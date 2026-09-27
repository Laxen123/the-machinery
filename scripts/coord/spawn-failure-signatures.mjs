// plan 3954 T2: the Windows NTSTATUS codes a CHILD process exits with when it could not even
// START — the box is out of memory (or, more rarely, the child's runtime could not initialise
// for a non-memory reason, e.g. a broken/incompatible DLL install; if a signature recurs with
// headroom confirmed, suspect the child install rather than memory) — a spawn-time failure, not
// a verdict from code that never ran. `backend/scripts/tests/test_seed_boot_validation_gate.py`'s
// `test_free_text_verifiedby_rejected_as_schema_error` failing with
// "assert 'verifiedBy' in 'Validator produced no output (exit=3221225794). stderr:\n'" is the
// measured shape (plan 3954 § Evidence): the node validator never ran, so the schema assertion
// on its output is meaningless — the process starved before it could print anything.
//
// ONE module, imported by both the land spine (done-worktree.mjs) and
// backend/scripts/_seed_validation.py's docstring-pointed sibling constant (Python cannot import
// a .mjs module, so that side duplicates the NTSTATUS decimal values as a small constant set —
// see its comment for the pointer back here). Never inline these numbers a third time. The
// WinError 1455 text signature below is JS-only (see its own header) — nothing on the Python
// side needs it, since that call site already checks a returncode, never a raised OSError.
//
// Deliberately named SPAWN_STARVATION_* rather than RESOURCE_EXHAUSTED — that token commonly
// means a provider HTTP 429, an unrelated rate-limit concept, and reusing it here would make
// the two failure classes collide under a repo-wide grep.
export const SPAWN_STARVATION_SIGNATURES = Object.freeze([
  // STATUS_DLL_INIT_FAILED — the 3858 land's measured failure (plan 3954 § Evidence).
  Object.freeze({ hex: '0xC0000142', decimal: 3221225794, name: 'STATUS_DLL_INIT_FAILED' }),
  // STATUS_NO_MEMORY — the code T1's constrained-child reproduction targets when the box (not
  // just the child's own working set) is out of memory at spawn time.
  Object.freeze({ hex: '0xC0000017', decimal: 3221225495, name: 'STATUS_NO_MEMORY' }),
  // STATUS_COMMITMENT_LIMIT — plan 3954 T1 reproduction (scripts/run-with-memory-limit.ps1): a dangling-ok: evidence citation; the one-off reproduction harness stays project-side
  // 12 MB Job Object memory cap on a Python parent spawning node/python/git children reproduced
  // this NTSTATUS twice and STATUS_DLL_INIT_FAILED once, at the SAME cap boundary — one failure
  // class, two NTSTATUS values the kernel happened to hand back. Signed 32-bit form -1073741523,
  // noted for reference only: every returncode this repo has actually measured (Python and Node
  // alike) has come back unsigned/positive, so only the unsigned decimal below is matched.
  Object.freeze({ hex: '0xC000012D', decimal: 3221225773, name: 'STATUS_COMMITMENT_LIMIT' }),
]);

// plan 3954 T1 reproduction (scripts/run-with-memory-limit.ps1): at a SLIGHTLY TIGHTER cap dangling-ok: evidence citation; the one-off reproduction harness stays project-side
// (8-10 MB) than the NTSTATUS boundary above, Python's `_winapi.CreateProcess` itself refuses
// inside `subprocess.Popen` — the OS never gets far enough to hand the CALLER an NTSTATUS exit
// code at all, so the failure surfaces as a plain OSError on the parent's side instead:
// "OSError: [WinError 1455] The paging file is too small for this operation to complete." A
// DIFFERENT numbering space from the NTSTATUS set above (a small Win32 error code, not a
// 0xC0000000+ status), so it is matched separately rather than folded into
// SPAWN_STARVATION_SIGNATURES — text-only, there is no numeric exit code to check it against.
export const SPAWN_STARVATION_WIN32_ERRORS = Object.freeze([
  Object.freeze({ code: 1455, name: 'ERROR_COMMITMENT_LIMIT' }),
]);

const SIGNATURE_DECIMALS = new Set(SPAWN_STARVATION_SIGNATURES.map((s) => s.decimal));

// plan 3954 T2 code-review round 2 (findings c4e38f/d0e41e): a bare signature number in free text
// is NOT proof of spawn starvation — a genuine pytest ASSERTION can mention one of these values
// (e.g. `assert 3221225794 == 0`, or our own signature tests failing with the decimal literal in
// their message), and that must never be read as "the box was out of memory". Require an actual
// EXIT-CODE FRAMING token immediately before the number/hex, so an assertion merely mentioning the
// value in isolation never matches. The numeric `looksSpawnStarved(exitCode)` /
// `isSpawnStarvationCode` path (an actual exit code, never free text) is untouched — this framing
// requirement is text-matching only.
//
// The token list is wider than the obvious exit/code/status/NTSTATUS vocabulary because it has to
// keep matching the REAL messages this repo already emits, not just the review finding's own
// example: `_seed_validation.py`'s own spawn-starvation branch reads "...spawn failed with
// 0xC0000142" (`failed with`, no "exit"/"code" word at all), Python's subprocess module reads
// "returned non-zero exit status N" (`exit status`, a two-word compound `exit\s*code` doesn't
// cover), and this module's OWN `[WinError N]` bracket framing (`WinError`, used both for the
// dedicated Win32-error-code check below and, in STARVED_TAIL_3858-shaped text, for a decimal
// NTSTATUS value someone chose to report inside that bracket instead of a bare returncode).
const EXIT_CODE_CONTEXT_RE_SRC =
  '(?:exit\\s*code|exitcode|exit\\s*status|exit|return\\s*code|returncode|rc|status|NTSTATUS|' +
  'code|failed\\s+with|WinError)\\s*[=:(]?\\s*';
// One alternation regex per spelling, built from the data above rather than hand-duplicated, so
// a signature added to the array above is matched by both `looksSpawnStarved` forms for free.
// Decimal: `(?<!\d)<n>(?!\d)` so "3221225794" doesn't also match inside a longer number like
// "13221225794". Hex: the digits after "0x", case-insensitive, optionally 0x-prefixed in the text
// (pytest/subprocess messages and Windows tooling both spell it as `0xC0000142` or `C0000142`).
const DECIMAL_TEXT_RE = new RegExp(
  [...SIGNATURE_DECIMALS].map((d) => `${EXIT_CODE_CONTEXT_RE_SRC}(?<!\\d)${d}(?!\\d)`).join('|'),
  'i',
);
// Hex: bounded on both sides by `(?<![0-9A-Fa-f])` / `(?![0-9A-Fa-f])` so a larger hex value that
// merely CONTAINS a signature (e.g. "0xC00001420" or "C0000142A") does not falsely match — the
// same "don't match inside a longer number" guard DECIMAL_TEXT_RE already applies for decimal. The
// context separator's optional `(?:0[xX])?` lets the framing token be followed by either spelling
// ("failed with 0xC0000142" or "failed with C0000142") without requiring the "0x" to be consumed
// by a hex digit itself.
const HEX_TEXT_RE = new RegExp(
  SPAWN_STARVATION_SIGNATURES.map(
    (s) =>
      `${EXIT_CODE_CONTEXT_RE_SRC}(?:0[xX])?(?<![0-9A-Fa-f])${s.hex.replace(/^0x/i, '')}(?![0-9A-Fa-f])`,
  ).join('|'),
  'i',
);
// "[WinError 1455]" — Python's own OSError repr when CreateProcess refuses before the child ever
// gets an NTSTATUS to exit with (see SPAWN_STARVATION_WIN32_ERRORS above). Bracketed and prefixed
// with the literal token "WinError" on purpose: 1455 alone is far too small/generic a number to
// safely match bare (a line count, a byte count, an unrelated exit code could all coincide).
const WIN32_ERROR_TEXT_RE = new RegExp(
  `\\[WinError\\s+(?:${SPAWN_STARVATION_WIN32_ERRORS.map((e) => e.code).join('|')})\\]`,
  'i',
);
// plan 3954 T2 round-3 review (findings 0299fc/2b4cbb/c170ec/0c0ae8/463e70): the context-framing
// requirement above fixed the false-positive problem but broke the SYMBOLIC name spelling this
// repo's own messages and Windows tooling actually use — "STATUS_NO_MEMORY (C0000017)",
// "STATUS_DLL_INIT_FAILED (0xC0000142)" — because the required framing token (exit/code/status/
// NTSTATUS/...) has to sit IMMEDIATELY before the number, and the symbolic name's own trailing
// text ("_NO_MEMORY", "_DLL_INIT_FAILED") sits in the way. The symbolic name itself is unambiguous
// evidence on its own — real Windows/NTSTATUS vocabulary a genuine pytest assertion never coins by
// accident — so match it directly, whole-word, no numeric framing required.
const SYMBOLIC_NAME_RE = new RegExp(
  '\\b(?:' +
    [
      ...SPAWN_STARVATION_SIGNATURES.map((s) => s.name),
      ...SPAWN_STARVATION_WIN32_ERRORS.map((e) => e.name),
    ].join('|') +
    ')\\b',
  'i',
);
// plan 3954 T2 round-3 review (findings f33651/82a4fc): a NESTED Node child_process spawn refusal
// (queued-run.mjs's own inner python/git spawn) that surfaces only as TEXT in a captured tail —
// not a `{ code, message }` error object — reads as libuv's own "spawn ENOMEM" / "spawn EAGAIN"
// message shape, the exact prefix Node's child_process uses. Whole-word, that EXACT "spawn
// <ERRNO>" shape only — "ENOMEM" alone in prose (an unrelated log line naming an errno) is NOT
// proof the process never started.
const NODE_SPAWN_ERRNO_RE = /\bspawn\s+(?:ENOMEM|EAGAIN)\b/i;

/** True iff a numeric exit code is one of the known spawn-starvation NTSTATUS values. */
export function isSpawnStarvationCode(exitCode) {
  return (
    typeof exitCode === 'number' && Number.isFinite(exitCode) && SIGNATURE_DECIMALS.has(exitCode)
  );
}

/**
 * True iff `textOrExitCode` carries a spawn-starvation signature — either a bare numeric exit
 * code, or free text (a pytest reason, a subprocess stderr tail, a done-worktree capture) that
 * mentions one of the signature values in either spelling. Never throws on a non-string,
 * non-number input; anything else (null, undefined, an object) is simply "no signature".
 */
export function looksSpawnStarved(textOrExitCode) {
  if (typeof textOrExitCode === 'number') return isSpawnStarvationCode(textOrExitCode);
  if (typeof textOrExitCode !== 'string' || !textOrExitCode) return false;
  return (
    DECIMAL_TEXT_RE.test(textOrExitCode) ||
    HEX_TEXT_RE.test(textOrExitCode) ||
    WIN32_ERROR_TEXT_RE.test(textOrExitCode) ||
    SYMBOLIC_NAME_RE.test(textOrExitCode) ||
    NODE_SPAWN_ERRNO_RE.test(textOrExitCode)
  );
}

// pytest's short-test-summary line, e.g.
//   FAILED backend/scripts/tests/test_seed_boot_validation_gate.py::test_x - AssertionError: ...
//   ERROR backend/scripts/tests/test_y.py::test_z - OSError: ...
// Captures the node id (group 1) and, when present, the reason text after " - " (group 2) — the
// SAME node-id grammar `parsePytestFailures` (the project's own nightly test-suite runner) uses, plus the
// reason text that grammar deliberately discards (it only needs the id → file fold).
//
// NOT imported from nightly-windows-suite.mjs (plan 3954 code-review findings 129934/116e1a,
// reuse angle): two independent blockers, not one. (1) `parsePytestFailures` returns only
// deduped node ids — no reason text — so it does not carry what `allFailedTestsSpawnStarved`
// below actually needs; reusing it would mean widening its return shape for every existing
// caller (`pytestFileTargets`, `run-land-tests.mjs`'s bisect-candidate path) just to grow a
// second field only this module reads. (2) even reusing just the grammar via an import would
// cycle: `nightly-windows-suite.mjs` imports `defaultNonTtyReporter` from
// `done-worktree-lib.mjs`, which imports `looksSpawnStarved` from THIS module — so
// `spawn-failure-signatures.mjs` importing back from `nightly-windows-suite.mjs` closes the
// loop. Least-churn honest option: keep this local, duplicate regex with the drift risk named
// here and on `parsePytestFailures`' own definition, rather than force either module's shape or
// invert the import graph for one field.
const PYTEST_FAILED_LINE_RE = /^(?:FAILED|ERROR)\s+(\S+)(?:\s-\s?(.*))?$/gm;

/**
 * True iff a pytest run's captured tail shows AT LEAST ONE failed test, and EVERY failed test's
 * short-summary line carries a spawn-starvation signature in its reason text. A FAILED/ERROR line
 * with no reason text (a truncated tail, or a pytest invocation that doesn't print one) does NOT
 * count as signature-carrying — that would let one starved test vacuously "prove" every other
 * failure in a mixed run, which is exactly the false-heal shape plan 3954's acceptance criteria
 * forbid ("a run with one genuine failure alongside spawn kills still reports PYTEST_FAILED").
 * No failed tests found at all ⇒ false (nothing to classify as starved).
 */
export function allFailedTestsSpawnStarved(pytestTail) {
  const text = typeof pytestTail === 'string' ? pytestTail : '';
  PYTEST_FAILED_LINE_RE.lastIndex = 0;
  const reasons = [];
  let m;
  while ((m = PYTEST_FAILED_LINE_RE.exec(text)) !== null) {
    reasons.push(m[2] || '');
  }
  if (reasons.length === 0) return false;
  return reasons.every((reason) => looksSpawnStarved(reason));
}
