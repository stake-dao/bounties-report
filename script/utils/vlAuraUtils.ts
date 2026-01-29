/**
 * vlAURA on-chain delegation utilities
 * - Query delegators from GraphQL API (OnChainDelegation entity)
 * - Fetch vlAURA balances on-chain via AuraLocker contracts
 */

import axios from "axios";
import type { Address } from "viem";
import { getClient } from "./getClients";
import { DELEGATION_ADDRESS } from "./constants";

// ============================================================================
// Constants
// ============================================================================

const GRAPHQL_ENDPOINT = process.env.VLAURA_GRAPHQL_ENDPOINT || "https://api-snapshot.stakedao.org/v1/graphql";

// AuraLocker contract addresses (vlAURA)
export const AURA_LOCKER_ADDRESSES: Record<number, Address> = {
  1: "0x3Fa73f1E5d8A792C80F426fc8F84FBF7Ce9bBCAC",    // Ethereum
  8453: "0x9e1f4190f1a8Fe0cD57421533deCB57F9980922e", // Base
};

// StakeDAO delegation address (same as vlCVX)
export const STAKE_DAO_VOTER = DELEGATION_ADDRESS.toLowerCase();

// Supported chain IDs for vlAURA
export const VLAURA_CHAIN_IDS = [1, 8453] as const;

// ============================================================================
// ABI (minimal for balance queries)
// ============================================================================

const AURA_LOCKER_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "delegates",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ============================================================================
// Types
// ============================================================================

export interface OnChainDelegation {
  id: string;
  chainId: number;
  protocol: string;
  delegator: string;
  delegate: string;
  lastUpdatedBlock: string;
  lastUpdatedTimestamp: string;
}

export interface OnChainDelegationEvent {
  id: string;
  chainId: number;
  protocol: string;
  delegator: string;
  fromDelegate: string;
  toDelegate: string;
  block: string;
  timestamp: string;
}

interface GraphQLResponse<T> {
  data: T;
}

interface OnChainDelegationResponse {
  OnChainDelegation: OnChainDelegation[];
}

interface OnChainDelegationEventResponse {
  OnChainDelegationEvent: OnChainDelegationEvent[];
}

export interface DelegatorBalance {
  address: Address;
  chainId: number;
  balance: bigint;
}

export interface AggregatedDelegator {
  address: Address;
  balances: Record<number, bigint>; // chainId -> balance
  totalBalance: bigint;
}

// ============================================================================
// GraphQL Queries
// ============================================================================

/**
 * Fetch current on-chain delegations for a delegate address
 * @param delegate - Delegate address to filter by (defaults to StakeDAO)
 * @param chainId - Optional chain ID filter
 * @returns Array of OnChainDelegation objects
 */
export async function fetchOnChainDelegations(
  delegate: string = STAKE_DAO_VOTER,
  chainId?: number
): Promise<OnChainDelegation[]> {
  const whereClause = chainId
    ? `{ delegate: { _eq: "${delegate.toLowerCase()}" }, protocol: { _eq: "aura" }, chainId: { _eq: ${chainId} } }`
    : `{ delegate: { _eq: "${delegate.toLowerCase()}" }, protocol: { _eq: "aura" } }`;

  const query = `
    query GetOnChainDelegations {
      OnChainDelegation(
        where: ${whereClause}
        order_by: { lastUpdatedTimestamp: desc }
      ) {
        id
        chainId
        protocol
        delegator
        delegate
        lastUpdatedBlock
        lastUpdatedTimestamp
      }
    }
  `;

  try {
    const response = await axios.post<GraphQLResponse<OnChainDelegationResponse>>(
      GRAPHQL_ENDPOINT,
      { query },
      {
        timeout: 30000,
        headers: { "Content-Type": "application/json" },
      }
    );

    if (!response.data?.data?.OnChainDelegation) {
      console.warn("No OnChainDelegation data in response");
      return [];
    }

    return response.data.data.OnChainDelegation;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error("GraphQL request failed:", error.message);
      if (error.response) {
        console.error("Status:", error.response.status);
        console.error("Response:", error.response.data);
      }
    }
    throw error;
  }
}

/**
 * Fetch delegation events (historical) filtered by delegate and optional timestamp
 * @param delegate - Delegate address to filter by
 * @param beforeTimestamp - Optional timestamp to filter events before
 * @param chainId - Optional chain ID filter
 * @returns Array of OnChainDelegationEvent objects
 */
export async function fetchOnChainDelegationEvents(
  delegate: string = STAKE_DAO_VOTER,
  beforeTimestamp?: number,
  chainId?: number
): Promise<OnChainDelegationEvent[]> {
  const conditions = [
    `toDelegate: { _eq: "${delegate.toLowerCase()}" }`,
    `protocol: { _eq: "aura" }`,
  ];

  if (chainId) {
    conditions.push(`chainId: { _eq: ${chainId} }`);
  }

  if (beforeTimestamp) {
    conditions.push(`timestamp: { _lte: "${beforeTimestamp}" }`);
  }

  const query = `
    query GetOnChainDelegationEvents {
      OnChainDelegationEvent(
        where: { ${conditions.join(", ")} }
        order_by: { timestamp: desc }
      ) {
        id
        chainId
        protocol
        delegator
        fromDelegate
        toDelegate
        block
        timestamp
      }
    }
  `;

  try {
    const response = await axios.post<GraphQLResponse<OnChainDelegationEventResponse>>(
      GRAPHQL_ENDPOINT,
      { query },
      {
        timeout: 30000,
        headers: { "Content-Type": "application/json" },
      }
    );

    if (!response.data?.data?.OnChainDelegationEvent) {
      console.warn("No OnChainDelegationEvent data in response");
      return [];
    }

    return response.data.data.OnChainDelegationEvent;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error("GraphQL request failed:", error.message);
    }
    throw error;
  }
}

/**
 * Get list of delegator addresses currently delegating to StakeDAO
 * @param chainId - Optional chain ID filter
 * @returns Array of delegator addresses (lowercase)
 * @deprecated Use getVlAuraDelegatorsAtTimestamp for accurate historical queries
 */
export async function getVlAuraDelegators(chainId?: number): Promise<string[]> {
  const delegations = await fetchOnChainDelegations(STAKE_DAO_VOTER, chainId);
  return delegations.map((d) => d.delegator.toLowerCase());
}

/**
 * Get list of delegator addresses who were delegating to StakeDAO at a specific timestamp.
 * Reconstructs delegation state by replaying events up to the given timestamp.
 * This mirrors vlCVX's processAllDelegators behavior.
 *
 * @param beforeTimestamp - Unix timestamp to get delegators at (e.g., proposal.start)
 * @param chainId - Optional chain ID filter
 * @returns Array of delegator addresses (lowercase) who were delegating at that time
 */
export async function getVlAuraDelegatorsAtTimestamp(
  beforeTimestamp: number,
  chainId?: number
): Promise<string[]> {
  // Get all delegation events TO StakeDAO before the timestamp
  const delegationEvents = await fetchOnChainDelegationEvents(
    STAKE_DAO_VOTER,
    beforeTimestamp,
    chainId
  );

  // Also get un-delegation events FROM StakeDAO before the timestamp
  // (delegators who stopped delegating to StakeDAO)
  const undelegationEvents = await fetchUndelegationEvents(
    STAKE_DAO_VOTER,
    beforeTimestamp,
    chainId
  );

  // Build a map of delegator -> their latest event timestamp and type
  const delegatorState = new Map<string, { timestamp: string; isDelegating: boolean }>();

  // Process delegation events (delegating TO StakeDAO)
  for (const event of delegationEvents) {
    const delegator = event.delegator.toLowerCase();
    const existing = delegatorState.get(delegator);

    if (!existing || BigInt(event.timestamp) > BigInt(existing.timestamp)) {
      delegatorState.set(delegator, {
        timestamp: event.timestamp,
        isDelegating: true,
      });
    }
  }

  // Process un-delegation events (stopped delegating to StakeDAO)
  for (const event of undelegationEvents) {
    const delegator = event.delegator.toLowerCase();
    const existing = delegatorState.get(delegator);

    if (!existing || BigInt(event.timestamp) > BigInt(existing.timestamp)) {
      delegatorState.set(delegator, {
        timestamp: event.timestamp,
        isDelegating: false,
      });
    }
  }

  // Return only delegators whose latest event shows they're still delegating
  const activeDelegators: string[] = [];
  for (const [delegator, state] of delegatorState) {
    if (state.isDelegating) {
      activeDelegators.push(delegator);
    }
  }

  console.log(`Found ${activeDelegators.length} delegators at timestamp ${beforeTimestamp}`);
  return activeDelegators;
}

/**
 * Fetch un-delegation events (when someone stops delegating to a delegate)
 * @param delegate - The delegate address they stopped delegating to
 * @param beforeTimestamp - Optional timestamp filter
 * @param chainId - Optional chain ID filter
 */
async function fetchUndelegationEvents(
  delegate: string,
  beforeTimestamp?: number,
  chainId?: number
): Promise<OnChainDelegationEvent[]> {
  const conditions = [
    `fromDelegate: { _eq: "${delegate.toLowerCase()}" }`,
    `protocol: { _eq: "aura" }`,
  ];

  if (chainId) {
    conditions.push(`chainId: { _eq: ${chainId} }`);
  }

  if (beforeTimestamp) {
    conditions.push(`timestamp: { _lte: "${beforeTimestamp}" }`);
  }

  const query = `
    query GetUndelegationEvents {
      OnChainDelegationEvent(
        where: { ${conditions.join(", ")} }
        order_by: { timestamp: desc }
      ) {
        id
        chainId
        protocol
        delegator
        fromDelegate
        toDelegate
        block
        timestamp
      }
    }
  `;

  try {
    const response = await axios.post<GraphQLResponse<OnChainDelegationEventResponse>>(
      GRAPHQL_ENDPOINT,
      { query },
      {
        timeout: 30000,
        headers: { "Content-Type": "application/json" },
      }
    );

    if (!response.data?.data?.OnChainDelegationEvent) {
      return [];
    }

    return response.data.data.OnChainDelegationEvent;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error("GraphQL request failed:", error.message);
    }
    throw error;
  }
}

/**
 * Get delegators grouped by chain
 * @returns Map of chainId to delegator addresses
 */
export async function getVlAuraDelegatorsByChain(): Promise<Map<number, string[]>> {
  const delegations = await fetchOnChainDelegations(STAKE_DAO_VOTER);
  
  const byChain = new Map<number, string[]>();
  for (const d of delegations) {
    const chainDelegators = byChain.get(d.chainId) || [];
    chainDelegators.push(d.delegator.toLowerCase());
    byChain.set(d.chainId, chainDelegators);
  }
  
  return byChain;
}

// ============================================================================
// On-Chain Balance Queries
// ============================================================================

/**
 * Get vlAURA balance for an address at a specific block
 * @param chainId - Chain ID (1 for Ethereum, 8453 for Base)
 * @param address - Address to query balance for
 * @param blockNumber - Block number to query at
 * @returns Balance as bigint
 */
export async function getVlAuraBalanceAt(
  chainId: number,
  address: Address,
  blockNumber: bigint
): Promise<bigint> {
  const client = await getClient(chainId);
  const lockerAddress = AURA_LOCKER_ADDRESSES[chainId];

  if (!lockerAddress) {
    throw new Error(`No AuraLocker address for chain ${chainId}`);
  }

  const balance = await client.readContract({
    address: lockerAddress,
    abi: AURA_LOCKER_ABI,
    functionName: "balanceOf",
    args: [address],
    blockNumber,
  });

  return balance;
}

/**
 * Get current vlAURA balance for an address
 * @param chainId - Chain ID
 * @param address - Address to query
 * @returns Balance as bigint
 */
export async function getVlAuraBalance(
  chainId: number,
  address: Address
): Promise<bigint> {
  const client = await getClient(chainId);
  const lockerAddress = AURA_LOCKER_ADDRESSES[chainId];

  if (!lockerAddress) {
    throw new Error(`No AuraLocker address for chain ${chainId}`);
  }

  const balance = await client.readContract({
    address: lockerAddress,
    abi: AURA_LOCKER_ABI,
    functionName: "balanceOf",
    args: [address],
  });

  return balance;
}

/**
 * Get delegate for an address at a specific block
 * @param chainId - Chain ID
 * @param address - Address to query delegate for
 * @param blockNumber - Block number to query at
 * @returns Delegate address
 */
export async function getVlAuraDelegateAt(
  chainId: number,
  address: Address,
  blockNumber: bigint
): Promise<Address> {
  const client = await getClient(chainId);
  const lockerAddress = AURA_LOCKER_ADDRESSES[chainId];

  if (!lockerAddress) {
    throw new Error(`No AuraLocker address for chain ${chainId}`);
  }

  const delegate = await client.readContract({
    address: lockerAddress,
    abi: AURA_LOCKER_ABI,
    functionName: "delegates",
    args: [address],
    blockNumber,
  });

  return delegate;
}

/**
 * Batch get balances for multiple addresses on a single chain
 * @param chainId - Chain ID
 * @param addresses - List of addresses to query
 * @param blockNumber - Optional block number (defaults to latest)
 * @returns Map of address to balance
 */
export async function getBatchVlAuraBalances(
  chainId: number,
  addresses: Address[],
  blockNumber?: bigint
): Promise<Map<Address, bigint>> {
  const client = await getClient(chainId);
  const lockerAddress = AURA_LOCKER_ADDRESSES[chainId];

  if (!lockerAddress) {
    throw new Error(`No AuraLocker address for chain ${chainId}`);
  }

  const contracts = addresses.map((address) => ({
    address: lockerAddress,
    abi: AURA_LOCKER_ABI,
    functionName: "balanceOf" as const,
    args: [address] as const,
  }));

  const results = await client.multicall({
    contracts,
    blockNumber,
  });

  const balanceMap = new Map<Address, bigint>();
  addresses.forEach((address, index) => {
    const result = results[index];
    if (result.status === "success") {
      balanceMap.set(address, result.result as bigint);
    } else {
      balanceMap.set(address, BigInt(0));
    }
  });

  return balanceMap;
}

/**
 * Get aggregated vlAURA balance across multiple chains
 * @param address - Address to query balance for
 * @param blocks - Map of chainId to blockNumber
 * @returns Total balance across all chains
 */
export async function getAggregatedVlAuraBalance(
  address: Address,
  blocks: Record<number, bigint>
): Promise<bigint> {
  const balancePromises = Object.entries(blocks).map(async ([chainIdStr, blockNumber]) => {
    const chainId = Number.parseInt(chainIdStr, 10);
    try {
      return await getVlAuraBalanceAt(chainId, address, blockNumber);
    } catch (error) {
      console.warn(`Failed to get balance on chain ${chainId}:`, error);
      return BigInt(0);
    }
  });

  const balances = await Promise.all(balancePromises);
  return balances.reduce((sum, balance) => sum + balance, BigInt(0));
}

// ============================================================================
// Combined Queries (GraphQL + On-Chain)
// ============================================================================

/**
 * Get all delegators with their vlAURA balances at specific blocks
 * @param blocks - Map of chainId to blockNumber
 * @returns Array of aggregated delegator data
 */
export async function getDelegatorsWithBalances(
  blocks: Record<number, bigint>
): Promise<AggregatedDelegator[]> {
  // Get delegators from GraphQL
  const delegatorsByChain = await getVlAuraDelegatorsByChain();
  
  // Collect unique delegators
  const allDelegators = new Set<string>();
  for (const delegators of delegatorsByChain.values()) {
    for (const d of delegators) {
      allDelegators.add(d);
    }
  }

  // Fetch balances for each chain
  const chainBalances = new Map<number, Map<Address, bigint>>();
  
  for (const [chainIdStr, blockNumber] of Object.entries(blocks)) {
    const chainId = Number.parseInt(chainIdStr, 10);
    const delegatorsOnChain = delegatorsByChain.get(chainId) || [];
    
    if (delegatorsOnChain.length === 0) continue;
    
    const balances = await getBatchVlAuraBalances(
      chainId,
      delegatorsOnChain as Address[],
      blockNumber
    );
    chainBalances.set(chainId, balances);
  }

  // Aggregate results
  const results: AggregatedDelegator[] = [];
  
  for (const delegator of allDelegators) {
    const balances: Record<number, bigint> = {};
    let totalBalance = BigInt(0);
    
    for (const [chainId, balanceMap] of chainBalances) {
      const balance = balanceMap.get(delegator as Address) || BigInt(0);
      if (balance > BigInt(0)) {
        balances[chainId] = balance;
        totalBalance += balance;
      }
    }
    
    if (totalBalance > BigInt(0)) {
      results.push({
        address: delegator as Address,
        balances,
        totalBalance,
      });
    }
  }

  // Sort by total balance descending
  results.sort((a, b) => (b.totalBalance > a.totalBalance ? 1 : -1));
  
  return results;
}

/**
 * Get total vlAURA delegated to StakeDAO across all chains
 * @param blocks - Map of chainId to blockNumber
 * @returns Total delegated vlAURA
 */
export async function getTotalDelegatedVlAura(
  blocks: Record<number, bigint>
): Promise<bigint> {
  const delegators = await getDelegatorsWithBalances(blocks);
  return delegators.reduce((sum, d) => sum + d.totalBalance, BigInt(0));
}

/**
 * Verify on-chain delegation matches indexed data
 * @param chainId - Chain ID to verify
 * @param blockNumber - Block to verify at
 * @returns Object with verification results
 */
export async function verifyDelegations(
  chainId: number,
  blockNumber: bigint
): Promise<{
  matched: number;
  mismatched: string[];
  total: number;
}> {
  const delegations = await fetchOnChainDelegations(STAKE_DAO_VOTER, chainId);
  
  let matched = 0;
  const mismatched: string[] = [];
  
  for (const delegation of delegations) {
    try {
      const onChainDelegate = await getVlAuraDelegateAt(
        chainId,
        delegation.delegator as Address,
        blockNumber
      );
      
      if (onChainDelegate.toLowerCase() === STAKE_DAO_VOTER) {
        matched++;
      } else {
        mismatched.push(delegation.delegator);
      }
    } catch (error) {
      console.warn(`Failed to verify ${delegation.delegator}:`, error);
      mismatched.push(delegation.delegator);
    }
  }
  
  return {
    matched,
    mismatched,
    total: delegations.length,
  };
}

// ============================================================================
// Block Utilities
// ============================================================================

/**
 * Get block number closest to a given timestamp using binary search
 * @param chainId - Chain ID
 * @param targetTimestamp - Unix timestamp to find block for
 * @returns Block number closest to the timestamp
 */
export async function getBlockAtTimestamp(
  chainId: number,
  targetTimestamp: bigint
): Promise<bigint> {
  const client = await getClient(chainId);
  
  // Get current block as upper bound
  const latestBlock = await client.getBlock({ blockTag: "latest" });
  let high = latestBlock.number;
  let low = BigInt(1);
  
  // Binary search for the block
  while (low < high) {
    const mid = (low + high) / BigInt(2);
    const block = await client.getBlock({ blockNumber: mid });
    
    if (block.timestamp < targetTimestamp) {
      low = mid + BigInt(1);
    } else {
      high = mid;
    }
  }
  
  // Verify and return the closest block
  const resultBlock = await client.getBlock({ blockNumber: low });
  
  // Check if previous block is closer
  if (low > BigInt(1)) {
    const prevBlock = await client.getBlock({ blockNumber: low - BigInt(1) });
    const diffCurrent = resultBlock.timestamp >= targetTimestamp 
      ? resultBlock.timestamp - targetTimestamp 
      : targetTimestamp - resultBlock.timestamp;
    const diffPrev = targetTimestamp >= prevBlock.timestamp
      ? targetTimestamp - prevBlock.timestamp
      : prevBlock.timestamp - targetTimestamp;
    
    if (diffPrev < diffCurrent) {
      return low - BigInt(1);
    }
  }
  
  return low;
}

/**
 * Get snapshot blocks for all vlAURA chains based on ETH block
 * @param ethBlockNumber - Ethereum block number (from proposal.snapshot)
 * @returns Record of chainId to block number
 */
export async function getSnapshotBlocks(
  ethBlockNumber: bigint
): Promise<Record<number, bigint>> {
  const ethClient = await getClient(1);
  const ethBlock = await ethClient.getBlock({ blockNumber: ethBlockNumber });
  const snapshotTimestamp = ethBlock.timestamp;
  
  console.log(`ETH snapshot block ${ethBlockNumber} at timestamp ${snapshotTimestamp}`);
  
  // Get corresponding Base block
  const baseBlock = await getBlockAtTimestamp(8453, snapshotTimestamp);
  const baseBlockData = await (await getClient(8453)).getBlock({ blockNumber: baseBlock });
  
  console.log(`Base snapshot block ${baseBlock} at timestamp ${baseBlockData.timestamp} (diff: ${baseBlockData.timestamp - snapshotTimestamp}s)`);
  
  return {
    1: ethBlockNumber,
    8453: baseBlock,
  };
}

// ============================================================================
// Formatting Helpers
// ============================================================================

/**
 * Format vlAURA balance for display (18 decimals)
 * @param balance - Raw balance as bigint
 * @returns Formatted string with 2 decimal places
 */
export function formatVlAuraBalance(balance: bigint): string {
  const divisor = BigInt(10 ** 18);
  const whole = balance / divisor;
  const fraction = (balance % divisor) / BigInt(10 ** 16); // 2 decimal places
  return `${whole.toLocaleString()}.${fraction.toString().padStart(2, "0")}`;
}
