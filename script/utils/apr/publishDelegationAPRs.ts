import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface APRUpdate {
  space: string; // e.g., "sdspectra.eth", "sdpendle.eth"
  apr: number;
  timestamp?: number; // when computed (defaults to now)
}

export interface StagedAPR {
  space: string;
  apr: number;
  computedAt: number;
}

export interface StageAPROptions {
  space: string;
  apr: number;
  periodTimestamp: number;
}

export interface PublishOptions {
  /**
   * If true, reads all staged APR files from {periodTimestamp}/staged_aprs/
   */
  fromStaging?: boolean;

  /**
   * The period timestamp directory to read staged files from
   */
  periodTimestamp?: number;

  /**
   * Specific spaces to publish (reads from their staged files)
   */
  spaces?: string[];

  /**
   * Spaces to exclude from publishing
   */
  exclude?: string[];

  /**
   * If true, writes the merged result to bounties-reports/latest/delegationsAPRs.json
   * If false, only writes to {periodTimestamp}/delegationsAPRs.json
   */
  writeToLatest?: boolean;
}

// ============================================================================
// Path Helpers
// ============================================================================

const BOUNTIES_REPORTS_DIR = path.join(process.cwd(), "bounties-reports");
const LATEST_DIR = path.join(BOUNTIES_REPORTS_DIR, "latest");
const LATEST_APR_FILE = path.join(LATEST_DIR, "delegationsAPRs.json");

function getStagedDir(periodTimestamp: number): string {
  return path.join(
    BOUNTIES_REPORTS_DIR,
    periodTimestamp.toString(),
    "staged_aprs"
  );
}

function getStagedFilePath(periodTimestamp: number, space: string): string {
  // Convert space to safe filename (e.g., "sdspectra.eth" -> "sdspectra.eth.json")
  return path.join(getStagedDir(periodTimestamp), `${space}.json`);
}

function getPeriodAPRFile(periodTimestamp: number): string {
  return path.join(
    BOUNTIES_REPORTS_DIR,
    periodTimestamp.toString(),
    "delegationsAPRs.json"
  );
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Stages an APR update to a staging file for later publishing.
 * Creates {periodTimestamp}/staged_aprs/{space}.json
 */
export async function stageAPR(options: StageAPROptions): Promise<void> {
  const { space, apr, periodTimestamp } = options;

  const stagedDir = getStagedDir(periodTimestamp);
  fs.mkdirSync(stagedDir, { recursive: true });

  const stagedData: StagedAPR = {
    space,
    apr,
    computedAt: Math.floor(Date.now() / 1000),
  };

  const filePath = getStagedFilePath(periodTimestamp, space);
  fs.writeFileSync(filePath, JSON.stringify(stagedData, null, 2));
  console.log(`Staged APR for ${space}: ${apr.toFixed(4)}% -> ${filePath}`);
}

/**
 * Reads all staged APR files from a period directory.
 */
function readStagedAPRs(periodTimestamp: number): StagedAPR[] {
  const stagedDir = getStagedDir(periodTimestamp);

  if (!fs.existsSync(stagedDir)) {
    return [];
  }

  const files = fs.readdirSync(stagedDir).filter((f) => f.endsWith(".json"));
  const staged: StagedAPR[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(stagedDir, file), "utf-8");
      const data = JSON.parse(content) as StagedAPR;
      staged.push(data);
    } catch (error) {
      console.warn(`Failed to read staged file ${file}:`, error);
    }
  }

  return staged;
}

/**
 * Reads a specific staged APR file.
 */
function readStagedAPR(
  periodTimestamp: number,
  space: string
): StagedAPR | null {
  const filePath = getStagedFilePath(periodTimestamp, space);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as StagedAPR;
  } catch {
    return null;
  }
}

/**
 * Reads the current delegationsAPRs.json from the latest directory.
 * Returns empty object if file doesn't exist.
 */
function readCurrentAPRs(): Record<string, number> {
  if (!fs.existsSync(LATEST_APR_FILE)) {
    return {};
  }

  try {
    const content = fs.readFileSync(LATEST_APR_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Writes APRs atomically by writing to a temp file then renaming.
 */
function writeAPRsAtomic(filePath: string, aprs: Record<string, number>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(aprs, null, 2));
  fs.renameSync(tempPath, filePath);
}

/**
 * Merges APR updates into existing APRs with preservation logic:
 * - Only overwrites if new APR > 0
 * - Preserves all keys not in updates
 */
function mergeAPRs(
  existing: Record<string, number>,
  updates: APRUpdate[]
): Record<string, number> {
  const merged = { ...existing };

  for (const update of updates) {
    // Only update if APR > 0 (preserve existing if update is 0 or negative)
    if (update.apr > 0) {
      merged[update.space] = update.apr;
    }
  }

  return merged;
}

/**
 * Main publish function that merges staged APRs into the destination file(s).
 */
export async function publishDelegationAPRs(
  options: PublishOptions
): Promise<void> {
  const { fromStaging, periodTimestamp, spaces, exclude = [], writeToLatest = false } = options;

  if (!periodTimestamp && fromStaging) {
    throw new Error("periodTimestamp is required when using fromStaging");
  }

  // Collect updates
  const updates: APRUpdate[] = [];

  if (fromStaging && periodTimestamp) {
    // Read all staged files
    const stagedAPRs = readStagedAPRs(periodTimestamp);

    for (const staged of stagedAPRs) {
      // Skip excluded spaces
      if (exclude.includes(staged.space)) {
        console.log(`Skipping excluded space: ${staged.space}`);
        continue;
      }
      updates.push({
        space: staged.space,
        apr: staged.apr,
        timestamp: staged.computedAt,
      });
    }
  } else if (spaces && periodTimestamp) {
    // Read specific staged files
    for (const space of spaces) {
      if (exclude.includes(space)) {
        console.log(`Skipping excluded space: ${space}`);
        continue;
      }

      const staged = readStagedAPR(periodTimestamp, space);
      if (staged) {
        updates.push({
          space: staged.space,
          apr: staged.apr,
          timestamp: staged.computedAt,
        });
      } else {
        console.warn(`No staged APR found for ${space}`);
      }
    }
  }

  if (updates.length === 0) {
    console.log("No APR updates to publish");
    return;
  }

  console.log(`Publishing ${updates.length} APR updates:`);
  for (const update of updates) {
    console.log(`  ${update.space}: ${update.apr.toFixed(4)}%`);
  }

  // Read current APRs from latest
  const currentAPRs = readCurrentAPRs();
  console.log(`Read ${Object.keys(currentAPRs).length} existing APRs from latest`);

  // Merge with preservation
  const mergedAPRs = mergeAPRs(currentAPRs, updates);

  // Write to period directory
  if (periodTimestamp) {
    const periodFile = getPeriodAPRFile(periodTimestamp);
    writeAPRsAtomic(periodFile, mergedAPRs);
    console.log(`Written to period file: ${periodFile}`);
  }

  // Write to latest if requested
  if (writeToLatest) {
    writeAPRsAtomic(LATEST_APR_FILE, mergedAPRs);
    console.log(`Written to latest: ${LATEST_APR_FILE}`);
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  // Parse CLI arguments
  const fromStaging = args.includes("--from-staging");
  const writeToLatest = args.includes("--write-latest");

  // Parse --space or --spaces argument
  const spaceIndex = args.findIndex((a) => a === "--space" || a === "--spaces");
  let spaces: string[] | undefined;
  if (spaceIndex !== -1 && args[spaceIndex + 1]) {
    spaces = args[spaceIndex + 1].split(",").map((s) => s.trim());
  }

  // Parse --exclude argument
  const excludeIndex = args.findIndex((a) => a === "--exclude");
  let exclude: string[] = [];
  if (excludeIndex !== -1 && args[excludeIndex + 1]) {
    exclude = args[excludeIndex + 1].split(",").map((s) => s.trim());
  }

  // Parse --period argument (defaults to current week)
  const WEEK = 604800;
  const now = Math.floor(Date.now() / 1000);
  const currentPeriod = Math.floor(now / WEEK) * WEEK;

  const periodIndex = args.findIndex((a) => a === "--period");
  let periodTimestamp: number = currentPeriod;
  if (periodIndex !== -1 && args[periodIndex + 1]) {
    periodTimestamp = Number.parseInt(args[periodIndex + 1], 10);
  }

  console.log("=== Delegation APR Publisher ===");
  console.log(`Period: ${periodTimestamp}`);
  console.log(`From staging: ${fromStaging}`);
  console.log(`Write to latest: ${writeToLatest}`);
  if (spaces) console.log(`Spaces: ${spaces.join(", ")}`);
  if (exclude.length > 0) console.log(`Exclude: ${exclude.join(", ")}`);
  console.log("");

  await publishDelegationAPRs({
    fromStaging,
    periodTimestamp,
    spaces,
    exclude,
    writeToLatest,
  });

  console.log("\nDone.");
}

// Run CLI if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
}
