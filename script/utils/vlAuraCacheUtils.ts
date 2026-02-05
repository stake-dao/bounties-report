/**
 * vlAURA Delegation Cache Utilities
 *
 * Stores and retrieves DelegateChanged events from AuraLocker contracts
 * in Parquet format for reliable, deterministic snapshot queries.
 *
 * Unlike the Delegate Registry (used by vlCVX), AuraLocker uses OZ-style
 * delegation with DelegateChanged(delegator, fromDelegate, toDelegate).
 * No spaceId - each chain has its own AuraLocker contract.
 */

import * as fs from "fs";
import * as path from "path";
import * as parquet from "parquetjs";
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { mainnet, base } from "./chains";
import { AURA_LOCKER_ADDRESSES } from "./vlAuraUtils";

const DATA_DIR = path.join(__dirname, "../../data");
const VLAURA_DELEGATIONS_DIR = path.join(DATA_DIR, "vlaura-delegations");

// AuraLocker creation blocks (for efficient event fetching)
const AURA_LOCKER_CREATION_BLOCKS: Record<number, bigint> = {
  1: 14975000n, // Ethereum - deployed around June 2022
  8453: 17894724n, // Base - deployed later
};

// AuraLocker DelegateChanged event
const DELEGATE_CHANGED_EVENT = parseAbiItem(
  "event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate)"
);

/**
 * Schema for vlAURA delegation events stored in Parquet
 */
export interface VlAuraDelegationEvent {
  event: "DelegateChanged" | "EndBlock";
  delegator: string; // address that delegated (lowercase)
  toDelegate: string; // who they delegated TO (lowercase)
  timestamp: number; // unix timestamp
  blockNumber: number; // block number
}

/**
 * Get the Parquet file path for a chain's AuraLocker
 */
function getVlAuraDelegationsFilePath(chainId: number): string {
  const lockerAddress = AURA_LOCKER_ADDRESSES[chainId];
  return path.join(VLAURA_DELEGATIONS_DIR, String(chainId), `${lockerAddress}.parquet`);
}

/**
 * Read vlAURA delegation events from Parquet file
 */
async function readVlAuraParquetFile(filePath: string): Promise<VlAuraDelegationEvent[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const hyparquet = await import("hyparquet");
    let data: VlAuraDelegationEvent[] = [];

    await hyparquet.parquetRead({
      file: await hyparquet.asyncBufferFromFile(filePath),
      rowFormat: "object",
      onComplete: (result: VlAuraDelegationEvent[]) => {
        data = result;
      },
    });

    return data;
  } catch (error) {
    console.error(`Error reading vlAURA Parquet file ${filePath}:`, error);
    return [];
  }
}

/**
 * Store vlAURA delegation events to Parquet file
 */
async function storeVlAuraDelegatorsAsParquet(
  chainId: number,
  events: VlAuraDelegationEvent[]
): Promise<void> {
  const filePath = getVlAuraDelegationsFilePath(chainId);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  const schema = new parquet.ParquetSchema({
    event: { type: "UTF8" },
    delegator: { type: "UTF8" },
    toDelegate: { type: "UTF8" },
    timestamp: { type: "INT64" },
    blockNumber: { type: "INT64" },
  });

  const writer = await parquet.ParquetWriter.openFile(schema, filePath);
  for (const event of events) {
    await writer.appendRow({
      event: event.event,
      delegator: event.delegator,
      toDelegate: event.toDelegate,
      timestamp: event.timestamp,
      blockNumber: event.blockNumber,
    });
  }
  await writer.close();

  console.log(`Stored ${events.length} vlAURA delegation events for chain ${chainId} in ${filePath}`);
}

/**
 * Get the latest processed block from the Parquet file
 */
async function getLatestProcessedBlock(chainId: number): Promise<number> {
  const filePath = getVlAuraDelegationsFilePath(chainId);

  if (!fs.existsSync(filePath)) {
    return 0;
  }

  try {
    const events = await readVlAuraParquetFile(filePath);
    if (events.length === 0) return 0;

    // Find EndBlock marker or last event's block
    // Note: blockNumber might be BigInt from Parquet
    const endBlockEvent = events.find((e) => e.event === "EndBlock");
    if (endBlockEvent) {
      return Number(endBlockEvent.blockNumber);
    }

    // Fallback to last event's block
    return Number(events[events.length - 1].blockNumber);
  } catch (error) {
    console.error(`Error getting latest processed block for chain ${chainId}:`, error);
    return 0;
  }
}

/**
 * Fetch DelegateChanged events from AuraLocker contract
 */
async function fetchDelegateChangedEvents(
  chainId: number,
  fromBlock: bigint,
  toBlock: bigint
): Promise<VlAuraDelegationEvent[]> {
  const chain = chainId === 1 ? mainnet : base;
  const rpcUrl =
    chainId === 1
      ? "https://lb.drpc.org/ogrpc?network=ethereum&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9"
      : "https://lb.drpc.org/ogrpc?network=base&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9";

  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  const lockerAddress = AURA_LOCKER_ADDRESSES[chainId] as Address;
  const events: VlAuraDelegationEvent[] = [];

  const BATCH_SIZE = chainId === 1 ? 50000n : 25000n;
  let currentFrom = fromBlock;
  let batchCount = 0;

  console.log(`[Chain ${chainId}] Fetching DelegateChanged events from block ${fromBlock} to ${toBlock}...`);

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

      // Get block timestamps for the logs
      const blockTimestamps = new Map<bigint, number>();
      const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))];

      for (const blockNum of uniqueBlocks) {
        const block = await client.getBlock({ blockNumber: blockNum });
        blockTimestamps.set(blockNum, Number(block.timestamp));
      }

      for (const log of logs) {
        events.push({
          event: "DelegateChanged",
          delegator: (log.args as any).delegator.toLowerCase(),
          toDelegate: (log.args as any).toDelegate.toLowerCase(),
          timestamp: blockTimestamps.get(log.blockNumber) || 0,
          blockNumber: Number(log.blockNumber),
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

        const blockTimestamps = new Map<bigint, number>();
        const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))];

        for (const blockNum of uniqueBlocks) {
          const block = await client.getBlock({ blockNumber: blockNum });
          blockTimestamps.set(blockNum, Number(block.timestamp));
        }

        for (const log of logs) {
          events.push({
            event: "DelegateChanged",
            delegator: (log.args as any).delegator.toLowerCase(),
            toDelegate: (log.args as any).toDelegate.toLowerCase(),
            timestamp: blockTimestamps.get(log.blockNumber) || 0,
            blockNumber: Number(log.blockNumber),
          });
        }

        currentFrom = smallerTo + 1n;
      } else if (error.status === 500 || error.message?.includes("Temporary internal error")) {
        // Transient RPC error - retry with backoff
        console.log(`[Chain ${chainId}] Transient RPC error, retrying in 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
        // Don't increment currentFrom, will retry same batch
      } else {
        throw error;
      }
    }
  }

  console.log(`[Chain ${chainId}] Found ${events.length} total DelegateChanged events`);
  return events;
}

/**
 * Index all vlAURA delegators for a chain
 * Incrementally fetches new events and stores in Parquet
 */
export async function indexVlAuraDelegators(chainId: number): Promise<void> {
  const chain = chainId === 1 ? mainnet : base;
  const rpcUrl =
    chainId === 1
      ? "https://lb.drpc.org/ogrpc?network=ethereum&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9"
      : "https://lb.drpc.org/ogrpc?network=base&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9";

  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  const endBlock = Number(await client.getBlockNumber());
  const latestProcessed = await getLatestProcessedBlock(chainId);
  const startBlock = Math.max(Number(AURA_LOCKER_CREATION_BLOCKS[chainId] || 0), latestProcessed + 1);

  console.log(`[Chain ${chainId}] Indexing from block ${startBlock} to ${endBlock}`);

  if (startBlock >= endBlock) {
    console.log(`[Chain ${chainId}] Already up to date`);
    return;
  }

  // Read existing events
  const existingEvents = await readVlAuraParquetFile(getVlAuraDelegationsFilePath(chainId));

  // Filter out EndBlock marker
  const filteredExisting = existingEvents.filter((e) => e.event !== "EndBlock");

  // Fetch new events
  const newEvents = await fetchDelegateChangedEvents(chainId, BigInt(startBlock), BigInt(endBlock));

  // Merge and sort
  // Note: blockNumber might be BigInt from Parquet reads
  const allEvents = [...filteredExisting, ...newEvents];
  allEvents.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

  // Add EndBlock marker
  allEvents.push({
    event: "EndBlock",
    delegator: "",
    toDelegate: "",
    timestamp: 0,
    blockNumber: endBlock,
  });

  // Store
  await storeVlAuraDelegatorsAsParquet(chainId, allEvents);
}

/**
 * Get vlAURA delegators for a specific delegate address at a snapshot block
 *
 * @param chainId - Chain ID (1 for ETH, 8453 for Base)
 * @param targetDelegate - The delegate address to filter for (e.g., StakeDAO)
 * @param atBlock - The block number to query at
 * @returns Array of delegator addresses
 */
export async function processVlAuraDelegators(
  chainId: number,
  targetDelegate: string,
  atBlock: number
): Promise<string[]> {
  const filePath = getVlAuraDelegationsFilePath(chainId);

  if (!fs.existsSync(filePath)) {
    throw new Error(`No vlAURA delegation cache found for chain ${chainId}. Run the indexer first.`);
  }

  const events = await readVlAuraParquetFile(filePath);
  const normalizedTarget = targetDelegate.toLowerCase();

  // Filter events up to target block
  // Note: blockNumber might be BigInt from Parquet, so use Number() for comparison
  const relevantEvents = events
    .filter((e) => e.event === "DelegateChanged" && Number(e.blockNumber) <= atBlock)
    .sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

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

/**
 * Get the EndBlock marker from the Parquet file
 * Returns 0 if not found
 */
export async function getVlAuraCacheEndBlock(chainId: number): Promise<number> {
  return getLatestProcessedBlock(chainId);
}

/**
 * Check if the cache is fresh enough for a given block
 */
export async function isVlAuraCacheFresh(chainId: number, requiredBlock: number): Promise<boolean> {
  const cacheEndBlock = await getVlAuraCacheEndBlock(chainId);
  return cacheEndBlock >= requiredBlock;
}
