import fs from "node:fs";
import path from "node:path";
import { getAddress, keccak256, toHex } from "viem";
import { utils } from "ethers";
import MerkleTree from "merkletreejs";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";

// Constants
const SDZERO_GAUGE = "0x930b866491549F6F5716CEA94723187e45e22ee5";
const LINEA_TOKEN = "0x1789e0043623282D5DCc7F213d703C6D8BAfBB04";
const LINEA_CHAIN_ID = 59144;
const DEC_1_TIMESTAMP = 1764633600; // Dec 1, 2025 00:00:00 UTC
const LINEA_AMOUNT = 1263130000000000000000000n; // 1,263,130 * 1e18

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Transfer event topic
const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));

async function main() {
  const explorerUtils = createBlockchainExplorerUtils();

  // ========================================
  // Phase 1: Get Dec 1st 2025 Block Number
  // ========================================
  console.log("Phase 1: Getting Dec 1st 2025 block number on Linea...");
  
  const dec1Block = await explorerUtils.getBlockNumberByTimestamp(
    DEC_1_TIMESTAMP,
    "before",
    LINEA_CHAIN_ID
  );
  
  if (dec1Block === 0) {
    throw new Error("Failed to get Dec 1st block number");
  }
  
  console.log(`Dec 1st 2025 block on Linea: ${dec1Block}`);

  // ========================================
  // Phase 2: Fetch All Transfer Events
  // ========================================
  console.log("\nPhase 2: Fetching Transfer events for sdZERO gauge...");
  
  const logs = await explorerUtils.getLogsByAddressAndTopics(
    SDZERO_GAUGE,
    0,
    dec1Block,
    { "0": TRANSFER_TOPIC },
    LINEA_CHAIN_ID
  );
  
  console.log(`Fetched ${logs.result.length} Transfer events`);
  
  // Build balance map
  const balances = new Map<string, bigint>();
  
  for (const log of logs.result) {
    // Decode from (topic1) and to (topic2)
    const from = getAddress(`0x${log.topics[1].slice(26)}`);
    const to = getAddress(`0x${log.topics[2].slice(26)}`);
    const amount = BigInt(log.data);
    
    // Subtract from sender (if not mint)
    if (from !== ZERO_ADDRESS) {
      const prevFrom = balances.get(from) || 0n;
      balances.set(from, prevFrom - amount);
    }
    
    // Add to receiver
    const prevTo = balances.get(to) || 0n;
    balances.set(to, prevTo + amount);
  }
  
  // Filter out zero/negative balances and zero address
  const holders = Array.from(balances.entries())
    .filter(([addr, bal]) => bal > 0n && addr !== ZERO_ADDRESS)
    .map(([address, balance]) => ({ address, balance }));
  
  console.log(`Found ${holders.length} holders with positive balance`);
  
  // Sanity check: no negative balances
  const negativeBalances = Array.from(balances.entries()).filter(([_, bal]) => bal < 0n);
  if (negativeBalances.length > 0) {
    console.warn("WARNING: Found negative balances (should not happen):");
    for (const [addr, bal] of negativeBalances) {
      console.warn(`  ${addr}: ${bal}`);
    }
  }

  // ========================================
  // Phase 3: Calculate Pro-Rata Distribution
  // ========================================
  console.log("\nPhase 3: Calculating pro-rata distribution...");
  
  const totalSupply = holders.reduce((sum, h) => sum + h.balance, 0n);
  console.log(`Total supply: ${totalSupply}`);
  
  const distribution: { address: string; amount: bigint }[] = [];
  
  for (const holder of holders) {
    const share = (holder.balance * LINEA_AMOUNT) / totalSupply;
    if (share > 0n) {
      distribution.push({ address: holder.address, amount: share });
    }
  }
  
  // Verify total
  const totalDistributed = distribution.reduce((sum, d) => sum + d.amount, 0n);
  console.log(`Total distributed: ${totalDistributed}`);
  console.log(`Target amount: ${LINEA_AMOUNT}`);
  console.log(`Difference (rounding dust): ${LINEA_AMOUNT - totalDistributed}`);

  // ========================================
  // Phase 4: Generate Merkle Tree
  // ========================================
  console.log("\nPhase 4: Generating merkle tree...");
  
  // Build leaves
  const leaves: string[] = [];
  const claims: Record<string, { tokens: Record<string, { amount: string; proof: string[] }> }> = {};
  
  for (const d of distribution) {
    const leaf = utils.keccak256(
      utils.solidityPack(
        ["bytes"],
        [
          utils.keccak256(
            utils.defaultAbiCoder.encode(
              ["address", "address", "uint256"],
              [d.address, LINEA_TOKEN, d.amount.toString()]
            )
          ),
        ]
      )
    );
    leaves.push(leaf);
    
    claims[d.address] = {
      tokens: {
        [LINEA_TOKEN]: {
          amount: d.amount.toString(),
          proof: [],
        },
      },
    };
  }
  
  const merkleTree = new MerkleTree(leaves, utils.keccak256, { sortPairs: true });
  const merkleRoot = merkleTree.getHexRoot();
  
  // Generate proofs
  for (const d of distribution) {
    const leaf = utils.keccak256(
      utils.solidityPack(
        ["bytes"],
        [
          utils.keccak256(
            utils.defaultAbiCoder.encode(
              ["address", "address", "uint256"],
              [d.address, LINEA_TOKEN, d.amount.toString()]
            )
          ),
        ]
      )
    );
    claims[d.address].tokens[LINEA_TOKEN].proof = merkleTree.getHexProof(leaf);
  }
  
  // Output directory
  const outputDir = path.join(__dirname, `../../data/extra_merkle/${LINEA_CHAIN_ID}`);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Save merkle.json
  const merkleData = { merkleRoot, claims };
  fs.writeFileSync(path.join(outputDir, "merkle.json"), JSON.stringify(merkleData, null, 2));
  
  // Save distribution.csv
  const csvContent = `address,token,amount\n${distribution.map(d => `${d.address},${LINEA_TOKEN},${d.amount.toString()}`).join("\n")}`;
  fs.writeFileSync(path.join(outputDir, "distribution.csv"), csvContent);
  
  // Save summary.json
  const summary = {
    timestamp: Math.floor(Date.now() / 1000),
    snapshotBlock: dec1Block,
    merkleRoot,
    token: LINEA_TOKEN,
    totalAmount: totalDistributed.toString(),
    totalRecipients: distribution.length,
  };
  fs.writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
  
  console.log(`Files saved to: ${outputDir}`);
  console.log(`Merkle root: ${merkleRoot}`);

  // ========================================
  // Summary
  // ========================================
  console.log("\n========================================");
  console.log("Summary");
  console.log("========================================");
  console.log(`sdZERO Gauge: ${SDZERO_GAUGE}`);
  console.log(`LINEA Token: ${LINEA_TOKEN}`);
  console.log(`Snapshot Block: ${dec1Block}`);
  console.log(`Total Holders: ${holders.length}`);
  console.log(`Total LINEA to distribute: ${LINEA_AMOUNT} (${Number(LINEA_AMOUNT) / 1e18} LINEA)`);
  console.log(`Total distributed: ${totalDistributed} (${Number(totalDistributed) / 1e18} LINEA)`);
  console.log("");
  console.log("Top 10 recipients:");
  const sorted = [...distribution].sort((a, b) => (b.amount > a.amount ? 1 : -1));
  for (let i = 0; i < Math.min(10, sorted.length); i++) {
    const d = sorted[i];
    const pct = (Number(d.amount) / Number(LINEA_AMOUNT) * 100).toFixed(2);
    console.log(`  ${i + 1}. ${d.address}: ${Number(d.amount) / 1e18} LINEA (${pct}%)`);
  }
}

main().catch(console.error);
