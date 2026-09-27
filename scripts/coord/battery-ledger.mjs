#!/usr/bin/env node
// scripts/battery-ledger.mjs — a per-file GREEN LEDGER for the scripts-battery gate (plan 3223).
//
// WHY THIS EXISTS. The existing battery-pass-cache.mjs (plan 1824) remembers "this exact
// content + selection passed" as ONE all-or-nothing fact — a kill or a single red file produces
// ZERO cache benefit, and the next attempt re-runs the whole selection from scratch. This module
// is the finer-grained sibling: it remembers which INDIVIDUAL FILES within a selection have
// already proven green under a given content key, written incrementally DURING the run (via
// battery-ledger-reporter.mjs, this module's node:test reporter half), so a retry within one run
// — or a same-content re-push after a cap-kill — can subtract what already passed and run only
// the remainder. It never decides whether the GATE is green (that stays the hook's / the
// preflight's job, by requiring full coverage of the ORIGINAL selection); it only ever answers
// "which files, of this selection, are already proven green under this exact content key".
//
// WHY A SEPARATE STORE FROM battery-pass-cache.mjs, NOT AN EXTENSION OF IT. That cache's key
// covers the whole battery's readable surface (external-tree prefixes, the gate-logic file, the
// installed toolchain) and its unit is a SELECTION-level pass/fail. Reusing its storage for a
// per-file ledger would either narrow that cache's own soundness surface to satisfy a per-file
// question it was never asked, or bolt a second unrelated shape onto one JSON entry format. Two
// separate concerns stay two separate stores; KEY DERIVATION is still shared (imported from
// battery-pass-cache.mjs below) so "same content ⇒ same key" holds identically in both places —
// see that module's own header for why content-addressing (not a patch-id / mutable marker) is
// the right primitive.
//
// STORAGE: `.scratch/gate-ledgers/<key>.json`, resolved relative to the CALLING PROCESS's cwd —
// deliberately NOT the shared `<git common dir>/…` rendezvous battery-pass-cache.mjs and
// battery-lock.mjs use. Those two need cross-WORKTREE sharing (a land's master merge-push must
// see the SAME cache a branch's force-push wrote, from a DIFFERENT worktree). This ledger's two
// callers — the pre-push hook (retry within one push, or a same-content re-push from the SAME
// worktree) and done-worktree's land preflight (its own single wtPath) — never need
// cross-worktree visibility, and `.scratch/` is already this repo's convention for exactly this
// kind of disposable, per-checkout, gitignored state (see CLAUDE.md § Batch/long-running/output).
// A ledger written by one worktree is simply invisible to another — safe by construction, never a
// soundness question (the content key still gates everything; an invisible ledger just means a
// MISS, i.e. "run everything", never a false hit).
//
// FAIL DIRECTION (mirrors pass-cache-kernel.mjs's documented contract — see that file's header):
// every uncertain path — an unparseable/oversized key, a missing/corrupt/expired ledger entry, an
// unreadable events file, a git error, an fs error — degrades to "no ledger, run everything".
// Nothing in this module can cause a file to be SKIPPED that was never proven green; it can only
// skip re-running a file that already was. `merge` additionally never blocks: it is close-out
// bookkeeping, called after a run whose pass/fail verdict is already decided elsewhere.
//
// TRUNCATION SAFETY (plan 3223's PINNED FINDING — see battery-ledger.test.mjs for the empirical
// basis): the reporter writes ONE JSON line per file, each terminated by its own '\n', via
// node's own `--test-reporter-destination` file stream — the SAME incremental-write mechanism
// the pre-existing TAP failure harvest already depends on (a SIGKILL mid-run leaves whatever was
// already flushed, and nothing more). parseLedgerEvents drops the LAST split segment
// unconditionally: on a well-formed file that is the trailing empty string after the final '\n';
// on a file truncated mid-write (killed between the JSON body and its trailing '\n') that is the
// truncated fragment itself. Either way, a truncated line is NEVER read as evidence — not even as
// a false failure, simply discarded, exactly what the plan's acceptance criteria requires.
//
// CONTENT-KEY IDENTIFICATION OF THE PER-FILE WRAPPER EVENT (the other empirically-verified half,
// documented in full in battery-ledger-reporter.mjs — this module never touches node:test event
// shapes directly, only the JSONL the reporter already normalized).
//
// Usage (mirrors battery-pass-cache.mjs's CLI shape):
//   printf '%s\n' "$SELECTION" | node scripts/battery-ledger.mjs key
//       stdout: the resolved content key (32 lowercase hex chars) on success; nothing on refusal.
//       exit:   0 ok · 2 refused (uncacheable — see stderr)
//   printf '%s\n' "$SELECTION" | node scripts/battery-ledger.mjs remainder --key <k>
//       stdout: $SELECTION minus every file already proven green under <k> (one per line, in
//               $SELECTION's own normalized order) — the FULL selection, unchanged, whenever <k>
//               is missing/malformed (fail-safe: no key ⇒ nothing to subtract).
//       exit:   always 0 (a "run everything" answer is never a failure).
//   node scripts/battery-ledger.mjs merge --key <k> --file <path> [--head <oid>]
//       Reads <path> (a battery-ledger-reporter.mjs destination file — the per-attempt JSONL of
//       file-level pass/fail events), unions its passed files into the persistent ledger entry
//       for <k>. Always exits 0 — this is close-out, called after the run's own verdict already
//       decided the push/land outcome; a ledger write must never retroactively affect it.
//       `--head` (plan 3225) is the HEAD commit oid the caller resolved BEFORE the run; it is
//       re-verified here and recorded as the entry's delta baseline only if HEAD did not move.
//       plan 3620 fix round (H1, findings de4f6d/8138ba/12003b/e7afab/54a2bd/a850c6/6991ad/7fae55/
//       14b7eb): this exit-0-always contract means the CLI's own exit STATUS can never tell a
//       caller whether the write actually reached disk — a THROWN fs write is caught (see below)
//       and still exits 0. So the LAST line printed to stdout is now an unambiguous sentinel,
//       `${MERGE_PERSISTED_SENTINEL}=1` or `=0` (exactly `MERGE_PERSISTED=1`/`=0`, no other text on
//       that line) — the SAME "print a sentinel, test it by exact string equality" discipline the
//       `chunk-round`/`pytest-chunk-round` sentinel below already uses.
//       plan 3620 fix round (I1): `=0` means only ONE thing now — no evidence a write could even
//       have reached disk (a missing `--key`/`--file`, an unreadable/missing destination file, or a
//       destination that WAS read but whose write attempt THREW — an fs error caught below). A
//       destination that read fine but named ZERO passed files is a VACUOUS success — no write was
//       even attempted (mergeGreenFiles' own no-op-on-empty rule), but nothing went wrong either —
//       and now prints `=1`, exactly like a genuine write. This is the CANONICAL non-convergent-round
//       shape (a chunk-capped gate stuck on one over-wall file banks nothing every round): under the
//       pre-I1 contract it always printed `=0`, so `ranProven` at the hook's two live seats was NEVER
//       true for it and GATE_NON_CONVERGENT could never fire on the exact case it exists to catch.
//       Sound because this sentinel only vouches that THIS round's own proof — however much or
//       little — reached the ledger; whether that proof amounts to PROGRESS is
//       scoreChunkRoundByGreenMark's question alone, answered by comparing green-set fingerprints
//       across rounds, never by this sentinel (see that function's own header).
//       plan 3620 fix round (I2, delta review): read "no write FAILED" as scoped to the GREEN-SET
//       write specifically — the one write whose result the non-convergence bound fingerprints —
//       never as "no write anywhere in this subcommand failed". Two things are DELIBERATELY outside
//       it, and a reader tempted to fold either one in should not: (1) `pytest-merge`'s separate
//       STALL-ledger write (plan 3318) is best-effort bookkeeping that claims nothing green, so its
//       failure must not flip a round whose green proof genuinely reached disk back to `=0` — doing
//       so would re-suppress the bound on exactly the rounds it exists to catch; and (2) an
//       UNREADABLE worker sidecar among several sources is tolerated by design (plan 3555 —
//       readPytestLedgerEventSources drops it so one unreadable worker cannot discard proof its
//       readable siblings already flushed), so a partial source read still reports `=1` for whatever
//       WAS banked. Neither can manufacture a false non-convergent verdict on its own: a round that
//       banks a smaller green set than the next one shows PROGRESS and resets the counter, and two
//       consecutive rounds banking the identical set really did prove nothing new — which is the
//       verdict. Both are pinned by tests in scripts/coord/battery-ledger.test.mjs so a later reader
//       cannot "tighten" them into that regression silently.
//       scripts/hooks/pre-push.sh's two live seats require exact `MERGE_PERSISTED=1` before
//       trusting this round's proof reached the persistent green set the non-convergence bound
//       fingerprints — see prepush_chunk_round_is_nonconvergent's own call sites.
//   node scripts/battery-ledger.mjs events-count --file <path>
//       plan 3620 fix round (G2). stdout: a single integer — the number of well-formed,
//       non-truncated events in <path> (a battery-ledger-reporter.mjs destination file), via the
//       SAME parseTruncationSafeJsonLines every other reader in this module trusts. Always exits 0;
//       prints `0` on a missing/unreadable file. Replaces a shell-side `[ -s <path> ]` non-empty-
//       bytes check, which a truncated-mid-write file can satisfy while proving nothing.
//   printf '%s\n' "$SELECTION" | node scripts/battery-ledger.mjs carry-forward --key <k>
//       plan 3225 (Fix A). Seeds <k>'s ledger with the files a PREVIOUS live green already proved
//       and the delta since that green provably cannot reach (its own commit → HEAD diff, fed
//       through scripts/select-battery-tests.mjs). Always exits 0; every doubt seeds nothing, so
//       the gate simply runs what it runs today.
//   node scripts/battery-ledger.mjs path            # the resolved ledger dir (debug/inspection)
//
// pytest-side subcommands (plan 3223 fix steps 3/4) — SAME contract shape as `remainder`/`merge`
// above, over a SEPARATE namespace (resolvePytestLedgerDir, not resolveLedgerDir) and a different
// events parser, since backend/scripts/_gate_ledger.py's own event shape differs from node:test's
// (see parsePytestLedgerEvents' own header for the file-green definition this implements — E4):
// Plan 3499: this stays sound unchanged under `--dist loadfile`: one file stays on one worker, so
// that file's own wall remains its own, preserving the wall-budgeted chunking invariant.
//   printf '%s\n' "$FILES" | node scripts/battery-ledger.mjs pytest-remainder --key <k>
//       Same contract as `remainder`, over the pytest namespace. Called from inside
//       backend/scripts/_gate_ledger.py's pytest_collection_modifyitems, not from a shell — the
//       stdin is the set of files THIS run's collection produced (already rootdir-relative,
//       "backend/scripts/..."-prefixed), not a shell-computed selection.
//   printf '%s\n' "$FILES" | node scripts/battery-ledger.mjs pytest-carry-forward --key <k>
//       Same contract as `carry-forward`, over the pytest namespace and through
//       backend/scripts/_select_tests.py. Additionally refuses (⇒ full run) when the delta touches
//       a pytest KEY-CLOSURE path that selector does not map — `backend/src/data`, `shared/src` —
//       see unmappedClosurePaths' own header for why the land tier is stricter than the push tier.
//   node scripts/battery-ledger.mjs pytest-merge --key <k> --file <path> [--head <oid>]
//       Reads <path> (a _gate_ledger.py events file: collect + per-test-terminal-report JSONL),
//       computes each file's green/not-green verdict (E4), and merges the green set into the
//       persistent ledger entry for <k>. Always exits 0 (close-out, mirrors `merge`). Called from
//       scripts/hooks/pre-push.sh and done-worktree.mjs's runPytestPreflight, unconditionally
//       after the pytest process exits (pass, fail, OR killed) — mirrors _rbr_merge_ledger.
//       plan 3620 fix round (H1/I1): SAME `${MERGE_PERSISTED_SENTINEL}=1`/`=0` last-stdout-line
//       contract as `merge` above, INCLUDING the I1 vacuous-success rule (real event sources with a
//       ZERO-file green set is `=1`, not `=0`) — see that subcommand's own doc block for the exact
//       rule; nothing pytest-specific changes it.
//   node scripts/battery-ledger.mjs pytest-events-count --file <path>
//       plan 3620 fix round (G2/G2b). The pytest twin of `events-count` above: sums well-formed
//       COMPLETION events (a `collect` line, or a TERMINAL `report`) across EVERY physical stream
//       <path> resolves to (the canonical file plus its xdist `.gwN` worker siblings —
//       readPytestLedgerEventSources, the SAME source list `pytest-merge` already reads), so a
//       cap-killed xdist run's worker-only proof still counts. plan 3620 fix round (H2): `start`
//       and `slow_deselect` lines do NOT count — see countWellFormedPytestEventsIn's own header
//       for why counting them would manufacture ran-proven evidence out of a round that banked
//       nothing. Always exits 0; prints `0` on a missing/unreadable file. Replaces a shell-side
//       `grep -q '"type": *"collect"'` check, which can match inside a truncated final fragment.
//
// plan 3620 (push-side non-convergence bound — the land side's own NON_CONVERGENT_ROUNDS/
// scoreChunkRound port, see that constant's header below for the full backstory):
//   node scripts/battery-ledger.mjs chunk-round --key <k> [--ran-proven]
//   node scripts/battery-ledger.mjs pytest-chunk-round --key <k> [--ran-proven]
//       Call AFTER this round's own `merge`/`pytest-merge`, at a RAN-AND-CHUNKED seat only (never
//       at a did-not-start seat — see scoreChunkRoundByGreenMark's own header for why). Compares
//       the green set's current fingerprint against the mark the PREVIOUS call under the same key
//       left on the ledger record, records the resulting consecutive zero-progress round count,
//       and prints TWO lines to stdout: one line of compact JSON —
//         {"rounds":N,"progressed":true|false,"nonConvergent":true|false,"ranProven":true|false,
//          "green":N}
//       — followed by the plan 3620 fix round (G3) SENTINEL line, exactly
//       `PREPUSH_CHUNK_ROUND_NONCONVERGENT=1` or `=0` (see CHUNK_ROUND_NONCONVERGENT_SENTINEL
//       below) and nothing else on that line — the hook's shell-side reader takes ONLY this last
//       line and tests it for EXACT STRING EQUALITY, never a substring/glob match against the JSON
//       line (the pre-fix hook's own overclaimed "validates the full grammar" shape guess). `=1`
//       is emitted iff this call's own `ranProven` AND `nonConvergent` are both true; every other
//       outcome — including every UNSCOREABLE one below — emits `=0`.
//       Always exits 0 (close-out, mirrors `merge`/`pytest-merge`) — the CALLER decides what to do
//       with `nonConvergent`/the sentinel. A missing/malformed --key prints the same fail-safe
//       answer an internal fs/JSON failure would (`nonConvergent:false, ranProven:false`, sentinel
//       `=0`) rather than erroring. `--ran-proven` (plan 3620 fix round, F1) is the CALLER's
//       positive evidence that the gate this round scores actually executed (its own
//       collection/report events) — OMITTED (the default) means UNSCOREABLE: `rounds`/
//       `progressed`/`nonConvergent` all read the same fail-safe "today's ordinary CHUNKED answer"
//       as a bad key, and nothing is written to the ledger. See scoreChunkRoundByGreenMark's own
//       header for the full contract this mirrors from done-worktree.mjs's own scoreChunkRound.
//
// Runbook: none yet (plan 3223 is this module's introduction) — see the plan file for the design
// record until a runbook is warranted.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { relative, sep, join, dirname, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { scriptsFileFrom, repoRootFrom } from './scripts-anchor.mjs';
import { readStdin } from './stdin-read.mjs';
import { parseLockArgs } from './landing-lock.mjs';
import { loadCoordConfig } from './coord-config.mjs';
// plan 3225 (Fix A): the pytest gate's KEY CLOSURE is read off the gate registry itself, never
// re-typed here — a hand-copied second copy of that array is exactly the drift plan 2492 closed
// between the two pass-caches. `keyedPaths`/`EXTERNAL_TREE_PREFIXES` play the same role for the
// battery half (see BATTERY_UNMAPPED_CLOSURE below, whose derivation battery-ledger.test.mjs pins).
// plan 4071 T4/D5: `GATES` is gone — `gatesFrom(config)` builds the registry from
// coord.config.json's `gates` key (caller-injects; `main()` below is the CLI entry point that
// resolves it once), and `pytestClosureFor(gates)` reads the pytest entry off THAT registry.
import { gatesFrom, pathCovers } from './gate-pass-cache.mjs';
import { EXTERNAL_TREE_PREFIXES } from './select-battery-tests.mjs';
// Reused, not reimplemented — see the WHY A SEPARATE STORE header above. `deriveKey` is the SAME
// content-addressing battery-pass-cache.mjs's own `check`/`record` use; `makeGit`/`normalizeSelection`
// are its git seam and stdin-normalization helpers. Nothing about how a key is COMPUTED lives in
// this file — only how a per-file GREEN SET is stored/read/merged under a key someone else minted.
import {
  deriveKey,
  keyedPaths,
  makeGit,
  normalizeSelection,
  scopedPrefixesFor,
} from './battery-pass-cache.mjs';
import {
  DEFAULT_TTL_MIN,
  entryPath,
  isLive,
  parseEntry,
  readCacheEntry,
  writeCacheEntry,
} from './pass-cache-kernel.mjs';

export { DEFAULT_TTL_MIN };

// plan 3620 fix round (H1, findings de4f6d/8138ba/12003b/e7afab/54a2bd/a850c6/6991ad/7fae55/
// 14b7eb): the `merge`/`pytest-merge` CLI's machine-readable PERSISTENCE sentinel name — the LAST
// line those two subcommands print is exactly `${MERGE_PERSISTED_SENTINEL}=1` or `=0`, nothing
// else on that line. Exported so scripts/hooks/pre-push.sh's own header comment and
// its name-paired test can spell the identical literal rather than a second hand-typed
// copy that could drift from what this CLI actually emits — the same discipline
// CHUNK_ROUND_NONCONVERGENT_SENTINEL below already uses. Both subcommands ALWAYS exit 0 (their
// documented "never blocks" contract — see the module header) even when the write THREW, which is
// exactly why an exit-status check can never answer "did this round's proof reach the persistent
// green set" — only this sentinel can.
// plan 3620 fix round (I1): `=1` means "no write FAILED", not "there was something to write" — a
// round whose evidence parsed fine but named nothing new to bank (a VACUOUS success) is `=1` too.
// See the `merge` subcommand's own doc block above for the full contract and the failure class this
// closes (GATE_NON_CONVERGENT could never fire on its own canonical zero-progress case before it).
export const MERGE_PERSISTED_SENTINEL = 'MERGE_PERSISTED';

// The `--test-reporter` value for this ledger's reporter half, spelled ONCE for every caller
// (done-worktree.mjs's runFullBatteryPreflight, and battery-ledger.test.mjs's empirical cases).
// Both used to rebuild it independently from their own dirname plus the same filename literal, so
// relocating or renaming the reporter could leave the tests green on a fresh path while the land
// preflight silently kept passing a stale one — and a reporter that will not load takes node's
// whole test harness down at startup, before a single test runs.
//
// A `file://` URL, not a path: `--test-reporter` is imported as an ESM module SPECIFIER. A POSIX
// absolute path happens to be a valid one, which is why the bare-path version was green on every
// Linux cloud drain; a Windows absolute path is not (`ERR_UNSUPPORTED_ESM_URL_SCHEME … Received
// protocol 'c:'`). `new URL(…, import.meta.url)` is resolved relative to THIS module, so it also
// cannot drift from the file's actual location the way a rebuilt string can.
// platform-assert-ok: the URL form is correct on both platforms — this removes a platform-specific
// branch rather than pinning one.
// plan 3962 Phase 2: this module moved to scripts/coord/, the REPORTER did not — it is an asset
// scripts/hooks/pre-push.sh also passes by the repo-relative path `./scripts/battery-ledger-reporter.mjs`,
// so it stays on the flat layer and is resolved by ANCHORING on the scripts/ directory name
// rather than by this module's own depth. A `./` URL here silently resolved relative to THIS
// module's own new location under scripts/coord/ instead, missing the reporter entirely, and
// every ledger-attached `node --test` failed to start with ERR_MODULE_NOT_FOUND — the land
// battery, not a test.
export const REPORTER_SPECIFIER = pathToFileURL(
  scriptsFileFrom('battery-ledger-reporter.mjs', dirname(fileURLToPath(import.meta.url))),
).href;

// Which reporter node:test IMPLICITLY selects for a piped (non-TTY) stdout on the node actually
// running — the value runFullBatteryPreflight must re-attach explicitly when it adds the ledger
// reporter above, because attaching ANY explicit `--test-reporter` suppresses node's implicit
// default and would otherwise change the shape of that preflight's captured diagnostic tail.
// Relocated here from done-worktree-lib.mjs by plan 3962 Decision 5, beside the reporter it must
// agree with.
//
// This is a FUNCTION rather than the literal it replaces because the answer is node-version
// dependent and the repo runs two nodes: up to node 22 the non-TTY default was `tap` (`spec` only
// on a real TTY); node 23 made `spec` the default for every stdout shape. A hard-coded 'tap' was
// therefore correct on the Linux cloud drains it was proven against (node 22) and silently wrong on
// this machine (node 24) — and its pinning test, which asserted TAP-shaped output unconditionally,
// FAILED on every local run, which on a full battery means it blocked every local land. Deriving it
// keeps one answer correct on both instead of picking a version to be wrong on.
//
// `version` is a parameter so the mapping is testable without a second node install.
export function defaultNonTtyReporter(version = process.version) {
  const major = Number.parseInt(String(version).replace(/^v/, '').split('.')[0], 10);
  // Unparseable version → 'spec': the forward-compatible answer, and every node from 23 on.
  return Number.isFinite(major) && major < 23 ? 'tap' : 'spec';
}

// A SEPARATE dir from both battery-pass-cache/ (a different rendezvous entirely — see the header)
// and gate-pass-cache/ — different key format, different prune policy, different lifetime story.
// `root` is the repo/worktree root to resolve `.scratch/` under; every caller passes (or defaults
// to) its OWN process.cwd() — see the STORAGE header above for why this is deliberately NOT the
// shared git-common-dir rendezvous the other two caches use.
export function resolveLedgerDir(root = process.cwd()) {
  return join(root, '.scratch', 'gate-ledgers');
}

// plan 3223 (pytest half). A SEPARATE subdirectory, not a separate key SHAPE — `entryPath`
// (pass-cache-kernel.mjs) enforces `<key>.json` with `key` matching `^[0-9a-f]{32}$`, so a
// prefixed filename like `pytest-<key>.json` would fail that check outright. Namespacing by
// DIRECTORY instead keeps every read/write below going through the exact same
// `readCacheEntry`/`writeCacheEntry`/`isLive` functions the battery ledger already uses — only
// the `ledgerDir` argument differs — while making a battery key and a pytest key for the
// (extremely unlikely, but not impossible: both are sha256-derived 32-hex-char strings)
// identical hex value land in two different files on disk. battery-ledger.test.mjs pins this
// separation with an explicit same-key-different-namespace case.
export function resolvePytestLedgerDir(root = process.cwd()) {
  return join(resolveLedgerDir(root), 'pytest');
}

// This CLI's flag surface — mirrors battery-pass-cache.mjs's CACHE_ARG_SPEC shape (same parser,
// same subcommand convention) rather than a hand-rolled argv walk.
// plan 3225: `head` is the caller's vouched-for HEAD commit oid on `merge`/`pytest-merge` — see
// mergeGreenFiles' own header for why passing it is a PROOF and omitting it is the safe default.
export const LEDGER_ARG_SPEC = Object.freeze({
  label: 'battery-ledger',
  value: Object.freeze(['key', 'file', 'head']),
  // plan 3318: `pytest-remainder --with-stalls` switches that ONE subcommand's stdout to
  // `<file>\t<stall-count>`. Opt-in rather than a shape change, because the bare form has a
  // second caller that counts plain path lines (done-worktree.mjs's ledgerRemainderCount).
  // plan 3620 (F1): `chunk-round --ran-proven` / `pytest-chunk-round --ran-proven` — the CALLER's
  // positive evidence that the gate this round scores actually executed. Absent ⇒ unscoreable;
  // see scoreChunkRoundByGreenMark's own header for the full contract.
  boolean: Object.freeze(['with-stalls', 'ran-proven']),
});

// --- shared truncation-safe JSONL reader (plan 3223 review round: finding 10/CONFIRMED) --------
//
// This repo's ONE incremental-JSONL convention (see the module header's TRUNCATION SAFETY
// section) — factored out so the two per-attempt parsers below (node:test's `parseLedgerEvents`,
// pytest's `parsePytestLedgerEvents`) can never drift apart on what counts as a trustworthy line.
// Splits on '\n' and unconditionally drops the LAST segment — a well-formed file's trailing ''
// after the final '\n', or a truncated in-flight fragment with no trailing '\n' at all; either way
// never trustworthy on its own — then yields every remaining non-empty line that parses as JSON. A
// single corrupt line (should never happen given either writer's contract, but one must never
// poison its siblings) is simply dropped, not fatal to the file. Callers apply their own per-event
// SHAPE validation on top (`typeof obj.file === 'string'`, etc.) — this function only ever answers
// "was this a well-formed, non-truncated JSON line", nothing about what it means.
export function parseTruncationSafeJsonLines(text) {
  const lines = String(text ?? '').split('\n');
  lines.pop(); // never trustworthy on its own — see this function's own header above.
  const objects = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      objects.push(JSON.parse(line));
    } catch {
      continue; // one corrupt line must never poison its siblings.
    }
  }
  return objects;
}

// --- parsing the reporter's per-attempt JSONL -------------------------------------------------

// Parse a battery-ledger-reporter.mjs destination file's content into the set of files it
// reported PASSED and the set it reported FAILED (both keyed by the ABSOLUTE path node:test
// itself resolved — the reporter's own `event.data.file`; callers relativize via
// `toPosixRelative` before comparing against a selection, which arrives as repo-relative paths).
// See the module header for the truncation-safety contract this implements (shared with
// parsePytestLedgerEvents below via parseTruncationSafeJsonLines).
// plan 4236 T5: `durations` (additive) maps each reported file to its `durationMs` when the event
// carried a finite, non-negative one — pre-4236 events carry none and simply contribute nothing.
export function parseLedgerEvents(text) {
  const passed = new Set();
  const failed = new Set();
  const durations = new Map();
  for (const obj of parseTruncationSafeJsonLines(text)) {
    if (!obj || typeof obj.file !== 'string' || typeof obj.passed !== 'boolean') continue;
    (obj.passed ? passed : failed).add(obj.file);
    if (Number.isFinite(obj.durationMs) && obj.durationMs >= 0)
      durations.set(obj.file, obj.durationMs);
  }
  return { passed, failed, durations };
}

// plan 3620 fix round G2 (findings 7db544/59a79d/276d88/b26033/d7e34f/a9a364): the shell hook used
// to gate its ran-proven evidence on `[ -s "$_rbr_ledgerfile" ]` — non-empty BYTES, not "at least
// one COMPLETE event". A reporter destination killed mid-write is non-empty (and, on the pytest
// side, the equivalent `grep -q '"type": *"collect"'` can match inside a truncated final
// fragment too) yet proves nothing actually completed. This module already owns the correct rule
// — parseTruncationSafeJsonLines's LAST-segment drop — so the hook consults it through this CLI
// subcommand instead of re-deriving a second, weaker truncation heuristic in shell. Counts only
// well-formed events matching parseLedgerEvents' own per-event shape check (`file` a string,
// `passed` a boolean), so a corrupt middle line is silently skipped exactly as parseLedgerEvents
// itself already treats one, never counted as evidence.
export function countLedgerEvents(text) {
  let n = 0;
  for (const obj of parseTruncationSafeJsonLines(text)) {
    if (obj && typeof obj.file === 'string' && typeof obj.passed === 'boolean') n += 1;
  }
  return n;
}

// The reporter's events are keyed by node:test's own resolved ABSOLUTE path; every selection this
// module ever compares against (from the hook's `"$@"`, from done-worktree's `listScriptsTestFiles`)
// is repo-relative (`scripts/<name>.test.mjs`). Normalize to POSIX separators explicitly — a
// Windows `path.relative` result uses `\`, and this repo's selection lists (and the pre-push
// hook's own shell string handling) are forward-slash throughout; leaving native separators here
// would make every green entry silently fail to match its own selection on a Windows push.
export function toPosixRelative(root, absPath) {
  return relative(root, absPath).split(sep).join('/');
}

// --- parsing _gate_ledger.py's per-attempt JSONL (plan 3223, pytest half) ----------------------
//
// backend/scripts/_gate_ledger.py emits two event shapes to its own per-attempt destination
// file, one JSON object per line:
//   {"type":"collect","file":"<repo-relative path>","count":<n>}   — once per file, after THIS
//     run's own ledger deselection has already settled (a file this run deselected as
//     already-proven never gets a collect line at all — it needs none, see that module's header).
//   {"type":"start","file":"<repo-relative path>"}   — plan 3318: one line the first time any
//     item of that file begins executing. The ONLY evidence a cap-killed attempt leaves about the
//     file it died inside (that file has no terminal reports and, if the kill beat collection's
//     flush, no `collect` line either). Consumed by `stalledPytestFiles` below; deliberately not
//     read by `greenPytestFiles`, so an events file written by a pre-3318 plugin — no `start`
//     lines at all — parses and merges exactly as it did before.
//   {"type":"report","file":"<repo-relative path>","outcome":"passed"|"failed"|"skipped",
//    "terminal":<bool>}   — one TERMINAL line per collected test item (outcome of its 'call'
//     phase, or of a 'setup' phase that skipped/failed before 'call' ever ran) PLUS, separately,
//     one non-terminal `"terminal":false` line for a 'teardown'-phase failure (a fixture cleanup
//     crash) — see _gate_ledger.py's own header for the full setup/call/teardown reasoning and
//     the empirical basis for exactly one terminal report per item.
//
// Same truncation-safety contract as parseLedgerEvents above (this repo's one incremental-JSONL
// convention, shared by both ledger halves via parseTruncationSafeJsonLines): the LAST split
// segment is unconditionally dropped — on a well-formed file that is the trailing '' after the
// final '\n'; on a file truncated mid-write (a SIGKILL between a JSON body and its trailing '\n')
// that is the truncated fragment itself. Either way, never trusted as evidence.
function foldPytestLedgerEvents(parsed, text) {
  const { collected, reported, failed, started, slowDeselected } = parsed;
  for (const obj of parseTruncationSafeJsonLines(text)) {
    if (!obj || typeof obj.file !== 'string' || typeof obj.type !== 'string') continue;
    if (obj.type === 'collect') {
      if (Number.isInteger(obj.count) && obj.count > 0) collected.set(obj.file, obj.count);
      continue;
    }
    if (obj.type === 'start') {
      // plan 3318: one line per file, the first time any of its items begins. Purely additive —
      // `greenPytestFiles` below does not read it, so an attempt written by an older plugin (no
      // `start` lines at all) behaves exactly as before.
      started.add(obj.file);
      continue;
    }
    if (obj.type === 'slow_deselect') {
      // plan 3318: one line per FILE this chunk-capped run dropped for being `slow`-marked.
      // Also purely additive, and also never a green/stall signal — it exists so the CALLER can
      // tell "this green covered the whole gate" from "this green covered the gate minus files a
      // capped run cannot finish", which decides whether the run may be pass-cached.
      slowDeselected.add(obj.file);
      continue;
    }
    if (obj.type === 'report') {
      if (typeof obj.outcome !== 'string') continue;
      if (obj.outcome === 'failed') failed.add(obj.file);
      if (obj.terminal === true) reported.set(obj.file, (reported.get(obj.file) ?? 0) + 1);
    }
  }
  return parsed;
}

export function parsePytestLedgerEvents(text) {
  return foldPytestLedgerEvents(
    {
      collected: new Map(), // file -> collected item count
      reported: new Map(), // file -> count of TERMINAL reports seen
      failed: new Set(), // file -> has at least one failed report, terminal or not
      started: new Set(), // file -> pytest began executing at least one of its items
      slowDeselected: new Set(), // file -> dropped this run for being `slow` under a chunk cap
    },
    text,
  );
}

// plan 3555: a cap KILL bypasses the controller's pytest_sessionfinish, so worker-private
// `<events>.<workerid>` streams are the only surviving proof. Discover the canonical path plus
// actual xdist worker siblings. This pattern is explicitly coupled to _gate_ledger.py's
// `self.events_path = f"{events_path}.{worker_id}"`: worker_id comes from
// config.workerinput["workerid"], which pytest-xdist always formats as gw<N>. If that scheme ever
// changes, this reader must change with it. The restriction also excludes unrelated sidecars and
// `_merge_worker_events()`'s `<events>.merge-<pid>.tmp` scratch file. Every lookup is best-effort
// because ledger close-out must never turn a decided push/land verdict into a blocker.
export function resolvePytestLedgerEventSources(canonicalPath) {
  if (typeof canonicalPath !== 'string' || canonicalPath.length === 0) return [];
  const dir = dirname(canonicalPath);
  const base = basename(canonicalPath);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const present = new Set(names);
  const sources = present.has(base) ? [canonicalPath] : [];
  const siblingPrefix = `${base}.`;
  for (const name of names.sort()) {
    if (!name.startsWith(siblingPrefix)) continue;
    const suffix = name.slice(siblingPrefix.length);
    if (/^gw[0-9]+$/.test(suffix)) sources.push(join(dir, name));
  }
  return sources;
}

export function readPytestLedgerEventSources(canonicalPath) {
  const sources = [];
  for (const path of resolvePytestLedgerEventSources(canonicalPath)) {
    try {
      sources.push({ path, text: readFileSync(path, 'utf8'), canonical: path === canonicalPath });
    } catch {
      // plan 3555: one unreadable worker must not discard proof flushed by its readable siblings.
    }
  }
  return sources;
}

export function combinePytestLedgerEventGroups(canonical, siblings) {
  const combined = {};
  // plan 3555 (delta review, guard-fires): iterate the UNION of both groups' field names, not just
  // the canonical group's. The two groups are produced by the same parser today, so their shapes
  // always match — but a field that ever appears only on the sibling side is worker-only evidence,
  // which is precisely the evidence a cap-killed run has and the canonical stream does not.
  // Keying the loop off `canonical` alone would drop exactly that.
  for (const name of new Set([...Object.keys(canonical), ...Object.keys(siblings)])) {
    const canonicalValues = canonical[name];
    const siblingValues = siblings[name];
    if (canonicalValues instanceof Map && siblingValues instanceof Map) {
      const values = new Map();
      for (const key of new Set([...canonicalValues.keys(), ...siblingValues.keys()])) {
        // The three reachable source states are explained below; max preserves their counts.
        values.set(key, Math.max(canonicalValues.get(key) ?? 0, siblingValues.get(key) ?? 0));
      }
      combined[name] = values;
    } else if (canonicalValues instanceof Set && siblingValues instanceof Set) {
      combined[name] = new Set([...canonicalValues, ...siblingValues]);
    } else {
      // Unknown evidence shapes must remain visible: a new field must be Map-/Set-shaped or add
      // an explicit combine rule here. Until then, carry the side that actually has a value rather
      // than drop the field — canonical wins a tie, and a field only the workers emitted still
      // survives (that asymmetry is the whole point on a cap-killed run).
      combined[name] = canonicalValues === undefined ? siblingValues : canonicalValues;
    }
  }
  return combined;
}

// plan 3555: parse every physical stream separately. Concatenating raw text would attach one
// worker's unterminated tail to the next worker's first record before truncation safety can drop
// it. The two source groups cover every reachable state: before a merge, direct canonical writes
// and worker proof are disjoint per file, so max equals the wanted sum; after a clean merge only
// canonical remains; and a kill inside the merge window leaves duplicate canonical/worker records,
// which max collapses to their single correct count. Worker siblings remain mutually disjoint by
// construction (one physical writer per worker), so they accumulate within their group.
export function parsePytestLedgerEventSources(sources) {
  const canonical = parsePytestLedgerEvents('');
  const siblings = parsePytestLedgerEvents('');
  for (const source of sources ?? []) {
    const group = typeof source === 'object' && source?.canonical ? canonical : siblings;
    foldPytestLedgerEvents(group, typeof source === 'string' ? source : source?.text);
  }
  return combinePytestLedgerEventGroups(canonical, siblings);
}

// plan 3620 fix round G2b (finding f64196): the pytest twin of countLedgerEvents above, over ONE
// physical stream. plan 3620 fix round H2 (findings b5a2f0/249e29/4d6fc9/a166e8/512b62/281bb3):
// COMPLETION evidence only — `collect` (a file was reached and its item count recorded) and a
// TERMINAL `report` (an item actually finished) — the EXACT class greenPytestFiles' own
// `collected`/`reported` maps already treat as "this file was proven" (foldPytestLedgerEvents only
// ever populates `reported` when `obj.terminal === true`; see that function's own header). `start`
// means a file BEGAN executing and proves nothing finished; `slow_deselect` means precisely that
// NO test from that file ran at all (a chunk-capped run dropping it as `slow`-marked) — counting
// either as ran-proven evidence pushes the push-side non-convergence bound's `ranProven` true on a
// round that banked nothing, the UNSAFE direction (toward a false accusation; see the DELIBERATE
// WONTFIX note just below this function, which now correctly describes both counters as
// COMPLETION-only). Mirrors the land side's own vocabulary:
// done-worktree.mjs's scoreChunkRound treats a slow-deselect-only round as a `healthyZero` that
// neither increments nor clears the counter — this counter must not manufacture positive evidence
// out of exactly that shape. A truncated final fragment is dropped by parseTruncationSafeJsonLines
// before this ever sees it, same as every other reader in this module.
function countWellFormedPytestEventsIn(text) {
  let n = 0;
  for (const obj of parseTruncationSafeJsonLines(text)) {
    if (!obj || typeof obj.file !== 'string' || typeof obj.type !== 'string') continue;
    if (obj.type === 'collect') {
      if (Number.isInteger(obj.count) && obj.count > 0) n += 1;
      continue;
    }
    if (obj.type === 'report' && typeof obj.outcome === 'string' && obj.terminal === true) n += 1;
  }
  return n;
}

// plan 3620 fix round G2b: summed across EVERY physical stream a canonical path resolves to —
// `sources` is a readPytestLedgerEventSources(canonicalPath) result (or a plain array of raw text
// strings, for a caller that already has the text) — so an xdist worker's own `<events>.gwN`
// sidecar counts too. Without this, a cap-killed xdist run's ONLY surviving proof (a worker's
// private stream — see resolvePytestLedgerEventSources' own header) would be invisible to the
// ran-proven check even though the canonical file legitimately has zero events of its own.
export function countPytestLedgerEvents(sources) {
  let n = 0;
  for (const source of sources ?? []) {
    n += countWellFormedPytestEventsIn(typeof source === 'string' ? source : source?.text);
  }
  return n;
}

// plan 3620 fix round — DELIBERATE WONTFIX (finding fe981b), pinned here so a later reader does
// not "fix" this into unsoundness: both counters above are COMPLETION-only evidence — they count
// events a writer actually flushed, so a run killed before its FIRST file finishes (a SIGKILL
// during collection, or mid-first-file, before any terminal report/collect line ever reached
// disk) counts as ZERO events, identical to a run that never started at all. That is the SAFE
// direction by construction: zero events ⇒ ran-proven false ⇒ this round is unscoreable ⇒ today's
// ordinary CHUNKED banner — a gate that was never given a chance to prove anything is never
// accused of non-convergence. The unsafe direction — a killed run somehow reading as ran-proven
// when it demonstrably completed nothing — is the one this module refuses to ever produce.

// plan 3318. The files this attempt STARTED that produced no terminal report at all — i.e. what
// pytest was executing when the chunk cap killed it. A cleanly-exited run reports every file it
// starts (every collected item emits exactly one terminal report — see parsePytestLedgerEvents'
// header), so this set is EMPTY unless the attempt was killed mid-file; that is what makes it a
// sound stall signal without the caller having to tell us it timed out.
//
// At most one file per attempt in practice (pytest executes files sequentially), but the shape is
// a set because nothing here depends on that being true.
//
// Truncation only ever costs a stall record: a `start` line lost to a SIGKILL mid-write is dropped
// by the truncation-safe parser, so that file simply keeps its old ordering next chunk. Never the
// other direction — a stall record can NEVER mark a file green, it only ever moves it LATER in the
// run order (see orderStalledLast).
export function stalledPytestFiles({ collected, reported, started }) {
  const out = new Set();
  if (!started) return out;
  for (const f of started) {
    // gpt-review (angle-A/B/C, simplification, efficiency, altitude — six finders, one defect):
    // the first cut required ZERO reports, which only catches a file killed before its FIRST test
    // finished. A big file that gets a few tests further into each chunk and dies partway records
    // no file-level green either (the ledger's unit is the FILE), so it is the SAME absorbing
    // state — just slower and completely invisible. `reported < collected` is the honest test.
    //
    // It also still excludes a RED file, which must NOT be deprioritized: a failing file reports a
    // terminal outcome for every collected item, so `reported === collected` and it never enters
    // this set. Pushing a genuine failure to the back of the run would report CHUNKED where the
    // truth is FAILED.
    //
    // A file with no `collect` line at all (truncation ate it) falls back to a threshold of 1,
    // i.e. the original zero-reports rule — unchanged behaviour for that case.
    const total = collected?.get(f);
    const seen = reported?.get(f) ?? 0;
    if (seen < (Number.isInteger(total) && total > 0 ? total : 1)) out.add(f);
  }
  return out;
}

// plan 3318. The files THIS attempt deselected because they are `slow`-marked and the run was
// chunk-capped (backend/scripts/_gate_ledger.py's `_slow_deselect`). Their presence means this
// run's green is NARROWER than the gate it was asked for, so its caller must not record it as a
// full-suite pass — see runPytestPreflight's own use in done-worktree.mjs and the
// PYTEST_CACHE_RECORDABLE downgrade in scripts/hooks/pre-push.sh.
export function slowDeselectedPytestFiles({ slowDeselected }) {
  return slowDeselected ?? new Set();
}

// E4's file-green definition, applied: a file is green iff pytest COLLECTED at least one item
// for it, the number of TERMINAL reports for that file equals the collected count exactly (never
// more — see parsePytestLedgerEvents' header on why over-counting cannot happen by construction;
// never less — a killed run's in-flight file necessarily falls short here), AND no report for
// that file — terminal or the separate teardown-failure signal — was ever a failure. A file
// entirely absent from `collected` (this run never got far enough to record its count, e.g. a
// SIGKILL landing during collection itself, before pytest_collection_finish ever ran) is
// therefore never green — it is simply absent from the returned set, not present-and-false.
export function greenPytestFiles({ collected, reported, failed }) {
  const green = new Set();
  for (const [file, count] of collected) {
    if (!failed.has(file) && (reported.get(file) ?? 0) === count) green.add(file);
  }
  return green;
}

// --- persistent per-key green set --------------------------------------------------------------

// The files already proven green under `key`, or an empty set on ANY doubt (absent, expired,
// corrupt, non-array `green`) — the fail-safe direction pass-cache-kernel.mjs's `isLive`/
// `readCacheEntry` already encode; this function adds no new failure mode on top of theirs.
export function readGreenSet(ledgerDir, key, nowMs, ttlMin = DEFAULT_TTL_MIN) {
  const entry = readCacheEntry(ledgerDir, key);
  if (!isLive(entry, nowMs, ttlMin)) return new Set();
  return new Set(Array.isArray(entry.green) ? entry.green : []);
}

// Union `newlyPassed` (repo-relative paths) into the persistent green set for `key`. A STALE
// (expired/corrupt/absent) existing entry is NEVER carried forward past its TTL — starting fresh
// from just `newlyPassed` in that case, not resurrecting old green files a clock says we can no
// longer trust (the same TTL discipline every other pass-cache-kernel consumer gets for free).
// No-op (no fs write at all) when there is nothing new to add — a merge call after a run that
// proved nothing new (everything already green, or everything failed) must not even touch the
// ledger's mtime/iso, since bumping `iso` would extend the TTL of files this run never re-proved.
//
// plan 3225 (Fix A, decision D2/D3): `head` is the ONE new field in the record shape — the HEAD
// COMMIT OID the green files were proven at, and the baseline a LATER key's carry-forward diffs
// against. It is only ever meaningful because both pass-caches refuse to key a DIRTY closure, so a
// state that produced a green is identical to HEAD for every keyed path and the commit oid fully
// describes it.
//
// PASSING IT IS THE CALLER'S PROOF, NOT A CONVENIENCE: a caller that cannot vouch that HEAD stayed
// put across its run passes nothing, and then any pre-existing `head` is DROPPED rather than left
// standing — the entry's green set now mixes files proven at two different commits, so no single
// commit describes it and the entry must stop being delta-eligible. An entry with no `head` simply
// never becomes a baseline (see findCarryForwardBaseline) ⇒ full run, the fail direction this whole
// module already encodes everywhere else.
export function mergeGreenFiles(
  ledgerDir,
  key,
  newlyPassed,
  nowMs,
  ttlMin = DEFAULT_TTL_MIN,
  { head, durations } = {},
) {
  if (!newlyPassed || newlyPassed.size === 0) return;
  const existing = readGreenSet(ledgerDir, key, nowMs, ttlMin);
  // plan 4236 T5: the last wall time per file — this write's durations over the carried ones.
  const mergedDurations = { ...readDurations(ledgerDir, key, nowMs, ttlMin) };
  for (const [f, ms] of Object.entries(durations ?? {}))
    if (typeof f === 'string' && f && Number.isFinite(ms) && ms >= 0) mergedDurations[f] = ms;
  const merged = new Set(existing);
  for (const f of newlyPassed) merged.add(f);
  writeCacheEntry(ledgerDir, key, {
    iso: new Date(nowMs).toISOString(),
    green: [...merged].sort(),
    // Written ONLY when the caller vouched for it; otherwise deliberately absent, which drops
    // whatever the prior entry carried (writeCacheEntry replaces the whole record).
    ...(isCommitOid(head) ? { head } : {}),
    // plan 3318: `writeCacheEntry` replaces the WHOLE record, so a green merge would otherwise
    // silently erase the stall counts a previous chunk recorded — and with them the ordering that
    // is the whole point of tracking them. Carried explicitly; a file that has since gone green is
    // left in the map harmlessly (it is subtracted from the remainder before ordering ever sees
    // it) rather than pruned here, so this stays a pure carry with no second definition of green.
    ...carriedStalls(ledgerDir, key, nowMs, ttlMin),
    // plan 3374: the consecutive zero-progress round counter rides the SAME carry rule, and for
    // the same reason — `writeCacheEntry` replaces the whole record, so a green merge landing
    // between two zero rounds would reset the count to 0 and the non-convergence seam could never
    // reach its threshold. Carried, never recomputed here: only recordChunkRound decides it.
    ...carriedZeroRounds(ledgerDir, key, nowMs, ttlMin),
    // plan 3620: the push-side counter's own fingerprint, carried the same way — see
    // carriedGreenMark's own header for why dropping it here would make the bound unreachable.
    ...carriedGreenMark(ledgerDir, key, nowMs, ttlMin),
    ...(Object.keys(mergedDurations).length > 0 ? { durations: mergedDurations } : {}),
  });
}

// plan 4236 T5 — the per-file LAST wall time (ms) recorded under `key`, or `{}` on any doubt (same
// fail-safe shape as readStallCounts). Data only: no consumer reads it to decide anything yet — it
// exists so the heavy-single-file question (plan 4234 Task 3(a), closed pending data) has numbers.
export function readDurations(ledgerDir, key, nowMs, ttlMin = DEFAULT_TTL_MIN) {
  const entry = readCacheEntry(ledgerDir, key);
  if (!isLive(entry, nowMs, ttlMin)) return {};
  const raw = entry.durations;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [f, ms] of Object.entries(raw)) {
    if (typeof f === 'string' && f && Number.isFinite(ms) && ms >= 0) out[f] = ms;
  }
  return out;
}

// plan 4236 T5 — the durations twin of carriedStalls: every whole-record writer carries the map so
// a stall write or a zero-round write never erases it.
function carriedDurations(ledgerDir, key, nowMs, ttlMin) {
  const durations = readDurations(ledgerDir, key, nowMs, ttlMin);
  return Object.keys(durations).length > 0 ? { durations } : {};
}

// plan 3318 — the shared "keep whatever stalls the live entry already had" spread, so
// mergeGreenFiles and mergeStalledFiles cannot drift on the record shape. `{}` (the key absent
// entirely) whenever there is nothing live to carry, which is what every pre-3318 entry looks
// like: an absent `stalls` reads as "no file has stalled", the direction that changes no ordering.
function carriedStalls(ledgerDir, key, nowMs, ttlMin) {
  const stalls = readStallCounts(ledgerDir, key, nowMs, ttlMin);
  return Object.keys(stalls).length > 0 ? { stalls } : {};
}

// plan 3374 — the zero-round twin of carriedStalls above, so mergeGreenFiles, mergeStalledFiles and
// recordChunkRound cannot drift on the record shape. `{}` (the key absent entirely) whenever there
// is nothing live to carry, which is what every pre-3374 entry looks like: an absent `zeroRounds`
// reads as "no round has proven zero", the direction that fires no seam.
function carriedZeroRounds(ledgerDir, key, nowMs, ttlMin) {
  const n = readZeroRounds(ledgerDir, key, nowMs, ttlMin);
  return n > 0 ? { zeroRounds: n } : {};
}

// plan 3620 (push-side non-convergence bound) — the `greenMark` twin of carriedStalls/
// carriedZeroRounds above, and for the identical reason: writeCacheEntry replaces the WHOLE
// record, so a green merge or a stall write landing BETWEEN two `chunk-round` CLI calls must not
// silently erase the banked-set fingerprint the second call compares against — that fingerprint
// (not the round count itself) is what scoreChunkRoundByGreenMark's "did this round bank anything
// new" question is answered from. Dropping it would make every round look like "no previous
// mark", which this module's own first-round rule reads as progress — the counter could then
// never reach NON_CONVERGENT_ROUNDS, exactly the failure class carriedStalls/carriedZeroRounds
// already exist to prevent for their own fields. `{}` (absent) whenever there is nothing live to
// carry, matching every entry written before this plan.
function carriedGreenMark(ledgerDir, key, nowMs, ttlMin) {
  const entry = readCacheEntry(ledgerDir, key);
  if (!isLive(entry, nowMs, ttlMin)) return {};
  return typeof entry.greenMark === 'string' ? { greenMark: entry.greenMark } : {};
}

// The per-file stall counts already recorded under `key`, or `{}` on ANY doubt — same fail-safe
// shape as readGreenSet above (absent, expired, corrupt, non-object `stalls`, a non-positive or
// non-integer count). Doubt here means "this file has never stalled", i.e. today's ordering.
export function readStallCounts(ledgerDir, key, nowMs, ttlMin = DEFAULT_TTL_MIN) {
  const entry = readCacheEntry(ledgerDir, key);
  if (!isLive(entry, nowMs, ttlMin)) return {};
  const raw = entry.stalls;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [f, n] of Object.entries(raw)) {
    if (typeof f === 'string' && f && Number.isInteger(n) && n > 0) out[f] = n;
  }
  return out;
}

// plan 3318. Record one more stall for each file in `stalled`, leaving the green set untouched.
//
// THE TTL IS NEVER EXTENDED BY THIS WRITE. A stall proves nothing green, so bumping `iso` would
// extend the life of greens this attempt never re-proved — the exact hazard mergeGreenFiles' own
// header names for its no-op-on-empty rule. The live entry's `iso`/`green`/`head` are carried
// through byte-for-byte; only a STALE-or-absent entry gets a fresh `iso`, and then with an empty
// green set, which claims nothing.
export function mergeStalledFiles(ledgerDir, key, stalled, nowMs, ttlMin = DEFAULT_TTL_MIN) {
  if (!stalled || stalled.size === 0) return;
  const entry = readCacheEntry(ledgerDir, key);
  const live = isLive(entry, nowMs, ttlMin);
  const stalls = live ? readStallCounts(ledgerDir, key, nowMs, ttlMin) : {};
  for (const f of stalled) stalls[f] = (stalls[f] ?? 0) + 1;
  writeCacheEntry(ledgerDir, key, {
    iso: live && typeof entry.iso === 'string' ? entry.iso : new Date(nowMs).toISOString(),
    green: live && Array.isArray(entry.green) ? entry.green : [],
    ...(live && isCommitOid(entry.head) ? { head: entry.head } : {}),
    stalls,
    // plan 3374: same whole-record carry rule as mergeGreenFiles' own — a stall write must not
    // erase the zero-round count either. Only live entries carry it (a STALE entry's whole record
    // is being replaced with a fresh, claim-nothing one, and a resurrected counter would then be
    // measuring rounds against a ledger that no longer remembers what they proved).
    ...(live ? carriedZeroRounds(ledgerDir, key, nowMs, ttlMin) : {}),
    // plan 3620: the same carry, for the same reason, applied to the push-side fingerprint.
    ...(live ? carriedGreenMark(ledgerDir, key, nowMs, ttlMin) : {}),
    ...(live ? carriedDurations(ledgerDir, key, nowMs, ttlMin) : {}),
  });
}

// --- plan 3374: consecutive zero-progress chunk rounds -----------------------------------------
//
// THE PROBLEM this closes. A chunk-capped gate that cannot finish a single over-wall file proves
// zero new files every round and still reports `CHUNKED — re-invoke to continue`, indistinguishable
// from healthy chunking. Measured on plan 3284 (2026-08-22): green frozen at 153/925 under key
// e087a779ed667038cddb119d51bee378, rounds 2-8 each proving nothing, the gate never converging and
// never saying so. `orderStalledLast` (plan 3318) makes the remainder RETIRE in the right order but
// cannot help once only the over-wall file is left — at that point the loop is genuinely infinite
// and the only honest move is to stop and name the file.
//
// WHY A PERSISTED COUNTER. Each round is a SEPARATE `done-worktree.mjs` process, so nothing in
// memory survives between them. The count rides the per-key ledger record — the one thing that is
// already content-keyed, already TTL'd, and already carried across invocations for exactly this
// gate.
//
// The count is CONSECUTIVE: any round that proves at least one new file clears it (decision D1 on
// the plan — a single zero round is not proof, several healthy shapes produce one).
export const NON_CONVERGENT_ROUNDS = 2;

// The consecutive zero-progress round count recorded under `key`, or 0 on ANY doubt (absent,
// expired, corrupt, non-integer, non-positive) — the same fail-safe shape readGreenSet and
// readStallCounts already use. Doubt here means "this gate has never proven nothing", i.e. no seam.
export function readZeroRounds(ledgerDir, key, nowMs, ttlMin = DEFAULT_TTL_MIN) {
  const entry = readCacheEntry(ledgerDir, key);
  if (!isLive(entry, nowMs, ttlMin)) return 0;
  const n = entry.zeroRounds;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// Record the outcome of ONE chunk-capped round that actually ran, returning the resulting
// consecutive zero-progress count. `progressed` true clears it; false increments it.
//
// THE TTL IS NEVER EXTENDED BY THIS WRITE — identical reasoning to mergeStalledFiles above: a
// zero-progress round proves nothing green, so bumping `iso` would extend the life of greens this
// attempt never re-proved. The live entry's `iso`/`green`/`head`/`stalls` are carried through
// byte-for-byte.
//
// A STALE-or-absent entry cannot host a count: there is no live green set for a round to have made
// progress against, so the answer is 0 and NOTHING is written (a fresh record here would claim a
// TTL window for an empty green set, and the next round would read a counter that has no ledger
// behind it). Callers see 0 and report the ordinary CHUNKED outcome — today's behaviour.
//
// plan 3620: `greenMark` is an OPTIONAL fifth-argument field — omitted (the default, every
// pre-3620 caller), the write simply carries forward whatever mark the record already had, byte-
// for-byte, exactly as it already carries `stalls`/`head`. Passed, it SETS the mark on this same
// write — scoreChunkRoundByGreenMark's own caller, below, is the only place that ever does.
export function recordChunkRound(
  ledgerDir,
  key,
  progressed,
  nowMs,
  ttlMin = DEFAULT_TTL_MIN,
  { greenMark } = {},
) {
  const next = progressed ? 0 : readZeroRounds(ledgerDir, key, nowMs, ttlMin) + 1;
  writeZeroRounds(ledgerDir, key, next, nowMs, ttlMin, { greenMark });
  return next;
}

// Drop any tally under `key`, leaving the rest of the record untouched. Called when the gate came
// back GREEN: the round proved the gate converges, so a count left standing would be inherited by a
// LATER chunked land under the same content key and push it over the threshold on a single zero
// round (gpt-review d7b751 — only zero rounds used to write the counter, so nothing ever cleared it
// once the gate stopped stalling).
export function clearChunkRounds(ledgerDir, key, nowMs = Date.now(), ttlMin = DEFAULT_TTL_MIN) {
  if (readZeroRounds(ledgerDir, key, nowMs, ttlMin) === 0) return; // nothing to clear, no write
  writeZeroRounds(ledgerDir, key, 0, nowMs, ttlMin);
}

// The ONE writer for the zero-round field, so recordChunkRound and clearChunkRounds cannot drift on
// the record shape (gpt-review d09e81 — three writers were each rebuilding the record by hand, the
// same class of omission that made the `stalls`/`zeroRounds` carries necessary in the first place).
//
// A STALE-or-absent entry is CREATED rather than skipped (gpt-review 304375/2da600): the ledger
// entry is otherwise only ever minted by a green merge, so a gate whose very first chunk-capped
// round proved nothing had nowhere to keep a tally — and the purest non-convergent case of all, a
// gate that never proves anything, could never reach the threshold. Creating it is safe precisely
// because the record claims NOTHING: an empty `green` means every reader still sees "nothing proven
// under this key", and with no `head` the entry can never become a carry-forward baseline.
//
// THE TTL IS NEVER EXTENDED FOR A LIVE ENTRY. A zero-progress round proves nothing green, so
// reusing the live entry's own `iso` is what stops this write from extending the life of greens the
// round never re-proved — the same discipline mergeStalledFiles documents. Only an
// absent/stale entry gets a fresh `iso`, and then its green set is empty, which claims nothing.
// plan 3620: `greenMark` (optional) is the push-side fingerprint to SET on this write. When
// omitted (every pre-3620 caller, and clearChunkRounds below), whatever mark the live entry
// already carries rides through unchanged — the same "carry unless told otherwise" rule
// carriedStalls/carriedZeroRounds already apply to their own fields, just inlined here since this
// IS the one writer those two helpers themselves call through.
function writeZeroRounds(ledgerDir, key, n, nowMs, ttlMin, { greenMark } = {}) {
  const entry = readCacheEntry(ledgerDir, key);
  const live = isLive(entry, nowMs, ttlMin);
  const carriedMark = live && typeof entry.greenMark === 'string' ? entry.greenMark : undefined;
  const mark = greenMark !== undefined ? greenMark : carriedMark;
  writeCacheEntry(ledgerDir, key, {
    iso: live && typeof entry.iso === 'string' ? entry.iso : new Date(nowMs).toISOString(),
    green: live && Array.isArray(entry.green) ? entry.green : [],
    ...(live && isCommitOid(entry.head) ? { head: entry.head } : {}),
    ...(live ? carriedStalls(ledgerDir, key, nowMs, ttlMin) : {}),
    ...(live ? carriedDurations(ledgerDir, key, nowMs, ttlMin) : {}),
    ...(mark !== undefined ? { greenMark: mark } : {}),
    // Absent rather than `0` when cleared — an absent field is what every pre-3374 entry looks
    // like, so the cleared state and the never-counted state are the SAME state on disk.
    ...(n > 0 ? { zeroRounds: n } : {}),
  });
}

// --- plan 3620: push-side non-convergence bound, scored by BANKED-SET FINGERPRINT --------------
//
// THE PROBLEM this closes. The land side (plan 3374, above) can compare "this round's own green
// set" against "the green set before this round ran" because ONE process (done-worktree.mjs)
// observes both ends of a round and can pass `roundGreen`/`greenBefore` in as arguments. The push
// hook has no such single observer: `scripts/hooks/pre-push.sh` is a NEW shell process per push,
// and the file-level pass/fail events for THIS round are already gone (merged into the ledger and
// discarded) by the time a chunk-report banner is built. What survives across rounds is only the
// ledger's own persisted green SET for the key — so the push side scores progress by comparing
// consecutive snapshots of that set instead of consecutive round-local proofs.
//
// THE FINGERPRINT. A deterministic, order-independent digest of the green set's file list: sort
// the relative paths (a Set's own iteration order is insertion order, not a stable content
// property), join with '\n', sha256, hex. Two rounds with the SAME banked set — byte for byte,
// regardless of the order files were proven in — always fingerprint identically; ANY new file
// changes it. `fingerprintGreenSet` never inspects the CALLER's key or wall-clock, only the set
// handed to it, so it is trivially testable on its own.
export function fingerprintGreenSet(green) {
  const sorted = [...green].sort();
  return createHash('sha256')
    .update(`${sorted.length}\n${sorted.join('\n')}`)
    .digest('hex');
}

// plan 3620 fix round G3 (findings 61b1db/66424a/5d153e/bac162/4027c7): the `chunk-round`/
// `pytest-chunk-round` CLI's machine-readable SENTINEL name — the LAST line those two subcommands
// print is exactly `${CHUNK_ROUND_NONCONVERGENT_SENTINEL}=1` or `=0`, nothing else on that line.
// Exported so scripts/hooks/pre-push.sh's own header comment and its name-paired test
// can spell the identical literal rather than a second hand-typed copy that could drift from what
// this CLI actually emits. Replaces the pre-fix hook's glob match against the compact-JSON line
// itself (`case … in '{"rounds":'*'"nonConvergent":true'*'}')`) — a shape/substring GUESS that its
// own comment overclaimed as "validates the full grammar" — with a line the hook can test for
// EXACT STRING EQUALITY, no parsing, no substring risk from a stray line elsewhere in captured
// stdout.
export const CHUNK_ROUND_NONCONVERGENT_SENTINEL = 'PREPUSH_CHUNK_ROUND_NONCONVERGENT';

// Score ONE chunk-capped round by comparing the green set's CURRENT fingerprint against the mark
// the PREVIOUS `chunk-round`/`pytest-chunk-round` CLI call left on the same ledger record —
// intended to run immediately after this round's own `merge`/`pytest-merge` call has already
// folded whatever it proved into the persistent green set, so the fingerprint here reflects this
// round's full contribution.
//
// `ranProven` (plan 3620 fix round, F1 — nine review findings: 3ac118/ad0ab2/17d6ec/b2e534/
// 86bbdd/e89db9/f498b6/529627/cd79c4) GATES all of the below. It mirrors done-worktree.mjs's own
// scoreChunkRound `ranProven` contract verbatim: "a round that spent its entire budget queueing,
// executing not one test, arrived here looking exactly like a non-convergent one; two of those in
// a row would have accused a gate that was never given a chance. `ranProven` is the CALLER's
// positive evidence that the gate really executed (its own collection/report events), and every
// doubt lands here". This function NEVER re-derives that evidence itself — it only trusts what
// scripts/hooks/pre-push.sh's two RAN-AND-CHUNKED seats vouch for, the one place that still holds
// the raw per-attempt reporter output by the time a round is scored. Anything short of strictly
// `true` is UNSCOREABLE and short-circuits before any of the THREE CASES below are even reached.
//
// THREE CASES, in the order this function decides them (reached only once `ranProven === true`
// and neither `green` nor `greenMark` on the raw ledger entry is malformed — see F4 below):
//   1. No mark recorded yet under this key (this is the FIRST chunk round ever scored here) AND
//      the green set is non-empty: `progressed = true`. There is nothing to compare against, so
//      this is not evidence of stalling — treating an unscoreable first round as non-convergent
//      would fire the seam on ordinary healthy chunking (round 1 always "has no history").
//   2. No mark recorded yet AND the green set is EMPTY: `progressed = false`. A gate whose very
//      first chunk-capped round proves nothing is exactly the purest non-convergent case there
//      is — the same reasoning writeZeroRounds' own header gives for CREATING a fresh record
//      here rather than skipping it (a gate that never converges must eventually be reachable by
//      the threshold, not permanently exempted for lacking a first "before" snapshot). This case
//      is reachable ONLY for a genuinely, well-formed empty green set — a CORRUPT one is caught
//      by the F4 malformed check below and never reaches here.
//   3. A mark IS recorded: `progressed = (fingerprint !== storedMark)` — the ordinary case.
//
// UNSCOREABLE is the SAME returned shape everywhere it applies (`ranProven` false/absent, F4's
// malformed `green`/`greenMark`, or any fs/JSON failure): `{rounds: 0, progressed: true,
// nonConvergent: false, ranProven: false, green: <best-effort current count>}`, and — critically —
// NOTHING is written to the ledger (`recordChunkRound` is never reached on any of those paths), so
// an unscoreable round can never disturb the tally or the fingerprint a later round compares
// against.
//
// FAIL-SAFE BY CONSTRUCTION: every fs/JSON failure below (a corrupt ledger entry, an unwritable
// dir) is already absorbed by readGreenSet/readCacheEntry/recordChunkRound's own fail-safe
// primitives — none of them throw. The try/catch is belt-and-suspenders should a future edit to
// any of those primitives ever change that, so this function can NEVER itself become the reason a
// push is blocked: any doubt degrades to today's ordinary CHUNKED behaviour.

// plan 3620 fix round G6 (finding 7ccf82): a raw READ FAILURE — an fs error other than "the file
// does not exist", or content that fails to parse as the kernel's own entry shape — is NOT the
// same fact as "no entry has ever been written under this key", even though pass-cache-kernel.mjs's
// own readCacheEntry (by design, for ITS OWN callers — see that module's documented FAIL
// DIRECTION) collapses both to the identical `null`. For every OTHER pass-cache consumer that is
// exactly the right answer: a corrupt entry ⇒ MISS ⇒ the gated work simply runs again, no state is
// lost because none was ever kept for it. This function is different: cases 1/2 below WRITE a
// fresh record on "no entry yet" (via recordChunkRound), and writeCacheEntry REPLACES the whole
// record — so scoring a transient read glitch as "no entry yet" would silently discard whatever
// real green set / fingerprint / round tally a LIVE entry actually held, on nothing more than one
// flaky read. Distinguished here, LOCALLY (no change to pass-cache-kernel.mjs's own contract,
// which stays correct for its other callers): ENOENT is the one error that unambiguously means
// "this key has never been written", and is the only one folded into the ordinary
// never-recorded-yet path below; every other read or parse failure sets `readFailed`, which routes
// to the SAME unscoreable answer as F4/G4/G5's malformed checks — write nothing, degrade to
// today's ordinary CHUNKED answer.
//
// Exported (unlike this section's other private helpers) so battery-ledger.test.mjs can pin the
// ENOENT/EISDIR/corrupt-JSON/well-formed distinction directly, without needing every case to
// survive a full scoreChunkRoundByGreenMark round-trip (whose own write step can, for some error
// shapes, throw and be masked by that function's outer try/catch — a real but different safety
// net than this diagnostic's own readFailed flag).
export function readLedgerEntryDiagnostic(ledgerDir, key) {
  let text;
  try {
    text = readFileSync(entryPath(ledgerDir, key), 'utf8');
  } catch (e) {
    return { entry: null, readFailed: e?.code !== 'ENOENT' };
  }
  const entry = parseEntry(text);
  return { entry, readFailed: entry === null };
}

export function scoreChunkRoundByGreenMark({
  ledgerDir,
  key,
  nowMs,
  ttlMin = DEFAULT_TTL_MIN,
  ranProven,
}) {
  try {
    if (ranProven !== true) {
      return {
        rounds: 0,
        progressed: true,
        nonConvergent: false,
        ranProven: false,
        green: readGreenSet(ledgerDir, key, nowMs, ttlMin).size,
      };
    }
    // plan 3620 fix round F4 (finding 3a9a30): readGreenSet's OWN fail-safe (pass-cache-kernel's
    // isLive/readCacheEntry contract) already collapses a CORRUPT `entry.green` (present but not
    // an array) to an empty Set — byte-for-byte indistinguishable from a genuinely-empty,
    // well-formed green set, which case 2 above reads as the purest non-convergent case there is.
    // Left alone, ledger corruption could manufacture a false NON_CONVERGENT out of a record that
    // never actually proved anything either way. So malformed `green`/`greenMark` are diagnosed
    // HERE, directly off the raw entry (never through readGreenSet's own silent degrade), and
    // routed to the exact same unscoreable answer as ranProven:false above — together, never
    // separately, because either one alone already means this record cannot be trusted to answer
    // whether progress happened. An ABSENT field is NOT malformed (that is the ordinary
    // "never-recorded-yet" case cases 1/2 already handle) — only a PRESENT value of the wrong
    // type is.
    const { entry: rawEntry, readFailed } = readLedgerEntryDiagnostic(ledgerDir, key);
    const rawLive = isLive(rawEntry, nowMs, ttlMin);
    // plan 3620 fix round G4 (findings 99f5d3/d75bef/8cd8fd/2758e7/65f5da/0d2b3c): malformed is not
    // just "green present but not an array" — an array carrying a non-string or empty-string
    // MEMBER is exactly as untrustworthy, and letting a member-corrupt array through here is
    // precisely how it could bypass this guard and then be REWRITTEN verbatim by this same
    // function's own write (writeZeroRounds carries the live entry's `green` through byte-for-byte
    // on every write scoreChunkRoundByGreenMark makes). Only a well-formed array — every member a
    // non-empty string — is left un-flagged, including the genuinely-empty array (case 2's own
    // legitimate shape).
    const greenMalformed =
      rawLive &&
      'green' in rawEntry &&
      (!Array.isArray(rawEntry.green) ||
        !rawEntry.green.every((f) => typeof f === 'string' && f.length > 0));
    // plan 3620 fix round G5 (finding eb0645): a `greenMark` is only ever meaningful as a sha256
    // hex digest — fingerprintGreenSet's own output shape — so it is validated AS a fingerprint,
    // not merely as "some string". A present-but-wrong-shaped value is corruption, same bucket as
    // greenMalformed above.
    //
    // plan 3620 fix round H3 (findings 07d2b1/f0bbd3): the bare regex `.test()` COERCES its
    // argument to a string first, and a one-element array whose sole member is already a
    // well-formed 64-hex string coerces to exactly that string (`String(['abc']) === 'abc'`) —
    // so `['<64 hex chars>']` silently PASSED this check before the explicit `typeof` guard below.
    // The comment this replaced claimed the regex alone "catches" a non-string value; it catches a
    // STRING-COERCIBLE-TO-GARBAGE value, not every non-string shape. `typeof === 'string'` first,
    // then the shape check, is the same two-step every other fingerprint validator in this module
    // (`isCommitOid`) already uses.
    const markMalformed =
      rawLive &&
      'greenMark' in rawEntry &&
      (typeof rawEntry.greenMark !== 'string' || !/^[0-9a-f]{64}$/.test(rawEntry.greenMark));
    if (readFailed || greenMalformed || markMalformed) {
      return {
        rounds: 0,
        progressed: true,
        nonConvergent: false,
        ranProven: false,
        green: readGreenSet(ledgerDir, key, nowMs, ttlMin).size,
      };
    }
    const green = readGreenSet(ledgerDir, key, nowMs, ttlMin);
    const mark = fingerprintGreenSet(green);
    const storedMark =
      rawLive && typeof rawEntry.greenMark === 'string' ? rawEntry.greenMark : undefined;
    const progressed = storedMark === undefined ? green.size > 0 : mark !== storedMark;
    const rounds = recordChunkRound(ledgerDir, key, progressed, nowMs, ttlMin, {
      greenMark: mark,
    });
    return {
      rounds,
      progressed,
      nonConvergent: rounds >= NON_CONVERGENT_ROUNDS,
      ranProven: true,
      green: green.size,
    };
  } catch {
    // Today's ordinary CHUNKED answer — see this function's own header.
    return { rounds: 0, progressed: true, nonConvergent: false, ranProven: false, green: 0 };
  }
}

// plan 3318. The remainder, reordered so files a previous chunk started-but-never-finished run
// LAST — least-stalled first among those, then by path so the order is deterministic.
//
// This is the whole convergence fix: without it, a file whose wall exceeds the chunk wall keeps
// whatever position collection gave it, and every chunk re-enters it and proves nothing (measured
// three times, green frozen at 152-153/925). With it, each chunk retires files it CAN finish and
// the proven count strictly increases until only the over-wall file is left — which is then the
// one thing the CHUNKED report has to name.
//
// Never affects what counts as proven — only what runs first.
export function orderStalledLast(remainder, stalls) {
  const fast = [];
  const slow = [];
  for (const f of remainder) ((stalls?.[f] ?? 0) > 0 ? slow : fast).push(f);
  slow.sort((a, b) => stalls[a] - stalls[b] || (a < b ? -1 : a > b ? 1 : 0));
  return [...fast, ...slow];
}

// --- delta-scoped carry-forward (plan 3225, Fix A) ---------------------------------------------
//
// THE PROBLEM (plan 3225 § Problem 1): the pass-caches are all-or-nothing by content key, so ANY
// change — even three test files — is a MISS, and the land preflight re-proves the WHOLE gate.
// 3223's ledger already knows how to subtract "files already proven green under THIS key"; the only
// thing missing was a way to carry a PREVIOUS key's greens across a small delta. That is all this
// section does: find the last green, name what changed since it, ask the gate's OWN selector which
// tests that change can reach, and seed the new key's ledger with everything the selector did NOT
// name. The run/skip decision, the "full coverage of the original selection ⇒ gate green" rule, and
// both preflights' short-circuits are untouched — they just see a ledger that already knows more.
//
// FAIL DIRECTION, unchanged from the rest of this module: EVERY doubt — no baseline, no `head`, a
// git failure, a selector that says FULL or crashes, a delta path the selector does not map — means
// "seed nothing", i.e. today's full run. Nothing here can cause a file to be skipped that was not
// already proven green at a commit whose delta to HEAD the selector claims cannot reach it.

// A git commit oid, as `git rev-parse HEAD` prints it. Deliberately its own predicate rather than
// reusing battery-pass-cache's `looksLikeOid` (which accepts 4-40 chars, because it validates an
// operator-pinned SHORT merge-base): a baseline written by our own callers is always the full
// 40-char form, and accepting an abbreviation here would let a truncated/garbled value resolve to
// a DIFFERENT commit than the one that was proven.
export function isCommitOid(s) {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

// The newest LIVE ledger entry, other than `excludeKey`, that can serve as a delta baseline: it
// must carry a `head` (a run vouched for it) and a non-empty green set (there is something to
// carry). Newest by `iso` — the closest baseline yields the smallest delta, hence the tightest
// selection. Returns `{ key, head, green: Set }` or null.
//
// Bounded by construction: the ledger dir holds one entry per content key seen inside the TTL, and
// this scan runs ONLY on a pass-cache miss, never on the hot hit path.
export function findCarryForwardBaseline(ledgerDir, excludeKey, nowMs, ttlMin = DEFAULT_TTL_MIN) {
  let names;
  try {
    names = readdirSync(ledgerDir).filter((n) => n.endsWith('.json'));
  } catch {
    return null; // no ledger dir yet — nothing to carry, run everything
  }
  let best = null;
  for (const name of names) {
    const k = name.replace(/\.json$/, '');
    if (k === excludeKey || !/^[0-9a-f]{32}$/.test(k)) continue;
    const entry = readCacheEntry(ledgerDir, k);
    if (!isLive(entry, nowMs, ttlMin)) continue; // TTL honored — an expired green is never a baseline
    if (!isCommitOid(entry.head) || !Array.isArray(entry.green) || entry.green.length === 0)
      continue;
    if (!best || entry.iso > best.iso) best = { key: k, head: entry.head, iso: entry.iso };
  }
  if (!best) return null;
  return {
    key: best.key,
    head: best.head,
    green: readGreenSet(ledgerDir, best.key, nowMs, ttlMin),
  };
}

// Repo-relative paths that differ between two commits. `null` on ANY git trouble — including the
// baseline commit no longer being reachable (a pruned object, a re-clone), which is precisely a
// case where we must not pretend to know what changed.
export function changedFilesBetween(git, fromOid, toRef = 'HEAD') {
  let out;
  try {
    out = git(['diff', '--name-only', fromOid, toRef]);
  } catch {
    return null;
  }
  return String(out)
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim())
    .filter(Boolean);
}

// --- D4: closure paths the selectors do not map -------------------------------------------------
//
// A gate's KEY CLOSURE (what moves its cache key) is WIDER than what its test SELECTOR maps. At the
// push tier that gap is absorbed by the hook: `_select_tests.py` is fed a list pre-grepped to
// `^backend/scripts/`, and `select-battery-tests.mjs` never looks at `pnpm-lock.yaml` at all. The
// LAND tier must not be MORE trusting than the push tier, so a delta touching a closure path the
// selector cannot reason about forces a full run (plan 3225's own clause 3, "a file outside its
// mapping"). Everything the selectors DO map keeps their own existing fallbacks — touchesExternalTree,
// hasNestedScriptChange, unclaimed-file ⇒ FULL, the 40%-subset cap — reused as-is, never re-rolled.

// The battery key's closure is `keyedPaths()`: the scripts tree (or its per-selection closure),
// every EXTERNAL_TREE_PREFIXES entry, and `pnpm-lock.yaml`. select-battery-tests.mjs bails on the
// first two by itself; the lockfile is the whole remainder, and battery-ledger.test.mjs pins that
// derivation against `keyedPaths()` so a future closure widening cannot silently slip past here.
export const BATTERY_UNMAPPED_CLOSURE = Object.freeze(['pnpm-lock.yaml']);

// The pytest gate's closure, straight off the registry entry the land preflight actually keys on.
// Caller-injected (plan 4071 D5): `gates` is `gatesFrom(coordConfig)`, built once by `main()`
// below; an absent 'pytest-backend-scripts' entry (a config-less checkout) degrades to an empty
// closure rather than throwing — every reader of this list already treats "nothing in it" as
// "nothing to trigger on".
export function pytestClosureFor(gates) {
  return Object.freeze([...(gates['pytest-backend-scripts']?.paths ?? [])]);
}
// The one prefix `_select_tests.py` maps (its own GATE_PREFIX — every other path on its stdin is
// silently dropped, which is exactly why a delta carrying one must not be scoped here) and the
// script's own repo-relative path — both used to be hardcoded here; plan 4071 E-A moved them
// behind coord.config.json's `pytestSelector.{prefix,script}` (empty core default `{ prefix:
// null, script: null }`). CALLER-INJECTED, not self-resolved (plan 4071 Rule 1): `main()` — the
// CLI entry point — resolves the config once and passes `prefix` to `unmappedClosurePaths` and
// `script` to `runPytestSelector` below; a caller with neither degrades to "cannot scope, run
// everything" (`unmappedClosurePaths`' own `mappedPrefix &&` guard; `runPytestSelector`'s own
// `if (!script) return null`), never a crash on an absent key.

// Delta paths that fall inside `closure` but outside `mappedPrefix` — non-empty ⇒ cannot scope.
// Containment is gate-pass-cache's OWN exported `pathCovers` (review finding): this module already
// imports from that file for GATES, so a second hand-rolled copy of the one-line predicate bought
// nothing and could only drift away from the definition the gate keys itself on.
export function unmappedClosurePaths(delta, closure, mappedPrefix) {
  return delta.filter(
    (p) => closure.some((c) => pathCovers(c, p)) && !(mappedPrefix && p.startsWith(mappedPrefix)),
  );
}

// --- the selectors, invoked as the CLIs they are ------------------------------------------------

// `scripts/select-battery-tests.mjs` over the delta. Returns the selected test set, or null for
// "run the full battery" (its EXIT_RUN_FULL, a crash, or empty output).
//
// The CLI is the SPINE's own copy (`import.meta.dirname`), like every other tool done-worktree
// reaches for, while `cwd` is the worktree — the module only ever resolves `scripts/` relative to
// cwd, so the trusted code reads the worktree's real test tree. A stale worktree copy could
// UNDER-select, which is the one direction that would be unsound.
export function runBatterySelector(
  delta,
  {
    _spawn = spawnSync,
    cwd = process.cwd(),
    cli = join(import.meta.dirname, 'select-battery-tests.mjs'),
    timeoutMs = 120_000,
  } = {},
) {
  let r;
  try {
    r = _spawn(process.execPath, [cli], {
      cwd,
      input: `${delta.join('\n')}\n`,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
  } catch {
    return null;
  }
  if (!r || r.error || r.status !== 0) return null;
  const files = String(r.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return files.length > 0 ? new Set(files) : null;
}

// Parse `_select_tests.py`'s stdout: `FULL <reason>` (⇒ null, run everything) or
// `SUBSET <n> test files` followed by one repo-relative test path per line. Anything unrecognised
// is null — never an optimistic empty subset.
export function parsePytestSelectorOutput(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''));
  if (!/^SUBSET\b/.test((lines[0] ?? '').trim())) return null;
  return new Set(
    lines
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

// `_select_tests.py` over the delta. Unlike the battery selector this runs the WORKTREE's copy (a
// cwd-relative path, exactly as scripts/hooks/pre-push.sh invokes it): the script resolves its own
// import-graph root from its own location, so the spine's copy would walk the WRONG tree. `script`
// (plan 4071 E-A: coord.config.json's `pytestSelector.script`, caller-injected — see the header
// comment above `PYTEST_CLOSURE`) is null by default, which degrades to "run everything" the same
// way a missing script file / non-zero exit / unparseable output already do — a config-less repo
// has no pytest selector to spawn at all.
export function runPytestSelector(
  delta,
  {
    _spawn = spawnSync,
    cwd = process.cwd(),
    python = 'python',
    timeoutMs = 120_000,
    script = null,
  } = {},
) {
  if (!script) return null;
  let r;
  try {
    r = _spawn(python, [script], {
      cwd,
      input: `${delta.join('\n')}\n`,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
  } catch {
    return null;
  }
  if (!r || r.error || r.status !== 0) return null;
  return parsePytestSelectorOutput(r.stdout);
}

// The pure arithmetic: which of `selection` the baseline already proved AND the delta cannot reach.
// `affected === null` (the selector could not scope) carries nothing. Never adds, reorders into
// incorrectness, or substitutes — the same bound `remainingSelection` already states.
//
// `selection` may be null/empty, which means "the baseline's own green set" — the pytest caller's
// shape, where the universe is whatever pytest COLLECTS and no caller can enumerate it without
// re-rolling pytest's collection rules. Sound either way: intersecting with a current selection is
// a nicety, since the real subtraction happens downstream (remainingSelection / _gate_ledger.py's
// in-run deselection) against the files that actually exist and are actually collected.
export function computeCarriedGreen({ selection, baselineGreen, affected }) {
  if (!affected) return null;
  const universe = selection && selection.length > 0 ? selection : [...baselineGreen];
  const carried = universe.filter((f) => baselineGreen.has(f) && !affected.has(f));
  return carried.length > 0 ? new Set(carried) : null;
}

// One carry-forward attempt, IO-injected so battery-ledger.test.mjs can drive every branch.
// Returns `{ carried: Set }` on a seed, or `{ carried: null, reason }` — the reason is stderr
// telemetry only, never a caller decision.
export function planCarryForward({
  ledgerDir,
  key,
  selection,
  git,
  nowMs,
  ttlMin = DEFAULT_TTL_MIN,
  closure,
  mappedPrefix,
  selector,
}) {
  const baseline = findCarryForwardBaseline(ledgerDir, key, nowMs, ttlMin);
  if (!baseline) return { carried: null, reason: 'no-live-baseline' };
  const delta = changedFilesBetween(git, baseline.head);
  if (!delta) return { carried: null, reason: 'delta-underivable' };
  const unmapped = unmappedClosurePaths(delta, closure, mappedPrefix);
  if (unmapped.length > 0)
    return { carried: null, reason: `closure-path-outside-selector-mapping:${unmapped[0]}` };
  const affected = selector(delta);
  if (!affected) return { carried: null, reason: 'selector-says-full' };
  const carried = computeCarriedGreen({ selection, baselineGreen: baseline.green, affected });
  if (!carried) return { carried: null, reason: 'nothing-to-carry' };
  return { carried, baselineKey: baseline.key, delta, affected };
}

// Pure subtraction — `selection` minus whatever `greenSet` already covers, ORDER PRESERVED and
// nothing ever ADDED, reordered-into-incorrectness, or substituted (the plan's own soundness
// bound on this operation). The caller decides what `greenSet` means (which key, which TTL); this
// function only ever shrinks what it is handed.
export function remainingSelection(selection, greenSet) {
  return selection.filter((f) => !greenSet.has(f));
}

// --- CLI -----------------------------------------------------------------------------------

// plan 3225 (decision D3) — the stale-green pin on the delta BASELINE, and the exact shape
// gate-pass-cache's own `record` uses for its key: the caller resolved HEAD *before* spawning the
// gate and passes it here, AFTER the run; we re-resolve HEAD now and accept the value only if it
// still matches. A commit landing in the worktree mid-run means the green set spans two commits, so
// no single commit describes it — return undefined, which mergeGreenFiles reads as "drop the head",
// and the entry simply stops being delta-eligible. Any git trouble lands in the same place.
export function verifiedHead(claimed, { git = makeGit() } = {}) {
  if (!isCommitOid(claimed)) return undefined;
  let actual;
  try {
    actual = String(git(['rev-parse', 'HEAD'])).trim();
  } catch {
    return undefined;
  }
  return actual === claimed ? claimed : undefined;
}

// The shared body of `carry-forward` / `pytest-carry-forward` — identical contract, differing only
// in ledger namespace, key closure and selector (the same axis on which `remainder`/`merge` already
// split). ALWAYS exit 0: like `merge`, this is an optimization, and every refusal simply leaves the
// gate running exactly what it runs today.
function carryForwardCmd(flags, nowMs, { ledgerDir, closure, mappedPrefix, selector, label }) {
  // An EMPTY selection is legal here (unlike `remainder`): it means "carry over the baseline's own
  // green set" — see computeCarriedGreen's header for why that is sound and why the pytest caller
  // has no list to give.
  const selection = normalizeSelection(readStdin());
  const key = flags.key;
  if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key)) {
    console.error(`battery-ledger: ${label} needs --key <32-hex-char key> — nothing done`);
    return 0;
  }
  let r;
  try {
    r = planCarryForward({
      ledgerDir,
      key,
      selection,
      git: makeGit(),
      nowMs,
      closure,
      mappedPrefix,
      selector,
    });
  } catch (e) {
    console.error(`battery-ledger: ${label} — ${e.message} (carrying nothing, full run)`);
    return 0;
  }
  if (!r.carried) {
    console.error(`battery-ledger: ${label} — no carry-forward (${r.reason})`);
    return 0;
  }
  try {
    // NO `head`: an INFERRED green must never become a baseline in its own right. Only a real run's
    // `merge` writes one (decision D3) — so a chain of deltas is always anchored on commits a gate
    // actually executed at.
    mergeGreenFiles(ledgerDir, key, r.carried, nowMs);
  } catch (e) {
    console.error(`battery-ledger: ${label} write failed (ignored) — ${e.message}`);
    return 0;
  }
  console.error(
    `battery-ledger: ${label} — ${r.carried.size} file(s) carried from ${r.baselineKey} ` +
      `(${r.delta.length} changed file(s) → ${r.affected.size} affected test file(s))`,
  );
  return 0;
}

export function main() {
  const { cmd, flags } = parseLockArgs(process.argv.slice(2), LEDGER_ARG_SPEC);
  const nowMs = Date.now();
  // Resolve the project's config ONCE, here — this is the CLI entry point plan 4071's Rule 1
  // carves out. The root is anchored on this module's OWN `scripts/` ancestor (scripts-anchor.mjs),
  // never a fixed `..` count, so the resolution survives this module moving one directory deeper.
  const coordConfig = loadCoordConfig(repoRootFrom(import.meta.dirname));
  const scopedPrefixes = scopedPrefixesFor(coordConfig.batteryScopedPrefixes);

  if (cmd === 'path') {
    console.log(resolveLedgerDir());
    return 0;
  }

  if (cmd === 'key') {
    const selection = normalizeSelection(readStdin());
    // Reuses battery-pass-cache.mjs's OWN key derivation unmodified (see the module header) —
    // any failure there (dirty tree, git error, no scripts/ tree, empty selection) is this
    // module's failure too, by construction: nothing here re-derives or second-guesses it.
    const derived = deriveKey({ git: makeGit(), selection, scopedPrefixes });
    if (!derived.ok) {
      console.error(`battery-ledger: key derivation refused — ${derived.reason}`);
      return 2;
    }
    console.log(derived.key);
    return 0;
  }

  if (cmd === 'remainder') {
    const selection = normalizeSelection(readStdin());
    const key = flags.key;
    // A missing/malformed key means "cannot consult a ledger" — the fail-safe answer is the
    // WHOLE selection, unchanged, exactly as if this module did not exist. This is the SAME
    // 32-lowercase-hex-char shape check pass-cache-kernel.mjs's own `entryPath` enforces
    // (reproduced here rather than imported, since the check itself is trivial and the
    // alternative is a thrown exception from `entryPath` this CLI would have to catch anyway —
    // validating first is simpler than catching after).
    if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key)) {
      for (const f of selection) console.log(f);
      return 0;
    }
    const green = readGreenSet(resolveLedgerDir(), key, nowMs);
    for (const f of remainingSelection(selection, green)) console.log(f);
    return 0;
  }

  if (cmd === 'merge') {
    const key = flags.key;
    const file = flags.file;
    if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key) || typeof file !== 'string') {
      console.error(
        'battery-ledger: merge needs --key <32-hex-char key> --file <path> — nothing done',
      );
      // plan 3620 fix round (H1): no key/file means no write was ever attempted — persisted=0.
      console.log(`${MERGE_PERSISTED_SENTINEL}=0`);
      return 0; // close-out — never a push/land blocker, see the module header.
    }
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // the reporter's destination never existed (nothing ran under this key this attempt) —
      // nothing to merge, not an error, but also nothing PERSISTED (H1).
      console.log(`${MERGE_PERSISTED_SENTINEL}=0`);
      return 0;
    }
    const root = process.cwd();
    const { passed, durations } = parseLedgerEvents(text);
    const relPassed = new Set();
    for (const abs of passed) relPassed.add(toPosixRelative(root, abs));
    // plan 4236 T5: per-file wall time, keyed repo-relative like the green set.
    const relDurations = {};
    for (const [abs, ms] of durations) relDurations[toPosixRelative(root, abs)] = ms;
    // plan 3620 fix round (H1/I1): `persisted` is this call's own observable proof that no write
    // FAILED — never "there was something to write". The destination was read successfully (the
    // catch above already handled the only way that can fail), so `persisted` starts at 1: if
    // `relPassed` is empty there is genuinely nothing new to bank (mergeGreenFiles' own
    // no-op-on-empty rule — no write is even attempted) and that is a VACUOUS success, not a
    // failure. It flips to 0 ONLY if an attempted write actually THROWS. See
    // MERGE_PERSISTED_SENTINEL's own header for the full contract this implements.
    let persisted = 1;
    if (relPassed.size > 0) {
      try {
        mergeGreenFiles(resolveLedgerDir(root), key, relPassed, nowMs, DEFAULT_TTL_MIN, {
          head: verifiedHead(flags.head),
          durations: relDurations,
        });
      } catch (e) {
        // fs trouble writing the ledger (readonly mount, disk full) — close-out, never blocks.
        persisted = 0;
        console.error(`battery-ledger: merge write failed (ignored) — ${e.message}`);
      }
    }
    console.log(`${MERGE_PERSISTED_SENTINEL}=${persisted}`);
    return 0;
  }

  // plan 3620 fix round G2 (findings 7db544/59a79d/276d88/b26033/d7e34f/a9a364). Prints a single
  // integer: the number of well-formed, non-truncated events in <file>, via countLedgerEvents
  // (built on the SAME parseTruncationSafeJsonLines every other reader in this module already
  // trusts) — replaces the shell hook's own `[ -s "$_rbr_ledgerfile" ]` check, which accepted a
  // truncated-mid-write file as evidence merely for being non-empty. ALWAYS exits 0 and prints `0`
  // on a missing/unreadable file — this is a close-out consult, never a blocker.
  if (cmd === 'events-count') {
    const file = flags.file;
    let text = '';
    if (typeof file === 'string') {
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        text = ''; // missing/unreadable — 0 events, not an error.
      }
    }
    console.log(String(countLedgerEvents(text)));
    return 0;
  }

  // plan 3223 (pytest half). `pytest-remainder` / `pytest-merge` mirror `remainder` / `merge`
  // above EXACTLY in shape (same stdin/argv/exit-code contract) — the only differences are the
  // ledger DIRECTORY (resolvePytestLedgerDir, not resolveLedgerDir — see that function's own
  // header for why namespacing lives in the directory, not the key) and the events PARSER
  // (parsePytestLedgerEvents/greenPytestFiles, not parseLedgerEvents — pytest's events already
  // arrive as repo-relative strings from backend/scripts/_gate_ledger.py, so there is no
  // toPosixRelative step here: that helper exists only because node:test's reporter hands back
  // ABSOLUTE paths, which pytest's own events never are).
  if (cmd === 'pytest-remainder') {
    const selection = normalizeSelection(readStdin());
    const key = flags.key;
    if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key)) {
      for (const f of selection) console.log(f);
      return 0;
    }
    // plan 3318: same remainder as before, only REORDERED — files a previous chunk started and
    // never finished go last, so the next chunk retires the ones it can actually finish instead
    // of re-entering the absorbing one. Nothing is added to or removed from the remainder here.
    const pytestDir = resolvePytestLedgerDir();
    const green = readGreenSet(pytestDir, key, nowMs);
    const stalls = readStallCounts(pytestDir, key, nowMs);
    const withStalls = flags['with-stalls'] === true;
    for (const f of orderStalledLast(remainingSelection(selection, green), stalls)) {
      console.log(withStalls ? `${f}\t${stalls[f] ?? 0}` : f);
    }
    return 0;
  }

  if (cmd === 'pytest-merge') {
    const key = flags.key;
    const file = flags.file;
    if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key) || typeof file !== 'string') {
      console.error(
        'battery-ledger: pytest-merge needs --key <32-hex-char key> --file <path> — nothing done',
      );
      // plan 3620 fix round (H1): no key/file means no write was ever attempted — persisted=0.
      console.log(`${MERGE_PERSISTED_SENTINEL}=0`);
      return 0; // close-out — never a push/land blocker, see the module header.
    }
    const sources = readPytestLedgerEventSources(file);
    if (sources.length === 0) {
      // _gate_ledger.py's destination never existed (nothing ran under this key this attempt, or
      // it never got past collection) — nothing to merge, not an error, but also nothing
      // PERSISTED (H1).
      console.log(`${MERGE_PERSISTED_SENTINEL}=0`);
      return 0;
    }
    const parsed = parsePytestLedgerEventSources(sources);
    const { collected, reported, failed } = parsed;
    const green = greenPytestFiles({ collected, reported, failed });
    // plan 3620 fix round (I1, Fix B check): `resolvePytestLedgerDir` is pure `join()` composition
    // over `process.cwd()` and this module's own literal path segments — no fs call, no mkdir, no
    // env read that can throw — so it is safe to resolve outside the try/catch below; a genuine fs
    // failure can only ever come from the write itself, already caught.
    const dir = resolvePytestLedgerDir(process.cwd());
    // plan 3620 fix round (H1/I1): `persisted` mirrors `merge`'s own contract — see
    // MERGE_PERSISTED_SENTINEL's header. `sources.length === 0` above already covers "no evidence
    // at all"; having reached here, AT LEAST ONE source WAS read successfully, so `persisted` starts
    // at 1 — a zero-file green set (nothing new proven this round) is a VACUOUS success, not a
    // failure, and no write is even attempted (mergeGreenFiles' own no-op-on-empty rule). It flips
    // to 0 ONLY if an attempted GREEN-SET write actually THROWS.
    // plan 3620 fix round (I2, delta review): "at least one" is deliberate, not sloppy — plan 3555's
    // readPytestLedgerEventSources drops an unreadable worker sidecar rather than failing the whole
    // read, precisely so one unreadable worker cannot discard proof its readable siblings already
    // flushed. A partially-read round therefore still reports `=1` for whatever it DID bank; that
    // cannot manufacture a false non-convergent verdict, because banking less this round than next
    // is PROGRESS (which resets the counter) and banking the identical set twice really is a
    // zero-progress pair. See MERGE_PERSISTED_SENTINEL's own header (I2) for the full scoping rule.
    let persisted = 1;
    if (green.size > 0) {
      try {
        mergeGreenFiles(dir, key, green, nowMs, DEFAULT_TTL_MIN, {
          head: verifiedHead(flags.head),
        });
      } catch (e) {
        // fs trouble writing the ledger (readonly mount, disk full) — close-out, never blocks.
        persisted = 0;
        console.error(`battery-ledger: pytest-merge write failed (ignored) — ${e.message}`);
      }
    }
    // plan 3318: stall bookkeeping is best-effort and orthogonal to the H1 persistence contract
    // above — it claims nothing green, so its own failure must never flip `persisted` back to 0
    // after a genuine green write already succeeded, and it must still run even when this round
    // proved no NEW green file (a file can stall without any file going green in the same round).
    // plan 3620 fix round (I2, delta review): this orthogonality SURVIVED I1's widening of
    // `persisted` from "a green write succeeded" to "no write FAILED" — that phrase is scoped to
    // the GREEN-SET write alone (MERGE_PERSISTED_SENTINEL's header, I2). Folding a stall-write
    // failure into the sentinel would flip rounds whose green proof genuinely reached disk back to
    // `=0`, re-suppressing `ranProven` at the hook's seats for exactly the zero-progress rounds
    // GATE_NON_CONVERGENT exists to catch — i.e. it would reintroduce this plan's own bug through
    // a different door. Pinned by a test in scripts/coord/battery-ledger.test.mjs (search "I2"), in the
    // reachable shape: a stall write that THREW leaves the sentinel at 1. The literal ordering this
    // paragraph describes — a green write that already SUCCEEDED, then a stall write that throws —
    // is a torn-mid-run race no harness can set up, because both writes target the SAME entry path,
    // so a successful green write is itself proof the path is writable. See that test's own scope
    // note; the opposite direction (a GREEN write that throws must report =0) has its own cases.
    try {
      mergeStalledFiles(dir, key, stalledPytestFiles(parsed), nowMs);
    } catch (e) {
      console.error(`battery-ledger: pytest-merge stall write failed (ignored) — ${e.message}`);
    }
    console.log(`${MERGE_PERSISTED_SENTINEL}=${persisted}`);
    return 0;
  }

  // plan 3620 fix round G2/G2b (findings 7db544/59a79d/276d88/b26033/d7e34f/a9a364/f64196). The
  // pytest twin of `events-count` above — replaces the shell hook's own `grep -q '"type":
  // *"collect"'` check, which can match a `collect` line living inside a TRUNCATED final
  // fragment (the exact SIGKILL-mid-write shape this whole fix round exists to close). Sums
  // well-formed COMPLETION events (see countWellFormedPytestEventsIn's own header — H2, `start`/
  // `slow_deselect` do NOT count) across EVERY physical stream a canonical events path resolves
  // to — readPytestLedgerEventSources already discovers the xdist worker sidecars, the SAME
  // source list `pytest-merge` above already reads, so a cap-killed xdist run's worker-only proof
  // is counted here too (G2b) — never just the canonical file, which a worker-only kill can leave
  // with zero events of its own. ALWAYS exits 0 and prints `0` on a missing/unreadable file.
  if (cmd === 'pytest-events-count') {
    const file = flags.file;
    const sources = typeof file === 'string' ? readPytestLedgerEventSources(file) : [];
    console.log(String(countPytestLedgerEvents(sources)));
    return 0;
  }

  // plan 3620 (push-side non-convergence bound). `chunk-round` / `pytest-chunk-round` mirror
  // `remainder` / `pytest-remainder`'s namespace split exactly (same battery-vs-pytest ledger dir
  // choice) — called from scripts/hooks/pre-push.sh's two RAN-AND-CHUNKED seats, AFTER that
  // round's own `merge`/`pytest-merge` call has already folded whatever it proved into the green
  // set, so scoreChunkRoundByGreenMark sees this round's full contribution. Prints TWO lines:
  //   1. ONE line of COMPACT JSON (no spaces — deliberate; kept as the human/diagnostic record,
  //      and because other callers may still want the full breakdown):
  //      {"rounds":N,"progressed":true|false,"nonConvergent":true|false,"ranProven":true|false,
  //      "green":N}
  //   2. plan 3620 fix round G3 (findings 61b1db/66424a/5d153e/bac162/4027c7): an UNAMBIGUOUS
  //      sentinel line, `PREPUSH_CHUNK_ROUND_NONCONVERGENT=1` or `=0`, that needs no JSON parsing
  //      at all — the hook's shell-side reader takes the LAST line and tests it for EXACT STRING
  //      EQUALITY against `PREPUSH_CHUNK_ROUND_NONCONVERGENT=1`, no globs, no substring match
  //      against the JSON line. The pre-fix hook read `case "$out" in *'"nonConvergent":true'*)`
  //      — a shape/substring GUESS against the JSON grammar that its own comment overclaimed as
  //      "validates the full grammar", when a stray line elsewhere in captured stdout containing
  //      that same substring could trip it. This sentinel is emitted ONLY when this call genuinely
  //      scored the round with `ranProven` true (mirrors `nonConvergent` itself, which
  //      scoreChunkRoundByGreenMark already never sets true on an unscoreable round) — `=1` iff
  //      BOTH `result.ranProven` and `result.nonConvergent` are true, `=0` in every other case
  //      (unscoreable, malformed, ordinary progressing/first round).
  //
  // plan 3620 fix round (F1): `--ran-proven` (boolean; see LEDGER_ARG_SPEC) is the CALLER's
  // positive evidence that the gate this round scores actually executed — threaded straight
  // through to scoreChunkRoundByGreenMark's own `ranProven` argument, never re-derived here.
  // Absent (the CLI's own default for an un-passed boolean flag) ⇒ `undefined` ⇒ NOT strictly
  // `true` ⇒ unscoreable, same as an explicit `--ran-proven=false` would be were that spelling
  // ever added — see that function's own header for the full contract.
  if (cmd === 'chunk-round' || cmd === 'pytest-chunk-round') {
    const key = flags.key;
    const ledgerDir = cmd === 'pytest-chunk-round' ? resolvePytestLedgerDir() : resolveLedgerDir();
    let result;
    if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key)) {
      result = { rounds: 0, progressed: true, nonConvergent: false, ranProven: false, green: 0 };
    } else {
      result = scoreChunkRoundByGreenMark({
        ledgerDir,
        key,
        nowMs,
        ranProven: flags['ran-proven'] === true,
      });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    const sentinelValue = result.ranProven === true && result.nonConvergent === true ? 1 : 0;
    process.stdout.write(`${CHUNK_ROUND_NONCONVERGENT_SENTINEL}=${sentinelValue}\n`);
    return 0;
  }

  // plan 3225 (Fix A). Called by done-worktree's two land preflights immediately BEFORE their
  // `remainder`/`pytest-remainder` call, so the subtraction that already exists sees the carried
  // files too. Nothing downstream changes shape.
  if (cmd === 'carry-forward') {
    return carryForwardCmd(flags, nowMs, {
      ledgerDir: resolveLedgerDir(),
      closure: BATTERY_UNMAPPED_CLOSURE,
      mappedPrefix: '',
      selector: (delta) => runBatterySelector(delta),
      label: 'carry-forward',
    });
  }

  if (cmd === 'pytest-carry-forward') {
    return carryForwardCmd(flags, nowMs, {
      ledgerDir: resolvePytestLedgerDir(),
      closure: pytestClosureFor(gatesFrom(coordConfig)),
      mappedPrefix: coordConfig.pytestSelector.prefix,
      selector: (delta) => runPytestSelector(delta, { script: coordConfig.pytestSelector.script }),
      label: 'pytest-carry-forward',
    });
  }

  console.error(
    'battery-ledger: no command (key|remainder|merge|events-count|carry-forward|' +
      'pytest-remainder|pytest-merge|pytest-events-count|pytest-carry-forward|chunk-round|' +
      'pytest-chunk-round|path)',
  );
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    // Any unexpected crash is fail-SAFE: `key`/`remainder` callers read a non-zero/empty result
    // as "no ledger, run everything"; `merge` is `|| true`'d by every caller anyway.
    console.error('battery-ledger:', e.message);
    process.exit(2);
  }
}
