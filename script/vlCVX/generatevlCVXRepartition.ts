import * as dotenv from "dotenv";
import fs from "fs";
import {
  abi,
  NETWORK_TO_MERKLE,
  NETWORK_TO_STASH,
  SDPENDLE_SPACE,
  SPACE_TO_NETWORK,
  SPACES,
  SPACES_IMAGE,
  SPACES_SYMBOL,
  SPACES_TOKENS,
  SPACES_UNDERLYING_TOKEN,
  WEEK,
} from "../utils/constants";
import {
  associateGaugesPerId,
  getDelegators,
  getProposal,
  getVoters,
  getVp,
} from "../utils/snapshot";
import { extractCSV, ExtractCSVType } from "../utils/utils";
import { DELEGATION_ADDRESS } from "../utils/constants";
import * as moment from "moment";
import { getGaugesInfos } from "../utils/reportUtils";
import { getAllCurveGauges } from "../utils/curveApi";

dotenv.config();

type CvxCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: number }
>;

const checkDistribution = (
  distribution: Record<string, Record<string, number>>,
  report: CvxCSVType
) => {
  // Check if we don't distribute more than what we have to distribute
  const totalsDistribution: Record<string, number> = {};
  for (const voter in distribution) {
    for (const tokenAddress in distribution[voter]) {
      if (!totalsDistribution[tokenAddress]) {
        totalsDistribution[tokenAddress] = 0;
      }
      totalsDistribution[tokenAddress] += distribution[voter][tokenAddress];
    }
  }

  console.log("Total Distribution:", totalsDistribution);

  const totalsReport: Record<string, number> = {};
  for (const [gaugeAddress, rewardInfo] of Object.entries(report)) {
    const { rewardAddress, rewardAmount } = rewardInfo;
    if (!totalsReport[rewardAddress.toLowerCase()]) {
      totalsReport[rewardAddress.toLowerCase()] = 0;
    }
    totalsReport[rewardAddress.toLowerCase()] += rewardAmount;
  }

  console.log("Total Report:", totalsReport);

  for (const tokenAddress in totalsDistribution) {
    const distributionAmount = totalsDistribution[tokenAddress];
    const reportAmount = totalsReport[tokenAddress.toLowerCase()] || 0;

    if (distributionAmount > reportAmount) {
      throw new Error(
        `Diff in the distribution for ${tokenAddress}: ${distributionAmount} distributed vs ${reportAmount} reported`
      );
    }
  }

  console.log("Distribution check passed successfully.");
};

const main = async () => {
  const now = moment.utc().unix();

  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;

  // Get curve gauges
  const curveGauges = await getAllCurveGauges();

  // Extract report before doing everything
  const csvResult = await extractCSV(currentPeriodTimestamp, "cvx.eth") as CvxCSVType;
  if (!csvResult) {
    throw new Error("No report");
  }

  // Get the proposal
  const proposalId =
    "0x7939a80a4e9eb40be5147a4be2d0c57467d12efb08005541eb56d9191194f85b";
  const proposal = await getProposal(proposalId);

  // Create a map gauge address => choice id
  const gaugePerChoiceId: Record<string, number> = associateGaugesPerId(
    proposal,
    curveGauges
  );

  console.log(proposal.strategies);

  // Get the delegation id strategy
  let delegationId = -1;
  for (let i = 0; i < proposal.strategies.length; i++) {
    if (proposal.strategies[i].name === "erc20-balance-of-delegation") {
      delegationId = i;
      break;
    }
  }

  // Get all votes
  const votes = await getVoters(proposalId);

  for (const vote of votes) {
    vote.delegation = [];
    vote.voter = vote.voter.toLowerCase();
  }

  // If we have votes based on delegations, fetch the voter vp
  if (delegationId > -1) {
    const votesWithDelegation = votes.filter(
      (vote) => vote.vp_by_strategy[delegationId] > 0
    );
    if (votesWithDelegation.length > 0) {
      // Get delegators
      let delegators = await getDelegators(
        "cvx.eth",
        votesWithDelegation.map((vote) => vote.voter),
        proposal.created
      );

      // If a delegator voted, we remove it from the delegations
      delegators = delegators.filter((delegation) => {
        const vote = votes.find(
          (vote) =>
            vote.voter.toLowerCase() === delegation.delegator.toLowerCase()
        );
        return vote === undefined;
      });

      // Get delegators vp
      const vps = await getVp(
        proposal,
        delegators.map((delegation) => delegation.delegator)
      );

      for (const vote of votesWithDelegation) {
        vote.delegation = [];
        for (const delegation of delegators) {
          if (
            delegation.delegate.toLowerCase() === vote.voter.toLowerCase() &&
            vps[delegation.delegator.toLowerCase()]
          ) {
            vote.delegation.push({
              voter: delegation.delegator.toLowerCase(),
              vp: vps[delegation.delegator.toLowerCase()],
            });
          }
        }
      }
    }
  }

  // For each voter, calculate his vp without the delegation
  // A voter can have a delegation but also owns some vp
  for (const vote of votes) {
    vote.vp_without_delegation =
      vote.vp -
      vote.delegation.reduce(
        (acc: number, delegation: any) => acc + delegation.vp,
        0
      );
    vote.totalSnapshotWeight = Object.values(vote.choice).reduce(
      (acc: any, weight: any) => acc + weight,
      0
    );
  }

  // Now we have to split rewards for all voters + delegation associated
  // Distribution is a map, key is user address, then the breadkdown <token address, amount>
  const distribution: Record<string, Record<string, number>> = {};

  for (const [gauge, rewardInfo] of Object.entries(csvResult)) {
    const choiceId = gaugePerChoiceId[gauge.toLowerCase()];

    if (!choiceId) {
      throw new Error("Choice id for " + gauge.toLowerCase() + " not found");
    }

    // Calculate the total voting power voted for this gauge
    let totalVp = 0;
    // let totalVpStakeDaoDelegation = 0; // Do not take into account delegation for now
    for (const voter of votes) {
      // Check if he voted
      const weight = voter.choice[choiceId.toString()];
      if (!weight) {
        continue;
      }

      const vp = (weight * voter.vp) / voter.totalSnapshotWeight;
      totalVp += vp;

      /*
      // Delegated vlCVX to Stake DAO
      if (voter.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
        totalVpStakeDaoDelegation += vp;
      }
      */
    }

    // Now, we have the voting power to distribute
    let rewardPerOneVp = 0;
    //if (reward.isOnlyForStakeDaoDelegation) {
    //  rewardPerOneVp = reward.amount / totalVpStakeDaoDelegation;
    // } else {
    rewardPerOneVp = rewardInfo.rewardAmount / totalVp;
    // }

    console.log(rewardInfo.rewardAmount);
    console.log(totalVp);

    for (const voter of votes) {
      /*
        // If the reward is only for stake dao delegation, we should skip the other ones
        if (
          reward.isOnlyForStakeDaoDelegation &&
          voter.voter.toLowerCase() !== DELEGATION_ADDRESS.toLowerCase()
        ) {
          continue;
        }
        */
      // Check if he voted
      const weight = voter.choice[choiceId.toString()];
      if (!weight) {
        continue;
      }

      // Calculate the global share
      const vpUsedToVote = (weight * voter.vp) / voter.totalSnapshotWeight;
      const vpShare = (vpUsedToVote * 100) / voter.vp;

      // Calculate the share for each delegator
      for (const delegator of voter.delegation) {
        const delegatorVotingPowerUsedToVote = (delegator.vp * vpShare) / 100;
        const amount = delegatorVotingPowerUsedToVote * rewardPerOneVp;

        if (!distribution[delegator.voter]) {
          distribution[delegator.voter] = {};
        }

        if (!distribution[delegator.voter][rewardInfo.rewardAddress]) {
          distribution[delegator.voter][rewardInfo.rewardAddress] = 0;
        }

        distribution[delegator.voter][rewardInfo.rewardAddress] += amount;
      }

      // And for the main voter
      const delegatorVotingPowerUsedToVote =
        (voter.vp_without_delegation * vpShare) / 100;
      const amount = delegatorVotingPowerUsedToVote * rewardPerOneVp;

      if (!distribution[voter.voter]) {
        distribution[voter.voter] = {};
      }

      if (!distribution[voter.voter][rewardInfo.rewardAddress]) {
        distribution[voter.voter][rewardInfo.rewardAddress] = 0;
      }

      distribution[voter.voter][rewardInfo.rewardAddress] += amount;
    }
  }

  // Check the amounts ditributed
  checkDistribution(distribution, csvResult);

  fs.writeFileSync("./script/vlCVX/distribution.json", JSON.stringify(distribution), {
    encoding: "utf-8",
  });

  // Add merkle generation (send tokens to Botmarket to be swapped in sdCRV ?)
  // Process --> claim, generate repartition --> (Delegation ?) -> Botmarket -> swap -> Merkle / Reward contract | (Raw voters) -> Merkle
};

main();
