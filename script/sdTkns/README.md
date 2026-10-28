# sdToken Distribution System

The sdToken pipeline converts weekly voting incentives into merkle trees for Stake DAO liquid locker voters and delegators.

## Scope

Operational reports currently cover:

| Report | Space | Token / output | Network |
|---|---|---|---|
| `curve.csv` | `sdcrv.eth` | sdCRV | Ethereum |
| `balancer.csv` | `sdbal.eth` | sdBAL | Ethereum |
| `frax.csv` | `sdfxs.eth` | legacy sdFXS and universal Fraxtal sdFXS | Ethereum / Fraxtal |
| `fxn.csv` | `sdfxn.eth` | sdFXN | Ethereum |
| `cake.csv` | `sdcake.eth` | sdCAKE | BSC |
| `spectra.csv` | `sdspectra.eth` | universal Base sdSpectra | Base |

Raw token rows can be added under `bounties-reports/{timestamp}/raw/{protocol}/`; see [Raw Token Distributions](../../README-raw-tokens.md).

## Key Files

- `generateMerkle.ts` - legacy sdToken merkle generator. It reads protocol CSVs, applies Snapshot vote weights and delegation rules, carries unclaimed balances, writes `merkle.json`, `delegationsAPRs.json`, and `log.json`, and prepares root update calldata. For sdCRV and sdFXN it keeps only the weekly share of `LEGACY_STASH_RECIPIENTS` (Aladdin's Concentrator locker and temporarily 3.Finance's sdMasterNode at `0xD7Ba3691750153f94dc0EB40bE09448F52f33b13`, whose keeper uses the legacy stash) plus the carried unclaimed balances on the legacy stash; every other weekly share goes to the cumulative universal distributors `SDCRV_UNIVERSAL_MERKLE` / `SDFXN_UNIVERSAL_MERKLE` (`sdTkns/sdtkns_merkle_1_sdcrv.json`, `sdTkns/sdtkns_merkle_1_sdfxn.json`, started from zero at the cutover; `log.json` lists them under `Universal`). A legacy token with no kept share that week is neither frozen nor set.
- `generateUniversalMerkleFrax.ts` - cumulative Fraxtal sdFXS merkle generator. Outputs `bounties-reports/{timestamp}/sdTkns/sdtkns_merkle_252.json` and may refresh `latest/sdTkns/sdtkns_merkle_252.json` locally.
- `generateUniversalMerkleSpectra.ts` - cumulative Base sdSpectra merkle generator. Reads Spectra repartition output and writes `bounties-reports/{timestamp}/sdTkns/sdtkns_merkle_8453.json` plus `bounties-reports/{timestamp}/spectra/merkle_data.json`.
- `claims/` - claim fetchers for Votemarket, Votemarket v2, and Spectra.

Shared merkle logic lives in `script/utils/merkle/` and `script/shared/merkle/`.

## Weekly Flow

1. Fetch claimed rewards into `weekly-bounties/{timestamp}/...`.
2. Generate report CSVs in `bounties-reports/{timestamp}/`.
3. Run the relevant merkle generator.
4. Verify reports and outputs.
5. Publish current files into `bounties-reports/latest/`.

## Commands

```bash
# Legacy sdToken merkle
pnpm sd-merkle

# Universal sdFXS merkle
pnpm sd-merkle:frax

# Spectra report, repartition, and universal sdSpectra merkle
pnpm spectra-report
pnpm spectra-repartition
pnpm sd-merkle:spectra

# Report generation examples
make -f automation/reports.mk run-weekly-curve
make -f automation/reports.mk run-weekly-fxn
```

Most scripts accept the current Thursday 00:00 UTC epoch by default. Universal generators also accept `--timestamp`:

```bash
pnpm tsx script/sdTkns/generateUniversalMerkleSpectra.ts --timestamp 1771459200
```

## Outputs

Legacy sdToken generator:

- `bounties-reports/{timestamp}/merkle.json`
- `bounties-reports/{timestamp}/delegationsAPRs.json`
- root-level `log.json`

Universal generators:

- `bounties-reports/{timestamp}/sdTkns/sdtkns_merkle_252.json` for sdFXS on Fraxtal.
- `bounties-reports/{timestamp}/sdTkns/sdtkns_merkle_8453.json` for sdSpectra on Base.
- `bounties-reports/{timestamp}/sdTkns/sdtkns_merkle_1_sdcrv.json` and `sdtkns_merkle_1_sdfxn.json` for the mainnet sdCRV and sdFXN universal distributors (written by the legacy generator, submitted by Guard's `sdtokens-submit` and accepted by its shared `merkle-accept-roots` job from `sdtokens-distribution.json`'s `universal` entries, published by the legacy publish step once `root()` matches).

Published copies are documented in [bounties-reports/latest/README.md](../../bounties-reports/latest/README.md).

## Delegation

The generator handles:

- Stake DAO delegation address: `0x52ea58f4FC3CEd48fa18E909226c1f8A0EF887DC`
- Auto-voter delegation address: `0x0657C6bEe67Bb96fae96733D083DAADE0cb5a179`
- direct-voter exclusions so users who vote directly are not also counted through delegation.

## Verification

```bash
pnpm tsx script/repartition/sdTkns/reportVerifier.ts curve
pnpm test:integration
```

## ENG-2224 validation

Cumulative baselines must match the active root. Verified current-period artifacts are reused; regenerated drafts cannot add the weekly allocation twice. Publication copies only verified universal entries after every required root is active. Aladdin and 3.Finance's sdMasterNode remain on the legacy stash; all prior unpaid legacy claims remain there.

The cross-repository fork test lives in `automation-guard/tests/jobs/sdtokens/test_universal_migration_fork.py`. Check out automation-guard, bounties-report, backend-monorepo and monorepo as sibling folders; install their dependencies, Bun, Anvil, Playwright and Chromium. From automation-guard:

```sh
RUN_FORK_E2E=1 E2E_UI=1 uv run pytest tests/jobs/sdtokens/test_universal_migration_fork.py -q
```

`FORK_RPC_1` selects an archive RPC; `PLAYWRIGHT_MODULE` can select an installed Playwright module. Transactions execute only on localhost. The test runs the allocation split, two cumulative periods, Guard funding and shared acceptance, the publication verifier and workflow copy step, actual Hub routes, portfolio/claim components and Router claims. It checks Aladdin, 3.Finance's legacy claim, legacy carry, prior claims, forwarding, different maturity times, malformed artifacts, missing proofs, retries, zero-reward periods and vlCVX/extra-reward claims. Snapshot inputs and wallet connection are fixtures; Next page navigation and swap quotes are outside this test.
