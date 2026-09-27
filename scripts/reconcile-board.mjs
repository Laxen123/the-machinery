#!/usr/bin/env node
// scripts/reconcile-board.mjs — reconcile refs/claims/* (the lock truth) against
// handoff-board.md (the human mirror) — plan 368.
//
// The ref is the source of truth for "who holds the lock"; the board is the human
// projection. They can drift: a session wins a ref then crashes before projecting
// (ORPHAN-REF: ref held, no present row of any live-ish state), or a board row
// outlives its released ref (ORPHAN-ROW: ACTIVE row, no ref — or an old-style claim
// that predates ref-CAS).
//
// plan 2818: the ref side of the classification is now THREE-WAY, not two. A ref is
// "present" (has a live board row) if its row reads ACTIVE, 🟢 LANDING, or ⏸ PAUSED —
// not ACTIVE alone. A LANDING row is the strongest liveness proof the board has (it
// means a land is actively in flight); a PAUSED row is a live session's claim, just not
// mid-diff right now — neither is an orphan. Before this fix, `activeRowsFromBoard()`
// only recognised ACTIVE rows, so a ref backing a LANDING or PAUSED row fell into
// orphanRefs and (once stale-aged) printed a `release-claim --force` remediation against
// a live session — measured 2-for-2 false-positive on 2026-08-04 (refs/claims/2766,
// refs/claims/2758). `orphanRefs` now means "no present row of ANY of the three states";
// a PAUSED-only ref gets its own `pausedRefs` bucket instead — a distinct third class,
// not an orphan.
//
// READ-ONLY by design: it REPORTS drift + flags stale orphan-refs (by claim age),
// and prints the exact remediation command — it never auto-deletes a ref or a row
// (the same "surface, never auto-steal" posture as landing-lock). The operator runs
// `release-claim <id> --force` on a confirmed-dead orphan-ref.

import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, resolveMain, lsRemoteTimed } from './coord/coord-git.mjs';
import { loadCoordConfig } from './coord/coord-config.mjs';
import {
  splitBoard,
  dataRowsOf,
  cellsOf,
  planIdOfRowSlug,
  LANDING_STATE,
  PAUSED_STATE,
  ACTIVE_STATE,
  IN_FLIGHT_STATES,
  TERMINAL_STATES,
} from './coord/board-lib.mjs';
import { parseLsRemote, parseClaimMessage } from './coord/claim-plan-lib.mjs';
// coord-refs.mjs imports nothing, so this adds no new cross-tree edge (plan 3756 step 2).
// Legacy constructors only — this step does not flip the namespace.
import { claimRefCandidates, claimRef } from './coord/coord-refs.mjs';
import { heldClaimsMap } from './coord/claim-plan.mjs';
// plan 3814: the landing queue is the strongest in-flight liveness signal outside the board
// (a slug holding a FIFO slot is a live land or a live claim-holder waiting to land) — pulled
// from the pure lib, never the heavy `landing-queue.mjs` CLI, so this reporter's import graph
// stays cheap and read-only.
// plan 3814 review fix round 2 (F3): QUEUE_START/QUEUE_END scope the header-row check to the
// actual queue table region — see queueRegionHasHeaderRow below. The round-1 byte-exact HEADER
// import is gone; a table-shaped header row (first cell === "slug") is now enough.
// plan 3814 review round 4: MIN_QUEUE_ROW_CELLS is parseQueue's own row-admission floor, now a
// named export instead of a literal this file re-typed — see queueRegionHasHeaderRow.
import {
  parseQueue,
  QUEUE_START,
  QUEUE_END,
  MIN_QUEUE_ROW_CELLS,
} from './coord/landing-queue-lib.mjs';
// plan 3973: the queue doc lives on the coord ref refs/heads/coord/landing-queue and is read
// through its ONE accessor — see readQueueDocForReconcile below for how it keeps this
// reporter's verified/unverified contract.
import { readQueueDoc, QUEUE_REF } from './coord/landing-queue-ref.mjs';

const ACTIVE = ACTIVE_STATE;
// plan 2818 (F7): board-state vocabulary has ONE home (board-lib.mjs's IN_FLIGHT_STATES) —
// this used to be a hand-copied third literal array that could drift from redgreen-lib's own
// copy, silently letting a future in-flight state read as an orphan-ref here. Exported so
// reconcile-board.test.mjs can guard it covers exactly IN_FLIGHT_STATES.
export const PRESENT_STATES = new Set(IN_FLIGHT_STATES);

// plan 3814 review fix (F1): board-lib.mjs's TERMINAL_STATES, as a Set for the allRowsFromBoard
// membership test below — the single home for "which states are terminal markers, not live
// evidence" is board-lib.mjs; this is just the lookup shape this file needs.
const TERMINAL_STATES_SET = new Set(TERMINAL_STATES);

// plan 2818 (F4): a read-only reporter must never hang — same 5s cap `lsRemoteTimed`
// already applies to the claim-ref side of this comparison.
const GIT_TIMEOUT_MS = 5000;

// plan 3814 review fix (F2/F3): the ONE resolver both the queue-side and board-side liveness
// walks use to turn a slug into a plan id, replacing two independent try/catch-and-drop copies
// (queuePlanIds, and the equivalent inline catch in allRowsFromBoard) that silently discarded
// any slug they could not resolve — dropping the entry rather than crediting it OR flagging the
// read as untrusted. Returns the resolved plan id, or `null` when the slug cannot be SAFELY
// resolved — callers must treat `null` as "this view is untrusted", never as "no credit, but
// otherwise a clean read" (see queuePlanIds / allRowsFromBoard below and the `verified` gate in
// main()).
//
// plan 3814 review fix round 2 (F4, findings c8d325/06886d/063d76): round 1 hand-rolled this as
// `planIdOf` (claim-plan-lib.mjs's bare `/^(\d{3,})/` — no boundary check at all) plus a
// DATE_PREFIX_RX special-case for the one shape (`YYYY-MM-DD-…`) that regex gets wrong. That special
// case did not cover every wrong-boundary shape: `planIdOf('2932-1-x')` greedily returns `'2932'`
// (a real, unrelated plan id) because it never checks what follows the digit run. board-lib.mjs
// ALREADY exports the boundary-aware primitive this needs — `planIdOfRowSlug` — with the exact
// invariant a board row-slug resolver requires (a bare id, or `<id>-` followed by a NON-digit;
// `null` for a date-prefixed, batch-train, or bare-legacy slug, and for `2932-1-x`, by
// construction). Delegating to it removes the hand-rolled exception entirely rather than growing
// a second special case per newly-discovered wrong-boundary shape.
// plan 3814 review fix round 3 (F3, finding 0f63f1 CONFIRMED): round 2 swapped `planIdOf`
// (claim-plan-lib.mjs's `/^(\d{3,})/` — plan ids are minted 3+ digits, see next-plan-id.mjs; that
// minimum is documented in claim-plan-lib.mjs) for board-lib.mjs's `planIdOfRowSlug` (boundary-
// aware — refuses `2932-1-x` and date-prefixed slugs by construction — but enforces NO minimum
// length at all) — losing the 3-digit floor in the swap. `planIdOfRowSlug` stays the boundary
// authority (that part of round 2 was right; do not re-edit board-lib.mjs, which has no reason to
// know about plan-id minting) — the length rule is re-imposed HERE, composed on top of its
// result: a 1- or 2-digit prefix resolves to `null` (unresolved), never a bogus short id. Two
// owners, two rules: board-lib.mjs owns the boundary shape, this file owns the minted-length
// floor sourced from claim-plan-lib's documented invariant.
export function resolveSlugPlanId(slug) {
  const id = planIdOfRowSlug(slug);
  return id != null && id.length >= 3 ? id : null;
}

// --- pure --------------------------------------------------------------------

// plan 3814 review fix round 3 (F4, findings 1367f2/7a883b CONFIRMED): round 2's F1 guarded only
// `content == null` (the read failed entirely — origin AND local fallback both threw). Board
// content that comes back non-null but MALFORMED (no BOARD-START/BOARD-END sentinels: a corrupt
// checkout file, or a coordination doc that isn't the board at all) still makes `splitBoard`
// throw, and that throw used to propagate straight out of both board walks and out of main()'s
// outer catch — exit 2, suppressing the ENTIRE report (PAUSED-REF/ORPHAN-ROW lines included) over
// a board read that merely came back corrupt rather than absent. Shared here so
// presentRowsFromBoard and allRowsFromBoard degrade the SAME way: empty body, never a throw.
// `malformed` is surfaced only through allRowsFromBoard's return (see its own comment) — the one
// signal main() reads to mark the board-row liveness view untrusted; presentRowsFromBoard stays a
// bare array for its existing callers, so it consumes the empty body silently rather than
// duplicating the same signal on two different return shapes.
function safeSplitBoardBody(content) {
  try {
    return { body: splitBoard(content).body, malformed: false };
  } catch {
    return { body: '', malformed: true };
  }
}

// Every "present" board row (ACTIVE, LANDING, or PAUSED) → [{ slug, planId, state }].
// Skips header + separator rows. plan 2818 (F6): iterates board-lib.mjs's dataRowsOf — the
// single owner of the header/separator convention — instead of a second hand-rolled copy of
// it, so a format change there (a second header row, a different separator shape) can never
// silently make this reporter skip live rows. activeRowsFromBoard is a thin ACTIVE-only
// filter over this.
// plan 3814 review fix round 2 (F1, finding 2e43ea CONFIRMED): `content` can now be `null` —
// readCoordFileForReconcile returns `{content: null, source: 'unreadable'}` when BOTH the
// origin read AND the local-fallback read throw (an outcome round 1's F5 unification made
// reachable on the BOARD side for the first time; it always existed on the queue side).
// splitBoard(null) throws (`null.indexOf` is not a function), which used to crash main()'s
// whole run via its outer catch — suppressing every finding, PAUSED-REF/ORPHAN-ROW lines
// included, over a board read that merely failed. An unreadable board degrades to an EMPTY
// view here, never a throw; main() keys `boardVerified` off the read's `source`, so this
// content already lands on the fail-safe (remediation-suppressed) side without any extra logic.
// plan 3814 review fix round 3 (F2, findings 004eaa/432669/1ae500/2fcda6/f7f860/852fdd/9a3f5a/
// 4ed1b2 CONFIRMED): this used to resolve `cells[0]` with the bare, boundary-unaware `planIdOf`
// (claim-plan-lib.mjs's `/^(\d{3,})/`, no boundary check) while allRowsFromBoard/queuePlanIds
// below already use the boundary-aware `resolveSlugPlanId` — so the SAME board file produced a
// DIFFERENT plan id for the same row slug depending on which walk read it: `2932-1-x` resolved to
// `'2932'` here (mis-crediting an unrelated real plan into inSync/pausedRefs/orphanRows) but
// correctly to nothing via the other walks. One resolver for every slug→id derivation in this
// file now; a `null` result skips the row exactly as the old try/catch did.
export function presentRowsFromBoard(content) {
  if (content == null) return [];
  const { body } = safeSplitBoardBody(content);
  const rows = [];
  for (const { cells } of dataRowsOf(body.split('\n'))) {
    if (!PRESENT_STATES.has(cells[2])) continue;
    const planId = resolveSlugPlanId(cells[0]);
    if (!planId) continue;
    rows.push({ slug: cells[0], planId, state: cells[2] });
  }
  return rows;
}

// ACTIVE board rows → [{ slug, planId }]. Skips header, separator, PAUSED/LANDING.
// This is the orphan-ROW side of the classification and its semantics must stay
// ACTIVE-only (do not widen it) — it is a thin filter over presentRowsFromBoard so
// the actual parsing lives in one place.
export function activeRowsFromBoard(content) {
  return presentRowsFromBoard(content)
    .filter((r) => r.state === ACTIVE)
    .map(({ slug, planId }) => ({ slug, planId }));
}

// plan 3814: EVERY data row in any NON-TERMINAL state — not just the PRESENT_STATES trio. A row
// outside {ACTIVE, LANDING, PAUSED} (an "IN PROGRESS"-shaped or any other live-but-not-in-the-
// trio board state) is still direct evidence a plan is not abandoned; the 2026-09-07 near-miss
// was exactly a ref whose row sat in such a state and so contributed no liveness at all under
// presentRowsFromBoard's trio filter. A sibling of presentRowsFromBoard (same dataRowsOf walk)
// rather than a variant of it — the trio-only semantics of presentRowsFromBoard/
// activeRowsFromBoard are UNCHANGED and other buckets still depend on them.
//
// plan 3814 review fix (F1, finding a8b20e CONFIRMED): "any state" originally meant literally
// any state, TERMINAL board markers (✅ DONE-ON-BRANCH, 🧹 SUPERSEDED) included — both of which
// are meant to persist on the board after a plan is archived/superseded, not evidence of a live
// claim. A crashed session that reached one of those states but never released its claim ref
// was then pulled into `live` and never again offered remediation, permanently. Excluded here
// via board-lib.mjs's TERMINAL_STATES — the single home for that vocabulary — never a
// hand-typed literal.
//
// plan 3814 review fix (F2/F3): resolves each slug through the shared resolveSlugPlanId rather
// than a second inline planIdOf try/catch — an unresolvable slug (a legacy bare slug with no
// digit prefix, or one whose leading digits would resolve to a WRONG plan id) is recorded in
// `unresolvedSlugs` instead of being silently dropped, so main() can mark the whole board-row
// liveness view untrusted rather than quietly crediting nothing.
// plan 3814 review fix round 2 (F1, finding 2e43ea CONFIRMED): same null-content guard as
// presentRowsFromBoard above, for the same reason — see that function's header comment.
// plan 3814 review fix round 3 (F4, findings 1367f2/7a883b CONFIRMED): non-null but malformed
// content (no BOARD-START/BOARD-END sentinels) now degrades the same way via safeSplitBoardBody
// instead of letting splitBoard's throw escape — see that helper's header comment. `malformed` is
// carried on the return so main() can fold it into the same "board view untrusted" gate the
// unresolved-slugs check already uses, and print its own NOTE.
export function allRowsFromBoard(content) {
  if (content == null) return { rows: [], unresolvedSlugs: [], malformed: false };
  const { body, malformed } = safeSplitBoardBody(content);
  const rows = [];
  const unresolvedSlugs = [];
  for (const { cells } of dataRowsOf(body.split('\n'))) {
    if (TERMINAL_STATES_SET.has(cells[2])) continue;
    const planId = resolveSlugPlanId(cells[0]);
    if (!planId) {
      unresolvedSlugs.push(cells[0]);
      continue;
    }
    rows.push({ slug: cells[0], planId, state: cells[2] });
  }
  return { rows, unresolvedSlugs, malformed };
}

// Four-way classification of the claim refs vs the present board rows (plan 2818):
//   inSync     — ACTIVE or LANDING row whose planId has a claim ref.
//   pausedRefs — refs whose ONLY present row(s) are PAUSED: a paused session's claim,
//                not an orphan.
//   orphanRows — ACTIVE row with no claim ref (unchanged; PAUSED/LANDING rows with no
//                ref are NOT orphan-rows — do not widen the report's noise floor).
//   orphanRefs — refs with no present row of any of the three states.
// A ref backed by a 🟢 LANDING row must never land in orphanRefs — a LANDING row is
// the strongest liveness proof the board has.
export function classifyReconcile({ claimsMap, presentRows }) {
  const claimedIds = new Set(Object.keys(claimsMap));
  const activeRows = presentRows.filter((r) => r.state === ACTIVE);
  // plan 2818 (round 2, G3): "live" used to be two hand-listed literals
  // (`r.state === ACTIVE || r.state === LANDING_STATE`) — the same hard-coded-vocabulary
  // drift F7 already fixed once for PRESENT_STATES. Derive it instead as "present, minus
  // paused" so a future addition to the shared IN_FLIGHT_STATES/PRESENT_STATES list lands
  // in `live` by construction instead of falling through both `live` and `paused` and being
  // silently dropped from every bucket this function returns. Semantics unchanged today:
  // PRESENT_STATES is exactly {ACTIVE, LANDING, PAUSED}, so live = ACTIVE or LANDING.
  const liveRows = presentRows.filter(
    (r) => PRESENT_STATES.has(r.state) && r.state !== PAUSED_STATE,
  );
  const pausedRows = presentRows.filter((r) => r.state === PAUSED_STATE);
  const liveRowIds = new Set(liveRows.map((r) => r.planId));
  const pausedRowIds = new Set(pausedRows.map((r) => r.planId));
  const presentIds = new Set(presentRows.map((r) => r.planId));

  return {
    inSync: liveRows.filter((r) => claimedIds.has(r.planId)),
    pausedRefs: Object.keys(claimsMap)
      .filter((id) => pausedRowIds.has(id) && !liveRowIds.has(id))
      .map((id) => ({ planId: id, sha: claimsMap[id] })),
    orphanRows: activeRows.filter((r) => !claimedIds.has(r.planId)),
    orphanRefs: Object.keys(claimsMap)
      .filter((id) => !presentIds.has(id))
      .map((id) => ({ planId: id, sha: claimsMap[id] })),
  };
}

// plan 3814: landing-queue entries → the Set of plan ids they resolve to. A regular
// single-plan slug ("3814-Coord-reconcile-…") resolves via the same shared resolver every
// other slug→id derivation in this file uses.
//
// plan 3814 review fix (F2/F3, findings 75d315/a7951e/44d094/856bb4/b74463/d78cbb/9e2b7a/ad2318):
// a BATCH TRAIN's queue slug (e.g. "batch-2026-08-06-sonnet-smalls", no leading digit id) and a
// legacy bare slug with no numeric prefix ("akut-card-…", which landing-queue.mjs stores
// verbatim and assertWritableSlug permits) both defeat resolveSlugPlanId. The pre-fix version
// silently DROPPED such an entry — no credit, no signal that the drop happened — which means a
// live batch member's or legacy claim's individual claim ref got NO queue liveness credit from
// this check and could be handed a `--force` remediation line: the exact destructive false
// positive this plan exists to remove. Every unresolved slug is now recorded in
// `unresolvedSlugs` instead, so main() can mark the WHOLE queue view untrusted (queueVerified =
// false) rather than silently crediting nothing — the fail-safe direction: never claim "no
// slot" from a view this reporter could not fully read.
export function queuePlanIds(entries) {
  const ids = new Set();
  const unresolvedSlugs = [];
  for (const e of entries) {
    const id = resolveSlugPlanId(e.slug);
    if (id) ids.add(id);
    else unresolvedSlugs.push(e.slug);
  }
  return { ids, unresolvedSlugs };
}

// plan 3814: the two remaining liveness gaps beyond plan 2818's three-way board classification
// — (a) a board row in ANY state (allRowIds) and (b) a landing-queue slot (queueSlugIds) — as a
// POST-FILTER over classifyReconcile's `orphanRefs`. Pulls a matching ref OUT into a `live`
// bucket carrying WHY, leaving the plan-2818 bucket semantics (inSync/pausedRefs/orphanRows/
// orphanRefs) exactly as classifyReconcile already computed them — this never widens
// `orphanRows`, and it runs in main() AFTER the plan-3756 released-tombstone filter so a
// released ref can never be resurrected into `live` by a stale board/queue signal.
export function splitLiveOrphanRefs(orphanRefs, { allRowIds, queueSlugIds }) {
  const live = [];
  const stillOrphan = [];
  for (const r of orphanRefs) {
    const onBoard = allRowIds.has(r.planId);
    const onQueue = queueSlugIds.has(r.planId);
    if (onBoard || onQueue) {
      const liveReason = onBoard && onQueue ? 'queue+board' : onBoard ? 'board' : 'queue';
      live.push({ ...r, liveReason });
    } else {
      stillOrphan.push(r);
    }
  }
  return { live, orphanRefs: stillOrphan };
}

// Orphan-refs older than staleMin (age from the claim commit's iso). Unknown age
// (unparseable iso) counts as stale — it can't be proven healthy.
export function staleRefs(orphanRefs, { nowMs, staleMin = 35 }) {
  return orphanRefs.filter((r) => {
    const t = Date.parse(r.iso);
    if (Number.isNaN(t)) return true;
    return (nowMs - t) / 60000 > staleMin;
  });
}

// plan 2818 (round 2, G1/G2/G9): the per-orphan-ref REPORT flag + whether the destructive
// `--force` remediation line should print — pulled out of main() so both round-1 regressions
// are unit-testable instead of stdout-scraped.
//
// G1: an `holderUnreadable` ref (this run's enrichment fetch/cat-file threw — a transient
// failure, or a sibling releasing/re-acquiring the ref mid-read) must NEVER get the `--force`
// line. Pre-fix, its `iso` stayed undefined, `staleRefs`'s own (unchanged, correct-for-its-
// actual-purpose) unknown-iso→stale rule then flagged it STALE, and the report printed
// `--force` against a claim that merely could not be READ this run — the exact destructive
// false positive this whole plan exists to eliminate, reintroduced by the previous round's
// per-ref try/catch. It gets its own flag, UNREADABLE, distinct from STALE/recent.
//
// G2: when the board view itself is the LOCAL-FALLBACK (`boardVerified: false` — origin was
// unreachable this run), every orphan-ref verdict was computed against an unverified, possibly
// -stale board: the very staleness class that produced the original false positive. Remediation
// is suppressed across the board in that case, readable rows included — they still print, just
// advisory, pending a re-run against origin.
export function remediationFor(r, { stale, boardVerified }) {
  if (r.holderUnreadable) {
    return {
      flag: 'UNREADABLE',
      remediate: false,
      note: ' holder record unreadable this run — re-run before judging; do NOT force-release on this basis.',
    };
  }
  const isStale = stale.has(r.planId);
  return {
    flag: isStale ? 'STALE' : 'recent',
    remediate: isStale && boardVerified,
    note: '',
  };
}

// plan 1475 (item 3): the 5s-capped ls-remote is now coord-git's shared `lsRemoteTimed` (folded
// from the three hand-rolled copies plan 1398 item 7 spread the timeout across — this one plus
// post-checkout-claim-guard's claimRefExists and sweep-acquire-residue's hasClaimRef). The cap
// keeps this read-only reporter from hanging on an unreachable/offline origin. `_git` stays the
// injectable test seam, threaded straight through.
// Side-channel for the ref each claim was found on (populated by fetchClaimsMap). Kept out of
// the returned map because every existing caller treats its values as shas.
const claimRefByPlanId = new Map();
export function fetchClaimsMap(mainDir, { _git = git } = {}) {
  // plan 3756 review: a claim ref outliving its claim (the release tombstone) means ref
  // EXISTENCE is no longer holding. heldClaimsMap resolves the tips — one capped fetch for
  // the whole namespace, both namespaces covered — so a landed plan stops reading as claimed.
  //
  // Filtering only in the orphan loop below would have been too late: this map also decides
  // inSync and pausedRefs, so a released ref would still have been reported as a live claim
  // against a board row.
  const held = heldClaimsMap(mainDir, { _git });
  // sha keyed by id, as every caller expects, plus the ref that ANSWERED so the report can name
  // a ref that actually exists rather than assuming a namespace.
  claimRefByPlanId.clear();
  for (const [id, v] of Object.entries(held)) claimRefByPlanId.set(id, v.ref);
  return Object.fromEntries(Object.entries(held).map(([id, v]) => [id, v.sha]));
}

// plan 2818 (F4): fetchClaimsMap above reads the LIVE remote refs/claims/* from origin, but
// main() used to read the board from this checkout's MUTABLE LOCAL working tree — so a claim
// whose board row exists only on origin/master (not yet fetched/merged into this checkout)
// was reported ORPHAN-REF, the exact false positive plan 2818 removed from the other side of
// the comparison. Measured live 2026-08-04: refs/claims/2818 reported ORPHAN-REF while its
// 🔄 ACTIVE row was already present on origin/master. Also required by CLAUDE.md's "Fetch
// before judging … reason about `origin/master`, not drifting local refs". Reads the board
// from origin/master (bounded fetch + `git show`, both capped at GIT_TIMEOUT_MS like every
// other read this reporter does); on ANY failure (offline, unreadable ref/path) falls back to
// the local working-tree copy. Either way the returned `source` says which view judged the
// run, so the CLI summary can show it. `_git` is the same injectable test seam fetchClaimsMap
// uses.
//
// Why this does NOT delegate to coord-git.mjs's `readTrackedFileFresh`, despite that helper
// owning a superficially identical fetch → `git show origin/master:<rel>` → local-fallback
// sequence: the two differ on the ONE property this reporter is built around. That helper
// SWALLOWS a failed fetch ("offline — the local copy is the best available view") and then
// still runs the `show`, which SUCCEEDS off this checkout's stale cached
// refs/remotes/origin/master — so a fetch failure yields content labelled `origin/master`
// that may be arbitrarily out of date. Here that mislabelling is destructive: `main()` keys
// `boardVerified` off this source, and a verified board is what unlocks the
// `release-claim --force` remediation line. Keeping fetch and show in ONE try block means a
// fetch failure falls through to the local fallback and the run is correctly marked
// unverified, which suppresses every remediation (see remediationFor). A plan-2818 round-2
// delegation attempt was reverted for exactly this reason — the shared helper is right for
// its own callers, whose worst case on a stale read is a merely-outdated view rather than a
// wrong destructive suggestion.
// plan 3814 review fix (F5, findings 33dddb/a2133b/88ceba/9db9c8): fetchOriginMasterForReconcile
// + readCoordFileForReconcile below COLLAPSE what used to be two near-identical functions
// (readBoardForReconcile, readQueueForReconcile) that each ran their OWN `git fetch origin
// master` — so a single run of this reporter paid the fetch cost twice for the exact same ref.
// The fetch is now a single call, its boolean verdict threaded into both coordination-file
// reads. `_git` stays the injectable test seam every other read in this file uses.
export function fetchOriginMasterForReconcile(mainDir, { _git = git } = {}) {
  try {
    _git(mainDir, ['fetch', '--quiet', 'origin', 'master'], { timeout: GIT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

// plan 2818 (F4) / plan 3814 review fix (F5): the ONE coordination-file reader, now shared by
// the board read and the landing-queue read — collapsing readBoardForReconcile and
// readQueueForReconcile, which differed only in the queue side's extra `content: null`
// "totally unreadable" outcome (kept here: the board file is always expected to exist in a
// coordination checkout, so that branch is simply never exercised for board reads, but there is
// no harm in the board path having it too). `fetchOk` is this run's single
// fetchOriginMasterForReconcile() verdict — NEVER attempt `show` when it is false; that is
// exactly the property the long comment below explains this file must have, and the very reason
// readTrackedFileFresh is wrong for this reporter's purposes despite looking superficially
// identical.
//
// Why this does NOT delegate to coord-git.mjs's `readTrackedFileFresh`, despite that helper
// owning a superficially identical fetch → `git show origin/master:<rel>` → local-fallback
// sequence: the two differ on the ONE property this reporter is built around. That helper
// SWALLOWS a failed fetch ("offline — the local copy is the best available view") and then
// still runs the `show`, which SUCCEEDS off this checkout's stale cached
// refs/remotes/origin/master — so a fetch failure yields content labelled `origin/master`
// that may be arbitrarily out of date. Here that mislabelling is destructive: `main()` keys
// `boardVerified`/`queueVerified` off `source`, and a verified view is what unlocks the
// `release-claim --force` remediation line. Gating the `show` on `fetchOk` means a failed fetch
// (or one this run never attempted) falls straight through to the local fallback and the read is
// correctly marked unverified, which suppresses every remediation (see remediationFor). A
// plan-2818 round-2 delegation attempt was reverted for exactly this reason — the shared helper
// is right for its own callers, whose worst case on a stale read is a merely-outdated view
// rather than a wrong destructive suggestion.
// plan 3814 review fix round 2 (F5, finding f79c7b CONFIRMED, minor): `fetchOk`'s tri-state
// default used to be `undefined`, whose meaning was unclear — it fell through the `fetchOk ===
// false` check (only an EXPLICIT `false` skipped `show`) and attempted `show` anyway, same as
// `true`. Defaulting to `false` makes an omitted `fetchOk` behave identically to an explicit
// `fetchOk: false` — the fail-safe direction (skip `show`, go straight to the local fallback) —
// rather than silently behaving like `true`. No caller passes `fetchOk` as `undefined` on
// purpose: main() always threads a real boolean from fetchOriginMasterForReconcile(), and every
// test call site passes an explicit `true`/`false`.
export function readCoordFileForReconcile(mainDir, rel, { _git = git, fetchOk = false } = {}) {
  try {
    if (fetchOk === false) throw new Error('origin fetch failed this run — skip show');
    const content = _git(mainDir, ['show', `origin/master:${rel}`], { timeout: GIT_TIMEOUT_MS });
    return { content, source: 'origin/master' };
  } catch {
    try {
      return {
        content: readFileSync(join(mainDir, rel), 'utf8'),
        source: 'local working tree (origin read failed)',
      };
    } catch {
      return { content: null, source: 'unreadable' };
    }
  }
}

// plan 3973: the queue twin of readCoordFileForReconcile. Same contract — `source` is what
// main() keys `queueVerified` off, and only a read this run FETCHED and found on origin earns
// the verified label — but the doc now comes from the coord ref through the accessor. The
// accessor's own explicit-refspec fetch is the freshness proof (its `fetched` flag), so this
// does NOT gate on the master fetch's `fetchOk`; a failed ref fetch degrades to the cached
// tracking ref labelled unverified, and a faulted read (an unreadable ref, or the D4 loud-fail
// when an old-code session still wrote the master doc) is `content: null` — "unreadable",
// which suppresses every remediation exactly as an unreadable board does.
export function readQueueDocForReconcile(mainDir, { _readQueueDoc = readQueueDoc } = {}) {
  let q;
  try {
    q = _readQueueDoc(mainDir, { fetch: true });
  } catch (e) {
    return { content: null, source: `unreadable (${e?.message ?? e})` };
  }
  if (q.fault) return { content: null, source: `unreadable (${q.fault.message})` };
  if (q.fetched && (q.source === 'ref' || q.source === 'empty' || q.source === 'master')) {
    return { content: q.doc, source: 'origin/master' };
  }
  return { content: q.doc, source: `${QUEUE_REF} (cached tracking ref — origin fetch failed)` };
}

// plan 3814 review fix round 2 (F3, findings 52a59b/cc2964/002dce/df7f85/f7f03e/505879/eac968/
// 3369d4 CONFIRMED): round 1's F4 guard was `queueContent.includes(QUEUE_HEADER)` — a byte-exact
// substring search over the WHOLE document against the CURRENT 11-column header. Two defects:
//   (a) UNSCOPED — the header string appearing anywhere in the doc (prose, an audit note, a code
//       block) satisfied it, even while the actual QUEUE-START/QUEUE-END region was corrupt.
//   (b) REJECTS LEGACY FORMATS — a queue doc written with an older/narrower column set has a
//       different header row, so the byte-exact check failed, `queueVerified` went false, and
//       remediation was permanently suppressed on any such checkout — a usability regression, not
//       a safety gain.
// Scoped to the region between QUEUE_START/QUEUE_END (kept from round 2) — that part was right.
//
// plan 3814 review fix round 3 (F1, findings 603721/3f789f/b2620d/bbfad2/9aac6b/4aea76/f17cb9
// CONFIRMED): round 2's answer to (b) was WRONG and is corrected here. It accepted ANY pipe row
// in the region whose first cell is "slug", regardless of width. But `parseQueue`
// (landing-queue-lib.mjs) SKIPS any row with `cells.length < 6` when it walks the very same
// region (`if (!cells || cells.length < 6 || isSeparator(line)) continue;`) — so a header
// narrower than 6 cells is not a supported "legacy format" at all: every DATA row sitting under
// it is silently dropped by parseQueue's own parse, and round 2's relaxed check would still mark
// the view VERIFIED while it carries zero rows parseQueue can actually read. That is exactly the
// "verified but empty queue" hazard this guard exists to prevent — reintroduced from the other
// side. This threshold is therefore DELIBERATELY COUPLED to parseQueue's own `cells.length < 6`
// skip: the verifier must accept exactly what parseQueue can actually read, no more and no less.
// Relaxing ONE of these two thresholds without the other reintroduces the hazard — if a future
// change ever widens/narrows parseQueue's own minimum column count, this constant must move with
// it in the SAME change, not independently. `content == null` (an unreadable read, see F1 above)
// returns false rather than throwing on `.indexOf`.
export function queueRegionHasHeaderRow(content) {
  if (content == null) return false;
  const s = content.indexOf(QUEUE_START);
  const e = content.indexOf(QUEUE_END);
  if (s === -1 || e === -1 || e < s) return false;
  const region = content.slice(s + QUEUE_START.length, e);
  return region.split('\n').some((line) => {
    const cells = cellsOf(line);
    // The width threshold is parseQueue's OWN row-admission floor, imported (plan 3814 review
    // round 4) rather than re-typed: a verifier looser than the parser marks a queue verified
    // whose rows the parser silently drops, which is how a live queue slot becomes invisible and
    // a `--force` line gets printed against it. Round 3 held the two in lockstep with a comment;
    // this makes it structural, so the threshold cannot drift from the parser it must match.
    return !!cells && cells.length >= MIN_QUEUE_ROW_CELLS && cells[0] === 'slug';
  });
}

// plan 3814 review round 4: main()'s board-row trust gate, as a real exported predicate rather
// than an expression inlined in main(). The round-3 test for it re-derived
// `unresolvedSlugs.length === 0 && !malformed` in the test body, so it asserted its own copy of
// the rule and would have stayed green if main() dropped the `!malformed` term — a tautology that
// tests nothing. One owner, called by main() and by the test, so a regression in the gate fails
// the suite.
export function boardRowsVerifiedFrom({ unresolvedSlugs, malformed }) {
  return unresolvedSlugs.length === 0 && !malformed;
}

// --- CLI (integration) -------------------------------------------------------

// plan 3814 review fix (F6, finding 4c71c7): `Number(process.argv[i+1])` yields NaN for a
// missing/garbage `--stale-min` value (a trailing flag with nothing after it, or a typo'd
// non-numeric argument) — every `>` comparison in staleRefs then goes false for EVERY
// orphan-ref (`x > NaN` is always false), so nothing is ever reported stale and remediation
// silently never prints, with no error to explain why. Falls back to `defaultStaleMin` (with a
// stderr note) on any non-finite or negative value instead of going silently inert. Exported and
// pure (argv injected) so the NaN case is directly testable without spawning the CLI.
export function resolveStaleMin(argv, defaultStaleMin = 35) {
  const i = argv.indexOf('--stale-min');
  if (i === -1) return defaultStaleMin;
  const raw = argv[i + 1];
  // plan 3814 review fix round 2 (F2, findings 626824/d9b36d/2a4fb6 CONFIRMED): `Number('')` is
  // `0` — finite and non-negative — so a missing/blank/whitespace-only value used to sail past
  // the `!Number.isFinite(n) || n < 0` guard and silently become a 0-minute staleness threshold,
  // flagging EVERY orphan-ref stale and inviting `--force` against all of them. Reject a
  // missing/blank/whitespace-only value explicitly, BEFORE the Number() coercion — an explicit,
  // non-blank `--stale-min 0` stays legal (falls through to the normal numeric check below).
  if (raw === undefined || String(raw).trim() === '') {
    console.error(
      `reconcile-board: --stale-min value "${raw ?? ''}" is not a valid non-negative number — using default ${defaultStaleMin}m`,
    );
    return defaultStaleMin;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(
      `reconcile-board: --stale-min value "${raw}" is not a valid non-negative number — using default ${defaultStaleMin}m`,
    );
    return defaultStaleMin;
  }
  return n;
}

function main() {
  const staleMin = resolveStaleMin(process.argv);
  const mainDir = resolveMain();
  const { paths } = loadCoordConfig(mainDir);
  const claimsMap = fetchClaimsMap(mainDir);
  // plan 3814 review fix (F5): ONE fetch for this whole run, its verdict threaded into both
  // the board read and the queue read below — see readCoordFileForReconcile's header comment.
  const fetchOk = fetchOriginMasterForReconcile(mainDir);
  const { content: board, source: boardSource } = readCoordFileForReconcile(
    mainDir,
    paths.boardFile,
    { fetchOk },
  );
  const presentRows = presentRowsFromBoard(board);
  // plan 3814 gap (a): every board row in a NON-TERMINAL state — not just the
  // ACTIVE/LANDING/PAUSED trio — is a liveness signal for the orphan-ref split below.
  // plan 3814 review fix (F2/F3): `boardUnresolvedSlugs` names every row slug allRowsFromBoard
  // could not safely resolve to a plan id — a non-empty list makes this whole liveness view
  // untrusted (see `verified` below), never silently "no credit".
  // plan 3814 review fix round 3 (F4): `boardMalformed` is allRowsFromBoard's signal that
  // `content` was non-null but had no BOARD-START/BOARD-END sentinels — folded into
  // `boardRowsVerified` below alongside the unresolved-slugs check, and reported via its own NOTE.
  const {
    rows: allBoardRows,
    unresolvedSlugs: boardUnresolvedSlugs,
    malformed: boardMalformed,
  } = allRowsFromBoard(board);
  const allRowIds = new Set(allBoardRows.map((r) => r.planId));
  // plan 3814 gap (b): the landing queue, read the same way as the board (bounded, origin
  // first, local fallback, never hanging) — a slug holding a queue slot is the strongest
  // in-flight signal outside the board itself. `queueContent === null` means BOTH the origin
  // and local reads failed. `queueParsedOk` also catches a sentinel-less/corrupt queue doc
  // (parseQueue throws on either) — plan 3814 review fix (F4, findings d9c7fe/bda999/0ab1cb):
  // AND now requires the parsed content to actually contain the queue table's HEADER row, since
  // parseQueue returns `entries: []` WITHOUT throwing when both sentinel pairs survive but the
  // header/data rows themselves are gone — that used to read as a verified, genuinely-empty
  // queue. A real empty queue (header present, zero data rows) still parses ok and stays
  // verified; only a header-less (corrupt) body is downgraded. Any of these failures leaves
  // `queueSlugIds` empty AND `queueVerified` (below) false — the fail-safe posture the plan
  // requires: never assume "no slot" from a read that never happened or came back corrupt, only
  // from one that DID happen cleanly and came up empty.
  const { content: queueContent, source: queueSource } = readQueueDocForReconcile(mainDir);
  let queueEntries = [];
  let queueParsedOk = false;
  if (queueContent != null) {
    try {
      const parsed = parseQueue(queueContent);
      // plan 3814 review fix round 2 (F3): scoped, format-tolerant header check — see
      // queueRegionHasHeaderRow's header comment for what this replaces and why.
      if (queueRegionHasHeaderRow(queueContent)) {
        queueEntries = parsed.entries;
        queueParsedOk = true;
      }
    } catch {
      /* sentinel-less or otherwise unparseable queue doc — degrade to unverified, empty */
    }
  }
  // plan 3814 review fix (F2/F3): same untrusted-on-unresolved posture as the board side.
  const { ids: queueSlugIds, unresolvedSlugs: queueUnresolvedSlugs } = queuePlanIds(queueEntries);
  // `orphanRefs` is re-bound below once each ref's tip has been read (plan 3756).
  let { inSync, pausedRefs, orphanRows, orphanRefs } = classifyReconcile({
    claimsMap,
    presentRows,
  });

  // enrich orphan-refs with the holder identity + iso for the staleness + report. plan 2818
  // (F5): each ref's enrichment is timeout-capped AND independently try/catched — an
  // unbounded fetch could hang the whole run (now a MANDATORY step of every cloud firing, per
  // the prompt-lib claim-drift-report change), and a sibling releasing or re-acquiring
  // refs/claims/<id> between fetchClaimsMap's ls-remote and this cat-file can make the
  // recorded r.sha unreachable — pre-fix that threw and crashed main()'s outer handler (exit
  // 2), suppressing the summary and every other finding. A failure here degrades only THAT
  // row (its holder fields stay undefined — the report already renders `?` for them) so the
  // loop always completes and the summary always prints.
  // Every ref-shaped row gets the ref that ANSWERED, not just the orphans — the PAUSED-REF
  // lines are printed from a different list and would otherwise assume a namespace.
  for (const r of [...orphanRefs, ...pausedRefs]) r.ref = claimRefByPlanId.get(r.planId) ?? null;
  for (const r of orphanRefs) {
    try {
      // One ref at a time, tolerating absence: `git fetch origin <a> <b>` fails outright if
      // EITHER is missing, and during the migration window one of the two always is.
      for (const cand of claimRefCandidates(r.planId)) {
        try {
          git(mainDir, ['fetch', '--quiet', 'origin', cand], { timeout: GIT_TIMEOUT_MS });
        } catch {
          /* absent in this namespace — the other one carries it */
        }
      }
      const raw = git(mainDir, ['cat-file', 'commit', r.sha], { timeout: GIT_TIMEOUT_MS });
      const body = raw.slice(raw.indexOf('\n\n') + 2);
      Object.assign(r, parseClaimMessage(body) || {});
    } catch {
      r.holderUnreadable = true;
    }
  }
  // plan 3756: a released claim is a ref pointing at a tombstone, not an absent ref, so the
  // ls-remote above reports it exactly like a live one. Left unfiltered, every landed plan
  // would show up here as an ORPHAN-REF and the report would invite an operator to
  // force-release a lock nobody holds — the opposite of what this reporter is for. `released`
  // comes from parseClaimMessage in the loop just above, so this costs no extra read.
  orphanRefs = orphanRefs.filter((r) => !r.released);
  // plan 3814: pull out any orphan-ref that carries a board row (any state) or a landing-queue
  // slot — run AFTER the released-tombstone filter above so a released ref can never be
  // resurrected into `live` by a stale board/queue signal (a landed plan's old row/slot).
  const { live, orphanRefs: stillOrphanRefs } = splitLiveOrphanRefs(orphanRefs, {
    allRowIds,
    queueSlugIds,
  });
  orphanRefs = stillOrphanRefs;
  const nowMs = Date.now();
  const stale = new Set(staleRefs(orphanRefs, { nowMs, staleMin }).map((r) => r.planId));
  // plan 2818 (round 2, G2): only an origin-resolved board is verified — the local-fallback
  // view (origin unreachable this run) is unverified, so remediationFor suppresses `--force`
  // for every orphan-ref when this is false, however stale-looking each individually is.
  const boardVerified = boardSource === 'origin/master';
  // plan 3814 review fix (F2/F3): a board row this run could not resolve to a plan id makes the
  // board-row liveness view untrusted too — the akut-card-… shape named in the review findings.
  // plan 3814 review fix round 3 (F4): a malformed (non-null, no-sentinels) board content also
  // untrusts this view — see allRowsFromBoard's/safeSplitBoardBody's header comments.
  const boardRowsVerified = boardRowsVerifiedFrom({
    unresolvedSlugs: boardUnresolvedSlugs,
    malformed: boardMalformed,
  });
  // plan 3814: same posture on the queue side — a queue read that never reached origin (or
  // never parsed at all) cannot be trusted to prove "no slot", so it suppresses remediation
  // exactly like an unverified board does. plan 3814 review fix (F2/F3): an unresolved queue
  // slug (a batch-train slug, a legacy bare slug) is folded into the same untrusted verdict.
  // All folded into ONE `verified` gate passed to remediationFor as `boardVerified` —
  // remediationFor's own contract/tests are untouched; this is a caller-side combination of the
  // independent verification axes.
  const queueVerified =
    queueSource === 'origin/master' && queueParsedOk && queueUnresolvedSlugs.length === 0;
  const verified = boardVerified && boardRowsVerified && queueVerified;

  console.log(
    `reconcile-board: ${inSync.length} in-sync, ${orphanRefs.length} orphan-ref, ${live.length} live (queue/board), ${pausedRefs.length} paused-ref, ${orphanRows.length} orphan-row (board: ${boardSource}, queue: ${queueSource})`,
  );
  // plan 3814 review fix round 2 (F1, finding 2e43ea CONFIRMED): a board source of 'unreadable'
  // means BOTH origin AND the local working tree failed — presentRowsFromBoard/allRowsFromBoard
  // degraded to an empty view rather than throwing (see their header comments), so this run's
  // board-row liveness signal is entirely absent, not merely stale. Distinct wording from the
  // local-fallback note below: there IS no fallback view here to call "advisory".
  if (boardSource === 'unreadable') {
    console.log(
      '  NOTE: board view is UNREADABLE this run (origin read failed AND no local working-tree copy) — treated as empty; the orphan-ref rows below carry no board-row liveness signal at all; re-run before any release.',
    );
  } else if (!boardVerified) {
    console.log(
      '  NOTE: board view is unverified (origin read failed; using local working tree) — the orphan-ref rows below are advisory only; re-run against origin before any release.',
    );
  }
  if (boardUnresolvedSlugs.length) {
    console.log(
      `  NOTE: board view carries ${boardUnresolvedSlugs.length} unresolvable slug(s) (${boardUnresolvedSlugs.join(', ')}) — a live plan behind one of these could be missed; remediation is suppressed until resolved.`,
    );
  }
  // plan 3814 review fix round 3 (F4, findings 1367f2/7a883b CONFIRMED): the board read
  // succeeded (non-null content) but the content itself has no BOARD-START/BOARD-END sentinels —
  // distinct from both the 'unreadable' (read failed) and unresolved-slug cases above.
  if (boardMalformed) {
    console.log(
      '  NOTE: board content is malformed (missing BOARD-START/BOARD-END sentinels) — treated as empty; remediation is suppressed until resolved.',
    );
  }
  if (!queueVerified) {
    console.log(
      '  NOTE: landing-queue view is unverified (origin read/parse failed) — a ref could hold a live queue slot this run cannot see; remediation is suppressed until a clean re-run.',
    );
  }
  if (queueUnresolvedSlugs.length) {
    console.log(
      `  NOTE: landing-queue view carries ${queueUnresolvedSlugs.length} unresolvable slug(s) (${queueUnresolvedSlugs.join(', ')}) — a live queue slot behind one of these could be missed; remediation is suppressed until resolved.`,
    );
  }
  for (const r of live) {
    console.log(
      `  LIVE ${r.ref ?? claimRef(r.planId)} (${r.liveReason}) — held by session ${r.sessionUuid ?? '?'} host ${r.host ?? '?'} since ${r.iso ?? '?'}; ${r.liveReason === 'queue+board' ? 'has a landing-queue slot AND a board row' : r.liveReason === 'queue' ? 'has a landing-queue slot' : 'has a board row'} outside ACTIVE/LANDING/PAUSED — not an orphan, no remediation.`,
    );
  }
  for (const r of orphanRefs) {
    const { flag, remediate, note } = remediationFor(r, { stale, boardVerified: verified });
    console.log(
      `  ORPHAN-REF ${r.ref ?? claimRef(r.planId)} (${flag}) — held by session ${r.sessionUuid ?? '?'} host ${r.host ?? '?'} since ${r.iso ?? '?'}; no ACTIVE/LANDING/PAUSED board row.${note}`,
    );
    if (remediate)
      console.log(
        `    → held; no landing-queue slot; no board row of any state; age > ${staleMin}m → if dead: node scripts/release-claim.mjs release ${r.planId} --force`,
      );
  }
  for (const r of pausedRefs) {
    console.log(
      `  PAUSED-REF ${r.ref ?? claimRef(r.planId)} — board row ⏸ PAUSED; a paused session's claim, not an orphan (no remediation).`,
    );
  }
  for (const r of orphanRows) {
    console.log(
      `  ORPHAN-ROW ${r.slug} — board ACTIVE but no live claim ref for plan ${r.planId} (old-style claim, or a row left behind by a release).`,
    );
  }
  return 0; // report-only, never gates a push
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error('reconcile-board:', e.message);
    process.exit(2);
  }
}
