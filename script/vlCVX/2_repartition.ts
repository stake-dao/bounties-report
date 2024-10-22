import * as dotenv from "dotenv";
import fs from "fs";
import { CVX_SPACE, WEEK, DELEGATION_ADDRESS } from "../utils/constants";
import { getAllDelegators, processAllDelegators } from "../utils/utils";
import {
  associateGaugesPerId,
  fetchLastProposalsIds,
  getProposal,
  getVoters,
  getVotingPower,
} from "../utils/snapshot";
import { extractCSV } from "../utils/utils";
import * as moment from "moment";
import { getAllCurveGauges } from "../utils/curveApi";
import { DelegatorData } from "../utils/types";

dotenv.config();

type CvxCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: number }
>;
type Distribution = Record<
  string,
  { isStakeDelegator: boolean; tokens: Record<string, number> }
>;

// Function to validate distribution against the report
const checkDistribution = (distribution: Distribution, report: CvxCSVType) => {
  const totalsDistribution: Record<string, number> = {};
  const totalsReport: Record<string, number> = {};

  // Calculate totals for distribution
  Object.values(distribution).forEach(({ tokens }) => {
    Object.entries(tokens).forEach(([tokenAddress, amount]) => {
      totalsDistribution[tokenAddress] =
        (totalsDistribution[tokenAddress] || 0) + amount;
    });
  });

  // Calculate totals for report
  Object.values(report).forEach(({ rewardAddress, rewardAmount }) => {
    totalsReport[rewardAddress.toLowerCase()] =
      (totalsReport[rewardAddress.toLowerCase()] || 0) + rewardAmount;
  });

  // Compare totals and normalize small differences
  Object.entries(totalsDistribution).forEach(
    ([tokenAddress, distributionAmount]) => {
      const reportAmount = totalsReport[tokenAddress.toLowerCase()] || 0;
      const diff = Math.abs(distributionAmount - reportAmount);

      if (diff > 0 && diff < 0.00000000001) {
        console.log(`Small difference found for ${tokenAddress}: ${diff}`);
        console.log(
          `Normalizing distribution amount from ${distributionAmount} to ${reportAmount}`
        );

        // Find the voter with the largest amount for this token and adjust their amount
        let maxVoter = "";
        let maxAmount = 0;

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


// For stake dao delegators, we want to distribute the rewards to the delegators, not to the voter
const computeStakeDaoDelegation = async (proposal: any, stakeDaoDelegators: string[], tokens: Record<string, number>) => {
  const delegationDistribution: Distribution = {};

  const vps = await getVotingPower(
    proposal,
    stakeDaoDelegators
  );

  // Compute the total vp
  const totalVp = Object.values(vps).reduce((acc, vp) => acc + vp, 0);
  console.log("totalVp", totalVp);

  // Compute the reward per user (for each token, based on the vp share of the user)
  Object.entries(tokens).forEach(([token, amount]) => {
    const rewardPerVp = amount / totalVp;
    console.log("rewardPerVp", rewardPerVp);

    // Distribute rewards to each delegator
    stakeDaoDelegators.forEach((delegator) => {
      const delegatorVp = vps[delegator] || 0;
      const delegatorReward = delegatorVp * rewardPerVp;

      if (delegatorReward > 0) {
        if (!delegationDistribution[delegator]) {
          delegationDistribution[delegator] = {
            isStakeDelegator: true,
            tokens: {},
          };
        }
        delegationDistribution[delegator].tokens[token] =
          (delegationDistribution[delegator].tokens[token] || 0) + delegatorReward;
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
      throw new Error(`Warning: Distribution mismatch for token ${token}`);
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
  const csvResult = (await extractCSV(
    currentPeriodTimestamp,
    CVX_SPACE
  )) as CvxCSVType;
  if (!csvResult) throw new Error("No CSV report found");

  // Log total rewards per token in CSV
  const totalPerToken = Object.values(csvResult).reduce(
    (acc, { rewardAddress, rewardAmount }) => {
      acc[rewardAddress] = (acc[rewardAddress] || 0) + rewardAmount;
      return acc;
    },
    {} as Record<string, number>
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
    const allDelegators = await getAllDelegators(DELEGATION_ADDRESS, "1", [CVX_SPACE]);
    const cvxDelegators = allDelegators[CVX_SPACE];
    const cvxDelegatorsData: Record<string, DelegatorData[]> = {
      'cvx.eth': cvxDelegators
    };
    stakeDaoDelegators = processAllDelegators(cvxDelegatorsData, CVX_SPACE, currentPeriodTimestamp);

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

    console.log("totalVp", totalVp);

    const rewardPerOneVp = rewardInfo.rewardAmount / totalVp;

    Object.entries(voterVps).forEach(([voter, vp]) => {
      const amount = vp * rewardPerOneVp;
      if (amount > 0) {
        if (!distribution[voter]) {
          distribution[voter] = {
            isStakeDelegator: false,
            tokens: {},
          };
        }
        distribution[voter].tokens[rewardInfo.rewardAddress] =
          (distribution[voter].tokens[rewardInfo.rewardAddress] || 0) + amount;
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
    `${dirPath}/repartition.json`,
    JSON.stringify({ distribution }, null, 2)
  );

  console.log("vlCVX repartition generation completed successfully.");
};

// Make sure to call main as an async function
main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
