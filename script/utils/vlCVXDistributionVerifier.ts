import { Chain, getAddress } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { formatAddress } from "./address";
import fs from "fs";
import path from "path";

interface DelegationRepartition {
  distribution: {
    totalTokens: Record<string, string>;
    totalPerGroup: Record<string, { forwarders: string; nonForwarders: string }>;
    totalForwardersShare: string;
    totalNonForwardersShare: string;
    forwarders: Record<string, string>;
    nonForwarders: Record<string, string>;
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

export const verifyVlCVXDistribution = async (
  currentPeriodTimestamp: number,
  gaugeType: "curve" | "fxn",
  currentMerkleData: MerkleData,
  previousMerkleData: MerkleData,
  log: (message: string) => void,
  merkleType: "forwarders" | "combined" = "combined"
) => {
  log("\n=== vlCVX Distribution Verification ===");
  log(`Verifying ${gaugeType} distribution for period ${currentPeriodTimestamp}`);
  log(`Merkle type: ${merkleType}`);

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

  log(`\nForwarders: ${Object.keys(forwarders).length}`);
  log(`Non-Forwarder Delegators: ${Object.keys(nonForwarders).length}`);
  log(`Non-Delegators (Direct Voters): ${Object.keys(nonDelegators).length}`);

  // Verify each group against merkle data
  const errors: string[] = [];
  const warnings: string[] = [];

  // For combined merkle, we verify forwarders and non-forwarders+direct voters
  // For forwarders merkle, we only verify forwarders
  
  if (merkleType === "forwarders") {
    // Verify only forwarders
    log("\n=== Verifying Forwarders ===");
    for (const [address, share] of Object.entries(forwarders)) {
      const normalizedAddress = getAddress(address);
      const shareNumber = parseFloat(share);
      
      const merkleEntry = currentMerkleData.claims[normalizedAddress];
      if (!merkleEntry) {
        errors.push(`Forwarder ${formatAddress(normalizedAddress)} not found in merkle data`);
        continue;
      }

      for (const [token, groupAmounts] of Object.entries(totalPerGroup)) {
        const normalizedToken = getAddress(token);
        const expectedAmount = BigInt(groupAmounts.forwarders) * BigInt(Math.floor(shareNumber * 1e18)) / BigInt(1e18);
        
        const merkleTokenAmount = merkleEntry.tokens[normalizedToken]?.amount;
        if (!merkleTokenAmount) {
          warnings.push(`Token ${normalizedToken} not found for forwarder ${formatAddress(normalizedAddress)}`);
          continue;
        }

        const merkleBigInt = BigInt(merkleTokenAmount);
        const previousAmount = previousMerkleData.claims[normalizedAddress]?.tokens[normalizedToken]?.amount || "0";
        const weekChange = merkleBigInt - BigInt(previousAmount);

        const tolerance = expectedAmount / 10000n;
        if (weekChange < expectedAmount - tolerance || weekChange > expectedAmount + tolerance) {
          errors.push(
            `Forwarder ${formatAddress(normalizedAddress)} token ${normalizedToken}: ` +
            `expected ~${expectedAmount.toString()}, got ${weekChange.toString()}`
          );
        }
      }
    }
  } else {
    // Combined merkle: skip forwarders (they're not in this merkle)
    log("\n=== Skipping Forwarders (not in combined merkle) ===");
  }

  log("\n=== Verifying Non-Forwarder Delegators ===");
  for (const [address, share] of Object.entries(nonForwarders)) {
    const normalizedAddress = getAddress(address);
    const shareNumber = parseFloat(share);
    
    const merkleEntry = currentMerkleData.claims[normalizedAddress];
    if (!merkleEntry) {
      errors.push(`Non-forwarder delegator ${formatAddress(normalizedAddress)} not found in merkle data`);
      continue;
    }

    for (const [token, groupAmounts] of Object.entries(totalPerGroup)) {
      const normalizedToken = getAddress(token);
      const expectedAmount = BigInt(groupAmounts.nonForwarders) * BigInt(Math.floor(shareNumber * 1e18)) / BigInt(1e18);
      
      const merkleTokenAmount = merkleEntry.tokens[normalizedToken]?.amount;
      if (!merkleTokenAmount) {
        warnings.push(`Token ${normalizedToken} not found for non-forwarder ${formatAddress(normalizedAddress)}`);
        continue;
      }

      const merkleBigInt = BigInt(merkleTokenAmount);
      const previousAmount = previousMerkleData.claims[normalizedAddress]?.tokens[normalizedToken]?.amount || "0";
      const weekChange = merkleBigInt - BigInt(previousAmount);

      const tolerance = expectedAmount / 10000n;
      if (weekChange < expectedAmount - tolerance || weekChange > expectedAmount + tolerance) {
        errors.push(
          `Non-forwarder delegator ${formatAddress(normalizedAddress)} token ${normalizedToken}: ` +
          `expected ~${expectedAmount.toString()}, got ${weekChange.toString()}`
        );
      }
    }
  }

  log("\n=== Verifying Non-Delegators (Direct Voters) ===");
  for (const [address, data] of Object.entries(nonDelegators)) {
    const normalizedAddress = getAddress(address);
    const merkleEntry = currentMerkleData.claims[normalizedAddress];
    
    if (!merkleEntry) {
      errors.push(`Non-delegator ${formatAddress(normalizedAddress)} not found in merkle data`);
      continue;
    }

    for (const [token, amount] of Object.entries(data.tokens)) {
      const normalizedToken = getAddress(token);
      const expectedAmount = BigInt(amount);
      
      const merkleTokenAmount = merkleEntry.tokens[normalizedToken]?.amount;
      if (!merkleTokenAmount) {
        warnings.push(`Token ${normalizedToken} not found for non-delegator ${formatAddress(normalizedAddress)}`);
        continue;
      }

      const merkleBigInt = BigInt(merkleTokenAmount);
      const previousAmount = previousMerkleData.claims[normalizedAddress]?.tokens[normalizedToken]?.amount || "0";
      const weekChange = merkleBigInt - BigInt(previousAmount);

      if (weekChange !== expectedAmount) {
        errors.push(
          `Non-delegator ${formatAddress(normalizedAddress)} token ${normalizedToken}: ` +
          `expected ${expectedAmount.toString()}, got ${weekChange.toString()}`
        );
      }
    }
  }

  // Summary
  log("\n=== Verification Summary ===");
  log(`Total Errors: ${errors.length}`);
  log(`Total Warnings: ${warnings.length}`);
  
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

  // Token totals verification
  log("\n=== Token Totals Verification ===");
  const calculatedTotals: Record<string, bigint> = {};
  
  // Sum up all week changes from merkle data
  for (const address in currentMerkleData.claims) {
    const currentClaims = currentMerkleData.claims[address];
    const previousClaims = previousMerkleData.claims[address] || { tokens: {} };
    
    for (const token in currentClaims.tokens) {
      const normalizedToken = getAddress(token);
      const currentAmount = BigInt(currentClaims.tokens[token].amount);
      const previousAmount = previousClaims.tokens[token] ? BigInt(previousClaims.tokens[token].amount) : 0n;
      const weekChange = currentAmount - previousAmount;
      
      calculatedTotals[normalizedToken] = (calculatedTotals[normalizedToken] || 0n) + weekChange;
    }
  }

  // Compare with expected totals based on merkle type
  const normalizedTotalTokens = normalizeTokenMapping(delegationData.distribution.totalTokens);
  
  if (merkleType === "forwarders") {
    // For forwarders merkle, compare with forwarders portion only
    log("Comparing with forwarders portion only:");
    for (const [token, groupAmounts] of Object.entries(totalPerGroup)) {
      const normalizedToken = getAddress(token);
      const expected = BigInt(groupAmounts.forwarders);
      const calculated = calculatedTotals[normalizedToken] || 0n;
      
      log(`${token}: expected ${expected.toString()}, calculated ${calculated.toString()}`);
      
      if (expected !== calculated) {
        const diff = expected > calculated ? expected - calculated : calculated - expected;
        const percentage = Number(diff * 10000n / expected) / 100;
        log(`  ⚠️  Difference: ${diff.toString()} (${percentage.toFixed(2)}%)`);
      }
    }
  } else {
    // For combined merkle, compare with non-forwarders portion + direct voters
    log("Comparing with non-forwarders + direct voters:");
    
    // Calculate expected totals for non-forwarders + direct voters
    const expectedTotals: Record<string, bigint> = {};
    
    // Add non-forwarders portion
    for (const [token, groupAmounts] of Object.entries(totalPerGroup)) {
      const normalizedToken = getAddress(token);
      expectedTotals[normalizedToken] = BigInt(groupAmounts.nonForwarders);
    }
    
    // Add direct voters amounts
    for (const [address, data] of Object.entries(nonDelegators)) {
      for (const [token, amount] of Object.entries(data.tokens)) {
        const normalizedToken = getAddress(token);
        expectedTotals[normalizedToken] = (expectedTotals[normalizedToken] || 0n) + BigInt(amount);
      }
    }
    
    // Compare
    for (const [token, expected] of Object.entries(expectedTotals)) {
      const calculated = calculatedTotals[token] || 0n;
      
      log(`${token}: expected ${expected.toString()}, calculated ${calculated.toString()}`);
      
      if (expected !== calculated) {
        const diff = expected > calculated ? expected - calculated : calculated - expected;
        const percentage = expected > 0n ? Number(diff * 10000n / expected) / 100 : 0;
        log(`  ⚠️  Difference: ${diff.toString()} (${percentage.toFixed(2)}%)`);
      }
    }
  }
};