# sdTokens freeze + verification — architecture, PR, and this week's actions

Status handoff for the sdTokens (sdCRV / sdFXN legacy merkle) distribution pipeline:
the new verification/gating layer (PR #186), the freeze/timelock flow and the claim
window it creates, how the UI should handle it, and the multisig/KMS transactions to
execute for period `1787788800`.

Merkle contract (mainnet sdTkns): `0x2f18e001B44DCc1a1968553A2F32ab8d45B12195`

---

## 1. This week's fxn incident + fix (already on `main`)

A swap misfire left native FXN outside the report's view, so ~15.5 sdFXN was missing
from `fxn.csv`.

- **Misroute** `0x0b903b2e72dfb9fb58aa7a7dd0f5dda5a7dd4377785eebc6b6f0aad0c070aee8`
  (Aug 28): `ALL_MIGHT_V2` (`0xDBd24b092f686b12650EC1450e3A7138F714506c`) sent
  **15.355980998834488256 FXN** (`0x365AccFCa291e7D3914637ABf1F7635dB165Bb09`) to
  `0xa05c5f4a91be37f82a5ddfea970c6d32675fa737` instead of depositing to sdFXN →
  Botmarket. Only 0 sdFXN reached Botmarket. In `generateReport.ts` this tx is fetched
  but skipped at `if (sdInTx <= 0) continue` → zero attribution, zero double-count.
- **Recovery** `0xf8cd1f3b7cb711b29a7b893942daa13fd5a6b0c86938614231a47c4e8c5fd57a`
  (Aug 31): pulled via `BOSS` (`0xB0552b6860CE5C0202976Db056b5e3Cc4f9CC765`) →
  `SD_FXN_POOL` (`0x28ca243dc0ac075dd012fcf9375c25d18a844d96`) minted 15.561968 sdFXN →
  **15.528491600513923371 sdFXN forwarded to Botmarket**
  (`0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF`). 0.033477 sdFXN dust stranded at BOSS.

**Why the report missed it:** `fetchSwapInEvents`/`fetchSwapOutEvents` key transfers
only on `ALL_MIGHT_V2` as counterparty. Every transfer in the recovery routes through
BOSS/pool/Botmarket — the aggregator is never touched — so it is invisible.

**Fix (commit `08cfc319` on `main`):**
- `data/residual-catchup/fxn-1787788800.json` — catch-up manifest, `actualSdReceivedWei
  = 15528491600513923371`, attributed to native FXN.
- Applied via `script/reports/applyResidualCatchup.ts`: `fxn.csv` total
  **50.915916 → 66.444408 sdFXN** across the 3 FXN rows; cleanup tx recorded in
  `fxn-attribution.json`.
- `applyResidualCatchup.ts` grand-total gate made CSV-precision-aware (a flat `1e-9`
  relative tolerance is unsatisfiable when an 18-decimal residual splits across
  6-decimal rows).

Open dust item: **0.033477 sdFXN** left at BOSS needs a separate sweep or write-off.

---

## 2. New architecture — sdTokens verification pipeline (PR #186)

Branch `feat/sdtokens-legacy-verify` → https://github.com/stake-dao/bounties-report/pull/186
(commits `f8432422` feature, `be125a73` R1/R5 fixes). Adds independent verification and
gating around the existing freeze → generate → set-roots flow.

| Script | Runs in | Asserts |
|---|---|---|
| `script/helpers/verifyLegacyRoot.ts` | `sdtokens-merkle.yaml` (publish) | On-chain `merkleRoot(token)` matches the source merkle before publishing to `latest`. `0x0` on-chain ⇒ still frozen ⇒ **skip publish** (`skip=true`). |
| `script/sdTkns/verify/reportGate.ts` | `reports.yaml` (notify + final OTC lane) | R1–R5 report gate (below). |
| `script/sdTkns/verify/reconstructSdMerkle.ts` | `sdtokens-post-freeze.yaml` | Independent V1–V11 reconstruction of the merkle from source data. |
| `script/sdTkns/verify/checkBeforeSetRoots.ts` | `sdtokens-post-freeze.yaml` | Pre-set-roots checks (rebuild, continuity, funding, surplus, ordering, scope). |

Supporting changes:
- `generateMerkle.ts` — `buildTransactionLog`, writes `period`/`postFreeze` into
  `log.json`, tighter distribution check.
- `createMultiMerkle.ts` / `utils.ts` — read-only claim-cache mode so verification
  observes chain state without moving the committed claim-window anchor; extracted
  helpers.
- Unit tests for all of the above.

**Report gate (reportGate, R1–R5):** R1 source completeness (volume band vs 4 trailing
weeks), R2 row provenance, R3 swap conservation, R4 rate sanity, R5 WETH ledger.

**Reconstruction (reconstructSdMerkle, V1–V11):** V1 rebuild, V2 conservation, V3
continuity, V4 attribution (Botmarket sd events), V8 scope, V9 snapshot eligibility,
V10 registry, V11 APR presence. `checkBeforeSetRoots` runs V1/V3/V5/V6/V7/V8 (V5 funding
two-way, V6 surplus, V7 ordering).

---

## 3. Freeze / timelock flow + the claim window

The merkle is Votium-style: a new cumulative root requires a **freeze first** (so
claimed-since-freeze is snapshotted consistently), then a set. On-chain,
`merkleRoot(token)` reads **`0x0` while frozen**, so every `claim` reverts during the
window — regardless of which merkle the UI serves. Automation adds a **~3h timelock** on
the set.

```
multiFreeze(tokens)    → root = 0x0 ──┐
  generate merkle (off-chain, mins)   │  ~3h+ window: root 0x0, all claims revert
[~3h guard timelock]                  │
multiSet(tokens, roots)→ root = R_new ┘
```

The window is inherent: generation needs the freeze to have happened, and the timelock
is a security property. It cannot be collapsed — it must be reflected, not raced.

**Load-bearing invariant (keep it):** the publish-to-`latest` step is gated on
`verifyLegacyRoot` (skip while `0x0`), so `bounties-reports/latest/merkle.json` only
advances **after** the on-chain root matches the new source root. `latest` lags
on-chain, never leads it — a proof built from `latest` always matches the live root
when not frozen.

**Operational rule:** the publish job must **re-run after the timelock lands** — it
no-ops via the skip gate until the set executes. Without a retry/trigger, `latest` never
catches up.

---

## 4. UI handling of freeze / latest

**Correctness = on-chain root (authoritative):**
1. UI reads `merkleRoot(token)`.
2. `== 0x0` → frozen → disable claim, show updating state (prevents every failed tx).
3. `!= 0x0` → read `latest/merkle.json`, assert its root `== merkleRoot(token)`, build
   proof, allow claim.

**UX = a published status file** (this repo emits it, UI polls it). Proposed
`bounties-reports/latest/sdTkns/status.json`:

```json
{
  "updatedAt": 1788253477,
  "tokens": {
    "0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5": {
      "symbol": "sdCRV", "chainId": 1,
      "frozen": true,
      "period": 1787788800,
      "frozenAt": 1788240000,
      "etaUnfreeze": 1788250800,
      "previousRoot": "0x8d39…",
      "pendingRoot": "0xc675…"
    }
  }
}
```

Post-freeze workflow writes `frozen:true` + `etaUnfreeze` when queuing the freeze; the
publish step flips it to `frozen:false` once `verifyLegacyRoot` passes. UI shows a
countdown while frozen, normal claim otherwise. (Emission not yet wired — pending
decision to add to PR #186 or a follow-up.)

---

## 5. Transactions to execute — period `1787788800` (multisig / KMS)

Both calls target the sdTkns merkle `0x2f18e001B44DCc1a1968553A2F32ab8d45B12195`
(network: ethereum, value: 0). Tokens this week: **sdCRV**
(`0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5`) and **sdFXN**
(`0xe19d1c837B8A1C83A56cD9165b2c0256D39653aD`). Executed via the automation guard
(KMS-signed), subject to the ~3h timelock; the `multiSet` must follow the `multiFreeze`
+ off-chain generation.

New roots:
- sdCRV: `0x8d391b4597dbc164a2f39ebae2d9c814168babf7d846875f2ae2d1441b881c53`
- sdFXN: `0xc67515c8f085eab04b9a2b6316a3ff84051fa47bcfb7cd230531d0034f66286f`

**1) `multiFreeze([sdCRV, sdFXN])`** — `to` `0x2f18e001B44DCc1a1968553A2F32ab8d45B12195`

```
0xde1be3c200000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000d1b5651e55d4ceed36251c61c50c889b36f6abb5000000000000000000000000e19d1c837b8a1c83a56cd9165b2c0256d39653ad
```

**2) `multiSet([sdCRV, sdFXN], [rootCRV, rootFXN])`** — `to` `0x2f18e001B44DCc1a1968553A2F32ab8d45B12195`

```
0xd665811c000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000002000000000000000000000000d1b5651e55d4ceed36251c61c50c889b36f6abb5000000000000000000000000e19d1c837b8a1c83a56cd9165b2c0256d39653ad00000000000000000000000000000000000000000000000000000000000000028d391b4597dbc164a2f39ebae2d9c814168babf7d846875f2ae2d1441b881c53c67515c8f085eab04b9a2b6316a3ff84051fa47bcfb7cd230531d0034f66286f
```

Source: `log.json` → `Transactions[0]` (`toFreeze.data`, `toSet.data`).

---

## 6. Verification results — period `1787788800` (real post-freeze merkle)

| Check set | Result |
|---|---|
| `reconstructSdMerkle` | **8/8 PASS** — V2 conservation wei-exact; V4 fxn Botmarket sd = `66.444407672875492513` (confirms the fxn fix independently) |
| `checkBeforeSetRoots` | **5/6** — V5 funding reconciles (sdCRV `0.98`, sdFXN `0.006`); only V7 fails |
| `reportGate` curve | **5/5 PASS** |
| `reportGate` fxn | **4/5** — only R1 |
| `verifyLegacyRoot` | sdCRV/sdFXN `WAITING` (on-chain root `0x0`, still frozen — expected pre-set state); other legacy tokens `OK` |

Funding, conservation, and attribution all reconcile — distribution is correct.

---

## 7. Open items / follow-ups

- **fxn R1 volume flag** — `votemarket_v2` at `203k` vs 4-week median ~`797k`; matches
  last week (`204k`), so a level shift the median spans, not a data error. Confirm the
  lower fxn volume is expected. (R1 already fixed for the steady-zero false positive.)
- **V7 `log.period=undefined`** — the deployed `generateMerkle` doesn't emit `period`;
  PR #186's version does. Clears once PR #186 ships.
- **`status.json` emission** — wire into `sdtokens-post-freeze.yaml` + publish step for
  the UI (Section 4). Pending decision: PR #186 or a follow-up.
- **Publish retry after timelock** — ensure the legacy publish job re-runs once the set
  executes, so `latest` catches up (Section 3).
- **0.033477 sdFXN dust at BOSS** — sweep or write-off (Section 1).

---

## References

- PR #186 — https://github.com/stake-dao/bounties-report/pull/186
- fxn fix — commit `08cfc319` (`main`)
- Manifest — `data/residual-catchup/fxn-1787788800.json`
- Merkle contract — `0x2f18e001B44DCc1a1968553A2F32ab8d45B12195`
- Aggregator `ALL_MIGHT_V2` — `0xDBd24b092f686b12650EC1450e3A7138F714506c`
- Botmarket — `0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF`
