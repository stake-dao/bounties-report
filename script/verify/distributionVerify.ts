/**
 * Distribution verification orchestrator.
 *
 * Runs vlCVX / vlAURA verification scripts as subprocesses, builds a prompt
 * from their output, and delegates analysis to any LLMClient.
 *
 * Fast mode  : verifyDistribution.ts + verifyRewardFlow.ts  (~5s, no network)
 * Deep mode  : + RPC/parquet delegation scripts             (~2-3 min)
 *
 * All public exports are plain functions — no class, no state.
 */

import { spawnSync } from "child_process";
import * as path from "path";
import type { LLMClient } from "../utils/llmClient";

const PROJECT_ROOT = path.join(__dirname, "../../");
const MAX_BUFFER = 10 * 1024 * 1024;

// ── Types ─────────────────────────────────────────────────────────────────────

export type Protocol = "vlCVX" | "vlAURA" | "all";

type Verdict = "pass" | "fail" | "warning";

export interface ScriptResult {
  label: string;
  output: string;
  exitCode: number;
}

export interface VerificationResult {
  verdict: Verdict;
  summary: string;
  issues: string[];
  scripts: ScriptResult[];
}

interface VerifyOptions {
  deep?: boolean;
}

// ── Deep script registry ──────────────────────────────────────────────────────

interface DeepScript {
  label: string;
  path: string;
  /** Return extra CLI args given the week timestamp. */
  args: (timestamp: number) => string[];
  protocols: Protocol[];
  note?: string;
}

const DEEP_SCRIPTS: DeepScript[] = [
  {
    label: "vlCVX parquet delegators",
    path: "script/vlCVX/verify/verifyDelegators.ts",
    args: (ts) => ["--timestamp", String(ts), "--gauge-type", "all"],
    protocols: ["vlCVX", "all"],
  },
  {
    label: "vlCVX RPC delegators",
    path: "script/vlCVX/verify/delegators-rpc.ts",
    args: (ts) => ["--timestamp", String(ts), "--gauge-type", "all"],
    protocols: ["vlCVX", "all"],
  },
  {
    label: "vlAURA RPC delegators",
    path: "script/vlAURA/verify/delegators-rpc.ts",
    args: () => [], // uses current-week repartition file internally
    protocols: ["vlAURA", "all"],
  },
  {
    label: "vlAURA delegation timing",
    path: "script/vlAURA/verify/delegation-timing.ts",
    args: () => [], // snapshot blocks are hardcoded in the script
    protocols: ["vlAURA", "all"],
    note: "snapshot blocks hardcoded — update script if stale",
  },
];

// ── Internal helpers ──────────────────────────────────────────────────────────

function spawnScript(relPath: string, args: string[]): ScriptResult {
  const result = spawnSync("pnpm", ["tsx", relPath, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const out = result.stdout ?? "";
  const err = result.stderr ?? "";
  return {
    label: relPath,
    output: (err ? `${out}\n[stderr]\n${err}` : out).trim(),
    exitCode: result.status ?? 1,
  };
}

// ── Public functions ──────────────────────────────────────────────────────────

/**
 * Run verification scripts and return their raw outputs.
 * Call this once and reuse `scripts` across multiple model calls.
 */
export function runScripts(
  timestamp: number,
  protocol: Protocol,
  options: VerifyOptions = {}
): ScriptResult[] {
  const { deep = false } = options;
  const tsArgs = ["--timestamp", String(timestamp)];
  const scripts: ScriptResult[] = [];

  const runProtocol = (proto: "vlCVX" | "vlAURA") => {
    const p = proto.toLowerCase();
    console.log(`  → ${p}/verify/distribution.ts`);
    const d = spawnScript(`script/${proto}/verify/distribution.ts`, tsArgs);
    d.label = `${proto} Distribution Verification`;
    scripts.push(d);

    console.log(`  → ${p}/verify/rewardFlow.ts`);
    const f = spawnScript(`script/${proto}/verify/rewardFlow.ts`, tsArgs);
    f.label = `${proto} Reward Flow Verification`;
    scripts.push(f);
  };

  if (protocol === "vlCVX" || protocol === "all") runProtocol("vlCVX");
  if (protocol === "vlAURA" || protocol === "all") runProtocol("vlAURA");

  if (deep) {
    for (const def of DEEP_SCRIPTS) {
      if (!def.protocols.includes(protocol)) continue;
      console.log(`  → ${def.path}${def.note ? ` [${def.note}]` : ""}`);
      const r = spawnScript(def.path, def.args(timestamp));
      r.label = def.label;
      scripts.push(r);
    }
  }

  return scripts;
}

/**
 * Build the LLM prompt from collected script outputs.
 */
function buildPrompt(
  timestamp: number,
  protocol: Protocol,
  scripts: ScriptResult[],
  deep: boolean
): string {
  const date = new Date(timestamp * 1000).toISOString().split("T")[0];
  const sections = scripts
    .map((s) => `────────── ${s.label} (exit ${s.exitCode}) ──────────\n${s.output}`)
    .join("\n\n");

  return `You are a DeFi protocol engineer reviewing automated distribution verification for Stake DAO bounty distributions (vlCVX / vlAURA).

Week: ${timestamp} (${date})  |  Protocol: ${protocol}  |  Mode: ${deep ? "deep" : "fast"}

${sections}

Respond with ONLY a raw JSON object (no markdown, no text outside JSON):
{
  "verdict": "pass" | "fail" | "warning",
  "summary": "<one concise sentence>",
  "issues": ["<specific problem>", ...]
}

Verdict rules:
- "pass"    → all ✅, zero ❌
- "fail"    → any ❌ on: missing required files, invalid merkle root, delegation address in merkle, BigInt group-split mismatch, delegators in file not found via RPC, CSV diff≠0 AND token NOT in merkle (undistributed funds)
- "warning" → only non-critical: optional file absent, week-over-week >20%, ⚠️ RPC warnings where counts still match, CSV diff≠0 BUT token IS present in merkle (reporting gap only — funds distributed correctly but CSV is incomplete)
Issues must be empty when verdict is "pass".

IMPORTANT — CSV mismatch triage (two very different severities):
1. CSV diff≠0 + token NOT in merkle → CRITICAL FAIL: funds were computed but never distributed
2. CSV diff≠0 + token IS in merkle  → WARNING only: the CSV is an incomplete report (known cause: isWrapped=true bounties on Arbitrum/Base votemarket-v2 produce unwrapped tokens that bypass the CSV generator). Funds reached delegators correctly.
When you see a CSV mismatch, check whether the script output mentions the token appearing in merkle claims. If the merkle claim count for that token is non-zero, classify as warning not fail.`;
}

/**
 * Ask a specific LLM client to analyze pre-collected script outputs.
 * Separating this from runScripts() lets compareModels.ts query N models
 * against the same outputs without re-running the scripts.
 */
export async function analyze(
  client: LLMClient,
  timestamp: number,
  protocol: Protocol,
  scripts: ScriptResult[],
  deep: boolean
): Promise<VerificationResult> {
  const allOk = scripts.every((s) => s.exitCode === 0);
  const fallback = {
    verdict: (allOk ? "pass" : "fail") as Verdict,
    summary: allOk
      ? "All checks passed (LLM analysis unavailable)"
      : "Verification failures detected (LLM analysis unavailable)",
    issues: allOk ? [] : ["See raw script output for details"],
  };

  const prompt = buildPrompt(timestamp, protocol, scripts, deep);
  const { result: parsed, error } = await client.analyzeJson<{
    verdict: Verdict;
    summary: string;
    issues: string[];
  }>(prompt, fallback, { maxTokens: 1024, timeout: 90_000 });

  if (error) console.warn(`  ⚠️  LLM error (${client.model}): ${error}`);

  return {
    verdict: parsed.verdict,
    summary: parsed.summary,
    issues: parsed.issues ?? [],
    scripts,
  };
}

/**
 * Convenience: run scripts then analyze — the common single-model path.
 */
export async function verify(
  client: LLMClient,
  timestamp: number,
  protocol: Protocol = "all",
  options: VerifyOptions = {}
): Promise<VerificationResult> {
  const { deep = false } = options;
  const date = new Date(timestamp * 1000).toISOString().split("T")[0];

  console.log(
    `\n[verify] week ${timestamp} (${date}), protocol=${protocol}, mode=${deep ? "deep" : "fast"}, model=${client.model}`
  );

  const scripts = runScripts(timestamp, protocol, options);
  console.log(`  → analyzing with ${client.model} (${client.provider})`);
  return analyze(client, timestamp, protocol, scripts, deep);
}
