# scripts/coord/

The generic coordination CORE — plan-lifecycle, review-marker, and claim/lock machinery that
carries no vetapp-specific knowledge (no record/seed/deploy/market vocabulary). This is the half
of `scripts/` the eventual public extraction (program plan 3958) takes as-is: a fresh checkout of
`scripts/coord/` alone, with nothing under `scripts/project/`, must still load and run its own
tests. `docs/runbooks/scripts-module-layout.md` § Rule 3 is what a pre-push gate enforces to keep
that true — a non-test module here may import only its own siblings (`scripts/coord/**`) and
`node:` builtins, never anything project-specific and never a bare package specifier outside an
explicit, one-line-justified allow-list. See that runbook section for the mechanism, and plan 3959
(program step 1 of 8, "coord-core") for why this split exists and what moves here over the
following program steps.
