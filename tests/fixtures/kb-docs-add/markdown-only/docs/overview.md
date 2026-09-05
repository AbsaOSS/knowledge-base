# Ledger Sync

Ledger Sync copies the day's posted transactions from the core ledger into the
reporting warehouse and reconciles the totals, so finance reports agree with the
ledger by 06:00 every morning.

## How it works

1. A scheduled job exports the ledger delta as Parquet.
2. The loader upserts it into the warehouse.
3. A reconciliation query compares debit/credit totals per account.

```mermaid
flowchart LR
  Ledger --> Export --> Warehouse --> Reconcile
```

## Guarantees

| Property | Value |
|---|---|
| Freshness | ≤ 6 hours |
| Idempotent | yes — reruns are safe |
