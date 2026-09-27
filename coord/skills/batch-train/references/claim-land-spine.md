# Claim + land spine — the canonical claim-plan.mjs / done-worktree.mjs mechanics

**Canonical source for this doctrine.** Written once (plan 1373 D7) to end the drift risk of
independently re-describing the claim mechanism and the land mechanism in every skill that uses them.
Cited by `pickup-plan` (single-plan claim + land), `batch-train` (multi-plan all-or-release claim + one
shared land), and `orchestrate` (the autonomous drain orchestrator) — whichever of those exists as a
coord-scope master at the time you're reading this; as of plan 1373's authoring, no `orchestrate` master
exists under `coord/skills/` (the autonomous orchestrator implements the same spine ad hoc, undocumented
here — a future coord-scope `orchestrate` master should cite this file instead of re-describing it).
Each consumer keeps its own use-case-specific step-by-step (the literal bash, its own dispatch shape,
its own risk-ordering) — this file is the underlying model those steps implement, not a replacement for
them.

## The claim half — the claim ref is the source of truth

`git ref refs/heads/coord/claims/<id>` (moved off the flat `refs/claims/<id>` by plan 3756, because a
cloud sandbox's mandatory proxy hard-403s that legacy namespace outright; legacy refs are still read
during the migration window — `scripts/coord/coord-refs.mjs` is the ONE authority for both names) — or, for a
batch, one ref per member acquired together — is the single source of truth for "who holds this plan."
Everything else — a board row, an `in-progress/` folder location, a session-entry stub — is a
**projection** of that ref, not the lock itself. **A ref existing no longer proves the plan is held**:
since plan 3756 a release appends a `claim RELEASED plan=<id>` tombstone commit instead of deleting the
ref, so check liveness with `claim-plan.mjs status <id>`, never a raw `git ls-remote`.

- **Acquire is an atomic compare-and-swap.** `claim-plan.mjs acquire <id> --slug <slug> --seed-write
yes|no` (single plan) or `claim-plan.mjs batch <id1> <id2> […≤5] --slug <batch-slug>` (2–5 plans,
  **all-or-release**: every ref acquires or none do) — two sessions racing for the same plan(s) cannot
  both win, unlike an optimistic board-row append which has no such gate.
- **On win (`{"won":true,…}`)** the tool projects deterministically, in ONE commit, pushed atomically:
  a board `🔄 ACTIVE` row, the plan body's `Status:` flip (plus an `**Override:**` note if the claim
  bypassed a `waiting-*/` gate), `git mv` into `in-progress/`, an INDEX repath, and a session-entry stub
  (one shared entry listing every member, for a batch) plus — for a batch — the write-once manifest
  `docs/superpowers/batches/<batch-slug>/manifest.json`.
- **On loss (`{"won":false,…}`)** the JSON names the holder (session/host/time). STOP unconditionally —
  never reinterpret a plan that already looks claimed as your own resume. Positive ownership requires
  EITHER a `{won:true}` you personally received this session, OR `claim-plan.mjs status <id>` reporting
  `youAreHolder: true`. A worktree-owner-guard PreToolUse hook additionally blocks a write into a
  worktree a different session owns, as a backstop against a misread here.
- **`activePathFor` resolves across every claimable folder** — `ready/`, `pending-approval/` (plan 1371;
  the default fresh-mint holding folder, superseding the retired `drafting/`), and every
  `waiting-{blocked,operator,date,trip}/` — so claiming a parked plan projects and promotes it directly;
  no separate unblock step exists. The tool does not judge whether a `waiting-*/` gate MAY be bypassed —
  it claims unconditionally; that human judgment belongs to whoever calls `acquire` on a gated plan.
- **`release-claim.mjs release <id>`** releases the claim — since plan 3756 by appending a tombstone
  commit, not by deleting the ref (the proxy 403s deletes by verb); actual ref deletion is the separate,
  off-critical-path dead-claim reaper chore, run from an environment whose pushes may delete. Wired
  into `done-worktree` on land, or called
  directly on abandon. **`reconcile-board.mjs`** reports ref↔board drift when the two disagree.

## The land half — `done-worktree.mjs` is the deterministic spine

`done-worktree.mjs <slug>` (or `<batch-slug>` for a batch) runs the same fixed sequence every time —
this determinism is what makes the review-marker gate, the deploy-check, and carry-forward extraction
reliable instead of ad hoc:

1. **Preflight** — gates green, a recorded review marker present and un-stale, `FINDINGS_OPEN` clear.
2. **Merge** into master — FIFO-serialized via the landing queue; a `🟥` seed-write land additionally
   serializes against any OTHER `🟥` land touching an OVERLAPPING data shard-set (scoped mutex since
   plan 1300 — disjoint-shard `🟥` lands and `🟩` lands merge freely).
3. **Deploy-check** — verifies the project's deploy story is consistent; **never deploys itself** (deploy
   stays a separate, operator-gated step where the project requires manual deploys).
4. **Archive** the plan(s) (`move-plan … archive`) and extract any remaining carry-forwards into NEW
   plans (never left as an unfiled TODO).
5. **Board + claim cleanup** — remove the ACTIVE row(s), release the claim ref(s) via `release-claim.mjs`.
6. **Teardown** — the worktree directory and branch, local and remote.

For a **batch**, step 4 onward runs ONCE for every surviving member together: one `done-worktree` call
archives all landed members, releases every claim, removes every board row, and frees the ONE
landing-queue slot the whole batch held. There is never a per-member land inside a batch — landing early
defeats the tax savings the batch exists to capture and desyncs the shared claim/board state for the
remaining cars.

## Common mistakes

| Mistake                                                                                       | Why it bites                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Treating a `{won:false}` or an already-`in-progress/` plan as "probably my own earlier claim" | The single most damaging skip on record (a same-tree double-work collision). A projected claim looks identical whether it's yours or a live sibling's — only a `{won:true}` you received, or `youAreHolder: true`, is proof. |
| Using `--lock-only` for a real pickup                                                         | Acquires the ref and projects NOTHING — no folder move, no board row, no session entry. Tests/dogfood only; a real pickup that uses it and skips the manual projection strands the plan invisibly.                           |
| Landing a batch member separately because it's ready first                                    | Breaks the one-land invariant the batch exists for; also desyncs the shared manifest/board state for the cars still running.                                                                                                 |
| Re-deriving the claim or land mechanism independently in a new skill                          | This file is the single source (plan 1373 D7) — point at it instead of writing a fourth description that can drift.                                                                                                          |
