/**
 * vlCVX delegation artifact coherence gate (post on-chain cutover).
 *
 * File-only, deterministic, no RPC: validates that each protocol's
 * repartition_delegation.json (+ chain-split variants) is internally exact —
 * per-delegate pools conserve to the wei, routed totalPerGroup matches the
 * flattened legs (via the delegationExact accessors the payers run),
 * totalTokens equals the sum of per-delegate pools, top-level membership
 * sets agree across chain files and with the perDelegate sections — and that
 * Curve and FXN artifacts belong to the same vlCVX epoch.
 *
 * The on-chain counterpart (delegators-rpc.ts) recomputes the attribution
 * from epoch-pinned chain state; this gate only proves the artifact agrees
 * with itself.
 *
 * Usage:
 *   pnpm tsx script/vlCVX/verify/verifyDelegators.ts [--timestamp <ts>] [--gauge-type <curve|fxn|all>]
 *
 * Exit code: 0 = coherent, 1 = at least one violation.
 */

import * as path from "path";
import * as dotenv from "dotenv";
import { WEEK } from "../../utils/constants";
import {
  artifactCoherenceIssues,
  loadDelegationArtifacts,
} from "./delegatorsVerifyCore";

dotenv.config();

const main = (): void => {
  const args = process.argv.slice(2);
  let timestamp: number | undefined;
  let gaugeType: "curve" | "fxn" | "all" = "all";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) {
      timestamp = parseInt(args[++i]);
    } else if (args[i] === "--gauge-type" && args[i + 1]) {
      gaugeType = args[++i] as "curve" | "fxn" | "all";
    }
  }
  if (!timestamp) {
    timestamp = Math.floor(Math.floor(Date.now() / 1000) / WEEK) * WEEK;
  }

  const gaugeTypes: Array<"curve" | "fxn"> =
    gaugeType === "all" ? ["curve", "fxn"] : [gaugeType];

  console.log("=".repeat(70));
  console.log(`vlCVX Delegation Artifact Coherence — period ${timestamp}`);
  console.log("=".repeat(70));

  const allIssues: string[] = [];
  const epochs: Record<string, number | undefined> = {};

  for (const gt of gaugeTypes) {
    const dirAbs = path.join(
      __dirname,
      `../../../bounties-reports/${timestamp}/vlCVX/${gt}`
    );
    console.log(`\n--- ${gt.toUpperCase()} ---`);

    const files = loadDelegationArtifacts(dirAbs);
    if (files.length === 0) {
      // Legitimacy of a missing artifact (no delegate voter earned) is an
      // on-chain question — delegators-rpc.ts decides it.
      console.log(
        `⚠️  repartition_delegation.json absent — deferred to the on-chain leg`
      );
      continue;
    }

    const [main] = files;
    epochs[gt] = main.snapshotBlock;
    for (const f of files) {
      if (
        f.proposalId !== main.proposalId ||
        f.snapshotBlock !== main.snapshotBlock
      ) {
        allIssues.push(
          `${gt}: ${f.name} carries proposal ${f.proposalId}/epoch ${f.snapshotBlock}, ` +
            `main file has ${main.proposalId}/${main.snapshotBlock}`
        );
      }
    }

    const { issues, warnings } = artifactCoherenceIssues(files);

    const delegates = Object.keys(main.summary.perDelegate ?? {});
    const fwd = Object.keys(main.summary.forwarders ?? {}).length;
    const nonFwd = Object.keys(main.summary.nonForwarders ?? {}).length;
    const tokens = Object.keys(main.summary.totalTokens ?? {}).length;
    console.log(
      `proposal ${main.proposalId} (epoch ${main.snapshotBlock}) — ` +
        `${files.length} file(s), ${delegates.length} delegates, ` +
        `${fwd + nonFwd} wallets (${fwd} fwd / ${nonFwd} non-fwd), ${tokens} token(s)`
    );

    for (const w of warnings) console.log(`⚠️  ${w}`);
    if (issues.length === 0) {
      console.log(`✅ ${gt.toUpperCase()}: artifact coherent (wei-exact)`);
    } else {
      for (const issue of issues) console.log(`❌ ${issue}`);
      allIssues.push(...issues.map((i) => `${gt}: ${i}`));
    }
  }

  const definedEpochs = Object.entries(epochs).filter(
    ([, e]) => e !== undefined
  );
  if (
    definedEpochs.length === 2 &&
    definedEpochs[0][1] !== definedEpochs[1][1]
  ) {
    const msg = `curve epoch ${definedEpochs[0][1]} != fxn epoch ${definedEpochs[1][1]} — mixed rounds`;
    console.log(`\n❌ ${msg}`);
    allIssues.push(msg);
  }

  console.log("\n" + "=".repeat(70));
  if (allIssues.length === 0) {
    console.log("RESULT: delegation artifacts coherent");
  } else {
    console.log(`RESULT: FAILED — ${allIssues.length} violation(s)`);
    process.exitCode = 1;
  }
  console.log("=".repeat(70));
};

main();
