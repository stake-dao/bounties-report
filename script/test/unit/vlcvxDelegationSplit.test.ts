/**
 * Unit tests for computeStakeDaoDelegation (ENG-1973): contributing-weight
 * shares, the base/pool bigint split, and the reconciliation guards.
 *
 * All on-chain reads are module-mocked; the math under test is pure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VOTIUM_FORWARDER } from "../../utils/constants";

const mocks = vi.hoisted(() => ({
  getContributingWeightsAtVoteRaw: vi.fn(),
  getVoteOf: vi.fn(),
  getForwardedDelegators: vi.fn(),
}));

vi.mock("../../utils/onChainDelegation", () => ({
  getContributingWeightsAtVoteRaw: mocks.getContributingWeightsAtVoteRaw,
}));
vi.mock("../../utils/gaugeVotePlatform", () => ({
  getVoteOf: mocks.getVoteOf,
}));
vi.mock("../../utils/delegationHelper", () => ({
  getForwardedDelegators: mocks.getForwardedDelegators,
}));
vi.mock("../../utils/chainUtils", () => ({
  getBlockNumberByTimestamp: vi.fn().mockResolvedValue(123456),
}));
vi.mock("../../utils/getClients", () => ({
  getClient: vi.fn().mockResolvedValue({}),
}));

import { computeStakeDaoDelegation } from "../../vlCVX/2_repartition/delegators";

const DELEGATION_VOTER = "0xbb06fefb8f23a7c60c93fe20464db6687c51955f";
const D1 = "0x1111111111111111111111111111111111111111";
const D2 = "0x2222222222222222222222222222222222222222";
const TOKEN = "0xd533a949740bb3306d119cc777fa900ba034cd52";
const ONE = 10n ** 18n;

const proposal = { id: "0", author: "0xPlatform", end: 1_000_000 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getForwardedDelegators.mockResolvedValue([]);
});

describe("computeStakeDaoDelegation", () => {
  it("with baseWeight 0 the full amount is the delegation pool, split by contributing weights", async () => {
    mocks.getContributingWeightsAtVoteRaw.mockResolvedValue({ [D1]: 100n * ONE, [D2]: 50n * ONE });
    mocks.getVoteOf.mockResolvedValue({
      gauges: [],
      weights: [],
      voted: true,
      baseWeight: 0n,
      adjustedWeight: 150n * ONE,
    });
    mocks.getForwardedDelegators.mockResolvedValue([
      VOTIUM_FORWARDER, // D1 forwards
      "0x0000000000000000000000000000000000000000", // D2 does not
    ]);

    const { distribution, delegateOwnTokens } = await computeStakeDaoDelegation(
      proposal,
      [D1, D2],
      { [TOKEN]: 1000n },
      DELEGATION_VOTER,
      {} as any
    );

    expect(delegateOwnTokens).toEqual({});
    expect((distribution[DELEGATION_VOTER] as any).tokens).toEqual({
      [TOKEN]: 1000n,
    });

    const d1 = distribution[D1] as any;
    const d2 = distribution[D2] as any;
    expect(Number(d1.share)).toBeCloseTo(100 / 150, 12);
    expect(d1.shareForwarders).toBe(d1.share);
    expect(d1.shareNonForwarders).toBe("0");
    expect(Number(d2.share)).toBeCloseTo(50 / 150, 12);
    expect(d2.shareForwarders).toBe("0");
    expect(d2.shareNonForwarders).toBe(d2.share);
  });

  it("returns wei-exact per-delegator attribution that conserves the pool", async () => {
    // 1000 split 2:1 → 666.67/333.33: floor gives 666/333, the leftover wei
    // goes to the largest remainder (D1: 100e18 vs D2: 50e18 mod 150e18).
    mocks.getContributingWeightsAtVoteRaw.mockResolvedValue({ [D1]: 100n * ONE, [D2]: 50n * ONE });
    mocks.getVoteOf.mockResolvedValue({
      gauges: [],
      weights: [],
      voted: true,
      baseWeight: 0n,
      adjustedWeight: 150n * ONE,
    });
    mocks.getForwardedDelegators.mockResolvedValue([
      VOTIUM_FORWARDER,
      "0x0000000000000000000000000000000000000000",
    ]);

    const { exact } = await computeStakeDaoDelegation(
      proposal,
      [D1, D2],
      { [TOKEN]: 1000n },
      DELEGATION_VOTER,
      {} as any
    );

    expect(exact.delegate).toBe(DELEGATION_VOTER);
    expect(exact.poolTokens).toEqual({ [TOKEN]: 1000n });
    expect(exact.exactByDelegator[D1][TOKEN]).toBe(667n);
    expect(exact.exactByDelegator[D2][TOKEN]).toBe(333n);
    expect(
      exact.exactByDelegator[D1][TOKEN] + exact.exactByDelegator[D2][TOKEN]
    ).toBe(1000n);
    expect(exact.forwarderFlags[D1]).toBe(true);
    expect(exact.forwarderFlags[D2]).toBe(false);
  });

  it("with baseWeight > 0 the delegate keeps floor(amount*base/effective), the pool gets the remainder", async () => {
    mocks.getContributingWeightsAtVoteRaw.mockResolvedValue({ [D1]: 60n * ONE, [D2]: 40n * ONE });
    mocks.getVoteOf.mockResolvedValue({
      gauges: [],
      weights: [],
      voted: true,
      baseWeight: 50n * ONE,
      adjustedWeight: 100n * ONE,
    });
    mocks.getForwardedDelegators.mockResolvedValue([
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
    ]);

    const { distribution, delegateOwnTokens } = await computeStakeDaoDelegation(
      proposal,
      [D1, D2],
      { [TOKEN]: 999n },
      DELEGATION_VOTER,
      {} as any
    );

    // own = floor(999 * 50 / 150) = 333, pool = 666 — conservation is exact
    expect(delegateOwnTokens).toEqual({ [TOKEN]: 333n });
    expect((distribution[DELEGATION_VOTER] as any).tokens).toEqual({
      [TOKEN]: 666n,
    });
  });

  it("throws when contributing weights do not reconcile with the applied vote", async () => {
    mocks.getContributingWeightsAtVoteRaw.mockResolvedValue({ [D1]: 10n * ONE });
    mocks.getVoteOf.mockResolvedValue({
      gauges: [],
      weights: [],
      voted: true,
      baseWeight: 0n,
      adjustedWeight: 150n * ONE, // helper says 10, vote says 150
    });

    await expect(
      computeStakeDaoDelegation(proposal, [D1], { [TOKEN]: 1000n }, DELEGATION_VOTER)
    ).rejects.toThrow("do not reconcile");
  });

  it("throws when the delegate has no vote on the proposal", async () => {
    mocks.getContributingWeightsAtVoteRaw.mockResolvedValue({});
    mocks.getVoteOf.mockResolvedValue({
      gauges: [],
      weights: [],
      voted: false,
      baseWeight: 0n,
      adjustedWeight: 0n,
    });

    await expect(
      computeStakeDaoDelegation(proposal, [D1], { [TOKEN]: 1000n }, DELEGATION_VOTER)
    ).rejects.toThrow("has no vote");
  });

  it("refuses to strand a non-empty pool when no delegator has a contributing weight", async () => {
    // base 9 + adjusted 1 => pool = 10% of tokens, but the only delegator
    // contributes 0 (drift -1 stays within the 0.1*1+1 tolerance)
    mocks.getContributingWeightsAtVoteRaw.mockResolvedValue({ [D1]: 0n });
    mocks.getVoteOf.mockResolvedValue({
      gauges: [],
      weights: [],
      voted: true,
      baseWeight: 9n * ONE,
      adjustedWeight: 1n * ONE,
    });

    await expect(
      computeStakeDaoDelegation(proposal, [D1], { [TOKEN]: 100n }, DELEGATION_VOTER)
    ).rejects.toThrow("no beneficiary");
  });

  it("throws on a voted account with non-positive effective weight", async () => {
    mocks.getContributingWeightsAtVoteRaw.mockResolvedValue({ [D1]: 0n });
    mocks.getVoteOf.mockResolvedValue({
      gauges: [],
      weights: [],
      voted: true,
      baseWeight: 0n,
      adjustedWeight: 0n,
    });

    await expect(
      computeStakeDaoDelegation(proposal, [D1], { [TOKEN]: 1000n }, DELEGATION_VOTER)
    ).rejects.toThrow("non-positive");
  });
});
