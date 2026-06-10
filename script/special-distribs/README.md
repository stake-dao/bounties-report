# Special Distributions

One-off distribution scripts that build or update extra merkle data outside the normal weekly sdToken/vlCVX flows.

## Scripts

### CSV distribution

`csvDistribution.ts` reads `script/special-distribs/distribution-data.csv`, merges it with `data/extra_merkle/merkle.json`, and rewrites the extra merkle files.

```bash
pnpm tsx script/special-distribs/csvDistribution.ts
```

### Yearn Boost / YB merge

`yb.ts` merges `yb_merkle.json` with the current extra merkle from the main branch and writes the combined result to `data/extra_merkle/merkle.json`.

```bash
pnpm yb-distribution
```

### Linea sdZERO

`lineaDistribution.ts` creates a Linea-specific extra merkle for sdZERO holders at the Dec 1, 2025 snapshot.

```bash
pnpm tsx script/special-distribs/lineaDistribution.ts
```

Outputs are written under `data/extra_merkle/59144/`.

### sdBAL Sunset (BIP-920 pass-through)

`sdbalSunsetDistribution.ts` distributes Balancer's BIP-920 USDC compensation to sdBAL holders at snapshot block 25035662 (BIP-920 vote start, 2026-05-08 18:00 UTC). Merges into `data/extra_merkle/merkle.json` (URD `0x6D98023de9AdeEE661E922F58f5c2ff086be1F4e`).

Phased CLI — run sequentially; each phase reads the previous phase's output from `sdbal-sunset/`:

```bash
pnpm tsx script/special-distribs/sdbalSunsetDistribution.ts --phase 1            # snapshot holders
pnpm tsx script/special-distribs/sdbalSunsetDistribution.ts --phase 2            # classify EOA vs contract
pnpm tsx script/special-distribs/sdbalSunsetDistribution.ts --phase 3            # auto-route contracts (probes interfaces; halts on unknown)
pnpm tsx script/special-distribs/sdbalSunsetDistribution.ts --phase 4 --usdc N   # pro-rata payouts (N = uint USDC received by locker)
pnpm tsx script/special-distribs/sdbalSunsetDistribution.ts --phase 5            # merge cumulative URD merkle (preserves prior leaves)
pnpm tsx script/special-distribs/sdbalSunsetDistribution.ts --phase 6            # Safe tx bundles: submitRoot + acceptRoot
pnpm tsx script/special-distribs/sdbalSunsetDistribution.ts --phase verify       # invariant gate (run before submitRoot)
```

Phase 3 auto-routes via interface probes (Gnosis Safe / Balancer BPT verified to contain sdBAL via Vault.getPoolTokens / Curve gauge whose `lp_token()` holds sdBAL / ERC4626 with `asset()==sdBAL`). Default-deny — any contract not matching one of these explicit routes halts the run and is listed in `sdbal-sunset/unknown_contracts.json` for manual review. There is no generic ERC20 fallback (would mis-treat treasuries holding sdBAL inventory as redistributable wrappers).
