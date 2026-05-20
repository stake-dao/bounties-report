/**
 * sdSPECTRA distribution verification.
 *
 * Standalone re-run of the verification that generateUniversalMerkleSpectra.ts
 * performs inline, so aiVerify.ts can gate the spectra-bribes set-roots step.
 *
 * Usage:
 *   pnpm tsx script/verify/verifySpectraDistribution.ts [--timestamp WEEK]
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { MerkleData } from "../interfaces/MerkleData";
import { Distribution } from "../interfaces/Distribution";
import { findPreviousMerkle } from "../utils/merkle/findPreviousMerkle";
import { distributionVerifier } from "../utils/merkle/distributionVerifier";
import { getLastClosedProposals } from "../utils/snapshot";
import { SPECTRA_SPACE, WEEK } from "../utils/constants";
import { base } from "../utils/chains";

dotenv.config();

const SPECTRA_MERKLE_ADDRESS =
  "0x665d334388012d17f1d197de72b7b708ffccb67d" as `0x${string}`;
const REPORTS = path.join(__dirname, "../../bounties-reports");

function parseTimestamp(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) {
      return parseInt(args[i + 1], 10);
    }
  }
  return Math.floor(Date.now() / 1000 / WEEK) * WEEK;
}

function loadCurrentMerkle(epoch: number): MerkleData {
  for (const rel of ["sdTkns/sdtkns_merkle_8453.json", "spectra/merkle_data.json"]) {
    const p = path.join(REPORTS, String(epoch), rel);
    if (fs.existsSync(p)) {
      console.log(`Current merkle: ${rel}`);
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    }
  }
  throw new Error(`no sdSPECTRA merkle for week ${epoch} (sdTkns/ or spectra/)`);
}

function loadPreviousMerkle(epoch: number): { data: MerkleData; foundAt: string | null } {
  const primary = findPreviousMerkle(epoch, "sdTkns/sdtkns_merkle_8453.json");
  return primary.foundAt
    ? primary
    : findPreviousMerkle(epoch, "spectra/merkle_data.json");
}

async function main(): Promise<void> {
  const epoch = parseTimestamp(process.argv.slice(2));
  console.log(`sdSPECTRA distribution verification — week ${epoch}`);

  const repartitionPath = path.join(REPORTS, String(epoch), "spectra/repartition.json");
  if (!fs.existsSync(repartitionPath)) {
    console.error(`❌ distribution file missing: ${repartitionPath}`);
    process.exit(1);
  }
  const currentDistribution: { distribution: Distribution } = JSON.parse(
    fs.readFileSync(repartitionPath, "utf-8")
  );

  const currentMerkleData = loadCurrentMerkle(epoch);
  const { data: previousMerkleData, foundAt } = loadPreviousMerkle(epoch);
  console.log(foundAt ? `Previous merkle: ${foundAt}` : "No previous merkle found");

  // proposals[1]: bribes are claimed for the previous voting period, not the latest.
  const proposals = await getLastClosedProposals(SPECTRA_SPACE, 2);
  if (proposals.length < 2) {
    console.error(`❌ expected 2 closed ${SPECTRA_SPACE} proposals, got ${proposals.length}`);
    process.exit(1);
  }
  const proposalId = proposals[1].id;
  console.log(`Verifying against proposal: ${proposalId}\n`);

  const rows = await distributionVerifier(
    SPECTRA_SPACE,
    base,
    SPECTRA_MERKLE_ADDRESS,
    currentMerkleData,
    previousMerkleData,
    currentDistribution.distribution,
    proposalId,
    "8453"
  );

  // Every row's merkle delta (newAmount - prevAmount) must equal the amount
  // repartition.json assigned that address — anything else is a mis-built tree.
  const mismatches = rows.filter((r) => r.isError);
  if (mismatches.length > 0) {
    console.error(`\n❌ ${mismatches.length} of ${rows.length} rows do not reconcile:`);
    for (const m of mismatches) {
      console.error(
        `  ${m.address} ${m.symbol}: repartition=${m.distributionAmount} merkleDelta=${m.weekChange}`
      );
    }
    process.exit(1);
  }
  console.log(`\n✅ all ${rows.length} address/token rows reconcile with repartition.json`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
