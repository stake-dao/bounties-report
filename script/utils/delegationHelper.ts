import { DelegatorDataAugmented } from "../interfaces/DelegatorDataAugmented";
import { formatAddress } from "./address";
import { getBlockNumberByTimestamp } from "./chainUtils";
import { processAllDelegators } from "./cacheUtils";
import { getClient, DELEGATION_ADDRESS, VOTIUM_FORWARDER_REGISTRY, VLAURA_SPACE } from "./constants";
import { getVotingPower } from "./snapshot";
import { Proposal } from "./types";
import { VOTIUM_FORWARDER } from "./constants";
import { verifyDelegators, fetchDelegatorsWithFallback } from "./delegationAPIUtils";
import { getSnapshotBlocks, getDelegatorsWithBalances, formatVlAuraBalance } from "./vlAuraUtils";

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
    const client = await getClient(1);
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
    // Only those whose VP is above > 0.00000002% of the total VP (below likely no rewards)
    // Use a small epsilon for floating-point comparison to ensure deterministic results
    const vpThreshold = delegatorData.totalVotingPower * 0.00000002;
    const epsilon = 1e-9;
    const filteredDelegators = sortedDelegators.filter(
      (delegator) =>
        delegatorData.votingPowers[delegator] > vpThreshold - epsilon
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
  chainId: string = "1",
  options: { verify?: boolean; useFallback?: boolean } = {}
): Promise<DelegatorDataAugmented | null> => {
  const { verify = false, useFallback = false } = options;

  // For vlAURA, use on-chain method instead of Snapshot's score API
  // (Snapshot's erc20-votes-with-override strategy doesn't work at historical blocks)
  if (space === VLAURA_SPACE) {
    return fetchVlAuraDelegatorData(proposal);
  }

  let delegators: string[];

  if (useFallback) {
    // Use parquet with API fallback
    delegators = await fetchDelegatorsWithFallback(
      space,
      proposal.created,
      DELEGATION_ADDRESS
    );
  } else {
    // Use parquet only (default behavior)
    delegators = await processAllDelegators(
      space,
      proposal.created,
      DELEGATION_ADDRESS
    );
  }

  if (delegators.length === 0) return null;

  // Optional verification against REST API
  if (verify) {
    try {
      const verification = await verifyDelegators(
        space,
        proposal.created,
        DELEGATION_ADDRESS
      );
      if (!verification.isValid) {
        console.warn(
          `[${space}] Delegator verification failed! ` +
          `Match rate: ${verification.matchRate.toFixed(2)}%, ` +
          `Parquet: ${verification.parquetCount}, API: ${verification.apiCount}`
        );
      }
    } catch (error) {
      console.warn(`[${space}] Verification skipped due to error:`, error);
    }
  }

  // Use batching to avoid overloading Snapshot's score API
  const votingPowers = await getVotingPower(proposal, delegators, chainId, false, 5, 1000);
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

/**
 * Fetch vlAURA delegator data using on-chain queries
 * (Snapshot's score API doesn't work with erc20-votes-with-override strategy at historical blocks)
 */
const fetchVlAuraDelegatorData = async (
  proposal: any
): Promise<DelegatorDataAugmented | null> => {
  // Get snapshot blocks for all chains based on proposal snapshot
  const snapshotBlocks = await getSnapshotBlocks(BigInt(proposal.snapshot));

  // Get delegators with their vlAURA balances
  const delegatorsWithBalances = await getDelegatorsWithBalances(snapshotBlocks);

  if (delegatorsWithBalances.length === 0) return null;

  // Convert to the expected format
  const delegators: string[] = [];
  const votingPowers: Record<string, number> = {};
  let totalVotingPower = 0;

  for (const delegator of delegatorsWithBalances) {
    const address = delegator.address.toLowerCase();
    // Convert from wei (18 decimals) to human-readable number
    const vp = Number(delegator.totalBalance) / 1e18;

    delegators.push(address);
    votingPowers[address] = vp;
    totalVotingPower += vp;
  }

  console.log(`vlAURA on-chain: ${delegators.length} delegators, total VP: ${formatVlAuraBalance(BigInt(Math.floor(totalVotingPower * 1e18)))}`);

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
