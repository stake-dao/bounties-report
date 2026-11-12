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
- `claims/` - Votemarket and Votium claim parsing helpers.
- `merkle/` - reusable merkle distribution logic.

## Explorer and indexer failures

`explorerUtils.ts` shares a process-local limiter across factory instances:
requests start at least 500 ms apart, with at most five in flight. Each API
request has a 120-second budget including queueing and body parsing, at most
four attempts, and a 30-second per-attempt timeout. HTTP 429/5xx, transport
failures and identified API rate limits retry with bounded backoff; valid
`Retry-After` values are honored only within the remaining budget. Permanent,
unknown and malformed responses fail immediately. Only documented empty log
responses become `[]`; a failed block lookup is not an empty log response.

These limits do not coordinate separate jobs sharing an API key. Diagnostics
include chain, action, attempt and sanitized response detail, never the key or
full URL. Delegation/forwarder collectors do not add another retry layer: an
incomplete collection or unreadable existing Parquet aborts before writing its
checkpoint. Missing files alone are the bootstrap case. Financial consumers
must not reinterpret these errors as empty successful histories.

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
