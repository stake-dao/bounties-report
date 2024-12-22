# Stake DAO Rewards Distribution

This repository contains the scripts and merkle trees used for distributing rewards across Stake DAO's ecosystem.

## Overview

The repository handles two main types of reward distributions:

1. **sdToken Distribution** - Manages rewards claim on behalf of sdToken voters, by our Liquid Lockers, on Votemarket (documentation in progress)

2. **vlCVX Distribution** - Manages rewards for vlCVX voters and delegators from Votemarket
   - [View vlCVX Distribution Documentation](script/vlCVX/README.md)


## Purpose

- Generate and store merkle trees for reward distributions
- Provide verification tools for distribution calculations
- Handle delegation-based reward sharing

## Key Components

- Merkle tree generation scripts
- Distribution calculation logic
- Reward claiming automation
- Verification and reporting tools

## Repository Structure

```
.
├── proposalHelper.ts # Script to check gauges, votes in Snapshot
├── bounties-reports/ # Weekly distribution reports
├── weekly_bounties/ # Information about claimed bounties on Votemarket (liquid lockers + external protocols)
├── data/ # Indexed blockchain data in parquet format for easier script processing
├── merkle.json # Current sdToken merkle tree
├── log.json # sdToken distribution logs
├── delegationAPRs.json # Delegation APRs for sdToken
├── script/
│ ├── vlCVX/ # vlCVX distribution scripts
│ └── sdTkns/ # sdToken distribution scripts
│ └── indexer/ # Fetching data from blockchain and storing it in data/
│ └── repartition/sdTkns/reportVerifier.ts # sdToken distribution verification script
│ └── reports/ # Generating reports (claimed bounties)
│ └── utils/ # Utility scripts
```
