// ABOUTME: report2 fetch stage
// ABOUTME: Fetch swap events and token infos based on collected bounties

import { createPublicClient, http } from "viem";
import path from "path";
import dotenv from "dotenv";
import { mainnet } from "../../utils/chains";
import {
  getTimestampsBlocks,
  collectAllTokens,
  fetchAllTokenInfos,
  fetchSwapInEvents,
  fetchSwapOutEvents,
  PROTOCOLS_TOKENS,
  ALL_MIGHT,
} from "../../utils/reportUtils";
import { CollectOutput, FetchOutput, Protocol } from "./types";
import { ensureDir, readJson, stagePath, writeJson } from "./io";

dotenv.config();

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

export async function cmdFetch(protocol: Protocol, period: number) {
  const collect: CollectOutput = readJson(stagePath(period, protocol, "collect"), null);
  if (!collect) throw new Error(`collect artifact not found for ${protocol} ${period}`);

  // Resolve blocks range: prefer collect's sources if present; otherwise use current week
  const useBlocks = (collect.sources.blockNumber1 && collect.sources.blockNumber2)
    ? { from: collect.sources.blockNumber1, to: collect.sources.blockNumber2 }
    : (() => {
        // fallback to current week
        return { from: 0, to: 0 };
      })();

  let blocks = useBlocks;
  if (blocks.from === 0 || blocks.to === 0) {
    const { blockNumber1, blockNumber2 } = await getTimestampsBlocks(publicClient, 0);
    blocks = { from: blockNumber1, to: blockNumber2 };
  }

  // Tokens and infos
  const bountiesByProtocol = { [protocol]: Object.values(collect.bounties[protocol] || {}) } as any;
  const tokens = Array.from(collectAllTokens(bountiesByProtocol, PROTOCOLS_TOKENS));
  const tokenInfos = await fetchAllTokenInfos(tokens, publicClient);

  // Swap events at aggregator
  const swapsIn = await fetchSwapInEvents(1, blocks.from, blocks.to, tokens, ALL_MIGHT);
  const swapsOut = await fetchSwapOutEvents(1, blocks.from, blocks.to, tokens, ALL_MIGHT);

  const out: FetchOutput = {
    period,
    protocol,
    blocks,
    tokens,
    tokenInfos,
    swapsIn,
    swapsOut,
    counts: { in: swapsIn.length, out: swapsOut.length },
  };

  const outPath = stagePath(period, protocol, "fetch");
  ensureDir(path.dirname(outPath));
  writeJson(outPath, out);
  return outPath;
}
