// scripts/ready-board.test.mjs (plan 2524)
//
// Every case runs against INJECTED oracle/stamp/claim inputs — no live git, no oracle spawn, no
// clock. That is the whole point of extracting this out of the `/cloud-eligibility` heredoc: the
// classification rules that were hand-patched three times in production are now pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_GLOBS } from './coord/coord-refs.mjs';
import { dispWidth } from './coord/box-table.mjs';
import {
  idOf,
  titleOf,
  stripTitle,
  laneOf,
  shortCode,
  cloudCell,
  buildBoard,
  renderReadyBoard,
  runOracle,
  readClaims,
  loadStamps,
  CROSS_LANE,
  LANE_LABEL,
  laneLabelFor,
  priorityGlyphFor,
  priorityWeightFor,
  laneRankFor,
  originHeaderLine,
  fuseBrowserTier,
  gatherOracleRuns,
  batchSlugByMember,
} from './ready-board.mjs';

const stamp = (o = {}) => ({
  stage: 'specced',
  execModel: 'sonnet',
  cloudExec: 'true',
  cloudEnv: null,
  loop: null,
  // plan 2520: `priority` is the one stamp whose ABSENCE is not null — the ruled vocabulary's
  // default IS `medium`, so that is what an unstamped plan actually reaches this board as. The
  // fixture matches reality rather than an impossible `null`.
  priority: 'medium',
  folder: 'ready',
  ...o,
});

test('idOf pulls the leading plan id; junk slugs read null', () => {
  assert.equal(idOf('2383-Pipe-notes-carry'), '2383');
  assert.equal(idOf('batch-2026-07-26-thing'), null);
  assert.equal(idOf(undefined), null);
});

test('titleOf drops the id and the FABLE- prefix, keeps the category, truncates long slugs', () => {
  assert.equal(titleOf('2383-Pipe-notes-carry'), 'Pipe-notes-carry');
  assert.equal(titleOf('2404-FABLE-Pipe-consensus'), 'Pipe-consensus');
  const long = titleOf('2404-FABLE-Pipe-consensus-se-bundle-detector-reads-prose-prerequisites');
  assert.ok(long.endsWith('…'));
  assert.equal(dispWidth(long), 38);
});

// plan 3341 review (finding B, keys 7bd971/eab05a/873376/0df823/66b70b): stripTitle used to
// strip ONLY a hardcoded `^FABLE-`, so a SOL- plan's title rendered with the raw marker still
// in it (`102-SOL-DQ-alpha` → title `SOL-DQ-alpha` instead of `DQ-alpha`).
test('stripTitle/titleOf also drop a SOL- lane-marker segment, same as FABLE-', () => {
  assert.equal(stripTitle('102-SOL-DQ-alpha'), 'DQ-alpha');
  assert.equal(titleOf('3341-SOL-Infra-sol-executor-lane'), 'Infra-sol-executor-lane');
});

test('laneOf reads execModel from the plan file, falling back to the run only when unstamped', () => {
  const stamps = { 100: stamp({ execModel: 'fable' }), 101: stamp() };
  assert.equal(laneOf('100', stamps, 'sonnet'), 'fable');
  assert.equal(laneOf('101', stamps, 'fable'), 'sonnet');
  // A plan with no stamps entry raced out of ready/ mid-run: fall back to the run it came from.
  assert.equal(laneOf('999', stamps, 'fable'), 'fable');
});

// plan 3341: laneOf now resolves through the shared fail-closed table instead of a
// fable-or-sonnet binary — a `sol` plan reports its own lane, and a genuinely unrecognized
// value degrades to its raw string rather than crashing the whole board.
test('laneOf: sol resolves to its own lane; a genuinely unrecognized value degrades, never throws', () => {
  const stamps = { 102: stamp({ execModel: 'sol' }), 103: stamp({ execModel: 'bogus-lane' }) };
  assert.equal(laneOf('102', stamps, 'sonnet'), 'sol');
  assert.equal(laneOf('103', stamps, 'sonnet'), 'bogus-lane');
});

// plan 3341 review (finding C, key ba580c): LANE_LABEL used to be typed here as its own
// literal (sonnet 🔵), independently of batches-view.mjs's own glyph map (sonnet 🟢) — same
// plan, two different colours depending on which board rendered it. Both now derive from
// EXEC_LANE_TABLE (claim-plan-lib.mjs), whose canonical sonnet icon is 🟢 — this board's
// sonnet glyph moving from 🔵 to 🟢 is the deliberate fix, pinned here.
test('LANE_LABEL is sourced from EXEC_LANE_TABLE — sonnet renders 🟢, matching batches-view.mjs', () => {
  assert.equal(LANE_LABEL.sonnet, '🟢 sonnet');
  assert.equal(LANE_LABEL.fable, '🟣 fable');
  assert.equal(LANE_LABEL.sol, '🔶 sol');
});

// plan 3341 delta-review follow-up (key 1d63e3): `LANE_LABEL[lane]` used to be a bare index
// into a plain object literal (LANE_LABEL is built by Object.fromEntries, which always
// returns an Object.prototype-having object) — the exact class of bug resolveExecLane
// (claim-plan-lib.mjs) already closed one layer up, reopened one layer down. A row whose
// `lane` is a JS-prototype property name resolved through the prototype chain to a truthy,
// non-string "label" — the Object constructor FUNCTION itself — instead of falling through
// to an honest "unknown" render. laneOf's own catch path (see the "genuinely unrecognized
// value degrades" test above) is exactly how such a lane string reaches this board, so
// `execModel: constructor` is not a contrived input — resolveExecLane's own error message
// echoes the raw execModel value straight through, and this board's laneOf catch does too.
test('laneLabelFor: an own-property lane renders its label; a prototype-chain name renders as a clearly-marked unknown lane, never the inherited value', () => {
  assert.equal(laneLabelFor('sonnet'), '🟢 sonnet');
  assert.equal(laneLabelFor('fable'), '🟣 fable');
  assert.equal(laneLabelFor('sol'), '🔶 sol');
  for (const poison of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const label = laneLabelFor(poison);
    assert.ok(
      typeof label === 'string' && label.includes(poison) && !/\[native code\]/.test(label),
      `laneLabelFor(${JSON.stringify(poison)}) leaked a prototype value: ${label}`,
    );
  }
});

test('priorityGlyphFor: a real tier renders its glyph; a prototype-chain name renders as a clearly-marked unknown value, never the inherited function', () => {
  assert.equal(priorityGlyphFor('high'), '⚡');
  assert.equal(priorityGlyphFor('low'), '↓');
  // `medium` is PRIORITY_DEFAULT and renders BLANK on purpose — an unmarked cell is the honest
  // "default priority" render (plan 2582). An absent stamp renders blank for the same reason.
  assert.equal(priorityGlyphFor('medium'), '');
  assert.equal(priorityGlyphFor(undefined), '');
  assert.equal(priorityGlyphFor(''), '');
  // The `?? ''` this replaced only caught null/undefined, so a prototype key resolved to a
  // FUNCTION (not nullish) and the fallback never fired — the Prio cell printed the function's
  // own source text.
  for (const poison of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const glyph = priorityGlyphFor(poison);
    assert.ok(
      typeof glyph === 'string' && !/\[native code\]/.test(glyph) && !/function/.test(glyph),
      `priorityGlyphFor(${JSON.stringify(poison)}) leaked a prototype value: ${glyph}`,
    );
  }
});

// End-to-end: the SAME poisoned execModel, run through laneOf (the real caller-side path)
// and then through the Lane-column render, must never leak a prototype-chain value into the
// operator-facing board — pinning the bug at the boundary where it was actually observed
// (the rendered table cell), not just at laneLabelFor in isolation.
test('renderReadyBoard: a row whose lane is a prototype-chain name never prints "[native code]" in the Lane column', () => {
  const stamps = { 200: stamp({ execModel: 'constructor' }) };
  const board = buildBoard({
    sonnet: { eligible: [{ slug: '200-Infra-poisoned-lane' }], excluded: [] },
    fable: { eligible: [], excluded: [] },
    stamps,
  });
  const rendered = renderReadyBoard(board);
  assert.ok(!/\[native code\]/.test(rendered), `board leaked a prototype value:\n${rendered}`);
  assert.match(rendered, /unknown lane \(constructor\)/);
});

// plan 3341 review round 2 (finding D, key 17f5cf): before this fix, a row whose `.lane` was a
// genuinely-unresolvable execModel string (laneOf's catch path) was counted in NONE of
// sonnet/fable/sol, so `counts.total` could exceed the sum of the three named buckets — the
// header could read "Ready plans: 1 (sonnet 0 · fable 0) — …" for a board holding exactly one
// such row, which contradicts itself (1 total, 0 in the breakdown) while the row sits right
// there in the table. `counts.other` closes the gap; the breakdown must always sum to total.
test('plan 3341 review round 2 (finding D, key 17f5cf): counts.other accounts for a malformed-lane row so the header never contradicts the total', () => {
  const stamps = { 200: stamp({ execModel: 'constructor' }) };
  const board = buildBoard({
    sonnet: { eligible: [{ slug: '200-Infra-poisoned-lane' }], excluded: [] },
    fable: { eligible: [], excluded: [] },
    stamps,
  });
  assert.equal(board.counts.total, 1);
  assert.equal(board.counts.other, 1);
  assert.equal(
    board.counts.sonnet + board.counts.fable + board.counts.sol + board.counts.other,
    board.counts.total,
    'the breakdown must always sum to the total',
  );
  const out = renderReadyBoard(board);
  assert.match(
    out,
    /Ready plans: 1 \(sonnet 0 · fable 0 · other 1\) — 1 takeable by a cloud drain now\./,
  );
});

// plan 3341 delta-review follow-up: the sort comparator had the SAME bare-lookup shape as
// LANE_LABEL/PRIORITY_GLYPH, on the same two hand/oracle-derived fields, just in the sort path.
// `PRIORITY_SORT_WEIGHT[priority] ?? PRIORITY_SORT_WEIGHT[PRIORITY_DEFAULT]` looked safe for the
// same reason PRIORITY_GLYPH's did: a prototype-chain name resolves to a truthy FUNCTION, so `??`
// never fires and `weight - weight` becomes NaN instead of falling back to PRIORITY_DEFAULT's
// weight.
test("priorityWeightFor: a real tier weighs correctly; a prototype-chain name falls back to PRIORITY_DEFAULT's weight, never NaN", () => {
  assert.equal(priorityWeightFor('high'), 0);
  assert.equal(priorityWeightFor('medium'), 1);
  assert.equal(priorityWeightFor('low'), 2);
  const defaultWeight = priorityWeightFor('medium');
  for (const poison of [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
    undefined,
  ]) {
    const weight = priorityWeightFor(poison);
    assert.equal(
      weight,
      defaultWeight,
      `priorityWeightFor(${JSON.stringify(poison)}) should fall back to PRIORITY_DEFAULT's weight`,
    );
    assert.equal(typeof weight, 'number');
  }
});

// Same shape, on the `lane` string a row carries (laneOf's own catch path can hand back any
// unresolved execModel verbatim) — a prototype-chain lane must sort last (weight 9), never NaN.
test('laneRankFor: a real lane ranks correctly; a prototype-chain name falls back to 9, never NaN', () => {
  const table = { sonnet: 0, fable: 1, sol: 2 };
  assert.equal(laneRankFor(table, 'sonnet'), 0);
  assert.equal(laneRankFor(table, 'fable'), 1);
  assert.equal(laneRankFor(table, 'sol'), 2);
  for (const poison of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.equal(
      laneRankFor(table, poison),
      9,
      `laneRankFor(table, ${JSON.stringify(poison)}) should fall back to 9`,
    );
  }
});

// End-to-end: buildBoard's sort must not throw or misorder when a row's priority AND lane are
// both prototype-chain names — pinning the bug at the boundary where NaN comparators would
// actually surface (Array#sort on the real row set), not just at the two helpers in isolation.
test('buildBoard: sorting never throws and stays stable when priority/lane are prototype-chain names', () => {
  const stamps = {
    300: stamp({ execModel: 'sonnet', priority: 'high' }),
    301: stamp({ execModel: 'constructor', priority: 'constructor' }),
    302: stamp({ execModel: 'sonnet', priority: 'low' }),
  };
  const board = buildBoard({
    sonnet: {
      eligible: [{ slug: '300-Infra-a' }, { slug: '301-Infra-poisoned' }, { slug: '302-Infra-b' }],
      excluded: [],
    },
    fable: { eligible: [], excluded: [] },
    stamps,
  });
  assert.equal(board.rows.length, 3);
  // high (300) sorts first; the poisoned row (301, priority falls back to medium's weight)
  // and low (302) both sort after it, in a stable, deterministic order — never NaN-scrambled.
  assert.equal(board.rows[0].id, '300');
  assert.deepEqual(board.rows.map((r) => r.id).sort(), ['300', '301', '302']);
});

test('shortCode splits the cloud gate by WHY — unstamped needs a spec-pass, cloud-false is adjudicated', () => {
  assert.equal(shortCode({ exclude: 'cloud', cloudExec: 'unset' }), 'unstamped');
  assert.equal(shortCode({ exclude: 'cloud', cloudExec: null }), 'unstamped');
  assert.equal(shortCode({ exclude: 'cloud', cloudExec: 'false' }), 'cloud-false');
  assert.equal(shortCode({ exclude: 'blocked' }), 'blocked-by');
  assert.equal(shortCode({ exclude: 'stub' }), 'unspecced');
  assert.equal(shortCode({ exclude: 'operator' }), 'operator-gated');
  assert.equal(shortCode({ exclude: null }), null);
});

test('shortCode passes an UNKNOWN oracle code through as itself, never a familiar label', () => {
  // A new gate must be visible as new. Collapsing it into a known code would misreport it.
  assert.equal(shortCode({ exclude: 'webkit-env' }), 'webkit-env');
  assert.equal(shortCode({ exclude: 'brand-new-gate' }), 'brand-new-gate');
});

// plan 4202: an undeclared-provenance refusal gets its OWN cell, never folded into
// 'unspecced' (the bare-stub code) — the fix (re-run /spec-pass, stamp --provenance) is a
// different operator action from "no spec-pass ran at all".
test('shortCode: an oracle "provenance" exclude renders as its own "undeclared-provenance" code, never "unspecced" or ELIGIBLE (plan 4202)', () => {
  assert.equal(shortCode({ exclude: 'provenance' }), 'undeclared-provenance');
  assert.notEqual(shortCode({ exclude: 'provenance' }), 'unspecced');
  assert.equal(
    cloudCell({ eligible: false, code: shortCode({ exclude: 'provenance' }) }),
    '⛔ undeclared-provenance',
  );
});

// ── note 1: lane attribution (the 2026-07-19 misreport) ───────────────────────

test('note 1: a fable plan blocked for cloudExec lands under FABLE, not SONNET', () => {
  // The regression shape: queue-drain runs the cloud gate BEFORE the lane gate, so this plan
  // carries exclude 'cloud' in BOTH runs and never a cross-lane code in either. Inferring the
  // lane from exclude codes filed exactly this row under the wrong heading (1701/2018/2023/2045).
  const excluded = [{ slug: '2370-FABLE-Pipe-x', exclude: 'cloud', cloudExec: 'unset' }];
  const board = buildBoard({
    sonnet: { eligible: [], excluded },
    fable: { eligible: [], excluded },
    stamps: { 2370: stamp({ execModel: 'fable' }) },
  });
  assert.equal(board.rows.length, 1, 'rendered exactly once, not once per run');
  assert.equal(board.rows[0].lane, 'fable');
  assert.equal(board.counts.fable, 1);
  assert.equal(board.counts.sonnet, 0);
});

test('note 1: cross-lane exclude codes are dropped as noise, never rendered as a block', () => {
  assert.ok(CROSS_LANE.has('fable') && CROSS_LANE.has('sonnet-lane'));
  const board = buildBoard({
    sonnet: { eligible: [], excluded: [{ slug: '2402-FABLE-x', exclude: 'fable', reason: 'r' }] },
    fable: { eligible: [{ slug: '2402-FABLE-x' }], excluded: [] },
    stamps: { 2402: stamp({ execModel: 'fable' }) },
  });
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].eligible, true, 'the fable run’s verdict wins, not the noise code');
  assert.equal(board.footnotes.size, 0);
});

// ── plan 3341, reversed at the LANE axis by plan 3461: `sol` still has no native oracle run
// (queue-drain has no `--lane sol` — plan 3461 deliberately did not add one, admitting a `sol`
// plan under BOTH the sonnet and fable runs instead). Before the native-run-filter carve-out,
// `lane !== runLane` dropped the row in BOTH runs (its resolved lane, 'sol', never equals
// either runLane), so it never reached `rows` at all: a silent vanish, not a rendered row. Plan
// 3461 made `sol` drain-claimable, so today's typical case is BOTH runs reporting a `sol` plan
// ELIGIBLE (see the "an all-sol LOCAL pool" test below) — but a `sol` plan can still be
// excluded on BOTH runs by its own environment axis (e.g. `sol-env-trusted` on trusted cloud,
// permanent), and the same one-row-not-zero-not-two dedup must hold for that case too. ────────

test('plan 3341/3461: a sol plan excluded by BOTH runs (its own env axis) still renders exactly once, under its own lane', () => {
  const LONG_REASON =
    'execModel: sol — Full-egress cloud codex transport is UNPROVEN (not yet refused-for-cause, ' +
    "just untested): whether codex exec's hook-driven context injection actually fires inside a " +
    'full-egress sandbox is unverified; run that probe, then flip SOL_FULL_EGRESS_CLOUD_SUPPORTED';
  const excluded = [
    { slug: '3341-SOL-Infra-x', exclude: 'sol-env-full-unproven', reason: LONG_REASON },
  ];
  const board = buildBoard({
    sonnet: { eligible: [], excluded },
    fable: { eligible: [], excluded },
    stamps: { 3341: stamp({ execModel: 'sol' }) },
  });
  assert.equal(board.rows.length, 1, 'rendered exactly once, not dropped, not doubled');
  assert.equal(board.rows[0].lane, 'sol');
  assert.equal(board.rows[0].code, 'sol-env-full-unproven');
  assert.equal(cloudCell(board.rows[0]), '⛔ sol-env-full-unproven');
  assert.equal(board.counts.sol, 1);
  assert.equal(board.counts.takeable, 0, 'excluded — not takeable, but present and visible');
  // the footnote carries the oracle's reason VERBATIM — never shortened, matching every other
  // exclude code's footnote treatment.
  const out = renderReadyBoard(board);
  assert.ok(out.includes(LONG_REASON), 'footnote must carry the full reason string, unshortened');
});

// A lane with no native run is admitted from exactly ONE run (the sonnet ingest call, fixed
// arbitrarily) even when the two runs' oracle payloads disagree on the reason text — proving
// this isn't a lucky merge of two identical entries, but a real "take it from one, skip the
// other" rule. Uses `sol-env-trusted` (still a live, reachable code — a permanent trusted-cloud
// refusal) rather than the generic `sol` code, which no longer fires for an actual `sol` plan
// now that plan 3461 made it drain-claimable.
test('plan 3341/3461: a sol row (excluded on its env axis) is admitted from the SONNET run specifically, never doubled from fable', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [
        { slug: '3341-SOL-Infra-x', exclude: 'sol-env-trusted', reason: 'sonnet-run reason' },
      ],
    },
    fable: {
      eligible: [],
      excluded: [
        { slug: '3341-SOL-Infra-x', exclude: 'sol-env-trusted', reason: 'fable-run reason' },
      ],
    },
    stamps: { 3341: stamp({ execModel: 'sol' }) },
  });
  assert.equal(board.rows.length, 1);
  const out = renderReadyBoard(board);
  assert.match(out, /sonnet-run reason/);
  assert.doesNotMatch(out, /fable-run reason/);
});

// plan 3461 round 2 (finding: ready-board.mjs:147): the old dedup hardcoded "admit a
// no-native-run lane's row from the SONNET run only" (`if (runLane !== 'sonnet') continue;`) —
// so a sol plan the sonnet oracle call did not report AT ALL (a partial/failed spawn, or any
// other reason unrelated to lane routing) silently vanished from the board even though the
// fable call reported it fine. Model exactly that: sonnet's eligible/excluded lists don't
// mention the plan at all, only fable's does — admission must be derived from `hasNativeRun`,
// never from naming a specific run as the sole source of truth.
test('plan 3461 round 2: a sol row reported ONLY by the fable run (sonnet omits it entirely) still renders, not dropped', () => {
  const board = buildBoard({
    sonnet: { eligible: [], excluded: [] },
    fable: {
      eligible: [],
      excluded: [
        { slug: '3341-SOL-Infra-x', exclude: 'sol-env-trusted', reason: 'fable-only reason' },
      ],
    },
    stamps: { 3341: stamp({ execModel: 'sol' }) },
  });
  assert.equal(board.rows.length, 1, 'rendered from the fable run, not silently vanished');
  assert.equal(board.rows[0].lane, 'sol');
  const out = renderReadyBoard(board);
  assert.match(out, /fable-only reason/);
});

// Same gap, but for an ELIGIBLE (takeable) sol plan rather than an excluded one — the sonnet
// call reports nothing for this id at all, so it must still be picked up and counted takeable
// from the fable call's eligible[] list.
test('plan 3461 round 2: a sol plan ELIGIBLE only in the fable run (sonnet omits it entirely) is still takeable', () => {
  const board = buildBoard({
    sonnet: { eligible: [], excluded: [] },
    fable: { eligible: [{ slug: '3341-SOL-Infra-x' }], excluded: [] },
    stamps: { 3341: stamp({ execModel: 'sol' }) },
  });
  assert.equal(board.rows.length, 1, 'rendered from the fable run, not silently vanished');
  assert.equal(board.rows[0].lane, 'sol');
  assert.equal(board.rows[0].eligible, true);
  assert.equal(board.counts.takeable, 1);
});

// plan 3461 (operator ruling 2026-08-26) made `sol` drain-claimable and lane-agnostic: a `sol`
// plan is now admitted under BOTH the sonnet and fable oracle runs on LOCAL and full-egress
// cloud. Same dedup mechanism as above (take it from exactly one run), but the outcome is now
// ELIGIBLE, not excluded — an all-sol LOCAL pool is fully takeable, reversing the pre-3461
// "an all-sol pool renders as 0 takeable" behaviour for this case.
test('plan 3461: an all-sol LOCAL pool renders as fully takeable, not 0 takeable — sol is drain-claimable now', () => {
  const eligible = [{ slug: '3341-SOL-Infra-x' }];
  const board = buildBoard({
    sonnet: { eligible, excluded: [] },
    fable: { eligible, excluded: [] },
    stamps: { 3341: stamp({ execModel: 'sol' }) },
  });
  assert.equal(board.rows.length, 1, 'rendered exactly once, not doubled');
  assert.equal(board.rows[0].lane, 'sol');
  assert.equal(board.rows[0].eligible, true);
  const out = renderReadyBoard(board);
  assert.doesNotMatch(out, /ready\/ is empty/);
  assert.match(
    out,
    /Ready plans: 1 \(sonnet 0 · fable 0 · sol 1\) — 1 takeable by a cloud drain now\./,
  );
});

// A sol plan CAN still render as 0-takeable — when its own environment axis excludes it on
// both runs (trusted cloud, permanent) — but that is now an environment fact, not a blanket
// lane refusal. Doctrine WORKING, not an error state: the board must still say "N ready, M
// sol, 0 takeable" plainly, never fall through to the "(ready/ is empty.)" empty-corpus message
// (that message is reserved for rows.length === 0, which this is not) and never read as a
// regression.
test('plan 3341/3461: a sol pool excluded on its env axis (trusted cloud) still renders as N ready / 0 takeable, never as "ready/ is empty"', () => {
  const excluded = [{ slug: '3341-SOL-Infra-x', exclude: 'sol-env-trusted', reason: 'r' }];
  const board = buildBoard({
    sonnet: { eligible: [], excluded },
    fable: { eligible: [], excluded },
    stamps: { 3341: stamp({ execModel: 'sol' }) },
  });
  const out = renderReadyBoard(board);
  assert.doesNotMatch(out, /ready\/ is empty/);
  assert.match(
    out,
    /Ready plans: 1 \(sonnet 0 · fable 0 · sol 1\) — 0 takeable by a cloud drain now\./,
  );
});

// Each of the four new oracle exclude codes (queue-drain.mjs, plan 3341) passes through
// shortCode unchanged, per the file's existing "unknown code passed through as itself"
// convention — no special-casing needed, and none was added, so a fifth code needs no new
// branch here either.
test('plan 3341: the four new sol-lane exclude codes render verbatim, no garbage/blank cell', () => {
  for (const code of ['sol', 'sol-env-trusted', 'sol-env-full-unproven', 'exec-lane-malformed']) {
    assert.equal(shortCode({ exclude: code }), code);
  }
});

// ── note 3: claims ────────────────────────────────────────────────────────────

test('note 3: a claimed eligible plan renders CLAIMED and is NOT counted takeable', () => {
  const board = buildBoard({
    sonnet: { eligible: [{ slug: '2481-Infra-x' }, { slug: '2482-Infra-y' }], excluded: [] },
    fable: { eligible: [], excluded: [] },
    stamps: { 2481: stamp(), 2482: stamp() },
    claimed: new Set(['2481']),
  });
  const claimedRow = board.rows.find((r) => r.id === '2481');
  assert.equal(cloudCell(claimedRow), '🔒 CLAIMED');
  assert.equal(cloudCell(board.rows.find((r) => r.id === '2482')), '✅ ELIGIBLE');
  assert.equal(board.counts.takeable, 1, 'claimed rows are not takeable now');
});

test('note 3: CLAIMED wins over an exclude code — a held plan’s cloud verdict is moot', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [{ slug: '2468-Coord-x', exclude: 'cloud', cloudExec: 'false', reason: 'r' }],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 2468: stamp({ cloudExec: 'false' }) },
    claimed: new Set(['2468']),
  });
  assert.equal(cloudCell(board.rows[0]), '🔒 CLAIMED');
});

// ── note 5: batch holds — a runnable train is takeable, a withheld one is not (plan 2643) ────

// The oracle's real hold wording (batchHoldReason, batch-paths.mjs). Kept verbatim so the
// via-train footnote is asserted to carry the actual instruction an operator acts on, not a
// paraphrase this test invented.
const holdReason = (slug) =>
  `member of runnable batch "${slug}" (status: proposed, gate: null) — take the whole train ` +
  'via `claim-plan.mjs batch`, or override with --override-batch-solo "<note>"';

test('note 5: (a) a member of a RUNNABLE batch renders 🚃 via-train and COUNTS as takeable', () => {
  // The misreport: ⛔ everywhere else on this board means "a cloud drain cannot take this", but
  // the drain's batch check MUST take a runnable train — ahead of `.next`. Only the SOLO claim is
  // held, which is also why these ids are absent from `eligible[]` (the plan-2459 hold).
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [
        { slug: '2634-Pipe-a', exclude: 'batch', reason: holdReason('batch-2026-07-30-tandvard') },
        { slug: '2637-Pipe-b', exclude: 'batch', reason: holdReason('batch-2026-07-30-tandvard') },
      ],
      runnableBatches: [{ slug: 'batch-2026-07-30-tandvard', members: ['2634', '2637'] }],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 2634: stamp(), 2637: stamp() },
  });
  assert.equal(cloudCell(board.rows.find((r) => r.id === '2634')), '🚃 via-train');
  assert.equal(cloudCell(board.rows.find((r) => r.id === '2637')), '🚃 via-train');
  assert.equal(board.counts.takeable, 2, 'a runnable train’s members are takeable NOW');
  assert.equal(board.rows[0].viaTrain, 'batch-2026-07-30-tandvard', 'row names its train');
});

test('note 5: (b) a batch-held member whose train is NOT runnable keeps ⛔ batch and is not takeable', () => {
  // The train was withheld this run (a member not cloud-eligible here, blocked under the hold,
  // or held by another batch) — `runnableBatches` is empty, so the hold IS a real block.
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [
        { slug: '2634-Pipe-a', exclude: 'batch', reason: holdReason('batch-2026-07-30-tandvard') },
      ],
      runnableBatches: [],
      skippedBatches: [{ slug: 'batch-2026-07-30-tandvard', reason: 'not every member …' }],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 2634: stamp() },
  });
  assert.equal(cloudCell(board.rows[0]), '⛔ batch');
  assert.equal(board.rows[0].viaTrain, null);
  assert.equal(board.counts.takeable, 0, 'a withheld train is not on offer');
});

test('note 5: (c) a CLAIMED member of a runnable batch renders 🔒 — claim beats both verdicts', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [
        { slug: '2634-Pipe-a', exclude: 'batch', reason: holdReason('batch-2026-07-30-tandvard') },
      ],
      runnableBatches: [{ slug: 'batch-2026-07-30-tandvard', members: ['2634'] }],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 2634: stamp() },
    claimed: new Set(['2634']),
  });
  assert.equal(cloudCell(board.rows[0]), '🔒 CLAIMED');
  assert.equal(board.counts.takeable, 0, 'someone already holds it');
});

test('note 5: the via-train footnote keeps the oracle’s verbatim reason under a 🚃, never a ⛔', () => {
  // The "take the whole train via claim-plan.mjs batch" instruction is the actionable half of the
  // hold text — it must survive the re-glyphing, and must not be filed under a blocked marker.
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [
        { slug: '2634-Pipe-a', exclude: 'batch', reason: holdReason('batch-2026-07-30-tandvard') },
        { slug: '2637-Pipe-b', exclude: 'batch', reason: holdReason('batch-2026-07-30-tandvard') },
      ],
      runnableBatches: [{ slug: 'batch-2026-07-30-tandvard', members: ['2634', '2637'] }],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 2634: stamp(), 2637: stamp() },
  });
  const out = renderReadyBoard(board);
  assert.match(out, /🚃 via-train \(2634, 2637\) — member of runnable batch/);
  assert.match(out, /take the whole train via `claim-plan\.mjs batch`/);
  assert.doesNotMatch(out, /⛔ (batch|via-train) \(/, 'no blocked footnote block for these rows');
});

test('note 5: a runnable and a withheld train side by side get their own footnote blocks', () => {
  // Both carry exclude `batch`; only the glyph and the embedded slug separate them. Keying the
  // footnote on the glyph as well as the reason keeps them two blocks even if the oracle's
  // wording ever stopped embedding the slug.
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [
        { slug: '10-A-a', exclude: 'batch', reason: holdReason('batch-runnable') },
        { slug: '20-B-b', exclude: 'batch', reason: holdReason('batch-withheld') },
      ],
      runnableBatches: [{ slug: 'batch-runnable', members: ['10'] }],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 10: stamp(), 20: stamp() },
  });
  const out = renderReadyBoard(board);
  assert.match(out, /🚃 via-train \(10\) — member of runnable batch "batch-runnable"/);
  assert.match(out, /⛔ batch \(20\) — member of runnable batch "batch-withheld"/);
  assert.equal(board.counts.takeable, 1, 'only the runnable train counts');
});

test('note 5: runnability is read PER RUN — a fable train does not make a sonnet row via-train', () => {
  // Each lane's run carries its own runnableBatches. A row is rendered under its native lane, so
  // it must consult that lane's verdict; crossing them would manufacture a takeable row.
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [{ slug: '10-A-a', exclude: 'batch', reason: holdReason('batch-fable-train') }],
      runnableBatches: [],
    },
    fable: {
      eligible: [],
      excluded: [
        { slug: '20-FABLE-B-b', exclude: 'batch', reason: holdReason('batch-fable-train') },
      ],
      runnableBatches: [{ slug: 'batch-fable-train', members: ['20'] }],
    },
    stamps: { 10: stamp(), 20: stamp({ execModel: 'fable' }) },
  });
  assert.equal(cloudCell(board.rows.find((r) => r.id === '10')), '⛔ batch');
  assert.equal(cloudCell(board.rows.find((r) => r.id === '20')), '🚃 via-train');
  assert.equal(board.counts.takeable, 1);
});

test('note 5: only the `batch` code can become 🚃 — another exclude in a runnable train stays ⛔', () => {
  // Defensive pin. A member excluded by a gate ABOVE the batch gate withholds its whole train, so
  // the oracle can never emit this combination today; the assertion keeps a future oracle change
  // from silently re-glyphing an unrelated block.
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [{ slug: '10-A-a', exclude: 'cloud', cloudExec: 'false', reason: 'local-only' }],
      runnableBatches: [{ slug: 'batch-x', members: ['10'] }],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 10: stamp({ cloudExec: 'false' }) },
  });
  assert.equal(cloudCell(board.rows[0]), '⛔ cloud-false');
  assert.equal(board.counts.takeable, 0);
});

test('note 5: an oracle payload with no runnableBatches key at all is handled, never a crash', () => {
  // Every pre-2643 fixture in this file omits the key, and a sibling/older oracle may too.
  const board = buildBoard({
    sonnet: { eligible: [], excluded: [{ slug: '10-A-a', exclude: 'batch', reason: 'held' }] },
    fable: { eligible: [], excluded: [] },
    stamps: { 10: stamp() },
  });
  assert.equal(cloudCell(board.rows[0]), '⛔ batch');
  assert.equal(board.counts.takeable, 0);
});

test('note 5: box alignment holds with a 🚃 via-train cell present', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [{ slug: '20-B-b' }],
      excluded: [{ slug: '10-A-a', exclude: 'batch', reason: holdReason('batch-x') }],
      runnableBatches: [{ slug: 'batch-x', members: ['10'] }],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 10: stamp(), 20: stamp() },
  });
  const out = renderReadyBoard(board);
  const box = out.split('\n').filter((l) => /^[┌│├└]/.test(l));
  const widths = new Set(box.map((l) => dispWidth(l)));
  assert.equal(widths.size, 1, `box not aligned with a 🚃 row present: widths ${[...widths]}`);
  assert.match(out, /Ready plans: 2 \(sonnet 2 · fable 0\) — 2 takeable/);
});

// ── plan 3438: the landing-mutex bucket (`mutexDropped`) — the 2026-08-24 regression that
// silently vanished 3 real ready/ plans (3309, 3397, 3424) from the board. `queue-drain.mjs`
// serializes this as bare slug strings (never `{slug, exclude, reason}`), and its exclude codes
// `fable` / `sonnet-lane` can each only be emitted by ONE of the two runs — `fable` marks a
// fable-native plan as not-this-lane in the SONNET run, `sonnet-lane` marks a sonnet-native plan
// as not-this-lane in the FABLE run — so the fixtures below pair each plan's `mutexDropped` entry
// with the cross-lane exclude its OTHER run would actually emit, matching the real reproduction
// in the plan body rather than an arbitrary run assignment. ──────────────────────────────────

test("plan 3438: a fable-native plan in mutexDropped of the fable run, cross-lane `fable` noise in the sonnet run, renders exactly one `mutex` row (3309's real shape)", () => {
  const slug = '3309-FABLE-Pipe-se-v2-x';
  const board = buildBoard({
    sonnet: { eligible: [], excluded: [{ slug, exclude: 'fable', reason: 'r' }] },
    fable: { eligible: [], excluded: [], mutexDropped: [slug] },
    stamps: { 3309: stamp({ execModel: 'fable' }) },
  });
  assert.equal(board.rows.length, 1, 'rendered exactly once, not dropped, not doubled');
  assert.equal(board.rows[0].id, '3309');
  assert.equal(board.rows[0].code, 'mutex');
  assert.equal(board.rows[0].eligible, false);
  assert.equal(board.rows[0].lane, 'fable');
  assert.equal(board.counts.takeable, 0);
});

test("plan 3438: the mirror — a sonnet-native plan in mutexDropped of the sonnet run, cross-lane `sonnet-lane` noise in the fable run (3397 / 3424's real shape)", () => {
  const slug = '3397-DQ-dk-stage4-x';
  const board = buildBoard({
    sonnet: { eligible: [], excluded: [], mutexDropped: [slug] },
    fable: { eligible: [], excluded: [{ slug, exclude: 'sonnet-lane', reason: 'r' }] },
    stamps: { 3397: stamp() },
  });
  assert.equal(board.rows.length, 1, 'rendered exactly once, not dropped, not doubled');
  assert.equal(board.rows[0].id, '3397');
  assert.equal(board.rows[0].code, 'mutex');
  assert.equal(board.rows[0].lane, 'sonnet');
});

test('plan 3438: a mutex row renders ⏸ mutex in the Cloud column, and the footnote carries the canonical reason under the same glyph', () => {
  const board = buildBoard({
    sonnet: { eligible: [], excluded: [], mutexDropped: ['3397-DQ-dk-stage4-x'] },
    fable: { eligible: [], excluded: [] },
    stamps: { 3397: stamp() },
  });
  assert.equal(cloudCell(board.rows[0]), '⏸ mutex');
  const out = renderReadyBoard(board);
  assert.match(out, /⏸ mutex \(3397\) — held by the ACTIVE landing mutex/);
  assert.match(out, /node scripts\/landing-queue\.mjs status/);
  assert.doesNotMatch(out, /⛔ mutex/, 'the Cloud cell and the footnote must agree on the glyph');
});

// The count pin — the one that would actually have caught the regression: every plan id either
// oracle run mentions in ANY of its three buckets (eligible, excluded, mutexDropped) must render
// as exactly one row. A future fourth bucket added upstream fails THIS assertion instead of
// silently vanishing another plan the way `mutexDropped` did.
test('plan 3438: rendered row count equals the number of DISTINCT plan ids across all three buckets of both runs', () => {
  const sonnet = {
    eligible: [{ slug: '100-Infra-a' }],
    excluded: [{ slug: '400-FABLE-Pipe-d', exclude: 'fable', reason: 'r' }],
    mutexDropped: ['300-Infra-c'],
  };
  const fable = {
    eligible: [{ slug: '200-FABLE-Pipe-b' }],
    excluded: [{ slug: '300-Infra-c', exclude: 'sonnet-lane', reason: 'r' }],
    mutexDropped: ['400-FABLE-Pipe-d'],
  };
  const stamps = {
    100: stamp(),
    200: stamp({ execModel: 'fable' }),
    300: stamp(),
    400: stamp({ execModel: 'fable' }),
  };
  const distinctIds = new Set(
    [sonnet, fable].flatMap((res) =>
      [...res.eligible, ...res.excluded, ...res.mutexDropped.map((slug) => ({ slug }))].map((e) =>
        idOf(e.slug),
      ),
    ),
  );
  assert.equal(distinctIds.size, 4, 'sanity: fixture actually names 4 distinct ids');
  const board = buildBoard({ sonnet, fable, stamps });
  assert.equal(board.rows.length, distinctIds.size);
  assert.deepEqual(board.rows.map((r) => r.id).sort(), [...distinctIds].sort());
});

test('plan 3438: mutexDropped: [] (the common case, no land in flight) changes nothing about the output', () => {
  const sonnetBase = { eligible: [{ slug: '100-Infra-a' }], excluded: [] };
  const fableBase = { eligible: [], excluded: [] };
  const stamps = { 100: stamp() };
  const withEmpty = buildBoard({
    sonnet: { ...sonnetBase, mutexDropped: [] },
    fable: { ...fableBase, mutexDropped: [] },
    stamps,
  });
  const without = buildBoard({ sonnet: sonnetBase, fable: fableBase, stamps });
  assert.deepEqual(withEmpty.rows, without.rows);
  assert.deepEqual(withEmpty.counts, without.counts);
});

// plan 3341: the header's sol clause is additive and conditional — a board with no sol rows
// renders byte-identically to before (confirmed by every sol-free test above); this pins the
// clause's own OUTPUT shape via renderReadyBoard's counts input directly, exercising the
// render layer in isolation from buildBoard's ingest. (Plan 3461 update: buildBoard's two-run
// ingest CAN now produce a real `sol` row via the NATIVE_RUN_LANES carve-out — see the
// plan 3341/3461 tests above, which exercise that path end to end — this test's synthetic
// `counts` input remains a useful narrower pin of the header string alone.)
test('plan 3341: renderReadyBoard header counts a sol bucket only when non-zero', () => {
  const noSol = renderReadyBoard({
    rows: [{ id: '1', slug: '1-A-a', lane: 'sonnet', priority: 'medium', eligible: true }],
    footnotes: new Map(),
    counts: { total: 1, sonnet: 1, fable: 0, sol: 0, takeable: 1 },
  });
  assert.match(noSol, /Ready plans: 1 \(sonnet 1 · fable 0\) — 1 takeable/);

  const withSol = renderReadyBoard({
    rows: [{ id: '2', slug: '2-SOL-A-a', lane: 'sol', priority: 'medium', eligible: true }],
    footnotes: new Map(),
    counts: { total: 1, sonnet: 0, fable: 0, sol: 1, takeable: 1 },
  });
  assert.match(withSol, /Ready plans: 1 \(sonnet 0 · fable 0 · sol 1\) — 1 takeable/);
  assert.match(withSol, /🔶 sol/);
});

// ── note 2: the full-env tag ──────────────────────────────────────────────────

test('note 2: a cloudEnv: full plan is TAGGED, not blocked', () => {
  const board = buildBoard({
    sonnet: { eligible: [{ slug: '2131-Infra-x' }], excluded: [] },
    fable: { eligible: [], excluded: [] },
    stamps: { 2131: stamp({ cloudEnv: 'full' }) },
  });
  assert.equal(cloudCell(board.rows[0]), '✅ ELIGIBLE (full)');
  assert.equal(board.counts.takeable, 1, 'full-env is provenance, not a block');
  assert.match(renderReadyBoard(board), /Full-egress runner/);
});

// ── note 2 (post-3823 revision): the browser-env fusion — a THIRD, lane-paired `--env browser`
// tier admits a `cloudEnv: browser` row the two `--env full` runs excluded purely on the env
// axis, tagged `(browser)` exactly like `(full)` (plan 3823 made the browser body the fleet
// default rather than a single-account exception). `fuseBrowserTier` is the pure admission-layer
// mechanism; the end-to-end `buildBoard` tests below pin it at the boundary an operator actually
// reads (the rendered cell and footnote), matching this file's own stated testing philosophy.

test('fuseBrowserTier: promotes a browser-env-excluded id the browser run also reports eligible', () => {
  const fullRes = {
    eligible: [{ slug: '100-Infra-a' }],
    excluded: [{ slug: '200-Infra-b', exclude: 'browser-env', reason: 'r' }],
  };
  const browserRes = { eligible: [{ slug: '200-Infra-b' }], excluded: [] };
  const fused = fuseBrowserTier(fullRes, browserRes);
  assert.deepEqual(
    fused.eligible.map((e) => e.slug),
    ['100-Infra-a', '200-Infra-b'],
  );
  assert.equal(fused.excluded.length, 0, 'the promoted id leaves the excluded bucket entirely');
});

// review round 4 (finding 54b09a): the two oracle calls are independently timed, so the SAME plan
// can reach this fusion under two spellings of its id if a rename lands between them. `idOf` keeps
// whatever padding the basename carried; `canonicalPlanId` — the oracle's own normalizer, and what
// the batch map keys on — strips it. Keying the browser buckets one way and the batch map the other
// meant a padded/unpadded pair hashed to two keys and the browser verdict was silently not found.
test('fuseBrowserTier (round 4): a browser-env candidate matches its browser verdict across zero-padding differences in the two snapshots', () => {
  const promoted = fuseBrowserTier(
    { eligible: [], excluded: [{ slug: '007-Infra-b', exclude: 'browser-env', reason: 'r' }] },
    { eligible: [{ slug: '7-Infra-b' }], excluded: [] },
  );
  assert.deepEqual(
    promoted.eligible.map((e) => e.slug),
    ['007-Infra-b'],
    'promotion keeps the FULL run’s own slug — only the matching key is canonicalized',
  );
  assert.equal(promoted.excluded.length, 0);

  const adopted = fuseBrowserTier(
    { eligible: [], excluded: [{ slug: '7-Infra-b', exclude: 'browser-env', reason: 'r' }] },
    {
      eligible: [],
      excluded: [{ slug: '0007-Infra-b', exclude: 'batch', reason: 'held by batch-x' }],
      runnableBatches: [{ slug: 'batch-x', members: ['07'] }],
    },
  );
  assert.deepEqual(
    adopted.excluded.map((e) => e.exclude),
    ['batch'],
    'the browser run’s later-evaluated verdict is adopted despite the padding difference',
  );
  assert.deepEqual(
    adopted.runnableBatches.map((b) => b.slug),
    ['batch-x'],
    'and the batch backing that adoption is carried through, keyed the same way',
  );
});

test('fuseBrowserTier: an exclude code OTHER than browser-env is never promoted, even if the id happens to appear in the browser run’s eligible[]', () => {
  const fullRes = {
    eligible: [],
    excluded: [{ slug: '200-Infra-b', exclude: 'blocked', reason: 'blocked-by: 100' }],
  };
  // Defensive fixture: the real oracle could never actually produce this shape (a gate ABOVE the
  // env check already excluded the row, so the env-only browser run agrees on `blocked` too) —
  // pinned anyway so a future oracle change can’t silently widen promotion past the one code the
  // env axis owns.
  const browserRes = { eligible: [{ slug: '200-Infra-b' }], excluded: [] };
  const fused = fuseBrowserTier(fullRes, browserRes);
  assert.deepEqual(fused.excluded, fullRes.excluded, 'a non-env exclude reason is untouched');
  assert.equal(fused.eligible.length, 0);
});

// review round 2, finding #3: generalizes the old, narrower "browser-env or nothing" fusion —
// a `browser-env` candidate is the ONE row shape that never reached the LATER gates
// (blocked/operator/stub/batch/mutex) under `--env full` at all, because the env gate stopped it
// first (queue-drain's `parsePlanMeta` gate order: cloud → env → … → blocked-by/operator/stub →
// batch/mutex). Once the browser run admits it past env, whatever THAT pipeline finds for the
// same id is real, new information — adopted verbatim, never left under the stale env label.
test('fuseBrowserTier: a browser-env-excluded id the browser run excludes for a DIFFERENT, later-evaluated reason adopts that entry verbatim — never the stale browser-env label', () => {
  const fullRes = {
    eligible: [],
    excluded: [{ slug: '200-Infra-b', exclude: 'browser-env', reason: 'needs Chromium' }],
  };
  const browserRes = {
    eligible: [],
    excluded: [{ slug: '200-Infra-b', exclude: 'blocked', reason: 'blocked-by another plan: 100' }],
  };
  const fused = fuseBrowserTier(fullRes, browserRes);
  assert.deepEqual(fused.excluded, [
    { slug: '200-Infra-b', exclude: 'blocked', reason: 'blocked-by another plan: 100' },
  ]);
  assert.equal(fused.eligible.length, 0, 'adopting a block is not a promotion');
});

// review round 2, finding A (most serious): a browser-env candidate is lane-agnostic on the env
// axis — queue-drain's cloud/env gate runs well ahead of the lane-mismatch check on EVERY
// invocation, regardless of which `--lane` was requested (see the comment above fuseBrowserTier),
// so the SAME id can appear as a `browser-env` candidate in BOTH the sonnet-full and fable-full
// runs even though it belongs to only one lane. Once that plan's OWN lane's browser call passes
// it past env, the OTHER lane's browser call reaches the lane-mismatch check instead and reports
// a CROSS_LANE code (`fable` / `sonnet-lane`) — the same "this is the other lane's plan" signal
// `ingest` already recognizes and drops as noise. Adopting that code into THIS fuse's `excluded[]`
// verbatim (the pre-fix behaviour) handed `ingest` an entry it silently drops, so the row would
// never render under this fuse at all — while carrying no promise the row renders anywhere else,
// since that depends on the OTHER lane's own fuse/ingest pairing actually running and succeeding.
test('fuseBrowserTier (finding A): a browser run excluding a browser-env candidate with a CROSS-LANE code keeps the ORIGINAL browser-env entry, never adopts the cross-lane one', () => {
  const fullRes = {
    eligible: [],
    excluded: [{ slug: '200-FABLE-b', exclude: 'browser-env', reason: 'needs Chromium' }],
  };
  const browserRes = {
    eligible: [],
    excluded: [
      {
        slug: '200-FABLE-b',
        exclude: 'fable',
        reason: 'execModel: fable — heavy-model plan, not drainable',
      },
    ],
  };
  const fused = fuseBrowserTier(fullRes, browserRes);
  assert.deepEqual(
    fused.excluded,
    fullRes.excluded,
    'the cross-lane entry is dropped in favour of the original browser-env entry — never adopted',
  );
  assert.equal(fused.eligible.length, 0);
});

test('fuseBrowserTier (finding A): the OTHER cross-lane code (sonnet-lane) is refused the same way', () => {
  const fullRes = {
    eligible: [],
    excluded: [{ slug: '300-Infra-c', exclude: 'browser-env', reason: 'needs Chromium' }],
  };
  const browserRes = {
    eligible: [],
    excluded: [
      {
        slug: '300-Infra-c',
        exclude: 'sonnet-lane',
        reason: 'execModel: sonnet — not in the fable lane',
      },
    ],
  };
  const fused = fuseBrowserTier(fullRes, browserRes);
  assert.deepEqual(fused.excluded, fullRes.excluded);
});

// finding C, isolated at the fuseBrowserTier level (the buildBoard-level test below pins the
// SAME thing at the rendered boundary): a runnableBatches entry the browser run reports must
// back an actually-adopted row, or it must not populate the fused via-train mapping at all.
test('fuseBrowserTier (finding C): a browser-run runnableBatches entry that backs NO adopted row is dropped, not merged unconditionally', () => {
  const fullRes = {
    eligible: [],
    // NOT a browser-env candidate — this id never even consults the browser run's excluded[]/
    // eligible[] buckets, so nothing about it is ever "adopted".
    excluded: [{ slug: '10-A-a', exclude: 'blocked', reason: 'blocked-by another plan: 5' }],
  };
  const browserRes = {
    eligible: [],
    excluded: [],
    runnableBatches: [{ slug: 'batch-unrelated', members: ['99'] }],
  };
  const fused = fuseBrowserTier(fullRes, browserRes);
  assert.ok(
    !('runnableBatches' in fused),
    'no adopted row backs this batch, so it must not populate the fused runnableBatches at all',
  );
});

test('fuseBrowserTier (finding C): a runnableBatches entry sharing NO adopted-batch member with an unrelated adopted batch entry is excluded from the merge', () => {
  const fullRes = {
    eligible: [],
    excluded: [{ slug: '10-A-a', exclude: 'browser-env', reason: 'r' }],
  };
  const browserRes = {
    eligible: [],
    // The adopted row (10) is held by batch-x — batch-y is reported alongside it but backs no
    // adopted row at all (its only member, 77, never appears in fullRes.excluded).
    excluded: [{ slug: '10-A-a', exclude: 'batch', reason: holdReason('batch-x') }],
    runnableBatches: [
      { slug: 'batch-x', members: ['10'] },
      { slug: 'batch-y', members: ['77'] },
    ],
  };
  const fused = fuseBrowserTier(fullRes, browserRes);
  assert.deepEqual(fused.runnableBatches, [{ slug: 'batch-x', members: ['10'] }]);
});

test('fuseBrowserTier: a browser-env-excluded id the browser run does not report in ANY of its three buckets keeps its original full-env verdict, unchanged — the safest degrade (a snapshot/timing gap between the two independently-timed calls)', () => {
  const fullRes = {
    eligible: [],
    excluded: [{ slug: '200-Infra-b', exclude: 'browser-env', reason: 'r' }],
  };
  const browserRes = { eligible: [], excluded: [], mutexDropped: [] };
  const fused = fuseBrowserTier(fullRes, browserRes);
  assert.deepEqual(fused, fullRes, 'no information about this id anywhere in the browser run');
});

test('fuseBrowserTier: a browser-env-excluded id whose browser run puts it in a RUNNABLE batch adopts the batch exclude AND merges runnableBatches, so ingest can render it via-train, not a plain block', () => {
  const fullRes = {
    eligible: [],
    excluded: [{ slug: '10-A-a', exclude: 'browser-env', reason: 'needs Chromium' }],
  };
  const browserRes = {
    eligible: [],
    excluded: [{ slug: '10-A-a', exclude: 'batch', reason: 'member of runnable batch "batch-x"' }],
    runnableBatches: [{ slug: 'batch-x', members: ['10'] }],
  };
  const fused = fuseBrowserTier(fullRes, browserRes);
  assert.deepEqual(fused.excluded, browserRes.excluded);
  assert.deepEqual(fused.runnableBatches, [{ slug: 'batch-x', members: ['10'] }]);
});

test('fuseBrowserTier: runnableBatches is a UNION (full-env entries first) — an existing full-env-runnable train is never dropped by the merge', () => {
  const fullRes = {
    eligible: [],
    excluded: [{ slug: '10-A-a', exclude: 'browser-env', reason: 'r' }],
    runnableBatches: [{ slug: 'batch-full', members: ['20'] }],
  };
  const browserRes = {
    eligible: [],
    excluded: [{ slug: '10-A-a', exclude: 'batch', reason: 'r2' }],
    runnableBatches: [{ slug: 'batch-browser', members: ['10'] }],
  };
  const fused = fuseBrowserTier(fullRes, browserRes);
  assert.deepEqual(fused.runnableBatches, [
    { slug: 'batch-full', members: ['20'] },
    { slug: 'batch-browser', members: ['10'] },
  ]);
});

test('fuseBrowserTier: runnableBatches is untouched (no synthesized empty array) when the browser run reports none', () => {
  const fullRes = { eligible: [{ slug: '100-Infra-a' }], excluded: [] };
  const fused = fuseBrowserTier(fullRes, { eligible: [], excluded: [], runnableBatches: [] });
  assert.ok(!('runnableBatches' in fused));
});

// The live shape reported against this worktree (team-lead follow-up): a `browser-env`-excluded
// row is reachable past the env gate under the browser run (queue-drain evaluates env BEFORE the
// landing-mutex gate — a row only reaches the mutex check once it has already passed env), but a
// genuinely ACTIVE landing mutex (an unrelated, real, currently-held gate) drops it there instead
// of reporting it eligible. This is NOT a lane-coverage bug — reproduced live via direct
// `--cloud --lane fable --env browser` vs `--env full` oracle calls against 3751/3797/3824: full
// reports `browser-env`, browser reports `mutexDropped`, consistently across three separate runs.
test('fuseBrowserTier: a browser-env-excluded id the browser run reaches but the ACTIVE landing mutex holds is re-filed into mutexDropped, never falsely promoted to eligible', () => {
  const fullRes = {
    eligible: [],
    excluded: [{ slug: '3751-FABLE-DQ-x', exclude: 'browser-env', reason: 'needs Chromium' }],
  };
  const browserRes = { eligible: [], excluded: [], mutexDropped: ['3751-FABLE-DQ-x'] };
  const fused = fuseBrowserTier(fullRes, browserRes);
  assert.equal(
    fused.eligible.length,
    0,
    'never falsely reported eligible — the mutex is a real block',
  );
  assert.equal(
    fused.excluded.length,
    0,
    'the stale browser-env entry does not survive the re-file',
  );
  assert.deepEqual(fused.mutexDropped, ['3751-FABLE-DQ-x']);
});

test('fuseBrowserTier: a full run that ALREADY reports its own mutexDropped ids keeps them, and a promoted mutex id is appended, never replacing them', () => {
  const fullRes = {
    eligible: [],
    excluded: [{ slug: '200-Infra-b', exclude: 'browser-env', reason: 'r' }],
    mutexDropped: ['300-Infra-c'],
  };
  const browserRes = { eligible: [], excluded: [], mutexDropped: ['200-Infra-b'] };
  const fused = fuseBrowserTier(fullRes, browserRes);
  assert.deepEqual(fused.mutexDropped.slice().sort(), ['200-Infra-b', '300-Infra-c']);
});

test('fuseBrowserTier: the common no-op case (nothing to re-file into mutexDropped) leaves the object shape byte-for-byte unchanged — mutexDropped absent stays absent', () => {
  const fullRes = { eligible: [{ slug: '100-Infra-a' }], excluded: [] };
  const fused = fuseBrowserTier(fullRes, { eligible: [], excluded: [], mutexDropped: [] });
  assert.deepEqual(fused, fullRes);
  assert.ok(!('mutexDropped' in fused), 'no synthesized empty array standing in for "absent"');
});

test('fuseBrowserTier: a missing/failed browser run degrades to the full run’s own verdict, unchanged', () => {
  const fullRes = {
    eligible: [{ slug: '100-Infra-a' }],
    excluded: [{ slug: '200-Infra-b', exclude: 'browser-env', reason: 'r' }],
  };
  assert.equal(fuseBrowserTier(fullRes, undefined), fullRes);
});

test('buildBoard/renderReadyBoard: a sonnet-lane cloudEnv: browser plan excluded under --env full renders ✅ ELIGIBLE (browser) once sonnetBrowser admits it, and leaves the browser-env footnote', () => {
  const excluded = [{ slug: '1443-Infra-x', exclude: 'browser-env', reason: 'needs Chromium' }];
  const board = buildBoard({
    sonnet: { eligible: [], excluded },
    fable: { eligible: [], excluded: [] },
    sonnetBrowser: { eligible: [{ slug: '1443-Infra-x' }], excluded: [] },
    stamps: { 1443: stamp({ cloudEnv: 'browser' }) },
  });
  assert.equal(board.rows.length, 1, 'rendered exactly once, not doubled');
  assert.equal(cloudCell(board.rows[0]), '✅ ELIGIBLE (browser)');
  assert.equal(board.counts.takeable, 1, 'promoted — takeable now');
  const out = renderReadyBoard(board);
  assert.doesNotMatch(
    out,
    /⛔ browser-env/,
    'the old blocked footnote must not survive the promotion',
  );
});

test('buildBoard/renderReadyBoard: a FABLE-lane cloudEnv: browser plan is promoted from fableBrowser specifically, never from sonnetBrowser — mirrors note 1’s two-lane pairing', () => {
  const excluded = [{ slug: '3751-FABLE-DQ-x', exclude: 'browser-env', reason: 'needs Chromium' }];
  const board = buildBoard({
    sonnet: { eligible: [], excluded: [] },
    fable: { eligible: [], excluded },
    // A sonnetBrowser payload that (incorrectly, hypothetically) named the same id must NOT be
    // the thing that promotes a fable-lane row — only fableBrowser may.
    sonnetBrowser: { eligible: [], excluded: [] },
    fableBrowser: { eligible: [{ slug: '3751-FABLE-DQ-x' }], excluded: [] },
    stamps: { 3751: stamp({ execModel: 'fable', cloudEnv: 'browser' }) },
  });
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].lane, 'fable');
  assert.equal(cloudCell(board.rows[0]), '✅ ELIGIBLE (browser)');
  assert.equal(board.counts.fable, 1);
  assert.equal(board.counts.takeable, 1);
});

// Superseded by finding #3's generalization below: a `browser-env`-excluded row whose browser run
// finds it blocked for a DIFFERENT reason (e.g. `blocked`) now adopts that reason instead of
// staying under the stale `browser-env` label — see "adopts that reason, never the stale
// browser-env label" further down, which replaces what this test used to pin.
test('buildBoard/renderReadyBoard: a cloudEnv: browser plan the browser run does not report in ANY bucket stays under its original full-env verdict, still tagged (browser)', () => {
  const excluded = [{ slug: '9-Infra-x', exclude: 'browser-env', reason: 'needs Chromium' }];
  const board = buildBoard({
    sonnet: { eligible: [], excluded },
    fable: { eligible: [], excluded: [] },
    sonnetBrowser: { eligible: [], excluded: [], mutexDropped: [] },
    stamps: { 9: stamp({ cloudEnv: 'browser' }) },
  });
  assert.equal(cloudCell(board.rows[0]), '⛔ browser-env (browser)');
  assert.equal(board.counts.takeable, 0);
  assert.match(renderReadyBoard(board), /⛔ browser-env \(9\) — needs Chromium/);
});

// The live shape (team-lead follow-up, 3751/3797/3824): the browser run reaches the row past the
// env gate but the ACTIVE landing mutex holds it there — renders `⏸ mutex (browser)`, never
// `✅ ELIGIBLE`, and never the stale/redundant `⛔ browser-env (browser)` shape (code and tag
// saying the same thing). `(browser)` still applies: it is a stamp-derived provenance fact, not a
// claim about which gate currently blocks the row — the same way `(full)` already renders next to
// an unrelated `⏸ mutex` row elsewhere on this board.
test('buildBoard/renderReadyBoard: a cloudEnv: browser plan the browser run reaches but the ACTIVE landing mutex holds renders ⏸ mutex (browser), never a false ELIGIBLE and never the stale browser-env label', () => {
  const excluded = [{ slug: '3751-FABLE-DQ-x', exclude: 'browser-env', reason: 'needs Chromium' }];
  const board = buildBoard({
    sonnet: { eligible: [], excluded: [] },
    fable: { eligible: [], excluded },
    fableBrowser: { eligible: [], excluded: [], mutexDropped: ['3751-FABLE-DQ-x'] },
    stamps: { 3751: stamp({ execModel: 'fable', cloudEnv: 'browser' }) },
  });
  assert.equal(board.rows.length, 1);
  assert.equal(cloudCell(board.rows[0]), '⏸ mutex (browser)');
  assert.equal(
    board.counts.takeable,
    0,
    'a mutex hold is a real, current block — never falsely takeable',
  );
  const out = renderReadyBoard(board);
  assert.match(out, /⏸ mutex \(3751\) — held by the ACTIVE landing mutex/);
  assert.doesNotMatch(
    out,
    /⛔ browser-env/,
    'the stale env-axis label must not survive the re-file',
  );
});

// Review round 2, finding #3 generalized past the mutex-specific case above: the browser run can
// find a `browser-env` candidate blocked by ANY later gate, not only mutex — pinned end to end at
// the rendered cell, the boundary the operator actually reads.
test('buildBoard/renderReadyBoard: a cloudEnv: browser plan the browser run excludes for a DIFFERENT reason (blocked-by) adopts that reason, never the stale browser-env label', () => {
  const excluded = [{ slug: '9-Infra-x', exclude: 'browser-env', reason: 'needs Chromium' }];
  const board = buildBoard({
    sonnet: { eligible: [], excluded },
    fable: { eligible: [], excluded: [] },
    sonnetBrowser: {
      eligible: [],
      excluded: [{ slug: '9-Infra-x', exclude: 'blocked', reason: 'blocked-by another plan: 5' }],
    },
    stamps: { 9: stamp({ cloudEnv: 'browser' }) },
  });
  assert.equal(cloudCell(board.rows[0]), '⛔ blocked-by (browser)');
  assert.equal(board.counts.takeable, 0);
  const out = renderReadyBoard(board);
  assert.match(out, /⛔ blocked-by \(9\) — blocked-by another plan: 5/);
  assert.doesNotMatch(
    out,
    /⛔ browser-env/,
    'the stale env-axis label must not survive the adoption',
  );
});

test('buildBoard/renderReadyBoard: a browser-env-excluded plan whose browser run puts it in a runnable batch renders 🚃 via-train (browser), never a plain block', () => {
  const excluded = [{ slug: '10-Infra-a', exclude: 'browser-env', reason: 'needs Chromium' }];
  const board = buildBoard({
    sonnet: { eligible: [], excluded },
    fable: { eligible: [], excluded: [] },
    sonnetBrowser: {
      eligible: [],
      excluded: [{ slug: '10-Infra-a', exclude: 'batch', reason: holdReason('batch-x') }],
      runnableBatches: [{ slug: 'batch-x', members: ['10'] }],
    },
    stamps: { 10: stamp({ cloudEnv: 'browser' }) },
  });
  assert.equal(cloudCell(board.rows[0]), '🚃 via-train (browser)');
  assert.equal(
    board.counts.takeable,
    1,
    'a runnable train is takeable NOW, even reached only via the browser tier',
  );
  const out = renderReadyBoard(board);
  assert.match(out, /🚃 via-train \(10\) — member of runnable batch "batch-x"/);
});

test('buildBoard: omitting sonnetBrowser/fableBrowser entirely (the pre-3823 caller shape) renders identically to before — fuseBrowserTier degrades silently', () => {
  const withBrowserArgs = buildBoard({
    sonnet: { eligible: [{ slug: '100-Infra-a' }], excluded: [] },
    fable: { eligible: [], excluded: [] },
    sonnetBrowser: undefined,
    fableBrowser: undefined,
    stamps: { 100: stamp() },
  });
  const withoutBrowserArgs = buildBoard({
    sonnet: { eligible: [{ slug: '100-Infra-a' }], excluded: [] },
    fable: { eligible: [], excluded: [] },
    stamps: { 100: stamp() },
  });
  assert.deepEqual(withBrowserArgs.rows, withoutBrowserArgs.rows);
  assert.deepEqual(withBrowserArgs.counts, withoutBrowserArgs.counts);
});

test('renderReadyBoard: the (browser) legend line appears only when a row actually carries the tag', () => {
  const withTag = buildBoard({
    sonnet: { eligible: [{ slug: '1-Infra-a' }], excluded: [] },
    fable: { eligible: [], excluded: [] },
    stamps: { 1: stamp({ cloudEnv: 'browser' }) },
  });
  assert.match(renderReadyBoard(withTag), /headless-Chromium egress/);

  const withoutTag = buildBoard({
    sonnet: { eligible: [{ slug: '1-Infra-a' }], excluded: [] },
    fable: { eligible: [], excluded: [] },
    stamps: { 1: stamp() },
  });
  assert.doesNotMatch(renderReadyBoard(withoutTag), /headless-Chromium egress/);
});

// review round 2, finding D: the legend must point the operator at the LIVE check for "does this
// slot actually run the browser body", not only at a dated log that can lag reality in either
// direction — and it must not claim the registry marking a slot equals that slot's live trigger
// already running it.
test('renderReadyBoard (finding D): the (browser) legend names the live check and does not claim every marked slot is already live', () => {
  const board = buildBoard({
    sonnet: { eligible: [{ slug: '1-Infra-a' }], excluded: [] },
    fable: { eligible: [], excluded: [] },
    stamps: { 1: stamp({ cloudEnv: 'browser' }) },
  });
  const out = renderReadyBoard(board);
  assert.match(out, /the trigger-body sync tool in dry-run mode/, 'names the LIVE check');
  assert.match(
    out,
    /does not mean its live trigger already runs that body/,
    'the registry MARKS the slot — that is not the same claim as "already running"',
  );
  assert.match(
    out,
    /the project's fleet log has the dated history/,
    'the dated log stays as background',
  );
});

// ── priority (plan 2582: full three-tier, not a high/blank boolean) ──────────

test('priority: high sorts first, medium sorts strictly between high and low', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [{ slug: '100-A-a' }, { slug: '200-B-b' }, { slug: '300-C-c' }],
      excluded: [],
    },
    fable: { eligible: [], excluded: [] },
    stamps: {
      100: stamp(), // medium (fixture default)
      200: stamp({ priority: 'high' }),
      300: stamp({ priority: 'low' }),
    },
  });
  assert.deepEqual(
    board.rows.map((r) => r.id),
    ['200', '100', '300'],
    'high, then medium, then low',
  );
  assert.equal(board.rows[0].priority, 'high');
  assert.equal(board.rows[1].priority, 'medium');
  assert.equal(board.rows[2].priority, 'low');
});

test('priority: a plan with no `priority:` field carries the full tier string, not a boolean', () => {
  const board = buildBoard({
    sonnet: { eligible: [{ slug: '400-A-a' }], excluded: [] },
    fable: { eligible: [], excluded: [] },
    // stamp() carrying no `priority` key at all — as read-plan-stamps.mjs's readPriorityTier()
    // would actually normalize an unset field: PRIORITY_DEFAULT, i.e. 'medium'.
    stamps: { 400: { execModel: 'sonnet' } },
  });
  assert.equal(board.rows[0].priority, 'medium', 'unset priority normalizes to PRIORITY_DEFAULT');
});

test('priority: Prio column renders ⚡ / blank / ↓ for high / medium / low, and unset renders identically to medium', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [{ slug: '10-A-a' }, { slug: '20-B-b' }, { slug: '30-C-c' }, { slug: '40-D-d' }],
      excluded: [],
    },
    fable: { eligible: [], excluded: [] },
    stamps: {
      10: stamp({ priority: 'high' }),
      20: stamp({ priority: 'medium' }),
      30: stamp({ priority: 'low' }),
      // 40 has NO priority key at all — must render identically to the explicit 'medium' row.
      // PRIORITY_DEFAULT (build-index-lib.mjs) is 'medium': the ruled plan-2520 semantics say an
      // absent field MEANS medium, so this is the correct render, not a missing "no data" state.
      40: { execModel: 'sonnet' },
    },
  });
  // Sort order (high → medium → low → id) puts 40 (unset, normalizes to medium) right after 20
  // (explicit medium), before 30 (low) — asserted here rather than assumed.
  assert.deepEqual(
    board.rows.map((r) => r.id),
    ['10', '20', '40', '30'],
  );

  const out = renderReadyBoard(board);
  // Data rows are every '│'-led line between the header separator and the bottom border.
  const rowLines = out.split('\n').filter((l, i, all) => l.startsWith('│') && i >= 4);
  assert.equal(rowLines.length, 4);
  // split('│') on '│ Plan │ Title │ Lane │ Prio │ Cloud │' → ['', Plan, Title, Lane, Prio, Cloud, ''].
  const prioCell = (line) => line.split('│')[4].trim();
  assert.equal(prioCell(rowLines[0]), '⚡', 'high (10)');
  assert.equal(prioCell(rowLines[1]), '', 'medium (20)');
  assert.equal(prioCell(rowLines[2]), '', 'unset renders identically to medium (40)');
  assert.equal(prioCell(rowLines[3]), '↓', 'low (30)');
});

test('priority: box alignment holds with a low-priority (↓) row present', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [{ slug: '10-A-a' }, { slug: '20-B-b' }],
      excluded: [],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 10: stamp({ priority: 'high' }), 20: stamp({ priority: 'low' }) },
  });
  const out = renderReadyBoard(board);
  const box = out.split('\n').filter((l) => /^[┌│├└]/.test(l));
  const widths = new Set(box.map((l) => dispWidth(l)));
  assert.equal(widths.size, 1, `box not aligned with a ↓ row present: widths ${[...widths]}`);
});

// ── review fix round (2943+2944, F9): 2943's acceptance says `/ready-plans` shows the evidence
// ── column — `evidence` already reaches STAMP_KEYS (read-plan-stamps.mjs) but never reached this
// ── board's row shape or its rendered table. Derived exactly like `fullEnv` (a plain stamps[id]
// ── lookup, null when unstamped) and rendered as its own column, mirroring the Prio column's
// ── blank-for-unset convention.

test('F9: evidence is derived onto the row exactly like fullEnv — a plain stamps[id] lookup, null when unstamped', () => {
  const board = buildBoard({
    sonnet: { eligible: [{ slug: '10-DQ-a' }, { slug: '20-DQ-b' }], excluded: [] },
    fable: { eligible: [], excluded: [] },
    stamps: { 10: stamp({ evidence: 'observed-wave' }), 20: stamp() },
  });
  assert.equal(board.rows.find((r) => r.id === '10').evidence, 'observed-wave');
  assert.equal(board.rows.find((r) => r.id === '20').evidence, null, 'unstamped reads null');
});

test('F9: renderReadyBoard shows an Evidence column, box alignment holds with a stamped row present', () => {
  const board = buildBoard({
    sonnet: { eligible: [{ slug: '10-DQ-a' }, { slug: '20-DQ-b' }], excluded: [] },
    fable: { eligible: [], excluded: [] },
    stamps: { 10: stamp({ evidence: 'latent' }), 20: stamp() },
  });
  const out = renderReadyBoard(board);
  assert.match(out, /Evidence/, 'the column header is present');
  assert.match(out, /latent/, 'a stamped row renders its evidence class');
  const box = out.split('\n').filter((l) => /^[┌│├└]/.test(l));
  const widths = new Set(box.map((l) => dispWidth(l)));
  assert.equal(
    widths.size,
    1,
    `box not aligned with an Evidence column present: widths ${[...widths]}`,
  );
});

test('F9: an unstamped row renders a BLANK Evidence cell, not the literal string "null"', () => {
  const board = buildBoard({
    sonnet: { eligible: [{ slug: '30-DQ-c' }], excluded: [] },
    fable: { eligible: [], excluded: [] },
    stamps: { 30: stamp() },
  });
  const out = renderReadyBoard(board);
  assert.doesNotMatch(out, /null/);
  // Evidence is the LAST cell (['Plan','Title','Lane','Prio','Cloud','Evidence']) — split('│')
  // yields ['', Plan, Title, Lane, Prio, Cloud, Evidence, ''], so index 6 is the Evidence cell.
  const rowLine = out.split('\n').find((l) => l.startsWith('│') && /30/.test(l));
  assert.ok(rowLine, 'the data row is present');
  assert.equal(rowLine.split('│')[6].trim(), '', 'blank, not "null"');
});

// plan 3955: /ready-plans grows a Cost column — the plan's own 💰 Cost forecast banner
// (queue-drain.mjs's `parseCost`), split into the Cash/Claude axes plan 3748 already defined.
// Cost is a property of the PLAN, not of its takeable-ness, so it rides eligible, excluded,
// and browser-promoted rows alike (mirroring the F9 Evidence tests above).

test('3955: a split-banner cost renders "Cash $X · Claude $Y" on one line', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [
        {
          slug: '10-DQ-a',
          cost: {
            split: true,
            usd: 0,
            over: false,
            unknown: false,
            claude: { usd: 5, over: false },
          },
        },
      ],
      excluded: [],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 10: stamp() },
  });
  assert.equal(board.rows.find((r) => r.id === '10').cost.split, true);
  const out = renderReadyBoard(board);
  assert.match(out, /Cash \$0 · Claude \$5/);
});

test('3955: a legacy (unsplit) cost renders one figure with the `>` "at least" prefix', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [{ slug: '20-DQ-b', cost: { split: false, usd: 2, over: true, unknown: false } }],
      excluded: [],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 20: stamp() },
  });
  const out = renderReadyBoard(board);
  assert.match(out, />\$2/);
});

test('3955: an unknown cost and a row carrying no cost at all both render a BLANK Cost cell — never a fabricated $0', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [
        { slug: '30-DQ-c', cost: { split: false, usd: null, over: false, unknown: true } },
        { slug: '40-DQ-d' }, // no `cost` key at all
      ],
      excluded: [],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 30: stamp(), 40: stamp() },
  });
  assert.equal(board.rows.find((r) => r.id === '30').cost.unknown, true);
  assert.equal(board.rows.find((r) => r.id === '40').cost, null, 'absent cost normalizes to null');
  const out = renderReadyBoard(board);
  const cell = (id) => {
    const line = out
      .split('\n')
      .find((l) => l.startsWith('│') && new RegExp(`\\b${id}\\b`).test(l));
    const cells = line.split('│');
    return cells[cells.length - 2].trim(); // Cost is the LAST rendered column
  };
  assert.equal(cell('30'), '', 'unknown renders blank, not $0 or "unknown"');
  assert.equal(cell('40'), '', 'no cost key renders blank, not $0 or "null"');
});

test('3955: an EXCLUDED row carrying cost renders it exactly like an eligible row', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [
        {
          slug: '50-DQ-e',
          exclude: 'operator',
          reason: 'r',
          cost: { split: false, usd: 3, over: false, unknown: false },
        },
      ],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 50: stamp() },
  });
  assert.equal(board.rows.find((r) => r.id === '50').cost.usd, 3);
  const out = renderReadyBoard(board);
  assert.match(out, /\$3/);
});

test('3955: a browser-promoted row (via fuseBrowserTier) keeps its cost', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [
        {
          slug: '60-DQ-f',
          exclude: 'browser-env',
          reason: 'r',
          cost: { split: false, usd: 7, over: false, unknown: false },
        },
      ],
    },
    fable: { eligible: [], excluded: [] },
    sonnetBrowser: { eligible: [{ slug: '60-DQ-f' }], excluded: [] },
    stamps: { 60: stamp({ cloudEnv: 'browser' }) },
  });
  const row = board.rows.find((r) => r.id === '60');
  assert.equal(row.eligible, true, 'the browser run promoted it');
  assert.equal(row.cost.usd, 7, 'promotion carried the cost through, not just the slug');
  const out = renderReadyBoard(board);
  assert.match(out, /\$7/);
});

// plan 3955 (review round): `mutexDropped` is a pinned bare-slug-string contract, so a landing-
// mutex-held row's cost rides the SIBLING `mutexDroppedMeta` array (queue-drain.mjs) instead —
// without it, a seed-write plan withheld by the ACTIVE landing mutex rendered a blank Cost cell
// even with a perfectly valid banner.

test('3955: a mutex-held row carries its cost via the sibling mutexDroppedMeta array', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [],
      mutexDropped: ['70-DQ-g'],
      mutexDroppedMeta: [
        {
          slug: '70-DQ-g',
          cost: {
            split: true,
            usd: 0,
            over: false,
            unknown: false,
            claude: { usd: 5, over: false },
          },
        },
      ],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 70: stamp() },
  });
  const row = board.rows.find((r) => r.id === '70');
  assert.equal(row.code, 'mutex');
  assert.equal(row.cost.split, true);
  const out = renderReadyBoard(board);
  assert.match(out, /Cash \$0 · Claude \$5/);
});

test('3955: mutexDroppedMeta absent still normalizes a mutex row to a blank (never a crash, never a fabricated $0)', () => {
  const board = buildBoard({
    sonnet: { eligible: [], excluded: [], mutexDropped: ['71-DQ-h'] },
    fable: { eligible: [], excluded: [] },
    stamps: { 71: stamp() },
  });
  assert.equal(board.rows.find((r) => r.id === '71').cost, null);
});

test('3955: a browser-fused mutex-promoted row keeps its cost too', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [
        {
          slug: '80-DQ-i',
          exclude: 'browser-env',
          reason: 'r',
          cost: { split: false, usd: 4, over: false, unknown: false },
        },
      ],
    },
    fable: { eligible: [], excluded: [] },
    sonnetBrowser: { eligible: [], excluded: [], mutexDropped: ['80-DQ-i'] },
    stamps: { 80: stamp({ cloudEnv: 'browser' }) },
  });
  const row = board.rows.find((r) => r.id === '80');
  assert.equal(row.code, 'mutex', 'the browser run re-filed it into mutexDropped');
  assert.equal(row.cost.usd, 4, 'the fused mutexDroppedMeta carried the cost through');
  const out = renderReadyBoard(board);
  assert.match(out, /\$4/);
});

test('sort falls through priority → lane (sonnet first) → id ascending', () => {
  const board = buildBoard({
    sonnet: { eligible: [{ slug: '300-A-a' }, { slug: '100-B-b' }], excluded: [] },
    fable: { eligible: [{ slug: '200-C-c' }], excluded: [] },
    stamps: { 100: stamp(), 300: stamp(), 200: stamp({ execModel: 'fable' }) },
  });
  assert.deepEqual(
    board.rows.map((r) => r.id),
    ['100', '300', '200'],
  );
});

// ── footnotes ─────────────────────────────────────────────────────────────────

test('rows sharing ONE generic cause collapse to a single footnote block naming both', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [
        { slug: '1-A-a', exclude: 'cloud', cloudExec: 'unset', reason: 'cloudExec unset — …' },
        { slug: '2-B-b', exclude: 'cloud', cloudExec: 'unset', reason: 'cloudExec unset — …' },
        { slug: '3-C-c', exclude: 'blocked', reason: 'blocked-by another plan: 2402' },
      ],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 1: stamp(), 2: stamp(), 3: stamp() },
  });
  const out = renderReadyBoard(board);
  // `⛔ <code>` also appears in the table CELLS, so count the footnote shape specifically —
  // `⛔ <code> (<ids>)`, which only the footnote block emits.
  assert.equal(out.match(/⛔ unstamped \(/g).length, 1, 'one block, not one per row');
  assert.match(out, /⛔ unstamped \(1, 2\) — cloudExec unset/);
  assert.match(out, /⛔ blocked-by \(3\) — blocked-by another plan: 2402/);
});

test('two plans blocked on DIFFERENT upstreams get their own footnote — never one wrong blocker', () => {
  // The regression: keying footnotes on the short code alone kept only the FIRST plan's reason
  // and printed it under every row sharing the code, so plan 2 was attributed to plan 1's
  // upstream. An operator would then wait on, or investigate, the wrong plan.
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [
        { slug: '1-A-a', exclude: 'blocked', reason: 'blocked-by another plan: 2401' },
        { slug: '2-B-b', exclude: 'blocked', reason: 'blocked-by another plan: 2555' },
      ],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 1: stamp(), 2: stamp() },
  });
  const out = renderReadyBoard(board);
  assert.match(out, /⛔ blocked-by \(1\) — blocked-by another plan: 2401/);
  assert.match(out, /⛔ blocked-by \(2\) — blocked-by another plan: 2555/);
  assert.equal(
    out.match(/⛔ blocked-by \(/g).length,
    2,
    'one block per distinct CAUSE, not per code',
  );
});

test('an unknown exclude code still surfaces its reason rather than swallowing it', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [],
      excluded: [{ slug: '1-A-a', exclude: 'brand-new-gate', reason: 'some new rule fired' }],
    },
    fable: { eligible: [], excluded: [] },
    stamps: { 1: stamp() },
  });
  assert.match(renderReadyBoard(board), /⛔ brand-new-gate \(1\) — some new rule fired/);
});

test('a missing reason renders a placeholder, never "undefined"', () => {
  const board = buildBoard({
    sonnet: { eligible: [], excluded: [{ slug: '1-A-a', exclude: 'stub' }] },
    fable: { eligible: [], excluded: [] },
    stamps: { 1: stamp() },
  });
  const out = renderReadyBoard(board);
  assert.doesNotMatch(out, /undefined/);
  assert.match(out, /\(no reason given\)/);
});

// ── rendering ─────────────────────────────────────────────────────────────────

test('renderReadyBoard: header counts, and every box line the same visual width', () => {
  const board = buildBoard({
    sonnet: {
      eligible: [{ slug: '2383-Pipe-notes-carry-raw-table-cell-pipes-and-duplicate-amount' }],
      excluded: [{ slug: '2446-Coord-x', exclude: 'blocked', reason: 'blocked-by: 2402' }],
    },
    fable: {
      eligible: [],
      excluded: [{ slug: '2370-FABLE-Pipe-y', exclude: 'cloud', cloudExec: 'unset', reason: 'r' }],
    },
    stamps: {
      2383: stamp({ priority: 'high' }),
      2446: stamp(),
      2370: stamp({ execModel: 'fable' }),
    },
  });
  const lines = renderReadyBoard(board).split('\n');
  assert.match(lines[0], /Ready plans: 3 \(sonnet 2 · fable 1\) — 1 takeable/);

  const box = lines.filter((l) => /^[┌│├└]/.test(l));
  assert.equal(box.length, 7); // top, header, sep, 3 rows, bottom
  const widths = new Set(box.map((l) => dispWidth(l)));
  assert.equal(widths.size, 1, `box not aligned: widths ${[...widths]}`);
});

test('renderReadyBoard: an empty ready/ says so instead of printing an empty box', () => {
  const board = buildBoard({ sonnet: {}, fable: {} });
  const out = renderReadyBoard(board);
  assert.match(out, /Ready plans: 0 \(sonnet 0 · fable 0\) — 0 takeable/);
  assert.match(out, /ready\/ is empty/);
  assert.doesNotMatch(out, /┌/);
});

// ── failure posture ───────────────────────────────────────────────────────────

test('loadStamps FAILS LOUD — an unreadable corpus must not become a SONNET-only board', () => {
  assert.throws(
    () =>
      loadStamps({
        collect: () => {
          throw new Error('plans root does not exist: /nope');
        },
      }),
    (e) => {
      assert.match(e.message, /NOT printing a board/);
      assert.match(e.message, /wrong cwd/);
      assert.match(e.message, /vetapp-only/);
      return true;
    },
  );
});

test('runOracle recovers the JSON the oracle prints on its exit-1 empty-lane path', async () => {
  const err = Object.assign(new Error('exit 1'), {
    stdout: JSON.stringify({ eligible: [], excluded: [{ slug: '1-A-a', exclude: 'stub' }] }),
  });
  const res = await runOracle(['--cloud'], {
    exec: () => Promise.reject(err),
  });
  assert.equal(res.excluded.length, 1);
});

test('runOracle THROWS when the oracle fails without parseable JSON — no false-empty lane', async () => {
  // An empty lane and a crashed oracle both render "0 takeable"; only one of them means it.
  await assert.rejects(
    () =>
      runOracle(['--cloud'], {
        exec: () => Promise.reject(Object.assign(new Error('boom'), { stderr: 'SyntaxError: …' })),
      }),
    (e) => {
      assert.match(e.message, /NOT printing a\s*\n?board/);
      assert.match(e.message, /queue-drain\.mjs --cloud/);
      return true;
    },
  );
});

// ── review round 2, finding #1: the two --env full calls stay STRICT; the two --env browser
// calls must NEVER take the whole board down with them (a browser-tier failure only costs
// promotions/revisions, per note 2) — pinned against a FAKE `runOracle`, never a real spawn.
//
// review round 2, finding E: the browser tier is only spawned when `stamps` actually carries a
// `cloudEnv: browser` plan — every fixture below that wants the tier to RUN passes such a stamp.
const browserRungStamps = { 1: stamp({ cloudEnv: 'browser' }) };

test('gatherOracleRuns: all four calls succeeding returns them all, browserTierStatus ok/ok', async () => {
  const seen = [];
  const fakeRunOracle = (args) => {
    seen.push(args);
    return Promise.resolve({ eligible: [], excluded: [], marker: args.join(' ') });
  };
  const result = await gatherOracleRuns({ runOracle: fakeRunOracle, stamps: browserRungStamps });
  assert.equal(result.sonnet.marker, '--cloud --env full');
  assert.equal(result.fable.marker, '--cloud --lane fable --env full');
  assert.equal(result.sonnetBrowser.marker, '--cloud --env browser');
  assert.equal(result.fableBrowser.marker, '--cloud --lane fable --env browser');
  assert.deepEqual(result.browserTierStatus, { sonnet: 'ok', fable: 'ok' });
  assert.equal(seen.length, 4, 'exactly the four documented oracle invocations, nothing extra');
});

test('gatherOracleRuns: a FULL-env oracle failure still propagates (STRICT) — an empty lane must never be indistinguishable from a crash', async () => {
  const fakeRunOracle = (args) =>
    args.includes('browser')
      ? Promise.resolve({ eligible: [], excluded: [] })
      : Promise.reject(new Error('oracle boom'));
  await assert.rejects(
    () => gatherOracleRuns({ runOracle: fakeRunOracle, stamps: browserRungStamps }),
    /oracle boom/,
  );
});

test('gatherOracleRuns: a BROWSER-env oracle failure degrades to sonnetBrowser/fableBrowser undefined and browserTierStatus failed/failed — never propagates, never takes the full-env runs down with it', async () => {
  const fakeRunOracle = (args) =>
    args.includes('browser')
      ? Promise.reject(new Error('browser oracle boom'))
      : Promise.resolve({ eligible: [], excluded: [] });
  const result = await gatherOracleRuns({ runOracle: fakeRunOracle, stamps: browserRungStamps });
  assert.deepEqual(result.sonnet, { eligible: [], excluded: [] });
  assert.deepEqual(result.fable, { eligible: [], excluded: [] });
  assert.equal(result.sonnetBrowser, undefined);
  assert.equal(result.fableBrowser, undefined);
  assert.deepEqual(result.browserTierStatus, { sonnet: 'failed', fable: 'failed' });
});

// finding B: the status is PER LANE — a single shared boolean could not tell "only fable's
// browser call failed" from "both did", which is exactly the shape that made originHeaderLine
// print a false "no browser-only promotions were applied" statement while the sonnet lane's own
// promotion sat right there in the table.
test('gatherOracleRuns (finding B): only ONE of the two browser calls failing reports that lane alone as failed — the surviving lane stays ok and usable', async () => {
  const fakeRunOracle = (args) => {
    if (args.includes('fable') && args.includes('browser')) return Promise.reject(new Error('x'));
    return Promise.resolve({ eligible: [], excluded: [], marker: args.join(' ') });
  };
  const result = await gatherOracleRuns({ runOracle: fakeRunOracle, stamps: browserRungStamps });
  assert.equal(result.sonnetBrowser.marker, '--cloud --env browser');
  assert.equal(result.fableBrowser, undefined);
  assert.deepEqual(result.browserTierStatus, { sonnet: 'ok', fable: 'failed' });
});

// finding E: the browser tier's fixed cost (two more full ready/ corpus walks) is only worth
// paying when a ready plan actually needs it. No `cloudEnv: browser` stamp anywhere ⇒ both
// browser calls are skipped — never spawned at all — and report a THIRD status, `'skipped'`,
// never `'failed'` (a skip is not a degradation and must never read as one).
test('gatherOracleRuns (finding E): no ready plan carries cloudEnv: browser — both browser calls are SKIPPED, never spawned', async () => {
  const seen = [];
  const fakeRunOracle = (args) => {
    seen.push(args);
    return Promise.resolve({ eligible: [], excluded: [], marker: args.join(' ') });
  };
  const result = await gatherOracleRuns({
    runOracle: fakeRunOracle,
    stamps: { 1: stamp(), 2: stamp({ cloudEnv: 'full' }) },
  });
  assert.equal(seen.length, 2, 'only the two --env full calls are spawned');
  assert.ok(seen.every((args) => !args.includes('browser')));
  assert.equal(result.sonnetBrowser, undefined);
  assert.equal(result.fableBrowser, undefined);
  assert.deepEqual(result.browserTierStatus, { sonnet: 'skipped', fable: 'skipped' });
});

test('gatherOracleRuns (finding E): a single ready plan carrying cloudEnv: browser is enough to run the browser tier, and an empty stamps map defaults to skipped', async () => {
  const seen = [];
  const fakeRunOracle = (args) => {
    seen.push(args);
    return Promise.resolve({ eligible: [], excluded: [], marker: args.join(' ') });
  };
  const withRung = await gatherOracleRuns({
    runOracle: fakeRunOracle,
    stamps: { 1: stamp(), 2: stamp({ cloudEnv: 'browser' }) },
  });
  assert.equal(seen.length, 4, 'one browser-rung plan among several others still runs the tier');
  assert.deepEqual(withRung.browserTierStatus, { sonnet: 'ok', fable: 'ok' });

  const withoutStamps = await gatherOracleRuns({ runOracle: fakeRunOracle });
  assert.deepEqual(
    withoutStamps.browserTierStatus,
    { sonnet: 'skipped', fable: 'skipped' },
    'stamps defaults to {} — no stamps means no browser-rung plan, same as an explicit empty map',
  );
});

// review round 3 (findings a55380 / 21f627): the ONE member→batch map builder, shared by
// `fuseBrowserTier` and `ingest`. First-match-wins on a double-listed id is the property that had
// to stop being duplicated — the roster view resolves the same tiebreak, so a divergence here
// makes this board name a different holding train for the same plan.
test('batchSlugByMember: first listing of a double-listed member wins, ids are canonicalized, and a missing/blank result is an empty map', () => {
  const m = batchSlugByMember({
    runnableBatches: [
      { slug: 'batch-2026-09-09-a', members: ['200', '0201'] },
      { slug: 'batch-2026-09-09-b', members: ['201', '202'] },
    ],
  });
  assert.equal(m.get('200'), 'batch-2026-09-09-a');
  assert.equal(
    m.get('201'),
    'batch-2026-09-09-a',
    'first listing wins, never last — and `0201` canonicalizes onto the same key as `201`',
  );
  assert.equal(m.get('202'), 'batch-2026-09-09-b');
  assert.equal(batchSlugByMember(undefined).size, 0);
  assert.equal(batchSlugByMember({}).size, 0);
  assert.equal(batchSlugByMember({ runnableBatches: [{ slug: 'x' }] }).size, 0);
});

// review round 3 (findings a67bee / c3f0ee / b8523e / 7d1ba0): `collectPlanStamps` walks EVERY
// active status folder, but the oracle only ever evaluates `ready/`. A browser stamp on a plan no
// board row can come from must therefore NOT admit the tier — otherwise both calls are spawned on
// every render for nothing, and a failure of either prints the browser-tier WARNING over a table
// on which no row ever needed the tier. `waiting-blocked/3560` carries `cloudEnv: browser` today,
// so this is the live case, not a hypothetical one.
test('gatherOracleRuns (review round 3): a cloudEnv browser stamp OUTSIDE ready/ does not admit the browser tier', async () => {
  const seen = [];
  const fakeRunOracle = (args) => {
    seen.push(args);
    return Promise.resolve({ eligible: [], excluded: [], marker: args.join(' ') });
  };
  const parked = await gatherOracleRuns({
    runOracle: fakeRunOracle,
    stamps: {
      1: stamp(),
      3560: stamp({ cloudEnv: 'browser', folder: 'waiting-blocked' }),
      3823: stamp({ cloudEnv: 'browser', folder: 'in-progress' }),
    },
  });
  assert.equal(seen.length, 2, 'only the two --env full calls are spawned');
  assert.ok(seen.every((args) => !args.includes('browser')));
  assert.deepEqual(parked.browserTierStatus, { sonnet: 'skipped', fable: 'skipped' });

  seen.length = 0;
  const ready = await gatherOracleRuns({
    runOracle: fakeRunOracle,
    stamps: {
      3560: stamp({ cloudEnv: 'browser', folder: 'waiting-blocked' }),
      3797: stamp({ cloudEnv: 'browser', folder: 'ready' }),
    },
  });
  assert.equal(seen.length, 4, 'one READY browser plan alongside the parked one runs the tier');
  assert.deepEqual(ready.browserTierStatus, { sonnet: 'ok', fable: 'ok' });
});

// A `fuseBrowserTier(fullRes, undefined)` round-trip: gatherOracleRuns's degrade output is
// exactly the shape fuseBrowserTier's own documented "missing browser result" branch expects —
// pinned end to end so the two pieces are proven to fit together, not just individually correct.
test('gatherOracleRuns + fuseBrowserTier: a browser-tier failure degrades all the way through to the full run’s own verdict, unchanged', async () => {
  const fullPayload = {
    eligible: [],
    excluded: [{ slug: '200-Infra-b', exclude: 'browser-env', reason: 'r' }],
  };
  const fakeRunOracle = (args) =>
    args.includes('browser') ? Promise.reject(new Error('boom')) : Promise.resolve(fullPayload);
  const { sonnet, sonnetBrowser } = await gatherOracleRuns({
    runOracle: fakeRunOracle,
    stamps: browserRungStamps,
  });
  assert.deepEqual(fuseBrowserTier(sonnet, sonnetBrowser), fullPayload);
});

test('readClaims degrades to "none known" when the claim read fails — never a misattribution', () => {
  assert.equal(
    readClaims({
      heldClaims: () => {
        throw new Error('timed out');
      },
    }).size,
    0,
  );
  assert.deepEqual(
    [...readClaims({ heldClaims: () => ({ 2468: { sha: 'abc' }, 2524: { sha: 'def' } }) })],
    ['2468', '2524'],
  );
});

test('readClaims reports only HELD plans, against the repo root (plan 3756)', () => {
  // The seam is the held-claim reader, not a raw ls-remote: since plan 3756 a released claim
  // leaves its ref in place, so ref existence would mark landed plans as claimed and withhold
  // them from every drain firing. heldClaimsMap resolves the tips and is itself capped.
  let seenDir = null;
  readClaims({
    heldClaims: (dir) => {
      seenDir = dir;
      return {};
    },
  });
  assert.match(seenDir, /vetapp/);
});

// ── plan 3619: a gate-blocked drain must not look like one that never started ──
//
// The acceptance criterion the whole plan turns on. On 2026-09-01 a live drain held 4 finished
// commits behind a failing gate, and this board rendered its marker as `⛔ already-on-origin` —
// the same cell a plan whose session died before its first commit gets. The operator read "hands
// off, re-check after the threshold" and the stall sat 3.5h. The oracle now emits its own exclude
// code for the state; because `shortCode` passes unmapped codes through and `cloudCell` renders the
// code verbatim, the distinct render needs no new branch here — but it does need pinning, because
// a future `shortCode` mapping that folded `gate-blocked` into `already-on-origin` would silently
// restore the exact confusion this plan exists to remove.

test('shortCode: gate-blocked passes through as its own code (plan 3619)', () => {
  assert.equal(shortCode({ exclude: 'gate-blocked' }), 'gate-blocked');
});

test('cloudCell: a gate-blocked row renders DISTINCTLY from an already-on-origin row (plan 3619)', () => {
  const gateBlocked = cloudCell({ code: 'gate-blocked' });
  const neverStarted = cloudCell({ code: 'already-on-origin' });
  assert.equal(gateBlocked, '⛔ gate-blocked');
  assert.equal(neverStarted, '⛔ already-on-origin');
  assert.notEqual(gateBlocked, neverStarted);
});

test('cloudCell: gate-blocked still yields to CLAIMED and to the env tags (plan 3619)', () => {
  // The new code is additive — it must not disturb the existing precedence. A claimed plan reads
  // CLAIMED whatever the oracle said, because once a session holds it the cloud verdict is moot.
  assert.equal(cloudCell({ code: 'gate-blocked', claimed: true }), '🔒 CLAIMED');
  assert.equal(cloudCell({ code: 'gate-blocked', fullEnv: true }), '⛔ gate-blocked (full)');
});

// ── plan 3816 fix round (review Fix 3): honest per-run snapshot provenance ────────────────────
// The board runs two oracle calls CONCURRENTLY, each fetching independently, then used to print
// ONE post-hoc `rev-parse origin/master` resolved AFTER both returned — so it could print
// snapshot C while one call's rows actually came from snapshot A or B. Each oracle now reports
// the snapshot it itself read (queue-drain.mjs main()'s additive `originSha` field); this board
// renders straight off those two payloads instead of a third, independently-timed git read.

test('originHeaderLine: sonnet and fable agree — a single short sha', () => {
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: 'abcdef1234567890' },
      fable: { originSha: 'abcdef1234567890' },
    }),
    'source: origin/master @ abcdef1',
  );
});

test('originHeaderLine: sonnet and fable DISAGREE — both short shas, flagged as differing snapshots', () => {
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: 'aaaaaaa1111111111' },
      fable: { originSha: 'bbbbbbb2222222222' },
    }),
    'source: origin/master @ aaaaaaa / bbbbbbb (snapshots differ)',
  );
});

test('originHeaderLine: either originSha missing/null renders "(unknown)" — never a partial/guessed sha', () => {
  const known = { originSha: 'abcdef1234567890' };
  assert.equal(
    originHeaderLine({ sonnet: known, fable: { originSha: null } }),
    'source: origin/master @ (unknown)',
  );
  assert.equal(
    originHeaderLine({ sonnet: { originSha: null }, fable: known }),
    'source: origin/master @ (unknown)',
  );
  assert.equal(
    originHeaderLine({ sonnet: { originSha: null }, fable: { originSha: null } }),
    'source: origin/master @ (unknown)',
  );
  assert.equal(
    originHeaderLine({}),
    'source: origin/master @ (unknown)',
    'a wholly malformed payload degrades the same way, never throws',
  );
});

// ── plan 3816 fix round 2, Fix E: compare FULL shas, only shorten for display ──────────────────
// Two DIFFERENT commits that happen to share a 7-char prefix must never render as "agreed" —
// the prior comparison shortened BEFORE comparing, so a prefix collision was indistinguishable
// from a genuine agreement.
test('originHeaderLine: two full shas sharing a 7-char prefix but differing beyond it are NOT treated as agreeing (Fix E)', () => {
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: 'abcdef1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      fable: { originSha: 'abcdef1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    }),
    'source: origin/master @ abcdef1 / abcdef1 (snapshots differ)',
    'a 7-char prefix collision must still be reported as differing snapshots, not agreement',
  );
});

test('originHeaderLine: identical FULL shas still render as agreement (display still shortens to 7)', () => {
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: 'abcdef1111111111111111111111111111111111' },
      fable: { originSha: 'abcdef1111111111111111111111111111111111' },
    }),
    'source: origin/master @ abcdef1',
  );
});

// ── plan 3816 fix round 2, Fix D: surface fetch-degradation to the board header ────────────────
// A failed origin fetch (or an unreadable local origin/master) used to log ONLY to the oracle
// child process's stderr, which runOracle discards on success — the board silently showed a
// stale/empty snapshot as if it were fresh. `originFetchFailed` carries that degradation into
// the JSON payload so the header can warn instead of staying silent.
test('originHeaderLine: either oracle reporting originFetchFailed appends the stale-board warning (Fix D)', () => {
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: 'aaaaaaa1234567890', originFetchFailed: true },
      fable: { originSha: 'aaaaaaa1234567890', originFetchFailed: false },
    }),
    'source: origin/master @ aaaaaaa — WARNING: origin fetch failed, board may be stale',
    'sonnet alone reporting a failed fetch must still warn',
  );
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: 'aaaaaaa1234567890', originFetchFailed: false },
      fable: { originSha: 'aaaaaaa1234567890', originFetchFailed: true },
    }),
    'source: origin/master @ aaaaaaa — WARNING: origin fetch failed, board may be stale',
    'fable alone reporting a failed fetch must still warn',
  );
});

test('originHeaderLine: originFetchFailed false/absent on both oracles never appends the warning', () => {
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: 'aaaaaaa1234567890', originFetchFailed: false },
      fable: { originSha: 'aaaaaaa1234567890', originFetchFailed: false },
    }),
    'source: origin/master @ aaaaaaa',
  );
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: 'aaaaaaa1234567890' },
      fable: { originSha: 'aaaaaaa1234567890' },
    }),
    'source: origin/master @ aaaaaaa',
    'a payload from before this fix (no originFetchFailed field at all) is non-fatal and warns nothing',
  );
});

// ── plan 3816 fix round 3 (review keys f5ba3e/1494a6): surface the unreadable-blob skip ─────────
// The prior round's readyEntriesFromOrigin guard skips an unreadable ready/ blob and logs one
// line to the oracle CHILD PROCESS's stderr — which this board's runOracle discards on a
// successful exit, so `/ready-plans` rendered a fresh-looking snapshot silently missing a ready
// plan. `originSkippedUnreadable` (main()'s additive field, same plumbing as originFetchFailed)
// carries that count across the child-process boundary so the header can warn instead.
test('originHeaderLine: either oracle reporting originSkippedUnreadable > 0 appends the unreadable-skip warning', () => {
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: 'aaaaaaa1234567890', originSkippedUnreadable: 1 },
      fable: { originSha: 'aaaaaaa1234567890', originSkippedUnreadable: 0 },
    }),
    'source: origin/master @ aaaaaaa — WARNING: 1 ready plan(s) unreadable at that snapshot and omitted',
    'sonnet alone reporting a skip must still warn',
  );
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: 'aaaaaaa1234567890', originSkippedUnreadable: 0 },
      fable: { originSha: 'aaaaaaa1234567890', originSkippedUnreadable: 2 },
    }),
    'source: origin/master @ aaaaaaa — WARNING: 2 ready plan(s) unreadable at that snapshot and omitted',
    'fable alone reporting a skip must still warn, and the count it reports is the one used',
  );
});

test('originHeaderLine: originSkippedUnreadable 0/absent on both oracles never appends the unreadable-skip warning', () => {
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: 'aaaaaaa1234567890', originSkippedUnreadable: 0 },
      fable: { originSha: 'aaaaaaa1234567890', originSkippedUnreadable: 0 },
    }),
    'source: origin/master @ aaaaaaa',
  );
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: 'aaaaaaa1234567890' },
      fable: { originSha: 'aaaaaaa1234567890' },
    }),
    'source: origin/master @ aaaaaaa',
    'a payload from before this fix (no originSkippedUnreadable field at all) warns nothing — the clean case renders exactly as it did before this round',
  );
});

test('originHeaderLine: a failed fetch AND an unreadable-blob skip both warn, fetch-failure FIRST', () => {
  assert.equal(
    originHeaderLine({
      sonnet: {
        originSha: 'aaaaaaa1234567890',
        originFetchFailed: true,
        originSkippedUnreadable: 1,
      },
      fable: {
        originSha: 'aaaaaaa1234567890',
        originFetchFailed: false,
        originSkippedUnreadable: 0,
      },
    }),
    'source: origin/master @ aaaaaaa — WARNING: origin fetch failed, board may be stale' +
      ' — WARNING: 1 ready plan(s) unreadable at that snapshot and omitted',
  );
});

// ── review round 2, finding #2: rows can now be promoted/revised on the strength of a BROWSER
// run — the provenance header must account for it, the same way it already accounts for
// sonnet/fable. sonnet/fable stay REQUIRED (every test above, unmodified, proves the two-run
// call shape still behaves byte-for-byte); sonnetBrowser/fableBrowser are OPTIONAL on top.

test('originHeaderLine: sonnetBrowser/fableBrowser agreeing with sonnet/fable is still a single short sha', () => {
  const sha = 'abcdef1234567890';
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: sha },
      fable: { originSha: sha },
      sonnetBrowser: { originSha: sha },
      fableBrowser: { originSha: sha },
    }),
    'source: origin/master @ abcdef1',
  );
});

test('originHeaderLine: a browser run reading a DIFFERENT snapshot is flagged as differing — the header must not silently ignore it', () => {
  const sha = 'aaaaaaa1111111111';
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: sha },
      fable: { originSha: sha },
      sonnetBrowser: { originSha: 'bbbbbbb2222222222' },
    }),
    'source: origin/master @ aaaaaaa / aaaaaaa / bbbbbbb (snapshots differ)',
  );
});

test('originHeaderLine: sonnetBrowser/fableBrowser omitted entirely (the pre-3823 two-run call shape) behaves byte-for-byte as before — never forced to (unknown), never a fabricated disagreement', () => {
  const sha = 'abcdef1234567890';
  assert.equal(
    originHeaderLine({ sonnet: { originSha: sha }, fable: { originSha: sha } }),
    'source: origin/master @ abcdef1',
  );
});

test('originHeaderLine: a browser run present but with no sha of its own (its browser tier degraded, or its own fetch failed before a sha resolved) does not force the header to (unknown) when sonnet/fable are healthy', () => {
  const sha = 'abcdef1234567890';
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: sha },
      fable: { originSha: sha },
      sonnetBrowser: { originSha: null },
      fableBrowser: undefined,
    }),
    'source: origin/master @ abcdef1',
  );
});

test('originHeaderLine: sonnet/fable stay REQUIRED — either missing still forces (unknown) even when both browser runs are healthy', () => {
  const sha = 'abcdef1234567890';
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: sha },
      fable: { originSha: null },
      sonnetBrowser: { originSha: sha },
      fableBrowser: { originSha: sha },
    }),
    'source: origin/master @ (unknown)',
  );
});

test('originHeaderLine: a browser run reporting originFetchFailed/originSkippedUnreadable still warns, exactly like sonnet/fable already do', () => {
  const sha = 'abcdef1234567890';
  const out = originHeaderLine({
    sonnet: { originSha: sha },
    fable: { originSha: sha },
    sonnetBrowser: { originSha: sha, originFetchFailed: true },
    fableBrowser: { originSha: sha, originSkippedUnreadable: 2 },
  });
  assert.match(out, /WARNING: origin fetch failed, board may be stale/);
  assert.match(out, /WARNING: 2 ready plan\(s\) unreadable at that snapshot and omitted/);
});

// review round 2, finding B: the OLD `browserTierFailed` boolean is replaced by a PER-LANE
// `browserTierStatus` — the tests below replace the old boolean-shaped tests they pinned (a
// shared boolean printed a false "no browser-only promotions were applied" statement whenever
// only ONE lane's browser call failed, since the surviving lane's promotions still landed on the
// board while the header claimed none had). finding #1's degrade is still surfaced on the SAME
// header (finding #2's own point: a degraded browser tier must be visible to the operator, not
// silently absorbed) — only the shape of what triggers it changed.
test('originHeaderLine (finding B): a single failed lane names ITSELF, ordered AFTER the fetch/skip warnings, and never forces (unknown) on a healthy full-env pair', () => {
  const sha = 'abcdef1234567890';
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: sha },
      fable: { originSha: sha },
      browserTierStatus: { sonnet: 'failed', fable: 'ok' },
    }),
    'source: origin/master @ abcdef1 — WARNING: the browser-env tier could not be reached ' +
      'this run for the sonnet lane; no browser-only promotions/revisions applied there',
  );
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: sha },
      fable: { originSha: sha },
      browserTierStatus: { sonnet: 'ok', fable: 'failed' },
    }),
    'source: origin/master @ abcdef1 — WARNING: the browser-env tier could not be reached ' +
      'this run for the fable lane; no browser-only promotions/revisions applied there',
    'the OTHER lane failing names ITSELF, not the lane that actually succeeded',
  );
  const withAll = originHeaderLine({
    sonnet: { originSha: sha, originFetchFailed: true },
    fable: { originSha: sha },
    browserTierStatus: { sonnet: 'failed', fable: 'ok' },
  });
  const fetchIdx = withAll.indexOf('origin fetch failed');
  const browserIdx = withAll.indexOf('browser-env tier could not be reached');
  assert.ok(
    fetchIdx > -1 && browserIdx > fetchIdx,
    'fetch warning still comes before the browser one',
  );
});

test('originHeaderLine (finding B): BOTH lanes failing names both, joined "and", plural "lanes"', () => {
  const sha = 'abcdef1234567890';
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: sha },
      fable: { originSha: sha },
      browserTierStatus: { sonnet: 'failed', fable: 'failed' },
    }),
    'source: origin/master @ abcdef1 — WARNING: the browser-env tier could not be reached ' +
      'this run for the sonnet and fable lanes; no browser-only promotions/revisions applied ' +
      'there',
  );
});

// finding E: a SKIPPED lane (no ready plan carried cloudEnv: browser this run, so
// gatherOracleRuns never even spawned the call) must never read as a degradation — the whole
// point of the third status is that "nothing to do" and "tried and failed" are different facts.
test('originHeaderLine (finding E): a SKIPPED browser lane never warns — skipped is not a failure', () => {
  const sha = 'abcdef1234567890';
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: sha },
      fable: { originSha: sha },
      browserTierStatus: { sonnet: 'skipped', fable: 'skipped' },
    }),
    'source: origin/master @ abcdef1',
  );
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: sha },
      fable: { originSha: sha },
      browserTierStatus: { sonnet: 'skipped', fable: 'failed' },
    }),
    'source: origin/master @ abcdef1 — WARNING: the browser-env tier could not be reached ' +
      'this run for the fable lane; no browser-only promotions/revisions applied there',
    'a mixed skipped/failed run names only the genuinely failed lane',
  );
});

test('originHeaderLine: browserTierStatus absent (a payload from before this fix, or every lane ok) never appends the browser warning', () => {
  const sha = 'abcdef1234567890';
  assert.equal(
    originHeaderLine({
      sonnet: { originSha: sha },
      fable: { originSha: sha },
      browserTierStatus: { sonnet: 'ok', fable: 'ok' },
    }),
    'source: origin/master @ abcdef1',
  );
  assert.equal(
    originHeaderLine({ sonnet: { originSha: sha }, fable: { originSha: sha } }),
    'source: origin/master @ abcdef1',
    'a payload from before this fix (no browserTierStatus field at all) warns nothing',
  );
});
