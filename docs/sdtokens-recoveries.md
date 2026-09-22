# Direct-funded sdToken recoveries

`script/sdTkns/recoveries.ts` loads the reviewed `data/sdtokens-recoveries.json` from the same checkout as Merkle generation. No external mutable JSON endpoint is used. Scope: Ethereum legacy sdCRV (`curve`) and sdFXN (`fxn`).

Each entry needs a unique `id`, a readable `reason`, `protocol`, source transfer evidence, an allocation and a funding receipt. Amounts are unsigned integer strings in token base units; addresses and hashes are complete and lowercase. `funding: null` keeps an entry inactive.

## Input

- `sources`: ERC-20 transfers identified by `chainId`, `transaction`, `logIndex`, `token`, `from`, `to`, `amount`. `usedAmount` reserves the part represented by this recovery; all entries together cannot consume more than that source transfer. Reusing a source with different identity/amount fails.
- `trail`: additional withdrawal, bridge and conversion transfer evidence using the same fields, without `usedAmount`. Every supplied transfer is checked against its successful receipt. A bridge pairing or a conversion's economic adequacy still requires review; unrelated receipt matches do not establish that link.
- `allocation.type: "historical-votes"`: one `votes` record per source, containing its `source` array index, `epoch`, `gauge`, `campaignId`, `claimLogIndex`, `sourceCommit`, `proposalId` and `proposalLogCommit`. This mode supports previously unreported native L2 Votemarket V2 claims. Sources in an entry must share their chain and token so their reserved raw amounts are comparable. Pinned claim files, on-chain claims/campaigns and historical post-freeze proposal logs are verified. Original voter/delegator logic computes wallet weights; integer remainder allocation conserves the full funded amount.
- `allocation.type: "wallets"`: `amounts` maps wallet addresses to exact sdToken base-unit amounts. The sum must equal funding. These are reviewed beneficiary instructions; source receipts alone do not prove wallet eligibility or that a previous ordinary report did not already pay them.
- `funding`: `period`, `transaction`, `logIndex`, `from`, `amount`. The token and distributor come from existing protocol constants. Require the exact transfer, a successful canonical receipt, 12 confirmations, funding after mainnet source/trail evidence and before the target period ends. Use an external wallet/Safe, not an existing BotMarket/AllMight distribution transfer. The transaction must contain exactly one movement of this token involving the distributor.

An explicit allocation has this shape; the wallets and amounts below are examples, not an instruction to distribute:

```json
{
  "type": "wallets",
  "amounts": {
    "0x1000000000000000000000000000000000000001": "3000000000000000000",
    "0x2000000000000000000000000000000000000002": "6000000000000000000"
  }
}
```

## Distribution and logs

- The generator verifies active entries and adds exact wallet credits through `createMultiMerkle`. Normal CSV allocations and claim-aware carry continue unchanged.
- `log.json` includes `Recoveries` (IDs, mode, source epochs, amount, funding transaction, recipient count) and `PrefundedRewards` (exact amounts by token symbol). Console events distinguish `merkle_recovery_pending`, `merkle_recovery_preview` and `merkle_recovery_applied`; reconstruction notifications show recovery amounts and funding hashes.
- `bounties-reports/<period>/sdtokens-recoveries.json` archives complete inputs, verified funding block/hash and exact wallet allocations. It is committed with distribution artifacts and included in the existing IPFS evidence step.
- Inputs and allocations must match archived evidence on reruns. Moving an entry to another period, deleting it, changing its recipients or reusing its funding fails. A past target without generated evidence blocks the next distribution. Keep completed entries in the ledger permanently. A legitimate remaining source portion can use another entry and another funding transaction.
- Recovery funding is separate from ordinary BotMarket report proceeds. The legacy distributor-attribution mode removes the verified recovery transfer from its ordinary weekly reconciliation. No OTC or swap-report exclusions are needed.
- Funding preparation uses `max(tree liability - distributor balance, 0)`. Surplus accounting subtracts verified prefunding from rewards still expected to arrive; it does not relax the existing surplus threshold.

## Operator sequence

1. Add and review the entry with `funding: null`. For historical mode, preview with `pnpm tsx script/sdTkns/recoveries.ts --preview <id> <amount-wei> <output.json>`. A preview never activates an entry.
2. Choose a target period before its first recovery-evidence generation. Review conversion and direct-transfer transactions, then execute them from the funding wallet.
3. Record the actual funding receipt and amount; update explicit wallet amounts if applicable. Review and merge the completed entry before generation. Do not reuse a period with existing recovery evidence or a verified distribution.
4. Run the normal report, pre/post-freeze, reconstruction and root checks. Review `Recoveries`, the archived wallet amounts and the remaining funding cap. Setting `funding` does not send transactions or publish a root.

Each entry uses one funding transaction. Different distributions require separate entries; this module does not cover vlCVX or Universal Rewards Distributor pipelines.
