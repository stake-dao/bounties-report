import { describe, expect, it } from "vitest";
import {
  rateFailures,
  runR1,
  runR2,
  runR5,
  wethResidual,
  withinVolumeBand,
} from "../../sdTkns/verify/reportGate";

const PERIOD = 1787184000;

describe("Run 8 report gate", () => {
  it("applies the ±50% trailing-volume band", () => {
    expect(withinVolumeBand(100n, [90n, 100n, 100n, 110n])).toBe(true);
    expect(withinVolumeBand(49n, [100n, 100n, 100n, 100n])).toBe(false);
    expect(withinVolumeBand(0n, [0n, 0n, 0n, 0n])).toBe(true);
    expect(withinVolumeBand(0n, [100n, 100n, 100n, 100n])).toBe(false);
  });

  it("flags the genuine R1 source gaps in the real 1787184000 fixture", () => {
    const result = runR1(PERIOD, ["curve", "fxn"]);
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain("curve/votemarket_v1: collapsed/outlier volume");
    expect(result.detail).toContain("fxn/votemarket_v2: collapsed/outlier volume");
  });

  it("uses root-gauge provenance and the recorded dropped-token justifications", () => {
    expect(runR2(PERIOD, ["curve"]).ok).toBe(true);
    const fxn = runR2(PERIOD, ["fxn"]);
    expect(fxn.ok).toBe(true);
  });

  it("resolves a root gauge absent from the current cvx.csv through the trailing weeks", () => {
    // 1788393600: base-WETH+superOETHb has a VoteMarket claim on its root gauge but no
    // Convex-side claim, so the current cvx.csv has no row to map root -> child.
    const curve = runR2(1788393600, ["curve"]);
    expect(curve.detail).not.toContain("0x92106dcfa053a8283213a062735649cbf0e718a2");
    expect(curve.ok).toBe(true);
  });

  it("checks each WETH batch against the peg-aware reference", () => {
    const attribution = {
      totals: { sdInTotal: 100, sdAssigned: 100, wethInTotal: 1, wethOutTotal: 1 },
      txs: [
        { tx: "0xpass", wethIn: 1, sdIn: 100, nativeOut: 100 },
        { tx: "0xfail", wethIn: 1, sdIn: 80, nativeOut: 100 },
        { tx: "0xdirect", wethIn: 0, sdIn: 10, nativeOut: 10 },
      ],
    };
    expect(rateFailures(attribution, 1, 0.05)).toEqual([
      "0xfail effective=80 reference=100",
    ]);
  });

  it("reconciles cleanup residuals and passes the real ENG-1951 ledger", () => {
    expect(
      wethResidual({
        totals: { sdInTotal: 0, sdAssigned: 0, wethInTotal: 1.1, wethOutTotal: 1 },
        cleanupTransactions: [{ residualWethConsumed: { token: 0.1 } }],
      }),
    ).toBeCloseTo(0, 12);
    expect(runR5(PERIOD, ["curve", "fxn"], 3_000).ok).toBe(true);
  });
});
