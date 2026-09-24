---
description: Show every plan in ready/ as a scannable table — lane (sonnet/fable/sol), priority, and whether a cloud drain can take it right now, with the oracle's blocked reasons as footnotes. Read-only; never stamps, claims, or moves anything.
---

# /ready-plans

The twin of `/landing-queue`: that one shows what is **landing**, this one shows what is **takeable**. Renders `docs/superpowers/plans/ready/` as one boxed table instead of the two flat text lists the retired `/cloud-eligibility` printed.

User invocation: `$ARGUMENTS`

## Step 1 — print the board

Run from the repo root (`<home>\Desktop\Claude\Hobby\the project`):

```bash
git fetch origin -q
# The board reads the LOCAL ready/ folder, so a stale checkout shows a stale board — and with
# ~7 parallel sessions the local ref drifts within minutes. Fast-forward only, and only on
# master: from a worktree branch this merge would pull master INTO the branch.
git symbolic-ref -q --short HEAD | grep -qx master && DONE_WORKTREE_AUTHORIZED=1 git merge --ff-only origin/master -q || true
node scripts/ready-board.mjs
```

**The renderer's stdout is invisible to the operator — a tool call result is never shown to them, only your own reply text is.** Copy its output **verbatim into your visible reply** (the table and the footnotes, not a paraphrase of the counts). A prose summary in place of the table is not a valid Step 1 — if your reply text doesn't contain the actual table, you have not completed this step. `/landing-queue` carries this same rule because it was violated three times in a row on 2026-07-26; the operator never actually saw a table.

Output shape:

```
Ready plans: 21 (sonnet 14 · fable 5 · sol 2) — 15 takeable by a cloud drain now.
┌──────┬────────────────────────────────────────┬───────────┬──────┬────────────────┬──────────┬──────────────────────┐
│ Plan │                 Title                  │   Lane    │ Prio │     Cloud      │ Evidence │ Cost                 │
├──────┼────────────────────────────────────────┼───────────┼──────┼────────────────┼──────────┼──────────────────────┤
│ 2486 │ Infra-offline-pytest-gate-must-not-ne… │ 🟢 sonnet │  ⚡  │ ⛔ cloud-false │          │ >$2                  │
│ 2383 │ Pipe-notes-carry-raw-table-cell-pipes… │ 🟢 sonnet │      │ ✅ ELIGIBLE    │          │ Cash $0 · Claude $5  │
│ 3341 │ Infra-sol-executor-lane-execmodel-so… │ 🔶 sol    │      │ ✅ ELIGIBLE    │          │                      │
└──────┴────────────────────────────────────────┴───────────┴──────┴────────────────┴──────────┴──────────────────────┘
⛔ cloud-false — cloudExec: false — not cloud-safe (…); route to a local drain
```

`Cost` is the plan's own 💰 Cost forecast banner: a split banner (plan 3748) renders both axes on one line (`Cash $0 · Claude $5`), a legacy single-figure banner renders as one figure (`>$2` — the `>` means "at least"), and a missing/unparseable banner renders blank rather than a fabricated `$0`.

Rows sort priority → lane (sonnet, fable, sol, in that order) → id. `Lane` is the plan's own `execModel:` stamp, not an inference. `(full)` on a Cloud cell means the plan needs a Full-egress runner and `(browser)` means it needs verified live headless-Chromium egress — every live drain slot is both since plan 3823, so each is provenance, not a block. **A `sol`-lane plan's `Cloud` cell behaves exactly like sonnet's or fable's now (plan 3461, reversing plan 3341's lane refusal)** — `✅ ELIGIBLE` unless the SAME generic reasons that would block any lane apply (`cloudExec: false`, unspecced, blocked-by, operator-gated, claimed). `sol` is lane-agnostic (admitted under both the sonnet and the fable oracle run, since there is no `--lane sol`) and this board reports it under the sonnet row per `ready-board.mjs`'s own tie-break, so it never double-renders. `queue-drain.mjs` still carries the lane's own environment refusal, `sol-env-trusted` (a permanent block on a trusted/limited-egress cloud env — codex exec cannot reach `api.openai.com` there at all), but **this command can never show it**: Step 1 runs only full-egress views (`--env full` and, since plan 3823, `--env browser` as well — this board’s own note 2), and a full-egress env clears that axis. `sol-env-full-unproven` is presently unreachable code everywhere, kept only for a deliberate future re-pin of `SOL_FULL_EGRESS_CLOUD_SUPPORTED`.

Then lead with one line: "N takeable now (sonnet X, fable Y, sol Z); the rest are CLAIMED or blocked for the stated reason." When the operator asks about ONE plan, quote just its row and expand its footnote in plain English.

## Step 2 — reading the verdicts (what each one means you should DO)

| Cell | Meaning | The action |
| --- | --- | --- |
| `✅ ELIGIBLE` | A cloud drain can take it right now | Nothing — it's in the pool |
| `🔒 CLAIMED` | A live session already holds `refs/claims/<id>` | Nothing. Not a block; hands off |
| `⛔ unstamped` | `cloudExec` unset — never adjudicated | Needs a spec-pass / board-pass to stamp it |
| `⛔ cloud-false` | Stamped local-only (rubric #1–#6) | Route it to a local drain, not the cloud |
| `⛔ unspecced` | Still a stub — a stub can't drain | Needs a spec-pass |
| `⛔ blocked-by` | A real upstream plan is still in flight | Wait for the upstream to archive |
| `⛔ operator-gated` | The plan routes a decision to the operator | `/unblock-lane` or a direct ruling |
| `⛔ browser-env` | A lower-rung run said the plan needs live headless-Chromium egress | Nothing. Since plan 3823 the browser view admits it, so this code should never survive onto a printed row — if one does, the board’s browser run is not covering that plan’s lane |

`execModel: sol` (plan 3461) carries no lane-specific cell of its own anymore — a `sol` row hits the same rows above as any other lane. `queue-drain.mjs` still knows `⛔ sol-env-trusted` (a permanent refusal on a trusted/limited-egress cloud env) and the presently-unreachable `⛔ sol-env-full-unproven`, but this command’s invocations are all full-egress (`--env full` and `--env browser`), so neither is ever triggered — see the note under the sample table above.

`CLAIMED` takes precedence over a block: once a session holds the plan, its cloud verdict is moot. Rubric numbering for the `cloud-false` parentheticals: `docs/runbooks/cloud-drain-autonomy.md` § cloudExec stamping rubric.

## Rules

- **Read-only.** This never stamps, claims, moves, or promotes anything. A wrong-looking `cloudExec` or `execModel` is fixed by a spec-pass / board-pass re-adjudication, never from here. To CHANGE which plans are eligible you stamp them, which is a different flow.
- **A `sol`-lane row is drain-claimable now (plan 3461, reversing plan 3341)** — it is takeable exactly like sonnet or fable, and if it never shows `✅ ELIGIBLE` the reason is the SAME generic gate that would block any lane (`cloudExec: false`, unspecced, blocked-by, operator-gated, claimed), fixed the same way — a re-adjudication via spec-pass / board-pass, not a lane-level exclusion.
- **No fabrication.** Every line traces to the renderer output. If `ready-board.mjs` errors, report the error rather than guessing the board — in particular it refuses to print at all when the plan stamps are unreadable, because a stamp-less board would silently file every plan under the SONNET lane (the 2026-07-19 misreport).
- **The list is a live snapshot** of `ready/` as of the fetch; it shifts as drains claim and land.
- **the project only.** Measured 2026-07-26 (plan 2488): a sibling repo's `queue-drain.mjs` has drifted out of sync with its own `build-index-lib.mjs` and dies before any stamp is read.

## Provenance

Supersedes the `/cloud-eligibility` skill (plan 2524), whose whole body was an untestable heredoc that had been hand-patched three times for one class of bug. The four regression pins it carried — two lanes, the full-env view, claims-aren't-in-the-oracle, read-the-whole-frontmatter — now live in `scripts/ready-board.mjs`'s header where `scripts/ready-board.test.mjs` holds them. Retiring the old skill is plan **2525**, blocked on plan 2468's relocation of the coord skill masters.
