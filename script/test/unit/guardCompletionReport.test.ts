import { describe, expect, it } from "vitest";
import { provenEvents, settledOutsideReport } from "../../reports/guardCompletion";

const proof = {
  transactions: [{ hash: "0xaa" }],
  remaining: { "0xcarry": "5" },
  purged: { "0xalcx": "1408656511288191329" },
} as any;

describe("Guarded weekly report vs completion proof", () => {
  it("reads only the proof's transactions", () => {
    // 2026-10-06 curve: the OTC sdCRV delivery and the vlCVX CRV withdraw also
    // went through AllMight V2 and broke the funding/delivery totals.
    const events = [{ transactionHash: "0xAA" }, { transactionHash: "0x5d02" }, { transactionHash: "0x0ed3" }] as any[];
    expect(provenEvents(proof, events)).toEqual([{ transactionHash: "0xAA" }]);
  });

  it("treats a purged claim like a carried one", () => {
    // 2026-10-06 fxn: the purged ALCX was required in the report.
    expect(settledOutsideReport(proof, "0xalcx", "1408656511288191329")).toBe(true);
    expect(settledOutsideReport(proof, "0xcarry", "5")).toBe(true);
    expect(settledOutsideReport(proof, "0xcarry", "6")).toBe(false);
    expect(settledOutsideReport(proof, "0xother", "1")).toBe(false);
  });
});
