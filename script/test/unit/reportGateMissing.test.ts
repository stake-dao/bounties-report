import { describe, expect, it } from "vitest";
import { formatReportGateMessages, missingReportFiles } from "../../sdTkns/verify/reportGate";

describe("Report gate on an unpublished week", () => {
  it("names the missing report files instead of failing R2-R5 one by one", () => {
    // 2026-10-06: crv/fxn checks halted, the Tuesday gate ran without any report.
    expect(missingReportFiles(1790812800, ["curve", "fxn"])).toEqual([
      "curve.csv", "curve-attribution.json", "fxn.csv", "fxn-attribution.json",
    ]);
    expect(missingReportFiles(1790208000, ["curve", "fxn"])).toEqual([]);
  });

  it("prints a repeated warning once", async () => {
    const warning = "curve: 42161/0xaf88 is outside the Ethereum sd report";
    const [message] = await formatReportGateMessages(1790812800, ["curve"], [
      { id: "R2", name: "Claim amounts", ok: true, detail: "ok", warnings: [warning, warning] },
    ]);
    expect(message.split(warning).length - 1).toBe(1);
  });
});
