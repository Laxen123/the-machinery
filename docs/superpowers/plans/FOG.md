# Fog ledger — "Not yet specified" + "Out of scope"

Two board-level ledgers in one file, with OPPOSITE graduation rules (`docs/coord/plan-lanes.md`
§ The two-ledger idea: fog vs. out-of-scope): fog graduates INTO plans; out-of-scope never
graduates at all. It is a ledger, not a plan — the index and plan lints skip it. Edit it on the
main branch through the coordination write path, like any coordination document, never on a
worktree branch.

## Not yet specified

In-scope questions too dim to phrase as a plan yet. A plan when the question can be stated
precisely now, even if blocked; fog when it cannot. One bullet per patch:
`- <suspected question / area> — <context> (fogged YYYY-MM-DD)`. A board-pass re-tests each
patch; when one can be phrased precisely, mint the plan(s) and delete the patch in the same pass.

## Out of scope

Permanent ledger of ideas killed as beyond the current goal. One bullet per kill:
`- <gist> — out of scope because <why> → archive/<file>.md (killed YYYY-MM-DD)`. Entries never
graduate back; they return only as a fresh plan if the goal itself is redrawn.
