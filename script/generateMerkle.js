const fs = require('fs');
const path = require('path');
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const { gql, request } = require("graphql-request");
const axios = require('axios').default;
const { utils, BigNumber } = require("ethers");
const { parseAbi, encodeFunctionData, formatUnits, parseEther, createPublicClient, http } = require("viem");
const { bsc, mainnet } = require('viem/chains');
const VOTER_ABI = require("../abis/AutoVoter.json");
const dotenv = require("dotenv");

const {
  MERKLE_ADDRESS,
  MERKLE_BSC_ADDRESS,
  STASH_CONTROLLER_ADDRESS,
  SNAPSHOT_ENDPOINT,
  ENDPOINT_DELEGATORS,
  ENDPOINT_DELEGATORS_BSC,
  AUTO_VOTER_DELEGATION_ADDRESS,
  AUTO_VOTER_CONTRACT,
  DELEGATION_ADDRESS,
  AGNOSTIC_ENDPOINT,
  AGNOSTIC_API_KEY,
  ETHEREUM,
  ETH_CHAIN_ID,
  BSC,
  BSC_CHAIN_ID,
  SDCRV_SPACE,
  SDBAL_SPACE,
  SDFXS_SPACE,
  SDANGLE_SPACE,
  SDPENDLE_SPACE,
  SDCAKE_SPACE,
  SDFXN_SPACE,
  SPACES,
  LABELS_TO_SPACE,
  SUBGRAP_BY_CHAIN,
  SPACE_TO_NETWORK,
  SPACE_TO_CHAIN_ID,
  NETWORK_TO_STASH,
  NETWORK_TO_MERKLE,
  SPACES_TOKENS,
  SPACES_SYMBOL,
  SPACES_IMAGE,
  SPACES_UNDERLYING_TOKEN,
  abi
} = require("./utils/constants");
const { fetchLastProposalsIds, fetchProposalsIdsBasedOnPeriods, getProposal, getVoters, getVoterVotingPower } = require("./utils/snapshot");
const { checkSpace, extractCSV, getTokenPrice, extractProposalChoices, getChoiceWhereExistsBribe, getAllDelegators, getDelegationVotingPower, getAllAccountClaimedSinceLastFreezeOnBSC, getAllAccountClaimedSinceLastFreezeOnMainnet, addVotersFromAutoVoter, getChoicesBasedOnReport } = require("./utils/utils");
const { getAllAccountClaimedSinceLastFreezeWithAgnostic } = require("./utils/agnostic");

dotenv.config();


const logData = {}; // Use to store and write logs in a JSON 


const main = async () => {
  const [fileName, csvResult] = await extractCSV(LABELS_TO_SPACE);

  logData["Latest report"] = fileName;


  // Fetch last merkle
  const { data: lastMerkles } = await axios.get("https://raw.githubusercontent.com/stake-dao/bounties-report/main/merkle.json");

  // Fetch last proposal ids
  const proposalIdPerSpace = await fetchLastProposalsIds(SPACES);

  const newMerkles = [];
  const { data: delegationAPRs } = await axios.get("https://raw.githubusercontent.com/stake-dao/bounties-report/main/delegationsAPRs.json");

  for (const key of Object.keys(delegationAPRs)) {
    delegationAPRs[key] = 0;
  }

  const toFreeze = {};
  const toSet = {};

  // All except Pendle
  for (const space of Object.keys(proposalIdPerSpace)) {
    if (space === "sdpendle.eth") { // Special case sdPendle : Monthly report
      continue;
    }

    checkSpace(space, SPACES_SYMBOL, SPACES_IMAGE, SPACES_UNDERLYING_TOKEN, SPACES_TOKENS, SPACE_TO_NETWORK, NETWORK_TO_STASH, NETWORK_TO_MERKLE);

    // If no bribe to distribute to this space => skip
    if (!csvResult[space]) {
      continue;
    }

    const tokenPrice = await getTokenPrice(space, SPACE_TO_NETWORK, SPACES_UNDERLYING_TOKEN);

    const id = proposalIdPerSpace[space];

    // Get the proposal to find the create timestamp
    const proposal = await getProposal(id);

    // Extract address per choice
    // The address will be only the strat of the address
    const allAddressesPerChoice = extractProposalChoices(proposal);

    // Get only choices where we have a bribe reward
    // Now, the address is the complete address
    // Map -> gauge address => {index : choice index, amount: sdTKN }
    const addressesPerChoice = getChoiceWhereExistsBribe(allAddressesPerChoice, csvResult[space]);

    //const addressesPerChoice = getChoicesBasedOnReport(allAddressesPerChoice, csvResult[space]);

    // Here, we should have delegation voter + all other voters
    // Object with vp property
    let voters = await getVoters(id);

    voters = await getVoterVotingPower(proposal, voters, SPACE_TO_CHAIN_ID[space]);
    voters = await addVotersFromAutoVoter(space, proposal, voters, allAddressesPerChoice);

    // Get all delegator addresses
    const delegators = await getAllDelegators(DELEGATION_ADDRESS, proposal.created, space);

    // Get voting power for all delegator
    // Map of address => VotingPower
    const delegatorsVotingPower = await getDelegationVotingPower(proposal, delegators.concat([DELEGATION_ADDRESS]), SPACE_TO_CHAIN_ID[space]);

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

    // fs.writeFileSync(`./tmp/parse-${space}-delegationScoresWithoutVote.json`, Object.keys(delegatorsVotingPower).map((key) => key + ";" + delegatorsVotingPower[key]).join("\n"));

    const delegatorSumVotingPower = Object.values(delegatorsVotingPower).reduce((acc, vp) => acc + vp, 0.0);
    let delegationVote = voters.find((v) => v.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase());
    //const delegatorSumVotingPower = delegationVote;
    if (!delegationVote) {
      delegationVote = {
        totalRewards: 0,
        vp: 0,
      }
      //throw new Error("No delegation vote for " + space + " - " + id);
    }

    // We can have sum delegation lower than delegation vp
    //delegationVote.vp = delegatorSumVotingPower;
    if(id.toLowerCase() === "0x9b01f87c204e11d5f36d61606cbfaa35ae37859e2549158ea8e3415a5564396d".toLowerCase()) {
      delegationVote.totalRewards = 1520 + 763 + 1563
    } else {
      delegationVote.totalRewards = 0;
    }

    for (const gaugeAddress of Object.keys(addressesPerChoice)) {
      const index = addressesPerChoice[gaugeAddress].index;
      const sdTknRewardAmount = addressesPerChoice[gaugeAddress].amount;

      // Calculate the total VP used to vote for this gauge across all voters
      let totalVP = 0;
      for (const voter of voters) {
        let vpChoiceSum = 0;
        let currentChoiceIndex = 0;
        for (const choiceIndex of Object.keys(voter.choice)) {
          if (index === parseInt(choiceIndex)) {
            currentChoiceIndex = voter.choice[choiceIndex];
          }

          vpChoiceSum += voter.choice[choiceIndex];
        }

        if (currentChoiceIndex === 0) {
          continue;
        }

        const ratio = currentChoiceIndex * 100 / vpChoiceSum;
        totalVP += voter.vp * ratio / 100;
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
        const ratio = currentChoiceIndex * 100 / vpChoiceSum;
        const vpUsed = voter.vp * ratio / 100;
        const totalVPRatio = vpUsed * 100 / totalVP;
        const amountEarned = totalVPRatio * sdTknRewardAmount / 100;

        if (voter.totalRewards === undefined) {
          voter.totalRewards = 0;
        }

        voter.totalRewards += amountEarned;
      }
    }

    // Now we have all rewards across all voters
    // But one voter is the delegation, we have to split his rewards across the delegation
    delegationVote = voters.find((v) => v.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase());
    if (delegationVote) {
      delegationVote.delegation = {};

      for (const delegatorAddress of Object.keys(delegatorsVotingPower)) {
        const vp = delegatorsVotingPower[delegatorAddress];
        const ratioVp = vp * 100 / delegatorSumVotingPower;

        // This user should receive ratioVp% of all rewards
        if (space === SDCRV_SPACE && delegatorAddress.toLowerCase() === "0x1c0d72a330f2768daf718def8a19bab019eead09".toLowerCase()) {
          logData["Concentrator"] = {
            "votingPower": vp,
            "delegationVotingPower": delegatorSumVotingPower,
            "totalRewards": delegationVote.totalRewards,
            "ratioVp": ratioVp,
            "ratioRewards": ratioVp * delegationVote.totalRewards / 100,
            "ratioRewardsNew": vp * delegationVote.totalRewards / delegatorSumVotingPower,
          }
        }
        delegationVote.delegation[delegatorAddress.toLowerCase()] = ratioVp * delegationVote.totalRewards / 100;
      }

      // Calculate delegation apr
      if (delegationVote.vp > 0) {
        if (space === "sdcake.eth") {
          logData["sdCAKE"] = {
            "votingPower": delegationVote.vp,
            "totalRewards": delegationVote.totalRewards,
          }
        }
        let delegationAPR = ((Number(delegationVote.totalRewards) * 26 * tokenPrice) / delegationVote.vp) * 100 / tokenPrice;
        if (space === SDFXS_SPACE) {
          delegationAPR *= 4;
        }
        delegationAPRs[space] = delegationAPR;
      }
    }

    // Create a map with userAddress => reward amount
    const userRewards = {};
    for (const voter of voters) {
      if (!voter.totalRewards) {
        continue
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

    // New distribution is split here
    // We have to sum with old distribution if users don't claim
    const tokenToDistribute = SPACES_TOKENS[space];

    const lastMerkle = lastMerkles.find((m) => m.address.toLowerCase() === tokenToDistribute.toLowerCase());
    const network = SPACE_TO_NETWORK[space];

    if (lastMerkle) {

      let usersClaimedAddress = {};
      switch (network) {
        case ETHEREUM:
          usersClaimedAddress = await getAllAccountClaimedSinceLastFreezeWithAgnostic(tokenToDistribute);
          break;
        case BSC:
          usersClaimedAddress = await getAllAccountClaimedSinceLastFreezeOnBSC(lastMerkle, NETWORK_TO_STASH[network]);
          break;
        default:
          throw new Error("network unknow");
      }

      const userAddressesLastMerkle = Object.keys(lastMerkle.merkle);

      for (const userAddress of userAddressesLastMerkle) {

        const userAddressLowerCase = userAddress.toLowerCase();
        const isClaimed = usersClaimedAddress[userAddressLowerCase];

        // If user didn't claim, we add the previous rewards to new one
        if (!isClaimed) {
          const leaf = lastMerkle.merkle[userAddress];
          const amount = parseFloat(formatUnits(BigNumber.from(leaf.amount), 18));

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


    // Define a threshold below which numbers are considered too small and should be set to 0
    const threshold = 1e-8;

    const adjustedUserRewards = Object.fromEntries(
      Object.entries(userRewards).map(([address, reward]) => {
        // If the reward is smaller than the threshold, set it to 0
        const adjustedReward = reward < threshold ? 0 : reward;
        return [address.toLowerCase(), adjustedReward];
      })
    );

    const elements = [];
    for (let i = 0; i < userRewardAddresses.length; i++) {
      const userAddress = userRewardAddresses[i];

      const amount = parseEther(adjustedUserRewards[userAddress.toLowerCase()].toString());

      elements.push(utils.solidityKeccak256(["uint256", "address", "uint256"], [i, userAddress.toLowerCase(), BigNumber.from(amount)]));
    }

    const merkleTree = new MerkleTree(elements, keccak256, { sort: true });

    const merkle = {};
    let totalAmount = BigNumber.from(0);
    for (let i = 0; i < userRewardAddresses.length; i++) {
      const userAddress = userRewardAddresses[i];
      const amount = BigNumber.from(parseEther(adjustedUserRewards[userAddress.toLowerCase()].toString()));
      totalAmount = totalAmount.add(amount);

      merkle[userAddress.toLowerCase()] = {
        index: i,
        amount,
        proof: merkleTree.getHexProof(elements[i]),
      };
    }

    newMerkles.push({
      "symbol": SPACES_SYMBOL[space],
      "address": tokenToDistribute,
      "image": SPACES_IMAGE[space],
      "merkle": merkle,
      root: merkleTree.getHexRoot(),
      "total": totalAmount,
      "chainId": parseInt(SPACE_TO_CHAIN_ID[space]),
      "merkleContract": NETWORK_TO_MERKLE[network]
    });

    if (!toFreeze[network]) {
      toFreeze[network] = [];
    }
    if (!toSet[network]) {
      toSet[network] = [];
    }
    toFreeze[network].push(tokenToDistribute);
    toSet[network].push(merkleTree.getHexRoot());
  }

  // Generate pendle 
  let pendleAprs = [];
  const space = SDPENDLE_SPACE;

  checkSpace(space, SPACES_SYMBOL, SPACES_IMAGE, SPACES_UNDERLYING_TOKEN, SPACES_TOKENS, SPACE_TO_NETWORK, NETWORK_TO_STASH, NETWORK_TO_MERKLE);

  // If there is none on report, do not proceed
  if (csvResult[space]) {
    allPeriods = Object.keys(csvResult[space]);
    const proposalsPeriods = await fetchProposalsIdsBasedOnPeriods(space, allPeriods);


    const tokenPrice = await getTokenPrice(space, SPACE_TO_NETWORK, SPACES_UNDERLYING_TOKEN);

    // Users can have rewards on multiple periods => sum them
    let pendleUserRewards = {};

    // Merge rewards by proposal period
    const pendleRewards = {};

    for (const period in csvResult[space]) {
      const proposalId = proposalsPeriods[period];
      if (!pendleRewards[proposalId]) {
        pendleRewards[proposalId] = {};
      }

      const rewards = csvResult['sdpendle.eth'][period];
      for (const address in rewards) {
        if (pendleRewards[proposalId][address]) {
          pendleRewards[proposalId][address] += rewards[address];
        } else {
          pendleRewards[proposalId][address] = rewards[address];
        }
      }
    }

    // console.log("pendleRewardsPerProposal", pendleRewards);


    for (const proposalId in pendleRewards) {

      // console.log("proposalId", proposalId);

      // Get the proposal to find the create timestamp
      const proposal = await getProposal(proposalId);

      // Extract address per choice
      // The address will be only the strat of the address
      const allAddressesPerChoice = extractProposalChoices(proposal);

      // Get only choices where we have a bribe reward
      // Now, the address is the complete address
      // Map -> gauge address => {index : choice index, amount: sdTKN }
      // If index = -1, no data on snapshot BUT gauge on report
      const addressesPerChoice = getChoicesBasedOnReport(allAddressesPerChoice, pendleRewards[proposalId]);


      console.log("addressesPerChoice", addressesPerChoice);

      // Here, we should have delegation voter + all other voters
      // Object with vp property
      let voters = await getVoters(proposalId);

      voters = await getVoterVotingPower(proposal, voters, SPACE_TO_CHAIN_ID["sdpendle.eth"]);
      voters = await addVotersFromAutoVoter("sdpendle.eth", proposal, voters, allAddressesPerChoice);

      if(proposalId.toLowerCase() === "0x7d741fb408de334dbebc9d90c0d798677e8792c37e542f35ecc036048ead1c6c".toLowerCase()) {
        let delegationVoter = voters.find(v => v.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase());
        if(!delegationVoter) {
          delegationVoter = {
            totalRewards: 0,
            choice: {
              "-1": 50,
              "-2": 50
            },
            voter: DELEGATION_ADDRESS,
            vp: 672290
          }

          voters.push(delegationVoter)
        }
      }
      
      console.log("voters", voters);

      // Get all delegator addresses
      const delegators = await getAllDelegators(DELEGATION_ADDRESS, proposal.created, space);

      // Get voting power for all delegator
      // Map of address => VotingPower
      const delegatorsVotingPower = await getDelegationVotingPower(proposal, delegators.concat([DELEGATION_ADDRESS]), SPACE_TO_CHAIN_ID[space]);


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

      const delegatorSumVotingPower = Object.values(delegatorsVotingPower).reduce((acc, vp) => acc + vp, 0.0);
      let delegationVote = voters.find((v) => v.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase());
      //const delegatorSumVotingPower = delegationVote;
      if (!delegationVote) {
        delegationVote = {
          totalRewards: 0,
          vp: 0,
        }
        //throw new Error("No delegation vote for " + space + " - " + id);
      }

      delegationVote.totalRewards = 0;


      const nonFoundGauges = {};
      let delegationRewardsForNonFoundGauges = 0;

      for (const gaugeAddress of Object.keys(addressesPerChoice)) {
        const index = addressesPerChoice[gaugeAddress].index;
        const sdTknRewardAmount = addressesPerChoice[gaugeAddress].amount;

        /*
        console.log("gaugeAddress", gaugeAddress);
        console.log("index", index);
        console.log("sdTknRewardAmount", sdTknRewardAmount);
        */
       
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

          const ratio = currentChoiceIndex * 100 / vpChoiceSum;
          totalVP += voter.vp * ratio / 100;
        }

        if (!foundVotersForGauge) {
          nonFoundGauges[gaugeAddress] = {
            index: index,
            amount: sdTknRewardAmount
          };
          delegationRewardsForNonFoundGauges += sdTknRewardAmount;
          continue;
        }

        // SPECIAL CASE : If there is no gauge found on votes BUT on report, all rewards for delegation
        // We split the bribe reward amount between voters
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
          const ratio = currentChoiceIndex * 100 / vpChoiceSum;
          const vpUsed = voter.vp * ratio / 100;
          const totalVPRatio = vpUsed * 100 / totalVP;
          const amountEarned = totalVPRatio * sdTknRewardAmount / 100;

          if (voter.totalRewards === undefined) {
            voter.totalRewards = 0;
          }

          voter.totalRewards += amountEarned;
        }
      }

      // Add all rewards from non-found gauges to the DELEGATION_ADDRESS
      let delegationVoter = voters.find(v => v.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase());
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
          choice: {}
        });
      }

      // console.log("Non-found gauges:", nonFoundGauges);




      // console.log("voters", voters);


      // Now we have all rewards across all voters
      // But one voter is the delegation, we have to split his rewards across the delegation
      delegationVote = voters.find((v) => v.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase());
      if (delegationVote) {
        delegationVote.delegation = {};

        for (const delegatorAddress of Object.keys(delegatorsVotingPower)) {
          const vp = delegatorsVotingPower[delegatorAddress];
          const ratioVp = vp * 100 / delegatorSumVotingPower;
          delegationVote.delegation[delegatorAddress.toLowerCase()] = ratioVp * delegationVote.totalRewards / 100;
        }

        // Check split
        /*const totalSplitDelegationRewards = Object.values(delegationVote.delegation).reduce((acc, d) => acc + d, 0.0) || 0;
        if (parseInt(delegationVote.totalRewards) !== parseInt(totalSplitDelegationRewards)) {
          throw new Error("Delegation " + space + " - " + id + " split rewards wrong " + delegationVote.totalRewards + " - " + totalSplitDelegationRewards);
        }*/

        // Calculate delegation apr
        if (delegationVote.vp > 0) {
          let delegationAPR = ((Number(delegationVote.totalRewards) * 26 * tokenPrice) / delegationVote.vp) * 100 / tokenPrice;
          pendleAprs.push(delegationAPR);
        }
      }

      // Create a map with userAddress => reward amount
      const proposalUserRewards = {};

      for (const voter of voters) {
        if (!voter.totalRewards) {
          continue
        }

        if (voter.delegation) {
          for (const delegatorAddress of Object.keys(voter.delegation)) {
            const amount = voter.delegation[delegatorAddress.toLowerCase()];
            if (proposalUserRewards[delegatorAddress.toLowerCase()]) {
              proposalUserRewards[delegatorAddress.toLowerCase()] += amount;
            } else {
              proposalUserRewards[delegatorAddress.toLowerCase()] = amount;
            }
          }
        } else {
          if (proposalUserRewards[voter.voter.toLowerCase()]) {
            proposalUserRewards[voter.voter.toLowerCase()] += voter.totalRewards;
          } else {
            proposalUserRewards[voter.voter.toLowerCase()] = voter.totalRewards;
          }
        }
      }

      // Add / sum with pendleUserRewards
      for (const userAddress in proposalUserRewards) {
        if (pendleUserRewards[userAddress]) {
          pendleUserRewards[userAddress] += proposalUserRewards[userAddress];
        } else {
          pendleUserRewards[userAddress] = proposalUserRewards[userAddress];
        }
      }

    } // end for proposalId in pendleRewards

    // console.log("pendleUserRewards", pendleUserRewards);


    // New distribution is split here
    // We have to sum with old distribution if users don't claim
    const tokenToDistribute = SPACES_TOKENS[space];

    const lastMerkle = lastMerkles.find((m) => m.address.toLowerCase() === tokenToDistribute.toLowerCase());
    const network = SPACE_TO_NETWORK[space];

    if (lastMerkle) {

      let usersClaimedAddress = await getAllAccountClaimedSinceLastFreezeOnMainnet(lastMerkle, MERKLE_ADDRESS);

      const userAddressesLastMerkle = Object.keys(lastMerkle.merkle);

      for (const userAddress of userAddressesLastMerkle) {

        const userAddressLowerCase = userAddress.toLowerCase();
        const isClaimed = usersClaimedAddress[userAddressLowerCase];

        // If user didn't claim, we add the previous rewards to new one
        if (!isClaimed) {
          const leaf = lastMerkle.merkle[userAddress];
          const amount = parseFloat(formatUnits(BigNumber.from(leaf.amount), 18));

          if (pendleUserRewards[userAddressLowerCase]) {
            pendleUserRewards[userAddressLowerCase] += amount;
          } else {
            pendleUserRewards[userAddressLowerCase] = amount;
          }
        }
      }
    }

    console.log("pendleUserRewards", pendleUserRewards);

    // Since this point, pendleUserRewards map contains the new reward amount for each user
    // We have to generate the merkle
    const userRewardAddresses = Object.keys(pendleUserRewards);


    // Define a threshold below which numbers are considered too small and should be set to 0
    const threshold = 1e-8;

    const adjustedUserRewards = Object.fromEntries(
      Object.entries(pendleUserRewards).map(([address, reward]) => {
        // If the reward is smaller than the threshold, set it to 0
        const adjustedReward = reward < threshold ? 0 : reward;
        return [address.toLowerCase(), adjustedReward];
      })
    );

    const elements = [];
    for (let i = 0; i < userRewardAddresses.length; i++) {
      const userAddress = userRewardAddresses[i];

      const amount = parseEther(adjustedUserRewards[userAddress.toLowerCase()].toString());

      elements.push(utils.solidityKeccak256(["uint256", "address", "uint256"], [i, userAddress.toLowerCase(), BigNumber.from(amount)]));
    }

    const merkleTree = new MerkleTree(elements, keccak256, { sort: true });

    const merkle = {};
    let totalAmount = BigNumber.from(0);
    for (let i = 0; i < userRewardAddresses.length; i++) {
      const userAddress = userRewardAddresses[i];
      const amount = BigNumber.from(parseEther(adjustedUserRewards[userAddress.toLowerCase()].toString()));
      totalAmount = totalAmount.add(amount);

      merkle[userAddress.toLowerCase()] = {
        index: i,
        amount,
        proof: merkleTree.getHexProof(elements[i]),
      };
    }

    newMerkles.push({
      "symbol": SPACES_SYMBOL[space],
      "address": tokenToDistribute,
      "image": SPACES_IMAGE[space],
      "merkle": merkle,
      root: merkleTree.getHexRoot(),
      "total": totalAmount,
      "chainId": parseInt(SPACE_TO_CHAIN_ID[space]),
      "merkleContract": NETWORK_TO_MERKLE[network]
    });

    if (!toFreeze[network]) {
      toFreeze[network] = [];
    }
    if (!toSet[network]) {
      toSet[network] = [];
    }
    toFreeze[network].push(tokenToDistribute);
    toSet[network].push(merkleTree.getHexRoot());

  } // end if csvResult[space] (Pendle distribution)


  // Add pendle aprs
  if(!delegationAPRs[space]) {
    delegationAPRs[space] = 0;
  }

  delegationAPRs[space] = pendleAprs.reduce((acc, apr) => acc + apr, 0) / pendleAprs.length;

  logData["Transactions"] = [];

  for (const network of Object.keys(toFreeze)) {
    let multiSetName = null;
    if (network === "ethereum") {
      multiSetName = 'multiSet';
    } else {
      multiSetName = 'multiUpdateMerkleRoot';
    }

    const freezeData = encodeFunctionData({
      abi,
      functionName: 'multiFreeze',
      args: [toFreeze[network]],
    });

    const multiSetData = encodeFunctionData({
      abi,
      functionName: multiSetName,
      args: [toFreeze[network], toSet[network]],
    });

    logData["Transactions"].push({
      "network": network,
      "tokenAddressesToFreeze": toFreeze[network],
      "newMerkleRoots": toSet[network],
      "toFreeze": {
        "contract": NETWORK_TO_STASH[network],
        "data": freezeData,
      },
      "toSet": {
        "contract": NETWORK_TO_STASH[network],
        "function": multiSetName,
        "data": multiSetData,
      },
    });
  }

  for (const lastMerkle of lastMerkles) {

    let found = false;
    for (const newMerkle of newMerkles) {
      if (newMerkle.address.toLowerCase() === lastMerkle.address.toLowerCase()) {
        found = true;
        break;
      }
    }

    if (!found) {
      newMerkles.push(lastMerkle);
    }
  }

  fs.writeFileSync(`./merkle.json`, JSON.stringify(newMerkles));
  fs.writeFileSync(`./delegationsAPRs.json`, JSON.stringify(delegationAPRs));

  // Add full path to the written files in the log
  logData["Merkle"] = path.join(__dirname, 'merkle.json');
  logData["DelegationsAPRs"] = path.join(__dirname, 'delegationsAPRs.json');

  fs.writeFileSync(path.join(__dirname, 'log.json'), JSON.stringify(logData));

  const logPath = path.join(__dirname, 'log.json');
  fs.writeFileSync(logPath, JSON.stringify(logData));

  console.log(logPath);
}



main();