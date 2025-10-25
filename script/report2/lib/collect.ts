// ABOUTME: report2 collect stage
// ABOUTME: Normalize bounties per protocol and write a trace artifact

import path from "path";
import { Protocol, CollectOutput } from "./types";
import { collectSourcePaths, ensureDir, readJson, stagePath, writeJson } from "./io";

export async function cmdCollect(protocol: Protocol, period: number, rootDir: string) {
  const src = collectSourcePaths(period);

  const raw: any = {
    votemarket: readJson(src.votemarket, {}),
    votemarket_v2: readJson(src.votemarket_v2, {}),
    warden: readJson(src.warden, {}),
    hiddenhand: readJson(src.hiddenhand, {}),
  };

  const timestamps = {
    timestamp1: raw?.votemarket?.timestamp1 || 0,
    timestamp2: raw?.votemarket?.timestamp2 || 0,
    blockNumber1: raw?.votemarket?.blockNumber1 || 0,
    blockNumber2: raw?.votemarket?.blockNumber2 || 0,
  };

  // v2 filtering: drop explicitly unwrapped entries
  const v2Filtered = Object.entries((raw.votemarket_v2 || {}) as Record<string, any>)
    .reduce((acc, [key, value]) => {
      if (!value || typeof value !== "object") return acc;
      const ns: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        if ((v as any)?.isWrapped !== false) ns[k] = v;
      }
      acc[key] = ns;
      return acc;
    }, {} as Record<string, Record<string, any>>);

  const protos: Protocol[] = ["curve", "balancer", "fxn", "frax", "pendle"];
  const bounties: Record<Protocol, Record<string, any>> = {
    curve: {}, balancer: {}, fxn: {}, frax: {}, pendle: {}
  };
  for (const p of protos) {
    const parts = [
      (raw.votemarket || {})[p] || {},
      (v2Filtered || {})[p] || {},
      (raw.warden || {})[p] || {},
      (raw.hiddenhand || {})[p] || {},
    ];
    bounties[p] = Object.assign({}, ...parts);
  }

  const summary: Record<Protocol, number> = {
    curve: Object.keys(bounties.curve).length,
    balancer: Object.keys(bounties.balancer).length,
    fxn: Object.keys(bounties.fxn).length,
    frax: Object.keys(bounties.frax).length,
    pendle: Object.keys(bounties.pendle).length,
  };

  const narrowed: Record<Protocol, Record<string, any>> = { curve: {}, balancer: {}, fxn: {}, frax: {}, pendle: {} };
  narrowed[protocol] = bounties[protocol];

  const out: CollectOutput = {
    period,
    summary,
    sources: timestamps,
    bounties: narrowed,
  };

  const outPath = stagePath(period, protocol, "collect");
  ensureDir(path.dirname(outPath));
  writeJson(outPath, out);
  return outPath;
}
