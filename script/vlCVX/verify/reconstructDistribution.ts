/**
 * Independent reconstruction of the vlCVX Thursday voters merkle.
 *
 * Rebuilds every wallet×token week-delta from the primary distribution
 * sources and requires the published merkle to match to the wei. Run after
 * each distribution as the closing invariant.
 *
 * Checks:
 * 1. Proofs — every leaf folds to the published merkleRoot
 * 2. Monotonicity — cumulative claims never shrink or drop vs the previous merkle
 * 3. Conservation — flattened perDelegate attribution equals totalPerGroup
 *    per gauge / group / token (routing: pooled = forwarders behind
 *    VLCVX_POOLED_DELEGATES; everyone else raw)
 * 4. Reconstruction — direct legs + raw-routed delegation legs + raw Votium
 *    legs === merkle week delta, wallet×token, wei-exact, no extras either way
 * 5. Pooled containment — pooled wallets carry no unexplained delta here
 * 6. Votium legality — every raw Votium payee either forwards to the Stake DAO
 *    forwarder per the registry facts, or voted its own vlCVX this round
 * 7. Claimed cap — raw Votium paid per token <= claimed from Votium
 * 8. Withdrawal — votium_thursday_withdrawal equals the log's totalRewardsPaid
 *
 * Non-claim weeks (no votium_forwarders_log) skip checks 6-8 and reconstruct
 * from gauge legs only.
 *
 * Usage:
 *   pnpm tsx script/vlCVX/verify/reconstructDistribution.ts [--timestamp WEEK]
 *
 * Exits non-zero on any failed check.
 */

import * as fs from "fs";
import * as path from "path";
import { keccak256, encodeAbiParameters, concat } from "viem";
import { WEEK, VLCVX_POOLED_DELEGATES } from "../../utils/constants";
import {
  CheckResult,
  REPORTS_DIR,
  bp,
  fileExists,
  printSection,
  readJSON,
  shortAddr,
} from "../../utils/verifyHelpers";

const WEEKLY_BOUNTIES_DIR = path.join(__dirname, "../../../weekly-bounties");
const GAUGES = ["curve", "fxn"] as const;
const POOLED = new Set(VLCVX_POOLED_DELEGATES.map((a) => a.toLowerCase()));

const lc = (s: string) => s.toLowerCase();
const legKey = (w: string, t: string) => `${lc(w)}|${lc(t)}`;

function parseTimestamp(): number {
  const idx = process.argv.indexOf("--timestamp");
  if (idx !== -1) return Number(process.argv[idx + 1]);
  const weeks = fs
    .readdirSync(REPORTS_DIR)
    .filter((d) => /^\d+$/.test(d) && fileExists(path.join(REPORTS_DIR, d, "vlCVX/vlcvx_merkle.json")))
    .map(Number)
    .sort((a, b) => b - a);
  if (weeks.length === 0) throw new Error("no vlCVX voters merkle found under bounties-reports/");
  return weeks[0];
}

/** wallet(lc) -> token(lc) -> cumulative wei */
function indexMerkle(merkle: any): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const [addr, claim] of Object.entries<any>(merkle.claims)) {
    for (const [token, v] of Object.entries<any>(claim.tokens)) {
      out.set(legKey(addr, token), BigInt(typeof v === "string" ? v : v.amount));
    }
  }
  return out;
}

function findPreviousMerkle(timestamp: number): { data: any; foundAt: number } | null {
  for (let back = 1; back <= 8; back++) {
    const ts = timestamp - back * WEEK;
    const p = bp(ts, "vlCVX/vlcvx_merkle.json");
    if (fileExists(p)) return { data: readJSON(p), foundAt: ts };
  }
  return null;
}

function verifyProofs(merkle: any): CheckResult {
  const hashPair = (a: `0x${string}`, b: `0x${string}`) =>
    keccak256(concat(a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]));
  let leaves = 0;
  let bad = 0;
  for (const [addr, claim] of Object.entries<any>(merkle.claims)) {
    for (const [token, { amount, proof }] of Object.entries<any>(claim.tokens)) {
      leaves++;
      let node = keccak256(
        keccak256(
          encodeAbiParameters(
            [{ type: "address" }, { type: "address" }, { type: "uint256" }],
            [addr as `0x${string}`, token as `0x${string}`, BigInt(amount)]
          )
        )
      );
      for (const p of proof) node = hashPair(node, p);
      if (node !== merkle.merkleRoot) bad++;
    }
  }
  return {
    label: "proofs",
    ok: bad === 0,
    detail: `${leaves} leaves, ${bad} fail to fold to ${merkle.merkleRoot.slice(0, 10)}…`,
  };
}

function main() {
  const timestamp = parseTimestamp();
  console.log(`\nvlCVX Thursday reconstruction — week ${timestamp}`);

  const merkle = readJSON(bp(timestamp, "vlCVX/vlcvx_merkle.json"));
  const prev = findPreviousMerkle(timestamp);
  if (!prev) throw new Error("no previous voters merkle found within 8 weeks — cannot compute week delta");

  const sections: boolean[] = [];

  // 1. proofs ------------------------------------------------------------------
  sections.push(printSection("proof integrity", [verifyProofs(merkle)]));

  // 2. monotonicity ------------------------------------------------------------
  const curIdx = indexMerkle(merkle);
  const prevIdx = indexMerkle(prev.data);
  let shrunk = 0;
  let dropped = 0;
  for (const [k, v] of prevIdx) {
    const c = curIdx.get(k);
    if (c === undefined) dropped++;
    else if (c < v) shrunk++;
  }
  sections.push(
    printSection("cumulative monotonicity", [
      {
        label: `vs ${prev.foundAt}`,
        ok: shrunk === 0 && dropped === 0,
        detail: `${shrunk} shrunk, ${dropped} dropped leaves`,
      },
    ])
  );

  // 3+4+5. rebuild expected week delta from primary sources --------------------
  const expected = new Map<string, { amt: bigint; sources: string[] }>();
  const addLeg = (w: string, t: string, amt: string, src: string) => {
    const k = legKey(w, t);
    const e = expected.get(k) ?? { amt: 0n, sources: [] };
    e.amt += BigInt(amt);
    e.sources.push(src);
    expected.set(k, e);
  };

  const conservation: CheckResult[] = [];
  const pooledWallets = new Set<string>();
  const registryForwarders = new Set<string>();

  for (const gauge of GAUGES) {
    const directPath = bp(timestamp, `vlCVX/${gauge}/repartition.json`);
    if (fileExists(directPath)) {
      for (const [w, v] of Object.entries<any>(readJSON(directPath).distribution)) {
        for (const [t, amt] of Object.entries<any>(v.tokens)) addLeg(w, t, amt, `${gauge}:direct`);
      }
    }

    const delegPath = bp(timestamp, `vlCVX/${gauge}/repartition_delegation.json`);
    if (!fileExists(delegPath)) continue;
    const dist = readJSON(delegPath).distribution;
    for (const w of Object.keys(dist.forwarders ?? {})) registryForwarders.add(lc(w));

    const pooledSum: Record<string, bigint> = {};
    const rawSum: Record<string, bigint> = {};
    for (const [delegate, section] of Object.entries<any>(dist.perDelegate ?? {})) {
      const isPooled = POOLED.has(lc(delegate));
      for (const [group, wallets] of [
        ["forwarders", section.forwarders],
        ["nonForwarders", section.nonForwarders],
      ] as const) {
        for (const [w, tokens] of Object.entries<any>(wallets ?? {})) {
          for (const [t, amt] of Object.entries<any>(tokens)) {
            if (group === "forwarders" && isPooled) {
              pooledSum[lc(t)] = (pooledSum[lc(t)] ?? 0n) + BigInt(amt);
              pooledWallets.add(lc(w));
            } else {
              rawSum[lc(t)] = (rawSum[lc(t)] ?? 0n) + BigInt(amt);
              addLeg(w, t, amt, `${gauge}:deleg(${shortAddr(delegate)},${group})`);
            }
          }
        }
      }
    }
    for (const [t, groups] of Object.entries<any>(dist.totalPerGroup ?? {})) {
      const fileFwd = BigInt(groups.forwarders ?? "0");
      const fileRaw = BigInt(groups.nonForwarders ?? "0");
      const myFwd = pooledSum[lc(t)] ?? 0n;
      const myRaw = rawSum[lc(t)] ?? 0n;
      conservation.push({
        label: `${gauge} ${shortAddr(t)}`,
        ok: fileFwd === myFwd && fileRaw === myRaw,
        detail:
          fileFwd === myFwd && fileRaw === myRaw
            ? `pooled ${myFwd} / raw ${myRaw}`
            : `pooled file=${fileFwd} rebuilt=${myFwd}, raw file=${fileRaw} rebuilt=${myRaw}`,
      });
    }
  }
  sections.push(printSection("perDelegate ↔ totalPerGroup conservation", conservation));

  // votium raw legs (claim weeks only)
  const logPath = bp(timestamp, "vlCVX/curve/votium_forwarders_log.json");
  const isClaimWeek = fileExists(logPath);
  const votiumWallets = new Set<string>();
  let log: any = null;
  if (isClaimWeek) {
    log = readJSON(logPath);
    for (const [w, tokens] of Object.entries<any>(log.forwardersData.tokenAllocations)) {
      votiumWallets.add(lc(w));
      for (const [t, leg] of Object.entries<any>(tokens)) addLeg(w, t, leg.amountWei, "votium");
    }
  }

  // 4. reconstruction ----------------------------------------------------------
  const deltas = new Map<string, bigint>();
  for (const [k, v] of curIdx) {
    const d = v - (prevIdx.get(k) ?? 0n);
    if (d !== 0n) deltas.set(k, d);
  }
  const mismatches: string[] = [];
  const union = new Set([...expected.keys(), ...deltas.keys()]);
  for (const k of union) {
    const e = expected.get(k)?.amt ?? 0n;
    const d = deltas.get(k) ?? 0n;
    if (e !== d) {
      mismatches.push(
        `${k} expected=${e} merkle=${d} (${(expected.get(k)?.sources ?? ["no source"]).join(" + ")})`
      );
    }
  }
  sections.push(
    printSection("week-delta reconstruction", [
      {
        label: `direct + raw deleg${isClaimWeek ? " + votium" : ""} vs merkle`,
        ok: mismatches.length === 0,
        detail: `${union.size} wallet×token legs, ${mismatches.length} mismatched`,
      },
    ])
  );
  for (const m of mismatches.slice(0, 20)) console.log(`     ↳ ${m}`);

  // 5. pooled containment ------------------------------------------------------
  let pooledLeaks = 0;
  for (const [k, d] of deltas) {
    const w = k.split("|")[0];
    if (!pooledWallets.has(w)) continue;
    if ((expected.get(k)?.amt ?? 0n) !== d) pooledLeaks++;
  }
  sections.push(
    printSection("pooled containment", [
      {
        label: `${pooledWallets.size} pooled wallets`,
        ok: pooledLeaks === 0,
        detail: `${pooledLeaks} unexplained deltas in the Thursday merkle`,
      },
    ])
  );

  // 6-8. votium checks (claim weeks) -------------------------------------------
  if (isClaimWeek) {
    const votedPath = path.join(WEEKLY_BOUNTIES_DIR, String(timestamp), "votium/forwarders_voted_rewards.json");
    const voted = fileExists(votedPath) ? readJSON(votedPath) : null;
    const ownVoters = new Set<string>();
    if (voted) {
      for (const side of ["curveVotes", "fxnVotes"]) {
        for (const w of Object.keys(voted[side] ?? {})) ownVoters.add(lc(w));
      }
    }
    const illegal = [...votiumWallets].filter((w) => !registryForwarders.has(w) && !ownVoters.has(w));
    sections.push(
      printSection("votium payee legality", [
        {
          label: `${votiumWallets.size} raw Votium payees`,
          ok: illegal.length === 0,
          detail:
            illegal.length === 0
              ? "each is a registry forwarder or voted its own vlCVX"
              : `${illegal.length} neither forwarder nor own-voter: ${illegal.slice(0, 3).map(shortAddr).join(", ")}`,
        },
      ])
    );

    const claimedPath = path.join(WEEKLY_BOUNTIES_DIR, String(timestamp), "votium/claimed_bounties_convex.json");
    const capResults: CheckResult[] = [];
    if (fileExists(claimedPath)) {
      const claimedPerToken: Record<string, bigint> = {};
      for (const side of Object.values<any>(readJSON(claimedPath))) {
        for (const b of Object.values<any>(side)) {
          claimedPerToken[lc(b.rewardToken)] = (claimedPerToken[lc(b.rewardToken)] ?? 0n) + BigInt(b.amount);
        }
      }
      for (const [t, v] of Object.entries<any>(log.totalRewardsPaid ?? {})) {
        const paid = BigInt(v);
        const claimed = claimedPerToken[lc(t)] ?? 0n;
        capResults.push({
          label: shortAddr(t),
          ok: paid <= claimed,
          detail: paid <= claimed ? `paid ${paid} ≤ claimed ${claimed}` : `paid ${paid} > claimed ${claimed}`,
        });
      }
    }
    sections.push(printSection("claimed cap (raw ≤ claimed, remainder = pool + dust)", capResults));

    const wdPath = bp(timestamp, "vlCVX/votium_thursday_withdrawal.json");
    const wdResults: CheckResult[] = [];
    if (fileExists(wdPath)) {
      const wd = readJSON(wdPath);
      const tokens = new Set([...Object.keys(wd.tokens ?? {}), ...Object.keys(log.totalRewardsPaid ?? {})].map(lc));
      let bad = 0;
      for (const t of tokens) {
        if ((wd.tokens?.[t] ?? "0") !== (log.totalRewardsPaid?.[t] ?? "0")) bad++;
      }
      wdResults.push({
        label: `${tokens.size} tokens`,
        ok: bad === 0,
        detail: bad === 0 ? "withdrawal ≡ totalRewardsPaid to the wei" : `${bad} tokens differ`,
      });
    } else {
      wdResults.push({
        label: "votium_thursday_withdrawal.json",
        ok: false,
        detail: "missing while a votium log exists — the funding leg is unstaged",
      });
    }
    sections.push(printSection("thursday withdrawal", wdResults));
  } else {
    console.log("\n  (no votium_forwarders_log — non-claim week, votium checks skipped)");
  }

  const allOk = sections.every(Boolean);
  console.log(`\n${allOk ? "✅ ALL INVARIANTS HOLD" : "❌ INVARIANT VIOLATIONS — do not distribute"}\n`);
  process.exit(allOk ? 0 : 1);
}

main();
