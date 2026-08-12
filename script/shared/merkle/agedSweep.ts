/**
 * Aged-reward sweep for the vlCVX voters merkle (mainnet).
 *
 * Rewards older than six months may be reclaimed by Stake DAO, subject to a
 * mandatory thirty-day notice so delegators can still claim first. This file
 * wires the generic machinery in ./aging.ts to the concrete vlCVX artifacts:
 *
 *   ANNOUNCE (a human, CLI — never the weekly pipeline):
 *     pnpm tsx script/shared/merkle/agedSweep.ts announce --effective 2026-09-15
 *   writes bounties-reports/aged-sweep/vlcvx-voters/announcement-<date>-generic.json
 *   listing every credit that will be older than six months on the effective
 *   date. The file is committed and reviewed — the same trust model as the
 *   verifier's waivers: the pipeline can consume an announcement, never mint one.
 *
 *   APPLY (the weekly generation, createCombinedMerkle.ts):
 *   DISABLED BY DEFAULT. Runs only when AGED_SWEEP_MODE=apply and
 *   AGED_SWEEP_RECIPIENT are set, and even then only announcements whose
 *   effective date has passed are consumed. It re-reads claimed() on-chain at
 *   apply time — anything claimed during the notice window is left alone —
 *   reduces both per-gauge bases, credits the recipient, records what it did in
 *   bounties-reports/<period>/vlCVX/aged_sweep_applied.json, and emits
 *   quantified verifier waivers to script/verify/invariants/waivers.aged-sweep.json
 *   (one per pair, capped at exactly the applied reduction).
 *
 *   STATUS:
 *     pnpm tsx script/shared/merkle/agedSweep.ts status
 *
 * The Union reassignment (script/vlCVX/union_reassign/) is the particular case
 * of the same protocol: its step 3 emits an announcement in this same format
 * with policy "gross" — justified there because the announced amounts never
 * entered a posted root, so no claim can have consumed them. Both kinds of
 * announcement are applied by the same code path here.
 *
 * The applied record doubles as ledger input for the NEXT sweep: a sweep makes
 * the artifact series non-monotone, and the record is what lets the ledger
 * builder date the decrease as a consumption of the oldest credits instead of
 * refusing the series.
 */

import fs from "fs";
import path from "path";
import { getAddress } from "viem";
import { MerkleData } from "../../interfaces/MerkleData";
import { generateMerkleTree } from "./generateMerkleTree";
import { getClient } from "../../utils/getClients";
import { fetchClaimed } from "../../verify/invariants/preservation";
import { VLCVX_NON_DELEGATORS_MERKLE } from "../../utils/constants";
import {
  AGE_MONTHS,
  AnnouncementRow,
  applyReductionsToSeries,
  assertAnnouncementApplicable,
  buildAnnouncement,
  buildCreditLedger,
  dayOf,
  minusMonths,
  pairKey,
  parseDay,
  PlannedPair,
  planReductions,
  Restatement,
  SweepAnnouncement,
} from "./aging";

export const TARGET_GROUP = "vlcvx-voters";

const REPO = path.resolve(__dirname, "../../..");

// AGED_SWEEP_ROOT is a TEST-ONLY override letting the vitest suite run the
// whole announce/apply lifecycle against a fixture tree. Resolved lazily so a
// test can set it after import; production never sets it.
const reportsRoot = () =>
  process.env.AGED_SWEEP_ROOT
    ? path.join(process.env.AGED_SWEEP_ROOT, "bounties-reports")
    : path.join(REPO, "bounties-reports");
export const announceDir = () => path.join(reportsRoot(), "aged-sweep", TARGET_GROUP);
const waiversFile = () =>
  process.env.AGED_SWEEP_ROOT
    ? path.join(process.env.AGED_SWEEP_ROOT, "waivers.aged-sweep.json")
    : path.join(REPO, "script/verify/invariants/waivers.aged-sweep.json");

/** The per-gauge bases the combined mainnet merkle is derived from. */
const SERIES: { series: "curve" | "fxn"; relPath: string }[] = [
  { series: "curve", relPath: path.join("vlCVX", "curve", "merkle_data_non_delegators.json") },
  { series: "fxn", relPath: path.join("vlCVX", "fxn", "merkle_data_non_delegators.json") },
];

/**
 * Known in-place rewrites of the committed series. Anything not listed here
 * (or recorded by a previous sweep) makes the ledger builder refuse the
 * series, which is the point: an unexplained decrease means the history can
 * no longer be dated by differencing.
 */
const KNOWN_RESTATEMENTS: Restatement[] = [
  {
    kind: "reset",
    period: 1785974400,
    // The Union (Llama Airforce) — ENG-2105 reassigned its accumulated line to
    // its end users in place; the survivors on its own line (dead tokens,
    // deliberately retained) restart as an opening balance at that period.
    address: "0xde1e6a7ed0ad3f61d531a8a78e83ccddbd6e0c49",
    reason: "ENG-2105 Union reassignment rewrote period 1785974400 in place",
  },
];

interface AppliedRecord {
  period: number;
  appliedAt: string;
  recipient: string;
  claimedBlock: string;
  announcements: {
    file: string;
    digest: string;
    source: string;
    policy: string;
    effectiveDate: string;
  }[];
  /** Per-series reductions — exactly the decreases the next ledger build will see. */
  reductions: { address: string; token: string; series: string; amount: string }[];
  /**
   * Per-pair forensics: the claimed() each reduction was computed against.
   * If PRESERVE_BELOW_CLAIMED fires at verify time, the delta against these
   * values shows exactly who claimed inside the publish window.
   */
  pairs: {
    address: string;
    token: string;
    cumulative: string;
    claimed: string;
    announced: string;
    reduction: string;
  }[];
  creditedPerToken: { [token: string]: string };
  waiversFile: string;
}

const appliedRecordPath = (period: number) =>
  path.join(reportsRoot(), String(period), "vlCVX", "aged_sweep_applied.json");

function readAppliedRecords(): { period: number; record: AppliedRecord }[] {
  if (!fs.existsSync(reportsRoot())) return [];
  return fs
    .readdirSync(reportsRoot())
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .sort((a, b) => a - b)
    .filter((p) => fs.existsSync(appliedRecordPath(p)))
    .map((p) => ({
      period: p,
      record: JSON.parse(fs.readFileSync(appliedRecordPath(p), "utf8")) as AppliedRecord,
    }));
}

/**
 * Restatements for building one series' ledger: the known in-place rewrites
 * plus every previous sweep's reductions on that series, EXCLUDING sweeps
 * recorded at `beyondPeriod` or later (when regenerating period P the artifact
 * being diffed no longer contains P's own sweep).
 */
export function restatementsForSeries(
  series: string,
  beyondPeriod = Number.MAX_SAFE_INTEGER
): Restatement[] {
  const fromSweeps: Restatement[] = [];
  for (const { period, record } of readAppliedRecords()) {
    if (period >= beyondPeriod) continue;
    for (const r of record.reductions) {
      if (r.series !== series) continue;
      fromSweeps.push({
        kind: "consume-oldest",
        period,
        address: r.address,
        token: r.token,
        amount: BigInt(r.amount),
        reason: `aged sweep applied at ${period}`,
      });
    }
  }
  return [...KNOWN_RESTATEMENTS, ...fromSweeps];
}

// ---------------------------------------------------------------------------
// Announce
// ---------------------------------------------------------------------------

export function announceGenericSweep(input: {
  effectiveDate: string;
  announcedAt: string;
}): { file: string; announcement: SweepAnnouncement } {
  const cutoff = minusMonths(parseDay(input.effectiveDate), AGE_MONTHS);

  const rows: AnnouncementRow[] = [];
  for (const { series, relPath } of SERIES) {
    const ledger = buildCreditLedger(
      reportsRoot(),
      relPath,
      restatementsForSeries(series)
    );
    for (const [key, credits] of ledger.credits) {
      const [address, token] = key.split("|");
      for (const credit of credits) {
        if (credit.period >= cutoff) continue;
        rows.push({
          address,
          token,
          series,
          period: credit.period,
          date: dayOf(credit.period),
          amount: credit.amount.toString(),
        });
      }
    }
  }
  if (rows.length === 0) {
    throw new Error(
      `nothing is older than ${AGE_MONTHS} months at ${input.effectiveDate} — no announcement written`
    );
  }

  const announcement = buildAnnouncement({
    targetGroup: TARGET_GROUP,
    source: "generic-aging",
    policy: "fifo",
    announcedAt: input.announcedAt,
    effectiveDate: input.effectiveDate,
    rows,
  });

  const file = path.join(
    announceDir(),
    `announcement-${input.effectiveDate}-generic.json`
  );
  writeAnnouncementFile(file, announcement);
  return { file, announcement };
}

/**
 * An announcement is a published commitment: rewriting it in place with
 * different contents would defeat the notice period, so only an identical
 * re-write is allowed. A wrong announcement must be deleted explicitly (and
 * delegators re-notified), never silently replaced.
 */
export function writeAnnouncementFile(file: string, announcement: SweepAnnouncement) {
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, "utf8")) as SweepAnnouncement;
    if (existing.digest !== announcement.digest) {
      throw new Error(
        `${path.relative(REPO, file)} already exists with a different digest — an announcement ` +
          `is a published commitment, it must not be silently replaced. Delete it explicitly ` +
          `(and re-notify) if it was wrong.`
      );
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(announcement, null, 2));
}

// ---------------------------------------------------------------------------
// Apply (the generation hook)
// ---------------------------------------------------------------------------

export interface AgedSweepResult {
  merkleByProtocol: { curve: MerkleData; fxn: MerkleData };
  record: AppliedRecord;
}

function loadAnnouncements(): { file: string; announcement: SweepAnnouncement }[] {
  if (!fs.existsSync(announceDir())) return [];
  return fs
    .readdirSync(announceDir())
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      file: path.join(announceDir(), f),
      announcement: JSON.parse(
        fs.readFileSync(path.join(announceDir(), f), "utf8")
      ) as SweepAnnouncement,
    }))
    .filter(({ announcement }) => announcement.targetGroup === TARGET_GROUP);
}

/**
 * A provenance-bound ("gross") announcement may only be applied while the
 * credits it points at are demonstrably present. Two checks, both against
 * facts the announcement cannot fabricate:
 *
 *   1. the committed artifact at basedOn.period carries EXACTLY the recorded
 *      root — the contribution landed and was never rewritten away;
 *   2. the merkle in flight still holds at least that artifact's amount for
 *      every announced pair — no later regeneration clawed the credits back.
 *
 * Without this, a gross announcement applied against bases that never
 * received the source credits would eat the recipients' own pre-existing
 * entitlements up to the announced amount. Refusal is conservative: if an
 * earlier sweep legitimately reduced an announced pair below its source
 * amount, apply the older announcement first.
 */
function verifyBasedOn(
  file: string,
  announcement: SweepAnnouncement,
  flatByProtocol: { [series: string]: { [address: string]: { [token: string]: string } } }
) {
  const { period, roots } = announcement.basedOn!;
  for (const [series, root] of Object.entries(roots)) {
    const spec = SERIES.find((s) => s.series === series);
    if (!spec) {
      throw new Error(`${path.basename(file)}: basedOn names unknown series "${series}"`);
    }
    const artifactPath = path.join(reportsRoot(), String(period), spec.relPath);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(
        `${path.basename(file)}: basedOn points at ${path.relative(reportsRoot(), artifactPath)} ` +
          `for period ${period}, which is not in the committed tree — the sweep's source ` +
          `state has not been published, refusing to apply`
      );
    }
    const committed: MerkleData = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    if (committed.merkleRoot !== root) {
      throw new Error(
        `${path.basename(file)}: basedOn expects root ${root.slice(0, 14)}… at period ` +
          `${period} (${series}) but the committed artifact has ` +
          `${committed.merkleRoot.slice(0, 14)}… — the source state was replaced, ` +
          `re-derive the announcement`
      );
    }
    const committedFlat = flatClaims(committed);
    for (const row of announcement.rows) {
      if (row.series !== series) continue;
      const address = getAddress(row.address);
      const token = getAddress(row.token);
      const held = BigInt(flatByProtocol[series]?.[address]?.[token] ?? "0");
      const atSource = BigInt(committedFlat[address]?.[token] ?? "0");
      if (held < atSource) {
        throw new Error(
          `${path.basename(file)}: ${address}/${token} holds ${held} in the ${series} ` +
            `merkle in flight but held ${atSource} in the basedOn artifact — the source ` +
            `credits were reduced since, refusing to sweep against a shrunken line`
        );
      }
    }
  }
}

/** The production claimed() reader: one multicall batch pinned at the head block. */
async function readClaimedOnChain(
  pairs: [string, string][]
): Promise<{ block: string; claimed: Map<string, bigint> }> {
  const client = await getClient(1);
  const pinnedBlock = await client.getBlockNumber();
  const claimed = await fetchClaimed(
    client as any,
    {
      target: "voters" as any,
      chainId: 1,
      distributor: getAddress(VLCVX_NON_DELEGATORS_MERKLE),
      pinnedBlock,
    },
    pairs
  );
  return { block: pinnedBlock.toString(), claimed };
}

const flatClaims = (merkle: MerkleData) => {
  const flat: { [address: string]: { [token: string]: string } } = {};
  for (const [address, claim] of Object.entries(merkle.claims ?? {})) {
    const a = getAddress(address);
    flat[a] = flat[a] ?? {};
    for (const [token, { amount }] of Object.entries(claim.tokens ?? {})) {
      const t = getAddress(token);
      flat[a][t] = (BigInt(flat[a][t] ?? "0") + BigInt(amount)).toString();
    }
  }
  return flat;
};

/**
 * The hook createCombinedMerkle calls between generating the per-gauge bases
 * and deriving the combined merkle. INERT unless AGED_SWEEP_MODE=apply: it
 * returns null without touching the filesystem or the network, so the weekly
 * pipeline is unchanged while the mechanism is deactivated.
 *
 * When active it consumes every announcement whose effective date has passed,
 * "gross" announcements before "fifo" ones (a gross announcement carries a
 * provenance argument that its amounts were never claimable; it should see
 * the line before a fifo sweep shrinks it).
 */
export async function maybeApplyAgedSweep(input: {
  curve: MerkleData;
  fxn: MerkleData;
  period: number;
  /** Unix seconds "now" — injectable for tests; defaults to wall clock. */
  now?: number;
  /** claimed() reader — injectable for tests; defaults to on-chain multicall. */
  readClaimed?: (
    pairs: [string, string][]
  ) => Promise<{ block: string; claimed: Map<string, bigint> }>;
}): Promise<AgedSweepResult | null> {
  const mode = process.env.AGED_SWEEP_MODE ?? "off";
  if (mode === "off") return null;
  if (mode !== "apply") {
    throw new Error(
      `AGED_SWEEP_MODE must be unset, "off" or "apply", got "${mode}" — ` +
        `announcements are written by the CLI ("announce"), never by generation`
    );
  }
  const recipient = process.env.AGED_SWEEP_RECIPIENT;
  if (!recipient) {
    throw new Error(
      "AGED_SWEEP_MODE=apply needs AGED_SWEEP_RECIPIENT (the address swept rewards are assigned to)"
    );
  }
  const recipientAddress = getAddress(recipient);
  const now = input.now ?? Math.floor(Date.now() / 1000);

  const all = loadAnnouncements();
  if (all.length === 0) {
    console.log("aged sweep: apply mode is on but there is no announcement — nothing to do");
    return null;
  }

  const appliedDigests = new Map<string, number>();
  for (const { period, record } of readAppliedRecords()) {
    for (const a of record.announcements) appliedDigests.set(a.digest, period);
  }

  const effective: { file: string; announcement: SweepAnnouncement }[] = [];
  for (const entry of all) {
    const digest = entry.announcement.digest;
    const appliedAt = appliedDigests.get(digest);
    if (appliedAt !== undefined && appliedAt !== input.period) {
      if (appliedAt > input.period) {
        throw new Error(
          `announcement ${digest.slice(0, 12)} is recorded as applied at FUTURE period ` +
            `${appliedAt} while generating ${input.period} — refusing to double-apply`
        );
      }
      console.log(
        `aged sweep: ${path.basename(entry.file)} already applied at ${appliedAt} — skipped`
      );
      continue;
    }
    if (now < parseDay(entry.announcement.effectiveDate)) {
      console.log(
        `aged sweep: ${path.basename(entry.file)} not effective until ` +
          `${entry.announcement.effectiveDate} — skipped`
      );
      continue;
    }
    assertAnnouncementApplicable(entry.announcement, now);
    effective.push(entry);
  }
  if (effective.length === 0) {
    console.log("aged sweep: no announcement is effective yet — nothing applied");
    return null;
  }
  effective.sort((a, b) =>
    a.announcement.policy !== b.announcement.policy
      ? a.announcement.policy === "gross"
        ? -1
        : 1
      : a.announcement.digest < b.announcement.digest
        ? -1
        : 1
  );

  // claimed() is measured against the COMBINED line — the distributor knows
  // one cumulative per (address, token), not the per-gauge split.
  const flatByProtocol = {
    curve: flatClaims(input.curve),
    fxn: flatClaims(input.fxn),
  };
  const cumulative = new Map<string, bigint>();
  for (const flat of Object.values(flatByProtocol)) {
    for (const [address, tokens] of Object.entries(flat)) {
      for (const [token, amount] of Object.entries(tokens)) {
        const key = pairKey(address, token);
        cumulative.set(key, (cumulative.get(key) ?? 0n) + BigInt(amount));
      }
    }
  }

  // Rows naming a series this target does not apply would be planned but
  // never executed: the announcement would be recorded as applied while both
  // bases stayed untouched. Refuse them outright.
  const knownSeries = new Set<string>(SERIES.map((s) => s.series));
  for (const { file, announcement } of effective) {
    for (const row of announcement.rows) {
      if (!knownSeries.has(row.series)) {
        throw new Error(
          `${path.basename(file)}: row ${row.address}/${row.token} names series ` +
            `"${row.series}", which ${TARGET_GROUP} does not apply — refusing to ` +
            `record a sweep that would silently skip it`
        );
      }
    }
    if (announcement.basedOn) {
      verifyBasedOn(file, announcement, flatByProtocol);
    }
  }

  const announcedPairs = new Map<string, [string, string]>();
  for (const { announcement } of effective) {
    for (const row of announcement.rows) {
      const key = pairKey(row.address, row.token);
      announcedPairs.set(key, [getAddress(row.address), getAddress(row.token)]);
    }
  }
  // A pair announced but no longer in the merkle was emptied by an earlier
  // sweep or claim-out; there is nothing left to take from it.
  let absent = 0;
  for (const key of announcedPairs.keys()) {
    if (!cumulative.has(key)) {
      cumulative.set(key, 0n);
      absent++;
    }
  }
  if (absent > 0) {
    console.log(`aged sweep: ${absent} announced pair(s) no longer hold a line — they yield 0`);
  }

  const pairs = [...announcedPairs.values()];
  console.log(`aged sweep: reading claimed() for ${pairs.length} pairs…`);
  const readClaimed = input.readClaimed ?? readClaimedOnChain;
  const { block: pinnedBlock, claimed: claimedRaw } = await readClaimed(pairs);
  console.log(`aged sweep: claimed() pinned at block ${pinnedBlock}`);
  const claimed = new Map<string, bigint>();
  for (const [address, token] of pairs) {
    claimed.set(pairKey(address, token), claimedRaw.get(`${address}:${token}`) ?? 0n);
  }

  const plan = planReductions(
    effective.map((e) => e.announcement),
    claimed,
    cumulative
  ).filter((p) => getAddress(p.address) !== recipientAddress);

  if (plan.length === 0) {
    console.log("aged sweep: every announced line is already claimed or empty — nothing applied");
    return null;
  }

  const applied: { [K in "curve" | "fxn"]: ReturnType<typeof applyReductionsToSeries> } = {
    curve: applyReductionsToSeries(flatByProtocol.curve, plan, "curve", recipientAddress),
    fxn: applyReductionsToSeries(flatByProtocol.fxn, plan, "fxn", recipientAddress),
  };

  const creditedPerToken = new Map<string, bigint>();
  const reductions: AppliedRecord["reductions"] = [];
  const appliedPerPair = new Map<string, bigint>();
  for (const series of ["curve", "fxn"] as const) {
    for (const { address, token, before, after } of applied[series].reduced) {
      reductions.push({ address, token, series, amount: (before - after).toString() });
      const key = pairKey(address, token);
      appliedPerPair.set(key, (appliedPerPair.get(key) ?? 0n) + (before - after));
    }
    for (const [token, amount] of applied[series].credited) {
      creditedPerToken.set(token, (creditedPerToken.get(token) ?? 0n) + amount);
    }
  }
  // Everything the plan reduced must have landed in a series application —
  // the record and the waivers below describe what HAPPENED, never the plan.
  for (const p of plan) {
    const got = appliedPerPair.get(pairKey(p.address, p.token)) ?? 0n;
    if (got !== p.reduction) {
      throw new Error(
        `${p.address}/${p.token}: planned reduction ${p.reduction} but the series ` +
          `applications took ${got} — refusing to record a sweep that did not happen`
      );
    }
  }

  const record: AppliedRecord = {
    period: input.period,
    appliedAt: new Date(now * 1000).toISOString(),
    recipient: recipientAddress,
    claimedBlock: pinnedBlock,
    announcements: effective.map(({ file, announcement }) => ({
      file: path.relative(REPO, file),
      digest: announcement.digest,
      source: announcement.source,
      policy: announcement.policy,
      effectiveDate: announcement.effectiveDate,
    })),
    reductions,
    pairs: plan.map((p) => ({
      address: getAddress(p.address),
      token: getAddress(p.token),
      cumulative: p.cumulative.toString(),
      claimed: p.claimed.toString(),
      announced: p.announced.toString(),
      reduction: p.reduction.toString(),
    })),
    creditedPerToken: Object.fromEntries(
      [...creditedPerToken].map(([t, a]) => [t, a.toString()])
    ),
    waiversFile: path.relative(REPO, waiversFile()),
  };
  fs.mkdirSync(path.dirname(appliedRecordPath(input.period)), { recursive: true });
  fs.writeFileSync(appliedRecordPath(input.period), JSON.stringify(record, null, 2));

  writeWaivers(plan, effective, input.period, now);

  console.log(
    `aged sweep: reduced ${plan.length} pair(s) across ${effective.length} announcement(s); ` +
      `recipient ${recipientAddress} credited on ${creditedPerToken.size} token(s)`
  );

  return {
    merkleByProtocol: {
      curve: generateMerkleTree(applied.curve.claims),
      fxn: generateMerkleTree(applied.fxn.claims),
    },
    record,
  };
}

/**
 * Quantified verifier waivers, one per swept pair, capped at exactly the
 * applied reduction — all PRESERVE_AMOUNT_REDUCED, because a sweep never
 * removes a pair: a fully-swept line is kept at "0" precisely so that a claim
 * made from the still-active old root during the publish window trips
 * PRESERVE_BELOW_CLAIMED, which is never waived. (A removed pair would be the
 * blind spot — its removal deficit SHRINKS as the user claims, so a full
 * claim inside the window would pass verification while double-paying.)
 */
function writeWaivers(
  plan: PlannedPair[],
  effective: { file: string; announcement: SweepAnnouncement }[],
  period: number,
  now: number
) {
  const digests = effective.map((e) => e.announcement.digest.slice(0, 12)).join(", ");
  const waivers = plan.map((p) => ({
    invariant: "PRESERVE_AMOUNT_REDUCED",
    chainId: 1,
    target: "voters" as const,
    account: getAddress(p.address),
    token: getAddress(p.token),
    maxDeficit: p.reduction.toString(),
    reason:
      `>${AGE_MONTHS}-month aged sweep applied at period ${period} ` +
      `(announcements ${digests}); see bounties-reports/${period}/vlCVX/aged_sweep_applied.json`,
    addedBy: "agedSweep apply",
    addedAt: dayOf(now),
  }));
  fs.writeFileSync(waiversFile(), JSON.stringify(waivers, null, 2));
  console.log(
    `aged sweep: wrote ${waivers.length} waiver(s) to ${path.relative(REPO, waiversFile())} — ` +
      `commit them with the merkle, remove them once the root is accepted`
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function cliArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function cli() {
  const command = process.argv[2];
  const today = new Date().toISOString().slice(0, 10);

  if (command === "announce") {
    const effectiveDate = cliArg("effective");
    if (!effectiveDate) {
      throw new Error(
        "pass --effective YYYY-MM-DD (at least 30 days out — the notice period is mandatory)"
      );
    }
    const { file, announcement } = announceGenericSweep({
      effectiveDate,
      announcedAt: cliArg("announced-at") ?? today,
    });
    console.log(`announced ${announcement.rows.length} aged credit(s), digest ${announcement.digest.slice(0, 16)}…`);
    console.log(`cutoff    credits dated before ${announcement.cutoff} (effective ${announcement.effectiveDate})`);
    for (const [token, total] of Object.entries(announcement.totals)) {
      console.log(`  ${token}  ${total}`);
    }
    console.log(`\nwrote ${path.relative(REPO, file)}`);
    console.log("commit and publish it — the sweep may only be applied after the effective date.");
    return;
  }

  if (command === "status") {
    const nowTs = Math.floor(Date.now() / 1000);
    const appliedDigests = new Map<string, number>();
    for (const { period, record } of readAppliedRecords()) {
      for (const a of record.announcements) appliedDigests.set(a.digest, period);
    }
    const all = loadAnnouncements();
    if (all.length === 0) {
      console.log(`no announcements under ${path.relative(REPO, announceDir())}`);
      return;
    }
    for (const { file, announcement } of all) {
      const appliedAt = appliedDigests.get(announcement.digest);
      const state =
        appliedAt !== undefined
          ? `APPLIED at period ${appliedAt}`
          : nowTs >= parseDay(announcement.effectiveDate)
            ? "EFFECTIVE — will be consumed by the next apply"
            : `pending until ${announcement.effectiveDate}`;
      console.log(
        `${path.basename(file)}\n  source ${announcement.source}  policy ${announcement.policy}  ` +
          `rows ${announcement.rows.length}  digest ${announcement.digest.slice(0, 12)}…\n  ${state}`
      );
    }
    return;
  }

  throw new Error(
    "usage: agedSweep.ts announce --effective YYYY-MM-DD [--announced-at YYYY-MM-DD] | agedSweep.ts status"
  );
}

if (require.main === module) {
  cli().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
