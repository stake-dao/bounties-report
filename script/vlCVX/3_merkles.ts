/**
 * vlCVX Merkle Tree Generation Script
 *
 * This script generates Merkle trees for both delegators and regular voters of vlCVX (claimed through Votemarket).
 * For delegators, it calculates the distribution of crvUSD + SDT tokens based on their shares on delegation.
 * For regular voters, it processes distributions across multiple chains (Ethereum, Arbitrum, Optimism, etc.).
 *
 * The script performs the following main steps:
 * 1. For delegators:
 *    - Retrieves the CRVUSD + SDT transfer data and calculates token shares based on the delegation shares
 *    - Generates a single Merkle tree based on calculated crvUSD + SDT amounts
 *    - Saves the merkle tree as merkle_data_delegators.json -> Pending until set root (then copied in latest)
 *
 * 2. For regular voters (non-delegators):
 *    - Detects available chains from distribution files (repartition_[chainId].json)
 *    - For each chain (including Ethereum mainnet):
 *      - Loads chain-specific distribution data
 *      - Generates a separate Merkle tree for that chain
 *      - Saves as merkle_data_non_delegators_[chainId].json (or merkle_data_non_delegators.json for mainnet) -> Pending until set root (then copied in latest)
 *
 * Usage:
 * - For delegators: pnpm tsx script/vlCVX/3_merkles.ts --delegators
 * - For non-delegators: pnpm tsx script/vlCVX/3_merkles.ts
 */
import fs from "fs";
import path from "path";
import { createPublicClient, http, getAddress, Chain } from "viem";
import { mainnet, arbitrum, optimism, base, polygon } from "viem/chains";
import { getCRVUsdTransfer, generateMerkleTree } from "./utils";
import { getClosestBlockTimestamp } from "../utils/chainUtils";
import { CRVUSD, DELEGATION_ADDRESS, SDT } from "../utils/constants";
import { MerkleData } from "../interfaces/MerkleData";
import { DelegationDistribution } from "../interfaces/DelegationDistribution";
import { createCombineDistribution } from "../utils/merkle";
import { fetchTokenInfos } from "../utils/tokens";

const IGNORED_TOKENS = [
  "0xd9879d9dbdc5042d8f1c2710be293909b985dc90", // reYWA (vested)
].map((token) => token.toLowerCase());

interface Distribution {
  [address: string]: {
    tokens: {
      [tokenAddress: string]: bigint;
    };
  };
}

/**
 * Verifies and adjusts token balances against actual Botmarket balances
 * Returns adjusted distribution if needed
 */
async function checkDistribution(
  distribution: Distribution
): Promise<Distribution> {
  console.log("\nChecking Botmarket balances:");

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http("https://rpc.flashbots.net"),
  });

  // Get unique token addresses from the distribution
  const tokenAddresses = new Set<string>();
  Object.values(distribution).forEach((data) => {
    Object.keys(data.tokens).forEach((tokenAddress) =>
      tokenAddresses.add(tokenAddress)
    );
  });

  for (const tokenAddress of tokenAddresses) {
    // Skip ZUN token check
    if (
      tokenAddress.toLowerCase() ===
      "0x6b5204b0be36771253cc38e88012e02b752f0f36".toLowerCase()
    ) {
      continue;
    }

    // Calculate total expected amount for this token
    const totalExpected = Object.values(distribution).reduce((acc, data) => {
      return (
        acc +
        (data.tokens[tokenAddress] ? BigInt(data.tokens[tokenAddress]) : 0n)
      );
    }, 0n);

    if (totalExpected === 0n) continue;

    // Get actual balance from Botmarket
    const botmarketBalance = await publicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: [
        {
          name: "balanceOf",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
      ],
      functionName: "balanceOf",
      args: ["0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF" as `0x${string}`],
    });

    // Compare and adjust if needed
    if (botmarketBalance !== totalExpected) {
      console.log(`\nToken ${tokenAddress}:`);
      console.log(`Expected: ${totalExpected}`);
      console.log(`Actual: ${botmarketBalance}`);
      console.log(`Difference: ${botmarketBalance - totalExpected}`);

      // Adjust distribution if actual balance is lower
      if (botmarketBalance < totalExpected) {
        const ratio = Number(botmarketBalance) / Number(totalExpected);
        console.log(`Adjusting amounts by ratio: ${ratio}`);

        Object.values(distribution).forEach((data) => {
          if (data.tokens[tokenAddress]) {
            data.tokens[tokenAddress] = BigInt(
              Math.floor(Number(data.tokens[tokenAddress]) * ratio)
            );
          }
        });
      }
    }
  }

  return distribution;
}

/**
 * Generates Merkle tree for delegators based on their sdCRV allocation
 */
async function generateDelegatorMerkleTree(
  minBlock: number,
  maxBlock: number,
  delegationDistribution: DelegationDistribution | null,
  previousMerkleData: MerkleData
): Promise<MerkleData> {
  if (
    !delegationDistribution ||
    Object.keys(delegationDistribution).length === 0
  ) {
    console.log(
      "No delegation distribution found. Using previous merkle data."
    );
    return previousMerkleData;
  }

  // Find delegators with shares
  const delegators = Object.entries(delegationDistribution).filter(
    ([_, data]) => data.share
  );

  if (delegators.length === 0) {
    console.log(
      "No delegators found in distribution. Using previous merkle data."
    );
    return previousMerkleData;
  }

  // Get total crvUsd transfer amount
  const crvUsdTransfer = await getCRVUsdTransfer(minBlock, maxBlock);
  let totalCrvUsd = crvUsdTransfer.amount;

  // Remove worth 0.00001 of crvUSD from totalCrvUsd (for round issues)
  totalCrvUsd -= BigInt(10 ** 14);

  // Add SDT (5k)
  let totalSDT = 5000n * BigInt(10 ** 18);

  // Remove worth 0.00001 of sdt from totalSDT (for round issues)
  totalSDT -= BigInt(10 ** 14);

  let totalSDTOut = 0n; // SDT after skipping certain users

  const skippedUsers = new Set([
    getAddress("0xe001452BeC9e7AC34CA4ecaC56e7e95eD9C9aa3b"), // Bent
  ]);

  console.log("Total crvUsd for distribution:", totalCrvUsd.toString());
  console.log("Total SDT for distribution:", totalSDT.toString());

  const distribution: Distribution = {};

  let totalValidShares = 0;

  // First pass: Calculate crvUsd and sdt amounts for each delegator
  delegators.forEach(([address, data]) => {
    const normalizedAddress = getAddress(address);
    const share = parseFloat(data.share!);

    if (share <= 0) return; // Ignore invalid shares

    const crvUsdAmount =
      (totalCrvUsd * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);
    let sdtAmount =
      (totalSDT * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);

    totalValidShares += share;

    if (skippedUsers.has(normalizedAddress)) {
      totalSDTOut += sdtAmount; // Accumulate skipped users' SDT share
      sdtAmount = 0n;
      totalValidShares -= share;
    }

    if (crvUsdAmount > 0n || sdtAmount > 0n) {
      distribution[normalizedAddress] = {
        tokens: {
          [CRVUSD]: crvUsdAmount,
          [SDT]: sdtAmount,
        },
      };
    }
  });

  // Second pass: Redistribute leftover SDT
  if (totalSDTOut > 0n) {
    delegators.forEach(([address, data]) => {
      const normalizedAddress = getAddress(address);
      const share = parseFloat(data.share!);

      if (share <= 0) return; // Ignore invalid shares
      if (skippedUsers.has(normalizedAddress)) return;

      const sdtAmount = (totalSDTOut * BigInt(Math.floor(share * 1e18))) / BigInt(Math.floor(totalValidShares * 1e18));
      distribution[normalizedAddress].tokens[SDT] += sdtAmount;
    });
  }

  return generateMerkleTree(
    createCombineDistribution({ distribution }, previousMerkleData)
  );
}

/**
 * Compares new and previous merkle data distributions
 */
function compareMerkleData(
  title: string,
  newMerkle: MerkleData,
  previousMerkle: MerkleData,
  tokenInfo: { [address: string]: { symbol: string; decimals: number } }
) {
  console.log(`\n=== ${title} ===`);

  // Collect all tokens from both merkles
  const tokens = new Set<string>();
  [newMerkle.claims, previousMerkle.claims].forEach((claims) => {
    Object.values(claims).forEach((claim) => {
      if (claim.tokens) {
        Object.keys(claim.tokens).forEach((token) =>
          tokens.add(token.toLowerCase())
        );
      }
    });
  });

  // Compare distributions for each token
  tokens.forEach((token) => {
    const info = Object.entries(tokenInfo).find(
      ([addr, _]) => addr.toLowerCase() === token
    )?.[1] || { symbol: "UNKNOWN", decimals: 18 };

    // Calculate totals
    const newTotal = Object.values(newMerkle.claims).reduce((acc, claim) => {
      const amount =
        claim.tokens?.[token]?.amount ||
        claim.tokens?.[getAddress(token)]?.amount ||
        "0";
      return acc + BigInt(amount);
    }, 0n);

    const prevTotal = Object.values(previousMerkle.claims).reduce(
      (acc, claim) => {
        const amount =
          claim.tokens?.[token]?.amount ||
          claim.tokens?.[getAddress(token)]?.amount ||
          "0";
        return acc + BigInt(amount);
      },
      0n
    );

    const newTotalFormatted = Number(newTotal) / 10 ** info.decimals;
    const prevTotalFormatted = Number(prevTotal) / 10 ** info.decimals;
    const diffTotal = newTotalFormatted - prevTotalFormatted;

    console.log(`\n--- ${info.symbol} Distribution ---`);
    console.log(
      `Previous Total: ${prevTotalFormatted.toFixed(2)} ${info.symbol}`
    );
    console.log(`New Total: ${newTotalFormatted.toFixed(2)} ${info.symbol}`);
    console.log(
      `Difference: ${diffTotal > 0 ? "+" : ""}${diffTotal.toFixed(2)} ${
        info.symbol
      }`
    );

    if (newTotal > 0n || prevTotal > 0n) {
      console.log("\nSorted users:");

      // Get all addresses and their amounts
      const addresses = new Set([
        ...Object.keys(newMerkle.claims),
        ...Object.keys(previousMerkle.claims),
      ]);

      const holders = Array.from(addresses).map((address) => {
        const newAmount = BigInt(
          newMerkle.claims[address]?.tokens?.[token]?.amount ||
            newMerkle.claims[address]?.tokens?.[getAddress(token)]?.amount ||
            "0"
        );
        const prevAmount = BigInt(
          previousMerkle.claims[address]?.tokens?.[token]?.amount ||
            previousMerkle.claims[address]?.tokens?.[getAddress(token)]
              ?.amount ||
            "0"
        );
        return {
          address,
          newAmount,
          prevAmount,
          share: Number((newAmount * 10000n) / (newTotal || 1n)) / 100,
        };
      });

      // Sort and display significant holders
      holders
        .sort((a, b) => Number(b.newAmount - a.newAmount))
        .filter((holder) => Number(holder.newAmount) > 0)
        .forEach((holder) => {
          const newAmountFormatted =
            Number(holder.newAmount) / 10 ** info.decimals;
          const prevAmountFormatted =
            Number(holder.prevAmount) / 10 ** info.decimals;
          const diff = newAmountFormatted - prevAmountFormatted;

          const addressDisplay =
            holder.address === DELEGATION_ADDRESS
              ? "STAKE DELEGATION (0x52ea...)"
              : `${holder.address.slice(0, 6)}...${holder.address.slice(-4)}`;

          let diffStr = "";
          if (diff !== 0) {
            const diffPercentage =
              (diff / (newTotalFormatted - prevTotalFormatted)) * 100;
            diffStr = ` (+${diff.toFixed(2)} - ${diffPercentage.toFixed(1)}%)`;
          }

          console.log(
            `${addressDisplay}: ${holder.share.toFixed(
              2
            )}% - ${newAmountFormatted.toFixed(2)}${diffStr} ${info.symbol}`
          );
        });
    }
  });
}

/**
 * Gets available chain IDs from distribution files in the current period
 */
async function getAvailableChains(
  currentPeriodTimestamp: number
): Promise<string[]> {
  const dirPath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/vlCVX`
  );
  
  // Check if directory exists, if not return empty array
  if (!fs.existsSync(dirPath)) {
    console.log(`Directory does not exist: ${dirPath}`);
    return [];
  }
  
  const files = fs.readdirSync(dirPath);

  // Find all repartition files with chain IDs
  const chainFiles = files.filter(
    (file) =>
      file.startsWith("repartition_") &&
      file.endsWith(".json") &&
      !file.includes("delegation") // Exclude delegation file
  );

  // Extract chain IDs from filenames
  return chainFiles
    .map((file) => {
      const match = file.match(/repartition_(\d+)\.json/);
      return match ? match[1] : null;
    })
    .filter((chainId): chainId is string => chainId !== null);
}

/**
 * Main function to generate merkle trees
 */
async function generateMerkles(generateDelegatorsMerkle: boolean = false) {
  // Calculate period timestamps
  const WEEK = 604800;
  const currentPeriodTimestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;
  
  // Ensure the directory structure exists
  const currentPeriodDir = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/vlCVX`
  );
  
  if (!fs.existsSync(currentPeriodDir)) {
    console.log(`Creating directory structure: ${currentPeriodDir}`);
    fs.mkdirSync(currentPeriodDir, { recursive: true });
    console.log("Directory created. No distribution files found, exiting.");
    return;
  }

  if (generateDelegatorsMerkle) {
    // Handle delegators merkle tree generation
    const chain = mainnet;
    const publicClient = createPublicClient({
      chain,
      transport: http("https://rpc.flashbots.net"),
    });

    // Get block numbers
    const currentBlock = Number(await publicClient.getBlockNumber());
    const minBlock = await getClosestBlockTimestamp(
      "ethereum",
      currentPeriodTimestamp
    );

    // Load appropriate distribution file
    const distributionFileName = "repartition_delegation.json";
    const currentDistributionPath = path.join(
      __dirname,
      `../../bounties-reports/${currentPeriodTimestamp}/vlCVX/${distributionFileName}`
    );

    // Load and parse distribution
    const currentDistribution: { distribution: Distribution } = JSON.parse(
      fs.readFileSync(currentDistributionPath, "utf-8")
    );

    // Load previous merkle data
    const merkleFileName = "merkle_data_delegators.json";
    const previousMerkleDataPath = path.join(
      __dirname,
      `../../bounties-reports/${
        currentPeriodTimestamp - WEEK
      }/vlCVX/${merkleFileName}`
    );

    let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
    if (fs.existsSync(previousMerkleDataPath)) {
      previousMerkleData = JSON.parse(
        fs.readFileSync(previousMerkleDataPath, "utf-8")
      );
    }

    // Generate delegator merkle tree
    const merkleData = await generateDelegatorMerkleTree(
      minBlock,
      currentBlock,
      currentDistribution.distribution,
      previousMerkleData
    );

    // Save merkle data
    const outputPath = path.join(
      __dirname,
      `../../bounties-reports/${currentPeriodTimestamp}/vlCVX/${merkleFileName}`
    );

    // Ensure addresses are checksummed
    merkleData.claims = Object.fromEntries(
      Object.entries(merkleData.claims).map(([address, claim]) => [
        getAddress(address),
        claim,
      ])
    );

    const tokenInfo = await fetchTokenInfos(
      merkleData,
      previousMerkleData,
      chain
    );

    // Compare merkle data
    compareMerkleData("Delegator", merkleData, previousMerkleData, tokenInfo);

    // Save to current period directory
    fs.writeFileSync(outputPath, JSON.stringify(merkleData, null, 2));

    console.log("Delegator Merkle tree generated and saved successfully.");
  } else {
    // Handle non-delegators merkle trees for all chains
    const chains = await getAvailableChains(currentPeriodTimestamp);
    console.log(`Found distribution files for chains: ${chains.join(", ")}`);

    // Generate merkle tree for mainnet (default)
    await generateSingleMerkle(currentPeriodTimestamp, mainnet);

    // Generate merkle trees for other chains
    for (const chainId of chains) {
      let chain: Chain;
      switch (chainId) {
        case "42161":
          chain = arbitrum;
          break;
        case "10":
          chain = optimism;
          break;
        case "8453":
          chain = base;
          break;
        case "137":
          chain = polygon;
          break;
        default:
          console.log(`Skipping unknown chain ID: ${chainId}`);
          continue;
      }

      await generateSingleMerkle(currentPeriodTimestamp, chain, chainId);
    }
  }
}

/**
 * Generates merkle tree for a single chain
 */
async function generateSingleMerkle(
  currentPeriodTimestamp: number,
  chain: Chain,
  chainId?: string
) {
  const publicClient = createPublicClient({
    chain,
    transport: http("https://rpc.flashbots.net"),
  });

  const WEEK = 604800;
  const prevWeekTimestamp = currentPeriodTimestamp - WEEK;

  // Get block numbers
  const currentBlock = Number(await publicClient.getBlockNumber());
  const minBlock = await getClosestBlockTimestamp(
    "ethereum",
    currentPeriodTimestamp
  );

  // Load appropriate distribution file
  const distributionFileName = chainId
    ? `repartition_${chainId}.json`
    : "repartition.json";

  const currentDistributionPath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/vlCVX/${distributionFileName}`
  );

  // Load and parse distribution
  const currentDistribution: { distribution: Distribution } = JSON.parse(
    fs.readFileSync(currentDistributionPath, "utf-8")
  );

  // Load previous merkle data
  const merkleFileName = chainId
    ? `merkle_data_non_delegators_${chainId}.json`
    : "merkle_data_non_delegators.json";

  const previousMerkleDataPath = path.join(
    __dirname,
    `../../bounties-reports/${prevWeekTimestamp}/vlCVX/${merkleFileName}`
  );

  let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
  if (fs.existsSync(previousMerkleDataPath)) {
    previousMerkleData = JSON.parse(
      fs.readFileSync(previousMerkleDataPath, "utf-8")
    );
  }

  // Filter out ignored tokens
  const filteredDistribution = Object.fromEntries(
    Object.entries(currentDistribution.distribution).filter(([_, data]) => {
      return !IGNORED_TOKENS.some((token) => data.tokens[token]);
    })
  ) as Distribution;

  // Generate merkle tree
  const merkleData = generateMerkleTree(
    createCombineDistribution(
      { distribution: filteredDistribution },
      previousMerkleData
    )
  );

  // Save merkle data
  const outputPath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/vlCVX/${merkleFileName}`
  );

  // Ensure addresses are checksummed
  merkleData.claims = Object.fromEntries(
    Object.entries(merkleData.claims).map(([address, claim]) => [
      getAddress(address),
      claim,
    ])
  );

  const tokenInfo = await fetchTokenInfos(
    merkleData,
    previousMerkleData,
    chain
  );

  // TODO: As sdTokens, logFile + sended to Telegram (use distributionVerifier)
  // Compare merkle data
  compareMerkleData(
    chainId ? `Non-delegator (Chain ${chainId})` : "Non-delegator",
    merkleData,
    previousMerkleData,
    tokenInfo
  );

  // Save to current period directory
  fs.writeFileSync(outputPath, JSON.stringify(merkleData, null, 2));

  console.log(
    `Merkle tree generated and saved successfully for ${
      chainId ? `chain ${chainId}` : "mainnet"
    }`
  );
}

/**
 * Script entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const generateDelegatorsMerkle =
    args.includes("--delegators") || args.includes("-d");

  try {
    await generateMerkles(generateDelegatorsMerkle);
  } catch (error) {
    console.error("Error generating merkle trees:", error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}