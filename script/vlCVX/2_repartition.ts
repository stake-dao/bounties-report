import * as dotenv from "dotenv";
import fs from "fs";
import { CVX_SPACE, WEEK, DELEGATION_ADDRESS } from "../utils/constants";
import {
  associateGaugesPerId,
  fetchLastProposalsIds,
  getProposal,
  getVoters,
  getVotingPower,
} from "../utils/snapshot";
import { extractCVXCSV } from "../utils/utils";
import * as moment from "moment";
import { getAllCurveGauges } from "../utils/curveApi";
import { processAllDelegators } from "../utils/cacheUtils";

dotenv.config();

type CvxCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: bigint }
>;
type Distribution = Record<
  string,
  { isStakeDelegator: boolean; tokens: Record<string, bigint> }
>;

// Function to validate distribution against the report
const checkDistribution = (distribution: Distribution, report: CvxCSVType) => {
  const totalsDistribution: Record<string, bigint> = {};
  const totalsReport: Record<string, bigint> = {};

  // Calculate totals for distribution
  Object.values(distribution).forEach(({ tokens }) => {
    Object.entries(tokens).forEach(([tokenAddress, amount]) => {
      totalsDistribution[tokenAddress] =
        (totalsDistribution[tokenAddress] || BigInt(0)) + BigInt(amount);
    });
  });

  // Calculate totals for report
  Object.values(report).forEach(({ rewardAddress, rewardAmount }) => {
    totalsReport[rewardAddress.toLowerCase()] =
      (totalsReport[rewardAddress.toLowerCase()] || BigInt(0)) + rewardAmount;
  });

  // Compare totals and normalize small differences
  Object.entries(totalsDistribution).forEach(
    ([tokenAddress, distributionAmount]) => {
      const reportAmount =
        totalsReport[tokenAddress.toLowerCase()] || BigInt(0);
      const diff = distributionAmount - reportAmount;

      if (diff > 0 && diff < BigInt(0.00000000001)) {
        console.log(`Small difference found for ${tokenAddress}: ${diff}`);
        console.log(
          `Normalizing distribution amount from ${distributionAmount} to ${reportAmount}`
        );

        // Find the voter with the largest amount for this token and adjust their amount
        let maxVoter = "";
        let maxAmount = BigInt(0);

        Object.entries(distribution).forEach(([voter, { tokens }]) => {
          if (tokens[tokenAddress] && tokens[tokenAddress] > maxAmount) {
            maxVoter = voter;
            maxAmount = tokens[tokenAddress];
          }
        });

        if (maxVoter) {
          const adjustment = reportAmount - distributionAmount;
          distribution[maxVoter].tokens[tokenAddress] += adjustment;
          console.log(`Adjusted ${maxVoter}'s amount by ${adjustment}`);
        }

        totalsDistribution[tokenAddress] = reportAmount;
      } else if (distributionAmount > reportAmount) {
        throw new Error(
          `Distribution exceeds report for ${tokenAddress}: ${distributionAmount} distributed vs ${reportAmount} reported`
        );
      }
    }
  );

  console.log("Distribution totals:", totalsDistribution);
  console.log("Report totals:", totalsReport);
};

// TODO : just compute vp for each stake dao delegator. And we will use that share for sdCRV repartition
// For stake dao delegators, we want to distribute the rewards to the delegators, not to the voter
const computeStakeDaoDelegation = async (
  proposal: any,
  stakeDaoDelegators: string[],
  tokens: Record<string, bigint>
) => {
  const delegationDistribution: Distribution = {};

  const vps = await getVotingPower(proposal, stakeDaoDelegators);

  // Compute the total vp with 18 decimals precision
  const totalVpBigInt = BigInt(
    Math.floor(Object.values(vps).reduce((acc, vp) => acc + vp, 0) * 1e18)
  );

  // Process each token
  Object.entries(tokens).forEach(([token, amount]) => {
    let remainingRewards = BigInt(Math.floor(amount));
    let processedDelegators = 0;
    const totalDelegators = stakeDaoDelegators.length;

    // Distribute rewards to each delegator
    stakeDaoDelegators.forEach((delegator) => {
      processedDelegators++;
      const delegatorVp = vps[delegator] || 0;
      const delegatorVpBigInt = BigInt(Math.floor(delegatorVp * 1e18));

      let delegatorReward: bigint;
      if (processedDelegators === totalDelegators) {
        // Last delegator gets remaining rewards to avoid dust
        delegatorReward = remainingRewards;
      } else {
        // Calculate proportional amount
        delegatorReward =
          (BigInt(Math.floor(amount)) * delegatorVpBigInt) / totalVpBigInt;
        remainingRewards -= delegatorReward;
      }

      if (delegatorReward > 0n) {
        if (!delegationDistribution[delegator]) {
          delegationDistribution[delegator] = {
            isStakeDelegator: true,
            tokens: {},
          };
        }
        delegationDistribution[delegator].tokens[token] =
          (delegationDistribution[delegator].tokens[token] || 0) +
          Number(delegatorReward);
      }
    });
  });

  // Verify total distribution matches original amount
  Object.entries(tokens).forEach(([token, originalAmount]) => {
    const distributedAmount = Object.values(delegationDistribution).reduce(
      (acc, { tokens }) => acc + (tokens[token] || 0),
      0
    );
    if (Math.abs(originalAmount - distributedAmount) > 0.000000001) {
      throw new Error(
        `Warning: Distribution mismatch for token ${token}. Original: ${originalAmount}, Distributed: ${distributedAmount}`
      );
    }
  });

  return delegationDistribution;
};

const main = async () => {
  console.log("Starting vlCVX repartition generation...");
  const now = moment.utc().unix();

  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;

  // Fetch Curve gauges
  console.log("Fetching Curve gauges...");
  const curveGauges = await getAllCurveGauges();

  // Extract CSV report
  console.log("Extracting CSV report...");
  const csvResult = (await extractCVXCSV(
    currentPeriodTimestamp,
    CVX_SPACE
  )) as CvxCSVType;
  if (!csvResult) throw new Error("No CSV report found");

  console.log("csvResult", csvResult);

  /*
  // Log total rewards per token in CSV
  const totalPerToken = Object.values(csvResult).reduce(
    (acc, { rewardAddress, rewardAmount }) => {
      acc[rewardAddress] = (acc[rewardAddress] || BigInt(0)) + rewardAmount;
      return acc;
    },
    {} as Record<string, bigint>
  );
  console.log("Total rewards per token in CSV:", totalPerToken);

  // Fetch proposal and votes
  console.log("Fetching proposal and votes...");
  const filter: string = "^(?!FXN ).*Gauge Weight for Week of";
  const proposalIdPerSpace = await fetchLastProposalsIds(
    [CVX_SPACE],
    now,
    filter
  );
  const proposalId = proposalIdPerSpace[CVX_SPACE];
  console.log("proposalId", proposalId);

  const proposal = await getProposal(proposalId);
  const gaugePerChoiceId = associateGaugesPerId(proposal, curveGauges);
  const votes = await getVoters(proposalId);

  // Fetch StakeDAO delegators
  console.log("Fetching StakeDAO delegators...");
  // Only if delegation address is one of the voters
  const isDelegationAddressVoter = votes.some((voter) => voter.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase());
  let stakeDaoDelegators: string[] = [];

  if (isDelegationAddressVoter) {
    console.log("Delegation address is one of the voters, fetching StakeDAO delegators");
    stakeDaoDelegators = await processAllDelegators(CVX_SPACE, currentPeriodTimestamp, DELEGATION_ADDRESS);

    // If one of the delegators vote by himself, we need to remove him from the list
    for (const delegator of stakeDaoDelegators) {
      if (votes.some((voter) => voter.voter.toLowerCase() === delegator.toLowerCase())) {
        stakeDaoDelegators = stakeDaoDelegators.filter((d) => d.toLowerCase() !== delegator.toLowerCase());
      }
    }

  } else {
    console.log("Delegation address is not one of the voters, skipping StakeDAO delegators computation");
  }
  // Distribute rewards
  console.log("Distributing rewards...");
  const distribution: Distribution = {};

  Object.entries(csvResult).forEach(([gauge, rewardInfo]) => {
    const choiceId = gaugePerChoiceId[gauge.toLowerCase()];
    console.log("gauge", gauge, "| choiceId", choiceId);
    if (!choiceId) throw new Error(`Choice ID not found for gauge: ${gauge}`);

    let totalVp = 0;
    const voterVps: Record<string, number> = {};

    votes.forEach((voter) => {
      const weight = voter.choice[choiceId.toString()];
      if (!weight) return;

      const vp = weight * voter.vp;
      totalVp += vp;
      voterVps[voter.voter] = vp;
    });

    // Convert totalVp to BigInt with 18 decimals precision
    const totalVpBigInt = BigInt(Math.floor(totalVp * 1e18));
    
    let remainingRewards = rewardInfo.rewardAmount;
    let processedVoters = 0;
    const totalVoters = Object.keys(voterVps).length;

    Object.entries(voterVps).forEach(([voter, vp]) => {
      processedVoters++;
      // Convert vp to BigInt with same precision
      const vpBigInt = BigInt(Math.floor(vp * 1e18));
      
      let amount: bigint;
      if (processedVoters === totalVoters) {
        // Last voter gets remaining rewards to avoid dust
        amount = remainingRewards;
      } else {
        // Calculate proportional amount
        amount = (rewardInfo.rewardAmount * vpBigInt) / totalVpBigInt;
        remainingRewards -= amount;
      }

      if (amount > 0n) {
        if (!distribution[voter]) {
          distribution[voter] = {
            isStakeDelegator: false,
            tokens: {},
          };
        }
        distribution[voter].tokens[rewardInfo.rewardAddress] =
          (distribution[voter].tokens[rewardInfo.rewardAddress] || 0) + Number(amount);
      }
    });
  });

  // Remove any entries with zero amounts
  Object.keys(distribution).forEach((voter) => {
    const nonZeroTokens = Object.entries(distribution[voter].tokens).filter(
      ([, amount]) => amount > 0
    );
    if (nonZeroTokens.length === 0) {
      delete distribution[voter];
    } else {
      distribution[voter].tokens = Object.fromEntries(nonZeroTokens);
    }
  });


  // Compute StakeDAO delegator rewards
  console.log("Computing StakeDAO delegator rewards...");
  if (isDelegationAddressVoter && stakeDaoDelegators.length > 0) {
    const stakeDaoPromises = Object.entries(distribution).map(async ([voter, { tokens }]) => {
      if (voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
        const stakeDaoDelegation = await computeStakeDaoDelegation(proposal, stakeDaoDelegators, tokens);
        Object.entries(stakeDaoDelegation).forEach(([delegator, { tokens }]) => {
          if (!distribution[delegator]) {
            distribution[delegator] = {
              isStakeDelegator: true,
              tokens: {},
            };
          }
          distribution[delegator].tokens = { ...distribution[delegator].tokens, ...tokens };
        });
        // Remove the original delegatee
        delete distribution[voter];
      }
    });

    // Wait for all stake dao computations to complete
    await Promise.all(stakeDaoPromises);
  } else {
    console.log("Skipping StakeDAO delegation computation");
  }

  // Validate distribution
  console.log("Validating distribution...");
  checkDistribution(distribution, csvResult);

  // Calculate and log total tokens distributed
  const roundToDecimals = (num: number, decimals: number): number => {
    return Number(num.toFixed(decimals));
  };

  // Calculate and log total tokens distributed
  const totalTokensDistributed = Object.values(distribution).reduce(
    (acc, { tokens }) => {
      Object.entries(tokens).forEach(([token, amount]) => {
        if (amount) {
          const roundedAmount = roundToDecimals(amount, 18); // Adjust decimal places as needed
          acc[token] = roundToDecimals((acc[token] || 0) + roundedAmount, 18);
        }
      });
      return acc;
    },
    {} as Record<string, number>
  );

  console.log("Total tokens distributed:");
  console.log(totalTokensDistributed);

  // Save distribution to file
  console.log("Saving distribution to file...");
  const dirPath = `bounties-reports/${currentPeriodTimestamp}/vlCVX`;
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(
    `${dirPath}/repartition_bis.json`,
    JSON.stringify({ distribution }, null, 2)
  );
  */
  console.log("vlCVX repartition generation completed successfully.");
};

// Make sure to call main as an async function
main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
