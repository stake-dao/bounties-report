import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchDelegatorData: vi.fn(),
  getForwardedDelegators: vi.fn(),
  processAllForwarders: vi.fn(),
  getOnChainVotingPower: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock("../../utils/delegationHelper", () => ({
  fetchDelegatorData: mocks.fetchDelegatorData,
  getForwardedDelegators: mocks.getForwardedDelegators,
}));

vi.mock("../../utils/forwarderCacheUtils", () => ({
  processAllForwarders: mocks.processAllForwarders,
}));

const delegationMocks = vi.hoisted(() => ({
  getDelegatesAtEpoch: vi.fn(),
  getContributingWeightsAtVote: vi.fn(),
}));

vi.mock("../../utils/onChainDelegation", () => ({
  getDelegatesAtEpoch: delegationMocks.getDelegatesAtEpoch,
  getContributingWeightsAtVote: delegationMocks.getContributingWeightsAtVote,
}));

vi.mock("../../utils/gaugeVotePlatform", () => ({
  getOnChainProposal: vi.fn(),
  getOnChainVoters: vi.fn(),
  getOnChainVotingPower: mocks.getOnChainVotingPower,
  associateGaugesPerIdOnChain: vi.fn(),
}));

vi.mock("../../utils/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/constants")>();
  return { ...actual, getClient: mocks.getClient };
});

import { VOTIUM_FORWARDER } from "../../utils/constants";
import { getAllForwarders } from "../../vlCVX/claims/generateConvexVotium";

const USER = "0x1111111111111111111111111111111111111111";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const PROPOSAL = {
  id: 7,
  author: "0x2222222222222222222222222222222222222222",
  snapshot: 230,
};

const THE_UNION = "0xde1E6A7ED0ad3F61D531a8a78E83CcDdbd6E0c49";

beforeEach(() => {
  vi.clearAllMocks();

  delegationMocks.getDelegatesAtEpoch.mockResolvedValue({});
  delegationMocks.getContributingWeightsAtVote.mockResolvedValue({});

  mocks.fetchDelegatorData.mockResolvedValue({
    delegators: [USER],
    votingPowers: { [USER]: 30 },
    totalVotingPower: 30,
  });
  mocks.processAllForwarders.mockResolvedValue([]);
  mocks.getOnChainVotingPower.mockResolvedValue({});
  mocks.getClient.mockResolvedValue({});
  mocks.getForwardedDelegators.mockImplementation(
    async (addresses: string[]) =>
      addresses.map((address) =>
        address.toLowerCase() === USER
          ? VOTIUM_FORWARDER
          : ZERO_ADDRESS
      )
  );
});

describe("getAllForwarders voting-power source", () => {
  it("uses a hybrid delegator's direct VP from each platform", async () => {
    const curve = await getAllForwarders(
      "cvx.eth",
      PROPOSAL,
      [{ voter: USER, vp: 120 }],
      123_456,
      1_000
    );
    const fxn = await getAllForwarders(
      "cvx.eth",
      { ...PROPOSAL, id: 8 },
      [{ voter: USER, vp: 135 }],
      123_500,
      1_000
    );

    expect(curve).toEqual([
      expect.objectContaining({
        address: USER,
        type: "delegator",
        votingPower: 120,
      }),
    ]);
    expect(fxn).toEqual([
      expect.objectContaining({
        address: USER,
        type: "delegator",
        votingPower: 135,
      }),
    ]);
  });

  it("does not use a StakeDAO contributing weight for an indexed-only forwarder", async () => {
    mocks.processAllForwarders.mockResolvedValue([USER]);
    mocks.getOnChainVotingPower.mockResolvedValue({ [USER]: 80 });

    const forwarders = await getAllForwarders(
      "cvx.eth",
      PROPOSAL,
      [],
      123_456,
      1_000
    );

    expect(forwarders).toEqual([
      expect.objectContaining({
        address: USER,
        type: "delegator",
        votingPower: 80,
      }),
    ]);
  });

  it("preserves an explicit zero direct VP instead of falling back to delegation VP", async () => {
    const forwarders = await getAllForwarders(
      "cvx.eth",
      PROPOSAL,
      [{ voter: USER, vp: 0 }],
      123_456,
      1_000
    );

    expect(forwarders[0].votingPower).toBe(0);
  });

  it("prices a Union delegator's slice at its contributing weight, not raw VP", async () => {
    mocks.fetchDelegatorData.mockResolvedValue(null);
    mocks.processAllForwarders.mockResolvedValue([USER]);
    mocks.getOnChainVotingPower.mockResolvedValue({ [USER]: 7_374 });
    delegationMocks.getDelegatesAtEpoch.mockResolvedValue({
      [USER]: THE_UNION.toLowerCase(),
    });
    delegationMocks.getContributingWeightsAtVote.mockResolvedValue({
      [USER]: 6_900,
    });

    const forwarders = await getAllForwarders(
      "cvx.eth",
      PROPOSAL,
      [],
      123_456,
      1_000
    );

    expect(delegationMocks.getContributingWeightsAtVote).toHaveBeenCalledWith(
      expect.any(String),
      PROPOSAL.author,
      PROPOSAL.id,
      THE_UNION,
      [USER],
      expect.anything()
    );
    expect(forwarders).toEqual([
      expect.objectContaining({
        address: USER,
        isUnionDelegator: true,
        delegatedTo: THE_UNION,
        votingPower: 7_374,
        unionContributingWeight: 6_900,
      }),
    ]);
  });

  it("keeps a non-delegator direct voter on their own vote VP", async () => {
    mocks.fetchDelegatorData.mockResolvedValue(null);

    const forwarders = await getAllForwarders(
      "cvx.eth",
      PROPOSAL,
      [{ voter: USER, vp: 42 }],
      123_456,
      1_000
    );

    expect(forwarders).toEqual([
      expect.objectContaining({
        address: USER,
        type: "direct-voter",
        votingPower: 42,
      }),
    ]);
  });
});
