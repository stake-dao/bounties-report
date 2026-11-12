import {
  AUTO_VOTER_DELEGATION_ADDRESS,
  DELEGATION_ADDRESS,
} from "../utils/constants";
import { fetchAllDelegators } from "../utils/cacheUtils";
import { verifyAllSpacesAgainstRPC } from "../utils/delegationRPCUtils";

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
 * Cross-verify Ethereum parquet cache against the Snapshot registry at one
 * finalized RPC block. Errors and mismatches remain blocking.
 */
const verifyDelegations = async () => {
  console.log("\n" + "=".repeat(60));
  console.log("Cross-verifying parquet cache against finalized RPC state...");
  console.log("=".repeat(60));

  // Preserve the existing gate's scope: Stake DAO delegation on Ethereum.
  await verifyAllSpacesAgainstRPC("1", DELEGATION_ADDRESS);

  console.log("\n" + "=".repeat(60));
  console.log("✓ All verifications passed");
  console.log("=".repeat(60));
};

const main = async () => {
  await indexDelegators();
  await verifyDelegations();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
