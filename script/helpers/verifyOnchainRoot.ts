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
] as const;

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

async function verifyFile(spec: FileSpec): Promise<{ ok: boolean; source: string; onchain: string }> {
  const raw = readFileSync(spec.path, "utf8");
  const data = JSON.parse(raw) as { merkleRoot?: string };
  if (!data.merkleRoot) {
    throw new Error(`merkleRoot field missing in ${spec.path}`);
  }
  const source = data.merkleRoot.toLowerCase();
  const client = await getClient(spec.chainId);
  const onchain = (await client.readContract({
    address: spec.distributor,
    abi: URD_ABI,
    functionName: "root",
  })) as `0x${string}`;
  const onchainLower = onchain.toLowerCase();
  return { ok: source === onchainLower, source, onchain: onchainLower };
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
      const { ok, source, onchain } = await verifyFile(f);
      const status = ok ? "OK" : "MISMATCH";
      console.log(`[${status}] chain=${f.chainId} file=${f.path}`);
      console.log(`   source : ${source}`);
      console.log(`   onchain: ${onchain}`);
      if (!ok) allOk = false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[ERROR] chain=${f.chainId} file=${f.path}: ${msg}`);
      allOk = false;
    }
  }

  if (!allOk) {
    console.error(
      "\nOn-chain root does not match source merkle. acceptRoot() likely not yet executed — aborting publish.",
    );
    process.exit(1);
  }
  console.log("\nAll on-chain roots match source files. Safe to publish.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
