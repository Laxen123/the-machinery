#!/usr/bin/env node
// scripts/clear-stale-worktree-lock.mjs — self-heal the recurring stale
// `.git/worktrees/<slug>/index.lock` that interrupts worktree commits (plan 1100).
//
// THE BUG (origin: plan 1089, recurred ~5×). A `git commit` inside a linked
// worktree fails with:
//     fatal: Unable to create '…/.git/worktrees/<slug>/index.lock': File exists.
// The lock is always a 0-byte STALE file with NO live git process holding it —
// `git status` reads fine, the prior commit's git children have all exited. It
// is a crash leftover: a git index-write (the commit's own final index write, or
// a `git add` inside the husky→lint-staged pre-commit run) was killed mid-flight
// — by a Claude session Stop, the Bash-tool 2-min foreground cap (the `scripts/**`
// pre-push gate alone runs ~131 s > the 120 s cap), or the heavy
// ~7-parallel-session shared-`.git` environment — after `open(O_CREAT|O_EXCL)`
// created the empty lock but before the index was written + the lock renamed
// away. The NEXT commit then trips on the leftover. Hand-cleared with `rm -f` +
// retry ~5× during plan 1089; this script replaces that hand step with a SAFE,
// provably-stale clear (rm -f would also nuke a lock a live op holds — this won't).
//
// WHY THIS IS A HELPER, NOT A GIT HOOK (plan 1100 finding — do NOT re-add a hook).
// git acquires the worktree index.lock BEFORE it runs the pre-commit hook —
// verified empirically: with a pre-existing lock planted, `git commit` dies with
// "Unable to create '…index.lock': File exists" and the pre-commit hook never
// runs at all (its marker never prints). So NO git commit-hook can clear a
// pre-existing stale lock; the clear must happen BEFORE `git commit` is invoked.
// Run it as a pre-step / on the EEXIST error, then retry the commit:
//     node scripts/clear-stale-worktree-lock.mjs && git commit -m "…"
// (the `&&` is safe — this script is guaranteed to exit 0, see below). Scripted /
// coordination commits already self-heal via coord-git's gitWithLockRetry →
// waitForIndexLock; this helper is only for the agent's RAW `git commit` in a
// worktree, the one path that bypasses that machinery.
//
// SCOPE — WORKTREE INDEX ONLY, via a STRUCTURAL gate (not a path substring).
// A LINKED worktree's git dir differs from the repo's common git dir
// (`--git-dir` != `--git-common-dir`); the MAIN checkout has them equal. From a
// linked worktree we clear THAT worktree's lock; from the MAIN checkout we sweep
// EVERY linked worktree's lock (plan 1286 — this used to be a silent no-op, root
// cause D of the 2026-07-02 incident). The shared MAIN `.git/index.lock` is a
// different contention class — parallel sessions legitimately race it and it is
// covered by coordWrite / gitWithLockRetry's retry + heal-main's 30 s stale gate —
// so it is NEVER cleared from here. (A substring test on `/worktrees/` would
// misfire for a repo whose own path merely contains a `worktrees` segment — code
// review plan 1100; the `--git-common-dir` comparison is immune to that.)
//
// PROVABLY-STALE GATE. Reuses coord-git's `clearStaleIndexLock` (plan 871): it
// removes the lock IFF its mtime is idle ≥ threshold, logs loudly, and never
// touches a lock a live op is actively rewriting (an active worktree index-write
// completes in well under a second; the pre-commit hook does NOT hold the index
// lock — lint-staged's own `git add` runs inside it). The threshold is SHORTER
// than the shared-index STALE_LOCK_MS (30 s) on purpose: a worktree's index is
// PRIVATE — no parallel session ever writes it — so a few seconds idle already
// proves orphaned. Observed real leaks were 26–193 s idle. Tune with
// WORKTREE_LOCK_STALE_MS (an explicit `0` forces an unconditional clear).
//
// ALWAYS EXITS 0 — a clearer failure must never block the `&&`-chained commit
// retry; git's own acquire then surfaces any genuine contention. coord-git is
// imported LAZILY inside the guarded path so even a module-load failure there
// can't break that guarantee.
//
// `--rebase-state` (plan 2398 item 5) — the SECOND crash-leftover class on this checkout: a
// stale `.git/rebase-merge` left by the same Git-for-Windows crash, which blocked `git rebase`
// for an unrelated session on 2026-07-25 while HEAD was still a symbolic ref (i.e. no rebase
// was in flight). The logic + its three gates live in `./stale-rebase-state.mjs`; this script
// is where the reflex is INVOKED from, because it is the one place agents already reach for a
// crash leftover in this worktree's git dir. It is OPT-IN and never on the default path: the
// default is `&&`-chained in front of a raw `git commit` and must stay non-destructive
// (removing an empty index.lock loses nothing; discarding rebase state could). Same lazy
// import + exit-0 discipline as coord-git above.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// The staleness gate (env-tunable WORKTREE_LOCK_STALE_MS, default 3 s) is parsed ONCE in
// coord-git.mjs and imported lazily below with the rest of the machinery (plan 1286 dedup —
// heal-main and the sweep share the same constant, so the three can never desync). Lazy so a
// coord-git load failure still cannot break this script's exit-0 guarantee.

// Normalise a path for cross-platform structural comparison (Windows: separators
// + case differ between two otherwise-identical paths).
const normPath = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// plan 4087 review round 2 (finding clear-stale-worktree-lock.mjs:133), updated round-3 (key
// 51f62f): report an uncleared lock's TRUE reason, shared by BOTH the single-linked-worktree
// branch and the MAIN-checkout sweep branch below. `outcome` is one of 'delete-failed' / 'absent'
// / 'fresh' — `clearStaleIndexLockDetailed`'s fourth outcome, 'unresolvable' (its own lockPath
// could not be determined), is dropped here: BOTH call sites always resolve and pass `lockPath`
// explicitly before calling it (the single-worktree branch builds it from `gitDir`, the sweep
// branch — via `sweepWorktreeIndexLocks` — builds it from `worktreeAdminRoot`), so
// `clearStaleIndexLockDetailed`'s own "path unresolvable" branch can never fire through either
// path. A message for an outcome that cannot occur just teaches the reader a wrong story, so it
// is removed instead of kept as dead-but-harmless.
//
// 'absent' means the lock's presence changed between two checks — this script's own guard and
// `clearStaleIndexLockDetailed`'s internal stat disagreed about whether it was there. That race
// runs in OPPOSITE directions for the two callers (the single-worktree branch's own `existsSync`
// gate runs AFTER `clearStaleIndexLockDetailed`, so 'absent' there means a lock APPEARED since;
// the sweep branch instead now reports `clearStaleIndexLockDetailed`'s own outcome straight from
// `sweepWorktreeIndexLocks` — plan 4087 round-3 review key b14495 — whose OWN presence check ran
// BEFORE the attempted clear, so 'absent' there means a lock that existed a moment ago is
// already gone), so the message stays direction-neutral rather than asserting the one direction
// that only ever held for the single-worktree branch.
function reportUnclearedLock(outcome, ageMs, lockPath, staleMs) {
  if (outcome === 'delete-failed') {
    console.error(
      `[clear-stale-worktree-lock] worktree index.lock is stale (idle ${Math.round((ageMs ?? 0) / 1000)}s) ` +
        `but could NOT be deleted (a live handle denied the delete — EPERM/EBUSY): ${lockPath}`,
    );
  } else if (outcome === 'absent') {
    console.error(
      `[clear-stale-worktree-lock] worktree index.lock's presence changed between two checks ` +
        `(already cleared, or appeared after an earlier check found none) — nothing further to ` +
        `do here; re-run if a lock is still blocking a commit: ${lockPath}`,
    );
  } else {
    // 'fresh' — the only outcome left once 'removed' (filtered by every caller below before
    // reaching here) and 'unresolvable' (structurally unreachable, see above) are accounted for.
    console.error(
      `[clear-stale-worktree-lock] worktree index.lock present but idle < ` +
        `${staleMs}ms — left in place (a live op may hold it): ${lockPath}`,
    );
  }
}

async function main() {
  // Resolve the git dir AND the common git dir, both absolute, in ONE call.
  // `--path-format=absolute` (git ≥ 2.31) makes both lines absolute so the
  // structural comparison below is reliable. Any failure (not a repo / git
  // missing / ancient git) → no-op, the safe degradation.
  let gitDir, commonDir;
  try {
    const lines = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .split(/\r?\n/);
    gitDir = (lines[0] || '').trim();
    commonDir = (lines[1] || '').trim();
  } catch {
    return;
  }
  if (!gitDir || !commonDir) return;

  // Opt-in second leftover class (plan 2398 item 5). Runs for MAIN and for a linked worktree
  // alike — rebase state is per-worktree ($GIT_DIR/rebase-merge) and the HEAD gate is read
  // from whichever worktree we are standing in. Lazy import, so a load failure here still
  // cannot break the exit-0 contract.
  if (process.argv.slice(2).includes('--rebase-state')) {
    const { clearStaleRebaseState } = await import('./stale-rebase-state.mjs');
    const { WORKTREE_LOCK_STALE_MS } = await import('./coord/coord-git.mjs');
    clearStaleRebaseState(gitDir, { staleMs: WORKTREE_LOCK_STALE_MS });
  }

  // MAIN checkout (git-dir === common-dir): the SHARED index is coordWrite's domain — NEVER
  // clear it from here. But plan 1286 (root cause D, 2026-07-02 incident): this used to be a
  // SILENT full no-op, so an operator clearing a WORKTREE's stale lock from the main checkout
  // got no action and no message — and reached for the blind `rm -f` this helper exists to
  // retire. From MAIN we now sweep EVERY linked worktree's index.lock with the same
  // provably-stale gate (the shared main index.lock still stays untouched).
  if (normPath(gitDir) === normPath(commonDir)) {
    const { sweepWorktreeIndexLocks, WORKTREE_LOCK_STALE_MS } =
      await import('./coord/coord-git.mjs');
    const swept = sweepWorktreeIndexLocks(process.cwd(), { staleMs: WORKTREE_LOCK_STALE_MS });
    for (const s of swept) {
      // plan 4087 round-3 review (key b14495): `sweepWorktreeIndexLocks` now carries
      // `clearStaleIndexLockDetailed`'s own outcome through on `s.outcome` (coord-git.mjs) — no
      // re-probe here. The old `existsSync(s.lockPath)` re-check ran well AFTER
      // `sweepWorktreeIndexLocks` made its own presence/staleness determination, so it was
      // answering a DIFFERENT, later moment in time and could disagree with (and mislabel) what
      // actually happened — reporting straight from `s.outcome` removes that second race instead
      // of papering over it.
      if (!s.removed) {
        reportUnclearedLock(s.outcome, s.ageMs, s.lockPath, WORKTREE_LOCK_STALE_MS);
      }
    }
    if (!swept.length) {
      console.error(
        '[clear-stale-worktree-lock] run from the MAIN checkout — no linked-worktree index.lock found. ' +
          '(The shared main .git/index.lock is never cleared from here; that is coordWrite/heal-main territory.)',
      );
    }
    return;
  }

  const lockPath = `${gitDir}/index.lock`;

  // Lazy import so an import-time failure in coord-git can't break exit-0.
  const { clearStaleIndexLockDetailed, WORKTREE_LOCK_STALE_MS } =
    await import('./coord/coord-git.mjs');
  const detail = clearStaleIndexLockDetailed(gitDir, {
    staleMs: WORKTREE_LOCK_STALE_MS,
    lockPath,
  });

  // clearStaleIndexLockDetailed logs ONLY when it removes. If a lock is present but we
  // deliberately spared it (younger than the threshold — a live op may hold it), SAY so:
  // otherwise the operator reads silence as "no lock", sees the retry fail again, and
  // reaches for the blind `rm -f` this helper exists to retire. plan 4087 T4-C: a lock that
  // is PROVABLY STALE but whose delete itself failed (a live handle denies it — EPERM/EBUSY)
  // is a DIFFERENT, truer reason — reporting it as "still fresh" is simply false and sends
  // the operator hunting for a live op that isn't there.
  if (!detail.removed && existsSync(lockPath)) {
    // plan 4087 T4-C follow-up, unified round 2 (finding :133) with the sweep branch above via
    // the shared reportUnclearedLock: this call site always passes `lockPath` in, so
    // `clearStaleIndexLockDetailed` can only return 'absent' / 'fresh' / 'delete-failed' here,
    // never 'unresolvable' (reportUnclearedLock's own header explains why that outcome is
    // dropped rather than handled, round-3 review key 51f62f). Folding 'absent' into "fresh"
    // would still be wrong: 'absent' means its own internal stat found NO lock, while the
    // existsSync above that gates this whole block then found one — a lock appeared in the
    // race window between those two checks, not one we deliberately spared as live-held.
    reportUnclearedLock(detail.outcome, detail.ageMs, lockPath, WORKTREE_LOCK_STALE_MS);
  }
}

main()
  .catch((e) => {
    // Defensive: any failure (incl. the lazy import) must never block the retry.
    console.error(`[clear-stale-worktree-lock] non-fatal: ${e?.message || e}`);
  })
  .finally(() => process.exit(0));
