import { getClient, CVX_SPACE, VOTIUM_FORWARDER, VOTIUM_FORWARDER_REGISTRY } from "../../utils/constants";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { getProposal, getVoters, fetchLastProposalsIdsCurrentPeriod } from "../../utils/snapshot";
import { getForwardedDelegators } from "../../utils/delegationHelper";
import { getBlockNumberByTimestamp } from "../../utils/chainUtils";

/**
 * Test forwarder detection for a specific address
 */
async function testForwarderDetection() {
  console.log("=".repeat(80));
  console.log("Testing Forwarder Detection");
  console.log("=".repeat(80));

  // Test address that we know was missed
  const testAddress = "0x0D0Db6402196fb090Cd251A1503b5688A30A6116";

  try {
    // Get current proposal
    const now = Math.floor(Date.now() / 1000);
    const proposalIds = await fetchLastProposalsIdsCurrentPeriod(
      [CVX_SPACE],
      now,
      "^(?!FXN ).*Gauge Weight for Week of"
    );
    
    const proposalId = proposalIds[CVX_SPACE];
    const proposal = await getProposal(proposalId);
    const voters = await getVoters(proposalId);

    console.log(`\nCurrent proposal: ${proposal.title}`);
    console.log(`Total voters: ${voters.length}`);

    // Get snapshot block
    const blockSnapshotEnd = await getBlockNumberByTimestamp(proposal.end, "after", 1);
    console.log(`Snapshot block: ${blockSnapshotEnd}`);

    // Check if test address voted
    const vote = voters.find((v: any) => v.voter.toLowerCase() === testAddress.toLowerCase());
    if (vote) {
      console.log(`\n✅ ${testAddress} voted in this proposal`);
      console.log(`   Voting power: ${(vote.vp / 1e18).toFixed(2)} veCRV`);
      console.log(`   Choices: ${JSON.stringify(vote.choice)}`);
    } else {
      console.log(`\n❌ ${testAddress} did not vote in this proposal`);
    }

    // Check forwarding status directly
    console.log(`\n🔍 Checking forwarding status on-chain...`);
    console.log(`   Contract: ${VOTIUM_FORWARDER_REGISTRY}`);
    console.log(`   Block: ${blockSnapshotEnd}`);

    try {
      const forwardedResult = await getForwardedDelegators([testAddress], blockSnapshotEnd);
      const forwardedTo = forwardedResult[0];

      console.log(`\n📋 Forwarding result:`);
      console.log(`   Address forwards to: ${forwardedTo || "Not forwarded"}`);
      
      if (forwardedTo?.toLowerCase() === VOTIUM_FORWARDER.toLowerCase()) {
        console.log(`   ✅ This address IS forwarding to Votium!`);
      } else {
        console.log(`   ❌ This address is NOT forwarding to Votium`);
      }
    } catch (error) {
      console.error("\n❌ Error checking forwarding status:", error);
    }

    // Test with multiple addresses
    console.log("\n" + "=".repeat(80));
    console.log("Testing batch processing with first 10 voters");
    console.log("=".repeat(80));

    const testVoters = voters.slice(0, 10).map((v: any) => v.voter);
    console.log(`\nChecking ${testVoters.length} addresses...`);

    const batchResults = await getForwardedDelegators(testVoters, blockSnapshotEnd);
    
    let forwarderCount = 0;
    testVoters.forEach((addr: string, idx: number) => {
      const forwardedTo = batchResults[idx];
      const isForwarder = forwardedTo?.toLowerCase() === VOTIUM_FORWARDER.toLowerCase();
      
      if (isForwarder) {
        forwarderCount++;
        console.log(`✅ ${addr} -> forwards to Votium`);
      } else {
        console.log(`   ${addr} -> ${forwardedTo || "not forwarded"}`);
      }
    });

    console.log(`\nSummary: ${forwarderCount}/${testVoters.length} addresses forward to Votium`);

  } catch (error) {
    console.error("Error in test:", error);
  }
}

// Run the test
if (require.main === module) {
  testForwarderDetection()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}