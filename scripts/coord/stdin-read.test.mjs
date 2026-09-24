// scripts/stdin-read.test.mjs — the name-paired suite for scripts/coord/stdin-read.mjs, this
// repo's ONE synchronous stdin reader (plan 2615). A NEW test file is warranted under the
// vetapp CLAUDE.md growth valve for the stated reason: stdin-read.mjs is a genuinely new
// scripts/<name>.mjs module, so this is its name-pair, not an extra file beside an existing one.
//
// The defect these pin: `readFileSync(0,'utf8')` in a bare `catch { return '' }` made a
// Windows EAGAIN on the payload pipe indistinguishable from empty input, so every consumer
// returned early with no output, no marker, and no trace at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readStdin,
  readStdinResult,
  appendStdinDiagnostic,
  STDIN_DIAGNOSTIC_LOG,
} from './stdin-read.mjs';

function errno(code) {
  const err = new Error(`${code}: fake stdin failure`);
  err.code = code;
  return err;
}

// A fake `readSync(fd, buf, offset, length, position)` seam. Each step is either an
// Error to throw or a chunk (string/Buffer) to deliver; running past the end returns 0
// (EOF). Records every call so a test can assert the retry actually re-read.
function fakeRead(steps) {
  let i = 0;
  const fn = (fd, buf, offset, length, position) => {
    fn.calls.push({ fd, offset, length, position });
    if (i >= steps.length) return 0;
    const step = steps[i++];
    if (step instanceof Error) throw step;
    const bytes = Buffer.isBuffer(step) ? step : Buffer.from(step, 'utf8');
    bytes.copy(buf, offset);
    return bytes.length;
  };
  fn.calls = [];
  return fn;
}

// Collects the diagnostic instead of appending to the shared trail.
function fakeLog() {
  const fn = (err, attempts, partialChars) => fn.calls.push({ err, attempts, partialChars });
  fn.calls = [];
  return fn;
}

const noSleep = () => {};
const notATty = () => false;

test('readStdinResult: retries a transient EAGAIN and then succeeds (the plan-2615 defect)', () => {
  const read = fakeRead([errno('EAGAIN'), errno('EAGAIN'), '{"prompt":"Distriktsveterinarerna"}']);
  const log = fakeLog();
  const sleeps = [];
  const res = readStdinResult({ read, log, sleep: (ms) => sleeps.push(ms), tty: notATty });
  assert.equal(res.ok, true);
  assert.equal(res.raw, '{"prompt":"Distriktsveterinarerna"}');
  assert.equal(res.attempts, 2);
  assert.equal(res.error, null);
  assert.equal(log.calls.length, 0, 'a recovered read is not a failure — nothing to log');
  assert.equal(sleeps.length, 2, 'backed off once per retry');
  assert.ok(
    sleeps.every((ms) => ms > 0),
    'the backoff must actually wait, else the retries burn in a single tick',
  );
});

test('readStdinResult: EWOULDBLOCK and EINTR are retried too; a non-transient errno is not', () => {
  for (const code of ['EWOULDBLOCK', 'EINTR']) {
    const res = readStdinResult({
      read: fakeRead([errno(code), '{"ok":1}']),
      log: fakeLog(),
      sleep: noSleep,
      tty: notATty,
    });
    assert.equal(res.ok, true, `${code} must be retried`);
    assert.equal(res.raw, '{"ok":1}');
  }
  const read = fakeRead([errno('EBADF'), '{"never":1}']);
  const log = fakeLog();
  const res = readStdinResult({ read, log, sleep: noSleep, tty: notATty });
  assert.equal(res.ok, false, 'EBADF is a real condition, not a hiccup');
  assert.equal(res.error.code, 'EBADF');
  assert.equal(res.attempts, 0);
  assert.equal(read.calls.length, 1, 'no retry spent on a non-transient errno');
  assert.equal(log.calls.length, 1);
});

test('readStdinResult: exhausted retries → ok:false + exactly one diagnostic', () => {
  const read = fakeRead(Array.from({ length: 10 }, () => errno('EAGAIN')));
  const log = fakeLog();
  const res = readStdinResult({ retries: 3, read, log, sleep: noSleep, tty: notATty });
  assert.equal(res.ok, false);
  assert.equal(res.raw, '');
  assert.equal(res.attempts, 3, 'the retry budget is BOUNDED — a hook must never hang the turn');
  assert.equal(res.error.code, 'EAGAIN');
  assert.equal(read.calls.length, 4, 'one initial read + 3 retries');
  assert.deepEqual(log.calls, [{ err: res.error, attempts: 3, partialChars: 0 }]);
});

test('readStdinResult: genuinely-empty input is ok:true — NOT conflated with a failed read', () => {
  const log = fakeLog();
  const res = readStdinResult({ read: fakeRead([]), log, sleep: noSleep, tty: notATty });
  assert.equal(res.ok, true);
  assert.equal(res.raw, '');
  assert.equal(res.attempts, 0);
  assert.equal(log.calls.length, 0, 'no input is not an error — logging it would be noise');
});

test('readStdinResult: a fatal error keeps the bytes that already arrived', () => {
  // readFileSync(0) discarded these (and the pipe position had already advanced), which
  // is why plan 2615 accumulates chunks here instead of re-calling readFileSync whole.
  const log = fakeLog();
  const res = readStdinResult({
    retries: 1,
    read: fakeRead(['{"prompt":"half', errno('EAGAIN'), errno('EAGAIN')]),
    log,
    sleep: noSleep,
    tty: notATty,
  });
  assert.equal(res.ok, false);
  assert.equal(res.raw, '{"prompt":"half', 'the partial payload survives for the diagnostic');
  assert.deepEqual(log.calls, [{ err: res.error, attempts: 1, partialChars: 15 }]);
});

test('readStdinResult: a multi-byte character split across chunks is not mangled', () => {
  // The a-with-diaeresis in this fixture is two bytes in UTF-8. Chunks are concatenated
  // BEFORE decoding, so a boundary landing mid-character must still decode correctly.
  const raw = Buffer.from('{"prompt":"Gällivare"}', 'utf8');
  const cut = raw.indexOf(Buffer.from('ä', 'utf8')) + 1; // between the two bytes
  const res = readStdinResult({
    read: fakeRead([raw.subarray(0, cut), raw.subarray(cut)]),
    log: fakeLog(),
    sleep: noSleep,
    tty: notATty,
  });
  assert.equal(res.ok, true);
  assert.equal(res.raw, '{"prompt":"Gällivare"}');
});

test('readStdinResult: a TTY on fd 0 is treated as no input, without reading or logging', () => {
  // A hand-run hook has no piped payload; blocking on a terminal read (or burning the
  // retry budget and logging a false failure) on every manual invocation would be wrong.
  const read = fakeRead(['should never be read']);
  const log = fakeLog();
  const res = readStdinResult({ read, log, sleep: noSleep, tty: () => true });
  assert.deepEqual(res, { ok: true, raw: '', error: null, attempts: 0 });
  assert.equal(read.calls.length, 0);
  assert.equal(log.calls.length, 0);
});

test('readStdin: keeps the fail-open string contract every hook entrypoint relies on', () => {
  // All nine hooks do `const raw = readStdin(); if (!raw.trim()) return;` — the wrapper
  // must still hand back a plain string on both the happy and the failed path.
  assert.equal(
    readStdin({ read: fakeRead(['{"prompt":"x"}']), log: fakeLog(), sleep: noSleep, tty: notATty }),
    '{"prompt":"x"}',
  );
  assert.equal(
    readStdin({
      retries: 0,
      read: fakeRead([errno('EAGAIN')]),
      log: fakeLog(),
      sleep: noSleep,
      tty: notATty,
    }),
    '',
  );
});

test('appendStdinDiagnostic: writes one parseable JSON line per failure, and rotates when huge', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'loader-common-stdin-diag-')), 'errors.log');
  assert.equal(appendStdinDiagnostic(errno('EAGAIN'), 3, 12, path), true);
  assert.equal(appendStdinDiagnostic(errno('EINTR'), 1, 0, path), true);
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'one line appended per failure');
  const first = JSON.parse(lines[0]);
  assert.equal(first.code, 'EAGAIN');
  assert.equal(first.retries, 3);
  assert.equal(first.partialChars, 12);
  assert.equal(typeof first.ts, 'string', 'timestamped by the shared appendJsonl writer');
  assert.equal(typeof first.hook, 'string', 'names WHICH hook failed — the point of the trail');
  assert.equal(typeof first.pid, 'number');

  // Over the cap → the shared writer renames the old trail to <path>.1 and starts fresh, so
  // the live file holds only the new line while ONE prior generation survives for triage.
  writeFileSync(path, 'x'.repeat(1024 * 1024 + 1));
  appendStdinDiagnostic(errno('EAGAIN'), 0, 0, path);
  const rotated = readFileSync(path, 'utf8').trim().split('\n');
  assert.equal(rotated.length, 1, 'rotated — the trail must not grow without bound');
  assert.equal(JSON.parse(rotated[0]).code, 'EAGAIN');
  assert.ok(existsSync(`${path}.1`), 'the previous generation is kept, not discarded');
});

test('appendStdinDiagnostic: an unwritable path is swallowed, never thrown', () => {
  // A hook already degraded by a stdin failure must not additionally crash. The parent here
  // is a FILE, so even the writer's mkdir-parent step fails (a merely-absent directory would
  // just be created).
  const blocker = join(mkdtempSync(join(tmpdir(), 'loader-common-stdin-diag-')), 'not-a-dir');
  writeFileSync(blocker, 'i am a file');
  let wrote = true;
  assert.doesNotThrow(() => {
    wrote = appendStdinDiagnostic(errno('EAGAIN'), 1, 0, join(blocker, 'errors.log'));
  });
  assert.equal(wrote, false, 'reports the failure to a caller that cares, without throwing');
});

test('STDIN_DIAGNOSTIC_LOG lives under the OS tmpdir, not in the repo', () => {
  // Disposable by construction: a hook diagnostic must never need repo hygiene, and it
  // must never be stdout (a UserPromptSubmit hook's stdout is injected context, and a
  // Stop hook's is a block decision).
  assert.ok(STDIN_DIAGNOSTIC_LOG.startsWith(tmpdir()), STDIN_DIAGNOSTIC_LOG);
});
