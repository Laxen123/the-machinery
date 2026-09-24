// scripts/test-helpers/tracked-tmpdir.mjs — a `mkdtempSync` that CANNOT leak (plan 2365 T4).
//
// WHY THIS IS A SHARED HELPER AND NOT A PER-FILE BLOCK. Two suites (install-lock.test.mjs,
// install-main.test.mjs) each had ~15 and ~20 bare `mkdtempSync(join(tmpdir(), '<prefix>-'))` call
// sites and NOTHING that ever removed the dirs — measured on the operator's real TEMP on
// 2026-07-25: 3772 leaked `install-lock-*` and 267 leaked `install-main-*` directories. The first
// fix attempt hand-rolled the same "track + sweep in after()" block in BOTH files, and the
// install-main.test.mjs copy used an OPT-IN wrapper (`tmp()`), which two call sites simply did not
// call — so that file kept leaking while its own header claimed it did not. That is precisely the
// failure mode `test-helpers/isolated-plan-repo.mjs`'s header (plan 1797) records this repo already
// paying for once ("a scaffold fix had to be applied four times"). One implementation, here.
//
// THE SHAPE THAT MATTERS: SHADOW, DON'T OPT IN. Callers bind the returned function to the *name*
// `mkdtempSync` and drop `mkdtempSync` from their `node:fs` import list:
//
//     import { trackedMkdtempSync } from './test-helpers/tracked-tmpdir.mjs';
//     const mkdtempSync = trackedMkdtempSync();
//
// Every pre-existing call site is then captured automatically, with no per-site edit and no way for
// a NEW call site to silently escape tracking — the raw `node:fs` symbol is no longer in scope at
// all. An opt-in wrapper alongside a live raw import is what let two sites leak; this shape makes
// that unrepresentable.
//
// The sweep runs in ONE `node:test` `after()` hook (registered at construction), each removal in its
// own try/catch: on Windows a temp dir can still be locked by an AV scanner or a just-exited child
// process, and a cleanup failure must never turn a green suite red — leaking one dir is strictly
// better than a false test failure.
import { after } from 'node:test';
import { mkdtempSync as fsMkdtempSync, rmSync as fsRmSync } from 'node:fs';

// `_mkdtempSync` / `_rmSync` / `_after` are injectable purely so this helper is itself unit-testable
// (see install-lock.test.mjs) without creating real directories or registering a real hook.
export function trackedMkdtempSync({
  _mkdtempSync = fsMkdtempSync,
  _rmSync = fsRmSync,
  _after = after,
} = {}) {
  const created = [];

  const tracked = (prefix) => {
    const dir = _mkdtempSync(prefix);
    created.push(dir);
    return dir;
  };

  // Exposed for the helper's own tests; production callers only ever call `tracked(prefix)`.
  tracked.created = created;
  tracked.sweep = () => {
    // Splice as we go so a second sweep (defensive — a suite could call it explicitly) is a no-op
    // rather than re-attempting removals that already succeeded.
    while (created.length > 0) {
      const dir = created.pop();
      try {
        _rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort: a locked or already-gone dir must never fail the suite */
      }
    }
  };

  _after(() => tracked.sweep());
  return tracked;
}
