import { MerkleData } from "../../interfaces/MerkleData";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM";

export type InvariantId =
  | "STRUCT_JSON_DUPLICATE_KEY"
  | "STRUCT_BAD_ADDRESS"
  | "STRUCT_BAD_AMOUNT"
  | "STRUCT_DUPLICATE_PAIR"
  | "STRUCT_BAD_PROOF"
  | "STRUCT_ROOT_MISMATCH"
  | "STRUCT_PROOF_INVALID"
  | "BASELINE_UNRESOLVED"
  | "PRESERVE_AMOUNT_REDUCED"
  | "PRESERVE_PAIR_REMOVED"
  | "PRESERVE_BELOW_CLAIMED"
  | "EXCL_DELTA_OVERLAP"
  | "EXCL_ADDR_DELTA_OVERLAP"
  | "RESTATEMENT_CREDITS_INVALID";

export interface Violation {
  invariant: InvariantId;
  severity: Severity;
  target: TargetLabel;
  chainId: number;
  /** What the violation is about: an (account, token) pair, a file, a root… */
  subject: string;
  detail: string;
  /** Quantified shortfall in base units, when the invariant has one (used for waiver capping). */
  deficit?: bigint;
}

export type TargetLabel = "voters" | "delegators";

/** One (chainId, distributor, artifact path) unit the invariants run against. */
export interface ArtifactSpec {
  target: TargetLabel;
  chainId: number;
  distributor: `0x${string}`;
  /** Path relative to `bounties-reports/{timestamp}/` */
  relPath: string;
}

/** Normalized cumulative claims: checksummed account -> checksummed token -> amount. */
export type PairMap = Map<string, Map<string, bigint>>;

export interface LoadedArtifact {
  spec: ArtifactSpec;
  absPath: string;
  raw: MerkleData;
  /** Normalized (account, token) -> cumulative amount view of `raw.claims`. */
  pairs: PairMap;
  declaredRoot: string;
  computedRoot: string;
}

export interface BaselineResolution {
  spec: ArtifactSpec;
  /** Active on-chain root at the pinned block. */
  activeRoot: string;
  pinnedBlock: bigint;
  /** Artifact whose recomputed root matches `activeRoot`; null when unresolved. */
  artifactPath: string | null;
  /** Empty when activeRoot is the zero root (fresh distributor). */
  pairs: PairMap;
}

export interface InvariantReport {
  timestamp: number;
  generatedAt: string;
  pinnedBlocks: Record<string, string>;
  violations: Violation[];
  /** Per-artifact summary for the attestation groundwork (Phase 2). */
  artifacts: {
    target: TargetLabel;
    chainId: number;
    distributor: string;
    path: string;
    declaredRoot: string;
    computedRoot: string;
    baselineRoot: string | null;
    baselineArtifact: string | null;
  }[];
}
