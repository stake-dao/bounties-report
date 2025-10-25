// ABOUTME: IO helpers and path conventions for report2
// ABOUTME: Read/write JSON and resolve trace/output directories

import fs from "fs";
import path from "path";
import { Protocol } from "./types";

export function repoRoot(): string {
  return path.resolve(__dirname, "..", "..", "..");
}

export function getCurrentPeriod(weekSeconds = 604800): number {
  return Math.floor(Date.now() / 1000 / weekSeconds) * weekSeconds;
}

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

export function readJson<T = any>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(p: string, data: unknown) {
  const json = JSON.stringify(
    data as any,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2
  );
  fs.writeFileSync(p, json);
}

export function traceDir(period: number): string {
  return path.join(repoRoot(), "bounties-reports", String(period), "trace");
}

export function stagePath(period: number, protocol: Protocol, stage: string): string {
  return path.join(traceDir(period), `${protocol}-${stage}.json`);
}

export function collectSourcePaths(period: number) {
  const base = path.join(repoRoot(), "weekly-bounties", String(period));
  return {
    votemarket: path.join(base, "votemarket", "claimed_bounties.json"),
    votemarket_v2: path.join(base, "votemarket-v2", "claimed_bounties.json"),
    warden: path.join(base, "warden", "claimed_bounties.json"),
    hiddenhand: path.join(base, "hiddenhand", "claimed_bounties.json"),
  };
}

export function reportsDir(period: number): string {
  return path.join(repoRoot(), "bounties-reports", String(period));
}
