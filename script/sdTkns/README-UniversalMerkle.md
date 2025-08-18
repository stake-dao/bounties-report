# Universal Merkle for sdTokens

## Overview

sdToken rewards can now be distributed using the Universal Merkle system, which allows users to claim multiple tokens (e.g., sdFXS and FXS) in a single transaction. This system uses shared utilities to reduce code duplication across different protocols.

## Changes from Previous System

1. **sdFXS is excluded from the old merkle generation** (`generateMerkle.ts`)
2. **New Universal Merkle generator** (`generateUniversalMerkleFrax.ts`) processes both:
   - sdFXS rewards from `bounties-reports/{timestamp}/frax.csv`
   - FXS rewards from `bounties-reports/{timestamp}/raw/frax/frax.csv`
3. **Output**: `bounties-reports/{timestamp}/universal_merkle_frax.json`

## File Structure

```
bounties-reports/{timestamp}/
├── frax.csv                    # sdFXS rewards (existing format)
├── raw/
│   └── frax/
│       └── frax.csv            # FXS token rewards
└── universal_merkle_frax.json  # Universal Merkle output
```

## CSV Formats

### frax.csv (sdFXS rewards)
```
Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol
```

### raw/frax/frax.csv (FXS rewards)
```
Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount
```

## Universal Merkle Structure

```json
{
  "merkleRoot": "0x...",
  "claims": {
    "0xUserAddress": {
      "tokens": {
        "0x402F878BDd1f5C66FdAF0fabaBcF74741B68ac36": {  // sdFXS
          "amount": "1000000000000000000",
          "proof": ["0x...", "0x..."]
        },
        "0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0": {  // FXS
          "amount": "500000000000000000",
          "proof": ["0x...", "0x..."]
        }
      }
    }
  }
}
```

## How to Generate

### For sdFXS specifically:
```bash
# Run the Universal Merkle generator
./script/sdTkns/runUniversalMerkleFrax.sh

# Or directly:
npx ts-node script/sdTkns/generateUniversalMerkleFrax.ts
```

### For other sdTokens (when migrated):
```bash
# Generate Universal Merkle for any protocol
npx ts-node script/sdTkns/generateUniversalMerkleGeneric.ts <protocol>

# Available protocols: curve, balancer, angle, pendle, fxn
# Example:
npx ts-node script/sdTkns/generateUniversalMerkleGeneric.ts curve
```

## Shared Architecture

The Universal Merkle system uses shared utilities to avoid code duplication:

1. **`universalMerkleGenerator.ts`** - Core logic for processing rewards and generating merkles
2. **`vlCVX/utils.ts`** - Shared merkle tree generation function
3. **`merkle.ts`** - Distribution combination logic for unclaimed rewards

This architecture is shared with the vlCVX Universal Merkle system, ensuring consistency and maintainability.

## Contract Integration

The Universal Merkle is submitted to the UniversalRewardDistributor contract (address TBD).

Users can claim both sdFXS and FXS tokens in a single transaction by calling:
```solidity
claim(address account, address reward, uint256 claimable, bytes32[] proof)
```

## Benefits

1. **Gas Efficiency**: Single transaction for multiple token claims
2. **Extensibility**: Easy to add more reward tokens
3. **User Experience**: Simpler claiming process
4. **Clean Architecture**: Complete separation from old merkle system