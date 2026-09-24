// scripts/pytest-memory-budget.test.mjs — unit tests for the pytest worker memory-budget loader
// and pure arithmetic (plan 3954 T3). New test-FILE justification (vetapp CLAUDE.md "a new
// scripts/*.test.mjs FILE requires a one-line justification"): this name-pairs the genuinely new
// scripts/coord/pytest-memory-budget.mjs module, split out of test-queue.mjs per the
// scripts/**-module-layout import-boundary rule rather than folded into test-queue.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_BUDGET_PATH,
  findScriptsFile,
  loadPytestMemoryBudget,
  memoryWorkerBudget,
} from './pytest-memory-budget.mjs';

const FIXTURE_PEAK_BYTES = 3_656_278_016;

test('memoryWorkerBudget: floor(free / peak), minimum 1, never a refusal', () => {
  assert.equal(memoryWorkerBudget(20_000_000_000, 3_656_278_016), 5);
  assert.equal(memoryWorkerBudget(100_000_000_000, 3_656_278_016), 27);
  assert.equal(memoryWorkerBudget(1, 3_656_278_016), 1); // near-zero free -> 1, never 0
  assert.equal(memoryWorkerBudget(0, 3_656_278_016), 1);
});

test('memoryWorkerBudget: invalid inputs degrade to null, never throw', () => {
  assert.equal(memoryWorkerBudget(Number.NaN, 3_656_278_016), null);
  assert.equal(memoryWorkerBudget(20_000_000_000, 0), null);
  assert.equal(memoryWorkerBudget(20_000_000_000, Number.NaN), null);
  assert.equal(memoryWorkerBudget(20_000_000_000, -1), null);
});

// Review fix (plan 3954 round 2): the xdist CONTROLLER's own peak is an ADDITIONAL fixed cost
// every slot pays once, deducted from the share BEFORE dividing by the per-worker peak.
test('memoryWorkerBudget: a controllerPeakBytes term is deducted from the share before dividing', () => {
  // 20 GB share, 3.66 GB/worker with no controller term -> 5 workers (same as above).
  // With a 1 GB controller subtracted first, the numerator shrinks and so does the quotient.
  assert.equal(
    memoryWorkerBudget(20_000_000_000, 3_656_278_016, 1_000_000_000),
    Math.floor((20_000_000_000 - 1_000_000_000) / 3_656_278_016),
  );
  assert.equal(
    memoryWorkerBudget(20_000_000_000, 3_656_278_016, 0),
    5,
    '0 is a no-op, same as omitted',
  );
});

test('memoryWorkerBudget: a controller cost larger than the share still returns 1, never a refusal', () => {
  assert.equal(memoryWorkerBudget(1_000_000_000, 3_656_278_016, 5_000_000_000), 1);
});

test('memoryWorkerBudget: a non-finite controllerPeakBytes is treated as 0, never poisons the result', () => {
  assert.equal(
    memoryWorkerBudget(20_000_000_000, 3_656_278_016, Number.NaN),
    memoryWorkerBudget(20_000_000_000, 3_656_278_016, 0),
  );
  assert.equal(
    memoryWorkerBudget(20_000_000_000, 3_656_278_016, undefined),
    memoryWorkerBudget(20_000_000_000, 3_656_278_016),
    'the default parameter and an explicit undefined behave identically',
  );
});

test('loadPytestMemoryBudget: the committed T0 measurement parses with a usable peak', (t) => {
  // plan 3958: scripts/pytest-memory-budget.json is a real, machine-measured artifact (records
  // the operator's own hostname and hardware memory figures — exactly the shape
  // assert-no-personal-data.mjs's denylist exists to keep out of a published tree), so it is
  // never shipped in the public coord-kit. loadPytestMemoryBudget's OWN documented contract is
  // "a missing file degrades to null, never throws" (the very next test) — this one just has
  // nothing to pin against when that degrade is what actually happens here.
  if (!existsSync(DEFAULT_BUDGET_PATH)) {
    t.skip('scripts/pytest-memory-budget.json is absent — no committed T0 measurement to load');
    return;
  }
  const budget = loadPytestMemoryBudget(DEFAULT_BUDGET_PATH);
  assert.ok(budget, 'scripts/pytest-memory-budget.json must load on this machine');
  assert.ok(Number.isFinite(budget.perWorkerPeakBytes) && budget.perWorkerPeakBytes > 0);
});

test('loadPytestMemoryBudget: a missing file degrades to null, never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pytest-memory-budget-test-'));
  try {
    const missing = join(dir, 'does-not-exist.json');
    const originalError = console.error;
    const messages = [];
    console.error = (message) => messages.push(message);
    try {
      assert.equal(loadPytestMemoryBudget(missing), null);
    } finally {
      console.error = originalError;
    }
    assert.equal(messages.length, 1); // exactly one logged line, never a throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPytestMemoryBudget: an unusable perWorkerPeakBytes degrades to null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pytest-memory-budget-test-'));
  try {
    const file = join(dir, 'bad.json');
    writeFileSync(file, JSON.stringify({ perWorkerPeakBytes: 'not-a-number' }));
    assert.equal(loadPytestMemoryBudget(file), null);
    writeFileSync(file, JSON.stringify({})); // field absent entirely
    assert.equal(loadPytestMemoryBudget(file), null);
    writeFileSync(file, JSON.stringify({ perWorkerPeakBytes: 0 }));
    assert.equal(loadPytestMemoryBudget(file), null);
    writeFileSync(file, 'not json at all');
    assert.equal(loadPytestMemoryBudget(file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPytestMemoryBudget: a valid file carries the rest of the measurement through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pytest-memory-budget-test-'));
  try {
    const file = join(dir, 'fixture.json');
    writeFileSync(
      file,
      JSON.stringify({ perWorkerPeakBytes: 3_656_278_016, machine: 'FIXTURE-HOST', workers: 9 }),
    );
    const budget = loadPytestMemoryBudget(file);
    assert.equal(budget.perWorkerPeakBytes, 3_656_278_016);
    assert.equal(budget.machine, 'FIXTURE-HOST');
    assert.equal(budget.workers, 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review fix (plan 3954 round 2): a budget file written before the controller term existed (or a
// fixture that omits it) must still load — controllerPeakBytes normalizes to 0, never undefined
// or a crash, so a caller can always read it without its own null-check.
test('loadPytestMemoryBudget: a file with no controllerPeakBytes normalizes it to 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pytest-memory-budget-test-'));
  try {
    const file = join(dir, 'fixture.json');
    writeFileSync(file, JSON.stringify({ perWorkerPeakBytes: 3_656_278_016 }));
    const budget = loadPytestMemoryBudget(file);
    assert.equal(budget.controllerPeakBytes, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPytestMemoryBudget: a file WITH controllerPeakBytes carries it through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pytest-memory-budget-test-'));
  try {
    const file = join(dir, 'fixture.json');
    writeFileSync(
      file,
      JSON.stringify({ perWorkerPeakBytes: 3_656_278_016, controllerPeakBytes: 314_572_800 }),
    );
    const budget = loadPytestMemoryBudget(file);
    assert.equal(budget.controllerPeakBytes, 314_572_800);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review fix (3065e4, plan 3954): the committed figure is measured on ONE host at ONE point in
// time. A different/materially-changed host is never a reason to REJECT it (plan 1750's
// no-admission-floor ruling applies here too — the budget is still returned), only a reason to
// say so once. `hostname`/`totalMemoryBytes` are the injection points — never the live machine in
// a test (vetapp CLAUDE.md "environment must be a parameter").
test('loadPytestMemoryBudget: a same-host file is silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pytest-memory-budget-test-'));
  try {
    const file = join(dir, 'fixture.json');
    writeFileSync(
      file,
      JSON.stringify({
        perWorkerPeakBytes: FIXTURE_PEAK_BYTES,
        machine: 'SAME-HOST',
        totalMemoryBytes: 68_000_000_000,
      }),
    );
    const originalError = console.error;
    const messages = [];
    console.error = (message) => messages.push(message);
    let budget;
    try {
      budget = loadPytestMemoryBudget(file, {
        hostname: 'SAME-HOST',
        totalMemoryBytes: 68_000_000_000,
      });
    } finally {
      console.error = originalError;
    }
    assert.equal(budget.perWorkerPeakBytes, FIXTURE_PEAK_BYTES);
    assert.deepEqual(messages, [], 'no mismatch, no log line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPytestMemoryBudget: a different-host file logs ONE line but still returns the budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pytest-memory-budget-test-'));
  try {
    const file = join(dir, 'fixture.json');
    writeFileSync(
      file,
      JSON.stringify({
        perWorkerPeakBytes: FIXTURE_PEAK_BYTES,
        machine: 'OTHER-HOST',
        totalMemoryBytes: 68_000_000_000,
      }),
    );
    const originalError = console.error;
    const messages = [];
    console.error = (message) => messages.push(message);
    let budget;
    try {
      // Same total memory (well under the 25% delta) — the note should name the host mismatch
      // only, not claim a memory-size difference too.
      budget = loadPytestMemoryBudget(file, {
        hostname: 'THIS-HOST',
        totalMemoryBytes: 69_000_000_000,
      });
    } finally {
      console.error = originalError;
    }
    assert.equal(budget.perWorkerPeakBytes, FIXTURE_PEAK_BYTES, 'never rejected — still returned');
    assert.equal(messages.length, 1);
    assert.match(messages[0], /measured on "OTHER-HOST", not this host \("THIS-HOST"\)/);
    assert.doesNotMatch(messages[0], /total memory differs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPytestMemoryBudget: a different host AND a >25% total-memory delta names both in the one line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pytest-memory-budget-test-'));
  try {
    const file = join(dir, 'fixture.json');
    writeFileSync(
      file,
      JSON.stringify({
        perWorkerPeakBytes: FIXTURE_PEAK_BYTES,
        machine: 'OTHER-HOST',
        totalMemoryBytes: 8_000_000_000, // far below this host's total below
      }),
    );
    const originalError = console.error;
    const messages = [];
    console.error = (message) => messages.push(message);
    let budget;
    try {
      budget = loadPytestMemoryBudget(file, {
        hostname: 'THIS-HOST',
        totalMemoryBytes: 68_000_000_000,
      });
    } finally {
      console.error = originalError;
    }
    assert.equal(budget.perWorkerPeakBytes, FIXTURE_PEAK_BYTES, 'never rejected — still returned');
    assert.equal(messages.length, 1);
    assert.match(messages[0], /measured on "OTHER-HOST", not this host \("THIS-HOST"\)/);
    assert.match(messages[0], /total memory differs by more than 25%/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findScriptsFile: survives this module moving to scripts/coord/ (plan 3962 P1)', () => {
  // Builds a synthetic scripts/ tree — NOT a repo root: <root>/scripts/x.json (the sibling),
  // no coord.config.json anywhere (there is none in the real scripts/test-helpers/
  // isolated-plan-repo.mjs fixture either — see findScriptsFile's doc comment) — then resolves
  // as if THIS module's own file lived one level deeper, at <root>/scripts/coord/
  // pytest-memory-budget.mjs — the move plan 3962 is about to make. The sibling must still
  // resolve to <root>/scripts/x.json, not <root>/scripts/coord/x.json, found by walking up to
  // the nearest ancestor literally named `scripts`, never via a repo-root marker.
  const root = mkdtempSync(join(tmpdir(), 'vetapp-scripts-file-'));
  try {
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir);
    writeFileSync(join(scriptsDir, 'x.json'), '{}');
    const simulatedCoordDir = join(scriptsDir, 'coord');
    mkdirSync(simulatedCoordDir);
    assert.equal(findScriptsFile('x.json', scriptsDir), join(scriptsDir, 'x.json'));
    assert.equal(findScriptsFile('x.json', simulatedCoordDir), join(scriptsDir, 'x.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findScriptsFile: post-move resolution does NOT depend on the sibling existing on disk', () => {
  // The regression class an earlier (existsSync-based) version of this walk was still exposed
  // to: if the sibling has not been WRITTEN yet, an existence probe finds nothing at any
  // ancestor and falls back to `join(startDir, name)` — scripts/coord/x.json, the wrong
  // directory, exactly the class of bug this whole fix exists to close. Anchoring on the
  // `scripts` directory NAME (not on whether x.json is present) must still resolve correctly
  // here, with x.json never created at all.
  const root = mkdtempSync(join(tmpdir(), 'vetapp-scripts-file-nofile-'));
  try {
    const scriptsDir = join(root, 'scripts');
    const simulatedCoordDir = join(scriptsDir, 'coord');
    mkdirSync(simulatedCoordDir, { recursive: true }); // x.json is deliberately never written
    assert.equal(findScriptsFile('x.json', simulatedCoordDir), join(scriptsDir, 'x.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findScriptsFile: pre-move (module directly IN scripts/) resolves with zero ancestor walk', () => {
  // The other direction of the same invariant: called from a directory whose own basename is
  // already `scripts` (today's real location, before plan 3962's move), no walk is needed —
  // i is 0 (its parent is never consulted).
  const root = mkdtempSync(join(tmpdir(), 'vetapp-scripts-file-premove-'));
  try {
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir);
    assert.equal(findScriptsFile('x.json', scriptsDir), join(scriptsDir, 'x.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findScriptsFile: falls back to alongside startDir when no ancestor is named scripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'vetapp-scripts-file-no-anchor-'));
  try {
    assert.equal(findScriptsFile('x.json', root), join(root, 'x.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findScriptsFile: resolves against the REAL isolated-plan-repo.mjs fixture, from a simulated scripts/coord/ location', async () => {
  // The exact mechanism a sister worker's module broke against (a repo-root-marker walk found
  // no marker in this fixture and silently resolved wrong): makeIsolatedRepo copies the WHOLE
  // scripts/ tool tree, nested dirs included, into <tmp>/scripts/ — no coord.config.json, no
  // other repo-root file, ever. scripts/coord/ is part of that copy, so simulating this
  // module's post-move location is just pointing startDir at the fixture's own copied
  // scripts/coord/ — no synthetic tree needed.
  const { makeIsolatedRepo } = await import('../test-helpers/isolated-plan-repo.mjs');
  const repo = makeIsolatedRepo({
    prefix: 'pytest-memory-budget-fixture',
    basename: '9999-Test-fixture-only.md',
    body: '# fixture plan\n',
  });
  try {
    const simulatedCoordDir = join(repo.scriptsDir, 'coord');
    assert.ok(existsSync(simulatedCoordDir), 'fixture must have copied scripts/coord/');
    assert.equal(
      findScriptsFile('pytest-memory-budget.json', simulatedCoordDir),
      join(repo.scriptsDir, 'pytest-memory-budget.json'),
    );
  } finally {
    repo.cleanup();
  }
});
