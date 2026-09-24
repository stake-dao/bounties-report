import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, pad, toHex } from "viem";

const mocks = vi.hoisted(() => ({
  explorerLogs: vi.fn(),
  explorerBlock: vi.fn(),
  rpcLogs: vi.fn(),
  rpcHead: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("../../utils/explorerUtils", () => ({
  createBlockchainExplorerUtils: () => ({
    getLogsByAddressAndTopics: mocks.explorerLogs,
    getBlockNumberByTimestamp: mocks.explorerBlock,
  }),
}));
vi.mock("../../utils/getClients", () => ({
  getClientWithFallback: async () => ({ getLogs: mocks.rpcLogs, getBlockNumber: mocks.rpcHead, multicall: vi.fn() }),
}));

import { getBlockNumberByTimestamp } from "../../utils/chainUtils";
import { assertClaimLogsMatchRpc, fetchVotemarketV2ClaimedBounties } from "../../utils/claims/votemarketV2Claims";

const LOCKER = "0x52f541764E6e90eeBc5c21Ff570De0e2D63766B6" as const;
const VM = "0x8c2c5A295450DDFf4CB360cA73FCCC12243D14D9";
const CLAIM_TOPIC = keccak256(toHex("Claim(uint256,address,uint256,uint256,uint256)"));
const claimLog = (txHash: string, logIndex: number) => ({
  address: VM,
  transactionHash: txHash,
  logIndex,
  blockNumber: "0x1e4bf13f",
  topics: [CLAIM_TOPIC, pad("0x01"), pad(LOCKER)],
  data: encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [1n, 0n, 1790208000n]
  ),
});

afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("claim window", () => {
  it("never resolves a block bound to zero", async () => {
    mocks.explorerBlock.mockResolvedValue(0);
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.fetch.mockResolvedValue({ ok: false, status: 502 });
    await expect(getBlockNumberByTimestamp(1790208000, "after", 42161)).rejects.toThrow(
      /No block after timestamp 1790208000 on chain 42161 \(explorer: no closest block; llama: HTTP 502\)/
    );
  });

  it("falls back to DefiLlama when the explorer has no closest block", async () => {
    mocks.explorerBlock.mockRejectedValue(new Error("Explorer API request failed"));
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ height: 508293439 }) });
    await expect(getBlockNumberByTimestamp(1790208000, "before", 42161)).resolves.toBe(508293439);
  });
});

describe("explorer vs rpc cross-check", () => {
  it("throws when the rpc sees claims the explorer did not return", async () => {
    mocks.rpcLogs.mockResolvedValue([{ transactionHash: "0xb97b", logIndex: 7 }]);
    await expect(
      assertClaimLogsMatchRpc(42161, [VM], 508290000, 508293500, LOCKER, [])
    ).rejects.toThrow(/Claim logs mismatch .* explorer 0, rpc 1; missing from explorer 0xb97b:7/);
  });

  it("throws when the explorer returns claims the rpc does not know", async () => {
    mocks.rpcLogs.mockResolvedValue([]);
    await expect(
      assertClaimLogsMatchRpc(42161, [VM], 1, 10, LOCKER, [claimLog("0xdead", 1)])
    ).rejects.toThrow(/unknown to rpc 0xdead:1/);
  });

  it("passes when both agree and chunks the rpc range", async () => {
    mocks.rpcLogs.mockResolvedValue([{ transactionHash: "0xB97B", logIndex: 7 }]);
    await expect(
      assertClaimLogsMatchRpc(42161, [VM], 1, 12_000, LOCKER, [claimLog("0xb97b", "0x7")])
    ).resolves.toBeUndefined();
    expect(mocks.rpcLogs).toHaveBeenCalledTimes(3);
    expect(mocks.rpcLogs.mock.calls[0][0]).toMatchObject({ fromBlock: 1n, toBlock: 5_000n, args: { account: LOCKER } });
  });
});

describe("fetchVotemarketV2ClaimedBounties", () => {
  it("ends a current-week window at the chain head and fails on a disagreeing explorer", async () => {
    mocks.explorerBlock.mockResolvedValue(508290000);
    mocks.rpcHead.mockResolvedValue(508293500n);
    mocks.explorerLogs.mockResolvedValue({ result: [] });
    mocks.rpcLogs.mockResolvedValue([{ transactionHash: "0xb97b", logIndex: 7 }]);
    const now = Math.floor(Date.now() / 1000);
    await expect(
      fetchVotemarketV2ClaimedBounties("fxn", now - 3600, now, LOCKER)
    ).rejects.toThrow(/Claim logs mismatch/);
    expect(mocks.explorerLogs).toHaveBeenCalledWith(expect.any(String), 508290000, 508293500, expect.any(Object), expect.any(Number));
  });

  it("returns an empty protocol when explorer and rpc both see nothing", async () => {
    mocks.explorerBlock.mockResolvedValue(508290000);
    mocks.rpcHead.mockResolvedValue(508293500n);
    mocks.explorerLogs.mockResolvedValue({ result: [] });
    mocks.rpcLogs.mockResolvedValue([]);
    const now = Math.floor(Date.now() / 1000);
    await expect(fetchVotemarketV2ClaimedBounties("fxn", now - 3600, now, LOCKER)).resolves.toEqual({ fxn: [] });
  });
});
