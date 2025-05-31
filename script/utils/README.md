# Utilities Documentation

This directory contains shared utilities and helper functions used across the distribution system.

## 📁 File Structure

### Core Files

#### **constants.ts**
Central configuration file containing:
- Protocol mappings and addresses
- Space configurations
- Network settings
- Token addresses

Key exports:
```typescript
export const SPACES = [SDCRV_SPACE, SDBAL_SPACE, ...];
export const SPACES_TOKENS: Record<string, string>;
export const SPACE_TO_NETWORK: Record<string, string>;
export const LABELS_TO_SPACE: Record<string, string>;
```

#### **utils.ts**
Core utility functions including:
- `extractCSV()` - Parse distribution CSV files
- `extractAllRawTokenCSVs()` - Parse raw token distributions
- `checkSpace()` - Validate space configuration
- `getTokenPrice()` - Fetch token prices

#### **createMerkle.ts**
Merkle tree generation logic:
```typescript
export const createMerkle = async (
  ids: string[],          // Proposal IDs
  space: string,          // Snapshot space
  lastMerkles: any,       // Previous merkles for unclaimed rewards
  csvResult: any,         // Distribution data
  // ... additional parameters
  overrideTokenAddress?: string  // For raw token distributions
): Promise<MerkleStat>
```

### Helper Modules

#### **snapshot.ts**
Snapshot.org integration:
- Fetch proposals
- Get voting results
- Query voting power

#### **reportUtils.ts**
Report generation utilities:
- Protocol token mappings
- Report formatting helpers

#### **merkle.ts**
Merkle tree utilities:
- Tree construction
- Proof generation
- Root calculation

#### **delegationHelper.ts**
Delegation management:
- Process delegations
- Calculate delegator shares
- Track delegation changes

#### **priceUtils.ts**
Token price fetching:
- CoinGecko integration
- DeFiLlama price feeds
- Historical price data

#### **contractRegistry.ts**
Smart contract addresses:
- Merkle distributors
- Token contracts
- Protocol contracts

## 🔧 Key Functions

### CSV Processing

```typescript
// Extract standard CSV
const csvData = await extractCSV(timestamp, space);

// Extract raw token CSV
const rawTokens = await extractAllRawTokenCSVs(timestamp);
```

### Merkle Generation

```typescript
// Create merkle tree
const merkleStat = await createMerkle(
  proposalIds,
  space,
  lastMerkles,
  distributions
);
```

### Snapshot Integration

```typescript
// Fetch latest proposals
const proposals = await fetchLastProposalsIds(spaces, timestamp, filter);

// Get voting power
const votingPower = await getVotingPower(proposal, voters, chainId);
```

## 📊 Type Definitions

### Distribution Types

```typescript
export type RawTokenDistribution = {
  gauge: string;     // Gauge address
  token: string;     // Token to distribute
  amount: number;    // Amount to distribute
  space: string;     // Snapshot space
};

export type MerkleStat = {
  apr: number;
  merkle: Merkle;
  logs: Log[];
};
```

### CSV Types

```typescript
export type OtherCSVType = Record<string, number>;
export type PendleCSVType = Record<string, Record<string, number>>;
export type CvxCSVType = Record<string, CvxReward[]>;
```

## 🔌 External Integrations

### Price Feeds
- **CoinGecko**: General token prices
- **DeFiLlama**: DeFi token prices
- **Curve API**: Pool-specific data

### Blockchain Data
- **Viem**: Ethereum interactions
- **Ethers**: Legacy compatibility
- **Multicall**: Batch RPC calls

## 🚀 Usage Examples

### Adding a New Protocol

1. Update `constants.ts`:
```typescript
export const SDNEW_SPACE = "sdnew.eth";
export const SD_NEW = "0x..."; // Token address

// Add to mappings
SPACES.push(SDNEW_SPACE);
SPACES_TOKENS[SDNEW_SPACE] = SD_NEW;
SPACE_TO_NETWORK[SDNEW_SPACE] = ETHEREUM;
```

2. Configure in `reportUtils.ts`:
```typescript
PROTOCOLS_TOKENS["new"] = {
  native: "0x...",
  sdToken: SD_NEW
};
```

### Processing Raw Tokens

```typescript
// Extract raw token distributions
const rawDistributions = await extractAllRawTokenCSVs(timestamp);

// Group by token and space
const grouped = groupDistributionsByToken(rawDistributions);

// Create merkle with override token
const merkle = await createMerkle(
  proposalIds,
  space,
  lastMerkles,
  distributions,
  undefined,
  undefined,
  undefined,
  {},
  rawTokenAddress // Override token
);
```

## 🔍 Debugging

Enable debug logging:
```typescript
if (process.env.DEBUG) {
  console.log("Debug info:", data);
}
```

Common issues:
- Missing space configuration
- Invalid CSV format
- Network connection errors
- Missing proposal data

## 🧪 Testing

Test utilities:
```bash
npm test -- script/utils
```

Mock data available in `test/helpers.ts`