import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ParquetSchema, ParquetWriter } from "parquetjs";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { encodePacked, keccak256, pad } from "viem";
import { formatBytes32String } from "ethers/lib/utils";

const state = vi.hoisted(() => ({ root: "", head: 0, logs: vi.fn() }));
vi.mock("path", async (original) => {
  const actual = await original<typeof import("path")>();
  return { ...actual, join: (...parts: string[]) =>
    parts[1] === "../../data" ? state.root : actual.join(...parts) };
});
vi.mock("node:path", async (original) => {
  const actual = await original<typeof import("node:path")>();
  return { ...actual, join: (...parts: string[]) =>
    parts[1] === "../../data" ? state.root : actual.join(...parts) };
});
vi.mock("viem", async (original) => ({
  ...await original<typeof import("viem")>(),
  createPublicClient: () => ({ getBlockNumber: async () => BigInt(state.head) }),
}));
vi.mock("../../utils/explorerUtils", () => ({
  createBlockchainExplorerUtils: () => ({ getLogsByAddressAndTopics: state.logs }),
}));

const DELEGATE = "0x1111111111111111111111111111111111111111";
const USER = "0x2222222222222222222222222222222222222222";
const schema = new ParquetSchema({
  event: { type: "UTF8" }, user: { type: "UTF8" }, spaceId: { type: "UTF8" },
  timestamp: { type: "INT64" }, blockNumber: { type: "INT64" },
});
let file: string;
let cache: typeof import("../../utils/cacheUtils");

beforeEach(async () => {
  vi.resetModules();
  state.root = mkdtempSync(path.join(tmpdir(), "delegator-integrity-"));
  file = path.join(state.root, "delegations", "1", `${DELEGATE}.parquet`);
  mkdirSync(path.dirname(file), { recursive: true });
  state.head = 30_050_001;
  const writer = await ParquetWriter.openFile(schema, file);
  await writer.appendRow({ event: "EndBlock", user: "", spaceId: "", timestamp: 0, blockNumber: 30_000_000 });
  await writer.close();
  state.logs.mockReset().mockResolvedValue({ result: [] });
  cache = await import("../../utils/cacheUtils");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(state.root, { recursive: true, force: true });
});

describe("delegator checkpoint integrity", () => {
  it("does not checkpoint a partially collected range, then retries it on recovery", async () => {
    const before = readFileSync(file);
    const ranges: number[] = [];
    state.logs.mockImplementation(async (_address, from) => {
      ranges.push(from);
      if (from > 30_050_000) throw new Error("explorer unavailable");
      return { result: [] };
    });
    const failed = expect(cache.fetchAllDelegators("1", [DELEGATE])).rejects.toThrow();
    await failed;
    expect(readFileSync(file)).toEqual(before);
    expect(ranges.filter(from => from === 30_050_001)).toHaveLength(1);
    ranges.length = 0;
    state.logs.mockImplementation(async (_address, from) => { ranges.push(from); return { result: [] }; });
    await cache.fetchAllDelegators("1", [DELEGATE]);
    expect(ranges).toContain(30_000_001);
    const rows = await parquetReadObjects({ file: await asyncBufferFromFile(file) });
    expect(rows).toEqual([{ event: "EndBlock", user: "", spaceId: "", timestamp: 0n, blockNumber: 30_050_001n }]);
  });

  it("includes an event when the checkpoint is exactly one block behind the head", async () => {
    state.head = 30_000_001;
    state.logs.mockImplementation(async (_address, from, to, topics) => {
      expect([from, to]).toEqual([30_000_001, 30_000_001]);
      return { result: topics["0"] === keccak256(encodePacked(["string"], ["SetDelegate(address,bytes32,address)"])) ? [{
        topics: [topics["0"], pad(USER), formatBytes32String("sdcrv.eth"), pad(DELEGATE)],
        timeStamp: "100", blockNumber: "30000001",
      }] : [] };
    });
    await cache.fetchAllDelegators("1", [DELEGATE]);
    expect(await cache.processAllDelegators("sdcrv.eth", 100, DELEGATE)).toEqual([USER]);
    expect(await cache.processAllDelegators("sdcrv.eth", 99, DELEGATE)).toEqual([]);
  });

  it("rejects a missing Clear result even when the Set result is valid", async () => {
    const before = readFileSync(file);
    state.logs.mockResolvedValueOnce({ result: [] }).mockResolvedValue({});
    const failed = expect(cache.fetchAllDelegators("1", [DELEGATE])).rejects.toThrow();
    await failed;
    expect(readFileSync(file)).toEqual(before);
  });

  it("propagates corruption instead of overwriting it or returning no delegators", async () => {
    writeFileSync(file, "broken parquet");
    await expect(cache.fetchAllDelegators("1", [DELEGATE])).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe("broken parquet");
    await expect(cache.processAllDelegators("sdcrv.eth", 100, DELEGATE)).rejects.toThrow();
  });
});

describe("forwarder checkpoint integrity", () => {
  let forwarderFile: string;
  let forwarders: typeof import("../../utils/forwarderCacheUtils");
  beforeEach(async () => {
    forwarderFile = path.join(state.root, "forwarders", "1", `${DELEGATE}.parquet`);
    mkdirSync(path.dirname(forwarderFile), { recursive: true });
    const writer = await ParquetWriter.openFile(new ParquetSchema({
      event: { type: "UTF8" }, from: { type: "UTF8" }, to: { type: "UTF8" },
      start: { type: "INT64" }, expiration: { type: "INT64" },
      timestamp: { type: "INT64" }, blockNumber: { type: "INT64" },
    }), forwarderFile);
    await writer.appendRow({ event: "EndBlock", from: "", to: "", start: 0, expiration: 0, timestamp: 0, blockNumber: 30_000_000 });
    await writer.close();
    forwarders = await import("../../utils/forwarderCacheUtils");
  });

  it("includes registrations at the final block", async () => {
    state.head = 30_000_001;
    state.logs.mockImplementation(async (_address, from, to, topics) => ({ result:
      topics["2"] ? [{ topics: [topics["0"], pad(USER), pad(DELEGATE), pad("0x01")],
        timeStamp: "100", blockNumber: String(to) }] : [],
    }));
    await forwarders.fetchAllForwarders("1", DELEGATE);
    expect(await forwarders.processAllForwarders(100, DELEGATE)).toEqual([USER]);
  });

  it("keeps a corrupt file intact and rejects reads", async () => {
    writeFileSync(forwarderFile, "broken parquet");
    await expect(forwarders.fetchAllForwarders("1", DELEGATE)).rejects.toThrow();
    expect(readFileSync(forwarderFile, "utf8")).toBe("broken parquet");
    await expect(forwarders.processAllForwarders(100, DELEGATE)).rejects.toThrow();
  });

  it("does not checkpoint a missing result", async () => {
    const before = readFileSync(forwarderFile);
    state.logs.mockResolvedValue({});
    await expect(forwarders.fetchAllForwarders("1", DELEGATE)).rejects.toThrow();
    expect(readFileSync(forwarderFile)).toEqual(before);
  });
});
