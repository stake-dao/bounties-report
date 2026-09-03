import fs from "fs";
import path from "path";
import { MerkleData } from "../../interfaces/MerkleData";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";

const DEFAULT_REPORTS_ROOT = "bounties-reports";

export interface PreviousMerkleResult {
  data: MerkleData;
  foundAt: string | null;
}

function emptyMerkle(): MerkleData {
  return { merkleRoot: "", claims: {} };
}

/** Numeric report epochs before `currentPeriodTimestamp`, newest first. */
function previousReportPeriods(
  currentPeriodTimestamp: number,
  reportsRoot: string,
  includeCurrent = false
): number[] {
  if (!fs.existsSync(reportsRoot)) return [];

  return fs
    .readdirSync(reportsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((timestamp) =>
      includeCurrent
        ? timestamp <= currentPeriodTimestamp
        : timestamp < currentPeriodTimestamp
    )
    .sort((a, b) => b - a);
}

function loadMerkle(filePath: string): MerkleData | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as MerkleData;
  } catch {
    return null;
  }
}

/** Recompute a file's root instead of trusting its declared `merkleRoot`. */
function recomputeRoot(data: MerkleData): string {
  const distribution: Record<string, Record<string, string>> = {};
  for (const [account, claim] of Object.entries(data.claims ?? {})) {
    distribution[account] = {};
    for (const [token, tokenClaim] of Object.entries(claim.tokens ?? {})) {
      distribution[account][token] = tokenClaim.amount;
    }
  }
  return generateMerkleTree(distribution).merkleRoot.toLowerCase();
}

/**
 * Finds and loads the most recent previous merkle data for a given relative path.
 *
 * Scans every prior numeric report epoch, newest first. There is deliberately
 * no fixed week horizon: a chain can resume after an arbitrarily long pause and
 * its cumulative Merkle must never reset to zero.
 *
 * @param currentPeriodTimestamp - The current week's timestamp
 * @param relPath - Path relative to `bounties-reports/{timestamp}/` (e.g. "vlCVX/vlcvx_merkle_8453.json")
 * @returns The most recent previous MerkleData found, or empty data if none
 */
export function findPreviousMerkle(
  currentPeriodTimestamp: number,
  relPath: string,
  reportsRoot = DEFAULT_REPORTS_ROOT
): PreviousMerkleResult {
  for (const timestamp of previousReportPeriods(
    currentPeriodTimestamp,
    reportsRoot
  )) {
    const fullPath = path.join(reportsRoot, timestamp.toString(), relPath);
    if (fs.existsSync(fullPath)) {
      const data = loadMerkle(fullPath);
      if (data) return { data, foundAt: fullPath };
    }
  }
  return { data: emptyMerkle(), foundAt: null };
}

/**
 * Resolve the artifact that is actually active on-chain.
 *
 * Newer report files may have been generated but never accepted. A candidate
 * is therefore accepted only when the root recomputed from its claims matches
 * `activeRoot`. A `.superseded.json` sibling is also considered for restatements.
 */
export function findMerkleMatchingRoot(
  currentPeriodTimestamp: number,
  relPath: string,
  activeRoot: string,
  options: { reportsRoot?: string; includeCurrent?: boolean } = {}
): PreviousMerkleResult {
  const reportsRoot = options.reportsRoot ?? DEFAULT_REPORTS_ROOT;
  const expectedRoot = activeRoot.toLowerCase();
  const supersededRelPath = relPath.replace(/\.json$/, ".superseded.json");

  for (const timestamp of previousReportPeriods(
    currentPeriodTimestamp,
    reportsRoot,
    options.includeCurrent ?? false
  )) {
    for (const candidateRelPath of [relPath, supersededRelPath]) {
      const fullPath = path.join(
        reportsRoot,
        timestamp.toString(),
        candidateRelPath
      );
      if (!fs.existsSync(fullPath)) continue;

      const data = loadMerkle(fullPath);
      if (!data) continue;

      try {
        if (recomputeRoot(data) === expectedRoot) {
          return { data, foundAt: fullPath };
        }
      } catch {
        // Malformed artifacts are not valid root provenance; keep searching.
      }
    }
  }

  return { data: emptyMerkle(), foundAt: null };
}
