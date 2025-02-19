import * as dotenv from "dotenv";
import fs from "fs";
import {
  CVX_SPACE,
  WEEK,
  DELEGATION_ADDRESS,
  SD_FRAX_DELEG_TEST,
} from "../utils/constants";
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
import { processAllDelegators } from "../utils/cacheUtils";

dotenv.config();

type CvxCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: bigint }
>;
type Distribution = Record<string, { tokens: Record<string, bigint> }>;

/*
// Function to validate distribution against the report
const checkDistribution = (distribution: Distribution, report: CvxCSVType) => {
  const totalsDistribution: Record<string, bigint> = {};
  const totalsReport: Record<string, bigint> = {};

  console.log("Distribution:", distribution);
  console.log("Report:", report);

  // Calculate totals for distribution
  Object.values(distribution).forEach(({ tokens }) => {
    Object.entries(tokens).forEach(([tokenAddress, amount]) => {
      totalsDistribution[tokenAddress.toLowerCase()] =
        (totalsDistribution[tokenAddress.toLowerCase()] || BigInt(0)) +
        BigInt(amount);
    });
  });

  // Calculate totals for report
  Object.entries(report).forEach(([_, rewardInfos]) => {
    rewardInfos.forEach(({ rewardAddress, rewardAmount }) => {
      const address = rewardAddress.toLowerCase();
      totalsReport[address] =
        (totalsReport[address] || BigInt(0)) + rewardAmount;
    });
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
          const tokenAmount = BigInt(tokens[tokenAddress] || 0);
          if (tokenAmount > maxAmount) {
            maxVoter = voter;
            maxAmount = tokenAmount;
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
*/

// For stake dao delegators, we want to distribute the rewards to the delegators, not to the voter
const computeStakeDaoDelegation = async (
  proposal: any,
  stakeDaoDelegators: string[],
  tokens: Record<string, bigint>,
  delegationVoter: string
): Promise<Record<string, { tokens: Record<string, bigint> } | { share: string }>> => {
  const delegationDistribution: Record<
    string,
    { tokens: Record<string, bigint> } | { share: string }
  > = {};

  // Store original delegator's distribution with full token amounts
  delegationDistribution[delegationVoter] = {
    tokens: { ...tokens },
  };

  // Get voting power for all delegators
  const vps = await getVotingPower(proposal, stakeDaoDelegators);

  // Compute the total vp with 18 decimals precision
  const totalVp = Object.values(vps).reduce((acc, vp) => acc + vp, 0);

  // Store share for each delegator
  stakeDaoDelegators.forEach((delegator) => {
    const delegatorVp = vps[delegator] || 0;
    if (delegatorVp > 0) {
      const share = (delegatorVp / totalVp).toString();
      delegationDistribution[delegator] = {
        share,
      };
    }
  });

  return delegationDistribution;
};

// Convert delegation distribution to JSON-friendly format
const convertDelegationToJsonFormat = (
  dist: Record<string, { tokens?: Record<string, bigint>; share?: string }>
) => {
  return Object.entries(dist).reduce((acc, [address, data]) => {
    if ("tokens" in data) {
      // Handle original delegator with tokens
      acc[address] = {
        tokens: Object.entries(data.tokens!).reduce(
          (tokenAcc, [token, amount]) => {
            tokenAcc[token] = amount.toString();
            return tokenAcc;
          },
          {} as Record<string, string>
        ),
      };
    } else {
      // Handle delegators with shares
      acc[address] = {
        share: data.share,
      };
    }
    return acc;
  }, {} as Record<string, any>);
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
  const totalPerToken = Object.values(csvResult).reduce((acc, rewardArray) => {
    rewardArray.forEach(({ rewardAddress, rewardAmount }) => {
      acc[rewardAddress] = (acc[rewardAddress] || BigInt(0)) + rewardAmount;
    });
    return acc;
  }, {} as Record<string, bigint>);
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
  const gaugeMapping = associateGaugesPerId(proposal, curveGauges);
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
      CVX_SPACE,
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
        console.log("removing delegator, already voted by himself", delegator);
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
    const gaugeInfo = gaugeMapping[gauge.toLowerCase()];
    if (!gaugeInfo) throw new Error(`Choice ID not found for gauge: ${gauge}`);

    const choiceId = gaugeInfo.choiceId;
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

    // Convert totalVp to BigInt with 18 decimals precision
    const totalVpBigInt = BigInt(Math.floor(totalVp * 1e18));

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
  let delegationDistribution: Record<
    string,
    { tokens: Record<string, bigint> } | { share: string }
  > = {};

  if (isDelegationAddressVoter && stakeDaoDelegators.length > 0) {
    // Find the delegation voter's rewards
    for (const [voter, { tokens }] of Object.entries(distribution)) {
      if (voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
        // Compute delegation distribution
        delegationDistribution = await computeStakeDaoDelegation(
          proposal,
          stakeDaoDelegators,
          tokens,
          voter
        );

        // Remove delegation voter from main distribution
        delete distribution[voter];
        break;
      }
    }
  }

  // Convert distributions to JSON-friendly format for regular distribution
  const convertToJsonFormat = (dist: Distribution) => {
    return Object.entries(dist).reduce((acc, [voter, { tokens }]) => {
      acc[voter] = {
        tokens: Object.entries(tokens).reduce((tokenAcc, [token, amount]) => {
          tokenAcc[token] = amount.toString();
          return tokenAcc;
        }, {} as Record<string, string>),
      };
      return acc;
    }, {} as Record<string, { tokens: Record<string, string> }>);
  };

  // Create separate distributions by chain ID
  const distributionsByChain: Record<number, Distribution> = { 1: {} };


  // Create a map of token addresses to their chain IDs from the CSV
  const tokenChainIds: Record<string, number> = {};
  Object.values(csvResult).forEach((rewardInfos) => {
    console.log(rewardInfos);
    rewardInfos.forEach(({ chainId, rewardAddress }) => {
      if (chainId !== 1) { // Only track non-mainnet tokens
        tokenChainIds[rewardAddress.toLowerCase()] = chainId;
      }
    });
  });

  // Separate distributions by chain ID
  Object.entries(distribution).forEach(([voter, { tokens }]) => {
    const tokensByChain: Record<number, Record<string, bigint>> = { 1: {} };

    // Separate tokens by chain ID
    Object.entries(tokens).forEach(([tokenAddress, amount]) => {
      const chainId = tokenChainIds[tokenAddress.toLowerCase()] || 1;
      if (!tokensByChain[chainId]) {
        tokensByChain[chainId] = {};
      }
      tokensByChain[chainId][tokenAddress] = amount;
    });

    // Add to respective chain distributions
    Object.entries(tokensByChain).forEach(([chainId, chainTokens]) => {
      const numChainId = Number(chainId);
      if (!distributionsByChain[numChainId]) {
        distributionsByChain[numChainId] = {};
      }
      if (Object.keys(chainTokens).length > 0) {
        distributionsByChain[numChainId][voter] = { tokens: chainTokens };
      }
    });
  });

  // Save distributions to separate files by chain
  console.log("Saving distributions to files...");
  const dirPath = `bounties-reports/${currentPeriodTimestamp}/vlCVX`;
  fs.mkdirSync(dirPath, { recursive: true });

  // Save each chain's distribution
  Object.entries(distributionsByChain).forEach(([chainId, chainDistribution]) => {
    const filename = chainId === '1' 
      ? 'repartition.json' 
      : `repartition_${chainId}.json`;

    fs.writeFileSync(
      `${dirPath}/${filename}`,
      JSON.stringify({ distribution: convertToJsonFormat(chainDistribution) }, null, 2)
    );
  });

  // Save delegation distribution if it exists
  if (Object.keys(delegationDistribution).length > 0) {
    fs.writeFileSync(
      `${dirPath}/repartition_delegation.json`,
      JSON.stringify(
        {
          distribution: convertDelegationToJsonFormat(delegationDistribution),
        },
        null,
        2
      )
    );
  }
  console.log("vlCVX repartition generation completed successfully.");
};

// Make sure to call main as an async function
main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
