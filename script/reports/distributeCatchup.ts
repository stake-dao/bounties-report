// ABOUTME: Distributes catchup SD value proportionally across protocol CSV reports
// ABOUTME: Handles OTC double-counting corrections by adding back diluted amounts

import * as fs from "fs";
import * as path from "path";

interface CSVRow {
  gaugeName: string;
  gaugeAddress: string;
  rewardToken: string;
  rewardAddress: string;
  rewardAmount: number;
  rewardSdValue: number;
  sharePercentage: number;
}

/**
 * Parse a CSV file with semicolon delimiter
 */
function parseCSV(filePath: string): CSVRow[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");

  // Skip header
  const dataLines = lines.slice(1);

  return dataLines.map((line) => {
    const [
      gaugeName,
      gaugeAddress,
      rewardToken,
      rewardAddress,
      rewardAmount,
      rewardSdValue,
      sharePercentage,
    ] = line.split(";");

    return {
      gaugeName: gaugeName.trim(),
      gaugeAddress: gaugeAddress.trim(),
      rewardToken: rewardToken.trim(),
      rewardAddress: rewardAddress.trim(),
      rewardAmount: parseFloat(rewardAmount),
      rewardSdValue: parseFloat(rewardSdValue),
      sharePercentage: parseFloat(sharePercentage),
    };
  });
}

/**
 * Write CSV rows to file
 */
function writeCSV(filePath: string, rows: CSVRow[]): void {
  const header =
    "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol\n";

  const dataLines = rows.map(
    (row) =>
      `${row.gaugeName};${row.gaugeAddress};${row.rewardToken};${row.rewardAddress};${row.rewardAmount.toFixed(6)};${row.rewardSdValue.toFixed(2)};${row.sharePercentage.toFixed(2)}`
  );

  fs.writeFileSync(filePath, header + dataLines.join("\n"), "utf-8");
}

/**
 * Distribute catchup amount proportionally across CSV rows
 */
function distributeCatchup(
  inputPath: string,
  catchupAmount: number,
  outputPath?: string
): void {
  console.log(`\n📊 Processing: ${path.basename(inputPath)}`);
  console.log(`💰 Catchup amount to distribute: ${catchupAmount.toFixed(2)}`);

  // Parse existing CSV
  const rows = parseCSV(inputPath);

  // Calculate current total
  const currentTotal = rows.reduce((sum, row) => sum + row.rewardSdValue, 0);
  console.log(`📈 Current total SD value: ${currentTotal.toFixed(2)}`);

  // Distribute proportionally
  const updatedRows = rows.map((row) => {
    const proportion = row.rewardSdValue / currentTotal;
    const additionalSd = proportion * catchupAmount;
    const newSdValue = row.rewardSdValue + additionalSd;

    return {
      ...row,
      rewardSdValue: newSdValue,
    };
  });

  // Recalculate share percentages
  const newTotal = updatedRows.reduce((sum, row) => sum + row.rewardSdValue, 0);
  const finalRows = updatedRows.map((row) => ({
    ...row,
    sharePercentage: (row.rewardSdValue / newTotal) * 100,
  }));

  // Verify total
  const verifyTotal = finalRows.reduce((sum, row) => sum + row.rewardSdValue, 0);
  const expectedTotal = currentTotal + catchupAmount;
  const difference = Math.abs(verifyTotal - expectedTotal);

  console.log(`✅ New total SD value: ${verifyTotal.toFixed(2)}`);
  console.log(`🎯 Expected total: ${expectedTotal.toFixed(2)}`);
  console.log(`📊 Difference: ${difference.toFixed(6)} (rounding)`);

  // Verify share percentages sum to ~100%
  const totalSharePercentage = finalRows.reduce(
    (sum, row) => sum + row.sharePercentage,
    0
  );
  console.log(
    `📈 Total share percentage: ${totalSharePercentage.toFixed(2)}%`
  );

  // Write output
  const output = outputPath || inputPath;
  writeCSV(output, finalRows);
  console.log(`💾 Saved to: ${output}\n`);
}

/**
 * Main execution
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length < 2 || args.length > 3) {
    console.error(`
Usage: tsx script/reports/distributeCatchup.ts <csv-path> <catchup-amount> [output-path]

Arguments:
  csv-path       Path to the CSV file to process
  catchup-amount Amount of SD value to distribute proportionally
  output-path    (Optional) Output path. If not provided, overwrites input file

Examples:
  # Process Curve CSV, add 1532.2 SD value
  tsx script/reports/distributeCatchup.ts bounties-reports/1761177600/curve.csv 1532.2

  # Process FXN CSV, save to new file
  tsx script/reports/distributeCatchup.ts bounties-reports/1761177600/fxn.csv 500 bounties-reports/1761177600/fxn-updated.csv

  # Process Pendle CSV
  tsx script/reports/distributeCatchup.ts bounties-reports/1761177600/pendle.csv 250.5
`);
    process.exit(1);
  }

  const [csvPath, catchupAmountStr, outputPath] = args;
  const catchupAmount = parseFloat(catchupAmountStr);

  if (isNaN(catchupAmount)) {
    console.error(`❌ Error: Invalid catchup amount: ${catchupAmountStr}`);
    process.exit(1);
  }

  if (!fs.existsSync(csvPath)) {
    console.error(`❌ Error: File not found: ${csvPath}`);
    process.exit(1);
  }

  distributeCatchup(csvPath, catchupAmount, outputPath);
}

main();
