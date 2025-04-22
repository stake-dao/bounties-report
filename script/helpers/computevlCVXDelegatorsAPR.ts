import {
  createPublicClient,
  http,
  formatEther,
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
  getVotingPower,
} from "../utils/snapshot";
import { getAllCurveGauges } from "../utils/curveApi";
import {
  DELEGATION_ADDRESS,
  CVX_SPACE,
  WEEK,
  VLCVX_DELEGATORS_MERKLE,
  CRVUSD,
  SDT,
  CVX,
} from "../utils/constants";
import { extractCSV, getHistoricalTokenPrice } from "../utils/utils";
import { getClosestBlockTimestamp } from "../utils/chainUtils";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";
import { ALL_MIGHT, REWARDS_ALLOCATIONS_POOL } from "../utils/reportUtils";
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { processAllDelegators } from "../utils/cacheUtils";
import { getAllRewardsForDelegators } from "./utils";
const REWARD_TOKENS = [CRVUSD, SDT];

interface APRResult {
  totalVotingPower: number;
  delegationVotingPower: number;
  delegationShare: number;
  rewardValueUSD: number;
  cvxPrice: number;
  annualizedAPR: number;
  periodStartBlock: number;
  periodEndBlock: number;
  timestamp: number;
  sdtAPR: number;
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

const skippedUsers = new Set([
  getAddress("0xe001452BeC9e7AC34CA4ecaC56e7e95eD9C9aa3b"), // Bent
]);

async function getTokenPrices(
  tokens: string[],
  currentPeriodTimestamp: number
): Promise<TokenPrice[]> {
  const prices = await Promise.all(
    tokens.map(async (token) => {
      const price = await getHistoricalTokenPrice(
        currentPeriodTimestamp,
        "ethereum",
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

  const paddedAllMight = pad(ALL_MIGHT as `0x${string}`, {
    size: 32,
  }).toLowerCase();
  const paddedRewardsAllocationsPool = pad(
    REWARDS_ALLOCATIONS_POOL as `0x${string}`,
    {
      size: 32,
    }
  ).toLowerCase();
  const paddedVlcvxRecipient = pad(VLCVX_DELEGATORS_MERKLE as `0x${string}`, {
    size: 32,
  }).toLowerCase();

  // Query for transfers from ALL_MIGHT
  const topicsAllMight = {
    "0": transferHash,
    "1": paddedAllMight,
    "2": paddedVlcvxRecipient,
  };

  // Query for transfers from REWARDS_ALLOCATIONS_POOL
  const topicsRewardsAllocationsPool = {
    "0": transferHash,
    "1": paddedRewardsAllocationsPool,
    "2": paddedVlcvxRecipient,
  };

  const [responseAllMight, responseRewardsAllocationsPool] = await Promise.all([
    explorerUtils.getLogsByAddressesAndTopics(
      tokens,
      startBlock,
      endBlock,
      topicsAllMight,
      1
    ),
    explorerUtils.getLogsByAddressesAndTopics(
      tokens,
      startBlock,
      endBlock,
      topicsRewardsAllocationsPool,
      1
    ),
  ]);

  const allResults = [
    ...responseAllMight.result,
    ...responseRewardsAllocationsPool.result,
  ];

  if (allResults.length === 0) {
    throw new Error("No token transfers found");
  }

  return allResults.map((transfer) => {
    const [amount] = decodeAbiParameters([{ type: "uint256" }], transfer.data);

    return {
      token: transfer.address.toLowerCase(),
      amount: BigInt(amount),
      blockNumber: parseInt(transfer.blockNumber, 16),
    };
  });
}

async function computeAPR(): Promise<
  APRResult & {
    annualizedAPRWithoutSDT: number;
    sdtAPR: number;
  }
> {
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
  const gauges = Object.keys(csvResult);
  console.log(`Found ${gauges.length} gauges in report`);

  // Fetch last proposal
  console.log("Fetching latest proposal...");
  const filter: string = "^(?!FXN ).*Gauge Weight for Week of";
  const proposalIdPerSpace = await fetchLastProposalsIds(
    [CVX_SPACE],
    now,
    filter
  );
  // Try to find the address with different casing
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

  // Get delegators and their voting powers
  console.log("Fetching delegator data...");
  const delegators = await processAllDelegators(
    CVX_SPACE,
    proposal.created,
    DELEGATION_ADDRESS
  );
  const delegatorVotingPowers = await getVotingPower(proposal, delegators);

  // Calculate delegationVPSDT by subtracting skipped users' voting power
  let delegationVPSDT = delegationVotingPower;
  for (const skippedUser of skippedUsers) {
    // Normalize the skipped user address
    const normalizedSkippedUser = getAddress(skippedUser);

    // Check if this user exists in the delegator voting powers
    if (delegatorVotingPowers[normalizedSkippedUser]) {
      delegationVPSDT -= delegatorVotingPowers[normalizedSkippedUser];
      console.log(
        `Subtracted ${delegatorVotingPowers[normalizedSkippedUser].toFixed(
          2
        )} VP from skipped user ${normalizedSkippedUser}`
      );
    } else {
      // Try to find the address with different casing
      const foundAddress = Object.keys(delegatorVotingPowers).find(
        (addr) => addr.toLowerCase() === normalizedSkippedUser.toLowerCase()
      );

      if (foundAddress) {
        delegationVPSDT -= delegatorVotingPowers[foundAddress];
        console.log(
          `Found and subtracted ${delegatorVotingPowers[foundAddress].toFixed(
            2
          )} VP from skipped user ${foundAddress}`
        );
      }
    }
  }

  // Get all rewards on the Week received by the Merkles
  // Get block numbers
  const currentBlock = Number(await publicClient.getBlockNumber());
  const minBlock = await getClosestBlockTimestamp(
    "ethereum",
    currentPeriodTimestamp
  );
  const rewards = await getRewards(minBlock, currentBlock, REWARD_TOKENS);

  // First, calculate sumPerToken from the rewards array
  const sumPerToken = rewards.reduce((acc, reward) => {
    const normalizedAddress = getAddress(reward.token);
    acc[normalizedAddress] = (acc[normalizedAddress] || 0n) + reward.amount;
    return acc;
  }, {} as Record<string, bigint>);

  console.log("sumPerToken", sumPerToken);

  // Get Thursday rewards and merge them with sumPerToken
  const thursdayRewards = getAllRewardsForDelegators(currentPeriodTimestamp);

  console.log("thursdayRewards", thursdayRewards.rewards);
  console.log("thursdayForwarders", thursdayRewards.forwarders);

  // Create a Set of forwarder addresses for efficient lookup
  const forwardersSet = new Set(thursdayRewards.forwarders.map(addr => addr.toLowerCase()));

  // Calculate delegationVPForwarders by only including voting power from forwarders
  let delegationVPForwarders = 0;
  for (const [address, votingPower] of Object.entries(delegatorVotingPowers)) {
    if (forwardersSet.has(address.toLowerCase())) {
      delegationVPForwarders += votingPower;
      console.log(`Including forwarder ${address} with VP: ${votingPower.toFixed(2)}`);
    }
  }

  console.log(`Total forwarders VP: ${delegationVPForwarders.toFixed(2)}`);
  
  // TODO : Add side delegs tokens
  // Properly merge Thursday rewards with sumPerToken
  for (const [token, amount] of Object.entries(thursdayRewards.rewards)) {
    const normalizedAddress = getAddress(token);
    sumPerToken[normalizedAddress] =
      (sumPerToken[normalizedAddress] || 0n) + amount;
  }

  const tokens = Object.keys(sumPerToken);
  const prices = await getTokenPrices(tokens, currentPeriodTimestamp);

  const cvxPriceResponse = await getTokenPrices([CVX], Number(proposal.start)); // Price at the snapshot
  const cvxPrice = cvxPriceResponse[0].price;

  // Calculate individual token reward values
  const tokenRewardValues: Record<string, number> = {};
  let rewardValueUSD = 0;
  let rewardValueUSDWithoutSDT = 0;

  for (const price of prices) {
    const tokenAmount = sumPerToken[getAddress(price.address)] || 0n;
    const valueUSD =
      price.price * (Number(tokenAmount) / Math.pow(10, price.decimals));

    tokenRewardValues[price.address] = valueUSD;
    rewardValueUSD += valueUSD;

    // Exclude SDT from the without-SDT calculation
    if (price.address.toLowerCase() !== SDT.toLowerCase()) {
      rewardValueUSDWithoutSDT += valueUSD;
    }
  }
  // TODO : remove, side chains rewards
  rewardValueUSD += 5000; // EYWA non forwarders
  rewardValueUSD += 2917; // Base CRV non forwarders

  // Calculate APRs for individual tokens
  const sdtValue = tokenRewardValues[getAddress(SDT)] || 0;

  // Calculate total non-SDT rewards
  const nonSdtValue = rewardValueUSD - sdtValue;

  const annualizedSDT = sdtValue * 52;
  const annualizedNonSDT = nonSdtValue * 52;

  // Use delegationVPForwarders for SDT APR calculation only
  const sdtAPR = (annualizedSDT / (cvxPrice * delegationVPForwarders)) * 100;
  
  // Use regular delegationVotingPower for non-SDT APR calculation
  const nonSdtAPR =
    (annualizedNonSDT / (cvxPrice * delegationVotingPower)) * 100;

  // Calculate total APRs
  const annualizedAPR = sdtAPR + nonSdtAPR; // Sum of individual APRs
  const annualizedAPRWithoutSDT = nonSdtAPR; // All APRs except SDT

  console.log("SDT Value:", sdtValue);
  console.log("Non-SDT Value:", nonSdtValue);
  console.log("SDT APR (using forwarders VP):", sdtAPR.toFixed(2) + "%");
  console.log("Non-SDT APR (using regular VP):", nonSdtAPR.toFixed(2) + "%");
  console.log("Total APR:", annualizedAPR.toFixed(2) + "%");

  return {
    totalVotingPower,
    delegationVotingPower, // Keep using regular VP for the return value
    delegationShare: delegationVotingPower / totalVotingPower,
    rewardValueUSD,
    cvxPrice,
    annualizedAPR,
    annualizedAPRWithoutSDT,
    sdtAPR,
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
      delegatorsApr: result.annualizedAPR,
      delegatorsAprWithoutSDT: result.annualizedAPRWithoutSDT,
    };

    writeFileSync(outputPath, JSON.stringify(updatedData, null, 2));

    console.log("\n=== Delegation APR Calculation ===");
    console.log(`Period Timestamp: ${result.timestamp}`);
    console.log(`Total Voting Power: ${result.totalVotingPower.toFixed(2)}`);
    console.log(
      `Delegation Voting Power: ${result.delegationVotingPower.toFixed(2)}`
    );
    console.log(
      `Delegation Share: ${(result.delegationShare * 100).toFixed(2)}%`
    );
    console.log(`Period Reward Value: $${result.rewardValueUSD.toFixed(2)}`);
    console.log(`CVX Price: $${result.cvxPrice.toFixed(2)}`);
    console.log(`SDT APR: ${result.sdtAPR.toFixed(2)}%`);
    console.log(`Total Annualized APR: ${result.annualizedAPR.toFixed(2)}%`);
    console.log(
      `Annualized APR (without SDT): ${result.annualizedAPRWithoutSDT.toFixed(
        2
      )}%`
    );
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
