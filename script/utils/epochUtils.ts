// ABOUTME: Utilities for calculating Votium 2-week epoch boundaries
// ABOUTME: Provides functions to compute epoch starts for reward distributions
import { TWOWEEKS } from "./constants";

/**
 * Calculates the start timestamp of the current Votium 2-week epoch
 * @param nowSeconds - Current timestamp in seconds (defaults to now)
 * @returns Epoch start timestamp in seconds
 */
export function computeCurrentEpochStart(nowSeconds: number = Math.floor(Date.now() / 1000)): number {
  return nowSeconds - (nowSeconds % TWOWEEKS);
}
