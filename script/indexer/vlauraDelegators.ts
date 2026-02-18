/**
 * Index vlAURA delegators from AuraLocker contracts
 *
 * This script fetches DelegateChanged events from AuraLocker contracts
 * on Ethereum and Base, storing them in Parquet format for reliable
 * snapshot queries.
 *
 * Usage:
 *   pnpm tsx script/indexer/vlauraDelegators.ts
 *
 * The indexer supports incremental updates - it will resume from the
 * last processed block stored in the Parquet file.
 */

import { indexVlAuraDelegators, processVlAuraDelegators, getVlAuraCacheEndBlock } from "../utils/vlAuraCacheUtils";
import { DELEGATION_ADDRESS } from "../utils/constants";
import { getVlAuraDelegatorsAtTimestamp } from "../utils/vlAuraUtils";
import { getClient } from "../utils/getClients";

const VLAURA_CHAIN_IDS = [1, 8453]; // Ethereum and Base

/**
 * Cross-verify parquet delegator sets against GraphQL for each chain.
 * Warns on discrepancies instead of throwing — the GraphQL indexer
 * (OnChainDelegationEvent) may lag behind RPC, so it's not authoritative.
 */
async function verifyVlAuraDelegations() {
  console.log("\n" + "=".repeat(60));
  console.log("Cross-verifying parquet cache against GraphQL API...");
  console.log("=".repeat(60));

  for (const chainId of VLAURA_CHAIN_IDS) {
    try {
      const endBlock = await getVlAuraCacheEndBlock(chainId);
      const parquetDelegators = await processVlAuraDelegators(chainId, DELEGATION_ADDRESS, endBlock);

      // Get block timestamp for the GraphQL query
      const client = await getClient(chainId);
      const block = await client.getBlock({ blockNumber: BigInt(endBlock) });
      const blockTimestamp = Number(block.timestamp);

      console.log(
        `\n[Chain ${chainId}] Verifying at block ${endBlock} (${new Date(blockTimestamp * 1000).toISOString()})...`
      );

      const graphqlDelegators = await getVlAuraDelegatorsAtTimestamp(blockTimestamp, chainId);

      // Compare sets
      const parquetSet = new Set(parquetDelegators.map((d) => d.toLowerCase()));
      const graphqlSet = new Set(graphqlDelegators.map((d) => d.toLowerCase()));

      const inParquetNotGraphQL = [...parquetSet].filter((d) => !graphqlSet.has(d));
      const inGraphQLNotParquet = [...graphqlSet].filter((d) => !parquetSet.has(d));

      if (inParquetNotGraphQL.length === 0 && inGraphQLNotParquet.length === 0) {
        console.log(`[Chain ${chainId}] ✓ ${parquetSet.size} delegators match`);
      } else {
        console.warn(`[Chain ${chainId}] ⚠ Discrepancy detected:`);
        console.warn(`  Parquet: ${parquetSet.size}, GraphQL: ${graphqlSet.size}`);
        if (inParquetNotGraphQL.length > 0) {
          console.warn(`  In parquet but not GraphQL (${inParquetNotGraphQL.length}):`);
          inParquetNotGraphQL.slice(0, 5).forEach((addr) => console.warn(`    - ${addr}`));
          if (inParquetNotGraphQL.length > 5) console.warn(`    ... and ${inParquetNotGraphQL.length - 5} more`);
        }
        if (inGraphQLNotParquet.length > 0) {
          console.warn(`  In GraphQL but not parquet (${inGraphQLNotParquet.length}):`);
          inGraphQLNotParquet.slice(0, 5).forEach((addr) => console.warn(`    - ${addr}`));
          if (inGraphQLNotParquet.length > 5) console.warn(`    ... and ${inGraphQLNotParquet.length - 5} more`);
        }
      }
    } catch (error) {
      console.warn(`[Chain ${chainId}] ⚠ Verification skipped (GraphQL may be unavailable):`, error);
    }
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("vlAURA Delegators Indexer");
  console.log("=".repeat(60));

  for (const chainId of VLAURA_CHAIN_IDS) {
    console.log(`\n[Chain ${chainId}] Starting indexer...`);

    try {
      await indexVlAuraDelegators(chainId);

      // Verify by counting delegators at current end block
      const endBlock = await getVlAuraCacheEndBlock(chainId);
      const delegators = await processVlAuraDelegators(chainId, DELEGATION_ADDRESS, endBlock);

      console.log(`[Chain ${chainId}] Cache now has ${delegators.length} StakeDAO delegators at block ${endBlock}`);
    } catch (error) {
      console.error(`[Chain ${chainId}] Error:`, error);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Indexing complete");
  console.log("=".repeat(60));

  // Cross-verify parquet against GraphQL
  await verifyVlAuraDelegations();
}

main().catch(console.error);
