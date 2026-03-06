/**
 * AI-powered distribution verification CLI.
 *
 * Usage:
 *   pnpm tsx script/verify/aiVerify.ts [--timestamp WEEK] [--protocol vlCVX|vlAURA|all] [--model MODEL] [--deep]
 *
 * Env:
 *   OPENCODE_ZEN_API_KEY  (required)
 */

import * as dotenv from "dotenv";
import { verify, Protocol } from "./distributionVerify";
import { createZenClient, ZEN_DEFAULT_MODEL } from "../utils/openCodeZen";
import { sendVerificationReport } from "./telegramReport";
import { WEEK } from "../utils/constants";

dotenv.config();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let timestamp: number | undefined;
  let protocol: Protocol = "all";
  let model = ZEN_DEFAULT_MODEL;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) {
      timestamp = parseInt(args[++i], 10);
    } else if (args[i] === "--protocol" && args[i + 1]) {
      protocol = args[++i] as Protocol;
    } else if (args[i] === "--model" && args[i + 1]) {
      model = args[++i];
    } else if (args[i] === "--help") {
      console.log(`
Usage: pnpm tsx script/verify/aiVerify.ts [options]

Options:
  --timestamp <ts>    Week epoch (default: current week)
  --protocol  <p>     vlCVX | vlAURA | bounties | all  (default: all)
  --model     <m>     LLM model via Opencode ZEN (default: ${ZEN_DEFAULT_MODEL})
  --help              Show this message
`);
      process.exit(0);
    }
  }

  if (!timestamp) {
    const now = Math.floor(Date.now() / 1000);
    timestamp = Math.floor(now / WEEK) * WEEK;
  }

  const client = createZenClient(model);

  // When "all", run each protocol independently so each gets its own Telegram message.
  const protocols: Protocol[] = protocol === "all"
    ? ["vlCVX", "bounties", "vlAURA"]
    : [protocol];

  let anyFail = false;

  for (const p of protocols) {
    const result = await verify(client, timestamp, p);
    await sendVerificationReport(result, timestamp, p);

    const icon = result.verdict === "pass" ? "✅" : result.verdict === "warning" ? "⚠️ " : "❌";
    if (result.verdict === "fail") anyFail = true;

    console.log("\n" + "═".repeat(70));
    console.log(`  AI Verification Report [${p}] — ${client.model} (${client.provider})`);
    console.log("═".repeat(70));
    console.log(`\n  ${icon} ${result.verdict.toUpperCase()}: ${result.summary}`);

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
