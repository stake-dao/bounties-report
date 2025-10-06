import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";
import { sendTelegramMessage } from "../utils/telegramUtils";

dotenv.config();

const WEEK = 604800;

interface ClaimedBounty {
  bountyId: string;
  gauge: string;
  amount: string;
  rewardToken: string;
}

interface ClaimedBountiesFile {
  timestamp1: number;
  timestamp2: number;
  blockNumber1: number;
  blockNumber2: number;
  votemarket?: {
    curve?: Record<string, ClaimedBounty>;
    fxn?: Record<string, ClaimedBounty>;
  };
  votemarket_v2?: {
    curve?: Record<string, ClaimedBounty>;
    fxn?: Record<string, ClaimedBounty>;
  };
  votium?: Record<string, ClaimedBounty>;
}

interface CSVRow {
  gaugeName: string;
  gaugeAddress: string;
  rewardToken: string;
  rewardAddress: string;
  rewardAmount: string;
}

interface ValidationResult {
  timestamp: number;
  isValid: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    claimedBountiesExists: boolean;
    csvReportsExist: boolean;
    curveClaims: number;
    fxnClaims: number;
    votiumClaims: number;
    totalClaims: number;
    curveCSVRows: number;
    fxnCSVRows: number;
    totalCSVRows: number;
  };
}

/**
 * Parse CSV file and count rows
 */
function parseCSV(filePath: string): CSVRow[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");
  
  // Skip header and filter empty lines
  const dataLines = lines.slice(1).filter(line => line.trim());
  
  return dataLines.map(line => {
    const parts = line.split(";");
    return {
      gaugeName: parts[0] || "",
      gaugeAddress: parts[1] || "",
      rewardToken: parts[2] || "",
      rewardAddress: parts[3] || "",
      rewardAmount: parts[4] || "0",
    };
  });
}

/**
 * Count claims from claimed_bounties.json
 */
function countClaims(claimedBounties: ClaimedBountiesFile): {
  curve: number;
  fxn: number;
  votium: number;
  total: number;
} {
  let curve = 0;
  let fxn = 0;
  let votium = 0;

  // Count votemarket claims
  if (claimedBounties.votemarket?.curve) {
    curve += Object.keys(claimedBounties.votemarket.curve).length;
  }
  if (claimedBounties.votemarket?.fxn) {
    fxn += Object.keys(claimedBounties.votemarket.fxn).length;
  }

  // Count votemarket_v2 claims
  if (claimedBounties.votemarket_v2?.curve) {
    curve += Object.keys(claimedBounties.votemarket_v2.curve).length;
  }
  if (claimedBounties.votemarket_v2?.fxn) {
    fxn += Object.keys(claimedBounties.votemarket_v2.fxn).length;
  }

  // Count votium claims
  if (claimedBounties.votium) {
    votium = Object.keys(claimedBounties.votium).length;
  }

  return {
    curve,
    fxn,
    votium,
    total: curve + fxn + votium,
  };
}

/**
 * Verify claims completeness for a specific period
 */
function verifyPeriod(timestamp: number): ValidationResult {
  const result: ValidationResult = {
    timestamp,
    isValid: true,
    errors: [],
    warnings: [],
    summary: {
      claimedBountiesExists: false,
      csvReportsExist: false,
      curveClaims: 0,
      fxnClaims: 0,
      votiumClaims: 0,
      totalClaims: 0,
      curveCSVRows: 0,
      fxnCSVRows: 0,
      totalCSVRows: 0,
    },
  };

  // Check claimed_bounties.json - multiple possible locations
  const possibleClaimsPaths = [
    // New location (votemarket-v2)
    path.join(__dirname, `../../weekly-bounties/${timestamp}/votemarket-v2/claimed_bounties_convex.json`),
    // Legacy location
    path.join(__dirname, `../../weekly-bounties/${timestamp}/claimed_bounties.json`),
    // Votemarket v1 location
    path.join(__dirname, `../../weekly-bounties/${timestamp}/votemarket/claimed_bounties_convex.json`),
  ];

  let claimedBountiesPath: string | undefined;
  let claimedBounties: any;

  // Try all possible locations
  for (const possiblePath of possibleClaimsPaths) {
    if (fs.existsSync(possiblePath)) {
      claimedBountiesPath = possiblePath;
      break;
    }
  }

  if (!claimedBountiesPath) {
    result.errors.push(
      `❌ Missing claimed_bounties files. Checked:\n` +
      possibleClaimsPaths.map(p => `     - ${p}`).join('\n')
    );
    result.isValid = false;
  } else {
    result.summary.claimedBountiesExists = true;
    
    try {
      const fileContent = fs.readFileSync(claimedBountiesPath, "utf-8");
      const parsedData = JSON.parse(fileContent);
      
      // Handle different file formats
      // New format: { curve: {...}, fxn: {...} }
      // Old format: { votemarket: { curve: {...} }, votemarket_v2: { ... }, votium: {...} }
      
      if (parsedData.votemarket || parsedData.votemarket_v2 || parsedData.votium) {
        // Old format
        claimedBounties = parsedData;
      } else if (parsedData.curve || parsedData.fxn) {
        // New format - convert to old format for compatibility
        claimedBounties = {
          votemarket_v2: parsedData,
        };
      } else {
        throw new Error("Unknown claims file format");
      }

      const claims = countClaims(claimedBounties);
      result.summary.curveClaims = claims.curve;
      result.summary.fxnClaims = claims.fxn;
      result.summary.votiumClaims = claims.votium;
      result.summary.totalClaims = claims.total;

      if (claims.total === 0) {
        result.errors.push(
          "❌ claimed_bounties file exists but contains 0 claims"
        );
        result.isValid = false;
      }
    } catch (error) {
      result.errors.push(
        `❌ Error parsing claimed_bounties file: ${error}`
      );
      result.isValid = false;
    }
  }

  // Check CSV reports
  const cvxCSVPath = path.join(
    __dirname,
    `../../bounties-reports/${timestamp}/cvx.csv`
  );
  const fxnCSVPath = path.join(
    __dirname,
    `../../bounties-reports/${timestamp}/cvx_fxn.csv`
  );

  let csvExists = false;

  // Check Curve CSV
  if (fs.existsSync(cvxCSVPath)) {
    csvExists = true;
    const rows = parseCSV(cvxCSVPath);
    result.summary.curveCSVRows = rows.length;

    if (rows.length === 0) {
      result.warnings.push("⚠️  cvx.csv exists but is empty");
    }
  } else {
    result.warnings.push("⚠️  Missing cvx.csv");
  }

  // Check FXN CSV
  if (fs.existsSync(fxnCSVPath)) {
    csvExists = true;
    const rows = parseCSV(fxnCSVPath);
    result.summary.fxnCSVRows = rows.length;

    if (rows.length === 0) {
      result.warnings.push("⚠️  cvx_fxn.csv exists but is empty");
    }
  } else {
    result.warnings.push("⚠️  Missing cvx_fxn.csv");
  }

  result.summary.csvReportsExist = csvExists;
  result.summary.totalCSVRows =
    result.summary.curveCSVRows + result.summary.fxnCSVRows;

  if (!csvExists) {
    result.errors.push("❌ No CSV reports found (cvx.csv or cvx_fxn.csv)");
    result.isValid = false;
  }

    // Cross-validate: claims should roughly match CSV rows
    if (
      result.summary.claimedBountiesExists &&
      result.summary.csvReportsExist
    ) {
      // Check if there's a significant mismatch (>10% difference)
      const totalExpected = result.summary.totalCSVRows;
      const totalActual = result.summary.totalClaims;
      const diff = Math.abs(totalActual - totalExpected);
      const percentDiff = totalExpected > 0 ? (diff / totalExpected) * 100 : 0;

      if (diff > 5 && percentDiff > 10) {
        // Major mismatch - this is an error
        result.errors.push(
          `❌ Major mismatch: ${totalActual} claims vs ${totalExpected} CSV rows (diff: ${diff}, ${percentDiff.toFixed(1)}%)`
        );
        result.isValid = false;
      } else if (diff > 2) {
        // Minor mismatch - this is a warning
        result.warnings.push(
          `⚠️  Mismatch: ${totalActual} claims vs ${totalExpected} CSV rows (diff: ${diff})`
        );
      }

      // Specific checks for Curve
      if (
        result.summary.curveClaims === 0 &&
        result.summary.curveCSVRows > 0
      ) {
        result.errors.push(
          `❌ Missing Curve claims: 0 claims but ${result.summary.curveCSVRows} CSV rows`
        );
        result.isValid = false;
      }

      // Specific checks for FXN
      if (result.summary.fxnClaims === 0 && result.summary.fxnCSVRows > 0) {
        result.warnings.push(
          `⚠️  Missing FXN claims: 0 claims but ${result.summary.fxnCSVRows} CSV rows`
        );
      }
    }

  return result;
}

/**
 * Print validation result
 */
function printResult(result: ValidationResult) {
  const date = new Date(result.timestamp * 1000).toISOString().split("T")[0];
  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `Period: ${result.timestamp} (${date}) ${result.isValid ? "✅" : "❌"}`
  );
  console.log(`${"=".repeat(60)}`);

  // Print summary
  console.log("\n📊 Summary:");
  console.log(
    `  claimed_bounties.json: ${result.summary.claimedBountiesExists ? "✓" : "✗"}`
  );
  console.log(
    `  CSV reports: ${result.summary.csvReportsExist ? "✓" : "✗"}`
  );
  console.log(`  Total claims: ${result.summary.totalClaims}`);
  console.log(`    - Curve: ${result.summary.curveClaims}`);
  console.log(`    - FXN: ${result.summary.fxnClaims}`);
  console.log(`    - Votium: ${result.summary.votiumClaims}`);
  console.log(`  Total CSV rows: ${result.summary.totalCSVRows}`);
  console.log(`    - Curve (cvx.csv): ${result.summary.curveCSVRows}`);
  console.log(`    - FXN (cvx_fxn.csv): ${result.summary.fxnCSVRows}`);

  // Print errors
  if (result.errors.length > 0) {
    console.log("\n🚨 Errors:");
    result.errors.forEach((error) => console.log(`  ${error}`));
  }

  // Print warnings
  if (result.warnings.length > 0) {
    console.log("\n⚠️  Warnings:");
    result.warnings.forEach((warning) => console.log(`  ${warning}`));
  }

  if (result.isValid && result.warnings.length === 0) {
    console.log("\n✅ All checks passed!");
  }
}

/**
 * Send Telegram notification for validation failures
 */
async function sendTelegramNotification(result: ValidationResult) {
  try {
    const date = new Date(result.timestamp * 1000).toISOString().split("T")[0];
    
    let message = `🚨 *vlCVX Claims Verification Failed*\n\n`;
    message += `*Period:* ${result.timestamp} (${date})\n\n`;
    
    // Summary
    message += `📊 *Summary:*\n`;
    message += `• claimed\\_bounties: ${result.summary.claimedBountiesExists ? "✅" : "❌"}\n`;
    message += `• CSV reports: ${result.summary.csvReportsExist ? "✅" : "❌"}\n`;
    message += `• Total claims: ${result.summary.totalClaims}\n`;
    message += `  \\- Curve: ${result.summary.curveClaims}\n`;
    message += `  \\- FXN: ${result.summary.fxnClaims}\n`;
    message += `  \\- Votium: ${result.summary.votiumClaims}\n`;
    message += `• Total CSV rows: ${result.summary.totalCSVRows}\n`;
    message += `  \\- Curve: ${result.summary.curveCSVRows}\n`;
    message += `  \\- FXN: ${result.summary.fxnCSVRows}\n\n`;
    
    // Errors
    if (result.errors.length > 0) {
      message += `🚨 *Errors:*\n`;
      result.errors.forEach((error) => {
        // Escape special characters for MarkdownV2
        const escapedError = error
          .replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&')
          .replace(/❌/g, '❌');
        message += `${escapedError}\n`;
      });
      message += `\n`;
    }
    
    // Warnings
    if (result.warnings.length > 0) {
      message += `⚠️ *Warnings:*\n`;
      result.warnings.forEach((warning) => {
        // Escape special characters for MarkdownV2
        const escapedWarning = warning
          .replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&')
          .replace(/⚠️/g, '⚠️');
        message += `${escapedWarning}\n`;
      });
      message += `\n`;
    }
    
    message += `⛔ *Merkle generation blocked until issues are resolved\\.*\n\n`;
    message += `Run verification manually:\n`;
    message += `\`pnpm tsx script/vlCVX/verifyClaimsCompleteness\\.ts \\-\\-timestamp ${result.timestamp}\``;
    
    await sendTelegramMessage(message);
    console.log("\n✅ Telegram notification sent");
  } catch (error) {
    console.error("\n❌ Failed to send Telegram notification:", error);
  }
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  let timestamp: number | undefined;
  let checkRecent = false;
  let sendTelegram = true; // Default to sending notifications

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) {
      timestamp = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === "--recent") {
      checkRecent = true;
    } else if (args[i] === "--no-telegram") {
      sendTelegram = false;
    }
  }

  if (!timestamp && !checkRecent) {
    // Default to current period
    timestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;
  }

  if (checkRecent) {
    // Check last 5 periods
    const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;
    console.log("\n🔍 Checking last 5 periods for completeness...\n");

    const results: ValidationResult[] = [];
    for (let i = 0; i < 5; i++) {
      const periodTimestamp = currentPeriod - i * WEEK;
      const result = verifyPeriod(periodTimestamp);
      results.push(result);
      printResult(result);
    }

    // Summary
    const invalidCount = results.filter((r) => !r.isValid).length;
    console.log(`\n${"=".repeat(60)}`);
    console.log(
      `Overall: ${invalidCount === 0 ? "✅" : "❌"} ${5 - invalidCount}/5 periods valid`
    );
    console.log(`${"=".repeat(60)}\n`);

    // Send Telegram for first invalid result only
    if (invalidCount > 0 && sendTelegram) {
      const firstInvalid = results.find((r) => !r.isValid);
      if (firstInvalid) {
        await sendTelegramNotification(firstInvalid);
      }
    }

    if (invalidCount > 0) {
      process.exit(1);
    }
  } else if (timestamp) {
    // Check single period
    const result = verifyPeriod(timestamp);
    printResult(result);

    // Send Telegram notification if validation failed
    if (!result.isValid && sendTelegram) {
      await sendTelegramNotification(result);
    }

    if (!result.isValid) {
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
