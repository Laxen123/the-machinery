// scripts/exec-model-default-lib.test.mjs — name-pair of the genuinely new module
// scripts/coord/exec-model-default-lib.mjs (plan 3656). Justification for a new test FILE per
// vetapp CLAUDE.md: this is the name-pair of a new module, not a case that belongs in
// exec-model-stamp.test.mjs — that file tests the STAMP, this one tests the toggle
// READ/WRITE, and the two fail for different reasons.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EXEC_MODEL_DEFAULT_PATH,
  KNOWN_EXEC_LANES,
  execModelDefaultLane,
  isCalendarDate,
  readExecModelDefault,
} from './exec-model-default-lib.mjs';
import { main, renderExecModelDefault, writeExecModelDefault } from '../exec-model-default.mjs';
import { EXEC_LANE_TABLE } from './claim-plan-lib.mjs';

/** A disposable toggle file, so the real write path is exercised without touching the repo's own. */
function withTempToggle(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'exec-model-default-'));
  try {
    return fn(join(dir, 'exec-model-default.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `fn` with console.log/error muted; returns fn's value. */
function quiet(fn) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('the committed toggle is well-formed and names a known lane', () => {
  const { defaultLane, since, ruling } = readExecModelDefault();
  assert.ok(KNOWN_EXEC_LANES.includes(defaultLane), `unknown defaultLane ${defaultLane}`);
  assert.match(since, /^\d{4}-\d{2}-\d{2}$/, 'since must be an ISO date');
  assert.ok(ruling.trim().length > 0, 'ruling must carry the operator’s verbatim words');
  assert.equal(execModelDefaultLane(), defaultLane);
});

// exec-model-default-lib.mjs keeps KNOWN_EXEC_LANES as a local literal rather than importing
// claim-plan-lib.mjs (which would drag a large graph into every plan write — see that
// module's comment). This assertion is what makes the duplication safe: the two vocabularies
// cannot diverge without a red test here.
test('KNOWN_EXEC_LANES agrees with claim-plan-lib’s EXEC_LANE_TABLE', () => {
  assert.deepEqual([...KNOWN_EXEC_LANES].sort(), Object.keys(EXEC_LANE_TABLE).sort());
});

// The toggle is read relative to the MODULE's dirname, never process.cwd(), because every
// caller runs from a worktree / coord checkout / cloud sandbox rather than the repo root,
// and because the isolated-plan-repo scaffold runs a COPY of scripts/.
test('the toggle path resolves next to its module, not to the cwd', () => {
  assert.match(EXEC_MODEL_DEFAULT_PATH.replaceAll('\\', '/'), /scripts\/exec-model-default\.json$/);
  assert.doesNotThrow(() => readFileSync(EXEC_MODEL_DEFAULT_PATH, 'utf8'));
});

test('renderExecModelDefault round-trips through the reader’s validation', () => {
  for (const lane of KNOWN_EXEC_LANES) {
    const rendered = renderExecModelDefault({
      defaultLane: lane,
      since: '2026-09-03',
      ruling: 'operator words',
    });
    const parsed = JSON.parse(rendered);
    assert.equal(parsed.defaultLane, lane);
    assert.equal(parsed.since, '2026-09-03');
    assert.equal(parsed.ruling, 'operator words');
    assert.ok(rendered.endsWith('\n'), 'file must end with a newline');
  }
});

// The REAL write path, against a temp toggle — the branch a CLI test can never reach,
// because `set` to a different lane would rewrite the repo's own committed toggle.
test('writeExecModelDefault writes a file the reader accepts, for every lane', () => {
  withTempToggle((path) => {
    for (const lane of KNOWN_EXEC_LANES) {
      writeExecModelDefault(
        { defaultLane: lane, since: '2026-09-03', ruling: 'operator words' },
        path,
      );
      assert.deepEqual(readExecModelDefault(path), {
        defaultLane: lane,
        since: '2026-09-03',
        ruling: 'operator words',
      });
      assert.equal(execModelDefaultLane(path), lane);
    }
    // Rewriting in place leaves exactly one file's worth of content, no temp residue.
    assert.ok(readFileSync(path, 'utf8').endsWith('\n'));
  });
});

// The reader is fail-closed on all four axes; a caller has no sane fallback, so each of
// these must throw rather than coerce. `since`/`ruling` are validated as strictly as the
// lane because they are the whole reason the ruling cannot be lost to compaction.
test('the reader refuses every malformed toggle shape', () => {
  withTempToggle((path) => {
    const cases = [
      ['not json at all', /not valid JSON/],
      [JSON.stringify({ since: '2026-09-03', ruling: 'x' }), /defaultLane/],
      [JSON.stringify({ defaultLane: 'opus', since: '2026-09-03', ruling: 'x' }), /defaultLane/],
      [JSON.stringify({ defaultLane: 'sol', ruling: 'x' }), /since/],
      [JSON.stringify({ defaultLane: 'sol', since: '3 Sept', ruling: 'x' }), /since/],
      // Shape-only validation used to pass these; a `since` nobody can place on a calendar
      // is worthless as the audit record it exists to be.
      [JSON.stringify({ defaultLane: 'sol', since: '2026-99-99', ruling: 'x' }), /since/],
      [JSON.stringify({ defaultLane: 'sol', since: '2026-02-31', ruling: 'x' }), /since/],
      [JSON.stringify({ defaultLane: 'sol', since: '2026-09-03' }), /ruling/],
      [JSON.stringify({ defaultLane: 'sol', since: '2026-09-03', ruling: '   ' }), /ruling/],
    ];
    for (const [content, rx] of cases) {
      writeFileSync(path, content, 'utf8');
      assert.throws(() => readExecModelDefault(path), rx, `should refuse: ${content.slice(0, 40)}`);
    }
  });
  assert.throws(
    () => readExecModelDefault(join(tmpdir(), 'exec-model-default-does-not-exist.json')),
    /cannot read/,
  );
});

// Every CLI refusal below is exercised with a lane that is NOT the one currently in force.
// Using the current lane would let the same-lane no-op return 0 and mask a refusal that
// never fired — which is exactly how the flag-shaped-reason guard was first lost. Each
// refusal is checked ahead of the write in main(), so a non-current lane is still safe:
// the toggle file is asserted untouched at the end.
const OTHER_LANE = KNOWN_EXEC_LANES.find((l) => l !== readExecModelDefault().defaultLane);

// The CLI's refusals are the whole safety of a review-exempt toggle: nothing downstream
// re-validates a flip, so a bad `set` invocation must fail here or not at all.
test('set refuses an unknown lane, a missing reason, and a flag-shaped reason', () => {
  const before = readFileSync(EXEC_MODEL_DEFAULT_PATH, 'utf8');
  assert.equal(
    quiet(() => main(['set', 'opus', '--reason', 'x'])),
    1,
  );
  assert.equal(
    quiet(() => main(['set', OTHER_LANE])),
    1,
  );
  assert.equal(
    quiet(() => main(['set', OTHER_LANE, '--reason', '--dry'])),
    1,
  );
  assert.equal(
    quiet(() => main(['set', OTHER_LANE, '--reason', '   '])),
    1,
  );
  assert.equal(
    quiet(() => main(['set'])),
    1,
  );
  assert.equal(
    quiet(() => main(['wobble'])),
    1,
  );
  assert.equal(readFileSync(EXEC_MODEL_DEFAULT_PATH, 'utf8'), before, 'no refusal may write');
});

// An UNQUOTED ruling used to bind only its first word and silently drop the rest, recording
// a truncated operator quote as if it were verbatim. The shared parser refuses the stray
// positionals instead.
test('set refuses an unquoted multi-word reason rather than truncating it', () => {
  const before = readFileSync(EXEC_MODEL_DEFAULT_PATH, 'utf8');
  assert.equal(
    quiet(() => main(['set', OTHER_LANE, '--reason', 'I', 'want', 'Sol', 'back'])),
    1,
  );
  assert.equal(readFileSync(EXEC_MODEL_DEFAULT_PATH, 'utf8'), before);
});

test('set refuses an unknown flag instead of swallowing it as data', () => {
  const before = readFileSync(EXEC_MODEL_DEFAULT_PATH, 'utf8');
  assert.equal(
    quiet(() => main(['set', OTHER_LANE, '--resaon', 'typo'])),
    1,
  );
  assert.equal(readFileSync(EXEC_MODEL_DEFAULT_PATH, 'utf8'), before);
});

// `set` to the lane already in force must be a no-op — it must not rewrite the file and
// stamp today's date over the date the real ruling was made.
test('set to the current lane changes nothing', () => {
  const before = readFileSync(EXEC_MODEL_DEFAULT_PATH, 'utf8');
  const { defaultLane } = readExecModelDefault();
  assert.equal(
    quiet(() => main(['set', defaultLane, '--reason', 'no-op probe'])),
    0,
  );
  assert.equal(readFileSync(EXEC_MODEL_DEFAULT_PATH, 'utf8'), before);
});

test('show prints the current lane and exits 0', () => {
  assert.equal(
    quiet(() => main([])),
    0,
  );
  assert.equal(
    quiet(() => main(['show'])),
    0,
  );
});

// `show sol` printing the lane and exiting 0 reads as a successful FLIP to a hurried
// operator, when it changed nothing at all.
test('show refuses stray arguments rather than ignoring them', () => {
  assert.equal(
    quiet(() => main(['show', OTHER_LANE])),
    1,
  );
  assert.equal(
    quiet(() => main(['show', '--reason', 'x'])),
    1,
  );
});

// The writer is exported, so it is reachable without going through the CLI's refusals.
// A bad value persisted here would throw in every plan write in the repo.
test('writeExecModelDefault refuses a value the reader would reject', () => {
  withTempToggle((path) => {
    const bad = [
      { defaultLane: 'opus', since: '2026-09-03', ruling: 'x' },
      { defaultLane: 'sol', since: '2026-02-31', ruling: 'x' },
      { defaultLane: 'sol', since: '2026-09-03', ruling: '  ' },
    ];
    for (const value of bad) assert.throws(() => writeExecModelDefault(value, path));
  });
});

test('isCalendarDate separates real dates from date-shaped strings', () => {
  for (const ok of ['2026-09-03', '2024-02-29', '2026-12-31']) assert.ok(isCalendarDate(ok), ok);
  for (const bad of ['2026-99-99', '2026-02-31', '2023-02-29', '3 Sept', '', null, '2026-9-3'])
    assert.equal(isCalendarDate(bad), false, String(bad));
});

// The full `set` path against a temp toggle — the flip actually happening, not just its
// refusals. `main`'s togglePath parameter is what makes this reachable without rewriting
// the repo's own toggle.
test('set flips the lane and records the ruling and date', () => {
  withTempToggle((path) => {
    writeExecModelDefault(
      { defaultLane: 'sonnet', since: '2020-01-01', ruling: 'old ruling' },
      path,
    );
    const before = new Date().toISOString().slice(0, 10);
    assert.equal(
      quiet(() => main(['set', 'sol', '--reason', 'I want Sol back.'], { togglePath: path })),
      0,
    );
    const after = readExecModelDefault(path);
    assert.equal(after.defaultLane, 'sol');
    assert.equal(after.ruling, 'I want Sol back.');
    // Sampling the clock a second time here would be flaky across UTC midnight, so accept
    // either side of the boundary the call itself could have fallen on.
    assert.ok([before, new Date().toISOString().slice(0, 10)].includes(after.since), after.since);
  });
});

// A corrupt toggle must be repairable — the reader's own error says to use `set` — but a
// plain `set` must not overwrite it blind, because a transient read failure and real
// corruption are indistinguishable here and the stored ruling is gone either way.
test('set refuses an unreadable toggle unless --repair is given', () => {
  withTempToggle((path) => {
    writeFileSync(path, '{ this is not json', 'utf8');
    assert.equal(
      quiet(() => main(['set', 'sol', '--reason', 'repairing'], { togglePath: path })),
      1,
    );
    assert.equal(readFileSync(path, 'utf8'), '{ this is not json', 'a refusal must not write');

    assert.equal(
      quiet(() => main(['set', 'sol', '--reason', 'repairing', '--repair'], { togglePath: path })),
      0,
    );
    assert.equal(readExecModelDefault(path).defaultLane, 'sol');
    assert.equal(readExecModelDefault(path).ruling, 'repairing');
  });
});
