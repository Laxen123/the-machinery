---
description: Release this session's landing-queue slot IMMEDIATELY (`node scripts/landing-queue.mjs dequeue <slug>`) — the mutating twin of the read-only /landing-queue viewer. Use when told to "leave the queue" / "release your slot" / "get out of the landing queue", or when reworking while enqueued (runbook rule - release on reopen — dequeue, not requeue). Idempotent, always exit 0, never loses work — only queue position.
---

# /leave-queue

Release this session's slot in the plan-504 FIFO landing queue, right now, with no runbook search. One command, then stop:

```bash
node scripts/landing-queue.mjs dequeue <slug>
```

User invocation: `$ARGUMENTS`

## Step 1 — resolve the slug

- If `$ARGUMENTS` names a slug, use it verbatim (batch slugs like `batch-2026-07-10-coord-spine5` are valid queue entries too).
- Otherwise derive it from the session's own worktree branch: `git branch --show-current` → strip the `worktree-` prefix. A batch-train session's branch is `worktree-<batch-slug>`; the batch slug is the queue key.
- No argument and not on a `worktree-*` branch → print the current queue (`node scripts/landing-queue-board.mjs`) and ask which entry to release. Never guess.

## Step 2 — one safety check, then dequeue

**Do NOT dequeue a land that is actively mid-merge.** If a `done-worktree` spine invocation for this slug is running right now, or the board shows this slug (or, for a batch, a member row) as `🟢 LANDING`, stop and report — the spine owns the slot and dequeues it itself. A `LAND_BLOCKED_HOLDING` 🟥 seam also keeps its slot on purpose (hold-through-conflict); releasing it needs an explicit operator go-ahead.

Otherwise run it from any checkout (worktree included — the tool routes through the coord checkout):

```bash
node scripts/landing-queue.mjs dequeue <slug>
```

It is idempotent and always exits 0; an already-absent entry is a no-op, never an error.

## Step 3 — confirm and state the re-entry path

Print the resulting queue (`node scripts/landing-queue-board.mjs`) so the release is visible, then one line: the slot is gone, the work is untouched, and re-entry is by re-running `node scripts/done-worktree.mjs <slug>` when ACTUALLY ready (it re-enqueues at the back — a queue slot means "reviewed + done, merge NOW", per `docs/runbooks/plans-workflow.md` § Queue slot = readiness).

## Rules

- This command mutates ONLY the queue entry — never the board row, claim ref, plan file, or branch.
- Dequeue is the correct release. `requeue` is not (it keeps a tail slot to drain back on — the plan-1674 hog); `steal`/`demote` are for waiters acting on someone ELSE's stale head, not for leaving yourself.
