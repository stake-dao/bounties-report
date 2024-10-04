import * as dotenv from "dotenv";
import fs from "fs";
import {
  AGNOSTIC_MAINNET_TABLE,
  CVX_SPACE,
  WEEK,
  DELEGATION_ADDRESS,
} from "../utils/constants";
import {
  associateGaugesPerId,
  fetchLastProposalsIds,
  getProposal,
  getVoters,
  getVotingPower,
} from "../utils/snapshot";
import { getDelegators } from "../utils/agnostic";
import { extractCSV } from "../utils/utils";
import * as moment from "moment";
import { getAllCurveGauges } from "../utils/curveApi";

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
          if (
            tokens[tokenAddress] &&
            tokens[tokenAddress] > maxAmount
          ) {
            maxVoter = voter;
            maxAmount = tokens[tokenAddress];
          }
        });

        if (maxVoter) {
          const adjustment = reportAmount - distributionAmount;
          distribution[maxVoter].tokens[tokenAddress] += adjustment;
          console.log(
            `Adjusted ${maxVoter}'s amount by ${adjustment}`
          );
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

const main = async () => {
  console.log("Starting vlCVX repartition generation...");
  const now = moment.utc().unix();

  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;

  let stakeDaoDelegators: string[] = [];

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

  // Process votes and delegations
  console.log("Processing votes and delegations...");
  const delegationId = proposal.strategies.findIndex(
    (s: { name: string }) => s.name === "erc20-balance-of-delegation"
  );

  // Initialize delegation for all votes
  votes.forEach((vote) => {
    vote.delegation = [];
  });

  if (delegationId > -1) {
    const votesWithDelegation = votes.filter(
      (vote) => vote.vp_by_strategy[delegationId] > 0
    );
    if (votesWithDelegation.length > 0) {
      let delegators: Record<string, { delegator: string; delegate: string }> =
        {};

      for (const vote of votesWithDelegation) {
        const _delegators = await getDelegators(
          vote.voter,
          AGNOSTIC_MAINNET_TABLE,
          proposal.created,
          CVX_SPACE
        );
        const delegator_for: Record<
          string,
          { delegator: string; delegate: string }
        > = {};
        _delegators.forEach((d) => {
          delegator_for[d.toLowerCase()] = {
            delegator: d.toLowerCase(),
            delegate: vote.voter.toLowerCase(),
          };
        });
        delegators = { ...delegators, ...delegator_for };
      }

      // If a delegator voted, we remove it from the delegations
      delegators = Object.fromEntries(
        Object.entries(delegators).filter(
          ([, d]) =>
            !votes.some(
              (v) => v.voter.toLowerCase() === d.delegator.toLowerCase()
            )
        )
      );

      stakeDaoDelegators = Object.values(delegators)
        .filter(
          (d) => d.delegate.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
        )
        .map((d) => d.delegator.toLowerCase());

      const vps = await getVotingPower(
        proposal,
        Object.values(delegators).map((d) => d.delegator)
      );

      votesWithDelegation.forEach((vote) => {
        vote.delegation = Object.values(delegators)
          .filter(
            (d) =>
              d.delegate.toLowerCase() === vote.voter.toLowerCase() &&
              vps[d.delegator.toLowerCase()]
          )
          .map((d) => ({
            voter: d.delegator.toLowerCase(),
            vp: vps[d.delegator.toLowerCase()],
          }));
      });
    }
  }

  // For each voter, calculate his vp without the delegation
  // A voter can have a delegation but also owns some vp
  votes.forEach((vote) => {
    vote.vp_without_delegation =
      vote.vp -
      (vote.delegation
        ? vote.delegation.reduce(
            (acc: number, d: { vp: number }) => acc + d.vp,
            0
          )
        : 0);
    vote.totalSnapshotWeight = Object.values(
      vote.choice as Record<string, number>
    ).reduce((acc, weight) => acc + weight, 0);
  });

  // Distribute rewards
  console.log("Distributing rewards...");
  const distribution: Distribution = {};

  Object.entries(csvResult).forEach(([gauge, rewardInfo]) => {
    const choiceId = gaugePerChoiceId[gauge.toLowerCase()];

    console.log("gauge", gauge, "| choiceId", choiceId);
    if (!choiceId) throw new Error(`Choice ID not found for gauge: ${gauge}`);

    let totalVp = 0;
    let totalVpStakeDaoDelegation = 0;
    let isOnlyDelegation = true;

    votes.forEach((voter) => {
      const weight = voter.choice[choiceId.toString()];
      if (!weight) return;

      const vp = (weight * voter.vp) / voter.totalSnapshotWeight;
      totalVp += vp;

      if (
        !stakeDaoDelegators.includes(voter.voter.toLowerCase()) &&
        voter.voter.toLowerCase() !== DELEGATION_ADDRESS.toLowerCase()
      ) {
        isOnlyDelegation = false;
      }

      if (voter.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
        totalVpStakeDaoDelegation += vp;
      }
    });

    const rewardPerOneVp = isOnlyDelegation
      ? rewardInfo.rewardAmount / totalVpStakeDaoDelegation
      : rewardInfo.rewardAmount / totalVp;

    votes.forEach((voter) => {
      if (
        isOnlyDelegation &&
        voter.voter.toLowerCase() !== DELEGATION_ADDRESS.toLowerCase()
      )
        return;

      const weight = voter.choice[choiceId.toString()];
      if (!weight) return;

      const vpUsedToVote = (weight * voter.vp) / voter.totalSnapshotWeight;
      const vpShare = (vpUsedToVote * 100) / voter.vp;

      // Distribute to delegators
      voter.delegation.forEach((delegator: { voter: string; vp: number }) => {
        const amount = ((delegator.vp * vpShare) / 100) * rewardPerOneVp;
        if (amount > 0) {
          if (!distribution[delegator.voter]) {
            distribution[delegator.voter] = {
              isStakeDelegator: stakeDaoDelegators.includes(
                delegator.voter.toLowerCase()
              ),
              tokens: {},
            };
          }
          distribution[delegator.voter].tokens[rewardInfo.rewardAddress] =
            (distribution[delegator.voter].tokens[rewardInfo.rewardAddress] ||
              0) + amount;
        }
      });

      // Distribute to main voter
      const amount =
        ((voter.vp_without_delegation * vpShare) / 100) * rewardPerOneVp;
      if (amount > 0) {
        if (!distribution[voter.voter]) {
          distribution[voter.voter] = {
            isStakeDelegator: stakeDaoDelegators.includes(
              voter.voter.toLowerCase()
            ),
            tokens: {},
          };
        }
        distribution[voter.voter].tokens[rewardInfo.rewardAddress] =
          (distribution[voter.voter].tokens[rewardInfo.rewardAddress] || 0) +
          amount;
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

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
