# Raw Token Distributions

Raw token distributions let the sdToken pipeline distribute native tokens such as CRV, BAL, or FXS with the same Snapshot vote weighting used for the matching sdToken space.

## Directory Layout

Place raw token reports under:

```text
bounties-reports/{timestamp}/raw/{protocol}/{protocol}.csv
```

The loader scans every protocol directory inside `raw/` for a CSV matching the directory name.

## CSV Format

Required columns:

- `gauge address` - gauge or pool address receiving the reward.
- `reward address` - token contract address to distribute.
- `reward amount` - token amount in normal token units, not wei.

Optional columns:

- `reward token` - token symbol used in generated metadata and logs.
- `space` or `snapshot space` - Snapshot space whose voting rules apply. If omitted, the loader derives the space from the protocol name when possible.

Example:

```csv
gauge address;reward address;reward token;reward amount;space
0x7E1444BA99dcdFfE8fBdb42C02fb0005009e961A;0xD533a949740bb3306d119CC777fa900bA034cd52;CRV;1000;sdcrv.eth
0x4e6bB6B7447B7B2Aa268C16AB87F4Bb48BF57939;0xD533a949740bb3306d119CC777fa900bA034cd52;CRV;2000;sdcrv.eth
```

## Processing

`script/sdTkns/generateMerkle.ts`:

- reads all `raw/` CSVs with `extractAllRawTokenCSVs()`;
- groups rows by token address and Snapshot space;
- calls `createMultiMerkle(..., overrideTokenAddress)` so the native token is distributed instead of the default sdToken for that space;
- appends the raw-token merkle to the weekly `merkle.json` output and root-update transaction data.

Run it with:

```bash
pnpm sd-merkle
```

## Notes

- Raw token rows do not use `reward sd value`.
- Amounts are parsed as decimal numbers by the current loader.
- If `space` is omitted, only the built-in protocol mapping is used; unknown protocol directories are skipped.
- The generated token symbol comes from `reward token` and falls back to `UNKNOWN` when absent.
