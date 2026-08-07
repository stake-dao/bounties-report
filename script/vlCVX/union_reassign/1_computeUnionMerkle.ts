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
 * Output: out/union_end_user_merkle.json, MerkleData-shaped and ready for
 * 2_mergeIntoLatestMerkle.ts. Nothing is written unless the per-token sum
 * equals the Union's live claimable to the wei.
 *
 * Network responses are cached under .cache/ so a re-run is cheap.
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getAddress } from "viem";
import { MerkleData } from "../../interfaces/MerkleData";

dotenv.config();

const HERE = __dirname;
const REPO = path.resolve(HERE, "../../..");
const CACHE = path.join(HERE, ".cache");
const OUT = path.join(HERE, "out");

const UNION = "0xde1e6a7ed0ad3f61d531a8a78e83ccddbd6e0c49";
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
// Scanning the registry needs an endpoint that serves wide eth_getLogs ranges,
// which an Alchemy free tier does not (it caps at 10 blocks). RPC_URL_1 accepts
// a comma-separated list and every call falls through it in order — providers
// do go blind on individual block regions, and a second one gets past it.
const RPC_ENDPOINTS = (process.env.RPC_URL_1 ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean)
  .concat(
    process.env.WEB3_ALCHEMY_API_KEY
      ? [`https://eth-mainnet.g.alchemy.com/v2/${process.env.WEB3_ALCHEMY_API_KEY}`]
      : []
  );

// float vlCVX -> integer weight. 1e12 keeps well under float64's 15-16 digits
// for the largest balance seen (~2.4M vlCVX) while making ties astronomically
// unlikely.
const WEIGHT_SCALE = 1e12;

// Snapshot's vote is the reference: the eligible vlCVX must reconstruct the
// voting power it credited to The Union. Two FXN proposals are counted twice
// (the Thursday and Tuesday rounds share a proposal) and Snapshot did not
// credit one delegator there, hence a tolerance rather than an equality.
const MAX_VP_DRIFT = 0.0005;

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cached<T>(name: string, produce: () => Promise<T>): Promise<T> {
  const file = path.join(CACHE, `${name}.json`);
  if (fs.existsSync(file)) return Promise.resolve(JSON.parse(fs.readFileSync(file, "utf8")));
  return produce().then((value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
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

async function rpc(method: string, params: unknown[]): Promise<any> {
  if (RPC_ENDPOINTS.length === 0) {
    throw new Error("no Ethereum endpoint: set RPC_URL_1 (comma-separated list allowed)");
  }
  let last: unknown;
  for (const url of RPC_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = await res.json();
      if (json.error) throw new Error(JSON.stringify(json.error));
      return json.result;
    } catch (error) {
      last = error;
    }
  }
  throw last;
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

type RoundKey = { period: number; protocol: string };

/**
 * Mainnet only: the Base/Arbitrum repartitions feed their own merkles and are
 * not part of the mainnet claimable this reassignment targets.
 */
function unionRounds(): { key: RoundKey; tokens: Map<string, bigint> }[] {
  const rounds = new Map<string, Map<string, bigint>>();
  const reports = path.join(REPO, "bounties-reports");

  for (const period of fs.readdirSync(reports)) {
    if (!/^\d+$/.test(period)) continue;
    const base = path.join(reports, period, "vlCVX");
    if (!fs.existsSync(base)) continue;

    // The flat layout predates the curve/fxn split and is Curve-only.
    const files: { file: string; protocol: string }[] = [
      { file: path.join(base, "repartition.json"), protocol: "curve" },
    ];
    for (const protocol of ["curve", "fxn"]) {
      files.push({ file: path.join(base, protocol, "repartition.json"), protocol });
    }

    for (const { file, protocol } of files) {
      if (!fs.existsSync(file)) continue;
      const distribution = JSON.parse(fs.readFileSync(file, "utf8")).distribution ?? {};
      for (const [address, payload] of Object.entries<any>(distribution)) {
        if (address.toLowerCase() !== UNION) continue;
        const key = `${period}|${protocol}`;
        const tokens = rounds.get(key) ?? new Map<string, bigint>();
        for (const [token, amount] of Object.entries<string>(payload.tokens ?? {})) {
          const t = token.toLowerCase();
          tokens.set(t, (tokens.get(t) ?? 0n) + BigInt(amount));
        }
        rounds.set(key, tokens);
      }
    }
  }

  return [...rounds.entries()]
    .map(([key, tokens]) => {
      const [period, protocol] = key.split("|");
      return { key: { period: Number(period), protocol }, tokens };
    })
    .sort((a, b) =>
      a.key.period !== b.key.period
        ? a.key.period - b.key.period
        : a.key.protocol < b.key.protocol
          ? -1
          : 1
    );
}

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
  for (const [key, proposal] of mapping) {
    const [period, protocol] = key.split("|");
    const file = path.join(
      REPO,
      `bounties-reports/${period}/vlCVX/${protocol}/repartition.json`
    );
    if (!fs.existsSync(file)) continue;
    const recorded = JSON.parse(fs.readFileSync(file, "utf8")).proposalId;
    if (typeof recorded !== "string" || !recorded.startsWith("0x")) continue;
    if (recorded !== proposal.id) {
      throw new Error(`${key}: resolved ${proposal.id} but repartition records ${recorded}`);
    }
    checked++;
  }
  console.log(`  round -> proposal cross-checked on ${checked} recorded proposalIds`);

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
  return cached("union-delegation-events", async () => {
    const latest = Number(await rpc("eth_blockNumber", []));
    const logs: any[] = [];
    let start = REGISTRY_CREATION_BLOCK;
    let chunk = 2_000_000;

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
      } catch (error) {
        if (++attempt < 4) {
          await sleep(2000 * attempt);
          continue;
        }
        attempt = 0;
        if (chunk <= 50_000) {
          throw new Error(
            `eth_getLogs keeps failing on ${start}-${end} at ${chunk} blocks — this scan needs ` +
              `an endpoint that serves wide ranges. Set RPC_URL_1 to one (an Alchemy free tier ` +
              `caps at 10 blocks). Underlying error: ${error}`
          );
        }
        chunk = Math.floor(chunk / 4);
        console.log(`    ${start}-${end} refused, retrying with ${chunk} blocks`);
      }
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
  });
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
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function latestMerkle(): { period: number; file: string } {
  const reports = path.join(REPO, "bounties-reports");
  const periods = fs
    .readdirSync(reports)
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .filter((p) => fs.existsSync(path.join(reports, String(p), "vlCVX/vlcvx_merkle.json")))
    .sort((a, b) => a - b);
  const period = periods[periods.length - 1];
  return { period, file: path.join(reports, String(period), "vlCVX/vlcvx_merkle.json") };
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const merkle = latestMerkle();
  const source: MerkleData = JSON.parse(fs.readFileSync(merkle.file, "utf8"));
  const unionKey = Object.keys(source.claims).find((a) => a.toLowerCase() === UNION);
  if (!unionKey) throw new Error(`the Union holds no claim in ${merkle.file}`);
  const claimable = new Map<string, bigint>(
    Object.entries(source.claims[unionKey].tokens).map(([t, { amount }]) => [
      t.toLowerCase(),
      BigInt(amount),
    ])
  );
  console.log(`merkle   ${path.relative(REPO, merkle.file)}`);
  console.log(`         ${claimable.size} tokens claimable by the Union, never claimed`);

  const rounds = unionRounds();
  console.log(`rounds   ${rounds.length} credited the Union`);

  const mapping = await resolveProposals(rounds);
  const events = await delegationEvents();
  console.log(`registry ${events.length} delegation events towards the Union`);

  // The merkle is what is actually claimable. Summing the per-round
  // repartitions can land a few wei above it (rounding when each weekly merkle
  // was built), so trim the difference off the last round that paid the token.
  const totals = new Map<string, bigint>();
  for (const { tokens } of rounds) {
    for (const [token, amount] of tokens) totals.set(token, (totals.get(token) ?? 0n) + amount);
  }
  for (const [token, total] of totals) {
    const drift = total - (claimable.get(token) ?? 0n);
    if (drift === 0n) continue;
    const last = [...rounds].reverse().find((r) => r.tokens.has(token))!;
    const amount = last.tokens.get(token)!;
    if (!(amount > drift && drift > 0n)) {
      throw new Error(`${token}: unexpected drift ${drift} vs merkle`);
    }
    last.tokens.set(token, amount - drift);
    console.log(`         dust trim ${token.slice(0, 10)}: -${drift} wei on round ${last.key.period}`);
  }

  const perUser = new Map<string, Map<string, bigint>>();
  let worstDrift = 0;

  for (const { key, tokens } of rounds) {
    const proposal = mapping.get(`${key.period}|${key.protocol}`)!;
    const { proposal: full, votes } = await proposalWithVotes(proposal.id);
    const voters = new Set(votes.map((v) => v.voter.toLowerCase()));
    const unionVote = votes.find((v) => v.voter.toLowerCase() === UNION);
    if (!unionVote) throw new Error(`${proposal.id}: the Union did not vote`);

    const sets = delegatorSetAt(events, Number(full.snapshot));
    const registered = new Set(sets.cvx);
    const scored = [...sets.cvx, ...sets.global.filter((a) => !registered.has(a))];
    const vps = await scoreDelegators(full, scored);

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

    const drift = Math.abs(unionVote.vp - eligibleVp) / (unionVote.vp || 1);
    worstDrift = Math.max(worstDrift, drift);
    if (drift > MAX_VP_DRIFT) {
      throw new Error(
        `${key.period}|${key.protocol}: eligible vlCVX ${eligibleVp} does not reconstruct ` +
          `the ${unionVote.vp} Snapshot credited to the Union (${(drift * 100).toFixed(3)} %)`
      );
    }

    for (const [token, amount] of tokens) {
      for (const [address, part] of largestRemainder(amount, weights)) {
        if (part <= 0n) continue;
        const own = perUser.get(address) ?? new Map<string, bigint>();
        own.set(token, (own.get(token) ?? 0n) + part);
        perUser.set(address, own);
      }
    }

    console.log(
      `  ${key.period} ${key.protocol.padEnd(5)} ${proposal.title.slice(0, 40).padEnd(42)}` +
        ` eligible=${weights.size.toString().padStart(4)} drift=${(drift * 100).toFixed(3)}%`
    );
  }

  // ---- the split must equal the Union's line to the wei ---------------------

  const claims: MerkleData["claims"] = {};
  const distributed = new Map<string, bigint>();
  for (const [address, tokens] of [...perUser].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const entry: Record<string, { amount: string; proof: string[] }> = {};
    for (const [token, amount] of [...tokens].sort(([a], [b]) => (a < b ? -1 : 1))) {
      entry[getAddress(token)] = { amount: amount.toString(), proof: [] };
      distributed.set(token, (distributed.get(token) ?? 0n) + amount);
    }
    claims[getAddress(address)] = { tokens: entry };
  }

  for (const token of new Set([...claimable.keys(), ...distributed.keys()])) {
    const owed = claimable.get(token) ?? 0n;
    const paid = distributed.get(token) ?? 0n;
    if (owed !== paid) throw new Error(`${token}: distributed ${paid} != claimable ${owed}`);
  }

  const file = path.join(OUT, "union_end_user_merkle.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        meta: {
          union: getAddress(UNION),
          sourceMerkle: path.relative(REPO, merkle.file),
          sourceMerkleRoot: source.merkleRoot,
          rounds: rounds.length,
          endUsers: Object.keys(claims).length,
          worstVpDrift: worstDrift,
        },
        merkleRoot: "",
        claims,
      },
      null,
      2
    )
  );

  console.log(`\nwrote ${path.relative(REPO, file)}`);
  console.log(`  end users   ${Object.keys(claims).length}`);
  console.log(`  tokens      ${distributed.size}, each matching the Union's line to the wei`);
  console.log(`  worst drift ${(worstDrift * 100).toFixed(3)} % against Snapshot's voting power`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
