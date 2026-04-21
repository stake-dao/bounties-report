/**
 * AI-powered distribution verification CLI with multi-model consensus.
 *
 * Runs verification scripts once, queries multiple LLM models in parallel,
 * and resolves a final verdict by consensus. Scripts are the source of truth:
 * if all scripts pass but every LLM is down, the pipeline still passes.
 *
 * Usage:
 *   pnpm tsx script/verify/aiVerify.ts [--timestamp WEEK] [--protocol vlCVX|vlAURA|all] [--models m1,m2] [--deep]
 *
 * Env:
 *   OPENCODE_ZEN_API_KEY  (required)
 */

import * as dotenv from "dotenv";
import { spawnSync } from "child_process";
import * as path from "path";
import { verifyWithConsensus, Protocol, ConsensusResult, VerifyMetadata } from "./distributionVerify";
import { createZenClient, ZEN_DEFAULT_MODEL } from "../utils/openCodeZen";
import { sendConsensusReport } from "./telegramReport";
import { WEEK, CVX_SPACE, VLAURA_SPACE } from "../utils/constants";
import { fetchLastProposalsIds } from "../utils/snapshot";
import type { LLMClient } from "../utils/llmClient";

dotenv.config();

const DEFAULT_MODELS = [
  "claude-haiku-4-5",
  "gpt-5.4-mini",
  "minimax-m2.5-free",
];

const VERDICT_ICON: Record<string, string> = { pass: "✅", warning: "⚠️ ", fail: "❌" };
const pad = (s: string, n: number) => s.length <= n ? s.padEnd(n) : s.slice(0, n - 1) + "…";

function printModelTable(result: ConsensusResult): void {
  const W = { model: 22, verdict: 10, summary: 36, ms: 7 };
  const header =
    "Model".padEnd(W.model) + "Verdict".padEnd(W.verdict) +
    "Summary".padEnd(W.summary) + "ms".padEnd(W.ms);

  console.log("\n  " + header);
  console.log("  " + "─".repeat(header.length));

  for (const m of result.modelVerdicts) {
    if (m.verdict === null) {
      console.log(
        `  ❌ ${pad(m.model, W.model)}${"ERROR".padEnd(W.verdict)}${pad(m.error ?? "unknown", W.summary)}${String(m.ms).padStart(W.ms)}`
      );
    } else {
      const icon = VERDICT_ICON[m.verdict] ?? "❓";
      console.log(
        `  ${icon} ${pad(m.model, W.model)}${m.verdict.padEnd(W.verdict)}${pad(m.summary ?? "", W.summary)}${String(m.ms).padStart(W.ms)}`
      );
    }
  }
}

interface SnapshotQuery {
  label: string;
  space: string;
  filter: string;
  protocols: Protocol[];
}

const SNAPSHOT_QUERIES: SnapshotQuery[] = [
  { label: "vlCVX Curve", space: CVX_SPACE, filter: "^(?!FXN ).*Gauge Weight for Week of", protocols: ["vlCVX", "all"] },
  { label: "vlCVX FXN", space: CVX_SPACE, filter: "^FXN.*Gauge Weight for Week of", protocols: ["vlCVX", "all"] },
  { label: "vlAURA", space: VLAURA_SPACE, filter: "Gauge Weight for Week of", protocols: ["vlAURA", "all"] },
];

async function fetchMetadata(timestamp: number, protocols: Protocol[]): Promise<VerifyMetadata> {
  const meta: VerifyMetadata = { timestamp };

  const gitResult = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf-8",
    cwd: path.join(__dirname, "../../"),
  });
  if (gitResult.status === 0) meta.commitSha = gitResult.stdout.trim();

  const queries = SNAPSHOT_QUERIES.filter((q) => protocols.some((p) => q.protocols.includes(p)));

  if (queries.length > 0) {
    try {
      const proposals: VerifyMetadata["snapshotProposals"] = [];
      for (const q of queries) {
        const result = await fetchLastProposalsIds([q.space], timestamp + WEEK, q.filter);
        if (result[q.space]) {
          proposals.push({ label: q.label, space: q.space, proposalId: result[q.space] });
        }
      }
      if (proposals.length > 0) meta.snapshotProposals = proposals;
    } catch (err) {
      console.warn(`  ⚠️  Snapshot proposal fetch failed: ${err}`);
    }
  }

  return meta;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let timestamp: number | undefined;
  let protocol: Protocol = "all";
  let modelIds = DEFAULT_MODELS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) {
      timestamp = parseInt(args[++i], 10);
    } else if (args[i] === "--protocol" && args[i + 1]) {
      protocol = args[++i] as Protocol;
    } else if (args[i] === "--models" && args[i + 1]) {
      modelIds = args[++i].split(",").map((m) => m.trim());
    } else if (args[i] === "--model" && args[i + 1]) {
      modelIds = [args[++i]];
    } else if (args[i] === "--help") {
      console.log(`
Usage: pnpm tsx script/verify/aiVerify.ts [options]

Options:
  --timestamp <ts>       Week epoch (default: current week)
  --protocol  <p>        vlCVX | vlAURA | bounties | all  (default: all)
  --models    <m1,m2>    Comma-separated model IDs (default: ${DEFAULT_MODELS.join(",")})
  --model     <m>        Single model (shorthand for --models with one)
  --deep                 Include RPC/parquet delegation checks (implicit)
  --help                 Show this message
`);
      process.exit(0);
    }
  }

  if (!timestamp) {
    const now = Math.floor(Date.now() / 1000);
    timestamp = Math.floor(now / WEEK) * WEEK;
  }

  const apiKey = process.env.OPENCODE_ZEN_API_KEY ?? "";
  const clients: LLMClient[] = modelIds.map((m) => createZenClient(m, apiKey));

  const protocols: Protocol[] = protocol === "all"
    ? ["vlCVX", "bounties", "vlAURA"]
    : [protocol];

  let anyFail = false;
  const metadata = await fetchMetadata(timestamp, protocols);

  for (const p of protocols) {
    const result = await verifyWithConsensus(clients, timestamp, p);
    await sendConsensusReport(result, timestamp, p, metadata);

    const icon = VERDICT_ICON[result.verdict] ?? "❓";
    if (result.verdict === "fail") anyFail = true;

    console.log("\n" + "═".repeat(70));
    console.log(`  AI Verification Report [${p}] — consensus (${result.consensusMethod})`);
    console.log("═".repeat(70));

    printModelTable(result);

    const responded = result.modelVerdicts.filter((m) => m.verdict !== null).length;
    const total = result.modelVerdicts.length;
    console.log(`\n  Consensus: ${result.consensusMethod} (${responded}/${total} models responded)`);
    console.log(`  ${icon} ${result.verdict.toUpperCase()}: ${result.summary}`);

    if (result.issues.length > 0) {
      console.log("\n  Issues:");
      for (const issue of result.issues) console.log(`    • ${issue}`);
    }

    const scriptSummary = result.scripts.map((s) => `${s.label}=${s.exitCode}`).join(" | ");
    console.log(`\n  Scripts: ${scriptSummary}`);
    console.log("═".repeat(70));
  }

  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
