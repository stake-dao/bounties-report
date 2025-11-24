import * as fs from "fs";
import * as path from "path";
import moment from "moment";
import { fetchProposalsIdsBasedOnExactPeriods, getProposal } from "../utils/snapshot";
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
    // currentPeriodTimestamp is the Thursday of the *current* week (or previous Thursday if today is Wed)
    // The script is run to prepare for the *next* distribution which happens on TargetPeriod
    const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;
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
            const client = await getClient(chainId);
            const currentBlock = await client.getBlockNumber();

            // Estimate blocks
            // Eth: ~12s, Base: ~2s
            const blockTime = chainId === 8453 ? 2n : 12n;
            const lookbackBlocks = (BigInt(lookbackWeeks) * 7n * 24n * 3600n) / blockTime;
            const startBlock = currentBlock - lookbackBlocks;

            // Chunk size
            const chunkSize = chainId === 8453 ? 2000n : 10000n; // Base RPCs are stricter

            const limit = pLimit(20);
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

            const chunks = await Promise.all(chunkPromises);
            const logs = chunks.flat();

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

        // Generate periods to check: Target, Target-1W, ..., Target-(N-1)W
        const periodsToCheck: string[] = [];
        for (let i = 0; i < totalSteps; i++) {
            periodsToCheck.push((targetPeriod - (i * WEEK)).toString());
        }

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
        const proposalIds = await fetchProposalsIdsBasedOnExactPeriods(spaceId, periodsToCheck, targetPeriod + WEEK);

        let foundAny = false;
        let currentRoundId = 0;

        // Iterate through all periods to find ALL active rounds (overlapping)
        for (let i = 0; i < totalSteps; i++) {
            const checkTimestamp = periodsToCheck[i];
            if (proposalIds[checkTimestamp]) {
                const proposalId = proposalIds[checkTimestamp];
                const activeStep = i + 1;

                const proposal = await getProposal(proposalId);

                // Update or add round info
                if (!roundMetadata[protocolName]) {
                    roundMetadata[protocolName] = { rounds: [] };
                }

                const rounds = roundMetadata[protocolName]!.rounds;
                // Check if round already exists
                let round = rounds.find(r => r.proposalStart === formatDate(proposal.start));

                if (!round) {
                    // Create new round entry
                    const maxId = rounds.length > 0 ? Math.max(...rounds.map(r => r.id)) : 0;
                    round = {
                        id: maxId + 1,
                        proposalStart: formatDateTime(proposal.start),
                        proposalEnd: formatDateTime(proposal.end),
                        proposals: [{
                            id: proposal.id,
                            start: formatDateTime(proposal.start),
                            end: formatDateTime(proposal.end)
                        }],
                        distributions: []
                    };
                    rounds.push(round);
                } else {
                    // If round exists, ensure proposal is added if not already there
                    if (!round.proposals) {
                        round.proposals = [];
                    }
                    if (!round.proposals.some(p => p.id === proposal.id)) {
                        round.proposals.push({
                            id: proposal.id,
                            start: formatDateTime(proposal.start),
                            end: formatDateTime(proposal.end)
                        });
                    }
                }

                // Re-generate distributions
                // Proposal End is usually around the start of the distribution cycle
                // proposalEndPeriod is the Thursday of the week containing the proposal end (usually same as proposal start)
                const proposalEndPeriod = Math.floor(proposal.end / WEEK) * WEEK;

                round.distributions = [];
                for (let s = 1; s <= totalSteps; s++) {
                    // User wants distributions on Tuesdays.
                    // proposalEndPeriod is Thursday. Tuesday is +5 days.
                    // The distribution starts a week later after the end of the vote.
                    // So Step 1 is: proposalEndPeriod + 1 WEEK + 5 days.
                    const distDate = proposalEndPeriod + (s * WEEK) + (5 * 86400);
                    const distDateStr = formatDate(distDate);

                    // Try to get from timeMap, otherwise check old rounds
                    let time = timeMap.get(distDateStr) || "";
                    if (!time) {
                        const oldRound = oldRounds.find(r => r.id === round!.id); // Assuming ID matches or we can match by date?
                        // Better match by date if IDs change? IDs seem sequential 1, 2.
                        // But we are rebuilding rounds.
                        // Let's try to find a distribution in oldRounds with same date.
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

                console.log(`Updated ${protocolName}: Round ${round.id}, Step ${activeStep}/${totalSteps}`);
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

    const processPendle = async () => {
        const reportsDir = path.join(__dirname, "../../bounties-reports");

        const oldRounds = roundMetadata["pendle"]?.rounds || [];

        // Fetch distribution times for Pendle (using SD_CRV as proxy per user request)
        const eventAbi = parseAbiItem("event MerkleRootUpdated(address indexed token, bytes32 indexed merkleRoot, uint256 update)");
        const timeMap = await fetchDistributionTimes(
            parseInt(ETH_CHAIN_ID),
            MERKLE_ADDRESS,
            eventAbi,
            { token: SD_CRV },
            8 // 8 weeks
        );

        // Current report timestamp (Thursday of this week)
        // We use the same logic as in getRoundMetadata: currentPeriodTimestamp
        // But we might need to check if the folder exists.

        let checkTimestamp = currentPeriodTimestamp;
        let periods: string[] = [];
        let foundTimestamp = 0;

        // 1. Find the latest pendle.csv
        // Look back up to 5 weeks to find a valid report
        for (let i = 0; i < 5; i++) {
            const ts = checkTimestamp - (i * WEEK);
            const csvPath = path.join(reportsDir, ts.toString(), "pendle.csv");

            if (fs.existsSync(csvPath)) {
                const content = fs.readFileSync(csvPath, "utf-8");
                const lines = content.split("\n");
                if (lines.length > 1) {
                    // Extract periods from the first column of data rows
                    // Format: Period;Gauge Name;...
                    // We want unique periods
                    const foundPeriods = new Set<string>();
                    for (let j = 1; j < lines.length; j++) {
                        const row = lines[j].trim();
                        if (row) {
                            const cols = row.split(";");
                            if (cols.length > 0) {
                                foundPeriods.add(cols[0]);
                            }
                        }
                    }
                    if (foundPeriods.size > 0) {
                        periods = Array.from(foundPeriods).sort();
                        foundTimestamp = ts;
                        break;
                    }
                }
            }
        }

        if (periods.length === 0) {
            console.log("No Pendle report found in the last 5 weeks.");
            return;
        }

        console.log(`Found Pendle report at ${foundTimestamp} with periods: ${periods.join(", ")}`);

        // 2. Find the start of the cycle
        // Go back from foundTimestamp to find the first timestamp that has the SAME periods
        let cycleStartTimestamp = foundTimestamp;

        // Look back up to 4 weeks (since it's a 4 week cycle)
        for (let i = 1; i <= 4; i++) {
            const prevTs = foundTimestamp - (i * WEEK);
            const prevCsvPath = path.join(reportsDir, prevTs.toString(), "pendle.csv");

            if (fs.existsSync(prevCsvPath)) {
                const content = fs.readFileSync(prevCsvPath, "utf-8");
                const lines = content.split("\n");
                const prevPeriods = new Set<string>();
                for (let j = 1; j < lines.length; j++) {
                    const row = lines[j].trim();
                    if (row) {
                        const cols = row.split(";");
                        if (cols.length > 0) {
                            prevPeriods.add(cols[0]);
                        }
                    }
                }

                const prevPeriodsArray = Array.from(prevPeriods).sort();
                // Compare arrays
                if (JSON.stringify(prevPeriodsArray) === JSON.stringify(periods)) {
                    cycleStartTimestamp = prevTs;
                } else {
                    // Periods changed, so cycleStartTimestamp is the one after this
                    break;
                }
            } else {
                // File doesn't exist, so cycleStartTimestamp is likely the current one (or we reached the end of history)
                break;
            }
        }

        console.log(`Cycle started at ${cycleStartTimestamp} (${moment.unix(cycleStartTimestamp).format("DD-MM-YYYY")})`);

        // 3. Fetch Proposals
        const proposals: ProposalInfo[] = [];
        // We need to fetch proposals for ALL periods in the CSV
        // fetchProposalsIdsBasedOnExactPeriods takes an array of periods.
        // It returns a map of period -> proposalId

        // The periods in CSV are timestamps.
        // fetchProposalsIdsBasedOnExactPeriods expects strings.
        // Add the NEXT period to the list to check
        const lastPeriod = parseInt(periods[periods.length - 1]);
        const nextPeriod = (lastPeriod + WEEK).toString();
        const allPeriodsToCheck = [...periods, nextPeriod];

        const proposalIdsMap = await fetchProposalsIdsBasedOnExactPeriods(SDPENDLE_SPACE, allPeriodsToCheck, moment().unix());

        for (const period of allPeriodsToCheck) {
            if (proposalIdsMap[period]) {
                const proposalId = proposalIdsMap[period];
                const proposal = await getProposal(proposalId);
                proposals.push({
                    id: proposal.id,
                    start: formatDateTime(proposal.start),
                    end: formatDateTime(proposal.end)
                });
            } else {
                console.log(`No proposal found for period ${period}`);
            }
        }

        // 4. Generate Metadata
        // Distributions
        // Step 1 Date = Cycle Start Timestamp + 5 Days (Tuesday)
        const step1Date = moment.unix(cycleStartTimestamp).add(5, 'days');

        // Round 1: Current Cycle
        const round1: Round = {
            id: 1,
            proposals: proposals.slice(0, 4), // First 4 proposals
            distributions: []
        };

        let currentRoundId = 0;
        for (let s = 1; s <= 4; s++) {
            const distDate = step1Date.clone().add(s - 1, 'weeks');
            const distDateStr = distDate.format("DD-MM-YYYY");

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

        // Round 2: Next Cycle
        // Starts 4 weeks after Round 1
        const nextCycleStartTimestamp = cycleStartTimestamp + (4 * WEEK);
        const step1DateNext = moment.unix(nextCycleStartTimestamp).add(5, 'days');

        const round2: Round = {
            id: 2,
            proposals: proposals.slice(4), // Remaining proposals (should be 1)
            distributions: []
        };

        for (let s = 1; s <= 4; s++) {
            const distDate = step1DateNext.clone().add(s - 1, 'weeks');
            const distDateStr = distDate.format("DD-MM-YYYY");

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

        if (!roundMetadata["pendle"]) {
            roundMetadata["pendle"] = { rounds: [] };
        }
        // Only add Round 2 if it has proposals
        if (round2.proposals && round2.proposals.length > 0) {
            roundMetadata["pendle"]!.rounds = [round1, round2];
        } else {
            roundMetadata["pendle"]!.rounds = [round1];
        }

        if (currentRoundId > 0) {
            roundMetadata["pendle"]!.currentRoundId = currentRoundId;
        }

        const currentStep = (currentPeriodTimestamp - cycleStartTimestamp) / WEEK + 1;
        console.log(`Updated pendle: Round 1 & 2, Current Step ~${currentStep}/4, Proposals: ${proposals.length}`);
    };

    // Spectra-specific processing: one proposal = one distribution
    const processSpectra = async () => {
        const weeksToCheck = 2;
        const periodsToCheck: string[] = [];
        for (let i = 0; i < weeksToCheck; i++) {
            periodsToCheck.push((targetPeriod - (i * WEEK)).toString());
        }

        // Reset rounds for Spectra
        const oldRounds = roundMetadata["spectra"]?.rounds || [];
        roundMetadata["spectra"] = { rounds: [] };

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

        // Fetch proposals for all periods
        const proposalIds = await fetchProposalsIdsBasedOnExactPeriods(SPECTRA_SPACE, periodsToCheck, targetPeriod + WEEK);

        let foundAny = false;
        let currentRoundId = 0;

        // Each proposal gets its own round with ONE distribution step
        for (let i = 0; i < weeksToCheck; i++) {
            const checkTimestamp = periodsToCheck[i];
            if (proposalIds[checkTimestamp]) {
                const proposalId = proposalIds[checkTimestamp];

                const proposal = await getProposal(proposalId);

                const rounds = roundMetadata["spectra"]!.rounds;

                // Create new round entry for this proposal
                const maxId = rounds.length > 0 ? Math.max(...rounds.map(r => r.id)) : 0;
                const round: Round = {
                    id: maxId + 1,
                    proposalStart: formatDateTime(proposal.start),
                    proposalEnd: formatDateTime(proposal.end),
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

    await processPendle();

    // Spectra: 1 proposal = 1 distribution (weekly)
    await processSpectra();

    // General: 2 steps (Using SDCRV as proxy)
    await processProtocol("general", SDCRV_SPACE, 2);

    fs.writeFileSync(roundMetadataPath, JSON.stringify(roundMetadata, null, 4));
    console.log("Round metadata updated.");
};

// Execute if run directly
if (require.main === module) {
    getRoundMetadata().catch(console.error);
}