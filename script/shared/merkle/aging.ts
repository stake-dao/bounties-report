/**
 * Aging of cumulative-merkle credits: which part of an (address, token) line is
 * older than six months, and how much of it a sweep may take back.
 *
 * A cumulative merkle stores one number per (address, token); every weekly
 * credit is folded in and its date discarded. This module recovers the dates by
 * DIFFERENCING the committed artifact series: merkle[P] - merkle[P-1] is the
 * credit granted at P, by definition, whatever legs fed it. Differencing is
 * only sound while the series is monotone, so the builder hard-fails on any
 * unexplained decrease — a restatement (a period rewritten in place, e.g. the
 * ENG-2105 Union reassignment) must be listed explicitly to be tolerated.
 *
 * The sweep itself is a two-phase protocol, both phases file-backed and
 * reviewable:
 *
 *   1. ANNOUNCE — a dated file listing exactly which (address, token, period)
 *      credits become sweepable on an effective date. The thirty-day notice is
 *      mandatory (delegators must be able to claim before it lands), so the
 *      effective date is at least NOTICE_DAYS after the announcement and the
 *      six-month test is evaluated AT the effective date, not at announce time.
 *   2. APPLY — at merkle generation on/after the effective date, reduce each
 *      announced line by what is still recoverable given claimed() on-chain,
 *      credit the recipient, and emit verifier waivers capped at exactly the
 *      applied reduction.
 *
 * What "still recoverable" means depends on the claim-consumption policy,
 * because claimed(account, reward) is a single number that does not say which
 * credits it paid for:
 *
 *   - "fifo": claims are assumed to have consumed the OLDEST credits first, so
 *     the aged part is already partly paid out: reduction = max(0, A - C).
 *     This is the conservative default — it never takes anything a claimer
 *     could argue was theirs.
 *   - "gross": the aged part is taken in full, capped only so the line never
 *     drops below claimed: reduction = min(A, cum - C). Only justified when
 *     provenance shows the announced amounts were never claimable — the Union
 *     reassignment case, where the announced share entered no posted root.
 *
 * Both formulas keep newCumulative >= claimed, so a sweep can never make an
 * address's claim() revert (PRESERVE_BELOW_CLAIMED is unreachable from here);
 * only PRESERVE_AMOUNT_REDUCED / PRESERVE_PAIR_REMOVED fire, and those are
 * exactly the waivers the apply phase emits.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { getAddress } from "viem";
import { MerkleData } from "../../interfaces/MerkleData";

/** Sweeps may only reach credits strictly older than this, at the effective date. */
export const AGE_MONTHS = 6;
/** Mandatory notice between announcing a sweep and it becoming effective. */
export const NOTICE_DAYS = 30;

export const pairKey = (address: string, token: string) =>
  `${getAddress(address)}|${getAddress(token)}`;

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/**
 * `YYYY-MM-DD` -> unix seconds at 00:00 UTC.
 *
 * Round-tripped, because Date.UTC silently NORMALISES an impossible date:
 * "2026-09-31" becomes 1 October and still returns a finite timestamp, so a
 * sweep would run against a different day than the one it printed.
 */
export function parseDay(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) throw new Error(`expected a YYYY-MM-DD date, got "${text}"`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ts = Date.UTC(year, month - 1, day) / 1000;
  const back = new Date(ts * 1000);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    throw new Error(
      `"${text}" is not a real calendar date — it normalises to ` +
        `${back.toISOString().slice(0, 10)}`
    );
  }
  return ts;
}

export const dayOf = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

/**
 * N calendar months back, clamped to the target month's last day.
 *
 * Calendar months rather than 30*N days so the cutoff cannot drift, and
 * clamped because Date.UTC rolls a non-existent day into the NEXT month: six
 * months before 31 October would land on 1 May instead of 30 April, moving the
 * cutoff LATER and making a 30 April credit look sweepable when it is not yet.
 */
export function minusMonths(ts: number, months: number): number {
  const d = new Date(ts * 1000);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() - months;
  // Day 0 of the following month is the last day of the target month.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay)) / 1000;
}

// ---------------------------------------------------------------------------
// Credit ledger, by differencing the committed series
// ---------------------------------------------------------------------------

export type Credit = { period: number; amount: bigint };

export interface CreditLedger {
  /** pairKey -> credits in period order. Sums to `latest` exactly. */
  credits: Map<string, Credit[]>;
  /** pairKey -> cumulative amount in the newest artifact. */
  latest: Map<string, bigint>;
  /** Periods that actually carried an artifact, ascending. */
  periods: number[];
}

/**
 * An explained decrease in the series. Anything else hard-fails the builder.
 *
 * "reset" — the artifact was legitimately rewritten in place (e.g. the
 * ENG-2105 Union reassignment): the pair's prior credits are dropped and the
 * surviving amount becomes an opening balance dated at `period`. Re-dating to
 * "now" is the SAFE direction for an age test — it can only make credits look
 * younger, never sweepable too early. A reset pair whose amount did NOT
 * change keeps its original dates on purpose: an untouched line was claimable
 * all along, so its six-month clock correctly runs from the original
 * distribution — re-dating it would only delay a legitimate recovery.
 *
 * "consume-oldest" — a previous aged sweep reduced the pair by exactly
 * `amount`: the decrease consumes the pair's OLDEST credits, which is what the
 * sweep did. A reset would be wrong here — it would re-date the surviving
 * credits to the sweep period, so after the first sweep nothing would ever
 * look old enough to sweep again.
 */
export type Restatement =
  | { kind: "reset"; period: number; address: string; reason: string }
  | {
      kind: "consume-oldest";
      period: number;
      address: string;
      token: string;
      amount: bigint;
      reason: string;
    };

function readAmounts(file: string): Map<string, bigint> {
  const data: MerkleData = JSON.parse(fs.readFileSync(file, "utf8"));
  const amounts = new Map<string, bigint>();
  for (const [address, claim] of Object.entries(data.claims ?? {})) {
    for (const [token, { amount }] of Object.entries(claim.tokens ?? {})) {
      const key = pairKey(address, token);
      // Duplicate keys differing only in case would silently overwrite.
      amounts.set(key, (amounts.get(key) ?? 0n) + BigInt(amount));
    }
  }
  return amounts;
}

/**
 * Walk every `bounties-reports/<period>/<relPath>` in period order and turn
 * the cumulative series into dated credits.
 *
 * The first artifact is an opening balance dated at its own period. That
 * under-dates anything the series inherited from an earlier layout, which is
 * safe (younger-looking credits are swept later, never earlier); callers that
 * need exact dates for the early history must extend the series backwards,
 * not adjust the cutoff.
 */
export function buildCreditLedger(
  reportsRoot: string,
  relPath: string,
  restatements: Restatement[] = []
): CreditLedger {
  const periods = fs
    .readdirSync(reportsRoot)
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .filter((p) => fs.existsSync(path.join(reportsRoot, String(p), relPath)))
    .sort((a, b) => a - b);
  if (periods.length === 0) {
    throw new Error(`no artifact found for ${relPath} under ${reportsRoot}`);
  }

  const resets = new Set<string>();
  const consumptions = new Map<string, bigint>();
  for (const r of restatements) {
    if (r.kind === "reset") {
      resets.add(`${r.period}|${getAddress(r.address)}`);
    } else {
      const key = `${r.period}|${pairKey(r.address, r.token)}`;
      consumptions.set(key, (consumptions.get(key) ?? 0n) + r.amount);
    }
  }
  const isReset = (period: number, key: string) =>
    resets.has(`${period}|${key.split("|")[0]}`);

  const credits = new Map<string, Credit[]>();
  let prev = new Map<string, bigint>();
  const violations: string[] = [];

  /** Pop `amount` from the pair's oldest credits; false if they cannot cover it. */
  const consumeOldest = (key: string, amount: bigint): boolean => {
    const list = credits.get(key) ?? [];
    let left = amount;
    while (left > 0n && list.length > 0) {
      const oldest = list[0];
      if (oldest.amount > left) {
        oldest.amount -= left;
        left = 0n;
      } else {
        left -= oldest.amount;
        list.shift();
      }
    }
    if (left > 0n) return false;
    if (list.length === 0) credits.delete(key);
    return true;
  };

  for (const period of periods) {
    const curr = readAmounts(path.join(reportsRoot, String(period), relPath));

    for (const [key, amount] of curr) {
      const before = prev.get(key) ?? 0n;
      if (amount < before) {
        const consumed = consumptions.get(`${period}|${key}`);
        if (isReset(period, key)) {
          // History reset: what survives is an opening balance dated here.
          credits.set(key, [{ period, amount }]);
        } else if (consumed !== undefined && consumed === before - amount) {
          if (!consumeOldest(key, consumed)) {
            violations.push(
              `${key} at ${period}: recorded sweep of ${consumed} exceeds the pair's dated credits`
            );
          }
        } else {
          violations.push(
            `${key} decreased ${before} -> ${amount} at ${period}` +
              (consumed !== undefined
                ? ` (a sweep is recorded there but for ${consumed}, not ${before - amount})`
                : "")
          );
        }
        continue;
      }
      const credit = amount - before;
      if (credit > 0n) {
        const list = credits.get(key) ?? [];
        list.push({ period, amount: credit });
        credits.set(key, list);
      }
    }

    for (const key of prev.keys()) {
      if (curr.has(key)) continue;
      // A zero line dropping out loses nothing — the weekly combine skips
      // zero amounts, so a fully-swept pair vanishes one period later.
      if ((prev.get(key) ?? 0n) === 0n) continue;
      const consumed = consumptions.get(`${period}|${key}`);
      if (isReset(period, key)) {
        credits.delete(key);
      } else if (consumed !== undefined && consumed === prev.get(key)) {
        if (!consumeOldest(key, consumed)) {
          violations.push(
            `${key} at ${period}: recorded sweep of ${consumed} exceeds the pair's dated credits`
          );
        }
      } else {
        violations.push(`${key} vanished at ${period}`);
      }
    }

    prev = curr;
  }

  if (violations.length > 0) {
    throw new Error(
      `the ${relPath} series is not monotone, so differencing cannot date its credits.\n` +
        `Every decrease must be an explicit, explained Restatement — refusing to guess:\n` +
        violations.slice(0, 10).map((v) => `  ${v}`).join("\n") +
        (violations.length > 10 ? `\n  … and ${violations.length - 10} more` : "")
    );
  }

  // The ledger is only trustworthy if it reconstructs the series head exactly,
  // checked over the UNION of keys so a pair missing from either side fails too.
  for (const key of new Set([...credits.keys(), ...prev.keys()])) {
    const sum = (credits.get(key) ?? []).reduce((a, c) => a + c.amount, 0n);
    if (sum !== (prev.get(key) ?? 0n)) {
      throw new Error(
        `ledger self-check failed for ${key}: credits sum ${sum} != latest ${prev.get(key) ?? 0n}`
      );
    }
  }

  return { credits, latest: prev, periods };
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export type SweepPolicy = "fifo" | "gross";

/** The only policies apply may execute — anything else fails closed. */
export const SWEEP_POLICIES: ReadonlySet<string> = new Set(["fifo", "gross"]);

export interface AnnouncementRow {
  address: string;
  token: string;
  /** Which artifact series the credit lives in (e.g. "curve" / "fxn"). */
  series: string;
  period: number;
  date: string;
  amount: string;
}

export interface SweepAnnouncement {
  version: 1;
  /** One distributor's merkle family, e.g. "vlcvx-voters". */
  targetGroup: string;
  /** Who computed the rows — provenance for the policy choice. */
  source: string;
  policy: SweepPolicy;
  announcedAt: string;
  /** The day the sweep may land; the six-month test is evaluated here. */
  effectiveDate: string;
  /** effectiveDate minus AGE_MONTHS — stored so humans can read it, re-derived on apply. */
  cutoff: string;
  /**
   * The committed artifacts the rows were computed against. Set it for
   * provenance-justified ("gross") announcements: apply refuses to run unless
   * these exact roots sit at this period in the committed tree AND the merkle
   * in flight still contains at least those amounts for every announced pair.
   * Without this, a gross announcement applied against bases that never
   * received (or later lost) the source credits would eat the recipients'
   * pre-existing entitlements instead.
   */
  basedOn?: { period: number; roots: { [series: string]: string } };
  rows: AnnouncementRow[];
  totals: { [token: string]: string };
  digest: string;
}

/**
 * Fingerprint of the COMMITMENT: every field that changes what an apply would
 * do — not just the rows. Hashing rows alone would let a published file flip
 * fifo to gross, backdate announcedAt past the notice, or move the effective
 * date, all while still reading as "unchanged".
 */
export function announcementDigest(
  a: Pick<
    SweepAnnouncement,
    "targetGroup" | "source" | "policy" | "announcedAt" | "effectiveDate" | "basedOn"
  > & { rows: AnnouncementRow[] }
): string {
  const basedOn = a.basedOn
    ? `${a.basedOn.period}:` +
      Object.entries(a.basedOn.roots)
        .map(([series, root]) => `${series}=${root}`)
        .sort()
        .join(",")
    : "";
  const header = [a.targetGroup, a.source, a.policy, a.announcedAt, a.effectiveDate, basedOn].join(
    "|"
  );
  const canonical =
    header +
    "\n" +
    a.rows
      .map(
        (r) =>
          `${getAddress(r.address)}|${getAddress(r.token)}|${r.series}|${r.period}|${r.amount}`
      )
      .sort()
      .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function buildAnnouncement(input: {
  targetGroup: string;
  source: string;
  policy: SweepPolicy;
  announcedAt: string;
  effectiveDate: string;
  basedOn?: SweepAnnouncement["basedOn"];
  rows: AnnouncementRow[];
}): SweepAnnouncement {
  if (!SWEEP_POLICIES.has(input.policy)) {
    throw new Error(`unknown sweep policy "${input.policy}" — expected fifo or gross`);
  }
  const announced = parseDay(input.announcedAt);
  const effective = parseDay(input.effectiveDate);
  if (effective - announced < NOTICE_DAYS * 86400) {
    throw new Error(
      `the notice period is mandatory: effective ${input.effectiveDate} is less than ` +
        `${NOTICE_DAYS} days after announcement ${input.announcedAt}`
    );
  }
  const cutoff = minusMonths(effective, AGE_MONTHS);
  for (const row of input.rows) {
    if (row.period >= cutoff) {
      throw new Error(
        `announced row ${row.address}/${row.token} at ${dayOf(row.period)} is not older ` +
          `than ${AGE_MONTHS} months at the effective date (cutoff ${dayOf(cutoff)})`
      );
    }
    if (BigInt(row.amount) <= 0n) {
      throw new Error(`announced row ${row.address}/${row.token} has non-positive amount`);
    }
  }

  const totals = new Map<string, bigint>();
  for (const row of input.rows) {
    const token = getAddress(row.token);
    totals.set(token, (totals.get(token) ?? 0n) + BigInt(row.amount));
  }

  return {
    version: 1,
    targetGroup: input.targetGroup,
    source: input.source,
    policy: input.policy,
    announcedAt: input.announcedAt,
    effectiveDate: input.effectiveDate,
    cutoff: dayOf(cutoff),
    basedOn: input.basedOn,
    rows: input.rows,
    totals: Object.fromEntries([...totals].map(([t, a]) => [t, a.toString()])),
    digest: announcementDigest(input),
  };
}

/**
 * Everything that must hold before an announcement is allowed to reduce
 * anything. All derived fields are RE-COMPUTED rather than trusted: an edited
 * file must not be able to smuggle a shorter notice or a later cutoff.
 */
export function assertAnnouncementApplicable(
  announcement: SweepAnnouncement,
  now: number
): void {
  if (announcement.version !== 1) {
    throw new Error(`unknown announcement version ${announcement.version}`);
  }
  // The file arrives as a JSON cast: an unknown policy must fail closed here,
  // never fall through to the more aggressive branch downstream.
  if (!SWEEP_POLICIES.has(announcement.policy)) {
    throw new Error(
      `announcement ${String(announcement.digest).slice(0, 12)} carries unknown policy ` +
        `"${announcement.policy}" — expected fifo or gross`
    );
  }
  const announced = parseDay(announcement.announcedAt);
  const effective = parseDay(announcement.effectiveDate);
  if (effective - announced < NOTICE_DAYS * 86400) {
    throw new Error(
      `announcement ${announcement.digest.slice(0, 12)} violates the mandatory ` +
        `${NOTICE_DAYS}-day notice (announced ${announcement.announcedAt}, ` +
        `effective ${announcement.effectiveDate})`
    );
  }
  if (now < effective) {
    throw new Error(
      `announcement ${announcement.digest.slice(0, 12)} is not effective until ` +
        `${announcement.effectiveDate}`
    );
  }
  const cutoff = minusMonths(effective, AGE_MONTHS);
  if (announcement.cutoff !== dayOf(cutoff)) {
    throw new Error(
      `announcement cutoff ${announcement.cutoff} does not match its own effective date ` +
        `(${announcement.effectiveDate} - ${AGE_MONTHS} months = ${dayOf(cutoff)})`
    );
  }
  for (const row of announcement.rows) {
    if (row.period >= cutoff) {
      throw new Error(
        `announced row ${row.address}/${row.token} at ${dayOf(row.period)} is younger ` +
          `than the cutoff ${dayOf(cutoff)}`
      );
    }
  }
  if (announcementDigest(announcement) !== announcement.digest) {
    throw new Error(
      `announcement digest mismatch — the announcement was edited after it was made`
    );
  }
}

// ---------------------------------------------------------------------------
// Planning: announced amounts -> reductions, given claimed()
// ---------------------------------------------------------------------------

export interface PlannedPair {
  address: string;
  token: string;
  announced: bigint;
  claimed: bigint;
  cumulative: bigint;
  reduction: bigint;
  /** reduction, allocated oldest-credit-first across the announced rows. */
  bySeries: Map<string, bigint>;
}

/**
 * Turn announcements into per-(address, token) reductions.
 *
 * `cumulative` is the pair's CURRENT in-flight amount summed across the
 * series that make up the distributor's posted merkle — claimed() is measured
 * against that sum, never against a single series. Announcements are applied
 * in the order given, each seeing the cumulative left by the previous one, so
 * two pending sweeps can never take the same wei twice.
 *
 * The reduction is allocated back to concrete series oldest-row-first, which
 * both keeps the split deterministic and matches FIFO's story of which
 * credits are being taken.
 */
export function planReductions(
  announcements: SweepAnnouncement[],
  claimed: Map<string, bigint>,
  cumulative: Map<string, bigint>
): PlannedPair[] {
  const remaining = new Map(cumulative);
  const planned = new Map<string, PlannedPair>();

  for (const announcement of announcements) {
    const rowsByPair = new Map<string, AnnouncementRow[]>();
    for (const row of announcement.rows) {
      const key = pairKey(row.address, row.token);
      const list = rowsByPair.get(key) ?? [];
      list.push(row);
      rowsByPair.set(key, list);
    }

    for (const [key, rows] of rowsByPair) {
      const [address, token] = key.split("|");
      const announced = rows.reduce((a, r) => a + BigInt(r.amount), 0n);
      const c = claimed.get(key) ?? 0n;
      const cum = remaining.get(key);
      if (cum === undefined) {
        throw new Error(
          `${key} is announced for sweeping but absent from the merkle being generated — ` +
            `the announcement targets a different artifact than the one in flight`
        );
      }

      let byPolicy: bigint;
      if (announcement.policy === "fifo") {
        byPolicy = announced > c ? announced - c : 0n;
      } else if (announcement.policy === "gross") {
        byPolicy = announced;
      } else {
        // assertAnnouncementApplicable already refuses these; fail closed
        // anyway rather than ever defaulting to the aggressive branch.
        throw new Error(`unknown sweep policy "${announcement.policy}"`);
      }
      // Whatever the policy claims, the line must never drop below claimed():
      // the distributor pays amount - claimed, and a lower amount reverts.
      const floor = cum > c ? cum - c : 0n;
      const reduction = byPolicy < floor ? byPolicy : floor;

      // Allocation to concrete rows follows each policy's story of what the
      // claims consumed. Under "fifo" the claims ate the OLDEST rows, so the
      // sweep takes each row's post-claim remainder — after an applied sweep
      // no announced credit survives, which is what stops the next wave from
      // re-announcing residue. Under "gross" the claims never touched the
      // announced rows, so the reduction itself is taken oldest-first.
      const sorted = [...rows].sort((a, b) => a.period - b.period);
      const available = new Map<AnnouncementRow, bigint>();
      let claimLeft = announcement.policy === "fifo" ? c : 0n;
      for (const row of sorted) {
        const amount = BigInt(row.amount);
        const eaten = claimLeft < amount ? claimLeft : amount;
        claimLeft -= eaten;
        available.set(row, amount - eaten);
      }

      let left = reduction;
      const bySeries = new Map<string, bigint>();
      for (const row of sorted) {
        if (left === 0n) break;
        const cap = available.get(row)!;
        const take = left < cap ? left : cap;
        if (take === 0n) continue;
        bySeries.set(row.series, (bySeries.get(row.series) ?? 0n) + take);
        left -= take;
      }

      remaining.set(key, cum - reduction);
      const prior = planned.get(key);
      if (prior) {
        // `cumulative` stays as the first announcement saw it: the pair's real
        // pre-sweep line, which is what the applied record must show.
        prior.announced += announced;
        prior.reduction += reduction;
        for (const [series, amount] of bySeries) {
          prior.bySeries.set(series, (prior.bySeries.get(series) ?? 0n) + amount);
        }
      } else {
        planned.set(key, {
          address,
          token,
          announced,
          claimed: c,
          cumulative: cum,
          reduction,
          bySeries,
        });
      }
    }
  }

  return [...planned.values()].filter((p) => p.reduction > 0n);
}

// ---------------------------------------------------------------------------
// Applying reductions to one series' claims
// ---------------------------------------------------------------------------

export interface AppliedSeries {
  /** address -> token -> new amount, zero pairs removed. */
  claims: { [address: string]: { [token: string]: string } };
  /** What the recipient was credited, per token. */
  credited: Map<string, bigint>;
  reduced: { address: string; token: string; before: bigint; after: bigint }[];
}

/**
 * Subtract each pair's reduction for `series` and credit the recipient with
 * the sum, token by token. Conservation is asserted: a sweep moves wei to the
 * recipient, it never mints or burns any.
 *
 * A line swept to nothing is kept at "0", NEVER removed. A removed pair is the
 * verifier's blind spot: PRESERVE_PAIR_REMOVED's deficit is prev − claimed, so
 * a delegator claiming from the still-active old root during the publish
 * window SHRINKS the deficit under the sweep's waiver — a full claim raises no
 * violation at all while the recipient is still credited, double-paying those
 * wei. A zero line instead trips PRESERVE_BELOW_CLAIMED (claimed > 0 = amount),
 * which the sweep never waives, forcing a regeneration that sees the claim.
 * The zero line drops out by itself one period later — the weekly combine
 * skips zero amounts — and losing a zero is violation-free.
 */
export function applyReductionsToSeries(
  claims: { [address: string]: { [token: string]: string } },
  plan: PlannedPair[],
  series: string,
  recipient: string
): AppliedSeries {
  const recipientAddress = getAddress(recipient);
  const next: { [address: string]: { [token: string]: string } } = {};
  const totalsBefore = new Map<string, bigint>();
  for (const [address, tokens] of Object.entries(claims)) {
    const a = getAddress(address);
    next[a] = {};
    for (const [token, amount] of Object.entries(tokens)) {
      const t = getAddress(token);
      next[a][t] = ((BigInt(next[a][t] ?? "0")) + BigInt(amount)).toString();
      totalsBefore.set(t, (totalsBefore.get(t) ?? 0n) + BigInt(amount));
    }
  }

  const credited = new Map<string, bigint>();
  const reduced: AppliedSeries["reduced"] = [];

  for (const pair of plan) {
    const take = pair.bySeries.get(series) ?? 0n;
    if (take === 0n) continue;
    const address = getAddress(pair.address);
    const token = getAddress(pair.token);
    const before = BigInt(next[address]?.[token] ?? "0");
    if (before < take) {
      throw new Error(
        `${address}/${token}: the ${series} series holds ${before} but the plan takes ${take} — ` +
          `the announcement was computed against different artifacts`
      );
    }
    const after = before - take;
    next[address][token] = after.toString();
    credited.set(token, (credited.get(token) ?? 0n) + take);
    reduced.push({ address, token, before, after });
  }

  for (const [token, amount] of credited) {
    if (!next[recipientAddress]) next[recipientAddress] = {};
    next[recipientAddress][token] = (
      BigInt(next[recipientAddress][token] ?? "0") + amount
    ).toString();
  }

  for (const [token, before] of totalsBefore) {
    let after = 0n;
    for (const tokens of Object.values(next)) after += BigInt(tokens[token] ?? "0");
    if (after !== before) {
      throw new Error(
        `conservation broken for ${token}: ${before} before the sweep, ${after} after`
      );
    }
  }

  return { claims: next, credited, reduced };
}
