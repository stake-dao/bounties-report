# Latest Published Distributions

This directory contains the current merkle and APR files copied by publish workflows after distribution processing.

## Active Files

- `merkle.json` - latest legacy sdToken merkle tree.
- `delegationsAPRs.json` - latest sdToken delegation APRs.
- `sdTkns/sdtkns_merkle_252.json` - latest Fraxtal sdFXS universal merkle.
- `sdTkns/sdtkns_merkle_8453.json` - latest Base sdSpectra universal merkle.
- `sdTkns/sdtkns_merkle_1_sdcrv.json` / `sdTkns/sdtkns_merkle_1_sdfxn.json` - latest mainnet sdCRV / sdFXN universal merkles (`0x32dA29D7F3aD8cF157C6427CecFD3f0665042A37` / `0xdD03449c5b8F1e2aF92FaA45Db6CCA268479b990`).
- `vlCVX/vlcvx_merkle.json` - latest vlCVX voter merkle.
- `vlCVX/vlcvx_merkle_{chainId}.json` - latest chain-specific vlCVX voter merkles.
- `vlCVX/vlcvx_merkle_delegators.json` - latest vlCVX forwarded-delegator merkle.
- `vlCVX/APRs.json` - latest vlCVX APR data.
- `vlAURA/vlaura_merkle.json` - latest vlAURA merkle.
- `vlAURA/vlaura_merkle_{chainId}.json` - latest chain-specific vlAURA merkles.

## Publish Sources

- `sdTokens: Merkle` publishes legacy sdToken, sdFXS, and sdSpectra files.
- `vlCVX: Distribution` publishes vlCVX voters and delegators files.
- `Compute APR` can refresh latest vlCVX APR files.

`newMerkle.json` is a legacy/manual artifact and is not written by the current publish workflows.
