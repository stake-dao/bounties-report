/**
 * Unit tests for the value-weighted forwarder split of the Tuesday sCRVUSD
 * distribution (pure math): entitlement merging, pico-USD value weights, and the
 * missing-price guards.
 */
import { describe, it, expect } from "vitest";
import {
  computeValueWeights,
  mergeEntitlements,
  usdToPico,
} from "../../vlCVX/3_merkles/forwarderProceedsSplit";
import { splitAmountByWeights } from "../../vlCVX/2_repartition/delegators";

const CRV = "0xd533a949740bb3306d119cc777fa900ba034cd52";
const USG = "0xb1c2db5d6ca03fce73dbd304d320bf76c55ae1b1";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ONE = 10n ** 18n;

describe("usdToPico", () => {
  it("converts via decimal string, keeping tiny and huge prices exact", () => {
    expect(usdToPico(1, "t")).toBe(10n ** 12n);
    expect(usdToPico(0.5123456789, "t")).toBe(512_345_678_900n);
    expect(usdToPico(0, "t")).toBe(0n);
    // sub-micro-dollar token keeps its significant digits
    expect(usdToPico(0.0000008, "t")).toBe(800_000n);
    // large price stays exact without float-multiply overflow
    expect(usdToPico(100_000, "t")).toBe(100_000n * 10n ** 12n);
  });
  it("rejects invalid prices", () => {
    expect(() => usdToPico(-1, "t")).toThrow("invalid USD price");
    expect(() => usdToPico(Number.NaN, "t")).toThrow("invalid USD price");
  });
});

describe("mergeEntitlements", () => {
  it("sums wallet/token amounts across platforms", () => {
    const merged = mergeEntitlements(
      { [A]: { [CRV]: 5n } },
      { [A]: { [CRV]: 2n, [USG]: 1n }, [B]: { [USG]: 4n } }
    );
    expect(merged[A][CRV]).toBe(7n);
    expect(merged[A][USG]).toBe(1n);
    expect(merged[B][USG]).toBe(4n);
  });
});

describe("computeValueWeights", () => {
  it("values entitlements in pico-USD across mixed decimals", () => {
    const weights = computeValueWeights(
      {
        // A: 100 CRV at $0.50 = $50; B: 25 USDC at $1 = $25
        [A]: { [CRV]: 100n * ONE },
        [B]: { [USDC]: 25n * 10n ** 6n },
      },
      { [CRV]: 500_000_000_000n, [USDC]: 1_000_000_000_000n },
      { [CRV]: 18, [USDC]: 6 }
    );
    expect(weights[A]).toBe(50_000_000_000_000n); // $50 in pico-USD
    expect(weights[B]).toBe(25_000_000_000_000n); // $25 in pico-USD
  });

  it("a wallet only weighs the tokens its delegate earned (no cross-subsidy)", () => {
    // B is entitled only to USG — its weight must not move with CRV price.
    const mk = (crvPrice: bigint) =>
      computeValueWeights(
        { [A]: { [CRV]: 10n * ONE }, [B]: { [USG]: 10n * ONE } },
        { [CRV]: crvPrice, [USG]: 10n ** 12n },
        { [CRV]: 18, [USG]: 18 }
      );
    expect(mk(10n ** 12n)[B]).toBe(mk(9n * 10n ** 12n)[B]);
    expect(mk(9n * 10n ** 12n)[A]).toBe(9n * mk(10n ** 12n)[A]);
  });

  it("throws on a missing or zero price for a held token", () => {
    expect(() =>
      computeValueWeights(
        { [A]: { [CRV]: 1n } },
        { [USG]: 10n ** 12n },
        { [CRV]: 18 }
      )
    ).toThrow("no usable price");
    expect(() =>
      computeValueWeights({ [A]: { [CRV]: 1n } }, { [CRV]: 0n }, { [CRV]: 18 })
    ).toThrow("no usable price");
  });

  it("throws on missing decimals", () => {
    expect(() =>
      computeValueWeights({ [A]: { [CRV]: 1n } }, { [CRV]: 1n }, {})
    ).toThrow("decimals");
  });

  it("end-to-end: pool split follows value, conserving to the wei", () => {
    const weights = computeValueWeights(
      {
        [A]: { [CRV]: 300n * ONE }, // $150
        [B]: { [USDC]: 50n * 10n ** 6n }, // $50
      },
      { [CRV]: 500_000_000_000n, [USDC]: 1_000_000_000_000n },
      { [CRV]: 18, [USDC]: 6 }
    );
    const pool = 1_000_000_000_000_000_001n; // awkward wei total
    const split = splitAmountByWeights(pool, weights);
    expect(split[A] + split[B]).toBe(pool);
    // 3:1 value ratio
    expect(Number(split[A]) / Number(split[B])).toBeCloseTo(3, 9);
  });
});
