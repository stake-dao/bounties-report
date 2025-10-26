import { WETH_CHAIN_IDS } from "../utils/constants";
import {
  PROTOCOLS_TOKENS,
  matchWethInWithRewardsOut,
} from "../utils/reportUtils";
import { debug, sampleArray, isDebugEnabled } from "../utils/logger";

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
  transactionHash?: string;
}

interface ProcessedSwapEvent extends SwapEvent {
  formattedAmount: number;
  symbol: string;
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

interface SwapData {
  sdTokenIn?: number[];
  sdTokenOut?: number[];
  nativeIn?: number[];
  nativeOut?: number[];
  wethOut?: number[];
  wethIn?: number[];
  rewardsOut?: { token: string; symbol: string; amount: number }[];
}

/**
 * Compute per‑protocol sd attribution and output CSV rows.
 *
 * Steps:
 * 1) Group swaps by protocol/block and track flows (weth/native/sd/rewards)
 * 2) Match WETH in with rewards out to value tokens in WETH terms
 * 3) Derive WETH→Native ratio and native equivalents
 * 4) Allocate sd: direct sd first, remainder by bounty shares
 * 5) Merge by (gauge, rewardToken) for CSV
 */
function processReport(
  chainId: number,
  swapsIn: ProcessedSwapEvent[],
  swapsOut: ProcessedSwapEvent[],
  aggregatedBounties: Record<string, Bounty[]>,
  tokenInfos: Record<string, TokenInfo>,
  excludedSwapsInBlockNumbers: number[]
): { [protocol: string]: CSVRow[] } {
  // Step 1: Organize swaps by protocol and block
  const swapsData: Record<string, Record<number, SwapData>> = {};
  
  // First, collect all transactions that involve sdToken for each protocol
  const protocolTransactions: Record<string, Set<string>> = {};
  
  for (const [protocol, tokenConfig] of Object.entries(PROTOCOLS_TOKENS)) {
    protocolTransactions[protocol] = new Set();
    swapsData[protocol] = {};

    // Identify transactions that involve sdToken
    for (const swap of [...swapsIn, ...swapsOut]) {
      if (swap.token.toLowerCase() === tokenConfig.sdToken.toLowerCase() && swap.transactionHash) {
        protocolTransactions[protocol].add(swap.transactionHash);
      }
    }
  }

  for (const [protocol, tokenConfig] of Object.entries(PROTOCOLS_TOKENS)) {
    // Process sdTokenIn events
    for (const swap of swapsIn) {
      if (excludedSwapsInBlockNumbers.includes(swap.blockNumber)) continue;
      if (swap.token.toLowerCase() === tokenConfig.sdToken.toLowerCase()) {
        if (!swapsData[protocol][swap.blockNumber]) {
          swapsData[protocol][swap.blockNumber] = { sdTokenIn: [] };
        }
        swapsData[protocol][swap.blockNumber].sdTokenIn!.push(
          swap.formattedAmount
        );
      }
    }

    // Process swap events only from transactions that involve sdToken
    for (const swap of [...swapsIn, ...swapsOut]) {
      if (excludedSwapsInBlockNumbers.includes(swap.blockNumber)) continue;
      
      // Skip if this transaction doesn't involve sdToken for this protocol
      if (swap.transactionHash && !protocolTransactions[protocol].has(swap.transactionHash)) {
        continue;
      }
      
      if (!swapsData[protocol][swap.blockNumber]) continue;

      const token = swap.token.toLowerCase();
      const isNative = token === tokenConfig.native.toLowerCase();
      const isWeth = token === WETH_CHAIN_IDS[chainId].toLowerCase();
      const isSdToken = token === tokenConfig.sdToken.toLowerCase();
      const isReward = ![
        WETH_CHAIN_IDS[chainId],
        tokenConfig.native,
        tokenConfig.sdToken,
      ]
        .map((t) => t.toLowerCase())
        .includes(token);

      if (swapsIn.includes(swap)) {
        if (isNative) {
          swapsData[protocol][swap.blockNumber].nativeIn ??= [];
          swapsData[protocol][swap.blockNumber].nativeIn!.push(
            swap.formattedAmount
          );
        } else if (isWeth) {
          swapsData[protocol][swap.blockNumber].wethIn ??= [];
          swapsData[protocol][swap.blockNumber].wethIn!.push(
            swap.formattedAmount
          );
        }
      } else if (swapsOut.includes(swap)) {
        if (isNative) {
          swapsData[protocol][swap.blockNumber].nativeOut ??= [];
          swapsData[protocol][swap.blockNumber].nativeOut!.push(
            swap.formattedAmount
          );
        } else if (isWeth) {
          swapsData[protocol][swap.blockNumber].wethOut ??= [];
          swapsData[protocol][swap.blockNumber].wethOut!.push(
            swap.formattedAmount
          );
        } else if (isSdToken) {
          swapsData[protocol][swap.blockNumber].sdTokenOut ??= [];
          swapsData[protocol][swap.blockNumber].sdTokenOut!.push(
            swap.formattedAmount
          );
        } else if (isReward) {
          swapsData[protocol][swap.blockNumber].rewardsOut ??= [];
          if (
            !swapsData[protocol][swap.blockNumber].rewardsOut!.some(
              (r) => r.token === swap.token && r.amount === swap.formattedAmount
            )
          ) {
            swapsData[protocol][swap.blockNumber].rewardsOut!.push({
              token: swap.token,
              symbol: swap.symbol,
              amount: swap.formattedAmount,
            });
          }
        }
      }
    }
  }

  // Step 2: Match WETH in with rewards out to infer WETH value per token
  const tokenValues: Record<string, Record<string, number>> = {}; // protocol -> token -> weth value

  for (const [protocol, blocks] of Object.entries(swapsData)) {
    tokenValues[protocol] = {};

    for (const blockData of Object.values(blocks)) {
      const matches = matchWethInWithRewardsOut(blockData);
      if (isDebugEnabled() && matches.length > 0) {
        debug("[match] protocol matches", protocol, {
          matches: sampleArray(
            matches.map((m) => ({ token: m.address, symbol: m.symbol, amount: m.amount, weth: m.weth })),
            5
          ),
          count: matches.length,
        });
      }
      for (const match of matches) {
        if (!tokenValues[protocol][match.address]) {
          tokenValues[protocol][match.address] = 0;
        }
        tokenValues[protocol][match.address] += match.weth;
      }
    }
    if (isDebugEnabled()) {
      const tvEntries = Object.entries(tokenValues[protocol] || {}).map(([addr, weth]) => ({ addr, weth }));
      debug("[tokenValues] protocol", protocol, sampleArray(tvEntries, 10));
    }
  }

  // Step 3: Calculate total flows for each protocol
  const protocolFlows: Record<
    string,
    {
      totalWethIn: number;
      totalWethOut: number;
      totalNativeIn: number;
      totalNativeOut: number;
      totalSdTokenIn: number;
      totalSdTokenOut: number;
    }
  > = {};

  for (const [protocol, blocks] of Object.entries(swapsData)) {
    let totalWethIn = 0,
      totalWethOut = 0;
    let totalNativeIn = 0,
      totalNativeOut = 0;
    let totalSdTokenIn = 0,
      totalSdTokenOut = 0;

    for (const block of Object.values(blocks)) {
      totalWethIn += (block.wethIn || []).reduce((sum, amt) => sum + amt, 0);
      totalWethOut += (block.wethOut || []).reduce((sum, amt) => sum + amt, 0);
      totalNativeIn += (block.nativeIn || []).reduce(
        (sum, amt) => sum + amt,
        0
      );
      totalNativeOut += (block.nativeOut || []).reduce(
        (sum, amt) => sum + amt,
        0
      );
      totalSdTokenIn += (block.sdTokenIn || []).reduce(
        (sum, amt) => sum + amt,
        0
      );
      totalSdTokenOut += (block.sdTokenOut || []).reduce(
        (sum, amt) => sum + amt,
        0
      );
    }

    protocolFlows[protocol] = {
      totalWethIn,
      totalWethOut,
      totalNativeIn,
      totalNativeOut,
      totalSdTokenIn,
      totalSdTokenOut,
    };
    if (isDebugEnabled()) {
      debug("[flows] protocol", protocol, {
        totalWethIn,
        totalWethOut,
        totalNativeIn,
        totalNativeOut,
        totalSdTokenIn,
        totalSdTokenOut,
      });
    }
  }

  // Step 4: Calculate bounty values and sd allocation
  Object.entries(aggregatedBounties).forEach(([protocol, bounties]) => {
    const native = PROTOCOLS_TOKENS[protocol].native.toLowerCase();
    const sdToken = PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase();
    const flows = protocolFlows[protocol];

    if (!flows) return;

    // Sum native-denominated bounties
    const nativeFromBounties = bounties
      .filter((bounty) => bounty.rewardToken.toLowerCase() === native)
      .reduce((sum, bounty) => {
        const tokenInfo = tokenInfos[bounty.rewardToken.toLowerCase()];
        return sum + Number(bounty.amount) / 10 ** (tokenInfo?.decimals || 18);
      }, 0);

    // Calculate WETH to Native ratio
    const nativeFromWeth = flows.totalNativeOut - nativeFromBounties;
    const wethToNativeRatio =
      flows.totalWethIn > 0 ? nativeFromWeth / flows.totalWethIn : 0;

    // Edge case: WETH bounties with no WETH swaps (paid directly)
    const wethFromBounties = bounties
      .filter(
        (b) =>
          b.rewardToken.toLowerCase() === WETH_CHAIN_IDS[chainId].toLowerCase()
      )
      .reduce((sum, b) => {
        const tokenInfo = tokenInfos[b.rewardToken.toLowerCase()];
        return sum + Number(b.amount) / 10 ** (tokenInfo?.decimals || 18);
      }, 0);

    const fallbackWethToNativeRatio =
      wethFromBounties > 0 &&
      flows.totalWethIn === 0 &&
      flows.totalNativeOut > 0
        ? flows.totalNativeOut / wethFromBounties
        : 0;

    const effectiveWethToNativeRatio =
      wethToNativeRatio > 0 ? wethToNativeRatio : fallbackWethToNativeRatio;
    if (isDebugEnabled()) {
      debug("[ratios]", protocol, {
        nativeFromBounties,
        nativeFromWeth,
        wethToNativeRatio,
        wethFromBounties,
        fallbackWethToNativeRatio,
        effectiveWethToNativeRatio,
      });
    }

    // Compute native equivalent per bounty
    bounties.forEach((bounty) => {
      const rewardToken = bounty.rewardToken.toLowerCase();
      const tokenInfo = tokenInfos[rewardToken];
      const formattedAmount =
        Number(bounty.amount) / 10 ** (tokenInfo?.decimals || 18);
      let nativeEquivalent = 0;

      if (rewardToken === native) {
        nativeEquivalent = formattedAmount;
      } else if (rewardToken === WETH_CHAIN_IDS[chainId].toLowerCase()) {
        nativeEquivalent = formattedAmount * effectiveWethToNativeRatio;
      } else {
        // Use the token values from WETH matching
        const tokenWethValue = tokenValues[protocol][rewardToken];
        if (tokenWethValue) {
          // Pro‑rate by this token’s share of its total amount
          const totalForToken = bounties
            .filter((b) => b.rewardToken.toLowerCase() === rewardToken)
            .reduce((sum, b) => {
              const dec = tokenInfos[rewardToken]?.decimals || 18;
              return sum + Number(b.amount) / 10 ** dec;
            }, 0);
          const localShare = formattedAmount / totalForToken;
          nativeEquivalent =
            tokenWethValue * localShare * effectiveWethToNativeRatio;
        }
      }

      bounty.nativeEquivalent = nativeEquivalent;
    });

    // Shares across all bounties (for remainder sd allocation)
    const totalNativeEquivalent = bounties.reduce(
      (acc, bounty) => acc + (bounty.nativeEquivalent || 0),
      0
    );
    if (isDebugEnabled()) {
      debug("[nativeEquivalent] total", protocol, totalNativeEquivalent);
    }

    bounties.forEach((bounty) => {
      bounty.share =
        bounty.nativeEquivalent && totalNativeEquivalent > 0
          ? bounty.nativeEquivalent / totalNativeEquivalent
          : 0;
    });

    // sdToken amounts
    const sdTokenBounties = bounties.filter(
      (b) => b.rewardToken.toLowerCase() === sdToken
    );
    const nonSdTokenBounties = bounties.filter(
      (b) => b.rewardToken.toLowerCase() !== sdToken
    );

    // Direct sdToken bounties (pass‑through)
    sdTokenBounties.forEach((bounty) => {
      const tokenInfo = tokenInfos[bounty.rewardToken.toLowerCase()];
      bounty.sdTokenAmount =
        Number(bounty.amount) / 10 ** (tokenInfo?.decimals || 18);
    });

    // Distribute remaining sdToken by normalized shares
    const directSdTokenAmount = sdTokenBounties.reduce(
      (acc, bounty) => acc + (bounty.sdTokenAmount || 0),
      0
    );
    let remainingSdTokenAmount = flows.totalSdTokenIn - directSdTokenAmount;
    // Pendle: scale by share of WETH that came from included reward tokens
    if (protocol === "pendle") {
      const matchedIncludedWeth = Object.values(tokenValues[protocol] || {}).reduce(
        (acc, v) => acc + (v || 0),
        0
      );
      const includedShare = flows.totalWethIn > 0 ? matchedIncludedWeth / flows.totalWethIn : 1;
      if (includedShare > 0 && includedShare < 1) {
        remainingSdTokenAmount = remainingSdTokenAmount * includedShare;
      }
      if (isDebugEnabled()) {
        debug("[pendle scale] includedShare", { matchedIncludedWeth, totalWethIn: flows.totalWethIn, includedShare });
      }
    }
    if (isDebugEnabled()) {
      debug("[sdToken] direct/remaining", protocol, {
        directSdTokenAmount,
        remainingSdTokenAmount,
      });
    }

    const totalShares = bounties.reduce((acc, b) => acc + (b.share || 0), 0);
    nonSdTokenBounties.forEach((bounty) => {
      bounty.normalizedShare =
        bounty.share && totalShares > 0 ? bounty.share / totalShares : 0;
      bounty.sdTokenAmount = bounty.normalizedShare
        ? bounty.normalizedShare * remainingSdTokenAmount
        : 0;
    });
  });

  // Step 5: Convert to CSV rows
  const groupedRows: { [protocol: string]: CSVRow[] } = {};

  Object.entries(aggregatedBounties).forEach(([protocol, bounties]) => {
    const mergedRows: { [key: string]: CSVRow } = {};

    bounties.forEach((bounty) => {
      const rewardToken = bounty.rewardToken.toLowerCase();
      const tokenInfo = tokenInfos[rewardToken];
      const formattedAmount =
        Number(bounty.amount) / 10 ** (tokenInfo?.decimals || 18);
      const key = `${protocol}-${bounty.gauge.toLowerCase()}-${rewardToken}`;

      if (mergedRows[key]) {
        mergedRows[key].rewardAmount += formattedAmount;
        mergedRows[key].rewardSdValue += bounty.sdTokenAmount || 0;
        mergedRows[key].sharePercentage += bounty.share
          ? bounty.share * 100
          : 0;
      } else {
        mergedRows[key] = {
          protocol,
          gaugeName: bounty.gaugeName || "Unknown",
          gaugeAddress: bounty.gauge,
          rewardToken: tokenInfo?.symbol || "Unknown",
          rewardAddress: bounty.rewardToken,
          rewardAmount: formattedAmount,
          rewardSdValue: bounty.sdTokenAmount || 0,
          sharePercentage: bounty.share ? bounty.share * 100 : 0,
        };
      }
    });

    // Filter out rows with zero SD token value
    groupedRows[protocol] = Object.values(mergedRows).filter(
      (row) => row.rewardSdValue > 0
    );
    if (isDebugEnabled()) {
      const total = groupedRows[protocol].reduce((acc, r) => acc + (r.rewardSdValue || 0), 0);
      debug("[groupedRows]", protocol, {
        rows: groupedRows[protocol].length,
        totalSd: Number(total.toFixed(6)),
      });
    }
  });

  return groupedRows;
}

export default processReport;
