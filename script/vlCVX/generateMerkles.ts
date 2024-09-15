import { MerkleTree } from "merkletreejs";
import { utils, BigNumber } from "ethers";
import keccak256 from "keccak256";
import fs from "fs";
import path from "path";
import { createPublicClient, http, formatUnits } from "viem";
import { mainnet } from "viem/chains";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";
import { SDCRV_SPACE, SPACES_TOKENS, VLCVX_RECIPIENT } from "../utils/constants";
import { ALL_MIGHT } from "../utils/reportUtils";

interface Distribution {
  [address: string]: {
    isStakeDelegator: boolean;
    tokens: {
      [tokenAddress: string]: number;
    };
  };
}

interface UserReward {
  address: string;
  amount: string;
}

const WEEK = 604800;
const currentPeriodTimestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

const explorerUtils = createBlockchainExplorerUtils("ethereum");

async function getSdCrvBalance(): Promise<BigNumber> {
  const transferEventSignature = "Transfer(address,address,uint256)";
  const transferEventTopic = utils.id(transferEventSignature);

  const currentBlock = await publicClient.getBlockNumber();

  const logs = await explorerUtils.getLogsByAddressAndTopics(
    SPACES_TOKENS["sdcrv.eth"],
    0, // fromBlock
    currentBlock, // toBlock
    {
      "0": transferEventTopic,
      "1": utils.hexZeroPad(ALL_MIGHT, 32),
      "2": utils.hexZeroPad(VLCVX_RECIPIENT, 32),
    }
  );

  let totalBalance = BigNumber.from(0);

  for (const log of logs.result) {
    const amount = BigNumber.from(log.data);
    totalBalance = totalBalance.add(amount);
  }

  return totalBalance;
}

function generateMerkleForNonDelegators(distribution: Distribution): void {
  const userRewards: UserReward[] = Object.entries(distribution)
    .filter(([_, data]) => !data.isStakeDelegator)
    .flatMap(([address, data]) =>
      Object.entries(data.tokens).map(([tokenAddress, amount]) => ({
        address,
        amount: utils.parseEther(amount.toString()).toString(),
      }))
    );

  const merkleData = generateMerkleTree(userRewards);

  const outputPath = path.join(__dirname, "..", "..", "bounties-reports", currentPeriodTimestamp.toString(), "vlCVX", "merkle_non_delegators.json");
  fs.writeFileSync(outputPath, JSON.stringify(merkleData, null, 2));
  console.log(`Merkle tree data for non-delegators written to ${outputPath}`);
}

async function generateMerkleForDelegators(distribution: Distribution): Promise<void> {
  const sdCrvBalance = await getSdCrvBalance();
  const totalSdCrv = parseFloat(utils.formatEther(sdCrvBalance));

  const delegatorRewards: UserReward[] = Object.entries(distribution)
    .filter(([_, data]) => data.isStakeDelegator)
    .map(([address, data]) => {
      const userTotal = Object.values(data.tokens).reduce((sum, amount) => sum + amount, 0);
      const share = userTotal / totalSdCrv;
      const sdCrvAmount = share * totalSdCrv;
      return {
        address,
        amount: utils.parseEther(sdCrvAmount.toString()).toString(),
      };
    });

  const merkleData = generateMerkleTree(delegatorRewards);

  const outputPath = path.join(__dirname, "..", "..", "bounties-reports", currentPeriodTimestamp.toString(), "vlCVX", "merkle_delegators_sdcrv.json");
  fs.writeFileSync(outputPath, JSON.stringify(merkleData, null, 2));
  console.log(`Merkle tree data for delegators (sdCRV) written to ${outputPath}`);
}

function generateMerkleTree(userRewards: UserReward[]) {
  const leaves = userRewards.map((reward) =>
    utils.solidityKeccak256(
      ["address", "uint256"],
      [reward.address, reward.amount]
    )
  );

  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const merkleRoot = merkleTree.getHexRoot();

  const claims = Object.fromEntries(
    userRewards.map((reward) => [
      reward.address,
      {
        amount: reward.amount,
        proof: merkleTree.getHexProof(
          utils.solidityKeccak256(
            ["address", "uint256"],
            [reward.address, reward.amount]
          )
        ),
      },
    ])
  );

  return { merkleRoot, claims };
}

async function main() {
  const distributionPath = path.join(__dirname, "..", "..", "bounties-reports", currentPeriodTimestamp.toString(), "vlCVX", "repartition.json");
  const distributionData = JSON.parse(fs.readFileSync(distributionPath, "utf-8"));
  const distribution: Distribution = distributionData.distribution;

  generateMerkleForNonDelegators(distribution);
  await generateMerkleForDelegators(distribution);
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});