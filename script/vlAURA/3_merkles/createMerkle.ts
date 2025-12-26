import fs from "fs";
import path from "path";
import * as moment from "moment";
import * as dotenv from "dotenv";
dotenv.config();

import { createCombineDistribution } from "../../utils/merkle/merkle";
import { generateMerkleTree } from "../utils";
import { MerkleData } from "../../interfaces/MerkleData";
import { WEEK } from "../../utils/constants";

const currentPeriodTimestamp = Math.floor(moment.utc().unix() / WEEK) * WEEK;

// Supported chain IDs for vlAURA
const SUPPORTED_CHAIN_IDS = ["1", "42161", "10", "8453", "137"];

// Store merkle data per chain
const merkleDataByChain: Record<string, MerkleData> = {};

/**
 * Process a single chain's repartition data
 */
async function processChain(chainId: string, reportsDir: string) {
  console.log(`\nProcessing chain ${chainId}...`);

  const suffix = chainId === "1" ? "" : `_${chainId}`;
  const nonDelegatorsFile = path.join(reportsDir, `repartition${suffix}.json`);
  const delegationFile = path.join(
    reportsDir,
    `repartition_delegation${suffix}.json`
  );

  // Check if any files exist for this chain
  if (!fs.existsSync(nonDelegatorsFile) && !fs.existsSync(delegationFile)) {
    console.log(`No repartition files found for chain ${chainId}, skipping`);
    return;
  }

  const combined: {
    [address: string]: { tokens: { [token: string]: bigint } };
  } = {};

  // Load non-delegators
  if (fs.existsSync(nonDelegatorsFile)) {
    const nonDelegatorsData = JSON.parse(
      fs.readFileSync(nonDelegatorsFile, "utf8")
    );
    for (const [address, data] of Object.entries(
      nonDelegatorsData.distribution
    )) {
      const addr = address.toLowerCase();
      if (!combined[addr]) {
        combined[addr] = { tokens: {} };
      }
      if (data && typeof data === "object" && "tokens" in data) {
        for (const [token, amountStr] of Object.entries((data as any).tokens)) {
          combined[addr].tokens[token] =
            (combined[addr].tokens[token] || 0n) + BigInt(amountStr as string);
        }
      }
    }
    console.log(
      `Chain ${chainId}: Loaded ${
        Object.keys(nonDelegatorsData.distribution).length
      } non-delegators`
    );
  }

  // Load delegation data
  if (fs.existsSync(delegationFile)) {
    const delegationData = JSON.parse(fs.readFileSync(delegationFile, "utf8"));
    const { totalTokens, delegators } = delegationData.distribution;

    if (totalTokens && delegators) {
      // Distribute tokens to delegators based on their share
      for (const [address, shareStr] of Object.entries(delegators)) {
        const share = parseFloat(shareStr as string);
        const addr = address.toLowerCase();

        if (!combined[addr]) {
          combined[addr] = { tokens: {} };
        }

        for (const [token, totalStr] of Object.entries(totalTokens)) {
          const total = BigInt(totalStr as string);
          const reward = BigInt(Math.floor(share * Number(total)));
          combined[addr].tokens[token] =
            (combined[addr].tokens[token] || 0n) + reward;
        }
      }
      console.log(
        `Chain ${chainId}: Added ${Object.keys(delegators).length} delegators`
      );
    }
  }

  if (Object.keys(combined).length === 0) {
    console.log(`Chain ${chainId}: No distributions to process`);
    return;
  }

  // Load previous merkle data for this chain
  const prevPeriodTimestamp = currentPeriodTimestamp - WEEK;
  const prevMerkleFileName =
    chainId === "1" ? "vlaura_merkle.json" : `vlaura_merkle_${chainId}.json`;
  const prevMerklePath = path.join(
    "bounties-reports",
    prevPeriodTimestamp.toString(),
    "vlAURA",
    prevMerkleFileName
  );

  let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
  if (fs.existsSync(prevMerklePath)) {
    previousMerkleData = JSON.parse(fs.readFileSync(prevMerklePath, "utf8"));
    console.log(
      `Chain ${chainId}: Loaded previous merkle from ${prevMerklePath}`
    );
  } else {
    console.log(`Chain ${chainId}: No previous merkle data found`);
  }

  // Convert combined distribution to the format expected by createCombineDistribution
  const currentDistribution: {
    distribution: { [address: string]: { tokens: { [token: string]: bigint } } };
  } = { distribution: combined };

  // Create combined distribution with previous merkle
  const universalMerkle = createCombineDistribution(
    currentDistribution,
    previousMerkleData
  );

  // Generate merkle tree
  const newMerkleData: MerkleData = generateMerkleTree(universalMerkle);

  console.log(`Chain ${chainId}: Merkle Root: ${newMerkleData.merkleRoot}`);
  console.log(
    `Chain ${chainId}: Total claims: ${Object.keys(newMerkleData.claims).length}`
  );

  // Store for later saving
  merkleDataByChain[chainId] = newMerkleData;

  // Save merkle for this chain
  const merkleFileName =
    chainId === "1" ? "vlaura_merkle.json" : `vlaura_merkle_${chainId}.json`;
  const merkleFile = path.join(reportsDir, merkleFileName);

  fs.writeFileSync(merkleFile, JSON.stringify(newMerkleData, null, 2));
  console.log(`Chain ${chainId}: Saved merkle to ${merkleFile}`);

  // Log summary of totals per token
  const totals: Record<string, bigint> = {};
  for (const [, claim] of Object.entries(newMerkleData.claims)) {
    for (const [token, tokenClaim] of Object.entries(claim.tokens)) {
      totals[token] = (totals[token] || 0n) + BigInt(tokenClaim.amount);
    }
  }
  console.log(`Chain ${chainId}: Total per token in merkle:`);
  for (const [token, amount] of Object.entries(totals)) {
    console.log(`  ${token}: ${amount.toString()}`);
  }
}

async function main() {
  console.log("Running vlAURA merkle generation...");
  console.log(`Period: ${currentPeriodTimestamp}`);

  const reportsDir = path.join(
    "bounties-reports",
    currentPeriodTimestamp.toString(),
    "vlAURA"
  );

  // Check if merkle already exists (mainnet)
  const mainMerkleFile = path.join(reportsDir, "vlaura_merkle.json");
  if (fs.existsSync(mainMerkleFile) && process.env.FORCE_UPDATE !== "true") {
    console.error(`Merkle file already exists: ${mainMerkleFile}`);
    console.error(`To force regeneration, run with FORCE_UPDATE=true`);
    process.exit(1);
  }

  // Ensure directory exists
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // Process each supported chain
  for (const chainId of SUPPORTED_CHAIN_IDS) {
    await processChain(chainId, reportsDir);
  }

  // Summary
  console.log("\n=== Summary ===");
  const processedChains = Object.keys(merkleDataByChain);
  if (processedChains.length === 0) {
    console.log("No merkle trees generated");
  } else {
    console.log(`Generated merkle trees for chains: ${processedChains.join(", ")}`);
    for (const chainId of processedChains) {
      const merkle = merkleDataByChain[chainId];
      console.log(
        `  Chain ${chainId}: ${Object.keys(merkle.claims).length} claims`
      );
    }
  }

  console.log("\nvlAURA merkle generation completed successfully.");
}

main().catch(console.error);
