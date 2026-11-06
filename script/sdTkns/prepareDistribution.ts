import { readFileSync, writeFileSync } from "node:fs";
import { erc20Abi, parseAbi, zeroHash } from "viem";
import { BOTMARKETS } from "../utils/constants";
import { getClient } from "../utils/getClients";
import {
  checkV1, checkV6, checkV12, ethereumTargets, loadUniversalFiles, toBigInt, universalTargets,
  type LogData, type MerkleEntry, type MerkleClaim, type UniversalFiles,
} from "./verify/checkBeforeSetRoots";

const DISTRIBUTOR = "0x03E34b085C52985F6a5D27243F20C84bDdc01Db4";
const OWNER = "0xbd2A781f11A32929393e6959D08F78346bEDA8f6";
const TOKENS = new Set([
  "0xd1b5651e55d4ceed36251c61c50c889b36f6abb5",
  "0xe19d1c837b8a1c83a56cd9165b2c0256d39653ad",
]);

export function buildDistribution(
  log: LogData, merkle: MerkleEntry[], period: number, verified: boolean,
  balances: Map<string, readonly [bigint, bigint]>,
  universalFiles: UniversalFiles = new Map(),
) {
  if (log.period !== period || (verified && log.postFreeze !== true)) {
    throw new Error("stale or pre-freeze log");
  }
  const targets = ethereumTargets(log);
  if (new Set(targets.tokens).size !== targets.tokens.length) throw new Error("duplicate targets");
  checkV6(log, merkle, targets);
  const universalEntries = universalTargets(log);
  if (universalEntries.length > 0) checkV12(universalEntries, universalFiles);
  const universalFunding = new Map<string, bigint>();
  const universal = universalEntries.map((entry) => {
    if (!TOKENS.has(entry.token)) throw new Error(`unsupported token ${entry.token}`);
    if (universalFunding.has(entry.token)) throw new Error("duplicate universal targets");
    if (entry.previousRoot && !universalFiles.get(entry.file)?.previousFile) throw new Error(`missing baseline file for ${entry.token}`);
    universalFunding.set(entry.token, entry.weekly);
    return {
      distributor: entry.distributor, token: entry.token, file: entry.file, root: entry.root,
      total: entry.total.toString(), maxFunding: entry.weekly.toString(),
      previousRoot: entry.previousRoot ?? zeroHash,
      previousFile: universalFiles.get(entry.file)?.previousFile ?? null,
    };
  });
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
    if (maxFunding + (universalFunding.get(address) ?? 0n) > balance[1]) throw new Error(`insufficient funding for ${address}`);
    return { address, root: targets.roots[index], total: total.toString(), maxFunding: maxFunding.toString() };
  });
  for (const [token, weekly] of universalFunding) {
    const balance = balances.get(token);
    if (!balance) throw new Error(`missing balance for ${token}`);
    if (!targets.tokens.includes(token) && weekly > balance[1]) throw new Error(`insufficient funding for ${token}`);
  }
  return { period, postFreeze: log.postFreeze === true, verified, distributor: DISTRIBUTOR, owner: OWNER, tokens, universal };
}

async function main() {
  const period = Math.floor(Date.now() / 1000 / 604800) * 604800;
  const log: LogData = JSON.parse(readFileSync("log.json", "utf8"));
  const merkle: MerkleEntry[] = JSON.parse(readFileSync(`bounties-reports/${period}/merkle.json`, "utf8"));
  const targets = ethereumTargets(log);
  const universalEntries = universalTargets(log);
  const universalFiles = loadUniversalFiles(period, universalEntries);
  checkV1(merkle, targets, log, universalEntries, universalFiles);
  const client = await getClient(1);
  for (const entry of universalEntries) {
    const active = await client.readContract({
      address: entry.distributor as `0x${string}`,
      abi: parseAbi(["function root() view returns (bytes32)"]), functionName: "root",
    });
    if (active.toLowerCase() !== (entry.previousRoot ?? zeroHash)) throw new Error(`${entry.file} active baseline changed`);
  }
  const balances = new Map<string, readonly [bigint, bigint]>();
  for (const token of new Set([...targets.tokens, ...universalEntries.map((entry) => entry.token)])) {
    balances.set(token, await Promise.all([
      client.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [DISTRIBUTOR] }),
      client.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [BOTMARKETS.ethereum as `0x${string}`] }),
    ]));
  }
  const distribution = buildDistribution(log, merkle, period, process.argv.includes("--verified"), balances, universalFiles);
  console.log(JSON.stringify({
    event: "sdtokens_distribution_checked", period,
    postFreeze: distribution.postFreeze,
    distributionSurplus: log.DistributionSurplus,
    tokens: distribution.tokens,
    universal: distribution.universal,
  }));
  writeFileSync(`bounties-reports/${period}/sdtokens-distribution.json`, JSON.stringify(distribution, null, 2) + "\n");
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
