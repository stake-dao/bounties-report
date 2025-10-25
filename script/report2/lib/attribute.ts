// ABOUTME: report2 attribute stage
// ABOUTME: Map per-tx receipts to assign sd to tokens and compute per-token totals

import path from "path";
import { createPublicClient, http } from "viem";
import dotenv from "dotenv";
import { mainnet } from "../../utils/chains";
import { Protocol, CollectOutput, FetchOutput, FilterOutput, AttributeOutput } from "./types";
import { ensureDir, readJson, stagePath, writeJson } from "./io";
import { mapTokenSwapsToOutToken, PROTOCOLS_TOKENS, WETH_ADDRESS } from "../../utils/reportUtils";

dotenv.config();

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

export async function cmdAttribute(protocol: Protocol, period: number) {
  const collect: CollectOutput = readJson(stagePath(period, protocol, "collect"), null);
  const fetched: FetchOutput = readJson(stagePath(period, protocol, "fetch"), null);
  const filtered: FilterOutput = readJson(stagePath(period, protocol, "filter"), null);
  if (!collect || !fetched || !filtered) throw new Error(`collect/fetch/filter artifacts missing for ${protocol} ${period}`);

  const wethAddr = WETH_ADDRESS.toLowerCase();
  const nativeAddr = PROTOCOLS_TOKENS[protocol].native.toLowerCase();
  const sdAddr = PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase();

  // Included tokens based on bounties (excluding native/sd)
  const includedTokens = new Set<string>();
  for (const bounty of Object.values(collect.bounties[protocol] || {})) {
    const t = String((bounty as any).rewardToken || "").toLowerCase();
    if (t && t !== nativeAddr && t !== sdAddr) includedTokens.add(t);
  }

  // Aggregate per-token sd attribution by walking receipts per tx
  const txs = Array.from(new Set([
    ...filtered.filtered.in.map((e: any) => e.transactionHash).filter(Boolean),
    ...filtered.filtered.out.map((e: any) => e.transactionHash).filter(Boolean),
  ] as string[]));

  const includedSdByToken: Record<string, number> = {};
  const txAttributions: Array<{ tx: string; mapped: Record<string, string> }> = [];

  // sd minted in this set (from filtered in events)
  const sdMintedTotal = (filtered.filtered.in as any[])
    .filter((e) => String(e.token).toLowerCase() === sdAddr)
    .reduce((s, e) => s + (e.formattedAmount || 0), 0);

  // Basis for proportional attribution
  const wethIn = (filtered.filtered.in as any[])
    .filter((e) => String(e.token).toLowerCase() === wethAddr)
    .reduce((s, e) => s + (e.formattedAmount || 0), 0);
  const wethOut = (filtered.filtered.out as any[])
    .filter((e) => String(e.token).toLowerCase() === wethAddr)
    .reduce((s, e) => s + (e.formattedAmount || 0), 0);

  for (const tx of txs) {
    const inTx = (filtered.filtered.in as any[]).filter((e) => e.transactionHash === tx);
    const sdInTx = inTx.filter((e) => String(e.token).toLowerCase() === sdAddr)
      .reduce((a, b) => a + (b.formattedAmount || 0), 0);
    if (sdInTx <= 0) continue;

    const inWeth = inTx.filter((e) => String(e.token).toLowerCase() === wethAddr)
      .reduce((a, b) => a + (b.formattedAmount || 0), 0);
    const outWeth = (filtered.filtered.out as any[])
      .filter((e) => e.transactionHash === tx && String(e.token).toLowerCase() === wethAddr)
      .reduce((a, b) => a + (b.formattedAmount || 0), 0);
    const wethBasis = inWeth > 0 ? inWeth : outWeth;
    if (wethBasis <= 0) continue;

    let tokenToOut: Record<string, bigint> = {};
    try {
      tokenToOut = await mapTokenSwapsToOutToken(publicClient, tx as `0x${string}` , includedTokens, wethAddr, require("../../utils/reportUtils").ALL_MIGHT);
    } catch {
      continue;
    }
    const sdPerWeth = sdInTx / wethBasis;
    let mapped: Record<string, string> = {};
    for (const [tok, amt] of Object.entries(tokenToOut)) {
      const t = tok.toLowerCase();
      if (!includedTokens.has(t)) continue;
      const v = Number(amt) / 1e18 * sdPerWeth;
      includedSdByToken[t] = (includedSdByToken[t] || 0) + v;
      mapped[t] = v.toFixed(12);
    }
    // Residual WETH to WETH bucket
    const totalMappedWeth = Object.values(tokenToOut).reduce((s, a) => s + Number(a) / 1e18, 0);
    const residual = Math.max(0, wethBasis - totalMappedWeth);
    if (residual > 0) {
      includedSdByToken[wethAddr] = (includedSdByToken[wethAddr] || 0) + residual * sdPerWeth;
      mapped[wethAddr] = (residual * sdPerWeth).toFixed(12);
    }
    txAttributions.push({ tx, mapped });
  }

  const out: AttributeOutput = {
    period,
    protocol,
    sdMintedTotal,
    wethTotals: { in: wethIn, out: wethOut },
    includedTokens: Array.from(includedTokens),
    includedSdByToken,
    txAttributions,
  };

  const outPath = stagePath(period, protocol, "attribute");
  ensureDir(path.dirname(outPath));
  writeJson(outPath, out);
  return outPath;
}
