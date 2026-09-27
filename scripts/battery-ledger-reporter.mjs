// scripts/battery-ledger-reporter.mjs — a node:test CUSTOM REPORTER (plan 3223) that emits one
// JSONL line per completed TEST FILE (not per individual test), for battery-ledger.mjs's `merge`
// command to fold into the persistent green ledger. Loaded as a THIRD `--test-reporter` /
// `--test-reporter-destination` pair alongside the pre-existing `spec`→stdout and `tap`→tapfile
// pairs the battery gates already use — never a replacement for either.
//
// WHY A CUSTOM REPORTER AND NOT THE EXISTING TAP HARVEST (plan 3223's pinned empirical finding —
// re-verify with the scratch probes below before trusting this on a future node version, and see
// battery-ledger.test.mjs for the pinned assertions). Measured live on the node version this repo
// actually runs:
//   - `node --test <files> --test-reporter=tap` produces a FLAT stream of per-TEST `ok`/`not ok`
//     lines. A PASSING test's TAP entry carries NO file reference at all — the existing plan-2530/
//     2875 failure harvest works only because a `not ok` entry ALSO carries a `location:
//     '<path>:<line>:<col>'` diagnostic, which a passing test never emits. TAP genuinely cannot
//     carry the per-file PASS signal this ledger needs.
//   - The node:test CUSTOM REPORTER event stream can. Every `test:complete` event's `data.file`
//     is the absolute path node resolved for that test. There is a real, distinct per-FILE
//     completion event: node wraps every test FILE in an implicit top-level test (`nesting: 0`)
//     whose `passed` is the AND of everything the file registered — present even for a file that
//     registers zero tests, or one that throws at import time before registering any (verified).
//
// IDENTIFYING THE FILE-LEVEL EVENT — the correction to the plan's own pinned finding. The plan's
// note assumed `data.name === data.file` picks out the file-level wrapper. That holds ONLY when
// node is invoked with an ABSOLUTE test-file path. This repo's actual invocations (the pre-push
// hook's `"$@"`, done-worktree's `listScriptsTestFiles` output) are REPO-RELATIVE
// (`scripts/<name>.test.mjs`) — and empirically, the wrapper's `data.name` is the EXACT ARGV STRING
// node received for that file (relative when invoked relatively, absolute when invoked
// absolutely), while `data.file` is ALWAYS the resolved absolute path. So `name === file` is
// FALSE for every real invocation this reporter will ever see. The robust, invocation-agnostic
// test verified instead:
//
//     resolve(process.cwd(), event.data.name) === event.data.file
//
// This holds because the wrapper's `name` IS whatever arg was passed on the command line, and
// `file` IS that same arg resolved against the SAME cwd this reporter itself observes (same
// process — no IPC boundary to cross). A real subtest's `name` is a human description ("passes
// the postal-code check"), which resolved against cwd essentially never coincides with the file's
// own absolute path. Verified across: absolute invocation, relative invocation, a file with zero
// tests, a file with a top-level test PLUS a nested `describe`, and a file that throws at import
// time before registering anything — exactly one `isWrapper` event per file in every case, with
// `passed` correctly aggregating (verified false for both "a top-level test failed" and "the file
// crashed on import").
//
// THE MaxListenersExceededWarning FIX. Adding a THIRD `--test-reporter`/`--test-reporter-
// destination` pair pushes the shared TestsStream's listener count past Node's default cap of 10,
// which prints "(node:PID) MaxListenersExceededWarning: ... 11 end listeners added" to STDERR —
// verified: two reporters (today's spec+tap) never trip it, three does. That warning would land
// in the pre-push hook's spec→stdout stream (piped through `tee`, so fully developer-visible) on
// EVERY battery run once this reporter is wired in — pure noise on a hot path. `setMaxListeners`
// below (Node's own top-level `node:events` API, not `EventEmitter.prototype.setMaxListeners`,
// since this module never gets a handle to the actual internal stream object) raises the process-
// wide default BEFORE the stream's listener count is checked; verified live that this fully
// suppresses the warning with no other observable change to spec's output.
//
// CONTRACT WITH battery-ledger.mjs: this file's ONLY output is a stream of complete JSON lines,
// each `{"file":"<absolute path>","passed":<bool>}\n` — see that module's `parseLedgerEvents` for
// the reader half (including its truncation-safety handling of a SIGKILLed run's in-flight line).
// This reporter performs NO fs reads, NO key derivation, NO merge logic — it only observes the
// live test:complete stream and yields text; node's own `--test-reporter-destination` plumbing is
// what makes those yields land on disk incrementally (the same mechanism the pre-existing tapfile
// already depends on for its own truncation-tolerant harvest).

import { setMaxListeners } from 'node:events';
import { resolve } from 'node:path';

setMaxListeners(20);

export default async function* batteryLedgerReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:complete' || event.data.nesting !== 0) continue;
    const { name, file, details } = event.data;
    // See the module header: the file-level wrapper's `name` is the exact invocation string for
    // that file, so resolving it against THIS process's own cwd reproduces node's own resolution
    // of `file` — a real subtest's human-readable `name` essentially never does.
    if (resolve(process.cwd(), name) !== file) continue;
    // plan 4236 T5: the file's own wall time rides along (additive — every reader keys on
    // `file`/`passed` and ignores the rest), so a heavy single-file question has data to answer
    // from instead of ad-hoc logs. Absent when node reports no finite duration.
    const ms = Number(details?.duration_ms);
    const durationMs = Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : undefined;
    yield `${JSON.stringify({ file, passed: !!details?.passed, durationMs })}\n`;
  }
}
