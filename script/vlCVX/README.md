# vlCVX Rewards Distribution Process

This document outlines the process for distributing rewards to vlCVX voters and delegators.

## Process Overview

0. **Claims rewards from Votium** (Wednesday)
   - Claims forwarded rewards from Votium for delegators who opted to forward their rewards
   - This happens one day before Votemarket claims

1. **Claims rewards from Votemarket** (Thursday) (`claims/generateConvexVotemarket.ts` and `claims/generateConvexVotemarketV2.ts`)
   - Fetches claimed bounties from Votemarket v1 and v2
   - Saves data to JSON files for further processing

2. **Generates report (rewards / gauges)** (`1_report.ts`)
   - Processes claimed bounties data
   - Creates a CSV report with reward details per gauge
   - Saves report to `bounties-reports/{timestamp}/cvx.csv`

3. **Generates repartition data** (`2_repartition/index.ts`)
   - Calculates distribution for non-delegators (`2_repartition/nonDelegators.ts`)
   - Calculates distribution for delegators (`2_repartition/delegators.ts`)
   - Handles forwarding status on Votium for delegators
   - Saves data to:
     - `bounties-reports/{timestamp}/vlCVX/repartition.json` (and chain-specific variants)
     - `bounties-reports/{timestamp}/vlCVX/repartition_delegation.json` (and chain-specific variants)

4. **Swaps forwarded delegators rewards to crvUSD** (handled by automation-jobs)

5. **Generates Merkle trees** (`3_merkles.ts`)
   - For vlCVX voters: `3_merkles/createCombinedMerkle.ts`
     - Processes distribution data across multiple chains
     - Generates chain-specific Merkle trees
     - Taking also into account delegators non-forwarded rewards + SDT for them
   - For delegators: `3_merkles/createDelegatorsMerkle.ts`
     - Computes crvUSD amounts for delegators using shares from `repartition_delegation.json`
     - Generates a separate Merkle tree for delegators
   - Saves Merkle data to:
     - `bounties-reports/{timestamp}/vlCVX/merkle_data_{CHAIN_ID}.json`
     - `bounties-reports/{timestamp}/vlCVX/merkle_data_delegators.json`

6. **Withdraws funds to respective Merkle contracts** (handled by automation-jobs)

7. **Sets Merkle roots for distribution** (handled by automation-jobs)
   - Thursday: Distributes unprocessed rewards (non-delegators + non-forwarded ones)
   - Tuesday: Distributes swapped rewards (for delegators who forwarded their Votium rewards)

8. **Copies Merkle data to latest directory** (GitHub workflow: `copy-vlCVX-merkle.yaml`)
   - Copies temporary Merkle data to `bounties-reports/latest/vlCVX_merkle.json`
   - Computes and publishes APR (non-delegators on Thursday, delegators on Tuesday)