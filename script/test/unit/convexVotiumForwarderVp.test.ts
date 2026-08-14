import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getForwardedDelegators: vi.fn(),
  processAllForwarders: vi.fn(),
  getOnChainVotingPower: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock("../../utils/delegationHelper", () => ({
  getForwardedDelegators: mocks.getForwardedDelegators,
}));

vi.mock("../../utils/forwarderCacheUtils", () => ({
  processAllForwarders: mocks.processAllForwarders,
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

import {
  VOTIUM_FORWARDER,
  VLCVX_ONCHAIN_DELEGATION_ADDRESS,
} from "../../utils/constants";
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

describe("getAllForwarders route and voting-power source", () => {
  it("routes an own-vote leg as individual with the platform's direct VP", async () => {
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
        type: "individual",
        votingPower: 120,
      }),
    ]);
    expect(fxn).toEqual([
      expect.objectContaining({
        address: USER,
        type: "individual",
        votingPower: 135,
      }),
    ]);
  });

  it("routes a virtual slice of a Stake DAO delegate's vote as pooled", async () => {
    const forwarders = await getAllForwarders(
      "cvx.eth",
      PROPOSAL,
      [
        {
          voter: USER,
          vp: 30,
          viaDelegate: VLCVX_ONCHAIN_DELEGATION_ADDRESS,
        },
      ],
      123_456,
      1_000
    );

    expect(forwarders).toEqual([
      expect.objectContaining({
        address: USER,
        type: "pooled",
        votingPower: 30,
      }),
    ]);
  });

  it("routes a virtual slice of a NON-Stake-DAO delegate's vote as individual", async () => {
    const forwarders = await getAllForwarders(
      "cvx.eth",
      PROPOSAL,
      [{ voter: USER, vp: 45, viaDelegate: THE_UNION }],
      123_456,
      1_000
    );

    expect(forwarders).toEqual([
      expect.objectContaining({
        address: USER,
        type: "individual",
        votingPower: 45,
      }),
    ]);
  });

  it("classifies per platform: pooled on one, individual on the other", async () => {
    const curve = await getAllForwarders(
      "cvx.eth",
      PROPOSAL,
      [{ voter: USER, vp: 120 }], // voted itself on Curve
      123_456,
      1_000
    );
    const fxn = await getAllForwarders(
      "cvx.eth",
      { ...PROPOSAL, id: 8 },
      [
        {
          voter: USER,
          vp: 65_105,
          viaDelegate: VLCVX_ONCHAIN_DELEGATION_ADDRESS,
        },
      ],
      123_500,
      1_000
    );

    expect(curve[0].type).toBe("individual");
    expect(fxn[0].type).toBe("pooled");
  });

  it("keeps an indexed-only forwarder individual on its on-chain VP", async () => {
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
        type: "individual",
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
});
