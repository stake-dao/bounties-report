# Stake DAO Rewards Distribution

This repository generates, verifies, and publishes Stake DAO weekly reward distributions. It covers sdToken voting incentives, vlCVX voter/delegator rewards, and the current Spectra sdToken pipeline.

## Systems

### sdToken distributions

See [script/sdTkns/README.md](./script/sdTkns/README.md).

- Processes voting incentives for Curve, Balancer, Frax, FXN, and Cake reports.
- Builds legacy `merkle.json` outputs plus newer chain-specific universal merkle files in `sdTkns/`.
- Supports raw token distributions from `bounties-reports/{timestamp}/raw/{protocol}/`.
- Publishes active files under `bounties-reports/latest/` through the `sdTokens: Merkle` workflow.

### vlCVX distributions

See [script/vlCVX/README.md](./script/vlCVX/README.md).

- Processes Convex Votemarket and Votium rewards.
- Splits rewards between direct voters, delegators, and Votium forwarders.
- Publishes main and chain-specific merkles under `bounties-reports/latest/vlCVX/`.

### Spectra sdToken distributions

See [script/spectra/README.md](./script/spectra/README.md).

- Generates the Spectra report and repartition data.
- Uses `script/sdTkns/generateUniversalMerkleSpectra.ts` to publish the Base sdSpectra merkle as `sdTkns/sdtkns_merkle_8453.json`.

## Repository Layout

```text
.
├── automation/                       # Make targets used by GitHub Actions and local ops
├── bounties-reports/
│   ├── {timestamp}/                  # Weekly report, repartition, APR, and merkle outputs
│   │   ├── merkle.json               # Legacy sdToken merkle output
│   │   ├── delegationsAPRs.json      # sdToken delegation APRs
│   │   ├── {protocol}.csv            # Protocol reports
│   │   ├── raw/{protocol}/           # Optional raw token reports
│   │   ├── sdTkns/                   # Universal sdToken merkles by chain
│   │   ├── spectra/                  # Spectra repartition and compatibility merkle data
│   │   └── vlCVX/                    # vlCVX repartitions, APRs, and merkles
│   └── latest/                       # Current published copies consumed by claim UIs/contracts
│       ├── merkle.json
│       ├── delegationsAPRs.json
│       ├── sdTkns/sdtkns_merkle_{chainId}.json
│       └── vlCVX/
├── data/                             # Indexed delegation data, metadata, and extra merkles
├── script/
│   ├── reports/                      # Report generation
│   ├── sdTkns/                       # sdToken merkle generation and claim fetchers
│   ├── special-distribs/             # One-off extra distribution scripts
│   ├── spectra/                      # Spectra report and repartition steps
│   ├── utils/                        # Shared utilities
│   ├── verify/                       # Automated verification and LLM triage
│   └── vlCVX/                        # vlCVX distribution pipeline
└── weekly-bounties/                  # Claimed rewards fetched from external platforms
```

## Setup

```bash
pnpm install
cp .env.example .env
```

Fill the RPC/API keys needed by the pipeline you are running. Common variables are `WEB3_ALCHEMY_API_KEY`, `EXPLORER_KEY`, `ETHERSCAN_TOKEN`, `BOTS_ENVIO_GRAPHQL_URL_WORKER`, and Telegram variables for notification scripts.

## Common Commands

```bash
# Legacy sdToken merkle
pnpm sd-merkle

# Universal sdFXS and sdSpectra merkles
pnpm sd-merkle:frax
pnpm spectra-report
pnpm spectra-repartition
pnpm sd-merkle:spectra

# vlCVX report, repartition, and merkles
make -f automation/reports.mk run-weekly-vlcvx
make -f automation/distribution.mk run-repartition PROTOCOL=vlCVX
make -f automation/distribution.mk run-merkles PROTOCOL=vlCVX TYPE=non-delegators
make -f automation/distribution.mk run-merkles PROTOCOL=vlCVX TYPE=delegators

# Tests
pnpm test
pnpm test:unit
pnpm test:integration
```

## Report Exclusions

- Add persistent exclusions per protocol in `data/excluded-transactions.json`. Entries can be plain hashes or objects with `hash`, optional `note`, and optional `periods`, `startPeriod`, or `endPeriod`.
- Add ad-hoc exclusions with `--exclude-tx`: `pnpm tsx script/reports/generateReport.ts curve --exclude-tx 0xabc...`.
- Load exclusions from a file with `--exclude-tx-file`.
- Use `--no-default-exclusions` to ignore `data/excluded-transactions.json` for one run.

## GitHub Workflows

Current workflow entry points are:

- `Claims` - fetches claimed rewards into `weekly-bounties/`.
- `Reports` - generates weekly and OTC CSV reports.
- `sdTokens: Verify Reports` - verifies sdToken report inputs.
- `sdTokens: Merkle` - runs and publishes legacy, sdFXS, and sdSpectra merkle steps.
- `vlCVX: Distribution` - runs vlCVX repartition, merkle, verification, and publish steps.
- `Compute APR` - recomputes latest vlCVX APR files.
- `System: Index Delegators` - refreshes delegation caches.

## Claude Commands

Reusable Claude commands live in `.claude/commands/`:

- `/verify-distrib` verifies vlCVX distribution files.
- `/verify-votemarket` verifies bounty report CSVs, attribution files, and claimed rewards.

## Documentation

- [Script overview](./script/README.md)
- [Reports directory](./bounties-reports/README.md)
- [Latest published files](./bounties-reports/latest/README.md)
- [Raw token distributions](./README-raw-tokens.md)
- [Verification pipeline](./script/verify/README.md)
