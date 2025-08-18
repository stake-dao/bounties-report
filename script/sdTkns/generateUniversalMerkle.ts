import { generateSdTokensMerkle, SdTokensMerkleConfig } from "../utils/merkle/sdTokensMerkleGenerator.js";
import * as fs from "fs";
import * as path from "path";
import { BigNumber } from "ethers";
import dotenv from "dotenv";
import { FRAXTAL_SD_FXS, SD_SPECTRA } from "../utils/constants.js";
dotenv.config();

const SD_TOKEN_CONFIGS = {
  sdFXS: {
    spaceId: "sdfxs.eth",
    tokenAddress: FRAXTAL_SD_FXS,
    chainId: 252, // Fraxtal
    merkleContract: "0x87E97DDab1B1Dc956C26351b38390352F1821b18", // SDFXS_UNIVERSAL_MERKLE
    csvPath: "bounties-reports/{timestamp}/sdFXS.csv",
    outputPath: "bounties-reports/{timestamp}/sdTkns/sdtkns_merkle_252.json",
    rawTokens: [{
      address: "0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0", // FXS
      symbol: "FXS"
    }]
  },
  sdSpectra: {
    spaceId: "sdspectra.eth",
    tokenAddress: SD_SPECTRA,
    chainId: 8453, // Base
    merkleContract: "", // TODO: Add Spectra universal merkle contract when available
    csvPath: "bounties-reports/{timestamp}/spectra/sdSPECTRA.csv",
    outputPath: "bounties-reports/{timestamp}/sdTkns/sdtkns_merkle_8453.json",
    rawTokens: [{
      address: "0xF5c3aD57b1C3F5cEe211833CAc8760b9C55fF7A9", // SPECTRA
      symbol: "SPECTRA"
    }]
  }
};

async function main() {
  const args = process.argv.slice(2);
  
  // Parse command line arguments
  let timestamp: number | undefined;
  let tokenType: string | undefined;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) {
      timestamp = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === "--token" && args[i + 1]) {
      tokenType = args[i + 1];
      i++;
    }
  }
  
  // Validate token type
  if (!tokenType || !SD_TOKEN_CONFIGS[tokenType as keyof typeof SD_TOKEN_CONFIGS]) {
    console.error("Error: Invalid or missing token type");
    console.log("Usage: npx tsx script/sdTkns/generateUniversalMerkle.ts --token <sdFXS|sdSpectra> [--timestamp <timestamp>]");
    console.log("Available tokens:", Object.keys(SD_TOKEN_CONFIGS).join(", "));
    process.exit(1);
  }
  
  const config = SD_TOKEN_CONFIGS[tokenType as keyof typeof SD_TOKEN_CONFIGS];
  
  try {
    // Use timestamp or calculate current period
    const periodTimestamp = timestamp || Math.floor(Date.now() / 1000) - (Math.floor(Date.now() / 1000) % 604800);
    
    // Replace timestamp placeholder in output path
    const outputPath = config.outputPath.replace("{timestamp}", periodTimestamp.toString());
    
    // Create merkle config
    const merkleConfig: SdTokensMerkleConfig = {
      space: config.spaceId,
      sdToken: config.tokenAddress,
      sdTokenSymbol: tokenType.toUpperCase(),
      rawTokens: config.rawTokens,
      merkleContract: config.merkleContract,
      outputFileName: path.basename(outputPath) // Just the filename for previous merkle lookup
    };
    
    const result = await generateSdTokensMerkle(merkleConfig, periodTimestamp);
    
    if (result) {
      // Create output directory if it doesn't exist
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      // Save the merkle data
      fs.writeFileSync(outputPath, JSON.stringify(result.merkleData, null, 2));
      
      console.log(`✅ Successfully generated merkle for ${tokenType} on chain ${config.chainId}`);
      console.log(`Output saved to: ${outputPath}`);
      console.log(`Merkle Root: ${result.merkleData.merkleRoot}`);
      console.log(`Total users: ${Object.keys(result.merkleData.claims).length}`);
      
      // Log summary statistics
      console.log(`\nDistribution Summary:`);
      for (const [tokenSymbol, stats] of Object.entries(result.statistics)) {
        const totalFormatted = BigNumber.from(stats.total).div(BigNumber.from(10).pow(18)).toString();
        console.log(`${tokenSymbol}: ${totalFormatted} tokens to ${stats.recipients} recipients`);
      }
      
      // Log contract address
      if (config.merkleContract) {
        console.log(`\nUniversal Merkle Contract: ${config.merkleContract}`);
      }
    } else {
      console.log(`No merkle data generated for ${tokenType}`);
    }
  } catch (error) {
    console.error(`Error generating merkle for ${tokenType}:`, error);
    process.exit(1);
  }
}

main().catch(console.error);