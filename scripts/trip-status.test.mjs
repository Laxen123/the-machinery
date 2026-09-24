// scripts/trip-status.test.mjs — unit tests for the waiting-trip/ release valve
// (plan 2679). node:test, no real fs / shell — every seam (readdir, readFile,
// exec) is injected, mirroring blocked-by-lib.test.mjs's fixture-corpus style.
// New-file justification: name-pair of the genuinely new trip-status.mjs module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readTripCheckRaw,
  unquoteTripCheckValue,
  parseTripCheck,
  readTripCheckTimeoutMsRaw,
  parseTripCheckTimeoutMs,
  resolveTripCheckTimeoutMs,
  runProbe,
  listWaitingTripPlans,
  makeStatusReaddir,
  buildReport,
  isMoveRaceErrno,
  formatReport,
  parseCliArgs,
  PROBE_TIMEOUT_MS,
  TRIP_CHECK_TIMEOUT_CEILING_MS,
  TRIP_CHECK_TIMEOUT_FLOOR_MS,
} from './trip-status.mjs';
import { unquoteYaml } from './coord/build-index-lib.mjs';

// --- readTripCheckRaw / unquoteTripCheckValue / parseTripCheck --------------

test('parseTripCheck: no frontmatter at all → none', () => {
  assert.deepEqual(parseTripCheck('# just a heading\n\nbody text\n'), {
    kind: 'none',
    command: null,
  });
});

test('parseTripCheck: frontmatter present but no tripCheck: key → none', () => {
  const content = '---\nsummary: "x"\nstage: specced\n---\n\n# Title\n';
  assert.deepEqual(parseTripCheck(content), { kind: 'none', command: null });
});

test('parseTripCheck: unquoted manual form', () => {
  const content =
    '---\nsummary: "x"\ntripCheck: manual — an operator sighting\nstage: specced\n---\n';
  assert.deepEqual(parseTripCheck(content), { kind: 'manual', command: null });
});

test('parseTripCheck: single-quoted manual form (still classified manual)', () => {
  const content = "---\ntripCheck: 'manual — needs a named scan'\n---\n";
  assert.deepEqual(parseTripCheck(content), { kind: 'manual', command: null });
});

test('parseTripCheck: single-quoted command form, a doubled YAML quote unescapes to a literal quote', () => {
  const content = "---\ntripCheck: 'echo it''s tripped; exit 0'\n---\n";
  const parsed = parseTripCheck(content);
  assert.equal(parsed.kind, 'command');
  assert.equal(parsed.command, "echo it's tripped; exit 0");
});

test('parseTripCheck: a literal # INSIDE quotes survives — the plan-1955 regression this reader exists for', () => {
  // Mirrors the real plan-1955 stamp: a double-quoted "#usercentrics-root" living
  // inside the outer single-quoted YAML scalar. A comment-stripping reader
  // (build-index-lib's readFrontmatterScalar) would truncate at the first
  // ` #...`; this local reader must not.
  const content = '---\ntripCheck: \'grep -q "#usercentrics-root" some/file.html\'\n---\n';
  const parsed = parseTripCheck(content);
  assert.equal(parsed.kind, 'command');
  assert.equal(parsed.command, 'grep -q "#usercentrics-root" some/file.html');
});

test('readTripCheckRaw: only scans WITHIN the frontmatter fence, not the body', () => {
  const content = '---\nsummary: "x"\n---\n\ntripCheck: this is body prose, not a marker\n';
  assert.equal(readTripCheckRaw(content), null);
});

test('unquoteTripCheckValue: double-quoted form unescapes \\" and \\\\', () => {
  assert.equal(unquoteTripCheckValue('"a \\"b\\" c\\\\d"'), 'a "b" c\\d');
});

test('unquoteTripCheckValue: unquoted value passes through unchanged', () => {
  assert.equal(unquoteTripCheckValue('manual — plain text'), 'manual — plain text');
});

// --- runProbe ----------------------------------------------------------------

const fakeExec =
  (status, { signal = null, error = null } = {}) =>
  () => ({ status, signal, error });

test('runProbe: exit 0 → tripped', () => {
  const { verdict } = runProbe('irrelevant', { exec: fakeExec(0) });
  assert.equal(verdict, 'tripped');
});

test('runProbe: exit 1 → quiet', () => {
  const { verdict } = runProbe('irrelevant', { exec: fakeExec(1) });
  assert.equal(verdict, 'quiet');
});

test('runProbe: exit >=2 → probe-error, never tripped', () => {
  assert.equal(runProbe('irrelevant', { exec: fakeExec(2) }).verdict, 'error');
  assert.equal(runProbe('irrelevant', { exec: fakeExec(17) }).verdict, 'error');
});

test('runProbe: killed by signal with elapsed WELL UNDER the budget (an external kill, not ours) → probe-error, never tripped', () => {
  // spawnSync's own timeout kill cannot fire before timeoutMs has elapsed, so
  // a signal seen at ~0ms elapsed against a 90s budget was NOT our timeout.
  let call = 0;
  const now = () => (call++ === 0 ? 1_000 : 1_500); // 500ms elapsed, well under any real budget
  const { verdict } = runProbe('irrelevant', {
    exec: fakeExec(null, { signal: 'SIGTERM' }),
    timeoutMs: PROBE_TIMEOUT_MS,
    now,
  });
  assert.equal(verdict, 'error');
});

// --- plan 3540: split timeout verdict from error --------------------------

test('runProbe: killed by signal with elapsed AT/OVER the budget (OUR OWN timeout kill) → timeout, never tripped', () => {
  // spawnSync sets result.signal = 'SIGKILL' on ITS OWN timeout kill — the
  // SAME signal an external killer would use — so the signal name alone
  // cannot discriminate. Elapsed-vs-budget can: our kill cannot fire before
  // timeoutMs has elapsed.
  let call = 0;
  const now = () => (call++ === 0 ? 0 : PROBE_TIMEOUT_MS); // exactly at the cap
  const { verdict, ms } = runProbe('sleep 999', {
    exec: fakeExec(null, { signal: 'SIGKILL' }),
    timeoutMs: PROBE_TIMEOUT_MS,
    now,
  });
  assert.equal(verdict, 'timeout');
  assert.equal(ms, PROBE_TIMEOUT_MS);
});

test('runProbe: the REAL spawnSync timeout shape (result.error ETIMEDOUT *and* result.signal, together) → timeout, not error', () => {
  // Node's spawnSync reports its OWN timeout kill in TWO fields at once: it
  // sets result.error to an ETIMEDOUT Error AND result.signal to killSignal.
  // Measured 2026-08-30 on this repo:
  //   spawnSync('sh', ['-c','sleep 5'], { timeout: 300, killSignal: 'SIGKILL' })
  //   → status=null  signal=SIGKILL  error.code=ETIMEDOUT
  // A fake exec that returns `signal` WITHOUT `error` does not model that, so
  // an implementation that returns early on `result.error` passes such a test
  // while the timeout verdict stays unreachable in production — exactly what
  // `--timeout-ms 2000` against plan 3302's probe showed: killed by our own
  // budget at 2003ms, rendered `⚠ probe-error`. This test pins the real shape.
  const etimedout = Object.assign(new Error('spawnSync sh ETIMEDOUT'), { code: 'ETIMEDOUT' });
  let call = 0;
  const now = () => (call++ === 0 ? 0 : PROBE_TIMEOUT_MS);
  const { verdict } = runProbe('sleep 999', {
    exec: fakeExec(null, { signal: 'SIGKILL', error: etimedout }),
    timeoutMs: PROBE_TIMEOUT_MS,
    now,
  });
  assert.equal(verdict, 'timeout');
});

test('runProbe: a NON-timeout result.error (a spawn failure) still renders error, even at long elapsed', () => {
  // The guard above keys on the ETIMEDOUT code, never on "result.error is set
  // and the clock is past the budget" — a genuine spawn failure on a machine
  // that happened to be slow is still a probe-error, not a timeout.
  const enoent = Object.assign(new Error('spawnSync sh ENOENT'), { code: 'ENOENT' });
  let call = 0;
  const now = () => (call++ === 0 ? 0 : 200_000);
  const { verdict } = runProbe('irrelevant', {
    exec: fakeExec(null, { error: enoent }),
    timeoutMs: PROBE_TIMEOUT_MS,
    now,
  });
  assert.equal(verdict, 'error');
});

test('runProbe: a genuine exit >=2 still renders error even after a long elapsed time — timeout and error never collapse', () => {
  let call = 0;
  const now = () => (call++ === 0 ? 0 : 200_000); // slow, but a real nonzero exit with no signal
  const { verdict } = runProbe('irrelevant', {
    exec: fakeExec(9),
    timeoutMs: PROBE_TIMEOUT_MS,
    now,
  });
  assert.equal(verdict, 'error');
});

test('runProbe: real default clock (no `now` injected) still behaves — a fast fake exec never reads as a timeout', () => {
  const { verdict } = runProbe('irrelevant', { exec: fakeExec(1) });
  assert.equal(verdict, 'quiet');
});

test('runProbe: exec throws (spawn failure, e.g. sh missing) → probe-error', () => {
  const throwing = () => {
    throw new Error('ENOENT');
  };
  assert.equal(runProbe('irrelevant', { exec: throwing }).verdict, 'error');
});

test('runProbe: result.error set (spawnSync convention) → probe-error', () => {
  const { verdict } = runProbe('irrelevant', {
    exec: () => ({ status: null, signal: null, error: new Error('x') }),
  });
  assert.equal(verdict, 'error');
});

// --- listWaitingTripPlans (injected readdir — depth-transparent per plan 2678) ---

function directEntry(name, isDir) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

test("listWaitingTripPlans: flat status folder (today's real shape)", () => {
  const readdir = (segments) => {
    if (segments.length === 0) {
      return [directEntry('1268-Infra-worktree-guard-exact-merge-allowlist.md', false)];
    }
    return [];
  };
  const plans = listWaitingTripPlans({ readdir });
  assert.deepEqual(plans, [
    {
      id: '1268',
      slug: 'Infra-worktree-guard-exact-merge-allowlist',
      rel: 'docs/superpowers/plans/waiting-trip/1268-Infra-worktree-guard-exact-merge-allowlist.md',
    },
  ]);
});

test('listWaitingTripPlans: one-level category subfolder is still seen (plan 2678 depth-transparency)', () => {
  const readdir = (segments) => {
    if (segments.length === 0) {
      return [
        directEntry('denmark', true),
        directEntry('2677-Biz-dk-social-go-live-follow-ups.md', false),
      ];
    }
    if (segments.length === 1 && segments[0] === 'denmark') {
      return [directEntry('9999-Biz-clumped-plan.md', false)];
    }
    return [];
  };
  const plans = listWaitingTripPlans({ readdir }).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(plans, [
    {
      id: '2677',
      slug: 'Biz-dk-social-go-live-follow-ups',
      rel: 'docs/superpowers/plans/waiting-trip/2677-Biz-dk-social-go-live-follow-ups.md',
    },
    {
      id: '9999',
      slug: 'Biz-clumped-plan',
      rel: 'docs/superpowers/plans/waiting-trip/denmark/9999-Biz-clumped-plan.md',
    },
  ]);
});

test('makeStatusReaddir: an ENOENT on a NESTED category subfolder (parallel-session race) is tolerated as empty', () => {
  const readdirImpl = (path) => {
    if (path.endsWith('ghost')) {
      const err = new Error('gone');
      err.code = 'ENOENT';
      throw err;
    }
    return [directEntry('ghost', true)];
  };
  const readdir = makeStatusReaddir('/fake/waiting-trip', readdirImpl);
  assert.deepEqual(
    readdir([]).map((e) => e.name),
    ['ghost'],
  ); // Dirent-likes carry functions; compare by name
  assert.deepEqual(readdir(['ghost']), []); // tolerated, not thrown
});

test('makeStatusReaddir: an error at the TOP level (segments=[]) is NEVER tolerated — always throws', () => {
  const readdirImpl = () => {
    const err = new Error('gone');
    err.code = 'ENOENT';
    throw err;
  };
  const readdir = makeStatusReaddir('/fake/waiting-trip', readdirImpl);
  assert.throws(() => readdir([]));
});

test('makeStatusReaddir: a non-ENOENT/ENOTDIR error on a nested folder still throws', () => {
  const readdirImpl = () => {
    const err = new Error('nope');
    err.code = 'EACCES';
    throw err;
  };
  const readdir = makeStatusReaddir('/fake/waiting-trip', readdirImpl);
  assert.throws(() => readdir(['sub']));
});

// --- buildReport / formatReport (full pipeline, fs-free) --------------------

test('buildReport: mixes manual/command verdicts and counts TRIPPED correctly', () => {
  const plans = [
    { id: '1', slug: 'manual-one', rel: 'a.md' },
    { id: '2', slug: 'quiet-cmd', rel: 'b.md' },
    { id: '3', slug: 'tripped-cmd', rel: 'c.md' },
    { id: '4', slug: 'no-marker', rel: 'd.md' },
    { id: '5', slug: 'errored-cmd', rel: 'e.md' },
  ];
  const contentByRel = {
    'a.md': '---\ntripCheck: manual — an operator sighting\n---\n',
    'b.md': "---\ntripCheck: 'grep -q nope /dev/null'\n---\n",
    'c.md': "---\ntripCheck: 'true'\n---\n",
    'd.md': '---\nsummary: "x"\n---\n',
    'e.md': "---\ntripCheck: 'exit 9'\n---\n",
  };
  const readFile = (rel) => contentByRel[rel];
  // Fake exec: the command string decides the outcome so this stays fs/shell-free.
  const exec = (_bin, args) => {
    const cmd = args[1];
    if (cmd.includes('nope')) return { status: 1, signal: null, error: null };
    if (cmd === 'true') return { status: 0, signal: null, error: null };
    if (cmd === 'exit 9') return { status: 9, signal: null, error: null };
    throw new Error(`unexpected command in test: ${cmd}`);
  };
  const report = buildReport({ plans, readFile, exec });
  const byId = Object.fromEntries(report.rows.map((r) => [r.id, r.verdict]));
  assert.deepEqual(byId, {
    1: 'manual',
    2: 'quiet',
    3: 'tripped',
    4: 'none',
    5: 'error',
  });
  assert.equal(report.trippedCount, 1);
});

test('buildReport: rows are sorted by numeric plan id regardless of input order', () => {
  const plans = [
    { id: '2029', slug: 'b', rel: 'b.md' },
    { id: '451', slug: 'a', rel: 'a.md' },
    { id: '1268', slug: 'c', rel: 'c.md' },
  ];
  const readFile = () => '---\ntripCheck: manual — x\n---\n';
  const report = buildReport({
    plans,
    readFile,
    exec: () => ({ status: 1, signal: null, error: null }),
  });
  assert.deepEqual(
    report.rows.map((r) => r.id),
    ['451', '1268', '2029'],
  );
});

test('formatReport: TRIPPED rows produce a non-empty promotion-candidate summary line', () => {
  const report = { rows: [{ id: '3', slug: 'x', verdict: 'tripped', ms: 12 }], trippedCount: 1 };
  const text = formatReport(report);
  assert.match(text, /TRIPPED/);
  assert.match(text, /promotion candidate/);
});

test('formatReport: no trips fired → says so plainly', () => {
  const report = { rows: [{ id: '3', slug: 'x', verdict: 'quiet', ms: 12 }], trippedCount: 0 };
  assert.match(formatReport(report), /No trips fired\./);
});

// --- plan-2679 review-round regressions -------------------------------------

test('parseTripCheck: a COMMAND whose first token merely starts with "manual" is NOT classified manual', () => {
  // /^manual\b/i used to swallow this, so the probe never ran and the trip
  // could never fire via the automated valve.
  const plan = "---\ntripCheck: 'manual-mode.sh check'\n---\n";
  assert.deepEqual(parseTripCheck(plan), { kind: 'command', command: 'manual-mode.sh check' });
});

test('parseTripCheck: the documented `manual — <who>` form is still classified manual', () => {
  for (const v of ['manual — someone watches prod', 'manual', 'manual - a plain hyphen form']) {
    assert.equal(parseTripCheck(`---\ntripCheck: '${v}'\n---\n`).kind, 'manual', v);
  }
});

test('runProbe: passes killSignal SIGKILL so the ~90s cap survives a SIGTERM-trapping command', () => {
  let seen = null;
  runProbe('sleep 999', {
    exec: (_c, _a, opts) => {
      seen = opts;
      return { status: 1, signal: null, error: null };
    },
  });
  assert.equal(seen.killSignal, 'SIGKILL');
});

test('buildReport: a plan moved out of the lane mid-run renders `gone`, never crashes the report', () => {
  const plans = [
    { id: '1', slug: 'stays', rel: 'a.md' },
    { id: '2', slug: 'moved-by-sibling-session', rel: 'b.md' },
  ];
  const readFile = (rel) => {
    if (rel === 'b.md') {
      const e = new Error('ENOENT: no such file or directory');
      e.code = 'ENOENT';
      throw e;
    }
    return '---\ntripCheck: manual — x\n---\n';
  };
  const report = buildReport({ plans, readFile, exec: () => ({ status: 1 }) });
  assert.deepEqual(
    report.rows.map((r) => r.verdict),
    ['manual', 'gone'],
  );
  assert.equal(report.trippedCount, 0);
  assert.match(formatReport(report), /moved/);
});

test('buildReport: a NON-ENOENT read failure still throws (never silently swallowed)', () => {
  const plans = [{ id: '1', slug: 'x', rel: 'a.md' }];
  const readFile = () => {
    const e = new Error('EACCES');
    e.code = 'EACCES';
    throw e;
  };
  assert.throws(() => buildReport({ plans, readFile, exec: () => ({ status: 1 }) }), /EACCES/);
});

test('unquoteTripCheckValue IS build-index-lib unquoteYaml — one quote rule, not two copies', () => {
  assert.equal(unquoteTripCheckValue, unquoteYaml);
});

// --- plan-2679 review round 2 (regressions of the round-1 fixes) -------------

test('parseTripCheck: the manual-vs-command boundary, both directions pinned', () => {
  // Every row here was a review finding at some round. The two failure
  // directions are in tension, so they are pinned TOGETHER: a value that is
  // wrongly `manual` never runs its probe (silent — the worse one), and a value
  // that is wrongly `command` gets handed to sh -c and renders a misleading
  // probe-error for a trip no machine was ever meant to check.
  const MANUAL = [
    'manual',
    'manual — someone watches prod', // the documented form (all 22 stamps)
    'manual—no space before the dash',
    'manual – en dash',
    'manual - a whitespace-delimited hyphen',
    'manual: watched by the pass reviewer',
    'manual, an operator notices X',
  ];
  const COMMAND = [
    'manual-mode.sh check',
    'manual_probe.sh',
    'manual.sh --check',
    'manual sync-check.sh --verify', // first argv word is bare "manual"
    'manual check-status.sh',
    'grep -q foo bar',
  ];
  for (const v of MANUAL) {
    assert.equal(parseTripCheck(`---\ntripCheck: '${v}'\n---\n`).kind, 'manual', `MANUAL: ${v}`);
  }
  for (const v of COMMAND) {
    assert.equal(parseTripCheck(`---\ntripCheck: '${v}'\n---\n`).kind, 'command', `COMMAND: ${v}`);
  }
});

test('isMoveRaceErrno: ONE errno rule shared by both race-tolerant seams', () => {
  assert.equal(isMoveRaceErrno({ code: 'ENOENT' }), true);
  assert.equal(isMoveRaceErrno({ code: 'ENOTDIR' }), true);
  assert.equal(isMoveRaceErrno({ code: 'EACCES' }), false);
  assert.equal(isMoveRaceErrno(null), false);
});

// --- plan 3540: tripCheckTimeoutMs frontmatter override ----------------------

test('readTripCheckTimeoutMsRaw: no frontmatter / no key → null', () => {
  assert.equal(readTripCheckTimeoutMsRaw('# just a heading\n'), null);
  assert.equal(readTripCheckTimeoutMsRaw('---\ntripCheck: manual — x\n---\n'), null);
});

test('readTripCheckTimeoutMsRaw: extracts the raw scalar, trimmed of trailing whitespace', () => {
  const content = '---\ntripCheck: manual — x\ntripCheckTimeoutMs: 300000  \n---\n';
  assert.equal(readTripCheckTimeoutMsRaw(content), '300000');
});

test('parseTripCheckTimeoutMs: absent/empty value defaults to defaultMs (PROBE_TIMEOUT_MS by default)', () => {
  assert.equal(parseTripCheckTimeoutMs(null), PROBE_TIMEOUT_MS);
  assert.equal(parseTripCheckTimeoutMs(''), PROBE_TIMEOUT_MS);
  assert.equal(parseTripCheckTimeoutMs(null, { defaultMs: 12_345 }), 12_345);
});

test('parseTripCheckTimeoutMs: honours a valid in-range override', () => {
  assert.equal(parseTripCheckTimeoutMs('300000'), 300_000);
});

test('parseTripCheckTimeoutMs: clamps a value above the ceiling and warns once', () => {
  const warnings = [];
  const n = parseTripCheckTimeoutMs('999999999', { warn: (m) => warnings.push(m) });
  assert.equal(n, TRIP_CHECK_TIMEOUT_CEILING_MS);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ceiling/);
});

test('parseTripCheckTimeoutMs: clamps a value below the floor and warns once', () => {
  const warnings = [];
  const n = parseTripCheckTimeoutMs('5', { warn: (m) => warnings.push(m) });
  assert.equal(n, TRIP_CHECK_TIMEOUT_FLOOR_MS);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /floor/);
});

test('parseTripCheckTimeoutMs: a non-integer / negative / NaN / non-numeric value falls back to the default, NEVER throws', () => {
  for (const bad of ['abc', '-500', '12.5', 'NaN', '1e5', 'Infinity', '  ']) {
    assert.doesNotThrow(() => parseTripCheckTimeoutMs(bad));
    assert.equal(
      parseTripCheckTimeoutMs(bad),
      PROBE_TIMEOUT_MS,
      `bad value: ${JSON.stringify(bad)}`,
    );
  }
});

test('resolveTripCheckTimeoutMs: reads tripCheckTimeoutMs: from frontmatter and clamps it', () => {
  const content = "---\ntripCheck: 'true'\ntripCheckTimeoutMs: 999999999\n---\n";
  const warnings = [];
  assert.equal(
    resolveTripCheckTimeoutMs(content, { warn: (m) => warnings.push(m) }),
    TRIP_CHECK_TIMEOUT_CEILING_MS,
  );
  assert.equal(warnings.length, 1);
});

test('resolveTripCheckTimeoutMs: absent key falls back to the passed defaultMs', () => {
  const content = "---\ntripCheck: 'true'\n---\n";
  assert.equal(resolveTripCheckTimeoutMs(content), PROBE_TIMEOUT_MS);
  assert.equal(resolveTripCheckTimeoutMs(content, { defaultMs: 42_000 }), 42_000);
});

// --- plan 3540: buildReport's timeout verdict + total-run budget ------------

// A deterministic incrementing clock: each call returns the next value from
// `values`, clamped to the last entry if over-called (defensive only — every
// test below sizes its array to the exact number of `now()` calls buildReport
// and runProbe make for that plan mix, so an over-call would itself be a
// signal the implementation's call count drifted).
function seqClock(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

test('buildReport: a probe killed by ITS OWN timeout budget renders `timeout`, not `error`, and is never tripped', () => {
  const plans = [{ id: '1', slug: 'slow-cmd', rel: 'a.md' }];
  const readFile = () => "---\ntripCheck: 'sleep 999'\n---\n";
  const exec = () => ({ status: null, signal: 'SIGKILL', error: null });
  // calls: runStart, budget-check, probe-start, probe-end
  const now = seqClock([0, 0, 0, PROBE_TIMEOUT_MS]);
  const report = buildReport({ plans, readFile, exec, now });
  assert.equal(report.rows[0].verdict, 'timeout');
  assert.equal(report.trippedCount, 0);
});

test("buildReport: a plan's tripCheckTimeoutMs: override is threaded through as THAT probe's effective budget", () => {
  const plans = [{ id: '1', slug: 'slow-cmd', rel: 'a.md' }];
  const readFile = () => "---\ntripCheck: 'sleep 999'\ntripCheckTimeoutMs: 300000\n---\n";
  let seenTimeoutOpt = null;
  const exec = (_bin, _args, opts) => {
    seenTimeoutOpt = opts.timeout;
    return { status: 1, signal: null, error: null };
  };
  const report = buildReport({ plans, readFile, exec }); // real Date.now, exec returns instantly
  assert.equal(seenTimeoutOpt, 300_000);
  assert.equal(report.rows[0].verdict, 'quiet');
});

test('buildReport: the total-run budget stops further command-form probes and marks the remainder budgetExhausted', () => {
  const plans = [
    { id: '1', slug: 'first', rel: 'a.md' },
    { id: '2', slug: 'second', rel: 'b.md' },
  ];
  const contentByRel = {
    'a.md': "---\ntripCheck: 'true'\n---\n",
    'b.md': "---\ntripCheck: 'true'\n---\n",
  };
  const readFile = (rel) => contentByRel[rel];
  const exec = () => ({ status: 1, signal: null, error: null }); // fast, quiet
  // calls: runStart(0); plan1: check(0), probe-start(0), probe-end(2000); plan2: check(2000)
  const now = seqClock([0, 0, 0, 2000, 2000]);
  const report = buildReport({ plans, readFile, exec, now, totalBudgetMs: 1_000 });
  assert.deepEqual(
    report.rows.map((r) => r.verdict),
    ['quiet', 'budgetExhausted'],
  );
  assert.equal(report.trippedCount, 0);
});

test('buildReport: manual/none rows after the total-run budget is exhausted still render normally — they cost nothing', () => {
  const plans = [
    { id: '1', slug: 'first-cmd', rel: 'a.md' },
    { id: '2', slug: 'burns-budget', rel: 'b.md' },
    { id: '3', slug: 'manual-after', rel: 'c.md' },
    { id: '4', slug: 'none-after', rel: 'd.md' },
  ];
  const contentByRel = {
    'a.md': "---\ntripCheck: 'true'\n---\n",
    'b.md': "---\ntripCheck: 'true'\n---\n",
    'c.md': '---\ntripCheck: manual — an operator sighting\n---\n',
    'd.md': '---\nsummary: "x"\n---\n',
  };
  const readFile = (rel) => contentByRel[rel];
  const exec = () => ({ status: 1, signal: null, error: null });
  const now = seqClock([0, 0, 0, 2000, 2000]);
  const report = buildReport({ plans, readFile, exec, now, totalBudgetMs: 1_000 });
  assert.deepEqual(
    report.rows.map((r) => r.verdict),
    ['quiet', 'budgetExhausted', 'manual', 'none'],
  );
});

test('buildReport/exit-contract: trippedCount counts ONLY tripped rows — timeouts and budget-exhaustion never contribute', () => {
  const plans = [
    { id: '1', slug: 'tripped', rel: 'a.md' },
    { id: '2', slug: 'timed-out', rel: 'b.md' },
    { id: '3', slug: 'exhausted', rel: 'c.md' },
  ];
  const contentByRel = {
    'a.md': "---\ntripCheck: 'true'\n---\n",
    'b.md': "---\ntripCheck: 'sleep 999'\n---\n",
    'c.md': "---\ntripCheck: 'true'\n---\n",
  };
  const readFile = (rel) => contentByRel[rel];
  const exec = (_bin, args) => {
    const cmd = args[1];
    if (cmd === 'true') return { status: 0, signal: null, error: null }; // tripped
    return { status: null, signal: 'SIGKILL', error: null }; // our own timeout
  };
  // calls: runStart(0);
  //   plan a: check(0), probe-start(0), probe-end(10)                 → tripped, ms=10
  //   plan b: check(10), probe-start(10), probe-end(90010)            → timeout, ms=90000
  //   plan c: check(150000)                                          → budgetExhausted
  const now = seqClock([0, 0, 0, 10, 10, 10, 90_010, 150_000]);
  const report = buildReport({ plans, readFile, exec, now, totalBudgetMs: 100_000 });
  assert.deepEqual(
    report.rows.map((r) => r.verdict),
    ['tripped', 'timeout', 'budgetExhausted'],
  );
  assert.equal(report.trippedCount, 1);
});

test('formatReport: renders the new ⏱ probe-timeout and ∅ budget-exhausted verdict labels', () => {
  const report = {
    rows: [
      { id: '1', slug: 'a', verdict: 'timeout', ms: 90_000 },
      { id: '2', slug: 'b', verdict: 'budgetExhausted', ms: null },
    ],
    trippedCount: 0,
  };
  const text = formatReport(report);
  assert.match(text, /⏱ probe-timeout/);
  assert.match(text, /∅ budget-exhausted/);
});

// --- plan 3540: --timeout-ms / --total-budget-ms CLI flags -------------------

test('parseCliArgs: no args → empty options (all defaults apply downstream)', () => {
  assert.deepEqual(parseCliArgs([]), {});
});

test('parseCliArgs: --timeout-ms sets timeoutMs', () => {
  assert.deepEqual(parseCliArgs(['--timeout-ms', '300000']), { timeoutMs: 300_000 });
});

test('parseCliArgs: --total-budget-ms sets totalBudgetMs', () => {
  assert.deepEqual(parseCliArgs(['--total-budget-ms', '500000']), { totalBudgetMs: 500_000 });
});

test('parseCliArgs: both flags together', () => {
  assert.deepEqual(parseCliArgs(['--timeout-ms', '1000', '--total-budget-ms', '2000']), {
    timeoutMs: 1_000,
    totalBudgetMs: 2_000,
  });
});

test('parseCliArgs: a missing value fails cleanly with a usage message, never silently defaults', () => {
  assert.throws(() => parseCliArgs(['--timeout-ms']), /Usage/);
});

test('parseCliArgs: a non-numeric value fails cleanly with a usage message', () => {
  assert.throws(() => parseCliArgs(['--timeout-ms', 'soon']), /Usage/);
});

test('parseCliArgs: a zero or negative value fails cleanly with a usage message', () => {
  assert.throws(() => parseCliArgs(['--timeout-ms', '0']), /Usage/);
  assert.throws(() => parseCliArgs(['--total-budget-ms', '-5']), /Usage/);
});

test('parseCliArgs: an unknown flag fails cleanly with a usage message', () => {
  assert.throws(() => parseCliArgs(['--bogus']), /Usage/);
});

// --- plan 3540 review fixes -------------------------------------------------

test('parseTripCheckTimeoutMs: a trailing inline YAML comment is stripped — the runbook own example must parse', () => {
  // The runbook documents exactly this stamp:
  //   tripCheckTimeoutMs: 300000 # this plan's probe needs more than the 90s default
  // Before this fix the `#...` tail failed the digits-only test and the stamp
  // silently fell back to the 90s default — the documented example did not
  // work, and the fallback was silent by design, so nobody would have noticed.
  // Comment-stripping is safe HERE (unlike `tripCheck:`, see the file header)
  // precisely because this value is an integer: a `#` can never be part of it.
  const warn = () => {};
  assert.equal(
    parseTripCheckTimeoutMs("300000 # this plan's probe needs more than the 90s default", { warn }),
    300_000,
  );
  assert.equal(parseTripCheckTimeoutMs('300000   ', { warn }), 300_000);
});

test('parseTripCheckTimeoutMs: only a WHITESPACE-PRECEDED # is a comment, per YAML — `300000#x` is malformed, not 300000', () => {
  // YAML only treats `#` as starting an inline comment when it is preceded by
  // whitespace (or starts the scalar). `300000#tight` is therefore the scalar
  // "300000#tight" — malformed for an integer field — and must fall back to
  // the default rather than being silently accepted as 300000 by a blind
  // /#.*$/ strip (review finding on this plan's own first fix).
  const warn = () => {};
  assert.equal(parseTripCheckTimeoutMs('300000#tight', { warn }), PROBE_TIMEOUT_MS);
  assert.equal(
    parseTripCheckTimeoutMs('300000\t# tab-preceded is still a comment', { warn }),
    300_000,
  );
  // YAML whitespace is space and tab ONLY. JS's \s also matches NBSP and the
  // Unicode spaces, which YAML does not accept as a comment separator — so a
  // NBSP-preceded # is part of one malformed scalar, not a comment.
  assert.equal(
    parseTripCheckTimeoutMs('300000\u00a0#nbsp-is-not-yaml-space', { warn }),
    PROBE_TIMEOUT_MS,
  );
});

test('parseTripCheckTimeoutMs: a comment-only / empty-after-strip value still falls back to the default', () => {
  const warn = () => {};
  assert.equal(parseTripCheckTimeoutMs('# no value at all', { warn }), PROBE_TIMEOUT_MS);
});

test('buildReport: a probe is capped at the REMAINING total budget, so the table cannot overrun it', () => {
  // The total budget used to gate only the START of each probe, so a plan
  // stamped at the 600s ceiling could run 600s PAST a spent budget — which
  // made the runbook's "a permissive per-plan override carries no run-time
  // risk to the rest of the lane" claim false. The remaining budget must cap
  // the probe's own timeout.
  const plans = [{ id: '1', slug: 'slow', rel: 'a.md' }];
  const readFile = () => "---\ntripCheck: 'sleep 999'\ntripCheckTimeoutMs: 600000\n---\n";
  let seenTimeout = null;
  const exec = (_sh, _args, opts) => {
    seenTimeout = opts.timeout;
    return { status: 1, signal: null, error: null };
  };
  // 10_000ms of a 30_000ms total budget already spent when the probe starts.
  let call = 0;
  const clock = [0, 10_000, 10_000, 10_000];
  const now = () => clock[Math.min(call++, clock.length - 1)];
  buildReport({ plans, readFile, exec, now, totalBudgetMs: 30_000, warn: () => {} });
  assert.equal(seenTimeout, 20_000, 'probe timeout must be clamped to the 20s of budget left');
});

test('buildReport: the remaining-budget cap never RAISES a smaller per-plan budget', () => {
  const plans = [{ id: '1', slug: 'fast', rel: 'a.md' }];
  const readFile = () => "---\ntripCheck: 'true'\ntripCheckTimeoutMs: 5000\n---\n";
  let seenTimeout = null;
  const exec = (_sh, _args, opts) => {
    seenTimeout = opts.timeout;
    return { status: 1, signal: null, error: null };
  };
  buildReport({
    plans,
    readFile,
    exec,
    now: () => 0,
    totalBudgetMs: 900_000,
    warn: () => {},
  });
  assert.equal(seenTimeout, 5_000);
});

test('parseCliArgs: a fractional millisecond value fails cleanly rather than reaching spawnSync', () => {
  assert.throws(() => parseCliArgs(['--timeout-ms', '1.5']), /Usage/);
  assert.throws(() => parseCliArgs(['--total-budget-ms', '2.5']), /Usage/);
});
