import { getAddress } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { formatAddress } from "./address";
import fs from "fs";
import path from "path";
import {
  hasPerDelegateAttribution,
  getExactGroupAmounts,
} from "./delegationExact";

interface DelegationRepartition {
  distribution: {
    totalTokens: Record<string, string>;
    totalPerGroup: Record<string, { forwarders: string; nonForwarders: string }>;
    totalForwardersShare: string;
    totalNonForwardersShare: string;
    forwarders: Record<string, string>;
    nonForwarders: Record<string, string>;
    perDelegate?: Record<string, any>;
  };
}

// Helper to normalize token addresses for comparison
const normalizeTokenMapping = (tokens: Record<string, any>): Record<string, any> => {
  const normalized: Record<string, any> = {};
  for (const [token, value] of Object.entries(tokens)) {
    try {
      normalized[getAddress(token)] = value;
    } catch {
      normalized[token.toLowerCase()] = value;
    }
  }
  return normalized;
};

interface NonDelegatorsRepartition {
  distribution: Record<string, { tokens: Record<string, string> }>;
}

const weekChangeOf = (
  currentMerkleData: MerkleData,
  previousMerkleData: MerkleData,
  address: string,
  token: string
): bigint | null => {
  const merkleTokenAmount =
    currentMerkleData.claims[address]?.tokens[token]?.amount;
  if (!merkleTokenAmount) return null;
  const previousAmount =
    previousMerkleData.claims[address]?.tokens[token]?.amount || "0";
  return BigInt(merkleTokenAmount) - BigInt(previousAmount);
};

export const verifyVlCVXDistribution = async (
  currentPeriodTimestamp: number,
  gaugeType: "curve" | "fxn",
  currentMerkleData: MerkleData,
  previousMerkleData: MerkleData,
  log: (message: string) => void,
  merkleType: "forwarders" | "combined" = "combined"
) => {
  log("\n=== vlCVX Distribution Verification ===");
  log(`Gauge Type: ${gaugeType.toUpperCase()}`);
  log(`Period: ${currentPeriodTimestamp} (${new Date(currentPeriodTimestamp * 1000).toUTCString()})`);
  log(`Merkle Type: ${merkleType}`);

  // Read delegation repartition file
  const delegationPath = path.join(
    process.cwd(),
    `bounties-reports/${currentPeriodTimestamp}/vlCVX/${gaugeType}/repartition_delegation.json`
  );

  // Read non-delegators repartition file
  const nonDelegatorsPath = path.join(
    process.cwd(),
    `bounties-reports/${currentPeriodTimestamp}/vlCVX/${gaugeType}/repartition.json`
  );

  if (!fs.existsSync(delegationPath) || !fs.existsSync(nonDelegatorsPath)) {
    log(`⚠️  Warning: Missing repartition files for ${gaugeType}`);
    return;
  }

  const delegationData: DelegationRepartition = JSON.parse(
    fs.readFileSync(delegationPath, "utf-8")
  );
  const nonDelegatorsData: NonDelegatorsRepartition = JSON.parse(
    fs.readFileSync(nonDelegatorsPath, "utf-8")
  );

  // Extract data from files and normalize token addresses
  const { forwarders, nonForwarders } = delegationData.distribution;
  const totalPerGroup = normalizeTokenMapping(delegationData.distribution.totalPerGroup);
  const nonDelegators = nonDelegatorsData.distribution;
  // Files written before the on-chain cutover carry no perDelegate section:
  // their per-wallet delegation amounts cannot be recomputed here, so those
  // checks are skipped (historical periods only — the writer always emits it).
  const hasAttribution = hasPerDelegateAttribution(delegationData.distribution);

  log("\n=== User Categories ===");
  log(`Forwarders (Votium): ${Object.keys(forwarders).length} addresses`);
  log(`Non-Forwarder Delegators: ${Object.keys(nonForwarders).length} addresses`);
  log(`Direct Voters (Non-Delegators): ${Object.keys(nonDelegators).length} addresses`);
  log(`Total Unique Addresses: ${Object.keys(forwarders).length + Object.keys(nonForwarders).length + Object.keys(nonDelegators).length}`);

  // Verify each group against merkle data
  const errors: string[] = [];
  const warnings: string[] = [];

  // For combined merkle, we verify non-forwarders + direct voters.
  // For the forwarders (sCRVUSD) merkle, per-address checking runs against
  // the split-breakdown artifact — see below.

  if (merkleType === "forwarders") {
    const breakdownPath = path.join(
      process.cwd(),
      `bounties-reports/${currentPeriodTimestamp}/vlCVX/delegators_split_breakdown.json`
    );
    const payoutsPath = path.join(
      process.cwd(),
      `bounties-reports/${currentPeriodTimestamp}/vlCVX/votium_forwarder_payouts.json`
    );
    if (fs.existsSync(breakdownPath)) {
      log("\n=== Verifying Forwarders (exact split breakdown) ===");
      const breakdown = JSON.parse(fs.readFileSync(breakdownPath, "utf-8"));
      const votiumPayouts: Record<string, bigint> = {};
      if (fs.existsSync(payoutsPath)) {
        const artifact = JSON.parse(fs.readFileSync(payoutsPath, "utf-8"));
        for (const [addr, amount] of Object.entries(artifact.payouts || {})) {
          votiumPayouts[getAddress(addr)] = BigInt(amount as string);
        }
      }
      const SCRVUSD = getAddress("0x0655977FEb2f289A4aB78af67BAB0d17aAb84367");
      const expected: Record<string, bigint> = {};
      for (const [addr, row] of Object.entries(
        (breakdown.perWallet || {}) as Record<string, { total: string }>
      )) {
        expected[getAddress(addr)] = BigInt(row.total);
      }
      for (const [addr, amount] of Object.entries(votiumPayouts)) {
        expected[addr] = (expected[addr] ?? 0n) + amount;
      }
      let checked = 0;
      for (const [addr, expectedDelta] of Object.entries(expected)) {
        const weekChange = weekChangeOf(
          currentMerkleData,
          previousMerkleData,
          addr,
          SCRVUSD
        );
        if (weekChange === null) {
          errors.push(`Forwarder ${formatAddress(addr)} not found in merkle data`);
          continue;
        }
        if (weekChange !== expectedDelta) {
          errors.push(
            `Forwarder ${formatAddress(addr)}: expected sCRVUSD delta ` +
              `${expectedDelta.toString()}, got ${weekChange.toString()}`
          );
        }
        checked++;
      }
      log(`Checked ${checked} forwarder payouts against the breakdown artifact`);
    } else {
      log("\n=== Forwarders ===");
      log(
        "No delegators_split_breakdown.json for this period (historical run) — " +
          "per-address sCRVUSD deltas cannot be recomputed here"
      );
    }
  } else {
    // Combined merkle: skip forwarders (they're not in this merkle)
    log("\n=== Skipping Forwarders ===");
    log("Forwarders are distributed through a separate merkle tree");
  }

  if (merkleType === "combined") {
    log("\n=== Verifying Non-Forwarder Delegators ===");
    log(`Checking ${Object.keys(nonForwarders).length} non-forwarder delegator addresses...`);

    if (hasAttribution) {
      // Every wallet must have received EXACTLY its per-delegate
      // attribution, token by token.
      const exactNonForwarders = getExactGroupAmounts(
        delegationData.distribution,
        "nonForwarders"
      );
      for (const [wallet, tokens] of Object.entries(exactNonForwarders)) {
        const normalizedAddress = getAddress(wallet);
        if (!currentMerkleData.claims[normalizedAddress]) {
          errors.push(
            `Non-forwarder delegator ${formatAddress(normalizedAddress)} not found in merkle data`
          );
          continue;
        }
        for (const [token, expectedAmount] of Object.entries(tokens)) {
          if (expectedAmount === 0n) continue;
          const normalizedToken = getAddress(token);
          const weekChange = weekChangeOf(
            currentMerkleData,
            previousMerkleData,
            normalizedAddress,
            normalizedToken
          );
          if (weekChange === null) {
            warnings.push(
              `Token ${normalizedToken} not found for non-forwarder ${formatAddress(normalizedAddress)}`
            );
            continue;
          }
          // Direct-voter amounts can add to the same wallet/token — the
          // exact delegation amount is a lower bound then; equality holds
          // for pure delegators.
          const directAmount = BigInt(
            Object.entries(nonDelegators).find(
              ([a]) => a.toLowerCase() === wallet
            )?.[1]?.tokens?.[token] ?? 0
          );
          const expectedTotal = expectedAmount + directAmount;
          if (weekChange !== expectedTotal) {
            errors.push(
              `Non-forwarder delegator ${formatAddress(normalizedAddress)} token ${normalizedToken}: ` +
                `expected ${expectedTotal.toString()}, got ${weekChange.toString()}`
            );
          }
        }
      }
    } else {
      log(
        "No perDelegate attribution in this period's file (historical run) — " +
          "per-wallet delegation checks skipped"
      );
    }

    log("\n=== Verifying Direct Voters (Non-Delegators) ===");
    log(`Checking ${Object.keys(nonDelegators).length} direct voter addresses...`);
    log("These users voted directly without delegation");

    const exactNonForwardersForDirect = hasAttribution
      ? getExactGroupAmounts(delegationData.distribution, "nonForwarders")
      : {};

    for (const [address, data] of Object.entries(nonDelegators)) {
      const normalizedAddress = getAddress(address);
      const merkleEntry = currentMerkleData.claims[normalizedAddress];

      if (!merkleEntry) {
        errors.push(`Non-delegator ${formatAddress(normalizedAddress)} not found in merkle data`);
        continue;
      }

      // A wallet can be direct voter AND non-forwarder delegator; its
      // delegation part is added on top of the direct part.
      const delegationExtra: Record<string, bigint> =
        exactNonForwardersForDirect[address.toLowerCase()] ?? {};

      for (const [token, amount] of Object.entries(data.tokens)) {
        const normalizedToken = getAddress(token);
        const expectedAmount =
          BigInt(amount) + (delegationExtra[token.toLowerCase()] ?? 0n);

        const weekChange = weekChangeOf(
          currentMerkleData,
          previousMerkleData,
          normalizedAddress,
          normalizedToken
        );
        if (weekChange === null) {
          warnings.push(`Token ${normalizedToken} not found for non-delegator ${formatAddress(normalizedAddress)}`);
          continue;
        }

        if (weekChange !== expectedAmount) {
          errors.push(
            `Non-delegator ${formatAddress(normalizedAddress)} token ${normalizedToken}: ` +
            `expected ${expectedAmount.toString()}, got ${weekChange.toString()}`
          );
        }
      }
    }
  }

  // Summary
  log("\n=== Verification Summary ===");
  log(`✓ Total Addresses Verified: ${Object.keys(currentMerkleData.claims).length}`);
  log(`${errors.length > 0 ? '✗' : '✓'} Total Errors: ${errors.length}`);
  log(`${warnings.length > 0 ? '⚠' : '✓'} Total Warnings: ${warnings.length}`);

  if (errors.length > 0) {
    log("\n❌ Errors found:");
    errors.slice(0, 10).forEach(error => log(`  - ${error}`));
    if (errors.length > 10) {
      log(`  ... and ${errors.length - 10} more errors`);
    }
  }

  if (warnings.length > 0) {
    log("\n⚠️  Warnings:");
    warnings.slice(0, 5).forEach(warning => log(`  - ${warning}`));
    if (warnings.length > 5) {
      log(`  ... and ${warnings.length - 5} more warnings`);
    }
  }

  if (errors.length === 0 && warnings.length === 0) {
    log("\n✅ All distributions verified successfully!");
  }
};
