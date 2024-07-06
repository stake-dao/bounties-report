import axios from "axios";
import { createPublicClient, erc20Abi, formatUnits, http, parseAbi, zeroAddress, getContract } from "viem";
import { mainnet } from 'viem/chains'
import { encodePacked, keccak256, getAddress, decodeEventLog } from 'viem'
import { getClosestBlockTimestamp, MAINNET_VM_PLATFORMS, WARDEN_PATHS, fetchProposalsIdsBasedOnPeriods, getTokenBalance, getGaugeWeight, isValidAddress } from './utils/reportUtils';
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

interface GaugeShare {
    voted: number;
    share: number;
    gaugeAddress?: string;
    stakeVote?: number;
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
            allDepositedBribes.push(decodedLog.args);

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
            if (proposal.proposalHash.toLowerCase() === bribe.proposal.toLowerCase()) {
                bribe.title = proposal.title;
                bribe.gauge = proposal.proposal;
            }
        }
    })

    // Fetch proposals for Balancer bribes on snapshot (take the one with my week in the period)
    const proposals = await fetchProposalsIdsBasedOnPeriods("sdbal.eth", currentPeriod);

    // Current period -> Proposal
    const proposal = proposals[currentPeriod];

    if (!proposal) return {};


    const scoresTotal = proposal.scores_total;
    const choices = proposal.choices;
    const scores = proposal.scores;


    // Compute the voting shares per gauge on that snapshot
    const gaugeShares = scores.reduce<{ [key: string]: GaugeShare }>((acc, score, index) => {
        if (typeof score === 'number' && score !== 0) {
            acc[choices[index]] = {
                voted: score,
                share: score / scoresTotal
            };
        }
        return acc;
    }, {});


    // Get Stake DAO delegation veBal balance
    const totalVebal = await getTokenBalance(publicClient, "0xC128a9954e6c874eA3d62ce62B468bA073093F25", "0xea79d1A83Da6DB43a85942767C389fE0ACf336A5", 18);

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
                    gaugeShares[gauge].gaugeAddress = bribeAddress;

                    // Compute stakeVotes
                    gaugeShares[gauge].stakeVote = gaugeShares[gauge].share * totalVebal;
                    found = true;
                    break;
                }
            }
        }

        if (!found) {
            allDepositedBribes.splice(i, 1); // Remove from array if no match found
        }
    }

    const totalEstimatedToken: { [token: string]: number } = {};

    // First, preprocess gaugeShares for faster lookup
    const gaugeSharesMap = new Map();
    for (const [key, data] of Object.entries(gaugeShares)) {
        if (data.gaugeAddress && isValidAddress(data.gaugeAddress)) {
            gaugeSharesMap.set(data.gaugeAddress.toLowerCase(), { key, ...data });
        }
    }


    // Now process allDepositedBribes
    for (const bribe of allDepositedBribes) {
        const gaugeData = gaugeSharesMap.get(bribe.gauge.toLowerCase());

        if (gaugeData) {
            if (!gaugeData.gaugeWeight) {
                gaugeData.gaugeWeight = await getGaugeWeight(
                    publicClient,
                    "0xC128468b7Ce63eA702C1f104D55A2566b13D3ABD" as `0x${string}`,
                    gaugeData.gaugeAddress as `0x${string}`
                );
            }

            bribe.gaugeWeight = gaugeData.gaugeWeight;

            if (gaugeData.voted !== undefined && gaugeData.gaugeWeight !== undefined) {
                bribe.stakeVote = gaugeData.voted;
                bribe.stakeShares = bribe.stakeVote / bribe.gaugeWeight;
                bribe.estimatedAmount = Number(bribe.stakeShares) * Number(bribe.totalAmount);

                totalEstimatedToken[bribe.token] = (totalEstimatedToken[bribe.token] || 0) + bribe.estimatedAmount;
            }
        }
    }

    // Compute real 
    for (const bribe of allDepositedBribes) {
        // Get total claimed for that token 
        const totalClaimed = allClaimedBounties.filter((bounty) => bounty.rewardToken.toLowerCase() === bribe.token.toLowerCase()).reduce((acc, bounty) => acc + Number(bounty.amount), 0);

        const shareOfTotal = bribe.estimatedAmount / totalEstimatedToken[bribe.token];

        // Compute the real amount
        bribe.realAmount = totalClaimed * shareOfTotal;
    }


    let protocolBounties: { [protocol: string]: HiddenHandBounty[] } = {}

    protocolBounties["balancer"] = [];

    for (const bribe of allDepositedBribes) {
        const hiddenHandBounty: HiddenHandBounty = {
            identifier: bribe.proposal,
            amount: bribe.realAmount,
            rewardToken: bribe.token,
        };

        protocolBounties["balancer"].push(hiddenHandBounty);
    }

    return protocolBounties;
}

/**
 * Retrieves timestamps and block numbers for a specified week.
 * @param {number | undefined} pastWeek - Number of weeks in the past (0 for current week).
 * @returns {Promise<{timestamp1: number, timestamp2: number, timestampEnd: number, blockNumber1: number, blockNumber2: number, blockNumberEnd: number}>}
 */
async function getTimestampsBlocks(pastWeek?: number) {
    const currentTimestamp = Math.floor(Date.now() / 1000);
    let timestamp2: number;
    let timestamp1: number;

    if (pastWeek === undefined || pastWeek === 0) {
        console.log("No past week specified, using current week");
        timestamp2 = currentTimestamp;
        timestamp1 = Math.floor(currentTimestamp / WEEK) * WEEK; // Rounded down to the start of the current week
    } else {
        console.log(`Past week specified: ${pastWeek}`);

        timestamp2 = Math.floor(currentTimestamp / WEEK) * WEEK;
        timestamp1 = timestamp2 - pastWeek * WEEK;
    }

    const blockNumber1 = await getClosestBlockTimestamp("ethereum", timestamp1);
    const blockNumber2 = pastWeek === undefined || pastWeek === 0
        ? Number(await publicClient.getBlockNumber())
        : await getClosestBlockTimestamp("ethereum", timestamp2);

    return {
        timestamp1,
        timestamp2,
        blockNumber1,
        blockNumber2,
    };
}



/**
 * Main function to execute the weekly report generation.
 */
const main = async () => {

    const { timestamp1, timestamp2, blockNumber1, blockNumber2 } = await getTimestampsBlocks(1); // Past week


    // Votemarket
    const votemarketClaimedBounties = await fetchVotemarketClaimedBounties(blockNumber1, blockNumber2);
    console.log('votemarket');
    console.log(votemarketClaimedBounties);

    // Warden 
    console.log('warden')
    const wardenClaimedBounties = await fetchWardenClaimedBounties(blockNumber1, blockNumber2);
    console.log(wardenClaimedBounties);


    // Hidden Hand (need an additional computation to estimate bribes because just have the total / reward)
    console.log('hidden hand')
    const hiddenHandClaimedBounties = await fetchHiddenHandClaimedBounties(blockNumber1, blockNumber2);
    console.log(hiddenHandClaimedBounties);


}

main()
