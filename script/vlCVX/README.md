# vlCVX Distribution Script

This directory contains scripts for managing the distribution of rewards for vlCVX voters and delegators.

## Process Overview
[![](https://mermaid.ink/img/pako:eNqVU12PmzAQ_CuW77GOmkvUh3BSJSCXJlIr5aNKq0AenHhJ3GCMbHNpdbr_3gXTFqpUuoIEhp2ZHXvsZ3rUAmhAT4aXZ_J5mhYErzCJcy4VMXDlRliiC7LVDhQ3F3B7Mhi8J1HyARwCSm6cdBIRJRji9AWKtydenWDvpaIGHSO6AMMd9CiZNuQpj7dfyRsiIIcTd9rYlumfccOfJZsrL728xRexIl5vW-CsgcyTWKuywg5NjXClq8I1rn5L95TnDW3xx9knMJcciDMAtmPtCWduLOGF-JfHRaO0TL5IdxaGX0lmtGrZBo6ylIBO0LXyHcJ9l7d6NS_qdV027HWyqXPQ2nnPf7VYNaDNbVBfz1YHvwtSuoZSW4nzlGBT6su7-4RXTiteJzf4pg-_1mA3Sg71UiN2gOFq49oCFKKrf8y5tVPI6h2gQ5LJPA_uJsPHx8mQWWcw2uBuPB6348FVCncORuX3hxv0qKXPZuG74f_RMUE01vKzSX2_ht9RISGbsSVbsTXb-Ml0e5CIxWzOFt5nr7K7vwHfjW4gP3qT3usDZRQTU1wKPKnPNS6l7gwKUhrgUEDGq9zVQb0gtE5p86M40sCZChg1ujqdaZDx3OJXVQrc61PJMWvV_n35CZHFTIk?type=png)](https://mermaid.live/edit#pako:eNqVU12PmzAQ_CuW77GOmkvUh3BSJSCXJlIr5aNKq0AenHhJ3GCMbHNpdbr_3gXTFqpUuoIEhp2ZHXvsZ3rUAmhAT4aXZ_J5mhYErzCJcy4VMXDlRliiC7LVDhQ3F3B7Mhi8J1HyARwCSm6cdBIRJRji9AWKtydenWDvpaIGHSO6AMMd9CiZNuQpj7dfyRsiIIcTd9rYlumfccOfJZsrL728xRexIl5vW-CsgcyTWKuywg5NjXClq8I1rn5L95TnDW3xx9knMJcciDMAtmPtCWduLOGF-JfHRaO0TL5IdxaGX0lmtGrZBo6ylIBO0LXyHcJ9l7d6NS_qdV027HWyqXPQ2nnPf7VYNaDNbVBfz1YHvwtSuoZSW4nzlGBT6su7-4RXTiteJzf4pg-_1mA3Sg71UiN2gOFq49oCFKKrf8y5tVPI6h2gQ5LJPA_uJsPHx8mQWWcw2uBuPB6348FVCncORuX3hxv0qKXPZuG74f_RMUE01vKzSX2_ht9RISGbsSVbsTXb-Ml0e5CIxWzOFt5nr7K7vwHfjW4gP3qT3usDZRQTU1wKPKnPNS6l7gwKUhrgUEDGq9zVQb0gtE5p86M40sCZChg1ujqdaZDx3OJXVQrc61PJMWvV_n35CZHFTIk)


## Description

This is the process of distributing Votemarket rewards to vlCVX voters and Stake DAO delegators on vlCVX. It performs the following key steps:

*All the files are stored in `bounties-reports/{timestamp}/vlCVX/`*

1. Claims rewards from Votemarket (`automation-jobs`)
2. Calculates the repartition of rewards per token and gauge (`distribution/generateBounties`)
3. Generates report (rewards / gauges) (`1_report.ts`)
4. Generates repartition data for vlCVX voters and delegators (`2_repartition.ts`)
5. Swaps tokens to sdCRV (`automation-jobs`)
6. Computes sdCRV amounts for delegators, using shares present in `repartition_delegation.json` (`3_generateMerkles`)
7. Generates Merkle trees for both vlCVX voters and delegators (`3_generateMerkles`) => `merkle_data.json`
8. Withdraws funds to respective Merkle contracts (`automation-jobs`)
9. Sets Merkle roots for distribution (`automation-jobs`)

The process involves interactions with two repositories:
- `automation-jobs` (green): Handles automated tasks like claiming rewards and token swaps
- `bounties-report` (orange): Manages repartition calculations, Merkle tree generation, and distribution setup.

## Verification Tools

### Proposal Helper

A proposal helper script is available to verify voter participation and voting power distribution. You can use it to analyze specific gauges in a proposal:

```bash
pnpm tsx script/proposalHelper.ts --proposalId <PROPOSAL_ID> --gauges <GAUGE_ADDRESSES>
```

This script helps verify the correct distribution of rewards by providing detailed information about:
- Voter participation
- Individual voting power
- Delegation details
- Vote distribution across gauges, by linking with snapshot choices

### Distribution Verification

All distribution calculations and Merkle tree generations can be verified through GitHub Actions logs under the `generate-vlcvx-merkles` workflow. These logs provide transparent tracking of reward distributions, including detailed breakdowns by token and recipient.

The process involves interactions with two repositories:
- `automation-jobs` (green): Handles automated tasks like claiming rewards and token swaps
- `bounties-report` (orange): Manages repartition calculations, Merkle tree generation, and distribution setup.