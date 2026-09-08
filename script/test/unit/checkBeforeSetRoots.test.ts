import { describe, expect, it } from "vitest";
import {
  findClaimAwareContinuityViolations,
  nonzeroReportedSymbols,
} from "../../sdTkns/verify/checkBeforeSetRoots";

const HOLDER = "0x66bb7c182672a4b4a1c5891b9fd708b241ef3622";
const PREVIOUS_SDCRV = 618_045_487_474_645_028_669n;
const CURRENT_SDCRV = 40_182_198_944_401_257_279n;

describe("claim-aware V3 continuity", () => {
  it("passes when claims cover a decreased unclaimed balance", () => {
    const violations = findClaimAwareContinuityViolations(
      new Map([[HOLDER, PREVIOUS_SDCRV]]),
      new Map([[HOLDER, CURRENT_SDCRV]]),
      new Map([[HOLDER, PREVIOUS_SDCRV]]),
    );

    expect(violations).toEqual([]);
  });

  it("fails when claims do not cover a decreased unclaimed balance", () => {
    const violations = findClaimAwareContinuityViolations(
      new Map([[HOLDER, 100n]]),
      new Map([[HOLDER, 40n]]),
      new Map([[HOLDER, 59n]]),
    );

    expect(violations).toEqual([
      {
        holder: HOLDER,
        previous: 100n,
        current: 40n,
        claimedSince: 59n,
      },
    ]);
  });

  it("passes when a disappeared holder fully claimed the previous amount", () => {
    const violations = findClaimAwareContinuityViolations(
      new Map([[HOLDER, 100n]]),
      new Map(),
      new Map([[HOLDER, 100n]]),
    );

    expect(violations).toEqual([]);
  });
});

describe("V8 TotalReported scope", () => {
  it("ignores folded RawToken_ entries", () => {
    expect(
      nonzeroReportedSymbols({
        sdCRV: 100,
        sdFXN: 0,
        RawToken_curve_CRV: 25,
      }),
    ).toEqual(["sdCRV"]);
  });
});
