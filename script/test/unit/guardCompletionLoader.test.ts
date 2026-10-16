import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { guardOf, inputPath, loadCompletion } from "../../reports/guardCompletion";
import { PROTOCOLS_TOKENS } from "../../utils/reportUtils";

const directory = mkdtempSync(path.join(tmpdir(), "guard-completion-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const TOKEN = "0xaaaa000000000000000000000000000000000000";
const SHA = "1".repeat(40);
const HASH = `0x${"2".repeat(64)}`;

function proof(protocol: string, extra: Record<string, unknown> = {}) {
  const epoch = 1790208000;
  return {
    schema: 1, chainId: 1, protocol, epoch, laneId: HASH, pipelineRun: null,
    checkRunId: "1", checkRunAttempt: "1", guardCommit: SHA, sourceCommit: SHA, sourceDigest: HASH,
    sources: {
      votemarket_v1: { path: `weekly-bounties/${epoch}/votemarket/claimed_bounties.json`, digest: HASH },
      votemarket_v2: { path: `weekly-bounties/${epoch}/votemarket-v2/claimed_bounties.json`, digest: HASH },
    },
    fromBlock: 100, checkedBlock: 200, checkedBlockHash: HASH, confirmations: 12,
    expected: { [TOKEN]: "100" }, sold: { [TOKEN]: "60" },
    nativeFunded: "0", nativeConverted: "0", sdProduced: "0", sdDelivered: "0",
    remaining: {}, delegated: {}, transactions: [],
    ...extra,
  };
}

function load(value: unknown, protocol?: string) {
  const file = path.join(directory, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(value));
  return loadCompletion(file, protocol);
}

describe("guard completion proofs", () => {
  it.each(["curve", "fxn"])("accepts %s completion with V2 claims and no V1 report", (protocol) => {
    const value = proof(protocol);
    const { votemarket_v1, ...sources } = value.sources;
    expect(load({ ...value, sources }, protocol).sources).toEqual(sources);
  });

  it.each(["curve", "fxn"])("still requires the %s V2 claim source", (protocol) => {
    const value = proof(protocol);
    const { votemarket_v2, ...sources } = value.sources;
    expect(() => load({ ...value, sources }, protocol)).toThrow("claim sources");
  });

  it("names the guard job, pipeline and strictness per protocol", () => {
    expect(guardOf("fxn")).toMatchObject({ job: "fxn-swaps", pipeline: "fxn-swaps-guard", strict: true, label: "FXN" });
    expect(guardOf("curve")).toMatchObject({ job: "crv-swaps", pipeline: "crv-swaps-guard", strict: false, label: "CURVE" });
    expect(inputPath("curve")).toBe("/tmp/crv-swaps-completion.input.json");
    expect(() => guardOf("balancer")).toThrow("No guard completion");
  });

  it("accepts a curve remainder the check explained, and carries its amounts", () => {
    const loaded = load(proof("curve", {
      remaining: { [TOKEN]: "40" },
      remainingReasons: { [TOKEN]: "parked: no quote" },
      carryIn: { [TOKEN]: "10" }, purged: {}, sdPulled: "5",
    }), "curve");
    expect(loaded.remaining).toEqual({ [TOKEN]: "40" });
    expect(loaded.sdPulled).toBe("5");
  });

  it("refuses a curve remainder without a reason", () => {
    expect(() => load(proof("curve", { remaining: { [TOKEN]: "40" } }))).toThrow("Unexplained CURVE remainder");
    expect(() => load(proof("curve", { remaining: { [TOKEN]: "0" }, remainingReasons: { [TOKEN]: "dust" } }))).toThrow("Unexplained CURVE remainder");
  });

  it("accepts fxn dust recorded by the custody check", () => {
    const alcx = "0xdbdb4d16eda451d0503b854cf79d55697f90c8df";
    const amount = "1408893513975616741";
    const loaded = load(proof("fxn", {
      remaining: { [alcx]: amount }, remainingReasons: { [alcx]: "dust" },
    }));
    expect(loaded.remaining).toEqual({ [alcx]: amount });
    expect(load(proof("fxn")).protocol).toBe("fxn");
  });

  it("accepts an illiquid fxn reward the guard explicitly parked", () => {
    const loaded = load(proof("fxn", {
      remaining: { [TOKEN]: "40" }, remainingReasons: { [TOKEN]: "parked: no executable route" },
    }));
    expect(loaded.remaining).toEqual({ [TOKEN]: "40" });
  });

  it.each(["parked", "parked: ", "held: bridge pending", "waits on Botmarket: not planned this epoch", undefined])("refuses fxn remainder with reason %s", (reason) => {
    expect(() => load(proof("fxn", {
      remaining: { [TOKEN]: "40" }, remainingReasons: { [TOKEN]: reason },
    }))).toThrow("FXN remainder");
  });

  it.each([PROTOCOLS_TOKENS.fxn.native, PROTOCOLS_TOKENS.fxn.sdToken])("refuses unsettled fxn output %s even when labelled dust", (token) => {
    const address = token.toLowerCase();
    expect(() => load(proof("fxn", {
      remaining: { [address]: "40" }, remainingReasons: { [address]: "dust" },
    }))).toThrow("FXN remainder");
  });

  it("binds the proof to the requested protocol", () => {
    expect(() => load(proof("curve"), "fxn")).toThrow("not for fxn");
    expect(() => load(proof("balancer"))).toThrow("not for a guarded protocol");
  });
});
