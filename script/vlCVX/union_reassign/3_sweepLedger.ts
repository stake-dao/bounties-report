/**
 * Exactly how much of each delegator's share is older than six months.
 *
 *   pnpm tsx script/vlCVX/union_reassign/3_sweepLedger.ts --effective 2026-09-11
 *
 * A sweep may only recover rewards older than six months, so it cannot work from
 * the cumulative split: that says what each address is owed in total, not which
 * dated round each wei came from. This walks the per-round breakdown
 * 1_computeUnionMerkle.ts writes and splits every (address, token) into the part
 * a sweep may take and the part it may not touch.
 *
 * `--effective` is the date the sweep BECOMES EFFECTIVE, not the date it is
 * started: the thirty-day notice period is mandatory, so the six-month test
 * lands at the end of it. The cutoff is that date minus six months; rounds dated
 * strictly before the cutoff are sweepable.
 *
 * Outputs, both under out/ and gitignored:
 *   sweep_ledger.json  per (address, token): total / sweepable / keep + rounds
 *   sweep_ledger.csv   the same, one row per (address, token), for ops
 *
 * On sweep day the recovery per (address, token) is NOT simply `sweepable`. Two
 * things stand in the way, and both are in the output:
 *
 *   1. The cumulative in the posted merkle is the address's OWN prior
 *      entitlement plus the Union share. Only the Union-derived sweepable part
 *      is in scope; reducing to the kept part alone would delete that prior
 *      amount (725 rows carry one, the largest 7,081 CRV against a Union share
 *      of 169).
 *   2. The distributor pays `amount - claimed`, so an address that already
 *      claimed has been paid and there is nothing left to take back.
 *
 *     newCumulative = max(claimed(address, token), cumulative - sweepable)
 *     recovered     = cumulative - newCumulative
 *
 * Pass --check-claimed to read claimed() on-chain and have those two columns
 * computed for real; without it the ledger reports the ceiling (claimed == 0).
 */

import fs from "fs";
import path from "path";
import { getAddress } from "viem";
import { getClient } from "../../utils/getClients";
import { fetchClaimed } from "../../verify/invariants/preservation";
import { VLCVX_NON_DELEGATORS_MERKLE } from "../../utils/constants";
import { REPO } from "./shared";

const OUT = path.join(__dirname, "out");
const AGE_MONTHS = 6;
const BREAKDOWN = path.join(OUT, "round_breakdown.json");
// The merkle the sweep will actually be applied to. Needed because a recipient's
// cumulative is prior + unionShare, and only the Union-derived part is in scope.
const POSTED = path.join(OUT, "vlcvx_merkle.json");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

/**
 * `YYYY-MM-DD` -> unix seconds at 00:00 UTC.
 *
 * Round-tripped, because Date.UTC silently NORMALISES an impossible date:
 * "2026-09-31" becomes 1 October and still returns a finite timestamp, so the
 * sweep would run against a different day than the one it printed.
 */
function parseDay(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) throw new Error(`--effective must be YYYY-MM-DD, got "${text}"`);
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

/**
 * N calendar months back, clamped to the target month's last day.
 *
 * Calendar months rather than 30*N days so the cutoff cannot drift, and
 * clamped because Date.UTC rolls a non-existent day into the NEXT month: six
 * months before 31 October would land on 1 May instead of 30 April, moving the
 * cutoff LATER and making a 30 April round look sweepable when it is not yet.
 */
function minusMonths(ts: number, months: number): number {
  const d = new Date(ts * 1000);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() - months;
  // Day 0 of the following month is the last day of the target month.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay)) / 1000;
}

type RoundSlice = { date: string; period: number; protocol: string; amount: bigint };

type Cell = {
  total: bigint;
  sweepable: bigint;
  keep: bigint;
  sweepRounds: RoundSlice[];
  keepRounds: RoundSlice[];
};

async function main() {
  if (!fs.existsSync(BREAKDOWN)) {
    throw new Error(
      `missing ${path.relative(REPO, BREAKDOWN)} — run 1_computeUnionMerkle.ts first`
    );
  }
  const effectiveText = arg("effective");
  if (!effectiveText) {
    throw new Error(
      "pass --effective YYYY-MM-DD: the date the sweep becomes effective, i.e. the end of the " +
        "mandatory thirty-day notice period. The six-month cutoff is derived from it."
    );
  }
  const effective = parseDay(effectiveText);
  const cutoff = minusMonths(effective, AGE_MONTHS);
  const cutoffText = new Date(cutoff * 1000).toISOString().slice(0, 10);

  if (!fs.existsSync(POSTED)) {
    throw new Error(
      `missing ${path.relative(REPO, POSTED)} — run 2_mergeIntoLatestMerkle.ts first. The sweep ` +
        `reduces cumulative amounts in THAT merkle, and a recipient's cumulative is their prior ` +
        `entitlement plus the Union share, so the Union share alone is not enough to compute it.`
    );
  }
  const postedMerkle = JSON.parse(fs.readFileSync(POSTED, "utf8"));
  const posted = new Map<string, bigint>();
  for (const [address, claim] of Object.entries<any>(postedMerkle.claims)) {
    for (const [token, { amount }] of Object.entries<any>(claim.tokens)) {
      posted.set(`${getAddress(address)}|${getAddress(token)}`, BigInt(amount));
    }
  }

  const data = JSON.parse(fs.readFileSync(BREAKDOWN, "utf8"));
  console.log(`breakdown  ${data.rounds.length} rounds, digest ${data.meta.roundsDigest.slice(0, 16)}…`);
  console.log(`posted     ${path.relative(REPO, POSTED)} root ${postedMerkle.merkleRoot.slice(0, 14)}…`);
  console.log(`effective  ${effectiveText}  ->  sweepable if the round is dated before ${cutoffText}`);

  // (address, token) -> split
  const cells = new Map<string, Cell>();
  let sweepRoundCount = 0;
  for (const round of data.rounds) {
    const sweepable = round.period < cutoff;
    if (sweepable) sweepRoundCount++;
    for (const [address, tokens] of Object.entries<Record<string, string>>(round.perUser)) {
      for (const [token, amount] of Object.entries(tokens)) {
        const key = `${getAddress(address)}|${getAddress(token)}`;
        const cell =
          cells.get(key) ??
          { total: 0n, sweepable: 0n, keep: 0n, sweepRounds: [], keepRounds: [] };
        const value = BigInt(amount);
        const slice = {
          date: round.date,
          period: round.period,
          protocol: round.protocol,
          amount: value,
        };
        cell.total += value;
        if (sweepable) {
          cell.sweepable += value;
          cell.sweepRounds.push(slice);
        } else {
          cell.keep += value;
          cell.keepRounds.push(slice);
        }
        cells.set(key, cell);
      }
    }
  }
  console.log(`rounds     ${sweepRoundCount} sweepable, ${data.rounds.length - sweepRoundCount} protected`);

  // ---- optional: what is actually recoverable after on-chain claims ---------
  let claimed: Map<string, bigint> | undefined;
  if (has("check-claimed")) {
    const pairs: [string, string][] = [...cells.keys()].map((k) => {
      const [a, t] = k.split("|");
      return [a, t];
    });
    console.log(`claimed    reading claimed() for ${pairs.length} pairs…`);
    const client = await getClient(1);
    const block = await client.getBlockNumber();
    claimed = await fetchClaimed(
      client as any,
      {
        target: "voters" as any,
        chainId: 1,
        distributor: getAddress(VLCVX_NON_DELEGATORS_MERKLE),
        pinnedBlock: block,
      },
      pairs
    );
    console.log(`           pinned at block ${block}`);
  }

  // ---- write ---------------------------------------------------------------
  const rows = [...cells.entries()]
    .map(([key, cell]) => {
      const [address, token] = key.split("|");
      const already = claimed?.get(`${address}:${token}`) ?? 0n;
      const cumulative = posted.get(key);
      if (cumulative === undefined) {
        throw new Error(
          `${address} / ${token} is in the split but absent from ` +
            `${path.relative(REPO, POSTED)} — the ledger and the merkle disagree`
        );
      }
      // The posted cumulative is prior + unionShare. Only the Union-derived
      // sweepable part may be reduced; the address's own prior entitlement is
      // untouchable. Reducing to `keep` alone would delete that prior amount —
      // 725 of these rows carry one, the largest 7,081 CRV against a Union
      // share of 169 — and could even report a negative recovery.
      const priorEntitlement = cumulative - cell.total;
      if (priorEntitlement < 0n) {
        throw new Error(
          `${address} / ${token}: posted cumulative ${cumulative} is below the Union share ` +
            `${cell.total} — the ledger does not match the merkle it will be applied to`
        );
      }
      const floor = cumulative - cell.sweepable;
      const newCumulative = already > floor ? already : floor;
      return {
        address,
        token,
        cumulative,
        priorEntitlement,
        total: cell.total,
        sweepable: cell.sweepable,
        keep: cell.keep,
        claimed: claimed ? already : undefined,
        newCumulative,
        recovered: cumulative - newCumulative,
        sweepRounds: cell.sweepRounds,
        keepRounds: cell.keepRounds,
      };
    })
    .sort((a, b) =>
      a.address === b.address ? (a.token < b.token ? -1 : 1) : a.address < b.address ? -1 : 1
    );

  fs.mkdirSync(OUT, { recursive: true });
  const jsonFile = path.join(OUT, "sweep_ledger.json");
  fs.writeFileSync(
    jsonFile,
    JSON.stringify(
      {
        meta: {
          union: data.meta.union,
          sourcePeriod: data.meta.sourcePeriod,
          roundsDigest: data.meta.roundsDigest,
          effectiveDate: effectiveText,
          sixMonthCutoff: cutoffText,
          claimedCheckedOnChain: Boolean(claimed),
          rows: rows.length,
          recipients: new Set(rows.map((r) => r.address)).size,
        },
        rows: rows.map((r) => ({
          ...r,
          cumulative: r.cumulative.toString(),
          priorEntitlement: r.priorEntitlement.toString(),
          total: r.total.toString(),
          sweepable: r.sweepable.toString(),
          keep: r.keep.toString(),
          claimed: r.claimed?.toString(),
          newCumulative: r.newCumulative.toString(),
          recovered: r.recovered.toString(),
          sweepRounds: r.sweepRounds.map((x) => ({ ...x, amount: x.amount.toString() })),
          keepRounds: r.keepRounds.map((x) => ({ ...x, amount: x.amount.toString() })),
        })),
      },
      null,
      2
    )
  );

  const csvFile = path.join(OUT, "sweep_ledger.csv");
  const csv = [
    "address;token;cumulative_wei;prior_entitlement_wei;union_share_wei;sweepable_wei;keep_wei;" +
      (claimed ? "claimed_wei;" : "") +
      "new_cumulative_wei;recovered_wei;sweepable_round_dates;kept_round_dates",
    ...rows.map((r) =>
      [
        r.address,
        r.token,
        r.cumulative,
        r.priorEntitlement,
        r.total,
        r.sweepable,
        r.keep,
        ...(claimed ? [r.claimed] : []),
        r.newCumulative,
        r.recovered,
        r.sweepRounds.map((x) => x.date).join("|"),
        r.keepRounds.map((x) => x.date).join("|"),
      ].join(";")
    ),
  ].join("\n");
  // Trailing newline: some CSV readers drop or mangle a final unterminated row.
  fs.writeFileSync(csvFile, csv + "\n");

  // ---- summary -------------------------------------------------------------
  const perToken = new Map<string, { total: bigint; sweepable: bigint; keep: bigint }>();
  for (const r of rows) {
    const t = perToken.get(r.token) ?? { total: 0n, sweepable: 0n, keep: 0n };
    t.total += r.total;
    t.sweepable += r.sweepable;
    t.keep += r.keep;
    perToken.set(r.token, t);
  }

  const fullySweepable = rows.filter((r) => r.keep === 0n).length;
  const untouched = rows.filter((r) => r.sweepable === 0n).length;
  const partial = rows.length - fullySweepable - untouched;
  const addrAllSweepable = new Set(rows.filter((r) => r.keep === 0n).map((r) => r.address));
  const addrAnyKeep = new Set(rows.filter((r) => r.keep > 0n).map((r) => r.address));
  for (const a of addrAnyKeep) addrAllSweepable.delete(a);

  console.log(`\nwrote ${path.relative(REPO, jsonFile)}`);
  console.log(`      ${path.relative(REPO, csvFile)}`);
  console.log(`\n(address, token) rows   ${rows.length}`);
  console.log(`  fully sweepable       ${fullySweepable}`);
  console.log(`  partly sweepable      ${partial}`);
  console.log(`  untouchable (<6mo)    ${untouched}`);
  console.log(`\nrecipients              ${new Set(rows.map((r) => r.address)).size}`);
  console.log(`  lose everything       ${addrAllSweepable.size}`);
  console.log(`  keep something        ${addrAnyKeep.size}`);

  console.log(`\nper token (wei):`);
  for (const [token, t] of [...perToken].sort(([, a], [, b]) => (b.sweepable > a.sweepable ? 1 : -1))) {
    console.log(
      `  ${token}\n    total ${t.total}\n    sweep ${t.sweepable}\n    keep  ${t.keep}`
    );
  }

  if (!claimed) {
    console.log(
      `\nNOTE: claimed() was not read, so recovered_wei is the CEILING (assumes nobody claimed).\n` +
        `      Re-run with --check-claimed on sweep day for the real figure.`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
