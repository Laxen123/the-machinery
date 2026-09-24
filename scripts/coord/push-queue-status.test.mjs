// scripts/push-queue-status.test.mjs — the plan-1795 push-queue probe.
//
// The contract every case defends: the probe is READ-ONLY and ALWAYS exits 0 — it exists so a
// session watching a silent `git push` checks the queues instead of blind-retrying (the 2026-07-13
// storm amplifier), and a probe that can itself fail a caller's chain or mutate a queue would be
// worse than no probe. Pure summarize/format logic is unit-tested directly; the CLI arm runs
// against fixture dirs via the --queue-dir/--lock-path seams (never the machine's real queues,
// which other live sessions own).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  summarize,
  formatStatus,
  scanProcesses,
  detectBranch,
  classifyPushCmd,
} from './push-queue-status.mjs';
import { DEFAULT_CONCURRENCY } from './test-queue.mjs';

const CLI = resolve(import.meta.dirname, 'push-queue-status.mjs');
const NOW = Date.parse('2026-07-13T19:30:00.000Z');
const ticket = (pid, startedAgoSec, extra = {}) => ({
  pid,
  startedWaiting: NOW - startedAgoSec * 1000,
  heartbeat: NOW - 1000,
  ...extra,
});

// --- summarize (pure) --------------------------------------------------------

test('summarize: free lock + empty queue + zero hooks is NOT busy', () => {
  const s = summarize({
    batteryEntry: undefined,
    tickets: [],
    processes: { prePushHooks: 0, landTestRuns: 0, nodeTestRunners: 0 },
    now: NOW,
  });
  assert.equal(s.battery.state, 'free');
  assert.deepEqual(s.testQueue.holders, []);
  assert.deepEqual(s.testQueue.waiting, []);
  assert.equal(s.busy, false);
});

test('summarize: a held battery lock alone makes the machine BUSY', () => {
  const s = summarize({
    batteryEntry: {
      token: 't',
      label: 'prepush-1',
      host: 'h',
      pid: 7,
      iso: new Date(NOW).toISOString(),
    },
    tickets: [],
    processes: null,
    now: NOW,
  });
  assert.equal(s.battery.state, 'held');
  assert.match(s.battery.holder, /prepush-1/);
  assert.equal(s.busy, true);
});

test('summarize: a FRESH lock whose declared holder is DEAD reports stale, not busy (plan 2549)', () => {
  // The caller computed holderProvedDead() = true (same host, declared holderPid, provably dead).
  // Age says fresh — but the very next acquire reaps this lock instantly, so reporting 'held'/BUSY
  // would tell a session to wait out up to the 120-min ceiling on a lock that no longer blocks
  // anything (review 2549 finding [1]; also feeds git-maintenance-guard's strong-signal read).
  const s = summarize({
    batteryEntry: {
      token: 't',
      label: 'prepush-1',
      host: 'h',
      pid: 7,
      holderPid: 4242,
      iso: new Date(NOW).toISOString(), // fresh — age alone would classify 'held'
    },
    batteryHolderDead: true,
    tickets: [],
    processes: null,
    now: NOW,
  });
  assert.equal(s.battery.state, 'stale');
  assert.equal(s.busy, false);
});

test('summarize: FIFO slot split — first N live tickets hold, the rest wait, stale ones vanish', () => {
  const s = summarize({
    batteryEntry: undefined,
    tickets: [
      ticket(30, 10, { label: 'late waiter' }),
      ticket(10, 120, { label: 'backend vitest', host: 'box' }),
      ticket(20, 60, { label: 'pytest' }),
      { pid: 99, startedWaiting: NOW - 600_000, heartbeat: NOW - 600_000, label: 'crashed' },
    ],
    processes: null,
    now: NOW,
    concurrency: 2,
  });
  assert.deepEqual(
    s.testQueue.holders.map((t) => t.pid),
    [10, 20],
  );
  assert.deepEqual(
    s.testQueue.waiting.map((t) => t.pid),
    [30],
  );
  // The display line carries what a session needs to identify the holder — including its
  // scheduling tier since plan 2716 (a pre-2716 ticket, like these, reads as the ruled default).
  assert.match(
    s.testQueue.holders[0].line,
    /pid 10 "backend vitest" \[medium\] \(host box, 120s in queue\)/,
  );
  assert.equal(s.busy, true);
});

// Plan 2716: waiters are listed in the order they will be SERVED (tier first, then FIFO), not in
// bare arrival order — a probe that disagrees with the queue it reports on is worse than none.
test('summarize: the waiting list is ordered by tier, then FIFO', () => {
  const s = summarize({
    batteryEntry: undefined,
    tickets: [
      { ...ticket(1, 300, { label: 'holder' }), startedRunning: NOW - 300_000 },
      ticket(2, 200, { label: 'bulk', tier: 'low' }),
      ticket(3, 150, { label: 'other bulk', tier: 'low' }),
      ticket(4, 10, { label: 'operator', tier: 'high' }),
    ],
    processes: null,
    now: NOW,
    concurrency: 1,
  });
  assert.deepEqual(
    s.testQueue.holders.map((t) => t.pid),
    [1],
    'the running ticket is never preempted by the high arrival',
  );
  assert.deepEqual(
    s.testQueue.waiting.map((t) => t.pid),
    [4, 2, 3],
    'high first, then the two lows in arrival order',
  );
  assert.equal(s.testQueue.waiting[0].tier, 'high');
});

test('summarize: a long-RUNNING low holder keeps its own tier — the guard is waiting-only', () => {
  // The starvation guard reorders a QUEUE; it cannot reorder work already in flight. Showing a
  // holder's effectiveTier relabelled a low job as `medium` just for having run a while — a tier
  // the queue never assigned it and never acts on.
  const s = summarize({
    batteryEntry: undefined,
    tickets: [
      { ...ticket(1, 3600, { label: 'long bulk', tier: 'low' }), startedRunning: NOW - 3_600_000 },
      ticket(2, 3600, { label: 'aged waiter', tier: 'low' }),
    ],
    processes: null,
    now: NOW,
    concurrency: 1,
  });
  assert.equal(s.testQueue.holders[0].tier, 'low', 'a running low holder stays low');
  assert.equal(s.testQueue.waiting[0].tier, 'medium', 'an aged low WAITER is promoted');
});

test('summarize: EACH live process count alone makes the machine BUSY (hooks, run-land-tests, node --test)', () => {
  // Review finding 0: a live run-land-tests/node --test tree is machine load even when its
  // sh wrapper is already gone or it runs entirely outside the pre-push hook.
  for (const processes of [
    { prePushHooks: 2, landTestRuns: 0, nodeTestRunners: 0 },
    { prePushHooks: 0, landTestRuns: 1, nodeTestRunners: 0 },
    { prePushHooks: 0, landTestRuns: 0, nodeTestRunners: 4 },
  ]) {
    const s = summarize({ batteryEntry: undefined, tickets: [], processes, now: NOW });
    assert.equal(s.busy, true, `expected busy for ${JSON.stringify(processes)}`);
  }
});

test('summarize: a STALE battery entry (crashed holder leftover) is reported but NOT busy', () => {
  // Review finding 1: the real acquire() reaps a past-ceiling entry and passes through — the
  // probe telling a session to wait on it would mask the push's actual (non-load) problem.
  const staleIso = new Date(NOW - 130 * 60_000).toISOString(); // > DEFAULT_STALE_MIN (120m)
  const s = summarize({
    batteryEntry: { token: 't', label: 'crashed-holder', host: 'h', pid: 9, iso: staleIso },
    tickets: [],
    processes: { prePushHooks: 0, landTestRuns: 0, nodeTestRunners: 0 },
    now: NOW,
  });
  assert.equal(s.battery.state, 'stale');
  assert.match(s.battery.holder, /crashed-holder/);
  assert.equal(s.busy, false);
  assert.match(formatStatus(s, { now: NOW, host: 'h' }), /STALE leftover/);
});

test('summarize: read errors degrade to state "unknown" and are NOT themselves a busy signal', () => {
  const s = summarize({
    batteryEntry: undefined,
    batteryError: 'not a git repository',
    tickets: [],
    queueError: 'EACCES',
    processes: null,
    now: NOW,
  });
  assert.equal(s.battery.state, 'unknown');
  assert.equal(s.testQueue.state, 'unknown');
  assert.equal(s.busy, false); // a probe error is not evidence of load
  assert.equal(s.testQueue.concurrency, DEFAULT_CONCURRENCY);
});

// --- formatStatus -------------------------------------------------------------

test('formatStatus: BUSY verdict tells the reader NOT to retry; QUIET verdict points elsewhere', () => {
  const busy = summarize({
    batteryEntry: { token: 't', label: 'prepush-9', iso: new Date(NOW).toISOString() },
    tickets: [],
    processes: null,
    now: NOW,
  });
  const busyText = formatStatus(busy, { now: NOW, host: 'test-host' });
  assert.match(busyText, /verdict:\s+BUSY/);
  assert.match(busyText, /Do NOT retry/);
  assert.match(busyText, /presumed QUEUED, not dead/);

  const quiet = summarize({ batteryEntry: undefined, tickets: [], processes: null, now: NOW });
  const quietText = formatStatus(quiet, { now: NOW, host: 'test-host' });
  assert.match(quietText, /verdict:\s+QUIET/);
  assert.match(quietText, /NOT explained by the test queues/);
  // Review finding 3: a QUIET verdict without the process scan is weaker — say so.
  assert.match(quietText, /CAVEAT: the process scan was unavailable/);

  const quietScanned = summarize({
    batteryEntry: undefined,
    tickets: [],
    processes: { prePushHooks: 0, landTestRuns: 0, nodeTestRunners: 0 },
    now: NOW,
  });
  assert.doesNotMatch(
    formatStatus(quietScanned, { now: NOW, host: 'test-host' }),
    /CAVEAT/,
    'a QUIET verdict WITH a successful scan carries no caveat',
  );
});

// --- scanProcesses ------------------------------------------------------------

test('scanProcesses: off-Windows returns null; a garbage scan returns null (never throws)', () => {
  assert.equal(scanProcesses({ _platform: 'linux' }), null);
  assert.equal(scanProcesses({ _platform: 'win32', _exec: () => 'garbage' }), null);
  assert.equal(scanProcesses({ _platform: 'win32', _exec: () => '{"hooks":"x"}' }), null);
  assert.equal(
    scanProcesses({
      _platform: 'win32',
      _exec: () => {
        throw new Error('CIM unavailable');
      },
    }),
    null,
  );
  assert.deepEqual(
    scanProcesses({ _platform: 'win32', _exec: () => '{"hooks":3,"rlt":1,"nt":12,"pushes":[]}\n' }),
    { prePushHooks: 3, landTestRuns: 1, nodeTestRunners: 12, pushes: [] },
  );
});

test('scanProcesses: pushes parse — array, PowerShell-unrolled single object, and null (plan 2731)', () => {
  // ConvertTo-Json serializes a ONE-element array property as a bare object — both shapes must
  // land as an array, or the single-live-push case (the incident's exact shape) is dropped.
  const single = scanProcesses({
    _platform: 'win32',
    _exec: () =>
      '{"hooks":0,"rlt":0,"nt":0,"pushes":{"pid":44852,"orphaned":true,"cmd":"git push origin worktree-x"}}',
  });
  assert.deepEqual(single.pushes, [
    { pid: 44852, orphaned: true, cmd: 'git push origin worktree-x' },
  ]);
  const many = scanProcesses({
    _platform: 'win32',
    _exec: () =>
      '{"hooks":0,"rlt":0,"nt":0,"pushes":[{"pid":1,"orphaned":false,"cmd":"git push"},{"pid":2,"orphaned":true,"cmd":"git push origin master"}]}',
  });
  assert.equal(many.pushes.length, 2);
  assert.equal(many.pushes[1].orphaned, true);
  const none = scanProcesses({ _platform: 'win32', _exec: () => '{"hooks":0,"rlt":0,"nt":0}' });
  assert.deepEqual(none.pushes, []);
});

test('scanProcesses: MSYS wrapper chain deduped to the topmost process; URL credentials redacted', () => {
  // One real push = cmd\git.exe (pid 100) spawning mingw64\bin\git.exe (pid 200) with the same
  // command line — the report must count pushes, not wrappers.
  const out = scanProcesses({
    _platform: 'win32',
    _exec: () =>
      JSON.stringify({
        hooks: 0,
        rlt: 0,
        nt: 0,
        pushes: [
          {
            pid: 100,
            ppid: 50,
            orphaned: false,
            cmd: 'git push https://x:tok3n@github.com/a/b worktree-x', // personal-data-ok: fixture credential-URL redaction test
          },
          {
            pid: 200,
            ppid: 100,
            orphaned: false,
            cmd: 'git push https://x:tok3n@github.com/a/b worktree-x', // personal-data-ok: fixture credential-URL redaction test
          },
        ],
      }),
  });
  assert.equal(out.pushes.length, 1);
  assert.equal(out.pushes[0].pid, 100);
  assert.doesNotMatch(out.pushes[0].cmd, /tok3n/);
  assert.match(out.pushes[0].cmd, /\/\/\*\*\*@github\.com/);
});

test('detectBranch: trims, rejects detached HEAD, degrades to null on git failure', () => {
  assert.equal(detectBranch({ _exec: () => 'worktree-2731-x\n' }), 'worktree-2731-x');
  assert.equal(detectBranch({ _exec: () => 'HEAD\n' }), null);
  assert.equal(
    detectBranch({
      _exec: () => {
        throw new Error('not a git repository');
      },
    }),
    null,
  );
});

// --- live same-branch push (plan 2731) ----------------------------------------

test('classifyPushCmd: whole refspec tokens only — no substring/prefix matches', () => {
  const b = 'worktree-2731-x';
  assert.equal(classifyPushCmd('git push origin worktree-2731-x', b), 'match');
  assert.equal(classifyPushCmd('git push -u origin worktree-2731-x', b), 'match');
  assert.equal(classifyPushCmd('git push origin +worktree-2731-x', b), 'match');
  // Either side of a src:dst refspec counts — pushing FROM the branch or INTO it.
  assert.equal(classifyPushCmd('git push origin worktree-2731-x:master', b), 'match');
  assert.equal(classifyPushCmd('git push origin HEAD:worktree-2731-x', b), 'match');
  // The first-review bug: a substring match would hit ALL of these.
  assert.equal(classifyPushCmd('git push origin worktree-2731-x-v2', b), 'other');
  assert.equal(classifyPushCmd('git push origin other-branch', b), 'other');
  // A quoted exe path with spaces must not derail tokenization.
  assert.equal(
    classifyPushCmd('"C:\\Program Files\\Git\\cmd\\git.exe" push origin worktree-2731-x', b),
    'match',
  );
  assert.equal(classifyPushCmd('git status', b), 'other');
});

test('classifyPushCmd: implicit targets (bare/HEAD/--all) are INDETERMINATE, never silently other', () => {
  const b = 'worktree-2731-x';
  // The land spine's own committed shape (branch-hygiene.md): target depends on that
  // process's repo/HEAD, which a command line cannot reveal.
  assert.equal(classifyPushCmd('git push origin HEAD:master', b), 'indeterminate');
  assert.equal(classifyPushCmd('git push origin HEAD', b), 'indeterminate');
  assert.equal(classifyPushCmd('git push', b), 'indeterminate');
  assert.equal(classifyPushCmd('git push origin', b), 'indeterminate');
  assert.equal(classifyPushCmd('git push --all origin', b), 'indeterminate');
  // An explicit non-matching refspec ALONGSIDE HEAD still reads indeterminate (HEAD may be us).
  assert.equal(classifyPushCmd('git push origin HEAD other', b), 'indeterminate');
});

test('summarize: a live push naming the CURRENT branch fills livePushes and makes BUSY', () => {
  // The incident shape: the wedge sweeper killed the push's wrapper, the harness reported the
  // task FAILED, and nothing told the session "your branch already has a live (orphaned) push".
  const pushes = [
    { pid: 44852, orphaned: true, cmd: 'git push origin worktree-2731-x' },
    { pid: 7, orphaned: false, cmd: 'git push origin some-other-branch' },
  ];
  const s = summarize({
    batteryEntry: undefined,
    tickets: [],
    processes: { prePushHooks: 0, landTestRuns: 0, nodeTestRunners: 0, pushes },
    now: NOW,
    currentBranch: 'worktree-2731-x',
  });
  assert.deepEqual(
    s.livePushes.map((p) => p.pid),
    [44852],
  );
  assert.equal(s.busy, true);

  // No branch known (detached HEAD / not a repo) -> no branch matching, but ANY live push is
  // still push machinery and votes busy (second-review finding — the branch filter only decides
  // which pushes earn the DO-NOT-RE-PUSH verdict, not whether the machine is loaded).
  const noBranch = summarize({
    batteryEntry: undefined,
    tickets: [],
    processes: { prePushHooks: 0, landTestRuns: 0, nodeTestRunners: 0, pushes },
    now: NOW,
    currentBranch: null,
  });
  assert.deepEqual(noBranch.livePushes, []);
  assert.deepEqual(noBranch.indeterminatePushes, []);
  assert.equal(noBranch.busy, true);
});

test('summarize + formatStatus: an implicit-target push is reported as its own bucket', () => {
  const s = summarize({
    batteryEntry: undefined,
    tickets: [],
    processes: {
      prePushHooks: 0,
      landTestRuns: 0,
      nodeTestRunners: 0,
      pushes: [{ pid: 9001, orphaned: true, cmd: 'git push origin HEAD:master' }],
    },
    now: NOW,
    currentBranch: 'worktree-2731-x',
  });
  assert.deepEqual(s.livePushes, []);
  assert.equal(s.indeterminatePushes.length, 1);
  assert.equal(s.busy, true);
  const text = formatStatus(s, { now: NOW, host: 'test-host' });
  assert.match(text, /live push:\s+pid 9001 ORPHANED — IMPLICIT target/);
  // No same-branch certainty -> no DO-NOT-RE-PUSH verdict, but the machine reads BUSY.
  assert.match(text, /verdict:\s+BUSY/);
});

test('formatStatus: a live same-branch push gets the DO-NOT-RE-PUSH verdict and names the orphan', () => {
  const s = summarize({
    batteryEntry: undefined,
    tickets: [],
    processes: {
      prePushHooks: 0,
      landTestRuns: 0,
      nodeTestRunners: 0,
      pushes: [{ pid: 44852, orphaned: true, cmd: 'git push origin worktree-2731-x' }],
    },
    now: NOW,
    currentBranch: 'worktree-2731-x',
  });
  const text = formatStatus(s, { now: NOW, host: 'test-host' });
  assert.match(text, /live push:\s+pid 44852 ORPHANED/);
  assert.match(text, /verdict:\s+DO NOT RE-PUSH/);
  assert.match(text, /worktree-2731-x/);
  assert.doesNotMatch(text, /verdict:\s+BUSY/);
});

// --- CLI end-to-end (fixture dirs via the test seams — never the real queues) --

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
}

test('CLI --json: reads fixture lock + queue dir, reports both, exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pqs-'));
  const lockPath = join(dir, 'battery-lock.json');
  writeFileSync(
    lockPath,
    JSON.stringify({
      token: 'x',
      label: 'prepush-42',
      iso: new Date().toISOString(),
      pid: 1,
      host: 'h',
    }),
  );
  const queueDir = join(dir, 'queue');
  // One live ticket (fresh heartbeat) — written the same shape acquire() writes.
  const started = Date.now() - 5000;
  const qf = join(queueDir, `${started}-123.json`);
  mkdirSync(queueDir);
  writeFileSync(
    qf,
    JSON.stringify({
      pid: 123,
      host: 'h',
      label: 'backend vitest',
      startedWaiting: started,
      heartbeat: Date.now(),
    }),
  );

  const out = runCli(['--json', '--lock-path', lockPath, '--queue-dir', queueDir]);
  assert.equal(out.status, 0, out.stderr);
  const s = JSON.parse(out.stdout);
  assert.equal(s.battery.state, 'held');
  assert.match(s.battery.holder, /prepush-42/);
  assert.equal(s.testQueue.holders.length, 1);
  assert.equal(s.testQueue.holders[0].pid, 123);
  assert.equal(s.busy, true);
  // READ-ONLY: the probe must not have pruned/reaped either fixture.
  assert.equal(readFileSync(qf, 'utf8').includes('backend vitest'), true);
  assert.equal(readFileSync(lockPath, 'utf8').includes('prepush-42'), true);
});

test('CLI: a value flag that swallowed the NEXT flag is surfaced (still exit 0), not acted on', () => {
  // parseFlags consumes the next token as the value even when it is itself a flag — the probe
  // must refuse `--lock-path --json` loudly instead of probing a lock at the literal path
  // "--json" and silently dropping JSON mode (delta-review finding 1).
  const out = runCli(['--lock-path', '--json']);
  assert.equal(out.status, 0, 'the probe contract: even a usage error exits 0');
  assert.match(out.stderr, /--lock-path is missing its value/);
});

test('CLI: an explicitly EMPTY --branch= is refused loudly, not silently no-matched', () => {
  const out = runCli(['--branch', '']);
  assert.equal(out.status, 0, 'the probe contract: even a usage error exits 0');
  assert.match(out.stderr, /--branch is missing its value/);
});

test('CLI: a missing queue dir reads as an EMPTY queue (not an error), still exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pqs-empty-'));
  const out = runCli([
    '--json',
    '--lock-path',
    join(dir, 'no-lock.json'),
    '--queue-dir',
    join(dir, 'never-created'),
  ]);
  assert.equal(out.status, 0, out.stderr);
  const s = JSON.parse(out.stdout);
  assert.equal(s.battery.state, 'free');
  assert.equal(s.testQueue.state, 'ok');
  assert.deepEqual(s.testQueue.waiting, []);
});

// ── plan 2734: the probe must be able to SEE a battery running outside the mutex ──────────────
// The blind spot this closes, measured 2026-08-02: this tool printed `test-queue: 0/2 slot(s) held,
// 0 waiting` while the SAME probe counted 27 pre-push shells and 11 live `node --test` processes.
// Occupancy cannot see that on its own, because an unserialized battery holds nothing.

const HELD = (label) => ({
  token: 't-' + label,
  label,
  host: 'h',
  pid: 7,
  iso: new Date(NOW).toISOString(),
});

test('plan 2734: live test trees with NEITHER tier held report the bypass, and formatStatus NAMES it', () => {
  const s = summarize({
    batteryEntry: undefined, // 0 held …
    overflowEntry: undefined, // … on both tiers …
    tickets: [], // … and an empty queue …
    processes: { prePushHooks: 27, landTestRuns: 4, nodeTestRunners: 11 }, // … beside live batteries
    now: NOW,
  });
  assert.equal(s.battery.state, 'free');
  assert.equal(s.overflow.state, 'free');
  assert.deepEqual(s.testQueue.holders, []);
  assert.equal(s.unserialized.state, 'unlocked');
  assert.equal(s.unserialized.nodeTestRunners, 11);
  // The whole point of the plan: this exact state may never PRINT as a quiet machine again.
  const out = formatStatus(s, { now: NOW, host: 'h' });
  assert.match(
    out,
    /UNSERIALIZED: 11 live node --test process\(es\) while NEITHER lock tier is held/,
  );
  assert.match(out, /do NOT read the queue lines above as a quiet machine/);
  // It must NOT assert these ARE batteries (review round 2): a manual `node --test` is machine load
  // just the same, and the operational advice does not depend on telling them apart.
  assert.match(out, /a battery that timed out past the queue, or a manual run/);
  assert.equal(s.busy, true); // the raw process counts already voted busy; that is unchanged
});

test('plan 2734: a held OVERFLOW slot is reported on its own line, votes BUSY, and accounts for the load', () => {
  const s = summarize({
    batteryEntry: undefined,
    overflowEntry: HELD('prepush-admitted'),
    tickets: [],
    processes: { prePushHooks: 2, landTestRuns: 1, nodeTestRunners: 3 },
    now: NOW,
  });
  assert.equal(s.overflow.state, 'held');
  assert.match(s.overflow.holder, /prepush-admitted/);
  // A clamped bypass battery IS machine load — the retry-discipline verdict must count it, or a
  // session reads "not busy" while a battery runs and fires the blind retry this probe exists to stop.
  assert.equal(s.busy, true);
  assert.equal(s.unserialized.state, 'partly-owned');
  const out = formatStatus(s, { now: NOW, host: 'h' });
  assert.match(out, /^battery-overflow: held by /m);
  assert.match(out, /reduced parallelism/);
  assert.doesNotMatch(out, /UNSERIALIZED:/); // owned load must not raise the loud line
  // ...but it must not go SILENT either (review round 2): a held tier means SOME serialized work
  // exists, never that any scanned process belongs to it, so the report states both facts and
  // asserts no link between them (round 3 walked back the "at least one has an owner" wording).
  assert.match(out, /^note: +3 live node --test process\(es\), and a lock tier IS held/m);
  assert.match(out, /Nothing here ties a process to the holder/);
});

test('plan 2734: a held serialized tier suppresses the bypass alarm (no false UNSERIALIZED)', () => {
  const s = summarize({
    batteryEntry: HELD('prepush-holder'),
    overflowEntry: undefined,
    tickets: [],
    processes: { prePushHooks: 3, landTestRuns: 1, nodeTestRunners: 9 },
    now: NOW,
  });
  assert.equal(s.unserialized.state, 'partly-owned');
  const out2 = formatStatus(s, { now: NOW, host: 'h' });
  assert.doesNotMatch(out2, /UNSERIALIZED:/);
  assert.match(out2, /^note: +9 live node --test process\(es\), and a lock tier IS held/m);
});

test('plan 2734: no process scan reports UNKNOWN, never a false "none"', () => {
  const s = summarize({
    batteryEntry: undefined,
    overflowEntry: undefined,
    tickets: [],
    processes: null, // non-Windows, or a failed CIM scan
    now: NOW,
  });
  // Absence of evidence is not evidence of a quiet machine — the same posture the QUIET verdict's
  // own scan caveat takes.
  assert.equal(s.unserialized.state, 'unknown');
  assert.equal(s.unserialized.nodeTestRunners, null);
  assert.doesNotMatch(formatStatus(s, { now: NOW, host: 'h' }), /UNSERIALIZED:/);
});

test('plan 2734: a STALE overflow leftover is reported but does NOT count as busy', () => {
  const s = summarize({
    batteryEntry: undefined,
    overflowEntry: {
      token: 't',
      label: 'crashed',
      host: 'h',
      pid: 9,
      iso: '2026-07-13T10:00:00.000Z',
    },
    tickets: [],
    processes: { prePushHooks: 0, landTestRuns: 0, nodeTestRunners: 0 },
    now: NOW, // 9.5h later — far past the age ceiling
  });
  // Same rule the serialized tier already follows: the next admission reaps it, so telling a session
  // to wait on it would mask its push's real problem.
  assert.equal(s.overflow.state, 'stale');
  assert.equal(s.busy, false);
  assert.match(formatStatus(s, { now: NOW, host: 'h' }), /^battery-overflow: STALE leftover/m);
});

test('plan 2734: an omitted overflow input reports free — an older caller/fixture never crashes', () => {
  const s = summarize({ batteryEntry: undefined, tickets: [], processes: null, now: NOW });
  assert.equal(s.overflow.state, 'free');
  assert.match(formatStatus(s, { now: NOW, host: 'h' }), /^battery-overflow: free$/m);
});

test('plan 2734: a FULLY QUALIFIED destination refspec matches its branch (found in real use)', () => {
  const br = 'worktree-2734-FABLE-Infra-battery-lock';
  // The exact shape that misfired: the probe called this an IMPLICIT target and fell back to the
  // hedged "if your last push used an implicit refspec…" verdict, so the most explicit refspec a
  // caller can write produced the weakest attribution.
  assert.equal(classifyPushCmd(`git.exe push origin HEAD:refs/heads/${br}`, br), 'match');
  assert.equal(classifyPushCmd(`git push origin ${br}:refs/heads/${br}`, br), 'match');
  assert.equal(classifyPushCmd(`git push origin refs/heads/${br}`, br), 'match');
  assert.equal(classifyPushCmd(`git push origin +HEAD:refs/heads/${br}`, br), 'match'); // force
  // The branch side is NOT normalized (delta review): `branch` is the name git reports, so a branch
  // legitimately NAMED `refs/heads/<br>` is a DIFFERENT branch from `<br>` and must not cross-match
  // in either direction. This costs the `--branch refs/heads/x` convenience on purpose — that
  // synonym is precisely what makes the two indistinguishable.
  assert.equal(classifyPushCmd(`git push origin HEAD:${br}`, `refs/heads/${br}`), 'indeterminate');
  assert.equal(classifyPushCmd(`git push origin ${br}`, `refs/heads/${br}`), 'other');
  assert.equal(classifyPushCmd(`git push origin refs/heads/${br}`, `refs/heads/${br}`), 'match');
  // Whole-token discipline is UNCHANGED — normalizing one fixed prefix must not create substring
  // matches (the property plan 2731's review pinned).
  assert.equal(classifyPushCmd(`git push origin HEAD:refs/heads/${br}-v2`, br), 'indeterminate');
  assert.equal(classifyPushCmd(`git push origin refs/heads/${br}-v2`, br), 'other');
  // And a genuinely implicit target still reads as indeterminate, never as a false match.
  assert.equal(classifyPushCmd('git push origin HEAD', br), 'indeterminate');
});

test('plan 2734 delta review: a QUOTED refspec survives tokenization (the exe-path strip ate it)', () => {
  const br = 'worktree-2734-FABLE-Infra-battery-lock';
  // Windows CIM command lines quote the exe path, and the first cut DELETED every quoted span to
  // get that path (with its spaces) out of the way — which also deleted a quoted refspec, so the
  // most explicit form a caller can write again produced the weakest verdict.
  assert.equal(classifyPushCmd(`git push origin "HEAD:refs/heads/${br}"`, br), 'match');
  assert.equal(classifyPushCmd(`git push origin "${br}"`, br), 'match');
  // The exe path is still neutralized: it survives as ONE token, so it cannot shift refspec
  // positions and it is not the literal `push`.
  assert.equal(
    classifyPushCmd(`"C:\Program Files\Git\mingw64\bin\git.exe" push origin ${br}`, br),
    'match',
  );
  assert.equal(
    classifyPushCmd(`"C:\Program Files\Git\bin\git.exe" push origin other-branch`, br),
    'other',
  );
  // A quoted whole-token stays whole: quoting must not open a substring path.
  assert.equal(classifyPushCmd(`git push origin "refs/heads/${br}-v2"`, br), 'other');
});

test('plan 2734 delta review: an UNREADABLE lock tier is not reported as an unserialized bypass', () => {
  const live = { prePushHooks: 0, landTestRuns: 0, nodeTestRunners: 4 };
  // NEITHER tier reads as held — but the serialized read FAILED, so "neither is held" is not a fact.
  // The first cut classified this 'unlocked' and fired the loud alarm on what may be a perfectly
  // serialized machine.
  const s = summarize({
    batteryEntry: undefined,
    batteryError: 'not a git repository',
    overflowEntry: undefined,
    tickets: [],
    processes: live,
    now: NOW,
  });
  assert.equal(s.unserialized.state, 'lock-unreadable');
  assert.equal(s.unserialized.nodeTestRunners, 4);
  const out = formatStatus(s, { now: NOW, host: 'h' });
  assert.doesNotMatch(out, /UNSERIALIZED:/);
  assert.match(out, /could NOT be read/);
  // With both tiers READABLE and free, the same process picture is still the loud bypass signal.
  const clean = summarize({
    batteryEntry: undefined,
    overflowEntry: undefined,
    tickets: [],
    processes: live,
    now: NOW,
  });
  assert.equal(clean.unserialized.state, 'unlocked');
  assert.match(formatStatus(clean, { now: NOW, host: 'h' }), /UNSERIALIZED:/);
  // A HELD tier still wins over an unreadable sibling — a known holder is the stronger fact.
  const held = summarize({
    batteryEntry: { token: 't', label: 'b', host: 'h', pid: 1, iso: '2026-07-13T19:25:00.000Z' },
    overflowError: 'read failed',
    tickets: [],
    processes: live,
    now: NOW,
  });
  assert.equal(held.unserialized.state, 'partly-owned');
});

test('plan 2734 delta review: the partly-owned note attributes NO process to the holder', () => {
  const s = summarize({
    batteryEntry: { token: 't', label: 'b', host: 'h', pid: 1, iso: '2026-07-13T19:25:00.000Z' },
    overflowEntry: undefined,
    tickets: [],
    processes: { prePushHooks: 0, landTestRuns: 0, nodeTestRunners: 3 },
    now: NOW,
  });
  const out = formatStatus(s, { now: NOW, host: 'h' });
  // The wording that replaced 'accounted' still claimed "at least one has an owner", which the data
  // does not support: the lock may be held through a setup phase, or by another clone.
  assert.doesNotMatch(out, /has an owner/);
  assert.match(out, /Nothing here ties a process to the holder/);
});

test('plan 2734 delta review: a QUIET verdict names an unreadable lock tier', () => {
  const s = summarize({
    batteryEntry: undefined,
    overflowError: 'EPERM',
    tickets: [],
    processes: { prePushHooks: 0, landTestRuns: 0, nodeTestRunners: 0, pushes: [] },
    now: NOW,
  });
  assert.equal(s.busy, false); // an unreadable lock is not evidence of load — it must not flip BUSY
  const out = formatStatus(s, { now: NOW, host: 'h' });
  assert.match(out, /verdict: {6}QUIET/);
  assert.match(out, /CAVEAT: a lock tier could not be read/);
  // Both tiers readable ⇒ the QUIET line carries no lock caveat at all.
  const clean = summarize({
    batteryEntry: undefined,
    overflowEntry: undefined,
    tickets: [],
    processes: { prePushHooks: 0, landTestRuns: 0, nodeTestRunners: 0, pushes: [] },
    now: NOW,
  });
  assert.doesNotMatch(formatStatus(clean, { now: NOW, host: 'h' }), /CAVEAT/);
});

test('plan 2734 delta review: push OPTION VALUES are not mistaken for the remote/refspec', () => {
  const br = 'worktree-2734-FABLE-Infra-battery-lock';
  // `-o ci.skip origin` — dropping only the `-`-prefixed token left `ci.skip` in the positional
  // list, where it was read as the REMOTE, making `origin` look like an explicit refspec. The probe
  // then answered 'other' — a confident wrong answer that HID a live push of this branch.
  assert.equal(classifyPushCmd(`git push -o ci.skip origin`, br), 'indeterminate');
  assert.equal(classifyPushCmd(`git push -o ci.skip origin ${br}`, br), 'match');
  // `--repo` consumes its VALUE but does NOT change positional parsing: the first positional is
  // still the repository. Measured on real git rather than argued from its docs (round 4 read the
  // "takes precedence" wording as meaning --repo substitutes for the positional, round 5 read it the
  // other way, neither showed evidence):
  //   $ git push --repo https://example.invalid/x.git aaa master --dry-run
  //   fatal: 'aaa' does not appear to be a git repository
  assert.equal(classifyPushCmd(`git push --repo https://x/y.git ${br}`, br), 'indeterminate');
  assert.equal(classifyPushCmd(`git push --repo https://x/y.git origin ${br}`, br), 'match');
  assert.equal(classifyPushCmd(`git push --repo=https://x/y.git origin ${br}`, br), 'match');
  // `--recurse-submodules <mode>` takes a value in the split form too — its mode was being read
  // as the remote.
  assert.equal(
    classifyPushCmd(`git push --recurse-submodules on-demand origin ${br}`, br),
    'match',
  );
  assert.equal(classifyPushCmd(`git push --receive-pack /usr/bin/rp origin ${br}`, br), 'match');
  // The `=`-joined form was never affected — it is one token and already dropped as a flag.
  assert.equal(classifyPushCmd(`git push --push-option=ci.skip origin ${br}`, br), 'match');
  // A tag-only push can never target a branch, so it is 'other', not the hedged 'indeterminate'
  // that tells a session its own push may still be running.
  assert.equal(classifyPushCmd('git push --tags origin', br), 'other');
  // --follow-tags pushes the BRANCH and its tags — it stays indeterminate.
  assert.equal(classifyPushCmd('git push --follow-tags origin', br), 'indeterminate');
  assert.equal(classifyPushCmd(`git push --tags origin ${br}`, br), 'match');
});

test('plan 2734 delta review: the refs/heads/ residual ambiguity errs toward DO-NOT-RE-PUSH', () => {
  // For a branch actually NAMED `refs/heads/foo`, the token `refs/heads/foo` is both its own short
  // form and the qualified form of the ordinary branch `foo`. Git resolves that against the real ref
  // namespace; a command line cannot. Pinned deliberately: the surviving error direction must be
  // over-matching (the session WAITS) and never under-matching (the session duplicates a push).
  assert.equal(classifyPushCmd('git push origin refs/heads/foo', 'refs/heads/foo'), 'match');
  assert.equal(classifyPushCmd('git push origin refs/heads/foo', 'foo'), 'match');
  // The unambiguous forms stay unambiguous in both directions.
  assert.equal(classifyPushCmd('git push origin foo', 'refs/heads/foo'), 'other');
  assert.equal(
    classifyPushCmd('git push origin refs/heads/refs/heads/foo', 'refs/heads/foo'),
    'match',
  );
});

test('plan 2734 delta review: --lock-path ALONE also skips the `git rev-parse` spawn', () => {
  // The first cut required BOTH tier flags, so the lock-path-only shape — most fixtures, and the
  // one a session reaches for — kept paying the spawn for a value it then discarded. Overflow
  // already reports 'free' in this shape by its own rule, so nothing needs resolving.
  const dir = mkdtempSync(join(tmpdir(), 'pqs-nonrepo1-'));
  const lockPath = join(dir, 'battery-lock.json');
  writeFileSync(
    lockPath,
    JSON.stringify({ token: 'x', label: 'prepush-1', iso: new Date().toISOString(), pid: 1 }),
  );
  const out = runCli(['--json', '--lock-path', lockPath, '--queue-dir', dir], { cwd: dir });
  assert.equal(out.status, 0, out.stderr);
  const s = JSON.parse(out.stdout);
  assert.equal(s.battery.state, 'held');
  assert.equal(s.battery.error, undefined);
  assert.equal(s.overflow.state, 'free');
  assert.equal(s.overflow.error, undefined);
});

test('plan 2734 delta review: both tier paths given ⇒ NO `git rev-parse` spawn at all', () => {
  // The probe is what a session runs DURING a process storm, so an avoidable synchronous spawn is
  // pure cost on the worst possible path — and resolving a value it then discards made every
  // fixture invocation silently depend on the cwd being a git repo. Running from a NON-repo cwd
  // with both tier paths supplied proves the resolution is skipped: if it still ran, git would
  // report "not a git repository" into the tier fields.
  const dir = mkdtempSync(join(tmpdir(), 'pqs-nonrepo-'));
  const lockPath = join(dir, 'battery-lock.json');
  const overflowPath = join(dir, 'battery-overflow-lock.json');
  writeFileSync(
    lockPath,
    JSON.stringify({ token: 'x', label: 'prepush-1', iso: new Date().toISOString(), pid: 1 }),
  );
  const out = runCli(
    ['--json', '--lock-path', lockPath, '--overflow-lock-path', overflowPath, '--queue-dir', dir],
    { cwd: dir },
  );
  assert.equal(out.status, 0, out.stderr);
  const s = JSON.parse(out.stdout);
  assert.equal(s.battery.state, 'held');
  assert.equal(s.battery.error, undefined);
  assert.equal(s.overflow.state, 'free'); // the file simply does not exist — free, not unknown
  assert.equal(s.overflow.error, undefined);
});

test('plan 2734 round 4: a VALUELESS or EMPTY value flag is refused, never silently defaulted', () => {
  // Both shapes used to reach the default: `--lock-path` at the end of argv stored `undefined`
  // (read as absent by `??`), and `--lock-path=` stored `''` (falsy but not nullish, so it slipped
  // past the `== null` guard and suppressed default resolution instead). A fixture probe that
  // silently retargets the REAL machine lock is the worst possible failure for a read-only tool.
  for (const args of [
    ['--lock-path'],
    ['--lock-path='],
    ['--queue-dir'],
    ['--queue-dir='],
    ['--branch'],
    ['--branch='],
    ['--overflow-lock-path'],
    ['--overflow-lock-path='],
  ]) {
    const out = runCli(args);
    // The probe contract is absolute: read-only, ALWAYS exit 0 — it reports the error, never
    // fails its caller's chain.
    assert.equal(out.status, 0, `${args[0]} must still exit 0, got ${out.status}`);
    assert.match(
      out.stderr + out.stdout,
      /is missing its value/,
      `${args[0]} was not refused: ${out.stderr || out.stdout}`,
    );
  }
});

test('plan 2734 round 5: the SUBCOMMAND is found past git global options, not by first `push` token', () => {
  const br = 'worktree-2734-FABLE-Infra-battery-lock';
  // `git -C <dir> push …` is how every coord script drives a temp checkout. Matching the first
  // token that merely equals 'push' meant a `-C` argument named `push` became the subcommand and
  // shifted every position after it.
  assert.equal(classifyPushCmd(`git -C /tmp/x push origin ${br}`, br), 'match');
  assert.equal(classifyPushCmd(`git -C push push origin ${br}`, br), 'match');
  assert.equal(classifyPushCmd(`git -c user.name=x push origin ${br}`, br), 'match');
  assert.equal(classifyPushCmd(`git --git-dir /tmp/g push origin ${br}`, br), 'match');
  // A non-push subcommand is still 'other', including one whose ARGUMENT is the word push.
  assert.equal(classifyPushCmd(`git log --grep push origin ${br}`, br), 'other');
  assert.equal(classifyPushCmd(`git -C /tmp/x fetch origin ${br}`, br), 'other');
});

test('plan 2734 round 6: subcommand + mode flags survive the shapes each review round found', () => {
  const br = 'worktree-2734-FABLE-Infra-battery-lock';
  // An ARGUMENTS-ONLY command line (no executable token) — index 0 cannot be assumed to be the exe.
  assert.equal(classifyPushCmd(`push origin ${br}`, br), 'match');
  // A global option from the SHARED table that the local copy was missing.
  assert.equal(classifyPushCmd(`git --config-env foo.bar=ENV push origin ${br}`, br), 'match');
  assert.equal(classifyPushCmd(`git --super-prefix x/ push origin ${br}`, br), 'match');
  assert.equal(classifyPushCmd(`git --exec-path /usr/lib/git push origin ${br}`, br), 'match');
  // A valueless global option must not stop the scan.
  assert.equal(classifyPushCmd(`git --no-pager push origin ${br}`, br), 'match');
  // ...but a genuinely different subcommand must, even when an ARGUMENT is the word `push`.
  assert.equal(classifyPushCmd(`git log --grep push origin ${br}`, br), 'other');
  assert.equal(classifyPushCmd(`git rev-parse push`, br), 'other');
  // A flag consumed as an option VALUE is not an option: `-o --tags` is a push-option string, and
  // git still performs a normal branch push (round 6).
  assert.equal(classifyPushCmd(`git push -o --tags origin ${br}`, br), 'match');
  assert.equal(classifyPushCmd(`git push -o --tags origin`, br), 'indeterminate');
  assert.equal(classifyPushCmd(`git push -o --all origin`, br), 'indeterminate');
  // The real flags still mean what they mean.
  assert.equal(classifyPushCmd(`git push --tags origin`, br), 'other');
  assert.equal(classifyPushCmd(`git push --all origin`, br), 'indeterminate');
});
