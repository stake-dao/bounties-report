/**
 * Unit tests for the pure expansion math in sdbalSunsetDistribution.ts:
 * proRataSplit (wrapper holder splits) and assignDust (uint reconciliation).
 * These drive every recursive contract expansion of the sdBAL sunset
 * distribution — totals must reconcile exactly at each level.
 */
import { describe, it, expect } from "vitest";
import { proRataSplit, assignDust } from "../../special-distribs/sdbalSunsetDistribution";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";

describe("proRataSplit", () => {
  it("splits proportionally and never over-assigns", () => {
    const { shares, assigned } = proRataSplit(
      [[A, 600n], [B, 300n], [C, 100n]],
      1_000_000n,
      1000n,
    );
    expect(shares).toEqual([[A, 600_000n], [B, 300_000n], [C, 100_000n]]);
    expect(assigned).toBe(1_000_000n);
  });

  it("drops zero shares and reports the shortfall via assigned", () => {
    // C's 1 wei of a huge supply rounds to 0 — must not appear with a 0 entry.
    const { shares, assigned } = proRataSplit(
      [[A, 10n ** 18n], [C, 1n]],
      100n,
      10n ** 18n + 1n,
    );
    expect(shares.map(([a]) => a)).toEqual([A]);
    expect(assigned).toBeLessThan(100n);
  });

  it("handles denominator larger than holder sum (Balancer MINIMUM_BPT at addr(0))", () => {
    // totalSupply includes 1e6 wei locked at address(0) that is not in holders.
    const totalSupply = 1_000_000_000_001_000_000n;
    const { shares, assigned } = proRataSplit(
      [[A, 1_000_000_000_000_000_000n]],
      506272155103516794n,
      totalSupply,
    );
    expect(shares).toHaveLength(1);
    expect(assigned).toBeLessThan(506272155103516794n);
    // shortfall is the locked share, recovered exactly by assignDust
    const beneficiaries = { [A]: shares[0][1].toString() };
    assignDust(beneficiaries, 506272155103516794n - assigned);
    expect(BigInt(beneficiaries[A])).toBe(506272155103516794n);
  });

  it("preserves value exactly across split + dust for adversarial amounts", () => {
    const holders: [string, bigint][] = [
      [A, 333333333333333333n],
      [B, 333333333333333334n],
      [C, 1n],
    ];
    const denominator = holders.reduce((s, [, b]) => s + b, 0n);
    const value = 999999999999999999n;
    const { shares, assigned } = proRataSplit(holders, value, denominator);
    const beneficiaries: Record<string, string> = {};
    for (const [a, v] of shares) beneficiaries[a] = v.toString();
    assignDust(beneficiaries, value - assigned);
    const total = Object.values(beneficiaries).reduce((s, v) => s + BigInt(v), 0n);
    expect(total).toBe(value);
  });
});

describe("assignDust", () => {
  it("adds dust to the largest beneficiary", () => {
    const beneficiaries = { [A]: "100", [B]: "300", [C]: "200" };
    assignDust(beneficiaries, 7n);
    expect(beneficiaries[B]).toBe("307");
    expect(beneficiaries[A]).toBe("100");
  });

  it("is a no-op for zero or negative dust", () => {
    const beneficiaries = { [A]: "100" };
    assignDust(beneficiaries, 0n);
    expect(beneficiaries[A]).toBe("100");
  });
});
