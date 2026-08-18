/**
 * Unit tests for baseline resolution: exact root-match provenance, the
 * `.superseded.json` sibling used while a committed restatement's root is not
 * yet accepted on-chain, and the fail-closed path when nothing matches.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { computeRoot, toPairMap } from "../../verify/invariants/artifact";
import { resolveBaseline } from "../../verify/invariants/baseline";
import { ArtifactSpec, Violation } from "../../verify/invariants/types";

const ACCT = getAddress("0x1111000000000000000000000000000000000011");
const OTHER = getAddress("0x2222000000000000000000000000000000000022");
const CRV = getAddress("0xD533a949740bb3306d119CC777fa900bA034cd52");

const EPOCH = 1786579200;
const SPEC: ArtifactSpec = {
  target: "voters",
  chainId: 1,
  distributor: "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db",
  relPath: path.join("vlCVX", "vlcvx_merkle.json"),
};

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write a MerkleData file and return its recomputed root. */
function writeTree(relPath: string, entries: [string, string, string][]): string {
  const claims: Record<string, { tokens: Record<string, { amount: string }> }> = {};
  for (const [account, token, amount] of entries) {
    claims[account] ??= { tokens: {} };
    claims[account].tokens[token] = { amount };
  }
  const data = { merkleRoot: "", claims };
  const file = path.join(root, String(EPOCH), relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return computeRoot(toPairMap(data as any)).toLowerCase();
}

const clientFor = (activeRoot: string) =>
  ({ readContract: async () => activeRoot }) as any;

const resolve = async (activeRoot: string) => {
  const violations: Violation[] = [];
  const res = await resolveBaseline(SPEC, clientFor(activeRoot), EPOCH, root, violations, 1n);
  return { res, violations };
};

describe("resolveBaseline", () => {
  it("resolves the primary artifact when it matches the active root", async () => {
    const primary = writeTree(SPEC.relPath, [[ACCT, CRV, "100"]]);
    writeTree(path.join("vlCVX", "vlcvx_merkle.superseded.json"), [[OTHER, CRV, "7"]]);
    const { res, violations } = await resolve(primary);
    expect(violations).toEqual([]);
    expect(res.artifactPath).toBe(path.join(root, String(EPOCH), SPEC.relPath));
    expect(res.pairs.get(ACCT)?.get(CRV)).toBe(100n);
  });

  it("falls back to the .superseded.json sibling when the primary was restated", async () => {
    writeTree(SPEC.relPath, [[ACCT, CRV, "100"], [OTHER, CRV, "40"]]); // restated
    const superseded = writeTree(
      path.join("vlCVX", "vlcvx_merkle.superseded.json"),
      [[ACCT, CRV, "100"], [ACCT, getAddress("0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B"), "5"]]
    );
    const { res, violations } = await resolve(superseded);
    expect(violations).toEqual([]);
    expect(res.artifactPath).toBe(
      path.join(root, String(EPOCH), "vlCVX", "vlcvx_merkle.superseded.json")
    );
    expect(res.pairs.get(ACCT)?.get(CRV)).toBe(100n);
  });

  it("fails closed when neither the primary nor the superseded sibling matches", async () => {
    writeTree(SPEC.relPath, [[ACCT, CRV, "100"]]);
    writeTree(path.join("vlCVX", "vlcvx_merkle.superseded.json"), [[OTHER, CRV, "7"]]);
    const { res, violations } = await resolve(
      "0x1111111111111111111111111111111111111111111111111111111111111111"
    );
    expect(res.artifactPath).toBeNull();
    expect(violations).toHaveLength(1);
    expect(violations[0].invariant).toBe("BASELINE_UNRESOLVED");
  });

  it("treats the zero root as a fresh distributor (empty baseline, no violation)", async () => {
    const { res, violations } = await resolve(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );
    expect(violations).toEqual([]);
    expect(res.artifactPath).toBeNull();
    expect(res.pairs.size).toBe(0);
  });
});
