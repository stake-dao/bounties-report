import * as dotenv from "dotenv";
import fs from "fs";
import {
  WEEK,
  DELEGATION_ADDRESS,
  SPECTRA_SPACE,
} from "../utils/constants";
import {
  getLastClosedProposal,
  getVoters,
  getVotingPower,
} from "../utils/snapshot";
import { CvxCSVType, extractCSV } from "../utils/utils";
import * as moment from "moment";
import { processAllDelegators } from "../utils/cacheUtils";
import { Distribution } from "./3_merkles";
import { getAddress } from "viem";

dotenv.config();

const main = async () => {
  console.log("Starting Spectra repartition generation...");
  const now = moment.utc().unix();
  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;

  // Extract CSV report
  console.log("Extracting CSV report...");
  const _csvResult = (await extractCSV(
    currentPeriodTimestamp,
    SPECTRA_SPACE
  ));
  if (!_csvResult) throw new Error("No CSV report found");

  const csvResult = _csvResult as CvxCSVType;

  // Fetch proposal and votes
  console.log("Fetching proposal and votes...");
  const proposal = await getLastClosedProposal(SPECTRA_SPACE);
  console.log(proposal)
  const proposalId = proposal.id;
  console.log("proposalId", proposalId);

  const votes = await getVoters(proposalId);

  // Fetch StakeDAO delegators
  console.log("Fetching StakeDAO delegators...");
  // Only if delegation address is one of the voters
  const isDelegationAddressVoter = votes.some(
    (voter) => voter.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
  );
  let stakeDaoDelegators: string[] = [];

  if (isDelegationAddressVoter) {
    console.log(
      "Delegation address is one of the voters, fetching StakeDAO delegators"
    );
    stakeDaoDelegators = await processAllDelegators(
      SPECTRA_SPACE,
      proposal.created,
      DELEGATION_ADDRESS
    );

    // If one of the delegators vote by himself, we need to remove him from the list
    for (const delegator of stakeDaoDelegators) {
      if (
        votes.some(
          (voter) => voter.voter.toLowerCase() === delegator.toLowerCase()
        )
      ) {
        stakeDaoDelegators = stakeDaoDelegators.filter(
          (d) => d.toLowerCase() !== delegator.toLowerCase()
        );
      }
    }

    console.log("stakeDaoDelegators", stakeDaoDelegators);
  } else {
    console.log(
      "Delegation address is not one of the voters, skipping StakeDAO delegators computation"
    );
  }
  // Distribute rewards
  console.log("Distributing rewards...");
  const distribution: Distribution = {};

  Object.entries(csvResult).forEach(([gauge, rewardInfos]) => {
    let choiceId = (proposal.choices as string[]).findIndex((choice: string) => choice.toLowerCase() === gauge.toLowerCase());
    if(choiceId === -1) {
      throw new Error(`Choice ID not found for gauge: ${gauge}`);
    }
    choiceId += 1 // + 1 because when you vote for the first gauge, id starts at 1 and not 0

    let totalVp = 0;

    const voterVps: Record<string, number> = {};

    // First calculate total VP for the gauge
    votes.forEach((voter) => {
      let vpChoiceSum = 0;
      let currentChoiceIndex = 0;

      for (const choiceIndex of Object.keys(voter.choice)) {
        if (choiceId === parseInt(choiceIndex)) {
          currentChoiceIndex = voter.choice[choiceIndex];
        }
        vpChoiceSum += voter.choice[choiceIndex];
      }

      if (currentChoiceIndex === 0) {
        return;
      }

      const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
      totalVp += (voter.vp * ratio) / 100;
    });

    // Then calculate each voter's share based on the total VP
    votes.forEach((voter) => {
      let vpChoiceSum = 0;
      let currentChoiceIndex = 0;

      for (const choiceIndex of Object.keys(voter.choice)) {
        if (choiceId === parseInt(choiceIndex)) {
          currentChoiceIndex = voter.choice[choiceIndex];
        }
        vpChoiceSum += voter.choice[choiceIndex];
      }

      if (currentChoiceIndex === 0) {
        return;
      }

      const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
      const voterShare = (voter.vp * ratio) / 100;
      // Store the voter's share of the total VP
      voterVps[voter.voter] = voterShare / totalVp;
    });


    rewardInfos.forEach(({ rewardAddress, rewardAmount }) => {
      let remainingRewards = rewardAmount;
      let processedVoters = 0;
      const totalVoters = Object.keys(voterVps).length;

      Object.entries(voterVps).forEach(([voter, share]) => {
        processedVoters++;

        let amount: bigint;
        if (processedVoters === totalVoters) {
          // Last voter gets remaining rewards to avoid dust
          amount = remainingRewards;
        } else {
          // Simply multiply rewardAmount by the share
          amount =
            (rewardAmount * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);
          remainingRewards -= amount;
        }

        if (amount > 0n) {
          if (!distribution[voter]) {
            distribution[voter] = {
              tokens: {},
            };
          }
          distribution[voter].tokens[rewardAddress] =
            (distribution[voter].tokens[rewardAddress] || 0n) + amount;
        }
      });
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
    // Find the delegation voter's rewards
    const delegationVoterAddress = Object.keys(distribution).find((voter: string) => voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase());
    if(delegationVoterAddress) {
      const delegationDistribution = distribution[delegationVoterAddress];
      const tokens = delegationDistribution.tokens;

      // Get voting power for all delegators
      const vps = await getVotingPower(proposal, stakeDaoDelegators);

      // Compute the total vp with 18 decimals precision
      const totalVp = Object.values(vps).reduce((acc, vp) => acc + vp, 0);

      for(const stakeDaoDelegator of stakeDaoDelegators) {
        const stakeDaoDelegatorChecksum = getAddress(stakeDaoDelegator);
        const stakeDaoDelegatorLc = stakeDaoDelegator.toLowerCase();
        const delegatorVp = vps[stakeDaoDelegatorLc] || 0;
        if (delegatorVp === 0) {
          continue;
        }

        const share = delegatorVp / totalVp; // In percentage

        for(const tokenAddress of Object.keys(tokens)) {
          const tokenAddressChecksum = getAddress(tokenAddress);
          const totalAmount = tokens[tokenAddress];
          const userAmount = (totalAmount * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);

          if(!distribution[stakeDaoDelegatorChecksum]) {
            distribution[stakeDaoDelegatorChecksum] = {
              tokens: {}
            }
          }

          if(!distribution[stakeDaoDelegatorChecksum].tokens[tokenAddressChecksum]) {
            distribution[stakeDaoDelegatorChecksum].tokens[tokenAddressChecksum] = BigInt(0);
          }

          distribution[stakeDaoDelegatorChecksum].tokens[tokenAddressChecksum] += userAmount;
        }
      }
      delete distribution[delegationVoterAddress];
    }
    
  }

  // Convert distributions to JSON-friendly format for regular distribution
  const convertToJsonFormat = (dist: Distribution) => {
    return Object.entries(dist).reduce(
      (acc, [voter, { tokens }]) => {
        acc[voter] = {
          tokens: Object.entries(tokens).reduce((tokenAcc, [token, amount]) => {
            tokenAcc[token] = amount.toString(); // Convert BigInt to string
            return tokenAcc;
          }, {} as Record<string, string>),
        };
        return acc;
      },
      {} as Record<
        string,
        { tokens: Record<string, string> }
      >
    );
  };

  // Save distributions to separate files
  console.log("Saving distributions to files...");
  const dirPath = `bounties-reports/${currentPeriodTimestamp}/spectra`;
  fs.mkdirSync(dirPath, { recursive: true });

  // Save main distribution
  fs.writeFileSync(
    `${dirPath}/repartition.json`,
    JSON.stringify({ distribution: convertToJsonFormat(distribution) }, null, 2)
  );

  console.log("Spectra repartition generation completed successfully.");
};

// Make sure to call main as an async function
main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});