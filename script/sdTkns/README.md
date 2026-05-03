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

- `generateMerkle.ts` - legacy sdToken merkle generator. It reads protocol CSVs, applies Snapshot vote weights and delegation rules, carries unclaimed balances, writes `merkle.json`, `delegationsAPRs.json`, and `log.json`, and prepares root update calldata.
- `generateUniversalMerkleFrax.ts` - cumulative Fraxtal sdFXS merkle generator. Outputs `bounties-reports/{timestamp}/sdTkns/sdtkns_merkle_252.json` and may refresh `latest/sdTkns/sdtkns_merkle_252.json` locally.
- `generateUniversalMerkleSpectra.ts` - cumulative Base sdSpectra merkle generator. Reads Spectra repartition output and writes `bounties-reports/{timestamp}/sdTkns/sdtkns_merkle_8453.json` plus `bounties-reports/{timestamp}/spectra/merkle_data.json`.
- `claims/` - claim fetchers for Votemarket, Votemarket v2, Hidden Hand, Warden, and Spectra.

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
