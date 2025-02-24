This directory contains the most recent merkle files copied from the distribution process. Files are automatically updated here once distribution is completed on chain.

## Files
- `merkle.json` - Latest sdTokens distribution merkle tree
- `delegationsAPRs.json` - Current delegation APRs for sdTokens distribution
- `spectra_merkle.json` - Latest Spectra protocol distribution merkle tree
- `vlCVX/vlcvx_merkle{nothing or chainId}.json` - Latest vlCVX distribution merkle tree
- `vlCVX/vlcvx_merkle_delegators.json` - Latest vlCVX delegators distribution merkle tree

## Update Process
Files are automatically copied here through GitHub Actions workflows when distributions are processed:
- sdTokens distribution files via `copy-sdtkns-merkle` workflow
- Spectra distribution files via `copy-spectra-merkle` workflow
- vlCVX distribution files via dedicated merkle generation scripts

The files in this directory serve as the current source of truth for active distributions and are used by the claiming contracts.
