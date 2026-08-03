/**
 * Unit tests for getOnChainDelegators (ENG-1973): DelegateSet enumeration,
 * epoch filtering, and the exact completeness check against the delegate's
 * on-chain weight.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CVX_GAUGE_DELEGATION_CREATION_BLOCK_ETH } from "../../utils/constants";

// The explorer scan is the only non-injected dependency — mock it and drive
// the returned DelegateSet users per test.
let delegateSetUsers: string[] = [];
vi.mock("../../utils/explorerUtils", () => ({
  createBlockchainExplorerUtils: () => ({
    getLogsByAddressAndTopics: async () => ({
      result: delegateSetUsers.map((user) => ({
        topics: [
          "0xsig",
          `0x000000000000000000000000${user.slice(2)}`,
          "0xdelegate",
        ],
      })),
    }),
  }),
}));

import { getOnChainDelegators } from "../../utils/onChainDelegation";

const DELEGATION = "0xb8270eef1319173dE9f5033FED442F638ff1607d";
const DELEGATE = "0xbB06fEFB8f23A7c60C93fe20464DB6687C51955f";
const EPOCH = 230;

const USER_1 = "0x1111111111111111111111111111111111111111";
const USER_2 = "0x2222222222222222222222222222222222222222";
const USER_3 = "0x3333333333333333333333333333333333333333";

// delegates: user -> delegate at epoch; weights: user -> synced weight (wei);
// delegateWeight: the delegate's on-chain balanceAtEpochOf
const makeClient = (
  delegates: Record<string, string>,
  weights: Record<string, bigint>,
  delegateWeight: bigint
) => ({
  // single chunk: latest = creation block + 10
  getBlockNumber: async () =>
    BigInt(CVX_GAUGE_DELEGATION_CREATION_BLOCK_ETH + 10),
  readContract: async ({ functionName }: any) => {
    if (functionName === "balanceAtEpochOf") return delegateWeight;
    throw new Error(`unexpected readContract: ${functionName}`);
  },
  multicall: async ({ contracts }: any) =>
    contracts.map((c: any) => {
      if (c.functionName === "getDelegateAtEpoch")
        return delegates[(c.args[0] as string).toLowerCase()];
      if (c.functionName === "userWeightAtEpochOf")
        return weights[(c.args[1] as string).toLowerCase()] ?? 0n;
      throw new Error(`unexpected multicall: ${c.functionName}`);
    }),
});

beforeEach(() => {
  delegateSetUsers = [];
});

describe("getOnChainDelegators", () => {
  it("returns users still delegating at the epoch when weights reconcile exactly", async () => {
    delegateSetUsers = [USER_1, USER_2, USER_3];
    const client = makeClient(
      {
        [USER_1]: DELEGATE,
        [USER_2]: DELEGATE,
        [USER_3]: "0x0000000000000000000000000000000000000000", // revoked
      },
      { [USER_1]: 100n * 10n ** 18n, [USER_2]: 50n * 10n ** 18n },
      150n * 10n ** 18n
    );

    const delegators = await getOnChainDelegators(
      DELEGATION,
      DELEGATE,
      EPOCH,
      client
    );
    expect(delegators.sort()).toEqual([USER_1, USER_2]);
  });

  it("throws on a deficit: the log scan missed delegators", async () => {
    delegateSetUsers = [USER_1];
    const client = makeClient(
      { [USER_1]: DELEGATE },
      { [USER_1]: 100n * 10n ** 18n },
      150n * 10n ** 18n // 50 vlCVX belong to a delegator the scan missed
    );

    await expect(
      getOnChainDelegators(DELEGATION, DELEGATE, EPOCH, client)
    ).rejects.toThrow("log scan is likely incomplete");
  });

  it("throws on an excess: extra or duplicate delegators enumerated", async () => {
    delegateSetUsers = [USER_1, USER_2];
    const client = makeClient(
      { [USER_1]: DELEGATE, [USER_2]: DELEGATE },
      { [USER_1]: 100n * 10n ** 18n, [USER_2]: 100n * 10n ** 18n },
      150n * 10n ** 18n
    );

    await expect(
      getOnChainDelegators(DELEGATION, DELEGATE, EPOCH, client)
    ).rejects.toThrow("extra or duplicate delegators");
  });

  it("skips the completeness check when nothing is delegated at the epoch", async () => {
    delegateSetUsers = [USER_1];
    const client = makeClient({ [USER_1]: DELEGATE }, {}, 0n);

    const delegators = await getOnChainDelegators(
      DELEGATION,
      DELEGATE,
      EPOCH,
      client
    );
    expect(delegators).toEqual([USER_1]);
  });

  it("throws when no DelegateSet event is found (seeded delegators expected)", async () => {
    delegateSetUsers = [];
    const client = makeClient({}, {}, 0n);

    await expect(
      getOnChainDelegators(DELEGATION, DELEGATE, EPOCH, client)
    ).rejects.toThrow("No DelegateSet events found");
  });
});
