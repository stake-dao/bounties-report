import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getAddress, keccak256, parseAbiItem, PublicClient } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { Ledger, verifyExpiryParent } from "../shared/merkle/expiry";
import { getClient } from "../utils/getClients";
import { ABI, EXTRA, OWNER, TREASURY_RECIPIENT, Review, pairKey } from "./prepare";
import { loadRoot, prepareOnchain } from "./run";
import { prepareMonthly, recoverLedger } from "./monthly";
import { MODULE_ABI, transition } from "./transition";
import configuration from "./config.json";

const rootEvent = parseAbiItem("event RootSet(bytes32 indexed newRoot,bytes32 indexed newIpfsHash)");
const claimEvent = parseAbiItem("event Claimed(address indexed account,address indexed recipient,address indexed reward,uint256 amount)");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const serialize = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n";

/** Recompute the proposal, then prove it was published without an intervening
 * affected claim. This is a post-execution audit, NOT an execution-time guard. */
export async function verifyAdoption(review: Review, report: { block: string; blockHash: string; sourceRoot: string; recoveryRoot: string; payouts?: { token: string; amount: string }[]; automatic?: ReturnType<typeof transition> }, candidate: MerkleData, txHash: `0x${string}`, client: PublicClient, resolveRoot = (root: string) => loadRoot(review, root)) {
  assert(/^\d+$/.test(report.block) && /^0x[0-9a-f]{64}$/i.test(txHash), "invalid adoption input");
  verifyExpiryParent(candidate);
  const snapshot = await client.getBlock({ blockNumber: BigInt(report.block) });
  assert.equal(snapshot.hash, report.blockHash, "preparation snapshot reorged");
  // All other calls already pass explicit block numbers; pin only getBlock().
  const pinned = { ...client, getBlock: (args?: any) => args ? client.getBlock(args) : Promise.resolve(snapshot) } as PublicClient;
  const prepared = await prepareOnchain(review, resolveRoot(review.sourceRoot), pinned, null, resolveRoot);
  assert("recovery" in prepared && prepared.recovery.rows.length && !prepared.deficits.length, "proposal no longer reproducible or funded");
  assert.equal(prepared.sourceRoot, report.sourceRoot, "proposal parent mismatch");
  assert.equal(prepared.recoveryRoot, report.recoveryRoot, "proposal root mismatch");
  assert.equal(prepared.recoveryRoot, candidate.merkleRoot, "candidate differs from recomputed recovery");
  // Archived root-only preparations remain replayable. New preparations also
  // prove that their claims occurred in the very same Safe execution.
  if (report.payouts !== undefined) assert.deepEqual(report.payouts, prepared.recovery.payouts, "payouts differ from preparation replay");
  if (review.execution === "module-v1") {
    assert(report.automatic, "module authorization missing");
    const pool = getAddress(review.distributor) === EXTRA ? "extra-1" : "voters-1";
    const module = (configuration.modules as Record<string, { address: string; codeHash: string } | null>)[pool];
    assert(module && getAddress(module.address) === getAddress(report.automatic.module), "unapproved recovery module");
    const code = await client.getBytecode({ address: getAddress(module.address), blockNumber: snapshot.number! });
    assert(code && keccak256(code) === module.codeHash, "module bytecode mismatch");
    const expectedProposal = await client.readContract({ address: getAddress(module.address), abi: MODULE_ABI, functionName: "proposal", blockNumber: snapshot.number! });
    assert.deepEqual(report.automatic, transition(review, resolveRoot(report.sourceRoot), prepared.recovery, module.address, BigInt(report.automatic.nonce), expectedProposal), "module transition differs from replay");
  } else assert(!report.automatic, "legacy review cannot authorize a module");

  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const finalized = await client.getBlock({ blockTag: "finalized" });
  assert(receipt.status === "success" && receipt.blockNumber <= finalized.number!, "execution must be successful and finalized");
  assert(receipt.blockNumber > snapshot.number!, "execution must follow the preparation snapshot");
  assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash, "execution reorged");
  if (report.automatic) {
    const activations = await client.getLogs({ address: getAddress(report.automatic.module), event: parseAbiItem("event Activated(bytes32 indexed proposal,bytes32 indexed parent,bytes32 indexed root)"), fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
    const matching = activations.filter(log => log.transactionHash === txHash);
    assert.equal(matching.length, 1, "expected one module activation in execution transaction");
    const activation = matching[0];
    assert(!activation.removed && activation.blockHash === receipt.blockHash, "module activation reorged");
    assert.equal(activation.args.proposal, report.automatic.proposal, "wrong module proposal");
    assert.equal(activation.args.parent, report.sourceRoot, "wrong module parent");
    assert.equal(activation.args.root, candidate.merkleRoot, "wrong module root");
  } else assert.equal(getAddress(receipt.to!), OWNER, "expected direct owner Safe transaction");
  const address = getAddress(review.distributor);
  const affected = new Set(prepared.recovery.rows.map(row => pairKey(row.account, row.token)));
  const paid = new Set<string>();
  const treasuryPaid = new Map<string, bigint>();
  if (report.automatic) for (const payout of report.payouts ?? []) {
    treasuryPaid.set(getAddress(payout.token), await client.readContract({ address, abi: ABI, functionName: "claimed", args: [TREASURY_RECIPIENT, getAddress(payout.token)], blockNumber: snapshot.number! }));
  }
  let publication: { blockNumber: bigint; logIndex: number } | undefined;
  for (let start = snapshot.number! + 1n; start <= receipt.blockNumber; start += 10000n) {
    const toBlock = start + 9999n < receipt.blockNumber ? start + 9999n : receipt.blockNumber;
    const roots = await client.getLogs({ address, event: rootEvent, fromBlock: start, toBlock });
    for (const log of roots) {
      assert(!log.removed && log.transactionHash === txHash && log.args.newRoot === candidate.merkleRoot && !publication, "unexpected root replacement after preparation");
      assert(log.blockNumber !== null && log.logIndex !== null && log.blockHash && log.blockNumber >= start && log.blockNumber <= toBlock, "publication outside snapshot");
      assert.equal((await client.getBlock({ blockNumber: log.blockNumber })).hash, log.blockHash, "publication block is not canonical");
      if (report.automatic) assert.equal(log.args.newIpfsHash, report.automatic.proposal, "root publication is not bound to module proposal");
      publication = { blockNumber: log.blockNumber!, logIndex: log.logIndex! };
    }
    const claims = await client.getLogs({ address, event: claimEvent, fromBlock: start, toBlock });
    for (const log of claims) {
      assert(!log.removed && log.args.account && log.args.reward, "claim history incomplete");
      assert(log.blockNumber !== null && log.logIndex !== null && log.blockHash && log.blockNumber >= start && log.blockNumber <= toBlock, "claim outside snapshot");
      assert.equal((await client.getBlock({ blockNumber: log.blockNumber })).hash, log.blockHash, "claim block is not canonical");
      const beforePublication = !publication || log.blockNumber! < publication.blockNumber || (log.blockNumber === publication.blockNumber && log.logIndex! < publication.logIndex);
      assert(!beforePublication || !affected.has(pairKey(log.args.account, log.args.reward)), "affected wallet claimed before recovery execution");
      const token = getAddress(log.args.reward);
      if (report.automatic && getAddress(log.args.account) === TREASURY_RECIPIENT && treasuryPaid.has(token)) {
        const payout = report.payouts!.find(p => getAddress(p.token) === token)!;
        const cumulative = treasuryPaid.get(token)! + log.args.amount!;
        assert(cumulative <= BigInt(payout.amount), "unexpected Treasury overpayment");
        treasuryPaid.set(token, cumulative);
        if (beforePublication && cumulative === BigInt(payout.amount)) paid.add(token);
      }
      if (report.payouts !== undefined && log.transactionHash === txHash && getAddress(log.args.account) === TREASURY_RECIPIENT) {
        assert(!beforePublication && log.args.recipient && getAddress(log.args.recipient) === TREASURY_RECIPIENT, "Treasury claim not paid directly after publication");
        paid.add(getAddress(log.args.reward));
      }
    }
  }
  assert(publication, "recovery publication missing");
  if (report.automatic) for (const payout of report.payouts ?? []) {
    assert.equal(treasuryPaid.get(getAddress(payout.token)), BigInt(payout.amount), "Treasury payout amount mismatch");
  }
  if (report.payouts !== undefined) assert.deepEqual([...paid].sort(), report.payouts.map(p => getAddress(p.token)).sort(), "atomic Treasury claims missing or unexpected");
  const latest = await client.getBlock();
  const at = { address, abi: ABI, blockNumber: latest.number! };
  assert.equal(await client.readContract({ ...at, functionName: "root" }), candidate.merkleRoot, "recovery is no longer active");
  assert.equal((await client.readContract({ ...at, functionName: "pendingRoot" }))[2], 0n, "another root is pending; keep publishers paused");
  assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash, "execution reorged during adoption");
  assert.equal((await client.getBlock({ blockNumber: latest.number! })).hash, latest.hash, "adoption snapshot reorged");
  return { prepared: { ...prepared, ...(report.automatic ? { automatic: report.automatic, status: "executed" } : {}) }, receipt: { transactionHash: txHash, block: receipt.blockNumber.toString(), blockHash: receipt.blockHash, logIndex: publication.logIndex }, parent: resolveRoot(report.sourceRoot) };
}

/** Build the whole file plan before writing. Generated data is changed only by
 * the explicit adoption CLI, after verification, for a separately reviewed PR. */
export function adoptionFiles(review: Review, verified: Awaited<ReturnType<typeof verifyAdoption>>, reports = "bounties-reports", toolkit = "merkl-toolkit", ledger?: Ledger) {
  const { prepared, parent, receipt } = verified;
  const tree = prepared.recovery.merkle;
  const extra = getAddress(review.distributor) === EXTRA;
  const files = new Map<string, string>();
  const archive = path.join(reports, extra ? "recovery/extra/roots" : "expiry/roots", String(review.chainId));
  files.set(path.join(archive, `${parent.merkleRoot}.json`), serialize(parent));
  files.set(path.join(archive, `${tree.merkleRoot}.json`), serialize(tree));
  files.set(path.join(reports, "recovery", `${extra ? "extra" : "voters"}-${review.chainId}`, `${tree.merkleRoot}.json`), serialize({ review, ...prepared, receipt, ...(ledger ? { ledger } : {}) }));
  if (review.chainId === 1 && review.recipient === TREASURY_RECIPIENT) {
    const pool = extra ? "extra-1" : "voters-1";
    const pointer = path.join(reports, "recovery/treasury-claims", `${pool}.json`);
    const index = fs.existsSync(pointer) ? read(pointer) : { version: 1, chainId: 1, recipient: TREASURY_RECIPIENT, pools: {} };
    assert(index.version === 1 && index.chainId === 1 && index.recipient === TREASURY_RECIPIENT, "claim index target mismatch");
    assert(Object.keys(index.pools).every(name => name === pool), "claim index pool target mismatch");
    const previous = index.pools[pool];
    const amounts = Object.fromEntries(Object.entries(tree.claims[TREASURY_RECIPIENT]?.tokens ?? {}).map(([token, claim]) => [token, claim.amount]));
    // Retries may see this exact adoption already published. Otherwise every
    // opening entitlement must come from the preceding approved recovery.
    if (previous?.root !== tree.merkleRoot) {
      const opening = parent.claims[TREASURY_RECIPIENT]?.tokens ?? {};
      for (const token of new Set([...Object.keys(opening), ...Object.keys(previous?.amounts ?? {})])) {
        assert.equal(opening[token]?.amount ?? "0", previous?.amounts[token] ?? "0", "unaccounted Treasury Merkle entitlement; review the cutover");
      }
    }
    index.pools[pool] = { distributor: review.distributor, root: tree.merkleRoot, receipt, amounts };
    files.set(pointer, serialize(index));
  }
  const requireParent = (file: string) => {
    const current = read(file);
    verifyExpiryParent(current);
    assert([parent.merkleRoot, tree.merkleRoot].includes(current.merkleRoot), "local baseline has advanced; stop and reconcile before adoption");
  };
  if (extra) {
    const latest = path.join(toolkit, "data/last_merkle.json");
    requireParent(latest);
    const distributions = read(path.join(toolkit, "data/distribution.json"));
    assert(distributions.length, "no extra distribution history");
    const lastArchive = path.join(toolkit, "data/distributions", String(distributions.at(-1).timestamp), "merkle.json");
    if (review.execution === "module-v1") {
      let ancestor = parent.merkleRoot;
      const seen = new Set<string>();
      while (fs.existsSync(path.join(toolkit, "data/recoveries", `${ancestor}.json`))) {
        assert(!seen.has(ancestor), "recovery ancestry cycle");
        seen.add(ancestor);
        const prior = read(path.join(toolkit, "data/recoveries", `${ancestor}.json`));
        assert.equal(prior.merkle.merkleRoot, ancestor, "recovery ancestry mismatch");
        verifyExpiryParent(prior.merkle);
        ancestor = prior.sourceRoot;
      }
      assert.equal(read(lastArchive).merkleRoot, ancestor, "ordinary extra baseline changed");
    } else requireParent(lastArchive);
    files.set(path.join(toolkit, "data/recoveries", `${tree.merkleRoot}.json`), serialize({ sourceRoot: parent.merkleRoot, receipt, merkle: tree }));
    files.set(latest, serialize(tree));
  } else {
    const filename = `vlCVX/vlcvx_merkle${review.chainId === 1 ? "" : `_${review.chainId}`}.json`;
    const periods = fs.readdirSync(reports).filter(p => /^\d+$/.test(p)).sort((a, b) => Number(b) - Number(a));
    const periodFile = periods.map(p => path.join(reports, p, filename)).find(file => fs.existsSync(file));
    assert(periodFile, "missing voters period");
    const latest = path.join(reports, "latest", filename);
    requireParent(periodFile); requireParent(latest);
    // Both generation and independent week-delta reconstruction must see the
    // same reduced baseline. Original cumulative tree stays in the root archive.
    files.set(periodFile, serialize(tree));
    files.set(latest, serialize(tree));
  }
  return files;
}

async function main() {
  const [poolName, directory, txHash] = process.argv.slice(2);
  const pool = configuration.pools.find(pool => pool.name === poolName);
  assert(pool && directory, "usage: adopt.ts <pool> <prepared-pool-directory> <safe-tx-hash> [--write]");
  const seed: Review = read(pool.review);
  const review: Review = fs.existsSync(path.join(directory, "review.json")) ? read(path.join(directory, "review.json")) : seed;
  assert.equal(review.chainId, seed.chainId, "review chain mismatch");
  assert.equal(review.distributor, seed.distributor, "review distributor mismatch");
  const client = await getClient(review.chainId);
  let ledger: Ledger | undefined;
  if (review.period) {
    const replay = await prepareMonthly(seed, client, review.cutoff, `bounties-reports/recovery/${poolName}`, BigInt(review.checkpoint.block), review.recipient, review.execution === "module-v1");
    assert("review" in replay, "monthly eligibility is not reproducible");
    assert.deepEqual(replay.review, review, "monthly eligibility differs from canonical replay");
    ledger = replay.ledger;
  } else assert.deepEqual(review, seed, "unapproved fixed review");
  const resolve = (root: string) => review.period && root === review.sourceRoot ? read(path.join(directory, "source-merkle.json")) : loadRoot(review, root);
  const verified = await verifyAdoption(review, read(path.join(directory, "report.json")), read(path.join(directory, "recovery-merkle.json")), txHash as `0x${string}`, client, resolve);
  if (ledger) ledger = recoverLedger(ledger, review, verified.prepared.recovery.rows, verified.prepared.recovery.merkle, { block: Number(verified.receipt.block), blockHash: verified.receipt.blockHash, logIndex: verified.receipt.logIndex });
  const files = adoptionFiles(review, verified, "bounties-reports", "merkl-toolkit", ledger);
  for (const [file, contents] of files) {
    if (process.argv.includes("--write")) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    console.log(`${process.argv.includes("--write") ? "Prepared" : "Would update"}: ${file}`);
  }
}

if (require.main === module) main().catch(error => {
  console.error(error instanceof assert.AssertionError ? error.message.split("\n")[0] : "Recovery adoption failed; check inputs and RPC state");
  process.exitCode = 1;
});
