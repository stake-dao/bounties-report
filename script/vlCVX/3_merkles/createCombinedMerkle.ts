import fs from "fs";
import path from "path";
import * as moment from "moment";
import * as dotenv from "dotenv";
dotenv.config();

import { mainnet } from "../../utils/chains";
import { createCombineDistribution } from "../../utils/merkle/merkle";
import { generateMerkleTree, mergeMerkleData } from "../utils";
import { MerkleData } from "../../interfaces/MerkleData";
import { CVX_SPACE, WEEK } from "../../utils/constants";
import { distributionVerifier } from "../../utils/merkle/distributionVerifier";
import { fetchLastProposalsIds } from "../../utils/snapshot";

// Round current UTC time down to the nearest week for the current period
const currentPeriodTimestamp = Math.floor(moment.utc().unix() / WEEK) * WEEK;

// Global variables to hold Merkle data for each gauge type and chain
let merkleDataByChain: {
  [chainId: string]: {
    curve?: MerkleData;
    fxn?: MerkleData;
  };
} = {};

// Define the two gauge types to process
const gaugeTypes = ["curve", "fxn"];

// Define all supported chain IDs
const supportedChainIds = ["1", "42161", "10", "8453", "137"];

/**
 * Main function: process all gauge types and then merge the Merkle data for each chain.
 */
async function main() {
  console.log("Running merkles generation...");

  // Check if merkle files already exist for this period
  const merkleFiles = [
    `bounties-reports/${currentPeriodTimestamp}/vlCVX/curve/merkle_data_non_delegators.json`,
    `bounties-reports/${currentPeriodTimestamp}/vlCVX/fxn/merkle_data_non_delegators.json`,
    `bounties-reports/${currentPeriodTimestamp}/vlCVX/vlcvx_merkle.json`
  ];
  
  const existingFiles = merkleFiles.filter(f => fs.existsSync(f));
  if (existingFiles.length > 0 && process.env.FORCE_UPDATE !== "true") {
    console.error(`⚠️  ERROR: Merkle files already exist for period ${currentPeriodTimestamp}`);
    console.error(`   Files found:`);
    existingFiles.forEach(f => console.error(`   - ${f}`));
    console.error(`   To force regeneration, run with FORCE_UPDATE=true`);
    process.exit(1);
  }

  // Initialize the merkle data structure for all chains
  supportedChainIds.forEach((chainId) => {
    merkleDataByChain[chainId] = {};
  });

  // Process each gauge type.
  for (const gaugeType of gaugeTypes) {
    processGaugeType(gaugeType);
  }

  // After processing, generate the global merkle for each chain.
  for (const chainId of supportedChainIds) {
    generateGlobalMerkleForChain(chainId);
  }
}

/**
 * Generates and saves a global merkle file for a specific chain by merging curve and fxn data if available.
 *
 * @param chainId - The chain identifier (e.g. "1", "42161")
 */
function generateGlobalMerkleForChain(chainId: string) {
  const chainData = merkleDataByChain[chainId];
  if (!chainData) {
    console.log(`No merkle data structure initialized for chain ${chainId}`);
    return;
  }

  // If both curve and fxn are available, merge them; otherwise, use whichever exists.
  let globalMerkle: MerkleData | undefined;
  if (chainData.curve && chainData.fxn) {
    globalMerkle = mergeMerkleData(chainData.curve, chainData.fxn);
    console.log(
      `Chain ${chainId}: Both gauge types available; merged global merkle data created.`
    );
  } else if (chainData.curve) {
    globalMerkle = chainData.curve;
    console.log(
      `Chain ${chainId}: Only curve merkle data available; using curve merkle data as global.`
    );
  } else if (chainData.fxn) {
    globalMerkle = chainData.fxn;
    console.log(
      `Chain ${chainId}: Only fxn merkle data available; using fxn merkle data as global.`
    );
  } else {
    console.log(`No merkle data available for chain ${chainId}.`);
    return;
  }

  if (globalMerkle) {
    const reportsDir = path.join(
      "bounties-reports",
      currentPeriodTimestamp.toString(),
      "vlCVX"
    );

    // Create the directory if it doesn't exist
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    // For Mainnet (chainId "1"), use "vlcvx_merkle.json"
    // For other chains, use "vlcvx_merkle_${chainId}.json"
    const outputName =
      chainId === "1" ? "vlcvx_merkle.json" : `vlcvx_merkle_${chainId}.json`;

    const outputPath = path.join(reportsDir, outputName);
    fs.writeFileSync(outputPath, JSON.stringify(globalMerkle, null, 2));
    console.log(
      `Global merkle for chain ${chainId} generated and saved as ${outputName}`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * Processes one gauge type (either "curve" or "fxn") by:
 * - Defining the output directory for the current period and gauge type.
 * - Processing Mainnet (chainId "1") and additional chains.
 *
 * @param gaugeType - "curve" or "fxn"
 */
function processGaugeType(gaugeType: string) {
  // Construct the base directory for the current period and gauge type.
  const reportsDir = path.join(
    "bounties-reports",
    currentPeriodTimestamp.toString(),
    "vlCVX",
    gaugeType
  );
  console.log(
    `\nProcessing gauge type "${gaugeType}" in directory ${reportsDir}`
  );

  // File paths for Mainnet (chainId "1")
  const NON_DELEGATORS_FILE = path.join(reportsDir, "repartition.json");
  const DELEGATION_FILE = path.join(reportsDir, "repartition_delegation.json");

  // Process Mainnet first
  processChain(
    gaugeType,
    "1",
    NON_DELEGATORS_FILE,
    DELEGATION_FILE,
    reportsDir
  );

  // Process additional chains
  const otherChainIds = ["42161", "10", "8453", "137"];
  for (const chainId of otherChainIds) {
    const nonDelegatorsFile = path.join(
      reportsDir,
      `repartition_${chainId}.json`
    );
    const delegationFile = path.join(
      reportsDir,
      `repartition_delegation_${chainId}.json`
    );
    processChain(
      gaugeType,
      chainId,
      nonDelegatorsFile,
      delegationFile,
      reportsDir
    );
  }
}

/**
 * Processes data for a given chain:
 * 1. Loads non-delegators data (if available) and builds a combined distribution.
 * 2. Merges in delegation-based distributions (if available).
 * 3. (For curve only on Mainnet) Reads forwarders' voted rewards from the weekly-bounties folder and adds them.
 * 4. Loads previous Merkle data from the previous week period folder (for this gauge type).
 * 5. Generates a new Merkle tree and saves it.
 * 6. Stores the resulting Merkle in the global merkleDataByChain structure.
 *
 * @param gaugeType - The gauge type ("curve" or "fxn")
 * @param chainId - The chain identifier (e.g. "1", "42161")
 * @param nonDelegatorsFilePath - Path to the non-delegators JSON file for the chain.
 * @param delegationFilePath - Path to the delegation JSON file for the chain.
 * @param reportsDir - The base directory for the current gauge type reports.
 */
function processChain(
  gaugeType: string,
  chainId: string,
  nonDelegatorsFilePath: string,
  delegationFilePath: string,
  reportsDir: string
) {
  console.log(`\nProcessing chain ${chainId} for gauge type "${gaugeType}"...`);

  const combined: {
    [address: string]: { tokens: { [token: string]: bigint } };
  } = {};

  // 1. Load non-delegators data (if the file exists)
  if (fs.existsSync(nonDelegatorsFilePath)) {
    const nonDelegatorsData = JSON.parse(
      fs.readFileSync(nonDelegatorsFilePath, "utf8")
    );
    const nonDelegators = nonDelegatorsData.distribution;
    for (const [address, data] of Object.entries(nonDelegators)) {
      const addr = address.toLowerCase();
      combined[addr] = { tokens: {} };
      if (data && typeof data === 'object' && 'tokens' in data) {
        const tokens = (data as any).tokens;
        for (const [token, amountStr] of Object.entries(tokens)) {
          combined[addr].tokens[token] = BigInt(amountStr as string);
        }
      }
    }
    console.log(`Loaded non-delegators data for chain ${chainId}`);
  } else {
    console.log(
      `No non-delegators file found for chain ${chainId}; continuing with delegation data only`
    );
  }

  // 2. Load delegation data (if available)
  let delegationSummary: any = null;
  if (fs.existsSync(delegationFilePath)) {
    const delegationData = JSON.parse(
      fs.readFileSync(delegationFilePath, "utf8")
    );
    delegationSummary = delegationData.distribution;
  } else {
    console.warn(
      `Delegation file not found for chain ${chainId}: ${delegationFilePath}. Using only non-delegators data.`
    );
  }

  // 3. Process delegation data (if it exists and is in the expected format)
  if (
    delegationSummary &&
    delegationSummary.totalTokens &&
    delegationSummary.totalNonForwardersShare !== undefined
  ) {
    const delegationTotalTokens = delegationSummary.totalTokens;
    const totalNonForwardersShare = parseFloat(
      delegationSummary.totalNonForwardersShare
    );

    // Build the delegation pool for tokens
    const delegationPool: { [token: string]: bigint } = {};
    if (totalNonForwardersShare > 0) {
      for (const [token, totalStr] of Object.entries(delegationTotalTokens)) {
        if (
          delegationSummary.totalPerGroup &&
          delegationSummary.totalPerGroup[token] &&
          delegationSummary.totalPerGroup[token].nonForwarders
        ) {
          delegationPool[token] = BigInt(
            delegationSummary.totalPerGroup[token].nonForwarders
          );
        } else {
          const total = BigInt(totalStr as string);
          delegationPool[token] = BigInt(
            Math.floor(Number(total) * totalNonForwardersShare)
          );
        }
      }
      console.log(`Delegation Non-Forwarders Pool for chain ${chainId}:`);
      for (const [token, pool] of Object.entries(delegationPool)) {
        console.log(`${token}: ${pool.toString()}`);
      }
    } else {
      console.warn(
        `No delegation non-forwarded rewards to add for chain ${chainId}.`
      );
    }

    // Distribute rewards from the delegation pool based on each address's share
    if (totalNonForwardersShare > 0 && delegationSummary.nonForwarders) {
      for (const [address, shareStr] of Object.entries(
        delegationSummary.nonForwarders
      )) {
        const share = parseFloat(shareStr as string);
        const rewardsForAddress: { [token: string]: bigint } = {};
        for (const [token, pool] of Object.entries(delegationPool)) {
          const reward = BigInt(Math.floor(share * Number(pool)));
          rewardsForAddress[token] = reward;
        }
        const addr = address.toLowerCase();
        if (combined[addr]) {
          for (const [token, reward] of Object.entries(rewardsForAddress)) {
            combined[addr].tokens[token] =
              (combined[addr].tokens[token] || 0n) + reward;
          }
        } else {
          combined[addr] = { tokens: rewardsForAddress };
        }
      }
    }
  } else {
    console.warn(
      `Delegation data for chain ${chainId} is not available or not in the expected format. Skipping delegation processing.`
    );
  }

  if (Object.keys(combined).length === 0) {
    console.log(`No distributions to process for chain ${chainId}`);
    return;
  }

  // 3. (On curve merkle) Log Votium forwarders' rewards but DO NOT distribute them
  if (gaugeType === "curve" && chainId === "1") {
    const votiumRewardsDir = path.join(
      "weekly-bounties",
      currentPeriodTimestamp.toString(),
      "votium"
    );
    
    // Create a log file for Votium forwarders info
    const logFilePath = path.join(
      reportsDir,
      "votium_forwarders_log.json"
    );
    
    const votiumLog: {
      timestamp: number;
      message: string;
      forwardersData?: any;
      totalRewardsSkipped?: { [token: string]: string };
      addressesSkipped?: string[];
    } = {
      timestamp: currentPeriodTimestamp,
      message: "Votium forwarders rewards are no longer distributed through merkle trees",
    };
    
    // Try to load actual claimed bounties first
    const claimedBountiesFile = path.join(
      votiumRewardsDir,
      "claimed_bounties_convex.json"
    );
    
    if (fs.existsSync(claimedBountiesFile)) {
      console.log("\n⚠️  NOTICE: Found Votium claimed bounties, but NOT distributing to forwarders");
      console.log("   File:", claimedBountiesFile);
      
      // Load forwarders data to log what would have been distributed
      const forwardersRewardsFile = path.join(
        votiumRewardsDir,
        "forwarders_voted_rewards.json"
      );
      
      if (fs.existsSync(forwardersRewardsFile)) {
        const forwardersData = JSON.parse(
          fs.readFileSync(forwardersRewardsFile, "utf8")
        );
        
        console.log("\n📊 Votium Forwarders Summary (NOT DISTRIBUTED):");
        console.log("   ═══════════════════════════════════════════");
        
        if (forwardersData.tokenAllocations) {
          const tokenAllocations = forwardersData.tokenAllocations;
          const totalsByToken: { [token: string]: bigint } = {};
          const uniqueAddresses = new Set<string>();
          
          // Calculate totals that would have been distributed
          for (const address in tokenAllocations) {
            uniqueAddresses.add(address.toLowerCase());
            
            for (const token in tokenAllocations[address]) {
              const tokenData = tokenAllocations[address][token];
              
              let amountStr: string;
              if (typeof tokenData === 'object' && tokenData.amountWei) {
                amountStr = tokenData.amountWei;
              } else if (typeof tokenData === 'object' && tokenData.amount) {
                amountStr = tokenData.amount;
              } else if (typeof tokenData === 'string') {
                amountStr = tokenData;
              } else {
                continue;
              }
              
              const amount = BigInt(amountStr.split('.')[0]);
              
              if (!totalsByToken[token]) {
                totalsByToken[token] = 0n;
              }
              totalsByToken[token] += amount;
            }
          }
          
          console.log(`   📍 Unique forwarders: ${uniqueAddresses.size}`);
          console.log(`   💰 Token totals that would have been distributed:`);
          
          for (const [token, total] of Object.entries(totalsByToken)) {
            console.log(`      • ${token}: ${total.toString()} wei`);
          }
          
          // Add to log
          votiumLog.forwardersData = forwardersData;
          votiumLog.totalRewardsSkipped = Object.fromEntries(
            Object.entries(totalsByToken).map(([k, v]) => [k, v.toString()])
          );
          votiumLog.addressesSkipped = Array.from(uniqueAddresses);
          
          console.log("\n   ℹ️  These rewards should be handled through a separate process");
          console.log("   ℹ️  Log saved to:", logFilePath);
        }
      } else {
        console.warn("   ⚠️  Forwarders rewards file not found");
      }
    } else {
      // Check if theoretical forwarders file exists
      const forwardersRewardsFile = path.join(
        votiumRewardsDir,
        "forwarders_voted_rewards.json"
      );
      
      if (fs.existsSync(forwardersRewardsFile)) {
        console.log("\n⚠️  NOTICE: Found theoretical Votium forwarders rewards, but NOT distributing");
        console.log("   File:", forwardersRewardsFile);
        
        const forwardersData = JSON.parse(
          fs.readFileSync(forwardersRewardsFile, "utf8")
        );
        
        if (forwardersData.tokenAllocations) {
          const tokenAllocations = forwardersData.tokenAllocations;
          const uniqueAddresses = Object.keys(tokenAllocations).length;
          
          console.log(`   📍 Would have distributed to ${uniqueAddresses} forwarders`);
          console.log("   ℹ️  These theoretical rewards are NOT being added to the merkle tree");
          
          votiumLog.forwardersData = { 
            tokenAllocations: tokenAllocations,
            source: "theoretical" 
          };
          votiumLog.addressesSkipped = Object.keys(tokenAllocations).map(a => a.toLowerCase());
        }
      } else {
        console.log("   ℹ️  No Votium forwarders rewards found for this period");
      }
    }
    
    // Save the log file
    fs.writeFileSync(logFilePath, JSON.stringify(votiumLog, null, 2));
    console.log("\n═══════════════════════════════════════════════════════════");
  }

  // 4. Load previous Merkle data from the previous week period folder (for this gauge type)
  const prevPeriodTimestamp = currentPeriodTimestamp - WEEK;
  const prevReportsDir = path.join(
    "bounties-reports",
    prevPeriodTimestamp.toString(),
    "vlCVX",
    gaugeType
  );
  const merkleFileName =
    chainId === "1"
      ? "merkle_data_non_delegators.json"
      : `merkle_data_non_delegators_${chainId}.json`;
  const previousMerkleDataPath = path.join(prevReportsDir, merkleFileName);
  console.log("previousMerkleDataPath", previousMerkleDataPath);

  let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
  if (fs.existsSync(previousMerkleDataPath)) {
    previousMerkleData = JSON.parse(
      fs.readFileSync(previousMerkleDataPath, "utf8")
    );
    console.log(
      `Loaded previous merkle data for chain ${chainId} from ${prevReportsDir}`
    );
  } else {
    console.log(
      `No previous merkle data found for chain ${chainId} in ${prevReportsDir}`
    );
  }

  // 5. Generate the new Merkle tree
  const currentDistribution = { distribution: combined };
  const universalMerkle = createCombineDistribution(
    currentDistribution,
    previousMerkleData
  );
  const newMerkleData: MerkleData = generateMerkleTree(universalMerkle);
  console.log(`Merkle Root for chain ${chainId}:`, newMerkleData.merkleRoot);

  // 6. Save the new Merkle data to the same reports directory
  const outputName =
    chainId === "1"
      ? "merkle_data_non_delegators.json"
      : `merkle_data_non_delegators_${chainId}.json`;
  const outputPath = path.join(reportsDir, outputName);
  fs.writeFileSync(outputPath, JSON.stringify(newMerkleData, null, 2));
  console.log(
    `Merkle tree for chain ${chainId} generated and saved as ${outputName}`
  );

  // 7. Store the merkle data in the global structure
  if (merkleDataByChain[chainId]) {
    merkleDataByChain[chainId][gaugeType as "curve" | "fxn"] = newMerkleData;
    console.log(
      `Stored ${gaugeType} merkle data for chain ${chainId} in global structure`
    );
  }

  const filter =
    gaugeType === "fxn"
      ? "^FXN.*Gauge Weight for Week of"
      : "^(?!FXN ).*Gauge Weight for Week of";
  const now = Math.floor(Date.now() / 1000);
  (async () => {
    const proposalIdPerSpace = await fetchLastProposalsIds(
      [CVX_SPACE],
      now,
      filter
    );
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
