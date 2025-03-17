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
import { distributionVerifier } from "../../utils/distributionVerifier";
import { fetchLastProposalsIds } from "../../utils/snapshot";

// Number of seconds in one week
const WEEK = 604800;

// Round current UTC time down to the nearest week to get the current period timestamp
const currentPeriodTimestamp = Math.floor(moment.utc().unix() / WEEK) * WEEK;

// The directory to which we'll write the bounties reports for this period
const reportsDir = path.join(
  "bounties-reports",
  currentPeriodTimestamp.toString(),
  "vlCVX"
);

// Path to the JSON file holding delegation data for this period
const DELEGATION_FILE = path.join(reportsDir, "repartition_delegation.json");

// Ensure the required file exists before proceeding
if (!fs.existsSync(DELEGATION_FILE)) {
  console.error(`Delegation file not found: ${DELEGATION_FILE}`);
  process.exit(1);
}

// Load the delegation data from disk
const delegationData = JSON.parse(fs.readFileSync(DELEGATION_FILE, "utf8"));
const delegationSummary = delegationData.distribution;

// Object where we'll accumulate final forwarder distributions
const combined: { [address: string]: { tokens: { [token: string]: bigint } } } =
  {};

// Extract the total share of forwarders from the loaded delegation summary
const totalForwardersShare = parseFloat(delegationSummary.totalForwardersShare);

// If no forwarders are present, there's no need to do anything
if (totalForwardersShare <= 0) {
  console.warn("No forwarders found in delegation data.");
  process.exit(0);
}

/**
 * Main function to compute forwarder rewards, build a Merkle tree,
 * and run the distribution verifier.
 */
async function processForwarders() {
  // Create a public viem client for mainnet (using an RPC URL from .env if provided)
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(process.env.RPC_URL || "https://rpc.flashbots.net"),
  });

  // Fetch the current block number
  const currentBlock = Number(await publicClient.getBlockNumber());

  // We'll look for transfers since the start of the current period,
  // i.e., the block near `currentPeriodTimestamp`
  const minBlock = await getClosestBlockTimestamp(
    "ethereum",
    currentPeriodTimestamp
  );

  // Query the CRVUSD transfer data within the specified block range
  const crvUsdTransfer = await getCRVUsdTransfer(minBlock, currentBlock);

  // We store the total amount of crvUSD found during this time frame
  let totalCrvUsd = crvUsdTransfer.amount;

  // Subtract a small buffer to avoid minor rounding issues
  totalCrvUsd -= BigInt(10 ** 14);
  console.log("Total crvUSD for distribution:", totalCrvUsd.toString());

  // Similarly, retrieve the SDT amount to distribute from the delegation summary
  // If it's missing, we'll use a default fallback of 5000 SDT
  let totalSDT = 0n;
  if (
    delegationSummary.totalSDTPerGroup &&
    delegationSummary.totalSDTPerGroup.forwarders
  ) {
    totalSDT = BigInt(delegationSummary.totalSDTPerGroup.forwarders);
    console.log(
      "Total SDT for distribution to forwarders:",
      totalSDT.toString()
    );
  } else {
    // Fallback to 5000 SDT (with 18 decimals) if not specified in the summary
    totalSDT = 5000n * BigInt(10 ** 18);
    console.log("Using default 5000 SDT for distribution");
  }

  // Again subtract a small buffer for rounding issues
  totalSDT -= BigInt(10 ** 14);

  // Iterate over each forwarder from the delegation summary
  // Calculate their portion of both crvUSD and SDT
  for (const [address, shareStr] of Object.entries(
    delegationSummary.forwarders
  )) {
    const share = parseFloat(shareStr);
    if (share <= 0) continue; // Skip any zero or negative shares

    // Convert the share to a BigInt-based fraction and multiply by total token amounts
    const crvUsdAmount =
      (totalCrvUsd * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);
    const sdtAmount =
      (totalSDT * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);

    // Convert the address to EIP-55 format
    const addr = getAddress(address);

    // Only add if the user gets a non-zero allocation
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

  // Load previous Merkle data for forwarders (if any)
  // This file is used to ensure continuity of claims across periods
  const previousMerkleDataPath = path.join(
    "bounties-reports",
    "latest",
    "vlCVX",
    "vlcvx_merkle_delegators.json"
  );

  let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
  if (fs.existsSync(previousMerkleDataPath)) {
    previousMerkleData = JSON.parse(
      fs.readFileSync(previousMerkleDataPath, "utf8")
    );
    console.log(
      "Loaded previous merkle data for delegators from latest directory"
    );
  } else {
    console.log(
      "No previous merkle data found for delegators in latest directory"
    );
  }

  // Combine the current distribution with the previous claims
  // so that any leftover / carry-over amounts remain claimable
  const currentDistribution = { distribution: combined };
  const universalMerkle = createCombineDistribution(
    currentDistribution,
    previousMerkleData
  );
  const newMerkleData: MerkleData = generateMerkleTree(universalMerkle);

  console.log("Delegators Merkle Root:", newMerkleData.merkleRoot);

  // Ensure output directory exists
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // Write the newly generated Merkle data to a JSON file
  const outputPath = path.join(reportsDir, "merkle_data_delegators.json");
  fs.writeFileSync(outputPath, JSON.stringify(newMerkleData, null, 2));
  console.log(
    "Delegators Merkle tree generated and saved as merkle_data_delegators.json"
  );

  // Attempt to verify distribution on mainnet
  const filter = "^(?!FXN ).*Gauge Weight for Week of";
  const now = Math.floor(Date.now() / 1000);
  try {
    // Find the proposal ID used for verifying distribution
    const proposalIdPerSpace = await fetchLastProposalsIds(
      [CVX_SPACE],
      now,
      filter
    );
    const proposalId = proposalIdPerSpace[CVX_SPACE];
    console.log("Running verifier with proposalId:", proposalId);

    distributionVerifier(
      CVX_SPACE,
      mainnet,
      "0x17F513CDE031C8B1E878Bde1Cb020cE29f77f380", // Target contract
      newMerkleData,
      previousMerkleData,
      currentDistribution.distribution,
      proposalId
    );
  } catch (error) {
    console.error("Error running distribution verifier:", error);
  }
}

// Run the forwarders processing flow
processForwarders().catch(console.error);
