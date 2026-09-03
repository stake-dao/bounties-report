import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import {
  findMerkleMatchingRoot,
  findPreviousMerkle,
} from "../../utils/merkle/findPreviousMerkle";
import { canUseStandardGaugeMerge } from "../../utils/merkle/activeGaugeBaseline";

const WEEK = 604800;
const CURRENT = 1788393600;
const ACCOUNT = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const REL_PATH = path.join("vlCVX", "vlcvx_merkle_42161.json");

let reportsRoot: string;

beforeEach(() => {
  reportsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "previous-merkle-"));
});

afterEach(() => {
  fs.rmSync(reportsRoot, { recursive: true, force: true });
});

function writeMerkle(timestamp: number, amount: string, declaredRoot?: string) {
  const data = generateMerkleTree({ [ACCOUNT]: { [TOKEN]: amount } });
  if (declaredRoot) data.merkleRoot = declaredRoot;
  const filePath = path.join(reportsRoot, String(timestamp), REL_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
  return { data, filePath };
}

describe("findPreviousMerkle", () => {
  it("finds the newest artifact even after a gap longer than 12 weeks", () => {
    const old = writeMerkle(CURRENT - 37 * WEEK, "100");

    const result = findPreviousMerkle(CURRENT, REL_PATH, reportsRoot);

    expect(result.foundAt).toBe(old.filePath);
    expect(result.data.merkleRoot).toBe(old.data.merkleRoot);
  });

  it("skips newer unaccepted artifacts and resolves the recomputed active root", () => {
    const active = writeMerkle(CURRENT - 37 * WEEK, "100");
    writeMerkle(CURRENT - WEEK, "200");

    const result = findMerkleMatchingRoot(
      CURRENT,
      REL_PATH,
      active.data.merkleRoot,
      { reportsRoot }
    );

    expect(result.foundAt).toBe(active.filePath);
  });

  it("rejects a declared root that does not recompute from the file", () => {
    const active = writeMerkle(CURRENT - 37 * WEEK, "100");
    writeMerkle(CURRENT - WEEK, "200", active.data.merkleRoot);

    const result = findMerkleMatchingRoot(
      CURRENT,
      REL_PATH,
      active.data.merkleRoot,
      { reportsRoot }
    );

    expect(result.foundAt).toBe(active.filePath);
  });
});

describe("canUseStandardGaugeMerge", () => {
  const activeRoot = `0x${"1".repeat(64)}`;
  const matchingGaugeBase = {
    merkleRoot: activeRoot,
    claims: {},
  };

  it("allows a continuous per-gauge baseline matching the active root", () => {
    expect(
      canUseStandardGaugeMerge(
        CURRENT,
        CURRENT - WEEK,
        activeRoot,
        matchingGaugeBase
      )
    ).toBe(true);
  });

  it("rejects an old matching tree after a distribution gap", () => {
    expect(
      canUseStandardGaugeMerge(
        CURRENT,
        CURRENT - 37 * WEEK,
        activeRoot,
        matchingGaugeBase
      )
    ).toBe(false);
  });

  it("rejects last week's divergent per-gauge tree after recovery", () => {
    expect(
      canUseStandardGaugeMerge(CURRENT, CURRENT - WEEK, activeRoot, {
        merkleRoot: `0x${"2".repeat(64)}`,
        claims: {},
      })
    ).toBe(false);
  });
});
