import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { formatUnits, parseUnits, type PublicClient } from "viem";
import {
  SD_SWAP_REFERENCES,
  WEEK,
  WETH_CHAIN_IDS,
} from "../../utils/constants";
import { getClient } from "../../utils/getClients";
import { sendTelegramMessage } from "../../utils/telegramUtils";
import { checkSdAttribution } from "./reconstructSdMerkle";
import type { SdTransferDestination } from "./reconstructSdMerkle";

const REPORTS_DIR = "bounties-reports";
const WEEKLY_DIR = "weekly-bounties";
const SOURCES = ["votemarket_v1", "votemarket_v2"] as const;
const SOURCE_DIR: Record<(typeof SOURCES)[number], string> = {
  votemarket_v1: "votemarket",
  votemarket_v2: "votemarket-v2",
};
const PROTOCOLS = ["curve", "fxn"] as const;
const POOL_ABI = [{
  name: "get_dy",
  type: "function",
  stateMutability: "view",
  inputs: [
    { name: "i", type: "int128" },
    { name: "j", type: "int128" },
    { name: "dx", type: "uint256" },
  ],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

export type ReportProtocol = (typeof PROTOCOLS)[number];

export interface ReportGateResult {
  id: "R1" | "R2" | "R3" | "R4" | "R5";
  name: string;
  ok: boolean;
  detail: string;
}

interface Claim {
  gauge?: unknown;
  rewardToken?: unknown;
  amount?: unknown;
}

interface CsvRow {
  period?: string;
  gaugeName: string;
  gauge: string;
  rewardToken: string;
}

interface Attribution {
  totals: {
    sdInTotal: number;
    sdAssigned: number;
    wethInTotal: number;
    wethOutTotal: number;
  };
  dropped?: { tokensNotSwapped?: string[] };
  txs?: Array<{
    tx?: string;
    wethIn?: number;
    wethOut?: number;
    sdIn?: number;
    nativeOut?: number;
  }>;
  cleanupTransactions?: Array<{
    residualWethConsumed?: Record<string, number>;
  }>;
}

const lc = (value: string) => value.toLowerCase();

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function sourcePath(period: number, source: (typeof SOURCES)[number]): string {
  return path.join(WEEKLY_DIR, String(period), SOURCE_DIR[source], "claimed_bounties.json");
}

function claimsForProtocol(file: string, protocol: ReportProtocol): Claim[] {
  const data = readJson<Record<string, unknown>>(file);
  const raw = data[protocol];
  if (!raw || (typeof raw !== "object" && !Array.isArray(raw))) return [];
  return Object.values(raw as Record<string, Claim>);
}

function claimedVolume(file: string, protocol: ReportProtocol): bigint {
  return claimsForProtocol(file, protocol).reduce((sum, claim) => {
    if (typeof claim.amount !== "string" || !/^\d+$/.test(claim.amount)) {
      throw new Error(`${file} ${protocol} claim has invalid amount`);
    }
    return sum + BigInt(claim.amount);
  }, 0n);
}

function median(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return (sorted[1] + sorted[2]) / 2n;
}

export function withinVolumeBand(current: bigint, history: bigint[]): boolean {
  if (history.length !== 4) return false;
  // Steady-state zero: no volume now and none across the whole trailing window is a
  // consistently unused source (e.g. a retired platform), not a collapse.
  if (current <= 0n) return history.every((value) => value <= 0n);
  const middle = median(history);
  if (middle <= 0n) return false;
  const difference = current > middle ? current - middle : middle - current;
  return difference * 2n <= middle;
}

export function runR1(period: number, protocols: readonly ReportProtocol[]): ReportGateResult {
  const failures: string[] = [];
  let checked = 0;
  for (const protocol of protocols) {
    for (const source of SOURCES) {
      const currentFile = sourcePath(period, source);
      if (!existsSync(currentFile)) {
        failures.push(`${protocol}/${source}: weekly claims file missing`);
        continue;
      }
      const historyFiles = [1, 2, 3, 4].map((back) => sourcePath(period - back * WEEK, source));
      const missingHistory = historyFiles.find((file) => !existsSync(file));
      if (missingHistory) {
        failures.push(`${protocol}/${source}: trailing source file missing (${missingHistory})`);
        continue;
      }
      const current = claimedVolume(currentFile, protocol);
      const history = historyFiles.map((file) => claimedVolume(file, protocol));
      if (!withinVolumeBand(current, history)) {
        failures.push(
          `${protocol}/${source}: collapsed/outlier volume current=${current} trailing=[${history.join(",")}]`,
        );
        continue;
      }
      checked++;
    }
  }
  return {
    id: "R1",
    name: "Source completeness",
    ok: failures.length === 0,
    detail: failures.length === 0 ? `${checked} protocol-source volumes complete and within ±50%` : failures.join("; "),
  };
}

function readCsvRows(period: number, protocol: ReportProtocol): CsvRow[] {
  const rows: CsvRow[] = [];
  for (const suffix of [".csv", "-otc.csv"]) {
    const file = path.join(REPORTS_DIR, String(period), `${protocol}${suffix}`);
    if (!existsSync(file)) continue;
    const parsed = parseCsv(readFileSync(file, "utf8"), {
      columns: true,
      delimiter: ";",
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    for (const row of parsed) {
      rows.push({
        period: row.Period,
        gaugeName: (row["Gauge Name"] ?? "").trim().toLowerCase(),
        gauge: lc(row["Gauge Address"] ?? ""),
        rewardToken: lc(row["Reward Address"] ?? ""),
      });
    }
  }
  return rows;
}

function rootGaugeMap(period: number, protocol: ReportProtocol, rows: CsvRow[]): Map<string, string> {
  const auxiliary = path.join(
    REPORTS_DIR,
    String(period),
    protocol === "curve" ? "cvx.csv" : "cvx_fxn.csv",
  );
  if (!existsSync(auxiliary)) return new Map();
  const actualByName = new Map(rows.map((row) => [row.gaugeName, row.gauge]));
  const parsed = parseCsv(readFileSync(auxiliary, "utf8"), {
    columns: true,
    delimiter: ";",
    skip_empty_lines: true,
  }) as Array<Record<string, string>>;
  const mapping = new Map<string, string>();
  for (const row of parsed) {
    const name = (row["Gauge Name"] ?? "").trim().toLowerCase();
    const root = lc(row["Gauge Address"] ?? "");
    const actual = actualByName.get(name);
    if (root && actual) mapping.set(root, actual);
  }
  return mapping;
}

const provenanceKey = (gauge: string, token: string) => `${lc(gauge)}|${lc(token)}`;

export function runR2(period: number, protocols: readonly ReportProtocol[]): ReportGateResult {
  const failures: string[] = [];
  let rowCount = 0;
  let claimCount = 0;
  for (const protocol of protocols) {
    const rows = readCsvRows(period, protocol);
    const gaugeMap = rootGaugeMap(period, protocol, rows);
    const rowKeys = new Set<string>();
    for (const row of rows) {
      if (row.period && Number(row.period) !== period) {
        failures.push(`${protocol} OTC row has period ${row.period}, expected ${period}`);
      }
      rowKeys.add(provenanceKey(row.gauge, row.rewardToken));
      rowCount++;
    }

    const claims: Claim[] = [];
    for (const source of SOURCES) {
      const file = sourcePath(period, source);
      if (existsSync(file)) claims.push(...claimsForProtocol(file, protocol));
    }
    const claimKeys = new Set<string>();
    for (const claim of claims) {
      if (typeof claim.gauge !== "string" || typeof claim.rewardToken !== "string") {
        failures.push(`${protocol} claim missing gauge or rewardToken`);
        continue;
      }
      const gauge = gaugeMap.get(lc(claim.gauge)) ?? claim.gauge;
      claimKeys.add(provenanceKey(gauge, claim.rewardToken));
      claimCount++;
    }

    const attrFile = path.join(REPORTS_DIR, String(period), `${protocol}-attribution.json`);
    const dropped = existsSync(attrFile)
      ? new Set((readJson<Attribution>(attrFile).dropped?.tokensNotSwapped ?? []).map(lc))
      : new Set<string>();
    for (const key of rowKeys) {
      if (!claimKeys.has(key)) failures.push(`${protocol} CSV row has no raw claim: ${key}`);
    }
    for (const key of claimKeys) {
      const token = key.split("|")[1];
      if (!rowKeys.has(key) && !dropped.has(token)) {
        failures.push(`${protocol} raw claim has no CSV row or attribution.dropped justification: ${key}`);
      }
    }
  }
  return {
    id: "R2",
    name: "Row provenance",
    ok: failures.length === 0,
    detail: failures.length === 0 ? `${rowCount} rows and ${claimCount} claimed bounties map both directions` : failures.join("; "),
  };
}

function relativeMatch(left: number, right: number, tolerance = 0.001): boolean {
  const scale = Math.max(Math.abs(left), Math.abs(right));
  return scale === 0 || Math.abs(left - right) / scale <= tolerance;
}

async function runR3(
  period: number,
  protocols: readonly ReportProtocol[],
  client: PublicClient,
  destination: SdTransferDestination,
): Promise<ReportGateResult> {
  await checkSdAttribution(period, client, protocols, destination);
  const details: string[] = [];
  for (const protocol of protocols) {
    const attr = readJson<Attribution>(
      path.join(REPORTS_DIR, String(period), `${protocol}-attribution.json`),
    );
    if (!relativeMatch(attr.totals.sdInTotal, attr.totals.sdAssigned)) {
      throw new Error(
        `${protocol}: sdInTotal=${attr.totals.sdInTotal}, sdAssigned=${attr.totals.sdAssigned}`,
      );
    }
    details.push(`${protocol} assigned=${attr.totals.sdAssigned}`);
  }
  return { id: "R3", name: "Swap conservation", ok: true, detail: details.join("; ") };
}

export function rateFailures(
  attribution: Attribution,
  sdPerNative: number,
  tolerance: number,
): string[] {
  const failures: string[] = [];
  for (const tx of attribution.txs ?? []) {
    const wethIn = tx.wethIn ?? 0;
    if (wethIn <= 0) continue;
    const sdIn = tx.sdIn ?? 0;
    const nativeOut = tx.nativeOut ?? 0;
    const effective = sdIn / wethIn;
    const reference = (nativeOut / wethIn) * sdPerNative;
    if (!Number.isFinite(effective) || !Number.isFinite(reference) || reference <= 0 || Math.abs(effective - reference) / reference > tolerance) {
      failures.push(`${tx.tx ?? "unknown"} effective=${effective} reference=${reference}`);
    }
  }
  return failures;
}

async function poolSdPerNative(client: PublicClient, protocol: ReportProtocol): Promise<number> {
  const config = SD_SWAP_REFERENCES[protocol];
  const probe = parseUnits(String(config.probeSize), 18);
  const nativePerSdRaw = await client.readContract({
    address: config.pool,
    abi: POOL_ABI,
    functionName: "get_dy",
    args: [1n, 0n, probe],
  });
  const nativePerSd = Number(formatUnits(nativePerSdRaw, 18)) / config.probeSize;
  if (nativePerSd >= config.peg) return 1;
  const sdPerNativeRaw = await client.readContract({
    address: config.pool,
    abi: POOL_ABI,
    functionName: "get_dy",
    args: [0n, 1n, probe],
  });
  return Number(formatUnits(sdPerNativeRaw, 18)) / config.probeSize;
}

async function runR4(
  period: number,
  protocols: readonly ReportProtocol[],
  client: PublicClient,
  tolerance: number,
): Promise<ReportGateResult> {
  const failures: string[] = [];
  let batches = 0;
  for (const protocol of protocols) {
    const attribution = readJson<Attribution>(
      path.join(REPORTS_DIR, String(period), `${protocol}-attribution.json`),
    );
    const pricedBatches = (attribution.txs ?? []).filter((tx) => (tx.wethIn ?? 0) > 0);
    if (pricedBatches.length === 0) continue;
    const sdPerNative = await poolSdPerNative(client, protocol);
    failures.push(...rateFailures(attribution, sdPerNative, tolerance).map((failure) => `${protocol}/${failure}`));
    batches += pricedBatches.length;
  }
  return {
    id: "R4",
    name: "Rate sanity",
    ok: failures.length === 0,
    detail: failures.length === 0 ? `${batches} WETH swap batches within ±${tolerance * 100}% of peg-aware pool reference` : failures.join("; "),
  };
}

export function wethResidual(attribution: Attribution): number {
  const settled = (attribution.cleanupTransactions ?? []).reduce(
    (sum, cleanup) => sum + Object.values(cleanup.residualWethConsumed ?? {}).reduce((inner, value) => inner + value, 0),
    0,
  );
  // Cleanup transactions reconcile leftover WETH, so they can only pull the residual
  // toward zero — never create one. A native-token recovery (no WETH flow at all)
  // records its basis here but leaves wethIn/wethOut untouched, so the clamp keeps the
  // ledger balanced instead of manufacturing a spurious residual.
  const raw = attribution.totals.wethInTotal - attribution.totals.wethOutTotal;
  return Math.sign(raw) * Math.max(0, Math.abs(raw) - settled);
}

export function runR5(
  period: number,
  protocols: readonly ReportProtocol[],
  wethUsd: number,
): ReportGateResult {
  const failures: string[] = [];
  const details: string[] = [];
  for (const protocol of protocols) {
    const attribution = readJson<Attribution>(
      path.join(REPORTS_DIR, String(period), `${protocol}-attribution.json`),
    );
    const residual = wethResidual(attribution);
    const usd = Math.abs(residual) * wethUsd;
    if (!Number.isFinite(usd) || usd >= 50) failures.push(`${protocol}: residual=${residual} WETH ($${usd})`);
    else details.push(`${protocol}=$${usd.toFixed(4)}`);
  }
  return {
    id: "R5",
    name: "WETH ledger",
    ok: failures.length === 0,
    detail: failures.length === 0 ? `${details.join("; ")} residual (<$50 each)` : failures.join("; "),
  };
}

async function wethUsdPrice(): Promise<number> {
  const response = await fetch(
    `https://coins.llama.fi/prices/current/ethereum:${lc(WETH_CHAIN_IDS[1])}`,
  );
  if (!response.ok) throw new Error(`WETH price HTTP ${response.status}`);
  const body = await response.json() as { coins?: Record<string, { price?: unknown }> };
  const value = Object.values(body.coins ?? {})[0]?.price;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("WETH price response is invalid");
  }
  return value;
}

async function runCheck(
  id: ReportGateResult["id"],
  name: string,
  callback: () => ReportGateResult | Promise<ReportGateResult>,
): Promise<ReportGateResult> {
  try {
    return await callback();
  } catch (error) {
    return { id, name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const period = Number(argValue("--period"));
  if (!Number.isInteger(period) || period <= 0) throw new Error("Usage: reportGate.ts --period <timestamp> [--protocol curve|fxn] [--sd-destination botmarket|distributor] [--notify-only]");
  const requested = argValue("--protocol");
  if (requested && !PROTOCOLS.includes(requested as ReportProtocol)) throw new Error(`unsupported protocol ${requested}`);
  const protocols: readonly ReportProtocol[] = requested ? [requested as ReportProtocol] : PROTOCOLS;
  const tolerance = Number(argValue("--rate-tolerance") ?? "0.05");
  if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error("--rate-tolerance must be positive");
  const destination = argValue("--sd-destination") ?? "botmarket";
  if (destination !== "botmarket" && destination !== "distributor") {
    throw new Error("--sd-destination must be botmarket or distributor");
  }
  const notifyOnly = process.argv.includes("--notify-only");
  const clientPromise = getClient(1);

  const results: ReportGateResult[] = [];
  results.push(await runCheck("R1", "Source completeness", () => runR1(period, protocols)));
  results.push(await runCheck("R2", "Row provenance", () => runR2(period, protocols)));
  results.push(await runCheck("R3", "Swap conservation", async () => runR3(period, protocols, await clientPromise, destination)));
  results.push(await runCheck("R4", "Rate sanity", async () => runR4(period, protocols, await clientPromise, tolerance)));
  results.push(await runCheck("R5", "WETH ledger", async () => {
    const residuals = protocols.map((protocol) => wethResidual(readJson<Attribution>(path.join(REPORTS_DIR, String(period), `${protocol}-attribution.json`))));
    const price = residuals.every((value) => Math.abs(value) < 0.0005) ? 100_000 : await wethUsdPrice();
    return runR5(period, protocols, price);
  }));

  console.log(`sdToken report gate: period=${period} protocols=${protocols.join(",")}`);
  for (const result of results) console.log(`[${result.ok ? "PASS" : "FAIL"}] ${result.id} ${result.name} — ${result.detail}`);
  console.log(`RESULT: ${results.every((result) => result.ok) ? "PASS" : "FAIL"} — ${results.filter((result) => result.ok).length}/${results.length} checks passed`);

  if (notifyOnly) {
    const icon = results.every((result) => result.ok) ? "✅" : "⚠️";
    await sendTelegramMessage(
      `${icon} <b>sdToken report verification</b>\n${results.map((result) => `${result.ok ? "PASS" : "FAIL"} ${result.id}: ${result.detail}`).join("\n")}`,
      "HTML",
    );
  } else if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[FAIL] setup — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
