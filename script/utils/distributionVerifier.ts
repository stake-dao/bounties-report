import { processAllDelegators } from "./cacheUtils";
import { DELEGATION_ADDRESS } from "./constants";
import { delegationLogger, proposalInformationLogger } from "./delegationHelper";
import { getLastClosedProposal, getVoters } from "./snapshot";
import fs from "fs";
import path from "path";

const setupLogging = (proposalId: string): string => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tempDir = path.join(process.cwd(), "temp");
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    return path.join(tempDir, `proposal-${proposalId}-${timestamp}.log`);
}


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

    const logPath = setupLogging(proposal.id);
    const log = (message: string) => {
        fs.appendFileSync(logPath, `${message}\n`);
        console.log(message);
    };

    // Proposal information
    proposalInformationLogger(space, proposal, log);

    // Delegation breakdown
    log("\n=== Delegation Information ===");
    delegationLogger(space, proposal, log);

    // Votes
    log(`\nTotal Votes: ${votes.length}`);

    // Holders
    log(`\nHolder Distribution:`);

    const table: any[] = [];
}