import { formatUnits, parseEther } from "viem";
import { BigNumber, utils } from "ethers";
import {
  AUTO_VOTER_DELEGATION_ADDRESS,
  DELEGATION_ADDRESS,
  NETWORK_TO_MERKLE,
  SDBAL_SPACE,
  SDCAKE_SPACE,
  SDCRV_SPACE,
  SDFXS_SPACE,
  SDPENDLE_SPACE,
  SPACE_TO_CHAIN_ID,
  SPACE_TO_NETWORK,
  SPACES_IMAGE,
  SPACES_SYMBOL,
  SPACES_TOKENS,
  SPACES_UNDERLYING_TOKEN,
} from "../constants";
import {
  formatVotingPowerResult,
  getProposal,
  getVoters,
  getVotingPower,
} from "../snapshot";
import {
  addVotersFromAutoVoter,
  ChoiceBribe,
  extractProposalChoices,
  getAllAccountClaimedSinceLastFreeze,
  getChoicesBasedOnReport,
  getChoiceWhereExistsBribe,
  getDelegationVotingPower,
} from "../utils";
import { Log, MerkleStat } from "../types";
import MerkleTree from "merkletreejs";
import keccak256 from "keccak256";
import { processAllDelegators } from "../cacheUtils";

/**
 * Creates a merkle tree for token distribution based on voting results
 *
 * @param ids - Array of proposal IDs to process
 * @param space - Snapshot space (e.g., 'sdcrv.eth')
 * @param lastMerkles - Previous merkle trees for unclaimed rewards carry-over
 * @param csvResult - Distribution amounts per gauge from CSV
 * @param pendleRewards - Special handling for Pendle multi-period rewards
 * @param sdFXSWorkingData - Working supply data for sdFXS APR calculation
 * @param sdCakeWorkingData - Working supply data for sdCAKE APR calculation
 * @param additionalDelegatorRewards - Extra rewards for delegators
 * @param overrideTokenAddress - Optional: distribute a different token (for raw tokens)
 * @returns MerkleStat object containing merkle tree, APR, and logs
 */
export const createMultiMerkle = async (
  ids: string[],
  space: string,
  lastMerkles: any,
  csvResult: any,
  pendleRewards: Record<string, Record<string, number>> | undefined,
  sdFXSWorkingData: any,
  sdCakeWorkingData: any,
  additionalDelegatorRewards: Record<string, number> = {},
  overrideTokenAddress?: string
): Promise<MerkleStat> => {
  const userRewards: Record<string, number> = {};
  const aprs: any[] = [];
  const logs: Log[] = [];
  const network = SPACE_TO_NETWORK[space];

  for (const id of ids) {
    // Get the proposal to find the create timestamp
    const proposal = await getProposal(id);

    // Extract address per choice
    // The address will be only the strat of the address
    const allAddressesPerChoice = extractProposalChoices(proposal);

    // Get only choices where we have a bribe reward
    // Now, the address is the complete address
    // Map -> gauge address => {index : choice index, amount: sdTKN }
    let addressesPerChoice: Record<string, ChoiceBribe> = {};

    if (pendleRewards) {
      addressesPerChoice = getChoicesBasedOnReport(
        allAddressesPerChoice,
        pendleRewards[id]
      );
    } else {
      addressesPerChoice = getChoiceWhereExistsBribe(
        allAddressesPerChoice,
        csvResult
      );
    }

    // Here, we should have delegation voter + all other voters
    // Object with vp property
    let voters = await getVoters(id);
    const vps = await getVotingPower(
      proposal,
      voters.map((v) => v.voter),
      SPACE_TO_CHAIN_ID[space]
    );

    voters = formatVotingPowerResult(voters, vps);

    voters = await addVotersFromAutoVoter(
      space,
      proposal,
      voters,
      allAddressesPerChoice
    );

    // Should be already done but remove the autovoter address again to be sure
    voters = voters.filter(
      (voter) =>
        voter.voter.toLowerCase() !==
        AUTO_VOTER_DELEGATION_ADDRESS.toLowerCase()
    );

    const delegators = await processAllDelegators(
      space,
      proposal.created,
      DELEGATION_ADDRESS
    );

    // Get voting power for all delegator
    // Map of address => VotingPower
    const delegatorsVotingPower = await getDelegationVotingPower(
      proposal,
      delegators.concat([DELEGATION_ADDRESS]),
      SPACE_TO_CHAIN_ID[space]
    );

    // Reduce delegator voting power if some guys voted directly
    for (const delegatorAddress of Object.keys(delegatorsVotingPower)) {
      const da = delegatorAddress.toLowerCase();
      for (const vote of voters) {
        if (vote.voter.toLowerCase() === da) {
          delegatorsVotingPower[delegatorAddress] -= vote.vp;
          if (delegatorsVotingPower[delegatorAddress] <= 0) {
            delegatorsVotingPower[delegatorAddress] = 0;
          }
          break;
        }
      }
    }

    const delegatorSumVotingPower = Object.values(delegatorsVotingPower).reduce(
      (acc, vp) => acc + vp,
      0.0
    );
    let delegationVote = voters.find(
      (v) => v.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
    );

    if (!delegationVote) {
      delegationVote = {
        totalRewards: 0,
        vp: 0,
      };
    }

    // Compute only thoses with voting power > 0.00000002% of delegation voting power
    const filteredDelegatorsVotingPower = Object.fromEntries(
      Object.entries(delegatorsVotingPower).filter(
        ([_, vp]) => vp > delegationVote.vp * 0.00000002
      )
    );
    const amountOfDelegators =
      Object.keys(filteredDelegatorsVotingPower).length - 1; // Delegation

    logs.push({
      id: "Delegators",
      content: [`${id} : ${amountOfDelegators}`],
    });

    // Add additional rewards to delegation if specified for this space
    if (
      additionalDelegatorRewards[space] &&
      additionalDelegatorRewards[space] > 0 &&
      id === ids[0]
    ) {
      // Only add to the first proposal to avoid duplicating
      if (!delegationVote.totalRewards) {
        delegationVote.totalRewards = 0;
      }
      delegationVote.totalRewards += additionalDelegatorRewards[space];

      logs.push({
        id: "AdditionalRewards",
        content: [
          `Added ${additionalDelegatorRewards[space]} additional rewards to ${space} delegators`,
        ],
      });
    }

    delegationVote.totalRewards = delegationVote.totalRewards || 0;
    const nonFoundGauges: Record<string, { index: number; amount: number }> =
      {};
    let delegationRewardsForNonFoundGauges = 0;

    for (const gaugeAddress of Object.keys(addressesPerChoice)) {
      const index = addressesPerChoice[gaugeAddress].index;
      const sdTknRewardAmount = addressesPerChoice[gaugeAddress].amount;

      // Calculate the total VP used to vote for this gauge across all voters
      let totalVP = 0;
      let foundVotersForGauge = false;
      for (const voter of voters) {
        let vpChoiceSum = 0;
        let currentChoiceIndex = 0;
        for (const choiceIndex of Object.keys(voter.choice)) {
          if (index === parseInt(choiceIndex)) {
            currentChoiceIndex = voter.choice[choiceIndex];
            foundVotersForGauge = true;
          }

          vpChoiceSum += voter.choice[choiceIndex];
        }

        if (currentChoiceIndex === 0) {
          continue;
        }

        const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
        totalVP += (voter.vp * ratio) / 100;
      }

      if (!foundVotersForGauge) {
        nonFoundGauges[gaugeAddress] = {
          index: index,
          amount: sdTknRewardAmount,
        };
        delegationRewardsForNonFoundGauges += sdTknRewardAmount;
        continue;
      }

      // We split the bribe reward amount amount between voters
      for (const voter of voters) {
        // Sum choice votes
        let vpChoiceSum = 0;
        let currentChoiceIndex = 0;
        for (const choiceIndex of Object.keys(voter.choice)) {
          if (index === parseInt(choiceIndex)) {
            currentChoiceIndex = voter.choice[choiceIndex];
          }

          vpChoiceSum += voter.choice[choiceIndex];
        }

        if (currentChoiceIndex === 0) {
          // User not voted for this gauge
          continue;
        }

        // User voted for this gauge address
        // We calculate his vp associated
        const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
        const vpUsed = (voter.vp * ratio) / 100;
        const totalVPRatio = (vpUsed * 100) / totalVP;
        const amountEarned = (totalVPRatio * sdTknRewardAmount) / 100;

        if (voter.totalRewards === undefined) {
          voter.totalRewards = 0;
        }

        voter.totalRewards += amountEarned;
      }
    }

    if (pendleRewards) {
      // Add all rewards from non-found gauges to the DELEGATION_ADDRESS
      let delegationVoter = voters.find(
        (v) => v.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
      );
      if (delegationVoter) {
        if (delegationVoter.totalRewards === undefined) {
          delegationVoter.totalRewards = 0;
        }
        delegationVoter.totalRewards += delegationRewardsForNonFoundGauges;
      } else {
        // If the delegation voter does not exist, create it and add the rewards
        voters.push({
          voter: DELEGATION_ADDRESS.toLowerCase(),
          totalRewards: delegationRewardsForNonFoundGauges,
          vp: 0, // Assuming no voting power if not already in the list
          choice: {},
        });
      }
    }

    // Now we have all rewards across all voters
    // But one voter is the delegation, we have to split his rewards across the delegation
    delegationVote = voters.find(
      (v) => v.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
    );
    if (delegationVote) {
      delegationVote.delegation = {};

      for (const delegatorAddress of Object.keys(delegatorsVotingPower)) {
        const vp = delegatorsVotingPower[delegatorAddress];
        const ratioVp = (vp * 100) / delegatorSumVotingPower;

        // This user should receive ratioVp% of all rewards
        if (
          space === SDCRV_SPACE &&
          delegatorAddress.toLowerCase() ===
            "0x1c0d72a330f2768daf718def8a19bab019eead09".toLowerCase()
        ) {
          logs.push({
            id: "Concentrator",
            content: [
              `Voting power : ${vp}`,
              `Rewards : ${(ratioVp * delegationVote.totalRewards) / 100}`,
            ],
          });
        }

        delegationVote.delegation[delegatorAddress.toLowerCase()] =
          (ratioVp * delegationVote.totalRewards) / 100;
      }

      // Calculate delegation apr
      if (delegationVote.vp > 0) {
        if (space === "sdcake.eth") {
          logs.push({
            id: "sdCAKE",
            content: [
              `Voting power : ${delegationVote.vp}`,
              `Rewards : ${delegationVote.totalRewards}`,
            ],
          });
        }

        aprs.push({
          vp: delegationVote.vp,
          amount: delegationVote.totalRewards,
        });
      }
    }

    // Create a map with userAddress => reward amount
    for (const voter of voters) {
      if (!voter.totalRewards) {
        continue;
      }

      if (voter.delegation) {
        for (const delegatorAddress of Object.keys(voter.delegation)) {
          const amount = voter.delegation[delegatorAddress.toLowerCase()];
          if (userRewards[delegatorAddress.toLowerCase()]) {
            userRewards[delegatorAddress.toLowerCase()] += amount;
          } else {
            userRewards[delegatorAddress.toLowerCase()] = amount;
          }
        }
      } else {
        if (userRewards[voter.voter.toLowerCase()]) {
          userRewards[voter.voter.toLowerCase()] += voter.totalRewards;
        } else {
          userRewards[voter.voter.toLowerCase()] = voter.totalRewards;
        }
      }
    }
  }

  // Determine which token to distribute:
  // - Use overrideTokenAddress for raw tokens (e.g., CRV instead of sdCRV)
  // - Otherwise use the default sdToken for the space
  const tokenToDistribute = overrideTokenAddress || SPACES_TOKENS[space];

  const lastMerkle = lastMerkles.find(
    (m: any) => m.address.toLowerCase() === tokenToDistribute.toLowerCase()
  );

  if (lastMerkle) {
    const usersClaimedAddress = await getAllAccountClaimedSinceLastFreeze(
      NETWORK_TO_MERKLE[network],
      tokenToDistribute,
      SPACE_TO_CHAIN_ID[space]
    );

    const userAddressesLastMerkle = Object.keys(lastMerkle.merkle);

    for (const userAddress of userAddressesLastMerkle) {
      const userAddressLowerCase = userAddress.toLowerCase();
      const isClaimed = usersClaimedAddress[userAddressLowerCase];

      // If user didn't claim, we add the previous rewards to new one
      if (!isClaimed) {
        const leaf = lastMerkle.merkle[userAddress];
        const amount = parseFloat(
          formatUnits(BigInt(BigNumber.from(leaf.amount).toString()), 18)
        );

        if (userRewards[userAddressLowerCase]) {
          userRewards[userAddressLowerCase] += amount;
        } else {
          userRewards[userAddressLowerCase] = amount;
        }
      }
    }
  }

  // Since this point, userRewards map contains the new reward amount for each user
  // We have to generate the merkle
  const userRewardAddresses = Object.keys(userRewards);

  // TEMPORARY FIX: Reduce the largest voter by 0.5436014543 for sdBAL to match contract balance
  if (space === SDBAL_SPACE) {
    // Find the user with the largest reward
    let maxReward = 0;
    let maxRewardAddress = '';
    for (const [address, reward] of Object.entries(userRewards)) {
      if (reward > maxReward) {
        maxReward = reward;
        maxRewardAddress = address;
      }
    }

    if (maxRewardAddress) {
      const adjustmentAmount = 0.5436014543;
      console.log(`[TEMP FIX] Reducing ${maxRewardAddress} reward by ${adjustmentAmount} sdBAL`);
      console.log(`[TEMP FIX] Before: ${userRewards[maxRewardAddress].toFixed(10)} sdBAL`);
      userRewards[maxRewardAddress] -= adjustmentAmount;
      console.log(`[TEMP FIX] After: ${userRewards[maxRewardAddress].toFixed(10)} sdBAL`);
    }
  }

  // Define a threshold below which numbers are considered too small and should be set to 0
  const threshold = 2e-8;
  const adjustedUserRewards = Object.fromEntries(
    Object.entries(userRewards).map(([address, reward]) => {
      // If the reward is smaller than the threshold, set it to 0
      const adjustedReward = reward < threshold ? 0 : reward;
      return [address.toLowerCase(), adjustedReward];
    })
  );

  const elements: any[] = [];
  for (let i = 0; i < userRewardAddresses.length; i++) {
    const userAddress = userRewardAddresses[i];

    const rewardValue = adjustedUserRewards[userAddress.toLowerCase()];
    // Convert to fixed decimal notation to avoid scientific notation
    const rewardString = rewardValue.toFixed(18);
    const amount = parseEther(rewardString);

    elements.push(
      utils.solidityKeccak256(
        ["uint256", "address", "uint256"],
        [
          i,
          userAddress.toLowerCase(),
          BigInt(BigNumber.from(amount).toString()),
        ]
      )
    );
  }

  const merkleTree = new MerkleTree(elements, keccak256, { sort: true });

  const merkle: any = {};
  let totalAmount = BigNumber.from(0);
  for (let i = 0; i < userRewardAddresses.length; i++) {
    const userAddress = userRewardAddresses[i];
    const rewardValue = adjustedUserRewards[userAddress.toLowerCase()];
    // Convert to fixed decimal notation to avoid scientific notation
    const rewardString = rewardValue.toFixed(18);
    const amount = BigNumber.from(parseEther(rewardString));
    totalAmount = totalAmount.add(amount);

    merkle[userAddress.toLowerCase()] = {
      index: i,
      amount,
      proof: merkleTree.getHexProof(elements[i]),
    };
  }

  let apr = 0;
  if (aprs.length > 0) {
    const sumRewards = aprs.reduce((acc, aprData) => acc + aprData.amount, 0);

    if (space == SDFXS_SPACE) {
      apr = (sumRewards / sdFXSWorkingData.total_vp) * 52 * 100;
    } else if (space === SDCAKE_SPACE) {
      apr = (sumRewards / sdCakeWorkingData.total_vp) * 26 * 100;
    } else {
      const vpAverage =
        aprs.reduce((acc, aprData) => acc + aprData.vp, 0) / aprs.length;
      apr = (sumRewards / vpAverage) * 52 * 100;
    }
  }

  if (space === SDFXS_SPACE) {
    apr *= 4;
  }

  return {
    apr,
    merkle: {
      symbol: SPACES_SYMBOL[space],
      address: tokenToDistribute,
      image: SPACES_IMAGE[space],
      merkle: merkle,
      root: merkleTree.getHexRoot(),
      total: totalAmount,
      chainId: parseInt(SPACE_TO_CHAIN_ID[space]),
      merkleContract: NETWORK_TO_MERKLE[network],
    },
    logs,
  };
};
