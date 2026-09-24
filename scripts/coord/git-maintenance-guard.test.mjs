// scripts/git-maintenance-guard.test.mjs — the plan-2398 machine-global-maintenance guard.
//
// The contract every case defends: the guard blocks EXACTLY the one measured hazard — an
// immediate prune (`--prune=now`, bare `git prune`, `-c gc.pruneExpire=now`) racing the
// commit-tree→push window that claim-plan / spec-sweep-lock / usage-broadcast all enter —
// and waves every other maintenance command through. A guard that also blocked plain
// `git gc` would be ceremony around a non-risk (plan 2398 item 1 says so explicitly), and a
// guard that let `--prune=now` through on a busy machine would be no guard at all.
//
// Pure classify/summarize/verdict logic is unit-tested directly; the CLI arm runs against
// fixture files via the --probe-json / --worktree-porcelain seams (never the machine's real
// queues, which other live sessions own — same rule as push-queue-status.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeNoRepoRoot } from '../test-helpers/no-repo-root.mjs';
import {
  classifyMaintenance,
  parseLinkedWorktrees,
  summarizeLiveness,
  verdict,
  resolveExpiryEpoch,
  MAINTENANCE_OPS,
  IMMEDIATE_WINDOW_S,
} from './git-maintenance-guard.mjs';

// The expiry resolver is git-backed; the classification cases pin it to a deterministic stub so
// they stay hermetic (no spawn, no clock). NOW_S is the injected "now"; the stub answers the
// spellings git itself resolves — verified against `git rev-parse --since=<v>` on git 2.43.
const NOW_S = 1_784_991_342;
const RESOLVED = {
  '0.seconds.ago': NOW_S,
  today: NOW_S,
  '2.weeks.ago': NOW_S - 14 * 86400,
  '3.months.ago': NOW_S - 90 * 86400,
  '1.week.ago': NOW_S - 7 * 86400,
};
const stub = {
  _nowS: NOW_S,
  // Unknown spellings resolve to NOW, exactly as git's approxidate does for an unparseable
  // value — so an unrecognised expiry is classified immediate (fail closed), not safe.
  _resolveExpiry: (v) => (v in RESOLVED ? RESOLVED[v] : NOW_S),
};
const classify = (cmdline) => classifyMaintenance(cmdline.split(' '), stub);

const CLI = resolve(import.meta.dirname, 'git-maintenance-guard.mjs');

// --- classification: the SAFE side (never blocked) ---------------------------

for (const cmdline of [
  'git gc',
  'git gc --prune',
  'git gc --prune=2.weeks.ago',
  'git gc --prune 3.months.ago', // `gc --prune` is `=`-only: real git exits 129 here, never runs
  'git gc --prune=now --prune=never', // LAST occurrence wins, as git itself does
  'git -c gc.pruneExpire=now -c gc.pruneExpire=never gc',
  'git maintenance run --task=commit-graph',
  'git gc --auto',
  'git gc --aggressive', // repack DEPTH, not a prune axis — the word is a false friend
  'git gc --prune=never',
  'git repack -a -d',
  'git pack-refs --all --prune',
  'git fsck --connectivity-only',
  'git prune-packed',
  'git maintenance run',
  'git prune --expire=2.weeks.ago',
  'git prune --expire 3.months.ago',
]) {
  test(`classify: \`${cmdline}\` is not aggressive`, () => {
    const c = classify(cmdline);
    assert.equal(c.recognized, true);
    assert.equal(c.aggressive, false, `reasons: ${c.reasons.join(' / ')}`);
  });
}

// --- classification: the AGGRESSIVE side (the one real hazard) ---------------

for (const cmdline of [
  'git gc --prune=now',
  'git gc --prune=NOW', // case must not be a bypass
  'git gc --prune=all',
  'git -c gc.pruneExpire=now gc', // the config spelling of the same thing
  'git -cgc.pruneExpire=now gc', // …and its joined form
  'git prune', // bare prune has NO mtime grace, unlike gc
  'git prune --expire=now',
  'git prune --expire now', // `prune --expire` DOES take a separate token
  'git gc --prune=0.seconds.ago', // a now-equivalent git's date parser accepts
  'git gc --prune=never --prune=now', // LAST occurrence wins — the first-match bug
  'git -c gc.pruneExpire=never -c gc.pruneExpire=now gc',
  'git -c gc.pruneExpire=now maintenance run --task=gc', // `maintenance` drives the same prune
  'git gc --force', // defeats the gc.pid mutex, the only gc-vs-gc lock git gives us
  'git -c gc.reflogExpireUnreachable=now gc',
  'git reflog expire --expire-unreachable=now --all',
]) {
  test(`classify: \`${cmdline}\` is aggressive`, () => {
    const c = classify(cmdline);
    assert.equal(c.recognized, true);
    assert.equal(c.aggressive, true);
    assert.ok(c.reasons.length > 0);
  });
}

test('classify: a leading `git` is optional', () => {
  assert.equal(classifyMaintenance(['gc', '--prune=now'], stub).aggressive, true);
  assert.equal(classifyMaintenance(['gc'], stub).aggressive, false);
});

test('classify: an expiry OUTSIDE the immediate window is safe, inside it is not', () => {
  const at = (offsetS) =>
    classifyMaintenance(['git', 'gc', '--prune=X'], {
      _nowS: NOW_S,
      _resolveExpiry: () => NOW_S - offsetS,
    }).aggressive;
  assert.equal(at(0), true);
  assert.equal(at(IMMEDIATE_WINDOW_S - 1), true);
  assert.equal(at(IMMEDIATE_WINDOW_S + 1), false);
});

test('classify: an UNRESOLVABLE expiry fails closed', () => {
  // git missing / not a repo ⇒ resolveExpiryEpoch returns null. An expiry we cannot evaluate
  // is not proof of a safe one.
  const c = classifyMaintenance(['git', 'gc', '--prune=2.weeks.ago'], {
    _nowS: NOW_S,
    _resolveExpiry: () => null,
  });
  assert.equal(c.aggressive, true);
});

test('resolveExpiryEpoch: parses git rev-parse --since, null when git cannot answer', () => {
  assert.equal(resolveExpiryEpoch('x', { _exec: () => '--max-age=1784991342\n' }), 1784991342);
  assert.equal(resolveExpiryEpoch('x', { _exec: () => 'nonsense' }), null);
  assert.equal(
    resolveExpiryEpoch('x', {
      _exec: () => {
        throw new Error('not a git repository');
      },
    }),
    null,
  );
});

test('classify: separate-token global flags do not swallow the verb', () => {
  // `git -C /some/checkout gc` is a perfectly safe default gc; reading `/some/checkout` as the
  // verb would refuse it as "not a maintenance verb" (exit 2).
  for (const cmdline of [
    'git -C /some/checkout gc',
    'git --git-dir /a/.git gc',
    'git --work-tree /a --git-dir /a/.git gc',
    'git --no-pager -C /a gc',
    // These already passed — they pin the behaviour now that GLOBAL_VALUE_FLAGS is EXPORTED and
    // shared with push-queue-status (plan-2734 review round 6), so a future edit to the table
    // cannot quietly regress this file while fixing the other one.
    'git -c foo.bar=baz gc',
    'git -c foo.bar=baz -c a.b=c gc',
    'git --config-env foo.bar=ENV gc',
    'git --super-prefix x/ gc',
  ]) {
    const c = classify(cmdline);
    assert.equal(c.recognized, true, cmdline);
    assert.equal(c.op, 'gc', cmdline);
    assert.equal(c.aggressive, false, cmdline);
  }
  // …and the hazard is still seen through them.
  assert.equal(classify('git -C /a -c gc.pruneExpire=now gc').aggressive, true);
  assert.equal(classify('git -C /a gc --prune=now').aggressive, true);
});

test('classify: the expiry resolver is called ONCE per distinct value', () => {
  const calls = [];
  const c = classifyMaintenance(
    [
      'git',
      '-c',
      'gc.reflogExpire=1.week.ago',
      '-c',
      'gc.reflogExpireUnreachable=1.week.ago',
      'gc',
    ],
    {
      _nowS: NOW_S,
      _resolveExpiry: (v) => {
        calls.push(v);
        return NOW_S - 7 * 86400;
      },
    },
  );
  assert.equal(c.aggressive, false);
  assert.deepEqual(calls, ['1.week.ago']); // memoized, not spawned twice
});

test('classify: a non-maintenance verb is NOT recognized (never a silent pass)', () => {
  for (const v of ['status', 'push', 'commit', 'gcc', '']) {
    const c = classifyMaintenance(v ? [v] : [], stub);
    assert.equal(c.recognized, false, `"${v}" must not classify as maintenance`);
  }
  assert.ok(MAINTENANCE_OPS.has('gc'));
});

// --- worktree porcelain ------------------------------------------------------

const PORCELAIN = [
  'worktree /c/vetapp',
  'HEAD aaaa',
  'branch refs/heads/master',
  '',
  'worktree /c/vetapp/.claude/worktrees/2398-x',
  'HEAD bbbb',
  'branch refs/heads/worktree-2398-x',
  '',
  'worktree /c/vetapp/.claude/coord-worktree',
  'HEAD cccc',
  'detached',
  '',
].join('\n');

test('parseLinkedWorktrees: MAIN is excluded, linked ones are listed', () => {
  const wts = parseLinkedWorktrees(PORCELAIN);
  assert.equal(wts.length, 2);
  // The canonical parser strips `refs/heads/`, which is what the refusal message wants to show.
  assert.equal(wts[0].branch, 'worktree-2398-x');
  assert.equal(wts[1].branch, '(detached)');
});

test('parseLinkedWorktrees: a lone MAIN record yields no linked worktrees', () => {
  assert.deepEqual(
    parseLinkedWorktrees('worktree /c/vetapp\nHEAD aaaa\nbranch refs/heads/master\n'),
    [],
  );
});

test('parseLinkedWorktrees: empty/garbage input degrades to empty, never throws', () => {
  assert.deepEqual(parseLinkedWorktrees(''), []);
  assert.deepEqual(parseLinkedWorktrees(null), []);
});

const HUSK = [
  'worktree /c/vetapp/.claude/worktrees/dead',
  'HEAD dddd',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n');

test('parseLinkedWorktrees: a PRUNABLE registration is KEPT and flagged (fail closed)', () => {
  // Deliberately NOT filtered the way cloud-checkout-preflight guard 4 filters its live-session
  // count: `prunable` also fires on a momentarily unreadable gitdir, which a LIVE session can
  // hit, and this guard would rather refuse a husk (cost: one `git worktree prune`) than allow
  // an immediate prune beside a live claim-plan (cost: a lost coord object).
  const wts = parseLinkedWorktrees(PORCELAIN + '\n' + HUSK);
  assert.equal(wts.length, 3);
  assert.deepEqual(
    wts.map((w) => w.prunable),
    [false, false, true],
  );
});

test('verdict: a prunable husk still REFUSES, and the message names the remedy', () => {
  const l = summarizeLiveness({
    worktrees: parseLinkedWorktrees(PORCELAIN + '\n' + HUSK),
    probe: quietProbe,
  });
  const v = verdict({
    classification: classifyMaintenance(['git', 'gc', '--prune=now'], stub),
    liveness: l,
  });
  assert.equal(v.allow, false);
  const text = v.lines.join('\n');
  assert.match(text, /\[prunable\]/);
  assert.match(text, /git worktree prune/);
});

test('parseLinkedWorktrees: a whitespace-only separator line still splits blocks', () => {
  // The reason this delegates to worktree-porcelain.mjs (plan 2058) rather than re-rolling a
  // parser: a stricter `\n\n+` split merges the blocks and loses every entry after the first,
  // which here would silently under-count live sessions and let an immediate prune through.
  assert.equal(parseLinkedWorktrees(PORCELAIN.replace(/\n\n/g, '\n \n')).length, 2);
  assert.equal(parseLinkedWorktrees(PORCELAIN.replace(/\n\n/g, '\n\r\n')).length, 2);
});

// --- liveness ----------------------------------------------------------------

const quietProbe = {
  battery: { state: 'free' },
  testQueue: { state: 'ok', holders: [], waiting: [] },
  processes: { prePushHooks: 0, landTestRuns: 0, nodeTestRunners: 0 },
  busy: false,
};

test('summarizeLiveness: quiet probe + no worktrees is neither strong nor weak', () => {
  const l = summarizeLiveness({ worktrees: [], probe: quietProbe });
  assert.equal(l.strong, false);
  assert.equal(l.weak, false);
  assert.equal(l.processScanAvailable, true);
});

test('summarizeLiveness: worktrees alone is WEAK, not strong', () => {
  const l = summarizeLiveness({ worktrees: parseLinkedWorktrees(PORCELAIN), probe: quietProbe });
  assert.equal(l.strong, false);
  assert.equal(l.weak, true);
  assert.equal(l.worktreeCount, 2);
});

test('summarizeLiveness: a busy probe names the signals', () => {
  const l = summarizeLiveness({
    worktrees: [],
    probe: {
      battery: { state: 'held', holder: 'pid 1 (host h, 5s)' },
      testQueue: { state: 'ok', holders: [{ line: 'pid 2' }], waiting: [] },
      processes: { prePushHooks: 3, landTestRuns: 1, nodeTestRunners: 0 },
      busy: true,
    },
  });
  assert.equal(l.strong, true);
  assert.equal(l.strongSignals.length, 3);
  assert.match(l.strongSignals.join(' '), /battery-lock held/);
});

test('summarizeLiveness: a null process scan is reported, not treated as proof of quiet', () => {
  const l = summarizeLiveness({ worktrees: [], probe: { ...quietProbe, processes: null } });
  assert.equal(l.processScanAvailable, false);
  assert.equal(l.strong, false);
});

test('summarizeLiveness: busy with no itemizable signal still reports strong', () => {
  const l = summarizeLiveness({ worktrees: [], probe: { ...quietProbe, busy: true } });
  assert.equal(l.strong, true);
  assert.deepEqual(l.strongSignals, ['push-queue probe reports BUSY']);
});

test('summarizeLiveness: a FAILED read is `unproven`, distinct from an empty one', () => {
  assert.equal(summarizeLiveness({ worktrees: [], probe: quietProbe }).unproven, false);
  assert.equal(
    summarizeLiveness({ worktrees: [], probe: null, probeError: 'spawn ENOENT' }).unproven,
    true,
  );
  assert.equal(
    summarizeLiveness({ worktrees: [], probe: quietProbe, worktreeError: 'not a git repo' })
      .unproven,
    true,
  );
});

// --- verdict -----------------------------------------------------------------

const live = summarizeLiveness({ worktrees: parseLinkedWorktrees(PORCELAIN), probe: quietProbe });
const busy = summarizeLiveness({ worktrees: [], probe: { ...quietProbe, busy: true } });
const quiet = summarizeLiveness({ worktrees: [], probe: quietProbe });

test('verdict: a safe command is ALLOWED even on a busy machine', () => {
  const v = verdict({ classification: classifyMaintenance(['git', 'gc'], stub), liveness: busy });
  assert.equal(v.allow, true);
  assert.equal(v.code, 0);
  assert.match(v.lines.join('\n'), /^ALLOWED/m);
});

test('verdict: an immediate prune is REFUSED when machinery is live', () => {
  const v = verdict({
    classification: classifyMaintenance(['git', 'gc', '--prune=now'], stub),
    liveness: busy,
  });
  assert.equal(v.allow, false);
  assert.equal(v.code, 1);
  assert.match(v.lines.join('\n'), /other sessions are LIVE/);
});

test('verdict: an immediate prune is REFUSED on the weaker worktree signal, and says so', () => {
  const v = verdict({
    classification: classifyMaintenance(['git', 'prune'], stub),
    liveness: live,
  });
  assert.equal(v.allow, false);
  assert.equal(v.code, 1);
  assert.match(v.lines.join('\n'), /WEAKER signal/);
});

test('verdict: an immediate prune is ALLOWED on a genuinely quiet machine', () => {
  const v = verdict({
    classification: classifyMaintenance(['git', 'gc', '--prune=now'], stub),
    liveness: quiet,
  });
  assert.equal(v.allow, true);
  assert.equal(v.code, 0);
});

test('verdict: the override allows, loudly', () => {
  const v = verdict({
    classification: classifyMaintenance(['git', 'gc', '--prune=now'], stub),
    liveness: busy,
    override: true,
  });
  assert.equal(v.allow, true);
  assert.match(v.lines.join('\n'), /OVERRIDDEN/);
});

test('verdict: an immediate prune FAILS CLOSED when the liveness read errored', () => {
  // Both axes look empty, but the probe ERRORED — "quiet" is unproven, so an unreadable probe
  // must not read as permission to prune. The safe commands are unaffected (next case).
  const unproven = summarizeLiveness({ worktrees: [], probe: null, probeError: 'spawn ENOENT' });
  const v = verdict({
    classification: classifyMaintenance(['git', 'gc', '--prune=now'], stub),
    liveness: unproven,
  });
  assert.equal(v.allow, false);
  assert.equal(v.code, 1);
  assert.match(v.lines.join('\n'), /liveness read FAILED/);
  assert.match(v.lines.join('\n'), /spawn ENOENT/);
});

test('verdict: a failed liveness read does NOT block a safe command', () => {
  const unproven = summarizeLiveness({ worktrees: [], probe: null, probeError: 'spawn ENOENT' });
  const v = verdict({
    classification: classifyMaintenance(['git', 'gc'], stub),
    liveness: unproven,
  });
  assert.equal(v.allow, true);
  assert.equal(v.code, 0);
});

test('verdict: an unrecognized verb exits 2, never 0', () => {
  const v = verdict({
    classification: classifyMaintenance(['git', 'status'], stub),
    liveness: quiet,
  });
  assert.equal(v.allow, false);
  assert.equal(v.code, 2);
});

// --- CLI (fixture seams only) ------------------------------------------------

// Two CLI cases below drive the guard with `cwd: dir` and depend on `dir` NOT being a git repo
// (the lazy-liveness case at "works outside a repo", and the `git gc --prune=never` case whose
// own comment says "inside an empty temp dir is not a repo"). A bare
// `mkdtempSync(join(tmpdir(), …))` only satisfies that while the machine has no repo above
// tmpdir(); `makeNoRepoRoot` plants the barrier and asserts it (plan 3622).
const dir = makeNoRepoRoot('gmg-');
const probeFile = join(dir, 'probe.json');
const wtFile = join(dir, 'wt.txt');
writeFileSync(probeFile, JSON.stringify(quietProbe));
writeFileSync(wtFile, PORCELAIN);

const run = (args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_MAINTENANCE_GUARD_OVERRIDE: '', ...env },
  });

const SEAMS = ['--probe-json', probeFile, '--worktree-porcelain', wtFile];

test('CLI: `check -- git gc` exits 0 with live worktrees registered', () => {
  const r = run(['check', ...SEAMS, '--', 'git', 'gc']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ALLOWED/);
});

test('CLI: `check -- git gc --prune=now` exits 1 with worktrees registered', () => {
  const r = run(['check', ...SEAMS, '--', 'git', 'gc', '--prune=now']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /REFUSED/);
  assert.match(r.stdout, /Ways forward/);
});

test('CLI: the override flips the same command to exit 0', () => {
  const r = run(['check', ...SEAMS, '--', 'git', 'gc', '--prune=now'], {
    GIT_MAINTENANCE_GUARD_OVERRIDE: '1',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OVERRIDDEN/);
});

test('CLI: --json emits the classification, liveness and verdict', () => {
  const r = run(['check', ...SEAMS, '--json', '--', 'git', 'prune']);
  assert.equal(r.status, 1);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.classification.op, 'prune');
  assert.equal(j.classification.aggressive, true);
  assert.equal(j.liveness.worktreeCount, 2);
  assert.equal(j.verdict.allow, false);
});

test('CLI: a safe command needs NO liveness read at all (lazy) — works outside a repo', () => {
  // No fixture seams and a cwd that is not a git repo: if the guard still read liveness, the
  // worktree list would fail and `unproven` would kick in. A safe command must never get there.
  const r = spawnSync(process.execPath, [CLI, 'check', '--', 'git', 'gc'], {
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, GIT_MAINTENANCE_GUARD_OVERRIDE: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ALLOWED/);
  assert.doesNotMatch(r.stdout, /worktree\(s\) registered/);
});

test('CLI: a skipped liveness read is MARKED skipped in --json, not faked as quiet', () => {
  // "we did not look" and "we looked and it was quiet" are different claims; a --json consumer
  // must be able to tell them apart.
  const r = run(['check', ...SEAMS, '--json', '--', 'git', 'gc']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.liveness.skipped, true);
  const aggressive = JSON.parse(
    run(['check', ...SEAMS, '--json', '--', 'git', 'prune']).stdout.trim(),
  );
  assert.notEqual(aggressive.liveness.skipped, true);
  assert.equal(aggressive.liveness.worktreeCount, 2);
});

test('CLI: `git maintenance` driven by an immediate prune config is REFUSED', () => {
  const r = run(['check', ...SEAMS, '--', 'git', '-c', 'gc.pruneExpire=now', 'maintenance', 'run']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /REFUSED/);
});

test('CLI: `probe` is read-only and exits 0', () => {
  const r = run(['probe', ...SEAMS]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /linked worktrees: 2/);
});

test('CLI: a missing `--` command is a usage error (exit 2), not a pass', () => {
  const r = run(['check', ...SEAMS]);
  assert.equal(r.status, 2);
});

test('CLI: an unknown subcommand is a usage error (exit 2)', () => {
  const r = run(['sweep', ...SEAMS, '--', 'git', 'gc']);
  assert.equal(r.status, 2);
});

test('CLI: `run -- git <non-maintenance>` refuses with exit 2 and does NOT execute it', () => {
  const r = run(['run', ...SEAMS, '--', 'git', 'status']);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /not a git maintenance verb/);
});

test('CLI: `run` executes an allowed command and propagates ITS exit code', () => {
  // `git gc --prune=never` inside an empty temp dir is not a repo → git exits non-zero.
  // The point of the case is that the guard ALLOWED it and handed back git's own status,
  // rather than reporting its own 0.
  const r = spawnSync(
    process.execPath,
    [CLI, 'run', ...SEAMS, '--', 'git', 'gc', '--prune=never'],
    { encoding: 'utf8', cwd: dir, env: { ...process.env, GIT_MAINTENANCE_GUARD_OVERRIDE: '' } },
  );
  assert.notEqual(r.status, 1); // 1 is the guard's own REFUSED code; anything else is git's
  assert.match(r.stdout, /ALLOWED/);
});
