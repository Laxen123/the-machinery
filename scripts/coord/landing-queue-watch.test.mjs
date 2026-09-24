// scripts/landing-queue-watch.test.mjs (plan 968)
// Unit tests for the pure decision core of the sleep-until-head watcher: the
// status → verdict mapping and the arg parser (defaults + validation). The loop /
// spawn / sleep is a thin IO shell around these and is exercised manually against a
// throwaway queue; here we lock the branch logic + the documented defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  watchVerdict,
  parseWatchArgs,
  keepHotShouldPrep,
  staleWhileQueuedShouldProbe,
  formatStaleWhileQueued,
  demoteSentinelStep,
  stealSentinelStep,
  selectPollIntervalSec,
  effectiveHeartbeatSec,
  shouldHeartbeatNow,
  DEFAULT_INTERVAL_SEC,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_HEARTBEAT_SEC,
  DEFAULT_NEAR_INTERVAL_SEC,
  NEAR_POSITION_THRESHOLD,
  SELF_ARM_HEARTBEAT_SEC,
  HEAD_EXIT_REFRESH_MIN_AGE_MS,
  DEMOTE_RETRY_MS,
  STEAL_RETRY_MS,
  OVERTAKE_RETRY_MS,
  REAP_RETRY_MS,
  overtakeSentinelStep,
  reapSentinelStep,
  readWatcherPid,
  watcherIsLive,
  stampPidfile,
  claimPidfile,
  WATCHER_PIDFILE_MAX_AGE_MS,
  prepAbortReason,
  classifyPrepExit,
  prepExitReport,
  PREP_MAX_MS,
  PREP_INFRA_ESCALATE_AFTER,
  PREP_EXITS,
  PREP_EXIT_BUSY,
  keepHotBusyStandDown,
  pairBusyHolder,
  fakeStatusFor,
} from './landing-queue-watch.mjs';
// plan 3274 (review round, F3 review fix): PREP_EXIT — the shared home (done-worktree-lib.mjs,
// beside EXIT/SEAM) both done-worktree.mjs and this watcher's own PREP_EXITS table now key their
// GATE_CHUNKED row off, rather than each carrying its own re-typed 40 literal.
import { PREP_EXIT } from './done-worktree-lib.mjs';
import { WORKTREE_LOCK_MAX_HOLD_MS } from './worktree-lock.mjs';
import {
  demoteVerdict,
  DEFAULT_DEMOTE_STALE_MIN,
  DEFAULT_STEAL_STALE_MIN,
  DEFAULT_REAP_STALE_MIN,
} from './landing-queue-lib.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'landing-queue-watch.mjs');

test('watchVerdict — head (position 1) is terminal, code 0', () => {
  const v = watchVerdict({ position: 1, total: 5 });
  assert.equal(v.kind, 'head');
  assert.equal(v.done, true);
  assert.equal(v.code, 0);
  assert.match(v.message, /1\/5/);
});

test('watchVerdict — gone (position 0) is terminal, code 3', () => {
  const v = watchVerdict({ position: 0, total: 5 });
  assert.equal(v.kind, 'gone');
  assert.equal(v.done, true);
  assert.equal(v.code, 3);
});

test('watchVerdict — gone also for an empty queue (0/0)', () => {
  const v = watchVerdict({ position: 0, total: 0 });
  assert.equal(v.kind, 'gone');
  assert.equal(v.done, true);
  assert.equal(v.code, 3);
});

test('watchVerdict — waiting (position > 1) keeps looping', () => {
  const v = watchVerdict({ position: 3, total: 5 });
  assert.equal(v.kind, 'waiting');
  assert.equal(v.done, false);
  assert.equal(v.code, null);
  assert.match(v.message, /3\/5/);
});

test('parseWatchArgs — slug positional + documented defaults', () => {
  const o = parseWatchArgs(['955-UI-map']);
  assert.equal(o.slug, '955-UI-map');
  assert.equal(o.intervalSec, DEFAULT_INTERVAL_SEC);
  assert.equal(o.timeoutSec, DEFAULT_TIMEOUT_SEC);
  assert.equal(o.heartbeatEverySec, DEFAULT_HEARTBEAT_SEC);
  assert.equal(o.json, false);
});

test('parseWatchArgs — flags override and --json is boolean', () => {
  const o = parseWatchArgs([
    'my-slug',
    '--interval',
    '5',
    '--timeout',
    '30',
    '--heartbeat-every',
    '900',
    '--json',
  ]);
  assert.equal(o.slug, 'my-slug');
  assert.equal(o.intervalSec, 5);
  assert.equal(o.timeoutSec, 30);
  assert.equal(o.heartbeatEverySec, 900);
  assert.equal(o.json, true);
});

test('parseWatchArgs — missing slug throws', () => {
  assert.throws(() => parseWatchArgs(['--interval', '5']), /needs a <slug>/);
});

// ── plan 972 keep-hot, DEFAULT-ON since plan 2551 ─────────────────────
// This pin was "default off" until plan 2551 FLIPPED it (not deleted — the direction of the
// default is the whole point of the pin). Rationale: every canonical machine-emitted recipe
// handed out the flagless command while only the runbook added --keep-hot, so a session that
// copy-pasted what the spine printed waited COLD and arrived at head needing a full rebase +
// gate battery inside the head slot (plan 2549's land, 2026-07-27: 9-min head-hold > the
// plan-1528 8-min cap → requeued to the tail). Safe behavior belongs in the default.
test('plan 2551: keep-hot is ON by default; --pure-poll is the opt-out; --keep-hot is a no-op', () => {
  assert.equal(
    parseWatchArgs(['s']).keepHot,
    true,
    'the FLAGLESS command must keep the branch hot',
  );
  assert.equal(
    parseWatchArgs(['s', '--pure-poll']).keepHot,
    false,
    'the explicit opt-out still works',
  );
  // Accepted, and redundant — every pre-flip recipe, runbook line and muscle-memory invocation
  // must keep PARSING. Dropping the flag would turn a stale-but-safe command into a hard
  // "unknown flag" throw, which is the opposite of a safe-by-default flip.
  assert.equal(parseWatchArgs(['s', '--keep-hot']).keepHot, true);
  // Both together: the opt-out wins (it is the only thing that can turn keep-hot off).
  assert.equal(parseWatchArgs(['s', '--keep-hot', '--pure-poll']).keepHot, false);
});

// ── plan 2551: the per-slug pidfile the spine's auto-spawn probes ────────────────────
// Every case here defends ONE property: the probe is ECONOMY, never correctness. Overlapping
// preps already dedup at the per-slug worktree lock (plan 2473) + the battery-lock, so a wrong
// answer costs at most one redundant detached poller — which is why nothing throws, and why the
// fail direction is deliberately OPPOSITE to the locks': anything the probe cannot positively
// confirm (unreadable, undated, or merely stale) reads as FREE. A false "free" costs one spare
// poller; a false "live" costs the whole keep-hot guarantee.
test('plan 2551: readWatcherPid — a real pid parses; absent/garbage/non-positive read as nobody', () => {
  assert.equal(readWatcherPid('x', { _read: () => '4321\n' }), 4321);
  assert.equal(readWatcherPid('x', { _read: () => '  4321  ' }), 4321, 'whitespace tolerated');
  assert.equal(
    readWatcherPid('x', {
      _read: () => {
        throw new Error('ENOENT');
      },
    }),
    null,
    'an absent pidfile is not an error — it means nobody is advertising',
  );
  assert.equal(readWatcherPid('x', { _read: () => 'not-a-pid' }), null);
  assert.equal(readWatcherPid('x', { _read: () => '0' }), null);
  assert.equal(readWatcherPid('x', { _read: () => '-7' }), null);
});

const NOW = Date.parse('2026-07-28T00:00:00.000Z');
// A CURRENT (post-2839) advertisement — a keep-hot watcher's, since that is the only kind that
// writes one. The pre-2839 shapes get their own pins below.
const stamp = (pid, iso) => JSON.stringify({ pid, iso, keepHot: true });
const live = (text, alive, o = {}) =>
  watcherIsLive('x', { _read: () => text, _pidAlive: () => alive, _now: () => NOW, ...o });

test('plan 2551: watcherIsLive — a FRESH stamp whose pid is not provably dead holds the slug', () => {
  assert.equal(live(stamp(4321, '2026-07-27T23:55:00.000Z'), true), true);
  assert.equal(live(stamp(4321, '2026-07-27T23:55:00.000Z'), false), false, 'provably dead ⇒ free');
  // pidAlive returns null when death cannot be PROVEN (foreign-user pid, exotic kill error) —
  // that alone does not free the slug; the AGE gate below is what bounds it.
  assert.equal(live(stamp(4321, '2026-07-27T23:55:00.000Z'), null), true);
});

// THE PID-REUSE BUG (review 2026-07-28, fixed here). Without an age gate, a watcher that died
// without running its exit cleanup (OOM-kill, hard termination) leaves a pidfile the OS can
// REASSIGN to an unrelated long-lived process — which then probes alive forever, suppressing the
// spine's auto-spawn for that slug for the rest of its wait. The branch silently stops being kept
// hot: the exact cold-wait failure this plan removes, reintroduced by its own safety net.
test('plan 2551: watcherIsLive — a STALE stamp frees the slug even when the pid probes alive', () => {
  const staleIso = new Date(NOW - (WATCHER_PIDFILE_MAX_AGE_MS + 60_000)).toISOString();
  assert.equal(live(stamp(4321, staleIso), true), false, 'past the ceiling ⇒ free (pid reuse)');
  const justInsideIso = new Date(NOW - (WATCHER_PIDFILE_MAX_AGE_MS - 60_000)).toISOString();
  assert.equal(live(stamp(4321, justInsideIso), true), true, 'inside the ceiling ⇒ still held');
});

// gpt-review 714d86 (2026-08-05): the ceiling alone bounds only the PAST. A future-dated stamp
// makes the age negative, which is trivially inside any ceiling — so a host clock that jumped
// forward before a watcher died would leave that dead watcher's advertisement suppressing the
// auto-spawn until real time caught up.
test('plan 2839: watcherIsLive — a FUTURE-dated stamp reads as FREE, not as freshly live', () => {
  const futureIso = new Date(NOW + 60 * 60 * 1000).toISOString();
  assert.equal(live(stamp(4321, futureIso), true), false, 'the future is not proof of life');
  // The boundary itself: stamped exactly now is live; one millisecond ahead is not.
  assert.equal(live(stamp(4321, new Date(NOW).toISOString()), true), true);
  assert.equal(live(stamp(4321, new Date(NOW + 1).toISOString()), true), false);
});

test('plan 2551: watcherIsLive — unreadable / undated / garbage all read as FREE', () => {
  // Fail direction is deliberately OPPOSITE to the locks: the only cost of a false "free" is one
  // redundant detached poller (duplicate preps dedup at the worktree lock), while a false "live"
  // costs the whole keep-hot guarantee.
  assert.equal(live('4321', true), false, 'a legacy bare-pid file cannot prove freshness');
  assert.equal(live('not-a-pid', true), false);
  assert.equal(live('', true), false);
  assert.equal(
    watcherIsLive('x', {
      _read: () => {
        throw new Error('ENOENT');
      },
      _pidAlive: () => true,
      _now: () => NOW,
    }),
    false,
    'no pidfile ⇒ free, without ever consulting pid liveness',
  );
});

test('plan 2551: readWatcherPid parses both the JSON stamp and a legacy bare pid', () => {
  assert.equal(readWatcherPid('x', { _read: () => stamp(4321, '2026-07-27T23:55:00.000Z') }), 4321);
  assert.equal(readWatcherPid('x', { _read: () => '4321' }), 4321, 'legacy shape still resolves');
  // The pid is read for the RELEASE ownership guard, which must work in both modes — so it stays
  // mode-blind on purpose. Only `watcherIsLive` cares whether the advertiser keeps the branch hot.
  assert.equal(
    readWatcherPid('x', { _read: () => JSON.stringify({ pid: 4321, iso: null, keepHot: false }) }),
    4321,
  );
});

// ── plan 2839: a --pure-poll watcher must not advertise keep-hot coverage it does not provide ──
//
// THE HOLE. `--pure-poll` does NO rebase and NO gate re-validation, yet the watcher claimed the
// per-slug pidfile unconditionally — so the spine read it through `watcherIsLive` and SKIPPED its
// own keep-hot auto-spawn for that slug's whole wait. The branch went cold with no signal:
// precisely the failure the auto-spawn (plan 2551) exists to prevent, arriving by another door.
//
// Every case below pins one of the four bugs four consecutive review rounds found in the fix.
const FRESH_ISO = '2026-07-27T23:55:00.000Z';

test('plan 2839: watcherIsLive — only a KEEP-HOT advertisement suppresses the auto-spawn', () => {
  assert.equal(live(stamp(4321, FRESH_ISO), true), true, 'keep-hot coverage is real coverage');
  // A pure-poll watcher from a PRE-2839 checkout: right shape, fresh stamp, live pid — and no
  // field. This is the case the `keepHot` field exists for; gating the WRITER alone (review round
  // 2) left exactly this watcher still suppressing the spine.
  assert.equal(
    live(JSON.stringify({ pid: 4321, iso: FRESH_ISO }), true),
    false,
    'a pre-2839 advertisement cannot prove keep-hot coverage ⇒ free',
  );
  // Explicit false, and every non-`true` value: the read is `=== true`, never truthiness.
  for (const v of [false, null, 0, 'true', 1, undefined]) {
    assert.equal(
      live(JSON.stringify({ pid: 4321, iso: FRESH_ISO, keepHot: v }), true),
      false,
      `keepHot: ${JSON.stringify(v)} is not proof of coverage`,
    );
  }
});

test('plan 2839: stampPidfile — the mode is REQUIRED, and a non-keep-hot write is refused', () => {
  const writes = [];
  const opts = { _write: (p, o) => writes.push([p, o]), _nowIso: () => FRESH_ISO };
  // THE BUG THAT SHIPPED AND WAS REVERTED (review round 3): the per-poll re-stamp called
  // `stampPidfile(path)` with no options, so a DEFAULTED mode rewrote a correct record on the very
  // first poll — inverting the spine's dedup into an amplifier (a duplicate watcher per poll).
  // Omission must be impossible, not merely discouraged.
  assert.throws(() => stampPidfile('x', opts), TypeError, 'omitting the mode must throw');
  assert.throws(() => stampPidfile('x'), TypeError, 'no options at all must throw too');
  assert.equal(writes.length, 0, 'a throwing call never touches the file');

  assert.equal(stampPidfile('x', { ...opts, keepHot: true }), true);
  assert.deepEqual(writes, [['x', { pid: process.pid, iso: FRESH_ISO, keepHot: true }]]);

  // The path is per-slug and LAST-WRITER-WINS, so a watcher with nothing to advertise must write
  // NOTHING: a self-describing `keepHot: false` stamp would still overwrite a live keep-hot
  // watcher's record on the same slug and send the spine spawning duplicates.
  writes.length = 0;
  assert.equal(stampPidfile('x', { ...opts, keepHot: false }), false);
  assert.equal(writes.length, 0, 'a non-keep-hot write never touches the shared path');

  // The IO contract is unchanged: a write failure still returns false rather than throwing into
  // the watch loop. A watcher that cannot advertise must still watch.
  assert.equal(
    stampPidfile('x', {
      keepHot: true,
      _write: () => {
        throw new Error('EACCES');
      },
    }),
    false,
  );
});

// A recording harness for claimPidfile: no fs, no signals, no process.exit.
function claimHarness({
  keepHot,
  path = '/main/.scratch/lq-watch-s.pid',
  stamp: stampResult = true,
}) {
  const rec = { handlers: {}, stamps: [], mkdirs: [], rms: [], exits: [] };
  const restamp = claimPidfile('s', {
    keepHot,
    _pathFor: () => path,
    _on: (ev, fn) => {
      (rec.handlers[ev] ||= []).push(fn);
    },
    _mkdir: (d) => rec.mkdirs.push(d),
    _stamp: (p, o) => {
      rec.stamps.push([p, o]);
      return stampResult;
    },
    _readPid: () => process.pid,
    _rm: (p) => rec.rms.push(p),
    _exit: (c) => rec.exits.push(c),
  });
  return { rec, restamp };
}

test('plan 2839: claimPidfile — a pure-poll watcher registers handlers but advertises nothing', () => {
  const { rec, restamp } = claimHarness({ keepHot: false });
  assert.equal(restamp, null, 'nothing to advertise ⇒ no re-stamp closure');
  assert.equal(rec.stamps.length, 0, 'and the shared pidfile is never written');
  assert.equal(rec.mkdirs.length, 0);
  // REVIEW ROUND 1's BUG: "a pure-poll watcher just doesn't claim the pidfile" broke Ctrl+C —
  // these handlers are what END the process, and plan 2738's prep-kill listener is PREPENDED on
  // the assumption they already exist behind it. They are registered unconditionally, first.
  assert.deepEqual(Object.keys(rec.handlers).sort(), ['SIGINT', 'SIGTERM', 'exit']);
  rec.handlers.SIGINT[0]();
  rec.handlers.SIGTERM[0]();
  assert.deepEqual(rec.exits, [130, 143], 'Ctrl+C and SIGTERM still exit a pure-poll watcher');
});

test('plan 2839: claimPidfile — handlers survive a resolveMain failure (no pidfile path)', () => {
  // REVIEW ROUND 4's BUG: registration still sat behind the `pidfilePathFor` null return, so a
  // watcher whose MAIN could not be resolved was left un-interruptible.
  const { rec, restamp } = claimHarness({ keepHot: true, path: null });
  assert.equal(restamp, null);
  assert.equal(rec.stamps.length, 0);
  assert.deepEqual(Object.keys(rec.handlers).sort(), ['SIGINT', 'SIGTERM', 'exit']);
  rec.handlers.SIGINT[0]();
  assert.deepEqual(rec.exits, [130]);
  assert.deepEqual(rec.rms, [], 'release with no path unlinks nothing');
});

test('plan 2839: claimPidfile — a keep-hot watcher re-declares the mode on EVERY write', () => {
  const { rec, restamp } = claimHarness({ keepHot: true });
  assert.equal(typeof restamp, 'function');
  restamp();
  restamp();
  assert.equal(rec.stamps.length, 3, 'one claim + two polls');
  for (const [, o] of rec.stamps) {
    assert.deepEqual(o, { keepHot: true }, 'the mode rides the closure, so no site can drop it');
  }
  // The exit cleanup only unlinks a file that still names US (a relaunched watcher for the same
  // slug may legitimately have taken it over).
  rec.handlers.exit[0]();
  assert.deepEqual(rec.rms, ['/main/.scratch/lq-watch-s.pid']);
});

test('plan 2839: claimPidfile — a failed claim stamp yields no closure, handlers intact', () => {
  const { rec, restamp } = claimHarness({ keepHot: true, stamp: false });
  assert.equal(restamp, null, 'a watcher that cannot advertise must still watch');
  assert.deepEqual(Object.keys(rec.handlers).sort(), ['SIGINT', 'SIGTERM', 'exit']);
});

test('plan 2839: the stampPidfile → watcherIsLive seam, end to end on one slug', () => {
  // ONE in-memory pidfile shared by both watchers, exactly as the real per-slug path is shared.
  let file = null;
  const write = (_p, o) => {
    file = JSON.stringify(o);
  };
  const isLive = () =>
    watcherIsLive('x', { _read: () => file ?? '', _pidAlive: () => true, _now: () => NOW });

  assert.equal(isLive(), false, 'no advertisement ⇒ the spine spawns its own watcher');
  stampPidfile('x', { keepHot: true, _write: write, _nowIso: () => FRESH_ISO });
  assert.equal(isLive(), true, 'a keep-hot watcher legitimately suppresses the duplicate');
  // The whole point: a pure-poll watcher on the SAME slug cannot take the advertisement away.
  assert.equal(
    stampPidfile('x', { keepHot: false, _write: write, _nowIso: () => FRESH_ISO }),
    false,
  );
  assert.equal(isLive(), true, "the keep-hot watcher's record survives a pure-poll watcher");
});

// plan 1777 strictness pin: the old loop silently consumed `--typo value` pairs (a
// misspelled --interval waited on the DEFAULT cadence forever); the spec'd parseFlags
// wrapper refuses unknown flags loudly.
test('parseWatchArgs — unknown flag throws loudly', () => {
  assert.throws(
    () => parseWatchArgs(['s', '--intervall', '5']),
    /landing-queue-watch: unknown flag --intervall/,
  );
});

test('plan 972: keepHotShouldPrep — fires only while WAITING, on a tip advance', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  // disabled ⇒ never (back-compat: a watcher launched without --keep-hot is pure-poll)
  assert.equal(
    keepHotShouldPrep({ enabled: false, kind: 'waiting', tip: A, lastPreppedTip: null }),
    false,
  );
  // first poll (no prior prep) while waiting ⇒ prep to stamp the initial marker
  assert.equal(
    keepHotShouldPrep({ enabled: true, kind: 'waiting', tip: A, lastPreppedTip: null }),
    true,
  );
  // tip unchanged since the last prep ⇒ no re-prep (the rebase would idempotently no-op)
  assert.equal(
    keepHotShouldPrep({ enabled: true, kind: 'waiting', tip: A, lastPreppedTip: A }),
    false,
  );
  // origin/master advanced ⇒ re-prep (rebase onto the new base during the wait)
  assert.equal(
    keepHotShouldPrep({ enabled: true, kind: 'waiting', tip: B, lastPreppedTip: A }),
    true,
  );
  // head / gone ⇒ never prep (about to land, or already out of the queue)
  assert.equal(
    keepHotShouldPrep({ enabled: true, kind: 'head', tip: B, lastPreppedTip: A }),
    false,
  );
  assert.equal(
    keepHotShouldPrep({ enabled: true, kind: 'gone', tip: B, lastPreppedTip: A }),
    false,
  );
  // unknown tip (rev-parse failed) ⇒ skip this poll, never prep against an unknown base
  assert.equal(
    keepHotShouldPrep({ enabled: true, kind: 'waiting', tip: null, lastPreppedTip: A }),
    false,
  );
});

test('plan 2274: staleWhileQueuedShouldProbe — fires only while WAITING, on a tip advance, ALWAYS ON (no enable flag)', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  // first poll (no prior probe) while waiting ⇒ probe (unlike keep-hot, no --enabled gate)
  assert.equal(staleWhileQueuedShouldProbe({ kind: 'waiting', tip: A, lastProbedTip: null }), true);
  // tip unchanged since the last probe ⇒ skip (nothing new to re-check)
  assert.equal(staleWhileQueuedShouldProbe({ kind: 'waiting', tip: A, lastProbedTip: A }), false);
  // origin/master advanced ⇒ re-probe
  assert.equal(staleWhileQueuedShouldProbe({ kind: 'waiting', tip: B, lastProbedTip: A }), true);
  // head / gone ⇒ never probe (about to land, or already out of the queue)
  assert.equal(staleWhileQueuedShouldProbe({ kind: 'head', tip: B, lastProbedTip: A }), false);
  assert.equal(staleWhileQueuedShouldProbe({ kind: 'gone', tip: B, lastProbedTip: A }), false);
  // unknown tip (rev-parse failed) ⇒ skip this poll, never probe against an unknown base
  assert.equal(
    staleWhileQueuedShouldProbe({ kind: 'waiting', tip: null, lastProbedTip: A }),
    false,
  );
});

test('plan 2274: formatStaleWhileQueued — prefers culprit attribution text, falls back to a bare file list', () => {
  const withCulprits = formatStaleWhileQueued(
    'demo-slug',
    ['a.py'],
    'conflict in a.py — landed by plan 2265 (abc123456 "...")',
  );
  assert.match(withCulprits, /STALE-WHILE-QUEUED \(plan 2274\): demo-slug/);
  assert.match(withCulprits, /landed by plan 2265/);
  // culprit attribution failed (best-effort) ⇒ falls back to naming the raw conflicted paths
  const withoutCulprits = formatStaleWhileQueued('demo-slug', ['a.py', 'b.py'], '');
  assert.match(withoutCulprits, /- a\.py/);
  assert.match(withoutCulprits, /- b\.py/);
});

test('parseWatchArgs — non-positive numeric flag throws', () => {
  assert.throws(
    () => parseWatchArgs(['s', '--interval', '0']),
    /--interval must be a positive number/,
  );
  assert.throws(
    () => parseWatchArgs(['s', '--timeout', 'abc']),
    /--timeout must be a positive number/,
  );
});

// ── plan 1807 lever 2: adaptive poll cadence ────────────────────────
// This watcher (launched detached per docs/runbooks/plans-workflow.md "Self-manage
// mechanical waits") is the live head-detection path; done-worktree.mjs's own --wait
// poll loop is dormant (CLAUDE.md forbids running --wait detached) and out of scope.

test('parseWatchArgs — --near-interval defaults to DEFAULT_NEAR_INTERVAL_SEC, overridable', () => {
  assert.equal(parseWatchArgs(['s']).nearIntervalSec, DEFAULT_NEAR_INTERVAL_SEC);
  assert.equal(parseWatchArgs(['s', '--near-interval', '5']).nearIntervalSec, 5);
  assert.throws(
    () => parseWatchArgs(['s', '--near-interval', '0']),
    /--near-interval must be a positive number/,
  );
});

test('selectPollIntervalSec — position <= NEAR_POSITION_THRESHOLD gets the near tier', () => {
  assert.equal(
    selectPollIntervalSec({ position: NEAR_POSITION_THRESHOLD, nearSec: 30, farSec: 120 }),
    30,
  );
  assert.equal(selectPollIntervalSec({ position: 1, nearSec: 30, farSec: 120 }), 30);
});

test('selectPollIntervalSec — deeper positions keep the far (base --interval) tier', () => {
  assert.equal(
    selectPollIntervalSec({
      position: NEAR_POSITION_THRESHOLD + 1,
      nearSec: 30,
      farSec: 120,
    }),
    120,
  );
  assert.equal(selectPollIntervalSec({ position: 9, nearSec: 30, farSec: 120 }), 120);
});

test('selectPollIntervalSec — unknown position (failed status read) fails toward the SLOWER far tier', () => {
  assert.equal(selectPollIntervalSec({ position: null, nearSec: 30, farSec: 120 }), 120);
  assert.equal(selectPollIntervalSec({ position: 0, nearSec: 30, farSec: 120 }), 120);
});

test('selectPollIntervalSec — bare defaults match the documented DEFAULT_* constants', () => {
  assert.equal(selectPollIntervalSec({ position: 2 }), DEFAULT_NEAR_INTERVAL_SEC);
  assert.equal(selectPollIntervalSec({ position: 50 }), DEFAULT_INTERVAL_SEC);
});

// Integration: a waiting payload at position 2 (== NEAR_POSITION_THRESHOLD) must sleep at
// the FAST --near-interval cadence, not the slow --interval one — proven by timing out
// almost immediately when --near-interval is tiny but --interval is deliberately huge
// (a flat, un-adaptive loop would still be asleep at the first --interval tick).
// --pure-poll: plan 2551 flipped keep-hot ON by default, which (with no LQW_FAKE_ORIGIN_TIP /
// LQW_FAKE_PREP) would fire a REAL `done-worktree --prep` for this nonexistent slug on the
// very first poll — unrelated to the near-interval cadence this test targets, and slow enough
// to blow past execFileSync's timeout (observed: code null, not 4). The plan-972/2274 CLI tests
// below face the same default and cope by faking origin-tip + prep instead; --pure-poll is the
// simpler opt-out here since keep-hot itself is out of scope for this assertion.
// LQW_FAKE_ORIGIN_TIP / LQW_FAKE_STALE_PROBE: the plan-2274 STALE-WHILE-QUEUED probe is ALWAYS
// ON regardless of --pure-poll (see its header comment), so without these two the loop still
// shells out to a REAL `git rev-parse origin/master` + `git merge-tree` every poll — on this
// repo's shared, heavily-loaded .git that alone measured ~13s, still starving the <10s bound
// this test asserts even after --pure-poll fixed the timeout-vs-null failure above. Faking both
// (mirroring the plan-2274 CLI test below) removes the last real git call from this test's path.
test('plan 1807: CLI — a position-2 waiter times out on the FAST near-interval, not the slow base interval', () => {
  let code = 0;
  let stdout = '';
  const started = Date.now();
  try {
    stdout = execFileSync(
      'node',
      [
        CLI,
        'demo-slug',
        '--timeout',
        '1',
        '--interval',
        '999',
        '--near-interval',
        '0.2',
        '--pure-poll',
        '--json',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          LQW_FAKE_STATUS_JSON: JSON.stringify({
            slug: 'demo-slug',
            position: 2,
            total: 3,
            head: 'other',
          }),
          LQW_FAKE_ORIGIN_TIP: 'b'.repeat(40),
          LQW_FAKE_STALE_PROBE: 'clean',
        },
        timeout: 15000,
      },
    );
  } catch (e) {
    code = e.status;
    stdout = e.stdout || '';
  }
  const elapsedMs = Date.now() - started;
  assert.equal(code, 4, 'still waiting → times out at the --timeout deadline');
  assert.match(stdout, /"kind":"timeout"/);
  // The bound only needs to separate the 0.2s near-interval from the 999s base interval —
  // anything under a few seconds proves the fast cadence. It must NOT also absorb node
  // process startup under full-battery load: at 3000ms this flaked twice on 2026-08-13
  // (3272ms/3395ms, both green in isolation) and blocked the plan-2875 pre-deploy gate.
  // 10s keeps a 100x margin below the base interval while tolerating a loaded machine;
  // a genuinely flat 999s loop is killed by execFileSync's 15s timeout (code null ≠ 4).
  assert.ok(
    // ambient-load-ok: duration genuinely IS the property here (fast near-interval vs a 999s base
    // interval) and the code under test is a real spawned child, so an injected clock cannot drive
    // it. The bound was already retuned once on observed flake — see the four comment lines above —
    // and 10s keeps a 100x margin below the interval it must separate.
    elapsedMs < 10_000,
    `position-2 waiter must poll on the fast near-interval, not a 999s base interval (took ${elapsedMs}ms)`,
  );
});

// CLI dry trace via LQW_FAKE_STATUS_JSON: a head payload exits 0 immediately (no real
// queue / no git), proving the loop plumbing wires the verdict to the exit code.
test('CLI — fake head status exits 0 and prints HEAD', () => {
  const out = execFileSync('node', [CLI, 'demo-slug', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LQW_FAKE_STATUS_JSON: JSON.stringify({
        slug: 'demo-slug',
        position: 1,
        total: 2,
        head: 'demo-slug',
      }),
    },
  });
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.kind, 'head');
  assert.equal(parsed.code, 0);
});

// A malformed status payload makes readStatus throw every poll; after
// MAX_CONSECUTIVE_ERRORS the watcher bails to ERROR (exit 5) instead of spinning on a
// corrupt queue. --interval 0.1 keeps the 8-strike bail well under a second.
test('CLI — malformed status payload bails to ERROR (code 5)', () => {
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync('node', [CLI, 'demo-slug', '--interval', '0.1', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, LQW_FAKE_STATUS_JSON: 'not-json' },
    });
  } catch (e) {
    code = e.status;
    stdout = e.stdout || '';
  }
  assert.equal(code, 5);
  assert.match(stdout, /"kind":"error"/);
});

// plan 972: --keep-hot fires a (faked) done-worktree --prep on a waiting poll, then keeps
// waiting → times out cleanly (proves the flag is accepted and the keep-hot step is wired into
// the loop without crashing). LQW_FAKE_PREP avoids spawning a real done-worktree.
// plan 1807 lever 2: the fake status is position 2 — pin --near-interval (not just
// --interval) so this test keeps its sub-second runtime under the new adaptive tier.
test('plan 972: CLI — --keep-hot runs a prep on a waiting poll, then times out (code 4)', () => {
  let code = 0;
  let stderr = '';
  try {
    execFileSync(
      'node',
      [
        CLI,
        'demo-slug',
        '--keep-hot',
        '--timeout',
        '1',
        '--interval',
        '1',
        '--near-interval',
        '1',
        '--json',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          LQW_FAKE_STATUS_JSON: JSON.stringify({
            slug: 'demo-slug',
            position: 2,
            total: 3,
            head: 'other',
          }),
          LQW_FAKE_ORIGIN_TIP: 'a'.repeat(40),
          LQW_FAKE_PREP: '0',
        },
      },
    );
  } catch (e) {
    code = e.status;
    stderr = e.stderr || '';
  }
  assert.equal(code, 4, 'still waiting → times out after the keep-hot prep');
  assert.match(stderr, /keep-hot — origin\/master at aaaaaaaaa/, 'the prep fired this poll');
});

test('plan 2274: CLI — STALE-WHILE-QUEUED warns on a conflicted probe with NO --keep-hot flag (always on)', () => {
  let code = 0;
  let stderr = '';
  try {
    execFileSync(
      'node',
      [CLI, 'demo-slug', '--timeout', '1', '--interval', '1', '--near-interval', '1', '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          LQW_FAKE_STATUS_JSON: JSON.stringify({
            slug: 'demo-slug',
            position: 8,
            total: 9,
            head: 'other',
          }),
          LQW_FAKE_ORIGIN_TIP: 'c'.repeat(40),
          LQW_FAKE_STALE_PROBE: 'backend/scripts/_places_geo.py',
        },
      },
    );
  } catch (e) {
    code = e.status;
    stderr = e.stderr || '';
  }
  assert.equal(code, 4, 'still waiting (deep position, no keep-hot) → times out, never blocks');
  assert.match(stderr, /STALE-WHILE-QUEUED \(plan 2274\)/, 'the probe fired without --keep-hot');
  assert.match(stderr, /_places_geo\.py/, 'names the conflicted path');
});

test('plan 2274: CLI — a CLEAN probe never warns', () => {
  let code = 0;
  let stderr = '';
  try {
    execFileSync(
      'node',
      [CLI, 'demo-slug', '--timeout', '1', '--interval', '1', '--near-interval', '1', '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          LQW_FAKE_STATUS_JSON: JSON.stringify({
            slug: 'demo-slug',
            position: 8,
            total: 9,
            head: 'other',
          }),
          LQW_FAKE_ORIGIN_TIP: 'd'.repeat(40),
          LQW_FAKE_STALE_PROBE: 'clean',
        },
      },
    );
  } catch (e) {
    code = e.status;
    stderr = e.stderr || '';
  }
  assert.equal(code, 4);
  assert.doesNotMatch(stderr, /STALE-WHILE-QUEUED/);
});

// A waiting payload with --timeout 1 exits 4 (TIMEOUT) rather than spinning forever.
// plan 1807 lever 2: position 2 → pin --near-interval so this stays sub-second.
test('CLI — fake waiting status times out with code 4', () => {
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync(
      'node',
      [CLI, 'demo-slug', '--timeout', '1', '--interval', '1', '--near-interval', '1', '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          LQW_FAKE_STATUS_JSON: JSON.stringify({
            slug: 'demo-slug',
            position: 2,
            total: 3,
            head: 'other',
          }),
        },
      },
    );
  } catch (e) {
    code = e.status;
    stdout = e.stdout || '';
  }
  assert.equal(code, 4);
  assert.match(stdout, /"kind":"timeout"/);
});

// ── plan 2085: self-armed near-head heartbeating ─────────────────────
// The canonical QUEUE_WAIT instruction hands out the FLAGLESS watcher command, so the
// default must be demote-safe on its own: near the head the watcher self-arms
// heartbeating (effectiveHeartbeatSec), and it refreshes once more at head-exit.

// plan 3422 D3 reframed this case. effectiveHeartbeatSec is unchanged and still passes the
// flag through verbatim at depth — but "flagless stays pure-read" is no longer what a flagless
// launch MEANS, because DEFAULT_HEARTBEAT_SEC is now SELF_ARM_HEARTBEAT_SEC rather than 0. A
// heartbeatEverySec of 0 is now unreachable from the CLI (parseWatchArgs requires a positive
// number, and the default is positive); it is kept here as the total-function contract only.
test('effectiveHeartbeatSec — deep positions keep the flag value verbatim (total-function contract; 0 is no longer the flagless default, plan 3422 D3)', () => {
  assert.equal(
    effectiveHeartbeatSec({ position: NEAR_POSITION_THRESHOLD + 1, heartbeatEverySec: 0 }),
    0,
    'an explicit 0 still means off at depth — the function passes the flag through unchanged',
  );
  assert.equal(effectiveHeartbeatSec({ position: 9, heartbeatEverySec: 900 }), 900);
  // unknown position (failed status read) → never self-arm blind
  assert.equal(effectiveHeartbeatSec({ position: null, heartbeatEverySec: 0 }), 0);
});

test('plan 3422 D3: the flagless default heartbeats at EVERY position, at the self-arm cadence', () => {
  assert.equal(
    DEFAULT_HEARTBEAT_SEC,
    SELF_ARM_HEARTBEAT_SEC,
    'a flagless watcher must arrive at the head demote-fresh from ANY depth (plan 2347 waited ' +
      '~124 min at depth and was demoted just as it reached position 2)',
  );
  // the flagless launch value, resolved at a deep position, is now a live cadence — not 0
  const flagless = parseWatchArgs(['some-slug']).heartbeatEverySec;
  assert.equal(
    effectiveHeartbeatSec({ position: 12, heartbeatEverySec: flagless }),
    SELF_ARM_HEARTBEAT_SEC,
  );
});

test('plan 2085: effectiveHeartbeatSec — position <= NEAR_POSITION_THRESHOLD self-arms even flagless', () => {
  assert.equal(
    effectiveHeartbeatSec({ position: NEAR_POSITION_THRESHOLD, heartbeatEverySec: 0 }),
    SELF_ARM_HEARTBEAT_SEC,
  );
  assert.equal(
    effectiveHeartbeatSec({ position: 1, heartbeatEverySec: 0 }),
    SELF_ARM_HEARTBEAT_SEC,
  );
});

test('plan 2085: effectiveHeartbeatSec — near head an explicit flag is clamped to the self-arm cadence; a faster one wins', () => {
  // slower explicit flag: the demote clock, not the flag, is binding near head
  assert.equal(
    effectiveHeartbeatSec({ position: 2, heartbeatEverySec: SELF_ARM_HEARTBEAT_SEC * 3 }),
    SELF_ARM_HEARTBEAT_SEC,
  );
  // faster explicit flag keeps its cadence
  assert.equal(effectiveHeartbeatSec({ position: 2, heartbeatEverySec: 60 }), 60);
});

// ── plan 3422 D3: the near-head transition arm ───────────────────────
test('plan 3422 D3: shouldHeartbeatNow arms on the FIRST poll that observes near-head, inside the cadence window', () => {
  const base = {
    hbSec: SELF_ARM_HEARTBEAT_SEC,
    lastWriteMs: 10_000,
    cadenceSeedMs: 0,
    nowMs: 10_100, // 100ms since the last write — deep inside the cadence window
  };
  // 3 → 2 is the transition the plan-2347 demotion raced: arm regardless of the clock.
  assert.deepEqual(shouldHeartbeatNow({ ...base, position: 2, prevPosition: 3 }), {
    write: true,
    reason: 'near-head-transition',
  });
  // already near head last poll → no re-arm, the cadence clock governs again
  assert.deepEqual(shouldHeartbeatNow({ ...base, position: 2, prevPosition: 2 }), {
    write: false,
    reason: 'within-window',
  });
  // still deep → cadence only
  assert.deepEqual(shouldHeartbeatNow({ ...base, position: 7, prevPosition: 8 }), {
    write: false,
    reason: 'within-window',
  });
});

test('plan 3422 D3: a watcher that STARTS near head arms on poll 1 (prevPosition seeded Infinity)', () => {
  assert.deepEqual(
    shouldHeartbeatNow({
      position: 1,
      prevPosition: Infinity,
      hbSec: SELF_ARM_HEARTBEAT_SEC,
      lastWriteMs: null,
      cadenceSeedMs: 0,
      nowMs: 0,
    }),
    { write: true, reason: 'near-head-transition' },
  );
});

test('plan 3422 D3: the cadence path still fires at depth once the window elapses', () => {
  assert.deepEqual(
    shouldHeartbeatNow({
      position: 6,
      prevPosition: 6,
      hbSec: SELF_ARM_HEARTBEAT_SEC,
      lastWriteMs: null,
      cadenceSeedMs: 0,
      nowMs: SELF_ARM_HEARTBEAT_SEC * 1000,
    }),
    { write: true, reason: 'cadence' },
  );
  // an explicit --heartbeat-every 0 is still honoured as "off" away from the transition
  assert.deepEqual(
    shouldHeartbeatNow({
      position: 6,
      prevPosition: 6,
      hbSec: 0,
      lastWriteMs: null,
      cadenceSeedMs: 0,
      nowMs: 9_999_999,
    }),
    { write: false, reason: 'off' },
  );
});

// THE plan-3422 D3 acceptance case, mirroring the plan-2085 regression below it: a flagless
// watcher on a 124-minute wait that walks position 5 → 2 must reach the head demote-FRESH.
// Before D3 the deep leg wrote nothing at all (DEFAULT_HEARTBEAT_SEC was 0) and the entry
// aged ~124 min past the 15-min threshold; plan 2347 was demoted to the tail for exactly this.
test('plan 3422 D3: a simulated 124-min flagless wait from position 5 to 2 never goes demote-stale', () => {
  const hbFlag = parseWatchArgs(['slug-3422']).heartbeatEverySec;
  const startMs = 0;
  const totalMs = 124 * 60_000;
  let lastWriteMs = null;
  let prevPosition = Infinity;
  let worstStaleMs = 0;
  // position walks 5 → 2 across the wait; poll cadence is the watcher's own selectPollIntervalSec
  let nowMs = startMs;
  while (nowMs <= totalMs) {
    const frac = nowMs / totalMs;
    const position = Math.max(2, 5 - Math.floor(frac * 3));
    const hbSec = effectiveHeartbeatSec({ position, heartbeatEverySec: hbFlag });
    const d = shouldHeartbeatNow({
      position,
      prevPosition,
      hbSec,
      lastWriteMs,
      cadenceSeedMs: startMs,
      nowMs,
    });
    prevPosition = position;
    if (d.write) lastWriteMs = nowMs;
    worstStaleMs = Math.max(worstStaleMs, nowMs - (lastWriteMs ?? startMs));
    nowMs += selectPollIntervalSec({ position }) * 1000;
  }
  assert.ok(
    worstStaleMs < DEFAULT_DEMOTE_STALE_MIN * 60_000,
    `entry went ${Math.round(worstStaleMs / 60_000)} min stale during the wait — the plan-1682 ` +
      `demote threshold is ${DEFAULT_DEMOTE_STALE_MIN} min, so it would have been demoted`,
  );
});

test('plan 2085: SELF_ARM_HEARTBEAT_SEC stays well under the plan-1682 demote threshold', () => {
  assert.ok(
    SELF_ARM_HEARTBEAT_SEC <= (DEFAULT_DEMOTE_STALE_MIN * 60) / 2,
    `self-arm cadence ${SELF_ARM_HEARTBEAT_SEC}s must keep >=2x margin under the ` +
      `${DEFAULT_DEMOTE_STALE_MIN}-min demote threshold or a near-head waiter can go stale between bumps`,
  );
});

// THE plan-2085 regression: a waiter following the CANONICAL (flagless) wait instruction
// that sits in the queue past the demote threshold must NOT be demote-eligible when it
// reaches head. Simulates the watcher's own poll/heartbeat math over a 40-minute wait,
// then feeds the resulting head entry into landing-queue-lib's REAL demoteVerdict —
// so the test breaks if the self-arm default is removed, if its cadence drifts past the
// demote threshold, or if the near tier stops covering the head-approach window.
test('plan 2085 regression: a flagless waiter past the demote threshold reaches head demote-FRESH', () => {
  const min = 60_000;
  const t0 = Date.UTC(2026, 6, 19, 12, 0, 0);
  const { heartbeatEverySec } = parseWatchArgs(['2085-slug']); // the canonical flagless launch
  let lastHeartbeatAtMs = t0; // enqueue stamped the entry fresh at t0 (the loop seeds to now)
  let now = t0;
  let prevPosition = Infinity;
  const poll = (position) => {
    const hbSec = effectiveHeartbeatSec({ position, heartbeatEverySec });
    const d = shouldHeartbeatNow({
      position,
      prevPosition,
      hbSec,
      lastWriteMs: lastHeartbeatAtMs,
      cadenceSeedMs: t0,
      nowMs: now,
    });
    prevPosition = position;
    if (d.write) lastHeartbeatAtMs = now;
    now += selectPollIntervalSec({ position }) * 1000;
  };

  // 40 min deep in the queue: far poll tier. plan 3422 D3 RETIRED the "pure-read tail" this
  // test used to assert here — the deep leg now heartbeats at the self-arm cadence too, which
  // is the whole point (plan 2347 went ~124 min stale at depth and was demoted on arrival at
  // position 2). What the deep leg must guarantee is no longer "zero writes" but "never stale".
  let worstDeepStaleMs = 0;
  while (now < t0 + 40 * min) {
    poll(4);
    worstDeepStaleMs = Math.max(worstDeepStaleMs, now - lastHeartbeatAtMs);
  }
  assert.ok(
    worstDeepStaleMs < DEFAULT_DEMOTE_STALE_MIN * min,
    `the deep-tail wait went ${Math.round(worstDeepStaleMs / min)} min stale — past the ` +
      `${DEFAULT_DEMOTE_STALE_MIN}-min demote threshold (plan 3422 D3)`,
  );
  assert.ok(
    now - t0 > DEFAULT_DEMOTE_STALE_MIN * min,
    'the wait is already past the demote threshold',
  );

  // the queue drains: one poll at position 2 — the transition arm must bump immediately
  const beforeTransitionMs = lastHeartbeatAtMs;
  poll(2);
  assert.ok(
    lastHeartbeatAtMs > beforeTransitionMs,
    'the near-head transition arm bumps the heartbeat on arrival at position <= 2',
  );

  // next poll would see head; done-worktree then runs its ~26 s pre-queue preflight —
  // the exact window the plan-1999 incident's four demotes fired in. (Conservative: the
  // head-exit refresh the watcher ALSO does is deliberately not credited here.)
  const headArrivalMs = now;
  const preflightMs = 26_000;
  const entries = [
    {
      slug: '2085-slug',
      lane: 'code',
      session: '1',
      host: 'h1',
      enqueuedIso: new Date(t0).toISOString(),
      heartbeatIso: new Date(lastHeartbeatAtMs).toISOString(),
    },
    {
      slug: 'waiter-behind',
      lane: 'code',
      session: '2',
      host: 'h2',
      enqueuedIso: new Date(t0).toISOString(),
      heartbeatIso: new Date(t0).toISOString(),
    },
  ];
  const v = demoteVerdict({
    entries,
    demoter: 'waiter-behind',
    nowMs: headArrivalMs + preflightMs,
  });
  assert.equal(v.ok, false, 'a self-armed head must not be demote-eligible during preflight');
  assert.match(v.reason, /fresh/);

  // Counterfactual — the pre-2085 behavior (heartbeat never bumped since enqueue) WAS
  // demote-eligible in the same window: proves this test actually pins the livelock.
  const stale = demoteVerdict({
    entries: [{ ...entries[0], heartbeatIso: new Date(t0).toISOString() }, entries[1]],
    demoter: 'waiter-behind',
    nowMs: headArrivalMs + preflightMs,
  });
  assert.equal(
    stale.ok,
    true,
    'without the self-arm the same wait was demote-eligible (the livelock)',
  );
});

test('plan 2085: HEAD_EXIT_REFRESH_MIN_AGE_MS is a short dedupe window, far under the self-arm cadence', () => {
  assert.ok(
    HEAD_EXIT_REFRESH_MIN_AGE_MS < SELF_ARM_HEARTBEAT_SEC * 1000,
    'the head-exit dedupe window must be shorter than the self-arm cadence or the refresh never fires',
  );
});

// Loop wiring: the terminal HEAD poll refreshes the queue heartbeat before exit (no
// prior write this run → the gate fires; the write itself is a no-op under the fake-
// status dry trace, same as every other heartbeat in fake mode). Also pins the plan-2085
// banner fix: a FLAGLESS launch must report the self-armed near-head cadence, not
// silence (review [3] — the silence is what sent operators reaching for the flag).
test('plan 2085: CLI — head exit logs the pre-exit heartbeat refresh', () => {
  const r = spawnSync('node', [CLI, 'demo-slug', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LQW_FAKE_STATUS_JSON: JSON.stringify({
        slug: 'demo-slug',
        position: 1,
        total: 2,
        head: 'demo-slug',
      }),
    },
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /refreshing queue heartbeat before exit \(plan 2085\)/);
  // plan 3422 D3: the deep-position clause used to read "off" on a flagless launch. It now
  // reports a live cadence, because DEFAULT_HEARTBEAT_SEC is the self-arm cadence — the banner
  // is the operator's only view of what the watcher will actually do, so it has to say so.
  assert.match(
    r.stderr,
    /heartbeat at deep positions: every \d+s, self-armed every \d+s at position <=2 \(plan 2085\)/,
    'the flagless startup banner must report BOTH the deep-position and near-head cadences',
  );
});

// ── plan 1682: demoteSentinelStep — the demote-sentinel's pure clock bookkeeping ──
// (review 1682 [5]) The invariants pinned here are exactly the regressions the review
// named: resetting the observation clock on a mere re-poll, failing to gate on
// kind === 'waiting', and ignoring the retry throttle.

test('demoteSentinelStep — a head CHANGE resets the observation clock and never attempts', () => {
  const s = demoteSentinelStep({
    head: 'new-head',
    kind: 'waiting',
    nowMs: 1_000_000,
    observedHead: 'old-head',
    headSinceMs: 0,
    nextDemoteMs: 0,
  });
  assert.equal(s.attempt, false);
  assert.equal(s.observedHead, 'new-head');
  assert.equal(s.headSinceMs, 1_000_000, 'clock restarts at the change');
});

test('demoteSentinelStep — a re-poll of the SAME head does NOT reset the clock; attempts only past staleMs', () => {
  const staleMs = 15 * 60_000;
  const t0 = 1_000_000;
  // under the threshold: no attempt, clock untouched
  const early = demoteSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t0 + staleMs - 1,
    observedHead: 'hog',
    headSinceMs: t0,
    nextDemoteMs: 0,
  });
  assert.equal(early.attempt, false);
  assert.equal(early.headSinceMs, t0, 're-poll must not restart the observation clock');
  // past the threshold: attempt, and the retry gate advances
  const due = demoteSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t0 + staleMs,
    observedHead: 'hog',
    headSinceMs: t0,
    nextDemoteMs: 0,
  });
  assert.equal(due.attempt, true);
  assert.equal(due.nextDemoteMs, t0 + staleMs + DEMOTE_RETRY_MS);
});

test('demoteSentinelStep — only waiting polls attempt; head/gone kinds never do', () => {
  for (const kind of ['head', 'gone']) {
    const s = demoteSentinelStep({
      head: 'hog',
      kind,
      nowMs: 100 * 60_000,
      observedHead: 'hog',
      headSinceMs: 0,
      nextDemoteMs: 0,
    });
    assert.equal(s.attempt, false, `kind=${kind} must never attempt`);
  }
});

test('demoteSentinelStep — attempts are throttled by nextDemoteMs regardless of outcome', () => {
  const staleMs = 15 * 60_000;
  const t1 = 100 * 60_000;
  const first = demoteSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t1,
    observedHead: 'hog',
    headSinceMs: 0,
    nextDemoteMs: 0,
    staleMs,
  });
  assert.equal(first.attempt, true);
  // next poll lands inside the retry window → suppressed, gate unchanged
  const inWindow = demoteSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t1 + DEMOTE_RETRY_MS - 1,
    observedHead: 'hog',
    headSinceMs: 0,
    nextDemoteMs: first.nextDemoteMs,
    staleMs,
  });
  assert.equal(inWindow.attempt, false);
  assert.equal(inWindow.nextDemoteMs, first.nextDemoteMs);
  // once the window passes, the attempt fires again
  const after = demoteSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t1 + DEMOTE_RETRY_MS,
    observedHead: 'hog',
    headSinceMs: 0,
    nextDemoteMs: first.nextDemoteMs,
    staleMs,
  });
  assert.equal(after.attempt, true);
});

// ── plan 2266: stealSentinelStep — the same pure clock bookkeeping, for the mechanical
// steal attempt. Mirrors the demoteSentinelStep suite above exactly (shared core —
// sentinelStep — so a regression in one would show in both); the one behavioral
// difference pinned here is the STALE threshold (45 min, not 15) and its OWN clock never
// being confused with the demote sentinel's.

test('stealSentinelStep — a head CHANGE resets the observation clock and never attempts', () => {
  const s = stealSentinelStep({
    head: 'new-head',
    kind: 'waiting',
    nowMs: 1_000_000,
    observedHead: 'old-head',
    headSinceMs: 0,
    nextStealMs: 0,
  });
  assert.equal(s.attempt, false);
  assert.equal(s.observedHead, 'new-head');
  assert.equal(s.headSinceMs, 1_000_000, 'clock restarts at the change');
});

test('stealSentinelStep — a re-poll of the SAME head does NOT reset the clock; attempts only past the 45-min staleMs', () => {
  const staleMs = DEFAULT_STEAL_STALE_MIN * 60_000;
  const t0 = 1_000_000;
  const early = stealSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t0 + staleMs - 1,
    observedHead: 'hog',
    headSinceMs: t0,
    nextStealMs: 0,
  });
  assert.equal(early.attempt, false);
  assert.equal(early.headSinceMs, t0, 're-poll must not restart the observation clock');
  const due = stealSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t0 + staleMs,
    observedHead: 'hog',
    headSinceMs: t0,
    nextStealMs: 0,
  });
  assert.equal(due.attempt, true);
  assert.equal(due.nextStealMs, t0 + staleMs + STEAL_RETRY_MS);
});

test('stealSentinelStep — only waiting polls attempt; head/gone kinds never do', () => {
  for (const kind of ['head', 'gone']) {
    const s = stealSentinelStep({
      head: 'hog',
      kind,
      nowMs: 100 * 60_000,
      observedHead: 'hog',
      headSinceMs: 0,
      nextStealMs: 0,
    });
    assert.equal(s.attempt, false, `kind=${kind} must never attempt`);
  }
});

test('stealSentinelStep — attempts are throttled by nextStealMs regardless of outcome', () => {
  const staleMs = DEFAULT_STEAL_STALE_MIN * 60_000;
  const t1 = 100 * 60_000;
  const first = stealSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t1,
    observedHead: 'hog',
    headSinceMs: 0,
    nextStealMs: 0,
    staleMs,
  });
  assert.equal(first.attempt, true);
  const inWindow = stealSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t1 + STEAL_RETRY_MS - 1,
    observedHead: 'hog',
    headSinceMs: 0,
    nextStealMs: first.nextStealMs,
    staleMs,
  });
  assert.equal(inWindow.attempt, false);
  assert.equal(inWindow.nextStealMs, first.nextStealMs);
  const after = stealSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t1 + STEAL_RETRY_MS,
    observedHead: 'hog',
    headSinceMs: 0,
    nextStealMs: first.nextStealMs,
    staleMs,
  });
  assert.equal(after.attempt, true);
});

test('stealSentinelStep — the 45-min steal threshold is longer than the 15-min demote threshold, so a hog is demoted well before it would ever be mechanically stolen', () => {
  assert.ok(DEFAULT_STEAL_STALE_MIN > DEFAULT_DEMOTE_STALE_MIN);
});

// ── plan 2275: overtakeSentinelStep (pure overtake-attempt decision) ───────────────

test('plan 2275: overtakeSentinelStep fires only when waiting + 🟩 lane + HOLDING head + throttle elapsed', () => {
  const base = {
    kind: 'waiting',
    nowMs: 1_000_000,
    nextOvertakeMs: 0,
    lane: '🟩',
    headState: 'HOLDING',
  };
  const fired = overtakeSentinelStep(base);
  assert.equal(fired.attempt, true);
  assert.equal(
    fired.nextOvertakeMs,
    base.nowMs + OVERTAKE_RETRY_MS,
    'throttle advances on a fired attempt',
  );
  // each gate individually suppresses the attempt WITHOUT advancing the throttle
  for (const gate of [
    { kind: 'head' },
    { kind: 'gone' },
    { lane: '🟥' },
    { lane: null },
    { headState: null },
    { headState: '' },
    { nextOvertakeMs: base.nowMs + 1 },
  ]) {
    const r = overtakeSentinelStep({ ...base, ...gate });
    assert.equal(r.attempt, false, `gated out by ${JSON.stringify(gate)}`);
    assert.equal(
      r.nextOvertakeMs,
      gate.nextOvertakeMs ?? base.nextOvertakeMs,
      'a gated-out poll must not push the next eligibility window back',
    );
  }
});

test('plan 2275: overtakeSentinelStep throttle — a fired attempt suppresses the next poll until retryMs elapses', () => {
  const t0 = 5_000_000;
  const args = { kind: 'waiting', lane: '🟩', headState: 'HOLDING' };
  const first = overtakeSentinelStep({ ...args, nowMs: t0, nextOvertakeMs: 0 });
  assert.equal(first.attempt, true);
  const tooSoon = overtakeSentinelStep({
    ...args,
    nowMs: t0 + OVERTAKE_RETRY_MS - 1,
    nextOvertakeMs: first.nextOvertakeMs,
  });
  assert.equal(tooSoon.attempt, false);
  const due = overtakeSentinelStep({
    ...args,
    nowMs: t0 + OVERTAKE_RETRY_MS,
    nextOvertakeMs: first.nextOvertakeMs,
  });
  assert.equal(due.attempt, true);
});

// ── plan 2331 (sonnet-review fix): reapSentinelStep — the same pure clock bookkeeping,
// for the auto-reap attempt. Mirrors the stealSentinelStep suite above exactly (shared
// core — sentinelStep — so a regression in one would show in both). This suite exists
// because the review caught that reap had been wired ONLY into done-worktree.mjs's
// in-process --wait loop — which this file's own header comment (line 71-74) already
// documents as dormant in the real flow, since a normal self-managed wait launches THIS
// watcher detached instead — so reap structurally never fired for the predominant wait
// path until this sentinel + its wiring into the main loop were added.

test('reapSentinelStep — a head CHANGE resets the observation clock and never attempts', () => {
  const s = reapSentinelStep({
    head: 'new-head',
    kind: 'waiting',
    nowMs: 1_000_000,
    observedHead: 'old-head',
    headSinceMs: 0,
    nextReapMs: 0,
  });
  assert.equal(s.attempt, false);
  assert.equal(s.observedHead, 'new-head');
  assert.equal(s.headSinceMs, 1_000_000, 'clock restarts at the change');
});

test('reapSentinelStep — a re-poll of the SAME head does NOT reset the clock; attempts only past the 45-min staleMs', () => {
  const staleMs = DEFAULT_REAP_STALE_MIN * 60_000;
  const t0 = 1_000_000;
  const early = reapSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t0 + staleMs - 1,
    observedHead: 'hog',
    headSinceMs: t0,
    nextReapMs: 0,
  });
  assert.equal(early.attempt, false);
  assert.equal(early.headSinceMs, t0, 're-poll must not restart the observation clock');
  const due = reapSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t0 + staleMs,
    observedHead: 'hog',
    headSinceMs: t0,
    nextReapMs: 0,
  });
  assert.equal(due.attempt, true);
  assert.equal(due.nextReapMs, t0 + staleMs + REAP_RETRY_MS);
});

test('reapSentinelStep — only waiting polls attempt; head/gone kinds never do', () => {
  for (const kind of ['head', 'gone']) {
    const s = reapSentinelStep({
      head: 'hog',
      kind,
      nowMs: 100 * 60_000,
      observedHead: 'hog',
      headSinceMs: 0,
      nextReapMs: 0,
    });
    assert.equal(s.attempt, false, `kind=${kind} must never attempt`);
  }
});

test('reapSentinelStep — attempts are throttled by nextReapMs regardless of outcome', () => {
  const staleMs = DEFAULT_REAP_STALE_MIN * 60_000;
  const t1 = 100 * 60_000;
  const first = reapSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t1,
    observedHead: 'hog',
    headSinceMs: 0,
    nextReapMs: 0,
    staleMs,
  });
  assert.equal(first.attempt, true);
  const inWindow = reapSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t1 + REAP_RETRY_MS - 1,
    observedHead: 'hog',
    headSinceMs: 0,
    nextReapMs: first.nextReapMs,
    staleMs,
  });
  assert.equal(inWindow.attempt, false);
  assert.equal(inWindow.nextReapMs, first.nextReapMs);
  const after = reapSentinelStep({
    head: 'hog',
    kind: 'waiting',
    nowMs: t1 + REAP_RETRY_MS,
    observedHead: 'hog',
    headSinceMs: 0,
    nextReapMs: first.nextReapMs,
    staleMs,
  });
  assert.equal(after.attempt, true);
});

test('reapSentinelStep — the 45-min reap threshold matches the mechanical-steal threshold (both target a dead head, just verified two different ways)', () => {
  assert.equal(DEFAULT_REAP_STALE_MIN, DEFAULT_STEAL_STALE_MIN);
});

// plan 2551 (review round 2): the freshness ceiling must exceed the worst-case runtime of the
// thing it guards — a keep-hot `--prep` IS the full gate battery, run synchronously by this
// watcher. battery-lock.mjs already derives that worst case (retry included) and encodes it as
// DEFAULT_STALE_MIN for exactly the same reason, so the two are pinned together here rather than
// left as two independently-drifting numbers. A ceiling BELOW the battery would mark a watcher
// stale precisely while it was doing the most useful work it ever does.
test('plan 2551: the pidfile freshness ceiling clears the battery-lock stale ceiling it shadows', async () => {
  const { DEFAULT_STALE_MIN } = await import('./battery-lock.mjs');
  assert.ok(
    WATCHER_PIDFILE_MAX_AGE_MS >= DEFAULT_STALE_MIN * 60_000,
    `watcher pidfile ceiling ${WATCHER_PIDFILE_MAX_AGE_MS / 60000}m must be >= battery-lock's ` +
      `${DEFAULT_STALE_MIN}m worst-case battery ceiling — a shorter one declares a watcher dead ` +
      `while its own --prep gate battery is still legitimately running`,
  );
});

// ── plan 2738: a prep may never starve the poll loop ─────────────────────────────────────────
//
// THE INCIDENT (2026-08-02, plan 2718's land). keep-hot's prep was a SYNCHRONOUS execFileSync
// inside this loop, so for the prep's whole ~15-27 min the watcher could not poll: it could not
// see that it had reached head, could not exit (so the session was never woken), and could not bump
// the queue heartbeat — while the head slot it held blocked everyone behind it. Result: 36 min at
// head un-woken, heartbeat 10 min stale, found by the operator rather than by any wake. These cases
// pin the three decisions that make the prep supervised instead of blocking.

test('plan 2738: keepHotShouldPrep — an in-flight prep blocks a second one', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  // The gate the synchronous version never needed: master can advance twice inside one prep, and a
  // rival prep against the same worktree would be refused BUSY by the per-slug lock — manufacturing
  // exactly the infrastructure exit class the watcher now treats as alarming.
  assert.equal(
    keepHotShouldPrep({
      enabled: true,
      kind: 'waiting',
      tip: B,
      lastPreppedTip: A,
      prepRunning: true,
    }),
    false,
  );
  assert.equal(
    keepHotShouldPrep({
      enabled: true,
      kind: 'waiting',
      tip: B,
      lastPreppedTip: A,
      prepRunning: false,
    }),
    true,
  );
  // default false ⇒ every pre-2738 caller and test keeps its exact meaning
  assert.equal(
    keepHotShouldPrep({ enabled: true, kind: 'waiting', tip: B, lastPreppedTip: A }),
    true,
  );
});

test('plan 2738: prepAbortReason — reaching head kills the prep instead of waiting it out', () => {
  const started = 1_000;
  const soon = started + 60_000;
  // The whole point of keep-hot is arriving at head already prepared. Once we ARE at head the prep
  // has no value left, and every second it keeps running is a second the woken session waits.
  assert.equal(
    prepAbortReason({ running: true, kind: 'head', startedMs: started, nowMs: soon }),
    'head',
  );
  // 'gone' is the same story: the slot is not ours any more, so mutating the worktree is pure risk.
  assert.equal(
    prepAbortReason({ running: true, kind: 'gone', startedMs: started, nowMs: soon }),
    'gone',
  );
  // still waiting, well inside the ceiling ⇒ let it work
  assert.equal(
    prepAbortReason({ running: true, kind: 'waiting', startedMs: started, nowMs: soon }),
    null,
  );
  // no prep in flight ⇒ nothing to abort, whatever the verdict says
  assert.equal(
    prepAbortReason({ running: false, kind: 'head', startedMs: started, nowMs: soon }),
    null,
  );
});

test('plan 2738: prepAbortReason — the wedged-prep backstop fires exactly at the bound', () => {
  // Driven by an INJECTED maxMs, not the exported constant (review finding: the first cut asserted
  // `PREP_MAX_MS === WORKTREE_LOCK_MAX_HOLD_MS`, a tautology comparing a constant to the constant it
  // was assigned from — it could not detect drift in the actual abort behaviour).
  const started = 1_000;
  const maxMs = 60_000;
  const at = (nowMs) =>
    prepAbortReason({ running: true, kind: 'waiting', startedMs: started, nowMs, maxMs });
  assert.equal(at(started + maxMs - 1), null);
  assert.equal(at(started + maxMs), 'timeout');
  // head/gone still win over the clock — the wait being over is the stronger reason.
  assert.equal(
    prepAbortReason({ running: true, kind: 'head', startedMs: started, nowMs: started, maxMs }),
    'head',
  );
});

test('plan 2738: PREP_MAX_MS is a WEDGED-prep backstop, not the lock ceiling', () => {
  // Two anchors were tried and both rejected by review: WORKTREE_LOCK_MAX_HOLD_MS (a NO-RENEWAL
  // ceiling — runLandPrep renews between phases, so pinning there kills healthy 45-minute preps,
  // i.e. exactly the long valid preps keep-hot exists to produce), then WATCHER_PIDFILE_MAX_AGE_MS
  // (right number, wrong reason — that is the duplicate-spawn suppression policy, and a re-tune of
  // it for watcher reasons would silently move this watchdog).
  //
  // So pin the RELATION, not either identity. Asserting equality with another constant is how the
  // first version of this test became a tautology, and today both happen to be 120 min — an
  // equality assertion would pass by coincidence and stop meaning anything the moment one moves.
  assert.ok(
    PREP_MAX_MS > WORKTREE_LOCK_MAX_HOLD_MS,
    `the prep backstop (${PREP_MAX_MS}ms) must exceed the lock's no-renewal ceiling ` +
      `(${WORKTREE_LOCK_MAX_HOLD_MS}ms) — a bound at or under it kills healthy renewing preps`,
  );
});

test('plan 2738: classifyPrepExit — branch failures vs machinery failures', () => {
  assert.equal(classifyPrepExit(0), 'ok');
  // CONFLICT / GATE_FAILED are real properties of the branch and DO re-surface at head.
  assert.equal(classifyPrepExit(7), 'benign');
  assert.equal(classifyPrepExit(8), 'benign');
  // plan 3274: GATE_CHUNKED (40) is a gate that ran out of its per-process cloud-chunk time budget,
  // never a real branch defect — done-worktree.mjs's own comment on the code says "re-invoke to
  // continue", never "there is nothing wrong here". It reads the same way CONFLICT/GATE_FAILED do:
  // keep-hot itself is working.
  assert.equal(classifyPrepExit(40), 'benign');
  // BUSY / ERROR mean the prep never ran: nothing was learned, nothing re-surfaces at head, and the
  // branch is silently going cold. Collapsing these into the benign line is what made 36 minutes of
  // dead keep-hot read as a healthy wait.
  assert.equal(classifyPrepExit(6), 'infra');
  assert.equal(classifyPrepExit(9), 'infra');
  // An unrecognised code (a preflight seam code, a crash, a signal death) is a fault in the
  // machinery — fail toward the extra warning, never toward hiding a stall. 10 is done-worktree.mjs's
  // own PREFLIGHT_FAIL (delta-review finding: GATE_CHUNKED used to collide with it here at 10, before
  // GATE_CHUNKED was renumbered to 40 — see PREP_EXITS' comment) — it belongs to the LAND seam/EXIT
  // range, not this map, so it stays deliberately unmapped and must classify the same as any other
  // code this file has never heard of.
  assert.equal(classifyPrepExit(10), 'infra');
  assert.equal(classifyPrepExit(undefined), 'infra');
});

test('plan 3274: prepExitReport — GATE_CHUNKED (40) is benign, does not stall-escalate, and retries', () => {
  const r = prepExitReport({ code: 40, slug: 'demo', consecutiveInfra: 2 });
  assert.equal(r.class, 'benign');
  assert.equal(r.escalate, false);
  // a chunked gate proves keep-hot RAN — it must not feed the infra-stall streak (the exact
  // mistake that let 11 consecutive escalating stalls fire against a healthy sibling in plan 2816).
  assert.equal(r.consecutiveInfra, 0);
  assert.match(r.message, /keep-hot itself is working/);
  // This code must NOT inherit the CONFLICT/GATE_FAILED template — nothing failed and nothing is
  // branch-level, so neither phrase belongs in its message (the same confusion this whole feature
  // exists to prevent one layer up: "not finished yet" read as "something broke").
  assert.doesNotMatch(r.message, /branch-level failure/);
  assert.doesNotMatch(r.message, /re-surfaces at head/);
  // It must say what actually happened: a cloud time-budget exhaustion that wants a re-invoke.
  assert.match(r.message, /cloud-chunk time budget/);
  assert.match(r.message, /re-invoke/);
  // (delta-review fix) the message's "re-invoke to continue" / "wants to be re-invoked" promise must
  // actually be kept — unlike CONFLICT/GATE_FAILED (which reproduce identically against an unchanged
  // tip, so retrying them is wasted), GATE_CHUNKED alone must ask for a retry of the SAME tip: nothing
  // else re-arms it (see the CLI acceptance test below for the end-to-end proof).
  assert.equal(r.retry, true);
});

// ── plan 3374: the row GATE_CHUNKED's own `retry: true` makes necessary. A gate that has proven
// ZERO new files for several consecutive chunk-capped rounds will not prove any on the next one, so
// re-arming the SAME tip every poll — which is exactly what GATE_CHUNKED asks for, and what the
// `infra` default would also do — is an infinite loop burning the whole 4h wait.
test('plan 3374: prepExitReport — GATE_NON_CONVERGENT is benign, does not stall-escalate, and specifically does NOT retry', () => {
  const r = prepExitReport({
    code: PREP_EXIT.GATE_NON_CONVERGENT,
    slug: 'demo',
    consecutiveInfra: 2,
  });
  assert.equal(
    r.class,
    'benign',
    'keep-hot RAN — this is a branch property, not a machinery fault',
  );
  assert.equal(r.escalate, false);
  assert.equal(r.consecutiveInfra, 0, 'must not feed the KEEP-HOT STALLED infra streak');
  // THE point of the row: unlike GATE_CHUNKED (retry: true), respinning an UNCHANGED tip here
  // reproduces the identical answer — the same rule CONFLICT/GATE_FAILED already state.
  assert.equal(r.retry, false, 'a non-convergent gate must NEVER re-arm the same tip');
  // And it must not inherit GATE_CHUNKED's "re-invoke to continue" promise, which is false here.
  assert.match(r.message, /will NOT resolve by being re-invoked/);
  assert.match(r.message, /COMMIT/);
  assert.match(r.message, /keep-hot itself is working/);
});

test('plan 3374: GATE_NON_CONVERGENT and GATE_CHUNKED are DIFFERENT prep codes with OPPOSITE retry answers', () => {
  // The structural reason the new code exists at all: had it reused GATE_CHUNKED, the watcher
  // would have re-fired the same tip on every poll for the whole wait.
  assert.notEqual(PREP_EXIT.GATE_NON_CONVERGENT, PREP_EXIT.GATE_CHUNKED);
  assert.equal(PREP_EXITS[PREP_EXIT.GATE_CHUNKED].retry, true);
  assert.equal(PREP_EXITS[PREP_EXIT.GATE_NON_CONVERGENT].retry, false);
  assert.equal(PREP_EXITS[PREP_EXIT.GATE_NON_CONVERGENT].class, 'benign');
});

test('plan 2738: prepExitReport — the benign class keeps the "re-surfaces at head" promise', () => {
  const r = prepExitReport({ code: 7, slug: 'demo', consecutiveInfra: 2 });
  assert.equal(r.class, 'benign');
  assert.match(r.message, /re-surfaces at head/);
  assert.match(r.message, /keep-hot itself is working/);
  assert.equal(r.escalate, false);
  // a branch-level failure proves keep-hot RAN, so it clears the machinery-fault streak
  assert.equal(r.consecutiveInfra, 0);
});

test('plan 2738: prepExitReport — a clean prep says nothing and resets the streak', () => {
  const r = prepExitReport({ code: 0, slug: 'demo', consecutiveInfra: 2 });
  assert.equal(r.class, 'ok');
  assert.equal(r.message, null);
  assert.equal(r.consecutiveInfra, 0);
  assert.equal(r.escalate, false);
});

test('plan 2738: prepExitReport — infra exits count up and ESCALATE, never repeat the benign line', () => {
  // The log line the incident actually needed: "keep-hot is NOT running", not "continuing to wait".
  let streak = 0;
  const seen = [];
  for (let i = 0; i < PREP_INFRA_ESCALATE_AFTER; i++) {
    const r = prepExitReport({ code: 6, slug: 'demo', consecutiveInfra: streak });
    streak = r.consecutiveInfra;
    seen.push(r);
    assert.equal(r.class, 'infra');
    assert.equal(r.consecutiveInfra, i + 1);
    assert.match(r.message, /KEEP-HOT DID NOT RUN/);
    // the benign class's reassurance must never appear on a machinery fault — that conflation IS
    // the bug (the infra line says the OPPOSITE: "nothing re-surfaces at head")
    assert.doesNotMatch(r.message, /keep-hot itself is working/);
    assert.doesNotMatch(r.message, /continuing to wait/);
  }
  assert.equal(seen[0].escalate, false, 'one collision with a sibling land is not a stall');
  assert.equal(seen.at(-1).escalate, true);
  assert.match(seen.at(-1).message, /KEEP-HOT STALLED/);
  assert.match(seen.at(-1).message, /land-prep-demo\.log/, 'points at the prep log to check');
});

test('plan 2738: prepExitReport — one success between two infra exits clears the streak', () => {
  // Otherwise a watcher that recovers would keep escalating on an old grudge.
  const a = prepExitReport({ code: 9, slug: 'demo', consecutiveInfra: 0 });
  const ok = prepExitReport({ code: 0, slug: 'demo', consecutiveInfra: a.consecutiveInfra });
  const b = prepExitReport({ code: 9, slug: 'demo', consecutiveInfra: ok.consecutiveInfra });
  assert.equal(b.consecutiveInfra, 1);
  assert.equal(b.escalate, false);
});

test('plan 3274 (delta-review fix): prepExitReport — GATE_CHUNKED repeats forever without escalating', () => {
  // Unlike an infra streak (capped at PREP_INFRA_ESCALATE_AFTER, above), a chunked gate is not a
  // machinery fault — it must keep retrying, poll after poll, for the whole wait, and NEVER print
  // KEEP-HOT STALLED. Feed it far more times than the infra cap and confirm the streak never moves.
  let streak = 0;
  for (let i = 0; i < PREP_INFRA_ESCALATE_AFTER * 3; i++) {
    const r = prepExitReport({ code: 40, slug: 'demo', consecutiveInfra: streak });
    streak = r.consecutiveInfra;
    assert.equal(r.consecutiveInfra, 0, `iteration ${i} must not accumulate a streak`);
    assert.equal(r.escalate, false, `iteration ${i} must never escalate`);
    assert.equal(r.retry, true, `iteration ${i} must keep asking for a retry`);
    assert.doesNotMatch(r.message, /KEEP-HOT STALLED/);
  }
});

test('plan 2738: prepExitReport — only an INFRA exit (or GATE_CHUNKED) asks for a retry of the same tip', () => {
  // Review finding. keep-hot only fires when origin/master ADVANCES and lastPreppedTip is advanced
  // when the prep STARTS, so without this an infra failure consumes that tip's only attempt: on a
  // quiet master the branch stays cold for the whole wait AND the streak never reaches the
  // escalation threshold, because there is never a second attempt to count.
  // (delta-review fix) GATE_CHUNKED (40) is the one BENIGN code that also retries — asserted in its
  // own dedicated test above, not here, since this test's premise ("only an INFRA exit") is no
  // longer literally true and the exception deserves its own explanation, not a bare extra line.
  assert.equal(prepExitReport({ code: 6, slug: 'demo' }).retry, true);
  assert.equal(prepExitReport({ code: 9, slug: 'demo' }).retry, true);
  assert.equal(prepExitReport({ code: 99, slug: 'demo' }).retry, true, 'unknown ⇒ infra ⇒ retry');
  // …but the retry is CAPPED at the escalation threshold, not an unbounded respin. An unrecognised
  // code covers the preflight seam range, where a dirty worktree makes every attempt pay a ~26 s
  // preflight before failing identically — uncapped that is one done-worktree spawn per poll for the
  // rest of a multi-hour wait, for a condition that will not fix itself. (Two pre-existing CLI tests
  // in this file spawn a REAL prep, and an uncapped retry made them respin it every poll.)
  assert.equal(
    prepExitReport({ code: 6, slug: 'demo', consecutiveInfra: PREP_INFRA_ESCALATE_AFTER - 1 })
      .retry,
    false,
    'once the loud STALLED line is printed, spinning further costs more and says nothing new',
  );
  // A conflict against an UNCHANGED tip reproduces identically, so respinning it would burn the
  // wait re-deriving the same answer.
  assert.equal(prepExitReport({ code: 7, slug: 'demo' }).retry, false);
  assert.equal(prepExitReport({ code: 8, slug: 'demo' }).retry, false);
  assert.equal(prepExitReport({ code: 0, slug: 'demo' }).retry, false);
});

test('plan 2738: PREP_EXITS is ONE row per code — class and label cannot drift apart', () => {
  // Two parallel maps (the first cut) let a renumbered code be updated in one and not the other,
  // surfacing as a correct class beside an "unexpected exit" label, or the reverse.
  for (const [code, row] of Object.entries(PREP_EXITS)) {
    assert.ok(row.class && row.label, `exit ${code} needs both a class and a label`);
    assert.equal(classifyPrepExit(Number(code)), row.class);
    assert.match(prepExitReport({ code: Number(code), slug: 'demo' }).message ?? 'prepared', /\S/);
  }
});

// plan 3274 (review round, F3/PLAUSIBLE): this file used to hardcode `40` as the GATE_CHUNKED row
// key while done-worktree.mjs's own PREP_EXIT.GATE_CHUNKED defined the canonical value — this
// branch already shipped ONE exit-code collision (GATE_CHUNKED=10 vs EXIT[SEAM.PREFLIGHT_FAIL]=10)
// from two places disagreeing about a number, so a second re-typed literal here is worth closing.
// SOURCE-INSPECTED (mirrors done-worktree.test.mjs's own established technique for pinning a wiring
// fact without a runtime coincidence masking a drift): a plain `assert.equal(PREP_EXITS[40], ...)`
// would still pass even if this file's `40` silently diverged from PREP_EXIT.GATE_CHUNKED (unlikely
// today, but exactly the class of drift a renumber could reintroduce) — reading the row key must
// come from the shared PREP_EXIT.GATE_CHUNKED reference, not a coincidentally-equal literal.
test('plan 3274 (F3 review fix): PREP_EXITS keys its GATE_CHUNKED row off the shared PREP_EXIT.GATE_CHUNKED, never a re-typed literal', () => {
  const src = readFileSync(CLI, 'utf8');
  assert.match(
    src,
    /\[PREP_EXIT\.GATE_CHUNKED\]:\s*\{/,
    'the GATE_CHUNKED row in PREP_EXITS must be keyed by [PREP_EXIT.GATE_CHUNKED], imported from ' +
      'done-worktree-lib.mjs — not a hand-typed 40',
  );
  assert.doesNotMatch(
    src,
    /\n\s*40:\s*\{/,
    'no bare `40:` object-literal key may remain for this row — that is exactly the re-typed ' +
      'literal this fix closes',
  );
  // Runtime sanity: the live map still actually has a row at PREP_EXIT.GATE_CHUNKED (40), with the
  // same benign/retry shape the rest of this file's tests already exercise via the literal `40`.
  assert.equal(PREP_EXIT.GATE_CHUNKED, 40);
  assert.equal(PREP_EXITS[PREP_EXIT.GATE_CHUNKED]?.class, 'benign');
  assert.equal(PREP_EXITS[PREP_EXIT.GATE_CHUNKED]?.retry, true);
});

// plan 3274 (findings f96036 / ae1359 / dc67a0 / 4c58da, all CONFIRMED): the fix above closed the
// drift for GATE_CHUNKED alone — every OTHER row (0/5/6/7/8/9) still hardcoded its exit code as a
// bare numeric object-literal key, `PREP_EXIT_BUSY` still re-typed `6` as its own literal instead of
// reading `PREP_EXIT.BUSY`, and the GATE_CHUNKED operator message still spelled out `40` in a plain
// string. Any one of those left a renumber able to move classification (which reads through
// PREP_EXIT) while a row/constant/message stayed pinned to the OLD number — exactly what already
// happened once for GATE_CHUNKED (10 -> 40) before that row alone was fixed. This test pins the
// de-duplication for the WHOLE map, not just one row, using the same source-inspection technique as
// the test above (a bare `assert.equal(PREP_EXITS[6], ...)` would still pass even if this file's `6`
// had silently diverged from PREP_EXIT.BUSY — reading must come from the shared reference, not a
// coincidentally-equal literal) plus a runtime check that behaviour at TODAY's numbers is unchanged.
test('plan 3274 (f96036/ae1359/dc67a0/4c58da fix): every PREP_EXITS row, PREP_EXIT_BUSY, and the GATE_CHUNKED message are derived from the shared PREP_EXIT map — no exit code is a re-typed literal', () => {
  const src = readFileSync(CLI, 'utf8');
  const start = src.indexOf('export const PREP_EXITS = Object.freeze({');
  const end = src.indexOf('\nexport function classifyPrepExit', start);
  assert.ok(start >= 0 && end > start, 'could not locate the PREP_EXITS block to inspect');
  const prepExitsBlock = src.slice(start, end);

  // Every row must be keyed [PREP_EXIT.<NAME>] — never a bare `N:` literal. This regex would catch a
  // renumber that left ANY row (not just GATE_CHUNKED) behind on its old number.
  assert.doesNotMatch(
    prepExitsBlock,
    /\n\s*\d+:\s*\{/,
    'a bare numeric object-literal key remains in PREP_EXITS — every row must be keyed off ' +
      'PREP_EXIT.<NAME> instead, or a renumber of that code silently stops matching this row',
  );
  // plan 3374: DERIVED from the shared map, not a hand-typed whitelist. The list used to be
  // literal, which meant a NEW prep exit code (this plan added GATE_NON_CONVERGENT) got no
  // coverage here at all until someone remembered to extend it — the same "two places disagree
  // about the map" drift this whole test exists to catch, one level up. Now every PREP_EXIT name
  // must have a row keyed off the shared reference, and a future addition is covered on arrival.
  const prepExitNames = Object.keys(PREP_EXIT);
  assert.ok(
    prepExitNames.length >= 8,
    'sanity: the shared PREP_EXIT map was read, not an empty {}',
  );
  for (const name of prepExitNames) {
    assert.match(
      prepExitsBlock,
      new RegExp(`\\[PREP_EXIT\\.${name}\\]:\\s*\\{`),
      `PREP_EXITS is missing a row keyed [PREP_EXIT.${name}]`,
    );
  }

  // The GATE_CHUNKED operator message must interpolate the code, never spell it out — a renumber
  // must not leave the diagnosis naming the OLD exit code while classification already moved.
  assert.doesNotMatch(
    prepExitsBlock,
    /exited 40\b/,
    'the GATE_CHUNKED message hardcodes exit code 40 instead of interpolating PREP_EXIT.GATE_CHUNKED',
  );
  assert.match(
    prepExitsBlock,
    /exited \$\{PREP_EXIT\.GATE_CHUNKED\}/,
    'the GATE_CHUNKED message must interpolate ${PREP_EXIT.GATE_CHUNKED}',
  );

  // PREP_EXIT_BUSY must be DEFINED as PREP_EXIT.BUSY, not a re-typed literal `6` — the same class of
  // drift as the rows above, for the one exit code that also has its own exported constant.
  assert.match(
    src,
    /export const PREP_EXIT_BUSY = PREP_EXIT\.BUSY;/,
    'PREP_EXIT_BUSY must be defined as PREP_EXIT.BUSY, not a literal',
  );

  // Runtime sanity: behaviour at TODAY's numbers is completely unchanged — this is a
  // de-duplication, not a semantics change. Every class/retry value matches what the rest of this
  // file already exercises via classifyPrepExit/prepExitReport.
  assert.equal(PREP_EXIT_BUSY, PREP_EXIT.BUSY);
  assert.equal(PREP_EXIT_BUSY, 6);
  assert.equal(classifyPrepExit(PREP_EXIT.OK), 'ok');
  assert.equal(classifyPrepExit(PREP_EXIT.DETACHED_STAMP), 'infra');
  assert.equal(classifyPrepExit(PREP_EXIT.BUSY), 'infra');
  assert.equal(classifyPrepExit(PREP_EXIT.CONFLICT), 'benign');
  assert.equal(classifyPrepExit(PREP_EXIT.GATE_FAILED), 'benign');
  assert.equal(classifyPrepExit(PREP_EXIT.ERROR), 'infra');
  assert.equal(classifyPrepExit(PREP_EXIT.GATE_CHUNKED), 'benign');
  // ...and the sibling-prep stand-down predicate still gates on the SAME BUSY value the map uses —
  // this is the f96036 finding's own reproduction: feed it a genuine live same-slug sibling under
  // the CANONICAL code (PREP_EXIT.BUSY, not the file's own re-typed `6`) and confirm the stand-down
  // still fires. Before this fix, `keepHotBusyStandDown`'s `code !== PREP_EXIT_BUSY` guard compared
  // against a constant that happened to equal 6 today but would NOT have tracked a BUSY renumber —
  // exactly the false-alarm shape f96036 describes.
  const liveSibling = {
    entry: {
      owner: 'prep',
      slug: 'demo',
      pid: 1,
      host: 'test-host',
      startedIso: '2026-08-04T10:00:00.000Z',
    },
    live: true,
  };
  const standDown = keepHotBusyStandDown({
    code: PREP_EXIT.BUSY,
    slug: 'demo',
    holder: liveSibling,
    nowMs: Date.parse('2026-08-04T10:05:00.000Z'), // 5 min in — well under the wedged backstop
  });
  assert.ok(standDown, 'a live same-slug sibling under PREP_EXIT.BUSY must stand down, not alarm');
  assert.equal(standDown.wedged, false);
});

test('plan 2738: fakeStatusFor — a payload ARRAY is a per-poll script, last entry repeating', () => {
  const one = JSON.stringify({ position: 2, total: 3 });
  assert.equal(fakeStatusFor(one, 0), one, 'a single payload keeps its plan-968 meaning');
  assert.equal(fakeStatusFor(one, 7), one);
  const script = JSON.stringify([{ position: 3 }, { position: 2 }, { position: 1 }]);
  assert.equal(JSON.parse(fakeStatusFor(script, 0)).position, 3);
  assert.equal(JSON.parse(fakeStatusFor(script, 1)).position, 2);
  assert.equal(JSON.parse(fakeStatusFor(script, 2)).position, 1);
  // past the end the queue simply stops moving — never an out-of-range crash mid-trace
  assert.equal(JSON.parse(fakeStatusFor(script, 9)).position, 1);
  assert.throws(() => fakeStatusFor('[]', 0), /empty poll script/);
});

// ── plan 2738 acceptance: THE STALL ITSELF, end to end ───────────────────────────────────────
//
// The plan's first verification bullet: "with a deliberately long prep, confirm the watcher still
// detects head and exits within one poll interval." LQW_FAKE_PREP_SLEEP_MS stands a real sleeping
// child in for the ~15-27 min gate battery, driven through the real spawn / supervise / tree-kill
// path; the status script moves the queue from position 2 to head UNDERNEATH it.
//
// Pre-2738 this exact scenario is the 2026-08-02 incident: the prep was an execFileSync, so the
// watcher would sit inside it for the full sleep, never re-poll, never see head, never exit, and
// never wake the session. The wall-clock assertion is what actually separates the two: the run must
// finish in far less than the prep's own duration.
test('plan 2738 acceptance: a long prep does NOT starve head detection — the watcher still wakes', () => {
  const PREP_MS = 60_000; // stands in for the multi-minute gate battery
  const started = Date.now();
  let code = 0;
  let stderr = '';
  let stdout = '';
  try {
    stdout = execFileSync(
      'node',
      [CLI, 'demo-slug', '--interval', '1', '--near-interval', '1', '--timeout', '120', '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          // poll 1: waiting at position 2 ⇒ start the prep. poll 2: HEAD, while it is still running.
          LQW_FAKE_STATUS_JSON: JSON.stringify([
            { slug: 'demo-slug', position: 2, total: 3, head: 'other' },
            { slug: 'demo-slug', position: 1, total: 3, head: 'demo-slug' },
          ]),
          LQW_FAKE_ORIGIN_TIP: 'a'.repeat(40),
          LQW_FAKE_PREP_SLEEP_MS: String(PREP_MS),
        },
      },
    );
  } catch (e) {
    code = e.status;
    stderr = e.stderr || '';
    stdout = e.stdout || '';
  }
  const elapsed = Date.now() - started;
  assert.equal(code, 0, `head reached ⇒ exit 0 (stderr: ${stderr})`);
  assert.match(stdout, /"kind":"head"/);
  assert.ok(
    // ambient-load-ok: duration IS the property — "woke early" vs "blocked for the prep's full
    // 60s" is a claim about elapsed time and has no event-order or exit-code equivalent, and the
    // subject is a real spawned child so an injected clock cannot drive it. The bound is expressed
    // as a FRACTION of the thing it must beat (PREP_MS / 2 = 30s) rather than a tuned figure, and a
    // healthy wake lands in milliseconds, so the margin is ~3 orders of magnitude.
    elapsed < PREP_MS / 2,
    `the watcher woke in ${elapsed}ms — pre-2738 it would have blocked for the prep's full ` +
      `${PREP_MS}ms and woken nobody`,
  );
});

test('plan 2738 acceptance: an infra-failed prep retries on a LATER poll, and stops at the cap', () => {
  // Two properties in one trace. (a) A BUSY prep must be re-attempted even though origin/master has
  // not moved — otherwise that tip's only attempt is spent and the branch stays cold. (b) The
  // retries must be SPACED (review round 2: re-arming the tip inside the same poll fired them
  // back-to-back and burned the escalation budget instantly) and CAPPED, so a permanently-broken
  // prep cannot spawn done-worktree once per poll for a multi-hour wait.
  let stderr = '';
  try {
    execFileSync(
      'node',
      [CLI, 'demo-slug', '--interval', '1', '--near-interval', '1', '--timeout', '9'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          LQW_FAKE_STATUS_JSON: JSON.stringify({
            slug: 'demo-slug',
            position: 2,
            total: 3,
            head: 'other',
          }),
          LQW_FAKE_ORIGIN_TIP: 'a'.repeat(40), // never advances — only the retry can re-fire a prep
          LQW_FAKE_PREP: '6', // BUSY: the worktree lock is held, keep-hot did not run
        },
      },
    );
  } catch (e) {
    stderr = e.stderr || '';
  }
  const starts = (stderr.match(/running done-worktree --prep/g) || []).length;
  assert.ok(
    starts > 1,
    `an infra failure must be retried on an unchanged tip, saw ${starts} starts`,
  );
  assert.equal(
    starts,
    PREP_INFRA_ESCALATE_AFTER,
    `retries stop at the escalation cap (${PREP_INFRA_ESCALATE_AFTER}); saw ${starts} over ~9 polls`,
  );
  assert.match(stderr, /KEEP-HOT STALLED/, 'and the cap coincides with the loud line');
});

test('plan 3274 (delta-review fix) acceptance: a GATE_CHUNKED prep actually gets re-invoked, never stalls', () => {
  // The finding this test pins: before this fix, GATE_CHUNKED (40) classified benign with
  // retry:false — its own message promised "the gate wants to be re-invoked to keep checking", but
  // nothing re-armed lastPreppedTip for the SAME tip, so on a quiet master (exactly this trace:
  // LQW_FAKE_ORIGIN_TIP never advances) the chunk-and-resume loop never actually continued. Same
  // shape as the BUSY-retry acceptance test above, EXCEPT here the retries must NOT stop at
  // PREP_INFRA_ESCALATE_AFTER and must NEVER print KEEP-HOT STALLED — a chunked gate is not a
  // machinery fault.
  let stderr = '';
  try {
    execFileSync(
      'node',
      [CLI, 'demo-slug', '--interval', '1', '--near-interval', '1', '--timeout', '9'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          LQW_FAKE_STATUS_JSON: JSON.stringify({
            slug: 'demo-slug',
            position: 2,
            total: 3,
            head: 'other',
          }),
          LQW_FAKE_ORIGIN_TIP: 'a'.repeat(40), // never advances — only the retry can re-fire a prep
          LQW_FAKE_PREP: '40', // GATE_CHUNKED: ran out of cloud-chunk budget, wants a re-invoke
        },
      },
    );
  } catch (e) {
    stderr = e.stderr || '';
  }
  const starts = (stderr.match(/running done-worktree --prep/g) || []).length;
  assert.ok(
    starts > PREP_INFRA_ESCALATE_AFTER,
    `a chunked prep must keep being re-invoked past where an infra fault would have capped ` +
      `(${PREP_INFRA_ESCALATE_AFTER}); saw only ${starts} starts over ~9 polls`,
  );
  assert.doesNotMatch(
    stderr,
    /KEEP-HOT STALLED/,
    'a chunked gate must never escalate — it is proof keep-hot is working, not a machinery fault',
  );
  assert.match(stderr, /cloud-chunk time budget/, 'and the benign reason is logged each time');
});

// The plan's third verification bullet, as the property that actually produced the 10-min-stale
// heartbeat: the heartbeat is bumped from inside the poll loop, so "does the heartbeat keep
// advancing across a multi-minute prep" IS "does the loop keep going round". Pin the loop.
test('plan 2738 acceptance: the poll loop keeps its cadence for the whole prep', () => {
  const PREP_MS = 20_000;
  let stderr = '';
  try {
    execFileSync(
      'node',
      [CLI, 'demo-slug', '--interval', '1', '--near-interval', '1', '--timeout', '4'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          LQW_FAKE_STATUS_JSON: JSON.stringify({
            slug: 'demo-slug',
            position: 2,
            total: 3,
            head: 'other',
          }),
          LQW_FAKE_ORIGIN_TIP: 'a'.repeat(40),
          LQW_FAKE_PREP_SLEEP_MS: String(PREP_MS),
        },
      },
    );
  } catch (e) {
    stderr = e.stderr || '';
  }
  const polls = (stderr.match(/demo-slug position 2\/3/g) || []).length;
  assert.ok(
    polls >= 3,
    `expected the loop to keep polling during the ${PREP_MS}ms prep, saw ${polls} polls — ` +
      `pre-2738 the first poll started the prep and the loop stopped there (stderr: ${stderr})`,
  );
  // and it must not spawn a rival prep on every one of those polls
  assert.equal(
    (stderr.match(/running done-worktree --prep/g) || []).length,
    1,
    'one prep in flight at a time',
  );
});

// ── plan 2816: the BUSY that is not a fault ──────────────────────────────────────────────────
//
// Plan 2551 made two preps per slug the NORMAL state (the QUEUE_WAIT seam fires a one-shot
// dispatchLandPrep AND spawns the detached watcher), while plan 2738 taught the watcher that a BUSY
// is alarming. `keepHotShouldPrep`'s prepRunning gate suppresses only the watcher's OWN rival, never
// the sibling the seam dispatched — so the alarm was manufactured on every healthy wait (11
// consecutive escalating stalls against one healthy prep on plan 2758's land, 2026-08-04).

const siblingPrep = (over = {}) => ({
  owner: 'prep',
  slug: 'demo',
  pid: 38284,
  host: 'BUILD-HOST-01',
  startedIso: '2026-08-04T10:00:00.000Z',
  heartbeatIso: '2026-08-04T10:05:07.555Z', // frozen: runLandPrep blocks the loop in sync git calls
  ...over,
});
const SIBLING_NOW = Date.parse('2026-08-04T10:20:00.000Z'); // 20 min in — a healthy mid-battery prep

test('plan 2816: keepHotBusyStandDown — a LIVE same-slug sibling prep is a stand-down, not a stall', () => {
  const r = keepHotBusyStandDown({
    code: PREP_EXIT_BUSY,
    slug: 'demo',
    holder: { entry: siblingPrep(), live: true },
    nowMs: SIBLING_NOW,
  });
  assert.ok(r, 'the designed steady state must be recognised');
  assert.equal(r.wedged, false);
  // grep-distinct prefix (spec answer 3) — the same predicate runs in the cloud drains, and
  // land-health telemetry that counts stall lines must not count these.
  assert.match(r.message, /^keep-hot stand-down:/);
  assert.doesNotMatch(r.message, /KEEP-HOT STALLED/);
  assert.doesNotMatch(r.message, /KEEP-HOT DID NOT RUN/);
  // the message must say the OPPOSITE of the false one: the sibling IS what keeps the branch hot
  assert.match(r.message, /kept HOT, not going cold/);
  // the USEFUL pointer, in place of the dangerous "check the per-slug worktree lock" one (answer 4)
  assert.match(r.message, /\.scratch\/land-prep-demo\.log/);
  assert.doesNotMatch(r.message, /worktree lock/);
  // and it names the holder through the SHARED describer, so it cannot drift from done-worktree's
  assert.match(r.message, /prep pid 38284 on BUILD-HOST-01/);
});

test('plan 2816: keepHotBusyStandDown — every OTHER holder shape falls through to the 2738 alarm', () => {
  const call = (holder) =>
    keepHotBusyStandDown({ code: PREP_EXIT_BUSY, slug: 'demo', holder, nowMs: SIBLING_NOW });
  assert.equal(call(null), null, 'nothing readable (FREE) — cannot prove a sibling');
  assert.equal(call({ entry: null, live: true }), null, 'a CORRUPT record proves nothing');
  assert.equal(call({ entry: siblingPrep(), live: false }), null, 'a STALE holder is a real fault');
  assert.equal(call({ entry: siblingPrep(), live: null }), null, 'unprovable liveness ⇒ alarm');
  assert.equal(
    call({ entry: siblingPrep({ owner: 'land' }), live: true }),
    null,
    'a LAND holding the worktree is not keep-hot being done for us',
  );
  assert.equal(
    call({ entry: siblingPrep({ slug: 'other-slug' }), live: true }),
    null,
    'a foreign slug is not our sibling',
  );
});

test('plan 2816: keepHotBusyStandDown — only a BUSY exit can be explained by a live holder', () => {
  // An ERROR (9) or an unrecognised code says nothing about the lock, so a live holder observed
  // alongside one is a coincidence. Suppressing those would close a genuine alarm.
  const holder = { entry: siblingPrep(), live: true };
  for (const code of [0, 7, 8, 9, 99]) {
    assert.equal(
      keepHotBusyStandDown({ code, slug: 'demo', holder, nowMs: SIBLING_NOW }),
      null,
      `exit ${code} must not stand down`,
    );
  }
  assert.ok(
    keepHotBusyStandDown({ code: PREP_EXIT_BUSY, slug: 'demo', holder, nowMs: SIBLING_NOW }),
  );
  assert.equal(
    PREP_EXITS[PREP_EXIT_BUSY].class,
    'infra',
    'BUSY is the infra code being carved out',
  );
});

test('plan 2816: keepHotBusyStandDown — a sibling past PREP_MAX_MS gets its OWN distinct alarm', () => {
  // Spec answer 1: closing the false positive must not close the true one. The threshold is the
  // sibling's own PREP_MAX_MS, never the 3-strike counter, and the age comes from the lock record's
  // startedIso rather than a watcher-side counter (which would only measure how long WE watched).
  const started = '2026-08-04T10:00:00.000Z';
  const wedgedNow = Date.parse(started) + PREP_MAX_MS + 60_000;
  const r = keepHotBusyStandDown({
    code: PREP_EXIT_BUSY,
    slug: 'demo',
    holder: { entry: siblingPrep({ startedIso: started }), live: true },
    nowMs: wedgedNow,
  });
  assert.equal(r.wedged, true);
  assert.match(r.message, /KEEP-HOT SIBLING PREP WEDGED/);
  assert.doesNotMatch(r.message, /^keep-hot stand-down:/);
  assert.doesNotMatch(r.message, /KEEP-HOT STALLED/, 'a distinct alarm, not the 3-strike one');
  assert.match(r.message, /\.scratch\/land-prep-demo\.log/);
  // exactly at the bound is still healthy; one ms past it is wedged
  const at = (nowMs) =>
    keepHotBusyStandDown({
      code: PREP_EXIT_BUSY,
      slug: 'demo',
      holder: { entry: siblingPrep({ startedIso: started }), live: true },
      nowMs,
    }).wedged;
  assert.equal(at(Date.parse(started) + PREP_MAX_MS), false);
  assert.equal(at(Date.parse(started) + PREP_MAX_MS + 1), true);
  // an unreadable start cannot PROVE two hours — LIVE was proved, so it stays the healthy path
  assert.equal(
    keepHotBusyStandDown({
      code: PREP_EXIT_BUSY,
      slug: 'demo',
      holder: { entry: siblingPrep({ startedIso: 'not-a-date' }), live: true },
      nowMs: wedgedNow,
    }).wedged,
    false,
  );
});

test('plan 2816: prepExitReport — a stand-down clears the streak and does NOT re-attempt the tip', () => {
  const standDown = keepHotBusyStandDown({
    code: PREP_EXIT_BUSY,
    slug: 'demo',
    holder: { entry: siblingPrep(), live: true },
    nowMs: SIBLING_NOW,
  });
  const r = prepExitReport({
    code: PREP_EXIT_BUSY,
    slug: 'demo',
    consecutiveInfra: PREP_INFRA_ESCALATE_AFTER - 1,
    standDown,
  });
  assert.equal(r.class, 'standdown', 'its own class — neither 2738 half must claim it');
  assert.equal(r.escalate, false);
  // Not merely "don't increment": a LIVE sibling is positive proof the machinery works, so leaving
  // an older streak standing would let it escalate later on a grudge the stand-down disproved.
  assert.equal(r.consecutiveInfra, 0);
  // Spec answer 2: CREDIT the sibling's prep to lastPreppedTip. Retry works by rolling the tip
  // back; not rolling it back is what stops a re-collide once per poll for the sibling's battery.
  assert.equal(r.retry, false);
  assert.match(r.message, /^keep-hot stand-down:/);
});

test('plan 2816: prepExitReport — the wedged sibling escalates, on its own message', () => {
  const started = '2026-08-04T10:00:00.000Z';
  const standDown = keepHotBusyStandDown({
    code: PREP_EXIT_BUSY,
    slug: 'demo',
    holder: { entry: siblingPrep({ startedIso: started }), live: true },
    nowMs: Date.parse(started) + PREP_MAX_MS + 1,
  });
  const r = prepExitReport({ code: PREP_EXIT_BUSY, slug: 'demo', standDown });
  assert.equal(r.class, 'standdown');
  assert.equal(r.escalate, true);
  assert.equal(r.consecutiveInfra, 0, 'its own threshold, never the 3-strike counter');
  assert.equal(r.retry, false, 'respinning cannot dislodge a holder that will not let go');
  assert.match(r.message, /KEEP-HOT SIBLING PREP WEDGED/);
});

test('plan 2816 regression: with NO stand-down every BUSY still escalates exactly as plan 2738', () => {
  // The acceptance criterion that guards the true positive. `standDown` defaults to null, so every
  // pre-2816 caller and test keeps its exact meaning.
  let streak = 0;
  let last = null;
  for (let i = 0; i < PREP_INFRA_ESCALATE_AFTER; i++) {
    last = prepExitReport({
      code: PREP_EXIT_BUSY,
      slug: 'demo',
      consecutiveInfra: streak,
      standDown: null,
    });
    streak = last.consecutiveInfra;
    assert.equal(last.class, 'infra');
    assert.equal(last.consecutiveInfra, i + 1);
  }
  assert.equal(last.escalate, true);
  assert.match(last.message, /KEEP-HOT STALLED/);
});

test('plan 2816 acceptance: the incident trace — one healthy sibling, zero stalls, one prep', () => {
  // Plan 2758's land verbatim: a queued waiter whose every keep-hot prep bounces off a LIVE sibling
  // prep on the same slug. Pre-2816 this printed 11 escalating stalls; it must now print stand-downs
  // and, because the sibling's prep is credited to lastPreppedTip, must not respin the prep at all.
  let stderr = '';
  try {
    execFileSync(
      'node',
      [CLI, 'demo-slug', '--interval', '1', '--near-interval', '1', '--timeout', '6'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          LQW_FAKE_STATUS_JSON: JSON.stringify({
            slug: 'demo-slug',
            position: 2,
            total: 3,
            head: 'other',
          }),
          LQW_FAKE_ORIGIN_TIP: 'a'.repeat(40),
          LQW_FAKE_PREP: String(PREP_EXIT_BUSY),
          LQW_FAKE_BUSY_HOLDER: JSON.stringify({
            live: true,
            entry: {
              owner: 'prep',
              slug: 'demo-slug',
              pid: 38284,
              host: 'BUILD-HOST-01',
              startedIso: new Date(Date.now() - 60_000).toISOString(),
              heartbeatIso: new Date(Date.now() - 60_000).toISOString(),
            },
          }),
        },
      },
    );
  } catch (e) {
    stderr = e.stderr || '';
  }
  assert.match(
    stderr,
    /keep-hot stand-down:/,
    'the sibling must be named as keep-hot, not a fault',
  );
  assert.doesNotMatch(stderr, /KEEP-HOT STALLED/, 'the false alarm this plan closes');
  assert.doesNotMatch(stderr, /KEEP-HOT DID NOT RUN/);
  assert.equal(
    (stderr.match(/running done-worktree --prep/g) || []).length,
    1,
    'the sibling is credited to lastPreppedTip, so an unchanged tip never re-fires (spec answer 2)',
  );
});

test('plan 2816 (gpt-review): pairBusyHolder pins the verdict to ONE lock acquisition', () => {
  // Five independent finders flagged the unguarded two-read pairing (entry, then liveness). The
  // turnover that matters is not a cosmetically-stale pid in a log line: our sibling prep releases
  // and a LAND takes the lock between the reads, so `live` is true OF THE LAND while the entry
  // still says owner 'prep' on our slug — and a land holding the worktree would then be classified
  // as keep-hot-in-progress, silencing the alarm. `token` is a fresh randomUUID per acquisition, so
  // an unchanged token proves the record never turned over across the probe.
  const held = { token: 'uuid-1', owner: 'prep', slug: 'demo', pid: 1 };
  assert.deepEqual(pairBusyHolder({ before: held, live: true, after: held }), {
    entry: held,
    live: true,
  });
  // the finding's own scenario: the prep let go and a LAND took it mid-probe
  const land = { token: 'uuid-2', owner: 'land', slug: 'demo', pid: 2 };
  assert.equal(pairBusyHolder({ before: held, live: true, after: land }), null);
  // released and not retaken
  assert.equal(pairBusyHolder({ before: held, live: true, after: undefined }), null);
  // reaped into garbage mid-probe
  assert.equal(pairBusyHolder({ before: held, live: true, after: null }), null);
  // nothing to pair ON — a record with no token (pre-token checkout, or hand-written) can never be
  // proven to be one snapshot, so it falls through to the alarm rather than being trusted
  const tokenless = { owner: 'prep', slug: 'demo', pid: 1 };
  assert.equal(pairBusyHolder({ before: tokenless, live: true, after: tokenless }), null);
  // FREE / CORRUPT before the probe even starts
  assert.equal(pairBusyHolder({ before: undefined, live: true, after: held }), null);
  assert.equal(pairBusyHolder({ before: null, live: true, after: held }), null);
  // a paired-but-NOT-live holder still pairs — pairing is about identity, the verdict is the
  // lock module's, and keepHotBusyStandDown is what rejects live !== true
  assert.deepEqual(pairBusyHolder({ before: held, live: false, after: held }), {
    entry: held,
    live: false,
  });
  assert.equal(
    keepHotBusyStandDown({
      code: PREP_EXIT_BUSY,
      slug: 'demo',
      holder: pairBusyHolder({ before: held, live: false, after: held }),
      nowMs: SIBLING_NOW,
    }),
    null,
  );
});
