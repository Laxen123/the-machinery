// New test-file justification: name-paired tests for the new spawn-failure-signatures.mjs module
// (plan 3954 T2).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPAWN_STARVATION_SIGNATURES,
  SPAWN_STARVATION_WIN32_ERRORS,
  allFailedTestsSpawnStarved,
  isSpawnStarvationCode,
  looksSpawnStarved,
} from './spawn-failure-signatures.mjs';

// plan 3954 § Evidence: plan 3858's land preflight, `python -m pytest backend/scripts -n 9
// --dist loadfile` — 4 failed, all four spawning a child (node validator / git / a slow
// subprocess) on a box measured at 5.3 GB free of 63.8 GB. Shaped after the real pytest
// short-test-summary section (each FAILED line carries its reason inline, pytest's default), not
// a byte-identical transcript — the plan doc's own quoting trimmed reasons off three of the four
// lines for readability.
const STARVED_TAIL_3858 = [
  '=================================== FAILURES ===================================',
  '______________ test_idle_guard_does_not_kill_a_slow_process_that_keeps_writing ______________',
  'E   OSError: [WinError 3221225794] the child process could not be created',
  '=========================== short test summary info ============================',
  'FAILED backend/scripts/price-pipeline/__tests__/test_3732_codex_transport_idle_guard.py::test_idle_guard_does_not_kill_a_slow_process_that_keeps_writing - OSError: [WinError 3221225794] the child process could not be created',
  "FAILED backend/scripts/price-pipeline/test_conftest_git_isolation.py::test_a_sibling_subtrees_git_fixture_cannot_commit_into_an_inherited_git_dir - subprocess.CalledProcessError: Command 'git' returned non-zero exit status 3221225794.",
  'FAILED backend/scripts/tests/test_seed_boot_validation_gate.py::test_real_seed_passes_schema - AssertionError: Validator produced no output (exit=3221225794). stderr:',
  "FAILED backend/scripts/tests/test_seed_boot_validation_gate.py::test_free_text_verifiedby_rejected_as_schema_error - AssertionError: assert 'verifiedBy' in 'Validator produced no output (exit=3221225794). stderr:\\n'",
  '4 failed, 33966 passed, 20 skipped, 4 xfailed in 1027.12s (0:17:07)',
].join('\n');

const MIXED_TAIL_ONE_GENUINE_FAILURE = [
  '=========================== short test summary info ============================',
  'FAILED backend/scripts/price-pipeline/__tests__/test_3732_codex_transport_idle_guard.py::test_idle_guard_does_not_kill_a_slow_process_that_keeps_writing - OSError: [WinError 3221225794] the child process could not be created',
  'FAILED backend/scripts/tests/test_real_regression.py::test_price_rounds_to_two_decimals - AssertionError: assert 199.999 == 200.0',
  '2 failed, 40000 passed in 812.03s (0:13:32)',
].join('\n');

test('SPAWN_STARVATION_SIGNATURES carries both hex and decimal spellings', () => {
  assert.equal(SPAWN_STARVATION_SIGNATURES.length, 3);
  for (const sig of SPAWN_STARVATION_SIGNATURES) {
    assert.match(sig.hex, /^0x[0-9A-Fa-f]+$/);
    assert.equal(typeof sig.decimal, 'number');
    assert.equal(Number.parseInt(sig.hex, 16), sig.decimal);
  }
  const decimals = SPAWN_STARVATION_SIGNATURES.map((s) => s.decimal).sort();
  assert.deepEqual(decimals, [3221225495, 3221225773, 3221225794]);
});

test('isSpawnStarvationCode matches only the known NTSTATUS decimals', () => {
  assert.equal(isSpawnStarvationCode(3221225794), true); // STATUS_DLL_INIT_FAILED
  assert.equal(isSpawnStarvationCode(3221225495), true); // STATUS_NO_MEMORY
  assert.equal(isSpawnStarvationCode(3221225773), true); // STATUS_COMMITMENT_LIMIT
  assert.equal(isSpawnStarvationCode(0), false);
  assert.equal(isSpawnStarvationCode(1), false);
  assert.equal(isSpawnStarvationCode('3221225794'), false); // string, not a number
  assert.equal(isSpawnStarvationCode(undefined), false);
});

// plan 3954 T1 reproduction (scripts/run-with-memory-limit.ps1): STATUS_STACK_BUFFER_OVERRUN
// (0xC0000409), STATUS_BREAKPOINT (0x80000003), and STATUS_STACK_OVERFLOW (0xC00000FD) are
// runtime-internal aborts (V8's own OOM/stack crashes) seen at tighter caps than the
// spawn-starvation boundary — deliberately NOT added to the signature set, because matching them
// could mask a real crash as an infra-only "re-invoke with headroom" starvation.
test('isSpawnStarvationCode does NOT match the excluded runtime-internal-abort codes', () => {
  assert.equal(isSpawnStarvationCode(3221226505), false); // 0xC0000409 STATUS_STACK_BUFFER_OVERRUN
  assert.equal(isSpawnStarvationCode(2147483651), false); // 0x80000003 STATUS_BREAKPOINT
  assert.equal(isSpawnStarvationCode(3221225725), false); // 0xC00000FD STATUS_STACK_OVERFLOW
});

test('looksSpawnStarved matches a bare numeric exit code', () => {
  assert.equal(looksSpawnStarved(3221225794), true);
  assert.equal(looksSpawnStarved(3221225495), true);
  assert.equal(looksSpawnStarved(3221225773), true);
  assert.equal(looksSpawnStarved(1), false);
});

test('looksSpawnStarved matches decimal and hex spellings in free text', () => {
  assert.equal(looksSpawnStarved('Validator produced no output (exit=3221225794). stderr:'), true);
  assert.equal(looksSpawnStarved('spawn failed with 0xC0000142'), true);
  assert.equal(looksSpawnStarved('spawn failed with 0xc0000017'), true); // case-insensitive
  // bare hex, no 0x prefix, framed by the NTSTATUS token rather than "exit"/"code"
  assert.equal(looksSpawnStarved('process died — NTSTATUS C0000017'), true);
  assert.equal(
    looksSpawnStarved('subprocess.CalledProcessError: returned non-zero exit status 3221225773.'),
    true, // STATUS_COMMITMENT_LIMIT, decimal spelling
  );
  assert.equal(looksSpawnStarved('spawn failed with 0xC000012D'), true); // hex spelling
});

// plan 3954 T2 code-review round 2 (findings c4e38f/d0e41e): the exact false-positive shape the
// finding names — a genuine test's OWN assertion message mentioning a signature decimal, with no
// exit-code framing at all — must never read as spawn starvation, or a real regression hides
// behind a resumable-looking PYTEST_STARVED classification forever.
test('looksSpawnStarved does NOT match a bare signature decimal inside an unrelated assertion', () => {
  assert.equal(looksSpawnStarved('assert 3221225794 in codes'), false);
  assert.equal(looksSpawnStarved('AssertionError: assert 3221225794 == 0'), false);
});

// The measured 3858 shape must keep matching — this is the one case the tightened regex exists to
// preserve, not just avoid regressing.
test('looksSpawnStarved still matches the measured 3858 "(exit=N)" framing', () => {
  assert.equal(looksSpawnStarved('Validator produced no output (exit=3221225794). stderr:'), true);
});

test('looksSpawnStarved matches the WinError 1455 text signature (CreateProcess itself refused)', () => {
  assert.equal(
    looksSpawnStarved(
      'OSError: [WinError 1455] The paging file is too small for this operation to complete',
    ),
    true,
  );
  assert.equal(looksSpawnStarved('[winerror 1455]'), true); // case-insensitive
  // The bare number, with no "WinError" framing, must NOT match — 1455 alone is too small/generic.
  assert.equal(looksSpawnStarved('1455 clinics processed'), false);
  assert.equal(looksSpawnStarved('WinError 1455 without brackets'), false);
});

// plan 3954 T2 round-3 review (findings 0299fc/2b4cbb/c170ec/0c0ae8/463e70): the symbolic NTSTATUS
// name is unambiguous evidence on its own, whole-word, without the numeric context framing.
test('looksSpawnStarved matches the symbolic NTSTATUS/Win32 names as whole words', () => {
  assert.equal(looksSpawnStarved('STATUS_NO_MEMORY (C0000017)'), true);
  assert.equal(looksSpawnStarved('STATUS_DLL_INIT_FAILED (0xC0000142)'), true);
  assert.equal(looksSpawnStarved('STATUS_COMMITMENT_LIMIT'), true);
  assert.equal(looksSpawnStarved('status_no_memory'), true); // case-insensitive
  assert.equal(looksSpawnStarved('ERROR_COMMITMENT_LIMIT'), true);
  // whole-word only — a longer identifier that merely CONTAINS the name must not match
  assert.equal(looksSpawnStarved('MY_STATUS_NO_MEMORY_EXTRA'), false);
});

// plan 3954 T2 round-3 review (findings f33651/82a4fc): the exact "spawn <ERRNO>" shape libuv/Node
// itself emits, whole-word — never a bare mention of the errno in prose.
test('looksSpawnStarved matches "spawn ENOMEM"/"spawn EAGAIN" but not the bare errno in prose', () => {
  assert.equal(looksSpawnStarved('spawn ENOMEM'), true);
  assert.equal(looksSpawnStarved('queued-run: failed to spawn python — spawn ENOMEM'), true);
  assert.equal(looksSpawnStarved('spawn EAGAIN'), true);
  assert.equal(looksSpawnStarved('ENOMEM'), false);
  assert.equal(looksSpawnStarved('the disk reported EAGAIN once'), false);
});

test('looksSpawnStarved does not match the excluded runtime-internal-abort codes in free text', () => {
  assert.equal(looksSpawnStarved('exit status 3221226505'), false); // STATUS_STACK_BUFFER_OVERRUN
  assert.equal(looksSpawnStarved('0xC0000409'), false);
  assert.equal(looksSpawnStarved('0x80000003'), false); // STATUS_BREAKPOINT
  assert.equal(looksSpawnStarved('0xC00000FD'), false); // STATUS_STACK_OVERFLOW
});

test('looksSpawnStarved does not match an unrelated number or empty/null input', () => {
  assert.equal(looksSpawnStarved('exit code 1'), false);
  assert.equal(looksSpawnStarved('a longer number 13221225794 embeds the digits'), false);
  assert.equal(looksSpawnStarved(''), false);
  assert.equal(looksSpawnStarved(null), false);
  assert.equal(looksSpawnStarved(undefined), false);
  assert.equal(looksSpawnStarved({}), false);
});

test('SPAWN_STARVATION_WIN32_ERRORS carries the one Win32 error code, a different numbering space from the NTSTATUS set', () => {
  assert.equal(SPAWN_STARVATION_WIN32_ERRORS.length, 1);
  assert.equal(SPAWN_STARVATION_WIN32_ERRORS[0].code, 1455);
  assert.equal(SPAWN_STARVATION_WIN32_ERRORS[0].name, 'ERROR_COMMITMENT_LIMIT');
});

test('allFailedTestsSpawnStarved is true when the 3858-shaped tail is all spawn-starved failures', () => {
  assert.equal(allFailedTestsSpawnStarved(STARVED_TAIL_3858), true);
});

test('allFailedTestsSpawnStarved is false when one failed test alongside spawn kills is a genuine regression', () => {
  assert.equal(allFailedTestsSpawnStarved(MIXED_TAIL_ONE_GENUINE_FAILURE), false);
});

test('allFailedTestsSpawnStarved is false with no FAILED/ERROR lines at all', () => {
  assert.equal(allFailedTestsSpawnStarved('3 passed in 0.42s'), false);
  assert.equal(allFailedTestsSpawnStarved(''), false);
  assert.equal(allFailedTestsSpawnStarved(undefined), false);
});

test('allFailedTestsSpawnStarved is false when a FAILED line carries no reason text (truncated tail)', () => {
  // A FAILED line with no " - <reason>" must never vacuously count as signature-carrying — that
  // would let a truncated tail "prove" starvation it never actually showed.
  const tail = [
    'FAILED backend/scripts/tests/test_seed_boot_validation_gate.py::test_real_seed_passes_schema',
    '1 failed in 0.42s',
  ].join('\n');
  assert.equal(allFailedTestsSpawnStarved(tail), false);
});

test('allFailedTestsSpawnStarved is true for a WinError 1455 tail (CreateProcess itself refused, no NTSTATUS exit code)', () => {
  const tail = [
    'FAILED backend/scripts/price-pipeline/__tests__/test_x.py::test_a - OSError: [WinError 1455] The paging file is too small for this operation to complete',
    '1 failed in 0.31s',
  ].join('\n');
  assert.equal(allFailedTestsSpawnStarved(tail), true);
});

test('allFailedTestsSpawnStarved recognises ERROR lines the same as FAILED lines', () => {
  const tail = [
    'ERROR backend/scripts/tests/test_x.py::test_y - OSError: [WinError 3221225495] not enough memory',
    '1 error in 0.10s',
  ].join('\n');
  assert.equal(allFailedTestsSpawnStarved(tail), true);
});

// plan 3958: the plan-3954 lockstep drift guard that used to live here (parsing
// backend/scripts/_seed_validation.py's Python frozenset literal and asserting it matches
// SPAWN_STARVATION_SIGNATURES' JS decimal set) is removed -- backend/ is vetapp product code,
// never shipped by the public coord-kit. Genuine vetapp product coverage, not core.
