import { readFileSync, writeFileSync } from "node:fs";
import { erc20Abi } from "viem";
import { BOTMARKETS } from "../utils/constants";
import { getClient } from "../utils/getClients";
import { checkV1, ethereumTargets, toBigInt, type LogData, type MerkleEntry, type MerkleClaim } from "./verify/checkBeforeSetRoots";

const DISTRIBUTOR = "0x03E34b085C52985F6a5D27243F20C84bDdc01Db4";
const OWNER = "0xbd2A781f11A32929393e6959D08F78346bEDA8f6";
const TOKENS = new Set([
  "0xd1b5651e55d4ceed36251c61c50c889b36f6abb5",
  "0xe19d1c837b8a1c83a56cd9165b2c0256d39653ad",
]);

export function buildDistribution(
  log: LogData, merkle: MerkleEntry[], period: number, verified: boolean,
  balances: Map<string, readonly [bigint, bigint]>,
) {
  if (log.period !== period || (verified && log.postFreeze !== true)) {
    throw new Error("stale or pre-freeze log");
  }
  const targets = ethereumTargets(log);
  if (new Set(targets.tokens).size !== targets.tokens.length) throw new Error("duplicate targets");
  const tokens = targets.tokens.map((address, index) => {
    if (!TOKENS.has(address)) throw new Error(`unsupported token ${address}`);
    const entries = merkle.filter((m) => m.chainId === 1 && String(m.address).toLowerCase() === address);
    if (entries.length !== 1) throw new Error(`missing or duplicate merkle ${address}`);
    const entry = entries[0];
    if (String(entry.merkleContract).toLowerCase() !== DISTRIBUTOR.toLowerCase()) throw new Error("unexpected distributor");
    if (String(entry.root).toLowerCase() !== targets.roots[index]) throw new Error("root mismatch");
    const total = toBigInt(entry.total, `${address} total`);
    const claimTotal = Object.values(entry.merkle as Record<string, MerkleClaim>).reduce(
      (sum, claim) => sum + toBigInt(claim.amount, `${address} claim`), 0n,
    );
    if (total !== claimTotal) throw new Error("tree total does not equal the claim liability");
    const balance = balances.get(address);
    if (!balance || total <= 0n) throw new Error("missing balance or empty liability");
    const maxFunding = total > balance[0] ? total - balance[0] : 0n;
    if (maxFunding > balance[1]) throw new Error(`insufficient funding for ${address}`);
    return { address, root: targets.roots[index], total: total.toString(), maxFunding: maxFunding.toString() };
  });
  return { period, postFreeze: log.postFreeze === true, verified, distributor: DISTRIBUTOR, owner: OWNER, tokens };
}

async function main() {
  const period = Math.floor(Date.now() / 1000 / 604800) * 604800;
  const log: LogData = JSON.parse(readFileSync("log.json", "utf8"));
  const merkle: MerkleEntry[] = JSON.parse(readFileSync(`bounties-reports/${period}/merkle.json`, "utf8"));
  const targets = ethereumTargets(log);
  checkV1(merkle, targets, log);
  const client = await getClient(1);
  const balances = new Map<string, readonly [bigint, bigint]>();
  for (const token of targets.tokens) {
    balances.set(token, await Promise.all([
      client.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [DISTRIBUTOR] }),
      client.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [BOTMARKETS.ethereum as `0x${string}`] }),
    ]));
  }
  const distribution = buildDistribution(log, merkle, period, process.argv.includes("--verified"), balances);
  writeFileSync(`bounties-reports/${period}/sdtokens-distribution.json`, JSON.stringify(distribution, null, 2) + "\n");
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
