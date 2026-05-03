# Bounties Reports

This directory stores weekly reports, repartition data, APR snapshots, and generated merkle trees. Timestamped folders are historical records; `latest/` contains the currently published copies.

## Layout

```text
bounties-reports/
├── {timestamp}/
│   ├── {protocol}.csv
│   ├── {protocol}-otc.csv
│   ├── {protocol}-attribution.json
│   ├── merkle.json
│   ├── delegationsAPRs.json
│   ├── raw/{protocol}/{protocol}.csv
│   ├── sdTkns/sdtkns_merkle_{chainId}.json
│   ├── spectra/
│   │   ├── repartition.json
│   │   └── merkle_data.json
│   └── vlCVX/
│   │   ├── curve/
│   │   ├── fxn/
│   │   ├── vlcvx_merkle.json
│   │   ├── vlcvx_merkle_{chainId}.json
│   │   ├── merkle_data_delegators.json
│   │   └── APRs.json
└── latest/
    ├── merkle.json
    ├── delegationsAPRs.json
    ├── sdTkns/
    └── vlCVX/
```

## Timestamps

Weekly folders are Unix timestamps for the Thursday 00:00 UTC period start.

Example: `1747872000` is `2025-05-22T00:00:00.000Z`.

## CSV Reports

Standard report CSVs use semicolon delimiters. Common columns include:

```csv
gauge address;gauge name;reward token;reward amount;reward sd value
0x7E1444BA99dcdFfE8fBdb42C02fb0005009e961A;sETH/ETH;SDT;1000;500
```

vlCVX reports include reward token addresses and chain IDs:

```csv
ChainId;Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;
1;Gauge;0xGauge;USDC;0xToken;1000000;
```

Raw token CSVs live in `raw/{protocol}/` and are documented in [README-raw-tokens.md](../README-raw-tokens.md).

## Merkle Formats

Legacy sdToken `merkle.json` is an array of token entries:

```json
[
  {
    "symbol": "sdCRV",
    "address": "0x...",
    "merkle": {
      "0xuser": {
        "index": 0,
        "amount": { "type": "BigNumber", "hex": "0x..." },
        "proof": ["0x..."]
      }
    },
    "root": "0x...",
    "chainId": 1,
    "merkleContract": "0x..."
  }
]
```

Universal merkles (`sdTkns/`, `vlCVX/`) use:

```json
{
  "merkleRoot": "0x...",
  "claims": {
    "0xuser": {
      "tokens": {
        "0xtoken": {
          "amount": "1000000000000000000",
          "proof": ["0x..."]
        }
      }
    }
  }
}
```

## Current Published Files

See [latest/README.md](./latest/README.md) for the active files copied by publish workflows.

## Generation

Typical order:

1. Fetch claims into `weekly-bounties/{timestamp}/`.
2. Generate CSV reports.
3. Generate protocol repartition files.
4. Generate merkle files and APR files.
5. Verify outputs.
6. Publish to `latest/` after on-chain roots are set or verified.

Relevant workflow entry points are `Claims`, `Reports`, `sdTokens: Merkle`, `vlCVX: Distribution`, and `Compute APR`.
