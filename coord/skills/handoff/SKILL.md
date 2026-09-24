---
name: handoff
description: Consolidate the current session's work — code changes, decisions, dead-ends, half-done parts — into the project's rolling handoff.md. End-of-day ritual.
---

# handoff — taking a break

`handoff` means **"I'm taking a break."** It's the pause verb. The session is wrapping up — for the day, for a meal, for a parallel context-switch — and the next agent (or future-you) needs to be able to pick the work back up cleanly.

This skill does NOT close out a worktree for good. If the plan is finished, the branch is mergeable, and the worktree should be torn down — use `done-worktree` instead. The deciding test: **do you intend to keep working in this worktree later?**

- Yes → `handoff` (this skill, pause-and-log)
- No → `done-worktree` (merge, archive, tear down)

## What this skill does

1. Appends a dated section to `handoff.md` summarising what shipped this session, what's live in production (auto-deploy targets), and what remains.
2. If run from inside a worktree, marks that worktree `⏸ PAUSED` in the `## Active worktrees` board in `docs/handoff/board.md` (or `handoff-board.md` on legacy projects), so a fresh `/state` read shows "ready to resume."
3. Commits + pushes the handoff to master.

That's it. No merging, no archiving, no teardown — those are `done-worktree`'s job.

## Pre-reqs

- `git` — must be inside a repo. If not, bail with a message.
- `render` CLI / API key (optional) — used in Step 3 for deploy status. Skip gracefully if missing.

## Steps

### 1. Locate the boundary

Read `handoff.md` from repo root. If missing, create an empty one and treat the boundary as "all commits on the default branch since project inception" (or, pragmatically, the last week).

Otherwise find the most recent dated section header for THIS session's work. The most recent `## YYYY-MM-DD` may be a parallel session's entry — find the one whose `Branch:` matches the worktree you're in, or the one with `Author == current operator` and most recent timestamp. If that entry includes a `since commit: <sha>` footnote, use that SHA as the boundary. Otherwise use the date and `git log --since=<date>`.

### 2. List commits since the boundary

```bash
git log <boundary>..HEAD --pretty='%h %s (%an)' --no-merges
git log <boundary>..HEAD --merges --pretty='%h %s'
```

Group entries by conventional-commit prefix when present (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`). If running inside a worktree, list only commits authored by this session (filter by branch ancestry — `<boundary>..<worktree-branch>` or `<boundary>..HEAD --first-parent`).

If the working tree has uncommitted changes, surface that to the user before continuing — don't auto-include them in "Shipped." Either commit them first or explicitly note them as "not committed" in the entry.

### 3. Check deploy status (project-specific)

If the project has an auto-deploy target (Render, Vercel, etc.) referenced in CLAUDE.md or a runbook:

```bash
# Vetapp pattern — Render API
source ~/.bashrc
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services/<srv-id>/deploys?limit=1"
```

Extract per service: status (live / deploying / failed), commit SHA, finishedAt timestamp.

If the project has no obvious auto-deploy target, skip and note `Deploy status: skipped (no auto-deploy target known)` in the entry.

### 3.5. GATE probe — BEFORE any handoff edits

Step 4 writes a new per-session entry to `docs/handoff/sessions/`, and step 5 updates the board row in `docs/handoff/board.md`. Run the probe against the _clean_ working tree first. At probe time we have made NO edits — any status code other than `??` (untracked) is from another session, staged OR unstaged.

```bash
DIRTY=$(git -C <main-worktree> status --porcelain -- handoff.md docs/handoff/board.md 2>/dev/null | grep -vE '^\?\?' | head -5)
if [ -n "$DIRTY" ]; then
  echo "handoff: GATE probe found modifications on shared paths owned by another session:"
  echo "$DIRTY"
  echo "Another session (probably /pickup-plan or /done-worktree) is mid-flight. STOP — surface to operator before continuing."
  exit 1
fi
```

If the probe trips, **do not edit** — surface the dirty paths, identify which sibling session owns them, wait for that session to commit, then retry.

### 4. Compose the entry

Use the existing project's session-numbering convention if there is one (e.g. session 20, 20b, 20c …).

**Mint a FRESH session number race-safe — never eyeball filesystem-max+1.** If you already created this session's entry at pickup (step 5a), reuse that `<N>` and edit in place. Only when creating a brand-new entry (an ad-hoc session that did NOT pick up via `claim-plan acquire`): if `scripts/claim-plan.mjs` exists (the project, plan 871), get the number from the CAS counter so two parallel sessions can't pick the same `<N>` and clobber each other's file (the recurring 775b/777b collisions):

```bash
node scripts/claim-plan.mjs mint-session      # → {"sessionNum":N}
```

Then write `docs/handoff/sessions/YYYY-MM-DD-session-<N>.md`. If that exact filename already exists (a colliding sibling got there first), do NOT overwrite — bump to `…-<N>b.md`, `…-<N>c.md`, the documented belt-and-suspenders suffix. (No `claim-plan.mjs` → fall back to the project's increment convention, still bumping on a name collision.)

- **If `docs/handoff/sessions/` exists (the project post-plan-205):** write the entry to this session's file `docs/handoff/sessions/YYYY-MM-DD-session-<N>.md` — edit it in place if you already created it at pickup (step 5a), else create it. One file per session, no append-contention.
- **Else (legacy):** append to `handoff.md` using today's date as the header, below the board-pointer line at the top of the file (in the project the `## Active worktrees` board lives in `docs/handoff/board.md` since plan 857; legacy projects keep it inline in `handoff.md`).

Either way this is a coordination path read off master — written via `$MAIN` in step 6 (the pre-commit guard enforces it never lands on a worktree branch).

Capture the host this session is running on for the entry (`hostname`, cross-platform). When pausing a worktree, the host is the PC where the worktree directory lives — copy it from the CLAIM entry rather than re-capturing if you want to make explicit that the worktree is bound to that PC, not the one running `handoff`. (In practice these are the same machine, since you can only pause a worktree you can see — but the convention preserves the cross-PC invariant from `pickup-plan`.)

```markdown
## 2026-05-18 (session N — <plan title or scope>)

**Status:** ⏸ PAUSED — <one line: where we left off, what's blocking, when to resume>
**Plan:** `docs/superpowers/plans/<plan-file>.md` (if applicable)
**Branch:** `worktree-<slug>` — tip `<sha>` (if in a worktree); else "master"
**Host:** `<hostname>` (where the worktree directory lives — same as the CLAIM entry)
**Started / Last touched:** YYYY-MM-DD HH:MM (UTC offset)

**Shipped this session:**

- <commit> <subject>
- <commit> <subject>

**Live (auto-deploy):**

- frontend: <status> @ <commit> at <timestamp>
- api: <status> @ <commit> at <timestamp>

**Resume condition:**
<concrete, verifiable: "operator picks one of A/B/C", "Lighthouse run produces CLS measurement", "session 22 finishes its merge", etc.>

**Carry-forward:**

1. <item — one line + why-it-matters>
2. <item>

**Files touched:** (optional code block)

since commit: `<latest SHA on HEAD>`
```

For `Carry-forward`: pull anything that's not done from this session's work. Surface them as a one-line list. The point isn't to be exhaustive — it's to leave breadcrumbs the next agent can follow.

`Status:` line is the most important field for `/state` and future agents. Be specific. "PAUSED, awaiting operator decision on X" is far more useful than just "PAUSED."

### 5. Update the active-worktree board (only if in a worktree)

If the current Bash cwd is inside `.claude/worktrees/<slug>/` — OR if the most recent session entry's `Branch:` line names a worktree — find the row for this worktree in the `## Active worktrees` section.

The board lives only in `docs/handoff/board.md` (relocated under `docs/handoff/` by plan 857; it was extracted to a dedicated board file at the 2026-05-28 plan-171 cutover — from `handoff.md` on 2026-05-27 — then the `handoff.md` copy was dropped).

If `scripts/board.mjs` exists (the project post-plan-205), it owns the atomic board mutation — one or two calls replace the hand-edit + stage (and step 6 then does NOT stage `docs/handoff/board.md`, since board.mjs already committed+pushed it):

```bash
node scripts/board.mjs set-state <slug> PAUSED
node scripts/board.mjs update <slug> --tip "\`<sha>\`" --touched "YYYY-MM-DD" --resume "<one-liner from the entry's Resume condition>"
```

Fallback (no `board.mjs`) — update the row in `docs/handoff/board.md` (or `handoff-board.md` on legacy projects) by hand and stage it in step 6:

- **State:** `🔄 ACTIVE` → `⏸ PAUSED`
- **Branch tip:** refresh to current SHA
- **Last touched:** today's date
- **Resume condition:** copy the one-liner from the entry's `Resume condition:` field

If `handoff-board.md` doesn't exist yet in this project (legacy / pre-extraction projects), single-write to `handoff.md` only.

If the row doesn't exist (e.g. the worktree was created without `pickup-plan` updating the board), add it now using the same format the rest of the table uses.

The board format (matches what `pickup-plan` and `done-worktree` use):

```markdown
## Active worktrees

| Worktree | Branch tip | State    | Plan / claim                                                   | Last touched | Resume condition |
| -------- | ---------- | -------- | -------------------------------------------------------------- | ------------ | ---------------- |
| <slug>   | `<sha>`    | ⏸ PAUSED | `<plan-file>.md` · session N claim `<sha>` · host=`<hostname>` | YYYY-MM-DD   | <one-liner>      |
```

In `docs/handoff/board.md` the table is delimited by `<!-- BOARD-START -->` / `<!-- BOARD-END -->` sentinels; insert the row INSIDE that window. (`handoff.md` no longer carries the board — only the per-session entry from step 4 goes there.)

Preserve the `host=…` suffix from the original CLAIM row — `handoff` is a state transition (active → paused), not a host change. If the row doesn't have a host suffix (predates the convention), add one using `hostname` now so the next cross-PC `/state` read is unambiguous.

### 6. Commit and push

Handoff updates land on **master**, not on the worktree branch — `/state` readers see master.

If currently inside a worktree, edit/commit/push on the main worktree instead. Resolve it once and edit `$MAIN`'s copies — **the Edit/Write tool writes to whatever path you give it, so editing the worktree's own `handoff.md` silently commits to the wrong branch and `/state` never sees it.** `git -C "$MAIN"` only controls where the _commit_ lands; the absolute `$MAIN/…` edit path is the other half.

```bash
MAIN=$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -1)   # first entry = main checkout
git -C "$MAIN" rev-parse --abbrev-ref HEAD     # MUST print: master — bail if not
# Steps 4-5 must have edited the session entry + board on "$MAIN" (NOT the worktree copies).
# (GATE probe at step 3.5 already verified no parallel-session unstaged work on these paths;
# don't re-probe here — your own step-4/5 edits are now unstaged and would trip the regex.)
# Stage the step-4 entry: post-plan-205 → the per-session file; legacy → handoff.md.
git -C "$MAIN" add docs/handoff/sessions/YYYY-MM-DD-session-<N>.md   # post-plan-205; OR `handoff.md` (legacy)
# board.mjs ABSENT (manual fallback) ONLY — if step 5 used board.mjs it already
# committed+pushed the board row, so do NOT re-stage docs/handoff/board.md here:
# [ -f "$MAIN"/docs/handoff/board.md ] && git -C "$MAIN" add docs/handoff/board.md
git -C "$MAIN" commit -m "handoff: <YYYY-MM-DD>"
git -C "$MAIN" push origin master
```

If `git push` fails (branch protection, auth, no upstream), surface the error and stop — don't force, don't retry destructively. The local commit stays so the user can resolve manually.

## Notes

- This skill never edits production code. It only writes `handoff.md` and runs read-only git / deploy-status commands plus the final commit/push.
- If the repo has no remote, skip Step 6's `git push` and tell the user.
- If the user wants to preview before commit, render the new section to chat, wait for approval, then continue with Step 6.
- The `Status:` line vocabulary is project-convention; common values are `🔄 IN PROGRESS`, `⏸ PAUSED`, `✅ COMPLETED`, `❌ ABANDONED`. `handoff` writes PAUSED by default (since it's "taking a break") — for COMPLETED, use `done-worktree` instead, which does the rest of the close-out (merge, archive, teardown).

## Common mistakes

| Mistake                                                  | Why it bites                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Use `handoff` to close out a worktree for good           | This skill leaves the worktree alive. Future agents reading the active board still see it. Use `done-worktree` instead.                                                                                                                                                                                                                                                                                                                                                           |
| Write the entry on the worktree branch instead of master | `/state` readers on master don't see worktree-branch commits until merge. Always commit handoff updates on master.                                                                                                                                                                                                                                                                                                                                                                |
| Forget to update the active-worktree board               | The board says `🔄 ACTIVE` but the session is gone. Next session has no signal that the worktree is paused.                                                                                                                                                                                                                                                                                                                                                                       |
| Forget the "Resume condition" line                       | Future-you doesn't remember what was blocking. Always one concrete, verifiable line.                                                                                                                                                                                                                                                                                                                                                                                              |
| Bundle uncommitted work into "Shipped"                   | Shipped means committed + pushed. Surface uncommitted state separately.                                                                                                                                                                                                                                                                                                                                                                                                           |
| Drop the `host=…` suffix from the board row when pausing | Cross-PC operators lose the signal that says "this paused worktree lives on machine X." Future `/state` from another machine then can't distinguish "paused elsewhere, resume by going back to X" from "paused locally on this PC."                                                                                                                                                                                                                                               |
| Stage cross-session paths without a pre-stage probe      | Race: a parallel session mid-`/pickup-plan` (or mid-`/done-worktree`) has staged OR unstaged modifications on the same shared paths (`handoff.md` / `docs/handoff/board.md`); broad `git add` in step 6 consumes them under THIS session's handoff commit message. Attribution silently breaks. The probe (`git status --porcelain` → bail on anything except `??` via `grep -vE '^\?\?'`) catches it BEFORE `git add`. Recurring race shape (4+ incidents, see the project plan 173). |
