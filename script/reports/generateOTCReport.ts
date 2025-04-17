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
  getGaugesInfos,
  processSwapsOTC,
  processSwaps,
  collectAllTokens,
  addGaugeNamesToBounties,
  fetchAllTokenInfos,
} from "../utils/reportUtils";
import { ALL_MIGHT, OTC_REGISTRY } from "../utils/reportUtils";
import { VLCVX_DELEGATORS_RECIPIENT } from "../utils/constants";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";
import processReport from "./reportCommon";
import { parse } from "csv-parse/sync"; // Assumes you use csv-parse for CSV parsing

dotenv.config();

const WEEK = 604800;
const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

// Keep only interfaces needed in this file
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

/**
 * Fetch OTC withdrawals by decoding event logs from the explorer.
 */
async function fetchOTCWithdrawals(
  fromBlock: number,
  toBlock: number
): Promise<Record<string, Bounty[]>> {
  const eventSignature = "OTCWithdrawn(uint256,address,uint256)";
  const otcWithdrawnHash = keccak256(encodePacked(["string"], [eventSignature]));
  const otcWithdrawnAbi = parseAbi([
    "event OTCWithdrawn(uint256 id, address withdrawer, uint256 amount)",
  ]);

  const explorerUtils = createBlockchainExplorerUtils();
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

  const decodedLogs: { id: bigint; withdrawer: string; amount: bigint; block: number }[] = [];
  for (const log of response.result) {
    const decodedLog = decodeEventLog({
      abi: otcWithdrawnAbi,
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

  // For each log, fetch detailed OTC data from the contract and store it under its protocol
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

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

async function main() {
  // Validate protocol argument
  const protocol = process.argv[2];
  if (!protocol || !["curve", "balancer", "fxn", "frax", "pendle"].includes(protocol)) {
    console.error("Please specify a valid protocol: curve, balancer, fxn, frax, or pendle");
    process.exit(1);
  }

  // Get block numbers
  const { blockNumber1, blockNumber2 } = await getTimestampsBlocks(publicClient, 0);

  let aggregatedBounties = await fetchOTCWithdrawals(blockNumber1, blockNumber2);
  // Filter bounties for the specified protocol
  aggregatedBounties = { [protocol]: aggregatedBounties[protocol] };

  // Collect tokens and fetch their info
  const protocolTokens = { [protocol]: PROTOCOLS_TOKENS[protocol] };
  const allTokens = collectAllTokens(aggregatedBounties, protocolTokens);
  const tokenInfos = await fetchAllTokenInfos(Array.from(allTokens), publicClient);

  // Get gauge infos and attach gauge names
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
    case "pendle":
      gaugesInfo = await getGaugesInfos("pendle");
      break;
  }
  aggregatedBounties = { [protocol]: addGaugeNamesToBounties(aggregatedBounties[protocol], gaugesInfo ?? []) };


  // Replace gauge address per root gauge address (if curve + is root gauge + != root gauge and gauge is not root gauge)

  for (const bounty of aggregatedBounties[protocol]) {
    if (protocol === "curve") {
      const gaugeInfo = gaugesInfo?.find(gauge => gauge.address.toLowerCase() === bounty.gauge.toLowerCase() || gauge.rootGauge?.toLowerCase() === bounty.gauge.toLowerCase());
      if (gaugeInfo) {
        bounty.gauge = gaugeInfo.address;
        bounty.gaugeName = gaugeInfo.name;
      }
    }
  }

  // Fetch swap events
  const swapIn = await fetchSwapInEvents(1, blockNumber1, blockNumber2, Array.from(allTokens), ALL_MIGHT);
  const swapOut = await fetchSwapOutEvents(1, blockNumber1, blockNumber2, Array.from(allTokens), ALL_MIGHT);

  const vlcvxRecipientSwapsIn = await fetchSwapInEvents(
    1,
    blockNumber1,
    blockNumber2,
    [PROTOCOLS_TOKENS.curve.sdToken],
    VLCVX_DELEGATORS_RECIPIENT
  );
  const vlcvxRecipientSwapsInBlockNumbers = vlcvxRecipientSwapsIn.map(swap => swap.blockNumber);
  console.log("vlCVX recipient blocks to exclude:", vlcvxRecipientSwapsInBlockNumbers);

  const swapInFiltered = processSwapsOTC(swapIn, tokenInfos);

  // Identify OTC swap blocks to filter for further processing
  const otcSwapBlocks = new Set(swapInFiltered.map(swap => swap.blockNumber));

  // Process sdToken swaps
  const sdTokenSwapsIn = processSwaps(
    swapIn.filter(swap =>
      swap.token.toLowerCase() === PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase() &&
      otcSwapBlocks.has(swap.blockNumber)
    ),
    tokenInfos
  );
  const sdTokenSwapsOut = processSwaps(
    swapOut.filter(swap =>
      swap.token.toLowerCase() === PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase() &&
      otcSwapBlocks.has(swap.blockNumber)
    ),
    tokenInfos
  );

  // Process remaining swaps
  const otherSwapsIn = processSwaps(
    swapIn.filter(swap =>
      swap.token.toLowerCase() !== PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase() &&
      swap.from.toLowerCase() !== OTC_REGISTRY.toLowerCase() &&
      otcSwapBlocks.has(swap.blockNumber)
    ),
    tokenInfos
  );
  const otherSwapsOut = processSwaps(
    swapOut.filter(swap => otcSwapBlocks.has(swap.blockNumber)),
    tokenInfos
  );

  // Merge and deduplicate swaps
  const combinedSwapsIn = [...swapInFiltered, ...sdTokenSwapsIn, ...otherSwapsIn];
  const combinedSwapsOut = [...otherSwapsOut, ...sdTokenSwapsOut];
  const uniqueSwapsIn = combinedSwapsIn.filter((swap, index, self) =>
    index === self.findIndex(t => t.blockNumber === swap.blockNumber && t.logIndex === swap.logIndex)
  );
  const uniqueSwapsOut = combinedSwapsOut.filter((swap, index, self) =>
    index === self.findIndex(t => t.blockNumber === swap.blockNumber && t.logIndex === swap.logIndex)
  );

  const processedReport = processReport(
    uniqueSwapsIn,
    uniqueSwapsOut,
    aggregatedBounties,
    tokenInfos,
    vlcvxRecipientSwapsInBlockNumbers
  );

  // Write updated CSV reports
  const projectRoot = path.resolve(__dirname, "..", "..");
  const dirPath = path.join(projectRoot, "bounties-reports", currentPeriod.toString());

  for (const [protocol, data] of Object.entries(processedReport)) {
    // Special handling for Pendle - create a separate OTC file
    if (protocol === "pendle") {
      const fileName = `${protocol}-otc.csv`;
      const filePath = path.join(dirPath, fileName);
      
      // Create rows with current period
      const rows = data.map(row => ({
        "Period": currentPeriod.toString(),
        "Gauge Name": row.gaugeName,
        "Gauge Address": row.gaugeAddress,
        "Reward Token": row.rewardToken,
        "Reward Address": row.rewardAddress,
        "Reward Amount": row.rewardAmount.toString(),
        "Reward sd Value": row.rewardSdValue.toString(),
        "Share % per Protocol": "0", // To be computed
      }));
      
      // Calculate percentages
      const totalRewardSdValue = rows.reduce(
        (sum, row) => sum + parseFloat(row["Reward sd Value"]),
        0
      );
      
      for (const row of rows) {
        row["Share % per Protocol"] = ((parseFloat(row["Reward sd Value"]) / totalRewardSdValue) * 100).toFixed(2);
      }
      
      // Generate CSV content
      const csvContent = [
        "Period;Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
        ...rows.map(row => 
          `${row.Period};${row["Gauge Name"]};${row["Gauge Address"]};${row["Reward Token"]};${row["Reward Address"]};` +
          `${parseFloat(row["Reward Amount"]).toFixed(6)};${parseFloat(row["Reward sd Value"]).toFixed(6)};` +
          `${row["Share % per Protocol"]}`
        )
      ].join("\n");
      
      fs.writeFileSync(filePath, csvContent);
      console.log(`Created OTC report for ${protocol}: ${filePath}`);
      continue; // Skip the rest of the loop for Pendle
    }

    // For other protocols, continue with the existing logic
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
      console.log(`No existing file found for ${protocol}. Creating a new one.`);
    }

    const newGaugeAddresses = new Set(data.map(row => row.gaugeAddress.toLowerCase()));
    
    currentCsvData = currentCsvData.filter(row => {
      const isNewGauge = newGaugeAddresses.has(row["Gauge Address"].toLowerCase());
      const hasZeroSdValue = parseFloat(row["Reward sd Value"]) === 0;
      return !(isNewGauge && hasZeroSdValue);
    });

    const currentCsvDict = currentCsvData.reduce((acc, row) => {
      const key = `${row["Gauge Address"]}-${row["Reward Address"]}`;
      acc[key] = row;
      return acc;
    }, {} as Record<string, any>);

    for (const newRow of data) {
      const key = `${newRow.gaugeAddress}-${newRow.rewardAddress}`;
      
      if (currentCsvDict[key]) {
        currentCsvDict[key]["Reward Amount"] =
          (parseFloat(currentCsvDict[key]["Reward Amount"]) + newRow.rewardAmount).toString();
        currentCsvDict[key]["Reward sd Value"] =
          (parseFloat(currentCsvDict[key]["Reward sd Value"]) + newRow.rewardSdValue).toString();
      } else {
        currentCsvDict[key] = {
          "Gauge Name": newRow.gaugeName,
          "Gauge Address": newRow.gaugeAddress,
          "Reward Token": newRow.rewardToken,
          "Reward Address": newRow.rewardAddress,
          "Reward Amount": newRow.rewardAmount.toString(),
          "Reward sd Value": newRow.rewardSdValue.toString(),
          "Share % per Protocol": "0", // To be recomputed
        };
      }
    }

    const totalRewardSdValue = Object.values(currentCsvDict).reduce(
      (sum: number, row: any) => sum + parseFloat(row["Reward sd Value"]),
      0
    );

    for (const key in currentCsvDict) {
      const row = currentCsvDict[key];
      row["Share % per Protocol"] = ((parseFloat(row["Reward sd Value"]) / totalRewardSdValue) * 100).toFixed(2);
    }

    const updatedCsvData = Object.values(currentCsvDict);
    const csvContent = [
      "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
      ...updatedCsvData.map((row: any) =>
        `${row["Gauge Name"]};${row["Gauge Address"]};${row["Reward Token"]};${row["Reward Address"]};` +
        `${parseFloat(row["Reward Amount"]).toFixed(6)};${parseFloat(row["Reward sd Value"]).toFixed(6)};` +
        `${row["Share % per Protocol"]}`
      )
    ].join("\n");

    fs.writeFileSync(filePath, csvContent);
    console.log(`Updated report for ${protocol}: ${filePath}`);
  }
}

main().catch(console.error);
