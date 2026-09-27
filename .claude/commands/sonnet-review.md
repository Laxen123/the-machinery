---
description: Cheaper-but-trustworthy code review — a verify-hybrid twin of /code-review with ESCALATE-ON-REFUTE verifiers. Runs the same fan-out workflow (scope → finders → per-location verifiers → sweep → synthesis); finders/scope/sweep/synthesis AND the round-1 verifiers are pinned to claude-sonnet-high (the cheap bulk), and only when a verifier REFUTES a candidate does a claude-opus-high adjudicator re-judge that location before it is dropped, REGARDLESS of the session model. ~1.1-1.4x pure-Sonnet cost, far below full Opus-xhigh /code-review. Use for routine / land-gate reviews to cut cost without flipping the session model. Pass "<level> [target]" — level is high (default) / xhigh / max (fan-out breadth only); target is an optional PR#, branch, ref range, path, or free-form instruction.
---

# /sonnet-review

Run a code review whose **finders and round-1 verifiers run claude-sonnet-high**, escalating to a **claude-opus-high adjudicator only on a REFUTE**, regardless of what model this session is on. This is a pinned fork of the built-in `/code-review` workflow — the differences are the two model PINs (`PIN` = Sonnet-high for scope/finders/round-1 verifiers/sweep/synthesis, `ADJUDICATE_PIN` = Opus-high for the refute-adjudicators) AND the two-round `verifyGroups`/`verifyOnce` escalate-on-refute flow, in `.claude/workflows/sonnet-review.js`. Escalate-on-refute (plan 1161, supersedes the plan-1143 full-Opus pin) spends Opus only on the risky decision — dropping a finding a verifier refuted: a Sonnet REFUTE triggers one independent Opus adjudicator, and the finding is dropped only if Opus also refutes. Bake-off `codereview-verifier-model-2026-06-29` found Sonnet verifiers uphold a real bug 33/33 (the full-Opus pin's justification did not reproduce). Your session model is untouched; the review costs ~1.1-1.4x pure-Sonnet, far below full Opus-xhigh.

User invocation: `$ARGUMENTS`

Argument shape: `<level> [target]`
- `level` — `high` (default), `xhigh`, or `max`. Controls fan-out breadth (number of correctness angles, per-angle candidate cap, whether the gap-sweep runs). Finders and round-1 verifiers stay Sonnet-high and only the refute-adjudicators are Opus-high at every level. **`max` is identical to `xhigh` in this fork** — same `LEVEL_PARAMS`, and because effort is pinned to `high` the upstream extended-thinking difference is gone too; it survives only as an accepted alias. Use `high` for routine diffs, `xhigh` for broader coverage.
- `target` — optional: a PR number, branch, ref range, path, or a free-form instruction (e.g. `only review backend/src/foo.ts`, `focus on error handling`). Omit to review the current branch diff.

## What to do

1. Invoke the **Workflow** tool to run `.claude/workflows/sonnet-review.js` with `args` set to the verbatim `$ARGUMENTS` string (e.g. `"high"`, `"xhigh 1042"`, `"high only review .claude/**"`). Prefer `name: "sonnet-review"`; if the runtime cannot resolve the workflow by name (the backing file is `.js`, while the other workflows in this repo are `.mjs`, so name-discovery may not index it), fall back to `scriptPath` with the absolute path to `.claude/workflows/sonnet-review.js` in the current checkout. This command's instruction to call Workflow IS the opt-in — you do not need to ask first.
2. The workflow runs in the background and returns a structured result: `{ level, target, summary, findings[], refuted[], stats }`. Each finding has `file`, `line`, `summary`, `failure_scenario`, `verdict` (CONFIRMED / PLAUSIBLE).
3. Present the result like a `/code-review` report: lead with the one-line summary, then list findings most-severe first with `file:line`, the verdict, and the failure scenario. Note the `stats` line (finders / candidates / verifier agents / `escalated` = how many Opus adjudicator agents ran, i.e. distinct refuted locations / reported) so the cost/coverage is visible. If `findings` is empty, say so plainly.
4. This command does NOT auto-record the land-gate review marker, but it CAN satisfy the gate. The gate (`done-worktree` REVIEW_NEEDED → `record-review.mjs` / `reviewSeam`) is **command-agnostic** — it keys on a recorded `Review: <VERDICT> @ <sha>` marker, not on which command produced the review. So after a clean `/sonnet-review` you may run `node scripts/record-review.mjs PASS` to clear REVIEW_NEEDED; you do NOT also need to run `/code-review`.

5. **Record the verdict, its PROVENANCE, AND persist the findings.** Two land gates apply: findings-as-data (plan 1205) and review provenance (plan 2162). Always declare HOW the review ran — write the workflow's WHOLE return object to a JSON file (e.g. `.scratch/review-result.json`) and pass it as `--review-stats`; that stamps `sonnet-review f=<finders> v=<verifierAgents> adj=<escalated>` into the sha-pinned marker so the land can tell this full fan-out apart from a hand-rolled substitute:
   - **`findings` is empty** → the review was clean: `node scripts/record-review.mjs PASS --review-stats .scratch/review-result.json`. Done.
   - **`findings` is non-empty** → persist them, then disposition each:
     1. Write the workflow's `findings[]` array verbatim to a JSON file, e.g. `.scratch/review-findings.json` (each entry already has `file`, `line`, `summary`, `verdict`; `failure_scenario` is carried along harmlessly). (`.scratch/review-result.json` for `--review-stats` can be the same full return object — record-review reads its `stats` sub-object.)
     2. Record with the findings AND the provenance attached. Pick the verdict by severity: **`BUGS-FOUND`** if any finding is a CONFIRMED correctness bug, else **`NITS`**:
        `node scripts/record-review.mjs <NITS|BUGS-FOUND> --findings .scratch/review-findings.json --review-stats .scratch/review-result.json`
     3. Disposition EVERY finding (the land halts at `FINDINGS_OPEN` until each is one of plan / fixed / wontfix). Use the `key` printed for each finding (or read it from the sidecar `docs/handoff/sessions/<session>.findings.json`).

        **Disposition them in ONE invocation (plan 2595)** — the CLI is N-ary, and one invocation is one coord write. A per-finding loop pays a full lock+freshen+commit+push cycle EACH, which measured as the single largest coord-write class on this repo (20.6% of all coord writes, ~42 lock-min/day). A real round is usually mixed, so `--batch` is the normal form:
        ```bash
        # mixed round — one write. kind ∈ fixed | plan | wontfix | reopen; value = plan id / reason.
        cat > .scratch/dispositions.json <<'EOF'
        [{"key":"a1b2c3","kind":"fixed"},
         {"key":"d4e5f6","kind":"wontfix","value":"sub-floor → infra-debt.md 2026-07-28 <slug>"},
         {"key":"g7h8i9","kind":"plan","value":"1300"}]
        EOF
        node scripts/record-review.mjs disposition --batch .scratch/dispositions.json
        ```
        When every finding gets the SAME disposition, just list the keys:
        - fixed them in this diff → `node scripts/record-review.mjs disposition <key1> <key2> <key3> --fixed`
        - deferring them → **file a plan first** (`node scripts/next-plan-id.mjs claim …` — "pre-existing" is NOT an exemption, and the plan-2531 fix-now test comes first), then `node scripts/record-review.mjs disposition <key…> --plan <id>`
        - consciously not doing them → `node scripts/record-review.mjs disposition <key…> --wontfix "<reason>"` (reason mandatory)

        Dispositions are all-or-nothing: one bad key refuses the whole invocation and applies none of it, so a refusal is always safe to retry with the key fixed. The single-key form still works verbatim.
   - There is no `--resume FINDINGS_OPEN` skip; the only way through is to disposition every finding. The per-finding `--wontfix` is the conscious, reason-stamped override.

   **`/code-review` (built-in) note:** the built-in `/code-review` reports findings to the host UI, not to a file, so it cannot auto-persist them. After a `/code-review` whose findings you will not all fix, build the same `.scratch/review-findings.json` by hand from its findings (one `{file,line,summary,verdict}` per finding) and follow the same step-5 record + disposition flow. Declare its provenance with `--review-method code-review` (add `--finders/--verifiers/--adjudicated` if you have the counts).

   **Subagent-executed plans (plan 2162):** a dispatched subagent has NO Workflow tool, so it CANNOT run this workflow (or the built-in `/code-review`) — it can only hand-roll a single reviewer-agent pass. That is a real, weaker tier, and it MUST be declared honestly so it is not indistinguishable from a full fan-out: `node scripts/record-review.mjs <VERDICT> --review-method substitute [--findings …]`. The land does not block a `substitute` review, but it surfaces the tier in the marker table and land log — a known, named downgrade instead of an invisible one. See your project's `CLAUDE.md` § Review calibration.
