import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getAddress } from "viem";
import {
  AGE_MONTHS,
  NOTICE_DAYS,
  announcementDigest,
  applyReductionsToSeries,
  assertAnnouncementApplicable,
  buildAnnouncement,
  buildCreditLedger,
  dayOf,
  minusMonths,
  pairKey,
  parseDay,
  planReductions,
  Restatement,
  SweepAnnouncement,
} from "../../shared/merkle/aging";
import {
  announceGenericSweep,
  maybeApplyAgedSweep,
  restatementsForSeries,
} from "../../shared/merkle/agedSweep";

const A1 = getAddress("0x" + "11".repeat(20));
const A2 = getAddress("0x" + "22".repeat(20));
const RECIPIENT = getAddress("0x" + "99".repeat(20));
const CRV = getAddress("0x" + "aa".repeat(20));
const FXS = getAddress("0x" + "bb".repeat(20));

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

describe("parseDay", () => {
  it("parses a valid day to 00:00 UTC", () => {
    expect(parseDay("2026-09-11")).toBe(Date.UTC(2026, 8, 11) / 1000);
  });

  it("rejects days Date.UTC would silently normalise", () => {
    expect(() => parseDay("2026-09-31")).toThrow(/not a real calendar date/);
    expect(() => parseDay("2026-13-01")).toThrow();
    expect(() => parseDay("2027-02-29")).toThrow(/not a real calendar date/);
  });

  it("rejects non-dates", () => {
    expect(() => parseDay("soon")).toThrow(/YYYY-MM-DD/);
  });
});

describe("minusMonths", () => {
  const day = (text: string) => parseDay(text);

  it("goes back six plain months", () => {
    expect(dayOf(minusMonths(day("2026-09-11"), 6))).toBe("2026-03-11");
  });

  it("clamps to the target month's last day instead of rolling forward", () => {
    // Six months before 31 October is 30 April, NOT 1 May — rolling forward
    // would move the cutoff later and sweep a 30 April credit too early.
    expect(dayOf(minusMonths(day("2026-10-31"), 6))).toBe("2026-04-30");
  });

  it("handles leap years", () => {
    expect(dayOf(minusMonths(day("2028-08-31"), 6))).toBe("2028-02-29");
  });
});

// ---------------------------------------------------------------------------
// Credit ledger
// ---------------------------------------------------------------------------

describe("buildCreditLedger", () => {
  let root: string;
  const REL = path.join("x", "merkle.json");

  const write = (period: number, amounts: { [addr: string]: { [token: string]: bigint } }) => {
    const claims: any = {};
    for (const [address, tokens] of Object.entries(amounts)) {
      claims[address] = { tokens: {} };
      for (const [token, amount] of Object.entries(tokens)) {
        claims[address].tokens[token] = { amount: amount.toString(), proof: [] };
      }
    }
    const dir = path.join(root, String(period), "x");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "merkle.json"), JSON.stringify({ merkleRoot: "", claims }));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aged-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("dates credits by differencing, across gaps and new pairs", () => {
    write(1000, { [A1]: { [CRV]: 100n } });
    // no artifact at 2000 — a skipped week
    write(3000, { [A1]: { [CRV]: 150n }, [A2]: { [CRV]: 40n } });
    write(4000, { [A1]: { [CRV]: 150n }, [A2]: { [CRV]: 90n } });

    const ledger = buildCreditLedger(root, REL);
    expect(ledger.periods).toEqual([1000, 3000, 4000]);
    expect(ledger.credits.get(pairKey(A1, CRV))).toEqual([
      { period: 1000, amount: 100n },
      { period: 3000, amount: 50n },
    ]);
    expect(ledger.credits.get(pairKey(A2, CRV))).toEqual([
      { period: 3000, amount: 40n },
      { period: 4000, amount: 50n },
    ]);
    expect(ledger.latest.get(pairKey(A1, CRV))).toBe(150n);
  });

  it("refuses an unexplained decrease", () => {
    write(1000, { [A1]: { [CRV]: 100n } });
    write(2000, { [A1]: { [CRV]: 60n } });
    expect(() => buildCreditLedger(root, REL)).toThrow(/not monotone/);
  });

  it("refuses an unexplained vanished pair", () => {
    write(1000, { [A1]: { [CRV]: 100n } });
    write(2000, { [A2]: { [CRV]: 100n } });
    expect(() => buildCreditLedger(root, REL)).toThrow(/vanished/);
  });

  it("a reset restatement restarts the pair as an opening balance", () => {
    write(1000, { [A1]: { [CRV]: 100n } });
    write(2000, { [A1]: { [CRV]: 30n } });
    const restatements: Restatement[] = [
      { kind: "reset", period: 2000, address: A1, reason: "rewritten in place" },
    ];
    const ledger = buildCreditLedger(root, REL, restatements);
    // The survivor is dated at the reset period: younger-looking, never older.
    expect(ledger.credits.get(pairKey(A1, CRV))).toEqual([{ period: 2000, amount: 30n }]);
  });

  it("a consume-oldest restatement pops the oldest credits, keeping later dates", () => {
    write(1000, { [A1]: { [CRV]: 100n } });
    write(2000, { [A1]: { [CRV]: 160n } });
    write(3000, { [A1]: { [CRV]: 40n } }); // a sweep took 120
    const restatements: Restatement[] = [
      {
        kind: "consume-oldest",
        period: 3000,
        address: A1,
        token: CRV,
        amount: 120n,
        reason: "sweep",
      },
    ];
    const ledger = buildCreditLedger(root, REL, restatements);
    // 100 @1000 fully consumed, 20 of the 60 @2000 consumed — the remaining 40
    // stays dated at 2000, NOT re-dated to the sweep period.
    expect(ledger.credits.get(pairKey(A1, CRV))).toEqual([{ period: 2000, amount: 40n }]);
  });

  it("a consume-oldest restatement must match the decrease exactly", () => {
    write(1000, { [A1]: { [CRV]: 100n } });
    write(2000, { [A1]: { [CRV]: 40n } });
    const restatements: Restatement[] = [
      {
        kind: "consume-oldest",
        period: 2000,
        address: A1,
        token: CRV,
        amount: 50n, // the artifact decreased by 60
        reason: "sweep",
      },
    ];
    expect(() => buildCreditLedger(root, REL, restatements)).toThrow(/for 50, not 60/);
  });
});

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

const row = (over: Partial<SweepAnnouncement["rows"][0]> = {}) => ({
  address: A1,
  token: CRV,
  series: "curve",
  period: parseDay("2026-01-08"),
  date: "2026-01-08",
  amount: "100",
  ...over,
});

const validInput = () => ({
  targetGroup: "vlcvx-voters",
  source: "generic-aging",
  policy: "fifo" as const,
  announcedAt: "2026-08-12",
  effectiveDate: "2026-09-15",
  rows: [row()],
});

describe("announcements", () => {
  it("builds with a derived cutoff and an order-independent digest", () => {
    const a = buildAnnouncement(validInput());
    expect(a.cutoff).toBe("2026-03-15");
    expect(a.totals[CRV]).toBe("100");
    const shuffled = buildAnnouncement({
      ...validInput(),
      rows: [row({ period: parseDay("2026-01-01"), date: "2026-01-01", amount: "1" }), row()],
    });
    const reordered = buildAnnouncement({
      ...validInput(),
      rows: [row(), row({ period: parseDay("2026-01-01"), date: "2026-01-01", amount: "1" })],
    });
    expect(shuffled.digest).toBe(reordered.digest);
  });

  it("enforces the mandatory notice period", () => {
    expect(() =>
      buildAnnouncement({ ...validInput(), effectiveDate: "2026-09-10" })
    ).toThrow(/notice period is mandatory/);
    // exactly NOTICE_DAYS is allowed
    expect(NOTICE_DAYS).toBe(30);
    expect(() =>
      buildAnnouncement({ ...validInput(), effectiveDate: "2026-09-11" })
    ).not.toThrow();
  });

  it("refuses rows younger than the six-month cutoff", () => {
    expect(AGE_MONTHS).toBe(6);
    const young = row({ period: parseDay("2026-03-15"), date: "2026-03-15" });
    expect(() => buildAnnouncement({ ...validInput(), rows: [young] })).toThrow(
      /not older than 6 months/
    );
  });

  it("refuses non-positive amounts", () => {
    expect(() =>
      buildAnnouncement({ ...validInput(), rows: [row({ amount: "0" })] })
    ).toThrow(/non-positive/);
  });

  it("apply-time validation re-derives everything and catches tampering", () => {
    const a = buildAnnouncement(validInput());
    const effective = parseDay(a.effectiveDate);

    expect(() => assertAnnouncementApplicable(a, effective - 86400)).toThrow(
      /not effective until/
    );
    expect(() => assertAnnouncementApplicable(a, effective)).not.toThrow();

    const editedRows = { ...a, rows: [row({ amount: "999" })] };
    expect(() => assertAnnouncementApplicable(editedRows, effective)).toThrow(
      /digest mismatch/
    );

    const editedCutoff = { ...a, cutoff: "2026-04-01" };
    expect(() => assertAnnouncementApplicable(editedCutoff, effective)).toThrow(
      /does not match its own effective date/
    );

    const shortNotice = { ...a, announcedAt: "2026-09-01" };
    expect(() => assertAnnouncementApplicable(shortNotice, effective)).toThrow(
      /mandatory 30-day notice/
    );
  });
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

describe("planReductions", () => {
  const announce = (
    policy: "fifo" | "gross",
    rows: ReturnType<typeof row>[]
  ): SweepAnnouncement =>
    buildAnnouncement({ ...validInput(), policy, rows });

  it("fifo: claims consume the oldest credits first, so reduction = announced - claimed", () => {
    const a = announce("fifo", [row({ amount: "100" })]);
    const plan = planReductions(
      [a],
      new Map([[pairKey(A1, CRV), 30n]]),
      new Map([[pairKey(A1, CRV), 500n]])
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].reduction).toBe(70n);
    expect(plan[0].bySeries.get("curve")).toBe(70n);
  });

  it("fifo: fully-claimed announced amounts yield nothing", () => {
    const a = announce("fifo", [row({ amount: "100" })]);
    const plan = planReductions(
      [a],
      new Map([[pairKey(A1, CRV), 150n]]),
      new Map([[pairKey(A1, CRV), 500n]])
    );
    expect(plan).toHaveLength(0);
  });

  it("gross: takes the full announced amount but never below claimed", () => {
    const a = announce("gross", [row({ amount: "100" })]);
    // cum 120, claimed 50 -> floor is 70 < announced 100
    const plan = planReductions(
      [a],
      new Map([[pairKey(A1, CRV), 50n]]),
      new Map([[pairKey(A1, CRV), 120n]])
    );
    expect(plan[0].reduction).toBe(70n);
    // and with plenty of room the full amount is taken
    const roomy = planReductions(
      [a],
      new Map([[pairKey(A1, CRV), 50n]]),
      new Map([[pairKey(A1, CRV), 1000n]])
    );
    expect(roomy[0].reduction).toBe(100n);
  });

  it("allocates a partial reduction to the oldest rows first, across series", () => {
    const a = announce("fifo", [
      row({ series: "fxn", period: parseDay("2026-02-05"), date: "2026-02-05", amount: "60" }),
      row({ series: "curve", period: parseDay("2026-01-08"), date: "2026-01-08", amount: "40" }),
    ]);
    // claimed 30 consumes the OLDEST announced credits: 30 of curve@Jan-08.
    const plan = planReductions(
      [a],
      new Map([[pairKey(A1, CRV), 30n]]),
      new Map([[pairKey(A1, CRV), 500n]])
    );
    expect(plan[0].reduction).toBe(70n);
    expect(plan[0].bySeries.get("curve")).toBe(10n);
    expect(plan[0].bySeries.get("fxn")).toBe(60n);
  });

  it("sequential announcements cannot take the same wei twice", () => {
    const gross = announce("gross", [row({ amount: "80" })]);
    const fifo = announce("fifo", [
      row({ period: parseDay("2026-02-05"), date: "2026-02-05", amount: "50" }),
    ]);
    // cum 100, claimed 0: gross takes 80, fifo wants 50 but only 20 remain.
    const plan = planReductions(
      [gross, fifo],
      new Map([[pairKey(A1, CRV), 0n]]),
      new Map([[pairKey(A1, CRV), 100n]])
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].reduction).toBe(100n);
    expect(plan[0].cumulative).toBe(100n); // as the first announcement saw it
  });

  it("throws when an announced pair is missing from the merkle in flight", () => {
    const a = announce("fifo", [row()]);
    expect(() => planReductions([a], new Map(), new Map())).toThrow(
      /absent from the merkle being generated/
    );
  });
});

// ---------------------------------------------------------------------------
// Applying to a series
// ---------------------------------------------------------------------------

describe("applyReductionsToSeries", () => {
  const plan = (reduction: bigint, series = "curve") => [
    {
      address: A1,
      token: CRV,
      announced: reduction,
      claimed: 0n,
      cumulative: reduction + 10n,
      reduction,
      bySeries: new Map([[series, reduction]]),
    },
  ];

  it("moves the reduction to the recipient and conserves every token", () => {
    const claims = { [A1]: { [CRV]: "100", [FXS]: "7" }, [A2]: { [CRV]: "50" } };
    const applied = applyReductionsToSeries(claims, plan(40n), "curve", RECIPIENT);
    expect(applied.claims[A1][CRV]).toBe("60");
    expect(applied.claims[A1][FXS]).toBe("7");
    expect(applied.claims[RECIPIENT][CRV]).toBe("40");
    expect(applied.credited.get(CRV)).toBe(40n);
    const total = Object.values(applied.claims).reduce(
      (a, tokens) => a + BigInt(tokens[CRV] ?? "0"),
      0n
    );
    expect(total).toBe(150n);
  });

  it("keeps a fully-swept line at zero instead of removing the pair", () => {
    // A removed pair is the verifier's blind spot: its removal deficit shrinks
    // as the user claims from the still-active old root, so a full claim
    // during the publish window would pass verification while double-paying.
    // A zero line trips PRESERVE_BELOW_CLAIMED instead, which is never waived.
    const claims = { [A1]: { [CRV]: "40" }, [A2]: { [CRV]: "50" } };
    const applied = applyReductionsToSeries(claims, plan(40n), "curve", RECIPIENT);
    expect(applied.claims[A1][CRV]).toBe("0");
    expect(applied.claims[RECIPIENT][CRV]).toBe("40");
  });

  it("ignores reductions belonging to another series", () => {
    const claims = { [A1]: { [CRV]: "100" } };
    const applied = applyReductionsToSeries(claims, plan(40n, "fxn"), "curve", RECIPIENT);
    expect(applied.claims[A1][CRV]).toBe("100");
    expect(applied.reduced).toHaveLength(0);
    expect(applied.claims[RECIPIENT]).toBeUndefined();
  });

  it("refuses to take more than the series holds", () => {
    const claims = { [A1]: { [CRV]: "30" } };
    expect(() => applyReductionsToSeries(claims, plan(40n), "curve", RECIPIENT)).toThrow(
      /holds 30 but the plan takes 40/
    );
  });
});

// ---------------------------------------------------------------------------
// The generation hook is INERT while deactivated
// ---------------------------------------------------------------------------

describe("maybeApplyAgedSweep gating", () => {
  const saved: { [k: string]: string | undefined } = {};
  beforeEach(() => {
    saved.mode = process.env.AGED_SWEEP_MODE;
    saved.recipient = process.env.AGED_SWEEP_RECIPIENT;
  });
  afterEach(() => {
    if (saved.mode === undefined) delete process.env.AGED_SWEEP_MODE;
    else process.env.AGED_SWEEP_MODE = saved.mode;
    if (saved.recipient === undefined) delete process.env.AGED_SWEEP_RECIPIENT;
    else process.env.AGED_SWEEP_RECIPIENT = saved.recipient;
  });

  const empty = { merkleRoot: "", claims: {} };

  it("returns null without doing anything when the mode is unset or off", async () => {
    delete process.env.AGED_SWEEP_MODE;
    expect(await maybeApplyAgedSweep({ curve: empty, fxn: empty, period: 0 })).toBeNull();
    process.env.AGED_SWEEP_MODE = "off";
    expect(await maybeApplyAgedSweep({ curve: empty, fxn: empty, period: 0 })).toBeNull();
  });

  it("rejects unknown modes instead of guessing", async () => {
    process.env.AGED_SWEEP_MODE = "report";
    await expect(
      maybeApplyAgedSweep({ curve: empty, fxn: empty, period: 0 })
    ).rejects.toThrow(/must be unset, "off" or "apply"/);
  });

  it("apply mode requires a recipient", async () => {
    process.env.AGED_SWEEP_MODE = "apply";
    delete process.env.AGED_SWEEP_RECIPIENT;
    await expect(
      maybeApplyAgedSweep({ curve: empty, fxn: empty, period: 0 })
    ).rejects.toThrow(/AGED_SWEEP_RECIPIENT/);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle on a fixture tree: announce -> apply -> record/waivers ->
// the NEXT wave's ledger accepts the swept artifact via consume-oldest
// ---------------------------------------------------------------------------

describe("aged sweep lifecycle", () => {
  let root: string;
  const saved: { [k: string]: string | undefined } = {};

  const P1 = parseDay("2026-01-01");
  const P2 = parseDay("2026-02-05");
  const P3 = parseDay("2026-08-06"); // still fresh at the effective date
  const P4 = parseDay("2026-09-17"); // the generation that applies the sweep

  const writeBases = (
    period: number,
    bases: { [series: string]: { [addr: string]: { [token: string]: bigint } } }
  ) => {
    for (const [series, amounts] of Object.entries(bases)) {
      const claims: any = {};
      for (const [address, tokens] of Object.entries(amounts)) {
        claims[address] = { tokens: {} };
        for (const [token, amount] of Object.entries(tokens)) {
          claims[address].tokens[token] = { amount: amount.toString(), proof: [] };
        }
      }
      const dir = path.join(root, "bounties-reports", String(period), "vlCVX", series);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "merkle_data_non_delegators.json"),
        JSON.stringify({ merkleRoot: "", claims })
      );
    }
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aged-e2e-"));
    for (const k of ["AGED_SWEEP_ROOT", "AGED_SWEEP_MODE", "AGED_SWEEP_RECIPIENT"]) {
      saved[k] = process.env[k];
    }
    process.env.AGED_SWEEP_ROOT = root;

    writeBases(P1, { curve: { [A1]: { [CRV]: 100n } }, fxn: { [A1]: { [CRV]: 30n } } });
    writeBases(P2, {
      curve: { [A1]: { [CRV]: 160n }, [A2]: { [CRV]: 50n } },
      fxn: { [A1]: { [CRV]: 30n } },
    });
    writeBases(P3, {
      curve: { [A1]: { [CRV]: 200n }, [A2]: { [CRV]: 50n } },
      fxn: { [A1]: { [CRV]: 30n } },
    });
  });

  afterEach(() => {
    for (const k of ["AGED_SWEEP_ROOT", "AGED_SWEEP_MODE", "AGED_SWEEP_RECIPIENT"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const merkleAt = (period: number, series: string) =>
    JSON.parse(
      fs.readFileSync(
        path.join(
          root,
          "bounties-reports",
          String(period),
          "vlCVX",
          series,
          "merkle_data_non_delegators.json"
        ),
        "utf8"
      )
    );

  it("announce, apply with claims, record, waivers, then the next ledger build", async () => {
    // ---- announce: only the credits older than the cutoff (2026-03-15) ------
    const { announcement } = announceGenericSweep({
      announcedAt: "2026-08-12",
      effectiveDate: "2026-09-15",
    });
    expect(announcement.rows).toHaveLength(4); // A1 curve@P1+P2, A1 fxn@P1, A2 curve@P2
    expect(announcement.totals[CRV]).toBe("240"); // 100+60+30+50 — P3 is fresh
    expect(announcement.policy).toBe("fifo");

    // ---- apply at P4: A1 has claimed 120, A2 nothing -------------------------
    process.env.AGED_SWEEP_MODE = "apply";
    process.env.AGED_SWEEP_RECIPIENT = RECIPIENT;
    const readClaimed = async (pairs: [string, string][]) => ({
      block: "123",
      claimed: new Map(
        pairs.map(([a, t]) => [`${a}:${t}`, a === A1 ? 120n : 0n] as [string, bigint])
      ),
    });

    const result = await maybeApplyAgedSweep({
      curve: merkleAt(P3, "curve"),
      fxn: merkleAt(P3, "fxn"),
      period: P4,
      now: P4,
      readClaimed,
    });
    expect(result).not.toBeNull();
    const { curve, fxn } = result!.merkleByProtocol;

    // A1 announced 190, claimed 120 -> fifo takes 70. The claims consumed the
    // oldest rows (curve@P1's 100, then 20 of fxn@P1's 30), so the sweep takes
    // fxn's remaining 10 and curve@P2's 60.
    expect(curve.claims[A1].tokens[CRV].amount).toBe("140");
    expect(fxn.claims[A1].tokens[CRV].amount).toBe("20");
    // A2 announced 50, claimed 0 -> the whole line goes, but the pair STAYS
    // at zero so a claim inside the publish window trips PRESERVE_BELOW_CLAIMED.
    expect(curve.claims[A2].tokens[CRV].amount).toBe("0");
    expect(curve.claims[RECIPIENT].tokens[CRV].amount).toBe("110");
    expect(fxn.claims[RECIPIENT].tokens[CRV].amount).toBe("10");
    expect(curve.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);

    // ---- the applied record and the waivers ---------------------------------
    const record = result!.record;
    expect(record.claimedBlock).toBe("123");
    const totalReduced = record.reductions.reduce((a, r) => a + BigInt(r.amount), 0n);
    expect(totalReduced).toBe(120n);
    expect(record.creditedPerToken[CRV]).toBe("120");

    const waivers = JSON.parse(
      fs.readFileSync(path.join(root, "waivers.aged-sweep.json"), "utf8")
    );
    const byAccount = Object.fromEntries(waivers.map((w: any) => [w.account, w]));
    // Pairs are never removed, so every waiver is an amount reduction.
    expect(byAccount[A1].invariant).toBe("PRESERVE_AMOUNT_REDUCED");
    expect(byAccount[A1].maxDeficit).toBe("70");
    expect(byAccount[A2].invariant).toBe("PRESERVE_AMOUNT_REDUCED");
    expect(byAccount[A2].maxDeficit).toBe("50");
    // The record carries the claimed() each reduction was computed against.
    const pairA1 = record.pairs.find((p) => p.address === A1)!;
    expect(pairA1.claimed).toBe("120");
    expect(pairA1.cumulative).toBe("230");

    // ---- the pipeline writes the swept bases; the NEXT ledger build must
    // accept the decrease as a consumption of the oldest credits -------------
    writeBases(P4, {
      curve: {
        [A1]: { [CRV]: 140n },
        [A2]: { [CRV]: 0n }, // fully swept, kept at zero
        [RECIPIENT]: { [CRV]: 110n },
      },
      fxn: {
        [A1]: { [CRV]: 20n },
        [RECIPIENT]: { [CRV]: 10n },
      },
    });

    const ledger = buildCreditLedger(
      path.join(root, "bounties-reports"),
      path.join("vlCVX", "curve", "merkle_data_non_delegators.json"),
      restatementsForSeries("curve")
    );
    // 60 consumed from the oldest curve credits: 100@P1 -> 40 remains there.
    expect(ledger.credits.get(pairKey(A1, CRV))).toEqual([
      { period: P1, amount: 40n },
      { period: P2, amount: 60n },
      { period: P3, amount: 40n },
    ]);
    expect(ledger.credits.get(pairKey(A2, CRV))).toBeUndefined();
    expect(ledger.credits.get(pairKey(RECIPIENT, CRV))).toEqual([
      { period: P4, amount: 110n },
    ]);

    // ---- and a later generation must not double-apply -----------------------
    const again = await maybeApplyAgedSweep({
      curve: merkleAt(P4, "curve"),
      fxn: merkleAt(P4, "fxn"),
      period: P4 + 604800,
      now: P4 + 604800,
      readClaimed,
    });
    expect(again).toBeNull();
  });

  it("refuses rows naming a series this target does not apply", async () => {
    const { file } = announceGenericSweep({
      announcedAt: "2026-08-12",
      effectiveDate: "2026-09-15",
    });
    // Corrupt one row's series AND recompute the digest, so only the series
    // gate can catch it (a stale digest would trip the tamper check first).
    const a = JSON.parse(fs.readFileSync(file, "utf8"));
    a.rows[0].series = "curvee";
    a.digest = announcementDigest(a);
    fs.writeFileSync(file, JSON.stringify(a));

    process.env.AGED_SWEEP_MODE = "apply";
    process.env.AGED_SWEEP_RECIPIENT = RECIPIENT;
    await expect(
      maybeApplyAgedSweep({
        curve: merkleAt(P3, "curve"),
        fxn: merkleAt(P3, "fxn"),
        period: P4,
        now: P4,
        readClaimed: async (pairs) => ({
          block: "123",
          claimed: new Map(pairs.map(([a2, t]) => [`${a2}:${t}`, 0n] as [string, bigint])),
        }),
      })
    ).rejects.toThrow(/names series "curvee"/);
  });

  it("a basedOn announcement only applies while its source state is present", async () => {
    const rows = [
      {
        address: A1,
        token: CRV,
        series: "curve",
        period: P1,
        date: dayOf(P1),
        amount: "100",
      },
    ];
    const curveRoot = () => merkleAt(P3, "curve").merkleRoot ?? "";
    const write = (roots: { [s: string]: string }) => {
      const a = buildAnnouncement({
        targetGroup: "vlcvx-voters",
        source: "union-reassign",
        policy: "gross",
        announcedAt: "2026-08-12",
        effectiveDate: "2026-09-15",
        basedOn: { period: P3, roots },
        rows,
      });
      const dir = path.join(root, "bounties-reports", "aged-sweep", "vlcvx-voters");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "announcement-2026-09-15-union-reassign.json");
      fs.writeFileSync(file, JSON.stringify(a));
      return file;
    };

    process.env.AGED_SWEEP_MODE = "apply";
    process.env.AGED_SWEEP_RECIPIENT = RECIPIENT;
    const readClaimed = async (pairs: [string, string][]) => ({
      block: "123",
      claimed: new Map(pairs.map(([a2, t]) => [`${a2}:${t}`, 0n] as [string, bigint])),
    });
    const input = () => ({
      curve: merkleAt(P3, "curve"),
      fxn: merkleAt(P3, "fxn"),
      period: P4,
      now: P4,
      readClaimed,
    });

    // Root mismatch: the recorded source state is not what sits in the tree.
    write({ curve: "0x" + "12".repeat(32) });
    await expect(maybeApplyAgedSweep(input())).rejects.toThrow(/source state was replaced/);

    // Matching root but the in-flight line shrank below the source amount.
    const good = write({ curve: "" }); // fixture artifacts carry merkleRoot ""
    const shrunk = merkleAt(P3, "curve");
    shrunk.claims[A1].tokens[CRV].amount = "50";
    await expect(
      maybeApplyAgedSweep({ ...input(), curve: shrunk })
    ).rejects.toThrow(/refusing to sweep against a shrunken line/);

    // Intact source state: applies.
    fs.writeFileSync(good, fs.readFileSync(good));
    const ok = await maybeApplyAgedSweep(input());
    expect(ok).not.toBeNull();
    expect(ok!.merkleByProtocol.curve.claims[A1].tokens[CRV].amount).toBe("100"); // 200 − 100
  });

  it("a zero line dropping out of the next period is not a ledger violation", () => {
    // The weekly combine skips zero amounts, so a fully-swept pair vanishes
    // one period after the sweep. Nothing is lost — no restatement needed.
    writeBases(P4, { curve: { [A1]: { [CRV]: 200n }, [A2]: { [CRV]: 0n } }, fxn: {} });
    writeBases(P4 + 604800, { curve: { [A1]: { [CRV]: 200n } }, fxn: {} });
    const ledger = buildCreditLedger(
      path.join(root, "bounties-reports"),
      path.join("vlCVX", "curve", "merkle_data_non_delegators.json"),
      [
        {
          kind: "consume-oldest",
          period: P4,
          address: A2,
          token: CRV,
          amount: 50n,
          reason: "sweep",
        },
      ]
    );
    expect(ledger.credits.get(pairKey(A2, CRV))).toBeUndefined();
  });

  it("regenerating the SAME period re-applies deterministically", async () => {
    announceGenericSweep({ announcedAt: "2026-08-12", effectiveDate: "2026-09-15" });
    process.env.AGED_SWEEP_MODE = "apply";
    process.env.AGED_SWEEP_RECIPIENT = RECIPIENT;
    const readClaimed = async (pairs: [string, string][]) => ({
      block: "123",
      claimed: new Map(pairs.map(([a, t]) => [`${a}:${t}`, 0n] as [string, bigint])),
    });
    const input = () => ({
      curve: merkleAt(P3, "curve"),
      fxn: merkleAt(P3, "fxn"),
      period: P4,
      now: P4,
      readClaimed,
    });
    const first = await maybeApplyAgedSweep(input());
    const second = await maybeApplyAgedSweep(input());
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.merkleByProtocol.curve.merkleRoot).toBe(
      first!.merkleByProtocol.curve.merkleRoot
    );
  });
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

describe("announcementDigest", () => {
  const base = (rows: ReturnType<typeof row>[]) => ({
    targetGroup: "vlcvx-voters",
    source: "generic-aging",
    policy: "fifo" as const,
    announcedAt: "2026-08-12",
    effectiveDate: "2026-09-15",
    rows,
  });

  it("is insensitive to row order and address casing, sensitive to amounts", () => {
    const rows = [row(), row({ address: A2, amount: "5" })];
    const lower = rows.map((r) => ({ ...r, address: r.address.toLowerCase() }));
    expect(announcementDigest(base([...rows].reverse()))).toBe(announcementDigest(base(rows)));
    expect(announcementDigest(base(lower))).toBe(announcementDigest(base(rows)));
    expect(
      announcementDigest(base([row(), row({ address: A2, amount: "6" })]))
    ).not.toBe(announcementDigest(base(rows)));
  });

  it("commits to the execution-critical header fields, not just the rows", () => {
    const rows = [row()];
    const reference = announcementDigest(base(rows));
    // Flipping fifo to gross changes the reduction from announced−claimed to
    // the full announced amount; backdating announcedAt fakes the notice;
    // moving effectiveDate moves the cutoff. All must change the commitment.
    expect(announcementDigest({ ...base(rows), policy: "gross" })).not.toBe(reference);
    expect(announcementDigest({ ...base(rows), announcedAt: "2026-07-01" })).not.toBe(reference);
    expect(announcementDigest({ ...base(rows), effectiveDate: "2026-10-15" })).not.toBe(reference);
    expect(
      announcementDigest({ ...base(rows), basedOn: { period: 1, roots: { curve: "0xabc" } } })
    ).not.toBe(reference);
  });
});

describe("policy validation fails closed", () => {
  it("buildAnnouncement rejects unknown policies", () => {
    expect(() =>
      buildAnnouncement({ ...validInput(), policy: "fif0" as any })
    ).toThrow(/unknown sweep policy/);
  });

  it("apply-time validation rejects a policy typo instead of treating it as gross", () => {
    const a = buildAnnouncement(validInput());
    const tampered = { ...a, policy: "fif0" as any };
    expect(() =>
      assertAnnouncementApplicable(tampered, parseDay(a.effectiveDate))
    ).toThrow(/unknown policy/);
  });
});
