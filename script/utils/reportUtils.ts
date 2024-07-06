import axios from 'axios';
import { getAddress } from 'viem';
import { gql, request } from "graphql-request";
import { getContract, formatUnits, PublicClient, Address } from 'viem';
import { erc20Abi } from 'viem';


function isValidAddress(address: string): address is `0x${string}` {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
}


const getClosestBlockTimestamp = async (chain: string, timestamp: number): Promise<number> => {
    const response = await axios.get(`https://coins.llama.fi/block/${chain}/${timestamp}`);

    if (response.status !== 200) {
        console.error(response.data);
        throw new Error("Failed to get closest block timestamp");
    }

    const result = response.data;
    return result.height;
}


const MAINNET_VM_PLATFORMS: { [key: string]: { platform: string, locker: string } } = {
    "curve": { platform: getAddress("0x0000000895cB182E6f983eb4D8b4E0Aa0B31Ae4c"), locker: getAddress("0x52f541764E6e90eeBc5c21Ff570De0e2D63766B6") },
    "balancer": { platform: getAddress("0x0000000446b28e4c90DbF08Ead10F3904EB27606"), locker: getAddress("0xea79d1A83Da6DB43a85942767C389fE0ACf336A5") },
    "frax": { platform: getAddress("0x000000060e56DEfD94110C1a9497579AD7F5b254"), locker: getAddress("0xCd3a267DE09196C48bbB1d9e842D7D7645cE448f") },
    "fxn": { platform: getAddress("0x00000007D987c2Ea2e02B48be44EC8F92B8B06e8"), locker: getAddress("0x75736518075a01034fa72D675D36a47e9B06B2Fb") },
}

const WARDEN_PATHS: { [key: string]: string } = {
    "curve": "crv",
    "balancer": "bal",
    "frax": "frax",
    "fxn": "fxn"
}

const SNAPSHOT_ENDPOINT = "https://hub.snapshot.org/graphql";

interface Proposal {
    id: string;
    title: string;
    body: string;
    choices: string[];
    start: number;
    end: number;
    snapshot: string;
    state: string;
    scores: string[];
    scores_by_strategy: string[];
    scores_total: number;
    scores_updated: number;
    author: string;
    space: {
        id: string;
        name: string;
    };
}

interface Timestamps {
    [key: number]: Proposal;
}

const fetchProposalsIdsBasedOnPeriods = async (space: string, period: number): Promise<Timestamps> => {
    const query = gql`
    query Proposals {
      proposals(
        first: 1000
        skip: 0
        orderBy: "created",
        orderDirection: desc,
        where: {
          space_in: ["${space}"]
          type: "weighted"
        }
      ) {
        id
        title
        body
        choices
        start
        end
        snapshot
        state
        scores
        scores_by_strategy
        scores_total
        scores_updated
        author
        space {
          id
          name
        }
      }
    }`;
    const result = await request(SNAPSHOT_ENDPOINT, query);
    const proposals = result.proposals.filter((proposal: Proposal) => proposal.title.indexOf("Gauge vote") > -1);

    let associated_timestamps: Timestamps = {};

    for (const proposal of proposals) {
        const title = proposal.title;
        const dateStrings = title.match(/\d{1,2}\/\d{1,2}\/\d{4}/g);

        if (dateStrings && dateStrings.length >= 2) {
            const [date_a, date_b] = dateStrings;

            const parts_a = date_a.split('/');
            const parts_b = date_b.split('/');

            // Convert dd/mm/yyyy to mm/dd/yyyy by swapping the first two elements
            const correctFormat_a = `${parts_a[1]}/${parts_a[0]}/${parts_a[2]}`;
            const correctFormat_b = `${parts_b[1]}/${parts_b[0]}/${parts_b[2]}`;

            const timestamp_a = new Date(correctFormat_a).getTime() / 1000;
            const timestamp_b = new Date(correctFormat_b).getTime() / 1000;

            // Associate if the period is between a and b
            if (period >= timestamp_a && period <= timestamp_b) {
                associated_timestamps[period] = proposal;
            }
        }
    }
    return associated_timestamps;
}

async function getTokenBalance(
    publicClient: PublicClient,
    tokenAddress: Address,
    contractAddress: Address,
    decimals: number = 18
): Promise<number> {
    const balance = await publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [contractAddress],
    });

    return Number(formatUnits(balance, decimals));
}

// Define the ABI for the gauge controller contract
const gaugeControllerAbi = [
    {
        name: 'get_gauge_weight',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'gauge', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
    },
] as const;

async function getGaugeWeight(
    publicClient: PublicClient,
    gaugeControllerAddress: Address,
    gaugeAddress: Address
): Promise<number> {
    try {
        const weight = await publicClient.readContract({
            address: gaugeControllerAddress,
            abi: gaugeControllerAbi,
            functionName: 'get_gauge_weight',
            args: [gaugeAddress],
        });

        // weight is returned in 1e18 scale
        return Number(formatUnits(weight, 18));
    } catch (error) {
        console.error(`Error fetching gauge weight for ${gaugeAddress}:`, error);
        return 0;
    }
}




export { getClosestBlockTimestamp, MAINNET_VM_PLATFORMS, WARDEN_PATHS, fetchProposalsIdsBasedOnPeriods, getTokenBalance, getGaugeWeight, isValidAddress };