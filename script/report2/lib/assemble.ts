// ABOUTME: report2 assemble stage
// ABOUTME: Produce CSV and sidecar from collected bounties and attribution

import fs from "fs";
import path from "path";
import { Protocol, CollectOutput, FetchOutput, AttributeOutput, AssembleOutputRow } from "./types";
import { ensureDir, readJson, reportsDir, stagePath } from "./io";
import { getGaugesInfos, escapeCSV, PROTOCOLS_TOKENS } from "../../utils/reportUtils";

export async function cmdAssemble(protocol: Protocol, period: number) {
  const collect: CollectOutput = readJson(stagePath(period, protocol, "collect"), null);
  const fetched: FetchOutput = readJson(stagePath(period, protocol, "fetch"), null);
  const attr: AttributeOutput = readJson(stagePath(period, protocol, "attribute"), null);
  if (!collect || !fetched || !attr) throw new Error(`collect/fetch/attribute artifacts missing for ${protocol} ${period}`);

  const gauges = await getGaugesInfos(protocol);
  const gaugeMap = new Map(gauges.map((g) => [g.address.toLowerCase(), { name: g.name, actualGauge: g.actualGauge }]));

  const tokenInfos = fetched.tokenInfos as Record<string, { symbol: string; decimals: number }>;
  const sdAddr = PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase();
  const nativeAddr = PROTOCOLS_TOKENS[protocol].native.toLowerCase();

  // Build rows from bounties
  const rows: AssembleOutputRow[] = [];
  const byToken: Record<string, AssembleOutputRow[]> = {};
  for (const bounty of Object.values(collect.bounties[protocol] || {})) {
    const rewardAddrRaw = String((bounty as any).rewardToken);
    const rewardAddr = rewardAddrRaw.toLowerCase();
    const tokenInfo = tokenInfos[rewardAddr] || { symbol: "UNKNOWN", decimals: 18 };
    const amount = Number((bounty as any).amount || "0");
    const formatted = amount / Math.pow(10, tokenInfo.decimals);
    const gaugeAddr: string = String((bounty as any).gauge);
    const gaugeInfo = gaugeMap.get(gaugeAddr.toLowerCase());
    const row: AssembleOutputRow = {
      gaugeName: (gaugeInfo?.name || (bounty as any).gaugeName || "Unknown"),
      gaugeAddress: gaugeInfo?.actualGauge || gaugeAddr,
      rewardToken: tokenInfo.symbol,
      rewardAddress: rewardAddrRaw,
      rewardAmount: formatted,
      rewardSdValue: 0,
      sharePercentage: 0,
    };
    rows.push(row);
    (byToken[rewardAddr] ||= []).push(row);
  }

  // Assign SD values
  // Direct sd bounties preserve their amount
  for (const r of rows) {
    if (r.rewardAddress.toLowerCase() === sdAddr) {
      r.rewardSdValue = r.rewardAmount;
    }
  }

  // Distribute remaining sd according to per-token attributions
  const included = new Set(Object.keys(attr.includedSdByToken).map((t) => t.toLowerCase()));
  for (const [token, sdShare] of Object.entries(attr.includedSdByToken)) {
    const t = token.toLowerCase();
    if (!byToken[t]) continue;
    const tokenRows = byToken[t];
    const base = tokenRows.reduce((s, r) => s + r.rewardSdValue, 0);
    const sumAmt = tokenRows.reduce((s, r) => s + r.rewardAmount, 0);
    // Proportional by existing sd if any, otherwise by amount
    const weights = base > 0 ? tokenRows.map((r) => r.rewardSdValue / base) : tokenRows.map((r) => (r.rewardAmount / (sumAmt || 1)));
    tokenRows.forEach((r, i) => { r.rewardSdValue = (weights[i] || 0) * sdShare; });
  }

  // Drop rows that have zero value unless they are sd token rows
  const filteredRows = rows.filter((r) => r.rewardSdValue > 0 || r.rewardAddress.toLowerCase() === sdAddr);

  // Compute shares
  const total = filteredRows.reduce((s, r) => s + (r.rewardSdValue || 0), 0);
  if (total > 0) filteredRows.forEach((r) => { r.sharePercentage = (r.rewardSdValue / total) * 100; });

  // Write CSV
  const outDir = reportsDir(period);
  ensureDir(outDir);
  const csv = [
    "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
    ...filteredRows.map((r) => (
      `${escapeCSV(r.gaugeName)};${escapeCSV(r.gaugeAddress)};${escapeCSV(r.rewardToken)};${escapeCSV(r.rewardAddress)};` +
      `${r.rewardAmount.toFixed(6)};${r.rewardSdValue.toFixed(6)};${r.sharePercentage.toFixed(2)}`
    )),
  ].join("\n");
  const csvPath = path.join(outDir, `${protocol}.csv`);
  fs.writeFileSync(csvPath, csv);

  // Sidecar
  const sidecar = {
    protocol,
    period,
    totals: {
      sdMinted: Number(attr.sdMintedTotal.toFixed ? (attr.sdMintedTotal as any).toFixed(6) : attr.sdMintedTotal),
      sdAssigned: Number(total.toFixed(6)),
      rows: filteredRows.length,
    },
  };
  const sidecarPath = stagePath(period, protocol, "sidecar");
  ensureDir(path.dirname(sidecarPath));
  fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
  return { csvPath, sidecarPath };
}
