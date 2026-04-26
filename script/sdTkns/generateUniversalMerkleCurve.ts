import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { BigNumber } from "ethers";
import { mainnet } from "../utils/chains";
import {
  SDCRV_SPACE,
  WEEK,
  SDCRV_UNIVERSAL_MERKLE,
  SD_CRV,
  SPACES_UNDERLYING_TOKEN,
} from "../utils/constants";
import {
  generateSdTokensMerkle,
  SdTokensMerkleConfig
} from "../utils/merkle/sdTokensMerkleGenerator";
import { findPreviousMerkle } from "../utils/merkle/findPreviousMerkle";
import { Distribution } from "../interfaces/Distribution";
import { distributionVerifier } from "../utils/merkle/distributionVerifier";
import { fetchLastProposalsIds } from "../utils/snapshot";
import { generateMerkleTree } from "../shared/merkle/generateMerkleTree";

dotenv.config();

const CRV_ADDRESS = SPACES_UNDERLYING_TOKEN[SDCRV_SPACE];

async function main() {
  const args = process.argv.slice(2);

  let timestamp: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) {
      timestamp = parseInt(args[i + 1]);
      i++;
    }
  }

  const currentPeriodTimestamp = timestamp || Math.floor(Date.now() / 1000 / WEEK) * WEEK;

  console.log(`Generating sdCRV merkle for period: ${currentPeriodTimestamp}`);
  console.log(`sdCRV token address: ${SD_CRV}`);

  try {
    const { data: previousMerkleData, foundAt: prevFoundAt } = findPreviousMerkle(
      currentPeriodTimestamp,
      "sdTkns/sdtkns_merkle_1_sdcrv.json"
    );
    if (prevFoundAt) {
      console.log(`Loaded previous merkle data for cumulative calculation from ${prevFoundAt}`);
    } else {
      console.log("No previous merkle data found, starting fresh");
    }

    const config: SdTokensMerkleConfig = {
      space: SDCRV_SPACE,
      sdToken: SD_CRV,
      sdTokenSymbol: "sdCRV",
      rawTokens: [{
        address: CRV_ADDRESS,
        symbol: "CRV"
      }],
      merkleContract: SDCRV_UNIVERSAL_MERKLE,
      outputFileName: "sdtkns_merkle_1_sdcrv.json"
    };

    const weekResult = await generateSdTokensMerkle(config, currentPeriodTimestamp);

    if (!weekResult) {
      console.error("Failed to generate Universal Merkle for sdCRV");
      process.exit(1);
    }

    console.log("\nThis week's distribution generated");

    const cumulativeClaims: any = {};

    for (const [address, prevClaim] of Object.entries(previousMerkleData.claims)) {
      cumulativeClaims[address] = {
        tokens: {}
      };
      for (const [token, tokenData] of Object.entries((prevClaim as any).tokens)) {
        cumulativeClaims[address].tokens[token] = {
          amount: (tokenData as any).amount,
          proof: []
        };
      }
    }

    for (const [address, weekClaim] of Object.entries(weekResult.merkleData.claims)) {
      if (!cumulativeClaims[address]) {
        cumulativeClaims[address] = { tokens: {} };
      }

      for (const [token, weekTokenData] of Object.entries((weekClaim as any).tokens)) {
        const weekAmount = BigInt((weekTokenData as any).amount);

        if (!cumulativeClaims[address].tokens[token]) {
          cumulativeClaims[address].tokens[token] = {
            amount: weekAmount.toString(),
            proof: []
          };
        } else {
          const prevAmount = BigInt(cumulativeClaims[address].tokens[token].amount);
          cumulativeClaims[address].tokens[token].amount = (prevAmount + weekAmount).toString();
        }
      }
    }

    const cumulativeUniversalMerkle: { [address: string]: { [tokenAddress: string]: string } } = {};
    for (const [address, claim] of Object.entries(cumulativeClaims)) {
      const claimData = claim as any;
      cumulativeUniversalMerkle[address] = {};
      for (const [token, tokenData] of Object.entries(claimData.tokens)) {
        const data = tokenData as any;
        cumulativeUniversalMerkle[address][token] = data.amount;
      }
    }

    const cumulativeMerkleData = generateMerkleTree(cumulativeUniversalMerkle);

    const outputDir = path.join(
      __dirname,
      "..",
      "..",
      "bounties-reports",
      currentPeriodTimestamp.toString(),
      "sdTkns"
    );

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, "sdtkns_merkle_1_sdcrv.json");
    fs.writeFileSync(outputPath, JSON.stringify(cumulativeMerkleData, null, 2));

    const latestDir = path.join(__dirname, "..", "..", "bounties-reports", "latest", "sdTkns");
    if (!fs.existsSync(latestDir)) {
      fs.mkdirSync(latestDir, { recursive: true });
    }
    const latestPath = path.join(latestDir, "sdtkns_merkle_1_sdcrv.json");
    fs.writeFileSync(latestPath, JSON.stringify(cumulativeMerkleData, null, 2));

    console.log("\n✅ Cumulative merkle trees generated and saved successfully.");
    console.log(`Merkle Root: ${cumulativeMerkleData.merkleRoot}`);
    console.log(`Total users: ${Object.keys(cumulativeMerkleData.claims).length}`);

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

      if (Object.keys(addressDistribution.tokens).length > 0) {
        weekDistribution[address] = addressDistribution;
      }
    }

    console.log("\nWeek Distribution Summary:");
    const weekStats: { [token: string]: { total: bigint; recipients: number } } = {};

    for (const [, dist] of Object.entries(weekDistribution)) {
      for (const [token, amount] of Object.entries(dist.tokens)) {
        if (!weekStats[token]) {
          weekStats[token] = { total: 0n, recipients: 0 };
        }
        weekStats[token].total += amount;
        weekStats[token].recipients++;
      }
    }

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

    try {
      const filter = "*Gauge vote.*$";
      const now = Math.floor(Date.now() / 1000);
      const proposalIdPerSpace = await fetchLastProposalsIds([SDCRV_SPACE], now, filter);
      const proposalId = proposalIdPerSpace[SDCRV_SPACE];

      if (proposalId) {
        console.log(`\nRunning verification against proposal: ${proposalId}`);

        await distributionVerifier(
          SDCRV_SPACE,
          mainnet,
          SDCRV_UNIVERSAL_MERKLE as `0x${string}`,
          cumulativeMerkleData,
          previousMerkleData,
          weekDistribution,
          proposalId,
          "1"
        );
      } else {
        console.log("\nNo proposal found for verification");
      }
    } catch (error) {
      console.error("Error running distribution verifier:", error);
    }

    console.log(`\nUniversal Merkle Contract: ${SDCRV_UNIVERSAL_MERKLE}`);

  } catch (error) {
    console.error("Error generating sdCRV merkle:", error);
    process.exit(1);
  }
}

main().catch(console.error);
