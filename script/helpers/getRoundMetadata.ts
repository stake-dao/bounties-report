import * as fs from "fs";
import * as path from "path";
import * as moment from "moment";
import { fetchProposalsIdsBasedOnExactPeriods, getProposal } from "../utils/snapshot";
import { WEEK, SDPENDLE_SPACE, SPECTRA_SPACE, SDCRV_SPACE } from "../utils/constants";

interface DistributionStep {
    step: number;
    date: string;
}

interface Round {
    id: number;
    proposalStart: string;
    proposalEnd: string;
    distributions: DistributionStep[];
}

interface ProtocolRoundMetadata {
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

    const roundMetadataPath = path.join(__dirname, "../../round_metadata.json");

    let roundMetadata: RoundMetadata = {};
    if (fs.existsSync(roundMetadataPath)) {
        roundMetadata = JSON.parse(fs.readFileSync(roundMetadataPath, "utf-8"));
    }

    // Helper to format date
    const formatDate = (timestamp: number) => moment.unix(timestamp).format();

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
        roundMetadata[protocolName] = { rounds: [] };

        // Fetch proposals for all periods
        const proposalIds = await fetchProposalsIdsBasedOnExactPeriods(spaceId, periodsToCheck, targetPeriod + WEEK);

        let foundAny = false;

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
                        proposalStart: formatDate(proposal.start),
                        proposalEnd: formatDate(proposal.end),
                        distributions: []
                    };
                    rounds.push(round);
                }

                // Re-generate distributions
                // Proposal End is usually around the start of the distribution cycle
                // proposalEndPeriod is the Thursday of the week containing the proposal end (usually same as proposal start)
                const proposalEndPeriod = Math.floor(proposal.end / WEEK) * WEEK;

                round.distributions = [];
                for (let s = 1; s <= totalSteps; s++) {
                    // User wants distributions on Tuesdays.
                    // proposalEndPeriod is Thursday. Tuesday is +5 days.
                    // Step 1: Thursday + 5 days = Tuesday (same week/cycle start)
                    // Step 2: Thursday + 1 week + 5 days = Next Tuesday
                    const distDate = proposalEndPeriod + ((s - 1) * WEEK) + (5 * 86400);
                    round.distributions.push({
                        step: s,
                        date: formatDate(distDate)
                    });
                }

                console.log(`Updated ${protocolName}: Round ${round.id}, Step ${activeStep}/${totalSteps}`);
                foundAny = true;
            }
        }

        if (!foundAny) {
            console.log(`No active round found for ${protocolName}`);
        }
    };

    // Pendle: 4 steps
    await processProtocol("pendle", SDPENDLE_SPACE, 4);

    // Spectra: 2 steps
    await processProtocol("spectra", SPECTRA_SPACE, 2);

    // General: 2 steps (Using SDCRV as proxy)
    await processProtocol("general", SDCRV_SPACE, 2);

    fs.writeFileSync(roundMetadataPath, JSON.stringify(roundMetadata, null, 4));
    console.log("Round metadata updated.");
};

// Execute if run directly
if (require.main === module) {
    getRoundMetadata().catch(console.error);
}