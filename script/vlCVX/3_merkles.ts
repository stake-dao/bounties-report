/**
 * vlCVX Merkle Tree Generation Script
 *
 * This script generates Merkle trees for both delegators and regular voters of vlCVX (claimed through Votemarket).
 * It calculates the distribution of sdCRV tokens for delegators based on their normal tokens distribution
 * For regular voters, it uses the existing token distribution data.
 *
 * The script performs the following main steps:
 * 1. Retrieves the sdCRV transfer data and calculates token shares for delegators
 * 2. Generates a Merkle tree for delegators based on their calculated sdCRV amounts
 * 3. Generates a Merkle tree for regular voters based on the distribution data
 * 4. Saves merkle trees separately for delegators and non-delegators
 */

import fs from "fs";
import path from "path";
import { createPublicClient, http, getAddress } from "viem";
import { mainnet } from "viem/chains";
import { getCRVUsdTransfer, generateMerkleTree } from "./utils";
import { getClosestBlockTimestamp } from "../utils/chainUtils";
import { DELEGATION_ADDRESS } from "../utils/constants";
import { MerkleData } from "../interfaces/MerkleData";
import { DelegationDistribution } from "../interfaces/DelegationDistribution";

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
  const totalCrvUsd = crvUsdTransfer.amount;

  console.log("Total crvUsd for distribution:", totalCrvUsd.toString());

  // Calculate sdCRV amounts for delegators
  const delegatorDistribution: {
    [address: string]: { [tokenAddress: string]: string };
  } = {};

  delegators.forEach(([address, data]) => {
    const normalizedAddress = getAddress(address);
    const share = parseFloat(data.share!);
    const crvUsdAmount =
      (totalCrvUsd * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);

    if (crvUsdAmount > 0n) {
      delegatorDistribution[normalizedAddress] = {
        [getAddress("0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E")]:
          crvUsdAmount.toString(),
      };
    }
  });

  // Merge with previous merkle data
  if (previousMerkleData && previousMerkleData.claims) {
    Object.entries(previousMerkleData.claims).forEach(
      ([address, claimData]: [string, any]) => {
        const normalizedAddress = getAddress(address);

        if (!delegatorDistribution[normalizedAddress]) {
          delegatorDistribution[normalizedAddress] = {};
        }

        if (claimData && claimData.tokens) {
          Object.entries(claimData.tokens).forEach(
            ([tokenAddress, tokenData]: [string, any]) => {
              const normalizedTokenAddress = getAddress(tokenAddress);

              if (tokenData && tokenData.amount) {
                if (
                  !delegatorDistribution[normalizedAddress][
                    normalizedTokenAddress
                  ]
                ) {
                  delegatorDistribution[normalizedAddress][
                    normalizedTokenAddress
                  ] = "0";
                }
                const previousAmount = BigInt(tokenData.amount);
                const currentAmount = BigInt(
                  delegatorDistribution[normalizedAddress][
                    normalizedTokenAddress
                  ]
                );
                delegatorDistribution[normalizedAddress][
                  normalizedTokenAddress
                ] = (previousAmount + currentAmount).toString();
              }
            }
          );
        }
      }
    );
  }

  return generateMerkleTree(delegatorDistribution);
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
 * Main function to generate merkle trees
 */
async function generateMerkles(generateDelegatorsMerkle: boolean = false) {
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http("https://rpc.flashbots.net"),
  });

  // Calculate period timestamps
  const WEEK = 604800;
  const currentPeriodTimestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;
  const prevWeekTimestamp = currentPeriodTimestamp - WEEK;

  // Get block numbers
  const currentBlock = Number(await publicClient.getBlockNumber());
  const minBlock = await getClosestBlockTimestamp(
    "ethereum",
    currentPeriodTimestamp
  );

  // Load appropriate distribution file
  const distributionFileName = generateDelegatorsMerkle
    ? "repartition_delegation.json"
    : "repartition.json";
  const currentDistributionPath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/vlCVX/${distributionFileName}`
  );

  // Load and parse distribution
  const currentDistribution : { distribution: Distribution } = JSON.parse(
    fs.readFileSync(currentDistributionPath, "utf-8")
  );

  // Load previous merkle data
  const merkleFileName = generateDelegatorsMerkle
    ? "merkle_data_delegators.json"
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

  let merkleData: MerkleData;
  if (generateDelegatorsMerkle) {
    // Generate delegator merkle tree
    merkleData = await generateDelegatorMerkleTree(
      minBlock,
      currentBlock,
      currentDistribution.distribution,
      previousMerkleData
    );
  } else {
    // TODO : A function like for delegators
    // Process non-delegator distribution
    let distribution = currentDistribution.distribution;
    distribution = await checkDistribution(distribution);

    // Convert distribution to merkle format
    const merkleDistribution = Object.entries(distribution).reduce(
      (acc, [address, data]) => {
        acc[address] = Object.entries(data.tokens).reduce(
          (tokenAcc, [tokenAddress, amount]) => {
            tokenAcc[tokenAddress] = amount.toString();
            return tokenAcc;
          },
          {} as { [tokenAddress: string]: string }
        );
        return acc;
      },
      {} as { [address: string]: { [tokenAddress: string]: string } }
    );

    // First normalize the merkleDistribution addresses
    const normalizedMerkleDistribution: {
      [address: string]: { [tokenAddress: string]: string };
    } = {};

    // Normalize the new distribution first
    Object.entries(merkleDistribution).forEach(([address, tokens]) => {
      const normalizedAddress = getAddress(address);
      normalizedMerkleDistribution[normalizedAddress] = {};

      // Normalize and merge token amounts for the same address
      Object.entries(tokens).forEach(([tokenAddress, amount]) => {
        const normalizedTokenAddress = getAddress(tokenAddress);
        const currentAmount = BigInt(
          normalizedMerkleDistribution[normalizedAddress][
            normalizedTokenAddress
          ] || "0"
        );
        const newAmount = BigInt(amount);
        normalizedMerkleDistribution[normalizedAddress][
          normalizedTokenAddress
        ] = (currentAmount + newAmount).toString();
      });
    });

    // Then merge with previous merkle data
    if (previousMerkleData && previousMerkleData.claims) {
      Object.entries(previousMerkleData.claims).forEach(
        ([address, claimData]) => {
          const normalizedAddress = getAddress(address);

          if (!normalizedMerkleDistribution[normalizedAddress]) {
            normalizedMerkleDistribution[normalizedAddress] = {};
          }

          if (claimData && claimData.tokens) {
            Object.entries(claimData.tokens).forEach(
              ([tokenAddress, tokenData]: [string, any]) => {
                const normalizedTokenAddress = getAddress(tokenAddress);
                const prevAmount = BigInt(tokenData.amount || "0");
                const currentAmount = BigInt(
                  normalizedMerkleDistribution[normalizedAddress][
                    normalizedTokenAddress
                  ] || "0"
                );

                normalizedMerkleDistribution[normalizedAddress][
                  normalizedTokenAddress
                ] = (prevAmount + currentAmount).toString();
              }
            );
          }
        }
      );
    }

    merkleData = generateMerkleTree(normalizedMerkleDistribution);
  }

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

  // Tokens infos (for checks)
  const rewardTokenAddresses = new Set<string>();

  for (const address in merkleData.claims) {
    const tokens = Object.keys(merkleData.claims[address].tokens);
    tokens.forEach((token) => rewardTokenAddresses.add(token));
  }

  const tokenInfoArray = await Promise.allSettled(
    Array.from(rewardTokenAddresses).map(async (tokenAddress) => {
      const address = getAddress(tokenAddress.toLowerCase());
      try {
        const [symbol, decimals] = await Promise.all([
          publicClient.readContract({
            address,
            abi: [
              {
                inputs: [],
                name: "symbol",
                outputs: [{ type: "string" }],
                stateMutability: "view",
                type: "function",
              },
            ],
            functionName: "symbol",
          }),
          publicClient.readContract({
            address,
            abi: [
              {
                inputs: [],
                name: "decimals",
                outputs: [{ type: "uint8" }],
                stateMutability: "view",
                type: "function",
              },
            ],
            functionName: "decimals",
          }),
        ]);

        return { tokenAddress: address, symbol, decimals };
      } catch (error) {
        console.error(`Error fetching info for token ${address}:`, error);
        throw error;
      }
    })
  );

  const tokenInfo: {
    [tokenAddress: string]: { symbol: string; decimals: number };
  } = {};

  tokenInfoArray.forEach((result, index) => {
    if (result.status === "fulfilled") {
      const { tokenAddress, symbol, decimals } = result.value;
      tokenInfo[tokenAddress] = {
        symbol: symbol as string,
        decimals: Number(decimals),
      };
    } else {
      const tokenAddress = Array.from(rewardTokenAddresses)[index];
      console.warn(
        `Failed to fetch info for token ${tokenAddress}. Using default values.`
      );
      tokenInfo[tokenAddress] = { symbol: "UNKNOWN", decimals: 18 };
    }
  });

  // Compare merkle data
  compareMerkleData(
    generateDelegatorsMerkle ? "Delegator" : "Non-delegator",
    merkleData,
    previousMerkleData,
    tokenInfo
  );

  fs.writeFileSync(outputPath, JSON.stringify(merkleData, null, 2));

  console.log(
    `${
      generateDelegatorsMerkle ? "Delegator" : "Non-delegator"
    } Merkle tree generated and saved successfully.`
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
