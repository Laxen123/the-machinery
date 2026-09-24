#!/usr/bin/env bash
# PreToolUse(Edit|Write|MultiEdit) guard: archived plans are IMMUTABLE.
#
# Blocks edits to docs/superpowers/plans/archive/** so a follow-up can never be
# quietly "recorded in the archived plan" instead of being filed as its own plan.
# An archived plan is a frozen historical record; nobody re-reads archive/, so an
# item parked there is untracked — the exact no-perpetual-deferral failure named in
# 98 Hobby/CLAUDE.md ("'Deferred with rationale' ... leave work untracked").
#
# Scope note: the archival machinery (scripts/move-plan.mjs, scripts/done-worktree*.mjs)
# writes archived plans via node fs + `git mv`, NOT the Edit/Write TOOL, so this guard
# never blocks legitimate archiving — only an interactive Edit/Write into archive/.
# Fails OPEN: any parse error allows the edit (a missed block beats a wedged session).
#
# stdin note (plan 2615 task 4): this hook is INTENTIONALLY best-effort on its read and
# does NOT use lib/loader-common.mjs's retrying readStdin. It takes the payload with
# `cat` — a proper read-to-EOF that does not hit the Windows EAGAIN shape plan 2615
# fixed — and the `node -e` below only re-reads that already-buffered string back out
# of a local pipe. Worst case is one un-blocked archive edit, not a silently-skipped
# context injection.

input="$(cat)"

# Extract the target path via node (jq is not guaranteed on Windows). Covers
# Edit/Write (.file_path); MultiEdit also carries .file_path.
fp="$(printf '%s' "$input" \
  | node -e 'const fs=require("fs");try{const t=(JSON.parse(fs.readFileSync(0,"utf8")).tool_input||{});process.stdout.write(t.file_path||t.path||"")}catch(e){}' 2>/dev/null \
  | tr -d '\r')"

# Normalize Windows backslashes so the match works on absolute, relative, and
# worktree paths alike (.claude/worktrees/<slug>/docs/superpowers/plans/archive/...).
norm="${fp//\\//}"

case "$norm" in
  *docs/superpowers/plans/archive/*)
    cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Archived plans (docs/superpowers/plans/archive/) are immutable historical records — nobody re-reads them, so anything written here is untracked. Do NOT record a follow-up in an archived plan. Per the no-perpetual-deferral rule (98 Hobby/CLAUDE.md), pick one and act this turn: (1) fold a small same-surface item into the active plan, (2) close it explicitly ('not doing this, because…'), or (3) file a NEW plan with `node scripts/next-plan-id.mjs claim …` and a clear trip-condition — 'can't be coded blind yet' is a reason to write the trip-condition, not to skip the plan. A genuine historical correction to an archived file goes through scripts/move-plan.mjs or a Bash/git command, not the Edit tool."}}
JSON
    exit 0
    ;;
esac

exit 0
