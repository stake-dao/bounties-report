import * as fs from "fs";
import * as path from "path";
import moment from "moment";
import { fetchProposalsIdsBasedOnExactPeriods, getProposal, getLastClosedProposals } from "../utils/snapshot";
import { WEEK, SPECTRA_SPACE, SDCRV_SPACE, MERKLE_ADDRESS, SPECTRA_MERKLE_ADDRESS, SD_CRV, ETH_CHAIN_ID, BASE_CHAIN_ID } from "../utils/constants";
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
        const parsed = JSON.parse(fs.readFileSync(roundMetadataPath, "utf-8"));
        if (parsed.spectra) roundMetadata.spectra = parsed.spectra;
        if (parsed.general) roundMetadata.general = parsed.general;
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

            const CHUNK_TIMEOUT_MS = 10_000;
            const limit = pLimit(10); // Reduced concurrency to avoid overwhelming RPCs
            const chunkPromises = [];

            for (let i = startBlock; i < currentBlock; i += chunkSize) {
                const to = (i + chunkSize) > currentBlock ? currentBlock : (i + chunkSize);
                chunkPromises.push(limit(async () => {
                    try {
                        return await Promise.race([
                            client.getLogs({
                                address: contractAddress as `0x${string}`,
                                event: eventAbi,
                                args: args,
                                fromBlock: i,
                                toBlock: to
                            }),
                            new Promise<never>((_, reject) =>
                                setTimeout(() => reject(new Error(`getLogs timeout ${i}-${to}`)), CHUNK_TIMEOUT_MS)
                            )
                        ]);
                    } catch (e) {
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
        console.log(`[DEBUG] Starting processProtocol for ${protocolName}...`);
        
        const upcomingTuesdayTs = getUpcomingTuesday().unix();
        
        // Fetch the last 2 closed proposals
        // Round 1: second-to-last proposal (already distributed last week)
        // Round 2: latest proposal (upcoming distributions)
        const proposals = await getLastClosedProposals(spaceId, 2);
        
        if (proposals.length === 0) {
            console.log(`No closed proposals found for ${protocolName}`);
            return;
        }
        
        // Reset rounds for this protocol
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

        let currentRoundId = 0;
        const rounds = roundMetadata[protocolName]!.rounds;
        
        // Process proposals in reverse order (oldest first = Round 1)
        // proposals[0] = newest (Round 2 - upcoming)
        // proposals[1] = second newest (Round 1 - already distributed)
        const orderedProposals = [...proposals].reverse();
        
        for (let i = 0; i < orderedProposals.length; i++) {
            const proposal = orderedProposals[i];
            const roundId = i + 1;
            
            // Create round entry
            const round: Round = {
                id: roundId,
                proposals: [{
                    id: proposal.id,
                    start: formatDateTime(proposal.start),
                    end: formatDateTime(proposal.end)
                }],
                distributions: []
            };

            // Generate distributions for this round
            // Proposal End is usually around the start of the distribution cycle
            // proposalEndPeriod is the Thursday of the week containing the proposal end
            const proposalEndPeriod = Math.floor(proposal.end / WEEK) * WEEK;

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

                // Check if this distribution is the upcoming Tuesday
                if (distDateStr === upcomingTuesdayStr) {
                    currentRoundId = roundId;
                }
            }

            rounds.push(round);
            console.log(`Updated ${protocolName}: Round ${roundId}, distributions: ${round.distributions.map(d => d.date).join(', ')}`);
        }

        // Set currentRoundId - if upcoming Tuesday matches a distribution, use that round
        // Otherwise default to the latest round (Round 2)
        if (currentRoundId > 0) {
            roundMetadata[protocolName]!.currentRoundId = currentRoundId;
        } else if (rounds.length > 0) {
            // Default to the latest round if no match found
            roundMetadata[protocolName]!.currentRoundId = rounds[rounds.length - 1].id;
        }
        
        console.log(`[DEBUG] Completed processProtocol for ${protocolName}`);
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
            4 // 4 weeks: ~24 Base chunks vs 49 for 8 weeks
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