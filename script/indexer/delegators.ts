import {
  AUTO_VOTER_DELEGATION_ADDRESS,
  DELEGATION_ADDRESS,
} from "../utils/constants";
import { fetchAllDelegators } from "../utils/cacheUtils";

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

const main = async () => {
  await indexDelegators();
};

main().catch(console.error);
