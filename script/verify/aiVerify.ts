/**
 * AI-powered distribution verification CLI with multi-model consensus.
 *
 * Runs verification scripts once, queries multiple LLM models in parallel,
 * and resolves a final verdict by consensus. Scripts are the source of truth:
 * if all scripts pass but every LLM is down, the pipeline still passes.
 *
 * Usage:
 *   pnpm tsx script/verify/aiVerify.ts [--timestamp WEEK] [--protocol vlCVX|bounties|spectra|frax|all] [--target voters|delegators|both] [--run-type voters|delegators] [--models m1,m2] [--deep]
 *
 * Env:
 *   OPENCODE_ZEN_API_KEY  (required)
 */

import * as dotenv from "dotenv";
import { spawnSync } from "child_process";
import * as path from "path";
import { verifyWithConsensus, Protocol, ConsensusResult, VerifyMetadata, RunType } from "./distributionVerify";
import { createZenClient, ZEN_DEFAULT_MODEL } from "../utils/openCodeZen";
import { sendConsensusReport } from "./telegramReport";
import { WEEK, CVX_SPACE } from "../utils/constants";
import { getOnChainProposal } from "../utils/gaugeVotePlatform";
import { getClient } from "../utils/getClients";
import {
  CVX_GAUGE_VOTE_PLATFORM_CURVE,
  CVX_GAUGE_VOTE_PLATFORM_FXN,
} from "../utils/constants";
import type { LLMClient } from "../utils/llmClient";
import { parseTarget, type Target as InvariantTarget } from "./invariants/cli";

dotenv.config();

const DEFAULT_MODELS = [
  "claude-opus-4-7",
  "gpt-5.5",
  "minimax-m2.7",
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

// vlCVX gauge votes moved on-chain (ENG-1973): reference the platform
// proposal, not a legacy Snapshot hash.
const ONCHAIN_QUERIES: { label: string; platform: string; protocols: Protocol[] }[] = [
  { label: "vlCVX Curve", platform: CVX_GAUGE_VOTE_PLATFORM_CURVE, protocols: ["vlCVX", "all"] },
  { label: "vlCVX FXN", platform: CVX_GAUGE_VOTE_PLATFORM_FXN, protocols: ["vlCVX", "all"] },
];

async function fetchMetadata(timestamp: number, protocols: Protocol[]): Promise<VerifyMetadata> {
  const meta: VerifyMetadata = { timestamp };

  const gitResult = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf-8",
    cwd: path.join(__dirname, "../../"),
  });
  if (gitResult.status === 0) meta.commitSha = gitResult.stdout.trim();

  const queries = ONCHAIN_QUERIES.filter((q) => protocols.some((p) => q.protocols.includes(p)));

  if (queries.length > 0) {
    try {
      const client = await getClient(1);
      const proposals: VerifyMetadata["snapshotProposals"] = [];
      for (const q of queries) {
        const proposal = await getOnChainProposal(q.platform, CVX_SPACE, client, {
          targetPeriod: timestamp,
        });
        proposals.push({
          label: q.label,
          space: CVX_SPACE,
          proposalId: `On-chain gauge vote #${proposal.id} (vlCVX epoch ${proposal.snapshot})`,
        });
      }
      if (proposals.length > 0) meta.snapshotProposals = proposals;
    } catch (err) {
      console.warn(`  ⚠️  On-chain proposal fetch failed: ${err}`);
    }
  }

  return meta;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let timestamp: number | undefined;
  let protocol: Protocol = "all";
  let invariantTarget: InvariantTarget = "both";
  let runType: RunType | undefined;
  let modelIds = DEFAULT_MODELS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) {
      timestamp = parseInt(args[++i], 10);
    } else if (args[i] === "--protocol" && args[i + 1]) {
      protocol = args[++i] as Protocol;
    } else if (args[i] === "--target" && args[i + 1]) {
      invariantTarget = parseTarget(args[++i]);
    } else if (args[i] === "--run-type" && args[i + 1]) {
      const v = args[++i];
      if (v !== "voters" && v !== "delegators") {
        console.error(`Invalid --run-type: ${v} (expected voters|delegators)`);
        process.exit(1);
      }
      runType = v;
    } else if (args[i] === "--models" && args[i + 1]) {
      modelIds = args[++i].split(",").map((m) => m.trim());
    } else if (args[i] === "--model" && args[i + 1]) {
      modelIds = [args[++i]];
    } else if (args[i] === "--help") {
      console.log(`
Usage: pnpm tsx script/verify/aiVerify.ts [options]

Options:
  --timestamp <ts>       Week epoch (default: current week)
  --protocol  <p>        vlCVX | bounties | spectra | frax | all  (default: all)
  --target    <t>        vlCVX invariant target: voters | delegators | both (default: both)
  --run-type  <r>        Which pipeline run dispatched this verify: voters | delegators
                         (authoritative run context for the models; default: infer from dates)
  --models    <m1,m2>    Comma-separated model IDs (default: ${DEFAULT_MODELS.join(",")})
  --model     <m>        Single model (shorthand for --models with one)
  --deep                 Include artifact/on-chain delegation checks (implicit)
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
    ? ["vlCVX", "bounties", "spectra"]
    : [protocol];

  let anyFail = false;
  const metadata = await fetchMetadata(timestamp, protocols);

  for (const p of protocols) {
    const result = await verifyWithConsensus(clients, timestamp, p, invariantTarget, runType);
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
