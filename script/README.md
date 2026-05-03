# Script Directory

This directory contains the TypeScript pipelines used to fetch rewards, generate reports, compute distributions, build merkle trees, and verify weekly outputs.

## Main Areas

- [sdTkns](./sdTkns/README.md) - legacy sdToken merkle generation plus universal sdFXS and sdSpectra support.
- [vlCVX](./vlCVX/README.md) - vlCVX report, repartition, merkle, and verification scripts.
- [spectra](./spectra/README.md) - Spectra report and repartition steps used by the sdSpectra universal merkle.
- [utils](./utils/README.md) - shared constants, CSV parsing, Snapshot helpers, merkle helpers, RPC clients, and claim fetchers.
- [verify](./verify/README.md) - distribution verification and LLM triage pipeline.
- [special-distribs](./special-distribs/README.md) - one-off extra merkle generation scripts.
- `reports/` - protocol report generators.
- `indexer/` - delegation and forwarding indexers.
- `interfaces/` - shared TypeScript interfaces for merkle and distribution data.
- `test/` - unit, integration, and snapshot tests.

## Common Commands

```bash
# sdToken merkles
pnpm sd-merkle
pnpm sd-merkle:frax
pnpm sd-merkle:spectra

# Spectra report and repartition
pnpm spectra-report
pnpm spectra-repartition

# Report generation
make -f automation/reports.mk run-weekly-curve
make -f automation/reports.mk run-weekly-balancer
make -f automation/reports.mk run-weekly-fxn
make -f automation/reports.mk run-weekly-frax
make -f automation/reports.mk run-weekly-vlcvx

# OTC reports
make -f automation/reports.mk run-otc-curve
make -f automation/reports.mk run-otc-balancer
make -f automation/reports.mk run-otc-fxn
make -f automation/reports.mk run-otc-frax

# vlCVX distribution steps
make -f automation/distribution.mk run-repartition PROTOCOL=vlCVX
make -f automation/distribution.mk run-merkles PROTOCOL=vlCVX TYPE=non-delegators
make -f automation/distribution.mk run-merkles PROTOCOL=vlCVX TYPE=delegators
```

Direct script execution uses `pnpm tsx`:

```bash
pnpm tsx script/reports/generateReport.ts curve
pnpm tsx script/verify/aiVerify.ts --timestamp 1771459200 --protocol vlCVX
```

## Data Flow

```text
weekly-bounties/ claims
        |
        v
report scripts -> bounties-reports/{timestamp}/*.csv
        |
        v
repartition scripts -> protocol repartition JSON
        |
        v
merkle scripts -> merkle JSON + APR files
        |
        v
publish workflows -> bounties-reports/latest/
```

## Tests

```bash
pnpm test
pnpm test:unit
pnpm test:integration
pnpm test:coverage
```
