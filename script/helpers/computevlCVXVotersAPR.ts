import {
  createPublicClient,
  http,
  keccak256,
  encodePacked,
  pad,
  decodeAbiParameters,
  getAddress,
} from "viem";
import { mainnet } from "viem/chains";
import * as moment from "moment";
import {
  getProposal,
  getVoters,
  associateGaugesPerId,
  fetchLastProposalsIds,
} from "../utils/snapshot";
import { getAllCurveGauges } from "../utils/curveApi";
import {
  DELEGATION_ADDRESS,
  CVX_SPACE,
  WEEK,
  VLCVX_NON_DELEGATORS_MERKLE,
  CVX,
} from "../utils/constants";
import { extractCSV, getHistoricalTokenPrice } from "../utils/utils";
import { getClosestBlockTimestamp } from "../utils/chainUtils";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";
import { BOTMARKET } from "../utils/reportUtils";
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { getAllRewardsForVotersOnChain, computeAnnualizedAPR } from "./utils";

interface APRResult {
  totalVotingPower: number;
  rewardValueUSD: number;
  cvxPrice: number;
  annualizedAPR: number;
  periodStartBlock: number;
  periodEndBlock: number;
  timestamp: number;
}

interface TokenTransfer {
  token: string;
  amount: bigint;
  blockNumber: number;
}

interface TokenPrice {
  address: string;
  price: number;
  decimals: number;
}

type CvxCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: bigint; chainId?: number }[]
>;

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

async function getTokenPrices(
  chain: string,
  tokens: string[],
  currentPeriodTimestamp: number
): Promise<TokenPrice[]> {
  const prices = await Promise.all(
    tokens.map(async (token) => {
      const price = await getHistoricalTokenPrice(
        currentPeriodTimestamp,
        chain,
        token
      );
      return { address: token, price, decimals: 18 };
    })
  );
  return prices;
}

async function getRewards(
  startBlock: number,
  endBlock: number,
  tokens: string[]
): Promise<TokenTransfer[]> {
  const explorerUtils = createBlockchainExplorerUtils();
  const transferSig = "Transfer(address,address,uint256)";
  const transferHash = keccak256(encodePacked(["string"], [transferSig]));

  const paddedBotmarket = pad(BOTMARKET as `0x${string}`, {
    size: 32,
  }).toLowerCase();
  const paddedNonDelegators = pad(
    VLCVX_NON_DELEGATORS_MERKLE as `0x${string}`,
    {
      size: 32,
    }
  ).toLowerCase();

  // Query for transfers from BOTMARKET
  const topicsBotmarket = {
    "0": transferHash,
    "1": paddedBotmarket,
    "2": paddedNonDelegators,
  };

  const responseBotmarket = await explorerUtils.getLogsByAddressesAndTopics(
    tokens,
    startBlock,
    endBlock,
    topicsBotmarket,
    1
  );

  // Remove duplicates with same transactionHash AND token address
  const uniqueTransfers = responseBotmarket.result.filter(
    (transfer, index, self) =>
      index ===
      self.findIndex(
        (t) =>
          t.transactionHash === transfer.transactionHash &&
          t.address === transfer.address
      )
  );

  if (uniqueTransfers.length === 0) {
    throw new Error("No token transfers found");
  }

  return uniqueTransfers.map((transfer) => {
    const [amount] = decodeAbiParameters([{ type: "uint256" }], transfer.data);

    return {
      token: transfer.address.toLowerCase(),
      amount: BigInt(amount),
      blockNumber: parseInt(transfer.blockNumber, 16),
    };
  });
}

async function computeAPR(): Promise<APRResult> {
  const now = moment.utc().unix();
  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;

  // Get CVX report to identify relevant gauges
  console.log("Extracting CSV report...");
  const csvResult = (await extractCSV(
    currentPeriodTimestamp,
    CVX_SPACE
  )) as CvxCSVType;
  if (!csvResult) throw new Error("No CSV report found");

  // Get relevant gauges from CSV
  const gauges = Array.from(
    new Set(
      Object.keys(csvResult).filter((gauge) =>
        csvResult[gauge].some((g) => g.chainId === 1)
      )
    )
  );
  console.log(`Found ${gauges.length} gauges in report`);

  /*
  // Get relevant tokens from CSV
  const tokens = Array.from(
    new Set(
      Object.values(csvResult).flatMap((gauge) =>
        gauge.filter((g) => g.chainId === 1).map((g) => g.rewardAddress)
      )
    )
  );
  */

  // Fetch last proposal
  console.log("Fetching latest proposal...");
  const filter: string = "^(?!FXN ).*Gauge Weight for Week of";
  const proposalIdPerSpace = await fetchLastProposalsIds(
    [CVX_SPACE],
    now,
    filter
  );
  const proposalId = proposalIdPerSpace[CVX_SPACE];
  console.log("Using proposal:", proposalId);

  // Fetch proposal data and votes
  const proposal = await getProposal(proposalId);
  const votes = await getVoters(proposalId);
  const curveGauges = await getAllCurveGauges();
  const gaugePerChoiceId = associateGaugesPerId(proposal, curveGauges);

  let totalVotingPower = 0;
  let delegationVotingPower = 0;

  // Process votes for each gauge
  for (const gauge of gauges) {
    const gaugeInfo = gaugePerChoiceId[gauge.toLowerCase()];
    if (!gaugeInfo) {
      console.warn(`Warning: No gauge info found for ${gauge}`);
      continue;
    }

    const votesForGauge = votes.filter(
      (vote) => vote.choice[gaugeInfo.choiceId] !== undefined
    );

    for (const vote of votesForGauge) {
      let vpChoiceSum = 0;
      let currentChoiceIndex = 0;

      for (const [choiceIndex, value] of Object.entries(vote.choice)) {
        if (gaugeInfo.choiceId === parseInt(choiceIndex)) {
          currentChoiceIndex = value;
        }
        vpChoiceSum += value;
      }

      if (currentChoiceIndex > 0) {
        const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
        const effectiveVp = (vote.vp * ratio) / 100;

        totalVotingPower += effectiveVp;
        if (vote.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
          delegationVotingPower += effectiveVp;
        }
      }
    }
  }

  // Remove delegation vp has different distribution
  totalVotingPower -= delegationVotingPower;

  // Get all rewards on the Week received by the Merkles
  // Get block numbers
  const currentBlock = Number(await publicClient.getBlockNumber());
  const minBlock = await getClosestBlockTimestamp(
    "ethereum",
    currentPeriodTimestamp
  );
  /*
  const rewards = await getRewards(minBlock, currentBlock, tokens);

  const sumPerToken = rewards.reduce((acc, reward) => {
    acc[getAddress(reward.token)] =
      (acc[getAddress(reward.token)] || 0n) + reward.amount;
    return acc;
  }, {} as Record<string, bigint>);
  */
  const allRewards = getAllRewardsForVotersOnChain(1, currentPeriodTimestamp);
  const tokens = Object.keys(allRewards);
  const sumPerToken = allRewards as Record<string, bigint>;

  const prices = await getTokenPrices("ethereum", tokens, currentPeriodTimestamp);

  const cvxPriceResponse = await getTokenPrices("ethereum", [CVX], Number(proposal.start)); // Price at the snapshot
  const cvxPrice = cvxPriceResponse[0].price;

  // Calculate total reward value in USD
  const rewardValueUSD = prices.reduce((total, price) => {
    const tokenAmount = sumPerToken[getAddress(price.address)] || 0n;
    const valueUSD =
      price.price * (Number(tokenAmount) / Math.pow(10, price.decimals));
    return total + valueUSD;
  }, 0);

  // Calculate APR
  const annualizedAPR = computeAnnualizedAPR(
    totalVotingPower,
    rewardValueUSD,
    cvxPrice
  );
  return {
    totalVotingPower,
    rewardValueUSD,
    cvxPrice,
    annualizedAPR,
    periodStartBlock: Number(proposal.snapshot),
    periodEndBlock: Number(proposal.end),
    timestamp: currentPeriodTimestamp,
  };
}

async function main() {
  try {
    const result = await computeAPR();

    const outputPath = join(
      __dirname,
      "../../bounties-reports/latest/vlCVX/APRs.json"
    );

    // Read existing file if it exists
    let existingData = {};
    try {
      existingData = JSON.parse(readFileSync(outputPath, "utf8"));
    } catch (error) {
      // File doesn't exist or is invalid, start fresh
    }

    // Merge new data with existing
    const updatedData = {
      ...existingData,
      votersApr: result.annualizedAPR,
    };

    writeFileSync(outputPath, JSON.stringify(updatedData, null, 2));

    console.log("\n=== Voters APR Calculation ===");
    console.log(`Period Timestamp: ${result.timestamp}`);
    console.log(`Total Voting Power: ${result.totalVotingPower.toFixed(2)}`);
    console.log(`Period Reward Value: $${result.rewardValueUSD.toFixed(2)}`);
    console.log(`CVX Price: $${result.cvxPrice.toFixed(2)}`);
    console.log(`Annualized APR: ${result.annualizedAPR.toFixed(2)}%`);
    console.log(
      `Period: ${result.periodStartBlock} - ${result.periodEndBlock}`
    );
    console.log(`APR saved to: ${outputPath}`);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
}

export { computeAPR };
