/**
 * Pieces shared by the two Union-reassignment steps.
 *
 * Both steps have to agree on which merkle they operate on, what the Union's
 * line in it is, where the per-gauge bases live, and whether the Union has
 * already claimed. Those were copied into each step and the copies had already
 * drifted — only one of them guarded the empty-period case — so they live here.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import dotenv from "dotenv";
import { encodeFunctionData, getAddress } from "viem";
import { MerkleData } from "../../interfaces/MerkleData";
import { VLCVX_NON_DELEGATORS_MERKLE } from "../../utils/constants";

dotenv.config();

export const REPO = path.resolve(__dirname, "../../..");
export const UNION = "0xde1e6a7ed0ad3f61d531a8a78e83ccddbd6e0c49";

export const PROTOCOLS = ["curve", "fxn"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/**
 * Token lines that are NOT distributed to the end users.
 *
 * ZUN and opASF have no price on DefiLlama and no DEX pair on DexScreener at
 * all — nobody can sell them, so crediting ~1,500 addresses with them buys the
 * recipients nothing and costs 2,003 merkle leaves. USDf is a liquid token, but
 * THIS line is 211087891 wei of an 18-decimal token — $0.0000 — which rounds to
 * nothing for every recipient anyway.
 *
 * Their amounts are deliberately LEFT on the Union's own claim rather than
 * dropped: the merkle totals must stay conserved token by token, so the Union
 * keeps exactly these lines and Stake DAO can sweep them separately. Removing a
 * token from this list and re-running both steps is all it takes to distribute
 * it after all.
 */
export const EXCLUDED_TOKENS = new Map<string, string>([
  ["0x6b5204b0be36771253cc38e88012e02b752f0f36", "ZUN — no price, no DEX pair, $0 liquidity"],
  ["0x7fe24f1a024d33506966cb7ca48bab8c65fb632d", "opASF — no price, no DEX pair, $0 liquidity"],
  ["0xfa2b947eec368f42195f24f36d2af29f7c24cec2", "USDf — line is worth $0.0000 (2.1e-10 units)"],
]);

export const isExcluded = (token: string) => EXCLUDED_TOKENS.has(token.toLowerCase());

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

/**
 * JSON-RPC with endpoint fallthrough.
 *
 * A body carrying neither `result` nor `error` is a failure, not a value:
 * providers answer that way when they rate-limit or interpose a proxy notice,
 * and returning the `undefined` through produced a NaN block number that
 * silently skipped the entire registry scan and cached the empty result.
 */
export async function rpc(method: string, params: unknown[]): Promise<any> {
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
      if (json.result === undefined || json.result === null) {
        throw new Error(`${method}: no result in ${JSON.stringify(json).slice(0, 200)}`);
      }
      return json.result;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/** The most recent round that has a mainnet vlCVX merkle. */
export function latestMerkle(): { period: number; file: string } {
  const reports = path.join(REPO, "bounties-reports");
  const periods = fs
    .readdirSync(reports)
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .filter((p) => fs.existsSync(path.join(reports, String(p), "vlCVX/vlcvx_merkle.json")))
    .sort((a, b) => a - b);
  if (periods.length === 0) throw new Error("no vlcvx_merkle.json under bounties-reports/");
  const period = periods[periods.length - 1];
  return { period, file: path.join(reports, String(period), "vlCVX/vlcvx_merkle.json") };
}

/**
 * `vlcvx_merkle.json` is DERIVED, never a source: createCombinedMerkle rebuilds
 * it every period as mergeMerkleData(curve, fxn) from these two per-gauge bases,
 * and re-seeds each base from the PREVIOUS period's own copy via
 * findPreviousMerkle — not from the combined file. A reassignment that patches
 * only the combined merkle is therefore reverted by the next weekly run, which
 * re-credits the Union and drops every end user back to their old cumulative
 * amount. Both bases have to be patched alongside it.
 */
export function basePath(period: number, protocol: Protocol): string {
  return path.join(
    REPO,
    "bounties-reports",
    String(period),
    "vlCVX",
    protocol,
    "merkle_data_non_delegators.json"
  );
}

/** The Union's cumulative line in `merkle`, keyed by lowercase token. */
export function unionLine(merkle: MerkleData, where: string): Map<string, bigint> {
  const key = Object.keys(merkle.claims).find((a) => a.toLowerCase() === UNION);
  if (!key) throw new Error(`the Union holds no claim in ${where}`);
  return new Map(
    Object.entries(merkle.claims[key].tokens).map(([token, { amount }]) => [
      token.toLowerCase(),
      BigInt(amount),
    ])
  );
}

export type RoundKey = { period: number; protocol: Protocol };
export type Round = { key: RoundKey; tokens: Map<string, bigint> };

/**
 * The rounds that credited The Union, from the repartition files.
 *
 * Mainnet only: the Base/Arbitrum repartitions feed their own merkles and are
 * not part of the mainnet claimable this reassignment targets.
 *
 * Lives here because BOTH steps need it: step 2 has to re-derive the round-level
 * inputs to check the split it is about to apply was computed against them.
 */
export function unionRounds(): Round[] {
  const rounds = new Map<string, Map<string, bigint>>();
  const reports = path.join(REPO, "bounties-reports");

  for (const period of fs.readdirSync(reports)) {
    if (!/^\d+$/.test(period)) continue;
    const base = path.join(reports, period, "vlCVX");
    if (!fs.existsSync(base)) continue;

    // The flat layout predates the curve/fxn split and is Curve-only. Both
    // layouts collapse onto the same period|curve key and their amounts are
    // SUMMED, so a period carrying both — any backfill or legacy restore — would
    // double that round. The nested file supersedes the flat one.
    const files: { file: string; protocol: Protocol }[] = [];
    if (!fs.existsSync(path.join(base, "curve", "repartition.json"))) {
      files.push({ file: path.join(base, "repartition.json"), protocol: "curve" });
    }
    for (const protocol of PROTOCOLS) {
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
      return { key: { period: Number(period), protocol: protocol as Protocol }, tokens };
    })
    .sort((a, b) =>
      a.key.period !== b.key.period
        ? a.key.period - b.key.period
        : a.key.protocol < b.key.protocol
          ? -1
          : 1
    );
}

/** Drop excluded tokens, then drop rounds left crediting nothing. */
export function liveRounds(rounds: Round[]): { live: Round[]; skipped: number } {
  let skipped = 0;
  for (const round of rounds) {
    for (const token of [...round.tokens.keys()]) {
      if (isExcluded(token)) round.tokens.delete(token);
    }
  }
  const live = rounds.filter((round) => {
    if (round.tokens.size > 0) return true;
    skipped++;
    return false;
  });
  return { live, skipped };
}

/**
 * Fingerprint of the round-level inputs the allocation depends on.
 *
 * Pinning the Union's aggregate per-token line is NOT sufficient: step 1 splits
 * each round over the delegator set at that round's own snapshot block, so a
 * backfill that moves an amount between rounds while leaving every per-token
 * total identical changes who gets paid without changing the line. Step 2
 * compares this digest before reusing a split, so that reattribution is caught
 * instead of being applied to the wrong delegator sets.
 */
export function roundsDigest(rounds: Round[]): string {
  const canonical = rounds
    .map(
      ({ key, tokens }) =>
        `${key.period}|${key.protocol}|` +
        [...tokens]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([token, amount]) => `${token}:${amount}`)
          .join(",")
    )
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

const CLAIMED_ABI = [
  {
    name: "claimed",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "reward", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * A cumulative merkle entry is gross-earned, not net-of-claims: the distributor
 * pays `amount - claimed(account, reward)`. Reassigning the Union's full
 * historical line is only sound while `claimed` is zero on every token —
 * otherwise the same wei are owed twice and the distributor runs short for
 * whoever claims last.
 *
 * The old root stays claimable until the new one is accepted, so this is a
 * gate for BOTH steps and must be re-run immediately before acceptRoot; a
 * compute-time check alone leaves the whole publish window uncovered.
 */
export async function assertUnionNeverClaimed(tokens: Iterable<string>): Promise<number> {
  const claimed: [string, bigint][] = [];
  let checked = 0;
  for (const token of tokens) {
    const raw = await rpc("eth_call", [
      {
        to: getAddress(VLCVX_NON_DELEGATORS_MERKLE),
        data: encodeFunctionData({
          abi: CLAIMED_ABI,
          functionName: "claimed",
          args: [getAddress(UNION), getAddress(token)],
        }),
      },
      "latest",
    ]);
    checked++;
    const amount = BigInt(raw);
    if (amount > 0n) claimed.push([token, amount]);
  }
  if (claimed.length > 0) {
    throw new Error(
      `the Union has already claimed on ${claimed.length} of ${checked} token(s), so ` +
        `reassigning its full line would owe those wei twice:\n` +
        claimed.map(([token, amount]) => `  ${token} ${amount} wei`).join("\n")
    );
  }
  return checked;
}
