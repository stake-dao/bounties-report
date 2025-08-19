import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { BigNumber } from "ethers";
import { getAddress } from "viem";
import { mainnet, fraxtal } from "viem/chains";
import {
  SDFXS_SPACE,
  WEEK,
  SDFXS_UNIVERSAL_MERKLE,
  FRAXTAL_SD_FXS,
} from "../utils/constants";
import { 
  generateSdTokensMerkle, 
  SdTokensMerkleConfig 
} from "../utils/merkle/sdTokensMerkleGenerator";
import { MerkleData } from "../interfaces/MerkleData";
import { Distribution } from "../interfaces/Distribution";
import { distributionVerifier } from "../utils/merkle/distributionVerifier";
import { fetchLastProposalsIds } from "../utils/snapshot";

dotenv.config();

// FXS token address
const FXS_ADDRESS = "0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0";

async function main() {
  const args = process.argv.slice(2);
  
  // Parse command line arguments
  let timestamp: number | undefined;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) {
      timestamp = parseInt(args[i + 1]);
      i++;
    }
  }
  
  // Use timestamp or calculate current period
  const currentPeriodTimestamp = timestamp || Math.floor(Date.now() / 1000 / WEEK) * WEEK;
  const prevWeekTimestamp = currentPeriodTimestamp - WEEK;
  
  console.log(`Generating sdFXS merkle for period: ${currentPeriodTimestamp}`);
  console.log(`sdFXS token address: ${FRAXTAL_SD_FXS}`);
  
  try {
    // Configuration for sdFXS Merkle
    const config: SdTokensMerkleConfig = {
      space: SDFXS_SPACE,
      sdToken: FRAXTAL_SD_FXS,
      sdTokenSymbol: "sdFXS",
      rawTokens: [{
        address: FXS_ADDRESS,
        symbol: "FXS"
      }],
      merkleContract: SDFXS_UNIVERSAL_MERKLE,
      outputFileName: "sdtkns_merkle_252.json"  // Fixed to match actual output filename
    };
    
    // Generate sdTokens Merkle using shared utility
    const result = await generateSdTokensMerkle(config, currentPeriodTimestamp);
    
    if (!result) {
      console.error("Failed to generate Universal Merkle for sdFXS");
      process.exit(1);
    }
    
    // Save the merkle data to sdTkns directory
    const outputDir = path.join(
      __dirname,
      "..",
      "..",
      "bounties-reports",
      currentPeriodTimestamp.toString(),
      "sdTkns"
    );
    
    // Create sdTkns directory if it doesn't exist
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Save as sdtkns_merkle_252.json for Fraxtal
    const outputPath = path.join(outputDir, "sdtkns_merkle_252.json");
    fs.writeFileSync(outputPath, JSON.stringify(result.merkleData, null, 2));
    
    // Save to latest directory
    const latestDir = path.join(__dirname, "..", "..", "bounties-reports", "latest", "sdTkns");
    if (!fs.existsSync(latestDir)) {
      fs.mkdirSync(latestDir, { recursive: true });
    }
    const latestPath = path.join(latestDir, "sdtkns_merkle_252.json");
    fs.writeFileSync(latestPath, JSON.stringify(result.merkleData, null, 2));
    
    console.log("\n✅ Merkle trees generated and saved successfully.");
    console.log(`Merkle Root: ${result.merkleData.merkleRoot}`);
    console.log(`Total users: ${Object.keys(result.merkleData.claims).length}`);
    
    // Log summary statistics
    console.log("\nDistribution Summary:");
    for (const [tokenSymbol, stats] of Object.entries(result.statistics)) {
      const totalFormatted = BigNumber.from(stats.total).div(BigNumber.from(10).pow(18)).toString();
      console.log(`${tokenSymbol}: ${totalFormatted} tokens to ${stats.recipients} recipients`);
    }
    
    console.log(`\nFiles saved to:`);
    console.log(`- ${outputPath}`);
    console.log(`- ${latestPath}`);
    
    // Step: Load previous merkle data for verification
    const previousMerkleDataPath = path.join(
      __dirname,
      `../../bounties-reports/${prevWeekTimestamp}/sdTkns/sdtkns_merkle_252.json`
    );
    let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
    if (fs.existsSync(previousMerkleDataPath)) {
      previousMerkleData = JSON.parse(
        fs.readFileSync(previousMerkleDataPath, "utf-8")
      );
      console.log("Loaded previous merkle data for verification");
    }
    
    // Step: Calculate week's distribution (difference between current and previous)
    const weekDistribution: Distribution = {};
    
    // For each address in current merkle
    for (const [address, currentClaim] of Object.entries(result.merkleData.claims)) {
      const previousClaim = previousMerkleData.claims[address];
      const addressDistribution: { tokens: { [token: string]: bigint } } = { tokens: {} };
      
      // For each token in current claim
      for (const [token, currentTokenData] of Object.entries(currentClaim.tokens)) {
        const currentAmount = BigInt(currentTokenData.amount);
        const previousAmount = previousClaim?.tokens[token] 
          ? BigInt(previousClaim.tokens[token].amount) 
          : 0n;
        
        const weekAmount = currentAmount - previousAmount;
        if (weekAmount > 0n) {
          addressDistribution.tokens[token] = weekAmount;
        }
      }
      
      // Only add to distribution if there are tokens
      if (Object.keys(addressDistribution.tokens).length > 0) {
        weekDistribution[address] = addressDistribution;
      }
    }
    
    // Step: Run distribution verification
    try {
      const filter = "*Gauge vote.*$";
      const now = Math.floor(Date.now() / 1000);
      const proposalIdPerSpace = await fetchLastProposalsIds([SDFXS_SPACE], now, filter);
      const proposalId = proposalIdPerSpace[SDFXS_SPACE];
      
      if (proposalId) {
        console.log(`\nRunning verification against proposal: ${proposalId}`);
        
        await distributionVerifier(
          SDFXS_SPACE,
          mainnet,
          SDFXS_UNIVERSAL_MERKLE,
          result.merkleData,
          previousMerkleData,
          weekDistribution,
          proposalId,
          "252"
        );
      } else {
        console.log("\nNo proposal found for verification");
      }
    } catch (error) {
      console.error("Error running distribution verifier:", error);
    }
    
    // Log contract address
    console.log(`\nUniversal Merkle Contract: ${SDFXS_UNIVERSAL_MERKLE}`);
    
  } catch (error) {
    console.error("Error generating sdFXS merkle:", error);
    process.exit(1);
  }
}

main().catch(console.error);
