/**
 * Unit tests for the raw Votium payouts consumed by the Thursday combined
 * merkle: claimed-cap validation, the per-wallet USD floor, and per-token
 * totals (the ops withdrawal amounts). Pure math — no I/O.
 */
import { describe, it, expect } from "vitest";
import {
  computeVotiumRawPayouts,
  hasClaimedVotiumBounties,
} from "../../utils/votiumRawPayouts";

const A = "0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const B = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const YB = "0x01791f726b4103694969820be083196cc7c045ff";
const WFRAX = "0x04acaf8d2865c0714f79da09645c13fd2888977f";

const claims = (amounts: Record<string, string>) => ({
  curve: Object.fromEntries(
    Object.entries(amounts).map(([token, amount], index) => [
      String(index),
      { rewardToken: token, amount },
    ])
  ),
});

describe("hasClaimedVotiumBounties", () => {
  it("detects positive claims and rejects malformed data", () => {
    expect(hasClaimedVotiumBounties(claims({ [YB]: "100" }))).toBe(true);
    expect(hasClaimedVotiumBounties(claims({ [YB]: "0" }))).toBe(false);
    expect(hasClaimedVotiumBounties({ curve: {} })).toBe(false);
    expect(() => hasClaimedVotiumBounties(null)).toThrow();
    expect(() =>
      hasClaimedVotiumBounties({ curve: { "0": { rewardToken: YB, amount: "x" } } })
    ).toThrow();
  });
});

describe("computeVotiumRawPayouts", () => {
  it("pays reconciled wei amounts per wallet and totals them per token", () => {
    const result = computeVotiumRawPayouts({
      claimedBounties: claims({ [YB]: "1000", [WFRAX]: "500" }),
      minimumPayoutUsd: 1,
      tokenAllocations: {
        [A]: {
          [YB]: { amountWei: "600", usd: 40 },
          [WFRAX]: { amountWei: "500", usd: 150 },
        },
        [B]: {
          [YB]: { amountWei: "400", usd: 27 },
        },
      },
    });

    expect(result.payouts[A.toLowerCase()]).toEqual({
      [YB]: 600n,
      [WFRAX]: 500n,
    });
    expect(result.payouts[B.toLowerCase()]).toEqual({ [YB]: 400n });
    expect(result.totalsPerToken).toEqual({ [YB]: 1000n, [WFRAX]: 500n });
    expect(result.belowFloor).toEqual([]);
  });

  it("drops below-floor wallets and keeps their value out of the withdrawal totals", () => {
    const result = computeVotiumRawPayouts({
      claimedBounties: claims({ [YB]: "1000" }),
      minimumPayoutUsd: 1,
      tokenAllocations: {
        [A]: { [YB]: { amountWei: "990", usd: 60 } },
        [B]: { [YB]: { amountWei: "10", usd: 0.26 } },
      },
    });

    expect(result.payouts[A.toLowerCase()]).toEqual({ [YB]: 990n });
    expect(result.payouts[B.toLowerCase()]).toBeUndefined();
    expect(result.belowFloor).toEqual([B.toLowerCase()]);
    expect(result.totalsPerToken).toEqual({ [YB]: 990n });
  });

  it("floors on the wallet's TOTAL USD across tokens, not per token", () => {
    const result = computeVotiumRawPayouts({
      claimedBounties: claims({ [YB]: "100", [WFRAX]: "100" }),
      minimumPayoutUsd: 1,
      tokenAllocations: {
        [A]: {
          [YB]: { amountWei: "100", usd: 0.6 },
          [WFRAX]: { amountWei: "100", usd: 0.6 },
        },
      },
    });

    expect(result.payouts[A.toLowerCase()]).toEqual({
      [YB]: 100n,
      [WFRAX]: 100n,
    });
    expect(result.belowFloor).toEqual([]);
  });

  it("throws when allocations exceed the claimed amount for a token", () => {
    expect(() =>
      computeVotiumRawPayouts({
        claimedBounties: claims({ [YB]: "100" }),
        minimumPayoutUsd: 1,
        tokenAllocations: {
          [A]: { [YB]: { amountWei: "60", usd: 5 } },
          [B]: { [YB]: { amountWei: "50", usd: 4 } },
        },
      })
    ).toThrow("exceed claimed amount");
  });

  it("validates the cap over ALL wallets including below-floor ones", () => {
    expect(() =>
      computeVotiumRawPayouts({
        claimedBounties: claims({ [YB]: "100" }),
        minimumPayoutUsd: 1,
        tokenAllocations: {
          [A]: { [YB]: { amountWei: "100", usd: 5 } },
          [B]: { [YB]: { amountWei: "10", usd: 0.2 } }, // below floor, still counted
        },
      })
    ).toThrow("exceed claimed amount");
  });

  it("handles empty allocations and zero-amount entries", () => {
    const result = computeVotiumRawPayouts({
      claimedBounties: claims({ [YB]: "100" }),
      minimumPayoutUsd: 1,
      tokenAllocations: {
        [A]: { [YB]: { amountWei: "0", usd: 0 } },
      },
    });
    expect(result.payouts).toEqual({});
    expect(result.totalsPerToken).toEqual({});
    expect(result.belowFloor).toEqual([]);
  });

  it("rejects malformed amounts and negative floors", () => {
    expect(() =>
      computeVotiumRawPayouts({
        claimedBounties: claims({ [YB]: "100" }),
        minimumPayoutUsd: -1,
        tokenAllocations: {},
      })
    ).toThrow("minimumPayoutUsd");
    expect(() =>
      computeVotiumRawPayouts({
        claimedBounties: claims({ [YB]: "100" }),
        minimumPayoutUsd: 1,
        tokenAllocations: { [A]: { [YB]: { amountWei: "1.5", usd: 1 } } },
      })
    ).toThrow("unsigned integer");
  });
});
