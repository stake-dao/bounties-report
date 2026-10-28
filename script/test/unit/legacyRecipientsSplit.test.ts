/**
 * sdCRV/sdFXN weekly shares move to the universal distributors; only
 * LEGACY_STASH_RECIPIENTS (Aladdin's locker, which claims from the legacy
 * stash on-chain) keep theirs on the legacy merkle next to the carried
 * unclaimed balances.
 */
import { describe, it, expect, vi } from "vitest";
import { formatUnits } from "viem";
import { BigNumber } from "ethers";
import { DELEGATION_ADDRESS, SDCRV_SPACE } from "../../utils/constants";

const GAUGE = "0xbbbb22220000000000000000000000000000bbbb";
const KEPT = "0xd111000000000000000000000000000000000001";
const DIVERTED = "0xd222000000000000000000000000000000000002";
const CARRIED = "0xd333000000000000000000000000000000000003";

const proposal = {
  id: "0xproposal",
  end: 1784642400,
  created: 1784170674,
  snapshot: "25542094",
  strategies: [],
  space: { id: SDCRV_SPACE },
  choices: ["Gauge B - 0xbbbb2222…bbbb"],
};

vi.mock("../../utils/snapshot", () => ({
  getProposal: async () => proposal,
  getVoters: async () => [{ voter: DELEGATION_ADDRESS, choice: { "1": 1 }, vp: 0 }],
  getVotingPower: async () => ({ [DELEGATION_ADDRESS.toLowerCase()]: 1000 }),
  formatVotingPowerResult: (voters: Array<{ voter: string }>, vps: Record<string, number>) =>
    voters.map((v) => ({ ...v, vp: vps[v.voter.toLowerCase()] ?? 0 })),
}));

vi.mock("../../utils/utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    addVotersFromAutoVoter: async (_space: string, _proposal: unknown, voters: unknown[]) => voters,
    getDelegationVotingPower: async () => ({ [KEPT]: 60, [DIVERTED]: 40 }),
    getAllAccountClaimedSinceLastFreeze: async () => ({}),
  };
});

vi.mock("../../utils/cacheUtils", () => ({
  processAllDelegators: async () => [KEPT, DIVERTED],
}));

import { createMultiMerkle } from "../../utils/merkle/createMultiMerkle";

const leaf = (merkle: any, address: string): number =>
  parseFloat(formatUnits(BigInt(BigNumber.from(merkle.merkle[address]?.amount ?? 0).toString()), 18));

const lastMerkles = [{
  address: "0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5",
  merkle: { [CARRIED]: { amount: BigNumber.from("5000000000000000000"), index: 0, proof: [] } },
}];

describe("legacy recipients split", () => {
  it("keeps only the legacy recipients' weekly share on the legacy merkle and diverts the rest", async () => {
    const result = await createMultiMerkle(
      ["0xproposal"], SDCRV_SPACE, lastMerkles, { [GAUGE]: 1000 }, { total_vp: 1 }, { total_vp: 1 }, {},
      undefined, { legacyRecipients: new Set([KEPT]) },
    );
    expect(leaf(result.merkle, KEPT)).toBeCloseTo(600, 9);
    expect(leaf(result.merkle, CARRIED)).toBeCloseTo(5, 9);
    expect(result.merkle.merkle[DIVERTED]).toBeUndefined();
    expect(result.weeklyTotal).toBeCloseTo(600, 9);
    expect(Object.keys(result.diverted)).toEqual([DIVERTED]);
    expect(result.diverted[DIVERTED]).toBeCloseTo(400, 9);
  });

  it("reports an empty legacy week when no legacy recipient earned anything", async () => {
    const result = await createMultiMerkle(
      ["0xproposal"], SDCRV_SPACE, [], { [GAUGE]: 1000 }, { total_vp: 1 }, { total_vp: 1 }, {},
      undefined, { legacyRecipients: new Set(["0x0000000000000000000000000000000000000009"]) },
    );
    expect(result.weeklyTotal).toBe(0);
    expect(Object.keys(result.merkle.merkle)).toEqual([]);
    expect(result.diverted[KEPT] + result.diverted[DIVERTED]).toBeCloseTo(1000, 9);
  });

  it("changes nothing without the option", async () => {
    const result = await createMultiMerkle(
      ["0xproposal"], SDCRV_SPACE, [], { [GAUGE]: 1000 }, { total_vp: 1 }, { total_vp: 1 }, {},
    );
    expect(leaf(result.merkle, KEPT) + leaf(result.merkle, DIVERTED)).toBeCloseTo(1000, 9);
    expect(result.weeklyTotal).toBeCloseTo(1000, 9);
    expect(result.diverted).toEqual({});
  });
});
