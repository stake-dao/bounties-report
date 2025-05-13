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
  CVX,
} from "../utils/constants";
import { extractCSV } from "../utils/utils";
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { getAllRewardsForVotersOnChain, computeAnnualizedAPR } from "./utils";
import {
  getHistoricalTokenPrices,
  TokenIdentifier,
} from "../utils/priceUtils";

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
          currentChoiceIndex = Number(value);
        }
        vpChoiceSum += Number(value);
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
  const allRewards = getAllRewardsForVotersOnChain(1, currentPeriodTimestamp);
  const tokens = Object.keys(allRewards);

  // Prepare token identifiers for price fetching
  const tokenIdentifiers: TokenIdentifier[] = tokens.map(token => ({
    chainId: 1,
    address: getAddress(token)
  }));

  // Fetch all prices at once
  const prices = await getHistoricalTokenPrices(tokenIdentifiers, currentPeriodTimestamp);

  // Get CVX price at proposal start timestamp
  const cvxPriceResponse = await getHistoricalTokenPrices(
    [{ chainId: 1, address: getAddress(CVX) }],
    Number(proposal.start)
  );
  const cvxPrice = cvxPriceResponse[`ethereum:${CVX.toLowerCase()}`];
  if (!cvxPrice) {
    throw new Error(`CVX price not found at timestamp ${proposal.start}`);
  }

  // Calculate total reward value in USD
  let rewardValueUSD = 0;
  for (const token of tokens) {
    const key = `ethereum:${token.toLowerCase()}`;
    const price = prices[key] || 0;
    const amount = allRewards[token] || 0n;
    rewardValueUSD += price * (Number(amount) / 1e18);
  }

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
