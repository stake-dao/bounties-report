/**
 * Deterministic invariants gate for the vlCVX merkle distributions (ENG-2055).
 *
 * Phase 1 checks (local artifact + on-chain reads, no side effects):
 *   - structural: duplicate JSON keys, address/amount syntax, duplicate
 *     (account, token) pairs, per-leaf proof validity, full root recomputation;
 *   - baseline provenance: the ACTIVE on-chain root must be recomputable from
 *     a known historical artifact (fail closed otherwise);
 *   - cumulative preservation: union-pair current >= previous, removals only
 *     when fully claimed, proposed >= claimedOnChain;
 *   - delta-scoped voters/delegators exclusivity (same epoch, same token).
 *
 * Phase 2+ (separate PRs): conservation vs repartition inputs with explicit
 * dust ledger, attestation emission consumed by submit/accept jobs,
 * Anvil-fork exhaustive claim simulation, indexer-backed classification.
 *
 * Usage:
 *   pnpm tsx script/verify/invariantsVerify.ts [--timestamp N] [--target voters|delegators|both] [--json out.json]
 *
 * Exit code: 0 = all invariants hold, 1 = at least one violation (gate fails).
 */
import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";
dotenv.config();

import { getClient } from "../utils/getClients";
import { WEEK } from "../utils/constants";
import { loadArtifact } from "./invariants/artifact";
import { resolveBaseline } from "./invariants/baseline";
import {
  checkPreservation,
  fetchClaimed,
  unionPairKeys,
} from "./invariants/preservation";
import { checkDeltaExclusivity, positiveDeltas } from "./invariants/exclusivity";
import { applyWaivers, loadWaivers } from "./invariants/waivers";
import {
  ArtifactSpec,
  InvariantReport,
  PairMap,
  Violation,
} from "./invariants/types";

const REPORTS_ROOT = "bounties-reports";

const VLCVX_SPECS: ArtifactSpec[] = [
  {
    target: "delegators",
    chainId: 1,
    distributor: "0x17F513CDE031C8B1E878Bde1Cb020cE29f77f380",
    relPath: path.join("vlCVX", "merkle_data_delegators.json"),
  },
  {
    target: "voters",
    chainId: 1,
    distributor: "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db",
    relPath: path.join("vlCVX", "vlcvx_merkle.json"),
  },
  {
    target: "voters",
    chainId: 8453,
    distributor: "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db",
    relPath: path.join("vlCVX", "vlcvx_merkle_8453.json"),
  },
  {
    target: "voters",
    chainId: 42161,
    distributor: "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db",
    relPath: path.join("vlCVX", "vlcvx_merkle_42161.json"),
  },
];

/** Chains whose artifact may legitimately be absent for a given week. */
const OPTIONAL_CHAINS = new Set([8453, 42161]);

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const now = Math.floor(Date.now() / 1000);
  return {
    timestamp: parseInt(get("--timestamp") ?? String(Math.floor(now / WEEK) * WEEK), 10),
    target: (get("--target") ?? "both") as "voters" | "delegators" | "both",
    jsonOut: get("--json"),
  };
}

async function main() {
  const { timestamp, target, jsonOut } = parseArgs();
  const violations: Violation[] = [];
  const report: InvariantReport = {
    timestamp,
    generatedAt: new Date().toISOString(),
    pinnedBlocks: {},
    violations,
    artifacts: [],
  };

  console.log(`🔒 vlCVX invariants gate — epoch ${timestamp} (${new Date(timestamp * 1000).toISOString()})`);

  const specs = VLCVX_SPECS.filter(
    (s) => target === "both" || s.target === target
  );

  // Per-spec deltas kept for the cross-merkle exclusivity check on mainnet.
  const mainnetDeltas: Partial<Record<"voters" | "delegators", PairMap>> = {};

  for (const spec of specs) {
    const absPath = path.join(REPORTS_ROOT, String(timestamp), spec.relPath);
    const label = `${spec.target}@${spec.chainId}`;

    if (!fs.existsSync(absPath) && OPTIONAL_CHAINS.has(spec.chainId)) {
      console.log(`   ⏭️  ${label}: no artifact for this epoch (optional chain) — skipped`);
      continue;
    }

    console.log(`\n▶ ${label} — ${absPath}`);
    const artifact = loadArtifact(spec, absPath, violations);
    if (!artifact) continue;
    console.log(`   leaves: ${[...artifact.pairs.values()].reduce((n, t) => n + t.size, 0)} | declared root ${artifact.declaredRoot.slice(0, 10)}… | recomputed ${artifact.computedRoot === artifact.declaredRoot ? "✅ match" : "❌ MISMATCH"}`);

    const client = await getClient(spec.chainId);
    const baseline = await resolveBaseline(
      spec,
      client,
      timestamp,
      REPORTS_ROOT,
      violations
    );
    report.pinnedBlocks[`${spec.chainId}`] = baseline.pinnedBlock.toString();
    console.log(`   active root ${baseline.activeRoot.slice(0, 10)}… @ block ${baseline.pinnedBlock} → baseline ${baseline.artifactPath ?? "UNRESOLVED"}`);

    report.artifacts.push({
      target: spec.target,
      chainId: spec.chainId,
      distributor: spec.distributor,
      path: absPath,
      declaredRoot: artifact.declaredRoot,
      computedRoot: artifact.computedRoot,
      baselineRoot: baseline.activeRoot,
      baselineArtifact: baseline.artifactPath,
    });

    // Preservation runs even with an unresolved baseline (claimed() feed is
    // still meaningful) but the BASELINE_UNRESOLVED violation already fails
    // the gate in that case.
    const ctx = {
      target: spec.target,
      chainId: spec.chainId,
      distributor: spec.distributor,
      pinnedBlock: baseline.pinnedBlock,
    };
    const pairKeys = unionPairKeys(artifact.pairs, baseline.pairs);
    console.log(`   fetching claimed() for ${pairKeys.length} pairs…`);
    const claimed = await fetchClaimed(client, ctx, pairKeys);
    checkPreservation(ctx, artifact.pairs, baseline.pairs, claimed, violations);

    if (spec.chainId === 1) {
      mainnetDeltas[spec.target] = positiveDeltas(artifact.pairs, baseline.pairs);
    }
  }

  if (mainnetDeltas.voters && mainnetDeltas.delegators) {
    console.log(`\n▶ voters ∩ delegators delta-exclusivity (mainnet)`);
    checkDeltaExclusivity(
      1,
      mainnetDeltas.voters,
      mainnetDeltas.delegators,
      violations
    );
  } else if (target === "both") {
    console.log(
      "\n⚠️  exclusivity check skipped: need both mainnet artifacts in the same run"
    );
  }

  const waivers = loadWaivers(
    path.join("script", "verify", "invariants", "waivers.vlcvx.json")
  );
  const { active, waived } = applyWaivers(violations, waivers);
  report.violations = active;

  if (jsonOut) {
    fs.writeFileSync(
      jsonOut,
      JSON.stringify({ ...report, waived }, bigintReplacer, 2)
    );
    console.log(`\n📄 report written to ${jsonOut}`);
  }

  for (const { violation, waiver } of waived) {
    console.log(
      `   🟡 waived: ${violation.invariant} ${violation.target}@${violation.chainId} ${violation.subject}\n      ${waiver.reason}`
    );
  }

  if (active.length === 0) {
    console.log(`\n✅ all invariants hold${waived.length ? ` (${waived.length} known waiver(s) applied)` : ""}`);
    process.exit(0);
  }

  console.error(`\n❌ ${active.length} invariant violation(s):`);
  for (const v of active) {
    console.error(
      `   [${v.severity}] ${v.invariant} ${v.target}@${v.chainId} ${v.subject}\n      ${v.detail}`
    );
  }
  process.exit(1);
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

main().catch((err) => {
  // Any unexpected error fails closed: the gate must never pass by crashing.
  console.error("💥 invariants gate crashed (failing closed):", err);
  process.exit(1);
});
