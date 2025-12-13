/**
 * Verify vlCVX Delegator Computation
 *
 * This script verifies that the delegator computation for vlCVX distribution is correct.
 * It checks:
 * 1. Parquet file is up-to-date (EndBlock covers proposal period)
 * 2. All active delegators at snapshot are accounted for
 * 3. Delegators who voted directly are correctly excluded from delegation
 * 4. All delegators in file have non-zero VP
 * 5. No delegators with VP > 0 are missing from file
 *
 * Usage:
 *   pnpm tsx script/vlCVX/verify/verifyDelegators.ts [--timestamp <timestamp>] [--gauge-type <curve|fxn>]
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import axios from "axios";
import { formatBytes32String } from "ethers/lib/utils";
import {
  CVX_SPACE,
  WEEK,
  DELEGATION_ADDRESS,
} from "../../utils/constants";
import {
  fetchLastProposalsIds,
  getProposal,
  getVoters,
} from "../../utils/snapshot";
import { getClient } from "../../utils/getClients";

dotenv.config();

// Types
interface DelegatorEvent {
  event: string;
  user: string;
  spaceId: string;
  timestamp: number;
  blockNumber: number;
}

interface VerificationResult {
  timestamp: number;
  gaugeType: string;
  isValid: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    parquetEndBlock: number;
    snapshotBlock: number;
    snapshotTimestamp: number;
    parquetActiveDelegators: number;
    delegatorsWhoVoted: number;
    delegatorsWithZeroVP: number;
    expectedInFile: number;
    actualInFile: number;
    forwarders: number;
    nonForwarders: number;
    missingWithVP: number;
    extraInFile: number;
  };
  details: {
    delegatorsWhoVoted: Array<{ address: string; vp: number; hasRewards: boolean }>;
    missingDelegatorsWithVP: Array<{ address: string; vp: number }>;
  };
}

// Read parquet file using hyparquet (same as cacheUtils.ts)
async function readParquetFile(filePath: string): Promise<DelegatorEvent[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const hyparquet = await import("hyparquet");

    let data: DelegatorEvent[] = [];
    await hyparquet.parquetRead({
      file: await (hyparquet as any).asyncBufferFromFile(filePath),
      rowFormat: "object",
      onComplete: (result: any[]) => {
        data = result as DelegatorEvent[];
      },
    });
    return data;
  } catch (error) {
    console.error(`Error reading Parquet file ${filePath}:`, error);
    return [];
  }
}

// Get active delegators from parquet at a specific timestamp
async function getActiveDelegatorsFromParquet(
  space: string,
  snapshotTimestamp: number,
  delegationAddress: string
): Promise<{ delegators: Set<string>; endBlock: number }> {
  const SPACE_TO_CHAIN_ID: Record<string, string> = {
    "cvx.eth": "1",
    "cvx_fxn.eth": "1",
  };

  const chainId = SPACE_TO_CHAIN_ID[space] || "1";
  const filePath = path.join(
    __dirname,
    `../../../data/delegations/${chainId}/${delegationAddress}.parquet`
  );

  const data = await readParquetFile(filePath);
  if (data.length === 0) {
    throw new Error(`No data found in parquet file: ${filePath}`);
  }

  // Get EndBlock marker
  const endBlockEntry = data.find((d) => d.event === "EndBlock");
  const endBlock = endBlockEntry ? Number(endBlockEntry.blockNumber) : 0;

  // Filter by space and timestamp
  const spaceBytes32 = formatBytes32String(space).toLowerCase();
  const filtered = data.filter(
    (d) =>
      d.spaceId.toLowerCase() === spaceBytes32 &&
      d.timestamp <= snapshotTimestamp &&
      d.event !== "EndBlock"
  );

  // Group events by user
  const userEvents: Record<string, string[]> = {};
  for (const entry of filtered) {
    const user = entry.user.toLowerCase();
    if (!userEvents[user]) {
      userEvents[user] = [];
    }
    userEvents[user].push(entry.event);
  }

  // Keep only users whose last event is "Set"
  const activeDelegators = new Set<string>();
  for (const [user, events] of Object.entries(userEvents)) {
    if (events[events.length - 1] === "Set") {
      activeDelegators.add(user);
    }
  }

  return { delegators: activeDelegators, endBlock };
}

// Get voting power for addresses using Snapshot API
async function getVotingPowerBatch(
  proposal: any,
  addresses: string[]
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};

  if (addresses.length === 0) {
    return result;
  }

  // Process in batches of 150
  const BATCH_SIZE = 150;
  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE);

    try {
      const { data } = await axios.post<any>(
        "https://score.snapshot.org/api/scores",
        {
          params: {
            network: "1",
            snapshot: parseInt(proposal.snapshot),
            strategies: proposal.strategies,
            space: proposal.space.id,
            addresses: batch,
          },
        }
      );

      if (data?.result?.scores) {
        for (const score of data.result.scores) {
          for (const [address, scoreValue] of Object.entries(score)) {
            const normalizedAddress = address.toLowerCase();
            result[normalizedAddress] =
              (result[normalizedAddress] || 0) + (scoreValue as number);
          }
        }
      }
    } catch (error) {
      console.error(`Error fetching VP for batch starting at ${i}:`, error);
    }
  }

  return result;
}

// Main verification function
async function verifyDelegators(
  timestamp: number,
  gaugeType: "curve" | "fxn"
): Promise<VerificationResult> {
  const result: VerificationResult = {
    timestamp,
    gaugeType,
    isValid: true,
    errors: [],
    warnings: [],
    summary: {
      parquetEndBlock: 0,
      snapshotBlock: 0,
      snapshotTimestamp: 0,
      parquetActiveDelegators: 0,
      delegatorsWhoVoted: 0,
      delegatorsWithZeroVP: 0,
      expectedInFile: 0,
      actualInFile: 0,
      forwarders: 0,
      nonForwarders: 0,
      missingWithVP: 0,
      extraInFile: 0,
    },
    details: {
      delegatorsWhoVoted: [],
      missingDelegatorsWithVP: [],
    },
  };

  const space = CVX_SPACE;

  // 1. Get proposal
  console.log("Fetching proposal...");
  const filter =
    gaugeType === "fxn"
      ? "^FXN.*Gauge Weight for Week of"
      : "^(?!FXN ).*Gauge Weight for Week of";

  const proposalIdPerSpace = await fetchLastProposalsIds(
    [space],
    timestamp + WEEK,
    filter
  );
  const proposalId = proposalIdPerSpace[space];

  if (!proposalId) {
    result.errors.push(`No proposal found for ${gaugeType} gauge type`);
    result.isValid = false;
    return result;
  }

  const proposal = await getProposal(proposalId);
  console.log(`Proposal: ${proposal.title}`);
  console.log(`Proposal ID: ${proposalId}`);

  // Get snapshot block timestamp
  const publicClient = await getClient(1);
  const block = await (publicClient as any).getBlock({
    blockNumber: BigInt(proposal.snapshot),
  });
  const snapshotTimestamp = Number(block.timestamp);

  result.summary.snapshotBlock = parseInt(proposal.snapshot);
  result.summary.snapshotTimestamp = snapshotTimestamp;

  // 2. Get active delegators from parquet
  console.log("Reading parquet file...");
  const { delegators: parquetDelegators, endBlock } =
    await getActiveDelegatorsFromParquet(
      space,
      snapshotTimestamp,
      DELEGATION_ADDRESS
    );

  result.summary.parquetEndBlock = endBlock;
  result.summary.parquetActiveDelegators = parquetDelegators.size;

  // Check if parquet is up-to-date
  if (endBlock < parseInt(proposal.snapshot)) {
    result.errors.push(
      `Parquet file is outdated: EndBlock ${endBlock} < Snapshot block ${proposal.snapshot}`
    );
    result.isValid = false;
  }

  // 3. Get all voters from Snapshot
  console.log("Fetching voters...");
  const votes = await getVoters(proposalId);
  const voterAddresses = new Set(votes.map((v) => v.voter.toLowerCase()));

  // Check if delegation address voted
  const delegationAddressVoted = voterAddresses.has(
    DELEGATION_ADDRESS.toLowerCase()
  );
  if (!delegationAddressVoted) {
    result.warnings.push(
      "Delegation address did not vote - no delegation distribution expected"
    );
  }

  // 4. Find delegators who voted directly
  const delegatorsWhoVoted = new Set<string>();
  for (const delegator of parquetDelegators) {
    if (
      voterAddresses.has(delegator) &&
      delegator !== DELEGATION_ADDRESS.toLowerCase()
    ) {
      delegatorsWhoVoted.add(delegator);
    }
  }
  result.summary.delegatorsWhoVoted = delegatorsWhoVoted.size;

  // For each delegator who voted, record their info
  for (const delegator of delegatorsWhoVoted) {
    const vote = votes.find((v) => v.voter.toLowerCase() === delegator);
    if (vote) {
      result.details.delegatorsWhoVoted.push({
        address: delegator,
        vp: vote.vp,
        hasRewards: true, // simplified - actual check would need gauge mapping
      });
    }
  }

  // 5. Load repartition files
  const dirPath = `bounties-reports/${timestamp}/vlCVX/${gaugeType}`;
  const delegationFilePath = path.join(
    __dirname,
    `../../../${dirPath}/repartition_delegation.json`
  );
  if (!fs.existsSync(delegationFilePath)) {
    result.errors.push(`Delegation file not found: ${delegationFilePath}`);
    result.isValid = false;
    return result;
  }

  const delegationData = JSON.parse(fs.readFileSync(delegationFilePath, "utf-8"));

  // Get delegators from file
  const fileForwarders = new Set(
    Object.keys(delegationData.distribution?.forwarders || {}).map((a) =>
      a.toLowerCase()
    )
  );
  const fileNonForwarders = new Set(
    Object.keys(delegationData.distribution?.nonForwarders || {}).map((a) =>
      a.toLowerCase()
    )
  );
  const fileDelegators = new Set([...fileForwarders, ...fileNonForwarders]);

  result.summary.forwarders = fileForwarders.size;
  result.summary.nonForwarders = fileNonForwarders.size;
  result.summary.actualInFile = fileDelegators.size;

  // 6. Calculate expected delegators
  // Expected = parquet - delegation_address - voted_directly
  const expectedDelegators = new Set<string>();
  for (const delegator of parquetDelegators) {
    if (
      delegator !== DELEGATION_ADDRESS.toLowerCase() &&
      !delegatorsWhoVoted.has(delegator)
    ) {
      expectedDelegators.add(delegator);
    }
  }

  // 7. Get VP for expected delegators to filter out zero VP
  console.log("Fetching voting power for delegators...");
  const vpResults = await getVotingPowerBatch(
    proposal,
    Array.from(expectedDelegators)
  );

  let zeroVPCount = 0;
  const expectedWithVP = new Set<string>();
  for (const delegator of expectedDelegators) {
    const vp = vpResults[delegator] || 0;
    if (vp > 0) {
      expectedWithVP.add(delegator);
    } else {
      zeroVPCount++;
    }
  }

  result.summary.delegatorsWithZeroVP = zeroVPCount;
  result.summary.expectedInFile = expectedWithVP.size;

  // 8. Find missing delegators (in expected but not in file)
  const missing = new Set<string>();
  for (const delegator of expectedWithVP) {
    if (!fileDelegators.has(delegator)) {
      missing.add(delegator);
    }
  }

  // 9. Find extra delegators (in file but not in expected)
  const extra = new Set<string>();
  for (const delegator of fileDelegators) {
    if (!expectedWithVP.has(delegator)) {
      extra.add(delegator);
    }
  }

  result.summary.extraInFile = extra.size;

  // 10. Check VP of missing delegators
  if (missing.size > 0) {
    const missingVP = await getVotingPowerBatch(proposal, Array.from(missing));
    for (const [addr, vp] of Object.entries(missingVP)) {
      if (vp > 0) {
        result.details.missingDelegatorsWithVP.push({ address: addr, vp });
      }
    }
    result.summary.missingWithVP = result.details.missingDelegatorsWithVP.length;
  }

  // 11. Validate results
  if (result.summary.missingWithVP > 0) {
    result.errors.push(
      `${result.summary.missingWithVP} delegators with VP > 0 are missing from file`
    );
    result.isValid = false;
  }

  if (result.summary.extraInFile > 0) {
    result.warnings.push(
      `${result.summary.extraInFile} extra delegators in file (not in parquet or have 0 VP)`
    );
  }

  if (result.summary.actualInFile !== result.summary.expectedInFile) {
    const diff = result.summary.actualInFile - result.summary.expectedInFile;
    if (Math.abs(diff) > 0 && result.summary.missingWithVP === 0) {
      // Difference is due to zero VP delegators, which is fine
      result.warnings.push(
        `Delegator count difference: ${result.summary.actualInFile} in file vs ${result.summary.expectedInFile} expected (diff: ${diff})`
      );
    }
  }

  // 12. Verify file delegators have non-zero VP
  console.log("Verifying file delegators have VP...");
  const fileVP = await getVotingPowerBatch(proposal, Array.from(fileDelegators));
  let zeroVPInFile = 0;
  for (const delegator of fileDelegators) {
    if ((fileVP[delegator] || 0) === 0) {
      zeroVPInFile++;
    }
  }

  if (zeroVPInFile > 0) {
    result.errors.push(
      `${zeroVPInFile} delegators in file have 0 VP (should not be in file)`
    );
    result.isValid = false;
  }

  return result;
}

// Print verification result
function printResult(result: VerificationResult): void {
  const date = new Date(result.timestamp * 1000).toISOString().split("T")[0];
  console.log(`\n${"=".repeat(70)}`);
  console.log(
    `vlCVX Delegator Verification: ${result.timestamp} (${date}) - ${result.gaugeType.toUpperCase()}`
  );
  console.log(`${"=".repeat(70)}`);

  console.log(`\nStatus: ${result.isValid ? "PASS" : "FAIL"}`);

  console.log(`\n--- Parquet Data ---`);
  console.log(`  EndBlock: ${result.summary.parquetEndBlock}`);
  console.log(`  Active delegators at snapshot: ${result.summary.parquetActiveDelegators}`);

  console.log(`\n--- Snapshot Data ---`);
  console.log(`  Snapshot block: ${result.summary.snapshotBlock}`);
  console.log(
    `  Snapshot timestamp: ${result.summary.snapshotTimestamp} (${new Date(result.summary.snapshotTimestamp * 1000).toISOString()})`
  );

  console.log(`\n--- Delegator Accounting ---`);
  console.log(`  1. Parquet active delegators: ${result.summary.parquetActiveDelegators}`);
  console.log(`  2. Minus delegation address:  -1`);
  console.log(`  3. Minus voted directly:      -${result.summary.delegatorsWhoVoted}`);
  console.log(`  4. Minus zero VP:             -${result.summary.delegatorsWithZeroVP}`);
  console.log(`  5. Expected in file:          ${result.summary.expectedInFile}`);

  console.log(`\n--- File Contents ---`);
  console.log(`  Forwarders: ${result.summary.forwarders}`);
  console.log(`  Non-forwarders: ${result.summary.nonForwarders}`);
  console.log(`  Total in file: ${result.summary.actualInFile}`);

  console.log(`\n--- Validation ---`);
  console.log(
    `  Missing with VP > 0: ${result.summary.missingWithVP} ${result.summary.missingWithVP === 0 ? "" : ""}`
  );
  console.log(`  Extra in file: ${result.summary.extraInFile}`);

  if (result.details.delegatorsWhoVoted.length > 0) {
    console.log(`\n--- Delegators Who Voted Directly (${result.details.delegatorsWhoVoted.length}) ---`);
    for (const d of result.details.delegatorsWhoVoted.slice(0, 10)) {
      console.log(`  ${d.address}: ${d.vp.toLocaleString()} VP`);
    }
    if (result.details.delegatorsWhoVoted.length > 10) {
      console.log(`  ... and ${result.details.delegatorsWhoVoted.length - 10} more`);
    }
  }

  if (result.details.missingDelegatorsWithVP.length > 0) {
    console.log(
      `\n--- MISSING Delegators with VP > 0 (${result.details.missingDelegatorsWithVP.length}) ---`
    );
    for (const d of result.details.missingDelegatorsWithVP) {
      console.log(`  ${d.address}: ${d.vp.toLocaleString()} VP`);
    }
  }

  if (result.errors.length > 0) {
    console.log(`\n--- Errors ---`);
    for (const error of result.errors) {
      console.log(`  ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log(`\n--- Warnings ---`);
    for (const warning of result.warnings) {
      console.log(`  ${warning}`);
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  if (result.isValid) {
    console.log(`RESULT: All delegators correctly accounted for`);
  } else {
    console.log(`RESULT: VERIFICATION FAILED - See errors above`);
  }
  console.log(`${"=".repeat(70)}\n`);
}

// Main
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let timestamp: number | undefined;
  let gaugeType: "curve" | "fxn" | "all" = "curve";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) {
      timestamp = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === "--gauge-type" && args[i + 1]) {
      gaugeType = args[i + 1] as "curve" | "fxn" | "all";
      i++;
    } else if (args[i] === "--help") {
      console.log(`
Usage: pnpm tsx script/vlCVX/verify/verifyDelegators.ts [options]

Options:
  --timestamp <ts>    Period timestamp (default: current period)
  --gauge-type <type> Gauge type: curve, fxn, or all (default: curve)
  --help              Show this help message

Examples:
  pnpm tsx script/vlCVX/verify/verifyDelegators.ts
  pnpm tsx script/vlCVX/verify/verifyDelegators.ts --gauge-type all
  pnpm tsx script/vlCVX/verify/verifyDelegators.ts --timestamp 1765411200 --gauge-type curve
`);
      process.exit(0);
    }
  }

  // Default to current period
  if (!timestamp) {
    const now = Math.floor(Date.now() / 1000);
    timestamp = Math.floor(now / WEEK) * WEEK;
  }

  const gaugeTypes: Array<"curve" | "fxn"> = gaugeType === "all" 
    ? ["curve", "fxn"] 
    : [gaugeType as "curve" | "fxn"];

  let allValid = true;

  for (const gt of gaugeTypes) {
    console.log(`\nVerifying vlCVX delegators for period ${timestamp}...`);
    console.log(`Gauge type: ${gt}\n`);

    try {
      const result = await verifyDelegators(timestamp, gt);
      printResult(result);

      if (!result.isValid) {
        allValid = false;
      }
    } catch (error) {
      console.error(`Verification failed for ${gt} with error:`, error);
      allValid = false;
    }
  }

  if (!allValid) {
    process.exit(1);
  }
}

main();
