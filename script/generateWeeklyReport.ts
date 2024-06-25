import axios from "axios";
import { createPublicClient, erc20Abi, formatUnits, http, parseAbi, zeroAddress, getContract } from "viem";
import { mainnet } from 'viem/chains'
import { encodePacked, keccak256, getAddress, decodeEventLog } from 'viem'
import { getClosestBlockTimestamp, MAINNET_VM_PLATFORMS, WARDEN_PATHS } from './utils/reportUtils';
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

const publicClient = createPublicClient({
    chain: mainnet,
    transport: http("https://rpc.flashbots.net")
});

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

    let questsByProtocol: { [path: string]: {questId: BigInt, period: BigInt}[] } = {};

    const botMarketAddress = "0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF";
    const botMarketApi = wardenApiBase + getAddress(botMarketAddress);
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

                    if (decodedLog.args.account && getAddress(decodedLog.args.account) != botMarketAddress) {
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
const fetchHiddenHandClaimedBounties = async () => {

}

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

}

main()
