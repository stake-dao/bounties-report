import axios from "axios";
import {
  abi,
  AUTO_VOTER_CONTRACT,
  AUTO_VOTER_DELEGATION_ADDRESS,
  CVX_SPACE,
  DELEGATE_REGISTRY,
  DELEGATE_REGISTRY_CREATION_BLOCK_BSC,
  DELEGATE_REGISTRY_CREATION_BLOCK_ETH,
  LABELS_TO_SPACE,
  MERKLE_CREATION_BLOCK_BSC,
  MERKLE_CREATION_BLOCK_ETH,
  SDBAL_SPACE,
  SDPENDLE_SPACE,
} from "./constants";
import fs from "fs";
import path from "path";
import {
  createPublicClient,
  encodePacked,
  getAddress,
  http,
  keccak256,
  pad,
} from "viem";
import { bsc, mainnet } from "viem/chains";
import { createBlockchainExplorerUtils } from "./explorerUtils";
import { formatBytes32String } from "ethers/lib/utils";
import { DelegatorData } from "./types";
const VOTER_ABI = require("../../abis/AutoVoter.json");
const { parse } = require("csv-parse/sync");

export type PendleCSVType = Record<string, Record<string, number>>;
type OtherCSVType = Record<string, number>;
type CvxCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: number }
>;
export type ExtractCSVType = PendleCSVType | OtherCSVType | CvxCSVType;

export const extractCSV = async (
  currentPeriodTimestamp: number,
  space: string
): Promise<ExtractCSVType | undefined> => {
  let csvFilePath: string | undefined;

  let nameSpace: undefined | string = undefined;

  for (const name of Object.keys(LABELS_TO_SPACE)) {
    if (LABELS_TO_SPACE[name] === space) {
      nameSpace = name;
      break;
    }
  }

  if (!nameSpace) {
    throw new Error("can't find name space for space " + space);
  }

  csvFilePath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/${nameSpace}.csv`
  );

  if (!csvFilePath || !fs.existsSync(csvFilePath)) {
    return undefined;
  }

  const csvFile = fs.readFileSync(csvFilePath, "utf8");

  let records = parse(csvFile, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ";",
  });

  const newRecords = records.map((row: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])
    )
  );

  records = newRecords;

  const response: ExtractCSVType = {};
  let total = 0;
  const totalPerToken: Record<string, number> = {};

  for (const row of records) {
    const gaugeAddress = row["gauge address"];
    if (!gaugeAddress) {
      throw new Error("can't find gauge address for " + space);
    }

    if (space === SDPENDLE_SPACE) {
      const period = row["period"];
      const pendleResponse = response as PendleCSVType;
      if (!pendleResponse[period]) {
        pendleResponse[period] = {};
      }
      if (!pendleResponse[period][gaugeAddress]) {
        pendleResponse[period][gaugeAddress] = 0;
      }

      if (row["reward sd value"]) {
        total += parseFloat(row["reward sd value"]);
        pendleResponse[period][gaugeAddress] += parseFloat(
          row["reward sd value"]
        );
      }
    } else if (space === CVX_SPACE) {
      const cvxResponse = response as CvxCSVType;
      const rewardAddress = row["reward address"].toLowerCase();
      const rewardAmount = parseFloat(row["reward amount"]);

      if (!cvxResponse[gaugeAddress]) {
        cvxResponse[gaugeAddress] = { rewardAddress, rewardAmount };
      } else {
        cvxResponse[gaugeAddress].rewardAmount += rewardAmount;
      }

      if (!totalPerToken[rewardAddress]) {
        totalPerToken[rewardAddress] = 0;
      }
      totalPerToken[rewardAddress] += rewardAmount;
    } else {
      const otherResponse = response as OtherCSVType;
      if (!otherResponse[gaugeAddress]) {
        otherResponse[gaugeAddress] = 0;
      }
      if (row["reward sd value"]) {
        const rewardValue = parseFloat(row["reward sd value"]);
        total += rewardValue;
        otherResponse[gaugeAddress] += rewardValue;
      }
    }
  }
  return response;
};

export const getTokenPrice = async (
  space: string,
  SPACE_TO_NETWORK: Record<string, string>,
  SPACES_UNDERLYING_TOKEN: Record<string, string>
): Promise<number> => {
  try {
    if (space === SDBAL_SPACE) {
      const resp = await axios.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=balancer-80-bal-20-weth&vs_currencies=usd"
      );
      return resp.data["balancer-80-bal-20-weth"].usd;
    } else {
      const key = `${SPACE_TO_NETWORK[space]}:${SPACES_UNDERLYING_TOKEN[space]}`;
      const resp = await axios.get(
        `https://coins.llama.fi/prices/current/${key}`
      );
      return resp.data.coins[key].price;
    }
  } catch (e) {
    console.log("Error getTokenPrice ", space);
    throw e;
  }
};

export const checkSpace = (
  space: string,
  SPACES_SYMBOL: Record<string, string>,
  SPACES_IMAGE: Record<string, string>,
  SPACES_UNDERLYING_TOKEN: Record<string, string>,
  SPACES_TOKENS: Record<string, string>,
  SPACE_TO_NETWORK: Record<string, string>,
  NETWORK_TO_STASH: Record<string, string>,
  NETWORK_TO_MERKLE: Record<string, string>
) => {
  if (!SPACES_SYMBOL[space]) {
    throw new Error("No symbol defined for space " + space);
  }
  if (!SPACES_IMAGE[space]) {
    throw new Error("No image defined for space " + space);
  }
  if (!SPACES_UNDERLYING_TOKEN[space]) {
    throw new Error("No underlying token defined for space " + space);
  }
  if (!SPACES_TOKENS[space]) {
    throw new Error("No sdToken defined for space " + space);
  }

  if (!SPACE_TO_NETWORK[space]) {
    throw new Error("No network defined for space " + space);
  }

  if (!NETWORK_TO_STASH[SPACE_TO_NETWORK[space]]) {
    throw new Error("No stash contract defined for space " + space);
  }

  if (!NETWORK_TO_MERKLE[SPACE_TO_NETWORK[space]]) {
    throw new Error("No merkle contract defined for space " + space);
  }
};

/**
 * For each proposal choice, extract his gauge address with his index
 */
export const extractProposalChoices = (
  proposal: any
): Record<string, number> => {
  const addressesPerChoice: Record<string, number> = {};

  if (proposal.space.id.toLowerCase() === SDPENDLE_SPACE) {
    const SEP = " - ";
    const SEP2 = "-";

    for (let i = 0; i < proposal.choices.length; i++) {
      const choice = proposal.choices[i];
      if (
        choice.indexOf("Current Weights") > -1 ||
        choice.indexOf("Paste") > -1 ||
        choice.indexOf("Total Percentage") > -1
      ) {
        continue;
      }
      const start = choice.indexOf(SEP);
      if (start === -1) {
        throw new Error("Impossible to parse choice : " + choice);
      }

      const end = choice.indexOf(SEP2, start + SEP.length);
      if (end === -1) {
        throw new Error("Impossible to parse choice : " + choice);
      }

      const address = choice.substring(end + SEP2.length);
      addressesPerChoice[address] = i + 1;
    }
  } else {
    const SEP = " - 0x";

    for (let i = 0; i < proposal.choices.length; i++) {
      const choice = proposal.choices[i];
      if (
        choice.indexOf("Current Weights") > -1 ||
        choice.indexOf("Paste") > -1 ||
        choice.indexOf("Total Percentage") > -1
      ) {
        continue;
      }
      const start = choice.indexOf(" - 0x");
      if (start === -1) {
        throw new Error("Impossible to parse choice : " + choice);
      }

      let end = choice.indexOf("…", start);
      if (end === -1) {
        end = choice.indexOf("...", start);
        if (end === -1) {
          //throw new Error("Impossible to parse choice : " + choice);
          continue;
        }
      }

      const address = choice.substring(start + SEP.length - 2, end);
      addressesPerChoice[address] = i + 1;
    }
  }

  return addressesPerChoice;
};

export interface ChoiceBribe {
  index: number;
  amount: number;
}

export const getChoiceWhereExistsBribe = (
  addressesPerChoice: Record<string, number>,
  cvsResult: any
): Record<string, ChoiceBribe> => {
  const newAddressesPerChoice: Record<string, ChoiceBribe> = {};
  if (!cvsResult) {
    return newAddressesPerChoice;
  }

  const cvsResultLowerCase: any = {};
  for (const key of Object.keys(cvsResult)) {
    cvsResultLowerCase[key.toLowerCase()] = cvsResult[key];
  }

  const addresses = Object.keys(cvsResultLowerCase).map((addr) =>
    addr.toLowerCase()
  );

  for (const key of Object.keys(addressesPerChoice)) {
    const k = key.toLowerCase();

    for (const addr of addresses) {
      if (addr.indexOf(k) === -1) {
        continue;
      }

      newAddressesPerChoice[addr] = {
        index: addressesPerChoice[key],
        amount: cvsResultLowerCase[addr],
      };
      break;
    }
  }

  if (Object.keys(newAddressesPerChoice).length !== addresses.length) {
    for (const addr of addresses) {
      if (!newAddressesPerChoice[addr]) {
        console.log("Gauge ", addr, "not found");
      }
    }
  }

  return newAddressesPerChoice;
};

export const getChoicesBasedOnReport = (
  addressesPerChoice: Record<string, number>,
  csvResult: any
): Record<string, ChoiceBribe> => {
  const gaugeToChoice: Record<string, ChoiceBribe> = {};
  let notFoundIndex = 0;

  for (const gauge in csvResult) {
    const gaugeLower = gauge.toLowerCase();

    let found = false;
    for (const gaugeBis in addressesPerChoice) {
      const gaugeBisLower = gaugeBis.toLowerCase();

      // Check if the full gauge address starts with the truncated gauge address
      if (gaugeLower.startsWith(gaugeBisLower)) {
        const data: ChoiceBribe = {
          index: addressesPerChoice[gaugeBis],
          amount: csvResult[gauge],
        };
        gaugeToChoice[gaugeLower] = data; // Use full gauge address as key
        found = true;
        break;
      }
    }
    if (!found) {
      notFoundIndex -= 1;
      const data = {
        index: notFoundIndex,
        amount: csvResult[gauge],
      };
      gaugeToChoice[gaugeLower] = data; // Use full gauge address as key when not found
    }
  }

  return gaugeToChoice;
};

interface Voter {
  voter: string;
  choice: Record<string, number>;
  vp: number;
}

/**
 * Will fetch auto voter delegators at the snapshot block number and add them as voters
 */
export const addVotersFromAutoVoter = async (
  space: string,
  proposal: any,
  voters: Voter[],
  addressesPerChoice: Record<string, number>,
  allDelegationLogsAutoVoter: DelegatorData[]
): Promise<Voter[]> => {
  const autoVoter = voters.find(
    (v) => v.voter.toLowerCase() === AUTO_VOTER_DELEGATION_ADDRESS.toLowerCase()
  );
  if (!autoVoter) {
    return voters;
  }

  /*
  const delegators = await getDelegators(
    AUTO_VOTER_DELEGATION_ADDRESS,
    table,
    proposal.created,
    space
  );
  if (delegators.length === 0) {
    return voters;
  }
  */

  // Fetch delegators weight registered in the auto voter contract
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(
      "https://lb.drpc.org/ogrpc?network=ethereum&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9"
    ),
    batch: {
      multicall: true,
    },
  });

  // Process
  const delegators = processAllDelegators(
    allDelegationLogsAutoVoter,
    space,
    proposal.created
  );

  const { data } = await axios.post("https://score.snapshot.org/api/scores", {
    params: {
      network: "1",
      snapshot: parseInt(proposal.snapshot),
      strategies: proposal.strategies,
      space: proposal.space.id,
      addresses: delegators,
    },
  });

  // Compute delegators voting power at the proposal timestamp
  const votersVp: Record<string, number> = {};

  for (const score of data.result.scores) {
    const keys = Object.keys(score);
    for (const key of keys) {
      const vp = score[key];
      if (vp === 0) {
        continue;
      }

      const user = key.toLowerCase();
      if (!votersVp[user]) {
        votersVp[user] = 0;
      }

      votersVp[user] += vp;
    }
  }

  const delegatorAddresses = Object.keys(votersVp);
  if (delegatorAddresses.length === 0) {
    return voters;
  }

  const results = await publicClient.multicall({
    contracts: delegatorAddresses.map((delegatorAddress) => {
      return {
        address: AUTO_VOTER_CONTRACT as any,
        abi: VOTER_ABI as any,
        functionName: "get",
        args: [delegatorAddress, space],
      };
    }),
    blockNumber: parseInt(proposal.snapshot) as any,
  });

  if (results.some((r) => r.status === "failure")) {
    throw new Error(
      "Error when fetching auto voter weights : " + JSON.stringify(results)
    );
  }

  const gaugeAddressesFromProposal = Object.keys(addressesPerChoice);

  for (const delegatorAddress of delegatorAddresses) {
    const data = results.shift()?.result as any;
    if (!data) {
      continue;
    }

    if (data.killed) {
      continue;
    }

    if (data.user.toLowerCase() !== delegatorAddress.toLowerCase()) {
      continue;
    }

    // Shouldn't be undefined or 0 here
    const vp = votersVp[delegatorAddress.toLowerCase()];
    if (!vp) {
      throw new Error("Error when getting user voting power");
    }

    const gauges = data.gauges;
    const weights = data.weights;

    if (gauges.length !== weights.length) {
      throw new Error("gauges length != weights length");
    }

    const choices: Record<string, number> = {};

    for (let i = 0; i < gauges.length; i++) {
      const gauge = gauges[i];
      const weight = weights[i];

      // Need to find the choice index from the gauge address
      const gaugeAddressFromProposal = gaugeAddressesFromProposal.find(
        (g) => gauge.toLowerCase().indexOf(g.toLowerCase()) > -1
      );
      if (!gaugeAddressFromProposal) {
        continue;
      }

      choices[addressesPerChoice[gaugeAddressFromProposal].toString()] =
        Number(weight);
    }

    voters.push({
      voter: delegatorAddress.toLowerCase(),
      choice: choices,
      vp: vp,
    });
  }

  // Remove auto voter to not receive bounty rewards
  return voters.filter(
    (voter) =>
      voter.voter.toLowerCase() !== AUTO_VOTER_DELEGATION_ADDRESS.toLowerCase()
  );
};

export const getDelegationVotingPower = async (
  proposal: any,
  delegatorAddresses: string[],
  network: string
): Promise<Record<string, number>> => {
  try {
    const { data } = await axios.post("https://score.snapshot.org/api/scores", {
      params: {
        network,
        snapshot: parseInt(proposal.snapshot),
        strategies: proposal.strategies,
        space: proposal.space.id,
        addresses: delegatorAddresses,
      },
    });

    if (!data?.result?.scores) {
      throw new Error("No score");
    }

    let result: Record<string, number> = {};
    for (const score of data.result.scores) {
      const parsedScore: Record<string, number> = {};
      for (const addressScore of Object.keys(score)) {
        parsedScore[addressScore.toLowerCase()] = score[addressScore];
      }

      let newResult = { ...result };
      for (const address of Object.keys(newResult)) {
        if (typeof parsedScore[address.toLowerCase()] !== "undefined") {
          newResult[address] += parsedScore[address.toLowerCase()];
          delete parsedScore[address.toLowerCase()];
        }
      }

      result = {
        ...newResult,
        ...parsedScore,
      };
    }

    return result;
  } catch (e) {
    console.log(e);
    throw e;
  }
};

export const getAllAccountClaimed = async (
  lastMerkle: any,
  merkleContract: string,
  chain: any
): Promise<Record<string, boolean>> => {
  const resp: Record<string, boolean> = {};

  const wagmiContract = {
    address: merkleContract,
    abi: abi,
  };

  let rpcUrl = "";
  switch (chain.id) {
    case mainnet.id:
      rpcUrl =
        "https://lb.drpc.org/ogrpc?network=ethereum&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9";
      break;
    case bsc.id:
      rpcUrl =
        "https://lb.drpc.org/ogrpc?network=bsc&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9";
      break;
  }

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  const calls: any[] = [];
  for (const userAddress of Object.keys(lastMerkle.merkle)) {
    const index = lastMerkle.merkle[userAddress].index;
    calls.push({
      ...wagmiContract,
      functionName: "isClaimed",
      args: [lastMerkle.address, index],
    });
  }

  const results = await publicClient.multicall({
    contracts: calls,
  });

  for (const userAddress of Object.keys(lastMerkle.merkle)) {
    const result = results.shift();
    if (!result) {
      continue;
    }
    if (result.result === true) {
      resp[userAddress.toLowerCase()] = true;
    }
  }

  return resp;
};

export const getAllAccountClaimedSinceLastFreeze = async (
  merkleContract: string,
  tokenAddress: string,
  chainId: string
): Promise<Record<string, boolean>> => {
  const cacheDir = path.join(__dirname, "../../cache/merkle_updates");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  const chainDir = path.join(cacheDir, chainId);
  if (!fs.existsSync(chainDir)) {
    fs.mkdirSync(chainDir);
  }
  const merkleDir = path.join(chainDir, merkleContract.toLowerCase());
  if (!fs.existsSync(merkleDir)) {
    fs.mkdirSync(merkleDir);
  }
  const cacheFile = path.join(merkleDir, `${tokenAddress.toLowerCase()}.json`);

  let cachedMerkleUpdate: { blockNumber: number; timestamp: number } | null = null;
  if (fs.existsSync(cacheFile)) {
    const fileContent = fs.readFileSync(cacheFile, "utf8");
    cachedMerkleUpdate = JSON.parse(fileContent);
  }

  const resp: Record<string, boolean> = {};

  const explorerUtils = createBlockchainExplorerUtils(
    Number(chainId) === mainnet.id ? "ethereum" : "bsc"
  );

  const publicClient = createPublicClient({
    chain: Number(chainId) === mainnet.id ? mainnet : bsc,
    transport: http(),
  });

  const currentBlock = await publicClient.getBlock();

  const merkleEventSignature = "MerkleRootUpdated(address,bytes32,uint256)";
  const merkleEventHash = keccak256(
    encodePacked(["string"], [merkleEventSignature])
  );

  const claimedEventSignature =
    "Claimed(address,uint256,uint256,address,uint256)";
  const claimedEventHash = keccak256(
    encodePacked(["string"], [claimedEventSignature])
  );

  const paddedToken = pad(tokenAddress as `0x${string}`, {
    size: 32,
  }).toLowerCase();

  // Start from the cached block number or the creation block
  let startBlock = cachedMerkleUpdate
    ? cachedMerkleUpdate.blockNumber
    : (Number(chainId) === mainnet.id ? MERKLE_CREATION_BLOCK_ETH : MERKLE_CREATION_BLOCK_BSC);

  const merkleUpdates = await explorerUtils.getLogsByAddressAndTopics(
    getAddress(merkleContract),
    startBlock,
    Number(currentBlock.number),
    {
      "0": merkleEventHash,
      "1": paddedToken,
    }
  );

  let latestMerkleUpdate: any = null;
  for (let i = merkleUpdates.result.length - 1; i >= 0; i--) {
    if (
      merkleUpdates.result[i].topics[2] !==
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    ) {
      latestMerkleUpdate = merkleUpdates.result[i];
      break;
    }
  }

  if (latestMerkleUpdate) {
    // Update the cache
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(cacheFile, JSON.stringify({
      blockNumber: Number(latestMerkleUpdate.blockNumber),
      timestamp: Number(latestMerkleUpdate.timeStamp)
    }, null, 2));

    startBlock = Number(latestMerkleUpdate.blockNumber);
  } else if (cachedMerkleUpdate) {
    startBlock = cachedMerkleUpdate.blockNumber;
  }

  const endBlock = Number(currentBlock.number);

  const allClaimedLogs = await explorerUtils.getLogsByAddressAndTopics(
    getAddress(merkleContract),
    startBlock,
    endBlock,
    {
      "0": claimedEventHash,
      "1": paddedToken,
    }
  );

  // Decode user address from logs and update the cached data
  for (const log of allClaimedLogs.result) {
    const paddedUserAddress = log.topics[2];
    const userAddress = getAddress("0x" + paddedUserAddress.slice(-40));
    resp[userAddress.toLowerCase()] = true;
  }

  return resp;
};

function readJSONFile(filePath: string): DelegatorData[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const fileContent = fs.readFileSync(filePath, "utf8");
  return JSON.parse(fileContent);
}

function writeJSONFile(filePath: string, data: DelegatorData[]): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export const fetchDelegators = async (
  delegationAddress: string,
  startBlock: number,
  endBlock: number,
  explorerUtils: any,
  spacesIds: string[]
): Promise<DelegatorData[]> => {
  const chunkSize = 100_000;
  const allDelegators: DelegatorData[] = [];

  while (startBlock < endBlock) {
    const chunkEndBlock = Math.min(startBlock + chunkSize, endBlock);

    const setDelegateSignature = "SetDelegate(address,bytes32,address)";
    const setDelegateHash = keccak256(
      encodePacked(["string"], [setDelegateSignature])
    );

    const clearDelegateSignature = "ClearDelegate(address,bytes32,address)";
    const clearDelegateHash = keccak256(
      encodePacked(["string"], [clearDelegateSignature])
    );

    const paddedDelegationAddress = pad(delegationAddress as `0x${string}`, {
      size: 32,
    }).toLowerCase();

    const setDelegateLogs = await explorerUtils.getLogsByAddressAndTopics(
      getAddress(DELEGATE_REGISTRY),
      startBlock,
      chunkEndBlock,
      {
        "0": setDelegateHash,
        "3": paddedDelegationAddress,
      }
    );

    const clearDelegateLogs = await explorerUtils.getLogsByAddressAndTopics(
      getAddress(DELEGATE_REGISTRY),
      startBlock,
      chunkEndBlock,
      {
        "0": clearDelegateHash,
        "3": paddedDelegationAddress,
      }
    );

    const allLogs = [...setDelegateLogs.result, ...clearDelegateLogs.result];

    const delegators: DelegatorData[] = [];

    for (const log of allLogs) {
      const event = log.topics[0];
      const paddedDelegator = log.topics[1];
      const spaceId = log.topics[2];
      const delegator = getAddress("0x" + paddedDelegator.slice(-40));
      if (
        spacesIds.map((id) => id.toLowerCase()).includes(spaceId.toLowerCase())
      ) {
        delegators.push({
          event: event === setDelegateHash ? "Set" : "Clear",
          user: delegator.toLowerCase(),
          spaceId: spaceId.toLowerCase(),
          timestamp: Number(log.timeStamp),
        });
      }
    }

    allDelegators.push(...delegators);
    startBlock = chunkEndBlock + 1;
  }

  return allDelegators;
};

export const getAllDelegators = async (
  delegationAddress: string,
  chainId: string,
  spaces: string[]
): Promise<DelegatorData[]> => {
  const cacheDir = path.join(__dirname, "../../cache/delegations");
  const cacheFile = path.join(
    cacheDir,
    `delegators_${chainId}_${delegationAddress.toLowerCase()}.json`
  );

  let cachedData = readJSONFile(cacheFile);
  let startBlock: number;

  const explorerUtils = createBlockchainExplorerUtils(
    Number(chainId) === mainnet.id ? "ethereum" : "bsc"
  );

  if (cachedData.length > 0) {
    const latestTimestamp = cachedData[cachedData.length - 1].timestamp;
    startBlock = await explorerUtils.getBlockNumberByTimestamp(
      latestTimestamp,
      "before"
    );
  } else {
    startBlock =
      Number(chainId) === mainnet.id
        ? DELEGATE_REGISTRY_CREATION_BLOCK_ETH
        : DELEGATE_REGISTRY_CREATION_BLOCK_BSC;
  }

  const publicClient = createPublicClient({
    chain: Number(chainId) === mainnet.id ? mainnet : bsc,
    transport: http(),
  });

  const currentBlock = await publicClient.getBlock();

  const spacesIds = spaces.map((space) => formatBytes32String(space));

  const newDelegators = await fetchDelegators(
    delegationAddress,
    startBlock,
    Number(currentBlock.number),
    explorerUtils,
    spacesIds
  );

  // Combine cached data with new data
  const allDelegators = [...cachedData, ...newDelegators];

  // Sort by timestamp
  allDelegators.sort((a, b) => a.timestamp - b.timestamp);

  // Save to JSON file
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  writeJSONFile(cacheFile, allDelegators);

  return allDelegators;
};

export const processAllDelegators = (
  delegators: DelegatorData[],
  space: string,
  timestamp: number
): string[] => {
  const users: string[] = [];

  const spaceBytes = formatBytes32String(space);

  let processedData: DelegatorData[] = [];

  // Get all until timestamp
  for (const delegator of delegators) {
    if (
      delegator.timestamp > timestamp ||
      delegator.spaceId.toLowerCase() !== spaceBytes.toLowerCase()
    ) {
      continue;
    }
    processedData.push(delegator);
  }

  // Group entries by user
  const userEntries: Record<string, DelegatorData[]> = {};
  for (const entry of processedData) {
    if (entry.spaceId.toLowerCase() !== spaceBytes.toLowerCase()) continue;
    if (!userEntries[entry.user]) {
      userEntries[entry.user] = [];
    }
    userEntries[entry.user].push(entry);
  }

  // For each user, check if their last entry is a "Set" event
  for (const [user, entries] of Object.entries(userEntries)) {
    entries.sort((a, b) => b.timestamp - a.timestamp); // Sort in descending order
    if (entries[0].event === "Set") {
      users.push(user);
    }
  }
  return users;
};

// TODO : RPC and parquet
export const getAllDelegators_vlCVX = async (
  delegationAddress: string,
  space: string
): Promise<DelegatorData[]> => {
  const explorerUtils = createBlockchainExplorerUtils("ethereum");

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(),
  });

  const currentBlock = await publicClient.getBlock();
  let endBlock = Number(currentBlock.number);
  const chunkSize = 1_000_000;
  const creationBlock = DELEGATE_REGISTRY_CREATION_BLOCK_ETH

  const setDelegateSignature = "SetDelegate(address,bytes32,address)";
  const setDelegateHash = keccak256(
    encodePacked(["string"], [setDelegateSignature])
  );

  const clearDelegateSignature = "ClearDelegate(address,bytes32,address)";
  const clearDelegateHash = keccak256(
    encodePacked(["string"], [clearDelegateSignature])
  );

  const paddedDelegationAddress = pad(delegationAddress as `0x${string}`, {
    size: 32,
  }).toLowerCase();

  const spaceId = formatBytes32String(space);

  const delegators: DelegatorData[] = [];
  const processedDelegators = new Set<string>();

  while (endBlock > creationBlock) {
    const startBlock = Math.max(endBlock - chunkSize, creationBlock);

    const setDelegateLogs = await explorerUtils.getLogsByAddressAndTopics(
      getAddress(DELEGATE_REGISTRY),
      startBlock,
      endBlock,
      {
        "0": setDelegateHash,
        "2": spaceId,
        "3": paddedDelegationAddress,
      }
    );

    const clearDelegateLogs = await explorerUtils.getLogsByAddressAndTopics(
      getAddress(DELEGATE_REGISTRY),
      startBlock,
      endBlock,
      {
        "0": clearDelegateHash,
        "2": spaceId,
        "3": paddedDelegationAddress,
      }
    );

    const allLogs = [...setDelegateLogs.result, ...clearDelegateLogs.result];
    allLogs.sort((a, b) => Number(b.timeStamp) - Number(a.timeStamp));

    for (const log of allLogs) {
      const event = log.topics[0];
      const paddedDelegator = log.topics[1];
      const delegator = getAddress("0x" + paddedDelegator.slice(-40)).toLowerCase();

      if (!processedDelegators.has(delegator)) {
        delegators.push({
          event: event === setDelegateHash ? "Set" : "Clear",
          user: delegator,
          spaceId: spaceId.toLowerCase(),
          timestamp: Number(log.timeStamp),
        });
        processedDelegators.add(delegator);
      }
    }

    endBlock = startBlock - 1;
  }

  // Sort delegators by timestamp in descending order
  delegators.sort((a, b) => b.timestamp - a.timestamp);

  return delegators;
};