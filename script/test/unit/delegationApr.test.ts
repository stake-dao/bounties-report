import { describe, it, expect } from "vitest";
import { computeSdFxsDelegationAPR } from "../../utils/merkle/delegationApr";

describe("computeSdFxsDelegationAPR", () => {
  it("annualizes weekly delegation rewards with the x4 sdFXS multiplier", () => {
    // 100 weekly rewards over 10000 vp -> (100/10000)*52*100*4 = 208
    expect(computeSdFxsDelegationAPR(100, 10000)).toBeCloseTo(208, 10);
  });

  it("returns 0 when total voting power is zero or negative", () => {
    expect(computeSdFxsDelegationAPR(100, 0)).toBe(0);
    expect(computeSdFxsDelegationAPR(100, -5)).toBe(0);
  });

  it("returns 0 when there are no delegation rewards", () => {
    expect(computeSdFxsDelegationAPR(0, 10000)).toBe(0);
  });
});
