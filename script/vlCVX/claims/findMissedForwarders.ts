import { getClient, CVX_SPACE, VOTIUM_FORWARDER, VOTIUM_FORWARDER_REGISTRY, DELEGATION_ADDRESS } from "../../utils/constants";
import { createPublicClient, http, getAddress } from "viem";
import { mainnet } from "../../utils/chains";
import { getProposal, getVoters, fetchLastProposalsIds } from "../../utils/snapshot";
import { getForwardedDelegators } from "../../utils/delegationHelper";
import { getBlockNumberByTimestamp } from "../../utils/chainUtils";
import fs from "fs";
import path from "path";

interface MissedForwarder {
  address: string;
  votingPower: number;
  proposalId: string;
  proposalTitle: string;
  voteChoices: any;
}

/**
 * Find forwarders that were missed in previous periods
 */
export async function findMissedForwarders(
  periodTimestamp: number,
  space: string = CVX_SPACE
): Promise<MissedForwarder[]> {
  console.log("=".repeat(80));
  console.log(`Finding missed forwarders for period ${periodTimestamp}`);
  console.log(`Date: ${new Date(periodTimestamp * 1000).toUTCString()}`);
  console.log("=".repeat(80));

  const missedForwarders: MissedForwarder[] = [];

  try {
    // Get proposals for that period
    const proposalIds = await fetchLastProposalsIds(
      [space],
      periodTimestamp + 604800, // Add one week to get proposals from that period
      "Gauge Weight for Week of"
    );
    
    const proposalId = proposalIds[space];
    if (!proposalId) {
      console.log("No proposal found for this period");
      return missedForwarders;
    }

    const proposal = await getProposal(proposalId);
    console.log(`\nProposal: ${proposal.title}`);
    console.log(`Period: ${new Date(proposal.start * 1000).toUTCString()}`);

    // Get all voters
    const voters = await getVoters(proposalId);
    console.log(`Total voters: ${voters.length}`);

    // Get snapshot block
    const blockSnapshotEnd = await getBlockNumberByTimestamp(
      proposal.end,
      "after",
      1
    );

    // Check if we have the old forwarders file
    const forwardersFilePath = path.join(
      "weekly-bounties",
      periodTimestamp.toString(),
      "votium",
      "forwarders_voted_rewards.json"
    );

    let existingForwarders: string[] = [];
    if (fs.existsSync(forwardersFilePath)) {
      const data = JSON.parse(fs.readFileSync(forwardersFilePath, "utf-8"));
      if (data.forwarders) {
        existingForwarders = data.forwarders.map((f: any) => 
          (typeof f === "string" ? f : f.address).toLowerCase()
        );
      } else if (data.tokenAllocations) {
        existingForwarders = Object.keys(data.tokenAllocations).map(a => a.toLowerCase());
      }
      console.log(`Found ${existingForwarders.length} existing forwarders in file`);
    } else {
      console.log("No existing forwarders file found");
    }

    // Get ALL voter addresses from the proposal
    const voterAddresses = voters.map((v: any) => v.voter);

    console.log(`\nChecking forwarding status ON-CHAIN for ${voterAddresses.length} voters...`);
    console.log("This checks the Votium Forwarder Registry contract directly at the snapshot block");

    // Check forwarding status in batches
    const batchSize = 50; // Smaller batches for reliability
    const allForwardedStatuses: string[] = [];
    
    for (let i = 0; i < voterAddresses.length; i += batchSize) {
      const batch = voterAddresses.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(voterAddresses.length / batchSize);
      
      console.log(`Processing batch ${batchNum}/${totalBatches} (checking ${batch.length} addresses on-chain)...`);
      
      try {
        const forwardedAddresses = await getForwardedDelegators(batch, blockSnapshotEnd);
        allForwardedStatuses.push(...forwardedAddresses);
      } catch (error) {
        console.error(`Error processing batch ${batchNum}:`, error);
        // Try one by one if batch fails
        console.log(`Retrying batch ${batchNum} one by one...`);
        for (const addr of batch) {
          try {
            const result = await getForwardedDelegators([addr], blockSnapshotEnd);
            allForwardedStatuses.push(result[0] || "");
          } catch (e) {
            console.error(`Failed to check ${addr}:`, e);
            allForwardedStatuses.push("");
          }
        }
      }
    }

    // Find voters who forwarded to Votium but aren't in existing list
    voterAddresses.forEach((voterAddress: string, index: number) => {
      const forwardedTo = allForwardedStatuses[index]?.toLowerCase();
      const voterLower = voterAddress.toLowerCase();
      
      if (forwardedTo === VOTIUM_FORWARDER.toLowerCase()) {
        // This voter forwarded to Votium
        if (!existingForwarders.includes(voterLower)) {
          // They were missed!
          const vote = voters.find((v: any) => v.voter.toLowerCase() === voterLower);
          
          missedForwarders.push({
            address: voterLower,
            votingPower: vote?.vp || 0,
            proposalId: proposal.id,
            proposalTitle: proposal.title,
            voteChoices: vote?.choice || {},
          });
        }
      }
    });

    console.log(`\n🔍 Found ${missedForwarders.length} missed forwarders`);
    
    if (missedForwarders.length > 0) {
      console.log("\nMissed forwarders:");
      missedForwarders.forEach(forwarder => {
        console.log(`\n- Address: ${forwarder.address}`);
        console.log(`  Voting Power: ${(forwarder.votingPower / 1e18).toFixed(2)} veCRV`);
        console.log(`  Vote choices: ${JSON.stringify(forwarder.voteChoices)}`);
      });
    }

    return missedForwarders;

  } catch (error) {
    console.error("Error finding missed forwarders:", error);
    return missedForwarders;
  }
}

/**
 * Check a specific address to see if they were a forwarder
 */
export async function checkAddressForwarding(
  address: string,
  periodTimestamp: number,
  space: string = CVX_SPACE
): Promise<void> {
  console.log("=".repeat(80));
  console.log(`Checking forwarding status for ${address}`);
  console.log(`Period: ${periodTimestamp} (${new Date(periodTimestamp * 1000).toUTCString()})`);
  console.log("=".repeat(80));

  try {
    // Get proposal
    const proposalIds = await fetchLastProposalsIds(
      [space],
      periodTimestamp + 604800,
      "Gauge Weight for Week of"
    );
    
    const proposalId = proposalIds[space];
    if (!proposalId) {
      console.log("No proposal found for this period");
      return;
    }

    const proposal = await getProposal(proposalId);
    const voters = await getVoters(proposalId);
    
    // Find if they voted
    const vote = voters.find((v: any) => v.voter.toLowerCase() === address.toLowerCase());
    
    if (!vote) {
      console.log(`\n❌ Address ${address} did not vote in this proposal`);
      return;
    }

    console.log(`\n✅ Address voted in proposal: ${proposal.title}`);
    console.log(`Voting Power: ${(vote.vp / 1e18).toFixed(2)} veCRV`);
    console.log(`Choices: ${JSON.stringify(vote.choice)}`);

    // Check forwarding status
    const blockSnapshotEnd = await getBlockNumberByTimestamp(proposal.end, "after", 1);
    const forwardedAddresses = await getForwardedDelegators([address], blockSnapshotEnd);
    const forwardedTo = forwardedAddresses[0]?.toLowerCase();

    console.log(`\nForwarding status:`);
    console.log(`Forwarded to: ${forwardedTo || "Not forwarded"}`);
    
    if (forwardedTo === VOTIUM_FORWARDER.toLowerCase()) {
      console.log("✅ This address WAS forwarding to Votium!");
      
      // Check if they're in the rewards file
      const forwardersFilePath = path.join(
        "weekly-bounties",
        periodTimestamp.toString(),
        "votium",
        "forwarders_voted_rewards.json"
      );
      
      if (fs.existsSync(forwardersFilePath)) {
        const data = JSON.parse(fs.readFileSync(forwardersFilePath, "utf-8"));
        const addressLower = address.toLowerCase();
        
        let found = false;
        if (data.forwarders) {
          found = data.forwarders.some((f: any) => 
            (typeof f === "string" ? f : f.address).toLowerCase() === addressLower
          );
        } else if (data.tokenAllocations) {
          found = addressLower in data.tokenAllocations;
        }
        
        if (found) {
          console.log("✅ Address is in the rewards file");
        } else {
          console.log("❌ Address is NOT in the rewards file - they were missed!");
        }
      }
    } else {
      console.log("❌ This address was not forwarding to Votium");
    }

  } catch (error) {
    console.error("Error checking address:", error);
  }
}

// Main function
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log("Usage:");
    console.log("  Find missed forwarders: ts-node findMissedForwarders.ts <periodTimestamp>");
    console.log("  Check specific address: ts-node findMissedForwarders.ts <address> <periodTimestamp>");
    console.log("\nExample:");
    console.log("  ts-node findMissedForwarders.ts 1749686400");
    console.log("  ts-node findMissedForwarders.ts 0x0D0Db6402196fb090Cd251A1503b5688A30A6116 1749686400");
    process.exit(1);
  }

  if (args[0].startsWith("0x")) {
    // Check specific address
    const address = args[0];
    const periodTimestamp = parseInt(args[1]);
    
    if (isNaN(periodTimestamp)) {
      console.error("Invalid period timestamp");
      process.exit(1);
    }
    
    await checkAddressForwarding(address, periodTimestamp);
  } else {
    // Find all missed forwarders
    const periodTimestamp = parseInt(args[0]);
    
    if (isNaN(periodTimestamp)) {
      console.error("Invalid period timestamp");
      process.exit(1);
    }
    
    const missed = await findMissedForwarders(periodTimestamp);
    
    // Save results
    if (missed.length > 0) {
      const outputPath = `missed_forwarders_${periodTimestamp}.json`;
      fs.writeFileSync(outputPath, JSON.stringify(missed, null, 2));
      console.log(`\nResults saved to: ${outputPath}`);
    }
  }
}

// Run if called directly
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}