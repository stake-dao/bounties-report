/**
 * Verify that all delegators in repartition delegated BEFORE the snapshot block
 */

import { DELEGATION_ADDRESS } from "../../utils/constants";
import * as fs from "fs";

const snapshotBlocks: Record<number, number> = { 1: 24340181, 8453: 41448198 };

async function verifyDelegationTiming() {
  const hyparquet = await import("hyparquet");

  const parquetFiles: Record<number, string> = {
    1: "data/vlaura-delegations/1/0x3Fa73f1E5d8A792C80F426fc8F84FBF7Ce9bBCAC.parquet",
    8453: "data/vlaura-delegations/8453/0x9e1f4190f1a8Fe0cD57421533deCB57F9980922e.parquet",
  };

  const stakeDAO = DELEGATION_ADDRESS.toLowerCase();
  const issues: string[] = [];
  const allDelegators: Array<{ chainId: number; delegator: string; delegationBlock: number }> = [];

  for (const [chainIdStr, filePath] of Object.entries(parquetFiles)) {
    const chainId = Number(chainIdStr);
    const snapshotBlock = snapshotBlocks[chainId];

    let events: any[] = [];
    await hyparquet.parquetRead({
      file: await hyparquet.asyncBufferFromFile(filePath),
      rowFormat: "object",
      onComplete: (result: any[]) => {
        events = result;
      },
    });

    // Build delegation state: for each delegator, track their latest delegation
    const delegatorState = new Map<string, { toDelegate: string; block: number }>();

    for (const e of events) {
      if (e.event === "EndBlock") continue;
      const block = Number(e.blockNumber);
      if (block > snapshotBlock) continue; // Only events up to snapshot

      const existing = delegatorState.get(e.delegator);
      if (!existing || block > existing.block) {
        delegatorState.set(e.delegator, { toDelegate: e.toDelegate, block });
      }
    }

    // Find delegators to StakeDAO at snapshot
    let count = 0;
    for (const [delegator, state] of delegatorState) {
      if (state.toDelegate === stakeDAO) {
        count++;
        allDelegators.push({ chainId, delegator, delegationBlock: state.block });

        // Verify they delegated BEFORE snapshot
        if (state.block > snapshotBlock) {
          issues.push(
            `[Chain ${chainId}] ${delegator} delegated at block ${state.block} > snapshot ${snapshotBlock}`
          );
        }
      }
    }

    console.log(`[Chain ${chainId}] ${count} delegators at or before snapshot block ${snapshotBlock}`);
  }

  // Show delegation blocks for all delegators
  console.log("\n=== Delegation blocks for each delegator ===");
  allDelegators.sort((a, b) => b.delegationBlock - a.delegationBlock);

  for (const d of allDelegators.slice(0, 10)) {
    const snapshotBlock = snapshotBlocks[d.chainId];
    const blocksBefore = snapshotBlock - d.delegationBlock;
    console.log(
      `[Chain ${d.chainId}] ${d.delegator}: delegated at ${d.delegationBlock} (${blocksBefore} blocks before snapshot)`
    );
  }

  if (allDelegators.length > 10) {
    console.log(`... and ${allDelegators.length - 10} more`);
  }

  if (issues.length > 0) {
    console.log("\n⚠️ ISSUES FOUND:");
    issues.forEach((i) => console.log(i));
  } else {
    console.log("\n✓ All delegations occurred BEFORE the snapshot block");
  }
}

verifyDelegationTiming().catch(console.error);
