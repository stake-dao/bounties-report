/**
 * Compare multiple LLM models on the same distribution verification output.
 *
 * Runs verification scripts ONCE, then sends identical output to each model
 * in parallel and prints a side-by-side comparison table.
 *
 * Usage:
 *   pnpm tsx script/verify/compareModels.ts [options]
 *
 * Options:
 *   --timestamp <ts>      Week epoch (default: current week)
 *   --protocol  <p>       vlCVX | vlAURA | all (default: all)
 *   --models    <m1,m2>   Comma-separated model IDs
 *   --deep                Include RPC/parquet delegation checks
 *
 * Available ZEN models: GET https://opencode.ai/zen/v1/models
 * Free options: kimi-k2.5-free, minimax-m2.5-free, big-pickle, glm-5-free
 *
 * Env:
 *   OPENCODE_ZEN_API_KEY  (required)
 */

import * as dotenv from "dotenv";
import { runScripts, analyze, Protocol, VerificationResult } from "./distributionVerify";
import { createZenClient, ZEN_DEFAULT_MODEL } from "../utils/openCodeZen";
import { WEEK } from "../utils/constants";

dotenv.config();

const DEFAULT_MODELS = [
  ZEN_DEFAULT_MODEL,          // best quality (claude-sonnet-4-6)
  "claude-haiku-4-5",         // fast, cheap
  "kimi-k2.5-free",           // free — OpenAI-compat
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const icon = (v: string) => ({ pass: "✅", warning: "⚠️ ", fail: "❌" }[v] ?? "❓");
const pad = (s: string, n: number) => s.length <= n ? s.padEnd(n) : s.slice(0, n - 1) + "…";

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env.OPENCODE_ZEN_API_KEY ?? "";

  const argv = process.argv.slice(2);
  let timestamp: number | undefined;
  let protocol: Protocol = "all";
  let models = DEFAULT_MODELS;
  let deep = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--timestamp" && argv[i + 1]) timestamp = parseInt(argv[++i], 10);
    else if (argv[i] === "--protocol" && argv[i + 1]) protocol = argv[++i] as Protocol;
    else if (argv[i] === "--models" && argv[i + 1]) models = argv[++i].split(",").map((m) => m.trim());
    else if (argv[i] === "--deep") deep = true;
    else if (argv[i] === "--help") {
      console.log(`
Usage: pnpm tsx script/verify/compareModels.ts [options]

Options:
  --timestamp <ts>      Week epoch (default: current week)
  --protocol  <p>       vlCVX | vlAURA | all (default: all)
  --models    <m1,m2>   Comma-separated model IDs (default: ${DEFAULT_MODELS.join(",")})
  --deep                Include RPC/parquet delegation checks
`);
      process.exit(0);
    }
  }

  if (!timestamp) {
    const now = Math.floor(Date.now() / 1000);
    timestamp = Math.floor(now / WEEK) * WEEK;
  }

  const date = new Date(timestamp * 1000).toISOString().split("T")[0];
  console.log("═".repeat(70));
  console.log(`  Model Comparison — week ${timestamp} (${date}), protocol=${protocol}`);
  console.log(`  Models: ${models.join(", ")}`);
  console.log("═".repeat(70));

  // ── Run scripts once ──────────────────────────────────────────────────────

  console.log(`\nRunning scripts (mode=${deep ? "deep" : "fast"})…`);
  const scripts = runScripts(timestamp, protocol, { deep });
  console.log(`Done: ${scripts.map((s) => `${s.label}(${s.exitCode})`).join(", ")}`);

  // ── Query all models in parallel ──────────────────────────────────────────

  console.log(`\nQuerying ${models.length} models in parallel…\n`);

  type Row = { model: string; provider: string; result: VerificationResult | null; ms: number; error?: string };

  const rows: Row[] = await Promise.all(
    models.map(async (modelId): Promise<Row> => {
      const client = createZenClient(modelId, apiKey);
      const t0 = Date.now();
      try {
        const result = await analyze(client, timestamp!, protocol, scripts, deep);
        return { model: modelId, provider: client.provider, result, ms: Date.now() - t0 };
      } catch (err) {
        return { model: modelId, provider: client.provider, result: null, ms: Date.now() - t0, error: String(err) };
      }
    })
  );

  // ── Print table ───────────────────────────────────────────────────────────

  const W = { model: 26, verdict: 9, summary: 44, ms: 6 };
  const header =
    "Model".padEnd(W.model) + "Verdict".padEnd(W.verdict) +
    "Summary".padEnd(W.summary) + "ms".padEnd(W.ms);

  console.log("═".repeat(70));
  console.log("  " + header);
  console.log("  " + "─".repeat(header.length));

  for (const row of rows) {
    if (!row.result) {
      console.log(
        `  ❌ ${pad(row.model, W.model)}${"ERROR".padEnd(W.verdict)}${pad(row.error ?? "", W.summary)}${String(row.ms).padStart(W.ms)}`
      );
      continue;
    }
    const { verdict, summary } = row.result;
    console.log(
      `  ${icon(verdict)} ${pad(row.model, W.model)}${verdict.padEnd(W.verdict)}${pad(summary, W.summary)}${String(row.ms).padStart(W.ms)}`
    );
  }

  // ── Issues per model ──────────────────────────────────────────────────────

  const withIssues = rows.filter((r) => r.result && r.result.issues.length > 0);
  if (withIssues.length > 0) {
    console.log("\n" + "─".repeat(70));
    for (const row of withIssues) {
      console.log(`  [${row.model}]`);
      for (const issue of row.result!.issues) console.log(`    • ${issue}`);
    }
  }

  // ── Agreement summary ─────────────────────────────────────────────────────

  const verdicts = rows.filter((r) => r.result).map((r) => r.result!.verdict);
  const allAgree = verdicts.every((v) => v === verdicts[0]);
  const counts = verdicts.reduce<Record<string, number>>((a, v) => { a[v] = (a[v] ?? 0) + 1; return a; }, {});

  console.log("\n" + "═".repeat(70));
  console.log(
    allAgree
      ? `  ✅ All models agree: ${verdicts[0].toUpperCase()}`
      : `  ⚠️  Models disagree: ${Object.entries(counts).map(([v, n]) => `${v}×${n}`).join(", ")}`
  );
  console.log("═".repeat(70));

  process.exit(rows.some((r) => r.result?.verdict === "fail" || r.error) ? 1 : 0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
