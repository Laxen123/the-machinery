---
name: batches
description: Use when the operator asks for the batch roster, "/batches", "show the batch roster", "which batches are claimable", or wants to see proposed execution-batches before running a batch-train. Read-only VIEW — the twin of the project's `/landing-queue` command — never mutates anything. Requires no model tier; a Sonnet session can run it.
---

# /batches — read-only view of the proposed batch roster

Render the batch roster — since plan 1467 each batch is a FOLDER `docs/superpowers/batches/<slug>/batch.md`
(the operator-approved roster a `board-pass` Phase 1 sweep maintains, plan 1364/1373/1467), plus the ONE
global `docs/superpowers/batches/dependencies.md`; the renderer falls back to the retired `proposed.md`
mega-table with a deprecation warning — as a scannable table, instead of raw markdown. **The twin of
the project's `/landing-queue` command** — same shape (a thin skill/command that shells a read-only
`scripts/*.mjs` renderer and prints its output verbatim), applied to the batch roster instead of the
landing-queue FIFO.

**Location note:** `/landing-queue` actually lives as a the project _project_ slash command
(`the project/.claude/commands/landing-queue.md`), not a `coord/skills/` master — so "mirror the
landing-queue skill" means mirror its _shape_, not its literal location. This skill is minted under
`coord/skills/` per plan 1373 D8 regardless (a coord master, junctioned into `~/.claude/skills/`,
usable from any project that adopts the shared coord tooling) — see this file's own report-back for the
inconsistency flagged to the operator.

## What it does

1. Runs `node scripts/batches-view.mjs` from the the project repo root and prints its output **verbatim**.
2. That script scans the `docs/superpowers/batches/<slug>/batch.md` folders (+ `dependencies.md`) and
   renders one row per `proposed` batch — both runnable and gated (a gated batch shows a `⛔ gate(...)`
   flag) — (pass `--html [out]` for a self-contained HTML overview instead — default
   `.scratch/batches-view.html`, plan 1430; open it rendered via the render-html MCP, never as a raw file
   path):

   ```
   Proposed batches: <N> (<M> flagged ⚠) (<X> 🟣 fable-lane).
   ┌────────────┬──────┬─────────┬───────┬──────────────┬──────┐
   │ Batch slug │ Lane │ Members │ Model │ Dependencies │ Flag │
   ├────────────┼──────┼─────────┼───────┼──────────────┼──────┤
   │ ...        │ 🟩/🟥│ ...     │ 🟢/🟣 │ ...          │ ...  │
   └────────────┴──────┴─────────┴───────┴──────────────┴──────┘
   ```

   Each parenthesised count is omitted when it is zero, so a clean all-sonnet board prints the
   bare `Proposed batches: <N>.` The two counts are SEPARATE on purpose (plan 2556): `flagged ⚠`
   is the warning axis (drift), `🟣 fable-lane` is a routing label for trains that are runnable
   but need a heavy conductor rather than `batch-train`.

   plus a "Fable lane" list (singles that never batch — see below), a "Not batched" list
   (`ready/` singles the last sweep considered and declined to group), and — since plan 1496
   (operator ask 2026-07-06) — a **"Ready plans by category"** section: every plan currently in
   `ready/` (LIVE-scanned from the plans tree, not the roster doc), grouped by its filename
   category prefix (DQ / UI / Infra / Reuse / Fix / Other / …), one line per plan:

   ```
   Ready plans by category (<N> total, <M> 🟣 fable; cost = spend beyond the executing session):
     DQ (13):
       1015 🟣 <plan H1 title = what it does> — <💰 cost-forecast line, condensed> [in <batch-slug>]
       ...
   ```

   The cost is each plan's own mandatory 💰 banner — out-of-pocket spend (API / scraping /
   `claude -p` dollars) on top of the session that executes it, NOT the session itself. `[in …]`
   marks members of a proposed batch. This section renders even when no batch folders exist.

3. Stop there. This skill never edits a `batch.md`, never runs `move-plan`/`edit-plan`, and never
   invokes `batch-train` itself — it only shows the roster so the operator (or a train conductor) can
   decide what to claim.

## Columns, in plain terms

- **Batch slug** — the batch folder's id, e.g. `batch-2026-07-05-seed-heavy`.
- **Lane** — 🟩 free (merges without a mutex) / 🟥 seed (serializes against overlapping-shard seed
  lands) — the same lane semantics as everywhere else in the coord tooling.
- **Members** — the plan ids riding this batch.
- **Model** — one 🟢 (sonnet) or 🟣 (fable) icon per member, in member order, read LIVE from each
  member's current frontmatter (`execModel:` or a `FABLE-` filename segment) — never from a value
  cached in the batch.md, which would drift the moment a plan gets re-stamped. **No 🔶 (sol) ever
  appears here** — batch eligibility requires `execModel: sonnet` (plan 3341), so `sol` never
  reaches a roster row; a 🔶 showing up anywhere in these views is a drifted member, not a third
  valid icon for this column.
- **Dependencies** — edges from `dependencies.md`'s `## Dependencies` block that mention this batch or any
  of its members: `blocked-by` / `overlaps` / `order-after`, rendered verbatim with an optional reason
  (e.g. a colliding data shard). `—` if none.
- **Flag** — see below (including `⛔ gate(...)` for a gated batch whose `batch.md` carries a `gate:`).

## The lane label, and the flag that matters

- **🟣 fable(<ids>)** — a member's effective execModel is `fable`. This is a **routing label, not
  an error**: the row is a fable CO-EXECUTION GROUP and it is claimable, just not by
  `batch-train` (a Sonnet-only mechanical conductor, which is why the distinction is worth
  keeping). Its executors, since plan 2556: a heavy local session via `/local-drain`
  (Modification 3 — the batch arrives in the filter's `localBatches[]`), or the `fable-full`
  cloud routine, whose "Fable batch" section runs each car under the thin-orchestrator doctrine
  with a relaxed derail rule. Before 2556 neither existed, the flag rendered as `⚠ fable(...)`,
  and the row genuinely WAS unclaimable — the plan-2459 runnable-batch hold blocked every member
  from every drain while nothing could take the train. Don't "fix" a fable row by dropping the
  member; that's a board-pass call, not this skill's.
- **⚠ drift(<ids>)** — a member's _current_ plan folder (checked live against the actual
  `docs/superpowers/plans/*/` tree, not the roster's snapshot) is anything other than `ready/`. The
  roster's own contract is "every member is ready + specced, and all members share ONE lane";
  anything else means the member was claimed (→ `in-progress/`), re-parked (→ a `waiting-*/`),
  already landed (→ `archive/`), or is simply missing since the roster was last written. A drifted
  batch is stale — the fix is another `board-pass` sweep to reconcile the roster, not a hand-edit
  here. **Note the lane clause is HOMOGENEITY, not sonnet-only** (plan 2556): an all-fable roster is
  a legitimate runnable batch, and only a MIXED-lane roster is a defect — `checkBatchEligibility`
  refuses that one at claim time. Drift is about the FOLDER, never about the lane; a 🟣 row is not
  drifted.

A batch with no ⚠ flag and an all-🟢 model column is claimable by `batch-train` right now; one with
a 🟣 label and no ⚠ is equally claimable, by the fable executors named above. Both cases carry one
frontmatter check the view does NOT render: a member stamped `loop: hitl` (plan 1668) makes the
batch genuinely unclaimable in EITHER lane — a hitl plan needs a live operator exchange, and no
conductor, mechanical or heavy, can supply one unattended. `batches-view.mjs` has no hitl flag and
`claim-plan.mjs batch` does not check the key — the exclusion lives in the board-pass sweep and
batch-train's own eligibility step, so verify member frontmatter when in doubt. An absent `loop:`
key is unconstrained (stamp is forward-only).

## Who produces the input, who renders it

- **`board-pass` Phase 1** (`coord/skills/board-pass/SKILL.md` § Batch sweep) computes and reconciles
  the batch folders + `dependencies.md` every pass — batch membership, per-member execModel annotation,
  and the `## Dependencies` block. This skill does not compute any of that; it only reads what board-pass
  wrote.
- **`scripts/batches-view.mjs`** (the project repo) is the parser + table renderer — the actual
  markdown-to-table logic, the live member re-resolution (via `move-plan.mjs`'s `lsPlans`/
  `resolvePlanRel`/`statusOf`), the fable/drift flag computation, and the box-drawing. This skill is
  just the operator-facing entry point that invokes it and presents the result; read that script's
  header comment for the exact `## Dependencies` block grammar and the flag-computation rules if you
  need more detail than this file restates.

## Rules

- **Read-only, no exceptions.** No `coordWrite`, no `move-plan`, no `edit-plan`, no `batch-train`
  invocation from inside this skill. If the operator wants to act on a row (claim a batch, resolve a
  flag, promote a drifted member), that is a separate, explicit next step — this skill's job ends at
  printing the table.
- **No fabrication.** Every line traces to `batches-view.mjs`'s actual output. If the script errors or
  no batch folders exist, report that verbatim (the script already degrades gracefully — no roster
  prints a "nothing proposed" line, not a crash) rather than guessing the roster.
- Runs from the the project repo root (or wherever the coord tooling's `canonicalRepoRoot()` resolves it) —
  no worktree needed, no model-tier requirement.
