import { describe, expect, it, vi } from "vitest";
import { compareSourceClaims, verifySourceClaims, readClaimLogs } from "../../sdTkns/verify/reportSources";

const claim = { chainId: 42161, bountyId: "1", gauge: "0x123", rewardToken: "0xabc", amount: "100", isWrapped: true };

describe("Independent source completeness", () => {
  it("accepts equal claim multisets regardless of ordering or address case", () => {
    expect(() => compareSourceClaims([claim, { ...claim, amount: "200" }], [{ ...claim, amount: "200" }, { ...claim, rewardToken: "0xABC" }])).not.toThrow();
  });
  it("rejects a missing claim even if reports were generated from that incomplete file", () => {
    expect(() => compareSourceClaims([], [claim])).toThrow(/missing from file/);
  });
  it("rejects a duplicated claim and preserves legitimate repeated campaign claims", () => {
    expect(() => compareSourceClaims([claim, claim], [claim])).toThrow(/extra in file/);
    expect(() => compareSourceClaims([claim, claim], [claim, claim])).not.toThrow();
  });
  it.each(["chainId", "gauge", "rewardToken", "amount", "isWrapped"])("rejects changed %s", (field) => {
    const changes = { chainId: 10, gauge: "0x456", rewardToken: "0xdef", amount: "99", isWrapped: false };
    expect(() => compareSourceClaims([claim], [{ ...claim, [field]: changes[field as keyof typeof changes] }])).toThrow(/mismatch/);
  });
  it("fails closed on RPC errors instead of treating them as zero claims", async () => {
    const client = { getBlockNumber: vi.fn().mockRejectedValue(new Error("RPC unavailable")) } as any;
    await expect(verifySourceClaims(1789603200, ["curve"], async () => client)).rejects.toThrow("RPC unavailable");
  });

  it.each(["Block range is too large", "eth_getLogs is limited to a 10,000 range", "ranges over 10000 blocks are not supported"])("reduces oversized ranges: %s", async (message) => {
    const blocks: bigint[] = [];
    const logs = await readClaimLogs(0n, 10n, async (from, to) => {
      if (to - from > 2n) throw new Error(message);
      for (let block = from; block <= to; block++) blocks.push(block);
      return [from];
    });
    expect(blocks).toEqual(Array.from({ length: 10 }, (_, index) => BigInt(index)));
    expect(logs.length).toBeGreaterThan(1);
    await expect(readClaimLogs(0n, 10n, async () => { throw new Error("RPC offline"); })).rejects.toThrow("RPC offline");
  });

  it("retries temporary rate limits without treating them as an empty page", async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn().mockRejectedValueOnce(new Error("over rate limit")).mockResolvedValue(["claim"]);
      const result = readClaimLogs(0n, 10n, read);
      await vi.runAllTimersAsync();
      expect(await result).toEqual(["claim"]);
      expect(read).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
