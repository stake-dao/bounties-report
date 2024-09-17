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
} from "./utils";

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
  distribution: Distribution
): Promise<MerkleData> {
  // Step 1: Get the total sdCRV transfer amount and block number
  const sdCrvTransfer = await getSdCrvTransfer(publicClient);
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

  // Step 7: Generate Merkle tree for delegators using the calculated sdCRV amounts
  return generateMerkleTree(delegatorDistribution);
}

async function generateMerkles() {
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(),
  });

  const WEEK = 604800;
  const currentPeriodTimestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

  // Step 1: Load distribution data
  const distributionPath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/vlCVX/repartition.json`
  );
  const distribution: Distribution = JSON.parse(
    fs.readFileSync(distributionPath, "utf-8")
  );

  // Step 2: Retrieve token info (symbol and decimals) for all reward tokens
  const rewardTokenAddresses = Object.entries(distribution).reduce(
    (acc, [address, data]) => {
      if (typeof data !== "boolean" && data.tokens) {
        Object.keys(data.tokens).forEach((tokenAddress) =>
          acc.add(tokenAddress)
        );
      }
      return acc;
    },
    new Set<string>()
  );

  // For each token address, get token info (symbol, decimals)
  const tokenInfoArray = await Promise.allSettled(
    Array.from(rewardTokenAddresses).map(async (tokenAddress) => {
      const address = getAddress(tokenAddress.toLowerCase());
      try {
        const [symbol, decimals] = await Promise.all([
          publicClient.readContract({
            address: address,
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
            address: address,
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

  // Store token info in a dictionary
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
      tokenInfo[tokenAddress] = {
        symbol: "UNKNOWN",
        decimals: 18,
      };
    }
  });

  // Step 3: Calculate distribution for regular voters (non-delegators)
  const nonDelegatorDistribution = Object.entries(
    distribution.distribution
  ).reduce((acc, [address, data]) => {
    if (typeof data !== "boolean" && !data.isStakeDaoDelegator) {
      acc[address] = Object.entries(data.tokens || {}).reduce(
        (tokenAcc, [tokenAddress, amount]) => {
          if (typeof amount === "number") {
            const decimals = tokenInfo[tokenAddress]?.decimals || 18;
            try {
              // Convert the amount to a fixed-point representation
              const fixedAmount = amount.toFixed(decimals);
              const formattedAmount = utils
                .parseUnits(fixedAmount, decimals)
                .toString();
              tokenAcc[tokenAddress] = formattedAmount;
            } catch (error) {
              console.error(
                `Error parsing amount for token ${tokenAddress} with amount ${amount}:`,
                error
              );
            }
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
    }
    return acc;
  }, {} as { [address: string]: { [tokenAddress: string]: string } });

  // Step 4: Generate Merkle tree for regular voters
  const nonDelegatorMerkleData = generateMerkleTree(nonDelegatorDistribution);

  // Step 5: Generate Merkle tree for delegators
  const delegatorMerkleData = await generateDelegatorMerkleTree(
    publicClient,
    distribution
  );

  // Step 6: Combine Merkle data for both delegators and regular voters
  const merkleDataPath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/vlCVX/merkle_data.json`
  );
  const merkleData = {
    delegators: delegatorMerkleData,
    regularVoters: nonDelegatorMerkleData,
  };

  // Step 7: Save the combined Merkle data to a JSON file
  fs.writeFileSync(merkleDataPath, JSON.stringify(merkleData, null, 2));

  console.log("Merkle trees generated and saved successfully.");
}

generateMerkles().catch(console.error);
