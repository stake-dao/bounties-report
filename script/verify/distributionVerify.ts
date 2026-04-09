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
  /** LLM self-assessed confidence in verdict (0.0–1.0). */
  confidence?: number;
  /** Cross-script consistency notes surfaced by the LLM. */
  crossCheckNotes?: string[];
  /** Per-chain verdict breakdown (e.g. { mainnet: "pass", base: "warning" }). */
  chainStatus?: Record<string, Verdict>;
  /** Week A or B detected from proposalId comparison. */
  weekContext?: "A" | "B" | "unknown";
}

export interface ModelVerdict {
  model: string;
  verdict: Verdict | null;
  summary?: string;
  issues?: string[];
  scriptNotes?: Record<string, string>;
  confidence?: number;
  crossCheckNotes?: string[];
  chainStatus?: Record<string, Verdict>;
  weekContext?: "A" | "B" | "unknown";
  error?: string;
  ms: number;
}

export interface SnapshotProposal {
  label: string;
  space: string;
  proposalId: string;
}

/** Metadata extracted from week files / Snapshot API — passed to report formatters. */
export interface VerifyMetadata {
  timestamp: number;
  /** Snapshot proposals resolved for this verification run. */
  snapshotProposals?: SnapshotProposal[];
  /** Git HEAD short SHA at time of verification. */
  commitSha?: string;
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
When you see a CSV mismatch, check whether the script output mentions the token appearing in merkle claims. If merkle claim count for that token is non-zero, classify as warning not fail.`,
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

  const basePrompt = `You are a DeFi protocol engineer reviewing automated distribution verification for Stake DAO bounty distributions.

Week: ${timestamp} (${date})  |  Protocol: ${protocol}

## YOUR TASK
Analyze the verification script outputs below. Each script tests a different aspect of the distribution pipeline. You must:
1. Read each script's output and determine if it passed
2. Cross-validate numbers BETWEEN scripts (e.g., delegator counts from parquet vs RPC should be consistent)
3. Flag anything anomalous even if the script itself passed (counts outside baseline range, unexpected patterns)
4. Classify your confidence in the overall result

## BASELINE EXPECTATIONS (typical healthy week)
- vlCVX: 200–300 merkle claims, 30–50 tokens, 280–350 delegators, zero-VP filtered: 50–100
- vlAURA: 80–150 merkle claims, 3–8 tokens, 80–120 delegators
- CSV diff should be exactly 0 for all tokens
- Cumulative merkle: prev + this_week amounts (diff < 1e-9 relative is acceptable BigInt rounding)
- Group split (fwd + nfwd) must be exact (0 diff)
- Share ratio error < 1e-4

## IMPORTANT: TOKEN COUNT CONTEXT
Different scripts count tokens differently — this is normal, NOT a discrepancy:
- "Distribution Verification" counts unique tokens in THIS WEEK's merkle (current claims only)
- "Reward Flow" cumulative merkle counts tokens across ALL weeks (historical + current)
- CSV token count = tokens distributed this week per chain
These counts are expected to differ. Do NOT flag a mismatch between them.

## CROSS-SCRIPT CHECKS
After reading all outputs, verify:
- Parquet delegator count ≈ RPC delegator count (same gauge type)
- If Week B detected (same proposalId as prev week): delegator set must be identical to previous week
- If CSV diff ≠ 0: check if Reward Flow mentions the token in merkle claims (present → warning only; absent → fail)

## SCRIPT OUTPUTS
${sections}

## RESPONSE FORMAT
Respond with ONLY a raw JSON object (no markdown, no text outside JSON):
{
  "verdict": "pass" | "fail" | "warning",
  "confidence": <0.0–1.0>,
  "summary": "<one concise sentence, max 20 words>",
  "issues": ["<issue>", ...],
  "cross_check_notes": ["<any cross-script inconsistency or anomaly>"],
  "chain_status": { "<chain>": "pass" | "fail" | "warning" },
  "script_notes": { "<exact script label>": "<brief metric phrase>" },
  "week_context": "A" | "B" | "unknown"
}

## FIELD RULES

confidence:
- 0.95–1.0: all checks pass, cross-checks consistent, counts within baseline ranges
- 0.7–0.94: minor anomalies (e.g., unusual count delta) but no failures
- <0.7: uncertain — ambiguous outputs, mixed signals

issues:
- Each issue ONE short sentence, max 15 words
- Name the check and count/scope — no raw hex addresses or large integers
- Bad: "0x0901...e5f6 diff=20349206294183918416061799"
- Good: "Cumulative merkle mismatch for 8 Curve Mainnet tokens"
- Must be empty when verdict is "pass"

cross_check_notes:
- One entry per cross-script observation (even if benign), e.g.:
  "Parquet: 319 delegators, RPC: 319 — consistent"
  "Distribution: 42 this-week tokens; cumulative merkle: 41 historical tokens — expected difference"
- Include at least one note — empty array only if single-script run
- Do NOT flag differences between this-week token counts and cumulative token counts — they measure different things

chain_status:
- One key per chain present in the outputs (e.g. "mainnet", "base")
- Verdict per chain based on that chain's specific results
- Omit chains with no data in the outputs

script_notes:
- Key = EXACT script label from section header (e.g. "vlCVX Distribution Verification")
- Value = short phrase (max 10 words) with the most informative numbers
- MUST include a note for EVERY script — omit only if no output at all
- Extraction guidance per script:
  - "* Distribution Verification" → claim count + token count, e.g. "234 claims, 18 tokens"
  - "* Reward Flow Verification" → CSV balance result + chain count, e.g. "CSV balanced across 3 chains"
  - "* parquet delegators" → delegator count + split, e.g. "319: 292 fwd / 27 non-fwd"
  - "* RPC delegators" → active + filtered count, e.g. "319 active, 93 zero-VP filtered"
  - "* delegation timing" → snapshot block(s), e.g. "block 24741454 (ETH) / 43867680 (Base)"
  - "Bounties Report Verification" → gauge/CSV counts or failure, e.g. "42 gauges, 3 CSVs"

week_context:
- "A" if new proposalId (different from previous week)
- "B" if same proposalId as previous week (delegator set must be identical)
- "unknown" if cannot determine from script output

## VERDICT RULES
- "pass" (confidence ≥ 0.9): all ✅, zero ❌, cross-checks consistent
- "fail" (any confidence): missing required files, invalid merkle root, delegation address in merkle, BigInt group-split mismatch, delegators not found via RPC, CSV diff≠0 AND token NOT in merkle
- "warning": non-critical only — optional file absent, week-over-week >20% change, CSV diff≠0 BUT token IS in merkle, cross-script count discrepancy <5%, ⚠️ RPC warnings where counts still match`;

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
    confidence?: number;
    cross_check_notes?: string[];
    chain_status?: Record<string, Verdict>;
    week_context?: "A" | "B" | "unknown";
  }>(prompt, fallback, { maxTokens: 2048, timeout: 90_000 });

  if (error) console.warn(`  ⚠️  LLM error (${client.model}): ${error}`);

  return {
    verdict: parsed.verdict,
    summary: parsed.summary,
    issues: parsed.issues ?? [],
    scripts,
    scriptNotes: parsed.script_notes,
    confidence: parsed.confidence,
    crossCheckNotes: parsed.cross_check_notes,
    chainStatus: parsed.chain_status,
    weekContext: parsed.week_context,
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

function avgConfidence(models: ModelVerdict[], verdict: Verdict): number {
  const matching = models.filter((m) => m.verdict === verdict && m.confidence != null);
  if (matching.length === 0) return 0.5;
  return matching.reduce((sum, m) => sum + m.confidence!, 0) / matching.length;
}

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

  const maxCount = Math.max(counts.pass, counts.warning, counts.fail);
  const tied = (["fail", "warning", "pass"] as Verdict[]).filter((v) => counts[v] === maxCount);

  let majority: Verdict;
  if (tied.length === 1) {
    majority = tied[0];
  } else {
    majority = tied.reduce((best, v) => {
      const confBest = avgConfidence(responded, best);
      const confV = avgConfidence(responded, v);
      if (confV > confBest) return v;
      if (confV === confBest && VERDICT_RANK[v] > VERDICT_RANK[best]) return v;
      return best;
    });
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
          confidence: result.confidence,
          crossCheckNotes: result.crossCheckNotes,
          chainStatus: result.chainStatus,
          weekContext: result.weekContext,
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
  const matching = responded.filter((m) => m.verdict === verdict);
  const best = matching.length > 0
    ? matching.reduce((a, b) => (b.confidence ?? 0) > (a.confidence ?? 0) ? b : a)
    : responded[0];

  const scriptOnlySummary = allScriptsPass
    ? `All ${scripts.length} scripts passed — no LLM response, verdict from scripts only`
    : `${scripts.filter((s) => s.exitCode !== 0).length}/${scripts.length} scripts failed — no LLM response, verdict from scripts only`;

  return {
    verdict,
    summary: best?.summary ?? scriptOnlySummary,
    issues: best?.issues ?? (allScriptsPass ? [] : ["See raw script output for details"]),
    scripts,
    scriptNotes: best?.scriptNotes,
    confidence: best?.confidence,
    crossCheckNotes: best?.crossCheckNotes,
    chainStatus: best?.chainStatus,
    weekContext: best?.weekContext,
    modelVerdicts,
    consensusMethod: method,
  };
}
