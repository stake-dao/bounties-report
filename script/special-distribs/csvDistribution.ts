import fs from "fs";
import path from "path";
import { getAddress } from "viem";
import { parse } from "csv-parse/sync";
import { utils } from "ethers";
import MerkleTree from "merkletreejs";


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

interface UniversalMerkle {
  [address: string]: {
    [tokenAddress: string]: string;
  };
}

/**
 * Generate merkle tree
 */
function generateMerkleTree(distribution: UniversalMerkle): MerkleData {
  const leaves: string[] = [];
  const claims: MerkleData["claims"] = {};

  // Convert input addresses to checksum addresses and merge duplicate addresses
  const checksummedDistribution = Object.entries(distribution).reduce(
    (acc, [address, tokens]) => {
      const checksumAddress = getAddress(address);

      if (!acc[checksumAddress]) {
        acc[checksumAddress] = {};
      }

      Object.entries(tokens).forEach(([tokenAddress, amount]) => {
        const checksumTokenAddress = getAddress(tokenAddress);
        acc[checksumAddress][checksumTokenAddress] = amount;
      });

      return acc;
    },
    {} as { [address: string]: { [tokenAddress: string]: string } }
  );

  Object.entries(checksummedDistribution).forEach(([address, tokens]) => {
    Object.entries(tokens).forEach(([tokenAddress, amount]) => {
      const leaf = utils.keccak256(
        utils.solidityPack(
          ["bytes"],
          [
            utils.keccak256(
              utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [address, tokenAddress, amount]
              )
            ),
          ]
        )
      );
      leaves.push(leaf);

      if (!claims[address]) {
        claims[address] = { tokens: {} };
      }
      claims[address].tokens[tokenAddress] = {
        amount,
        proof: [],
      };
    });
  });

  const merkleTree = new MerkleTree(leaves, utils.keccak256, { sortPairs: true });
  const merkleRoot = merkleTree.getHexRoot();

  // Generate proofs using checksummed addresses
  Object.entries(claims).forEach(([address, claim]) => {
    Object.entries(claim.tokens).forEach(([tokenAddress, tokenClaim]) => {
      const leaf = utils.keccak256(
        utils.solidityPack(
          ["bytes"],
          [
            utils.keccak256(
              utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [address, tokenAddress, tokenClaim.amount]
              )
            ),
          ]
        )
      );
      tokenClaim.proof = merkleTree.getHexProof(leaf);
    });
  });

  return {
    merkleRoot,
    claims,
  };
}

/**
 * Load existing merkle data and convert to distribution format
 */
function loadExistingDistribution(): UniversalMerkle {
  const merklePath = path.join(__dirname, "../../data/extra_merkle/merkle.json");
  
  if (!fs.existsSync(merklePath)) {
    console.log("No existing merkle.json found, starting fresh");
    return {};
  }
  
  try {
    const merkleData: MerkleData = JSON.parse(fs.readFileSync(merklePath, 'utf-8'));
    const distribution: UniversalMerkle = {};
    
    // Convert merkle claims back to distribution format
    for (const [address, claim] of Object.entries(merkleData.claims)) {
      distribution[address] = {};
      for (const [token, tokenData] of Object.entries(claim.tokens)) {
        distribution[address][token] = tokenData.amount;
      }
    }
    
    console.log(`Loaded existing distribution with ${Object.keys(distribution).length} addresses`);
    return distribution;
  } catch (error) {
    console.error("Error loading existing merkle:", error);
    return {};
  }
}

/**
 * Parse CSV and generate merkle tree
 */
async function main() {
  const csvPath = path.join(__dirname, "distribution-data.csv");
  
  if (!fs.existsSync(csvPath)) {
    console.error("CSV file not found:", csvPath);
    process.exit(1);
  }
  
  console.log("Reading CSV file...");
  const fileContent = fs.readFileSync(csvPath, 'utf-8');
  
  // Parse CSV
  const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  
  // Load existing distribution
  const distribution: UniversalMerkle = loadExistingDistribution();
  
  // Add CSV records to distribution (merging with existing)
  let newRecords = 0;
  let updatedRecords = 0;
  
  for (const record of records) {
    try {
      const address = getAddress(record.address);
      const token = getAddress(record.token);
      const amount = BigInt(record.amount);
      
      if (!distribution[address]) {
        distribution[address] = {};
        newRecords++;
      } else if (distribution[address][token]) {
        updatedRecords++;
      }
      
      // Add to existing amount or set new amount
      const existingAmount = distribution[address][token] ? BigInt(distribution[address][token]) : 0n;
      distribution[address][token] = (existingAmount + amount).toString();
    } catch (error) {
      console.error("Error processing record:", record, error);
    }
  }
  
  console.log(`Added ${newRecords} new addresses, updated ${updatedRecords} existing entries`);
  
  console.log(`\nTotal distribution now has ${Object.keys(distribution).length} addresses`);
  
  // Generate merkle tree
  console.log("\nGenerating merkle tree...");
  const merkleData = generateMerkleTree(distribution);
  
  // Output to extra_merkle directory (overwrite existing)
  const timestamp = Math.floor(Date.now() / 1000);
  const outputDir = path.join(__dirname, "../../data/extra_merkle");
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Save files
  const merklePath = path.join(outputDir, "merkle.json");
  const repartitionPath = path.join(outputDir, "repartition.json");
  const summaryPath = path.join(outputDir, "summary.json");
  
  fs.writeFileSync(merklePath, JSON.stringify(merkleData, null, 2));
  fs.writeFileSync(repartitionPath, JSON.stringify({
    timestamp,
    distribution
  }, null, 2));
  
  // Create summary
  const tokenSummary: Record<string, { total: bigint; recipients: number }> = {};
  
  for (const [address, tokens] of Object.entries(distribution)) {
    for (const [token, amount] of Object.entries(tokens)) {
      if (!tokenSummary[token]) {
        tokenSummary[token] = { total: 0n, recipients: 0 };
      }
      tokenSummary[token].total += BigInt(amount);
      tokenSummary[token].recipients++;
    }
  }
  
  const summary = {
    timestamp,
    merkleRoot: merkleData.merkleRoot,
    totalRecipients: Object.keys(distribution).length,
    tokens: Object.entries(tokenSummary).map(([token, data]) => ({
      token,
      totalAmount: data.total.toString(),
      recipients: data.recipients
    }))
  };
  
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  
  console.log(`\nFiles saved to: ${outputDir} (merged with existing data)`);
  console.log(`Merkle root: ${merkleData.merkleRoot}`);
  console.log(`Total recipients: ${Object.keys(distribution).length}`);
  
  // Display token summary
  console.log("\nToken Summary:");
  for (const tokenData of summary.tokens) {
    console.log(`- ${tokenData.token}`);
    console.log(`  Total: ${tokenData.totalAmount} wei`);
    console.log(`  Recipients: ${tokenData.recipients}`);
  }
}

// Run
if (require.main === module) {
  main().catch(console.error);
}