import { MerkleData } from "../../interfaces/MerkleData";
import { WEEK } from "../constants";

/**
 * Per-gauge cumulative files may seed the standard global merge only when they
 * are both current and proven to decompose the live global root.
 */
export function canUseStandardGaugeMerge(
  currentPeriodTimestamp: number,
  matchedGlobalPeriod: number | null,
  activeRoot: string,
  previousGaugeGlobal: MerkleData | null
): boolean {
  return (
    matchedGlobalPeriod === currentPeriodTimestamp - WEEK &&
    previousGaugeGlobal?.merkleRoot.toLowerCase() === activeRoot.toLowerCase()
  );
}
