import { parseUnits } from "viem";

// Reports round each CSV amount to six decimals. JSON attribution still uses
// doubles; allow 1e-9 token per term while reconciling those legacy values.
export const CSV_ROUNDING_WEI = 1_000_000_000_000n;
export const ATTRIBUTION_DUST_WEI = 1_000_000_000n;

export function reportAmount(value: unknown, label: string): bigint {
  const text = typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value.toFixed(18) : value;
  if (typeof text !== "string" || !/^\d+(\.\d{1,18})?$/.test(text)) {
    throw new Error(`${label}: invalid nonnegative report amount`);
  }
  return parseUnits(text, 18);
}

export function amountDifference(left: bigint, right: bigint): bigint {
  return left > right ? left - right : right - left;
}
