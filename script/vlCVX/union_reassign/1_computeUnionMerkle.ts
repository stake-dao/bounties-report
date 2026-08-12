/**
 * Compute the end-user merkle for The Union's unclaimed vlCVX balance.
 *
 *   pnpm tsx script/vlCVX/union_reassign/1_computeUnionMerkle.ts
 *
 * The Union (`0xde1E6A7E…0c49`) was credited in the weekly vlCVX merkles from
 * November 2024 on and never claimed a wei. That balance was earned by
 * delegated voting power: it belongs to the addresses that delegated to The
 * Union on Snapshot, not to the delegate.
 *
 * This script rebuilds who is owed what, from scratch — no artefact from any
 * other step is required. For every round that credited The Union:
 *
 *   1. resolve the cvx.eth gauge-weight proposal the round was built from,
 *   2. replay the Snapshot DelegateRegistry to that proposal's snapshot block
 *      to get the addresses delegating to The Union on cvx.eth,
 *   3. score them with the proposal's own `erc20-balance-of` strategy — the
 *      one `erc20-balance-of-delegation` sums into the delegate's voting power,
 *   4. drop the delegators who voted the proposal themselves: Snapshot removed
 *      their weight from the delegate's vote, so they backed none of this pot,
 *      and the pipeline already paid them directly,
 *   5. split each token over the remaining vlCVX with a largest-remainder
 *      allocation, so the parts sum back to the round's amount exactly.
 *
 * The end user is ALWAYS the delegator. A Votium forwarder redirection sends
 * *Votium's* payouts elsewhere; it has no claim on this money, which came from
 * Votemarket through the Stake DAO distributor.
 *
 * Output: out/union_end_user_merkle.json — the combined split plus a
 * per-protocol breakdown, because the reassignment has to be applied to the two
 * per-gauge bases createCombinedMerkle re-seeds from and not only to the derived
 * vlcvx_merkle.json. Nothing is written unless every per-token sum equals the
 * Union's live claimable to the wei, per protocol and combined.
 *
 * Network responses are cached under .cache/, keyed on the inputs they were
 * derived from, so a re-run is cheap but a changed input is never served stale.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { getAddress } from "viem";
import { MerkleData } from "../../interfaces/MerkleData";
import {
  assertUnionNeverClaimed,
  basePath,
  EXCLUDED_TOKENS,
  isExcluded,
  latestMerkle,
  liveRounds,
  PROTOCOLS,
  Protocol,
  REPO,
  RoundKey,
  roundsDigest,
  rpc,
  UNION,
  unionLine,
  unionRounds,
} from "./shared";

const HERE = __dirname;
const CACHE = path.join(HERE, ".cache");
const OUT = path.join(HERE, "out");

const WEEK = 604800;

const DELEGATE_REGISTRY = "0x469788fE6E9E9681C6ebF3bF78e7Fd26Fc015446";
const REGISTRY_CREATION_BLOCK = 11225329;
const SET_DELEGATE = "0xa9a7fd460f56bddb880a465a9c3e9730389c70bc53108148f16d55a87a6c468e";
const CLEAR_DELEGATE = "0x9c4f00c4291262731946e308dc2979a56bd22cce8f95906b975065e96cd5a064";
const UNION_TOPIC = `0x000000000000000000000000${UNION.slice(2)}`;

const CVX_SPACE_ID = "0x6376782e65746800000000000000000000000000000000000000000000000000";
const GLOBAL_SPACE_ID = `0x${"00".repeat(32)}`;

const HUB = "https://hub.snapshot.org/graphql";
const SCORES = "https://score.snapshot.org/api/scores";

// eth_getLogs window for the registry scan. The floor has to sit below the
// 10_000-block cap common on Infura and most QuickNode tiers, or an endpoint
// that would serve the scan fine at a narrow width is rejected instead.
const MAX_LOG_CHUNK = 2_000_000;
const MIN_LOG_CHUNK = 2_000;
// Batches to get through before probing a wider window. Widening on every
// success makes a hard-capped provider oscillate across its cap, paying four
// failed attempts and 12s of backoff for every batch it completes.
const WIDEN_AFTER = 20;

// float vlCVX -> integer weight. 1e12 keeps well under float64's 15-16 digits
// for the largest balance seen (~2.4M vlCVX) while making ties astronomically
// unlikely.
const WEIGHT_SCALE = 1e12;

// Snapshot's vote is the reference: the eligible vlCVX must reconstruct the
// voting power it credited to The Union. Two FXN proposals are counted twice
// (the Thursday and Tuesday rounds share a proposal) and Snapshot did not
// credit one delegator there, hence a tolerance rather than an equality.
const MAX_VP_DRIFT = 0.0005;

// A genuine rounding artefact is bounded by how many rounds paid the token, NOT
// by the size of the last one: bounding it by the last round's own amount would
// silently absorb an entire missing round into that round's delegator set. The
// worst real gap measured across the 49 rounds is 1.035e-8 relative, so 1e-6
// carries ~100x headroom while staying ~5 orders tighter than a whole round.
const MAX_DUST_RATIO = 1_000_000n; // divisor: total / 1e6
const MIN_DUST_WEI = 10_000n; // floor, for tokens with few decimals

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Disk cache keyed on BOTH the name and a fingerprint of the inputs the value
 * was derived from. Keying on the name alone meant a score map cached for one
 * delegator set was served for a different one — so recovering a delegator that
 * an incomplete log scan had missed still scored them zero until the operator
 * knew to delete a second cache file by hand.
 *
 * Entries without an envelope are from the name-only scheme: there is no way to
 * tell what produced them, so they are re-fetched rather than trusted.
 */
function cached<T>(
  name: string,
  produce: () => Promise<T>,
  fingerprint = ""
): Promise<T> {
  const file = path.join(CACHE, `${name}.json`);
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const envelope =
      raw && typeof raw === "object" && !Array.isArray(raw) && "fingerprint" in raw;
    if (envelope && raw.fingerprint === fingerprint) return Promise.resolve(raw.value as T);
  }
  return produce().then((value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ fingerprint, value }));
    return value;
  });
}

async function retry<T>(what: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === attempts) throw error;
      console.log(`    retry ${i}/${attempts - 1} on ${what}: ${error}`);
      await sleep(Math.min(30_000, 3000 * i));
    }
  }
}

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(HUB, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

/** Python's `round`: half-to-even. Above 2^53 a float carries no fraction. */
function roundHalfEven(x: number): bigint {
  if (!Number.isFinite(x)) throw new Error(`cannot round ${x}`);
  if (Math.abs(x) >= 2 ** 53) return BigInt(x);
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return BigInt(floor + 1);
  if (diff < 0.5) return BigInt(floor);
  return BigInt(floor % 2 === 0 ? floor : floor + 1);
}

/** Split `amount` over `weights`; the parts sum back to `amount` exactly. */
function largestRemainder(
  amount: bigint,
  weights: Map<string, bigint>
): Map<string, bigint> {
  const total = [...weights.values()].reduce((a, b) => a + b, 0n);
  const parts = new Map<string, bigint>();
  if (total <= 0n || amount <= 0n) return parts;

  const remainders: { rest: bigint; address: string }[] = [];
  let allocated = 0n;
  for (const [address, weight] of weights) {
    const numerator = amount * weight;
    const part = numerator / total;
    parts.set(address, part);
    allocated += part;
    remainders.push({ rest: numerator - part * total, address });
  }
  // Deterministic: largest remainder first, address as the tie-break.
  remainders.sort((a, b) =>
    a.rest === b.rest ? (a.address < b.address ? -1 : 1) : a.rest > b.rest ? -1 : 1
  );
  for (const { address } of remainders.slice(0, Number(amount - allocated))) {
    parts.set(address, parts.get(address)! + 1n);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// 1. The rounds that credited The Union
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2. Round -> Snapshot proposal
// ---------------------------------------------------------------------------

type Proposal = {
  id: string;
  title: string;
  created: number;
  start: number;
  end: number;
  snapshot: number;
};

function isGaugeWeight(proposal: Proposal, protocol: string): boolean {
  const { title } = proposal;
  if (!title.includes("Gauge Weight for Week of") || title.startsWith("(TEST)")) return false;
  return protocol === "fxn" ? title.startsWith("FXN") : !title.startsWith("FXN ");
}

/**
 * The rule the legacy pipeline used (`fetchLastProposalsIds`): the most
 * recently created weighted proposal of the right family whose `start` is at
 * or before `period - WEEK`. Cross-checked below against every round whose
 * repartition file recorded a proposalId.
 */
async function resolveProposals(
  rounds: { key: RoundKey }[]
): Promise<Map<string, Proposal>> {
  const all: Proposal[] = await cached("cvx-weighted-proposals", async () => {
    const out: Proposal[] = [];
    for (let skip = 0; ; skip += 1000) {
      const batch = (
        await retry("proposals", () =>
          gql(
            `query($skip: Int!) {
               proposals(first: 1000, skip: $skip, orderBy: "created", orderDirection: asc,
                         where: {space_in: ["cvx.eth"], type: "weighted"}) {
                 id title created start end snapshot
               }
             }`,
            { skip }
          )
        )
      ).proposals;
      out.push(...batch);
      if (batch.length < 1000) break;
    }
    return out;
  });
  console.log(`  ${all.length} weighted cvx.eth proposals`);

  const mapping = new Map<string, Proposal>();
  for (const { key } of rounds) {
    const candidates = all.filter(
      (p) => isGaugeWeight(p, key.protocol) && p.start <= key.period - WEEK
    );
    if (candidates.length === 0) {
      throw new Error(`no proposal for round ${key.period}|${key.protocol}`);
    }
    mapping.set(
      `${key.period}|${key.protocol}`,
      candidates.reduce((a, b) => (b.created > a.created ? b : a))
    );
  }

  let checked = 0;
  let unrecorded = 0;
  for (const [key, proposal] of mapping) {
    const [period, protocol] = key.split("|");
    // Mirror unionRounds(): the nested layout supersedes the flat one, so the
    // round's repartition is looked up wherever it actually lives — the 10
    // flat-layout rounds were previously never eligible for this cross-check.
    const nested = path.join(REPO, `bounties-reports/${period}/vlCVX/${protocol}/repartition.json`);
    const flat = path.join(REPO, `bounties-reports/${period}/vlCVX/repartition.json`);
    const file = fs.existsSync(nested) ? nested : protocol === "curve" ? flat : "";
    if (!file || !fs.existsSync(file)) {
      unrecorded++;
      continue;
    }
    const recorded = JSON.parse(fs.readFileSync(file, "utf8")).proposalId;
    if (recorded === undefined || recorded === null || recorded === "") {
      unrecorded++;
      continue;
    }
    if (typeof recorded === "string" && recorded.startsWith("0x")) {
      if (recorded !== proposal.id) {
        throw new Error(`${key}: resolved ${proposal.id} but repartition records ${recorded}`);
      }
      checked++;
      continue;
    }
    // Post-ENG-2105 rounds record an on-chain round number here, not a Snapshot
    // id, and resolve delegation on-chain through expandDelegateVotes. Skipping
    // them left the ONE guard against a wrong proposal switched off: the Snapshot
    // resolver would pick a stale pre-cutover proposal, and the VP-drift gate
    // cannot catch that because both sides of it come from that same proposal.
    throw new Error(
      `${key}: repartition records proposalId ${JSON.stringify(recorded)}, an on-chain ` +
        `round number rather than a Snapshot proposal id. This reassignment replays the ` +
        `Snapshot DelegateRegistry and cannot resolve that round — teach it on-chain ` +
        `delegation before including post-cutover periods.`
    );
  }
  console.log(
    `  round -> proposal cross-checked on ${checked} recorded proposalIds` +
      (unrecorded > 0 ? `, ${unrecorded} round(s) record none` : "")
  );

  return mapping;
}

async function proposalWithVotes(id: string): Promise<{ proposal: any; votes: any[] }> {
  return cached(`proposals/${id}`, async () => {
    const proposal = (
      await retry("proposal", () =>
        gql(
          `query($id: String!) {
             proposal(id: $id) { id title snapshot space { id } strategies { name network params } }
           }`,
          { id }
        )
      )
    ).proposal;
    const votes: any[] = [];
    for (let skip = 0; ; skip += 1000) {
      const batch = (
        await retry("votes", () =>
          gql(
            `query($id: String!, $skip: Int!) {
               votes(first: 1000, skip: $skip, where: {proposal: $id},
                     orderBy: "created", orderDirection: asc) { voter vp }
             }`,
            { id, skip }
          )
        )
      ).votes;
      votes.push(...batch);
      if (batch.length < 1000) break;
    }
    await sleep(300);
    return { proposal, votes };
  });
}

// ---------------------------------------------------------------------------
// 3. Delegations towards The Union
// ---------------------------------------------------------------------------

type DelegationEvent = {
  block: number;
  logIndex: number;
  event: "Set" | "Clear";
  delegator: string;
  space: string;
};

/**
 * The DelegateRegistry is the only source of truth for Snapshot delegation:
 * `erc20-balance-of-delegation` resolves a delegate's extra voting power from
 * exactly these events.
 */
async function delegationEvents(): Promise<DelegationEvent[]> {
  // The scan is defined by the registry, the delegate and the start block; the
  // head block is not part of the key, or the cache would never hit.
  const fingerprint = `${DELEGATE_REGISTRY}|${UNION}|${REGISTRY_CREATION_BLOCK}`;
  return cached(
    "union-delegation-events",
    async () => {
      const head = await rpc("eth_blockNumber", []);
      const latest = Number(head);
      // `Number(undefined)` is NaN and `start <= NaN` is false, so an endpoint
      // answering without a result used to skip the loop entirely: no error, no
      // log line, an empty event set cached forever, and a drift failure that
      // pointed the operator at Snapshot instead of the RPC.
      if (!Number.isInteger(latest) || latest <= REGISTRY_CREATION_BLOCK) {
        throw new Error(
          `eth_blockNumber returned ${JSON.stringify(head)} (parsed ${latest}) — cannot ` +
            `scan the DelegateRegistry from ${REGISTRY_CREATION_BLOCK}`
        );
      }

      const logs: any[] = [];
      let start = REGISTRY_CREATION_BLOCK;
      let chunk = MAX_LOG_CHUNK;
      // Narrowest width observed to be refused. Never attempted again: a provider
      // with a hard cap refuses it every single time, so re-probing it is pure
      // waste rather than an occasional cost.
      let ceiling = Infinity;
      let streak = 0;

      // Providers fail two ways here: a transient hiccup, which a retry fixes,
      // and a range they refuse to serve, which only a smaller chunk fixes.
      let attempt = 0;
      while (start <= latest) {
        const end = Math.min(start + chunk - 1, latest);
        try {
          const batch = await rpc("eth_getLogs", [
            {
              fromBlock: `0x${start.toString(16)}`,
              toBlock: `0x${end.toString(16)}`,
              address: DELEGATE_REGISTRY,
              topics: [[SET_DELEGATE, CLEAR_DELEGATE], null, null, UNION_TOPIC],
            },
          ]);
          logs.push(...batch);
          console.log(`    ${start}-${end}: ${batch.length} logs`);
          start = end + 1;
          attempt = 0;
          // A narrowed window may have been for one blind region rather than for
          // the whole chain, and leaving it narrowed walks the remaining ~11.8M
          // blocks at the smallest width. Widen back — but only below a width
          // already known to be refused, and only every WIDEN_AFTER batches, so
          // a hard-capped provider settles just under its cap instead of paying
          // a failed probe for every batch it completes.
          if (++streak >= WIDEN_AFTER && chunk < MAX_LOG_CHUNK && chunk * 2 < ceiling) {
            chunk *= 2;
            streak = 0;
            console.log(`    widening to ${chunk} blocks`);
          }
        } catch (error) {
          if (++attempt < 4) {
            await sleep(2000 * attempt);
            continue;
          }
          attempt = 0;
          streak = 0;
          // Give up only once MIN_LOG_CHUNK itself has actually failed. Dividing
          // first and then testing the floor rejected the endpoint while naming a
          // width it had never attempted — and testing the floor before dividing
          // meant the narrowest range ever tried was 31_250 blocks, so an endpoint
          // with the common 10_000-block cap was rejected with a message blaming
          // the operator's endpoint choice.
          if (chunk <= MIN_LOG_CHUNK) {
            throw new Error(
              `eth_getLogs keeps failing on ${start}-${end} even at ${chunk} blocks — ` +
                `set RPC_URL_1 to an endpoint that serves this range (an Alchemy free tier ` +
                `caps at 10 blocks). Underlying error: ${error}`
            );
          }
          ceiling = chunk;
          chunk = Math.max(MIN_LOG_CHUNK, Math.floor(chunk / 4));
          console.log(`    ${start}-${end} refused, retrying with ${chunk} blocks`);
        }
      }

      // The Union demonstrably received delegations, so an empty scan is a
      // broken read, never a fact — and caching it would reproduce the same
      // misleading downstream failure on every subsequent run.
      if (logs.length === 0) {
        throw new Error(
          `the DelegateRegistry scan returned no events towards the Union across ` +
            `${REGISTRY_CREATION_BLOCK}-${latest} — that cannot be right; the endpoint is ` +
            `answering but not serving logs`
        );
      }

      return logs
        .map((log) => ({
          block: Number(log.blockNumber),
          logIndex: Number(log.logIndex),
          event: log.topics[0].toLowerCase() === SET_DELEGATE ? "Set" : "Clear",
          delegator: `0x${log.topics[1].slice(-40)}`.toLowerCase(),
          space: log.topics[2].toLowerCase(),
        }))
        .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex) as DelegationEvent[];
    },
    fingerprint
  );
}

/**
 * Delegators pointing at The Union at `block`. A space-scoped delegation
 * overrides the global one, so both are tracked; only the cvx.eth set carries
 * weight in the proposal.
 */
function delegatorSetAt(events: DelegationEvent[], block: number) {
  const space = new Map<string, string>();
  const global = new Map<string, string>();
  for (const event of events) {
    if (event.block > block) break;
    if (event.space === CVX_SPACE_ID) space.set(event.delegator, event.event);
    else if (event.space === GLOBAL_SPACE_ID) global.set(event.delegator, event.event);
  }
  const set = (m: Map<string, string>) =>
    [...m.entries()].filter(([, e]) => e === "Set").map(([a]) => a).sort();
  return { cvx: set(space), global: set(global) };
}

// ---------------------------------------------------------------------------
// 4. Voting power, with the proposal's own strategy
// ---------------------------------------------------------------------------

async function scoreDelegators(
  proposal: any,
  addresses: string[]
): Promise<Record<string, number>> {
  // Keyed on the address set as well as the proposal: keying on the proposal
  // alone served a score map computed for a different delegator set, so a
  // delegator recovered by re-running the registry scan still scored zero until
  // this second cache file was deleted by hand too.
  const fingerprint = `${addresses.length}:${createHash("sha256")
    .update([...addresses].sort().join(","))
    .digest("hex")
    .slice(0, 32)}`;
  return cached(`vp/${proposal.id}`, async () => {
    // `erc20-balance-of` only: that is the layer `erc20-balance-of-delegation`
    // sums into the delegate. Curve and FXN proposals point at different vlCVX
    // contracts, so the balances are read per proposal, never shared.
    const strategies = proposal.strategies.filter((s: any) => s.name === "erc20-balance-of");
    if (strategies.length === 0) throw new Error(`${proposal.id}: no erc20-balance-of strategy`);

    const scores: Record<string, number> = {};
    for (let i = 0; i < addresses.length; i += 1000) {
      const body = {
        params: {
          network: "1",
          snapshot: Number(proposal.snapshot),
          strategies,
          space: proposal.space.id,
          addresses: addresses.slice(i, i + 1000),
        },
      };
      const result = await retry("scores", async () => {
        const res = await fetch(SCORES, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!json.result) throw new Error(JSON.stringify(json).slice(0, 200));
        return json.result;
      });
      for (const layer of result.scores) {
        for (const [address, value] of Object.entries<number>(layer)) {
          if (value) scores[address.toLowerCase()] = (scores[address.toLowerCase()] ?? 0) + value;
        }
      }
      await sleep(200);
    }
    return scores;
  }, fingerprint);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const merkle = latestMerkle();
  const source: MerkleData = JSON.parse(fs.readFileSync(merkle.file, "utf8"));
  const claimable = unionLine(source, path.relative(REPO, merkle.file));
  console.log(`merkle   ${path.relative(REPO, merkle.file)} (period ${merkle.period})`);

  // "Never claimed" used to be asserted in prose and printed as fact. It is the
  // whole premise of the reassignment — a cumulative line is gross-earned and
  // the distributor pays it net of claimed — so read it from the URD.
  const checked = await assertUnionNeverClaimed(claimable.keys());
  console.log(
    `         ${claimable.size} tokens claimable, claimed(union, token) == 0 on all ${checked}`
  );

  // Each per-gauge base carries its own slice of that line, and the bases are
  // what the weekly pipeline re-seeds from, so the split has to reconcile
  // against each of them and not only against their merged total.
  const baseLines = new Map<Protocol, Map<string, bigint>>();
  for (const protocol of PROTOCOLS) {
    const file = basePath(merkle.period, protocol);
    if (!fs.existsSync(file)) {
      throw new Error(
        `missing ${path.relative(REPO, file)} — the reassignment has to be applied to the ` +
          `per-gauge bases the weekly run re-seeds from, not only to vlcvx_merkle.json`
      );
    }
    const base: MerkleData = JSON.parse(fs.readFileSync(file, "utf8"));
    baseLines.set(protocol, unionLine(base, path.relative(REPO, file)));
  }

  const fromBases = new Map<string, bigint>();
  for (const line of baseLines.values()) {
    for (const [token, amount] of line) {
      fromBases.set(token, (fromBases.get(token) ?? 0n) + amount);
    }
  }
  for (const token of new Set([...claimable.keys(), ...fromBases.keys()])) {
    const combined = claimable.get(token) ?? 0n;
    const bases = fromBases.get(token) ?? 0n;
    if (combined !== bases) {
      throw new Error(
        `${token}: the Union's combined line is ${combined} but curve+fxn bases hold ${bases}`
      );
    }
  }
  console.log(`bases    curve+fxn union lines reconcile with the combined line`);

  // Split the Union's line into what gets reassigned and what stays with it.
  // The retained lines are not dropped — step 2 leaves them on the Union's own
  // claim so every per-token total stays conserved.
  const distribute = new Map<string, bigint>();
  const retained = new Map<string, bigint>();
  for (const [token, amount] of claimable) {
    (isExcluded(token) ? retained : distribute).set(token, amount);
  }
  if (distribute.size === 0) {
    throw new Error("every token is excluded — there is nothing left to reassign");
  }
  if (retained.size > 0) {
    console.log(`excluded ${retained.size} token line(s) stay on the Union's claim, undistributed:`);
    for (const [token, amount] of retained) {
      console.log(`         ${amount.toString().padStart(26)} wei  ${EXCLUDED_TOKENS.get(token)}`);
    }
  }

  const allRounds = unionRounds();
  console.log(`rounds   ${allRounds.length} credited the Union`);

  // Drop the excluded tokens, then the rounds left crediting nothing —
  // otherwise they would be scored and split for no purpose.
  const { live, skipped: emptiedRounds } = liveRounds(allRounds);
  if (emptiedRounds > 0) {
    console.log(`         ${emptiedRounds} round(s) credited only excluded tokens — skipped`);
  }

  // Fingerprint the round-level inputs BEFORE the dust trim mutates them. The
  // per-token line alone does not pin the allocation: each round is split over
  // the delegator set at its own snapshot block, so a backfill that moves an
  // amount between rounds changes who gets paid while leaving every total
  // identical. Step 2 re-derives this and refuses a split that predates it.
  const digest = roundsDigest(live);
  console.log(`         round inputs digest ${digest.slice(0, 16)}…`);

  const mapping = await resolveProposals(live);
  const events = await delegationEvents();
  console.log(`registry ${events.length} delegation events towards the Union`);

  // The merkle is what is actually claimable. Summing the per-round
  // repartitions can land a few wei above it (rounding when each weekly merkle
  // was built), so trim the difference off the last round that paid the token.
  const totals = new Map<string, bigint>();
  for (const { tokens } of live) {
    for (const [token, amount] of tokens) totals.set(token, (totals.get(token) ?? 0n) + amount);
  }
  for (const [token, total] of totals) {
    const drift = total - (distribute.get(token) ?? 0n);
    if (drift === 0n) continue;
    const last = [...live].reverse().find((r) => r.tokens.has(token))!;
    const amount = last.tokens.get(token)!;
    // Bound the trim by the token's own total, NOT by the last round's amount:
    // the old guard accepted any value up to `amount - 1`, so an entire missing
    // round would have been absorbed into that one round — shortchanging exactly
    // its delegator set by the full amount while every later check still passed.
    const tolerance =
      total / MAX_DUST_RATIO > MIN_DUST_WEI ? total / MAX_DUST_RATIO : MIN_DUST_WEI;
    if (drift < 0n) {
      throw new Error(
        `${token}: the merkle credits ${-drift} wei MORE than the rounds account for — a ` +
          `round crediting the Union is missing from bounties-reports/`
      );
    }
    if (drift > tolerance) {
      throw new Error(
        `${token}: the rounds sum ${drift} wei above the merkle, past the ${tolerance} wei ` +
          `rounding tolerance — that is a missing or misattributed round, not dust`
      );
    }
    if (drift >= amount) {
      throw new Error(
        `${token}: drift ${drift} wei exceeds the last paying round's own ${amount} wei`
      );
    }
    last.tokens.set(token, amount - drift);
    console.log(`         dust trim ${token.slice(0, 10)}: -${drift} wei on round ${last.key.period}`);
  }

  const perUser = new Map<string, Map<string, bigint>>();
  // Per-round detail, for 3_sweepLedger.ts: which round, dated, paid whom what.
  const breakdown: any[] = [];
  // Tracked per protocol as well, because the reassignment has to be written
  // into each per-gauge base and each base only knows its own gauge type.
  const perUserByProtocol = new Map<Protocol, Map<string, Map<string, bigint>>>(
    PROTOCOLS.map((protocol) => [protocol, new Map<string, Map<string, bigint>>()])
  );
  let worstDrift = 0;

  for (const { key, tokens } of live) {
    const proposal = mapping.get(`${key.period}|${key.protocol}`)!;
    const { proposal: full, votes } = await proposalWithVotes(proposal.id);
    const voters = new Set(votes.map((v) => v.voter.toLowerCase()));
    const unionVote = votes.find((v) => v.voter.toLowerCase() === UNION);
    if (!unionVote) throw new Error(`${proposal.id}: the Union did not vote`);

    const sets = delegatorSetAt(events, Number(full.snapshot));
    const registered = new Set(sets.cvx);
    const scored = [...sets.cvx, ...sets.global.filter((a) => !registered.has(a))];
    const vps = await scoreDelegators(full, scored);

    // Snapshot's erc20-balance-of-delegation resolves the space-scoped delegation
    // when there is one and otherwise falls back to the global one, so a
    // global-only delegator's vlCVX IS inside the voting power Snapshot credited
    // to the Union and did earn part of this pot. They were scored here and then
    // dropped by the cvx.eth-only `registered` filter, which silently
    // redistributed their share to everyone else.
    //
    // Paying them requires knowing whether their cvx.eth slot points at someone
    // else, which this scan cannot see: it filters on the Union as delegate, so a
    // competing delegation leaves no log in it. Rather than guess in either
    // direction, refuse. The set is empty for every round in scope today, so this
    // only ever fires when it would otherwise have cost somebody their share.
    const strandedGlobal = sets.global
      .filter((address) => !registered.has(address))
      .filter((address) => (vps[address] ?? 0) > 0);
    if (strandedGlobal.length > 0) {
      throw new Error(
        `${key.period}|${key.protocol}: ${strandedGlobal.length} address(es) delegate to the ` +
          `Union globally with no cvx.eth delegation and hold vlCVX, so Snapshot counted them ` +
          `towards the Union's vote while this split would pay them nothing — ` +
          `${strandedGlobal.join(", ")}. Resolve their cvx.eth slot before continuing.`
      );
    }

    // A delegator who voted the proposal himself backed none of this pot.
    const weights = new Map<string, bigint>();
    let eligibleVp = 0;
    for (const [address, vp] of Object.entries(vps)) {
      if (!registered.has(address) || voters.has(address) || vp <= 0) continue;
      const weight = roundHalfEven(vp * WEIGHT_SCALE);
      if (weight <= 0n) continue;
      weights.set(address, weight);
      eligibleVp += vp;
    }

    // NOTE: this gate is aggregate. It proves the delegator set reconstructs the
    // Union's voting power in total, not that every individual delegator is
    // present, so a holder under the tolerance can still be missing without
    // tripping it. The absolute gap is surfaced alongside the percentage so an
    // operator can see whether real vlCVX is unaccounted for rather than only a
    // ratio; per-address reconciliation needs Snapshot's own per-delegator
    // breakdown, which the scores API does not return in this shape.
    const gap = unionVote.vp - eligibleVp;
    const drift = Math.abs(gap) / (unionVote.vp || 1);
    worstDrift = Math.max(worstDrift, drift);
    if (drift > MAX_VP_DRIFT) {
      throw new Error(
        `${key.period}|${key.protocol}: eligible vlCVX ${eligibleVp} does not reconstruct ` +
          `the ${unionVote.vp} Snapshot credited to the Union ` +
          `(${(drift * 100).toFixed(3)} %, ${gap.toFixed(2)} vlCVX unaccounted for)`
      );
    }

    const bucket = perUserByProtocol.get(key.protocol)!;
    // Captured per round as well as accumulated. The cumulative split alone
    // cannot answer "how much of this address's share is older than six
    // months", which is exactly what a later sweep has to subtract, so the round
    // dimension is written out instead of discarded.
    const thisRound: Record<string, Record<string, string>> = {};
    for (const [token, amount] of tokens) {
      for (const [address, part] of largestRemainder(amount, weights)) {
        if (part <= 0n) continue;
        const own = perUser.get(address) ?? new Map<string, bigint>();
        own.set(token, (own.get(token) ?? 0n) + part);
        perUser.set(address, own);
        const mine = bucket.get(address) ?? new Map<string, bigint>();
        mine.set(token, (mine.get(token) ?? 0n) + part);
        bucket.set(address, mine);
        (thisRound[getAddress(address)] ??= {})[getAddress(token)] = part.toString();
      }
    }
    breakdown.push({
      period: key.period,
      date: new Date(key.period * 1000).toISOString().slice(0, 10),
      protocol: key.protocol,
      proposalId: proposal.id,
      proposalTitle: full.title,
      snapshotBlock: Number(full.snapshot),
      eligible: weights.size,
      tokens: Object.fromEntries([...tokens].map(([t, a]) => [getAddress(t), a.toString()])),
      perUser: thisRound,
    });

    console.log(
      `  ${key.period} ${key.protocol.padEnd(5)} ${proposal.title.slice(0, 40).padEnd(42)}` +
        ` eligible=${weights.size.toString().padStart(4)} drift=${(drift * 100).toFixed(3)}%` +
        ` gap=${gap.toFixed(2)}`
    );
  }

  // ---- every split must equal its own line to the wei -----------------------

  /** A per-user map, shaped as MerkleData claims, with its per-token sums. */
  const shape = (from: Map<string, Map<string, bigint>>) => {
    const claims: MerkleData["claims"] = {};
    const sums = new Map<string, bigint>();
    for (const [address, tokens] of [...from].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const entry: Record<string, { amount: string; proof: string[] }> = {};
      for (const [token, amount] of [...tokens].sort(([a], [b]) => (a < b ? -1 : 1))) {
        entry[getAddress(token)] = { amount: amount.toString(), proof: [] };
        sums.set(token, (sums.get(token) ?? 0n) + amount);
      }
      claims[getAddress(address)] = { tokens: entry };
    }
    return { claims, sums };
  };

  const reconcile = (label: string, owed: Map<string, bigint>, paid: Map<string, bigint>) => {
    for (const token of new Set([...owed.keys(), ...paid.keys()])) {
      const a = owed.get(token) ?? 0n;
      const b = paid.get(token) ?? 0n;
      if (a !== b) throw new Error(`${label}/${token}: distributed ${b} != claimable ${a}`);
    }
  };

  const combined = shape(perUser);
  reconcile("combined", distribute, combined.sums);

  const claimsByProtocol: Record<string, MerkleData["claims"]> = {};
  for (const protocol of PROTOCOLS) {
    const shaped = shape(perUserByProtocol.get(protocol)!);
    // Each protocol's split must equal that base's own Union line, minus the
    // excluded tokens that stay on the Union's claim there.
    const baseDistribute = new Map(
      [...baseLines.get(protocol)!].filter(([token]) => !isExcluded(token))
    );
    reconcile(protocol, baseDistribute, shaped.sums);
    claimsByProtocol[protocol] = shaped.claims;
    console.log(
      `  ${protocol.padEnd(5)} ${Object.keys(shaped.claims).length.toString().padStart(4)} end users` +
        `, ${shaped.sums.size} tokens matching the base's line to the wei`
    );
  }

  const file = path.join(OUT, "union_end_user_merkle.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        meta: {
          union: getAddress(UNION),
          sourceMerkle: path.relative(REPO, merkle.file),
          sourcePeriod: merkle.period,
          // Pin the Union's own line, not the whole root. The root moves on any
          // unrelated regeneration of the latest merkle — ENG-2105 moved it
          // without touching a wei of the Union's line — which made a
          // numerically exact artefact refuse to apply and forced a full
          // 49-round re-run to change one string. These amounts are what the
          // split actually depends on. sourceMerkleRoot below is kept for
          // provenance only; do not gate on it.
          unionClaim: Object.fromEntries(
            [...claimable]
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([token, amount]) => [getAddress(token), amount.toString()])
          ),
          // The lines step 2 must LEAVE on the Union's claim. Keeping them named
          // here means step 2 asserts exactly what should survive rather than
          // re-deriving the policy from its own copy of the exclusion list.
          retainedByUnion: Object.fromEntries(
            [...retained]
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([token, amount]) => [
                getAddress(token),
                { amount: amount.toString(), reason: EXCLUDED_TOKENS.get(token) },
              ])
          ),
          sourceMerkleRoot: source.merkleRoot,
          roundsDigest: digest,
          rounds: live.length,
          roundsSkippedAsExcluded: emptiedRounds,
          endUsers: Object.keys(combined.claims).length,
          worstVpDrift: worstDrift,
        },
        merkleRoot: "",
        claims: combined.claims,
        claimsByProtocol,
      },
      null,
      2
    )
  );

  // Per-round detail, kept out of the committed artefact because it is an order
  // of magnitude larger and derivable from it plus this run's inputs.
  const breakdownFile = path.join(OUT, "round_breakdown.json");
  fs.writeFileSync(
    breakdownFile,
    JSON.stringify(
      {
        meta: {
          union: getAddress(UNION),
          sourcePeriod: merkle.period,
          roundsDigest: digest,
          rounds: breakdown.length,
          endUsers: Object.keys(combined.claims).length,
          excludedTokens: Object.fromEntries(
            [...retained].map(([token]) => [getAddress(token), EXCLUDED_TOKENS.get(token)])
          ),
        },
        rounds: breakdown,
      },
      null,
      2
    )
  );

  console.log(`\nwrote ${path.relative(REPO, file)}`);
  console.log(`      ${path.relative(REPO, breakdownFile)} (${breakdown.length} rounds, per-delegator)`);
  console.log(`  end users   ${Object.keys(combined.claims).length}`);
  console.log(`  tokens      ${combined.sums.size}, each matching the Union's line to the wei`);
  console.log(`  worst drift ${(worstDrift * 100).toFixed(3)} % against Snapshot's voting power`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
