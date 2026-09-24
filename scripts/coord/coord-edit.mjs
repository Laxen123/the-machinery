#!/usr/bin/env node
// scripts/coord-edit.mjs  (plan 646, T2)
// Land a HAND-AUTHORED working-tree edit to an arbitrary shared-doc pathspec on master
// ($MAIN) atomically, with coordWrite's contract — closing the one gap coordWrite/
// index.mjs/move-plan/edit-plan don't cover: a bulk cleanup that hand-edits a file no
// coord tool owns (the docs/INDEX.md *archive* region — outside the INDEX:PLANS
// sentinels — or handoff.md). Today such an edit sits briefly uncommitted on the shared
// master checkout, and a sibling coord tool's `git add` then sweeps the hunks into ITS
// commit (content lands, attribution scatters — observed 3× in one plan-639 session).
//
// HOW IT DIFFERS FROM coordWrite: coordWrite re-runs an idempotent `mutate()` against the
// fresh base each attempt. coord-edit has no regenerator — it CAPTURES the hand-edit as a
// patch once, then REPLAYS that fixed patch onto the freshened base each attempt, 3-way
// merging so a sibling's concurrent edit to OTHER lines of the same file is preserved.
// If a sibling edits the SAME lines, the replay can't auto-resolve — coord-edit fails
// LOUD (PATCH_CONFLICT) and leaves the tree clean for a manual re-author.
//
// WHY --cached --3way (not `git apply` to the working tree): this repo stores coordination
// docs as LF blobs with a CRLF working tree (core.autocrlf / .gitattributes). `git apply`
// to the working tree matches LF patch context against CRLF lines and fatally fails. The
// index blobs are all LF, so applying to the INDEX (--cached) is line-ending-immune; the
// working tree is re-synced from HEAD after a successful land.
//
// SCOPE: tracked-file EDITS only. A brand-new file is not captured by `git diff HEAD` —
// author new plans via `next-plan-id.mjs claim`, not this. Do NOT use coord-edit for the
// docs/INDEX.md *generated* region (between the INDEX:PLANS sentinels) — that is regenerated
// by build-index and guarded by lint; use index.mjs / move-plan.mjs there.
//
// CARVE-OUT (plan 1684): docs/superpowers/batches/** (the plan-1467 batch-folder surface,
// e.g. docs/superpowers/batches/<slug>/batch.md) has no OTHER sanctioned creation path —
// next-plan-id.mjs claim only mints PLAN files, not batch folders. When EVERY untracked path
// in a single --paths invocation is under docs/superpowers/batches/, coord-edit marks it
// intent-to-add (`git add -N`) so the diff/capture/apply pipeline below treats it as an
// ordinary new-file addition, then unstages that marker again if anything fails before the
// land completes. A mix of a batches/** new file and any OTHER untracked path still refuses
// in full, same as a plan/spec/handoff new file always has.
//
// Usage (run from anywhere — it operates on $MAIN regardless of cwd, after you hand-edit
// the file IN the main checkout):
//   node scripts/coord-edit.mjs --paths docs/INDEX.md --message "docs(plans): bulk-archive sweep"
//   node scripts/coord-edit.mjs --paths docs/INDEX.md handoff.md --message "..." [--dry]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  resolveMain,
  git,
  gitWithLockRetry,
  backoffMs,
  sleepSync,
  COORD_TRAILER,
  masterPushSpec,
  withCoordCheckout,
  ffMasterFromOrigin,
  parseFlags,
  // plan 2580: the ONE coord-land protocol (commit → pin → release → push → rollback → verify) and
  // its no-op twin, shared with coordWrite instead of re-implemented here. `revertPathsToHead` is
  // the unified revert that replaced this module's private `restorePathsToHead` near-twin.
  coordLandCommit,
  assertNoopReachedOrigin,
  nothingStagedFor,
  // plan 3802: the coord checkout is a sparse cone, so this write path guards its targets the
  // same way coordWrite does — coordEditApply is a withCoordCheckout caller in its own right.
  assertCoordPathInCone,
  revertPathsToHead,
  NO_COORD_LOCK,
} from './coord-git.mjs';
import { scanForCorruption, corruptionWarning } from './corruption-guard.mjs';
import { BATCHES_DIR_REL } from './batch-paths.mjs';
// plan 4071 T2: assertCoordPathInCone's `excludes` is now caller-injected (coord.config.json's
// `coordCheckoutExcludedTopLevel`) rather than a coord-git.mjs module constant — resolved here from
// `mainDir`, which by the time coordEditApply runs is the already-populated coord-checkout dir (its
// root-level coord.config.json is always materialised by cone mode, see coord-git.mjs).
import { loadCoordConfig } from './coord-config.mjs';

// Arg surface (via the shared coord-git parseFlags, plan 1769): --paths consumes EVERY
// following non-flag token (so multiple paths work), --message takes one value, --dry is a
// boolean. An unknown --flag is a loud error; a bare positional OR single-dash token gets
// the historical paths hint (pre-1769 both fell to the same "unexpected argument" branch —
// the unknownFlag override keeps that hint for `-z` while `--bogus` stays "unknown flag").
export function parseCoordEditArgs(argv) {
  const pathsHint = (a) => `unexpected argument "${a}" (paths go after --paths)`;
  const { flags } = parseFlags(argv, {
    label: 'coord-edit',
    multi: ['paths'],
    value: ['message'],
    boolean: ['dry'],
    positionals: false,
    messages: {
      positional: pathsHint,
      unknownFlag: (a) => (a.startsWith('--') ? `unknown flag ${a}` : pathsHint(a)),
    },
  });
  const { paths = [], ...rest } = flags;
  return { paths, flags: rest };
}

// Capture the full delta of relPaths from HEAD (staged + unstaged) as a --full-index patch
// so `git apply --3way` can locate the pre-image blob even after the base advances.
export function capturePatch(mainDir, relPaths, { env } = {}) {
  return git(mainDir, ['diff', '--full-index', 'HEAD', '--', ...relPaths], { env });
}

// plan 2580: the private `restorePathsToHead` that used to live here is GONE — it was a near-twin
// of coord-git's exported `revertPathsToHead` that carried the conflicted-index `checkout HEAD`
// rung but NOT the new-file cleanup loop, so a rolled-back attempt that created a brand-new file
// left it dangling untracked (plan 2572 gap). `revertPathsToHead` is now the superset of both and
// is imported above; every former call site calls it instead.

// True if `patch` is ALREADY applied to the current index (it reverse-applies cleanly) —
// e.g. a sibling landed an identical edit before us. Lets coord-edit report a clean no-op
// instead of mistaking an already-present edit for a conflict.
function patchAlreadyApplied(mainDir, patch, env) {
  try {
    git(mainDir, ['apply', '--cached', '--reverse', '--check'], { input: patch, env });
    return true;
  } catch {
    return false;
  }
}

// The land loop. Mirrors coordWrite's freshen → mutate → commit-pathspec(+trailer) → push
// → jittered silent rebase-retry on non-ff, with REPLAY-A-PATCH where coordWrite re-runs
// mutate. `patch` is captured ONCE by the caller; the working tree of relPaths is assumed
// clean at entry (the caller resets after capture). Returns { attempts, noop? }.
// `onBeforePush` is an optional test seam (undefined in production): a synchronous retry
// loop has no per-attempt callback like coordWrite's `mutate`, so this is the only hook a
// test can use to deterministically land a sibling commit between our freshen and our push
// and force a non-ff. It runs immediately before each `git push`.
export function coordEditApply(
  mainDir,
  {
    relPaths,
    patch,
    message,
    tool = 'coord-edit',
    attempts = 8,
    onBeforePush,
    // plan 2519 (porting plan 2393 lever 1): the lock handle from withCoordCheckout, so this
    // loop can hand the coord lock back after its commit and spend the push round-trip
    // unserialized. Defaults to the inert NO_COORD_LOCK so a caller that ignores this (or calls
    // coordEditApply directly, as the unit tests do) keeps today's behaviour — the seam is
    // opt-in, exactly like coordWrite's lockCtx.
    lockCtx = NO_COORD_LOCK,
    // plan 2580: the same injectable git coordWrite has always had, threaded ONLY into the shared
    // land helper (commit / rev-parse / push) exactly as coordWrite threads it — the apply/diff
    // calls above stay on the real `git`. Without it the half-land commit tolerance this module
    // just inherited has no way to be exercised: that path only opens when the commit reports
    // "nothing to commit" AFTER git already moved HEAD, which only a fault-injecting git can stage.
    _git = git,
  },
) {
  if (!relPaths?.length) throw new Error('coordEditApply: relPaths required');
  // plan 4071 T2: resolved from mainDir (the coord-checkout, already populated by the time this
  // runs — see the import comment above).
  const { coordCheckoutExcludedTopLevel: coneExcludes } = loadCoordConfig(mainDir);
  for (const rel of relPaths) assertCoordPathInCone(rel, { tool, excludes: coneExcludes });
  if (typeof message !== 'string' || !message.trim())
    throw new Error('coordEditApply: a non-empty message is required');
  if (!patch?.trim()) {
    const e = new Error(`coord-edit: no uncommitted changes in [${relPaths.join(', ')}] to land`);
    e.code = 'NO_CHANGES';
    throw e;
  }
  const env = { ...process.env, HUSKY: '0' };
  const fullMsg = `${message}\n\n${COORD_TRAILER}: ${tool}`;
  // plan 1286: `mainDir` is now normally the DISPOSABLE coord-checkout (detached HEAD), where a
  // bare `push origin master` would push the shared local master ref instead of our commit —
  // name the source explicitly, exactly as coordWrite does.
  const pushSpec = masterPushSpec(mainDir, env);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      gitWithLockRetry(mainDir, ['fetch', '--quiet', 'origin', 'master'], { env });
      gitWithLockRetry(mainDir, ['merge', '--ff-only', 'origin/master'], { env });
    } catch {
      /* offline / locally-ahead — the push non-ff guard below is the backstop */
    }
    // Replay the captured edit onto the freshened INDEX (LF blobs → CRLF-immune). --3way
    // preserves a sibling's edit to OTHER lines; a SAME-line clash leaves the index
    // conflicted and exits non-zero.
    try {
      git(mainDir, ['apply', '--cached', '--3way', '--whitespace=nowarn'], { input: patch, env });
    } catch (ae) {
      // A failed --3way may have left unmerged stage-1/2/3 entries in the index. Clean to a
      // deterministic base FIRST, THEN probe for already-applied — a reverse-check against a
      // conflicted index is ambiguous across git versions and could misclassify a real
      // same-line conflict as a no-op (silently dropping the edit).
      revertPathsToHead(mainDir, relPaths, env);
      if (patchAlreadyApplied(mainDir, patch, env)) {
        // plan 2580: "a sibling already landed our exact edit" is a claim about ORIGIN, but the
        // reverse-apply probe only proves it against this checkout's HEAD — prove the rest.
        assertNoopReachedOrigin(mainDir, pushSpec, env, {
          relPaths,
          label: 'coordEditApply',
          _git,
        });
        return { attempts: i + 1, noop: true }; // sibling already landed our exact edit
      }
      const e = new Error(
        `coord-edit: the captured edit no longer applies to [${relPaths.join(', ')}] after ` +
          `origin/master advanced — a sibling changed the same lines. Re-make your edit against ` +
          `fresh master and re-run.\n${`${ae.stderr || ''}${ae.message || ''}`.trim()}`,
      );
      e.code = 'PATCH_CONFLICT';
      throw e;
    }
    // No-op short-circuit: the apply produced nothing net new in the index (idempotent
    // re-run / equivalent edit already on the base) → success without an empty commit.
    if (nothingStagedFor(mainDir, relPaths, env)) {
      revertPathsToHead(mainDir, relPaths, env);
      // plan 2580: same guard as coordWrite's no-op, and deliberately OUTSIDE the probe's
      // try/catch — that catch means "there are staged changes", so swallowing a verification
      // failure into it would resurrect the silent-success this guard exists to kill.
      assertNoopReachedOrigin(mainDir, pushSpec, env, {
        relPaths,
        label: 'coordEditApply',
        _git,
      });
      return { attempts: i + 1, noop: true };
    }
    // We applied to the INDEX (--cached, for CRLF-safety); but `git commit -- <pathspec>`
    // commits the WORKING TREE content of those paths, which is still at pre-edit content
    // from the reset. Sync the working tree FROM the freshly-merged index so the pathspec
    // commit records the merged result (and the tree ends clean = HEAD after commit).
    gitWithLockRetry(mainDir, ['checkout', '--', ...relPaths], { env });
    // plan 2580: commit → pin → release → push → reacquire/rollback → verify is now the ONE shared
    // coord-land protocol helper coordWrite also calls, instead of the copy plan 2519 ported here
    // (which had already silently diverged twice and still lacked the half-land commit tolerance
    // and the new-file rollback cleanup — both now inherited by construction). A non-ff comes back
    // as `{pushed:false}` for this loop to retry; anything else throws straight out, as before.
    const landed = coordLandCommit(mainDir, {
      relPaths,
      fullMsg,
      env,
      pushSpec,
      lockCtx,
      label: 'coordEditApply',
      onBeforePush,
      attempt: i,
      _git,
    });
    if (landed.pushed) return { attempts: i + 1 };
    lastErr = landed.error;
    sleepSync(backoffMs(i));
  }
  const err = new Error(
    `coord-edit([${relPaths.join(', ')}]) blocked after ${attempts} attempts — origin/master kept ` +
      `advancing. This is NORMAL transient contention; just re-run.`,
  );
  err.cause = lastErr;
  throw err;
}

// Plan 1634: refuse EARLY when a relPath's working copy (post-image) or HEAD blob
// (pre-image) is a disk-corruption signature, rather than let capturePatch produce a
// binary "Files differ" patch that `git apply --3way` (called later, inside
// coordEditApply, against the disposable coord-checkout) then fails to apply — confusing
// and late. Throws CORRUPTED_PREIMAGE naming every corrupted path + reason up front.
export function assertNoCorruption(mainDir, relPaths, env) {
  const { corrupted } = scanForCorruption(
    relPaths,
    (p) => readFileSync(join(mainDir, p), 'utf8'),
    (p) => git(mainDir, ['show', `HEAD:${p}`], { env }),
  );
  if (corrupted.length) {
    const e = new Error(
      corrupted.map(({ path: p, reason }) => corruptionWarning(p, reason)).join('\n') +
        `\ncoord-edit: refusing to capture/apply an edit whose pre-image or post-image is ` +
        `corrupted — fix or restore the file(s) above before re-running coord-edit.`,
    );
    e.code = 'CORRUPTED_PREIMAGE';
    throw e;
  }
}

// List the relPaths that are NOT tracked in HEAD. `git diff HEAD` silently OMITS an untracked
// path, so a new file passed in --paths would vanish from the commit behind a misleading
// success message — reject it up front (author new files via next-plan-id.mjs claim), except
// for the docs/superpowers/batches/** carve-out (plan 1684) handled by the caller.
function untrackedPaths(mainDir, relPaths, env) {
  return relPaths.filter((p) => {
    try {
      git(mainDir, ['ls-files', '--error-unmatch', '--', p], { env, stdio: 'pipe' });
      return false;
    } catch {
      return true;
    }
  });
}

// plan 1684: the ONLY untracked-file carve-out. Matches a path anywhere under
// BATCHES_DIR_REL (the plan-1467 batch-folder surface, imported from batch-paths.mjs — the
// single source of truth for this path, plan 1678 batch review finding [4]) — new plans,
// specs, or any other new file are NOT covered and keep the original refusal.
const BATCH_CARVEOUT_RE = new RegExp(`^${BATCHES_DIR_REL}/`);

function carveoutErrorMessage(disallowedPaths) {
  return (
    `coord-edit: not tracked — coord-edit lands EDITS to existing files, not new files ` +
    `(author new plans via next-plan-id.mjs claim; the only untracked-file carve-out is a ` +
    `new docs/superpowers/batches/** file, plan 1684): ${disallowedPaths.join(', ')}`
  );
}

// Validates relPaths' untracked subset against the carve-out policy and stages it (`git add -N`)
// so a caller can immediately capturePatch/diff it as an ordinary new-file addition. Returns the
// untracked subset (the caller resets it on cleanup). Throws (code CARVEOUT_DISALLOWED) on any
// untracked path outside the carve-out. Shared by coordEdit() and the --dry CLI branch — these
// two had already drifted once while hand-duplicated (coordEdit()'s own throw interpolated the
// full untracked list instead of just the disallowed offenders — plan 1678 batch review finding
// [2]/[3]): one implementation closes both.
function stageCarveoutOrThrow(mainDir, relPaths, env) {
  const untracked = untrackedPaths(mainDir, relPaths, env);
  if (untracked.length) {
    const disallowed = untracked.filter((p) => !BATCH_CARVEOUT_RE.test(p));
    if (disallowed.length) {
      const e = new Error(carveoutErrorMessage(disallowed));
      e.code = 'CARVEOUT_DISALLOWED';
      throw e;
    }
    // plan 1684: every untracked path is under docs/superpowers/batches/ — mark it intent-to-add
    // so `git diff`/`capturePatch` see it as an ordinary new-file addition.
    git(mainDir, ['add', '-N', '--', ...untracked], { env });
  }
  return untracked;
}

// Capture the hand-edit from $MAIN's working tree, then land it via coordEditApply — since
// plan 1286 the land loop runs against the DISPOSABLE coord-checkout under the coord-write
// lock (withCoordCheckout), never the shared MAIN tree. Two consequences:
//   - foreign dirt on MAIN can no longer refuse the op (the plan-487 assertCleanOutsidePathspec
//     guard is structurally obsolete here — the land never touches MAIN's other files);
//   - KILL-safety improves: MAIN's dirt (the only durable copy of the hand-edit) is restored
//     to HEAD only AFTER the land succeeded on origin. A kill mid-land leaves the edit intact
//     in MAIN's tree, and the re-run re-captures it (an already-landed patch reports noop).
// After a successful land, MAIN's captured paths are restored to HEAD and MAIN is best-effort
// fast-forwarded to the new origin tip (so the file's on-disk content comes right back);
// when a sibling's dirt blocks that ff, origin holds the truth and MAIN just lags, as for
// every other routed writer.
// Returns { attempts, noop?, changed } where `changed` is the subset of relPaths that actually
// had an edit (so callers report what truly landed, not every name passed in --paths).
export function coordEdit(
  mainDir,
  { relPaths, message, tool = 'coord-edit', attempts = 8, onBeforePush },
) {
  const env = { ...process.env, HUSKY: '0' };
  const carveoutAdded = stageCarveoutOrThrow(mainDir, relPaths, env);
  try {
    assertNoCorruption(mainDir, relPaths, env);
    const changed = git(mainDir, ['diff', '--name-only', 'HEAD', '--', ...relPaths], { env })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const patch = capturePatch(mainDir, relPaths, { env });
    if (!patch.trim()) {
      const e = new Error(`coord-edit: no uncommitted changes in [${relPaths.join(', ')}] to land`);
      e.code = 'NO_CHANGES';
      throw e;
    }
    // Captured now (before anything is mutated) so the post-land recovery path below can
    // re-materialize ONLY the carve-out path(s) — never the full `patch`, which can cover OTHER,
    // already-landed tracked paths in the same call and would re-dirty them as phantom local
    // changes, potentially wedging MAIN's ff outright (review finding, plan 1678 batch: reproduced
    // empirically — reapplying the full patch against a co-committed tracked file leaves it
    // locally modified, and a subsequent `merge --ff-only` then hard-refuses on "local changes
    // would be overwritten" instead of merely lagging).
    const carveoutPatch = carveoutAdded.length ? capturePatch(mainDir, carveoutAdded, { env }) : '';
    const res = withCoordCheckout(
      mainDir,
      // plan 2519: forward the lock handle so coordEditApply can release it after its commit,
      // same as board.mjs/coordWrite already do.
      (cdir, lockCtx) =>
        coordEditApply(cdir, { relPaths, patch, message, tool, attempts, onBeforePush, lockCtx }),
      { tool },
    );
    // Landed (or provably already on origin): MAIN's copy of the edit is now redundant dirt —
    // clear it (this is what recreates it below when ff succeeds: `git merge --ff-only` REFUSES
    // outright — "untracked working tree files would be overwritten by merge" — when a matching
    // untracked file already occupies a path the merge wants to introduce, so a carve-out path
    // must be cleared BEFORE the ff, not after; empirically confirmed, not merely inferred), then
    // best-effort ff so the on-disk content reflects the just-landed commit.
    revertPathsToHead(mainDir, relPaths, env);
    let ffOk = false;
    try {
      ffMasterFromOrigin(mainDir, { env });
      ffOk = true;
    } catch {
      /* dirty/diverged MAIN — origin holds the truth; MAIN catches up on a later ff */
    }
    if (!ffOk && carveoutAdded.length) {
      // The carve-out path had no HEAD blob under MAIN's OLD local HEAD, so the revertPathsToHead
      // call above DELETED its working-tree copy (by design — that's what let the ff above have a
      // chance to recreate it cleanly). But the ff just failed, so local HEAD still lacks the
      // file: it is now MISSING from MAIN's disk even though the land already succeeded on origin
      // — coordEdit() would otherwise report success while silently deleting the caller's file
      // (review finding, plan 1678 batch). Re-materialize it from the SAME patch already captured
      // and landed (not a guess — byte-identical to what's on origin) rather than leave it gone;
      // a later successful ff still reconciles it into the index properly (this file then becomes
      // the same "untracked blocks the next ff until cleared" case as a fresh carve-out land,
      // which is the same class of MAIN-lags staleness already accepted for ordinary tracked paths
      // whose ff fails, not a new failure mode).
      try {
        gitWithLockRetry(mainDir, ['apply', '--whitespace=nowarn'], { input: carveoutPatch, env });
      } catch {
        /* best-effort recovery; worst case an operator re-fetches/re-runs coord-edit manually */
      }
    }
    return { ...res, changed };
  } catch (e) {
    // plan 1684: an error before the land completed must not leave the carve-out's
    // intent-to-add marker behind — unstage it so MAIN reads exactly as it did before this
    // call (the file itself is untouched; only its index staging state is reverted).
    if (carveoutAdded.length) {
      try {
        gitWithLockRetry(mainDir, ['reset', '--', ...carveoutAdded], { env });
      } catch {
        /* best-effort cleanup; the underlying error is what surfaces */
      }
    }
    throw e;
  }
}

export async function main() {
  let paths, flags;
  try {
    ({ paths, flags } = parseCoordEditArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (!paths.length) {
    console.error(
      'usage: coord-edit.mjs --paths <p…> --message "<subject>" [--dry]\n' +
        '  Hand-edit the tracked shared doc(s) in the MAIN checkout first, then run this.',
    );
    return 2;
  }
  if (!flags.message) {
    console.error('coord-edit: --message "<commit subject>" is required');
    return 2;
  }

  const mainDir = resolveMain();
  const env = { ...process.env, HUSKY: '0' };

  if (flags.dry) {
    // plan 1678 batch review finding [2]/[3]: shares stageCarveoutOrThrow with coordEdit() —
    // otherwise a brand-new docs/superpowers/batches/** file is untracked, `capturePatch` (a
    // plain `git diff HEAD`) sees nothing for it, and --dry falsely reports "no uncommitted
    // changes" for a path that a real (non-dry) run lands successfully; a hand-duplicated copy
    // of this check already drifted once (a wrong-list error message) while separate.
    let untracked;
    try {
      untracked = stageCarveoutOrThrow(mainDir, paths, env);
    } catch (e) {
      if (e.code === 'CARVEOUT_DISALLOWED') {
        console.error(e.message);
        return 2;
      }
      throw e;
    }
    try {
      try {
        assertNoCorruption(mainDir, paths, env);
      } catch (e) {
        if (e.code === 'CORRUPTED_PREIMAGE') {
          console.error(e.message);
          return 3;
        }
        throw e;
      }
      const patch = capturePatch(mainDir, paths, { env });
      if (!patch.trim()) {
        console.error(`coord-edit: no uncommitted changes in [${paths.join(', ')}] to land`);
        return 2;
      }
      const changed = git(mainDir, ['diff', '--name-only', 'HEAD', '--', ...paths], { env }).trim();
      console.log(
        `[dry] would land edits to:\n${changed
          .split('\n')
          .map((f) => `  ${f}`)
          .join(
            '\n',
          )}\n  commit "${flags.message}" + Coord-Write trailer, pushed to master via coord-edit.`,
      );
      return 0;
    } finally {
      // --dry must never leave a lingering intent-to-add marker on MAIN.
      if (untracked.length) {
        try {
          gitWithLockRetry(mainDir, ['reset', '--', ...untracked], { env });
        } catch {
          /* best-effort */
        }
      }
    }
  }

  let res;
  try {
    res = coordEdit(mainDir, { relPaths: paths, message: flags.message, tool: 'coord-edit' });
  } catch (e) {
    if (e.code === 'NO_CHANGES') {
      console.error(e.message);
      return 2;
    }
    if (e.code === 'PATCH_CONFLICT' || e.code === 'CORRUPTED_PREIMAGE') {
      console.error(e.message);
      return 3;
    }
    throw e;
  }
  // Report the files that ACTUALLY had an edit (res.changed), not every name passed in
  // --paths — a path with no change is a no-op for that file and must not read as "landed".
  const landed = res?.changed?.length ? res.changed.join(', ') : paths.join(', ');
  console.log(
    res?.noop
      ? `coord-edit: [${landed}] — already up to date on master (nothing to push).`
      : `coord-edit: [${landed}] — committed + pushed to master.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error('coord-edit:', e.message);
      process.exit(1);
    },
  );
}
