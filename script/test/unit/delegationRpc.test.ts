import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringToHex, zeroAddress } from "viem";
import { getClient } from "../../utils/getClients";
import { processAllDelegators } from "../../utils/cacheUtils";
import {
  DELEGATE_REGISTRY_CREATION_BLOCK_ETH,
  DELEGATION_ADDRESS,
} from "../../utils/constants";
import { verifyAllSpacesAgainstRPC } from "../../utils/delegationRPCUtils";

vi.mock("../../utils/getClients", () => ({ getClient: vi.fn() }));
vi.mock("../../utils/cacheUtils", () => ({
  fetchAllDelegators: async () => {},
  processAllDelegators: vi.fn(),
}));

const FIRST = BigInt(DELEGATE_REGISTRY_CREATION_BLOCK_ETH);
const BLOCK = FIRST + 50_000n;
const TIMESTAMP = 1794441600n;
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const SPACE = stringToHex("sdcrv.eth", { size: 32 });

// Model a registry with duplicate Set events and a delegation at the final
// inclusive scan boundary. Latest state intentionally differs from BLOCK.
function rpcClient() {
  const events = [
    { blockNumber: FIRST, args: { delegator: A, id: SPACE } },
    { blockNumber: FIRST + 1n, args: { delegator: A, id: SPACE } },
    { blockNumber: BLOCK, args: { delegator: B, id: SPACE } },
    { blockNumber: BLOCK + 1n, args: { delegator: C, id: SPACE } },
  ];
  return {
    getBlock: async ({ blockTag, blockNumber }: any) => {
      const number = blockTag === "finalized" ? BLOCK + 1n : blockNumber;
      return { number, timestamp: number === BLOCK ? TIMESTAMP : TIMESTAMP + 12n };
    },
    getLogs: async ({ fromBlock, toBlock }: any) => events.filter(
      (event) => event.blockNumber >= fromBlock && event.blockNumber <= toBlock
    ),
    multicall: async ({ blockNumber, contracts }: any) => contracts.map(
      ({ args: [user, space] }: any) => space === SPACE && (
        blockNumber === BLOCK ? [A, B] : blockNumber === BLOCK + 1n ? [A, C] : []
      ).includes(user.toLowerCase())
        ? DELEGATION_ADDRESS
        : zeroAddress
    ),
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(getClient).mockResolvedValue(rpcClient() as any);
  vi.mocked(processAllDelegators).mockImplementation(async (space, timestamp) =>
    space === "sdcrv.eth" && timestamp === Number(TIMESTAMP) ? [A, B] : []
  );
});

afterEach(() => vi.restoreAllMocks());

describe("Snapshot delegation RPC verification", () => {
  it("accepts matching delegations at a pinned historical block, including the scan boundary", async () => {
    await expect(verifyAllSpacesAgainstRPC("1", DELEGATION_ADDRESS, BLOCK)).resolves.toBeUndefined();
  });

  it("uses one finalized block and excludes later events by default", async () => {
    vi.mocked(processAllDelegators).mockImplementation(async (space, timestamp) =>
      space === "sdcrv.eth" && timestamp === Number(TIMESTAMP + 12n) ? [A, C] : []
    );
    await expect(verifyAllSpacesAgainstRPC("1", DELEGATION_ADDRESS)).resolves.toBeUndefined();
  });

  it("finds active RPC delegators missing from parquet, rather than only checking known wallets", async () => {
    vi.mocked(processAllDelegators).mockImplementation(async (space) => space === "sdcrv.eth" ? [A] : []);
    await expect(verifyAllSpacesAgainstRPC("1", DELEGATION_ADDRESS, BLOCK))
      .rejects.toThrow(/sdcrv\.eth.*0 in parquet only.*1 in RPC only/);
  });

  it("rejects parquet wallets that never delegated to the target", async () => {
    vi.mocked(processAllDelegators).mockImplementation(async (space) => space === "sdcrv.eth" ? [A, B, C] : []);
    await expect(verifyAllSpacesAgainstRPC("1", DELEGATION_ADDRESS, BLOCK))
      .rejects.toThrow(/sdcrv\.eth.*1 in parquet only.*0 in RPC only/);
  });

  it("rejects a cached delegation cleared or redirected since its Set event", async () => {
    const client = rpcClient();
    client.multicall = async ({ contracts }: any) => contracts.map(() => zeroAddress);
    vi.mocked(getClient).mockResolvedValue(client as any);
    await expect(verifyAllSpacesAgainstRPC("1", DELEGATION_ADDRESS, BLOCK))
      .rejects.toThrow(/sdcrv\.eth.*2 in parquet only.*0 in RPC only/);
  });

  it("does not skip an unreadable parquet space", async () => {
    vi.mocked(processAllDelegators).mockRejectedValue(new Error("Unreadable parquet"));
    await expect(verifyAllSpacesAgainstRPC("1", DELEGATION_ADDRESS, BLOCK))
      .rejects.toThrow("Unreadable parquet");
  });

  it.each(["getLogs", "multicall"] as const)("fails closed when RPC %s fails", async (method) => {
    const client = rpcClient();
    client[method] = async () => { throw new Error("RPC unavailable"); };
    vi.mocked(getClient).mockResolvedValue(client as any);
    await expect(verifyAllSpacesAgainstRPC("1", DELEGATION_ADDRESS, BLOCK))
      .rejects.toThrow("RPC unavailable");
  });

  it("makes the indexer command fail on an RPC verification error", async () => {
    vi.mocked(getClient).mockRejectedValue(new Error("RPC unavailable"));
    const exitCode = process.exitCode;
    try {
      await import("../../indexer/delegators");
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
    } finally {
      process.exitCode = exitCode;
    }
  });
});
