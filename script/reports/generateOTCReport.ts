import fs from "fs";
import path from "path";
import { createPublicClient, formatUnits, http, keccak256, encodePacked, parseAbi, decodeEventLog} from "viem";
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
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";

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

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

const explorerUtils = createBlockchainExplorerUtils();


async function fetchAllTokenInfos(
  allTokens: string[]
): Promise<Record<string, TokenInfo>> {
  const tokenInfos: Record<string, TokenInfo> = {};
  for (const token of allTokens) {
    tokenInfos[token.toLowerCase()] = await getTokenInfo(publicClient, token);
  }
  return tokenInfos;
}

interface ProcessedSwapEvent extends SwapEvent {
  formattedAmount: number;
  symbol: string;
}

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
    id: BigInt;
    withdrawer: string;
    amount: BigInt;
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
    const logWithBlockNumber = {
      id: decodedLog.args.id,
      withdrawer: decodedLog.args.withdrawer,
      amount: decodedLog.args.amount,
      block: Number(log.blockNumber),
    };

    decodedLogs.push(logWithBlockNumber);
  }

  // Initialize result object with protocol keys
  const result: Record<string, Bounty[]> = {
    curve: [],
    balancer: [],
    fxn: [],
    frax: []
  };

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

    const protocol = otcData[1].toLowerCase();
    const bounty: Bounty = {
      bountyId: id.toString(),
      gauge: otcData[3],
      amount: amount.toString(),
      rewardToken: otcData[2],
    };

    // Add to the appropriate protocol array
    if (result[protocol]) {
      result[protocol].push(bounty);
    } else {
      // If protocol not in predefined list, create it
      result[protocol] = [bounty];
    }
  }

  return result;
}

// TODO : Shared between all reports + one function
function processSwaps(
  swaps: SwapEvent[],
  tokenInfos: Record<string, TokenInfo>
): ProcessedSwapEvent[] {
  const seen = new Set<string>();

  return swaps
    .filter((swap) => swap.from.toLowerCase() != OTC_REGISTRY.toLowerCase())
    .filter((swap) => swap.from.toLowerCase() !== BOTMARKET.toLowerCase())
    .filter((swap) => swap.to.toLowerCase() !== GOVERNANCE.toLowerCase())
    .filter((swap) => swap.to.toLowerCase() !== BOSS.toLowerCase())
    .filter((swap) => {
      // Create unique key for each swap using blockNumber and logIndex
      const key = `${swap.blockNumber}-${swap.logIndex}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
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

function aggregateBounties(
  claimedBounties: ClaimedBounties
): Record<string, Bounty[]> {
  const protocols = ["curve", "balancer", "fxn", "frax"];
  const aggregated: Record<string, Bounty[]> = {};

  for (const protocol of protocols) {
    aggregated[protocol] = [
      ...Object.values(claimedBounties.votemarket[protocol] || {}),
      ...Object.values(claimedBounties.votemarket_v2[protocol] || {}),
      ...Object.values(claimedBounties.warden[protocol] || {}),
      ...Object.values(claimedBounties.hiddenhand[protocol] || {}),
    ];
  }

  return aggregated;
}

// TODO : Shared between all reports + one function
function processSwapsOTC(
  swaps: SwapEvent[],
  tokenInfos: Record<string, TokenInfo>
): ProcessedSwapEvent[] {
  const seen = new Set<string>();

  return swaps
    .filter((swap) => swap.from.toLowerCase() == OTC_REGISTRY.toLowerCase())
    .filter((swap) => {
      // Create unique key for each swap using blockNumber and logIndex
      const key = `${swap.blockNumber}-${swap.logIndex}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
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

function collectAllTokens(
  bounties: Record<string, Bounty[]>,
  protocols: typeof PROTOCOLS_TOKENS
): Set<string> {
  const allTokens = new Set<string>();

  Object.values(bounties).forEach((protocolBounties) =>
    protocolBounties.forEach((bounty) => allTokens.add(bounty.rewardToken))
  );

  allTokens.add(WETH_ADDRESS);

  Object.values(protocols).forEach((protocolInfo) => {
    allTokens.add(protocolInfo.native);
    allTokens.add(protocolInfo.sdToken);
  });

  return allTokens;
}

interface GaugeInfo {
  name: string;
  address: string;
}

function addGaugeNamesToBounties(
  bounties: Bounty[],
  gaugesInfo: GaugeInfo[]
): Bounty[] {
  const gaugeMap = new Map(
    gaugesInfo.map((g) => [g.address.toLowerCase(), g.name])
  );

  return bounties.map((bounty) => ({
    ...bounty,
    gaugeName: gaugeMap.get(bounty.gauge.toLowerCase()) || "UNKNOWN",
  }));
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

function escapeCSV(field: string): string {
  if (field.includes(";") || field.includes('"') || field.includes("\n")) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
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

  let aggregatedBounties = await fetchOTCWithdrawals(blockNumber1, blockNumber2);

  // Filter bounties for specific protocol
  aggregatedBounties = { [protocol]: aggregatedBounties[protocol] };

  // Collect tokens only for specified protocol
  const protocolTokens = { [protocol]: PROTOCOLS_TOKENS[protocol] };
  const allTokens = collectAllTokens(aggregatedBounties, protocolTokens);
  const tokenInfos = await fetchAllTokenInfos(Array.from(allTokens));

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

  const swapInFiltered = processSwapsOTC(swapIn, tokenInfos);
  const swapOutFiltered = processSwaps(swapOut, tokenInfos);

  // Get the block numbers where OTC swaps occurred
  const otcSwapBlocks = new Set(swapInFiltered.map(swap => swap.blockNumber));

  // Filter all swaps to only include those in OTC swap blocks
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

  // Filter all other swaps to only include those in OTC swap blocks
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

  // Merge all swaps
  const combinedSwapsIn = [...swapInFiltered, ...sdTokenSwapsIn, ...otherSwapsIn];
  const combinedSwapsOut = [...otherSwapsOut, ...sdTokenSwapsOut];

  // DROP DUPLICATES
  const uniqueSwapsOut = combinedSwapsOut.filter((swap, index, self) =>
    index === self.findIndex((t) => t.blockNumber === swap.blockNumber && t.logIndex === swap.logIndex)
  );

  const uniqueSwapsIn = combinedSwapsIn.filter((swap, index, self) =>
    index === self.findIndex((t) => t.blockNumber === swap.blockNumber && t.logIndex === swap.logIndex)
  );

  const swapsData: Record<string, Record<number, SwapData>> = {};

  for (const [key, protocolInfos] of Object.entries(PROTOCOLS_TOKENS)) {
    swapsData[key] = {};

    for (const swap of uniqueSwapsIn) {
      if (vlcvxRecipientSwapsInBlockNumbers.includes(swap.blockNumber)) {
        continue;
      }

      if (swap.token.toLowerCase() === protocolInfos.sdToken.toLowerCase()) {
        if (!swapsData[key][swap.blockNumber]) {
          swapsData[key][swap.blockNumber] = { sdTokenIn: [] };
        }
        swapsData[key][swap.blockNumber].sdTokenIn!.push(swap.formattedAmount);
      }
    }

    for (const swap of [...uniqueSwapsIn, ...uniqueSwapsOut]) {
      if (vlcvxRecipientSwapsInBlockNumbers.includes(swap.blockNumber)) {
        continue;
      }

      if (!swapsData[key][swap.blockNumber]) continue;

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

      if (uniqueSwapsIn.includes(swap)) {
        if (isNative) {
          swapsData[key][swap.blockNumber].nativeIn ??= [];
          swapsData[key][swap.blockNumber].nativeIn!.push(swap.formattedAmount);
        } else if (isWeth) {
          swapsData[key][swap.blockNumber].wethIn ??= [];
          swapsData[key][swap.blockNumber].wethIn!.push(swap.formattedAmount);
        }
      } else if (uniqueSwapsOut.includes(swap)) {
        if (isNative) {
          swapsData[key][swap.blockNumber].nativeOut ??= [];
          swapsData[key][swap.blockNumber].nativeOut!.push(
            swap.formattedAmount
          );
        } else if (isWeth) {
          swapsData[key][swap.blockNumber].wethOut ??= [];
          swapsData[key][swap.blockNumber].wethOut!.push(swap.formattedAmount);
        } else if (isSdToken) {
          swapsData[key][swap.blockNumber].sdTokenOut ??= [];
          swapsData[key][swap.blockNumber].sdTokenOut!.push(
            swap.formattedAmount
          );
        } else if (isReward) {
          swapsData[key][swap.blockNumber].rewardsOut ??= [];
          if (
            !swapsData[key][swap.blockNumber].rewardsOut!.some(
              (r) => r.token === swap.token && r.amount === swap.formattedAmount
            )
          ) {
            swapsData[key][swap.blockNumber].rewardsOut!.push({
              token: swap.token,
              symbol: swap.symbol!,
              amount: swap.formattedAmount,
            });
          }
        }
      }
    }
  }

  const allMatches = Object.entries(swapsData).flatMap(([protocol, blocks]) =>
    Object.entries(blocks).flatMap(([blockNumber, blockData]) => {
      const matches = matchWethInWithRewardsOut(blockData);
      return matches.length > 0
        ? [{ protocol, blockNumber: parseInt(blockNumber), matches }]
        : [];
    })
  );

  const orderedData = allMatches.reduce((acc: ProtocolData, item) => {
    const { protocol, blockNumber, matches } = item;
    if (!acc[protocol]) acc[protocol] = [];
    acc[protocol].push({ blockNumber, matches });
    return acc;
  }, {} as ProtocolData);

  interface TokenInfo {
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
    tokens: TokenInfo[];
  }

  const protocolSummaries: ProtocolSummary[] = [];

  // Filter out blocks that don't has any "sdTokenOut"
  for (const [protocol, blocks] of Object.entries(swapsData)) {
    for (const [blockNumber, blockData] of Object.entries(blocks)) {
      if (!blockData.sdTokenOut || blockData.sdTokenOut.length === 0) {
        delete swapsData[protocol][parseInt(blockNumber)];
      }
    }
  }

  for (const [protocol, blocks] of Object.entries(swapsData)) {
    let totalWethOut = 0;
    let totalWethIn = 0;
    let totalNativeOut = 0;
    let totalNativeIn = 0;
    let totalSdTokenOut = 0;
    let totalSdTokenIn = 0;
    const tokenMap: { [address: string]: TokenInfo } = {};

    for (const block of Object.values(blocks)) {
      // Sum up totals
      totalWethOut += (block.wethOut || []).reduce(
        (sum, amount) => sum + amount,
        0
      );
      totalWethIn += (block.wethIn || []).reduce(
        (sum, amount) => sum + amount,
        0
      );
      totalSdTokenOut += (block.sdTokenOut || []).reduce(
        (sum, amount) => sum + amount,
        0
      );
      totalSdTokenIn += (block.sdTokenIn || []).reduce(
        (sum, amount) => sum + amount,
        0
      );
      totalNativeOut += (block.nativeOut || []).reduce(
        (sum, amount) => sum + amount,
        0
      );
      totalNativeIn += (block.nativeIn || []).reduce(
        (sum, amount) => sum + amount,
        0
      );
    }

    // Get token info from orderedData
    const protocolData = orderedData[protocol] || [];
    for (const blockData of protocolData) {
      for (const match of blockData.matches) {
        if (!tokenMap[match.address]) {
          tokenMap[match.address] = { ...match, amount: 0, weth: 0 };
        }
        tokenMap[match.address].amount += match.amount;
        tokenMap[match.address].weth += match.weth;
      }
    }

    protocolSummaries.push({
      protocol,
      totalWethOut,
      totalWethIn,
      totalNativeOut,
      totalNativeIn,
      totalSdTokenOut,
      totalSdTokenIn,
      tokens: Object.values(tokenMap),
    });
  }

  Object.entries(aggregatedBounties).forEach(([protocol, bounties]) => {
    const native = PROTOCOLS_TOKENS[protocol].native.toLowerCase();
    const sdToken = PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase();

    const protocolSummary = protocolSummaries.find(
      (p) => p.protocol === protocol
    );
    if (!protocolSummary) {
      console.warn(`No summary found for protocol ${protocol}`);
      return;
    }

    const {
      totalNativeIn,
      totalNativeOut,
      totalWethIn,
      totalWethOut,
      totalSdTokenIn,
      totalSdTokenOut,
    } = protocolSummary;

    // Ratios
    const wethToNativeRatio = totalNativeOut / totalWethIn;

    console.log("totalNativeIn", totalNativeIn);
    console.log("totalWethOut", totalWethOut);
    console.log("wethToNativeRatio", wethToNativeRatio);

    let totalShares = 0;

    // First pass: calculate shares
    bounties.forEach((bounty: any) => {
      const rewardToken = bounty.rewardToken.toLowerCase();
      const tokenInfo = tokenInfos[rewardToken];
      const formattedAmount =
        Number(bounty.amount) / 10 ** (tokenInfo?.decimals || 18);

      let share = 0;

      console.log("rewardToken", rewardToken);
      console.log("formattedAmount", formattedAmount);
      console.log("totalNativeOut", totalNativeOut);

      if (rewardToken === native) {
        console.log("formattedAmount", formattedAmount);
        share = formattedAmount / totalNativeOut;
      } else if (rewardToken === sdToken) {
        // No action needed for sdToken, share remains 0
      } else if (rewardToken === WETH_ADDRESS.toLowerCase()) {
        const nativeAmount = formattedAmount * wethToNativeRatio;
        console.log("formattedAmount", formattedAmount);
        console.log("nativeAmount for the WETH", nativeAmount);
        share = nativeAmount / totalNativeOut;
      } else {
        const tokenSummary = protocolSummary.tokens.find(
          (t) => t.address.toLowerCase() === rewardToken
        );
        if (tokenSummary) {
          const localShare = formattedAmount / tokenSummary.amount;
          const wethAmount = tokenSummary.weth * localShare;
          const nativeAmount = wethAmount * wethToNativeRatio;
          share = nativeAmount / totalNativeOut;
        }
      }

      bounty.share = share;
      totalShares += share;
    });

    console.log("totalShares", totalShares);

    // Second pass: normalize shares and calculate SD token amounts
    bounties.forEach((bounty: any) => {
      // In case of sdToken, put value directly. Shares computed after with the total sum
      if (bounty.rewardToken.toLowerCase() === sdToken) {
        const tokenInfo = tokenInfos[bounty.rewardToken];
        const formattedAmount =
          Number(bounty.amount) / 10 ** (tokenInfo?.decimals || 18);
        bounty.sdTokenAmount = formattedAmount;
      } else {
        bounty.normalizedShare = bounty.share / totalShares;

        bounty.sdTokenAmount = bounty.normalizedShare * totalSdTokenIn;
      }
    });

    // Need to pass one last time, now that we have all sdToken values, to get real shares
    const totalSdTokenAmount = bounties.reduce((acc, bounty) => {
      return acc + (bounty.sdTokenAmount || 0);
    }, 0);

    bounties.forEach((bounty: any) => {
      bounty.share = bounty.sdTokenAmount / totalSdTokenAmount;
    });
  });

  // Merge
  const mergedRows: { [key: string]: CSVRow } = {};

  Object.entries(aggregatedBounties).forEach(([protocol, bounties]) => {
    bounties.forEach((bounty: any) => {
      const rewardToken = bounty.rewardToken.toLowerCase();
      const tokenInfo = tokenInfos[rewardToken];
      const formattedAmount =
        Number(bounty.amount) / 10 ** (tokenInfo?.decimals || 18);

      // Create a unique key for each combination of protocol, gauge address, and reward address
      const key = `${protocol}-${bounty.gauge.toLowerCase()}-${rewardToken}`;

      if (mergedRows[key]) {
        // If this combination already exists, add to its values
        mergedRows[key].rewardAmount += formattedAmount;
        mergedRows[key].rewardSdValue += bounty.sdTokenAmount;
        mergedRows[key].sharePercentage += bounty.share * 100; // Convert share to percentage
      } else {
        // If this is a new combination, create a new entry
        mergedRows[key] = {
          protocol,
          gaugeName: bounty.gaugeName || "Unknown",
          gaugeAddress: bounty.gauge,
          rewardToken: tokenInfo?.symbol || "Unknown",
          rewardAddress: bounty.rewardToken,
          rewardAmount: formattedAmount,
          rewardSdValue: bounty.sdTokenAmount,
          sharePercentage: bounty.share * 100, // Convert share to percentage
        };
      }
    });
  });

  // Group merged rows by protocol
  const groupedRows: { [protocol: string]: CSVRow[] } = {};
  Object.values(mergedRows).forEach((row) => {
    if (!groupedRows[row.protocol]) {
      groupedRows[row.protocol] = [];
    }
    groupedRows[row.protocol].push(row);
  });

  // Drop lines where no rewardSdValue (= 0)
  Object.values(groupedRows).forEach((rows) => {
    rows.filter((row) => row.rewardSdValue > 0);
  });

  // Create directory if it doesn't exist
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
  for (const [protocol, rows] of Object.entries(groupedRows)) {
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
    const fileName = `${protocol}_bis.csv`;
    fs.writeFileSync(path.join(dirPath, fileName), csvContent);
    console.log(`Report generated for ${protocol}: ${fileName}`);
  }

  return;
}

main().catch(console.error);
