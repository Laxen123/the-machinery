// scripts/coord/claim-plan-lib.mjs
// Pure, git-free helpers for the atomic ref-CAS plan-claim tools (plan 368). Every
// function here is deterministic string/data logic so the whole claim decision tree
// is unit-testable without a real repo; the git plumbing lives in claim-plan.mjs.

import { LEGACY_PATHS } from './coord-config.mjs';
// coord-refs.mjs imports nothing (a dependency-free leaf), so importing it here cannot
// cost this module its git-free, repo-free unit-testability or introduce a cycle (plan
// 3756 step 2). `refForPlan` is THE write seam every other file's claim-ref construction
// routes through — step 3 flips the namespace by editing this one function's body.
import { claimRef, parseClaimLsRemote } from './coord-refs.mjs';
// parse-flags.mjs is a LEAF (node builtins + pure string logic only), so importing
// assertOneOf here cannot cost this module its git-free, repo-free unit-testability.
import { assertOneOf } from './parse-flags.mjs';
// batch-paths.mjs is a LEAF (node builtins only), so importing it here cannot cycle.
import { batchHoldReason } from './batch-paths.mjs';
// plan 2891 T4: build-handoff-lib.mjs imports NOTHING (a pure renderer core), so taking the
// shared session-entry date shape from it cannot cycle or cost this module its git-free,
// repo-free unit-testability.
import { SESSION_ENTRY_DATE_SHAPE } from './build-handoff-lib.mjs';
// plan 4202: undeclaredProvenanceReason is the shared reason sentence for the undeclared-
// provenance refusal below — the oracle/board/move-plan/next-plan-id/promoteWaitingBlocked/
// stamp --move preflight surfaces all build the same sentence from it; only this claim gate
// additionally sets `stubOkHint` for its own operator-override lane.
import {
  readSeedMarker,
  readFrontmatterScalar,
  splitFrontmatter,
  insertAfterFrontmatterOrPrepend,
  spliceAtMatch,
  STATUS_BLOCK_RX,
  COST_BANNER_RX,
  SEED_BANNER_RX,
  H1_RX,
  IN_PROGRESS_FOLDER,
  undeclaredProvenanceReason,
  specReviewGateCode,
} from './build-index-lib.mjs';
// plan 2426: the stale-Blocked-by drop the claim projection applies. `dropStaleBlockedBy`
// is itself PURE (the corpus view arrives as `statusOf`/`isShipped` callbacks), so this
// import does not cost this module its git-free, repo-free unit-testability — it only
// borrows the ONE classification that board-write-gate.mjs already owns, rather than
// re-deriving "is this line dead?" a second time here.
import { dropStaleBlockedBy } from './board-write-gate.mjs';

// `\d{3,}` not `\d{3}`: plan ids are ≥3 digits (zero-padded), but plan 1000 crossed
// into 4 digits (the seedwrite-concurrency migration that fixed this). The greedy run
// captures the WHOLE leading numeric id ("1000-Infra-…" → "1000", "365" → "365").
const ID_RX = /^(\d{3,})/;

// The plan id (3+ digits) from a bare id or a full basename ("365-UI-mobile-nav.md").
export function planIdOf(idOrName) {
  const m = ID_RX.exec(String(idOrName));
  if (!m) throw new Error(`claim-plan: cannot derive a plan id from "${idOrName}"`);
  return m[1];
}

// THE write seam for a claim ref — plan 3756 step 3 flips the namespace by editing this
// one function, which is the whole reason step 2 routed every other file through it.
//
// Reads do NOT go through here: a reader must honour the legacy namespace too, for as
// long as any session holds a pre-flip lock. Readers use `claimRefCandidates(id)` (or
// `readHolder`, which walks them) instead.
export function refForPlan(idOrName) {
  return claimRef(planIdOf(idOrName));
}

// The claim commit message IS the holder record. One key=value per line so it is
// trivially parseable and greppable in `git cat-file commit`.
export function buildClaimMessage({ planId, sessionUuid, host, iso }) {
  return (
    [`claim plan=${planId}`, `session=${sessionUuid}`, `host=${host}`, `iso=${iso}`].join('\n') +
    '\n'
  );
}

// Reads a HELD claim commit and (plan 3756) a RELEASED one — the tombstone
// `claim RELEASED plan=<id>` that replaced the ref delete, whose body carries the same
// session/host/iso lines so a released claim stays reportable rather than becoming an
// unreadable blob.
//
// `released` is the discriminator. Callers on the HELD path never see a tombstone,
// because `readHolder` (claim-plan.mjs) filters one out and returns null — "released"
// and "no ref at all" are the same answer to "who holds this?". The readers that
// deliberately want to see released refs (reap-dead-claims, reconcile-board's orphan
// report) go through `readClaimRefTip` and branch on this flag.
export function parseClaimMessage(msg) {
  const s = String(msg ?? '');
  const released = /^claim RELEASED plan=(\d{3,})$/m.exec(s);
  const planId = released ? released[1] : (s.match(/^claim plan=(\d{3,})$/m) || [])[1];
  if (!planId) return null;
  const get = (k) => (s.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1] ?? null;
  return {
    planId,
    sessionUuid: get('session'),
    host: get('host'),
    iso: get('iso'),
    released: Boolean(released),
  };
}

// A non-force push to refs/claims/<id> either creates the ref (won) or is rejected
// non-fast-forward because a sibling already holds it (lost). Anything else (hook,
// network, auth) is a real error we must surface, NOT a silent "lost".
const NONFF_RX = /non-fast-forward|fetch first|\[rejected\]|! \[remote rejected\]|already exists/i;
export function classifyPushResult({ ok, stderr = '' }) {
  if (ok) return { won: true };
  if (NONFF_RX.test(stderr)) return { won: false, lost: true };
  return { won: false, lost: false, error: true, stderr };
}

// `git ls-remote origin 'refs/claims/*'` -> { '<id>': '<sha>' }. Delegates to
// coord-refs.mjs's dual-namespace parser (plan 3756 step 2) — today only the legacy
// namespace is ever populated, so the result is byte-identical to the old hand-rolled
// single-namespace regex.
export function parseLsRemote(out) {
  return parseClaimLsRemote(out);
}

// The counter ref points at a commit whose message is `session=<N> …`. null =>
// no ref yet => the first session is 1.
export function nextSessionNumber(counterMessageOrNull) {
  if (!counterMessageOrNull) return 1;
  const m = counterMessageOrNull.match(/^session=(\d+)/m);
  return (m ? Number(m[1]) : 0) + 1;
}

// plan 2844 Task 1: `--date` reaches sessionEntryCandidates below UNVALIDATED at both
// claim-plan call sites (doAcquire ~:1312, doAcquireBatch ~:1442) and is concatenated
// straight into the session-entry filename (`${date}-session-${n}.md`). A malformed value
// mints a filename `rankSessionFiles` (done-worktree-lib.mjs) cannot ORDER — its date-prefix
// match fails, the sort key falls back to `''`, and the entry silently sorts oldest instead
// of taking the most-recent-wins tiebreak (surfaced by plan 2838's round-3 review). Validated
// ONCE, here, and called from both sites so neither can mint the same malformed name.
//
// Shape-only, not a full calendar check: a shape-valid-but-impossible date (2026-13-40) still
// sorts and sequences exactly like a real one, so it endangers nothing rankSessionFiles does —
// only a non-ISO SHAPE breaks its date-prefix match.
//
// plan 2891 T4: built from the SHARED SESSION_ENTRY_DATE_SHAPE rather than a hand-copied
// `\d{4}-\d{2}-\d{2}`. This gate and done-worktree-lib's SESSION_ENTRY_BASENAME_RX are two
// halves of ONE invariant — this one decides which `--date` may be concatenated into a
// filename, that one decides which filename is a session entry — and they were previously
// kept in sync only by a comment naming the other file.
const SESSION_ENTRY_DATE_RX = new RegExp(`^${SESSION_ENTRY_DATE_SHAPE}$`);
export function assertSessionEntryDate(date, { cmd } = {}) {
  if (!SESSION_ENTRY_DATE_RX.test(String(date ?? ''))) {
    throw new Error(
      `claim-plan ${cmd ? cmd + ': ' : ''}--date "${date}" must be YYYY-MM-DD (e.g. 2026-08-04) — ` +
        `it is concatenated straight into the session-entry filename, and a malformed value ` +
        `mints a name rankSessionFiles cannot order (plan 2844).`,
    );
  }
}

// The per-session handoff entry path. handoffLayout='sessions' (default): one file
// per session under the configured sessions dir (no append-contention). 'single': the
// rolling handoff file. Paths come from coord-config (plan 857); default LEGACY_PATHS
// keeps config-less callers + direct unit tests on the legacy root layout.
export function sessionEntryRelPath(
  date,
  sessionNum,
  handoffLayout = 'sessions',
  paths = LEGACY_PATHS,
) {
  if (handoffLayout === 'single') return paths.rollingHandoffFile;
  return `${paths.sessionsDir}/${date}-session-${sessionNum}.md`;
}

// plan 871: the ordered candidate paths for a session entry, so a writer can pick the
// first FREE one instead of clobbering. Even though the session NUMBER is now minted
// race-safe via the CAS counter (mintSessionNumber), a session that wrote its entry by a
// non-CAS path (an ad-hoc `handoff` picking filesystem-max+1) could still collide on a
// number and overwrite a sibling's CLAIM stub (the recurring 775b/777b incidents). The
// first candidate is the bare `<date>-session-<N>.md`; collisions fall through to the
// documented `…-<N>b.md`, `…-<N>c.md`, … belt-and-suspenders suffixes (b–z, 25 slots —
// far beyond any realistic same-number pileup). 'single' layout has no per-session file
// to collide on, so it yields just `handoff.md`.
export function sessionEntryCandidates(
  date,
  sessionNum,
  handoffLayout = 'sessions',
  paths = LEGACY_PATHS,
) {
  if (handoffLayout === 'single') return [paths.rollingHandoffFile];
  const base = `${paths.sessionsDir}/${date}-session-${sessionNum}`;
  const out = [`${base}.md`];
  for (let c = 'b'.charCodeAt(0); c <= 'z'.charCodeAt(0); c++) {
    out.push(`${base}${String.fromCharCode(c)}.md`);
  }
  return out;
}

// The board's "Plan / claim" cell (column 3) for a fresh ACTIVE claim. Mirrors the
// pickup-plan step-5b convention: `<planRef>` · session N · host=`<h>` · marker.
//
// `planRef` (when given) is the plan's REAL on-disk reference — the status-dir-
// prefixed original-cased basename, e.g. `in-progress/811-Price-Surface-….md`.
// Prefer it over the bare `slug`: the board lint's NO_PLAN_REF regex
// (PLAN_REF_RX) only matches `NNN-PX-…` whose category tag PX starts uppercase,
// so a slug whose category was lowercased (`811-price-…`) renders an unmatchable
// cell that aborts the board write — the plan-819 / plan-811 strand. The real
// basename keeps the source casing and the dir prefix names where the plan lives.
// Falls back to `<slug>.md` only when no planRef is supplied (legacy callers/tests).
// plan 2460 Phase 2: executor provenance. The claim-time board cell/session-stub used to
// carry only WHO claimed a plan (host/session), never WHAT actually executed it — the
// sonnet-lane telemetry miner (mine-sonnet-lane-executor-telemetry.mjs) had to fall back to
// a host-shape heuristic to guess "cloud drain vs /orchestrate-dispatched Opus worker vs a
// plain interactive session", which the miner's own header documents as unreliable (a
// cloud-eligible plan picked up by a local /orchestrate run cannot be told apart from a
// genuine cloud-drain execution by host alone). Stamping the executor explicitly at claim
// time removes the guesswork FORWARD of this plan (no backfill — every pre-cutover claim has
// no stamp and the miner's existing heuristic keeps classifying those exactly as before).
//
// `dispatchMode` is a FIXED, closed vocabulary — every place a claim can originate today —
// so a typo'd flag fails loudly (a silently-wrong arm label is worse than a crash) rather
// than mislabelling telemetry. `interactive` is the explicit default for a human-driven
// pickup-plan session, not a fallback for "didn't say" — every claim gets an arm.
export const DISPATCH_MODES = [
  'cloud-drain',
  'orchestrate-worker',
  'local-drain-inline',
  'interactive',
];

// Both fields render inside the board's pipe-delimited table AND the claim cell's own
// backtick-quoted spans (`` exec=`<mode>` model=`<id>` ``) — a backtick, pipe, or newline in
// either would corrupt one or the other, so both are rejected outright rather than escaped.
// Applied to `model` only: `mode` is already restricted to the closed DISPATCH_MODES list
// above, none of whose literals contain these characters, so the check would be unreachable
// dead code there (sonnet-review 2026-07-26, finding on plan 2460).
const TABLE_BREAKING_RX = /[`|\n]/;
function assertNoTableBreakingChars(value, label) {
  if (TABLE_BREAKING_RX.test(value)) {
    throw new Error(
      `claim-plan: --${label} "${value}" must not contain a backtick, pipe, or newline — it is ` +
        `rendered inside the board's pipe-delimited table and the claim cell's backtick-quoted spans.`,
    );
  }
}

// `--model-id` is free text supplied by whoever is claiming (an LLM agent following the
// generated cloud-routine prose, or a human) — unlike `--dispatch-mode` it has no closed
// vocabulary to validate against. The one failure mode worth catching cheaply: the caller
// left an unsubstituted prose placeholder (e.g. "<the model you are running as>") in place
// of the real value. `<`/`>` never appear in a genuine model id, so their presence is a
// reliable signal of exactly that mistake — reject loudly rather than silently mislabel the
// telemetry arm as family "other" (sonnet-review 2026-07-26, finding on plan 2460: an
// unsubstituted placeholder was previously accepted as a valid modelId).
const PLACEHOLDER_RX = /[<>]/;
function assertNotPlaceholder(value, label) {
  if (PLACEHOLDER_RX.test(value)) {
    throw new Error(
      `claim-plan: --${label} "${value}" looks like an unsubstituted placeholder (contains < or ` +
        `>) — pass the actual value, not the prose instruction text.`,
    );
  }
}

// Normalize the two executor-provenance flags ONCE, at the write seam, so every downstream
// consumer (the board cell, both session stubs) gets an already-valid, always-populated pair
// — never omitted, never null. `modelId`/`dispatchMode` are the raw (possibly undefined)
// CLI flag values; trimmed and defaulted here, not upstream, so a caller that forgets to
// normalize still gets a safe value rather than a literal "undefined" written to disk.
export function normalizeExecutorProvenance({ modelId, dispatchMode } = {}) {
  const trimmedMode = dispatchMode == null ? '' : String(dispatchMode).trim();
  const mode = trimmedMode === '' ? 'interactive' : trimmedMode;
  assertOneOf(mode, DISPATCH_MODES, { label: '--dispatch-mode', prefix: 'claim-plan' });
  const trimmedModel = modelId == null ? '' : String(modelId).trim();
  const model = trimmedModel === '' ? 'unlabeled' : trimmedModel;
  assertNoTableBreakingChars(model, 'model-id');
  assertNotPlaceholder(model, 'model-id');
  return { modelId: model, dispatchMode: mode };
}

export function boardPlanClaimCell({
  slug,
  planRef,
  sessionNum,
  host,
  seedWrite,
  seedLane = true,
  priority = false,
  modelId,
  dispatchMode,
}) {
  // plan 2328: a `priority: high` plan prefixes ⚡ onto the lane marker (one token,
  // same shape as the INDEX bullet's `⚡🟥` — build-index-lib parsePlanMeta), so the
  // stamp is visible on the board row without opening the plan file.
  const lane = seedLane && String(seedWrite).toLowerCase() === 'yes' ? '🟥 SEED-WRITE' : '🟩';
  const marker = `${priority ? '⚡' : ''}${lane}`;
  const ref = planRef || `${slug}.md`;
  // Normalized HERE (not just at the CLI seam) so every caller — including a bare unit test
  // that supplies neither field — gets an explicit exec/model arm on the cell (plan 2460).
  const provenance = normalizeExecutorProvenance({ modelId, dispatchMode });
  return (
    `\`${ref}\` · session ${sessionNum} · host=\`${host}\` · ${marker}` +
    ` · exec=\`${provenance.dispatchMode}\` model=\`${provenance.modelId}\``
  );
}

// The Status-block regex that plan 2415 added here as a LOCAL copy is now imported from
// build-index-lib (see the import block above). 2415 reached the same conclusion this plan
// did — a claim must replace the whole block, not stack annotations — but kept a private
// copy, reasoning that importing would risk drift because plan-body-state.mjs is adopted
// byte-identical by tandapp. That rationale does not hold: `build-index-lib.mjs` is itself
// in tandapp's adopt set (coord.config.json), so a constant living THERE is shared by every
// writer in both repos with no adoption problem — which is precisely why it was put there
// rather than in either writer. Two hand-maintained copies of one regex is the drift the
// concern was about, not the cure for it. The copy also predates `**Takeover:**`, so it
// would have stranded that annotation the moment this plan's --resume path stamped one.
// Anchors for INSERTING a Status line into a hand-filed plan that has none, in
// preference order: right after the cost-forecast banner, else the SEED-WRITE
// banner, else the H1 — falling through to a prepend if the body has none of them.
// COST_BANNER_RX / SEED_BANNER_RX / H1_RX are now all imported from build-index-lib.mjs
// (plan 2409) — see that module for the cost-anchor narrowing rationale (a body
// sentence merely discussing a cost forecast must not hijack the anchor).
// flipStatusToInProgress below still matches all three anchors against a
// frontmatter-stripped body so a summary line quoting a banner verbatim can never
// hijack the anchor either (round 5 fix, unchanged by this plan).

// ───────────────────── plan 1364 Ship 1: batch claim (2-8 plans, one worktree) ─────

// A batch slug MUST start with "batch-" (mirrors the plan-872 slug-prefix guard for
// single-plan acquire, which requires the slug to carry the resolved plan id as its
// leading prefix). A batch has no single plan id to prefix against, so the fixed
// "batch-" prefix is the analogous structural marker: it lets a downstream tool
// (done-worktree, board tooling) recognise a batch worktree/branch at a glance,
// distinct from every single-plan `<id>-<Category>-…` slug.
//
// plan 1364 review R2 (R2-1): the single owner of the "batch-" convention. Was
// hand-encoded independently in landing-queue.mjs (`isBatchSlug`) and
// done-worktree.mjs (`a.slug.startsWith('batch-')`) — a third copy that could drift
// from this one. Both now import BATCH_SLUG_PREFIX / isBatchSlug from here instead.
export const BATCH_SLUG_PREFIX = 'batch-';

export function isBatchSlug(slug) {
  return Boolean(slug) && String(slug).startsWith(BATCH_SLUG_PREFIX);
}

export function assertBatchSlug(slug) {
  if (!isBatchSlug(slug)) {
    throw new Error(
      `claim-plan batch: --slug "${slug}" must start with "batch-" ` +
        `(e.g. --slug batch-2026-07-03-coord-hardening).`,
    );
  }
}

// The repository-wide slug/category charset (plan 1313 F-004/F-015) now lives in the LEAF
// module slug-charset.mjs (plan 3450) so a consumer that needs only the grammar
// (landing-queue-lib.mjs) doesn't have to pull in this module's coord-config -> coord-git ->
// board-write-gate import chain. Re-exported here so every existing consumer of
// claim-plan-lib's SLUG_CHARSET_RX / assertSlugCharset keeps working unchanged.
export { SLUG_CHARSET_RX, assertSlugCharset } from './slug-charset.mjs';

// The lanes a plan's `execModel:` frontmatter can name, and everything downstream code
// needs to know about each one (plan 3341) — an icon (a board/drain-view display glyph),
// a drain-claim title label, and the executor-shape flags a caller branches on instead of
// re-testing `execModel === 'fable'` (or, now, `'sol'`) by hand at each call site.
//
//   icon / label: 🟢 sonnet, 🟣 fable, 🔶 sol / 'sonnet drain', 'fable drain', 'sol lane' —
//     pinned literals from the orchestrator (NOT sourced by reading batches-view.mjs /
//     ready-board.mjs / cloud-session-hygiene-lib.mjs, which other workers were editing
//     concurrently while this table was built — see plan 3341 coordination notes).
//     `sol lane` is drain-claimable (plan 3461) — see `drainClaimable` below.
//   drainClaimable: can the orchestrator drain (queue-drain.mjs) pick this lane's plans up
//     on its own? `sol` is drain-claimable too (plan 3461, reversing plan 3341's opt-in-only
//     clause on operator ruling) — every drain session is already Opus-class (both
//     `sonnet-full` and `fable-full` cloud triggers, and every local drain, run as an Opus
//     session; the lane name is only the WORKER tier), so no new session kind is needed to
//     drive a Sol seat. This flag being `true` is orthogonal to `batchable` being `false`
//     immediately below — one plan claimed and executed alone is not a batch.
//   hasNativeRun: is this lane requestable as its own `--lane` CLI value on queue-drain.mjs,
//     i.e. does it get its own dedicated oracle invocation (a run whose `requestedLane`
//     matches it one-for-one) rather than riding inside another lane's run? True for
//     `sonnet` (the default oracle run) and `fable` (`--lane fable`); false for `sol` — plan
//     3461 made `sol` drain-claimable WITHOUT inventing a `--lane sol` CLI value, so a `sol`
//     plan is admitted under BOTH the sonnet and the fable oracle run instead of getting a
//     run of its own.
//     MUST NOT be conflated with `drainClaimable` above — they coincided only by accident
//     before this plan, when `sol` was the sole lane with neither. `drainClaimable` answers
//     "can any drain pick this lane's plans up at all"; `hasNativeRun` answers a narrower,
//     unrelated question — "does this lane have a `--lane` value of its own to be picked up
//     BY". A lane can be drain-claimable (`sol` today) with no native run of its own, exactly
//     because every drain session is already Opus-class regardless of `--lane` — the CLI flag
//     only selects which WORKER tier's plans an invocation reports on, not whether Sol plans
//     are reachable. Conflating the two again is the exact plan-3461 defect: it is what let
//     `ready-board.mjs` and `queue-drain.mjs` each hand-roll their own copy of this axis as a
//     literal (`NATIVE_RUN_LANES` / `lane !== 'sol'`) instead of reading one shared flag.
//   batchable: does ANY conductor exist that can run a homogeneous batch of this lane's
//     plans? True for sonnet (`batch-train`'s mechanical conductor) AND fable (a heavy
//     session, or the fable-full routine's Fable-batch section — a DIFFERENT conductor
//     from batch-train, but a real one, per the plan-2556 "ALL-FABLE batch is claimable"
//     precedent) — false ONLY for `sol`, which has no batch conductor at all, ever (a sol
//     plan is executed by a single Opus-orchestrated session dispatching `codex exec`,
//     structurally incompatible with a multi-plan batch). This is the flag BATCH_LANES is
//     derived from below, so it answers "can this lane batch", never "can it ride
//     batch-train specifically" — a narrower question this table doesn't need to answer.
//   thinOrchestrator: does this lane execute under the thin-orchestrator doctrine (a heavy
//     session driving a worker) rather than queue-drain's plain Sonnet-worker dispatch?
//   needsCodexTransport: does this lane's conductor need the codex-CLI transport (Luna/Sol
//     runners) to execute, rather than pure in-process Claude tool calls?
//
// plan 3341 review: `orchestratorTier` (which model tier conducts this lane) was dropped —
// genuinely unread by anything in this codebase (checked via a repo-wide grep before
// removing); re-add it if a real consumer needs it, rather than carrying a field nothing
// reads.
export const EXEC_LANE_TABLE = Object.freeze({
  sonnet: {
    lane: 'sonnet',
    icon: '🟢',
    label: 'sonnet drain',
    drainClaimable: true,
    hasNativeRun: true,
    batchable: true,
    thinOrchestrator: false,
    needsCodexTransport: false,
  },
  fable: {
    lane: 'fable',
    icon: '🟣',
    label: 'fable drain',
    drainClaimable: true,
    hasNativeRun: true,
    batchable: true,
    thinOrchestrator: true,
    needsCodexTransport: false,
  },
  sol: {
    lane: 'sol',
    icon: '🔶',
    label: 'sol lane',
    drainClaimable: true,
    hasNativeRun: false,
    batchable: false,
    thinOrchestrator: true,
    needsCodexTransport: true,
  },
});

// The fail-closed lane resolver (plan 3341). Every ternary elsewhere in this codebase that
// tests `execModel === 'fable'` (else sonnet) reads ANY unrecognized value as the sonnet
// default — tolerable when 'fable' was the only alternative to guard against, but not once a
// THIRD lane exists: a plan mis-stamped `execModel: sol` that a stale ternary doesn't
// recognize would silently run as an ordinary Sonnet-drain plan instead of refusing, exactly
// the misroute this plan exists to close off. `resolveExecLane` is the ONE seam a call site
// should migrate to instead of re-rolling its own ternary: it returns the frozen
// EXEC_LANE_TABLE entry for a recognized lane, the sonnet entry for an absent/blank value
// (today's documented default, preserved byte-for-byte), and THROWS for anything else — an
// unknown lane fails loud at the resolution point instead of silently defaulting.
export function resolveExecLane(execModel) {
  const trimmed = execModel == null ? '' : String(execModel).trim().toLowerCase();
  if (trimmed === '') return EXEC_LANE_TABLE.sonnet;
  // Own-property lookup, never a bare `EXEC_LANE_TABLE[trimmed]` — a plain object literal
  // inherits `Object.prototype`, so `execModel: constructor` / `toString` / `valueOf` /
  // `hasOwnProperty` would otherwise resolve to a truthy (but nonsensical) "lane" instead of
  // hitting the throw below, defeating the whole point of a resolver whose job is to fail
  // loud on anything it doesn't recognize.
  const entry = Object.prototype.hasOwnProperty.call(EXEC_LANE_TABLE, trimmed)
    ? EXEC_LANE_TABLE[trimmed]
    : undefined;
  if (!entry) {
    throw new Error(
      `resolveExecLane: unrecognized execModel "${execModel}" — must be one of ` +
        `${Object.keys(EXEC_LANE_TABLE).join(' / ')} (or absent, which reads as sonnet).`,
    );
  }
  return entry;
}

// The lanes a batch may run in (plan 2556). Derived from EXEC_LANE_TABLE's `batchable`
// flag — never a second hand-typed literal — so this set can't silently drift from the
// lane vocabulary above as new lanes are added or a lane's batchability changes.
//
// plan 3341 ruling (orchestrator decision, overrides an earlier draft of this comment):
// `sol` is DELIBERATELY EXCLUDED here, not merely unbatchable by omission — a `sol` plan
// is executed by a single Opus-orchestrated session dispatching `codex exec`, so there is
// no batch conductor for it at all, ever (not "not yet"). Including it in BATCH_LANES
// would make an all-sol batch silently ELIGIBLE, which is the exact defect this exclusion
// prevents. checkBatchEligibility's `unknown` check below distinguishes "not a recognized
// lane at all" (a typo — unchanged wording) from "a recognized lane that plainly cannot
// batch" (sol — its own refusal, naming why) via `resolveExecLane(...).batchable`, so the
// two vocabularies (this set and the table) can never disagree about WHICH case a value
// falls into. An ABSENT execModel reads as `sonnet` — the grandfathered default
// queue-drain's own lane gate applies.
const BATCH_LANES = new Set(
  Object.values(EXEC_LANE_TABLE)
    .filter((entry) => entry.batchable)
    .map((entry) => entry.lane),
);

// Pure eligibility gate — run BEFORE any ref is acquired (fail fast: nothing to roll
// back). `members`: [{ id, path, content }], one entry per requested plan id, in the
// order given — `path`/`content` are null when the caller's activePathFor lookup
// could not resolve the id (this function only judges the results; the git lookup
// itself lives in claim-plan.mjs, which has repo access). `force` bypasses the
// execModel/seed-write-homogeneity checks — it NEVER bypasses the 2-8 count or
// resolvability, per the plan-1364 design. `stubOk` (plan 1427 Gate 2) is the ONLY
// thing that bypasses the stage:"specced" requirement — `force` used to bypass stage
// too, but that left a batch-shaped escape hatch around the exact self-pickup bypass
// Gate 2 closes for single-plan acquire (a stub plan claimed with no heavy-model
// spec-pass). `pipelineFields` (plan 4071 D3): threaded straight through to each
// member's checkStubClaimGate call — see that function's doc comment for the default.
// Returns { ok:true } or { ok:false, reason }.
export function checkBatchEligibility(
  members,
  { force = false, stubOk = false, seedLane = true, pipelineFields = [] } = {},
) {
  if (members.length < 2 || members.length > 8) {
    return { ok: false, reason: `a batch must claim 2-8 plans (got ${members.length})` };
  }
  const ids = members.map((m) => m.id);
  const dupe = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dupe) return { ok: false, reason: `duplicate plan id "${dupe}" in batch` };
  const unresolved = members.filter((m) => !m.path);
  if (unresolved.length) {
    return {
      ok: false,
      reason:
        `plan(s) not resolvable (no ready/waiting-*/pending-approval file found): ` +
        unresolved.map((m) => m.id).join(', '),
    };
  }
  if (!stubOk) {
    for (const m of members) {
      const stage = readFrontmatterScalar(m.content, 'stage').toLowerCase();
      if (stage !== 'specced') {
        return {
          ok: false,
          reason:
            `plan ${m.id} has stage "${stage || '(absent)'}", batch requires "specced" ` +
            `(use --stub-ok "<authorization note>" to override a stub — --force no longer ` +
            `bypasses stage, plan 1427 Gate 2)`,
        };
      }
      // Review F1: a member can read stage:"specced" (passing the check above) while
      // still carrying `specReview: exempt-mechanical` on a 🟥 plan whose body mentions
      // a Gate-1 pipeline-owned field — checkStubClaimGate is the ONE place that
      // narrowing is judged, and single-plan acquire always runs it. Without this call, a
      // batch claim was a structural bypass around that exact refusal.
      const gate = checkStubClaimGate(m.content, { stubOk, seedLane, pipelineFields });
      if (!gate.ok) {
        return { ok: false, reason: `plan ${m.id}: ${gate.reason}` };
      }
    }
  }
  // plan 3341: this ONE lookup is shared by the pre-force structural check right below
  // AND the post-force homogeneity checks further down — computed once, before either.
  const execModels = members.map(
    (m) => readFrontmatterScalar(m.content, 'execModel').toLowerCase() || 'sonnet',
  );
  // plan 3341 ruling (orchestrator decision): a `sol` member is refused BEFORE the --force
  // bypass below, unlike every other check `force` waives. A stamping typo (unrecognized
  // value) is plausibly a slip `--force` can reasonably wave through on the operator's
  // say-so, and a mixed SEED-WRITE banner is a policy call — but "there is no batch
  // conductor for `sol`, ever" is a structural fact, not a policy this session can opt out
  // of: a `sol` plan is executed by a single Opus-orchestrated session dispatching `codex
  // exec`, and no `--force` waiver conjures that conductor into existing for a batch-train
  // run. Letting `--force` through here would recreate exactly the silently-broken state
  // (a claimed batch nothing can execute) this distinction exists to prevent. Judged via
  // `resolveExecLane(...).batchable` — the SAME flag BATCH_LANES is derived from above — so
  // an unrecognized value (a genuine typo) is NOT reported here; it falls through to the
  // unknown-value check below instead, which — like this one — runs BEFORE `--force` can
  // apply (see that check's own comment for why).
  const notBatchable = members
    .map((m, i) => ({ id: m.id, value: execModels[i] }))
    .filter((e) => {
      try {
        return !resolveExecLane(e.value).batchable;
      } catch {
        return false; // unrecognized — a different defect, judged (and refused) below
      }
    });
  if (notBatchable.length) {
    return {
      ok: false,
      reason:
        `plan(s) in a non-batchable lane (${notBatchable.map((e) => `${e.id}=${e.value}`).join(', ')}) ` +
        `— a \`sol\` plan is executed by a single Opus-orchestrated session dispatching ` +
        `\`codex exec\`; there is no batch conductor for it at all, so it can never ride ` +
        `\`batch-train\` or any other batch lane. This is not a stamping typo, so \`--force\` ` +
        `is not the right tool here — claim the sol plan(s) solo instead.`,
    };
  }
  // plan 2556: the gate is LANE-HOMOGENEITY, not sonnet-only. It used to refuse any member
  // whose execModel was not `sonnet`, which made a fable batch unclaimable through the only
  // sanctioned path — and the cloud-routine prompts forbid `--force` outright, so there was
  // no escape at all. That was the last link in the dead zone: the plan-2459 hold blocked
  // every member from a solo claim while the batch claim refused the train.
  //
  // An ABSENT execModel normalizes to `sonnet` — the grandfathered default queue-drain's own
  // lane gate applies (`execModel === 'fable'` inverts, everything else is the sonnet pool),
  // so an unstamped member batches with sonnet members exactly as it always did.
  //
  // Membership in the known BATCHABLE lane set is checked BEFORE the mixed-value check below
  // (plan 2556 review finding 2) — a bare same-value check would ACCEPT a batch whose members
  // all share the SAME typo, and queue-drain's lane gate reads anything-not-`fable` as the
  // sonnet pool, so that batch would silently execute as sonnet with nothing having validated
  // the value. Every `sol` member was already refused above, so anything still outside
  // BATCH_LANES here is a genuine unrecognized value.
  //
  // plan 3341 correctness fix: this check now runs BEFORE the `--force` early return below,
  // not after it. `--force` overrides a POLICY judgment (a mixed lane, a mixed SEED-WRITE
  // banner) — it never rescues a value `resolveExecLane` cannot resolve at all. The prior
  // ordering ran this check only when `force` was false (a `force`-true call returned `ok`
  // immediately, right after the `notBatchable` refusal above, before this check ever ran),
  // so a forced batch could admit a member whose execModel nothing downstream can execute —
  // exactly the silently-broken state this gate exists to prevent.
  const unknown = members
    .map((m, i) => ({ id: m.id, value: execModels[i] }))
    .filter((e) => !BATCH_LANES.has(e.value));
  if (unknown.length) {
    return {
      ok: false,
      reason:
        `unrecognized execModel in batch (${unknown.map((e) => `${e.id}="${e.value}"`).join(', ')}) ` +
        `— must be one of ${[...BATCH_LANES].join(' / ')} (or absent, which reads as sonnet). ` +
        `Likely a stamping typo; fix the frontmatter — \`--force\` cannot rescue this (it ` +
        `overrides a policy judgment, never a value nothing can resolve at all).`,
    };
  }
  if (force) return { ok: true };
  if (new Set(execModels).size > 1) {
    return {
      ok: false,
      reason:
        `mixed execModel in batch (${members.map((m, i) => `${m.id}=${execModels[i]}`).join(', ')}) ` +
        `— every member must share one lane, because a batch runs under ONE conductor and a ` +
        `Sonnet batch-train cannot ride a fable member (nor vice versa). Split it, or use ` +
        `--force to override.`,
    };
  }
  const markers = members.map((m) => readSeedMarker(m.content, { seedLane }));
  if (new Set(markers).size > 1) {
    return {
      ok: false,
      reason:
        `mixed SEED-WRITE banners in batch (${members.map((m, i) => `${m.id}=${markers[i]}`).join(', ')}) ` +
        `— all members must share the same 🟥/🟩 marker (use --force to override)`,
    };
  }
  return { ok: true };
}

// plan 1427 Gate 1 & 2: pipeline-owned seed fields whose FLIP (not addition) requires
// a heavy-model specReview — Gate 1's push-time guard (assert-pipeline-field-
// specreview.mjs) and Gate 2's claim-time exempt-mechanical narrowing (below) both key
// off this ONE set so the two enforcement points can never drift on which fields are
// covered. Scope decided at spec-pass 2026-07-05: `acceptsAcuteCases` (renamed from
// isEmergencyHospital by plan 1592) — the candidates (clinicConfirmation/
// operationalStatus) are deferred to a follow-up (see plan 1427 body "Out of scope").
// `acuteCapability` added by the plan-1592 review: since the two-axis split it is the
// field that DIRECTLY gates Akut-view membership (strictly more load-bearing than
// acceptsAcuteCases ever was), so a hand-forged schema-valid flip of it is exactly
// the d7e661baf incident class Gate 1 exists to stop. (`clinicForm` stays out: the
// organisational-form axis drives no money/akut surface on its own.) Plan 4071 D3: the
// field list itself moved OUT of this module and into coord.config.json's
// `land.specReviewGatedFields` (read via loadCoordConfig/loadCoordConfigAtOrigin), so
// this module is project-agnostic — checkStubClaimGate and checkBatchEligibility below
// take the list as a `pipelineFields` parameter instead of a hardcoded literal, and the
// caller (claim-plan.mjs, which already resolves `cfg` for the same claim) passes it
// through. An empty/absent list is a no-op narrowing (a config-less repo gates nothing).

// Gate 2 (plan 1427, claim-time specReview gate): claiming a `stage: stub` plan (or a
// plan with no stage at all) via single acquire requires either a heavy-model
// `specReview` sha, or `specReview: exempt-mechanical` — and `exempt-mechanical` is
// REFUSED on a 🟥 seed-write plan whose body mentions a Gate-1 pipeline-owned field,
// because a self-stamped "this is just mechanical" exemption is exactly the self-
// pickup bypass the plan-1412/d7e661baf incident exploited (a stage:stub plan
// self-claimed in its own mint window, no heavy-model review). `stubOk` (truthy —
// the caller has already validated the operator's authorization note is non-empty)
// bypasses the whole gate, INCLUDING the 🟥 narrowing — an explicit operator override
// always wins over a structural refusal. Edge case (acceptance criteria): a stub
// plan that already carries a real specReview sha PASSES — the gate keys on
// specReview PRESENCE, `stage` is only the trigger for requiring one, never itself
// re-checked once a specReview value exists. `pipelineFields` (plan 4071 D3): the
// Gate-1 field list, injected by the caller — defaults to `[]` (no fields gated),
// never to the historical two-field literal, so a config-less caller narrows nothing
// rather than silently inheriting vetapp-specific policy. Returns { ok:true } or
// { ok:false, reason }.
export function checkStubClaimGate(
  content,
  { stubOk = false, seedLane = true, pipelineFields = [] } = {},
) {
  if (stubOk) return { ok: true };
  const stage = readFrontmatterScalar(content, 'stage').toLowerCase();
  const specReview = readFrontmatterScalar(content, 'specReview');
  if (specReview) {
    if (specReview.toLowerCase() === 'exempt-mechanical') {
      const seedWrite = readSeedMarker(content, { seedLane }) === '🟥';
      const touchesPipelineField = seedWrite && pipelineFields.some((f) => content.includes(f));
      if (touchesPipelineField) {
        return {
          ok: false,
          reason:
            `plan is stage "${stage || '(absent)'}" with specReview: exempt-mechanical, but it is a ` +
            `🟥 seed-write plan whose body mentions a Gate-1 pipeline-owned field ` +
            `(${pipelineFields.join(', ')}) — a self-stamped mechanical exemption cannot cover ` +
            `that (plan 1427 Gate 2; incident d7e661baf). Run a heavy-model spec-pass for a real ` +
            `specReview sha, or claim with --stub-ok "<authorization note>".`,
        };
      }
      return { ok: true };
    }
    // plan 3943: a real specReview sha stamped with specReviewBy: undeclared means the
    // stamping session never recorded WHICH model/effort produced the spec-pass verdict
    // (plan 3004's self-report field) — a review of unknown provenance is exactly the
    // "no premise was verified" gap this plan closes, so it cannot be drained any more
    // than a bare stub can. Scoped to the literal `undeclared` value only — an ABSENT
    // specReviewBy (every plan stamped before plan 3004 introduced the field) is a
    // grandfathered legacy shape, not a provenance gap this check is about.
    const specReviewBy = readFrontmatterScalar(content, 'specReviewBy');
    if (specReviewGateCode(stage, specReview, specReviewBy) === 'provenance') {
      // plan 4202: both the PREDICATE (specReviewGateCode) and the reason text come from the
      // shared core (build-index-lib.mjs) so neither can drift from what the oracle/board/
      // move-plan surfaces decide and say — only the stub-ok hint differs, since this is the
      // one surface with an operator-override lane.
      return {
        ok: false,
        reason: undeclaredProvenanceReason('plan', specReview, { stubOkHint: true }),
      };
    }
    return { ok: true }; // any other non-empty specReview (a sha) always passes
  }
  const isStubStage = stage === 'stub' || stage === '';
  if (isStubStage) {
    return {
      ok: false,
      reason:
        `plan is stage "${stage || '(absent)'}" with no specReview — claiming a stub via single ` +
        `acquire requires a heavy-model spec-pass (run the spec-pass skill to stamp specReview, ` +
        `plan 1427 Gate 2) or an explicit operator override via --stub-ok "<authorization note>".`,
    };
  }
  return { ok: true };
}

// plan 2459 Task 2 (leak B guard, single-plan claim path): is `planId` a member of a
// RUNNABLE batch (status: proposed, gate: null)? `heldSlug` is that batch's slug, or null/
// undefined when the plan is unheld — the caller (claim-plan.mjs) resolves it from disk ONCE
// via batch-paths.mjs's findRunnableBatchForPlan; this function itself touches no fs,
// mirroring checkStubClaimGate's pure shape.
//
// Takes the RESOLVED slug rather than a lookup map (plan 2518 review, two CONFIRMED
// findings): this gate only ever answers about the ONE plan being claimed, so a map
// parameter forced its single production caller to box an already-known string into a
// throwaway one-entry Map and canonicalize the id three times to shuttle it back out. The
// bulk shape still exists for the caller that genuinely has one — queue-drain scans every
// ready plan against a precomputed map via batch-paths.mjs's batchHoldFor.
//
// `overrideNote` (non-empty — already validated by the caller, same convention as stubOk
// above) bypasses the gate unconditionally: the explicit operator-directed escape hatch
// (plan 2459 pinned judgment call 2 — `pickup-plan <id>`'s operator override stays
// legitimate, this flag is its batch-hold analogue). Returns { ok:true } or
// { ok:false, reason } naming the batch and both legal moves.
export function checkBatchSoloClaimGate(planId, heldSlug, { overrideNote } = {}) {
  if (overrideNote) return { ok: true };
  if (!heldSlug) return { ok: true };
  // The wording comes from batch-paths.mjs's batchHoldReason (plan 2518 item 1), which
  // queue-drain.mjs's eligibility branch also composes through — one sentence, so the claim
  // refusal and the drain's exclusion reason cannot drift into two differently-worded copies
  // of the same rule. The claim path prefixes the shared core so it reads as a sentence,
  // which is the ONLY difference between the two messages before the extraction.
  return { ok: false, reason: `plan ${planId} is a ${batchHoldReason(heldSlug)}` };
}

// The board "Plan / claim" cell for a batch member: the same shape boardPlanClaimCell
// renders for a single-plan claim, plus a trailing `· batch=`<batch-slug>`` pointer so
// a human/tool scanning the board can discover the shared batch grouping. A bare batch
// slug never ends in `.md`, so appending it after the marker cannot be mistaken for (or
// interfere with matching of) the plan ref that lint-board.mjs's PLAN_REF_RX looks for.
export function boardBatchPlanClaimCell({ batchSlug, ...rest }) {
  return `${boardPlanClaimCell(rest)} · batch=\`${batchSlug}\``;
}

// True when a plan's source folder is a waiting-* gate. Claiming such a plan is an
// operator override of its trip-condition, which flipStatusToInProgress records.
export function isWaitingFolder(folder) {
  return typeof folder === 'string' && folder.startsWith('waiting-');
}

// Flip a plan body's Status line to 🔄 IN PROGRESS, recording the prior value. When
// `srcFolder` is a waiting-*/ gate (a resume/override, not a fresh ready/ claim),
// append an **Override:** line so a later audit can reconstruct WHY the plan ran
// before its trip-condition fired — the resume-projection convention from the
// pickup-plan skill (step 5c), now emitted by the tool (plan 446). `stubOk` (plan
// 1427 Gate 2), when given, appends a SECOND **Override:** line naming the operator's
// authorization note — the audit trail for why a stub-gate refusal was bypassed.
//
// plan 2426 adds two more optional inputs, and this is deliberately the ONE seam that
// carries them, because it is the ONE body transform BOTH claim paths already share
// (`claim-plan`'s projectClaim/projectBatchClaim and `drain-run`'s stampClaimInProgress):
//
//   `blockedView` ({ basename, statusOf, isShipped }) — when given, a STALE `**Blocked-by:**`
//     line is dropped before the flip (operator ruling Q2), so a claimed plan whose blockers
//     have all archived+shipped stops carrying the 2141/2408-style dead line into
//     `in-progress/`. A LIVE line is left VERBATIM — see dropStaleBlockedBy's header for why
//     the claim path is deliberately not symmetric with move-plan's unconditional drop.
//   `blockedOk` (the `--blocked-ok "<note>"` operator override) — an **Override:** line
//     recording that a live Blocked-by was knowingly claimed through. Same mechanism, same
//     audit purpose as `stubOk`; independent of it.
//
// `overrideBatchSolo` (plan 2459 Task 2) appends a further **Override:** line the same way,
// naming why a runnable-batch member was claimed solo. All override reasons are independent
// and can all co-occur (a rare quadruple-override).
//
// All default to absent, so every pre-2426 / pre-2459 caller keeps byte-identical output.
export function flipStatusToInProgress(
  body,
  {
    host,
    slug,
    date,
    srcFolder,
    stubOk,
    blockedView = null,
    blockedOk = null,
    overrideBatchSolo = null,
  },
) {
  // Drop FIRST, flip second: the two edits target independent lines, and doing the drop
  // against the un-flipped body keeps this function's Status-anchor logic below reasoning
  // about exactly the body shape it always has.
  if (blockedView) body = dropStaleBlockedBy(body, blockedView);
  const statusLine = `**Status:** 🔄 IN PROGRESS — picked up ${date} by \`${host}\` in \`worktree-${slug}\`.`;
  let overrideLine = isWaitingFolder(srcFolder)
    ? `\n**Override:** operator pickup ${date} satisfied the \`${srcFolder}/\` gate (auto-projected by \`claim-plan acquire\`).`
    : '';
  // plan 2353: a TAKEOVER — the plan was already in `in-progress/` under a previous
  // holder whose claim ref had to be released first. Recorded as its own line (not the
  // waiting-gate Override above, which states a different fact) so an audit can tell
  // "resumed after a dead holder" apart from "claimed fresh" and from "trip-condition
  // bypassed".
  if (srcFolder === IN_PROGRESS_FOLDER) {
    overrideLine += `\n**Takeover:** resumed ${date} by \`${host}\` via \`claim-plan acquire --resume\` — the plan was already in \`in-progress/\`; the previous holder's \`refs/claims/\` lock was released before this claim.`;
  }
  if (stubOk) {
    overrideLine += `\n**Override:** claimed via \`--stub-ok\` (plan 1427 Gate 2 bypass) — "${stubOk}".`;
  }
  if (blockedOk) {
    overrideLine += `\n**Override:** claimed via \`--blocked-ok\` over a LIVE **Blocked-by:** line (plan 2426) — "${blockedOk}".`;
  }
  if (overrideBatchSolo) {
    overrideLine +=
      `\n**Override:** claimed solo via \`--override-batch-solo\` (plan 2459 Task 2 batch-hold ` +
      `bypass) — "${overrideBatchSolo}".`;
  }
  // Search AND splice within the frontmatter-stripped body only (plan 2360 round
  // 5, hardened plan 2392) — despite the `body` parameter name, this is the WHOLE
  // file including frontmatter, and a plan's `summary:` can quote a banner (or
  // even a `**Status:**`-shaped line) verbatim. Splicing by `match.index` +
  // `match[0].length` (not `String.replace(literalText, …)`) means a SECOND,
  // stale occurrence of the same anchor/Status text elsewhere in the body can
  // never mis-target the splice either (plan 2392 finding 3) — `replace()` always
  // targets the first occurrence, which need not be the one that was matched.
  const { prefix: fmPrefix, body: strippedBody } = splitFrontmatter(body);
  // Match the whole status BLOCK, not just the Status line (plan 2353). This path used
  // to be line-scoped, which silently left the PRIOR transition's **Previous status:** /
  // **Override:** / **Takeover:** lines stranded beneath the freshly-written ones. A
  // fresh ready/ claim never noticed (nothing to strand), but `--resume` makes claiming
  // an already-claimed plan routine — and a chained takeover (dead holder → takeover →
  // that session also dies → second takeover) would stack two undated, unordered
  // histories for one plan, destroying exactly the audit trail the Takeover line exists
  // to provide. Replacing the block drops them; the prior Status value survives as
  // **Previous status:**, and the fuller lineage lives in the board row + session entries.
  const prevMatch = strippedBody.match(STATUS_BLOCK_RX);
  if (prevMatch) {
    // A Status line is present — flip it in place and capture the prior value. Since the
    // match is the whole BLOCK (Status + any stale Previous status/Override/Takeover
    // lines), `prev` must come from ONLY the block's first line — deriving it from the
    // whole match would embed the stale multi-line block inside one annotation line, the
    // same unbounded growth in a different shape (plan 2415's warning, kept).
    const prev = prevMatch[0].split('\n')[0];
    const next = `${statusLine}\n**Previous status:** ${prev.replace(/^\*\*Status:\*\* /, '')}${overrideLine}`;
    return fmPrefix + spliceAtMatch(strippedBody, prevMatch, next);
  }
  // No Status line (hand-filed plan) — INSERT one rather than throwing. There is
  // no previous value, so omit the **Previous status:** line.
  const anchorMatch =
    strippedBody.match(COST_BANNER_RX) ||
    strippedBody.match(SEED_BANNER_RX) ||
    strippedBody.match(H1_RX);
  if (anchorMatch) {
    const anchor = anchorMatch[0];
    return (
      fmPrefix +
      spliceAtMatch(strippedBody, anchorMatch, `${anchor}\n\n${statusLine}${overrideLine}`)
    );
  }
  // No banner/H1 anchor either. If a YAML frontmatter block leads the body,
  // insert AFTER its closing fence — never prepend before it, which splits the
  // frontmatter block and makes `stripFrontmatter`/`readFrontmatterScalar` (both
  // requiring `lines[0] === '---'`) stop recognizing it as frontmatter at all.
  // This was a pre-existing bug (predates plan 2360 entirely), fixed here (plan
  // 2392 finding 2) — shared with plan-body-state.mjs's setStatusLine via the
  // one `insertAfterFrontmatterOrPrepend` helper (see its build-index-lib.mjs
  // header comment for why a from-scratch frontmatterEnd() rescan here would
  // have reintroduced the same corruption class).
  return insertAfterFrontmatterOrPrepend(body, `${statusLine}${overrideLine}`);
}
