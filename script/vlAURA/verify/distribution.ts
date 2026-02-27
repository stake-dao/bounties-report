/**
 * Verify vlAURA weekly distribution integrity.
 *
 * Checks:
 * 1. File existence — repartition + merkle files
 * 2. Delegation shares sum — delegators sum ≈ 1.0
 * 3. Merkle integrity — valid roots, claim counts, token counts
 * 4. Week comparison — claim counts vs previous week, flag >20% deviation
 * 5. Token completeness — all CSV tokens appear in merkle
 * 6. Exclusion checks — delegation address not in merkle
 *
 * Usage:
 *   pnpm tsx script/vlAURA/verify/distribution.ts [--timestamp WEEK]
 */

import * as path from "path";
import { DELEGATION_ADDRESS, WEEK } from "../../utils/constants";
import {
  CheckResult,
  MerkleConfig,
  TokenCheckConfig,
  weekDir,
  fileExists,
  printSection,
  checkMerkleIntegrity,
  checkWeekComparison,
  checkTokenCompleteness,
  readJSON,
} from "../../utils/verifyHelpers";

// ── Config ────────────────────────────────────────────────────────────────────

const VLAURA_FILES = {
  required: ["repartition.json", "repartition_delegation.json", "vlaura_merkle.json"],
  optional: [
    "repartition_42161.json",
    "repartition_delegation_42161.json",
    "vlaura_merkle_42161.json",
  ],
};

const VLAURA_TOKEN_CHECKS: TokenCheckConfig[] = [
  { label: "vlAURA Mainnet", csv: "vlaura.csv", chain: "1", merkle: "vlAURA/vlaura_merkle.json" },
  { label: "vlAURA Arbitrum", csv: "vlaura.csv", chain: "42161", merkle: "vlAURA/vlaura_merkle_42161.json" },
];

const VLAURA_MERKLE_CONFIGS: MerkleConfig[] = [
  { label: "vlAURA Mainnet", path: "vlAURA/vlaura_merkle.json" },
  { label: "vlAURA Arbitrum", path: "vlAURA/vlaura_merkle_42161.json", optional: true },
];

// ── Check 1: File Existence ───────────────────────────────────────────────────

function checkFileExistence(timestamp: number): CheckResult[] {
  const results: CheckResult[] = [];
  const base = weekDir(timestamp);

  for (const f of VLAURA_FILES.required) {
    const p = path.join(base, "vlAURA", f);
    const exists = fileExists(p);
    results.push({ label: `vlAURA/${f}`, ok: exists, detail: exists ? "exists" : "MISSING" });
  }
  for (const f of VLAURA_FILES.optional) {
    const p = path.join(base, "vlAURA", f);
    const exists = fileExists(p);
    results.push({
      label: `vlAURA/${f}`,
      ok: true,
      detail: exists ? "exists" : "not present (optional — no Arbitrum bounties)",
    });
  }

  return results;
}

// ── Check 2: Delegation Share Sums ───────────────────────────────────────────

function checkVlAURADelegationShares(timestamp: number): CheckResult[] {
  const results: CheckResult[] = [];
  const base = weekDir(timestamp);

  const mainPath = path.join(base, "vlAURA/repartition_delegation.json");
  if (!fileExists(mainPath)) {
    results.push({ label: "vlAURA mainnet shares", ok: false, detail: "file missing" });
    return results;
  }

  const data = readJSON(mainPath);
  const delegators = data.distribution.delegators || {};
  const vals = Object.values(delegators) as string[];
  const sum = vals.reduce((s: number, v: string) => s + parseFloat(v), 0);
  const ok = sum > 0.999 && sum < 1.001;
  results.push({
    label: "vlAURA mainnet delegator shares",
    ok,
    detail: `${vals.length} delegators, sum=${sum.toFixed(6)}`,
  });

  const arbPath = path.join(base, "vlAURA/repartition_delegation_42161.json");
  if (fileExists(arbPath)) {
    const arbData = readJSON(arbPath);
    const arbDelegators = arbData.distribution.delegators || {};
    const arbVals = Object.values(arbDelegators) as string[];
    const arbSum = arbVals.reduce((s: number, v: string) => s + parseFloat(v), 0);
    const arbOk = arbVals.length === 0 || (arbSum > 0.999 && arbSum < 1.001);
    results.push({
      label: "vlAURA Arbitrum delegator shares",
      ok: arbOk,
      detail: `${arbVals.length} delegators, sum=${arbSum.toFixed(6)}`,
    });
  }

  return results;
}

// ── Check 6: Exclusion Checks ────────────────────────────────────────────────

function checkExclusions(timestamp: number): CheckResult[] {
  const results: CheckResult[] = [];
  const base = weekDir(timestamp);
  const delegAddr = DELEGATION_ADDRESS;

  for (const cfg of VLAURA_MERKLE_CONFIGS) {
    const filePath = path.join(base, cfg.path);
    if (!fileExists(filePath)) continue;

    const data = readJSON(filePath);
    const inMerkle = !!data.claims[delegAddr];
    results.push({
      label: `${cfg.label} delegation addr excluded`,
      ok: !inMerkle,
      detail: inMerkle ? "CRITICAL: delegation addr IN merkle" : "excluded",
    });
  }

  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  let timestamp: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) { timestamp = parseInt(args[++i]); }
    else if (args[i] === "--help") {
      console.log(`
Usage: pnpm tsx script/vlAURA/verify/distribution.ts [options]

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
  console.log(`  vlAURA Distribution Verification: ${timestamp} (${date})`);
  console.log("═".repeat(70));

  let allOk = true;

  if (!printSection("File Existence", checkFileExistence(timestamp))) allOk = false;
  if (!printSection("Delegation Shares", checkVlAURADelegationShares(timestamp))) allOk = false;
  if (!printSection("Merkle Integrity", checkMerkleIntegrity(timestamp, VLAURA_MERKLE_CONFIGS))) allOk = false;
  if (!printSection("Week Comparison", checkWeekComparison(timestamp, VLAURA_MERKLE_CONFIGS))) allOk = false;
  if (!printSection("Token Completeness", checkTokenCompleteness(timestamp, VLAURA_TOKEN_CHECKS))) allOk = false;
  if (!printSection("Exclusion Checks", checkExclusions(timestamp))) allOk = false;

  console.log(`\n${"═".repeat(70)}`);
  console.log(allOk ? "  ✅ All vlAURA distribution checks passed" : "  ❌ Some checks failed — see above");
  console.log("═".repeat(70));

  process.exit(allOk ? 0 : 1);
}

main();
