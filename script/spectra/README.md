# Spectra Rewards Distribution Process

This directory contains scripts for managing the distribution of rewards for Spectra voters and delegators.

## Process Overview

1. **Claims rewards from Spectra Safe Module** (handled by automation-jobs)
   - Fetches claimed bounties from the Spectra Safe Module on Base
   - Tracks rewards across multiple chains
   - Funds are directly sent to the Merkle (for now, no swap)

2. **Generates report (rewards / gauges)** (`1_report.ts`)
   - Processes claimed bounties data
   - Creates a CSV report with reward details per gauge
   - Saves report to `bounties-reports/{timestamp}/spectra.csv`

3. **Generates repartition data** (`2_repartition.ts`)
   - Fetches the latest Snapshot proposal from Spectra space
   - Calculates distribution based on voting power and choices
   - Handles StakeDAO delegators distribution
   - Computes delegation APR for analytics
   - Saves data to:
     - `bounties-reports/{timestamp}/spectra/repartition.json`

4. **Generates Merkle trees** (`3_merkles.ts`)
   - Combines current distribution with previous unclaimed amounts
   - Generates Merkle tree for all eligible recipients
   - Compares with previous distribution for verification
   - Saves Merkle data to:
     - `bounties-reports/{timestamp}/spectra/merkle_data.json`
     - `bounties-reports/latest/spectra/merkle_data_tmp.json`


5. **Sets Merkle root for distribution** (handled by automation-jobs)

6. **Copies Merkle data to latest directory** (GitHub workflow: `copy-spectra-merkle.yaml`)
   - Copies temporary Merkle data to `bounties-reports/latest/spectra_merkle.json`
   - Removes the temporary file after copying
