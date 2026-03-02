/**
 * Verify vlCVX weekly distribution integrity.
 *
 * Checks:
 * 1. File existence — repartition + merkle files
 * 2. Delegation shares sum — forwarders + nonForwarders ≈ 1.0
 * 3. Merkle integrity — valid roots, claim counts, token counts
 * 4. Week comparison — claim counts vs previous week, flag >20% deviation
 * 5. Token completeness — all CSV tokens appear in merkle
 * 6. Exclusion checks — delegation address not in merkle, SDT presence
 * 7. Group allocation — forwarder/non-forwarder percentages
 * 8. Week A/B detection — same proposalId as previous week
 *
 * Usage:
 *   pnpm tsx script/vlCVX/verify/distribution.ts [--timestamp WEEK]
 */

import * as fs from "fs";
import * as path from "path";
import { DELEGATION_ADDRESS, WEEK } from "../../utils/constants";
import {
  CheckResult,
  MerkleConfig,
  TokenCheckConfig,
  REPORTS_DIR,
  weekDir,
  fileExists,
  printSection,
  checkMerkleIntegrity,
  checkWeekComparison,
  checkTokenCompleteness,
  readJSON,
  shortAddr,
} from "../../utils/verifyHelpers";

// ── Config ────────────────────────────────────────────────────────────────────

const VLCVX_FILES = {
  curve: [
    "repartition.json",
    "repartition_delegation.json",
    "repartition_8453.json",
    "repartition_delegation_8453.json",
    "merkle_data_non_delegators.json",
    "merkle_data_non_delegators_8453.json",
  ],
  fxn: [
    "repartition.json",
    "repartition_delegation.json",
    "merkle_data_non_delegators.json",
  ],
  root: ["vlcvx_merkle.json", "vlcvx_merkle_8453.json"],
  rootOptional: ["merkle_data_delegators.json"],
};

const VLCVX_TOKEN_CHECKS: TokenCheckConfig[] = [
  { label: "Curve Mainnet", csv: "cvx.csv", chain: "1", merkle: "vlCVX/vlcvx_merkle.json" },
  { label: "Curve Base", csv: "cvx.csv", chain: "8453", merkle: "vlCVX/vlcvx_merkle_8453.json" },
  { label: "FXN Mainnet", csv: "cvx_fxn.csv", chain: "1", merkle: "vlCVX/vlcvx_merkle.json" },
];

interface DelegShareConfig {
  label: string;
  path: string;
}

const VLCVX_DELEG_SHARE_CONFIGS: DelegShareConfig[] = [
  { label: "Curve Mainnet", path: "vlCVX/curve/repartition_delegation.json" },
  { label: "Curve Base", path: "vlCVX/curve/repartition_delegation_8453.json" },
  { label: "FXN Mainnet", path: "vlCVX/fxn/repartition_delegation.json" },
];

const VLCVX_MERKLE_CONFIGS: MerkleConfig[] = [
  { label: "vlCVX Mainnet", path: "vlCVX/vlcvx_merkle.json" },
  { label: "vlCVX Base", path: "vlCVX/vlcvx_merkle_8453.json" },
];

// ── Check 1: File Existence ───────────────────────────────────────────────────

function checkFileExistence(timestamp: number): CheckResult[] {
  const results: CheckResult[] = [];
  const base = weekDir(timestamp);

  for (const f of VLCVX_FILES.curve) {
    const p = path.join(base, "vlCVX/curve", f);
    const exists = fileExists(p);
    results.push({ label: `vlCVX/curve/${f}`, ok: exists, detail: exists ? "exists" : "MISSING" });
  }
  for (const f of VLCVX_FILES.fxn) {
    const p = path.join(base, "vlCVX/fxn", f);
    const exists = fileExists(p);
    results.push({ label: `vlCVX/fxn/${f}`, ok: exists, detail: exists ? "exists" : "MISSING" });
  }
  for (const f of VLCVX_FILES.root) {
    const p = path.join(base, "vlCVX", f);
    const exists = fileExists(p);
    results.push({ label: `vlCVX/${f}`, ok: exists, detail: exists ? "exists" : "MISSING" });
  }
  for (const f of VLCVX_FILES.rootOptional) {
    const p = path.join(base, "vlCVX", f);
    const exists = fileExists(p);
    results.push({
      label: `vlCVX/${f}`,
      ok: true,
      detail: exists ? "exists" : "not present (delegators run pending)",
    });
  }

  return results;
}

// ── Check 2: Delegation Share Sums ───────────────────────────────────────────

function checkVlCVXDelegationShares(timestamp: number): CheckResult[] {
  const results: CheckResult[] = [];
  const base = weekDir(timestamp);

  for (const cfg of VLCVX_DELEG_SHARE_CONFIGS) {
    const filePath = path.join(base, cfg.path);
    if (!fileExists(filePath)) {
      results.push({ label: `${cfg.label} shares`, ok: false, detail: "file missing" });
      continue;
    }

    const data = readJSON(filePath);
    const dist = data.distribution;

    const fwdShare = parseFloat(dist.totalForwardersShare || "0");
    const nfwdShare = parseFloat(dist.totalNonForwardersShare || "0");
    const totalShare = fwdShare + nfwdShare;
    const shareOk = totalShare > 0.999 && totalShare < 1.001;
    results.push({
      label: `${cfg.label} total shares`,
      ok: shareOk,
      detail: `fwd=${fwdShare.toFixed(6)} + nfwd=${nfwdShare.toFixed(6)} = ${totalShare.toFixed(6)}`,
    });

    const fwdValues = Object.values(dist.forwarders || {}) as string[];
    const fwdSum = fwdValues.reduce((s, v) => s + parseFloat(v), 0);
    const fwdOk = fwdValues.length === 0 || (fwdSum > 0.999 && fwdSum < 1.001);
    results.push({
      label: `${cfg.label} forwarders internal`,
      ok: fwdOk,
      detail: `${fwdValues.length} addrs, sum=${fwdSum.toFixed(6)}`,
    });

    const nfwdValues = Object.values(dist.nonForwarders || {}) as string[];
    const nfwdSum = nfwdValues.reduce((s, v) => s + parseFloat(v), 0);
    const nfwdOk = nfwdValues.length === 0 || (nfwdSum > 0.999 && nfwdSum < 1.001);
    results.push({
      label: `${cfg.label} non-forwarders internal`,
      ok: nfwdOk,
      detail: `${nfwdValues.length} addrs, sum=${nfwdSum.toFixed(6)}`,
    });
  }

  return results;
}

// ── Check 6: Exclusion Checks ────────────────────────────────────────────────

function checkExclusions(timestamp: number): CheckResult[] {
  const results: CheckResult[] = [];
  const base = weekDir(timestamp);
  const delegAddr = DELEGATION_ADDRESS;

  for (const cfg of VLCVX_MERKLE_CONFIGS) {
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

  const sdtAddr = "0x73968b9a57c6e53d41345fd57a6e6ae27d6cdb2f";
  const mainMerklePath = path.join(base, "vlCVX/vlcvx_merkle.json");
  if (fileExists(mainMerklePath)) {
    const data = readJSON(mainMerklePath);
    const tokens = new Set<string>();
    for (const claimant of Object.values(data.claims || {}) as any[]) {
      for (const token of Object.keys(claimant.tokens || {})) tokens.add(token.toLowerCase());
    }
    results.push({
      label: "SDT in vlCVX merkle",
      ok: true,
      detail: tokens.has(sdtAddr) ? "present" : "not present (check if SDT bounties exist)",
    });
  }

  return results;
}

// ── Check 7: Group Allocation ─────────────────────────────────────────────────

function checkGroupAllocation(timestamp: number): CheckResult[] {
  const results: CheckResult[] = [];
  const base = weekDir(timestamp);

  for (const cfg of VLCVX_DELEG_SHARE_CONFIGS) {
    const filePath = path.join(base, cfg.path);
    if (!fileExists(filePath)) continue;

    const data = readJSON(filePath);
    const dist = data.distribution;
    const fwdShare = parseFloat(dist.totalForwardersShare || "0");
    const nfwdShare = parseFloat(dist.totalNonForwardersShare || "0");

    results.push({
      label: `${cfg.label} group allocation`,
      ok: true,
      detail: `forwarders=${(fwdShare * 100).toFixed(2)}% non-forwarders=${(nfwdShare * 100).toFixed(2)}%`,
    });
  }

  return results;
}

// ── Check 8: Week A/B Detection ───────────────────────────────────────────────

function checkWeekAB(timestamp: number): CheckResult[] {
  const base = weekDir(timestamp);
  const prevBase = weekDir(timestamp - WEEK);

  const currPath = path.join(base, "vlCVX/curve/repartition_delegation.json");
  const prevPath = path.join(prevBase, "vlCVX/curve/repartition_delegation.json");

  if (!fileExists(currPath))
    return [{ label: "Week A/B", ok: true, detail: "repartition_delegation.json missing — skip" }];

  const currData = readJSON(currPath);
  const currId: string | undefined = currData.proposalId;

  if (!currId)
    return [{ label: "Week A/B", ok: true, detail: "proposalId not stored in file" }];

  if (!fileExists(prevPath))
    return [{ label: "Week A/B", ok: true, detail: `Week A — proposalId: ${currId.slice(0, 14)}... (no prev week)` }];

  const prevData = readJSON(prevPath);
  const prevId: string | undefined = prevData.proposalId;
  const isWeekB = !!prevId && currId === prevId;

  return [{
    label: "Week A/B",
    ok: true,
    detail: isWeekB
      ? `Week B — same proposalId as prev week (${currId.slice(0, 14)}...) — delegator sets must be identical`
      : `Week A — new proposalId: ${currId.slice(0, 14)}...`,
  }];
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  let timestamp: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) { timestamp = parseInt(args[++i]); }
    else if (args[i] === "--help") {
      console.log(`
Usage: pnpm tsx script/vlCVX/verify/distribution.ts [options]

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
  console.log(`  vlCVX Distribution Verification: ${timestamp} (${date})`);
  console.log("═".repeat(70));

  let allOk = true;

  if (!printSection("File Existence", checkFileExistence(timestamp))) allOk = false;
  if (!printSection("Delegation Shares", checkVlCVXDelegationShares(timestamp))) allOk = false;
  if (!printSection("Merkle Integrity", checkMerkleIntegrity(timestamp, VLCVX_MERKLE_CONFIGS))) allOk = false;
  if (!printSection("Week Comparison", checkWeekComparison(timestamp, VLCVX_MERKLE_CONFIGS))) allOk = false;
  if (!printSection("Token Completeness", checkTokenCompleteness(timestamp, VLCVX_TOKEN_CHECKS))) allOk = false;
  if (!printSection("Exclusion Checks", checkExclusions(timestamp))) allOk = false;
  if (!printSection("Group Allocation", checkGroupAllocation(timestamp))) allOk = false;
  if (!printSection("Week A/B", checkWeekAB(timestamp))) allOk = false;

  console.log(`\n${"═".repeat(70)}`);
  console.log(allOk ? "  ✅ All vlCVX distribution checks passed" : "  ❌ Some checks failed — see above");
  console.log("═".repeat(70));

  process.exit(allOk ? 0 : 1);
}

main();
