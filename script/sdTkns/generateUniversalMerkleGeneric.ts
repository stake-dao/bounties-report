import * as dotenv from "dotenv";
import * as moment from "moment";
import * as fs from "fs";
import * as path from "path";
import { BigNumber } from "ethers";

import {
  SDCRV_SPACE,
  SDBAL_SPACE,
  SDANGLE_SPACE,
  SDPENDLE_SPACE,
  SDFXN_SPACE,
  SD_CRV,
  SD_BAL,
  SD_ANGLE,
  SD_PENDLE,
  SD_FXN,
  WEEK,
} from "../utils/constants";
import { 
  generateUniversalMerkle, 
  UniversalMerkleConfig 
} from "../utils/universalMerkleGenerator";

dotenv.config();

// Token configurations for different protocols
const TOKEN_CONFIGS: Record<string, UniversalMerkleConfig> = {
  curve: {
    space: SDCRV_SPACE,
    sdToken: SD_CRV,
    sdTokenSymbol: "sdCRV",
    rawTokens: [{
      address: "0xD533a949740bb3306d119CC777fa900bA034cd52", // CRV
      symbol: "CRV"
    }],
    merkleContract: process.env.SDCRV_UNIVERSAL_MERKLE || "0x0000000000000000000000000000000000000000",
    outputFileName: "universal_merkle_curve.json"
  },
  balancer: {
    space: SDBAL_SPACE,
    sdToken: SD_BAL,
    sdTokenSymbol: "sdBAL",
    rawTokens: [{
      address: "0x5c6Ee304399DBdB9C8Ef030aB642B10820DB8F56", // 80BAL-20WETH
      symbol: "BAL"
    }],
    merkleContract: process.env.SDBAL_UNIVERSAL_MERKLE || "0x0000000000000000000000000000000000000000",
    outputFileName: "universal_merkle_balancer.json"
  },
  angle: {
    space: SDANGLE_SPACE,
    sdToken: SD_ANGLE,
    sdTokenSymbol: "sdANGLE",
    rawTokens: [{
      address: "0x31429d1856aD1377A8A0079410B297e1a9e214c2", // ANGLE
      symbol: "ANGLE"
    }],
    merkleContract: process.env.SDANGLE_UNIVERSAL_MERKLE || "0x0000000000000000000000000000000000000000",
    outputFileName: "universal_merkle_angle.json"
  },
  pendle: {
    space: SDPENDLE_SPACE,
    sdToken: SD_PENDLE,
    sdTokenSymbol: "sdPENDLE",
    rawTokens: [{
      address: "0x808507121B80c02388fAd14726482e061B8da827", // PENDLE
      symbol: "PENDLE"
    }],
    merkleContract: process.env.SDPENDLE_UNIVERSAL_MERKLE || "0x0000000000000000000000000000000000000000",
    outputFileName: "universal_merkle_pendle.json"
  },
  fxn: {
    space: SDFXN_SPACE,
    sdToken: SD_FXN,
    sdTokenSymbol: "sdFXN",
    rawTokens: [{
      address: "0x365AccFCa291e7D3914637ABf1F7635dB165Bb09", // FXN
      symbol: "FXN"
    }],
    merkleContract: process.env.SDFXN_UNIVERSAL_MERKLE || "0x0000000000000000000000000000000000000000",
    outputFileName: "universal_merkle_fxn.json"
  }
};

const main = async () => {
  // Get protocol from command line arguments
  const protocol = process.argv[2];
  
  if (!protocol || !TOKEN_CONFIGS[protocol]) {
    console.error("Please specify a valid protocol:");
    console.error("Available protocols:", Object.keys(TOKEN_CONFIGS).join(", "));
    console.error("Usage: npm run generate:universal-merkle <protocol>");
    process.exit(1);
  }
  
  const now = moment.utc().unix();
  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;
  
  const config = TOKEN_CONFIGS[protocol];
  
  // Generate Universal Merkle using shared utility
  const result = await generateUniversalMerkle(config, currentPeriodTimestamp);
  
  if (!result) {
    console.error(`Failed to generate Universal Merkle for ${protocol}`);
    return;
  }
  
  // Save the merkle data
  const outputPath = path.join(
    __dirname,
    "..",
    "..",
    "bounties-reports",
    currentPeriodTimestamp.toString(),
    config.outputFileName
  );
  
  fs.writeFileSync(outputPath, JSON.stringify(result.merkleData, null, 2));
  
  console.log(`Universal Merkle for ${protocol} generated and saved to ${outputPath}`);
  console.log(`Merkle Root: ${result.merkleData.merkleRoot}`);
  console.log(`Total users: ${Object.keys(result.merkleData.claims).length}`);
  
  // Log summary statistics
  console.log(`\nDistribution Summary:`);
  for (const [tokenSymbol, stats] of Object.entries(result.statistics)) {
    const totalFormatted = BigNumber.from(stats.total).div(BigNumber.from(10).pow(18)).toString();
    console.log(`${tokenSymbol}: ${totalFormatted} tokens to ${stats.recipients} recipients`);
  }
  
  // Log contract address
  console.log(`\nUniversal Merkle Contract: ${config.merkleContract}`);
};

main().catch(console.error);