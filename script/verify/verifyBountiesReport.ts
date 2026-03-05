/**
 * Comprehensive bounties report verification.
 *
 * Mirrors what the OTC dashboard "Analytics" page shows:
 *   1. CSV files — existence, column integrity, share sum ≈ 100 %
 *   2. Attribution — sdInTotal ≈ CSV sdValue sum, dropped tokens flagged
 *   3. CSV ↔ Attribution cross-check — every CSV token must be in perToken or dropped
 *   4. claimed_bounties.json ↔ CSV — every VoteMarket claim must appear in CSV
 *   5. BotMarket allowlist — claiming addresses are authorised
 *
 * Usage:
 *   pnpm tsx script/verify/verifyBountiesReport.ts [--epoch EPOCH]
 *
 * Exit 0 = all checks pass (or only warnings)
 * Exit 1 = at least one ❌ failure
 */

import * as fs from "fs";
import * as path from "path";
import { createPublicClient, http, fallback, getAddress } from "viem";
import { mainnet } from "viem/chains";
import { getAvailableEndpoints } from "../utils/rpcConfig";

// ── Root gauge map ─────────────────────────────────────────────────────────────
// Curve (and potentially other protocols) have "root gauges" on L2 chains.
// claimed_bounties.json records the L2 root gauge address, but the CSV reports
// the actual mainnet gauge address. We resolve root→actual before cross-checking.

async function buildRootGaugeMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>(); // rootGauge (lowercase) → actualGauge (lowercase)
  try {
    const res = await fetch("https://raw.githubusercontent.com/stake-dao/votemarket-data/main/gauges/curve.json");
    if (!res.ok) return map;
    const json: any = await res.json();
    const data = json.data ?? json;
    for (const gauge of Object.values(data) as any[]) {
      if (gauge.rootGauge && gauge.gauge) {
        map.set(gauge.rootGauge.toLowerCase(), gauge.gauge.toLowerCase());
      }
    }
  } catch {
    // Non-fatal — fall through with empty map
  }
  return map;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const REPORTS_DIR = path.join(__dirname, "../../bounties-reports");
const WEEKLY_DIR = path.join(__dirname, "../../weekly-bounties");
const WEEK = 604800;

const PROTOCOLS = ["curve", "balancer", "frax", "pendle", "fxn"] as const;
type Protocol = (typeof PROTOCOLS)[number];

const BOT_MARKET = "0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF" as const;
const BOT_MARKET_ABI = [
  {
    name: "isAllowed",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "operator", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// Known claiming addresses (BotMarket operators)
const CLAIMING_ADDRESSES = [
  "0x52ea58f4FC3CEd48fa18E909226c1f8A0EF887DC", // delegation address / locker
];

// Tolerance for float comparisons (0.5 %)
const TOLERANCE = 0.005;

// ── Types ─────────────────────────────────────────────────────────────────────

interface CheckResult {
  label: string;
  ok: boolean;
  warn?: boolean; // ok=true but noteworthy
  detail: string;
}

interface CsvRow {
  gaugeName: string;
  gaugeAddress: string;
  rewardToken: string;
  rewardAddress: string;
  rewardAmount: number;
  rewardSdValue: number;
  sharePercent: number;
}

interface AttributionJson {
  protocol: string;
  period: number;
  aggregator: string;
  totals: {
    sdInTotal: number;
    sdAssigned: number;
    wethInTotal: number;
    wethOutTotal: number;
  };
  dropped: {
    tokensNotSwapped: string[];
    wethNotSwapped: boolean;
  };
  perToken: Record<string, { mappedWeth: number; sd: number }>;
  txs: Array<{ tx: string; wethIn: number; sdIn: number; [k: string]: unknown }>;
}

interface ClaimEntry {
  chainId: number;
  bountyId: string;
  gauge: string;
  amount: string;
  rewardToken: string;
  isWrapped: boolean;
}

// ── File helpers ──────────────────────────────────────────────────────────────

function readJSON<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
}

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function epochDir(epoch: number): string {
  return path.join(REPORTS_DIR, String(epoch));
}

function weeklyDir(epoch: number): string {
  return path.join(WEEKLY_DIR, String(epoch));
}

// ── CSV parser ────────────────────────────────────────────────────────────────

/**
 * Parse a semicolon-delimited bounties CSV.
 * Both regular (no Period column) and OTC (Period prefix) formats are handled.
 */
function parseCsv(raw: string): CsvRow[] {
  const lines = raw.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].split(";").map((h) => h.trim());
  const hasPeriod = header[0].toLowerCase() === "period";

  const rows: CsvRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(";").map((c) => c.trim());
    const offset = hasPeriod ? 1 : 0;

    const gaugeName    = cols[offset] ?? "";
    const gaugeAddress = cols[offset + 1] ?? "";
    const rewardToken  = cols[offset + 2] ?? "";
    const rewardAddress = cols[offset + 3] ?? "";
    const rewardAmount  = parseFloat(cols[offset + 4] ?? "0");
    const rewardSdValue = parseFloat(cols[offset + 5] ?? "0");
    const sharePercent  = parseFloat(cols[offset + 6] ?? "0");

    if (!gaugeAddress) continue;
    rows.push({ gaugeName, gaugeAddress, rewardToken, rewardAddress, rewardAmount, rewardSdValue, sharePercent });
  }
  return rows;
}

// ── RPC client (fast, no retries) ─────────────────────────────────────────────

function makeMainnetClient() {
  const endpoints = getAvailableEndpoints(1)
    .filter((e) => !e.url.includes("stake-erpc") && !e.url.includes("ankr.com"))
    .slice(0, 3);
  const transports = endpoints.map((e) => http(e.url, { timeout: 10_000, retryCount: 1 }));
  return createPublicClient({ chain: mainnet, transport: fallback(transports) });
}

// ── Check 1: File existence ───────────────────────────────────────────────────

function checkFiles(epoch: number): CheckResult[] {
  const results: CheckResult[] = [];
  const base = epochDir(epoch);

  for (const proto of PROTOCOLS) {
    const csvPath = path.join(base, `${proto}.csv`);
    const attrPath = path.join(base, `${proto}-attribution.json`);
    const otcPath = path.join(base, `${proto}-otc.csv`);

    results.push({
      label: `${proto}.csv`,
      ok: exists(csvPath),
      detail: exists(csvPath) ? "exists" : "MISSING",
    });
    // Attribution is optional for OTC-only protocols (frax)
    const attrMissing = !exists(attrPath);
    results.push({
      label: `${proto}-attribution.json`,
      ok: true,
      warn: attrMissing,
      detail: attrMissing ? "not present (OTC-only or direct distribution)" : "exists",
    });
    results.push({
      label: `${proto}-otc.csv`,
      ok: true,
      warn: !exists(otcPath),
      detail: exists(otcPath) ? "exists" : "not present",
    });
  }

  const claimedPath = path.join(weeklyDir(epoch), "votemarket-v2", "claimed_bounties.json");
  results.push({
    label: "votemarket-v2/claimed_bounties.json",
    ok: exists(claimedPath),
    detail: exists(claimedPath) ? "exists" : "MISSING",
  });

  return results;
}

// ── Check 2 + 3: CSV integrity & Attribution cross-check ─────────────────────

interface ProtocolSummary {
  protocol: Protocol;
  csvSdTotal: number;
  csvGaugeCount: number;
  csvTokenCount: number;
  csvShareSum: number;
  attrSdTotal: number;
  attrTxCount: number;
  droppedTokens: string[];
  checks: CheckResult[];
}

function checkProtocol(epoch: number, proto: Protocol): ProtocolSummary {
  const base = epochDir(epoch);
  const checks: CheckResult[] = [];

  // ── CSV ──────────────────────────────────────────────────────────────────────
  const csvPath = path.join(base, `${proto}.csv`);
  const otcPath = path.join(base, `${proto}-otc.csv`);

  let rows: CsvRow[] = [];
  if (exists(csvPath)) {
    rows = [...rows, ...parseCsv(fs.readFileSync(csvPath, "utf-8"))];
  }
  if (exists(otcPath)) {
    rows = [...rows, ...parseCsv(fs.readFileSync(otcPath, "utf-8"))];
  }

  const csvSdTotal = rows.reduce((s, r) => s + r.rewardSdValue, 0);
  const csvShareSum = rows.reduce((s, r) => s + r.sharePercent, 0);
  const uniqueGauges = new Set(rows.map((r) => r.gaugeAddress.toLowerCase()));
  const uniqueTokens = new Set(rows.map((r) => r.rewardAddress.toLowerCase()));

  // Share sum should be close to 100 (excluding OTC rows which may have their own 100 %)
  const mainRows = exists(csvPath) ? parseCsv(fs.readFileSync(csvPath, "utf-8")) : [];
  const mainShareSum = mainRows.reduce((s, r) => s + r.sharePercent, 0);
  const shareOk = mainRows.length === 0 || Math.abs(mainShareSum - 100) < 0.5;
  checks.push({
    label: `${proto} share sum`,
    ok: shareOk,
    detail: `main CSV share sum = ${mainShareSum.toFixed(2)} %${shareOk ? "" : " ≠ 100"}`,
  });

  // ── Attribution ───────────────────────────────────────────────────────────────
  const attrPath = path.join(base, `${proto}-attribution.json`);
  if (!exists(attrPath)) {
    // Not all protocols run through the swap aggregator (e.g. frax is OTC-only)
    checks.push({ label: `${proto} attribution`, ok: true, warn: true, detail: "attribution.json not present (OTC-only protocol)" });
    return { protocol: proto, csvSdTotal, csvGaugeCount: uniqueGauges.size, csvTokenCount: uniqueTokens.size, csvShareSum, attrSdTotal: 0, attrTxCount: 0, droppedTokens: [], checks };
  }

  const attr = readJSON<AttributionJson>(attrPath);
  const attrSdTotal = attr.totals.sdInTotal;
  const droppedTokens = attr.dropped.tokensNotSwapped;

  // Protocols with wethNotSwapped=true and sdInTotal=0 use direct distribution (e.g. pendle)
  const isDirectDistrib = attr.dropped.wethNotSwapped && attrSdTotal === 0 && attr.txs.length === 0;

  // sdInTotal ≈ csvSdTotal (main CSV only — OTC rows are settled via OTC, not the aggregator)
  const mainCsvSdTotal = mainRows.reduce((s, r) => s + r.rewardSdValue, 0);
  if (isDirectDistrib) {
    checks.push({
      label: `${proto} CSV vs attribution sd total`,
      ok: true,
      warn: true,
      detail: `direct distribution (wethNotSwapped=true) — CSV=${mainCsvSdTotal.toFixed(2)}, no aggregator swap`,
    });
  } else if (mainCsvSdTotal > 0 && attrSdTotal > 0) {
    const diff = Math.abs(attrSdTotal - mainCsvSdTotal);
    const relDiff = diff / mainCsvSdTotal;
    const sdOk = relDiff < TOLERANCE;
    checks.push({
      label: `${proto} CSV vs attribution sd total`,
      ok: sdOk,
      detail: `CSV=${mainCsvSdTotal.toFixed(2)} attr=${attrSdTotal.toFixed(2)} diff=${diff.toFixed(2)} (${(relDiff * 100).toFixed(2)}%)`,
    });
  } else if (mainCsvSdTotal === 0 && attrSdTotal === 0) {
    checks.push({ label: `${proto} CSV vs attribution sd total`, ok: true, detail: "both zero (no activity)" });
  } else {
    checks.push({
      label: `${proto} CSV vs attribution sd total`,
      ok: false,
      detail: `CSV=${mainCsvSdTotal.toFixed(2)} attr=${attrSdTotal.toFixed(2)} — unexpected mismatch`,
    });
  }

  // sdAssigned ≈ sdInTotal
  if (attrSdTotal > 0) {
    const assignDiff = Math.abs(attr.totals.sdAssigned - attrSdTotal);
    const assignOk = assignDiff / attrSdTotal < TOLERANCE;
    checks.push({
      label: `${proto} sdAssigned ≈ sdInTotal`,
      ok: assignOk,
      detail: `assigned=${attr.totals.sdAssigned.toFixed(2)} total=${attrSdTotal.toFixed(2)}`,
    });
  }

  if (!isDirectDistrib) {
    // Only check MAIN CSV tokens against perToken/dropped — OTC tokens are settled separately
    const mainTokens = new Set(mainRows.map((r) => r.rewardAddress.toLowerCase()));
    const coveredTokens = new Set([
      ...Object.keys(attr.perToken).map((a) => a.toLowerCase()),
      ...droppedTokens.map((a) => a.toLowerCase()),
    ]);

    for (const tokenAddr of mainTokens) {
      if (!coveredTokens.has(tokenAddr)) {
        checks.push({
          label: `${proto} token ${tokenAddr.slice(0, 8)}… in attribution`,
          ok: false,
          detail: `token in main CSV but missing from attribution perToken and not in dropped list`,
        });
      }
    }
  }

  // Dropped tokens — flag as warnings (ORDER mismatches)
  for (const dropped of droppedTokens) {
    checks.push({
      label: `${proto} dropped token`,
      ok: true,
      warn: true,
      detail: `${dropped} was not swapped (ORDER mismatch)`,
    });
  }

  return {
    protocol: proto,
    csvSdTotal,
    csvGaugeCount: uniqueGauges.size,
    csvTokenCount: uniqueTokens.size,
    csvShareSum,
    attrSdTotal,
    attrTxCount: attr.txs.length,
    droppedTokens,
    checks,
  };
}

// ── Check 4: claimed_bounties ↔ CSV ───────────────────────────────────────────

function checkClaimedBounties(epoch: number, summaries: ProtocolSummary[], rootGaugeMap: Map<string, string>): CheckResult[] {
  const results: CheckResult[] = [];
  const claimedPath = path.join(weeklyDir(epoch), "votemarket-v2", "claimed_bounties.json");

  if (!exists(claimedPath)) {
    results.push({ label: "claimed_bounties.json", ok: false, detail: "file missing — skipping cross-check" });
    return results;
  }

  const claimed = readJSON<Record<string, Record<string, ClaimEntry>>>(claimedPath);
  const base = epochDir(epoch);

  for (const proto of PROTOCOLS) {
    const protoEntries = Object.values(claimed[proto] ?? {});
    if (protoEntries.length === 0) continue;

    // Build gauge set from CSV (case-insensitive)
    const csvPath = path.join(base, `${proto}.csv`);
    const otcPath = path.join(base, `${proto}-otc.csv`);
    let rows: CsvRow[] = [];
    if (exists(csvPath)) rows = [...rows, ...parseCsv(fs.readFileSync(csvPath, "utf-8"))];
    if (exists(otcPath)) rows = [...rows, ...parseCsv(fs.readFileSync(otcPath, "utf-8"))];

    // Separate main vs OTC rows
    const mainRows2 = exists(csvPath) ? parseCsv(fs.readFileSync(csvPath, "utf-8")) : [];
    const otcRows2  = exists(otcPath) ? parseCsv(fs.readFileSync(otcPath, "utf-8")) : [];

    // Map gauge address → { mainTokens, isOtc }
    const gaugeMainTokens = new Map<string, Set<string>>();
    const otcGauges = new Set<string>();
    for (const row of mainRows2) {
      const ga = row.gaugeAddress.toLowerCase();
      if (!gaugeMainTokens.has(ga)) gaugeMainTokens.set(ga, new Set());
      gaugeMainTokens.get(ga)!.add(row.rewardAddress.toLowerCase());
    }
    for (const row of otcRows2) {
      otcGauges.add(row.gaugeAddress.toLowerCase());
    }

    let okCount = 0;
    let missingGauge = 0;
    let tokenMismatch = 0;

    for (const entry of protoEntries) {
      // Resolve root gauge → actual gauge if applicable (Curve L2 cross-chain gauges)
      const rawGa = entry.gauge.toLowerCase();
      const ga = rootGaugeMap.get(rawGa) ?? rawGa;
      const rt = entry.rewardToken.toLowerCase();

      const inMain = gaugeMainTokens.has(ga);
      const inOtc  = otcGauges.has(ga);

      if (!inMain && !inOtc) {
        missingGauge++;
        results.push({
          label: `${proto} bountyId=${entry.bountyId} chain=${entry.chainId}`,
          ok: false,
          detail: `gauge ${entry.gauge.slice(0, 10)}… in claimed_bounties but NOT in any CSV`,
        });
        continue;
      }

      // OTC gauges: token may differ after OTC conversion — skip token check
      if (inOtc && !inMain) {
        okCount++;
        continue;
      }

      // Token check — skipped for isWrapped (wrapped token ≠ CSV token by design)
      if (!entry.isWrapped && inMain) {
        const csvTokens = gaugeMainTokens.get(ga)!;
        if (!csvTokens.has(rt)) {
          tokenMismatch++;
          results.push({
            label: `${proto} bountyId=${entry.bountyId} chain=${entry.chainId}`,
            ok: false,
            detail: `rewardToken ${entry.rewardToken.slice(0, 10)}… not in main CSV for gauge ${entry.gauge.slice(0, 10)}… (isWrapped=false)`,
          });
          continue;
        }
      }

      okCount++;
    }

    results.push({
      label: `${proto} claimed↔CSV`,
      ok: missingGauge === 0 && tokenMismatch === 0,
      detail: `${okCount}/${protoEntries.length} ok, ${missingGauge} missing gauge, ${tokenMismatch} token mismatch`,
    });
  }

  return results;
}

// ── Check 5: BotMarket allowlist ──────────────────────────────────────────────

async function checkBotMarket(): Promise<CheckResult[]> {
  const client = makeMainnetClient();
  const results: CheckResult[] = [];

  for (const addr of CLAIMING_ADDRESSES) {
    try {
      const allowed = await client.readContract({
        address: BOT_MARKET,
        abi: BOT_MARKET_ABI,
        functionName: "isAllowed",
        args: [getAddress(addr)],
      });
      results.push({
        label: `BotMarket ${addr.slice(0, 8)}…`,
        ok: allowed,
        detail: allowed ? "allowed ✅" : "NOT ALLOWED ❌ — claiming would revert",
      });
    } catch (err) {
      results.push({
        label: `BotMarket ${addr.slice(0, 8)}…`,
        ok: false,
        detail: `RPC error: ${err}`,
      });
    }
  }

  return results;
}

// ── Output helpers ────────────────────────────────────────────────────────────

function printSection(title: string, results: CheckResult[]): boolean {
  if (results.length === 0) return true;

  console.log(`\n  ${title}`);
  console.log("  " + "─".repeat(60));

  let allOk = true;
  for (const r of results) {
    const icon = !r.ok ? "❌" : r.warn ? "⚠️ " : "✅";
    console.log(`  ${icon} ${r.label}: ${r.detail}`);
    if (!r.ok) allOk = false;
  }
  return allOk;
}

function printSummaryTable(summaries: ProtocolSummary[]): void {
  console.log("\n  Protocol Summary");
  console.log("  " + "─".repeat(60));
  console.log(`  ${"Protocol".padEnd(12)} ${"CSV sdVal".padStart(12)} ${"Attr sdVal".padStart(12)} ${"Gauges".padStart(7)} ${"Tokens".padStart(7)} ${"Txs".padStart(5)} ${"Dropped".padStart(8)}`);
  console.log("  " + "─".repeat(60));

  let totalCsv = 0;
  let totalAttr = 0;

  for (const s of summaries) {
    totalCsv += s.csvSdTotal;
    totalAttr += s.attrSdTotal;

    const diff = s.droppedTokens.length > 0 ? `⚠️  ${s.droppedTokens.length}` : "—";
    console.log(
      `  ${s.protocol.padEnd(12)} ${s.csvSdTotal.toFixed(1).padStart(12)} ${s.attrSdTotal.toFixed(1).padStart(12)} ${String(s.csvGaugeCount).padStart(7)} ${String(s.csvTokenCount).padStart(7)} ${String(s.attrTxCount).padStart(5)} ${diff.padStart(8)}`
    );
  }

  console.log("  " + "─".repeat(60));
  console.log(`  ${"TOTAL".padEnd(12)} ${totalCsv.toFixed(1).padStart(12)} ${totalAttr.toFixed(1).padStart(12)}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let epoch: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--epoch" || args[i] === "--period") && args[i + 1]) {
      epoch = parseInt(args[++i], 10);
    } else if (args[i] === "--help") {
      console.log(`Usage: pnpm tsx script/verify/verifyBountiesReport.ts [--epoch EPOCH]\n`);
      process.exit(0);
    }
  }

  if (!epoch) {
    // Find latest epoch in bounties-reports/
    const dirs = fs.readdirSync(REPORTS_DIR)
      .map(Number)
      .filter((n) => !isNaN(n) && n > 1_000_000_000)
      .sort((a, b) => b - a);
    epoch = dirs[0];
    if (!epoch) {
      console.error("No epoch found in bounties-reports/");
      process.exit(1);
    }
  }

  const date = new Date(epoch * 1000).toISOString().split("T")[0];
  console.log("═".repeat(70));
  console.log(`  Bounties Report Verification: epoch ${epoch} (${date})`);
  console.log("═".repeat(70));

  let allOk = true;

  // 1 — files
  if (!printSection("File Existence", checkFiles(epoch))) allOk = false;

  // 2 + 3 — per-protocol CSV + attribution
  const summaries: ProtocolSummary[] = [];
  for (const proto of PROTOCOLS) {
    const base = epochDir(epoch);
    const csvPath = path.join(base, `${proto}.csv`);
    const attrPath = path.join(base, `${proto}-attribution.json`);
    if (!exists(csvPath) && !exists(attrPath)) continue; // skip entirely absent protocols

    const summary = checkProtocol(epoch, proto);
    summaries.push(summary);
    if (!printSection(`${proto.toUpperCase()} CSV + Attribution`, summary.checks)) allOk = false;
  }

  printSummaryTable(summaries);

  // 4 — claimed_bounties cross-check (needs root gauge map for Curve L2 gauges)
  console.log("\n  claimed_bounties ↔ CSV (resolving root gauges…)");
  const [rootGaugeMap, botResults] = await Promise.all([buildRootGaugeMap(), checkBotMarket()]);
  console.log(`  Root gauge map: ${rootGaugeMap.size} entries loaded`);
  if (!printSection("claimed_bounties ↔ CSV", checkClaimedBounties(epoch, summaries, rootGaugeMap))) allOk = false;

  // 5 — BotMarket allowlist
  if (!printSection("BotMarket", botResults)) allOk = false;

  // Final verdict
  console.log(`\n${"═".repeat(70)}`);
  console.log(allOk ? "  ✅ All bounties report checks passed" : "  ❌ Some checks failed — see above");
  console.log("═".repeat(70));

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
