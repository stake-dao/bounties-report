import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getAddress, parseAbiItem, PublicClient } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { verifyExpiryParent } from "../shared/merkle/expiry";
import { getClient } from "../utils/getClients";
import { ABI, EXTRA, OWNER, Review, pairKey } from "./prepare";
import { loadRoot, prepareOnchain } from "./run";
import configuration from "./config.json";

const rootEvent = parseAbiItem("event RootSet(bytes32 indexed newRoot,bytes32 indexed newIpfsHash)");
const claimEvent = parseAbiItem("event Claimed(address indexed account,address indexed recipient,address indexed reward,uint256 amount)");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const serialize = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n";

/** Recompute the proposal, then prove it was published without an intervening
 * affected claim. This is a post-execution audit, NOT an execution-time guard. */
export async function verifyAdoption(review: Review, report: { block: string; blockHash: string; sourceRoot: string; recoveryRoot: string }, candidate: MerkleData, txHash: `0x${string}`, client: PublicClient, resolveRoot = (root: string) => loadRoot(review, root)) {
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

  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const finalized = await client.getBlock({ blockTag: "finalized" });
  assert(receipt.status === "success" && receipt.blockNumber <= finalized.number!, "execution must be successful and finalized");
  assert(receipt.blockNumber > snapshot.number!, "execution must follow the preparation snapshot");
  assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash, "execution reorged");
  assert.equal(getAddress(receipt.to!), OWNER, "expected direct owner Safe transaction");
  const address = getAddress(review.distributor);
  const affected = new Set(prepared.recovery.rows.map(row => pairKey(row.account, row.token)));
  let publication: { blockNumber: bigint; logIndex: number } | undefined;
  for (let start = snapshot.number! + 1n; start <= receipt.blockNumber; start += 10000n) {
    const toBlock = start + 9999n < receipt.blockNumber ? start + 9999n : receipt.blockNumber;
    const roots = await client.getLogs({ address, event: rootEvent, fromBlock: start, toBlock });
    for (const log of roots) {
      assert(!log.removed && log.transactionHash === txHash && log.args.newRoot === candidate.merkleRoot && !publication, "unexpected root replacement after preparation");
      publication = { blockNumber: log.blockNumber!, logIndex: log.logIndex! };
    }
    const claims = await client.getLogs({ address, event: claimEvent, fromBlock: start, toBlock });
    for (const log of claims) {
      assert(!log.removed && log.args.account && log.args.reward, "claim history incomplete");
      const beforePublication = !publication || log.blockNumber! < publication.blockNumber || (log.blockNumber === publication.blockNumber && log.logIndex! < publication.logIndex);
      assert(!beforePublication || !affected.has(pairKey(log.args.account, log.args.reward)), "affected wallet claimed before recovery execution");
    }
  }
  assert(publication, "recovery publication missing");
  const latest = await client.getBlock();
  const at = { address, abi: ABI, blockNumber: latest.number! };
  assert.equal(await client.readContract({ ...at, functionName: "root" }), candidate.merkleRoot, "recovery is no longer active");
  assert.equal((await client.readContract({ ...at, functionName: "pendingRoot" }))[2], 0n, "another root is pending; keep publishers paused");
  assert.equal((await client.getBlock({ blockNumber: latest.number! })).hash, latest.hash, "adoption snapshot reorged");
  return { prepared, receipt: { transactionHash: txHash, block: receipt.blockNumber.toString(), blockHash: receipt.blockHash }, parent: resolveRoot(report.sourceRoot) };
}

/** Build the whole file plan before writing. Generated data is changed only by
 * the explicit adoption CLI, after verification, for a separately reviewed PR. */
export function adoptionFiles(review: Review, verified: Awaited<ReturnType<typeof verifyAdoption>>, reports = "bounties-reports", toolkit = "merkl-toolkit") {
  const { prepared, parent, receipt } = verified;
  const tree = prepared.recovery.merkle;
  const extra = getAddress(review.distributor) === EXTRA;
  const files = new Map<string, string>();
  const archive = path.join(reports, extra ? "recovery/extra/roots" : "expiry/roots", String(review.chainId));
  files.set(path.join(archive, `${parent.merkleRoot}.json`), serialize(parent));
  files.set(path.join(archive, `${tree.merkleRoot}.json`), serialize(tree));
  files.set(path.join(reports, "recovery", `${extra ? "extra" : "voters"}-${review.chainId}`, `${tree.merkleRoot}.json`), serialize({ review, ...prepared, receipt }));
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
    requireParent(lastArchive);
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
  const review: Review = read(pool.review);
  const verified = await verifyAdoption(review, read(path.join(directory, "report.json")), read(path.join(directory, "recovery-merkle.json")), txHash as `0x${string}`, await getClient(review.chainId));
  const files = adoptionFiles(review, verified);
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
