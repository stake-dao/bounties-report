# Stake DAO Rewards Distribution

This repository manages the complete reward distribution system for Stake DAO's liquid lockers and governance participants.

## 🎯 Overview

The system handles multiple types of reward distributions across different protocols and chains:

### 1. **[sdToken Distribution](./script/sdTkns/README.md)**
Manages voting incentives for Stake DAO's liquid locker tokens (sdCRV, sdBAL, sdFXS, etc.)
- Processes rewards from voting markets (Votemarket, Hidden Hand, Warden)
- Distributes based on Snapshot governance votes
- Supports delegation with automatic reward sharing
- Handles both sdTokens and raw token distributions

### 2. **[vlCVX Distribution](./script/vlCVX/README.md)**
Manages rewards for vlCVX holders across multiple chains
- Processes Convex voting rewards
- Supports multi-chain distributions (Ethereum, Arbitrum, Base)
- Handles delegator reward sharing

### 3. **[Spectra Distribution](./script/spectra/README.md)**
Protocol-specific distributions for Spectra
- Custom reward calculations
- Merkle tree generation for Spectra voters

## 🔧 Key Features

- **Multi-Protocol Support**: Curve, Balancer, Frax, FXN, Pendle, Cake
- **Cross-Chain**: Ethereum, BSC, Base, Arbitrum
- **Delegation System**: Automatic reward distribution to delegators
- **Raw Token Support**: Distribute native tokens (CRV, BAL) alongside sdTokens
- **Automated Workflows**: GitHub Actions for weekly distributions

## 📁 Repository Structure

```text
.
├── bounties-reports/        
│   ├── {timestamp}/        # Weekly distribution reports and calculations
│   │   ├── merkle.json     # sdTokens merkle tree
│   │   ├── delegationsAPRs.json  # Delegation APRs for sdTokens
│   │   ├── vlCVX/         # vlCVX distribution files
│   │   │   ├── repartition.json  # Main distribution data
│   │   │   ├── repartition_{chainId}.json  # Chain-specific distributions
│   │   │   ├── repartition_delegation.json  # Delegator shares
│   │   │   ├── merkle_data_non_delegators.json
│   │   │   └── merkle_data_delegators.json
│   │   └── spectra/       # Spectra distribution files
│   │       ├── repartition.json
│   │       └── merkle_data.json
│   │
│   └── latest/            # Current active distribution files
│       ├── merkle.json    # Latest sdTokens merkle tree
│       ├── delegationsAPRs.json  # Current APRs for delegations
│       ├── spectra_merkle.json   # Latest Spectra merkle tree
│       └── vlCVX/         # Latest vlCVX merkle trees
│           ├── vlcvx_merkle.json         # Main distribution
│           ├── vlcvx_merkle_{chainId}.json  # Chain-specific distributions
│           └── vlcvx_merkle_delegators.json # Delegators distribution
│
├── weekly_bounties/        # Claimed rewards from Votemarket
│                          # (liquid lockers + external protocols)
│
├── script/
│   ├── vlCVX/            # vlCVX distribution scripts
│   │   ├── 1_report.ts   # Generate rewards/gauges report
│   │   ├── 2_repartition.ts  # Generate distribution data
│   │   └── 3_merkles.ts  # Generate merkle trees
│   ├── sdTkns/           # sdToken distribution scripts
│   ├── spectra/          # Spectra protocol distribution scripts
│   ├── indexer/          # Blockchain data indexing
│   ├── repartition/      # Distribution calculation logic
│   ├── reports/          # Report generation
│   └── utils/            # Shared utilities
│
├── data/                  # Indexed blockchain data (parquet format)
├── merkle.json           # Current sdToken merkle tree
├── log.json              # sdToken distribution logs
└── proposalHelper.ts     # Script to verify votes in Snapshot
```

This structure shows:
1. Weekly timestamp-based folders with all calculation data
2. The `latest` directory with current merkle trees used by contracts
3. Complete distribution process files (reports, repartition, merkles)
4. Supporting scripts and utilities for each protocol

## 📚 Documentation

### Core Systems
- **[sdToken Distribution Guide](./script/sdTkns/README.md)** - Complete guide for sdToken distributions
- **[vlCVX Distribution Guide](./script/vlCVX/README.md)** - vlCVX reward distribution system
- **[Spectra Distribution Guide](./script/spectra/README.md)** - Spectra protocol integration

### Technical References
- **[Utilities Documentation](./script/utils/README.md)** - Shared functions and helpers
- **[Reports Structure](./bounties-reports/README.md)** - Understanding distribution reports
- **[Raw Token Guide](./README-raw-tokens.md)** - Distributing native tokens

## 🚀 Quick Start

### Installation
```bash
# Clone the repository
git clone https://github.com/stake-dao/bounties-report.git

# Install dependencies
npm install
```

### Generate Distributions
```bash
# Generate sdToken merkle trees
npm run generate-merkle

# Generate vlCVX distributions
npm run vlcvx:all

# Generate Spectra distributions
npm run spectra:all
```

### Excluding Transactions From Reports
- Add persistent exclusions per protocol by editing `data/excluded-transactions.json`. Each entry can be a plain hash string or an object with `hash`, optional `note`, and optional `periods/startPeriod/endPeriod` filters (UNIX week start).
- Pass ad-hoc hashes on the CLI: `pnpm tsx script/reports/generateReport.ts curve --exclude-tx 0xabc... --exclude-tx 0xdef...`
- Or load them from a file (newline/comma-separated list or JSON): `pnpm tsx script/reports/generateReport.ts curve --exclude-tx-file ./my-txs.txt`.
- Use `--no-default-exclusions` when you want to ignore the shared `data/excluded-transactions.json` file for a specific run.

## 🔄 Distribution Process

The distribution process runs weekly through automated workflows:

1. **Thursday 00:00 UTC** - New distribution period begins
2. **Bounty Collection** - Platforms report voting incentives
3. **Report Generation** - Create CSV files for each protocol
4. **Merkle Generation** - Build merkle trees for efficient claiming
5. **Deployment** - Update contracts with new merkle roots

### GitHub Actions Workflows
- `copy-sdtkns-merkle` - Processes sdToken distributions
- `copy-spectra-merkle` - Handles Spectra protocol
- `vlcvx-merkle-generation` - Manages vlCVX rewards

Latest distributions are always available in `bounties-reports/latest/`.

## 🧪 Testing

WIP
