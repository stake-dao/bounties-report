import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDistribution } from "../../sdTkns/generateMerkle";
import { getAllAccountClaimedSinceLastFreeze } from "../../utils/utils";

const mocks = vi.hoisted(() => ({ readContract: vi.fn(), getLogs: vi.fn(), exists: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const mocked = { ...actual, existsSync: mocks.exists, readFileSync: mocks.read, writeFileSync: mocks.write };
  return { ...mocked, default: mocked };
});
vi.mock("../../utils/getClients", () => ({
  getClient: async () => ({ readContract: mocks.readContract, getBlock: async () => ({ number: 300n }) }),
}));
vi.mock("../../utils/explorerUtils", () => ({
  createBlockchainExplorerUtils: () => ({ getLogsByAddressAndTopics: mocks.getLogs }),
}));

const PERIOD = 1788393600;
const SDCRV = "0xd1b5651e55d4ceed36251c61c50c889b36f6abb5";
const DISTRIBUTOR = "0x03e34b085c52985f6a5d27243f20c84bddc01db4";
const ZERO = "0x" + "00".repeat(32);
const ROOT = "0x" + "11".repeat(32);

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("post-freeze freshness", () => {
  it("records the freeze separately from the nonzero claim-window anchor", async () => {
    mocks.exists.mockReturnValue(true);
    mocks.read.mockReturnValue(JSON.stringify({ blockNumber: 100, timestamp: PERIOD - 604800 }));
    mocks.getLogs.mockResolvedValueOnce({ result: [
      { blockNumber: 100, timeStamp: PERIOD - 604800, topics: ["event", "token", ROOT] },
      { blockNumber: 200, timeStamp: PERIOD + 100, topics: ["event", "token", ZERO] },
    ] }).mockResolvedValueOnce({ result: [] });
    await getAllAccountClaimedSinceLastFreeze(DISTRIBUTOR, SDCRV, "1");
    expect(JSON.parse(String(mocks.write.mock.calls[0][1]))).toEqual({
      blockNumber: 100, timestamp: PERIOD - 604800, freezeTimestamp: PERIOD + 100,
    });
    expect(mocks.getLogs.mock.calls[1][1]).toBe(100);
  });

  it.each([
    [ZERO, PERIOD + 100, true],
    [ZERO, PERIOD - 1, false],
    [ZERO, undefined, false],
    [ROOT, PERIOD + 100, false],
  ])("checks the actual frozen root and this week's freeze timestamp", async (root, freezeTimestamp, expected) => {
    mocks.exists.mockReturnValue(true);
    mocks.read.mockReturnValue(JSON.stringify({ timestamp: PERIOD - 604800, freezeTimestamp }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.readContract.mockResolvedValue(root);
    const merkle = [{ chainId: 1, symbol: "sdCRV", address: SDCRV, merkleContract: DISTRIBUTOR, total: "100" }];
    const result = await checkDistribution(merkle as any, { TotalReported: { sdCRV: 1 } }, PERIOD, true);
    expect(result, JSON.stringify(errors.mock.calls)).toBe(expected);
  });
});
