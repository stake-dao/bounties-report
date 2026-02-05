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

const VLAURA_CHAIN_IDS = [1, 8453]; // Ethereum and Base

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
}

main().catch(console.error);
