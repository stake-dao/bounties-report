# sdBAL Sunset Distribution — Summary

Pass-through of Balancer's [BIP-920](https://forum.balancer.fi/t/bip-920-vebal-compensation-airdrop/7025)
veBAL compensation to sdBAL holders.

**Model:** the net pot is split **pro-rata across sdBAL gauge stakers** by their gauge
balance. Only gauge stakers are paid — the pool, the merkle stash, direct holders and
dust are not; their share is absorbed into the gauge split (so gauge stakers receive the
entire net pot).

**Fee:** Stake DAO's 15% fee (**5,709.000000 USDC**) was already taken
([tx 0xad9ce210…](https://etherscan.io/tx/0xad9ce210ee03703bdba422bb16e21f5083a87b736419c3d58e898927188d003a),
protocol Safe → stakedao.eth). Attribution is on the **net** pot.

## Key parameters

| | |
|---|---|
| Gross pot received | 38,055.182232 USDC ([funding tx 0xeffea8a0…](https://etherscan.io/tx/0xeffea8a0e72039450fed07187b621e5072e52531a577c7c7d73132e5d1e69484)) |
| Fee taken (15%) | 5,709.000000 USDC → stakedao.eth ([fee tx 0xad9ce210…](https://etherscan.io/tx/0xad9ce210ee03703bdba422bb16e21f5083a87b736419c3d58e898927188d003a)) |
| **Net pot distributed** | **32,346.182232 USDC** (`32346182232` uint, 6 decimals) |
| Snapshot block | **25035662** (2026-05-08 18:00 UTC, BIP-920 vote start) |
| Basis | sdBAL gauge — split pro-rata over the gauge's 81 expanded stakers (Σ 377,016.0538 gauge sdBAL) |
| Payout floor | **$10** — nothing under $10 attributed; 32 sub-$10 stakers dropped, their 81.453504 USDC redistributed pro-rata to the rest |
| **Recipients** | **48** (after floor) |
| Distribution channel | URD extra merkle, cumulative — prior leaves preserved |
| New merkle root | `0x0f3815975a85b8dc719b30059005562ad508c251e51d8a3af7b3f031faac22e9` |
| Prior root | `0xc8432faea512a70570f7c159df14e73cedaae6bbf804ef12b60a734e2a2f49dd` |
| On-chain status | **not yet submitted** — URD root still at the prior root, no pending root |

## Infrastructure addresses

| Role | Address |
|---|---|
| sdBAL token (snapshot subject) | [`0xF24d8651578a55b0C119B9910759a351A3458895`](https://etherscan.io/token/0xF24d8651578a55b0C119B9910759a351A3458895) |
| sdBAL gauge (payout basis) | [`0x3E8C72655e48591d93e6dfdA16823dB0fF23d859`](https://etherscan.io/address/0x3E8C72655e48591d93e6dfdA16823dB0fF23d859) |
| Payout token (USDC) | [`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`](https://etherscan.io/token/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) |
| URD (claim contract) | [`0x6D98023de9AdeEE661E922F58f5c2ff086be1F4e`](https://etherscan.io/address/0x6D98023de9AdeEE661E922F58f5c2ff086be1F4e) |
| Protocol Safe (holds the USDC, funds the URD) | [`0xb0552b6860ce5c0202976db056b5e3cc4f9cc765`](https://etherscan.io/address/0xb0552b6860ce5c0202976db056b5e3cc4f9cc765) |

## Recipients (48)

Amounts in USDC. Type marks known protocol allocations; blank = ordinary gauge staker.

| # | Address | USDC | Type |
|---|---|---|---|
| 1 | `0xb0e83C2D71A991017e0116d58c5765Abc57384af` | 13557.273791 |  |
| 2 | `0xE3940ab013b8A4bcfD2318652658ee976b81443F` | 1928.257224 |  |
| 3 | `0xF67265772797bDDEb05Ae0B51bEEf5c3c52F9795` | 1381.569267 |  |
| 4 | `0x71F12a5b0E60d2Ff8A87FD34E7dcff3c10c914b0` | 1247.502709 |  |
| 5 | `0xAD2906fAf5eFEC651f54372b121414FF0EeC6B1D` | 1203.602812 | Balancer Vesters |
| 6 | `0x99d39F545AB74bD686859b9608B6fE8719bC7349` | 1126.902311 |  |
| 7 | `0xDc70b6C0aEB5C6627EAa707fC6c804a2EC43f937` | 1109.186818 | Alchemix |
| 8 | `0x2f707265E61300e8290C18E38EbcBd129FB0B0F5` | 1032.158814 |  |
| 9 | `0x9D5Df30F475CEA915b1ed4C0CCa59255C897b61B` | 958.867759 | Inverse Finance |
| 10 | `0x1A31C94f97C649bC2a8aDbCeb54D1f4a075be4b1` | 936.610203 |  |
| 11 | `0xB70D29deCca758BB72Cd2967a989782F3acAd3e6` | 816.594257 |  |
| 12 | `0x279a7DBFaE376427FFac52fcb0883147D42165FF` | 716.353371 |  |
| 13 | `0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063` | 702.811181 | Stake DAO Treasury |
| 14 | `0x1b7D0C1d2A730fa791A2937AD75Fef11AeACa3D4` | 612.688313 | Balancer Vesters |
| 15 | `0x5C89C420A9E82Ea9AEDBaAab03302e39982919b9` | 592.914622 |  |
| 16 | `0x345D047DE6fEf34D6217DeD8de15BB3300e536f1` | 402.506220 |  |
| 17 | `0xFEffd47b42BD7936fcf256E162EEdba99Bd96556` | 378.665709 | Balancer Vesters |
| 18 | `0x7c2eA10D3e5922ba3bBBafa39Dc0677353D2AF17` | 376.984547 | Balancer Vesters |
| 19 | `0x4334703B0B74E2045926f82F4158A103fCE1Df4f` | 349.435955 |  |
| 20 | `0x250Dc31d9eCD8AF562f506b40d0dE4349C987E92` | 327.451577 |  |
| 21 | `0x200550cAD164E8e0Cb544A9c7Dc5c833122C1438` | 291.783123 | Balancer Vesters |
| 22 | `0x69Be08e37274f9D321e00c7E19cC0E96fbb70d23` | 282.962870 |  |
| 23 | `0x4D26f0e78C154f8FDA7AcF6646246Fa135507017` | 280.128396 |  |
| 24 | `0x420DCc5FCf2cA696d66326b86D431cDbF256420A` | 242.475510 |  |
| 25 | `0x99AfD53f807766A8B98400B0C785E500c041F32B` | 209.435860 | Balancer Vesters |
| 26 | `0xDdB50FfDbA4D89354E1088e4EA402de895562173` | 170.179487 |  |
| 27 | `0xB5f2535871Eb511FFd48bFB8514ddfF0F47b7712` | 151.868727 |  |
| 28 | `0x0af815364BD9e9E60f3d2D3bAc1320B77d3E35F7` | 141.363501 | Convergence Treasury |
| 29 | `0x5275817b74021E97c980E95EdE6bbAc0D0d6f3a2` | 135.339492 |  |
| 30 | `0xfCbbae9BE6Be2B6de264643Dd0Ee3d9a0E2e8733` | 66.725942 |  |
| 31 | `0xAD1648c366fcBEa944b7349dF94ad0D7F386edE3` | 60.152701 |  |
| 32 | `0xDB60b36688df7AB9444f32DdE2d8CEAC4b0040E1` | 59.546802 |  |
| 33 | `0x77299Cf68685B96a529D392C7d8EdfC94CBDCC15` | 49.704831 |  |
| 34 | `0x5CfE3929f77b7FB71d77a9dF6a828043C2123671` | 47.532905 |  |
| 35 | `0x03184931936D8933D25579e3F9a28F5CF7F6c354` | 46.966090 |  |
| 36 | `0xB1246C58eE52c93876A920E23e5f50F29A9A501F` | 42.313561 |  |
| 37 | `0x7F91B4A29bFdCDb09E6250E218BbD010eD44CFA1` | 40.732366 |  |
| 38 | `0xc1133c83D409724727fF6699F14F040746e5AD01` | 39.107384 |  |
| 39 | `0xA7499Aa6464c078EeB940da2fc95C6aCd010c3Cc` | 37.262359 |  |
| 40 | `0xaB699b1BB3fE0eB9884213AB91D86f06fB33499d` | 37.080459 |  |
| 41 | `0x72658e9A5c55371A5e80559B8E07AbC14F212120` | 27.290061 | Balancer Vesters |
| 42 | `0x579B48Fa60E901E75a8c143bB1ADc04D738535f8` | 23.888144 |  |
| 43 | `0x4Dfe6C8DA5e9A05CD50B7925d17fCfa1a17D6d5b` | 23.703803 |  |
| 44 | `0xfC4B2a62A06cb2E1C6A743E9aE327Bb16977E4c1` | 22.031760 |  |
| 45 | `0xC7aDC31d7B180B0Ee4Ac3737Aab8114021ab8Fd9` | 18.726742 |  |
| 46 | `0x1d9D7711A5f625F5867F81DCb99B39A08C0B10fe` | 14.794700 |  |
| 47 | `0x4d2eb1b7c4b2814D04967263d7c5B21864E9Fe08` | 12.772776 |  |
| 48 | `0x539e96Fad131Ef18075472ED8c5FdEca1075D0Fa` | 11.974420 |  |

**Σ paid = 32,346.182232 USDC** (exact, = gross 38,055.182232 − 5,709.000000 fee).

## Dropped by the $10 floor

32 sub-$10 gauge stakers were excluded; their combined 81.453504 USDC was redistributed
pro-rata across the 48 recipients above.