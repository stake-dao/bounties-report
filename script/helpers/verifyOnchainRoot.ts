import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getClient } from "../utils/getClients";

const URD_ABI = [
  {
    name: "root",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "pendingRoot",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "root", type: "bytes32" },
      { name: "ipfsHash", type: "bytes32" },
      { name: "validAt", type: "uint256" },
    ],
  },
] as const;

const ZERO_ROOT = "0x0000000000000000000000000000000000000000000000000000000000000000";

type Target = "delegators" | "voters" | "vlaura";

interface FileSpec {
  path: string;
  chainId: number;
  distributor: `0x${string}`;
}

const VLCVX_DELEGATORS: Record<number, `0x${string}`> = {
  1: "0x17F513CDE031C8B1E878Bde1Cb020cE29f77f380",
};

const VLCVX_VOTERS: Record<number, `0x${string}`> = {
  1: "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db",
  10: "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db",
  42161: "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db",
  8453: "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db",
};

const VLAURA: Record<number, `0x${string}`> = {
  1: "0x59ADeBc5cBdB18aE344a506976fE3bbBB3D89199",
  42161: "0x59ADeBc5cBdB18aE344a506976fE3bbBB3D89199",
  8453: "0x59ADeBc5cBdB18aE344a506976fE3bbBB3D89199",
};

function collectFiles(target: Target, period: number): FileSpec[] {
  const vlcvxDir = path.join("bounties-reports", String(period), "vlCVX");
  const vlauraDir = path.join("bounties-reports", String(period), "vlAURA");
  const files: FileSpec[] = [];

  if (target === "delegators") {
    files.push({
      path: path.join(vlcvxDir, "merkle_data_delegators.json"),
      chainId: 1,
      distributor: VLCVX_DELEGATORS[1],
    });
    return files;
  }

  if (target === "voters") {
    files.push({
      path: path.join(vlcvxDir, "vlcvx_merkle.json"),
      chainId: 1,
      distributor: VLCVX_VOTERS[1],
    });
    for (const chainId of [10, 42161, 8453]) {
      const p = path.join(vlcvxDir, `vlcvx_merkle_${chainId}.json`);
      if (existsSync(p)) {
        files.push({ path: p, chainId, distributor: VLCVX_VOTERS[chainId] });
      }
    }
    return files;
  }

  // vlaura
  files.push({
    path: path.join(vlauraDir, "vlaura_merkle.json"),
    chainId: 1,
    distributor: VLAURA[1],
  });
  for (const chainId of [42161, 8453]) {
    const p = path.join(vlauraDir, `vlaura_merkle_${chainId}.json`);
    if (existsSync(p)) {
      files.push({ path: p, chainId, distributor: VLAURA[chainId] });
    }
  }
  return files;
}

interface VerifyResult {
  ok: boolean;
  source: string;
  onchain: string;
  pendingRoot: string;
  pendingValidAt: bigint;
  now: number;
  reason?: string;
}

async function verifyFile(spec: FileSpec): Promise<VerifyResult> {
  const raw = readFileSync(spec.path, "utf8");
  const data = JSON.parse(raw) as { merkleRoot?: string };
  if (!data.merkleRoot) {
    throw new Error(`merkleRoot field missing in ${spec.path}`);
  }
  const source = data.merkleRoot.toLowerCase();
  const client = await getClient(spec.chainId);

  const [onchain, pending] = await Promise.all([
    client.readContract({
      address: spec.distributor,
      abi: URD_ABI,
      functionName: "root",
    }) as Promise<`0x${string}`>,
    client.readContract({
      address: spec.distributor,
      abi: URD_ABI,
      functionName: "pendingRoot",
    }) as Promise<readonly [`0x${string}`, `0x${string}`, bigint]>,
  ]);

  const onchainLower = onchain.toLowerCase();
  const pendingRootLower = pending[0].toLowerCase();
  const pendingValidAt = pending[2];
  const now = Math.floor(Date.now() / 1000);

  const rootMatches = source === onchainLower;
  const hasPending = pendingRootLower !== ZERO_ROOT;
  const timelockExpired = Number(pendingValidAt) <= now;

  let ok = true;
  let reason: string | undefined;

  if (!rootMatches) {
    ok = false;
    reason = "on-chain root does not match source — acceptRoot() not yet executed";
  } else if (hasPending && !timelockExpired) {
    ok = false;
    reason = `pending root present with validAt=${pendingValidAt} > now=${now} — timelock still active, too soon to publish`;
  }

  return {
    ok,
    source,
    onchain: onchainLower,
    pendingRoot: pendingRootLower,
    pendingValidAt,
    now,
    reason,
  };
}

function parseArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === `--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const target = parseArg("target") as Target | undefined;
  const periodStr = parseArg("period");

  if (!target || !periodStr) {
    console.error(
      "Usage: verifyOnchainRoot --target <delegators|voters|vlaura> --period <timestamp>",
    );
    process.exit(2);
  }
  if (!["delegators", "voters", "vlaura"].includes(target)) {
    console.error(`Unknown target: ${target}`);
    process.exit(2);
  }

  const period = Number(periodStr);
  if (!Number.isFinite(period) || period <= 0) {
    console.error(`Invalid period: ${periodStr}`);
    process.exit(2);
  }

  const files = collectFiles(target, period);
  const missingMain = !existsSync(files[0].path);
  if (missingMain) {
    console.error(`Source file not found: ${files[0].path}`);
    process.exit(3);
  }

  console.log(`Verifying on-chain roots for target=${target} period=${period}`);
  let allOk = true;

  for (const f of files) {
    try {
      const res = await verifyFile(f);
      const status = res.ok ? "OK" : "BLOCK";
      console.log(`[${status}] chain=${f.chainId} file=${f.path}`);
      console.log(`   source      : ${res.source}`);
      console.log(`   onchain root: ${res.onchain}`);
      console.log(`   pendingRoot : ${res.pendingRoot}`);
      console.log(`   validAt     : ${res.pendingValidAt} (now=${res.now})`);
      if (res.reason) {
        console.log(`   reason      : ${res.reason}`);
      }
      if (!res.ok) allOk = false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[ERROR] chain=${f.chainId} file=${f.path}: ${msg}`);
      allOk = false;
    }
  }

  if (!allOk) {
    console.error("\nPublish blocked — see reasons above.");
    process.exit(1);
  }
  console.log("\nAll on-chain roots match source and no active timelock. Safe to publish.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
