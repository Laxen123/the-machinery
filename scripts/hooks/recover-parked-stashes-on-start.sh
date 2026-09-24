#!/usr/bin/env bash
# scripts/hooks/recover-parked-stashes-on-start.sh — SessionStart hook (plan 977
# Tier 2 point 4). If the Stop auto-park hook stashed idle config/code dirt
# (wip-stop-hook-* stashes), surface a recovery notice at session start so the work
# is never silently lost. Read-only: lists stashes, never pops/drops, never blocks.
#
# Stashes live in the shared common .git, so they are visible from any worktree; the
# recovery itself must run from the MAIN checkout (that is where the dirt belonged).
set -eu

# %gd = stash ref (stash@{N}), %gs = subject. Match only our Stop-hook auto-parks.
stashes="$(git stash list --format='%gd %gs' 2>/dev/null | grep -E 'wip-stop-hook-' || true)"
[ -n "$stashes" ] || exit 0

count="$(printf '%s\n' "$stashes" | grep -c . || true)"
entries="$(printf '%s' "$stashes" | tr '\n' ';')"
msg="VetNära auto-park: ${count} parked stash(es) from the Stop auto-heal hook await recovery (idle config/code dirt on master was stashed so it could not wedge the queue). Recover from the MAIN checkout: \`git stash pop\` (newest) or \`node scripts/sweep-stray-stashes.mjs\` to review/drop subsumed ones. Entries: ${entries}"

# SessionStart surfaces context via hookSpecificOutput.additionalContext. Render the
# JSON with node so a stash subject containing a quote/backslash can't break it.
node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:process.argv[1]}}))' "$msg"
exit 0
