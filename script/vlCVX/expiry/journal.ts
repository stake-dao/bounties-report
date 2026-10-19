import fs from "fs";
import path from "path";
import { utils } from "ethers";
import { Address, Hash, parseAbi, parseAbiItem, PublicClient } from "viem";
import { MerkleData } from "../../interfaces/MerkleData";
import { applyConfirmedExpiry, assertExpiryLedger, EXPIRY_DISTRIBUTOR, expiryDigest, expiryKey, Ledger, PreparedExpiry, recordExpiryDistribution, syncExpiryClaims, writeExpiryInput } from "../../shared/merkle/expiry";
import { readConfirmedExpiry } from "./chain";

const ROOT_SET = parseAbiItem("event RootSet(bytes32 indexed newRoot, bytes32 indexed newIpfsHash)");
const ACTIVATED = parseAbiItem("event Activated(bytes32 indexed digest, bytes32 indexed parent, bytes32 indexed root, uint256 recovered)");
const CLAIM = parseAbiItem("event Claimed(address indexed account,address indexed recipient,address indexed reward,uint256 amount)");
const URD_ABI = parseAbi(["function root() view returns(bytes32)", "function claimed(address,address) view returns(uint256)"]);

export async function readLedgerClaims(client: PublicClient, ledger: Ledger, block: bigint, merkle?: MerkleData, beforeLog?: number) {
  const pairs = new Map(Object.entries(ledger.pairs).map(([key, pair]) => [key, [pair.account, pair.token]]));
  for (const [account, claim] of Object.entries(merkle?.claims ?? {})) {
    for (const token of Object.keys(claim.tokens)) pairs.set(expiryKey(account, token), [account, token]);
  }
  const claims: Record<string, string> = {};
  const entries = [...pairs];
  for (let i = 0; i < entries.length; i += 200) {
    const chunk = entries.slice(i, i + 200);
    const values = await client.multicall({
      contracts: chunk.map(([, [account, token]]) => ({ address: EXPIRY_DISTRIBUTOR as Address, abi: URD_ABI, functionName: "claimed" as const, args: [account as Address, token as Address] })),
      blockNumber: beforeLog === undefined ? block : block - 1n, allowFailure: false,
    });
    chunk.forEach(([key], j) => { claims[key] = (values[j] as bigint).toString(); });
  }
  if (beforeLog !== undefined) {
    const events = await client.getLogs({ address: EXPIRY_DISTRIBUTOR, event: CLAIM, fromBlock: block, toBlock: block });
    for (const event of events) {
      if (event.logIndex === null || event.logIndex >= beforeLog || event.removed) continue;
      const key = expiryKey(event.args.account!, event.args.reward!);
      if (claims[key] !== undefined) claims[key] = (BigInt(claims[key]) + event.args.amount!).toString();
    }
  }
  return claims;
}

export async function replayExpiryJournal(client: PublicClient, directory: string, module: PreparedExpiry["module"], until?: Ledger["checkpoint"]): Promise<Ledger> {
  let ledger: Ledger = JSON.parse(fs.readFileSync(path.join(directory, "bootstrap.json"), "utf8"));
  const checkpoint = await client.getBlock({ blockNumber: BigInt(ledger.checkpoint.block) });
  if (checkpoint.hash !== ledger.checkpoint.blockHash || await client.readContract({ address: EXPIRY_DISTRIBUTOR, abi: URD_ABI, functionName: "root", blockNumber: checkpoint.number! }) !== ledger.root) throw new Error("bootstrap checkpoint reorged");
  let finalized = await client.getBlock({ blockTag: "finalized" });
  if (until) {
    if (finalized.number === null || BigInt(until.block) > finalized.number) throw new Error("prepared checkpoint is not finalized");
    finalized = await client.getBlock({ blockNumber: BigInt(until.block) });
    if (finalized.hash !== until.blockHash) throw new Error("prepared checkpoint reorged");
  }
  if (finalized.number === null || finalized.number < checkpoint.number!) throw new Error("bootstrap is not finalized");
  assertExpiryLedger(ledger);
  const preparedDir = path.join(directory, "prepared");
  const prepared = fs.existsSync(preparedDir) ? fs.readdirSync(preparedDir).filter(file => file.endsWith(".json")).map(file => JSON.parse(fs.readFileSync(path.join(preparedDir, file), "utf8")) as PreparedExpiry) : [];
  if (prepared.some(input => JSON.stringify(input.module) !== JSON.stringify(module) || input.chainId !== ledger.chainId || input.distributor !== ledger.distributor)) throw new Error("unreviewed expiry module inputs");
  const journal = path.join(directory, "journal");
  fs.mkdirSync(journal, { recursive: true });
  const events: { block: bigint; log: number; hash: Hash; root?: Hash; digest?: Hash }[] = [];
  const startBlock = BigInt(ledger.checkpoint.block) + (ledger.checkpoint.logIndex === undefined ? 1n : 0n);
  for (let start = startBlock; start <= finalized.number; start += 10000n) {
    const end = start + 9999n < finalized.number ? start + 9999n : finalized.number;
    const roots = await client.getLogs({ address: EXPIRY_DISTRIBUTOR, event: ROOT_SET, fromBlock: start, toBlock: end });
    const activations = await client.getLogs({ address: module.address as Address, event: ACTIVATED, fromBlock: start, toBlock: end });
    const expiryTransactions = new Set(activations.map(event => event.transactionHash));
    for (const event of roots) {
      if (!event.removed && event.transactionHash && event.blockNumber !== null && event.logIndex !== null && !expiryTransactions.has(event.transactionHash)) events.push({ block: event.blockNumber, log: event.logIndex, hash: event.transactionHash, root: event.args.newRoot });
    }
    for (const event of activations) {
      if (!event.removed && event.transactionHash && event.blockNumber !== null && event.logIndex !== null) events.push({ block: event.blockNumber, log: event.logIndex, hash: event.transactionHash, digest: event.args.digest });
    }
  }
  const idle = fs.readdirSync(journal).filter(file => file.endsWith(".json")).map(file => JSON.parse(fs.readFileSync(path.join(journal, file), "utf8"))).filter(entry => entry.kind === "idle");
  for (const entry of idle) {
    if (entry.checkpoint.block <= ledger.checkpoint.block || BigInt(entry.checkpoint.block) > finalized.number) continue;
    const block = await client.getBlock({ blockNumber: BigInt(entry.checkpoint.block) });
    if (block.hash === entry.checkpoint.blockHash) events.push({ block: block.number!, log: Number.MAX_SAFE_INTEGER, hash: entry.id });
  }
  events.sort((a, b) => Number(a.block - b.block) || a.log - b.log);
  for (const event of events) {
    if (event.block === BigInt(ledger.checkpoint.block) && event.log <= (ledger.checkpoint.logIndex ?? Number.MAX_SAFE_INTEGER)) continue;
    const block = await client.getBlock({ blockNumber: event.block });
    let entry: any;
    if (event.digest) {
      const file = path.join(preparedDir, `${event.digest}.json`);
      if (!fs.existsSync(file)) throw new Error(`missing immutable expiry inputs ${event.digest}`);
      const input: PreparedExpiry = JSON.parse(fs.readFileSync(file, "utf8"));
      if (expiryDigest(input) !== event.digest) throw new Error("prepared filename digest");
      const actual = await readConfirmedExpiry(client, input, event.hash);
      if (!actual) throw new Error("activation finality changed during replay");
      const applied = applyConfirmedExpiry(ledger, input, actual);
      ledger = applied.ledger;
      entry = { kind: "expiry", input: event.digest, actual };
      const rootsDir = path.resolve(directory, "../..", "roots", String(ledger.chainId));
      fs.mkdirSync(rootsDir, { recursive: true });
      writeExpiryInput(path.join(rootsDir, `${actual.root.toLowerCase()}.json`), applied.merkle);
    } else if (event.root) {
      const rootsDir = path.resolve(directory, "../..", "roots", String(ledger.chainId));
      const merkle = JSON.parse(fs.readFileSync(path.join(rootsDir, `${event.root.toLowerCase()}.json`), "utf8"));
      const source = JSON.parse(fs.readFileSync(path.join(rootsDir, `${event.root.toLowerCase()}.rewards.json`), "utf8"));
      if (source.chainId !== ledger.chainId || source.distributor !== EXPIRY_DISTRIBUTOR || source.parent !== ledger.root || source.root !== event.root) throw new Error("ordinary reward provenance");
      const receipt = await client.getTransactionReceipt({ hash: event.hash });
      if (receipt.status !== "success" || receipt.blockHash !== block.hash || !receipt.logs.some(log => log.address.toLowerCase() === EXPIRY_DISTRIBUTOR.toLowerCase() && log.logIndex === event.log && log.topics[1] === event.root)) throw new Error("ordinary activation receipt");
      const publication = { root: event.root, block: Number(block.number), blockHash: block.hash!, logIndex: event.log, timestamp: Number(block.timestamp), merkle };
      const claims = await readLedgerClaims(client, ledger, event.block, merkle, event.log);
      ledger = recordExpiryDistribution(ledger, publication, source.rewards, claims);
      entry = { kind: "distribution", publication: { ...publication, merkle: undefined }, source, claims, transactionHash: event.hash };
    } else {
      entry = idle.find(entry => entry.id === event.hash);
      if (entry.root !== ledger.root || ledger.runs[String(entry.round)]?.complete) throw new Error("idle round parent");
      const claims = await readLedgerClaims(client, ledger, event.block);
      if (JSON.stringify(claims) !== JSON.stringify(entry.claims)) throw new Error("idle round claims changed");
      ledger = syncExpiryClaims(ledger, claims);
      ledger.runs[String(entry.round)] = { nextBatch: ledger.runs[String(entry.round)]?.nextBatch ?? 0, complete: true, processed: ledger.runs[String(entry.round)]?.processed ?? [] };
      ledger.checkpoint = entry.checkpoint;
    }
    const id = utils.sha256(utils.toUtf8Bytes(JSON.stringify(entry)));
    writeExpiryInput(path.join(journal, `${id}.json`), entry);
  }
  const currentRoot = await client.readContract({ address: EXPIRY_DISTRIBUTOR, abi: URD_ABI, functionName: "root", blockNumber: finalized.number });
  if (currentRoot !== ledger.root || (await client.getBlock({ blockNumber: finalized.number })).hash !== finalized.hash) throw new Error("journal does not reconcile finalized active root");
  if (until) return ledger;
  const state = path.join(directory, "states");
  fs.mkdirSync(state, { recursive: true });
  const id = utils.sha256(utils.toUtf8Bytes(JSON.stringify(ledger)));
  writeExpiryInput(path.join(state, `${id}.json`), ledger);
  const pointer = path.join(directory, "current.json");
  const temporary = `${pointer}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ state: id, root: ledger.root, checkpoint: ledger.checkpoint }) + "\n");
  fs.renameSync(temporary, pointer);
  return ledger;
}
