// scripts/coord/board-lib.mjs
// Pure, git-free board (the coordination board file) parsing + row mutation.
// Rows are a markdown table between BOARD-START / BOARD-END sentinels.
// Columns (0-indexed): 0 Worktree(slug) | 1 Branch tip | 2 State | 3 Plan/claim | 4 Last touched | 5 Resume.

export const BOARD_START = '<!-- BOARD-START -->';
export const BOARD_END = '<!-- BOARD-END -->';

export function splitBoard(content) {
  const s = content.indexOf(BOARD_START);
  const e = content.indexOf(BOARD_END);
  if (s === -1 || e === -1 || e < s) {
    // code: typed discriminator (plan 2082) so callers that treat a sentinel-less
    // board as a benign no-op (move-plan's syncBoardPlanRefs) key on it, not on
    // this message's exact wording.
    throw Object.assign(
      new Error('board-lib: BOARD-START/BOARD-END sentinels not found (is this the board file?)'),
      { code: 'NO_BOARD_SENTINELS' },
    );
  }
  return {
    head: content.slice(0, s + BOARD_START.length),
    body: content.slice(s + BOARD_START.length, e),
    tail: content.slice(e),
  };
}

export function cellsOf(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  return t
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

// Body rows whose STATE COLUMN (cell 2) is exactly `🟢 LANDING`, excluding the
// row for `exceptSlug` (cell 0). Column-aware on purpose: a substring scan for
// "🟢 LANDING" also matches the literal text inside another row's resume prose
// (e.g. "QUEUED behind X's 🟢 LANDING mutex"), which falsely reports the mutex
// as held — a coordination DEADLOCK (plan 230). Header/separator rows have a
// non-matching cell 2 and are naturally excluded.
export function landingRows(body, exceptSlug) {
  return body.split('\n').filter((l) => {
    const cells = cellsOf(l);
    if (!cells || cells.length < 3) return false;
    if (cells[2] !== '🟢 LANDING') return false;
    return !(exceptSlug && cells[0] === exceptSlug);
  });
}

// exported since plan 504 — landing-queue-lib.mjs parses the same table shape
export function isSeparator(line) {
  return /^\|[\s|:-]+\|$/.test(line.trim());
}

// DATA rows of the body's line array — skips non-table lines, the separator row, and
// exactly the first table row (the header). The single owner of the header/separator
// convention: findRowLineIndex and rowSlugsForPlanIdLines both iterate through here, so
// a format change (second header row, different separator shape) lands in ONE loop.
// plan 2818: exported so `reconcile-board.mjs`'s `presentRowsFromBoard` shares this same
// walk instead of hand-rolling a second copy of the header/separator convention — a
// change to the shared parser would otherwise silently make that reporter skip live rows.
export function* dataRowsOf(lines) {
  let seenHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const cells = cellsOf(lines[i]);
    if (!cells) continue;
    if (isSeparator(lines[i])) continue;
    if (!seenHeader) {
      seenHeader = true; // first table row = header
      continue;
    }
    yield { i, cells };
  }
}

// Index (in the body's line array) of the data row whose slug (cell 0) matches.
// Skips the header row (first table row) and separator row. -1 if not found.
export function findRowLineIndex(lines, slug) {
  for (const { i, cells } of dataRowsOf(lines)) {
    if (cells[0] === slug) return i;
  }
  return -1;
}

// plan 1801: rows keyed by the STABLE plan id — a plan renamed while claimed (the execModel
// Infra↔FABLE stamp, any edit-plan rename) desyncs the row's claim-time slug from the plan's
// current basename, so slug-exact lookups miss the row and orphan it (the coord-spine9 1785
// derail). A member row's slug always begins with its plan id (`NNN[N]-PX-desc`); requiring a
// non-digit after `<id>-` blocks both an id-prefix false match (id 178 vs row `1785-…`) and
// legacy date-prefixed slugs (`2026-05-17-…` vs id 2026). Bare pre-convention slugs carry no
// id prefix and can't match here — callers union this with the basename-derived slug they
// already resolve (rowKeysForPlan below).
// A plan id is digits by construction (next-plan-id.mjs); anything else (a hand-corrupted
// manifest member) yields null up front — interpolating it into the RegExp would either throw
// on a metacharacter or false-match, and a non-digit "id" can never key a `NNN-PX-…` row.
//
// plan 2394 extracted this predicate from rowSlugsForPlanIdLines so the id-boundary rules
// above are enforced in exactly ONE place: a takeover's DEMOTE decision must key on the same
// row set a removal does, and two hand-copied matchers could disagree about which rows belong
// to the plan (the drift rowKeysForPlan was factored out to prevent, one layer down).
function planIdRowMatcher(planId) {
  const id = String(planId);
  if (!/^\d+$/.test(id)) return null;
  // Expressed through planIdOfRowSlug so the id-boundary rule has ONE definition, not two that
  // can drift. Same semantics as the previous hand-rolled `slug === id || /^<id>-(?=\D)/`.
  return (slug) => planIdOfRowSlug(slug) === id;
}

// plan 2932: the INVERSE of planIdRowMatcher, and now its implementation — which plan id does
// this row slug belong to, asked once per row instead of once per (row × candidate id).
// `/in-progress` walks the whole board building a per-plan index, so the matcher-per-id shape
// is quadratic there. The boundary rule is a bare id, or `<id>-` followed by a NON-DIGIT: that
// lookahead is what stops `2932-1-x` reading as plan 2932, and what keeps a longer id from
// prefix-matching a shorter one.
// INVARIANT: for any digit id, `planIdOfRowSlug(s) === id` exactly when `planIdRowMatcher(id)(s)`.
export function planIdOfRowSlug(slug) {
  return /^(\d+)(?:-(?=\D)|$)/.exec(String(slug ?? ''))?.[1] ?? null;
}

// plan 2394: the FULL rows a plan id owns — `state` (cell 2) and `planClaim` (cell 3)
// alongside the slug. `claim-plan acquire --resume` cannot decide whether a same-plan-id row
// is a dead holder's leftover or still-live work from the slug alone: a batch member's row
// carries a `batch=` marker in the claim cell, and a row mid-land carries 🟢 LANDING in the
// state cell. rowSlugsForPlanIdLines is now a projection of this, so the two lookups cannot
// drift on which rows match.
export function rowsForPlanIdLines(lines, planId) {
  const matches = planIdRowMatcher(planId);
  if (!matches) return [];
  const out = [];
  for (const { cells } of dataRowsOf(lines)) {
    if (matches(cells[0])) {
      out.push({ slug: cells[0], state: cells[2] ?? '', planClaim: cells[3] ?? '' });
    }
  }
  return out;
}

// Content-level wrapper; an unparseable / sentinel-less board yields [] (fail-closed,
// mirroring done-worktree's boardHasRow) — a caller can't key a removal on a board it
// can't parse anyway.
export function rowsForPlanId(content, planId) {
  try {
    return rowsForPlanIdLines(splitBoard(content).body.split('\n'), planId);
  } catch {
    return [];
  }
}

export function rowSlugsForPlanIdLines(lines, planId) {
  return rowsForPlanIdLines(lines, planId).map((r) => r.slug);
}

// plan 2394: the `batch=` marker claim-plan-lib's `boardBatchPlanClaimCell` stamps into the
// "Plan / claim" cell of every batch-member row (`… · 🟩 · batch=`<batch-slug>``). A plan id
// can LEGITIMATELY own a second 🔄 ACTIVE row as a batch member (plan 1364), so a takeover's
// demote pass must recognise and spare it.
// Deliberately LOOSE (no `·` separator, no backtick shape required): every misread must fall
// on the SAFE side. A false positive costs nothing — the row just keeps the pre-2394
// print-the-note behaviour and a human demotes it — whereas a false negative would flip a
// LIVE batch member to ⏸ PAUSED and silently detach it from a running batch train. A slug or
// plan basename can never contain `=` (claim-plan-lib's SLUG_CHARSET_RX), so in practice only
// that renderer emits this token.
// KEEP IN SYNC with claim-plan-lib.mjs `boardBatchPlanClaimCell` — the sole WRITER of the
// marker; this is the sole READER.
const BATCH_MARKER_RX = /\bbatch=/;

export function isBatchMemberCell(planClaimCell) {
  return BATCH_MARKER_RX.test(String(planClaimCell ?? ''));
}

// plan 2932: the marker's VALUE, not just its presence — the batch slug a member plan's land
// is queued under (`batch-2026-08-06-sonnet-smalls`), which carries no plan id and so cannot be
// derived from the row slug. `/in-progress` needs it to show a queued batch member its real
// FIFO position. Same grammar as BATCH_MARKER_RX above, in the SAME file, so the reader and the
// predicate cannot drift apart; the optional backticks match what claim-plan-lib's
// `boardBatchPlanClaimCell` writes. null when there is no marker.
const BATCH_VALUE_RX = /\bbatch=`?([^`\s|]+)`?/;
export function batchSlugOfCell(planClaimCell) {
  return BATCH_VALUE_RX.exec(String(planClaimCell ?? ''))?.[1] ?? null;
}

// plan 1801 (review-fix): the ONE owner of the "which board rows belong to this plan"
// union — planId-keyed rows (covers a rename desync) + the basename-derived slug the
// caller already resolved (covers legacy bare, id-less row slugs). Shared by claim-plan's
// projectDerail and done-worktree's closeOutBatch so the two removal paths cannot drift.
export function rowKeysForPlan(lines, planId, basenameSlug) {
  const keys = new Set(rowSlugsForPlanIdLines(lines, planId));
  if (basenameSlug) keys.add(basenameSlug);
  return [...keys];
}

export function renderRow({ slug, tip, state, planClaim, touched, resume }) {
  return `| ${slug} | ${tip} | ${state} | ${planClaim} | ${touched} | ${resume} |`;
}

// Exported since plan 2082: move-plan's board-row path sync (syncBoardPlanRefs)
// reuses the same splitBoard → per-line transform → head+body+tail reassembly as
// the five mutators below, so a change to the reassembly contract lands in ONE place.
export function withBody(content, transform) {
  const { head, body, tail } = splitBoard(content);
  const lines = body.split('\n');
  transform(lines);
  return head + lines.join('\n') + tail;
}

// Shared idx-or-absent guard for the three `tolerateAbsent` mutators (F-018). Factored after
// the 2026-07-04 review flagged the identical `if (idx === -1) { if (tolerateAbsent) return;
// throw }` block copy-pasted verbatim into setRowState/removeRow/stampLanding — a divergence
// risk (a future change to the tolerate-absent contract had to be edited in three places in
// lockstep; missing one silently reintroduces the very hard-fail-on-benign-race class F-018
// was filed to fix). Returns the row index, or -1 when the row is absent AND absence is
// tolerated (the caller then no-ops); throws the canonical "row not found" error otherwise.
function rowIndexOrAbsent(lines, slug, tolerateAbsent) {
  const idx = findRowLineIndex(lines, slug);
  if (idx === -1 && !tolerateAbsent) {
    throw new Error(`board-lib: row not found for slug "${slug}"`);
  }
  return idx;
}

// `tolerateAbsent` (F-018, plan 1313 coord audit): board.mjs's `set-state` is a documented
// teardown/op step (drain-run, done-worktree, and a manual CLI invocation all call it), and a
// sibling's concurrent close-out removing the row FIRST is a benign, idempotent-intent race —
// not a real error. The default (false) preserves the original hard-throw contract for any other
// caller that wants strict "this row must exist" semantics.
export function setRowState(content, slug, state, { tolerateAbsent = false } = {}) {
  return withBody(content, (lines) => {
    const idx = rowIndexOrAbsent(lines, slug, tolerateAbsent);
    if (idx === -1) return; // absent + tolerated — idempotent no-op, mirrors dequeueEntry
    const cells = cellsOf(lines[idx]);
    cells[2] = state;
    lines[idx] = `| ${cells.join(' | ')} |`;
  });
}

// The field-name → column-index map, and the one in-place field application both the
// single-row updateRow and the multi-row updateRows (plan 2394) share. Factored on the same
// grounds as rowIndexOrAbsent above: a second hand-copy of `{tip:1,state:2,…}` is a silent
// wrong-column write the moment the table gains a column.
const ROW_CELL_INDEX = { tip: 1, state: 2, planClaim: 3, touched: 4, resume: 5 };

function applyFields(lines, idx, fields) {
  const cells = cellsOf(lines[idx]);
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    cells[ROW_CELL_INDEX[k]] = v;
  }
  lines[idx] = `| ${cells.join(' | ')} |`;
}

// Update named cells of an existing row. fields: {tip,state,planClaim,touched,resume} (any subset).
export function updateRow(content, slug, fields) {
  return withBody(content, (lines) => {
    const idx = findRowLineIndex(lines, slug);
    if (idx === -1) throw new Error(`board-lib: row not found for slug "${slug}"`);
    applyFields(lines, idx, fields);
  });
}

// plan 2512: the Lines-level core of updateRows below — resolves EVERY target slug in ONE
// dataRowsOf walk (slug -> line index), then applies fields to each present row, instead of
// the pre-2512 per-slug findRowLineIndex call (each walking dataRowsOf from scratch: O(k*n)
// for k slugs). Mutates `lines` in place; safe because applyFields only ever replaces a cell
// within an existing line — it never changes the line COUNT, so the map built up front stays
// valid for every subsequent slug in this same pass (including a repeated slug, which mirrors
// the pre-2512 per-call findRowLineIndex behaviour of re-finding — and re-applying to — the
// same row). Exported so `claim-plan.mjs`'s `projectClaim` can apply a takeover's row
// demotions against a line array it already split once, without re-parsing board content
// `updateRows` (content-level) would otherwise re-split via `withBody`.
export function updateRowsLines(lines, slugs, fields) {
  const updated = [];
  const absent = [];
  const indexBySlug = new Map();
  for (const { i, cells } of dataRowsOf(lines)) {
    // First occurrence wins — matches findRowLineIndex/updateRow so a duplicate-slug board
    // state (an anomaly the machinery otherwise prevents) resolves to the SAME physical row
    // on every mutation path instead of silently diverging (plan 2542).
    if (!indexBySlug.has(cells[0])) indexBySlug.set(cells[0], i);
  }
  for (const slug of slugs) {
    const idx = indexBySlug.get(slug);
    if (idx === undefined) {
      absent.push(slug);
      continue;
    }
    applyFields(lines, idx, fields);
    updated.push(slug);
  }
  return { updated, absent };
}

// plan 2394: apply the SAME fields to MULTIPLE rows in ONE pass — the state-transition
// analogue of removeRows, and the primitive `claim-plan acquire --resume` needs to fold a
// dead holder's row demotion INTO its own atomic projection commit rather than print a
// `board.mjs set-state … PAUSED` line an unattended caller (a cloud drain, an orchestrator
// worker) has no code path to read.
// Like removeRows — and unlike single-row updateRow, whose throw-on-unknown-slug contract is
// UNCHANGED — this NEVER throws on an absent slug: it updates whichever named rows are
// present and reports the rest as `absent`. A projection re-applied by the claim retry loop
// (tree reset --hard, mutations replayed on a freshened board) or a sibling's concurrent row
// removal then degrades to a no-op instead of aborting a whole claim over one vanished row.
// When every slug is absent the returned content is byte-identical to the input, which
// coordWrite's own "nothing to commit" tolerance already covers at the call site.
// plan 2512: thin content-level wrapper over updateRowsLines — the O(n) single-pass slug
// resolution now lives there so a caller already holding a split line array (projectClaim's
// applyMutations) can call it directly instead of paying withBody's re-split.
export function updateRows(content, slugs, fields) {
  let result;
  const next = withBody(content, (lines) => {
    result = updateRowsLines(lines, slugs, fields);
  });
  return { content: next, updated: result.updated, absent: result.absent };
}

// plan 2512: the Lines-level core of upsertRow below — mutates `lines` in place so a caller
// that already split the board once (projectClaim's applyMutations) can upsert without paying
// a second splitBoard + withBody re-split. Insert-or-replace by slug, same shape as before.
export function upsertRowLines(lines, row) {
  const rendered = renderRow(row);
  const idx = findRowLineIndex(lines, row.slug);
  if (idx !== -1) {
    lines[idx] = rendered;
    return;
  }
  // append after the last data/non-empty table line, before trailing blank lines
  let insertAt = lines.length;
  while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, rendered);
}

// Insert a new row before BOARD-END; if a row with this slug exists, replace it (idempotent).
export function upsertRow(content, row) {
  return withBody(content, (lines) => upsertRowLines(lines, row));
}

// `tolerateAbsent` (F-018): make a single-slug `remove` a no-op success when the row is already
// gone, mirroring landing-queue-lib's `dequeueEntry` — a sibling's close-out removing the row
// FIRST is a benign race (board.mjs's own multi-slug `removeRows` below already tolerates this;
// drain-run/done-worktree already swallow the throw at 4 call sites for exactly this reason). The
// default (false) keeps the ORIGINAL hard-throw contract removeRows's own header comment
// documents as unchanged for any other caller wanting strict semantics.
export function removeRow(content, slug, { tolerateAbsent = false } = {}) {
  return withBody(content, (lines) => {
    const idx = rowIndexOrAbsent(lines, slug, tolerateAbsent);
    if (idx === -1) return; // absent + tolerated — idempotent no-op
    lines.splice(idx, 1);
  });
}

// plan 1364 Ship 3: remove MULTIPLE rows in ONE pass — the batch analogue of removeRow.
// removeRow's single-slug "throw on unknown slug" contract is UNCHANGED (that function is
// untouched; board.mjs still calls it for a single-slug `remove`); this multi-slug path
// NEVER throws — it removes whichever named rows are present and reports the rest as
// `absent`, so a batch close-out re-invoke after a partial prior run (some/all member rows
// already gone) can no-op cleanly instead of aborting the whole batch's board cleanup over
// one already-removed row. When every slug is absent the returned content is byte-identical
// to the input — coordWrite's own "nothing to commit" tolerance covers that case at the
// call site, so this never needs to special-case it.
export function removeRows(content, slugs) {
  const removed = [];
  const absent = [];
  const next = withBody(content, (lines) => {
    for (const slug of slugs) {
      const idx = findRowLineIndex(lines, slug);
      if (idx === -1) {
        absent.push(slug);
        continue;
      }
      lines.splice(idx, 1);
      removed.push(slug);
    }
  });
  return { content: next, removed, absent };
}

export const LANDING_STATE = '🟢 LANDING';

// plan 2394: the demote target `claim-plan acquire --resume` writes into a dead holder's
// stale row. Exported (and re-used by board.mjs's STATE_ALIASES) so the rendered state
// string has ONE definition — a hand-copied `'⏸ PAUSED'` in a second writer that drifts by
// one character produces a row `lint-board`/`landingRows`-style column-exact matching no
// longer recognises.
export const PAUSED_STATE = '⏸ PAUSED';

// plan 2818: same single-definition rationale as LANDING_STATE/PAUSED_STATE above — the
// rendered ACTIVE state string has ONE home here, so `redgreen-lib.mjs`'s IN_FLIGHT_STATES
// and `reconcile-board.mjs`'s PRESENT_STATES both import it instead of each hand-copying a
// `'🔄 ACTIVE'` literal that could drift by one character from the other.
export const ACTIVE_STATE = '🔄 ACTIVE';

// plan 2818: board-state vocabulary has ONE home. `redgreen-lib.mjs` used to define its own
// IN_FLIGHT_STATES array (identical values) and `reconcile-board.mjs`'s PRESENT_STATES
// duplicated the same three states a third time — a future state added to one and not the
// others would make a reporter call a live claim an orphan-ref. Both now import this.
export const IN_FLIGHT_STATES = [ACTIVE_STATE, PAUSED_STATE, LANDING_STATE];

// plan 3814 review fix (F1): same single-definition rationale as ACTIVE_STATE/PAUSED_STATE/
// LANDING_STATE above — these were three inline literals hand-copied into board.mjs's
// STATE_ALIASES with no shared owner, which is exactly the drift class this file's other
// state constants exist to prevent. IN_PROGRESS_STATE is a live, in-flight state (a plan
// mid-work outside the ACTIVE/LANDING/PAUSED trio); DONE_ON_BRANCH_STATE and SUPERSEDED_STATE
// are TERMINAL markers meant to persist on the board after a plan is archived/landed or its
// claim was taken over — a row in either of those states is NOT evidence of a live claim, and
// crediting it as such would let a crashed session that reached one of them but never released
// its claim ref hide from remediation permanently.
export const IN_PROGRESS_STATE = '🔄 IN PROGRESS';
export const DONE_ON_BRANCH_STATE = '✅ DONE-ON-BRANCH';
export const SUPERSEDED_STATE = '🧹 SUPERSEDED';
export const TERMINAL_STATES = [DONE_ON_BRANCH_STATE, SUPERSEDED_STATE];

// Set the row's state to LANDING and stamp the claim time as a `landing@<iso>`
// token in the touched cell (cell 4). Idempotent: re-stamping STRIPS any prior
// token before appending, so the row never accumulates duplicates. The state
// cell stays EXACTLY `🟢 LANDING` (the stamp rides in cell 4, not cell 2) so
// landingRows' column-exact match still detects the held mutex (plan 230).
export function stampLanding(content, slug, iso, { tolerateAbsent = false } = {}) {
  return withBody(content, (lines) => {
    const idx = rowIndexOrAbsent(lines, slug, tolerateAbsent);
    if (idx === -1) return; // absent + tolerated — idempotent no-op (F-018)
    const cells = cellsOf(lines[idx]);
    cells[2] = LANDING_STATE;
    const base = cells[4].replace(/\s*·?\s*landing@\S+/g, '').trim();
    cells[4] = base ? `${base} · landing@${iso}` : `landing@${iso}`;
    lines[idx] = `| ${cells.join(' | ')} |`;
  });
}

// plan 3443: default staleness threshold for the reaper below — matches
// `landing-queue.mjs steal --confirm-holder-gone`'s own `--stale-min` default so the two
// staleness clocks (queue-side steal, board-side reap) agree on "how long is too long"
// without the operator having to tune two numbers in lockstep.
export const DEFAULT_LANDING_REAP_STALE_MIN = 45;

// plan 3443: the PURE staleness verdict for a held 🟢 LANDING board row — is it provably
// dead, or might it still be a live (if slow) land? This is a WRITE decision (the caller
// flips the row to ⏸ PAUSED on `stale: true`), which is why it deliberately INVERTS
// `landing-age`'s own "unknown age = stale" convention just above: that verdict only
// REPORTS a number for a human to read, so treating an unknown age as the scarier answer is
// the safe default; this verdict WRITES, so every unknown input here must fail toward
// "leave it alone" instead — reaping a row that turns out to have been alive is strictly
// worse than leaving a truly-dead one held for one more landing-held read (it self-heals
// next firing regardless).
//
// `stale` is true ONLY when ALL THREE independent conditions hold:
//   (a) queue — no live landing-queue entry for the row's slug, or an entry whose
//       heartbeat has gone stale. A FRESH heartbeat is a full-stop guard against reaping a
//       live slow land: with `queueHeartbeatFresh === true` this condition is false no
//       matter what (b)/(c) say, which the plain AND below already gives for free — no
//       special-case branch needed, just worth naming.
//   (b) stamp — the row's `landing@` claim-time stamp parses and is older than `staleMin`
//       minutes. Absent or unparseable ⇒ NOT stale (cannot prove staleness from nothing).
//   (c) branch — the plan's execution branch shows no new commits since the stamp.
//       `branchProgressed === true` ⇒ not stale; `null` (branch state unreadable) ⇒ not
//       stale, same fail-open direction as the other two.
// Every `null` (unknown) input therefore lands on the NOT-stale side, by construction of
// the plain AND — this function never needs to special-case "unknown" beyond what each
// condition already does. Deterministic: no clock reads inside, `nowMs` is injected.
export function landingRowReapVerdict({
  landingIso,
  nowMs,
  queueEntryPresent,
  queueHeartbeatFresh,
  branchProgressed,
  staleMin = DEFAULT_LANDING_REAP_STALE_MIN,
}) {
  let queueStale;
  let queueReason;
  if (queueEntryPresent === null) {
    queueStale = false;
    queueReason = 'queue state unreadable — unknown never reaps';
  } else if (queueEntryPresent === false) {
    queueStale = true;
    queueReason = 'no live landing-queue entry';
  } else if (queueHeartbeatFresh === true) {
    queueStale = false;
    queueReason = 'a FRESH queue heartbeat — a live land, never reaped';
  } else if (queueHeartbeatFresh === false) {
    queueStale = true;
    queueReason = 'a queue entry is present but its heartbeat has gone stale';
  } else {
    queueStale = false;
    queueReason = 'a queue entry is present, heartbeat freshness unknown — unknown never reaps';
  }

  let stampStale = false;
  let stampReason = 'no landing@ stamp (or unparseable) — cannot prove staleness';
  if (landingIso != null) {
    const t = Date.parse(landingIso);
    if (!Number.isNaN(t)) {
      const ageMin = (nowMs - t) / 60000;
      stampStale = ageMin > staleMin;
      stampReason = `landing@ stamp is ${ageMin.toFixed(1)}m old (stale threshold ${staleMin}m)`;
    }
  }

  const branchStale = branchProgressed === false;
  const branchReason =
    branchProgressed === true
      ? 'the execution branch has new commits since the landing@ stamp'
      : branchProgressed === false
        ? 'no execution branch progress since the landing@ stamp'
        : 'branch state unreadable — unknown never reaps';

  const stale = queueStale && stampStale && branchStale;
  if (stale) {
    return {
      stale: true,
      reason: `stale 🟢 LANDING row — ${queueReason}; ${stampReason}; ${branchReason}`,
    };
  }
  // Not stale: name whichever condition kept it alive (checked in the same a/b/c order).
  if (!queueStale) return { stale: false, reason: queueReason };
  if (!stampStale) return { stale: false, reason: stampReason };
  return { stale: false, reason: branchReason };
}

// Read-only inspection of a row's LANDING claim. Returns
// { landing, iso, ageMin }:
//   - landing=false  → row missing OR its state cell isn't exactly LANDING.
//   - landing=true, iso=null, ageMin=null → LANDING row with no landing@ stamp
//     (legacy set-state without --landing-at; caller treats unknown-age as stale).
//   - landing=true, iso=<s>, ageMin=<n> → minutes since the stamp, given nowMs.
// nowMs is injectable so the verdict logic is deterministically testable.
export function landingInfo(content, slug, nowMs) {
  const { body } = splitBoard(content);
  const lines = body.split('\n');
  const idx = findRowLineIndex(lines, slug);
  if (idx === -1) return { landing: false, iso: null, ageMin: null };
  const cells = cellsOf(lines[idx]);
  if (!cells || cells[2] !== LANDING_STATE) return { landing: false, iso: null, ageMin: null };
  // plan 3443: read the stamp from cell 4 ONLY — `stampLanding`'s own write target — never by
  // scanning the whole row. The reaper's twin of this scrape (queue-drain's landingIsoFromRow)
  // was fixed the same way in review: a stray `landing@…` token in another cell, notably the
  // resume cell where the reaper's own REAPED note quotes the stamp it acted on, would
  // otherwise be picked up ahead of the real one and misreport the row's age.
  const m = cells[4] ? cells[4].match(/landing@(\S+)/) : null;
  if (!m) return { landing: true, iso: null, ageMin: null };
  const iso = m[1];
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { landing: true, iso, ageMin: null };
  return { landing: true, iso, ageMin: Math.max(0, Math.round((nowMs - t) / 60000)) };
}
