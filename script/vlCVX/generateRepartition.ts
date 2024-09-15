import * as dotenv from "dotenv";
import fs from "fs";
import { WEEK } from "../utils/constants";
import {
  associateGaugesPerId,
  getDelegators,
  getProposal,
  getVoters,
  getVotingPower,
} from "../utils/snapshot";
import { extractCSV, ExtractCSVType } from "../utils/utils";
import * as moment from "moment";
import { getAllCurveGauges } from "../utils/curveApi";

dotenv.config();

// TODO: Replace with actual DELEGATION_ADDRESS from constants
const DELEGATION_ADDRESS = "0x68378fCB3A27D5613aFCfddB590d35a6e751972C";

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

  // Compare totals
  Object.entries(totalsDistribution).forEach(
    ([tokenAddress, distributionAmount]) => {
      const reportAmount = totalsReport[tokenAddress.toLowerCase()] || 0;
      if (distributionAmount > reportAmount) {
        throw new Error(
          `Distribution exceeds report for ${tokenAddress}: ${distributionAmount} distributed vs ${reportAmount} reported`
        );
      }
    }
  );
};

const main = async () => {
  console.log("Starting vlCVX repartition generation...");
  const now = moment.utc().unix();

  // TODO: Replace with actual timestamp calculation
  const currentPeriodTimestamp = 1725494400; // Math.floor(now / WEEK) * WEEK;

  let stakeDaoDelegators: string[] = [];

  // Fetch Curve gauges
  console.log("Fetching Curve gauges...");
  const curveGauges = await getAllCurveGauges();

  // Extract CSV report
  console.log("Extracting CSV report...");
  const csvResult = (await extractCSV(
    currentPeriodTimestamp,
    "cvx.eth"
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
  const proposalId =
    "0x7939a80a4e9eb40be5147a4be2d0c57467d12efb08005541eb56d9191194f85b";
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
      let delegators = await getDelegators(
        "cvx.eth",
        votesWithDelegation.map((v) => v.voter),
        proposal.created
      );
      delegators = delegators.filter(
        (d) =>
          !votes.some(
            (v) => v.voter.toLowerCase() === d.delegator.toLowerCase()
          )
      );

      stakeDaoDelegators = delegators
        .filter(
          (d) => d.delegate.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
        )
        .map((d) => d.delegator.toLowerCase());

      const vps = await getVotingPower(
        proposal,
        delegators.map((d) => d.delegator)
      );

      votesWithDelegation.forEach((vote) => {
        vote.delegation = delegators
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

  // Calculate voting power without delegation
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
      });

      // Distribute to main voter
      const amount =
        ((voter.vp_without_delegation * vpShare) / 100) * rewardPerOneVp;
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
    });
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
