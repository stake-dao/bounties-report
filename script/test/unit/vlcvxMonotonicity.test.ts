import { describe, expect, it } from "vitest";
import { checkMonotonicity, droppedLeaves } from "../../vlCVX/verify/reconstructDistribution";

const leaf = (w: string, t: string) => `${w}|${t}`;
const RECOVERED = leaf("0xa", "0xcvx");
const STALE = leaf("0xb", "0xcrvusd");
const OPEN = leaf("0xc", "0xcrv");
const KEPT = leaf("0xd", "0xcrv");

describe("vlCVX voters monotonicity", () => {
  // Week 1793836800 dropped 3,048 recovered zero-amount leaves and one stale
  // leaf claimed above its amount; a leaf with an open balance must still fail.
  const prev = new Map([[RECOVERED, 0n], [STALE, 6n], [OPEN, 5n], [KEPT, 7n]]);
  const cur = new Map([[KEPT, 9n]]);

  it("lists only leaves missing from the new merkle", () => {
    expect(droppedLeaves(prev, cur).sort()).toEqual([OPEN, RECOVERED, STALE].sort());
  });

  it("accepts drops with nothing left to claim and rejects drops with an open balance", () => {
    // Recovered zero-amount leaf: claimed 0 >= 0. Stale leaf: claimed 9 >= 6. Open leaf: claimed 4 < 5.
    const claimed = new Map([[STALE, 9n], [OPEN, 4n]]);
    expect(checkMonotonicity(prev, cur, claimed)).toEqual({ shrunk: 0, pruned: 2, dropped: 1 });
  });

  it("accepts a drop claimed exactly to its amount", () => {
    const claimed = new Map([[STALE, 9n], [OPEN, 5n]]);
    expect(checkMonotonicity(prev, cur, claimed)).toEqual({ shrunk: 0, pruned: 3, dropped: 0 });
  });

  it("still counts a shrunk leaf", () => {
    expect(checkMonotonicity(new Map([[KEPT, 10n]]), cur, new Map())).toEqual({ shrunk: 1, pruned: 0, dropped: 0 });
  });
});
