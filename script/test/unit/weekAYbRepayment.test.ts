/**
 * One-shot repayment of the week-A YB gauge rewards (USDT+crvUSD +
 * USDC+crvUSD, 23/7-5/8 round) stranded in the merkle contract by the
 * end-block read bug fixed in #170. Keyed to the round's proposal id so it
 * fires only for this round's generations and self-disarms next round.
 * Remove this test together with the repayment block after the round closes.
 */
import { describe, it, expect, vi } from "vitest";
import { formatUnits } from "viem";
import { BigNumber } from "ethers";
import { DELEGATION_ADDRESS, SDCRV_SPACE } from "../../utils/constants";

const ROUND_PROPOSAL_ID =
  "0x79d8a5b7e4ae963d8c980c4ab4adfcdbe0e39e3b5677cf4a33c1da53e5ff7049";
const REPAID_USER = "0xe4f02accc88a3000f11afec71c04896127a3aeb5";
const REPAID_AMOUNT = 8078.312182;

const GAUGE_B = "0xbbbb22220000000000000000000000000000bbbb";
const DELEGATOR_1 = "0xd111000000000000000000000000000000000001";
const DELEGATOR_2 = "0xd222000000000000000000000000000000000002";

const baseProposal = {
  end: 1784642400,
  created: 1784170674,
  snapshot: "25542094",
  strategies: [],
  space: { id: SDCRV_SPACE },
  choices: ["Gauge A - 0xaaaa1111…aaaa", "Gauge B - 0xbbbb2222…bbbb"],
};

vi.mock("../../utils/snapshot", () => ({
  getProposal: async (id: string) => ({ ...baseProposal, id }),
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
    addVotersFromAutoVoter: async (
      _space: string,
      _proposal: unknown,
      voters: unknown[]
    ) => voters,
    getDelegationVotingPower: async () => ({
      [DELEGATOR_1]: 60,
      [DELEGATOR_2]: 40,
    }),
    getAllAccountClaimedSinceLastFreeze: async () => ({}),
  };
});

vi.mock("../../utils/cacheUtils", () => ({
  processAllDelegators: async () => [DELEGATOR_1, DELEGATOR_2],
}));

import { createMultiMerkle } from "../../utils/merkle/createMultiMerkle";

const leafAmount = (merkle: any, address: string): number => {
  const leaf = merkle.merkle[address.toLowerCase()];
  if (!leaf) return 0;
  return parseFloat(
    formatUnits(BigInt(BigNumber.from(leaf.amount).toString()), 18)
  );
};

describe("week-A YB repayment", () => {
  it("adds the stranded week-A amount to the sole voter for this round's proposal", async () => {
    const result = await createMultiMerkle(
      [ROUND_PROPOSAL_ID],
      SDCRV_SPACE,
      [],
      { [GAUGE_B]: 50 },
      { total_vp: 1 },
      { total_vp: 1 }
    );

    expect(leafAmount(result.merkle, REPAID_USER)).toBeCloseTo(REPAID_AMOUNT, 6);
    // Regular distribution is untouched: gauge B still flows to delegators.
    expect(leafAmount(result.merkle, DELEGATOR_1)).toBeCloseTo(30, 6);
    expect(leafAmount(result.merkle, DELEGATOR_2)).toBeCloseTo(20, 6);
    const total = parseFloat(
      formatUnits(BigInt(BigNumber.from(result.merkle.total).toString()), 18)
    );
    expect(total).toBeCloseTo(50 + REPAID_AMOUNT, 6);
  });

  it("does not fire for any other proposal", async () => {
    const result = await createMultiMerkle(
      ["0xother0000000000000000000000000000000000000000000000000000000000"],
      SDCRV_SPACE,
      [],
      { [GAUGE_B]: 50 },
      { total_vp: 1 },
      { total_vp: 1 }
    );

    expect(leafAmount(result.merkle, REPAID_USER)).toBe(0);
    const total = parseFloat(
      formatUnits(BigInt(BigNumber.from(result.merkle.total).toString()), 18)
    );
    expect(total).toBeCloseTo(50, 6);
  });
});
