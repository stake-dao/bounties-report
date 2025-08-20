import { readFileSync } from 'fs';
import { BigNumber, utils } from 'ethers';
import { tokenService } from '../utils/tokenService';

interface MerkleData {
  merkleRoot: string;
  claims: {
    [address: string]: {
      tokens: {
        [tokenAddress: string]: {
          amount: string;
          proof: string[];
        };
      };
    };
  };
}

interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
}

interface TokenSummary {
  tokenAddress: string;
  tokenInfo?: TokenInfo;
  totalAmountWei: BigNumber;
  totalAmountFormatted: string;
  recipientCount: number;
}

interface AddressClaim {
  address: string;
  tokens: {
    tokenAddress: string;
    tokenInfo?: TokenInfo;
    amountWei: BigNumber;
    amountFormatted: string;
  }[];
  totalValueUSD?: number; // Could be added later if needed
}

interface MerkleComparison {
  before: {
    merkleRoot: string;
    tokenSummaries: TokenSummary[];
    addressClaims: AddressClaim[];
  };
  after: {
    merkleRoot: string;
    tokenSummaries: TokenSummary[];
    addressClaims: AddressClaim[];
  };
  differences: {
    newAddresses: string[];
    removedAddresses: string[];
    modifiedAddresses: {
      address: string;
      changes: {
        tokenAddress: string;
        tokenInfo?: TokenInfo;
        beforeAmount: BigNumber;
        afterAmount: BigNumber;
        difference: BigNumber;
        beforeFormatted: string;
        afterFormatted: string;
        differenceFormatted: string;
        percentageChange: number;
      }[];
    }[];
    tokenDifferences: {
      tokenAddress: string;
      tokenInfo?: TokenInfo;
      beforeTotal: BigNumber;
      afterTotal: BigNumber;
      difference: BigNumber;
      beforeFormatted: string;
      afterFormatted: string;
      differenceFormatted: string;
      percentageChange: number;
      beforeRecipients: number;
      afterRecipients: number;
      recipientsDifference: number;
    }[];
  };
}

export async function analyzeMerkleTokens(merklePath: string): Promise<{
  tokenSummaries: TokenSummary[];
  addressClaims: AddressClaim[];
  merkleRoot: string;
}> {
  // Read and parse the merkle.json file
  const data: MerkleData = JSON.parse(readFileSync(merklePath, 'utf8'));

  // Initialize token service
  await tokenService.initialize();

  // Map to store sum per token
  const tokenSums = new Map<string, { total: BigNumber; recipients: Set<string> }>();
  const addressClaims: AddressClaim[] = [];

  // Process all claims
  for (const [address, claimData] of Object.entries(data.claims)) {
    const addressTokens: AddressClaim['tokens'] = [];

    if (claimData.tokens) {
      for (const [tokenAddress, tokenData] of Object.entries(claimData.tokens)) {
        const amount = BigNumber.from(tokenData.amount);

        // Update token sum
        const current = tokenSums.get(tokenAddress) || { total: BigNumber.from(0), recipients: new Set<string>() };
        current.total = current.total.add(amount);
        current.recipients.add(address);
        tokenSums.set(tokenAddress, current);

        // Get token info
        const tokenInfo = await tokenService.getTokenByAddress(tokenAddress, "1");

        addressTokens.push({
          tokenAddress,
          tokenInfo: tokenInfo ? {
            address: tokenAddress,
            symbol: tokenInfo.symbol,
            decimals: tokenInfo.decimals,
            name: tokenInfo.name
          } : undefined,
          amountWei: amount,
          amountFormatted: formatTokenAmount(amount, tokenInfo?.decimals || 18, tokenInfo?.symbol)
        });
      }
    }

    if (addressTokens.length > 0) {
      addressClaims.push({
        address,
        tokens: addressTokens
      });
    }
  }

  // Convert to token summaries
  const tokenSummaries: TokenSummary[] = [];
  for (const [tokenAddress, { total, recipients }] of tokenSums.entries()) {
    const tokenInfo = await tokenService.getTokenByAddress(tokenAddress, "1");

    tokenSummaries.push({
      tokenAddress,
      tokenInfo: tokenInfo ? {
        address: tokenAddress,
        symbol: tokenInfo.symbol,
        decimals: tokenInfo.decimals,
        name: tokenInfo.name
      } : undefined,
      totalAmountWei: total,
      totalAmountFormatted: formatTokenAmount(total, tokenInfo?.decimals || 18, tokenInfo?.symbol),
      recipientCount: recipients.size
    });
  }

  // Sort summaries by total amount descending
  tokenSummaries.sort((a, b) => {
    if (a.totalAmountWei.gt(b.totalAmountWei)) return -1;
    if (a.totalAmountWei.lt(b.totalAmountWei)) return 1;
    return 0;
  });

  // Sort address claims by address
  addressClaims.sort((a, b) => a.address.localeCompare(b.address));

  return {
    tokenSummaries,
    addressClaims,
    merkleRoot: data.merkleRoot
  };
}

function formatTokenAmount(amount: BigNumber, decimals: number, symbol?: string): string {
  const formatted = utils.formatUnits(amount, decimals);
  const num = parseFloat(formatted);

  // Format with appropriate decimal places
  let displayValue: string;
  if (num === 0) {
    displayValue = "0";
  } else if (num < 0.000001) {
    displayValue = num.toExponential(2);
  } else if (num < 1) {
    displayValue = num.toFixed(6).replace(/\.?0+$/, '');
  } else if (num < 1000) {
    displayValue = num.toFixed(4).replace(/\.?0+$/, '');
  } else if (num < 1000000) {
    displayValue = num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  } else {
    // For millions, show with M suffix
    displayValue = (num / 1000000).toFixed(2) + 'M';
  }

  return symbol ? `${displayValue} ${symbol}` : displayValue;
}

export async function printMerkleAnalysis(merklePath: string): Promise<void> {
  const { tokenSummaries, addressClaims, merkleRoot } = await analyzeMerkleTokens(merklePath);

  console.log("\n" + "=".repeat(100));
  console.log("MERKLE TREE ANALYSIS");
  console.log("=".repeat(100));
  console.log(`Merkle Root: ${merkleRoot}`);
  console.log(`Total Recipients: ${addressClaims.length}`);
  console.log(`Total Tokens: ${tokenSummaries.length}`);

  // Token Summary
  console.log("\n" + "=".repeat(100));
  console.log("TOKEN DISTRIBUTION SUMMARY");
  console.log("=".repeat(100));
  console.log(`${'Token'.padEnd(15)} ${'Address'.padEnd(45)} ${'Total Amount'.padEnd(20)} ${'Recipients'.padEnd(10)}`);
  console.log("-".repeat(100));

  for (const summary of tokenSummaries) {
    const symbol = summary.tokenInfo?.symbol || 'Unknown';
    console.log(
      `${symbol.padEnd(15)} ${summary.tokenAddress.padEnd(45)} ${summary.totalAmountFormatted.padEnd(20)} ${summary.recipientCount.toString().padEnd(10)}`
    );
  }

  // Address Claims Summary
  console.log("\n" + "=".repeat(100));
  console.log("CLAIMS BY ADDRESS");
  console.log("=".repeat(100));

  for (const claim of addressClaims) {
    console.log(`\nAddress: ${claim.address}`);
    console.log("-".repeat(60));

    for (const token of claim.tokens) {
      const symbol = token.tokenInfo?.symbol || 'Unknown';
      console.log(`  ${symbol.padEnd(10)} ${token.amountFormatted.padStart(25)}`);
    }
  }

  console.log("\n" + "=".repeat(100));
}

// Export function to get formatted data without printing
export async function getMerkleAnalysisData(merklePath: string) {
  return analyzeMerkleTokens(merklePath);
}

export async function compareMerkles(beforePath: string, afterPath: string): Promise<MerkleComparison> {
  // Analyze both merkle trees
  const beforeData = await analyzeMerkleTokens(beforePath);
  const afterData = await analyzeMerkleTokens(afterPath);

  // Create maps for efficient lookups
  const beforeAddressMap = new Map<string, AddressClaim>();
  const afterAddressMap = new Map<string, AddressClaim>();
  
  beforeData.addressClaims.forEach(claim => beforeAddressMap.set(claim.address, claim));
  afterData.addressClaims.forEach(claim => afterAddressMap.set(claim.address, claim));

  const beforeTokenMap = new Map<string, TokenSummary>();
  const afterTokenMap = new Map<string, TokenSummary>();
  
  beforeData.tokenSummaries.forEach(summary => beforeTokenMap.set(summary.tokenAddress, summary));
  afterData.tokenSummaries.forEach(summary => afterTokenMap.set(summary.tokenAddress, summary));

  // Find new and removed addresses
  const beforeAddresses = new Set(beforeAddressMap.keys());
  const afterAddresses = new Set(afterAddressMap.keys());
  
  const newAddresses = Array.from(afterAddresses).filter(addr => !beforeAddresses.has(addr));
  const removedAddresses = Array.from(beforeAddresses).filter(addr => !afterAddresses.has(addr));

  // Find modified addresses
  const modifiedAddresses: MerkleComparison['differences']['modifiedAddresses'] = [];
  
  for (const address of beforeAddresses) {
    if (!afterAddresses.has(address)) continue;
    
    const beforeClaim = beforeAddressMap.get(address)!;
    const afterClaim = afterAddressMap.get(address)!;
    
    const beforeTokens = new Map<string, typeof beforeClaim.tokens[0]>();
    const afterTokens = new Map<string, typeof afterClaim.tokens[0]>();
    
    beforeClaim.tokens.forEach(token => beforeTokens.set(token.tokenAddress, token));
    afterClaim.tokens.forEach(token => afterTokens.set(token.tokenAddress, token));
    
    const changes: typeof modifiedAddresses[0]['changes'] = [];
    
    // Check all tokens (before and after)
    const allTokens = new Set([...beforeTokens.keys(), ...afterTokens.keys()]);
    
    for (const tokenAddress of allTokens) {
      const beforeToken = beforeTokens.get(tokenAddress);
      const afterToken = afterTokens.get(tokenAddress);
      
      const beforeAmount = beforeToken?.amountWei || BigNumber.from(0);
      const afterAmount = afterToken?.amountWei || BigNumber.from(0);
      
      if (!beforeAmount.eq(afterAmount)) {
        const difference = afterAmount.sub(beforeAmount);
        const tokenInfo = afterToken?.tokenInfo || beforeToken?.tokenInfo;
        const decimals = tokenInfo?.decimals || 18;
        const symbol = tokenInfo?.symbol;
        
        const percentageChange = beforeAmount.isZero() 
          ? 100 
          : parseFloat(difference.mul(10000).div(beforeAmount).toString()) / 100;
        
        changes.push({
          tokenAddress,
          tokenInfo,
          beforeAmount,
          afterAmount,
          difference,
          beforeFormatted: formatTokenAmount(beforeAmount, decimals, symbol),
          afterFormatted: formatTokenAmount(afterAmount, decimals, symbol),
          differenceFormatted: (difference.isNegative() ? '-' : '+') + formatTokenAmount(difference.abs(), decimals, symbol),
          percentageChange
        });
      }
    }
    
    if (changes.length > 0) {
      modifiedAddresses.push({ address, changes });
    }
  }

  // Calculate token differences
  const tokenDifferences: MerkleComparison['differences']['tokenDifferences'] = [];
  const allTokenAddresses = new Set([...beforeTokenMap.keys(), ...afterTokenMap.keys()]);
  
  for (const tokenAddress of allTokenAddresses) {
    const beforeSummary = beforeTokenMap.get(tokenAddress);
    const afterSummary = afterTokenMap.get(tokenAddress);
    
    const beforeTotal = beforeSummary?.totalAmountWei || BigNumber.from(0);
    const afterTotal = afterSummary?.totalAmountWei || BigNumber.from(0);
    const beforeRecipients = beforeSummary?.recipientCount || 0;
    const afterRecipients = afterSummary?.recipientCount || 0;
    
    if (!beforeTotal.eq(afterTotal) || beforeRecipients !== afterRecipients) {
      const difference = afterTotal.sub(beforeTotal);
      const tokenInfo = afterSummary?.tokenInfo || beforeSummary?.tokenInfo;
      const decimals = tokenInfo?.decimals || 18;
      const symbol = tokenInfo?.symbol;
      
      const percentageChange = beforeTotal.isZero() 
        ? 100 
        : parseFloat(difference.mul(10000).div(beforeTotal).toString()) / 100;
      
      tokenDifferences.push({
        tokenAddress,
        tokenInfo,
        beforeTotal,
        afterTotal,
        difference,
        beforeFormatted: formatTokenAmount(beforeTotal, decimals, symbol),
        afterFormatted: formatTokenAmount(afterTotal, decimals, symbol),
        differenceFormatted: (difference.isNegative() ? '-' : '+') + formatTokenAmount(difference.abs(), decimals, symbol),
        percentageChange,
        beforeRecipients,
        afterRecipients,
        recipientsDifference: afterRecipients - beforeRecipients
      });
    }
  }

  return {
    before: beforeData,
    after: afterData,
    differences: {
      newAddresses,
      removedAddresses,
      modifiedAddresses,
      tokenDifferences
    }
  };
}

export async function printMerkleComparison(beforePath: string, afterPath: string): Promise<void> {
  const comparison = await compareMerkles(beforePath, afterPath);
  
  console.log("\n" + "=".repeat(100));
  console.log("MERKLE TREE COMPARISON");
  console.log("=".repeat(100));
  console.log(`Before Merkle Root: ${comparison.before.merkleRoot}`);
  console.log(`After Merkle Root:  ${comparison.after.merkleRoot}`);
  console.log(`\nBefore Recipients: ${comparison.before.addressClaims.length}`);
  console.log(`After Recipients:  ${comparison.after.addressClaims.length}`);
  console.log(`Difference:        ${comparison.after.addressClaims.length - comparison.before.addressClaims.length}`);

  // Token differences
  if (comparison.differences.tokenDifferences.length > 0) {
    console.log("\n" + "=".repeat(100));
    console.log("TOKEN DISTRIBUTION CHANGES");
    console.log("=".repeat(100));
    console.log(`${'Token'.padEnd(10)} ${'Before'.padEnd(20)} ${'After'.padEnd(20)} ${'Difference'.padEnd(20)} ${'%'.padEnd(8)} ${'Recipients'.padEnd(15)}`);
    console.log("-".repeat(100));
    
    for (const diff of comparison.differences.tokenDifferences) {
      const symbol = diff.tokenInfo?.symbol || 'Unknown';
      const recipientChange = diff.recipientsDifference > 0 ? `+${diff.recipientsDifference}` : diff.recipientsDifference.toString();
      
      console.log(
        `${symbol.padEnd(10)} ${diff.beforeFormatted.padEnd(20)} ${diff.afterFormatted.padEnd(20)} ${diff.differenceFormatted.padEnd(20)} ${(diff.percentageChange.toFixed(2) + '%').padEnd(8)} ${recipientChange.padEnd(15)}`
      );
    }
  }

  // New addresses
  if (comparison.differences.newAddresses.length > 0) {
    console.log("\n" + "=".repeat(100));
    console.log(`NEW ADDRESSES (${comparison.differences.newAddresses.length})`);
    console.log("=".repeat(100));
    
    for (const address of comparison.differences.newAddresses) {
      const claim = comparison.after.addressClaims.find(c => c.address === address)!;
      console.log(`\n${address}:`);
      for (const token of claim.tokens) {
        const symbol = token.tokenInfo?.symbol || 'Unknown';
        console.log(`  ${symbol.padEnd(10)} ${token.amountFormatted}`);
      }
    }
  }

  // Removed addresses
  if (comparison.differences.removedAddresses.length > 0) {
    console.log("\n" + "=".repeat(100));
    console.log(`REMOVED ADDRESSES (${comparison.differences.removedAddresses.length})`);
    console.log("=".repeat(100));
    
    for (const address of comparison.differences.removedAddresses) {
      const claim = comparison.before.addressClaims.find(c => c.address === address)!;
      console.log(`\n${address}:`);
      for (const token of claim.tokens) {
        const symbol = token.tokenInfo?.symbol || 'Unknown';
        console.log(`  ${symbol.padEnd(10)} ${token.amountFormatted}`);
      }
    }
  }

  // Modified addresses
  if (comparison.differences.modifiedAddresses.length > 0) {
    console.log("\n" + "=".repeat(100));
    console.log(`MODIFIED ADDRESSES (${comparison.differences.modifiedAddresses.length})`);
    console.log("=".repeat(100));
    
    for (const modified of comparison.differences.modifiedAddresses) {
      console.log(`\n${modified.address}:`);
      console.log("-".repeat(60));
      
      for (const change of modified.changes) {
        const symbol = change.tokenInfo?.symbol || 'Unknown';
        console.log(`  ${symbol.padEnd(10)} ${change.beforeFormatted.padEnd(20)} → ${change.afterFormatted.padEnd(20)} (${change.differenceFormatted}, ${change.percentageChange.toFixed(2)}%)`);
      }
    }
  }
  
  console.log("\n" + "=".repeat(100));
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    // Default behavior - analyze single merkle
    await printMerkleAnalysis("data/extra_merkle/merkle.json");
  } else if (args.length === 1) {
    // Analyze single merkle from provided path
    await printMerkleAnalysis(args[0]);
  } else if (args.length === 2) {
    // Compare two merkles
    console.log(`Comparing merkles: ${args[0]} (before) vs ${args[1]} (after)`);
    await printMerkleComparison(args[0], args[1]);
  } else {
    console.error("Usage:");
    console.error("  npx ts-node script/helpers/analyzeMerkle.ts                    # Analyze default merkle");
    console.error("  npx ts-node script/helpers/analyzeMerkle.ts <path>            # Analyze specific merkle");
    console.error("  npx ts-node script/helpers/analyzeMerkle.ts <before> <after>  # Compare two merkles");
    process.exit(1);
  }
}


if (require.main === module) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
}

