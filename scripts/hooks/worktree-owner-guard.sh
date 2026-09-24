#!/usr/bin/env bash
# PreToolUse Edit|Write|MultiEdit hook: BLOCK a write into a plan worktree owned
# by a DIFFERENT session. Plan 958.
#
# Root cause (2026-06-22 953/924 collision): a second top-level session entered an
# already-claimed worktree and wrote stray edits, because every prior guard (the
# ref-CAS `acquire`, the dirty-tree check, the 6h-stale heuristic) is ADVISORY —
# honored only if the LLM runs and reads it. This hook makes a cross-owner write
# impossible at the harness layer.
#
# Identity (verified against the Claude Code hooks docs): the PreToolUse payload
# carries a stable per-session `session_id` (distinct between two concurrent
# sessions). A SUBAGENT call carries its OWN `session_id` PLUS an `agent_id`. There
# is NO session-id env var, so cut-worktree.mjs (run via Bash) cannot stamp the
# owner — ownership is bound TRUST-ON-FIRST-WRITE: the first top-level write into a
# worktree whose `.owner` has no `sessionUuid` claims it; later writes by a
# different `session_id` are denied.
#
# Exemptions:
#   - SUBAGENT calls (payload has `agent_id`): a subagent is spawned by a session
#     already working the repo and has a different session_id from its parent, so
#     gating it would false-block the owner's own subagents. The real threat (a
#     foreign TOP-LEVEL session) carries no agent_id and IS gated.
#   - `agent-*` worktrees (subagent isolation:"worktree" checkouts): owned by the
#     dispatching session's subagents; never gated.
#   - Writes OUTSIDE any `.claude/worktrees/<slug>/` (the master checkout): allowed.
#
# Scope: Edit/Write/MultiEdit only (Bash-driven writes are out of scope — path-
# gating arbitrary shell is unreliable; the source edits that matter go through
# these tools). Like worktree-guard.sh, "deny" is the permissionDecision JSON on
# stdout (always exit 0); "allow" is empty stdout. No `jq` (undeclared external
# that fails OPEN when absent — plan 683); the payload + `.owner` are parsed with
# node, which is guaranteed present in this repo.
set -eu

raw=$(cat)

# Parse session_id / agent_id / tool_input.file_path with node (never jq). node catches
# JSON errors internally and always exits 0, so `set -e` is safe. session_id and agent_id
# are opaque identifiers, never multi-line, so we STRIP any CR/LF from them: a newline
# injected into one cannot shift the line split and spoof another field (a crafted
# session_id with a "\n" must not let an attacker fake a non-empty agent_id and dodge the
# guard). file_path is emitted LAST and read as "the rest of the output", so a path that
# legitimately contains a newline is preserved rather than truncated.
parsed=$(printf '%s' "$raw" | node -e '
let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{
  let j={};try{j=JSON.parse(s)}catch{}
  const id=(v)=>String(v==null?"":v).replace(/[\r\n]/g,"");
  const sid=id(j&&j.session_id);
  const aid=id(j&&j.agent_id);
  const fp=String((j&&j.tool_input&&j.tool_input.file_path)||"").replace(/\r/g,"");
  process.stdout.write(sid+"\n"+aid+"\n"+fp);
})')
SESSION=$(printf '%s\n' "$parsed" | sed -n '1p')
AGENT=$(printf '%s\n' "$parsed" | sed -n '2p')
FILE=$(printf '%s\n' "$parsed" | tail -n +3)

# No file path (malformed payload, or a non-file tool) → nothing to gate.
[ -n "$FILE" ] || exit 0

# Unknown writer (payload carried no session_id) → do NOT gate AND do NOT bind. Binding an
# EMPTY owner would brick the worktree (every real, non-empty session would then mismatch
# and be denied). Fail-open is safe here: a real harness call always carries session_id,
# and an identity-less call is not the cross-session collision this guards against.
[ -n "$SESSION" ] || exit 0

# A subagent call (has agent_id) is exempt (see the Exemptions note above).
[ -z "$AGENT" ] || exit 0

# Normalize Windows backslashes so the path match works regardless of slash form.
norm=$(printf '%s' "$FILE" | tr '\\' '/')

# Only gate writes that land inside some `.claude/worktrees/<slug>/<...>`. Pattern-
# matching the path directly means we depend on neither CLAUDE_PROJECT_DIR nor git.
case "$norm" in
  */.claude/worktrees/*/*) : ;;
  *) exit 0 ;;
esac
before="${norm%%/.claude/worktrees/*}"
after="${norm#*/.claude/worktrees/}"
slug="${after%%/*}"
wtdir="${before}/.claude/worktrees/${slug}"

# `agent-*` isolation worktrees are exempt.
case "$slug" in
  agent-*) exit 0 ;;
esac

owner_file="${wtdir}/.owner"

# Read the bound owner. "__MISSING__" = no .owner file (or unparseable); "" = a
# creator-only stamp with sessionUuid null/absent (not yet bound).
bound=$(node -e '
const fs=require("fs");
try{const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(o.sessionUuid==null?"":String(o.sessionUuid))}
catch{process.stdout.write("__MISSING__")}
' "$owner_file" | tr -d '\r')

# Trust-on-first-write: an unbound worktree is claimed by this writer. Known narrow
# limitation: two sessions racing to be the FIRST writer of the same fresh worktree can
# both read "unbound" and both be allowed before either binds (last write wins .owner).
# The threat model is COOPERATING parallel sessions (accidental double-pickup), not an
# adversary, and the owning session creates + first-writes the worktree before any sibling
# even knows it exists, so the window is effectively closed in practice; file-locking is
# not worth its cost here.
if [ "$bound" = "__MISSING__" ] || [ -z "$bound" ]; then
  node -e '
const fs=require("fs");const f=process.argv[1],sid=process.argv[2];
let o={};try{o=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
o.sessionUuid=sid;
fs.writeFileSync(f,JSON.stringify(o));
' "$owner_file" "$SESSION" || true
  exit 0
fi

# The owner writing into its own worktree.
[ "$bound" = "$SESSION" ] && exit 0

# A foreign top-level session: DENY. The reason is rendered through node's JSON.stringify
# (NOT a raw printf interpolation) so a slug or session id that ever contained a quote,
# backslash, or newline cannot break the JSON or inject, the way a printf-built string
# could (a malformed deny payload would fail-open: the harness ignores it and the write
# proceeds).
short_owner=$(printf '%s' "$bound" | cut -c1-8)
short_self=$(printf '%s' "$SESSION" | cut -c1-8)
reason="worktree-owner-guard: '${slug}' is owned by a DIFFERENT live session (owner=${short_owner}, you=${short_self}). A parallel session holds this plan worktree, so do NOT write into it. Go read-only and surface to the operator, or cut your own worktree. Ownership is bound trust-on-first-write via .claude/worktrees/${slug}/.owner (plan 958)."
node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:process.argv[1]}}))' "$reason"
exit 0
