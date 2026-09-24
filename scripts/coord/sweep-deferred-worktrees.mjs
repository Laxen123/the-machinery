#!/usr/bin/env node
// scripts/sweep-deferred-worktrees.mjs (plan 2218)
// Idle-sweep companion to done-worktree's teardown: when a worktree dir survives the
// git-level removal plus ONE forced pass (the locked-tree profile — a long-path
// node_modules handle pinning the tree), teardown no longer retry-storms it. Plan 2198
// correlated every 2026-07-21 main-checkout `.pnpm`/`.bin` store tear with exactly those
// retry-storm windows (minutes of forced recursive deletes over a junction-dense,
// hard-link-dense tree whose file inodes are shared with the main checkout, on a machine
// with a documented Wof.sys filter-driver race under parallel enumeration). Teardown now
// records the leftover dir here and moves on; the NEXT `done-worktree` / `cut-worktree`
// invocation — a natural idle-ish moment, by which time the locker (the dying session's
// handles) is normally gone — retries removal with ONE attempt per dir, no storm.
//
// Marker: `<main>/.scratch/deferred-worktree-removals.jsonl`, one JSON object per line
// ({ts, dir, slug, branch, reason, attempts, lastAttemptAt?}), written via the shared
// appendJsonl journal writer (coord-metrics.mjs, plan 2198 — do NOT pass maxBytes here:
// rotation would strand live marker state in a `.1` file this reader never consults).
// Append-only from teardown; the sweep rewrites it atomically, MERGING against a fresh
// on-disk read at rewrite time so a concurrent teardown's append recorded mid-sweep is
// preserved, not clobbered. The residual race is the microseconds between that re-read
// and the rename; a marker entry lost there leaves an orphaned dir, which the read-only
// `scripts/coord/reconcile-worktree-branches.mjs` audit still surfaces as a worktree-dir husk
// — the backstop, not this file, owns the no-lost-dir guarantee.
//
// A deferred dir is usually STILL REGISTERED in `git worktree list`: the failed
// `git worktree remove` keeps the admin entry, and `git worktree prune` only clears
// entries whose dir is GONE. So "registered" alone cannot mean "live". The sweep
// discriminates by AGE: a dir whose creation time is NEWER than its marker entry was
// re-created after the deferral (a legitimate live worktree — a nonempty leftover dir
// can never be re-adopted by `git worktree add`, so re-creation implies it was removed
// first) and is dropped as moot; an OLDER registered dir is the deferred husk itself and
// is removed through the git primitive (`git worktree remove --force --force`, ONE
// attempt — the same escalation teardown 3a uses), which clears dir + registration
// together. Unknown age (no birthtime) on a registered dir → skip, keep the entry.
//
// Safety invariants (each is load-bearing — do not relax):
//   - CONTAINMENT: only dirs under `<main>/.claude/worktrees/` are ever removed. An
//     entry outside that root is refused and dropped loudly (corrupt marker), the dir
//     untouched.
//   - RECREATED = LIVE: a registered dir newer than its marker entry is a live worktree
//     — never removed; the stale deferral is dropped as moot.
//   - UNKNOWN = SKIP: if the porcelain listing fails, NOTHING is removed this
//     invocation; if a registered dir's age can't be read, that entry is kept untouched.
//     No removal without knowing what's live.
//   - ONE attempt per entry per invocation. The attempts counter + lastAttemptAt are
//     kept for the plan-2218 trip-condition forensics (correlate against
//     `.scratch/install-main-heals.jsonl` on the next main-checkout tear).
//
// Plan 3092 — prunable-husk completion: everything above is MARKER-driven (it only
// acts on `.scratch/deferred-worktree-removals.jsonl`, written by teardown step 3d).
// When teardown's own invoking shell is killed earlier, at step 1 (the false-255 bug
// plan 3092 fixes in `buildProcessKillCommand`), step 3d is never reached — the
// half-removed worktree dir is invisible to the marker and survives as a `prunable`
// `git worktree list` registration the marker-driven pass alone can never see. This
// module now ALSO scans `git worktree list --porcelain` directly (via
// `parseWorktreePorcelain`, reusing its own `prunable`/`prunableReason` fields) on every
// invocation, marker present or not, and reports it in a separate `prunable` bucket.
//
// The scan is REPORT-ONLY. It removes NEITHER half of a husk — not the leftover
// directory and not the dead `.git/worktrees/<name>` registration — because the whole
// scan rests on ONE flag that is not a liveness verdict:
//   - `prunable` means only "git cannot follow this worktree's `.git` link RIGHT NOW".
//     A LIVE worktree whose link is momentarily missing or unreadable looks identical:
//     one MID-`git worktree add` (git writes the admin entry before the working tree's
//     own `.git` file), one mid-teardown, one on a slow/racing mount. This module does
//     not, and from a single porcelain snapshot cannot, tell those from a real husk.
//   - the blast radius is every OTHER session's worktrees, not just this one's. The
//     scan runs on every `done-worktree`/`cut-worktree` invocation over the SHARED
//     `.git` this repo's CLAUDE.md documents as carrying ~5-7 parallel sessions, and
//     `git worktree prune` has no per-path form — it is global by construction. So
//     deleting the DIRECTORY would destroy a sibling's unlanded work, and pruning the
//     REGISTRATION would break a sibling's in-flight `worktree add` / strand its branch
//     association (round-1 `/sonnet-review high` @ 3d39c5a7 CONFIRMED the first;
//     round-2 `/gpt-review` @ 4a405ba9 CONFIRMED the second, which an earlier draft of
//     this module did do automatically).
// Reporting it is the whole contribution, and it is the part that was actually missing:
// before plan 3092 a killed-mid-teardown husk was invisible on EVERY surface, this
// module's included. `scripts/coord/reconcile-worktree-branches.mjs` is NOT a backstop for it
// — its `classifyHusks` fires only on `!hasGitPointer && !hasAdminEntry`, and the whole
// point of this shape is that the admin entry SURVIVES — so the report below is the only
// place it surfaces. Every entry is therefore named by path, dir-already-gone ones
// included: those are exactly the ones a human must `git worktree prune` by hand.
//
// This matches what the rest of the module already does: nothing here deletes on a flag
// alone — the marker-driven pass above only removes dirs a teardown explicitly recorded,
// and even then re-checks age (RECREATED = LIVE). ONE pre-plan-3092 exception survives
// and is deliberately left alone: after that marker-driven pass successfully removes a
// REGISTERED husk it recorded, it runs a global `git worktree prune` (see `sweptRegistered`
// below). It carries a smaller version of the same cross-session hazard, but it is
// conditional on this session having just removed its own recorded worktree rather than
// firing on every invocation, it predates this plan, and narrowing it is a separate change
// — tracked in `docs/handoff/infra-debt.md` (2026-08-11).
//
// Plan 3238 — the branch-delete retry: `done-worktree.mjs`'s teardown step
// `branch-delete-local` is one-shot. When the preceding `worktree-remove` defers on a
// locked tree (the exact shape this module exists to retry), the registration survives
// `git worktree prune`, so `git branch -d/-D` refuses with "branch is checked out at
// <path>" and NOTHING revisits it afterward — the local `worktree-<slug>` branch is
// stranded indefinitely. So the instant a marker entry's DIR problem finally resolves
// this invocation (it is about to land in `result.swept`, from either the registered-husk
// `gitRemove` path or the unregistered `remove` path above), this module also retries the
// branch delete that teardown left undone, using the `branch` field the marker already
// carries (`recordDeferredRemoval`). Three safety rules, each closing a distinct failure
// mode of a naive delete:
//   - act only when `branch` is non-empty AND still exists locally — most entries never
//     had a stranded branch, or something else already cleaned it up.
//   - never touch a branch checked out in ANY OTHER REGISTERED worktree — checked against
//     the same porcelain read the dir-liveness check above already performed (its entries
//     carry a `branch` field, see `worktree-porcelain.mjs`). Git would refuse anyway, but
//     the check keeps this module from reaching for a SIBLING session's live tree, the
//     module's standing cross-session posture. "OTHER" is load-bearing: that porcelain read
//     predates the loop, so the husk this invocation just removed is still listed in it —
//     counting the entry's own stale row would self-block every registered-husk resolution,
//     which is the very case this retry exists for.
//   - `git branch -D` only after proving the branch tip is an ancestor of the LOCAL
//     `origin/master` ref (`git merge-base --is-ancestor <branch> origin/master`, the same
//     primitive `reconcile-worktree-branches.mjs` uses via `coord-git.mjs`'s
//     `isAncestorRef` — reimplemented locally here rather than imported, per this module's
//     own no-coord-git-import posture below). NO network call: a stale local
//     `origin/master` at worst REFUSES the delete — the safe direction, leaving the branch
//     for a later sweep or the `reconcile-worktree-branches.mjs` audit.
// A refused or failed delete is SOFT — the entry still drops out of the marker (the DIR
// problem it stood for IS resolved; the branch alone is never a reason to re-defer it) and
// the outcome is only ever surfaced for reporting, in the `branches` bucket of the return
// value and in both the spine's stderr summary and the standalone CLI output, so a
// left-behind branch is named rather than silently forgotten a second time.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteTextSync } from './atomic-write.mjs';
import { appendJsonl } from './coord-metrics.mjs';
import { disarmJunction } from './junction-guard.mjs';
import { pwshExe, pwshCandidates } from './pwsh-exec.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';
import { parseWorktreePorcelain } from './worktree-porcelain.mjs';

export const MARKER_BASENAME = 'deferred-worktree-removals.jsonl';

export function markerPath(mainDir) {
  return join(mainDir, '.scratch', MARKER_BASENAME);
}

// Windows paths are case-insensitive; porcelain emits forward slashes while teardown's
// forced-removal form uses backslashes — compare one canonical form.
const IS_WIN = process.platform === 'win32';
function canon(p) {
  const r = resolve(String(p)).replace(/\\/g, '/');
  return IS_WIN ? r.toLowerCase() : r;
}

export function recordDeferredRemoval(mainDir, { dir, slug = null, branch = null, reason }) {
  if (!dir) throw new Error('sweep-deferred-worktrees: recordDeferredRemoval requires a dir');
  // ts is stamped HERE (not left to appendJsonl's default) so the caller and the
  // written line agree on the deferral time the sweep's age discrimination reads.
  const entry = {
    ts: new Date().toISOString(),
    dir: resolve(String(dir)),
    slug,
    branch,
    reason: reason || 'locked-tree teardown defer (plan 2218)',
    attempts: 0,
  };
  // appendJsonl swallows failures (telemetry contract); the marker is load-bearing state,
  // so surface a failed write to the caller — teardown then says "remove by hand".
  if (!appendJsonl(markerPath(mainDir), entry)) {
    throw new Error(`sweep-deferred-worktrees: marker append failed (${markerPath(mainDir)})`);
  }
  return entry;
}

// Corrupt lines (a torn append) are silently dropped at the next rewrite — the marker is
// hygiene state whose true backstop is reconcile-worktree-branches' husk audit.
export function readDeferredEntries(mainDir) {
  const path = markerPath(mainDir);
  if (!existsSync(path)) return [];
  const byDir = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    if (!e || typeof e.dir !== 'string' || !e.dir) continue;
    const key = canon(e.dir);
    const prev = byDir.get(key);
    if (prev) {
      // dedupe by dir: keep the earliest deferral timestamp, the largest attempt count
      prev.attempts = Math.max(prev.attempts || 0, e.attempts || 0);
      prev.lastAttemptAt = e.lastAttemptAt || prev.lastAttemptAt;
    } else {
      byDir.set(key, { attempts: 0, ...e });
    }
  }
  return [...byDir.values()];
}

// Resolution lives in the shared scripts/coord/pwsh-exec.mjs seam (plan 2405).
const soft = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
  } catch {
    /* best-effort — the existsSync recheck decides the real outcome */
  }
};

// ONE forced pass for an UNREGISTERED dir, mirroring done-worktree teardown 3b (same
// long-path/`\\?\` + reparse-point rationale — see the comments there; kept separate
// from 3b because that copy must route through teardown's DRY-tracing run()). No loop,
// by design.
export function defaultRemove(dir) {
  // plan 2697: disarm a node_modules junction FIRST. Today this sweep is only ever fed PLAN
  // worktree dirs (recordDeferredRemoval's single call site), and those always get a real
  // `pnpm install`, never a junction — so this is defence in depth, not a live bug. But both
  // deleters below TRAVERSE a junction on Windows (`Remove-Item -Recurse` on PS 5.1, and
  // `git worktree remove --force` in defaultGitRemove), which is exactly how plan 2401's store
  // tear destroyed MAIN's real node_modules. A second unguarded traversal path is precisely the
  // shape that let that bug survive its own fix, so it does not get to sit here unarmed.
  if (disarmJunction(dir) === 'failed') {
    // A junction is present and still armed — every deleter here would traverse it. Leave the
    // dir for the next sweep (the marker entry is kept when the dir survives).
    return;
  }
  if (IS_WIN) {
    const win = resolve(dir).replace(/\//g, '\\');
    // Candidate ORDER supplied by this caller, not imported by the resolver (plan 4061 T3).
    soft(pwshExe({ candidates: pwshCandidates(process.platform) }), [
      '-NoProfile',
      '-Command',
      `Remove-Item -LiteralPath '\\\\?\\${win}' -Recurse -Force -ErrorAction SilentlyContinue`,
    ]);
    if (existsSync(dir)) soft('cmd', ['/c', 'rmdir', '/s', '/q', win]);
  } else {
    soft('rm', ['-rf', resolve(dir)]);
  }
}

// The git primitive for a REGISTERED husk — clears dir + admin entry together. ONE
// attempt; a locked tree just fails softly and the entry is kept for the next sweep.
function defaultGitRemove(mainDir, dir) {
  // plan 2697: `git worktree remove --force` is THE traversing deleter of plan 2401's incident —
  // git-for-windows reads a junction as a plain directory and deletes through it. Same defence
  // in depth as defaultRemove above; a still-armed junction means we do not run it at all.
  if (disarmJunction(dir) === 'failed') return;
  soft('git', ['-C', mainDir, 'worktree', 'remove', '--force', '--force', resolve(dir)]);
}

// The one full parse of `git worktree list --porcelain` — carries `prunable` /
// `prunableReason` alongside `path`, so both the marker-driven registered check and
// the plan-3092 prunable-husk scan read the same live git judgment.
function listPorcelainEntries(mainDir) {
  const out = execFileSync('git', ['-C', mainDir, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: gitRepoIsolatedEnv(),
  });
  return parseWorktreePorcelain(out);
}

// Creation time in ms, or null when the platform/filesystem can't say (POSIX fs without
// birthtime reports 0 — treated as unknown, never as "old").
function defaultBirthtimeOf(dir) {
  try {
    const b = statSync(dir).birthtimeMs;
    return b > 0 ? b : null;
  } catch {
    return null;
  }
}

// A registered dir must be strictly newer than its marker entry (plus skew slack) to be
// judged re-created; ties/clock-jitter fall to the husk side only past this margin.
const RECREATE_SKEW_MS = 2000;

// Plan 3238 — local git primitives for the branch-delete retry (see module header). Kept
// as three small, independently-injectable seams (mirroring `remove`/`gitRemove`/
// `birthtimeOf` above) rather than a single "handle the branch" function, so a test can
// force exactly one failure mode without faking the others.
function defaultBranchExists(mainDir, branch) {
  try {
    execFileSync(
      'git',
      ['-C', mainDir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { stdio: 'ignore', env: gitRepoIsolatedEnv() },
    );
    return true;
  } catch {
    return false;
  }
}

// `git merge-base --is-ancestor <branch> origin/master` — no fetch, no other network call.
// Any failure (genuinely not merged, or a local `origin/master` too stale to resolve) reads
// as "not proven merged" and refuses the delete — the safe direction either way.
//
// This is the same primitive `coord-git.mjs`'s `isAncestorRef` wraps, deliberately NOT
// imported: `coord-git.mjs` is a ~2.7k-line module that pulls in `ensure-coord-reroute`,
// `worktree-lock`, `kill-tree` and more at load, and THIS module is imported by
// `done-worktree.mjs`/`cut-worktree.mjs` and runs on every one of their invocations. The
// three-line try/catch is cheaper than that surface, and keeping it local is what lets the
// seam be injected (the tests spawn no git at all). Nothing else in this file avoids
// `coord-git.mjs` as a matter of policy — the note in `main()` below is about `resolveMain`
// specifically — so this is a load-weight trade, not a module-wide posture.
function defaultBranchMergedToOriginMaster(mainDir, branch) {
  try {
    execFileSync('git', ['-C', mainDir, 'merge-base', '--is-ancestor', branch, 'origin/master'], {
      stdio: 'ignore',
      env: gitRepoIsolatedEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

// Soft, like `defaultRemove`/`defaultGitRemove` above — the caller's own `branchExists`
// recheck (in `retryBranchDelete`) is what decides whether this actually worked.
function defaultDeleteBranch(mainDir, branch) {
  soft('git', ['-C', mainDir, 'branch', '-D', branch]);
}

// Plan 3238: called at the moment an entry is about to land in `result.swept` (its DIR
// problem just resolved). Returns null for a true no-op (no branch recorded, or the branch
// is already gone — nothing worth reporting), otherwise `{ branch, dir, slug, deleted,
// why? }` — `why` is present whenever `deleted` is false, naming which safety rule left it.
//
// `registeredBranchDirs` is the caller's `{dir, branch}` list for every REGISTERED worktree,
// from the same porcelain read the dir-liveness check already did. It is deliberately a list
// of PAIRS rather than a bare set of branch names, and the check below is "checked out
// SOMEWHERE ELSE", because that snapshot is taken BEFORE the entry loop: a registered husk
// this invocation has just successfully removed is still IN it, carrying its own branch. A
// bare-set membership test would therefore make every registered-husk resolution self-block
// on its OWN now-stale row and report `checked out in a live registered worktree` for a
// worktree that no longer exists — silently defeating the locked-tree case that is the whole
// motivating shape of this plan. Excluding the entry's own dir is safe precisely because its
// registration is the one this invocation just cleared; a row for any OTHER path still
// blocks, which is the cross-session protection the rule exists for.
function retryBranchDelete(mainDir, e, registeredBranchDirs, opts) {
  const branch = e.branch;
  if (!branch) return null;
  const branchExists = opts.branchExists || defaultBranchExists;
  const branchMergedToOriginMaster =
    opts.branchMergedToOriginMaster || defaultBranchMergedToOriginMaster;
  const deleteBranch = opts.deleteBranch || defaultDeleteBranch;

  if (!branchExists(mainDir, branch)) return null; // already gone — nothing to retry
  const outcome = { branch, dir: e.dir, slug: e.slug ?? null };
  const ownDir = canon(e.dir);
  if (registeredBranchDirs.some((r) => r.branch === branch && r.dir !== ownDir)) {
    return { ...outcome, deleted: false, why: 'checked out in a live registered worktree' };
  }
  if (!branchMergedToOriginMaster(mainDir, branch)) {
    return { ...outcome, deleted: false, why: 'not an ancestor of local origin/master' };
  }
  try {
    deleteBranch(mainDir, branch);
  } catch {
    /* soft — the existence recheck below decides the real outcome */
  }
  if (branchExists(mainDir, branch)) {
    return { ...outcome, deleted: false, why: 'delete refused or failed' };
  }
  return { ...outcome, deleted: true };
}

/**
 * Retry removal of teardown-deferred worktree dirs — one attempt each, no storm —
 * PLUS (plan 3092) a marker-independent, REPORT-ONLY scan of every `prunable`
 * `git worktree list` registration: the husk a killed-mid-teardown session left behind
 * is surfaced (both halves), never removed — see the module header for why neither the
 * directory nor the registration may be deleted off that flag alone. PLUS (plan 3238) a
 * retry of the entry's local `worktree-<slug>` branch delete the instant its DIR problem
 * resolves — see the module header's "the branch-delete retry" section for the three
 * safety rules that gate it.
 * Returns { swept, kept, dropped, prunable, branches } (entry lists; `dropped` entries
 * carry a `.why`; `prunable` entries carry `.dir` + `.reason` + `.inRoot` + `.dirLeft` —
 * the last true when a directory is still on disk and so wants a human; `branches`
 * entries carry `.branch` + `.dir` + `.slug` + `.deleted` + `.why` (why present iff not
 * deleted) for every swept entry whose recorded `branch` still existed locally when its
 * dir problem resolved).
 * opts (tests / callers): registeredDirs (string[]), porcelainEntries (full
 * `parseWorktreePorcelain` shape — `{path, branch, prunable, prunableReason, …}`, used to
 * derive registeredDirs when registeredDirs is not given, to derive the (dir, branch) pairs
 * the branch retry consults, AND to drive the prunable-husk scan; note that passing
 * registeredDirs WITHOUT porcelainEntries leaves those pairs empty, so a test that wants the
 * checked-out-elsewhere guard exercised must pass porcelainEntries),
 * porcelainEntriesAfter (the same shape, standing in for the POST-cleanup re-read the husk
 * scan does whenever this invocation removed anything), remove (fn dir), gitRemove (fn
 * mainDir,dir), birthtimeOf (fn dir → ms|null), branchExists (fn mainDir,branch →
 * boolean), branchMergedToOriginMaster (fn mainDir,branch → boolean), deleteBranch (fn
 * mainDir,branch), dry (report only), now (() => iso).
 */
export function sweepDeferredWorktrees(mainDir, opts = {}) {
  const result = { swept: [], kept: [], dropped: [], prunable: [], branches: [] };
  const entries = readDeferredEntries(mainDir);

  let registered;
  let porcelainEntries;
  try {
    if (opts.registeredDirs) {
      registered = opts.registeredDirs.map(canon);
      porcelainEntries = opts.porcelainEntries || [];
    } else {
      porcelainEntries = opts.porcelainEntries || listPorcelainEntries(mainDir);
      registered = porcelainEntries.map((e) => canon(e.path));
    }
  } catch {
    // UNKNOWN = SKIP: can't tell what's live — keep everything untouched this invocation.
    result.kept = entries;
    return result;
  }

  const root = canon(join(mainDir, '.claude', 'worktrees')) + '/';
  const remove = opts.remove || defaultRemove;
  const gitRemove = opts.gitRemove || defaultGitRemove;
  const birthtimeOf = opts.birthtimeOf || defaultBirthtimeOf;
  const now = opts.now || (() => new Date().toISOString());
  const processed = new Set();
  let sweptRegistered = false;
  // Plan 3238: (canonical dir → branch) for every REGISTERED worktree, from the same
  // porcelain read the dir-liveness check above already performed — never re-derived from
  // a second git call. Pairs, not a bare branch set: see `retryBranchDelete` for why the
  // entry's OWN row must not count against it.
  const registeredBranchDirs = porcelainEntries
    .filter((pe) => pe.branch)
    .map((pe) => ({ dir: canon(pe.path), branch: pe.branch }));
  const retryBranch = (e) => {
    const outcome = retryBranchDelete(mainDir, e, registeredBranchDirs, opts);
    if (outcome) result.branches.push(outcome);
  };

  for (const e of entries) {
    const dir = canon(e.dir);
    processed.add(dir);
    if (!existsSync(e.dir)) {
      result.dropped.push({ ...e, why: 'already-gone' });
      continue;
    }
    if (!dir.startsWith(root)) {
      // CONTAINMENT: refuse + drop; a marker entry outside the worktrees root is corrupt
      // and must never drive a recursive delete.
      result.dropped.push({ ...e, why: 'outside-worktrees-root — refused, remove by hand' });
      continue;
    }
    const isRegistered = registered.includes(dir);
    if (isRegistered) {
      const born = birthtimeOf(e.dir);
      const recordedAt = Date.parse(e.ts || e.at || '');
      if (born != null && recordedAt && born > recordedAt + RECREATE_SKEW_MS) {
        // RECREATED = LIVE: removed since the deferral and freshly re-cut — a live tree.
        result.dropped.push({ ...e, why: 'recreated since deferral — live worktree, moot' });
        continue;
      }
      if (born == null || !recordedAt) {
        // UNKNOWN = SKIP: registered and can't prove it predates the deferral.
        result.kept.push(e);
        continue;
      }
      if (opts.dry) {
        result.kept.push(e);
        continue;
      }
      gitRemove(mainDir, e.dir); // the registered-husk primitive: dir + admin entry
      if (existsSync(e.dir)) {
        result.kept.push({ ...e, attempts: (e.attempts || 0) + 1, lastAttemptAt: now() });
      } else {
        sweptRegistered = true;
        result.swept.push(e);
        retryBranch(e); // plan 3238: the dir problem just resolved — retry the branch too
      }
      continue;
    }
    if (opts.dry) {
      result.kept.push(e);
      continue;
    }
    remove(e.dir);
    if (existsSync(e.dir)) {
      result.kept.push({ ...e, attempts: (e.attempts || 0) + 1, lastAttemptAt: now() });
    } else {
      result.swept.push(e);
      retryBranch(e); // plan 3238: the dir problem just resolved — retry the branch too
    }
  }

  if (!opts.dry) {
    // a registered-husk sweep that raced git's own cleanup can leave a stale admin
    // entry; prune is cheap and idempotent
    if (sweptRegistered && !opts.gitRemove) soft('git', ['-C', mainDir, 'worktree', 'prune']);
    rewriteMarker(mainDir, result.kept, processed);
  }

  // Plan 3092: prunable-husk REPORTING — git's OWN judgment (parseWorktreePorcelain's
  // `prunable` flag), independent of the marker file. See the module header for why the
  // marker alone cannot see this shape, and why NOTHING here is deleted: not the
  // directory, and not the `.git/worktrees/<name>` registration either. The report is
  // identical under `--dry`, because there is no mutation for `--dry` to withhold.
  // `porcelainEntries` is the PRE-cleanup snapshot, so it predates this invocation's own
  // removals AND the global prune they trigger. Re-READ git's judgment rather than guess
  // which of its rows the sweep invalidated: an earlier cut of this filtered out entries
  // whose PATH this sweep had swept, which silently hid the one case that most needs
  // reporting — a directory removed while its admin registration survived (a raced or
  // locked prune, the very race the `sweptRegistered` line above exists to paper over).
  // A failed re-read falls back to the stale snapshot rather than reporting nothing —
  // over-reporting a husk costs a human one look, under-reporting costs them the only
  // surface it appears on — but it is FLAGGED `stale`, so the report says so instead of
  // asserting residue that this very invocation may already have cleared.
  let scanEntries = porcelainEntries;
  let stale = false;
  if (!opts.dry && (result.swept.length || sweptRegistered)) {
    try {
      scanEntries = opts.porcelainEntriesAfter || listPorcelainEntries(mainDir);
    } catch {
      scanEntries = opts.porcelainEntriesAfter || porcelainEntries;
      stale = !opts.porcelainEntriesAfter;
    }
  }
  for (const pe of scanEntries.filter((e) => e.prunable)) {
    result.prunable.push({
      dir: pe.path,
      reason: pe.prunableReason,
      inRoot: canon(pe.path).startsWith(root),
      // A husk whose dir is already gone leaves only the registration to judge; one that
      // still has files needs the directory looked at first. Both are reported by path —
      // only the wording differs.
      dirLeft: existsSync(pe.path),
      // true ⇒ read before this invocation's own cleanup, so the row may already be gone
      stale,
    });
  }

  return result;
}

// The ONE rendering of a prunable husk, shared by the spine's stderr line and the
// standalone CLI so the two can never drift into telling an operator different things.
// It must carry every fact a human needs to act safely: WHERE the residue is, which half
// of it is still standing (a dir-already-gone husk needs `git worktree prune` and nothing
// else — the commonest shape, and the one an earlier cut of this omitted from stderr
// entirely), and the two things that make the obvious action WRONG.
//
// Ordering is load-bearing: every caveat precedes the instruction it qualifies. An
// earlier cut printed "remove it" first and "OUTSIDE .claude/worktrees/, do NOT delete"
// after, which is the wrong way round for anyone acting on the first thing they read.
export function describePrunableHusk(e) {
  const caveats = [];
  if (!e.inRoot) {
    caveats.push(
      'OUTSIDE .claude/worktrees/ — do NOT delete this path on the strength of this report',
    );
  }
  if (e.stale) {
    caveats.push(
      'UNVERIFIED — the post-cleanup `git worktree list` re-read failed, so this row predates this run’s own cleanup and may already be gone',
    );
  }
  const action = e.dirLeft
    ? 'directory still on disk — confirm no session is using it, remove it, then `git worktree prune`'
    : 'directory already gone — stale registration only, clear it with `git worktree prune`';
  // `prune` skips a LOCKED registration, so "I ran prune and it is still there" is an
  // expected outcome with its own next step rather than a sign the report was wrong.
  const locked = 'if `prune` leaves it, the registration is locked — `git worktree unlock` first';
  return `${e.dir} (${[...caveats, action, locked].join('; ')})`;
}

// The ONE rendering of a branch left behind by the plan-3238 retry, shared by the spine's
// stderr line and the standalone CLI — mirrors `describePrunableHusk` above. Only ever
// called for a `branches` entry with `deleted: false` (the `.why` field is what a caller
// checks first).
export function describeBranchLeft(e) {
  return `${e.branch} (left — ${e.why}; the reconcile-worktree-branches.mjs audit is the backstop)`;
}

// Rewrite = fresh on-disk read MINUS the dirs this sweep processed PLUS the updated
// kept entries — so a concurrent teardown's append recorded mid-sweep survives the
// rewrite (see the header's residual-race note).
function rewriteMarker(mainDir, kept, processedCanonDirs) {
  const path = markerPath(mainDir);
  const preserved = readDeferredEntries(mainDir).filter(
    (e) => !processedCanonDirs.has(canon(e.dir)),
  );
  const final = [...preserved, ...kept];
  if (!final.length) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* best-effort — a leftover empty marker is harmless */
    }
    return;
  }
  atomicWriteTextSync(path, final.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// The ONE shared invocation wrapper for the two spine call sites (and any future one):
// best-effort, one summary line on stderr when anything happened, errors logged — never
// thrown (a sweep failure must never block a land or a cut).
export function runSweepAndReport(mainDir, label) {
  try {
    const sw = sweepDeferredWorktrees(mainDir);
    const branchesDeleted = sw.branches.filter((b) => b.deleted);
    const branchesLeft = sw.branches.filter((b) => !b.deleted);
    if (
      sw.swept.length ||
      sw.kept.length ||
      sw.dropped.length ||
      sw.prunable.length ||
      sw.branches.length
    ) {
      process.stderr.write(
        `${label}: deferred-worktree sweep — ${sw.swept.length} removed, ` +
          `${sw.kept.length} still locked, ${sw.dropped.length} dropped, ` +
          `${branchesDeleted.length} stranded branch(es) deleted, ${branchesLeft.length} branch(es) left, ` +
          `${sw.prunable.length} prunable registration(s) REPORTED (none removed)\n` +
          // plan 3238: a left branch is named, not folded into a count — the same reasoning
          // as the prunable-husk list below (a count reads as "handled").
          branchesLeft
            .map((b) => `${label}: branch left (dir problem resolved) — ${describeBranchLeft(b)}\n`)
            .join('') +
          // EVERY husk is named, not just the ones with files still on disk. Nothing
          // removes either half any more, so a dir-already-gone entry is the one an
          // operator must prune BY HAND — filtering it down to an aggregate count (as
          // the first cut of this did) leaves the commonest shape unactionable, and a
          // bare count reads as "handled" (plan 3092).
          sw.prunable
            .map(
              (e) =>
                `${label}: prunable-husk NOT removed (a prunable worktree can be a LIVE one that lost its .git) — ` +
                `${describePrunableHusk(e)}\n`,
            )
            .join(''),
      );
    }
    return sw;
  } catch (e) {
    process.stderr.write(`${label}: deferred-worktree sweep skipped: ${e.message || e}\n`);
    return null;
  }
}

export function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const dry = args.includes('--dry');
  // resolveMain would drag in coord-git's heavier surface; the CLI runs from the repo, so
  // the git toplevel of cwd's common dir is the main checkout.
  const top = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
    env: gitRepoIsolatedEnv(),
  }).trim();
  const mainDir = resolve(top, '..');
  const res = sweepDeferredWorktrees(mainDir, { dry });
  if (json) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } else {
    const line = (e, extra = '') => ` - ${e.dir}${extra}`;
    const branchesDeleted = res.branches.filter((b) => b.deleted);
    const branchesLeft = res.branches.filter((b) => !b.deleted);
    process.stdout.write(
      `deferred-worktree sweep${dry ? ' (dry)' : ''}: ` +
        `${res.swept.length} removed, ${res.kept.length} still locked, ${res.dropped.length} dropped, ` +
        `${branchesDeleted.length} branch(es) deleted, ${branchesLeft.length} branch(es) left, ` +
        `${res.prunable.length} prunable registration(s) reported\n` +
        res.swept.map((e) => line(e, ' (removed)')).join('\n') +
        (res.swept.length ? '\n' : '') +
        res.kept.map((e) => line(e, ` (kept, attempts=${e.attempts})`)).join('\n') +
        (res.kept.length ? '\n' : '') +
        res.dropped.map((e) => line(e, ` (dropped: ${e.why})`)).join('\n') +
        (res.dropped.length ? '\n' : '') +
        branchesDeleted.map((b) => ` - branch deleted: ${b.branch}`).join('\n') +
        (branchesDeleted.length ? '\n' : '') +
        // Same shared renderer as the spine's stderr line.
        branchesLeft.map((b) => ` - branch left: ${describeBranchLeft(b)}`).join('\n') +
        (branchesLeft.length ? '\n' : '') +
        // Same shared renderer as the spine's stderr line — `line()` already prints the
        // dir, so this appends only the status/action half.
        res.prunable
          .map((e) => ` - prunable registration REPORTED, not removed: ${describePrunableHusk(e)}`)
          .join('\n') +
        (res.prunable.length ? '\n' : ''),
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error('sweep-deferred-worktrees:', e.message);
    process.exit(2);
  }
}
