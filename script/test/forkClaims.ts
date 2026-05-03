/**
 * Anvil fork claim tester
 *
 * For each configured merkle, forks the target chain, submits the new root
 * (impersonating the contract owner), then fires every pending claim and
 * asserts success.
 *
 * Usage:
 *   pnpm tsx script/test/forkClaims.ts [--period TIMESTAMP] [--only LABEL]
 *
 * Requires anvil to be available in PATH.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { createPublicClient, createWalletClient, http } from "viem";
import type { Chain, PublicClient, WalletClient } from "viem";
import { mainnet } from "viem/chains";
import { WEEK } from "../utils/constants";
import type { MerkleData } from "../interfaces/MerkleData";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface MerkleTestConfig {
  label: string;
  chain: Chain;
  rpcUrl: string;
  distributor: string;
  /** Path relative to bounties-reports/{period}/ */
  merkleRelPath: string;
}

const CONFIGS: MerkleTestConfig[] = [
  {
    label: "vlCVX Non-Delegators",
    chain: mainnet,
    rpcUrl: "https://eth.llamarpc.com",
    distributor: "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db",
    merkleRelPath: "vlCVX/vlcvx_merkle.json",
  },
  {
    label: "vlCVX Delegators",
    chain: mainnet,
    rpcUrl: "https://eth.llamarpc.com",
    distributor: "0x17F513CDE031C8B1E878Bde1Cb020cE29f77f380",
    merkleRelPath: "vlCVX/merkle_data_delegators.json",
  },
  // Add more entries as needed:
  // {
  //   label: "sdFXS Universal",
  //   chain: fraxtal, // add fraxtal chain if needed
  //   rpcUrl: "https://rpc.frax.com",
  //   distributor: "0xAeB87C92b2E7d3b21fA046Ae1E51E0ebF11A41Af",
  //   merkleRelPath: "sdTkns/sdtkns_merkle_252.json",
  // },
  // {
  //   label: "sdSpectra Universal",
  //   chain: base,
  //   rpcUrl: "https://mainnet.base.org",
  //   distributor: "0x665d334388012d17f1d197de72b7b708ffccb67d",
  //   merkleRelPath: "sdTkns/sdtkns_merkle_8453.json",
  // },
];

// ---------------------------------------------------------------------------
// ABI (UniversalRewardsDistributor)
// ---------------------------------------------------------------------------

const URD_ABI = [
  { name: "root", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
  { name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "claimed", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }, { name: "reward", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "submitRoot", type: "function", stateMutability: "nonpayable", inputs: [{ name: "newRoot", type: "bytes32" }, { name: "ipfsHash", type: "bytes32" }], outputs: [] },
  { name: "acceptRoot", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "claim", type: "function", stateMutability: "nonpayable", inputs: [{ name: "account", type: "address" }, { name: "reward", type: "address" }, { name: "claimable", type: "uint256" }, { name: "proof", type: "bytes32[]" }], outputs: [] },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ANVIL_PORT = 18545; // use a non-default port to avoid conflicts
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;

async function jsonRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(ANVIL_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

function startAnvil(rpcUrl: string): ReturnType<typeof spawn> {
  const proc = spawn("anvil", [
    "--fork-url", rpcUrl,
    "--port", String(ANVIL_PORT),
    "--silent",
  ]);
  proc.on("error", (e) => { throw new Error(`Failed to start anvil: ${e.message}`); });
  return proc;
}

async function waitForAnvil(retries = 20): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await jsonRpc("eth_chainId");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error("Anvil did not start in time");
}

// ---------------------------------------------------------------------------
// Core test logic for one config
// ---------------------------------------------------------------------------

async function testMerkle(
  cfg: MerkleTestConfig,
  merkle: MerkleData
): Promise<{ passed: number; skipped: number; failed: number; failures: string[] }> {
  // Cast to concrete client types — cfg.chain: Chain (generic) prevents viem from narrowing
  // the overloaded return type, but the runtime object is fully functional.
  const publicClient = createPublicClient({ chain: cfg.chain, transport: http(ANVIL_RPC) }) as unknown as PublicClient;
  const walletClient = createWalletClient({ chain: cfg.chain, transport: http(ANVIL_RPC) }) as unknown as WalletClient;

  // Get owner and fund them
  const owner = (await publicClient.readContract({
    address: cfg.distributor as `0x${string}`,
    abi: URD_ABI,
    functionName: "owner",
  })) as `0x${string}`;

  await jsonRpc("anvil_impersonateAccount", [owner]);
  await jsonRpc("anvil_setBalance", [owner, "0x56BC75E2D63100000"]);

  // Submit + accept new root
  const submitHash = await walletClient.writeContract({
    address: cfg.distributor as `0x${string}`,
    abi: URD_ABI,
    functionName: "submitRoot",
    args: [merkle.merkleRoot as `0x${string}`, "0x0000000000000000000000000000000000000000000000000000000000000000"],
    account: owner,
  });
  await publicClient.waitForTransactionReceipt({ hash: submitHash });

  const acceptHash = await walletClient.writeContract({
    address: cfg.distributor as `0x${string}`,
    abi: URD_ABI,
    functionName: "acceptRoot",
    args: [],
    account: owner,
  });
  await publicClient.waitForTransactionReceipt({ hash: acceptHash });

  // Verify root was set
  const onchainRoot = await publicClient.readContract({
    address: cfg.distributor as `0x${string}`,
    abi: URD_ABI,
    functionName: "root",
  });
  if ((onchainRoot as string).toLowerCase() !== merkle.merkleRoot.toLowerCase()) {
    throw new Error(`Root mismatch! on-chain=${onchainRoot} expected=${merkle.merkleRoot}`);
  }

  // Build all (user, token, amount, proof) tuples
  const entries = Object.entries(merkle.claims).flatMap(([user, data]) =>
    Object.entries(data.tokens).map(([token, { amount, proof }]) => ({
      user: user as `0x${string}`,
      token: token as `0x${string}`,
      amount: BigInt(amount),
      proof: proof as `0x${string}`[],
    }))
  );

  // Fetch all claimed amounts via multicall
  const claimedResults = await publicClient.multicall({
    contracts: entries.map(({ user, token }) => ({
      address: cfg.distributor as `0x${string}`,
      abi: URD_ABI,
      functionName: "claimed" as const,
      args: [user, token],
    })),
  });

  let passed = 0, skipped = 0, failed = 0;
  const failures: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const { user, token, amount, proof } = entries[i];
    const alreadyClaimed = (claimedResults[i].result as bigint) ?? 0n;

    if (amount <= alreadyClaimed) {
      skipped++;
      continue;
    }

    try {
      await jsonRpc("anvil_impersonateAccount", [user]);
      await jsonRpc("anvil_setBalance", [user, "0x56BC75E2D63100000"]);

      const hash = await walletClient.writeContract({
        address: cfg.distributor as `0x${string}`,
        abi: URD_ABI,
        functionName: "claim",
        args: [user, token, amount, proof],
        account: user,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      passed++;
    } catch (e: unknown) {
      failed++;
      const msg = e instanceof Error ? e.message.slice(0, 120) : String(e);
      failures.push(`user=${user} token=${token.slice(0, 10)}… err=${msg}`);
    }
  }

  return { passed, skipped, failed, failures };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let periodTimestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;
  let onlyLabel: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--period" && args[i + 1]) periodTimestamp = parseInt(args[++i]);
    if (args[i] === "--only" && args[i + 1]) onlyLabel = args[++i];
  }

  const configs = onlyLabel
    ? CONFIGS.filter((c) => c.label.toLowerCase().includes(onlyLabel!.toLowerCase()))
    : CONFIGS;

  if (configs.length === 0) {
    console.error(`No configs matched label filter: ${onlyLabel}`);
    process.exit(1);
  }

  console.log(`\n🧪 Fork Claim Tester — period ${periodTimestamp}`);
  console.log(`   Running ${configs.length} config(s)\n`);

  let totalPassed = 0, totalSkipped = 0, totalFailed = 0;
  const allFailures: string[] = [];

  for (const cfg of configs) {
    const merklePath = path.join("bounties-reports", periodTimestamp.toString(), cfg.merkleRelPath);

    if (!fs.existsSync(merklePath)) {
      console.log(`⏭️  [${cfg.label}] Merkle file not found: ${merklePath} — skipping`);
      continue;
    }

    const merkle: MerkleData = JSON.parse(fs.readFileSync(merklePath, "utf8"));
    const claimCount = Object.values(merkle.claims).reduce(
      (acc, c) => acc + Object.keys(c.tokens).length, 0
    );
    console.log(`🔀 [${cfg.label}] Forking ${cfg.chain.name} — ${claimCount} claim entries`);

    const anvil = startAnvil(cfg.rpcUrl);
    try {
      await waitForAnvil();
      console.log(`   ✅ Fork ready (root: ${merkle.merkleRoot.slice(0, 18)}…)`);

      const result = await testMerkle(cfg, merkle);
      totalPassed += result.passed;
      totalSkipped += result.skipped;
      totalFailed += result.failed;
      allFailures.push(...result.failures.map((f) => `[${cfg.label}] ${f}`));

      console.log(
        `   ✅ ${result.passed} claimed  ⏭️  ${result.skipped} already claimed  ❌ ${result.failed} failed`
      );
      if (result.failures.length > 0) {
        result.failures.forEach((f) => console.log(`     ❌ ${f}`));
      }
    } finally {
      anvil.kill();
      // Brief wait for port release before next config
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`📊 Total: ✅ ${totalPassed} passed  ⏭️  ${totalSkipped} skipped  ❌ ${totalFailed} failed`);

  if (totalFailed > 0) {
    console.log("\nFailures:");
    allFailures.forEach((f) => console.log(`  ${f}`));
    process.exit(1);
  }

  console.log("\n✅ All claims verified successfully.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
