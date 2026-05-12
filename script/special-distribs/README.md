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
