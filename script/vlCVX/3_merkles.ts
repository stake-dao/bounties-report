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
import { SDCRV_SPACE, SPACES_TOKENS } from "../utils/constants";

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

  console.log(`Total sdCRV amount to distribute: ${totalSdCrv.toString()}`);

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

async function generateMerkles() {
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http("https://rpc.flashbots.net"),
  });

  const WEEK = 604800;
  const currentPeriodTimestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;
  const previousPeriodTimestamp = currentPeriodTimestamp - 2 * WEEK; // 2 weeks ago (latest distribution)

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
  const combinedNonDelegatorDistribution: Distribution = {};

  // Add current distribution for non-delegators
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

  // Step 4: Retrieve token info (symbol and decimals) for all reward tokens
  const rewardTokenAddresses = new Set<string>();
  Object.values(combinedNonDelegatorDistribution).forEach((data) => {
    Object.keys(data.tokens).forEach((tokenAddress) =>
      rewardTokenAddresses.add(tokenAddress)
    );
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

  // Step 7: Combine Merkle data for both delegators and non-delegators
  const merkleDataPath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/vlCVX/merkle_data.json`
  );
  const merkleData = {
    delegators: delegatorMerkleData,
    nonDelegators: nonDelegatorMerkleData,
  };

  // Step 8: Save the combined Merkle data to a JSON file
  fs.writeFileSync(merkleDataPath, JSON.stringify(merkleData, null, 2));

  console.log("Merkle trees generated and saved successfully.");
}

generateMerkles().catch(console.error);
