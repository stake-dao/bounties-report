import fs from "fs";
import path from "path";
import { createPublicClient, formatUnits, http } from "viem";
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
  processSwapsOTC,
  aggregateBounties,
  collectAllTokens,
  fetchAllTokenInfos,
  processSwaps,
  escapeCSV,
  addGaugeNamesToBounties,
} from "../utils/reportUtils";
import dotenv from "dotenv";
import {
  ALL_MIGHT,
  BOTMARKET,
  OTC_REGISTRY,
  WETH_ADDRESS,
  GOVERNANCE,
} from "../utils/reportUtils";
import { VLCVX_DELEGATORS_RECIPIENT } from "../utils/constants";
import processReport from "./reportCommon";

dotenv.config();

const WEEK = 604800;
const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

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
}

interface ClaimedBounties {
  timestamp1: number;
  timestamp2: number;
  blockNumber1: number;
  blockNumber2: number;
  votemarket: Record<string, Record<string, Bounty>>;
  votemarket_v2: Record<string, Record<string, Bounty>>;
  warden: Record<string, Record<string, Bounty>>;
  hiddenhand: Record<string, Record<string, Bounty>>;
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

interface BlockData {
  blockNumber: number;
  matches: MatchData[];
}

interface ProtocolData {
  [protocol: string]: BlockData[];
}

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

interface ProcessedSwapEvent extends SwapEvent {
  formattedAmount: number;
  symbol: string;
}

interface GaugeInfo {
  name: string;
  address: string;
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

async function fetchBountiesData(
  currentPeriod: number
): Promise<ClaimedBounties> {
  const paths = {
    votemarket: `weekly-bounties/${currentPeriod}/votemarket/claimed_bounties.json`,
    votemarket_v2: `weekly-bounties/${currentPeriod}/votemarket-v2/claimed_bounties.json`,
    warden: `weekly-bounties/${currentPeriod}/warden/claimed_bounties.json`,
    hiddenhand: `weekly-bounties/${currentPeriod}/hiddenhand/claimed_bounties.json`,
  };

  const readJsonFile = (path: string) => {
    try {
      return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch (error) {
      console.warn(`Warning: Could not read ${path}`, error);
      return {};
    }
  };

  const votemarket = readJsonFile(paths.votemarket);
  const votemarket_v2 = readJsonFile(paths.votemarket_v2);
  const warden = readJsonFile(paths.warden);
  const hiddenhand = readJsonFile(paths.hiddenhand);

  // Filter out unwrapped bounties from v2 if needed
  const filteredV2 = Object.entries(votemarket_v2).reduce(
    (acc, [key, value]: [string, any]) => {
      if (value.isWrapped !== false) {
        // Keep if isWrapped is true or undefined
        acc[key] = value;
      }
      return acc;
    },
    {}
  );

  return {
    timestamp1: votemarket.timestamp1 || 0,
    timestamp2: votemarket.timestamp2 || 0,
    blockNumber1: votemarket.blockNumber1 || 0,
    blockNumber2: votemarket.blockNumber2 || 0,
    votemarket,
    votemarket_v2: filteredV2,
    warden,
    hiddenhand,
  };
}

async function main() {
  // Get protocol from command line args
  const protocol = process.argv[2];
  if (!protocol || !["curve", "balancer", "fxn", "frax"].includes(protocol)) {
    console.error(
      "Please specify a valid protocol: curve, balancer, fxn, or frax"
    );
    process.exit(1);
  }

  const { timestamp1, timestamp2, blockNumber1, blockNumber2 } =
    await getTimestampsBlocks(publicClient, 0);

  const totalBounties = await fetchBountiesData(currentPeriod);
  let aggregatedBounties = aggregateBounties(totalBounties);

  // Filter bounties for specific protocol
  aggregatedBounties = { [protocol]: aggregatedBounties[protocol] };

  // Collect tokens only for specified protocol
  const protocolTokens = { [protocol]: PROTOCOLS_TOKENS[protocol] };
  const allTokens = collectAllTokens(aggregatedBounties, protocolTokens);

  const tokenInfos = await fetchAllTokenInfos(
    Array.from(allTokens),
    publicClient
  );

  // Get gauge infos only for specified protocol
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

  // Add gauge names to bounties for specific protocol
  aggregatedBounties = {
    [protocol]: addGaugeNamesToBounties(
      aggregatedBounties[protocol],
      gaugesInfo
    ),
  };

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

  const swapOTC = processSwapsOTC(swapIn, tokenInfos);

  let swapInFiltered = processSwaps(swapIn, tokenInfos);
  let swapOutFiltered = processSwaps(swapOut, tokenInfos);

  console.log(swapOTC);

  console.log(swapInFiltered);

  console.log(swapOutFiltered);

  // Filter out swaps that are for OTC (Block is present in swapOTC)
  swapInFiltered = swapInFiltered.filter(
    (swap) =>
      !swapOTC.some((otcSwap) => otcSwap.blockNumber === swap.blockNumber)
  );

  swapOutFiltered = swapOutFiltered.filter(
    (swap) =>
      !swapOTC.some((otcSwap) => otcSwap.blockNumber === swap.blockNumber)
  );

  const processedReport = processReport(
    swapInFiltered,
    swapOutFiltered,
    aggregatedBounties,
    tokenInfos,
    vlcvxRecipientSwapsInBlockNumbers
  );

  // Generate CSV files from the processed report
  const projectRoot = path.resolve(__dirname, "..", "..");
  const dirPath = path.join(
    projectRoot,
    "bounties-reports",
    currentPeriod.toString()
  );

  fs.mkdirSync(dirPath, { recursive: true });
  const formattedDate = new Date(currentPeriod * 1000).toLocaleDateString(
    "en-GB"
  );
  console.log("Generating reports for the week of:", formattedDate);

  // Generate CSV files for each protocol
  for (const [protocol, rows] of Object.entries(processedReport)) {
    const csvContent = [
      "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
      ...rows.map(
        (row) =>
          `${escapeCSV(row.gaugeName)};` +
          `${escapeCSV(row.gaugeAddress)};` +
          `${escapeCSV(row.rewardToken)};` +
          `${escapeCSV(row.rewardAddress)};` +
          `${row.rewardAmount.toFixed(6)};` +
          `${row.rewardSdValue.toFixed(6)};` +
          `${row.sharePercentage.toFixed(2)}`
      ),
    ].join("\n");

    // Write to file
    const fileName = `${protocol}.csv`;
    fs.writeFileSync(path.join(dirPath, fileName), csvContent);
    console.log(`Report generated for ${protocol}: ${fileName}`);
  }
}

main().catch(console.error);
