#!/usr/bin/env node
// scripts/git-maintenance-guard.mjs — the guard for machine-global git maintenance on the
// SHARED main checkout (plan 2398).
//
// WHY THIS EXISTS, AND WHY IT IS SMALL. The shared `.git` is the object store every
// `.claude/worktrees/*` linked worktree reads and writes (that IS a linked worktree:
// git-dir != git-common-dir, common-dir is MAIN's `.git`). Every other machine-global
// operation here is serialized by a named lock — the landing mutex, the battery-lock, the
// test queue, the install mutex, per-plan claim refs — but `git gc` / `repack` / `prune`
// had none. Plan 2361 Task 0 specifies a `git gc` on this checkout as a routine prerequisite
// and is `loop: afk`, i.e. an unattended drain worker is the intended executor.
//
// THE VERDICT (plan 2398 item 1 — measured on git 2.43.0, not asserted). Concurrent `git gc`
// AT ITS DEFAULTS is SAFE for every operation this repo performs: a linked worktree's detached
// HEAD and its index are both gc roots, `refs/claims/*` survive pack-refs, reflogs are roots, a
// live worktree's admin dir is never pruned (and `worktree add` holds a `locked` marker the
// pruner skips), and gc-vs-gc is hard-locked by `gc.pid`. The evidence table lives in ONE
// place — docs/runbooks/branch-hygiene.md § Machine-global git maintenance — not here.
//
//   ONE thing is genuinely unsafe, and it is repo-specific: an IMMEDIATE prune
//   (`--prune=now`, bare `git prune`, `-c gc.pruneExpire=now`) deletes a loose object that
//   no ref, index or HEAD points at YET. This repo enters exactly that window on every
//   coordination write: `claim-plan.mjs` (plan claims + the session counter),
//   `spec-sweep-lock.mjs`, and `usage-broadcast.mjs` all build an object with
//   `git commit-tree`/`hash-object` and only THEN `git push` it to a `refs/claims/*` /
//   `refs/coord/*` ref. Between those two steps the object is unreferenced locally and an
//   immediate prune deletes it — the push then fails, or pushes a ref whose object is gone.
//   At the default 2-week expiry the same object survives untouched (mtime grace).
//
// So this guard deliberately does ONE thing: it refuses an IMMEDIATE-PRUNE maintenance
// command while other sessions may be live, and waves everything else straight through.
// `git gc`, `git repack`, `git gc --aggressive` (that flag is repack DEPTH, not a prune
// axis), `pack-refs`, `fsck` are never blocked — building ceremony around a non-risk was
// explicitly out of scope.
//
// USAGE
//   node scripts/git-maintenance-guard.mjs run   -- git gc              # check, then run it
//   node scripts/git-maintenance-guard.mjs check -- git gc --prune=now  # verdict only
//   node scripts/git-maintenance-guard.mjs probe                        # liveness read only
//   …plus --json on any of the three.
// Exit codes: 0 = allowed (and, for `run`, the command's own exit code), 1 = REFUSED,
// 2 = usage error / unrecognized command (never a silent pass).
// Escape hatch: GIT_MAINTENANCE_GUARD_OVERRIDE=1 — allows with a loud OVERRIDDEN line.
//
// The liveness read REUSES `scripts/push-queue-status.mjs --json` (plan 1795) rather than
// rolling a second process-counting mechanism: that probe already aggregates the battery
// lock, the machine-global test queue, and the live push-machinery process scan, and is
// contractually read-only + always-exit-0. We add exactly one signal it does not have —
// the registered linked worktrees, i.e. "how many sessions have a checkout here".

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseFlags } from './parse-flags.mjs';
import { parseWorktreePorcelain } from './worktree-porcelain.mjs';

// --- classification (pure) ---------------------------------------------------

// The maintenance verbs this guard knows. Anything else is an authoring error, not a pass:
// a typo'd verb must never read as "safe".
export const MAINTENANCE_OPS = new Set([
  'gc',
  'prune',
  'prune-packed',
  'repack',
  'pack-refs',
  'fsck',
  'maintenance',
  'reflog',
]);

// The two literal spellings that always mean "right now", answerable without asking git —
// the fast path, and the fallback when no resolver is available. `never` is the SAFE extreme
// (prune nothing).
// `git <flag> <value> <verb>` — the value is a separate token and must be consumed WITH the
// flag, so it is never mistaken for the maintenance verb.
// Exported (plan-2734 review round 6): push-queue-status.mjs parses `git push` command lines from
// the process scan and needs the SAME table — a second hand-maintained copy there was already
// missing --config-env and --super-prefix, and a global option whose value is mistaken for the
// subcommand makes that probe report a live push as `other`.
export const GLOBAL_VALUE_FLAGS = new Set([
  '-C',
  // `-c <key>=<value>`. REDUNDANT for this file's own loop, which consumes `-c` earlier because it
  // needs the VALUE (a leading `-c gc.pruneExpire=now` is the hazard it exists to catch) — listed
  // here for the OTHER consumers of this table, which only need to skip the pair. push-queue-status
  // was reading `foo.bar=baz` as the subcommand of `git -c foo.bar=baz push …` (plan-2734 r6).
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
  '--config-env',
]);

const IMMEDIATE_LITERALS = new Set(['now', 'all']);
const NEVER_LITERALS = new Set(['never']);

// How close to "now" a resolved expiry has to be to count as immediate. A value inside this
// window leaves no meaningful mtime grace for the sub-second commit-tree→push window this
// guard protects; `2.weeks.ago` (git's default) is four orders of magnitude outside it.
export const IMMEDIATE_WINDOW_S = 3600;

/**
 * Resolve a git expiry spelling to an epoch-seconds cutoff by asking GIT, not by matching
 * strings. `--prune=0.seconds.ago` is `--prune=now` with a different name, and enumerating
 * approxidate's spellings is a losing game (verified: `0.seconds.ago` deletes a fresh object
 * exactly as `now` does). `git rev-parse --since=<v>` prints `--max-age=<epoch>`.
 *
 * Returns `null` when git could not be asked at all (not a repo, git missing) — the caller
 * treats that as IMMEDIATE, i.e. fails closed.
 *
 * Note: approxidate falls back to NOW for an unparseable value, so a typo'd expiry resolves
 * as immediate and gets refused. That is the right false-positive direction — `git gc` itself
 * aborts on such a value (`fatal: failed to parse prune expiry value`), so nothing is lost.
 */
export function resolveExpiryEpoch(value, { _exec = execFileSync, cwd = process.cwd() } = {}) {
  try {
    const out = _exec('git', ['rev-parse', `--since=${value}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = /--max-age=(\d+)/.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Classify a git maintenance command line.
 *
 * @param {string[]} argv  the command tokens, with or without a leading `git`
 * @param {object} [opts]
 * @param {(v:string)=>number|null} [opts._resolveExpiry]  seam for the git-backed date resolver
 * @param {number} [opts._nowS]  seam for "now" in epoch seconds
 * @returns {{recognized:boolean, op:string|null, aggressive:boolean, reasons:string[]}}
 */
export function classifyMaintenance(argv, opts = {}) {
  const { _resolveExpiry = (v) => resolveExpiryEpoch(v), _nowS = Math.floor(Date.now() / 1000) } =
    opts;

  // One classification can ask about the same expiry twice (gc.reflogExpire and
  // gc.reflogExpireUnreachable set to the same value), and the resolver spawns a git child —
  // memoize per call. `undefined` is a legitimate cached answer, hence the `has` check.
  const resolved = new Map();
  const resolveOnce = (v) => {
    if (!resolved.has(v)) resolved.set(v, _resolveExpiry(v));
    return resolved.get(v);
  };

  const isImmediate = (v) => {
    if (typeof v !== 'string') return false;
    const t = v.trim().toLowerCase();
    if (t === '') return false;
    if (IMMEDIATE_LITERALS.has(t)) return true;
    if (NEVER_LITERALS.has(t)) return false;
    const epoch = resolveOnce(v);
    // Unresolvable ⇒ fail closed: an expiry we cannot evaluate is not proof of a safe one.
    return epoch === null || epoch >= _nowS - IMMEDIATE_WINDOW_S;
  };

  const toks = (argv ?? []).map(String).filter((t) => t !== '');
  let i = 0;
  if (toks[i] === 'git') i++;

  // Leading `-c key=value` / `--config-env`-style pairs must be read BEFORE the verb: a
  // `-c gc.pruneExpire=now` in front of a plain `git gc` is the same hazard as `--prune=now`
  // spelled on the verb, and reading only the verb's own flags would wave it through.
  const configs = [];
  while (i < toks.length) {
    if (toks[i] === '-c' && i + 1 < toks.length) {
      configs.push(toks[i + 1]);
      i += 2;
      continue;
    }
    if (toks[i].startsWith('-c') && toks[i].length > 2) {
      configs.push(toks[i].slice(2));
      i += 1;
      continue;
    }
    // Global options that take a SEPARATE-token value: consume both, or the value is read as
    // the verb and a perfectly safe `git -C /some/checkout gc` is refused as "not a maintenance
    // verb". The `=`-joined spellings need no special case — they are a single token.
    if (GLOBAL_VALUE_FLAGS.has(toks[i]) && i + 1 < toks.length) {
      i += 2;
      continue;
    }
    if (toks[i].startsWith('-')) {
      i += 1; // a valueless global (--no-pager, --paginate, --bare); irrelevant here
      continue;
    }
    break;
  }

  const op = toks[i] ?? null;
  if (!op || !MAINTENANCE_OPS.has(op)) {
    return { recognized: false, op, aggressive: false, reasons: [] };
  }
  const rest = toks.slice(i + 1);
  const reasons = [];

  // LAST occurrence wins, for both `-c` and flags — that is git's own rule, verified:
  // `git gc --prune=never --prune=now` DELETES a fresh object and `--prune=now --prune=never`
  // spares it. A first-match read would call the first of those safe and wave through exactly
  // the command this guard exists to catch.
  const cfg = (key) => {
    const k = `${key.toLowerCase()}=`;
    const hits = configs.filter((c) => c.toLowerCase().startsWith(k));
    return hits.length ? hits[hits.length - 1].slice(k.length) : undefined;
  };

  // `joinedOnly` distinguishes git's two flag shapes, and the distinction is load-bearing:
  //   - `gc --prune[=<date>]` takes an OPTIONAL argument, so only the `=`-joined form supplies
  //     a value. Real `git gc --prune now` is a usage error (exit 129, "unknown option") and
  //     never runs — reading `now` as its value would REFUSE a command git already rejects.
  //   - `prune --expire <date>` / `reflog expire --expire <date>` take a REQUIRED argument, so
  //     the separate-token form is valid there and must be read.
  const flagValue = (name, { joinedOnly = false } = {}) => {
    let found;
    for (let k = 0; k < rest.length; k++) {
      if (rest[k].startsWith(`${name}=`)) found = rest[k].slice(name.length + 1);
      else if (!joinedOnly && rest[k] === name) found = rest[k + 1] ?? '';
      else if (joinedOnly && rest[k] === name) found = ''; // bare `--prune` ⇒ configured expiry
    }
    return found;
  };
  const hasBare = (name) => rest.includes(name);

  // The `-c` config axis applies to `gc` AND to `maintenance` — verified: `git -c
  // gc.pruneExpire=now maintenance run --task=gc` deletes a fresh object exactly as
  // `gc --prune=now` does. `maintenance` was in MAINTENANCE_OPS but had no branch, so it
  // classified as safe unconditionally.
  const configDrivenPrune = op === 'gc' || op === 'maintenance';

  if (configDrivenPrune) {
    if (isImmediate(cfg('gc.pruneExpire')))
      reasons.push(
        `\`-c gc.pruneExpire=<now>\` is \`--prune=now\` by another name (drives \`git ${op}\`)`,
      );
    // Expiring unreachable reflog entries turns reflog-only objects (an amend/rewind safety
    // net every parallel session relies on) into prune candidates in the same run.
    if (isImmediate(cfg('gc.reflogExpireUnreachable')) || isImmediate(cfg('gc.reflogExpire')))
      reasons.push('immediate reflog expiry drops the reflog root that protects amended commits');
  }

  if (op === 'gc') {
    // Bare `--prune` (no `=`) means "the configured expiry" (2 weeks by default) — safe.
    // Only an explicit immediate value is the hazard.
    const prune = flagValue('--prune', { joinedOnly: true });
    if (isImmediate(prune)) reasons.push('`--prune=<now>` deletes loose objects regardless of age');
    // --force defeats the gc.pid mutex, the ONE lock git gives us for free (a second gc
    // otherwise dies `fatal: gc is already running on machine … pid …`).
    if (hasBare('--force') || hasBare('-f'))
      reasons.push('`--force` bypasses the gc.pid lock, the only gc-vs-gc mutex git provides');
  } else if (op === 'prune') {
    // BARE `git prune` is the trap: with no --expire it prunes EVERY unreachable loose
    // object regardless of age — i.e. it is `--prune=now` by default, unlike `git gc`.
    const expire = flagValue('--expire');
    if (expire === undefined)
      reasons.push('bare `git prune` has NO mtime grace — it expires every unreachable object');
    else if (isImmediate(expire))
      reasons.push('`--expire=<now>` deletes loose objects regardless of age');
  } else if (op === 'reflog') {
    if (rest[0] === 'expire') {
      if (isImmediate(flagValue('--expire-unreachable')) || isImmediate(flagValue('--expire')))
        reasons.push('immediate reflog expiry drops the reflog root that protects amended commits');
    }
  }
  // repack / prune-packed / pack-refs / fsck carry no prune-expiry axis: they rewrite or verify
  // packs and refs, and every one of those is a reachability-preserving operation. Deliberately
  // never blocked.

  return { recognized: true, op, aggressive: reasons.length > 0, reasons };
}

// --- liveness (pure core + injectable reads) ---------------------------------

/**
 * The linked worktrees registered on this shared `.git` — i.e. "how many sessions have a
 * checkout here". The MAIN checkout is `git worktree list`'s FIRST record and is dropped: it
 * is this invocation's own repo, not another session.
 *
 * A `prunable`-flagged registration is KEPT and flagged, not filtered out. cloud-checkout-
 * preflight.mjs's guard 4 does drop them, and for its live-session COUNT that is right — but
 * this guard's job is to fail closed, and `prunable` is not proof of death: git raises it
 * whenever the gitdir file is momentarily unreadable (a slow mount, a symlink race, a directory
 * being recreated), which a LIVE session can hit. Refusing on a husk costs one `git worktree
 * prune` — the refusal message names the husks and says exactly that; allowing on a live
 * session costs a lost coord object. So we take the cheap error, and deliberately do NOT share
 * guard 4's filter.
 *
 * Parsing goes through `parseWorktreePorcelain` (scripts/coord/worktree-porcelain.mjs, plan 2058 —
 * THE one porcelain block parser, already shared by land-lib and cloud-checkout-preflight).
 * A second hand-rolled parser here is exactly the drift plan 2058 extracted it to prevent:
 * its block separator (`\n\s*\n+`) tolerates a whitespace-only blank line, and a stricter
 * split silently merges blocks and loses every entry after the first.
 */
export function parseLinkedWorktrees(porcelain) {
  return parseWorktreePorcelain(porcelain)
    .slice(1)
    .map((w) => ({
      path: w.path,
      branch: w.branch || '(detached)',
      prunable: Boolean(w.prunable),
    }));
}

/**
 * Fold the two reads into one liveness picture.
 *
 * `strong` = the push-queue probe says the machine is BUSY (a held battery lock, queued
 * heavy tests, or live push machinery) — hard evidence another session is mid-operation.
 * `weak`   = linked worktrees are registered. A registered worktree is a checkout, not
 * necessarily a running process, so on its own it is a proxy — but it is the proxy that
 * matches the hazard (a session with a checkout here is a session that runs claim-plan).
 */
export function summarizeLiveness({ worktrees, probe, probeError = null, worktreeError = null }) {
  const strongSignals = [];
  if (probe?.busy) {
    if (probe.battery?.state === 'held')
      strongSignals.push(`battery-lock held by ${probe.battery.holder}`);
    const held = probe.testQueue?.holders?.length ?? 0;
    const waiting = probe.testQueue?.waiting?.length ?? 0;
    if (held || waiting) strongSignals.push(`test-queue ${held} holding / ${waiting} waiting`);
    const p = probe.processes;
    if (p && (p.prePushHooks || p.landTestRuns || p.nodeTestRunners))
      strongSignals.push(
        `live push machinery (${p.prePushHooks} pre-push, ${p.landTestRuns} run-land-tests, ${p.nodeTestRunners} node --test)`,
      );
    if (!strongSignals.length) strongSignals.push('push-queue probe reports BUSY');
  }
  return {
    worktrees,
    worktreeCount: worktrees.length,
    strongSignals,
    strong: strongSignals.length > 0,
    weak: worktrees.length > 0,
    // The Windows CIM scan is the read most likely to be unavailable (it is null off-Windows
    // and on any scan failure), and a QUIET read without it is weaker evidence — say so
    // rather than letting silence read as proof of an idle machine.
    processScanAvailable: Boolean(probe?.processes),
    probeError,
    worktreeError,
    // A read that FAILED is not a read that came back empty. If either liveness read errored,
    // "quiet" is unproven — and for an immediate prune the guard must fail CLOSED (an
    // unreadable probe is not permission to prune). `weak`/`strong` deliberately stay false so
    // the SAFE commands are still waved through unchanged; only the aggressive branch consults
    // this flag.
    unproven: Boolean(probeError || worktreeError),
  };
}

// The stand-in a SAFE command is judged against — main() deliberately skips the liveness read
// for those (see its lazy note). DERIVED from summarizeLiveness so it can never drift from the
// real shape, and marked `skipped: true` so a `--json` consumer can tell "we did not look" from
// "we looked and the machine was quiet" — the two are very different claims.
export const EMPTY_LIVENESS = Object.freeze({
  ...summarizeLiveness({ worktrees: [], probe: null }),
  probeError: null,
  skipped: true,
});

/**
 * The allow/refuse decision.
 *
 * @returns {{allow:boolean, code:number, lines:string[]}}
 */
export function verdict({ classification, liveness, override = false }) {
  const lines = [];
  if (!classification.recognized) {
    return {
      allow: false,
      code: 2,
      lines: [
        `git-maintenance-guard: "${classification.op ?? '(nothing)'}" is not a git maintenance verb ` +
          `(known: ${[...MAINTENANCE_OPS].sort().join(', ')}). Refusing rather than guessing.`,
      ],
    };
  }

  if (!classification.aggressive) {
    lines.push(
      `ALLOWED: \`git ${classification.op}\` at these options carries no immediate-prune axis — ` +
        `plan 2398 measured concurrent gc/repack SAFE against every operation this repo performs.`,
    );
    // Deliberately says nothing about liveness: a safe command is allowed on a busy machine
    // exactly as on a quiet one, and main() skips the (non-trivial) liveness read entirely for
    // it. Run `probe` if you want the liveness picture.
    return { allow: true, code: 0, lines };
  }

  for (const r of classification.reasons) lines.push(`IMMEDIATE-PRUNE: ${r}`);

  if (override) {
    lines.push(
      'OVERRIDDEN: GIT_MAINTENANCE_GUARD_OVERRIDE=1 is set — running anyway. Be sure no other ' +
        'session is mid-`claim-plan`/`spec-sweep-lock`/`usage-broadcast` (each has a window where a ' +
        'fresh object is referenced by nothing local).',
    );
    return { allow: true, code: 0, lines };
  }

  if (liveness.strong) {
    lines.push(
      `REFUSED: other sessions are LIVE on this checkout — ${liveness.strongSignals.join('; ')}.`,
    );
  } else if (liveness.weak) {
    const husks = liveness.worktrees.filter((w) => w.prunable);
    lines.push(
      `REFUSED: ${liveness.worktreeCount} linked worktree(s) are registered on this shared .git ` +
        `(${liveness.worktrees.map((w) => `${w.branch}${w.prunable ? ' [prunable]' : ''}`).join(', ')}). ` +
        `No live push machinery was detected, so this is the WEAKER signal — but a registered ` +
        `worktree is a session that runs claim-plan, and that is exactly the window an immediate ` +
        `prune breaks.`,
    );
    // A `prunable` entry may be a dead session's husk — or a live one whose gitdir was
    // momentarily unreadable. We refuse either way (fail closed), but name the cheap remedy so
    // a genuinely stale registration does not block immediate prunes forever.
    if (husks.length)
      lines.push(
        `  ${husks.length} of those are flagged \`prunable\` (${husks.map((w) => w.path).join(', ')}). ` +
          `If those sessions really are gone, \`git worktree prune\` clears them and this refusal ` +
          `with them; they are counted because \`prunable\` also fires on a momentarily unreadable ` +
          `gitdir, which a LIVE session can hit.`,
      );
  } else if (liveness.unproven) {
    // FAIL CLOSED. Both liveness axes came back empty, but at least one of them ERRORED rather
    // than reporting — so "the machine is quiet" is unproven, and an unreadable probe must
    // never read as permission to run the one destructive command this guard exists for.
    // git's stderr is multi-line; flatten it so the refusal stays one scannable line.
    const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
    lines.push(
      'REFUSED: the liveness read FAILED, so a quiet machine is unproven — ' +
        [
          liveness.probeError && `push-queue probe: ${flat(liveness.probeError)}`,
          liveness.worktreeError && `worktree list: ${flat(liveness.worktreeError)}`,
        ]
          .filter(Boolean)
          .join('; ') +
        '. An unreadable probe is not permission to prune.',
    );
  } else {
    lines.push(
      'ALLOWED: no linked worktrees registered and no live push machinery — the machine looks quiet.',
    );
    if (!liveness.processScanAvailable)
      lines.push(
        '  CAVEAT: the process scan was unavailable (non-Windows, or the scan failed), so this ' +
          'rests on the queue + worktree reads alone.',
      );
    return { allow: true, code: 0, lines };
  }

  lines.push(
    'Ways forward: (1) drop the immediate prune — plain `git gc` packs just as well and keeps the ' +
      '2-week mtime grace that protects a fresh coord object; (2) wait for the machine to go quiet ' +
      '(`node scripts/push-queue-status.mjs`, `node scripts/landing-queue.mjs`); (3) if you are certain ' +
      'no session is live, re-run with GIT_MAINTENANCE_GUARD_OVERRIDE=1.',
  );
  return { allow: false, code: 1, lines };
}

// --- impure reads -------------------------------------------------------------

// Returns the error rather than swallowing it: a FAILED read must not be indistinguishable
// from "no worktrees registered" — see summarizeLiveness's `unproven`.
export function readWorktrees({ _exec = execFileSync, cwd = process.cwd() } = {}) {
  try {
    return {
      worktrees: parseLinkedWorktrees(
        _exec('git', ['worktree', 'list', '--porcelain'], {
          cwd,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024, // many live worktrees can grow the porcelain past 1MB
        }),
      ),
      worktreeError: null,
    };
  } catch (e) {
    return { worktrees: [], worktreeError: e?.message ?? String(e) };
  }
}

// Shell out to the plan-1795 probe's own --json rather than duplicating its battery-lock /
// test-queue / CIM reads here. It is contractually read-only and always exit-0, so the only
// failure mode we handle is "the spawn itself did not produce JSON".
export function readPushQueueProbe({ _spawn = spawnSync, cwd = process.cwd() } = {}) {
  const cli = resolve(import.meta.dirname, 'push-queue-status.mjs');
  try {
    const r = _spawn(process.execPath, [cli, '--json'], {
      cwd,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const out = (r?.stdout ?? '').trim().split(/\r?\n/).pop() ?? '';
    return { probe: JSON.parse(out), probeError: null };
  } catch (e) {
    return { probe: null, probeError: e?.message ?? String(e) };
  }
}

// ONE seam-read shape for both liveness axes (fixture file if the flag is set, else the real
// read), so a change to the fixture contract cannot land on one axis and not the other — and
// so a fixture that fails to parse reports an error field exactly like a failed real read
// instead of crashing the guard.
function readAxis(fixturePath, { parse, empty, read, errorKey }) {
  if (!fixturePath) return read();
  try {
    return parse(readFileSync(fixturePath, 'utf8'));
  } catch (e) {
    return { ...empty, [errorKey]: e?.message ?? String(e) };
  }
}

function readLiveness(flags) {
  // Fixture seams, mirroring push-queue-status's --queue-dir/--lock-path convention: a test
  // must never read the machine's real queues, which other live sessions own.
  const { worktrees, worktreeError } = readAxis(flags['worktree-porcelain'], {
    parse: (raw) => ({ worktrees: parseLinkedWorktrees(raw), worktreeError: null }),
    empty: { worktrees: [] },
    read: readWorktrees,
    errorKey: 'worktreeError',
  });
  const { probe, probeError } = readAxis(flags['probe-json'], {
    parse: (raw) => ({ probe: JSON.parse(raw), probeError: null }),
    empty: { probe: null },
    read: readPushQueueProbe,
    errorKey: 'probeError',
  });
  return summarizeLiveness({ worktrees, probe, probeError, worktreeError });
}

export function main(argv = process.argv.slice(2)) {
  // Split on the `--` separator FIRST: everything after it is the guarded command verbatim,
  // and must never be parsed as this script's own flags (`git gc --prune=now` shares flag
  // shapes with nothing here, but `--force` would collide).
  const sep = argv.indexOf('--');
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const guarded = sep === -1 ? [] : argv.slice(sep + 1);

  const { cmd, flags } = parseFlags(own, {
    label: 'git-maintenance-guard',
    boolean: ['json'],
    value: ['probe-json', 'worktree-porcelain'],
    subcommand: true,
    positionals: false,
  });

  if (!cmd || !['check', 'run', 'probe'].includes(cmd)) {
    console.error(
      'git-maintenance-guard: usage — `check|run -- <git maintenance command>` or `probe` [--json]',
    );
    return 2;
  }

  // The liveness read is LAZY. It costs a `git worktree list` plus a whole child-Node run of
  // push-queue-status (which itself reads two lock files and, on Windows, does a CIM process
  // scan) — and a non-aggressive command's ALLOW verdict never consults it. So `run -- git gc`,
  // the overwhelmingly common invocation, now does zero of that work; only `probe` and an
  // actual immediate-prune classification pay for it.
  let livenessCache;
  const liveness = () => (livenessCache ??= readLiveness(flags));

  if (cmd === 'probe') {
    const l = liveness();
    if (flags.json) console.log(JSON.stringify(l));
    else {
      console.log(`linked worktrees: ${l.worktreeCount}`);
      for (const w of l.worktrees) console.log(`  ${w.branch}  ${w.path}`);
      console.log(
        l.strong
          ? `live machinery: ${l.strongSignals.join('; ')}`
          : 'live machinery: none detected',
      );
      if (l.probeError) console.log(`push-queue probe: UNAVAILABLE (${l.probeError})`);
      if (l.worktreeError) console.log(`worktree list: UNAVAILABLE (${l.worktreeError})`);
    }
    return 0;
  }

  if (!guarded.length) {
    console.error(
      `git-maintenance-guard: \`${cmd}\` needs the command after \`--\`, e.g. -- git gc`,
    );
    return 2;
  }

  const classification = classifyMaintenance(guarded);
  const override = process.env.GIT_MAINTENANCE_GUARD_OVERRIDE === '1';
  // Only an aggressive classification consults liveness — see the lazy-read note above. The
  // safe branch of verdict() reads nothing off it, so an empty picture is honest there.
  const l = classification.aggressive ? liveness() : EMPTY_LIVENESS;
  const v = verdict({ classification, liveness: l, override });

  if (flags.json) console.log(JSON.stringify({ classification, liveness: l, verdict: v }));
  else for (const l of v.lines) console.log(l);

  if (!v.allow) return v.code;
  if (cmd === 'check') return 0;

  // run: exec the guarded command, propagating its own exit code (0 from the guard means
  // "allowed", never "succeeded" — the caller wants git's verdict, not ours).
  const [bin, ...rest] = guarded[0] === 'git' ? guarded : ['git', ...guarded];
  const r = spawnSync(bin, rest, { stdio: 'inherit' });
  if (r.error) {
    console.error(
      `git-maintenance-guard: could not run \`${guarded.join(' ')}\`: ${r.error.message}`,
    );
    return 2;
  }
  return r.status ?? 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    // A guard that crashes must FAIL CLOSED — an unreadable probe is not permission to prune.
    console.error(`git-maintenance-guard: ${e?.message ?? e}`);
    process.exit(2);
  }
}
