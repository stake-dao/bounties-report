import fs from "fs";
import path from "path";
import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  isHex,
  keccak256,
} from "viem";
import MerkleTree from "merkletreejs";
import { MerkleData } from "../../interfaces/MerkleData";
import { parseJsonRejectingDuplicates } from "./jsonSafe";
import {
  ArtifactSpec,
  LoadedArtifact,
  PairMap,
  Violation,
} from "./types";

export const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** URD leaf: keccak256(keccak256(abi.encode(account, reward, amount))). */
export function computeLeaf(
  account: `0x${string}`,
  token: `0x${string}`,
  amount: bigint
): `0x${string}` {
  return keccak256(
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint256" }],
        [account, token, amount]
      )
    )
  );
}

/** Recompute the root exactly like script/shared/merkle/generateMerkleTree.ts. */
export function computeRoot(pairs: PairMap): string {
  const leaves: string[] = [];
  for (const [account, tokens] of pairs) {
    for (const [token, amount] of tokens) {
      leaves.push(
        computeLeaf(account as `0x${string}`, token as `0x${string}`, amount)
      );
    }
  }
  if (leaves.length === 0) return ZERO_ROOT;
  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  return tree.getHexRoot();
}

/** Normalize MerkleData claims into a (account -> token -> amount) map. */
export function toPairMap(
  data: MerkleData,
  onViolation?: (v: Omit<Violation, "target" | "chainId">) => void
): PairMap {
  const pairs: PairMap = new Map();
  for (const [rawAccount, claim] of Object.entries(data.claims ?? {})) {
    if (!isAddress(rawAccount, { strict: false })) {
      onViolation?.({
        invariant: "STRUCT_BAD_ADDRESS",
        severity: "CRITICAL",
        subject: rawAccount,
        detail: "claim account is not a valid address",
      });
      continue;
    }
    const account = getAddress(rawAccount);
    for (const [rawToken, tokenClaim] of Object.entries(claim?.tokens ?? {})) {
      if (!isAddress(rawToken, { strict: false })) {
        onViolation?.({
          invariant: "STRUCT_BAD_ADDRESS",
          severity: "CRITICAL",
          subject: `${account} / ${rawToken}`,
          detail: "reward token is not a valid address",
        });
        continue;
      }
      const token = getAddress(rawToken);
      const rawAmount = (tokenClaim as { amount?: string })?.amount;
      if (
        typeof rawAmount !== "string" ||
        !/^[0-9]+$/.test(rawAmount) ||
        BigInt(rawAmount) === 0n
      ) {
        onViolation?.({
          invariant: "STRUCT_BAD_AMOUNT",
          severity: "CRITICAL",
          subject: `${account} / ${token}`,
          detail: `amount must be a positive base-10 integer string, got: ${String(rawAmount)}`,
        });
        continue;
      }
      let tokens = pairs.get(account);
      if (!tokens) {
        tokens = new Map();
        pairs.set(account, tokens);
      }
      if (tokens.has(token)) {
        onViolation?.({
          invariant: "STRUCT_DUPLICATE_PAIR",
          severity: "CRITICAL",
          subject: `${account} / ${token}`,
          detail: "duplicate (account, token) pair after address normalization",
        });
        continue;
      }
      tokens.set(token, BigInt(rawAmount));
    }
  }
  return pairs;
}

/**
 * Load an artifact and run all local structural invariants:
 * duplicate JSON keys, address/amount syntax, duplicate pairs, per-leaf proof
 * validity against the declared root, and full root recomputation.
 */
export function loadArtifact(
  spec: ArtifactSpec,
  absPath: string,
  violations: Violation[]
): LoadedArtifact | null {
  const tag = { target: spec.target, chainId: spec.chainId };
  if (!fs.existsSync(absPath)) {
    violations.push({
      invariant: "BASELINE_UNRESOLVED",
      severity: "CRITICAL",
      ...tag,
      subject: absPath,
      detail: "artifact file does not exist",
    });
    return null;
  }
  const text = fs.readFileSync(absPath, "utf8");
  const { value: raw, duplicates } = parseJsonRejectingDuplicates<MerkleData>(text);
  for (const dup of duplicates) {
    violations.push({
      invariant: "STRUCT_JSON_DUPLICATE_KEY",
      severity: "CRITICAL",
      ...tag,
      subject: `${dup.path} :: "${dup.key}"`,
      detail: `duplicate JSON key in ${absPath} — JSON.parse silently drops one of the entries`,
    });
  }

  const pairs = toPairMap(raw, (v) => violations.push({ ...v, ...tag }));

  const declaredRoot = (raw.merkleRoot ?? "").toLowerCase();
  if (!isHex(raw.merkleRoot ?? "") || declaredRoot === ZERO_ROOT) {
    violations.push({
      invariant: "STRUCT_ROOT_MISMATCH",
      severity: "CRITICAL",
      ...tag,
      subject: absPath,
      detail: `declared merkleRoot is missing or zero: ${String(raw.merkleRoot)}`,
    });
  }

  const computedRoot = computeRoot(pairs).toLowerCase();
  if (declaredRoot && computedRoot !== declaredRoot) {
    violations.push({
      invariant: "STRUCT_ROOT_MISMATCH",
      severity: "CRITICAL",
      ...tag,
      subject: absPath,
      detail: `recomputed root ${computedRoot} != declared root ${declaredRoot}`,
    });
  }

  // Verify every embedded proof against the declared root. A wrong proof does
  // not change the root but produces an unclaimable leaf for that user.
  const treeLeaves: `0x${string}`[] = [];
  for (const [account, tokens] of pairs) {
    for (const [token, amount] of tokens) {
      treeLeaves.push(
        computeLeaf(account as `0x${string}`, token as `0x${string}`, amount)
      );
    }
  }
  const tree = new MerkleTree(treeLeaves, keccak256, { sortPairs: true });
  for (const [account, claim] of Object.entries(raw.claims ?? {})) {
    if (!isAddress(account, { strict: false })) continue;
    const normAccount = getAddress(account);
    for (const [token, tokenClaim] of Object.entries(claim?.tokens ?? {})) {
      if (!isAddress(token, { strict: false })) continue;
      const normToken = getAddress(token);
      const amount = pairs.get(normAccount)?.get(normToken);
      if (amount === undefined) continue;
      const proof = (tokenClaim as { proof?: string[] })?.proof;
      if (!Array.isArray(proof) || proof.some((p) => !isHex(p) || p.length !== 66)) {
        violations.push({
          invariant: "STRUCT_BAD_PROOF",
          severity: "CRITICAL",
          ...tag,
          subject: `${normAccount} / ${normToken}`,
          detail: "proof is missing or contains non-bytes32 entries",
        });
        continue;
      }
      const leaf = computeLeaf(normAccount, normToken, amount);
      if (!tree.verify(proof, leaf, raw.merkleRoot)) {
        violations.push({
          invariant: "STRUCT_PROOF_INVALID",
          severity: "CRITICAL",
          ...tag,
          subject: `${normAccount} / ${normToken}`,
          detail: "embedded proof does not verify against the declared root (leaf unclaimable)",
        });
      }
    }
  }

  return { spec, absPath, raw, pairs, declaredRoot, computedRoot };
}

/**
 * Pairs of the most recent ARCHIVED artifact strictly before `timestamp`
 * (weekly scan, oldest useful fallback 12 weeks). Used as the cross-tree
 * delta baseline when the active-root baseline resolves to the artifact
 * under verification itself: once a tree is published its delta vs the
 * active root reads zero, which would silence the voters∩delegators
 * exclusivity checks for whichever tree published first. An empty result
 * (fresh distributor) makes the full cumulative the delta, which is then
 * genuinely this round's additions.
 */
export function loadArchivedPairs(
  reportsRoot: string,
  timestamp: number,
  relPath: string,
  maxWeeksBack = 12
): { pairs: PairMap; foundAt: string | null } {
  const WEEK = 604800;
  for (let weeksBack = 1; weeksBack <= maxWeeksBack; weeksBack++) {
    const candidate = path.join(
      reportsRoot,
      String(timestamp - weeksBack * WEEK),
      relPath
    );
    if (!fs.existsSync(candidate)) continue;
    try {
      const data: MerkleData = JSON.parse(fs.readFileSync(candidate, "utf8"));
      return { pairs: toPairMap(data), foundAt: candidate };
    } catch {
      // A corrupt archive is not a baseline; keep scanning back.
    }
  }
  return { pairs: new Map(), foundAt: null };
}
