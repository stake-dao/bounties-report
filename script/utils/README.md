# Utilities

Shared utilities used by the report, repartition, merkle, indexer, and verification scripts.

## Core Files

- `constants.ts` - contract addresses, Snapshot spaces, token mappings, chain IDs, merkle contracts, and platform configs.
- `utils.ts` - CSV loaders, raw-token CSV parsing, Snapshot choice helpers, delegation voting power helpers, token price helpers, and on-chain claim lookup helpers.
- `snapshot.ts` - Snapshot proposal, voter, voting power, and gauge-choice queries.
- `reportUtils.ts` - report token/gauge helpers used by protocol report generators.
- `contractRegistry.ts` - contract address registry helpers.
- `getClients.ts`, `rpcConfig.ts`, `rpcClientManager.ts`, `chains/` - RPC client creation and chain definitions.
- `tokenService.ts`, `tokens.ts`, `priceUtils.ts` - token metadata and pricing helpers.
- `cacheUtils.ts`, `forwarderCacheUtils.ts` - cache readers and writers for delegation/forwarding data.
- `claims/` - Votemarket, Votium, and Warden claim parsing helpers.
- `merkle/` - reusable merkle distribution logic.

## Merkle Helpers

- `merkle/createMultiMerkle.ts` - legacy sdToken merkle calculation used by `script/sdTkns/generateMerkle.ts`.
- `merkle/sdTokensMerkleGenerator.ts` - universal sdToken generator used by sdFXS and sdSpectra flows.
- `merkle/merkle.ts` - conversion and carry-forward helpers for universal merkle data.
- `merkle/findPreviousMerkle.ts` - scans previous weekly folders for the last available merkle file.
- `merkle/distributionVerifier.ts` - verifies generated universal merkles against period distributions.
- `shared/merkle/generateMerkleTree.ts` - canonical universal merkle tree builder.

## Common Imports

```typescript
import {
  extractCSV,
  extractAllRawTokenCSVs,
  extractProposalChoices,
  getChoiceWhereExistsBribe,
} from "../utils/utils";

import {
  fetchLastProposalsIds,
  getProposal,
  getVoters,
  getVotingPower,
} from "../utils/snapshot";

import { createMultiMerkle } from "../utils/merkle/createMultiMerkle";
import { generateMerkleTree } from "../shared/merkle/generateMerkleTree";
```

## CSV Loading

```typescript
const csvData = await extractCSV(timestamp, "sdcrv.eth");
const rawTokenRows = await extractAllRawTokenCSVs(timestamp);
```

`extractCSV()` resolves the protocol filename through `LABELS_TO_SPACE`. `extractAllRawTokenCSVs()` scans `bounties-reports/{timestamp}/raw/{protocol}/{protocol}.csv`.

## Raw Token Shape

```typescript
export type RawTokenDistribution = {
  gauge: string;
  token: string;
  symbol: string;
  amount: number;
  space: string;
};
```

Raw token merkle generation is documented in [README-raw-tokens.md](../../README-raw-tokens.md).

## Adding Protocol Support

Typical changes:

1. Add or update constants in `constants.ts`.
2. Add report generation logic under `script/reports/` or a protocol-specific directory.
3. Wire make targets in `automation/reports.mk` or `automation/distribution.mk`.
4. Add verification coverage when the protocol affects published merkle data.

Avoid adding a new helper here until at least two pipeline areas need it; protocol-local helpers are easier to maintain when behavior is still specific.

## Testing

```bash
pnpm test:unit
pnpm test:integration
```
