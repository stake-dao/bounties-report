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

export type Protocol = "vlCVX" | "vlAURA" | "bounties" | "all";

export type Verdict = "pass" | "fail" | "warning";

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
  /** Optional per-script metric notes extracted by the LLM (key = script label). */
  scriptNotes?: Record<string, string>;
}

export interface ModelVerdict {
  model: string;
  verdict: Verdict | null;
  summary?: string;
  issues?: string[];
  scriptNotes?: Record<string, string>;
  error?: string;
  ms: number;
}

export interface ConsensusResult extends VerificationResult {
  modelVerdicts: ModelVerdict[];
  consensusMethod: "unanimous" | "majority" | "script-only";
}

// ── Script registry ───────────────────────────────────────────────────────────

interface VerifyScript {
  label: string;
  path: string;
  /** Return extra CLI args given the week timestamp. */
  args: (timestamp: number) => string[];
  protocols: Protocol[];
  note?: string;
}

const SCRIPTS: VerifyScript[] = [
  // ── vlCVX ───────────────────────────────────────────────────
  {
    label: "vlCVX Distribution Verification",
    path: "script/vlCVX/verify/distribution.ts",
    args: (ts) => ["--timestamp", String(ts)],
    protocols: ["vlCVX", "all"],
  },
  {
    label: "vlCVX Reward Flow Verification",
    path: "script/vlCVX/verify/rewardFlow.ts",
    args: (ts) => ["--timestamp", String(ts)],
    protocols: ["vlCVX", "all"],
  },
  {
    label: "vlCVX Claims Completeness",
    path: "script/vlCVX/verify/claimsCompleteness.ts",
    args: (ts) => ["--timestamp", String(ts)],
    protocols: ["vlCVX", "all"],
  },
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
  // ── bounties report ─────────────────────────────────────────
  {
    label: "Bounties Report Verification",
    path: "script/verify/verifyBountiesReport.ts",
    args: (ts) => ["--epoch", String(ts)],
    protocols: ["bounties", "all"],
  },
  // ── vlAURA ──────────────────────────────────────────────────
  {
    label: "vlAURA Distribution Verification",
    path: "script/vlAURA/verify/distribution.ts",
    args: (ts) => ["--timestamp", String(ts)],
    protocols: ["vlAURA", "all"],
  },
  {
    label: "vlAURA Reward Flow Verification",
    path: "script/vlAURA/verify/rewardFlow.ts",
    args: (ts) => ["--timestamp", String(ts)],
    protocols: ["vlAURA", "all"],
  },
  {
    label: "vlAURA RPC delegators",
    path: "script/vlAURA/verify/delegators-rpc.ts",
    args: () => [],
    protocols: ["vlAURA", "all"],
  },
  {
    label: "vlAURA delegation timing",
    path: "script/vlAURA/verify/delegation-timing.ts",
    args: () => [],
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
 * Run all verification scripts and return their raw outputs.
 * Call this once and reuse `scripts` across multiple model calls.
 */
export function runScripts(timestamp: number, protocol: Protocol): ScriptResult[] {
  return SCRIPTS
    .filter((s) => s.protocols.includes(protocol))
    .map((s) => {
      console.log(`  → ${s.path}${s.note ? ` [${s.note}]` : ""}`);
      const r = spawnScript(s.path, s.args(timestamp));
      r.label = s.label;
      return r;
    });
}

/**
 * Optional domain-specific context injected into the LLM prompt per protocol.
 * Keeps protocol-specific knowledge out of the generic prompt template.
 * Add an entry here when a new protocol has known triage rules or quirks.
 */
const PROTOCOL_CONTEXT: Partial<Record<Protocol, string>> = {
  bounties: `Bounties report triage rules:
- ⚠️  "frax attribution not present" → expected (frax is OTC-only, no aggregator swap)
- ⚠️  "pendle direct distribution" → expected (wethNotSwapped=true, pendle uses direct route)
- ⚠️  "dropped token" (ORDER mismatch) → usually a cross-chain token (e.g. Base USDC) that can't be swapped by the mainnet aggregator; classify as warning unless the token has no CSV entry at all
- ❌  "gauge in claimed_bounties but NOT in any CSV" → CRITICAL: bounty claimed on-chain but not distributed
- ❌  "sdInTotal mismatch > 0.5%" → CRITICAL: swap amounts don't reconcile with CSV
- ❌  CSV file missing for a non-empty protocol → CRITICAL
Root gauge note: Curve L2 gauges (rootGauge on Arbitrum/Base) are resolved to their mainnet gauge before checking the CSV — a failed resolution is a data issue, not a false positive.`,
  vlCVX: `CSV mismatch triage for vlCVX:
1. CSV diff≠0 + token NOT in merkle → CRITICAL FAIL: funds computed but never distributed.
2. CSV diff≠0 + token IS in merkle  → WARNING only: known cause — isWrapped=true bounties on Arbitrum/Base votemarket-v2 produce unwrapped tokens that bypass the CSV generator. Funds reached delegators correctly.
When you see a CSV mismatch, check whether the script output mentions the token appearing in merkle claims. If merkle claim count for that token is non-zero, classify as warning not fail.
Base-file triage for vlCVX:
1. If "vlCVX Claims Completeness" shows zero Base claims implicitly (Curve claims match Mainnet-only CSV rows, no 8453 rows) OR the distribution/reward-flow scripts explicitly say "no 8453 entries in CSV" / "Curve Base skipped", then missing Base-specific files are EXPECTED and must not be treated as fail or warning.
2. Only treat missing Base-specific files as fail if there is evidence Base claims should exist (8453 CSV rows, Base claims in claimed_bounties, or script output says Base data required).`,
  vlAURA: `CSV mismatch triage for vlAURA:
1. CSV diff≠0 + token NOT in merkle → CRITICAL FAIL: funds computed but never distributed.
2. CSV diff≠0 + token IS in merkle  → WARNING only: known cause — isWrapped=true bounties on Arbitrum/Base votemarket-v2 produce unwrapped tokens that bypass the CSV generator. Funds reached delegators correctly.
When you see a CSV mismatch, check whether the script output mentions the token appearing in merkle claims. If merkle claim count for that token is non-zero, classify as warning not fail.`,
};

/**
 * Build the LLM prompt from collected script outputs.
 */
function buildPrompt(timestamp: number, protocol: Protocol, scripts: ScriptResult[]): string {
  const date = new Date(timestamp * 1000).toISOString().split("T")[0];
  const sections = scripts
    .map((s) => `────────── ${s.label} (exit ${s.exitCode}) ──────────\n${s.output}`)
    .join("\n\n");

  const basePrompt = `You are a DeFi protocol engineer reviewing automated distribution verification for Stake DAO bounty distributions (vlCVX / vlAURA / bounties report).

Week: ${timestamp} (${date})  |  Protocol: ${protocol}

${sections}

Respond with ONLY a raw JSON object (no markdown, no text outside JSON):
{
  "verdict": "pass" | "fail" | "warning",
  "summary": "<one concise sentence, max 20 words>",
  "issues": ["<issue>", ...],
  "script_notes": { "<exact script label>": "<brief metric phrase>" }
}

Issue writing rules:
- Each issue is ONE short sentence, max 15 words.
- Name the check that failed and the count/scope — do NOT embed raw hex addresses or large integers.
- Bad:  "0x0901...e5f6 diff=20349206294183918416061799"
- Good: "Cumulative merkle mismatch for 8 Curve Mainnet tokens"

script_notes rules:
- Key must be the EXACT script label shown in the section header (e.g. "vlCVX Distribution Verification").
- Value is a short phrase (max 10 words) with the most informative numbers from that script's output.
- You MUST include a note for EVERY script — only omit if the script produced no output at all.
- Per-script guidance (extract these specific numbers):
  - "* Distribution Verification" → merkle claim count + token count, e.g. "234 claims, 18 tokens"
  - "* Reward Flow Verification" → CSV balance result + chain count, e.g. "CSV balanced (3 chains)" or "CSV diff on 2 tokens"
  - "* Claims Completeness" → total claims + Curve/FXN split, e.g. "20 claims (14 Curve / 6 FXN)"
  - "* parquet delegators" → delegator count + forwarder/non-fwd split, e.g. "315: 89 fwd / 226 non-fwd"
  - "* RPC delegators" → active delegator count + zero-VP filtered count, e.g. "315 active, 43 zero-VP"
  - "* delegation timing" → snapshot block used, e.g. "block 22300000"
  - "Bounties Report Verification" → gauge/CSV row counts or failure reason, e.g. "42 gauges, 3 CSVs" or "CSV files missing"

Verdict rules:
- "pass"    → all ✅, zero ❌
- "fail"    → any ❌ on: missing required files, invalid merkle root, delegation address in merkle, BigInt group-split mismatch, delegators in file not found via RPC, CSV diff≠0 AND token NOT in merkle (undistributed funds)
- "warning" → only non-critical: optional file absent, week-over-week >20%, ⚠️ RPC warnings where counts still match, CSV diff≠0 BUT token IS present in merkle (reporting gap only — funds distributed correctly but CSV is incomplete)
- Missing Base-specific vlCVX files are NOT "missing required files" when claims/CSV evidence shows no Base activity that week.
Issues must be empty when verdict is "pass".`;

  const context = PROTOCOL_CONTEXT[protocol as keyof typeof PROTOCOL_CONTEXT];
  if (context) return `${basePrompt}\n\n${context}`;
  return basePrompt;
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
  scripts: ScriptResult[]
): Promise<VerificationResult> {
  const allOk = scripts.every((s) => s.exitCode === 0);
  const fallback = {
    verdict: (allOk ? "pass" : "fail") as Verdict,
    summary: allOk
      ? "All checks passed (LLM analysis unavailable)"
      : "Verification failures detected (LLM analysis unavailable)",
    issues: allOk ? [] : ["See raw script output for details"],
  };

  const prompt = buildPrompt(timestamp, protocol, scripts);
  const { result: parsed, error } = await client.analyzeJson<{
    verdict: Verdict;
    summary: string;
    issues: string[];
    script_notes?: Record<string, string>;
  }>(prompt, fallback, { maxTokens: 2048, timeout: 90_000 });

  if (error) console.warn(`  ⚠️  LLM error (${client.model}): ${error}`);

  return {
    verdict: parsed.verdict,
    summary: parsed.summary,
    issues: parsed.issues ?? [],
    scripts,
    scriptNotes: parsed.script_notes,
  };
}

/**
 * Convenience: run scripts then analyze — the common single-model path.
 */
export async function verify(
  client: LLMClient,
  timestamp: number,
  protocol: Protocol = "all"
): Promise<VerificationResult> {
  const date = new Date(timestamp * 1000).toISOString().split("T")[0];

  console.log(`\n[verify] week ${timestamp} (${date}), protocol=${protocol}, model=${client.model}`);

  const scripts = runScripts(timestamp, protocol);
  console.log(`  → analyzing with ${client.model} (${client.provider})`);
  return analyze(client, timestamp, protocol, scripts);
}

// ── Multi-model consensus ────────────────────────────────────────────────────

const VERDICT_RANK: Record<Verdict, number> = { pass: 0, warning: 1, fail: 2 };

function resolveConsensus(
  modelVerdicts: ModelVerdict[],
  allScriptsPass: boolean
): { verdict: Verdict; method: ConsensusResult["consensusMethod"] } {
  const responded = modelVerdicts.filter((m) => m.verdict !== null);

  if (responded.length === 0) {
    return {
      verdict: allScriptsPass ? "pass" : "fail",
      method: "script-only",
    };
  }

  const counts: Record<Verdict, number> = { pass: 0, warning: 0, fail: 0 };
  for (const m of responded) counts[m.verdict!]++;

  const unanimous = responded.every((m) => m.verdict === responded[0].verdict);
  if (unanimous) {
    let verdict = responded[0].verdict!;
    if (verdict === "fail" && allScriptsPass) verdict = "warning";
    return { verdict, method: "unanimous" };
  }

  let majority: Verdict = "pass";
  let maxCount = 0;
  for (const v of ["fail", "warning", "pass"] as Verdict[]) {
    if (counts[v] > maxCount) {
      maxCount = counts[v];
      majority = v;
    } else if (counts[v] === maxCount && VERDICT_RANK[v] > VERDICT_RANK[majority]) {
      majority = v;
    }
  }

  if (majority === "fail" && allScriptsPass) majority = "warning";
  return { verdict: majority, method: "majority" };
}

/**
 * Run scripts once, query multiple models in parallel, resolve by consensus.
 * Scripts are the source of truth — if all pass and every LLM is down, verdict = pass.
 */
export async function verifyWithConsensus(
  clients: LLMClient[],
  timestamp: number,
  protocol: Protocol = "all"
): Promise<ConsensusResult> {
  const date = new Date(timestamp * 1000).toISOString().split("T")[0];
  const modelNames = clients.map((c) => c.model).join(", ");

  console.log(`\n[verify] week ${timestamp} (${date}), protocol=${protocol}`);
  console.log(`  models: ${modelNames}`);

  const scripts = runScripts(timestamp, protocol);
  const allScriptsPass = scripts.every((s) => s.exitCode === 0);

  console.log(`  scripts: ${scripts.map((s) => `${s.label}(${s.exitCode})`).join(", ")}`);
  console.log(`  → querying ${clients.length} models in parallel…`);

  const LLM_UNAVAILABLE_MARKER = "LLM analysis unavailable";

  const modelVerdicts: ModelVerdict[] = await Promise.all(
    clients.map(async (client): Promise<ModelVerdict> => {
      const t0 = Date.now();
      try {
        const result = await analyze(client, timestamp, protocol, scripts);
        const llmFailed = result.summary.includes(LLM_UNAVAILABLE_MARKER);
        if (llmFailed) {
          return {
            model: client.model,
            verdict: null,
            error: `LLM returned fallback (API error)`,
            ms: Date.now() - t0,
          };
        }
        return {
          model: client.model,
          verdict: result.verdict,
          summary: result.summary,
          issues: result.issues,
          scriptNotes: result.scriptNotes,
          ms: Date.now() - t0,
        };
      } catch (err) {
        return {
          model: client.model,
          verdict: null,
          error: String(err),
          ms: Date.now() - t0,
        };
      }
    })
  );

  const { verdict, method } = resolveConsensus(modelVerdicts, allScriptsPass);

  const responded = modelVerdicts.filter((m) => m.verdict !== null);
  const best = responded.find((m) => m.verdict === verdict) ?? responded[0];

  const scriptOnlySummary = allScriptsPass
    ? `All ${scripts.length} scripts passed — no LLM response, verdict from scripts only`
    : `${scripts.filter((s) => s.exitCode !== 0).length}/${scripts.length} scripts failed — no LLM response, verdict from scripts only`;

  return {
    verdict,
    summary: best?.summary ?? scriptOnlySummary,
    issues: best?.issues ?? (allScriptsPass ? [] : ["See raw script output for details"]),
    scripts,
    scriptNotes: best?.scriptNotes,
    modelVerdicts,
    consensusMethod: method,
  };
}
