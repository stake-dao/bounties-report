import axios from "axios";
import { createPublicClient, erc20Abi, formatUnits, http, parseAbi, zeroAddress, getContract, pad } from "viem";
import { mainnet } from 'viem/chains'
import { encodePacked, keccak256, getAddress, decodeEventLog } from 'viem'
import { getClosestBlockTimestamp, MAINNET_VM_PLATFORMS, WARDEN_PATHS, fetchProposalsIdsBasedOnPeriods, getTokenBalance, getGaugeWeight, isValidAddress, getTimestampsBlocks } from './utils/reportUtils';
import dotenv from 'dotenv';
import { SwapEvent } from "./utils/types";
import { fetchHiddenHandClaimedBounties, fetchVotemarketClaimedBounties, fetchWardenClaimedBounties } from "./utils/claimedBountiesUtils";

dotenv.config();

const WETH_ADDRESS = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");

const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || "";
const WEEK = 604800; // One week in seconds
const currentDate = new Date();

const currentTimestamp = Math.floor(currentDate.getTime() / 1000);
const currentPeriod = Math.floor(currentTimestamp / WEEK) * WEEK;


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

const getLogsByAddressTopic2 = async (address: string, topic0: string, fromBlock: number, toBlock: number, topic2?: string) => {
    const apiKey = ETHERSCAN_KEY;
    let url = `https://api.etherscan.io/api?module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=${toBlock}&address=${address}&topic0=${topic0}&apikey=${apiKey}`;

    if (topic2) {
        url += `&topic0_2_opr=and&topic2=${topic2}`;
    }

    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error: any) {
        console.error(`Error fetching logs: ${error.message}`);
    }
}

async function fetchSwapEvents(blockMin: number, blockMax: number, rewardTokens: string[], contractAddress: string) {
    const swapEvents: SwapEvent[] = [];

    const transferSig = "Transfer(address,address,uint256)"
    const transferHash = keccak256(encodePacked(['string'], [transferSig]));


    for (const token of rewardTokens) {
        const response = await getLogsByAddress(
            token,
            transferHash,
            blockMin,
            blockMax
        );

        if (response && response.result && Array.isArray(response.result)) {
            for (const log of response.result) {
                if (log.topics.length === 3) {  // Transfer event has 3 topics
                    const from = '0x' + log.topics[1].slice(26);  // Extract 'from' address
                    const to = '0x' + log.topics[2].slice(26);    // Extract 'to' address
                    const value = BigInt(log.data);               // Amount is in the data field

                    if (from.toLowerCase() === contractAddress.toLowerCase()) {
                        swapEvents.push({
                            blockNumber: parseInt(log.blockNumber, 16),
                            logIndex: parseInt(log.logIndex, 16),
                            token: token,
                            amount: value
                        });
                    }
                }
            }
        } else {
            console.error(`No valid logs found for token ${token}`);
        }
    }

    return swapEvents.sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber - b.blockNumber
    );
}

async function fetchWETHEvents(blockMin: number, blockMax: number, contractAddress: string) {
    const wethEvents: SwapEvent[] = [];

    const transferSig = "Transfer(address,address,uint256)"
    const transferHash = keccak256(encodePacked(['string'], [transferSig]));

    // Pad the contract address to 32 bytes
    const paddedAddress = pad(contractAddress as `0x${string}`, { size: 32 }).toLowerCase();

    const response = await getLogsByAddressTopic2(
        WETH_ADDRESS,
        transferHash,
        blockMin,
        blockMax,
        paddedAddress
    );

    if (response && response.result && Array.isArray(response.result)) {
        for (const log of response.result) {
            const value = BigInt(log.data);

            wethEvents.push({
                blockNumber: parseInt(log.blockNumber, 16),
                logIndex: parseInt(log.logIndex, 16),
                token: WETH_ADDRESS,
                amount: value
            });
        }
    } else {
        console.error('No valid logs found for WETH');
    }

    return wethEvents.sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber - b.blockNumber
    );
}



/**
 * Main function to execute the weekly report generation.
 */
const main = async () => {

    const { timestamp1, timestamp2, blockNumber1, blockNumber2 } = await getTimestampsBlocks(publicClient, 0); // Past week

    // Votemarket
    const votemarketClaimedBounties = await fetchVotemarketClaimedBounties(blockNumber1, blockNumber2);

    // Warden 
    const wardenClaimedBounties = await fetchWardenClaimedBounties(blockNumber1, blockNumber2);


    // Hidden Hand (need an additional computation to estimate bribes because just have the total / reward)
    const hiddenHandClaimedBounties = await fetchHiddenHandClaimedBounties(blockNumber1, blockNumber2);


    /*
    const rewardTokens = ["0x090185f2135308BaD17527004364eBcC2D37e5F6", "0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0"]; // USE from claimed bounties

    // Fetch swaps on the week
    const swapEvents = await fetchSwapEvents(blockNumber1, blockNumber2, rewardTokens, ALL_MIGHT);
    console.log(swapEvents);

    console.log('----');

    // Fetch WETH events on the week
    const wethEvents = await fetchWETHEvents(blockNumber1, blockNumber2, ALL_MIGHT);
    console.log(wethEvents);
    */


}

main()
