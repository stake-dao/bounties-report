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
//import { DELEGATION_ADDRESS } from "../utils/constants";
import * as moment from "moment";
import { getAllCurveGauges } from "../utils/curveApi";

dotenv.config();

const DELEGATION_ADDRESS = "0x68378fCB3A27D5613aFCfddB590d35a6e751972C"; // TODO: TEST Purpose

type CvxCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: number }
>;

const checkDistribution = (
  distribution: Record<
    string,
    { isStakeDelegator: boolean; tokens: Record<string, number> }
  >,
  report: CvxCSVType
) => {
  // Check if we don't distribute more than what we have to distribute
  const totalsDistribution: Record<string, number> = {};
  for (const voter in distribution) {
    for (const tokenAddress in distribution[voter]) {
      if (!totalsDistribution[tokenAddress]) {
        totalsDistribution[tokenAddress] = 0;
      }
      totalsDistribution[tokenAddress] += distribution[voter].tokens[tokenAddress];
    }
  }

  const totalsReport: Record<string, number> = {};
  for (const [gaugeAddress, rewardInfo] of Object.entries(report)) {
    const { rewardAddress, rewardAmount } = rewardInfo;
    if (!totalsReport[rewardAddress.toLowerCase()]) {
      totalsReport[rewardAddress.toLowerCase()] = 0;
    }
    totalsReport[rewardAddress.toLowerCase()] += rewardAmount;
  }

  for (const tokenAddress in totalsDistribution) {
    const distributionAmount = totalsDistribution[tokenAddress];
    const reportAmount = totalsReport[tokenAddress.toLowerCase()] || 0;

    if (distributionAmount > reportAmount) {
      throw new Error(
        `Diff in the distribution for ${tokenAddress}: ${distributionAmount} distributed vs ${reportAmount} reported`
      );
    }
  }
};

const main = async () => {
  const now = moment.utc().unix();

  const currentPeriodTimestamp = 1725494400; // Math.floor(now / WEEK) * WEEK; // TODO : Test purpose

  let stakeDaoDelegators: string[] = []; // All addresses that delegated to Stake DAO

  // Get curve gauges
  const curveGauges = await getAllCurveGauges();

  // Extract report before doing everything
  const csvResult = (await extractCSV(
    currentPeriodTimestamp,
    "cvx.eth"
  )) as CvxCSVType;
  if (!csvResult) {
    throw new Error("No report");
  }

  // Log total per token in CSV

  let totalPerToken: Record<string, number> = {};
  for (const [gauge, rewardInfo] of Object.entries(csvResult)) {
    const { rewardAddress, rewardAmount } = rewardInfo;
    if (!totalPerToken[rewardAddress]) {
      totalPerToken[rewardAddress] = 0;
    }
    totalPerToken[rewardAddress] += rewardAmount;
  }

  console.log("Totals in CSV : ", totalPerToken);

  // Get the proposal (latest gauge vote from Convex)
  const proposalId =
    "0x7939a80a4e9eb40be5147a4be2d0c57467d12efb08005541eb56d9191194f85b";
  const proposal = await getProposal(proposalId);

  // Create a map gauge address => choice id
  const gaugePerChoiceId: Record<string, number> = associateGaugesPerId(
    proposal,
    curveGauges
  );

  // Get the delegation strategy id
  let delegationId = -1;
  for (let i = 0; i < proposal.strategies.length; i++) {
    if (proposal.strategies[i].name === "erc20-balance-of-delegation") {
      delegationId = i;
      break;
    }
  }

  // Get all votes (voters for the proposal)
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

      // For each delegator, we check if he delegated to Stake DAO
      for (const delegator of delegators) {
        if (
          delegator.delegate.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
        ) {
          stakeDaoDelegators.push(delegator.delegator.toLowerCase());
        }
      }

      // Get delegators vp
      const vps = await getVotingPower(
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
  // Distribution is a map, key is user address, then the breakdown <token address, amount, isOnlyDelegation>
  const distribution: Record<
    string,
    { isStakeDelegator: boolean; tokens: Record<string, number> }
  > = {};

  for (const [gauge, rewardInfo] of Object.entries(csvResult)) {
    const choiceId = gaugePerChoiceId[gauge.toLowerCase()];

    let isOnlyDelegation = true; // With tests, doesn't change anything to use that flag

    if (!choiceId) {
      throw new Error("Choice id for " + gauge.toLowerCase() + " not found");
    }

    // Calculate the total voting power voted for this gauge
    let totalVp = 0;
    let totalVpStakeDaoDelegation = 0;
    for (const voter of votes) {
      // Check if he voted
      const weight = voter.choice[choiceId.toString()];
      if (!weight) {
        continue;
      }

      const vp = (weight * voter.vp) / voter.totalSnapshotWeight;
      totalVp += vp;

      // If at least one voter didn't delegate, it's not only for delegation
      if (
        !stakeDaoDelegators.includes(voter.voter.toLowerCase()) &&
        voter.voter.toLowerCase() !== DELEGATION_ADDRESS.toLowerCase()
      ) {
        isOnlyDelegation = false;
      }

      // Delegated vlCVX to Stake DAO
      if (voter.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
        totalVpStakeDaoDelegation += vp;
      }
    }

    // Now, we have the voting power to distribute
    let rewardPerOneVp = 0;
    if (isOnlyDelegation) {
      rewardPerOneVp = rewardInfo.rewardAmount / totalVpStakeDaoDelegation; // With tests, doesn't change anything
    } else {
      rewardPerOneVp = rewardInfo.rewardAmount / totalVp;
    }

    for (const voter of votes) {
      // If the reward is only for Stake Dao delegation, we should skip the other ones
      if (
        isOnlyDelegation &&
        voter.voter.toLowerCase() !== DELEGATION_ADDRESS.toLowerCase()
      ) {
        continue;
      }

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
          distribution[delegator.voter] = {
            isStakeDelegator: stakeDaoDelegators.includes(
              delegator.voter.toLowerCase()
            ),
            tokens: {},
          };
        }

        if (!distribution[delegator.voter].tokens[rewardInfo.rewardAddress]) {
          distribution[delegator.voter].tokens[rewardInfo.rewardAddress] = 0;
        }

        distribution[delegator.voter].tokens[rewardInfo.rewardAddress] +=
          amount;
      }

      // And for the main voter
      const delegatorVotingPowerUsedToVote =
        (voter.vp_without_delegation * vpShare) / 100;
      const amount = delegatorVotingPowerUsedToVote * rewardPerOneVp;

      if (!distribution[voter.voter]) {
        distribution[voter.voter] = {
          isStakeDelegator: stakeDaoDelegators.includes(
            voter.voter.toLowerCase()
          ),
          tokens: {},
        };
      }

      if (!distribution[voter.voter].tokens[rewardInfo.rewardAddress]) {
        distribution[voter.voter].tokens[rewardInfo.rewardAddress] = 0;
      }
      distribution[voter.voter].tokens[rewardInfo.rewardAddress] += amount;
    }
  }

  // Check the amounts distributed
  checkDistribution(distribution, csvResult);

  let totalTokens: Record<string, number> = {};
  for (const voter of Object.keys(distribution)) {
      for (const token of Object.keys(distribution[voter].tokens)) {
          const amount = distribution[voter].tokens[token];
          if (amount) {
              if (!totalTokens[token]) {
                  totalTokens[token] = 0;
              }
              totalTokens[token] += amount;
          }
      }
  }
  console.log("Totals distributed : ", totalTokens);


  fs.writeFileSync('./distribution.json', JSON.stringify(distribution), { encoding: 'utf-8' });


  fs.writeFileSync(
    `bounties-reports/${currentPeriodTimestamp}/repartition.json`,
    JSON.stringify({ distribution }),
    {
      encoding: "utf-8",
    }
  );
};

main();
