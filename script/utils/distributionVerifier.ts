import { processAllDelegators } from "./cacheUtils";
import { DELEGATION_ADDRESS } from "./constants";
import { getLastClosedProposal, getVoters } from "./snapshot";

export const distributionVerifier = async (space: string) => {
    // Fetch last proposal
    const proposal = await getLastClosedProposal(space);
    const proposalId = proposal.id;
    console.log("proposalId", proposalId);

    // Fetch voters
    const votes = await getVoters(proposalId);

    // If possible (ie : if the delegation voted), then fetch delegators
    const isDelegationAddressVoter = votes.some(
        (voter) => voter.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
    );
    let stakeDaoDelegators: string[] = [];

    if (isDelegationAddressVoter) {
        console.log(
            "Delegation address is one of the voters, fetching StakeDAO delegators"
        );
        stakeDaoDelegators = await processAllDelegators(
            space,
            proposal.created,
            DELEGATION_ADDRESS
        );
    }

    
}