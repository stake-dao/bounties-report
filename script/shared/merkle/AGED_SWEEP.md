# Aged-reward sweep (>6 months) — runbook

Stake DAO may reclaim rewards older than **six months**, with a mandatory
**thirty-day notice** so delegators can still claim before the sweep lands.
The machinery lives in `aging.ts` (generic library) and `agedSweep.ts`
(vlCVX-voters wiring + CLI); the weekly pipeline hook sits in
`script/vlCVX/3_merkles/createCombinedMerkle.ts`.

**The mechanism is DEACTIVATED by default.** The weekly run is byte-identical
unless `AGED_SWEEP_MODE=apply` is set, and even then nothing happens without a
committed announcement whose effective date has passed.

## How it recovers dates from a cumulative merkle

A cumulative merkle stores one number per (address, token) — credit dates are
discarded at generation. `buildCreditLedger` recovers them by differencing the
committed weekly artifacts: `merkle[P] − merkle[P−1]` is the credit granted at
P, whatever legs fed it. This is validated on every build (monotonicity +
exact reconstruction of the series head) and reproduces the audit prototype
exactly on the full 2025–2026 history.

Decreases in the series hard-fail the build unless explained:

- a **reset** (a period rewritten in place, e.g. the ENG-2105 Union
  reassignment) restarts the pair as an opening balance dated at that period —
  the safe direction: credits can only look *younger*;
- a **consume-oldest** entry (a previous sweep, read from
  `aged_sweep_applied.json`) pops the pair's oldest credits, which is what the
  sweep did. Without this, the first applied sweep would freeze the ledger
  forever.

## The two-phase protocol

### 1. Announce (a human decision, CLI only — the pipeline can never mint one)

```bash
# generic: everything older than 6 months at the effective date
pnpm tsx script/shared/merkle/agedSweep.ts announce --effective 2026-10-01

# the Union particular case: gross-policy announcement from the round ledger
pnpm tsx script/vlCVX/union_reassign/3_sweepLedger.ts --effective 2026-09-11 --announce
```

Writes `bounties-reports/aged-sweep/vlcvx-voters/announcement-<date>-<source>.json`:
per-(address, token, series, period) rows, per-token totals, and a digest over
**everything execution-critical** — rows, policy, dates, target, and source
binding — so no field of the published commitment can be edited unnoticed.
The effective date must be ≥ 30 days out; the six-month cutoff is derived from
the **effective** date (the age test happens at the end of the notice, not the
start). Commit the file and notify delegators — it is the published
commitment. A wrong announcement is deleted and re-issued, never edited: the
apply step re-derives the cutoff, re-hashes the whole commitment, validates
the policy enum and every row's series, and refuses on any mismatch.

Gross announcements additionally carry `basedOn` — the period and exact roots
of the artifacts their rows were computed against. Apply refuses to run unless
those roots sit in the committed tree **and** the merkle in flight still holds
at least the source amounts for every announced pair. Without that binding, a
gross sweep applied against bases that never received (or later lost) the
source credits would eat the recipients' own prior entitlements.

Policies:

- `fifo` (generic default): claims are assumed to have consumed the oldest
  credits first — `reduction = max(0, announced − claimed)`. Conservative:
  never takes anything a claimer could argue was already theirs.
- `gross` (Union case): the full announced amount, floored at claimed().
  Only justified by provenance — the Union share never entered a posted root,
  so no historical claim can have consumed it (verified on-chain).

Both keep every line ≥ claimed(), so a sweep can never make a delegator's
`claim()` revert.

### 2. Apply (at weekly generation, on/after the effective date)

```bash
AGED_SWEEP_MODE=apply \
AGED_SWEEP_RECIPIENT=0x<stake-dao-recovery-address> \
pnpm tsx script/vlCVX/3_merkles/createCombinedMerkle.ts
```

The hook re-reads `claimed()` on-chain at apply time — anything claimed during
the notice window is left alone — reduces both per-gauge bases, credits the
recipient (the swept amounts stay claimable, by Stake DAO, in the same merkle),
and the combined merkle derives from the swept bases as usual. It writes:

- `bounties-reports/<period>/vlCVX/aged_sweep_applied.json` — the audit
  record, and the ledger input that explains this period's decreases to the
  next sweep;
- `script/verify/invariants/waivers.aged-sweep.json` — one quantified waiver
  per swept pair (`PRESERVE_AMOUNT_REDUCED`, or `PRESERVE_PAIR_REMOVED` when a
  line hit zero), capped at exactly the applied reduction.
  `invariantsVerify` loads this file alongside the hand-maintained waivers.

Commit record + waivers with the merkle. Remove the waiver file once the swept
root is accepted on-chain (later periods baseline against the swept root, so
the waivers are only needed for that one verify run). Re-running the same
period (`FORCE_UPDATE`) re-applies deterministically; a later period skips
already-applied announcements by digest.

### Status

```bash
pnpm tsx script/shared/merkle/agedSweep.ts status
```

### Ordering with the Union reassignment

Publish the merged Union bases **before** running a generic `announce`: an
announcement computed pre-merge lists the Union's old line instead of its
post-merge remainder. Even out of order nothing double-pays — every reduction
is capped at the pair's actual line and floored at `claimed()` — but the
announced figures would not match what the apply can take, which defeats the
point of a notice.

## What can still fire in verify

`PRESERVE_BELOW_CLAIMED` is deliberately **never** waived by the sweep. If it
fires on a swept pair it means someone claimed between the apply-time
`claimed()` read and the verify run — regenerate (the fresh read picks the
claim up) rather than waive. The applied record's `pairs` block stores the
claimed() every reduction was computed against, so the offending claim is a
one-line diff.

This tripwire is why a fully-swept line is kept at `"0"` instead of being
removed: a *removed* pair is the verifier's blind spot (its removal deficit
shrinks as the user claims, so a full claim inside the publish window would
verify clean while double-paying), whereas a zero line makes any such claim
trip `PRESERVE_BELOW_CLAIMED`. Zero lines drop out by themselves one period
later — the weekly combine skips zero amounts, and losing a zero is
violation-free.

## Env summary

| Variable | Effect |
| --- | --- |
| `AGED_SWEEP_MODE` | unset/`off` = fully inert (default). `apply` = consume effective announcements at generation. |
| `AGED_SWEEP_RECIPIENT` | Required in apply mode: the address swept rewards are reassigned to. |
| `AGED_SWEEP_ROOT` | Test-only: reroots announcements/records/waivers onto a fixture tree. |
