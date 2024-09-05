import fs from "fs";
import { parse } from "csv-parse/sync";
import path from "path";
import { getLogsByAddressAndTopics } from "../utils/etherscanUtils";
import {
  createPublicClient,
  formatUnits,
  http,
  getAddress,
  parseAbiItem,
  decodeEventLog,
  parseAbi,
  keccak256,
  encodePacked,
} from "viem";
import { mainnet } from "viem/chains";
import {
  getTimestampsBlocks,
  PROTOCOLS_TOKENS,
  getTokenInfo,
  getGaugesInfos,
  fetchSwapInEvents,
  fetchSwapOutEvents,
} from "../utils/reportUtils";
import {
  OTC_REGISTRY,
  BOTMARKET,
  ALL_MIGHT,
  WETH_ADDRESS,
} from "../utils/reportUtils";

import dotenv from "dotenv";

dotenv.config();

const WEEK = 604800;
const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

interface OTCWithdrawal {
  protocol: string;
  rewardToken: string;
  amount: number;
  gaugeAddress: string;
  chainId: number;
  blockNumber: number;
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

interface ProcessedSwapEvent {
  blockNumber: number;
  logIndex: number;
  from: string;
  to: string;
  token: string;
  amount: bigint;
  formattedAmount: number;
  symbol: string;
}

async function fetchOTCWithdrawals(
  fromBlock: number,
  toBlock: number
): Promise<OTCWithdrawal[]> {
  const eventSignature = "OTCWithdrawn(uint256,address,uint256)";
  const otcWithdrawnHash = keccak256(
    encodePacked(["string"], [eventSignature])
  );

  const otcWitdrawnAbi = parseAbi([
    "event OTCWithdrawn(uint256 id, address withdrawer, uint256 amount)",
  ]);

  let decodedLogs: {
    id: BigInt;
    withdrawer: string;
    amount: BigInt;
    block: number;
  }[] = [];

  const response = await getLogsByAddressAndTopics(
    OTC_REGISTRY,
    fromBlock,
    toBlock,
    { "0": otcWithdrawnHash }
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
    const logWithBlockNumber = {
      id: decodedLog.args.id,
      withdrawer: decodedLog.args.withdrawer,
      amount: decodedLog.args.amount,
      block: Number(log.blockNumber),
    };

    decodedLogs.push(logWithBlockNumber);
  }

  let OTCWithdrawals: OTCWithdrawal[] = [];

  // Fetch OTC Data from contract
  for (const decoded of decodedLogs) {
    const { id, withdrawer, amount, block } = decoded;
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

    OTCWithdrawals.push({
      protocol: otcData[1],
      rewardToken: otcData[2],
      amount: Number(amount),
      gaugeAddress: otcData[3],
      chainId: Number(otcData[4]),
      blockNumber: block,
    });
  }

  return OTCWithdrawals;
}

async function fetchSwaps(
  otcWithdrawals: OTCWithdrawal[],
  allTokens: Set<string>
) {
  const uniqueBlocks = [...new Set(otcWithdrawals.map((w) => w.blockNumber))];
  const minBlock = Math.min(...uniqueBlocks);
  const maxBlock = Math.max(...uniqueBlocks);

  const swapIn = await fetchSwapInEvents(
    "ethereum",
    minBlock,
    maxBlock,
    Array.from(allTokens),
    ALL_MIGHT
  );
  const swapOut = await fetchSwapOutEvents(
    "ethereum",
    minBlock,
    maxBlock,
    Array.from(allTokens),
    ALL_MIGHT
  );

  return { swapIn, swapOut };
}

function processSwaps(
  swaps: any[],
  tokenInfos: Record<string, any>
): ProcessedSwapEvent[] {
  return swaps
    .filter((swap) => swap.from.toLowerCase() !== BOTMARKET.toLowerCase())
    .filter((swap) => swap.from.toLowerCase() !== OTC_REGISTRY.toLowerCase())
    .map((swap) => {
      const tokenInfo = tokenInfos[swap.token.toLowerCase()];
      let formattedAmount: number;
      if (!tokenInfo) {
        console.warn(
          `No info found for token ${swap.token}. Using 18 decimals as default.`
        );
        formattedAmount = Number(formatUnits(swap.amount, 18));
      } else {
        formattedAmount = Number(formatUnits(swap.amount, tokenInfo.decimals));
      }
      return {
        ...swap,
        formattedAmount,
        symbol: tokenInfo?.symbol || "UNKNOWN",
      };
    });
}

async function main() {
  const { timestamp1, timestamp2, blockNumber1, blockNumber2 } =
    await getTimestampsBlocks(publicClient, 0);

  const otcWithdrawals = await fetchOTCWithdrawals(blockNumber1, blockNumber2);

  const csvData: Record<string, any[]> = {};

  console.log("OTC Withdrawals:");
  console.log(otcWithdrawals);

  // Collect all tokens
  const allTokens = new Set<string>();
  otcWithdrawals.forEach((withdrawal) => {
    allTokens.add(withdrawal.rewardToken);
    const protocolInfo = PROTOCOLS_TOKENS[withdrawal.protocol.toLowerCase()];
    if (protocolInfo) {
      allTokens.add(protocolInfo.native);
      allTokens.add(protocolInfo.sdToken);
    }
  });
  allTokens.add(WETH_ADDRESS);

  const tokenInfos = await fetchAllTokenInfos(Array.from(allTokens));

  const { swapIn, swapOut } = await fetchSwaps(otcWithdrawals, allTokens);

  const swapInFiltered = processSwaps(swapIn, tokenInfos);
  const swapOutFiltered = processSwaps(swapOut, tokenInfos);

  const swapsData: Record<string, Record<number, SwapData>> = {};

  for (const withdrawal of otcWithdrawals) {
    const protocol = withdrawal.protocol.toLowerCase();
    if (!swapsData[protocol]) swapsData[protocol] = {};

    const protocolInfos = PROTOCOLS_TOKENS[protocol];
    if (!protocolInfos) continue;

    const blockNumber = withdrawal.blockNumber;

    if (!swapsData[protocol][blockNumber]) {
      swapsData[protocol][blockNumber] = {};
    }

    // Process swaps for this block
    for (const swap of [...swapInFiltered, ...swapOutFiltered].filter(
      (s) => s.blockNumber === blockNumber
    )) {
      const isNative =
        swap.token.toLowerCase() === protocolInfos.native.toLowerCase();
      const isWeth = swap.token.toLowerCase() === WETH_ADDRESS.toLowerCase();
      const isSdToken =
        swap.token.toLowerCase() === protocolInfos.sdToken.toLowerCase();
      const isReward = ![
        WETH_ADDRESS,
        protocolInfos.native,
        protocolInfos.sdToken,
      ].includes(swap.token.toLowerCase());

      if (swapInFiltered.includes(swap)) {
        if (isNative) {
          swapsData[protocol][blockNumber].nativeIn ??= [];
          swapsData[protocol][blockNumber].nativeIn!.push(swap.formattedAmount);
        } else if (isWeth) {
          swapsData[protocol][blockNumber].wethIn ??= [];
          swapsData[protocol][blockNumber].wethIn!.push(swap.formattedAmount);
        } else if (isSdToken) {
          swapsData[protocol][blockNumber].sdTokenIn ??= [];
          swapsData[protocol][blockNumber].sdTokenIn!.push(
            swap.formattedAmount
          );
        }
      } else if (swapOutFiltered.includes(swap)) {
        if (isNative) {
          swapsData[protocol][blockNumber].nativeOut ??= [];
          swapsData[protocol][blockNumber].nativeOut!.push(
            swap.formattedAmount
          );
        } else if (isWeth) {
          swapsData[protocol][blockNumber].wethOut ??= [];
          swapsData[protocol][blockNumber].wethOut!.push(swap.formattedAmount);
        } else if (isSdToken) {
          swapsData[protocol][blockNumber].sdTokenOut ??= [];
          swapsData[protocol][blockNumber].sdTokenOut!.push(
            swap.formattedAmount
          );
        } else if (isReward) {
          swapsData[protocol][blockNumber].rewardsOut ??= [];
          if (
            !swapsData[protocol][blockNumber].rewardsOut!.some(
              (r) => r.token === swap.token && r.amount === swap.formattedAmount
            )
          ) {
            swapsData[protocol][blockNumber].rewardsOut!.push({
              token: swap.token,
              symbol: swap.symbol!,
              amount: swap.formattedAmount,
            });
          }
        }
      }
    }
  }

  // Process the swaps data and compute shares
  for (const [protocol, blocks] of Object.entries(swapsData)) {
    const protocolInfos = PROTOCOLS_TOKENS[protocol];

    const gaugesInfo = await getGaugesInfos(protocol);

    if (!protocolInfos) continue;

    let totalWethOut = 0;
    let totalNativeIn = 0;
    let totalSdTokenIn = 0;

    for (const blockData of Object.values(blocks)) {
      totalWethOut += (blockData.wethOut || []).reduce(
        (sum, amount) => sum + amount,
        0
      );
      totalNativeIn += (blockData.nativeIn || []).reduce(
        (sum, amount) => sum + amount,
        0
      );
      totalSdTokenIn += (blockData.sdTokenIn || []).reduce(
        (sum, amount) => sum + amount,
        0
      );
    }

    const wethToNativeRatio = totalNativeIn / totalWethOut;

    for (const withdrawal of otcWithdrawals.filter(
      (w) => w.protocol.toLowerCase() === protocol
    )) {
      const rewardToken = withdrawal.rewardToken.toLowerCase();
      const tokenInfo = tokenInfos[rewardToken];
      const formattedAmount = parseFloat(
        formatUnits(BigInt(withdrawal.amount), tokenInfo?.decimals || 18)
      );
      let sdTokenAmount: number;

      if (rewardToken === protocolInfos.sdToken.toLowerCase()) {
        sdTokenAmount = formattedAmount;
      } else if (rewardToken === WETH_ADDRESS.toLowerCase()) {
        const nativeAmount = formattedAmount * wethToNativeRatio;
        sdTokenAmount = (nativeAmount / totalNativeIn) * totalSdTokenIn;
      } else if (rewardToken === protocolInfos.native.toLowerCase()) {
        sdTokenAmount = (formattedAmount / totalNativeIn) * totalSdTokenIn;
      } else {
        // For other reward tokens, we need to find the corresponding WETH amount from the swaps
        const blockData = blocks[withdrawal.blockNumber];
        const match = blockData.rewardsOut?.find(
          (r) => r.token.toLowerCase() === rewardToken
        );
        if (match) {
          const localShare = formattedAmount / match.amount;
          const wethAmount = blockData.wethIn?.[0] || 0; // Assuming there's only one WETH in per block
          const nativeAmount = wethAmount * wethToNativeRatio * localShare;
          sdTokenAmount = (nativeAmount / totalNativeIn) * totalSdTokenIn;
        } else {
          console.warn(
            `No match found for reward token ${rewardToken} in block ${withdrawal.blockNumber}`
          );
          sdTokenAmount = 0;
        }
      }

      const gauge = gaugesInfo.find(
        (g) => g.address.toLowerCase() === withdrawal.gaugeAddress.toLowerCase()
      );

      if (!csvData[protocol]) csvData[protocol] = [];
      csvData[protocol].push({
        gaugeName: gauge ? gauge.name : "Unknown",
        gaugeAddress: withdrawal.gaugeAddress,
        rewardToken: tokenInfo?.symbol || "Unknown",
        rewardAddress: withdrawal.rewardToken,
        rewardAmount: formattedAmount,
        rewardSdValue: sdTokenAmount,
        sharePercentage: 0,
      });
    }
  }

  const projectRoot = path.resolve(__dirname, ".."); // Go up one level from the script directory
  const dirPath = path.join(
    projectRoot,
    "bounties-reports",
    currentPeriod.toString()
  );

  for (const [protocol, data] of Object.entries(csvData)) {
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

    // Convert currentCsvData to a dictionary for easier lookup and modification
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

async function fetchAllTokenInfos(
  allTokens: string[]
): Promise<Record<string, any>> {
  const tokenInfos: Record<string, any> = {};
  for (const token of allTokens) {
    tokenInfos[token.toLowerCase()] = await getTokenInfo(publicClient, token);
  }
  return tokenInfos;
}

main().catch(console.error);
