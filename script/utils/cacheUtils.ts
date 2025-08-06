import {
  keccak256,
  encodePacked,
  getAddress,
  pad,
  createPublicClient,
  http,
} from "viem";
import * as fs from "fs";
import * as path from "path";
import { DelegatorData } from "./types";
import {
  DELEGATE_REGISTRY,
  DELEGATE_REGISTRY_CREATION_BLOCK_BSC,
  DELEGATE_REGISTRY_CREATION_BLOCK_ETH,
  DELEGATE_REGISTRY_CREATION_BLOCK_BASE,
  SPACE_TO_CHAIN_ID,
} from "./constants";
import { createBlockchainExplorerUtils } from "./explorerUtils";
import { base, bsc, mainnet } from "viem/chains";
import * as parquet from "parquetjs";
import { formatBytes32String } from "ethers/lib/utils";

const DATA_DIR = path.join(__dirname, "../../data");
const DELEGATIONS_DIR = path.join(DATA_DIR, "delegations");

function getDelegationsFilePath(
  chainId: string,
  delegationAddress: string
): string {
  return path.join(DELEGATIONS_DIR, chainId, `${delegationAddress}.parquet`);
}

const setDelegateSignature = "SetDelegate(address,bytes32,address)";
const setDelegateHash = keccak256(
  encodePacked(["string"], [setDelegateSignature])
);

const clearDelegateSignature = "ClearDelegate(address,bytes32,address)";
const clearDelegateHash = keccak256(
  encodePacked(["string"], [clearDelegateSignature])
);

export const fetchAllDelegators = async (
  chainId: string,
  delegationAddresses: string[]
) => {
  const { rpcUrl, chain, explorerUtils, startBlock } =
    initializeChainData(chainId);

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  const endBlock = Number(await publicClient.getBlockNumber());

  for (const delegationAddress of delegationAddresses) {
    const newDelegators = await fetchDelegatorsForAddress(
      chainId,
      delegationAddress,
      explorerUtils,
      startBlock,
      endBlock
    );

    // Ensure directory exists before trying to read file
    const filePath = getDelegationsFilePath(chainId, delegationAddress);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    
    const oldDelegators = await readParquetFile(filePath);

    // Remove EndBlock entries from both arrays
    const filteredOldDelegators = oldDelegators.filter(d => d.event !== "EndBlock");
    const filteredNewDelegators = newDelegators.filter(d => d.event !== "EndBlock");

    // Merge the filtered delegators
    const delegators = [...filteredOldDelegators, ...filteredNewDelegators];

    // Sort by block number to ensure chronological order
    delegators.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

    // Add new EndBlock entry
    delegators.push({
      event: "EndBlock",
      user: "",
      spaceId: "",
      timestamp: 0,
      blockNumber: endBlock,
    });

    // Store the merged results
    await storeDelegatorsAsParquet(chainId, delegationAddress, delegators);
  }
};

export const processAllDelegators = async (
  space: string,
  currentPeriodTimestamp: number,
  delegationAddress: string
) => {
  const spaceBytes32 = formatBytes32String(space);

  // First get the cached file for the delegation address
  const existingFile = getDelegationsFilePath(
    SPACE_TO_CHAIN_ID[space],
    delegationAddress
  );
  if (!fs.existsSync(existingFile)) {
    throw new Error(`No existing file found for ${delegationAddress}.`);
  }

  // Read the Parquet file and store its contents
  const delegators = await readParquetFile(existingFile);

  // Filter by space and timestamp
  const filteredByTimestamp = delegators.filter(
    (d) =>
      d.spaceId.toLowerCase() === spaceBytes32.toLowerCase() &&
      d.timestamp <= currentPeriodTimestamp
  );

  let usersEvents: { [key: string]: string[] } = {};

  // Retrieve all events for each user
  for (const delegator of filteredByTimestamp) {
    if (!usersEvents[delegator.user]) {
      usersEvents[delegator.user] = [];
    }
    usersEvents[delegator.user].push(delegator.event);
  }

  let filteredDelegators: DelegatorData[] = [];
  // Drop users whose latest event is "Clear"
  for (const [user, events] of Object.entries(usersEvents)) {
    if (events[events.length - 1] !== "Clear") {
      filteredDelegators.push(
        filteredByTimestamp.find((d) => d.user === user)!
      );
    }
  }
  // Return as a list of addresses
  return filteredDelegators.map((d) => d.user);
};

function initializeChainData(chainId: string) {
  const DELEGATION_REGISTRY_CREATION_BLOCK =
    chainId === "1"
      ? DELEGATE_REGISTRY_CREATION_BLOCK_ETH
      : chainId === "56"
      ? DELEGATE_REGISTRY_CREATION_BLOCK_BSC
      : DELEGATE_REGISTRY_CREATION_BLOCK_BASE;

  let rpcUrl: string;
  let chain: typeof mainnet | typeof bsc;

  switch (chainId) {
    case "1":
      chain = mainnet;
      rpcUrl =
        "https://lb.drpc.org/ogrpc?network=ethereum&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9";
      break;
    case "56":
      chain = bsc;
      rpcUrl =
        "https://lb.drpc.org/ogrpc?network=bsc&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9";
      break;
    case "8453":
      chain = base;
      rpcUrl =
        "https://lb.drpc.org/ogrpc?network=base&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9";
      break;
    default:
      throw new Error(`Unsupported chain ID: ${chainId}`);
  }

  const explorerUtils = createBlockchainExplorerUtils();

  return {
    rpcUrl,
    chain,
    explorerUtils,
    startBlock: DELEGATION_REGISTRY_CREATION_BLOCK,
  };
}

async function fetchDelegatorsForAddress(
  chainId: string,
  delegationAddress: string,
  explorerUtils: any,
  startBlock: number,
  endBlock: number
): Promise<DelegatorData[]> {
  const delegators: DelegatorData[] = [];
  const paddedDelegationAddress = pad(delegationAddress as `0x${string}`, {
    size: 32,
  }).toLowerCase();

  let latestProcessedBlock = Number(
    await getLatestProcessedBlock(chainId, delegationAddress)
  );

  const fetchStartBlock = Math.max(startBlock, latestProcessedBlock + 1);

  console.log("Start block", fetchStartBlock);

  const chunkSize = 100_000;

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
      paddedDelegationAddress,
      Number(chainId)
    );

    for (const log of logs) {
      delegators.push(parseDelegatorData(log));
    }
  }

  return delegators;
}

async function getLatestProcessedBlock(
  chainId: string,
  delegationAddress: string
): Promise<number> {
  const existingFile = getDelegationsFilePath(chainId, delegationAddress);


  if (!fs.existsSync(existingFile)) {
    console.warn(
      `No existing file found for ${delegationAddress}. Starting from block 0.`
    );
    return 0;
  }

  try {
    const fileStats = await fs.promises.stat(existingFile);
    if (fileStats.size === 0) {
      console.warn(
        `Existing file for ${delegationAddress} is empty. Starting from block 0.`
      );
      return 0;
    }

    const delegators = await readParquetFile(existingFile);

    const lastBlock = delegators[delegators.length - 1].blockNumber;

    return lastBlock;
  } catch (error) {
    console.error(
      `Error reading Parquet file for ${delegationAddress}:`,
      error
    );
    console.warn(`Starting from block 0 due to error.`);
    return 0;
  }
}

async function fetchLogs(
  explorerUtils: any,
  startBlock: number,
  endBlock: number,
  paddedDelegationAddress: string,
  chainId: number
) {
  const setDelegateLogs = await explorerUtils.getLogsByAddressAndTopics(
    getAddress(DELEGATE_REGISTRY),
    startBlock,
    endBlock,
    {
      "0": setDelegateHash,
      "3": paddedDelegationAddress,
    },
    chainId
  );

  const clearDelegateLogs = await explorerUtils.getLogsByAddressAndTopics(
    getAddress(DELEGATE_REGISTRY),
    startBlock,
    endBlock,
    {
      "0": clearDelegateHash,
      "3": paddedDelegationAddress,
    },
    chainId
  );

  return [...setDelegateLogs.result, ...clearDelegateLogs.result];
}

function parseDelegatorData(log: any): DelegatorData {
  const event = log.topics[0];
  const paddedDelegator = log.topics[1];
  const spaceId = log.topics[2];
  const delegator = getAddress("0x" + paddedDelegator.slice(-40));

  return {
    event: event === setDelegateHash ? "Set" : "Clear",
    user: delegator.toLowerCase(),
    spaceId: spaceId.toLowerCase(),
    timestamp: Number(log.timeStamp),
    blockNumber: Number(log.blockNumber),
  };
}

async function storeDelegatorsAsParquet(
  chainId: string,
  delegationAddress: string,
  newDelegators: DelegatorData[]
) {
  const filePath = getDelegationsFilePath(chainId, delegationAddress);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  const schema = new parquet.ParquetSchema({
    event: { type: "UTF8" },
    user: { type: "UTF8" },
    spaceId: { type: "UTF8" },
    timestamp: { type: "INT64" },
    blockNumber: { type: "INT64" },
  });

  let existingDelegators: DelegatorData[] = [];
  if (fs.existsSync(filePath)) {
    try {
      await readParquetFile(filePath);
    } catch (error) {
      console.error(
        `Error reading existing Parquet file for ${delegationAddress}:`,
        error
      );
      // If there's an error reading the file, we'll start with an empty array
      existingDelegators = [];
    }
  }

  // Remove existing EndBlock entry if present
  existingDelegators = existingDelegators.filter((d) => d.event !== "EndBlock");

  // Merge existing and new delegators, ensuring no duplicates
  const mergedDelegators = [...existingDelegators];
  for (const newDelegator of newDelegators) {
    if (newDelegator.event !== "EndBlock") {
      const existingIndex = mergedDelegators.findIndex(
        (d) =>
          BigInt(d.blockNumber) === BigInt(newDelegator.blockNumber) &&
          d.user === newDelegator.user &&
          d.spaceId === newDelegator.spaceId
      );
      if (existingIndex === -1) {
        mergedDelegators.push(newDelegator);
      } else {
        mergedDelegators[existingIndex] = newDelegator;
      }
    }
  }

  // Sort by blockNumber to ensure chronological order
  mergedDelegators.sort((a, b) => {
    const blockA = BigInt(a.blockNumber);
    const blockB = BigInt(b.blockNumber);
    if (blockA < blockB) return -1;
    if (blockA > blockB) return 1;
    return 0;
  });

  // Add the new EndBlock entry
  const endBlockEntry = newDelegators.find((d) => d.event === "EndBlock");
  if (endBlockEntry) {
    mergedDelegators.push(endBlockEntry);
  }

  // Write the merged data to a new file
  const writer = await parquet.ParquetWriter.openFile(schema, filePath);
  for (const delegator of mergedDelegators) {
    await writer.appendRow({
      event: delegator.event,
      user: delegator.user,
      spaceId: delegator.spaceId,
      timestamp: delegator.timestamp,
      blockNumber: delegator.blockNumber,
    });
  }
  await writer.close();

  console.log(
    `Stored ${newDelegators.length} delegators for ${delegationAddress} in ${filePath}`
  );
}

async function readParquetFile(filePath: string) {
  // Check if file exists first
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const { asyncBufferFromFile, parquetRead } = await import("hyparquet");

    let data: any[] = [];
    await parquetRead({
      file: await asyncBufferFromFile(filePath),
      rowFormat: "object",
      onComplete: (result: any[]) => {
        data = result;
      },
    });
    return data;
  } catch (error) {
    console.error(`Error reading Parquet file ${filePath}:`, error);
    return [];
  }
}