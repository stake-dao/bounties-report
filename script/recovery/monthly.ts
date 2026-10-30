import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getAddress, parseAbi, parseAbiItem, PublicClient, zeroHash } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { assertExpiryLedger, expiryKey, Ledger, Publication, sixCalendarMonths, syncExpiryClaims, verifyExpiryParent } from "../shared/merkle/expiry";
import { fetchClaimed } from "../verify/invariants/preservation";
import { ABI, EXTRA, RECIPIENT, Review } from "./prepare";

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const remaining = (credit: Ledger["pairs"][string]["credits"][number]) => BigInt(credit.granted) - BigInt(credit.paid) - BigInt(credit.recovered);
const eligible = (credit: Ledger["pairs"][string]["credits"][number], at: number) => credit.protection === null && credit.activatedAt !== null && sixCalendarMonths(credit.ageBoundAt ?? credit.activatedAt) <= at;
const rootEvent = parseAbiItem("event RootSet(bytes32 indexed newRoot,bytes32 indexed newIpfsHash)");
const incentiveAbi = parseAbi(["function incentives(uint256) view returns(address,address,uint256,uint256,uint256,uint256,address,uint256,address)"]);
const hooks = new Set(["0x06ab7052b00d038f8eef33b267c23b5154ce8cdc", "0x68654d460fdf3231b49b25817cbbd72d8d291fcf"]);

/** Last Thursday, 12:00 UTC. Before that window, finish the previous period. */
export function monthlyPeriod(at: number) {
  const date = new Date(at * 1000);
  const window = (year: number, month: number) => {
    const end = new Date(Date.UTC(year, month + 1, 0, 12));
    end.setUTCDate(end.getUTCDate() - (end.getUTCDay() + 3) % 7);
    return end;
  };
  let start = window(date.getUTCFullYear(), date.getUTCMonth());
  if (start.getTime() > at * 1000) start = window(date.getUTCFullYear(), date.getUTCMonth() - 1);
  return { period: start.toISOString().slice(0, 7), cutoff: start.getTime() / 1000 };
}

/** Append only ordinary cumulative increases. Unknown reductions require adoption. */
export function appendPublication(input: Ledger, publication: Publication, vmRewards?: Record<string, string>, historicalRepair = false): Ledger {
  assert(publication.merkle && publication.merkle.merkleRoot === publication.root, "publication artifact mismatch");
  const distribution = verifyExpiryParent(publication.merkle);
  const ledger = structuredClone(input);
  const amounts = new Map(Object.entries(distribution).flatMap(([account, tokens]) => Object.entries(tokens).map(([token, amount]) => [expiryKey(account, token), { account, token, amount }] as const)));
  for (const key of new Set([...Object.keys(ledger.pairs), ...amounts.keys()])) {
    const leaf = amounts.get(key);
    const pair = ledger.pairs[key] ??= { account: leaf!.account, token: leaf!.token, activeAmount: "0", paid: "0", credits: [] };
    const next = BigInt(leaf?.amount ?? "0"), previous = BigInt(pair.activeAmount);
    if (next < previous && historicalRepair) {
      assert.equal(pair.paid, "0", "historical repair must precede claim allocation");
      pair.credits = next ? [{ id: `${publication.root}:${key}:opening`, root: publication.root, granted: next.toString(), paid: "0", recovered: "0", activatedAt: null, protection: "unresolved historical repair" }] : [];
      pair.activeAmount = next.toString();
      continue;
    }
    assert(next >= previous, "Unadopted reduction: stop publishers and adopt the confirmed recovery");
    const increase = next - previous;
    const proven = ledger.distributor === EXTRA ? BigInt(vmRewards?.[key] ?? "0") : increase;
    assert(proven >= 0n && proven <= increase, "invalid VM allocation");
    // Historical reductions can leave paid above activeAmount. New rewards
    // first refill that already-paid gap; charge it against VM credits first.
    const gap = BigInt(pair.paid) > previous ? BigInt(pair.paid) - previous : 0n;
    const absorbed = increase < gap ? increase : gap;
    const delta = increase - absorbed;
    const vm = proven > absorbed ? proven - absorbed : 0n;
    for (const [amount, protection] of [[vm, null], [delta - vm, "non-VM or unknown source"]] as const) {
      if (!amount) continue;
      pair.credits.push({ id: `${publication.block}:${publication.logIndex}:${key}:${pair.credits.length}`, root: publication.root, granted: amount.toString(), paid: "0", recovered: "0", activatedAt: publication.timestamp, protection });
    }
    pair.activeAmount = next.toString();
  }
  ledger.root = publication.root;
  ledger.checkpoint = { block: publication.block, blockHash: publication.blockHash, logIndex: publication.logIndex };
  assertExpiryLedger(ledger);
  return ledger;
}

export function monthlyReview(ledger: Ledger, cutoff: number, period: string): Review {
  assertExpiryLedger(ledger);
  return {
    chainId: ledger.chainId, distributor: ledger.distributor, recipient: RECIPIENT,
    sourceRoot: ledger.root, sourceFile: "source-merkle.json", cutoff, period,
    checkpoint: { block: String(ledger.checkpoint.block), hash: ledger.checkpoint.blockHash },
    provenance: "Canonical publication ledger; six UTC calendar months; extra rewards VM-only",
    rows: Object.values(ledger.pairs).filter(pair => pair.account !== RECIPIENT).flatMap(pair => {
      const maximum = pair.credits.filter(credit => eligible(credit, cutoff)).reduce((sum, credit) => sum + remaining(credit), 0n);
      return maximum > 0n ? [{ account: pair.account, token: pair.token, claimed: pair.paid, maximum: maximum.toString() }] : [];
    }),
  };
}

/** Keep the unexpired credit ages after a confirmed recovery; never re-bootstrap reductions. */
export function recoverLedger(input: Ledger, review: Review, rows: { account: string; token: string; claimed: string; recovered: string }[], tree: MerkleData, checkpoint: Ledger["checkpoint"]): Ledger {
  const claims = Object.fromEntries(Object.entries(input.pairs).map(([key, pair]) => [key, pair.paid]));
  for (const row of rows) claims[expiryKey(row.account, row.token)] = row.claimed;
  const ledger = syncExpiryClaims(input, claims);
  for (const row of rows) {
    const pair = ledger.pairs[expiryKey(row.account, row.token)];
    let amount = BigInt(row.recovered);
    for (const credit of pair.credits.filter(credit => eligible(credit, review.cutoff))) {
      const take = remaining(credit) < amount ? remaining(credit) : amount;
      credit.recovered = (BigInt(credit.recovered) + take).toString();
      amount -= take;
    }
    assert.equal(amount, 0n, "recovery exceeds eligible ledger credits");
    pair.activeAmount = (BigInt(pair.activeAmount) - BigInt(row.recovered)).toString();
  }
  // New treasury credit is protected. Funding offsets never touch old treasury credit.
  const distribution = verifyExpiryParent(tree);
  for (const [token, amount] of Object.entries(distribution[RECIPIENT] ?? {})) {
    const key = expiryKey(RECIPIENT, token);
    const pair = ledger.pairs[key] ??= { account: RECIPIENT, token, activeAmount: "0", paid: "0", credits: [] };
    const delta = BigInt(amount) - BigInt(pair.activeAmount);
    assert(delta >= 0n, "existing DAO entitlement decreased");
    if (delta) pair.credits.push({ id: `${tree.merkleRoot}:${key}`, root: tree.merkleRoot, granted: delta.toString(), paid: "0", recovered: "0", activatedAt: null, protection: "recovered DAO rewards" });
    pair.activeAmount = amount;
  }
  for (const pair of Object.values(ledger.pairs)) assert.equal(pair.activeAmount, distribution[pair.account]?.[pair.token] ?? "0", "recovery tree differs from ledger");
  ledger.root = tree.merkleRoot;
  ledger.checkpoint = checkpoint;
  ledger.recoveries.push(tree.merkleRoot);
  assertExpiryLedger(ledger);
  return ledger;
}

type Allocation = { token: { address: string }; distribution: { incentiveId: number }; users: { user: string; amount: string }[] };
export async function vmRewards(client: PublicClient, allocations: Allocation[], deltas: Record<string, string>, block: bigint) {
  const ids = [...new Set(allocations.map(row => row.distribution.incentiveId))];
  assert(ids.every(id => Number.isSafeInteger(id) && id >= 0), "invalid incentive id");
  const campaigns = new Map<number, readonly unknown[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const values = await client.multicall({ contracts: chunk.map(id => ({ address: EXTRA, abi: incentiveAbi, functionName: "incentives" as const, args: [BigInt(id)] })), blockNumber: block, allowFailure: false });
    chunk.forEach((id, j) => campaigns.set(id, values[j] as readonly unknown[]));
  }
  const totals = new Map<string, { raw: bigint; vm: bigint }>();
  for (const allocation of allocations) {
    const campaign = campaigns.get(allocation.distribution.incentiveId)!;
    const verified = getAddress(String(campaign[1])) === getAddress(allocation.token.address) && BigInt(campaign[5] as bigint) === 42161n && hooks.has(String(campaign[6]).toLowerCase());
    for (const user of allocation.users) {
      assert(/^\d+$/.test(user.amount), "invalid allocation amount");
      const key = expiryKey(user.user, allocation.token.address);
      const total = totals.get(key) ?? { raw: 0n, vm: 0n };
      total.raw += BigInt(user.amount);
      if (verified) total.vm += BigInt(user.amount);
      totals.set(key, total);
    }
  }
  return Object.fromEntries(Object.entries(deltas).flatMap(([key, amount]) => {
    const total = totals.get(key), net = BigInt(amount);
    assert(net >= 0n, "negative allocation delta");
    if (!total || total.raw < net) return [];
    const vm = total.vm - (total.raw - net); // Charge redirects against VM first.
    return vm > 0n ? [[key, vm.toString()]] : [];
  }));
}

/** Index every archive, not just distribution.json (which omits published roots). */
export function rootFiles(extra: boolean, chainId: number) {
  const directory = extra ? "merkl-toolkit/data/distributions" : "bounties-reports";
  const filename = extra ? "merkle.json" : `vlCVX/vlcvx_merkle${chainId === 1 ? "" : `_${chainId}`}.json`;
  const entries: { timestamp: number; root: string; file: string }[] = [];
  for (const folder of fs.readdirSync(directory).filter(name => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b))) {
    const files = [path.join(directory, folder, filename)];
    // This checked-in backup is the published March 25 tree, before wrapper repair.
    if (extra && folder === "1774440599") files.push("merkl-toolkit/data/last_merkle.json.bak");
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const fd = fs.openSync(file, "r"), prefix = Buffer.alloc(512);
      try { fs.readSync(fd, prefix, 0, prefix.length, 0); } finally { fs.closeSync(fd); }
      const root = prefix.toString().match(/"merkleRoot"\s*:\s*"(0x[0-9a-fA-F]{64})"/)?.[1];
      if (root) entries.push({ timestamp: Number(folder), root, file });
    }
  }
  return entries;
}

export async function prepareMonthly(seed: Review, client: PublicClient, at: number, archive: string, until?: bigint) {
  const window = monthlyPeriod(at);
  assert.equal(await client.getChainId(), seed.chainId, "RPC chain mismatch");
  let finalized = await client.getBlock({ blockTag: "finalized" });
  if (until !== undefined) {
    assert(until <= finalized.number!, "monthly checkpoint is not finalized");
    finalized = await client.getBlock({ blockNumber: until });
  }
  const completed = fs.existsSync(archive) ? fs.readdirSync(archive).filter(file => file.endsWith(".json")).map(file => read(path.join(archive, file))).filter(entry => until === undefined || BigInt(entry.receipt.block) <= until) : [];
  completed.sort((a, b) => Number(b.receipt.block) - Number(a.receipt.block));
  if (completed.some(entry => entry.review.period === window.period)) return { status: "noop", reason: "Monthly recovery already adopted", ...window };
  const extra = seed.distributor === EXTRA;
  let ledger: Ledger;
  if (completed.length) {
    assert(completed[0].ledger, "Adopt a publication ledger before enabling monthly recovery");
    ledger = completed[0].ledger;
  } else if (!extra) ledger = read(`bounties-reports/expiry/bootstrap/${seed.chainId}/ledger.json`);
  else {
    let low = 0n, high = finalized.number!;
    while (high - low > 1n) {
      const middle = (low + high) / 2n;
      const code = await client.getBytecode({ address: EXTRA, blockNumber: middle });
      if (code && code !== "0x") high = middle; else low = middle;
    }
    const block = await client.getBlock({ blockNumber: low });
    ledger = { version: 1, chainId: 1, distributor: EXTRA, root: zeroHash, checkpoint: { block: Number(low), blockHash: block.hash! }, pairs: {}, recoveries: [], runs: {} };
  }
  assertExpiryLedger(ledger);
  assert.equal(ledger.chainId, seed.chainId, "ledger chain mismatch");
  assert.equal(ledger.distributor, seed.distributor, "ledger distributor mismatch");
  assert.equal((await client.getBlock({ blockNumber: BigInt(ledger.checkpoint.block) })).hash, ledger.checkpoint.blockHash, "ledger checkpoint reorged");
  if (Object.keys(ledger.pairs).length) assert.equal(await client.readContract({ address: getAddress(seed.distributor), abi: ABI, functionName: "root", blockNumber: BigInt(ledger.checkpoint.block) }), ledger.root, "ledger checkpoint root mismatch");
  const archives = rootFiles(extra, seed.chainId);
  const resolve = (root: string): MerkleData | undefined => {
    const entry = archives.find(entry => entry.root === root);
    if (entry) return read(entry.file);
    const file = `bounties-reports/${extra ? "recovery/extra" : "expiry"}/roots/${seed.chainId}/${root}.json`;
    return fs.existsSync(file) ? read(file) : undefined;
  };
  let unresolvedHistory = false;
  const startBlock = BigInt(ledger.checkpoint.block) + (ledger.checkpoint.logIndex === undefined ? 1n : 0n);
  for (let start = startBlock; start <= finalized.number!; start += 10000n) {
    const logs = await client.getLogs({ address: getAddress(seed.distributor), event: rootEvent, fromBlock: start, toBlock: start + 9999n < finalized.number! ? start + 9999n : finalized.number! });
    for (const log of logs) {
      assert(!log.removed && log.args.newRoot && log.blockNumber !== null && log.logIndex !== null, "invalid publication");
      if (log.blockNumber === BigInt(ledger.checkpoint.block) && log.logIndex <= (ledger.checkpoint.logIndex ?? Number.MAX_SAFE_INTEGER)) continue;
      const block = await client.getBlock({ blockNumber: log.blockNumber });
      assert.equal(block.hash, log.blockHash, "publication reorged");
      if (log.args.newRoot === zeroHash) continue; // A historical freeze grants no credit.
      const merkle = resolve(log.args.newRoot);
      if (!merkle) {
        assert(extra && !completed.length && log.blockNumber <= BigInt(seed.checkpoint.block), `Published artifact unavailable: ${log.args.newRoot}`);
        unresolvedHistory = true;
        ledger.root = log.args.newRoot;
        continue;
      }
      // Missing historical roots destroy age/provenance evidence. Protect the
      // entire next known opening balance, then age only later proven increases.
      if (unresolvedHistory) ledger.pairs = {};
      const publication = { root: log.args.newRoot, merkle, block: Number(block.number), blockHash: block.hash!, timestamp: Number(block.timestamp), logIndex: log.logIndex };
      let vm: Record<string, string> | undefined;
      if (extra && !unresolvedHistory) {
        const end = archives.findIndex(entry => entry.root === publication.root);
        const parent = archives.findIndex(entry => entry.root === ledger.root);
        // An adopted recovery substitutes its original parent in the archive sequence.
        const recoveredParent = completed.find(entry => entry.recoveryRoot === ledger.root)?.sourceRoot;
        const from = parent >= 0 ? parent : recoveredParent ? archives.findIndex(entry => entry.root === recoveredParent) : -1;
        assert(end >= 0 && (from >= 0 || ledger.root === zeroHash), "extra allocation history unavailable");
        const firstTimestamp = from >= 0 ? archives[from].timestamp : 0;
        assert(archives[end].timestamp >= firstTimestamp, "extra publication order");
        const allocations: Allocation[] = [];
        const timestamps = new Set(archives.filter(entry => entry.timestamp > firstTimestamp && entry.timestamp <= archives[end].timestamp).map(entry => entry.timestamp));
        for (const timestamp of timestamps) allocations.push(...read(`merkl-toolkit/data/distributions/${timestamp}/distribution.json`).incentives);
        const deltas = Object.fromEntries(Object.entries(verifyExpiryParent(merkle)).flatMap(([a, ts]) => Object.entries(ts).flatMap(([t, value]) => {
          const key = expiryKey(a, t), delta = BigInt(value) - BigInt(ledger.pairs[key]?.activeAmount ?? "0");
          return delta > 0n ? [[key, delta.toString()]] : [];
        })));
        vm = await vmRewards(client, allocations, deltas, block.number!);
      }
      ledger = appendPublication(ledger, publication, vm, extra && !completed.length && log.blockNumber <= BigInt(seed.checkpoint.block));
      unresolvedHistory = false;
    }
  }
  const active = await client.readContract({ address: getAddress(seed.distributor), abi: ABI, functionName: "root", blockNumber: finalized.number! });
  assert(!unresolvedHistory && ledger.root === active, "active publication history incomplete");
  if (extra && until === undefined && completed.some(entry => entry.recoveryRoot === active)) {
    return { status: "waiting", reason: "Wait for an ordinary extra distribution after the previous recovery", ...window };
  }
  // A chain with no new rewards can legitimately retain its previous root.
  const canonical = extra ? "merkl-toolkit/data/last_merkle.json" : `bounties-reports/latest/vlCVX/vlcvx_merkle${seed.chainId === 1 ? "" : `_${seed.chainId}`}.json`;
  const published = read(canonical);
  verifyExpiryParent(published);
  if (until === undefined && published.merkleRoot !== active) return { status: "waiting", reason: "Wait for the active finalized root and canonical proofs to match", ...window };
  const pairs = Object.values(ledger.pairs).map(pair => [pair.account, pair.token] as [string, string]);
  const values = await fetchClaimed(client, { target: "voters", chainId: seed.chainId, distributor: getAddress(seed.distributor), pinnedBlock: finalized.number! }, pairs, 150);
  const claims = Object.fromEntries([...values].map(([key, value]) => [key.toLowerCase(), value.toString()]));
  if (extra && !completed.length) for (const [key, pair] of Object.entries(ledger.pairs)) {
    const offset = BigInt(claims[key]) - BigInt(pair.activeAmount);
    if (offset > 0n) pair.credits.unshift({ id: `${key}:paid-offset`, root: ledger.root, granted: offset.toString(), paid: "0", recovered: "0", activatedAt: null, protection: "lifetime paid offset" });
  }
  ledger = syncExpiryClaims(ledger, claims);
  ledger.checkpoint = { block: Number(finalized.number), blockHash: finalized.hash! };
  assert.equal((await client.getBlock({ blockNumber: finalized.number! })).hash, finalized.hash, "monthly snapshot reorged");
  const source = resolve(active);
  assert(source, "active publication artifact missing");
  return { ...window, ledger, review: monthlyReview(ledger, window.cutoff, window.period), source };
}
