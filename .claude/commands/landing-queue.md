---
description: Show the plan-504 landing queue as a quick human-readable FIFO table (# / Plan / Lane / Enqueued / Origin, head row marked). Read-only — never mutates the queue. Optional `check` / `live` argument also probes whether the head slot is a live land or a stale head that may be steal-eligible (board row, plan folder, branch-merged, last-commit age).
---

# /landing-queue

Render the cross-session landing queue (the plan-504 FIFO ordering layer for `done-worktree` lands) as a scannable table, instead of the raw one-line-per-entry `status` output.

User invocation: `$ARGUMENTS`

## Step 1 — print the board

Run the read-only renderer from the repo root:

```bash
node scripts/landing-queue-board.mjs
```

**The renderer's stdout is invisible to the operator — a tool call result is never shown to them, only your own reply text is.** Copy its output **verbatim into your visible reply** (the table itself, not a paraphrase of row counts or the head slug). A prose summary in place of the table is not a valid Step 1 — if your reply text doesn't contain the actual table, you have not completed this step.

It shells the canonical `node scripts/landing-queue.mjs status --json` (which does the authoritative fresh read of the queue ref `refs/heads/coord/landing-queue` — plan 3973; the doc is no longer on master — + landed-orphan prune) and prints:

```
Landing queue: <N> waiting, FIFO order.
┌──────────┬─────────────────────────────┬─────────┬──────────┬──────────┐
│    #     │ Plan                        │ Lane    │ Enqueued │ Origin   │
├──────────┼─────────────────────────────┼─────────┼──────────┼──────────┤
│ 1 (head) │ <slug>                      │ 🟩 free │ HH:MM    │ local    │
│ 2        │ <slug>                      │ 🟥 seed │ HH:MM    │ cloud    │
└──────────┴─────────────────────────────┴─────────┴──────────┴──────────┘
```

Enqueued times are HH:MM UTC (sliced from the stored ISO timestamps). Lane is the plan's seed-write banner: 🟩 free (merges freely) / 🟥 seed (serializes the merge). Origin is derived from the entry's `host` field (already returned by `status --json`, no extra lookup): a host on the canonical local-machine list (`LOCAL_HOST_DENYLIST` in `scripts/cloud-checkout-preflight.mjs`) renders `local`, anything else renders `cloud` (default-deny, same posture as that script). Origin is plain ASCII since plan 2932 — it used to render `🖥 local`, whose U+1F5A5 is counted as two terminal cells but drawn as one, so every local row overflowed the box by a column; all three boards now share the one `local` / `cloud` / `none` vocabulary. It does NOT identify *which* cloud account — the queue has no per-entry account data today. If the queue is empty it prints `Landing queue: empty` — print that and stop.

This step is **read-only**. The renderer only spawns `status --json`; it performs no `coordWrite` and no queue mutation.

## Step 2 — head-liveness probe (ONLY if `$ARGUMENTS` contains `check` or `live`)

If `$ARGUMENTS` is empty, stop after Step 1. Otherwise, the head slot holds the land mutex until it dequeues — a head whose session has died blocks everyone behind it. Probe whether the head (`# 1`) is a **live land** or a **stale head**:

1. **Heartbeat age** — `node scripts/landing-queue.mjs status <head-slug> --json` already showed it's head; the raw `status` line shows its `heartbeat=` ISO. A heartbeat equal to its enqueue time (never bumped) is a soft staleness signal. **Do NOT run `heartbeat` yourself** — that resets the staleness clock and masks a dead head.
2. **Board row** — search `handoff-board.md` for the head slug. `🟢 LANDING` = actively mid-merge (healthy). `🔄 ACTIVE` / `⏸ PAUSED` while at the head of the queue is suspicious (enqueued to land but not landing).
3. **Plan folder** — `docs/superpowers/plans/in-progress/<slug>.md` present (not yet landed) vs `archive/<slug>.md` (already landed → orphan queue entry the next queue op self-heals).
4. **Branch merged** — `git merge-base --is-ancestor worktree-<slug> origin/master` (exit 0 = merged).
5. **Commit recency** — `git show -s --format="%cr" worktree-<slug>` (last commit age) and the head of the branch.

Report a one-line verdict: **live land** (board `🟢 LANDING` and/or recent commits — leave it alone) vs **stale head** (no LANDING row, no recent commits, heartbeat never bumped — a waiter may `steal` the slot once the holder is confirmed gone, per `landing-queue.mjs steal --confirm-holder-gone`). Do not steal automatically — surface the verdict and let the operator decide.

## Sleeping until your turn (a waiting land session)

This command is the human *viewer*. A **session** waiting for its own land slot (it enqueued, isn't head, and the spine seamed `QUEUE_WAIT`) should not poll in-context — launch `node scripts/landing-queue-watch.mjs <slug>` via Bash `run_in_background: true` and end the turn. The watcher polls `status` in a detached process at zero token cost and exits at head (exit 0; 3 GONE / 4 TIMEOUT), re-invoking the session to re-run `done-worktree <slug>`. Pattern + the `ScheduleWakeup` dead-man fallback: `docs/runbooks/plans-workflow.md` "Self-manage mechanical waits" (plan 968).

**The flagless command above IS the keep-hot one (plan 2551).** The watcher rebases your branch onto each new `origin/master` and re-validates the gates during the wait, so you reach head HOT and fast-path past the rebase + gate battery inside the head slot. Do not add `--keep-hot` (accepted, but a no-op), and never put `--pure-poll` in a wait recipe — that opt-out exists for read-only observation of a queue you must not mutate, and a land that waits cold arrives at head needing the full battery, blows the plan-1528 8-min head cap, and is requeued to the tail.

## Rules

- **Read-only by default.** Step 1 never mutates. Step 2 only reads (board, plan folder, git) — never `heartbeat`, `dequeue`, or `steal` the queue without an explicit operator go-ahead.
- **No fabrication.** Every line traces to the renderer output or a real probe; if `landing-queue-board.mjs` errors, report the error rather than guessing the queue.
- **Verbatim means verbatim.** A real incident (2026-07-26): three consecutive invocations ran the renderer correctly but replied with only a prose summary ("N waiting, head is X") — the operator never actually saw a table because tool output isn't visible to them. Reproducing the table in your own reply text is the deliverable of Step 1, not an optional nicety.
