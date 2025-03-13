import {
  PROTOCOLS_TOKENS,
  matchWethInWithRewardsOut,
  WETH_ADDRESS,
} from "../utils/reportUtils";

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

interface SwapData {
  sdTokenIn?: number[];
  sdTokenOut?: number[];
  nativeIn?: number[];
  nativeOut?: number[];
  wethOut?: number[];
  wethIn?: number[];
  rewardsOut?: { token: string; symbol: string; amount: number }[];
}

interface SwapEvent {
  blockNumber: number;
  logIndex: number;
  from: string;
  to: string;
  token: string;
  amount: bigint;
}

interface ProcessedSwapEvent extends SwapEvent {
  formattedAmount: number;
  symbol: string;
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

/**
 * Processes swap events and bounties to generate CSV rows grouped by protocol.
 */
function processReport(
  swapsIn: ProcessedSwapEvent[],
  swapsOut: ProcessedSwapEvent[],
  aggregatedBounties: Record<string, Bounty[]>,
  tokenInfos: Record<string, TokenInfo>,
  excludedSwapsInBlockNumbers: number[]
): { [protocol: string]: CSVRow[] } {
  // Organize swaps data by protocol and block number.
  const swapsData: Record<string, Record<number, SwapData>> = {};

  for (const [protocol, tokenConfig] of Object.entries(PROTOCOLS_TOKENS)) {
    swapsData[protocol] = {};

    // Process sdTokenIn events.
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

    // Process remaining swap events (both in and out).
    for (const swap of [...swapsIn, ...swapsOut]) {
      if (excludedSwapsInBlockNumbers.includes(swap.blockNumber)) continue;
      if (!swapsData[protocol][swap.blockNumber]) continue;

      const token = swap.token.toLowerCase();
      const isNative = token === tokenConfig.native.toLowerCase();
      const isWeth = token === WETH_ADDRESS.toLowerCase();
      const isSdToken = token === tokenConfig.sdToken.toLowerCase();
      const isReward = ![WETH_ADDRESS, tokenConfig.native, tokenConfig.sdToken]
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

  // Build ordered matches using the provided matching function.
  const allMatches = Object.entries(swapsData).flatMap(([protocol, blocks]) =>
    Object.entries(blocks).flatMap(([blockNumber, blockData]) => {
      const matches = matchWethInWithRewardsOut(blockData);
      return matches.length > 0
        ? [{ protocol, blockNumber: parseInt(blockNumber), matches }]
        : [];
    })
  );

  const orderedData = allMatches.reduce(
    (acc: ProtocolData, { protocol, blockNumber, matches }) => {
      acc[protocol] = acc[protocol] || [];
      acc[protocol].push({ blockNumber, matches });
      return acc;
    },
    {} as ProtocolData
  );

  // Remove blocks with no sdTokenOut events.
  for (const [protocol, blocks] of Object.entries(swapsData)) {
    for (const [blockNumber, blockData] of Object.entries(blocks)) {
      if (!blockData.sdTokenOut || blockData.sdTokenOut.length === 0) {
        delete swapsData[protocol][parseInt(blockNumber)];
      }
    }
  }

  // Build protocol summaries.
  const protocolSummaries: ProtocolSummary[] = [];
  for (const [protocol, blocks] of Object.entries(swapsData)) {
    let totalWethOut = 0,
      totalWethIn = 0,
      totalNativeOut = 0,
      totalNativeIn = 0,
      totalSdTokenOut = 0,
      totalSdTokenIn = 0;
    const tokenMap: { [address: string]: AggregatedTokenInfo } = {};

    for (const block of Object.values(blocks)) {
      totalWethOut += (block.wethOut || []).reduce((sum, amt) => sum + amt, 0);
      totalWethIn += (block.wethIn || []).reduce((sum, amt) => sum + amt, 0);
      totalNativeOut += (block.nativeOut || []).reduce(
        (sum, amt) => sum + amt,
        0
      );
      totalNativeIn += (block.nativeIn || []).reduce(
        (sum, amt) => sum + amt,
        0
      );
      totalSdTokenOut += (block.sdTokenOut || []).reduce(
        (sum, amt) => sum + amt,
        0
      );
      totalSdTokenIn += (block.sdTokenIn || []).reduce(
        (sum, amt) => sum + amt,
        0
      );
    }

    const protocolData = orderedData[protocol] || [];
    for (const { matches } of protocolData) {
      for (const match of matches) {
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

  // Calculate bounty shares using protocol summaries.
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

    const { totalNativeOut, totalWethIn, totalSdTokenIn } = protocolSummary;
    const nativeFromBounties = bounties
      .filter((bounty) => bounty.rewardToken.toLowerCase() === native)
      .reduce((sum, bounty) => {
        const tokenInfo = tokenInfos[bounty.rewardToken.toLowerCase()];
        const formattedAmount =
          Number(bounty.amount) / 10 ** (tokenInfo?.decimals || 18);
        return sum + formattedAmount;
      }, 0);

    const nativeFromWeth = totalNativeOut - nativeFromBounties;
    const wethToNativeRatio =
      totalWethIn > 0 ? nativeFromWeth / totalWethIn : 0;

    bounties.forEach((bounty) => {
      const rewardToken = bounty.rewardToken.toLowerCase();
      const tokenInfo = tokenInfos[rewardToken];
      const formattedAmount =
        Number(bounty.amount) / 10 ** (tokenInfo?.decimals || 18);
      let nativeEquivalent = 0;

      if (rewardToken === native) {
        nativeEquivalent = formattedAmount;
      } else if (rewardToken === WETH_ADDRESS.toLowerCase()) {
        nativeEquivalent = formattedAmount * wethToNativeRatio;
      } else {
        const tokenSummary = protocolSummary.tokens.find(
          (t) => t.address.toLowerCase() === rewardToken
        );
        if (tokenSummary) {
          const localShare = formattedAmount / tokenSummary.amount;
          nativeEquivalent = tokenSummary.weth * localShare * wethToNativeRatio;
        }
      }
      bounty.nativeEquivalent = nativeEquivalent;
    });

    const totalNativeEquivalent = bounties.reduce(
      (acc, bounty) => acc + (bounty.nativeEquivalent || 0),
      0
    );
    let totalShares = 0;
    bounties.forEach((bounty) => {
      bounty.share = bounty.nativeEquivalent
        ? bounty.nativeEquivalent / totalNativeEquivalent
        : 0;
      totalShares += bounty.share;
    });

    // Normalize shares and compute SD token amounts.
    bounties.forEach((bounty) => {
      if (bounty.rewardToken.toLowerCase() === sdToken) {
        const tokenInfo = tokenInfos[bounty.rewardToken];
        bounty.sdTokenAmount =
          Number(bounty.amount) / 10 ** (tokenInfo?.decimals || 18);
      } else {
        bounty.normalizedShare = bounty.share ? bounty.share / totalShares : 0;
        bounty.sdTokenAmount = bounty.normalizedShare
          ? bounty.normalizedShare * totalSdTokenIn
          : 0;
      }
    });

    const totalSdTokenAmount = bounties.reduce(
      (acc, bounty) => acc + (bounty.sdTokenAmount || 0),
      0
    );
    bounties.forEach((bounty) => {
      bounty.share = bounty.sdTokenAmount
        ? bounty.sdTokenAmount / totalSdTokenAmount
        : 0;
    });
  });

  // Merge bounties into CSV rows.
  const mergedRows: { [key: string]: CSVRow } = {};
  Object.entries(aggregatedBounties).forEach(([protocol, bounties]) => {
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
  });

  // Group CSV rows by protocol and filter out rows with zero SD token value.
  const groupedRows: { [protocol: string]: CSVRow[] } = {};
  Object.values(mergedRows).forEach((row) => {
    if (row.rewardSdValue > 0) {
      groupedRows[row.protocol] = groupedRows[row.protocol] || [];
      groupedRows[row.protocol].push(row);
    }
  });

  return groupedRows;
}

export default processReport;
