import { 
  DELEGATION_ADDRESS, 
  SDPENDLE_SPACE,
  SPACE_TO_CHAIN_ID
} from "../utils/constants";
import { ChoiceBribe } from "../utils/utils";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stageAPR } from "../utils/apr/publishDelegationAPRs";
const { parse } = require("csv-parse/sync");

/**
 * Read VoteMarket gauges from pendle-votemarket.csv and pendle-otc.csv for a given week
 * 
 * @param week - The week timestamp
 * @returns Set of VM gauge addresses (lowercase)
 */
export const getVMGaugesFromCSV = (week: number): Set<string> => {
  const csvPaths = [
    join(process.cwd(), "bounties-reports", week.toString(), "pendle-votemarket.csv"),
    join(process.cwd(), "bounties-reports", week.toString(), "pendle-otc.csv"),
  ];
  
  const vmGauges = new Set<string>();
  
  for (const csvPath of csvPaths) {
    if (!existsSync(csvPath)) continue;
    
    const csvContent = readFileSync(csvPath, "utf-8");
    
    // Parse CSV with semicolon delimiter (as seen in the sample)
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      delimiter: ";",
    });
    
    // Extract unique gauge addresses from the CSV
    for (const row of records) {
      const gaugeAddress = row["Gauge Address"] || row["gauge address"];
      if (gaugeAddress) {
        vmGauges.add(gaugeAddress.toLowerCase());
      }
    }
  }
  
  if (vmGauges.size === 0) {
    console.warn(`No external CSV (votemarket/otc) found for week ${week}`);
  } else {
    console.log(`Found ${vmGauges.size} VM gauges from external CSVs for week ${week}`);
  }
  
  return vmGauges;
};

/**
 * Calculate voting power for SDPENDLE delegation that went to VoteMarket gauges
 * Only considers delegation voting power allocated to gauges from pendle-otc.csv
 * 
 * @param voters - Array of voters with their choices and voting power
 * @param addressesPerChoice - Map of gauge addresses to choice indices
 * @param delegationTotalRewards - Total rewards earned by delegation
 * @param week - The week timestamp to read pendle-otc.csv
 * @returns Object with VP and rewards for APR calculation
 */
export const calculateSdPendleVMVotingPower = (
  voters: any[],
  addressesPerChoice: Record<string, ChoiceBribe>,
  delegationTotalRewards: number,
  week: number
): { vp: number; amount: number; logs: string[] } => {
  const logs: string[] = [];
  
  // Get VM gauges from pendle-otc.csv
  const vmGauges = getVMGaugesFromCSV(week);
  
  // Find delegation voter
  const delegationVoter = voters.find(
    (v) => v.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
  );
  
  if (!delegationVoter || !delegationVoter.vp || delegationVoter.vp <= 0) {
    logs.push("No delegation voter found or no voting power");
    return { vp: 0, amount: 0, logs };
  }
  
  // Get the indices of VoteMarket gauges that match our CSV
  const vmGaugeIndices = new Set<number>();
  for (const [gaugeAddress, choiceData] of Object.entries(addressesPerChoice)) {
    if (vmGauges.has(gaugeAddress.toLowerCase())) {
      vmGaugeIndices.add(choiceData.index);
    }
  }
  
  let vmDelegationVP = 0;
  
  if (delegationVoter.choice && Object.keys(delegationVoter.choice).length > 0) {
    // Calculate total VP weight for VM gauges from delegation's choices
    let totalChoiceWeight = 0;
    let vmChoiceWeight = 0;
    
    for (const [choiceIndexStr, weight] of Object.entries(delegationVoter.choice)) {
      const choiceIndex = parseInt(choiceIndexStr);
      const choiceWeight = weight as number;
      totalChoiceWeight += choiceWeight;
      
      // Check if this choice index is a VM gauge
      if (vmGaugeIndices.has(choiceIndex)) {
        vmChoiceWeight += choiceWeight;
      }
    }
    
    // Calculate the proportion of delegation VP that went to VM gauges
    if (totalChoiceWeight > 0) {
      const vmRatio = vmChoiceWeight / totalChoiceWeight;
      vmDelegationVP = delegationVoter.vp * vmRatio;
      
      logs.push(`Total delegation VP: ${delegationVoter.vp}`);
      logs.push(`VM gauges weight: ${vmChoiceWeight}/${totalChoiceWeight} (${(vmRatio * 100).toFixed(2)}%)`);
      logs.push(`VM delegation VP for APR: ${vmDelegationVP.toFixed(2)}`);
      logs.push(`Total rewards: ${delegationTotalRewards}`);
    } else {
      logs.push("No choice weights found");
    }
  } else {
    logs.push("Delegation has no choices");
  }
  
  // Use VM delegation VP if calculated, otherwise use total delegation VP as fallback
  const vpForAPR = vmDelegationVP > 0 ? vmDelegationVP : delegationVoter.vp;
  
  return {
    vp: vpForAPR,
    amount: delegationTotalRewards,
    logs
  };
};

/**
 * Calculate final APR value for SDPENDLE delegators
 * 
 * TODO: Add support for regular Pendle gauges (pendle.csv)
 * - Check if pendle.csv exists for the week (appears ~monthly)
 * - Extract multiple periods/timestamps from the CSV
 * - Fetch proposals for each period
 * - Calculate rewards and VP for regular gauges
 * - Compute separate APR for regular gauges
 * - Return both VM APR and Regular APR, plus total
 * 
 * @param aprs - Array of APR data points with vp and amount
 * @returns Calculated APR percentage
 */
export const computeSdPendleDelegatorsAPR = (aprs: Array<{ vp: number; amount: number }>): number => {
  if (aprs.length === 0) {
    return 0;
  }
  
  const sumRewards = aprs.reduce((acc, aprData) => acc + aprData.amount, 0);
  const vpAverage = aprs.reduce((acc, aprData) => acc + aprData.vp, 0) / aprs.length;
  
  if (vpAverage === 0) {
    return 0;
  }
  
  // Weekly rewards * 52 weeks * 100 for percentage
  return (sumRewards / vpAverage) * 52 * 100;
};

/**
 * Main function to compute SDPENDLE delegators APR
 * Can be run directly: npx ts-node script/helpers/computeSdPendleDelegatorsAPR.ts [week_timestamp]
 */
async function main() {
  const args = process.argv.slice(2);
  const now = Date.now() / 1000;
  const WEEK = 604800; // 7 days in seconds
  const week = args[0] ? parseInt(args[0]) : Math.floor(now / WEEK) * WEEK;
  
  console.log(`\n=== SDPENDLE Delegators APR Calculation ===`);
  console.log(`Week: ${week} (${new Date(week * 1000).toISOString().split('T')[0]})`);
  console.log(`Space: ${SDPENDLE_SPACE}`);
  
  try {
    // Fetch proposals for the week
    const { fetchLastProposalsIds } = await import("../utils/snapshot");
    const proposalIdPerSpace = await fetchLastProposalsIds(
      [SDPENDLE_SPACE],
      week + WEEK,
      "all"
    );
    
    const proposalId = proposalIdPerSpace[SDPENDLE_SPACE];
    if (!proposalId) {
      console.error(`No proposal found for ${SDPENDLE_SPACE} in week ${week}`);
      process.exit(1);
    }
    
    console.log(`Found proposal: ${proposalId}`);
    
    // Get proposal details
    const { getProposal, getVoters, getVotingPower, formatVotingPowerResult } = await import("../utils/snapshot");
    const { extractProposalChoices, addVotersFromAutoVoter } = await import("../utils/utils");
    
    const proposal = await getProposal(proposalId);
    
    // Get pendle rewards from external CSVs (votemarket and otc)
    const vmCsvPath = join(process.cwd(), "bounties-reports", week.toString(), "pendle-votemarket.csv");
    const otcCsvPath = join(process.cwd(), "bounties-reports", week.toString(), "pendle-otc.csv");
    
    if (!existsSync(vmCsvPath) && !existsSync(otcCsvPath)) {
      console.error(`No external CSV (votemarket/otc) found for week ${week}`);
      process.exit(1);
    }
    
    // Helper to read rewards from a CSV file
    const readRewardsFromCsv = (csvPath: string): Record<string, number> => {
      if (!existsSync(csvPath)) return {};
      const csvContent = readFileSync(csvPath, "utf-8");
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        delimiter: ";",
      });
      const rewards: Record<string, number> = {};
      for (const row of records) {
        const gaugeAddress = row["Gauge Address"]?.toLowerCase();
        const rewardAmount = parseFloat(row["Reward sd Value"] || "0");
        if (gaugeAddress) {
          rewards[gaugeAddress] = (rewards[gaugeAddress] || 0) + rewardAmount;
        }
      }
      return rewards;
    };
    
    // Read and merge rewards from both files
    const vmRewards = readRewardsFromCsv(vmCsvPath);
    const otcRewards = readRewardsFromCsv(otcCsvPath);
    
    const pendleRewards: Record<string, number> = { ...vmRewards };
    for (const [gauge, amount] of Object.entries(otcRewards)) {
      pendleRewards[gauge] = (pendleRewards[gauge] || 0) + amount;
    }
    
    // Extract choices and get only VM gauges
    const allAddressesPerChoice = extractProposalChoices(proposal);
    const { getChoicesBasedOnReport } = await import("../utils/utils");
    const addressesPerChoice = getChoicesBasedOnReport(allAddressesPerChoice, pendleRewards);
    
    // Get voters
    let voters = await getVoters(proposalId);
    const vps = await getVotingPower(
      proposal,
      voters.map((v: any) => v.voter),
      SPACE_TO_CHAIN_ID[SDPENDLE_SPACE]
    );
    
    voters = formatVotingPowerResult(voters, vps);
    voters = await addVotersFromAutoVoter(
      SDPENDLE_SPACE,
      proposal,
      voters,
      allAddressesPerChoice
    );
    
    // Filter out auto voter
    voters = voters.filter(
      (voter: any) =>
        voter.voter.toLowerCase() !== "0x8bBF0c99cc5Eb98177cc42eC397dc542c4903E0a".toLowerCase() // AUTO_VOTER_DELEGATION_ADDRESS
    );
    
    // Find delegation vote and calculate rewards
    const delegationVote = voters.find(
      (v: any) => v.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
    );
    
    if (!delegationVote) {
      console.error("No delegation vote found");
      process.exit(1);
    }
    
    // Calculate rewards for each voter based on their voting power allocation to gauges
    // This follows the same logic as in createMultiMerkle.ts
    for (const voter of voters) {
      voter.totalRewards = 0;
    }
    
    // Process each gauge and distribute rewards
    for (const [gaugeAddress, choiceData] of Object.entries(addressesPerChoice)) {
      const index = choiceData.index;
      const sdTknRewardAmount = pendleRewards[gaugeAddress.toLowerCase()] || 0;
      
      if (sdTknRewardAmount === 0) continue;
      
      // Calculate total VP used for this gauge
      let totalVP = 0;
      for (const voter of voters) {
        let vpChoiceSum = 0;
        let currentChoiceIndex = 0;
        
        for (const choiceIndex of Object.keys(voter.choice || {})) {
          if (index === parseInt(choiceIndex)) {
            currentChoiceIndex = voter.choice[choiceIndex];
          }
          vpChoiceSum += voter.choice[choiceIndex];
        }
        
        if (currentChoiceIndex === 0) continue;
        
        const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
        totalVP += (voter.vp * ratio) / 100;
      }
      
      if (totalVP === 0) continue;
      
      // Distribute rewards proportionally to VP
      for (const voter of voters) {
        let vpChoiceSum = 0;
        let currentChoiceIndex = 0;
        
        for (const choiceIndex of Object.keys(voter.choice || {})) {
          if (index === parseInt(choiceIndex)) {
            currentChoiceIndex = voter.choice[choiceIndex];
          }
          vpChoiceSum += voter.choice[choiceIndex];
        }
        
        if (currentChoiceIndex === 0) continue;
        
        const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
        const vpUsed = (voter.vp * ratio) / 100;
        const totalVPRatio = (vpUsed * 100) / totalVP;
        const amountEarned = (totalVPRatio * sdTknRewardAmount) / 100;
        
        voter.totalRewards += amountEarned;
      }
    }
    
    // Get delegation's total rewards
    const delegationRewards = delegationVote.totalRewards || 0;
    
    // Calculate VM-specific voting power
    const vmVPData = calculateSdPendleVMVotingPower(
      voters,
      addressesPerChoice,
      delegationRewards,
      week
    );
    
    console.log("\nVM VP Calculation:");
    vmVPData.logs.forEach(log => console.log(`  ${log}`));
    
    // Calculate final APR
    const finalAPR = computeSdPendleDelegatorsAPR([vmVPData]);
    
    console.log("\n=== Results ===");
    console.log(`Final SDPENDLE Delegators APR: ${finalAPR.toFixed(4)}%`);
    
    // Stage APR for later publishing (publisher will merge with existing APRs)
    await stageAPR({
      space: "sdpendle.eth",
      apr: finalAPR,
      periodTimestamp: week,
    });
    console.log(`Staged sdpendle.eth APR: ${finalAPR.toFixed(4)}%`);
    
  } catch (error) {
    console.error("Error during APR calculation:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
}
