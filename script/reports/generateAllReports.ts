import { execSync } from "child_process";
import path from "path";

/**
 * Generate reports for all protocols
 * Uses the regular generateReport.ts for curve, balancer, fxn
 * Uses the special generateReportFrax.ts for frax
 */
async function main() {
  const protocols = ["curve", "balancer", "fxn"];
  
  console.log("Generating reports for all protocols...\n");
  
  // Generate reports for regular protocols
  for (const protocol of protocols) {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Generating report for ${protocol.toUpperCase()}`);
    console.log(`${"=".repeat(50)}\n`);
    
    try {
      execSync(`npx ts-node ${path.join(__dirname, "generateReport.ts")} ${protocol}`, {
        stdio: 'inherit',
        cwd: path.join(__dirname, "../..")
      });
    } catch (error) {
      console.error(`Error generating report for ${protocol}:`, error);
      process.exit(1);
    }
  }
  
  // Generate report for frax using special script
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Generating report for FRAX (using Fraxtal sdFXS amount)`);
  console.log(`${"=".repeat(50)}\n`);
  
  try {
    execSync(`npx ts-node ${path.join(__dirname, "generateReportFrax.ts")}`, {
      stdio: 'inherit',
      cwd: path.join(__dirname, "../..")
    });
  } catch (error) {
    console.error(`Error generating report for frax:`, error);
    process.exit(1);
  }
  
  console.log(`\n${"=".repeat(50)}`);
  console.log("All reports generated successfully!");
  console.log(`${"=".repeat(50)}\n`);
}

main().catch(console.error);