import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { BigNumber } from "ethers";
import { fraxtal } from "../utils/chains";
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
import { generateMerkleTree } from "../shared/merkle/generateMerkleTree";

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
    // Step 1: Load previous merkle data for cumulative tracking
    const previousMerkleDataPath = path.join(
      __dirname,
      `../../bounties-reports/${prevWeekTimestamp}/sdTkns/sdtkns_merkle_252.json`
    );
    let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
    if (fs.existsSync(previousMerkleDataPath)) {
      previousMerkleData = JSON.parse(
        fs.readFileSync(previousMerkleDataPath, "utf-8")
      );
      console.log("Loaded previous merkle data for cumulative calculation");
    } else {
      console.log("No previous merkle data found, starting fresh");
    }
    
    // Step 2: Configuration for sdFXS Merkle
    const config: SdTokensMerkleConfig = {
      space: SDFXS_SPACE,
      sdToken: FRAXTAL_SD_FXS,
      sdTokenSymbol: "sdFXS",
      rawTokens: [{
        address: FXS_ADDRESS,
        symbol: "FXS"
      }],
      merkleContract: SDFXS_UNIVERSAL_MERKLE,
      outputFileName: "sdtkns_merkle_252.json"
    };
    
    // Step 3: Generate this week's distribution
    const weekResult = await generateSdTokensMerkle(config, currentPeriodTimestamp);
    
    if (!weekResult) {
      console.error("Failed to generate Universal Merkle for sdFXS");
      process.exit(1);
    }
    
    console.log("\nThis week's distribution generated");
    
    // Step 4: Create cumulative merkle data by adding this week to previous total
    const cumulativeClaims: any = {};
    
    // First, copy all previous claims
    for (const [address, prevClaim] of Object.entries(previousMerkleData.claims)) {
      cumulativeClaims[address] = {
        tokens: {}
      };
      for (const [token, tokenData] of Object.entries((prevClaim as any).tokens)) {
        cumulativeClaims[address].tokens[token] = {
          amount: (tokenData as any).amount,
          proof: [] // Will be recalculated
        };
      }
    }
    
    // Then add this week's distributions to the cumulative total
    for (const [address, weekClaim] of Object.entries(weekResult.merkleData.claims)) {
      if (!cumulativeClaims[address]) {
        cumulativeClaims[address] = { tokens: {} };
      }
      
      for (const [token, weekTokenData] of Object.entries((weekClaim as any).tokens)) {
        const weekAmount = BigInt((weekTokenData as any).amount);
        
        if (!cumulativeClaims[address].tokens[token]) {
          cumulativeClaims[address].tokens[token] = {
            amount: weekAmount.toString(),
            proof: [] // Will be recalculated
          };
        } else {
          const prevAmount = BigInt(cumulativeClaims[address].tokens[token].amount);
          cumulativeClaims[address].tokens[token].amount = (prevAmount + weekAmount).toString();
        }
      }
    }
    
    // Step 5: Convert cumulative claims to UniversalMerkle format for merkle tree generation
    const cumulativeUniversalMerkle: { [address: string]: { [tokenAddress: string]: string } } = {};
    for (const [address, claim] of Object.entries(cumulativeClaims)) {
      const claimData = claim as any;
      cumulativeUniversalMerkle[address] = {};
      for (const [token, tokenData] of Object.entries(claimData.tokens)) {
        const data = tokenData as any;
        cumulativeUniversalMerkle[address][token] = data.amount; // Already a string
      }
    }
    
    // Step 6: Generate new merkle tree with cumulative data
    const cumulativeMerkleData = generateMerkleTree(cumulativeUniversalMerkle);
    
    // Step 7: Save the cumulative merkle data
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
    fs.writeFileSync(outputPath, JSON.stringify(cumulativeMerkleData, null, 2));
    
    // Save to latest directory
    const latestDir = path.join(__dirname, "..", "..", "bounties-reports", "latest", "sdTkns");
    if (!fs.existsSync(latestDir)) {
      fs.mkdirSync(latestDir, { recursive: true });
    }
    const latestPath = path.join(latestDir, "sdtkns_merkle_252.json");
    fs.writeFileSync(latestPath, JSON.stringify(cumulativeMerkleData, null, 2));
    
    console.log("\n✅ Cumulative merkle trees generated and saved successfully.");
    console.log(`Merkle Root: ${cumulativeMerkleData.merkleRoot}`);
    console.log(`Total users: ${Object.keys(cumulativeMerkleData.claims).length}`);
    
    // Step 8: Calculate this week's distribution for verification and statistics
    const weekDistribution: Distribution = {};
    
    for (const [address, currentClaim] of Object.entries(cumulativeMerkleData.claims)) {
      const previousClaim = previousMerkleData.claims[address];
      const addressDistribution: { tokens: { [token: string]: bigint } } = { tokens: {} };
      
      for (const [token, currentTokenData] of Object.entries((currentClaim as any).tokens)) {
        const currentAmount = BigInt((currentTokenData as any).amount);
        const previousAmount = previousClaim?.tokens[token] 
          ? BigInt((previousClaim.tokens[token] as any).amount) 
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
    
    // Step 9: Log summary statistics for this week's distribution
    console.log("\nWeek Distribution Summary:");
    const weekStats: { [token: string]: { total: bigint; recipients: number } } = {};
    
    for (const [address, dist] of Object.entries(weekDistribution)) {
      for (const [token, amount] of Object.entries(dist.tokens)) {
        if (!weekStats[token]) {
          weekStats[token] = { total: 0n, recipients: 0 };
        }
        weekStats[token].total += amount;
        weekStats[token].recipients++;
      }
    }
    
    // Display week statistics
    const tokenConfig = config.rawTokens || [];
    tokenConfig.push({ address: config.sdToken, symbol: config.sdTokenSymbol });
    
    for (const tokenInfo of tokenConfig) {
      const stats = weekStats[tokenInfo.address.toLowerCase()];
      if (stats) {
        const totalFormatted = BigNumber.from(stats.total).div(BigNumber.from(10).pow(18)).toString();
        console.log(`${tokenInfo.symbol}: ${totalFormatted} tokens to ${stats.recipients} recipients`);
      } else {
        console.log(`${tokenInfo.symbol}: 0 tokens to 0 recipients`);
      }
    }
    
    console.log(`\nFiles saved to:`);
    console.log(`- ${outputPath}`);
    console.log(`- ${latestPath}`);
    
    // Step 10: Run distribution verification
    try {
      const filter = "*Gauge vote.*$";
      const now = Math.floor(Date.now() / 1000);
      const proposalIdPerSpace = await fetchLastProposalsIds([SDFXS_SPACE], now, filter);
      const proposalId = proposalIdPerSpace[SDFXS_SPACE];
      
      if (proposalId) {
        console.log(`\nRunning verification against proposal: ${proposalId}`);
        
        await distributionVerifier(
          SDFXS_SPACE,
          fraxtal,
          SDFXS_UNIVERSAL_MERKLE,
          cumulativeMerkleData,
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