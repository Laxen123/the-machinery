# Fold procedure — canonical body-merge mechanics

**Canonical source for this procedure.** Two callers execute it: standalone `consolidate` (the cold
quick-fold entry) and `board-pass` Phase 2 (executing an operator-approved fold proposed in Phase 1).
Both reach this file only AFTER their own confirm gate has already fired — this procedure assumes the
operator has said go and begins at drafting/minting, not at proposal.

**Precondition — the caller owns the propose+confirm gate, this file owns execution only:**

- `consolidate` gets its go from its own step 3 (draft to `.scratch/consolidate-<slug>.md`, present the
  table + consequence, STOP for the nod).
- `board-pass` gets its go from the operator's per-item reply to the Phase 1 report — Phase 1 already
  drafted the consolidated body as part of proposing it, so Phase 2 does not re-draft; it reuses that
  draft directly at step 2 below.

Never run any step here before the relevant caller's gate has fired.

## Eligibility (verify before drafting, in either caller)

A plan is foldable only if it is:

- in `ready/` OR `waiting-{blocked,operator,trip}/` — NOT `in-progress/` (a live worktree — never fold)
  and NOT `archive/`;
- unclaimed — `node scripts/claim-plan.mjs status <id>` reports not held (claim refs live on the REMOTE
  and are not in the default fetchspec, so a local `git show-ref` misses a live claim; a raw `git
ls-remote origin refs/claims/<id>` is doubly wrong now — the live namespace is
  `refs/heads/coord/claims/<id>` since plan 3756, and a ref existing no longer proves the plan is held,
  since release appends a tombstone commit rather than deleting the ref — `status` is the one command
  that reads the held/released predicate correctly) AND no board row. **Re-check IMMEDIATELY before step 4's archive**, not
  only at drafting time — a parallel session can claim a member in the minutes between (the plan-1659
  fold race, 2026-07-10: eligibility passed, then a pickup landed before `move-plan <id> archive` ran,
  archiving an in-flight plan out from under its holder);
- genuinely coupled to its group per the share-a-land criterion (`batch-train/references/share-a-land.md`)
  — a candidate that only shares a tag doesn't collide; drop it.

## Step 1 — Reconcile the merged plan's banners + metadata

| Field                 | Rule across the group                                                                                                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SEED-WRITE**        | `🟥` if **ANY** member is `🟥` (the merged plan inherits the LANDING-mutex / seed-serialize). `🟩` only if **all** members are `🟩`.                                                                                                                                                                                        |
| **Cost forecast**     | **Sum** the members' forecasts **per axis** (plan 3748) — Cash summed with Cash, Claude summed with Claude; a legacy member's one figure counts toward Cash. If any carries `$`/SDK-credit spend, carry it forward explicitly on the one-line banner — don't round to `$0` because most members are free.                   |
| **Category**          | The shared category. If mixed, pick the dominant one; if genuinely split, surface to the operator rather than guess.                                                                                                                                                                                                        |
| **Tasks**             | Preserve **every** task verbatim, grouped under a per-source header (`### Group A — <concern> (from plan NNN)`). Drop nothing; keep "optional"/"if cheap" qualifiers from the originals.                                                                                                                                    |
| **Status & blocking** | The merged plan inherits the **most-restrictive** member state: any member in `waiting-blocked` → merged is `waiting-blocked` (carry the `Blocked-by`); `waiting-operator` → carry `unblock:` + the ask; `waiting-trip` → carry the trip-condition; else `ready`. File it to **that** folder (step 3), not always `ready/`. |
| **Provenance**        | A `## Provenance` section listing each source plan id + its one-line trigger, so the fold is auditable.                                                                                                                                                                                                                     |

If the group mixes a `🟥` and a `🟩` plan, note in the (already-confirmed) record that folding
**serializes the `🟩` work behind the seed mutex** — this is a disclosure at execution time, not a
re-ask; the tradeoff should already have been surfaced during propose.

**Cross-status folds need a reason**, already vetted at propose time: folding a `ready` plan together
with a `waiting-blocked` one drags the shippable work behind the block. Default to folding within one
status; a cross-status fold reaching this file should already carry the operator's opt-in.

## Step 2 — Draft body (if not already drafted at propose time)

Body = frontmatter `summary:` (must match the `--blurb` you will pass — `claim`'s idempotency check
compares them; keep it under the 600-char INDEX brevity cap) + the two reconciled banners + `## Provenance`

- the grouped tasks + `## Verification gates`. `consolidate` drafts this to
  `.scratch/consolidate-<slug>.md` at its own step 3; `board-pass` Phase 1 drafts the equivalent inline in
  its report so Phase 2 can lift it verbatim.

## Step 3 — Mint the consolidated plan

```bash
node scripts/next-plan-id.mjs claim --category <Category> --slug <slug> \
  --body .scratch/consolidate-<slug>.md \
  --blurb "<exact summary frontmatter>" --seed-write yes|no
```

`--category` must come from the allowlist and a country-scoped slug carries its country token
(`se`/`no`/`dk`/`uk` — prose says `uk`, never `gb`); an unknown category hard-fails the mint gate
(plan 2329). Table + rules: `docs/coord/plan-lanes.md` § Plan naming.

Reserves the id by push-win, writes to `ready/`, adds the INDEX bullet, commits+pushes atomically.
**Read the minted id from its output** — call it `NNN`. Everything below needs the real `NNN` (you
cannot pre-stage the supersede edits before it exists).

If the reconciled status (step 1) is `waiting-*` (a cross-status fold), move the freshly minted plan to
that folder right after claim, so it lands with its inherited blocking state:

```bash
node scripts/move-plan.mjs NNN waiting-<kind> --blocked-by "<carried reason>"   # + edit-plan for unblock:/trip-condition
```

## Step 4 — Supersede-archive each original (two calls per plan)

For each original `<id>`:

```bash
# (a) archive: git mv → archive/, stamps body Status → "✅ COMPLETED — archived <date> (move-plan).",
#     regenerates the INDEX generated region (drops its ready bullet), commits+pushes.
node scripts/move-plan.mjs <id> archive

# (b) make the body HONEST: a folded-in plan was NOT completed — flip the stamped status to SUPERSEDED.
#     Read the archived file's now-stamped "**Status:** ✅ COMPLETED — archived <date> (move-plan)." line
#     VERBATIM and pass it as --find (edit-plan fails loud if --find is absent, so copy it exactly).
node scripts/edit-plan.mjs <id> \
  --find "**Status:** ✅ COMPLETED — archived <date> (move-plan)." \
  --replace "**Status:** 🗄️ SUPERSEDED by plan NNN — tasks folded into \`<new-slug>\` (Group X); archived <date>, not executed standalone."
```

The find/replace is idempotent (once replaced, the `✅ COMPLETED …` find string is gone, so a re-run
no-ops via coordWrite's empty-diff short-circuit).

## Step 5 — Write the browsable archive note (one `coord-edit`)

`move-plan` regenerates only the **generated** INDEX region; archived plans need a one-line **prose**
note in the archive region (below `<!-- INDEX:PLANS-END -->`). Hand-edit `docs/INDEX.md` in the MAIN
checkout, adding one line per superseded original:

```markdown
- `654-Infra-….md` — archived 2026-06-15, superseded by plan NNN (`<new-slug>`); not executed standalone, tasks folded into Group A of NNN.
```

Land all the lines in ONE commit:

```bash
node scripts/coord-edit.mjs --paths docs/INDEX.md --message "docs(plans): supersede <ids> → NNN (consolidate)"
```

## Step 6 — Verify

```bash
node scripts/build-index.mjs --check          # generated region consistent (exit 0)
git -C "$(git rev-parse --show-toplevel)" status -s   # clean — everything self-committed
ls docs/superpowers/plans/ready/ docs/superpowers/plans/archive/   # NNN in ready/, originals in archive/
```

Report to the operator: minted `NNN`, superseded `<ids>`, and that `NNN` is now a normal `ready/` plan
(pick it up via `pickup-plan` when it's time to execute — this procedure does NOT start the work).

This runs from the **MAIN checkout on master**, never a worktree — minting, archiving, and editing plan
bodies are coordination-doc operations (the `check-coordination-branch` guard rejects a worktree-branch
attempt).

## Common mistakes

| Mistake                                                               | Why it bites                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Execute this procedure without the caller's confirm gate having fired | You archived never-executed plans on a guess. The confirm gate belongs to the CALLER (consolidate step 3, or the board-pass Phase 1→2 operator turn) — this file has no gate of its own.         |
| `--find` the **original** Status line for the supersede edit          | `move-plan archive` already rewrote Status to `✅ COMPLETED — archived <date> (move-plan).`; the original line is gone, `edit-plan` exits 2. Read the **post-archive** line and use it verbatim. |
| Assume `move-plan` writes the archive prose note                      | It writes only the **generated** region. The browsable archive line is hand-edited + landed via `coord-edit.mjs` (step 5).                                                                       |
| Invent a verification command                                         | Only `build-index.mjs --check` + `git status` + an `ls` are needed. There is no `landing-queue-board.mjs`, no `move-plan --note` flag.                                                           |
| Round the merged cost to `$0`                                         | Cost is the **sum**; a member with `$`/SDK spend keeps it. SEED-WRITE is `🟥` if **any** member is.                                                                                              |
| Leave the body marked `✅ COMPLETED`                                  | A folded-in plan wasn't completed — that lies to the next reader. Step 4(b) flips it to SUPERSEDED.                                                                                              |
| Do it in a worktree                                                   | Coordination-doc work lands on master; `check-coordination-branch` rejects the branch path. No worktree.                                                                                         |
