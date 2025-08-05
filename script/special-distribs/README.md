# Pendle Extra Distributions

This script processes Pendle reward distributions for Stake DAO's delegation address and redistributes them to individual holders based on their time-weighted positions.

## How it works

1. **Fetches Pendle campaigns** from their GitHub repository that include rewards for Stake DAO's delegation address (`0x52ea58f4FC3CEd48fa18E909226c1f8A0EF887DC`)

2. **Gets holder data** from Stake DAO's API for each campaign period

3. **Calculates rewards using TWAP** (Time-Weighted Average Position):
   - Users who hold for the full period get 100% of their proportional share
   - Users who exit early get proportionally less
   - Example: If you hold 100 tokens for half the period, you get half the rewards compared to someone who holds 100 tokens for the full period

4. **Applies 15% fee** on total rewards before distribution

5. **Generates a Merkle tree** for efficient claiming

## Running the script

```bash
npm run pendle-extra
```

## Output

The script generates a distribution file in `data/pendle-extra/` containing:
- Merkle root for on-chain verification
- Individual user claims with amounts and proofs
- Summary of total distributions per token