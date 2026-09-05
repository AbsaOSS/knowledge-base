# Ledger Sync runbook

What to do when the 06:00 reconciliation alert fires.

## Symptom table

| Alert | Likely cause | Action |
|---|---|---|
| `recon_mismatch` | late-posted journal | rerun `sync --date=<yesterday>` |
| `export_timeout` | ledger read replica lagging | wait 15 min, rerun |

## Escalation

Page the ledger team after two failed reruns.
