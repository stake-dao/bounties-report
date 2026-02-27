/**
 * Verify vlAURA reward flow: CSV amounts match delegation + non-delegator split.
 *
 * Checks:
 * 1. CSV balance — CSV_total === delegation_total + nonDelegator_total per token (exact BigInt)
 *
 * Usage:
 *   pnpm tsx script/vlAURA/verify/rewardFlow.ts [--timestamp WEEK]
 */

import { WEEK } from "../../utils/constants";
import { ChainCheck, verifyCSVBalance } from "../../utils/verifyHelpers";

// ── Config ────────────────────────────────────────────────────────────────────

const VLAURA_CHECKS: ChainCheck[] = [
  {
    label: "vlAURA Mainnet",
    csv: "vlaura.csv",
    chain: "1",
    repartition: "vlAURA/repartition.json",
    delegation: "vlAURA/repartition_delegation.json",
  },
  {
    label: "vlAURA Arbitrum",
    csv: "vlaura.csv",
    chain: "42161",
    repartition: "vlAURA/repartition_42161.json",
    delegation: "vlAURA/repartition_delegation_42161.json",
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  let timestamp: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) { timestamp = parseInt(args[++i]); }
    else if (args[i] === "--help") {
      console.log(`
Usage: pnpm tsx script/vlAURA/verify/rewardFlow.ts [options]

Options:
  --timestamp <ts>   Week epoch (default: current week)
  --help             Show this message
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
  console.log(`  vlAURA Reward Flow Verification: ${timestamp} (${date})`);
  console.log("═".repeat(70));

  let allOk = true;

  const csvResult = verifyCSVBalance(timestamp, VLAURA_CHECKS);
  for (const line of csvResult.results) console.log(line);
  if (!csvResult.allOk) allOk = false;

  console.log(`\n${"═".repeat(70)}`);
  console.log(allOk ? "  ✅ All vlAURA reward flow checks passed" : "  ❌ Some checks failed — see above");
  console.log("═".repeat(70));

  process.exit(allOk ? 0 : 1);
}

main();
