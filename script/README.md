# Script Directory Overview

This directory contains all the core logic for processing and distributing rewards across Stake DAO's ecosystem.

## 📁 Directory Structure

### Distribution Systems

#### **[/sdTkns](./sdTkns/README.md)**
Main distribution system for sdToken rewards
- Processes voting incentives from multiple platforms
- Generates merkle trees for on-chain distribution
- Supports both sdTokens and raw token distributions

#### **[/vlCVX](./vlCVX/README.md)**
vlCVX reward distribution system
- Multi-chain support (Ethereum, Arbitrum, Base)
- Delegator reward processing
- Separate merkle trees per chain

#### **[/spectra](./spectra/README.md)**
Spectra protocol integration
- Custom reward calculations
- Protocol-specific distribution logic

### Supporting Modules

#### **[/utils](./utils/README.md)**
Shared utilities and helpers
- Constants and configuration
- Merkle tree generation
- CSV parsing and validation
- Blockchain integrations

#### **/reports**
Report generation scripts
- `generateReport.ts` - Main report generator
- `generateBSCReport.ts` - BSC-specific reports
- `generatePendleReport.ts` - Pendle protocol reports
- `generateOTCReport.ts` - OTC distribution reports

#### **/indexer**
Blockchain data indexing
- Delegation tracking
- Historical data processing
- Event monitoring

#### **/interfaces**
TypeScript interfaces and types
- Distribution data structures
- Merkle tree types
- API response types

## 🔧 Key Scripts

### Distribution Generation

```bash
# Generate sdToken distributions
ts-node script/sdTkns/generateMerkle.ts

# Generate vlCVX distributions
ts-node script/vlCVX/1_report.ts
ts-node script/vlCVX/2_repartition.ts
ts-node script/vlCVX/3_merkles.ts

# Generate Spectra distributions
ts-node script/spectra/1_report.ts
ts-node script/spectra/2_repartition.ts
ts-node script/spectra/3_merkles.ts
```

### Report Generation

```bash
# Generate protocol reports (supports: curve, balancer, fxn, frax, pendle)
ts-node script/reports/generateReport.ts curve
ts-node script/reports/generateReport.ts balancer
ts-node script/reports/generateReport.ts fxn
ts-node script/reports/generateReport.ts frax

# For Pendle, run BOTH scripts (order matters)
ts-node script/reports/generatePendleReport.ts     # USDT fee recipient rewards
ts-node script/reports/generateReport.ts pendle    # Non-USDT VM bounties
```

## 🏗️ Architecture

### Data Flow

```
1. Reports (CSV) → 2. Processing → 3. Merkle Trees → 4. On-chain
     ↓                   ↓              ↓                ↓
generateReport    generateMerkle   merkle.json    Smart Contracts
```

### Module Dependencies

```
sdTkns/
  ├── uses → utils/
  ├── uses → reports/
  └── outputs → bounties-reports/

vlCVX/
  ├── uses → utils/
  ├── uses → indexer/
  └── outputs → bounties-reports/

utils/
  ├── constants.ts (configuration)
  ├── snapshot.ts (governance data)
  └── merkle.ts (tree generation)
```

## 🔌 External Integrations

- **Snapshot.org** - Governance proposal data
- **Votemarket** - Voting incentive data
- **Hidden Hand** - Bribe marketplace data
- **Warden** - Delegation market data

## 📝 Adding New Protocols

1. Update configuration in `utils/constants.ts`
2. Add report generation logic in `reports/`
3. Configure distribution in relevant system (sdTkns/vlCVX/spectra)
4. Test with sample data
5. Deploy and monitor

## 🐛 Debugging

Enable verbose logging:
```bash
DEBUG=true npm run generate-merkle
```

Common log locations:
- `log.json` - sdToken distribution logs

## 📚 Further Reading

- [sdToken System Architecture](./sdTkns/README.md)
- [vlCVX Distribution Details](./vlCVX/README.md)
- [Utility Functions Reference](./utils/README.md)
