import { MerkleTree } from "merkletreejs";
import { utils, BigNumber } from "ethers";
import keccak256 from "keccak256";
import fs from "fs";
import path from "path";
import axios from "axios";
import { createPublicClient, getAddress, http } from "viem";
import { mainnet } from "viem/chains";

interface Distribution {
  [address: string]: {
    isStakeDaoDelegator: boolean;
    tokens: {
      [tokenAddress: string]: number;
    };
  };
}

interface DelegatorDistribution {
  [tokenAddress: string]: number;
}

interface MerkleData {
  merkleRoot: string;
  claims: {
    [address: string]: {
      tokens: {
        [tokenAddress: string]: {
          amount: string;
          proof: string[];
        };
      };
    };
  };
}

const WEEK = 604800;
const currentPeriodTimestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(),
});

function ensureDirectoryExistence(filePath: string) {
  const dirname = path.dirname(filePath);
  if (fs.existsSync(dirname)) {
    return true;
  }
  ensureDirectoryExistence(dirname);
  fs.mkdirSync(dirname);
}

function generateMerkleTree(distribution: {
  [address: string]: { [tokenAddress: string]: string };
}): MerkleData {
  const leaves: string[] = [];
  const claims: MerkleData["claims"] = {};

  Object.entries(distribution).forEach(([address, tokens]) => {
    Object.entries(tokens).forEach(([tokenAddress, amount]) => {
      const leaf = utils.keccak256(
        utils.solidityPack(
          ["bytes"],
          [
            utils.keccak256(
              utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [address, tokenAddress, amount]
              )
            ),
          ]
        )
      );
      leaves.push(leaf);

      if (!claims[address]) {
        claims[address] = { tokens: {} };
      }
      claims[address].tokens[tokenAddress] = {
        amount,
        proof: [],
      };
    });
  });

  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const merkleRoot = merkleTree.getHexRoot();

  // Generate proofs
  Object.entries(claims).forEach(([address, claim]) => {
    Object.entries(claim.tokens).forEach(([tokenAddress, tokenClaim]) => {
      const leaf = utils.keccak256(
        utils.solidityPack(
          ["bytes"],
          [
            utils.keccak256(
              utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [address, tokenAddress, tokenClaim.amount]
              )
            ),
          ]
        )
      );
      tokenClaim.proof = merkleTree.getHexProof(leaf);
    });
  });

  return { merkleRoot, claims };
}

async function generateMerkles(): Promise<void> {
  const repartitionPath = path.join(
    __dirname,
    "..",
    "..",
    "bounties-reports",
    currentPeriodTimestamp.toString(),
    "vlCVX",
    "repartition.json"
  );
  // const repartitionDelegatorsPath = path.join(__dirname, "..", "..", "bounties-reports", currentPeriodTimestamp.toString(), "vlCVX", "repartition_delegators.json");

  const distribution: Distribution = JSON.parse(
    fs.readFileSync(repartitionPath, "utf-8")
  );
  // const delegatorDistribution: DelegatorDistribution = JSON.parse(fs.readFileSync(repartitionDelegatorsPath, 'utf-8'));

  // Get all reward token addresses
  const rewardTokenAddresses = Object.entries(distribution.distribution).reduce(
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

  // Generate Merkle tree for non-delegators
  const nonDelegatorDistribution = Object.entries(
    distribution.distribution
  ).reduce((acc, [address, data]) => {
    if (typeof data !== "boolean" && !data.isStakeDelegator) {
      acc[address] = Object.entries(data.tokens || {}).reduce(
        (tokenAcc, [tokenAddress, amount]) => {
          if (typeof amount === "number") {
            const decimals = tokenInfo[tokenAddress]?.decimals || 18;
            try {
              // Convert the amount to a fixed-point representation
              const fixedAmount = amount.toFixed(decimals);
              const formattedAmount = utils.parseUnits(fixedAmount, decimals).toString();
              tokenAcc[tokenAddress] = formattedAmount;
            } catch (error) {
              console.error(
                `Error parsing amount for token ${tokenAddress} with amount ${amount}:`,
                error
              );
              // Fallback: Use a very small number instead of 0
              tokenAcc[tokenAddress] = "1"; // Represents the smallest possible unit
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

  const nonDelegatorMerkleData = generateMerkleTree(nonDelegatorDistribution);

  // Generate Merkle tree for delegators
  const delegatorTotalShares = Object.values(distribution).reduce(
    (total, data) => {
      if (data.isStakeDaoDelegator) {
        Object.values(data.tokens).forEach((amount) => (total += amount));
      }
      return total;
    },
    0
  );

  /*
  const delegatorDistributionWithSdCrv = Object.entries(distribution).reduce((acc, [address, data]) => {
    if (data.isStakeDaoDelegator) {
      const sdCrvAmount = Object.entries(data.tokens).reduce((total, [tokenAddress, amount]) => {
        const tokenShare = amount / delegatorTotalShares;
        const sdCrvForToken = BigNumber.from(delegatorDistribution[tokenAddress] || 0);
        return total.add(sdCrvForToken.mul(tokenShare * 1e6).div(1e6));
      }, BigNumber.from(0));
      acc[address] = { "sdCRV": sdCrvAmount.toString() };
    }
    return acc;
  }, {} as { [address: string]: { [tokenAddress: string]: string } });

  const delegatorMerkleData = generateMerkleTree(delegatorDistributionWithSdCrv);
  */

  // Save results
  const outputPath = path.join(
    __dirname,
    "..",
    "..",
    "bounties-reports",
    currentPeriodTimestamp.toString(),
    "vlCVX",
    "merkle_data.json"
  );
  ensureDirectoryExistence(outputPath);
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        nonDelegators: { ...nonDelegatorMerkleData },
        // delegators: { ...delegatorMerkleData }
      },
      null,
      2
    )
  );

  console.log(`Merkle tree data written to ${outputPath}`);
}

// Run the script
generateMerkles().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
