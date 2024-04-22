const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const fs = require('fs');
const path = require('path');
const orderBy = require("lodash/orderBy");
const { gql, request } = require("graphql-request");
const axios = require('axios').default;
const { utils, BigNumber } = require("ethers");
const { parse } = require("csv-parse/sync");
const { parseAbi, encodeFunctionData, formatUnits, parseEther, createPublicClient, http } = require("viem");
const { bsc, mainnet } = require('viem/chains');
const VOTER_ABI = require("./abis/AutoVoter.json");
const dotenv = require("dotenv");

dotenv.config();

const MERKLE_ADDRESS = "0x03E34b085C52985F6a5D27243F20C84bDdc01Db4";
const MERKLE_BSC_ADDRESS = "0xd65cE3d391318A35bF6e24A300359eB5436b6A40";
const STASH_CONTROLLER_ADDRESS = "0x2f18e001B44DCc1a1968553A2F32ab8d45B12195";

const SNAPSHOT_ENDPOINT = "https://hub.snapshot.org/graphql";
const ENDPOINT_DELEGATORS = "https://api.thegraph.com/subgraphs/name/snapshot-labs/snapshot";
const ENDPOINT_DELEGATORS_BSC = "https://api.thegraph.com/subgraphs/name/snapshot-labs/snapshot-binance-smart-chain";

// Auto Voter
const AUTO_VOTER_DELEGATION_ADDRESS = "0x0657C6bEe67Bb96fae96733D083DAADE0cb5a179";
const AUTO_VOTER_CONTRACT = "0x619eDEF2d18Ec9758E96D8FF2c7DcbFb58DD5A5C";

// Delegation
const DELEGATION_ADDRESS = "0x52ea58f4FC3CEd48fa18E909226c1f8A0EF887DC";

// Agnostic
const AGNOSTIC_ENDPOINT = "https://proxy.eu-02.agnostic.engineering/query";
const AGNOSTIC_API_KEY = "Fr2LXSVvKCfmXse8JQJiJBLHY9ujU3YZf8Kr6TDDh4Sw";

// Networks
const ETHEREUM = "ethereum";
const ETH_CHAIN_ID = "1";
const BSC = "bsc";
const BSC_CHAIN_ID = "56";

const SDCRV_SPACE = "sdcrv.eth";
const SDBAL_SPACE = "sdbal.eth";
const SDFXS_SPACE = "sdfxs.eth";
const SDANGLE_SPACE = "sdangle.eth";
const SDPENDLE_SPACE = "sdpendle.eth";
const SDCAKE_SPACE = "sdcake.eth";
const SDFXN_SPACE = "sdfxn.eth";

const SPACES = [SDCRV_SPACE, SDBAL_SPACE, SDFXS_SPACE, SDANGLE_SPACE, SDPENDLE_SPACE, SDCAKE_SPACE, SDFXN_SPACE];

const LABELS_TO_SPACE = {
  "frax": SDFXS_SPACE,
  "curve": SDCRV_SPACE,
  "balancer": SDBAL_SPACE,
  "angle": SDANGLE_SPACE,
  "pendle": SDPENDLE_SPACE,
  "cake": SDCAKE_SPACE,
  "fxn": SDFXN_SPACE,
};

const SUBGRAP_BY_CHAIN = {
  [BSC]: ENDPOINT_DELEGATORS_BSC,
  [ETHEREUM]: ENDPOINT_DELEGATORS
};

const SPACE_TO_NETWORK = {
  [SDFXS_SPACE]: ETHEREUM,
  [SDCRV_SPACE]: ETHEREUM,
  [SDBAL_SPACE]: ETHEREUM,
  [SDANGLE_SPACE]: ETHEREUM,
  [SDPENDLE_SPACE]: ETHEREUM,
  [SDFXN_SPACE]: ETHEREUM,
  [SDCAKE_SPACE]: BSC,
}

const SPACE_TO_CHAIN_ID = {
  [SDFXS_SPACE]: ETH_CHAIN_ID,
  [SDCRV_SPACE]: ETH_CHAIN_ID,
  [SDBAL_SPACE]: ETH_CHAIN_ID,
  [SDANGLE_SPACE]: ETH_CHAIN_ID,
  [SDPENDLE_SPACE]: ETH_CHAIN_ID,
  [SDFXN_SPACE]: ETH_CHAIN_ID,
  [SDCAKE_SPACE]: BSC_CHAIN_ID,
}

const NETWORK_TO_STASH = {
  [ETHEREUM]: STASH_CONTROLLER_ADDRESS,
  [BSC]: MERKLE_BSC_ADDRESS,
}

const NETWORK_TO_MERKLE = {
  [ETHEREUM]: MERKLE_ADDRESS,
  [BSC]: MERKLE_BSC_ADDRESS,
}

const SPACES_TOKENS = {
  [SDCRV_SPACE]: "0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5",
  [SDBAL_SPACE]: "0xF24d8651578a55b0C119B9910759a351A3458895",
  [SDFXS_SPACE]: "0x402F878BDd1f5C66FdAF0fabaBcF74741B68ac36",
  [SDANGLE_SPACE]: "0x752B4c6e92d96467fE9b9a2522EF07228E00F87c",
  [SDPENDLE_SPACE]: "0x5Ea630e00D6eE438d3deA1556A110359ACdc10A9",
  [SDFXN_SPACE]: "0xe19d1c837B8A1C83A56cD9165b2c0256D39653aD",
  [SDCAKE_SPACE]: "0x6a1c1447F97B27dA23dC52802F5f1435b5aC821A"
};

const SPACES_SYMBOL = {
  [SDCRV_SPACE]: "sdCRV",
  [SDBAL_SPACE]: "sdBAL",
  [SDFXS_SPACE]: "sdFXS",
  [SDANGLE_SPACE]: "sdANGLE",
  [SDPENDLE_SPACE]: "sdPENDLE",
  [SDCAKE_SPACE]: "sdCAKE",
  [SDFXN_SPACE]: "sdFXN",
};

const SPACES_IMAGE = {
  [SDCRV_SPACE]: "https://assets.coingecko.com/coins/images/27756/small/scCRV-2.png?1665654580",
  [SDBAL_SPACE]: "https://assets.coingecko.com/coins/images/11683/small/Balancer.png?1592792958",
  [SDFXS_SPACE]: "https://assets.coingecko.com/coins/images/13423/small/Frax_Shares_icon.png?1679886947",
  [SDANGLE_SPACE]: "https://assets.coingecko.com/coins/images/19060/small/ANGLE_Token-light.png?1666774221",
  [SDPENDLE_SPACE]: "https://beta.stakedao.org/assets/pendle.svg",
  [SDCAKE_SPACE]: "https://cdn.stamp.fyi/space/sdcake.eth?s=96&cb=cd2ea5c12296e731",
  [SDFXN_SPACE]: "https://cdn.jsdelivr.net/gh/curvefi/curve-assets/images/assets/0xe19d1c837b8a1c83a56cd9165b2c0256d39653ad.png",
};

const SPACES_UNDERLYING_TOKEN = {
  [SDCRV_SPACE]: "0xd533a949740bb3306d119cc777fa900ba034cd52",
  [SDBAL_SPACE]: "0x5c6ee304399dbdb9c8ef030ab642b10820db8f56", //80BAL instead of bal
  [SDFXS_SPACE]: "0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0",
  [SDANGLE_SPACE]: "0x31429d1856ad1377a8a0079410b297e1a9e214c2",
  [SDPENDLE_SPACE]: "0x808507121b80c02388fad14726482e061b8da827",
  [SDCAKE_SPACE]: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
  [SDFXN_SPACE]: "0x365AccFCa291e7D3914637ABf1F7635dB165Bb09",
};

const abi = parseAbi([
  'function multiFreeze(address[] tokens) public',
  'function multiSet(address[] tokens, bytes32[] roots) public',
  'function multiUpdateMerkleRoot(address[] tokens, bytes32[] roots) public',
  'function isClaimed(address token, uint256 index) public view returns (bool)',
]);

const logData = {}; // Use to store and write logs in a JSON 


const main = async () => {
  const csvResult = await extractCSV();

  // Fetch last merkle
  const { data: lastMerkles } = await axios.get("https://raw.githubusercontent.com/stake-dao/bounties-report/main/merkle.json");

  // Fetch last proposal ids
  const proposalIdPerSpace = await fetchLastProposalsIds();

  const newMerkles = [];
  const { data: delegationAPRs } = await axios.get("https://raw.githubusercontent.com/stake-dao/bounties-report/main/delegationsAPRs.json");

  const toFreeze = {};
  const toSet = {};

  for (const space of Object.keys(proposalIdPerSpace)) {
    checkSpace(space);

    // If no bribe to distribute to this space => skip
    if (!csvResult[space]) {
      continue;
    }

    const tokenPrice = await getTokenPrice(space);

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
    /*if(delegationVote.vp !== delegatorSumVotingPower) {
      throw new Error("Voting power delegation !== voting power sum all delegators - " + delegationVote.vp + " vs " + delegatorSumVotingPower + " - " + space + " - " + id);
    }*/

    // We can have sum delegation lower than delegation vp
    //delegationVote.vp = delegatorSumVotingPower;
    delegationVote.totalRewards = 0;

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

      // Check split
      /*const totalSplitDelegationRewards = Object.values(delegationVote.delegation).reduce((acc, d) => acc + d, 0.0) || 0;
      if (parseInt(delegationVote.totalRewards) !== parseInt(totalSplitDelegationRewards)) {
        throw new Error("Delegation " + space + " - " + id + " split rewards wrong " + delegationVote.totalRewards + " - " + totalSplitDelegationRewards);
      }*/

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

const extractCSV = async () => {
  const reportDir = path.join(__dirname, 'bribes-reports/');

  // Read the directory and filter out the CSV files
  const files = fs.readdirSync(reportDir);
  const csvFiles = files.filter(file => file.endsWith('.csv'));

  // Sort the CSV files based on the date in the filename in descending order (latest date first)
  const sortedCsvFiles = csvFiles.sort((a, b) => {
    const dateA = a.split('_')[0];
    const dateB = b.split('_')[0];
    return new Date(dateB) - new Date(dateA);
  }).reverse();

  logData["Latest report"] = sortedCsvFiles[0];

  // Get the most recent CSV file
  const mostRecentCsvFile = sortedCsvFiles[0];

  // Read the CSV file from the file system
  const csvFile = fs.readFileSync(path.join(reportDir, mostRecentCsvFile), 'utf8');


  let records = parse(csvFile, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ";",
  });

  const newRecords = [];
  for (const row of records) {
    let obj = {};
    for (const key of Object.keys(row)) {
      obj[key.toLowerCase()] = row[key];
    }
    newRecords.push(obj);
  }

  records = newRecords;

  const response = {};
  for (const row of records) {
    const space = LABELS_TO_SPACE[row["protocol"]];
    if (!space) {
      throw new Error("can't find space for " + row["protocol"]);
    }

    if (!response[space]) {
      response[space] = {};
    }

    const gaugeAddress = row["Gauge Address".toLowerCase()];
    if (!gaugeAddress) {
      throw new Error("can't find gauge address for " + row["protocol"]);
    }

    if (!response[space][gaugeAddress]) {
      response[space][gaugeAddress] = 0;
    }

    response[space][gaugeAddress] += parseFloat(row["Reward sd Value".toLowerCase()])
  }

  return response;
};

/**
 * Fetch last proposal id for all spaces
 */
const fetchLastProposalsIds = async () => {

  const query = gql`
    query Proposals {
      proposals(
        first: 1000
        skip: 0
        orderBy: "created",
        orderDirection: desc,
        where: {
          space_in: [${SPACES.map((space) => '"' + space + '"').join(",")}]
          type: "weighted"
        }
      ) {
        id
        title
        space {
          id
        }
      }
    }
  `;

  const result = await request(SNAPSHOT_ENDPOINT, query);
  const proposals = result.proposals.filter((proposal) => proposal.title.indexOf("Gauge vote") > -1);

  const proposalIdPerSpace = {};
  for (const space of SPACES) {

    let firstGaugeProposal = null;
    let added = false;
    for (const proposal of proposals) {
      if (proposal.space.id !== space) {
        continue;
      }

      // Always the last proposal for sdPendle
      if (firstGaugeProposal || space === SDCAKE_SPACE) {
        proposalIdPerSpace[space] = proposal.id;
        added = true;
        break;
      }

      firstGaugeProposal = proposal;
    }

    if (!added && firstGaugeProposal) {
      proposalIdPerSpace[space] = firstGaugeProposal.id;
    }
  }

  return proposalIdPerSpace;
}

/**
 * Get all voters for a proposal
 */
const getVoters = async (proposalId) => {
  const QUERY_VOTES = gql`
    query Proposal(
      $proposal: String!
      $orderBy: String
      $orderDirection: OrderDirection
      $created: Int
    ) {
      votes(
        first: 1000
        where: { proposal: $proposal, vp_gt: 0, created_lt: $created }
        orderBy: $orderBy
        orderDirection: $orderDirection
      ) {
        id
        ipfs
        voter
        created
        choice
        vp
        vp_by_strategy
      }
    }
  `;

  let votes = [];
  let run = true;
  let created = null

  // Fetch all data
  do {
    let params = {
      proposal: proposalId,
      orderBy: "created",
      orderDirection: "desc",
    };

    if (created) {
      params["created"] = created;
    }

    const result = await request(SNAPSHOT_ENDPOINT, QUERY_VOTES, params);

    if (result.votes?.length > 0) {
      votes = votes.concat(result.votes);
      created = result.votes[result.votes.length - 1].created;
    }
    else {
      run = false;
    }

  } while (run);

  return votes;
}

const getVoterVotingPower = async (proposal, votes, network) => {
  try {
    const votersAddresses = votes.map((v) => v.voter);

    const { data } = await axios.post(
      "https://score.snapshot.org/api/scores",
      {
        params: {
          network,
          snapshot: parseInt(proposal.snapshot),
          strategies: proposal.strategies,
          space: proposal.space.id,
          addresses: votersAddresses
        },
      },
    );

    const scores = votes.map((vote) => {
      let vp = 0;
      if (vote.vp > 0) {
        vp = vote.vp;
      } else if (data?.result?.scores) {
        for (const score of data.result.scores) {
          const keys = Object.keys(score);
          for (const key of keys) {
            if (key.toLowerCase() === vote.voter.toLowerCase()) {
              vp += score[key];
              break;
            }
          }
        }
        //vp = data?.result?.scores?.[0]?.[vote.voter] || data?.result?.scores?.[1]?.[vote.voter];
      }
      return { ...vote, vp };
    });

    return orderBy(scores, "vp", "desc");
  }
  catch (e) {
    console.log("Error getVoterVotingPower");
    throw e;
  }
}

/**
 * Will fetch auto voter delegators at the snapshot block number and add them as voters
 */
const addVotersFromAutoVoter = async (space, proposal, voters, addressesPerChoice) => {
  const autoVoter = voters.find((v) => v.voter.toLowerCase() === AUTO_VOTER_DELEGATION_ADDRESS.toLowerCase());
  if (!autoVoter) {
    return voters;
  }

  const delegators = await getAllDelegators(AUTO_VOTER_DELEGATION_ADDRESS, proposal.created, space);
  if (delegators.length === 0) {
    return voters;
  }

  const { data } = await axios.post(
    "https://score.snapshot.org/api/scores",
    {
      params: {
        network: '1',
        snapshot: parseInt(proposal.snapshot),
        strategies: proposal.strategies,
        space: proposal.space.id,
        addresses: delegators
      },
    },
  );

  // Compute delegators voting power at the proposal timestamp
  const votersVp = {};

  for (const score of data.result.scores) {
    const keys = Object.keys(score);
    for (const key of keys) {
      const vp = score[key];
      if (vp === 0) {
        continue;
      }

      const user = key.toLowerCase();
      if (!votersVp[user]) {
        votersVp[user] = 0;
      }

      votersVp[user] += vp;
    }
  }

  const delegatorAddresses = Object.keys(votersVp);
  if (delegatorAddresses.length === 0) {
    return voters;
  }

  // Fetch delegators weight registered in the auto voter contract
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(process.env.RPC_URL || undefined),
    batch: {
      multicall: true,
    }
  });

  const results = await publicClient.multicall({
    contracts: delegatorAddresses.map((delegatorAddress) => {
      return {
        address: AUTO_VOTER_CONTRACT,
        abi: VOTER_ABI,
        functionName: 'get',
        args: [delegatorAddress, space]
      }
    }),
    blockNumber: parseInt(proposal.snapshot)
  });

  if (results.some((r) => r.status === "failure")) {
    throw new Error("Error when fetching auto voter weights : " + JSON.stringify(results));
  }

  const gaugeAddressesFromProposal = Object.keys(addressesPerChoice);

  for (const delegatorAddress of delegatorAddresses) {
    const data = results.shift().result;
    if (data.killed) {
      continue;
    }

    if (data.user.toLowerCase() !== delegatorAddress.toLowerCase()) {
      continue;
    }

    // Shouldn't be undefined or 0 here
    const vp = votersVp[delegatorAddress.toLowerCase()];
    if (!vp) {
      throw new Error("Error when getting user voting power");
    }

    const gauges = data.gauges;
    const weights = data.weights;

    if (gauges.length !== weights.length) {
      throw new Error("gauges length != weights length");
    }

    const choices = {};

    for (let i = 0; i < gauges.length; i++) {
      const gauge = gauges[i];
      const weight = weights[i];

      // Need to find the choice index from the gauge address
      const gaugeAddressFromProposal = gaugeAddressesFromProposal.find((g) => gauge.toLowerCase().indexOf(g.toLowerCase()) > -1);
      if (!gaugeAddressFromProposal) {
        throw new Error("Can't find gauge address");
      }

      choices[addressesPerChoice[gaugeAddressFromProposal].toString()] = Number(weight);
    }

    voters.push({
      "voter": delegatorAddress.toLowerCase(),
      "choice": choices,
      "vp": vp,
    });
  }

  // Remove auto voter to not receive bounty rewards
  return voters
    .filter((voter) => voter.voter.toLowerCase() !== AUTO_VOTER_DELEGATION_ADDRESS.toLowerCase());
}

/**
 * Fetch the proposal
 */
const getProposal = async (idProposal) => {

  const QUERY_PROPOSAL = gql`
    query Proposal(
      $id: String!
    ) {
      proposal(id: $id) {
        id
        ipfs
        title
        body
        start
        end
        state
        author
        created
        choices
        snapshot
        type
        strategies {
          name
          params
        }
        space {
          id
          name
          members
          avatar
          symbol
        }
        scores_state
        scores_total
        scores
        votes
      }
    }
  `;

  const result = await request(SNAPSHOT_ENDPOINT, QUERY_PROPOSAL, {
    id: idProposal,
  });
  return result.proposal;
}

/**
 * All endpoints here : https://raw.githubusercontent.com/snapshot-labs/snapshot.js/master/src/delegationSubgraphs.json
 */
const getAllDelegators = async (delegationAddress, proposalCreatedTimestamp, space) => {
  let delegatorAddresses = [];
  let run = true;
  let skip = 0;

  const DELEGATIONS_QUERY = gql`
    query Proposal(
      $skip: Int
      $timestamp: Int
      $space: String
      ) {
      delegations(first: 1000 skip: $skip where: { 
        space: $space 
        delegate:"${delegationAddress}"
        timestamp_lte: $timestamp
      }) {
        delegator
        space
        delegate
      }
    }
  `;

  // Fetch all data
  do {
    const result = await request(SUBGRAP_BY_CHAIN[SPACE_TO_NETWORK[space]], DELEGATIONS_QUERY, { space, skip, timestamp: proposalCreatedTimestamp });

    if (result.delegations?.length > 0) {
      delegatorAddresses = delegatorAddresses.concat(result.delegations.map((d) => d.delegator));
      skip += 1000;
    }
    else {
      run = false;
    }

  } while (run);

  return delegatorAddresses;
};

const getDelegationVotingPower = async (proposal, delegatorAddresses, network) => {
  try {
    const { data } = await axios.post(
      "https://score.snapshot.org/api/scores",
      {
        params: {
          network,
          snapshot: parseInt(proposal.snapshot),
          strategies: proposal.strategies,
          space: proposal.space.id,
          addresses: delegatorAddresses
        },
      },
    );

    if (!data?.result?.scores) {
      throw new Error("No score");
    }

    let result = {};
    for (const score of data.result.scores) {
      result = {
        ...result,
        ...score
      };
    }
    return result;
  }
  catch (e) {
    console.log(e);
    throw e;
  }
}

/**
 * For each proposal choice, extract his gauge address with his index
 */
const extractProposalChoices = (proposal) => {
  const addressesPerChoice = {};

  if (proposal.space.id.toLowerCase() === SDPENDLE_SPACE.toLowerCase()) {
    const SEP = " - ";
    const SEP2 = "-";

    for (let i = 0; i < proposal.choices.length; i++) {
      const choice = proposal.choices[i];
      if (choice.indexOf("Current Weights") > -1 || choice.indexOf("Paste") > -1 || choice.indexOf("Total Percentage") > -1) {
        continue;
      }
      const start = choice.indexOf(SEP);
      if (start === -1) {
        throw new Error("Impossible to parse choice : " + choice);
      }

      const end = choice.indexOf(SEP2, start + SEP.length);
      if (end === -1) {
        throw new Error("Impossible to parse choice : " + choice);
      }

      const address = choice.substring(end + SEP2.length);
      addressesPerChoice[address] = i + 1;
    }
  } else {
    const SEP = " - 0x";

    for (let i = 0; i < proposal.choices.length; i++) {
      const choice = proposal.choices[i];
      if (choice.indexOf("Current Weights") > -1 || choice.indexOf("Paste") > -1 || choice.indexOf("Total Percentage") > -1) {
        continue;
      }
      const start = choice.indexOf(" - 0x");
      if (start === -1) {
        throw new Error("Impossible to parse choice : " + choice);
      }

      let end = choice.indexOf("…", start);
      if (end === -1) {
        end = choice.indexOf("...", start);
        if (end === -1) {
          //throw new Error("Impossible to parse choice : " + choice);
          continue;
        }
      }

      const address = choice.substring(start + SEP.length - 2, end);
      addressesPerChoice[address] = i + 1;
    }
  }

  return addressesPerChoice;
};

const getChoiceWhereExistsBribe = (addressesPerChoice, cvsResult) => {
  const newAddressesPerChoice = {};
  if (!cvsResult) {
    return newAddressesPerChoice;
  }

  const cvsResultLowerCase = {};
  for (const key of Object.keys(cvsResult)) {
    cvsResultLowerCase[key.toLowerCase()] = cvsResult[key];
  }

  const addresses = Object.keys(cvsResultLowerCase).map((addr) => addr.toLowerCase());

  for (const key of Object.keys(addressesPerChoice)) {
    const k = key.toLowerCase();

    for (const addr of addresses) {
      if (addr.indexOf(k) === -1) {
        continue;
      }

      newAddressesPerChoice[addr] = {
        index: addressesPerChoice[key],
        amount: cvsResultLowerCase[addr]
      };
      break;
    }
  }

  if (Object.keys(newAddressesPerChoice).length !== addresses.length) {
    throw new Error("Error when get complete gauge address");
  }

  return newAddressesPerChoice;
};

const DATE_LAST_CLAIM_QUERY = `
  SELECT
      timestamp
  FROM evm_events_ethereum_mainnet
  WHERE
      address = '${MERKLE_ADDRESS}' and
      signature = 'Claimed(address,uint256,uint256,address,uint256)'
  ORDER BY timestamp DESC
  LIMIT 1
`;

const DATE_LAST_UPDATE_QUERY = (timestamp, tokenAddress) => `
  SELECT
      timestamp
  FROM evm_events_ethereum_mainnet
  WHERE
      address = '${MERKLE_ADDRESS}' and
      timestamp < '${timestamp}' and
      input_0_value_address = '${tokenAddress}' and
      signature = 'MerkleRootUpdated(address,bytes32,uint256)'
  ORDER BY timestamp DESC
  LIMIT 1
`;

const ALL_CLAIMED_QUERY = (since, end, tokenAddress) => `
  SELECT
      input_3_value_address as user
  FROM evm_events_ethereum_mainnet
  WHERE
      address = '${MERKLE_ADDRESS}' and
      timestamp > '${since}' and
      timestamp <= '${end}' and
      input_0_value_address = '${tokenAddress}' and
      signature = 'Claimed(address,uint256,uint256,address,uint256)'
  ORDER BY timestamp DESC
`;

const getAllAccountClaimedSinceLastFreezeWithAgnostic = async (tokenAddress) => {
  const resp = {};

  const lastClaim = await agnosticFetch(DATE_LAST_CLAIM_QUERY);
  const lastUpdate = await agnosticFetch(DATE_LAST_UPDATE_QUERY(lastClaim[0][0], tokenAddress));

  const lastClaimTimestamp = lastClaim[0][0];
  const lastUpdateTimestamp = lastUpdate[0][0];

  const allClaimed = await agnosticFetch(ALL_CLAIMED_QUERY(lastUpdateTimestamp, lastClaimTimestamp, tokenAddress));
  if (!allClaimed) {
    return resp;
  }

  for (const row of allClaimed) {
    resp[row[0].toLowerCase()] = true;
  }
  return resp
}

const agnosticFetch = async (query) => {
  try {
    const response = await axios.post(AGNOSTIC_ENDPOINT, query, {
      headers: {
        'Authorization': `${AGNOSTIC_API_KEY}`,
        "Cache-Control": "max-age=300"
      }
    });

    return response.data.rows;
  }
  catch (e) {
    console.error(e);
    return [];
  }
}

const getAllAccountClaimedSinceLastFreezeOnBSC = async (lastMerkle, merkleContract) => {
  const resp = {};

  const wagmiContract = {
    address: merkleContract,
    abi: abi
  };

  const publicClient = createPublicClient({
    chain: bsc,
    transport: http()
  });

  const calls = [];
  for (const userAddress of Object.keys(lastMerkle.merkle)) {
    const index = lastMerkle.merkle[userAddress].index;
    calls.push({
      ...wagmiContract,
      functionName: 'isClaimed',
      args: [lastMerkle.address, index]
    });
  }

  const results = await publicClient.multicall({
    contracts: calls
  });

  for (const userAddress of Object.keys(lastMerkle.merkle)) {
    if (results.shift().result === true) {
      resp[userAddress.toLowerCase()] = true;
    }
  }

  return resp
}

const getTokenPrice = async (space) => {
  try {
    const key = `${SPACE_TO_NETWORK[space]}:${SPACES_UNDERLYING_TOKEN[space]}`;
    const resp = await axios.get(`https://coins.llama.fi/prices/current/${key}`);

    return resp.data.coins[key].price;
  }
  catch (e) {
    console.log("Error getTokenPrice ", space);
    throw e;
  }
}

const checkSpace = (space) => {
  if (!SPACES_SYMBOL[space]) {
    throw new Error("No symbol defined for space " + space);
  }
  if (!SPACES_IMAGE[space]) {
    throw new Error("No image defined for space " + space);
  }
  if (!SPACES_UNDERLYING_TOKEN[space]) {
    throw new Error("No underlying token defined for space " + space);
  }
  if (!SPACES_TOKENS[space]) {
    throw new Error("No sdToken defined for space " + space);
  }

  if (!SPACE_TO_NETWORK[space]) {
    throw new Error("No network defined for space " + space);
  }

  if (!NETWORK_TO_STASH[SPACE_TO_NETWORK[space]]) {
    throw new Error("No stash contract defined for space " + space);
  }

  if (!NETWORK_TO_MERKLE[SPACE_TO_NETWORK[space]]) {
    throw new Error("No merkle contract defined for space " + space);
  }
}

main();