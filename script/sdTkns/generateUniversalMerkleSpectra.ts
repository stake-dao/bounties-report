import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { getAddress } from "viem";
import {
  DELEGATION_ADDRESS,
  SPECTRA_SPACE,
  SD_SPECTRA,
  WEEK,
} from "../utils/constants";
import { generateMerkleTree } from "../shared/merkle/generateMerkleTree";
import { MerkleData } from "../interfaces/MerkleData";
import { createCombineDistribution } from "../utils/merkle/merkle";
import { fetchTokenInfos } from "../utils/tokens";
import { base } from "../utils/chains";
import { Distribution } from "../interfaces/Distribution";
import { distributionVerifier } from "../utils/merkle/distributionVerifier";
import { getLastClosedProposals } from "../utils/snapshot";

dotenv.config();

// Spectra Universal Merkle Contract on Base
const SPECTRA_MERKLE_ADDRESS = "0x665d334388012d17f1d197de72b7b708ffccb67d" as `0x${string}`;

function compareMerkleData(
  title: string,
  newMerkle: MerkleData,
  previousMerkle: MerkleData,
  tokenInfo: { [address: string]: { symbol: string; decimals: number } }
) {
  console.log(`\n=== ${title} ===`);

  // Collect all tokens from both merkles
  const tokens = new Set<string>();
  [newMerkle.claims, previousMerkle.claims].forEach((claims) => {
    Object.values(claims).forEach((claim) => {
      if (claim.tokens) {
        Object.keys(claim.tokens).forEach((token) =>
          tokens.add(token.toLowerCase())
        );
      }
    });
  });

  // For each token, show distribution
  tokens.forEach((token) => {
    // Find token info
    const info = Object.entries(tokenInfo).find(
      ([addr, _]) => addr.toLowerCase() === token
    )?.[1] || { symbol: "UNKNOWN", decimals: 18 };

    // Calculate totals
    const newTotal = Object.values(newMerkle.claims).reduce((acc, claim) => {
      const amount =
        claim.tokens?.[token]?.amount ||
        claim.tokens?.[getAddress(token)]?.amount ||
        "0";
      return acc + BigInt(amount);
    }, 0n);

    const prevTotal = Object.values(previousMerkle.claims).reduce(
      (acc, claim) => {
        const amount =
          claim.tokens?.[token]?.amount ||
          claim.tokens?.[getAddress(token)]?.amount ||
          "0";
        return acc + BigInt(amount);
      },
      0n
    );

    const newTotalFormatted = Number(newTotal) / 10 ** info.decimals;
    const prevTotalFormatted = Number(prevTotal) / 10 ** info.decimals;
    const diffTotal = newTotalFormatted - prevTotalFormatted;

    console.log(`\n--- ${info.symbol} Distribution ---`);
    console.log(
      `Previous Total: ${prevTotalFormatted.toFixed(2)} ${info.symbol}`
    );
    console.log(`New Total: ${newTotalFormatted.toFixed(2)} ${info.symbol}`);
    console.log(
      `Difference: ${diffTotal > 0 ? "+" : ""}${diffTotal.toFixed(2)} ${
        info.symbol
      }`
    );

    if (newTotal > 0n || prevTotal > 0n) {
      console.log("\nTop 10 holders:");

      // Get all addresses and their amounts
      const addresses = new Set([
        ...Object.keys(newMerkle.claims),
        ...Object.keys(previousMerkle.claims),
      ]);

      const holders = Array.from(addresses).map((address) => {
        const newAmount = BigInt(
          newMerkle.claims[address]?.tokens?.[token]?.amount ||
            newMerkle.claims[address]?.tokens?.[getAddress(token)]?.amount ||
            "0"
        );
        const prevAmount = BigInt(
          previousMerkle.claims[address]?.tokens?.[token]?.amount ||
            previousMerkle.claims[address]?.tokens?.[getAddress(token)]
              ?.amount ||
            "0"
        );
        return {
          address,
          newAmount,
          prevAmount,
          share: Number((newAmount * 10000n) / (newTotal || 1n)) / 100,
        };
      });

      // Sort by new amount and show top 10
      holders
        .sort((a, b) => Number(b.newAmount - a.newAmount))
        .filter((holder) => Number(holder.newAmount) > 0)
        .slice(0, 10)
        .forEach((holder) => {
          const newAmountFormatted =
            Number(holder.newAmount) / 10 ** info.decimals;
          const prevAmountFormatted =
            Number(holder.prevAmount) / 10 ** info.decimals;
          const diff = newAmountFormatted - prevAmountFormatted;

          const addressDisplay =
            holder.address === DELEGATION_ADDRESS
              ? "STAKE DELEGATION (0x52ea...)"
              : `${holder.address.slice(0, 6)}...${holder.address.slice(-4)}`;

          let diffStr = "";
          if (diff !== 0) {
            const diffPercentage =
              prevTotalFormatted > 0
                ? ((newAmountFormatted - prevAmountFormatted) / prevAmountFormatted) * 100
                : 100;
            diffStr = ` (${diff > 0 ? "+" : ""}${diff.toFixed(2)} ${info.symbol}, ${
              diff > 0 ? "+" : ""
            }${diffPercentage.toFixed(1)}%)`;
          }

          console.log(
            `  ${addressDisplay}: ${holder.share.toFixed(
              2
            )}% - ${newAmountFormatted.toFixed(2)} ${info.symbol}${diffStr}`
          );
        });
    }
  });
}

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
  
  // Use timestamp, PAST_WEEK env, or calculate current period
  const pastWeek = process.env.PAST_WEEK ? parseInt(process.env.PAST_WEEK) : 0;
  const currentPeriodTimestamp = timestamp || (Math.floor(Date.now() / 1000 / WEEK) * WEEK - (pastWeek * WEEK));
  const prevWeekTimestamp = currentPeriodTimestamp - WEEK;

  console.log(`Generating sdSpectra merkle for period: ${currentPeriodTimestamp}`);
  console.log(`sdSpectra token address: ${SD_SPECTRA}`);

  try {
    // Step 1: Load distributions from spectra directory
    const pathDir = path.join(__dirname, `../../bounties-reports/${currentPeriodTimestamp}/spectra`);
    const pathDirPrevious = path.join(__dirname, `../../bounties-reports/${prevWeekTimestamp}/spectra`);

    const currentDistributionPath = path.join(pathDir, "repartition.json");
    
    if (!fs.existsSync(currentDistributionPath)) {
      console.error(`Distribution file not found: ${currentDistributionPath}`);
      console.log("Please run the Spectra distribution scripts first.");
      process.exit(1);
    }
    
    const currentDistribution: { distribution: Distribution } = JSON.parse(
      fs.readFileSync(currentDistributionPath, "utf-8")
    );

    // Step 2: Load previous merkle data from sdTkns directory (if exists)
    const previousMerkleDataPath = path.join(
      __dirname,
      `../../bounties-reports/${prevWeekTimestamp}/sdTkns/sdtkns_merkle_8453.json`
    );
    let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
    if (fs.existsSync(previousMerkleDataPath)) {
      previousMerkleData = JSON.parse(
        fs.readFileSync(previousMerkleDataPath, "utf-8")
      );
      console.log("Loaded previous merkle data from sdTkns directory");
    } else {
      // Fallback to spectra directory for backward compatibility
      const fallbackPath = path.join(pathDirPrevious, "merkle_data.json");
      if (fs.existsSync(fallbackPath)) {
        previousMerkleData = JSON.parse(
          fs.readFileSync(fallbackPath, "utf-8")
        );
        console.log("Loaded previous merkle data from spectra directory (fallback)");
      }
    }

    // Step 3: Combine current distribution with previous amounts
    const merkleData = createCombineDistribution(currentDistribution, previousMerkleData);

    // Step 4: Generate merkle
    const newMerkleData = generateMerkleTree(merkleData);

    // Step 5: Retrieve token info
    const tokenInfo = await fetchTokenInfos(newMerkleData, previousMerkleData, base);

    // Compare merkle data
    compareMerkleData(
      "Distribution Changes",
      newMerkleData,
      previousMerkleData,
      tokenInfo
    );

    // Step 6: Checksum all addresses
    newMerkleData.claims = Object.fromEntries(
      Object.entries(newMerkleData.claims).map(([address, claim]) => [
        getAddress(address),
        claim,
      ])
    );

    // Step 7: Save merkle data to sdTkns directory (primary location)
    const sdTknsDir = path.join(__dirname, `../../bounties-reports/${currentPeriodTimestamp}/sdTkns`);
    if (!fs.existsSync(sdTknsDir)) {
      fs.mkdirSync(sdTknsDir, { recursive: true });
    }
    
    const sdTknsMerklePath = path.join(sdTknsDir, "sdtkns_merkle_8453.json");
    fs.writeFileSync(sdTknsMerklePath, JSON.stringify(newMerkleData, null, 2));

    console.log("\n✅ Merkle trees generated and saved successfully.");
    console.log(`Merkle Root: ${newMerkleData.merkleRoot}`);
    console.log(`Total users: ${Object.keys(newMerkleData.claims).length}`);
    
    // Log distribution summary
    const totalAmounts: { [token: string]: bigint } = {};
    const uniqueRecipients: { [token: string]: Set<string> } = {};
    
    Object.entries(newMerkleData.claims).forEach(([address, claim]) => {
      if (claim.tokens) {
        Object.entries(claim.tokens).forEach(([token, data]) => {
          const normalizedToken = token.toLowerCase();
          if (!totalAmounts[normalizedToken]) {
            totalAmounts[normalizedToken] = 0n;
            uniqueRecipients[normalizedToken] = new Set();
          }
          totalAmounts[normalizedToken] += BigInt(data.amount);
          uniqueRecipients[normalizedToken].add(address);
        });
      }
    });
    
    console.log("\nDistribution Summary:");
    Object.entries(totalAmounts).forEach(([token, total]) => {
      const info = tokenInfo[token] || tokenInfo[getAddress(token)] || { symbol: "UNKNOWN", decimals: 18 };
      const formatted = Number(total) / 10 ** info.decimals;
      console.log(`${info.symbol}: ${formatted.toFixed(2)} tokens to ${uniqueRecipients[token].size} recipients`);
    });
    
    // Also save to spectra directory for backward compatibility
    const merkleDataPath = path.join(pathDir, "merkle_data.json");
    fs.writeFileSync(merkleDataPath, JSON.stringify(newMerkleData, null, 2));

    console.log(`\nFiles saved to:`);
    console.log(`- ${sdTknsMerklePath} (primary)`);
    console.log(`- ${merkleDataPath} (backward compatibility)`);

    // Step 8: Verification
    // Bounties are claimed for the PREVIOUS voting period
    const proposals = await getLastClosedProposals(SPECTRA_SPACE, 2 + pastWeek);
    const proposal = proposals[1 + pastWeek];
    const proposalId = proposal.id;

    console.log(`\nRunning verification against proposal: ${proposalId}`);
    
    await distributionVerifier(
      SPECTRA_SPACE, 
      base, 
      SPECTRA_MERKLE_ADDRESS, 
      newMerkleData, 
      previousMerkleData, 
      currentDistribution.distribution, 
      proposalId, 
      "8453"
    );
    
    // Log contract address
    console.log(`\nUniversal Merkle Contract: ${SPECTRA_MERKLE_ADDRESS}`);
    
  } catch (error) {
    console.error("Error generating sdSpectra merkle:", error);
    process.exit(1);
  }
}

main().catch(console.error);
