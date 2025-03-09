import fs from "fs";
import path from "path";
import * as moment from "moment";
import * as dotenv from "dotenv";
dotenv.config();

import { getAddress } from "viem";
import { mainnet } from "viem/chains";
import { createCombineDistribution } from "../../utils/merkle";
import { generateMerkleTree } from "../utils";
import { MerkleData } from "../../interfaces/MerkleData";
import { CVX_SPACE, SDT } from "../../utils/constants";
import { distributionVerifier } from "../../utils/distributionVerifier";
import { fetchLastProposalsIds, getProposal } from "../../utils/snapshot";

const WEEK = 604800;
const currentPeriodTimestamp = Math.floor(moment.utc().unix() / WEEK) * WEEK;
const reportsDir = path.join("bounties-reports", currentPeriodTimestamp.toString(), "vlCVX");

const NON_DELEGATORS_FILE = path.join(reportsDir, "repartition.json");
const DELEGATION_FILE = path.join(reportsDir, "repartition_delegation.json");

// Also fetch all delegation from other chains
const DELEGATION_FILE_ARBITRUM = path.join(reportsDir, "repartition_42161.json");
const DELEGATION_FILE_OPTIMISM = path.join(reportsDir, "repartition_10.json");
const DELEGATION_FILE_BASE = path.join(reportsDir, "repartition_8453.json");
const DELEGATION_FILE_POLYGON = path.join(reportsDir, "repartition_137.json");

// Process each chain separately
processChain("1", NON_DELEGATORS_FILE, DELEGATION_FILE);

// Process other chains
const otherChainIds = ["42161", "10", "8453", "137"];
for (const chainId of otherChainIds) {
  const nonDelegatorsFile = path.join(reportsDir, `repartition_${chainId}.json`);
  const delegationFile = path.join(reportsDir, `repartition_delegation_${chainId}.json`);
  
  // Check if at least the delegation file exists
  if (fs.existsSync(delegationFile)) {
    processChain(chainId, nonDelegatorsFile, delegationFile);
  }
}

// Function to process a single chain
function processChain(chainId: string, nonDelegatorsFilePath: string, delegationFilePath: string) {
  console.log(`\nProcessing chain ${chainId}...`);
  
  // Initialize combined distribution
  const combined: { [address: string]: { tokens: { [token: string]: bigint } } } = {};
  
  // Load non-delegators data if file exists
  if (fs.existsSync(nonDelegatorsFilePath)) {
    const nonDelegatorsData = JSON.parse(fs.readFileSync(nonDelegatorsFilePath, "utf8"));
    const nonDelegators = nonDelegatorsData.distribution;
    
    // Add non-delegators to combined distribution
    for (const [address, data] of Object.entries(nonDelegators)) {
      const addr = address.toLowerCase();
      combined[addr] = { tokens: {} };
      for (const [token, amountStr] of Object.entries(data.tokens)) {
        combined[addr].tokens[token] = BigInt(amountStr);
      }
    }
    console.log(`Loaded non-delegators data for chain ${chainId}`);
  } else {
    console.log(`No non-delegators file found for chain ${chainId}, continuing with delegation data only`);
  }
  
  // Load delegation data
  if (!fs.existsSync(delegationFilePath)) {
    console.error(`Delegation file not found for chain ${chainId}: ${delegationFilePath}`);
    return; // Skip this chain if no delegation data
  }
  
  const delegationData = JSON.parse(fs.readFileSync(delegationFilePath, "utf8"));
  const delegationSummary = delegationData.distribution;
  
  const delegationTotalTokens = delegationSummary.totalTokens;
  const totalNonForwardersShare = parseFloat(delegationSummary.totalNonForwardersShare);
  
  // Build pool for tokens on this chain
  const delegationPool: { [token: string]: bigint } = {};
  if (totalNonForwardersShare > 0) {
    for (const [token, totalStr] of Object.entries(delegationTotalTokens)) {
      // Skip SDT for mainnet (it's handled separately)
      if (chainId === "1" && getAddress(token) === getAddress(SDT)) continue;
      
      // Use the token-specific amount for non-forwarders from totalPerGroup
      if (delegationSummary.totalPerGroup[token] && delegationSummary.totalPerGroup[token].nonForwarders) {
        delegationPool[token] = BigInt(delegationSummary.totalPerGroup[token].nonForwarders);
      } else {
        // Fallback to the old calculation if totalPerGroup data is missing
        const total = BigInt(totalStr);
        delegationPool[token] = BigInt(Math.floor(Number(total) * totalNonForwardersShare));
      }
    }
    console.log(`Delegation Non-Forwarders Pool for chain ${chainId}:`);
    for (const [token, pool] of Object.entries(delegationPool)) {
      console.log(`${token}: ${pool.toString()}`);
    }
  } else {
    console.warn(`No delegation non-forwarded rewards to add for chain ${chainId}.`);
    if (Object.keys(combined).length === 0) {
      return; // Skip if no non-delegators and no non-forwarders
    }
  }
  
  // Process delegation non-forwarders for tokens on this chain
  if (totalNonForwardersShare > 0) {
    for (const [address, shareStr] of Object.entries(delegationSummary.nonForwarders)) {
      const share = parseFloat(shareStr);
      const rewardsForAddress: { [token: string]: bigint } = {};
      for (const [token, pool] of Object.entries(delegationPool)) {
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
  
  // Process SDT separately for mainnet
  if (chainId === "1" && totalNonForwardersShare > 0 && 
      delegationSummary.totalSDTPerGroup && delegationSummary.totalSDTPerGroup.nonForwarders) {
    console.log("Total SDT Pool (to be distributed to non forwarders):", delegationSummary.totalSDTPerGroup.nonForwarders);
    
    for (const [address, shareStr] of Object.entries(delegationSummary.nonForwarders)) {
      const share = parseFloat(shareStr);
      const reward = BigInt(Math.floor(share * Number(delegationSummary.totalSDTPerGroup.nonForwarders)));
      const addr = address.toLowerCase();
      if (combined[addr]) {
        combined[addr].tokens[SDT] = (combined[addr].tokens[SDT] || 0n) + reward;
      } else {
        combined[addr] = { tokens: { [SDT]: reward } };
      }
    }
  }
  
  // Skip if no distributions to process
  if (Object.keys(combined).length === 0) {
    console.log(`No distributions to process for chain ${chainId}`);
    return;
  }
  
  // Load previous Merkle data for this chain
  const merkleFileName = chainId === "1" ? 
    "vlcvx_merkle.json" : 
    `vlcvx_merkle_${chainId}.json`;
    
  const previousMerkleDataPath = path.join(
    "bounties-reports",
    "latest",
    "vlCVX",
    merkleFileName
  );
  
  let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
  if (fs.existsSync(previousMerkleDataPath)) {
    previousMerkleData = JSON.parse(fs.readFileSync(previousMerkleDataPath, "utf8"));
    console.log(`Loaded previous merkle data for chain ${chainId} from latest directory`);
  } else {
    console.log(`No previous merkle data found for chain ${chainId} in latest directory`);
  }
  
  const currentDistribution = { distribution: combined };
  const universalMerkle = createCombineDistribution(currentDistribution, previousMerkleData);
  const newMerkleData: MerkleData = generateMerkleTree(universalMerkle);
  
  console.log(`Merkle Root for chain ${chainId}:`, newMerkleData.merkleRoot);
  
  const outputPath = path.join(reportsDir, merkleFileName);
  fs.writeFileSync(outputPath, JSON.stringify(newMerkleData, null, 2));
  console.log(`Merkle tree for chain ${chainId} generated and saved as ${merkleFileName}`);
  
  // Run verifier for all  only
  if (chainId === "1") {
    const filter = "^(?!FXN ).*Gauge Weight for Week of";
    const now = Math.floor(Date.now() / 1000);
    (async () => {
      const proposalIdPerSpace = await fetchLastProposalsIds([CVX_SPACE], now, filter);
      const proposalId = proposalIdPerSpace[CVX_SPACE];
      console.log("proposalId", proposalId);
      
      distributionVerifier(
        CVX_SPACE,
        mainnet,
        "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db",
        newMerkleData,
        previousMerkleData,
        currentDistribution.distribution,
        proposalId
      );
    })().catch(console.error);
  }
}



