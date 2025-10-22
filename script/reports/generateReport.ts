import fs from "fs";
import path from "path";
import { createPublicClient, http } from "viem";
import { mainnet } from "../utils/chains";
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
  matchWethInWithRewardsOut,
  mapTokenSwapsToOutToken,
} from "../utils/reportUtils";
import { ALL_MIGHT } from "../utils/reportUtils";
import { VLCVX_DELEGATORS_RECIPIENT } from "../utils/constants";
import processReport from "./processReport";
import { debug, sampleArray, isDebugEnabled } from "../utils/logger";
import { WETH_CHAIN_IDS } from "../utils/constants";

dotenv.config();

const WEEK = 604800;
const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

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

// Define raw tokens that should be distributed as-is without wrapping
const RAW_TOKENS = new Set([
  "0x4DF454443D6e9A888e9B1571B2375e8Ab4118d9d".toLowerCase(),
]);

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

/**
 * Separates raw token bounties from regular bounties
 */
function separateRawTokenBounties(bounties: Record<string, any>): {
  regular: Record<string, any>;
  raw: Record<string, any>;
} {
  const regular: Record<string, any> = {};
  const raw: Record<string, any> = {};

  for (const [protocol, protocolBounties] of Object.entries(bounties)) {
    regular[protocol] = {};
    raw[protocol] = {};

    for (const [key, bounty] of Object.entries(protocolBounties as Record<string, any>)) {
      if (bounty.rewardToken && RAW_TOKENS.has(bounty.rewardToken.toLowerCase())) {
        raw[protocol][key] = bounty;
      } else {
        regular[protocol][key] = bounty;
      }
    }
  }
  return { regular, raw };
}

/**
 * Processes raw token bounties into CSV format
 */
function processRawTokenBounties(
  rawBounties: Record<string, any>,
  tokenInfos: Record<string, any>,
  gaugesInfo?: Array<any>
): Record<string, Array<{
  gaugeName: string;
  gaugeAddress: string;
  rewardToken: string;
  rewardAddress: string;
  rewardAmount: number;
  rewardRawValue: number;
}>> {
  const result: Record<string, Array<any>> = {};

  for (const [protocol, protocolBounties] of Object.entries(rawBounties)) {
    if (!result[protocol]) {
      result[protocol] = [];
    }

    for (const bounty of Object.values(protocolBounties as Record<string, any>)) {
      const tokenInfo = tokenInfos[bounty.rewardToken.toLowerCase()];
      
      // Find gauge name and actual gauge address from gaugesInfo array
      let gaugeName = bounty.gauge;
      let gaugeAddress = bounty.gauge;
      if (gaugesInfo) {
        const gaugeInfo = gaugesInfo.find(
          (g: any) => g.address.toLowerCase() === bounty.gauge.toLowerCase()
        );
        if (gaugeInfo) {
          gaugeName = gaugeInfo.name;
          // If this bounty was claimed through a rootGauge, use the actual gauge address
          gaugeAddress = gaugeInfo.actualGauge || bounty.gauge;
        }
      }

      const amount = Number(bounty.amount) / Math.pow(10, tokenInfo?.decimals || 18);

      result[protocol].push({
        gaugeName,
        gaugeAddress,
        rewardToken: tokenInfo?.symbol || "UNKNOWN",
        rewardAddress: bounty.rewardToken,
        rewardAmount: amount,
        rewardRawValue: amount, // For raw tokens, the value is the same as the amount
      });
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
    console.error(
      "Please specify a valid protocol: curve, balancer, fxn, frax, or pendle"
    );
    process.exit(1);
  }

  // Get block numbers and timestamps (timestamps are not used later)
  const { blockNumber1, blockNumber2 } = await getTimestampsBlocks(
    publicClient,
    0
  );

  const totalBounties = await fetchBountiesData(currentPeriod);
  if (isDebugEnabled()) {
    const countSource = (src: Record<string, any>) =>
      Object.fromEntries(
        ["curve", "balancer", "fxn", "frax", "pendle"].map((p) => [
          p,
          src?.[p] ? Object.keys(src[p]).length : 0,
        ])
      );
    debug("[bounties] timestamps", {
      currentPeriod,
      blockNumber1,
      blockNumber2,
      timestamp1: totalBounties.timestamp1,
      timestamp2: totalBounties.timestamp2,
    });
    debug("[bounties] counts per source", {
      votemarket: countSource(totalBounties.votemarket || {}),
      votemarket_v2: countSource(totalBounties.votemarket_v2 || {}),
      warden: countSource(totalBounties.warden || {}),
      hiddenhand: countSource(totalBounties.hiddenhand || {}),
    });
  }
  let aggregatedBounties = aggregateBounties(totalBounties);
  
  // Separate raw token bounties from regular bounties
  const { regular: regularBounties, raw: rawBounties } = separateRawTokenBounties(aggregatedBounties);
  
  // Keep bounties only for the specified protocol
  aggregatedBounties = { [protocol]: regularBounties[protocol] || {} };
  const rawProtocolBounties = { [protocol]: rawBounties[protocol] || {} };

  // Collect tokens and fetch their info (including raw tokens)
  const protocolTokens = { [protocol]: PROTOCOLS_TOKENS[protocol] };
  
  // Convert aggregatedBounties back to array format for collectAllTokens
  const aggregatedBountiesForTokens: Record<string, any[]> = {};
  for (const [p, bounties] of Object.entries(aggregatedBounties)) {
    aggregatedBountiesForTokens[p] = Object.values(bounties || {});
  }
  
  const allTokens = collectAllTokens(aggregatedBountiesForTokens, protocolTokens);
  if (isDebugEnabled()) {
    debug("[tokens] protocol", protocol);
    debug("[tokens] total unique", allTokens.size);
    debug("[tokens] sample", sampleArray(Array.from(allTokens), 10));
  }
  
  // Add raw tokens to the set
  for (const protocolRawBounties of Object.values(rawProtocolBounties)) {
    for (const bounty of Object.values(protocolRawBounties as Record<string, any>)) {
      if (bounty.rewardToken) {
        allTokens.add(bounty.rewardToken.toLowerCase());
      }
    }
  }
  
  const tokenInfos = await fetchAllTokenInfos(
    Array.from(allTokens),
    publicClient
  );
  if (isDebugEnabled()) {
    const ti = Object.fromEntries(
      sampleArray(Object.entries(tokenInfos), 10).map(([a, i]) => [a, i?.symbol])
    );
    debug("[tokenInfos] sample symbols", ti);
  }

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
    case "pendle":
      gaugesInfo = await getGaugesInfos("pendle");
      break;
  }
  // Convert aggregatedBounties to array format for processReport
  const aggregatedBountiesArray: Record<string, any[]> = {};
  for (const [p, bounties] of Object.entries(aggregatedBounties)) {
    aggregatedBountiesArray[p] = Object.values(bounties || {});
  }
  
  if (gaugesInfo) {
    aggregatedBountiesArray[protocol] = addGaugeNamesToBounties(
      aggregatedBountiesArray[protocol],
      gaugesInfo
    );
  }

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
  if (isDebugEnabled()) {
    debug("[swaps] fetched", {
      inCount: swapIn.length,
      outCount: swapOut.length,
      inSample: sampleArray(
        swapIn.map((s) => ({
          block: s.blockNumber,
          logIndex: s.logIndex,
          token: s.token,
          tx: s.transactionHash,
          from: s.from,
          to: s.to,
        })),
        5
      ),
      outSample: sampleArray(
        swapOut.map((s) => ({
          block: s.blockNumber,
          logIndex: s.logIndex,
          token: s.token,
          tx: s.transactionHash,
          from: s.from,
          to: s.to,
        })),
        5
      ),
    });
  }

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
  debug("[swaps] vlcvx excluded blocks count", vlcvxRecipientSwapsInBlockNumbers.length);

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
  if (isDebugEnabled()) {
    debug("[swaps] otc blocks count", new Set(swapOTC.map((s) => s.blockNumber)).size);
    debug("[swaps] filtered counts", {
      inFiltered: swapInFiltered.length,
      outFiltered: swapOutFiltered.length,
    });
  }

  const processedReport = processReport(
    1,
    swapInFiltered,
    swapOutFiltered,
    aggregatedBountiesArray,
    tokenInfos,
    vlcvxRecipientSwapsInBlockNumbers
  );
  // Pendle-specific logic removed in favor of universal pass below

  // Generic: drop tokens that were not swapped for this protocol (all protocols)
  try {
    const txHashes = Array.from(
      new Set(
        [...swapInFiltered, ...swapOutFiltered]
          .map((s) => s.transactionHash)
          .filter(Boolean) as string[]
      )
    );
    const wethAddr = WETH_CHAIN_IDS[1].toLowerCase();
    const nativeAddr = PROTOCOLS_TOKENS[protocol].native.toLowerCase();
    const sdAddr = PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase();

    const includedTokens = new Set<string>();
    for (const b of aggregatedBountiesArray[protocol] || []) {
      const t = (b.rewardToken || "").toLowerCase();
      if (t && t !== nativeAddr && t !== sdAddr && t !== wethAddr) {
        includedTokens.add(t);
      }
    }

    const tokenSwapWeth: Record<string, number> = {};
    let totalWethOutUsed = 0;

    for (const tx of txHashes) {
      const inTx = swapInFiltered.filter((e) => e.transactionHash === tx);
      const outTx = swapOutFiltered.filter((e) => e.transactionHash === tx);
      const totalWethInTx = inTx
        .filter((e) => e.token.toLowerCase() === wethAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      const totalWethOutTx = outTx
        .filter((e) => e.token.toLowerCase() === wethAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      let mapped: Record<string, bigint> = {};
      try {
        mapped = await mapTokenSwapsToOutToken(
          publicClient,
          tx as `0x${string}`,
          includedTokens,
          wethAddr,
          ALL_MIGHT
        );
      } catch (e) {
        // Ignore mapping errors and continue
      }
      const mappedWethSum = Object.values(mapped).reduce(
        (s, v) => s + Number(v) / 1e18,
        0
      );
      for (const [tok, amt] of Object.entries(mapped)) {
        const tl = tok.toLowerCase();
        tokenSwapWeth[tl] = (tokenSwapWeth[tl] || 0) + Number(amt) / 1e18;
      }
      totalWethOutUsed += totalWethOutTx;
    }

    const tokensNotSwapped: string[] = [];
    for (const t of includedTokens) {
      if (!tokenSwapWeth[t] || tokenSwapWeth[t] === 0) tokensNotSwapped.push(t);
    }
    const wethNotSwapped = totalWethOutUsed === 0;

    if (isDebugEnabled()) {
      debug("[not-swapped detection]", {
        protocol,
        tokensNotSwapped,
        wethNotSwapped,
      });
    }

    if (processedReport[protocol]) {
      processedReport[protocol] = processedReport[protocol].filter((row) => {
        const addr = row.rewardAddress.toLowerCase();
        if (addr === nativeAddr || addr === sdAddr) return true;
        if (addr === wethAddr) return !wethNotSwapped;
        return !tokensNotSwapped.includes(addr);
      });
    }
  } catch (e) {
    debug("[not-swapped detection] error", String(e));
  }

  // Generic per-token reallocation using receipt-level attribution (all protocols)
  try {
    const txHashes = Array.from(
      new Set(
        [...swapInFiltered, ...swapOutFiltered]
          .map((s) => s.transactionHash)
          .filter(Boolean) as string[]
      )
    );
    const wethAddr = WETH_CHAIN_IDS[1].toLowerCase();
    const nativeAddr = PROTOCOLS_TOKENS[protocol].native.toLowerCase();
    const sdAddr = PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase();

    const includedTokens = new Set<string>();
    for (const b of aggregatedBountiesArray[protocol] || []) {
      const t = (b.rewardToken || "").toLowerCase();
      if (t && t !== nativeAddr && t !== sdAddr && t !== wethAddr) {
        includedTokens.add(t);
      }
    }

    const includedSdByToken: Record<string, number> = {};

    for (const tx of txHashes) {
      const inTx = swapInFiltered.filter((e) => e.transactionHash === tx);
      const totalWethInTx = inTx
        .filter((e) => e.token.toLowerCase() === wethAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      const sdInTx = inTx
        .filter((e) => e.token.toLowerCase() === sdAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      if (sdInTx <= 0 || totalWethInTx <= 0) continue;

      let tokenToOut: Record<string, bigint> = {};
      try {
        tokenToOut = await mapTokenSwapsToOutToken(
          publicClient,
          tx as `0x${string}`,
          includedTokens,
          wethAddr,
          ALL_MIGHT
        );
      } catch (e) {
        continue;
      }
      const sdPerWeth = sdInTx / totalWethInTx;
      for (const [tok, amount] of Object.entries(tokenToOut)) {
        const tokLower = tok.toLowerCase();
        if (!includedTokens.has(tokLower)) continue;
        const wethAmt = Number(amount) / 1e18;
        includedSdByToken[tokLower] = (includedSdByToken[tokLower] || 0) + wethAmt * sdPerWeth;
      }
    }

    if (isDebugEnabled()) {
      debug(
        "[generic per-token sd]",
        Object.entries(includedSdByToken).map(([k, v]) => ({ token: k, sd: v }))
      );
    }

    if (processedReport[protocol] && Object.keys(includedSdByToken).length > 0) {
      const rows = processedReport[protocol] || [];
      const rowsByToken: Record<string, typeof rows> = {};
      for (const row of rows) {
        const tok = row.rewardAddress.toLowerCase();
        (rowsByToken[tok] ||= []).push(row);
      }
      for (const [tok, tokenRows] of Object.entries(rowsByToken)) {
        if (tok === nativeAddr || tok === sdAddr || tok === wethAddr) continue;
        const targetSd = includedSdByToken[tok] || 0;
        if (targetSd <= 0) {
          tokenRows.forEach((r) => (r.rewardSdValue = 0));
          continue;
        }
        let sumOldSd = tokenRows.reduce((s, r) => s + (r.rewardSdValue || 0), 0);
        let weights: number[] = [];
        if (sumOldSd > 0) {
          weights = tokenRows.map((r) => (r.rewardSdValue || 0) / sumOldSd);
        } else {
          const sumAmt = tokenRows.reduce((s, r) => s + (r.rewardAmount || 0), 0);
          weights = tokenRows.map((r) => ((r.rewardAmount || 0) / (sumAmt || 1)));
        }
        tokenRows.forEach((r, idx) => {
          r.rewardSdValue = targetSd * (weights[idx] || 0);
        });
      }
      const finalTotal = rows.reduce((s, r) => s + (r.rewardSdValue || 0), 0);
      if (finalTotal > 0) rows.forEach((r) => (r.sharePercentage = ((r.rewardSdValue || 0) / finalTotal) * 100));

      // Keep only native/sdToken or tokens explicitly attributed; drop others (e.g., WETH when unused)
      const includedSet = new Set(Object.keys(includedSdByToken).map((t) => t.toLowerCase()));
      const beforeCount = rows.length;
      processedReport[protocol] = rows.filter((r) => {
        const addr = r.rewardAddress.toLowerCase();
        return addr === nativeAddr || addr === sdAddr || includedSet.has(addr);
      });
      const afterCount = processedReport[protocol].length;
      if (isDebugEnabled() && afterCount !== beforeCount) {
        debug("[filter rows by attribution]", { beforeCount, afterCount });
      }

      // Recompute shares after drop
      const finalTotal2 = processedReport[protocol].reduce((s, r) => s + (r.rewardSdValue || 0), 0);
      if (finalTotal2 > 0) processedReport[protocol].forEach((r) => (r.sharePercentage = ((r.rewardSdValue || 0) / finalTotal2) * 100));
      if (isDebugEnabled()) {
        const tokenTotals = Object.fromEntries(
          Object.entries(rowsByToken).map(([t, rs]) => [
            t,
            rs.reduce((s, r) => s + (r.rewardSdValue || 0), 0),
          ])
        );
        debug("[generic per-token reallocated]", { finalTotal: finalTotal2, tokenTotals });
      }
    }
  } catch (e) {
    debug("[generic per-token reallocation] error", String(e));
  }


  // Protocol-specific blocks removed in favor of universal attribution
  if (isDebugEnabled()) {
    const summary: Record<string, any> = {};
    for (const [p, rows] of Object.entries(processedReport)) {
      const total = (rows || []).reduce((acc, r) => acc + (r.rewardSdValue || 0), 0);
      summary[p] = { rows: rows?.length || 0, totalSd: Number(total.toFixed(6)) };
    }
    debug("[report] processed summary", summary);
  }

  // Emit attribution sidecar JSON (per protocol) for auditability
  try {
    const txHashes = Array.from(
      new Set(
        [...swapInFiltered, ...swapOutFiltered]
          .map((s) => s.transactionHash)
          .filter(Boolean) as string[]
      )
    );
    const wethAddr = WETH_CHAIN_IDS[1].toLowerCase();
    const nativeAddr = PROTOCOLS_TOKENS[protocol].native.toLowerCase();
    const sdAddr = PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase();

    const includedTokens = new Set<string>();
    for (const b of aggregatedBountiesArray[protocol] || []) {
      const t = (b.rewardToken || "").toLowerCase();
      if (t && t !== nativeAddr && t !== sdAddr && t !== wethAddr) {
        includedTokens.add(t);
      }
    }

    const tokenMappedWeth: Record<string, number> = {};
    const includedSdByToken: Record<string, number> = {};
    const txAttributions: Array<{
      tx: string;
      wethIn: number;
      wethOut: number;
      sdIn: number;
      tokenWeth: Record<string, number>;
      tokenSd: Record<string, number>;
    }> = [];
    let sdInTotal = 0;
    let wethInTotal = 0;
    let wethOutTotal = 0;

    for (const tx of txHashes) {
      const inTx = swapInFiltered.filter((e) => e.transactionHash === tx);
      const outTx = swapOutFiltered.filter((e) => e.transactionHash === tx);
      const totalWethInTx = inTx
        .filter((e) => e.token.toLowerCase() === wethAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      const totalWethOutTx = outTx
        .filter((e) => e.token.toLowerCase() === wethAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      const sdInTx = inTx
        .filter((e) => e.token.toLowerCase() === sdAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);

      if (totalWethInTx > 0 || totalWethOutTx > 0 || sdInTx > 0) {
        wethInTotal += totalWethInTx;
        wethOutTotal += totalWethOutTx;
        sdInTotal += sdInTx;
      }

      if (sdInTx <= 0 || totalWethInTx <= 0) {
        txAttributions.push({ tx, wethIn: totalWethInTx, wethOut: totalWethOutTx, sdIn: sdInTx, tokenWeth: {}, tokenSd: {} });
        continue;
      }

      let tokenToOut: Record<string, bigint> = {};
      try {
        tokenToOut = await mapTokenSwapsToOutToken(
          publicClient,
          tx as `0x${string}`,
          includedTokens,
          wethAddr,
          ALL_MIGHT
        );
      } catch (e) {
        txAttributions.push({ tx, wethIn: totalWethInTx, wethOut: totalWethOutTx, sdIn: sdInTx, tokenWeth: {}, tokenSd: {} });
        continue;
      }

      const sdPerWeth = totalWethInTx > 0 ? sdInTx / totalWethInTx : 0;
      const tokenWeth: Record<string, number> = {};
      const tokenSd: Record<string, number> = {};
      for (const [tok, amount] of Object.entries(tokenToOut)) {
        const tokLower = tok.toLowerCase();
        const wethAmt = Number(amount) / 1e18;
        tokenWeth[tokLower] = (tokenWeth[tokLower] || 0) + wethAmt;
        tokenSd[tokLower] = (tokenSd[tokLower] || 0) + wethAmt * sdPerWeth;
        tokenMappedWeth[tokLower] = (tokenMappedWeth[tokLower] || 0) + wethAmt;
        includedSdByToken[tokLower] = (includedSdByToken[tokLower] || 0) + wethAmt * sdPerWeth;
      }
      txAttributions.push({ tx, wethIn: totalWethInTx, wethOut: totalWethOutTx, sdIn: sdInTx, tokenWeth, tokenSd });
    }

    const tokensNotSwapped = Array.from(includedTokens).filter((t) => !tokenMappedWeth[t] || tokenMappedWeth[t] === 0);
    const perToken: Record<string, { mappedWeth: number; sd: number }> = {};
    for (const t of includedTokens) {
      perToken[t] = {
        mappedWeth: tokenMappedWeth[t] || 0,
        sd: includedSdByToken[t] || 0,
      };
    }

    const sidecar = {
      protocol,
      period: currentPeriod,
      aggregator: ALL_MIGHT,
      totals: {
        sdInTotal,
        sdAssigned: Object.values(includedSdByToken).reduce((a, b) => a + b, 0),
        wethInTotal,
        wethOutTotal,
      },
      dropped: { tokensNotSwapped, wethNotSwapped: wethOutTotal === 0 },
      perToken,
      txs: txAttributions,
    };

    const projectRoot2 = path.resolve(__dirname, "..", "..");
    const dirPath2 = path.join(projectRoot2, "bounties-reports", currentPeriod.toString());
    fs.mkdirSync(dirPath2, { recursive: true });
    const jsonPath = path.join(dirPath2, `${protocol}-attribution.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2));
    if (isDebugEnabled()) debug("[sidecar written]", jsonPath);
  } catch (e) {
    debug("[sidecar error]", String(e));
  }

  // Process raw token bounties
  const rawTokenReport = processRawTokenBounties(rawProtocolBounties, tokenInfos, gaugesInfo);

  // Generate CSV reports in the designated directory
  const projectRoot = path.resolve(__dirname, "..", "..");
  const dirPath = path.join(
    projectRoot,
    "bounties-reports",
    currentPeriod.toString()
  );
  fs.mkdirSync(dirPath, { recursive: true });
  
  // Create raw subdirectory for raw token reports
  const rawDirPath = path.join(dirPath, "raw");
  if (Object.keys(rawTokenReport).some(p => rawTokenReport[p] && rawTokenReport[p].length > 0)) {
    fs.mkdirSync(rawDirPath, { recursive: true });
  }
  
  const formattedDate = new Date(currentPeriod * 1000).toLocaleDateString(
    "en-GB"
  );
  console.log("Generating reports for the week of:", formattedDate);

  // Generate regular CSV reports
  for (const [protocol, rows] of Object.entries(processedReport)) {
    // Skip if no data
    if (!rows || rows.length === 0) {
      console.log(`No data to report for ${protocol}`);
      continue;
    }
    
    // Special handling for Pendle protocol
    if (protocol === "pendle") {
      // Generate pendle-otc.csv with Period column (matching OTC report format)
      const csvContent = [
        "Period;Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
        ...rows.map(
          (row) =>
            `${currentPeriod};${escapeCSV(row.gaugeName)};${escapeCSV(
              row.gaugeAddress
            )};${escapeCSV(row.rewardToken)};` +
            `${escapeCSV(row.rewardAddress)};${row.rewardAmount.toFixed(
              6
            )};${row.rewardSdValue.toFixed(6)};` +
            `${row.sharePercentage.toFixed(2)}`
        ),
      ].join("\n");

      const fileName = `${protocol}-otc.csv`;
      fs.writeFileSync(path.join(dirPath, fileName), csvContent);
      console.log(`Report generated for ${protocol}: ${fileName}`);
    } else {
      // Standard format for other protocols
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

  // Generate raw token CSV reports
  for (const [protocol, rows] of Object.entries(rawTokenReport)) {
    if (rows && rows.length > 0) {
      debug("[raw] rows", protocol, rows.length);
      const rawCsvContent = [
        "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount",
        ...rows.map(
          (row) =>
            `${escapeCSV(row.gaugeName)};${escapeCSV(
              row.gaugeAddress
            )};${escapeCSV(row.rewardToken)};` +
            `${escapeCSV(row.rewardAddress)};${row.rewardAmount.toFixed(6)}`
        ),
      ].join("\n");

      const rawFileName = `${protocol}.csv`;
      const protocolRawDir = path.join(rawDirPath, protocol);
      fs.mkdirSync(protocolRawDir, { recursive: true });
      fs.writeFileSync(path.join(protocolRawDir, rawFileName), rawCsvContent);
      console.log(`Raw token report generated for ${protocol}: raw/${protocol}/${rawFileName}`);
    }
  }
}

main().catch(console.error);
