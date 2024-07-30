const { gql, request } = require("graphql-request");
const fs = require('fs');
const path = require('path');
const { createPublicClient, http } = require("viem");
const { mainnet, bsc } = require('viem/chains');
const { parse } = require("csv-parse/sync");
const axios = require('axios').default;
const VOTER_ABI = require("../../abis/AutoVoter.json");

const { AUTO_VOTER_DELEGATION_ADDRESS, AUTO_VOTER_CONTRACT, SUBGRAP_BY_CHAIN, SPACE_TO_NETWORK, abi, LABELS_TO_SPACE, SDPENDLE_SPACE, SDBAL_SPACE } = require('./constants');

const extractCSV = async (currentPeriodTimestamp, space) => {
    let csvFilePath = undefined;

    if (space === SDPENDLE_SPACE) {
        // Special case here
        const reportDir = path.join(__dirname, '../../bribes-reports/pendle');

        // Read the directory and filter out the CSV files
        const files = fs.readdirSync(reportDir);
        const csvFiles = files.filter(file => file.endsWith('.csv'));

        // Sort the CSV files based on the date in the filename in descending order (latest date first)
        const sortedCsvFiles = csvFiles.sort((a, b) => {
            const dateA = a.split('_')[0];
            const dateB = b.split('_')[0];
            return new Date(dateB) - new Date(dateA);
        }).reverse();

        // Get the most recent CSV file
        const mostRecentCsvFile = sortedCsvFiles[0];
        csvFilePath = path.join(reportDir, mostRecentCsvFile);
    } else {
        let nameSpace = undefined;

        for (const name of Object.keys(LABELS_TO_SPACE)) {
            if (LABELS_TO_SPACE[name] === space) {
                nameSpace = name;
                break;
            }
        }

        if (!nameSpace) {
            throw new Error("can't find name space for space " + space);
        }

        csvFilePath = path.join(__dirname, `../../bribes-reports/${currentPeriodTimestamp}/${nameSpace}.csv`);
    }
    
    if(!csvFilePath || !fs.existsSync(csvFilePath)) {
        return undefined;
    }
    
    // Read the CSV file from the file system
    const csvFile = fs.readFileSync(csvFilePath, 'utf8');

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
    let total = 0;
    for (const row of records) {

        const gaugeAddress = row["Gauge Address".toLowerCase()];
        if (!gaugeAddress) {
            throw new Error("can't find gauge address for " + space);
        }

        // Pendle case : Period passed in protocol 
        if (space === SDPENDLE_SPACE) {
            const period = row["protocol"].split("-")[1];
            if (!response[period]) {
                response[period] = {};
            }

            if (!response[period][gaugeAddress]) {
                response[period][gaugeAddress] = 0;
            }

            total += parseFloat(row["Reward sd Value".toLowerCase()])
            response[period][gaugeAddress] += parseFloat(row["Reward sd Value".toLowerCase()]);
        } else {
            if (!response[gaugeAddress]) {
                response[gaugeAddress] = 0;
            }

            total += parseFloat(row["Reward sd Value".toLowerCase()])
            response[gaugeAddress] += parseFloat(row["Reward sd Value".toLowerCase()])
        }
    }

    return response;
};



const getTokenPrice = async (space, SPACE_TO_NETWORK, SPACES_UNDERLYING_TOKEN) => {
    try {
        if (space === SDBAL_SPACE) {
            const resp = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=balancer-80-bal-20-weth&vs_currencies=usd');
            return resp.data['balancer-80-bal-20-weth'].usd;
        } else {
            const key = `${SPACE_TO_NETWORK[space]}:${SPACES_UNDERLYING_TOKEN[space]}`;
            const resp = await axios.get(`https://coins.llama.fi/prices/current/${key}`);
            return resp.data.coins[key].price;
        }
    }
    catch (e) {
        console.log("Error getTokenPrice ", space);
        throw e;
    }
}
const checkSpace = (space, SPACES_SYMBOL, SPACES_IMAGE, SPACES_UNDERLYING_TOKEN, SPACES_TOKENS, SPACE_TO_NETWORK, NETWORK_TO_STASH, NETWORK_TO_MERKLE) => {
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



/**
 * For each proposal choice, extract his gauge address with his index
 */
const extractProposalChoices = (proposal) => {
    const addressesPerChoice = {};

    if (proposal.space.id.toLowerCase() === SDPENDLE_SPACE) {
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
        for(const addr of addresses) {
            if(!newAddressesPerChoice[addr]) {
                console.log("Gauge ", addr, "not found");
            }
        }
        //throw new Error("Error when get complete gauge address");
    }

    return newAddressesPerChoice;
};


const getChoicesBasedOnReport = (addressesPerChoice, csvResult) => {
    const gaugeToChoice = {};
    let notFoundIndex = 0;

    for (const gauge in csvResult) {
        const gaugeLower = gauge.toLowerCase();

        let found = false;
        for (const gaugeBis in addressesPerChoice) {
            const gaugeBisLower = gaugeBis.toLowerCase();

            // Check if the full gauge address starts with the truncated gauge address
            if (gaugeLower.startsWith(gaugeBisLower)) {
                const data = {
                    "index": addressesPerChoice[gaugeBis],
                    "amount": csvResult[gauge]
                };
                gaugeToChoice[gaugeLower] = data;  // Use full gauge address as key
                found = true;
                break;
            }
        }
        if (!found) {
            notFoundIndex -= 1;
            const data = {
                "index": notFoundIndex,
                "amount": csvResult[gauge]
            };
            gaugeToChoice[gaugeLower] = data;  // Use full gauge address as key when not found
        }
    }

    return gaugeToChoice;
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
        transport: http("https://lb.drpc.org/ogrpc?network=ethereum&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9"),
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
               continue;
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
 * All endpoints here : https://raw.githubusercontent.com/snapshot-labs/snapshot.js/master/src/delegationSubgraphs.json
 */
function wait(ms) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            resolve(ms)
        }, ms)
    })
}

const getAllDelegators = async (delegationAddress, proposalCreatedTimestamp, space) => {
    // Rate limite subgraph
    await wait(5000)

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
            const parsedScore = {}
            for (const addressScore of Object.keys(score)) {
                parsedScore[addressScore.toLowerCase()] = score[addressScore]
            }

            let newResult = { ...result }
            for (const address of Object.keys(newResult)) {
                if (typeof parsedScore[address.toLowerCase()] !== "undefined") {
                    newResult[address] += parsedScore[address.toLowerCase()]
                    delete parsedScore[address.toLowerCase()]
                }
            }

            result = {
                ...newResult,
                ...parsedScore
            };
        }

        return result;
    }
    catch (e) {
        console.log(e);
        throw e;
    }
}

const getAllAccountClaimed = async (lastMerkle, merkleContract, chain) => {
    const resp = {};

    const wagmiContract = {
        address: merkleContract,
        abi: abi
    };

    let rpcUrl = "";
    switch (chain.id) {
        case mainnet.id:
            rpcUrl = "https://lb.drpc.org/ogrpc?network=ethereum&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9";
            break;
        case bsc.id:
            rpcUrl = "https://lb.drpc.org/ogrpc?network=bsc&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9";
            break;
    }

    const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl)
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
        const result = results.shift();
        if (result.result === true) {
            resp[userAddress.toLowerCase()] = true;
        }
    }

    return resp
}


module.exports = {
    extractCSV,
    getTokenPrice,
    checkSpace,
    extractProposalChoices,
    getChoiceWhereExistsBribe,
    getChoicesBasedOnReport,
    addVotersFromAutoVoter,
    getAllDelegators,
    getDelegationVotingPower,
    getAllAccountClaimed,
};