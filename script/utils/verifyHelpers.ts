/**
 * Shared helpers for distribution verification scripts.
 *
 * Contains:
 *  - Generic check functions (merkle integrity, week comparison, token completeness, CSV balance)
 *  - Shared types and constants
 *  - Output helpers
 */

import * as fs from "fs";
import * as path from "path";
import { WEEK } from "./constants";

// ── Constants ────────────────────────────────────────────────────────────────

export const REPORTS_DIR = path.join(__dirname, "../../bounties-reports");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

export interface MerkleConfig {
  label: string;
  path: string;
  optional?: boolean;
}

export interface TokenCheckConfig {
  label: string;
  csv: string;
  chain: string;
  merkle: string;
}

export interface ChainCheck {
  label: string;
  csv: string;
  chain: string;
  repartition: string;
  delegation: string;
}

// ── Primitive helpers ─────────────────────────────────────────────────────────

export function readJSON(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

export function weekDir(timestamp: number): string {
  return path.join(REPORTS_DIR, String(timestamp));
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/** Returns base path for a relative sub-path inside a week directory. */
export function bp(timestamp: number, rel: string): string {
  return path.join(REPORTS_DIR, String(timestamp), rel);
}

// ── Output ─────────────────────────────────────────────────────────────────────

export function printSection(title: string, results: CheckResult[]): boolean {
  if (results.length === 0) return true;

  console.log(`\n  ${title}`);
  console.log("  " + "─".repeat(60));

  let allOk = true;
  for (const r of results) {
    const icon = r.ok ? "✅" : "❌";
    console.log(`  ${icon} ${r.label}: ${r.detail}`);
    if (!r.ok) allOk = false;
  }

  return allOk;
}

// ── Generic check: Merkle integrity ───────────────────────────────────────────

export function checkMerkleIntegrity(
  timestamp: number,
  configs: MerkleConfig[]
): CheckResult[] {
  const results: CheckResult[] = [];
  const base = weekDir(timestamp);

  for (const cfg of configs) {
    const filePath = path.join(base, cfg.path);
    if (!fileExists(filePath)) {
      results.push({
        label: `${cfg.label} merkle`,
        ok: !!cfg.optional,
        detail: cfg.optional ? "not present (optional)" : "MISSING",
      });
      continue;
    }

    const data = readJSON(filePath);

    const root = data.merkleRoot || data.root || "";
    const rootOk = /^0x[a-fA-F0-9]{64}$/.test(root);
    results.push({
      label: `${cfg.label} root`,
      ok: rootOk,
      detail: rootOk ? root.slice(0, 10) + "..." : `INVALID: ${root}`,
    });

    const claims = Object.keys(data.claims || {});
    results.push({
      label: `${cfg.label} claims`,
      ok: claims.length > 0,
      detail: `${claims.length} claimants`,
    });

    const tokens = new Set<string>();
    for (const claimant of Object.values(data.claims || {}) as any[]) {
      for (const token of Object.keys(claimant.tokens || {})) {
        tokens.add(token.toLowerCase());
      }
    }
    results.push({
      label: `${cfg.label} tokens`,
      ok: tokens.size > 0,
      detail: `${tokens.size} unique tokens`,
    });
  }

  return results;
}

// ── Generic check: Week comparison ────────────────────────────────────────────

export function checkWeekComparison(
  timestamp: number,
  configs: MerkleConfig[]
): CheckResult[] {
  const results: CheckResult[] = [];
  const prevTimestamp = timestamp - WEEK;
  const base = weekDir(timestamp);
  const prevBase = weekDir(prevTimestamp);

  for (const cfg of configs) {
    const currPath = path.join(base, cfg.path);
    const prevPath = path.join(prevBase, cfg.path);

    if (!fileExists(currPath)) continue;

    const currData = readJSON(currPath);
    const currCount = Object.keys(currData.claims || {}).length;

    if (!fileExists(prevPath)) {
      results.push({
        label: `${cfg.label} vs prev week`,
        ok: true,
        detail: `${currCount} claims (no prev week data)`,
      });
      continue;
    }

    const prevData = readJSON(prevPath);
    const prevCount = Object.keys(prevData.claims || {}).length;
    const change = prevCount > 0 ? ((currCount / prevCount - 1) * 100) : 0;
    const deviation = Math.abs(change);
    const ok = deviation <= 20;

    results.push({
      label: `${cfg.label} vs prev week`,
      ok,
      detail: `${currCount} (this) vs ${prevCount} (prev) = ${change >= 0 ? "+" : ""}${change.toFixed(1)}%`,
    });
  }

  return results;
}

// ── Generic check: Token completeness ─────────────────────────────────────────

function parseCSVTokens(csvPath: string, chainFilter: string): Set<string> {
  const tokens = new Set<string>();
  if (!fileExists(csvPath)) return tokens;

  const raw = fs.readFileSync(csvPath, "utf-8");
  const lines = raw.trim().split("\n").slice(1);

  for (const line of lines) {
    const parts = line.split(";");
    if (parts[0] !== chainFilter) continue;
    tokens.add(parts[4].toLowerCase());
  }

  return tokens;
}

function getMerkleTokens(merklePath: string): Set<string> {
  const tokens = new Set<string>();
  if (!fileExists(merklePath)) return tokens;

  const data = readJSON(merklePath);
  for (const claimant of Object.values(data.claims || {}) as any[]) {
    for (const token of Object.keys(claimant.tokens || {})) {
      tokens.add(token.toLowerCase());
    }
  }

  return tokens;
}

export function checkTokenCompleteness(
  timestamp: number,
  configs: TokenCheckConfig[]
): CheckResult[] {
  const results: CheckResult[] = [];
  const base = weekDir(timestamp);

  for (const cfg of configs) {
    const csvPath = path.join(base, cfg.csv);
    const merklePath = path.join(base, cfg.merkle);

    const csvTokens = parseCSVTokens(csvPath, cfg.chain);
    if (csvTokens.size === 0) {
      results.push({
        label: `${cfg.label} token completeness`,
        ok: true,
        detail: `no ${cfg.chain} entries in CSV`,
      });
      continue;
    }

    const merkleTokens = getMerkleTokens(merklePath);
    const missing: string[] = [];
    for (const token of csvTokens) {
      if (!merkleTokens.has(token)) missing.push(token);
    }

    const ok = missing.length === 0;
    results.push({
      label: `${cfg.label} token completeness`,
      ok,
      detail: ok
        ? `${csvTokens.size} CSV tokens all in merkle`
        : `MISSING: ${missing.map(shortAddr).join(", ")}`,
    });
  }

  return results;
}

// ── Generic check: CSV = Delegation + Non-Delegator balance ──────────────────

export function verifyCSVBalance(
  timestamp: number,
  checks: ChainCheck[]
): { allOk: boolean; results: string[] } {
  let allOk = true;
  const results: string[] = [];

  for (const cfg of checks) {
    results.push(`\n  === ${cfg.label}: CSV = Delegation + Non-Delegator ===`);

    const csvPath = bp(timestamp, cfg.csv);
    if (!fs.existsSync(csvPath)) {
      results.push(`  ⚠️  CSV not found: ${cfg.csv}`);
      continue;
    }

    const csvRaw = fs.readFileSync(csvPath, "utf-8");
    const lines = csvRaw.trim().split("\n").slice(1);

    const csvPerToken: Record<string, bigint> = {};
    for (const line of lines) {
      const parts = line.split(";");
      if (parts[0] !== cfg.chain) continue;
      const token = parts[4].toLowerCase();
      const amount = BigInt(parts[5]);
      csvPerToken[token] = (csvPerToken[token] || 0n) + amount;
    }

    if (Object.keys(csvPerToken).length === 0) {
      results.push(`  ⚠️  No chain=${cfg.chain} entries in CSV — skipping`);
      continue;
    }

    let repartition: any;
    let delegation: any;
    try {
      repartition = readJSON(bp(timestamp, cfg.repartition));
      delegation = readJSON(bp(timestamp, cfg.delegation));
    } catch (e: any) {
      results.push(`  ❌ Missing files: ${e.message}`);
      allOk = false;
      continue;
    }

    const nonDelegPerToken: Record<string, bigint> = {};
    for (const [, gaugeData] of Object.entries(repartition.distribution) as [string, any][]) {
      for (const [token, amount] of Object.entries(gaugeData.tokens) as [string, string][]) {
        const key = token.toLowerCase();
        nonDelegPerToken[key] = (nonDelegPerToken[key] || 0n) + BigInt(amount);
      }
    }

    const delegPerToken: Record<string, bigint> = {};
    for (const [token, amount] of Object.entries(delegation.distribution.totalTokens) as [string, string][]) {
      delegPerToken[token.toLowerCase()] = BigInt(amount);
    }

    const allTokens = new Set([
      ...Object.keys(csvPerToken),
      ...Object.keys(delegPerToken),
      ...Object.keys(nonDelegPerToken),
    ]);

    let checkOk = true;
    for (const token of [...allTokens].sort()) {
      const csv = csvPerToken[token] || 0n;
      const deleg = delegPerToken[token] || 0n;
      const nonDeleg = nonDelegPerToken[token] || 0n;
      const sum = deleg + nonDeleg;
      const diff = csv - sum;
      const ok = diff === 0n;
      if (!ok) { checkOk = false; allOk = false; }

      const icon = ok ? "✅" : "❌";
      results.push(
        `  ${icon} ${shortAddr(token)} | CSV=${csv.toString().padStart(28)} | D+ND=${sum.toString().padStart(28)} | diff=${diff.toString()}`
      );
    }
    results.push(checkOk ? `  RESULT: ✅ ALL balanced` : `  RESULT: ❌ MISMATCH`);
  }

  return { allOk, results };
}
