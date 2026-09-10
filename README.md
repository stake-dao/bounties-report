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

### IPFS evidence pins

Every merkle step pins the files a verifier needs to IPFS through `script/helpers/pinToIpfs.ts`, one Pinata pin per file with a CIDv0, so they stay readable while `raw.githubusercontent.com` is down. Each pin carries the keyvalues `repo`, `pipeline`, `period`, `path` (repo-relative) and `sha256`, so a reader lists `GET https://api.pinata.cloud/v3/files/public?keyvalues[pipeline]=sdtokens&keyvalues[period]=<timestamp>&limit=50` without GitHub, fetches `<gateway>/ipfs/<cid>` and checks the hash. The same map lands in `bounties-reports/{timestamp}/ipfs/{pipeline}.json` (one file per pipeline, so concurrent runs never conflict) together with `ipfsHash`, the bytes32 a URD `submitRoot(root, ipfsHash)` slot takes (the CIDv0 minus its `0x1220` prefix). Pinned sets: sdtokens (tree, distribution, `log.json`, curve/fxn CSVs and attributions, the two `merkle_updates` entries), vlCVX voters (`vlcvx_merkle*.json`), vlCVX delegators (`merkle_data_delegators.json`), the sdSpectra and sdFXS trees. The step needs the `PINATA_JWT` secret (legacy scope `pinFileToIPFS`) and skips with a warning when it is unset.

A push of those maps triggers `IPFS: evidence index`, the single writer that pins a browsable index (`index.json`, `index.html`) built from every map and commits its CID and EIP-1577 contenthash to `data/ipfs-index.json`. automation-jobs' `ens_publish` job (`[Bribes] ENS Publish - rewards.stakedao.eth`, dispatched by that workflow) mirrors that pointer into the contenthash of `rewards.stakedao.eth`, so `https://rewards.stakedao.eth.limo/` and any ENS-aware client reach the evidence without GitHub or a Pinata key. With `PINNING_SERVICE_URL` (variable, e.g. `https://api.filebase.io/v1/ipfs`) and `PINNING_SERVICE_TOKEN` (secret) set, every CID is replicated on that second provider through the IPFS Pinning Service API.

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
