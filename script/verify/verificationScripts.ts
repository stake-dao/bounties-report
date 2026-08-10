import type { Target } from "./invariants/cli";

export type Protocol = "vlCVX" | "bounties" | "spectra" | "frax" | "all";
export type InvariantTarget = Target;

interface VerifyScript {
  label: string;
  path: string;
  /** Return extra CLI args given the week timestamp. */
  args: (timestamp: number, invariantTarget: InvariantTarget) => string[];
  protocols: Protocol[];
  note?: string;
  /** Deterministic gate: non-zero exit fails the whole verification
   *  immediately and models are never queried (fail fast, no LLM cost). */
  gate?: boolean;
}

export interface VerifyScriptCommand {
  label: string;
  path: string;
  args: string[];
  note?: string;
  gate?: boolean;
}

const SCRIPTS: VerifyScript[] = [
  // ── vlCVX ───────────────────────────────────────────────────
  {
    // Runs FIRST: exact BigInt invariants vs on-chain state (ENG-2055).
    label: "vlCVX Deterministic Invariants",
    path: "script/verify/invariantsVerify.ts",
    args: (ts, target) => ["--timestamp", String(ts), "--target", target],
    protocols: ["vlCVX", "all"],
    gate: true,
  },
  {
    label: "vlCVX Distribution Verification",
    path: "script/vlCVX/verify/distribution.ts",
    args: (ts) => ["--timestamp", String(ts)],
    protocols: ["vlCVX", "all"],
  },
  {
    // Gate: on the Tuesday delegators run its forwarders check enforces
    // weeklyAdd > 0 — a zero addition must halt the pipeline, not reach the
    // models (2026-08-04: judges voted past it citing the Thursday exemption).
    // Safe on Thursday runs: the check self-skips while the delegators merkle
    // for the period does not exist yet.
    label: "vlCVX Reward Flow Verification",
    path: "script/vlCVX/verify/rewardFlow.ts",
    args: (ts) => ["--timestamp", String(ts)],
    protocols: ["vlCVX", "all"],
    gate: true,
  },
  {
    // Gate: aggregate + per-address reconciliation of the Tuesday delegators
    // merkle against on-chain sCRVUSD and the split breakdown. Since ENG-2105
    // the week's delta is "received - withheld + carried in", so this is also
    // what stops a Votium half from being paid twice or not at all. Self-skips
    // on Thursday runs, where no delegators merkle exists yet.
    label: "vlCVX Delegators Pot Reconciliation",
    path: "script/vlCVX/verify/verifyForwardersMerkle.ts",
    args: (ts) => ["--timestamp", String(ts)],
    protocols: ["vlCVX", "all"],
    gate: true,
  },
  {
    label: "vlCVX Claims Completeness",
    path: "script/vlCVX/verify/claimsCompleteness.ts",
    args: (ts) => ["--timestamp", String(ts)],
    protocols: ["vlCVX", "all"],
  },
  {
    // Post-cutover gate: file-only coherence of repartition_delegation
    // (per-delegate pool conservation, routed totals, membership sets across
    // chain files, curve/fxn same epoch). Deterministic, no RPC.
    label: "vlCVX delegation artifact",
    path: "script/vlCVX/verify/verifyDelegators.ts",
    args: (ts) => ["--timestamp", String(ts), "--gauge-type", "all"],
    protocols: ["vlCVX", "all"],
    gate: true,
  },
  {
    // Post-cutover gate: epoch-pinned on-chain recomputation — delegate-set
    // completeness, per-delegate delegator enumeration (exact vs
    // GaugeDelegation accounting), contributing weights at the vote,
    // wei-exact split and Votium-registry grouping vs the artifact.
    label: "vlCVX RPC delegators",
    path: "script/vlCVX/verify/delegators-rpc.ts",
    args: (ts) => ["--timestamp", String(ts), "--gauge-type", "all"],
    protocols: ["vlCVX", "all"],
    gate: true,
  },
  // ── bounties report ─────────────────────────────────────────
  {
    label: "Bounties Report Verification",
    path: "script/verify/verifyBountiesReport.ts",
    args: (ts) => ["--epoch", String(ts)],
    protocols: ["bounties", "all"],
  },
  // ── spectra ─────────────────────────────────────────────────
  {
    label: "sdSPECTRA Distribution Verification",
    path: "script/verify/verifySpectraDistribution.ts",
    args: (ts) => ["--timestamp", String(ts)],
    protocols: ["spectra", "all"],
  },
  // ── frax (sdFXS — frax slice of the bounties report only) ────
  {
    label: "Frax Bounties Verification",
    path: "script/verify/verifyBountiesReport.ts",
    args: (ts) => ["--epoch", String(ts), "--only", "frax"],
    protocols: ["frax"],
  },
];

const MAX_GATE_DIAGNOSTIC_LENGTH = 64 * 1024;
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

export function buildScriptCommands(
  timestamp: number,
  protocol: Protocol,
  invariantTarget: InvariantTarget = "both"
): VerifyScriptCommand[] {
  return SCRIPTS
    .filter((s) => s.protocols.includes(protocol))
    .map((s) => ({
      label: s.label,
      path: s.path,
      args: s.args(timestamp, invariantTarget),
      note: s.note,
      gate: s.gate,
    }));
}

export function sanitizeGateDiagnostic(output: string): string {
  let sanitized = output;
  for (const [name, value] of Object.entries(process.env)) {
    if (!SECRET_ENV_NAME.test(name) || !value || value.length < 8) continue;
    sanitized = sanitized.split(value).join("[REDACTED]");
    const encoded = encodeURIComponent(value);
    if (encoded !== value) {
      sanitized = sanitized.split(encoded).join("[REDACTED]");
    }
  }

  if (sanitized.length <= MAX_GATE_DIAGNOSTIC_LENGTH) return sanitized;
  const omitted = sanitized.length - MAX_GATE_DIAGNOSTIC_LENGTH;
  return `[${omitted} earlier characters truncated]\n${sanitized.slice(-MAX_GATE_DIAGNOSTIC_LENGTH)}`;
}
