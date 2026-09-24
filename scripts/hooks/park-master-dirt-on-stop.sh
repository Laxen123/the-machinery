#!/usr/bin/env bash
# scripts/hooks/park-master-dirt-on-stop.sh — Stop auto-heal hook (plan 977 Tier 2).
#
# Auto-heal for "loose work on the shared main checkout (master) wedges the
# coord/landing queue". When a MASTER-working session ends with PERSISTED uncommitted
# dirt in the shared main checkout ($MAIN), scripts/pre-yield-guard.mjs --commit-safe
# heals it so the queue can no longer wedge on dirt left by an idle or crashed session:
#   - idle PURE-DOC bookkeeping dirt (plans/specs/handoff/INDEX/wiki) → committed +
#     pushed to master (the clean self-heal a human would do — nothing to recover);
#   - config (.claude/**), app code, or a MIX → parked in a NAMED, recoverable stash
#     (a Stop hook must never auto-push a half-edited settings.json/hook or arbitrary
#     code). Recover with `git stash pop` or scripts/sweep-stray-stashes.mjs; the
#     SessionStart recover-parked-stashes-on-start.sh hook surfaces any waiting stash.
#
# Why a harness Stop hook: pre-yield-guard already heals loose $MAIN work, but it is
# wired ONLY into the `handoff` and `pickup-plan` pause paths — a session that makes a
# worktree-EXEMPT edit (config / hooks / plan-docs are allowed on master) and then
# goes idle or crashes never invokes either skill, so the guard never fires (the
# 2026-06-22 plan-961 wedge). The harness fires Stop hooks unconditionally, so this
# closes that coverage gap at the layer no LLM can bypass.
#
# Scope + safety:
#   - Master sessions only. Worktree sessions edit their own tree, not $MAIN, so they
#     exit early (a worktree session healing the operator's $MAIN dirt would be
#     cross-session and surprising).
#   - Age-gated (90s): the Stop hook fires every turn-end, so we DON'T touch an active
#     in-progress edit or the sub-second coordWrite transient window — only persisted
#     dirt is acted on (pre-yield-guard --age-ms).
#   - Budgeted (50s under a 60s hook timeout, plan 4026): a harness kill landing inside
#     `git stash push` leaves disk rewritten to HEAD and the index at its pre-stash state —
#     the stale MAIN index measured 2026-09-14, which blocks every sibling's ff pull. The
#     guard yields BEFORE the harness kills it, leaving the dirt for the next turn-end.
#   - Never blocks the stop (always exit 0).

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr -d '\r' || true)"
# Only a session working directly on master can dirty $MAIN; skip worktree sessions.
[ "$branch" = "master" ] || exit 0

# --commit-safe: heal idle doc dirt by commit+push, stash config/code. --age-ms 90000:
# leave dirt younger than 90s alone (active edit / live coordWrite window). --budget-ms 50000:
# the Stop hook's own timeout in .claude/settings.json is 60s, so the guard yields with 10s of
# margin rather than being killed mid-stash (plan 4026). Change one, change the other.
out="$(node scripts/pre-yield-guard.mjs --slug stop-hook --commit-safe --age-ms 90000 --budget-ms 50000 2>&1 || true)"

# Surface what the heal did (systemMessage is informational; it never blocks the stop).
# pre-yield-guard prints the recovery command on the stash line and the file list on
# the commit line; grep whichever fired. `park skipped: budget` (plan 4026) is surfaced too —
# a yield leaves the dirt in place, so the operator should see that it happened.
note="$(printf '%s\n' "$out" | grep -E 'parked loose|committed \+ pushed|park skipped: budget' | head -1 || true)"
if [ -n "$note" ]; then
  # Render the systemMessage JSON with node (NOT sed — a `sed 's/\\/\\\\/g'` escape
  # errors with "unknown option to s" on this host's sed, silently emitting an EMPTY
  # message). node escapes a backslash/quote/newline in the note correctly.
  node -e 'process.stdout.write(JSON.stringify({systemMessage:process.argv[1]}))' "$note"
fi
exit 0
