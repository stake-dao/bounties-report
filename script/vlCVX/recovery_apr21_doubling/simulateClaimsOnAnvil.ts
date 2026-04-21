import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import * as dotenv from "dotenv";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
} from "viem";
import { mainnet } from "../../utils/chains";
import { SCRVUSD, VLCVX_DELEGATORS_MERKLE } from "../../utils/constants";
import type { MerkleData } from "../../interfaces/MerkleData";

dotenv.config();

/**
 * Anvil-based fork simulator for the Apr 21 doubling recovery.
 *
 * Spawns a local anvil forked from mainnet, then for every account in the
 * corrected week-A merkle:
 *   1. setRoot(correctRoot) via impersonated owner.
 *   2. Call claim() (permissionless) for each account.
 *   3. Record actual sCRVUSD balance delta vs expected
 *      (= max(0, cumulative − claimed_before)).
 *
 * Expectations:
 *   - 31 listed over-claimers: merkle cumulative < on-chain claimed → no tx,
 *     actualDelta = 0, status = ok.
 *   - 62 fully-claimed: cumulative == claimed → no tx, actualDelta = 0.
 *   - 331 under-claimers: claim succeeds, actualDelta == expectedDelta.
 *   - Total paid ≈ 97,940.26 sCRVUSD.
 *
 * Env:
 *   WEB3_ALCHEMY_API_KEY  Alchemy key for fork RPC (required)
 *
 * CLI:
 *   --merkle <path>
 *   --overclaimers <path>
 *   --out <path>
 *   --port <number>       (default 18545)
 *
 * Writes fork_simulation_report.json next to the script.
 */

const URD_ABI = parseAbi([
  "function root() view returns (bytes32)",
  "function owner() view returns (address)",
  "function claimed(address account, address reward) view returns (uint256)",
  "function setRoot(bytes32 newRoot, bytes32 newIpfsHash) external",
  "function claim(address account, address reward, uint256 claimable, bytes32[] proof) external",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

type CliArgs = {
  merklePath: string;
  overclaimersPath: string;
  outPath: string;
  port: number;
};

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let merklePath = path.join(
    "bounties-reports",
    "1776297600",
    "vlCVX",
    "merkle_data_delegators.json",
  );
  let overclaimersPath = path.join(
    "script",
    "vlCVX",
    "recovery_apr21_doubling",
    "overclaimers.json",
  );
  let outPath = path.join(
    "script",
    "vlCVX",
    "recovery_apr21_doubling",
    "fork_simulation_report.json",
  );
  let port = 18545;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--merkle" && args[i + 1]) merklePath = args[++i];
    else if (args[i] === "--overclaimers" && args[i + 1])
      overclaimersPath = args[++i];
    else if (args[i] === "--out" && args[i + 1]) outPath = args[++i];
    else if (args[i] === "--port" && args[i + 1]) port = parseInt(args[++i]);
  }
  return { merklePath, overclaimersPath, outPath, port };
}

async function jsonRpc(
  rpcUrl: string,
  method: string,
  params: unknown[] = [],
): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as {
    result?: any;
    error?: { message: string };
  };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

async function waitForAnvil(rpcUrl: string, retries = 40): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await jsonRpc(rpcUrl, "eth_chainId");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error("Anvil did not start in time");
}

async function sendTx(
  rpcUrl: string,
  from: string,
  to: string,
  data: string,
): Promise<void> {
  const txHash = await jsonRpc(rpcUrl, "eth_sendTransaction", [
    { from, to, data, gas: "0x7A1200" },
  ]);
  for (let i = 0; i < 40; i++) {
    const receipt = await jsonRpc(rpcUrl, "eth_getTransactionReceipt", [
      txHash,
    ]);
    if (receipt) {
      if (receipt.status !== "0x1") {
        throw new Error(
          `tx ${txHash} reverted from=${from} to=${to}`,
        );
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`tx ${txHash} receipt timeout`);
}

async function main() {
  const { merklePath, overclaimersPath, outPath, port } = parseArgs();

  const alchemyKey = process.env.WEB3_ALCHEMY_API_KEY;
  if (!alchemyKey) throw new Error("WEB3_ALCHEMY_API_KEY required for fork RPC");
  const forkRpc = `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`;
  const anvilRpc = `http://127.0.0.1:${port}`;

  if (!fs.existsSync(merklePath)) {
    throw new Error(`Merkle not found: ${merklePath}`);
  }
  const merkle: MerkleData = JSON.parse(fs.readFileSync(merklePath, "utf8"));

  const BAD_ROOT =
    "0x24adda71b01b9f7fd6a7049b5eea4175f9ad92621cefce12c5aa2da4df191e0b";
  if (merkle.merkleRoot.toLowerCase() === BAD_ROOT.toLowerCase()) {
    throw new Error(
      `Supplied merkle has the BAD root ${BAD_ROOT}. Regenerate with the fix first.`,
    );
  }

  const overclaimerSet = new Set<string>();
  if (fs.existsSync(overclaimersPath)) {
    const oc = JSON.parse(fs.readFileSync(overclaimersPath, "utf8"));
    for (const row of oc.overclaimers ?? [])
      overclaimerSet.add(getAddress(row.account));
  }

  console.log(`Spawning anvil on :${port} (fork: mainnet)...`);
  const anvil: ChildProcess = spawn("anvil", [
    "--fork-url",
    forkRpc,
    "--port",
    String(port),
    "--silent",
    "--auto-impersonate",
  ]);
  anvil.on("error", (e) => {
    throw new Error(`anvil spawn error: ${e.message}`);
  });
  let anvilStderr = "";
  anvil.stderr?.on("data", (d) => {
    anvilStderr += d.toString();
  });

  try {
    await waitForAnvil(anvilRpc);
    console.log("anvil ready");

    const publicClient = createPublicClient({
      chain: mainnet,
      transport: http(anvilRpc),
    });
    const distributor = VLCVX_DELEGATORS_MERKLE as `0x${string}`;
    const scrvUsd = getAddress(SCRVUSD) as `0x${string}`;

    const owner = (await publicClient.readContract({
      address: distributor,
      abi: URD_ABI,
      functionName: "owner",
    })) as `0x${string}`;
    const rootBefore = (await publicClient.readContract({
      address: distributor,
      abi: URD_ABI,
      functionName: "root",
    })) as `0x${string}`;
    console.log(`Distributor : ${distributor}`);
    console.log(`Owner       : ${owner}`);
    console.log(`Root (pre)  : ${rootBefore}`);
    console.log(`Correct root: ${merkle.merkleRoot}`);

    // Fund + impersonate owner
    await jsonRpc(anvilRpc, "anvil_setBalance", [
      owner,
      "0xDE0B6B3A7640000",
    ]);
    await jsonRpc(anvilRpc, "anvil_impersonateAccount", [owner]);

    // setRoot (owner-only direct, bypasses timelock)
    const setRootData = encodeFunctionData({
      abi: URD_ABI,
      functionName: "setRoot",
      args: [
        merkle.merkleRoot as `0x${string}`,
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      ],
    });
    await sendTx(anvilRpc, owner, distributor, setRootData);

    const rootAfter = (await publicClient.readContract({
      address: distributor,
      abi: URD_ABI,
      functionName: "root",
    })) as `0x${string}`;
    if (rootAfter.toLowerCase() !== merkle.merkleRoot.toLowerCase()) {
      throw new Error(
        `setRoot failed: on-chain ${rootAfter} != target ${merkle.merkleRoot}`,
      );
    }
    console.log(`Root (post) : ${rootAfter} ✔`);

    type Row = {
      account: `0x${string}`;
      recipient: `0x${string}`;
      cumulativeWei: string;
      claimedBeforeWei: string;
      balanceBeforeWei: string;
      balanceAfterWei: string;
      actualDeltaWei: string;
      expectedDeltaWei: string;
      status: "ok" | "revert" | "mismatch";
      note: string;
      isOverclaimer: boolean;
    };

    // Stake DAO URD stores recipient at slot 9: mapping(address => address).
    // When non-zero, claim() transfers tokens to recipient instead of account.
    const ZERO_ADDR =
      "0x0000000000000000000000000000000000000000" as `0x${string}`;
    const readRecipient = async (
      account: `0x${string}`,
    ): Promise<`0x${string}`> => {
      const slot = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "uint256" }],
          [account, 9n],
        ),
      );
      const raw = (await publicClient.request({
        method: "eth_getStorageAt" as any,
        params: [distributor, slot, "latest"] as any,
      })) as string;
      const addr = `0x${raw.slice(-40)}` as `0x${string}`;
      return addr.toLowerCase() === ZERO_ADDR.toLowerCase()
        ? account
        : getAddress(addr);
    };

    const rows: Row[] = [];
    const accounts = Object.keys(merkle.claims).map((a) => getAddress(a));
    console.log(`\nSimulating ${accounts.length} claims via owner relayer...`);

    let done = 0;
    for (const account of accounts) {
      const tokens = merkle.claims[account]?.tokens ?? {};
      const tok = tokens[scrvUsd];
      if (!tok) {
        rows.push({
          account,
          recipient: account,
          cumulativeWei: "0",
          claimedBeforeWei: "0",
          balanceBeforeWei: "0",
          balanceAfterWei: "0",
          actualDeltaWei: "0",
          expectedDeltaWei: "0",
          status: "ok",
          note: "no SCRVUSD entry in merkle (skipped)",
          isOverclaimer: overclaimerSet.has(account),
        });
        continue;
      }
      const cumulative = BigInt(tok.amount);
      const proof = tok.proof as `0x${string}`[];

      const recipient = await readRecipient(account);
      const [claimedBefore, balBefore] = await Promise.all([
        publicClient.readContract({
          address: distributor,
          abi: URD_ABI,
          functionName: "claimed",
          args: [account, scrvUsd],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: scrvUsd,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [recipient],
        }) as Promise<bigint>,
      ]);

      const expectedDelta =
        cumulative > claimedBefore ? cumulative - claimedBefore : 0n;

      let status: Row["status"] = "ok";
      let note = "";
      let balAfter = balBefore;

      if (expectedDelta === 0n) {
        note =
          cumulative < claimedBefore
            ? "merkle cumulative < claimed (overclaimer surplus locked)"
            : "fully claimed already";
      } else {
        const claimData = encodeFunctionData({
          abi: URD_ABI,
          functionName: "claim",
          args: [account, scrvUsd, cumulative, proof],
        });
        try {
          await sendTx(anvilRpc, owner, distributor, claimData);
          balAfter = (await publicClient.readContract({
            address: scrvUsd,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [recipient],
          })) as bigint;
          const actualDelta = balAfter - balBefore;
          if (actualDelta !== expectedDelta) {
            status = "mismatch";
            note = `actualDelta=${actualDelta} expectedDelta=${expectedDelta}`;
          } else if (recipient !== account) {
            note = `paid to recipient ${recipient}`;
          }
        } catch (e: any) {
          status = "revert";
          note = (e?.message ?? String(e)).slice(0, 200);
        }
      }

      rows.push({
        account,
        recipient,
        cumulativeWei: cumulative.toString(),
        claimedBeforeWei: claimedBefore.toString(),
        balanceBeforeWei: balBefore.toString(),
        balanceAfterWei: balAfter.toString(),
        actualDeltaWei: (balAfter - balBefore).toString(),
        expectedDeltaWei: expectedDelta.toString(),
        status,
        note,
        isOverclaimer: overclaimerSet.has(account),
      });

      done++;
      if (done % 50 === 0)
        console.log(`  ${done}/${accounts.length} simulated`);
    }

    const fmt = (wei: string) => (Number(BigInt(wei)) / 1e18).toFixed(6);
    const okCount = rows.filter((r) => r.status === "ok").length;
    const mismatchCount = rows.filter((r) => r.status === "mismatch").length;
    const revertCount = rows.filter((r) => r.status === "revert").length;

    const overclaimerRows = rows.filter((r) => r.isOverclaimer);
    const overclaimerOK = overclaimerRows.filter(
      (r) => r.status === "ok" && r.actualDeltaWei === "0",
    ).length;
    const legitClaimed = rows.filter(
      (r) =>
        !r.isOverclaimer &&
        r.status === "ok" &&
        BigInt(r.expectedDeltaWei) > 0n &&
        r.actualDeltaWei === r.expectedDeltaWei,
    ).length;

    const totalActualPaidWei = rows.reduce(
      (a, r) => a + BigInt(r.actualDeltaWei),
      0n,
    );
    const totalExpectedPaidWei = rows.reduce(
      (a, r) => a + BigInt(r.expectedDeltaWei),
      0n,
    );

    console.log("\n=== Fork simulation summary ===");
    console.log(`Accounts examined  : ${rows.length}`);
    console.log(`  ok               : ${okCount}`);
    console.log(`  mismatch         : ${mismatchCount}`);
    console.log(`  revert           : ${revertCount}`);
    console.log(`Overclaimers       : ${overclaimerRows.length}`);
    console.log(`  claimed zero (ok): ${overclaimerOK}`);
    console.log(`Legit claims OK    : ${legitClaimed}`);
    console.log(
      `Total paid (actual): ${fmt(totalActualPaidWei.toString())} sCRVUSD`,
    );
    console.log(
      `Total paid (exp)   : ${fmt(totalExpectedPaidWei.toString())} sCRVUSD`,
    );

    if (mismatchCount > 0 || revertCount > 0) {
      console.log("\nAnomalies:");
      for (const r of rows.filter(
        (r) => r.status === "mismatch" || r.status === "revert",
      )) {
        console.log(
          `  ${r.status.toUpperCase()} ${r.account} oc=${r.isOverclaimer} cum=${fmt(r.cumulativeWei)} claimedBefore=${fmt(r.claimedBeforeWei)} note="${r.note}"`,
        );
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      rpcUrl: anvilRpc,
      fork: "anvil fork of mainnet",
      distributor,
      rewardToken: scrvUsd,
      merklePath,
      merkleRoot: merkle.merkleRoot,
      rootBefore,
      rootAfter,
      overclaimersPath: fs.existsSync(overclaimersPath)
        ? overclaimersPath
        : null,
      totals: {
        accounts: rows.length,
        ok: okCount,
        mismatch: mismatchCount,
        revert: revertCount,
        overclaimers: overclaimerRows.length,
        overclaimersClaimedZero: overclaimerOK,
        legitClaimsOK: legitClaimed,
        totalActualPaidWei: totalActualPaidWei.toString(),
        totalExpectedPaidWei: totalExpectedPaidWei.toString(),
      },
      rows,
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\nWrote ${outPath}`);
  } finally {
    anvil.kill();
    if (anvilStderr.trim()) {
      console.error("anvil stderr:", anvilStderr.slice(0, 500));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
