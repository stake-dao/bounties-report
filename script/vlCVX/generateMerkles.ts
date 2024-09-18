/**
 * vlCVX Merkle Tree Generation Script
 *
 * This script generates Merkle trees for both delegators and regular voters of vlCVX (claimed through Votemarket).
 * It calculates the distribution of sdCRV tokens for delegators based on their normal tokens distribution
 * + <hat which token brings in sdCRV. For regular voters,
 * it uses the existing token distribution data.
 *
 * The script performs the following main steps:
 * 1. Retrieves the sdCRV transfer data and calculates token shares for delegators
 * 2. Generates a Merkle tree for delegators based on their calculated sdCRV amounts (and distribution.json file)
 * 3. Generates a Merkle tree for regular voters based on the distribution.json file
 * 4. Combines both Merkle trees into a single JSON file for further use
 *
 */

import { utils } from "ethers";
import fs from "fs";
import path from "path";
import { createPublicClient, http, getAddress } from "viem";
import { mainnet } from "viem/chains";
import {
  getSdCrvTransfer,
  getTokenTransfersOut,
  getWethTransfersIn,
  matchTokensWithWeth,
  calculateTokenSdCrvShares,
  generateMerkleTree,
  MerkleData,
  CombinedMerkleData,
} from "./utils";
import { getClosestBlockTimestamp } from "../utils/reportUtils";

interface Distribution {
  [address: string]: {
    isStakeDaoDelegator: boolean;
    tokens: {
      [tokenAddress: string]: number;
    };
  };
}

async function generateDelegatorMerkleTree(
  publicClient: any,
  minBlock: number,
  maxBlock: number,
  distribution: Distribution,
  previousMerkleData: MerkleData
): Promise<MerkleData> {
  // Step 1: Get the total sdCRV transfer amount and block number
  const sdCrvTransfer = await getSdCrvTransfer(minBlock, maxBlock);
  const totalSdCrv = sdCrvTransfer.amount;
  const transferBlock = sdCrvTransfer.blockNumber;

  // Step 2: Get all unique tokens from delegators
  const uniqueTokens = new Set<string>();
  Object.values(distribution).forEach((data) => {
    if (data.isStakeDaoDelegator) {
      Object.keys(data.tokens || {}).forEach((token) =>
        uniqueTokens.add(token)
      );
    }
  });

  // Step 3: Get token transfers out and WETH transfers in at the transfer block
  const tokenTransfers = await Promise.all(
    Array.from(uniqueTokens).map((token) =>
      getTokenTransfersOut(publicClient, token, transferBlock)
    )
  );
  const wethTransfers = await getWethTransfersIn(publicClient, transferBlock);

  // Step 4: Match token transfers with WETH transfers to get WETH values
  const flattenedTokenTransfers = tokenTransfers.flat();
  const tokenWethValues = matchTokensWithWeth(
    flattenedTokenTransfers,
    wethTransfers
  );

  // Step 5: Calculate sdCRV shares for each token based on WETH values
  const tokenSdCrvShares = calculateTokenSdCrvShares(
    tokenWethValues,
    totalSdCrv
  );

  // Step 6: Calculate sdCRV amounts for each delegator based on their token holdings
  const delegatorDistribution: {
    [address: string]: { [tokenAddress: string]: string };
  } = {};

  const sdCrvTokenAddress = "0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5"; // sdCRV token

  Object.entries(distribution).forEach(([address, data]) => {
    if (data.isStakeDaoDelegator) {
      let totalSdCrvShare = BigInt(0);

      Object.entries(data.tokens || {}).forEach(([tokenAddress, amount]) => {
        if (tokenSdCrvShares[tokenAddress]) {
          const tokenAmount = BigInt(Math.floor(amount * 1e18)); // Convert to wei
          const sdCrvShare =
            (tokenSdCrvShares[tokenAddress] * tokenAmount) / BigInt(1e18);
          totalSdCrvShare += sdCrvShare;
        }
      });

      if (totalSdCrvShare > 0) {
        delegatorDistribution[address] = {
          [sdCrvTokenAddress]: totalSdCrvShare.toString(),
        };
      }
    }
  });

  // Step 7: Merge previous merkle data with new delegator distribution
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

  // Step 8: Generate Merkle tree for delegators using the calculated sdCRV amounts
  return generateMerkleTree(delegatorDistribution);
}

async function generateMerkles() {
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(),
  });

  const WEEK = 604800;
  const currentPeriodTimestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;
  const previousPeriodTimestamp = currentPeriodTimestamp - WEEK;

  const currentBlock = Number(await publicClient.getBlockNumber());
  const minBlock = await getClosestBlockTimestamp(
    "ethereum",
    currentPeriodTimestamp
  );

  // Step 1: Load current distribution data
  const currentDistributionPath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/vlCVX/repartition.json`
  );
  const currentDistribution: Distribution = JSON.parse(
    fs.readFileSync(currentDistributionPath, "utf-8")
  );

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
          isStakeDaoDelegator: false,
          tokens: {},
        };
        Object.entries((data as any).tokens).forEach(
          ([tokenAddress, amount]) => {
            combinedNonDelegatorDistribution[address].tokens[tokenAddress] =
              amount as number;
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
            isStakeDaoDelegator: false,
            tokens: {},
          };
        }
        if (claimData && claimData.tokens) {
          Object.entries(claimData.tokens).forEach(
            ([tokenAddress, tokenData]: [string, any]) => {
              if (tokenData && tokenData.amount) {
                const decimals = tokenInfo[tokenAddress]?.decimals || 18;
                if (
                  !combinedNonDelegatorDistribution[address].tokens[
                    tokenAddress
                  ]
                ) {
                  combinedNonDelegatorDistribution[address].tokens[
                    tokenAddress
                  ] = 0;
                }
                combinedNonDelegatorDistribution[address].tokens[
                  tokenAddress
                ] += parseFloat(utils.formatUnits(tokenData.amount, decimals));
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
        if (typeof amount === "number") {
          const decimals = tokenInfo[tokenAddress]?.decimals || 18;
          const formattedAmount = utils
            .parseUnits(amount.toFixed(decimals), decimals)
            .toString();
          tokenAcc[tokenAddress] = formattedAmount;
        } else {
          console.warn(
            `Amount for token ${tokenAddress} is not a number:`,
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

  // Step 6: Generate Merkle tree for delegators
  const delegatorMerkleData = await generateDelegatorMerkleTree(
    publicClient,
    minBlock,
    currentBlock,
    currentDistribution,
    previousMerkleData.delegators
  );

  // Step 7: Combine Merkle data for both delegators and non-delegators
  const merkleDataPath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/vlCVX/merkle_data.json`
  );
  const merkleData = {
    // delegators: delegatorMerkleData,
    nonDelegators: nonDelegatorMerkleData,
  };

  // Step 8: Save the combined Merkle data to a JSON file
  fs.writeFileSync(merkleDataPath, JSON.stringify(merkleData, null, 2));

  console.log("Merkle trees generated and saved successfully.");
}

generateMerkles().catch(console.error);
