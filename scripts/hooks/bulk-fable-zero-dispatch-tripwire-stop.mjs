#!/usr/bin/env node
// scripts/hooks/bulk-fable-zero-dispatch-tripwire-stop.mjs — Stop hook (plan 1747).
//
// Mirrors the thin-orchestrator doctrine's own rule 4 (three consecutive
// no-judgment delegations → a plan was mis-routed to fable, downgrade) but
// catches the OPPOSITE failure plan 1629's 2026-07-12 re-audit found: a
// bulk-shaped fable plan that never delegates at ALL. Two known misses seed the
// tuning:
//   - 1707 (price-write-seam-allowlist-burn-down, "27 active (non-archive)
//     holdouts") — 0 dispatches, 63 combined Bash+Edit before finishing.
//   - 1674 (prepush-battery-orphan-teardown, "10 live `node --test …`
//     batteries") — 0 dispatches, 243 combined Bash+Edit before finishing.
//
// WARN-ONLY, HARD CONSTRAINT: this hook emits `{"systemMessage": "..."}` and
// NOTHING else — no `decision:"block"` (that reopens the turn and forces the
// model to act, which is a soft-block in spirit even though it isn't a tool
// deny) and no PreToolUse-style `permissionDecision:"deny"` (this isn't even a
// PreToolUse hook). It matches the EXACT shape of the plain informational Stop
// hook already in .claude/settings.json (the FEATURES.md reminder), which also
// emits a bare systemMessage with no decision field. A false positive on a
// genuinely judgment-dense plan that merely runs long must never stop work —
// the doctrine's own inline-mode carve-out is real, and this hook cannot judge
// plan shape as reliably as a human/heavy-model read can.
//
// Trip requires ALL THREE (pinned in-body, do not loosen or invent new
// triggers):
//   (a) inline Bash/Read/Edit/Write/MultiEdit tool_use count on the main
//       thread crosses THRESHOLD (40 — tuned only against the 1707/1674
//       evidence above, both of which blew well past it before finishing);
//   (b) zero Agent/Task dispatches have occurred this session;
//   (c) the claimed plan's `summary:`/H1 text matches bulk-shape language — a
//       SMALL keyword list: "batch", digit+…+item/clinic/holdout/battery,
//       "corpus", "sweep" (BULK_SHAPE_TESTS below).
//
// COUNTING METHOD: reads the session's OWN transcript file (`transcript_path`
// off the Stop payload) and tallies `tool_use` blocks inside `type:"assistant"`
// entries. Unlike plan 1629's original scanner (which filtered on
// `isSidechain:false` because ITS transcripts apparently could carry inlined
// sidechain entries), a live measurement of this environment's own transcripts
// (2026-07-12, ~90 vetapp project transcripts swept) found `isSidechain` is
// NEVER `true` in a session's own file — an Agent dispatch's sub-work is
// recorded in a wholly SEPARATE transcript file, never inlined as a sidechain
// entry here. So every tool_use in THIS file already IS a main-thread call by
// construction; no isSidechain filter is needed (or possible) at this layer.
// The dispatch tool itself is named "Agent" in this harness (confirmed the
// same sweep: 2426 real occurrences, 0 "Task"); "Task" is kept in
// DISPATCH_TOOLS purely for forward/backward compat with the doctrine's own
// wording (plan 1629) — harmless since it never matches here today.
//
// FABLE-PLAN DETECTION (the "closest deterministic approximation" the plan
// authorizes when a fully reliable signal isn't available): a normal
// pickup-plan worktree's branch is `worktree-<id>-<slug>`, and its plan file is
// `docs/superpowers/plans/in-progress/<id>-<slug>.md` (verified against this
// repo's live `git worktree list` 2026-07-12 — every non-batch worktree
// follows this exactly). We derive the id from the branch name, locate the
// matching plan file (in-progress/, falling back to ready/ for a session that
// hasn't been claim-moved yet), and read its frontmatter once per Stop event
// (cheap: one git call + one small file read).
//
// KNOWN LIMITATION (documented per the plan's own escape hatch): a batch-train
// branch (`worktree-batch-<date>-<slug>`, no leading plan-id digits) or any
// non-`worktree-`-prefixed branch (master, a hand-named branch) does NOT match
// the id-extraction regex and is SKIPPED ENTIRELY — this hook never fires
// there. That's intentional, not an oversight: a batch-train car runs small
// SONNET-drainable plans (not the standalone execModel:fable sessions this
// tripwire targets), so under-detecting there costs nothing this plan is
// scoped to catch.
//
// Warns AT MOST ONCE per session (marker cache keyed by session_id, same
// pattern as the wiki loaders' per-session dedup) — once the tripwire has
// fired, re-scanning a still-growing transcript every subsequent turn buys
// nothing.
//
// Fails open/silent on any parse/git/fs error — a Stop hook must never wedge
// the turn.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readStdin,
  parseSessionId,
  markerDirFor,
  alreadyInjected,
  markInjected,
  parseJsonlEntries,
  readFileByteRange,
  OPT_IN_ROOTS,
} from './lib/loader-common.mjs';
import { readFrontmatterScalar, readH1 } from '../coord/build-index-lib.mjs';
import { readExecModel } from '../coord/lint-filename-execmodel-drift.mjs';
import { slugFromBranch } from '../coord/redgreen-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

// Pinned in-body — tune ONLY against the 1707 (63 combined Bash+Edit)/1674 (243
// combined Bash+Edit) evidence; do not invent new numbers.
export const THRESHOLD = 40;

export const INLINE_TOOLS = new Set(['Bash', 'Read', 'Edit', 'Write', 'MultiEdit']);
// "Agent" is this harness's real dispatch-tool name (confirmed via a live transcript
// sweep, see file header); "Task" is kept for wording-compat with plan 1629, though it
// has never matched here.
export const DISPATCH_TOOLS = new Set(['Agent', 'Task']);

// A small, fixed keyword list (pinned in-body — do not expand). The digit+noun test
// tolerates a bounded run of intervening words (an adjective/qualifier/backticked
// phrase) so it still matches the two known misses' actual wording ("27 active
// (non-archive) holdouts", "10 live `node --test scripts/*.test.mjs` batteries") —
// neither has the digit directly adjacent to the noun. The window is capped at 50
// chars and this test only ever runs against a plan's own (short) summary/H1 text,
// never a full plan body, so it can't drift onto an unrelated number.
export const BULK_SHAPE_TESTS = [
  /\bbatch(?:es)?\b/i,
  /\bcorpus\b/i,
  /\bsweep\b/i,
  /\d+[\s\S]{0,50}?\b(?:items?|clinics?|holdouts?|batter(?:y|ies))\b/i,
];

export function isBulkShaped(text) {
  return BULK_SHAPE_TESTS.some((re) => re.test(String(text || '')));
}

// The plan id off a standard pickup-plan worktree branch (`worktree-<id>-<slug>`).
// null for anything else (batch-train branches, master, a hand-named branch) — the
// documented detection-limit carve-out (see file header). Composes with redgreen-lib's
// canonical slugFromBranch (plan 1754 F4 — the redo of a reverted 1747 cleanup) rather
// than re-deriving the `worktree-` strip itself: slugFromBranch already owns
// `worktree-<slug>` → `<slug>` (null for anything else, including a batch-train
// branch, which has no leading digits in its slug either — the batch-branch→null
// behavior this function must preserve falls out of the SAME digit-prefix test below,
// unchanged).
export function planIdFromBranch(branch) {
  const slug = slugFromBranch(branch);
  if (!slug) return null;
  const m = slug.match(/^(\d{3,})-/);
  return m ? m[1] : null;
}

// Locate `<id>-*.md` under docs/superpowers/plans/in-progress/ (the normal case for a
// session actively executing), falling back to ready/ (a session that hasn't been
// claim-moved yet). null if neither has it. `readDir` is injectable for tests.
export function findPlanFile(id, repoRoot = REPO_ROOT, readDir = readdirSync) {
  for (const status of ['in-progress', 'ready']) {
    const dir = join(repoRoot, 'docs', 'superpowers', 'plans', status);
    let files;
    try {
      files = readDir(dir);
    } catch {
      continue;
    }
    const hit = files.find((f) => f.startsWith(`${id}-`) && f.endsWith('.md'));
    if (hit) return join(dir, hit);
  }
  return null;
}

// The full detection: is `cwd` (a git checkout) currently on a standard pickup-plan
// worktree branch whose claimed plan is execModel:fable AND bulk-shaped? Returns
// `{ id, planPath }` or null. Every dependency is injectable so tests never shell out
// to real git or touch the real plan tree.
//
// NOTE (folded finding [2], PLAUSIBLE, delta re-review 2026-07-12 — left as a note, not
// a fix, when this was reworked for F8 caching): this trusts the CALLER's `cwd`
// (main() passes `process.cwd()`) for branch/plan detection with no independent check
// that it's actually the session's own worktree checkout. Caching the result (F8,
// below) makes this a ONE-TIME trust rather than a per-Stop one, which if anything
// narrows the window, but does not remove it.
export function detectBulkFablePlan(
  cwd,
  {
    repoRoot = REPO_ROOT,
    readDir = readdirSync,
    readFile = (p) => readFileSync(p, 'utf8'),
    gitBranch,
  } = {},
) {
  let branch;
  try {
    branch = gitBranch
      ? gitBranch(cwd)
      : execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
  } catch {
    return null; // not a git repo / detached in a way rev-parse can't resolve — can't tell, skip
  }
  const id = planIdFromBranch(branch);
  if (!id) return null; // not a standard single-plan worktree — documented limitation
  const planPath = findPlanFile(id, repoRoot, readDir);
  if (!planPath) return null;
  let content;
  try {
    content = readFile(planPath);
  } catch {
    return null;
  }
  // Plan 3341: this tripwire is fable-ONLY by design, and `execModel: sol` is deliberately
  // NOT admitted here. A sol plan's cheap workers are `codex exec` dispatches, not Task/Agent
  // subagents, so a zero-Sonnet-subagent count is the EXPECTED steady state on that lane —
  // admitting it would fire this tripwire on every sol plan that ran exactly as intended.
  // The sol lane's own escape valve is the >2-rework-round cap, not this hook. Recorded here
  // rather than left silent so the omission reads as a decision instead of an oversight.
  if (readExecModel(content) !== 'fable') return null; // not an execModel:fable plan
  // Plan 1753: a structured `bulkShaped: true` frontmatter stamp (spec-pass/mint-set, on the
  // plan-1668 `loop:` precedent) wins outright when present — checked BEFORE the prose
  // heuristic below, which stays as the unchanged fallback for unstamped/legacy plans. Only
  // the literal string 'true' counts; anything else (absent, 'false', a stray value) falls
  // through to isBulkShaped unchanged — no suppression semantics, one-way signal only.
  if (readFrontmatterScalar(content, 'bulkShaped') === 'true') return { id, planPath };
  const combined = `${readFrontmatterScalar(content, 'summary')}\n${readH1(content)}`;
  if (!isBulkShaped(combined)) return null; // fable, but not bulk-shaped — not this tripwire's target
  return { id, planPath };
}

// Tally tool_use blocks within an already-read raw JSONL blob via the shared
// parseJsonlEntries generator (plan 1754 F5 — this used to be countMainThreadToolUse's
// own inline split+parse loop, byte-for-byte duplicated in loader-common's
// lastAssistantText; both now funnel through one shared primitive). Internal: neither
// `countMainThreadToolUse` (the unbounded, whole-blob tally below) nor
// `tallyToolUseCached` (the F7 incremental cache) needs the caller to see this
// directly — they differ only in WHAT `raw` slice they hand it.
function tallyToolUse(raw) {
  let inline = 0;
  let dispatch = 0;
  for (const entry of parseJsonlEntries(raw)) {
    if (!entry || entry.type !== 'assistant') continue;
    const content =
      entry.message && Array.isArray(entry.message.content) ? entry.message.content : null;
    if (!content) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      if (INLINE_TOOLS.has(block.name)) inline += 1;
      else if (DISPATCH_TOOLS.has(block.name)) dispatch += 1;
    }
  }
  return { inline, dispatch };
}

// Tally `tool_use` blocks in `type:"assistant"` entries of the session's OWN
// transcript file. Every entry in this file is main-thread by construction in this
// harness (see file header) — no isSidechain filter needed. `readFile` injectable for
// tests. Returns null (can't count → caller must fail-open) on any read error.
//
// This is the UNBOUNDED, whole-file primitive — still used directly by tests as "what
// would a from-scratch scan count", and as the fallback inside `tallyToolUseCached`
// (below) whenever there is no usable cache. A long, still-growing, zero-dispatch
// session calling this on EVERY Stop is exactly the O(n^2) cost F7 fixes — see
// `tallyToolUseCached` for the incremental replacement main() actually calls.
export function countMainThreadToolUse(transcriptPath, readFile = (p) => readFileSync(p, 'utf8')) {
  let raw;
  try {
    raw = readFile(transcriptPath);
  } catch {
    return null;
  }
  return tallyToolUse(raw);
}

// Truncate `raw` to its last COMPLETE (newline-terminated) line, returning the decoded
// text to parse plus the RAW-BYTE length consumed. All offset math happens on a Buffer
// (the newline scan is `buf.lastIndexOf(0x0a)` on raw bytes; only the consumed slice is
// decoded for parsing), so `bytes` is byte-exact against the file BY CONSTRUCTION —
// review [3]: the earlier version decoded first and measured Buffer.byteLength of the
// DECODED string, which drifts when the file carries an invalid UTF-8 sequence (each
// bad byte decodes to U+FFFD, 3 bytes re-encoded), and the shrink-only staleness guard
// would never self-heal that forward drift. A string input (the test seams inject
// strings) is encoded once here and is then the byte ground truth. A trailing line with
// no terminating `\n` — the write in progress, or a byte-range read landing mid-write —
// is excluded from both text and bytes: never counted, never marked "scanned" (E2's
// resume-offset contract for tallyToolUseCached below). Not used by
// countMainThreadToolUse/lastAssistantText, which intentionally tally whatever parses,
// torn tail or not — only the CACHED path needs this stricter boundary, since it alone
// persists an offset that must never re-count or skip a byte across Stops.
function boundedComplete(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
  const lastNl = buf.lastIndexOf(0x0a); // '\n' on RAW bytes — never on decoded text
  if (lastNl === -1) return { text: '', bytes: 0 };
  return { text: buf.toString('utf8', 0, lastNl + 1), bytes: lastNl + 1 };
}

// F7 (plan 1754): incrementally tally tool_use counts using a persisted per-session
// `{ scannedBytes, inlineCount, dispatchCount }` cache instead of re-reading and
// re-parsing the whole, monotonically-growing transcript on every Stop (the O(n^2)
// full re-read `countMainThreadToolUse` alone would cost on a long zero-dispatch
// session — the 1707/1674 evidence this hook targets). `getSize`/`readFrom`/
// `readFile` are all injectable (tests assert the cached path reads ONLY the bytes
// appended since `state.scannedBytes`, never the whole file).
//
// E2 staleness guard — falls back to a from-scratch scan (via `readFile`, same
// unbounded read `countMainThreadToolUse` uses) when:
//   - `state` is missing or its shape is unusable (first Stop this session, or a
//     corrupt/torn state file) — never throws, never trusts a malformed cache;
//   - the transcript's CURRENT size is LESS than `state.scannedBytes` (shrank or
//     rotated) — a cache can never be trusted to extend a file smaller than what it
//     already claims to have scanned.
//
// Both the from-scratch and incremental path bound their tally to `boundedComplete`'s
// last-COMPLETE-line boundary, so `scannedBytes` never advances past a torn trailing
// line — the next call re-reads and tallies it exactly once, never zero times (data
// loss) or twice (a double count that could flip the fire-once decision — E3b: cached
// counts must reach the IDENTICAL trip decision a full scan would).
//
// Byte-exactness (review [3]): both real readers return raw BUFFERS (`readFile`
// defaults to an encoding-less readFileSync; `readFrom` to loader-common's shared
// readFileByteRange), and boundedComplete does its newline/offset math on those raw
// bytes — decoding happens only on the consumed slice, so `scannedBytes` can never
// drift from real file offsets, whatever bytes the transcript carries. The offset
// reader is loader-common's readFileByteRange (review [6]) — the one shared fd-loop
// primitive it now shares with readFileTail — whose empty-Buffer-at-EOF / null-on-IO-
// error contract matches what this caller needs (nothing appended vs can't read).
//
// Returns `{ inline, dispatch, scannedBytes }` (the counts + offset to persist), or
// null (fail-open — caller must behave exactly as if it couldn't count at all) on any
// IO error.
export function tallyToolUseCached(
  transcriptPath,
  state,
  {
    getSize = (p) => statSync(p).size,
    readFrom = (p, start, end) => readFileByteRange(p, start, end),
    readFile = (p) => readFileSync(p),
  } = {},
) {
  let size;
  try {
    size = getSize(transcriptPath);
  } catch {
    return null;
  }

  const hasValidState =
    state &&
    Number.isInteger(state.scannedBytes) &&
    state.scannedBytes >= 0 &&
    Number.isInteger(state.inlineCount) &&
    state.inlineCount >= 0 &&
    Number.isInteger(state.dispatchCount) &&
    state.dispatchCount >= 0;

  if (!hasValidState || size < state.scannedBytes) {
    // No usable cache, or the transcript shrank/rotated underneath it — full re-scan.
    let raw;
    try {
      raw = readFile(transcriptPath);
    } catch {
      return null;
    }
    const { text, bytes } = boundedComplete(raw);
    const { inline, dispatch } = tallyToolUse(text);
    return { inline, dispatch, scannedBytes: bytes };
  }

  if (size === state.scannedBytes) {
    return {
      inline: state.inlineCount,
      dispatch: state.dispatchCount,
      scannedBytes: state.scannedBytes,
    };
  }

  // Pass the size this function ALREADY statted as the range's end bound, so the
  // shared reader skips a second stat() of the same file (review [4]) — and the read
  // is pinned to the size the staleness guard above validated, not whatever the file
  // has grown to in between.
  const delta = readFrom(transcriptPath, state.scannedBytes, size);
  if (delta === null) return null;
  const { text, bytes } = boundedComplete(delta);
  const { inline, dispatch } = tallyToolUse(text);
  return {
    inline: state.inlineCount + inline,
    dispatch: state.dispatchCount + dispatch,
    scannedBytes: state.scannedBytes + bytes,
  };
}

// Per-session "already warned" marker cache, plus the F7/F8 { scannedBytes,
// inlineCount, dispatchCount, detectionComputed, detection } state file (E1) — both
// live under this hook's OWN root, the same tmpdir-marker-dir pattern the wiki loaders
// use (lib/loader-common.mjs). Sourced from loader-common's OPT_IN_ROOTS (plan 1754
// folded finding: the generalized, correctly-scoped compaction-reset opt-in — NOT
// bolted into loader-common's wiki-only CACHE_ROOTS, the reverted 1747 wrong-depth
// mistake) so this hook and loader-common share ONE literal, not two. Wiring
// wiki-markers-compact-reset.mjs to actually sweep OPT_IN_ROOTS (via
// clearAllRegisteredMarkers) is a one-line follow-up outside this plan's file-scope
// allowlist — until then this marker is not compaction-reset, same as before this
// plan; acceptable, since a missed reset can only suppress a second legitimate
// warning for the rest of a compacted session, never cause a false positive.
export const CACHE_ROOT = OPT_IN_ROOTS.bulkFableTripwire;

const STATE_FILENAME = 'tool-use-state.json';

// Best-effort read of this session's combined F7+F8 state file. null on ANY failure
// (missing — first Stop this session — or corrupt/torn JSON): callers treat null
// identically to "nothing cached yet", never throw (E3c fail-open).
function loadState(markerDir) {
  if (!markerDir) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(markerDir, STATE_FILENAME), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Best-effort write; a failed write just means the next Stop redetects/rescans from
// scratch (correctness never depends on this succeeding).
function saveState(markerDir, state) {
  if (!markerDir) return;
  try {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, STATE_FILENAME), JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

export function buildWarning(planId, inlineCount) {
  return (
    `[bulk-fable-zero-dispatch-tripwire] This execModel:fable session (plan ${planId}) looks ` +
    `bulk-shaped (its summary/H1 matches "batch" / "N items…" / "corpus" / "sweep") and has run ` +
    `${inlineCount} inline Bash/Read/Edit/Write ops with ZERO Agent/Task dispatches (threshold ` +
    `${THRESHOLD}). This mirrors the plan-1629 finding on plans 1707/1674 — consider whether the ` +
    `independent items here should fan out to Agent dispatches instead of running fully inline. ` +
    `WARN ONLY: this is advisory, not a block — a genuinely judgment-dense plan that merely runs ` +
    `long is an expected, and acceptable, false positive.`
  );
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // malformed → fail open
  }

  const sessionId = parseSessionId(payload);
  const markerDir = markerDirFor(CACHE_ROOT, sessionId);
  // No session id → cannot dedupe "already warned"; still safe to proceed since this
  // hook only ever emits a systemMessage (never a turn-reopening block), unlike
  // wiki-loaders-stop.mjs's fail-CLOSED rule for its decision:"block" path.
  if (alreadyInjected(markerDir, 'warned')) return;

  let state = loadState(markerDir); // combined F7+F8 cache (E1); null → nothing cached yet
  // Deferred-write discipline (review [7]): merge every field into `state` in memory
  // and write the file AT MOST ONCE per Stop — the earlier shape wrote a detection-only
  // state right after F8, then immediately rewrote it with the merged F7 tally (the
  // first write a strict subset of the second). `flush()` on the early-return paths
  // keeps the F8 semantics those paths rely on (a fresh detection — including a null
  // "not a bulk-fable plan" — must persist even when the tally never runs, or every
  // later Stop would re-derive it). saveState stays best-effort, so fail-open is
  // untouched: a lost write just means the next Stop recomputes.
  let stateDirty = false;
  const flush = () => {
    if (stateDirty) saveState(markerDir, state);
  };

  // F8 — cache branch/plan detection once per session: a git rev-parse + two
  // readdirSync + a plan-file read/parse are otherwise identical turn-over-turn
  // (branch + claimed plan don't change mid-session).
  let info;
  if (state && state.detectionComputed) {
    info = state.detection; // may legitimately be null — a cached "not a bulk-fable plan"
  } else {
    info = detectBulkFablePlan(process.cwd()) || null;
    state = { ...(state || {}), detectionComputed: true, detection: info };
    stateDirty = true;
  }
  if (!info) return flush();

  const transcriptPath = payload?.transcript_path ?? payload?.transcriptPath ?? '';
  // F9: no existsSync guard here — a nonexistent/unreadable transcript already
  // fails open via tallyToolUseCached's own null-on-read-failure below.
  if (!transcriptPath) return flush();

  // F7 — incremental tool_use counting via the same cache's scannedBytes/inlineCount/
  // dispatchCount fields.
  const counted = tallyToolUseCached(transcriptPath, state);
  if (!counted) return flush(); // fail-open — IO error, behave exactly as if we couldn't count

  state = {
    ...state,
    scannedBytes: counted.scannedBytes,
    inlineCount: counted.inline,
    dispatchCount: counted.dispatch,
  };
  stateDirty = true;
  flush(); // the one write for this Stop (detection merge + tally together)

  if (counted.dispatch > 0) return; // at least one delegation happened — doctrine satisfied
  if (counted.inline < THRESHOLD) return; // hasn't crossed the threshold yet

  markInjected(markerDir, 'warned');
  process.stdout.write(JSON.stringify({ systemMessage: buildWarning(info.id, counted.inline) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch {
    // fail open — a Stop hook must never wedge the turn
  }
  process.exit(0);
}
