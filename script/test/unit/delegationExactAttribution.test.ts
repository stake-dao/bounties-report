/**
 * Unit tests for the exact delegation attribution:
 * - splitAmountByWeights: wei conservation, largest-remainder determinism;
 * - buildDelegationSummary: per-delegate sections, exact group totals,
 *   conservation guards;
 * - delegationExact reader: flattening + tamper detection.
 *
 * Pure math — no on-chain reads.
 */
import { describe, it, expect } from "vitest";
import {
  splitAmountByWeights,
  buildDelegationSummary,
  type DelegationDistribution,
  type PerDelegateExact,
} from "../../vlCVX/2_repartition/delegators";
import {
  hasPerDelegateAttribution,
  getExactGroupAmounts,
  getExactGroupTokenTotals,
} from "../../utils/delegationExact";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
// Stake DAO's on-chain delegate: its forwarders route to the pooled Tuesday
// group. DELEGATE_2 is a third-party delegate: its forwarders route raw.
const DELEGATE_1 = "0xbb06fefb8f23a7c60c93fe20464db6687c51955f";
const DELEGATE_2 = "0x2000000000000000000000000000000000000002";
const CRV = "0xd533a949740bb3306d119cc777fa900ba034cd52";
const USG = "0xb1c2db5d6ca03fce73dbd304d320bf76c55ae1b1";
const ONE = 10n ** 18n;

describe("splitAmountByWeights", () => {
  it("conserves the amount to the wei for awkward ratios", () => {
    const split = splitAmountByWeights(1000n, { [A]: 1n, [B]: 1n, [C]: 1n });
    expect(split[A] + split[B] + split[C]).toBe(1000n);
    // 333 each + 1 leftover wei; equal remainders → lowest address first.
    expect(split[A]).toBe(334n);
    expect(split[B]).toBe(333n);
    expect(split[C]).toBe(333n);
  });

  it("is deterministic across calls", () => {
    const weights = { [C]: 7n, [A]: 13n, [B]: 11n };
    const s1 = splitAmountByWeights(999999999n, weights);
    const s2 = splitAmountByWeights(999999999n, weights);
    expect(s1).toEqual(s2);
  });

  it("excludes zero weights and handles a zero amount", () => {
    const split = splitAmountByWeights(100n, { [A]: 5n, [B]: 0n });
    expect(split[A]).toBe(100n);
    expect(split[B]).toBeUndefined();
    expect(splitAmountByWeights(0n, { [A]: 5n })[A]).toBe(0n);
  });

  it("throws when an amount has no beneficiary", () => {
    expect(() => splitAmountByWeights(100n, { [A]: 0n })).toThrow("no beneficiary");
    expect(() => splitAmountByWeights(100n, {})).toThrow("no beneficiary");
  });

  it("conserves large 18-decimal pools", () => {
    const weights = {
      [A]: 2_199_089n * ONE,
      [B]: 8_969_342n * ONE,
      [C]: 547_675n * ONE,
    };
    const pool = 10_858_775_164_268_335_622_774n; // this week's CRV pot
    const split = splitAmountByWeights(pool, weights);
    expect(split[A] + split[B] + split[C]).toBe(pool);
  });
});

const buildInputs = (): {
  merged: DelegationDistribution;
  perDelegate: PerDelegateExact[];
} => {
  // Delegate 1 (Stake DAO, pooled): pool 1000 CRV, A (forwarder) 667 / B 333.
  // Delegate 2 (third-party): pool 500 CRV + 90 USG, C (forwarder) only —
  // C's amounts must route RAW despite the forwarder flag.
  const perDelegate: PerDelegateExact[] = [
    {
      delegate: DELEGATE_1,
      poolTokens: { [CRV]: 1000n },
      exactByDelegator: {
        [A]: { [CRV]: 667n },
        [B]: { [CRV]: 333n },
      },
      forwarderFlags: { [A]: true, [B]: false },
    },
    {
      delegate: DELEGATE_2,
      poolTokens: { [CRV]: 500n, [USG]: 90n },
      exactByDelegator: {
        [C]: { [CRV]: 500n, [USG]: 90n },
      },
      forwarderFlags: { [C]: true },
    },
  ];
  const merged: DelegationDistribution = {
    [A]: { share: "0.4", shareForwarders: "0.4", shareNonForwarders: "0" },
    [B]: { share: "0.2", shareForwarders: "0", shareNonForwarders: "0.2" },
    [C]: { share: "0.4", shareForwarders: "0.4", shareNonForwarders: "0" },
    // merged pot entry (delegation address) — totals must match pools
    "0xdddddddddddddddddddddddddddddddddddddddd": {
      tokens: { [CRV]: 1500n, [USG]: 90n },
    },
  };
  return { merged, perDelegate };
};

describe("buildDelegationSummary", () => {
  it("emits exact per-delegate sections and ROUTED group totals", () => {
    const { merged, perDelegate } = buildInputs();
    const summary = buildDelegationSummary(merged, perDelegate);

    // Sections keep the registry facts: C IS a forwarder of delegate 2.
    expect(summary.perDelegate[DELEGATE_1].forwarders[A][CRV]).toBe("667");
    expect(summary.perDelegate[DELEGATE_1].nonForwarders[B][CRV]).toBe("333");
    expect(summary.perDelegate[DELEGATE_2].forwarders[C][USG]).toBe("90");

    // totalPerGroup carries payment routes: only the Stake DAO delegate's
    // forwarder (A) is pooled; C's forwarder amounts route raw.
    expect(summary.totalPerGroup[CRV].forwarders).toBe("667");
    expect(summary.totalPerGroup[CRV].nonForwarders).toBe("833");
    expect(summary.totalPerGroup[USG].forwarders).toBe("0");
    expect(summary.totalPerGroup[USG].nonForwarders).toBe("90");

    // Scalar membership fields survive for the verifiers (registry facts).
    expect(Object.keys(summary.forwarders).sort()).toEqual([A, C].sort());
    expect(Object.keys(summary.nonForwarders)).toEqual([B]);
  });

  it("throws when a delegator is attributed to two delegates", () => {
    const { merged, perDelegate } = buildInputs();
    perDelegate[1].exactByDelegator[A] = { [CRV]: 1n };
    perDelegate[1].forwarderFlags[A] = true;
    perDelegate[1].poolTokens = { [CRV]: 501n, [USG]: 90n };
    (merged["0xdddddddddddddddddddddddddddddddddddddddd"] as any).tokens[CRV] = 1501n;
    expect(() => buildDelegationSummary(merged, perDelegate)).toThrow(
      "two delegates"
    );
  });

  it("throws when a delegate's attribution does not conserve its pool", () => {
    const { merged, perDelegate } = buildInputs();
    perDelegate[0].exactByDelegator[B] = { [CRV]: 332n }; // 667+332 != 1000
    expect(() => buildDelegationSummary(merged, perDelegate)).toThrow(
      "must conserve to the wei"
    );
  });

  it("throws when the merged pot disagrees with the delegate pools", () => {
    const { merged, perDelegate } = buildInputs();
    (merged["0xdddddddddddddddddddddddddddddddddddddddd"] as any).tokens[CRV] = 1501n;
    expect(() => buildDelegationSummary(merged, perDelegate)).toThrow(
      "merged pot"
    );
  });
});

describe("delegationExact reader", () => {
  const summaryJson = () => {
    const { merged, perDelegate } = buildInputs();
    // Round-trip through JSON like the real file
    return JSON.parse(
      JSON.stringify(buildDelegationSummary(merged, perDelegate))
    );
  };

  it("detects the attribution and flattens routed groups across delegates", () => {
    const s = summaryJson();
    expect(hasPerDelegateAttribution(s)).toBe(true);

    // Raw route: B (non-forwarder) plus C (forwarder of a NON-pooled
    // delegate — rerouted here even though it forwards).
    const raw = getExactGroupAmounts(s, "nonForwarders");
    expect(raw[B][CRV]).toBe(333n);
    expect(raw[C][CRV]).toBe(500n);
    expect(raw[C][USG]).toBe(90n);
    expect(raw[A]).toBeUndefined();

    const totals = getExactGroupTokenTotals(s, "nonForwarders");
    expect(totals[CRV]).toBe(833n);
    expect(totals[USG]).toBe(90n);
  });

  it("pools only the Stake DAO delegate's forwarders into the Tuesday group", () => {
    const s = summaryJson();
    const pooled = getExactGroupAmounts(s, "forwarders");
    expect(pooled[A][CRV]).toBe(667n);
    expect(pooled[C]).toBeUndefined();
    expect(Object.keys(pooled)).toEqual([A]);
  });

  it("rejects summaries without per-delegate attribution", () => {
    expect(hasPerDelegateAttribution({ totalTokens: {} })).toBe(false);
    expect(() =>
      getExactGroupAmounts({ totalTokens: {} }, "forwarders")
    ).toThrow("pre-cutover");
  });

  it("throws when per-wallet amounts no longer match totalPerGroup", () => {
    const s = summaryJson();
    s.perDelegate[DELEGATE_1].nonForwarders[B][CRV] = "1333"; // tampered
    expect(() => getExactGroupAmounts(s, "nonForwarders")).toThrow(
      "inconsistent file"
    );
  });

  it("rejects offsetting errors across delegates even when aggregates still match", () => {
    const s = summaryJson();
    // Move 100 CRV of attribution from delegate 2's wallet to delegate 1's:
    // both legs route raw, so the aggregate raw totals stay identical, but
    // each delegate's section no longer conserves its own pool.
    s.perDelegate[DELEGATE_1].nonForwarders[B][CRV] = "433"; // 333 + 100
    s.perDelegate[DELEGATE_2].forwarders[C][CRV] = "400"; // 500 - 100
    expect(() => getExactGroupAmounts(s, "nonForwarders")).toThrow(
      "inconsistent file"
    );
  });
});
