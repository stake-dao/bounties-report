import fs from "fs";
import { getAddress } from "viem";
import { InvariantId, Violation } from "./types";

/**
 * Quantified, pair-specific waivers for KNOWN intentional exceptions
 * (e.g. over-claim recovery after a repaired distribution). Repo-controlled:
 * the file ships with the code and changes go through review, so a waiver
 * cannot be minted by the pipeline that produced the merkle.
 *
 * A waiver never blanket-disables an invariant: it binds one (invariant,
 * chain, target, account, token) tuple and caps the tolerated deficit. If the
 * measured deficit grows beyond `maxDeficit`, the violation fires again.
 */
export interface Waiver {
  invariant: InvariantId;
  chainId: number;
  target: "voters" | "delegators";
  account: string;
  token: string;
  /** Upper bound for the tolerated deficit (base units, decimal string). */
  maxDeficit: string;
  reason: string;
  addedBy: string;
  addedAt: string;
}

/** Structural and provenance invariants can never be waived. */
const NON_WAIVABLE: ReadonlySet<InvariantId> = new Set([
  "STRUCT_JSON_DUPLICATE_KEY",
  "STRUCT_BAD_ADDRESS",
  "STRUCT_BAD_AMOUNT",
  "STRUCT_DUPLICATE_PAIR",
  "STRUCT_BAD_PROOF",
  "STRUCT_ROOT_MISMATCH",
  "STRUCT_PROOF_INVALID",
  "BASELINE_UNRESOLVED",
] as InvariantId[]);

export function loadWaivers(path: string): Waiver[] {
  if (!fs.existsSync(path)) return [];
  const waivers: Waiver[] = JSON.parse(fs.readFileSync(path, "utf8"));
  return waivers.map((w) => ({
    ...w,
    account: getAddress(w.account),
    token: getAddress(w.token),
  }));
}

export interface WaiverSplit {
  active: Violation[];
  waived: { violation: Violation; waiver: Waiver }[];
}

/**
 * Split violations into still-active and waived. The measured deficit is
 * parsed from the violation's structured fields by the caller — here we only
 * match identity; quantitative capping is enforced via `deficit`.
 */
export function applyWaivers(
  violations: (Violation & { deficit?: bigint })[],
  waivers: Waiver[]
): WaiverSplit {
  const active: Violation[] = [];
  const waived: WaiverSplit["waived"] = [];

  for (const v of violations) {
    if (NON_WAIVABLE.has(v.invariant)) {
      active.push(v);
      continue;
    }
    const pair = v.subject.split(" / ");
    const match = waivers.find(
      (w) =>
        w.invariant === v.invariant &&
        w.chainId === v.chainId &&
        w.target === v.target &&
        pair.length === 2 &&
        getAddress(pair[0]) === w.account &&
        getAddress(pair[1]) === w.token &&
        (v.deficit === undefined || v.deficit <= BigInt(w.maxDeficit))
    );
    if (match) waived.push({ violation: v, waiver: match });
    else active.push(v);
  }
  return { active, waived };
}
