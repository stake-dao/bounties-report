import axios from "axios";
import { DelegationEventAPI, DelegationAPIResponse, DelegatorData } from "./types";
import { DELEGATION_ADDRESS, SPACE_TO_CHAIN_ID } from "./constants";
import { processAllDelegators } from "./cacheUtils";

// StakeDAO Snapshot GraphQL API endpoint
const GRAPHQL_ENDPOINT = "https://snapshot-indexer.contact-69d.workers.dev/v1/graphql";

// Cache for API response (avoid multiple fetches in same session)
let cachedAPIResponse: DelegationEventAPI[] | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

/**
 * Fetch ALL delegation events from GraphQL API (cached)
 * The API returns all events for all spaces, we filter locally
 * @returns Array of all DelegationEventAPI objects
 */
export const fetchAllDelegationEventsFromGraphQL = async (): Promise<DelegationEventAPI[]> => {
  // Return cached if valid
  const now = Date.now();
  if (cachedAPIResponse && (now - cacheTimestamp) < CACHE_TTL_MS) {
    console.log("Using cached GraphQL response");
    return cachedAPIResponse;
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

    if (!response.data?.data?.DelegationEvent) {
      console.warn("No DelegationEvent array in GraphQL response");
      return [];
    }

    // Cache the response
    cachedAPIResponse = response.data.data.DelegationEvent;
    cacheTimestamp = now;
    
    console.log(`Fetched ${cachedAPIResponse.length} total delegation events from GraphQL`);
    return cachedAPIResponse;
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
  delegateAddress?: string
): Promise<DelegationEventAPI[]> => {
  const allEvents = await fetchAllDelegationEventsFromGraphQL();
  
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
  const apiEvents = await fetchDelegationEventsFromGraphQL(space, delegationAddress);
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
 * Verify ALL spaces for a given chainId against GraphQL API
 * Throws an error if any space has mismatches (excluding spaces not in GraphQL API)
 * @param chainId - Chain ID (e.g., "1" for Ethereum)
 * @param delegationAddress - Delegation address to verify
 * @param currentPeriodTimestamp - Timestamp to filter delegators
 */
export const verifyAllSpacesAgainstGraphQL = async (
  chainId: string,
  delegationAddress: string,
  currentPeriodTimestamp: number
): Promise<void> => {
  // Get all spaces for this chainId
  const spacesForChain = Object.entries(SPACE_TO_CHAIN_ID)
    .filter(([_, id]) => id === chainId)
    .map(([space]) => space);

  if (spacesForChain.length === 0) {
    console.log(`No spaces configured for chainId ${chainId}, skipping verification`);
    return;
  }

  console.log(`\n=== Verifying ${spacesForChain.length} spaces for chainId ${chainId} ===`);
  console.log(`Spaces: ${spacesForChain.join(", ")}`);

  // Fetch all events from GraphQL once (will be cached for subsequent calls)
  const allEvents = await fetchAllDelegationEventsFromGraphQL();
  
  // Determine which spaces exist in the GraphQL API
  const spacesInAPI = new Set(allEvents.map((e) => e.space.toLowerCase()));
  console.log(`Spaces available in GraphQL API: ${[...spacesInAPI].sort().join(", ")}`);
  
  // Filter to events for this delegation address
  const delegateEvents = allEvents.filter(
    (e) => e.delegate.toLowerCase() === delegationAddress.toLowerCase()
  );
  console.log(`Found ${delegateEvents.length} events for delegate ${delegationAddress}`);

  let verifiedCount = 0;
  let skippedCount = 0;

  // Verify each space
  for (const space of spacesForChain) {
    console.log(`\nVerifying ${space}...`);
    
    // Check if space exists in GraphQL API
    if (!spacesInAPI.has(space.toLowerCase())) {
      console.log(`  ⚠ Space ${space} not tracked by GraphQL API, skipping verification`);
      skippedCount++;
      continue;
    }
    
    // Get delegators from parquet
    let parquetDelegators: string[];
    try {
      parquetDelegators = await processAllDelegators(space, currentPeriodTimestamp, delegationAddress);
    } catch (error) {
      console.log(`  No parquet file for ${space}, skipping`);
      skippedCount++;
      continue;
    }
    
    // Get delegators from GraphQL
    const graphqlDelegators = processGraphQLDelegators(delegateEvents, currentPeriodTimestamp, space);
    
    // Compare sets
    const parquetSet = new Set(parquetDelegators.map((d) => d.toLowerCase()));
    const graphqlSet = new Set(graphqlDelegators.map((d) => d.toLowerCase()));
    
    const inParquetNotGraphQL = [...parquetSet].filter((d) => !graphqlSet.has(d));
    const inGraphQLNotParquet = [...graphqlSet].filter((d) => !parquetSet.has(d));
    
    if (inParquetNotGraphQL.length > 0 || inGraphQLNotParquet.length > 0) {
      console.error(`\nVerification FAILED for ${space}:`);
      console.error(`  In parquet but not GraphQL: ${inParquetNotGraphQL.length}`);
      if (inParquetNotGraphQL.length > 0) {
        console.error(`    ${inParquetNotGraphQL.slice(0, 5).join(", ")}${inParquetNotGraphQL.length > 5 ? "..." : ""}`);
      }
      console.error(`  In GraphQL but not parquet: ${inGraphQLNotParquet.length}`);
      if (inGraphQLNotParquet.length > 0) {
        console.error(`    ${inGraphQLNotParquet.slice(0, 5).join(", ")}${inGraphQLNotParquet.length > 5 ? "..." : ""}`);
      }
      
      throw new Error(
        `Delegation verification failed for ${space}: ` +
        `${inParquetNotGraphQL.length} in parquet only, ` +
        `${inGraphQLNotParquet.length} in GraphQL only`
      );
    }
    
    console.log(`  ✓ ${space}: ${parquetDelegators.length} delegators match`);
    verifiedCount++;
  }
  
  console.log(`\n✓ Verified ${verifiedCount} spaces for chainId ${chainId} (${skippedCount} skipped)`);
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
    const apiEvents = await fetchDelegationEventsFromGraphQL(space, delegationAddress);
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
  const apiEvents = await fetchDelegationEventsFromGraphQL(space, delegationAddress);

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
