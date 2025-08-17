# Frax Report Generation

## Overview

The Frax protocol report generation has a special behavior compared to other protocols (curve, balancer, fxn):

- **Bounties**: Still fetched from mainnet bounty platforms (Votemarket, Warden, Hidden Hand)
- **sdFXS Amount**: Fetched from Fraxtal chain by monitoring transfers to a specific address

## Key Differences

### Regular Protocols (curve, balancer, fxn)
- Use swap events on mainnet to calculate sdToken amounts
- Process: Bounties → Swaps → Native Token → sdToken conversion

### Frax Protocol
- Bounties are fetched from mainnet (same as others)
- sdFXS amount is determined by transfers on Fraxtal to address: `0xAeB87C92b2E7d3b21fA046Ae1E51E0ebF11A41Af`
- The total sdFXS amount is distributed proportionally across all bounties

## Implementation Details

### 1. Fraxtal sdFXS Fetcher (`fraxtalFetcher.ts`)
- Fetches sdFXS transfers on Fraxtal chain
- Monitors transfers to the designated recipient address
- Returns total amount for the week period

### 2. Generate Report Frax (`generateReportFrax.ts`)
- Fetches bounties from mainnet (same as regular report)
- Gets total sdFXS amount from Fraxtal
- Fetches historical token prices for the period
- Calculates USD value for each bounty
- Distributes sdFXS proportionally based on USD values
- Generates CSV report with calculated sdFXS values

### 3. Chain Configuration
- Fraxtal chain ID: 252
- RPC endpoint: https://rpc.frax.com
- Added to `CHAINS_IDS_TO_SHORTS` constant

## Usage

### Generate Frax Report Only
```bash
npm run report:frax
```

### Generate All Reports (including Frax)
```bash
npm run report:all
```

### Generate Regular Protocol Report
```bash
npx ts-node script/reports/generateReport.ts <protocol>
# Where <protocol> is: curve, balancer, or fxn
```

## CSV Output Format

The output CSV format remains the same as other protocols:
```
Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol
```

The key difference is how "Reward sd Value" is calculated:
- **Regular protocols**: Based on swap conversions
- **Frax**: Based on proportional distribution of Fraxtal sdFXS transfers

## Technical Flow

1. Fetch bounties from mainnet platforms
2. Query Fraxtal for sdFXS transfers to recipient address
3. Fetch historical token prices for each bounty token
4. Calculate USD value for each bounty (amount × price)
5. Distribute sdFXS proportionally based on USD values
6. Generate CSV report

## Example

If the week has:
- Bounty A: 100 USDC (price: $1) = $100
- Bounty B: 50 USDT (price: $1) = $50
- Total sdFXS from Fraxtal: 150

Distribution:
- Bounty A: 100/150 × 150 = 100 sdFXS
- Bounty B: 50/150 × 150 = 50 sdFXS

## Configuration

- **Fraxtal Recipient**: `0xAeB87C92b2E7d3b21fA046Ae1E51E0ebF11A41Af`
- **sdFXS Token Address**: `0x402F878BDd1f5C66FdAF0fabaBcF74741B68ac36` (same on all chains)
- **Fraxtal RPC**: https://rpc.frax.com