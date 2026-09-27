// scripts/test-queue.test.mjs — unit tests for the machine-global test-run
// queue (plan 1750). Everything correctness-critical lives in the pure
// computeHolders core (FIFO ordering, the concurrency-N cut, stale pruning,
// deterministic tie-break) and is tested without spawning anything; one light
// in-process integration test exercises the acquire/release ticket protocol
// against a temp dir with injected pids and a tiny poll interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeHolders,
  compareWaiting,
  effectiveTier,
  isRunningTicket,
  normalizeTier,
  perSlotWorkerBudget,
  perSlotWorkerBudgetDetail,
  resolveTestQueueConcurrency,
  acquire,
  readTickets,
  LOW_PROMOTE_MS,
  MAX_WAIT_MS,
  makeAdmissionScanner,
  TEST_SLOT_ADMITTED_MARKER,
  SLOT_ADMISSION_GRACE_MS,
  slotAdmissionBackstopMs,
  withTestSlot,
  FAIL_OPEN_CONCURRENCY,
  FAIL_OPEN_ENV,
  clampWorkerValue,
} from './test-queue.mjs';
import { OVERFLOW_TEST_CONCURRENCY } from './battery-lock.mjs';

// opts.budget: null disables the memory axis outright (no file read, no freemem() call) — the
// pre-3954 CPU-only behaviour the tests below this point were written to assert.
const CPU_ONLY = { budget: null };
// The T0 measurement (scripts/pytest-memory-budget.json perWorkerPeakBytes) as a fixture, never
// the live file or the live machine's freemem() — the platform-symbol rule in vetapp CLAUDE.md
// ("fake the memory reader as a parameter, never read the live machine in a test") applies here.
const FIXTURE_PEAK_BYTES = 3_656_278_016;

const T0 = 1_000_000; // arbitrary epoch base — computeHolders only compares numbers
const ticket = (pid, startedWaiting, heartbeat = T0) => ({ pid, startedWaiting, heartbeat });

test('effective concurrency and per-slot CPU budget share one validated policy', () => {
  assert.equal(resolveTestQueueConcurrency({ TEST_QUEUE_CONCURRENCY: '4' }), 4);
  assert.equal(resolveTestQueueConcurrency({ TEST_QUEUE_CONCURRENCY: 'invalid' }), 2);
  assert.equal(perSlotWorkerBudget(20, { TEST_QUEUE_CONCURRENCY: '4' }, CPU_ONLY), 4);
  assert.equal(
    perSlotWorkerBudget(
      40,
      { TEST_QUEUE_CONCURRENCY: '4', VETAPP_CPU_CAP_PERCENT: '90' },
      CPU_ONLY,
    ),
    9,
  );
});

// Plan 3954 T3 — the memory axis: workers = min(cpuBudget, memoryBudget), never an admission
// floor (plan 1750's fixed-concurrency ruling stands; only the worker count inside a slot moves).
// Review fix (plan 3954): the memory axis budgets against its SHARE of free memory — freemem() /
// the queue's slot count — exactly like the CPU axis already divides by
// resolveTestQueueConcurrency(env), because every concurrent slot reads the same live freemem()
// figure; an undivided budget lets N slots each admit up to the full free pool's worth of
// workers and collectively demand N times the machine's free memory.
test('perSlotWorkerBudget: memory axis caps workers below the CPU budget when it binds', () => {
  const cpu = 40;
  const env = { TEST_QUEUE_CONCURRENCY: '4', VETAPP_CPU_CAP_PERCENT: '90' }; // cpuBudget = 9
  // 40 GB free / 4 slots = 10 GB share / 3.66 GB peak -> 2 workers, below the CPU budget of 9.
  assert.equal(
    perSlotWorkerBudget(cpu, env, {
      freemem: () => 40_000_000_000,
      budget: { perWorkerPeakBytes: FIXTURE_PEAK_BYTES },
    }),
    2,
  );
});

test('perSlotWorkerBudget: CPU stays the binding axis with ample free memory', () => {
  const cpu = 40;
  const env = { TEST_QUEUE_CONCURRENCY: '4', VETAPP_CPU_CAP_PERCENT: '90' }; // cpuBudget = 9
  // 200 GB free / 4 slots = 50 GB share / 3.66 GB peak -> 13 workers, well above the CPU budget of 9.
  assert.equal(
    perSlotWorkerBudget(cpu, env, {
      freemem: () => 200_000_000_000,
      budget: { perWorkerPeakBytes: FIXTURE_PEAK_BYTES },
    }),
    9,
  );
});

test('perSlotWorkerBudget: a missing/unreadable budget degrades to the CPU-only budget, never a floor', () => {
  const cpu = 40;
  const env = { TEST_QUEUE_CONCURRENCY: '4', VETAPP_CPU_CAP_PERCENT: '90' };
  // budget: null is the explicit "no measurement" shape a missing/unreadable file loads as
  // (loadPytestMemoryBudget already logs the one line and returns null — see
  // pytest-memory-budget.test.mjs). Even a near-zero free-memory reading, if a budget WERE
  // present, would floor to 1 worker, never 0 — no admission refusal on low memory.
  assert.equal(perSlotWorkerBudget(cpu, env, { freemem: () => 1, budget: null }), 9);
});

test('perSlotWorkerBudgetDetail: reports which axis is binding, for explain-ability', () => {
  const cpu = 40;
  const env = { TEST_QUEUE_CONCURRENCY: '4', VETAPP_CPU_CAP_PERCENT: '90' };
  const budget = { perWorkerPeakBytes: FIXTURE_PEAK_BYTES };

  // 40 GB free / 4 slots = 10 GB share -> memoryBudget 2, below the CPU budget of 9.
  const memoryBound = perSlotWorkerBudgetDetail(cpu, env, {
    freemem: () => 40_000_000_000,
    budget,
  });
  assert.equal(memoryBound.binding, 'memory');
  assert.equal(memoryBound.workers, 2);
  assert.equal(memoryBound.cpuBudget, 9);
  assert.equal(memoryBound.memoryBudget, 2);
  assert.equal(memoryBound.freeBytes, 40_000_000_000);
  assert.equal(memoryBound.memoryShareBytes, 10_000_000_000);

  // 200 GB free / 4 slots = 50 GB share -> memoryBudget 13, above the CPU budget of 9.
  const cpuBound = perSlotWorkerBudgetDetail(cpu, env, { freemem: () => 200_000_000_000, budget });
  assert.equal(cpuBound.binding, 'cpu');
  assert.equal(cpuBound.workers, 9);
  assert.equal(cpuBound.cpuBudget, 9);
  assert.equal(cpuBound.memoryBudget, 13);
  assert.equal(cpuBound.memoryShareBytes, 50_000_000_000);

  const noBudget = perSlotWorkerBudgetDetail(cpu, env, CPU_ONLY);
  assert.equal(noBudget.binding, 'cpu');
  assert.equal(noBudget.memoryBudget, null);
  assert.equal(noBudget.memoryShareBytes, null);
});

// Review fix (plan 3954 round 2): the xdist CONTROLLER's own peak is an ADDITIONAL cost every
// slot pays once, deducted from the share before it is divided among workers — omitting it let a
// slot admit workers as if only N processes existed when the real tree is controller-plus-N.
test('perSlotWorkerBudgetDetail: a controllerPeakBytes term shrinks the memory budget and is carried through in the detail', () => {
  const cpu = 40;
  const env = { TEST_QUEUE_CONCURRENCY: '4', VETAPP_CPU_CAP_PERCENT: '90' };
  const controllerPeakBytes = 500_000_000;
  const budget = { perWorkerPeakBytes: FIXTURE_PEAK_BYTES, controllerPeakBytes };

  // 40 GB free / 4 slots = 10 GB share; with the controller's 500 MB deducted first, the memory
  // budget must be <= the no-controller figure (2, from the test above) computed against the
  // same share.
  const withController = perSlotWorkerBudgetDetail(cpu, env, {
    freemem: () => 40_000_000_000,
    budget,
  });
  assert.equal(withController.controllerPeakBytes, controllerPeakBytes);
  assert.equal(
    withController.memoryBudget,
    Math.max(1, Math.floor((10_000_000_000 - controllerPeakBytes) / FIXTURE_PEAK_BYTES)),
  );

  // A budget object with no controllerPeakBytes at all (an old committed file shape) reports 0,
  // never undefined/NaN — loadPytestMemoryBudget's own normalization is mirrored here for a
  // caller that injects opts.budget directly instead of going through the loader.
  const noControllerField = perSlotWorkerBudgetDetail(cpu, env, {
    freemem: () => 40_000_000_000,
    budget: { perWorkerPeakBytes: FIXTURE_PEAK_BYTES },
  });
  assert.equal(noControllerField.controllerPeakBytes, 0);
});
// Plan 2716 helpers: a ticket with a tier, and a ticket that has already been AWARDED a slot.
const tiered = (pid, startedWaiting, tier, heartbeat = T0) => ({
  ...ticket(pid, startedWaiting, heartbeat),
  tier,
});
const runningTicket = (pid, startedWaiting, tier, startedRunning = startedWaiting) => ({
  ...tiered(pid, startedWaiting, tier),
  startedRunning,
});

test('computeHolders: FIFO — the N oldest waiters hold the slots', () => {
  const tickets = [ticket(30, T0 - 100), ticket(10, T0 - 300), ticket(20, T0 - 200)];
  const holders = computeHolders(tickets, T0, 2, 90_000);
  assert.deepEqual([...holders].sort(), [10, 20]); // oldest two, arrival order — not pid order
});

test('computeHolders: concurrency-N cut — N=1 admits only the head; N ≥ queue admits all', () => {
  const tickets = [ticket(1, T0 - 3), ticket(2, T0 - 2), ticket(3, T0 - 1)];
  assert.deepEqual([...computeHolders(tickets, T0, 1, 90_000)], [1]);
  assert.equal(computeHolders(tickets, T0, 3, 90_000).size, 3);
  assert.equal(computeHolders(tickets, T0, 5, 90_000).size, 3);
});

test('computeHolders: a stale heartbeat is pruned and the next waiter is promoted', () => {
  const stale = { pid: 1, startedWaiting: T0 - 500, heartbeat: T0 - 91_000 }; // crashed holder
  const tickets = [stale, ticket(2, T0 - 400), ticket(3, T0 - 300), ticket(4, T0 - 200)];
  const holders = computeHolders(tickets, T0, 2, 90_000);
  assert.equal(holders.has(1), false); // dead pid never holds
  assert.deepEqual([...holders].sort(), [2, 3]); // its slot went to the next in line
});

test('computeHolders: a heartbeat exactly at the stale boundary is still live', () => {
  const edge = { pid: 1, startedWaiting: T0 - 500, heartbeat: T0 - 90_000 };
  assert.equal(computeHolders([edge], T0, 1, 90_000).has(1), true);
});

test('computeHolders: self-in-holders — my pid among the first N means I hold a slot', () => {
  const me = 4242;
  const tickets = [ticket(me, T0 - 250), ticket(9, T0 - 300), ticket(8, T0 - 100)];
  assert.equal(computeHolders(tickets, T0, 2, 90_000).has(me), true); // 2nd oldest of 3, N=2
  assert.equal(computeHolders(tickets, T0, 1, 90_000).has(me), false); // head-only cut
});

test('computeHolders: same-ms arrivals tie-break by pid, deterministically in every process', () => {
  const tickets = [ticket(200, T0 - 100), ticket(100, T0 - 100), ticket(300, T0 - 100)];
  assert.deepEqual([...computeHolders(tickets, T0, 2, 90_000)].sort(), [100, 200]);
});

test('computeHolders: malformed tickets (no finite heartbeat) never hold or block a slot', () => {
  const tickets = [
    { pid: 1, startedWaiting: T0 - 300, heartbeat: NaN },
    ticket(2, T0 - 200),
    ticket(3, T0 - 100),
  ];
  assert.deepEqual([...computeHolders(tickets, T0, 2, 90_000)].sort(), [2, 3]);
});

test('computeHolders: concurrency 0 or negative admits nobody (defensive floor)', () => {
  const tickets = [ticket(1, T0 - 100)];
  assert.equal(computeHolders(tickets, T0, 0, 90_000).size, 0);
  assert.equal(computeHolders(tickets, T0, -1, 90_000).size, 0);
});

// --- priority tiers (plan 2716) ----------------------------------------------
// Acceptance 1: a `high` ticket enqueued BEHIND waiting `low` ones runs first, and a running job
// is never interrupted. Acceptance 3: an aged `low` ticket is promoted to `medium`.

test('normalizeTier: absent / unknown tiers read as the ruled default, medium', () => {
  assert.equal(normalizeTier('high'), 'high');
  assert.equal(normalizeTier('low'), 'low');
  assert.equal(normalizeTier(undefined), 'medium'); // a pre-2716 ticket
  assert.equal(normalizeTier('normal'), 'medium'); // the vocabulary plan 2520 made illegal
  assert.equal(normalizeTier(''), 'medium');
});

test('normalizeTier: an inherited Object.prototype name is NOT a tier', () => {
  // Regression: the first cut probed `PRIORITY_SORT_WEIGHT[raw] === undefined`, which is FALSE for
  // 'constructor'/'toString' — the value passed through as legal and its "weight" resolved to a
  // function, making every comparison against it NaN. Tickets are files any process can write.
  for (const evil of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    assert.equal(normalizeTier(evil), 'medium', `${evil} must not be accepted as a tier`);
  }
  const poisoned = [tiered(1, T0 - 100, 'constructor'), tiered(2, T0 - 50, 'high')];
  assert.deepEqual([...computeHolders(poisoned, T0, 1, 90_000)], [2], 'high must still win');
});

test('LOW_PROMOTE_MS must stay below MAX_WAIT_MS or the guard is unreachable', () => {
  // A waiter hits the fail-open ceiling at MAX_WAIT_MS and RELEASES its ticket, so a promotion
  // window at or past that ceiling can never fire for a live ticket — dead code that still reads
  // as a working starvation guard. This pin is the only thing that notices if either moves.
  assert.ok(
    LOW_PROMOTE_MS < MAX_WAIT_MS,
    `LOW_PROMOTE_MS (${LOW_PROMOTE_MS}) must be < MAX_WAIT_MS (${MAX_WAIT_MS})`,
  );
});

test('computeHolders: a high ticket queued LAST is served before waiting low ones', () => {
  const tickets = [
    tiered(1, T0 - 300, 'low'),
    tiered(2, T0 - 200, 'low'),
    tiered(3, T0 - 100, 'high'), // newest arrival, highest tier
  ];
  assert.deepEqual([...computeHolders(tickets, T0, 1, 90_000)], [3]);
  assert.deepEqual([...computeHolders(tickets, T0, 2, 90_000)].sort(), [1, 3]); // then FIFO
});

test('computeHolders: within one tier the order is still plain FIFO', () => {
  const tickets = [
    tiered(3, T0 - 100, 'high'),
    tiered(1, T0 - 300, 'high'),
    tiered(2, T0 - 200, 'high'),
  ];
  assert.deepEqual([...computeHolders(tickets, T0, 2, 90_000)].sort(), [1, 2]);
});

test('computeHolders: a RUNNING low job is never preempted by a high arrival', () => {
  // Two low jobs already hold both slots; a high ticket arrives. It must WAIT — admitting it on
  // top would run 3 heavy jobs at concurrency 2, the exact over-admission the stamp prevents.
  const tickets = [
    runningTicket(1, T0 - 300, 'low'),
    runningTicket(2, T0 - 200, 'low'),
    tiered(3, T0 - 10, 'high'),
  ];
  const holders = computeHolders(tickets, T0, 2, 90_000);
  assert.deepEqual([...holders].sort(), [1, 2]);
  assert.equal(holders.has(3), false);
});

test('computeHolders: a freed slot goes to the waiting high ticket, not to FIFO', () => {
  const tickets = [
    runningTicket(1, T0 - 300, 'low'),
    tiered(2, T0 - 250, 'low'), // waiting longer…
    tiered(3, T0 - 10, 'high'), // …but this one outranks it
  ];
  assert.deepEqual([...computeHolders(tickets, T0, 2, 90_000)].sort(), [1, 3]);
});

test('computeHolders: running holders are never capped away, even past concurrency', () => {
  // A fail-open run or a rollout race can leave more runners than slots. Dropping one from the
  // holder set would not stop it running — it would only invite ANOTHER admission on top.
  const tickets = [runningTicket(1, T0 - 300, 'low'), runningTicket(2, T0 - 200, 'low')];
  assert.deepEqual([...computeHolders(tickets, T0, 1, 90_000)].sort(), [1, 2]);
});

test('computeHolders: a STALE running holder still frees its slot (crash reclaim survives)', () => {
  const dead = { ...runningTicket(1, T0 - 300, 'low'), heartbeat: T0 - 91_000 };
  const tickets = [dead, tiered(2, T0 - 100, 'medium')];
  const holders = computeHolders(tickets, T0, 1, 90_000);
  assert.equal(holders.has(1), false);
  assert.deepEqual([...holders], [2]);
});

test('effectiveTier: an aged low waiter is promoted to medium (starvation guard)', () => {
  const fresh = tiered(1, T0 - 60_000, 'low');
  const aged = tiered(2, T0 - LOW_PROMOTE_MS, 'low');
  assert.equal(effectiveTier(fresh, T0), 'low');
  assert.equal(effectiveTier(aged, T0), 'medium'); // exactly at the boundary already promotes
  assert.equal(effectiveTier(tiered(3, T0 - 10 * LOW_PROMOTE_MS, 'medium'), T0), 'medium'); // never → high
});

test('computeHolders: the promoted low waiter beats a NEWER medium, but never a high', () => {
  const aged = tiered(1, T0 - LOW_PROMOTE_MS, 'low'); // → medium, and the oldest
  const med = tiered(2, T0 - 100, 'medium');
  const hi = tiered(3, T0 - 5, 'high');
  assert.deepEqual([...computeHolders([aged, med], T0, 1, 90_000)], [1]);
  assert.deepEqual([...computeHolders([aged, med, hi], T0, 1, 90_000)], [3]);
  // …and without the promotion it would have lost to the newer medium.
  assert.deepEqual([...computeHolders([tiered(1, T0 - 100, 'low'), med], T0, 1, 90_000)], [2]);
});

test('TEST_QUEUE_LOW_PROMOTE_MS reaches BOTH the assignment core and the display default', () => {
  // Why this is pinned: the display probe and the assignment core each call effectiveTier with
  // their own default. A captured constant would have let the probe report `low` while the queue
  // was already serving that ticket as `medium`.
  const aged = tiered(1, T0 - 5_000, 'low');
  const med = tiered(2, T0 - 100, 'medium');
  process.env.TEST_QUEUE_LOW_PROMOTE_MS = '1000';
  try {
    assert.equal(effectiveTier(aged, T0), 'medium'); // display default
    assert.deepEqual([...computeHolders([aged, med], T0, 1, 90_000)], [1]); // and the core
  } finally {
    delete process.env.TEST_QUEUE_LOW_PROMOTE_MS;
  }
  assert.equal(effectiveTier(aged, T0), 'low'); // back to the 30-min default
});

test('compareWaiting: the exported comparator is the order slots are actually awarded', () => {
  const tickets = [
    tiered(1, T0 - 300, 'low'),
    tiered(2, T0 - 200, 'medium'),
    tiered(3, T0 - 100, 'high'),
  ];
  assert.deepEqual(
    [...tickets].sort((a, b) => compareWaiting(a, b, T0)).map((t) => t.pid),
    [3, 2, 1],
  );
});

test('readTickets: a null/empty startedRunning must NOT read as a running holder', () => {
  // Number(null) and Number('') are both 0 — finite — so the first cut promoted such a ticket to
  // an un-preemptable holder forever. A ticket is a file on a shared tmpdir; the parse is what
  // makes a foreign or half-written one degrade safely.
  const dir = mkdtempSync(join(tmpdir(), 'test-queue-parse-'));
  try {
    const write = (pid, startedRunning) =>
      writeFileSync(
        join(dir, `${T0}-${pid}.json`),
        JSON.stringify({ pid, startedWaiting: T0, heartbeat: T0, tier: 'low', startedRunning }),
      );
    write(1, null);
    write(2, '');
    write(3, 0);
    write(4, '12345');
    write(5, 12345);
    const byPid = Object.fromEntries(readTickets(dir).map((t) => [t.pid, t.startedRunning]));
    for (const pid of [1, 2, 3, 4]) {
      assert.equal(byPid[pid], undefined, `pid ${pid} must not parse as running`);
    }
    assert.equal(byPid[5], 12345, 'a real positive number is the only running stamp');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isRunningTicket: only a finite startedRunning counts as awarded', () => {
  assert.equal(isRunningTicket(runningTicket(1, T0, 'low')), true);
  assert.equal(isRunningTicket(tiered(1, T0, 'low')), false); // pre-2716 / still waiting
  assert.equal(isRunningTicket({ pid: 1, startedRunning: NaN }), false);
  assert.equal(isRunningTicket(null), false);
});

// Integration: the real acquire/release ticket protocol against a temp queue
// dir. Three simulated processes (injected pids — acquire is pid-injectable
// exactly for this), concurrency 2: the first two acquire immediately, the
// third only after a slot is released. Tiny pollMs keeps it fast; generous
// maxWaitMs so a slow machine can't fail-open the assertion away.
test('acquire/release: 3rd contender waits for a released slot (concurrency 2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-queue-'));
  const opts = { dir, pollMs: 25, maxWaitMs: 10_000, log: () => {} };

  const r1 = await acquire('itest-1', { ...opts, pid: 111 });
  const r2 = await acquire('itest-2', { ...opts, pid: 222 });
  assert.equal(readdirSync(dir).length, 2); // both hold, both tickets live

  let thirdHolds = false;
  const p3 = acquire('itest-3', { ...opts, pid: 333 }).then((r) => {
    thirdHolds = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 150)); // several poll cycles
  assert.equal(thirdHolds, false); // queue full — 333 must still be waiting

  r1(); // release a slot → 333 is now among the first 2 in FIFO order
  const r3 = await p3;
  assert.equal(thirdHolds, true);

  r2();
  r3();
  r3(); // idempotent — a double release must not throw
  assert.equal(readdirSync(dir).filter((n) => n.endsWith('.json')).length, 0); // all tickets freed
});

// End-to-end tier behaviour through the REAL ticket protocol (plan 2716 acceptance 1): the
// on-disk ticket carries the tier and the never-preempt stamp, and when a slot frees, the waiting
// `high` contender is admitted ahead of a `low` one that queued first.
test('acquire: the ticket records its tier and stamps startedRunning on award', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-queue-'));
  try {
    const release = await acquire('tier-pin', {
      dir,
      pollMs: 25,
      log: () => {},
      pid: 77,
      tier: 'low',
    });
    const [name] = readdirSync(dir).filter((n) => /^\d+-77\.json$/.test(n));
    assert.ok(name, 'expected a ticket file for pid 77');
    const t = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    assert.equal(t.tier, 'low');
    assert.equal(Number.isFinite(t.startedRunning), true, 'an awarded ticket must be stamped');
    release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acquire: a high contender jumps a low one that queued first (concurrency 1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-queue-'));
  const opts = { dir, pollMs: 25, concurrency: 1, maxWaitMs: 20_000, log: () => {} };
  try {
    const holder = await acquire('holder', { ...opts, pid: 111, tier: 'medium' });
    // The low contender queues FIRST; the high one arrives after it is already waiting.
    let lowWon = false;
    let highWon = false;
    const pLow = acquire('bulk', { ...opts, pid: 222, tier: 'low' }).then((r) => {
      lowWon = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 100)); // let 222 enter the poll loop, older by wall-clock
    const pHigh = acquire('operator', { ...opts, pid: 333, tier: 'high' }).then((r) => {
      highWon = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(lowWon, false, 'the single slot is held — neither contender may run yet');
    assert.equal(highWon, false);

    holder(); // free the slot: the newer HIGH ticket must take it, not the older LOW one
    const rHigh = await pHigh;
    assert.equal(highWon, true);
    assert.equal(lowWon, false, 'the low contender must still be waiting behind the high one');

    rHigh();
    (await pLow)();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fail-open must RELEASE the ticket (review finding 3): a failed-open process
// that kept its FIFO-oldest ticket would later be awarded a slot it no longer
// needs, starving a genuine waiter behind it.
test('acquire: fail-open after maxWaitMs releases the ticket (no FIFO starvation)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-queue-'));
  const opts = { dir, pollMs: 25, log: () => {} };
  const r1 = await acquire('fo-1', { ...opts, pid: 11 });
  const r2 = await acquire('fo-2', { ...opts, pid: 22 });
  const r3 = await acquire('fo-3', { ...opts, pid: 33, maxWaitMs: 100 }); // both slots busy → fail-open
  const left = readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.equal(left.length, 2, 'the failed-open ticket must be gone, only the 2 holders remain');
  assert.equal(
    left.some((n) => n.endsWith('-33.json')),
    false,
  );
  r3(); // the returned no-op release must still be safe to call
  r1();
  r2();
});

// Round-3 review finding: readTickets must PROPAGATE a readdir failure so the
// consecutive-error counter fails open in seconds — a swallowed error would
// instead starve the waiter invisibly for the whole max-wait.
test('acquire: a persistently broken queue dir fails open fast, not at max-wait', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-queue-'));
  const opts = { dir, pollMs: 25, log: () => {} };
  const r1 = await acquire('pb-1', { ...opts, pid: 11 });
  const r2 = await acquire('pb-2', { ...opts, pid: 22 });
  const p3 = acquire('pb-3', { ...opts, pid: 33, maxWaitMs: 30_000 }); // both slots busy → waits
  await new Promise((r) => setTimeout(r, 100)); // let 33 enter its poll loop
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, 'not a directory'); // readdirSync(dir) now throws ENOTDIR, persistently
  const broke = Date.now();
  const r3 = await p3; // must resolve via the consecutive-error fail-open…
  assert.ok(
    Date.now() - broke < 5_000,
    'fail-open must trigger after ~10 failed polls (<1s here), not the 30s max-wait',
  );
  r3();
  r1();
  r2();
  rmSync(dir, { force: true });
});

test('acquire: TEST_QUEUE_DISABLE=1 bypasses the queue entirely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-queue-'));
  process.env.TEST_QUEUE_DISABLE = '1';
  try {
    const release = await acquire('bypass', { dir, log: () => {} });
    assert.equal(readdirSync(dir).length, 0); // no ticket written
    release();
  } finally {
    delete process.env.TEST_QUEUE_DISABLE;
  }
});

// ── makeAdmissionScanner (plan 4006: extracted from done-worktree.mjs's runViaTestQueue so a
// second call site — nightly-windows-suite.mjs's spawnQueuedCommand — reuses the SAME scan rather
// than a second hand-typed copy beside the marker it recognizes) ───────────────────────────────
//
// Pure, parameterized, no timers/spawns — the whole point of extracting it here.

test('makeAdmissionScanner: recognizes the marker delivered in one whole chunk', () => {
  const scan = makeAdmissionScanner();
  assert.equal(scan('some preceding output\n'), false);
  assert.equal(scan(`${TEST_SLOT_ADMITTED_MARKER}\n`), true);
});

test('makeAdmissionScanner: recognizes the marker SPLIT across two chunks', () => {
  const scan = makeAdmissionScanner();
  const mid = Math.floor(TEST_SLOT_ADMITTED_MARKER.length / 2);
  const first = TEST_SLOT_ADMITTED_MARKER.slice(0, mid);
  const second = TEST_SLOT_ADMITTED_MARKER.slice(mid);
  assert.equal(scan(first), false, 'half the marker alone is not a match');
  assert.equal(scan(second), true, 'the second half completes it across the chunk boundary');
});

test('makeAdmissionScanner: only fires ONCE — a second call after a match returns false again', () => {
  const scan = makeAdmissionScanner();
  assert.equal(scan(TEST_SLOT_ADMITTED_MARKER), true);
  assert.equal(scan('more ordinary output after admission\n'), false);
});

// plan 4006 review round 1 (findings 92c7b3/3cc5b6, CONFIRMED): the header above promises "once it
// has fired, every subsequent call returns false again" — the doc's own contract, not merely the
// no-more-ordinary-output case the pre-existing test above pins. The implementation only cleared
// `buf` on a match, so a SECOND chunk that ALSO happens to contain the marker text fires a second
// time. Both current callers (runViaTestQueue, spawnQueuedCommand) happen to guard this externally
// with their own `admittedAtMs !== null` check, so nothing is broken TODAY — but this is a newly
// SHARED helper and the doc/behaviour mismatch is precisely the drift the extraction exists to
// prevent: an unguarded future caller would re-record admission on every later marker sighting.
test('plan 4006 review round 1 (92c7b3/3cc5b6): a SECOND chunk containing the marker after the first match also returns false — the one-shot contract holds even without a caller-side guard', () => {
  const scan = makeAdmissionScanner();
  assert.equal(scan(TEST_SLOT_ADMITTED_MARKER), true, 'first match fires');
  assert.equal(
    scan(TEST_SLOT_ADMITTED_MARKER),
    false,
    'a later chunk that ALSO contains the marker must not fire a second time',
  );
});

test('makeAdmissionScanner: carries at most one marker-length of trailing bytes (O(1) memory), never re-matching stale prefix fragments', () => {
  const scan = makeAdmissionScanner();
  // A long run of chatty, non-matching output must never let the internal buffer grow unbounded,
  // nor must an unrelated trailing fragment that happens to share a few characters with the
  // marker's OWN prefix ever falsely fire on its own.
  const chatty = 'x'.repeat(10_000) + TEST_SLOT_ADMITTED_MARKER.slice(0, 3);
  assert.equal(scan(chatty), false);
  // Completing the marker in a later chunk still works — the carried tail was preserved.
  assert.equal(scan(TEST_SLOT_ADMITTED_MARKER.slice(3)), true);
});

test('makeAdmissionScanner: two independent scanners never interleave (one per stream, gpt-review r1 finding 6e5e23)', () => {
  const scanOut = makeAdmissionScanner();
  const scanErr = makeAdmissionScanner();
  // stderr delivers the marker's first half; an UNRELATED stdout chunk lands "between" (a
  // different scanner entirely, so there is nothing for it to interleave with); stderr then
  // completes its own half. Each scanner only ever sees its OWN stream's bytes.
  const mid = Math.floor(TEST_SLOT_ADMITTED_MARKER.length / 2);
  assert.equal(scanErr(TEST_SLOT_ADMITTED_MARKER.slice(0, mid)), false);
  assert.equal(scanOut('unrelated stdout output\n'), false);
  assert.equal(scanErr(TEST_SLOT_ADMITTED_MARKER.slice(mid)), true);
});

test('makeAdmissionScanner: accepts a custom marker (parameterized, never hardcoded to the production token)', () => {
  const scan = makeAdmissionScanner('##CUSTOM-MARKER##');
  assert.equal(
    scan(TEST_SLOT_ADMITTED_MARKER),
    false,
    'the real production marker is NOT this one',
  );
  assert.equal(scan('##CUSTOM-MARKER##'), true);
});

// ── slotAdmissionBackstopMs (plan 4003 T1, exercised here beside its sibling makeAdmissionScanner)

test('slotAdmissionBackstopMs: TEST_QUEUE_MAX_WAIT_MS + the fixed grace, both read as PARAMETERS (never the ambient env)', () => {
  assert.equal(
    slotAdmissionBackstopMs({ TEST_QUEUE_MAX_WAIT_MS: '5000' }),
    5000 + SLOT_ADMISSION_GRACE_MS,
  );
  assert.equal(slotAdmissionBackstopMs({}), MAX_WAIT_MS + SLOT_ADMISSION_GRACE_MS);
});

// ── plan 4236 T2 (H2): the fail-open stays, but it hands the caller `admitted: false` ──────────
test('plan 4236 T2: a wait past maxWaitMs reaches the callback as admitted:false; a real slot as true', async () => {
  delete process.env.TEST_QUEUE_DISABLE; // a parameter here, never ambient
  const dir = mkdtempSync(join(tmpdir(), 'test-queue-'));
  try {
    const opts = { dir, pollMs: 25, log: () => {} };
    const seen = [];
    await withTestSlot(
      'adm-1',
      async (a) => {
        seen.push(a);
        await withTestSlot(
          'adm-2',
          async (b) => {
            seen.push(b);
            await withTestSlot('adm-3', async (c) => seen.push(c), {
              ...opts,
              pid: 33,
              maxWaitMs: 100, // both slots busy → fail-open
            });
          },
          { ...opts, pid: 22 },
        );
      },
      { ...opts, pid: 11 },
    );
    assert.deepEqual(seen, [{ admitted: true }, { admitted: true }, { admitted: false }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan 4236 T2: under TEST_QUEUE_FAIL_OPEN=1 the per-slot budget answers the clamp on both axes', () => {
  assert.equal(FAIL_OPEN_ENV, 'TEST_QUEUE_FAIL_OPEN');
  assert.equal(FAIL_OPEN_CONCURRENCY, 2);
  assert.equal(
    FAIL_OPEN_CONCURRENCY,
    OVERFLOW_TEST_CONCURRENCY,
    'the fail-open clamp is the plan-1795 overflow clamp — one number, pinned together',
  );
  const env = { TEST_QUEUE_CONCURRENCY: '2', VETAPP_CPU_CAP_PERCENT: '90', [FAIL_OPEN_ENV]: '1' };
  const d = perSlotWorkerBudgetDetail(20, env, { freemem: () => 200_000_000_000, budget: null });
  assert.equal(d.cpuBudget, 2);
  assert.equal(d.workers, 2);
  assert.equal(perSlotWorkerBudget(20, env, { budget: null }), 2);
  // without the flag, unchanged
  const { [FAIL_OPEN_ENV]: _omit, ...plain } = env;
  assert.equal(perSlotWorkerBudgetDetail(20, plain, { budget: null }).cpuBudget, 9);
});

test('plan 4236 T2 (r2): clampWorkerValue keeps 1..2, replaces everything else with 2', () => {
  assert.equal(clampWorkerValue('1'), '1');
  assert.equal(clampWorkerValue('2'), '2');
  for (const v of ['0', '3', '19', 'auto', '', undefined, '-1', '1.5'])
    assert.equal(clampWorkerValue(v), '2', String(v));
});
