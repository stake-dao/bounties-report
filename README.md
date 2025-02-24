# Stake DAO Rewards Distribution

This repository contains the scripts and Merkle trees for distributing rewards across Stake DAO's ecosystem.

## Overview

The repository handles three main types of reward distributions:

1. **sdToken Distribution** - Manages rewards claimed on behalf of sdToken voters by our Liquid Lockers on Votemarket
   - Handles distribution of rewards to sdToken holders
   - Manages delegation APRs and reward sharing

2. **vlCVX Distribution** - Manages rewards for vlCVX voters and delegators from Votemarket
   - [View vlCVX Distribution Documentation](script/vlCVX/README.md)
   - Handles both direct voter rewards and delegator distributions

3. **Spectra Distribution** - Manages Spectra protocol reward distributions
   - Handles protocol-specific reward calculations and distributions

## Purpose

- Generate and store Merkle trees for reward distributions
- Provide verification tools for distribution calculations
- Handle delegation-based reward sharing
- Automate reward claiming and distribution processes

## Key Components

- Merkle tree generation scripts
- Distribution calculation logic
- Reward claiming automation
- Verification and reporting tools

## Repository Structure

```
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

## Distribution Process

All distribution files are automatically processed and updated through GitHub Actions workflows:
- `copy-sdtkns-merkle` for sdToken distributions
- `copy-spectra-merkle` for Spectra protocol distributions
- Dedicated merkle generation scripts for vlCVX distributions

The latest distribution files are always available in the `bounties-reports/latest/` directory.
