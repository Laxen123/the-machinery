#!/usr/bin/env node
// scripts/heal-main.mjs — the ONE sanctioned recovery path for a wedged shared main
// checkout (plan 1286, post-mortem of the 2026-07-02 shared-checkout thrash).
//
// During the incident, ad-hoc recovery (hand `git pull --rebase` on MAIN with foreign
// staged files, bare `git pull --ff-only` under a multi-branch FETCH_HEAD, blind
// `rm index.lock`, a marker-dropping merge) wedged sessions on BOTH machines. This script
// replaces all of it: on ANY main-checkout wedge, run
//
//   node scripts/heal-main.mjs [--dry] [--json]
//
// and nothing else. Idempotent — a second run on a healed checkout reports all-clean.
//
// Taxonomy (each step detects, repairs, and journals):
//   0. a TRUNCATED index (plan 3968) — a torn lint-staged/pathspec-commit index write reads
//      the whole tree as deleted; rebuilt with `git reset` (mixed) before anything else runs,
//      since every later step below reasons from `git status`.
//   1. stale index.locks — the shared MAIN lock (30 s STALE_LOCK_MS gate) AND every linked
//      worktree's lock (3 s gate; absorbs clear-stale-worktree-lock.mjs and fixes its
//      from-main silent no-op, incident root cause D)
//   2. leftover rebase state (.git/rebase-merge / rebase-apply from a killed
//      pushMasterWithRebase) → `git rebase --abort` (fallback `--quit`)
//   3. detached MAIN HEAD → reattach to `master` iff the detached commit is an ancestor of
//      origin/master (nothing stranded); else surface LOUDLY and leave it
//   4. master out of sync with origin — BEHIND → ffMasterFromOrigin (immune to the
//      "Cannot fast-forward to multiple branches" FETCH_HEAD race that wedged two hand
//      recoveries); AHEAD/diverged (an unpushed local commit) → pushMasterWithRebase when
//      the tracked tree is clean, else surface
//   5. interrupted coord ops — `start` entries in the coord-op journal with no closing
//      done/error line and a dead pid (this host) are reported as evidence; their tree/lock
//      residue is already self-healed by steps 1–4 + the coord-checkout hard reset
//   6. orphaned dirt on MAIN — delegated to the sanctioned committer/stasher
//      (pre-yield-guard --commit-safe semantics: idle pure-doc dirt commits+pushes, config/
//      code/mixes park in a NAMED stash; young dirt is left alone) — never a hand `git add`
//      of a sibling's stray file "in passing"
//   7. stash/claim residue — delegated to sweep-stray-stashes.mjs and
//      sweep-acquire-residue.mjs (report-only here; run them directly to apply)
//
// Single-actor: steps 1–4 run under the coord-write lock (withCoordLock), so a second
// concurrent healer QUEUES instead of racing, and no coord write interleaves mid-repair.
// Step 6 self-locks inside pre-yield-guard; steps 5/7 are read-only.
//
// Permission-classifier note (incident root cause D): this script's own command surface
// contains no destructive verbs — the reattach is `git switch master`, lock clears are
// provably-stale unlinks, the rebase repair is `--abort`/`--quit` — and
// .claude/settings.json allowlists `node scripts/heal-main.mjs` (and claim-plan) so the
// auto-mode classifier can never block the sanctioned recovery path mid-incident.
//
// Exit codes: 0 = clean (nothing to do, or everything repaired); 1 = at least one step is
// BLOCKED and needs the operator (the report names it); 2 = usage/setup failure.

import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  resolveMain,
  git,
  gitWithLockRetry,
  clearStaleIndexLockDetailed,
  sweepWorktreeIndexLocks,
  STALE_LOCK_MS,
  WORKTREE_LOCK_STALE_MS,
  isAncestorRef,
  reattachMainToMaster,
  ffMasterFromOrigin,
  pushMasterWithRebase,
  withCoordLock,
  readCoordOpJournal,
  journalCoordOp,
  rebaseOwnerToken,
  errText,
  errSummary,
  SWEEP_SURFACED_EXIT,
  coordCheckoutPath,
  COORD_CHECKOUT_GIT_TIMEOUT_MS,
} from './coord-git.mjs';
import { resolveCommonDirPath } from './lock-path.mjs';
// plan 2948: the ONE `/proc/<pid>/stat` parsing convention (kill-tree owns it; worktree-lock and
// coord-git already reuse it). Needed here to tell a ZOMBIE from a live pid — see `pidAlive`.
import { procStatFields } from './kill-tree.mjs';
import { guard } from './pre-yield-guard.mjs';
// plan 3968: the ONE truncated-index predicate — see its own header for the mechanism.
import { checkIndexSanity } from './index-sanity.mjs';
// plan 4087 T3: the live hang probe — see coord-child-probe.mjs's own header for why it is a
// separate module and how its tests satisfy the platform-symbol rule.
import {
  listCoordChildren,
  killHungCoordChildren,
  formatAge,
  HUNG_COORD_CHILD_KILL_AGE_MS,
} from './coord-child-probe.mjs';

const commonDir = (mainDir) => resolveCommonDirPath({ anchor: mainDir });

// plan 4026: how many paths healStaleIndex hands one `git diff -- <pathspec…>` call. Bounded
// because a pathspec list is argv and this runs on a 132k-path checkout.
export const STALE_INDEX_PATHSPEC_CHUNK = 100;

// plan 4026: above this many differing paths healStaleIndex refuses to verify (and so never
// resets). A killed stash leaves a handful; hundreds is a different state, and the per-path
// disk check is a git call each.
export const STALE_INDEX_MAX_PATHS = 200;

// Step result shape: { step, status: 'clean'|'fixed'|'would-fix'|'blocked', detail, ...extra }.
// `extra` carries STRUCTURED flags a later step in the same run needs to key off of (e.g.
// `sparedForLock`/`removedMainLock` below) — never parse `detail` (a human-readable string) to
// recover a decision another step already made in structured form (plan 3968 review, f420dd).
const r = (step, status, detail, extra = {}) => ({ step, status, detail, ...extra });

// ── 0. truncated index (plan 3968: a torn lint-staged/pathspec-commit index write) ─────
// Runs FIRST, before every other step — every later step reads `git status`, and a
// truncated index makes status lie ("the whole tree deleted plus untracked"), which
// would send healStaleLocks/healRebaseResidue/healDetachedHead/healMasterSync/healDirt
// reasoning about a MAIN state that was never real.
//
// `git reset` (mixed, the default) rebuilds the index from HEAD's tree without touching
// the working tree — exactly what the 2026-09-12 incident's manual recovery did (`git
// reset` rebuilt a correct 11.5 MB index in one pass; working files were intact the
// whole time). A real modification/deletion the working tree actually carries is still
// visible in `git status` afterwards — this only discards the TORN index bookkeeping,
// never a file.
export function healTruncatedIndex(mainDir, { dry = false, exec = execFileSync } = {}) {
  // `exec` is a testability seam only (mirrors index-sanity.mjs's own `exec` option) — no
  // production caller passes it; it exists so a test can inject a probe failure and pin the
  // `unknown` arm below without needing to reproduce a real git-level corruption on disk.
  const sanity = checkIndexSanity(mainDir, { exec });
  // plan 3968 review round 2 (6f8265): a probe-error `unknown` verdict must never be treated
  // as "index OK" — this step cannot tell whether the index is fine or torn, so it skips the
  // reset (a `git reset` would be a guess either way) and says so plainly rather than
  // reporting a false-healthy "clean".
  //
  // plan 3968 review round 3 (f2095d): 'clean' plus a side flag was itself the bug — the CLI's
  // own `main()` only treats a literal 'blocked' status as unsafe (exit 1, "need the
  // operator"); a `status: 'clean'` result here reads as verified-healthy to that switch no
  // matter what extra field rides along, so an unreadable index could print "heal-main: all
  // clean." Report 'blocked' directly; `indexStateUnknown` stays as the structured flag other
  // steps (runHeal's own retry logic elsewhere in this file) can still key off of.
  if (sanity.unknown) {
    return [
      r('truncated-index', 'blocked', `index state could not be verified (${sanity.why})`, {
        indexStateUnknown: true,
      }),
    ];
  }
  if (!sanity.truncated) return [r('truncated-index', 'clean', `index OK (${sanity.why})`)];
  const lockPath = join(commonDir(mainDir), 'index.lock');
  if (existsSync(lockPath)) {
    // Never delete a live lock (worktree-guard.sh denies the raw form on purpose) — some
    // other process may be mid-write to the very index this step would otherwise reset.
    return [
      r(
        'truncated-index',
        'clean',
        `index looks TRUNCATED (${sanity.why}) but index.lock is present — spared, something else may be writing it; re-run heal-main once it clears`,
        { sparedForLock: true },
      ),
    ];
  }
  if (dry)
    return [
      r(
        'truncated-index',
        'would-fix',
        `index looks TRUNCATED (${sanity.why}) → git reset (mixed) to rebuild it from HEAD`,
      ),
    ];
  try {
    gitWithLockRetry(mainDir, ['reset']);
    return [r('truncated-index', 'fixed', `rebuilt a truncated index from HEAD (${sanity.why})`)];
  } catch (e) {
    return [
      r(
        'truncated-index',
        'blocked',
        `git reset failed to rebuild the index: ${errText(e).split('\n')[0]}`,
      ),
    ];
  }
}

// ── 0b. stale index (plan 4026: a park killed mid-`git stash push`) ────────────────────
// `git stash push` rewrites the WORKING TREE to HEAD first and writes the index second. A kill
// between those two steps — the Stop-hook park hitting its harness timeout, measured on the
// shared MAIN checkout 2026-09-14 — leaves a perfectly FULL index that is nonetheless older
// than HEAD: every file on disk matches HEAD byte for byte, yet `git status` shows staged
// renames/deletions and `git merge --ff-only origin/master` refuses, so every sibling session's
// sync is wedged until a human clears it.
//
// This is its own step, NOT a third signal inside checkIndexSanity: that predicate answers "is
// the index TRUNCATED" (a torn write, <10 % of HEAD's paths), a different question with a
// different repair. A stale-but-full index reads as perfectly healthy to it.
//
// The repair is `git reset` (mixed — rebuilds the index from HEAD, never touches a file), the
// same one-liner the 2026-09-14 incident was cleared with by hand. It is safe ONLY when the
// index holds nothing that is not already in HEAD, so all four signals must hold:
//   (1) `git write-tree` of the current index succeeds and ≠ HEAD^{tree}. An index that will
//       not even write a tree (unmerged entries) is never reset — we cannot reason about it.
//       (Evaluated AFTER (2): write-tree writes objects for a 132k-path index, so the cheap
//       read-only diff settles the healthy common case first.)
//   (2) `git diff --cached HEAD` names at least one path.
//   (3) EVERY path from (2) matches HEAD on disk: present in HEAD ⇒ the working file hashes to
//       HEAD's blob; absent from HEAD ⇒ absent on disk. Compared blob-to-blob (`ls-tree` +
//       `hash-object --path=`), NOT with `git diff HEAD` — that reads the working tree THROUGH
//       the index, so a path this very defect staged as deleted reads as deleted while the
//       file sits on disk holding HEAD's exact bytes.
//   (4) no index.lock (something may be mid-write) and no rebase in progress (a rebase owns an
//       index that legitimately differs from HEAD).
// Any path failing (3) is REAL uncommitted work: name it and touch nothing. That conservatism
// is the plan-3968 lesson — a one-signal index check reset a sparse checkout's selection.
//
// Status discipline (review round 3, six angles on one arm plus the Claude arm): this step says
// `clean` ONLY when it genuinely verified the index — matching HEAD, or deliberately spared for
// a reason that is itself healthy (a live index.lock, a rebase in progress, both of which are
// re-tried or owned elsewhere). Every arm that could NOT verify — an unreadable probe, an
// unmergeable index, an unreadable HEAD, a failed per-path comparison, a set over the
// verification cap — says `blocked`, because heal-main's own CLI reads any non-`blocked` status
// as verified-healthy and would print "all clean" over an index nothing looked at.
export function healStaleIndex(mainDir, { dry = false, maxPaths = STALE_INDEX_MAX_PATHS } = {}) {
  const common = commonDir(mainDir);

  // (4) FIRST — before any git call. `git diff --cached` refreshes the index's stat cache, so it
  // needs `index.lock` itself and FAILS while one is held; probing first therefore turns a
  // perfectly ordinary stale lock into a `blocked` verdict that halts the run before
  // healStaleLocks ever gets to clear it (caught by the existing wedged-repo test on the round-4
  // attempt to reorder these). Spare early instead, and let runHeal's retry re-run this step
  // once the lock is gone — a spare that SURVIVES that retry is what halts the run (round 4,
  // finding at :1421), because it means the lock was genuinely live and nothing verified the
  // index.
  //
  // Checked here rather than relying on step order: this step runs BEFORE healStaleLocks and
  // healRebaseResidue, so it cannot assume either has already cleared the way.
  if (existsSync(join(common, 'index.lock')))
    return [
      r(
        'stale-index',
        'clean',
        'index.lock is present — spared, something else may be writing the index; re-run heal-main once it clears',
        // Structured, mirroring healTruncatedIndex's own flag: runHeal retries this step when
        // healStaleLocks turns out to have REMOVED that lock (findings e23cfb/a79349/f6c809), and
        // halts the run when the retry still cannot verify (round 4, finding at :1421).
        { sparedForLock: true },
      ),
    ];
  const rebase = ['rebase-merge', 'rebase-apply'].filter((d) => existsSync(join(common, d)));
  if (rebase.length)
    return [
      r(
        'stale-index',
        'clean',
        `rebase in progress (${rebase.join(', ')}) — index differs from HEAD by design`,
      ),
    ];

  // (2) next, then (1) — the header's numbering is the logical order, not the evaluation order
  // (review finding 4f65f9). `write-tree` WRITES tree objects for a 132k-path index, so running
  // it on every heal pass of a healthy checkout is real cost for nothing; the cheap read-only
  // `diff --cached` settles the common case. `--no-renames` so both sides of a staged rename
  // arrive as plain A/D entries; `-z` so a path with a space or a non-ASCII byte is not
  // git-quoted (the shared checkout carries plan filenames with å/ä/ö).
  // Wrapped like every other git call in this step (review finding on the round-1 diff): an
  // unhandled throw here would escape runHeal and abort the whole heal pass.
  let staged;
  try {
    staged = gitWithLockRetry(mainDir, [
      'diff',
      '--cached',
      '--no-renames',
      '--name-only',
      '-z',
      'HEAD',
    ])
      .split('\0')
      .filter(Boolean);
  } catch (e) {
    return [r('stale-index', 'blocked', `staged diff unreadable, not touched (${errSummary(e)})`)];
  }
  if (!staged.length) return [r('stale-index', 'clean', 'index tree matches HEAD')];

  // (1) — a write-tree failure means unmerged entries (or a genuinely broken index); either way
  // a reset would be a guess, and a conflicted merge's index SHOULD differ from HEAD.
  let indexTree;
  try {
    indexTree = gitWithLockRetry(mainDir, ['write-tree']).trim();
  } catch (e) {
    return [
      r('stale-index', 'blocked', `unmergeable index, not touched (${errSummary(e)})`, {
        unmergeableIndex: true,
      }),
    ];
  }
  let headTree;
  try {
    headTree = gitWithLockRetry(mainDir, ['rev-parse', 'HEAD^{tree}']).trim();
  } catch (e) {
    return [r('stale-index', 'blocked', `HEAD tree unreadable, not touched (${errSummary(e)})`)];
  }
  if (indexTree === headTree)
    return [r('stale-index', 'clean', 'index tree matches HEAD despite a non-empty staged diff')];

  // A stale index left by a killed stash names a handful of paths (the 2026-09-14 incident
  // named 8). Hundreds is some OTHER state entirely, and signal (3) costs a git call per path —
  // refuse rather than grind, and rather than guess.
  // `maxPaths` is a testability seam only (mirroring healTruncatedIndex's `exec`) — no
  // production caller passes it; it exists so a test can pin this arm without staging 200 files.
  if (staged.length > maxPaths)
    return [
      r(
        'stale-index',
        // `blocked`, not `clean` — review round 2 (angle-A/altitude/guard-fires, unanimous): the
        // CLI's own switch reads any non-`blocked` status as verified-healthy and prints "all
        // clean", so an UNVERIFIED index must not ride home under it. Exactly the plan-3968
        // lesson healTruncatedIndex already learned for its probe-error arm.
        'blocked',
        `index differs from HEAD at ${staged.length} path(s), over the ${maxPaths}-path verification cap — nothing was checked and nothing was touched; inspect it by hand (a killed-stash residue names a handful of paths, not hundreds)`,
        { refusedOverCap: true, pathCount: staged.length },
      ),
    ];

  // (3) — two halves, both required, because a reset can lose work from EITHER side:
  //
  //   disk side — what the WORKING TREE holds at each differing path must be exactly HEAD's
  //   bytes. Compared blob-to-blob (`ls-tree` for HEAD, `hash-object --path=` for disk), NOT
  //   with `git diff HEAD`: that reads the working tree THROUGH the index, so a path this very
  //   defect staged as deleted reads as deleted even while the file sits on disk holding HEAD's
  //   exact bytes — the precise case this step exists to recognise (verified on a fixture,
  //   2026-09-20). `--path=` makes hash-object apply the same clean filters git would on
  //   staging, so a CRLF-normalised file is not misread as real dirt.
  //
  //   index side (review round 1, findings 9f18f8/de70a0/650746/c8a775) — the disk check alone
  //   is NOT enough: `git add <edit>` followed by restoring the file to HEAD, or `git add <new
  //   file>` followed by deleting it from disk, both leave disk == HEAD while the ONLY copy of
  //   real work lives in the index. A reset would destroy it. So an index entry at a differing
  //   path is safe ONLY as one half of a staged RENAME of unchanged content — the killed-stash
  //   shape — which means it must PAIR with a rename source: a path that HEAD has, the index no
  //   longer does, and whose HEAD blob AND mode are exactly this entry's. Each source pairs
  //   once. Round 2 tightened this from "its blob appears at some HEAD path in the set", which
  //   cleared genuine staged work that merely shared content with an unrelated committed file
  //   (findings at :337, six angles including the Claude arm) and skipped the mode check on a
  //   rename destination entirely (findings at :341). MODE is compared on both arms
  //   (2089fb/a3f227/b66f24), so a staged chmod is never silently reverted.
  //
  // Known and accepted limitation: a bare `git rm --cached <unchanged file>` is byte-identical
  // to this defect's residue — same staged deletion, same HEAD bytes on disk, nothing in the
  // index to lose — so a reset re-stages it. No CONTENT is lost, only the untrack intent, and
  // refusing that shape would refuse the repair itself (the 2026-09-14 index staged exactly
  // three such deletions).
  const realDirt = [];
  try {
    const headEntries = new Map(); // path → { sha, mode }
    const indexEntries = new Map(); // path → { sha, mode }
    for (let i = 0; i < staged.length; i += STALE_INDEX_PATHSPEC_CHUNK) {
      const chunk = staged.slice(i, i + STALE_INDEX_PATHSPEC_CHUNK);
      // "<mode> <type> <sha>\t<path>"
      for (const row of gitWithLockRetry(mainDir, ['ls-tree', '-z', '-r', 'HEAD', '--', ...chunk])
        .split('\0')
        .filter(Boolean)) {
        const tab = row.indexOf('\t');
        if (tab === -1) continue;
        const [mode, type, sha] = row.slice(0, tab).split(/\s+/);
        if (type === 'blob') headEntries.set(row.slice(tab + 1), { sha, mode });
      }
      // "<mode> <sha> <stage>\t<path>"
      for (const row of gitWithLockRetry(mainDir, ['ls-files', '-s', '-z', '--', ...chunk])
        .split('\0')
        .filter(Boolean)) {
        const tab = row.indexOf('\t');
        if (tab === -1) continue;
        const [mode, sha] = row.slice(0, tab).split(/\s+/);
        indexEntries.set(row.slice(tab + 1), { sha, mode });
      }
    }
    // Rename SOURCES: a path HEAD has and the index no longer does. Keyed `sha:mode` so a
    // destination must match both, and counted so N sources pair with at most N destinations —
    // two staged copies of one committed file are not two renames.
    const availableSources = new Map();
    for (const [p, e] of headEntries) {
      if (indexEntries.has(p)) continue;
      const k = `${e.sha}:${e.mode}`;
      availableSources.set(k, (availableSources.get(k) ?? 0) + 1);
    }
    for (const p of staged) {
      const head = headEntries.get(p);
      const inIndex = indexEntries.get(p);
      const onDisk = existsSync(join(mainDir, p));
      // Index side.
      if (inIndex) {
        if (head) {
          // In HEAD and in the index, yet listed as differing ⇒ the index holds a staged EDIT
          // (or chmod) of a tracked file. That is real work by construction; a reset drops it.
          realDirt.push(p);
          continue;
        }
        // Absent from HEAD: safe only as a rename destination paired with a real source.
        const k = `${inIndex.sha}:${inIndex.mode}`;
        const left = availableSources.get(k) ?? 0;
        if (left === 0) {
          realDirt.push(p);
          continue;
        }
        availableSources.set(k, left - 1);
      }
      // Disk side.
      if (!head) {
        // Absent from HEAD (a rename destination): a reset unstages it, so it is only safe when
        // there is no file on disk to be orphaned.
        if (onDisk) realDirt.push(p);
        continue;
      }
      if (!onDisk) {
        realDirt.push(p);
        continue;
      }
      const diskSha = gitWithLockRetry(mainDir, ['hash-object', `--path=${p}`, '--', p]).trim();
      if (diskSha !== head.sha) realDirt.push(p);
    }
  } catch (e) {
    return [
      r(
        'stale-index',
        'blocked',
        `could not compare disk against HEAD (${errSummary(e)}) — not touched`,
      ),
    ];
  }
  if (realDirt.length)
    return [
      r(
        'stale-index',
        'clean',
        `index differs from HEAD at ${staged.length} path(s) but ${realDirt[0]} is real dirt` +
          (realDirt.length > 1 ? ` (+${realDirt.length - 1} more)` : '') +
          ' — not touched',
        { realDirt },
      ),
    ];

  const why = `index tree ≠ HEAD at ${staged.length} path(s), all identical to HEAD on disk`;
  if (dry)
    return [r('stale-index', 'would-fix', `${why} → git reset (mixed) to rebuild it from HEAD`)];
  try {
    gitWithLockRetry(mainDir, ['reset', '-q']);
    return [r('stale-index', 'fixed', `rebuilt a stale index from HEAD (${why})`)];
  } catch (e) {
    return [r('stale-index', 'blocked', `git reset failed to rebuild the index: ${errSummary(e)}`)];
  }
}

// ── 1. stale index.locks (main + every linked worktree) ────────────────────────────────
// plan 4087 round-4 review (keys 1be773/108be0/efcdd2): both branches below used to collapse a
// STALE lock whose delete itself FAILED (a live handle denies removal — EPERM/EBUSY on Windows)
// into the wrong outcome. The worktree branch reported it as "fresh (spared)", which is simply
// false — a fresh lock and a stale-but-undeletable one call for different operator action. The
// main-lock branch was worse: its `else if (clearStaleIndexLock(...))` pushed NOTHING at all when
// the clear failed, so the lock could vanish from the report entirely (falling through to "no
// index.lock anywhere" if nothing else was wrong). Both now branch on the real
// `clearStaleIndexLockDetailed` outcome — 'removed' / 'delete-failed' / 'absent' — instead of a
// bare boolean, so a failed delete is reported as `blocked`, never silently dropped or misnamed
// `clean`. `_sweepWorktreeIndexLocks`/`_clearStaleIndexLockDetailed` are injectable so a test can
// pin an outcome without needing a real undeletable file on disk (Windows-only, handle-dependent).
export function healStaleLocks(
  mainDir,
  {
    dry = false,
    _sweepWorktreeIndexLocks = sweepWorktreeIndexLocks,
    _clearStaleIndexLockDetailed = clearStaleIndexLockDetailed,
  } = {},
) {
  const out = [];
  const mainLock = join(commonDir(mainDir), 'index.lock');
  if (existsSync(mainLock)) {
    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(mainLock).mtimeMs;
    } catch {
      /* vanished between exists and stat */
    }
    if (ageMs >= STALE_LOCK_MS) {
      if (dry) {
        out.push(
          r(
            'stale-locks',
            'would-fix',
            `main index.lock idle ${Math.round(ageMs / 1000)}s → remove`,
          ),
        );
      } else {
        const detail = _clearStaleIndexLockDetailed(mainDir, {
          staleMs: STALE_LOCK_MS,
          lockPath: mainLock,
        });
        if (detail.outcome === 'removed') {
          out.push(
            r(
              'stale-locks',
              'fixed',
              `removed stale main index.lock (idle ${Math.round(ageMs / 1000)}s)`,
              { removedMainLock: true },
            ),
          );
        } else if (detail.outcome === 'delete-failed') {
          out.push(
            r(
              'stale-locks',
              'blocked',
              `main index.lock idle ${Math.round(ageMs / 1000)}s but the delete itself failed ` +
                `(${errSummary(detail.error)}) — a live handle is denying removal, not "fresh"`,
            ),
          );
        } else if (detail.outcome === 'absent') {
          out.push(
            r(
              'stale-locks',
              'clean',
              'main index.lock vanished before it could be cleared (benign race)',
            ),
          );
        }
        // 'fresh' cannot occur here — the branch above already gated on the SAME staleMs.
      }
    } else if (ageMs > 0) {
      out.push(
        r(
          'stale-locks',
          'clean',
          `main index.lock present but fresh (${Math.round(ageMs / 1000)}s) — a live op may hold it, spared`,
        ),
      );
    }
  }
  for (const s of _sweepWorktreeIndexLocks(mainDir, { staleMs: WORKTREE_LOCK_STALE_MS, dry })) {
    if (s.outcome === 'removed') {
      out.push(r('stale-locks', 'fixed', `removed stale worktree index.lock: ${s.lockPath}`));
    } else if (s.outcome === 'dry-stale') {
      out.push(
        r(
          'stale-locks',
          'would-fix',
          `worktree index.lock idle ${Math.round(s.ageMs / 1000)}s → remove: ${s.lockPath}`,
        ),
      );
    } else if (s.outcome === 'delete-failed') {
      out.push(
        r(
          'stale-locks',
          'blocked',
          `worktree index.lock idle ${Math.round(s.ageMs / 1000)}s but the delete itself failed ` +
            `(${errSummary(s.error)}) — a live handle is denying removal, not "fresh": ${s.lockPath}`,
        ),
      );
    } else if (s.outcome === 'absent') {
      out.push(
        r(
          'stale-locks',
          'clean',
          `worktree index.lock vanished before it could be cleared (benign race): ${s.lockPath}`,
        ),
      );
    } else {
      out.push(r('stale-locks', 'clean', `worktree index.lock fresh (spared): ${s.lockPath}`));
    }
  }
  if (!out.length) out.push(r('stale-locks', 'clean', 'no index.lock anywhere'));
  return out;
}

// ── 2. leftover rebase state (a killed pushMasterWithRebase froze MAIN mid-rebase) ──────
// F-002 (plan 1312, 2026-07-02 coord audit + review follow-up): the abort is gated on TWO
// signals, because an unconditional abort could destroy a rebase genuinely in flight:
//   (1) JOURNAL LIVENESS (pid evidence, decisive): pushMasterWithRebase journals every rebase
//       attempt as an open `push-rebase` coord-op window. An open window whose pid is ALIVE →
//       the rebase is live, spare it regardless of age. Open window(s), ALL pids dead → the
//       rebaser was killed mid-flight, abort IMMEDIATELY (no wedge-window: this is the common
//       tool-timeout-SIGKILL case, healed as fast as pre-gate behavior).
//   (2) MTIME HUMAN-GATE (fallback for journal-less residue — an operator hand-rebase):
//       git touches rebase-merge/rebase-apply only at rebase-start and each --continue, NOT
//       while a human sits mid-conflict-resolution, so a short lock-style threshold would
//       abort a live human rebase. The gate is therefore HUMAN-timescale (15 min), not
//       STALE_LOCK_MS. Sanctioned rebasers never wait on it — signal (1) covers them.
//   (3) ABANDONED SHAPE (plan 2939, consulted only when (1) and (2) have not decided): a
//       session's OWN raw `git rebase` satisfies neither of the above — it journals nothing
//       and it is not a human — so it used to wedge the shared checkout for the full 15 min.
//       Keyed on the residue's shape rather than its age: no human-stop marker, a clean
//       tracked tree, and no live picker re-stamping it. Full derivation at its own block.
// NEVER "fix" this by shortening REBASE_RESIDUE_STALE_MS: that gate is correct for the case
// it was written for, and shortening it to cover agents puts it back in range of destroying a
// real operator rebase — the exact failure it exists to prevent.
// The coord-write lock remains the primary exclusion for sanctioned rebasers (heal-main's
// core and every sanctioned MAIN rebaser hold it, so a live one can't even be observed here).
export const REBASE_RESIDUE_STALE_MS = 15 * 60_000;
// A single push-rebase never legitimately runs this long — an open journal window older than
// this with a seemingly-alive pid is a RECYCLED pid, not a live rebase; ignore it so a stale
// window can never spare residue forever. Consulted only on the FALLBACK path now: a window
// carrying a readable process-identity token is answered by identity, with no clock at all.
const REBASE_WINDOW_RECENT_MS = 30 * 60_000;

// ── plan 2948: how much FUTURE-dating is jitter, and how much is a broken clock ──────────
// Both remaining clock-trusting signals — a journal entry's `ts` and a residue file's mtime —
// can read as dated in the FUTURE. A little of that is ordinary: a networked or virtualised
// filesystem whose clock runs slightly ahead of this process's, an NTP step mid-write. A lot
// of it is a clock that cannot be believed at all: a rollback, a copied `.git`, a sandbox
// before its first NTP sync.
//
// Below this bound a future date is treated as "just now" — the entry still counts as
// liveness, which is what keeps a clock-ahead filesystem's genuine progress writes from being
// thrown away (the CONFIRMED regression plan 2939's round-2→3 fix introduced). Beyond it the
// clock is PROVABLY unusable for that entry, and the operator's ruling decides which way to be
// wrong: abort, loudly (grill ruling 1, 2026-08-07) — and the abort wins even against a live
// pid on the fallback path (ruling 2). The asymmetry that earned it: an abort restores
// `ORIG_HEAD` and costs only replay progress, while sparing dead residue wedges MAIN for every
// parallel session until wall-clock catches up, which no re-run can clear.
//
// 2 minutes (ruling 3), ONE constant for BOTH signals, and the FUTURE direction only — a
// past-dated entry is ordinary aging, not skew. Far below REBASE_WINDOW_RECENT_MS (30 min), so
// it can only ever tighten the recency window, never loosen it.
export const CLOCK_SKEW_TOLERANCE_MS = 2 * 60_000;

// Liveness probe shared with reportInterruptedOps: EPERM ⇒ alive under another user.
//
// plan 2948: a ZOMBIE is refused FIRST. An unreaped process keeps its pid, so `kill(pid, 0)`
// succeeds on it and it reads as alive forever — while it is dead and will never touch the
// rebase again. This is the only place that can settle it: the identity token deliberately
// refuses to mint a token for a corpse, and "no token" degrades to exactly this probe, so
// without the check here the zombie refusal would accomplish nothing at all. `procStatFields`
// returns null off-Linux and when /proc is unreadable, which leaves the original behaviour
// verbatim on every host that cannot answer.
export const pidAlive = (pid, { _procStatFields = procStatFields } = {}) => {
  const fields = _procStatFields(pid); // [0] = state, per kill-tree's parsing convention
  if (fields && fields[0] === 'Z') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// ── plan 2948: is an open `push-rebase` window's owner still alive? ──────────────────────
// → { live, why, skewed }. Two tiers, and which one answers is decided by the ENTRY, not by
// the host: an entry carrying a `processStartTime` is answered by IDENTITY and never touches a
// clock; one without it (a pre-2948 entry, or a host where the probe returned null) degrades
// to the wall-clock rules made honest by grill rulings 1–3 — never straight to a verdict
// (ruling 6).
//
// Tier 1, IDENTITY (rulings 4–5). The token in the journal is compared BYTE-FOR-BYTE against
// the one this pid carries right now. Equal ⇒ the same process is still running ⇒ live, at any
// age, under any clock. Different ⇒ the pid was RECYCLED, which is precisely the hazard
// REBASE_WINDOW_RECENT_MS was a 30-minute guess at, now answered exactly. Unreadable (the pid
// is gone, or the OS refused) ⇒ no identity evidence; note that a vanished pid is ALSO what a
// dead owner looks like, so this falls through to tier 2 rather than concluding — tier 2's
// `alive()` probe is the one that distinguishes "gone" from "unreadable".
//
// Tier 2, CLOCK (rulings 1–3). A `ts` dated further into the future than the skew tolerance
// means the clock cannot be believed, and ruling 2 settles which evidence wins: the broken
// clock does, so the window does NOT spare — not even with a live pid. That is deliberately
// the mirror of what plan 2939's round-1 fix was CONFIRMED-bugged for; the difference is that
// it is now the operator's decision, the abort is loud, and it restores ORIG_HEAD. A `ts`
// that is unparseable is treated the same way: no usable age ⇒ no spare.
export function classifyRebaseWindow(e, alive, startTimeOf) {
  // A STRING, specifically. The journal is a file any process can corrupt, and a non-string
  // `processStartTime` (a `true`, a number, a truncated object) would divert off the clock path
  // on evidence that can never match a real token — reporting "recycled" on what is actually an
  // unreadable line. Requiring the shape keeps a corrupt entry on the fallback path, where the
  // clock rules give it a bounded answer.
  if (typeof e.processStartTime === 'string' && e.processStartTime) {
    const now = startTimeOf(e.pid);
    if (now)
      return now === e.processStartTime
        ? { live: true, why: `open journal window, pid ${e.pid} identity unchanged`, skewed: false }
        : {
            live: false,
            why: `pid ${e.pid} was recycled (process identity changed)`,
            skewed: false,
          };
    /* no identity evidence — fall through to the clock rules (ruling 6) */
  }
  const t = Date.parse(e.ts);
  if (!Number.isFinite(t))
    return { live: false, why: `journal window has an unparseable ts (${e.ts})`, skewed: true };
  const deltaMs = Date.now() - t;
  if (deltaMs < -CLOCK_SKEW_TOLERANCE_MS)
    return {
      live: false,
      why: `journal window is dated ${Math.round(-deltaMs / 1000)}s in the FUTURE`,
      skewed: true,
    };
  if (deltaMs >= REBASE_WINDOW_RECENT_MS)
    return {
      live: false,
      why: `journal window is ${Math.round(deltaMs / 60000)}min old (past the ${Math.round(REBASE_WINDOW_RECENT_MS / 60000)}min recency window)`,
      skewed: false,
    };
  return alive(e.pid)
    ? { live: true, why: `open journal window, pid ${e.pid} alive`, skewed: false }
    : { live: false, why: `pid ${e.pid} is dead`, skewed: false };
}

// Open (started, never closed) coord-op journal entries, oldest first.
export function openCoordOps(mainDir) {
  const open = new Map(); // token → start entry
  for (const e of readCoordOpJournal(mainDir)) {
    if (e.phase === 'start') open.set(e.token, e);
    else if (e.token) open.delete(e.token);
  }
  return [...open.values()];
}

// ── signal (3): the ABANDONED SHAPE (plan 2939) ────────────────────────────────────────
// Signals (1) and (2) both miss a session's OWN raw `git rebase` / `git pull --rebase`: it
// journals nothing (1 is blind) and it is not a human, so the 15-minute human gate (2) wedges
// the shared checkout for a quarter of an hour while every parallel session sees a detached
// MAIN. Measured 2026-08-06: a session's interrupted push-retry loop left exactly that state
// and heal-main reported "only 101s idle … possibly a live hand rebase, spared", so the
// recovery took the hand `git rebase --abort` this script exists to eliminate.
//
// The discriminator is the residue's SHAPE — not its age, not its journal. git writes a
// CONCRETE marker at every point where it stops and hands control to a person, so a residue
// carrying none of them, over a clean tracked tree, is one no human can be sitting in.
// Derived from real interrupted-rebase fixtures (git 2.43), not from prose:
//
//   state                                tracked tree   amend  stopped-sha  message/patch  done tail
//   conflict stop                        dirty (UU)      -        yes           yes         pick
//   conflict resolved + staged           dirty (M )      -        yes           yes         pick
//   conflict resolved to HEAD's content  CLEAN           -        yes           yes         pick
//   `edit` stop                          CLEAN          YES       yes           yes         edit
//   `squash` / `reword` stop             dirty          yes       yes           yes         squash
//   `break` stop                         CLEAN           -         -             -          break
//   failed `exec` stop                   CLEAN           -         -             -          exec <cmd>
//   KILLED mid-pick  (the target)        CLEAN           -         -             -          pick
//
// Only the last row is abort-eligible. Row 3 is why the marker set — not tree cleanliness
// alone — is the predicate: a human who resolves a conflict to content identical to HEAD
// leaves a CLEAN tree, and `stopped-sha` is the only thing standing between them and a
// destroyed rebase. Rows 6-7 are why the `done` tail is read: `break` and a failed `exec`
// stop deliberately, with a clean tree and no marker FILE at all.
//
// One caveat resolved by the fixtures rather than by either prose description in plan 2939:
// the todo/done CONSUMPTION state is not a usable discriminator. The measured incident's
// "the single pick was present in BOTH git-rebase-todo and done" reproduces exactly (git
// appends to `done` before it rewrites `git-rebase-todo`, and a kill in that window leaves
// the entry in both) — but so do "todo only" and "done only", depending on where the kill
// landed. It is a race window, not a signature; `git-rebase-todo.backup` additionally keeps
// the FULL original list forever, so any count-based reading of it is noise.
// REDUNDANT ON PURPOSE — the set is not minimal, and must not be minimised. A conflict stop
// writes all of `stopped-sha`, `message` and `patch`, so any ONE of them still spares the
// clean-tree identical-resolution case (row 3) if another is missing — which is the guard
// against a host whose git version writes a different subset than the one measured here.
const REBASE_STOP_MARKER_FILES = ['amend', 'stopped-sha', 'message', 'patch'];
// Sequencer commands that stop ON PURPOSE, leaving a clean tree and no marker file.
const REBASE_STOP_COMMANDS = new Set(['break', 'b', 'exec', 'x']);
// Porcelain XY codes that mean an unmerged path (reported distinctly — it is the loudest
// "a human is mid-resolution here" tell).
const PORCELAIN_UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

// The one shape a LIVE rebase shares with the target is the last row above: between picks a
// running rebase looks exactly like a killed one. This is the gate that separates them —
// git rewrites `git-rebase-todo`, `msgnum` and appends to `done` at EVERY pick boundary
// (measured: once per commit), so a residue whose FRESHEST entry has not moved in this long
// has no picker behind it. Deliberately NOT the human gate's 15 minutes and NOT a shortening
// of it: no human can be sitting in this shape, so the only thing waited out is a process.
//
// 3 minutes, not the 90 s a first cut used. The residual hazard this window buys down is a
// LIVE rebase that legitimately writes nothing for a while: one very large pick, a slow merge
// driver or hook, or a laptop suspend mid-rebase. It cannot be closed entirely without
// process/console evidence, which plan 2939 rejected as platform-specific and untestable —
// so it is bounded instead, and the cost of being wrong is bounded too: `git rebase --abort`
// restores ORIG_HEAD, losing replay progress but never a commit, while every state that holds
// UNRECOVERABLE human work (a resolution in the tree or the index) carries a marker above and
// is refused before this gate is ever consulted. A suspend longer than this is the known,
// accepted residual.
export const REBASE_ABANDONED_SHAPE_STALE_MS = 180_000;

// Files git rewrites as a rebase ADVANCES, in either backend — the liveness tell. Both
// backends also touch the dir itself, but the dir mtime alone can lag: `done` is APPENDED,
// which does not touch the dir entry.
//
// A NAMED list, not "every entry in the residue". Statting everything sounds more robust but
// admits noise as liveness: a non-progress entry git writes once at rebase start (notably
// `git-rebase-todo.backup`) rewritten by anything else then reads as recent activity and
// spares dead residue indefinitely. These four are what a rebase actually touches as it moves.
const REBASE_PROGRESS_FILES = ['git-rebase-todo', 'done', 'msgnum', 'next'];

// Age of the freshest thing in the residue. This is the ONE freshness derivation both the
// human gate and the shape gate use — deriving them separately is what let a live rebase whose
// dir mtime had gone stale bypass the shape check entirely and be aborted by the age path.
//
// → { ageMs, skewed, stated }: the freshest USABLE age, how many entries were beyond the
// future-skew tolerance, and how many could be stat'd at all. Three outcomes, and the caller
// needs all three kept apart (plan 2948):
//
//   stated === 0                → the residue VANISHED under us (a live rebase finished)
//   ageMs === null, skewed > 0  → every datable entry is future-dated beyond tolerance, i.e.
//                                 the clock is provably unusable HERE. Not "vanished", and not
//                                 "fresh" — a decided outcome the caller owes a verdict.
//   ageMs !== null              → real evidence; any beyond-tolerance entries were dropped
//
// Two directions of wrongness are load-bearing, and both were CONFIRMED regressions of plan
// 2939's reverted attempts:
//   • A future date WITHIN tolerance is clamped to 0, not discarded. A clock-ahead filesystem's
//     writes are a live rebase's genuine progress, and discarding them threw away exactly the
//     liveness the gate exists to detect.
//   • A future date BEYOND tolerance is dropped from the min, not passed through. Passed
//     through it is a NEGATIVE age that wins `Math.min` outright and pins the residue as
//     "just written" forever — the original defect. Dropped SILENTLY (the reverted attempt) an
//     all-future residue reads as "vanished" and wedges MAIN just as long; hence `skewed`,
//     which is what lets the caller tell the two nulls apart.
function residueFreshness(dir) {
  const ages = [];
  let skewed = 0;
  let stated = 0;
  for (const p of [dir, ...REBASE_PROGRESS_FILES.map((f) => join(dir, f))]) {
    let age;
    try {
      age = Date.now() - statSync(p).mtimeMs;
    } catch {
      continue; /* absent or vanished mid-check — the other entries still answer */
    }
    stated++;
    if (age < -CLOCK_SKEW_TOLERANCE_MS) skewed++;
    else ages.push(Math.max(0, age));
  }
  return { ageMs: ages.length ? Math.min(...ages) : null, skewed, stated };
}

// → { abandoned: boolean, why: string }. `why` reads as a clause in both the abort and the
// spare message, so every verdict names the evidence that produced it.
export function classifyAbandonedRebaseShape(
  mainDir,
  common,
  residue,
  { abandonedStaleMs = REBASE_ABANDONED_SHAPE_STALE_MS } = {},
) {
  // Merge-backend residue only. The `am` backend (`rebase-apply`, `git rebase --apply`) keeps
  // `patch`/`msg` present for the WHOLE run rather than only at a stop, so it has no marker
  // set to read; it falls through to the human gate unchanged. Modern git defaults to the
  // merge backend, and both pushMasterWithRebase and `git pull --rebase` use it.
  if (residue.length !== 1 || residue[0] !== 'rebase-merge')
    return { abandoned: false, why: `${residue.join('+')} is not merge-backend-only residue` };
  const dir = join(common, 'rebase-merge');

  // ONE directory snapshot answers both "is a marker present" and "has the sequencer started",
  // instead of a probe per marker inside the coord-lock critical section. An unreadable residue
  // dir is unanswerable → spare.
  let entries;
  try {
    entries = new Set(readdirSync(dir));
  } catch (e) {
    return { abandoned: false, why: `could not read the residue (${errText(e).split('\n')[0]})` };
  }
  const marker = REBASE_STOP_MARKER_FILES.find((f) => entries.has(f));
  if (marker) return { abandoned: false, why: `human-stop marker rebase-merge/${marker} present` };

  // No `done` ⇒ the sequencer has not run a single command yet, which is what `git rebase -i`
  // looks like while a HUMAN is still editing the todo in their $EDITOR: clean tree, no marker,
  // and nothing applied. Indistinguishable from an abandoned rebase by shape, so it defers to
  // the human gate — the one place a person legitimately sits for minutes with no marker.
  if (!entries.has('done'))
    return {
      abandoned: false,
      why: 'no `done` — the sequencer has not started (todo may be open in an editor)',
    };

  // A deliberate `break` / failed `exec` stop leaves no marker file — read the last thing the
  // sequencer actually did instead. Unreadable is NOT "nothing stopped it": an unanswerable
  // question spares, it never green-lights the abort.
  let doneTail;
  try {
    doneTail = readFileSync(join(dir, 'done'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
  } catch (e) {
    return { abandoned: false, why: `could not read done (${errText(e).split('\n')[0]})` };
  }
  if (!doneTail)
    return { abandoned: false, why: '`done` is empty — the sequencer has not started' };
  const lastCmd = doneTail.split(/\s+/)[0].toLowerCase();
  // Deliberately imprecise in the SAFE direction: git writes the same `exec <cmd>` line whether
  // the command succeeded (rebase continues) or failed (rebase stops), and records no exit
  // status, so a rebase killed just after a SUCCESSFUL exec is spared here and falls back to the
  // human gate. That costs coverage, never safety — the opposite reading would abort real stops.
  if (REBASE_STOP_COMMANDS.has(lastCmd))
    return { abandoned: false, why: `the sequencer stopped on purpose (done ends "${doneTail}")` };

  // Tracked-tree cleanliness. Untracked files are tolerated (`--untracked-files=no`) — the
  // same convention assertCleanOutsidePathspec uses, and step 6 owns MAIN's untracked dirt.
  let porcelain;
  try {
    porcelain = git(mainDir, ['status', '--porcelain', '--untracked-files=no'])
      .split('\n')
      .filter((l) => l.trim());
  } catch (e) {
    // Never abort on an unreadable tree — an unanswerable question is a spare, not a green light.
    return { abandoned: false, why: `could not read the tree (${errText(e).split('\n')[0]})` };
  }
  if (porcelain.length) {
    const unmerged = porcelain.filter((l) => PORCELAIN_UNMERGED.has(l.slice(0, 2)));
    return {
      abandoned: false,
      why: unmerged.length
        ? `${unmerged.length} unmerged path(s) — a human is mid-resolution`
        : `${porcelain.length} uncommitted tracked change(s)`,
    };
  }

  // Shape matches. Last: prove no picker is still behind it.
  const { ageMs: freshMs, skewed } = residueFreshness(dir);
  if (freshMs === null)
    return {
      abandoned: false,
      why: skewed
        ? `every residue entry is dated in the future beyond the ${Math.round(CLOCK_SKEW_TOLERANCE_MS / 1000)}s skew tolerance`
        : 'rebase state vanished mid-check',
    };
  if (freshMs < abandonedStaleMs)
    return {
      abandoned: false,
      why: `abandoned shape, but written ${Math.round(freshMs / 1000)}s ago — a live rebase re-stamps it every pick`,
    };
  return {
    abandoned: true,
    why: `abandoned shape (clean tracked tree, no human-stop marker, idle ${Math.round(freshMs / 1000)}s)`,
  };
}

export function healRebaseResidue(
  mainDir,
  {
    dry = false,
    staleMs = REBASE_RESIDUE_STALE_MS,
    abandonedStaleMs = REBASE_ABANDONED_SHAPE_STALE_MS,
    _alive,
    _beforeAbort,
    _startTime,
  } = {},
) {
  const common = commonDir(mainDir);
  const residue = ['rebase-merge', 'rebase-apply'].filter((d) => existsSync(join(common, d)));
  if (!residue.length) return [r('rebase-residue', 'clean', 'no rebase state')];
  // (1) journal liveness — process evidence beats mtime guessing.
  const alive = _alive || pidAlive;
  const startTimeOf = _startTime || rebaseOwnerToken;
  const openRebases = openCoordOps(mainDir).filter(
    (e) => e.tool === 'push-rebase' && e.host === hostname(),
  );
  // Classified LAZILY and at most once per window: `startTimeOf` is a subprocess on Windows and
  // this runs inside the coord-write lock's critical section, so the loop stops at the first
  // live owner (the common case — that is the whole reason a window is open) instead of probing
  // every remaining pid to answer a question already decided. Cached because the verdict is
  // read twice: once to decide, once to phrase.
  const classified = [];
  let live = null;
  for (const e of openRebases) {
    const c = classifyRebaseWindow(e, alive, startTimeOf);
    classified.push(c);
    if (c.live) {
      live = c;
      break;
    }
  }
  if (live)
    return [
      r(
        'rebase-residue',
        'clean',
        `a LIVE push-rebase holds the rebase state (${live.why}) — spared`,
      ),
    ];
  const ownerDied = openRebases.length > 0; // open window(s), none live → the rebaser was killed
  // The loud half of grill ruling 1: when a window was disbelieved because its clock is
  // unusable rather than because its owner is provably gone, the verdict has to SAY so — the
  // operator reading the report is the only one who can tell a skewed host from a dead one.
  const skewedWindow = classified.find((c) => c.skewed) || null;
  // (2) mtime human-gate for journal-less residue.
  // ONE freshness derivation for BOTH gates (residueFreshness: the dir AND the files git
  // rewrites as the rebase advances). Reading only the DIR mtime here is what let a live
  // journal-less rebase whose dir mtime had gone stale — `done` is appended, which does not
  // touch the dir entry — skip the shape check entirely and be aborted by the age path below.
  const ages = [];
  let skewedResidue = 0;
  let statedResidue = 0;
  for (const d of residue) {
    const f = residueFreshness(join(common, d));
    if (f.ageMs !== null) ages.push(f.ageMs);
    skewedResidue += f.skewed;
    statedResidue += f.stated;
  }
  // Two different nulls, and conflating them is what wedged MAIN in plan 2939's round-2→3
  // attempt. Nothing stat-able at all is a rebase that FINISHED under us — spare, as always.
  // Entries that exist but are all future-dated beyond tolerance is an unusable clock over
  // residue that is still very much present: ruling 1 says decide it, loudly, rather than
  // report a reassuring "vanished" that leaves MAIN detached until wall-clock catches up.
  // No usable age AND nothing skewed means nothing was stat-able at all — every entry either
  // never existed or vanished under us, which is what a rebase that FINISHED looks like. (A
  // successful stat always yields a datable-or-skewed entry, so `statedResidue` is necessarily 0
  // here; an earlier draft of this branch keyed a second message on it and was unreachable.)
  if (!ages.length && !skewedResidue)
    return [
      r('rebase-residue', 'clean', 'rebase state vanished mid-check (a live rebase completed)'),
    ];
  const clockUnusable = !ages.length && skewedResidue > 0;
  // Only reached when the clock IS usable; the unusable branch never consults it (see below).
  const ageMs = ages.length ? Math.min(...ages) : null;
  // (3) abandoned-shape — the only signal that reaches a session's own journal-less raw rebase
  // before the human gate's 15 minutes. Consulted only when (1) and (2) have not already
  // decided, so it can never weaken the live-owner spare or delay the dead-owner abort.
  // `clockUnusable` short-circuits it for the same reason: the shape gate's own last step is a
  // freshness comparison, so asking it under a clock we have already disbelieved would just
  // relaunch the guess. `ageMs` is null on that branch and every comparison below is guarded
  // by it — `null < staleMs` is TRUE in JS, which would silently route an unusable clock into
  // the spare path and undo ruling 1.
  const decidable = !ownerDied && !clockUnusable && ageMs < staleMs;
  const shape = decidable
    ? classifyAbandonedRebaseShape(mainDir, common, residue, { abandonedStaleMs })
    : { abandoned: false, why: '' };
  if (decidable && !shape.abandoned)
    return [
      r(
        'rebase-residue',
        'clean',
        `${residue.join('+')} present but only ${Math.round(ageMs / 1000)}s idle with no journal evidence of a dead owner — ${shape.why}, spared (idle ${Math.round(staleMs / 60000)}min → abort; re-run if it lingers)`,
      ),
    ];
  // Every abort names the evidence that produced it — grill ruling 1 makes that LOUDNESS part
  // of the contract, because a clock-skew abort is the one verdict an operator may need to go
  // fix the host over.
  const skewClause = `all ${statedResidue} residue entries dated >${Math.round(CLOCK_SKEW_TOLERANCE_MS / 1000)}s in the FUTURE — this host's clock is unusable, so liveness cannot be judged by time`;
  // A skewed window is named FIRST and carries the clock clause (it is the verdict that sends
  // an operator to fix the host); otherwise the window's own classification is reported
  // verbatim, so "pid 4242 was recycled (process identity changed)" is not flattened into the
  // generic "owner pid dead" it used to be — the identity signal's whole point is that it knows
  // WHICH of the two happened.
  const deadWindow = skewedWindow || classified[0];
  const why = clockUnusable
    ? skewClause
    : ownerDied
      ? `${deadWindow.why}${skewedWindow ? " — this host's clock is unusable, so liveness cannot be judged by time" : ''} (open push-rebase journal window)`
      : shape.abandoned
        ? shape.why
        : `idle ${Math.round(ageMs / 1000)}s`;
  if (dry)
    return [r('rebase-residue', 'would-fix', `${residue.join('+')} — ${why} → git rebase --abort`)];
  // Re-validate on the SHAPE path immediately before the destructive step. A raw rebase does
  // not hold the coord lock heal-main runs under, so nothing stops a human from staging a
  // resolution or reaching a stop between the classification above and the abort below. The
  // window is small and the re-check is cheap; the thing it protects is not recoverable.
  if (shape.abandoned) {
    if (_beforeAbort) _beforeAbort(); // test seam: simulate the race (same convention as _alive)
    const recheck = classifyAbandonedRebaseShape(mainDir, common, residue, { abandonedStaleMs });
    if (!recheck.abandoned)
      return [
        r(
          'rebase-residue',
          'clean',
          `${residue.join('+')} changed under us between check and abort — ${recheck.why}, spared`,
        ),
      ];
  }
  try {
    gitWithLockRetry(mainDir, ['rebase', '--abort']);
    // The applied verdict carries the same `why` the --dry one does (plan 2948). Every OTHER
    // verdict in this step already names its evidence — the runbook states that as the
    // contract — and the abort was the one that did not, which is precisely the verdict an
    // operator may need to act on: a clock-skew abort means go fix the host, and it is
    // indistinguishable from a routine dead-owner abort without this clause.
    return [
      r(
        'rebase-residue',
        'fixed',
        `aborted the interrupted rebase (${residue.join('+')}) — ${why}`,
      ),
    ];
  } catch (e) {
    // --abort can refuse on a half-created state (missing ORIG_HEAD); --quit drops the rebase
    // bookkeeping WITHOUT touching the working tree — safe, the tree state is then handled by
    // the detach/sync/dirt steps that follow.
    try {
      gitWithLockRetry(mainDir, ['rebase', '--quit']);
      return [
        r(
          'rebase-residue',
          'fixed',
          `rebase --abort refused (${errText(e).split('\n')[0]}); --quit dropped the leftover state — ${why}`,
        ),
      ];
    } catch (e2) {
      return [
        r(
          'rebase-residue',
          'blocked',
          `neither rebase --abort nor --quit cleared ${residue.join('+')}: ${errText(e2).split('\n')[0]}`,
        ),
      ];
    }
  }
}

// ── 3. detached MAIN HEAD ────────────────────────────────────────────────────────────────
export function healDetachedHead(mainDir, { dry = false } = {}) {
  let head;
  try {
    head = git(mainDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch (e) {
    return [r('detached-head', 'blocked', `cannot read HEAD: ${errText(e).split('\n')[0]}`)];
  }
  if (head === 'master') return [r('detached-head', 'clean', 'attached to master')];
  if (head !== 'HEAD')
    return [
      r(
        'detached-head',
        'blocked',
        `MAIN is on branch "${head}", not master — switch it back deliberately (\`git switch master\`); heal-main does not guess why it moved`,
      ),
    ];
  if (dry)
    return [
      r(
        'detached-head',
        'would-fix',
        'detached HEAD → reattach to master iff ancestor of origin/master',
      ),
    ];
  try {
    const res = reattachMainToMaster(mainDir);
    return [
      r(
        'detached-head',
        'fixed',
        `reattached master (was detached at ${String(res.from).slice(0, 9)})`,
      ),
    ];
  } catch (e) {
    return [r('detached-head', 'blocked', errText(e).split('\n').slice(0, 3).join(' '))];
  }
}

// ── 4. master vs origin sync ─────────────────────────────────────────────────────────────
export function healMasterSync(mainDir, { dry = false } = {}) {
  try {
    gitWithLockRetry(mainDir, ['fetch', '--quiet', 'origin', 'master']);
  } catch (e) {
    return [r('master-sync', 'blocked', `fetch failed (offline?): ${errText(e).split('\n')[0]}`)];
  }
  // Only judge/act when attached to master — a still-detached MAIN was surfaced by step 3.
  let head;
  try {
    head = git(mainDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch {
    head = null;
  }
  if (head !== 'master')
    return [r('master-sync', 'clean', 'skipped (MAIN not attached to master — see detached-head)')];
  const local = git(mainDir, ['rev-parse', 'master']).trim();
  const remote = git(mainDir, ['rev-parse', 'origin/master']).trim();
  if (local === remote) return [r('master-sync', 'clean', 'master == origin/master')];
  if (isAncestorRef(mainDir, local, remote)) {
    // BEHIND: plain catch-up. ffMasterFromOrigin retries through the FETCH_HEAD multi-branch
    // race (the wedge two hand recoveries hit with bare `git pull --ff-only`).
    if (dry) return [r('master-sync', 'would-fix', 'master behind origin → ffMasterFromOrigin')];
    try {
      ffMasterFromOrigin(mainDir);
      return [r('master-sync', 'fixed', `fast-forwarded master to origin (${remote.slice(0, 9)})`)];
    } catch (e) {
      return [
        r(
          'master-sync',
          'blocked',
          `ff failed (dirty files in the merge path?): ${errText(e).split('\n')[0]} — heal the dirt step first, then re-run`,
        ),
      ];
    }
  }
  // AHEAD or DIVERGED: an unpushed local commit (e.g. a --no-push record, a killed push).
  // pushMasterWithRebase needs a clean tracked tree for its rebase-retry.
  const dirty = git(mainDir, ['status', '--porcelain', '--untracked-files=no']).trim();
  if (dirty)
    return [
      r(
        'master-sync',
        'blocked',
        'master has unpushed local commit(s) AND a dirty tracked tree — let the dirt step park/commit the dirt, then re-run heal-main to push',
      ),
    ];
  if (dry) return [r('master-sync', 'would-fix', 'master ahead/diverged → pushMasterWithRebase')];
  try {
    pushMasterWithRebase(mainDir);
    return [
      r('master-sync', 'fixed', 'pushed the local master commit(s) to origin (rebase-retry)'),
    ];
  } catch (e) {
    return [r('master-sync', 'blocked', `push failed: ${errText(e).split('\n')[0]}`)];
  }
}

// ── 5. interrupted coord ops (journal evidence — read-only) ─────────────────────────────
export function reportInterruptedOps(mainDir, { _alive } = {}) {
  const alive = _alive || pidAlive; // EPERM ⇒ alive under another user; ESRCH ⇒ dead
  const out = [];
  for (const e of openCoordOps(mainDir)) {
    if (e.host !== hostname()) {
      out.push(
        r(
          'interrupted-ops',
          'clean',
          `open op ${e.tool} (${e.ts}) on host ${e.host} — cannot probe liveness cross-host; its lock stale-steals at 150s`,
        ),
      );
    } else if (!alive(e.pid)) {
      out.push(
        r(
          'interrupted-ops',
          'clean',
          `op ${e.tool} (${e.ts}, pid ${e.pid}) was KILLED mid-flight — residue self-heals (lock stale-steal + coord-checkout reset); evidence only`,
        ),
      );
    }
  }
  if (!out.length)
    out.push(r('interrupted-ops', 'clean', 'no interrupted coord ops in the journal'));
  return out;
}

// plan 4087 review fix (ykwr4h), tightened round 2 (finding heal-main.mjs:1193): the reporting
// floor for the NO-KILL branch below — deliberately separate from HUNG_COORD_CHILD_KILL_AGE_MS
// (still null; no measured kill ceiling has landed). Round 1 picked a flat 30-minute number,
// which hides a child that has been hung for, say, 10 minutes — a CHOSEN number, not a derived
// one. Every coord-checkout git child is now bounded by COORD_CHECKOUT_GIT_TIMEOUT_MS (90s,
// imported from coord-git.mjs, never copied — see that constant's own header), so a child older
// than a small multiple of that bound can no longer be a healthy BOUNDED op; 2x gives a margin
// against the timeout's own detection latency without reviving the "indistinguishable from a
// genuine wedge" problem ykwr4h fixed. NOTE: the coord PUSH paths are still uncapped (plan
// 4136), so a slow but healthy push can still be reported here — acceptable because this path
// only REPORTS (never kills on this floor alone; see the "possibly hung" wording below), so a
// false positive costs a human one look, not a killed process. The KILL ceiling stays exactly
// as it is (null, opt-in with an explicit `--kill-age-ms`) — this floor never gates it.
export const HUNG_COORD_CHILD_REPORT_AGE_MS = 2 * COORD_CHECKOUT_GIT_TIMEOUT_MS;

// ── live hang probe (plan 4087 T3) — read-only unless `kill` is set ────────────────────
// `reportInterruptedOps` above is JOURNAL evidence of a PAST wedge (a `start` with no closing
// line); it says nothing about a `resolveCoordCheckout` that is hung RIGHT NOW — the journal
// only gets a `start` entry, so a live hang leaves no journal signal at all until it eventually
// times out (T1) or is killed. This probe reads live process state instead: does any process's
// command line target the coord checkout directory, right now?
//
// Deliberately emits NOTHING when no such process exists — see the acceptance clause this
// exists to satisfy ("with no hung child present its output must be byte-identical to today"):
// every other step above always pushes a status line, but doing that here would itself change
// heal-main's output on every healthy run. Only a live hang changes the report, and only in the
// direction of surfacing it (never 'clean' — 'blocked' or, with `kill`, 'fixed').
export function probeHungCoordChildren(
  mainDir,
  {
    now,
    listRows,
    exec,
    platform,
    kill = false,
    killAgeMs,
    reportAgeMs = HUNG_COORD_CHILD_REPORT_AGE_MS,
    _killHungChildren = killHungCoordChildren,
  } = {},
) {
  const coordDir = coordCheckoutPath(mainDir);
  let children;
  try {
    children = listCoordChildren(coordDir, { now, listRows, exec, platform });
  } catch (err) {
    // plan 4087 review fix (1lch7tj/cz4610): process enumeration is a raw subprocess call
    // (`powershell.exe`/`ps`) that can itself fail (missing binary, a hardened sandbox, a
    // transient spawn error) — that must degrade the PROBE, not the whole heal-main run. A
    // probe that cannot look reports that it could not look; every other step still runs
    // (runHeal never wraps this call in its own try/catch, so an unguarded throw here would
    // have aborted the rest of the run below it).
    //
    // plan 4087 review round 3 (finding heal-main.mjs:1719, angle-C): `enumerationUnavailable`
    // marks this line as ADVISORY — the probe itself is best-effort by nature (it exists to
    // REPORT a possible hang, not to gate every heal-main run on its own ability to spawn
    // `ps`/`powershell.exe`). reportNeedsOperator (below) reads this flag to keep a probe that
    // cannot look from ever becoming, by itself, the reason a healthy heal-main run exits 1.
    return [
      r(
        'hung-coord-children',
        'blocked',
        `could not enumerate live processes to check for a hung coord-checkout child (${errSummary(err)}) — the probe is blind this run, look manually`,
        { enumerationUnavailable: true },
      ),
    ];
  }
  if (!children.length) return [];
  if (!kill) {
    // plan 4087 review fix (ykwr4h): gate on age — see HUNG_COORD_CHILD_REPORT_AGE_MS above.
    // An unknown age (creation date unparseable) is reported regardless of the floor: we cannot
    // rule out that it is old, and the fail-safe direction for VISIBILITY is the opposite of the
    // fail-safe direction for killing (killHungCoordChildren, below, never kills an unknown age).
    const gateMs = Number.isFinite(killAgeMs) ? killAgeMs : reportAgeMs;
    const hung = children.filter((c) => c.ageMs == null || c.ageMs >= gateMs);
    // plan 4087 review round 2 (finding heal-main.mjs:1193): "possibly" — the report floor is
    // derived from the coord-checkout git timeout, but the coord PUSH paths are still uncapped
    // (plan 4136), so this can legitimately be a slow, healthy push rather than a genuine wedge.
    return hung.map((c) =>
      r(
        'hung-coord-children',
        'blocked',
        `pid ${c.pid} has possibly been hung against the coord checkout for ${formatAge(c.ageMs)}: ${c.commandLine}`,
        { pid: c.pid, ageMs: c.ageMs },
      ),
    );
  }
  // plan 4087 review round 2 (finding heal-main.mjs:250/251, coord-child-probe.mjs): the killer
  // now reports each eligible child's TRUE outcome (see killProcessByPid's own header for the
  // four `reason` values — round 3 dropped the redundant `killed` boolean, finding
  // coord-child-probe.mjs:298) — a failed or refused kill must never render as "fixed". Only
  // children BELOW the kill threshold are absent from `_killHungChildren`'s result at all.
  //
  // plan 4087 review round 3 (finding coord-child-probe.mjs:194, efficiency e9c5aa/5dbc34):
  // `coordDir` is threaded through so the batch kill can re-verify each pid's CURRENT command
  // line, not just its start time (finding coord-child-probe.mjs:258); `platform`/`exec` thread
  // through so the batch's own ONE shared enumeration uses the same seams this probe was called
  // with, never a bare `process.platform`/real-subprocess default in a test.
  const outcomes = new Map(
    _killHungChildren(children, killAgeMs, { platform, exec, coordDir }).map((c) => [c.pid, c]),
  );
  return children.map((c) => {
    const outcome = outcomes.get(c.pid);
    if (!outcome) {
      return r(
        'hung-coord-children',
        'blocked',
        `pid ${c.pid} has possibly been hung against the coord checkout for ${formatAge(c.ageMs)} — below the ${formatAge(killAgeMs)} kill threshold, left alone: ${c.commandLine}`,
        { pid: c.pid, ageMs: c.ageMs },
      );
    }
    if (outcome.reason === 'killed') {
      return r(
        'hung-coord-children',
        'fixed',
        `killed pid ${c.pid} (ran against the coord checkout for ${formatAge(c.ageMs)}): ${c.commandLine}`,
        { pid: c.pid, ageMs: c.ageMs },
      );
    }
    // plan 4087 review round 3 (finding kill-tree.mjs:427/428, surfaced through this report
    // line): 'descendants-survived' is a PARTIAL kill — the target pid itself died, but one or
    // more of its descendants could not be confirmed killed — reported distinctly from a plain
    // kill failure or an identity refusal, never silently collapsed into either.
    const why =
      outcome.reason === 'identity-changed'
        ? `pid ${c.pid} no longer matches the process discovery found (the OS likely reused it) — refused to kill a stranger`
        : outcome.reason === 'descendants-survived'
          ? `pid ${c.pid} itself was killed, but its descendant process(es) could not be confirmed killed (pid(s): ${
              outcome.descendantsFailed?.join(', ') || 'unknown'
            }) — a partial kill, left for a human to check`
          : `attempted to kill pid ${c.pid} but the kill itself failed (already dead, or permission denied)`;
    return r(
      'hung-coord-children',
      'blocked',
      `${why}; it had possibly been hung against the coord checkout for ${formatAge(c.ageMs)}: ${c.commandLine}`,
      { pid: c.pid, ageMs: c.ageMs, killOutcome: outcome.reason },
    );
  });
}

// plan 4087 review round 3 (finding heal-main.mjs:1719, angle-C): whether `report` represents a
// run that needs the operator — the SAME predicate main()'s exit code and its "N step(s) need
// the operator" summary line use. A process-enumeration failure (`enumerationUnavailable`, from
// probeHungCoordChildren's own catch branch above) is itself best-effort — the live hang probe
// now runs on EVERY heal-main invocation unconditionally (T3's own acceptance clause), so its own
// inability to spawn `ps`/`powershell.exe` must never by itself flip a healthy run to "needs the
// operator". The finding it closes: without this, a box missing `ps` (a hardened sandbox, a
// transient spawn error) would fail EVERY heal-main run from then on, for a reason that has
// nothing to do with MAIN's actual git state.
// plan 4087 review round 4 (findings heal-main.mjs:1775 reuse/simplification): the ONE
// definition of "this step needs the operator" — a literal 'blocked' status, excluding a
// best-effort probe that could not even look (`enumerationUnavailable`, see probeHungCoordChildren's
// own catch branch above). reportNeedsOperator and main()'s "N step(s) need the operator" summary
// line both derive from this instead of each re-deriving their own copy of the same filter, which
// had already drifted apart in wording (and risked drifting in substance) across review rounds.
export function blockingSteps(report) {
  return report.filter((x) => x.status === 'blocked' && !x.enumerationUnavailable);
}

export function reportNeedsOperator(report) {
  return blockingSteps(report).length > 0;
}

// ── 6. orphaned dirt → the sanctioned committer/stasher ────────────────────────────────
// `exec` is a testability seam only (mirrors healTruncatedIndex's own `exec` option above,
// threaded through to guard()'s own `exec` param) — no production caller passes it; it exists
// so a test can inject an index-sanity probe failure and pin the 'index-state-unknown' arms
// below without needing to reproduce a real git-level corruption on disk.
export function healDirt(mainDir, { dry = false, log = () => {}, exec = execFileSync } = {}) {
  try {
    if (dry) {
      const res = guard(mainDir, { slug: 'heal-main', check: true, log, exec });
      if (!res.dirty) return [r('dirt', 'clean', 'MAIN working tree clean')];
      // Plan 1634: name any corrupted file up front — a real (non-dry) run EXCLUDES it
      // from whatever it does, so a --dry preview must not promise it will be resolved.
      // Plan 3206 re-review: the --check path guard() runs here cannot compute the
      // normalizes-clean outcome (it reports raw `git status` dirt), so this preview must
      // not promise a commit/stash the real run may not perform — dirt whose only change is
      // line-endings is renormalized in place and parked NOWHERE, and with a corrupted file
      // also present the real run reports 'blocked' rather than resolving anything.
      if (res.corrupted?.length)
        return [
          r(
            'dirt',
            'would-fix',
            `MAIN has uncommitted work → pre-yield-guard --commit-safe would commit/stash whatever survives line-ending normalization (dirt that normalizes away is renormalized in place, not parked), but would EXCLUDE corrupted file(s) needing a human/heal: ${res.corrupted.join(
              ', ',
            )} — a real run reports blocked while those remain`,
          ),
        ];
      if (res.skipped === 'job-output-only')
        return [
          r(
            'dirt',
            'clean',
            'MAIN dirt is live job-owned pipeline output that a real run leaves in place',
          ),
        ];
      // plan 3968 review round 3 (72c7a2/3eaf8f/709c19): guard()'s unconditional index-sanity
      // check (see its own header) runs in `--check` mode too, so a probe failure can surface
      // here exactly as it does on the real path below. Report the same refusal a real run
      // would give — NEVER the generic "would commit/stash" text below, which promises an
      // action pre-yield-guard will not actually take once the index state cannot be verified.
      if (res.skipped === 'index-state-unknown')
        return [
          r(
            'dirt',
            'blocked',
            `index state could not be verified (${res.indexSanity?.why || 'see pre-yield-guard log'}) — a real run would REFUSE to commit/stash anything until \`node scripts/heal-main.mjs\` can verify the index; re-run once resolved`,
          ),
        ];
      return [
        r(
          'dirt',
          'would-fix',
          'MAIN has uncommitted work → pre-yield-guard --commit-safe would commit pure-doc dirt / park the rest in a named stash (dirt that normalizes away is renormalized in place, not parked)',
        ),
      ];
    }
    const res = guard(mainDir, {
      slug: 'heal-main',
      commitSafe: true,
      ageThresholdMs: 90_000,
      log,
      exec,
    });
    if (!res.dirty) return [r('dirt', 'clean', 'MAIN working tree clean')];
    if (res.skipped === 'too-fresh')
      return [r('dirt', 'clean', 'dirt younger than 90s — likely a live edit, left alone')];
    // Plan 3968: guard() itself refused to park a TRUNCATED index (its `why` names the
    // predicate's evidence) — step 0 above (healTruncatedIndex) already tried and only
    // reaches this arm when it was spared for a live index.lock. Report blocked (this
    // MAIN state is not actually healed) rather than the uninformative generic
    // mode=none fallback below.
    if (res.skipped === 'truncated-index')
      return [
        r(
          'dirt',
          'blocked',
          `index still looks truncated (${res.indexSanity?.why || 'see pre-yield-guard log'}) — re-run heal-main once the index.lock clears`,
        ),
      ];
    // plan 3968 review round 3 (72c7a2/3eaf8f/709c19/ceb952): the sibling verdict to
    // 'truncated-index' above — guard() cannot tell whether the index is fine or torn (a
    // probe itself failed), so it refuses to park anything. Without this arm the result fell
    // through to the generic `pre-yield-guard mode=none` catch-all at the bottom of this
    // function, which loses `res.indexSanity.why` and the re-run guidance the 'truncated-index'
    // arm's own comment says exists to avoid.
    if (res.skipped === 'index-state-unknown')
      return [
        r(
          'dirt',
          'blocked',
          `index state could not be verified (${res.indexSanity?.why || 'see pre-yield-guard log'}) — re-run heal-main once the index can be read`,
        ),
      ];
    // Plan 1634: a corrupted file excluded from the commit/stash is NOT fully healed —
    // report 'blocked' (never 'fixed') and name it, so a structured --json/journal reader
    // never sees a clean-MAIN report while a zero-filled file is still sitting dirty.
    const corruptedSuffix = res.corrupted?.length
      ? `, but EXCLUDED corrupted file(s) needing a human/heal: ${res.corrupted.join(', ')}`
      : '';
    // Plan 3498: the guard deliberately leaves live job-owned pipeline output in place.
    // Matched on `skipped` before the mode switch, like normalizes-clean below; without this
    // arm its protected:false sentinel falls through to blocked mode=none.
    //
    // No `corruptedSuffix` here, unlike every sibling arm, and deliberately so: the guard
    // returns this sentinel from an EARLY return taken when nothing parkable is left, which
    // is upstream of every `partitionCorruptPaths` call (they run over the PARKABLE set,
    // inside the --check block or inside guardMutate). So `res.corrupted` is structurally
    // always undefined on this path — a `res.corrupted?.length ? 'blocked' : …` ternary here
    // would be dead code asserting a plan-1634 guarantee this arm cannot actually make.
    // Job output is not corruption-scanned at all, which is the right call rather than a
    // gap to close here: these files are being written by a LIVE process, so scanning one
    // mid-write would read a partial file and report false corruption. Their integrity is
    // the pipeline's own to check (`_load_from_dir` requires a complete `_meta.json`), not
    // this guard's. See docs/handoff/infra-debt.md for the reporting gap that leaves.
    if (res.skipped === 'job-output-only')
      return [r('dirt', 'clean', 'live job-owned pipeline output deliberately never parked')];
    // Plan 3206: the guard resolved line-ending-only dirt WITHOUT parking anything — it
    // renormalized the file(s) on disk instead, so nothing needed a stash. Matched on
    // `skipped` (which this arm reaches before the `res.mode` switch below); without the arm
    // the return lands on that switch's catch-all and heal-main exits 1 'blocked' for a
    // condition it just fixed. This sits AFTER corruptedSuffix on purpose and obeys the
    // plan-1634 rule directly above it: a corrupted file can be dirty ALONGSIDE the
    // line-ending-only one (the guard's corrupted-only early return fires only when EVERY
    // still-dirty path is corrupted), and that file is still sitting there untouched — so
    // 'fixed' is only honest when nothing was excluded (re-review finding, plan 3206).
    if (res.skipped === 'normalizes-clean')
      return [
        r(
          'dirt',
          res.corrupted?.length ? 'blocked' : 'fixed',
          `line-ending-only dirt renormalized on disk — nothing needed parking${corruptedSuffix}`,
        ),
      ];
    if (res.mode === 'commit-safe')
      return [
        r(
          'dirt',
          res.corrupted?.length ? 'blocked' : 'fixed',
          `committed + pushed idle doc dirt (${res.paths.join(', ')})${corruptedSuffix}`,
        ),
      ];
    if (res.mode === 'stash')
      return [
        r(
          'dirt',
          res.corrupted?.length ? 'blocked' : 'fixed',
          `parked dirt in named stash "${res.label}" (recover: git stash pop / sweep-stray-stashes)${corruptedSuffix}`,
        ),
      ];
    if (res.mode === 'corrupted-only')
      return [
        r(
          'dirt',
          'blocked',
          `corrupted file(s) left as-is, needs a human/heal: ${res.corrupted.join(', ')}`,
        ),
      ];
    if (res.mode === 'commit-unpushed')
      return [
        r(
          'dirt',
          'blocked',
          'doc dirt committed locally but the push failed — re-run heal-main (master-sync will push it)',
        ),
      ];
    // Plan 3206 re-review: the catch-all honours the plan-1634 invariant like every sibling
    // arm above — an excluded corrupted file is never a 'fixed' report, whatever mode got us
    // here. Unreachable from this call site today (healDirt always passes commitSafe and
    // never `commit`, so mode:'commit' cannot arrive), but the arms it backstops all encode
    // the rule and a future caller threading --commit through must not silently lose it.
    return [
      r(
        'dirt',
        res.protected && !res.corrupted?.length ? 'fixed' : 'blocked',
        `pre-yield-guard mode=${res.mode || 'none'}${corruptedSuffix}`,
      ),
    ];
  } catch (e) {
    return [r('dirt', 'blocked', `pre-yield-guard failed: ${errText(e).split('\n')[0]}`)];
  }
}

// ── 7. stash / claim residue → the existing single-purpose sweeps (delegated, never
//       reimplemented). Both are safe-by-design (subsumed-only drops, surfacing over
//       deleting), run as subprocesses in their own right; --dry maps to their --dry-run.
// The last couple of meaningful lines of a sweep report — its verdict. Shared by the clean and
// the surfaced path so both print the same shape, and blank-line tolerant: a sweep report opens
// with a BLANK line, which is what made the old first-line formatting print nothing at all.
function sweepTail(text) {
  return (
    String(text || '')
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-2)
      .join(' | ') || '(no output)'
  );
}

export function delegateSweeps(mainDir, { dry = false } = {}) {
  const out = [];
  for (const tool of ['sweep-stray-stashes.mjs', 'sweep-acquire-residue.mjs']) {
    const script = join(mainDir, 'scripts', tool);
    if (!existsSync(script)) continue; // sibling without the tool — skip silently
    try {
      const res = execFileSync('node', [script, ...(dry ? ['--dry-run'] : [])], {
        cwd: mainDir,
        encoding: 'utf8',
        timeout: 120_000,
      });
      out.push(r('sweeps', 'clean', `${tool}: ${sweepTail(res)}`));
    } catch (e) {
      // Both sweeps exit SWEEP_SURFACED_EXIT when they SURFACE residue rather than drop it.
      // That is evidence, not a heal failure: step 7 is report-only by design (see the header),
      // so blocking on it would make heal-main exit 1 "needs the operator" for as long as any
      // un-landed stash or modified plan file exists — which is precisely what it did.
      if (e?.status === SWEEP_SURFACED_EXIT) {
        out.push(
          r(
            'sweeps',
            'clean',
            `${tool} surfaced residue: ${sweepTail(e?.stdout)} — run it directly to inspect/apply`,
          ),
        );
      } else {
        // errSummary, not the bare first line of errText: these tools report on STDOUT and their
        // report OPENS WITH A BLANK LINE, so the first-line form printed an empty reason
        // ("BLOCKED [sweeps] sweep-stray-stashes.mjs failed:" and nothing after the colon).
        out.push(
          r(
            'sweeps',
            'blocked',
            `${tool} failed: ${errSummary(e) || '(no output on any channel)'}`,
          ),
        );
      }
    }
  }
  if (!out.length) out.push(r('sweeps', 'clean', 'no sweep tools present'));
  return out;
}

// ── the composed run ─────────────────────────────────────────────────────────────────────
export function runHeal(
  mainDir,
  {
    dry = false,
    log = console.error,
    // plan 4087 T3 test seams (production caller: `main()` below, which sets `check`/`kill`/
    // `killAgeMs` from the CLI flags — the rest are never set by a production caller). `hungProbe`
    // mirrors the options probeHungCoordChildren itself takes (now/listRows/exec/platform/kill/
    // killAgeMs/reportAgeMs/_killHungChildren) plus its own `check` gate, so a test can inject a
    // fake process reader without touching process.platform or spawning powershell/ps for real.
    hungProbe = {},
  } = {},
) {
  const report = [];
  // The index-preflight verdict that stopped the run, if one did (plan 4026 round 4).
  let indexPreflightUnverified = null;
  // plan 4087 review fix (1jcp4d9/17bmr57): the live-hang probe runs FIRST, before `core()`
  // below ever tries to acquire the coord-write lock. That lock is the SAME one a hung
  // coord-checkout recreation can be holding — so probing only after `core()` finishes (or
  // hangs waiting on it) is too late to help: by the time `core()` returns, either the hang is
  // already gone, or heal-main itself is now the thing stuck waiting with nothing surfaced to
  // the operator in the meantime.
  if (hungProbe.check) {
    const hungFindings = probeHungCoordChildren(mainDir, {
      ...hungProbe,
      kill: hungProbe.kill && !dry,
    });
    report.push(...hungFindings);
    // plan 4087 review round 2 (finding heal-main.mjs:1522): running the probe first is not
    // enough by itself — its finding was still only PRINTED with the final report, so if
    // `core()` below blocks on the very lock the hang is holding, the operator never sees why
    // heal-main itself is now stuck. Surface it HERE, immediately, via `log` (stderr, same
    // channel every other step's diagnostics already use) — in ADDITION to (never instead of)
    // its place in the final report, which still carries it for --json/journal consumers. A
    // healthy run (hungFindings empty) logs nothing here, preserving the byte-identical
    // no-hung-child contract for the final report.
    for (const f of hungFindings) {
      log(`[heal-main] ${f.status === 'fixed' ? 'fixed' : 'BLOCKED'} [${f.step}] ${f.detail}`);
    }
  }
  // Steps 1–4 mutate MAIN's git state → single-actor under the coord-write lock. A dry run
  // is read-only and skips the lock (safe to run while anything else is in flight).
  const core = () => {
    const step0 = healTruncatedIndex(mainDir, { dry });
    report.push(...step0);
    // plan 4026: right after the TRUNCATED-index check and before everything that reads
    // `git status` — a stale index makes that read lie in the same way a torn one does (staged
    // renames/deletions that exist in neither HEAD nor the working tree), and healMasterSync
    // further down would otherwise report a wedged ff with no idea why.
    const step0b = healStaleIndex(mainDir, { dry });
    report.push(...step0b);
    const staleLocksResult = healStaleLocks(mainDir, { dry });
    report.push(...staleLocksResult);
    // plan 3968 review (15a097, tightened round 2 per finding f420dd): step 0 spares a
    // truncated index whenever an index.lock is present — correctly, since a LIVE lock must
    // never be touched — but if that lock was STALE, healStaleLocks (just above) removed it,
    // and the index is still torn with nothing left in this run to fix it. Give step 0 one
    // more try, but ONLY when BOTH structured signals actually hold: step 0 itself reported
    // `sparedForLock` (never a `detail`-string match — a human-readable message is not a
    // decision another step should key off of) AND healStaleLocks reports it genuinely
    // REMOVED the main lock (`removedMainLock`), not merely that it ran. A lock that turned
    // out to be genuinely LIVE never sets `removedMainLock`, so this retry does not fire for
    // it — no need for the old "runs again as a safe no-op" fallback once the condition is
    // this precise.
    if (step0.some((x) => x.sparedForLock) && staleLocksResult.some((x) => x.removedMainLock)) {
      report.push(...healTruncatedIndex(mainDir, { dry }));
    }
    // plan 4026 (review findings e23cfb/a79349/f6c809): the stale-index step spares on the same
    // lock for the same reason, so it needs the same second try — otherwise a stale lock plus a
    // stale index leaves the index torn with nothing left in this run to fix it, and the
    // master-sync step below reports a wedged fast-forward with no idea why. Same two structured
    // signals, never a `detail`-string match.
    if (step0b.some((x) => x.sparedForLock) && staleLocksResult.some((x) => x.removedMainLock)) {
      report.push(...healStaleIndex(mainDir, { dry }));
    }
    // plan 4026 (round 3 finding at :286, generalised in round 4 per three angles at
    // :1398/:1421/:1431): an index preflight that did NOT verify the index must stop the run.
    // Every step below reasons from `git status`, which an unverified index makes lie —
    // healMasterSync would attempt a fast-forward against it and healDirt would park hundreds of
    // phantom modifications as if they were the operator's work.
    //
    // "Did not verify" is two shapes, and BOTH index steps carry both: `blocked` (a probe error,
    // an unmergeable index, an over-cap set, a failed rebuild), and a still-standing
    // `sparedForLock` — a spare the retry above did not clear, because healStaleLocks found the
    // lock genuinely LIVE. The retries have already run at this point, so the last verdict each
    // step produced is the one read here.
    const lastVerdict = (step) => report.filter((x) => x.step === step).at(-1);
    indexPreflightUnverified = ['truncated-index', 'stale-index']
      .map(lastVerdict)
      .filter(Boolean)
      .find((v) => v.status === 'blocked' || v.sparedForLock);
    if (indexPreflightUnverified) return;
    report.push(...healRebaseResidue(mainDir, { dry }));
    report.push(...healDetachedHead(mainDir, { dry }));
    report.push(...healMasterSync(mainDir, { dry }));
  };
  if (dry) core();
  else withCoordLock(mainDir, core, { tool: 'heal-main' });
  report.push(...reportInterruptedOps(mainDir));
  if (indexPreflightUnverified) {
    report.push(
      r(
        'index-preflight-halt',
        'blocked',
        `stopped after ${indexPreflightUnverified.step}: the index could not be verified (${indexPreflightUnverified.detail}), so \`git status\` cannot be trusted — the remaining steps (rebase residue, detached HEAD, master sync, dirt park, sweeps) were NOT run`,
      ),
    );
    return report;
  }
  // Step 6 self-locks inside pre-yield-guard (guardMutate runs under withCoordLock) — it must
  // run OUTSIDE our lock or it would deadlock waiting on itself.
  report.push(...healDirt(mainDir, { dry, log }));
  report.push(...delegateSweeps(mainDir, { dry }));
  const fixed = report.filter((x) => x.status === 'fixed');
  if (fixed.length && !dry)
    journalCoordOp(mainDir, {
      tool: 'heal-main',
      phase: 'healed',
      steps: fixed.map((f) => f.detail),
    });
  return report;
}

// plan 4087 T3 CLI usage line — shared by parseHealMainArgs' own error and its unknown-argument
// error, so the two never drift apart.
//
// plan 4087 review round 2 (finding heal-main.mjs:1521 — default heal-main no longer probes for
// hung coord children): `--check-hung-coord-children` is GONE. The report-only probe now runs
// on every heal-main invocation unconditionally (see main() below) — that was the whole T3
// acceptance clause ("heal-main REPORTS a hung child by pid and age by default; only the KILL is
// opt-in"), which round 1 accidentally regressed by gating the report behind this flag. With the
// report unconditional, a separate "turn the report on" flag has nothing left to mean.
const HEAL_MAIN_USAGE =
  'usage: node scripts/heal-main.mjs [--dry] [--json] [--kill-hung-coord-children [--kill-age-ms=<n>]]';

// plan 4087 review fix (11fec5/5n7bqo/h3eh4e): argv parsing + validation pulled out of main()
// into a pure function — testable directly with an array literal instead of mocking
// process.argv/console.error/process.exit. Returns `{ error }` (a ready-to-print CLI message,
// caller returns exit code 2) on any invalid combination, else the resolved options. Every
// validation this function performs happens ONCE, here, at the CLI boundary — nothing downstream
// (runHeal, probeHungCoordChildren, killHungCoordChildren) re-derives or re-checks these same
// argv-shaped rules.
export function parseHealMainArgs(argv) {
  const dry = argv.includes('--dry');
  const json = argv.includes('--json');
  // plan 4087 T3: opt-in, never default — see coord-child-probe.mjs's HUNG_COORD_CHILD_KILL_AGE_MS
  // header for why the age ceiling has no baked-in number yet.
  const killHung = argv.includes('--kill-hung-coord-children');
  const killAgeArg = argv.find((a) => a.startsWith('--kill-age-ms='));
  const killAgeMs = killAgeArg
    ? Number(killAgeArg.slice('--kill-age-ms='.length))
    : HUNG_COORD_CHILD_KILL_AGE_MS;
  const known = new Set(['--dry', '--json', '--kill-hung-coord-children']);
  const unknown = argv.find((a) => !known.has(a) && !a.startsWith('--kill-age-ms='));
  if (unknown) {
    return { error: `heal-main: unknown argument "${unknown}" — ${HEAL_MAIN_USAGE}` };
  }
  // plan 4087 review fix (11fec5): --kill-age-ms on its own reads as "I asked for a kill
  // threshold" while nothing will ever kill — refuse it outright rather than silently ignore it.
  if (killAgeArg && !killHung) {
    return {
      error:
        'heal-main: --kill-age-ms is inert without --kill-hung-coord-children — pass both, or neither',
    };
  }
  if (killHung && (killAgeMs == null || !Number.isFinite(killAgeMs))) {
    return {
      error:
        'heal-main: --kill-hung-coord-children needs --kill-age-ms=<n> (plan 4087 T1 has not ' +
        'landed a measured default yet, so no ceiling is assumed)',
    };
  }
  // plan 4087 review fix (5n7bqo/h3eh4e): a negative ceiling means "every process is older than
  // the threshold" — i.e. kill everything — never a valid ceiling. Checked after the two guards
  // above so a negative value with no --kill-hung-coord-children still gets the clearer "inert"
  // message instead of this one.
  if (killHung && killAgeMs < 0) {
    return { error: `heal-main: --kill-age-ms must be a non-negative number, got ${killAgeMs}` };
  }
  return { dry, json, killHung, killAgeMs };
}

export function main() {
  const parsed = parseHealMainArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    return 2;
  }
  const { dry, json, killHung, killAgeMs } = parsed;
  // assertMaster:false — heal-main must resolve MAIN precisely when it is detached.
  const mainDir = resolveMain({ assertMaster: false });
  // plan 4087 review round 2 (finding heal-main.mjs:1521): `check: true` UNCONDITIONALLY — the
  // report-only probe is not opt-in any more (see HEAL_MAIN_USAGE's header above). Only the
  // KILL stays behind its own flag.
  const report = runHeal(mainDir, {
    dry,
    hungProbe: { check: true, kill: killHung, killAgeMs },
  });
  if (json) {
    console.log(JSON.stringify({ dry, report }, null, 2));
  } else {
    for (const x of report) {
      const icon =
        x.status === 'fixed'
          ? '✔ fixed  '
          : x.status === 'would-fix'
            ? '→ would  '
            : x.status === 'blocked'
              ? // plan 4087 review round 4 (finding heal-main.mjs:1312): a best-effort enumeration
                // failure (`enumerationUnavailable` — the probe itself could not spawn
                // `ps`/`powershell.exe`) is not the operator-facing "this needs you" signal the
                // BLOCKED icon means everywhere else in this file; it stays visible as an
                // advisory line instead, matching blockingSteps' exclusion below.
                x.enumerationUnavailable
                ? '⚠ advisory'
                : '✖ BLOCKED'
              : '· clean  ';
      console.log(`${icon} [${x.step}] ${x.detail}`);
    }
    // plan 4087 review round 4 (finding heal-main.mjs:1775): shares the exact same predicate as
    // reportNeedsOperator (blockingSteps) instead of re-deriving its own copy of the filter.
    const blocked = blockingSteps(report);
    if (blocked.length) {
      console.log(`\nheal-main: ${blocked.length} step(s) need the operator (see ✖ lines above).`);
    } else if (report.some((x) => x.status === 'fixed')) {
      console.log('\nheal-main: repaired — re-run to verify it reports all-clean.');
    } else if (dry) {
      console.log('\nheal-main: dry run — nothing was changed.');
    } else {
      console.log('\nheal-main: all clean.');
    }
  }
  return reportNeedsOperator(report) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error('heal-main:', e.message);
    process.exit(2);
  }
}
