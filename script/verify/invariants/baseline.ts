import { PublicClient } from "viem";
import { findMerkleMatchingRoot } from "../../utils/merkle/findPreviousMerkle";
import { toPairMap, ZERO_ROOT } from "./artifact";
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

  const baseline = findMerkleMatchingRoot(
    currentTimestamp,
    spec.relPath,
    activeRoot,
    { reportsRoot, includeCurrent: true }
  );
  if (baseline.foundAt) {
    resolution.artifactPath = baseline.foundAt;
    resolution.pairs = toPairMap(baseline.data);
    return resolution;
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
