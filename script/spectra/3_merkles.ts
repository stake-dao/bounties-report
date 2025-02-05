/**
 * Spectra Merkle Tree Generation Script
*/

import fs from "fs";
import path from "path";
import { createPublicClient, http, getAddress } from "viem";
import { base } from "viem/chains";
import {
  DELEGATION_ADDRESS,
} from "../utils/constants";
import { generateMerkleTree, MerkleData } from "../vlCVX/utils";

export interface Distribution {
  [address: string]: {
    tokens: {
      [tokenAddress: string]: bigint;
    };
  };
}

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

  // For each token, show distribution
  tokens.forEach((token) => {
    // Find token info
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
      console.log("\n Sorted users:");

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

      // Sort by new amount and filter significant holders
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

async function generateMerkles() {
  const WEEK = 604800;
  const currentPeriodTimestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;
  const prevWeekTimestamp = currentPeriodTimestamp - WEEK;

  // Step 1: Load distributions
  const pathDir = `../../bounties-reports/${currentPeriodTimestamp}/spectra`;
  const pathDirPrevious = `../../bounties-reports/${prevWeekTimestamp}/spectra`;

  const currentDistributionPath = path.join(
    __dirname,
    pathDir,
    "repartition.json",
  );
  const currentDistribution: { distribution: Distribution } = JSON.parse(
    fs.readFileSync(currentDistributionPath, "utf-8")
  );

  // Step 2: Load previous merkle data (if exists)
  const previousMerkleDataPath = path.join(
    __dirname,
    pathDirPrevious,
    "merkle_data.json"
  );
  let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
  if (fs.existsSync(previousMerkleDataPath)) {
    previousMerkleData = JSON.parse(
      fs.readFileSync(previousMerkleDataPath, "utf-8")
    );
  }

  // Step 3: Combine current distribution with previous amounts
  let combinedDistribution: Distribution = {};

  // Add current week distribution
  Object.entries(currentDistribution.distribution).forEach(
    ([address, data]) => {
      combinedDistribution[address] = {
        tokens: {},
      };
      Object.entries(data.tokens).forEach(
        ([tokenAddress, amount]) => {
          combinedDistribution[address].tokens[getAddress(tokenAddress)] =
            BigInt(amount.toString());
        }
      );
    }
  );

  // Add previous merkle amounts
  if (
    previousMerkleData.claims
  ) {
    Object.entries(previousMerkleData.claims).forEach(
      ([address, claimData]: [string, any]) => {
        if (!combinedDistribution[address]) {
          combinedDistribution[address] = {
            tokens: {},
          };
        }
        if (claimData && claimData.tokens) {
          Object.entries(claimData.tokens).forEach(
            ([tokenAddress, tokenData]: [string, any]) => {
              if (tokenData && tokenData.amount) {
                const normalizedAddress = getAddress(tokenAddress);

                if (
                  !combinedDistribution[address].tokens[
                    normalizedAddress
                  ]
                ) {
                  combinedDistribution[address].tokens[
                    normalizedAddress
                  ] = 0n;
                }

                combinedDistribution[address].tokens[
                  normalizedAddress
                ] += BigInt(tokenData.amount);
              }
            }
          );
        }
      }
    );
  }

  // Step 4: Retrieve token info (symbol and decimals) for all reward tokens
  const rewardTokenAddresses = new Set<string>();

  // Collect from current distribution
  Object.values(combinedDistribution).forEach((data) => {
    Object.keys(data.tokens).forEach((tokenAddress) =>
      rewardTokenAddresses.add(tokenAddress.toLowerCase())
    );
  });

  // Collect from previous merkle data
  Object.values(previousMerkleData.claims).forEach((claim) => {
    if (claim.tokens) {
      Object.keys(claim.tokens).forEach((tokenAddress) =>
        rewardTokenAddresses.add(tokenAddress.toLowerCase())
      );
    }
  });

  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

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

  // Step 5: Generate Merkle tree
  const nonDelegatorDistribution = Object.entries(
    combinedDistribution
  ).reduce((acc, [address, data]) => {
    acc[address] = Object.entries(data.tokens).reduce(
      (tokenAcc, [tokenAddress, amount]) => {
        if (amount !== undefined) {
          tokenAcc[tokenAddress] = amount.toString();
        } else {
          console.warn(
            `Amount for token ${tokenAddress} is undefined:`,
            amount
          );
        }
        return tokenAcc;
      },
      {} as { [tokenAddress: string]: string }
    );
    return acc;
  }, {} as { [address: string]: { [tokenAddress: string]: string } });

  const newMerkleData = generateMerkleTree(nonDelegatorDistribution);

  // After generating both merkle trees, compare them
  console.log("\nComparing Merkle Tree:");

  compareMerkleData(
    "Distribution Changes",
    newMerkleData,
    previousMerkleData,
    tokenInfo
  );

  // Step 7: Combine Merkle data
  let merkleDataPath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/spectra/merkle_data.json`
  );

  // Additional : all addresses should be checksummed
  newMerkleData.claims = Object.fromEntries(
    Object.entries(newMerkleData.claims).map(([address, claim]) => [
      getAddress(address),
      claim,
    ])
  );


  // Step 8: Save the combined Merkle data to a JSON file
  fs.writeFileSync(merkleDataPath, JSON.stringify(newMerkleData, null, 2));

  // Step 9: Save it in the latest path
  merkleDataPath = path.join(
    __dirname,
    `../../bounties-reports/latest/spectra/merkle_data_tmp.json`
  );

  // Create directory if it doesn't exist
  const dir = path.dirname(merkleDataPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(merkleDataPath, JSON.stringify(newMerkleData, null, 2));

  console.log("Merkle trees generated and saved successfully.");
}

generateMerkles().catch(console.error);
