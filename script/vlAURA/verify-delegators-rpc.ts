/**
 * Verify vlAURA delegators using direct RPC calls to AuraLocker contracts
 * instead of the snapshot.stakedao GraphQL API.
 *
 * This script:
 * 1. Fetches DelegateChanged events from AuraLocker contracts
 * 2. Reconstructs delegation state at the snapshot timestamp
 * 3. Compares with the current repartition_delegation.json
 */

import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";
import * as moment from "moment";
import { getClient } from "../utils/getClients";
import { DELEGATION_ADDRESS, VLAURA_SPACE, WEEK } from "../utils/constants";
import { fetchLastProposalsIds, getProposal, getVoters } from "../utils/snapshot";
import { AURA_LOCKER_ADDRESSES } from "../utils/vlAuraUtils";
import { parseAbiItem, getAddress as viemGetAddress, erc20Abi, type Address, type Log } from "viem";

dotenv.config();

// AuraLocker ABI for balance check
const AURA_LOCKER_ABI = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// AuraLocker uses standard OZ delegation events
const DELEGATE_CHANGED_EVENT = parseAbiItem(
  "event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate)"
);

// AuraLocker creation blocks (approximate, for efficient event fetching)
const AURA_LOCKER_CREATION_BLOCKS: Record<number, bigint> = {
  1: 14975000n,      // Ethereum - deployed around June 2022
  8453: 17894724n,   // Base - deployed later
};

interface DelegationEvent {
  delegator: string;
  fromDelegate: string;
  toDelegate: string;
  blockNumber: bigint;
  timestamp?: number;
}

interface DelegatorState {
  latestBlock: bigint;
  isDelegating: boolean;
}

/**
 * Fetch voting power (vlAURA balance) for multiple addresses at a specific block
 * Returns a map of address -> balance
 */
async function fetchVotingPowers(
  chainId: number,
  addresses: string[],
  atBlock: bigint
): Promise<Map<string, bigint>> {
  const client = await getClient(chainId);
  const lockerAddress = AURA_LOCKER_ADDRESSES[chainId];
  const balances = new Map<string, bigint>();

  if (addresses.length === 0) return balances;

  console.log(`[Chain ${chainId}] Fetching voting power for ${addresses.length} addresses at block ${atBlock}...`);

  // Use multicall for efficiency
  const BATCH_SIZE = 100;
  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE);

    const calls = batch.map((addr) => ({
      address: lockerAddress,
      abi: AURA_LOCKER_ABI,
      functionName: "balanceOf" as const,
      args: [viemGetAddress(addr)] as const,
    }));

    try {
      const results = await client.multicall({
        contracts: calls,
        blockNumber: atBlock,
      });

      results.forEach((result, index) => {
        const addr = batch[index].toLowerCase();
        if (result.status === "success") {
          balances.set(addr, result.result as bigint);
        } else {
          balances.set(addr, 0n);
        }
      });
    } catch (error) {
      console.warn(`[Chain ${chainId}] Multicall failed for batch ${i}, falling back to individual calls`);
      // Fallback to individual calls
      for (const addr of batch) {
        try {
          const balance = await client.readContract({
            address: lockerAddress,
            abi: AURA_LOCKER_ABI,
            functionName: "balanceOf",
            args: [viemGetAddress(addr)],
            blockNumber: atBlock,
          });
          balances.set(addr.toLowerCase(), balance);
        } catch {
          balances.set(addr.toLowerCase(), 0n);
        }
      }
    }
  }

  const nonZeroCount = [...balances.values()].filter(b => b > 0n).length;
  console.log(`[Chain ${chainId}] ${nonZeroCount}/${addresses.length} addresses have non-zero VP`);

  return balances;
}

/**
 * Fetch all DelegateChanged events from AuraLocker contract
 */
async function fetchDelegateChangedEvents(
  chainId: number,
  toBlock: bigint
): Promise<DelegationEvent[]> {
  const client = await getClient(chainId);
  const lockerAddress = AURA_LOCKER_ADDRESSES[chainId];
  const fromBlock = AURA_LOCKER_CREATION_BLOCKS[chainId] || 0n;

  console.log(`[Chain ${chainId}] Fetching DelegateChanged events from block ${fromBlock} to ${toBlock}...`);

  const events: DelegationEvent[] = [];
  const BATCH_SIZE = chainId === 1 ? 50000n : 25000n; // Smaller batches for mainnet and Base RPC limits

  let currentFrom = fromBlock;
  let batchCount = 0;

  while (currentFrom <= toBlock) {
    const currentTo = currentFrom + BATCH_SIZE > toBlock ? toBlock : currentFrom + BATCH_SIZE;
    batchCount++;

    try {
      const logs = await client.getLogs({
        address: lockerAddress,
        event: DELEGATE_CHANGED_EVENT,
        fromBlock: currentFrom,
        toBlock: currentTo,
      });

      for (const log of logs) {
        events.push({
          delegator: (log.args as any).delegator.toLowerCase(),
          fromDelegate: (log.args as any).fromDelegate.toLowerCase(),
          toDelegate: (log.args as any).toDelegate.toLowerCase(),
          blockNumber: log.blockNumber,
        });
      }

      if (batchCount % 10 === 0) {
        console.log(`[Chain ${chainId}] Processed ${batchCount} batches, ${events.length} events found so far...`);
      }

      currentFrom = currentTo + 1n;
    } catch (error: any) {
      // If batch is too large, try smaller
      if (error.message?.includes("query returned more than") || error.code === -32005) {
        console.log(`[Chain ${chainId}] Batch too large, reducing size...`);
        const smallerBatch = BATCH_SIZE / 10n;
        const smallerTo = currentFrom + smallerBatch > toBlock ? toBlock : currentFrom + smallerBatch;

        const logs = await client.getLogs({
          address: lockerAddress,
          event: DELEGATE_CHANGED_EVENT,
          fromBlock: currentFrom,
          toBlock: smallerTo,
        });

        for (const log of logs) {
          events.push({
            delegator: (log.args as any).delegator.toLowerCase(),
            fromDelegate: (log.args as any).fromDelegate.toLowerCase(),
            toDelegate: (log.args as any).toDelegate.toLowerCase(),
            blockNumber: log.blockNumber,
          });
        }

        currentFrom = smallerTo + 1n;
      } else {
        throw error;
      }
    }
  }

  console.log(`[Chain ${chainId}] Found ${events.length} total DelegateChanged events`);
  return events;
}

/**
 * Reconstruct delegation state at a specific block
 */
function reconstructDelegationState(
  events: DelegationEvent[],
  targetDelegate: string,
  atBlock: bigint
): string[] {
  const normalizedTarget = targetDelegate.toLowerCase();

  // Filter events up to target block
  const relevantEvents = events
    .filter(e => e.blockNumber <= atBlock)
    .sort((a, b) => Number(a.blockNumber - b.blockNumber));

  // Build state: delegator -> their current delegate
  const delegatorToDelegate = new Map<string, string>();

  for (const event of relevantEvents) {
    delegatorToDelegate.set(event.delegator, event.toDelegate);
  }

  // Find all delegators currently delegating to target
  const activeDelegators: string[] = [];
  for (const [delegator, delegate] of delegatorToDelegate) {
    if (delegate === normalizedTarget) {
      activeDelegators.push(delegator);
    }
  }

  return activeDelegators;
}

async function main() {
  console.log("=".repeat(80));
  console.log("vlAURA Delegators Verification via RPC");
  console.log("=".repeat(80));

  const now = moment.utc().unix();
  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;

  // Load current repartition_delegation.json
  const dirPath = `bounties-reports/${currentPeriodTimestamp}/vlAURA`;
  const delegationFile = path.join(dirPath, "repartition_delegation.json");

  if (!fs.existsSync(delegationFile)) {
    console.error(`No delegation file found at ${delegationFile}`);
    process.exit(1);
  }

  const delegationData = JSON.parse(fs.readFileSync(delegationFile, "utf-8"));
  const existingDelegators = Object.keys(delegationData.distribution.delegators).map(d => d.toLowerCase());

  console.log(`\nLoaded ${existingDelegators.length} delegators from repartition_delegation.json`);

  // Fetch proposal to get snapshot block
  console.log("\nFetching proposal...");
  const filter = "Gauge Weight for Week of";
  const proposalIdPerSpace = await fetchLastProposalsIds([VLAURA_SPACE], now, filter);
  const proposalId = proposalIdPerSpace[VLAURA_SPACE];
  const proposal = await getProposal(proposalId);

  const snapshotBlock = BigInt(proposal.snapshot);
  console.log(`Proposal: ${proposal.title}`);
  console.log(`Snapshot block: ${snapshotBlock}`);

  // Get snapshot block timestamp
  const publicClient = await getClient(1);
  const snapshotBlockData = await publicClient.getBlock({ blockNumber: snapshotBlock });
  const snapshotTimestamp = Number(snapshotBlockData.timestamp);
  console.log(`Snapshot timestamp: ${snapshotTimestamp} (${new Date(snapshotTimestamp * 1000).toISOString()})`);

  // Fetch voters to exclude those who voted directly
  const votes = await getVoters(proposalId);
  const directVoters = new Set(votes.map(v => v.voter.toLowerCase()));
  console.log(`\nDirect voters: ${directVoters.size}`);

  const stakeDAODelegateAddress = DELEGATION_ADDRESS.toLowerCase();
  console.log(`\nStakeDAO delegation address: ${stakeDAODelegateAddress}`);

  // === RPC-based delegation discovery ===
  console.log("\n" + "=".repeat(80));
  console.log("Fetching delegations via RPC (DelegateChanged events)");
  console.log("=".repeat(80));

  // For each chain, fetch events and reconstruct state
  const rpcDelegators = new Set<string>();
  const chainTargetBlocks: Record<number, bigint> = {};
  const delegatorsByChain: Record<number, string[]> = { 1: [], 8453: [] };

  for (const chainId of [1, 8453]) {
    try {
      // Get the block for this chain at snapshot timestamp
      let targetBlock: bigint;
      if (chainId === 1) {
        targetBlock = snapshotBlock;
      } else {
        // For Base, find block at same timestamp
        const baseClient = await getClient(8453);
        // Use binary search to find block
        const latestBlock = await baseClient.getBlock({ blockTag: "latest" });
        let low = AURA_LOCKER_CREATION_BLOCKS[8453];
        let high = latestBlock.number;

        while (low < high) {
          const mid = (low + high) / 2n;
          const block = await baseClient.getBlock({ blockNumber: mid });
          if (block.timestamp < BigInt(snapshotTimestamp)) {
            low = mid + 1n;
          } else {
            high = mid;
          }
        }
        targetBlock = low;
        const baseBlockData = await baseClient.getBlock({ blockNumber: targetBlock });
        console.log(`[Base] Using block ${targetBlock} at timestamp ${baseBlockData.timestamp}`);
      }

      chainTargetBlocks[chainId] = targetBlock;

      const events = await fetchDelegateChangedEvents(chainId, targetBlock);
      const delegators = reconstructDelegationState(events, stakeDAODelegateAddress, targetBlock);

      console.log(`[Chain ${chainId}] Found ${delegators.length} delegators to StakeDAO at block ${targetBlock}`);

      delegatorsByChain[chainId] = delegators;
      for (const d of delegators) {
        rpcDelegators.add(d);
      }
    } catch (error) {
      console.error(`[Chain ${chainId}] Error:`, error);
    }
  }

  console.log(`\nTotal unique delegators from RPC: ${rpcDelegators.size}`);

  // Remove direct voters
  const rpcDelegatorsAfterVoters = [...rpcDelegators].filter(d => !directVoters.has(d));
  console.log(`After removing direct voters: ${rpcDelegatorsAfterVoters.length}`);

  // === Filter by voting power ===
  console.log("\n" + "=".repeat(80));
  console.log("Checking voting power at snapshot block");
  console.log("=".repeat(80));

  // Fetch VP for all delegators on each chain
  const allVotingPowers = new Map<string, bigint>();

  for (const chainId of [1, 8453]) {
    const targetBlock = chainTargetBlocks[chainId];
    if (!targetBlock) continue;

    // Get delegators that haven't voted directly
    const chainDelegators = delegatorsByChain[chainId].filter(d => !directVoters.has(d));
    if (chainDelegators.length === 0) continue;

    const vpMap = await fetchVotingPowers(chainId, chainDelegators, targetBlock);

    // Merge into allVotingPowers (sum across chains)
    for (const [addr, vp] of vpMap) {
      const existing = allVotingPowers.get(addr) || 0n;
      allVotingPowers.set(addr, existing + vp);
    }
  }

  // Filter out zero-VP delegators
  const zeroVpDelegators: string[] = [];
  const rpcDelegatorsFiltered: string[] = [];

  for (const delegator of rpcDelegatorsAfterVoters) {
    const vp = allVotingPowers.get(delegator) || 0n;
    if (vp > 0n) {
      rpcDelegatorsFiltered.push(delegator);
    } else {
      zeroVpDelegators.push(delegator);
    }
  }

  console.log(`\nDelegators with zero VP: ${zeroVpDelegators.length}`);
  if (zeroVpDelegators.length > 0 && zeroVpDelegators.length <= 10) {
    for (const addr of zeroVpDelegators) {
      console.log(`  ${addr}`);
    }
  }
  console.log(`After removing zero-VP delegators: ${rpcDelegatorsFiltered.length}`);

  // === Compare with Parquet cache ===
  console.log("\n" + "=".repeat(80));
  console.log("Fetching delegations via Parquet cache (for comparison)");
  console.log("=".repeat(80));

  const hyparquet = await import("hyparquet");
  const parquetFiles: Record<number, string> = {
    1: "data/vlaura-delegations/1/0x3Fa73f1E5d8A792C80F426fc8F84FBF7Ce9bBCAC.parquet",
    8453: "data/vlaura-delegations/8453/0x9e1f4190f1a8Fe0cD57421533deCB57F9980922e.parquet",
  };

  const parquetDelegators = new Set<string>();

  for (const [chainIdStr, filePath] of Object.entries(parquetFiles)) {
    const chainId = Number(chainIdStr);
    // Use chain-specific snapshot block
    const targetBlock = chainId === 1 ? snapshotBlock : await (async () => {
      const baseClient = await getClient(8453);
      const latestBlock = await baseClient.getBlock({ blockTag: "latest" });
      let low = AURA_LOCKER_CREATION_BLOCKS[8453];
      let high = latestBlock.number;
      while (low < high) {
        const mid = (low + high) / 2n;
        const block = await baseClient.getBlock({ blockNumber: mid });
        if (block.timestamp < BigInt(snapshotTimestamp)) {
          low = mid + 1n;
        } else {
          high = mid;
        }
      }
      return low;
    })();

    if (!fs.existsSync(filePath)) {
      console.log(`[Chain ${chainId}] Parquet file not found: ${filePath}`);
      continue;
    }

    let events: any[] = [];
    await hyparquet.parquetRead({
      file: await hyparquet.asyncBufferFromFile(filePath),
      rowFormat: "object",
      onComplete: (result: any[]) => { events = result; },
    });

    // Build delegation state at snapshot
    const delegatorState = new Map<string, { toDelegate: string; block: number }>();
    for (const e of events) {
      if (e.event === "EndBlock") continue;
      const block = Number(e.blockNumber);
      if (block > Number(targetBlock)) continue;
      const existing = delegatorState.get(e.delegator);
      if (!existing || block > existing.block) {
        delegatorState.set(e.delegator, { toDelegate: e.toDelegate, block });
      }
    }

    // Find delegators to StakeDAO
    let count = 0;
    for (const [delegator, state] of delegatorState) {
      if (state.toDelegate === stakeDAODelegateAddress) {
        parquetDelegators.add(delegator);
        count++;
      }
    }
    console.log(`[Chain ${chainId}] Parquet: ${count} delegators at snapshot`);
  }

  // Filter out direct voters from parquet
  const parquetDelegatorsFiltered = [...parquetDelegators].filter(d => !directVoters.has(d));
  console.log(`Parquet delegators (after filtering direct voters): ${parquetDelegatorsFiltered.length}`);

  // === Comparison ===
  console.log("\n" + "=".repeat(80));
  console.log("COMPARISON RESULTS");
  console.log("=".repeat(80));

  const rpcSet = new Set(rpcDelegatorsFiltered.map(d => d.toLowerCase()));
  const parquetSet = new Set(parquetDelegatorsFiltered.map(d => d.toLowerCase()));
  const existingSet = new Set(existingDelegators);

  console.log(`\nDelegator counts:`);
  console.log(`  - RPC (DelegateChanged events): ${rpcSet.size}`);
  console.log(`  - Parquet cache: ${parquetSet.size}`);
  console.log(`  - Existing repartition file: ${existingSet.size}`);

  // Find differences
  const inRpcNotParquet = [...rpcSet].filter(d => !parquetSet.has(d));
  const inParquetNotRpc = [...parquetSet].filter(d => !rpcSet.has(d));
  const inRpcNotExisting = [...rpcSet].filter(d => !existingSet.has(d));
  const inExistingNotRpc = [...existingSet].filter(d => !rpcSet.has(d));

  console.log(`\nDifferences:`);
  console.log(`  - In RPC but NOT in Parquet: ${inRpcNotParquet.length}`);
  if (inRpcNotParquet.length > 0) {
    console.log(`    ${inRpcNotParquet.join("\n    ")}`);
  }

  console.log(`  - In Parquet but NOT in RPC: ${inParquetNotRpc.length}`);
  if (inParquetNotRpc.length > 0) {
    console.log(`    ${inParquetNotRpc.join("\n    ")}`);
  }

  console.log(`\n  - In RPC but NOT in existing file: ${inRpcNotExisting.length}`);
  if (inRpcNotExisting.length > 0) {
    console.log(`    ${inRpcNotExisting.join("\n    ")}`);
  }

  console.log(`  - In existing file but NOT in RPC: ${inExistingNotRpc.length}`);
  if (inExistingNotRpc.length > 0) {
    console.log(`    ${inExistingNotRpc.join("\n    ")}`);
  }

  // Parquet staleness check
  if (inRpcNotParquet.length > 0) {
    console.log(`\n⚠️  PARQUET CACHE STALE: ${inRpcNotParquet.length} delegators in RPC but not in Parquet`);
    console.log("   Run: pnpm tsx script/indexer/vlauraDelegators.ts");
  }

  // Final verdict
  console.log("\n" + "=".repeat(80));
  if (rpcSet.size === existingSet.size && inRpcNotExisting.length === 0 && inExistingNotRpc.length === 0) {
    console.log("✅ VERIFIED: RPC delegators match existing repartition file");
  } else if (inExistingNotRpc.length > 0) {
    console.log("⚠️  WARNING: Some delegators in file are NOT found via RPC");
    console.log("   This could indicate stale data in the repartition file");
  } else if (inRpcNotExisting.length > 0) {
    console.log("⚠️  WARNING: Some RPC delegators are MISSING from the repartition file");
    console.log("   These delegators may be missing rewards (check if they have zero VP)!");
  } else {
    console.log("⚠️  MISMATCH: Delegator counts differ");
  }
  console.log("=".repeat(80));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
