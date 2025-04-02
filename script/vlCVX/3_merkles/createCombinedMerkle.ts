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
import { CVX_SPACE, SDT, TWOWEEKS, WEEK } from "../../utils/constants";
import { distributionVerifier } from "../../utils/distributionVerifier";
import { fetchLastProposalsIds, getProposal } from "../../utils/snapshot";

// Round current UTC time down to the nearest week to get the current period timestamp
const currentPeriodTimestamp = Math.floor(moment.utc().unix() / WEEK) * WEEK;

const currentVotiumPeriod = Math.floor(moment.utc().unix() / TWOWEEKS) * TWOWEEKS;


// Construct the directory path for this week's bounties reports
const reportsDir = path.join(
  "bounties-reports",
  currentPeriodTimestamp.toString(),
  "vlCVX"
);

// Mainnet files that hold non-delegator and delegator data
const NON_DELEGATORS_FILE = path.join(reportsDir, "repartition.json");
const DELEGATION_FILE = path.join(reportsDir, "repartition_delegation.json");

// Process Mainnet first (chainId "1")
processChain("1", NON_DELEGATORS_FILE, DELEGATION_FILE);

// Process other chains
const otherChainIds = ["42161", "10", "8453", "137"];
for (const chainId of otherChainIds) {
  // The "nonDelegatorsFile" for these chains (if it exists) is named "repartition_{chainId}.json"
  const nonDelegatorsFile = path.join(
    reportsDir,
    `repartition_${chainId}.json`
  );
  // The "delegationFile" for these chains is named "repartition_delegation_{chainId}.json"
  const delegationFile = path.join(
    reportsDir,
    `repartition_delegation_${chainId}.json`
  );

  // Only process if a delegation file exists for that chain
  processChain(chainId, nonDelegatorsFile, delegationFile);
}

/**
 * Processes data for a single chain:
 * 1. Loads non-delegators file (if it exists) and adds it to a combined distribution map.
 * 2. Merges that data with delegation-based distributions.
 * 3. Creates or updates a Merkle tree with the new distribution.
 * 4. Saves out a new Merkle file and (for mainnet) runs the distribution verifier.
 *
 * @param chainId - the chain identifier as a string ("1", "42161", etc.)
 * @param nonDelegatorsFilePath - path to the chain's non-delegators JSON file
 * @param delegationFilePath - path to the chain's delegation JSON file
 */
function processChain(
  chainId: string,
  nonDelegatorsFilePath: string,
  delegationFilePath: string
) {
  console.log(`\nProcessing chain ${chainId}...`);

  const combined: {
    [address: string]: { tokens: { [token: string]: bigint } };
  } = {};

  // 1. Load NON-DELEGATORS data (if available)
  if (fs.existsSync(nonDelegatorsFilePath)) {
    const nonDelegatorsData = JSON.parse(
      fs.readFileSync(nonDelegatorsFilePath, "utf8")
    );
    const nonDelegators = nonDelegatorsData.distribution;

    // Add each address's distribution to our combined structure
    for (const [address, data] of Object.entries(nonDelegators)) {
      const addr = address.toLowerCase();
      combined[addr] = { tokens: {} };
      for (const [token, amountStr] of Object.entries(data.tokens)) {
        combined[addr].tokens[token] = BigInt(amountStr);
      }
    }
    console.log(`Loaded non-delegators data for chain ${chainId}`);
  } else {
    console.log(
      `No non-delegators file found for chain ${chainId}, continuing with delegation data only`
    );
  }

  // 2. Load DELEGATION data (if available and in the expected format)
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

  // Process delegation data only if it's available and properly formatted
  if (
    delegationSummary &&
    delegationSummary.totalTokens &&
    delegationSummary.totalNonForwardersShare !== undefined
  ) {
    const delegationTotalTokens = delegationSummary.totalTokens;
    const totalNonForwardersShare = parseFloat(
      delegationSummary.totalNonForwardersShare
    );

    // 3. Build a pool for tokens to be distributed based on "non-forwarders" share
    const delegationPool: { [token: string]: bigint } = {};
    if (totalNonForwardersShare > 0) {
      for (const [token, totalStr] of Object.entries(delegationTotalTokens)) {
        // Use token-specific "nonForwarders" amounts if available
        if (
          delegationSummary.totalPerGroup &&
          delegationSummary.totalPerGroup[token] &&
          delegationSummary.totalPerGroup[token].nonForwarders
        ) {
          delegationPool[token] = BigInt(
            delegationSummary.totalPerGroup[token].nonForwarders
          );
        } else {
          // Fallback to a calculation multiplying total by share
          const total = BigInt(totalStr);
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

    // 4. Distribute tokens from that pool to each address based on their share
    if (totalNonForwardersShare > 0 && delegationSummary.nonForwarders) {
      for (const [address, shareStr] of Object.entries(
        delegationSummary.nonForwarders
      )) {
        const share = parseFloat(shareStr);

        // Calculate each address's reward for each token as their share of the pool
        const rewardsForAddress: { [token: string]: bigint } = {};
        for (const [token, pool] of Object.entries(delegationPool)) {
          const reward = BigInt(Math.floor(share * Number(pool)));
          rewardsForAddress[token] = reward;
        }

        // Merge these rewards into the combined structure
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

  // If no addresses exist in "combined", then there's nothing to process
  if (Object.keys(combined).length === 0) {
    console.log(`No distributions to process for chain ${chainId}`);
    return;
  }

  // 5. Load previous Merkle data and generate a new tree
  const merkleFileName =
    chainId === "1" ? "vlcvx_merkle.json" : `vlcvx_merkle_${chainId}.json`;

  const previousMerkleDataPath = path.join(
    "bounties-reports",
    "latest",
    "vlCVX",
    merkleFileName
  );

  let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
  if (fs.existsSync(previousMerkleDataPath)) {
    previousMerkleData = JSON.parse(
      fs.readFileSync(previousMerkleDataPath, "utf8")
    );
    console.log(
      `Loaded previous merkle data for chain ${chainId} from latest directory`
    );
  } else {
    console.log(
      `No previous merkle data found for chain ${chainId} in latest directory`
    );
  }

  // Generate the new Merkle tree
  const currentDistribution = { distribution: combined };
  const universalMerkle = createCombineDistribution(
    currentDistribution,
    previousMerkleData
  );
  const newMerkleData: MerkleData = generateMerkleTree(universalMerkle);

  // Add rewards from Votium forwarders which voted themselves
  // TODO

  console.log(`Merkle Root for chain ${chainId}:`, newMerkleData.merkleRoot);

  // Save the new Merkle data
  const outputName =
    chainId === "1"
      ? "merkle_data_non_delegators.json"
      : `merkle_data_non_delegators_${chainId}.json`;
  const outputPath = path.join(reportsDir, outputName);
  fs.writeFileSync(outputPath, JSON.stringify(newMerkleData, null, 2));
  console.log(
    `Merkle tree for chain ${chainId} generated and saved as ${outputName}`
  );

  // Run the distribution verifier for Mainnet
  if (chainId === "1") {
    const filter = "^(?!FXN ).*Gauge Weight for Week of";
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
}
