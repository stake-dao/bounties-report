import {
  AUTO_VOTER_DELEGATION_ADDRESS,
  DELEGATION_ADDRESS,
} from "../utils/constants";
import { fetchAllDelegators } from "../utils/cacheUtils";
import { verifyAllSpacesAgainstGraphQL } from "../utils/delegationAPIUtils";

/*
 * Index delegators for all spaces on Stake DAO delegation + Autovoter
 */
const indexDelegators = async () => {
  console.log("Fetching Stake DAO delegation logs for Ethereum...");

  // Ethereum
  await fetchAllDelegators("1", [
    DELEGATION_ADDRESS,
    AUTO_VOTER_DELEGATION_ADDRESS,
  ]);

  // BSC
  await fetchAllDelegators("56", [DELEGATION_ADDRESS]);

  // Base
  await fetchAllDelegators("8453", [DELEGATION_ADDRESS, AUTO_VOTER_DELEGATION_ADDRESS]);
};

/**
 * Cross-verify parquet cache against GraphQL API for DELEGATION_ADDRESS
 * Throws an error if any mismatches are found
 * Note: Only verifies Ethereum (chainId 1) - BSC and Base not fully tracked by API
 */
const verifyDelegations = async () => {
  console.log("\n" + "=".repeat(60));
  console.log("Cross-verifying parquet cache against GraphQL API...");
  console.log("=".repeat(60));

  const currentTimestamp = Math.floor(Date.now() / 1000);
  console.log(`Verification timestamp: ${currentTimestamp} (${new Date(currentTimestamp * 1000).toISOString()})`);

  // Verify DELEGATION_ADDRESS only (not Auto Voter) for Ethereum only
  // BSC (sdcake.eth) and Base (sdspectra.eth) are not fully tracked by the GraphQL API
  await verifyAllSpacesAgainstGraphQL("1", DELEGATION_ADDRESS, currentTimestamp);

  console.log("\n" + "=".repeat(60));
  console.log("✓ All verifications passed");
  console.log("=".repeat(60));
};

const main = async () => {
  await indexDelegators();
  await verifyDelegations();
};

main().catch(console.error);
