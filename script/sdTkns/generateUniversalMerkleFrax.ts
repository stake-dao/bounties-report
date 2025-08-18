import * as dotenv from "dotenv";
import * as moment from "moment";
import * as fs from "fs";
import * as path from "path";
import { BigNumber } from "ethers";

import {
  SDFXS_SPACE,
  SD_FXS,
  WEEK,
  SDFXS_UNIVERSAL_MERKLE,
  FRAXTAL_SD_FXS,
} from "../utils/constants";
import { 
  generateSdTokensMerkle, 
  SdTokensMerkleConfig 
} from "../utils/merkle/sdTokensMerkleGenerator";

dotenv.config();

// FXS token address
const FXS_ADDRESS = "0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0";

const main = async () => {
  const now = moment.utc().unix();
  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;
  
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
    outputFileName: "universal_merkle_frax.json"
  };
  
  // Generate sdTokens Merkle using shared utility
  const result = await generateSdTokensMerkle(config, currentPeriodTimestamp);
  
  if (!result) {
    console.error("Failed to generate Universal Merkle for sdFXS");
    return;
  }
  
  // Save the merkle data to the new organized location
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
  
  console.log(`sdFXS Merkle for Fraxtal generated and saved to ${outputPath}`);
  console.log(`Merkle Root: ${result.merkleData.merkleRoot}`);
  console.log(`Total users: ${Object.keys(result.merkleData.claims).length}`);
  
  // Log summary statistics
  console.log(`\nDistribution Summary:`);
  for (const [tokenSymbol, stats] of Object.entries(result.statistics)) {
    const totalFormatted = BigNumber.from(stats.total).div(BigNumber.from(10).pow(18)).toString();
    console.log(`${tokenSymbol}: ${totalFormatted} tokens to ${stats.recipients} recipients`);
  }
  
  // Log contract address
  console.log(`\nUniversal Merkle Contract: ${SDFXS_UNIVERSAL_MERKLE}`);

};

main().catch(console.error);