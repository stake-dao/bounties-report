<!-- ABOUTME: Describes how to run the vlCVX forwarding registry HyperIndex -->
<!-- ABOUTME: Outlines Envio commands and query patterns for monitoring delegation forwarding -->

# vlCVX Forwarding HyperIndex

This HyperIndex service ingests the Votium forwarder registry and maintains both the full interval history and a current snapshot of each delegator’s forwarding destination.

## Directory layout

- `config.yaml` – Envio configuration (network, registry address, handler wiring)
- `schema.graphql` – entity definitions for `Interval` history and `Registration` snapshot data (exposed via Hasura when enabled)
- `eventHandlers.ts` – TypeScript handlers translating registry events into entities
- `abis/ForwarderRegistry.json` – minimal ABI that exposes `setReg` and `expReg`
- `generated/` – created by `envio codegen` (discard before committing if not needed)
- `tests/forwarding.test.ts` – unit tests exercising handler logic via Envio mock helpers

## Getting started

1. Ensure the Envio CLI is available:
   ```bash
   npx envio --help
   ```
   (You can substitute `pnpm dlx` or a global install; the commands below remain the same.)

2. Generate types and scaffolding:
   ```bash
   npx envio codegen --config script/indexer/vlcvx-forwarder/config.yaml
   ```

3. Run the handler unit tests against Envio’s in-memory store:
   ```bash
   npx tsx script/indexer/vlcvx-forwarder/tests/forwarding.test.ts
   ```

4. Launch the indexer locally once you have an RPC endpoint:
   ```bash
   ETHEREUM_RPC_URL=<https_endpoint> npx envio dev --config script/indexer/vlcvx-forwarder/config.yaml
   ```

5. For production, build and start the service with the Envio deployment command that matches your environment (`envio start`, Docker, or Hosted Service).

## Query snippets

The generated GraphQL endpoint supports the following patterns (set `$E` to the epoch start you care about – e.g., `Math.floor(Date.now() / 1209600000) * 1209600`):

- **All historical intervals that forwarded to you**
  ```graphql
  query AllForwardsToMe($to: String!) {
    intervals(where: { to: $to, canceled: false }, orderBy: start, orderDirection: asc) {
      from
      to
      start
      expiration
    }
  }
  ```

- **Delegators forwarding to you for a specific epoch**
  ```graphql
  query ActiveToMeAtEpoch($to: String!, $E: BigInt!) {
    intervals(
      where: { to: $to, canceled: false, start_lte: $E, expiration_gt: $E }
      orderBy: start
      orderDirection: asc
    ) {
      from
      start
      expiration
    }
  }
  ```

- **Current active snapshot (should mirror the epoch query for “now”)**
  ```graphql
  query ActiveSnapshotToMe($to: String!, $E: BigInt!) {
    registrations(where: { to: $to, start_lte: $E, expiration_gt: $E }) {
      from
      to
      start
      expiration
    }
  }
  ```
