import { DelegatorDataAugmented } from "../interfaces/DelegatorDataAugmented";
import { formatAddress } from "./address";
import { processAllDelegators } from "./cacheUtils";
import { DELEGATION_ADDRESS } from "./constants";
import { getVotingPower } from "./snapshot";
import { Proposal } from "./types";

export const delegationLogger = async (space: string, proposal: Proposal, log: (message: string) => void) => {
    log(`\nSpace: ${space}`);
    const delegatorData = await fetchDelegatorData(space, proposal);

    if (delegatorData) {
        const sortedDelegators = delegatorData.delegators
            .filter((delegator) => delegatorData.votingPowers[delegator] > 0)
            .sort(
                (a, b) =>
                    (delegatorData.votingPowers[b] || 0) -
                    (delegatorData.votingPowers[a] || 0)
            );

        log(`Total Delegators: ${sortedDelegators.length}`);
        log(`Total Voting Power: ${delegatorData.totalVotingPower.toFixed(2)}`);

        log("\nDelegator Breakdown:");
        for (const delegator of sortedDelegators) {
            const vp = delegatorData.votingPowers[delegator];
            const share = (vp / delegatorData.totalVotingPower) * 100;
            log(`- ${delegator}: ${vp.toFixed(2)} VP (${share.toFixed(2)}%)`);
        }
    } else {
        log("No delegators found");
    }
}

const fetchDelegatorData = async (
    space: string,
    proposal: any
): Promise<DelegatorDataAugmented | null> => {
    const delegators = await processAllDelegators(
        space,
        proposal.created,
        DELEGATION_ADDRESS
    );


    if (delegators.length === 0) return null;

    const votingPowers = await getVotingPower(proposal, delegators);
    const totalVotingPower = Object.values(votingPowers).reduce(
        (acc, vp) => acc + vp,
        0
    );

    return {
        delegators,
        votingPowers,
        totalVotingPower,
    };
}

export const proposalInformationLogger = (space: string, proposal: Proposal, log: (message: string) => void) => {
    log("\n=== Proposal Information ===");
    log(`ID: ${proposal.id}`);
    log(`Title: ${proposal.title}`);
    log(`Space: ${space}`);
    log(`Author: ${formatAddress(proposal.author)}`);
    log(`Created: ${new Date(proposal.created * 1000).toLocaleString()}`);
    log(`Start: ${new Date(proposal.start * 1000).toLocaleString()}`);
    log(`End: ${new Date(proposal.end * 1000).toLocaleString()}`);
    log(`Snapshot Block: ${proposal.snapshot}`);
    
}