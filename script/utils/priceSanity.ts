/**
 * Price sanity gate for the Tuesday value-weighted forwarder split.
 *
 * The split only uses price RATIOS, so a single wrong price legally moves
 * money between forwarders while every conservation check (pot == on-chain
 * sCRVUSD, per-wallet wei-exactness, group totals) still passes. Two anchors
 * close that hole:
 *
 *   1. USD-pegged stables must price inside a hard band — unless BOTH
 *      sources agree the peg is genuinely off (a real depeg is correct data
 *      and must not brick the merkle).
 *   2. Every other token is cross-checked against an independent source;
 *      a large relative deviation fails, a missing cross price only warns
 *      (coverage gaps on exotic bribe tokens are expected).
 *
 * Pure validation lives here; createDelegatorsMerkle fetches and records the
 * full vector (primary + cross + deviations) in the split breakdown so the
 * decision is auditable after the fact.
 */

import axios from "axios";

/** Hard band for USD-pegged stables (primary source). */
export const STABLE_PRICE_BAND = { min: 0.95, max: 1.05 };
/** Relative deviation between sources above which the split must not run. */
export const CROSS_SOURCE_FAIL_DEVIATION = 0.5;
/** Relative deviation between sources that is only worth a loud warning. */
export const CROSS_SOURCE_WARN_DEVIATION = 0.2;

/**
 * Mainnet USD-pegged stables that flow through this pipeline. Curated: only
 * true pegged tokens — yield-bearing wrappers (sCRVUSD, sUSDe, sDAI…) drift
 * above $1 by design and must NOT be listed. An unlisted stable simply gets
 * the weaker cross-source check, so omissions are safe; additions go through
 * review like a waiver.
 */
export const KNOWN_STABLE_TOKENS: ReadonlySet<string> = new Set(
  [
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
    "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
    "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
    "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", // crvUSD
    "0x853d955acef822db058eb8505911ed77f175b99e", // FRAX (legacy)
    "0xcacd6fd266af91b8aed52accc382b4e165586e29", // frxUSD
    "0x865377367054516e17014ccded1e7d814edc9ce4", // DOLA
    "0x99d8a9c45b2eca8864373a26d1459e3dff1e17f3", // MIM
    "0x5f98805a4e8be255a32880fdec7f6728c6568ba0", // LUSD
    "0x6c3ea9036406852006290770bedfcaba0e23a0e8", // PYUSD
    "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", // USDe
    "0xdc035d45d973e3ec169d2276ddab16f1e407384f", // USDS
    "0x6440f144b7e50d6a8439336510312d2f54beb01d", // BOLD
  ].map((a) => a.toLowerCase())
);

export interface PriceSanityResult {
  /** Violations that must block the split (unless explicitly bypassed). */
  failures: string[];
  /** Suspicious but tolerable observations, logged and recorded. */
  warnings: string[];
  /** tokenLower -> |primary-cross|/max(primary,cross); null when no cross price. */
  deviations: Record<string, number | null>;
}

const relDeviation = (a: number, b: number): number =>
  Math.abs(a - b) / Math.max(a, b);

/**
 * Validates the primary price vector against the stable band and an
 * independent cross source. Pure — callers fetch, this decides.
 */
export const validatePriceVector = (input: {
  /** tokenLower -> primary USD price (the vector the split will use). */
  pricesUsd: Record<string, number>;
  /** tokenLower -> independent second-source USD price (may be sparse). */
  crossPricesUsd: Record<string, number>;
  stables?: ReadonlySet<string>;
}): PriceSanityResult => {
  const stables = input.stables ?? KNOWN_STABLE_TOKENS;
  const failures: string[] = [];
  const warnings: string[] = [];
  const deviations: Record<string, number | null> = {};

  for (const [token, price] of Object.entries(input.pricesUsd)) {
    const t = token.toLowerCase();
    if (!Number.isFinite(price) || price <= 0) {
      // computeValueWeights already hard-fails on non-positive prices; this
      // guard keeps the sanity report coherent if ordering ever changes.
      failures.push(`${t}: non-positive primary price ${price}`);
      deviations[t] = null;
      continue;
    }
    const cross = input.crossPricesUsd[t];
    const deviation =
      Number.isFinite(cross) && (cross as number) > 0
        ? relDeviation(price, cross as number)
        : null;
    deviations[t] = deviation;

    if (stables.has(t)) {
      const inBand =
        price >= STABLE_PRICE_BAND.min && price <= STABLE_PRICE_BAND.max;
      if (!inBand) {
        if (deviation !== null && deviation <= CROSS_SOURCE_WARN_DEVIATION) {
          warnings.push(
            `${t}: stable priced at $${price} outside [${STABLE_PRICE_BAND.min}, ` +
              `${STABLE_PRICE_BAND.max}] but both sources agree — treating as a real depeg`
          );
        } else {
          failures.push(
            `${t}: stable priced at $${price} outside [${STABLE_PRICE_BAND.min}, ` +
              `${STABLE_PRICE_BAND.max}] and the cross source ${
                deviation === null
                  ? "has no price"
                  : `disagrees (deviation ${(deviation * 100).toFixed(1)}%)`
              } — refusing to split on a suspect stable price`
          );
        }
        continue;
      }
      if (deviation !== null && deviation > CROSS_SOURCE_FAIL_DEVIATION) {
        // Primary is anchored by the band; a wildly-off cross price is almost
        // certainly bad cross data, not a bad split input.
        warnings.push(
          `${t}: stable in band at $${price} but cross source says $${cross} ` +
            `(deviation ${(deviation * 100).toFixed(1)}%) — cross data looks wrong`
        );
      }
      continue;
    }

    if (deviation === null) {
      warnings.push(
        `${t}: no cross-source price — split relies on the primary source alone ($${price})`
      );
    } else if (deviation > CROSS_SOURCE_FAIL_DEVIATION) {
      failures.push(
        `${t}: sources disagree by ${(deviation * 100).toFixed(1)}% ` +
          `(primary $${price} vs cross $${cross}) — refusing to split on a disputed price`
      );
    } else if (deviation > CROSS_SOURCE_WARN_DEVIATION) {
      warnings.push(
        `${t}: sources deviate by ${(deviation * 100).toFixed(1)}% ` +
          `(primary $${price} vs cross $${cross})`
      );
    }
  }

  return { failures, warnings, deviations };
};

const GECKO_TERMINAL_CHUNK = 30;

/**
 * Independent second-source prices from GeckoTerminal (mainnet). Distinct
 * from the DefiLlama primary in getTokenPrices; a total outage returns {}
 * and the caller decides (missing cross prices warn, they do not fail).
 * NOTE: getTokenPrices also falls back to GeckoTerminal for tokens DefiLlama
 * misses — for those tokens this cross-check degenerates to self-comparison,
 * which the stable band still guards.
 */
export const fetchGeckoTerminalPrices = async (
  tokensLower: string[]
): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (let i = 0; i < tokensLower.length; i += GECKO_TERMINAL_CHUNK) {
    const chunk = tokensLower.slice(i, i + GECKO_TERMINAL_CHUNK);
    try {
      const url =
        `https://api.geckoterminal.com/api/v2/simple/networks/eth/token_price/` +
        chunk.map((a) => encodeURIComponent(a)).join(",");
      const resp = await axios.get<any>(url);
      const data = resp.data?.data?.attributes?.token_prices ?? {};
      for (const [address, price] of Object.entries(data)) {
        const parsed = Number(price);
        if (Number.isFinite(parsed) && parsed > 0) {
          out[address.toLowerCase()] = parsed;
        }
      }
    } catch (error) {
      console.warn(
        `fetchGeckoTerminalPrices: chunk of ${chunk.length} failed — ` +
          `${(error as Error).message}`
      );
    }
  }
  return out;
};
