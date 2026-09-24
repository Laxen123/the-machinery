---
name: consolidate
description: Use for a COLD quick-fold — merging two or more open plans into one when no board-pass swept the board this session. If a board-pass just ran and proposed a fold, its Phase 2 executes that fold in-skill — don't invoke consolidate separately for it. Triggers - "consolidate these plans", "merge plans X/Y/Z into one", "these two are dupes, fold them", "find consolidation candidates", "audit the plans for overlap", "/consolidate".
---

# consolidate — cold quick-fold entry (fold mechanics live in `references/fold-procedure.md`)

**Narrow remaining scope (plan 1373 D2).** board-pass Phase 2 now executes an approved fold in-skill,
reusing its own Phase 1 analysis — no separate consolidate invocation needed for that path. This skill
survives ONLY for the **cold** case: an operator (or you) spots overlapping plans mid-session, with no
board-pass run backing it, and wants the fold done now. **board-pass Phase 2 and this skill are the two
callers of the same `references/fold-procedure.md`** — the body-merge mechanics live there once; neither
caller restates them.

**Why consolidate: every plan is a full land.** Each plan clears the landing queue — a FIFO-serialized
merge plus its own `/code-review` and deploy — so N related plans cost N land cycles. Folding them into
ONE plan means ONE worktree, ONE review, ONE queued land: **cutting the land count is the payoff.** A
second reason when they touch the same files: landed separately they rebase-conflict.

**The discipline: PROPOSE → CONFIRM → EXECUTE.** You are archiving plans that were never executed —
unusual and irreversible-ish (the originals leave their folder for good). NEVER mint the consolidated
plan or move an original until the operator has seen the proposal and said go. **Consolidate owns the
confirm gate; `references/fold-procedure.md` owns execution only** and refuses to be entered before that
gate fires.

## Be conservative — several small folds beat one big plan

Consolidation earns its keep by **saving land cycles** (and, secondarily, removing file-collisions). A
too-big fold costs more than it saves. Fold by **coherent work unit** — plans in the same subsystem /
closely-related concern that one person would sensibly build in one worktree and land together:

- **Don't cross subsystems just to cut a land.** Folding unrelated concerns makes an incoherent review
  and a land where one half's failure or conflict blocks the other. Net-negative.
- **Size to one context window.** Estimate the combined work and fold only if a single worktree session
  could execute it comfortably (rough ceiling: under ~50% context-window utilization, leaving headroom
  for review + iteration). Unsure → lean smaller; un-folding a landed plan is painful.
- **Prefer several coherent folds over one catch-all.** Two 2–3-plan folds in different subsystems beat
  one 6-plan mega-plan.
- **A shared category tag alone is NOT enough.** `Infra` spans done-worktree tooling, the price pipeline,
  CI — different subsystems.

## When to use

- Two or more open plans overlap (same subsystem, shared file-surface, or one incident cluster) and no
  board-pass ran this session to catch it — a cold fold.
- The operator asks to "consolidate", "merge into one plan", "summarize the X plans into one", mid-session,
  outside a board-pass.
- The operator asks to scan/audit all open plans for consolidation opportunities (SWEEP mode) without
  wanting a full board-pass.

**Do NOT use for:**

- A fold a board-pass Phase 1 just proposed — let Phase 2 execute it (reuses the analysis; no re-derivation).
- Plans in `in-progress/` or otherwise claimed (a HELD claim ref — check `claim-plan.mjs status <id>`,
  since a released ref is tombstoned rather than deleted and its mere existence proves nothing — or a
  board row) — a live worktree owns them. Surface the conflict; don't fold claimed work.
- Plans that merely share a category tag but have disjoint file-surfaces and unrelated concerns.
- A single plan (nothing to consolidate).

## Eligible folders

`ready/`, `pending-approval/` (plan 1371 — the default fresh-mint holding folder; a stub sitting there can
still be a genuine dupe of something already `ready/`), and every `waiting-{blocked,operator,trip}/` —
NOT `in-progress/` (live worktree, never fold) and NOT `archive/`. Full eligibility gate (claim check,
coupling test): `references/fold-procedure.md` § Eligibility.

## This is master-side coordination work — NO worktree

Minting, archiving, and editing plan bodies are coordination-doc operations. Run every step from the
**MAIN checkout on master** — `references/fold-procedure.md` covers this in full (its Step 6 / closing
note); this file doesn't restate it.

## Project conventions vary

This skill describes **the project** conventions (`NNN-Category-slug.md`, the `next-plan-id.mjs` /
`move-plan.mjs` / `edit-plan.mjs` / `coord-edit.mjs` tool suite, the two top banners). Adapt the surface
details to the project; keep the flow (select → decide fold-vs-batch → reconcile → propose → confirm →
execute via the shared procedure).

---

## Steps

### 1. Select the candidate group(s) — TARGETED or SWEEP

**TARGETED** — the operator named a set or a theme:

- **Explicit ids** (`/consolidate 654 659 661 662`) — use them; still run the eligibility gate.
- **By theme** (`consolidate the infra plans`) — list the active folders, filter to the theme (shared
  `NNN-<Category>-` tag and/or file-surface), propose that one cluster.

**SWEEP** — bare `/consolidate`, "find consolidation candidates", "audit the plans for overlap": scan ALL
active plan folders (including `pending-approval/`) and propose a **ranked shortlist**:

```bash
ls docs/superpowers/plans/pending-approval docs/superpowers/plans/ready \
   docs/superpowers/plans/waiting-blocked docs/superpowers/plans/waiting-operator \
   docs/superpowers/plans/waiting-trip
```

Read each plan's banners + tasks, cluster by subsystem / closely-related concern, apply the coherence
test ("Be conservative"), and present the candidate clusters as a shortlist — each with members,
why-they-collide, member statuses, and a one-line recommendation. **Propose only; fold nothing in sweep
mode.** A sweep that finds no genuine collisions reports "nothing worth folding" — that's a valid result.

### 2. Decide fold vs. batch vs. leave separate

Apply **the share-a-land criterion** — see `batch-train/references/share-a-land.md` for the full
three-outcome test and eligibility rules; don't restate it here. If the group is coupled mainly by land
overlap but each member is still a coherent standalone unit, propose `batch-train` instead of folding
(batching is cheaper — it keeps per-plan identity). Reserve the fold below for true duplicates or a work
item mistakenly split into pieces that don't stand alone.

### 3. Reconcile + draft + PROPOSE — then STOP for the operator's nod

Reconcile the merged plan's banners/metadata and draft its body per `references/fold-procedure.md` §§
Step 1–2 (SEED-WRITE / cost-forecast / category / tasks / status reconciliation rules, and the
`.scratch/consolidate-<slug>.md` draft format) — that file owns the mechanics, this step just says: do
those two steps now, as prep for the proposal.

Then present to the operator, and **STOP**:

- a table of the originals (id · concern · file-surface · banners);
- the proposed consolidated plan (slug, reconciled banners, the Group A/B/… task structure);
- the explicit consequence: _"mint 1 new plan + supersede-archive N originals."_

Wait for an explicit go. Do not enter `references/fold-procedure.md` until then.

### 4. Execute (on confirm) — hand off to `references/fold-procedure.md`

Run `references/fold-procedure.md` starting at its **Step 3 (Mint)** through **Step 6 (Verify)** — the
draft from step 3 above already covers its Steps 1–2. Report back per that file's closing instructions:
minted `NNN`, superseded `<ids>`, and that `NNN` is now a normal plan (pick it up via `pickup-plan` when
it's time to execute — consolidation does NOT start the work).

**Out-of-scope kills feed the ledger (plan 1668).** When reconciliation reveals a candidate is not a
fold member but simply beyond the product's goal, and the operator confirms killing it rather than
folding it: archive with the one-liner as usual AND append gist + why + link to the archived plan to
`docs/superpowers/plans/FOG.md` § "Out of scope" (via `coord-edit.mjs`, master-side). The ledger — not
the archive body alone — is what stops the idea being re-proposed by a later sweep; entries never
graduate back (they return only as a fresh mint if the goal itself is redrawn).

---

## Common mistakes

| Mistake                                                                                              | Why it bites                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mint/archive without showing a proposal first                                                        | You archived never-executed plans on a guess. The confirm gate is the skill's reason to exist.                                                             |
| Re-run a fold a board-pass already proposed                                                          | Phase 2 executes it in-skill off the Phase-1 analysis — a separate consolidate invocation re-derives the same reconciliation for nothing.                  |
| Body-merge a group that's coupled only by land overlap                                               | If each member is still a coherent standalone unit and all are `specced`+`sonnet`+same mutex class, that's a `batch-train` candidate, not a fold (step 2). |
| Fold a claimed / `in-progress` / disjoint plan                                                       | Only unclaimed plans in an eligible folder that actually collide. Surface the rest; don't silently absorb them.                                            |
| Restate the mint/archive/supersede commands here instead of following `references/fold-procedure.md` | That file is the single source; a second copy is exactly the drift this split was meant to prevent.                                                        |

## Red flags — STOP

- "The operator clearly wants it, I'll just mint and archive" → No. Show the proposal, get the nod.
- "These share the `Infra` tag, fold them all" → A tag spans subsystems. Fold by coherent work unit.
- "A board-pass proposed this fold, let me re-verify it myself first" → Don't re-derive; Phase 2 reuses
  Phase 1's analysis on purpose.
- "These 3 plans all touch the same file, fold them" → Shared-file coupling alone is the batch signal
  (step 2), not the fold signal, if each is still a coherent standalone plan.
