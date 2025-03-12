import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import {
  createPublicClient,
  http,
  keccak256,
  encodePacked,
  parseAbi,
  decodeEventLog,
} from "viem";
import { mainnet } from "viem/chains";
import {
  getTimestampsBlocks,
  fetchSwapInEvents,
  fetchSwapOutEvents,
  PROTOCOLS_TOKENS,
  matchWethInWithRewardsOut,
  getTokenInfo,
  getGaugesInfos,
  BOSS,
  ALL_MIGHT,
  BOTMARKET,
  OTC_REGISTRY,
  WETH_ADDRESS,
  GOVERNANCE,
  processSwapsOTC,
  processSwaps,
  collectAllTokens,
  addGaugeNamesToBounties,
  fetchAllTokenInfos,
  escapeCSV,
} from "../utils/reportUtils";
import { VLCVX_DELEGATORS_RECIPIENT } from "../utils/constants";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";
import processReport from "./reportCommon";

dotenv.config();

const WEEK = 604800;
const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

/* ============================================================
   Interfaces & Types
============================================================ */

interface TokenInfo {
  symbol: string;
  decimals: number;
}

interface Bounty {
  bountyId: string;
  gauge: string;
  amount: string;
  rewardToken: string;
  sdTokenAmount?: number;
  gaugeName?: string;
  nativeEquivalent?: number;
  share?: number;
  normalizedShare?: number;
}

interface SwapEvent {
  blockNumber: number;
  logIndex: number;
  from: string;
  to: string;
  token: string;
  amount: bigint;
}

interface SwapData {
  sdTokenIn?: number[];
  sdTokenOut?: number[];
  nativeIn?: number[];
  nativeOut?: number[];
  wethOut?: number[];
  wethIn?: number[];
  rewardsOut?: { token: string; symbol: string; amount: number }[];
}

interface MatchData {
  address: string;
  symbol: string;
  amount: number;
  weth: number;
}

interface OTCWithdrawal {
  protocol: string;
  rewardToken: string;
  amount: number;
  gaugeAddress: string;
  chainId: number;
  blockNumber: number;
}

interface BlockData {
  blockNumber: number;
  matches: MatchData[];
}

interface ProtocolData {
  [protocol: string]: BlockData[];
}

interface ProcessedSwapEvent extends SwapEvent {
  formattedAmount: number;
  symbol: string;
}

interface AggregatedTokenInfo {
  address: string;
  symbol: string;
  amount: number;
  weth: number;
}

interface ProtocolSummary {
  protocol: string;
  totalWethOut: number;
  totalWethIn: number;
  totalNativeOut: number;
  totalNativeIn: number;
  totalSdTokenOut: number;
  totalSdTokenIn: number;
  tokens: AggregatedTokenInfo[];
}

interface CSVRow {
  protocol: string;
  gaugeName: string;
  gaugeAddress: string;
  rewardToken: string;
  rewardAddress: string;
  rewardAmount: number;
  rewardSdValue: number;
  sharePercentage: number;
}

/* ============================================================
   Clients & Utilities
============================================================ */

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

const explorerUtils = createBlockchainExplorerUtils();

/**
 * Fetch OTC withdrawals and decode logs.
 */
async function fetchOTCWithdrawals(
  fromBlock: number,
  toBlock: number
): Promise<Record<string, Bounty[]>> {
  const eventSignature = "OTCWithdrawn(uint256,address,uint256)";
  const otcWithdrawnHash = keccak256(
    encodePacked(["string"], [eventSignature])
  );

  const otcWitdrawnAbi = parseAbi([
    "event OTCWithdrawn(uint256 id, address withdrawer, uint256 amount)",
  ]);

  let decodedLogs: {
    id: bigint;
    withdrawer: string;
    amount: bigint;
    block: number;
  }[] = [];

  const response = await explorerUtils.getLogsByAddressAndTopics(
    OTC_REGISTRY,
    fromBlock,
    toBlock,
    { "0": otcWithdrawnHash },
    1
  );

  if (!response || !response.result || response.result.length === 0) {
    throw new Error("No logs found");
  }

  for (const log of response.result) {
    const decodedLog = decodeEventLog({
      abi: otcWitdrawnAbi,
      data: log.data,
      topics: log.topics,
      strict: true,
    });
    decodedLogs.push({
      id: decodedLog.args.id,
      withdrawer: decodedLog.args.withdrawer,
      amount: decodedLog.args.amount,
      block: Number(log.blockNumber),
    });
  }

  // Initialize result with known protocols
  const result: Record<string, Bounty[]> = {
    curve: [],
    balancer: [],
    fxn: [],
    frax: [],
  };

  for (const decoded of decodedLogs) {
    const { id, amount } = decoded;
    const otcData = await publicClient.readContract({
      address: OTC_REGISTRY,
      abi: [
        {
          name: "otcs",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "", type: "uint256" }],
          outputs: [
            { name: "depositor", type: "address" },
            { name: "protocolName", type: "string" },
            { name: "rewardToken", type: "address" },
            { name: "gauge", type: "address" },
            { name: "chainId", type: "uint256" },
            { name: "amount", type: "uint256" },
            { name: "startTimestamp", type: "uint256" },
            { name: "totalPeriods", type: "uint256" },
            { name: "withdrawPerPeriod", type: "uint256" },
          ],
        },
      ],
      functionName: "otcs",
      args: [BigInt(Number(id))],
    });

    const protocol = otcData[1].toLowerCase();
    const bounty: Bounty = {
      bountyId: id.toString(),
      gauge: otcData[3],
      amount: amount.toString(),
      rewardToken: otcData[2],
    };

    if (result[protocol]) {
      result[protocol].push(bounty);
    } else {
      result[protocol] = [bounty];
    }
  }

  return result;
}

/* ============================================================
   Main Function
============================================================ */

async function main() {
  // Validate protocol argument
  const protocol = process.argv[2];
  if (!protocol || !["curve", "balancer", "fxn", "frax"].includes(protocol)) {
    console.error(
      "Please specify a valid protocol: curve, balancer, fxn, or frax"
    );
    process.exit(1);
  }

  // Get block timestamps and numbers
  const { blockNumber1, blockNumber2 } = await getTimestampsBlocks(
    publicClient,
    0
  );

  let aggregatedBounties = await fetchOTCWithdrawals(
    blockNumber1,
    blockNumber2
  );
  // Filter bounties for the specified protocol
  aggregatedBounties = { [protocol]: aggregatedBounties[protocol] };

  // Collect tokens and fetch their info
  const protocolTokens = { [protocol]: PROTOCOLS_TOKENS[protocol] };
  const allTokens = collectAllTokens(aggregatedBounties, protocolTokens);
  const tokenInfos = await fetchAllTokenInfos(
    Array.from(allTokens),
    publicClient
  );

  // Get gauge infos and add gauge names to bounties
  let gaugesInfo;
  switch (protocol) {
    case "curve":
      gaugesInfo = await getGaugesInfos("curve");
      break;
    case "balancer":
      gaugesInfo = await getGaugesInfos("balancer");
      break;
    case "fxn":
      gaugesInfo = await getGaugesInfos("fxn");
      break;
    case "frax":
      gaugesInfo = await getGaugesInfos("frax");
      break;
  }
  aggregatedBounties = {
    [protocol]: addGaugeNamesToBounties(
      aggregatedBounties[protocol],
      gaugesInfo
    ),
  };

  // Fetch swap events
  const swapIn = await fetchSwapInEvents(
    1,
    blockNumber1,
    blockNumber2,
    Array.from(allTokens),
    ALL_MIGHT
  );
  const swapOut = await fetchSwapOutEvents(
    1,
    blockNumber1,
    blockNumber2,
    Array.from(allTokens),
    ALL_MIGHT
  );

  const vlcvxRecipientSwapsIn = await fetchSwapInEvents(
    1,
    blockNumber1,
    blockNumber2,
    [PROTOCOLS_TOKENS.curve.sdToken],
    VLCVX_DELEGATORS_RECIPIENT
  );
  const vlcvxRecipientSwapsInBlockNumbers = vlcvxRecipientSwapsIn.map(
    (swap) => swap.blockNumber
  );
  console.log(
    "vlCVX recipient blocks to exclude:",
    vlcvxRecipientSwapsInBlockNumbers
  );

  const swapInFiltered = processSwapsOTC(swapIn, tokenInfos);
  const swapOutFiltered = processSwaps(swapOut, tokenInfos);

  // Get OTC swap block numbers
  const otcSwapBlocks = new Set(swapInFiltered.map((swap) => swap.blockNumber));

  // Process sdToken swaps
  const sdTokenSwapsIn = processSwaps(
    swapIn.filter(
      (swap) =>
        swap.token.toLowerCase() ===
          PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase() &&
        otcSwapBlocks.has(swap.blockNumber)
    ),
    tokenInfos
  );
  const sdTokenSwapsOut = processSwaps(
    swapOut.filter(
      (swap) =>
        swap.token.toLowerCase() ===
          PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase() &&
        otcSwapBlocks.has(swap.blockNumber)
    ),
    tokenInfos
  );

  // Process other swaps
  const otherSwapsIn = processSwaps(
    swapIn.filter(
      (swap) =>
        swap.token.toLowerCase() !==
          PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase() &&
        swap.from.toLowerCase() !== OTC_REGISTRY.toLowerCase() &&
        otcSwapBlocks.has(swap.blockNumber)
    ),
    tokenInfos
  );
  const otherSwapsOut = processSwaps(
    swapOut.filter((swap) => otcSwapBlocks.has(swap.blockNumber)),
    tokenInfos
  );

  // Merge swaps and drop duplicates
  const combinedSwapsIn = [
    ...swapInFiltered,
    ...sdTokenSwapsIn,
    ...otherSwapsIn,
  ];
  const combinedSwapsOut = [...otherSwapsOut, ...sdTokenSwapsOut];
  const uniqueSwapsIn = combinedSwapsIn.filter(
    (swap, index, self) =>
      index ===
      self.findIndex(
        (t) =>
          t.blockNumber === swap.blockNumber && t.logIndex === swap.logIndex
      )
  );
  const uniqueSwapsOut = combinedSwapsOut.filter(
    (swap, index, self) =>
      index ===
      self.findIndex(
        (t) =>
          t.blockNumber === swap.blockNumber && t.logIndex === swap.logIndex
      )
  );

  const processedReport = processReport(
    uniqueSwapsIn,
    uniqueSwapsOut,
    aggregatedBounties,
    tokenInfos,
    vlcvxRecipientSwapsInBlockNumbers
  );

  const projectRoot = path.resolve(__dirname, "..", "..");
  const dirPath = path.join(
    projectRoot,
    "bounties-reports",
    currentPeriod.toString()
  );

  for (const [protocol, data] of Object.entries(processedReport)) {
    // Get current csv (period)
    const fileName = `${protocol}.csv`;
    const filePath = path.join(dirPath, fileName);

    let currentCsvData: any[] = [];

    try {
      const currentCsv = fs.readFileSync(filePath, "utf8");
      currentCsvData = parse(currentCsv, {
        columns: true,
        skip_empty_lines: true,
        delimiter: ";",
      });
    } catch (e) {
      console.log(
        `No existing file found for ${protocol}. Creating a new one.`
      );
    }

    // First, collect all gauge addresses from new OTC data
    const newGaugeAddresses = new Set(
      data.map((row) => row.gaugeAddress.toLowerCase())
    );

    // Filter out existing entries with 0 sd value if their gauge is in new OTC data
    currentCsvData = currentCsvData.filter((row) => {
      const isNewGauge = newGaugeAddresses.has(
        row["Gauge Address"].toLowerCase()
      );
      const hasZeroSdValue = parseFloat(row["Reward sd Value"]) === 0;
      return !(isNewGauge && hasZeroSdValue);
    });

    // Convert filtered currentCsvData to a dictionary for easier lookup and modification
    const currentCsvDict = currentCsvData.reduce((acc, row) => {
      const key = `${row["Gauge Address"]}-${row["Reward Address"]}`;
      acc[key] = row;
      return acc;
    }, {});

    // Add new data to the dictionary, updating existing entries or adding new ones
    for (const newRow of data) {
      const key = `${newRow.gaugeAddress}-${newRow.rewardAddress}`;
      if (currentCsvDict[key]) {
        // Update existing entry
        currentCsvDict[key]["Reward Amount"] = (
          parseFloat(currentCsvDict[key]["Reward Amount"]) + newRow.rewardAmount
        ).toString();
        currentCsvDict[key]["Reward sd Value"] = (
          parseFloat(currentCsvDict[key]["Reward sd Value"]) +
          newRow.rewardSdValue
        ).toString();
      } else {
        // Add new entry
        currentCsvDict[key] = {
          "Gauge Name": newRow.gaugeName,
          "Gauge Address": newRow.gaugeAddress,
          "Reward Token": newRow.rewardToken,
          "Reward Address": newRow.rewardAddress,
          "Reward Amount": newRow.rewardAmount.toString(),
          "Reward sd Value": newRow.rewardSdValue.toString(),
          "Share % per Protocol": "0", // Will be recomputed
        };
      }
    }

    // Recompute total Reward sd Value and shares
    const totalRewardSdValue: number = Object.values(currentCsvDict).reduce(
      (sum: number, row: any) => sum + parseFloat(row["Reward sd Value"]),
      0
    );

    // Update shares
    for (const key in currentCsvDict) {
      const row = currentCsvDict[key];
      row["Share % per Protocol"] = (
        (parseFloat(row["Reward sd Value"]) / totalRewardSdValue) *
        100
      ).toFixed(2);
    }
    // Convert the dictionary back to an array for CSV writing
    const updatedCsvData = Object.values(currentCsvDict);
    // Generate CSV content
    const csvContent = [
      "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
      ...updatedCsvData.map(
        (row: any) =>
          `${row["Gauge Name"]};${row["Gauge Address"]};${row["Reward Token"]};${row["Reward Address"]};` +
          `${parseFloat(row["Reward Amount"]).toFixed(6)};${parseFloat(
            row["Reward sd Value"]
          ).toFixed(6)};${row["Share % per Protocol"]}`
      ),
    ].join("\n");
    // Write updated CSV
    fs.writeFileSync(filePath, csvContent);
    console.log(`Updated report for ${protocol}: ${filePath}`);
  }
}

main().catch(console.error);
