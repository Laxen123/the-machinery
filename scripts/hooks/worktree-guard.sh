#!/usr/bin/env bash
# PreToolUse Bash hook: block git merge / git push to master when worktrees
# exist under .claude/worktrees/, unless the push is limited to hook-maintenance
# or handoff-claim files, or the caller prefixes DONE_WORKTREE_AUTHORIZED=1.
#
# Auto-allow file set (handoff-claim + hook-maintenance):
#   - docs/handoff/current.md                 (pickup-plan claim lock; rolling handoff — plan 857)
#   - docs/handoff/board.md                   (plan 169 board, relocated under docs/handoff/ — plan 857)
#   - docs/handoff/sessions/**                (plan 205 per-session entries, relocated — plan 857)
#   - docs/handoff/infra-debt.md              (plan 2531 rolling debt list — one of the TWO plain-doc carve-outs from the docs/handoff/** coordWrite rule; hand-edited on master by design)
#   - docs/handoff/grammar-debt.md            (dangling-ok: documents the live ALLOWED_RE entry, inert where the optional ledger is absent; plan 3944; operator-chartered 2026-08-10 grammar/tags one-off ledger — the OTHER plain-doc carve-out, same hand-edited-on-master contract as infra-debt.md above)
#   - .claude/settings.json                   (hook config edits)
#   - docs/INDEX.md                           (pickup-plan path-pointer rewrite, atomic with CLAIM)
#   - docs/superpowers/plans/**               (pickup-plan step 4d: git mv to in-progress/, atomic with CLAIM)
#   - docs/superpowers/specs/**               (brainstorming/strategy spec docs land straight to master; sibling of plans/)
#   - docs/superpowers/batches/**             (plan-1467 batch-folder bookkeeping; doc-only, sibling of plans/ — plan 1684)
#   - docs/runbooks/ (.md files)             (procedure prose; doc-only, lands straight to master so a same-session correction isn't deferred — plan 2692. `.md` ONLY: the committed cloud-drain-setup-script.sh under runbooks is executable, not prose)
#   - wiki/**                                 (live subject-synthesis wiki; doc-only, lands straight to master — plan 934)
#   - WIKI.md                                 (wiki schema / Layer 3 — plan 934)
#
# Triggered 2026-05-23 cramped-laptop session — initial coarse guard blocked
# every push-to-master while any worktree existed; broke the pickup-plan claim
# flow which legitimately pushes handoff.md to master before creating its own
# worktree. The narrow auto-allow restores that workflow without re-opening
# the worktree-merge hole.
#
# Widened 2026-05-25 (plan 129 done-worktree carry-forward) — pickup-plan
# step 4d added a `git mv` of the plan file into `in-progress/` PLUS an
# INDEX.md path-pointer rewrite, both required to land atomically with
# the handoff.md CLAIM. The original auto-allow set (handoff.md only)
# rejected the three-file CLAIM commit, forcing every pickup to use the
# DONE_WORKTREE_AUTHORIZED=1 escape — defeats the auto-allow's purpose.
# The widened set still rejects code/test/config pushes; only plan-bookkeeping
# files pass without the explicit-authorize escape.
#
# Chained-commit fix 2026-05-27 (skill-streamline phase 2 follow-up) —
# the original auto-allow consulted `git log origin/master..HEAD` to read
# the file set. That's empty when the command is a chained
# `git add … && git commit … && git push origin master` (PreToolUse runs
# BEFORE any of the chain has executed), so chained commits even of pure
# plan-bookkeeping files fell through to deny. Added a second branch that
# parses `git add <file>` arguments out of the command text when origin
# has nothing queued. Broad adds (`-A`, `-u`, `--all`, `.`, `--update`)
# can't be scope-validated and still deny.
#
# Widened 2026-05-31 — brainstorming/strategy spec docs (docs/superpowers/specs/**)
# land straight to master per CLAUDE.md's "commit + push doc work immediately"
# rule, same as plans/**. Sibling dir, same doc-only risk profile; without this
# every spec push was forced through DONE_WORKTREE_AUTHORIZED=1 because worktrees
# (≈always present in this repo) keep the guard armed.
#
# Quoted-argument fix 2026-06-09 (plan 496) — the trigger match (`git merge` /
# `git push … master`) ran against the ENTIRE raw command string, so trigger
# TEXT inside a quoted argument — a `next-plan-id.mjs claim --blurb "…"`, a
# `git commit -m "…"` message, an `echo "…"` — falsely armed the guard even
# when the actual invocation was a self-scoping coord tool that only pushes
# bookkeeping paths. Minting a plan whose blurb described a "git push to master"
# flow was DENIED purely for its prose. Fix: anchor the trigger to a COMMAND
# BOUNDARY — start of line, or right after a separator (`&& || ; |` / `(`) or an
# env-assignment prefix — matched on the RAW command. Trigger text mid-prose
# inside a quoted arg ("… the git push to master flow …", a `git commit -m`
# message, an `echo "…"`) is not at a boundary, so it no longer arms the guard.
# The match deliberately stays on the RAW string (NOT a quote-stripped copy): an
# oddly-quoted but REAL push (`git push origin "master"`) must still be blocked,
# and stripping quotes would drop the refspec and open a fail-OPEN hole. The
# auto-allow path-set logic below still parses the ORIGINAL "$cmd".
#
# Known fail-SAFE limitation: a literal command separator INSIDE a quoted arg
# (a blurb quoting a whole `… && git push origin master` chain) still trips the
# boundary match and is over-blocked. Realistic plan summaries are prose, not
# `&&`-chains, so this is rare; reword the arg or prefix DONE_WORKTREE_AUTHORIZED=1.
# (An "early-allow the coord tools by basename" escape was prototyped and
# dropped: every variant reopened a fail-OPEN — the tool name matched inside a
# comment/arg of a real push, or a `bash -c "git push …"` wrapper slipped through.
# For a guard, a fail-safe over-block beats a fail-open bypass.)
#
# Widened 2026-06-21 (plan 934, operator-authorized) — the wiki (`wiki/**`,
# `WIKI.md`) became a live subject-synthesis layer with a "fold findings into
# the page every session" ingest rule. It is doc-only (no prod impact, exempt
# from /code-review), same risk profile as plans/specs/handoff, so it joins the
# straight-to-master auto-allow set. Otherwise every wiki edit needed a
# worktree-land or the DONE_WORKTREE_AUTHORIZED=1 escape — the exact friction
# that let the wiki rot.
#
# Widened 2026-07-10 (plan 1684) — docs/superpowers/batches/** (the plan-1467
# batch-folder surface, e.g. docs/superpowers/batches/<slug>/batch.md) had NO
# sanctioned creation path: this allow-list predated plan 1467 and omitted it,
# and coord-edit.mjs refused the new (untracked) file outright. The only batch
# folder that ever landed did so via the stop-hook auto-heal committing it as
# idle dirt — an accident, not a flow. It's coord bookkeeping doc-only, same
# risk profile as plans/**/specs/**, so it joins the straight-to-master set.
#
# Widened 2026-09-11 (plan 3944) — the grammar-debt ledger beside infra-debt.md is CLAUDE.md's
# OTHER plain-doc carve-out (alongside infra-debt.md above), hand-edited on
# master by the same standing rule since it was chartered 2026-08-10, but this
# allow-list only ever listed infra-debt.md. With a worktree alive (near-always
# true in this repo) a grammar-debt hand-edit-and-push was blocked by THIS
# guard even though it is the sanctioned way to edit it — pushing a session
# toward the DONE_WORKTREE_AUTHORIZED=1 escape for a doc-only file. This is a
# DIFFERENT mechanism from the worktree-branch wiki/ledger-diff guard in
# scripts/hooks/pre-push.sh and done-worktree.mjs's wikiDiffOnWorktreeBranch:
# those gate what a worktree BRANCH may carry (a commit that must never ride
# one), while this guard gates a push-to-master ATTEMPT while any worktree
# exists at all — do not merge the two ideas.

set -eu

ALLOWED_RE='^(docs/handoff/current\.md|docs/handoff/board\.md|docs/handoff/sessions/.*|docs/handoff/infra-debt\.md|docs/handoff/grammar-debt\.md|\.claude/settings\.json|docs/INDEX\.md|docs/superpowers/plans/.*|docs/superpowers/specs/.*|docs/superpowers/batches/.*|docs/runbooks/.*\.md|wiki/.*|WIKI\.md)$'

# Command extraction (plan 683) — parse the PreToolUse JSON on stdin with `node`,
# NOT `jq`. `jq` is an UNDECLARED external; on a host without it (reproduced on
# T2021896) the old `jq -r … 2>/dev/null` swallowed the not-found error and yielded
# an EMPTY command, so the trigger never matched and the guard FAILED OPEN — every
# `git push … master` / `git merge` silently allowed, and worktree-guard.test.mjs
# went 9/9 red on the deny-cases (blocking every scripts/-touching push via the
# pre-push hook). `node` is guaranteed present in this repo (the test already shells
# it), so this is dependency-free. Read stdin ONCE into $raw, then feed node.
raw=$(cat)
cmd=$(printf '%s' "$raw" | node -e 'let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j&&j.tool_input&&j.tool_input.command)||""))}catch{process.stdout.write("")}})' | tr -d '\r')

# Visibility (plan 683) — if stdin carried data but extraction yielded nothing, the
# parse failed (malformed JSON, or a future `node` break). Surface it on stderr
# (hook logs / manual runs; PreToolUse stderr is not always shown in the session UI)
# rather than failing open with no trace, like the jq-missing case this fixes.
# We still proceed (empty cmd → no trigger match → allow): blocking every bash call
# on an unparseable payload would be worse than the rare, now-traceable miss.
if [ -n "$raw" ] && [ -z "$cmd" ]; then
  echo "worktree-guard: WARNING — could not extract a command from the hook payload (JSON parse yielded empty); guard cannot evaluate this call" >&2
fi

# Explicit single-call bypass
if echo "$cmd" | grep -q 'DONE_WORKTREE_AUTHORIZED=1'; then
  exit 0
fi

# ── Stale worktree LOCK: deny the raw `rm` (plan 3752, operator decision
# 2026-09-07) ────────────────────────────────────────────────────────────────
# This shape parked plan 1823's unattended cloud session THREE times: 2026-09-05
# (8h24m, two operator clicks) and 2026-09-07 04:05Z-07:53Z (3h40m). It is not a
# safety problem, it is a STALL problem: the session hand-rolls
#   GD=/home/user/vetapp/.git/worktrees/<slug>
#   rm -f "$GD"/index.lock "$GD"/next-index-*.lock
# whose FIRST token is a variable assignment, so no `permissions.allow` entry can
# ever match it (they are prefix rules anchored on a command word) and it stops
# for a prompt nobody is watching. `node scripts/clear-stale-worktree-lock.mjs`
# does the same job, is already allow-listed in the COMMITTED .claude/settings.json
# (so it auto-approves in a fresh cloud clone), and is safer: it removes a lock
# only when it is provably idle, where a blind `rm -f` also removes one a live git
# op is holding.
#
# A DENY, not a warn, because a warn does not stop the park: the companion
# scripts/hooks/hand-rolled-step-guard.mjs teaches the same pattern through
# non-blocking additionalContext, the command still reaches the prompt, and the
# session still sits on it. That hook keeps its never-deny posture; the block
# lives here, in the hook that already matches Bash, already owns worktree-path
# concerns, and already emits a deny.
#
# Scope decided EXPLICITLY (T4 required the call, either way): WORKTREE gitdirs
# only. The MAIN checkout's own `.git/index.lock` is NOT denied here — the named
# fix would be wrong for it, since clear-stale-worktree-lock.mjs deliberately
# never touches the shared main lock (docs/coord/worktrees.md § Stale index.lock
# self-heal); a MAIN wedge is heal-main.mjs's business, and
# the warn-only guard already points there. Widening is a separate decision.
#
# ONE parser, not two. The first cut of this block re-implemented the matching in
# shell regexes and promptly missed `command rm`, `/bin/rm`, a `\`-continuation
# and an `if …; then rm`, while its command-WIDE scope test denied a MAIN-checkout
# cleanup whose command merely MENTIONED a worktree path elsewhere (13 review
# findings, one root cause). The sibling hand-rolled-step-guard.mjs already parses
# shell segments, command position, quoted tokens and lock basenames for its
# warn-only twin of this rule, so it is asked instead — `--stale-lock-rm-json`
# reads the same payload and prints each rm TARGET with its own scope.
#
# Only the `worktree` scope denies. A MAIN-checkout `.git/index.lock` is
# deliberately left alone (the T4 scope call, made explicitly): the named tool
# never touches the shared main lock, so the deny would prescribe the wrong fix.
# A MAIN wedge is heal-main.mjs's business, and the warn-only guard says so.
#
# Accepted limits: (1) a lock path built by a command substitution
# (`GD=$(git rev-parse --git-dir)`) is not resolvable without running it, so it is
# a MISS — fail-safe, and the warn still fires; (2) the deny does not check WHICH
# repo the lock belongs to, so a lock cleanup in an unrelated checkout is also
# denied. That is over-blocking, but the advice holds for any git checkout and the
# DONE_WORKTREE_AUTHORIZED=1 escape is one prefix away.
#
# `case` pre-filter: NO spawn at all unless the command even mentions a lock, so
# the classifier runs on a small fraction of Bash calls. The bracket classes make
# it case-INSENSITIVE in the shell's own pattern matcher — matching the
# classifier, which is case-insensitive because the Windows filesystem is. Two
# review rounds shaped this line: an all-lower/all-upper pattern pair skipped a
# MIXED-case spelling before the classifier could run, and the `tr` that fixed
# that spawned two processes on EVERY Bash call. This spawns none.
case "$cmd" in
  *[Ll][Oo][Cc][Kk]*)
    hook_dir=$(dirname "$0")
    stale_scope=$(printf '%s' "$raw" | node "$hook_dir/hand-rolled-step-guard.mjs" --stale-lock-rm-json 2>/dev/null | grep -o '"scope":"worktree"' | head -1 || true)
    if [ -n "$stale_scope" ]; then
      cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Do NOT clear a stale worktree git lock with a raw `rm`. Run `node scripts/clear-stale-worktree-lock.mjs` instead, then retry the git command. It clears ONLY a provably stale lock (a blind `rm -f` also deletes a lock a live git operation is holding), it sweeps every linked worktree when run from the main checkout, and — the reason this is a deny and not a warning — it is already in the committed .claude/settings.json allow-list, so it auto-approves. A hand-rolled `VAR=…; rm -f \"$VAR\"/index.lock` can match no allow rule at all (they are prefix rules anchored on a command word), so it stops for a permission prompt; that parked an unattended cloud drain for 8h24m on 2026-09-05 and 3h40m on 2026-09-07. See docs/coord/worktrees.md § Stale index.lock self-heal. A MAIN-checkout wedge is a different tool: `node scripts/heal-main.mjs`. To force the raw form anyway, prefix the command with DONE_WORKTREE_AUTHORIZED=1."}}
JSON
      exit 0
    fi
    ;;
esac

# ── Unqueued pytest sweep: DENY (plan 3969) ──────────────────────────────────
# Measured 2026-09-12 (plan 3941): one session ran the full
# backend/scripts/data-pipeline pytest sweep FOUR times SERIALLY through a
# bare `node scripts/queued-run.mjs python -X utf8 -m pytest -q <dir>` — about
# 40 minutes each — while THIS repo's own pre-push.sh printed the parallel
# form (`-n 9 --dist loadfile`, ~8 minutes) in the push log twice in that same
# session. queued-run.mjs (plan 3969, T1) now injects those flags itself for
# any pytest sweep that names no worker/dist flag, so the serial shape can
# still only be produced by TYPING one — this deny is what stops a session
# from hand-rolling the wrapper away entirely and running pytest bare, the
# same "advice is not a fix" problem plan 3752 solved for the stale-lock `rm`.
#
# A DENY, not a warn: the companion scripts/hooks/hand-rolled-step-guard.mjs
# already teaches the wrapper via non-blocking additionalContext (WARN pattern
# 1, `heavy-test-unqueued`), and the command still ran serially anyway — a
# warning does not stop a session that is not looking for it. That hook keeps
# its never-deny posture; the block lives here, in the hook that already
# matches Bash and already emits denies (the plan-3752 pattern, twinned).
#
# ONE parser, not two, exactly as the stale-lock deny above: `--unqueued-
# pytest-sweep-json` asks hand-rolled-step-guard.mjs's `unqueuedPytestSweepHits`
# — which already has segment walking, command position, quoted tokens, the
# single-file exemption and the info-flag exemption for its WARN twin — rather
# than re-deriving a "is this a pytest sweep" test in shell regexes (plan
# 3752's first cut re-implementing its parser in shell missed four spellings).
#
# The wrapped form (`node scripts/queued-run.mjs -- python -m pytest <dir>`)
# is allowed on STRUCTURAL grounds, not a name-based exemption: `node` is not
# a recognised wrapper token, so `pytest` never reaches command position and
# the classifier reports no hit. A single `.py` file, `pytest --version`/
# `--help`, and a command that merely MENTIONS pytest in prose (an `echo`, a
# `git commit -m`) all stay allowed too — see the classifier's own doc comment
# for why. `DONE_WORKTREE_AUTHORIZED=1` still forces the raw form through, the
# same single-call escape as every other deny in this file.
#
# `case` pre-filter: NO spawn at all unless the command even mentions pytest,
# case-insensitive like the lock filter above.
case "$cmd" in
  *[Pp][Yy][Tt][Ee][Ss][Tt]*)
    hook_dir=$(dirname "$0")
    sweep_hit=$(printf '%s' "$raw" | node "$hook_dir/hand-rolled-step-guard.mjs" --unqueued-pytest-sweep-json 2>/dev/null | grep -o '"segment"' | head -1 || true)
    if [ -n "$sweep_hit" ]; then
      cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Do NOT launch an unwrapped pytest sweep. Run it through the wrapper instead: `node scripts/queued-run.mjs -- python -m pytest <dir>` — it injects the `-n <workers> --dist loadfile` flags itself from scripts/pytest-workers.mjs, so do NOT type them yourself. A single `.py` file is allowed bare (not sweep-shaped, ticket-free by design). Serial is still reachable on purpose, but only through the wrapper: pass `-p no:xdist` yourself. See your project's `CLAUDE.md` § Pre-commit / pre-land checks and docs/coord/worktrees.md § Stale index.lock self-heal for the plan-3752 pattern this mirrors. To force the raw form anyway, prefix the command with DONE_WORKTREE_AUTHORIZED=1."}}
JSON
      exit 0
    fi
    ;;
esac

# ── Unqueued heavy single-file test run: DENY (plan 4241) ───────────────────
# Single-file `node --test` runs are ticket-free BY RULE (vetapp/CLAUDE.md §
# Pre-commit / pre-land checks) — right for a 5s file, wrong for one measured
# at 1,499,615 ms (scripts/pre-push-hook.test.mjs, before plan 4228 shrank it). # dangling-ok: dated measurement of a project test file
# 2026-09-26: one session ran 4-5 concurrent ticket-free single-file
# `node --test` runs beside two full batteries and a full pytest sweep — in
# load terms, a small sweep of its own, and nothing capped it. This DENY makes
# a file on the MEASURED heavy list (scripts/coord/heavy-test-files.json,
# regenerated from the battery ledger's per-file `durationMs` by
# `node scripts/heavy-test-files.mjs regenerate`) take the wrapper instead of
# running bare — the same "advice is not enough" fix plan 3969 applied to an
# unwrapped pytest sweep above.
#
# A DENY, not a warn, for the same reason as the pytest-sweep block: the
# companion scripts/hooks/hand-rolled-step-guard.mjs's own single-file
# exemption for pattern 1 (`heavy-test-unqueued`) already stays SILENT on a
# single test file by design — a warning would contradict that WARN twin
# rather than reinforce it — so this DENY lives here, on data the warn path
# cannot see (a MEASURED per-file duration, not a shape rule).
#
# ONE parser, not two: `--unqueued-heavy-test-json` asks
# hand-rolled-step-guard.mjs's `unqueuedHeavyTestFileHits`, which owns the
# match shape (S4 on the plan) and the heavy-list load (fail OPEN — a
# missing/unreadable/empty scripts/coord/heavy-test-files.json means nothing
# is heavy and this block never fires). The wrapped form
# (`node scripts/queued-run.mjs -- node --test <file>`) is allowed on
# STRUCTURAL grounds, exactly like the pytest sweep's wrapped form above: the
# OUTER `node`'s first positional argument is `scripts/queued-run.mjs`, not
# the literal `--test` flag, so the classifier reports no hit for that
# command position. An unlisted file, and a `$( … )`/glob-hidden target, stay
# allowed too — see that classifier's own doc comment for the full match
# shape and its accepted misses.
#
# `case` pre-filter: NO spawn at all unless the command even mentions `--test`
# (node's own flag spelling, always lowercase — unlike pytest/lock above there
# is no case-folding to do here).
case "$cmd" in
  *--test*)
    hook_dir=$(dirname "$0")
    heavy_hit=$(printf '%s' "$raw" | node "$hook_dir/hand-rolled-step-guard.mjs" --unqueued-heavy-test-json 2>/dev/null | grep -o '"segment"' | head -1 || true)
    if [ -n "$heavy_hit" ]; then
      cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Do NOT run this KNOWN-HEAVY test file bare. Run it through the wrapper instead: `node scripts/queued-run.mjs -- node --test <file>`. The file is on scripts/coord/heavy-test-files.json because its last recorded run took at least 600,000 ms (10 min) on this box, per scripts/heavy-test-files.mjs regenerate. An unlisted single file stays ticket-free by design, and the wrapped form above is always allowed. See vetapp/CLAUDE.md § Pre-commit / pre-land checks and docs/coord/hooks.md. To force the raw form anyway, prefix the command with DONE_WORKTREE_AUTHORIZED=1."}}
JSON
      exit 0
    fi
    ;;
esac

# Boundary-anchored trigger (plan 496) on the RAW command. `git merge` /
# `git push … master` only counts at a command boundary: start of line, or
# after a separator (`; & | (`, covering `&&`/`||`) or an optional env-assignment
# prefix. Trigger text mid-prose inside a quoted arg is not at a boundary and is
# ignored; an oddly-quoted real push (`git push origin "master"`) still matches.
#
# merge-* plumbing carve-out (plan 1259) — the merge arm was `merge\b`. `\b` is a
# word boundary and there IS one between `merge` and `-`, so `merge\b` false-positived
# on `git merge-base` / `git merge-tree`: read-only plumbing (compute ancestry / a
# merged tree; touch neither HEAD, index, nor working tree) used in push diagnostics
# like `git merge-base --is-ancestor origin/master HEAD`, wrongly blocked as if a real
# merge. The fix is a fail-SAFE ALLOWLIST, NOT a blanket hyphen-wildcard: the merge arm
# `merge([^-A-Za-z0-9_]|$)|merge-[^bt]` blocks bare `git merge` (EOL), `git merge <ref>`
# (a non-hyphen, non-word char follows), AND every WRITE-capable merge plumbing form —
# the strategy backends `merge-recursive`/`merge-octopus`/`merge-resolve`/`merge-ours`/
# `merge-subtree`, plus `merge-index`/`merge-one-file`/`merge-file` (NB: `merge-file`
# OVERWRITES its first arg in place, it is NOT read-only) — because every one of those
# begins with a char OTHER than b/t after the hyphen, so `merge-[^bt]` still fires on
# them. It exempts ONLY `merge-base` / `merge-tree` (the sole real `git merge-*`
# subcommands beginning with b/t, both genuinely read-only). This is the symmetric
# END-boundary companion to plan 496's START-boundary anchor. (A blanket
# `merge([^-A-Za-z0-9_]|$)` — exclude the whole `merge-*` namespace — was rejected in
# review: it fails OPEN on the write-capable backends above.)
#
# Residual (dormant, tracked as plan 1268) — `merge-[^bt]` is an ALLOWLIST-BY-PROXY,
# exact only for git's REAL merge-* subcommands (base/tree are the only ones starting
# with b/t, both read-only). It is NOT a fully exact match: git does not always error
# on an unknown verb — for a non-builtin it execs an external `git-<verb>` from PATH
# (the git-flow/git-extras extension mechanism), so a hypothetical PATH-resident
# `git-merge-b…`/`git-merge-t…` (e.g. `git-merge-branch`) would slip the carve-out.
# No such extension exists in git core or the common suites today, so this is dormant,
# not a live bypass; tightening to an exact base/tree allowlist is parked in plan 1268.
# `-C <path>` carve-in (plan 3779) — a git-global-option prefix group is
# admitted between `git[[:space:]]+` and the verb alternation so
# `git -C <path> push … master` / `git -C <path> merge …` — the exact shape
# Windows sessions are told to use in place of a leading `cd` (a Bash command may
# not open with `cd`) — is no longer invisible to the trigger. The plan-496
# boundary anchor (start of line / after a separator or env-assignment prefix)
# and the plan-1259 merge-base/merge-tree carve-out are untouched: the option
# prefix sits strictly between `git` and the verb, so it widens WHICH commands
# reach the verb alternation without changing how that alternation itself
# decides.
#
# Review-fix (plan 3779, /gpt-review round 2) — the FIRST cut of this carve-in
# had one regression and three fail-opens, all traced to the same root cause:
# the -C grammar was written TWICE (once in the trigger, once nowhere at all —
# the push auto-allow matcher below still assumed bare `git push`), so the two
# could disagree, and the one copy that existed was narrower than real `git`
# accepts.
#   F1 (regression this diff introduced) — the trigger now fires on
#     `git -C <path> push … master`, but the auto-allow matcher below still
#     matched only `git push` immediately-adjacent, so a SANCTIONED docs-only
#     `-C`-form push (the shape coord tooling uses) fell through to the
#     default deny — a NEW false denial.
#   F2 (fail-open) — the path group `("[^"]*"|[^[:space:]]+)` didn't accept a
#     SINGLE-quoted path, so `git -C 'path with a space' push … master` split
#     on the space and missed the trigger entirely → silently ALLOWED.
#   F3 (fail-open) — the group allowed only ONE `-C`, so git's own accepted
#     `git -C a -C b push … master` (repeatable) missed the trigger too.
#   F4 (fail-open) — nothing was admitted between `-C <path>` and the verb, so
#     any OTHER git global option mixed in (`--no-pager`, `-c foo=bar`, before
#     or after `-C`) also missed the trigger.
# Fixed by factoring the whole git-global-option prefix grammar into ONE
# `git_opts_re` variable — repeatable, multi-quote-style `-C`, plus a handful
# of other common global options — reused by BOTH the trigger regex below and
# the push auto-allow matcher (search `git_opts_re` further down). One
# definition; it cannot drift out of sync with itself again.
#
# Iteration-2 review fixes (19 findings, one root cause) — `git_opts_re` above
# was reused by the trigger AND the push auto-allow matcher, but the push_dir
# extraction further down (the parser that resolves WHICH directory a push
# actually comes from — feeds both the cross-repo skip and the directory-
# scoped auto-allow judgment) was NOT updated: it still recognized only a
# single `-C` immediately after `git`, double-quoted or bare.
#   R1 — a global option BEFORE `-C` (`git --no-pager -C <dir> push …`) passed
#     the trigger but left push_dir EMPTY, so the auto-allow inspected the
#     hook's own cwd instead of the real push directory.
#   R2 — repeated `-C` (`git -C a -C b push …`) passed the trigger but
#     push_dir recorded the FIRST path; git's real semantics take the LAST.
#   R3 — a single-quoted `-C` path with a space passed the trigger, but the
#     downstream parser (bare/double-quoted only) truncated it at the first
#     space.
#   R4 — `git_opts_re` itself had no quoted-value form for `-c` (a separate-
#     token option like `-C`), so `-c user.name='A B'` couldn't be parsed as
#     one token and the WHOLE trigger failed to match → fell through to allow.
# Fixed by factoring a three-way value fragment — double-quoted / single-
# quoted / bare, concatenable so `key='quoted value'` parses as one token —
# into ONE `opt_val_re` variable, reused for BOTH `-C` and `-c` in
# `git_opts_re`, and by the push_dir extraction below (which now matches the
# full `git`+options run and takes the LAST `-C` occurrence in it). One value
# grammar, three call sites, no separate fourth parser.
opt_val_re='("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]"'"'"']+)+'
git_opts_re='((-C[[:space:]]+'"$opt_val_re"'|--no-pager|--no-replace-objects|--bare|--literal-pathspecs|--paginate|-c[[:space:]]+'"$opt_val_re"'|--git-dir=[^[:space:]]+|--work-tree=[^[:space:]]+|--namespace=[^[:space:]]+)[[:space:]]+)*'
trigger_re='(^|[;&|(])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*git[[:space:]]+'"$git_opts_re"'(merge([^-A-Za-z0-9_]|$)|merge-[^bt]|push\b.*\bmaster\b)'
if ! printf '%s\n' "$cmd" | grep -qE "$trigger_re"; then
  exit 0
fi

# Cross-repo skip (2026-06-15) — this guard only protects THIS repo's master.
# When the command runs the push inside a DIFFERENT git repo (a leading
# `cd <dir>` or a `git -C <dir>`), resolve that dir's shared git dir and bail
# when it differs from this repo's. Worktrees of THIS repo share its common git
# dir, so they stay guarded; an unrelated repo (e.g. a personal Obsidian vault
# pushed via `cd ../obsidian && git push`) does not. Without this, the guard
# blocked any cross-repo push purely because THIS repo has worktrees.
_repo_common_dir() {  # $1 = dir → absolute common .git dir, or nothing
  ( cd "$1" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd ) || true
}
push_dir=""
# Reuses $git_opts_re (defined above, next to trigger_re) — same grammar as
# the trigger, not a fourth hand-rolled parser (plan 3779 iteration-2 fix).
# Extract the full `git`+options run first, THEN pull every `-C` value out of
# THAT run and take the LAST one — matching git's own repeatable-`-C`,
# last-one-wins semantics (R2) — regardless of what other global options sit
# before or after it in the run (R1, F4).
git_prefix_re='git[[:space:]]+'"$git_opts_re"
gp=$(printf '%s' "$cmd" | grep -oE "$git_prefix_re" | head -1 || true)
if [ -n "$gp" ]; then
  gc=$(printf '%s' "$gp" | grep -oE -- '-C[[:space:]]+'"$opt_val_re" | tail -1 || true)
  if [ -n "$gc" ]; then
    # Strip the `-C` token, then a leading/trailing quote of either kind (R3:
    # opt_val_re now accepts a single-quoted value too, so this generic
    # either-quote strip — unchanged from before — finally gets exercised).
    push_dir=$(printf '%s' "$gc" | sed -E "s/^-C[[:space:]]+//; s/^[\"']//; s/[\"']\$//")
  fi
fi
if [ -z "$push_dir" ]; then
  cdt=$(printf '%s' "$cmd" | grep -oE '(^|[;&|(])[[:space:]]*cd[[:space:]]+[^&|;]+' | head -1 || true)
  if [ -n "$cdt" ]; then
    push_dir=$(printf '%s' "$cdt" | sed -E "s/.*cd[[:space:]]+//; s/[[:space:]]+\$//; s/^[\"']//; s/[\"']\$//")
  fi
fi
if [ -n "$push_dir" ]; then
  this_common=$(_repo_common_dir ".")
  push_common=$(_repo_common_dir "$push_dir")
  if [ -n "$push_common" ] && [ -n "$this_common" ] && [ "$push_common" != "$this_common" ]; then
    exit 0
  fi
  # Fail CLOSED (plan 3779, finding 2) — a -C/cd target WAS parsed out of the
  # command but does not resolve to any git checkout (missing dir, not a repo,
  # a broken `cd`). We cannot tell whether it's this repo, a worktree of it, or
  # a foreign repo, so we must not silently fall back to judging the hook's own
  # cwd below (that IS the bug this plan fixes) or silently allow the cross-repo
  # skip. This guard's whole purpose is that a missed detection is worse than an
  # extra DONE_WORKTREE_AUTHORIZED=1.
  if [ -z "$push_common" ]; then
    cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"This command's -C/cd target directory could not be resolved to a git checkout (missing path, not a repo, or a broken cd), so the guard cannot tell which tree the push/merge is actually coming from. Failing CLOSED rather than silently judging the hook's own working directory instead (plan 3779). Verify the path, or prefix DONE_WORKTREE_AUTHORIZED=1 if this really is intentional."}}
JSON
    exit 0
  fi
fi

# Only when worktrees exist (excluding .scratch). In-process glob, NOT find(1)
# (swapped 2026-07-13): every guarded push used to spawn Git Bash find.exe here,
# and find.exe is the process implicated in all ten 2026-07 kernel 0x3B BSODs
# (concurrent NtQueryDirectoryFileEx race in Win11 26100 — claude-mgmt BSOD case
# file). The glob does one in-process readdir instead of adding a concurrent
# enumerator per push. Semantics preserved: `*/` matches directories only and
# skips dot-names, so .scratch is excluded for free (worktree slugs are
# `<planid>-…`, never dot-prefixed); with no match the pattern stays literal
# and fails the -d test, covering the missing-dir case too.
wt_exists=0
for _wt in .claude/worktrees/*/; do
  if [ -d "$_wt" ]; then wt_exists=1; break; fi
done
if [ "$wt_exists" -eq 0 ]; then
  exit 0
fi

# Push-only auto-allow: if every file being pushed touches ONLY files in the
# auto-allow set, let it through. Merge always blocked at this point.
#
# Reuses $git_opts_re (defined above, next to trigger_re) instead of a bare
# `\bgit[[:space:]]+push\b` — review finding F1 (plan 3779): the trigger fires
# on `git -C <path> push … master` but a bare-`push` matcher here does not, so
# a sanctioned `-C`-form push used to fall through this whole block straight
# to the default deny at EOF.
if echo "$cmd" | grep -qE '\bgit[[:space:]]+'"$git_opts_re"'push\b'; then
  # Path 1 — separate commit-then-push: origin/master..HEAD has the file list.
  # Covers the canonical case where commit landed first, push follows.
  # Auto-allow: handoff lock + hook maintenance + pickup-plan plan-bookkeeping.
  # The docs/superpowers/plans/** clause covers `git mv` between subfolders
  # (root → in-progress/, in-progress/ → archive/) AND new plan files filed
  # at close-out (waiting-blocked/, waiting-trip/, waiting-date/).
  #
  # Directory-scoped (plan 3779, finding 2) — a -C/cd target was already parsed
  # above into $push_dir for the cross-repo skip; REUSE it here rather than
  # adding a second parser. When set, it is guaranteed same-repo-resolvable at
  # this point (a foreign repo already exited 0, an unresolvable one already
  # denied), so judge the directory the push is ACTUALLY coming from, not the
  # hook's own cwd — otherwise a worktree source push can be judged against a
  # docs-clean main checkout and wrongly auto-allowed. No `cd`/`-C` prefix at
  # all ($push_dir empty) legitimately pushes from the cwd, which stays correct.
  if [ -n "$push_dir" ]; then
    changed=$(git -C "$push_dir" log origin/master..HEAD --name-only --pretty=format: 2>/dev/null | grep -v '^$' | sort -u || true)
  else
    changed=$(git log origin/master..HEAD --name-only --pretty=format: 2>/dev/null | grep -v '^$' | sort -u || true)
  fi
  if [ -n "$changed" ]; then
    non_allowed=$(echo "$changed" | grep -v -E "$ALLOWED_RE" || true)
    if [ -z "$non_allowed" ]; then
      exit 0
    fi
  else
    # Path 2 — chained `git add … && git commit … && git push`: nothing yet in
    # origin/master..HEAD because the commit hasn't run. Parse `git add` args
    # out of the command text and validate them against the same allow set.
    # Broad-add forms (-A / -u / --all / . / --update) can't be scope-validated
    # so they intentionally fall through to deny.
    if ! echo "$cmd" | grep -qE 'git[[:space:]]+add[[:space:]]+(-A|-u|--all|--update|\.)([[:space:]]|$|&|;|\|)'; then
      add_targets=$(echo "$cmd" \
        | grep -oE 'git[[:space:]]+add[[:space:]]+[^&|;]+' \
        | sed -E 's/^git[[:space:]]+add[[:space:]]+//' \
        | tr -s ' ' '\n' \
        | grep -vE '^(-|$)' \
        | sort -u || true)
      if [ -n "$add_targets" ]; then
        non_allowed=$(echo "$add_targets" | grep -v -E "$ALLOWED_RE" || true)
        if [ -z "$non_allowed" ]; then
          exit 0
        fi
      fi
    fi
  fi
fi

# Default: deny
cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Worktree(s) detected under .claude/worktrees/. Do NOT git merge or git push to master by hand — land via the done-worktree spine (node scripts/done-worktree.mjs <slug>), which sessions self-invoke once the plan is complete and the review verdict is recorded (operator done-signal gate retired 2026-06-12). Pushes touching ONLY docs/handoff/current.md / docs/handoff/board.md / docs/handoff/sessions/** / docs/INDEX.md / docs/superpowers/plans/** / docs/superpowers/specs/** / docs/superpowers/batches/** / docs/runbooks/ (.md files) / wiki/** / WIKI.md / .claude/settings.json are auto-allowed (pickup-plan claim lock + plan/spec/batch/runbook/wiki bookkeeping). Hook logic lives at scripts/hooks/ since plan 3765 and is ordinary review-gated app source: it lands through the spine like any other scripts/ change, and an urgent one-liner takes the explicit DONE_WORKTREE_AUTHORIZED=1 prefix rather than a silent auto-allow. To authorize anything else, prefix the bash command with DONE_WORKTREE_AUTHORIZED=1."}}
JSON
