# Archived: module-based reward expiry

Module-based expiry is retired. Do not deploy or enable its modules or Guard rules.
The module preparation CLI and automatic coordinator are removed. The recovery
preparation workflow fails closed; it does not fall back to creating Safe batches.

Historical ledgers, root artifacts, receipt reconstruction and archived Safe
adoption remain available so ordinary distributions keep their canonical
baseline. Removing code does not cancel a pending on-chain operation, revoke
live permissions or release a publisher hold. Saved module state requires
explicit reconciliation. A replacement expiry design must ship separately.
