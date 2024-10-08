# vlCVX Distribution Script

This directory contains scripts for managing the distribution of rewards for vlCVX voters and delegators.

## Process Overview
[![](https://mermaid.ink/img/pako:eNqVU12PmzAQ_CuW77GOmkvUh3BSJSCXJlIr5aNKq0AenHhJ3GCMbHNpdbr_3gXTFqpUuoIEhp2ZHXvsZ3rUAmhAT4aXZ_J5mhYErzCJcy4VMXDlRliiC7LVDhQ3F3B7Mhi8J1HyARwCSm6cdBIRJRji9AWKtydenWDvpaIGHSO6AMMd9CiZNuQpj7dfyRsiIIcTd9rYlumfccOfJZsrL728xRexIl5vW-CsgcyTWKuywg5NjXClq8I1rn5L95TnDW3xx9knMJcciDMAtmPtCWduLOGF-JfHRaO0TL5IdxaGX0lmtGrZBo6ylIBO0LXyHcJ9l7d6NS_qdV027HWyqXPQ2nnPf7VYNaDNbVBfz1YHvwtSuoZSW4nzlGBT6su7-4RXTiteJzf4pg-_1mA3Sg71UiN2gOFq49oCFKKrf8y5tVPI6h2gQ5LJPA_uJsPHx8mQWWcw2uBuPB6348FVCncORuX3hxv0qKXPZuG74f_RMUE01vKzSX2_ht9RISGbsSVbsTXb-Ml0e5CIxWzOFt5nr7K7vwHfjW4gP3qT3usDZRQTU1wKPKnPNS6l7gwKUhrgUEDGq9zVQb0gtE5p86M40sCZChg1ujqdaZDx3OJXVQrc61PJMWvV_n35CZHFTIk?type=png)](https://mermaid.live/edit#pako:eNqVU12PmzAQ_CuW77GOmkvUh3BSJSCXJlIr5aNKq0AenHhJ3GCMbHNpdbr_3gXTFqpUuoIEhp2ZHXvsZ3rUAmhAT4aXZ_J5mhYErzCJcy4VMXDlRliiC7LVDhQ3F3B7Mhi8J1HyARwCSm6cdBIRJRji9AWKtydenWDvpaIGHSO6AMMd9CiZNuQpj7dfyRsiIIcTd9rYlumfccOfJZsrL728xRexIl5vW-CsgcyTWKuywg5NjXClq8I1rn5L95TnDW3xx9knMJcciDMAtmPtCWduLOGF-JfHRaO0TL5IdxaGX0lmtGrZBo6ylIBO0LXyHcJ9l7d6NS_qdV027HWyqXPQ2nnPf7VYNaDNbVBfz1YHvwtSuoZSW4nzlGBT6su7-4RXTiteJzf4pg-_1mA3Sg71UiN2gOFq49oCFKKrf8y5tVPI6h2gQ5LJPA_uJsPHx8mQWWcw2uBuPB6348FVCncORuX3hxv0qKXPZuG74f_RMUE01vKzSX2_ht9RISGbsSVbsTXb-Ml0e5CIxWzOFt5nr7K7vwHfjW4gP3qT3usDZRQTU1wKPKnPNS6l7gwKUhrgUEDGq9zVQb0gtE5p86M40sCZChg1ujqdaZDx3OJXVQrc61PJMWvV_n35CZHFTIk)


## Description

This is the process of distributing Votemarket rewards to vlCVX voters and Stake DAO delegators on vlCVX. It performs the following key steps:

1. Claims rewards from Votemarket (`automation-jobs`)
2. Calculates the repartition of rewards per token and gauge (`distribution/generateBounties`)
3. Generates repartition data for vlCVX voters and delegators (`1_generateBountieesReport`)
4. Swaps tokens to sdCRV (`automation-jobs`)
5. Computes sdCRV amounts for delegators (`3_generateMerkles`)
6. Generates Merkle trees for both vlCVX voters and delegators (`3_generateMerkles`)
7. Withdraws funds to respective Merkle distributors (`automation-jobs`)
8. Sets Merkle roots for distribution (`automation-jobs`)

The process involves interactions with two repositories:
- `automation-jobs` (green): Handles automated tasks like claiming rewards and token swaps
- `bounties-report` (orange): Manages repartition calculations, Merkle tree generation, and distribution setup.