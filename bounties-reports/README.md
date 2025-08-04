# Bounties Reports Directory

This directory contains all weekly distribution reports and generated merkle trees organized by timestamp.

## 📁 Directory Structure

```
bounties-reports/
├── {timestamp}/                 # Unix timestamp for each week
│   ├── merkle.json             # sdToken merkle tree
│   ├── delegationsAPRs.json    # Delegation APR calculations
│   ├── {protocol}.csv          # Distribution reports per protocol
│   ├── raw/                    # Raw token distributions
│   │   └── {protocol}/
│   │       └── {protocol}.csv
│   ├── vlCVX/                  # vlCVX specific files
│   ├── spectra/                # Spectra specific files
└── latest/                     # Current active distributions
    ├── merkle.json
    ├── delegationsAPRs.json
    ├── vlCVX/
    └── spectra/
```

## 📅 Timestamp Format

Directories are named using Unix timestamps representing the start of each distribution week:
- Example: `1747872000` = February 22, 2024 00:00:00 UTC
- New directories are created every Thursday at 00:00 UTC

## 📄 File Types

### Protocol CSV Files

Standard format for sdToken distributions:
```csv
gauge address;gauge name;reward token;reward amount;reward sd value
0x7E1444BA99dcdFfE8fBdb42C02fb0005009e961A;sETH/ETH;0x73968b9a57c6E53d41345FD57a6E6ae27d6CDB2F;1000;500
```

### Raw Token CSV Files

Located in `raw/{protocol}/` for native token distributions:
```csv
gauge address;reward token;reward amount;space
0x7E1444BA99dcdFfE8fBdb42C02fb0005009e961A;0xD533a949740bb3306d119CC777fa900bA034cd52;1000;sdcrv.eth
```

### merkle.json

Complete merkle tree data:
```json
[
  {
    "symbol": "sdCRV",
    "address": "0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5",
    "image": "https://...",
    "merkle": {
      "0xuser1": {
        "index": 0,
        "amount": "1000000000000000000",
        "proof": ["0x...", "0x..."]
      }
    },
    "root": "0x...",
    "total": "10000000000000000000000",
    "chainId": 1,
    "merkleContract": "0x03E34b085C52985F6a5D27243F20C84bDdc01Db4"
  }
]
```

### delegationsAPRs.json

APR calculations for each space:
```json
{
  "sdcrv.eth": 25.5,
  "sdbal.eth": 18.3,
  "sdfxs.eth": 22.7
}
```

## 🔄 Latest Directory

The `latest/` directory contains symlinks or copies of the most recent distribution files used by:
- Frontend applications
- Smart contracts
- API endpoints

Files are automatically updated after each weekly distribution.

## 📊 Protocol Files

### Supported Protocols
- **curve.csv** - Curve protocol distributions
- **balancer.csv** - Balancer protocol distributions
- **frax.csv** - Frax protocol distributions
- **fxn.csv** - FXN protocol distributions
- **pendle.csv** - Pendle protocol distributions
- **cake.csv** - PancakeSwap distributions (BSC)

### Special Files
- **pendle-otc.csv** - OTC distributions for Pendle
- **curve-otc.csv** - OTC distributions for Curve

## 🛠️ Generation Process

1. **Thursday 00:00 UTC**: New week begins
2. **Bounty Collection**: Platforms report incentives
3. **CSV Generation**: Create distribution files
4. **Merkle Generation**: Run `generateMerkle.ts`
5. **Verification**: Check distribution accuracy
6. **Deployment**: Update `latest/` directory

## 📝 Data Validation

Each distribution includes:
- Total reward amounts per token
- User allocation details
- Merkle proofs for claiming
- APR calculations

Validation checks:
- Sum of user allocations equals total
- All addresses are valid
- Merkle root is correctly calculated
- Token balances are sufficient

## 🔗 Integration

Frontend integration:
```javascript
// Fetch latest merkle data
const response = await fetch('https://.../bounties-reports/latest/merkle.json');
const merkles = await response.json();

// Get user proof
const userProof = merkles[0].merkle[userAddress];
```

Contract integration:
```solidity
// Claim with merkle proof
merkleDistributor.claim(
    token,
    index,
    account,
    amount,
    merkleProof
);
```

## 📈 Historical Data

Historical distributions are preserved for:
- Audit trails
- Analytics
- Debugging
- User verification

Access historical data:
```bash
# List all weeks
ls -la bounties-reports/

# View specific week
cat bounties-reports/1747872000/merkle.json
```