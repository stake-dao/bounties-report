// ABOUTME: report2 filter stage
// ABOUTME: Apply OTC, delegation, and protocol-specific filters; keep a summary

import path from "path";
import { Protocol, CollectOutput, FetchOutput, FilterOutput } from "./types";
import { ensureDir, readJson, stagePath, writeJson } from "./io";
import {
  processSwaps,
  processSwapsOTC,
  fetchDelegationEvents,
  fetchSwapInEvents,
  PROTOCOLS_TOKENS,
  ALL_MIGHT,
} from "../../utils/reportUtils";

import { VLCVX_DELEGATORS_RECIPIENT, DELEGATION_RECIPIENT } from "../../utils/constants";

export async function cmdFilter(protocol: Protocol, period: number) {
  const collect: CollectOutput = readJson(stagePath(period, protocol, "collect"), null);
  const fetched: FetchOutput = readJson(stagePath(period, protocol, "fetch"), null);
  if (!collect || !fetched) throw new Error(`collect/fetch artifacts missing for ${protocol} ${period}`);

  const tokenInfos = fetched.tokenInfos as any;

  // Identify OTC swaps (by from=OTC) to exclude their blocks
  const otcSwapsIn = processSwapsOTC(fetched.swapsIn as any, tokenInfos);
  const otcBlocks = Array.from(new Set(otcSwapsIn.map((s: any) => s.blockNumber)));

  // Process all swaps with generic filtering
  let inProcessed = processSwaps(fetched.swapsIn as any, tokenInfos);
  let outProcessed = processSwaps(fetched.swapsOut as any, tokenInfos);

  // Exclude OTC blocks
  inProcessed = inProcessed.filter((s: any) => !otcBlocks.includes(s.blockNumber));
  outProcessed = outProcessed.filter((s: any) => !otcBlocks.includes(s.blockNumber));

  // Delegation: exclude tokens moved to delegation recipient on a per-token per-tx basis
  const allTokensLower = new Set((fetched.tokens || []).map((t) => t.toLowerCase()));
  const delegationEvents = await fetchDelegationEvents(1, fetched.blocks.from, fetched.blocks.to, Array.from(allTokensLower), DELEGATION_RECIPIENT);
  const delegatedMap = new Map<string, Set<string>>(); // token -> txs set
  delegationEvents.forEach((e) => {
    const t = e.token.toLowerCase();
    const tx = (e.transactionHash || "").toLowerCase();
    if (!delegatedMap.has(t)) delegatedMap.set(t, new Set());
    delegatedMap.get(t)!.add(tx);
  });

  const beforeIn = inProcessed.length, beforeOut = outProcessed.length;
  inProcessed = inProcessed.filter((s: any) => {
    const t = s.token.toLowerCase();
    const tx = (s.transactionHash || "").toLowerCase();
    const set = delegatedMap.get(t);
    return !set || !set.has(tx);
  });
  outProcessed = outProcessed.filter((s: any) => {
    const t = s.token.toLowerCase();
    const tx = (s.transactionHash || "").toLowerCase();
    const set = delegatedMap.get(t);
    return !set || !set.has(tx);
  });

  // Protocol sdToken presence filter (only retain txs that include protocol sdToken)
  const sdAddr = PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase();
  const txWithSd = new Set<string>();
  inProcessed.forEach((s: any) => { if (s.token.toLowerCase() === sdAddr) txWithSd.add((s.transactionHash || "").toLowerCase()); });
  outProcessed.forEach((s: any) => { if (s.token.toLowerCase() === sdAddr) txWithSd.add((s.transactionHash || "").toLowerCase()); });
  inProcessed = inProcessed.filter((s: any) => txWithSd.has((s.transactionHash || "").toLowerCase()));
  outProcessed = outProcessed.filter((s: any) => txWithSd.has((s.transactionHash || "").toLowerCase()));

  // vlCVX delegators recipient: exclude sdCRV incoming blocks to avoid counting those as mints (curve-specific recipient)
  const vlcvxExcludeSwaps = await fetchSwapInEvents(1, fetched.blocks.from, fetched.blocks.to, [PROTOCOLS_TOKENS.curve.sdToken], VLCVX_DELEGATORS_RECIPIENT);
  const vlcvxExcludedBlocks = vlcvxExcludeSwaps.map((s) => s.blockNumber);
  inProcessed = inProcessed.filter((s: any) => !vlcvxExcludedBlocks.includes(s.blockNumber));

  const reasons: Record<string, number> = {
    otcBlock: otcBlocks.length,
    delegatedTokensDropped: (beforeIn - inProcessed.length) + (beforeOut - outProcessed.length),
    sdPresenceTxs: txWithSd.size,
    vlcvxExcludedBlocks: vlcvxExcludedBlocks.length,
  };

  const out: FilterOutput = {
    period,
    protocol,
    sdToken: PROTOCOLS_TOKENS[protocol].sdToken,
    excluded: {
      otcBlocks,
      delegatedTokensCount: Array.from(delegatedMap.values()).reduce((a, s) => a + s.size, 0),
      vlcvxExcludedBlocks,
      reasons,
    },
    filtered: {
      in: inProcessed,
      out: outProcessed,
    },
  };

  const outPath = stagePath(period, protocol, "filter");
  ensureDir(path.dirname(outPath));
  writeJson(outPath, out);
  return outPath;
}
