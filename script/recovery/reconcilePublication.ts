import assert from "node:assert/strict";
import { getAddress, parseAbi, PublicClient, zeroHash } from "viem";
import { expiryKey, syncExpiryClaims } from "../shared/merkle/expiry";
import { adoptCumulativePublication, adoptExpiryCut } from "./twoPhase";
import { ABI, assertJournal, poolAddress, PublicationJournal } from "./publicationJournal";
import { vmRewards } from "./monthly";
import { fetchClaimed } from "../verify/invariants/preservation";

const events = parseAbi([
  "event RootSet(bytes32 indexed newRoot,bytes32 indexed newIpfsHash)",
  "event Claimed(address indexed account,address indexed recipient,address indexed reward,uint256 amount)",
  "event PendingRootSet(address indexed caller,bytes32 indexed newRoot,bytes32 indexed newIpfsHash)",
  "event PendingRootRevoked(address indexed caller)",
]);
const GUARD = "0x067e4F59F6Bd026897D771Fa430CA261d7C35205";
const SIGNER = "0x2468Fd5868dA9219b50c8d57bB4edba4097Bd20A";

/** Reads only finalized logs. Claims and root activations are replayed in EVM
 * order, including multiple events in one block and third-party acceptance. */
export async function reconcilePublication(input: PublicationJournal, client: PublicClient): Promise<PublicationJournal> {
  assertJournal(input);
  assert.equal(await client.getChainId(), 1, "RPC chain mismatch");
  const state = structuredClone(input);
  const address = poolAddress(state.pool);
  const finalized = await client.getBlock({ blockTag: "finalized" });
  const checkpoint = state.ledger.checkpoint;
  assert(checkpoint.logIndex === undefined, "journal checkpoint must be an end-of-block snapshot");
  assert(BigInt(checkpoint.block) <= finalized.number!, "journal ahead of finality");
  assert.equal((await client.getBlock({ blockNumber: BigInt(checkpoint.block) })).hash, checkpoint.blockHash, "journal checkpoint reorged");
  assert.equal(await client.readContract({ address, abi: ABI, functionName: "root", blockNumber: BigInt(checkpoint.block) }), state.ledger.root, "checkpoint root mismatch");
  const pairs = new Map(Object.values(state.ledger.pairs).map(pair => [expiryKey(pair.account, pair.token), [pair.account, pair.token]]));
  for (const [account, claim] of Object.entries(state.publication?.merkle.claims ?? {})) for (const token of Object.keys(claim.tokens)) pairs.set(expiryKey(account, token), [account, token]);
  const claims: Record<string, string> = {};
  const readClaims = async (block: bigint) => fetchClaimed(client, { target: "voters", chainId: 1, distributor: address, pinnedBlock: block }, [...pairs.values()] as [string, string][]);
  const initial = await readClaims(BigInt(checkpoint.block));
  for (const [key, [account, token]] of pairs) {
    claims[key] = String(initial.get(`${account}:${token}`));
    if (state.ledger.pairs[key]) assert.equal(claims[key], state.ledger.pairs[key].paid, "checkpoint claim mismatch");
  }
  for (let from = BigInt(checkpoint.block) + 1n; from <= finalized.number!; from += 10000n) {
    const to = from + 9999n < finalized.number! ? from + 9999n : finalized.number!;
    const logs = await client.getLogs({ address, events, fromBlock: from, toBlock: to, strict: true });
    logs.sort((a, b) => Number(a.blockNumber! - b.blockNumber!) || a.logIndex! - b.logIndex!);
    for (const log of logs) {
      assert(!log.removed && log.blockHash && log.blockNumber !== null && log.logIndex !== null, "incomplete publication log");
      const block = await client.getBlock({ blockNumber: log.blockNumber });
      assert.equal(block.hash, log.blockHash, "publication log reorged");
      if (log.eventName === "Claimed") {
        const key = expiryKey(log.args.account, log.args.reward);
        assert(claims[key] !== undefined, "claim for an unrecorded pair");
        claims[key] = (BigInt(claims[key]) + log.args.amount).toString();
        state.ledger = syncExpiryClaims(state.ledger, claims);
        continue;
      }
      const candidate = state.publication;
      assert(candidate, "unregistered publication event; reconcile before continuing");
      if (log.eventName === "PendingRootSet" || (log.eventName === "RootSet" && state.pool === "extra-1")) {
        assert.equal(log.args.newRoot, candidate.merkle.merkleRoot, "foreign root submitted");
        assert.equal(log.args.newIpfsHash, candidate.ipfsHash, "foreign publication evidence");
        assert(state.submission, "submission intent missing");
        const transaction = await client.getTransaction({ hash: log.transactionHash! });
        assert.equal(getAddress(transaction.to!), GUARD, "submission did not use the recorded guard route");
        assert.equal(getAddress(transaction.from), SIGNER, "submission signer differs");
        assert.equal(transaction.input.toLowerCase(), state.submission.calldata.toLowerCase(), "submission differs from durable intent");
        const receipt = await client.getTransactionReceipt({ hash: log.transactionHash! });
        assert.equal(receipt.status, "success", "submission failed");
        state.submitted = { transaction: log.transactionHash!, block: Number(block.number), blockHash: block.hash!, validAt: "0", ipfsHash: candidate.ipfsHash };
        // Only this receipt proves the funding leg landed. A same-root pending
        // observed without its recorded transaction is not a funding receipt.
        delete state.execution;
      }
      if (log.eventName === "PendingRootRevoked") {
        assert(state.cancelRequested && state.submitted, "unexpected pending revocation");
        state.cancelled = true;
        delete state.execution;
        state.history.push({ kind: "cancel", root: candidate.merkle.merkleRoot, transaction: log.transactionHash!, block: Number(block.number), blockHash: block.hash!, logIndex: log.logIndex });
      }
      if (log.eventName !== "RootSet") continue;
      assert(!state.cancelled && state.submitted, "activation without a recorded submission");
      assert.equal(log.args.newRoot, candidate.merkle.merkleRoot, "unexpected root activated");
      assert.equal(log.args.newIpfsHash, candidate.ipfsHash, "activation evidence mismatch");
      assert.equal(candidate.parent, state.ledger.root, "activation parent mismatch");
      const at = { block: Number(block.number), blockHash: block.hash!, logIndex: log.logIndex };
      if (candidate.kind === "cut") {
        assert(state.cut && !state.adopted, "cut not prepared");
        // Claims since preparation have already been consumed in canonical order.
        state.adopted = adoptExpiryCut(state.cut, claims, at);
        state.ledger = state.adopted.ledger;
      } else {
        assert.equal(candidate.kind, state.adopted ? "settlement" : "ordinary", "publication phase mismatch");
        assert(candidate.sources.length && new Set(candidate.sources).size === candidate.sources.length && candidate.sources.every(id => !(state.creditedSources ?? []).includes(id)), "reward source already credited");
        const deltas = Object.fromEntries(Object.entries(candidate.gains).flatMap(([a, tokens]) => Object.entries(tokens).map(([t, amount]) => [expiryKey(a, t), amount])));
        const vm = state.pool === "extra-1" ? await vmRewards(client, candidate.allocations ?? [], deltas, block.number!) : deltas;
        state.ledger = adoptCumulativePublication(state.ledger, { ...at, timestamp: Number(block.timestamp), root: candidate.merkle.merkleRoot, merkle: candidate.merkle }, claims, candidate.gains, vm, state.adopted?.reserve);
        state.creditedSources = [...(state.creditedSources ?? []), ...candidate.sources];
        state.lastPublication = candidate;
        if (candidate.kind === "settlement") {
          delete state.adopted;
          delete state.cut;
          delete state.notice;
          delete state.announcement;
        }
      }
      state.merkle = candidate.merkle;
      state.reserves = candidate.reserves;
      state.campaignCount = candidate.campaignCount;
      state.history.push({ kind: candidate.kind, root: log.args.newRoot, transaction: log.transactionHash!, ...at });
      delete state.publication;
      delete state.execution;
      delete state.submission;
      delete state.submitted;
      // A late cancel cannot undo activation, but must still stop settlement
      // and subsequent publications until the operator explicitly resumes.
    }
  }
  const at = { address, abi: ABI, blockNumber: finalized.number! };
  assert.equal(await client.readContract({ ...at, functionName: "root" }), state.ledger.root, "root history incomplete");
  const pending = await client.readContract({ ...at, functionName: "pendingRoot" });
  if (pending[0] !== zeroHash) {
    assert(state.submitted && !state.cancelled && state.publication?.merkle.merkleRoot === pending[0] && state.publication.ipfsHash === pending[1], "foreign pending root");
    state.submitted.validAt = String(pending[2]);
  } else if (state.submitted) assert(state.cancelled, "pending disappeared without activation or revocation");
  const finalClaims = await readClaims(finalized.number!);
  for (const [key, pair] of Object.entries(state.ledger.pairs)) {
    assert.equal(String(finalClaims.get(`${pair.account}:${pair.token}`)), pair.paid, `claim replay incomplete: ${key}`);
  }
  state.ledger.checkpoint = { block: Number(finalized.number), blockHash: finalized.hash! };
  if (input.publication) state.revision++;
  assert.equal((await client.getBlock({ blockNumber: finalized.number! })).hash, finalized.hash, "finalized checkpoint reorged");
  assertJournal(state);
  return state;
}
