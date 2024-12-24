/**
 * vlCVX Merkle Tree Generation Script
 *
 * This script generates Merkle trees for both delegators and regular voters of vlCVX (claimed through Votemarket).
 * It calculates the distribution of sdCRV tokens for delegators based on their normal tokens distribution
 * For regular voters, it uses the existing token distribution data.
 *
 * The script performs the following main steps:
 * 1. Retrieves the sdCRV transfer data and calculates token shares for delegators
 * 2. Generates a Merkle tree for delegators based on their calculated sdCRV amounts (and distribution.json file)
 * 3. Generates a Merkle tree for regular voters based on the distribution.json file
 * 4. Combines both Merkle trees into a single JSON file for further use
 *
 */

import fs from "fs";
import path from "path";
import { createPublicClient, http, getAddress } from "viem";
import { mainnet } from "viem/chains";
import {
  getSdCrvTransfer,
  generateMerkleTree,
  MerkleData,
  CombinedMerkleData,
} from "./utils";
import { getClosestBlockTimestamp } from "../utils/chainUtils";
import {
  DELEGATION_ADDRESS,
  SDCRV_SPACE,
  SPACES_TOKENS,
} from "../utils/constants";

interface Distribution {
  [address: string]: {
    isStakeDelegator: boolean;
    tokens: {
      [tokenAddress: string]: bigint;
    };
  };
}

interface DelegationDistribution {
  [address: string]: {
    isStakeDelegator: boolean;
    tokens?: {
      [tokenAddress: string]: bigint;
    };
    share?: string;
  };
}

async function checkDistribution(
  combinedNonDelegatorDistribution: Distribution,
) {

  console.log("\nChecking Botmarket balances:");

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http("https://rpc.flashbots.net"),
  });

  // Get unique token addresses from the distribution
  const tokenAddresses = new Set<string>();
  Object.values(combinedNonDelegatorDistribution).forEach(data => {
    Object.keys(data.tokens).forEach(tokenAddress => tokenAddresses.add(tokenAddress));
  });

  for (const tokenAddress of tokenAddresses) {
    // Skip ZUN as it's not on Botmarket
    if (tokenAddress.toLowerCase() === "0x6b5204b0be36771253cc38e88012e02b752f0f36".toLowerCase()) {
      continue;
    }

    // Get total amount from distribution for this token
    const totalExpected = Object.values(combinedNonDelegatorDistribution)
      .reduce((acc, data) => {
        return acc + (data.tokens[tokenAddress] || 0n);
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

    // Compare and log differences 
    if (botmarketBalance !== totalExpected) {
      console.log(`\nToken ${tokenAddress}:`);
      console.log(`Expected: ${totalExpected}`);
      console.log(`Actual: ${botmarketBalance}`);
      console.log(`Difference: ${botmarketBalance - totalExpected}`);

      // Adjust distribution if actual balance is lower
      if (botmarketBalance < totalExpected) {
        const ratio = Number(botmarketBalance) / Number(totalExpected);
        console.log(`Adjusting amounts by ratio: ${ratio}`);

        // Adjust all amounts for this token
        for (const data of Object.values(combinedNonDelegatorDistribution)) {
          if (data.tokens[tokenAddress]) {
            data.tokens[tokenAddress] = BigInt(
              Math.floor(Number(data.tokens[tokenAddress]) * ratio)
            );
          }
        }
      }
    }
  }
  return combinedNonDelegatorDistribution;
}

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
      "No delegation distribution found. Proceeding with empty distribution."
    );
    return previousMerkleData;
  }

  // Find delegators (those with shares)
  const delegators = Object.entries(delegationDistribution).filter(
    ([_, data]) => data.isStakeDelegator && data.share
  );

  if (delegators.length === 0) {
    console.log(
      "No delegators found in current distribution. Using previous merkle data for delegators."
    );
    return previousMerkleData;
  }

  // Step 1: Get the total sdCRV transfer amount
  const sdCrvTransfer = await getSdCrvTransfer(minBlock, maxBlock);
  const totalSdCrv = sdCrvTransfer.amount;

  // Step 2: Calculate sdCRV amounts for each delegator based on their shares
  const delegatorDistribution: {
    [address: string]: { [tokenAddress: string]: string };
  } = {};

  delegators.forEach(([address, data]) => {
    const share = parseFloat(data.share!);
    const sdCrvAmount =
      (totalSdCrv * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);

    if (sdCrvAmount > 0n) {
      delegatorDistribution[address] = {
        [SPACES_TOKENS[SDCRV_SPACE]]: sdCrvAmount.toString(),
      };
    }
  });

  // Step 3: Merge with previous merkle data
  if (previousMerkleData && previousMerkleData.claims) {
    Object.entries(previousMerkleData.claims).forEach(
      ([address, claimData]: [string, any]) => {
        if (!delegatorDistribution[address]) {
          delegatorDistribution[address] = {};
        }
        if (claimData && claimData.tokens) {
          Object.entries(claimData.tokens).forEach(
            ([tokenAddress, tokenData]: [string, any]) => {
              if (tokenData && tokenData.amount) {
                if (!delegatorDistribution[address][tokenAddress]) {
                  delegatorDistribution[address][tokenAddress] = "0";
                }
                const previousAmount = BigInt(tokenData.amount);
                const currentAmount = BigInt(
                  delegatorDistribution[address][tokenAddress]
                );
                delegatorDistribution[address][tokenAddress] = (
                  previousAmount + currentAmount
                ).toString();
              }
            }
          );
        }
      }
    );
  }

  // Step 4: Generate Merkle tree
  return generateMerkleTree(delegatorDistribution);
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
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http("https://rpc.flashbots.net"),
  });

  const WEEK = 604800;
  const currentPeriodTimestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;
  const prevWeekTimestamp = currentPeriodTimestamp - WEEK;
  const previousPeriodTimestamp = prevWeekTimestamp - WEEK; // 2 weeks ago (latest distribution)

  const currentBlock = Number(await publicClient.getBlockNumber());
  const minBlock = await getClosestBlockTimestamp(
    "ethereum",
    currentPeriodTimestamp
  );

  // Step 1: Load distributions
  const currentDistributionPath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/vlCVX/repartition.json`
  );
  const currentDistribution: { distribution: Distribution } = JSON.parse(
    fs.readFileSync(currentDistributionPath, "utf-8")
  );

  // Load delegation distribution data with new format
  const delegationDistributionPath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/vlCVX/repartition_delegation.json`
  );
  let delegationDistribution: DelegationDistribution | null = null;
  if (fs.existsSync(delegationDistributionPath)) {
    delegationDistribution = JSON.parse(
      fs.readFileSync(delegationDistributionPath, "utf-8")
    ).distribution;
  } else {
    console.log(
      "Delegation distribution file not found. Proceeding with empty distribution."
    );
  }

  // Step 2: Load previous merkle data (if exists)
  const previousMerkleDataPath = path.join(
    __dirname,
    `../../bounties-reports/${previousPeriodTimestamp}/vlCVX/merkle_data.json`
  );
  let previousMerkleData: CombinedMerkleData = {
    delegators: { merkleRoot: "", claims: {} },
    nonDelegators: { merkleRoot: "", claims: {} },
  };
  if (fs.existsSync(previousMerkleDataPath)) {
    previousMerkleData = JSON.parse(
      fs.readFileSync(previousMerkleDataPath, "utf-8")
    );
  }

  // Step 3: Combine current distribution with previous amounts for non-delegators
  let combinedNonDelegatorDistribution: Distribution = {};

  // Add current week distribution for non-delegators
  Object.entries(currentDistribution.distribution).forEach(
    ([address, data]) => {
      if (!(data as any).isStakeDaoDelegator) {
        combinedNonDelegatorDistribution[address] = {
          isStakeDelegator: false,
          tokens: {},
        };
        Object.entries((data as any).tokens).forEach(
          ([tokenAddress, amount]) => {
            combinedNonDelegatorDistribution[address].tokens[tokenAddress] =
              BigInt(amount.toString());
          }
        );
      }
    }
  );

  // Add previous week distribution for non-delegators
  const prevWeekDistributionPath = path.join(
    __dirname,
    `../../bounties-reports/${prevWeekTimestamp}/vlCVX/repartition.json`
  );

  if (fs.existsSync(prevWeekDistributionPath)) {
    const prevWeekDistribution: { distribution: Distribution } = JSON.parse(
      fs.readFileSync(prevWeekDistributionPath, "utf-8")
    );

    Object.entries(prevWeekDistribution.distribution).forEach(
      ([address, data]) => {
        if (!(data as any).isStakeDaoDelegator) {
          if (!combinedNonDelegatorDistribution[address]) {
            combinedNonDelegatorDistribution[address] = {
              isStakeDelegator: false,
              tokens: {},
            };
          }
          Object.entries((data as any).tokens).forEach(
            ([tokenAddress, amount]) => {
              if (
                !combinedNonDelegatorDistribution[address].tokens[tokenAddress]
              ) {
                combinedNonDelegatorDistribution[address].tokens[tokenAddress] =
                  0n;
              }
              combinedNonDelegatorDistribution[address].tokens[tokenAddress] +=
                BigInt(amount.toString());
            }
          );
        }
      }
    );
  }

  // Adapt to avoid decimals issues
  combinedNonDelegatorDistribution = await checkDistribution(
    combinedNonDelegatorDistribution
  );

  // Add previous merkle amounts
  if (
    previousMerkleData.nonDelegators &&
    previousMerkleData.nonDelegators.claims
  ) {
    Object.entries(previousMerkleData.nonDelegators.claims).forEach(
      ([address, claimData]: [string, any]) => {
        if (!combinedNonDelegatorDistribution[address]) {
          combinedNonDelegatorDistribution[address] = {
            isStakeDelegator: false,
            tokens: {},
          };
        }
        if (claimData && claimData.tokens) {
          Object.entries(claimData.tokens).forEach(
            ([tokenAddress, tokenData]: [string, any]) => {
              if (tokenData && tokenData.amount) {
                if (
                  !combinedNonDelegatorDistribution[address].tokens[
                    tokenAddress
                  ]
                ) {
                  combinedNonDelegatorDistribution[address].tokens[
                    tokenAddress
                  ] = 0n;
                }
                combinedNonDelegatorDistribution[address].tokens[
                  tokenAddress
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
  Object.values(combinedNonDelegatorDistribution).forEach((data) => {
    Object.keys(data.tokens).forEach((tokenAddress) =>
      rewardTokenAddresses.add(tokenAddress.toLowerCase())
    );
  });

  // Collect from previous merkle data
  [previousMerkleData.delegators, previousMerkleData.nonDelegators].forEach(
    (merkle) => {
      Object.values(merkle.claims).forEach((claim) => {
        if (claim.tokens) {
          Object.keys(claim.tokens).forEach((tokenAddress) =>
            rewardTokenAddresses.add(tokenAddress.toLowerCase())
          );
        }
      });
    }
  );

  // Add sdCRV token
  rewardTokenAddresses.add(SPACES_TOKENS[SDCRV_SPACE].toLowerCase());

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

  // Step 5: Generate Merkle tree for non-delegators
  const nonDelegatorDistribution = Object.entries(
    combinedNonDelegatorDistribution
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

  const nonDelegatorMerkleData = generateMerkleTree(nonDelegatorDistribution);

  // Step 6: Generate Merkle tree for delegators with new format
  const delegatorMerkleData = await generateDelegatorMerkleTree(
    minBlock,
    currentBlock,
    delegationDistribution,
    previousMerkleData.delegators
  );

  // After generating both merkle trees, compare them
  console.log("\nComparing Merkle Trees:");

  compareMerkleData(
    "Non-Delegator Distribution Changes",
    nonDelegatorMerkleData,
    previousMerkleData.nonDelegators,
    tokenInfo
  );

  compareMerkleData(
    "Delegator Distribution Changes",
    delegatorMerkleData,
    previousMerkleData.delegators,
    tokenInfo
  );

  // Step 7: Combine Merkle data for both delegators and non-delegators
  const merkleDataPath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/vlCVX/merkle_data.json`
  );
  const merkleData = {
    delegators: delegatorMerkleData,
    nonDelegators: nonDelegatorMerkleData,
  };

  // Additional : all addresses should be checksummed
  merkleData.delegators.claims = Object.fromEntries(
    Object.entries(merkleData.delegators.claims).map(([address, claim]) => [
      getAddress(address),
      claim,
    ])
  );

  merkleData.nonDelegators.claims = Object.fromEntries(
    Object.entries(merkleData.nonDelegators.claims).map(([address, claim]) => [
      getAddress(address),
      claim,
    ])
  );

  // Step 8: Save the combined Merkle data to a JSON file
  fs.writeFileSync(merkleDataPath, JSON.stringify(merkleData, null, 2));

  console.log("Merkle trees generated and saved successfully.");
}

generateMerkles().catch(console.error);
