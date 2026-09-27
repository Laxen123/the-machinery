---
description: Run a parallel-review-then-adversarial-verify audit on a URL, feature spec, or code path. Dispatches N reviewer agents, then one Playwright/Read-Grep verifier per finding. Writes docs/superpowers/audits/<date>-<slug>/report.md with verified findings as the fix queue. See docs/superpowers/AUDIT-RUNBOOK.md for full semantics.
---

# /audit-with-verification

You are orchestrating a two-stage audit harness. Follow this protocol exactly. The runbook is `docs/superpowers/AUDIT-RUNBOOK.md`; the schema is `docs/superpowers/audit-harness/schemas/finding.schema.json`; the prompts are in `docs/superpowers/audit-harness/templates/`. Read the runbook + schema first if you have not in this conversation.

User invocation: `$ARGUMENTS`

Argument shape: `<target> [n=4] [categories=...] [model=sonnet] [verifier_model=sonnet] [dry_run=true]`

## Step 1 — parse + classify target

Extract `<target>` (positional, required) and named flags. Classify target type:

| Detection | Target type | Verifier template |
|---|---|---|
| Starts with `http://` or `https://` | `url` | `verifier-web-prompt.md` |
| Ends with `.md` and contains `FEATURES`/`features` (case-insensitive) | `feature-spec` | `verifier-code-prompt.md` |
| Path exists and is a file | `code` | `verifier-code-prompt.md` |
| Path exists and is a directory | `dir` | `verifier-code-prompt.md` |
| None of the above | abort with one-line error: "target type unrecognised: <target>" |

Default categories per target type:
- `url` → `a11y,perf,copy,ux,seo`
- `feature-spec` → `drift`
- `code` / `dir` → `security,type-safety,dead-code,drift`

Default `n=4`, `model=sonnet`, `verifier_model=sonnet`.

Compute the run slug: `<YYYY-MM-DD>-<short-target-slug>` (lowercase, ASCII, kebab; e.g., `2026-05-17-example-com-contact`, `2026-05-17-features-md`). Create `docs/superpowers/audits/<run-slug>/` and `docs/superpowers/audits/<run-slug>/reviewers/` and `docs/superpowers/audits/<run-slug>/screenshots/`.

Write `docs/superpowers/audits/<run-slug>/run.json` with the metadata.

## Step 2 — cost flag

Quote the cost in ONE line before dispatch whenever a run fans out to more than 3 parallel subagents or more than 50 work units:

> "Dispatching N=4 Sonnet reviewers on <target>. Est. ~20k tokens, ~$0.20. Stage 2 (~12 verifiers) flagged separately after Stage 1 returns."

If `dry_run=true`: stop here. Print the plan (target type, N, categories, models, run path) and exit without dispatching.

If the user has not pre-approved this run and the projected total exceeds $1, ask one short confirmation question before dispatching. Otherwise proceed.

## Step 3 — dispatch parallel reviewers

Read `docs/superpowers/audit-harness/templates/reviewer-prompt.md`. For each `i` in `1..N`, substitute `{{TARGET}}`, `{{TARGET_TYPE}}`, `{{CATEGORIES}}`, `{{REVIEWER_INDEX}}`, `{{N_REVIEWERS}}`.

Send a **single message with N parallel `Agent` tool calls** (parallelism is critical — N sequential calls multiplies wall time):
- `subagent_type: general-purpose`
- `model: sonnet` (or as overridden)
- `description: "Audit reviewer <i> of <N> on <target>"`
- `prompt`: the substituted template

Collect each reviewer's response. Each MUST be a JSON array per the schema. Write `docs/superpowers/audits/<run-slug>/reviewers/<i>.json` for each.

If a reviewer returns invalid JSON or an empty array, log it in `run.json` under `reviewer_failures` and continue. Do not retry — N>=2 gives redundancy.

## Step 4 — collect, pre-filter, dedupe

Concatenate all reviewer arrays. For each finding:

1. **Validate** against `docs/superpowers/audit-harness/schemas/finding.schema.json`. Invalid → drop with `pre_filter_reason: "schema-invalid: <detail>"`.
2. **Repro_check coherence check.** Drop if any apply:
   - `repro_check.expected` is shorter than 16 chars
   - `repro_check.expected` is a vague verb without a property ("looks broken", "is missing", "should work")
   - `repro_check.input` is empty
   - For `playwright_*` types: `input` doesn't look like a URL
   - For `file_*` types: `input` doesn't look like a path
   Log dropped findings with `pre_filter_reason`.
3. **Dedupe** by `(category, title-normalised, repro_check.input)` triple. Keep the first occurrence; record dropped duplicates with `pre_filter_reason: "duplicate-of: <F-id>"`.
4. **Assign global IDs** `F-001..F-NNN` to the survivors.

Write all (survivors + dropped) to `docs/superpowers/audits/<run-slug>/findings.jsonl`. Each line is one finding; dropped ones carry `pre_filter_reason`.

## Step 5 — cost flag for Stage 2

Count survivors. Quote one line:

> "Stage 1: M raw findings, P pre-filtered, K survivors. Dispatching K verifier agents (~3k tokens each, ~$0.03 each, total ~$<K*0.03>). Wall ~5 min in batches of 4 parallel."

If K=0, skip to Step 7 with empty verdicts.

## Step 6 — dispatch verifiers (batched 4-parallel)

Pick the verifier template based on `repro_check.type`:
- `playwright_*` → `docs/superpowers/audit-harness/templates/verifier-web-prompt.md`
- `file_*` / `command` → `docs/superpowers/audit-harness/templates/verifier-code-prompt.md`

For each finding, substitute `{{FINDING_JSON}}` (the full finding JSON) and `{{RUN_DIR}}` (e.g., `docs/superpowers/audits/<run-slug>`).

Dispatch in batches of 4 parallel `Agent` calls. Web verifiers need Playwright MCP access — use `subagent_type: general-purpose` (which has full tool access including MCP). Code verifiers can use the same. Model: as configured.

For each verifier, expect a single JSON object response. Append to `docs/superpowers/audits/<run-slug>/verdicts.jsonl`. If the verifier returns invalid JSON or errors, record a synthetic verdict `{finding_id: <id>, verdict: "ambiguous", reason: "verifier failed to return parseable verdict: <error>"}`.

## Step 7 — write the report

Read `docs/superpowers/audit-harness/templates/report.md.template`. Substitute all `{{...}}` placeholders:

- Run metadata from `run.json`
- Counts: `N_VERIFIED`, `N_REJECTED`, `N_AMBIGUOUS`, `N_PRE_FILTERED`
- `PRUNE_PCT` = round(100 * (rejected + ambiguous) / (verified + rejected + ambiguous))
- For each tier, expand the `_FINDINGS_TABLE` placeholder into the per-finding markdown described in the template comment blocks (one section per finding)

Write to `docs/superpowers/audits/<run-slug>/report.md`.

## Step 8 — commit + surface

Stage `docs/superpowers/audits/<run-slug>/` and commit:

```
docs(audit): <target> — <N_VERIFIED> verified of <N_TOTAL> raw findings
```

Body: one-line summary per tier (verified count by severity, rejected count, ambiguous count, pre-filtered count, wall time, cost).

Do **not** push automatically — operator decides if the audit run goes to origin. Surface the local commit SHA + the report path. Headline counts: verified by severity + total cost + wall time.

## Rules

- **Read-only on the harness itself.** Do not edit `docs/superpowers/audit-harness/` files mid-run. Tune between runs.
- **Verifier never patches the claim.** If a verifier returns `verified` but its evidence cites a *different* selector than the reviewer's claim, flag as `ambiguous` in the report (the verifier may have laundered reviewer error).
- **No retries on Stage-1 failures.** N>=2 provides redundancy; retrying invites prompt-engineering loops.
- **Cost flag is non-negotiable.** Even when the operator has pre-approved a run, surface the cost line — it's the audit trail.
- **One run per slash invocation.** If the user wants two targets, two invocations.
