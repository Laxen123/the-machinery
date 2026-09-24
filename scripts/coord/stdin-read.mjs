// scripts/coord/stdin-read.mjs — the ONE synchronous stdin reader for every hook and CLI in this
// repo that consumes a piped payload (plan 2615).
//
// THE DEFECT THIS EXISTS TO CLOSE. Every such consumer opened with
//
//   const raw = readStdin(); if (!raw.trim()) return;
//
// over a helper that was `readFileSync(0, 'utf8')` inside a bare `catch { return '' }`. That
// made a READ FAILURE indistinguishable from NO INPUT — both ended the process with empty
// stdout and exit 0. On Windows `readFileSync(0)` against a pipe intermittently throws EAGAIN
// (the parent has not filled the pipe at the moment of the synchronous read), so a transport
// hiccup masqueraded as an empty prompt/reply: no injection, no marker, no log line, no
// non-zero exit. Observed live 2026-07-29 — a reply naming Distriktsveterinärerna did not
// inject the chain page, while replaying that exact transcript state through the real hook
// binary produced the correct block.
//
// Two changes close it:
//   1. RETRY the transient errnos with a bounded backoff, so the hiccup is absorbed.
//   2. On a genuine failure after retries, append ONE line to a temp-file diagnostic — never
//      stdout (a UserPromptSubmit hook's stdout is injected context; a Stop hook's is a block
//      decision), so the next occurrence is traceable instead of invisible.
//
// WHY IT LIVES IN scripts/, NOT in .claude/hooks/lib/loader-common.mjs where plan 2615 first
// put it (hooks have since moved inside scripts/hooks/ too, plan 3765, but the reasoning below
// is unchanged: this is still the shared piece, not a hook-owned one). `scripts/*.mjs` must not
// import outside `scripts/`: scripts/test-helpers/isolated-plan-repo.mjs copies the flat
// non-test `scripts/*.mjs` tool tree into a temp repo and runs the COPIES, so a tool reaching
// into `.claude/hooks/` (as it was back then) would have died there with ERR_MODULE_NOT_FOUND
// (caught by stamp-exec-model.test.mjs on this plan's own first cut). The established direction
// is hooks → scripts, so the primitive belongs on the scripts side and
// scripts/hooks/lib/loader-common.mjs re-exports it for the nine hook entrypoints.
import { readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isatty } from 'node:tty';

// Why an incremental readSync loop rather than retrying readFileSync(0) whole: readFileSync
// runs its OWN read loop and discards everything it had buffered when a mid-stream EAGAIN
// throws, and a pipe's read position has already advanced — so re-calling it would silently
// lose the leading bytes. Accumulating chunks here keeps what already arrived and resumes from
// there. Bytes are concatenated BEFORE decoding, so a multi-byte UTF-8 character split across a
// chunk boundary is not mangled.
const STDIN_CHUNK_BYTES = 64 * 1024;
const STDIN_MAX_RETRIES = 20;
const STDIN_RETRY_SLEEP_MS = 5; // ≤100 ms total — bounded; a hook must never hang a turn

// Transient syscall failures worth retrying. EAGAIN/EWOULDBLOCK = "the pipe has no bytes for
// you *yet*"; EINTR = the syscall was interrupted. Anything else (EBADF, ENOENT, …) is a real,
// non-recoverable condition and fails immediately.
const TRANSIENT_STDIN_ERRNOS = new Set(['EAGAIN', 'EWOULDBLOCK', 'EINTR']);

// The append-only diagnostic trail for a read that failed after its retries. Under the OS
// tmpdir alongside the loaders' marker roots, so it is disposable and needs no repo hygiene.
// Exported so tests and any future triage script name it in one place.
export const STDIN_DIAGNOSTIC_LOG = join(tmpdir(), 'coord-hook-stdin-errors.log');
const STDIN_DIAGNOSTIC_MAX_BYTES = 1024 * 1024; // rotate rather than grow unbounded

// Synchronous sleep. Atomics.wait on a throwaway SharedArrayBuffer is the standard main-thread
// sync sleep in Node (allowed here, unlike in a browser); there is no async option — every
// consumer of this module is a synchronous top-to-bottom script.
//
// Deliberately NOT imported from coord-git.mjs's identical helper (/sonnet-review high finding
// on this plan's first cut): coord-git pulls in execFileSync, randomUUID, ensure-coord-reroute,
// lock-path and child-env, and this module is loaded by hooks that run on EVERY user prompt —
// real startup cost on the hot path to save two lines. The unbounded-hang risk that finding
// cites (a NaN timeout coercing Atomics.wait to +Infinity) cannot arise here: the only argument
// is the module constant above, never caller-supplied.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// One line of JSON per failure, through coord-metrics.mjs's `appendJsonl` — this repo's ONE
// append-only JSONL writer (mkdir + `ts` stamp + size rotation + swallow-every-error), which
// that module's own header asks new journal-shaped writers to call instead of hand-rolling
// another copy of the pattern. Reusing it also brings the rotation semantics a hand-rolled copy
// had diverged from: rename to `<path>.1`, keeping ONE prior generation for triage, rather than
// truncating the old trail away — which additionally means a line appended by a parallel
// session between another session's size check and its rotate survives instead of being
// destroyed.
//
// `path` is a test seam (no caller passes it) so the real append can be exercised against a
// fixture file instead of polluting the shared trail every consumer writes to. Returns true iff
// a line was written; never throws, because a diagnostic that throws would turn an
// already-degraded process into a crashing one.
// LAZILY required, never imported at module scope (/sonnet-review high finding on this plan's
// second cut, which did import it eagerly and thereby argued both ways in one file). Measured
// marginal cost with the builtins already warm: coord-metrics 1.83 ms, coord-git 6.50 ms
// (3.6x) — so the asymmetry with the sleepSync decline above is real, but 1.83 ms is NOT free
// when it is paid by ~7 separate hook processes on EVERY user prompt for a path that has fired
// essentially never. A `require()` of an ESM module is synchronous (Node 22.12+; this repo runs
// 24), which a dynamic `import()` is not — and async would be wrong here, since a hook writes
// its stdout and exits immediately, so an unresolved promise would drop the very diagnostic
// this exists to record. Not a silent risk: stdin-read.test.mjs calls appendStdinDiagnostic
// directly, so a broken require goes red in the battery rather than at the next real failure.
const requireCJS = createRequire(import.meta.url);

export function appendStdinDiagnostic(err, attempts, partialChars, path = STDIN_DIAGNOSTIC_LOG) {
  const { appendJsonl } = requireCJS('./coord-metrics.mjs');
  return appendJsonl(
    path,
    {
      hook: basename(String(process.argv[1] ?? 'unknown')),
      pid: process.pid,
      code: err?.code ?? null,
      message: String(err?.message ?? err),
      retries: attempts,
      partialChars,
    },
    { maxBytes: STDIN_DIAGNOSTIC_MAX_BYTES },
  );
}

// One constructor for every return path so `ok` cannot drift out of sync with `error`
// (/sonnet-review high finding): it is BY CONSTRUCTION `error === null`, not a second
// hand-maintained field a future early-return could forget to set. Two callers checking the two
// different fields can therefore never disagree about the same read.
function stdinResult(raw, error, attempts) {
  return { ok: error === null, raw, error, attempts };
}

// Read all of stdin, returning a DISCRIMINATED result so a caller can tell "no input"
// (`{ ok: true, raw: '' }`) from "the read failed" (`{ ok: false }`) — the conflation that made
// the 2026-07-29 miss invisible. `attempts` is how many transient retries were spent; `raw` on
// a failure carries whatever HAD arrived before the fatal error.
//
// The seams (`read` / `sleep` / `log` / `tty`) exist for the unit tests — no real caller passes
// them.
export function readStdinResult({
  retries = STDIN_MAX_RETRIES,
  read = readSync,
  sleep = sleepSync,
  log = appendStdinDiagnostic,
  tty = isatty,
} = {}) {
  // A TTY on fd 0 means the process was launched by hand with no piped payload. Treat it as
  // genuinely-empty input instead of blocking on a terminal read (which on Windows throws
  // EAGAIN/EOF and would otherwise burn the retry budget and log a false failure on every
  // manual invocation).
  try {
    if (tty(0)) return stdinResult('', null, 0);
  } catch {
    /* isatty on an odd handle → fall through and just try to read */
  }

  const chunks = [];
  // ONE decode point for both exits (/sonnet-review high finding): the failure path's `raw` and
  // the length handed to the diagnostic must always be the same bytes the success path would
  // have returned, so a future change to how they are decoded cannot land on one exit only.
  const decode = () => Buffer.concat(chunks).toString('utf8');
  const buf = Buffer.allocUnsafe(STDIN_CHUNK_BYTES);
  let attempts = 0;
  for (;;) {
    let n;
    try {
      n = read(0, buf, 0, buf.length, null); // null position → sequential read of the pipe
    } catch (err) {
      // Windows raises EOF (not a 0-byte read) when the write end is already closed.
      if (err?.code === 'EOF') break;
      if (TRANSIENT_STDIN_ERRNOS.has(err?.code) && attempts < retries) {
        attempts += 1;
        sleep(STDIN_RETRY_SLEEP_MS);
        continue;
      }
      const raw = decode();
      log(err, attempts, raw.length);
      return stdinResult(raw, err, attempts);
    }
    if (!(n > 0)) break; // 0 bytes → EOF
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return stdinResult(decode(), null, attempts);
}

// Fail-open string form — the shape every existing entrypoint already calls. Kept as the
// default so the retry and the diagnostic land everywhere without editing each call site; a
// caller that must ACT differently on a failed read reaches for readStdinResult above (as
// select-battery-tests.mjs does, where an empty list parses cleanly and would otherwise skip a
// gate rather than over-run it).
export function readStdin(opts) {
  return readStdinResult(opts).raw;
}
