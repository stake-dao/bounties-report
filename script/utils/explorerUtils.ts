import axios from "axios";
import dotenv from "dotenv";

// Load the .env file from the project root
dotenv.config();

const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || "";
const BSCSCAN_KEY = process.env.BSCSCAN_API_KEY || "";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class RateLimiter {
  private readonly queue: (() => Promise<void>)[] = [];
  private running = 0;

  constructor(private readonly maxConcurrent: number) {}

  async add<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.maxConcurrent) {
      await new Promise((resolve) =>
        this.queue.push(resolve as () => Promise<void>)
      );
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

export type NetworkType = "ethereum" | "bsc";

class BlockchainExplorerUtils {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(network: NetworkType) {
    if (network === "ethereum") {
      this.baseUrl = "https://api.etherscan.io/api";
      this.apiKey = ETHERSCAN_KEY;
    } else if (network === "bsc") {
      this.baseUrl = "https://api.bscscan.com/api";
      this.apiKey = BSCSCAN_KEY;
    } else {
      throw new Error("Unsupported network type");
    }
  }

  createBlockchainExplorerUtils = (
    network: NetworkType
  ): BlockchainExplorerUtils => {
    return new BlockchainExplorerUtils(network);
  };

  /**
   * Fetches logs by address and topics from the blockchain explorer API.
   * @param {string} address - The contract address to query logs from.
   * @param {number} fromBlock - The starting block number to fetch logs.
   * @param {number} toBlock - The ending block number to fetch logs.
   * @param {Object} topics - An object containing topic filters.
   * @returns {Promise<any>} The API response containing the logs.
   */
  async getLogsByAddressAndTopics(
    address: string,
    fromBlock: number,
    toBlock: number,
    topics: { [key: string]: string }
  ) {
    let url = `${this.baseUrl}?module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=${toBlock}&address=${address}&apikey=${this.apiKey}`;

    // Add topics to the URL
    Object.entries(topics).forEach(([key, value]) => {
      url += `&topic${key}_${parseInt(key) + 1}_opr=and&topic${key}=${value}`;
    });
    const maxRetries = 5;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        const response = await rateLimiter.add(() => axios.get(url));

        if (response.data.status === "1") {
          return response.data;
        } else if (
          response.data.status === "0" &&
          response.data.message === "No records found"
        ) {
          console.warn(
            `No records found for address ${address} from block ${fromBlock} to ${toBlock}`
          );
          return { result: [] };
        } else if (
          response.data.message === "NOTOK" &&
          (response.data.result === "Max rate limit reached" ||
            response.data.result ===
              "Max calls per sec rate limit reached (5/sec)")
        ) {
          console.warn("Rate limit reached, retrying after delay...");
          await delay(1000); // Wait for 1 second before retrying
          retries++;
        } else {
          console.log(url);
          console.error("Unexpected response:", response.data);
          throw new Error(response.data.message || "Unknown error");
        }
      } catch (error: any) {
        if (error.response && error.response.status === 429) {
          console.warn("Rate limit reached, retrying after delay...");
          await delay(1000); // Wait for 1 second before retrying
          retries++;
        } else {
          console.error(url);
          console.error(`Error fetching logs: ${error.message}`);
          throw error;
        }
      }
    }

    throw new Error("Max retries reached");
  }

  /**
   * Fetches logs by multiple addresses and topics from the blockchain explorer API.
   * @param {string[]} addresses - The contract addresses to query logs from.
   * @param {number} fromBlock - The starting block number to fetch logs.
   * @param {number} toBlock - The ending block number to fetch logs.
   * @param {Object} topics - An object containing topic filters.
   * @returns {Promise<any>} The API response containing the logs.
   */
  async getLogsByAddressesAndTopics(
    addresses: string[],
    fromBlock: number,
    toBlock: number,
    topics: { [key: string]: string }
  ) {
    let allResults: any[] = [];

    for (const address of addresses) {
      let url = `${this.baseUrl}?module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=${toBlock}&address=${address}&apikey=${this.apiKey}`;

      // Add topics to the URL
      Object.entries(topics).forEach(([key, value]) => {
        url += `&topic${key}_${parseInt(key) + 1}_opr=and&topic${key}=${value}`;
      });

      const maxRetries = 5;
      let retries = 0;

      while (retries < maxRetries) {
        try {
          const response = await rateLimiter.add(() => axios.get(url));

          if (response.data.status === "1") {
            allResults = allResults.concat(response.data.result);
            break;
          } else if (
            response.data.status === "0" &&
            response.data.message === "No records found"
          ) {
            console.warn(
              `No records found for address ${address} from block ${fromBlock} to ${toBlock}`
            );
            break;
          } else if (
            response.data.message === "NOTOK" &&
            (response.data.result === "Max rate limit reached" ||
              response.data.result ===
                "Max calls per sec rate limit reached (5/sec)")
          ) {
            console.warn("Rate limit reached, retrying after delay...");
            await delay(1000); // Wait for 1 second before retrying
            retries++;
          } else {
            console.warn(url);
            console.error("Unexpected response:", response.data);
            throw new Error(response.data.message || "Unknown error");
          }
        } catch (error: any) {
          if (error.response && error.response.status === 429) {
            console.warn("Rate limit reached, retrying after delay...");
            await delay(1000); // Wait for 1 second before retrying
            retries++;
          } else {
            console.warn(url);
            console.error(`Error fetching logs: ${error.message}`);
            throw error;
          }
        }
      }

      if (retries === maxRetries) {
        throw new Error("Max retries reached");
      }
    }

    return { result: allResults };
  }

  /**
   * Fetches the block number closest to a given timestamp.
   * @param {number} timestamp - The Unix timestamp to query.
   * @param {'before' | 'after'} closest - Whether to get the closest block before or after the timestamp.
   * @returns {Promise<number>} The block number.
   */
  async getBlockNumberByTimestamp(
    timestamp: number,
    closest: 'before' | 'after' = 'before'
  ): Promise<number> {
    const url = `${this.baseUrl}?module=block&action=getblocknobytime&timestamp=${timestamp}&closest=${closest}&apikey=${this.apiKey}`;

    const maxRetries = 5;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        const response = await rateLimiter.add(() => axios.get(url));

        if (response.data.status === "1") {
          return parseInt(response.data.result);
        } else if (response.data.message === "NOTOK" && 
                  (response.data.result === "Max rate limit reached" ||
                   response.data.result === "Max calls per sec rate limit reached (5/sec)")) {
          console.warn("Rate limit reached, retrying after delay...");
          await delay(1000); // Wait for 1 second before retrying
          retries++;
        } else {
          console.log(url);
          console.error("Unexpected response:", response.data);
          throw new Error(response.data.message || "Unknown error");
        }
      } catch (error: any) {
        if (error.response && error.response.status === 429) {
          console.warn("Rate limit reached, retrying after delay...");
          await delay(1000); // Wait for 1 second before retrying
          retries++;
        } else {
          console.log(url);
          console.error(`Error fetching block number: ${error.message}`);
          throw error;
        }
      }
    }

    throw new Error("Max retries reached");
  }
}

export const createBlockchainExplorerUtils = (network: NetworkType) =>
  new BlockchainExplorerUtils(network);
