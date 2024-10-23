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
  SPACE_TO_CHAIN_ID,
} from "./constants";
import { createBlockchainExplorerUtils } from "./explorerUtils";
import { bsc, mainnet } from "viem/chains";
import * as parquet from "parquetjs";
import { asyncBufferFromFile, parquetRead } from "hyparquet";
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
    const delegators = await fetchDelegatorsForAddress(
      chainId,
      delegationAddress,
      explorerUtils,
      startBlock,
      endBlock
    );

    // Add end block if necessary
    if (
      delegators.length === 0 ||
      delegators[delegators.length - 1].blockNumber !== endBlock
    ) {
      delegators.push({
        event: "EndBlock",
        user: "",
        spaceId: "",
        timestamp: 0,
        blockNumber: endBlock,
      });
    }
    // Only if needed, store the delegators as Parquet
    if (delegators.length > 1) {
      // Always at least one (EndBlock)
      await storeDelegatorsAsParquet(chainId, delegationAddress, delegators);
    }
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

  console.log(`Reading ${existingFile}`);

  let delegators: any[] = [];

  await parquetRead({
    file: await asyncBufferFromFile(existingFile),
    rowFormat: "object",
    onComplete: (data: any[]) => {
      delegators = data;
    },
  });

  // Filter by space and timestamp
  delegators = delegators.filter(
    (d) =>
      d.spaceId.toLowerCase() === spaceBytes32.toLowerCase() &&
      d.timestamp <= currentPeriodTimestamp
  );

  let filteredDelegators: DelegatorData[] = [];
  let usersEvents: { [key: string]: string[] } = {};

  // Retrieve all events for each user
  for (const delegator of delegators) {
    if (!usersEvents[delegator.user]) {
      usersEvents[delegator.user] = [];
    }
    usersEvents[delegator.user].push(delegator.event);
  }

  // Drop users whose latest event is "Clear"
  for (const [user, events] of Object.entries(usersEvents)) {
    if (events[events.length - 1] !== "Clear") {
      filteredDelegators.push(delegators.find((d) => d.user === user)!);
    }
  }

  // Return as a list of addresses
  return filteredDelegators.map((d) => d.user);
};

function initializeChainData(chainId: string) {
  const DELEGATION_REGISTRY_CREATION_BLOCK =
    chainId === "1"
      ? DELEGATE_REGISTRY_CREATION_BLOCK_ETH
      : DELEGATE_REGISTRY_CREATION_BLOCK_BSC;

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
    default:
      throw new Error(`Unsupported chain ID: ${chainId}`);
  }

  const explorerUtils = createBlockchainExplorerUtils(
    Number(chainId) === mainnet.id ? "ethereum" : "bsc"
  );

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
      paddedDelegationAddress
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

    let latestBlock = 0;

    await parquetRead({
      file: await asyncBufferFromFile(existingFile),
      rowFormat: "object",
      onComplete: (data: any[]) => {
        if (data.length > 0) {
          latestBlock = data[data.length - 1].blockNumber;
        }
      },
    });
    return latestBlock;
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
  paddedDelegationAddress: string
) {
  const setDelegateLogs = await explorerUtils.getLogsByAddressAndTopics(
    getAddress(DELEGATE_REGISTRY),
    startBlock,
    endBlock,
    {
      "0": setDelegateHash,
      "3": paddedDelegationAddress,
    }
  );

  const clearDelegateLogs = await explorerUtils.getLogsByAddressAndTopics(
    getAddress(DELEGATE_REGISTRY),
    startBlock,
    endBlock,
    {
      "0": clearDelegateHash,
      "3": paddedDelegationAddress,
    }
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
      await parquetRead({
        file: await asyncBufferFromFile(filePath),
        rowFormat: "object",
        onComplete: (data: any[]) => {
          existingDelegators = data;
        },
      });
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
    await writer.appendRow(delegator);
  }
  await writer.close();

  console.log(
    `Stored ${newDelegators.length} delegators for ${delegationAddress} in ${filePath}`
  );
}
