import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { BigNumber } from "ethers";
import { mainnet } from "../utils/chains";
import {
  SDCRV_SPACE,
  SD_CRV,
  SDCRV_UNIVERSAL_MERKLE,
  SPACES_UNDERLYING_TOKEN,
  WEEK,
} from "../utils/constants";
import {
  generateSdTokensMerkle,
  SdTokensMerkleConfig,
} from "../utils/merkle/sdTokensMerkleGenerator";
import { findPreviousMerkle } from "../utils/merkle/findPreviousMerkle";
import { Distribution } from "../interfaces/Distribution";
import { distributionVerifier } from "../utils/merkle/distributionVerifier";
import { fetchLastProposalsIds } from "../utils/snapshot";
import { generateMerkleTree } from "../shared/merkle/generateMerkleTree";
import { computeDelegationAPR } from "../utils/merkle/delegationApr";

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
    // Step 1: Load previous merkle data, scanning back up to 12 weeks to handle skipped periods
    const { data: previousMerkleData, foundAt: prevFoundAt } = findPreviousMerkle(
      currentPeriodTimestamp,
      "sdTkns/sdtkns_merkle_1_sdcrv.json"
    );
    if (prevFoundAt) {
      console.log(`Loaded previous merkle data for cumulative calculation from ${prevFoundAt}`);
    } else {
      console.log("No previous merkle data found, starting fresh");
    }

    // Step 2: Configuration for sdCRV Merkle
    const config: SdTokensMerkleConfig = {
      space: SDCRV_SPACE,
      sdToken: SD_CRV,
      sdTokenSymbol: "sdCRV",
      rawTokens: [{
        address: CRV_ADDRESS,
        symbol: "CRV",
      }],
      merkleContract: SDCRV_UNIVERSAL_MERKLE,
      outputFileName: "sdtkns_merkle_1_sdcrv.json",
    };

    // Step 3: Generate this week's distribution
    const weekResult = await generateSdTokensMerkle(config, currentPeriodTimestamp);

    if (!weekResult) {
      console.error("Failed to generate Universal Merkle for sdCRV");
      process.exit(1);
    }

    console.log("\nThis week's distribution generated");

    // Step 3b: Compute and persist the sdCRV delegation APR.
    // sdCRV moved to the Universal Merkle, so the APR is no longer produced by
    // generateMerkle.ts (which skips SDCRV_SPACE). Mirror the legacy formula:
    // annualize the delegation's weekly sdCRV rewards over the delegation's
    // voting power in the week's gauge proposal.
    const delegationSdCrvRewards = Object.entries(weekResult.delegationRewards).find(
      ([token]) => token.toLowerCase() === SD_CRV.toLowerCase()
    )?.[1] ?? 0;
    const delegationAPR = computeDelegationAPR(
      delegationSdCrvRewards,
      weekResult.delegationVotingPower
    );
    console.log(
      `sdCRV delegation APR: ${delegationAPR.toFixed(4)}% ` +
        `(rewards: ${delegationSdCrvRewards}, delegationVp: ${weekResult.delegationVotingPower})`
    );

    // Merge into the period's delegationsAPRs.json without clobbering other
    // protocols (same read-merge-write pattern as sdFXS).
    const aprPath = path.join(
      __dirname,
      "..",
      "..",
      "bounties-reports",
      currentPeriodTimestamp.toString(),
      "delegationsAPRs.json"
    );
    let delegationAPRs: Record<string, number> = {};
    if (fs.existsSync(aprPath)) {
      delegationAPRs = JSON.parse(fs.readFileSync(aprPath, "utf-8"));
    }
    if (delegationAPR > 0) {
      delegationAPRs[SDCRV_SPACE] = delegationAPR;
      fs.mkdirSync(path.dirname(aprPath), { recursive: true });
      fs.writeFileSync(aprPath, JSON.stringify(delegationAPRs));
    } else {
      console.warn("sdCRV delegation APR is 0, leaving delegationsAPRs.json unchanged");
    }

    // Step 4: Create cumulative merkle data by adding this week to previous total
    const cumulativeClaims: any = {};

    // First, copy all previous claims
    for (const [address, prevClaim] of Object.entries(previousMerkleData.claims)) {
      const tokens: Record<string, { amount: string; proof: [] }> = {};

      for (const [token, tokenData] of Object.entries((prevClaim as any).tokens)) {
        const amount = BigInt((tokenData as any).amount);
        if (amount <= 0n) continue;

        tokens[token] = {
          amount: amount.toString(),
          proof: [] // Will be recalculated
        };
      }

      if (Object.keys(tokens).length > 0) {
        cumulativeClaims[address] = { tokens };
      }
    }

    // Then add this week's distributions to the cumulative total
    for (const [address, weekClaim] of Object.entries(weekResult.merkleData.claims)) {
      for (const [token, weekTokenData] of Object.entries((weekClaim as any).tokens)) {
        const weekAmount = BigInt((weekTokenData as any).amount);
        if (weekAmount <= 0n) continue;

        if (!cumulativeClaims[address]) {
          cumulativeClaims[address] = { tokens: {} };
        }

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
      const tokens: Record<string, string> = {};

      for (const [token, tokenData] of Object.entries(claimData.tokens)) {
        const data = tokenData as any;
        const amount = BigInt(data.amount);
        if (amount > 0n) {
          tokens[token] = amount.toString();
        }
      }

      if (Object.keys(tokens).length > 0) {
        cumulativeUniversalMerkle[address] = tokens;
      }
    }

    // Step 6: Generate new merkle tree with cumulative data
    const cumulativeMerkleData = generateMerkleTree(cumulativeUniversalMerkle);

    // Step 7: Save the cumulative merkle data to the period directory only.
    // bounties-reports/latest is updated by the publish step, gated on the
    // on-chain root verification (verifyOnchainRoot --target sdcrv).
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

      if (Object.keys(addressDistribution.tokens).length > 0) {
        weekDistribution[address] = addressDistribution;
      }
    }

    // Step 9: Log summary statistics for this week's distribution
    console.log("\nWeek Distribution Summary:");
    const weekStats: { [token: string]: { total: bigint; recipients: number } } = {};

    for (const [, dist] of Object.entries(weekDistribution)) {
      for (const [token, amount] of Object.entries(dist.tokens)) {
        const tokenKey = token.toLowerCase();
        if (!weekStats[tokenKey]) {
          weekStats[tokenKey] = { total: 0n, recipients: 0 };
        }
        weekStats[tokenKey].total += amount;
        weekStats[tokenKey].recipients++;
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

    // Step 10: Run distribution verification
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
          SDCRV_UNIVERSAL_MERKLE,
          cumulativeMerkleData,
          previousMerkleData,
          weekDistribution,
          proposalId
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
