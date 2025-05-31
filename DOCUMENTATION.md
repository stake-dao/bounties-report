# Documentation Structure

This document provides a map of all documentation in the bounties-report repository.

## 📚 Main Documentation

### Root Level
- **[README.md](./README.md)** - Project overview and quick start guide
- **[README-raw-tokens.md](./README-raw-tokens.md)** - Guide for distributing raw tokens
- **DOCUMENTATION.md** - This file, documentation index

### Core Systems

#### sdToken Distribution
- **[script/sdTkns/README.md](./script/sdTkns/README.md)** - Complete sdToken distribution guide
  - System overview
  - Distribution flow
  - Configuration
  - Usage examples

#### vlCVX Distribution
- **[script/vlCVX/README.md](./script/vlCVX/README.md)** - vlCVX rewards distribution
  - 8-step process overview
  - Multi-chain support
  - Delegator handling

#### Spectra Distribution
- **[script/spectra/README.md](./script/spectra/README.md)** - Spectra protocol integration
  - Base chain distribution
  - Safe module integration
  - Process workflow

### Technical References

#### Script Overview
- **[script/README.md](./script/README.md)** - Script directory guide
  - Directory structure
  - Module dependencies
  - Architecture overview

#### Utilities
- **[script/utils/README.md](./script/utils/README.md)** - Utility functions reference
  - Core files description
  - Type definitions
  - Integration examples

#### Reports Structure
- **[bounties-reports/README.md](./bounties-reports/README.md)** - Distribution reports guide
  - Directory structure
  - File formats
  - Data validation

## 🗺️ Documentation Map

```
Documentation Root
├── General
│   ├── Project Overview (README.md)
│   ├── Raw Tokens Guide (README-raw-tokens.md)
│   └── Documentation Index (DOCUMENTATION.md)
│
├── Distribution Systems
│   ├── sdToken Distribution (script/sdTkns/README.md)
│   ├── vlCVX Distribution (script/vlCVX/README.md)
│   └── Spectra Distribution (script/spectra/README.md)
│
├── Technical Guides
│   ├── Script Overview (script/README.md)
│   ├── Utilities Reference (script/utils/README.md)
│   └── Reports Structure (bounties-reports/README.md)
│
└── Process Flows
    ├── Weekly Distribution Process
    ├── Delegation Handling
    └── Multi-chain Support
```

## 📖 Reading Order for New Contributors

1. **Start Here**: [Main README](./README.md) - Understand the project
2. **Core System**: [sdToken Guide](./script/sdTkns/README.md) - Main distribution logic
3. **Technical Details**: [Utilities Guide](./script/utils/README.md) - Helper functions
4. **Data Structure**: [Reports Guide](./bounties-reports/README.md) - Output formats
5. **Advanced**: [Raw Tokens](./README-raw-tokens.md) - Additional features

## 🔍 Quick Links by Topic

### For Developers
- [Adding New Protocols](./script/utils/README.md#adding-a-new-protocol)
- [Debugging Guide](./script/sdTkns/README.md#error-handling)
- [Testing Documentation](./README.md#-testing)

### For Operations
- [Weekly Process](./README.md#-distribution-process)
- [GitHub Actions](./README.md#github-actions-workflows)
- [Data Validation](./bounties-reports/README.md#-data-validation)

### For Integration
- [Frontend Integration](./bounties-reports/README.md#-integration)
- [Contract Integration](./bounties-reports/README.md#-integration)
- [API Reference](./script/utils/README.md#-external-integrations)

## 📝 Documentation Standards

All documentation follows these guidelines:
- Clear section headers with emoji icons
- Code examples where relevant
- Links to related documentation
- Structured information (tables, lists)
- Process flow diagrams where helpful