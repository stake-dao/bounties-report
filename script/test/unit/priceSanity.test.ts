/**
 * Unit tests for the price sanity gate of the Tuesday value-weighted split:
 * stable band semantics (a real depeg both sources agree on must pass, a
 * suspect one must fail), cross-source deviation thresholds, and the curated
 * stables list shape.
 */
import { describe, expect, it } from "vitest";
import {
  KNOWN_STABLE_TOKENS,
  validatePriceVector,
} from "../../utils/priceSanity";

const STABLE = "0xaaaa000000000000000000000000000000000001";
const TOKEN = "0xbbbb000000000000000000000000000000000002";
const STABLES = new Set([STABLE]);

describe("validatePriceVector", () => {
  it("passes a stable in band and a token with agreeing sources", () => {
    const result = validatePriceVector({
      pricesUsd: { [STABLE]: 0.999, [TOKEN]: 12.9 },
      crossPricesUsd: { [STABLE]: 1.001, [TOKEN]: 13.2 },
      stables: STABLES,
    });
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.deviations[TOKEN]).toBeGreaterThan(0);
  });

  it("only warns on a genuine depeg both sources agree on", () => {
    const result = validatePriceVector({
      pricesUsd: { [STABLE]: 0.9 },
      crossPricesUsd: { [STABLE]: 0.91 },
      stables: STABLES,
    });
    expect(result.failures).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/real depeg/);
  });

  it("fails a stable out of band with no cross price", () => {
    const result = validatePriceVector({
      pricesUsd: { [STABLE]: 0.5 },
      crossPricesUsd: {},
      stables: STABLES,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/suspect stable price/);
    expect(result.deviations[STABLE]).toBeNull();
  });

  it("fails a stable out of band when the cross source disagrees", () => {
    const result = validatePriceVector({
      pricesUsd: { [STABLE]: 0.5 },
      crossPricesUsd: { [STABLE]: 1.0 },
      stables: STABLES,
    });
    expect(result.failures).toHaveLength(1);
  });

  it("warns (not fails) when a stable is in band but the cross price is wild", () => {
    const result = validatePriceVector({
      pricesUsd: { [STABLE]: 1.0 },
      crossPricesUsd: { [STABLE]: 3.0 },
      stables: STABLES,
    });
    expect(result.failures).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/cross data looks wrong/);
  });

  it("fails a non-stable when sources disagree beyond the fail threshold", () => {
    const result = validatePriceVector({
      pricesUsd: { [TOKEN]: 10 },
      crossPricesUsd: { [TOKEN]: 1 },
      stables: STABLES,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/disputed price/);
  });

  it("warns on moderate deviation and on missing cross prices", () => {
    const deviating = validatePriceVector({
      pricesUsd: { [TOKEN]: 10 },
      crossPricesUsd: { [TOKEN]: 7 },
      stables: STABLES,
    });
    expect(deviating.failures).toEqual([]);
    expect(deviating.warnings).toHaveLength(1);

    const missing = validatePriceVector({
      pricesUsd: { [TOKEN]: 10 },
      crossPricesUsd: {},
      stables: STABLES,
    });
    expect(missing.failures).toEqual([]);
    expect(missing.warnings).toHaveLength(1);
    expect(missing.warnings[0]).toMatch(/no cross-source price/);
  });

  it("fails a non-positive primary price", () => {
    const result = validatePriceVector({
      pricesUsd: { [TOKEN]: 0 },
      crossPricesUsd: {},
      stables: STABLES,
    });
    expect(result.failures).toHaveLength(1);
  });
});

describe("KNOWN_STABLE_TOKENS", () => {
  it("contains true pegged stables and excludes yield-bearing wrappers", () => {
    // USDC
    expect(
      KNOWN_STABLE_TOKENS.has("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")
    ).toBe(true);
    // sCRVUSD accrues above $1 by design — listing it would brick the merkle.
    expect(
      KNOWN_STABLE_TOKENS.has("0x0655977feb2f289a4ab78af67bab0d17aab84367")
    ).toBe(false);
    for (const token of KNOWN_STABLE_TOKENS) {
      expect(token).toMatch(/^0x[0-9a-f]{40}$/);
    }
  });
});
