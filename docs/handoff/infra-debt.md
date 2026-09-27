# Rolling debt ledger

Sub-floor tooling issues live HERE, not as plans: only a defect that blocks lands or corrupts
data earns its own plan. Anything below that floor, after failing the fix-now test
(`docs/coord/review.md` § Disposition policy), is ONE line here.

**Contract:** one dated line per entry, newest first, under `## Entries`; a pointer to where it
came from (finding key, session, commit, or plan); the failed fix-now clause in parentheses.
Every line carries a category tag right after the date — one of `[land]` `[plans]` `[review]`
`[hooks]` `[cloud]` `[wiki]` `[test]` `[misc]`. Hand-edited on the main branch only, never on
a worktree branch. A board-pass sweeps it periodically and deletes lines that shipped;
`node scripts/coord/infra-debt-report.mjs --check` reports size, shape and whether a sweep is
due.

## Entries
