import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getSpectraDistribution, SpectraClaimed } from "./utils";

dotenv.config();

const WEEK = 604800;
const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

function writeReportToCSV(rows: SpectraClaimed[]) {
  const dirPath = path.join(
    __dirname,
    "..",
    "..",
    "bounties-reports",
    currentPeriod.toString()
  );
  fs.mkdirSync(dirPath, { recursive: true });

  const csvContent = [
    "Gauge Name;Pool Address;Reward Token;Reward Address;Reward Amount;",
    ...rows.map(
      (row) =>
        `${row.name};${row.poolAddress};${row.tokenRewardSymbol};${row.tokenRewardAddress};${row.amount.toString()};`
    ),
  ].join("\n");

  const fileName = `spectra.csv`;
  fs.writeFileSync(path.join(dirPath, fileName), csvContent);
  console.log(`Report generated for Spectra: ${fileName}`);
}

async function main() {
  const report = await getSpectraDistribution();
  writeReportToCSV(report);
}

main().catch(console.error);
