/**
 * Snapshot Capture Utility
 *
 * Run this BEFORE the refactor to capture golden output files.
 * After the refactor, run the snapshot comparison tests to verify
 * byte-for-byte identical outputs.
 *
 * Usage:
 *   pnpm tsx script/test/snapshots/captureSnapshots.ts [period]
 *
 * If no period is provided, uses the latest available period.
 *
 * This captures:
 * - vlAURA repartition.json files
 * - vlAURA repartition_delegation*.json files
 * - vlAURA vlaura_merkle*.json files
 * - vlCVX curve/fxn repartition.json files
 * - vlCVX curve/fxn repartition_delegation*.json files
 * - vlCVX curve/fxn merkle_data_non_delegators*.json files
 * - vlCVX vlcvx_merkle*.json files
 * - vlCVX merkle_data_delegators.json
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

const BOUNTIES_DIR = path.resolve("bounties-reports");
const SNAPSHOT_DIR = path.resolve("script/test/snapshots/golden");

interface SnapshotManifest {
  capturedAt: string;
  period: number;
  files: {
    relativePath: string;
    sha256: string;
    sizeBytes: number;
  }[];
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function findLatestPeriod(): number {
  const entries = fs
    .readdirSync(BOUNTIES_DIR)
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .sort((a, b) => b - a);

  if (entries.length === 0) {
    throw new Error("No period directories found in bounties-reports/");
  }
  return entries[0];
}

function captureFiles(period: number): void {
  const periodDir = path.join(BOUNTIES_DIR, period.toString());
  if (!fs.existsSync(periodDir)) {
    throw new Error(`Period directory not found: ${periodDir}`);
  }

  const outputDir = path.join(SNAPSHOT_DIR, period.toString());
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const manifest: SnapshotManifest = {
    capturedAt: new Date().toISOString(),
    period,
    files: [],
  };

  // Define file patterns to capture
  const filesToCapture = [
    // vlAURA
    "vlAURA/repartition.json",
    "vlAURA/repartition_42161.json",
    "vlAURA/repartition_8453.json",
    "vlAURA/repartition_delegation.json",
    "vlAURA/repartition_delegation_42161.json",
    "vlAURA/repartition_delegation_8453.json",
    "vlAURA/vlaura_merkle.json",
    "vlAURA/vlaura_merkle_42161.json",
    "vlAURA/vlaura_merkle_8453.json",
    "vlAURA/APRs.json",
    // vlCVX
    "vlCVX/curve/repartition.json",
    "vlCVX/curve/repartition_8453.json",
    "vlCVX/curve/repartition_delegation.json",
    "vlCVX/curve/repartition_delegation_8453.json",
    "vlCVX/curve/merkle_data_non_delegators.json",
    "vlCVX/curve/merkle_data_non_delegators_8453.json",
    "vlCVX/fxn/repartition.json",
    "vlCVX/fxn/repartition_delegation.json",
    "vlCVX/fxn/merkle_data_non_delegators.json",
    "vlCVX/vlcvx_merkle.json",
    "vlCVX/vlcvx_merkle_8453.json",
    "vlCVX/merkle_data_delegators.json",
    "vlCVX/APRs.json",
  ];

  let capturedCount = 0;
  let skippedCount = 0;

  for (const relPath of filesToCapture) {
    const srcPath = path.join(periodDir, relPath);
    if (!fs.existsSync(srcPath)) {
      console.log(`  SKIP (not found): ${relPath}`);
      skippedCount++;
      continue;
    }

    const content = fs.readFileSync(srcPath, "utf-8");
    const destDir = path.join(outputDir, path.dirname(relPath));
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const destPath = path.join(outputDir, relPath);
    fs.writeFileSync(destPath, content);

    manifest.files.push({
      relativePath: relPath,
      sha256: sha256(content),
      sizeBytes: Buffer.byteLength(content),
    });

    capturedCount++;
    console.log(`  OK: ${relPath} (${Buffer.byteLength(content)} bytes)`);
  }

  // Write manifest
  const manifestPath = path.join(outputDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\nDone! Captured ${capturedCount} files, skipped ${skippedCount}.`);
  console.log(`Golden files saved to: ${outputDir}`);
  console.log(`Manifest saved to: ${manifestPath}`);
}

// Main
const periodArg = process.argv[2];
const period = periodArg ? parseInt(periodArg) : findLatestPeriod();

console.log(`Capturing snapshots for period ${period}...`);
captureFiles(period);
