import { describe, expect, it } from "vitest";
import { runR1, runR2, runR4, runR5, wethResidual, withinVolumeBand } from "../../sdTkns/verify/reportGate";

const client = { readContract: async ({ address }: any) => new Set([
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7",
  "0x501ebf66d76a96d4fb26ccead42957653e16b8b8",
]).has(address.toLowerCase()) ? 6 : 18 } as any;

describe("Report gate historical regressions", () => {
  it("compares each token with its own trailing median", () => {
    expect(withinVolumeBand(100n, [90n, 100n, 100n, 110n])).toBe(true);
    expect(withinVolumeBand(49n, [100n, 100n, 100n, 100n])).toBe(false);
    expect(withinVolumeBand(0n, [0n, 0n, 0n, 0n])).toBe(true);
    expect(withinVolumeBand(0n, [100n, 100n, 100n, 100n])).toBe(false);
    expect(runR1(1788998400, ["curve", "fxn"]).ok).toBe(true);
    const historical = runR1(1787184000, ["curve", "fxn"]);
    expect(historical.ok).toBe(true);
    expect(historical.warnings?.some((warning) => warning.startsWith("fxn/"))).toBe(true);
  });

  it("resolves a root gauge absent from the current cvx.csv through the trailing weeks", async () => {
    const curve = await runR2(1788393600, ["curve"], client);
    expect(curve.detail).not.toContain("0x92106dcfa053a8283213a062735649cbf0e718a2");
    expect(curve.ok, curve.detail).toBe(true);
  });

  it.each([1788998400, 1788393600, 1787788800, 1787184000])("reconciles historical allocation weights for %s", (period) => {
    const result = runR4(period, ["curve", "fxn"]);
    expect(result.ok, result.detail).toBe(true);
  });

  it("preserves signed WETH residuals", async () => {
    expect(wethResidual({
      totals: { sdInTotal: 0, sdAssigned: 0, wethInTotal: 1.1, wethOutTotal: 1 },
      cleanupTransactions: [{ residualWethConsumed: { token: 0.1 } }],
    })).toBeCloseTo(0, 12);
    expect((await runR5(1787184000, ["curve", "fxn"], 3_000)).ok).toBe(true);
  });

  it("uses actual cleanup WETH transfers, not the legacy native-token basis label", async () => {
    const rpc = { getTransactionReceipt: async () => ({ status: "success", logs: [] }) } as any;
    const result = await runR5(1787788800, ["fxn"], 3_000, rpc);
    expect(result.ok, result.detail).toBe(true);
  });
});
