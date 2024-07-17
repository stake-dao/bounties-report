import axios from "axios";
import dotenv from 'dotenv';


dotenv.config();


const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || "";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class RateLimiter {
    private queue: (() => Promise<void>)[] = [];
    private running = 0;

    constructor(private maxConcurrent: number) { }

    async add<T>(fn: () => Promise<T>): Promise<T> {
        while (this.running >= this.maxConcurrent) {
            await new Promise(resolve => this.queue.push(resolve as () => Promise<void>));
        }
        this.running++;
        try {
            return await fn();
        } finally {
            this.running--;
            if (this.queue.length > 0) {
                const next = this.queue.shift();
                if (next) next();
            }
        }
    }
}

const rateLimiter = new RateLimiter(5);


/**
 * Fetches logs by address and topics from Etherscan API.
 * @param {string} address - The contract address to query logs from.
 * @param {number} fromBlock - The starting block number to fetch logs.
 * @param {number} toBlock - The ending block number to fetch logs.
 * @param {Object} topics - An object containing topic filters.
 * @returns {Promise<any>} The API response containing the logs.
 */
export const getLogsByAddressAndTopics = async (
    address: string,
    fromBlock: number,
    toBlock: number,
    topics: { [key: string]: string }
) => {
    console.log(`Fetching logs on Etherscan for address ${address}`);

    let url = `https://api.etherscan.io/api?module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=${toBlock}&address=${address}&apikey=${ETHERSCAN_KEY}`;

    // Add topics to the URL
    Object.entries(topics).forEach(([key, value]) => {
        url += `&topic${key}_${parseInt(key) + 1}_opr=and&topic${key}=${value}`;
    });

    const maxRetries = 5;
    let retries = 0;

    while (retries < maxRetries) {
        try {
            const response = await rateLimiter.add(() => axios.get(url));

            if (response.data.status === '1') {
                return response.data;
            } else if (response.data.status === '0' && response.data.message === 'No records found') {
                console.log(`No records found for address ${address} from block ${fromBlock} to ${toBlock}`);
                return { result: [] };
            } else if (response.data.message === 'NOTOK' && response.data.result === 'Max rate limit reached') {
                console.log('Rate limit reached, retrying after delay...');
                await delay(1000); // Wait for 1 second before retrying
                retries++;
            } else {
                console.log(url);
                console.error('Unexpected response:', response.data);
                throw new Error(response.data.message || 'Unknown error');
            }
        } catch (error: any) {
            if (error.response && error.response.status === 429) {
                console.log('Rate limit reached, retrying after delay...');
                await delay(1000); // Wait for 1 second before retrying
                retries++;
            } else {
                console.log(url);
                console.error(`Error fetching logs: ${error.message}`);
                throw error;
            }
        }
    }

    throw new Error('Max retries reached');
};