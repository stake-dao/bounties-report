/**
 * Snapshot Comparison Tests
 *
 * These tests compare the current bounties-reports output files against
 * the golden snapshot files captured before the refactor.
 *
 * The golden files are captured by running:
 *   pnpm tsx script/test/snapshots/captureSnapshots.ts
 *
 * These tests verify the critical invariant:
 *   "The refactoring MUST produce byte-for-byte identical outputs."
 *
 * Specifically:
 * - Merkle roots must be identical
 * - All JSON output files must be identical
 * - File paths in bounties-reports/ must not change
 */
import { describe, it, expect } from "vitest";
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

function getLatestSnapshotPeriod(): number | null {
  if (!fs.existsSync(SNAPSHOT_DIR)) return null;
  const entries = fs
    .readdirSync(SNAPSHOT_DIR)
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .sort((a, b) => b - a);
  return entries.length > 0 ? entries[0] : null;
}

function loadManifest(period: number): SnapshotManifest | null {
  const manifestPath = path.join(
    SNAPSHOT_DIR,
    period.toString(),
    "manifest.json"
  );
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
}

// Only run if golden snapshots exist
const snapshotPeriod = getLatestSnapshotPeriod();
const manifest = snapshotPeriod !== null ? loadManifest(snapshotPeriod) : null;

describe.skipIf(snapshotPeriod === null)(
  "Snapshot comparison against golden files",
  () => {
    const period = snapshotPeriod!;

    it("manifest should exist and be valid", () => {
      expect(manifest).not.toBeNull();
      expect(manifest!.period).toBe(period);
      expect(manifest!.files.length).toBeGreaterThan(0);
    });

    if (manifest) {
      for (const file of manifest.files) {
        describe(`${file.relativePath}`, () => {
          const currentPath = path.join(
            BOUNTIES_DIR,
            period.toString(),
            file.relativePath
          );
          const goldenPath = path.join(
            SNAPSHOT_DIR,
            period.toString(),
            file.relativePath
          );

          it("should exist in bounties-reports/", () => {
            expect(fs.existsSync(currentPath)).toBe(true);
          });

          it("should have identical SHA-256 hash", () => {
            if (!fs.existsSync(currentPath)) return;

            const currentContent = fs.readFileSync(currentPath, "utf-8");
            const currentHash = sha256(currentContent);
            expect(currentHash).toBe(file.sha256);
          });

          it("should have identical file size", () => {
            if (!fs.existsSync(currentPath)) return;

            const currentContent = fs.readFileSync(currentPath, "utf-8");
            expect(Buffer.byteLength(currentContent)).toBe(file.sizeBytes);
          });

          // For merkle files, verify merkle root specifically
          if (file.relativePath.includes("merkle")) {
            it("should have identical merkle root", () => {
              if (!fs.existsSync(currentPath) || !fs.existsSync(goldenPath))
                return;

              const currentData = JSON.parse(
                fs.readFileSync(currentPath, "utf-8")
              );
              const goldenData = JSON.parse(
                fs.readFileSync(goldenPath, "utf-8")
              );

              if (currentData.merkleRoot && goldenData.merkleRoot) {
                expect(currentData.merkleRoot).toBe(goldenData.merkleRoot);
              }
            });
          }

          // For repartition files, verify distribution structure
          if (file.relativePath.includes("repartition")) {
            it("should have identical distribution keys", () => {
              if (!fs.existsSync(currentPath) || !fs.existsSync(goldenPath))
                return;

              const currentData = JSON.parse(
                fs.readFileSync(currentPath, "utf-8")
              );
              const goldenData = JSON.parse(
                fs.readFileSync(goldenPath, "utf-8")
              );

              if (currentData.distribution && goldenData.distribution) {
                expect(
                  Object.keys(currentData.distribution).sort()
                ).toEqual(Object.keys(goldenData.distribution).sort());
              }
            });
          }
        });
      }
    }
  }
);

/**
 * Structural integrity tests.
 * These run regardless of whether golden files exist.
 * They verify the output directory structure is valid.
 */
describe("Output structure integrity", () => {
  // Find the latest period
  const periods = fs.existsSync(BOUNTIES_DIR)
    ? fs
        .readdirSync(BOUNTIES_DIR)
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number)
        .sort((a, b) => b - a)
    : [];

  const latestPeriod = periods[0];

  it.skipIf(!latestPeriod)(
    "vlAURA directory should exist for latest period",
    () => {
      const dir = path.join(BOUNTIES_DIR, latestPeriod.toString(), "vlAURA");
      expect(fs.existsSync(dir)).toBe(true);
    }
  );

  it.skipIf(!latestPeriod)(
    "vlCVX directory should exist for latest period",
    () => {
      const dir = path.join(BOUNTIES_DIR, latestPeriod.toString(), "vlCVX");
      expect(fs.existsSync(dir)).toBe(true);
    }
  );

  it.skipIf(!latestPeriod)(
    "merkle files should contain valid JSON with merkleRoot field",
    () => {
      const merkleFiles = [
        path.join(
          BOUNTIES_DIR,
          latestPeriod.toString(),
          "vlAURA/vlaura_merkle.json"
        ),
        path.join(
          BOUNTIES_DIR,
          latestPeriod.toString(),
          "vlCVX/vlcvx_merkle.json"
        ),
      ];

      for (const filePath of merkleFiles) {
        if (fs.existsSync(filePath)) {
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          expect(data.merkleRoot).toBeDefined();
          expect(data.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
          expect(data.claims).toBeDefined();
          expect(typeof data.claims).toBe("object");
        }
      }
    }
  );

  it.skipIf(!latestPeriod)(
    "repartition files should contain valid JSON with distribution field",
    () => {
      const repartitionFiles = [
        path.join(
          BOUNTIES_DIR,
          latestPeriod.toString(),
          "vlAURA/repartition.json"
        ),
        path.join(
          BOUNTIES_DIR,
          latestPeriod.toString(),
          "vlCVX/curve/repartition.json"
        ),
      ];

      for (const filePath of repartitionFiles) {
        if (fs.existsSync(filePath)) {
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          expect(data.distribution).toBeDefined();
          expect(typeof data.distribution).toBe("object");

          // Each entry should have tokens
          for (const [address, entry] of Object.entries(data.distribution)) {
            expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
            expect((entry as any).tokens).toBeDefined();
          }
        }
      }
    }
  );
});
