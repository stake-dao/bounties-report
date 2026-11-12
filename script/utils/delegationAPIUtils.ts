import axios from "axios";
import { DelegationEventAPI, DelegationAPIResponse, DelegatorData } from "./types";
import { DELEGATION_ADDRESS, getClient } from "./constants";
import { processAllDelegators } from "./cacheUtils";

// StakeDAO Snapshot GraphQL API endpoint
const GRAPHQL_ENDPOINT = "https://snapshot-indexer.contact-69d.workers.dev/v1/graphql";

// Cache for API response (avoid multiple fetches in same session)
let cachedAPIResponse: DelegationAPIResponse | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

// A quiet event history is valid; the indexer's processed-block watermark,
// not its last delegation event, must cover the requested finalized state.
async function assertGraphQLCoverage(
  data: DelegationAPIResponse,
  timestamp: number
): Promise<void> {
  const indexed = Number(data.chain_metadata?.find((row) => row.chain_id === 1)?.latest_processed_block);
  if (!Number.isSafeInteger(indexed) || indexed <= 0) {
    throw new Error("GraphQL delegation indexer has no valid Ethereum metadata watermark");
  }
  const client = await getClient(1);
  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (BigInt(indexed) >= finalized.number) return;

  const indexedBlock = await client.getBlock({ blockNumber: BigInt(indexed) });
  const requiredTimestamp = Math.min(timestamp, Number(finalized.timestamp));
  if (Number(indexedBlock.timestamp) < requiredTimestamp) {
    throw new Error(
      `GraphQL delegation indexer is behind: processed block ${indexed} ` +
      `(timestamp ${indexedBlock.timestamp}) does not cover requested timestamp ${timestamp}. ` +
      `Restore indexer synchronization before using it to verify or replace the parquet cache.`
    );
  }
}

/**
 * Fetch ALL delegation events from GraphQL API (cached)
 * The API returns all events for all spaces, we filter locally
 * @returns Array of all DelegationEventAPI objects
 */
export const fetchAllDelegationEventsFromGraphQL = async (
  currentPeriodTimestamp: number
): Promise<DelegationEventAPI[]> => {
  // Return cached if valid
  const now = Date.now();
  if (cachedAPIResponse && (now - cacheTimestamp) < CACHE_TTL_MS) {
    console.log("Using cached GraphQL response");
    await assertGraphQLCoverage(cachedAPIResponse, currentPeriodTimestamp);
    return cachedAPIResponse.DelegationEvent;
  }

  const query = `
    query GetAllDelegationEvents {
      DelegationEvent(order_by: { timestamp: desc }) {
        id
        space
        delegator
        delegate
        event
        timestamp
        block
      }
      chain_metadata(where: { chain_id: { _eq: 1 } }) {
        chain_id
        latest_processed_block
      }
    }
  `;

  try {
    console.log("Fetching all delegation events from GraphQL...");
    const response = await axios.post<{ data: DelegationAPIResponse }>(
      GRAPHQL_ENDPOINT,
      { query },
      {
        timeout: 60000, // 60 second timeout (large response)
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!Array.isArray(response.data?.data?.DelegationEvent)) {
      throw new Error("No DelegationEvent array in GraphQL response");
    }

    await assertGraphQLCoverage(response.data.data, currentPeriodTimestamp);
    // Only cache responses whose coverage was checked successfully.
    cachedAPIResponse = response.data.data;
    cacheTimestamp = now;
    
    console.log(`Fetched ${cachedAPIResponse.DelegationEvent.length} total delegation events from GraphQL`);
    return cachedAPIResponse.DelegationEvent;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error("GraphQL request failed:", error.message);
      if (error.response) {
        console.error(`Status: ${error.response.status}`);
        console.error(`Response:`, error.response.data);
      }
    } else {
      console.error("Unexpected error fetching from GraphQL:", error);
    }
    throw error;
  }
};

/**
 * Clear the API cache (useful for testing or forced refresh)
 */
export const clearAPICache = (): void => {
  cachedAPIResponse = null;
  cacheTimestamp = 0;
};

/**
 * Fetch delegation events filtered by space and optionally by delegate
 * @param space - Space ID (e.g., "cvx.eth")
 * @param delegateAddress - The delegate address to filter by (optional)
 * @returns Array of filtered DelegationEventAPI objects
 */
export const fetchDelegationEventsFromGraphQL = async (
  space: string,
  currentPeriodTimestamp: number,
  delegateAddress?: string
): Promise<DelegationEventAPI[]> => {
  const allEvents = await fetchAllDelegationEventsFromGraphQL(currentPeriodTimestamp);
  
  // Filter by space
  let filtered = allEvents.filter(
    (e) => e.space.toLowerCase() === space.toLowerCase()
  );
  
  // Optionally filter by delegate address
  if (delegateAddress) {
    filtered = filtered.filter(
      (e) => e.delegate.toLowerCase() === delegateAddress.toLowerCase()
    );
  }
  
  console.log(`Filtered to ${filtered.length} events for space=${space}${delegateAddress ? `, delegate=${delegateAddress}` : ""}`);
  return filtered;
};

/**
 * Convert API events to the same format as parquet DelegatorData
 * @param events - Array of API delegation events
 * @returns Array of DelegatorData objects
 */
export const convertAPIEventsToDelegatorData = (
  events: DelegationEventAPI[]
): DelegatorData[] => {
  return events.map((event) => ({
    event: event.event,
    user: event.delegator.toLowerCase(),
    // API returns space as string (e.g., "cvx.eth"), not bytes32
    // We keep it as-is for comparison since we'll compare by space string
    spaceId: event.space.toLowerCase(),
    timestamp: parseInt(event.timestamp, 10),
    blockNumber: parseInt(event.block, 10),
  }));
};

/**
 * Process API delegation events to get active delegators at a specific timestamp
 * @param events - Array of API delegation events
 * @param currentPeriodTimestamp - Filter events up to this timestamp
 * @param space - Space to filter by (e.g., "cvx.eth")
 * @returns Array of active delegator addresses
 */
export const processGraphQLDelegators = (
  events: DelegationEventAPI[],
  currentPeriodTimestamp: number,
  space: string
): string[] => {
  // Filter by space and timestamp
  const filteredEvents = events.filter(
    (e) =>
      e.space.toLowerCase() === space.toLowerCase() &&
      parseInt(e.timestamp, 10) <= currentPeriodTimestamp
  );

  // Sort by timestamp (ascending) to process in order
  filteredEvents.sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp));

  // Track latest event per delegator
  const userLatestEvent: Record<string, "Set" | "Clear"> = {};

  for (const event of filteredEvents) {
    const delegator = event.delegator.toLowerCase();
    userLatestEvent[delegator] = event.event;
  }

  // Return delegators whose latest event is "Set" (active delegation)
  return Object.entries(userLatestEvent)
    .filter(([_, event]) => event === "Set")
    .map(([delegator]) => delegator);
};

export interface VerificationResult {
  isValid: boolean;
  parquetCount: number;
  apiCount: number;
  inParquetNotAPI: string[];
  inAPINotParquet: string[];
  matchRate: number;
}

/**
 * Verify delegators from parquet cache against GraphQL API for a single space
 * @param space - Space ID (e.g., "cvx.eth")
 * @param currentPeriodTimestamp - Timestamp to filter delegators
 * @param delegationAddress - Delegation address (defaults to DELEGATION_ADDRESS)
 * @returns Verification result with discrepancies
 */
export const verifyDelegators = async (
  space: string,
  currentPeriodTimestamp: number,
  delegationAddress: string = DELEGATION_ADDRESS
): Promise<VerificationResult> => {
  console.log(`\n=== Verifying delegators for ${space} ===`);
  console.log(`Timestamp: ${currentPeriodTimestamp} (${new Date(currentPeriodTimestamp * 1000).toISOString()})`);

  // 1. Get delegators from parquet
  console.log("Fetching delegators from parquet cache...");
  const parquetDelegators = await processAllDelegators(
    space,
    currentPeriodTimestamp,
    delegationAddress
  );
  console.log(`Parquet delegators: ${parquetDelegators.length}`);

  // 2. Get delegators from GraphQL API
  console.log("Fetching delegators from GraphQL API...");
  const apiEvents = await fetchDelegationEventsFromGraphQL(space, currentPeriodTimestamp, delegationAddress);
  const apiDelegators = processGraphQLDelegators(apiEvents, currentPeriodTimestamp, space);
  console.log(`GraphQL delegators: ${apiDelegators.length}`);

  // 3. Compare
  const parquetSet = new Set(parquetDelegators.map((d) => d.toLowerCase()));
  const apiSet = new Set(apiDelegators.map((d) => d.toLowerCase()));

  const inParquetNotAPI = [...parquetSet].filter((d) => !apiSet.has(d));
  const inAPINotParquet = [...apiSet].filter((d) => !parquetSet.has(d));

  const totalUnique = new Set([...parquetSet, ...apiSet]).size;
  const matching = totalUnique - inParquetNotAPI.length - inAPINotParquet.length;
  const matchRate = totalUnique > 0 ? (matching / totalUnique) * 100 : 100;

  const result: VerificationResult = {
    isValid: inParquetNotAPI.length === 0 && inAPINotParquet.length === 0,
    parquetCount: parquetDelegators.length,
    apiCount: apiDelegators.length,
    inParquetNotAPI,
    inAPINotParquet,
    matchRate,
  };

  // 4. Log results
  console.log(`\n=== Verification Results ===`);
  console.log(`Match rate: ${matchRate.toFixed(2)}%`);
  console.log(`Valid: ${result.isValid}`);

  if (inParquetNotAPI.length > 0) {
    console.log(`\nIn Parquet but NOT in GraphQL (${inParquetNotAPI.length}):`);
    inParquetNotAPI.slice(0, 10).forEach((addr) => console.log(`  - ${addr}`));
    if (inParquetNotAPI.length > 10) {
      console.log(`  ... and ${inParquetNotAPI.length - 10} more`);
    }
  }

  if (inAPINotParquet.length > 0) {
    console.log(`\nIn GraphQL but NOT in Parquet (${inAPINotParquet.length}):`);
    inAPINotParquet.slice(0, 10).forEach((addr) => console.log(`  - ${addr}`));
    if (inAPINotParquet.length > 10) {
      console.log(`  ... and ${inAPINotParquet.length - 10} more`);
    }
  }

  return result;
};

/**
 * Fetch delegators with GraphQL API fallback
 * Primary: Parquet cache, Fallback: GraphQL API
 * @param space - Space ID
 * @param currentPeriodTimestamp - Timestamp to filter delegators
 * @param delegationAddress - Delegation address
 * @returns Array of delegator addresses
 */
export const fetchDelegatorsWithFallback = async (
  space: string,
  currentPeriodTimestamp: number,
  delegationAddress: string = DELEGATION_ADDRESS
): Promise<string[]> => {
  try {
    // Primary: Parquet cache
    const delegators = await processAllDelegators(
      space,
      currentPeriodTimestamp,
      delegationAddress
    );

    if (delegators.length === 0) {
      console.warn(`No delegators found in parquet for ${space}, trying GraphQL...`);
      throw new Error("Empty parquet result");
    }

    return delegators;
  } catch (parquetError) {
    console.warn(`Parquet fetch failed for ${space}:`, parquetError);

    // Fallback: GraphQL API
    console.log(`Falling back to GraphQL API for ${space}...`);
    const apiEvents = await fetchDelegationEventsFromGraphQL(space, currentPeriodTimestamp, delegationAddress);
    return processGraphQLDelegators(apiEvents, currentPeriodTimestamp, space);
  }
};

/**
 * Compare delegation events between two timestamps to find changes
 * @param space - Space ID
 * @param fromTimestamp - Start timestamp
 * @param toTimestamp - End timestamp
 * @returns Object with new delegators, removed delegators, and unchanged
 */
export const getDelegationChanges = async (
  space: string,
  fromTimestamp: number,
  toTimestamp: number,
  delegationAddress: string = DELEGATION_ADDRESS
): Promise<{
  newDelegators: string[];
  removedDelegators: string[];
  unchanged: string[];
}> => {
  const apiEvents = await fetchDelegationEventsFromGraphQL(space, toTimestamp, delegationAddress);

  const delegatorsAtFrom = processGraphQLDelegators(apiEvents, fromTimestamp, space);
  const delegatorsAtTo = processGraphQLDelegators(apiEvents, toTimestamp, space);

  const fromSet = new Set(delegatorsAtFrom.map((d) => d.toLowerCase()));
  const toSet = new Set(delegatorsAtTo.map((d) => d.toLowerCase()));

  const newDelegators = [...toSet].filter((d) => !fromSet.has(d));
  const removedDelegators = [...fromSet].filter((d) => !toSet.has(d));
  const unchanged = [...toSet].filter((d) => fromSet.has(d));

  return {
    newDelegators,
    removedDelegators,
    unchanged,
  };
};
