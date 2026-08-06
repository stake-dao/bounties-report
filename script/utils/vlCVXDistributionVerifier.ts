import { getAddress } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { formatAddress } from "./address";
import fs from "fs";
import path from "path";
import {
  hasPerDelegateAttribution,
  getExactGroupAmounts,
} from "./delegationExact";
import {
  computeVotiumRawPayouts,
  hasClaimedVotiumBounties,
  MIN_VOTIUM_RAW_PAYOUT_USD,
} from "./votiumRawPayouts";

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

/**
 * The raw Votium leaves the combined CURVE merkle must carry this period
 * (lowercase wallet -> lowercase token -> wei), recomputed from the same
 * inputs as createCombinedMerkle. Empty on non-claim weeks. Errors are
 * reported through `errors` instead of throwing — this is a verifier.
 */
const loadVotiumRawExpectations = (
  currentPeriodTimestamp: number,
  errors: string[]
): Record<string, Record<string, bigint>> => {
  const votiumDir = path.join(
    process.cwd(),
    "weekly-bounties",
    String(currentPeriodTimestamp),
    "votium"
  );
  const claimsFile = path.join(votiumDir, "claimed_bounties_convex.json");
  const attributionFile = path.join(votiumDir, "forwarders_voted_rewards.json");

  try {
    const claims: unknown = fs.existsSync(claimsFile)
      ? JSON.parse(fs.readFileSync(claimsFile, "utf-8"))
      : null;
    const hasClaims = claims !== null && hasClaimedVotiumBounties(claims);
    if (!hasClaims) return {};
    if (!fs.existsSync(attributionFile)) {
      errors.push(
        "Votium bounties claimed this period but the forwarder attribution file is missing"
      );
      return {};
    }
    const attribution = JSON.parse(fs.readFileSync(attributionFile, "utf-8"));
    return computeVotiumRawPayouts({
      claimedBounties: claims,
      minimumPayoutUsd: MIN_VOTIUM_RAW_PAYOUT_USD,
      tokenAllocations: attribution.tokenAllocations ?? {},
    }).payouts;
  } catch (error) {
    errors.push(`Votium raw expectations could not be computed: ${error}`);
    return {};
  }
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
    if (fs.existsSync(breakdownPath)) {
      log("\n=== Verifying Forwarders (exact split breakdown) ===");
      const breakdown = JSON.parse(fs.readFileSync(breakdownPath, "utf-8"));
      const SCRVUSD = getAddress("0x0655977FEb2f289A4aB78af67BAB0d17aAb84367");
      const expected: Record<string, bigint> = {};
      for (const [addr, row] of Object.entries(
        (breakdown.perWallet || {}) as Record<string, { total: string }>
      )) {
        expected[getAddress(addr)] = BigInt(row.total);
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
    // Combined merkle: Stake DAO-pooled forwarders settle through the
    // Tuesday sCRVUSD merkle; every other forwarder is raw-routed and IS
    // checked below with the raw-routed delegators / Votium leaves.
    log("\n=== Pooled Forwarders ===");
    log("Stake DAO delegates' forwarders are distributed through the Tuesday sCRVUSD merkle");
  }

  if (merkleType === "combined") {
    // Raw Votium leaves live in the CURVE combined merkle on claim weeks;
    // they stack on top of a wallet's delegation and direct amounts.
    const votiumExtra =
      gaugeType === "curve"
        ? loadVotiumRawExpectations(currentPeriodTimestamp, errors)
        : {};

    log("\n=== Verifying Raw-Routed Delegators ===");
    log(
      "Non-forwarder delegators of every delegate plus forwarders behind " +
        "non-Stake-DAO delegates — each paid its exact per-delegate attribution"
    );

    const exactRawRouted = hasAttribution
      ? getExactGroupAmounts(delegationData.distribution, "nonForwarders")
      : {};

    if (hasAttribution) {
      for (const [wallet, tokens] of Object.entries(exactRawRouted)) {
        const normalizedAddress = getAddress(wallet);
        if (!currentMerkleData.claims[normalizedAddress]) {
          errors.push(
            `Raw-routed delegator ${formatAddress(normalizedAddress)} not found in merkle data`
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
              `Token ${normalizedToken} not found for raw-routed delegator ${formatAddress(normalizedAddress)}`
            );
            continue;
          }
          // Direct-voter and raw Votium amounts can add to the same
          // wallet/token; equality holds on the summed expectation.
          const directAmount = BigInt(
            Object.entries(nonDelegators).find(
              ([a]) => a.toLowerCase() === wallet
            )?.[1]?.tokens?.[token] ?? 0
          );
          const expectedTotal =
            expectedAmount +
            directAmount +
            (votiumExtra[wallet]?.[token.toLowerCase()] ?? 0n);
          if (weekChange !== expectedTotal) {
            errors.push(
              `Raw-routed delegator ${formatAddress(normalizedAddress)} token ${normalizedToken}: ` +
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

    for (const [address, data] of Object.entries(nonDelegators)) {
      const normalizedAddress = getAddress(address);
      const merkleEntry = currentMerkleData.claims[normalizedAddress];

      if (!merkleEntry) {
        errors.push(`Non-delegator ${formatAddress(normalizedAddress)} not found in merkle data`);
        continue;
      }

      // A wallet can be direct voter AND raw-routed delegator AND a raw
      // Votium payee; the parts stack on the same token.
      const delegationExtra: Record<string, bigint> =
        exactRawRouted[address.toLowerCase()] ?? {};
      const walletVotium: Record<string, bigint> =
        votiumExtra[address.toLowerCase()] ?? {};

      for (const [token, amount] of Object.entries(data.tokens)) {
        const normalizedToken = getAddress(token);
        const expectedAmount =
          BigInt(amount) +
          (delegationExtra[token.toLowerCase()] ?? 0n) +
          (walletVotium[token.toLowerCase()] ?? 0n);

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

    if (Object.keys(votiumExtra).length > 0) {
      log("\n=== Verifying Raw Votium Leaves ===");
      log(`Checking ${Object.keys(votiumExtra).length} Votium payee(s)...`);
      for (const [wallet, tokens] of Object.entries(votiumExtra)) {
        const normalizedAddress = getAddress(wallet);
        const delegationTokens = exactRawRouted[wallet] ?? {};
        const directTokens =
          Object.entries(nonDelegators).find(
            ([a]) => a.toLowerCase() === wallet
          )?.[1]?.tokens ?? {};
        for (const [token, votiumAmount] of Object.entries(tokens)) {
          const normalizedToken = getAddress(token);
          const directAmount = BigInt(
            Object.entries(directTokens).find(
              ([t]) => t.toLowerCase() === token
            )?.[1] ?? 0
          );
          const expectedTotal =
            votiumAmount + (delegationTokens[token] ?? 0n) + directAmount;
          const weekChange = weekChangeOf(
            currentMerkleData,
            previousMerkleData,
            normalizedAddress,
            normalizedToken
          );
          if (weekChange === null) {
            errors.push(
              `Votium payee ${formatAddress(normalizedAddress)} token ${normalizedToken} missing from merkle data`
            );
            continue;
          }
          if (weekChange !== expectedTotal) {
            errors.push(
              `Votium payee ${formatAddress(normalizedAddress)} token ${normalizedToken}: ` +
                `expected ${expectedTotal.toString()}, got ${weekChange.toString()}`
            );
          }
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
