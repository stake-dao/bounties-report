import axios from "axios";
import {
  abi,
  AUTO_VOTER_CONTRACT,
  AUTO_VOTER_DELEGATION_ADDRESS,
  CVX_FXN_SPACE,
  CVX_SPACE,
  LABELS_TO_SPACE,
  MERKLE_CREATION_BLOCK_BSC,
  MERKLE_CREATION_BLOCK_ETH,
  SDBAL_SPACE,
  SDPENDLE_SPACE,
  SPECTRA_SPACE,
  VLAURA_SPACE,
  getClient,
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
import { bsc, mainnet } from "../utils/chains";
import { createBlockchainExplorerUtils } from "./explorerUtils";
import { processAllDelegators } from "./cacheUtils";
import { getBlockNumberByTimestamp } from "./chainUtils";
const VOTER_ABI = require("../../abis/AutoVoter.json");
const { parse } = require("csv-parse/sync");

export type PendleCSVType = Record<string, Record<string, number>>;
export type OtherCSVType = Record<string, number>;
export type CvxCSVType = Record<
  string,
  Array<{ rewardAddress: string; rewardAmount: bigint; chainId: number }>
>;

export type ExtractCSVType = PendleCSVType | OtherCSVType | CvxCSVType;

export function isOddWeek(timestamp?: number): boolean {
  // If no timestamp provided, use current time in seconds
  if (timestamp === undefined) {
    timestamp = Math.floor(Date.now() / 1000);
  }
  
  // Get the week number (0-based) from Unix epoch
  const ONE_WEEK = 604800; // seconds in a week
  const weekNumber = Math.floor(timestamp / ONE_WEEK);
  
  // Check if week number is odd
  return Boolean(weekNumber % 2);
}

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

  let totalPerToken: Record<string, number | bigint> = {};

  // For non-sdpendle spaces, also check for OTC file
  if (space !== SDPENDLE_SPACE) {
    const otcFilePath = path.join(
      __dirname,
      `../../bounties-reports/${currentPeriodTimestamp}/${nameSpace}-otc.csv`
    );
    
    if (fs.existsSync(otcFilePath)) {
      const otcCsvFile = fs.readFileSync(otcFilePath, "utf8");
      let otcRecords = parse(otcCsvFile, {
        columns: true,
        skip_empty_lines: true,
        delimiter: ";",
      });
      
      otcRecords = otcRecords.map((row: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])
        )
      );
      
      // Merge OTC records into main records
      records = records.concat(otcRecords);
    }
  }

  for (const row of records) {
    const gaugeAddress = row["gauge address"] ? row["gauge address"].toLowerCase() : undefined;
    const gaugeName = row["gauge name"]; // For spectra
    if (space === SPECTRA_SPACE) {
      if (!gaugeName) {
        throw new Error("can't find pool address for " + space);
      }
    } else {
      if (!gaugeAddress) {
        throw new Error("can't find gauge address for " + space);
      }
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
        pendleResponse[period][gaugeAddress] += parseFloat(
          row["reward sd value"]
        );
      }
    } else if (space === CVX_SPACE || space === CVX_FXN_SPACE || space === VLAURA_SPACE) {
      const cvxResponse = response as CvxCSVType;
      const rewardAddress = row["reward address"].toLowerCase();
      const rewardAmount = BigInt(row["reward amount"]);
      const chainId = parseInt(row["chainid"]);
      const gaugeAddress = row["gauge address"].toLowerCase();

      if (!cvxResponse[gaugeAddress]) {
        cvxResponse[gaugeAddress] = [{ rewardAddress, rewardAmount, chainId }];
      } else {
        const existingRewardIndex = cvxResponse[gaugeAddress].findIndex(
          (reward) => reward.rewardAddress === rewardAddress
        );

        if (existingRewardIndex >= 0) {
          cvxResponse[gaugeAddress][existingRewardIndex].rewardAmount +=
            rewardAmount;
        } else {
          cvxResponse[gaugeAddress].push({
            rewardAddress,
            rewardAmount,
            chainId,
          });
        }
      }

      if (!totalPerToken[rewardAddress]) {
        totalPerToken[rewardAddress] = BigInt(0);
      }
      totalPerToken[rewardAddress] =
        (totalPerToken[rewardAddress] as bigint) + rewardAmount;
    } else if (space === SPECTRA_SPACE) {
      const otherResponse = response as OtherCSVType;
      if (!otherResponse[gaugeName]) {
        otherResponse[gaugeName] = 0;
      }
      if (row["reward sd value"]) {
        otherResponse[gaugeName] += parseFloat(row["reward sd value"]);
      }
    } else {
      const otherResponse = response as OtherCSVType;
      if (!otherResponse[gaugeAddress]) {
        otherResponse[gaugeAddress] = 0;
      }
      if (row["reward sd value"]) {
        otherResponse[gaugeAddress] += parseFloat(row["reward sd value"]);
      }
    }
  }
  return response;
};

/**
 * Reads and parses an OTC CSV file for Pendle.
 * The CSV is expected to have at least:
 *  - "timestamp": to key each snapshot,
 *  - "gauge address": used as the sub-key,
 *  - "reward sd value": the reward amount (as a string to be parsed to a number).
 *
 * @param filePath - The full path to the pendle external CSV file (votemarket or otc).
 * @returns A promise that resolves to a PendleCSVType object grouping rewards by timestamp.
 */
export const extractOTCCSV = async (
  filePath: string
): Promise<PendleCSVType> => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`OTC CSV file does not exist at path: ${filePath}`);
  }

  const csvFile = fs.readFileSync(filePath, "utf8");
  let records = parse(csvFile, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ";",
  });

  // Normalize column names to lowercase.
  records = records.map((row: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])
    )
  );

  const response: PendleCSVType = {};

  for (const row of records) {
    const period = row["period"];
    const gaugeAddress = row["gauge address"] ? row["gauge address"].toLowerCase() : undefined;

    if (!period) {
      throw new Error("Missing 'period' in row: " + JSON.stringify(row));
    }
    if (!gaugeAddress) {
      throw new Error("Missing 'gauge address' in row: " + JSON.stringify(row));
    }

    if (!response[period]) {
      response[period] = {};
    }

    // Initialize gauge address value if needed.
    if (!response[period][gaugeAddress]) {
      response[period][gaugeAddress] = 0;
    }

    if (row["reward sd value"]) {
      response[period][gaugeAddress] += parseFloat(row["reward sd value"]);
    }
  }

  return response;
};

/**
 * Represents a single raw token distribution entry
 */
export type RawTokenDistribution = {
  gauge: string;  // Gauge address receiving the rewards
  token: string;  // Token contract address to distribute
  symbol: string; // Token symbol
  amount: number; // Amount of tokens to distribute
  space: string;  // Snapshot space whose voting rules apply
};

export type RawTokenCSVType = RawTokenDistribution[];

/**
 * Extracts raw token distributions from CSV files in bounties-reports/{timestamp}/raw/{protocol}/
 * These distributions use raw tokens (CRV, BAL, etc.) instead of sdTokens
 * 
 * @param currentPeriodTimestamp - The timestamp of the current period
 * @returns Array of raw token distributions with gauge, token, amount, and space info
 */
export const extractAllRawTokenCSVs = async (
  currentPeriodTimestamp: number
): Promise<RawTokenCSVType> => {
  const rawDistributions: RawTokenCSVType = [];
  const rawBasePath = path.join(
    __dirname,
    `../../bounties-reports/${currentPeriodTimestamp}/raw/`
  );

  // Check if raw directory exists
  if (!fs.existsSync(rawBasePath)) {
    return rawDistributions;
  }

  // Get all protocol directories in raw/
  const protocolDirs = fs.readdirSync(rawBasePath).filter(item => {
    const itemPath = path.join(rawBasePath, item);
    return fs.statSync(itemPath).isDirectory();
  });

  // Process each protocol directory
  for (const protocol of protocolDirs) {
    const csvFilePath = path.join(rawBasePath, protocol, `${protocol}.csv`);
    
    if (!fs.existsSync(csvFilePath)) {
      continue;
    }

    const csvFile = fs.readFileSync(csvFilePath, "utf8");
    let records = parse(csvFile, {
      columns: true,
      skip_empty_lines: true,
      delimiter: ";",
    });

    // Normalize column names to lowercase
    records = records.map((row: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])
      )
    );

    // Process each row to extract raw token distribution data
    for (const row of records) {
      const gaugeAddress = row["gauge address"] ? row["gauge address"].toLowerCase() : undefined;
      const rewardAddress = row["reward address"];
      const rewardToken = row["reward token"]; // Token symbol
      const rewardAmount = row["reward amount"];
      
      // Determine the space based on the protocol
      let space = row["space"] || row["snapshot space"];
      if (!space) {
        // Map protocol names to snapshot spaces
        if (protocol === "curve") space = "sdcrv.eth";
        else if (protocol === "balancer") space = "sdbal.eth";
        else if (protocol === "frax") space = "sdfrax.eth";
        else if (protocol === "fxn") space = "sdfxs.eth";
        else {
          console.warn(`Unknown protocol ${protocol} for determining space`);
          continue;
        }
      }
      
      if (!gaugeAddress || !rewardAddress || !rewardAmount) {
        console.warn(`Missing required fields in raw/${protocol}/${protocol}.csv:`, row);
        continue;
      }

      rawDistributions.push({
        gauge: gaugeAddress,
        token: rewardAddress,
        symbol: rewardToken || "UNKNOWN",
        amount: parseFloat(rewardAmount),
        space: space
      });
    }
  }

  return rawDistributions;
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

export const getHistoricalTokenPrice = async (
  timestamp: number,
  chain: string,
  tokenAddress: string
): Promise<number> => {
  try {
    const key = `${chain}:${tokenAddress}`;
    const resp = await axios.get(
      `https://coins.llama.fi/prices/historical/${timestamp}/${key}`
    );

    const price = resp.data.coins[key].price;
    if (price === 0) {
      throw new Error(`${tokenAddress} price equals to 0`);
    }

    return price;
  } catch (e) {
    console.log("Error getHistoricalTokenPrice");
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
  addressesPerChoice: Record<string, number>
): Promise<Voter[]> => {
  const autoVoter = voters.find(
    (v) => v.voter.toLowerCase() === AUTO_VOTER_DELEGATION_ADDRESS.toLowerCase()
  );
  if (!autoVoter) {
    return voters;
  }

  const endBlock = await getBlockNumberByTimestamp(proposal.end, "before", mainnet.id);

  // Get all delegators until proposal creation
  const delegators = await processAllDelegators(
    space,
    proposal.created,
    AUTO_VOTER_DELEGATION_ADDRESS
  );

  // Fetch delegators weight registered in the auto voter contract
  const publicClient = await getClient(1);

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
    blockNumber: endBlock as any,
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
  network: string,
  batchSize: number = 50, // Default batch size of 50 addresses
  delayMs: number = 2000 // Delay between batches
): Promise<Record<string, number>> => {
  try {
    // Filter out the "delegation" strategy to get only raw VP
    // The delegation strategy would incorrectly attribute VP from users who
    // delegated to a delegator (but not to DELEGATION_ADDRESS) to that delegator
    const strategiesWithoutDelegation = proposal.strategies.filter(
      (s: { name: string }) => s.name !== "delegation"
    );

    let result: Record<string, number> = {};

    // Process addresses in batches to avoid Snapshot API limits
    const totalBatches = Math.ceil(delegatorAddresses.length / batchSize);

    for (let i = 0; i < delegatorAddresses.length; i += batchSize) {
      const batch = delegatorAddresses.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;

      if (totalBatches > 1) {
        console.log(`[getDelegationVotingPower] Processing batch ${batchNum}/${totalBatches} (${batch.length} addresses)`);
      }

      const { data } = await axios.post("https://score.snapshot.org/api/scores", {
        params: {
          network,
          snapshot: parseInt(proposal.snapshot),
          strategies: strategiesWithoutDelegation,
          space: proposal.space.id,
          addresses: batch,
        },
      });

      if (!data?.result?.scores) {
        throw new Error("No score");
      }

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

      // Delay between batches (except for last batch)
      if (i + batchSize < delegatorAddresses.length) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
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

  const publicClient = await getClient(chain.id);

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
  const cacheDir = path.join(__dirname, "../../data/merkle_updates");
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

  let cachedMerkleUpdate: { blockNumber: number; timestamp: number } | null =
    null;
  if (fs.existsSync(cacheFile)) {
    const fileContent = fs.readFileSync(cacheFile, "utf8");
    cachedMerkleUpdate = JSON.parse(fileContent);
  }

  const resp: Record<string, boolean> = {};

  const explorerUtils = createBlockchainExplorerUtils();

  let chain: any;
  switch (Number(chainId)) {
    case mainnet.id:
      chain = mainnet;
      break;
    case bsc.id:
      chain = bsc;
      break;
    default:
      throw new Error("Chain not found");
  }

  const publicClient = await getClient(Number(chainId));
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
    : Number(chainId) === mainnet.id
    ? MERKLE_CREATION_BLOCK_ETH
    : MERKLE_CREATION_BLOCK_BSC;

  const merkleUpdates = await explorerUtils.getLogsByAddressAndTopics(
    getAddress(merkleContract),
    startBlock,
    Number(currentBlock.number),
    {
      "0": merkleEventHash,
      "1": paddedToken,
    },
    Number(chainId)
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
    fs.writeFileSync(
      cacheFile,
      JSON.stringify(
        {
          blockNumber: Number(latestMerkleUpdate.blockNumber),
          timestamp: Number(latestMerkleUpdate.timeStamp),
        },
        null,
        2
      )
    );

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
    },
    Number(chainId)
  );

  // Decode user address from logs and update the cached data
  for (const log of allClaimedLogs.result) {
    const paddedUserAddress = log.topics[2];
    const userAddress = getAddress("0x" + paddedUserAddress.slice(-40));
    resp[userAddress.toLowerCase()] = true;
  }

  return resp;
};
