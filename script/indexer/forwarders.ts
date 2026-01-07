import { VOTIUM_FORWARDER, VOTIUM_FORWARDER_REGISTRY } from "../utils/constants";
import { fetchAllForwarders } from "../utils/forwarderCacheUtils";

/**
 * Index Votium forwarders who forward to Stake DAO's delegation address
 * 
 * This fetches setReg and expReg events from the Votium Forwarder Registry
 * and stores them in a parquet file for efficient lookup.
 */
const indexForwarders = async () => {
  console.log("Fetching Votium forwarder registry logs for Ethereum...");
  console.log(`Registry: ${VOTIUM_FORWARDER_REGISTRY}`);
  console.log(`Filtering for forwards to: ${VOTIUM_FORWARDER}`);

  await fetchAllForwarders("1", VOTIUM_FORWARDER);

  console.log("\nForwarder indexing complete.");
};

const main = async () => {
  await indexForwarders();
};

main().catch(console.error);
