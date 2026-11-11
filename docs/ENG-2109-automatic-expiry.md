# Automatic reward expiry

This document describes the signed, shape-preserving module in
[contracts-monorepo #527](https://github.com/stake-dao/contracts-monorepo/pull/527).
It supersedes the PREPARER/64-account design. Nothing here authorizes deployment,
signing, publication or schedule activation.

The single automation KMS authorizes `prepare(bytes,bytes)` using EIP-712 and
signs the Guard transaction. AllMight callers do not inherit signature authority.
Guard permits only `prepare(bytes,bytes)` and `activate(bytes)` on each pinned
module. Boss Safe enables the modules, initializes the signer and appoints the
verified Hypernative guardian. The guardian can invalidate and pause with
`cancel(true)`; only Boss Safe can resume with `cancel(false)`.

The module enforces at least **24 hours** on chain, even for public activation.
At activation it rechecks every affected claim snapshot, the parent root,
ownership, nonce and absence of pending roots. Any affected claim change fails;
no targeted claim freeze exists. Root installation and Treasury claims are
atomic. Age, six-calendar-month eligibility, VM provenance and exact funding
offsets remain off-chain responsibilities in `script/recovery/`.

The coordinator holds ordinary publishers, drains running writers, then requests
a fresh preparation. It preserves the hold through observation, finalized
adoption and all remaining chunks. Identical transport retries preserve the
deadline; claim invalidations trigger recalculation and a new full 24-hour
proposal. Three consecutive distinct invalidations in one pool latch escalation
for Boss Safe review. Unknown proposals or parent drift stop for reconciliation.

Every preparation appends `bytes32 expectedProposal` to the signed `Batch`,
read together with `nonce()` at the pinned claim-snapshot block. It names the
on-chain proposal being replaced (zero for a fresh slot). Thus A → B invalidates
A's old signature, and B → C invalidates B's. Retrying the currently installed
payload preserves its deadline. After a claim invalidation, regenerate the
snapshot and authorization with the current predecessor, then wait 24 hours.
Adoption rereads the historical proposal and reconstructs the complete payload;
report metadata alone cannot choose the predecessor. Archives encoded before
this field are not executable with the new module: regenerate preparation,
never edit old signed payloads or discard audit archives.

Each chunk permits at most 256 reductions, 64 tokens, 8192 program bytes and
2048 proof nodes. Finalized adoption publishes the reduced canonical baseline
before another chunk. Fourteen sequential chunks require at least 14 days,
excluding retries and publication; a monthly completion deadline is not assured.

## Candidate pins, not live deployment evidence

`script/recovery/config.json` pins the candidate CREATE2 addresses and constructed
runtime hashes, plus the exact expected Hypernative address in `guardian`.
**That guardian pin is currently null and blocks coordinator preflight.** No
approved Hypernative address has been established for this release. Supply its
authoritative identity evidence and review the config change before any release;
do not copy an arbitrary nonzero guardian from another contract. Guard compares
both modules' live guardians to this pin and fails on any mismatch. Safe rotation
requires a coordinated reviewed pin change, not automatic discovery.

Reproduce module pins in contracts-monorepo `packages/shared` with
`forge script script/PreviewRewardsExpiry.s.sol:PreviewRewardsExpiry`, using
the pinned dependencies and compiler configuration. This offline preview mocks
Boss ownership and timelocks of 3 hours (voters) and zero (extra), on chain 1.
It uses factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` and salts
`keccak256("stake-dao/expiry-treasury-v1/<pool>")`. It does not broadcast.
Its `guardian: null` output is an unresolved identity, not a deployment value;
never overwrite an already approved guardian pin with this preview placeholder.
Runtime hashes include the constructor's immutables and EIP-712 domain data.
Any bytecode change requires coordinated config, automation-guard ABI and
manifest updates; independently verify actual runtime/ownership before release.

The complete state machine, publication hold list, incident procedure and
validation limits live in
[automation-guard's runbook](https://github.com/stake-dao/automation-guard/blob/feat/rewards-expiry-monthly-cycle/docs/REWARDS_EXPIRY.md).
The existing Maestro pipeline remains initially paused. Production permissions,
deployment and activation require separate approval.
