import { afterEach, beforeEach, expect, it, vi } from "vitest";

let explorer: ReturnType<(typeof import("../../utils/explorerUtils"))["createBlockchainExplorerUtils"]>;
let factory: (typeof import("../../utils/explorerUtils"))["createBlockchainExplorerUtils"];
let fetcher: ReturnType<typeof vi.fn>;
const logs = () => explorer.getLogsByAddressAndTopics("0x1234", 10, 20, {}, 1);
const response = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const ok = { status: "1", message: "OK", result: [{ blockNumber: "0xb", data: "0x42" }] };

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("EXPLORER_KEY", "private-test-key");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetcher = vi.fn().mockImplementation(async () => response(ok));
  vi.stubGlobal("fetch", fetcher);
  ({ createBlockchainExplorerUtils: factory } = await import("../../utils/explorerUtils"));
  explorer = factory();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("preserves logs and numeric block resolutions, including all chunk boundaries", async () => {
  const urls: URL[] = [];
  fetcher.mockImplementation(async (url) => {
    const parsed = new URL(url);
    urls.push(parsed);
    return response(parsed.searchParams.get("action") === "getblocknobytime" ? { status: "1", result: "12345" } : ok);
  });
  const single = logs();
  await vi.runAllTimersAsync();
  expect(await single).toEqual(ok);
  const many = explorer.getLogsByAddressesAndTopics(["A", "B"], 10, 10_010, {}, 56);
  await vi.runAllTimersAsync();
  expect(await many).toEqual({ result: Array(4).fill(ok.result[0]) });
  expect(urls.slice(1).map(u => [u.searchParams.get("address"), u.searchParams.get("fromBlock"), u.searchParams.get("toBlock")])).toEqual([
    ["A", "10", "10009"], ["A", "10010", "10010"], ["B", "10", "10009"], ["B", "10010", "10010"],
  ]);
  const topics = explorer.getLogsByTopics(10, 10_010, { "1": "0xbeef" }, 8453);
  await vi.runAllTimersAsync();
  expect(await topics).toEqual({ result: [ok.result[0], ok.result[0]] });
  const block = explorer.getBlockNumberByTimestamp(100, "before", 1);
  await vi.runAllTimersAsync();
  expect(await block).toBe(12345);
});

it("paces requests across factory instances without a burst", async () => {
  const starts: number[] = [];
  fetcher.mockImplementation(async () => { starts.push(Date.now()); return response(ok); });
  const pending = [logs(), factory().getLogsByTopics(1, 2, {}, 56), logs()];
  await vi.runAllTimersAsync();
  expect(await Promise.all(pending)).toEqual([ok, { result: ok.result }, ok]);
  expect(starts.slice(1).map((time, i) => time - starts[i])).toEqual([500, 500]);
});

it.each([
  ["HTTP 429", () => response({}, 429, { "Retry-After": "3" })],
  ["HTTP 503", () => response({}, 503)],
  ["API rate limit", () => response({ status: "0", message: "NOTOK", result: "Max rate limit reached" })],
  ["documented query timeout", () => response({ status: "0", message: "NOTOK", result: "Unexpected err, timeout occurred or server too busy. Please try again later" })],
])("retries %s and preserves the successful result", async (_name, failure) => {
  const starts: number[] = [];
  fetcher.mockImplementationOnce(async () => { starts.push(Date.now()); return failure(); })
    .mockImplementationOnce(async () => { starts.push(Date.now()); return response(ok); });
  const pending = logs();
  await vi.runAllTimersAsync();
  expect(await pending).toEqual(ok);
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(_name === "HTTP 429" ? 3000 : 1000);
});

it.each([
  { status: "0", message: "NOTOK", result: "Invalid API Key private-test-key" },
  { status: "0", message: "NOTOK", result: "Unsupported chainid" },
  { status: "0", message: "NOTOK", result: "Unknown failure" },
  { status: "1", message: "OK", result: "not an array" },
])("rejects permanent or malformed log responses without retrying: %j", async (body) => {
  fetcher.mockImplementation(async () => response(body));
  const pending = expect(logs()).rejects.toThrow();
  await vi.runAllTimersAsync();
  await pending;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([vi.mocked(console.warn).mock.calls, vi.mocked(console.error).mock.calls])).not.toContain("private-test-key");
});

it("allows documented empty logs but never treats missing blocks as empty logs", async () => {
  fetcher.mockImplementation(async () => response({ status: "0", message: "No records found", result: [] }));
  const empty = logs();
  await vi.runAllTimersAsync();
  expect(await empty).toEqual({ result: [] });
  const block = expect(explorer.getBlockNumberByTimestamp(100, "before", 1)).rejects.toThrow();
  await vi.runAllTimersAsync();
  await block;
});

it.each(["fetch", "body"])("bounds a stalled %s and removes the API key from thrown errors", async (stage) => {
  fetcher.mockImplementation(() => stage === "fetch" ? new Promise(() => {}) : Promise.resolve({
    ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => {}),
  }));
  const start = Date.now();
  let failure: Error | undefined;
  const pending = logs().catch(error => { failure = error; });
  await vi.runAllTimersAsync();
  await pending;
  expect(failure?.message).toMatch(/timeout|budget/i);
  expect(failure?.message).not.toContain("private-test-key");
  expect(Date.now() - start).toBeLessThanOrEqual(120_000);
  expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not sleep past its budget for Retry-After", async () => {
  fetcher.mockImplementation(async () => response({}, 429, { "Retry-After": "3600" }));
  const pending = expect(logs()).rejects.toThrow(/budget/i);
  await vi.runAllTimersAsync();
  await pending;
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("never starts a request whose queue budget has expired", async () => {
  let count = 0;
  fetcher.mockImplementation(async () => { count++; return response(ok); });
  const requests = Array.from({ length: 250 }, () => logs());
  const pending = Promise.allSettled(requests);
  await vi.runAllTimersAsync();
  const results = await pending;
  expect(results.filter(result => result.status === "rejected").length).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(240);
});
