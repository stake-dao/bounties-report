import { WETH_CHAIN_IDS } from "../utils/constants";
import {
  PROTOCOLS_TOKENS,
  matchWethInWithRewardsOut,
  OTC_REGISTRY,
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
 * Processes OTC swap events and bounties to generate CSV rows.
 * This is a specialized version for OTC reports that doesn't filter out zero sdToken values.
 */
function processOTCReport(
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
    // Initialize blocks that have sdToken or OTC-related swaps
    for (const swap of [...swapsIn, ...swapsOut]) {
      if (excludedSwapsInBlockNumbers.includes(swap.blockNumber)) continue;
      
      // Initialize block data if we have:
      // 1. sdToken swaps OR
      // 2. Swaps from OTC Registry (WETH transfers)
      const isOTCSwap = swap.from && swap.from.toLowerCase() === OTC_REGISTRY.toLowerCase();
      const isSdToken = swap.token.toLowerCase() === tokenConfig.sdToken.toLowerCase();
      
      if (isSdToken || isOTCSwap) {
        if (!swapsData[protocol][swap.blockNumber]) {
          swapsData[protocol][swap.blockNumber] = {};
        }
      }
    }
    
    // Process sdTokenIn events
    for (const swap of swapsIn) {
      if (excludedSwapsInBlockNumbers.includes(swap.blockNumber)) continue;
      if (swap.token.toLowerCase() === tokenConfig.sdToken.toLowerCase()) {
        if (!swapsData[protocol][swap.blockNumber]) {
          swapsData[protocol][swap.blockNumber] = {};
        }
        swapsData[protocol][swap.blockNumber].sdTokenIn ??= [];
        swapsData[protocol][swap.blockNumber].sdTokenIn!.push(
          swap.formattedAmount
        );
      }
    }

    // Process all swap events - but only from transactions that involve sdToken
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

  // Step 2: Calculate total flows for each protocol
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
  }

  // Step 3: For OTC reports, calculate sdToken values based on the flows
  Object.entries(aggregatedBounties).forEach(([protocol, bounties]) => {
    const flows = protocolFlows[protocol];
    if (!flows) return;

    const wethAddress = WETH_CHAIN_IDS[chainId].toLowerCase();
    const tokenConfig = PROTOCOLS_TOKENS[protocol];
    const sdTokenAddress = tokenConfig.sdToken.toLowerCase();
    const nativeAddress = tokenConfig.native.toLowerCase();
    
    // Separate bounties by reward token type
    const wethBounties = bounties.filter(b => b.rewardToken.toLowerCase() === wethAddress);
    const nativeBounties = bounties.filter(b => b.rewardToken.toLowerCase() === nativeAddress);
    const sdTokenBounties = bounties.filter(b => b.rewardToken.toLowerCase() === sdTokenAddress);
    
    // Calculate total amounts for each type
    const totalWethFromBounties = wethBounties.reduce((sum, bounty) => {
      const tokenInfo = tokenInfos[bounty.rewardToken.toLowerCase()];
      return sum + Number(bounty.amount) / 10 ** (tokenInfo?.decimals || 18);
    }, 0);
    
    const totalNativeFromBounties = nativeBounties.reduce((sum, bounty) => {
      const tokenInfo = tokenInfos[bounty.rewardToken.toLowerCase()];
      return sum + Number(bounty.amount) / 10 ** (tokenInfo?.decimals || 18);
    }, 0);
    
    // Calculate conversion ratio: native → sdToken (from the vault deposit)
    // totalNativeIn includes both direct native rewards and native swapped from WETH
    // So we need to isolate the sdToken portion that came from native tokens
    const conversionRatio = flows.totalNativeIn > 0 ? flows.totalSdTokenOut / flows.totalNativeIn : 1;

    // Distribute sdToken values to bounties
    bounties.forEach((bounty) => {
      const tokenInfo = tokenInfos[bounty.rewardToken.toLowerCase()];
      const formattedAmount = Number(bounty.amount) / 10 ** (tokenInfo?.decimals || 18);
      const rewardToken = bounty.rewardToken.toLowerCase();
      
      if (rewardToken === sdTokenAddress) {
        // sdToken rewards: sdValue equals the amount (1:1)
        bounty.sdTokenAmount = formattedAmount;
        bounty.share = 0; // Not included in percentage calculation
      } else if (rewardToken === nativeAddress) {
        // Native token rewards: Convert to sdToken using the vault deposit ratio
        bounty.sdTokenAmount = formattedAmount * conversionRatio;
        bounty.share = 0; // Not included in percentage calculation
      } else if (rewardToken === wethAddress) {
        // WETH rewards: Need to calculate what portion of sdToken they represent
        // WETH was swapped to native, then native was deposited to get sdToken
        // So: WETH → native → sdToken
        // The sdTokenOut we see includes the native tokens that were deposited
        // We need to figure out how much native was generated from WETH, then apply conversion
        
        // All the native that went in (totalNativeIn) came from either:
        // 1. Direct native bounties (totalNativeFromBounties)
        // 2. WETH swapped to native (the rest)
        
        // The native from WETH would be: totalNativeIn - totalNativeFromBounties
        // But we need to be careful - if there's no direct native bounty tracking, 
        // assume all native came from WETH swaps
        
        if (totalWethFromBounties > 0 && flows.totalSdTokenOut > 0) {
          // Calculate this WETH bounty's share of total WETH
          const wethShare = formattedAmount / totalWethFromBounties;
          
          // The sdToken output attributable to WETH bounties is:
          // totalSdTokenOut * (portion of nativeIn that came from WETH)
          // If we have both WETH and native bounties, we need to split fairly
          // For now, assume all sdTokenOut is proportionally split by the bounty amounts
          
          const nativeFromWeth = totalNativeFromBounties > 0 
            ? Math.max(0, flows.totalNativeIn - totalNativeFromBounties)
            : flows.totalNativeIn;
          
          const sdTokenFromWeth = nativeFromWeth * conversionRatio;
          bounty.sdTokenAmount = wethShare * sdTokenFromWeth;
          bounty.share = wethShare;
        } else {
          bounty.sdTokenAmount = 0;
          bounty.share = 0;
        }
      } else {
        // Other token rewards
        bounty.sdTokenAmount = 0;
        bounty.share = 0;
      }
    });
  });

  // Step 4: Convert to CSV rows
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

    // For OTC reports, we include all rows regardless of sdToken value
    groupedRows[protocol] = Object.values(mergedRows);
  });

  return groupedRows;
}

export default processOTCReport;