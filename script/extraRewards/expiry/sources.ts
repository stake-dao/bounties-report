import fs from "fs";
import path from "path";
import { Address, parseAbi, PublicClient } from "viem";
import { EXTRA_REWARDS_DISTRIBUTOR, expiryKey } from "../../shared/merkle/expiry";

const ABI = parseAbi(["function incentives(uint256) view returns(address,address,uint256,uint256,uint256,uint256,address,uint256,address)"]);
const VM_HOOKS = new Set([
  "0x06ab7052b00d038f8eef33b267c23b5154ce8cdc",
  "0x68654d460fdf3231b49b25817cbbd72d8d291fcf",
]);

type Allocation = { token: { address: string }; distribution: { incentiveId: number }; users: { user: string; amount: string }[] };

export async function readVmRewards(client: PublicClient, allocations: Allocation[], rewards: Record<string, string>, block: bigint) {
  const ids = [...new Set(allocations.map(row => row.distribution.incentiveId))];
  if (ids.some(id => !Number.isSafeInteger(id) || id < 0)) throw new Error("invalid incentive id");
  const campaigns = new Map<number, readonly unknown[]>();
  for (let offset = 0; offset < ids.length; offset += 200) {
    const chunk = ids.slice(offset, offset + 200);
    const values = await client.multicall({
      contracts: chunk.map(id => ({ address: EXTRA_REWARDS_DISTRIBUTOR as Address, abi: ABI, functionName: "incentives" as const, args: [BigInt(id)] })),
      blockNumber: block, allowFailure: false,
    });
    chunk.forEach((id, i) => campaigns.set(id, values[i] as readonly unknown[]));
  }
  const allocated: Record<string, bigint> = {};
  const vm: Record<string, bigint> = {};
  for (const allocation of allocations) {
    const campaign = campaigns.get(allocation.distribution.incentiveId)!;
    const token = allocation.token.address;
    const verified = String(campaign[1]).toLowerCase() === token.toLowerCase()
      && BigInt(campaign[5] as bigint) === 42161n
      && VM_HOOKS.has(String(campaign[6]).toLowerCase());
    for (const user of allocation.users) {
      if (!/^\d+$/.test(user.amount)) throw new Error("invalid allocation amount");
      const key = expiryKey(user.user, token);
      const amount = BigInt(user.amount);
      allocated[key] = (allocated[key] ?? 0n) + amount;
      if (verified) vm[key] = (vm[key] ?? 0n) + amount;
    }
  }
  const result: Record<string, string> = {};
  for (const [key, amount] of Object.entries(rewards)) {
    const raw = allocated[key] ?? 0n;
    const net = BigInt(amount);
    if (net < 0n) throw new Error("negative reward delta");
    if (raw < net) continue;
    const eligible = (vm[key] ?? 0n) - (raw - net);
    if (eligible > 0n) result[key] = eligible.toString();
  }
  return result;
}

let history: { data: string; roots: string[] } | undefined;

export function readExtraPublication(root: string, parent: string) {
  const data = path.resolve("merkl-toolkit/data");
  const index: { timestamp: number }[] = JSON.parse(fs.readFileSync(path.join(data, "distribution.json"), "utf8"));
  const roots = history?.data === data ? history.roots : index.map(({ timestamp }) => {
    const file = path.join(data, "distributions", String(timestamp), "merkle.json");
    if (!fs.existsSync(file)) return "";
    const fd = fs.openSync(file, "r");
    const prefix = new Uint8Array(256);
    try { fs.readSync(fd, prefix, 0, prefix.length, 0); } finally { fs.closeSync(fd); }
    return new TextDecoder().decode(prefix).match(/"merkleRoot"\s*:\s*"(0x[0-9a-fA-F]{64})"/)?.[1].toLowerCase() ?? "";
  });
  history = { data, roots };
  const end = roots.indexOf(root.toLowerCase());
  if (end < 0) return null;
  const folder = path.join(data, "distributions", String(index[end].timestamp));
  const merkle = JSON.parse(fs.readFileSync(path.join(folder, "merkle.json"), "utf8"));
  let start = roots.lastIndexOf(parent.toLowerCase(), end - 1) + 1;
  if (merkle.parentRoot !== undefined) {
    if (merkle.parentRoot !== parent) throw new Error("extra rewards publication parent");
    start = index.findIndex(row => row.timestamp === merkle.firstDistribution);
    if (start < 0 || start > end) throw new Error("extra rewards allocation range");
  } else if (start === 0 && !/^0x0{64}$/.test(parent)) {
    start = end + 1;
  }
  const allocations: Allocation[] = [];
  for (let i = start; i <= end; ++i) {
    const distribution = JSON.parse(fs.readFileSync(path.join(data, "distributions", String(index[i].timestamp), "distribution.json"), "utf8"));
    allocations.push(...distribution.incentives);
  }
  return { merkle, allocations };
}
