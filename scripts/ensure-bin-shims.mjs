#!/usr/bin/env node
// scripts/ensure-bin-shims.mjs — reader-side `.bin` shim preflight (plan 1874, the plan-1869
// READER axis).
//
// WHY: every `pnpm install` — even a no-op — rewrites ALL of `node_modules/.bin`'s shims in
// place, so a gate that shells out to a shim (`pnpm exec lint-staged` in .husky/pre-commit,
// `pnpm exec prettier` in .husky/pre-push) mid-rewrite dies "not recognized" even when exactly
// one, perfectly legitimate install is running. Plan 1869 serialized install-vs-install
// (writer/writer) via the root-keyed install lock; this helper closes the reader axis WITHOUT a
// lock: a reader that finds a shim missing (1) checks whether an install currently HOLDS the
// install lock for this root and, if so, waits it out bounded and re-probes; (2) absorbs the
// lock-release micro-race with short-backoff re-probes; (3) only when the shim is missing with
// NO install running does it fail — deterministically, with the one-line heal (the fold of plan
// 1881 step 3: three sessions re-derived "run install-main.mjs" from the raw "not recognized"
// on 2026-07-15). The RW-lock alternative was priced and rejected at the plan-1874 pickup
// re-spec: it adds a writer-starvation axis on the hottest gate surface and its only extra
// coverage is rule-breaking bare installs that would not take a read side either (and the 2198
// verdict traced the DESTRUCTIVE tears to teardown retry storms, not concurrent installs).
//
// FAIL-OPEN CONTRACT (the test-queue.mjs FAIL-OPEN INVARIANT, restated for this seat): this
// machinery may never wedge a commit or push.
//   - exit 0  — shims present (possibly after waiting), OR the bounded lock-wait timed out
//               (warn + proceed: the gate then speaks for itself).
//   - exit 2  — DELIBERATE block: shim(s) persistently missing, no live install, backoff
//               exhausted. The heal line has been printed. Strictly better than the raw
//               "not recognized" death the gate would die seconds later anyway.
//   - anything else (crash, bad flag) — callers in the hooks treat as fail-open and proceed.
// Hook call sites therefore branch ONLY on exit 2 (`cmd || S=$?; [ "$S" = 2 ] && exit 1`).
//
// Fast path is pure stats: the lock path (one `git rev-parse` spawn inside install-lock's
// resolveLockPath) is only ever resolved AFTER a shim probe has failed.
//
// Usage: node scripts/ensure-bin-shims.mjs <shim...> [--root <path>] [--wait-sec 900]
// Test seams: ENSURE_BIN_BACKOFFS_MS ("250 750" default) and install-lock's INSTALL_LOCK_DIR.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sleepSync } from './coord/coord-git.mjs';
import { resolveLockPath, readEntry, isStale, safeCwd } from './coord/install-lock.mjs';
// The ONE main-vs-worktree discriminator (git-based, absolute-git-dir vs git-common-dir) — review
// finding: this file briefly carried its own weaker `.git`-is-a-directory heuristic under the same
// name, which would silently drift from the canonical check. Canonical never throws (errs → true,
// i.e. toward the install-main advice) and is only reached on the rare heal-line path.
import { isMainCheckout } from './coord/check-coordination-branch.mjs';

export const EXIT_TEAR = 2;
export const DEFAULT_WAIT_SEC = 900; // matches install-lock's own queue-wait ceiling
const POLL_MS = 2000;
const DEFAULT_BACKOFFS_MS = [250, 750];

// pnpm on Windows writes `<name>`, `<name>.CMD`, `<name>.ps1` side by side; POSIX just `<name>`.
// A shim counts as PRESENT when any form exists — the observed failure signature (the in-place
// rewrite / the wipe) removes all forms together, so probing "any" never false-passes a real tear.
export function shimPresent(root, name) {
  const bin = join(root, 'node_modules', '.bin');
  return ['', '.cmd', '.CMD', '.ps1'].some((ext) => existsSync(join(bin, `${name}${ext}`)));
}

export function missingShims(root, names) {
  return names.filter((n) => !shimPresent(root, n));
}

export function healLine(root, missing, _isMainCheckout = isMainCheckout) {
  const list = missing.join(', ');
  return _isMainCheckout(root)
    ? `ensure-bin-shims: node_modules/.bin is missing [${list}] with NO install running — torn store. ` +
        `Heal: \`node scripts/install-main.mjs\` (>=600s timeout; NEVER a bare \`pnpm install\` on the ` +
        `main checkout, and never --no-verify). Full rule: docs/runbooks/branch-hygiene.md § The THIRD lock.`
    : `ensure-bin-shims: node_modules/.bin is missing [${list}] — this worktree has no (or a torn) ` +
        `node_modules. Heal: \`pnpm install\` in this worktree (lock-free; >=600s timeout).`;
}

// Core decision loop, dependency-injected for tests. Returns the process exit code.
export function ensureShims({
  root,
  names,
  waitSec = DEFAULT_WAIT_SEC,
  backoffsMs = DEFAULT_BACKOFFS_MS,
  log = (m) => console.error(m),
  _now = Date.now,
  _sleep = sleepSync,
  _resolveLockPath = resolveLockPath,
  _readEntry = readEntry,
}) {
  let missing = missingShims(root, names);
  if (missing.length === 0) return 0;

  // Resolve the lock path lazily (one git spawn) — only reached when something is missing. A
  // resolution failure is fail-open: we can't tell whether an install is running, so degrade to
  // the backoff probes below rather than blocking or crashing.
  let lockPath = null;
  try {
    lockPath = _resolveLockPath({ root });
  } catch (e) {
    log(
      `ensure-bin-shims: cannot resolve the install lock (${e.message}) — skipping the wait, probing with backoff only`,
    );
  }

  if (lockPath) {
    const deadline = _now() + waitSec * 1000;
    let announced = false;
    for (;;) {
      const entry = _readEntry(lockPath); // undefined = free, null = corrupt (treated stale/free)
      const held = entry !== undefined && !isStale(entry, _now());
      if (!held) break;
      if (_now() >= deadline) {
        // FAIL-OPEN: an install outliving the full wait is install-lock's own staleness problem,
        // not a reason to wedge this commit/push — proceed and let the gate speak for itself.
        log(
          `ensure-bin-shims: still missing [${missing.join(', ')}] after waiting ${waitSec}s on a live install — proceeding (fail-open)`,
        );
        return 0;
      }
      if (!announced) {
        log(
          `ensure-bin-shims: [${missing.join(', ')}] missing while an install holds the lock — waiting for it to finish (the plan-1874 reader retry)`,
        );
        announced = true;
      }
      _sleep(POLL_MS);
      missing = missingShims(root, names);
      if (missing.length === 0) {
        log('ensure-bin-shims: shims reappeared — the install rewrote .bin; continuing');
        return 0;
      }
    }
  }

  // Lock free (or unresolvable): absorb the release micro-race, then decide. Defensive finite
  // clamp (review finding): sleepSync rides Atomics.wait, where a NaN timeout coerces to
  // +Infinity — a single malformed backoff must degrade to a 0ms probe, never an eternal hang
  // (the FAIL-OPEN contract outranks surfacing a caller bug here; parseBackoffs already rejects
  // malformed CLI/env input loudly before this is ever reached from the CLI).
  for (const ms of backoffsMs) {
    _sleep(Number.isFinite(ms) && ms >= 0 ? ms : 0);
    missing = missingShims(root, names);
    if (missing.length === 0) return 0;
  }
  log(healLine(root, missing));
  return EXIT_TEAR;
}

// Parse ENSURE_BIN_BACKOFFS_MS ("250 750"-style). A malformed token (NaN / negative) is a caller
// bug that must surface loudly (exit 1 = fail-open for hook callers, which branch only on exit 2)
// — never reach sleepSync, whose Atomics.wait coerces a NaN timeout to +Infinity (review finding:
// the unvalidated parse turned a typo'd backoff into an unkillable hook hang).
export function parseBackoffs(env) {
  if (!env) return DEFAULT_BACKOFFS_MS;
  const parsed = env.split(/\s+/).filter(Boolean).map(Number);
  if (parsed.length === 0 || parsed.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`bad ENSURE_BIN_BACKOFFS_MS "${env}" — space-separated non-negative ms only`);
  }
  return parsed;
}

function main() {
  const args = process.argv.slice(2);
  const names = [];
  let root = null;
  let waitSec = DEFAULT_WAIT_SEC;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root') root = args[++i];
    else if (a === '--wait-sec') waitSec = Number(args[++i]);
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else names.push(a);
  }
  if (names.length === 0) throw new Error('no shim names given');
  if (!Number.isFinite(waitSec) || waitSec < 0) throw new Error(`bad --wait-sec`);
  const backoffsMs = parseBackoffs(process.env.ENSURE_BIN_BACKOFFS_MS);
  return ensureShims({ root: resolve(root ?? safeCwd()), names, waitSec, backoffsMs });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    // A crash is the fail-open path for hook callers (they only block on EXIT_TEAR) — but say why.
    console.error('ensure-bin-shims:', e.message);
    process.exit(1);
  }
}
