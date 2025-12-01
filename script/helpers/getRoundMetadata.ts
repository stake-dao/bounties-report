import * as fs from "fs";
import * as path from "path";
import moment from "moment";
import axios from "axios";
import { fetchProposalsIdsBasedOnExactPeriods, getProposal, getLastClosedProposal } from "../utils/snapshot";
import { WEEK, SDPENDLE_SPACE, SPECTRA_SPACE, SDCRV_SPACE, MERKLE_ADDRESS, SPECTRA_MERKLE_ADDRESS, SD_CRV, SD_PENDLE, ETH_CHAIN_ID, BASE_CHAIN_ID, MERKLE_CREATION_BLOCK_ETH } from "../utils/constants";
import { getLatestJson } from "../utils/githubUtils";
import { getClient } from "../utils/getClients";
import { parseAbiItem } from "viem";
import pLimit from "p-limit";

interface DistributionStep {
    step: number;
    date: string;
    distributed?: string;
}

interface ProposalInfo {
    id: string;
    start: string;
    end: string;
}

interface Round {
    id: number;
    proposalStart?: string;
    proposalEnd?: string;
    proposals?: ProposalInfo[];
    distributions: DistributionStep[];
}

interface ProtocolRoundMetadata {
    currentRoundId?: number;
    rounds: Round[];
}

interface RoundMetadata {
    pendle?: ProtocolRoundMetadata;
    spectra?: ProtocolRoundMetadata;
    general?: ProtocolRoundMetadata;
}

export const getRoundMetadata = async () => {
    const now = moment.utc().unix();
    // currentPeriodTimestamp is the Thursday of the *current* week
    const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;
    // targetPeriod is used for proposal fetching - set to next week's Thursday
    // This is used as the upper bound for fetching proposals
    const targetPeriod = currentPeriodTimestamp + WEEK;

    const roundMetadataPath = path.join("data/round_metadata.json");

    let roundMetadata: RoundMetadata = {};
    if (fs.existsSync(roundMetadataPath)) {
        roundMetadata = JSON.parse(fs.readFileSync(roundMetadataPath, "utf-8"));
    }

    // Helper to format date
    const formatDate = (timestamp: number) => moment.unix(timestamp).utc().format("DD-MM-YYYY");

    // Helper to format date with time (for proposals)
    const formatDateTime = (timestamp: number) => moment.unix(timestamp).utc().format("DD-MM-YYYY HH:mm");

    // Helper to get upcoming Tuesday
    const getUpcomingTuesday = () => {
        const today = moment.utc();
        const dayOfWeek = today.day(); // 0=Sun, 1=Mon, 2=Tue, ...
        let daysUntilTuesday = 2 - dayOfWeek;
        if (daysUntilTuesday < 0) {
            daysUntilTuesday += 7;
        }
        return today.add(daysUntilTuesday, 'days').startOf('day');
    };

    const upcomingTuesdayStr = getUpcomingTuesday().format("DD-MM-YYYY");

    // Helper to fetch distribution times
    const fetchDistributionTimes = async (
        chainId: number,
        contractAddress: string,
        eventAbi: any,
        args: any = {},
        lookbackWeeks: number = 4
    ): Promise<Map<string, string>> => {
        try {
            console.log(`[fetchDistributionTimes] Getting client for chain ${chainId}...`);
            const client = await getClient(chainId);
            console.log(`[fetchDistributionTimes] Getting current block...`);
            const currentBlock = await client.getBlockNumber();
            console.log(`[fetchDistributionTimes] Current block: ${currentBlock}`);

            // Estimate blocks
            // Eth: ~12s, Base: ~2s
            const blockTime = chainId === 8453 ? 2n : 12n;
            const lookbackBlocks = (BigInt(lookbackWeeks) * 7n * 24n * 3600n) / blockTime;
            const startBlock = currentBlock - lookbackBlocks;
            console.log(`[fetchDistributionTimes] Fetching logs from block ${startBlock} to ${currentBlock}`);

            // Chunk size - Base needs larger chunks due to fast block times
            // Base: 8 weeks = ~2.4M blocks. With 50k chunk size = ~48 requests (manageable)
            // Eth: 8 weeks = ~403k blocks. With 10k chunk size = ~40 requests
            const chunkSize = chainId === 8453 ? 50000n : 10000n;

            const limit = pLimit(10); // Reduced concurrency to avoid overwhelming RPCs
            const chunkPromises = [];

            for (let i = startBlock; i < currentBlock; i += chunkSize) {
                const to = (i + chunkSize) > currentBlock ? currentBlock : (i + chunkSize);
                chunkPromises.push(limit(async () => {
                    try {
                        return await client.getLogs({
                            address: contractAddress as `0x${string}`,
                            event: eventAbi,
                            args: args,
                            fromBlock: i,
                            toBlock: to
                        });
                    } catch (e) {
                        // console.warn(`Failed to fetch logs for chunk ${i}-${to}:`, e);
                        return [];
                    }
                }));
            }

            console.log(`[fetchDistributionTimes] Waiting for ${chunkPromises.length} chunk promises...`);
            const chunks = await Promise.all(chunkPromises);
            const logs = chunks.flat();
            console.log(`[fetchDistributionTimes] Found ${logs.length} logs`);

            const timeMap = new Map<string, string>();

            // Fetch blocks in parallel (batches of 10)
            const batchSize = 10;
            for (let i = 0; i < logs.length; i += batchSize) {
                const batch = logs.slice(i, i + batchSize);
                await Promise.all(batch.map(async (log) => {
                    try {
                        const block = await client.getBlock({ blockNumber: log.blockNumber });
                        const timestamp = Number(block.timestamp);
                        const dateStr = moment.unix(timestamp).utc().format("DD-MM-YYYY");
                        const timeStr = moment.unix(timestamp).utc().format("HH:mm");

                        timeMap.set(dateStr, timeStr);
                    } catch (e) {
                        console.error(`Error fetching block ${log.blockNumber}:`, e);
                    }
                }));
            }

            return timeMap;
        } catch (e) {
            console.error("Error fetching distribution times:", e);
            return new Map<string, string>();
        }
    };

    // Helper to process protocol
    const processProtocol = async (
        protocolName: keyof RoundMetadata,
        spaceId: string,
        totalSteps: number
    ) => {
        const ROUNDS_TO_SHOW = 2; // Show current round + next round

        // Generate periods to check for CURRENT round + NEXT round
        // Each round has `totalSteps` distributions over `totalSteps` weeks
        // We need to find proposals for 2 rounds, so we check periods spanning both rounds
        // 
        // For general with totalSteps=2:
        // - Round 1 (current): proposal from ~2 weeks ago, distributions this week + next week
        // - Round 2 (next): proposal from this week, distributions in 2 weeks + 3 weeks
        //
        // fetchProposalsIdsBasedOnExactPeriods does: reportPeriod = periodTimestamp - WEEK
        // So to find the proposal for Round 1: pass currentPeriodTimestamp (reportPeriod = currentPeriod - WEEK)
        // To find the proposal for Round 2: pass currentPeriodTimestamp + (totalSteps * WEEK)
        
        const periodsToCheck: string[] = [];
        // We need to check 2 periods: one for current round, one for next round
        // 
        // For General (bi-weekly proposals, 2 distributions per round):
        // - Proposals happen every 2 weeks on Thursday
        // - Each proposal results in 2 distributions (Step 1 and Step 2) on following Tuesdays
        //
        // To correctly find which proposals to show:
        // 1. Get the upcoming Tuesday
        // 2. Calculate which proposal cycle that Tuesday belongs to
        // 3. Use that to find Round 1 and Round 2 proposal weeks
        //
        // fetchProposalsIdsBasedOnExactPeriods calculates: reportPeriod = periodTimestamp - WEEK
        // So to match a proposal created in week X, we pass periodTimestamp = X + WEEK
        
        const upcomingTuesdayTs = getUpcomingTuesday().unix();
        
        // Dynamically fetch the most recent closed proposal to use as anchor
        // This avoids hardcoding a specific epoch date
        const latestProposal = await getLastClosedProposal(spaceId);
        
        if (!latestProposal) {
            console.log(`No closed proposals found for ${protocolName}`);
            return;
        }
        
        // The proposal's created timestamp gives us the Thursday of the proposal week
        // We normalize it to the Thursday (start of the week in proposal terms)
        const latestProposalPeriod = Math.floor(latestProposal.created / WEEK) * WEEK;
        const CYCLE_LENGTH = totalSteps * WEEK; // Bi-weekly = 2 weeks for general
        
        // Calculate the first distribution date for the latest proposal
        // Proposal ends, then distributions start the following Tuesday
        // proposalEndPeriod (Thursday) + 1 WEEK + 5 days = First Tuesday
        const proposalEndPeriod = Math.floor(latestProposal.end / WEEK) * WEEK;
        const firstDistOfLatest = proposalEndPeriod + WEEK + (5 * 86400);
        const lastDistOfLatest = firstDistOfLatest + ((totalSteps - 1) * WEEK);
        
        // Determine which round the upcoming Tuesday belongs to
        // If upcoming Tuesday <= last distribution of latest proposal, it's Round 1
        // Otherwise, we need Round 2 (next proposal's round)
        let round1ProposalPeriod: number;
        let round2ProposalPeriod: number;
        
        if (upcomingTuesdayTs <= lastDistOfLatest) {
            // Upcoming Tuesday is within the latest proposal's distribution period
            round1ProposalPeriod = latestProposalPeriod;
            round2ProposalPeriod = latestProposalPeriod + CYCLE_LENGTH;
        } else {
            // Upcoming Tuesday is past the latest proposal's distributions
            // Round 1 should be the NEXT proposal (which may not exist yet)
            round1ProposalPeriod = latestProposalPeriod + CYCLE_LENGTH;
            round2ProposalPeriod = round1ProposalPeriod + CYCLE_LENGTH;
        }
        
        // Convert to periodTimestamp for fetchProposalsIdsBasedOnExactPeriods
        // reportPeriod = periodTimestamp - WEEK, so periodTimestamp = proposalPeriod + WEEK
        periodsToCheck.push((round1ProposalPeriod + WEEK).toString());
        periodsToCheck.push((round2ProposalPeriod + WEEK).toString());

        // Reset rounds for this protocol to ensure we only have active ones
        const oldRounds = roundMetadata[protocolName]?.rounds || [];
        roundMetadata[protocolName] = { rounds: [] };

        // Fetch distribution times for General (SD_CRV)
        let timeMap = new Map<string, string>();
        if (protocolName === "general") {
            const eventAbi = parseAbiItem("event MerkleRootUpdated(address indexed token, bytes32 indexed merkleRoot, uint256 update)");
            timeMap = await fetchDistributionTimes(
                parseInt(ETH_CHAIN_ID),
                MERKLE_ADDRESS,
                eventAbi,
                { token: SD_CRV },
                8 // Look back 8 weeks
            );
        }

        // Fetch proposals for all periods
        const maxPeriod = currentPeriodTimestamp + (ROUNDS_TO_SHOW * totalSteps * WEEK);
        const proposalIds = await fetchProposalsIdsBasedOnExactPeriods(spaceId, periodsToCheck, maxPeriod);

        let foundAny = false;
        let currentRoundId = 0;
        const seenProposalIds = new Set<string>(); // Track which proposals we've already processed

        // Iterate through periods to create rounds
        for (let roundIdx = 0; roundIdx < ROUNDS_TO_SHOW; roundIdx++) {
            const checkTimestamp = periodsToCheck[roundIdx];
            const proposalId = proposalIds[checkTimestamp];

            // Skip if this is a duplicate proposal (same proposal returned for multiple periods)
            if (proposalId && seenProposalIds.has(proposalId)) {
                // This means the next round's proposal doesn't exist yet
                // Project the next round based on when it should happen
                const rounds = roundMetadata[protocolName]!.rounds;
                const lastRound = rounds[rounds.length - 1];
                
                if (lastRound && lastRound.distributions.length > 0) {
                    // Calculate next round's distributions based on last round
                    const lastDistDate = lastRound.distributions[lastRound.distributions.length - 1].date;
                    const [lastDay, lastMonth, lastYear] = lastDistDate.split('-').map(Number);
                    const lastDistTs = moment.utc({ year: lastYear, month: lastMonth - 1, day: lastDay }).unix();
                    
                    // Next round starts 1 week after the last distribution of current round
                    const nextRoundFirstDist = lastDistTs + WEEK;
                    
                    const nextRound: Round = {
                        id: lastRound.id + 1,
                        proposals: [], // No proposal yet
                        distributions: []
                    };
                    
                    for (let s = 1; s <= totalSteps; s++) {
                        const distDate = nextRoundFirstDist + ((s - 1) * WEEK);
                        const distDateStr = formatDate(distDate);
                        
                        let time = timeMap.get(distDateStr) || "";
                        if (!time) {
                            for (const or of oldRounds) {
                                const d = or.distributions.find(d => d.date === distDateStr);
                                if (d && d.distributed) {
                                    time = d.distributed;
                                    break;
                                }
                            }
                        }
                        
                        nextRound.distributions.push({
                            step: s,
                            date: distDateStr,
                            distributed: time
                        });
                        
                        if (distDateStr === upcomingTuesdayStr) {
                            currentRoundId = nextRound.id;
                        }
                    }
                    
                    rounds.push(nextRound);
                    console.log(`Updated ${protocolName}: Round ${nextRound.id} (projected), distributions: ${nextRound.distributions.map(d => d.date).join(', ')}`);
                }
                continue;
            }

            if (proposalId) {
                seenProposalIds.add(proposalId);
                const proposal = await getProposal(proposalId);

                // Update or add round info
                if (!roundMetadata[protocolName]) {
                    roundMetadata[protocolName] = { rounds: [] };
                }

                const rounds = roundMetadata[protocolName]!.rounds;
                
                // Check if round already exists (by matching proposal ID to avoid duplicates)
                let round = rounds.find(r => r.proposals?.some(p => p.id === proposal.id));

                if (!round) {
                    // Create new round entry
                    const maxId = rounds.length > 0 ? Math.max(...rounds.map(r => r.id)) : 0;
                    round = {
                        id: maxId + 1,
                        proposals: [{
                            id: proposal.id,
                            start: formatDateTime(proposal.start),
                            end: formatDateTime(proposal.end)
                        }],
                        distributions: []
                    };
                    rounds.push(round);
                }

                // Generate distributions for this round
                // Proposal End is usually around the start of the distribution cycle
                // proposalEndPeriod is the Thursday of the week containing the proposal end
                const proposalEndPeriod = Math.floor(proposal.end / WEEK) * WEEK;

                round.distributions = [];
                for (let s = 1; s <= totalSteps; s++) {
                    // Distributions on Tuesdays.
                    // proposalEndPeriod is Thursday. Tuesday is +5 days.
                    // Step 1 is: proposalEndPeriod + 1 WEEK + 5 days.
                    const distDate = proposalEndPeriod + (s * WEEK) + (5 * 86400);
                    const distDateStr = formatDate(distDate);

                    // Try to get from timeMap, otherwise check old rounds
                    let time = timeMap.get(distDateStr) || "";
                    if (!time) {
                        for (const or of oldRounds) {
                            const d = or.distributions.find(d => d.date === distDateStr);
                            if (d && d.distributed) {
                                time = d.distributed;
                                break;
                            }
                        }
                    }

                    round.distributions.push({
                        step: s,
                        date: distDateStr,
                        distributed: time
                    });

                    if (distDateStr === upcomingTuesdayStr) {
                        currentRoundId = round.id;
                    }
                }

                console.log(`Updated ${protocolName}: Round ${round.id}, distributions: ${round.distributions.map(d => d.date).join(', ')}`);
                foundAny = true;
            }
        }

        if (currentRoundId > 0) {
            roundMetadata[protocolName]!.currentRoundId = currentRoundId;
        }

        if (!foundAny) {
            console.log(`No active round found for ${protocolName}`);
        }
    };

    // Pendle processing: Monthly cycle (4 weeks) with weekly distributions
    // Data comes from https://github.com/stake-dao/pendle-merkle-script/tree/main/scripts/data/sdPendle-rewards
    const processPendle = async () => {
        console.log("[DEBUG] Starting processPendle...");
        
        const PENDLE_REPO_PATH = "stake-dao/pendle-merkle-script";
        const PENDLE_DIRECTORY_PATH = "scripts/data/sdPendle-rewards";
        
        // Reset rounds for Pendle
        const oldRounds = roundMetadata["pendle"]?.rounds || [];
        roundMetadata["pendle"] = { rounds: [] };

        // Fetch distribution times for Pendle (using SD_CRV as proxy)
        const eventAbi = parseAbiItem("event MerkleRootUpdated(address indexed token, bytes32 indexed merkleRoot, uint256 update)");
        const timeMap = await fetchDistributionTimes(
            parseInt(ETH_CHAIN_ID),
            MERKLE_ADDRESS,
            eventAbi,
            { token: SD_CRV },
            8 // 8 weeks
        );

        // Fetch list of files from GitHub to get the latest and second latest
        const url = `https://api.github.com/repos/${PENDLE_REPO_PATH}/contents/${PENDLE_DIRECTORY_PATH}`;
        const response = await axios.get(url);
        
        if (response.status !== 200) {
            console.log("Failed to fetch Pendle rewards files from GitHub");
            return;
        }
        
        const files = response.data;
        
        // Parse filenames and sort by end date (format: DD-MM_DD-MM-YYYY.json)
        const filesWithDates = files
            .map((file: any) => {
                // Extract end date from filename: XX-XX_DD-MM-YYYY.json
                const match = file.name.match(/_(\d{2})-(\d{2})-(\d{4})\.json$/);
                if (match) {
                    const [_, day, month, year] = match;
                    const endDate = new Date(`${year}-${month}-${day}`);
                    return { file, endDate, name: file.name };
                }
                return null;
            })
            .filter((f: any) => f !== null)
            .sort((a: any, b: any) => b.endDate.getTime() - a.endDate.getTime());
        
        if (filesWithDates.length === 0) {
            console.log("No valid Pendle rewards files found");
            return;
        }
        
        // Get latest file (current/active cycle)
        const latestFile = filesWithDates[0];
        console.log(`[DEBUG] Latest Pendle file: ${latestFile.name}`);
        
        // Parse start and end dates from filename (DD-MM_DD-MM-YYYY.json)
        const filenameMatch = latestFile.name.match(/(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{4})\.json$/);
        if (!filenameMatch) {
            console.log("Failed to parse Pendle filename");
            return;
        }
        
        const [_, startDay, startMonth, endDay, endMonth, year] = filenameMatch;
        // Start date uses same year as end date, unless start month > end month (year rollover)
        const startYear = parseInt(startMonth) > parseInt(endMonth) ? parseInt(year) - 1 : parseInt(year);
        const cycleStartDate = moment.utc(`${startYear}-${startMonth}-${startDay}`, "YYYY-MM-DD");
        const cycleEndDate = moment.utc(`${year}-${endMonth}-${endDay}`, "YYYY-MM-DD");
        
        console.log(`[DEBUG] Cycle: ${cycleStartDate.format("DD-MM-YYYY")} to ${cycleEndDate.format("DD-MM-YYYY")}`);
        
        // Get periods from the LATEST GitHub report - this is the round we're distributing NOW
        // (The previous round from bounties-reports is already done)
        const fileContent = await axios.get(latestFile.file.download_url);
        const rewardsData = fileContent.data;
        const reportPeriods = Object.keys(rewardsData.resultsByPeriod || {}).map(p => parseInt(p)).sort((a, b) => a - b);
        const numPeriods = reportPeriods.length;
        
        console.log(`[DEBUG] Current round periods (from GitHub report): ${reportPeriods.map(p => formatDate(p)).join(', ')}`);
        
        // Check bounties-reports to see how many distributions have been done for THIS round
        const bountyReportsPath = path.join("bounties-reports");
        let distributionsDone = 0;
        let firstDistDate: number | null = null;
        
        if (fs.existsSync(bountyReportsPath)) {
            const folders = fs.readdirSync(bountyReportsPath)
                .filter(f => /^\d+$/.test(f))
                .map(f => parseInt(f))
                .sort((a, b) => a - b);
            
            for (const folder of folders) {
                const pendleCsvPath = path.join(bountyReportsPath, folder.toString(), "pendle.csv");
                if (fs.existsSync(pendleCsvPath)) {
                    const csvContent = fs.readFileSync(pendleCsvPath, "utf-8");
                    const lines = csvContent.split("\n").filter(l => l.trim() && !l.startsWith("Period"));
                    const csvPeriods = [...new Set(lines.map(l => parseInt(l.split(";")[0])).filter(p => !isNaN(p)))].sort((a, b) => a - b);
                    
                    // Check if this folder's periods match the current report periods
                    if (csvPeriods.length > 0 && csvPeriods[0] === reportPeriods[0]) {
                        distributionsDone++;
                        if (firstDistDate === null) {
                            firstDistDate = folder + (5 * 86400);
                        }
                    }
                }
            }
        }
        
        console.log(`[DEBUG] Distributions done for current round: ${distributionsDone}`);
        
        let currentRoundId = 0;
        let roundCounter = 1;
        
        // Standard cycle length is 4 weeks
        const STANDARD_CYCLE_WEEKS = 4;
        
        // Calculate first distribution date
        // If we found distributions for this round, use the first one
        // Otherwise, use the upcoming Tuesday (we're starting a new round)
        let cycleFirstDist: number;
        if (firstDistDate !== null && distributionsDone > 0) {
            cycleFirstDist = firstDistDate;
        } else {
            // No distributions yet for this round - first dist is the upcoming Tuesday
            cycleFirstDist = getUpcomingTuesday().unix();
        }
        
        console.log(`[DEBUG] First distribution date: ${formatDate(cycleFirstDist)}`);
        
        // Fetch proposals using period timestamps from the report
        // fetchProposalsIdsBasedOnExactPeriods expects periodTimestamp where reportPeriod = periodTimestamp - WEEK
        const round1PeriodsToFetch = reportPeriods.map(p => (p + WEEK).toString());
        
        // Round 2: proposals from AFTER the last report period (next 4 weekly proposals)
        const lastReportPeriod = reportPeriods[reportPeriods.length - 1];
        const nextCyclePeriods: number[] = [];
        for (let i = 1; i <= STANDARD_CYCLE_WEEKS; i++) {
            nextCyclePeriods.push(lastReportPeriod + (i * WEEK));
        }
        const round2PeriodsToFetch = nextCyclePeriods.map(p => (p + WEEK).toString());
        
        console.log(`[DEBUG] Round 2 proposal periods (after report): ${nextCyclePeriods.map(p => formatDate(p)).join(', ')}`);
        
        // Fetch all proposals
        const allPeriodsToFetch = [...round1PeriodsToFetch, ...round2PeriodsToFetch];
        const maxPeriod = nextCyclePeriods[nextCyclePeriods.length - 1] + (2 * WEEK);
        const pendleProposalIds = await fetchProposalsIdsBasedOnExactPeriods(
            SDPENDLE_SPACE,
            allPeriodsToFetch,
            maxPeriod
        );
        
        console.log(`[DEBUG] Found Pendle proposals: ${Object.keys(pendleProposalIds).length}`);
        
        // Fetch and cache proposal details
        const proposalCache = new Map<string, ProposalInfo>();
        const seenProposalIds = new Set<string>();
        
        for (const period of allPeriodsToFetch) {
            const proposalId = pendleProposalIds[period];
            if (proposalId && !seenProposalIds.has(proposalId)) {
                seenProposalIds.add(proposalId);
                const proposal = await getProposal(proposalId);
                proposalCache.set(proposalId, {
                    id: proposal.id,
                    start: formatDateTime(proposal.start),
                    end: formatDateTime(proposal.end)
                });
            }
        }
        
        // Build Round 1: Current cycle (from report)
        // ALL proposals are distributed together over 4 weeks
        const round1Proposals: ProposalInfo[] = [];
        const round1ProposalIds = new Set<string>();
        
        for (const period of round1PeriodsToFetch) {
            const proposalId = pendleProposalIds[period];
            if (proposalId && !round1ProposalIds.has(proposalId)) {
                round1ProposalIds.add(proposalId);
                const proposalInfo = proposalCache.get(proposalId);
                if (proposalInfo) {
                    round1Proposals.push(proposalInfo);
                }
            }
        }
        
        const round1: Round = {
            id: roundCounter++,
            proposals: round1Proposals,
            distributions: []
        };
        
        // Generate distribution dates for Round 1
        // Always 4 distributions per round (each distribution covers ALL proposals)
        for (let s = 1; s <= STANDARD_CYCLE_WEEKS; s++) {
            const distTimestamp = cycleFirstDist + ((s - 1) * WEEK);
            const distDateStr = formatDate(distTimestamp);
            
            let time = timeMap.get(distDateStr) || "";
            if (!time) {
                for (const or of oldRounds) {
                    const d = or.distributions.find(d => d.date === distDateStr);
                    if (d && d.distributed) {
                        time = d.distributed;
                        break;
                    }
                }
            }
            
            round1.distributions.push({
                step: s,
                date: distDateStr,
                distributed: time
            });
            
            if (distDateStr === upcomingTuesdayStr) {
                currentRoundId = round1.id;
            }
        }
        
        roundMetadata["pendle"]!.rounds.push(round1);
        console.log(`Updated pendle: Round ${round1.id} (current) with ${STANDARD_CYCLE_WEEKS} distributions, ${round1Proposals.length} proposals`);
        
        // Build Round 2: Next cycle (projected, always 4 weeks)
        const round2Proposals: ProposalInfo[] = [];
        const round2ProposalIds = new Set<string>();
        
        for (const period of round2PeriodsToFetch) {
            const proposalId = pendleProposalIds[period];
            if (proposalId && !round2ProposalIds.has(proposalId) && !round1ProposalIds.has(proposalId)) {
                round2ProposalIds.add(proposalId);
                const proposalInfo = proposalCache.get(proposalId);
                if (proposalInfo) {
                    round2Proposals.push(proposalInfo);
                }
            }
        }
        
        // Round 2 starts after Round 1's 4 distributions
        const nextCycleFirstDist = cycleFirstDist + (STANDARD_CYCLE_WEEKS * WEEK);
        
        const round2: Round = {
            id: roundCounter++,
            proposals: round2Proposals,
            distributions: []
        };
        
        // Generate distribution dates for Round 2 (always 4 weeks)
        for (let s = 1; s <= STANDARD_CYCLE_WEEKS; s++) {
            const distTimestamp = nextCycleFirstDist + ((s - 1) * WEEK);
            const distDateStr = formatDate(distTimestamp);
            
            let time = timeMap.get(distDateStr) || "";
            if (!time) {
                for (const or of oldRounds) {
                    const d = or.distributions.find(d => d.date === distDateStr);
                    if (d && d.distributed) {
                        time = d.distributed;
                        break;
                    }
                }
            }
            
            round2.distributions.push({
                step: s,
                date: distDateStr,
                distributed: time
            });
            
            if (distDateStr === upcomingTuesdayStr) {
                currentRoundId = round2.id;
            }
        }
        
        roundMetadata["pendle"]!.rounds.push(round2);
        console.log(`Updated pendle: Round ${round2.id} (next cycle) with ${STANDARD_CYCLE_WEEKS} distributions, ${round2Proposals.length} proposals`);
        
        if (currentRoundId > 0) {
            roundMetadata["pendle"]!.currentRoundId = currentRoundId;
        }
    };

    // Spectra-specific processing: one proposal = one distribution
    const processSpectra = async () => {
        console.log("[DEBUG] Starting processSpectra...");
        const weeksToCheck = 2;
        const periodsToCheck: string[] = [];
        // For Spectra: 1 proposal = 1 distribution (the following Tuesday after proposal ends)
        // We want to show:
        //   - CURRENT round: distribution happening THIS Tuesday (proposal from ~2 weeks ago)
        //   - INCOMING/NEXT round: distribution happening NEXT Tuesday (proposal from ~1 week ago)
        // 
        // fetchProposalsIdsBasedOnExactPeriods does: reportPeriod = periodTimestamp - WEEK
        // Distribution happens: proposalEndPeriod + WEEK + 5 days (Tuesday)
        //
        // To find proposal for distribution THIS week (Dec 02):
        //   - Proposal ended ~Nov 25 (week of Nov 20)
        //   - reportPeriod should be Nov 20 => periodTimestamp = Nov 27 = currentPeriodTimestamp
        // To find proposal for distribution NEXT week (Dec 09):
        //   - Proposal ended ~Dec 02 (week of Nov 27)
        //   - reportPeriod should be Nov 27 => periodTimestamp = Dec 04 = targetPeriod
        //
        // Order: CURRENT first, then INCOMING (so Round 1 = current, Round 2 = next)
        // periods = [currentPeriodTimestamp, targetPeriod]
        for (let i = weeksToCheck - 1; i >= 0; i--) {
            periodsToCheck.push((targetPeriod - (i * WEEK)).toString());
        }

        // Reset rounds for Spectra
        const oldRounds = roundMetadata["spectra"]?.rounds || [];
        roundMetadata["spectra"] = { rounds: [] };

        console.log("[DEBUG] Fetching distribution times for Spectra on Base chain...");
        // Fetch distribution times for Spectra
        const eventAbi = parseAbiItem("event RootSet(bytes32 indexed newRoot, bytes32 indexed newIpfsHash)");
        // Start from block 20M on Base (approx recent) to save time, or 0 if unsure.
        // Spectra is recent, so 20M is safe (Base is at ~22M+).
        const timeMap = await fetchDistributionTimes(
            parseInt(BASE_CHAIN_ID),
            SPECTRA_MERKLE_ADDRESS,
            eventAbi,
            {},
            8 // 8 weeks
        );
        console.log("[DEBUG] Fetched distribution times for Spectra, found", timeMap.size, "entries");

        // Fetch proposals for all periods
        console.log("[DEBUG] Fetching proposals for Spectra...");
        // Use targetPeriod + 2*WEEK as upper bound to capture upcoming proposals
        const proposalIds = await fetchProposalsIdsBasedOnExactPeriods(SPECTRA_SPACE, periodsToCheck, targetPeriod + (2 * WEEK));
        console.log("[DEBUG] Found proposal IDs:", Object.keys(proposalIds).length);

        let foundAny = false;
        let currentRoundId = 0;

        // Track seen proposal IDs to avoid duplicates
        const seenProposalIds = new Set<string>();
        
        // Each proposal gets its own round with ONE distribution step
        for (let i = 0; i < weeksToCheck; i++) {
            const checkTimestamp = periodsToCheck[i];
            if (proposalIds[checkTimestamp]) {
                const proposalId = proposalIds[checkTimestamp];
                
                // Skip if we've already processed this proposal
                if (seenProposalIds.has(proposalId)) {
                    continue;
                }
                seenProposalIds.add(proposalId);

                const proposal = await getProposal(proposalId);

                const rounds = roundMetadata["spectra"]!.rounds;

                // Create new round entry for this proposal
                const maxId = rounds.length > 0 ? Math.max(...rounds.map(r => r.id)) : 0;
                const round: Round = {
                    id: maxId + 1,
                    proposals: [{
                        id: proposal.id,
                        start: formatDateTime(proposal.start),
                        end: formatDateTime(proposal.end)
                    }],
                    distributions: []
                };
                rounds.push(round);

                // Calculate distribution date
                // Proposal ends on Tuesday, distribution happens the FOLLOWING Tuesday
                // proposalEndPeriod is the Thursday of the week containing the proposal end
                const proposalEndPeriod = Math.floor(proposal.end / WEEK) * WEEK;

                // Distribution is 1 week after proposal ends + 5 days to get to Tuesday
                // Distribution is 1 week after proposal ends + 5 days to get to Tuesday
                const distDate = proposalEndPeriod + WEEK + (5 * 86400);
                const distDateStr = formatDate(distDate);

                let time = timeMap.get(distDateStr) || "";
                if (!time) {
                    for (const or of oldRounds) {
                        const d = or.distributions.find(d => d.date === distDateStr);
                        if (d && d.distributed) {
                            time = d.distributed;
                            break;
                        }
                    }
                }

                round.distributions.push({
                    step: 1,
                    date: distDateStr,
                    distributed: time
                });

                if (distDateStr === upcomingTuesdayStr) {
                    currentRoundId = round.id;
                }

                console.log(`Updated spectra: Round ${round.id}, Distribution: ${distDateStr}`);
                foundAny = true;
            }
        }

        if (currentRoundId > 0) {
            roundMetadata["spectra"]!.currentRoundId = currentRoundId;
        }

        if (!foundAny) {
            console.log(`No active round found for spectra`);
        }
    };

    console.log("[DEBUG] Starting processPendle...");
    await processPendle();
    console.log("[DEBUG] Completed processPendle");

    // Spectra: 1 proposal = 1 distribution (weekly)
    console.log("[DEBUG] Starting processSpectra...");
    await processSpectra();
    console.log("[DEBUG] Completed processSpectra");

    // General: 2 steps (Using SDCRV as proxy)
    console.log("[DEBUG] Starting processProtocol for general...");
    await processProtocol("general", SDCRV_SPACE, 2);
    console.log("[DEBUG] Completed processProtocol for general");

    fs.writeFileSync(roundMetadataPath, JSON.stringify(roundMetadata, null, 4));
    console.log("Round metadata updated.");
};

// Execute if run directly
if (require.main === module) {
    getRoundMetadata().catch(console.error);
}