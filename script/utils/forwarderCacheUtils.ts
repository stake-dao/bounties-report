import {
  keccak256,
  encodePacked,
  getAddress,
  pad,
  createPublicClient,
  http,
} from "viem";
import * as fs from "node:fs";
import * as path from "node:path";
import { VOTIUM_FORWARDER_REGISTRY } from "./constants";
import { createBlockchainExplorerUtils } from "./explorerUtils";
import { mainnet } from "./chains";
import * as parquet from "parquetjs";

type ExplorerUtils = ReturnType<typeof createBlockchainExplorerUtils>;

const DATA_DIR = path.join(__dirname, "../../data");
const FORWARDERS_DIR = path.join(DATA_DIR, "forwarders");

// Votium Forwarder Registry creation block
const VOTIUM_REGISTRY_CREATION_BLOCK = 14872510;

// Event signatures
// setReg(address indexed _from, address indexed _to, uint256 indexed _start)
const setRegSignature = "setReg(address,address,uint256)";
const setRegHash = keccak256(encodePacked(["string"], [setRegSignature]));

// expReg(address indexed _from, uint256 indexed _end)
const expRegSignature = "expReg(address,uint256)";
const expRegHash = keccak256(encodePacked(["string"], [expRegSignature]));

export interface ForwarderData {
  event: "Set" | "Expire" | "EndBlock";
  from: string;
  to: string;
  start: number;
  expiration: number;
  timestamp: number;
  blockNumber: number;
}

function getForwardersFilePath(chainId: string, toAddress: string): string {
  return path.join(FORWARDERS_DIR, chainId, `${toAddress.toLowerCase()}.parquet`);
}

/**
 * Fetch all forwarders who forward to a specific address (e.g., Stake DAO's VOTIUM_FORWARDER)
 */
export const fetchAllForwarders = async (
  chainId: string,
  toAddress: string
) => {
  const rpcUrl =
    "https://lb.drpc.org/ogrpc?network=ethereum&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9";

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });

  const explorerUtils = createBlockchainExplorerUtils();
  const endBlock = Number(await publicClient.getBlockNumber());

  const filePath = getForwardersFilePath(chainId, toAddress);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  const newForwarders = await fetchForwardersForAddress(
    chainId,
    toAddress,
    explorerUtils,
    VOTIUM_REGISTRY_CREATION_BLOCK,
    endBlock
  );

  const oldForwarders = await readParquetFile(filePath);

  // Remove EndBlock entries from both arrays
  const filteredOldForwarders = oldForwarders.filter((d) => d.event !== "EndBlock");
  const filteredNewForwarders = newForwarders.filter((d) => d.event !== "EndBlock");

  // Merge the filtered forwarders
  const forwarders = [...filteredOldForwarders, ...filteredNewForwarders];

  // Sort by block number to ensure chronological order
  forwarders.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

  // Add new EndBlock entry
  forwarders.push({
    event: "EndBlock",
    from: "",
    to: "",
    start: 0,
    expiration: 0,
    timestamp: 0,
    blockNumber: endBlock,
  });

  // Store the merged results
  await storeForwardersAsParquet(chainId, toAddress, forwarders);
};

/**
 * Get all active forwarders at a specific epoch timestamp
 * Returns addresses that were forwarding to the target address at that time
 */
export const processAllForwarders = async (
  epochTimestamp: number,
  toAddress: string,
  chainId = "1"
): Promise<string[]> => {
  const filePath = getForwardersFilePath(chainId, toAddress);

  if (!fs.existsSync(filePath)) {
    console.warn(`No forwarders file found at ${filePath}`);
    return [];
  }

  const forwarders = await readParquetFile(filePath);

  // Build state for each forwarder address
  const forwarderState: Map<string, { start: number; expiration: number }> = new Map();

  // Process events chronologically
  for (const event of forwarders) {
    if (event.event === "EndBlock") continue;
    if (event.timestamp > epochTimestamp) continue;

    const fromAddr = event.from.toLowerCase();

    if (event.event === "Set") {
      forwarderState.set(fromAddr, {
        start: event.start,
        expiration: event.expiration,
      });
    } else if (event.event === "Expire") {
      // Update expiration
      const current = forwarderState.get(fromAddr);
      if (current) {
        forwarderState.set(fromAddr, {
          ...current,
          expiration: event.expiration,
        });
      }
    }
  }

  // Filter to active forwarders at the epoch
  const activeForwarders: string[] = [];

  for (const [address, state] of forwarderState) {
    // Active if: start <= epochTimestamp AND (expiration == 0 OR expiration > epochTimestamp)
    const isActive =
      state.start <= epochTimestamp &&
      (state.expiration === 0 || state.expiration > epochTimestamp);

    if (isActive) {
      activeForwarders.push(address);
    }
  }

  return activeForwarders;
};

async function fetchForwardersForAddress(
  chainId: string,
  toAddress: string,
  explorerUtils: ReturnType<typeof createBlockchainExplorerUtils>,
  startBlock: number,
  endBlock: number
): Promise<ForwarderData[]> {
  const forwarders: ForwarderData[] = [];
  const paddedToAddress = pad(toAddress.toLowerCase() as `0x${string}`, {
    size: 32,
  }).toLowerCase();

  const latestProcessedBlock = Number(
    await getLatestProcessedBlock(chainId, toAddress)
  );

  const fetchStartBlock = Math.max(startBlock, latestProcessedBlock + 1);

  console.log(`Start block: ${fetchStartBlock}, End block: ${endBlock}`);

  const chunkSize = 50_000;

  for (
    let currentBlock = fetchStartBlock;
    currentBlock < endBlock;
    currentBlock += chunkSize
  ) {
    const chunkEndBlock = Math.min(currentBlock + chunkSize - 1, endBlock);

    const logs = await fetchLogs(
      explorerUtils,
      currentBlock,
      chunkEndBlock,
      paddedToAddress,
      Number(chainId)
    );

    for (const log of logs) {
      forwarders.push(parseForwarderData(log));
    }
  }

  return forwarders;
}

async function getLatestProcessedBlock(
  chainId: string,
  toAddress: string
): Promise<number> {
  const filePath = getForwardersFilePath(chainId, toAddress);

  if (!fs.existsSync(filePath)) {
    console.warn(`No existing file found for ${toAddress}. Starting from block 0.`);
    return 0;
  }

  try {
    const fileStats = await fs.promises.stat(filePath);
    if (fileStats.size === 0) {
      console.warn(`Existing file for ${toAddress} is empty. Starting from block 0.`);
      return 0;
    }

    const forwarders = await readParquetFile(filePath);
    if (forwarders.length === 0) return 0;

    const lastBlock = forwarders[forwarders.length - 1].blockNumber;
    return lastBlock;
  } catch (error) {
    console.error(`Error reading Parquet file for ${toAddress}:`, error);
    console.warn("Starting from block 0 due to error.");
    return 0;
  }
}

async function fetchLogs(
  explorerUtils: ReturnType<typeof createBlockchainExplorerUtils>,
  startBlock: number,
  endBlock: number,
  paddedToAddress: string,
  chainId: number,
  maxRetries = 3
) {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Fetch setReg events (topic2 = _to address)
      const setRegLogs = await explorerUtils.getLogsByAddressAndTopics(
        getAddress(VOTIUM_FORWARDER_REGISTRY),
        startBlock,
        endBlock,
        {
          "0": setRegHash,
          "2": paddedToAddress,
        },
        chainId
      );

      // Fetch expReg events for addresses that forwarded to us
      // We need to get all expReg events and filter client-side since expReg doesn't have _to
      // Actually, expReg only has _from and _end, so we need to cross-reference with setReg
      // For now, we'll fetch all expReg and filter by known forwarders

      // Get all setReg logs first to know which _from addresses we care about
      const setRegResults = setRegLogs?.result || [];

      // Extract unique _from addresses from setReg
      const fromAddresses = new Set<string>();
      for (const log of setRegResults) {
        if (log.topics?.[1]) {
          fromAddresses.add(log.topics[1].toLowerCase());
        }
      }

      // Fetch expReg logs for each _from address we care about
      const expRegResults: typeof setRegResults = [];
      for (const paddedFrom of fromAddresses) {
        const expRegLogs = await explorerUtils.getLogsByAddressAndTopics(
          getAddress(VOTIUM_FORWARDER_REGISTRY),
          startBlock,
          endBlock,
          {
            "0": expRegHash,
            "1": paddedFrom,
          },
          chainId
        );
        if (expRegLogs?.result) {
          expRegResults.push(...expRegLogs.result);
        }
      }

      const results = [...setRegResults, ...expRegResults];

      console.log(
        `  Chunk ${startBlock}-${endBlock}: ${results.length} logs found (${setRegResults.length} setReg, ${expRegResults.length} expReg)`
      );

      return results;
    } catch (error) {
      console.warn(
        `fetchLogs attempt ${attempt + 1}/${maxRetries} failed for blocks ${startBlock}-${endBlock}:`,
        error
      );

      if (attempt < maxRetries - 1) {
        const backoffMs = 5000 * (2 ** attempt);
        console.log(`  Retrying in ${backoffMs / 1000}s...`);
        await delay(backoffMs);
      } else {
        console.error(
          `fetchLogs: All ${maxRetries} retries failed for blocks ${startBlock}-${endBlock}`
        );
        console.error(
          `  WARNING: Potential gap in data between blocks ${startBlock}-${endBlock}`
        );
        return [];
      }
    }
  }

  return [];
}

function parseForwarderData(log: { topics: string[]; timeStamp: string; blockNumber: string }): ForwarderData {
  const eventHash = log.topics[0];

  if (eventHash.toLowerCase() === setRegHash.toLowerCase()) {
    // setReg(address indexed _from, address indexed _to, uint256 indexed _start)
    const from = getAddress(`0x${log.topics[1].slice(-40)}`);
    const to = getAddress(`0x${log.topics[2].slice(-40)}`);
    const start = Number(BigInt(log.topics[3]));

    return {
      event: "Set",
      from: from.toLowerCase(),
      to: to.toLowerCase(),
      start,
      expiration: 0, // Will be updated by expReg
      timestamp: Number(log.timeStamp),
      blockNumber: Number(log.blockNumber),
    };
  }

  // expReg(address indexed _from, uint256 indexed _end)
  const from = getAddress(`0x${log.topics[1].slice(-40)}`);
  const expiration = Number(BigInt(log.topics[2]));

  return {
    event: "Expire",
    from: from.toLowerCase(),
    to: "", // Not available in expReg
    start: 0,
    expiration,
    timestamp: Number(log.timeStamp),
    blockNumber: Number(log.blockNumber),
  };
}

async function storeForwardersAsParquet(
  chainId: string,
  toAddress: string,
  newForwarders: ForwarderData[]
) {
  const filePath = getForwardersFilePath(chainId, toAddress);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  const schema = new parquet.ParquetSchema({
    event: { type: "UTF8" },
    from: { type: "UTF8" },
    to: { type: "UTF8" },
    start: { type: "INT64" },
    expiration: { type: "INT64" },
    timestamp: { type: "INT64" },
    blockNumber: { type: "INT64" },
  });

  let existingForwarders: ForwarderData[] = [];
  if (fs.existsSync(filePath)) {
    try {
      existingForwarders = await readParquetFile(filePath);
    } catch (error) {
      console.error(`Error reading existing Parquet file for ${toAddress}:`, error);
      existingForwarders = [];
    }
  }

  // Remove existing EndBlock entry if present
  existingForwarders = existingForwarders.filter((d) => d.event !== "EndBlock");

  // Merge existing and new forwarders, ensuring no duplicates
  const mergedForwarders = [...existingForwarders];
  for (const newForwarder of newForwarders) {
    if (newForwarder.event !== "EndBlock") {
      const existingIndex = mergedForwarders.findIndex(
        (d) =>
          BigInt(d.blockNumber) === BigInt(newForwarder.blockNumber) &&
          d.from === newForwarder.from &&
          d.event === newForwarder.event
      );
      if (existingIndex === -1) {
        mergedForwarders.push(newForwarder);
      } else {
        mergedForwarders[existingIndex] = newForwarder;
      }
    }
  }

  // Sort by blockNumber to ensure chronological order
  mergedForwarders.sort((a, b) => {
    const blockA = BigInt(a.blockNumber);
    const blockB = BigInt(b.blockNumber);
    if (blockA < blockB) return -1;
    if (blockA > blockB) return 1;
    return 0;
  });

  // Add the new EndBlock entry
  const endBlockEntry = newForwarders.find((d) => d.event === "EndBlock");
  if (endBlockEntry) {
    mergedForwarders.push(endBlockEntry);
  }

  // Write the merged data to a new file
  const writer = await parquet.ParquetWriter.openFile(schema, filePath);
  for (const forwarder of mergedForwarders) {
    await writer.appendRow({
      event: forwarder.event,
      from: forwarder.from,
      to: forwarder.to,
      start: forwarder.start,
      expiration: forwarder.expiration,
      timestamp: forwarder.timestamp,
      blockNumber: forwarder.blockNumber,
    });
  }
  await writer.close();

  console.log(
    `Stored ${mergedForwarders.length} forwarder events for ${toAddress} in ${filePath}`
  );
}

async function readParquetFile(filePath: string): Promise<ForwarderData[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const hyparquet = await import("hyparquet");

    let data: any[] = [];
    await hyparquet.parquetRead({
      file: await (hyparquet as any).asyncBufferFromFile(filePath),
      rowFormat: "object",
      onComplete: (result: any[]) => {
        data = result;
      },
    });
    return data as ForwarderData[];
  } catch (error) {
    console.error(`Error reading Parquet file ${filePath}:`, error);
    return [];
  }
}
