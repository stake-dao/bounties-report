# RewardsExpiry release pins

This is the release configuration for the signed module in
[contracts-monorepo #527](https://github.com/stake-dao/contracts-monorepo/pull/527).
It supersedes the PREPARER/64-account design. Nothing here authorizes deployment,
signing, publication or schedule activation.

* [Contract invariants and roles](https://github.com/stake-dao/contracts-monorepo/blob/feat/expiry-auto-ethereum/packages/shared/src/rewards-expiry/README.md): signed predecessor, 24-hour observation, proof bounds, atomic activation and emergency authority.
* [Guard operating runbook](https://github.com/stake-dao/automation-guard/blob/feat/rewards-expiry-monthly-cycle/docs/REWARDS_EXPIRY.md): whole-period Treasury prerequisites in both pools, publication hold/drain, chunks, retries, adoption, incidents and release gates.

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
the pinned pnpm dependencies, solc 0.8.28, optimizer 200 and Cancun configuration.
This offline preview mocks Boss ownership and timelocks of 3 hours (voters) and
zero (extra), on chain 1.
It uses factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` and salts
`keccak256("stake-dao/expiry-treasury-v1/<pool>")`. It does not broadcast.
Its `guardian: null` output is an unresolved identity, not a deployment value;
never overwrite an already approved guardian pin with this preview placeholder.
Runtime hashes include the constructor's immutables and EIP-712 domain data.
Hashing the compiler's unpatched runtime is incorrect. Any bytecode change
requires coordinated config, automation-guard ABI and manifest updates;
independently verify actual runtime/ownership before release. ABI generation:
`jq '.abi' out/RewardsExpiry.sol/RewardsExpiry.json` from `packages/shared`.

`transition.ts`, Guard's `BATCH_TYPE` and the contract's `Batch` must agree.
Preparations and adoption read `expectedProposal` at the archived snapshot block.
Payloads encoded before that field are incompatible: regenerate preparation,
never edit signed payloads or discard their audit archives. The existing Maestro
pipeline stays initially paused; production activation requires separate approval.
