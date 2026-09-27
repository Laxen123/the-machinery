#!/usr/bin/env sh
# scripts/hooks/pre-push-core.sh — the GENERIC half of the pre-push gate battery (plan 3963).
#
# Split out of the single 5,000-line scripts/hooks/pre-push.sh so a checkout of the
# generic coordination core (no vetapp product code) ships this file alone and still
# runs every coordination-level gate — typecheck, prettier, the scripts/*.mjs battery,
# the plan/board/wiki/coord-sharing lints, the diff-scoping and tiering machinery — with
# NO vetapp-product-specific gate (seed/price/pytest/mobile/…) in the mix.
#
# Sourced by scripts/hooks/pre-push.sh, which sources scripts/hooks/pre-push-project.sh
# FIRST (when present) so every `pp_project_*` function a "project hook seam" below might
# call is already defined by the time this file's own top-to-bottom execution reaches that
# seam — sourcing a file only DEFINES its functions, it does not run this file's battery,
# so the order costs nothing and a project-file-absent checkout finds no such function and
# no-ops there (see each seam's own comment). This file is unchanged in its own gate
# bodies and their exact battery ORDER from the pre-split scripts/hooks/pre-push.sh — the
# split is a pure move, not a rewrite (plan 3963 T1).
#
# scripts/hooks/pre-push.sh remains the SOURCED entry point (never exec'd) that
# .husky/pre-push dispatches to; that dispatcher is unchanged by this split beyond
# sourcing this file instead of containing the battery directly.

# Project hook seam registration + validation (review findings fb9352/6aa9d3, plan 3963).
#
# PP_PROJECT_SEAMS is the canonical, ORDERED list of every `pp_project_<name>` function a
# vetapp-shipping checkout's pre-push-project.sh must define — one entry per "project hook
# seam" call site below, in the exact order this file reaches them. A space-delimited POSIX
# string, deliberately never a bash array: this hook runs under real `dash` (see .husky/
# pre-push's own header), which has no arrays.
PP_PROJECT_SEAMS='sweep_checkpoint_passthrough cloud_routine_prompt_lint seam_and_brand_guards pipeline_field_guards pipeline_doc_lint market_dossier_lint pricing_and_seed_gates coord_sharing_drift mobile_gate'

# Validated ONCE, here, before the first seam call site below — never lazily at each seam —
# so a rename/drop is caught on EVERY push that carries a project file, not only a push whose
# diff happens to reach that one gate. Two failure modes this closes together:
#   F1 (fb9352): the OLD seam shape (`if command -v pp_project_<name> …; then …; fi`) resolves
#     a PATH EXECUTABLE just as readily as a shell function — an unrelated binary named like a
#     seam on a core-only checkout's PATH would be found and RUN, silently losing the
#     documented core-only no-op. pp_run_project_seam (below) never calls `command -v` at all
#     when PP_PROJECT_PRESENT is not 1, so PATH is not even consulted in that case.
#   F2 (6aa9d3): the OLD shape FAILS OPEN — a present-but-broken project file (a renamed or
#     dropped function) makes `command -v` false, and the gate silently no-ops with no error.
#     This block turns that into a loud, immediate, named failure instead.
# `[ "$(command -v "$_fn")" = "$_fn" ]` is the POSIX-portable way to tell "a shell function
# named $_fn" apart from "a PATH executable named $_fn": `command -v` prints the bare name for
# a function/builtin/alias but the resolved PATH for an executable — never `type`-output string
# matching, which is worded differently across dash and bash.
if [ "$PP_PROJECT_PRESENT" = 1 ]; then
  _pp_missing_seams=""
  for _pp_seam in $PP_PROJECT_SEAMS; do
    _pp_fn="pp_project_$_pp_seam"
    _pp_resolved=$(command -v "$_pp_fn" 2>/dev/null || true)
    if [ "$_pp_resolved" != "$_pp_fn" ]; then
      _pp_missing_seams="$_pp_missing_seams $_pp_seam"
    fi
  done
  if [ -n "$_pp_missing_seams" ]; then
    echo "pre-push: scripts/hooks/pre-push-project.sh is present but does not define the expected shell function(s) for seam(s):$_pp_missing_seams" >&2
    echo "pre-push: expected a function named pp_project_<seam> for each name above (see PP_PROJECT_SEAMS in scripts/hooks/pre-push-core.sh) — a rename or drop there silently disables that gate, so this is a hard error, not a skip. Fix the function name (or restore it) before pushing." >&2
    exit 1
  fi
fi

# pp_run_project_seam <short_name> — the ONE call shape every project hook seam below uses.
# Gates on PP_PROJECT_PRESENT (a plain flag set by pre-push.sh, never `command -v`) so a
# core-only checkout's no-op costs nothing and consults PATH not at all (F1, above). When the
# project file IS present, the validation block above has already proven every name in
# PP_PROJECT_SEAMS resolves to a real shell function, so this calls it directly — no per-call
# `command -v` re-check, and no risk of the PATH-executable confusion that check existed to
# avoid.
pp_run_project_seam() {
  if [ "$PP_PROJECT_PRESENT" != 1 ]; then
    return 0
  fi
  "pp_project_$1"
}

# Block the push if docs/INDEX.md and docs/superpowers/plans/ have drifted —
# catches forgotten INDEX updates after `git mv` to/from archive/in-progress/
# waiting-*/, per the parent CLAUDE.md "Plan archive discipline" rules.

# ── Capture pushed-ref stdin ONCE (plan 1287) ───────────────────────────────
# git feeds `<local-ref> <local-sha> <remote-ref> <remote-sha>` lines (one per
# pushed ref) on stdin — a pipe, readable only once. Both the coordination-ref
# pass-through below AND the pushed-delta diff-scoping further down need the
# same lines, so capture them to a temp file up front and have every later
# reader consume the file instead of raw stdin. Cleaned up on any exit path
# (errexit, an early `exit 0` pass-through, or normal fall-through).
PUSH_REFS_FILE=$(mktemp)
trap 'rm -f "$PUSH_REFS_FILE"' EXIT
cat > "$PUSH_REFS_FILE"

# ── Coordination-ref pass-through (plan 368) ────────────────────────────────
# Atomic ref-CAS claim/counter pushes (refs/claims/*, refs/coord/*) carry NO branch
# diff — every gate below (INDEX/board/cost/typecheck/mobile) is irrelevant to them.
# If EVERY pushed ref is a coordination ref, exit 0. (claim-plan/release-claim push
# with HUSKY=0 and skip the hook entirely; this is belt-and-suspenders for a manual
# `git push origin <sha>:refs/claims/<id>`.) stdin: `<lref> <lsha> <rref> <rsha>`.
# Errexit-safe (verified): empty stdin (a manual `sh .husky/pre-push` test) leaves
# saw_ref=0 -> falls through to the full hook, never a trivial pass.
# NOTE: the namespace list below is duplicated in scripts/coord/coord-refs.mjs's
# isCoordRef() (plan 1287, moved there by plan 3756) — a shell case pattern and a
# JS module can't share one literal. Adding/renaming a coordination-ref namespace
# must update BOTH or the two layers silently disagree on what counts as a
# coord-only push. coord-refs.mjs is the JS-side owner; compute-push-diff.mjs now
# imports the predicate from it rather than keeping a third copy.
coord_only=1
all_delete=1
saw_ref=0
while read -r _lref lsha rref _rsha; do
  if [ -n "$rref" ]; then
    saw_ref=1
    case "$rref" in
      # NOTE: refs/heads/backup/* archival pushes are deliberately NOT matched here — that's
      # BY DESIGN (plan 2071), handled per-caller via HUSKY=0 (see branch-hygiene.md), not a gap.
      # plan 3756: refs/heads/coord/* is the LIVE claim/counter namespace. It is a
      # BRANCH ref, so without this arm every claim acquire would run the full gate
      # battery — minutes per claim, and any gate failure would make claiming
      # impossible. The two legacy namespaces stay listed for the dual-read window.
      refs/claims/*|refs/coord/*|refs/heads/coord/*) : ;;
      *) coord_only=0 ;;
    esac
    # A deletion pushes the zero-sha as the LOCAL sha ("(delete) <zeros> <rref> <rsha>").
    # A zero-sha is all '0' of any length (40 for SHA-1, 64 for SHA-256); any non-'0'
    # char — or an empty field — means a real (non-delete) push of this ref.
    case "$lsha" in
      '' | *[!0]*) all_delete=0 ;;
    esac
  fi
done < "$PUSH_REFS_FILE"
if [ "$saw_ref" = 1 ] && [ "$coord_only" = 1 ]; then
  exit 0
fi
# Branch-delete pass-through (plan 1095): deleting a ref carries NO content diff, so
# every gate below (INDEX/board/cost/typecheck/tests/mobile/prettier) is irrelevant to
# it — and running the full gate on a `git push --delete` of a landed/abandoned worktree
# branch just hangs the delete. If EVERY pushed ref is a deletion, exit 0.
if [ "$saw_ref" = 1 ] && [ "$all_delete" = 1 ]; then
  exit 0
fi

# Drain-status pass-through (plan 3619) — the one CONTENT-based exemption in this hook.
#
# The two pass-throughs above key on ref NAMES; this one cannot, because the drain status channel
# has to be pushable by an unclaimed no-PAT cloud drain, which can push nothing but ordinary
# `refs/heads/*` branches. So the question asked here is what the push actually CHANGES: it is
# exempt only when its entire pushed delta is `.drain-status/<slug>.json` files and nothing else.
# One line of real code in the same push fails that test and runs the full battery — pinned by
# tests at both the unit layer (compute-push-diff.test.mjs) and here (pre-push-hook.test.mjs).
#
# Why the exemption has to exist at all: a cloud drain's only channel for its own state is a
# successful push to origin, and that channel sits behind THIS gate. When the gate rejects, the
# drain becomes byte-identical to one that never started — the ready-board reads its stake marker
# as "hands off", deadSeedVerdict counts toward freeing the plan for a second drain to redo the
# work, and wake-stalls cannot see it (the 2026-09-01 plan-3595 stall: 4 finished commits held
# ~3.5h, invisible to everything). A status push that cannot get out while the gate is red would
# be no channel at all. See scripts/drain-status.mjs for the channel and its shape.
#
# Placed HERE, beside the other pass-throughs and before the unconditional lints and the
# range-scoped seam guards, so the exemption is genuinely free: a heartbeat mid-gate must not
# itself cost a gate run. Fail-CLOSED — a non-zero exit (including any git failure inside the
# range computation) simply falls through to the full battery.
# The namespace check is a cheap PREFILTER, not the exemption. It is here so an ordinary push does
# not pay a node spawn plus a git diff on every single push across ~5-7 parallel sessions just to be
# told "no" — the overwhelming majority of pushes touch no `claude/status/*` ref at all and exit
# this block after one shell string comparison. It also narrows the exemption: a stray
# `.drain-status/*.json` riding a WORK branch now runs the full battery, which is the safer default.
# It is emphatically NOT the thing being trusted — anyone can name a branch `claude/status/x`, so
# the exemption itself remains the CONTENT check below, and both must pass.
status_ns_only=1
while read -r _lref _lsha rref _rsha; do
  if [ -n "$rref" ]; then
    case "$rref" in
      refs/heads/claude/status/*) : ;;
      *) status_ns_only=0 ;;
    esac
  fi
done < "$PUSH_REFS_FILE"
if [ "$saw_ref" = 1 ] && [ "$status_ns_only" = 1 ]; then
  if node scripts/compute-push-diff.mjs --drain-status-only < "$PUSH_REFS_FILE" >/dev/null 2>&1; then
    echo "pre-push: drain-status-only push (plan 3619) — gate battery skipped by CONTENT."
    exit 0
  fi
  echo "pre-push: a claude/status/* push whose diff is NOT drain-status-only — running the full gate."
fi

# ---- project hook seam: sweep-checkpoint pass-through, plan 3682 ----
# pp_project_sweep_checkpoint_passthrough is defined by scripts/hooks/pre-push-project.sh when that file
# exists (sourced earlier by the scripts/hooks/pre-push.sh dispatcher, which also sets
# PP_PROJECT_PRESENT); a checkout with no project file has PP_PROJECT_PRESENT=0, so
# pp_run_project_seam no-ops WITHOUT consulting PATH at all — the "core gates alone"
# contract (plan 3963), immune to an unrelated PATH executable of this name (finding
# fb9352). A present-but-broken project file (a renamed/dropped function) was already
# caught LOUDLY, once, up top — see the PP_PROJECT_SEAMS validation block (finding
# 6aa9d3) — so by the time this line runs, PP_PROJECT_PRESENT=1 means the function is
# guaranteed to exist.
pp_run_project_seam sweep_checkpoint_passthrough

# ── Push telemetry (plan 1731; instrumentation-only, ZERO gate-behavior change) ─────
# One line per gate-running push (i.e. a push that reaches here — past BOTH pass-
# throughs above) into a NEVER-COMMITTED log shared by every worktree + the main
# checkout: $(git rev-parse --git-common-dir)/push-telemetry.log lives inside .git/,
# so it is uncommittable by construction (no .gitignore entry needed) and survives
# worktree teardown. Records whether lint-plan-index.mjs / lint-board.mjs each
# detected drift and entered their drift-attribution path this push (a "hit" — the
# point where computeDriftIsInherited is consulted, regardless of whether that drift
# then resolved inherited or strict). Both gates mark their own hit via
# scripts/coord/push-telemetry-lib.mjs's markPushTelemetryHit(), gated on the
# COORD_PUSH_TELEMETRY_HITS_FILE env var this block exports — unset (a direct
# `node scripts/lint-*.mjs`, or any test) is a complete no-op, so importing/calling it
# changes NOTHING about either gate's existing pass/fail behavior (same convention as
# COORD_DRIFT_BRANCH/COORD_DRIFT_BASE, plan 1669). The two pass-throughs ABOVE this
# point keep the ORIGINAL trap (only PUSH_REFS_FILE cleanup) and never reach this
# block, so a coord-ref-only / delete-only push — which never runs the gates —
# produces NO telemetry line (plan 1701's denominator is gate-running pushes only).
#
# write_push_telemetry runs from the EXIT trap, which fires on BOTH a passing and a
# failing exit — so a gate that BLOCKS the push (a real drift violation exits
# non-zero from inside `node scripts/lint-plan-index.mjs` / `lint-board.mjs`, well
# before the hook would otherwise reach its natural end) still gets its one
# telemetry line written on the way out; an absent hit marker for a gate that never
# ran (the hook aborted before reaching it) reads as index_hit=0 / board_hit=0.
#
# Every command below is defensively guarded (`|| fallback` assignment, an `if`-
# wrapped test rather than a bare `cmd && VAR=1` — the same plan-336 errexit footgun
# this hook's own header warns about elsewhere — and a trailing `|| :`/`2>/dev/null`
# on every write): a telemetry failure (disk full, permissions, a removed tempfile)
# must NEVER surface, delay, or fail the push. `return 0` is the function's own last
# statement so its exit status is always 0 regardless of which branch it took.
write_push_telemetry() {
  # plan-1731 review finding 3: COORD_PUSH_TELEMETRY_HITS_FILE unset/empty means mktemp
  # failed earlier — telemetry was never wired up for this push (the gates ran with the
  # env var absent, so neither could ever have marked a hit even if drift was found).
  # Writing a data line here would fabricate a false "clean" index_hit=0 board_hit=0
  # reading indistinguishable from a REAL clean push — skip the line entirely rather
  # than record manufactured data.
  if [ -z "$COORD_PUSH_TELEMETRY_HITS_FILE" ]; then
    return 0
  fi
  PP_TELEM_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null) || PP_TELEM_COMMON_DIR=""
  if [ -z "$PP_TELEM_COMMON_DIR" ]; then
    return 0
  fi
  PP_TELEM_LOG="$PP_TELEM_COMMON_DIR/push-telemetry.log"
  # finding 6: prefer the branch .husky/pre-push already resolved further down
  # (COORD_DRIFT_BRANCH, plan 1669) over a fresh rev-parse spawn — but the EXIT trap can
  # fire BEFORE that precompute section runs (an early failure elsewhere in the hook),
  # so keep the fallback. Written as an `if`/`else`, NOT `${COORD_DRIFT_BRANCH:-$(git
  # rev-parse …)}`: verified that a failing command substitution INSIDE a `${VAR:-…}`
  # default still trips errexit on the enclosing bare assignment (`set -e; V=${U:-$(false)}`
  # aborts) — the same plan-336 footgun class this hook's own header warns about — so the
  # fallback branch keeps the established `VAR=$(cmd) || fallback` idiom instead.
  if [ -n "$COORD_DRIFT_BRANCH" ]; then
    PP_TELEM_BRANCH="$COORD_DRIFT_BRANCH"
  else
    PP_TELEM_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || PP_TELEM_BRANCH="unknown"
  fi
  [ -n "$PP_TELEM_BRANCH" ] || PP_TELEM_BRANCH="unknown"
  # finding 7: read the hits file ONCE (a single `cat`, not two `grep` spawns) and derive
  # both flags from the in-memory content via `case` glob matching (verified this matches
  # across embedded newlines — no subprocess at all for the flag checks).
  PP_TELEM_INDEX_HIT=0
  PP_TELEM_BOARD_HIT=0
  if [ -f "$COORD_PUSH_TELEMETRY_HITS_FILE" ]; then
    PP_TELEM_HITS=$(cat "$COORD_PUSH_TELEMETRY_HITS_FILE" 2>/dev/null) || PP_TELEM_HITS=""
    case "$PP_TELEM_HITS" in *index*) PP_TELEM_INDEX_HIT=1 ;; esac
    case "$PP_TELEM_HITS" in *board*) PP_TELEM_BOARD_HIT=1 ;; esac
  fi
  PP_TELEM_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || PP_TELEM_TS="unknown"
  PP_TELEM_LINE="$PP_TELEM_TS branch=$PP_TELEM_BRANCH index_hit=$PP_TELEM_INDEX_HIT board_hit=$PP_TELEM_BOARD_HIT"
  # finding 5: compose the header (only when creating the log) and the data line into a
  # SINGLE append (one `printf … >>` call), not two separate writes — shrinks the
  # check-then-write TOCTOU window between two pushes racing on file-creation. A residual
  # race can still (rarely) double up the header if two processes both see the file
  # absent and both append header+data in the same instant; that's tolerable — the
  # read-back recipe below strips comment lines first, so a duplicated header never
  # inflates a count (a bonus fix alongside 5: the header's OWN example/recipe text used
  # to literally contain the substrings 'branch='/'index_hit=1'/'board_hit=1' it tells the
  # reader to grep for, so even a SINGLE header write was silently self-counting by +1..+2
  # before this stripped it out).
  if [ -f "$PP_TELEM_LOG" ]; then
    PP_TELEM_CONTENT="$PP_TELEM_LINE"
  else
    PP_TELEM_CONTENT="# push-telemetry.log (plan 1731) — one line per gate-running push (worktree-branch AND master):
#   <ISO-8601 UTC timestamp> branch=<branch> index_hit=0|1 board_hit=0|1
# index_hit / board_hit = 1 iff lint-plan-index.mjs / lint-board.mjs detected drift and
# entered its drift-attribution path this push (computeDriftIsInherited consulted),
# regardless of whether the drift then resolved inherited or strict.
# Read-back — never wc -l (would also count these header lines). Strip comment lines
# first: this header text itself contains the literal substrings 'branch='/'index_hit=1'/
# 'board_hit=1' and would self-count otherwise:
#   total gate-running pushes:  grep -v '^#' push-telemetry.log | grep -c 'branch='
#   index-gate hit count:       grep -v '^#' push-telemetry.log | grep -c 'index_hit=1'
#   board-gate hit count:       grep -v '^#' push-telemetry.log | grep -c 'board_hit=1'
$PP_TELEM_LINE"
  fi
  printf '%s\n' "$PP_TELEM_CONTENT" >> "$PP_TELEM_LOG" 2>/dev/null || :
  return 0
}

PUSH_TELEMETRY_HITS_FILE=$(mktemp 2>/dev/null) || PUSH_TELEMETRY_HITS_FILE=""
if [ -n "$PUSH_TELEMETRY_HITS_FILE" ]; then
  export COORD_PUSH_TELEMETRY_HITS_FILE="$PUSH_TELEMETRY_HITS_FILE"
fi
# Extends the plan-1287 PUSH_REFS_FILE-only EXIT trap so telemetry is written on every
# exit path from here on (pass or fail) — the two pass-throughs above this point never
# reach this line, so they keep firing the ORIGINAL trap untouched.
#
# plan 3274 (F1 fix, review round): the ledger-salvage merges below used to ride a SEPARATE trap,
# re-installed only after BOTH heavy gates (pytest-backend-scripts, scripts-battery) had already
# finished running — which defeated the entire point of a salvage trap, since the one event class
# it exists for (a hard kill DURING a heavy gate: a SIGTERM this shell honors, an operator
# Ctrl+C, the outer job-wrapper's own TerminateJobObject) can only ever fire BEFORE that late
# install point runs. Installed HERE instead, before either heavy gate starts, so a kill mid-gate
# salvages whatever ledger progress that gate's own run_battery_with_retry / pytest block had
# already flushed to its per-attempt events file. Every variable this trap body reads is guarded
# with `${VAR:-}` plus its own `[ -f … ]` check — trap bodies are evaluated at EXIT time, not at
# install time, so it is safe for this to fire before ANY of them are ever assigned (a push that
# never reaches backend/scripts/ or scripts/ at all, or is killed before either gate's block
# runs); each merge attempt then degrades to a no-op rather than erroring. PYTEST_LEDGER_KEY /
# PYTEST_LEDGER_EVENTS are set directly in the main script body by the pytest gate;
# _rbr_ledger_key / _rbr_ledgerfile are set by run_battery_with_retry (a plain sh function — no
# `local`, so both stay visible here even if the kill lands mid-function). BATTERY_RAN_FILE is
# declared later still (only inside the `[ -n "$CHANGED" ]` block near the bottom of this hook) —
# referencing it here before that assignment ever runs is equally safe (an unset var expands to
# empty under this hook's `sh -e`, no `set -u`, and `rm -f ""` is a verified no-op). This also
# folds in what used to be a SECOND, duplicate trap re-installation right after the battery gate
# (F6: one trap, installed once, in one place — the salvage logic never actually needed two
# copies, since `trap … EXIT` always replaces rather than stacks). Each merge is `|| :`'d and
# never touches the push's own exit status.
#
# review finding d97786: neither salvage merge was bounded — a hung `node
# scripts/battery-ledger.mjs {pytest-merge,merge}` (a wedged node process, a stuck fs write under
# AV scanning, …) would keep the WHOLE trap, and so the whole push, from ever completing, even
# though the CHUNKED banner (further down this file) may already have printed. Both merges are a
# small local JSON read-modify-write with no network and no subprocess fan-out — normally
# millisecond-scale — so $PP_LEDGER_SALVAGE_CAP_S=20 is generous headroom for a slow disk/AV scan
# while still guaranteeing the trap can't hang indefinitely. run_bounded_soft (not the hard
# run_bounded/require_timeout_or_exit pair) is deliberate: a trap body must never abort on a
# missing `timeout` binary, it must degrade to a bare call exactly like every other best-effort
# close-out step here. Both run_bounded_soft and the ledger vars this trap reads are assigned only
# LATER in the script (run_bounded_soft's own definition; then _rbr_ledgerfile/PYTEST_LEDGER_EVENTS
# inside the gates further down) — so by construction, an EXIT before run_bounded_soft is defined
# is an EXIT before either ledger var could be non-empty either, and the `&&` guards short-circuit
# before "run_bounded_soft" is ever looked up as a command name (mirrors the safety argument the
# big comment block above already makes for $_rbr_ledger_key / $_rbr_ledgerfile themselves).
# Override-able (mirrors every other hook-side cap's `${VAR:-default}` shape, e.g.
# PREPUSH_LEDGER_REMAINDER_CAP_S below) so a test can shrink it to prove the bound actually fires,
# without needing prepush_validate_positive_int — that function isn't defined until later in this
# file and the trap is installed here deliberately early (see the big comment above), so this
# stays a minimal self-contained digit check rather than the full MAX_SAFE_INTEGER-parity contract
# that function enforces (this value never crosses into done-worktree.mjs, so there's no JS-side
# value it needs to stay byte-for-byte aligned with — unlike PREPUSH_WALL_S & co).
#
# The `0*` arm is load-bearing, not tidiness (plan 3274 final round, findings 7b7a05/30dfc2/d342aa/
# 9bc41a/2c1134/218ba8/dc5910, all CONFIRMED). A digits-only check accepts BOTH degenerate shapes,
# and each defeats this bound in its own direction: GNU `timeout 0` means "no timeout at all", so
# `PP_LEDGER_SALVAGE_CAP_S=0` would silently restore exactly the unbounded merge this trap was
# just fixed to prevent; and a leading-zero value like `008` reaches run_bounded's `$((_rb_cap +
# 300))` on the Windows wrapper path, where it is shell arithmetic and aborts. Since no legitimate
# cap ever starts with `0`, one glob arm rejects both and falls back to the default.
case "${PP_LEDGER_SALVAGE_CAP_S:-}" in
  '' | *[!0-9]* | 0*) PP_LEDGER_SALVAGE_CAP_S=20 ;;
esac
# plan 3555 (delta review, angle-A CONFIRMED): the EXIT trap below now DELETES the pytest ledger
# events file and its worker siblings, not just merges them — so the two variables that name that
# path must be owned by THIS hook run and nothing else. They are ordinary shell variables, not
# part of any caller contract (the hook exports GATE_LEDGER_KEY / GATE_LEDGER_EVENTS_FILE for its
# children; these two are internal names), but an ambient export of the same name would otherwise
# be inherited — and a push that exits BEFORE the pytest gate initializes them (any earlier gate
# failing, a pass-through, an interrupt) would then have the trap merge into a stranger's ledger
# key and delete a stranger's file. Blanking them here, before the trap exists, makes non-empty
# mean exactly one thing: this run assigned it. Both guards below already treat empty as "nothing
# to do", so this is the whole fix.
PYTEST_LEDGER_KEY=""
PYTEST_LEDGER_EVENTS=""
pytest_ledger_events_exist() {
  if [ -z "$1" ]; then
    return 1
  fi
  case $- in
    *f*) _plee_restore_noglob=1 ;;
    *) _plee_restore_noglob=0 ;;
  esac
  set +f
  _plee_found=1
  if [ -f "$1" ]; then
    _plee_found=0
  fi
  for _plee_worker in "$1".gw*; do
    _plee_suffix=${_plee_worker#"$1".gw}
    case "$_plee_suffix" in
      '' | *[!0-9]*) continue ;;
    esac
    if [ -f "$_plee_worker" ]; then
      _plee_found=0
      break
    fi
  done
  if [ "$_plee_restore_noglob" = 1 ]; then
    set -f
  fi
  return "$_plee_found"
}
# NOTE: the `gw` + one-or-more-digits worker-suffix rule in these helpers is duplicated in
# scripts/battery-ledger.mjs's resolvePytestLedgerEventSources() `/^gw[0-9]+$/` check — a shell
# case pattern and a JS module can't share one literal. Changing the worker-id rule must update
# BOTH or cleanup and discovery silently disagree about which sibling paths belong to the run.
pytest_ledger_events_rm() {
  if [ -z "$1" ]; then
    return 0
  fi
  case $- in
    *f*) _pler_restore_noglob=1 ;;
    *) _pler_restore_noglob=0 ;;
  esac
  set +f
  rm -f "$1"
  for _pler_worker in "$1".gw*; do
    _pler_suffix=${_pler_worker#"$1".gw}
    case "$_pler_suffix" in
      '' | *[!0-9]*) continue ;;
    esac
    rm -f "$_pler_worker"
  done
  for _pler_cache in "$1".remainder-*; do
    _pler_suffix=${_pler_cache#"$1".remainder-}
    case "$_pler_suffix" in
      *.json.lock) _pler_digest=${_pler_suffix%.json.lock} ;;
      *.json) _pler_digest=${_pler_suffix%.json} ;;
      *) continue ;;
    esac
    case "$_pler_digest" in
      *[!0-9a-f]*) continue ;;
    esac
    [ "${#_pler_digest}" -eq 64 ] || continue
    rm -f "$_pler_cache"
  done
  if [ "$_pler_restore_noglob" = 1 ]; then
    set -f
  fi
  return 0
}
trap 'write_push_telemetry || :; { if [ -n "${PYTEST_LEDGER_KEY:-}" ] && [ -n "${PYTEST_LEDGER_EVENTS:-}" ]; then pytest_ledger_events_exist "$PYTEST_LEDGER_EVENTS" && run_bounded_soft "$PP_LEDGER_SALVAGE_CAP_S" node scripts/battery-ledger.mjs pytest-merge --key "$PYTEST_LEDGER_KEY" --file "$PYTEST_LEDGER_EVENTS" >/dev/null 2>&1 || :; pytest_ledger_events_rm "$PYTEST_LEDGER_EVENTS" || :; fi; } || :; { [ -n "${_rbr_ledger_key:-}" ] && [ -n "${_rbr_ledgerfile:-}" ] && [ -f "$_rbr_ledgerfile" ] && run_bounded_soft "$PP_LEDGER_SALVAGE_CAP_S" node scripts/battery-ledger.mjs merge --key "$_rbr_ledger_key" --file "$_rbr_ledgerfile" >/dev/null 2>&1; } || :; rm -f "$PUSH_REFS_FILE" "$PUSH_TELEMETRY_HITS_FILE" "${BATTERY_RAN_FILE:-}"' EXIT

# ── Precompute drift-attribution BRANCH once (plan 1669; narrowed by plan 1701) ──────
# COORD_DRIFT_BRANCH (`git rev-parse --abbrev-ref HEAD`) is resolved ONCE here and
# exported: it feeds computeDriftIsInherited (scripts/coord/drift-attribution-lib.mjs) in
# lint-plan-index.mjs / lint-board.mjs / lint-cloud-routine-prompts.mjs, the wiki-diff
# guard (PP_WIKI_BRANCH below), the master branch check (plan 1766 item 8), and the
# push-telemetry EXIT trap — one spawn amortized over ~6 consumers that would otherwise
# each re-run the identical call. An exported EMPTY STRING is a distinct "already
# attempted and failed" signal: computeDriftIsInherited fails closed (strict) on it
# instead of re-running a rev-parse that already failed once; an UNSET var (a direct
# `node scripts/lint-*.mjs`, or any test — none export it) means "shell didn't attempt
# this", so the lib runs its own git call.
#
# COORD_DRIFT_BASE (`git merge-base HEAD origin/master`) is deliberately NOT
# precomputed (plan 1701). Plan 1669 resolved it unconditionally here so the drift
# gates could share one spawn when BOTH hit drift on the same push — betting that
# dual-gate drift was the common case for a worktree-branch push. Push telemetry
# (plan 1731; 2026-07-12 → 2026-07-19, 806 worktree-branch pushes) refuted that
# premise: 88.6% of worktree pushes hit NO drift gate (index_hit 8.9%, board_hit
# 2.5%, dual hits ZERO in 806), so the unconditional merge-base paid a spawn on
# every push to save a duplicate that never once occurred. Leaving COORD_DRIFT_BASE
# UNSET routes each gate through the lib's own lazy merge-base (the pre-1669 path),
# which runs only on the ~11% of pushes that actually hit drift; at a measured dual
# rate of 0/806 no cross-gate sharing mechanism is warranted.
COORD_DRIFT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || COORD_DRIFT_BRANCH=""
export COORD_DRIFT_BRANCH

# ── Detached MAIN checkout diagnosis (plan 2391) ────────────────────────────
# A commit made on a DETACHED shared main checkout is silently lost by the next
# `git pull --rebase`: the rebase replays it onto the detached HEAD while
# refs/heads/master stays stranded, and once HEAD has nothing left ahead of origin
# the next pull fast-forwards the work off the tip. Observed 2026-07-25: eight push
# retries, every one reading as an ordinary ref-lock race, and the commit ended up
# absent from origin/master.
#
# WARN, don't block: by the time a push runs the commit already exists, so refusing
# here would strand it with no way out. The refuse lives at COMMIT time
# (scripts/check-coordination-branch.mjs, via .husky/pre-commit); this is the
# "make it legible" half — the operator gets the real diagnosis instead of a
# ref-lock message.
#
# Scoped to the MAIN checkout. The legitimate detached `HEAD:master` land push runs
# from an EPHEMERAL done-worktree — a LINKED worktree — and so is never matched here
# (see the seed-gate comment further down). The coord writers push with HUSKY=0 and
# never reach this hook, so a detached MAIN push that DOES reach it is a hand push:
# exactly the lossy case.
#
# Plan-2391 review (findings 1htljfd / 1h2l87l / r74ak9): this block used to hand-roll
# BOTH halves of the test in bash — a second `git rev-parse --abbrev-ref HEAD` spawn
# duplicating the COORD_DRIFT_BRANCH precompute directly above, and a third copy of the
# main-checkout test (git-dir == git-common-dir) that also depended on
# `--path-format=absolute` (git >= 2.31; without it the compare silently never matches
# on Windows and the whole block is dead code). Both are gone: the branch comes from the
# precompute (zero spawns), and the checkout question goes to the CANONICAL primitive,
# `isMainCheckout()` in scripts/check-coordination-branch.mjs — the same one the
# pre-commit guard and the PreToolUse hook use, so the three cannot drift. The node spawn
# is paid ONLY on the vanishingly rare detached push, never on the attached common case.
if [ "$COORD_DRIFT_BRANCH" = "HEAD" ] \
  && node -e "import('./scripts/check-coordination-branch.mjs').then(m => process.exit(m.isMainCheckout() ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
  echo "pre-push: ⚠️  WARNING — pushing from a DETACHED main checkout (plan 2391)."
  echo "pre-push:    HEAD (detached): $(git rev-parse HEAD 2>/dev/null)"
  echo "pre-push:    refs/heads/master: $(git rev-parse --verify --quiet refs/heads/master 2>/dev/null || echo unreadable)"
  echo "pre-push:    Commits made here are NOT on master and the next \`git pull --rebase\` can"
  echo "pre-push:    silently drop them. A non-fast-forward rejection now is this, not mere contention."
  echo "pre-push:    Reattach:  git checkout master   (or: git checkout -B master <sha>)"
  echo "pre-push:    Recover a lost commit:  git reflog  →  git cherry-pick <sha>"
  echo "pre-push:    Heal the checkout:  node scripts/heal-main.mjs"
fi

node scripts/lint-plan-index.mjs

# Block the push if handoff-board.md narrates active worktrees whose plan
# files moved subfolder or no longer exist on disk — sibling to lint-plan-index.
# Exits 0 silently when handoff-board.md is absent (legacy / pre-extraction
# projects). Plan 170 shipped the lint; plan 172 wires it here after the 2
# pre-existing drift issues were resolved.
node scripts/lint-board.mjs

# ---- project hook seam: cloud-routine prompt drift, plan 1947 ----
# The cloud-routine drain prompt bodies and the
# template they are generated from (a project-side prompt-template library) are a
# VETAPP surface — a generic coordination checkout ships neither, so this lint was a
# "core" gate only relative to this repo's own battery (plan 4096 T5). Moved behind
# the standard seam: same position in the ordered gate list, same unconditional
# (never diff-scoped) run, same blocking behaviour — see pp_project_cloud_routine_prompt_lint
# in scripts/hooks/pre-push-project.sh for the gate itself.
pp_run_project_seam cloud_routine_prompt_lint

# ── Pushed-delta ranges for the range-scoped guards (plan 1289) ──────────────
# lint-coord-trailer / assert-seed-io-seam / assert-price-gates-single-site used
# to each self-default to origin/master..HEAD, which drifts under the parallel-
# session herd (plan 1287's root cause) and, for the two ADDED-lines guards, can
# flag a long-lived branch's older file content as a spurious violation this
# push never introduced. `compute-push-diff.mjs --ranges` resolves the SAME
# per-ref <remote-sha>..<local-sha> ranges the $CHANGED tier computation further
# down uses (merge-base fallback for a new branch's all-zero remote sha) — one
# range per qualifying pushed ref. Three outcomes, errexit-safe (the `if`
# consumes the command's exit status):
#   • success, ≥1 range → the ranges are passed as argv to the three guards
#   • success, 0 ranges → this push introduces no content (e.g. a mixed
#     coord-ref + branch-delete push) → the guards have nothing to check → skip
#   • failure → WARN and run each guard with origin/master..HEAD passed as an
#     EXPLICIT argv range (plan 1752: since the seam-guard F1 refinement, a
#     zero-argv invocation means "a human manual run" and reads the WORKING-TREE
#     allowlist/content — the hook must never impersonate that; the explicit
#     range keeps every gate on its committed-content read path, semantically
#     the pre-1289 fallback; land + CI re-check). Only when origin/master is
#     itself unresolvable do the guards run with no args, where their own
#     range resolution returns null → SKIP.
PUSH_RANGES=""
RANGES_OK=0
ORIGIN_OK=0
if git rev-parse --verify --quiet origin/master >/dev/null 2>&1; then
  ORIGIN_OK=1
  if PUSH_RANGES=$(node scripts/compute-push-diff.mjs --ranges < "$PUSH_REFS_FILE" 2>/dev/null); then
    RANGES_OK=1
  else
    echo "pre-push: WARNING — pushed-delta range computation failed (transient shared-.git ref churn?). coord-trailer / seed-io-seam / price-gates guards fall back to their origin/master..HEAD default this push."
    PUSH_RANGES=""
  fi
fi
# Run a range-scoped guard with the resolved ranges. $PUSH_RANGES word-splits
# into one argv per range — ranges are sha..sha tokens (no spaces), so unquoted
# expansion is intended. Empty-but-OK means zero qualifying refs: nothing this
# push introduces, so the guard is skipped outright rather than falling back to
# an origin/master..HEAD diff of other sessions' commits. Range computation
# FAILED (RANGES_OK=0) with origin/master present → the fallback range is passed
# as explicit argv, never zero args (plan 1752 — zero argv = human manual run =
# working-tree reads; the hook must not impersonate that).
run_range_guard() {
  if [ "$RANGES_OK" = 1 ] && [ -z "$PUSH_RANGES" ]; then
    return 0
  fi
  if [ "$RANGES_OK" = 0 ] && [ "$ORIGIN_OK" = 1 ]; then
    node "$1" origin/master..HEAD
  else
    # shellcheck disable=SC2086
    node "$1" $PUSH_RANGES
  fi
}

# Reject hand-edited (un-trailered) writes to handoff-board.md / the INDEX
# generated region — they must go through the coord tools (coordWrite stamps the
# Coord-Write: trailer; move-plan stamps it too). A multi-step hand sequence that
# bypasses the tools lands WITHOUT the trailer and is rejected here. No-ops (exit 0)
# when neither guarded doc changed in the pushed range. plan 421 (Plan B);
# range-scoped to the pushed delta since plan 1289.
# (The coordination-ref pass-through above already exit-0s for refs/claims|coord/*,
# so this never runs on a claim push.)
run_range_guard scripts/lint-coord-trailer.mjs

# Block the push if any ready/ plan lacks a parseable "Cost forecast:" banner.
# The autonomous ready/-queue drain (plan 231) PAUSES on a plan with no cost
# section (cost.unknown), silently stalling an unattended run on the first such
# plan (the 2026-05-31 dry-run reproduced this: cost_pause on 208 at iter 0).
# Reuses queue-drain's parsePlanMeta (one parser, can't drift from the driver);
# tracked-only via git ls-files, so a foreign untracked ready/ plan never gates
# your push. Bypass: git push --no-verify (but supply the banner first).
node scripts/lint-plan-cost-forecast.mjs

# ---- project hook seam: seed/price/places seam + brand-token guards ----
# pp_project_seam_and_brand_guards is defined by scripts/hooks/pre-push-project.sh when that file
# exists (sourced earlier by the scripts/hooks/pre-push.sh dispatcher, which also sets
# PP_PROJECT_PRESENT); a checkout with no project file has PP_PROJECT_PRESENT=0, so
# pp_run_project_seam no-ops WITHOUT consulting PATH at all — the "core gates alone"
# contract (plan 3963), immune to an unrelated PATH executable of this name (finding
# fb9352). A present-but-broken project file (a renamed/dropped function) was already
# caught LOUDLY, once, up top — see the PP_PROJECT_SEAMS validation block (finding
# 6aa9d3) — so by the time this line runs, PP_PROJECT_PRESENT=1 means the function is
# guaranteed to exist.
pp_run_project_seam seam_and_brand_guards

# Block the push if it ADDS a platform-dependent path assertion to a scripts/**/*.test.mjs — an
# equality assertion whose expectation is a drive-less absolute literal (a leading slash is
# drive-RELATIVE on Windows), or two path-valued bindings compared raw (git spells a main clone's
# common dir with `/` and a linked worktree's with `\`). Cloud drains run on Linux and local
# sessions run on Windows, so such an assertion lands green and then blocks an UNRELATED plan whose
# diff happens to pull the test into the plan-2273 import-closure battery (plan 2478 → 2462).
# Fix with assertSamePath (scripts/test-path-assert.mjs), a derived expectation, or an injected
# `_path: win32`/`posix`; waive in place with `// path-assert-ok: <reason>`. Same range-scoping /
# SKIP-on-unresolvable-base policy as the seam guards above. Plan 2490.
run_range_guard scripts/assert-posix-path-assertions.mjs

# Block the push if a non-test `scripts/**/*.mjs` module imports OUTSIDE scripts/ (or into
# scripts/test-helpers/, which is never copied either). scripts/test-helpers/isolated-plan-repo.mjs
# copies the non-test scripts tree into a temp repo and runs the COPIES, so an escaping specifier
# resolves to nothing there and the copied tool dies with ERR_MODULE_NOT_FOUND — but only IF some
# copied tool's import chain happens to reach it, so a violation lands green and detonates much
# later in an unrelated suite (write-lint-common.mjs carried one undetected until plan 2615's
# tree-wide scan). Fix by moving the shared piece into scripts/ and importing it from the hook —
# hooks may reach into scripts, scripts may not reach back out. Unlike the seam guards this one
# scans the WORKING TREE (no allowlist, nothing to grandfather); the range is used only to skip
# the scan when the push touches no scripts/ file, and a git failure scans rather than skips.
# Rule + evidence: docs/coord/scripts-layout.md. Plan 2622.
run_range_guard scripts/assert-scripts-self-contained.mjs

# Block the push if a NEW lock-taking `git status`/`git diff` spawn lands in a read-only
# poller/hook (scripts/hooks/**/*.mjs, scripts/redgreen*.mjs) without `--no-optional-locks` —
# on a 131k-file tree such a spawn can itself WRITE the index (stat-cache / untracked-cache
# refresh), taking the same lock a concurrent land's rebase needs and turning a rescheduled
# pick into a false LAND_BLOCKED (plan 3974 T0). A wrapper that unconditionally prepends the
# flag to whatever argv it is given (redgreen.mjs's gitOut, coord-write-guard-pretooluse.mjs's
# git()) covers every one of its callers with one edit. Waive in place with
# `// lock-free-poll-ok: <reason>`. Same range-scoping / SKIP-on-unresolvable-base policy as
# the seam guards above; `--all` sweeps the whole corpus. Plan 3974.
run_range_guard scripts/assert-lock-free-git-polls.mjs

# ---- project hook seam: account-registry + pipeline-field/price-gates/evidence guards ----
# pp_project_pipeline_field_guards is defined by scripts/hooks/pre-push-project.sh when that file
# exists (sourced earlier by the scripts/hooks/pre-push.sh dispatcher, which also sets
# PP_PROJECT_PRESENT); a checkout with no project file has PP_PROJECT_PRESENT=0, so
# pp_run_project_seam no-ops WITHOUT consulting PATH at all — the "core gates alone"
# contract (plan 3963), immune to an unrelated PATH executable of this name (finding
# fb9352). A present-but-broken project file (a renamed/dropped function) was already
# caught LOUDLY, once, up top — see the PP_PROJECT_SEAMS validation block (finding
# 6aa9d3) — so by the time this line runs, PP_PROJECT_PRESENT=1 means the function is
# guaranteed to exist.
pp_run_project_seam pipeline_field_guards

# Prohibit detailed narratives in the INDEX plan-archive region (plan 639). The
# archive region is permanent (never rebuilt), so a verbose "what happened" essay
# written at archive time lives forever — entries had grown to 4407 chars. Two
# independent offender reasons: 'overlong' (over 600 chars, the original check,
# NEVER exempted) and 'narrative' (a spine-shaped row still carrying text beyond the
# prefix/batch tag — plan 3971 made the archive row prefix-only). Grandfathered
# sole-record entries are exempt from both. The narrative check is BASE-SCOPED
# (plan 3971 review r1): a row already present on origin/master (by default; a
# standalone run can override with --base/--no-base) is exempt from THAT check
# only, so this lint can land before the one-time `index.mjs condense-archive`
# clears the pre-existing backlog, without every push failing on rows it didn't
# introduce. Reads docs/INDEX.md from disk, so it fires on any normal master push
# (the archive-narrative path is a done-worktree docs push). Bypass: git push --no-verify.
node scripts/lint-index-brevity.mjs

# Enforce the plan-2393 lever-1 forwarding invariant: a callback may forward `lockCtx`
# into coordWrite ONLY when that coordWrite is its LAST coord-checkout mutation, because
# the lock is handed back at the commit and anything after it runs unserialized against a
# checkout a sibling may already be resetting (plan 2435 item 3). Reads scripts/*.mjs from
# disk (~100 ms, no git range), so it fires on any push — a tree with no scripts/ change is
# still clean, and it deliberately does NOT rely on the scripts/*.test.mjs battery, whose
# import-closure SELECTION would not pull this lint's test in when the violation is
# introduced in a caller like board.mjs. Bypass: git push --no-verify (investigate first).
node scripts/lint-coord-lockctx.mjs

# ---- project hook seam: PIPELINE.md drift advisory ----
# pp_project_pipeline_doc_lint is defined by scripts/hooks/pre-push-project.sh when that file
# exists (sourced earlier by the scripts/hooks/pre-push.sh dispatcher, which also sets
# PP_PROJECT_PRESENT); a checkout with no project file has PP_PROJECT_PRESENT=0, so
# pp_run_project_seam no-ops WITHOUT consulting PATH at all — the "core gates alone"
# contract (plan 3963), immune to an unrelated PATH executable of this name (finding
# fb9352). A present-but-broken project file (a renamed/dropped function) was already
# caught LOUDLY, once, up top — see the PP_PROJECT_SEAMS validation block (finding
# 6aa9d3) — so by the time this line runs, PP_PROJECT_PRESENT=1 means the function is
# guaranteed to exist.
pp_run_project_seam pipeline_doc_lint

# ── Diff-range gates (cross-package typecheck + backend/scripts guard) ───────
# Compute the pushed file list ONCE, defensively. The husky wrapper (.husky/_/h)
# runs this hook as `sh -e`, so errexit is ON — and two constructs used to bite
# under it (plan 336, the "silent herd failure" that forced the --no-verify land
# of plan 319):
#   1. A bare `VAR=$(git diff … | grep '^backend/scripts/')` whose grep matches
#      nothing exits 1 → errexit aborts the hook with NO error text. On a
#      docs-only / frontend-only push the backend/scripts grep ALWAYS misses, so
#      the hook died silently right before the verify-mobile gate. (The bug only
#      LOOKED intermittent: when a sibling herd left origin/master stale, the
#      diff range pulled in others' backend/scripts commits → the grep matched →
#      no abort. Confirmed via `sh -e` repro, session 269.)
#   2. A bare `CHANGED=$(git diff …)` aborts under errexit if `git diff` itself
#      transiently exits non-zero — e.g. a sibling herd session rewriting
#      refs/remotes/origin/master in the shared .git mid-read.
# Both are neutralised by capturing the diff ONCE in an `if !`-guarded
# assignment (the `if` consumes the exit status, so errexit can't fire) and
# gating each check with `… | grep -q …` inside an `if` rather than a bare
# assignment. On a transient failure we WARN and skip the diff-scoped gates
# instead of aborting — CI re-runs them and a re-push re-evaluates.
#
# Scoped to the PUSHED DELTA, not `origin/master..HEAD` (plan 1287). Under the
# ~5-7 session parallel herd, origin/master continuously accumulates OTHER
# sessions' commits, so origin/master..HEAD drifted a docs-only worktree push
# into seeing a "backend diff" (a sibling's fresh backend/src/** commits) and
# ran the full ~25s backend vitest suite on a push that changed zero backend
# files — under load that blew past the tool-call timeout and SIGKILLed the
# push mid-hook (exit 143), leaving stale index.locks for siblings to trip on
# (12+ such kills in the 2026-07-02 incident). scripts/compute-push-diff.mjs
# reads the captured stdin ref lines and, per pushed ref, diffs
# <remote-sha>..<local-sha> (merge-base-against-origin/master fallback for a
# new branch's all-zero remote sha), unioning across refs — i.e. exactly the
# commits THIS push introduces, never unrelated origin drift. A done-worktree
# master-land push's ref line already carries the real (non-zero) prior master
# tip as remote-sha, so it tiers correctly on the merge's own diff with no
# branch-name special-casing. Falls back to origin/master..HEAD only when
# stdin carries no qualifying ref line (a manual/test hook invocation).
#
# Derived from $PUSH_RANGES (plan 1289), the ranges resolved ONCE further up —
# never a second independent resolution: on a new-branch push the merge-base is
# re-resolved per invocation, so two calls straddling a sibling's origin/master
# advance could scope the range guards and these tier gates to two DIFFERENT
# commit sets for one and the same push. --files-for diffs the already-resolved
# ranges verbatim. Zero qualifying refs → $CHANGED stays empty (this push
# introduces no content). Range-computation failure → the plan-1287 stdin mode
# is the fallback (its own re-resolution, same as before plan 1289).
CHANGED=""
if [ "$RANGES_OK" = 1 ]; then
  if [ -n "$PUSH_RANGES" ]; then
    # shellcheck disable=SC2086 — one argv per range, sha..sha tokens (no spaces)
    if ! CHANGED=$(node scripts/compute-push-diff.mjs --files-for $PUSH_RANGES 2>/dev/null); then
      echo "pre-push: WARNING — pushed-delta diff computation failed (transient shared-.git ref churn during a herd?). Cross-package + backend/scripts gates SKIPPED this push; CI is the backstop and a re-push re-evaluates the range."
      CHANGED=""
    fi
  fi
elif [ "$ORIGIN_OK" = 1 ]; then
  if ! CHANGED=$(node scripts/compute-push-diff.mjs < "$PUSH_REFS_FILE" 2>/dev/null); then
    echo "pre-push: WARNING — pushed-delta diff computation failed (transient shared-.git ref churn during a herd, or an unresolvable merge-base against origin/master?). Cross-package + backend/scripts gates SKIPPED this push; CI is the backstop and a re-push re-evaluates the range."
    CHANGED=""
  fi
fi

# ---- project hook seam: market-dossier shape lint, plan 3725 ----
# pp_project_market_dossier_lint is defined by scripts/hooks/pre-push-project.sh when that file
# exists (sourced earlier by the scripts/hooks/pre-push.sh dispatcher, which also sets
# PP_PROJECT_PRESENT); a checkout with no project file has PP_PROJECT_PRESENT=0, so
# pp_run_project_seam no-ops WITHOUT consulting PATH at all — the "core gates alone"
# contract (plan 3963), immune to an unrelated PATH executable of this name (finding
# fb9352). A present-but-broken project file (a renamed/dropped function) was already
# caught LOUDLY, once, up top — see the PP_PROJECT_SEAMS validation block (finding
# 6aa9d3) — so by the time this line runs, PP_PROJECT_PRESENT=1 means the function is
# guaranteed to exist.
pp_run_project_seam market_dossier_lint

# ── worktree-branch wiki/ledger-diff guard (plan 1604; retry-then-fail-closed: plan 1639;
# plan 3944 extended coverage to the two hand-edited debt ledgers) ──────────────────────────
# A worktree-* branch must never carry a wiki/** commit: hot wiki pages
# (price-inspector-appendix.md, wiki/log.md, hot.md) are edited by many parallel
# sessions, so a branch carrying wiki commits is near-guaranteed to conflict at the
# landing-queue head — the plan-1536 incident (27-min head-slot hold, two rebase-
# resolve-rerecord cycles, purely from a worktree branch's wiki commits colliding
# with sibling straight-to-master wiki edits on the same hot page). Wiki write-back
# belongs straight to master via `node scripts/wiki-commit.mjs <pages…> -m "…"` run
# from inside the worktree (it auto-detects the calling checkout and routes via the
# disposable coord-checkout, never committing on this branch). Mirrors
# done-worktree.mjs's preflight guard (wikiDiffOnWorktreeBranch), which now shares the
# SAME retry-then-fail-closed contract (plan 1639) — a push OUTSIDE the done-worktree
# spine (a bare `git push`, not `--no-verify`'d) is caught here too.
# plan 3944: `docs/handoff/infra-debt.md` and its sibling domain ledger (grammar-debt.md) are the vetapp
# CLAUDE.md § Coordination's two plain-doc carve-outs from coordWrite — hand-edited on
# MASTER, never on a worktree branch — and a ledger line riding a branch conflicts at the
# landing-queue head exactly the same way a wiki page does (plan 3495 is the incident: a
# dispatch was told to delete an infra-debt line on a branch). Same failure shape, so it
# rides this ONE guard's pathspec rather than standing up a second block — but the FIX is
# opposite (wiki-commit.mjs vs a hand-edit-on-master-and-push), so the BLOCKED message below
# still branches per file class instead of pointing every hit at the same remedy.
# Diff basis (plan 1616): the equivalent one-line three-dot form
# `git diff --name-only origin/master...HEAD -- …` (git diff A...B == diff base(A,B)..B),
# replacing a separate `git merge-base` call + two-dot diff — one subprocess instead of
# two.
# plan 1639 (bounded-retry-then-fail-closed): a `/sonnet-review xhigh` on batch-2026-07-08
# (plan 1616) found the pre-1639 form silently SKIPPED this whole guard on a diff failure,
# reasoning in its own WARNING that done-worktree.mjs's wikiDiffOnWorktreeBranch "still
# catches this branch at land time" — but that function's own try/catch silently returned
# "no violation" on the identical failure class, and ITS header comment claimed the REVERSE
# (".husky/pre-push is the hard block"). Neither guard was actually authoritative on a diff
# failure: a correlated transient failure (shared-.git ref-lock churn during a parallel-
# session herd) at BOTH push time and land time let a worktree-branch wiki commit through
# BOTH guards undetected. Fixed here by retrying the diff up to 3 times with backoff
# (PP_WIKI_RETRY_BACKOFFS_SEC below, default 250ms/750ms/1500ms — the SAME schedule
# wikiDiffOnWorktreeBranch now uses) to absorb ordinary herd ref-lock churn; if the diff
# STILL cannot be computed once the retry budget is exhausted, this guard now BLOCKS the
# push (fail-closed) instead of silently skipping — a rare blocked retry-exhaustion is far
# cheaper than reproducing the plan-1536 incident. Bypass after investigating:
# git push --no-verify.
# Pathspec covers wiki/** + the root-level WIKI.md + the two debt ledgers (plan 3944) —
# 'wiki/**' alone never matches WIKI.md, but WIKI.md is treated as in-scope wiki content
# everywhere else (wiki-commit.mjs, check-coordination-branch.mjs's WIKI_RX); a WIKI.md-only
# commit would otherwise sail through this guard and reproduce the exact plan-1536 collision
# it exists to prevent (/sonnet-review xhigh on this same batch, 2026-07-08). The post-diff
# grep below (PP_WIKI_ONLY / PP_LEDGER_ONLY) does NOT re-filter what git already scoped — it
# only splits the already-correct result to pick which remedy text to print (a re-filter of
# git's own scoped output was flagged as a drift-prone no-op by a delta /sonnet-review on this
# same fix, 2026-07-08; this split is a different thing).
# errexit-safe: `case` on a captured var, `if VAR=$(…); then`-guarded diff assignment on
# EVERY attempt (initial + each retry) — no bare `VAR=$(…)`, mirrors the $CHANGED pattern's
# own errexit hazard notes above. Branch comes from the COORD_DRIFT_BRANCH precompute (plan
# 1766 item 8 — resolved once above, straight-line before this point; no re-spawn).
# Test seam: PP_WIKI_RETRY_BACKOFFS_SEC overrides the space-separated backoff schedule (e.g.
# "0 0 0" to make a test's retry-exhaustion path instant) — this file's own name-paired test.
PP_WIKI_BRANCH="$COORD_DRIFT_BRANCH"
case "$PP_WIKI_BRANCH" in
  worktree-*)
    if git rev-parse --verify --quiet origin/master >/dev/null 2>&1; then
      : "${PP_WIKI_RETRY_BACKOFFS_SEC:=0.25 0.75 1.5}"
      PP_WIKI_DIFF_FAILED=1
      PP_WIKI_DIFF=""
      # plan 1642 review fix [F]: ONE copy of the diff invocation, in a single loop — the
      # pre-fix shape duplicated the exact same `git diff …` literal once for the initial
      # attempt and again inside the retry loop (a drift risk: a future pathspec/flag change
      # applied to only one copy). The leading "" token is the initial attempt (no sleep); the
      # backoff schedule's tokens are the up-to-3 retries — mirrors the JS twin's single
      # `for (attempt = 0; ; attempt++)` loop (wikiDiffOnWorktreeBranch, scripts/done-worktree.mjs).
      for PP_WIKI_BACKOFF in "" $PP_WIKI_RETRY_BACKOFFS_SEC; do
        if [ -n "$PP_WIKI_BACKOFF" ]; then
          sleep "$PP_WIKI_BACKOFF"
        fi
        if PP_WIKI_DIFF=$(git diff --name-only origin/master...HEAD -- 'wiki/**' 'WIKI.md' 'docs/handoff/infra-debt.md' 'docs/handoff/grammar-debt.md' 2>/dev/null); then # dangling-ok: the optional domain ledger; an absent path is a no-op in this diff filter
          PP_WIKI_DIFF_FAILED=0
          break
        fi
      done
      if [ "$PP_WIKI_DIFF_FAILED" = 1 ]; then
        echo "pre-push: BLOCKED — worktree-branch wiki-diff guard could not compute the diff after 3 retries (plan 1639 fail-closed; backoff ${PP_WIKI_RETRY_BACKOFFS_SEC}s): transient shared-.git ref-lock churn during a herd, or a genuinely broken origin/master ref. done-worktree.mjs's wikiDiffOnWorktreeBranch degrades the SAME way at land time (same retry schedule, then a hard PREFLIGHT_FAIL) — a correlated failure at both seats must never silently let a worktree-branch wiki commit through undetected (the plan-1536 incident class). Investigate (stale/locked refs, an unreachable origin/master, network), then re-push. Bypass: git push --no-verify (investigate first)."
        exit 1
      fi
      if [ -n "$PP_WIKI_DIFF" ]; then
        # plan 3944: split the (already correctly scoped) diff into wiki vs ledger hits so the
        # BLOCKED message below can print the right remedy for each — the two classes have
        # OPPOSITE fixes (wiki-commit.mjs vs hand-edit-on-master-and-push), and printing both
        # unconditionally would force an operator hitting only one class to read past
        # instructions for the other to find the line that applies to them.
        PP_WIKI_ONLY=$(printf '%s\n' "$PP_WIKI_DIFF" | grep -E '^(wiki/|WIKI\.md$)' || true)
        PP_LEDGER_ONLY=$(printf '%s\n' "$PP_WIKI_DIFF" | grep -E '^docs/handoff/(infra-debt|grammar-debt)\.md$' || true)
        if [ -n "$PP_WIKI_ONLY" ]; then
          echo "pre-push: BLOCKED — this worktree branch carries wiki commit(s) (plan 1604):"
          printf '%s\n' "$PP_WIKI_ONLY"
          echo "pre-push: wiki write-back must land straight to master, never ride a worktree branch. TWO causes reach this block and the fixes are OPPOSITE — decide which one you are looking at before acting (plan 2389)."
          echo "pre-push:   (a) you AUTHORED a wiki edit on this branch. The content is wanted; only the ROUTE is wrong. Fix: from inside this worktree, push the page content with \`node scripts/wiki-commit.mjs <pages…> -m \"chore(wiki): …\"\` (it auto-detects this checkout and routes to master via the disposable coord-checkout), then drop the wiki commit(s) from this branch (git rebase -i and drop them, or reset before them) and re-push."
          echo "pre-push:   (b) you never touched these pages — a merge of origin/master into this branch swept master's wiki pages into a commit, and a formatter pass then REWROTE them. The content is NOT wanted: wiki prose carries snake_case identifiers that prettier's markdown emphasis normalization eats (O_EXCL becomes O*EXCL), so wiki-committing this to master would land silent corruption. Tell (b) from (a) with \`git diff origin/master...HEAD -- 'wiki/**' 'WIKI.md'\`: emphasis/underscore-only churn on pages you did not edit is corruption, not an edit. Fix: DISCARD it (\`git checkout origin/master -- 'wiki/**' 'WIKI.md'\` then amend, or drop the offending commit) and re-push — do NOT run wiki-commit.mjs on it."
          echo "pre-push: (plan 2389 added \`wiki/\` + \`WIKI.md\` to .prettierignore, so (b) should no longer be REACHABLE via lint-staged; a fresh (b) means either an older branch predating that fix, or the ignore entry regressed — its own drift-guard test is the gate for the latter.)"
        fi
        if [ -n "$PP_LEDGER_ONLY" ]; then
          echo "pre-push: BLOCKED — this worktree branch carries hand-edited debt-ledger commit(s) (plan 3944):"
          printf '%s\n' "$PP_LEDGER_ONLY"
          echo "pre-push: docs/handoff/infra-debt.md and its sibling domain debt ledger are CLAUDE.md § Coordination's plain-doc carve-outs from coordWrite — hand-edited on MASTER, never on a worktree branch (plan 3495: a dispatch was told to delete an infra-debt line on a branch; a ledger line riding a branch conflicts at the landing-queue head exactly like a wiki page). Fix: hand-edit the ledger on the MAIN checkout's master, \`git commit -m \"…\" -- <ledger path>\`, push via pushMasterWithRebase (scripts/coord/coord-git.mjs), then drop the ledger commit(s) from this branch (git rebase -i and drop them, or reset before them) and re-push."
        fi
        echo "pre-push: Bypass: git push --no-verify (investigate first)."
        exit 1
      fi
    fi
    ;;
esac


# ── Generic orphan/hang bound (plan 1683 — generalizes plan 1674's battery-only mechanism) ──
# plan 1674 measured that a killed push (session kill / git timeout / aborted coordWrite
# retry) orphans whatever process tree it started: the sh wrappers die while the spawned
# tree (vitest worker pools, pytest, a WebKit browser tree) keeps running indefinitely
# (10/10 live batteries orphaned in the incident, idle-worker count climbing 133->163 over
# ~1h). 1674 fixed this for the scripts/*.test.mjs battery only; every OTHER long-running
# spawn below (backend vitest tiers, frontend seed-sanity vitest, the backend/scripts pytest
# gate, the WebKit mobile gate) shared the exact same vulnerability, unwrapped, until now.
#
# Detection (once per push, cheap: two builtin-ish checks, no subprocess): mirrors the
# battery block's own PP_WRAPPER selection so there is exactly one place a host's
# capability is probed. A missing wrapper FILE on a powershell host degrades loudly (the
# cap still bounds every gate below; only the near-instant parent-death kill is lost) — the
# orphan mechanism is Windows-specific anyway (plan 1674 Work 4), so a non-Windows host
# takes the bare-timeout fallback as the correct shape, not a degradation.
PP_WRAPPER=""
PP_BOUND_DESC="TIMEOUT-CAPPED ONLY (no job wrapper)"
if command -v powershell >/dev/null 2>&1; then
  if [ -f scripts/prepush-job-wrapper.ps1 ]; then
    PP_WRAPPER="scripts/prepush-job-wrapper.ps1"
    PP_BOUND_DESC="job-wrapped"
  else
    echo "pre-push: scripts/prepush-job-wrapper.ps1 MISSING — long-running gates run without the kill-on-close job wrapper (the timeout cap below still bounds them); restore the file, it is tracked in this repo" >&2
  fi
fi

# ── LOCAL-vs-CLOUD push classification (plan 2875) ──────────────────────────
# The two heaviest gates below (pytest-backend-scripts, scripts-battery — measured 98.5% of
# ALL gate time over 10 days, 96% of THAT on worktree-branch pushes re-running ~6x average
# before landing) only earn their FULL-run cost on THIS machine, where 5-7 sessions share
# one Windows box and contend for CPU/disk/the shared .git. A cloud drain runs ONE session
# per VM — nothing to contend with, no human waiting on the terminal, and it is this repo's
# only routine LINUX coverage — so a cloud push must NEVER see its heavy tiers softened.
# Operator ruling (verbatim, scoping this plan): "its less of anissue on cloud drains" /
# "since there is only 1 session per VM instance".
#
# Signal: `uname -s`, deliberately NOT an env var. Every cloud env — full-egress AND
# trusted/limited-egress alike (this project's full-egress env fleet) — carries both
# the coordination git-push token env var (this project's config
# names it) and FETCH_VANTAGE, so either would technically discriminate local from cloud
# too. But both are SECRETS (their whole purpose is credential/vantage material), and
# keying a test-SKIP decision on a secret's presence is a needless coupling when a
# non-secret signal is exactly as robust: this hook only ever runs locally under
# Git-for-Windows (MSYS/MINGW/CYGWIN — the operator's box, per this repo's own
# CLAUDE.md), and every cloud sandbox, full or trusted, is real Linux. This is the SAME
# `uname -s` this hook already uses for the battery-lock holder-pid platform split further
# down (search MINGW*/MSYS*/CYGWIN*), just read in the opposite direction: THERE, matching
# one of those three means "no probeable pid"; HERE, matching one of those three means
# "this is the operator's local Windows box".
#
# FAIL-CLOSED BY CONSTRUCTION: the only demotable case is a POSITIVE match on the
# Windows-emulation allowlist below. A missing `uname`, a real Linux/Darwin/BSD host (every
# cloud sandbox), or any platform this hook has never seen all leave PP_IS_LOCAL_PUSH=0 —
# the exact same "run the gate for real" path a cloud push takes. A wrong guess can only
# ADD a gate run, never remove one.
PP_IS_LOCAL_PUSH=0
case "$(uname -s 2>/dev/null)" in
  MINGW* | MSYS* | CYGWIN*) PP_IS_LOCAL_PUSH=1 ;;
esac

# ── plan 3295 E3: the land's once-per-land proof set ─────────────────────────────────────────
# The spine's post-rebase force-push is the single measured-dominant step of a land (plan 2443:
# it runs this whole battery). Operator ruling 2026-08-19 — "Once per land period" — covers it:
# a heavy gate already proven green earlier in THAT land is not re-proven here.
#
# THE SIDECAR IS THE ONLY SOURCE OF TRUTH (gpt-review a5db89 / eda9b2 / 11844d). `done-worktree.mjs`
# exports exactly ONE variable, `LAND_ID`; the proofs themselves — which gates, and the sha each was
# proven against — are read straight out of the land's own worktree sidecar
# `.scratch/land-gates-proven.json`. The first cut also exported `LAND_GATES_PROVEN` /
# `LAND_GATES_PROVEN_SHAS` and trusted THOSE for the gate names and baselines while validating only
# `LAND_ID` against the sidecar: two copies of one fact on one push, where a stale or hand-set env
# value would have been honoured as proof. Now the env carries only the id that ATTRIBUTES the
# sidecar, so there is nothing to disagree with.
#
# THREE conditions, all required, and every failure route leaves the gates exactly as they are
# today (the safe direction — a wrong guess can only ADD a run):
#   1. `CLAUDE_CODE_REMOTE` UNSET. A cloud push always gates in full (same ruling: cloud default
#      is full every land, chunked per plan 3274). This is checked FIRST and on its own.
#   2. `LAND_ID` present.
#   3. `LAND_ID` equals the landId in the land sidecar of the repo BEING PUSHED. This is what makes
#      a stale `LAND_ID` inherited from an unrelated shell inert: the sidecar is written by the land
#      into ITS OWN worktree's gitignored `.scratch/`, so an ordinary push from any other checkout
#      finds no sidecar (or a different id) and the export is ignored, loudly.
PP_LAND_PROVEN=""
PP_LAND_PROVEN_PYTEST_SHA=""
PP_LAND_PROVEN_BATTERY_SHA=""
# The sidecar, flattened to one `<key> <value>` line per fact: `landId <id>` first, then one line
# per proven gate. The node reader is the validator too — it drops any gate whose recorded sha is
# not sha-shaped, so a malformed entry can never hand a baseline to a `git diff` below.
PP_LAND_SIDECAR_DUMP=""
# <gate> -> its proven sha out of that dump. Echoes empty for an unnamed gate. `sed -n …p`, never
# `grep`: a non-matching grep exits 1 and this hook runs under errexit (plan 336's silent-herd
# footgun), while a no-match `sed` exits 0 — so no `|| true` crutch is needed anywhere here.
pp_land_proven_sha() {
  printf '%s\n' "$PP_LAND_SIDECAR_DUMP" | sed -n "s/^$1 //p" | head -n 1
}
if [ -z "${CLAUDE_CODE_REMOTE:-}" ] && [ -n "${LAND_ID:-}" ]; then
  _pp_land_top=$(git rev-parse --show-toplevel 2>/dev/null) || _pp_land_top=""
  if [ -n "$_pp_land_top" ] && [ -f "$_pp_land_top/.scratch/land-gates-proven.json" ]; then
    PP_LAND_SIDECAR_DUMP=$(node -e "try{const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));if(!j||typeof j.landId!=='string'||!j.landId.trim())process.exit(0);const out=['landId '+j.landId.trim()];const g=j.gatesProven;if(g&&typeof g==='object'){for(const k of Object.keys(g)){const e=g[k];if(e&&typeof e.sha==='string'&&/^[0-9a-f]{7,64}\$/.test(e.sha))out.push(k+' '+e.sha)}}process.stdout.write(out.join('\n'))}catch(e){}" "$_pp_land_top/.scratch/land-gates-proven.json" 2>/dev/null) || PP_LAND_SIDECAR_DUMP=""
  fi
  _pp_land_sidecar_id=$(pp_land_proven_sha landId)
  if [ -n "$_pp_land_sidecar_id" ] && [ "$_pp_land_sidecar_id" = "$LAND_ID" ]; then
    PP_LAND_PROVEN=$(printf '%s\n' "$PP_LAND_SIDECAR_DUMP" | sed -e '/^landId /d' -e 's/ .*//' | tr '\n' ',' | sed 's/,$//')
    PP_LAND_PROVEN_PYTEST_SHA=$(pp_land_proven_sha pytest-backend-scripts)
    PP_LAND_PROVEN_BATTERY_SHA=$(pp_land_proven_sha scripts-battery)
    echo "pre-push: once-per-land (plan 3295) — this land already proved [$PP_LAND_PROVEN] green (read from the land sidecar); the heavy gates below run only the remainder since each proven tree. Fast gates (lint, prettier, the small diff-scoped selections) are never skipped."
  else
    PP_LAND_SIDECAR_DUMP=""
    echo "pre-push: IGNORING LAND_ID — it does not match this checkout's land sidecar (${_pp_land_sidecar_id:-no sidecar}). Every gate runs in full (plan 3295)."
  fi
fi

# ── Cloud-chunked heavy-gate deadline (plan 3274) ───────────────────────────
# The two heaviest gates below (pytest-backend-scripts, scripts-battery) can each run for many
# minutes, and a SINGLE push can select BOTH (a diff touching backend/scripts/_places_geo.py
# selects FULL pytest, and one touching THIS file selects the battery) — two independent fixed
# caps would then SUM past the foreground push wall a cloud drain runs under (600s — see this
# repo's CLAUDE.md § Push retry discipline). Rather than cap each gate independently, stamp ONE
# absolute wall-clock DEADLINE here, at hook start, and let each heavy gate derive its own cap
# from whatever is left of that SAME deadline by the time it starts (prepush_remaining_budget,
# defined below) — so two gates in one push share one budget instead of each getting a full one.
#
# TOGGLE, highest precedence first:
#   1. PREPUSH_GATE_CHUNK_S set and numeric > 0 — chunking ON, and its value REPLACES
#      PREPUSH_WALL_S outright. This is the test/local-repro seam: a tiny value lets a fast test
#      (or an operator reproducing a cloud chunk locally) exercise a real cap-kill without
#      waiting out the real default.
#   2. CLAUDE_CODE_REMOTE non-empty (a cloud sandbox — orthogonal to, and NOT the same signal
#      as, PP_IS_LOCAL_PUSH's `uname` probe just above) — chunking ON at the
#      PREPUSH_WALL_S/PREPUSH_MIN_CHUNK_S defaults.
#   3. Otherwise — chunking OFF. Every existing budget below (PYTEST_CAP_S, BATTERY_CAP) keeps
#      its CURRENT value byte-identical; local behavior does not change at all.
# Orthogonal to PP_IS_LOCAL_PUSH / _should_locally_defer above: those DEFER a heavy gate
# entirely on a local push (never run it this push); chunking instead BOUNDS a gate that is
# actually going to run, and never demotes or defers anything. A real cloud push never sets
# PP_IS_LOCAL_PUSH=1, so the two mechanisms never fight over the same gate in production; a
# LOCAL test exercising chunking must keep its selection small enough to stay under
# PREPUSH_LOCAL_DEMOTE_MAX_FILES so _should_locally_defer's own decision doesn't intervene first.
# prepush_validate_positive_int <raw> <default> — the ONE numeric-validity rule EVERY
# PREPUSH_GATE_CHUNK_S / PREPUSH_WALL_S / PREPUSH_MIN_CHUNK_S / PREPUSH_LEDGER_REMAINDER_CAP_S
# value must pass (plan 3274, F1/F2/F3 delta-review fixes). Echoes <raw> — normalized to plain
# decimal, no leading zeros — when it is a valid positive integer: a non-empty run of ASCII
# digits, no sign, no decimal point, no whitespace, and no larger than Number.MAX_SAFE_INTEGER
# (9007199254740991) — the EXACT boundary done-worktree.mjs's parsePrepushPositiveInt enforces
# via `Number.isSafeInteger`, so the same env value can never enable/size chunk mode differently
# on this surface than on the JS one — the divergence this finding exists to close. Echoes
# <default> for every other shape: empty, non-numeric, negative (the leading `-` is not a
# digit), zero, a decimal point, leading/trailing whitespace, or a value exceeding
# MAX_SAFE_INTEGER. Before the F1/F3 review-round fix, only PREPUSH_GATE_CHUNK_S was validated
# this way (via a bespoke inline case pattern); PREPUSH_WALL_S/PREPUSH_MIN_CHUNK_S were taken
# as-is, straight into arithmetic, so an invalid value on either of THOSE two carried garbage
# into PREPUSH_DEADLINE_EPOCH's own `$(( ))` (or aborted this errexit shell outright) while
# chunkGateConfig quietly defaulted the same value away — same env, two behaviours, silently.
#
# POSIX-`sh`-portable throughout — NO `$((10#…))` Bash-extension arithmetic (plan 3274 F1
# BLOCKER fix, found independently by six review angles). This file's shebang is
# `#!/usr/bin/env sh`, and the real `/bin/sh` on every Linux cloud drain this plan exists to
# serve is `dash`, which treats a `10#`-prefixed radix literal as an arithmetic SYNTAX ERROR —
# verified 2026-08-18 against a real `dash` binary (`/usr/bin/dash.exe: arithmetic expression:
# expecting EOF: "10#008"`, exit 2), not just this repo's test harness, whose own `sh` resolves
# to Git for Windows' `usr\bin\sh.exe` — which is Bash running in `--posix`-ish sh-compat mode,
# not a real POSIX shell, and happily accepts `10#`. That gap is exactly why the old version of
# this function passed every test here while still being a hard abort on the platform the whole
# chunking feature was built for: EVERY push through this hook, chunked or not, on any system
# where `/bin/sh` is dash.
#
# Leading zeros are stripped TEXTUALLY instead (review finding d62e5e — see the function body for
# the mechanism) so "008" normalizes to "8" without ever risking dash/bash's own $(( ))-default
# octal auto-detection — "008"/"009" are not even valid octal literals and would abort this
# errexit shell the moment a later bare arithmetic use touched the raw string.
#
# The MAX_SAFE_INTEGER boundary check (plan 3274 F3 delta-review fix) is ALSO arithmetic-free,
# for the same reason: a 16-digit value is exactly the shape whose comparison this whole
# rewrite is trying to keep out of `$(( ))`. A digit-COUNT alone decides everything except the
# one length (16) where the boundary literal "9007199254740991" itself lives — there, a plain
# lexicographic `sort` of the two same-length, all-digit strings decides it (byte order equals
# numeric order for equal-length decimal strings), forced to the `C` locale so no collation
# ever reorders digits. (One residual gap, unchanged from before this fix and not this shell
# side's to close: an ASTRONOMICALLY long digit run — 309+ digits — overflows even IEEE-754 to
# Infinity, and `Infinity > 0` is true, so parsePrepushPositiveInt in done-worktree.mjs
# technically accepts it while no shell integer can represent Infinity; see that plan's own
# report.)
prepush_validate_positive_int() {
  _pvpi_val="$1"
  _pvpi_default="$2"
  case "$_pvpi_val" in
    '' | *[!0-9]*)
      echo "$_pvpi_default"
      return 0
      ;;
  esac
  # review finding d62e5e: the old one-zero-per-iteration `while` loop re-copied the shrinking
  # string on every iteration — O(n) iterations each doing O(n) work — so a digit-only override
  # with tens of thousands of leading zeros made this quadratic (a hung push, not a crash: `sh -e`
  # has no recursion/stack limit to trip). `${_pvpi_val%%[1-9]*}` finds the LONGEST suffix of
  # _pvpi_val matching "a non-zero digit followed by anything" in ONE pass — the only substring
  # that can start with a non-zero digit and match is the one starting at the FIRST such digit
  # (any earlier start begins with '0' and fails the pattern) — so what that removes leaves behind
  # exactly the leading-zero run (or the WHOLE string, unchanged, when there is no non-zero digit
  # at all: an all-zero input, where the pattern matches no suffix); its LENGTH is the zero count.
  # Measured empirically against the real `/usr/bin/dash` this file targets (not just Git-for-
  # Windows' bash-as-sh): this one glob-pattern operation stays linear even at 1,000,000 leading
  # zeros (~0.05s). But feeding that same huge zero-run BACK into `${_pvpi_val#"$_pvpi_leading_zeros"}`
  # as a LITERAL prefix pattern is NOT linear in dash's matcher — measured 200k zeros at ~20s and
  # climbing roughly with the square of the length, i.e. the exact quadratic blowup this fix
  # exists to remove, just relocated. So the actual character-offset slice is delegated to `cut`
  # (a real O(n) byte-oriented tool, already the file's convention for text ops it doesn't trust
  # to shell built-ins — see the `sort`/`head` MAX_SAFE_INTEGER compare just below) and only when
  # there IS a leading zero to strip — the common case (no leading zero) and the all-zero case
  # both skip the subprocess entirely.
  _pvpi_leading_zeros="${_pvpi_val%%[1-9]*}"
  _pvpi_zero_count=${#_pvpi_leading_zeros}
  if [ "$_pvpi_zero_count" -eq "${#_pvpi_val}" ]; then
    _pvpi_stripped=""
  elif [ "$_pvpi_zero_count" -eq 0 ]; then
    _pvpi_stripped="$_pvpi_val"
  else
    _pvpi_stripped=$(printf '%s' "$_pvpi_val" | cut -c$((_pvpi_zero_count + 1))-)
  fi
  if [ -z "$_pvpi_stripped" ]; then
    echo "$_pvpi_default"
    return 0
  fi
  _pvpi_len=${#_pvpi_stripped}
  if [ "$_pvpi_len" -gt 16 ]; then
    echo "$_pvpi_default"
    return 0
  fi
  if [ "$_pvpi_len" -eq 16 ]; then
    _pvpi_max='9007199254740991'
    if [ "$_pvpi_stripped" != "$_pvpi_max" ]; then
      _pvpi_smaller=$(printf '%s\n%s\n' "$_pvpi_stripped" "$_pvpi_max" | LC_ALL=C sort | head -n 1)
      if [ "$_pvpi_smaller" != "$_pvpi_stripped" ]; then
        echo "$_pvpi_default"
        return 0
      fi
    fi
  fi
  echo "$_pvpi_stripped"
}
PREPUSH_WALL_S="${PREPUSH_WALL_S:-480}"
PREPUSH_MIN_CHUNK_S="${PREPUSH_MIN_CHUNK_S:-60}"
# F1 review fix: re-validate both defaulted values above — an invalid raw env value (non-empty,
# so the `:-` defaults just above never fired) would otherwise ride unchecked into
# PREPUSH_DEADLINE_EPOCH's arithmetic further down. Falls back to the exact default literal each
# was just assigned above, so this is a no-op whenever the raw value was already valid or unset.
PREPUSH_WALL_S=$(prepush_validate_positive_int "$PREPUSH_WALL_S" 480)
PREPUSH_MIN_CHUNK_S=$(prepush_validate_positive_int "$PREPUSH_MIN_CHUNK_S" 60)
PREPUSH_CHUNK_MODE=0
# Rule 1: PREPUSH_GATE_CHUNK_S set and valid (same prepush_validate_positive_int rule as above) —
# chunking ON, REPLACING PREPUSH_WALL_S outright (the pinned clobber below). An invalid/unset
# PREPUSH_GATE_CHUNK_S echoes '' here (the <default> argument), so rule 1 does not apply and this
# falls through to rule 2.
_prepush_gate_chunk_s=$(prepush_validate_positive_int "${PREPUSH_GATE_CHUNK_S:-}" '')
if [ -n "$_prepush_gate_chunk_s" ]; then
  PREPUSH_CHUNK_MODE=1
  PREPUSH_WALL_S="$PREPUSH_GATE_CHUNK_S"
  # Re-validate after the clobber (never skip it): the raw PREPUSH_GATE_CHUNK_S value can still
  # carry a leading-zero/octal-risky spelling this function's own normalization (above) would
  # have cleaned up — chunk mode is already ON at this point, so a fallback here only changes
  # the WALL value, never turns chunking back off.
  PREPUSH_WALL_S=$(prepush_validate_positive_int "$PREPUSH_WALL_S" 480)
fi
if [ "$PREPUSH_CHUNK_MODE" != 1 ] && [ -n "${CLAUDE_CODE_REMOTE:-}" ]; then
  PREPUSH_CHUNK_MODE=1
fi
# The deadline itself: an absolute epoch, stamped once here. Left at 0 when chunking is off —
# prepush_remaining_budget below never lets a caller read that as "no time left" (see its own
# guard), so a 0 deadline can only ever under-constrain, never falsely block, a gate that
# somehow consulted it without checking PREPUSH_CHUNK_MODE first.
PREPUSH_DEADLINE_EPOCH=0
if [ "$PREPUSH_CHUNK_MODE" = 1 ]; then
  _pp_deadline_t0=$(date +%s) || _pp_deadline_t0=0
  PREPUSH_DEADLINE_EPOCH=$((_pp_deadline_t0 + PREPUSH_WALL_S))
fi

# prepush_remaining_budget — echoes whole seconds left until PREPUSH_DEADLINE_EPOCH, floored at
# 0 (never negative). Chunking OFF echoes a large sentinel so a caller that (incorrectly)
# consulted this without its own `[ "$PREPUSH_CHUNK_MODE" = 1 ]` guard always reads "plenty of
# budget left" rather than a false "no time" — belt and suspenders, not the primary guard.
prepush_remaining_budget() {
  if [ "$PREPUSH_CHUNK_MODE" != 1 ]; then
    echo 999999
    return 0
  fi
  _prb_now=$(date +%s) || _prb_now="$PREPUSH_DEADLINE_EPOCH"
  _prb_rem=$((PREPUSH_DEADLINE_EPOCH - _prb_now))
  [ "$_prb_rem" -lt 0 ] && _prb_rem=0
  echo "$_prb_rem"
}

# prepush_derive_attempt_cap <fixedCap> — the ONE per-attempt cap re-derivation
# run_battery_with_retry's retry loop calls before EVERY attempt (plan 3274 F2 fix, extracted as
# its own function in the F3 review-round fix below): echoes <fixedCap> shrunk down to whatever
# prepush_remaining_budget() reports is left of the shared push deadline, floored at 1s, but
# NEVER grown back up — the deadline only drains as wall-clock time passes, so a later attempt's
# own re-derived cap can only be smaller than (or equal to) an earlier one's, never bigger. A
# no-op (echoes <fixedCap> unchanged) whenever chunking is off ($PREPUSH_CHUNK_MODE != 1) — the
# local byte-identical-behaviour guarantee.
#
# Extracted as its own function (plan 3274, F3 review fix) specifically so
# this file's own name-paired test can assert this DERIVATION directly — by grabbing this function's
# source (mirroring bound_status_class/battery_outcome_class's own grab()-and-exec test pattern in
# that file) and feeding it controlled prepush_remaining_budget() readings — instead of inferring
# a shrink from how long a real battery attempt survived a real sleep. The prior test calibrated a
# dry run's setup overhead and then depended on a real sleep landing inside a computed window; this
# repo has measured 5x wall-clock spreads on identical code under parallel-session load, making
# that shape a flake generator on a suite the whole repo pushes through, liable to be blamed on an
# unrelated change.
prepush_derive_attempt_cap() {
  _pdac_cap=$1
  if [ "$PREPUSH_CHUNK_MODE" = 1 ]; then
    _pdac_remaining=$(prepush_remaining_budget)
    [ "$_pdac_remaining" -lt 1 ] && _pdac_remaining=1
    [ "$_pdac_remaining" -lt "$_pdac_cap" ] && _pdac_cap="$_pdac_remaining"
  fi
  echo "$_pdac_cap"
}

# prepush_chunk_report <gate> <detail> — the ONE banner for a CHUNKED outcome (plan 3274, design
# contract D3): unmistakable, never confusable with an ordinary test failure — a developer (or
# an unattended cloud drain re-reading its own output) must be able to tell at a glance that
# re-pushing the SAME commit is the correct next action, not a fix. Telemetry
# (gate_outcome/gate_close, result=chunked) is the CALLER's job, same split as every other
# gate's own echo-then-close pairing elsewhere in this hook — folding it in here would either
# double-log a caller that already gate_closes, or leave a caller that doesn't call gate_close
# silently unrecorded.
#
# plan 3620: the FIRST line of both this banner and prepush_nonconvergent_report's (just below) is
# a stable, greppable MARKER line — the machine-readable half of this plan's acceptance criterion
# 3, pinned by this file's own name-paired test. Exact grammar (one line, no other spelling):
#   pre-push: MARKER prepush-outcome=CHUNKED gate=<gate>
#   pre-push: MARKER prepush-outcome=NON_CONVERGENT gate=<gate>
# A genuinely FAILING gate must NEVER print either line — that omission is what makes "chunked",
# "non-convergent" and "failed" machine-distinguishable from a killed run's own partial output
# without parsing prose. Every other failure message in this hook (the pytest red-test line, the
# "FAILED (both attempts)" battery line, every classify_pytest_failure arm, the cap/no-verdict
# arms, …) is untouched by this plan and prints neither marker — see this plan's own tests for the
# "a failing gate emits no marker" pin.
prepush_chunk_report() {
  echo "pre-push: MARKER prepush-outcome=CHUNKED gate=$1"
  echo "pre-push: CHUNKED (not a test failure): $1 — $2"
  echo "pre-push: Re-push the SAME commit to continue — no rebase, no --no-verify."
}

# prepush_nonconvergent_report <gate> <detail> — the push-side twin of the land side's
# GATE_NON_CONVERGENT outcome (done-worktree.mjs's scoreChunkRound/NON_CONVERGENT_ROUNDS seam,
# plan 3436) — named identically ON PURPOSE, so the same seam name means the same thing on both
# sides of a land. Printed INSTEAD OF prepush_chunk_report — never both, never in the same call —
# once scripts/battery-ledger.mjs's chunk-round/pytest-chunk-round subcommand (called at the
# RAN-AND-CHUNKED seats only, see those call sites below) reports that NON_CONVERGENT_ROUNDS
# (2 — scripts/battery-ledger.mjs owns that constant; never re-minted here, per that constant's
# own header) consecutive rounds on this EXACT commit each banked ZERO new ledger files: proof
# that another identical push banks nothing again, so the correct next action is the OPPOSITE of
# prepush_chunk_report's own advice — STOP re-pushing and diagnose, not "push the same commit
# again". Still exits the push non-zero — a louder diagnosis, never a pass (plan's own execution
# note (b)) — the two call sites below keep their existing exit path and gate_outcome call intact.
prepush_nonconvergent_report() {
  echo "pre-push: MARKER prepush-outcome=NON_CONVERGENT gate=$1"
  echo "pre-push: GATE_NON_CONVERGENT: $1 — $2"
  echo "pre-push: STOP RE-PUSHING THIS COMMIT — diagnose instead. Two consecutive chunk-capped rounds on this exact commit each proved ZERO new files, so another identical push will bank nothing again and reprint this same message forever. Find the one file/test that cannot finish inside a single chunk wall (the ledger key and remaining count above name it) and fix or isolate it — or, if the wall is simply too tight for otherwise-healthy work, raise it for one push (PREPUSH_GATE_CHUNK_S) rather than re-pushing into the same cap. No rebase, no --no-verify."
}

# Selection-size threshold for the demotion below (plan 2875): a SUBSET selection at or
# under this many files still runs locally even on an ordinary push — the class the two
# gates' OWN selectors already treat as cheap/targeted (the battery's BATTERY_SMALL_MAX
# further down gates only its LOCK-WAIT length at 5 files, not whether the run happens at
# all). Above this count, or a full/unselectable run, the heavy tier defers instead. 15 is
# chosen comfortably above a single-module change with a couple of direct dependents (the
# battery header's own leaf-delta example is ~2 files) while staying well under a
# hub-module or cross-cutting change (that same header's worked example reaches 58 of ~104
# files; the pytest selector's own 40%-of-tree cap alone would still leave "SUBSET" up to
# ~247 files) — exactly the diff class this plan's own measurement says dominates gate
# time. Overridable like every other PREPUSH_* escape hatch in this hook.
PREPUSH_LOCAL_DEMOTE_MAX_FILES="${PREPUSH_LOCAL_DEMOTE_MAX_FILES:-15}"

# plan 3274 (F2 review fix): the bound for the `battery-ledger.mjs remainder` lookup — a small,
# fast, purely local JSON read under .scratch/gate-ledgers/ — used both inside
# run_battery_with_retry's per-attempt narrowing and in the chunk-report N/M/R derivation further
# down. Before this fix that lookup shelled out with NO time bound at all (every other subprocess
# in this hook goes through run_bounded); a hang there would wedge the WHOLE push — after the
# heavy gates already ran, with no report ever printed to show for it. 60s is comfortably
# generous for what is normally a sub-second lookup. Overridable like every other PREPUSH_*
# escape hatch in this hook, so a test can exercise the real cap-kill path without waiting out
# the production default.
PREPUSH_LEDGER_REMAINDER_CAP_S="${PREPUSH_LEDGER_REMAINDER_CAP_S:-60}"
# plan 3274 (delta-review round, F2): re-validate through the SAME shared
# prepush_validate_positive_int rule PREPUSH_WALL_S/PREPUSH_MIN_CHUNK_S already go through above —
# this value used to be taken as-is straight into run_bounded's own cap argument. Two distinct,
# real consequences of an invalid override reaching run_bounded unvalidated: on the PowerShell-
# wrapper path (`PP_WRAPPER` set — the normal case on a local Windows push) run_bounded computes
# `$((_rb_cap + 300))` on the raw value, so a non-numeric PREPUSH_LEDGER_REMAINDER_CAP_S aborts
# this WHOLE errexit shell via a shell arithmetic error rather than degrading gracefully; on the
# bare-`timeout` path a negative value is read as an option flag, which GNU timeout also rejects,
# but silently — masking a real misconfiguration as an ordinary cap-kill. Falls back to the exact
# default literal just assigned above, so this is a no-op whenever the raw value was already valid
# or unset.
PREPUSH_LEDGER_REMAINDER_CAP_S=$(prepush_validate_positive_int "$PREPUSH_LEDGER_REMAINDER_CAP_S" 60)

# prepush_chunk_round_is_nonconvergent <cliSubcommand> <key> <ranProven 0|1> — plan 3620. Runs
# `node scripts/battery-ledger.mjs <cliSubcommand> --key <key> [--ran-proven]` (chunk-round or
# pytest-chunk-round) bounded by whatever remains of the shared push deadline —
# prepush_derive_attempt_cap over $PREPUSH_LEDGER_REMAINDER_CAP_S, the EXACT cap/derivation the
# pre-existing `remainder` lookup already uses just below (run_battery_with_retry's own per-attempt
# narrowing) and for the identical reason: an unbounded lookup on the exact path that builds the
# chunk report would print no report at all on a hang, wedging the push after the heavy gate
# already ran. Echoes "1" only when that round's own scoreChunkRoundByGreenMark call reported
# `"nonConvergent":true`; "0" on every other outcome, INCLUDING any doubt (a non-zero exit, a
# cap-kill, unparseable output) — the fail-safe direction this whole plan is built on: a missing
# bound must always degrade to the ordinary CHUNKED report, never invent a false NON_CONVERGENT
# that would stop an otherwise-healthy push.
#
# plan 3620 fix round (F1): <ranProven> is THIS caller's own positive evidence that the gate it is
# reporting on actually executed this push (a `collect` event for the pytest seat, a non-empty
# reporter file for the battery seat — see each call site's own comment for how it was captured).
# `--ran-proven` is passed to the CLI only when that value is exactly `1`; anything else (0, empty,
# unset) omits the flag, which scoreChunkRoundByGreenMark treats as unscoreable — never invents
# evidence this function was not itself handed.
#
# No `jq` here (this hook has never depended on one). plan 3620 fix round G3 (findings
# 61b1db/66424a/5d153e/bac162/4027c7): the pre-fix version of this function matched a GLOB against
# the CLI's compact-JSON line itself (`case … in '{"rounds":'*'"nonConvergent":true'*'}')`) and its
# own comment overclaimed that as "validating the full grammar" — it is not: it is a shape/
# substring GUESS, and a stray line elsewhere in captured stdout (a future node warning, a library
# banner) that merely happens to CONTAIN `"nonConvergent":true` would trip it, the wrong fail-safe
# direction for a seam whose entire job is "when in doubt, never invent NON_CONVERGENT". Fixed by
# making the CLI print an unambiguous SENTINEL as its own last line
# (scripts/battery-ledger.mjs's CHUNK_ROUND_NONCONVERGENT_SENTINEL: `PREPUSH_CHUNK_ROUND_NONCONVERGENT=1`
# or `=0`, after the diagnostic JSON line, which the CLI still prints unchanged) and testing THIS
# hook's own capture of that LAST line for EXACT STRING EQUALITY against
# `PREPUSH_CHUNK_ROUND_NONCONVERGENT=1` — no glob, no substring, nothing to parse or overclaim. The
# CLI itself guarantees `=1` is emitted only when its own call genuinely scored the round with
# `ranProven` true AND `nonConvergent` true (see that module's own header) — this function trusts
# that contract rather than re-deriving it from the JSON line a second time.
prepush_chunk_round_is_nonconvergent() {
  _pcr_cli=$1
  _pcr_key=$2
  _pcr_ran_proven=$3
  _pcr_cap=$(prepush_derive_attempt_cap "$PREPUSH_LEDGER_REMAINDER_CAP_S")
  _pcr_ran_proven_flag=""
  [ "$_pcr_ran_proven" = 1 ] && _pcr_ran_proven_flag="--ran-proven"
  # shellcheck disable=SC2086 — $_pcr_ran_proven_flag is either empty or the single literal token
  # "--ran-proven" (assigned above, never caller-controlled text), so unquoted expansion here
  # either vanishes entirely or adds exactly one well-formed flag; it never word-splits data.
  if _pcr_out=$(run_bounded "$_pcr_cap" node scripts/battery-ledger.mjs "$_pcr_cli" --key "$_pcr_key" $_pcr_ran_proven_flag 2>/dev/null); then
    _pcr_last_line=$(printf '%s\n' "$_pcr_out" | tail -n 1)
    if [ "$_pcr_last_line" = "PREPUSH_CHUNK_ROUND_NONCONVERGENT=1" ]; then
      echo 1
      return 0
    fi
  fi
  echo 0
}

# _should_locally_defer <selCount> <fullOverrideFlag> — the ONE LOCAL-push demotion decision the
# pytest gate and the scripts-battery gate below each used to independently re-derive as a
# duplicated inline block (plan 2875 cluster 6, finding 779589): a threshold/platform/force-flag
# change applied to only one copy would silently leave the other gate on the old policy — a future
# retune of PREPUSH_LOCAL_DEMOTE_MAX_FILES (or PP_IS_LOCAL_PUSH's own platform detection) is
# exactly the kind of change that must land in ONE place, not two near-identical ones.
#
# <selCount> is the gate's own selection count using EACH gate's existing convention: 0 means
# "unselectable / full run" (both gates already treat 0 that way — see PYTEST_SEL_COUNT /
# BATTERY_COUNT's own init comments). <fullOverrideFlag> is the gate's own PREPUSH_FULL_* value —
# honoring it LOCALLY, in full, is what keeps that escape hatch meaning what its name says (see the
# battery gate's own comment on this, unchanged in spirit).
#
# Sets $_DEFER (0/1) rather than returning it: POSIX sh functions have no return value beyond an
# exit status, and a command-substitution assignment here would risk the same bare-`VAR=$(…)`
# footgun plan 336 already fixed elsewhere in this hook (an unexpected non-zero would abort the
# whole push under `set -e`). Global on purpose — mirrors every other shared-state helper in this
# file (run_battery_with_retry's RUN_BATTERY_* outputs, battery_outcome_class's echo-based return
# being the one exception because IT never needs multiple output fields).
_should_locally_defer() {
  _sld_count=$1
  _sld_full_override=$2
  _DEFER=0
  if [ "$PP_IS_LOCAL_PUSH" = 1 ] && [ "${_sld_full_override:-0}" != "1" ]; then
    if [ "$_sld_count" -eq 0 ] || [ "$_sld_count" -gt "$PREPUSH_LOCAL_DEMOTE_MAX_FILES" ]; then
      _DEFER=1
    fi
  fi
}

# require_timeout_or_exit <gate-label> — hard-fails the WHOLE push if GNU timeout is
# missing. Call this ONCE per gate, before entering any retry loop around run_bounded
# (PATH doesn't change between attempts — plan 1674's own reasoning for hoisting this
# precondition outside a retry loop, generalized here to every caller). A missing backstop
# layer must not vanish silently — mirrors the pytest-ModuleNotFoundError convention
# elsewhere in this hook (a missing dependency is never a --no-verify situation, since that
# bypasses every OTHER gate too).
require_timeout_or_exit() {
  if ! command -v timeout >/dev/null 2>&1; then
    echo "pre-push: $1 — but GNU 'timeout' is not on PATH. Refusing to run this gate without its outer orphan/hang backstop (the exact bug plan 1674 fixed) — this is a missing-dependency failure, not a test failure. Repair Git for Windows' coreutils (timeout.exe normally at C:\\Program Files\\Git\\usr\\bin\\timeout.exe) or fix PATH ordering, then re-push. Do NOT bypass with --no-verify (that skips every other gate too)." >&2
    exit 1
  fi
}

# run_bounded <capSeconds> <command> [args...] — runs "$@" through the SAME layered bound
# plan 1674 built for the scripts/*.test.mjs battery: scripts/prepush-job-wrapper.ps1
# OUTERMOST when available (kill-on-close Job Object + a parent-handle watch on the hook's
# own sh — the process that actually dies with the push — so a killed push reaps the WHOLE
# spawned tree near-instantly, regardless of which pnpm/python/node subprocess is doing the
# real work) wrapping an INNER GNU `timeout --kill-after=30 <capSeconds>` (the hang cap;
# timeout's own ancestor-death-survival property, which is exactly why it can't be the OUTER
# layer, is neutralized by running inside the wrapper's job — see the battery block's ORPHAN
# BOUND comment below for the full layer-order rationale, unchanged here). Falls back to
# bare GNU timeout when powershell / the wrapper file are unavailable. Caller must call
# require_timeout_or_exit first. Exit status: the wrapped command's own; 124 on cap expiry
# (GNU timeout and the wrapper's TerminateJobObject share that convention on purpose, so a
# caller with its own retry loop needs no new branch for a cap hit vs. a real failure).
run_bounded() {
  _rb_cap=$1
  shift
  if [ -n "$PP_WRAPPER" ]; then
    powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PP_WRAPPER" $((_rb_cap + 300)) timeout --kill-after=30 "$_rb_cap" "$@"
  else
    timeout --kill-after=30 "$_rb_cap" "$@"
  fi
}

# bound_status_class <rawStatus> — echoes the ONE shared classification of a run_bounded
# (or run_bounded_soft) exit status (plan 2523), so cap-expiry legibility is a property of
# run_bounded itself rather than a re-derivation living inside each gate that calls it (the
# pytest gate's own arms — see classify_pytest_failure above, which is the DIFFERENT
# output-signature classifier plan 2510 built — were the only caller of this convention
# before this plan; every gate below now goes through this instead of hand-rolling the same
# 124/137 comparison). Three buckets, per run_bounded's own doc comment above:
#   cap        — 124 or 137: GNU timeout's cap-expiry code, or the wrapper's
#                TerminateJobObject sharing that convention on purpose. The command was
#                KILLED mid-run; nothing about the caller's own pass/fail was ever decided.
#   real       — 1: the ONLY status a caller may treat as an actual verdict from the
#                wrapped command (a vitest/pytest "N failed" exit). Every OTHER caller
#                convention differs (e.g. pytest's own 0-5 range), so a gate that needs
#                finer-grained "real" handling still does its own status check — this
#                helper only tells it "not a cap, not obviously a verdict" via no-verdict.
#   no-verdict — everything else: 125-127 (the runner could not start — a missing
#                timeout/node/python on PATH, or a broken wrapper) and 128+N (death by
#                signal N — 130 Ctrl+C, 143 a SIGTERM outside timeout's --kill-after grace
#                window), plus any status this caller's own tool doesn't define. None of
#                these mean the wrapped command reported a red result.
# $1 = the raw exit status captured the `VAR=$(cmd) || VAR=$?` way (never trust "$?" itself
# past the next statement in errexit shells). Callers with their own richer status taxonomy
# (the pytest gate's 0-5 range) still special-case "real" as exactly 1; this helper's "real"
# bucket exists so a simple caller with no such taxonomy of its own has somewhere to land.
bound_status_class() {
  case "$1" in
    124 | 137) echo cap ;;
    1) echo real ;;
    *) echo no-verdict ;;
  esac
}

# elapsed_since <t0> — echoes the whole-second elapsed time since $1, a `date +%s` epoch
# captured via this hook's standard `_t0=$(date +%s) || _t0=0` guarded idiom. Factors the
# `$(($(date +%s) - _t0))` arithmetic that was hand-copied at 13 start-timer sites / ~30+
# elapsed computations (plan 2579, finding ptz3oa/1awafy2) into the one place beside
# bound_status_class() every gate already calls alongside it.
#
# Guarded like every other `date` call in this hook (sh -e), but the failure must stay VISIBLE
# (review finding 2026-07-28): echoing a clean `0` would sail through gate_outcome's dur_s clamp
# as a normal instant-gate reading and quietly pollute Phase 2's wall-time-share ranking with a
# fabricated number. The pre-extraction inline form `$(($(date +%s) - _t0))` left an EMPTY
# substitution on a failed read, yielding a negative value the clamp's `*[!0-9]*` arm caught and
# rewrote to "unknown" — flagging the broken clock, which is the behavior the clamp exists for.
# So say "unknown" outright: every call site feeds gate_outcome, whose clamp maps it to exactly
# that, and a refactor must not turn a flagged bad reading into a plausible good one.
elapsed_since() {
  _es_t0=$1
  _es_now=$(date +%s) || {
    echo unknown
    return 0
  }
  echo $(( _es_now - _es_t0 ))
}

# battery_outcome_class <lastAttemptStatus> <failedFilesCsv> — the TELEMETRY-side reducer for a
# retried battery gate, deliberately DIFFERENT from what the developer-facing text above does
# (re-review finding, 2026-07-27). The two consumers of a multi-attempt outcome want opposite
# things when the attempts disagree:
#
#   * the DEVELOPER reading the terminal wants the CAUTIOUS reading — never "you broke it" when
#     the machine killed the run — so that text keys on the LAST attempt's status class.
#   * the PHASE-2 PRUNE reading gate-outcome-telemetry.log wants the MOST-INFORMATIVE reading. It
#     asks "has this gate ever caught a real regression?" to decide whether the gate is worth its
#     cost, so a genuine catch must not be discounted just because a later retry got cap-killed
#     under parallel-herd load.
#
# `not ok`-reported files are DIRECT POSITIVE EVIDENCE of a real red, unioned across attempts by
# run_battery_with_retry and independent of any exit status — so evidence DOMINATES status here.
# Without this, attempt-1-real-fail + attempt-2-cap-kill logged `result=cap-kill` while `failed=`
# on the very same line named the regressing test: the log contradicting itself, in exactly the
# field Phase 2 reads to justify deleting tests.
battery_outcome_class() {
  if [ -n "$2" ]; then
    # some attempt rendered a verdict and it was RED — that is a catch, whatever happened after.
    echo fail
    return 0
  fi
  case "$(bound_status_class "$1")" in
    cap) echo cap-kill ;;
    no-verdict) echo no-verdict ;;
    *) echo fail ;;
  esac
}

# run_bounded_soft <capSeconds> <command...> — like run_bounded, but DEGRADES to a bare
# unwrapped invocation (no orphan/hang backstop) instead of require_timeout_or_exit's hard
# block when GNU timeout is unavailable (sonnet-review xhigh finding on plan 1683, batch
# batch-2026-07-10-coord-spine6, 2026-07-11). Reserved for gates whose own body already
# fast-no-ops on an irrelevant diff INSIDE the wrapped command itself (this hook has no
# cheap shell-side way to predict that in advance) — every other run_bounded call site
# below is preceded by a shell-level grep that already filters to the relevant diff, so
# only the mobile gate (relevance check lives inside verify-mobile-gate.mjs) needs this.
# A hard require_timeout_or_exit here would block even a docs-only master push whenever
# `timeout` drops off PATH, regressing a push that previously succeeded in ~50ms.
run_bounded_soft() {
  if command -v timeout >/dev/null 2>&1; then
    run_bounded "$@"
  else
    _rbs_cap=$1
    shift
    echo "pre-push: GNU 'timeout' is not on PATH — running without an orphan/hang backstop (a mobile-relevant push here could orphan a dev server/WebKit tree if the push is killed; a no-op push is unaffected either way). Repair Git for Windows' coreutils or fix PATH ordering when convenient." >&2
    "$@"
  fi
}

# plan 3223: fold ONE attempt's newly-proven-green files (harvested by battery-ledger-reporter.mjs
# into its own per-attempt destination file, $_rbr_ledgerfile) into the persistent, content-keyed
# ledger scripts/battery-ledger.mjs maintains under .scratch/gate-ledgers/. Called from BOTH the
# success branch and the failure branch of run_battery_with_retry's attempt loop below — a
# successful attempt is the COMMON case, and merging only on failure would mean the ledger never
# recorded the plain "everything passed" run a later re-push under unchanged content most needs to
# resume from. Best-effort, `|| true`'d internally (mirrors every other close-out call in this
# hook): a ledger write must never fail a push whose battery verdict is otherwise already decided.
# No-op when ledger participation never activated for this call ($_rbr_ledger_key empty — see the
# RBR_LEDGER opt-in at run_battery_with_retry's own top) or the destination file was never created
# (nothing reached node --test, or the reporter flushed nothing before a kill).
_rbr_merge_ledger() {
  if [ -n "$_rbr_ledger_key" ] && [ -n "$_rbr_ledgerfile" ] && [ -f "$_rbr_ledgerfile" ]; then
    # plan 3274 (land round, sibling of the CONFIRMED d97786 trap finding): bounded for the
    # SAME reason the EXIT-trap merges are, and more urgently — this one runs in the MAIN
    # battery flow, so a wedged node here blocks the push itself past the shared wall rather
    # than only delaying an exit. Same cap and same soft runner: a missing `timeout` binary
    # must degrade to today's unbounded call, never abort a close-out that is already `|| true`'d.
    #
    # plan 3620 fix round G1 (findings 21e465/ae339b) — SUPERSEDED this fix round, see H1 below:
    # that round captured the merge's own exit STATUS instead of discarding it with a bare
    # `|| true`. It did not work: `battery-ledger.mjs merge` CATCHES its own fs write failures and
    # ALWAYS exits 0 (its documented "never blocks" contract — see that module's own header), so
    # checking the exit status here proved nothing — a merge whose ledger write genuinely THREW
    # still read as "succeeded", and ran-proven would still be set from a round that banked zero
    # of its proof, marching toward a false GATE_NON_CONVERGENT exactly as G1 itself warned against.
    #
    # plan 3620 fix round (H1, findings de4f6d/8138ba/12003b/e7afab/54a2bd/a850c6/6991ad/7fae55/
    # 14b7eb): the CLI now prints its own PERSISTENCE as the LAST stdout line
    # (`MERGE_PERSISTED=1`/`=0` — scripts/battery-ledger.mjs's own module header documents the
    # exact contract), captured here instead of redirected to /dev/null, and tested for EXACT
    # STRING EQUALITY — the same "print an unambiguous sentinel, test it by string equality"
    # discipline prepush_chunk_round_is_nonconvergent's own PREPUSH_CHUNK_ROUND_NONCONVERGENT
    # sentinel already uses (G3, further below). `|| _rbr_merge_out=""` guards the SAME `sh -e`
    # bare-assignment hazard `run_bounded`/`run_bounded_soft`'s other callers already guard against
    # (a cap-kill's non-zero status would otherwise abort the whole push right here): on any doubt
    # about the call itself (cap-killed, wedged node) the captured output is simply empty, which
    # can never equal the sentinel — degrading to the SAME fail-safe "ran-proven stays unset" this
    # block has always used.
    _rbr_merge_out=$(run_bounded_soft "$PP_LEDGER_SALVAGE_CAP_S" node scripts/battery-ledger.mjs merge --key "$_rbr_ledger_key" --file "$_rbr_ledgerfile" 2>/dev/null) || _rbr_merge_out=""
    _rbr_merge_persisted=$(printf '%s\n' "$_rbr_merge_out" | tail -n 1)
    # plan 3620 fix round G2 (findings 7db544/59a79d/276d88/b26033/d7e34f/a9a364): ran-proven
    # evidence is now "at least one COMPLETE event", not merely "non-empty bytes" — `[ -s
    # "$_rbr_ledgerfile" ]` (the pre-fix check) accepts a file cut off mid-write, which is
    # non-empty yet proves nothing actually completed. `battery-ledger.mjs events-count` reuses
    # this module's own truncation-safe JSONL reader (parseTruncationSafeJsonLines) instead of a
    # second, weaker heuristic re-derived in shell. Gated on `[ "$PREPUSH_CHUNK_MODE" = 1 ]`: the
    # non-convergence bound is only ever CONSULTED in chunk mode (prepush_chunk_round_is_nonconvergent's
    # own call sites, far below), so spawning this extra process on an ordinary non-chunked push
    # would be pure waste. Exposed as the caller-visible RUN_BATTERY_RAN_PROVEN return value
    # (mirrors RUN_BATTERY_OK/_STATUS/_LAST_CAP, all set the same globals-as-return-values way
    # immediately above this function), read by the scripts-battery gate's own chunk-report seat
    # far below — this function's caller runs it un-subshelled on both call sites, so the
    # assignment survives past the retry loop.
    if [ "$PREPUSH_CHUNK_MODE" = 1 ] && [ "$_rbr_merge_persisted" = "MERGE_PERSISTED=1" ]; then
      _rbr_ev_cap=$(prepush_derive_attempt_cap "$PREPUSH_LEDGER_REMAINDER_CAP_S")
      _rbr_ev_count=$(run_bounded "$_rbr_ev_cap" node scripts/battery-ledger.mjs events-count --file "$_rbr_ledgerfile" 2>/dev/null) || _rbr_ev_count=""
      case "$_rbr_ev_count" in
        '' | *[!0-9]*) _rbr_ev_count=0 ;;
      esac
      [ "$_rbr_ev_count" -gt 0 ] && RUN_BATTERY_RAN_PROVEN=1
    fi
  fi
  # plan 336 class of bug (re-introduced by this fix round, caught in testing): this function is
  # called BARE at both its call sites (never `|| true`'d, never inside an if/&&/||) — under
  # `sh -e`, a function's own exit status is the exit status of the LAST command it executed, and
  # `[ "$_rbr_ev_count" -gt 0 ] && RUN_BATTERY_RAN_PROVEN=1` exits 1 (silently, no error text)
  # whenever the count is 0 — the ordinary case on the fake-harness-driven test suite, and for real
  # on any push whose reporter genuinely proved nothing this attempt. Without this explicit
  # `return 0`, THAT would abort the whole push right here, with no diagnostic at all — the exact
  # silent-herd-failure class plan 336 exists to prevent. Always exits 0; this function is
  # close-out bookkeeping (see its own header) and must never affect the push's own outcome.
  return 0
}

# run_battery_with_retry <label> <capSeconds> <concArgs> <test-file...> — the ONE
# implementation of "run `node --test` over these test files in a clean git env, with
# plan-984 retry-once semantics, orphan/hang-bounded by run_bounded". BOTH battery gates
# below call it: the scripts/*.mjs import-closure battery and the plan-2070
# data-dependency trigger. Before plan 2176 the second was a hand-copy of the first's
# ~50-line attempt/ok/status/retry/clean-env shape, so a retry-policy change (e.g. a third
# GIT_* var joining the unset list below) had to be found and applied twice by hand.
#
# Result is reported in $RUN_BATTERY_OK (1 green / 0 red after BOTH attempts), NOT an exit
# status: the callers run under `sh -e` and branch on the result later (the scripts caller
# ORs it with a pass-cache hit and releases its mutex first), so a non-zero *return* would
# abort the hook before either could. $3 (concArgs) and the test-file arguments are
# expanded UNQUOTED at the CALL SITE, so a selected list word-splits and a defaulted
# literal glob pathname-expands into "$@" before the function ever sees them — the exact
# shape the two inline loops had.
#
# CRITICAL — run node --test in a CLEAN git env (subshell `unset`). git exports
# GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE into every hook subprocess, and those
# env vars OVERRIDE a child `git -C <tmpdir>` repo selection. Several suite tests
# (coord-git/pre-yield/sweep) spin up throwaway temp repos and run `git config
# user.name` + `git commit` in them; inherited from the hook env, those calls hit
# THIS repo instead — corrupting the shared user.name to the test fixture identity
# and committing junk onto the branch (proven 2026-06-04, plan 338 dogfood). The
# offending test helpers also strip these now (defence in depth), but clearing
# them here protects the WHOLE suite regardless of any not-yet-hardened test. The
# `unset` is scoped to the subshell so the rest of the hook keeps git's env.
#
# RETRY-ONCE (plan 984) — the suite drives REAL git in throwaway temp repos: coordWrite's
# "two concurrent writers" race spawns two OS processes, several tests fire lock-removers on
# timers, and a single coordWrite test is ~13s — the real driver is Windows process-spawn
# overhead (hundreds of real git.exe spawns at ~100-200ms each), NOT AV scanning: an EICAR
# probe verified 2026-07-27 (plan 2530) that both the battery's temp-repo path and the repo
# itself are Defender-excluded. Under the 5-7
# session parallel herd hammering the shared .git, a timing-sensitive assertion can load-flake —
# and a NO-retry gate then rejects an otherwise-clean push (plan 980 land, 2026-06-22: full suite
# green in isolation, 1052/1052, but a `diff: 'simple'` assertion flaked under peak load). Mirror
# the backend vitest gate's --retry=2 (plan 941, full suite ~25s): re-run the WHOLE selection ONCE
# on failure. A genuine regression is deterministic and fails the re-run too (push still blocks); a
# load-flake clears on the quieter second pass. node:test has no --test-retries flag (verified on
# node 24 — `bad option`; --test-rerun-failures is a different prior-state feature, not auto-retry),
# so the retry is a manual loop. Manual `pnpm test` / a direct `node --test` stay STRICT (no retry)
# so a real regression still surfaces loudly in dev — only the GATE absorbs the flake, the same
# split the backend uses. `if ( subshell ); then` keeps the clean-git-env unset in ONE place and is
# errexit-safe (the subshell runs as an `if` condition → -e suspended; the loop tests its status).
#
# plan 3235 (review round): shared timeout-detection helper for run_battery_with_retry's two
# diagnostic branches below (the ATTEMPT-1 failure message AND the final-attempt re-run failure
# message). A per-test --test-timeout expiry reports through node:test's OWN "real" 1-exit
# convention — the SAME status an ordinary assertion failure uses — so either branch, checked in
# isolation, cannot otherwise tell a genuine hang apart from herd load-flake / a real regression.
# Before this helper existed, only the final-attempt branch ran this check, so a hang's first
# signal to the operator (attempt 1's own echo) always read as load-flake, a whole retry attempt
# before the correct diagnosis could surface. Node's TAP marks the shape unambiguously —
# `failureType: 'testTimeoutFailure'` / `error: 'test timed out after <n>ms'` — matched against the
# SAME per-attempt tapfile both call sites already hold in scope ($_rbr_tapfile, not yet removed at
# either point in the loop). Returns 0 (true) iff $1 names a readable TAP file containing that
# diagnostic; 1 for "no timeout signature", "file missing", or "no path given" — an empty/unset $1
# must not read stdin or otherwise be mistaken for a pass.
_rbr_tapfile_shows_timeout() {
  [ -n "$1" ] && [ -f "$1" ] || return 1
  grep -qE "testTimeoutFailure|test timed out after" "$1" 2>/dev/null
}

# plan 3242: the per-TEST timeout the battery runs under, defined ONCE for the whole shell side.
# Before this, the number was hand-copied at four places in this file (the real invocation site and
# three operator-facing diagnostic strings), so a re-derivation had to find all four or leave the
# messages quoting a cap the gate no longer applies. The JS side carries the twin definition —
# BATTERY_TEST_TIMEOUT_MS in the JS-side nightly-suite module, which is where the measured
# rationale for the VALUE lives (read it before changing this number; a shell variable and a JS
# constant cannot share one literal, so the two are drift-pinned to the same number by
# a battery-cap test). Deliberately NOT `${BATTERY_TEST_TIMEOUT_MS:-900000}`:
# this is a safety cap that turns an infinite hang into a bounded red, and an env knob on it is an
# env knob for switching the backstop off on the one push that needed it.
BATTERY_TEST_TIMEOUT_MS=900000
run_battery_with_retry() {
  _rbr_label=$1
  _rbr_cap=$2
  _rbr_conc=$3
  shift 3
  _rbr_attempt=1
  RUN_BATTERY_OK=0
  # review finding 1kp7gg8: the raw exit status of the LAST attempt, exposed alongside
  # RUN_BATTERY_OK so a failing caller can classify cap-vs-real via bound_status_class()
  # instead of always logging a hard "fail" (a cap-kill on the final attempt is not a
  # genuine regression). Only meaningful when RUN_BATTERY_OK=0 — a successful attempt
  # breaks out of the loop before touching it, same as $_rbr_status itself.
  RUN_BATTERY_STATUS=0
  # plan 3274 (F3 fix): the ACTUAL cap $_rbr_cap held for the LAST attempt this call made — set
  # each time the per-attempt cap re-derivation below runs, so it survives the loop as whatever
  # value the final attempt was really bounded by (F2's per-attempt shrink). The caller compares
  # this against ITS OWN remembered natural (pre-chunk) cap to decide whether a cap-kill here was
  # genuinely caused by OUR chunk deadline (reclassify to "chunked") or by the gate's own natural
  # cap firing first/simultaneously (a real cap-kill — see chunkCapDecision's usingChunkCap in
  # done-worktree.mjs, whose "only reclassify when STRICTLY binding" semantics this mirrors).
  # Defaults to $2 unchanged: with chunking off, or if the loop body never runs (an already-fully-
  # ledger-proven remainder), the caller's own natural-cap comparison then correctly finds nothing
  # strictly smaller and never reclassifies.
  RUN_BATTERY_LAST_CAP=$_rbr_cap
  # plan 2530: `not ok`-reported test-file basenames (comma-joined, empty on a green run or
  # when no attempt ever produced a parseable capture) — the gate-outcome telemetry's failed=
  # field, the piece the Phase 2 cost-weighted prune actually needs (which tests have EVER
  # failed, not just which ran). review finding 16fw12j: MERGED (union, deduped) across
  # attempts, not overwritten — a real attempt-1 failure must survive an attempt-2 cap-kill
  # (whose truncated log yields nothing), or the concrete regression evidence is lost and
  # telemetry logs failed= empty for a run that DID fail concretely.
  RUN_BATTERY_FAILED_FILES=""
  # plan 2734 (arm D): a battery-lock token this function acquired for the RE-RUN of an
  # unserialized run — see the RBR_RERUN_LOCK block at the bottom of the loop. Initialised per call
  # so a token can never leak from one gate's invocation into another's release step. The CALLER
  # releases it (the scripts-battery gate does, right beside its own token).
  RUN_BATTERY_RERUN_TOKEN=""
  # plan 3223 (review round: finding 2/CONFIRMED): the set of files THIS call ACTUALLY EXECUTED
  # via a real `node --test` invocation — the union of "$@" as narrowed for each attempt that
  # actually ran, NOT the caller's original selection. See the assignment at the top of the loop
  # body below for why this must be narrower than the original selection whenever the ledger
  # subtracts already-proven files, and plan 2070's own "ran+passed, not merely selected" contract
  # (scripts/hooks/pre-push.sh's data-dependency gate) for why the distinction is load-bearing.
  RUN_BATTERY_RAN_FILES=""
  # plan 3620 fix round (F1): this call's own ran-proven evidence — 0 (no evidence) until
  # _rbr_merge_ledger sees a non-empty per-attempt reporter file for SOME attempt (set 1, never
  # cleared back to 0 by a later attempt — one attempt actually running the gate is enough
  # evidence for the whole call, even if a subsequent attempt's own reporter file comes up empty).
  # See _rbr_merge_ledger's own comment for the "empty file is not evidence" reasoning.
  RUN_BATTERY_RAN_PROVEN=0
  # plan 3223 — per-file green ledger, OPT-IN via RBR_LEDGER (mirrors RBR_RERUN_LOCK's own
  # opt-in shape immediately below: set ONLY by the scripts-battery gate's call site, left unset
  # by the data-dependency gate's call — so THAT caller's behaviour stays byte-identical, per the
  # plan's E3).
  #
  # plan 3223 (review round: finding 8/CONFIRMED): the key is NOT re-derived here any more — it is
  # threaded in by the CALLER via RBR_LEDGER_KEY, the SAME content key the scripts-battery gate's
  # own battery-pass-cache.mjs `check` call already computed moments earlier ($BATTERY_CACHE_KEY —
  # both that call and `battery-ledger.mjs key` resolve through the identical `deriveKey`, so
  # re-deriving here paid an entire second multi-subprocess git-state-gathering pass (`git status
  # --porcelain`, a recursive `git ls-tree -r` over ~350 scripts/ blobs, `git merge-base`, `git diff
  # --name-only`, per-file content reads) for an answer that was already sitting in a variable —
  # and, worse, risked landing a DIFFERENT key than the pass-cache's own on a tree that changed
  # between the two derivations (the exact race runPytestPreflightCached's own header comment in
  # done-worktree.mjs already names for the pytest half of this same plan). Every failure/absence
  # here (RBR_LEDGER unset, no RBR_LEDGER_KEY supplied, a malformed key) degrades to "ledger
  # unavailable this run" — $_rbr_ledger_key stays empty and every ledger-gated block below no-ops
  # to exactly today's behavior (pass-cache-kernel.mjs's documented fail direction: MISS/error ⇒
  # run everything, never the reverse). The key is VALIDATED here (32 lowercase hex chars,
  # battery-pass-cache.mjs's own computeKey shape) rather than trusted blindly — belt-and-suspenders
  # against a caller ever handing this function a malformed value.
  _rbr_ledger_key=""
  _rbr_original_selection=$(printf '%s\n' "$@")
  if [ "${RBR_LEDGER:-0}" = 1 ]; then
    _rbr_ledger_key="${RBR_LEDGER_KEY:-}"
    case "$_rbr_ledger_key" in
      *[!0-9a-f]*) _rbr_ledger_key="" ;;
    esac
    [ "${#_rbr_ledger_key}" = 32 ] || _rbr_ledger_key=""
    # plan 3223 (re-review finding A/PLAUSIBLE): the key's SHAPE alone proves nothing about
    # whether it was actually derived from THIS call's selection — a future edit that reassigns
    # $BATTERY_FILES between the caller's key derivation and this call (or a second RBR_LEDGER=1
    # call site copying the pattern with an unrelated selection) would otherwise silently apply an
    # unrelated key's "already green" verdict here, skipping files the key's evidence never
    # covered. Re-establish the key<->selection tie WITHOUT reintroducing the second
    # `battery-ledger.mjs key` subprocess derivation finding 8/CONFIRMED (above) removed: the
    # caller threads through RBR_LEDGER_SELECTION — the EXACT raw string it fed
    # `battery-pass-cache.mjs check` to derive RBR_LEDGER_KEY, captured at that same instant (see
    # the scripts-battery gate's own BATTERY_CACHE_KEY_SELECTION capture). Re-expanding that raw
    # string here, inside its own command-substitution subshell (so the `set --` can never
    # clobber this function's own "$@"), applies the IDENTICAL word-splitting/globbing the call
    # site's unquoted $BATTERY_FILES expansion underwent to build "$@" — so comparing the result
    # against $_rbr_original_selection answers "does the raw string the key was derived from
    # still expand to exactly the file list this call received" without spawning anything
    # heavier than a shell fork. Any mismatch — including RBR_LEDGER_SELECTION never having been
    # supplied at all — fails to "ledger off, run everything" for THIS call, never "trust the
    # key".
    if [ -n "$_rbr_ledger_key" ]; then
      _rbr_ledger_selection_raw="${RBR_LEDGER_SELECTION:-}"
      if [ -z "$_rbr_ledger_selection_raw" ]; then
        _rbr_ledger_key=""
      else
        _rbr_ledger_selection_expanded=$(set -- $_rbr_ledger_selection_raw; printf '%s\n' "$@")
        if [ "$_rbr_ledger_selection_expanded" != "$_rbr_original_selection" ]; then
          echo "pre-push: $_rbr_label ledger — RBR_LEDGER_KEY's selection does not match this call's own selection; disabling ledger participation for this call (running everything)" >&2
          _rbr_ledger_key=""
        fi
      fi
    fi
  fi
  while [ "$_rbr_attempt" -le 2 ]; do
    # Recompute the remainder BEFORE every attempt (not just attempt 2 — E2's own requirement,
    # generalized): a file already proven green under this exact key from a PRIOR push (a
    # cap-killed run's progress surviving a same-content re-push) is subtracted before attempt 1
    # even starts, and a file this run's own earlier attempt just proved green (via the
    # _rbr_merge_ledger call at the bottom of each attempt, below) is subtracted before the next
    # one. A remainder that comes back EMPTY means every file in the ORIGINAL selection already
    # proved green under this key — stop here rather than invoke `node --test` with a now-empty
    # file list, which would silently fall back to node's own auto-discovery (an unbounded,
    # DIFFERENT selection) instead of correctly running "nothing".
    if [ -n "$_rbr_ledger_key" ]; then
      # plan 3274 (F2 review fix): bounded via run_bounded, like every other subprocess in this
      # hook — an unbounded hang here would wedge the WHOLE push mid-retry-loop, after attempt 1
      # already ran the real gate, with no report ever printed to show for it. The existing `||`
      # fallback already degrades gracefully on ANY failure (cap-kill included): treat the ledger
      # as unavailable this attempt and run the full selection — losing the narrowing is
      # cosmetic, losing the push is not.
      # plan 3274 (delta-review round, F4): clamp THIS lookup's own cap to whatever remains of the
      # shared chunk deadline too, via the same prepush_derive_attempt_cap the battery retry loop
      # itself uses for $_rbr_cap just below — otherwise a full PREPUSH_LEDGER_REMAINDER_CAP_S
      # (default 60s) could run well past the point the whole push was already supposed to have
      # stopped. A no-op when chunking is off (byte-identical local behavior).
      _rbr_ledger_cap=$(prepush_derive_attempt_cap "$PREPUSH_LEDGER_REMAINDER_CAP_S")
      _rbr_remainder=$(printf '%s\n' "$_rbr_original_selection" | run_bounded "$_rbr_ledger_cap" node scripts/battery-ledger.mjs remainder --key "$_rbr_ledger_key" 2>/dev/null) || _rbr_remainder="$_rbr_original_selection"
      if [ -z "$_rbr_remainder" ]; then
        RUN_BATTERY_OK=1
        echo "pre-push: $_rbr_label ledger — every file in this selection already proved green under this content key (a prior attempt or a prior push); nothing left to run"
        break
      fi
      set -- $_rbr_remainder
    fi
    # plan 3223 (review round: finding 2/CONFIRMED): record the files THIS attempt is actually
    # about to hand to `node --test` — "$@" as finalized above, AFTER any ledger narrowing —
    # unioned (deduped) across attempts into RUN_BATTERY_RAN_FILES. Ledger participation off
    # (_rbr_ledger_key empty) leaves "$@" exactly $_rbr_original_selection every attempt, so
    # RUN_BATTERY_RAN_FILES degrades to exactly $BATTERY_FILES — today's behavior, unchanged. With
    # the ledger active, a file the remainder subtracted (already proven green) never reaches this
    # line for THIS attempt, so it is correctly absent from the union unless a LATER attempt's own
    # narrower remainder still includes it (it never does — remainder only shrinks). This is what
    # the caller must publish as "ran+passed" to plan 2070's --exclude-ran, not the original
    # selection: see BATTERY_RAN_FILES's own assignment below.
    _rbr_attempt_selection=$(printf '%s\n' "$@")
    if [ -n "$_rbr_attempt_selection" ]; then
      if [ -n "$RUN_BATTERY_RAN_FILES" ]; then
        RUN_BATTERY_RAN_FILES=$(printf '%s\n%s\n' "$RUN_BATTERY_RAN_FILES" "$_rbr_attempt_selection" | sort -u)
      else
        RUN_BATTERY_RAN_FILES="$_rbr_attempt_selection"
      fi
    fi
    _rbr_status=0
    # plan 2530 / review finding 1afign8: capture node --test's combined output to a tempfile
    # via `tee` INSIDE the same clean-git-env subshell (never a second one — a second subshell
    # would re-lose the exit status the `if ( … )` below tests) so operator-visible output stays
    # LIVE — a 7-10 min battery with nothing printing reads as a hung push on a machine
    # documented as running 5-7 parallel sessions and invites a mid-flight Ctrl+C. `tee`'s own
    # exit status is not what matters here (`sh -e` pipelines report the LAST command's status,
    # which would be tee's, always ~0) — the status-file trick below captures run_bounded's real
    # status from INSIDE the pipe's first stage, written to a file, then read back after the
    # pipe completes. A real `mktemp` failure falls back to a deterministic $$-scoped path under
    # TMPDIR (never a second, textually-duplicated `run_bounded … node --test …` invocation —
    # plan 2176 pins exactly one copy of that line so a future retry-policy change can never
    # drift between two call shapes) — if THAT path is also unwritable the redirect itself fails
    # and the subshell aborts before node ever runs, which the outer retry loop treats as an
    # ordinary failed attempt. A missing/unreadable status file falls back to status 1 (treated
    # as a failed attempt) rather than silently reporting success.
    _rbr_outfile=$(mktemp 2>/dev/null) || _rbr_outfile="${TMPDIR:-/tmp}/prepush-battery-$$-$_rbr_attempt"
    _rbr_statusfile=$(mktemp 2>/dev/null) || _rbr_statusfile="${TMPDIR:-/tmp}/prepush-battery-status-$$-$_rbr_attempt"
    # plan 2875: a SECOND, machine-readable reporter destination for the not-ok harvest below —
    # see that harvest's own comment for why $_rbr_outfile (the developer-visible stream) was
    # never usable for this and never will be.
    _rbr_tapfile=$(mktemp 2>/dev/null) || _rbr_tapfile="${TMPDIR:-/tmp}/prepush-battery-tap-$$-$_rbr_attempt"
    # plan 3223: a THIRD destination, only ever created when ledger participation is active for
    # this call — the data-dependency gate (RBR_LEDGER unset, $_rbr_ledger_key empty) never pays
    # even the mktemp for this, keeping that caller's behaviour untouched down to "no extra
    # tempfile churn", not merely "no extra reporter flag".
    _rbr_ledgerfile=""
    if [ -n "$_rbr_ledger_key" ]; then
      _rbr_ledgerfile=$(mktemp 2>/dev/null) || _rbr_ledgerfile="${TMPDIR:-/tmp}/prepush-battery-ledger-$$-$_rbr_attempt"
    fi
    # plan 3223 (scoped fix round): the THIRD reporter's CLI args, built ONCE per attempt HERE —
    # never inside the `( … )` subshell below — so it is plain data by the time that subshell
    # reads it, mirroring $_rbr_ledgerfile's own placement immediately above. Empty unless ledger
    # participation is active for this call; see the invocation line below for why this rides as
    # a real CLI argument pair rather than NODE_OPTIONS.
    _rbr_ledger_reporter_args=""
    if [ -n "$_rbr_ledger_key" ]; then
      _rbr_ledger_reporter_args="--test-reporter=./scripts/battery-ledger-reporter.mjs --test-reporter-destination=$_rbr_ledgerfile"
    fi
    # plan 3274 (F2 fix, review round): re-derive the cap from whatever's LEFT of the shared
    # deadline immediately before EVERY attempt, not just once at the call site. Before this fix,
    # $_rbr_cap was fixed at function entry (from $2) and reused UNCHANGED for attempt 2's
    # re-run — so a gate that spent its whole cap on a cap-killed attempt 1 was simply handed the
    # same full cap again for attempt 2, letting this ONE gate alone consume roughly DOUBLE its
    # allotted share of the cross-gate push deadline (the same class of bug the JS-side land
    # preflight's own per-call-vs-per-process deadline fix already corrected — see
    # chunkCapDecision in done-worktree.mjs). Reassigns $_rbr_cap itself in place (via
    # prepush_derive_attempt_cap, F3 review-round extraction — see that function's own header),
    # specifically so the pinned run_bounded invocation below — $_rbr_cap feeding node's --test
    # run — and its own cap-hit echo (both asserted on byte-for-byte by
    # the battery-cap test) stay untouched — only the VALUE $_rbr_cap holds at
    # this point in the loop shrinks,
    # monotonically, as wall-clock time passes; it can never grow back on attempt 2, matching the
    # deadline itself. A no-op whenever chunking is off ($PREPUSH_CHUNK_MODE != 1): the caller's
    # original per-call cap is never read or touched, so every existing non-chunked
    # budget/message/exit-code stays byte-identical (the drift-pin test above this file's own
    # header covers this).
    _rbr_cap=$(prepush_derive_attempt_cap "$_rbr_cap")
    # F3: publish whatever $_rbr_cap holds for THIS attempt — see RUN_BATTERY_LAST_CAP's own
    # init comment above for why the caller needs this (never the original, unshrunk $2).
    RUN_BATTERY_LAST_CAP=$_rbr_cap
    if (
         unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR GIT_NAMESPACE
         # plan 1674 dogfood: NODE_TEST_CONTEXT=child-v8, if ever inherited from an outer
         # node:test process, makes this NESTED `node --test` mistake itself for that
         # outer runner's IPC child and silently report success without running anything
         # — unset it defensively alongside the git env vars above.
         unset NODE_TEST_CONTEXT
         # plan-1731 review finding 1: the scripts battery's own scripts/*.test.mjs suite
         # includes push-telemetry-lib.test.mjs, whose tests call markPushTelemetryHit
         # directly. If COORD_PUSH_TELEMETRY_HITS_FILE were inherited here (this hook
         # exported it earlier in THIS SAME push), a test exercising the function's
         # process.env-default path would append a stray marker into the REAL, LIVE
         # hits file this very push is using — corrupting its own telemetry line with a
         # false hit. Unset it defensively for this subshell (belt-and-suspenders on top
         # of every test in that file now passing an explicit env object — see its
         # header) so no test in the battery, present or future, can ever touch it.
         unset COORD_PUSH_TELEMETRY_HITS_FILE
         # plan 1715: the layered bound is the shared run_bounded() (job wrapper OUTERMOST at
         # cap+300s, inner GNU `timeout --kill-after=30 <cap>`; layer-order rationale + fallback
         # shape live with run_bounded's definition above and the ORPHAN BOUND comment on the
         # scripts-battery gate below). $_rbr_conc stays UNQUOTED so an empty clamp vanishes
         # instead of becoming an empty argv element (node option flags must precede the
         # positional test paths). run_bounded is a shell function and is inherited by this
         # ( ) subshell.
         # plan 2875: two EXPLICIT `--test-reporter`/`--test-reporter-destination` pairs, not
         # node's bare default. Node's own default reporter selection (spec on a TTY, otherwise —
         # supposedly — tap) turned out to no longer hold on the Node this hook actually runs
         # under: measured live, `node --test` piped through `tee` (a non-TTY stdout, exactly this
         # shape) still renders the human-friendly SPEC format, not TAP — so the harvest below,
         # which has always assumed a TAP stream, silently matched nothing on every single run
         # since it was written (`failed=` has never once appeared in gate-outcome-telemetry.log).
         # Rather than gamble on a future Node version's default again, both formats are now
         # requested explicitly and unconditionally: `spec` to stdout is BYTE-IDENTICAL to what a
         # developer has always seen here (this is pinning today's already-observed behavior, not
         # changing it), and `tap` goes to its own dedicated tempfile purely for the harvest below
         # to read — the developer-visible stream is untouched.
         #
         # plan 3223 (scoped fix round): the THIRD reporter (battery-ledger-reporter.mjs, ledger
         # participation only) rides in as a THIRD `--test-reporter`/`--test-reporter-destination`
         # pair on THIS invocation line, via $_rbr_ledger_reporter_args (built just above the loop
         # that reaches here) — NOT via NODE_OPTIONS. An earlier version of this fix used
         # NODE_OPTIONS specifically to dodge the byte-exact pin this file's own name-paired test's
         # "review finding 1afign8" case holds on this line; that dodge was itself the bug.
         # NODE_OPTIONS is a Node-wide env var — it is inherited by every `node` child THIS
         # battery's OWN tests spawn, and two scripts-battery files
         # (battery-flake-harness.test.mjs, pre-push-battery-cap.test.mjs) spawn a NESTED `node
         # --test` against a throwaway fixture directory as part of their own test bodies. That
         # nested `node --test` would inherit `--test-reporter=./scripts/battery-ledger-
         # reporter.mjs` from NODE_OPTIONS too, and the relative `./…` specifier resolves against
         # the CHILD's cwd (the fixture dir), not the repo root: ERR_MODULE_NOT_FOUND, verified
         # live on node v22.22.2 (a plain `node -e` child ignores the inherited flags harmlessly,
         # but `node --test` does not) — so the scripts battery itself would go red under the
         # NODE_OPTIONS route. Passing the pair as a CLI argument instead means only the
         # TOP-LEVEL `node --test` invocation below ever sees it; a nested child's own argv
         # carries none of its parent's flags, NODE_OPTIONS or otherwise. The "review finding
         # 1afign8" pin is updated in the same plan to admit this pair (see that test's own
         # comment) rather than loosened into a wildcard.
         # $_rbr_ledger_reporter_args stays UNQUOTED here so an empty value (ledger participation
         # inactive for this call) vanishes instead of becoming an empty argv element — the same
         # idiom $_rbr_conc already uses on this exact line. Placed BEFORE $_rbr_conc (not after)
         # so the trailing `$_rbr_conc "$@"` adjacency stays byte-for-byte intact for the OTHER,
         # out-of-scope pins that assert on it (its own battery-cap test and
         # the battery-lock test's own drift guards) — inserting anything between those
         # two tokens would break both without a matching plan to touch either file. A relative
         # `./scripts/...` path (not bare `scripts/...`) is load-bearing in
         # $_rbr_ledger_reporter_args's assignment above: node's `--test-reporter` specifier
         # resolution treats a bare relative path as a package-name lookup and fails with
         # ERR_MODULE_NOT_FOUND (verified) unless it starts with `./`/`../` or is absolute; this
         # hook always runs with cwd = the repo root, matching every other `node scripts/…mjs`
         # call in this file.
         # plan 3235: `node --test` applies NO per-test timeout by default (the flag defaults to
         # zero, meaning unbounded),
         # so a single test awaiting an event that already fired parks the whole battery at zero
         # CPU forever — measured 87 silent minutes during the plan 3211 land, holding a
         # test-queue slot the whole time, with no failing test and no output. The cap (15 min per
         # TEST, not per file) bounds that class to a red naming the culprit instead of an infinite
         # hang. No longer PROVISIONAL: plan 3242 measured the real target distribution — this local
         # Windows checkout under parallel-session load — and the sizing rule it applied resolved to
         # KEEPING 15 min, because the slowest legitimate test swung 5.1× with machine contention
         # (102.9s → 528.9s for the same test). The value itself now lives in ONE place per language:
         # $BATTERY_TEST_TIMEOUT_MS above for this file, BATTERY_TEST_TIMEOUT_MS in
         # the JS-side nightly-suite module for the JS side, which carries the full rationale.
         # Placed immediately after `--test`, never between `$_rbr_conc` and `"$@"` (see the
         # adjacency comment above) so the two out-of-scope pins that assert on that trailing
         # adjacency stay intact.
         # --test-force-exit is REQUIRED for --test-timeout to actually end the run, and is not a
         # tuning knob: the cap cancels the hung TEST and prints node's own "test timed out after
         # …ms" diagnostic, but the runner then waits for the event loop to drain — and a test hung
         # on an active handle (a live timer/socket, which is what a real hang looks like) never
         # drains, so the process sits there reporting nothing further, forever. Measured on this
         # machine (node v24.14.1): without the flag a 1500ms-capped hang ran until an external
         # 25s kill; with it, exit 1 at 1686ms carrying the same diagnostic. The plan-3235 guard
         # test below proves exactly this, and it is why that guard failed every local land until
         # this flag was added. Verified NOT to truncate output: 60 files / 2400 tests with piped
         # stdout and a ledger destination, 3 runs, complete stdout summary and all 60 ledger lines.
         { run_bounded "$_rbr_cap" node --test "--test-timeout=$BATTERY_TEST_TIMEOUT_MS" --test-force-exit --test-reporter=spec --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination="$_rbr_tapfile" $_rbr_ledger_reporter_args $_rbr_conc "$@" 2>&1; echo $? > "$_rbr_statusfile"; } | tee "$_rbr_outfile"
         _rbr_inner_status=$(cat "$_rbr_statusfile" 2>/dev/null) || _rbr_inner_status=1
         [ -n "$_rbr_inner_status" ] || _rbr_inner_status=1
         rm -f "$_rbr_statusfile"
         exit "$_rbr_inner_status"
       ); then
      RUN_BATTERY_OK=1
      _rbr_merge_ledger
      rm -f "$_rbr_outfile" "$_rbr_tapfile" "$_rbr_ledgerfile"
      break
    else
      _rbr_status=$?
      RUN_BATTERY_STATUS=$_rbr_status
    fi
    if [ "$_rbr_status" = 124 ] || [ "$_rbr_status" = 137 ]; then
      echo "pre-push: $_rbr_label node:test hit the ${_rbr_cap}s cap or was killed (status=$_rbr_status; a genuine cap expiry is exit 124 — a 137 could also be an unrelated external SIGKILL) — tree killed either way, treating as a failed attempt"
    elif [ "$_rbr_attempt" = 1 ]; then
      # plan 3235 (review round, finding A): check for a per-test timeout BEFORE any of the
      # load-flake wording below ever prints. A per-test-timeout expiry exits through the
      # SAME status-1 "real" convention an ordinary assertion failure uses, so without this check
      # attempt 1's own failure message would tell the operator "load flake, re-running to
      # confirm" for a class of failure the re-run can never clear — precisely the misdiagnosis
      # plan 3235 exists to prevent, and on the FIRST signal the operator sees, a whole retry
      # attempt before the (pre-existing) final-attempt check below could otherwise correct it.
      # The retry itself is UNCHANGED — it still runs below exactly as it does today; only the
      # DIAGNOSIS printed here changes. The cap this message quotes is interpolated from
      # $BATTERY_TEST_TIMEOUT_MS rather than hand-copied, so a re-derivation of the number can never
      # leave the operator-facing diagnostic quoting a cap the gate no longer applies (plan 3242).
      if _rbr_tapfile_shows_timeout "$_rbr_tapfile"; then
        echo "pre-push: $_rbr_label node:test failed once — a PER-TEST TIMEOUT (--test-timeout=${BATTERY_TEST_TIMEOUT_MS}ms fired on at least one test), NOT herd load-flake. Do NOT apply the load-flake triage (re-running the named file alone will NOT make a genuine hang pass) — the re-run below is still happening, but is expected to hit the same cap, so you can act on this now instead of waiting for it. Find the awaited event that never arrives (or already fired) in the named test."
      # plan 3223 (review round: finding 4/CONFIRMED): the retry is the SAME selection only when
      # ledger participation is inactive ($_rbr_ledger_key empty). With it active, attempt 2's own
      # remainder recomputation (top of the loop) narrows "$@" to exclude whatever THIS attempt's
      # own _rbr_merge_ledger call just proved green — so a mixed-outcome attempt 1 (some files
      # passed, one file failed) retries only the remainder, not the original selection. Wording
      # split on the same condition the narrowing itself is gated on, so it can never drift from
      # what actually re-runs.
      elif [ -n "$_rbr_ledger_key" ]; then
        echo "pre-push: $_rbr_label node:test failed once — re-running the REMAINDER (this attempt's own already-green files are excluded via the per-file ledger) ONCE to absorb parallel-herd load-flake (a genuine regression survives the re-run)"
      else
        echo "pre-push: $_rbr_label node:test failed once — re-running the SAME selection ONCE to absorb parallel-herd load-flake (a genuine regression survives the re-run)"
      fi
    else
      # review finding 13ituzt (pre-existing): the final attempt failing with a plain non-cap
      # status previously produced no attempt-specific echo at all before falling through to the
      # caller's generic "FAILED (both attempts)" message — this line is that missing diagnostic.
      # re-review finding (2026-07-27): this echo used to assert "a real regression, not herd
      # load-flake" for ANY non-cap status, contradicting the three-tier vocabulary plan 2523
      # established two functions up. The cap tier is already handled by the first arm above, so
      # what reaches here is real (a genuine red) OR no-verdict (crash / signal death outside
      # timeout's --kill-after grace / runner missing from PATH) — and telling a developer that a
      # SIGTERM-at-143 is "a real regression" is exactly the false verdict bound_status_class exists
      # to prevent. Split the two tiers; only `real` gets the confident wording.
      _rbr_final_class=$(bound_status_class "$_rbr_status") || _rbr_final_class=real
      if [ "$_rbr_final_class" = no-verdict ]; then
        echo "pre-push: $_rbr_label node:test exited $_rbr_status on the re-run — that is NOT a test verdict (node:test reports 1 for an actual red). Both attempts ended without the runner rendering a result, so this is harness-level (a crash, an interrupt, or a missing dependency), NOT evidence of a regression in your diff. Re-push once the machine is quieter; if it repeats, run the battery directly to see the real error."
      else
        # plan 3235: a per-test --test-timeout expiry reports through node:test's OWN "real"
        # 1-exit convention. That is the SAME
        # status a genuine assertion failure uses — so without this check a hung test's red would
        # read exactly like the generic "a real regression" wording below, and the repo's own
        # documented load-flake triage ("re-run the named files alone" — CLAUDE.md) would be
        # applied to it. A genuine hang SURVIVES that triage every time (it is bounded by the cap,
        # not flaky), so it must name itself a TIMEOUT explicitly instead of reading like an
        # ordinary assertion failure. node's own TAP diagnostic marks this shape unambiguously —
        # `failureType: 'testTimeoutFailure'` / `error: 'test timed out after <n>ms'` — matched
        # against the SAME tapfile the harvest below reads (not yet removed at this point in the
        # loop), via the shared _rbr_tapfile_shows_timeout helper defined above (plan 3235 review
        # round finding B: this used to be a throwaway $_rbr_timeout_hit variable populated via
        # `grep -l` on a single already-known file purely to test it for emptiness).
        if _rbr_tapfile_shows_timeout "$_rbr_tapfile"; then
          echo "pre-push: $_rbr_label node:test failed on the re-run too (status=$_rbr_status) — a PER-TEST TIMEOUT (--test-timeout=${BATTERY_TEST_TIMEOUT_MS}ms fired on at least one test), NOT herd load-flake and NOT an ordinary assertion failure. Do NOT apply the load-flake triage — re-running the named file alone will NOT make a genuine hang pass. Find the awaited event that never arrives (or already fired) in the named test."
        else
          echo "pre-push: $_rbr_label node:test failed on the re-run too (status=$_rbr_status) — a real regression, not herd load-flake."
        fi
      fi
    fi
    # plan 2530 / review finding 16fw12j: harvest THIS attempt's not-ok test-file basenames —
    # best-effort only, never blocks: a cap-kill's truncated partial log or an unrecognized TAP
    # shape just yields an empty list, which is fine — MERGED (union, deduped) into
    # RUN_BATTERY_FAILED_FILES rather than overwriting it, so a real attempt-1 failure survives
    # an empty-yielding attempt-2 (cap-kill or otherwise) instead of being discarded.
    #
    # plan 2875: reads $_rbr_tapfile (the dedicated TAP destination above), NOT $_rbr_outfile —
    # two compounding bugs, both fixed together because the second is only reachable once the
    # first is: (1) $_rbr_outfile was never TAP to begin with (see the invocation comment above —
    # measured live, node's own default here is `spec`, so a `^not ok` grep against it matched
    # nothing, ever); (2) even a genuine TAP stream would still miss most failures with the OLD
    # pattern, because node --test's top-level `not ok N - <description>` line names the TEST
    # NAME, not the file, for any file that registers at least one test() — only a file that
    # crashes before registering any test (a syntax/import-time error) happens to get its
    # FILENAME as the description, which is why this bug could look like it "mostly" worked in
    # ad-hoc testing. The one field TAP reliably carries the origin file on is each failing
    # subtest's own diagnostic YAML `location: '<path>:<line>:<col>'` (present on every `not ok`,
    # absent on every `ok` — verified empirically, not merely assumed) — grep that instead and
    # take the last path segment ending `.test.mjs` (stops at the nearest `/` or `\`, so it
    # handles a Windows path's doubled backslashes and a Linux path's forward slashes the same
    # way with one pattern).
    _rbr_attempt_failed=""
    if [ -n "$_rbr_tapfile" ] && [ -f "$_rbr_tapfile" ]; then
      _rbr_attempt_failed=$(grep -E '^[[:space:]]*location: ' "$_rbr_tapfile" 2>/dev/null | grep -oE '[^\\/]+\.test\.mjs' | sort -u | tr '\n' ',') || _rbr_attempt_failed=""
      _rbr_attempt_failed=${_rbr_attempt_failed%,}
    fi
    if [ -n "$_rbr_attempt_failed" ]; then
      if [ -n "$RUN_BATTERY_FAILED_FILES" ]; then
        RUN_BATTERY_FAILED_FILES=$(printf '%s,%s' "$RUN_BATTERY_FAILED_FILES" "$_rbr_attempt_failed" | tr ',' '\n' | sort -u | tr '\n' ',')
        RUN_BATTERY_FAILED_FILES=${RUN_BATTERY_FAILED_FILES%,}
      else
        RUN_BATTERY_FAILED_FILES="$_rbr_attempt_failed"
      fi
    fi
    # plan 3223: merge this attempt's newly-proven-green files BEFORE the rm -f below — the
    # same "harvest before delete" ordering the plan-2530/2875 failure harvest above already
    # follows against the same tapfile-adjacent tempfile lifecycle.
    _rbr_merge_ledger
    rm -f "$_rbr_outfile" "$_rbr_tapfile" "$_rbr_ledgerfile"
    # ── plan 2734 (arm D): don't double an UNSERIALIZED run's work under the load that broke it ──
    # On the SERIALIZED path plan 984's re-run is already under the lock — the battery gate holds it
    # across this whole function, both attempts — so there is nothing to fix there (the plan-2734
    # stub's framing missed this). The gap is the unserialized paths: a run that lost the lock and
    # then hit a LOAD-induced failure re-runs the same selection immediately, under exactly the load
    # that caused it, so the re-run stops discriminating regression-from-flake and just doubles the
    # work. Before the re-run, make ONE short bounded attempt to take the lock: the holder we queued
    # behind may well be gone by now, and a re-run under the lock is a real discriminator again.
    # Opt-in via RBR_RERUN_LOCK, set ONLY by the scripts-battery gate and only when its own acquire
    # returned 4 — the data-dependency gate (this function's other caller) leaves it unset, so its
    # behaviour is byte-identical. Failing to acquire is a NO-OP: the re-run still happens, because
    # tests are never skipped and an expired waiter is never starved (the 2026-07-10 ruling).
    if [ "${RBR_RERUN_LOCK:-0}" = 1 ] && [ "$_rbr_attempt" = 1 ] && [ -z "$RUN_BATTERY_RERUN_TOKEN" ]; then
      # The acquire's STATUS decides the clamp, the TOKEN decides the release, and the two are
      # independent (plan 2734): exit 0 = we hold the serialized lock ⇒ run the re-run at full
      # parallelism; exit 4 WITH a token = we hold the single overflow slot ⇒ keep the clamp but
      # still release it; exit 4/5 without one = nothing held. Blanking the token on any non-zero
      # (the obvious shape) would LEAK an overflow slot until its reap — the whole point of the
      # slot is that it is held while a clamped battery runs. --holder-pid is passed only when the
      # caller declared one, so an undeclared caller can never send an empty flag value (which
      # throws → EXIT_ERROR).
      # DELIBERATELY SHORT (review finding, 2026-08-02): the win case costs nothing — if the holder
      # we queued behind is gone, the FIRST poll takes tier 1 instantly — while the lose case is pure
      # added latency on a push that has already failed once. The first cut used a 120s ceiling and
      # inherited a 120s admission window from it, so a re-run behind a still-live holder could poll
      # ~240s before starting. 30s + 5s bounds that at ~35s. It can still land the overflow slot, and
      # if the gate ALREADY holds that slot this acquire simply finds it busy and gives up fast.
      _rbr_lock_status=0
      RUN_BATTERY_RERUN_TOKEN=$(node scripts/battery-lock.mjs acquire --label "prepush-rerun-$$" ${BATTERY_HOLDER_PID:+--holder-pid $BATTERY_HOLDER_PID} --timeout-sec "${RBR_RERUN_LOCK_WAIT_SEC:-30}" --admission-wait-sec 5 --poll-sec 2) || _rbr_lock_status=$?
      if [ "$_rbr_lock_status" = 0 ] && [ -n "$RUN_BATTERY_RERUN_TOKEN" ]; then
        _rbr_conc=""
        echo "pre-push: $_rbr_label took the battery lock for the re-run — the re-run is a real load discriminator now, at full parallelism, instead of a second concurrent battery"
      else
        echo "pre-push: $_rbr_label could not take the battery lock for the re-run (status=$_rbr_lock_status) — re-running at reduced parallelism anyway; tests are never skipped"
      fi
    fi
    _rbr_attempt=$((_rbr_attempt + 1))
  done
}

# ── CI-gap cover (plan 612) ─────────────────────────────────────────────────
# While GitHub Actions CI is dark (Actions budget $0 + June free allowance
# exhausted until the 2026-07-01 reset), two checks that run ONLY in CI's
# `verify` job have no local equivalent, so their break classes can land
# unguarded: prettier `--check` (CI: `pnpm lint`) and the frontend
# `tsc --noEmit`. Both gates below are diff-scoped (kept cheap so the herd of
# parallel sessions isn't slowed), skipped on coord-only pushes (the coord-ref
# pass-through above already exit-0'd those), and bypassable with --no-verify.

# Prettier --check on the changed, prettier-relevant files. CI runs
# `prettier --check .` over the whole repo; here we scope to origin/master..HEAD
# (prettier-relevant extensions only, non-deleted paths). prettier still applies
# .prettierignore to the explicit paths it's handed, so ignored files (seed,
# lockfiles, plans, board, FEATURES.md, *.py, …) are skipped — no need to
# reimplement the ignore set. Empty CHANGED (no diff / the diff above failed) →
# skip. errexit-safe: the grep is `|| true`'d inside the substitution (an
# empty match would otherwise abort under `sh -e`, the plan-336 footgun), and
# the existence filter runs in an `if` condition (fully exempt from errexit).
# Bypass: git push --no-verify (investigate first).
if [ -n "$CHANGED" ]; then
  PRETTIER_CHANGED=$(printf '%s\n' "$CHANGED" | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|yml|yaml)$' || true)
  # Drop paths that no longer exist on disk (deleted / renamed-away) — prettier
  # errors on a missing path. Build the surviving list one path at a time; the
  # heredoc (not a pipe) keeps the loop in THIS shell so the var survives.
  PRETTIER_EXISTING=""
  if [ -n "$PRETTIER_CHANGED" ]; then
    while IFS= read -r f; do
      if [ -n "$f" ] && [ -f "$f" ]; then
        PRETTIER_EXISTING="${PRETTIER_EXISTING}${f}
"
      fi
    done <<EOF
$PRETTIER_CHANGED
EOF
  fi
  if [ -n "$PRETTIER_EXISTING" ]; then
    echo "pre-push: changed prettier-relevant files detected — running prettier --check (scoped to the diff, chunked)"
    # plan 1874 (reader axis of plan 1869): prettier's .bin shim can be mid-rewrite while a
    # legitimate install-main run holds the install lock — probe it first; the helper waits out
    # a held lock (bounded) and re-probes with backoff. The shell test is the zero-spawn fast
    # path (no Node boot when the shim is present — the ~always case); --wait-sec 240 keeps the
    # worst-case addition bounded on a gate whose measured runtime already straddles the 600s
    # foreground push cap (review finding — background gate-running pushes per plan 2038 remain
    # the standing rule). FAIL-OPEN: only the helper's DELIBERATE exit 2 (persistent tear, heal
    # line already printed) blocks; any other failure proceeds to prettier's own error. Runs
    # ONLY when prettier will actually be invoked (this branch). errexit-safe: `cmd || VAR=$?`
    # never trips `sh -e`.
    EBS_STATUS=0
    if [ -f scripts/ensure-bin-shims.mjs ] && [ ! -e node_modules/.bin/prettier ]; then
      node scripts/ensure-bin-shims.mjs prettier --wait-sec 240 || EBS_STATUS=$?
    fi
    if [ "$EBS_STATUS" = 2 ]; then
      exit 1
    fi
    # Feed the newline-separated list through xargs so prettier runs in as many
    # BOUNDED invocations as the path count needs. A large diff (e.g. a consensus /
    # seed regen of 100+ files) otherwise overflows the command-line length limit
    # ("The command line is too long." on Windows), which silently failed the gate
    # and BLOCKED the land — plan 626 (surfaced by plan 607's ~140-file consensus
    # regen). One path per line (repo paths carry no spaces); `-r` skips an all-blank
    # list; a non-zero from ANY chunk makes xargs exit non-zero → caught below.
    # .prettierignore'd paths handed to prettier are skipped by prettier itself.
    # xargs runs `sh -c` (a real binary) which invokes pnpm — NOT `xargs pnpm`:
    # MSYS/git-bash xargs cannot exec the `pnpm` script-shim on Windows (it runs
    # nothing), so we go through sh, which resolves the shim. Paths arrive as "$@".
    # `-s 6000` bounds each chunk's command line: xargs otherwise sizes chunks by
    # POSIX ARG_MAX (~128k), but `pnpm` is `pnpm.cmd` run via cmd.exe, whose limit
    # is only ~8191 chars — so even ONE ~140-file chunk overflowed ("command line
    # too long") and blocked the land (plan 628; 626's chunking alone wasn't enough).
    # 6000 leaves headroom for the `sh -c '…' sh` + `pnpm exec prettier --check`
    # prefix under cmd.exe's limit. Verified on plan 607's 142 files (123→0).
    printf '%s\n' "$PRETTIER_EXISTING" | xargs -r -s 6000 sh -c 'pnpm exec prettier --check "$@"' sh || {
      echo "pre-push: prettier --check FAILED — formatting drift in the pushed diff. Fix with \`pnpm exec prettier --write <files>\` (or \`pnpm format\`), then re-push. Bypass: git push --no-verify (investigate first)."
      exit 1
    }
    echo "pre-push: prettier --check clean"
  fi
fi

# ── 1.6 Per-gate pass-cache probe (plan 2462) ───────────────────────────────
# ONE `check-all` process decides every expensive gate below (tsc x3, vitest x3,
# pytest; `next build` + the mobile gate are decided in done-worktree's prep path
# and here respectively). It is one `git status` + one `git cat-file --batch-check`
# + one `git version` for the whole battery — ~350ms measured on the real repo,
# against the 15-27 min the battery costs — so it is deliberately NOT diff-gated:
# the probe is cheaper than deciding whether to probe.
#
# The contract, inherited wholesale from the plan-1824 battery cache: a gate may
# be SKIPPED only when this exact content already ran that exact gate green inside
# the TTL. Dirt in a gate's own closure, git trouble, an expired entry, either
# kill-switch, or any doubt ⇒ that gate RUNS. A red run invalidates its key so a
# flaky earlier pass can never shadow a real failure. Full closure definitions live
# in scripts/gate-pass-cache.mjs (that is where to look when a gate stale-greens).
#
# Decisions land in a FILE of flat `<gate>.<field>=<value>` lines which the helpers
# below grep — deliberately NOT `eval`'d. This is the highest-blast-radius file in
# the repo; a cache file must never be able to inject shell into it.
GATE_CACHE_FILE=""
# plan 2527 item 2: check-all's own gatherRepoState() (one git status + one git cat-file
# --batch-check + one git version over the SAME allKeyedPaths() union every gate — including
# the probe-gated mobile gate — reads) is reusable by a later probe-gated `check --gate <g>`
# call in the same hook run (see gate-pass-cache.mjs's serializeRepoState). GATE_STATE_FILE
# carries that serialized gather; empty/absent/stale is always safe — the consuming side
# (gate_needs_run below) falls back to a fresh gather exactly as before this item.
GATE_STATE_FILE=""
# plan 2875 (review finding 4, DECLINED after investigation — see docs/coord/hooks.md § Diff-scoping).
# The gpt-review pass flagged this guard as a defect: two flags whose NAMES say BATTERY gating a
# probe that backs SEVEN unrelated gates, so debugging the battery silently disables their caching
# too. That reading is wrong, and the "fix" was reverted before landing.
# `scripts/gate-pass-cache.mjs`'s envDisabled() consults BOTH vars at ALL THREE sites (check-all,
# check, record) DELIBERATELY (plan 2462 task 4, comment at gate-pass-cache.mjs:660-663):
# "PREPUSH_FULL_BATTERY forces every gate to really run AND to not record". Unsetting the vars for
# the probe alone breaks that on both ends: the probe starts returning cache HITS, so gates SKIP —
# defeating the whole purpose of a flag whose contract is "force every gate to really run" — while
# `record` still refuses to write, leaving a cache that is read but never refreshed. The real cost
# of the original behavior is one slower push on a rarely-used debug flag; the cost of the "fix"
# was silently skipping gates the operator explicitly asked to force. Left as designed.
if [ "${PREPUSH_NO_BATTERY_CACHE:-0}" != "1" ] && [ "${PREPUSH_FULL_BATTERY:-0}" != "1" ]; then
  GATE_CACHE_FILE="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/gate-cache-$$")"
  GATE_STATE_FILE="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/gate-state-$$")"
  # Bare `timeout`, not the PowerShell job wrapper: this is one short node process
  # and the ~150-400ms wrapper spawn would eat the fast path this cache creates.
  # A cap-kill leaves a partial/absent file, which the helpers read as "no cached
  # verdict" ⇒ every gate runs. Fail-safe by construction.
  timeout --kill-after=15 60 node scripts/gate-pass-cache.mjs check-all     --out "$GATE_CACHE_FILE" --state-out "$GATE_STATE_FILE"     || true
fi

# ── Gate-outcome telemetry (plan 2530) ──────────────────────────────────────
# gate_outcome <name> <result> <durSec> <sel> [failed] — appends ONE line per gate that
# actually ran (or was cache-skipped) to $(git rev-parse --git-common-dir)/gate-outcome-
# telemetry.log — a NEVER-COMMITTED log inside .git/, the same "uncommittable by
# construction" trick write_push_telemetry (plan 1731) uses above. Filed to answer the
# plan-2530 question push-telemetry.log cannot: not "did index/board drift", but "which
# scripts/*.test.mjs battery tests have EVER caught anything" — the evidence Phase 2's
# cost-weighted prune needs and today has no persistent record of at all (a gate failure
# blocks a push, gets fixed in-session, and leaves nothing behind).
#   result = pass | fail | cache-hit | cap-kill | no-verdict | skipped | chunked (review finding
#            tq7h8u: a gate that never ran the thing it's named for — e.g. VERIFY_MOBILE_SKIP=1 or
#            a no-watched-surface no-op on the mobile gate — logs "skipped", never "pass".
#            "no-verdict" is bound_status_class's third tier: the runner died without rendering a
#            result, so the run is evidence of NOTHING — neither a catch nor a clean pass.
#            "chunked" (plan 3274) is a DISTINCT outcome from cap-kill: it fires only in
#            cloud-chunked mode (PREPUSH_CHUNK_MODE=1 — see the deadline stamp near
#            PP_IS_LOCAL_PUSH above) and means the shared push-deadline, not an anomaly, ended
#            the run early — expected/resumable, so a cost-weighted prune reading this log must
#            never score it as "this gate caught nothing" the way a real cap-kill under load can
#            still be read.)
#            For a RETRIED battery gate this value comes from battery_outcome_class(), where
#            observed `not ok` evidence in ANY attempt outranks a later attempt's cap-kill —
#            see that helper for why the log and the terminal classify the same run differently.
#   durSec = wall-clock seconds for THIS attempt (0 for a cache-hit — nothing ran; the literal
#            "unknown" if the caller's clock read was broken — see the clamp in the body)
#   sel    = file count selected, or the literal "full" / "n/a" when selection does not apply
#   phase  = OPTIONAL, and never written by THIS shell function — every record gate_outcome()
#            itself appends is implicitly push-phase and carries no `phase=` token at all. A
#            SECOND writer, scripts/done-worktree.mjs's own formatGateOutcomeLine() /
#            appendDeployGateOutcome() (plan 3172, extended by plan 3997), appends TWO other
#            values: `phase=land` from four of phasePreflight()'s land-preflight gate call sites
#            (production build, the WebKit mobile gate, pytest-backend-scripts, scripts-battery —
#            reusing these same gate NAMES rather than minting land-only ones), and `phase=deploy`
#            from the `--deploy` market-copy gate's own write (review round 1, findings
#            030446/b226c8: this write pre-dates `phase` and must not silently read as push-phase
#            just because it carries no token of its own). A consumer sums push/land/deploy cost
#            per gate by filtering on this one field. Rides between `sel=` and the optional
#            `failed=` below when present. Absent ⇒ push.
#   failed = optional comma-joined list of `not ok`-reported test-file basenames (battery only,
#            push-phase); a land-phase PYTEST_STARVED record also carries a single-value
#            `failed=PYTEST_STARVED` from the second writer above.
# Mirrors write_push_telemetry's defensive style: NEVER fails, delays, or surfaces a push —
# every step guarded (`|| :` / `2>/dev/null` / an `if`, never a bare `VAR=$(… | grep …)` under
# `sh -e`, the plan-336 footgun) and `return 0` is always the function's last word regardless
# of which branch it took. Deliberately a PLAIN function call, not consulted inside a caller's
# `if`/`&&` chain the way write_push_telemetry is via the EXIT trap — there is no single choke
# point a per-gate line can hook (unlike the two drift gates), so each call site invokes it
# directly right after the gate's own pass/fail/cache decision is known.
gate_outcome() {
  _go_name=$1
  _go_result=$2
  _go_dur=$3
  _go_sel=${4:-n/a}
  _go_failed=${5:-}
  # plan 2579 (finding 2rnbsi): memoize the git-common-dir lookup across calls IN THIS PUSH —
  # gate_outcome can run ~12+ times per push (once per gate that ran, cache-hit, or was
  # skipped), and every earlier call spawned its OWN fresh `git rev-parse --git-common-dir`
  # despite the answer never changing mid-push. Resolved on the FIRST call only; every later
  # call this push reuses it. Only a SUCCESSFUL resolution memoizes (review finding 2026-07-28):
  # the "a fresh attempt could not succeed where the first one failed" reasoning holds for repo
  # STATE, but this call can also fail transiently under the shared-`.git` herd this hook's own
  # comments describe, and caching that would silently drop the whole push's telemetry instead of
  # one gate's — losing the sample under exactly the load Phase 2 exists to measure. On failure
  # the next gate simply retries, which is what the pre-memoization code did every time.
  # Kept SELF-CONTAINED (private-looking `_GO_*` globals, not a script-level
  # precompute shared with write_push_telemetry's own independent lookup) so
  # this file's own name-paired test's gate_outcome-only extraction (the dur_s clamp test,
  # which pastes just this function body next to its own fake `git`) keeps working
  # unmodified — it never sees a preceding top-level precompute line.
  if [ -z "${_GO_COMMON_DIR:-}" ]; then
    _GO_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null) || _GO_COMMON_DIR=""
  fi
  _go_common_dir="$_GO_COMMON_DIR"
  [ -n "$_go_common_dir" ] || return 0
  _go_log="$_go_common_dir/gate-outcome-telemetry.log"
  _go_branch="${COORD_DRIFT_BRANCH:-unknown}"
  [ -n "$_go_branch" ] || _go_branch="unknown"
  _go_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || _go_ts="unknown"
  # re-review finding (2026-07-27): every caller computes dur_s via elapsed_since() (plan 2579;
  # originally hand-copied inline as `$(($(date +%s) - _t0))`), and _t0 falls back to 0 if its
  # own `date` call failed (the errexit guard finding 1csy4by added).
  # That fallback would write a ~1.7-BILLION-second duration straight into this log — and the
  # header below promises dur_s feeds Phase 2's "measured wall-time share" ranking, where one such
  # entry would dominate whichever gate happened to run at that moment. Clamp the absurd case to
  # "unknown" HERE, at the single write point, rather than at 13 call sites: no real gate on this
  # box runs a day, so >86400 can only mean a broken clock read. Non-numeric input lands here too.
  # (written as an `if`, not `[ … ] && x`: this function promises it NEVER fails or surfaces, and
  # a trailing false test would hand `sh -e` a nonzero status on the way out.)
  case "$_go_dur" in
    '' | *[!0-9]*) _go_dur="unknown" ;;
    *)
      if [ "$_go_dur" -gt 86400 ]; then
        _go_dur="unknown"
      fi
      ;;
  esac
  _go_line="$_go_ts branch=$_go_branch gate=$_go_name result=$_go_result dur_s=$_go_dur sel=$_go_sel"
  if [ -n "$_go_failed" ]; then
    _go_line="$_go_line failed=$_go_failed"
  fi
  if [ -f "$_go_log" ]; then
    _go_content="$_go_line"
  else
    _go_content="# gate-outcome-telemetry.log (plan 2530) — one line per gate that ran (or was
# cache-skipped) this gate-running push, NEVER committed (lives inside .git/):
#   <ISO-8601 UTC> branch=<b> gate=<name> result=pass|fail|cache-hit|cap-kill|no-verdict|skipped dur_s=<n-or-unknown> sel=<n-files-or-full-or-n/a> [failed=<f1,f2>]
# `failed=` only appears on the scripts/*.test.mjs battery's red attempts (the not-ok-reported
# test-file basenames). Feeds the Phase 2 cost-weighted battery prune (plan 2530): rank by
# (never-failed in this log) x (measured wall-time share) x (selection frequency).
$_go_line"
  fi
  printf '%s\n' "$_go_content" >> "$_go_log" 2>/dev/null || :
  return 0
}

# THE one way to wire a gate to this cache (plan 2492, findings `nepmjn`/`n0cq7i`: the
# cached?-then-key-then-run-then-close sequence was hand-copy-pasted at 7 call sites, where a
# future gate could be wired subtly differently, and each site read the decisions file TWICE).
#
#   $1 = gate name, $2 = human label for the CACHED line.
#   returns 0 (true)  ⇒ the gate must RUN; $GATE_KEY holds the key its close-out records under
#                       (empty ⇒ no usable verdict ⇒ run but do not record).
#   returns 1 (false) ⇒ a live cached green covers this exact content; the CACHED line is printed
#                       and the caller skips the run entirely.
# EMPTY OR ABSENT ALWAYS MEANS RUN: no file, a crashed probe, a malformed line, a miss, an
# uncacheable verdict — every one of them lands on "run the gate", never on a skip.
#
# ONE read of the decisions file per gate (the `_gs` slurp); the two field lookups are then
# in-memory. `^<gate>\.` cannot prefix-collide — the literal dot is required.
#
# PROBE-GATED GATES (plan 2527 item 3): check-all never decides these itself — its own probe
# must observe the same range/commit state as the run it precedes, so it cannot move into
# check-all (see gate-pass-cache.mjs's registry comment). check-all instead lists a probe-gated
# gate as `status=uncacheable reason=probe-gated`, a placeholder this helper detects below and
# resolves with that gate's own single-gate `check --gate <g>` call — one wiring shape for
# every cache-wired gate (the mobile gate included) rather than a second hand-rolled helper.
gate_needs_run() {
  GATE_KEY=""
  _gs=""
  if [ -n "$GATE_CACHE_FILE" ] && [ -f "$GATE_CACHE_FILE" ]; then
    _gs=$(grep "^$1\." "$GATE_CACHE_FILE" 2>/dev/null) || _gs=""
  fi
  _gnr_status=$(printf '%s\n' "$_gs" | grep "^$1\.status=" | head -1 | cut -d= -f2) || _gnr_status=""
  if [ "$_gnr_status" = "hit" ]; then
    echo "pre-push: $2 — CACHED green for this exact content (plan 2462), skipping"
    gate_outcome "$1" cache-hit 0 n/a
    return 1
  fi
  _gnr_reason=$(printf '%s\n' "$_gs" | grep "^$1\.reason=" | head -1 | cut -d= -f2) || _gnr_reason=""
  if [ "$_gnr_status" = "uncacheable" ] && [ "$_gnr_reason" = "probe-gated" ]; then
    # This gate's own probing check, pinned to THIS call site (not check-all). $GATE_STATE_FILE
    # (plan 2527 item 2), when present, lets it reuse check-all's already-gathered repo state
    # instead of re-deriving it — the probe subprocess itself is still always spawned fresh.
    # Real exit contract: 0 = HIT (key on stdout, skip), 2 = MISS (key on stdout, run+record),
    # 3 = UNCACHEABLE (no stdout, run, record nothing). Wrapped in `if VAR=$(...); then` (not a
    # bare assignment + separate `$?` read) so a MISS/UNCACHEABLE exit never trips this hook's
    # errexit — see the husky wrapper's `sh -e` note at the top of this file.
    _gnr_hit=0
    if [ -n "$GATE_STATE_FILE" ] && [ -f "$GATE_STATE_FILE" ]; then
      if GATE_KEY=$(timeout --kill-after=15 90 node scripts/gate-pass-cache.mjs check --gate "$1" --state-in "$GATE_STATE_FILE" 2>/dev/null); then
        _gnr_hit=1
      fi
    else
      if GATE_KEY=$(timeout --kill-after=15 90 node scripts/gate-pass-cache.mjs check --gate "$1" 2>/dev/null); then
        _gnr_hit=1
      fi
    fi
    if [ "$_gnr_hit" = 1 ]; then
      echo "pre-push: $2 — CACHED green for this exact content (plan 2491), skipping"
      gate_outcome "$1" cache-hit 0 n/a
      return 1
    fi
    return 0
  fi
  GATE_KEY=$(printf '%s\n' "$_gs" | grep "^$1\.key=" | head -1 | cut -d= -f2) || GATE_KEY=""
  return 0
}

# Close out a gate's run. $1=gate $2=key $3=0|1 (1 = the gate passed).
# A pass RECORDs (the script re-derives the key and refuses on drift); a failure
# INVALIDATEs so the entry cannot shadow the red. Both `|| true` — a cache
# close-out must never change whether a push proceeds.
gate_close() {
  # plan 2530: gate-outcome telemetry piggybacks on this SAME choke point — every close-out
  # already carries the gate name + pass/fail, so recording it here (rather than duplicating
  # a pass/fail branch at each of the 8 call sites) keeps ONE place that can drift.
  # $4=t0 (plan 2579, finding hddxkw: a raw `date +%s` epoch captured via this hook's
  # standard `_t0=$(date +%s) || _t0=0` idiom — every caller used to hand-compute
  # `$(($(date +%s) - _t0))` itself before calling this; that arithmetic now lives in
  # elapsed_since() (finding ptz3oa/1awafy2, defined beside bound_status_class), called ONCE
  # here rather than re-derived at each of the ~12 gate_close call sites — this IS the
  # "gate-outcome timing lives in the seam every gate already funnels through" fix.
  # Omitted ⇒ this caller hasn't been timed ⇒ no telemetry line, a silent no-op — never a
  # broken one), $5=sel (default n/a), $6=result override (e.g. "cap-kill"; default
  # derives from $3). Fires BEFORE the $2-empty early-return below: an uncacheable-but-ran gate
  # (no usable key) still deserves a persistent outcome record — only the CACHE write needs one.
  if [ -n "$4" ]; then
    _gc_result="fail"
    [ "$3" = 1 ] && _gc_result="pass"
    [ -n "$6" ] && _gc_result="$6"
    gate_outcome "$1" "$_gc_result" "$(elapsed_since "$4")" "${5:-n/a}"
  fi
  [ -n "$2" ] || return 0
  if [ "$3" = 1 ]; then
    timeout --kill-after=15 60 node scripts/gate-pass-cache.mjs record \
      --gate "$1" --key "$2" --label "prepush-$$" >/dev/null 2>&1 || true
  else
    timeout --kill-after=15 60 node scripts/gate-pass-cache.mjs invalidate \
      --key "$2" >/dev/null 2>&1 || true
  fi
}

# report_capped_verdict <gate> <key> <t0> <class> — the shared "close a run_bounded-capped
# gate given its already-classified status" shape (plan 2579, finding 1ni65xx) that the
# seed-sanity, full backend suite, and frontend seed-sanity gates all copy-pasted
# near-verbatim: a cap expiry closes as result=cap-kill with sel=full (the convention every
# converted gate shares); anything else (no-verdict or a genuine red) closes with
# gate_close's own default derivation from $3=0.
#
# $4 is the ALREADY-CLASSIFIED string, not a raw status — this helper does NOT call
# bound_status_class itself. Its own orphan-bound-coverage test asserts the
# LITERAL `bound_status_class "$<STATUS_VAR>"` call at each gate's own call site (by name,
# one per gate) as a drift guard; folding that call in here would make it textually
# disappear from the hook, which that coverage test can't see through a shared helper — so
# each caller keeps its own `X_STATUS_CLASS=$(bound_status_class "$X_STATUS")` line.
#
# Deliberately does NOT own the arm-specific echo + exit 1 either: each gate's
# cap/no-verdict/fail messages differ (and quote that gate's own re-run command), and
# the orphan-bound-coverage test's heavy-signature forward guard (which
# flags an unwrapped heavy-process spawn) only recognizes those messages as prose — not a
# spawn — when they stay literal `echo "..."` lines at the call site; folding them into a
# function-call argument turns that same text into part of a `report_capped_verdict ...`
# logical line the guard can no longer tell apart from a real invocation. So each caller
# keeps its own `if $CLASS = cap / elif = no-verdict / else` echo+exit block (review finding
# rb9brp's no-verdict-is-not-a-regression arm included) right after calling this.
report_capped_verdict() {
  if [ "$4" = cap ]; then
    gate_close "$1" "$2" 0 "$3" full cap-kill
  else
    gate_close "$1" "$2" 0 "$3"
  fi
}


# ── Typecheck gates, from coord.config.json -> land.typecheckCommands[] (plan 4096 T5) ────────
#
# These three gates used to be spelled out here literally, naming `@vetapp/frontend` and
# `@vetapp/backend` and a pnpm workspace — three PROJECT commands living in a "core" file. They
# are DATA now, and the core default is EMPTY, so a coordination-core checkout with no workspace
# runs no typecheck and says so in one line instead of failing on a package it never had.
#
# Behaviour in THIS repo is unchanged: the same three gate names (they are pass-cache keys), the
# same diff triggers, the same 300s cap, the same run_bounded/bound_status_class/
# report_capped_verdict classification, and the same position in the ordered gate list — the
# order is load-bearing for the once-per-land proof and the plan-3295 tiering.
#
# plan 2875 (carried over, and the reason the cap branch exists at all): a cap-kill is NOT a
# type-error verdict — tsc never finished, most likely a saturated machine (the common case on
# ~5-7 parallel sessions) — so it is branched, reported through report_capped_verdict's own
# gate_outcome path rather than the plain gate_close a real red uses, and worded so nobody reads
# it as a regression. Note tsc --noEmit exits 2 on a type error, not 1, which is why only the cap
# bucket of bound_status_class is borrowed here, never its "real"/"no-verdict" labels wholesale.
#
# Rows sharing a `group` are contiguous and share one diff trigger: the trigger is tested ONCE per
# group, the header prints once, and the "… clean" line prints once after the group's last row.
# Gates inside a group are cached SEPARATELY (the gate name is part of the key), because they are
# separate runs with separate verdicts — backend can be green while the shared project is red.
#
# FAIL-CLOSED on a bad config: a non-zero exit from the reader blocks the push. A malformed row
# must never read as "no typecheck configured" and pass — that is a gate silently ceasing to run,
# with a green push to show for it.
PP_TYPECHECK_ROWS=$(node scripts/coord/land-typecheck-rows.mjs 2>&1) || {
  echo "pre-push: typecheck gate configuration is unusable — push blocked. coord.config.json's land.typecheckCommands[] did not validate (scripts/coord/land-typecheck-rows.mjs). This is NOT a type error; it is a config defect, and it is blocking rather than skipping because a row this hook cannot read is a gate that would stop running silently. The reader said:"
  printf '%s\n' "$PP_TYPECHECK_ROWS"
  exit 1
}
if [ -z "$PP_TYPECHECK_ROWS" ]; then
  # A generic coordination checkout, or a project that configures none. Said once, plainly, so
  # "no typecheck ran" is never mistaken for "typecheck passed".
  echo "pre-push: no typecheck configured (coord.config.json land.typecheckCommands[] is empty) — skipping the typecheck gates"
else
  PP_TC_TAB=$(printf '\t')
  PP_TC_GROUP=""
  PP_TC_ACTIVE=0
  # Fed by HERE-DOCUMENT, never by a pipe: in dash the right-hand side of a pipe runs in a
  # SUBSHELL, so an `exit 1` from a failing gate inside the loop would end that subshell and let
  # the push sail on. A here-doc keeps the loop in this shell, where `exit` means exit.
  #
  # `IFS=... read` sets IFS for the READ ONLY, so the loop body keeps the normal IFS — which the
  # body needs, because it expands $PP_TC_CMD UNQUOTED to hand run_bounded separate argv words.
  # (The reader guarantees that string is plain words and that no field is empty; both are
  # load-bearing here — see its header.)
  while IFS="$PP_TC_TAB" read -r PP_TC_NAME PP_TC_LABEL PP_TC_CHANGED PP_TC_GRP PP_TC_DIFFLABEL PP_TC_CAP PP_TC_LAST PP_TC_PLURAL PP_TC_HINT PP_TC_CMD; do
    [ -n "$PP_TC_NAME" ] || continue
    if [ "$PP_TC_GRP" != "$PP_TC_GROUP" ]; then
      PP_TC_GROUP="$PP_TC_GRP"
      PP_TC_ACTIVE=0
      if printf '%s\n' "$CHANGED" | grep -qE "$PP_TC_CHANGED"; then
        PP_TC_ACTIVE=1
        # `if`, never `[ … ] && …`: this hook runs under `sh -e`, and a trailing AND-OR list
        # whose test is FALSE leaves a non-zero status behind for errexit to trip over — the
        # same shape this file's own header documents biting at plan 336.
        PP_TC_EACH=""
        if [ "$PP_TC_PLURAL" = each ]; then
          PP_TC_EACH=" each"
        fi
        echo "pre-push: $PP_TC_DIFFLABEL detected — running $PP_TC_GROUP ($PP_BOUND_DESC, ${PP_TC_CAP}s cap$PP_TC_EACH)"
        require_timeout_or_exit "$PP_TC_DIFFLABEL"
      fi
    fi
    [ "$PP_TC_ACTIVE" = 1 ] || continue
    if gate_needs_run "$PP_TC_NAME" "$PP_TC_LABEL"; then
      _k="$GATE_KEY"
      _t0=$(date +%s) || _t0=0
      PP_TC_STATUS=0
      # shellcheck disable=SC2086  # deliberate word-splitting; the reader refuses any command
      # carrying a shell metacharacter precisely because this expansion is unquoted.
      run_bounded "$PP_TC_CAP" $PP_TC_CMD || PP_TC_STATUS=$?
      if [ "$PP_TC_STATUS" != 0 ]; then
        PP_TC_CLASS=$(bound_status_class "$PP_TC_STATUS")
        report_capped_verdict "$PP_TC_NAME" "$_k" "$_t0" "$PP_TC_CLASS"
        if [ "$PP_TC_CLASS" = cap ]; then
          echo "pre-push: $PP_TC_LABEL hit its ${PP_TC_CAP}s cap and was KILLED mid-run (status=$PP_TC_STATUS; a genuine cap expiry is exit 124 — a 137 could also be an unrelated external SIGKILL). This is NOT evidence of a type error — tsc never finished, most likely a saturated machine (the common case on ~5-7 parallel sessions). Re-push once quieter, or get a real verdict directly: $PP_TC_CMD. Do NOT bypass with --no-verify (that skips every OTHER gate too)."
        else
          echo "pre-push: $PP_TC_LABEL FAILED — push blocked ($PP_TC_HINT). Bypass: git push --no-verify (investigate first)."
        fi
        exit 1
      fi
      gate_close "$PP_TC_NAME" "$_k" 1 "$_t0"
    fi
    # Same errexit reasoning as the PP_TC_EACH assignment above, and it matters more here: this
    # is the LAST statement of the loop body, so a false AND-OR list would leave the body's exit
    # status non-zero on every row that is not its group's last.
    if [ "$PP_TC_LAST" = 1 ]; then
      echo "pre-push: $PP_TC_GROUP clean"
    fi
  done <<PP_TYPECHECK_EOF
$PP_TYPECHECK_ROWS
PP_TYPECHECK_EOF
fi

# ---- project hook seam: cohort-stats/vitest/seed-validation/pytest/lockstep gates ----
# pp_project_pricing_and_seed_gates is defined by scripts/hooks/pre-push-project.sh when that file
# exists (sourced earlier by the scripts/hooks/pre-push.sh dispatcher, which also sets
# PP_PROJECT_PRESENT); a checkout with no project file has PP_PROJECT_PRESENT=0, so
# pp_run_project_seam no-ops WITHOUT consulting PATH at all — the "core gates alone"
# contract (plan 3963), immune to an unrelated PATH executable of this name (finding
# fb9352). A present-but-broken project file (a renamed/dropped function) was already
# caught LOUDLY, once, up top — see the PP_PROJECT_SEAMS validation block (finding
# 6aa9d3) — so by the time this line runs, PP_PROJECT_PRESENT=1 means the function is
# guaranteed to exist.
pp_run_project_seam pricing_and_seed_gates

# Coordination + landing-spine script tests (plan 338). The scripts/*.test.mjs
# suite — board, index, coord-git, queue-drain, landing-lock, AND the
# done-worktree landing spine (done-worktree*.test.mjs) — ran NOWHERE automatic
# before this: a regression in the landing spine or the coordination helpers
# shipped green (the same UNWIRED gap plan 327 fixed for the backend/scripts
# pytest suite). Gated on a scripts/*.mjs diff.
#
# COST + CONCURRENCY (plan 1673, measured 2026-07-10). The suite is NOT "~2s" — that claim was
# written when it was a handful of files and is long dead: it is 99 test files / 2336 tests, each
# file a node worker, several driving REAL git in throwaway repos. Measured cold, ALONE on an idle
# machine: 6m43s wall. The cost driver is Windows process-spawn overhead (hundreds of real git.exe
# spawns at ~100-200ms each), NOT AV scanning — an EICAR probe verified 2026-07-27 (plan 2530) that
# both the battery's temp-repo path and the repo itself are Defender-excluded. Worse, it ran
# UNSCOPED and UNSERIALIZED: under the 5-7
# session parallel herd, every coordWrite push fired a whole battery and 9-10 ran CONCURRENTLY
# (162 live git.exe, ~15 process creations/sec, kernel paged pool 6.1 GB in 5h → reboot required).
# Plan 1673 fixes both axes and BOTH fail SAFE, because a battery that does not run is worse than a
# slow one:
#   1. DELTA-SCOPE — `scripts/select-battery-tests.mjs` reads $CHANGED on stdin and prints the test
#      subset (changed tests + name-paired tests + reference-closure dependents). ANY non-zero exit
#      (malformed input, empty selection, crash) means "run the FULL battery", never "run nothing".
#      `PREPUSH_FULL_BATTERY=1` forces the full glob.
#   2. MACHINE-WIDE MUTEX — `scripts/battery-lock.mjs` serializes batteries across every worktree of
#      this clone (O_EXCL lockfile in the shared .git common dir). Serialization is LOAD-SHEDDING,
#      NEVER a test-skip: a queue-wait expiry (exit 4) logs one line and runs the battery ANYWAY,
#      unserialized — i.e. exactly the pre-1673 behaviour. Plan 1679 SIZE-GATES the acquire's wait
#      (short for a small subset, the module default for a full glob or a large subset) and
#      re-derives that default from a measured full-battery p95 — see the acquire block below and
#      scripts/battery-lock.mjs's header for the numbers.
# errexit-safe (plan 336): $CHANGED is captured ONCE above, and the gate is a
# `grep -q` inside an `if` — never a bare `VAR=$(… | grep …)` (that empty-match
# exit-1 under `sh -e` was the silent-abort footgun). Bypass: git push --no-verify.
#
# CLEAN GIT ENV + RETRY-ONCE (plan 2176): both now live with run_battery_with_retry()'s
# definition near the top of this hook — the ONE implementation this gate and the
# data-dependency gate below share. The CRITICAL clean-git-env incident (plan 338) and the
# plan-984 retry rationale moved there verbatim rather than being duplicated per call site.
#
# ORPHAN BOUND (plan 1674; operator released the timeout-first pin 2026-07-10) — a killed
# push (session kill / git timeout / aborted coordWrite retry) orphans this whole subtree:
# the sh wrappers die while `node --test` + its per-test-file worker keep running
# indefinitely (measured 2026-07-10: 10/10 live batteries orphaned, sh←sh←DEAD-PID
# ancestor chains, idle-worker count climbing 133→163 over ~1h). PRIMARY mechanism:
# scripts/prepush-job-wrapper.ps1 runs the battery inside a kill-on-close Windows Job
# Object AND watches its own parent's process handle. Either way the push dies, the tree
# dies with it: the wrapper killed alongside the push → its job handle closes → the KERNEL
# terminates the whole job; the wrapper survives while its parent dies (the measured
# non-uniform kill pattern) → the parent watch notices within ~500ms → the wrapper exits →
# same handle close, same kernel kill. Orphan lifetime ≈ 0, no clock to tune, zero
# false-rejection of a slow-but-passing battery. The wrapper ALSO enforces the 1200s cap —
# a job object cannot bound a HANG under a live parent; only a deadline can — by
# terminating the whole job with exit 124, deliberately matching GNU timeout's convention
# so run_battery_with_retry's loop needs no new branch. LAYERS (order matters — the wrapper is
# OUTERMOST so its parent-watch sees the hook's own sh, the process that actually dies
# with the push; the first integration nested it inside GNU timeout, whose verified
# defining property is SURVIVING ancestor death, which meant the watched parent never
# exited and the fast path never fired): sh → wrapper (job + parent-watch + 1500s
# backstop deadline) → sh → GNU `timeout --kill-after=30 1200` (the normal hang cap,
# running INSIDE the job where its survive-ancestor-death property is neutralized by job
# termination; its deadline also backstops a wedged wrapper from within) → node.
# battery-lock.mjs' reap backstop (plan 1673) covers anything that escapes all of it.
# CAP SIZING: 1200s ≈ 3× the worst measured cold full battery (403s, plan 1673) —
# the deadline exists to bound hangs, not police performance (the first cut's 600s sat
# only 1.5× over that measurement and risked killing a legitimately slow parallel-herd
# run; with the wrapper handling the orphan case, the cap no longer needs to be tight).
# `--kill-after=30` on the inner timeout is a defensive SIGKILL escalation if a hung
# process ignores the initial SIGTERM. A cap hit (exit 124; or 137 if kill-after
# escalated — note 137 is also what an UNRELATED external SIGKILL looks like, e.g. an
# OOM-kill or a manual `taskkill /F`; the log below is a best-guess label, not a
# certainty) is just another failed attempt to the retry loop — each attempt gets a fresh
# cap, so a persistently-hanging battery blocks the push for up to ~2×1230s ≈ 41 min
# typical worst case (~2×1500s ≈ 50 min if the inner timeout itself wedges and the
# wrapper's backstop deadline has to fire; on the plan-1795 reduced-parallelism OVERFLOW
# path the cap is 2400s, so the true outer worst case is ~2×2700s ≈ 90 min — size any
# external timeout and the battery-lock stale ceiling off THAT number, which
# battery-lock.test.mjs re-derives from this hook's largest BATTERY_CAP) before failing
# (plan-984 retry-once semantics
# unchanged; at 3× margin a cap hit is near-certainly a genuine hang, but hangs are rare
# enough that the shared loop beats a special no-retry branch). Hosts without powershell
# (non-Windows) fall back to the bare GNU-timeout shape at the same 1200s — the same
# bound minus the instant parent-death kill (the orphan mechanism is Windows-specific
# per plan 1674 Work 4 anyway). The
# `command -v timeout` precondition is HOISTED before the retry loop (PATH doesn't change
# between attempts; an in-loop sentinel risked colliding with a genuine exit-2 and eating
# the plan-984 retry) and HARD-FAILS — the outer backstop layer is not allowed to silently
# vanish, mirroring the pytest ModuleNotFoundError convention elsewhere in this hook (a
# missing-dependency failure is never a `--no-verify` situation — that bypasses every
# OTHER gate too, not just this one).
# plan 2176 finding 1: the test files this gate ACTUALLY EXECUTED (and passed) in this push,
# one per line — read by the data-dependency gate below to subtract its own selection against,
# so a push touching BOTH scripts/*.mjs and mapped data never runs the same test file twice
# (`wiki-loader-coverage.test.mjs` is reachable from both). Initialised empty HERE, outside the
# gate, because the gate below is skipped entirely on a diff with no scripts/*.mjs — an unset
# var would be an empty string anyway, but under `sh -e` the explicit init keeps the contract
# readable and immune to a future `set -u`. Deliberately records only files a real `node --test`
# ran: a pass-cache HIT, a fail, or a skipped gate all leave it EMPTY, so the data gate falls
# back to its full selection. Over-running is this mechanism's safe error, never under-running.
BATTERY_RAN_FILES=""

# ── plan 2279: the battery gate keys on the UNION of the push range and the CANONICAL diff ──
# The canonical diff is merge-base(origin/master, HEAD)..HEAD — the tree's own content diff vs
# master, identical for a branch's final force-push and its land's master merge-push where their
# PUSH RANGES differ (a range is an artifact of remote-ref state). Feeding the union to the
# trigger and the selector does two things the pass-cache needs (docs/coord/land-spine.md § The once-per-land proof cache):
#   1. the branch side actually RUNS (and records) the canonical selection — the plan-1838
#      dominant leak was final trees that never got a battery at all because the final push's
#      range carried no scripts/*.mjs, so the land's merge-push had nothing to hit;
#   2. selector monotonicity (more input paths → superset selection) guarantees the run covers
#      the canonical claim the cache keys on, so `record`'s sel-not-superset pin never fires in
#      hook flow.
# Fail direction: any git trouble leaves CANON_CHANGED empty and the union degrades to exactly
# the pre-2279 range-only gate. This can only ever ADD battery runs (the safe error), never
# remove one — a push whose range touches scripts still always gates. Every OTHER $CHANGED
# consumer (backend tiers, prettier, data-dependency gate, …) stays range-scoped on purpose.
CANON_CHANGED=""
if CANON_BASE=$(git merge-base origin/master HEAD 2>/dev/null) && [ -n "$CANON_BASE" ]; then
  if ! CANON_CHANGED=$(git diff --name-only "$CANON_BASE" HEAD 2>/dev/null); then
    CANON_CHANGED=""
  fi
fi
BATTERY_DELTA=$(printf '%s\n%s\n' "$CHANGED" "$CANON_CHANGED")
# plan 3295 E3: the battery's half of the once-per-land narrowing (see the pytest gate's own
# PYTEST_SCOPE_LIST comment and the resolution block up top). On a land's post-rebase push whose
# land already proved the battery green, the union above is REPLACED by the remainder since that
# proven tree — the canonical-diff union exists to make the branch push and the land's merge push
# agree on one selection, and inside a single land the proof already covers everything older than
# the baseline. Any git trouble leaves the union exactly as computed above (doubt runs more).
if [ -n "$PP_LAND_PROVEN_BATTERY_SHA" ]; then
  if _pp_battery_delta=$(git diff --name-only "$PP_LAND_PROVEN_BATTERY_SHA..HEAD" 2>/dev/null); then
    BATTERY_DELTA="$_pp_battery_delta"
    echo "pre-push: once-per-land — scripts-battery was proven green at $(printf '%.7s' "$PP_LAND_PROVEN_BATTERY_SHA") in this land; gating only the $(printf '%.7s' "$PP_LAND_PROVEN_BATTERY_SHA")..HEAD remainder (plan 3295)"
  else
    echo "pre-push: once-per-land — could not diff $PP_LAND_PROVEN_BATTERY_SHA..HEAD; gating the full canonical union instead (plan 3295, fail-safe)"
  fi
fi

# plan 3765: fires on ANY file under scripts/hooks/, not just .mjs. Hook logic moved there
# from .claude/hooks/, whose EXTERNAL_TREE_PREFIXES entry used to force a full battery on any
# hook change — shell hooks included. Without this the .sh guards (worktree-guard.sh,
# worktree-owner-guard.sh, main-checkout-clean-guard.sh, the two Stop/SessionStart shells)
# would match neither trigger, so their name-paired tests would never run and a broken
# master-push guard could land unproven (gpt-review round 1, b433a4/e60efb/11c953).
#
# plan 2875 cluster 5 (review fix): also fires on a change to THIS FILE (scripts/hooks/pre-push.sh)
# — before this, a diff touching only the hook itself matched neither this trigger nor
# done-worktree.mjs's land-time batteryPreflightNeeded (fixed alongside this), so a broken gate
# change could reach master with the scripts battery never proving it, at push time OR land time
# (finding dfc45c). select-battery-tests.mjs already treats this file as an external-tree path its
# flat import-closure selector cannot scope (NESTED_SCRIPTS_PATH_RX matches `scripts/hooks/…`), so
# once this trigger fires the selector below correctly falls back to the FULL battery on its own.
if printf '%s\n' "$BATTERY_DELTA" | grep -qE '^scripts/.*\.mjs$|^scripts/hooks/'; then
  # plan 1674/1715: a missing `timeout` binary is a precondition, not a per-attempt outcome
  # (PATH doesn't change between attempts) — checked ONCE here via the shared helper, before
  # delta-scoping/mutex even run, so it can never collide with a real exit code from the
  # wrapped command later. HARD-FAILS (never runs the battery with its outer backstop layer
  # silently missing); require_timeout_or_exit's message mirrors the pytest-ModuleNotFoundError
  # convention (a missing dependency is never a `--no-verify` situation — that bypasses every
  # other gate). Before plan 1715 the battery hand-rolled this exact `command -v timeout` check.
  require_timeout_or_exit "scripts/ diff"

  # 1. Delta-scope. BATTERY_FILES empty ⇒ full glob. The `if ! VAR=$(…)` shape keeps errexit
  # suspended for the capture (plan 336's bare-`VAR=$(… | grep …)` footgun), and EVERY failure
  # route lands on the full battery.
  BATTERY_FILES=""
  if [ "${PREPUSH_FULL_BATTERY:-0}" = "1" ]; then
    echo "pre-push: PREPUSH_FULL_BATTERY=1 — running the FULL scripts/*.test.mjs battery"
  elif ! BATTERY_FILES=$(printf '%s\n' "$BATTERY_DELTA" | node scripts/select-battery-tests.mjs); then
    BATTERY_FILES=""
    echo "pre-push: battery selector could not scope this delta — running the FULL battery (fail-safe)"
  fi
  # 0 is a MEANINGFUL default, not just defensive (plan 1678 batch review finding [7], re-scoped
  # at the plan-1674 merge): only the subset branch below sets a real count, so BATTERY_COUNT=0
  # is exactly "full-glob run" by the time the size-gate reads it — the gate keys on this, NOT on
  # `-n "$BATTERY_FILES"`, because plan 1674's defaulting line below re-fills BATTERY_FILES with
  # the literal glob pattern (making it non-empty for EVERY run, which would hand the full battery
  # the short small-subset wait). An unset var would also make the gate's `-le` error under `set -e`.
  BATTERY_COUNT=0

  # 1.5 Primary orphan bound: the shared PP_WRAPPER selection (see ORPHAN BOUND above).
  # plan 1715: the battery no longer re-derives its own wrapper-detection — that hand-rolled
  # twin (BATTERY_WRAPPER) was a near-verbatim duplicate of PP_WRAPPER's probe up top and had
  # already drifted from it (differently-worded MISSING warning). PP_WRAPPER/PP_BOUND_DESC were
  # selected once, at the top of this hook, via the exact same powershell-builtin + wrapper-file
  # probe (and PP_WRAPPER already emits the missing-file warning there, for every gate). The
  # battery only appends its cap-specific suffix so the count echoes below still tell the truth
  # about the 20-min per-attempt cap this gate applies. The layered invocation itself now runs
  # through run_bounded() (below), so BATTERY_WRAPPER is gone entirely.
  # Worded cap-agnostically: this echoes BEFORE the mutex acquire decides the actual cap
  # (1200s normal, 2400s on the plan-1795 reduced-parallelism overflow path).
  BATTERY_BOUND_DESC="$PP_BOUND_DESC, 1200s cap per attempt (2400s on mutex-wait overflow)"

  # plan 2875: the count is computed HERE (the demotion decision below needs it) but the
  # "running …" announcement is held until the non-demoted branch actually takes it.
  # Otherwise a demoted push prints "running the FULL battery" and then, two lines later,
  # "DEFERRING the battery" — a flat contradiction in the one output a developer reads to
  # find out what just happened. Observed live on this plan's own first push under the new
  # hook, which is exactly the sort of thing only a real run surfaces.
  BATTERY_ANNOUNCE=""
  if [ -n "$BATTERY_FILES" ]; then
    BATTERY_COUNT=$(printf '%s\n' "$BATTERY_FILES" | wc -l | tr -d ' ')
    BATTERY_ANNOUNCE="pre-push: scripts/ diff — running node --test on $BATTERY_COUNT selected test file(s) (clean git env, $BATTERY_BOUND_DESC; PREPUSH_FULL_BATTERY=1 forces the full battery)"
  else
    BATTERY_ANNOUNCE="pre-push: scripts/ diff — running node --test scripts/*.test.mjs (clean git env, $BATTERY_BOUND_DESC)"
  fi
  # Default the delta-scoped list to the full glob AFTER the count echo above: the variable
  # is expanded UNQUOTED in the invocation below, so the literal pattern glob-expands at
  # expansion time (POSIX pathname expansion applies to the result of parameter expansion) —
  # ONE invocation line per bound-shape instead of a duplicated per-branch pair.
  #
  # plan 3959 T1: the flat `scripts/*.test.mjs` glob never reaches a NESTED test file
  # (scripts/coord/<name>.test.mjs, scripts/<subdir>/<name>.test.mjs, scripts/lib/decision-dossier/
  # inline.test.mjs) — select-battery-tests.mjs's own listTestFiles() now walks the whole tree,
  # so the "cannot scope this delta, run everything" fallback must too, or the fallback would
  # silently run FEWER tests than a scoped selection sometimes does. APPENDED to the flat literal
  # (the quoted concatenation below is one assignment, `'scripts/*.test.mjs'` immediately abutting
  # a second quoted segment — no word-splitting applies to an assignment RHS regardless of
  # quoting, so this is exactly one multi-line value) rather than replacing it outright, for two
  # reasons: battery-pass-cache.mjs's isUniversalSelection sentinel is that exact one-line string
  # (a widened selection still reaches its safe fallback either way — a non-flat entry trips
  # closurePathsForSelection's OWN 'non-flat-test-path' -> whole-tree-key path — but keeping the
  # sentinel intact is the smaller, more obviously-safe diff); and pre-push-battery-cap.test.mjs
  # pins this exact substring verbatim. `find` (not a bash-only `**`/globstar) so this stays
  # POSIX-sh portable — the shebang is `#!/usr/bin/env sh`, and dash's `**` is not recursive.
  [ -n "$BATTERY_FILES" ] || BATTERY_FILES='scripts/*.test.mjs'"
$(find scripts -mindepth 2 -name '*.test.mjs' -not -path '*/node_modules/*' -not -path '*/test-helpers/*' -not -path '*/__golden__/*' | sort)"

  # sel for both the deferral telemetry below AND the plan-2530 line further down (that
  # second assignment is left in place, unchanged, recomputing the identical value on the
  # non-deferred path — cheap and avoids reflowing the pass-cache section that follows).
  BATTERY_TELEM_SEL=full
  [ "$BATTERY_COUNT" -gt 0 ] && BATTERY_TELEM_SEL="$BATTERY_COUNT"

  # ── plan 2875 cluster 6: the shared LOCAL-push demotion decision ────────────────────────
  # Calls the SAME _should_locally_defer the pytest gate above calls (see its own header
  # comment for the full rationale and why this used to be a duplicated inline block) — a
  # large or full selection is exactly the shape the operator's own measurement says
  # dominates gate time on THIS machine; a cloud drain never demotes (see PP_IS_LOCAL_PUSH's
  # header comment, up top). PREPUSH_FULL_BATTERY=1 is the developer's own pre-existing
  # escape hatch and stays fully honored, in full, locally — deferring a push that explicitly
  # asked to force the full battery would defeat the flag.
  _should_locally_defer "$BATTERY_COUNT" "${PREPUSH_FULL_BATTERY:-0}"
  BATTERY_LOCAL_DEFER=$_DEFER
  if [ "$BATTERY_LOCAL_DEFER" = 1 ]; then
    # plan 2875 cluster 6 (review fix, finding 72191b): the suggested recovery command used to be
    # a bare `node --test scripts/*.test.mjs` — itself a violation of the very queue-ticket rule
    # this plan's own hardening enforces elsewhere (CLAUDE.md: "wrap any other heavy run ... in
    # node scripts/queued-run.mjs <cmd…>"). Suggest the wrapped form instead, mirroring the pytest
    # gate's own recovery hint just above.
    # plan 3235: the recipe carries the same hang backstop the real invocation site above uses —
    # this is a hand-run command an operator copies verbatim, so a hand-run battery gets the same
    # per-test cap as the automated one instead of being the one entry point the fix never reaches.
    # plan 3242: the cap is interpolated from $BATTERY_TEST_TIMEOUT_MS, so the recipe can no longer
    # drift from the invocation site the way a hand-copied literal did.
    echo "pre-push: LOCAL push — scripts/*.test.mjs selection is $BATTERY_TELEM_SEL file(s) (over the ${PREPUSH_LOCAL_DEMOTE_MAX_FILES}-file local threshold, or a full/unselectable run) — DEFERRING the battery to the land preflight (plan 2875; a cloud drain always runs this gate in full, see docs/coord/cloud-drains.md). Get a real verdict now anyway: PREPUSH_FULL_BATTERY=1 git push, or node scripts/queued-run.mjs -- node --test --test-timeout=$BATTERY_TEST_TIMEOUT_MS --test-force-exit scripts/*.test.mjs."
    scripts_node_test_ok=1
    gate_outcome scripts-battery skipped 0 "$BATTERY_TELEM_SEL"
  else
  # plan 2875: the held "running …" announcement (built above) fires HERE, on the branch that
  # actually runs, so a demoted push never claims to be running what it just deferred.
  echo "$BATTERY_ANNOUNCE"
  # 1.7 Battery pass-cache (plan 1824) — content-addressed skip of a run whose EXACT gated
  # content + selection already passed (canonically: a land's master merge-push re-gating the
  # tree its branch force-push just gated; that redundancy is plan 1807's lever 1, subsumed by
  # this cache). `check` hashes the scripts tree + every external-tree prefix the battery can
  # read + the lockfile + the selection; ANY dirt/doubt is exit 3 (uncacheable) and the flow
  # below runs untouched — the cache can only skip a run whose content already ran green, never
  # narrow or skip an unproven one (the plan-1673 fail-safe direction, unchanged). A HIT skips
  # the battery AND the mutex acquire (the convoy-collapse half: a hit holds no lock, so queued
  # siblings behind a ripple stop paying for re-tests of identical content). Exit codes:
  # 0 HIT · 2 MISS (key on stdout for the record below) · 3/other uncacheable (no key, no record).
  # PREPUSH_FULL_BATTERY=1 bypasses the cache entirely (a forced full run must actually run and
  # is deliberately not recorded — it ran outside the cache's contract); PREPUSH_NO_BATTERY_CACHE=1
  # is the kill-switch if a skipped battery is ever suspected of masking a failure
  # (docs/coord/land-spine.md § The once-per-land proof cache). errexit-safe: the `|| STATUS=$?` consumes the
  # failing assignment's status, same shape as the acquire below.
  BATTERY_CACHE_KEY=""
  # plan 3223 (re-review finding A): the raw selection BATTERY_CACHE_KEY was derived FROM,
  # captured at the SAME instant as the key itself (right beside its assignment below) — never
  # re-read from $BATTERY_FILES later, so a future edit that reassigns $BATTERY_FILES between
  # here and the run_battery_with_retry call can't silently make this pairing stale. Threaded
  # into run_battery_with_retry as RBR_LEDGER_SELECTION; see that function's own guard.
  BATTERY_CACHE_KEY_SELECTION=""
  BATTERY_CACHE_HIT=0
  BATTERY_CACHE_MERGE_BASE=""
  if [ "${PREPUSH_NO_BATTERY_CACHE:-0}" = "1" ]; then
    echo "pre-push: PREPUSH_NO_BATTERY_CACHE=1 — battery pass-cache disabled for this push"
  elif [ "${PREPUSH_FULL_BATTERY:-0}" != "1" ]; then
    BATTERY_CACHE_STATUS=0
    # plan 2559: check ALSO pins the merge-base(origin/master, HEAD) baseline it resolved for the
    # canonical-selection key component to a scratch file, so the `record` call at the bottom of
    # this gate — which runs AFTER the whole battery, sometimes minutes later — can reuse that
    # EXACT baseline instead of re-asking origin/master, which a sibling session's `git fetch` may
    # have moved in between (RECORD-REFUSED reason=key-drift, measured 8/218 records over 3.1 days
    # — docs/coord/land-spine.md § The once-per-land proof cache). A missing/unwritable file just
    # leaves BATTERY_CACHE_MERGE_BASE empty below, which record's own --merge-base handling treats
    # exactly like "not provided" — re-resolve fresh, i.e. today's behavior. This can only ever
    # widen the key-drift exposure back to today's baseline, never narrow correctness.
    BATTERY_CACHE_MERGE_BASE_FILE="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/battery-cache-mb-$$")"
    # Bare GNU timeout, NOT run_bounded (delta-review finding, plan 1824): the cache CLI is a
    # single short node process (a few git spawns, no test tree), and run_bounded's PP_WRAPPER
    # arm would add a full PowerShell spawn (~150-400ms) to the exact fast path this cache exists
    # to create — per call, up to 3x per push. Bare timeout keeps the hang cap (a probe stalled
    # on git contention dies at 120s; timeout is guaranteed by the require_timeout_or_exit
    # above); the un-jobbed worst case is one ≤120s straggler pair, not the plan-1674 orphaned
    # test TREE the wrapper exists for. A 124 cap-kill lands in the non-0/non-2 branch below ⇒
    # uncacheable ⇒ the battery runs — the fail direction is unchanged.
    BATTERY_CACHE_KEY=$(printf '%s\n' "$BATTERY_FILES" | timeout --kill-after=30 120 node scripts/battery-pass-cache.mjs check --merge-base-out "$BATTERY_CACHE_MERGE_BASE_FILE") || BATTERY_CACHE_STATUS=$?
    # plan 3223 (re-review finding A): capture the exact raw string just piped into `check`
    # above, right beside it — see BATTERY_CACHE_KEY_SELECTION's own init comment above.
    BATTERY_CACHE_KEY_SELECTION="$BATTERY_FILES"
    if [ -f "$BATTERY_CACHE_MERGE_BASE_FILE" ]; then
      BATTERY_CACHE_MERGE_BASE=$(cat "$BATTERY_CACHE_MERGE_BASE_FILE" 2>/dev/null) || BATTERY_CACHE_MERGE_BASE=""
      rm -f "$BATTERY_CACHE_MERGE_BASE_FILE"
    fi
    if [ "$BATTERY_CACHE_STATUS" = 0 ] && [ -n "$BATTERY_CACHE_KEY" ]; then
      BATTERY_CACHE_HIT=1
    elif [ "$BATTERY_CACHE_STATUS" != 2 ]; then
      # Uncacheable (dirty gated paths, git error, crash): no key ⇒ the pass below is not
      # recorded either. Fail-closed to exactly today's behavior.
      BATTERY_CACHE_KEY=""
    fi
  fi

  # plan 2530: sel is the battery's own selection axis (never the shared gate_needs_run
  # cache — the battery has always used its OWN battery-pass-cache.mjs, see the header above).
  BATTERY_TELEM_SEL=full
  [ "$BATTERY_COUNT" -gt 0 ] && BATTERY_TELEM_SEL="$BATTERY_COUNT"

  # plan 3274 (D1): a pass-cache HIT (handled right below) needs no budget at all — nothing
  # runs — so this check is skipped for that case. Otherwise, in cloud-chunked mode, too little
  # of the shared deadline left means this gate must NOT start (never a silent skip — exits the
  # whole push red with a resumable chunk report, same contract as the pytest gate's own
  # PYTEST_CHUNK_NOSTART check above).
  # plan 3620: same as the pytest did-not-start seat's own comment — the non-convergence bound
  # deliberately does not reach this branch. The gate never ran, so there is no round to score
  # (done-worktree.mjs's scoreChunkRound `ranProven === false` case); a later push with more
  # budget left may start and finish it cleanly.
  if [ "$BATTERY_CACHE_HIT" != 1 ] && [ "$PREPUSH_CHUNK_MODE" = 1 ]; then
    _pp_remaining=$(prepush_remaining_budget)
    if [ "$_pp_remaining" -lt "$PREPUSH_MIN_CHUNK_S" ]; then
      prepush_chunk_report scripts-battery "0 files proven green — the shared push deadline left less than ${PREPUSH_MIN_CHUNK_S}s, so this gate never started."
      gate_outcome scripts-battery chunked 0 "$BATTERY_TELEM_SEL"
      exit 1
    fi
  fi

  scripts_node_test_ok=0
  if [ "$BATTERY_CACHE_HIT" = 1 ]; then
    scripts_node_test_ok=1
    gate_outcome scripts-battery cache-hit 0 "$BATTERY_TELEM_SEL"
    echo "pre-push: battery pass-cache HIT — this exact gated content + selection already passed within the TTL; skipping the battery run AND the mutex acquire (key $BATTERY_CACHE_KEY; force a run: PREPUSH_FULL_BATTERY=1, disable the cache: PREPUSH_NO_BATTERY_CACHE=1)"
  else
    # ↓ plan-1824 MISS/uncacheable arm: EVERYTHING from the mutex acquire (step 2) through the
    # release (step 3) below is inside this else — deliberately NOT re-indented (the battery-lock
    # tests derive literals from this hook's text, and a flat re-indent would churn every line).
    # A new gate step added between here and the closing `fi` (marked with the same plan tag)
    # runs only on a cache miss — put post-battery steps AFTER that fi if they must always run.

  # 2. Machine-wide mutex, SIZE-GATED (plan 1679). stdout is the token and nothing else;
  # diagnostics go to stderr. A non-zero acquire (queue-wait expiry, or any lock error) leaves the
  # token empty and we run the battery anyway — serialization is load-shedding, never a test-skip.
  # This is the ONE code path for every selection size — never a skip-the-mutex branch — but a
  # subset at or below BATTERY_SMALL_MAX files gets a SHORT --timeout-sec instead of the module
  # default: `select-battery-tests.mjs` measures a leaf-module delta at 2 selected files (its own
  # header comment), so waiting the full default (re-derived in battery-lock.mjs to outlast a full
  # battery, ~10 minutes) behind an unrelated run is pure added push latency for a run that was never
  # the load problem. A full glob, OR a selection ABOVE the threshold (a hub-module delta can select
  # up to 58 of ~104 files — effectively full-battery cost), waits the module default.
  # CAVEAT (measured 2026-07-10, plan 1679): file COUNT is an imperfect proxy for wall time — a
  # handful of test files (e.g. worktree-guard.test.mjs, coord-git.test.mjs) spin real git
  # repos/worktrees and can individually run 70s+ (Windows process-spawn overhead, not AV scanning —
  # verified 2026-07-27, plan 2530), so a small-BY-COUNT selection can still be
  # a heavy LOAD case that a 30s wait under-serializes. The threshold is biased low deliberately (the
  # plan's own asymmetry: over-serializing is the safe error) but this is a known residual gap, not a
  # guarantee — out of scope for this plan to close (no per-file cost model exists).
  BATTERY_SMALL_MAX=5
  # --holder-pid (plan 2549): declare THIS hook shell — the process that actually spans the whole
  # battery run — as the lock's long-lived holder, so a same-host waiter can reap the lock the
  # moment this shell dies (killed session, crash, BSOD) instead of waiting out the 120-min age
  # ceiling. It must be a WINDOWS pid: on Git-for-Windows sh, `$$` is an MSYS-namespace pid that
  # node's process.kill cannot probe (a live holder could read as DEAD — the one error direction
  # the design forbids), so translate via /proc/$$/winpid; on Linux the fallback `$$` IS the
  # probeable pid. battery-lock.test.mjs derives this wiring from the hook text (the
  # DEFAULT_STALE_MIN pattern) and fails on drift — without the flag the liveness reap silently
  # never fires.
  # The fallback when /proc/$$/winpid is unreadable is PLATFORM-SPLIT (plan 2734 review), because
  # `$$` is right on Linux and wrong on MSYS — there it is the very untranslated pid the translation
  # exists to avoid. Handing it over anyway was the ONLY path by which a wrong-namespace pid could
  # reach the lock, and battery-lock's self-check catches it only when that pid happens not to exist
  # as a Windows pid; a collision with an unrelated LIVE process would pass the check and then let a
  # waiter reap this lock the moment that stranger exits. So on MSYS we declare NOTHING instead: an
  # undeclared holder is age-only by design (slower reap after a crash, never a false one), which is
  # the safe error direction. The self-check stays as defense in depth for any other caller.
  # Platform detected with `uname -s`, NOT the OSTYPE variable: this file declares `#!/usr/bin/env sh`, and
  # OSTYPE is a bash-ism — under dash/ash it is simply unset, which would fall through to the
  # `$$` branch on the very platform that branch is wrong for (review round 4). One spawn, once
  # per push, only on the fallback path. The case is a DENYLIST of the Windows-emulation platforms
  # (the only ones where `$$` is not a probeable pid) plus an unusable uname — declaring nothing
  # costs a slower reap, declaring a wrong pid costs a live lock reaped out from under a running
  # battery. An allowlist of Linux/Darwin/BSD was the first cut and silently demoted every other
  # real Unix (Solaris, AIX) to age-only for no reason (review round 5); MSYS and Cygwin both
  # identify themselves in uname, so the denylist loses nothing that mattered.
  BATTERY_HOLDER_PID=$(cat /proc/$$/winpid 2>/dev/null || true)
  if [ -z "$BATTERY_HOLDER_PID" ]; then
    case "$(uname -s 2>/dev/null)" in
      MINGW* | MSYS* | CYGWIN* | '') BATTERY_HOLDER_PID="" ;; # no probeable pid / can't tell
      *) BATTERY_HOLDER_PID=$$ ;;                             # any real Unix: $$ IS probeable
    esac
  fi
  BATTERY_ACQUIRE_ARGS="--label prepush-$$${BATTERY_HOLDER_PID:+ --holder-pid $BATTERY_HOLDER_PID}"
  # Keyed on BATTERY_COUNT (0 ⇔ full glob — see its init above), NOT `-n "$BATTERY_FILES"`:
  # plan 1674's defaulting line re-fills BATTERY_FILES with the literal glob pattern before this
  # point, so the emptiness test would be true for every run and hand the FULL battery the short
  # small-subset wait.
  if [ "$BATTERY_COUNT" -gt 0 ] && [ "$BATTERY_COUNT" -le "$BATTERY_SMALL_MAX" ]; then
    BATTERY_ACQUIRE_ARGS="$BATTERY_ACQUIRE_ARGS --timeout-sec 30"
  fi
  # Overflow at REDUCED parallelism (plan 1795; operator-decided direction). The acquire's exit
  # status is now OBSERVED, not just truthiness-tested: exit 4 (EXIT_TIMEOUT — the queue wait
  # expired, i.e. the machine is ALREADY saturated behind a live holder) still runs the battery
  # (never a test-skip, never a starved push — the 2026-07-10 anti-starvation ruling survives)
  # but clamps `node --test` to --test-concurrency=2 (OVERFLOW_TEST_CONCURRENCY in
  # battery-lock.mjs — the canonical definition + sizing rationale; battery-lock.test.mjs
  # derives this literal from the hook text and fails on drift), so an overflow adds ~2 workers
  # to the storm instead of ~one-per-core — the 2026-07-13 amplification (894 procs, 3 concurrent
  # full batteries) came from exactly these expired waiters running at full width. Any OTHER
  # non-zero (exit 5 — a lock ERROR: flag typo, fs refusal) is NOT a load signal and keeps the
  # pre-1795 full-parallelism unserialized run. A clamped run is slower, so its per-attempt cap
  # DOUBLES to 2400s (a full-glob battery at concurrency 2 exceeds the normal 1200s hang cap by
  # design, not by hang) — DEFAULT_STALE_MIN's derivation test re-derives the worst case from the
  # LARGEST cap here, and 2×(2400+300)s = 90min still clears the 120min ceiling.
  # KNOWN over-clamp (review 2026-07-13, accepted): battery-lock's reap-exhaustion path
  # (>10 consecutive reaps — an fs anomaly, not saturation) also exits 4 and lands here, so a
  # rare contention burst on a small-subset push gets the clamp it didn't need. Deliberate:
  # over-serializing is this whole mechanism's safe error direction, the cost is seconds on a
  # ≤5-file battery, and splitting the exit-code contract for it would put a third code into
  # every consumer for a path that has never been observed in production.
  # errexit-safe: the `|| BATTERY_ACQ_STATUS=$?` consumes the failing assignment's status.
  BATTERY_TOKEN=""
  BATTERY_ACQ_STATUS=0
  BATTERY_CAP=1200
  BATTERY_CONC_ARGS=""
  BATTERY_TOKEN=$(node scripts/battery-lock.mjs acquire $BATTERY_ACQUIRE_ARGS) || BATTERY_ACQ_STATUS=$?
  if [ "$BATTERY_ACQ_STATUS" != 0 ]; then
    if [ "$BATTERY_ACQ_STATUS" = 4 ]; then
      # plan 2734: exit 4 NO LONGER means "no lock is held". The waiter may have been ADMITTED to
      # the single overflow slot, in which case its token is on stdout and holding it is what stops
      # a second timed-out waiter from joining this clamped run. So KEEP the token here (the release
      # step below frees it, and `release --token` probes both tiers so the hook never needs to know
      # which one granted it). An unadmitted exit 4 simply prints no token and $BATTERY_TOKEN stays
      # empty, exactly as before. Blanking it — the pre-2734 line that used to sit here — would leak
      # the slot until its reap and silently re-open the admission control.
      BATTERY_CONC_ARGS="--test-concurrency=2"
      BATTERY_CAP=2400
      # Arm the re-run's lock attempt (plan 2734, arm D — see run_battery_with_retry): ONLY on this
      # unserialized path, so the data-dependency gate's use of that shared function is untouched.
      RBR_RERUN_LOCK=1
      # $BATTERY_CONC_ARGS in the echo, never a second hardcoded literal — a clamp change would
      # update the assignment (drift-tested against OVERFLOW_TEST_CONCURRENCY) but not a copy.
      if [ -n "$BATTERY_TOKEN" ]; then
        echo "pre-push: battery ADMITTED to the overflow slot — running at REDUCED parallelism ($BATTERY_CONC_ARGS, ${BATTERY_CAP}s cap; tests are never skipped)"
      else
        echo "pre-push: battery queue-wait expired with the overflow slot taken — running the battery UNSERIALIZED at REDUCED parallelism ($BATTERY_CONC_ARGS, ${BATTERY_CAP}s cap; tests are never skipped)"
      fi
    else
      BATTERY_TOKEN=""
      echo "pre-push: battery mutex not acquired (status=$BATTERY_ACQ_STATUS) — running the battery UNSERIALIZED (tests are never skipped)"
    fi
  fi

  # plan 2176: the attempt/ok/status/retry/clean-env loop this block used to carry inline is
  # now run_battery_with_retry() (defined near the top of this hook, with the CRITICAL
  # clean-git-env and RETRY-ONCE rationale). The cap is $BATTERY_CAP since plan 1795: 1200s
  # normally, 2400s on the reduced-parallelism overflow path (see the acquire block above),
  # where $BATTERY_CONC_ARGS carries the --test-concurrency clamp (empty otherwise).
  # QUOTING IS LOAD-BEARING AND ASYMMETRIC HERE — do not "tidy" it:
  #   "$BATTERY_CONC_ARGS" MUST stay QUOTED. It is positional arg 3, which the function peels
  #   off with `shift 3`. On the normal (non-overflow) path it is EMPTY, and an unquoted empty
  #   var vanishes from the argument list entirely — so arg 3 would become the FIRST selected
  #   test file, which `shift 3` then discards, silently dropping that file from the battery.
  #   It is re-expanded UNQUOTED *inside* the function (as $_rbr_conc) where vanishing is the
  #   desired behaviour: there it must not become an empty argv element in front of node's
  #   positional paths.
  #   $BATTERY_FILES MUST stay UNQUOTED. It is the variadic tail, and it has to word-split (a
  #   selected list) or pathname-expand (the defaulted literal glob) into the function's "$@"
  #   here, at the call site — the same expansion the inline loop performed.
  # Both shapes stay orphan-bounded (plan 1674) so a killed push can never leave the worker
  # tree running.
  # plan 3223: opt this gate INTO ledger participation (mirrors RBR_RERUN_LOCK's own per-caller
  # opt-in, disarmed the same way immediately below) — the data-dependency gate's own
  # run_battery_with_retry call further down never sets this, so its behaviour stays untouched
  # (E3).
  RBR_LEDGER=1
  # plan 3223 (review round: finding 8/CONFIRMED): hand run_battery_with_retry the SAME content
  # key $BATTERY_CACHE_KEY the pass-cache `check` call above already derived for this exact
  # selection — never re-derived a second time inside the function. Empty exactly when
  # $BATTERY_CACHE_KEY is (an uncacheable/dirty tree, or the cache disabled) — the fail-safe
  # direction, same as before this fix: no key ⇒ no ledger participation ⇒ run everything.
  RBR_LEDGER_KEY="$BATTERY_CACHE_KEY"
  # plan 3223 (re-review finding A): the raw selection the key above was derived from, captured
  # at that same instant (BATTERY_CACHE_KEY_SELECTION) — never $BATTERY_FILES read fresh here,
  # so run_battery_with_retry's guard can catch it if the two ever drift apart. See that
  # function's own header for what this proves.
  RBR_LEDGER_SELECTION="$BATTERY_CACHE_KEY_SELECTION"
  # plan 3274 (D1): derive THIS call's cap from whatever remains of the shared deadline —
  # computed HERE, at the call site, per D1's "not a per-gate cap" contract (the mutex-wait
  # above can itself eat real time, so re-reading the clock this late is deliberate, not lazy).
  # Floored at 1s so run_bounded/`timeout` always receives a valid positive duration; a
  # near-zero remainder still attempts a run and lets the real cap-kill-to-chunked
  # reclassification below handle it, rather than adding a second NOSTART special-case this
  # deep inside the mutex-acquired territory. Byte-identical to before this plan whenever
  # chunk mode is off (D2) — $BATTERY_CAP is untouched below in that case.
  # plan 3274 (F3 fix): $_battery_natural_cap is $BATTERY_CAP's value BEFORE the shrink below —
  # the gate's own natural cap (1200s, or 2400s on the mutex-wait overflow path), captured here
  # because the very next lines may overwrite $BATTERY_CAP itself. The failure branch below
  # compares $RUN_BATTERY_LAST_CAP (the cap the LAST attempt was actually bounded by, per F2)
  # against this natural cap to decide whether a cap-kill was genuinely OUR chunk deadline
  # (reclassify to "chunked") or the gate's own natural cap firing first — mirrors
  # chunkCapDecision's usingChunkCap in done-worktree.mjs.
  _battery_natural_cap="$BATTERY_CAP"
  if [ "$PREPUSH_CHUNK_MODE" = 1 ]; then
    _pp_remaining=$(prepush_remaining_budget)
    [ "$_pp_remaining" -lt 1 ] && _pp_remaining=1
    [ "$_pp_remaining" -lt "$BATTERY_CAP" ] && BATTERY_CAP=$_pp_remaining
    echo "pre-push: chunk mode — scripts-battery cap derived from the shared push deadline: ${BATTERY_CAP}s remaining"
  fi
  _t0=$(date +%s) || _t0=0
  run_battery_with_retry "scripts" "$BATTERY_CAP" "$BATTERY_CONC_ARGS" $BATTERY_FILES
  scripts_node_test_ok=$RUN_BATTERY_OK
  BATTERY_TELEM_DUR=$(elapsed_since "$_t0")
  # Disarm arm D immediately (plan 2734). RBR_RERUN_LOCK is a per-CALL opt-in, but this hook runs
  # both battery gates in ONE shell, so leaving it set here would silently arm the re-run acquire
  # for the data-dependency gate's own run_battery_with_retry call further down — the exact
  # cross-gate leak that makes "the other caller is byte-identical" false. Reset, don't unset: `sh -e`
  # with a future `set -u` must still find the variable defined.
  RBR_RERUN_LOCK=0
  # plan 3274: capture the ledger key THIS call actually used, before the plan-3223 disarm just
  # below blanks RBR_LEDGER_KEY back to "" for the data-dependency gate's own call further down —
  # the chunk-report path in the failure branch needs it after that disarm has run. It sits AFTER
  # the RBR_RERUN_LOCK reset above, not before it, on purpose: the battery-lock test pins
  # that reset within 900 chars of the run_battery_with_retry "scripts" call it disarms, and this
  # block between the two pushed it to 953. Only the RBR_LEDGER_KEY blanking below has to happen
  # after this capture; RBR_RERUN_LOCK is an unrelated variable, so the order is free.
  _battery_ledger_key_used="$RBR_LEDGER_KEY"
  # plan 3223: disarm the ledger opt-in AND its key the same way, for the same reason — an
  # inherited RBR_LEDGER_KEY would otherwise ride into the data-dependency gate's own
  # run_battery_with_retry call further down, which leaves RBR_LEDGER itself unset (so it stays
  # inert there regardless — belt-and-suspenders, matching RBR_LEDGER's own disarm below).
  RBR_LEDGER=0
  RBR_LEDGER_KEY=""
  RBR_LEDGER_SELECTION=""

  # 3. Release before any exit path — including the failure exit below. `|| true` because a
  # close-out must never block a push. Its one-line confirmation goes to stderr; left unredirected
  # so a wedged lock is visible in the push output rather than silently swallowed.
  # TWO tokens can be outstanding since plan 2734: this gate's own (the serialized lock on exit 0,
  # or the overflow slot on an admitted exit 4) and the one run_battery_with_retry may have taken
  # for the re-run of an unserialized run (arm D). Each release call probes both tiers, so neither
  # needs to know which tier granted it, and a token that was never issued is simply skipped.
  for BATTERY_RELEASE_TOKEN in "$BATTERY_TOKEN" "$RUN_BATTERY_RERUN_TOKEN"; do
    if [ -n "$BATTERY_RELEASE_TOKEN" ]; then
      node scripts/battery-lock.mjs release --token "$BATTERY_RELEASE_TOKEN" || true
    fi
  done

  # Closes the plan-1824 pass-cache HIT/else — everything from the mutex acquire through the
  # release above runs only on a cache miss (or with the cache disabled/uncacheable).
  fi

  if [ "$scripts_node_test_ok" = 0 ]; then
    # plan 1824: a red run with a known key drops any (TTL-expired but still on disk) entry for
    # it — belt-and-suspenders so no stale pass can ever be resurrected for content that just
    # failed. `|| true`: close-out never blocks (the push is failing anyway, on the next line).
    if [ -n "$BATTERY_CACHE_KEY" ]; then
      timeout --kill-after=30 120 node scripts/battery-pass-cache.mjs invalidate --key "$BATTERY_CACHE_KEY" || true
    fi
    # review finding 1kp7gg8: branch cap vs real before logging, consistent with every other
    # run_bounded-wrapped gate this batch converted — a load-driven cap-kill on the final
    # attempt must not record a permanent result=fail (that poisons the never-failed ranking
    # the Phase 2 cost-weighted prune depends on). RUN_BATTERY_STATUS is run_battery_with_retry's
    # last-attempt raw exit status (only meaningful here since $scripts_node_test_ok = 0).
    _battery_gc_result=$(battery_outcome_class "$RUN_BATTERY_STATUS" "$RUN_BATTERY_FAILED_FILES") || _battery_gc_result=fail
    # plan 3274 (D3): battery_outcome_class already ensures "cap-kill" here means NO `not ok`
    # evidence was ever observed across either attempt — real evidence always wins (dominates to
    # "fail" instead), so a cap-kill reaching this branch is EITHER the shared chunk deadline
    # ending the run, OR the gate's own natural cap firing on a genuine hang/runaway test. F3 fix
    # (review round, most dangerous of the five findings): the OLD condition here reclassified
    # EVERY cap-kill to "chunked" whenever chunk mode was merely ON, regardless of which cap
    # actually fired — so a real hang that tripped the gate's own 1200s/2400s cap got reported as
    # "not a test failure, push again", advising an infinite re-push loop over an invisible
    # defect. The extra clause below requires the chunk-derived cap to have been STRICTLY
    # smaller than the gate's own natural cap for THIS attempt (mirrors chunkCapDecision's
    # usingChunkCap in done-worktree.mjs) — only then is our shared deadline provably what ended
    # the run. When the natural cap was equal or smaller (chunking never bound, or was never
    # activated), this falls through unchanged to the generic "FAILED (both attempts)" wording
    # below — a real cap-kill, exactly as before this plan touched this gate.
    if [ "$PREPUSH_CHUNK_MODE" = 1 ] && [ "$_battery_gc_result" = cap-kill ] && [ "$RUN_BATTERY_LAST_CAP" -lt "$_battery_natural_cap" ]; then
      _battery_chunk_detail="progress recorded under key ${_battery_ledger_key_used:-n/a} (no per-file breakdown available for this run)."
      if [ -n "$_battery_ledger_key_used" ] && [ "$BATTERY_COUNT" -gt 0 ]; then
        # Real N/M/R — bounded via run_bounded (plan 3274 F2 review fix: an unbounded lookup HERE,
        # on the exact path that builds the chunk report, would print no report at all on a hang).
        # On any failure (cap-kill included), leave $_battery_chunk_detail at the "no per-file
        # breakdown available" default set above — an explicit "counts unavailable" reading, never
        # a fabricated "0 of M, M remaining" derived from a query that never actually answered.
        # plan 3274 (delta-review round, F4): clamp to whatever remains of the shared chunk
        # deadline too (same prepush_derive_attempt_cap reuse as the retry-loop lookup above) — by
        # the time this branch runs the push is ALREADY ending on a chunk cap, so a full
        # PREPUSH_LEDGER_REMAINDER_CAP_S here could itself run past the point the push should have
        # stopped. A no-op when chunking is off.
        _battery_ledger_cap=$(prepush_derive_attempt_cap "$PREPUSH_LEDGER_REMAINDER_CAP_S")
        if _battery_chunk_remainder=$(printf '%s\n' "$BATTERY_FILES" | run_bounded "$_battery_ledger_cap" node scripts/battery-ledger.mjs remainder --key "$_battery_ledger_key_used" 2>/dev/null); then
          _battery_chunk_m=$BATTERY_COUNT
          _battery_chunk_r=$(printf '%s\n' "$_battery_chunk_remainder" | grep -c .) || _battery_chunk_r=0
          _battery_chunk_n=$((_battery_chunk_m - _battery_chunk_r))
          _battery_chunk_detail="$_battery_chunk_n of $_battery_chunk_m files proven green under key $_battery_ledger_key_used, $_battery_chunk_r remaining."
        fi
      fi
      # plan 3620: same non-convergence consult as the pytest seat above, over the battery
      # namespace — only when a real key is in hand ($_battery_ledger_key_used non-empty), falling
      # through to the ordinary CHUNKED report on any doubt.
      # plan 3620 fix round (F1): $RUN_BATTERY_RAN_PROVEN is run_battery_with_retry's own captured
      # evidence (a non-empty per-attempt ledger reporter file — see _rbr_merge_ledger's own
      # comment) that the LAST attempt this call made actually executed, threaded through rather
      # than re-derived here.
      if [ -n "$_battery_ledger_key_used" ] && [ "$(prepush_chunk_round_is_nonconvergent chunk-round "$_battery_ledger_key_used" "$RUN_BATTERY_RAN_PROVEN")" = 1 ]; then
        prepush_nonconvergent_report scripts-battery "$_battery_chunk_detail"
      else
        prepush_chunk_report scripts-battery "$_battery_chunk_detail"
      fi
      gate_outcome scripts-battery chunked "$BATTERY_TELEM_DUR" "$BATTERY_TELEM_SEL" "$RUN_BATTERY_FAILED_FILES"
      exit 1
    fi
    gate_outcome scripts-battery "$_battery_gc_result" "$BATTERY_TELEM_DUR" "$BATTERY_TELEM_SEL" "$RUN_BATTERY_FAILED_FILES"
    echo "pre-push: scripts node:test FAILED (both attempts) — a real regression (or a repeated timeout). Fix the failing/hanging test, then re-push. Re-run the full battery with PREPUSH_FULL_BATTERY=1 if you suspect the subset missed a dependent. Bypass: git push --no-verify (investigate first)."
    exit 1
  fi
  # plan 1824: record the green run under the key `check` computed above (miss path only — a hit
  # never re-proves anything, and an uncacheable/disabled/forced run has no key). `record`
  # re-derives the key itself and refuses on drift, so a battery that mutated the repo (the
  # plan-338 incident class) can never be recorded. `|| true`: recording is close-out, never a
  # push blocker. --merge-base (plan 2559) threads the SAME baseline check resolved minutes ago —
  # empty is fine, record's own fallback treats it as "not provided" and re-resolves fresh.
  if [ "$BATTERY_CACHE_HIT" != 1 ] && [ -n "$BATTERY_CACHE_KEY" ]; then
    printf '%s\n' "$BATTERY_FILES" | timeout --kill-after=30 120 node scripts/battery-pass-cache.mjs record --key "$BATTERY_CACHE_KEY" --merge-base "$BATTERY_CACHE_MERGE_BASE" --label "prepush-$$" || true
  fi
  # plan 2530: the cache-HIT case already got its own gate_outcome call above (the "battery
  # pass-cache HIT" echo) — never double-log a green run that never actually ran this push.
  if [ "$BATTERY_CACHE_HIT" != 1 ]; then
    gate_outcome scripts-battery pass "$BATTERY_TELEM_DUR" "$BATTERY_TELEM_SEL"
  fi
  echo "pre-push: scripts node:test clean"

  # plan 2176 finding 1: publish what this gate actually EXECUTED, for the data-dependency
  # gate's set-difference. Reached only on the green path ($scripts_node_test_ok=1 — the red
  # path exited 1 above), and gated on a CACHE MISS: a pass-cache HIT proves the content
  # already passed but ran no test in THIS push, and "ran+passed" — not "was selected" — is
  # the only claim strong enough to justify skipping a run (§(b) of the plan: subtracting a
  # merely-selected file would silently skip a test the gate never executed).
  # plan 3223 (review round: finding 2/CONFIRMED): sourced from $RUN_BATTERY_RAN_FILES (the
  # per-attempt union run_battery_with_retry itself tracked — see that function's own comment),
  # NOT a re-serialization of $BATTERY_FILES. With RBR_LEDGER=1 (set above), a ledger-narrowed
  # remainder can mean some of $BATTERY_FILES never actually reached `node --test` this push — a
  # file the ledger had already proven green under this content key is real "ran+passed" evidence
  # from an EARLIER attempt/push, not from THIS push's own execution, and re-serializing
  # $BATTERY_FILES here claimed it had, which fed a false exclusion into plan 2070's
  # --exclude-ran below (the exact `wiki-loader-coverage.test.mjs` incident class that contract
  # exists to prevent). $RUN_BATTERY_RAN_FILES already degrades to exactly $BATTERY_FILES when
  # the ledger never narrowed anything (inactive, or every attempt ran its full selection) —
  # today's behavior, unchanged in that case. The assignment is `|| true`'d anyway: this is
  # close-out bookkeeping and must never abort the hook under `sh -e` (plan 336).
  if [ "$BATTERY_CACHE_HIT" != 1 ]; then
    BATTERY_RAN_FILES="$RUN_BATTERY_RAN_FILES" || BATTERY_RAN_FILES=""
  fi
  fi
  # ↑ closes the plan-2875 BATTERY_LOCAL_DEFER else-branch opened above (deliberately NOT
  # re-indented — same rationale as the plan-1824 pass-cache HIT/else block it wraps: a flat
  # re-indent of the whole cache+mutex+run+record section would churn nearly the entire gate
  # for a change that is trigger-condition-only, and battery-lock.test.mjs derives literals
  # from this hook's exact text).
fi

# plan 2197: publish $BATTERY_RAN_FILES to a tempfile so select-battery-tests.mjs's
# --data-triggered mode can read it via --exclude-ran (the cross-gate dedup itself — plan 2176
# finding 1 — now lives in that module, unit-tested, instead of as a second grep -vxF
# set-difference here). Cleaned up by the EXIT trap installed near the top of this hook (plan
# 3274, F1 fix — that trap now covers BATTERY_RAN_FILE too, installed BEFORE either heavy gate
# runs rather than re-trapped here; see its own header comment for why a second, later
# installation defeated its own salvage purpose). Gated on `[ -n "$CHANGED" ]` (/sonnet-review
# high finding: a push with no diff at all — e.g. a branch-delete push, or coordination-ref-only
# — never reaches the data-triggered call below, so paying for a mktemp + write on every push is
# wasted cost on the hot path of a repo with 5-7 concurrent sessions). Written UNCONDITIONALLY
# once created, even when BATTERY_RAN_FILES is empty (scripts gate skipped entirely, cache-hit,
# or failed) — select-battery-tests.mjs's readExcludeRanFile treats an empty/missing/unreadable
# file identically to "nothing ran": the fail-safe direction (never narrows the data-triggered
# selection on an error path) is the module's job now, not this hook's.
BATTERY_RAN_FILE=""
if [ -n "$CHANGED" ]; then
  BATTERY_RAN_FILE=$(mktemp 2>/dev/null) || BATTERY_RAN_FILE=""
  if [ -n "$BATTERY_RAN_FILE" ] && ! printf '%s\n' "$BATTERY_RAN_FILES" > "$BATTERY_RAN_FILE" 2>/dev/null; then
    # /sonnet-review high finding: a write failure must not orphan the tempfile mktemp already
    # created — reset to empty ONLY after removing it, so the fallback below never leaks a file.
    rm -f "$BATTERY_RAN_FILE"
    BATTERY_RAN_FILE=""
  fi
fi

# ── Data-dependency triggered tests (plan 2070) ─────────────────────────────
# The scripts/*.mjs gate above only ever fires on a scripts/ diff — but some battery tests'
# TRUE inputs are DATA the scripts/ import closure cannot see at all (wiki pages, seed
# chainIds, the wiki-loader hook modules). A diff touching ONLY that data never enters the
# gate above, so its mapped test never runs on THIS push — the 2026-07-17→19 GB-chains
# incident: the plan-1554 land added unmapped seed chainIds and illegal wiki triggerPaths:,
# and wiki-loader-coverage.test.mjs sat red on master for ~2 days until an unrelated
# scripts/-touching push happened to eat the failure. This block is independent of the gate
# above and runs regardless of whether scripts/*.mjs is in this diff; it consults the SAME
# explicit DATA_DEPENDENCY_MAP the closure-based selector reads (select-battery-tests.mjs's
# `--data-triggered` mode) — never a second, parallel hardcode of the input set — so the map
# lives in exactly one place. A parse failure fails SAFE (the CLI prints every mapped test
# rather than silently skipping). No mutex / pass-cache: this runs at most one ~4s file,
# cheap enough to run un-battery'd (unlike the 99-file scripts/ battery those exist to bound).
# plan 2197: `set --` builds the argument list positionally so `--exclude-ran "$BATTERY_RAN_FILE"`
# is appended (only when the tempfile above was actually created and written) as its OWN quoted
# word — a bare "--data-triggered" is a complete, valid invocation on its own (a data-only diff
# never has a scripts/ gate to dedup against). /sonnet-review high finding: the prior string-
# concatenation + unquoted expansion shape word-split $BATTERY_RAN_FILE on any temp dir containing
# a space, silently defeating the dedup with no error. `set --` is safe here — this hook never
# reads its own $1/$2 (git's remote name/URL argv; every ref it needs arrives via stdin into
# $PUSH_REFS_FILE at the top of the file), and every $1/$@ elsewhere in this file is inside a
# function's OWN positional-parameter scope (unaffected by the caller's `set --`).
set -- --data-triggered
[ -n "$BATTERY_RAN_FILE" ] && set -- "$@" --exclude-ran "$BATTERY_RAN_FILE"
# errexit-safe: `VAR=$(cmd) || VAR=fallback` — cmd's exit status feeds the `||`, so a failure
# (including mainDataTriggered's own EXIT_RUN_FULL-equivalent exit 1 on "nothing matched") never
# aborts the hook under `sh -e`; same idiom as $BATTERY_RAN_FILES/$PUSH_TELEMETRY_HITS_FILE above.
DATA_TRIGGERED_FILES=""
if [ -n "$CHANGED" ]; then
  DATA_TRIGGERED_FILES=$(printf '%s\n' "$CHANGED" | node scripts/select-battery-tests.mjs "$@") || DATA_TRIGGERED_FILES=""
fi

# The gate proper — reached only when something SURVIVED the selection + dedup above.
if [ -n "$DATA_TRIGGERED_FILES" ]; then
  require_timeout_or_exit "data-dependency diff"
  echo "pre-push: data-dependency diff — running node --test on: $(printf '%s\n' "$DATA_TRIGGERED_FILES" | tr '\n' ' ')"
  # plan 2176: shares run_battery_with_retry() with the scripts battery above (this block used
  # to hand-copy its whole attempt/ok/status/retry/clean-env shape). The clean-git-env unset
  # matters just as much here — `git ls-files` inside the wiki-loader-coverage test would
  # otherwise inherit this hook's GIT_DIR/GIT_INDEX_FILE and operate on the wrong repo; the
  # full incident lives with the function's CRITICAL comment. No concurrency clamp (""), and a
  # 120s cap rather than the battery's $BATTERY_CAP: this runs at most one ~4s file.
  # $DATA_TRIGGERED_FILES is a newline-separated list of space-free selected paths and stays
  # UNQUOTED so it word-splits into the function's "$@" at this call site.
  # plan 4124: the "at most one ~4s file" premise fails on a push that carries a master merge —
  # 8 selected files took ~160 s under load and a flat 120 s cap failed both attempts. The cap
  # now scales with the selection: 120 s per selected file (one file keeps the old 120 s).
  _dd_cap_n=$(printf '%s\n' "$DATA_TRIGGERED_FILES" | grep -c . 2>/dev/null) || _dd_cap_n=1
  [ "${_dd_cap_n:-0}" -ge 1 ] 2>/dev/null || _dd_cap_n=1
  _t0=$(date +%s) || _t0=0
  run_battery_with_retry "data-dependency" $((120 * _dd_cap_n)) "" $DATA_TRIGGERED_FILES
  data_test_ok=$RUN_BATTERY_OK
  _dd_dur=$(elapsed_since "$_t0")
  _dd_sel=$(printf '%s\n' "$DATA_TRIGGERED_FILES" | wc -l | tr -d ' ')
  if [ "$data_test_ok" = 0 ]; then
    # review finding 1kp7gg8: same cap-vs-real branch as the scripts-battery gate above —
    # RUN_BATTERY_STATUS is run_battery_with_retry's last-attempt raw exit status.
    _dd_gc_result=$(battery_outcome_class "$RUN_BATTERY_STATUS" "$RUN_BATTERY_FAILED_FILES") || _dd_gc_result=fail
    gate_outcome data-dependency "$_dd_gc_result" "$_dd_dur" "$_dd_sel" "$RUN_BATTERY_FAILED_FILES"
    echo "pre-push: data-dependency node:test FAILED (both attempts) — this diff touches data a battery test reads directly (wiki/entities/**, a seed chainId, or a wiki-loader hook module): an unmapped chain, an illegal triggerPaths:, or a broken loader-registry bijection. Fix it (do not chase it with --no-verify — that hides exactly the drift class plan 2070 exists to catch), then re-push."
    exit 1
  fi
  gate_outcome data-dependency pass "$_dd_dur" "$_dd_sel"
  echo "pre-push: data-dependency node:test clean"
fi

# ---- project hook seam: coord-sharing drift gate, plans 893/1341 ----
# "vetapp is the CANONICAL source and sibling repos adopt a subset of its scripts" is a
# fact about THIS fleet's layout (coord.config.json → coordShare, the 98 Hobby siblings),
# not about coordination in general — a standalone coord checkout has no canonical-source
# relationship to keep in sync, so the gate was core only relative to vetapp's own battery
# (plan 4096 T5). Moved behind the standard seam at its existing position in the ordered
# gate list; the gate's own range-scoping, advisory/blocking split and rationale travel with
# it to pp_project_coord_sharing_drift in scripts/hooks/pre-push-project.sh.
pp_run_project_seam coord_sharing_drift

# Reverse-blocker advisory (plan 569). When the push touches the plans tree, surface any
# waiting-blocked/ plan whose every named blocker has ARCHIVED — unblocked but never
# re-filed to ready/ (the 484-class miss: a plan stranded after its last blocker landed,
# 2026-06-13). done-worktree's land spine auto-promotes these; this catches the non-land
# paths (a hand `git mv` to archive/, a routine plans push). ADVISORY — prints, never
# blocks (the script exits 0 without --check; the `|| true` is belt-and-suspenders).
if printf '%s\n' "$CHANGED" | grep -qE '^docs/superpowers/plans/'; then
  node scripts/lint-stale-blocked.mjs || true
fi

# Doc-freshness advisories (plan 3204). Two classes the 2026-08-15 docs-staleness audit found
# mechanically — dead repo-path references, and "until plan N lands" claims about a plan that
# has archived. Both re-accumulate by themselves, so the durable fix is a warning at write
# time rather than another 174-agent audit.
#
# DIFF-SCOPED, unlike the lint-pipeline-doc advisory above, and for the opposite reason: that
# one polices ONE document against code moves that never touch it, while these two police a
# ~200-file corpus, where the author of the push is the person who just wrote the pointer. Each
# script re-filters whatever it is handed down to the live corpus, so the whole changed-file
# list can go straight in on stdin and the hook needs no copy of the corpus rules. Measured on
# this checkout: 0.6 s combined for a one-doc push, 1.0 s for a five-doc push (two node
# starts dominate); the full-corpus mode (no arguments, run weekly as a standing
# operation) is 3.2 s.
#
# ADVISORY — both scripts exit 0 without --check, and the `|| true` is belt-and-suspenders
# against a future default change. Promotion of the dead-pointer half to blocking is a separate
# decision once the false-positive rate is known; the plan-pointer half is a heuristic about
# English and stays advisory permanently.
#
# CORE, not a project seam (S2 follow-up, plan 3958): assert-doc-pointers.mjs and
# assert-plan-pointers.mjs are both generic (no vetapp semantics of their own — they check
# docs/, wiki/, WIKI.md, CLAUDE.md), and until scripts/coord/doc-token-lib.mjs existed they
# imported their generic path-token helpers from the project's pipeline-doc lint, which itself
# hard-imports the project's pipeline-doc parser (a project-only stage-map parser,
# vetapp-only) — the same coupling that keeps lint-pipeline-doc.mjs's OWN CLI a project seam
# above (pp_project_pipeline_doc_lint). Now that both lints import their token helpers from
# scripts/coord/doc-token-lib.mjs instead, their own closures are core-clean, so the call moved
# back here. Called HERE, after $CHANGED is computed, rather than up with the other core gates.
if printf '%s\n' "$CHANGED" | grep -qE '^(docs/|wiki/|WIKI\.md|CLAUDE\.md)'; then
  printf '%s\n' "$CHANGED" | node scripts/assert-doc-pointers.mjs --stdin || true
  printf '%s\n' "$CHANGED" | node scripts/assert-plan-pointers.mjs --stdin || true
fi

# Block the push if a plan's filename `FABLE-` segment and its frontmatter
# `execModel: fable` field have drifted apart (plan 1292 work item 4c). The
# filename segment is a display mirror for the operator's file tree; the
# orchestrator drain reads the frontmatter field as truth. stamp-exec-model.mjs is
# the sanctioned tool that keeps them in lockstep; this catches anything that
# skipped it (a hand `git mv`, a hand-edited frontmatter). Diff-scoped in TWO ways
# now (plan 2540): this `if` still gates only WHETHER the lint runs (a push touching
# a plan file or the lint/stamp tooling itself), and the piped `$CHANGED` list on
# stdin now scopes WHAT the lint scans once running too — a stray drifted plan
# elsewhere in the tracked corpus no longer blocks a push that never touched it (a
# push touching this lint's OWN tooling still forces a full sweep, inside the lint
# itself — see resolveLintChangeScope in build-index-lib.mjs). A heredoc, not a
# second `printf … |` (review fix), feeds $CHANGED to node without forking a second
# printf — the `if` above already spent one. Bypass: git push --no-verify (but fix
# the drift first).
if printf '%s\n' "$CHANGED" | grep -qE '^(docs/superpowers/plans/|scripts/(lint-filename-execmodel-drift|stamp-exec-model)\.mjs)'; then
  node scripts/lint-filename-execmodel-drift.mjs <<EOF
$CHANGED
EOF
fi

# Block the push if a plan's `priority:` frontmatter stamp is an illegal value (plan 2520
# ruling 3: fail loud at write time). The three-tier vocabulary is `{high, medium, low}`
# (case-insensitive); an absent stamp is always legal (it defaults to `medium`) - only an
# EXPLICIT bad value (a typo, or the now-illegal `normal`) is refused. archive/ and parked/ are
# skipped (closed/frozen). Diff-scoped in TWO ways now (plan 2540), same as the
# execmodel-drift gate above: this `if` gates only WHETHER the lint runs, and the piped
# `$CHANGED` list on stdin scopes WHAT it scans — a stray illegal value elsewhere in the
# tracked corpus no longer blocks a push that never touched it (a push touching this
# lint's OWN tooling still forces a full sweep, inside the lint itself). A heredoc, not
# a second `printf … |` (review fix), feeds $CHANGED to node — see the execmodel-drift
# gate above for why. Bypass: git push --no-verify (but fix the value first).
if printf '%s\n' "$CHANGED" | grep -qE '^(docs/superpowers/plans/|scripts/(lint-plan-priority|read-plan-stamps|build-index-lib)\.mjs)'; then
  node scripts/lint-plan-priority.mjs <<EOF
$CHANGED
EOF
fi

# Wiki page-budget lint (plan 1255; budgets extended by plan 2618). Injected wiki
# pages (the scripts/hooks/*-loader.mjs family) are pushed into context whole every
# session that names their subject, so their size is budgeted — the thresholds and
# the updated:-length rule live as constants in scripts/coord/wiki-size-lint.mjs (single
# owner; do not restate numbers here — the plan-2618 genericization exists because
# a "16 KB" hardcoded in this echo went stale when the cap moved). The injected set
# is DERIVED (per-record dir + hook-source basenames + aliases:/triggerPaths:
# frontmatter under wiki/entities/), never a hand list. Diff-scoped to wiki/**
# (<1s when it runs, mirrors the plan-950 seed-sanity tier); rules doc: WIKI.md
# § "Page budgets + structure rules". errexit-safe: grep inside `if`, run
# ||-guarded. Bypass: git push --no-verify (investigate first).
if printf '%s\n' "$CHANGED" | grep -qE '^wiki/'; then
  echo "pre-push: wiki/ diff — running wiki page-budget lint"
  node scripts/coord/wiki-size-lint.mjs || {
    echo "pre-push: wiki-size-lint FAILED — a wiki page violates a page budget (the size cap or the updated:-length cap; the FAIL line above names which and the remedy). Fix per the message, then re-push. Bypass: git push --no-verify (investigate first)."
    exit 1
  }
  echo "pre-push: wiki-size-lint clean"

  # plan 2764: journal structure — exactly one `# Wiki action log` heading and no duplicate
  # entries. SECONDARY by construction: the route that produced all eight copies of this
  # file's history (wiki-commit.mjs → withCoordCheckout → coordWrite) runs NO git hooks at
  # all, so this tier can only ever catch a DIFFERENT route (a hand `git add wiki/log.md`, a
  # future tool). The load-bearing guard is checkJournalOrThrow inside wiki-commit.mjs's
  # mutate(); mechanism + evidence live in scripts/coord/wiki-log-lint.mjs's header.
  #
  # NESTED inside the wiki/ tier (so it forks no extra printf|grep on a non-wiki push) but
  # gated on wiki/log.md ITSELF, not on `^wiki/` like the budget lint around it. That inner
  # gate is load-bearing: this lint is ABSOLUTE where the write-time guard is a DELTA, so
  # running it for any wiki/** diff would hard-refuse a push that merely touches an unrelated
  # wiki page whenever the journal carries residual duplication the write-time guard
  # deliberately tolerates — the flag day the delta form exists to avoid, inflicted on a
  # pusher with no context on the journal. Gated this way, the only push it can block is one
  # that changes the journal, by whoever is changing it.
  # errexit-safe: grep inside `if`, run ||-guarded. Bypass: git push --no-verify (investigate).
  if printf '%s\n' "$CHANGED" | grep -qxE 'wiki/log\.md'; then
    echo "pre-push: wiki/log.md diff — running wiki journal-structure lint"
    node scripts/coord/wiki-log-lint.mjs || {
      echo "pre-push: wiki-log-lint FAILED — wiki/log.md carries duplicate structure (the FAIL line above names which). Repair with \`node scripts/coord/wiki-log-lint.mjs --fix\` (add --dry to preview; it asserts set equality, so no entry is lost), then re-push. Bypass: git push --no-verify (investigate first)."
      exit 1
    }
    echo "pre-push: wiki-log-lint clean"
  fi
fi

# ---- project hook seam: WebKit mobile gate, plan 233 ----
# pp_project_mobile_gate is defined by scripts/hooks/pre-push-project.sh when that file
# exists (sourced earlier by the scripts/hooks/pre-push.sh dispatcher, which also sets
# PP_PROJECT_PRESENT); a checkout with no project file has PP_PROJECT_PRESENT=0, so
# pp_run_project_seam no-ops WITHOUT consulting PATH at all — the "core gates alone"
# contract (plan 3963), immune to an unrelated PATH executable of this name (finding
# fb9352). A present-but-broken project file (a renamed/dropped function) was already
# caught LOUDLY, once, up top — see the PP_PROJECT_SEAMS validation block (finding
# 6aa9d3) — so by the time this line runs, PP_PROJECT_PRESENT=1 means the function is
# guaranteed to exist.
pp_run_project_seam mobile_gate
