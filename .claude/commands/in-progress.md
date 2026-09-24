---
description: Show every plan in docs/superpowers/plans/in-progress/ as one table (Plan / Title / Prio / Where / Activity / Queue) — which plans are being worked right now, where they are claimed (local vs cloud), how alive each session is, and its landing-queue position. Read-only, never mutates. Optional `deep` argument names the real cloud account per session and swaps Activity for the live /cloud-stalls verdict.
---

# /in-progress

Render the in-progress plan roster: **which plans are being worked right now, where, at what priority, how alive, and where they sit in the landing queue.**

Third twin of the two existing boards:

| Command          | Answers                  |
| ---------------- | ------------------------ |
| `/landing-queue` | what is **landing**      |
| `/ready-plans`   | what is **takeable**     |
| `/in-progress`   | what is **being worked** |

User invocation: `$ARGUMENTS`

## Step 1 — print the board

Run the read-only renderer from the repo root. Fetch first: claims live on `origin`, and a stale local ref shows a stale board.

```bash
git fetch origin -q && node scripts/in-progress-board.mjs
```

**The renderer's stdout is invisible to the operator — a tool call result is never shown to them, only your own reply text is.** Copy its output **verbatim into your visible reply**: the whole table, not a paraphrase of row counts or a sentence about which plans look stale. A prose summary in place of the table is not a valid Step 1 — if your reply text does not contain the actual box, you have not completed this step.

It prints:

```
In progress: <N> plans, <M> claimed (<L> local · <C> cloud), <U> unclaimed. <Q> in the landing queue.
┌──────┬────────────────────────────────────────┬────────┬───────┬─────────────┬──────────┐
│ Plan │                 Title                  │  Prio  │ Where │  Activity   │  Queue   │
├──────┼────────────────────────────────────────┼────────┼───────┼─────────────┼──────────┤
│ 2286 │ DQ-gpt-shadow-extraction-adjudicator-… │ high   │ local │ stale 4d 9h │    -     │
│ 2920 │ Pipe-study-2141-row-validator-stdin-w… │ -      │ cloud │ active 1m   │ 1 (head) │
└──────┴────────────────────────────────────────┴────────┴───────┴─────────────┴──────────┘
Account column needs `/in-progress deep`: git alone cannot name which cloud account runs a session.
```

Reading the cells:

- **Prio** — the plan's `priority:` frontmatter stamp (`high` / `medium` / `low`); `-` means unstamped. Sort is priority first (`high > medium > unstamped > low`, since an explicit `low` is a deliberate deprioritization while an absent stamp just means ordinary), then freshest activity. So a `high` plan sitting `stale 13d` lands at the TOP, which is the point.
- **Where** — the `refs/claims/<id>` holder's host, classified against `LOCAL_HOST_DENYLIST`: `local` / `cloud` / `none`. Default-deny, so an unknown host reads `cloud`. `none` means the plan sits in `in-progress/` with **no claim held at all** — usually a dead holder worth a look.
- **Activity** — the newest of (worktree branch tip commit, board `Last touched`, claim timestamp): `active` under 45 min, `idle` under 24 h, `stale` at or beyond 24 h. The 45-minute line is the landing queue's own steal threshold, not a third invented number.
- **Queue** — FIFO position from `landing-queue.mjs status --json`: `1 (head)`, `2`, … `-` for not enqueued, `?` if the queue read failed.

**Cells are ASCII on purpose.** No emoji anywhere in this board: `🖥` (U+1F5A5) is counted as two terminal cells by `box-table.mjs`'s `dispWidth` but drawn as one, which is exactly the misalignment the operator caught in this board's first mock. A width table can be wrong about a glyph; it cannot be wrong about the word `local`.

A degraded input marks its own column `?` and warns on stderr — the table always prints. The one hard failure is an unreadable claim map (exit 5, no table): a board that renders twelve live sessions as `none` reads as "nothing is running" and invites a double-claim.

## Step 2 — deep mode (ONLY if `$ARGUMENTS` contains `deep`)

If `$ARGUMENTS` is empty, stop after Step 1. Otherwise run:

```bash
node scripts/in-progress-board.mjs --deep
```

Same table, two columns upgraded: **Where** becomes the real signed-in account per cloud session, and **Activity** becomes the live session verdict where one can be decided.

**It decides exactly two verdicts, on purpose:** `ACTIVE` (`worker_status: running`) and `BLOCKED-ON-ASK` (`status_bucket: blocked` + `worker_status: requires_action`). The rest of the `/cloud-stalls` vocabulary — `GOAL-DROPPED`, `MID-TOOL-HANG`, `DONE-AWAITING-DECISION` — is decided by the **event tail**, which this board never reads. A `review_ready` bucket is `DONE-AWAITING-DECISION` only when the tail also carries a clean `result`, so asserting it from the bucket alone would be the fabrication `/cloud-stalls`' own "the git sweep is the INDEX, not the verdict" rule forbids. A session whose verdict cannot be decided keeps its fast-mode activity cell, never a blank. **For the full verdict set, run `/cloud-stalls`** — it owns the event reads and the recovery flow.

It drives the CDP automation Chrome, so it takes 1–3 minutes, and it **may open a claude.ai tab** in that automation Chrome for a canonical account that has none (`wake-stalls`' `ensureCanonicalCoverage`) — that is the one thing deep mode does that is not purely a read, and it touches only the automation browser, never repo, queue, or claim state. If the Chrome is down it prints the FAST table plus one loud warning and exits 0 — deep mode never fails to produce a table. A partial sweep (an account with no readable tab, a failed or truncated session read) still prints the table and names the gap on stderr, so a missing account is never mistaken for a healthy one. The verbatim rule applies identically.

## Rules

- **Read-only, in both modes.** This board never runs `release-claim`, `landing-queue dequeue` / `heartbeat` / `steal`, `wake-stalls --send`, or a session rename. (Deep mode's one non-read is opening a claude.ai tab in the automation Chrome, above.) A row that looks dead gets a one-line pointer to **`/cloud-stalls`**, which owns the propose → sign-off → execute recovery flow. Two commands must not own the same mutations.
- **Scope is `in-progress/` only.** Not `waiting-*`, not `ready/`, not `pending-approval/`, and never the board's own state column as a third source (operator ruling, 2026-08-06: *"skip waitinggrill / only ''in-progress''"*). Stale `🔄 ACTIVE` rows on waiting-lane plans are plan **2929**, and cannot leak into this table.
- **The table is unconditional.** It prints even when every row is healthy. Operator: *"I never want just a sentence. I want it as a full table."*
- **No fabrication.** Every line traces to renderer output. If the renderer errors, report the error rather than guessing the board.
- **Live snapshot.** Rows shift as sessions claim and land; the counts are true as of the fetch in Step 1.
- **Verbatim means verbatim.** A real incident (2026-07-26) put this same rule in `/landing-queue` and `/ready-plans`: three consecutive invocations ran the renderer correctly but replied with only a prose summary, so the operator never actually saw a table. Reproducing the box in your own reply text is the deliverable of Step 1, not an optional nicety.
