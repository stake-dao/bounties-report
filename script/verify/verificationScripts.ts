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
    label: "vlCVX Reward Flow Verification",
    path: "script/vlCVX/verify/rewardFlow.ts",
    args: (ts) => ["--timestamp", String(ts)],
    protocols: ["vlCVX", "all"],
  },
  {
    label: "vlCVX Claims Completeness",
    path: "script/vlCVX/verify/claimsCompleteness.ts",
    args: (ts) => ["--timestamp", String(ts)],
    protocols: ["vlCVX", "all"],
  },
  {
    label: "vlCVX parquet delegators",
    path: "script/vlCVX/verify/verifyDelegators.ts",
    args: (ts) => ["--timestamp", String(ts), "--gauge-type", "all"],
    protocols: ["vlCVX", "all"],
  },
  {
    label: "vlCVX RPC delegators",
    path: "script/vlCVX/verify/delegators-rpc.ts",
    args: (ts) => ["--timestamp", String(ts), "--gauge-type", "all"],
    protocols: ["vlCVX", "all"],
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
