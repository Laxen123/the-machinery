# audit-harness — internals

What the orchestrator slash command (`.claude/commands/audit-with-verification.md`) consumes. Humans reading the runbook (`docs/superpowers/AUDIT-RUNBOOK.md`) usually don't need to open this directory.

## Layout

```
docs/superpowers/audit-harness/
├── schemas/
│   └── finding.schema.json        # JSONSchema — the Stage-1 → Stage-2 contract
└── templates/
    ├── reviewer-prompt.md         # Stage-1 reviewer (parallel, N=4 default)
    ├── verifier-web-prompt.md     # Stage-2 verifier — URL targets, Playwright MCP
    ├── verifier-code-prompt.md    # Stage-2 verifier — file/dir targets
    └── report.md.template         # Stage-3 markdown output template
```

## Design invariants

1. **Reviewers are untrusted.** Their `evidence` field is informational only — the verifier always re-observes. This is the core safety property; without it, Stage 2 is just a Sonnet rubber-stamp.
2. **Verifier never patches a finding.** If the reviewer's `repro_check.input` is wrong (typo in selector, wrong file path), the verdict is `rejected` or `ambiguous` — not "verified after fixing the selector." Patching would silently launder reviewer error.
3. **`repro_check` is the contract.** Findings without a coherent `repro_check` are dropped before Stage 2 by the orchestrator (logged as `pre_filter_reason`). This forces reviewers to commit to a testable claim.
4. **Reviewer fabrication is a known failure mode.** Agents sometimes quote content from URLs that don't resolve. The Web verifier's first action is `browser_navigate`; if that fails, verdict is `ambiguous` regardless of the reviewer's "evidence".

## Editing prompts

Tune in place. The slash command reads these at dispatch time. After a tuning pass, re-run a smoke test (a known-quirky target with a few known-good findings) and confirm verdicts come out as expected.

## Lessons from the first live-site run (2026-05-17)

Three calibration issues found and fixed in this run:

1. **Always use full template substitution.** The orchestrator dispatch abbreviated the reviewer prompt by hand — losing the `## Example finding shape` block. Reviewers then drifted schemas (R3/R4 used `area`/`detail`/`expression`/`actual` instead of the schema-canonical fields). The pre-filter caught these but Stage-1 budget was still wasted. **Enforced:** reviewer-prompt.md Rule 9 now explicitly requires full template, and instructs reviewers to surface abbreviated prompts as a meta-finding.

2. **Positive observations are not findings.** R3 returned 14 items, 8 were "zero console errors", "icons correctly served", etc. These inflate finding counts and waste budget. **Enforced:** reviewer-prompt.md Rule 8 now explicitly prohibits positive observations in the JSON output.

3. **Perf reviewer slot needs a goal-oriented prompt.** R3 ("perf + network") returned only metrics observations, zero architectural issues. The prompt shape should be "find code paths that would benefit from changing" not "describe what you observed". **Recommendation:** either merge perf into a11y/UX slots (perf findings need rendering context to be actionable), or give the perf slot a custom prompt in the slash command that leads with "identify changes that would improve" not "observe and report".

## Adding a new repro_check type

1. Add it to the `repro_check.type` enum in `schemas/finding.schema.json`.
2. Add a branch to the relevant verifier template explaining how the verifier executes it.
3. Update `reviewer-prompt.md` so reviewers know the new type exists.
4. Update the runbook's failure-modes section if the new type has a distinctive failure mode.
