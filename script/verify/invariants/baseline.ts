import fs from "fs";
import path from "path";
import { PublicClient } from "viem";
import { MerkleData } from "../../interfaces/MerkleData";
import { WEEK } from "../../utils/constants";
import { computeRoot, toPairMap, ZERO_ROOT } from "./artifact";
import { ArtifactSpec, BaselineResolution, Violation } from "./types";

const URD_ABI = [
  {
    name: "root",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const MAX_WEEKS_BACK = 26;

/**
 * Resolve the baseline for an artifact: read the ACTIVE on-chain root at a
 * pinned block, then find the historical artifact whose recomputed root
 * matches it. Comparing against "last week's file" is not sound — that file
 * may have been revoked, patched or never accepted. Fails closed: if the
 * active root cannot be matched to a known artifact, a CRITICAL violation is
 * emitted and the caller must not proceed.
 */
export async function resolveBaseline(
  spec: ArtifactSpec,
  client: PublicClient,
  currentTimestamp: number,
  reportsRoot: string,
  violations: Violation[],
  /** One block per chain for the whole run — pinned by the caller so all
   * artifacts on a chain are checked against a single consistent snapshot. */
  pinnedBlock: bigint
): Promise<BaselineResolution> {
  const activeRoot = (
    await client.readContract({
      address: spec.distributor,
      abi: URD_ABI,
      functionName: "root",
      blockNumber: pinnedBlock,
    })
  ).toLowerCase();

  const resolution: BaselineResolution = {
    spec,
    activeRoot,
    pinnedBlock,
    artifactPath: null,
    pairs: new Map(),
  };

  // Fresh distributor: nothing distributed yet, the empty baseline is valid.
  if (activeRoot === ZERO_ROOT) return resolution;

  // A restatement rewrites an epoch's artifact in place; while its root is
  // not yet accepted on-chain, the active root's tree is preserved next to it
  // as `<name>.superseded.json`. Still exact-match provenance: a superseded
  // candidate only ever resolves if it recomputes to the active root, which
  // binds its full content.
  const supersededRelPath = spec.relPath.replace(/\.json$/, ".superseded.json");

  for (let weeksBack = 0; weeksBack <= MAX_WEEKS_BACK; weeksBack++) {
    const ts = currentTimestamp - weeksBack * WEEK;
    for (const relPath of [spec.relPath, supersededRelPath]) {
      const candidate = path.join(reportsRoot, String(ts), relPath);
      if (!fs.existsSync(candidate)) continue;
      try {
        const data: MerkleData = JSON.parse(fs.readFileSync(candidate, "utf8"));
        const pairs = toPairMap(data);
        if (computeRoot(pairs).toLowerCase() === activeRoot) {
          resolution.artifactPath = candidate;
          resolution.pairs = pairs;
          return resolution;
        }
      } catch {
        // Unreadable candidates are simply not a match; provenance failure is
        // reported below if nothing matches.
      }
    }
  }

  violations.push({
    invariant: "BASELINE_UNRESOLVED",
    severity: "CRITICAL",
    target: spec.target,
    chainId: spec.chainId,
    subject: `${spec.distributor} root=${activeRoot} block=${pinnedBlock}`,
    detail:
      `no artifact under ${reportsRoot}/*/${spec.relPath} (nor a .superseded.json sibling) ` +
      "recomputes to the active on-chain root; baseline provenance cannot be established — failing closed",
  });
  return resolution;
}
