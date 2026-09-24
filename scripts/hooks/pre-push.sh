#!/usr/bin/env sh
# scripts/hooks/pre-push.sh — thin dispatcher (plan 3963).
#
# The gate battery used to live entirely in this file (5,000 lines). It is now split into
# scripts/hooks/pre-push-core.sh (generic coordination gates — always present) and
# scripts/hooks/pre-push-project.sh (vetapp-specific gates — present in this repo, absent
# in a checkout of just the generic coordination core), so a non-vetapp checkout ships the
# core file alone and still runs every coordination-level gate, with none of the
# vetapp-product gates in the mix. See pre-push-core.sh's own header for the split's design
# (project hook seams, sourcing order, why a project-file-absent checkout no-ops cleanly).
#
# Sourced by .husky/pre-push, not exec'd: `.` runs this in THAT SAME shell, so an `exit`
# from either sourced file still ends the whole push, `trap … EXIT` cleanup set by either
# still fires once at real process exit, and the single read of the pushed-ref stdin (the
# very first thing pre-push-core.sh does) is consumed exactly once — sourcing
# pre-push-project.sh FIRST reads no stdin at all (it only defines functions), so nothing is
# lost or re-read before pre-push-core.sh's own capture runs.
#
# Resolved RELATIVE TO CWD, not from `$0` and not via git — same reasoning as
# .husky/pre-push's own header comment (git runs hooks from the worktree top level;
# scripts/pre-push-hook.test.mjs runs this under a fake git whose catch-all makes
# `git rev-parse --show-toplevel` resolve to nothing).
#
# Project file sourced BEFORE core: sourcing only DEFINES pre-push-project.sh's
# `pp_project_*` functions (a side-effect-free act), so by the time pre-push-core.sh's own
# top-to-bottom execution reaches a "project hook seam" call, the function it looks for
# already exists — reversing this order would make every seam's very first check find
# nothing, even with the project file present.
#
# PP_PROJECT_PRESENT is the explicit signal core reads (review findings fb9352/6aa9d3, plan
# 3963): the seam dispatcher (pp_run_project_seam, defined in pre-push-core.sh) branches on
# this FLAG, never on `command -v pp_project_<name>` directly — `command -v` also resolves a
# PATH EXECUTABLE, not just a shell function, so a core-only checkout with some unrelated
# `pp_project_<name>` binary on PATH would otherwise find and RUN it. This flag is a plain
# shell variable, not exported: both files are SOURCED into this one shell (never exec'd), so
# it survives into pre-push-core.sh without needing to cross a process boundary, and staying
# unexported means it does not leak into anything either file shells out to.
#
# An ABSENT project file is fail-CLOSED, not automatically read as "generic-core checkout"
# (review round 2, finding 25a722; hardened further in review round 3, findings ec4189/dc9ccd/
# 0c721a/f1ac81/3623e4/574115/a80be2/19587f/9f2894/fd2f3b/6fd062): a bare `-f` test cannot tell a
# legitimate generic-core checkout (the file was never part of this tree) apart from a VETAPP
# checkout that lost the file — a plain working-tree deletion, or a STAGED deletion (`git rm
# scripts/hooks/pre-push-project.sh`, which drops the path from the INDEX while HEAD still
# carries it). Both silently ran core-only under the old bare `-f` check, and round 2's fix still
# missed the staged-deletion case (its single `git ls-files --error-unmatch` probe reads the
# INDEX only) and treated ANY OTHER `git ls-files` failure — an unreadable index, an inherited
# GIT_INDEX_FILE — as proof of "untracked" too. Both gaps skip every seed/price/pytest/mobile gate
# with no error at all.
#
# Two independent git facts settle this now, and BOTH must cleanly answer "never tracked" before
# falling through to the generic-core continuation — a probe FAILING to answer is a hard error,
# never read as proof of "untracked":
#   1. `git ls-files --error-unmatch -- <path>` — is the path in the INDEX right now? Exits 0 when
#      tracked there (regardless of working-tree presence — this is how it sees a plain
#      deletion), 1 when it is not in the index, some other code when git itself could not answer.
#   2. `git rev-parse --verify -q HEAD:<path>` — is the path tracked at HEAD? A staged deletion
#      (`git rm`) removes the path from the index (probe 1 says "not tracked") while HEAD still
#      carries it (probe 2 says "tracked") — exactly the shape probe 1 alone cannot see. This is
#      `rev-parse --verify -q`, deliberately NOT `git cat-file -e HEAD:<path>` (measured, not
#      assumed): `cat-file -e` resolves a `tree:path` argument by first turning it into an object
#      id, and a path genuinely absent at HEAD fails THAT resolution step with the same `fatal:`
#      exit 128 a real git error would — there is no clean 0/1 split to read. `rev-parse --verify
#      -q` resolves the identical `HEAD:<path>` syntax but reports a missing path as an ordinary
#      exit 1, matching probe 1's own 0/1/other convention, and — measured — is unaffected by a
#      corrupt index (it reads the commit's tree object, never the working index), so a corrupt
#      index cannot make this SECOND probe falsely claim "not tracked".
# So:
#   - probe 1 exits 0                          -> tracked in the index, absent from the working
#                                                  tree -> hard error (a plain deletion).
#   - probe 1 exits 1, then probe 2 exits 0    -> tracked at HEAD but staged for deletion ->
#                                                  hard error.
#   - probe 1 exits 1, then probe 2 exits 1    -> never tracked anywhere (an unborn HEAD with no
#                                                  commits yet also lands here, measured) -> the
#                                                  legitimate generic-core checkout, continue
#                                                  exactly as before this fix.
#   - EITHER probe exits anything else (no git on PATH, a corrupt index on probe 1, not a git
#     repo, ...) -> hard error: git could not determine whether the project file is tracked, so
#     the push is REFUSED rather than guessed into a silent core-only run. This is the one
#     behavior change from round 2's documented "errored read as untracked is deliberate
#     fail-open" — a probe failure is no longer indistinguishable from a genuinely untracked path.
# The test harness's fake git (scripts/pre-push-hook.test.mjs) answers BOTH probes with a
# non-zero/errored result by default, so every pre-existing core-only fixture keeps taking the
# same continue-as-before path unless a fixture explicitly opts into one of the tracked cases.
PP_PROJECT_PRESENT=0
if [ -f ./scripts/hooks/pre-push-project.sh ]; then
  . ./scripts/hooks/pre-push-project.sh
  PP_PROJECT_PRESENT=1
else
  # Both probes below use `if cmd; then rc=0; else rc=$?; fi`, never a bare `cmd; rc=$?`: this
  # whole file is sourced (never exec'd) under `sh -e`, and a BARE command's nonzero exit is NOT
  # exempt from errexit the way a command used directly as an `if`/`elif`/`&&`/`||` condition is
  # — a bare `git ls-files …; rc=$?` would abort the push right there, silently, before this
  # script ever gets a chance to read $rc and print a diagnosis (the exact "silent herd failure"
  # class this file's OWN header incident, plan 336, exists to prevent). Wrapping the probe as
  # the condition of an `if` keeps it exempt while still letting us capture its real exit code.
  if git ls-files --error-unmatch -- scripts/hooks/pre-push-project.sh >/dev/null 2>&1; then
    ppp_rc=0
  else
    ppp_rc=$?
  fi
  if [ "$ppp_rc" = 0 ]; then
    echo "pre-push: scripts/hooks/pre-push-project.sh is TRACKED but absent from this working tree (found in the index)." >&2
    echo "pre-push: this repo runs vetapp-specific gates (seed/price/pytest/mobile/...) on every push — a tracked-but-absent project file means a WORKING-TREE DELETION, not a legitimate generic-core checkout, so this is a hard error rather than a silent core-only fallback." >&2
    echo "pre-push: fix with: git checkout -- scripts/hooks/pre-push-project.sh   (restore the deleted working-tree file)" >&2
    exit 1
  elif [ "$ppp_rc" = 1 ]; then
    if git rev-parse --verify -q HEAD:scripts/hooks/pre-push-project.sh >/dev/null 2>&1; then
      ppp_rc2=0
    else
      ppp_rc2=$?
    fi
    if [ "$ppp_rc2" = 0 ]; then
      echo "pre-push: scripts/hooks/pre-push-project.sh is tracked at HEAD but STAGED FOR DELETION (removed from the index, e.g. by \`git rm\`)." >&2
      echo "pre-push: this repo runs vetapp-specific gates (seed/price/pytest/mobile/...) on every push — a tracked-then-staged-deleted project file is not a legitimate generic-core checkout, so this is a hard error rather than a silent core-only fallback." >&2
      echo "pre-push: fix with: git restore --staged --worktree scripts/hooks/pre-push-project.sh   (unstage and restore the deletion; a vetapp checkout must ship this file)" >&2
      exit 1
    elif [ "$ppp_rc2" != 1 ]; then
      echo "pre-push: could not determine whether scripts/hooks/pre-push-project.sh is tracked at HEAD (\`git rev-parse --verify -q HEAD:...\` exited $ppp_rc2)." >&2
      echo "pre-push: refusing to guess — this repo runs vetapp-specific gates on every push, so an undetermined tracking state is a hard error rather than a silent core-only fallback." >&2
      exit 1
    fi
    # ppp_rc2 = 1: never tracked at HEAD either — genuinely untracked, the legitimate
    # generic-core checkout. Continue with PP_PROJECT_PRESENT=0, exactly as before this fix.
  else
    echo "pre-push: could not determine whether scripts/hooks/pre-push-project.sh is tracked (\`git ls-files --error-unmatch\` exited $ppp_rc)." >&2
    echo "pre-push: refusing to guess — this repo runs vetapp-specific gates on every push, so an undetermined tracking state is a hard error rather than a silent core-only fallback." >&2
    exit 1
  fi
fi
. ./scripts/hooks/pre-push-core.sh
