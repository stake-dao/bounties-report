import fs from "fs";
import path from "path";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import dotenv from "dotenv";
import {
  getTimestampsBlocks,
  fetchSwapInEvents,
  fetchSwapOutEvents,
  PROTOCOLS_TOKENS,
  processSwapsOTC,
  aggregateBounties,
  collectAllTokens,
  fetchAllTokenInfos,
  processSwaps,
  escapeCSV,
  addGaugeNamesToBounties,
  getGaugesInfos,
} from "../utils/reportUtils";
import { ALL_MIGHT } from "../utils/reportUtils";
import { VLCVX_DELEGATORS_RECIPIENT } from "../utils/constants";
import processReport from "./reportCommon";

dotenv.config();

const WEEK = 604800;
const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

// Only keep interfaces used in this file
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
  votemarket: Record<string, any>;
  votemarket_v2: Record<string, any>;
  warden: Record<string, any>;
  hiddenhand: Record<string, any>;
}

/**
 * Reads claimed bounties from JSON files and filters the v2 bounties.
 */
async function fetchBountiesData(
  currentPeriod: number
): Promise<ClaimedBounties> {
  const paths = {
    votemarket: `weekly-bounties/${currentPeriod}/votemarket/claimed_bounties.json`,
    votemarket_v2: `weekly-bounties/${currentPeriod}/votemarket-v2/claimed_bounties.json`,
    warden: `weekly-bounties/${currentPeriod}/warden/claimed_bounties.json`,
    hiddenhand: `weekly-bounties/${currentPeriod}/hiddenhand/claimed_bounties.json`,
  };

  const readJsonFile = (filePath: string) => {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      console.warn(`Warning: Could not read ${filePath}`, error);
      return {};
    }
  };

  const votemarket = readJsonFile(paths.votemarket);
  const votemarket_v2 = readJsonFile(paths.votemarket_v2);
  const warden = readJsonFile(paths.warden);
  const hiddenhand = readJsonFile(paths.hiddenhand);

  // Filter out v2 bounties that are explicitly unwrapped
  const filteredV2 = Object.entries(votemarket_v2).reduce(
    (acc, [key, value]: [string, any]) => {
      if (value.isWrapped !== false) {
        acc[key] = value;
      }
      return acc;
    },
    {} as Record<string, any>
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

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

async function main() {
  // Validate protocol argument
  const protocol = process.argv[2];
  if (!protocol || !["curve", "balancer", "fxn", "frax"].includes(protocol)) {
    console.error(
      "Please specify a valid protocol: curve, balancer, fxn, or frax"
    );
    process.exit(1);
  }

  // Get block numbers and timestamps (timestamps are not used later)
  const { blockNumber1, blockNumber2 } = await getTimestampsBlocks(
    publicClient,
    0
  );

  const totalBounties = await fetchBountiesData(currentPeriod);
  let aggregatedBounties = aggregateBounties(totalBounties);
  // Keep bounties only for the specified protocol
  aggregatedBounties = { [protocol]: aggregatedBounties[protocol] };

  // Collect tokens and fetch their info
  const protocolTokens = { [protocol]: PROTOCOLS_TOKENS[protocol] };
  const allTokens = collectAllTokens(aggregatedBounties, protocolTokens);
  const tokenInfos = await fetchAllTokenInfos(
    Array.from(allTokens),
    publicClient
  );

  // Fetch gauge infos and add gauge names to bounties
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

  // Get blocks to exclude for vlCVX recipient swaps
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

  // Process swaps and filter out OTC swaps by block number
  const swapOTC = processSwapsOTC(swapIn, tokenInfos);
  let swapInFiltered = processSwaps(swapIn, tokenInfos);
  let swapOutFiltered = processSwaps(swapOut, tokenInfos);

  swapInFiltered = swapInFiltered.filter(
    (swap) =>
      !swapOTC.some((otcSwap) => otcSwap.blockNumber === swap.blockNumber)
  );
  swapOutFiltered = swapOutFiltered.filter(
    (swap) =>
      !swapOTC.some((otcSwap) => otcSwap.blockNumber === swap.blockNumber)
  );

  const processedReport = processReport(
    1,
    swapInFiltered,
    swapOutFiltered,
    aggregatedBounties,
    tokenInfos,
    vlcvxRecipientSwapsInBlockNumbers
  );

  // Generate CSV reports in the designated directory
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

  for (const [protocol, rows] of Object.entries(processedReport)) {
    const csvContent = [
      "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
      ...rows.map(
        (row) =>
          `${escapeCSV(row.gaugeName)};${escapeCSV(
            row.gaugeAddress
          )};${escapeCSV(row.rewardToken)};` +
          `${escapeCSV(row.rewardAddress)};${row.rewardAmount.toFixed(
            6
          )};${row.rewardSdValue.toFixed(6)};` +
          `${row.sharePercentage.toFixed(2)}`
      ),
    ].join("\n");

    const fileName = `${protocol}.csv`;
    fs.writeFileSync(path.join(dirPath, fileName), csvContent);
    console.log(`Report generated for ${protocol}: ${fileName}`);
  }
}

main().catch(console.error);
