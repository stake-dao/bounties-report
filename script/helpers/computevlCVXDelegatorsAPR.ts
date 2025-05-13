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
import { extractCSV } from "../utils/utils";
import { getClosestBlockTimestamp } from "../utils/chainUtils";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";
import { ALL_MIGHT, REWARDS_ALLOCATIONS_POOL } from "../utils/reportUtils";
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { processAllDelegators } from "../utils/cacheUtils";
import { getAllRewardsForDelegators } from "./utils";
import {
  getHistoricalTokenPrices,
  TokenIdentifier,
  LLAMA_NETWORK_MAPPING,
} from "../utils/priceUtils";
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
  chainId: number;
}

type CvxCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: bigint; chainId?: number }[]
>;

interface ChainDelegationData {
  totalTokens: Record<string, string>;
  totalPerGroup: Record<
    string,
    {
      forwarders: string;
      nonForwarders: string;
    }
  >;
}

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

const skippedUsers = new Set([
  getAddress("0xe001452BeC9e7AC34CA4ecaC56e7e95eD9C9aa3b"), // Bent
]);

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
    const normalizedSkippedUser = getAddress(skippedUser);
    if (delegatorVotingPowers[normalizedSkippedUser]) {
      delegationVPSDT -= delegatorVotingPowers[normalizedSkippedUser];
      console.log(
        `Subtracted ${delegatorVotingPowers[normalizedSkippedUser].toFixed(
          2
        )} VP from skipped user ${normalizedSkippedUser}`
      );
    } else {
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

  // Get Thursday rewards (from getAllRewardsForDelegators)
  const thursdayRewards = getAllRewardsForDelegators(currentPeriodTimestamp);
  console.log("Thursday rewards:", thursdayRewards.chainRewards);

  // Get swapped delegator rewards (already on merkle)
  const currentBlock = Number(await publicClient.getBlockNumber());
  const minBlock = await getClosestBlockTimestamp(
    "ethereum",
    currentPeriodTimestamp
  );
  const swappedDelegRewards = await getRewards(
    minBlock,
    currentBlock,
    REWARD_TOKENS
  );

  // Calculate total delegator rewards by combining Thursday rewards and swapped deleg rewards
  const totalDelegatorsRewards = { ...thursdayRewards };

  // Add swapped deleg rewards to Ethereum chain
  for (const reward of swappedDelegRewards) {
    const normalizedAddress = getAddress(reward.token);
    if (!totalDelegatorsRewards.chainRewards[1]) {
      totalDelegatorsRewards.chainRewards[1] = {
        rewards: {},
        rewardsPerGroup: { forwarders: {}, nonForwarders: {} },
      };
    }
    totalDelegatorsRewards.chainRewards[1].rewardsPerGroup.nonForwarders[
      normalizedAddress
    ] =
      (totalDelegatorsRewards.chainRewards[1].rewardsPerGroup.nonForwarders[
        normalizedAddress
      ] || 0n) + reward.amount;
  }

  console.log(
    "Total delegators rewards (Ethereum):",
    totalDelegatorsRewards.chainRewards[1]?.rewardsPerGroup.nonForwarders
  );

  // Create a Set of forwarder addresses for efficient lookup
  const forwardersSet = new Set(
    thursdayRewards.forwarders.map((addr) => addr.toLowerCase())
  );

  // Calculate delegationVPForwarders by only including voting power from forwarders
  let delegationVPForwarders = 0;
  for (const [address, votingPower] of Object.entries(delegatorVotingPowers)) {
    if (forwardersSet.has(address.toLowerCase())) {
      delegationVPForwarders += votingPower;
      console.log(
        `Including forwarder ${address} with VP: ${votingPower.toFixed(2)}`
      );
    }
  }

  console.log(`Total forwarders VP: ${delegationVPForwarders.toFixed(2)}`);

  // Prepare token identifiers for price fetching
  const tokenIdentifiers: TokenIdentifier[] = [];
  for (const [chainId, chainData] of Object.entries(
    totalDelegatorsRewards.chainRewards
  )) {
    const tokens = Object.keys(chainData.rewardsPerGroup.nonForwarders);
    if (tokens.length > 0) {
      tokens.forEach((address) => {
        tokenIdentifiers.push({
          chainId: Number(chainId),
          address: getAddress(address),
        });
      });
    }
  }

  // Fetch all prices at once for current period
  const prices = await getHistoricalTokenPrices(
    tokenIdentifiers,
    currentPeriodTimestamp
  );
  console.log("prices", prices);

  // Get CVX price separately at proposal start timestamp
  const cvxPriceResponse = await getHistoricalTokenPrices(
    [{ chainId: 1, address: getAddress(CVX) }],
    Number(proposal.start)
  );
  console.log("cvxPriceResponse", cvxPriceResponse);
  const cvxPrice = cvxPriceResponse[`ethereum:${CVX.toLowerCase()}`];
  if (!cvxPrice) {
    throw new Error(`CVX price not found at timestamp ${proposal.start}`);
  }
  console.log("cvxPrice", cvxPrice);

  // Calculate individual token reward values
  const tokenRewardValues: Record<string, number> = {};
  let rewardValueUSD = 0;
  let rewardValueUSDWithoutSDT = 0;

  // Calculate values for each token using chain-specific prices
  for (const [key, price] of Object.entries(prices)) {
    const [network, address] = key.split(":");
    const chainId = Object.entries(LLAMA_NETWORK_MAPPING).find(
      ([_, n]) => n === network
    )?.[0];
    if (!chainId) continue;

    const chainIdNum = Number(chainId);
    const tokenAmount =
      totalDelegatorsRewards.chainRewards[chainIdNum]?.rewardsPerGroup
        .nonForwarders[getAddress(address)] || 0n;

    const valueUSD = price * (Number(tokenAmount) / Math.pow(10, 18)); // Assuming 18 decimals

    tokenRewardValues[address] = valueUSD;
    rewardValueUSD += valueUSD;

    // Exclude SDT from the without-SDT calculation
    if (address.toLowerCase() !== SDT.toLowerCase()) {
      rewardValueUSDWithoutSDT += valueUSD;
    }
  }

  // Log token reward values
  console.log("tokenRewardValues", tokenRewardValues);
  console.log("Total rewardValueUSD:", rewardValueUSD);

  // Calculate APRs for individual tokens
  const sdtValue = tokenRewardValues[SDT.toLowerCase()] || 0;

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
    delegationVotingPower,
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
