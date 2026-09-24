#!/usr/bin/env node
// scripts/coord/excl-lock.mjs — the shared O_EXCL lockfile MECHANISM behind
// `landing-lock.mjs` and `battery-lock.mjs` (plan 1678).
//
// WHY: both locks independently hand-rolled the same low-level algorithm —
// atomic `openSync(path, 'wx')` create, and a rename-then-unlink reap that
// keeps two racing reapers from both winning (a naive unlink+create lets a
// second reaper delete the FRESH lock a first reaper's recreate just wrote).
// Only `sleepSync` was shared before this (via `coord-git.mjs`). A hardening
// applied to one file's copy silently left the other on the old behaviour —
// found by /sonnet-review xhigh on plan 1673 (finding [0]).
//
// SCOPE — deliberately narrow (plan 1678 constraint 1): this is ONLY the
// file-level acquire/reap/release primitive. It knows nothing about:
//   - what staleness ceiling applies (battery-lock: 60 min; landing-lock: 35
//     min for its holder entries, 60s for its own meta-mutex) — the caller
//     decides staleness and only calls reapStaleExclusive once it has.
//   - single-holder vs multi-holder registry semantics (battery-lock's token
//     lock vs landing-lock's scoped registry behind a meta-mutex).
//   - the payload SHAPE (JSON entry vs a bare pid string) — payload is an
//     already-serialized string; this module never parses it.
// landing-lock's `registryVerdict` (scoped multi-holder contention) and
// battery-lock's exit-code/token-ownership contract are NOT here and must
// never move here — see each file's own header for why.
//
// CROSS-REPO DEPENDENCY ORDERING (plan 1678 constraint 2, spec-pass home
// decision): this is a NEW `coordShare` member, not folded into `coord-git.mjs`
// — `landing-lock.mjs` is byte-identical-synced to tandapp, and a new import
// it takes on must be adopted by the sibling FIRST (or in the same beat), per
// `docs/runbooks/coord-sharing.md`'s dependency-ordering rule. `coord.config.json`
// adds this file to tandapp's `adopt` list in the SAME commit that lands it here.
// battery-lock is vetapp-only, so it stays a plain (non-adopted) canonical file.

import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  existsSync,
  unlinkSync,
  renameSync,
} from 'node:fs';

// Try once to atomically create `path` containing `contents` (an
// already-serialized string — this module never parses or shapes the
// payload). Returns true on success, false when the path already exists
// (EEXIST) — the one universal "someone else already holds it" signal every
// O_EXCL lock in this repo relies on. Any other fs error propagates.
export function tryCreateExclusive(path, contents) {
  let fd;
  try {
    fd = openSync(path, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  return true;
}

// Read `path`'s raw text. undefined = free — never existed, or vanished
// between the existence check and the read (ENOENT: another process's
// release/reap raced us) — distinct from a present-but-unparseable file,
// which callers parse themselves and treat as corrupt (each lock's own
// "corrupt ⇒ reapable" policy lives in the caller, not here).
//
// Any OTHER read error (EACCES/EBUSY/EPERM — e.g. an AV/sync tool mid-scan,
// per corruption-guard.mjs's own documented case) propagates as a thrown
// exception rather than being folded into "free". Both callers already have
// the right opposite fail-safe for this at their own boundary: landing-lock's
// CLI wrapper turns an uncaught throw into exit 5 (fail CLOSED — never a
// false ACQUIRE that could race two overlapping 🟥 seed lands); battery-lock's
// CLI wrapper does the same, and `.husky/pre-push` already treats ANY
// non-zero battery-lock acquire exit (TIMEOUT=4 or error=5) as "run the
// battery UNSERIALIZED" — so a thrown read error there degrades to
// unserialized, never a skipped test and never a wedged push. Silently
// mapping a transient read failure on an EXISTING, holder-populated lock to
// "free" is precisely the regression this distinction closes (found by
// /sonnet-review xhigh on plan 1678, finding [0]).
export function readExclusive(path) {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined; // vanished between existsSync and read — free
    throw e;
  }
}

// Reap a stale lock/mutex by RENAMING it to a unique target first, then
// unlinking that target. Two racing reapers cannot both win: renameSync to a
// per-reaper unique name either moves the one inode away (this reaper won) or
// fails ENOENT (a rival already moved it, or it was released underneath us —
// either way, just retry the caller's acquire). A naive unlink+create lets
// BOTH reapers unlink — the second deleting the FRESH lock the first just
// recreated, which is precisely the double-reap race this function closes for
// every caller (battery-lock's single-holder lock AND landing-lock's registry
// meta-mutex, both re-expressed on this same function — see plan 1678).
// Returns true iff THIS call performed the reap.
export function reapStaleExclusive(path, reaperTag) {
  const parked = `${path}.reap-${reaperTag}`;
  try {
    renameSync(path, parked);
  } catch {
    return false;
  }
  try {
    unlinkSync(parked);
  } catch {
    /* best-effort: the parked copy is inert and uniquely named; it never blocks a later acquire */
  }
  return true;
}

// Release `path` only when `predicate(text)` returns true against its
// current raw contents (`text` is undefined when the file is already gone —
// a caller whose predicate must special-case "vanished ⇒ not mine" does so
// itself; the common case, a caller passing `force: true` through its own
// predicate, treats "gone" the same as "mine" by design).
// Returns:
//   'RELEASED' — this call unlinked it.
//   'NOOP'     — already gone (idempotent close-out — never treat as an error).
//   'FOREIGN'  — the predicate rejected the current holder; the caller must
//                NOT act on it (surface to the operator, never auto-override).
export function releaseOwned(path, predicate) {
  const text = readExclusive(path);
  if (text === undefined) return 'NOOP';
  if (!predicate(text)) return 'FOREIGN';
  try {
    unlinkSync(path);
  } catch {
    return 'NOOP'; // raced a reaper/release underneath us — gone either way
  }
  return 'RELEASED';
}
