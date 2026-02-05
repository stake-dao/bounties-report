/**
 * Verify vlCVX delegators using direct RPC calls to Snapshot Delegation Registry
 * instead of relying solely on block explorer APIs (parquet cache).
 *
 * This script:
 * 1. Fetches SetDelegate and ClearDelegate events from Snapshot Delegation Registry
 * 2. Reconstructs delegation state at the snapshot block
 * 3. Compares with the parquet cache and current repartition_delegation.json
 *
 * Usage:
 *   pnpm tsx script/vlCVX/verify-delegators-rpc.ts [--timestamp <ts>] [--gauge-type <curve|fxn|all>]
 */

import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { formatBytes32String } from "ethers/lib/utils";
import { getClient } from "../utils/getClients";
import {
  DELEGATION_ADDRESS,
  DELEGATE_REGISTRY,
  DELEGATE_REGISTRY_CREATION_BLOCK_ETH,
  CVX_SPACE,
  WEEK,
} from "../utils/constants";
import { fetchLastProposalsIds, getProposal, getVoters } from "../utils/snapshot";
import { parseAbiItem, getAddress } from "viem";

dotenv.config();

// vlCVX token contract address (CvxLockerV2)
const VLCVX_TOKEN = "0x72a19342e8F1838460eBFCCEf09F6585e32db86E" as const;

// vlCVX ABI for balance check
const VLCVX_ABI = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// Snapshot Delegation Registry events
const SET_DELEGATE_EVENT = parseAbiItem(
  "event SetDelegate(address indexed delegator, bytes32 indexed id, address indexed delegate)"
);

const CLEAR_DELEGATE_EVENT = parseAbiItem(
  "event ClearDelegate(address indexed delegator, bytes32 indexed id, address indexed delegate)"
);

interface DelegationEvent {
  delegator: string;
  space: string; // bytes32
  delegate: string;
  blockNumber: bigint;
  eventType: "Set" | "Clear";
  timestamp?: number;
}


/**
 * Fetch voting power (vlCVX balance) for multiple addresses at a specific block
 * Returns a map of address -> balance
 */
async function fetchVotingPowers(
  addresses: string[],
  atBlock: bigint
): Promise<Map<string, bigint>> {
  const client = await getClient(1);
  const balances = new Map<string, bigint>();

  if (addresses.length === 0) return balances;

  console.log(`Fetching voting power for ${addresses.length} addresses at block ${atBlock}...`);

  // Use multicall for efficiency
  const BATCH_SIZE = 100;
  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE);

    const calls = batch.map((addr) => ({
      address: getAddress(VLCVX_TOKEN),
      abi: VLCVX_ABI,
      functionName: "balanceOf" as const,
      args: [getAddress(addr)] as const,
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
      console.warn(`  Multicall failed for batch ${i}, falling back to individual calls`);
      // Fallback to individual calls
      for (const addr of batch) {
        try {
          const balance = await client.readContract({
            address: getAddress(VLCVX_TOKEN),
            abi: VLCVX_ABI,
            functionName: "balanceOf",
            args: [getAddress(addr)],
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
  console.log(`  ${nonZeroCount}/${addresses.length} addresses have non-zero VP`);

  return balances;
}

/**
 * Fetch all SetDelegate and ClearDelegate events from Delegation Registry
 */
async function fetchDelegationEvents(
  targetDelegate: string,
  spaceBytes32: string,
  toBlock: bigint
): Promise<DelegationEvent[]> {
  const client = await getClient(1);
  const fromBlock = BigInt(DELEGATE_REGISTRY_CREATION_BLOCK_ETH);
  const normalizedDelegate = getAddress(targetDelegate);

  console.log(`Fetching delegation events from block ${fromBlock} to ${toBlock}...`);
  console.log(`  Target delegate: ${normalizedDelegate}`);
  console.log(`  Space (bytes32): ${spaceBytes32}`);

  const events: DelegationEvent[] = [];
  const BATCH_SIZE = 45000n; // Public RPCs often limit to 50k blocks

  let currentFrom = fromBlock;
  let batchCount = 0;

  while (currentFrom <= toBlock) {
    const currentTo = currentFrom + BATCH_SIZE > toBlock ? toBlock : currentFrom + BATCH_SIZE;
    batchCount++;

    try {
      // Fetch SetDelegate events for target delegate and space
      const setLogs = await client.getLogs({
        address: getAddress(DELEGATE_REGISTRY),
        event: SET_DELEGATE_EVENT,
        args: {
          id: spaceBytes32 as `0x${string}`,
          delegate: normalizedDelegate,
        },
        fromBlock: currentFrom,
        toBlock: currentTo,
      });

      for (const log of setLogs) {
        events.push({
          delegator: (log.args as any).delegator.toLowerCase(),
          space: (log.args as any).id,
          delegate: (log.args as any).delegate.toLowerCase(),
          blockNumber: log.blockNumber,
          eventType: "Set",
        });
      }

      // Fetch ClearDelegate events for target delegate and space
      const clearLogs = await client.getLogs({
        address: getAddress(DELEGATE_REGISTRY),
        event: CLEAR_DELEGATE_EVENT,
        args: {
          id: spaceBytes32 as `0x${string}`,
          delegate: normalizedDelegate,
        },
        fromBlock: currentFrom,
        toBlock: currentTo,
      });

      for (const log of clearLogs) {
        events.push({
          delegator: (log.args as any).delegator.toLowerCase(),
          space: (log.args as any).id,
          delegate: (log.args as any).delegate.toLowerCase(),
          blockNumber: log.blockNumber,
          eventType: "Clear",
        });
      }

      if (batchCount % 5 === 0) {
        console.log(`  Processed ${batchCount} batches, ${events.length} events found so far...`);
      }

      currentFrom = currentTo + 1n;
    } catch (error: any) {
      // If batch is too large, try smaller
      if (error.message?.includes("query returned more than") || error.code === -32005) {
        console.log(`  Batch too large, reducing size...`);
        const smallerBatch = BATCH_SIZE / 10n;
        const smallerTo = currentFrom + smallerBatch > toBlock ? toBlock : currentFrom + smallerBatch;

        const setLogs = await client.getLogs({
          address: getAddress(DELEGATE_REGISTRY),
          event: SET_DELEGATE_EVENT,
          args: {
            id: spaceBytes32 as `0x${string}`,
            delegate: normalizedDelegate,
          },
          fromBlock: currentFrom,
          toBlock: smallerTo,
        });

        for (const log of setLogs) {
          events.push({
            delegator: (log.args as any).delegator.toLowerCase(),
            space: (log.args as any).id,
            delegate: (log.args as any).delegate.toLowerCase(),
            blockNumber: log.blockNumber,
            eventType: "Set",
          });
        }

        const clearLogs = await client.getLogs({
          address: getAddress(DELEGATE_REGISTRY),
          event: CLEAR_DELEGATE_EVENT,
          args: {
            id: spaceBytes32 as `0x${string}`,
            delegate: normalizedDelegate,
          },
          fromBlock: currentFrom,
          toBlock: smallerTo,
        });

        for (const log of clearLogs) {
          events.push({
            delegator: (log.args as any).delegator.toLowerCase(),
            space: (log.args as any).id,
            delegate: (log.args as any).delegate.toLowerCase(),
            blockNumber: log.blockNumber,
            eventType: "Clear",
          });
        }

        currentFrom = smallerTo + 1n;
      } else {
        throw error;
      }
    }
  }

  console.log(`  Found ${events.length} total delegation events`);
  return events;
}

/**
 * Reconstruct delegation state at a specific block
 */
function reconstructDelegationState(
  events: DelegationEvent[],
  atBlock: bigint
): string[] {
  // Filter events up to target block and sort by block number
  const relevantEvents = events
    .filter((e) => e.blockNumber <= atBlock)
    .sort((a, b) => Number(a.blockNumber - b.blockNumber));

  // Build state: delegator -> is currently delegating
  const delegatorState = new Map<string, boolean>();

  for (const event of relevantEvents) {
    if (event.eventType === "Set") {
      delegatorState.set(event.delegator, true);
    } else {
      delegatorState.set(event.delegator, false);
    }
  }

  // Find all active delegators
  const activeDelegators: string[] = [];
  for (const [delegator, isDelegating] of delegatorState) {
    if (isDelegating) {
      activeDelegators.push(delegator);
    }
  }

  return activeDelegators;
}

/**
 * Read parquet file to compare with RPC data
 */
async function readParquetDelegators(
  delegationAddress: string,
  spaceBytes32: string,
  snapshotTimestamp: number
): Promise<string[]> {
  const filePath = path.join(
    __dirname,
    `../../data/delegations/1/${delegationAddress}.parquet`
  );

  if (!fs.existsSync(filePath)) {
    console.warn(`Parquet file not found: ${filePath}`);
    return [];
  }

  try {
    const { parquetRead, asyncBufferFromFile } = await import("hyparquet");

    let data: any[] = [];
    await parquetRead({
      file: await asyncBufferFromFile(filePath),
      rowFormat: "object",
      onComplete: (result: any[]) => {
        data = result;
      },
    });

    // Filter by space and timestamp
    const filtered = data.filter(
      (d) =>
        d.spaceId?.toLowerCase() === spaceBytes32.toLowerCase() &&
        d.timestamp <= snapshotTimestamp &&
        d.event !== "EndBlock"
    );

    // Group events by user
    const userEvents: Record<string, string[]> = {};
    for (const entry of filtered) {
      const user = entry.user.toLowerCase();
      if (!userEvents[user]) {
        userEvents[user] = [];
      }
      userEvents[user].push(entry.event);
    }

    // Keep only users whose last event is "Set"
    const activeDelegators: string[] = [];
    for (const [user, events] of Object.entries(userEvents)) {
      if (events[events.length - 1] === "Set") {
        activeDelegators.push(user);
      }
    }

    return activeDelegators;
  } catch (error) {
    console.error(`Error reading parquet file:`, error);
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);

  let timestamp: number | undefined;
  let gaugeType: "curve" | "fxn" | "all" = "all";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) {
      timestamp = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === "--gauge-type" && args[i + 1]) {
      gaugeType = args[i + 1] as "curve" | "fxn" | "all";
      i++;
    } else if (args[i] === "--help") {
      console.log(`
Usage: pnpm tsx script/vlCVX/verify-delegators-rpc.ts [options]

Options:
  --timestamp <ts>    Period timestamp (default: current period)
  --gauge-type <type> Gauge type: curve, fxn, or all (default: all)
  --help              Show this help message
`);
      process.exit(0);
    }
  }

  // Default to current period
  if (!timestamp) {
    const now = Math.floor(Date.now() / 1000);
    timestamp = Math.floor(now / WEEK) * WEEK;
  }

  console.log("=".repeat(80));
  console.log("vlCVX Delegators Verification via RPC");
  console.log("=".repeat(80));
  console.log(`\nPeriod: ${timestamp} (${new Date(timestamp * 1000).toISOString()})`);

  const gaugeTypes: Array<"curve" | "fxn"> =
    gaugeType === "all" ? ["curve", "fxn"] : [gaugeType as "curve" | "fxn"];

  const stakeDAODelegateAddress = DELEGATION_ADDRESS;
  console.log(`StakeDAO delegation address: ${stakeDAODelegateAddress}`);

  for (const gt of gaugeTypes) {
    console.log("\n" + "=".repeat(80));
    console.log(`Verifying ${gt.toUpperCase()} gauge type`);
    console.log("=".repeat(80));

    // Both Curve and FXN use the same cvx.eth space for delegation
    // (only the proposal filter differs - FXN proposals have "FXN" prefix)
    const space = CVX_SPACE; // Always cvx.eth for both gauge types
    const spaceBytes32 = formatBytes32String(space);
    console.log(`Space: ${space} (used for both Curve and FXN delegation)`);
    console.log(`Space (bytes32): ${spaceBytes32}`);

    // Get proposal to find snapshot block
    console.log("\nFetching proposal...");
    const filter =
      gt === "fxn"
        ? "^FXN.*Gauge Weight for Week of"
        : "^(?!FXN ).*Gauge Weight for Week of";

    const proposalIdPerSpace = await fetchLastProposalsIds([CVX_SPACE], timestamp + WEEK, filter);
    const proposalId = proposalIdPerSpace[CVX_SPACE];

    if (!proposalId) {
      console.error(`No proposal found for ${gt} gauge type`);
      continue;
    }

    const proposal = await getProposal(proposalId);
    const snapshotBlock = BigInt(proposal.snapshot);

    console.log(`Proposal: ${proposal.title}`);
    console.log(`Proposal ID: ${proposalId}`);
    console.log(`Snapshot block: ${snapshotBlock}`);

    // Get snapshot block timestamp
    const publicClient = await getClient(1);
    const snapshotBlockData = await publicClient.getBlock({ blockNumber: snapshotBlock });
    const snapshotTimestamp = Number(snapshotBlockData.timestamp);
    console.log(
      `Snapshot timestamp: ${snapshotTimestamp} (${new Date(snapshotTimestamp * 1000).toISOString()})`
    );

    // Fetch voters to exclude those who voted directly
    const votes = await getVoters(proposalId);
    const directVoters = new Set(votes.map((v) => v.voter.toLowerCase()));
    console.log(`Direct voters: ${directVoters.size}`);

    // === RPC-based delegation discovery ===
    console.log("\n--- Fetching delegations via RPC ---");

    const events = await fetchDelegationEvents(
      stakeDAODelegateAddress,
      spaceBytes32,
      snapshotBlock
    );

    const rpcDelegators = reconstructDelegationState(events, snapshotBlock);
    console.log(`RPC delegators (raw): ${rpcDelegators.length}`);

    // Remove direct voters and delegation address
    const rpcDelegatorsAfterVoters = rpcDelegators.filter(
      (d) =>
        !directVoters.has(d) && d !== stakeDAODelegateAddress.toLowerCase()
    );
    console.log(`RPC delegators (after removing voters): ${rpcDelegatorsAfterVoters.length}`);

    // === Filter by voting power ===
    console.log("\n--- Checking voting power at snapshot block ---");
    const vpMap = await fetchVotingPowers(rpcDelegatorsAfterVoters, snapshotBlock);

    const zeroVpDelegators: string[] = [];
    const rpcDelegatorsFiltered: string[] = [];

    for (const delegator of rpcDelegatorsAfterVoters) {
      const vp = vpMap.get(delegator) || 0n;
      if (vp > 0n) {
        rpcDelegatorsFiltered.push(delegator);
      } else {
        zeroVpDelegators.push(delegator);
      }
    }

    console.log(`Delegators with zero VP: ${zeroVpDelegators.length}`);
    if (zeroVpDelegators.length > 0 && zeroVpDelegators.length <= 10) {
      for (const addr of zeroVpDelegators) {
        console.log(`  ${addr}`);
      }
    }
    console.log(`RPC delegators (after removing zero-VP): ${rpcDelegatorsFiltered.length}`);

    // === Parquet-based delegation (for comparison) ===
    console.log("\n--- Fetching delegations via Parquet cache ---");

    const parquetDelegators = await readParquetDelegators(
      stakeDAODelegateAddress,
      spaceBytes32,
      snapshotTimestamp
    );
    const parquetDelegatorsFiltered = parquetDelegators.filter(
      (d) =>
        !directVoters.has(d) && d !== stakeDAODelegateAddress.toLowerCase()
    );
    console.log(`Parquet delegators (after filtering): ${parquetDelegatorsFiltered.length}`);

    // === Load repartition file ===
    const dirPath = `bounties-reports/${timestamp}/vlCVX/${gt}`;
    const delegationFilePath = path.join(__dirname, `../../${dirPath}/repartition_delegation.json`);

    let existingDelegators: string[] = [];
    if (fs.existsSync(delegationFilePath)) {
      const delegationData = JSON.parse(fs.readFileSync(delegationFilePath, "utf-8"));
      const forwarders = Object.keys(delegationData.distribution?.forwarders || {});
      const nonForwarders = Object.keys(delegationData.distribution?.nonForwarders || {});
      existingDelegators = [...forwarders, ...nonForwarders].map((a) => a.toLowerCase());
      console.log(`\nRepartition file delegators: ${existingDelegators.length}`);
    } else {
      console.warn(`\nRepartition file not found: ${delegationFilePath}`);
    }

    // === Comparison ===
    console.log("\n" + "=".repeat(60));
    console.log("COMPARISON RESULTS");
    console.log("=".repeat(60));

    const rpcSet = new Set(rpcDelegatorsFiltered);
    const parquetSet = new Set(parquetDelegatorsFiltered);
    const existingSet = new Set(existingDelegators);

    console.log(`\nDelegator counts:`);
    console.log(`  - RPC (direct events):       ${rpcSet.size}`);
    console.log(`  - Parquet (cached events):   ${parquetSet.size}`);
    console.log(`  - Repartition file:          ${existingSet.size}`);

    // Find differences between RPC and Parquet
    const inRpcNotParquet = [...rpcSet].filter((d) => !parquetSet.has(d));
    const inParquetNotRpc = [...parquetSet].filter((d) => !rpcSet.has(d));

    console.log(`\nRPC vs Parquet:`);
    console.log(`  - In RPC but NOT in Parquet: ${inRpcNotParquet.length}`);
    if (inRpcNotParquet.length > 0 && inRpcNotParquet.length <= 10) {
      for (const addr of inRpcNotParquet) {
        console.log(`    ${addr}`);
      }
    }

    console.log(`  - In Parquet but NOT in RPC: ${inParquetNotRpc.length}`);
    if (inParquetNotRpc.length > 0 && inParquetNotRpc.length <= 10) {
      for (const addr of inParquetNotRpc) {
        console.log(`    ${addr}`);
      }
    }

    // Find differences between RPC and existing file
    const inRpcNotExisting = [...rpcSet].filter((d) => !existingSet.has(d));
    const inExistingNotRpc = [...existingSet].filter((d) => !rpcSet.has(d));

    console.log(`\nRPC vs Repartition file:`);
    console.log(`  - In RPC but NOT in file:    ${inRpcNotExisting.length}`);
    if (inRpcNotExisting.length > 0 && inRpcNotExisting.length <= 10) {
      for (const addr of inRpcNotExisting) {
        console.log(`    ${addr}`);
      }
    }

    console.log(`  - In file but NOT in RPC:    ${inExistingNotRpc.length}`);
    if (inExistingNotRpc.length > 0 && inExistingNotRpc.length <= 10) {
      for (const addr of inExistingNotRpc) {
        console.log(`    ${addr}`);
      }
    }

    // Final verdict for this gauge type
    console.log("\n" + "-".repeat(60));
    if (inExistingNotRpc.length === 0 && inRpcNotExisting.length === 0) {
      console.log(`✅ ${gt.toUpperCase()}: RPC delegators match repartition file`);
    } else if (inExistingNotRpc.length > 0) {
      console.log(`⚠️  ${gt.toUpperCase()}: ${inExistingNotRpc.length} delegators in file NOT found via RPC`);
      console.log(`   This could indicate addresses that un-delegated but weren't removed`);
    } else if (inRpcNotExisting.length > 0) {
      console.log(`⚠️  ${gt.toUpperCase()}: ${inRpcNotExisting.length} RPC delegators MISSING from file`);
      console.log(`   These may be zero-VP delegators (expected) or missing rewards (check VP)`);
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("Verification complete");
  console.log("=".repeat(80));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
