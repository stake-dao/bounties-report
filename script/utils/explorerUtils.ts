import axios from "axios";
import dotenv from "dotenv";

// Load the .env file from the project root
dotenv.config();

const EXPLORER_KEY =
  process.env.EXPLORER_KEY || process.env.ETHERSCAN_API_KEY || "";

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

class BlockchainExplorerUtils {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    this.baseUrl = "https://api.etherscan.io/v2/api";
    this.apiKey = EXPLORER_KEY;
  }

  createBlockchainExplorerUtils = (): BlockchainExplorerUtils => {
    return new BlockchainExplorerUtils();
  };

  private async makeRequest(url: string, retries = 5, delayMs = 10000) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 900000);

        const response = await rateLimiter.add(() => 
          fetch(url, { 
            signal: controller.signal 
          })
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (data.status === "1") {
          return data;
        } else if (data.status === "0" && data.message === "No records found") {
          return { result: [] };
        }

        if (attempt < retries - 1) {
          console.warn(
            `ExplorerUtils error (attempt ${attempt + 1}/${retries}):`,
            data.message
          );
          await delay(delayMs);
          continue;
        }
        return { result: [] };
      } catch (error: any) {
        if (error.name === 'AbortError') {
          console.warn(`Request timed out (attempt ${attempt + 1}/${retries})`);
        } else {
          console.warn(
            `Request failed (attempt ${attempt + 1}/${retries}):`,
            error
          );
        }
        
        await delay(delayMs * Math.pow(2, attempt));
        continue;
      }
    }
    return { result: [] };
  }

  async getLogsByAddressAndTopics(
    address: string,
    fromBlock: number,
    toBlock: number,
    topics: { [key: string]: string },
    chain_id: number
  ) {
    let url = `${this.baseUrl}?chainid=${chain_id}&module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=${toBlock}&address=${address}&apikey=${this.apiKey}`;
    Object.entries(topics).forEach(([key, value]) => {
      url += `&topic${key}_${parseInt(key) + 1}_opr=and&topic${key}=${value}`;
    });

    return this.makeRequest(url);
  }

  async getLogsByAddressesAndTopics(
    addresses: string[],
    fromBlock: number,
    toBlock: number,
    topics: { [key: string]: string },
    chain_id: number
  ) {
    const results = [];

    for (const address of addresses) {
      let url = `${this.baseUrl}?chainid=${chain_id}&module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=${toBlock}&address=${address}&apikey=${this.apiKey}`;
      Object.entries(topics).forEach(([key, value]) => {
        url += `&topic${key}_${parseInt(key) + 1}_opr=and&topic${key}=${value}`;
      });

      const response = await this.makeRequest(url);
      if (response?.result?.length) {
        results.push(...response.result);
      }
    }

    return { result: results };
  }

  async getBlockNumberByTimestamp(
    timestamp: number,
    closest: "before" | "after" = "before",
    chain_id: number
  ): Promise<number> {
    const url = `${this.baseUrl}?chainid=${chain_id}&module=block&action=getblocknobytime&timestamp=${timestamp}&closest=${closest}&apikey=${this.apiKey}`;

    const response = await this.makeRequest(url);

    if (
      !response?.result ||
      response.result === "Error! No closest block found" ||
      response.result === "0"
    ) {
      return 0;
    }

    const blockNumber = parseInt(response.result);
    return isNaN(blockNumber) ? 0 : blockNumber;
  }
}

export const createBlockchainExplorerUtils = () =>
  new BlockchainExplorerUtils();
