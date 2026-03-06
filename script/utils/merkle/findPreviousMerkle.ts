import fs from "fs";
import path from "path";
import { MerkleData } from "../../interfaces/MerkleData";
import { WEEK } from "../constants";

const MAX_WEEKS_BACK = 12;

/**
 * Finds and loads the most recent previous merkle data for a given relative path.
 *
 * Scans backwards from the previous week up to MAX_WEEKS_BACK weeks.
 * This handles cases where a chain is skipped for one or more weeks (no distribution),
 * preventing the cumulative merkle from incorrectly resetting to zero.
 *
 * @param currentPeriodTimestamp - The current week's timestamp
 * @param relPath - Path relative to `bounties-reports/{timestamp}/` (e.g. "vlAURA/vlaura_merkle_42161.json")
 * @returns The most recent previous MerkleData found, or empty data if none
 */
export function findPreviousMerkle(
  currentPeriodTimestamp: number,
  relPath: string
): { data: MerkleData; foundAt: string | null } {
  for (let weeksBack = 1; weeksBack <= MAX_WEEKS_BACK; weeksBack++) {
    const ts = currentPeriodTimestamp - weeksBack * WEEK;
    const fullPath = path.join("bounties-reports", ts.toString(), relPath);
    if (fs.existsSync(fullPath)) {
      const data: MerkleData = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      return { data, foundAt: fullPath };
    }
  }
  return { data: { merkleRoot: "", claims: {} }, foundAt: null };
}
