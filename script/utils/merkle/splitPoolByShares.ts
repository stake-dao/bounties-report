const SHARE_SCALE = 10n ** 18n;

const scaleShare = (shareStr: string): bigint =>
  BigInt(Math.round(parseFloat(shareStr) * 1e18));

/**
 * Apply a fractional share (decimal string, 0..1) to a wei amount using
 * integer math. Floors, so the result never exceeds `total`.
 */
export function applyShare(total: bigint, shareStr: string): bigint {
  return (total * scaleShare(shareStr)) / SHARE_SCALE;
}

/**
 * Split a wei pool across addresses proportionally to their share strings.
 * Shares are normalized by their actual sum, so the distributed total is
 * guaranteed <= pool regardless of float noise in the stored shares
 * (the legacy `Math.floor(share * Number(pool))` could overshoot the pool,
 * leaving the merkle underfunded vs the withdraw plan).
 */
export function splitPoolByShares(
  pool: bigint,
  shares: { [address: string]: string }
): { [address: string]: bigint } {
  const scaled: { [address: string]: bigint } = {};
  let totalScaled = 0n;
  for (const [address, shareStr] of Object.entries(shares)) {
    const s = scaleShare(shareStr);
    scaled[address] = s;
    totalScaled += s;
  }
  const rewards: { [address: string]: bigint } = {};
  for (const [address, s] of Object.entries(scaled)) {
    rewards[address] = totalScaled > 0n ? (pool * s) / totalScaled : 0n;
  }
  return rewards;
}
