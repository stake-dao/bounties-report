import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { erc20Abi, getAddress, zeroHash } from "viem";
import { cidToBytes32, pinFile } from "../helpers/pinToIpfs";
import { getClient } from "../utils/getClients";
import { sendTelegramMessage } from "../utils/telegramUtils";
import { ABI } from "./prepare";
import { announceExpiry, assertExpiryCoverage, prepareExpiryCut } from "./twoPhase";
import { assertJournal, journalPath, Pool, poolAddress, readJournal, writeJournal } from "./publicationJournal";
import { reconcilePublication } from "./reconcilePublication";

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** No transaction signing. The workflow commits with a non-force push; any
 * concurrent journal write rejects the whole change instead of rebasing it. */
export async function main() {
  const [action, name, argument] = process.argv.slice(2);
  assert(["voters-1", "extra-1"].includes(name), "unsupported monthly pool");
  const pool = name as Pool;
  let state = readJournal(pool);
  if (!state && action === "reconcile") { console.log(`${pool}: monthly expiry is not initialized`); return; }
  assert(state, "Initialize a reviewed canonical ledger and empty journal before enabling monthly expiry");
  assertJournal(state);
  const address = poolAddress(pool);
  if (action === "cancel") {
    // Persist before RPC/signing. An in-flight or accepted root still has to be
    // reconciled; this flag never pretends that cancellation already succeeded.
    state.cancelRequested = true;
    state.revision++;
    writeJournal(state);
    return;
  }
  const client = await getClient(1);
  state = await reconcilePublication(state, client);
  if (action === "announce") {
    assert(!state.notice && !state.publication && !state.adopted && !state.cancelRequested, "previous cycle unfinished");
    const policy = read("script/recovery/monthly-policy.json");
    assert(policy, "monthly policy not approved");
    const at = Math.floor(Date.now() / 1000);
    state.notice = announceExpiry(state.ledger, policy, argument, at);
    assert(!state.ledger.recoveries.includes(`monthly:${argument}`), "month already recovered");
    assert(process.env.PINATA_JWT, "IPFS pinning credential missing");
    const bytes = Buffer.from(json(state.notice));
    const pin = await pinFile(fetch, process.env.PINATA_JWT, "notice.json", bytes, { name: `${pool}-${argument}`, keyvalues: { pool, period: argument } });
    const url = `https://gateway.pinata.cloud/ipfs/${pin.cid}`;
    const response = await fetch(url);
    assert(response.ok && Buffer.from(await response.arrayBuffer()).equals(bytes), "notice read-back mismatch");
    await sendTelegramMessage(`Monthly expiry ${pool} · ${argument}\n${url}\nNo expiry cut before 24 hours after this alert. Claims and ordinary publications remain open.`, undefined, true);
    state.announcement = { cid: pin.cid, alert: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY ?? "stake-dao/bounties-report"}/actions/runs/${process.env.GITHUB_RUN_ID ?? "manual"}`, availableAt: Math.floor(Date.now() / 1000) };
  } else if (action === "cut") {
    assert(state.notice && state.announcement && !state.publication && !state.adopted && !state.cancelRequested, "cut not available");
    const block = await client.getBlock();
    const now = Number(block.timestamp);
    assert(now >= state.announcement.availableAt + 86400, "public notice not elapsed");
    assert.equal(await client.readContract({ address, abi: ABI, functionName: "root", blockNumber: block.number! }), state.ledger.root, "unfinalized publication");
    assert.equal((await client.readContract({ address, abi: ABI, functionName: "pendingRoot", blockNumber: block.number! }))[0], zeroHash, "pending publication");
    state.cut = prepareExpiryCut(state.notice, state.ledger, state.merkle, now);
    assert.notEqual(state.cut.merkle.merkleRoot, state.ledger.root, "no announced credits remain; no cut to submit");
    // Extra's campaign commitments require an explicit reserve snapshot; zero
    // is never inferred from the contract's apparent surplus.
    const tokens = [...new Set(Object.values(state.ledger.pairs).map(pair => pair.token))];
    assert(pool !== "extra-1" || state.reserves, "extra reserve snapshot missing");
    const reserves = state.reserves ?? Object.fromEntries(tokens.map(token => [token, "0"]));
    const claims = Object.fromEntries(Object.entries(state.ledger.pairs).map(([key, pair]) => [key, pair.paid]));
    const balances: Record<string, string> = {};
    for (const token of new Set([...tokens, ...Object.keys(reserves)])) balances[token] = String(await client.readContract({ address: getAddress(token), abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber: BigInt(state.ledger.checkpoint.block) }));
    assertExpiryCoverage(state.merkle, claims, balances, reserves);
    assert(process.env.PINATA_JWT, "IPFS pinning credential missing");
    const bytes = Buffer.from(json(state.cut.merkle));
    const pin = await pinFile(fetch, process.env.PINATA_JWT, "merkle.json", bytes, { name: `${pool}-${state.notice.period}-cut`, keyvalues: { pool, period: state.notice.period } });
    const response = await fetch(`https://gateway.pinata.cloud/ipfs/${pin.cid}`);
    assert(response.ok && Buffer.from(await response.arrayBuffer()).equals(bytes), "cut proofs read-back mismatch");
    state.publication = { version: 1, pool, revision: state.revision, kind: "cut", parent: state.ledger.root, merkle: state.cut.merkle, gains: {}, sources: [], reserves, checkpoint: state.ledger.checkpoint, ipfsHash: cidToBytes32(pin.cid) };
    if (pool === "extra-1") state.publication.campaignCount = state.campaignCount;
  } else if (action === "resume") {
    assert(!state.execution && state.cancelRequested, "uncertain transaction cannot be resumed");
    if (state.submitted) {
      assert(state.cancelled && state.publication, "resume requires a finalized revocation and retained funding receipt");
      assert.equal(state.publication.parent, state.ledger.root, "cancelled publication parent changed");
    } else {
      assert(!state.submission, "uncertain submission requires explicit reconciliation");
      if (!state.adopted) {
        delete state.publication;
        delete state.cut;
        delete state.notice;
        delete state.announcement;
      }
    }
    delete state.cancelRequested;
    delete state.cancelled;
    // The guard resumes this exact root WITHOUT its already executed funding.
  } else assert.equal(action, "reconcile", "unknown monthly publication action");
  if (action !== "reconcile") state.revision++;
  writeJournal(state);
  const directory = `bounties-reports/monthly-expiry/roots/${pool}`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${state.merkle.merkleRoot}.json`), json(state.merkle));
  // Proofs are served only for the root verified at a finalized checkpoint.
  const live = await client.readContract({ address, abi: ABI, functionName: "root" });
  if (pool === "voters-1") {
    const roots = "bounties-reports/expiry/roots/1";
    fs.mkdirSync(roots, { recursive: true });
    fs.writeFileSync(path.join(roots, `${state.merkle.merkleRoot}.json`), json(state.merkle));
    if (live === state.ledger.root) fs.writeFileSync("bounties-reports/latest/vlCVX/vlcvx_merkle.json", json(state.merkle));
  } else if (live === state.ledger.root) {
    const file = "merkl-toolkit/data/last_merkle.json";
    assert(fs.existsSync(file), "extra proof publication checkout missing");
    fs.writeFileSync(file, json(state.merkle));
  }
  console.log(`${journalPath(pool)}: revision ${state.revision}, active ${state.ledger.root}, pending ${state.publication?.merkle.merkleRoot ?? "none"}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
