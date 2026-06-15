# sdBAL Sunset Distribution — Summary

Pass-through of Balancer's [BIP-920](https://forum.balancer.fi/t/bip-920-vebal-compensation-airdrop/7025)
veBAL compensation to sdBAL holders.

**Model:** the full **38,055.182232 USDC** is split **pro-rata across sdBAL gauge
stakers** by their gauge balance. Only gauge stakers are paid — the pool, the merkle
stash, direct holders and dust are not; their share is simply absorbed into the gauge
split (so gauge stakers receive the entire pot).

Full routing methodology and per-contract identification: [`routing_review.md`](./routing_review.md).

## Key parameters

| | |
|---|---|
| Pot | **38,055.182232 USDC** (`38055182232` uint, 6 decimals) |
| Funding tx | [`0xeffea8a0…`](https://etherscan.io/tx/0xeffea8a0e72039450fed07187b621e5072e52531a577c7c7d73132e5d1e69484) — Balancer DAO → Stake DAO protocol Safe |
| Snapshot block | **25035662** (2026-05-08 18:00 UTC, BIP-920 vote start) |
| Basis | sdBAL gauge — split pro-rata over the gauge's 81 expanded stakers (Σ 377,016.0538 gauge sdBAL) |
| `$1` payout floor | 15 sub-$1 stakers dropped, their 5.188566 USDC redistributed pro-rata to the rest |
| **Recipients** | **65** (after floor) |
| Distribution channel | URD extra merkle, cumulative — prior leaves preserved |
| New merkle root | `0xb643af14f55c5284f020aaaf872e0dd0a9b45628611e3374faa0c9804496e0ba` |
| Prior root | `0xc8432faea512a70570f7c159df14e73cedaae6bbf804ef12b60a734e2a2f49dd` |
| On-chain status | **not yet submitted** — URD root still at the prior root, no pending root |

Regeneration command:

```bash
pnpm tsx script/special-distribs/sdbalSunsetDistribution.ts --phase 4 \
  --usdc 38055182232 --min-usdc 1000000 --source 0x3E8C72655e48591d93e6dfdA16823dB0fF23d859
pnpm tsx script/special-distribs/sdbalSunsetDistribution.ts --phase 5
```

## Infrastructure addresses

| Role | Address |
|---|---|
| sdBAL token (snapshot subject) | [`0xF24d8651578a55b0C119B9910759a351A3458895`](https://etherscan.io/token/0xF24d8651578a55b0C119B9910759a351A3458895) |
| sdBAL gauge (payout basis) | [`0x3E8C72655e48591d93e6dfdA16823dB0fF23d859`](https://etherscan.io/address/0x3E8C72655e48591d93e6dfdA16823dB0fF23d859) |
| Payout token (USDC) | [`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`](https://etherscan.io/token/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) |
| URD (claim contract) | [`0x6D98023de9AdeEE661E922F58f5c2ff086be1F4e`](https://etherscan.io/address/0x6D98023de9AdeEE661E922F58f5c2ff086be1F4e) |
| Protocol Safe (holds the USDC, funds the URD) | [`0xb0552b6860ce5c0202976db056b5e3cc4f9cc765`](https://etherscan.io/address/0xb0552b6860ce5c0202976db056b5e3cc4f9cc765) |

## Recipients (65)

Amounts in USDC.

| # | Address | USDC | Note |
|---|---|---|---|
| 1 | `0xb0e83C2D71A991017e0116d58c5765Abc57384af` | 15912.094522 | Top gauge staker EOA (41.8%) |
| 2 | `0xE3940ab013b8A4bcfD2318652658ee976b81443F` | 2263.184449 |  |
| 3 | `0xF67265772797bDDEb05Ae0B51bEEf5c3c52F9795` | 1621.539928 |  |
| 4 | `0x71F12a5b0E60d2Ff8A87FD34E7dcff3c10c914b0` | 1464.186777 |  |
| 5 | `0xAD2906fAf5eFEC651f54372b121414FF0EeC6B1D` | 1412.661719 | Vester beneficiary |
| 6 | `0x99d39F545AB74bD686859b9608B6fE8719bC7349` | 1322.638782 |  |
| 7 | `0xDc70b6C0aEB5C6627EAa707fC6c804a2EC43f937` | 1301.846210 | Alchemix Safe (via SDTController) |
| 8 | `0x2f707265E61300e8290C18E38EbcBd129FB0B0F5` | 1211.438882 |  |
| 9 | `0x9D5Df30F475CEA915b1ed4C0CCa59255C897b61B` | 1125.417593 |  |
| 10 | `0x1A31C94f97C649bC2a8aDbCeb54D1f4a075be4b1` | 1099.294026 |  |
| 11 | `0xB70D29deCca758BB72Cd2967a989782F3acAd3e6` | 958.431998 |  |
| 12 | `0x279a7DBFaE376427FFac52fcb0883147D42165FF` | 840.779845 |  |
| 13 | `0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063` | 824.885454 | stakedao.eth governance Safe |
| 14 | `0x1b7D0C1d2A730fa791A2937AD75Fef11AeACa3D4` | 719.108761 | Vester beneficiary |
| 15 | `0x5C89C420A9E82Ea9AEDBaAab03302e39982919b9` | 695.900493 | superchainer.eth (EIP-7702) |
| 16 | `0x345D047DE6fEf34D6217DeD8de15BB3300e536f1` | 472.419243 | EIP-7702 wallet |
| 17 | `0xFEffd47b42BD7936fcf256E162EEdba99Bd96556` | 444.437772 | Vester beneficiary |
| 18 | `0x7c2eA10D3e5922ba3bBBafa39Dc0677353D2AF17` | 442.464603 | Vester beneficiary |
| 19 | `0x4334703B0B74E2045926f82F4158A103fCE1Df4f` | 410.130978 | Stake DAO ops EOA |
| 20 | `0x250Dc31d9eCD8AF562f506b40d0dE4349C987E92` | 384.328039 |  |
| 21 | `0x200550cAD164E8e0Cb544A9c7Dc5c833122C1438` | 342.464179 | Vester beneficiary |
| 22 | `0x69Be08e37274f9D321e00c7E19cC0E96fbb70d23` | 332.111898 |  |
| 23 | `0x4D26f0e78C154f8FDA7AcF6646246Fa135507017` | 328.785092 |  |
| 24 | `0x420DCc5FCf2cA696d66326b86D431cDbF256420A` | 284.592117 |  |
| 25 | `0x99AfD53f807766A8B98400B0C785E500c041F32B` | 245.813668 | Vester beneficiary |
| 26 | `0xDdB50FfDbA4D89354E1088e4EA402de895562173` | 199.738689 |  |
| 27 | `0xB5f2535871Eb511FFd48bFB8514ddfF0F47b7712` | 178.247455 |  |
| 28 | `0x0af815364BD9e9E60f3d2D3bAc1320B77d3E35F7` | 165.917531 | Convergence (CVG) Treasury Safe |
| 29 | `0x5275817b74021E97c980E95EdE6bbAc0D0d6f3a2` | 158.847185 |  |
| 30 | `0xfCbbae9BE6Be2B6de264643Dd0Ee3d9a0E2e8733` | 78.315856 |  |
| 31 | `0xAD1648c366fcBEa944b7349dF94ad0D7F386edE3` | 70.600880 |  |
| 32 | `0xDB60b36688df7AB9444f32DdE2d8CEAC4b0040E1` | 69.889740 |  |
| 33 | `0x77299Cf68685B96a529D392C7d8EdfC94CBDCC15` | 58.338277 |  |
| 34 | `0x5CfE3929f77b7FB71d77a9dF6a828043C2123671` | 55.789098 |  |
| 35 | `0x03184931936D8933D25579e3F9a28F5CF7F6c354` | 55.123830 |  |
| 36 | `0xB1246C58eE52c93876A920E23e5f50F29A9A501F` | 49.663184 |  |
| 37 | `0x7F91B4A29bFdCDb09E6250E218BbD010eD44CFA1` | 47.807345 |  |
| 38 | `0xc1133c83D409724727fF6699F14F040746e5AD01` | 45.900113 |  |
| 39 | `0xA7499Aa6464c078EeB940da2fc95C6aCd010c3Cc` | 43.734617 |  |
| 40 | `0xaB699b1BB3fE0eB9884213AB91D86f06fB33499d` | 43.521121 |  |
| 41 | `0x72658e9A5c55371A5e80559B8E07AbC14F212120` | 32.030189 | Vester beneficiary |
| 42 | `0x579B48Fa60E901E75a8c143bB1ADc04D738535f8` | 28.037378 |  |
| 43 | `0x4Dfe6C8DA5e9A05CD50B7925d17fCfa1a17D6d5b` | 27.821018 |  |
| 44 | `0xfC4B2a62A06cb2E1C6A743E9aE327Bb16977E4c1` | 25.858551 |  |
| 45 | `0xC7aDC31d7B180B0Ee4Ac3737Aab8114021ab8Fd9` | 21.979470 |  |
| 46 | `0x1d9D7711A5f625F5867F81DCb99B39A08C0B10fe` | 17.364456 |  |
| 47 | `0x4d2eb1b7c4b2814D04967263d7c5B21864E9Fe08` | 14.991333 |  |
| 48 | `0x539e96Fad131Ef18075472ED8c5FdEca1075D0Fa` | 14.054309 |  |
| 49 | `0x4696B1123F4c6A03711E2c6E8311350B0350D7c2` | 10.972459 |  |
| 50 | `0x777d1868Fc2099ADd81AC239ed3F2D31420a52EB` | 10.616988 |  |
| 51 | `0xA613877f3A2A73D67c313fB43B740C5f877E98B9` | 10.142800 |  |
| 52 | `0xf9149B963Ed9CD8Bac918d70044A45D47413287c` | 10.069726 |  |
| 53 | `0x95B8Ec85A3d5dE4985D11A8ea028B52DBA52afCc` | 10.027669 |  |
| 54 | `0x30c20Ecab96d8D2f3E499eaa4d9B8339035D0b04` | 6.995786 |  |
| 55 | `0x7e1E1c5ac70038a9718431C92A618F01f8DADa18` | 5.185624 |  |
| 56 | `0xE47C505D89FC0a22DE1B2C4Fb729B2C63F9390e1` | 3.626222 |  |
| 57 | `0x62810730B8fe56d13c5627a96aF027782122Eda1` | 3.569666 |  |
| 58 | `0x3fE2461f7CB328629F2924993c6218748c740C83` | 3.264172 |  |
| 59 | `0x6119Fa6C5B18BE03F3b8E408c961E28239A0108C` | 3.219629 |  |
| 60 | `0xaeDC687fa5376d2Fe9D4B81EbFC8C2bA30ba54aE` | 2.878929 | herballemon.eth (EIP-7702) |
| 61 | `0x70A0E916bf70583601bC3A5B8676a17D354881FB` | 2.316557 |  |
| 62 | `0xdDDAB7A3A487Ef59eFBeE9CDACc6024F441206C9` | 2.158679 |  |
| 63 | `0x99C2E4708493B19BAA116e26Dfa0056f5A69A783` | 2.054324 |  |
| 64 | `0x39b487c1Fb23FB5cC82fb25A0374049ae42c46C3` | 1.845493 |  |
| 65 | `0xca76644C4F989c698Be79f8531e43b6e830bcEb2` | 1.708856 |  |

**Σ paid = 38,055.182232 USDC** (exact).

## Dropped by the $1 floor

15 sub-$1 gauge stakers were excluded; their combined 5.188566 USDC was redistributed
pro-rata across the 65 recipients above (a URD claim costs more in gas than a sub-$1
leaf pays out). Set `--min-usdc 0` and re-run phase 4 to pay them as leaves instead.

## Source artifacts

- `payouts.json` — per-address amounts, basis, floor
- `holders_raw.json` / `holders_classified.json` — 112 snapshot holders (EOA vs contract)
- `holders_expanded.json` — 206 final beneficiaries (full expansion record)
- `tranches.json` — merkle merge history (root transitions, USDC added, recipient count)
- `routing_review.md` — per-contract identification and open sign-off decisions
