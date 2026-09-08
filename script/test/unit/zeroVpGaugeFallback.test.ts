/**
 * Regression tests for createMultiMerkle's non-found-gauge fallback: a gauge
 * whose only choice-map entries carry weight 0 (or whose voters have no vp)
 * must route its rewards to the delegation like a gauge with no voters at all,
 * instead of silently dropping them (2026-08-04 sdCRV surplus incident: the
 * amount was funded to the merkle contract but allocated to nobody).
 */
import { describe, it, expect, vi } from "vitest";
import { formatUnits } from "viem";
import { BigNumber } from "ethers";
import { DELEGATION_ADDRESS, SD_CRV, SDCRV_SPACE } from "../../utils/constants";

const mocks = vi.hoisted(() => ({
  getAllAccountClaimedSinceLastFreeze: vi.fn(async () => ({})),
}));

const GAUGE_A = "0xaaaa11110000000000000000000000000000aaaa"; // bribed, zero-weight voter only
const GAUGE_B = "0xbbbb22220000000000000000000000000000bbbb"; // bribed, voted by delegation
const GAUGE_C = "0xcccc33330000000000000000000000000000cccc"; // bribed, no voter at all
const EXPANDED_USER = "0xeeee44440000000000000000000000000000eeee";
const DELEGATOR_1 = "0xd111000000000000000000000000000000000001";
const DELEGATOR_2 = "0xd222000000000000000000000000000000000002";

const proposal = {
  id: "0xproposal",
  end: 1784642400,
  created: 1784170674,
  snapshot: "25542094",
  strategies: [],
  space: { id: SDCRV_SPACE },
  choices: [
    "Gauge A - 0xaaaa1111…aaaa",
    "Gauge B - 0xbbbb2222…bbbb",
    "Gauge C - 0xcccc3333…cccc",
  ],
};

vi.mock("../../utils/snapshot", () => ({
  getProposal: async () => proposal,
  getVoters: async () => [
    { voter: DELEGATION_ADDRESS, choice: { "2": 1 }, vp: 0 },
  ],
  getVotingPower: async () => ({ [DELEGATION_ADDRESS.toLowerCase()]: 1000 }),
  formatVotingPowerResult: (
    voters: Array<{ voter: string }>,
    vps: Record<string, number>
  ) => voters.map((v) => ({ ...v, vp: vps[v.voter.toLowerCase()] ?? 0 })),
}));

vi.mock("../../utils/utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Inject the expanded auto-voter delegator holding a weight-0 entry for
    // gauge A's choice — the exact shape produced when a user re-registers
    // away from a gauge (the contract keeps the entry at weight 0).
    addVotersFromAutoVoter: async (
      _space: string,
      _proposal: unknown,
      voters: unknown[]
    ) => [
      ...voters,
      { voter: EXPANDED_USER, choice: { "1": 0 }, vp: 500 },
    ],
    getDelegationVotingPower: async () => ({
      [DELEGATOR_1]: 60,
      [DELEGATOR_2]: 40,
    }),
    getAllAccountClaimedSinceLastFreeze:
      mocks.getAllAccountClaimedSinceLastFreeze,
  };
});

vi.mock("../../utils/cacheUtils", () => ({
  processAllDelegators: async () => [DELEGATOR_1, DELEGATOR_2],
}));

import { createMultiMerkle } from "../../utils/merkle/createMultiMerkle";

const leafAmount = (merkle: any, address: string): number => {
  const leaf = merkle.merkle[address.toLowerCase()];
  if (!leaf) return 0;
  return parseFloat(formatUnits(BigInt(BigNumber.from(leaf.amount).toString()), 18));
};

describe("createMultiMerkle zero-vp gauge fallback", () => {
  it("routes rewards of a gauge with only zero-weight entries to the delegation", async () => {
    const result = await createMultiMerkle(
      ["0xproposal"],
      SDCRV_SPACE,
      [],
      { [GAUGE_A]: 100, [GAUGE_B]: 50 },
      { total_vp: 1 },
      { total_vp: 1 }
    );

    const total = parseFloat(
      formatUnits(BigInt(BigNumber.from(result.merkle.total).toString()), 18)
    );
    // Nothing lost: gauge A's 100 joins the delegation's 50 from gauge B.
    expect(total).toBeCloseTo(150, 6);
    expect(leafAmount(result.merkle, DELEGATOR_1)).toBeCloseTo(90, 6);
    expect(leafAmount(result.merkle, DELEGATOR_2)).toBeCloseTo(60, 6);
    expect(leafAmount(result.merkle, EXPANDED_USER)).toBe(0);
  });

  it("still routes rewards of a gauge with no voters at all to the delegation", async () => {
    const result = await createMultiMerkle(
      ["0xproposal"],
      SDCRV_SPACE,
      [],
      { [GAUGE_B]: 50, [GAUGE_C]: 30 },
      { total_vp: 1 },
      { total_vp: 1 }
    );

    const total = parseFloat(
      formatUnits(BigInt(BigNumber.from(result.merkle.total).toString()), 18)
    );
    expect(total).toBeCloseTo(80, 6);
    expect(leafAmount(result.merkle, DELEGATOR_1)).toBeCloseTo(48, 6);
    expect(leafAmount(result.merkle, DELEGATOR_2)).toBeCloseTo(32, 6);
  });

  it("forwards read-only cache mode without changing generation defaults", async () => {
    mocks.getAllAccountClaimedSinceLastFreeze.mockClear();
    await createMultiMerkle(
      ["0xproposal"],
      SDCRV_SPACE,
      [{ address: SD_CRV, merkle: {} }],
      { [GAUGE_B]: 50 },
      { total_vp: 1 },
      { total_vp: 1 },
      {},
      undefined,
      { readOnlyClaimCache: true },
    );

    expect(mocks.getAllAccountClaimedSinceLastFreeze).toHaveBeenCalledWith(
      expect.any(String),
      SD_CRV,
      "1",
      { readOnly: true },
    );
  });
});
