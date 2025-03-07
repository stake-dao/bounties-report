import fs from "fs";
import path from "path";
import * as moment from "moment";
import * as dotenv from "dotenv";
dotenv.config();

import { getAddress, Chain } from "viem";
import { mainnet } from "viem/chains";
import { createCombineDistribution } from "../../utils/merkle";
import { generateMerkleTree } from "../utils";
import { MerkleData } from "../../interfaces/MerkleData";
import { Distribution } from "../../interfaces/Distribution";
import { CVX_SPACE, ETHEREUM, SDT } from "../../utils/constants";
import { distributionVerifier } from "../../utils/distributionVerifier";

const WEEK = 604800;
const currentPeriodTimestamp = Math.floor(moment.utc().unix() / WEEK) * WEEK;
const reportsDir = path.join("bounties-reports", currentPeriodTimestamp.toString(), "vlCVX");

const NON_DELEGATORS_FILE = path.join(reportsDir, "repartition.json");
const DELEGATION_FILE = path.join(reportsDir, "repartition_delegation.json");

if (!fs.existsSync(NON_DELEGATORS_FILE)) {
  console.error(`Non-delegators file not found: ${NON_DELEGATORS_FILE}`);
  process.exit(1);
}
if (!fs.existsSync(DELEGATION_FILE)) {
  console.error(`Delegation file not found: ${DELEGATION_FILE}`);
  process.exit(1);
}

const nonDelegatorsData = JSON.parse(fs.readFileSync(NON_DELEGATORS_FILE, "utf8"));
const nonDelegators = nonDelegatorsData.distribution;

const delegationData = JSON.parse(fs.readFileSync(DELEGATION_FILE, "utf8"));
const delegationSummary = delegationData.distribution;

// Start with gauge-based (non-delegators) distribution.
const combined: { [address: string]: { tokens: { [token: string]: bigint } } } = {};
for (const [address, data] of Object.entries(nonDelegators)) {
  const addr = address.toLowerCase();
  combined[addr] = { tokens: {} };
  for (const [token, amountStr] of Object.entries(data.tokens)) {
    combined[addr].tokens[token] = BigInt(amountStr);
  }
}

// For delegation rewards we use two separate pools:
// (A) For tokens other than SDT: from delegationTotalTokens * totalNonForwardersShare
// (B) For SDT: totalSDT = 5000 SDT * (totalNonForwardersShare)

const delegationTotalTokens = delegationSummary.totalTokens; // string amounts per token
const totalNonForwardersShare = parseFloat(delegationSummary.totalNonForwardersShare);

// We’ll build a new pool for non-SDT tokens.
const newDelegationPool: { [token: string]: bigint } = {};
if (totalNonForwardersShare > 0) {
  for (const [token, totalStr] of Object.entries(delegationTotalTokens)) {
    if (getAddress(token) === getAddress(SDT)) continue; // Skip SDT here.
    const total = BigInt(totalStr);
    newDelegationPool[token] = BigInt(Math.floor(Number(total) * totalNonForwardersShare));
  }
  console.log("Delegation Non-Forwarders Pool (non-SDT):");
  for (const [token, pool] of Object.entries(newDelegationPool)) {
    console.log(`${token}: ${pool.toString()}`);
  }
} else {
  console.warn("No delegation non-forwarded rewards to add for non-SDT tokens.");
}

// Process delegation non-forwarders for non-SDT tokens.
if (totalNonForwardersShare > 0) {
  for (const [address, shareStr] of Object.entries(delegationSummary.nonForwarders)) {
    const share = parseFloat(shareStr);
    const rewardsForAddress: { [token: string]: bigint } = {};
    for (const [token, pool] of Object.entries(newDelegationPool)) {
      const reward = BigInt(Math.floor((share / totalNonForwardersShare) * Number(pool)));
      rewardsForAddress[token] = reward;
    }
    const addr = address.toLowerCase();
    if (combined[addr]) {
      for (const [token, reward] of Object.entries(rewardsForAddress)) {
        combined[addr].tokens[token] = (combined[addr].tokens[token] || 0n) + reward;
      }
    } else {
      combined[addr] = { tokens: rewardsForAddress };
    }
  }
}

// Now process SDT separately.
// Total SDT to distribute = 5000 SDT * totalNonForwardersShare.
const baseSDT = 5000n * (10n ** 18n);
const totalSDT = baseSDT * BigInt(Math.floor(totalNonForwardersShare * 1e6)) / 1000000n;

// Log total SDT pool.
console.log("Total SDT Pool (to be distributed to forwarders):", totalSDT.toString());

// Calculate total forwarders share.
const totalForwardersShare = Object.values(delegationSummary.forwarders)
  .reduce((acc, s) => acc + parseFloat(s), 0);

if (totalForwardersShare > 0) {
  for (const [address, shareStr] of Object.entries(delegationSummary.forwarders)) {
    const share = parseFloat(shareStr);
    const reward = BigInt(Math.floor((share / totalForwardersShare) * Number(totalSDT)));
    const addr = address.toLowerCase();
    // SDT is added only to forwarders.
    if (combined[addr]) {
      combined[addr].tokens[SDT] = (combined[addr].tokens[SDT] || 0n) + reward;
    } else {
      combined[addr] = { tokens: { [SDT]: reward } };
    }
  }
} else {
  console.warn("No forwarders found for SDT distribution.");
}

// Load previous Merkle data.
const prevWeekTimestamp = currentPeriodTimestamp - WEEK;
const previousMerkleDataPath = path.join(
  "bounties-reports",
  prevWeekTimestamp.toString(),
  "vlCVX",
  "merkle_data_non_delegators.json"
);
let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
if (fs.existsSync(previousMerkleDataPath)) {
  previousMerkleData = JSON.parse(fs.readFileSync(previousMerkleDataPath, "utf8"));
}

const currentDistribution = { distribution: combined };
const universalMerkle = createCombineDistribution(currentDistribution, previousMerkleData);
const newMerkleData: MerkleData = generateMerkleTree(universalMerkle);

console.log("Combined Merkle Root:", newMerkleData.merkleRoot);

const outputPath = path.join(reportsDir, "merkle_data_non_delegators.json");
fs.writeFileSync(outputPath, JSON.stringify(newMerkleData, null, 2));
console.log("Combined Merkle tree generated and saved as merkle_data_non_delegators.json");

// TODO : use data as input directly.
distributionVerifier(
  CVX_SPACE,
  mainnet,
  "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db",
  "bounties-reports/latest/vlCVX/merkle_data_non_delegators.json",
  "bounties-reports/latest/vlCVX/merkle_data_non_delegators.json",
  "bounties-reports/latest/vlCVX/repartition.json"
);


