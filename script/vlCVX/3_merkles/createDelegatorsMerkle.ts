import fs from "fs";
import path from "path";
import * as moment from "moment";
import * as dotenv from "dotenv";
dotenv.config();

import { getAddress } from "viem";
import { mainnet } from "viem/chains";
import { createPublicClient, http } from "viem";
import { createCombineDistribution } from "../../utils/merkle";
import { generateMerkleTree } from "../utils";
import { MerkleData } from "../../interfaces/MerkleData";
import { CVX_SPACE, SDT, CRVUSD } from "../../utils/constants";
import { getCRVUsdTransfer } from "../utils";
import { getClosestBlockTimestamp } from "../../utils/chainUtils";
import { fetchTokenInfos } from "../../utils/tokens";
import { distributionVerifier } from "../../utils/distributionVerifier";
import { fetchLastProposalsIds } from "../../utils/snapshot";

const WEEK = 604800;
const currentPeriodTimestamp = Math.floor(moment.utc().unix() / WEEK) * WEEK;
const reportsDir = path.join("bounties-reports", currentPeriodTimestamp.toString(), "vlCVX");

const DELEGATION_FILE = path.join(reportsDir, "repartition_delegation.json");

if (!fs.existsSync(DELEGATION_FILE)) {
  console.error(`Delegation file not found: ${DELEGATION_FILE}`);
  process.exit(1);
}

// Load delegation data
const delegationData = JSON.parse(fs.readFileSync(DELEGATION_FILE, "utf8"));
const delegationSummary = delegationData.distribution;

// Initialize the distribution object for forwarders
const combined: { [address: string]: { tokens: { [token: string]: bigint } } } = {};

// Get the total forwarders share
const totalForwardersShare = parseFloat(delegationSummary.totalForwardersShare);

// Skip processing if no forwarders
if (totalForwardersShare <= 0) {
  console.warn("No forwarders found in delegation data.");
  process.exit(0);
}

// Get block numbers for crvUSD transfer calculation
async function processForwarders() {
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(process.env.RPC_URL || "https://rpc.flashbots.net"),
  });

  const currentBlock = Number(await publicClient.getBlockNumber());
  const minBlock = await getClosestBlockTimestamp("ethereum", currentPeriodTimestamp - WEEK); // TODO : Current week

  // Get crvUSD transfer amount for the week
  const crvUsdTransfer = await getCRVUsdTransfer(minBlock, currentBlock);
  let totalCrvUsd = crvUsdTransfer.amount;

  // Remove a small amount for rounding issues
  totalCrvUsd -= BigInt(10 ** 14);

  console.log("Total crvUSD for distribution:", totalCrvUsd.toString());

  // Get SDT amount from delegation summary
  let totalSDT = 0n;
  if (delegationSummary.totalSDTPerGroup && delegationSummary.totalSDTPerGroup.forwarders) {
    totalSDT = BigInt(delegationSummary.totalSDTPerGroup.forwarders);
    console.log("Total SDT for distribution to forwarders:", totalSDT.toString());
  } else {
    // Fallback to 5000 SDT if not specified in delegation summary
    totalSDT = 5000n * BigInt(10 ** 18);
    console.log("Using default 5000 SDT for distribution");
  }

  // Remove a small amount for rounding issues
  totalSDT -= BigInt(10 ** 14);

  // Process forwarders
  for (const [address, shareStr] of Object.entries(delegationSummary.forwarders)) {
    const share = parseFloat(shareStr);
    if (share <= 0) continue;

    // Calculate rewards based on share
    const crvUsdAmount = (totalCrvUsd * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);
    const sdtAmount = (totalSDT * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);

    const addr = getAddress(address);
    if (crvUsdAmount > 0n || sdtAmount > 0n) {
      combined[addr] = { tokens: {} };
      if (crvUsdAmount > 0n) {
        combined[addr].tokens[CRVUSD] = crvUsdAmount;
      }
      if (sdtAmount > 0n) {
        combined[addr].tokens[SDT] = sdtAmount;
      }
    }
  }

  // Load previous Merkle data
  const previousMerkleDataPath = path.join(
    "bounties-reports",
    "latest",
    "vlCVX",
    "vlcvx_merkle_delegators.json"
  );

  let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
  if (fs.existsSync(previousMerkleDataPath)) {
    previousMerkleData = JSON.parse(fs.readFileSync(previousMerkleDataPath, "utf8"));
    console.log("Loaded previous merkle data for delegators from latest directory");
  } else {
    console.log("No previous merkle data found for delegators in latest directory");
  }

  const currentDistribution = { distribution: combined };
  const universalMerkle = createCombineDistribution(currentDistribution, previousMerkleData);
  const newMerkleData: MerkleData = generateMerkleTree(universalMerkle);

  console.log("Delegators Merkle Root:", newMerkleData.merkleRoot);

  // Ensure the output directory exists
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const outputPath = path.join(reportsDir, "merkle_data_delegators.json");
  fs.writeFileSync(outputPath, JSON.stringify(newMerkleData, null, 2));
  console.log("Delegators Merkle tree generated and saved as merkle_data_delegators.json");
  
  // Run distribution verifier
  const filter = "^(?!FXN ).*Gauge Weight for Week of";
  const now = Math.floor(Date.now() / 1000);
  try {
    const proposalIdPerSpace = await fetchLastProposalsIds([CVX_SPACE], now, filter);
    const proposalId = proposalIdPerSpace[CVX_SPACE];
    console.log("Running verifier with proposalId:", proposalId);
    
    distributionVerifier(
      CVX_SPACE,
      mainnet,
      "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db",
      newMerkleData,
      previousMerkleData,
      currentDistribution.distribution,
      proposalId
    );
  } catch (error) {
    console.error("Error running distribution verifier:", error);
  }
}


// Execute the script
processForwarders().catch(console.error);