import axios from "axios";
import { createPublicClient, erc20Abi, formatUnits, http, parseAbi, zeroAddress, getContract } from "viem";
import { mainnet } from 'viem/chains'
import { encodePacked, keccak256, getAddress, decodeEventLog } from 'viem'
import { getClosestBlockTimestamp, MAINNET_VM_PLATFORMS, WARDEN_PATHS, fetchProposalsIdsBasedOnPeriods } from './utils/reportUtils';
import dotenv from 'dotenv';

dotenv.config();

const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || "";
const WEEK = 604800; // One week in seconds
const currentDate = new Date();
const currentTimestamp = Math.floor(currentDate.getTime() / 1000);
const currentPeriod = Math.floor(currentTimestamp / WEEK) * WEEK;


interface Bounty {
    rewardToken: string,
    amount: BigInt
}

interface VotemarketBounty extends Bounty {
    bountyId: BigInt,
}

interface WardenBounty extends Bounty {
    questID: BigInt,
    period: BigInt
}

interface HiddenHandBounty extends Bounty {
    identifier: string,
}

const publicClient = createPublicClient({
    chain: mainnet,
    transport: http("https://rpc.flashbots.net")
});

const BOTMARKET = getAddress("0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF");
const HH_BALANCER_MARKET = getAddress("0x45Bc37b18E73A42A4a826357a8348cDC042cCBBc");

/**
 * Fetches logs by address and topic from Etherscan API.
 * @param {string} address - The contract address to query logs from.
 * @param {string} topic0 - The topic hash to filter logs.
 * @param {number} fromBlock - The starting block number to fetch logs.
 * @param {number} toBlock - The ending block number to fetch logs.
 * @returns {Promise<any>} The API response containing the logs.
 */
const getLogsByAddress = async (address: string, topic0: string, fromBlock: number, toBlock: number) => {
    const apiKey = ETHERSCAN_KEY;
    const url = `https://api.etherscan.io/api?module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=${toBlock}&address=${address}&topic0=${topic0}&apikey=${apiKey}`;

    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error: any) {
        console.error(`Error fetching logs: ${error.message}`);
    }

}


/**
 * Fetches claimed bounties from the Votemarket platform within a specified block range.
 * @param {number} block_min - The minimum block number to fetch from.
 * @param {number} block_max - The maximum block number to fetch to.
 * @returns {Promise<{[protocol: string]: VotemarketBounty[]}>} A mapping of protocol names to their respective claimed bounties.
 */
const fetchVotemarketClaimedBounties = async (block_min: number, block_max: number) => {
    const eventSignature = "Claimed(address,address,uint256,uint256,uint256,uint256)"
    const claimedEventHash = keccak256(encodePacked(['string'], [eventSignature]));

    let filtereredLogs: { [protocol: string]: VotemarketBounty[] } = {}

    const claimedAbi = parseAbi(['event Claimed(address indexed user, address rewardToken, uint256 indexed bountyId, uint256 amount, uint256 protocolFees, uint256 period)']);
    const promises = Object.keys(MAINNET_VM_PLATFORMS).map(async (protocol) => {

        const response = await getLogsByAddress(MAINNET_VM_PLATFORMS[protocol].platform, claimedEventHash, block_min, block_max);

        if (!response || !response.result || response.result.length === 0) {
            throw new Error("No logs found");
        }

        for (const log of response.result) {
            const decodedLog = decodeEventLog({
                abi: claimedAbi,
                data: log.data,
                topics: log.topics,
                strict: true
            });

            if (getAddress(decodedLog.args.user) == MAINNET_VM_PLATFORMS[protocol].locker) {
                const votemarketBounty: VotemarketBounty = {
                    bountyId: decodedLog.args.bountyId,
                    amount: decodedLog.args.amount,
                    rewardToken: getAddress(decodedLog.args.rewardToken)
                }
                if (!filtereredLogs[protocol]) {
                    filtereredLogs[protocol] = [];
                }
                filtereredLogs[protocol].push(votemarketBounty);
            }
        }
    });

    await Promise.all(promises);

    return filtereredLogs;
}



/**
 * Fetches claimed bounties from Warden by querying the blockchain and filtering based on API data.
 * @param {number} block_min - The minimum block number for the query range.
 * @param {number} block_max - The maximum block number for the query range.
 * @returns {Promise<{[protocol: string]: WardenBounty[]}>} A mapping of protocol names to their respective claimed bounties.
 */
const fetchWardenClaimedBounties = async (block_min: number, block_max: number) => {
    // Fetch all bounties data from Warden API
    const wardenApiBase = "https://api.paladin.vote/quest/v2/copilot/claims/"
    let distributorAddresses: string[] = [];

    let questsByProtocol: { [path: string]: { questId: BigInt, period: BigInt }[] } = {};

    const botMarketApi = wardenApiBase + BOTMARKET;
    const apiResponse = await axios.get(botMarketApi);

    // Process each to compare with what we claimed
    for (const claim of apiResponse.data.claims) {
        if (claim.amount <= 0) continue;

        const distributorAddress = getAddress(claim.distributor);
        if (!distributorAddresses.includes(distributorAddress)) {
            distributorAddresses.push(distributorAddress);
        }

        if (!questsByProtocol[claim.path]) {
            questsByProtocol[claim.path] = [];
        }
        const questInfo = {
            questId: BigInt(claim.questId),
            period: BigInt(claim.period),
        }
        questsByProtocol[claim.path].push(questInfo);
    }

    // Fetch weekly claimed bounties
    const eventSignature = "Claimed(uint256,uint256,uint256,uint256,address,address)";
    const claimedEventHash = keccak256(encodePacked(['string'], [eventSignature]));

    let allClaimedBounties: WardenBounty[] = [];

    const claimedEventAbi = parseAbi(['event Claimed(uint256 indexed questID,uint256 indexed period,uint256 index,uint256 amount,address rewardToken,address indexed account)']);
    const logPromises = distributorAddresses.map((distributor, index) => {
        return new Promise(async (resolve) => {
            // manage rate limits
            setTimeout(async () => {
                const logsResponse = await getLogsByAddress(distributor, claimedEventHash, block_min, block_max);

                if (!logsResponse || !logsResponse.result || logsResponse.result.length === 0) {
                    resolve(null);
                    return;
                }

                for (const log of logsResponse.result) {
                    const decodedLog = decodeEventLog({
                        abi: claimedEventAbi,
                        data: log.data,
                        topics: log.topics,
                        strict: false
                    });

                    if (decodedLog.args.account && getAddress(decodedLog.args.account) != BOTMARKET) {
                        continue;
                    }
                    const wardenBounty: WardenBounty = {
                        amount: decodedLog.args.amount as BigInt,
                        rewardToken: getAddress(decodedLog.args.rewardToken as string),
                        questID: decodedLog.args.questID as BigInt,
                        period: decodedLog.args.period as BigInt
                    }
                    allClaimedBounties.push(wardenBounty);
                }

                resolve(null);
            }, 1000 * index);
        });
    });
    await Promise.all(logPromises);

    // Filter and organize the bounties by protocol
    let protocolBounties: { [protocol: string]: WardenBounty[] } = {}

    allClaimedBounties.forEach((bounty) => {
        for (const protocol in questsByProtocol) {
            const quests = questsByProtocol[protocol];
            if (quests.some((quest) => quest.questId === bounty.questID && quest.period === bounty.period)) {
                if (!protocolBounties[protocol]) {
                    protocolBounties[protocol] = [];
                }
                protocolBounties[protocol].push(bounty);
            }
        }
    })

    return protocolBounties;
}

/**
 * Fetches claimed bounties from the Hidden Hand platform.
 * @returns {Promise<{[protocol: string]: HiddenHandBounty[]}>} A mapping of protocol names to their respective claimed bounties.
 */
const fetchHiddenHandClaimedBounties = async (block_min: number, block_max: number) => {
    const rewardClaimedSig = "RewardClaimed(bytes32,address,address,uint256)"
    const rewardClaimedHash = keccak256(encodePacked(['string'], [rewardClaimedSig]));

    let allClaimedBounties: HiddenHandBounty[] = []

    const claimedAbi = parseAbi(['event RewardClaimed(bytes32 indexed identifier,address indexed token,address indexed account,uint256 amount)']);

    const claimedResponse = await getLogsByAddress(getAddress("0xa9b08B4CeEC1EF29EdEC7F9C94583270337D6416"), rewardClaimedHash, block_min, block_max);

    if (!claimedResponse || !claimedResponse.result || claimedResponse.result.length === 0) {
        throw new Error("No logs found");
    }

    for (const log of claimedResponse.result) {
        const decodedLog = decodeEventLog({
            abi: claimedAbi,
            data: log.data,
            topics: log.topics,
            strict: true
        });

        if (getAddress(decodedLog.args.account) == BOTMARKET) {
            const hiddenHandBounty: HiddenHandBounty = {
                identifier: decodedLog.args.identifier,
                amount: decodedLog.args.amount,
                rewardToken: getAddress(decodedLog.args.token)
            }
            allClaimedBounties.push(hiddenHandBounty);
        }
    }

    // Get all bribes that has been deposited on Hidden Hand since inception
    const depositBribeSig = "DepositBribe(address,bytes32,uint256,address,address,uint256,uint256,uint256,uint256)"
    const depositBribeHash = keccak256(encodePacked(['string'], [depositBribeSig]));

    let allDepositedBribes: any[] = []

    const depositBribeAbi = parseAbi(['event DepositBribe(address indexed market,bytes32 indexed proposal,uint256 indexed deadline,address token,address briber,uint256 amount,uint256 totalAmount,uint256 maxTokensPerVote,uint256 periodIndex)']);

    // Long range, batch blocks 500 000 per 500 000 from 17621913 to block_min
    const chunk = 500000;
    const startBlock = 17621913;
    const endBlock = block_min;
    const numChunks = Math.ceil((endBlock - startBlock) / chunk);

    for (let i = 0; i < numChunks; i++) {
        const block_min = startBlock + i * chunk;
        const block_max = Math.min(block_min + chunk, endBlock);
        const depositedBribeResponse = await getLogsByAddress(getAddress("0xE00fe722e5bE7ad45b1A16066E431E47Df476CeC"), depositBribeHash, block_min, block_max);

        if (!depositedBribeResponse || !depositedBribeResponse.result || depositedBribeResponse.result.length === 0) {
            continue
        }


        for (const log of depositedBribeResponse.result) {
            const decodedLog = decodeEventLog({
                abi: depositBribeAbi,
                data: log.data,
                topics: log.topics,
                strict: true
            });

            // Filter out old ones
            if (Number(decodedLog.args.deadline) < currentPeriod || getAddress(decodedLog.args.market) != HH_BALANCER_MARKET) {
                continue;
            }

            // End of  Selection
            allDepositedBribes.push(decodedLog);
        }
    }
    

    // Match all deposited bribes with Hidden API to get the correct gauge (proposal)
    const hiddenHandApiUrl = "https://api.hiddenhand.finance/proposal/balancer";
    let hiddenHandProposals: any[] = [];
    try {
        const response = await axios.get(hiddenHandApiUrl);
        hiddenHandProposals = response.data.data;
    } catch (error) {
        console.error("Failed to fetch proposals from Hidden Hand:", error);
    }

    allDepositedBribes.map((bribe) => {
        for (const proposal of hiddenHandProposals) {
            if (proposal.proposalHash.toLowerCase() === bribe.args.proposal.toLowerCase()) {
                bribe.title = proposal.title;
                bribe.gauge = proposal.proposal;
            }
        }
    })

    /**
     *  'bb-WETH-wstETH - 0xf8c85bd74fee268…ba': { voted: 5028.899934070942, share: 0.04446803491326094 },
        'B-baoUSD-LUSD-BPT - 0x5af3b93fb82ab86…11': { voted: 13590.850083561125, share: 0.12017705739622019 },
        '80D2D-20USDC - 0x1249c510e066731…9e': { voted: 8523.559210289735, share: 0.0753695507004423 },
        '50WETH-50AURA - 0x275df57d2b23d53…00': { voted: 17217.589604785262, share: 0.1522464924148934 },
        'RDNT-WETH - 0x8135d6abfd42707…ad': { voted: 6136.962631408609, share: 0.05426607650431845 },
        'B-sdBAL-STABLE - 0xdc2df969ee5e662…f2': { voted: 5250.622565485046, share: 0.04642861671923079 },
        'B-auraBAL-STABLE - 0x0312aa8d0ba4a19…42': { voted: 17217.589604785262, share: 0.1522464924148934 },
        'D2D-rETH - 0x2d02bf5ea195dc0…63': { voted: 22161.25394675331, share: 0.19596083182114996 },
        'wstETH-WETH-BPT - 0x5c0f23a5c1be65f…1c': { voted: 5455.07789458543, share: 0.048236512448283066 },
        'B-baoETH-ETH-BPT - 0xd449efa0a587f2c…10': { voted: 1435.394019349455, share: 0.012692467975803848 },
        'svETH/wstETH - 0xd98ed0426d18b11…f8': { voted: 3494.65927621879, share: 0.03090151578718133 },
        'sDOLA-DOLA BSP - 0xcd19892916929f0…0e': { voted: 7577.763089877254, share: 0.0670063509043225 }
     */


    // Fetch proposals for Balancer bribes on snapshot (take the one with my week in the period)
    const proposals = await fetchProposalsIdsBasedOnPeriods("sdbal.eth", currentPeriod);

    // Current period -> Proposal
    const proposal = proposals[currentPeriod];

    if (!proposal) return {};


    const scoresTotal = proposal.scores_total;
    const choices = proposal.choices;
    const scores = proposal.scores;


    // Compute the voting shares per gauge on that snapshot
    const gaugeShares = scores.reduce<{ [key: string]: { voted: number; share: number } }>((acc, score, index) => {
        if (typeof score === 'number' && score !== 0) {
            acc[choices[index]] = {
                voted: score,
                share: score / scoresTotal
            };
        }
        return acc;
    }, {});


    // Drop those who are not bribed from allDepositedBribes
    for (let i = allDepositedBribes.length - 1; i >= 0; i--) {
        const bribe = allDepositedBribes[i];
        let found = false;

        for (const gauge in gaugeShares) {
            if (bribe.gauge) {
                const match = gauge.match(/0x[a-fA-F0-9]+/); // Match hexadecimal characters that start with '0x'

                if (!match) continue;

                const bribeAddress = bribe.gauge.toLowerCase(); // Prepare bribe gauge address for comparison

                if (bribeAddress.startsWith(match[0].toLowerCase())) {
                    console.log("Match found:", bribe.gauge, "matches with", match[0]);
                    found = true;
                    break;
                }
            }
        }

        if (!found) {
            allDepositedBribes.splice(i, 1); // Remove from array if no match found
        }
    }

    console.log(allDepositedBribes);


    return;

    // Getting the total sdBAL VP on each gauge 

};





/**
 * Main function to execute the weekly report generation.
 */
const main = async () => {
    const blockCurrentPeriod = await getClosestBlockTimestamp("ethereum", currentPeriod);
    const blockCurrentTimestamp = Number(await publicClient.getBlockNumber())


    // Votemarket
    //const votemarketClaimedBounties = await fetchVotemarketClaimedBounties(blockCurrentPeriod, blockCurrentTimestamp);
    //console.log(votemarketClaimedBounties);

    // Warden 
    //const wardenClaimedBounties = await fetchWardenClaimedBounties(blockCurrentPeriod, blockCurrentTimestamp);

    // Hidden Hand (need an additional computation to estimate bribes because just have the total / reward)
    const hiddenHandClaimedBounties = await fetchHiddenHandClaimedBounties(blockCurrentPeriod, blockCurrentTimestamp);
}

main()
