import { DelegatorDataAugmented } from "../interfaces/DelegatorDataAugmented";
import { formatAddress } from "./address";
import { getBlockNumberByTimestamp } from "./chainUtils";
import { processAllDelegators } from "./cacheUtils";
import { getOptimizedClient, DELEGATION_ADDRESS, VOTIUM_FORWARDER_REGISTRY } from "./constants";
import { getVotingPower } from "./snapshot";
import { Proposal } from "./types";
import { VOTIUM_FORWARDER } from "./constants";

// VOTIUM
export const getForwardedDelegators = async (
  delegators: string[],
  blockSnapshotEnd: number
): Promise<string[]> => {
  const abi = [
    {
      name: "batchAddressCheck",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "accounts", type: "address[]" }],
      outputs: [{ name: "", type: "address[]" }],
    },
  ];

  // Split delegators into smaller batches to avoid contract call size limits
  const BATCH_SIZE = 50; // Conservative batch size to ensure calls succeed
  const batches: string[][] = [];
  
  for (let i = 0; i < delegators.length; i += BATCH_SIZE) {
    batches.push(delegators.slice(i, i + BATCH_SIZE));
  }

  try {
    const client = await getOptimizedClient(1);
    const results: string[] = [];
    
    // Process each batch sequentially
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`Processing batch ${i + 1}/${batches.length} with ${batch.length} addresses`);
      
      const batchResult = (await client.readContract({
        address: VOTIUM_FORWARDER_REGISTRY as `0x${string}`,
        abi,
        functionName: "batchAddressCheck",
        args: [batch],
        blockNumber: BigInt(blockSnapshotEnd),
      })) as string[];
      
      results.push(...batchResult);
    }

    return results;
  } catch (error) {
    console.error("Error in multicall to get forwarded delegators:", error);
    console.error("CRITICAL: Forwarder check failed - this will affect merkle generation!");
    console.error("Delegators count:", delegators.length);
    console.error("Block:", blockSnapshotEnd);
    
    // CRITICAL: Instead of returning empty strings (which makes everyone non-forwarder),
    // we should throw an error to prevent incorrect merkle generation
    throw new Error(
      `Failed to fetch forwarder data for ${delegators.length} delegators at block ${blockSnapshotEnd}. ` +
      `This is critical for merkle generation. Error: ${error}`
    );
  }
};

export const delegationLogger = async (
  space: string,
  proposal: Proposal,
  voters: string[],
  log: (message: string) => void,
  chainId: string = "1",
  showVoterLabels: boolean = true
) => {
  log(`\nSpace: ${space}`);
  const delegatorData = await fetchDelegatorData(space, proposal, chainId);

  //const blockSnapshotEnd = parseInt(proposal.snapshot);
  const blockSnapshotEnd = await getBlockNumberByTimestamp(proposal.end, "after", 1);


  // If space is cvx.eth, fetch forwarded addresses
  let forwardedMap: Record<string, string> = {};
  if (
    space === "cvx.eth" &&
    delegatorData &&
    delegatorData.delegators.length > 0
  ) {
    const forwardedAddresses = await getForwardedDelegators(
      delegatorData.delegators,
      blockSnapshotEnd
    );
    // Create a mapping from delegator to its forwarded address based on the input order
    delegatorData.delegators.forEach((delegator, index) => {
      forwardedMap[delegator] = forwardedAddresses[index];
    });
  }

  if (delegatorData) {
    const sortedDelegators = delegatorData.delegators
      .filter((delegator) => delegatorData.votingPowers[delegator] > 0)
      .sort(
        (a, b) =>
          (delegatorData.votingPowers[b] || 0) -
          (delegatorData.votingPowers[a] || 0)
      );
    // Only thoses whose above > 0.00000002% of the total VP (below likely no rewards)
    // Filter out delegators with less than 1  voting power
    const filteredDelegators = sortedDelegators.filter(
      (delegator) =>
        delegatorData.votingPowers[delegator] >
        delegatorData.totalVotingPower * 0.00000002
    );

    log(`Total Delegators: ${sortedDelegators.length}`);
    log(
      `Total Delegators with voting power > 0.00000002% of total VP: ${filteredDelegators.length}`
    );
    log(`Total Voting Power: ${delegatorData.totalVotingPower.toFixed(2)}`);

    log("\nDelegator Breakdown:");
    for (const delegator of filteredDelegators) {
      const vp = delegatorData.votingPowers[delegator];
      const share = (vp / delegatorData.totalVotingPower) * 100;
      const hasVoted = showVoterLabels && voters.includes(delegator.toLowerCase())
        ? " (Voted by himself)"
        : "";
      const forwarded =
        forwardedMap[delegator] &&
        forwardedMap[delegator].toLowerCase() ===
          VOTIUM_FORWARDER.toLowerCase();
      log(
        `- ${delegator}: ${vp.toFixed(2)} VP (${share.toFixed(
          2
        )}%)${hasVoted} Forwarded: ${forwarded}`
      );
    }
  } else {
    log("No delegators found");
  }
};

export const fetchDelegatorData = async (
  space: string,
  proposal: any,
  chainId: string = "1"
): Promise<DelegatorDataAugmented | null> => {
  const delegators = await processAllDelegators(
    space,
    proposal.created,
    DELEGATION_ADDRESS
  );

  if (delegators.length === 0) return null;


  const votingPowers = await getVotingPower(proposal, delegators, chainId);
  const totalVotingPower = Object.values(votingPowers).reduce(
    (acc, vp) => acc + vp,
    0
  );

  return {
    delegators,
    votingPowers,
    totalVotingPower,
  };
};

export const proposalInformationLogger = (
  space: string,
  proposal: Proposal,
  log: (message: string) => void
) => {
  log("\n=== Proposal Information ===");
  log(`ID: ${proposal.id}`);
  log(`Title: ${proposal.title}`);
  log(`Space: ${space}`);
  log(`Author: ${formatAddress(proposal.author)}`);
  log(`Created: ${new Date(proposal.created * 1000).toLocaleString()}`);
  log(`Start: ${new Date(proposal.start * 1000).toLocaleString()}`);
  log(`End: ${new Date(proposal.end * 1000).toLocaleString()}`);
  log(`Snapshot Block: ${proposal.snapshot}`);
};
