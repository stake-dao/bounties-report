# Raw Token Distribution Feature

This feature allows distributing raw tokens (like CRV, BAL, etc.) alongside the existing sdToken distributions, using the same Snapshot voting mechanism.

## How It Works

1. **Directory Structure**: Raw token reports are placed in `bounties-reports/{WEEK}/raw/{protocol}/` directories
2. **CSV Format**: The CSV files must include the following columns:
   - `gauge address`: The gauge/pool address receiving rewards
   - `reward token`: The token contract address to distribute
   - `reward amount`: The amount of tokens to distribute
   - `space` (or `snapshot space`): The Snapshot space (e.g., `sdcrv.eth`) whose voting rules determine distribution

3. **Processing**: The system will:
   - Read all CSV files from `raw/` subdirectories
   - Group distributions by token address and space
   - Create separate merkle trees for each unique token
   - Use the same voting rules as the specified space

## Example CSV

File: `bounties-reports/1748476800/raw/curve/curve.csv`

```csv
gauge address;reward token;reward amount;space
0x7E1444BA99dcdFfE8fBdb42C02fb0005009e961A;0xD533a949740bb3306d119CC777fa900bA034cd52;1000;sdcrv.eth
0x4e6bB6B7447B7B2Aa268C16AB87F4Bb48BF57939;0xD533a949740bb3306d119CC777fa900bA034cd52;2000;sdcrv.eth
```

This example distributes:
- 1000 CRV tokens to gauge `0x7E1444BA99dcdFfE8fBdb42C02fb0005009e961A`
- 2000 CRV tokens to gauge `0x4e6bB6B7447B7B2Aa268C16AB87F4Bb48BF57939`

The distribution follows the voting rules of `sdcrv.eth` space.

## Key Features

- **Multiple Tokens**: You can distribute different tokens in the same CSV file
- **Multiple Spaces**: Different rows can reference different spaces
- **Coexistence**: Raw token distributions work alongside existing sdToken distributions
- **Same Infrastructure**: Uses the same merkle tree and claiming infrastructure

## Implementation Details

- Raw tokens are distributed using the `overrideTokenAddress` parameter in `createMerkle`
- Each unique token gets its own merkle tree
- The system groups distributions by both token address AND space
- No changes to the existing sdToken distribution system

## Notes

- The `Reward sd Value` column is NOT used for raw tokens
- Token symbols are temporarily generated as `RAW_{address}` - ideally fetch from chain
- The system validates that the space exists and has an active proposal
