# Execution batches — one folder per batch

Each batch is a folder `docs/superpowers/batches/<slug>/`: `batch.md` is the roster entry (the
claimable unit) and `manifest.json` is written beside it when the batch is claimed. A landed
batch's folder moves under `archive/`. Cross-batch edges live in `dependencies.md` beside this
file. Mechanism: `docs/coord/plan-lanes.md` § Batch lanes. `node scripts/batches-view.mjs`
renders the roster; `node scripts/claim-plan.mjs batch <ids…> --slug <slug>` claims one.

`batch.md` frontmatter contract:

```
---
slug: <slug>
lane: <mutation-banner marker>
members: [<id>, <id>]
gate: null # null (runnable now) | an objective blocker, e.g. "item <id> lands"
status: proposed # proposed | claimed | landed
---
```

## Fable lane

Heavy-lane items never ride a batch; each executes solo. One bullet per item, if any.

## Not batched

Ready items deliberately kept solo. One bullet per item, with the reason.
