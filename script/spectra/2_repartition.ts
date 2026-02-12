import * as dotenv from "dotenv";
import fs from "fs";
import {
  WEEK,
  DELEGATION_ADDRESS,
  SPECTRA_SPACE,
  AUTO_VOTER_DELEGATION_ADDRESS,
} from "../utils/constants";
import {
  getLastClosedProposals,
  getVoters,
  getVotingPower,
} from "../utils/snapshot";
import * as moment from "moment";
import { processAllDelegators } from "../utils/cacheUtils";
import { getAddress } from "viem";
import {  getSpectraDelegationAPR, getSpectraReport } from "./utils";
import { Distribution } from "../interfaces/Distribution";
import { PROTOCOLS_TOKENS } from "../utils/reportUtils";


dotenv.config();

const main = async () => {
  console.log("Starting Spectra repartition generation...");
  const now = moment.utc().unix();
  const pastWeek = process.env.PAST_WEEK ? parseInt(process.env.PAST_WEEK) : 0;
  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK - (pastWeek * WEEK);

  // Extract CSV report
  console.log("Extracting CSV report...");
  const csvResult = await getSpectraReport(currentPeriodTimestamp);

  // Fetch proposal and votes
  // Bounties are claimed for the PREVIOUS voting period, so skip the latest closed proposal
  console.log("Fetching proposal and votes...");
  const proposals = await getLastClosedProposals(SPECTRA_SPACE, 2 + pastWeek);
  const proposal = proposals[1 + pastWeek];
  const proposalId = proposal.id;
  console.log("proposalId", proposalId);

  const votes = await getVoters(proposalId);

  // Distribute rewards
  console.log("Distributing rewards...");
  const distribution: Distribution = {};
  /*
  for (const [gauge, rewardInfos] of csvEntries) {
    for (const rewardInfo of rewardInfos) {
      const address = getAddress(rewardInfo.rewardAddress);
      if (!tokenDecimals[address]) {
        const decimals = await publicClient.readContract({
          address,
          abi: [
            {
              inputs: [],
              name: "decimals",
              outputs: [{ type: "uint8" }],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "decimals",
        });
        tokenDecimals[address] = decimals;
      }
    }
  }
  */

  Object.entries(csvResult).forEach(([gauge, rewardSdValue]) => {
    let choiceId = (proposal.choices as string[]).findIndex((choice: string) => choice.toLowerCase() === gauge.toLowerCase());

    // If not found, try to match by removing network prefix and comparing the rest
    if (choiceId === -1) {
      // Extract the part after the first dash
      const gaugeSuffix = gauge.substring(gauge.indexOf('-') + 1);
      
      choiceId = (proposal.choices as string[]).findIndex((choice: string) => {
        const choiceSuffix = choice.substring(choice.indexOf('-') + 1);
        return choiceSuffix.toLowerCase() === gaugeSuffix.toLowerCase();
      });
    }

    console.log("choiceId for", gauge, choiceId);

    if (choiceId === -1) {
      console.error(`Available choices:`, proposal.choices);
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

    // Distribute sdToken proportionnally to the voters
    Object.entries(voterVps).forEach(([voter, share]) => {
      if (!distribution[voter]) {
        distribution[voter] = {
          tokens: {},
        };
      }
      const sdTokenAddress = PROTOCOLS_TOKENS.spectra.sdToken;
      const amount = BigInt(Math.floor(Number(rewardSdValue) * share * 1e18));
      distribution[voter].tokens[sdTokenAddress] = (distribution[voter].tokens[sdTokenAddress] || 0n) + amount;
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

  // Fetch StakeDAO delegators
  console.log("Fetching StakeDAO delegators...");
  // Only if delegation address is one of the voters

  const delegationAddresses = [DELEGATION_ADDRESS, AUTO_VOTER_DELEGATION_ADDRESS];
  let delegationAPR = 0;

  for (const delegationAddress of delegationAddresses) {
    const isDelegationAddressVoter = votes.some(
      (voter) => voter.voter.toLowerCase() === delegationAddress.toLowerCase()
    );

    if (isDelegationAddressVoter) {
      console.log(
        `Delegation address ${delegationAddress} is one of the voters, fetching StakeDAO delegators`
      );
      let stakeDaoDelegators = await processAllDelegators(
        SPECTRA_SPACE,
        proposal.created,
        delegationAddress
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

      if (stakeDaoDelegators.length > 0) {
        // Find the delegation voter's rewards
        const delegationVoterAddress = Object.keys(distribution).find((voter: string) => voter.toLowerCase() === delegationAddress.toLowerCase());
        if (delegationVoterAddress) {
          const delegationDistribution = distribution[delegationVoterAddress];
          const tokens = delegationDistribution.tokens;

          // Get voting power for all delegators
          const vps = await getVotingPower(proposal, stakeDaoDelegators, "8453");

          // Compute the total vp with 18 decimals precision
          const totalVp = Object.values(vps).reduce((acc, vp) => acc + vp, 0);

          // Compute the APR
          if (delegationAddress.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
            delegationAPR = await getSpectraDelegationAPR(tokens, stakeDaoDelegators);
          }

          for (const stakeDaoDelegator of stakeDaoDelegators) {
            const stakeDaoDelegatorChecksum = getAddress(stakeDaoDelegator);
            const stakeDaoDelegatorLc = stakeDaoDelegator.toLowerCase();
            const delegatorVp = vps[stakeDaoDelegatorLc] || 0;
            if (delegatorVp === 0) {
              continue;
            }

            const share = delegatorVp / totalVp; // In percentage

            for (const tokenAddress of Object.keys(tokens)) {
              const tokenAddressChecksum = getAddress(tokenAddress);
              const totalAmount = tokens[tokenAddress];
              const userAmount = (totalAmount * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);

              if (!distribution[stakeDaoDelegatorChecksum]) {
                distribution[stakeDaoDelegatorChecksum] = {
                  tokens: {}
                }
              }

              if (!distribution[stakeDaoDelegatorChecksum].tokens[tokenAddressChecksum]) {
                distribution[stakeDaoDelegatorChecksum].tokens[tokenAddressChecksum] = BigInt(0);
              }

              distribution[stakeDaoDelegatorChecksum].tokens[tokenAddressChecksum] += userAmount;
            }
          }
          delete distribution[delegationVoterAddress];
        }

      }

    } else {
      console.log(
        `Delegation address ${delegationAddress} is not one of the voters, skipping StakeDAO delegators computation`
      );
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

  // Save APR - write only Spectra, don't copy other protocols
  const localPath = `./bounties-reports/${currentPeriodTimestamp}/delegationsAPRs.json`;
  let delegationAPRs: Record<string, number> = {};
  if (fs.existsSync(localPath)) {
    delegationAPRs = JSON.parse(fs.readFileSync(localPath, "utf-8"));
  }
  delegationAPRs[SPECTRA_SPACE] = delegationAPR;
  fs.writeFileSync(localPath, JSON.stringify(delegationAPRs));

  // End
  console.log("Spectra repartition generation completed successfully.");
};

// Make sure to call main as an async function
main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
}); 
