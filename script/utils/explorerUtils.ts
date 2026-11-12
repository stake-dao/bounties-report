import dotenv from "dotenv";

// Load the .env file from the project root
dotenv.config();

const EXPLORER_KEY =
  process.env.EXPLORER_KEY || process.env.ETHERSCAN_API_KEY || "";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class RateLimiter {
  private readonly queue: (() => void)[] = [];
  private running = 0;
  private nextStart = 0;

  constructor(private readonly maxConcurrent: number) {}

  async add<T>(fn: () => Promise<T>, deadline: number): Promise<T> {
    while (this.running >= this.maxConcurrent) {
      let wake!: () => void;
      let timer!: ReturnType<typeof setTimeout>;
      try {
        await new Promise<void>((resolve, reject) => {
          wake = resolve;
          this.queue.push(wake);
          timer = setTimeout(() => reject(new Error("Explorer queue budget exhausted")), Math.max(0, deadline - Date.now()));
        });
      } finally {
        clearTimeout(timer);
        const index = this.queue.indexOf(wake);
        if (index !== -1) this.queue.splice(index, 1);
      }
    }
    this.running++;
    try {
      // Recheck after every wait: delayed timers must not release a burst.
      while (Date.now() < this.nextStart) {
        if (this.nextStart >= deadline) throw new Error("Explorer queue budget exhausted");
        await delay(this.nextStart - Date.now());
      }
      if (Date.now() >= deadline) throw new Error("Explorer queue budget exhausted");
      this.nextStart = Date.now() + 500;
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

  private async makeRequest(url: string) {
    const deadline = Date.now() + 120_000;
    const params = new URL(url).searchParams;
    const isLogs = params.get("action") === "getLogs";
    const context = `chain=${params.get("chainid")} action=${params.get("action")}`;
    const sanitize = (value: unknown) => {
      let text = String(value);
      if (this.apiKey) text = text.split(this.apiKey).join("***");
      return text.replace(/https?:\/\/\S+/gi, "[url]").replace(/apikey=[^\s&]*/gi, "apikey=***").slice(0, 300);
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      let detail = "unknown error";
      let retryable = false;
      let retryAfterMs = 1000 * 2 ** attempt;
      try {
        const { response, data } = await rateLimiter.add(async () => {
          const controller = new AbortController();
          let timer!: ReturnType<typeof setTimeout>;
          try {
            // The race also bounds body parsing and transports that ignore abort.
            return await Promise.race([
              (async () => {
                const response = await fetch(url, { signal: controller.signal });
                if (!response.ok) await response.body?.cancel();
                const data = response.ok ? await response.json() : undefined;
                return { response, data };
              })(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(new DOMException("Explorer request timeout", "AbortError"));
                }, Math.min(30_000, deadline - Date.now()));
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }, deadline);
        if (!response.ok) {
          detail = `HTTP ${response.status}`;
          retryable = response.status === 429 || response.status >= 500;
          const header = response.headers.get("Retry-After");
          if (header) {
            const ms = /^\d+(\.\d+)?$/.test(header)
              ? Number(header) * 1000 : Date.parse(header) - Date.now();
            if (Number.isFinite(ms) && ms >= 0) retryAfterMs = Math.max(retryAfterMs, ms);
          }
        } else if (data?.status === "1") {
          if (isLogs ? Array.isArray(data.result) : /^[1-9]\d*$/.test(String(data.result))) {
            return data;
          }
          detail = "Malformed explorer result";
        } else if (isLogs && data?.status === "0" && data.message === "No records found" && Array.isArray(data.result) && data.result.length === 0) {
          return { result: [] };
        } else {
          detail = `${sanitize(data?.message)}: ${sanitize(data?.result)}`;
          retryable = data?.status === "0" && /rate limit|query timeout|server (?:too )?busy/i.test(String(data.result));
        }
      } catch (error) {
        detail = sanitize(error instanceof Error ? error.message : error);
        retryable = error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
      }
      const failure = `Explorer request failed (${context}, attempt=${attempt + 1}/4): ${detail}`;
      if (!retryable || attempt === 3) throw new Error(failure);
      if (Date.now() + retryAfterMs >= deadline) throw new Error(`${failure}; retry budget exhausted`);
      console.warn(`${failure}; retry in ${retryAfterMs}ms`);
      await delay(retryAfterMs);
    }
    throw new Error(`Explorer retry budget exhausted (${context})`);
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
    // Use 10k block chunks to avoid explorer API timeouts
    const CHUNK_SIZE = 10_000;

    for (const address of addresses) {
      for (let currentBlock = fromBlock; currentBlock <= toBlock; currentBlock += CHUNK_SIZE) {
        const chunkEndBlock = Math.min(currentBlock + CHUNK_SIZE - 1, toBlock);

        let url = `${this.baseUrl}?chainid=${chain_id}&module=logs&action=getLogs&fromBlock=${currentBlock}&toBlock=${chunkEndBlock}&address=${address}&apikey=${this.apiKey}`;
        Object.entries(topics).forEach(([key, value]) => {
          url += `&topic${key}_${parseInt(key) + 1}_opr=and&topic${key}=${value}`;
        });

        const response = await this.makeRequest(url);
        if (response?.result?.length) {
          results.push(...response.result);
        }
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

  /**
   * Get logs by topics only (no address filter).
   * Used to discover token transfers between specific addresses.
   */
  async getLogsByTopics(
    fromBlock: number,
    toBlock: number,
    topics: { [key: string]: string },
    chain_id: number
  ) {
    const results = [];
    // Use 10k block chunks to avoid explorer API timeouts
    const CHUNK_SIZE = 10_000;

    for (let currentBlock = fromBlock; currentBlock <= toBlock; currentBlock += CHUNK_SIZE) {
      const chunkEndBlock = Math.min(currentBlock + CHUNK_SIZE - 1, toBlock);

      let url = `${this.baseUrl}?chainid=${chain_id}&module=logs&action=getLogs&fromBlock=${currentBlock}&toBlock=${chunkEndBlock}&apikey=${this.apiKey}`;
      for (const [key, value] of Object.entries(topics)) {
        url += `&topic${key}_${Number.parseInt(key) + 1}_opr=and&topic${key}=${value}`;
      }

      const response = await this.makeRequest(url);
      if (response?.result?.length) {
        results.push(...response.result);
      }
    }

    return { result: results };
  }
}

export const createBlockchainExplorerUtils = () =>
  new BlockchainExplorerUtils();
