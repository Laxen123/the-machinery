// scripts/queue-drain.test.mjs — unit tests for the read-only eligibility
// oracle. Pure functions only (no fs/git): parsePlanMeta / selectEligible /
// parseCost. Required scenarios (plan 231 Phase 1): empty / all-blocked /
// landing-mutex / operator-gated / 🟩-first sort / malformed Blocked-by.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parsePlanMeta,
  selectEligible,
  parseCost,
  readReadyMetas,
  OPERATOR_GATE_RX,
  OPERATOR_INTERACTIVE_RX,
  operatorInteractiveReason,
  operatorInteractiveReasonInBody,
  operatorGatedByText,
  closeoutTailSpans,
  CLOUD_ENV_LANES,
  CLOUD_ENV_RUNGS,
  tailScopedBody,
  tailOnlyBlockedByLines,
  parseExecutionHeads,
  planIdsFromRemoteHeads,
  originExecutedPlanIds,
  collapseSameShaBranches,
  HANDS_OFF_VERDICT_REASONS,
  UNKNOWN_LIVENESS_VERDICT_REASONS,
  seedLaneHeldFromRows,
  // plan 3443 review-fix tests (Fixes 1-7): the reaper's own step functions, exported +
  // dependency-injected (an optional `_exec` defaulting to the real execFileSync) so this file
  // can drive them without shelling out to real git/board.mjs.
  landingHeldViaBoard,
  queueStateFor,
  branchProgressedSince,
  reapRowIfStale,
  resolveLandingHeldForSeedLane,
  readPlanContentFromOrigin,
} from './queue-drain.mjs';
import { canonicalPlanId } from './batch-paths.mjs';
import { readSeedMarker, MUTATION_BANNER_LABEL, ARCHIVE_FOLDER } from './build-index-lib.mjs';

// plan 3958: MUTATION_BANNER_LABEL self-resolves to 'SEED-WRITE' in vetapp's real checkout and
// the public coord-kit's neutral 'DATA-WRITE' default in the built kit — every fixture below that
// the parsers under test actually READ (not a test title, which is just a label) must use it
// instead of the literal 'SEED-WRITE' text, or it silently stops matching in the kit.
const sw = (s) => s.replaceAll('SEED-WRITE', MUTATION_BANNER_LABEL);
// plan 3962 P1: parsePlanMeta no longer carries its own cloudRepos valid-key set (that edge to
// the project registry was cut — see queue-drain.mjs's import comment); this TEST is a project
// file, so it supplies the real vetapp set explicitly, exactly as main() does from
// coord.config.json at runtime.
import { VALID_CLOUD_REPOS } from './cloud-repos-lib.mjs';
// plan 3960 review fix (findings 3/4/5/17): a REAL isolated repo (a fresh module graph, per
// build-index-lib.test.mjs's own precedent) proving a configured lanes.ready rename actually
// reaches queue-drain.mjs's module-scope-resolved READY_FOLDER — this test file's own
// already-imported module is vetapp's own unconfigured instance and would trivially "pass"
// without proving anything.
import { makeIsolatedRepo } from '../test-helpers/isolated-plan-repo.mjs';
import { DEAD_SEED_MIN_AGE_MS } from './coord-git.mjs';
// plan 3748: proves the split-banner gate behaviour THROUGH the existing,
// byte-identical shouldPauseForCost — no second gate, no drain-run.mjs edit.
import { shouldPauseForCost } from './drain-run.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

// --- helpers -----------------------------------------------------------------

// Minimal plan body with a banner; extra clauses appended verbatim.
function plan({ seed = 'NO', extra = '' } = {}) {
  return `> ${seed === 'YES' ? '🟥' : '🟩'} **${MUTATION_BANNER_LABEL}: ${seed}** — test.\n\n# Test plan\n\n${extra}\n`;
}

// A parsed meta with explicit fields (bypasses parsing for selection tests).
// `cost` is a raw forecast string (e.g. '$3'); default null → unknown cost.
function meta({
  id,
  seedWrite = 'no',
  exclude = null,
  cost = null,
  staleBlockedBy = null,
  // plan 2556: `{ slug, otherwise }` on a batch-held plan (see parsePlanMeta) — the
  // input selectEligible's runnableBatches pass reads. Null on every other plan.
  batchHold = null,
  // plan 3111: the `adoptBranch:` stamp — the explicit assertion that the branch origin
  // carries for this id is DEAD work to inherit, not a live rival's marker.
  adoptBranch = null,
  // plan 3461 round 3: `toItem()` (queue-drain.mjs) no longer defaults a missing `lane` to
  // 'sonnet' — a real `parsePlanMeta` output always carries one (a non-null `execLaneInfo` by
  // construction), so a candidate meta reaching `toItem()` with no lane is now a thrown
  // invariant violation, not a silent default. This fixture SIMULATES parsePlanMeta's output,
  // so it must supply the field explicitly instead of relying on the removed implicit default —
  // 'sonnet' is the same value every pre-existing call site got before the fallback existed.
  lane = 'sonnet',
}) {
  return {
    id,
    slug: `${id}-X-test`,
    seedWrite,
    blockedBy: null,
    cost: parseCost(cost),
    exclude,
    staleBlockedBy,
    batchHold,
    adoptBranch,
    lane,
  };
}

// plans 3111/3583: the origin-heads map carries branch names plus the fresh-stake discriminator.
function originMap(byId) {
  return new Map(
    Object.entries(byId).map(([id, branches]) => [
      id,
      []
        .concat(branches)
        .map((branch) => (typeof branch === 'string' ? { name: branch, fresh: false } : branch)),
    ]),
  );
}

// plan 2556: a batch-held meta + the roster entry that holds it, built together so a test
// cannot accidentally describe a member and a roster that disagree about the slug.
function heldMeta({ id, slug, otherwise = null, seedWrite = 'no' }) {
  return meta({ id, seedWrite, exclude: 'batch', batchHold: { slug, otherwise } });
}
const rosterEntry = (slug, members) => ({ slug, lane: '🟩', members: members.map(String) });

// --- parseCost ---------------------------------------------------------------

test('parseCost: explicit $0 / no-LLM is zero', () => {
  assert.equal(parseCost('$0 LLM beyond WebSearch').usd, 0);
  assert.equal(parseCost('~30 min focused work + test. No LLM spend.').usd, 0);
  assert.equal(parseCost('No LLM spend.').unknown, false);
  // A pure-$0 banner (no larger figure anywhere) still resolves to 0.
  assert.equal(parseCost('$0 — pure code + unit-test change; no LLM, no API.').usd, 0);
});

test('parseCost: max-of-figures — a leading $0 component does not mask the real total (335 shape)', () => {
  // Regression: parseCost used to short-circuit to usd:0 on the FIRST "$0" it
  // saw ("render $0"), under-reporting a plan whose true spend is ~$10–20 and
  // making it look Phase-3 auto-landable. Max-of-all-figures fixes it.
  const c = parseCost('full-crawl + render $0 … vision ≈ $3–4; extraction ≈ $6–18');
  assert.equal(c.usd, 18); // max of {0, 3, 4, 6, 18}, not the leading 0
  assert.equal(c.over, false); // dominant figure is a plain dollar, not a ceiling
  assert.equal(c.unknown, false);
});

test('parseCost: a $0 setup component before a real total takes the total', () => {
  assert.equal(parseCost('$0 setup, then ~$12 of claude -p').usd, 12);
});

test('parseCost: ceiling form flags over', () => {
  const c = parseCost('> $5 of claude -p');
  assert.equal(c.usd, 5);
  assert.equal(c.over, true);
});

test('parseCost: plain figure', () => {
  assert.equal(parseCost('~$3 per batch').usd, 3);
  // A "$8–$10" range resolves to its HIGH end (10) — max-of-range is the
  // conservative pause-gate reading; under-reporting is the dangerous
  // direction. (No gate-behavior change here: both 8 and 10 are > $5.)
  assert.equal(parseCost('$8–$10 of claude -p spend').usd, 10);
});

test('parseCost: absent / prose-only is unknown', () => {
  assert.equal(parseCost(null).unknown, true);
  assert.equal(parseCost('TBD — depends on cohort size').unknown, true);
});

// --- parseCost: split Cash/Claude grammar (plan 3748) -------------------------

test('parseCost: split banner — both axes with figures', () => {
  const c = parseCost('Cash $2 · Claude ~$1 — Google Geocoding (low-hundreds reqs).');
  assert.equal(c.usd, 2); // usd is the Cash figure, not the Claude one
  assert.equal(c.split, true);
  assert.equal(c.unknown, false);
  assert.deepEqual(c.claude, { usd: 1, over: false });
});

test('parseCost: split banner — Claude over $5, Cash $0 does not pause shouldPauseForCost', () => {
  const c = parseCost('Cash $0 · Claude ~$85 — a claude -p fan-out; no money leaves an account.');
  assert.equal(c.usd, 0);
  assert.equal(c.unknown, false);
  assert.deepEqual(c.claude, { usd: 85, over: false });
  assert.equal(shouldPauseForCost(c), false); // behaviour change: Claude spend never gates
});

test('parseCost: split banner — Cash over $5 still pauses shouldPauseForCost', () => {
  const c = parseCost('Cash ~$85 · Claude $0 — a paid scrape; no model spend.');
  assert.equal(c.usd, 85);
  assert.equal(shouldPauseForCost(c), true);
});

test('parseCost: split banner — a range in one part takes its high end, leaves the other axis alone', () => {
  const c = parseCost('Cash $0 · Claude ~$6–12 — Sol extraction over ~20 records, twice.');
  assert.equal(c.usd, 0);
  assert.deepEqual(c.claude, { usd: 12, over: false });
});

test('parseCost: split banner — a prose-tail figure does not leak into the Cash max', () => {
  const c = parseCost('Cash $0 · Claude ~$2 — Sol extraction at $0.025/call, ~80 calls.');
  assert.equal(c.usd, 0); // the $0.025 prose-tail figure must not become the Cash max
});

test('parseCost: half-written split is malformed, not a silent legacy fall-back', () => {
  assert.equal(parseCost('Cash $0 · Claude').unknown, true);
  assert.equal(parseCost('Claude ~$4').unknown, true); // no Cash label at all
});

// A LONE label only counts as a label when a figure actually follows it. Ordinary
// legacy prose that merely OPENS with the word "Claude" (or "Cash") is not a
// half-written split — it is the pre-3748 grammar and must keep parsing as such.
// Getting this wrong is repo-wide: an unparseable banner both pauses the drain
// (cost.unknown) and makes lint-plan-cost-forecast block EVERY session's next push.
test('parseCost: legacy prose opening with "Claude"/"Cash" is not a malformed split', () => {
  const fanout = parseCost('Claude -p fan-out over ~20 records, ~$12 total.');
  assert.equal(fanout.unknown, false, 'a "claude -p" legacy banner must still parse');
  assert.equal(fanout.split, false);
  assert.equal(fanout.claude, null);
  assert.equal(fanout.usd, 12); // legacy max-of-figures ("~20 records" carries no $)

  const outlay = parseCost('Cash outlay ~$3 for Google Places; nothing else.');
  assert.equal(outlay.unknown, false, 'a "Cash outlay" legacy banner must still parse');
  assert.equal(outlay.split, false);
  assert.equal(outlay.usd, 3);

  // The discriminator is "is the part NOTHING BUT label + figure", not "does a
  // figure follow the label" — prose continuing AFTER the figure is still prose.
  const withFigureThenProse = parseCost('Claude $85 fan-out; no cash leaves an account.');
  assert.equal(withFigureThenProse.unknown, false);
  assert.equal(withFigureThenProse.split, false);
  assert.equal(withFigureThenProse.usd, 85);
});

test('parseCost: a lone label with a no-dollar ceiling is still a malformed split', () => {
  // The legacy grammar accepts a bare "> 5" ceiling (CEIL_RX makes the $
  // optional), so the malformed-split guard must recognise that spelling too —
  // otherwise `Cash > 5` slips through to the legacy path and reads as a
  // FIGURE rather than the half-written split it is.
  assert.equal(parseCost('Cash > 5').unknown, true);
  assert.equal(parseCost('Claude ≥ 12').unknown, true);
});

test('parseCost: split labels are case-insensitive', () => {
  const c = parseCost('cash $2 · CLAUDE ~$1 — Google Geocoding.');
  assert.equal(c.usd, 2);
  assert.equal(c.split, true);
  assert.deepEqual(c.claude, { usd: 1, over: false });
});

test('parseCost: legacy single-figure banner parses byte-identically, claude null, split false', () => {
  const c = parseCost('~$2 — Google Geocoding (low-hundreds reqs, under $5).');
  assert.equal(c.usd, 5); // unchanged max-of-figures quirk on the legacy path
  assert.equal(c.split, false);
  assert.equal(c.claude, null);
  assert.equal(c.unknown, false);
});

test('parseCost: legacy "no LLM spend" prose zero is unchanged', () => {
  const c = parseCost('~30 min focused work + test. No LLM spend.');
  assert.equal(c.usd, 0);
  assert.equal(c.unknown, false);
  assert.equal(c.split, false);
  assert.equal(c.claude, null);
});

// --- parsePlanMeta -----------------------------------------------------------

test('parsePlanMeta: id + SEED-WRITE banner', () => {
  const m = parsePlanMeta('231-Other-autonomous-ready-queue-drain.md', plan({ seed: 'NO' }));
  assert.equal(m.id, 231);
  assert.equal(m.seedWrite, 'no');
  assert.equal(m.exclude, null);
});

test('parsePlanMeta: a 4-digit id is parsed; a full-date legacy plan stays Infinity (plan 1002)', () => {
  // the fix: a 4-digit id (plan 1000+) parses in full, not Infinity (was `/^(\d{3})-/` → no match)
  assert.equal(parsePlanMeta('1001-Other-acct-foo.md', plan({ seed: 'NO' })).id, 1001);
  // date-safety preserved: a legacy full-date plan (no NNN prefix) must NOT parse "2026" as an id
  assert.equal(parsePlanMeta('2026-05-16-card-ux-followups.md', plan({ seed: 'NO' })).id, Infinity);
});

test('parsePlanMeta: 🟥 banner detected', () => {
  const m = parsePlanMeta('150-P07-seed-thing.md', plan({ seed: 'YES' }));
  assert.equal(m.seedWrite, 'yes');
});

// Banner-variant robustness (plan 948): the SEED-WRITE reader must tolerate
// markdown emphasis between the colon and the value. `**SEED-WRITE:** no`
// (colon INSIDE the bold, value OUTSIDE) used to parse seedWrite=null, which
// isSeedWrite() conservatively treats as 🟥 — so a genuine 🟩 docs/wiki plan
// got silently dropped by the LANDING mutex (observed live: plan 943).
test('parsePlanMeta: SEED-WRITE banner — colon+value both inside bold (**SEED-WRITE: no**)', () => {
  const m = parsePlanMeta('900-X-thing.md', sw('> 🟩 **SEED-WRITE: no** — test.\n'));
  assert.equal(m.seedWrite, 'no');
});

test('parsePlanMeta: SEED-WRITE banner — colon inside bold, value outside (**SEED-WRITE:** no)', () => {
  const m = parsePlanMeta('943-X-thing.md', sw('> 🟩 **SEED-WRITE:** no.\n'));
  assert.equal(m.seedWrite, 'no');
});

test('parsePlanMeta: SEED-WRITE banner — no markdown emphasis (🟥 SEED-WRITE yes)', () => {
  const m = parsePlanMeta('901-X-thing.md', sw('> 🟥 SEED-WRITE yes — mutates seed.\n'));
  assert.equal(m.seedWrite, 'yes');
});

test('parsePlanMeta: SEED-WRITE MAYBE parses (not null) so the mutex stays conservative 🟥', () => {
  // MAYBE is captured (not dropped to null); isSeedWrite() treats anything !=
  // 'no' as 🟥, so a "maybe" plan is conservatively withheld under the mutex.
  const m = parsePlanMeta('902-X-thing.md', sw('> **SEED-WRITE:** MAYBE — unsure.\n'));
  assert.equal(m.seedWrite, 'maybe');
});

// Cross-consistency (plan 1324): parsePlanMeta and readSeedMarker both route
// through the ONE shared parse (build-index-lib readSeedWriteValue), so across
// the full live-convention banner table they must never disagree in the
// mutex-relevant direction — a plan the drain mutexes as seed-write while the
// INDEX bullet renders it 🟩 (the 2026-07-02 1278/1282 drift), or vice versa.
// The one deliberate divergence stays: a MISSING banner is 🟩 on the display
// side but conservatively seed-write for the mutex (asserted separately below).
test('parsePlanMeta ⇄ readSeedMarker: agree across the live-convention banner table (plan 1324)', () => {
  // Every banner that carries SOME signal — a parseable value (YES/NO/MAYBE)
  // and/or an emoji. Signal-less mentions (no emoji + unparseable value) are
  // the missing-banner class, asserted in the divergence test below.
  const table = [];
  for (const emoji of ['🟥 ', '🟩 ', '']) {
    for (const value of emoji ? ['YES', 'no', 'MAYBE', 'conditional'] : ['YES', 'no', 'MAYBE']) {
      table.push(
        `> ${emoji}**${MUTATION_BANNER_LABEL}: ${value}** — colon+value inside bold\n`,
        `> ${emoji}**${MUTATION_BANNER_LABEL}:** ${value} — colon inside, value outside\n`,
        `> ${emoji}**${MUTATION_BANNER_LABEL}**: ${value} — colon outside bold\n`,
        `> ${emoji}${MUTATION_BANNER_LABEL}: ${value} — no bold\n`,
        `> ${emoji}***${MUTATION_BANNER_LABEL}:*** ${value} — bold+italic (pre-1324 drain grammar)\n`,
      );
    }
    if (emoji) table.push(`> ${emoji}**${MUTATION_BANNER_LABEL}** — bare form, no value\n`);
  }
  for (const body of table) {
    const drainSeedy = parsePlanMeta('900-X-t.md', body).seedWrite !== 'no'; // isSeedWrite()
    const marker = readSeedMarker(body);
    if (marker === '🟩' && drainSeedy)
      assert.fail(`drain mutexes as seed-write but INDEX renders 🟩: ${JSON.stringify(body)}`);
    if (marker === '🟥' && !drainSeedy)
      assert.fail(`INDEX renders 🟥 but drain lets it bypass the mutex: ${JSON.stringify(body)}`);
  }
});

test('no parseable signal: display defaults 🟩, mutex stays conservative (documented divergence)', () => {
  // Missing banner and signal-less mention (no emoji, unparseable value) are
  // the same class: no signal → 🟩 display default (plan 362), null → drain
  // treats as seed-write (unknown must not land during a LANDING).
  for (const body of [
    '# A plan with no banner at all\n',
    sw('> **SEED-WRITE: conditional** — no emoji\n'),
  ]) {
    assert.equal(readSeedMarker(body), '🟩');
    assert.equal(parsePlanMeta('901-X-t.md', body).seedWrite, null); // null ⇒ isSeedWrite() true
  }
});

test('parsePlanMeta: operator-gated body excluded (account-gated, like 221)', () => {
  const m = parsePlanMeta(
    '221-SEO-recon.md',
    plan({
      extra: 'Operator supplies the volume export (paid/account-gated, not agent-accessible).',
    }),
  );
  assert.equal(m.exclude, 'operator');
});

test('parsePlanMeta: cross-plan Blocked-by excluded as blocked', () => {
  const m = parsePlanMeta(
    '177-P07-thing.md',
    plan({ extra: '**Blocked-by:** 009-common-services-backfill-v2 landing' }),
  );
  assert.equal(m.exclude, 'blocked');
});

// --- Blocked-by / archive check (plan 1819) ----------------------------------
//
// A Blocked-by line naming a plan is verified against a precomputed
// `archivedIds` Set (parsePlanMeta stays pure — no fs read here) instead of
// being trusted at face value: archived ⇒ stale line, include + warn; not
// archived (still in flight elsewhere, or the id matches no plan file at all)
// ⇒ unchanged conservative exclude.

test('parsePlanMeta: Blocked-by naming an ARCHIVED plan is stale — included, with a staleBlockedBy warning (plan 1819)', () => {
  const m = parsePlanMeta(
    '1790-Other-downstream.md',
    plan({ extra: '**Blocked-by:** plan 1760 (in flight)' }),
    { archivedIds: new Set(['1760']) },
  );
  assert.equal(m.exclude, null);
  assert.match(m.staleBlockedBy, /1760/);
  assert.match(m.staleBlockedBy, /archived/);
});

test('parsePlanMeta: Blocked-by naming a plan still in flight (not in archivedIds) stays excluded as blocked — unchanged (plan 1819)', () => {
  const m = parsePlanMeta(
    '1790-Other-downstream.md',
    plan({ extra: '**Blocked-by:** plan 1760 (in flight)' }),
    { archivedIds: new Set(['1761']) }, // a DIFFERENT plan is archived — 1760 itself is not
  );
  assert.equal(m.exclude, 'blocked');
  assert.equal(m.staleBlockedBy, null);
});

test('parsePlanMeta: Blocked-by id matching no plan file anywhere stays excluded — conservative, unchanged (plan 1819)', () => {
  const m = parsePlanMeta(
    '1790-Other-downstream.md',
    plan({ extra: '**Blocked-by:** plan 9999 (unknown)' }),
    { archivedIds: new Set() },
  );
  assert.equal(m.exclude, 'blocked');
  assert.equal(m.staleBlockedBy, null);
});

test('parsePlanMeta: archivedIds omitted (default empty Set) is byte-identical to pre-1819 — plan-shaped Blocked-by still excludes (plan 1819)', () => {
  const m = parsePlanMeta(
    '177-P07-thing.md',
    plan({ extra: '**Blocked-by:** 009-common-services-backfill-v2 landing' }),
  );
  assert.equal(m.exclude, 'blocked');
  assert.equal(m.staleBlockedBy, null);
});

// Review fix: a multi-blocker line ("plan 1055 and plan 1541") is stale only
// when EVERY named blocker id is archived — a single still-open blocker keeps
// the whole line 'blocked', even though an earlier-named sibling already landed.
test('parsePlanMeta: multi-blocker line, only the FIRST-named id archived — stays excluded, not stale (plan 1819 review fix)', () => {
  const m = parsePlanMeta(
    '1790-Other-downstream.md',
    plan({
      extra:
        '**Blocked-by:** plan 1055 (SE national price re-extraction) and plan 1541 (NO+DK national price re-extraction)',
    }),
    { archivedIds: new Set(['1055']) }, // 1541 is still in flight
  );
  assert.equal(m.exclude, 'blocked');
  assert.equal(m.staleBlockedBy, null);
});

test('parsePlanMeta: multi-blocker line, only the SECOND-named id archived — stays excluded, not stale (plan 1819 review fix)', () => {
  const m = parsePlanMeta(
    '1790-Other-downstream.md',
    plan({
      extra:
        '**Blocked-by:** plan 1055 (SE national price re-extraction) and plan 1541 (NO+DK national price re-extraction)',
    }),
    { archivedIds: new Set(['1541']) }, // 1055 is still in flight
  );
  assert.equal(m.exclude, 'blocked');
  assert.equal(m.staleBlockedBy, null);
});

test('parsePlanMeta: multi-blocker line, ALL named ids archived — stale, included, warning names both (plan 1819 review fix)', () => {
  const m = parsePlanMeta(
    '1790-Other-downstream.md',
    plan({
      extra:
        '**Blocked-by:** plan 1055 (SE national price re-extraction) and plan 1541 (NO+DK national price re-extraction)',
    }),
    { archivedIds: new Set(['1055', '1541']) },
  );
  assert.equal(m.exclude, null);
  assert.match(m.staleBlockedBy, /1055/);
  assert.match(m.staleBlockedBy, /1541/);
});

// --- archived-but-not-shipped gets its OWN exclude reason (plan 2496) --------
//
// The drain oracle's archivedIds Set (readArchivedIds, plan 1836) already only
// holds SHIPPED archive ids — a blocker archived 🗄️ SUPERSEDED/abandoned, with no
// ✅ COMPLETED stamp, was NOT in archivedIds and so fell through to the generic
// `exclude: 'blocked'` bucket, indistinguishable from a blocker that is simply
// still open in ready/. That is exactly the standing divergence plan 2496 is
// about: the write-time board gate (blocked-by-lib.mjs's classifyBlocked) applies
// the SAME shipped-stamp test and hard-refuses the claim, every run, on a plan the
// oracle offered as merely 'blocked' — no different-looking than any other blocked
// plan. `archivedUnshippedIds` (the sibling Set to `archivedIds`, both produced by
// one readArchivedIds scan) lets parsePlanMeta name this case
// `blocker_archived_unshipped` instead, so the plan is excluded — never reaches
// the gate — WITH a reason distinct from "blocker still in flight".

test('parsePlanMeta: Blocked-by naming a plan ARCHIVED WITHOUT the shipped stamp gets its own exclude reason, not generic blocked (plan 2496)', () => {
  const m = parsePlanMeta(
    '1790-Other-downstream.md',
    plan({ extra: '**Blocked-by:** plan 1760 (superseded upstream)' }),
    { archivedIds: new Set(), archivedUnshippedIds: new Set(['1760']) },
  );
  assert.equal(m.exclude, 'blocker_archived_unshipped');
  assert.equal(m.staleBlockedBy, null);
  assert.match(m.excludeReason, /1760/);
  assert.match(m.excludeReason, /not-shipped/);
});

test('parsePlanMeta: Blocked-by naming a plan ARCHIVED WITH the shipped stamp still clears normally — no regression of plan 1819 (plan 2496)', () => {
  const m = parsePlanMeta(
    '1790-Other-downstream.md',
    plan({ extra: '**Blocked-by:** plan 1760 (landed upstream)' }),
    // A shipped id must win even when (by construction it never would, but this
    // pins the precedence explicitly) it were also present in archivedUnshippedIds:
    // the ALL-shipped branch is checked FIRST in parsePlanMeta.
    { archivedIds: new Set(['1760']), archivedUnshippedIds: new Set(['1760']) },
  );
  assert.equal(m.exclude, null);
  assert.match(m.staleBlockedBy, /1760/);
  assert.match(m.staleBlockedBy, /archived/);
});

test('parsePlanMeta: multi-blocker line, all archived but only SOME shipped — blocker_archived_unshipped, not stale (plan 2496)', () => {
  const m = parsePlanMeta(
    '1790-Other-downstream.md',
    plan({
      extra:
        '**Blocked-by:** plan 1055 (SE national price re-extraction) and plan 1541 (superseded)',
    }),
    { archivedIds: new Set(['1055']), archivedUnshippedIds: new Set(['1541']) },
  );
  assert.equal(m.exclude, 'blocker_archived_unshipped');
  assert.equal(m.staleBlockedBy, null);
});

test('parsePlanMeta: multi-blocker line, one archived-unshipped and one still fully open — stays generic blocked, not the new reason (plan 2496)', () => {
  const m = parsePlanMeta(
    '1790-Other-downstream.md',
    plan({
      extra:
        '**Blocked-by:** plan 1055 (superseded, archived) and plan 1541 (still in ready/, in flight)',
    }),
    { archivedIds: new Set(), archivedUnshippedIds: new Set(['1055']) }, // 1541 is not archived at all
  );
  assert.equal(m.exclude, 'blocked');
  assert.match(m.excludeReason, /1055/);
  assert.match(m.excludeReason, /1541/);
});

test('parsePlanMeta: archivedUnshippedIds omitted (default empty Set) is byte-identical to pre-2496 behaviour — still excludes as generic blocked', () => {
  const m = parsePlanMeta(
    '1790-Other-downstream.md',
    plan({ extra: '**Blocked-by:** plan 1760 (superseded upstream)' }),
    { archivedIds: new Set() }, // no archivedUnshippedIds passed at all
  );
  assert.equal(m.exclude, 'blocked');
  assert.equal(m.staleBlockedBy, null);
});

// --- strikethrough Blocked-by clearing (plan 2174) ---------------------------
//
// Spec-sweeps/board-passes "clear" a stale blocker by striking it through
// (`~~2123~~ CLEARED …`) instead of erasing it. Strip-then-classify: struck
// plan ids must not feed extractBlockedPlanIds (no staleBlockedBy resurrection),
// and a struck bare-id line's remainder is judged on its own.

test('parsePlanMeta: a struck bare-id "(i)" — ~~2123~~ CLEARED … — classifies eligible with NO staleBlockedBy noise', () => {
  const m = parsePlanMeta(
    '2142-DQ-thing.md',
    plan({
      extra:
        '**Blocked-by:** ~~2123~~ CLEARED (spec-sweep 2026-07-20) — 2123 LANDED and is archived. Executable now.',
    }),
    { archivedIds: new Set(['2123']) },
  );
  assert.equal(m.exclude, null);
  assert.equal(m.staleBlockedBy, null);
});

test('parsePlanMeta: a struck "plan NNNN" reference "(ii)" classifies eligible with no staleBlockedBy', () => {
  const m = parsePlanMeta(
    '2143-DQ-thing.md',
    plan({ extra: '**Blocked-by:** ~~plan 2123~~ CLEARED — superseded by the national refresh.' }),
    { archivedIds: new Set(['2123']) },
  );
  assert.equal(m.exclude, null);
  assert.equal(m.staleBlockedBy, null);
});

test('parsePlanMeta: an UN-struck reference alongside a struck one "(iii)" still blocks — stripping loosens nothing else', () => {
  const m = parsePlanMeta(
    '2144-DQ-thing.md',
    plan({ extra: '**Blocked-by:** ~~plan 2123~~ now blocked by plan 2200' }),
    { archivedIds: new Set(['2123']) }, // 2200 is not archived
  );
  assert.equal(m.exclude, 'blocked');
  assert.match(m.excludeReason, /2200/);
});

test('parsePlanMeta: a bare struck-only line with NO annotation ("~~2123~~") stays conservatively malformed, not silently eligible', () => {
  // own-diff regression re-check: guarding the classification block on the STRIPPED
  // value's truthiness (rather than the raw line's) would make this empty-after-strip
  // case skip classification entirely and leave exclude=null — the dangerous
  // direction. A bare strikethrough with no "CLEARED …" annotation carries no
  // evidence at all and must stay excluded, same as pre-plan-2174 behavior.
  const m = parsePlanMeta('2147-DQ-thing.md', plan({ extra: '**Blocked-by:** ~~2123~~' }));
  assert.equal(m.exclude, 'malformed');
});

test('parsePlanMeta: sonnet-review regression — a CLEARED first clause does NOT mask a still-open blocker named LATER in the same line', () => {
  // review-flagged failure: "~~2123~~ CLEARED (spec-sweep) — 2123 landed. Still
  // blocked by plan 2200." must still block on 2200 — the leading "cleared" word
  // must not short-circuit classification before extraction sees the rest.
  const m = parsePlanMeta(
    '2146-DQ-thing.md',
    plan({
      extra:
        '**Blocked-by:** ~~2123~~ CLEARED (spec-sweep) — 2123 landed. Still blocked by plan 2200.',
    }),
    { archivedIds: new Set(['2123']) }, // 2200 is NOT archived
  );
  assert.equal(m.exclude, 'blocked');
  assert.match(m.excludeReason, /2200/);
});

// --- multi-line Blocked-by read (plan 2180) -----------------------------------
//
// A body can carry TWO SEPARATE **Blocked-by:** lines (a spec-sweep/board-pass
// appends a new line rather than editing the old one in place). The prior
// non-global BLOCKED_BY_LINE_RX read only the FIRST such line, so a cleared first
// line masked a genuinely open second line — this was strictly more dangerous
// after plan 2174 added BLOCKED_CLEARED_RX (a cleared-looking first line now
// resolves the whole plan as eligible before the second line is ever read).

test('parsePlanMeta: a cleared FIRST Blocked-by line does not mask an open blocker named on a SEPARATE second line', () => {
  const m = parsePlanMeta(
    '2180-DQ-thing.md',
    plan({
      extra:
        '**Blocked-by:** ~~2123~~ CLEARED (spec-sweep) — 2123 landed. Executable now.\n' +
        '> **Blocked-by:** still blocked by plan 2200 pending the schema change.',
    }),
    { archivedIds: new Set(['2123']) }, // 2200 is NOT archived
  );
  assert.equal(m.exclude, 'blocked');
  assert.match(m.excludeReason, /2200/);
});

test('parsePlanMeta: two plain Blocked-by lines both naming open blockers still block on either', () => {
  const m = parsePlanMeta(
    '2181-DQ-thing.md',
    plan({
      extra:
        '**Blocked-by:** plan 1055 (SE national price re-extraction)\n' +
        '**Blocked-by:** plan 1541 (NO+DK national price re-extraction)',
    }),
  );
  assert.equal(m.exclude, 'blocked');
  assert.match(m.excludeReason, /1055/);
  assert.match(m.excludeReason, /1541/);
});

test('parsePlanMeta: own-diff sonnet-review CONFIRMED regression — an explicit "none" FIRST Blocked-by line must not mask an open blocker named on a SEPARATE second line', () => {
  // BLOCKED_NONE_RX is only start-anchored (`^(none|n\/?a)\b`), designed when only a
  // single Blocked-by line was ever read. Joining "none" + "plan 1055 (still pending)"
  // produces "none plan 1055 (still pending)", which still matches `^none\b` — testing
  // the WHOLE joined text against it (before id-extraction ever ran) would let this
  // read as an explicit no-blocker and skip extraction entirely, exactly the class of
  // bug this plan exists to fix. Id-extraction now runs first, so a real plan-id
  // reference anywhere in the joined text always wins over a leading "none".
  const m = parsePlanMeta(
    '2182-DQ-thing.md',
    plan({
      extra: '**Blocked-by:** none\n' + '**Blocked-by:** plan 1055 (still pending schema change)',
    }),
  );
  assert.equal(m.exclude, 'blocked');
  assert.match(m.excludeReason, /1055/);
});

test('parsePlanMeta: an explicit "none" Blocked-by line with no plan id anywhere in the joined text stays eligible (unchanged)', () => {
  const m = parsePlanMeta(
    '2183-DQ-thing.md',
    plan({
      extra: '**Blocked-by:** none (392 has landed; this is its open follow-up).',
    }),
  );
  assert.equal(m.exclude, null);
});

test('parsePlanMeta: a bare "cleared" token (no `~~`) is treated as an explicit none, like "none"/"n/a"', () => {
  const m = parsePlanMeta(
    '2145-DQ-thing.md',
    plan({ extra: '**Blocked-by:** cleared — 2096 landed 2026-07-20 (build log).' }),
  );
  assert.equal(m.exclude, null);
});

test('parsePlanMeta: operator Blocked-by excluded as operator', () => {
  const m = parsePlanMeta(
    '300-X-thing.md',
    plan({ extra: '**Blocked-by:** operator green-light on cost' }),
  );
  assert.equal(m.exclude, 'operator');
});

test('parsePlanMeta: "Blocked-by: none (…)" is eligible, not malformed (407 regression)', () => {
  const m = parsePlanMeta(
    '407-DQ-thing.md',
    plan({ extra: '**Blocked-by:** none (392 has landed; this is its open follow-up).' }),
  );
  assert.equal(m.exclude, null);
});

test('parsePlanMeta: n/a and bare-dash Blocked-by are eligible', () => {
  assert.equal(parsePlanMeta('a.md', plan({ extra: '**Blocked-by:** n/a' })).exclude, null);
  assert.equal(parsePlanMeta('b.md', plan({ extra: '**Blocked-by:** —' })).exclude, null);
  assert.equal(
    parsePlanMeta('c.md', plan({ extra: '**Blocked-by:** none — ready.' })).exclude,
    null,
  );
});

test('parsePlanMeta: malformed Blocked-by excluded conservatively', () => {
  const m = parsePlanMeta(
    '301-X-thing.md',
    plan({ extra: '**Blocked-by:** ¯\\_(ツ)_/¯ something unparseable' }),
  );
  assert.equal(m.exclude, 'malformed');
});

test('parsePlanMeta: 203-shape is eligible with $0 cost', () => {
  const m = parsePlanMeta(
    '203-UI-animalband.md',
    plan({ extra: '**Cost forecast:** ~30 min focused work + test. No LLM spend.' }),
  );
  assert.equal(m.exclude, null);
  assert.equal(m.cost.usd, 0);
});

// --- cost-banner anchoring (plan 2360) ----------------------------------------
// The whole-file loose match used to take the FIRST occurrence of the phrase
// "Cost forecast" anywhere in the file — including a YAML frontmatter `summary:`
// field — instead of the real `> 💰 **Cost forecast:**` banner lower in the
// body. Live case: plan 2320's summary contained "operator-approved cost
// forecast, lean field mask…", which parsed as unknown-cost and blocked its
// promotion to ready/ three times despite a perfectly parseable $0 banner.

test('parsePlanMeta: anchored banner wins over an earlier frontmatter prose mention (2320 regression)', () => {
  const content = [
    '---',
    "summary: 'operator-approved cost forecast, lean field mask, ship it'",
    'stage: specced',
    '---',
    '',
    plan({ extra: '> 💰 **Cost forecast:** $0 — console checks only; no LLM/API spend.' }),
  ].join('\n');
  const m = parsePlanMeta('2320-Infra-thing.md', content);
  assert.equal(m.cost.unknown, false);
  assert.equal(m.cost.usd, 0);
});

test('parsePlanMeta: anchored banner tolerates a bracketed qualifier and picks the real total, not the frontmatter prose', () => {
  const content = [
    '---',
    "summary: 'this plan needed a real cost forecast before shipping'",
    '---',
    '',
    plan({
      extra: '> 💰 **Cost forecast (FIRMED):** ~$8–12 total across two batches.',
    }),
  ].join('\n');
  const m = parsePlanMeta('2321-Infra-thing.md', content);
  assert.equal(m.cost.unknown, false);
  assert.equal(m.cost.usd, 12);
});

test('parsePlanMeta: legacy plan with no anchored banner line still parses via the loose fallback (unchanged)', () => {
  const m = parsePlanMeta(
    '900-Legacy-thing.md',
    plan({ extra: 'Cost forecast: ~$4, one small batch.' }),
  );
  assert.equal(m.cost.unknown, false);
  assert.equal(m.cost.usd, 4);
});

test('parsePlanMeta: no cost-forecast mention anywhere is unknown', () => {
  const m = parsePlanMeta('901-Legacy-thing.md', plan({ extra: 'Just a plain plan body.' }));
  assert.equal(m.cost.unknown, true);
});

// Real banner-shape diversity (plan 2360 review, sonnet-review high): the first
// cut anchored strictly on `> 💰 **Cost forecast:**` (blockquote, bold opens
// right after the emoji, figure outside the bold run) and mis-parsed or missed
// three OTHER shapes actually in use across the plan corpus — the anchor only
// needs 💰 and "Cost forecast" to share a line; everything after the label is
// peeled with the same `[:*\s]*` the pre-2360 loose match always used.

test('parsePlanMeta: dollar figure INSIDE the bold run still parses (1059 shape)', () => {
  const m = parsePlanMeta(
    '1059-Other-thing.md',
    plan({ extra: '> 💰 **Cost forecast: ~$0** for Phase 1 (pure code).' }),
  );
  assert.equal(m.cost.unknown, false);
  assert.equal(m.cost.usd, 0);
});

test('parsePlanMeta: no-blockquote banner still parses (1268 shape)', () => {
  const m = parsePlanMeta(
    '1268-Infra-thing.md',
    plan({ extra: '**💰 Cost forecast:** $0 — small change.' }),
  );
  assert.equal(m.cost.unknown, false);
  assert.equal(m.cost.usd, 0);
});

test('parsePlanMeta: emoji-inside-bold banner still parses (1065 shape)', () => {
  const m = parsePlanMeta(
    '1065-Other-thing.md',
    plan({ extra: '> **💰 Cost forecast:** $0 (pure code + tests + docs).' }),
  );
  assert.equal(m.cost.unknown, false);
  assert.equal(m.cost.usd, 0);
});

test('parsePlanMeta: a frontmatter summary that quotes a 💰 banner VERBATIM does not shadow the real body banner', () => {
  // Adversarial beyond the 2320 shape: the summary doesn't just mention the
  // phrase, it quotes a whole (bogus) banner, 💰 included — stripFrontmatter
  // keeps the scan out of the frontmatter entirely, so only the real body
  // banner is ever a candidate.
  const content = [
    '---',
    "summary: 'see > 💰 **Cost forecast:** $999 — bogus, quoted verbatim'",
    '---',
    '',
    plan({ extra: '> 💰 **Cost forecast:** $0 — the real one.' }),
  ].join('\n');
  const m = parsePlanMeta('2322-Infra-thing.md', content);
  assert.equal(m.cost.unknown, false);
  assert.equal(m.cost.usd, 0);
});

// Round-2 review finding: the loose FALLBACK still scanned raw (unstripped)
// content, so a legacy plan with no real banner but a frontmatter mention was
// still shadowed via that path. Fixed by body-scoping it too.
//
// Round-2 ALSO tightened the primary anchor to require a `**` bold-open
// alongside 💰 (reasoning: plain prose could combine "cost forecast" with an
// unrelated 💰 on one line). Round 3 found this broke every real non-bold
// banner (common in the corpus — see the ANCHORED_COST_BANNER_RX comment); a
// corpus-wide diff (all 2339 plan files) proved the bold requirement changed
// NO real file's outcome while the reverted-to loose anchor's own failure
// mode requires a coincidence (💰 + literal "cost forecast" in ordinary
// prose) nothing in the corpus does today. The bold requirement was reverted;
// the test below documents the accepted trade-off explicitly rather than
// asserting behavior the corpus evidence doesn't support.

test('parsePlanMeta: KNOWN TRADE-OFF — contrived prose combining 💰 and "cost forecast" can still shadow a real banner below it (accepted: no real plan does this; see the corpus-diff comment on ANCHORED_COST_BANNER_RX)', () => {
  const content = plan({
    extra:
      'we debated whether to add a 💰 Cost forecast section up front, decided to add one below.\n\n' +
      '> 💰 **Cost forecast:** $50 — actual estimate.',
  });
  const m = parsePlanMeta('2323-Infra-thing.md', content);
  assert.equal(m.cost.unknown, true);
});

test('parsePlanMeta: a real non-bold banner shape (common in the corpus) still parses correctly', () => {
  const m = parsePlanMeta(
    '2311-DQ-thing.md',
    plan({ extra: '💰 Cost forecast: ~1 short session. No LLM/pipeline spend.' }),
  );
  assert.equal(m.cost.unknown, false);
  assert.equal(m.cost.usd, 0);
});

test('parsePlanMeta: the loose FALLBACK is body-scoped too — a legacy plan with no real banner is not shadowed by a frontmatter mention', () => {
  const content = [
    '---',
    "summary: 'legacy plan, real Cost forecast: $999 mentioned only here'",
    '---',
    '',
    plan({ extra: 'Some legacy plan with no banner at all.' }),
  ].join('\n');
  const m = parsePlanMeta('2324-Infra-thing.md', content);
  assert.equal(m.cost.unknown, true);
});

test('OPERATOR_GATE_RX matches account-gated but not benign operator mentions', () => {
  assert.ok(OPERATOR_GATE_RX.test('data is account-gated'));
  assert.ok(!OPERATOR_GATE_RX.test('the operator chose the calmer default'));
});

// --- operator-interactive exclusion (plan 443) -------------------------------

test('parsePlanMeta: claude-in-chrome body excluded operator-interactive (438 shape)', () => {
  // Marker isolated so the reason names it deterministically; the realistic 438
  // body also carries "operator's logged-in Chrome" (any one marker is enough).
  const m = parsePlanMeta(
    '438-DQ-social-media-liveness-monitor.md',
    plan({ extra: 'reads run via claude-in-chrome (no Graph API / no paid scrape).' }),
  );
  assert.equal(m.exclude, 'operator');
  assert.match(m.excludeReason, /operator-interactive/);
  assert.match(m.excludeReason, /claude-in-chrome/);
});

test('parsePlanMeta: Google Flow body excluded operator-interactive (437 shape)', () => {
  const m = parsePlanMeta(
    '437-UI-icon-system-unification.md',
    plan({
      extra:
        'image generation uses Google Flow (Nano Banana 2) on the operator’s Google AI Pro sub.',
    }),
  );
  assert.equal(m.exclude, 'operator');
  assert.match(m.excludeReason, /google flow/i);
});

test('parsePlanMeta: "operator approval checkpoint" body excluded operator-interactive', () => {
  const m = parsePlanMeta(
    '999-X-thing.md',
    plan({ extra: 'a mandatory chip-preview operator-approval checkpoint before wiring.' }),
  );
  assert.equal(m.exclude, 'operator');
  assert.match(m.excludeReason, /operator-interactive/);
});

test('parsePlanMeta: clean all-code body stays eligible (no false positive — 435 shape)', () => {
  const m = parsePlanMeta(
    '435-DQ-seed-price-row-orphan-dedupe.md',
    plan({ extra: '$0 — deterministic edits over seed; no LLM/API/scraping spend.' }),
  );
  assert.equal(m.exclude, null);
  assert.equal(m.excludeReason, null);
});

// --- operator-gate SCOPING (plan 2368) ---------------------------------------
//
// Same frontmatter-shadow class plan 2360 closed for the banners: both operator
// regexes used to scan raw whole-file `content`. Three scopes now apply — no
// frontmatter, no close-out tails, and a declared-intent `operatorGated:` stamp
// that beats the text heuristic entirely.

test('parsePlanMeta: a frontmatter summary combining operator+suppl does not gate a body that needs no operator (plan 2368)', () => {
  // OPERATOR_GATE_RX's `[\s\S]{0,40}` window crosses newlines, so this could match
  // frontmatter→body as well as within the summary itself.
  const content = [
    '---',
    "summary: 'the operator must supply nothing here — describes the gate only'",
    '---',
    '',
    plan({ extra: 'Deterministic regex hardening + unit tests. No operator input at all.' }),
  ].join('\n');
  const m = parsePlanMeta('2368-Coord-thing.md', content);
  assert.equal(m.exclude, null);
  assert.equal(m.excludeReason, null);
});

test('parsePlanMeta: BOTH directions — a body that only QUOTES the gate phrases is not gated, one that states a real dependency still is (plan 2368)', () => {
  // The false-NEGATIVE direction is the dangerous one: a fix that silences
  // self-documentation by also silencing real operator dependencies would let an
  // operator-dependent plan into an unattended drain. Pin both.
  const quoting = parsePlanMeta(
    '2368-Coord-thing.md',
    plan({
      extra:
        'Background: a plan whose summary happens to combine "operator" and a "suppl*" word\n' +
        "inside the regex's 40-char window is silently dropped from both drain lanes.",
    }),
  );
  assert.equal(quoting.exclude, 'operator'); // unstamped prose still gates — see the stamp test below

  const real = parsePlanMeta(
    '221-SEO-recon.md',
    plan({ extra: 'Operator supplies the volume export (not agent-accessible).' }),
  );
  assert.equal(real.exclude, 'operator');
  assert.match(real.excludeReason, /operator-gated/);
});

test('parsePlanMeta: operatorGated: false beats the text heuristic; operatorGated: true forces the gate (plan 2368)', () => {
  // The declared-intent stamp is the only mechanism that separates "needs an
  // operator" from "talks about operator-gating" — this plan's own Background
  // sentence is the live case: writing down what the bug is trips the bug.
  const body = plan({
    extra:
      'Background: a summary combining "operator" and a "suppl*" word trips the gate, and a\n' +
      "tail describing the operator's logged-in browser trips the interactive gate.",
  });
  const gatedByProse = parsePlanMeta('2368-Coord-thing.md', body);
  assert.equal(gatedByProse.exclude, 'operator');

  const stampedFalse = parsePlanMeta(
    '2368-Coord-thing.md',
    ['---', 'operatorGated: false', '---', '', body].join('\n'),
  );
  assert.equal(stampedFalse.exclude, null);
  assert.equal(stampedFalse.excludeReason, null);

  // And the forcing direction: a plan with no gate LANGUAGE at all can still declare
  // that it needs the operator.
  const stampedTrue = parsePlanMeta(
    '999-X-thing.md',
    ['---', 'operatorGated: true', '---', '', plan({ extra: 'Deterministic code edits.' })].join(
      '\n',
    ),
  );
  assert.equal(stampedTrue.exclude, 'operator');
  assert.match(stampedTrue.excludeReason, /operator-gated/);
});

test("parsePlanMeta: a close-out tail describing the operator's session does not gate the drainable body (2403's real shape, plan 2368)", () => {
  // 2403 was structured per the repo's own split-don't-sink convention — the
  // operator-needing work carved into a named tail so the body CAN drain — and
  // OPERATOR_INTERACTIVE_RX excluded it anyway. Fixture mirrors 2403's real
  // section shape (heading text and the sentence that follows it).
  const content = plan({
    extra: [
      '## Scope',
      '',
      'Hoist the shared read into one primitive; unit tests only.',
      '',
      "## Close-out follow-up (operator-local tail — split-don't-sink)",
      '',
      "The sweep reads the operator's logged-in CDP Chrome tabs (`accountTabs`) — run it locally",
      'after the land. The unit-test acceptance below is the cloud-drainable body.',
      '',
      '## Verification',
      '',
      'node --test scripts/…',
    ].join('\n'),
  });
  const m = parsePlanMeta('2403-Infra-thing.md', content);
  assert.equal(m.exclude, null);
  assert.equal(m.excludeReason, null);

  // Control: the SAME marker in the drainable body (not in a tail) still gates.
  const inBody = parsePlanMeta(
    '2403-Infra-thing.md',
    plan({ extra: "## Scope\n\nThe sweep reads the operator's logged-in CDP Chrome tabs." }),
  );
  assert.equal(inBody.exclude, 'operator');
  assert.match(inBody.excludeReason, /operator-interactive/);
});

test('closeoutTailSpans: drops only the tail, ends at the next same-or-shallower heading (plan 2368)', () => {
  const body = [
    '## Scope',
    'keep me',
    '## Close-out follow-up (machine-local tail — split-don’t-sink)',
    'drop me',
    '### nested under the tail',
    'drop me too',
    '## Non-goals',
    'keep me as well',
  ].join('\n');
  const joined = closeoutTailSpans(body).join('\n');
  assert.match(joined, /keep me/);
  assert.match(joined, /keep me as well/);
  assert.match(joined, /## Non-goals/);
  assert.doesNotMatch(joined, /drop me/);
});

test('closeoutTailSpans: an H1 tail heading is a tail too — nothing enforces H2 (plan 2368 review finding)', () => {
  const body = [
    '# Close-out follow-up (operator-local tail — split-don’t-sink)',
    "run the sweep on the operator's logged-in Chrome after the land",
  ].join('\n');
  assert.deepEqual(closeoutTailSpans(body), []);
  assert.equal(operatorInteractiveReasonInBody(body), null);
});

test('closeoutTailSpans: only a heading that OPENS with the tail phrase is a tail (plan 2368 review finding)', () => {
  // Two ways an unanchored phrase-match over-reached: a heading DISCUSSING the
  // convention (plan 2368's own, which swallowed the rest of the plan), and an
  // unrelated heading that merely contains "<x>-local tail".
  for (const heading of [
    "### Second live instance: the heuristic defeats the split-don't-sink convention",
    '## Fixing the per-client-local tail latency bug',
  ]) {
    const body = [heading, "the operator's logged-in browser is genuinely needed here"].join('\n');
    assert.deepEqual(closeoutTailSpans(body), [body], heading);
    assert.ok(operatorInteractiveReasonInBody(body), heading);
  }
});

test('closeoutTailSpans: a tail heading QUOTED inside a fenced block is not a boundary (plan 2368 review finding)', () => {
  // The shared fence-aware literals (build-index-lib, plan 2052/2083) — a plan
  // documenting the convention by example must not lose its real body from the scan.
  const body = [
    '## Scope',
    '```markdown',
    '## Close-out follow-up (operator-local tail — split-don’t-sink)',
    '```',
    "the drainable body genuinely needs the operator's logged-in Chrome",
  ].join('\n');
  assert.deepEqual(closeoutTailSpans(body), [body]);
  assert.ok(operatorInteractiveReasonInBody(body));
});

test('closeoutTailSpans: SPANS, so dropping a section cannot fabricate adjacency across the seam (plan 2368 review finding)', () => {
  // Both gate regexes have a bounded cross-newline window, so a spliced-and-rejoined
  // body could match "operator" ↔ "approval checkpoint" text that was never adjacent.
  const body = [
    '## Scope',
    'the last sentence mentions the operator',
    '## Close-out follow-up (operator-local tail — split-don’t-sink)',
    'tail work, dropped',
    '## Verification',
    'approval checkpoint asserted by the suite',
  ].join('\n');
  // Two spans (before / after the tail), so neither regex sees them as one run.
  assert.equal(closeoutTailSpans(body).length, 2);
  assert.equal(operatorInteractiveReasonInBody(body), null);
  assert.equal(operatorGatedByText(body), false);
  // Control: spliced into ONE string, the fabricated adjacency DOES match — this is
  // what the span model prevents.
  assert.ok(operatorInteractiveReason(closeoutTailSpans(body).join('\n')));
});

test('parsePlanMeta: a Blocked-by line inside a frontmatter block scalar is not the plan’s own blocker (plan 2368)', () => {
  const content = [
    '---',
    'summary: |',
    '  quoting an earlier draft that said:',
    '  Blocked-by: plan 999 landing',
    '  …which is no longer true.',
    '---',
    '',
    plan({ extra: 'No blockers.' }),
  ].join('\n');
  const m = parsePlanMeta('2368-Coord-thing.md', content);
  assert.equal(m.blockedBy, null);
  assert.equal(m.exclude, null);
});

test('parsePlanMeta: a frontmatter block scalar containing a bare --- no longer truncates the strip (plan 2368)', () => {
  // stripFrontmatter used to terminate on the first line that TRIMMED to `---`, so
  // the embedded fence below ended the frontmatter early and the bogus banner quoted
  // after it parsed as the real one. The closing fence is now column-0 only.
  const content = [
    '---',
    'summary: |',
    '  quoting an old draft:',
    '  ---',
    '  > 💰 **Cost forecast:** $999 — bogus, still inside the frontmatter',
    '  more notes.',
    '---',
    '',
    plan({ extra: '> 💰 **Cost forecast:** $0 — the real one.' }),
  ].join('\n');
  const m = parsePlanMeta('2368-Coord-thing.md', content);
  assert.equal(m.cost.unknown, false);
  assert.equal(m.cost.usd, 0);
});

// ── plan 2446: the tail axis. A `**Blocked-by:**` line inside a `closeoutTailSpans`
// close-out tail declares a dependency of the deferred operator-local follow-up, not
// of the drainable body (same split-don't-sink reading plan 2368 already applies to
// the operator gates) — so it must not gate. The unsafe direction is answered with a
// loud `tailBlockedBySkipped` note, never silence. Fixture mirrors 2403's real
// close-out-tail section shape (archived plan 2403), same as the operator-gate test
// above.

// Shared close-out-tail fixture bodies (plan 2543 review fix: extracted so the
// parsePlanMeta tests below and the tailOnlyBlockedByLines threading test further
// down exercise the SAME literals instead of each re-typing near-identical copies —
// a future change to the close-out-tail heading shape now needs one edit, not four).
const TAIL_ONLY_BLOCKER_EXTRA = [
  '## Scope',
  '',
  'No real blockers in the body.',
  '',
  "## Close-out follow-up (operator-local tail — split-don't-sink)",
  '',
  '**Blocked-by:** plan 3000 (operator-local follow-up dependency only)',
  '',
  '## Verification',
  '',
  'node --test scripts/…',
].join('\n');
const TAIL_AND_BODY_BLOCKER_EXTRA = [
  '## Scope',
  '',
  '**Blocked-by:** plan 2199 must land first',
  '',
  "## Close-out follow-up (operator-local tail — split-don't-sink)",
  '',
  '**Blocked-by:** plan 3000 (tail-only, must not count)',
  '',
  '## Verification',
  '',
  'node --test scripts/…',
].join('\n');
const TAIL_NO_BLOCKER_EXTRA = [
  "## Close-out follow-up (operator-local tail — split-don't-sink)",
  '',
  'purely descriptive prose, no blocker.',
].join('\n');

test('parsePlanMeta: a Blocked-by line INSIDE a close-out tail does not gate the drainable body (plan 2446)', () => {
  const content = plan({ extra: TAIL_ONLY_BLOCKER_EXTRA });
  const m = parsePlanMeta('2446-Coord-thing.md', content, { archivedIds: new Set() });
  assert.equal(m.blockedBy, null, 'the tail-only line must not surface as the plan’s Blocked-by');
  assert.equal(m.exclude, null, 'must not gate the drainable body');
  assert.match(m.tailBlockedBySkipped, /3000/, 'but a loud note names what was skipped');
});

test('parsePlanMeta: a REAL body Blocked-by still gates even when the tail carries its OWN (unrelated) Blocked-by (plan 2446)', () => {
  const content = plan({ extra: TAIL_AND_BODY_BLOCKER_EXTRA });
  const m = parsePlanMeta('2446-Coord-thing.md', content, { archivedIds: new Set() });
  assert.equal(m.blockedBy, 'plan 2199 must land first');
  assert.equal(m.exclude, 'blocked');
  assert.match(m.excludeReason, /2199/);
  assert.match(m.tailBlockedBySkipped, /3000/);
});

test('parsePlanMeta: no tailBlockedBySkipped field at all when there is no close-out tail Blocked-by (plan 2446)', () => {
  const plain = parsePlanMeta('2446-Coord-thing.md', plan({ extra: 'No blockers.' }));
  assert.equal(plain.tailBlockedBySkipped, null);
  const withTailButNoBlocker = parsePlanMeta(
    '2446-Coord-thing.md',
    plan({ extra: TAIL_NO_BLOCKER_EXTRA }),
  );
  assert.equal(withTailButNoBlocker.tailBlockedBySkipped, null);
});

// ── plan 2543: tailScopedBody/tailOnlyBlockedByLines are now EXPORTED so
// blocked-by-lib.mjs imports them directly instead of keeping an independent copy
// of the tail-scoping wrapper + multiset-diff algorithm, and parsePlanMeta computes
// tailScopedBody ONCE per plan and threads it into both extractBlockedByLine and
// tailOnlyBlockedByLines instead of each re-deriving it. These tests pin that
// threading a precomputed scopedBody through tailOnlyBlockedByLines gives the exact
// same result as letting it compute one internally (the correctness property any
// caching/threading refactor must preserve) — reusing the SAME fixtures already
// exercised above (review fix: no re-typed copies) plus two bodies with no tail at
// all, the shape those fixtures don't cover.
test('2543: tailOnlyBlockedByLines(body, tailScopedBody(body)) matches tailOnlyBlockedByLines(body) with no second argument', () => {
  const bodies = [
    TAIL_ONLY_BLOCKER_EXTRA,
    TAIL_AND_BODY_BLOCKER_EXTRA,
    TAIL_NO_BLOCKER_EXTRA,
    'No close-out tail at all.\n\n**Blocked-by:** plan 477',
  ];
  for (const body of bodies) {
    assert.deepEqual(
      tailOnlyBlockedByLines(body, tailScopedBody(body)),
      tailOnlyBlockedByLines(body),
      `mismatch for body: ${JSON.stringify(body.slice(0, 40))}`,
    );
  }
});

test('OPERATOR_INTERACTIVE_RX matches live-session markers, not benign mentions', () => {
  assert.ok(OPERATOR_INTERACTIVE_RX.test('drive it via claude-in-chrome'));
  assert.ok(OPERATOR_INTERACTIVE_RX.test('generate via Google Flow'));
  assert.ok(OPERATOR_INTERACTIVE_RX.test("on the operator's logged-in session"));
  assert.ok(!OPERATOR_INTERACTIVE_RX.test('a deterministic HTML scrape, no browser'));
  assert.equal(operatorInteractiveReason('a deterministic HTML scrape'), null);
});

// --- selectEligible: reasons -------------------------------------------------

test('selectEligible: empty queue → reason empty', () => {
  const r = selectEligible([], { landingHeld: false });
  assert.equal(r.reason, 'empty');
});

test('selectEligible: all cross-plan-blocked → all_blocked', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'blocked' }), meta({ id: 11, exclude: 'blocked' })],
    {
      landingHeld: false,
    },
  );
  assert.equal(r.reason, 'all_blocked');
});

test('selectEligible: all operator-gated → all_need_operator', () => {
  const r = selectEligible([meta({ id: 10, exclude: 'operator' })], { landingHeld: false });
  assert.equal(r.reason, 'all_need_operator');
});

test('selectEligible: landing mutex drops 🟥, leaves nothing → landing_mutex_active', () => {
  const r = selectEligible([meta({ id: 10, seedWrite: 'yes' })], { landingHeld: true });
  assert.equal(r.reason, 'landing_mutex_active');
  assert.deepEqual(r.mutexDropped, ['10-X-test']);
});

test('selectEligible: nothing-runnable branch also carries mutexDroppedMeta, {slug, cost} parallel to mutexDropped (plan 3955)', () => {
  const r = selectEligible([meta({ id: 10, seedWrite: 'yes', cost: '$5' })], {
    landingHeld: true,
  });
  assert.equal(r.reason, 'landing_mutex_active');
  assert.deepEqual(r.mutexDropped, ['10-X-test'], 'mutexDropped itself is untouched — bare slugs');
  assert.equal(r.mutexDroppedMeta.length, 1);
  assert.equal(r.mutexDroppedMeta[0].slug, '10-X-test');
  assert.equal(r.mutexDroppedMeta[0].cost.usd, 5);
});

test('selectEligible: landing mutex keeps 🟩, drops 🟥', () => {
  const r = selectEligible(
    [meta({ id: 10, seedWrite: 'yes' }), meta({ id: 11, seedWrite: 'no' })],
    { landingHeld: true },
  );
  assert.equal(r.next.slug, '11-X-test');
  assert.equal(r.eligible.length, 1);
});

test('selectEligible: success path reports mutexDropped 🟥 slugs (plan 948)', () => {
  // ≥1 🟩 eligible → success path. The 🟥 plans withheld by the LANDING mutex
  // must still be surfaced (was silently omitted, leaving queue state opaque).
  const r = selectEligible(
    [
      meta({ id: 10, seedWrite: 'yes' }),
      meta({ id: 11, seedWrite: 'no' }),
      meta({ id: 12, seedWrite: 'yes' }),
    ],
    { landingHeld: true },
  );
  assert.equal(r.next.slug, '11-X-test'); // the 🟩 runs
  assert.deepEqual(r.mutexDropped, ['10-X-test', '12-X-test']); // both 🟥 reported
});

test('selectEligible: success path mutexDropped is empty when no LANDING held', () => {
  const r = selectEligible(
    [meta({ id: 10, seedWrite: 'yes' }), meta({ id: 11, seedWrite: 'no' })],
    { landingHeld: false },
  );
  assert.deepEqual(r.mutexDropped, []); // present, empty — both plans eligible
  assert.equal(r.eligible.length, 2);
});

test('selectEligible: success path also carries mutexDroppedMeta, {slug, cost} parallel to mutexDropped (plan 3955)', () => {
  const r = selectEligible(
    [
      meta({ id: 10, seedWrite: 'yes', cost: '$5' }),
      meta({ id: 11, seedWrite: 'no' }),
      meta({ id: 12, seedWrite: 'yes', cost: '>$2' }),
    ],
    { landingHeld: true },
  );
  assert.equal(r.next.slug, '11-X-test'); // the 🟩 runs
  assert.deepEqual(
    r.mutexDropped,
    ['10-X-test', '12-X-test'],
    'mutexDropped itself is untouched — bare slugs',
  );
  assert.deepEqual(
    r.mutexDroppedMeta.map((m) => m.slug),
    ['10-X-test', '12-X-test'],
  );
  assert.equal(r.mutexDroppedMeta[0].cost.usd, 5);
  assert.equal(r.mutexDroppedMeta[1].cost.over, true);
});

test('selectEligible: malformed-only → all_blocked', () => {
  const r = selectEligible([meta({ id: 12, exclude: 'malformed' })], { landingHeld: false });
  assert.equal(r.reason, 'all_blocked');
});

// --- plan 3443: seedLaneHeldFromRows — the lane-aware landing-held resolution -----------
//
// The consult site (main()) no longer asks "is ANY 🟢 LANDING row held" — it asks "is a 🟢
// LANDING row held whose OWN plan is itself 🟥 SEED-WRITE". These tests drive that pure
// resolution directly, injecting `readPlanContent` (never real git/board) exactly as
// selectEligible already takes its inputs.

// A board.mjs `landing-held` stdout line: `| slug | tip | 🟢 LANDING | \`ref\` · … | touched | resume |`.
function heldRow(slug, ref) {
  return `| ${slug} | \`abc1234\` | 🟢 LANDING | \`${ref}\` · session 1 · host=\`H\` | 2026-08-25T08:20:00.000Z · landing@2026-08-25T08:20:00.000Z | — |`;
}

test('seedLaneHeldFromRows: the only held row is a 🟩 plan → landingHeld is false', () => {
  const rows = [heldRow('3439-Infra-x', 'in-progress/3439-Infra-x.md')];
  assert.equal(
    seedLaneHeldFromRows(rows, () => plan({ seed: 'NO' })),
    false,
  );
});

test('seedLaneHeldFromRows: the only held row is a 🟥 plan → landingHeld is true', () => {
  const rows = [heldRow('3309-FABLE-x', 'in-progress/3309-FABLE-x.md')];
  assert.equal(
    seedLaneHeldFromRows(rows, () => plan({ seed: 'YES' })),
    true,
  );
});

test('seedLaneHeldFromRows: a missing SEED-WRITE banner fails toward HELD (conservative, mirrors isSeedWrite)', () => {
  const rows = [heldRow('3309-FABLE-x', 'in-progress/3309-FABLE-x.md')];
  assert.equal(
    seedLaneHeldFromRows(rows, () => '# a plan body with no SEED-WRITE banner at all\n', {
      log: () => {},
    }),
    true,
  );
});

test('seedLaneHeldFromRows: readPlanContent throwing (unreadable plan) fails toward HELD', () => {
  const rows = [heldRow('3309-FABLE-x', 'in-progress/3309-FABLE-x.md')];
  const held = seedLaneHeldFromRows(
    rows,
    () => {
      throw new Error('git show failed: not found');
    },
    { log: () => {} },
  );
  assert.equal(held, true);
});

test('seedLaneHeldFromRows: mixed 🟩+🟥 held rows → held (the 🟥 row dominates)', () => {
  const rows = [
    heldRow('3439-Infra-x', 'in-progress/3439-Infra-x.md'),
    heldRow('3309-FABLE-y', 'in-progress/3309-FABLE-y.md'),
  ];
  const held = seedLaneHeldFromRows(rows, (ref) =>
    ref.includes('3309') ? plan({ seed: 'YES' }) : plan({ seed: 'NO' }),
  );
  assert.equal(held, true);
});

test('seedLaneHeldFromRows: mixed 🟩+🟩 held rows → not held', () => {
  const rows = [
    heldRow('3439-Infra-x', 'in-progress/3439-Infra-x.md'),
    heldRow('3424-Infra-y', 'in-progress/3424-Infra-y.md'),
  ];
  assert.equal(
    seedLaneHeldFromRows(rows, () => plan({ seed: 'NO' })),
    false,
  );
});

test('seedLaneHeldFromRows: no held rows at all → not held', () => {
  assert.equal(
    seedLaneHeldFromRows([], () => plan({ seed: 'YES' })),
    false,
  );
});

test('seedLaneHeldFromRows: an unparseable row line fails toward HELD', () => {
  assert.equal(
    seedLaneHeldFromRows(['not a table row at all'], () => plan({ seed: 'NO' }), {
      log: () => {},
    }),
    true,
  );
});

test('seedLaneHeldFromRows: a row whose claim cell carries no backticked plan ref fails toward HELD', () => {
  const rows = ['| 3309-FABLE-x | `abc` | 🟢 LANDING | no ref in this cell | 2026-08-25 | — |'];
  assert.equal(
    seedLaneHeldFromRows(rows, () => plan({ seed: 'NO' }), { log: () => {} }),
    true,
  );
});

// --- plan 3443 gpt-review round: Fixes 1-7 ---------------------------------------------
//
// A held-row builder more flexible than `heldRow` above — lets a test control the touched
// cell (the stamp) and the resume cell independently, and optionally stamp a `batch=` marker
// into the claim cell (Fix 3).
function landingRow({
  slug,
  ref = `in-progress/${slug}.md`,
  touched = '2026-08-25T06:00:00.000Z',
  resume = '—',
  batch = null,
}) {
  const claim = batch ? `\`${ref}\` · session 1 · batch=\`${batch}\`` : `\`${ref}\` · session 1`;
  return `| ${slug} | \`abc1234\` | 🟢 LANDING | ${claim} | ${touched} | ${resume} |`;
}

// A rev-parse stub that always reports "ref does not resolve" (git exit 1) — the
// no-branch-progress case every Fix 3/4/5 test below wants as an inert default.
function noBranchProgress(cmd, args) {
  if (cmd === 'git' && args.includes('rev-parse')) {
    const e = new Error('not found');
    e.status = 1;
    throw e;
  }
  return undefined; // not handled — caller's dispatcher falls through
}

// --- Fix 1: queueStateFor must not turn an unreadable heartbeat into "stale" -----------

test('queueStateFor (Fix 1): a present queue entry with an ABSENT heartbeat -> queueHeartbeatFresh is null (unknown), never false', () => {
  const result = queueStateFor('/scripts', '3439-Infra-x', Date.now(), {
    _exec: () => JSON.stringify({ position: 1 }), // no heartbeatIso field at all
  });
  assert.equal(result.queueEntryPresent, true);
  assert.equal(
    result.queueHeartbeatFresh,
    null,
    'an absent heartbeat is UNKNOWN, not proof of staleness',
  );
});

test('queueStateFor (Fix 1): a present queue entry with an UNPARSEABLE heartbeat -> queueHeartbeatFresh is null, never false', () => {
  const result = queueStateFor('/scripts', '3439-Infra-x', Date.now(), {
    _exec: () => JSON.stringify({ position: 1, heartbeatIso: 'not-a-real-timestamp' }),
  });
  assert.equal(result.queueEntryPresent, true);
  assert.equal(result.queueHeartbeatFresh, null);
});

test('reapRowIfStale (Fix 1): a present queue entry with an absent heartbeat is NEVER reaped, even with a very old stamp and no branch progress', () => {
  const rowLine = landingRow({
    slug: '3439-Infra-x',
    touched: 'x · landing@2026-08-25T00:00:00.000Z',
  });
  const nowMs = Date.parse('2026-08-25T08:00:00.000Z'); // 8h old — way past the 45m threshold
  let boardUpdateCalled = false;
  const reaped = reapRowIfStale('/scripts', '/repo', '3439-Infra-x', rowLine, nowMs, {
    _exec: (cmd, args) => {
      if (cmd === 'node' && args[1] === 'status') return JSON.stringify({ position: 1 }); // present, no heartbeatIso
      if (cmd === 'node' && args[1] === 'update') {
        boardUpdateCalled = true;
        return '';
      }
      const r = noBranchProgress(cmd, args);
      if (r !== undefined) return r;
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    },
    log: () => {},
  });
  assert.equal(
    boardUpdateCalled,
    false,
    'an unreadable heartbeat must fail toward "leave it held", not toward reaping',
  );
  assert.equal(reaped, false);
});

test('reapRowIfStale (Fix 1): a present queue entry with an unparseable heartbeat is NEVER reaped', () => {
  const rowLine = landingRow({
    slug: '3439-Infra-x',
    touched: 'x · landing@2026-08-25T00:00:00.000Z',
  });
  const nowMs = Date.parse('2026-08-25T08:00:00.000Z');
  let boardUpdateCalled = false;
  const reaped = reapRowIfStale('/scripts', '/repo', '3439-Infra-x', rowLine, nowMs, {
    _exec: (cmd, args) => {
      if (cmd === 'node' && args[1] === 'status') {
        return JSON.stringify({ position: 1, heartbeatIso: 'garbage' });
      }
      if (cmd === 'node' && args[1] === 'update') {
        boardUpdateCalled = true;
        return '';
      }
      const r = noBranchProgress(cmd, args);
      if (r !== undefined) return r;
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    },
    log: () => {},
  });
  assert.equal(boardUpdateCalled, false);
  assert.equal(reaped, false);
});

// --- Fix 2: fetch origin ONCE before any staleness/plan read --------------------------

test('resolveLandingHeldForSeedLane (Fix 2): runs ONE `git fetch origin` before any staleness or plan read, whenever a row is held and repoRoot is set', () => {
  const rows = [landingRow({ slug: '3439-Infra-x' })];
  const calls = [];
  resolveLandingHeldForSeedLane({
    scriptsDir: '/scripts',
    repoRoot: '/repo',
    heal: false, // the fetch must still run — the plan read below needs it current too
    _exec: (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'node' && args[1] === 'landing-held') return rows.join('\n') + '\n';
      if (cmd === 'git' && args.includes('fetch')) return '';
      if (cmd === 'git' && args.includes('show')) return plan({ seed: 'NO' });
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    },
    log: () => {},
  });
  const fetchCalls = calls.filter((c) => c[0] === 'git' && c[1].includes('fetch'));
  assert.equal(fetchCalls.length, 1, 'exactly one fetch for the whole call, never per-row');
  // `--prune` (re-review round 2): a deleted execution branch must not leave a remote-tracking
  // ref behind for the branch probe to answer from.
  assert.deepEqual(fetchCalls[0][1], ['-C', '/repo', 'fetch', '--prune', 'origin']);
  const fetchIdx = calls.indexOf(fetchCalls[0]);
  const showIdx = calls.findIndex((c) => c[0] === 'git' && c[1].includes('show'));
  assert.ok(showIdx !== -1, 'the plan read did happen');
  assert.ok(fetchIdx < showIdx, 'the fetch must run BEFORE the authoritative plan read');
});

// plan 3443 re-review: a failed fetch FAILS CLOSED — held, no reaping AND no lane-narrowing.
// The first cut of Fix 2 skipped only the healing and still narrowed the lane from the local
// refs, which re-opened the very hole review Fix 7 closed one seam over: the "authoritative"
// plan read resolves `origin/master` from a LOCAL ref, so an unrefreshed ref can serve a stale
// SEED-WRITE banner, and a 🟩-reading stale banner wrongly FREES the seed lane. This test
// therefore pins `held === true` even though the (stale) banner the stub would serve says 🟩 —
// the whole point is that the banner must not be consulted at all.
test('resolveLandingHeldForSeedLane (Fix 2): a fetch failure fails CLOSED — held, with no reap machinery and no plan read', () => {
  const rows = [landingRow({ slug: '3439-Infra-x' })];
  const logs = [];
  const calls = [];
  const held = resolveLandingHeldForSeedLane({
    scriptsDir: '/scripts',
    repoRoot: '/repo',
    heal: true,
    _exec: (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'node' && args[1] === 'landing-held') return rows.join('\n') + '\n';
      if (cmd === 'git' && args.includes('fetch')) throw new Error('could not resolve host');
      if (cmd === 'git' && args.includes('show')) return plan({ seed: 'NO' }); // 🟩, must be ignored
      throw new Error(`unexpected call reached healing machinery: ${cmd} ${JSON.stringify(args)}`);
    },
    log: (m) => logs.push(m),
  });
  assert.equal(held, true, 'unverifiable refs must never FREE the seed lane');
  assert.ok(
    calls.some((c) => c[0] === 'git' && c[1].includes('fetch')),
    'a fetch WAS attempted',
  );
  assert.ok(
    !calls.some((c) => c[0] === 'git' && c[1].includes('show')),
    'the seed banner is never read off refs the fetch could not refresh',
  );
  assert.ok(
    !calls.some((c) => c[0] === 'node' && (c[1][1] === 'status' || c[1][1] === 'update')),
    'no reap machinery (queue status / board update) ran once the fetch failed',
  );
  assert.ok(
    logs.some((m) => /fetch/i.test(m)),
    'logs a one-line notice about the failed fetch',
  );
});

// plan 3443 re-review round 2: a genuinely DEAD batch-member row must still be reapable.
//
// An earlier pass forced every batch-member row with no queue entry to "unknown" so a
// mis-resolved batch slug could never trigger a reap. That was wrong twice over: a LIVE batch is
// already protected by the branch probe (the test below pins that), and a dead batch's queue
// entry is gone permanently — so "unknown" never resolves and the row becomes unreapable
// forever, re-creating the indefinite seed-lane wedge this plan exists to end, for batch rows.
test('reapRowIfStale (re-review): a genuinely dead batch-member row IS reaped — "unknown" must not be permanent', () => {
  const rowLine = landingRow({
    slug: '3439-Infra-x',
    batch: 'batch-2026-08-25-smalls',
    touched: 'x · landing@2026-08-25T00:00:00.000Z',
  });
  const nowMs = Date.parse('2026-08-25T08:00:00.000Z'); // 8h old, no queue entry, no branch
  let boardUpdateCalled = false;
  const reaped = reapRowIfStale('/scripts', '/repo', '3439-Infra-x', rowLine, nowMs, {
    _exec: (cmd, args) => {
      if (cmd === 'node' && args[1] === 'status') return JSON.stringify({ position: 0 }); // absent
      if (cmd === 'node' && args[1] === 'landing-held') return rowLine + '\n'; // TOCTOU re-check
      if (cmd === 'node' && args[1] === 'update') {
        boardUpdateCalled = true;
        return '';
      }
      const r = noBranchProgress(cmd, args);
      if (r !== undefined) return r;
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    },
    log: () => {},
  });
  assert.equal(boardUpdateCalled, true, 'a dead batch row must not be permanently unreapable');
  assert.equal(reaped, true);
});

// ...and the reason the guard above was unnecessary: a LIVE batch is protected by the BRANCH
// probe, which Fix 3 routed to the batch slug. The batch's execution branch exists and has moved
// since the stamp, so the row is not stale no matter what the queue lookup says.
test('reapRowIfStale (re-review): a LIVE batch is protected by the batch-slug BRANCH probe, not by the queue answer', () => {
  const rowLine = landingRow({
    slug: '3439-Infra-x',
    batch: 'batch-2026-08-25-smalls',
    touched: 'x · landing@2026-08-25T00:00:00.000Z',
  });
  const nowMs = Date.parse('2026-08-25T08:00:00.000Z');
  const probedRefs = [];
  let boardUpdateCalled = false;
  const reaped = reapRowIfStale('/scripts', '/repo', '3439-Infra-x', rowLine, nowMs, {
    _exec: (cmd, args) => {
      if (cmd === 'node' && args[1] === 'status') return JSON.stringify({ position: 0 }); // absent
      if (cmd === 'node' && args[1] === 'landing-held') return rowLine + '\n';
      if (cmd === 'node' && args[1] === 'update') {
        boardUpdateCalled = true;
        return '';
      }
      if (cmd === 'git' && args.includes('rev-parse')) {
        probedRefs.push(args[args.length - 1]);
        return 'deadbeef\n';
      }
      if (cmd === 'git' && args.includes('log')) {
        return `${Math.floor(Date.parse('2026-08-25T04:00:00.000Z') / 1000)}\n`; // after the stamp
      }
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    },
    log: () => {},
  });
  assert.equal(boardUpdateCalled, false, 'a live batch is never reaped');
  assert.equal(reaped, false);
  assert.ok(
    probedRefs.some((r) => r.includes('batch-2026-08-25-smalls')),
    'the branch probe used the BATCH slug, not the member row slug',
  );
  assert.ok(
    !probedRefs.some((r) => r.includes('3439-Infra-x')),
    'the member slug is never used for a liveness probe',
  );
});

// An ORDINARY row with no queue entry reads as genuinely absent — unchanged by any of the above.
test('reapRowIfStale (re-review): an ORDINARY row with no queue entry is still reaped', () => {
  const rowLine = landingRow({
    slug: '3439-Infra-x',
    touched: 'x · landing@2026-08-25T00:00:00.000Z',
  });
  const nowMs = Date.parse('2026-08-25T08:00:00.000Z');
  let boardUpdateCalled = false;
  const reaped = reapRowIfStale('/scripts', '/repo', '3439-Infra-x', rowLine, nowMs, {
    _exec: (cmd, args) => {
      if (cmd === 'node' && args[1] === 'status') return JSON.stringify({ position: 0 });
      if (cmd === 'node' && args[1] === 'landing-held') return rowLine + '\n'; // TOCTOU re-check
      if (cmd === 'node' && args[1] === 'update') {
        boardUpdateCalled = true;
        return '';
      }
      const r = noBranchProgress(cmd, args);
      if (r !== undefined) return r;
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    },
    log: () => {},
  });
  assert.equal(boardUpdateCalled, true);
  assert.equal(reaped, true);
});

// plan 3443 re-review round 2: a git commit timestamp is whole Unix SECONDS — `%ct` is an
// integer and `%cI` renders it as `2026-08-25T15:52:59+00:00`, never with a fraction. `landing@`
// carries milliseconds. So a commit in the same second as the claim compares 00.000 against
// 00.812 and reads as "no progress" — toward reaping a live land. Truncating the STAMP to its
// second and comparing `>=` makes them comparable and rounds the shared second toward progress.
//
// The stub below emits REAL git output shapes (bare integer seconds). An earlier pass pinned
// this with `…:00.750Z`, which git cannot produce — so the test passed while the code did
// nothing.
test('branchProgressedSince (re-review): a commit in the SAME second as a ms-precision stamp counts as progress', () => {
  const landingIso = '2026-08-25T00:00:00.812Z'; // the real shape stampLanding writes
  const tipSec = Math.floor(Date.parse('2026-08-25T00:00:00.000Z') / 1000); // same second, "before"
  const progressed = branchProgressedSince('/repo', '3439-Infra-x', landingIso, {
    _exec: (cmd, args) => {
      if (args.includes('rev-parse')) return 'deadbeef\n';
      if (args.includes('log')) return `${tipSec}\n`;
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    },
  });
  assert.equal(progressed, true, 'same-second commits round toward progress, never toward reaping');
});

test('branchProgressedSince (re-review): a commit a full second BEFORE the stamp is still not progress', () => {
  const landingIso = '2026-08-25T00:00:05.812Z';
  const tipSec = Math.floor(Date.parse('2026-08-25T00:00:04.000Z') / 1000);
  const progressed = branchProgressedSince('/repo', '3439-Infra-x', landingIso, {
    _exec: (cmd, args) => {
      if (args.includes('rev-parse')) return 'deadbeef\n';
      if (args.includes('log')) return `${tipSec}\n`;
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    },
  });
  assert.equal(progressed, false, 'the rounding is one second wide, not unbounded');
});

// --- Fix 3: a batch MEMBER row must not be reaped off the row's OWN slug ---------------

test('reapRowIfStale (Fix 3): a batch MEMBER row whose BATCH is live (queue entry + fresh heartbeat under the BATCH slug) is NEVER reaped', () => {
  const nowMs = Date.parse('2026-08-25T08:00:00.000Z');
  const rowLine = landingRow({
    slug: '3309-P02-member',
    batch: 'batch-2026-08-25-sonnet-smalls',
    touched: 'x · landing@2026-08-25T06:00:00.000Z', // 120m old — well past the 45m threshold
  });
  const statusCalls = [];
  const reaped = reapRowIfStale('/scripts', '/repo', '3309-P02-member', rowLine, nowMs, {
    _exec: (cmd, args) => {
      if (cmd === 'node' && args[1] === 'status') {
        statusCalls.push(args[2]);
        if (args[2] === 'batch-2026-08-25-sonnet-smalls') {
          return JSON.stringify({
            position: 1,
            heartbeatIso: new Date(nowMs - 60000).toISOString(), // fresh, 1m old
          });
        }
        return JSON.stringify({ position: 0 }); // the WRONG (member) slug has no entry
      }
      const r = noBranchProgress(cmd, args);
      if (r !== undefined) return r;
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    },
    log: () => {},
  });
  assert.deepEqual(
    statusCalls,
    ['batch-2026-08-25-sonnet-smalls'],
    'the queue lookup must use the BATCH slug, never the member row slug',
  );
  assert.equal(reaped, false, 'a live batch must never be reaped via a member row');
});

test('reapRowIfStale (Fix 3): an unparseable batch= marker treats queue state as UNKNOWN without shelling out, and is never reaped', () => {
  const nowMs = Date.parse('2026-08-25T08:00:00.000Z');
  // `batch=` present but no value follows — batchSlugOfCell returns null for this shape.
  const rowLine =
    '| 3309-P02-member | `abc1234` | 🟢 LANDING | `in-progress/3309-P02-member.md` · batch= | ' +
    'x · landing@2026-08-25T06:00:00.000Z | — |';
  const calls = [];
  const logs = [];
  const reaped = reapRowIfStale('/scripts', '/repo', '3309-P02-member', rowLine, nowMs, {
    _exec: (cmd, args) => {
      calls.push([cmd, args]);
      const e = new Error('must not be called');
      e.status = 1;
      throw e;
    },
    log: (m) => logs.push(m),
  });
  assert.equal(reaped, false);
  assert.deepEqual(
    calls,
    [],
    'an unparseable batch marker must short-circuit before any queue/branch shell-out',
  );
  assert.ok(
    logs.some((m) => /batch/i.test(m)),
    'logs why the row is being treated as unknown',
  );
});

// --- Fix 4: TOCTOU — re-check the row immediately before the board write --------------

test('reapRowIfStale (Fix 4): the landing@ stamp changing between verdict and write ABORTS the reap', () => {
  const oldIso = '2026-08-25T06:00:00.000Z';
  const newIso = '2026-08-25T07:55:00.000Z'; // a resumed session re-stamped it moments ago
  const rowLine = landingRow({ slug: '3439-Infra-x', touched: `x · landing@${oldIso}` });
  const freshRowLine = landingRow({ slug: '3439-Infra-x', touched: `x · landing@${newIso}` });
  const nowMs = Date.parse('2026-08-25T08:00:00.000Z');
  let landingHeldCalls = 0;
  let boardUpdateCalled = false;
  const logs = [];
  const reaped = reapRowIfStale('/scripts', '/repo', '3439-Infra-x', rowLine, nowMs, {
    _exec: (cmd, args) => {
      if (cmd === 'node' && args[1] === 'status') return JSON.stringify({ position: 0 });
      if (cmd === 'node' && args[1] === 'landing-held') {
        landingHeldCalls++;
        return freshRowLine + '\n'; // the re-check sees the row re-stamped
      }
      if (cmd === 'node' && args[1] === 'update') {
        boardUpdateCalled = true;
        return '';
      }
      const r = noBranchProgress(cmd, args);
      if (r !== undefined) return r;
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    },
    log: (m) => logs.push(m),
  });
  assert.equal(reaped, false, 'the reap must be aborted');
  assert.equal(boardUpdateCalled, false, 'the board write must never fire once the stamp changed');
  assert.equal(landingHeldCalls, 1, 'a re-check landing-held read happens right before the write');
  assert.ok(logs.some((m) => /stamp/i.test(m)));
});

test('reapRowIfStale (Fix 4): the row still being present, LANDING, and same-stamped at write time REAPS normally', () => {
  const iso = '2026-08-25T06:00:00.000Z';
  const rowLine = landingRow({ slug: '3439-Infra-x', touched: `x · landing@${iso}` });
  const nowMs = Date.parse('2026-08-25T08:00:00.000Z');
  let boardUpdateCalled = false;
  const reaped = reapRowIfStale('/scripts', '/repo', '3439-Infra-x', rowLine, nowMs, {
    _exec: (cmd, args) => {
      if (cmd === 'node' && args[1] === 'status') return JSON.stringify({ position: 0 });
      if (cmd === 'node' && args[1] === 'landing-held') return rowLine + '\n'; // unchanged
      if (cmd === 'node' && args[1] === 'update') {
        boardUpdateCalled = true;
        return '';
      }
      const r = noBranchProgress(cmd, args);
      if (r !== undefined) return r;
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    },
    log: () => {},
  });
  assert.equal(reaped, true, 'a genuinely stale, unchanged row is still reaped');
  assert.equal(boardUpdateCalled, true);
});

// --- Fix 5: the landing@ stamp is read from cell 4 ONLY --------------------------------

test('reapRowIfStale (Fix 5): a stray landing@ token in the resume cell must not stand in for a MISSING cell-4 stamp', () => {
  // Cell 4 (touched) carries no landing@ stamp at all; cell 5 (resume) carries an ancient one
  // (a leftover REAPED note's own text mentioning a ~5-year-old stamp). Without a real cell-4
  // stamp, staleness can never be proven — this must NOT reap regardless of what else is stale.
  const rowLine =
    '| 3439-Infra-x | `abc1234` | 🟢 LANDING | `in-progress/3439-Infra-x.md` · session 1 | ' +
    '2026-08-25T07:58:00.000Z | REAPED 2026-08-24T00:00:00.000Z: stale — ' +
    'landing@2020-01-01T00:00:00.000Z auto-flipped by queue-drain |';
  const nowMs = Date.parse('2026-08-25T08:00:00.000Z');
  let boardUpdateCalled = false;
  const reaped = reapRowIfStale('/scripts', '/repo', '3439-Infra-x', rowLine, nowMs, {
    _exec: (cmd, args) => {
      if (cmd === 'node' && args[1] === 'status') return JSON.stringify({ position: 0 });
      if (cmd === 'node' && args[1] === 'update') {
        boardUpdateCalled = true;
        return '';
      }
      const r = noBranchProgress(cmd, args);
      if (r !== undefined) return r;
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    },
    log: () => {},
  });
  assert.equal(
    boardUpdateCalled,
    false,
    'cell 4 carries no stamp — cannot prove staleness, so a stray resume-cell token must be ignored',
  );
  assert.equal(reaped, false);
});

// --- Fix 6: `--ready` (repoRoot: null) stays the old blunt path ------------------------

test('resolveLandingHeldForSeedLane (Fix 6): repoRoot: null skips the lane-aware machinery entirely (no per-row plan-read noise)', () => {
  const rows = [landingRow({ slug: '3439-Infra-x' })];
  const logs = [];
  const held = resolveLandingHeldForSeedLane({
    scriptsDir: '/scripts',
    repoRoot: null,
    heal: true,
    _exec: (cmd, args) => {
      if (cmd === 'node' && args[1] === 'landing-held') return rows.join('\n') + '\n';
      throw new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`);
    },
    log: (m) => logs.push(m),
  });
  assert.equal(held, true, 'a held row is still reported held via the blunt board answer');
  assert.deepEqual(
    logs,
    [],
    'no per-row "could not read plan" noise — the lane-aware machinery must never run without a repoRoot',
  );
});

// --- Fix 7: an authoritative-read failure must fail CLOSED, never fall back to disk ----

test('readPlanContentFromOrigin (Fix 7): a git-show failure PROPAGATES — no local-disk fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qdrain-fix7-'));
  try {
    mkdirSync(join(dir, 'docs', 'superpowers', 'plans', 'in-progress'), { recursive: true });
    // A STALE local copy claiming 🟩 — if the fallback fired, this is what it would wrongly
    // return instead of throwing.
    writeFileSync(
      join(dir, 'docs', 'superpowers', 'plans', 'in-progress', '3439-Infra-x.md'),
      plan({ seed: 'NO' }),
      'utf8',
    );
    assert.throws(
      () =>
        readPlanContentFromOrigin(dir, 'in-progress/3439-Infra-x.md', {
          _exec: () => {
            throw new Error('git show origin/master:... failed: unknown revision');
          },
        }),
      /unknown revision/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The BATCH twin (execution notes: "TWO call sites, not one" — computeRunnableBatches must
// honour the SAME plain landingHeld boolean the single-plan path does, so the resolve-once
// placement at the consult site narrows BOTH). Mirrors the landing-mutex cases just above and
// the existing batch cases (see "plan 2556: batchHold + the runnableBatches surfacing" below).
test('selectEligible (batch path): a 🟥 train IS offered when landingHeld is false (🟩-only landing state)', () => {
  const r = selectEligible(
    [
      heldMeta({ id: 20, slug: 'batch-seed', seedWrite: 'yes' }),
      heldMeta({ id: 21, slug: 'batch-seed' }),
    ],
    { landingHeld: false, batchRoster: [rosterEntry('batch-seed', [20, 21])] },
  );
  assert.equal(r.runnableBatches.length, 1);
  assert.equal(r.runnableBatches[0].slug, 'batch-seed');
});

test('selectEligible (batch path): the SAME 🟥 train is still withheld when landingHeld is true', () => {
  const r = selectEligible(
    [
      heldMeta({ id: 20, slug: 'batch-seed', seedWrite: 'yes' }),
      heldMeta({ id: 21, slug: 'batch-seed' }),
    ],
    { landingHeld: true, batchRoster: [rosterEntry('batch-seed', [20, 21])] },
  );
  assert.deepEqual(r.runnableBatches, []);
});

// --- selectEligible: ordering ------------------------------------------------

test('selectEligible: 🟩 before 🟥, then id ascending', () => {
  const r = selectEligible(
    [
      meta({ id: 233, seedWrite: 'no' }),
      meta({ id: 150, seedWrite: 'yes' }),
      meta({ id: 203, seedWrite: 'no' }),
      meta({ id: 100, seedWrite: 'yes' }),
    ],
    { landingHeld: false },
  );
  assert.deepEqual(
    r.eligible.map((e) => e.slug),
    ['203-X-test', '233-X-test', '100-X-test', '150-X-test'],
  );
  assert.equal(r.next.slug, '203-X-test'); // lowest-id 🟩 first
});

test('selectEligible: within a seed group, cheaper cost sorts first', () => {
  const r = selectEligible(
    [
      meta({ id: 100, seedWrite: 'no', cost: '$5' }),
      meta({ id: 200, seedWrite: 'no', cost: '$0' }),
      meta({ id: 300, seedWrite: 'no', cost: '$2' }),
    ],
    { landingHeld: false },
  );
  assert.deepEqual(
    r.eligible.map((e) => e.slug),
    ['200-X-test', '300-X-test', '100-X-test'], // $0 < $2 < $5
  );
});

test('selectEligible: cost asc respects 🟩-first; unknown cost sorts last in group', () => {
  const r = selectEligible(
    [
      meta({ id: 10, seedWrite: 'yes', cost: '$1' }), // 🟥 cheap
      meta({ id: 20, seedWrite: 'no', cost: null }), //  🟩 unknown cost → last in 🟩
      meta({ id: 30, seedWrite: 'no', cost: '$4' }), //  🟩 known cost
      meta({ id: 40, seedWrite: 'yes', cost: '$0' }), // 🟥 cheapest seed
    ],
    { landingHeld: false },
  );
  // 🟩 group first (cost asc, unknown last): 30 ($4) then 20 (unknown);
  // 🟥 group next (cost asc): 40 ($0) then 10 ($1).
  assert.deepEqual(
    r.eligible.map((e) => e.slug),
    ['30-X-test', '20-X-test', '40-X-test', '10-X-test'],
  );
});

test('selectEligible: equal cost falls back to plan-id ascending', () => {
  const r = selectEligible(
    [
      meta({ id: 300, seedWrite: 'no', cost: '$0' }),
      meta({ id: 100, seedWrite: 'no', cost: '$0' }),
      meta({ id: 200, seedWrite: 'no', cost: '$0' }),
    ],
    { landingHeld: false },
  );
  assert.deepEqual(
    r.eligible.map((e) => e.slug),
    ['100-X-test', '200-X-test', '300-X-test'],
  );
});

// --- plan 2328: priority: high is the FIRST sort key -------------------------

test('selectEligible (plan 2328): priority beats a cheaper AND greener non-priority plan', () => {
  const r = selectEligible(
    [
      meta({ id: 100, seedWrite: 'no', cost: '$0' }), // 🟩 free — normally first
      { ...meta({ id: 200, seedWrite: 'yes', cost: '$9' }), priority: true, priorityTier: 'high' }, // ⚡ 🟥 expensive
    ],
    { landingHeld: false },
  );
  assert.equal(r.next.slug, '200-X-test'); // ⚡ wins over both lane and cost
  assert.equal(r.next.priority, true); // surfaced in the oracle item
  assert.equal(r.eligible[1].priority, undefined); // absent on a normal plan
});

test('selectEligible (plan 2328): hard gates still exclude a priority plan — priority never gates', () => {
  const r = selectEligible(
    [
      {
        ...meta({ id: 200, seedWrite: 'no', exclude: 'blocked' }),
        priority: true,
        priorityTier: 'high',
      },
      meta({ id: 100, seedWrite: 'no', cost: '$0' }),
    ],
    { landingHeld: false },
  );
  assert.equal(r.next.slug, '100-X-test'); // the excluded ⚡ plan never re-enters
  assert.equal(r.excluded[0].slug, '200-X-test');
  // and the seed-write LANDING mutex still withholds a ⚡ 🟥 plan:
  const held = selectEligible(
    [{ ...meta({ id: 300, seedWrite: 'yes' }), priority: true, priorityTier: 'high' }],
    { landingHeld: true },
  );
  assert.equal(held.reason, 'landing_mutex_active');
});

test('selectEligible (plan 2328): two priority plans fall back to the normal chain between themselves', () => {
  const r = selectEligible(
    [
      { ...meta({ id: 100, seedWrite: 'yes', cost: '$0' }), priority: true, priorityTier: 'high' }, // ⚡ 🟥
      { ...meta({ id: 300, seedWrite: 'no', cost: '$5' }), priority: true, priorityTier: 'high' }, // ⚡ 🟩 pricier
      { ...meta({ id: 200, seedWrite: 'no', cost: '$1' }), priority: true, priorityTier: 'high' }, // ⚡ 🟩 cheap
      meta({ id: 50, seedWrite: 'no', cost: '$0' }), // normal — behind every ⚡
    ],
    { landingHeld: false },
  );
  // Within the ⚡ group the pre-2328 chain holds: 🟩 before 🟥, cost asc.
  assert.deepEqual(
    r.eligible.map((e) => e.slug),
    ['200-X-test', '300-X-test', '100-X-test', '50-X-test'],
  );
});

// --- plan 2520: three-tier priority — high > medium/unstamped > low ----------

test('selectEligible (plan 2520): high > medium/unstamped > low, tie-break unchanged below the tier', () => {
  const r = selectEligible(
    [
      { ...meta({ id: 100, seedWrite: 'no', cost: '$0' }), priorityTier: 'low' }, // sinks last
      meta({ id: 200, seedWrite: 'no', cost: '$0' }), // unstamped = medium
      { ...meta({ id: 300, seedWrite: 'no', cost: '$0' }), priorityTier: 'medium' }, // explicit medium
      { ...meta({ id: 400, seedWrite: 'no', cost: '$5' }), priorityTier: 'high' },
    ],
    { landingHeld: false },
  );
  assert.deepEqual(
    r.eligible.map((e) => e.slug),
    // high first; medium and unstamped tie at the SAME tier and fall back to the pre-2328
    // chain between themselves (both 🟩/$0 here, so id-asc); low sinks below all of them.
    ['400-X-test', '200-X-test', '300-X-test', '100-X-test'],
  );
});

test('selectEligible (plan 2520): low sinks BELOW the unstamped bulk, not merely "not high"', () => {
  const r = selectEligible(
    [
      { ...meta({ id: 100, seedWrite: 'no', cost: '$9' }), priorityTier: 'low' }, // 🟩 cheap-lane but low tier
      meta({ id: 200, seedWrite: 'yes', cost: '$0' }), // 🟥 unstamped — would normally sort BEHIND 🟩
    ],
    { landingHeld: false },
  );
  // Pre-2520 there was no way to push a plan below the unstamped bulk — a `low` stamp used to
  // read identically to no stamp at all. Now it sorts dead last regardless of the 🟩/🟥 chain.
  assert.deepEqual(
    r.eligible.map((e) => e.slug),
    ['200-X-test', '100-X-test'],
  );
});

test('selectEligible (plan 2520): an unrecognized/escaped priorityTier value falls back to the medium weight, not a crash', () => {
  const r = selectEligible(
    [
      { ...meta({ id: 100, seedWrite: 'no', cost: '$0' }), priorityTier: 'normal' }, // escaped bad value
      { ...meta({ id: 200, seedWrite: 'no', cost: '$0' }), priorityTier: 'high' },
    ],
    { landingHeld: false },
  );
  assert.deepEqual(
    r.eligible.map((e) => e.slug),
    ['200-X-test', '100-X-test'],
  );
});

test('selectEligible: null banner treated as 🟥 for sort/mutex', () => {
  const m = {
    id: 50,
    slug: '50-X-test',
    seedWrite: null,
    blockedBy: null,
    cost: parseCost(null),
    exclude: null,
    // plan 3461 round 3: toItem() no longer defaults a missing lane to 'sonnet' — this
    // hand-built meta (bypassing the meta() helper) must supply it explicitly, same as any
    // real parsePlanMeta output does.
    lane: 'sonnet',
  };
  const r = selectEligible([m, meta({ id: 51, seedWrite: 'no' })], { landingHeld: false });
  assert.equal(r.next.slug, '51-X-test'); // 🟩 sorts ahead of unknown-banner plan
  const held = selectEligible([m], { landingHeld: true });
  assert.equal(held.reason, 'landing_mutex_active'); // unknown banner dropped under mutex
});

test('selectEligible: emits path + seedWrite + cost on next', () => {
  const r = selectEligible([meta({ id: 203, seedWrite: 'no' })], { landingHeld: false });
  assert.equal(r.next.path, 'docs/superpowers/plans/ready/203-X-test.md');
  assert.equal(r.next.seedWrite, 'no');
  assert.ok('usd' in r.next.cost);
});

test('selectEligible: a stale-Blocked-by plan surfaces staleBlockedBy on both next and eligible (plan 1819)', () => {
  const warning =
    'blocked-by plan 1760 is archived (landed) — stale Blocked-by line: "plan 1760 (in flight)"';
  const r = selectEligible([meta({ id: 1790, staleBlockedBy: warning })], { landingHeld: false });
  assert.equal(r.next.staleBlockedBy, warning);
  assert.equal(r.eligible[0].staleBlockedBy, warning);
});

test('selectEligible: a plan with no staleBlockedBy omits the field entirely (JSON shape unchanged — plan 1819)', () => {
  const r = selectEligible([meta({ id: 1791 })], { landingHeld: false });
  assert.equal('staleBlockedBy' in r.next, false);
});

test('selectEligible: returns excluded (slug+exclude+reason) on the success path (plan 443)', () => {
  const interactive = {
    id: 437,
    slug: '437-UI-test',
    seedWrite: 'no',
    blockedBy: null,
    cost: parseCost('$0'),
    exclude: 'operator',
    excludeReason:
      'operator-interactive: needs the operator\'s live browser/session (matched "google flow")',
  };
  const r = selectEligible([meta({ id: 435, seedWrite: 'yes' }), interactive], {
    landingHeld: false,
  });
  assert.equal(r.next.slug, '435-X-test'); // the eligible one runs
  assert.equal(r.excluded.length, 1); // ...and the skipped one is reported
  assert.equal(r.excluded[0].slug, '437-UI-test');
  assert.equal(r.excluded[0].exclude, 'operator');
  assert.match(r.excluded[0].reason, /operator-interactive/);
});

test('selectEligible: an excluded item carries cost too (plan 3955 — mirrors toItem())', () => {
  const interactive = {
    id: 437,
    slug: '437-UI-test',
    seedWrite: 'no',
    blockedBy: null,
    cost: parseCost('$0'),
    exclude: 'operator',
    excludeReason:
      'operator-interactive: needs the operator\'s live browser/session (matched "google flow")',
  };
  const r = selectEligible([meta({ id: 435, seedWrite: 'yes' }), interactive], {
    landingHeld: false,
  });
  assert.equal(r.excluded.length, 1);
  assert.ok(
    'usd' in r.excluded[0].cost,
    'the excluded item carries the same cost shape as eligible',
  );
});

test('selectEligible: seedLane off ⇒ no mutex drop even when landingHeld', () => {
  const metas = [meta({ id: 231, seedWrite: 'yes' }), meta({ id: 100, seedWrite: 'no' })];
  const r = selectEligible(metas, { landingHeld: true, seedLane: false });
  assert.equal(r.next.slug, '100-X-test'); // lowest id first (no seed sort bias when seedLane off)
  assert.equal(r.eligible.length, 2); // nothing dropped — mutex skipped
});

// --- stage/execModel frontmatter gates (plan 1292) ---------------------------

// Full plan body with a leading YAML frontmatter block, so readFrontmatterKey
// actually has a `---`…`---` block to parse (the `plan()` helper above has none).
function planFm(frontmatterLines, extra = '') {
  const fm = ['---', ...frontmatterLines, '---'].join('\n');
  return `${fm}\n\n> 🟩 **${MUTATION_BANNER_LABEL}: NO** — test.\n\n# Test plan\n\n${extra}\n`;
}

test('parsePlanMeta: execModel: fable is excluded with reason "fable" (frontmatter, not filename)', () => {
  const m = parsePlanMeta(
    '1300-Other-fable-shape.md',
    planFm(['execModel: fable', 'stage: specced']),
  );
  assert.equal(m.execModel, 'fable');
  assert.equal(m.exclude, 'fable');
  assert.match(m.excludeReason, /execModel: fable/);
});

test('parsePlanMeta: execModel: sonnet is eligible', () => {
  const m = parsePlanMeta(
    '1301-Other-sonnet-shape.md',
    planFm(['execModel: sonnet', 'stage: specced']),
  );
  assert.equal(m.execModel, 'sonnet');
  assert.equal(m.exclude, null);
});

test('selectEligible: a ready/ pair (one execModel: fable, one execModel: sonnet) drains only the sonnet one, fable excluded with reason', () => {
  const fable = parsePlanMeta(
    '1302-Other-fable-plan.md',
    planFm(['execModel: fable', 'stage: specced']),
  );
  const sonnet = parsePlanMeta(
    '1303-Other-sonnet-plan.md',
    planFm(['execModel: sonnet', 'stage: specced']),
  );
  const r = selectEligible([fable, sonnet], { landingHeld: false });
  assert.equal(r.next.slug, '1303-Other-sonnet-plan');
  assert.equal(r.eligible.length, 1);
  assert.equal(r.excluded.length, 1);
  assert.equal(r.excluded[0].slug, '1302-Other-fable-plan');
  assert.equal(r.excluded[0].exclude, 'fable');
  assert.match(r.excluded[0].reason, /execModel: fable/);
});

test('parsePlanMeta: legacy plan with NO stage/execModel frontmatter fields is eligible (grandfather)', () => {
  const m = parsePlanMeta(
    '900-Other-legacy-plan.md',
    plan({ extra: '**Cost forecast:** $0 — no LLM spend.' }), // no frontmatter block at all
  );
  assert.equal(m.execModel, null);
  assert.equal(m.stage, null);
  assert.equal(m.specReview, null);
  assert.equal(m.exclude, null); // absent execModel ⇒ sonnet; absent stage ⇒ specced
});

test('parsePlanMeta: frontmatter present but WITHOUT execModel/stage keys is also eligible (grandfather)', () => {
  const m = parsePlanMeta('901-Other-partial-fm.md', planFm(['seedWrite: false']));
  assert.equal(m.execModel, null);
  assert.equal(m.stage, null);
  assert.equal(m.exclude, null);
});

test('parsePlanMeta (plan 2328): priority: high is read from frontmatter; other/absent values are normal', () => {
  const hi = parsePlanMeta('2340-DQ-urgent.md', planFm(['priority: high']));
  assert.equal(hi.priority, true);
  assert.equal(hi.priorityTier, 'high');
  assert.equal(hi.exclude, null); // the stamp never gates
  // The boolean flag (`priority`) stays `high`-only, byte-identical to pre-2520 — a `low` stamp,
  // a garbage value, and no frontmatter at all all read `priority: false` here.
  assert.equal(parsePlanMeta('a.md', planFm(['priority: low'])).priority, false);
  assert.equal(parsePlanMeta('b.md', planFm(['priority: true'])).priority, false);
  assert.equal(parsePlanMeta('c.md', plan({ seed: 'NO' })).priority, false);
});

test('parsePlanMeta (plan 2520): priorityTier carries the three-tier vocabulary — medium is the default for absent AND for an escaped bad value', () => {
  assert.equal(parsePlanMeta('a.md', planFm(['priority: low'])).priorityTier, 'low');
  assert.equal(parsePlanMeta('b.md', planFm(['priority: medium'])).priorityTier, 'medium');
  assert.equal(parsePlanMeta('c.md', plan({ seed: 'NO' })).priorityTier, 'medium'); // unstamped
  assert.equal(parsePlanMeta('d.md', planFm(['priority: normal'])).priorityTier, 'medium'); // illegal, warns
  assert.equal(parsePlanMeta('e.md', planFm(['priority: HIGH'])).priorityTier, 'high'); // case-insensitive
});

test('parsePlanMeta: stage: stub with no specReview is excluded with reason "stub"', () => {
  const m = parsePlanMeta('1304-Other-stub-plan.md', planFm(['stage: stub', 'execModel: sonnet']));
  assert.equal(m.stage, 'stub');
  assert.equal(m.specReview, null);
  assert.equal(m.exclude, 'stub');
  assert.match(m.excludeReason, /spec-pass/);
  assert.match(m.excludeReason, /exempt-mechanical/);
});

// ── plan 4202: specReviewBy: undeclared → exclude code 'provenance', never 'stub' ──────

test('parsePlanMeta: a real specReview stamped with specReviewBy: undeclared is excluded with reason "provenance" (plan 4202)', () => {
  const m = parsePlanMeta(
    '1320-Other-undeclared.md',
    planFm([
      'stage: specced',
      'specReview: 9f8e7d6',
      'specReviewBy: undeclared',
      'execModel: sonnet',
    ]),
  );
  assert.equal(m.exclude, 'provenance');
  assert.match(m.excludeReason, /specReviewBy: undeclared/);
});

test('parsePlanMeta: undeclared provenance excludes on stage: stub too — never the bare-stub "stub" code', () => {
  const m = parsePlanMeta(
    '1321-Other-undeclared-stub.md',
    planFm(['stage: stub', 'specReview: 9f8e7d6', 'specReviewBy: undeclared', 'execModel: sonnet']),
  );
  assert.equal(m.exclude, 'provenance');
  assert.doesNotMatch(m.excludeReason, /without a specReview stamp/);
});

test('parsePlanMeta: specReviewBy is case-insensitive; an absent specReviewBy (legacy) is never "provenance"', () => {
  const upper = parsePlanMeta(
    '1322-Other-undeclared-upper.md',
    planFm(['stage: specced', 'specReview: 9f8e7d6', 'specReviewBy: UNDECLARED']),
  );
  assert.equal(upper.exclude, 'provenance');

  const legacy = parsePlanMeta(
    '1323-Other-legacy.md',
    planFm(['stage: specced', 'specReview: 9f8e7d6']),
  );
  assert.equal(legacy.exclude, null);

  const declared = parsePlanMeta(
    '1324-Other-declared.md',
    planFm(['stage: specced', 'specReview: 9f8e7d6', 'specReviewBy: fable-5.1/xhigh']),
  );
  assert.equal(declared.exclude, null);
});

test('parsePlanMeta: exempt-mechanical is never excluded as "provenance", even with a garbage specReviewBy', () => {
  const m = parsePlanMeta(
    '1325-Other-exempt.md',
    planFm(['stage: stub', 'specReview: exempt-mechanical', 'specReviewBy: undeclared']),
  );
  assert.equal(m.exclude, null);
});

test('parsePlanMeta: stage: stub + specReview: exempt-mechanical is eligible', () => {
  const m = parsePlanMeta(
    '1305-Other-stub-exempt.md',
    planFm(['stage: stub', 'specReview: exempt-mechanical', 'execModel: sonnet']),
  );
  assert.equal(m.specReview, 'exempt-mechanical');
  assert.equal(m.exclude, null);
});

test('parsePlanMeta: stage: stub + specReview: <sha> is eligible', () => {
  const m = parsePlanMeta(
    '1306-Other-stub-sha.md',
    planFm(['stage: stub', 'specReview: a1b2c3d', 'execModel: sonnet']),
  );
  assert.equal(m.specReview, 'a1b2c3d');
  assert.equal(m.exclude, null);
});

test('parsePlanMeta: a FABLE- filename segment with NO execModel frontmatter is still eligible — proves the filter reads frontmatter, never the filename', () => {
  const m = parsePlanMeta(
    '1307-FABLE-Category-heavy-model-looking-name.md',
    planFm(['stage: specced']), // deliberately no execModel key
  );
  assert.equal(m.execModel, null); // filename says FABLE, frontmatter says nothing
  assert.equal(m.exclude, null); // grandfathered to sonnet-eligible — filename is NOT read
});

// plan 1292 bugfix (plan 1015 shape): a comment-suffixed execModel value used to
// survive the raw readFrontmatterKey compare intact ("fable # umbrella tracker…"
// never equals the bare string 'fable'), so the plan silently escaped the fable
// exclusion. readFrontmatterScalar strips the comment before the compare.
test('parsePlanMeta: execModel with a trailing YAML comment (plan 1015 shape) is still excluded as fable', () => {
  const m = parsePlanMeta(
    '1015-Other-umbrella-tracker.md',
    planFm(['execModel: fable # umbrella tracker — NOT drain-eligible', 'stage: specced']),
  );
  assert.equal(m.execModel, 'fable');
  assert.equal(m.exclude, 'fable');
});

// plan 1292 round-2 bugfix repro: a QUOTED-AND-commented value ("fable" # note) used to
// survive with its quotes intact — readFrontmatterKey's own unquote pass sees the raw
// `"fable" # note` (last char is comment text, not a closing quote, so it never fires),
// and the old readFrontmatterScalar only stripped the comment, leaving `"fable"` (with
// quotes) to fail the bare-string compare and silently escape the fable exclusion.
test('parsePlanMeta: execModel with a QUOTED value and a trailing YAML comment is still excluded as fable', () => {
  const m = parsePlanMeta(
    '1310-Other-quoted-fable.md',
    planFm(['execModel: "fable" # note', 'stage: specced']),
  );
  assert.equal(m.execModel, 'fable');
  assert.equal(m.exclude, 'fable');
});

test('parsePlanMeta: stub exclusion is case-insensitive on stage and survives a comment on specReview', () => {
  const stubUpper = parsePlanMeta(
    '1308-Other-stub-upper.md',
    planFm(['stage: STUB', 'execModel: sonnet']),
  );
  assert.equal(stubUpper.exclude, 'stub');

  const stubWithComment = parsePlanMeta(
    '1309-Other-stub-comment.md',
    planFm([
      'stage: stub',
      'specReview: exempt-mechanical # no judgment call here',
      'execModel: sonnet',
    ]),
  );
  assert.equal(stubWithComment.specReview, 'exempt-mechanical');
  assert.equal(stubWithComment.exclude, null);
});

// --- selectEligible: all_fable_or_stub aggregate reason (plan 1292 bugfix) ---

test('selectEligible: all excluded by fable/stub only → all_fable_or_stub, not all_blocked', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'fable' }), meta({ id: 11, exclude: 'stub' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_fable_or_stub');
});

test('selectEligible: a fable/stub mix WITH a genuine blocked plan still reports all_blocked', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'fable' }), meta({ id: 11, exclude: 'blocked' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_blocked');
});

// plan 4202: an undeclared-provenance exclude ('provenance') joins the same "lifecycle,
// not blocked" mixed-pool set 'stub' already joined — see the mixed-pool `.every()` list's
// own comment in queue-drain.mjs for why.
test('selectEligible: an all-provenance pool (specReviewBy: undeclared) reports all_fable_or_stub, never all_blocked (plan 4202)', () => {
  const r = selectEligible([meta({ id: 10, exclude: 'provenance' })], { landingHeld: false });
  assert.equal(r.reason, 'all_fable_or_stub');
});

test('selectEligible: provenance MIXED with stub/fable still reports all_fable_or_stub', () => {
  const r = selectEligible(
    [
      meta({ id: 10, exclude: 'provenance' }),
      meta({ id: 11, exclude: 'stub' }),
      meta({ id: 12, exclude: 'fable' }),
    ],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_fable_or_stub');
});

test('selectEligible: provenance MIXED with a genuine blocked plan still reports all_blocked', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'provenance' }), meta({ id: 11, exclude: 'blocked' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_blocked');
});

// plan 2541: the operator bucket used to check .some() while every sibling bucket
// checked .every() — a fable+operator mix wrongly reported 'all_need_operator' even
// though the fable member isn't operator-gated at all. Now every bucket (including
// this one) requires the WHOLE excluded set to match before claiming its reason, so
// a mix that satisfies no single-cause bucket falls through to 'all_blocked'.
test('selectEligible: an operator/fable mix satisfies no single-cause bucket → all_blocked', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'fable' }), meta({ id: 11, exclude: 'operator' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_blocked');
});

// plan 2541 regression: the original bug report's exact shape — one plan excluded
// 'operator', another excluded 'blocked' (or 'blocker_archived_unshipped') — must
// NOT report 'all_need_operator' since not every excluded plan is operator-gated.
test('selectEligible: operator mixed with a genuine blocked plan is NOT all_need_operator (plan 2541)', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'operator' }), meta({ id: 11, exclude: 'blocked' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_blocked');
});

test('selectEligible: operator mixed with blocker_archived_unshipped is NOT all_need_operator (plan 2541)', () => {
  const r = selectEligible(
    [
      meta({ id: 10, exclude: 'operator' }),
      meta({ id: 11, exclude: 'blocker_archived_unshipped' }),
    ],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_blocked');
});

// plan 2541 no-regression: a PURE all-operator pool must still report all_need_operator.
test('selectEligible: a pure all-operator pool still reports all_need_operator (plan 2541)', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'operator' }), meta({ id: 11, exclude: 'operator' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_need_operator');
});

// --- plan 2459 Task 2: runnable-batch hold gate (leak B) ---------------------

test('parsePlanMeta: a member of a runnable batch (batchHeldBy has it) is excluded as batch, naming the slug + both legal moves', () => {
  const m = parsePlanMeta('2460-FABLE-x.md', plan({ extra: '> 💰 **Cost forecast:** $0' }), {
    batchHeldBy: new Map([['2460', 'batch-claim-projection']]),
  });
  assert.equal(m.exclude, 'batch');
  assert.match(m.excludeReason, /batch-claim-projection/);
  assert.match(m.excludeReason, /claim-plan\.mjs batch/);
  assert.match(m.excludeReason, /--override-batch-solo/);
});

test('parsePlanMeta: a ZERO-PADDED legacy plan id still matches its batch hold (plan 2459 review regression)', () => {
  // parsePlanMeta derives `id` as Number(...), so `007-…md` becomes 7. Before the fix the
  // lookup used String(id) === '7' against a map keyed on the roster's raw '007', missed, and
  // left exclude null — the guard failing OPEN for every legacy sub-100 id, which is precisely
  // the solo-claim dissolution it was built to stop. readRunnableBatchMembers now canonicalizes
  // its keys, so the map a real caller passes is keyed '7'.
  const m = parsePlanMeta(
    '007-P07-scrape-concurrency-sweep.md',
    plan({ extra: '> 💰 **Cost forecast:** $0' }),
    {
      batchHeldBy: new Map([['7', 'batch-legacy']]),
    },
  );
  assert.equal(m.exclude, 'batch');
  assert.match(m.excludeReason, /batch-legacy/);
});

test('parsePlanMeta: a plan NOT in batchHeldBy is unaffected — default empty Map is byte-identical to pre-2459', () => {
  const m = parsePlanMeta('2460-FABLE-x.md', plan({ extra: '> 💰 **Cost forecast:** $0' }));
  assert.equal(m.exclude, null);
});

test('parsePlanMeta: the stub/specReview gate wins over a batch hold — a stub still needs a spec-pass regardless of batch membership', () => {
  const m = parsePlanMeta('2460-FABLE-x.md', planFm(['stage: stub']), {
    batchHeldBy: new Map([['2460', 'batch-x']]),
  });
  assert.equal(m.exclude, 'stub');
});

test('parsePlanMeta: a batch hold wins over Blocked-by — it names an alternative claim path, not an upstream dependency', () => {
  const m = parsePlanMeta(
    '2460-FABLE-x.md',
    plan({ extra: '**Blocked-by:** plan 900 (still in flight)\n\n> 💰 **Cost forecast:** $0' }),
    { batchHeldBy: new Map([['2460', 'batch-x']]) },
  );
  assert.equal(m.exclude, 'batch');
});

test('parsePlanMeta: operator-gating still takes precedence over a batch hold (checked earlier in the chain)', () => {
  const m = parsePlanMeta(
    '2460-FABLE-x.md',
    plan({ extra: 'Operator supplies the export first.\n\n> 💰 **Cost forecast:** $0' }),
    { batchHeldBy: new Map([['2460', 'batch-x']]) },
  );
  assert.equal(m.exclude, 'operator');
});

// plan 2459's guarantee — a batch-held pool gets its OWN reason, never all_fable_or_stub or
// all_blocked — is preserved, but plan 2556's review SPLIT that reason in two: `all_batch_held`
// now PROMISES a takeable train, while `all_batch_held_none_runnable` says the members are held
// with nothing to take (e.g. one is blocked underneath the hold). Both halves are asserted here
// so 2459's intent stays visible and neither value can quietly become the other.
test('selectEligible: all excluded by batch hold, NO takeable train → all_batch_held_none_runnable (never all_fable_or_stub)', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'batch' }), meta({ id: 11, exclude: 'batch' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_batch_held_none_runnable');
  assert.notEqual(r.reason, 'all_fable_or_stub');
  assert.deepEqual(r.runnableBatches, []);
});

test('selectEligible: all excluded by batch hold WITH a takeable train → all_batch_held', () => {
  const r = selectEligible(
    [heldMeta({ id: 10, slug: 'batch-a' }), heldMeta({ id: 11, slug: 'batch-a' })],
    { landingHeld: false, batchRoster: [rosterEntry('batch-a', [10, 11])] },
  );
  assert.equal(r.reason, 'all_batch_held');
  assert.equal(r.runnableBatches.length, 1, 'the reason promises a train — it must be there');
});

test('selectEligible: a batch-hold + fable/stub mix reports all_blocked — the two buckets never merge', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'batch' }), meta({ id: 11, exclude: 'fable' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_blocked');
});

test('selectEligible: a batch-hold mix WITH a genuine blocked plan still reports all_blocked', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'batch' }), meta({ id: 11, exclude: 'blocked' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_blocked');
});

// This test asserted `all_need_operator` while the operator bucket used `.some()`. Plan 2541
// changed that bucket to `.every()` (matching every sibling bucket) precisely so a MIXED pool
// stops claiming a reason that only one of its plans actually has — an operator reading
// `all_need_operator` for a pool that is half batch-held performs an operator action that
// unblocks nothing. Rewritten to the post-2541 truth, and kept rather than deleted because it
// is the one place BOTH invariants meet: a mixed operator+batch pool may claim NEITHER reason.
test('selectEligible: an operator + batch-hold mix claims neither reason — it falls through to all_blocked (plan 2541 .every())', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'batch' }), meta({ id: 11, exclude: 'operator' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_blocked');
  assert.notEqual(r.reason, 'all_need_operator');
  assert.notEqual(r.reason, 'all_batch_held');
});

// The no-regression twin 2541 asks for, on THIS plan's axis: a PURE operator pool must still
// report all_need_operator even with the batch gate wired in (the batch map is consulted, but
// an operator-gated plan is excluded before it and the reason must not drift).
test('selectEligible: a pure operator pool still reports all_need_operator with the batch gate live', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'operator' }), meta({ id: 11, exclude: 'operator' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_need_operator');
});

// --- plan 2556: batchHold + the runnableBatches surfacing --------------------
//
// THE GAP THIS CLOSES: the routine prompts' batch check asked whether "every id in the
// batch's `members` array appears in the oracle's `eligible` list" — which the plan-2459
// hold makes impossible by construction, since a batch-held member is EXCLUDED from
// `eligible`. The check was structurally dead in BOTH lanes. `runnableBatches` answers
// the question the prompt actually needed, without ever relaxing the hold.

test('parsePlanMeta: a batch-held plan with no Blocked-by carries batchHold {slug, otherwise:null} — otherwise-eligible', () => {
  const m = parsePlanMeta('2460-FABLE-x.md', plan({ extra: '> 💰 **Cost forecast:** $0' }), {
    batchHeldBy: new Map([['2460', 'batch-x']]),
  });
  assert.equal(m.exclude, 'batch');
  assert.deepEqual(m.batchHold, { slug: 'batch-x', otherwise: null });
});

// THE BUG THIS PINS: the batch gate is checked BEFORE Blocked-by, so a member that is
// BOTH batch-held and blocked-by an open upstream reports `exclude: 'batch'` — visually
// indistinguishable from a member that is merely waiting for its train. Reporting that
// batch as runnable would send a drain to claim a train one of whose cars cannot move.
test('parsePlanMeta: a batch-held plan that is ALSO blocked-by an open upstream records otherwise:blocked', () => {
  const m = parsePlanMeta(
    '2460-FABLE-x.md',
    plan({ extra: '**Blocked-by:** plan 900 (still in flight)\n\n> 💰 **Cost forecast:** $0' }),
    { batchHeldBy: new Map([['2460', 'batch-x']]) },
  );
  assert.equal(m.exclude, 'batch'); // the hold still WINS — unchanged from 2459
  assert.equal(m.batchHold.otherwise, 'blocked');
});

test('parsePlanMeta: a batch-held plan whose Blocked-by line is STALE is otherwise-eligible, and staleBlockedBy stays null (pre-2556 output preserved)', () => {
  const m = parsePlanMeta(
    '2460-FABLE-x.md',
    plan({ extra: '**Blocked-by:** plan 900\n\n> 💰 **Cost forecast:** $0' }),
    { batchHeldBy: new Map([['2460', 'batch-x']]), archivedIds: new Set(['900']) },
  );
  assert.equal(m.exclude, 'batch');
  assert.equal(m.batchHold.otherwise, null);
  // Deliberate: the classifier's staleBlockedBy is NOT adopted on the batch branch, so
  // every field that existed before plan 2556 is byte-identical to what 2459 emitted.
  assert.equal(m.staleBlockedBy, null);
});

test('parsePlanMeta: a plan no batch holds has batchHold null', () => {
  const m = parsePlanMeta('2460-FABLE-x.md', plan({ extra: '> 💰 **Cost forecast:** $0' }));
  assert.equal(m.batchHold, null);
});

test('selectEligible: a batch whose every member is held by IT and otherwise-eligible is reported runnable', () => {
  const r = selectEligible(
    [heldMeta({ id: 10, slug: 'batch-a' }), heldMeta({ id: 11, slug: 'batch-a' })],
    { landingHeld: false, batchRoster: [rosterEntry('batch-a', [10, 11])] },
  );
  assert.equal(r.reason, 'all_batch_held'); // exit code contract unchanged (decision D2)
  assert.equal(r.runnableBatches.length, 1);
  assert.equal(r.runnableBatches[0].slug, 'batch-a');
  assert.deepEqual(r.runnableBatches[0].members, ['10', '11']);
  assert.deepEqual(r.runnableBatches[0].memberSlugs, ['10-X-test', '11-X-test']);
  assert.equal(r.runnableBatches[0].seedWrite, 'no');
});

test('selectEligible: ONE member blocked underneath the hold withholds the whole batch', () => {
  const r = selectEligible(
    [
      heldMeta({ id: 10, slug: 'batch-a' }),
      heldMeta({ id: 11, slug: 'batch-a', otherwise: 'blocked' }),
    ],
    { landingHeld: false, batchRoster: [rosterEntry('batch-a', [10, 11])] },
  );
  assert.deepEqual(r.runnableBatches, []);
});

// A roster naming a member that has since archived/moved is stale — never a runnable
// train, and specifically never a train reported runnable off only the members that
// happen to still be in ready/.
test('selectEligible: a roster member absent from the ready/ pool withholds the batch', () => {
  const r = selectEligible([heldMeta({ id: 10, slug: 'batch-a' })], {
    landingHeld: false,
    batchRoster: [rosterEntry('batch-a', [10, 11])],
  });
  assert.deepEqual(r.runnableBatches, []);
});

// THE BUG THIS PINS: batch-paths.mjs resolves a double-listed id first-match-wins, so on
// a malformed roster only ONE batch actually holds the member. A bare `exclude === 'batch'`
// test would report BOTH batches runnable and let the loser's claim dissolve the winner.
test('selectEligible: a member held by a DIFFERENT batch does not make this batch runnable (double-listing tiebreak)', () => {
  const r = selectEligible(
    [heldMeta({ id: 10, slug: 'batch-a' }), heldMeta({ id: 11, slug: 'batch-a' })],
    {
      landingHeld: false,
      batchRoster: [rosterEntry('batch-a', [10, 11]), rosterEntry('batch-b', [11])],
    },
  );
  assert.deepEqual(
    r.runnableBatches.map((b) => b.slug),
    ['batch-a'],
  );
});

test('selectEligible: a 🟥 batch is withheld while a LANDING is held, and reported once it clears', () => {
  const metas = [
    heldMeta({ id: 10, slug: 'batch-a', seedWrite: 'yes' }),
    heldMeta({ id: 11, slug: 'batch-a' }),
  ];
  const roster = [rosterEntry('batch-a', [10, 11])];
  assert.deepEqual(
    selectEligible(metas, { landingHeld: true, batchRoster: roster }).runnableBatches,
    [],
  );
  const cleared = selectEligible(metas, { landingHeld: false, batchRoster: roster });
  assert.equal(cleared.runnableBatches.length, 1);
  assert.equal(cleared.runnableBatches[0].seedWrite, 'yes');
});

// seedLane off (a config-less / non-vetapp sibling): the mutex does not exist there, so a
// 🟥-bannered member must not withhold the train either — mirrors the candidate filter.
test('selectEligible: seedLane off — a 🟥 member neither withholds the batch nor stamps seedWrite yes', () => {
  const r = selectEligible(
    [
      heldMeta({ id: 10, slug: 'batch-a', seedWrite: 'yes' }),
      heldMeta({ id: 11, slug: 'batch-a' }),
    ],
    { landingHeld: true, seedLane: false, batchRoster: [rosterEntry('batch-a', [10, 11])] },
  );
  assert.equal(r.runnableBatches.length, 1);
  assert.equal(r.runnableBatches[0].seedWrite, 'no');
});

test('selectEligible: runnableBatches sort by smallest member id — the tiebreak the routine prompts specify', () => {
  const r = selectEligible(
    [
      heldMeta({ id: 30, slug: 'batch-late' }),
      heldMeta({ id: 31, slug: 'batch-late' }),
      heldMeta({ id: 12, slug: 'batch-early' }),
      heldMeta({ id: 40, slug: 'batch-early' }),
    ],
    {
      landingHeld: false,
      batchRoster: [rosterEntry('batch-late', [30, 31]), rosterEntry('batch-early', [12, 40])],
    },
  );
  assert.deepEqual(
    r.runnableBatches.map((b) => b.slug),
    ['batch-early', 'batch-late'],
  );
});

// The shape must be stable across BOTH return branches (same contract mutexDropped follows),
// so a consumer can read `.runnableBatches` without first branching on the exit code.
test('selectEligible: runnableBatches rides the SUCCESS shape too, and defaults to [] on every shape', () => {
  const withNext = selectEligible(
    [meta({ id: 9 }), heldMeta({ id: 10, slug: 'batch-a' }), heldMeta({ id: 11, slug: 'batch-a' })],
    { landingHeld: false, batchRoster: [rosterEntry('batch-a', [10, 11])] },
  );
  assert.equal(withNext.next.slug, '9-X-test');
  assert.equal(withNext.runnableBatches.length, 1);
  assert.deepEqual(selectEligible([meta({ id: 9 })], { landingHeld: false }).runnableBatches, []);
  assert.deepEqual(selectEligible([], { landingHeld: false }).runnableBatches, []);
  assert.deepEqual(
    selectEligible([meta({ id: 9, exclude: 'blocked' })], { landingHeld: false }).runnableBatches,
    [],
  );
});

// --- plan 1781: cloudExec axis + --cloud gating -------------------------------

// A plan body WITH a frontmatter block carrying an explicit cloudExec value
// (parsePlanMeta reads it from frontmatter only). `cloud` = 'true'|'false'|null.
function fmPlan({ cloud = null, extra = '' } = {}) {
  const fm = ['---', 'summary: test', ...(cloud === null ? [] : [`cloudExec: ${cloud}`]), '---'];
  return `${fm.join('\n')}\n\n> 🟩 **${MUTATION_BANNER_LABEL}: no** — test.\n\n# Test plan\n\n${extra}\n`;
}

test('parsePlanMeta: cloudExec is read from frontmatter (true/false/absent → normalized)', () => {
  assert.equal(parsePlanMeta('1000-X-t.md', fmPlan({ cloud: 'true' })).cloudExec, 'true');
  assert.equal(parsePlanMeta('1000-X-t.md', fmPlan({ cloud: 'false' })).cloudExec, 'false');
  assert.equal(parsePlanMeta('1000-X-t.md', fmPlan({ cloud: null })).cloudExec, null);
});

test('parsePlanMeta: off-cloud (default) NEVER cloud-excludes, whatever cloudExec says', () => {
  for (const c of ['true', 'false', null]) {
    const m = parsePlanMeta('1000-X-t.md', fmPlan({ cloud: c }));
    assert.notEqual(m.exclude, 'cloud');
  }
});

test('parsePlanMeta --cloud: only cloudExec:true is admitted; false and absent are excluded', () => {
  const yes = parsePlanMeta('1000-X-t.md', fmPlan({ cloud: 'true' }), { cloudOnly: true });
  assert.equal(yes.exclude, null);

  const no = parsePlanMeta('1000-X-t.md', fmPlan({ cloud: 'false' }), { cloudOnly: true });
  assert.equal(no.exclude, 'cloud');
  assert.match(no.excludeReason, /cloudExec: false/);

  const absent = parsePlanMeta('1000-X-t.md', fmPlan({ cloud: null }), { cloudOnly: true });
  assert.equal(absent.exclude, 'cloud');
  assert.match(absent.excludeReason, /unset/);
});

test('parsePlanMeta --cloud: the cloud gate fires FIRST, ahead of operator/blocked gates', () => {
  // A plan that is BOTH operator-gated AND not cloud-stamped reports the cloud reason.
  const body = fmPlan({ cloud: null, extra: 'Operator supplies the export first.' });
  const m = parsePlanMeta('1000-X-t.md', body, { cloudOnly: true });
  assert.equal(m.exclude, 'cloud');
});

test('selectEligible: all excluded by cloud only → all_not_cloud_eligible', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'cloud' }), meta({ id: 11, exclude: 'cloud' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_not_cloud_eligible');
});

test('selectEligible: a cloud+fable/stub mix reports all_fable_or_stub (all lifecycle gates)', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'cloud' }), meta({ id: 11, exclude: 'fable' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_fable_or_stub');
});

test('selectEligible: cloud mixed with a genuine blocked plan still reports all_blocked', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'cloud' }), meta({ id: 11, exclude: 'blocked' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_blocked');
});

// --- plan 1781: CLI-level --cloud end-to-end (main() + parseFlags + readReadyMetas) ---

// A minimal eligible ready/ plan body; cloud = 'true'|'false'|null controls the axis.
function cliPlanBody({ cloud = null } = {}) {
  const fm = [
    '---',
    'summary: cli test',
    ...(cloud === null ? [] : [`cloudExec: ${cloud}`]),
    '---',
  ];
  return `${fm.join('\n')}\n\n> 🟩 **${MUTATION_BANNER_LABEL}: no** — test.\n> 💰 **Cost forecast:** $0 — no LLM.\n\n# CLI test plan\n\nBody.\n`;
}

// Invoke the real CLI against a throwaway ready/ dir. --no-mutex avoids the board
// probe (which needs a repo); --ready puts main() in repo-less mode.
function runQueueDrain(readyDir, extraArgs = []) {
  try {
    const stdout = execFileSync(
      'node',
      [join(SCRIPTS_DIR, 'queue-drain.mjs'), '--ready', readyDir, '--no-mutex', ...extraArgs],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, json: JSON.parse(stdout) };
  } catch (e) {
    const stdout = e.stdout?.toString() ?? '';
    let json = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      /* non-JSON error */
    }
    return { code: e.status ?? 1, json, stderr: e.stderr?.toString() ?? '' };
  }
}

function withReadyDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qdrain-ready-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// plan 1819: readReadyMetas resolves the archive dir as the SIBLING of readyDir
// (`dirname(readyDir)/archive`) — mirror that layout with a throwaway `<root>/
// ready` + `<root>/archive` pair so the CLI end-to-end wiring (not just the pure
// parsePlanMeta call) is exercised.
function withPlansDirs(fn) {
  const root = mkdtempSync(join(tmpdir(), 'qdrain-plans-'));
  const readyDir = join(root, 'ready');
  const archiveDir = join(root, 'archive');
  mkdirSync(readyDir);
  mkdirSync(archiveDir);
  try {
    return fn({ readyDir, archiveDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A ready/ plan body carrying an explicit Blocked-by line (cliPlanBody has no
// Blocked-by hook — this is the archive-check-specific twin).
function blockedPlanBody(blockedBy) {
  return `> 🟩 **${MUTATION_BANNER_LABEL}: no** — test.\n> 💰 **Cost forecast:** $0 — no LLM.\n\n**Blocked-by:** ${blockedBy}\n\n# CLI test plan\n\nBody.\n`;
}

test('CLI: a ready/ plan Blocked-by naming an ARCHIVED-AND-SHIPPED plan is ELIGIBLE with staleBlockedBy in the JSON (plan 1819)', () => {
  withPlansDirs(({ readyDir, archiveDir }) => {
    writeFileSync(
      join(archiveDir, '1760-Other-upstream-thing.md'),
      '# archived upstream\n\n**Status:** ✅ COMPLETED — archived 2026-07-01 (done-worktree).\n',
    );
    writeFileSync(
      join(readyDir, '1790-Other-downstream.md'),
      blockedPlanBody('plan 1760 (in flight)'),
    );
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.next.slug, '1790-Other-downstream');
    assert.match(res.json.next.staleBlockedBy, /1760/);
    assert.match(res.json.next.staleBlockedBy, /archived/);
  });
});

// Review fix (plan 1819): archive/ holds plans that are "shipped OR closed" — a
// blocker archived WITHOUT shipping (superseded/abandoned, no ✅ COMPLETED stamp)
// must NOT be treated as a satisfied blocker.
//
// plan 2496: this stays excluded (unchanged from 1819), but now gets its OWN named
// reason (`blocker_archived_unshipped`) instead of the generic 'blocked' bucket a
// still-in-flight or nonexistent blocker also uses — the whole point of 2496 is that
// this class is distinguishable from those at selection time, not just excluded.
test('CLI: a ready/ plan Blocked-by naming an ARCHIVED-BUT-NOT-SHIPPED plan stays excluded, with its own named reason (plan 1819 review fix; reason named by plan 2496)', () => {
  withPlansDirs(({ readyDir, archiveDir }) => {
    writeFileSync(
      join(archiveDir, '1760-Other-upstream-thing.md'),
      '# archived upstream\n\n**Status:** 🗄️ SUPERSEDED by plan 1900 — folded in, not executed standalone.\n',
    );
    writeFileSync(
      join(readyDir, '1790-Other-downstream.md'),
      blockedPlanBody('plan 1760 (in flight)'),
    );
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.code, 1, `expected exit 1; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.reason, 'all_blocked');
    assert.equal(res.json.excluded[0].exclude, 'blocker_archived_unshipped');
    assert.match(res.json.excluded[0].reason, /1760/);
    assert.match(res.json.excluded[0].reason, /not.shipped|not-shipped/i);
  });
});

// Review fix (plan 1819): a multi-blocker line is stale only when EVERY named
// blocker has archived-and-shipped; a single still-open blocker must keep the
// whole line 'blocked' even though an earlier-named sibling already landed.
test('CLI: a ready/ plan Blocked-by naming TWO plans, only one archived, stays excluded (plan 1819 review fix)', () => {
  withPlansDirs(({ readyDir, archiveDir }) => {
    writeFileSync(
      join(archiveDir, '1055-Other-landed-thing.md'),
      '# archived, shipped\n\n**Status:** ✅ COMPLETED — archived 2026-07-01 (done-worktree).\n',
    );
    writeFileSync(
      join(readyDir, '1790-Other-downstream.md'),
      blockedPlanBody(
        'plan 1055 (SE national price re-extraction) and plan 1541 (NO+DK national price re-extraction)',
      ),
    );
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.code, 1, `expected exit 1; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.reason, 'all_blocked');
    assert.equal(res.json.excluded[0].exclude, 'blocked');
  });
});

test('CLI: a ready/ plan Blocked-by naming TWO plans, BOTH archived-and-shipped, is ELIGIBLE (plan 1819 review fix)', () => {
  withPlansDirs(({ readyDir, archiveDir }) => {
    writeFileSync(
      join(archiveDir, '1055-Other-landed-thing.md'),
      '# archived, shipped\n\n**Status:** ✅ COMPLETED — archived 2026-07-01 (done-worktree).\n',
    );
    writeFileSync(
      join(archiveDir, '1541-Other-also-landed.md'),
      '# archived, shipped\n\n**Status:** ✅ COMPLETED — archived 2026-07-02 (done-worktree).\n',
    );
    writeFileSync(
      join(readyDir, '1790-Other-downstream.md'),
      blockedPlanBody(
        'plan 1055 (SE national price re-extraction) and plan 1541 (NO+DK national price re-extraction)',
      ),
    );
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.next.slug, '1790-Other-downstream');
    assert.match(res.json.next.staleBlockedBy, /1055/);
    assert.match(res.json.next.staleBlockedBy, /1541/);
  });
});

// plan 2496 end-to-end: a real archive/ scan (readArchivedIds) partitioning into
// shipped + unshipped, wired all the way through readReadyMetas/the CLI — not just
// the pure parsePlanMeta unit above.
test('CLI: a ready/ plan Blocked-by naming TWO plans, one archived-shipped and one archived-but-NOT-shipped, gets blocker_archived_unshipped (plan 2496)', () => {
  withPlansDirs(({ readyDir, archiveDir }) => {
    writeFileSync(
      join(archiveDir, '1055-Other-landed-thing.md'),
      '# archived, shipped\n\n**Status:** ✅ COMPLETED — archived 2026-07-01 (done-worktree).\n',
    );
    writeFileSync(
      join(archiveDir, '1541-Other-superseded.md'),
      '# archived, not shipped\n\n**Status:** 🗄️ SUPERSEDED by plan 1900 — folded in, not executed standalone.\n',
    );
    writeFileSync(
      join(readyDir, '1790-Other-downstream.md'),
      blockedPlanBody(
        'plan 1055 (SE national price re-extraction) and plan 1541 (NO+DK national price re-extraction)',
      ),
    );
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.code, 1, `expected exit 1; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.reason, 'all_blocked');
    assert.equal(res.json.excluded[0].exclude, 'blocker_archived_unshipped');
    assert.match(res.json.excluded[0].reason, /1541/);
  });
});

test('CLI: a ready/ plan Blocked-by naming a plan NOT archived (still in flight) stays excluded — unchanged (plan 1819)', () => {
  withPlansDirs(({ readyDir }) => {
    // archiveDir exists but is empty — 1760 has NOT landed.
    writeFileSync(
      join(readyDir, '1790-Other-downstream.md'),
      blockedPlanBody('plan 1760 (in flight)'),
    );
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.code, 1, `expected exit 1; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.reason, 'all_blocked');
    assert.equal(res.json.excluded[0].exclude, 'blocked');
  });
});

test('CLI --cloud: selects the cloudExec:true plan and excludes the unstamped one (exit 0)', () => {
  withReadyDir((dir) => {
    writeFileSync(join(dir, '2000-Infra-cloud-safe.md'), cliPlanBody({ cloud: 'true' }));
    writeFileSync(join(dir, '2001-Infra-unstamped.md'), cliPlanBody({ cloud: null }));
    const res = runQueueDrain(dir, ['--cloud']);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.next.slug, '2000-Infra-cloud-safe');
    assert.equal(res.json.eligible.length, 1);
  });
});

test('CLI --cloud: a pool with no cloudExec:true plan exits 1 all_not_cloud_eligible', () => {
  withReadyDir((dir) => {
    writeFileSync(join(dir, '2001-Infra-unstamped.md'), cliPlanBody({ cloud: null }));
    writeFileSync(join(dir, '2002-Infra-false.md'), cliPlanBody({ cloud: 'false' }));
    const res = runQueueDrain(dir, ['--cloud']);
    assert.equal(res.code, 1, `expected exit 1; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.reason, 'all_not_cloud_eligible');
  });
});

test('CLI (no --cloud): the SAME pool is fully eligible — default path unchanged', () => {
  withReadyDir((dir) => {
    writeFileSync(join(dir, '2001-Infra-unstamped.md'), cliPlanBody({ cloud: null }));
    writeFileSync(join(dir, '2002-Infra-false.md'), cliPlanBody({ cloud: 'false' }));
    const res = runQueueDrain(dir, []);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.eligible.length, 2);
  });
});

// plan 2421 [1]: toItem() now carries the richer cloudExec enum on every eligible[] entry —
// the exact value /local-drain-filter.mjs's readCloudExecStamp would compute itself, so the
// filter can trust it without a second file read. Exercised end-to-end (real files, real CLI),
// not just the pure toItem() unit, since the value crosses a JSON.stringify/parse boundary.
test('CLI: eligible[] entries carry the richer cloudExec enum (true/false/unset/no-frontmatter)', () => {
  withReadyDir((dir) => {
    writeFileSync(join(dir, '2100-Infra-cloud-true.md'), cliPlanBody({ cloud: 'true' }));
    writeFileSync(join(dir, '2101-Infra-cloud-false.md'), cliPlanBody({ cloud: 'false' }));
    writeFileSync(join(dir, '2102-Infra-unstamped.md'), cliPlanBody({ cloud: null }));
    writeFileSync(
      join(dir, '2103-Infra-no-frontmatter.md'),
      '# no frontmatter block at all\n\nBody.\n',
    );
    const res = runQueueDrain(dir, []); // off-cloud: nothing excluded, all four are eligible
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    const bySlug = Object.fromEntries(res.json.eligible.map((e) => [e.slug, e.cloudExec]));
    assert.equal(bySlug['2100-Infra-cloud-true'], 'true');
    assert.equal(bySlug['2101-Infra-cloud-false'], 'false');
    assert.equal(bySlug['2102-Infra-unstamped'], 'unset');
    assert.equal(bySlug['2103-Infra-no-frontmatter'], 'no-frontmatter');
  });
});

test('CLI: an unknown flag is rejected (parseFlags), not silently swallowed', () => {
  withReadyDir((dir) => {
    writeFileSync(join(dir, '2000-Infra-x.md'), cliPlanBody({ cloud: 'true' }));
    const res = runQueueDrain(dir, ['--claod']); // typo of --cloud
    assert.equal(res.code, 2, `expected exit 2; stderr=${res.stderr ?? ''}`);
    assert.match(res.stderr ?? '', /unknown flag --claod/);
  });
});

// --- plan 1810: --lane fable — composable execModel-gate inversion -----------

test('parsePlanMeta fableLane: execModel: fable passes the (inverted) gate', () => {
  const m = parsePlanMeta(
    '1810-Infra-fable-shape.md',
    planFm(['execModel: fable', 'stage: specced']),
    { fableLane: true },
  );
  assert.equal(m.execModel, 'fable');
  assert.equal(m.exclude, null);
});

test('parsePlanMeta fableLane: execModel: sonnet is excluded as sonnet-lane', () => {
  const m = parsePlanMeta(
    '1811-Infra-sonnet-shape.md',
    planFm(['execModel: sonnet', 'stage: specced']),
    { fableLane: true },
  );
  assert.equal(m.exclude, 'sonnet-lane');
  assert.match(m.excludeReason, /execModel: sonnet/);
});

test('parsePlanMeta fableLane: absent execModel (grandfathered sonnet) is excluded as sonnet-lane', () => {
  const m = parsePlanMeta('1812-Infra-legacy.md', planFm(['stage: specced']), {
    fableLane: true,
  });
  assert.equal(m.execModel, null);
  assert.equal(m.exclude, 'sonnet-lane');
});

test('parsePlanMeta fableLane: a fable stub with no specReview is STILL excluded as stub — the stage gate is not bypassed', () => {
  const m = parsePlanMeta('1813-Infra-fable-stub.md', planFm(['execModel: fable', 'stage: stub']), {
    fableLane: true,
  });
  assert.equal(m.exclude, 'stub');
  assert.match(m.excludeReason, /spec-pass/);
});

test('parsePlanMeta fableLane: operator-gating still takes precedence over the lane gate', () => {
  const m = parsePlanMeta(
    '1814-Infra-fable-operator.md',
    planFm(['execModel: sonnet', 'stage: specced'], 'Operator supplies the export first.'),
    { fableLane: true },
  );
  assert.equal(m.exclude, 'operator');
});

test('parsePlanMeta: default (fableLane omitted/false) is byte-identical to pre-1810 — fable excluded, sonnet eligible', () => {
  const fable = parsePlanMeta(
    '1815-Infra-fable.md',
    planFm(['execModel: fable', 'stage: specced']),
  );
  assert.equal(fable.exclude, 'fable');
  const sonnet = parsePlanMeta(
    '1816-Infra-sonnet.md',
    planFm(['execModel: sonnet', 'stage: specced']),
  );
  assert.equal(sonnet.exclude, null);
});

test('selectEligible: a fable-lane ready/ pair (one fable, one sonnet) drains only the fable one', () => {
  const fable = parsePlanMeta(
    '1817-Infra-fable-plan.md',
    planFm(['execModel: fable', 'stage: specced']),
    { fableLane: true },
  );
  const sonnet = parsePlanMeta(
    '1818-Infra-sonnet-plan.md',
    planFm(['execModel: sonnet', 'stage: specced']),
    { fableLane: true },
  );
  const r = selectEligible([fable, sonnet], { landingHeld: false });
  assert.equal(r.next.slug, '1817-Infra-fable-plan');
  assert.equal(r.eligible.length, 1);
  assert.equal(r.excluded.length, 1);
  assert.equal(r.excluded[0].slug, '1818-Infra-sonnet-plan');
  assert.equal(r.excluded[0].exclude, 'sonnet-lane');
});

test('selectEligible: a fable-lane pool holding only sonnet-lane plans → all_fable_or_stub (not all_blocked)', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'sonnet-lane' }), meta({ id: 11, exclude: 'sonnet-lane' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_fable_or_stub');
});

test('selectEligible: sonnet-lane mixed with fable/stub/cloud still reports all_fable_or_stub', () => {
  const r = selectEligible(
    [
      meta({ id: 10, exclude: 'sonnet-lane' }),
      meta({ id: 11, exclude: 'fable' }),
      meta({ id: 12, exclude: 'stub' }),
      meta({ id: 13, exclude: 'cloud' }),
    ],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_fable_or_stub');
});

test('selectEligible: sonnet-lane mixed with a genuine cross-plan block still reports all_blocked', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'sonnet-lane' }), meta({ id: 11, exclude: 'blocked' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_blocked');
});

// A fable-lane-shaped ready/ plan body for the CLI end-to-end tests below.
// `env` (plan 1925) adds a `cloudEnv:` frontmatter key when non-null.
function cliFableLaneBody({ execModel = null, stage = 'specced', cloud = null, env = null } = {}) {
  const fm = [
    '---',
    'summary: cli fable-lane test',
    ...(execModel === null ? [] : [`execModel: ${execModel}`]),
    `stage: ${stage}`,
    ...(cloud === null ? [] : [`cloudExec: ${cloud}`]),
    ...(env === null ? [] : [`cloudEnv: ${env}`]),
    '---',
  ];
  return `${fm.join('\n')}\n\n> 🟩 **${MUTATION_BANNER_LABEL}: no** — test.\n> 💰 **Cost forecast:** $0 — no LLM.\n\n# CLI fable-lane test plan\n\nBody.\n`;
}

test('CLI --lane fable: selects only the execModel:fable plan, excludes the sonnet one', () => {
  withReadyDir((dir) => {
    writeFileSync(join(dir, '2010-Infra-fable.md'), cliFableLaneBody({ execModel: 'fable' }));
    writeFileSync(join(dir, '2011-Infra-sonnet.md'), cliFableLaneBody({ execModel: 'sonnet' }));
    const res = runQueueDrain(dir, ['--lane', 'fable']);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.next.slug, '2010-Infra-fable');
    assert.equal(res.json.eligible.length, 1);
    assert.equal(res.json.excluded[0].exclude, 'sonnet-lane');
  });
});

test('CLI --cloud --lane fable: composes both gates — only cloudExec:true AND execModel:fable survives', () => {
  withReadyDir((dir) => {
    writeFileSync(
      join(dir, '2012-Infra-fable-cloud.md'),
      cliFableLaneBody({ execModel: 'fable', cloud: 'true' }),
    );
    writeFileSync(
      join(dir, '2013-Infra-fable-nocloud.md'),
      cliFableLaneBody({ execModel: 'fable', cloud: null }),
    );
    writeFileSync(
      join(dir, '2014-Infra-sonnet-cloud.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true' }),
    );
    const res = runQueueDrain(dir, ['--cloud', '--lane', 'fable']);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.next.slug, '2012-Infra-fable-cloud');
    assert.equal(res.json.eligible.length, 1);
  });
});

test('CLI --lane fable: a pool with no fable plan exits 1 all_fable_or_stub', () => {
  withReadyDir((dir) => {
    writeFileSync(join(dir, '2015-Infra-sonnet.md'), cliFableLaneBody({ execModel: 'sonnet' }));
    const res = runQueueDrain(dir, ['--lane', 'fable']);
    assert.equal(res.code, 1, `expected exit 1; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.reason, 'all_fable_or_stub');
  });
});

test('CLI (no --lane): the SAME fable/sonnet pool selects only the sonnet plan — default unchanged', () => {
  withReadyDir((dir) => {
    writeFileSync(join(dir, '2010-Infra-fable.md'), cliFableLaneBody({ execModel: 'fable' }));
    writeFileSync(join(dir, '2011-Infra-sonnet.md'), cliFableLaneBody({ execModel: 'sonnet' }));
    const res = runQueueDrain(dir, []);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.next.slug, '2011-Infra-sonnet');
    assert.equal(res.json.excluded[0].exclude, 'fable');
  });
});

test('CLI --lane: an unsupported value is rejected with a clear error, not silently swallowed', () => {
  withReadyDir((dir) => {
    writeFileSync(join(dir, '2000-Infra-x.md'), cliPlanBody({ cloud: 'true' }));
    const res = runQueueDrain(dir, ['--lane', 'sonnet']);
    assert.equal(res.code, 2, `expected exit 2; stderr=${res.stderr ?? ''}`);
    assert.match(res.stderr ?? '', /unsupported --lane value/);
  });
});

// --- plan 2387: CLOUD_ENV_LANES — the LANE side of the admission gate, tabled ---
// (the other half of plan 2323's CLOUD_ENV_RUNGS table: adding a hypothetical
// intermediate lane is one row here, no edit to cloudEnvLaneRank or the CLI's
// --env validation — both derive from this table.)

test('CLOUD_ENV_LANES: the two legal --env CLI values, ranked (trusted is the implicit rank-0 floor, not a row)', () => {
  assert.deepEqual(CLOUD_ENV_LANES, [
    { value: 'full', rank: 1 },
    { value: 'browser', rank: Infinity },
  ]);
});

test('CLOUD_ENV_LANES: browser ranks Infinity, not a literal max-of-today number — it must admit a hypothetical rung ranked ABOVE every rung in CLOUD_ENV_RUNGS today, with no edit to this table', () => {
  const browser = CLOUD_ENV_LANES.find((l) => l.value === 'browser');
  const highestRungRankToday = Math.max(...CLOUD_ENV_RUNGS.map((r) => r.rank));
  assert.ok(
    browser.rank > highestRungRankToday,
    "browser lane rank must outrank every existing CLOUD_ENV_RUNGS row, not merely equal today's max",
  );
});

test('CLI --env: the unsupported-value error message is table-driven, not hardcoded — it names every CLOUD_ENV_LANES value', () => {
  withReadyDir((dir) => {
    writeFileSync(join(dir, '2048-Infra-x.md'), cliPlanBody({ cloud: 'true' }));
    const res = runQueueDrain(dir, ['--cloud', '--env', 'bogus']);
    assert.equal(res.code, 2, `expected exit 2; stderr=${res.stderr ?? ''}`);
    for (const l of CLOUD_ENV_LANES) {
      assert.match(res.stderr ?? '', new RegExp(`"${l.value}"`));
    }
  });
});

// --- plan 1925 / 2003: --env full — the cloudEnv environment-routing axis ------
// (plan 2003: the full lane is a SUPERSET — it excludes nothing on the cloudEnv
// axis and admits both cloudEnv: full AND trusted/absent plans; only the trusted
// lane still excludes cloudEnv: full. The old 'trusted-env' exclusion is retired.)

test('parsePlanMeta cloudOnly: cloudEnv: full is excluded as full-env from the default (trusted) pool', () => {
  const m = parsePlanMeta(
    '1925-Infra-full-shape.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: full']),
    { cloudOnly: true },
  );
  assert.equal(m.cloudEnv, 'full');
  assert.equal(m.exclude, 'full-env');
  assert.match(m.excludeReason, /Full-egress environment/);
});

test('parsePlanMeta cloudOnly: absent cloudEnv reads as trusted — eligible in the default pool (pre-1925 unchanged)', () => {
  const m = parsePlanMeta(
    '1926-Infra-trusted-shape.md',
    planFm(['stage: specced', 'cloudExec: true']),
    { cloudOnly: true },
  );
  assert.equal(m.cloudEnv, null);
  assert.equal(m.exclude, null);
});

test('parsePlanMeta cloudOnly+fullEnv: cloudEnv: full is eligible in the full lane', () => {
  const m = parsePlanMeta(
    '1927-Infra-full-lane.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: full']),
    { cloudOnly: true, lane: 'full' },
  );
  assert.equal(m.exclude, null);
});

test('parsePlanMeta cloudOnly+fullEnv: absent cloudEnv (trusted) is ELIGIBLE in the full superset lane (plan 2003 — was trusted-env)', () => {
  const m = parsePlanMeta(
    '1928-Infra-trusted-in-full.md',
    planFm(['stage: specced', 'cloudExec: true']),
    { cloudOnly: true, lane: 'full' },
  );
  assert.equal(m.exclude, null);
});

test('parsePlanMeta cloudOnly+fullEnv: an explicit cloudEnv: trusted is ELIGIBLE too (plan 2003 — the full lane is a superset)', () => {
  const m = parsePlanMeta(
    '1929-Infra-explicit-trusted.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: trusted']),
    { cloudOnly: true, lane: 'full' },
  );
  assert.equal(m.exclude, null);
});

test('parsePlanMeta cloudOnly+fullEnv: cloudExec unset/false still excludes as cloud FIRST — the safety gate precedes env routing', () => {
  const unstamped = parsePlanMeta(
    '1930-Infra-unstamped.md',
    planFm(['stage: specced', 'cloudEnv: full']),
    { cloudOnly: true, lane: 'full' },
  );
  assert.equal(unstamped.exclude, 'cloud');
  const falseStamped = parsePlanMeta(
    '1931-Infra-false.md',
    planFm(['stage: specced', 'cloudExec: false', 'cloudEnv: full']),
    { cloudOnly: true, lane: 'full' },
  );
  assert.equal(falseStamped.exclude, 'cloud');
});

test('parsePlanMeta: fullEnv is INERT without cloudOnly — a local drain reads the unchanged full pool', () => {
  const m = parsePlanMeta(
    '1932-Infra-local.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: full']),
    { lane: 'full' },
  );
  assert.equal(m.exclude, null);
});

test('parsePlanMeta (no cloudOnly): a cloudEnv: full plan stays eligible locally', () => {
  const m = parsePlanMeta(
    '1933-Infra-local-default.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: full']),
  );
  assert.equal(m.cloudEnv, 'full');
  assert.equal(m.exclude, null);
});

test('parsePlanMeta cloudOnly+fullEnv: a full-env stub with no specReview is STILL excluded as stub — the stage gate is not bypassed', () => {
  const m = parsePlanMeta(
    '1934-Infra-full-stub.md',
    planFm(['stage: stub', 'cloudExec: true', 'cloudEnv: full']),
    { cloudOnly: true, lane: 'full' },
  );
  assert.equal(m.exclude, 'stub');
});

test('selectEligible: a trusted pool excluded only by full-env routing → all_fable_or_stub (not all_blocked)', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'full-env' }), meta({ id: 11, exclude: 'full-env' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_fable_or_stub');
});

test('CLI --cloud (default): excludes the cloudEnv: full plan as full-env, selects the trusted one', () => {
  withReadyDir((dir) => {
    writeFileSync(
      join(dir, '2020-Infra-full.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true', env: 'full' }),
    );
    writeFileSync(
      join(dir, '2021-Infra-trusted.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true' }),
    );
    const res = runQueueDrain(dir, ['--cloud']);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.next.slug, '2021-Infra-trusted');
    assert.equal(res.json.eligible.length, 1);
    assert.equal(res.json.excluded[0].exclude, 'full-env');
  });
});

test('CLI --cloud --env full: SUPERSET — admits BOTH the cloudEnv: full and the trusted plan (plan 2003)', () => {
  withReadyDir((dir) => {
    writeFileSync(
      join(dir, '2020-Infra-full.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true', env: 'full' }),
    );
    writeFileSync(
      join(dir, '2021-Infra-trusted.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true' }),
    );
    const res = runQueueDrain(dir, ['--cloud', '--env', 'full']);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    // both are eligible now; the trusted plan is NO LONGER excluded as trusted-env
    assert.equal(res.json.eligible.length, 2);
    assert.equal(res.json.excluded.length, 0);
    const eligibleSlugs = res.json.eligible.map((e) => e.slug).sort();
    assert.deepEqual(eligibleSlugs, ['2020-Infra-full', '2021-Infra-trusted']);
  });
});

test('CLI --cloud --env full --lane fable: SUPERSET — picks fable plans of BOTH env kinds, excludes only the sonnet one (plan 2003)', () => {
  withReadyDir((dir) => {
    writeFileSync(
      join(dir, '2022-Infra-fable-full.md'),
      cliFableLaneBody({ execModel: 'fable', cloud: 'true', env: 'full' }),
    );
    writeFileSync(
      join(dir, '2023-Infra-sonnet-full.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true', env: 'full' }),
    );
    writeFileSync(
      join(dir, '2024-Infra-fable-trusted.md'),
      cliFableLaneBody({ execModel: 'fable', cloud: 'true' }),
    );
    const res = runQueueDrain(dir, ['--cloud', '--env', 'full', '--lane', 'fable']);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    // both fable plans (full AND trusted env) survive; the sonnet plan is excluded as sonnet-lane
    assert.equal(res.json.eligible.length, 2);
    const eligibleSlugs = res.json.eligible.map((e) => e.slug).sort();
    assert.deepEqual(eligibleSlugs, ['2022-Infra-fable-full', '2024-Infra-fable-trusted']);
    assert.equal(res.json.excluded[0].exclude, 'sonnet-lane');
  });
});

test('CLI --cloud --env full: an UNSTAMPED-only pool still exits 1 all_not_cloud_eligible — the superset lane keeps the cloudExec gate', () => {
  withReadyDir((dir) => {
    // no cloudExec stamp → excluded as `cloud` before env routing is ever consulted
    writeFileSync(join(dir, '2025-Infra-unstamped.md'), cliFableLaneBody({ execModel: 'sonnet' }));
    const res = runQueueDrain(dir, ['--cloud', '--env', 'full']);
    assert.equal(res.code, 1, `expected exit 1; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.reason, 'all_not_cloud_eligible');
  });
});

test('CLI --env without --cloud is rejected with a clear error', () => {
  withReadyDir((dir) => {
    writeFileSync(join(dir, '2026-Infra-x.md'), cliPlanBody({ cloud: 'true' }));
    const res = runQueueDrain(dir, ['--env', 'full']);
    assert.equal(res.code, 2, `expected exit 2; stderr=${res.stderr ?? ''}`);
    assert.match(res.stderr ?? '', /--env requires --cloud/);
  });
});

test('CLI --env: an unsupported value is rejected with a clear error', () => {
  withReadyDir((dir) => {
    writeFileSync(join(dir, '2027-Infra-x.md'), cliPlanBody({ cloud: 'true' }));
    const res = runQueueDrain(dir, ['--cloud', '--env', 'trusted']);
    assert.equal(res.code, 2, `expected exit 2; stderr=${res.stderr ?? ''}`);
    assert.match(res.stderr ?? '', /unsupported --env value/);
  });
});

// --- plan 2250: --env browser — the cloudEnv: browser superset rung -----------
// (one level above `full`: needs verified live headless-Chromium egress, which the
// 2241 evidence shows a Full-egress environment does NOT establish on its own —
// `fullEnv` alone must never satisfy this gate.)

test('parsePlanMeta cloudOnly: cloudEnv: browser is excluded as browser-env from the default (trusted) pool', () => {
  const m = parsePlanMeta(
    '2250-Infra-browser-shape.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: browser']),
    { cloudOnly: true },
  );
  assert.equal(m.cloudEnv, 'browser');
  assert.equal(m.exclude, 'browser-env');
  assert.match(m.excludeReason, /verified live headless-Chromium egress/);
});

test('parsePlanMeta cloudOnly+fullEnv: cloudEnv: browser is STILL excluded — fullEnv alone does not satisfy it (the 2241 lesson)', () => {
  const m = parsePlanMeta(
    '2251-Infra-browser-in-full.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: browser']),
    { cloudOnly: true, lane: 'full' },
  );
  assert.equal(m.exclude, 'browser-env');
});

test('parsePlanMeta cloudOnly+browserEnv: cloudEnv: browser is eligible in the browser lane', () => {
  const m = parsePlanMeta(
    '2252-Infra-browser-lane.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: browser']),
    { cloudOnly: true, lane: 'browser' },
  );
  assert.equal(m.exclude, null);
});

test('parsePlanMeta cloudOnly+browserEnv: cloudEnv: full is ALSO eligible — browser is a superset of full', () => {
  const m = parsePlanMeta(
    '2253-Infra-full-in-browser.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: full']),
    { cloudOnly: true, lane: 'browser' },
  );
  assert.equal(m.exclude, null);
});

test('parsePlanMeta cloudOnly+browserEnv: absent cloudEnv (trusted) is ALSO eligible — browser is top of the superset ladder', () => {
  const m = parsePlanMeta(
    '2254-Infra-trusted-in-browser.md',
    planFm(['stage: specced', 'cloudExec: true']),
    { cloudOnly: true, lane: 'browser' },
  );
  assert.equal(m.exclude, null);
});

test('parsePlanMeta: browserEnv is INERT without cloudOnly — a local drain reads the unchanged full pool', () => {
  const m = parsePlanMeta(
    '2255-Infra-local-browser.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: browser']),
    { lane: 'browser' },
  );
  assert.equal(m.exclude, null);
});

test('selectEligible: a pool excluded only by browser-env routing → all_fable_or_stub (not all_blocked)', () => {
  const r = selectEligible(
    [meta({ id: 10, exclude: 'browser-env' }), meta({ id: 11, exclude: 'browser-env' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_fable_or_stub');
});

test('CLI --cloud (default): excludes the cloudEnv: browser plan as browser-env, selects the trusted one', () => {
  withReadyDir((dir) => {
    writeFileSync(
      join(dir, '2030-Infra-browser.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true', env: 'browser' }),
    );
    writeFileSync(
      join(dir, '2031-Infra-trusted.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true' }),
    );
    const res = runQueueDrain(dir, ['--cloud']);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.next.slug, '2031-Infra-trusted');
    assert.equal(res.json.eligible.length, 1);
    assert.equal(res.json.excluded[0].exclude, 'browser-env');
  });
});

test('CLI --cloud --env full: still excludes the cloudEnv: browser plan — full does not subsume browser', () => {
  withReadyDir((dir) => {
    writeFileSync(
      join(dir, '2032-Infra-browser.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true', env: 'browser' }),
    );
    writeFileSync(
      join(dir, '2033-Infra-full.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true', env: 'full' }),
    );
    const res = runQueueDrain(dir, ['--cloud', '--env', 'full']);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.next.slug, '2033-Infra-full');
    assert.equal(res.json.eligible.length, 1);
    assert.equal(res.json.excluded[0].exclude, 'browser-env');
  });
});

test('CLI --cloud --env browser: SUPERSET — admits browser, full, AND trusted plans all at once', () => {
  withReadyDir((dir) => {
    writeFileSync(
      join(dir, '2034-Infra-browser.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true', env: 'browser' }),
    );
    writeFileSync(
      join(dir, '2035-Infra-full.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true', env: 'full' }),
    );
    writeFileSync(
      join(dir, '2036-Infra-trusted.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true' }),
    );
    const res = runQueueDrain(dir, ['--cloud', '--env', 'browser']);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.eligible.length, 3);
    assert.equal(res.json.excluded.length, 0);
    const eligibleSlugs = res.json.eligible.map((e) => e.slug).sort();
    assert.deepEqual(eligibleSlugs, [
      '2034-Infra-browser',
      '2035-Infra-full',
      '2036-Infra-trusted',
    ]);
  });
});

test('CLI --cloud --env browser --lane fable: composes with the fable-lane gate too', () => {
  withReadyDir((dir) => {
    writeFileSync(
      join(dir, '2037-Infra-fable-browser.md'),
      cliFableLaneBody({ execModel: 'fable', cloud: 'true', env: 'browser' }),
    );
    writeFileSync(
      join(dir, '2038-Infra-sonnet-browser.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true', env: 'browser' }),
    );
    const res = runQueueDrain(dir, ['--cloud', '--env', 'browser', '--lane', 'fable']);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.eligible.length, 1);
    assert.equal(res.json.eligible[0].slug, '2037-Infra-fable-browser');
    assert.equal(res.json.excluded[0].exclude, 'sonnet-lane');
  });
});

// ── plan 2034: drain exclusion of waiting-grill/ ─────────────────────────────
// The drain's ONLY filesystem read of plan bodies is readdirSync(readyDir) inside
// readReadyMetas — a plan parked in waiting-grill/ (or any sibling lane) is invisible
// to it by construction. This pins that: a plans tree holding one ready/ plan and one
// waiting-grill/ plan yields exactly the ready/ meta, so the grill lane can never be
// auto-drained with its questions unanswered.
test('readReadyMetas: a waiting-grill/ plan is invisible to the drain (plan 2034)', () => {
  const root = mkdtempSync(join(tmpdir(), 'qd-grill-'));
  try {
    const readyDir = join(root, 'ready');
    mkdirSync(readyDir, { recursive: true });
    mkdirSync(join(root, 'waiting-grill'), { recursive: true });
    writeFileSync(
      join(readyDir, '900-Other-ok.md'),
      plan({ extra: '**Blocked-by:** none\n\n> 💰 **Cost forecast:** $0' }),
    );
    writeFileSync(
      join(root, 'waiting-grill', '901-Other-grilled.md'),
      plan({ extra: '## Grill questions\n\n1. Q?\n' }),
    );
    const metas = readReadyMetas(readyDir, { source: 'tree' });
    assert.equal(metas.length, 1, `expected only the ready/ plan, got: ${JSON.stringify(metas)}`);
    assert.match(String(metas[0].slug ?? metas[0].id), /900/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── plan 2459 Task 2: readReadyMetas end-to-end batch-hold wiring ────────────
// Batches live TWO levels up from ready/ (…/plans/ready → …/plans → …/superpowers/
// {plans,batches}) — mirror that exact nesting so the real batchesDir derivation
// (not just the pure parsePlanMeta call above) is exercised.

function withSuperpowersDirs(fn) {
  const root = mkdtempSync(join(tmpdir(), 'qdrain-super-'));
  const readyDir = join(root, 'plans', 'ready');
  const batchesDir = join(root, 'batches');
  mkdirSync(readyDir, { recursive: true });
  mkdirSync(batchesDir, { recursive: true });
  try {
    return fn({ root, readyDir, batchesDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeBatchMdFixture(batchesDir, slug, { members, gate = null, status = 'proposed' }) {
  const dir = join(batchesDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'batch.md'),
    [
      '---',
      `slug: ${slug}`,
      'lane: 🟩',
      `members: [${members.join(', ')}]`,
      `gate: ${gate == null ? 'null' : gate}`,
      `status: ${status}`,
      '---',
      '',
      `# ${slug}`,
      '',
      'Test batch.',
      '',
    ].join('\n'),
  );
}

test('readReadyMetas: a member of a runnable batch is excluded as batch, naming the slug + both legal moves (plan 2459 Task 2)', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-x', { members: ['2460'] });
    writeFileSync(
      join(readyDir, '2460-Infra-held.md'),
      plan({ extra: '> 💰 **Cost forecast:** $0' }),
    );
    const metas = readReadyMetas(readyDir, { source: 'tree' });
    assert.equal(metas.length, 1);
    assert.equal(metas[0].exclude, 'batch');
    assert.match(metas[0].excludeReason, /batch-x/);
    assert.match(metas[0].excludeReason, /claim-plan\.mjs batch/);
    assert.match(metas[0].excludeReason, /--override-batch-solo/);
  });
});

test('readReadyMetas: a gate:non-null batch never excludes its members (plan 2459 item 5)', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-gated', { members: ['2461'], gate: 'plan 2000 lands' });
    writeFileSync(
      join(readyDir, '2461-Infra-free.md'),
      plan({ extra: '> 💰 **Cost forecast:** $0' }),
    );
    const metas = readReadyMetas(readyDir, { source: 'tree' });
    assert.equal(metas.length, 1);
    assert.equal(metas[0].exclude, null);
  });
});

// The "known live edge case" plan 2459 pins: batch-claim-projection's real members are
// [2459, 2460] — 2459 (this very plan) is already in-progress/ (claimed via the normal
// pickup, not solo-claimable again anyway), 2460 still sits in ready/. The guard must
// still refuse 2460 solo, naming batch-claim-projection, even though its co-member is
// already gone from ready/.
test('readReadyMetas: batch-claim-projection shape — the still-ready co-member is refused even though its sibling already claimed', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-claim-projection', { members: ['2459', '2460'] });
    writeFileSync(
      join(readyDir, '2460-FABLE-other-half.md'),
      plan({ extra: '> 💰 **Cost forecast:** $0' }),
    );
    const metas = readReadyMetas(readyDir, { source: 'tree' });
    assert.equal(metas.length, 1);
    assert.equal(metas[0].exclude, 'batch');
    assert.match(metas[0].excludeReason, /batch-claim-projection/);
  });
});

// Stale-roster safety (plan 2459 item 6): a roster whose members have ALL long since
// archived must never refuse an UNRELATED ready/ plan — this holds by construction
// (readReadyMetas only ever consults the map for ids it is actually scanning in ready/).
test('readReadyMetas: a stale roster (members not in ready/ at all) excludes nothing — never refuses an unrelated plan', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-coord-smalls', { members: ['2421'] }); // long since landed
    writeFileSync(
      join(readyDir, '2500-Other-unrelated.md'),
      plan({ extra: '> 💰 **Cost forecast:** $0' }),
    );
    const metas = readReadyMetas(readyDir, { source: 'tree' });
    assert.equal(metas.length, 1);
    assert.equal(metas[0].exclude, null);
  });
});

// ── plan 3816: readReadyMetas source axis (origin default, tree explicit opt-in) ───────────
// CLAUDE.md § Coordination: "Fetch before judging a plan landed/blocked or a queue slot free:
// reason about origin/master, not drifting local refs" — applied to `readReadyMetas` the way
// plan 3247 already applied it to the in-progress/ read (readPlanContentFromOrigin above).

test('readReadyMetas: source "origin" (the default) throws without a repoRoot — the fixture escape hatch is explicit `source: "tree"`, never a silent origin no-op', () => {
  assert.throws(() => readReadyMetas('/some/ready/dir'), /requires repoRoot/);
});

// One `git cat-file --batch` stream builder — mirrors in-progress-board.test.mjs's own helper of
// the same name (that file's listPlansFromOrigin parses the identical byte-offset stream shape),
// ported here rather than imported since the two test files carry no import relationship.
function catFileStream(objects) {
  return Buffer.concat(
    objects.map((body) => {
      const buf = Buffer.from(body, 'utf8');
      return Buffer.concat([
        Buffer.from(`deadbeef blob ${buf.length}\n`, 'utf8'),
        buf,
        Buffer.from('\n', 'utf8'),
      ]);
    }),
  );
}

test('readReadyMetas: source "origin" fetches ONCE, resolves ONE commit sha via `rev-parse`, lists via ONE `ls-tree` PINNED TO THAT SHA (blob shas, NOT --name-only, NOT the mutable origin/master name), and reads ALL ready/ content via ONE `cat-file --batch` — never a per-file listing or a per-file git-show (plan 3816 fix round 1 Fix 1, fix round 2 Fix A)', () => {
  const calls = [];
  const lsTreeTargets = [];
  const RESOLVED_SHA = 'deadbeefcafe0000000000000000000000000000';
  const metas = readReadyMetas('/repo/docs/superpowers/plans/ready', {
    source: 'origin',
    repoRoot: '/repo',
    _exec: (cmd, args, opts) => {
      assert.equal(cmd, 'git');
      calls.push(args[2]); // args: ['-C', repoRoot, <subcommand>, ...]
      if (args[2] === 'ls-tree') lsTreeTargets.push(args[args.length - 1]);
      if (args[2] === 'fetch') return '';
      if (args[2] === 'rev-parse') {
        assert.deepEqual(args.slice(2), ['rev-parse', 'origin/master']);
        return RESOLVED_SHA + '\n';
      }
      if (args[2] === 'ls-tree') {
        assert.ok(
          !args.includes('--name-only'),
          'FIX 1: blob shas are required, not bare paths — --name-only must be gone',
        );
        assert.equal(
          args[4],
          RESOLVED_SHA,
          'FIX A: ls-tree must be pinned to the resolved COMMIT SHA, never the mutable ' +
            '"origin/master" ref name',
        );
        return (
          '100644 blob aaa\tdocs/superpowers/plans/ready/900-Other-ok.md\n' +
          '100644 blob bbb\tdocs/superpowers/plans/ready/infra/901-Infra-other.md\n'
        );
      }
      if (args[2] === 'cat-file') {
        assert.deepEqual(args.slice(2), ['cat-file', '--batch']);
        assert.equal(opts.input, 'aaa\nbbb\n', 'both shas fed to ONE batch call, ls-tree order');
        return catFileStream([
          plan({ extra: '> 💰 **Cost forecast:** $0' }),
          plan({ extra: '> 💰 **Cost forecast:** $1' }),
        ]);
      }
      throw new Error(`unexpected: git ${args.join(' ')}`);
    },
  });
  assert.equal(calls.filter((c) => c === 'fetch').length, 1, 'exactly one fetch per call');
  assert.equal(
    calls.filter((c) => c === 'rev-parse').length,
    1,
    'exactly one commit-sha resolve per call (Fix A)',
  );
  // plan 4246 review fix (b35525): the batch roster is now ALSO read at the resolved sha — one
  // more ls-tree, of the batches dir, pinned to the same RESOLVED_SHA (the mock's ls-tree branch
  // asserts that for every listing). Its (mock) listing names no batch folder, so it reads no
  // batch.md and adds no cat-file call.
  assert.deepEqual(
    lsTreeTargets,
    ['docs/superpowers/plans/ready', 'docs/superpowers/batches/'],
    'exactly one ready/ listing (never one per ready/ file), plus one roster listing',
  );
  assert.equal(
    calls.filter((c) => c === 'cat-file').length,
    1,
    'exactly one cat-file --batch call, never one per ready/ file',
  );
  assert.equal(
    calls.length,
    5,
    'N ready/ files still produce a FIXED call count (4 + the roster listing), not 3+N',
  );
  assert.equal(metas.length, 2);
  const flat = metas.find((m) => m.slug === '900-Other-ok');
  const nested = metas.find((m) => m.slug === '901-Infra-other');
  assert.equal(flat.category, null, 'a flat ready/ file carries no category');
  assert.equal(
    nested.category,
    'infra',
    'a one-level category subfolder (plan 2678) is derived off origin exactly as it is locally',
  );
  // Content comes back correctly ALIGNED per file (flat=$0, nested=$1 — never swapped).
  assert.equal(flat.cost.usd, 0);
  assert.equal(nested.cost.usd, 1);
});

test('readReadyMetas: source "origin" — the fetch, rev-parse, ls-tree and cat-file calls all carry a 15000ms timeout (Fix F)', () => {
  const seenOpts = {};
  readReadyMetas('/repo/docs/superpowers/plans/ready', {
    source: 'origin',
    repoRoot: '/repo',
    _exec: (cmd, args, opts) => {
      seenOpts[args[2]] = opts;
      if (args[2] === 'fetch') return '';
      if (args[2] === 'rev-parse') return 'deadbeefcafe0000000000000000000000000000\n';
      if (args[2] === 'ls-tree') {
        return '100644 blob aaa\tdocs/superpowers/plans/ready/900-Other-ok.md\n';
      }
      if (args[2] === 'cat-file') {
        return catFileStream([plan({ extra: '> 💰 **Cost forecast:** $0' })]);
      }
      throw new Error(`unexpected: git ${args.join(' ')}`);
    },
  });
  for (const sub of ['fetch', 'rev-parse', 'ls-tree', 'cat-file']) {
    assert.equal(
      seenOpts[sub]?.timeout,
      15000,
      `Fix F: git ${sub} must carry a 15000ms bound so a hung call cannot hang the oracle forever`,
    );
  }
});

// ── plan 3816 fix round 2, Fix A: readReadyMetas exposes which commit it read via onSnapshot ──
test('readReadyMetas: source "origin" invokes onSnapshot ONCE with the resolved commit sha and fetchFailed:false on a clean read (Fix A)', () => {
  const snapshots = [];
  const RESOLVED_SHA = 'cafefeed0000000000000000000000000000000f';
  readReadyMetas('/repo/docs/superpowers/plans/ready', {
    source: 'origin',
    repoRoot: '/repo',
    onSnapshot: (s) => snapshots.push(s),
    _exec: (cmd, args) => {
      if (args[2] === 'fetch') return '';
      if (args[2] === 'rev-parse') return RESOLVED_SHA + '\n';
      if (args[2] === 'ls-tree') {
        return '100644 blob aaa\tdocs/superpowers/plans/ready/900-Other-ok.md\n';
      }
      if (args[2] === 'cat-file') {
        return catFileStream([plan({ extra: '> 💰 **Cost forecast:** $0' })]);
      }
      throw new Error(`unexpected: git ${args.join(' ')}`);
    },
  });
  assert.equal(snapshots.length, 1, 'onSnapshot fires exactly once');
  assert.deepEqual(snapshots[0], {
    originSha: RESOLVED_SHA,
    fetchFailed: false,
    skippedUnreadable: 0,
  });
});

test('readReadyMetas: source "origin" reports fetchFailed:true through onSnapshot when the fetch failed but a local origin/master still resolves', () => {
  const snapshots = [];
  const RESOLVED_SHA = 'cafefeed0000000000000000000000000000000f';
  readReadyMetas('/repo/docs/superpowers/plans/ready', {
    source: 'origin',
    repoRoot: '/repo',
    onSnapshot: (s) => snapshots.push(s),
    log: () => {},
    _exec: (cmd, args) => {
      if (args[2] === 'fetch') throw new Error('simulated network blip');
      if (args[2] === 'rev-parse') return RESOLVED_SHA + '\n';
      if (args[2] === 'ls-tree') {
        return '100644 blob aaa\tdocs/superpowers/plans/ready/900-Other-ok.md\n';
      }
      if (args[2] === 'cat-file') {
        return catFileStream([plan({ extra: '> 💰 **Cost forecast:** $0' })]);
      }
      throw new Error(`unexpected: git ${args.join(' ')}`);
    },
  });
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0], {
    originSha: RESOLVED_SHA,
    fetchFailed: true,
    skippedUnreadable: 0,
  });
});

test('readReadyMetas: source "origin" never invokes onSnapshot when source is "tree" (fixture mode reports its own null default, not a callback)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qdrain-tree-onsnapshot-'));
  try {
    writeFileSync(join(dir, '900-Other-ok.md'), plan({ extra: '> 💰 **Cost forecast:** $0' }));
    let fired = false;
    readReadyMetas(dir, { source: 'tree', onSnapshot: () => (fired = true) });
    assert.equal(fired, false, 'onSnapshot is an origin-only signal — tree mode never calls it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── plan 3816 fix round 2, Fix B: a null/unreadable blob must never reach the string parsers ──
test('readReadyMetas: source "origin" — an unreadable (null) blob is SKIPPED, not passed to the string parsers, and logs one named stderr line naming the path + short sha (Fix B)', () => {
  const logs = [];
  const metas = readReadyMetas('/repo/docs/superpowers/plans/ready', {
    source: 'origin',
    repoRoot: '/repo',
    log: (msg) => logs.push(msg),
    _exec: (cmd, args) => {
      if (args[2] === 'fetch') return '';
      if (args[2] === 'rev-parse') return 'deadbeefcafe0000000000000000000000000000\n';
      if (args[2] === 'ls-tree') {
        return (
          '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t' +
          'docs/superpowers/plans/ready/900-Other-missing.md\n' +
          '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\t' +
          'docs/superpowers/plans/ready/901-Other-ok.md\n'
        );
      }
      if (args[2] === 'cat-file') {
        // Simulates readBlobsBatched's own null-for-missing-blob contract directly, at the
        // readyEntriesFromOrigin boundary, by returning a cat-file stream that reports the
        // FIRST object missing (git cat-file --batch prints "<sha> missing" with no body).
        return Buffer.concat([
          Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa missing\n', 'utf8'),
          catFileStream([plan({ extra: '> 💰 **Cost forecast:** $2' })]),
        ]);
      }
      throw new Error(`unexpected: git ${args.join(' ')}`);
    },
  });
  assert.equal(
    metas.length,
    1,
    'the unreadable entry is skipped entirely — no crash, no null-content meta',
  );
  assert.equal(metas[0].slug, '901-Other-ok');
  assert.equal(logs.length, 1, 'exactly one warning logged for the skipped blob');
  assert.match(
    logs[0],
    /unreadable blob for docs\/superpowers\/plans\/ready\/900-Other-missing\.md/,
  );
  assert.match(logs[0], /\(aaaaaaa\)/, 'the SHORT (7-char) sha is named in the warning');
  assert.match(logs[0], /skipping this ready plan/);
});

// ── plan 3816 fix round 3 (review keys f5ba3e/1494a6): surface the unreadable-blob skip to the
// board via onSnapshot's new `skippedUnreadable` field, instead of leaving it stranded on the
// oracle child process's stderr where ready-board.mjs's runOracle silently discards it on a
// successful exit — see queue-drain.mjs's onSnapshot header comment and ready-board.mjs's
// originHeaderLine header comment for the full mechanism this closes.
test('readReadyMetas: source "origin" — a cat-file --batch reporting one blob missing among several good ones still returns every good plan, skips only the bad one, and reports skippedUnreadable:1 via onSnapshot (fix round 3)', () => {
  const logs = [];
  const snapshots = [];
  const metas = readReadyMetas('/repo/docs/superpowers/plans/ready', {
    source: 'origin',
    repoRoot: '/repo',
    log: (msg) => logs.push(msg),
    onSnapshot: (s) => snapshots.push(s),
    _exec: (cmd, args) => {
      if (args[2] === 'fetch') return '';
      if (args[2] === 'rev-parse') return 'deadbeefcafe0000000000000000000000000000\n';
      if (args[2] === 'ls-tree') {
        return (
          '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t' +
          'docs/superpowers/plans/ready/900-Other-missing.md\n' +
          '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\t' +
          'docs/superpowers/plans/ready/901-Other-ok.md\n' +
          '100644 blob cccccccccccccccccccccccccccccccccccccccc\t' +
          'docs/superpowers/plans/ready/902-Other-ok2.md\n'
        );
      }
      if (args[2] === 'cat-file') {
        // The FIRST object ("900-Other-missing") reports missing (git cat-file --batch prints
        // "<sha> missing" with no body); the other two good ones stream normally.
        return Buffer.concat([
          Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa missing\n', 'utf8'),
          catFileStream([
            plan({ extra: '> 💰 **Cost forecast:** $1' }),
            plan({ extra: '> 💰 **Cost forecast:** $2' }),
          ]),
        ]);
      }
      throw new Error(`unexpected: git ${args.join(' ')}`);
    },
  });
  assert.equal(metas.length, 2, 'both good plans still come back');
  assert.deepEqual(metas.map((m) => m.slug).sort(), ['901-Other-ok', '902-Other-ok2']);
  assert.equal(logs.length, 1, 'exactly one warning logged for the one skipped blob');
  assert.equal(snapshots.length, 1, 'onSnapshot fires exactly once');
  assert.deepEqual(snapshots[0], {
    originSha: 'deadbeefcafe0000000000000000000000000000',
    fetchFailed: false,
    skippedUnreadable: 1,
  });
});

test('readReadyMetas: source "origin" — a clean read with no unreadable blobs reports skippedUnreadable:0 via onSnapshot (fix round 3)', () => {
  const snapshots = [];
  const metas = readReadyMetas('/repo/docs/superpowers/plans/ready', {
    source: 'origin',
    repoRoot: '/repo',
    onSnapshot: (s) => snapshots.push(s),
    _exec: (cmd, args) => {
      if (args[2] === 'fetch') return '';
      if (args[2] === 'rev-parse') return 'deadbeefcafe0000000000000000000000000000\n';
      if (args[2] === 'ls-tree') {
        return '100644 blob aaa\tdocs/superpowers/plans/ready/900-Other-ok.md\n';
      }
      if (args[2] === 'cat-file') {
        return catFileStream([plan({ extra: '> 💰 **Cost forecast:** $0' })]);
      }
      throw new Error(`unexpected: git ${args.join(' ')}`);
    },
  });
  assert.equal(metas.length, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].skippedUnreadable, 0, 'no skips on the clean path');
});

// ── plan 3816 fix round 2, Fix C: a failed fetch AND no local origin/master must fail soft ─────
test('readReadyMetas: source "origin" — rev-parse failing (no local origin/master at all, e.g. a fresh/partial clone) returns an EMPTY array instead of throwing, logs one named line, and reports originSha:null/fetchFailed:true via onSnapshot (Fix C)', () => {
  const logs = [];
  const snapshots = [];
  const metas = readReadyMetas('/repo/docs/superpowers/plans/ready', {
    source: 'origin',
    repoRoot: '/repo',
    log: (msg) => logs.push(msg),
    onSnapshot: (s) => snapshots.push(s),
    _exec: (cmd, args) => {
      if (args[2] === 'fetch') return ''; // fetch itself can succeed or fail — irrelevant here
      if (args[2] === 'rev-parse') throw new Error("fatal: ambiguous argument 'origin/master'");
      throw new Error(`unexpected: git ${args.join(' ')} (ls-tree/cat-file must NOT run)`);
    },
  });
  assert.deepEqual(
    metas,
    [],
    'an unresolvable origin/master degrades to an EMPTY ready set, never a throw',
  );
  assert.equal(logs.length, 1, 'exactly one warning logged');
  assert.match(logs[0], /no readable origin\/master/);
  assert.match(logs[0], /ambiguous argument 'origin\/master'/);
  assert.match(logs[0], /returning an EMPTY ready set/);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0], { originSha: null, fetchFailed: true, skippedUnreadable: 0 });
});

test('readReadyMetas: source "origin" — rev-parse failing after a SUCCESSFUL fetch still fails soft to an empty set (the fetch guard alone is not enough, Fix C)', () => {
  const metas = readReadyMetas('/repo/docs/superpowers/plans/ready', {
    source: 'origin',
    repoRoot: '/repo',
    log: () => {},
    _exec: (cmd, args) => {
      if (args[2] === 'fetch') return ''; // fetch SUCCEEDS
      if (args[2] === 'rev-parse') throw new Error('fatal: no such ref');
      throw new Error(`unexpected: git ${args.join(' ')}`);
    },
  });
  assert.deepEqual(metas, []);
});

test('readReadyMetas: source "origin" — a git-fetch failure degrades to the LOCAL origin/master ref instead of throwing, logging to stderr ONLY (never stdout) (plan 3816 fix round, Fix 2)', () => {
  const logs = [];
  const metas = readReadyMetas('/repo/docs/superpowers/plans/ready', {
    source: 'origin',
    repoRoot: '/repo',
    log: (msg) => logs.push(msg),
    _exec: (cmd, args) => {
      if (args[2] === 'fetch') throw new Error('simulated network blip');
      if (args[2] === 'rev-parse') return 'deadbeefcafe0000000000000000000000000000\n';
      if (args[2] === 'ls-tree') {
        return '100644 blob aaa\tdocs/superpowers/plans/ready/900-Other-ok.md\n';
      }
      if (args[2] === 'cat-file') {
        return catFileStream([plan({ extra: '> 💰 **Cost forecast:** $0' })]);
      }
      throw new Error(`unexpected: git ${args.join(' ')}`);
    },
  });
  assert.equal(metas.length, 1, 'the origin metas still come back despite the fetch failure');
  assert.equal(metas[0].slug, '900-Other-ok');
  assert.equal(logs.length, 1, 'exactly one warning logged');
  assert.match(logs[0], /readReadyMetas — git fetch origin failed \(simulated network blip\)/);
  assert.match(logs[0], /reading ready\/ off the LOCAL origin\/master ref, which may lag origin/);
});

test('readReadyMetas: source "origin" — a git-fetch failure writes NOTHING to stdout (console.log) — only the injected log seam carries the warning (plan 3816 fix round, Fix 2)', () => {
  const stdoutLogs = [];
  const originalConsoleLog = console.log;
  console.log = (...args) => stdoutLogs.push(args.join(' '));
  try {
    readReadyMetas('/repo/docs/superpowers/plans/ready', {
      source: 'origin',
      repoRoot: '/repo',
      _exec: (cmd, args) => {
        if (args[2] === 'fetch') throw new Error('simulated network blip');
        if (args[2] === 'rev-parse') return 'deadbeefcafe0000000000000000000000000000\n';
        if (args[2] === 'ls-tree') {
          return '100644 blob aaa\tdocs/superpowers/plans/ready/900-Other-ok.md\n';
        }
        if (args[2] === 'cat-file') {
          return catFileStream([plan({ extra: '> 💰 **Cost forecast:** $0' })]);
        }
        throw new Error(`unexpected: git ${args.join(' ')}`);
      },
    });
  } finally {
    console.log = originalConsoleLog;
  }
  assert.deepEqual(stdoutLogs, [], 'stdout must stay parseable JSON — the warning is stderr-only');
});

test('readReadyMetas: source "origin" against a REAL temp git repo — a tree-only file and an origin-only file resolve to opposite sets per source (acceptance)', () => {
  const bareDir = mkdtempSync(join(tmpdir(), 'qdrain-origin-bare-'));
  const workDir = mkdtempSync(join(tmpdir(), 'qdrain-origin-work-'));
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'master', bareDir]);
    execFileSync('git', ['init', '-q', '-b', 'master', workDir]);
    execFileSync('git', ['-C', workDir, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', workDir, 'config', 'user.name', 't']);
    execFileSync('git', ['-C', workDir, 'config', 'commit.gpgsign', 'false']);
    execFileSync('git', ['-C', workDir, 'remote', 'add', 'origin', bareDir]);

    const readyDir = join(workDir, 'docs', 'superpowers', 'plans', 'ready');
    mkdirSync(readyDir, { recursive: true });
    // Commit + push a plan that will live ONLY on origin/master once the working tree drops it.
    writeFileSync(
      join(readyDir, '910-Other-origin-only.md'),
      plan({ extra: '> 💰 **Cost forecast:** $0' }),
    );
    execFileSync('git', ['-C', workDir, 'add', '-A']);
    execFileSync('git', ['-C', workDir, 'commit', '-qm', 'origin-only plan']);
    execFileSync('git', ['-C', workDir, 'push', '-q', 'origin', 'master']);

    // Diverge the WORKING TREE from what was pushed: drop the origin-only file, add one that
    // was never pushed — the tree now disagrees with origin/master in both directions.
    rmSync(join(readyDir, '910-Other-origin-only.md'));
    writeFileSync(
      join(readyDir, '920-Other-tree-only.md'),
      plan({ extra: '> 💰 **Cost forecast:** $0' }),
    );

    const originSlugs = readReadyMetas(readyDir, { source: 'origin', repoRoot: workDir }).map(
      (m) => m.slug,
    );
    assert.deepEqual(
      originSlugs,
      ['910-Other-origin-only'],
      'origin mode reports the PUSHED set, unaffected by the un-pushed working-tree edits',
    );

    const treeSlugs = readReadyMetas(readyDir, { source: 'tree' }).map((m) => m.slug);
    assert.deepEqual(
      treeSlugs,
      ['920-Other-tree-only'],
      'tree mode (the explicit test opt-in) reports the LOCAL disk set, unaffected by origin',
    );
  } finally {
    rmSync(bareDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('CLI: a ready/ plan held by a runnable batch is excluded and a solo pool exits 1 all_batch_held (plan 2459 Task 2)', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-y', { members: ['2600'] });
    writeFileSync(join(readyDir, '2600-Infra-held.md'), cliPlanBody({}));
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.code, 1, `expected exit 1; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.reason, 'all_batch_held');
    assert.equal(res.json.excluded[0].exclude, 'batch');
    assert.match(res.json.excluded[0].reason, /batch-y/);
  });
});

// --- plan 2556: runnableBatches, end to end through the real CLI -------------

test('CLI: an all-held pool exits 1 all_batch_held AND names the takeable train in runnableBatches (plan 2556)', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-y', { members: ['2600', '2601'] });
    writeFileSync(join(readyDir, '2600-Infra-held.md'), cliPlanBody({}));
    writeFileSync(join(readyDir, '2601-Infra-held.md'), cliPlanBody({}));
    const res = runQueueDrain(readyDir, []);
    // Exit code deliberately UNCHANGED (decision D2): "no SINGLE plan runnable" is still
    // true, and drain-run/local-drain-filter/orchestrate-dryrun all read exit 0 as
    // "`.next` exists". A batch-capable consumer reads runnableBatches regardless.
    assert.equal(res.code, 1, `expected exit 1; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.reason, 'all_batch_held');
    assert.equal(res.json.runnableBatches.length, 1);
    assert.equal(res.json.runnableBatches[0].slug, 'batch-y');
    assert.deepEqual(res.json.runnableBatches[0].members, ['2600', '2601']);
    assert.deepEqual(res.json.runnableBatches[0].memberPaths, [
      'docs/superpowers/plans/ready/2600-Infra-held.md',
      'docs/superpowers/plans/ready/2601-Infra-held.md',
    ]);
  });
});

test('CLI: a batch one of whose members is blocked-by an open upstream is NOT reported runnable', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-y', { members: ['2600', '2601'] });
    writeFileSync(join(readyDir, '2600-Infra-held.md'), cliPlanBody({}));
    writeFileSync(
      join(readyDir, '2601-Infra-held.md'),
      `${cliPlanBody({})}\n**Blocked-by:** plan 900 (still in flight)\n`,
    );
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.code, 1);
    assert.deepEqual(res.json.runnableBatches, []);
  });
});

// A gated / already-claimed batch never guards its members (plan 2459 item 5), so it can
// never be reported runnable either — the ONE `isRunnableBatch` predicate decides both.
test('CLI: a gated batch guards nothing and is never reported runnable — its members drain solo', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-gated', { members: ['2600'], gate: 'plan 900 lands' });
    writeFileSync(join(readyDir, '2600-Infra-held.md'), cliPlanBody({}));
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.next.slug, '2600-Infra-held');
    assert.deepEqual(res.json.runnableBatches, []);
  });
});

// WORK ITEM 3, upgraded by the operator ruling from "verify the sonnet lane's check still
// works" to "GUARANTEE it works". The live board cannot exercise this: every current sonnet
// batch member is `cloudExec: false`, so the cloud gate (chain position 1) preempts the batch
// gate (position 7) and the batch never even reaches the batch branch. This fixture is the
// guarantee — a cloud-eligible SONNET batch IS reported to a --cloud drain.
test('CLI --cloud: a fully cloud-eligible SONNET batch is reported runnable (the item-3 guarantee)', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-cloudy', { members: ['2600', '2601'] });
    writeFileSync(join(readyDir, '2600-Infra-a.md'), cliPlanBody({ cloud: 'true' }));
    writeFileSync(join(readyDir, '2601-Infra-b.md'), cliPlanBody({ cloud: 'true' }));
    const res = runQueueDrain(readyDir, ['--cloud']);
    assert.equal(res.json.runnableBatches.length, 1, JSON.stringify(res.json));
    assert.equal(res.json.runnableBatches[0].slug, 'batch-cloudy');
    assert.deepEqual(res.json.skippedBatches, []);
  });
});

// RULING 1, end to end: ONE non-cloud-eligible member withholds the WHOLE train from the
// cloud lane, and the drain is told exactly which member and why — so it can log the skip and
// leave the train for the local lane instead of silently seeing "no batch".
test('CLI --cloud: one non-cloud-eligible member withholds the train and names itself in skippedBatches', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-mixed', { members: ['2600', '2601'] });
    writeFileSync(join(readyDir, '2600-Infra-a.md'), cliPlanBody({ cloud: 'true' }));
    writeFileSync(join(readyDir, '2601-Infra-b.md'), cliPlanBody({ cloud: 'false' }));
    const res = runQueueDrain(readyDir, ['--cloud']);
    assert.deepEqual(res.json.runnableBatches, []);
    assert.equal(res.json.skippedBatches.length, 1);
    assert.equal(res.json.skippedBatches[0].slug, 'batch-mixed');
    assert.deepEqual(res.json.skippedBatches[0].blockers, [{ id: '2601', cause: 'cloud' }]);
  });
});

// ...and the SAME roster IS takeable by the local lane, which is where the ruling says a
// mixed train belongs. Both halves in one place so the routing claim is not just asserted.
test('CLI (local): the very train the cloud lane withheld is runnable locally', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-mixed', { members: ['2600', '2601'] });
    writeFileSync(join(readyDir, '2600-Infra-a.md'), cliPlanBody({ cloud: 'true' }));
    writeFileSync(join(readyDir, '2601-Infra-b.md'), cliPlanBody({ cloud: 'false' }));
    const res = runQueueDrain(readyDir, []); // no --cloud: the local pool
    assert.deepEqual(
      res.json.runnableBatches.map((b) => b.slug),
      ['batch-mixed'],
    );
  });
});

// REVIEW FINDING 0 (plan 2556 /sonnet-review xhigh) — THE BUG THIS PINS: the roster read was
// demand-gated on `metas.some(m => m.exclude === 'batch')`. That predicate is FALSE in exactly
// the case that most needs reporting — a runnable batch ALL of whose members have left ready/
// (re-filed, claimed, archived, or the roster naming stale ids). No meta then reads 'batch', the
// roster was never read, and the batch appeared in NEITHER runnableBatches NOR skippedBatches:
// silently absent, which is precisely what the operator ruling's "logged reason" forbids, and
// nothing else in the system would ever surface a fully-stale roster entry. Every other test in
// this file exercises a batch with at least one member still in ready/, so the gap shipped
// untested until the review found it.
test('CLI: a runnable batch whose members have ALL left ready/ is still REPORTED in skippedBatches', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-stale', { members: ['2600', '2601'] });
    // Neither member exists in ready/ — only an unrelated plan does, so nothing is batch-held.
    writeFileSync(join(readyDir, '2700-Infra-unrelated.md'), cliPlanBody({}));
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.deepEqual(res.json.runnableBatches, []);
    assert.equal(res.json.skippedBatches.length, 1, JSON.stringify(res.json.skippedBatches));
    assert.equal(res.json.skippedBatches[0].slug, 'batch-stale');
    assert.deepEqual(res.json.skippedBatches[0].blockers, [
      { id: '2600', cause: 'not-in-ready-pool' },
      { id: '2601', cause: 'not-in-ready-pool' },
    ]);
  });
});

// --- plan 4246: an archived batch member must not strand the rest of the train -----------
//
// THE DEADLOCK THESE PIN (live 2026-09-26): batch-2026-09-26-profile-ui listed [4187, 4233];
// 4187 landed solo and archived. The oracle then refused the train ("4187
// (not-in-ready-pool)", all-or-nothing) AND refused 4233 solo ("member of runnable batch"), so
// no drain would ever take it. The fixture archive lane sits beside ready/ under the configured
// ARCHIVE_FOLDER name, exactly where main()'s roster looks for it.
function archivePlan(readyDir, basename) {
  const dir = join(dirname(readyDir), ARCHIVE_FOLDER);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, basename), '# landed\n\n**Status:** ✅ COMPLETED — test.\n');
}

test('CLI: a 2-member batch with 1 ARCHIVED member dissolves — the survivor is solo-eligible and the batch is logged as dissolved (plan 4246)', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-profile-ui', { members: ['2600', '2601'] });
    archivePlan(readyDir, '2600-UI-landed-solo.md');
    writeFileSync(join(readyDir, '2601-App-survivor.md'), cliPlanBody({}));
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.next.slug, '2601-App-survivor');
    assert.deepEqual(
      res.json.eligible.map((e) => e.slug),
      ['2601-App-survivor'],
    );
    assert.deepEqual(res.json.runnableBatches, []);
    assert.equal(res.json.skippedBatches.length, 1, JSON.stringify(res.json.skippedBatches));
    assert.equal(res.json.skippedBatches[0].slug, 'batch-profile-ui');
    assert.match(
      res.json.skippedBatches[0].reason,
      /^dissolved: only 1 live member left \(2600 archived\)/,
    );
    assert.deepEqual(res.json.skippedBatches[0].blockers, [{ id: '2600', cause: 'archived' }]);
  });
});

test('readReadyMetas (tree): the survivor of a dissolved batch reads exclude null, not batch (plan 4246)', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-scripts-checks', { members: ['2611', '2627'] });
    archivePlan(readyDir, '2627-Infra-landed-solo.md');
    writeFileSync(join(readyDir, '2611-Infra-survivor.md'), cliPlanBody({}));
    const metas = readReadyMetas(readyDir, { source: 'tree' });
    assert.equal(metas.length, 1);
    assert.equal(metas[0].exclude, null, metas[0].excludeReason);
  });
});

test('CLI: a 3-member batch with 1 ARCHIVED member stays runnable with exactly the 2 live ids (plan 4246)', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-three', { members: ['2600', '2601', '2602'] });
    archivePlan(readyDir, '2600-Infra-landed-solo.md');
    writeFileSync(join(readyDir, '2601-Infra-b.md'), cliPlanBody({}));
    writeFileSync(join(readyDir, '2602-Infra-c.md'), cliPlanBody({}));
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.json.runnableBatches.length, 1, JSON.stringify(res.json.skippedBatches));
    assert.equal(res.json.runnableBatches[0].slug, 'batch-three');
    assert.deepEqual(res.json.runnableBatches[0].members, ['2601', '2602']);
    assert.deepEqual(res.json.skippedBatches, []);
    // Still a live train: both survivors stay held from SOLO claims.
    const excluded = Object.fromEntries(res.json.excluded.map((e) => [e.slug, e.exclude]));
    assert.equal(excluded['2601-Infra-b'], 'batch');
    assert.equal(excluded['2602-Infra-c'], 'batch');
  });
});

test('CLI: a member merely out of ready/ (waiting-*, NOT archived) keeps the all-or-nothing hold (plan 4246 rule 4)', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-waiting', { members: ['2600', '2601'] });
    const waiting = join(dirname(readyDir), 'waiting-operator');
    mkdirSync(waiting, { recursive: true });
    writeFileSync(join(waiting, '2600-Infra-parked.md'), cliPlanBody({}));
    writeFileSync(join(readyDir, '2601-Infra-held.md'), cliPlanBody({}));
    const res = runQueueDrain(readyDir, []);
    assert.deepEqual(res.json.runnableBatches, []);
    assert.equal(res.json.skippedBatches.length, 1);
    assert.deepEqual(res.json.skippedBatches[0].blockers, [
      { id: '2600', cause: 'not-in-ready-pool' },
    ]);
    assert.equal(res.json.excluded[0].slug, '2601-Infra-held');
    assert.equal(res.json.excluded[0].exclude, 'batch');
  });
});

test('selectEligible: dissolvedBatches are logged in skippedBatches even with an empty runnable roster (plan 4246)', () => {
  const r = selectEligible([meta({ id: 10 })], {
    landingHeld: false,
    batchRoster: [],
    dissolvedBatches: [{ slug: 'batch-gone', members: ['10'], archivedMembers: ['9'] }],
  });
  assert.deepEqual(r.runnableBatches, []);
  assert.equal(r.skippedBatches.length, 1);
  assert.equal(r.skippedBatches[0].slug, 'batch-gone');
  assert.match(r.skippedBatches[0].reason, /^dissolved: only 1 live member left \(9 archived\)/);
});

// Review finding 23b124/4e915b: selectEligible's empty-metas fast path returned
// `skippedBatches: []` before the dissolved batches were merged in, so a dissolved batch vanished
// from the log exactly when ready/ held nothing at all.
test('selectEligible: an EMPTY ready pool still logs every dissolved batch in skippedBatches (plan 4246)', () => {
  const r = selectEligible([], {
    landingHeld: false,
    batchRoster: [],
    dissolvedBatches: [{ slug: 'batch-gone', members: ['10'], archivedMembers: ['9'] }],
  });
  assert.equal(r.reason, 'empty');
  assert.equal(r.skippedBatches.length, 1);
  assert.equal(r.skippedBatches[0].slug, 'batch-gone');
  assert.deepEqual(r.skippedBatches[0].blockers, [{ id: '9', cause: 'archived' }]);
});

test('CLI: an empty ready/ with a dissolved batch reports it (reason empty, skippedBatches carries it) (plan 4246)', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-empty-pool', { members: ['2600', '2601'] });
    archivePlan(readyDir, '2600-UI-landed-solo.md');
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.json.reason, 'empty');
    assert.equal(res.json.skippedBatches.length, 1, JSON.stringify(res.json.skippedBatches));
    assert.match(
      res.json.skippedBatches[0].reason,
      /^dissolved: only 1 live member left \(2600 archived\)/,
    );
  });
});

// Review finding 47956f: ready/ is read at the ORIGIN commit, so the archive listing must be too —
// a member archived on origin but not yet pulled into the local checkout counts as archived, and
// an archive file that exists only on local disk (never pushed) does not.
test('readReadyMetas (origin): archive membership is read at the SAME origin commit as ready/, never local disk (plan 4246)', () => {
  const bareDir = mkdtempSync(join(tmpdir(), 'qdrain-arch-bare-'));
  const workDir = mkdtempSync(join(tmpdir(), 'qdrain-arch-work-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', workDir, ...a], { encoding: 'utf8' });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'master', bareDir]);
    g('init', '-q', '-b', 'master');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    g('remote', 'add', 'origin', bareDir);
    const plansDir = join(workDir, 'docs', 'superpowers', 'plans');
    const readyDir = join(plansDir, 'ready');
    const archiveDir = join(plansDir, ARCHIVE_FOLDER);
    const batchesDir = join(workDir, 'docs', 'superpowers', 'batches');
    mkdirSync(readyDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    // batch-origin: its co-member 2600 is archived ON ORIGIN only (removed from disk below).
    writeBatchMdFixture(batchesDir, 'batch-origin', { members: ['2600', '2601'] });
    writeFileSync(join(archiveDir, '2600-UI-landed-on-origin.md'), '# landed\n');
    writeFileSync(join(readyDir, '2601-App-survivor.md'), cliPlanBody({}));
    // batch-disk: its co-member 2700 is archived on local DISK only (never pushed).
    writeBatchMdFixture(batchesDir, 'batch-disk', { members: ['2700', '2701'] });
    writeFileSync(join(readyDir, '2701-App-held.md'), cliPlanBody({}));
    g('add', '-A');
    g('commit', '-qm', 'seed');
    g('push', '-q', 'origin', 'master');
    rmSync(join(archiveDir, '2600-UI-landed-on-origin.md'));
    writeFileSync(join(archiveDir, '2700-UI-archived-locally-only.md'), '# local\n');

    const metas = readReadyMetas(readyDir, { source: 'origin', repoRoot: workDir, log: () => {} });
    const bySlug = Object.fromEntries(metas.map((m) => [m.slug, m.exclude]));
    assert.equal(bySlug['2601-App-survivor'], null, 'archived on origin → batch dissolved');
    assert.equal(bySlug['2701-App-held'], 'batch', 'archived on disk only → still held');
  } finally {
    rmSync(bareDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

// A real origin + work repo pair for the plan-4246 snapshot tests below. Returns the work dir and
// the plans / archive / ready / batches dirs inside it; `commitPush` commits everything and
// pushes, so later disk edits diverge from origin.
function makeOriginPair() {
  const bareDir = mkdtempSync(join(tmpdir(), 'qdrain-snap-bare-'));
  const workDir = mkdtempSync(join(tmpdir(), 'qdrain-snap-work-'));
  const g = (...a) => execFileSync('git', ['-C', workDir, ...a], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', bareDir]);
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  g('remote', 'add', 'origin', bareDir);
  const plansDir = join(workDir, 'docs', 'superpowers', 'plans');
  const dirs = {
    readyDir: join(plansDir, 'ready'),
    archiveDir: join(plansDir, ARCHIVE_FOLDER),
    batchesDir: join(workDir, 'docs', 'superpowers', 'batches'),
  };
  mkdirSync(dirs.readyDir, { recursive: true });
  mkdirSync(dirs.archiveDir, { recursive: true });
  return {
    workDir,
    ...dirs,
    commitPush: () => {
      g('add', '-A');
      g('commit', '-qm', 'seed');
      g('push', '-q', 'origin', 'master');
    },
    cleanup: () => {
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

// Review finding b35525: the batch.md roster is read at the SAME origin commit as ready/ and the
// archive. Origin lists 3 members with 1 archived (a live 2-car train, both survivors held); the
// stale LOCAL batch.md lists only 2 (which would read as dissolved) and must be ignored.
test('readReadyMetas (origin): a stale LOCAL batch.md is ignored — the origin roster decides the hold (plan 4246, review b35525)', () => {
  const r = makeOriginPair();
  try {
    writeBatchMdFixture(r.batchesDir, 'batch-three', { members: ['2600', '2601', '2602'] });
    writeFileSync(join(r.archiveDir, '2600-UI-landed.md'), '# landed\n');
    writeFileSync(join(r.readyDir, '2601-Infra-b.md'), cliPlanBody({}));
    writeFileSync(join(r.readyDir, '2602-Infra-c.md'), cliPlanBody({}));
    r.commitPush();
    writeBatchMdFixture(r.batchesDir, 'batch-three', { members: ['2600', '2601'] }); // stale, local
    const metas = readReadyMetas(r.readyDir, {
      source: 'origin',
      repoRoot: r.workDir,
      log: () => {},
    });
    const bySlug = Object.fromEntries(metas.map((m) => [m.slug, m.exclude]));
    assert.equal(bySlug['2601-Infra-b'], 'batch');
    assert.equal(bySlug['2602-Infra-c'], 'batch', 'the local roster (which drops 2602) is ignored');
  } finally {
    r.cleanup();
  }
});

// Review finding b89c44: Blocked-by archive status is read at the SAME origin commit too — a
// blocker archived+shipped on origin but not yet pulled is stale (plan eligible), and one shipped
// only on local disk (never pushed) is still an open blocker.
test('readReadyMetas (origin): Blocked-by archive status is read at the origin commit, not local disk (plan 4246, review b89c44)', () => {
  const r = makeOriginPair();
  try {
    const shipped = '# done\n\n**Status:** ✅ COMPLETED — test.\n';
    writeFileSync(join(r.archiveDir, '2650-Infra-shipped-on-origin.md'), shipped);
    writeFileSync(
      join(r.readyDir, '2651-Infra-waits-on-origin.md'),
      cliPlanBody({}) + '\n**Blocked-by:** plan 2650 (landing)\n',
    );
    writeFileSync(
      join(r.readyDir, '2661-Infra-waits-on-local.md'),
      cliPlanBody({}) + '\n**Blocked-by:** plan 2660 (landing)\n',
    );
    r.commitPush();
    rmSync(join(r.archiveDir, '2650-Infra-shipped-on-origin.md'));
    writeFileSync(join(r.archiveDir, '2660-Infra-shipped-locally-only.md'), shipped);
    const metas = readReadyMetas(r.readyDir, {
      source: 'origin',
      repoRoot: r.workDir,
      log: () => {},
    });
    const bySlug = Object.fromEntries(metas.map((m) => [m.slug, m]));
    assert.equal(bySlug['2651-Infra-waits-on-origin'].exclude, null);
    assert.match(bySlug['2651-Infra-waits-on-origin'].staleBlockedBy, /all archived/);
    assert.equal(bySlug['2661-Infra-waits-on-local'].exclude, 'blocked');
  } finally {
    r.cleanup();
  }
});

// Review round 3 (9adfd7): the DISK Blocked-by archive reader parses archive names with the shared
// planIdOfFilename, so a date-slugged shipped blocker (`029-2026-05-21-….md`) is recognized, and
// the lookup matches canonically (`plan 029` ↔ id 29).
test('readReadyMetas (tree): a DATE-slugged shipped archive blocker makes the Blocked-by line stale (plan 4246, review 9adfd7)', () => {
  withSuperpowersDirs(({ readyDir }) => {
    const archiveDir = join(dirname(readyDir), ARCHIVE_FOLDER);
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      join(archiveDir, '029-2026-05-21-landed-long-ago.md'),
      '# done\n\n**Status:** ✅ COMPLETED — test.\n',
    );
    writeFileSync(
      join(readyDir, '2670-Infra-waits.md'),
      cliPlanBody({}) + '\n**Blocked-by:** plan 029 (landing)\n',
    );
    const metas = readReadyMetas(readyDir, { source: 'tree' });
    assert.equal(metas[0].exclude, null, metas[0].excludeReason);
    assert.match(metas[0].staleBlockedBy, /plan 029 — all archived/);
  });
});

// Review round 3 (ca651e): the same, for the origin (at-ref) reader.
test('readReadyMetas (origin): a DATE-slugged shipped archive blocker makes the Blocked-by line stale (plan 4246, review ca651e)', () => {
  const r = makeOriginPair();
  try {
    writeFileSync(
      join(r.archiveDir, '029-2026-05-21-landed-long-ago.md'),
      '# done\n\n**Status:** ✅ COMPLETED — test.\n',
    );
    writeFileSync(
      join(r.readyDir, '2671-Infra-waits.md'),
      cliPlanBody({}) + '\n**Blocked-by:** plan 029 (landing)\n',
    );
    r.commitPush();
    const metas = readReadyMetas(r.readyDir, {
      source: 'origin',
      repoRoot: r.workDir,
      log: () => {},
    });
    assert.equal(metas[0].exclude, null, metas[0].excludeReason);
    assert.match(metas[0].staleBlockedBy, /plan 029 — all archived/);
  } finally {
    r.cleanup();
  }
});

// The same gate's second trigger path: members ARE in ready/ but every one is excluded by a gate
// ABOVE the batch gate, so again nothing reads 'batch'. The train must still be reported.
test('CLI --cloud: a batch whose members are ALL excluded before the batch gate is still reported', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-nocloud', { members: ['2600', '2601'] });
    writeFileSync(join(readyDir, '2600-Infra-a.md'), cliPlanBody({ cloud: 'false' }));
    writeFileSync(join(readyDir, '2601-Infra-b.md'), cliPlanBody({ cloud: 'false' }));
    const res = runQueueDrain(readyDir, ['--cloud']);
    assert.deepEqual(res.json.runnableBatches, []);
    assert.equal(res.json.skippedBatches.length, 1, JSON.stringify(res.json.skippedBatches));
    assert.deepEqual(res.json.skippedBatches[0].blockers, [
      { id: '2600', cause: 'cloud' },
      { id: '2601', cause: 'cloud' },
    ]);
  });
});

// The oracle hands the member stamps over so local-drain-filter need not re-read them
// (review finding 6). Pin the field so a future refactor cannot silently drop it and
// re-introduce the duplicated I/O.
test('CLI: a runnable batch carries memberCloudExec in member order', () => {
  withSuperpowersDirs(({ readyDir, batchesDir }) => {
    writeBatchMdFixture(batchesDir, 'batch-stamped', { members: ['2600', '2601'] });
    writeFileSync(join(readyDir, '2600-Infra-a.md'), cliPlanBody({ cloud: 'false' }));
    writeFileSync(join(readyDir, '2601-Infra-b.md'), cliPlanBody({}));
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.json.runnableBatches.length, 1);
    assert.deepEqual(res.json.runnableBatches[0].memberCloudExec, ['false', 'unset']);
  });
});

test('CLI: runnableBatches is [] (never undefined) when no plan is batch-held at all', () => {
  withSuperpowersDirs(({ readyDir }) => {
    writeFileSync(join(readyDir, '2600-Infra-free.md'), cliPlanBody({}));
    const res = runQueueDrain(readyDir, []);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    // Also the demand-gate's observable half: with nothing held, the roster walk is
    // skipped entirely (batchRoster stays null) and the field still renders as [].
    assert.deepEqual(res.json.runnableBatches, []);
  });
});

// --- plan 2556, operator ruling 2026-07-27 -----------------------------------
//
// (1) All-or-nothing per train, and a withheld train is SKIPPED WITH A LOGGED REASON —
//     never silently absent, or "no batch was runnable" and "a batch was withheld because
//     one member is not cloud-eligible HERE" become indistinguishable and a mixed train
//     rots instead of being routed to the lane that can take it.
// (2) A batch rides the priority of its BEST member: "the next eligible plan is
//     batch-held" means the train IS the next unit of work, not something to pass over.

test('selectEligible: a member excluded by a gate ABOVE the batch gate withholds the train AND logs why', () => {
  const r = selectEligible(
    [
      heldMeta({ id: 10, slug: 'batch-a' }),
      // In --cloud mode a member that is not cloud-eligible reads `cloud` here, never
      // `batch` — the cloud gate is chain position 1, the batch gate position 7.
      meta({ id: 11, exclude: 'cloud' }),
    ],
    { landingHeld: false, batchRoster: [rosterEntry('batch-a', [10, 11])] },
  );
  assert.deepEqual(r.runnableBatches, []);
  assert.equal(r.skippedBatches.length, 1);
  assert.equal(r.skippedBatches[0].slug, 'batch-a');
  assert.deepEqual(r.skippedBatches[0].blockers, [{ id: '11', cause: 'cloud' }]);
  assert.match(r.skippedBatches[0].reason, /11 \(cloud\)/);
  assert.match(r.skippedBatches[0].reason, /never claim a train partially/);
});

test('selectEligible: a roster member absent from the pool is logged as not-in-ready-pool', () => {
  const r = selectEligible([heldMeta({ id: 10, slug: 'batch-a' })], {
    landingHeld: false,
    batchRoster: [rosterEntry('batch-a', [10, 11])],
  });
  assert.deepEqual(r.skippedBatches[0].blockers, [{ id: '11', cause: 'not-in-ready-pool' }]);
});

test('selectEligible: a member blocked UNDER the hold is logged distinctly from one excluded above it', () => {
  const r = selectEligible(
    [
      heldMeta({ id: 10, slug: 'batch-a' }),
      heldMeta({ id: 11, slug: 'batch-a', otherwise: 'blocked' }),
    ],
    { landingHeld: false, batchRoster: [rosterEntry('batch-a', [10, 11])] },
  );
  assert.deepEqual(r.skippedBatches[0].blockers, [{ id: '11', cause: 'blocked-under-hold' }]);
});

test('selectEligible: a SEEDWRITE train withheld by the LANDING mutex says so, with no member blamed', () => {
  const r = selectEligible(
    [
      heldMeta({ id: 10, slug: 'batch-a', seedWrite: 'yes' }),
      heldMeta({ id: 11, slug: 'batch-a' }),
    ],
    { landingHeld: true, batchRoster: [rosterEntry('batch-a', [10, 11])] },
  );
  assert.deepEqual(r.runnableBatches, []);
  assert.match(r.skippedBatches[0].reason, /LANDING mutex/);
  assert.deepEqual(r.skippedBatches[0].blockers, []);
});

test('selectEligible: a roster entry with no members is logged, never silently dropped', () => {
  const r = selectEligible([meta({ id: 9 })], {
    landingHeld: false,
    batchRoster: [rosterEntry('batch-empty', [])],
  });
  assert.equal(r.skippedBatches[0].slug, 'batch-empty');
  assert.match(r.skippedBatches[0].reason, /no members/);
});

// RULING 2. A high-priority member drags its whole train ahead of a batch of ordinary
// plans with lower ids — under the pre-ruling smallest-member-id sort the order was the
// exact opposite, which is what "not something to pass over" forbids.
test('selectEligible: a batch rides the priority of its BEST member, not its smallest id', () => {
  const hi = heldMeta({ id: 90, slug: 'batch-urgent' });
  hi.priorityTier = 'high';
  const r = selectEligible(
    [
      heldMeta({ id: 10, slug: 'batch-ordinary' }),
      heldMeta({ id: 11, slug: 'batch-ordinary' }),
      hi,
      heldMeta({ id: 91, slug: 'batch-urgent' }),
    ],
    {
      landingHeld: false,
      batchRoster: [rosterEntry('batch-ordinary', [10, 11]), rosterEntry('batch-urgent', [90, 91])],
    },
  );
  assert.deepEqual(
    r.runnableBatches.map((b) => b.slug),
    ['batch-urgent', 'batch-ordinary'],
  );
  assert.equal(r.runnableBatches[0].priority, true);
  assert.equal(r.runnableBatches[0].rankedBy.id, '90');
  assert.equal(r.runnableBatches[1].priority, false);
});

// The rank is the BEST member's, so one high-tier member is enough — the others do not dilute it.
test('selectEligible: rankedBy names the single best member of a mixed-priority train', () => {
  const hi = heldMeta({ id: 50, slug: 'batch-mixed-prio' });
  hi.priorityTier = 'high';
  const lo = heldMeta({ id: 51, slug: 'batch-mixed-prio' });
  lo.priorityTier = 'low';
  const r = selectEligible([hi, lo], {
    landingHeld: false,
    batchRoster: [rosterEntry('batch-mixed-prio', [50, 51])],
  });
  assert.equal(r.runnableBatches[0].rankedBy.id, '50');
  assert.equal(r.runnableBatches[0].priorityTier, 'high');
});

// The ranking handle must never leak into the JSON contract.
test('selectEligible: a runnableBatches entry exposes no internal _rank handle', () => {
  const r = selectEligible(
    [heldMeta({ id: 10, slug: 'batch-a' }), heldMeta({ id: 11, slug: 'batch-a' })],
    { landingHeld: false, batchRoster: [rosterEntry('batch-a', [10, 11])] },
  );
  assert.equal('_rank' in r.runnableBatches[0], false);
});

// ── plan 2313: cloudEnv: webkit — the DOM-only live-render rung ──────────────
// (between `full` and `browser` on the superset ladder: the acceptance needs a live
// browser-RENDERED page but consumes only DOM/HTML/anchors/http_status — WebKit
// satisfies it, and WebKit live egress WORKS in a Full-egress environment (the
// 2206/2269 production proof), so `--env full` admits it directly; there is no
// separate `--env webkit` CLI lane. Only the plain-cloud Trusted lane excludes it.)

test('parsePlanMeta cloudOnly: cloudEnv: webkit is excluded as webkit-env from the default (trusted) pool', () => {
  const m = parsePlanMeta(
    '2313-Infra-webkit-shape.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: webkit']),
    { cloudOnly: true },
  );
  assert.equal(m.cloudEnv, 'webkit');
  assert.equal(m.exclude, 'webkit-env');
  assert.match(m.excludeReason, /WebKit browser-render egress/);
});

test('parsePlanMeta cloudOnly+fullEnv: cloudEnv: webkit is ELIGIBLE — a Full-egress lane has WebKit live egress (the 2313 point)', () => {
  const m = parsePlanMeta(
    '2314-Infra-webkit-in-full.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: webkit']),
    { cloudOnly: true, lane: 'full' },
  );
  assert.equal(m.exclude, null);
});

test('parsePlanMeta cloudOnly+browserEnv: cloudEnv: webkit is ALSO eligible — browser is top of the superset ladder', () => {
  const m = parsePlanMeta(
    '2315-Infra-webkit-in-browser.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: webkit']),
    { cloudOnly: true, lane: 'browser' },
  );
  assert.equal(m.exclude, null);
});

test('parsePlanMeta cloudOnly+fullEnv: cloudEnv: browser stays excluded while webkit passes — the rungs stay distinct', () => {
  const mWebkit = parsePlanMeta(
    '2316-Infra-webkit.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: webkit']),
    { cloudOnly: true, lane: 'full' },
  );
  const mBrowser = parsePlanMeta(
    '2317-Infra-browser.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: browser']),
    { cloudOnly: true, lane: 'full' },
  );
  assert.equal(mWebkit.exclude, null);
  assert.equal(mBrowser.exclude, 'browser-env');
});

test('parsePlanMeta: cloudEnv: webkit is INERT without cloudOnly — a local drain reads the unchanged full pool', () => {
  const m = parsePlanMeta(
    '2318-Infra-local-webkit.md',
    planFm(['stage: specced', 'cloudExec: true', 'cloudEnv: webkit']),
    {},
  );
  assert.equal(m.exclude, null);
});

test('selectEligible: a pool excluded only by webkit-env routing → all_fable_or_stub (not all_blocked)', () => {
  const r = selectEligible(
    [meta({ id: 20, exclude: 'webkit-env' }), meta({ id: 21, exclude: 'webkit-env' })],
    { landingHeld: false },
  );
  assert.equal(r.reason, 'all_fable_or_stub');
});

test('CLI --cloud (default): excludes the cloudEnv: webkit plan as webkit-env, selects the trusted one', () => {
  withReadyDir((dir) => {
    writeFileSync(
      join(dir, '2040-Infra-webkit.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true', env: 'webkit' }),
    );
    writeFileSync(
      join(dir, '2041-Infra-trusted.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true' }),
    );
    const res = runQueueDrain(dir, ['--cloud']);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.next.slug, '2041-Infra-trusted');
    assert.equal(res.json.eligible.length, 1);
    assert.equal(res.json.excluded[0].exclude, 'webkit-env');
  });
});

test('CLI --cloud --env full: admits webkit, full, AND trusted plans — still excludes browser', () => {
  withReadyDir((dir) => {
    writeFileSync(
      join(dir, '2042-Infra-webkit.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true', env: 'webkit' }),
    );
    writeFileSync(
      join(dir, '2043-Infra-full.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true', env: 'full' }),
    );
    writeFileSync(
      join(dir, '2044-Infra-trusted.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true' }),
    );
    writeFileSync(
      join(dir, '2045-Infra-browser.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true', env: 'browser' }),
    );
    const res = runQueueDrain(dir, ['--cloud', '--env', 'full']);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.eligible.length, 3);
    const eligibleSlugs = res.json.eligible.map((e) => e.slug).sort();
    assert.deepEqual(eligibleSlugs, ['2042-Infra-webkit', '2043-Infra-full', '2044-Infra-trusted']);
    assert.equal(res.json.excluded.length, 1);
    assert.equal(res.json.excluded[0].exclude, 'browser-env');
  });
});

test('CLI --cloud --env browser: admits the webkit plan too — top rung of the ladder', () => {
  withReadyDir((dir) => {
    writeFileSync(
      join(dir, '2046-Infra-webkit.md'),
      cliFableLaneBody({ execModel: 'sonnet', cloud: 'true', env: 'webkit' }),
    );
    const res = runQueueDrain(dir, ['--cloud', '--env', 'browser']);
    assert.equal(res.code, 0, `expected exit 0; stderr=${res.stderr ?? ''}`);
    assert.equal(res.json.next.slug, '2046-Infra-webkit');
  });
});

test('CLI --env webkit is NOT a lane value — rejected like any unsupported --env (full admits the rung instead)', () => {
  withReadyDir((dir) => {
    writeFileSync(join(dir, '2047-Infra-x.md'), cliPlanBody({ cloud: 'true' }));
    const res = runQueueDrain(dir, ['--cloud', '--env', 'webkit']);
    assert.equal(res.code, 2, `expected exit 2; stderr=${res.stderr ?? ''}`);
    assert.match(res.stderr ?? '', /unsupported --env value/);
  });
});

// ───────────────── the cloudRepos axis (plan 2577) ─────────────────

// plan 3958: VALID_CLOUD_REPOS is read from THIS checkout's own coord.config.json — the public
// coord-kit ships a neutral config with no cloudRepos rows at all (cloud-repos-lib.mjs's own
// header comment: "a config-less repo therefore ships with no extra-repo registry at all"). The
// two tests below exercise real, checkout-specific registry data (vetapp's real key is
// 'hobby-main'), so an empty registry has nothing to validate against for that part — skip that
// part rather than fail, same posture as stamp-cloud-exec.test.mjs's equivalent tests.
const [FIRST_VALID_CLOUD_REPO_KEY] = VALID_CLOUD_REPOS;

test('parsePlanMeta (plan 2577): cloudRepos parses to a key list and NEVER gates', (t) => {
  if (!FIRST_VALID_CLOUD_REPO_KEY) {
    t.skip('this checkout configures no coord.config.json cloudRepos rows');
    return;
  }
  const key = FIRST_VALID_CLOUD_REPO_KEY;
  const m = parsePlanMeta('2531-Other-policy.md', planFm([`cloudRepos: ${key}`]), {
    validCloudRepoKeys: VALID_CLOUD_REPOS,
  });
  assert.deepEqual(m.cloudRepos, [key]);
  // Surfaced, not gated (decision D4): the oracle cannot see which secrets a drain
  // environment holds, so the capability check runs in the drain session at runtime.
  assert.equal(m.exclude, null);
});

test('parsePlanMeta (plan 2577): absent cloudRepos is an empty list, and an unknown key is DROPPED not thrown', (t) => {
  assert.deepEqual(
    parsePlanMeta('a.md', plan({ seed: 'NO' }), { validCloudRepoKeys: VALID_CLOUD_REPOS })
      .cloudRepos,
    [],
  );
  // Non-strict on the oracle side on purpose: one typo in one plan body must never take
  // the whole drain selection down (the stamp tool is the strict half that refuses it). Portable
  // regardless of the registry's contents — 'bogus-repo' is unknown in any registry, empty or not.
  assert.deepEqual(
    parsePlanMeta('b.md', planFm(['cloudRepos: bogus-repo']), {
      validCloudRepoKeys: VALID_CLOUD_REPOS,
    }).cloudRepos,
    [],
  );
  if (!FIRST_VALID_CLOUD_REPO_KEY) {
    t.skip(
      'this checkout configures no coord.config.json cloudRepos rows — cannot exercise the mixed known+unknown or case-folding cases',
    );
    return;
  }
  const key = FIRST_VALID_CLOUD_REPO_KEY;
  assert.deepEqual(
    parsePlanMeta('c.md', planFm([`cloudRepos: bogus-repo, ${key}`]), {
      validCloudRepoKeys: VALID_CLOUD_REPOS,
    }).cloudRepos,
    [key],
  );
  assert.deepEqual(
    parsePlanMeta('d.md', planFm([`cloudRepos: ${key.toUpperCase()}`]), {
      validCloudRepoKeys: VALID_CLOUD_REPOS,
    }).cloudRepos,
    [key],
  );
});

test('parsePlanMeta (plan 3962 P1): with no validCloudRepoKeys supplied, every token is dropped', () => {
  // The default ([]) — a core-destined parsePlanMeta carries no registry of its own; a direct
  // caller that supplies nothing gets the unconfigured-repo behaviour, not vetapp's real set.
  assert.deepEqual(parsePlanMeta('e.md', planFm(['cloudRepos: hobby-main'])).cloudRepos, []);
});

// --- plan 2863: the already-executed-on-origin gate ------------------------------------------
// Four independent cloud firings each executed plan 2855 end-to-end in ~70 minutes because nothing
// asked origin whether a branch for the slug already existed. These pin the gate that closes it.

test('planIdsFromRemoteHeads: extracts ids from BOTH execution-branch shapes, ignores everything else', () => {
  const out = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/master',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/claude/drain-2855-FABLE-Coord-thing',
    'cccccccccccccccccccccccccccccccccccccccc\trefs/heads/worktree-2857-Infra-other-thing',
    'dddddddddddddddddddddddddddddddddddddddd\trefs/heads/backup/stale-local-master-2026',
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\trefs/tags/v1',
    '',
  ].join('\n');
  const ids = planIdsFromRemoteHeads(out);
  assert.deepEqual([...ids.keys()].sort(), ['2855', '2857']);
  // plan 3111: the Map also carries the branch NAMES — what the adopt carve-out matches against.
  // plan 3767: and the sha (collapseSameShaBranches' discriminator).
  assert.deepEqual(ids.get('2855'), [
    {
      name: 'claude/drain-2855-FABLE-Coord-thing',
      sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fresh: false,
      livenessUnknown: false,
      gateBlocked: false,
      status: null,
    },
  ]);
  assert.deepEqual(ids.get('2857'), [
    {
      name: 'worktree-2857-Infra-other-thing',
      sha: 'cccccccccccccccccccccccccccccccccccccccc',
      fresh: false,
      livenessUnknown: false,
      gateBlocked: false,
      status: null,
    },
  ]);
});

test('planIdsFromRemoteHeads: canonicalises ids so a zero-padded slug cannot miss its plan', () => {
  const ids = planIdsFromRemoteHeads(
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/worktree-0912-X-padded',
  );
  assert.ok(ids.has(canonicalPlanId(912)), 'a 0912 branch must match plan 912');
});

test('planIdsFromRemoteHeads: a branch whose id prefix is too short is NOT a plan branch', () => {
  // `\d{3,}` — plan ids are 3+ digits, so `drain-12-…` is some other branch, never a plan execution.
  const ids = planIdsFromRemoteHeads(
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/claude/drain-12-not-a-plan',
  );
  assert.equal(ids.size, 0);
});

test('parseExecutionHeads: keeps shas, de-dupes branch names, and ignores junk', () => {
  const fixture = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/claude/drain-2855-X-one',
    'junk',
    '',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/worktree-2856-X-two',
    'cccccccccccccccccccccccccccccccccccccccc\trefs/tags/worktree-2857-X-tag',
    'dddddddddddddddddddddddddddddddddddddddd\trefs/heads/claude/drain-2855-X-one',
  ].join('\n');
  assert.deepEqual(parseExecutionHeads(fixture), [
    {
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'claude/drain-2855-X-one',
      id: '2855',
    },
    {
      sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      name: 'worktree-2856-X-two',
      id: '2856',
    },
  ]);
});

// --- collapseSameShaBranches (plan 3767) --------------------------------------------------------
// N execution branches at ONE sha are one finished branch, not an unresolved rival: an override
// adopt's normalization push leaves its SOURCE branch on origin whenever the cloud sandbox proxy
// refuses the retirement delete (plan 3756), so a plan can carry e.g. a `claude/drain-<id>-…` AND
// a `worktree-<id>-…` at the IDENTICAL tip with nothing left to decide (the plan-3652 incident).

test('collapseSameShaBranches: a same-sha PAIR collapses to the worktree- name, the other as duplicate', () => {
  const list = [
    { name: 'claude/drain-3652-X', sha: 'abc123', fresh: false, gateBlocked: false, status: null },
    { name: 'worktree-3652-X', sha: 'abc123', fresh: false, gateBlocked: false, status: null },
  ];
  const { branches, duplicates } = collapseSameShaBranches(list);
  assert.deepEqual(branches, [list[1]], 'worktree- wins over claude/drain- among equal shas');
  assert.deepEqual(duplicates, [list[0]]);
});

test('collapseSameShaBranches: worktree- wins regardless of list order', () => {
  const list = [
    { name: 'worktree-3652-X', sha: 'abc123' },
    { name: 'claude/drain-3652-X', sha: 'abc123' },
  ];
  const { branches, duplicates } = collapseSameShaBranches(list);
  assert.deepEqual(branches, [list[0]]);
  assert.deepEqual(duplicates, [list[1]]);
});

test('collapseSameShaBranches: DIFFERENT shas are left UNCHANGED, no duplicates', () => {
  // plan 2855's genuine shape: three branches, three different tips — a human call, never
  // an unattended collapse.
  const list = [
    { name: 'claude/drain-2855-a', sha: 'aaa111' },
    { name: 'worktree-2855-b', sha: 'bbb222' },
  ];
  const r = collapseSameShaBranches(list);
  assert.deepEqual(r, { branches: list, duplicates: [] });
});

test("collapseSameShaBranches: a MISSING sha on ANY entry never collapses (today's behaviour, byte-for-byte)", () => {
  const list = [
    { name: 'claude/drain-3073-X', fresh: false, gateBlocked: false, status: null },
    { name: 'worktree-3073-X', fresh: false, gateBlocked: false, status: null },
  ];
  const r = collapseSameShaBranches(list);
  assert.deepEqual(r, { branches: list, duplicates: [] });
});

// gpt-review fix (plan 3767): a FRESH stake is a LIVE session, and two live sessions can
// legitimately sit at the same sha — a marker staked with `push origin origin/master:<branch>`
// carries the origin/master tip and NO commits of its own, so two rival stakes for one id are
// same-sha by construction while being exactly the "two sessions racing" case the ambiguity
// guard exists for. Same-sha means "one finished branch" only for DEAD heads; a fresh one is
// never folded away.
test('collapseSameShaBranches: a FRESH entry never collapses, even at an identical sha', () => {
  const list = [
    { name: 'claude/drain-3652-X', sha: 'abc123', fresh: true },
    { name: 'worktree-3652-X', sha: 'abc123', fresh: false },
  ];
  const r = collapseSameShaBranches(list);
  assert.deepEqual(r.branches, list, 'the list is returned UNCHANGED');
  assert.deepEqual(r.duplicates, []);
});

test('collapseSameShaBranches: two DEAD same-sha entries still collapse (fresh:false is not fresh)', () => {
  const list = [
    { name: 'claude/drain-3652-X', sha: 'abc123', fresh: false },
    { name: 'worktree-3652-X', sha: 'abc123', fresh: false },
  ];
  const r = collapseSameShaBranches(list);
  assert.deepEqual(
    r.branches.map((b) => b.name),
    ['worktree-3652-X'],
  );
  assert.deepEqual(
    r.duplicates.map((b) => b.name),
    ['claude/drain-3652-X'],
  );
});

test('selectEligible (plan 3767): a FRESH same-sha pair keeps the pre-3767 hands-off answer', () => {
  const onOriginIds = new Map([
    [
      '3652',
      [
        {
          name: 'claude/drain-3652-X',
          sha: 'abc123',
          fresh: true,
          livenessUnknown: false,
          gateBlocked: false,
          status: null,
        },
        { name: 'worktree-3652-X', sha: 'abc123', fresh: true, gateBlocked: false, status: null },
      ],
    ],
  ]);
  const r = selectEligible([meta({ id: 3652 })], { onOriginIds });
  assert.equal(r.excluded[0].exclude, 'already-on-origin');
  assert.equal(
    r.excluded[0].reason,
    handsOffOnOriginReason,
    'a live stake is hands-off, never collapsed into a selectable single branch',
  );
});

test('collapseSameShaBranches: ONE entry with a sha is unchanged (nothing to collapse against)', () => {
  const list = [{ name: 'worktree-3073-X', sha: 'abc123' }];
  const r = collapseSameShaBranches(list);
  assert.deepEqual(r, { branches: list, duplicates: [] });
});

test('planIdsFromRemoteHeads: equals a hand fold of parseExecutionHeads on mixed input', () => {
  const fixture = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/claude/drain-2855-X-one',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/worktree-2855-X-two',
    'cccccccccccccccccccccccccccccccccccccccc\trefs/heads/worktree-2856-X-three',
    'not an ls-remote line',
    '',
    'dddddddddddddddddddddddddddddddddddddddd\trefs/heads/worktree-2855-X-two',
  ].join('\n');
  const handFold = new Map();
  for (const { id, name, sha } of parseExecutionHeads(fixture)) {
    const branches = handFold.get(id);
    const head = {
      name,
      sha,
      fresh: false,
      livenessUnknown: false,
      gateBlocked: false,
      status: null,
    };
    if (branches) branches.push(head);
    else handFold.set(id, [head]);
  }
  assert.deepEqual(planIdsFromRemoteHeads(fixture), handFold);
});

test('selectEligible (plan 2863): a candidate whose id is on origin is EXCLUDED with a reason', () => {
  const metas = [meta({ id: 2855 }), meta({ id: 2900 })];
  const r = selectEligible(metas, { onOriginIds: originMap({ 2855: 'worktree-2855-X-test' }) });
  assert.equal(r.next.slug, '2900-X-test', 'the clean plan is still picked');
  const hit = r.excluded.find((e) => e.slug === '2855-X-test');
  assert.equal(hit.exclude, 'already-on-origin');
  assert.match(hit.reason, /already exists on origin/);
  assert.match(hit.reason, /adopt/, 'the reason names the operator action');
});

test('selectEligible (plan 2863): the gate does NOT mutate the caller metas (stays pure)', () => {
  const metas = [meta({ id: 2855 })];
  selectEligible(metas, { onOriginIds: originMap({ 2855: 'worktree-2855-X-test' }) });
  assert.equal(metas[0].exclude, null, 'the input meta must be untouched');
});

test('selectEligible (plan 2863): absent/empty id-set FAILS OPEN — nothing is excluded', () => {
  const metas = [meta({ id: 2855 })];
  // null = the ls-remote failed (or a non-cloud caller); empty = origin simply has no such branch.
  for (const onOriginIds of [null, undefined, new Map()]) {
    const r = selectEligible(metas, { onOriginIds });
    assert.equal(r.next.slug, '2855-X-test', `must stay eligible for ${onOriginIds}`);
    assert.deepEqual(r.excluded, []);
  }
});

test('selectEligible (plan 2863): a pool excluded ONLY by the origin gate → all_already_on_origin', () => {
  const r = selectEligible([meta({ id: 2855 }), meta({ id: 2858 })], {
    onOriginIds: originMap({ 2855: 'worktree-2855-X-test', 2858: 'worktree-2858-X-test' }),
  });
  assert.equal(r.reason, 'all_already_on_origin');
  assert.notEqual(r.reason, 'all_blocked', 'never misreport adoption-pending work as blocked');
  assert.equal(r.excluded.length, 2);
});

test('selectEligible (plan 2863): mixed with other lifecycle gates → all_fable_or_stub, not all_blocked', () => {
  const r = selectEligible([meta({ id: 2855 }), meta({ id: 2860, exclude: 'stub' })], {
    onOriginIds: originMap({ 2855: 'worktree-2855-X-test' }),
  });
  assert.equal(r.reason, 'all_fable_or_stub');
});

test('selectEligible (plan 2863): the gate never overrides an EXISTING exclusion', () => {
  // A plan already excluded for a stronger reason keeps that reason — the origin gate only ever
  // stamps plans that were otherwise runnable, so no diagnosis is masked.
  const r = selectEligible([meta({ id: 2855, exclude: 'blocked' })], {
    onOriginIds: originMap({ 2855: 'worktree-2855-X-test' }),
  });
  assert.equal(r.excluded[0].exclude, 'blocked');
});

test('originExecutedPlanIds (plan 2863): reads origin ONCE and parses the id-set', () => {
  const calls = [];
  const ids = originExecutedPlanIds('/repo', {
    _exec: (cmd, args) => {
      calls.push([cmd, args]);
      return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/worktree-2861-X-y\n';
    },
    _deadSeed: () => ({ dead: false, ageMs: null, reason: 'carries-work' }),
    log: () => {},
  });
  assert.equal(calls.length, 1, 'ONE ls-remote per firing, never one per candidate');
  assert.deepEqual(calls[0][1], [
    '-C',
    '/repo',
    'ls-remote',
    '--heads',
    'origin',
    'refs/heads/claude/drain-*',
    'refs/heads/worktree-*',
    'refs/heads/claude/status/*',
  ]);
  assert.deepEqual([...ids.keys()], ['2861']);
  assert.deepEqual(ids.get('2861'), [
    {
      name: 'worktree-2861-X-y',
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      fresh: false,
      livenessUnknown: false,
      gateBlocked: false,
      status: null,
    },
  ]);
});

const alreadyOnOriginReason =
  'already-on-origin: an execution branch for this plan id already exists on origin — the work was ' +
  'done by an earlier firing and awaits adoption, not redoing. Adopt it: ' +
  '`cut-worktree.mjs <slug> --adopt` for a `worktree-<slug>` branch, or ' +
  '`cut-worktree.mjs <slug> --adopt=claude/drain-<slug>` for an unclaimed drain branch. ' +
  'If that branch is DEAD work this plan should INHERIT (a cap-killed session re-filed to ready/), ' +
  'stamp it so a drain can take the plan instead of skipping it forever: ' +
  '`node scripts/plan-adopt-branch.mjs <id>` (plan 3111)';

const handsOffOnOriginReason =
  'already-on-origin: this branch carries NO commits of its own and is not yet provably older ' +
  'than the dead-seed threshold of ' +
  `${DEAD_SEED_MIN_AGE_MS / (60 * 60 * 1000)}h, so a drain may be staking it right now — hands ` +
  'off. It is NOT adoptable and NOT deletable; re-check after that threshold. On a ' +
  'PAT-limited account a drain ' +
  'runs UNCLAIMED by design, so the absence of ' +
  '`refs/claims/<id>` is NOT evidence the session is gone.';

// plan 3619 adds `status-heartbeat` — a live drain publishing on the gate-exempt status channel.
// It is the STRONGEST of the three: the other two only fail to prove the session is gone, this one
// is the session actively saying it is alive and holding work it cannot push.
assert.deepEqual([...HANDS_OFF_VERDICT_REASONS].sort(), [
  'age-unknown',
  'fresh',
  'status-heartbeat',
]);

test('originExecutedPlanIds + selectEligible (plan 3583): a fresh empty stake is hands-off', () => {
  const onOriginIds = originExecutedPlanIds('/repo', {
    _exec: () =>
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/claude/drain-3583-Coord-live\n',
    _deadSeed: () => ({ dead: false, ageMs: 2 * 60 * 1000, reason: 'fresh' }),
    log: () => {},
  });
  const result = selectEligible([meta({ id: 3583 })], { onOriginIds });
  assert.equal(result.excluded[0].exclude, 'already-on-origin');
  assert.equal(result.excluded[0].reason, handsOffOnOriginReason);
  assert.match(
    result.excluded[0].reason,
    new RegExp(`${DEAD_SEED_MIN_AGE_MS / (60 * 60 * 1000)}h`),
  );
  assert.doesNotMatch(result.excluded[0].reason, /--adopt/);
  assert.doesNotMatch(result.excluded[0].reason, /--delete/);
});

test('originExecutedPlanIds + selectEligible (plan 3583): a marker staked AT the current origin/master tip is hands-off', () => {
  // The plan-2863 marker writer stakes origin/master itself. At that exact tip the
  // `<tip>..origin/master` ancestry path is empty, so deadSeedVerdict reports age-unknown.
  const onOriginIds = originExecutedPlanIds('/repo', {
    _exec: () =>
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/claude/drain-3583-Coord-live\n',
    _deadSeed: () => ({ dead: false, ageMs: null, reason: 'age-unknown' }),
    log: () => {},
  });
  const result = selectEligible([meta({ id: 3583 })], { onOriginIds });
  assert.equal(result.excluded[0].exclude, 'already-on-origin');
  assert.equal(result.excluded[0].reason, handsOffOnOriginReason);
});

test('originExecutedPlanIds + selectEligible (plan 3583): carries-work and git-error are not hands-off', () => {
  for (const reason of ['carries-work', 'git-error']) {
    const onOriginIds = originExecutedPlanIds('/repo', {
      _exec: () =>
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/claude/drain-3583-Coord-work\n',
      _deadSeed: () => ({ dead: false, ageMs: null, reason }),
      log: () => {},
    });
    const result = selectEligible([meta({ id: 3583 })], { onOriginIds });
    assert.equal(result.excluded[0].reason, alreadyOnOriginReason, reason);
    assert.notEqual(result.excluded[0].reason, handsOffOnOriginReason, reason);
  }
});

test('originExecutedPlanIds + selectEligible (plan 3583): carrying work keeps the old reason byte-for-byte', () => {
  const onOriginIds = originExecutedPlanIds('/repo', {
    _exec: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/worktree-3583-Coord-work\n',
    _deadSeed: () => ({ dead: false, ageMs: null, reason: 'carries-work' }),
    log: () => {},
  });
  const result = selectEligible([meta({ id: 3583 })], { onOriginIds });
  assert.equal(result.excluded[0].exclude, 'already-on-origin');
  assert.equal(result.excluded[0].reason, alreadyOnOriginReason);
});

test('selectEligible (plan 3583): mixed fresh and carrying branches keep the old NOTE byte-for-byte', () => {
  const fresh = 'claude/drain-3583-Coord-live';
  const work = 'worktree-3583-Coord-work';
  const result = selectEligible([meta({ id: 3583 })], {
    onOriginIds: originMap({
      3583: [
        { name: fresh, fresh: true },
        { name: work, fresh: false },
      ],
    }),
  });
  assert.equal(result.excluded[0].exclude, 'already-on-origin');
  assert.equal(
    result.excluded[0].reason,
    `${alreadyOnOriginReason}. NOTE: origin holds 2 execution branches for this id (${fresh}, ${work}) — ` +
      'decide which one is the truth before adopting either.',
  );
});

test('originExecutedPlanIds (plan 2863): an ls-remote failure fails OPEN and warns LOUDLY', () => {
  const logs = [];
  const ids = originExecutedPlanIds('/repo', {
    _exec: () => {
      throw new Error('could not read from remote repository');
    },
    log: (m) => logs.push(m),
  });
  assert.equal(ids, null, 'null = gate off, never a brick-the-drain throw');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /WARNING/);
  assert.match(logs[0], /gate is OFF/);
});

test('originExecutedPlanIds: the default dead-seed verdict receives the injected clock', () => {
  const clockValues = [];
  const ids = originExecutedPlanIds(repoRootFrom(SCRIPTS_DIR), {
    _exec: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/worktree-3517-Infra-clock\n',
    now: () => {
      clockValues.push(123);
      return 123;
    },
    log: () => {},
  });
  assert.deepEqual(
    clockValues,
    [123],
    'the default verdict wrapper must evaluate the injected now',
  );
  assert.deepEqual(ids.get('3517'), [
    {
      name: 'worktree-3517-Infra-clock',
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      fresh: false,
      livenessUnknown: false,
      gateBlocked: false,
      status: null,
    },
  ]);
});

test('originExecutedPlanIds: drops a dead seed and logs its exact cleanup line once', () => {
  const logs = [];
  const ids = originExecutedPlanIds('/repo', {
    _exec: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/worktree-3517-Infra-dead\n',
    _deadSeed: () => ({ dead: true, ageMs: 7 * 60 * 60 * 1000, reason: 'dead' }),
    now: () => 123,
    log: (line) => logs.push(line),
  });
  assert.ok(ids instanceof Map);
  assert.equal(ids.has('3517'), false);
  assert.deepEqual(logs, [
    'queue-drain: ignoring DEAD SEED worktree-3517-Infra-dead (no commits of its own, staked ≥7h ago) — delete it: git push origin --delete worktree-3517-Infra-dead',
  ]);
});

test('originExecutedPlanIds: memoizes a shared dead-seed sha but logs every branch', () => {
  const logs = [];
  const seen = [];
  const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const ids = originExecutedPlanIds('/repo', {
    _exec: () =>
      [
        `${sha}\trefs/heads/claude/drain-3517-Infra-dead-a`,
        `${sha}\trefs/heads/claude/drain-3518-Infra-dead-b`,
      ].join('\n'),
    _deadSeed: (seenSha) => {
      seen.push(seenSha);
      return { dead: true, ageMs: 7 * 60 * 60 * 1000, reason: 'dead' };
    },
    log: (line) => logs.push(line),
  });
  assert.equal(ids.size, 0);
  assert.deepEqual(seen, [sha]);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /claude\/drain-3517-Infra-dead-a/);
  assert.match(logs[1], /claude\/drain-3518-Infra-dead-b/);
});

for (const reason of ['carries-work', 'fresh', 'age-unknown', 'git-error']) {
  test(`originExecutedPlanIds: keeps a non-dead ${reason} head`, () => {
    const ids = originExecutedPlanIds('/repo', {
      _exec: () =>
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/claude/drain-3517-Infra-live\n',
      _deadSeed: () => ({ dead: false, ageMs: reason === 'fresh' ? 1 : null, reason }),
      now: () => 123,
      log: () => {},
    });
    assert.deepEqual(ids.get('3517'), [
      {
        name: 'claude/drain-3517-Infra-live',
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        fresh: HANDS_OFF_VERDICT_REASONS.has(reason),
        // plan 3767 r2: the "could not tell" axis, orthogonal to hands-off — `git-error` is
        // the one reason here that means the probe failed rather than that the head is done.
        livenessUnknown: UNKNOWN_LIVENESS_VERDICT_REASONS.has(reason),
        gateBlocked: false,
        status: null,
      },
    ]);
  });
}

test('originExecutedPlanIds: a verdict throw keeps its head and continues processing others', () => {
  const seen = [];
  const ids = originExecutedPlanIds('/repo', {
    _exec: () =>
      [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/worktree-3517-Infra-throws',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/worktree-3518-Infra-dead',
        'cccccccccccccccccccccccccccccccccccccccc\trefs/heads/worktree-3519-Infra-real',
      ].join('\n'),
    _deadSeed: (sha) => {
      seen.push(sha);
      if (sha.startsWith('a')) throw new Error('predicate failed');
      return { dead: sha.startsWith('b'), ageMs: 8 * 60 * 60 * 1000 };
    },
    now: () => 123,
    log: () => {},
  });
  assert.ok(ids instanceof Map, 'only ls-remote failure may return null');
  assert.deepEqual([...ids.keys()], ['3517', '3519']);
  assert.equal(seen.length, 3, 'a thrown verdict does not abort later heads');
});

test('originExecutedPlanIds + selectEligible: all-dead branches make the plan eligible', () => {
  const onOriginIds = originExecutedPlanIds('/repo', {
    _exec: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/worktree-3517-Infra-dead\n',
    _deadSeed: () => ({ dead: true, ageMs: 6 * 60 * 60 * 1000 }),
    now: () => 123,
    log: () => {},
  });
  const result = selectEligible([meta({ id: 3517 })], { onOriginIds });
  assert.equal(result.next.slug, '3517-X-test');
});

test('originExecutedPlanIds + selectEligible: dead+real becomes the single-branch exclusion', () => {
  const real = 'worktree-3517-Infra-real';
  const onOriginIds = originExecutedPlanIds('/repo', {
    _exec: () =>
      [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/claude/drain-3517-Infra-dead',
        `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/${real}`,
      ].join('\n'),
    _deadSeed: (sha) => ({ dead: sha.startsWith('a'), ageMs: 7 * 60 * 60 * 1000 }),
    now: () => 123,
    log: () => {},
  });
  const result = selectEligible([meta({ id: 3517 })], { onOriginIds });
  assert.equal(result.excluded[0].exclude, 'already-on-origin');
  assert.doesNotMatch(result.excluded[0].reason, /decide which one is the truth/);
  assert.deepEqual(onOriginIds.get('3517'), [
    {
      name: real,
      sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fresh: false,
      livenessUnknown: false,
      gateBlocked: false,
      status: null,
    },
  ]);
});

test('originExecutedPlanIds + selectEligible: a stamp adopts the surviving real branch', () => {
  const real = 'worktree-3517-Infra-real';
  const onOriginIds = originExecutedPlanIds('/repo', {
    _exec: () =>
      [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/claude/drain-3517-Infra-dead',
        `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/${real}`,
      ].join('\n'),
    _deadSeed: (sha) => ({ dead: sha.startsWith('a'), ageMs: 7 * 60 * 60 * 1000 }),
    now: () => 123,
    log: () => {},
  });
  const result = selectEligible([meta({ id: 3517, adoptBranch: real })], { onOriginIds });
  assert.equal(result.next.adoptBranch, real);
  assert.deepEqual(result.excluded, []);
});

test('originExecutedPlanIds: emits exactly one log line for each dropped head', () => {
  const logs = [];
  originExecutedPlanIds('/repo', {
    _exec: () =>
      [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/worktree-3517-Infra-dead',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/worktree-3518-Infra-dead',
      ].join('\n'),
    _deadSeed: () => ({ dead: true, ageMs: 9 * 60 * 60 * 1000 }),
    now: () => 123,
    log: (line) => logs.push(line),
  });
  assert.equal(logs.length, 2);
  assert.equal(logs.filter((line) => line.includes('worktree-3517-Infra-dead')).length, 1);
  assert.equal(logs.filter((line) => line.includes('worktree-3518-Infra-dead')).length, 1);
});

// --- plan 2863 review round 1 -----------------------------------------------------------------

test('planIdsFromRemoteHeads: a LEGACY date-prefixed branch never poisons the id-set', () => {
  // The bug this pins: `\d{3,}` alone matches `worktree-2026-05-17-vetpris-…` and adds id 2026 —
  // while `parsePlanMeta` gives those legacy date-slugged plans id Infinity. The two sides disagree,
  // and `docs/superpowers/plans/archive/2026-FABLE-Price-…` is a REAL plan whose id is 2026, so one
  // unrelated date-slugged branch would have withheld it from every cloud firing.
  const ids = planIdsFromRemoteHeads(
    [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/worktree-2026-05-17-vetpris-retry',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/claude/drain-2026-05-23-record-split',
    ].join('\n'),
  );
  assert.equal(ids.size, 0, 'a date-slugged branch carries no plan id');
});

test('planIdsFromRemoteHeads: a REAL id followed by a letter still matches, bare or suffixed', () => {
  const ids = planIdsFromRemoteHeads(
    [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/claude/drain-2858',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/worktree-2026-FABLE-Price-leak',
      'cccccccccccccccccccccccccccccccccccccccc\trefs/heads/claude/drain-2861-phase-c',
    ].join('\n'),
  );
  assert.deepEqual([...ids.keys()].sort(), ['2026', '2858', '2861']);
});

test('planIdsFromRemoteHeads: a batch worktree branch is not a single-plan marker', () => {
  // `worktree-batch-<date>-<slug>` starts with letters, so it can never be read as a plan id — the
  // documented bound (batch trains are outside this gate) rather than a silent mis-parse.
  const ids = planIdsFromRemoteHeads(
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/worktree-batch-2026-07-27-gt-pill-parity',
  );
  assert.equal(ids.size, 0);
});

test('originExecutedPlanIds: asks origin for ONLY the two execution namespaces', () => {
  let args;
  originExecutedPlanIds('/repo', {
    _exec: (_cmd, a) => {
      args = a;
      return '';
    },
    _deadSeed: () => ({ dead: false, ageMs: null, reason: 'carries-work' }),
    log: () => {},
  });
  assert.ok(args.includes('refs/heads/claude/drain-*'), 'scopes the drain namespace');
  assert.ok(args.includes('refs/heads/worktree-*'), 'scopes the worktree namespace');
});

test('selectEligible: the already-on-origin reason names BOTH adoption commands', () => {
  // A `claude/drain-<slug>` branch needs `--adopt=claude/drain-<slug>`; a bare `--adopt` looks for
  // `origin/worktree-<slug>` and refuses. A reason line naming only the bare form misdirects.
  const r = selectEligible([meta({ id: 2855 })], {
    onOriginIds: originMap({ 2855: 'worktree-2855-X-test' }),
  });
  assert.match(r.excluded[0].reason, /--adopt=claude\/drain-<slug>/);
  assert.match(r.excluded[0].reason, /`cut-worktree\.mjs <slug> --adopt`/);
});

// --- plan 3111: the adopt carve-out ------------------------------------------------------------
// The plan-2863 gate above could not tell a LIVE rival's branch from a DEAD predecessor's HAND-OFF
// and excluded both, so a cap-killed cloud session's plan — deliberately re-filed to ready/ with its
// branch preserved and its body saying CONTINUE IT — was invisible to every cloud drain forever,
// while its exclusion reason told the reader to "adopt it". The only possible adopter WAS the drain
// the gate had just withheld it from (measured live on 3073/3084/3092). These pin the carve-out and,
// just as importantly, that plan 2863's protection is otherwise untouched.

test('planIdsFromRemoteHeads (plan 3111): TWO branches for one id are both carried, in order', () => {
  const ids = planIdsFromRemoteHeads(
    [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/claude/drain-2855-X-test',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/worktree-2855-X-test',
    ].join('\n'),
  );
  assert.deepEqual(ids.get('2855'), [
    {
      name: 'claude/drain-2855-X-test',
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      fresh: false,
      livenessUnknown: false,
      gateBlocked: false,
      status: null,
    },
    {
      name: 'worktree-2855-X-test',
      sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fresh: false,
      livenessUnknown: false,
      gateBlocked: false,
      status: null,
    },
  ]);
});

test('planIdsFromRemoteHeads (plan 3111): a repeated branch name is de-duped', () => {
  // The ambiguity COUNT is a decision input now (>1 ⇒ adopt-ambiguous), so a duplicate line must
  // not manufacture ambiguity out of one branch.
  const line = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/worktree-2855-X-test';
  const ids = planIdsFromRemoteHeads([line, line].join('\n'));
  assert.deepEqual(ids.get('2855'), [
    {
      name: 'worktree-2855-X-test',
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      fresh: false,
      livenessUnknown: false,
      gateBlocked: false,
      status: null,
    },
  ]);
});

test('selectEligible (plan 3111): a stamp matching origin SELECTS the plan and carries the branch', () => {
  const r = selectEligible([meta({ id: 3073, adoptBranch: 'worktree-3073-App-no-prices' })], {
    onOriginIds: originMap({ 3073: 'worktree-3073-App-no-prices' }),
  });
  assert.equal(r.reason, undefined, 'the deadlock is gone: the plan is runnable');
  assert.equal(r.next.slug, '3073-X-test');
  assert.equal(
    r.next.adoptBranch,
    'worktree-3073-App-no-prices',
    'the payload must name the branch to continue, or the taker cuts a fresh one and redoes the work',
  );
  assert.deepEqual(r.excluded, []);
});

test('selectEligible (plan 3111): plan 2863 is INTACT — an UNSTAMPED plan on origin is still excluded', () => {
  // The regression guard for the carve-out ever being widened: no stamp, branch on origin ⇒
  // already-on-origin, byte-identical to the pre-3111 behaviour.
  const r = selectEligible([meta({ id: 3073 })], {
    onOriginIds: originMap({ 3073: 'worktree-3073-App-no-prices' }),
  });
  assert.equal(r.excluded[0].exclude, 'already-on-origin');
  assert.equal(r.reason, 'all_already_on_origin');
  assert.equal(r.next, undefined);
});

test('selectEligible (plan 3111): a stamp naming a branch origin no longer carries is INERT', () => {
  // The branch landed and was torn down, so the id is not in the map at all: no exclusion fires and
  // the plan is picked normally. Asserted explicitly so a future refactor cannot turn an inert
  // stamp into an exclusion (which would deadlock the plan the other way round).
  const r = selectEligible([meta({ id: 3073, adoptBranch: 'worktree-3073-App-no-prices' })], {
    onOriginIds: originMap({ 2999: 'worktree-2999-X-other' }),
  });
  assert.equal(r.next.slug, '3073-X-test');
  assert.deepEqual(r.excluded, []);
});

test('selectEligible (plan 3111): a stamp plus a SECOND branch on origin → adopt-ambiguous naming both', () => {
  const branches = ['claude/drain-3073-App-no-prices', 'worktree-3073-App-no-prices'];
  const r = selectEligible([meta({ id: 3073, adoptBranch: 'worktree-3073-App-no-prices' })], {
    onOriginIds: originMap({ 3073: branches }),
  });
  assert.equal(r.excluded[0].exclude, 'adopt-ambiguous');
  for (const b of branches) assert.ok(r.excluded[0].reason.includes(b), `names ${b}`);
  assert.equal(r.next, undefined);
});

// --- selectEligible: same-sha collapse vs. genuine divergence (plan 3767) ------------------------
// The 3652 fixture (T5's live incident): a `claude/drain-3652-…` and a `worktree-3652-…` at the
// IDENTICAL tip. The 2855 fixture (plan 3111's original motivating case): three branches, three
// different tips — still a human call, unchanged.

test('selectEligible (plan 3767): the 3652 fixture — a same-sha pair, stamped on the worktree- name, SELECTS', () => {
  const onOriginIds = new Map([
    [
      '3652',
      [
        {
          name: 'claude/drain-3652-X',
          sha: 'abc123',
          fresh: false,
          livenessUnknown: false,
          gateBlocked: false,
          status: null,
        },
        { name: 'worktree-3652-X', sha: 'abc123', fresh: false, gateBlocked: false, status: null },
      ],
    ],
  ]);
  const r = selectEligible([meta({ id: 3652, adoptBranch: 'worktree-3652-X' })], { onOriginIds });
  assert.equal(r.reason, undefined, 'the deadlock is gone: the plan is runnable');
  assert.deepEqual(r.excluded, []);
  assert.equal(r.next.adoptBranch, 'worktree-3652-X', 'the payload names the branch to continue');
});

test('selectEligible (plan 3767): the 3652 fixture stamped on the RETIRED (claude/drain-) name still SELECTS', () => {
  // T1's retire delete is refused inside a cloud sandbox (plan 3756), so the branch a prior
  // stamp names can be exactly the one the collapse just folded away — a match against
  // EITHER name in the same-sha set must count, never force a re-stamp onto the preferred one.
  const onOriginIds = new Map([
    [
      '3652',
      [
        {
          name: 'claude/drain-3652-X',
          sha: 'abc123',
          fresh: false,
          livenessUnknown: false,
          gateBlocked: false,
          status: null,
        },
        { name: 'worktree-3652-X', sha: 'abc123', fresh: false, gateBlocked: false, status: null },
      ],
    ],
  ]);
  const r = selectEligible([meta({ id: 3652, adoptBranch: 'claude/drain-3652-X' })], {
    onOriginIds,
  });
  assert.equal(r.reason, undefined);
  assert.deepEqual(r.excluded, []);
  assert.equal(
    r.next.adoptBranch,
    'claude/drain-3652-X',
    'the stamp is carried through UNCHANGED — never rewritten to the preferred name',
  );
});

test('selectEligible (plan 3767): the SAME 3652 fixture, UNSTAMPED, excludes already-on-origin naming ONE branch — never "decide which"', () => {
  const onOriginIds = new Map([
    [
      '3652',
      [
        {
          name: 'claude/drain-3652-X',
          sha: 'abc123',
          fresh: false,
          livenessUnknown: false,
          gateBlocked: false,
          status: null,
        },
        { name: 'worktree-3652-X', sha: 'abc123', fresh: false, gateBlocked: false, status: null },
      ],
    ],
  ]);
  const r = selectEligible([meta({ id: 3652 })], { onOriginIds });
  assert.equal(r.excluded[0].exclude, 'already-on-origin');
  assert.doesNotMatch(r.excluded[0].reason, /decide which one is the truth/);
  assert.match(
    r.excluded[0].reason,
    /origin also carries claude\/drain-3652-X at the same tip/,
    'the collapsed duplicate is still named, as a footnote',
  );
});

test('selectEligible (plan 3767): the 2855 fixture — DIVERGENT shas stay adopt-ambiguous with the "decide which" NOTE', () => {
  const onOriginIds = new Map([
    [
      '2855',
      [
        {
          name: 'claude/drain-2855-vocabulary',
          sha: 'c3684afbf',
          fresh: false,
          livenessUnknown: false,
          gateBlocked: false,
          status: null,
        },
        {
          name: 'worktree-2855-across-persistence-boundaries',
          sha: '2a42e1435',
          fresh: false,
          livenessUnknown: false,
          gateBlocked: false,
          status: null,
        },
      ],
    ],
  ]);
  const r = selectEligible(
    [meta({ id: 2855, adoptBranch: 'worktree-2855-across-persistence-boundaries' })],
    { onOriginIds },
  );
  assert.equal(r.excluded[0].exclude, 'adopt-ambiguous');
  assert.match(r.excluded[0].reason, /which one a taker should continue is a human call/);
});

test('selectEligible (plan 3767): DIFFERENT shas on an UNSTAMPED id keep the "decide which" NOTE, unchanged', () => {
  const onOriginIds = new Map([
    [
      '2855',
      [
        {
          name: 'claude/drain-2855-a',
          sha: 'aaa111',
          fresh: false,
          livenessUnknown: false,
          gateBlocked: false,
          status: null,
        },
        { name: 'worktree-2855-b', sha: 'bbb222', fresh: false, gateBlocked: false, status: null },
      ],
    ],
  ]);
  const r = selectEligible([meta({ id: 2855 })], { onOriginIds });
  assert.equal(r.excluded[0].exclude, 'already-on-origin');
  assert.match(r.excluded[0].reason, /decide which one is the truth before adopting either/);
});

test('selectEligible (plan 3111): a pool of only ambiguous plans → all_adopt_ambiguous', () => {
  const r = selectEligible(
    [
      meta({ id: 3073, adoptBranch: 'worktree-3073-X' }),
      meta({ id: 3084, adoptBranch: 'worktree-3084-X' }),
    ],
    {
      onOriginIds: originMap({
        3073: ['worktree-3073-X', 'claude/drain-3073-X'],
        3084: ['worktree-3084-X', 'claude/drain-3084-X'],
      }),
    },
  );
  assert.equal(r.reason, 'all_adopt_ambiguous');
  assert.notEqual(
    r.reason,
    'all_already_on_origin',
    'the operator action differs — adopt vs decide',
  );
  assert.notEqual(r.reason, 'all_blocked');
});

test('selectEligible (plan 3111): adopt-ambiguous MIXED with a lifecycle gate → all_fable_or_stub', () => {
  const r = selectEligible(
    [meta({ id: 3073, adoptBranch: 'worktree-3073-X' }), meta({ id: 3080, exclude: 'stub' })],
    { onOriginIds: originMap({ 3073: ['worktree-3073-X', 'claude/drain-3073-X'] }) },
  );
  assert.equal(r.reason, 'all_fable_or_stub', 'never the outright-wrong all_blocked');
});

test('selectEligible (plan 3111): a STALE stamp (origin carries a different branch) still excludes', () => {
  // The carve-out fires on an EXACT name match only — that is what stops a stale sticker from
  // waving a live rival's branch through.
  const r = selectEligible([meta({ id: 3073, adoptBranch: 'worktree-3073-old-attempt' })], {
    onOriginIds: originMap({ 3073: 'claude/drain-3073-fresh-rival' }),
  });
  assert.equal(r.excluded[0].exclude, 'already-on-origin');
  assert.match(r.excluded[0].reason, /STALE/);
  assert.ok(
    r.excluded[0].reason.includes('claude/drain-3073-fresh-rival'),
    'names what origin has',
  );
});

test('selectEligible (plan 3111): the carve-out does NOT resurrect a plan excluded for another reason', () => {
  const r = selectEligible(
    [meta({ id: 3073, adoptBranch: 'worktree-3073-X', exclude: 'blocked' })],
    { onOriginIds: originMap({ 3073: 'worktree-3073-X' }) },
  );
  assert.equal(r.excluded[0].exclude, 'blocked');
  assert.equal(r.next, undefined);
});

test('toItem (plan 3111): adoptBranch is absent from the payload when the plan carries no stamp', () => {
  const r = selectEligible([meta({ id: 3073 })], { onOriginIds: null });
  assert.ok(!('adoptBranch' in r.next), 'an optional field must not appear as null on every plan');
});

// plan 3461 round 3: `toItem()` used to default a missing `m.lane` to 'sonnet' as "defense in
// depth". That default was backwards — a real `parsePlanMeta` output always carries a non-null
// lane by construction (an unresolvable execModel excludes the plan before it ever becomes a
// candidate), so a candidate reaching `toItem()` with no lane means the invariant itself broke,
// not that this plan happens to be an ordinary sonnet plan. Silently stamping 'sonnet' there
// would misroute a non-sonnet plan to the wrong worker tier — exactly the failure class round 2
// closed system-wide — so the fallback is now a loud throw instead.
test('toItem (plan 3461 round 3): a candidate with no resolved lane throws, never defaults to sonnet', () => {
  assert.throws(
    () => selectEligible([meta({ id: 9100, lane: null })], { landingHeld: false }),
    /invariant violated.*9100-X-test.*unrecognized lane/s,
  );
});

// plan 3461 round 4 (review finding): round 3's guard only checked TRUTHINESS (`!m.lane`), so a
// garbage string — a typo like 'sonnett', or any value that isn't a real lane — sailed straight
// through as if it had been resolved, reaching every consumer as a "real" lane. The guard must
// check RECOGNITION (membership in EXEC_LANE_TABLE), not mere presence.
test('toItem (plan 3461 round 4): a candidate with an unrecognized lane STRING throws, never passes through as real', () => {
  assert.throws(
    () => selectEligible([meta({ id: 9102, lane: 'sonnett' })], { landingHeld: false }),
    /invariant violated.*9102-X-test.*unrecognized lane.*"sonnett"/s,
  );
});

// plan 3461 round 5 (finding 186aba, CONFIRMED): round 4's guard checked membership via
// `Object.prototype.hasOwnProperty.call(EXEC_LANE_TABLE, m.lane)` alone, which COERCES its
// second argument to a property key before the lookup — so a non-string `m.lane` whose
// `toString()` resolves to a real lane name sails through as if it were a genuine string lane.
// It then reaches `local-drain-filter.mjs` as an object, which does not satisfy that module's
// own `typeof e.lane === 'string'` check and falls back to the requested POOL label instead —
// silently dispatching a sol plan to a Sonnet or Fable worker. `typeof m.lane === 'string'` must
// be checked explicitly; membership alone is not enough.
test('toItem (plan 3461 round 5): a non-string lane that coerces to a real lane name still throws', () => {
  const fakeLane = { toString: () => 'sol' };
  assert.throws(
    () => selectEligible([meta({ id: 9103, lane: fakeLane })], { landingHeld: false }),
    /invariant violated.*9103-X-test.*unrecognized lane.*typeof object/s,
  );
});

test("toItem (plan 3461 round 3): the plan's OWN lane is carried through verbatim, not re-defaulted", () => {
  const r = selectEligible([meta({ id: 9101, lane: 'fable' })], { landingHeld: false });
  assert.equal(r.next.lane, 'fable', 'a non-sonnet lane must survive toItem() unchanged');
  assert.equal(r.eligible[0].lane, 'fable');
});

// plan 3960 review fix (findings 3/5): listReadyBlobsFromOrigin used to run `git ls-tree`
// against the LITERAL `docs/superpowers/plans/ready` regardless of a configured `lanes.ready`
// rename — so origin-mode scanning could find no plans at all under a renamed lane, reporting an
// empty queue despite plans existing there. Proven with a REAL isolated repo whose
// coord.config.json renames the lane, a fresh module graph (module-scope READY_FOLDER is resolved
// once at import) — `_exec` is still faked so the test proves the ARGV construction without a real
// git object store.
test('listReadyBlobsFromOrigin: a configured lanes.ready rename reaches the origin git ls-tree scan (findings 3/5)', () => {
  const repo = makeIsolatedRepo({
    prefix: 'qdrain-ready-lane',
    startFolder: 'queue',
    basename: '9500-Other-renamed-lane.md',
    body: plan({ extra: '> 💰 **Cost forecast:** $0' }),
  });
  try {
    writeFileSync(
      join(repo.dir, 'coord.config.json'),
      JSON.stringify({ lanes: { ready: 'queue' } }),
    );
    // plan 3816 fix round precedent: import the module by a STRING LITERAL, never via
    // `process.argv[1]` — queue-drain.mjs carries a CLI entry guard
    // (`import.meta.url === pathToFileURL(process.argv[1]).href`) that fires its own real
    // `main()` origin scan the instant a positional arg equals ITS OWN path, which is exactly
    // what passing the module path as an extra argv entry would do.
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        [
          `import(${JSON.stringify(pathToFileURL(repo.toolPath('queue-drain.mjs')).href)}).then((m) => {`,
          '  let captured = null;',
          "  m.listReadyBlobsFromOrigin('/fake-repo', 'deadbeef', {",
          '    _exec: (cmd, args) => { captured = args; return ""; },',
          '  });',
          '  process.stdout.write(JSON.stringify({ args: captured }));',
          '});',
        ].join('\n'),
      ],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    assert.equal(probe.status, 0, probe.stderr);
    const { args } = JSON.parse(probe.stdout.trim());
    assert.deepEqual(
      args.slice(-2),
      ['--', 'docs/superpowers/plans/queue'],
      `origin scan must target the CONFIGURED ready folder, not the literal "ready" — got ${JSON.stringify(args)}`,
    );
  } finally {
    repo.cleanup();
  }
});

// plan 3960 review fix (findings 4/17): `toItem()`'s emitted `path` and batch close-out's
// `memberPaths` used to hardcode `docs/superpowers/plans/ready/...` even after the origin scan
// above started honouring `lanes.ready` — so origin mode could find plans under a renamed lane
// while still handing the driver a path under the OLD, nonexistent one, which
// local-drain-filter.mjs's `exists(e.path)` check then drops as ENOENT. Proven the same way: a
// real isolated repo's coord.config.json renames the lane, a fresh module graph, `selectEligible`
// (pure — no git/filesystem of its own) is called directly.
test('selectEligible/toItem: emitted plan path uses the CONFIGURED ready folder (findings 4/17)', () => {
  const repo = makeIsolatedRepo({
    prefix: 'qdrain-ready-lane-path',
    startFolder: 'queue',
    basename: '9501-Other-renamed-lane.md',
    body: plan({ extra: '> 💰 **Cost forecast:** $0' }),
  });
  try {
    writeFileSync(
      join(repo.dir, 'coord.config.json'),
      JSON.stringify({ lanes: { ready: 'queue' } }),
    );
    // plan 3816 fix round precedent: import by STRING LITERAL, never `process.argv[1]` — see
    // the sibling listReadyBlobsFromOrigin test above for why (queue-drain.mjs's CLI guard).
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        [
          `import(${JSON.stringify(pathToFileURL(repo.toolPath('queue-drain.mjs')).href)}).then((m) => {`,
          '  const meta = {',
          '    id: 9501,',
          "    slug: '9501-X-test',",
          "    seedWrite: 'no',",
          '    blockedBy: null,',
          '    cost: m.parseCost(null),',
          '    exclude: null,',
          '    staleBlockedBy: null,',
          '    batchHold: null,',
          '    adoptBranch: null,',
          "    lane: 'sonnet',",
          '  };',
          '  const r = m.selectEligible([meta], { landingHeld: false });',
          '  process.stdout.write(JSON.stringify({ path: r.next && r.next.path }));',
          '});',
        ].join('\n'),
      ],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    assert.equal(probe.status, 0, probe.stderr);
    const { path } = JSON.parse(probe.stdout.trim());
    assert.equal(
      path,
      'docs/superpowers/plans/queue/9501-X-test.md',
      'toItem() must emit a path under the CONFIGURED ready folder, not the literal "ready"',
    );
  } finally {
    repo.cleanup();
  }
});

test('selectEligible (plan 3111 review, finding 4): an UNSTAMPED id with TWO origin branches names both', () => {
  // The gate must still exclude (plan 2863 is right here regardless — there is no stamp to
  // discriminate on), but a reason that says "adopt it" while withholding that there is more
  // than one "it" can send a reader at the wrong rival branch.
  const branches = ['claude/drain-3073-X', 'worktree-3073-X'];
  const r = selectEligible([meta({ id: 3073 })], { onOriginIds: originMap({ 3073: branches }) });
  assert.equal(r.excluded[0].exclude, 'already-on-origin');
  for (const b of branches) assert.ok(r.excluded[0].reason.includes(b), `names ${b}`);
  assert.match(r.excluded[0].reason, /decide which one is the truth/);
});

test('selectEligible (plan 3111 review, finding 4): ONE branch keeps the pre-3111 reason exactly', () => {
  const one = selectEligible([meta({ id: 3073 })], {
    onOriginIds: originMap({ 3073: 'worktree-3073-X' }),
  });
  assert.ok(
    !/NOTE: origin holds/.test(one.excluded[0].reason),
    'no multi-branch note on one branch',
  );
  assert.match(one.excluded[0].reason, /already exists on origin/);
});

// --- plan 3341 / reversed by plan 3461: execModel: sol — a third lane. Plan 3341 made it
// drain-claimable by NEITHER --lane and NEVER environment-admitted on trusted cloud. Plan
// 3461 (operator ruling 2026-08-26, "I want plans that can be run by Sol to be Sol by
// default from now on") flips the LANE axis: `sol` is now drain-claimable and lane-agnostic
// — admitted under BOTH --lane sonnet and --lane fable, on LOCAL and full-egress cloud alike.
// The load-bearing property under test is now the ENVIRONMENT axis, which plan 3461 left
// untouched: a `sol` plan is still permanently refused on trusted/limited-egress cloud (no
// route to api.openai.com), by its own named environment reason — never silently admitted,
// and never silently mis-bucketed as a generic lane refusal now that the lane itself admits
// it everywhere else.

test('parsePlanMeta: execModel: sol is ADMITTED to the default (sonnet) LOCAL drain (plan 3461 — sol is drain-claimable and lane-agnostic)', () => {
  const m = parsePlanMeta('3341-Infra-sol-shape.md', planFm(['execModel: sol', 'stage: specced']));
  assert.equal(m.execModel, 'sol');
  assert.equal(m.exclude, null);
  assert.equal(m.excludeReason, null);
});

test('parsePlanMeta fableLane: execModel: sol is ALSO admitted to the fable lane — sol has no --lane value of its own, it rides both (plan 3461)', () => {
  const m = parsePlanMeta(
    '3342-Infra-sol-in-fable-lane.md',
    planFm(['execModel: sol', 'stage: specced']),
    { fableLane: true },
  );
  assert.equal(m.exclude, null);
  assert.equal(m.excludeReason, null);
});

test('parsePlanMeta cloudOnly (trusted, default): execModel: sol is still excluded by its OWN environment reason — the LANE gate no longer refuses it, but the ENV axis is unchanged by plan 3461', () => {
  const m = parsePlanMeta(
    '3343-Infra-sol-trusted-cloud.md',
    planFm(['execModel: sol', 'stage: specced', 'cloudExec: true']),
    { cloudOnly: true },
  );
  assert.equal(m.exclude, 'sol-env-trusted');
  assert.match(m.excludeReason, /api\.openai\.com/);
  assert.match(m.excludeReason, /trusted\/limited-egress/);
});

// plan 3380 lifted SOL_FULL_EGRESS_CLOUD_SUPPORTED (the environment refusal on full-egress
// cloud), and plan 3461 lifted the LANE refusal that used to catch a `sol` plan after the
// env axis cleared. So a full/browser render is now fully ADMITTED — neither axis excludes.
test('parsePlanMeta cloudOnly+fullEnv: execModel: sol is ADMITTED — the ENV axis cleared since plan 3380 and the LANE axis cleared since plan 3461', () => {
  const m = parsePlanMeta(
    '3344-Infra-sol-full-cloud.md',
    planFm(['execModel: sol', 'stage: specced', 'cloudExec: true']),
    { cloudOnly: true, lane: 'full' },
  );
  assert.equal(m.exclude, null);
  assert.equal(m.excludeReason, null);
});

test('parsePlanMeta cloudOnly+browserEnv: execModel: sol is ADMITTED — browser is a SUPERSET of full, so it clears the same cleared env+lane axes', () => {
  const m = parsePlanMeta(
    '3345-Infra-sol-browser-cloud.md',
    planFm(['execModel: sol', 'stage: specced', 'cloudExec: true']),
    { cloudOnly: true, lane: 'browser' },
  );
  assert.equal(m.exclude, null);
  assert.equal(m.excludeReason, null);
});

test('parsePlanMeta: execModel: sol is UNAFFECTED by the environment axis without cloudOnly — LOCAL admits it on both axes (plan 3461)', () => {
  const m = parsePlanMeta('3346-Infra-sol-local.md', planFm(['execModel: sol', 'stage: specced']));
  // Not one of the cloud-only env exclude codes, and not excluded at all — LOCAL never
  // even evaluates solEnvExclusion (cloudOnly is false), and the lane gate now admits it.
  assert.notEqual(m.exclude, 'sol-env-trusted');
  assert.notEqual(m.exclude, 'sol-env-full-unproven');
  assert.equal(m.exclude, null);
});

test('parsePlanMeta cloudOnly: cloud-safety (cloudExec) still gates FIRST, ahead of the sol env axis', () => {
  const m = parsePlanMeta(
    '3347-Infra-sol-unstamped-cloud.md',
    planFm(['execModel: sol', 'stage: specced']), // no cloudExec: true
    { cloudOnly: true },
  );
  assert.equal(m.exclude, 'cloud');
});

test('parsePlanMeta: an unrecognized execModel value excludes as exec-lane-malformed — it must NEVER silently join the sonnet pool (the exact misroute plan 3341 exists to close off)', () => {
  const m = parsePlanMeta(
    '3348-Infra-typo-execmodel.md',
    planFm(['execModel: sonnet-high', 'stage: specced']),
  );
  assert.equal(m.exclude, 'exec-lane-malformed');
  assert.match(m.excludeReason, /sonnet-high/);
});

test('selectEligible: a pool excluded only by the sol ENV axis (trusted cloud) -> all_fable_or_stub (lifecycle, not blocked)', () => {
  const solTrustedCloud = parsePlanMeta(
    '3350-Infra-sol-b.md',
    planFm(['execModel: sol', 'stage: specced', 'cloudExec: true']),
    { cloudOnly: true },
  );
  const r = selectEligible([solTrustedCloud], { landingHeld: false });
  assert.equal(r.reason, 'all_fable_or_stub');
});

test('selectEligible: an all-sol LOCAL pool is fully eligible, not excluded at all (plan 3461 reverses the pre-3461 all_fable_or_stub bucket for this case)', () => {
  const solLocal = parsePlanMeta(
    '3349-Infra-sol-a.md',
    planFm(['execModel: sol', 'stage: specced']),
  );
  const r = selectEligible([solLocal], { landingHeld: false });
  assert.equal(r.excluded.length, 0);
  assert.equal(r.eligible.length, 1);
});

// ── plan 3619: a gate-blocked drain is its own state, not "never started" ──
//
// The 2026-09-01 plan-3595 stall: a live drain held 4 finished commits ~3.5h behind a failing
// scripts-battery gate, and because the ONLY channel for a drain's state is a successful push, its
// stake marker on origin was byte-identical to one belonging to a session that never started. The
// oracle read it as `already-on-origin … hands off` and the dead-seed clock counted toward freeing
// the plan for a SECOND drain to redo the work. These tests pin the new, distinct state.

const GATE_BLOCKED_STATUS = {
  slug: '3595-SOL-Infra-recurring-oneoff-archive-sweep',
  planId: '3595',
  branch: 'claude/drain-3595-SOL-Infra-recurring-oneoff-archive-sweep',
  blockedOn: 'scripts-battery',
  heldCommits: 4,
  session: 'cse_01DypFRSuzjnWGnLodeBDWiC',
  heartbeatMs: Date.parse('2026-09-01T20:40:00Z'),
};

const statusLsRemote = (id, slug) =>
  `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/claude/drain-${slug}\n` +
  `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/claude/status/${slug}\n`;

test('originExecutedPlanIds (plan 3619): the status namespace rides the SAME single ls-remote', () => {
  // The one-round-trip property plan 2863 established must survive: a third refspec pattern, not a
  // third network call.
  const calls = [];
  originExecutedPlanIds('/repo', {
    _exec: (cmd, args) => {
      calls.push(args);
      return '';
    },
    _readStatuses: () => new Map(),
    _deadSeed: () => ({ dead: false, ageMs: null, reason: 'carries-work' }),
    log: () => {},
  });
  assert.equal(calls.length, 1, 'ONE ls-remote per firing');
  assert.deepEqual(calls[0], [
    '-C',
    '/repo',
    'ls-remote',
    '--heads',
    'origin',
    'refs/heads/claude/drain-*',
    'refs/heads/worktree-*',
    'refs/heads/claude/status/*',
  ]);
});

test('originExecutedPlanIds (plan 3619): a fresh heartbeat reaches deadSeedVerdict and marks the head gate-blocked', () => {
  const seen = [];
  const ids = originExecutedPlanIds('/repo', {
    _exec: () => statusLsRemote('3595', GATE_BLOCKED_STATUS.slug),
    _readStatuses: () => new Map([['3595', GATE_BLOCKED_STATUS]]),
    _deadSeed: (sha, statusHeartbeatMs) => {
      seen.push(statusHeartbeatMs);
      return { dead: false, ageMs: 60_000, reason: 'status-heartbeat' };
    },
    log: () => {},
  });
  assert.deepEqual(seen, [GATE_BLOCKED_STATUS.heartbeatMs], 'the heartbeat is passed through');
  const branches = ids.get('3595');
  assert.equal(branches.length, 1);
  assert.equal(branches[0].gateBlocked, true);
  assert.equal(branches[0].fresh, true, 'gate-blocked is also hands-off');
  assert.equal(branches[0].status.blockedOn, 'scripts-battery');
});

test('originExecutedPlanIds (plan 3619): the verdict memo is keyed by (sha, heartbeat), not sha alone', () => {
  // Two heads at the SAME tip belonging to DIFFERENT plans is the ordinary case (a marker and a
  // worktree branch staked at master). Keying the memo on sha alone would let the first head's
  // status decide the second head's verdict.
  const shaShared = 'a'.repeat(40);
  const heartbeats = [];
  const ids = originExecutedPlanIds('/repo', {
    _exec: () =>
      `${shaShared}\trefs/heads/claude/drain-3595-SOL-Infra-x\n` +
      `${shaShared}\trefs/heads/worktree-3600-Coord-y\n`,
    _readStatuses: () => new Map([['3595', GATE_BLOCKED_STATUS]]),
    _deadSeed: (_sha, statusHeartbeatMs) => {
      heartbeats.push(statusHeartbeatMs);
      return statusHeartbeatMs
        ? { dead: false, ageMs: 60_000, reason: 'status-heartbeat' }
        : { dead: false, ageMs: 120_000, reason: 'fresh' };
    },
    log: () => {},
  });
  assert.deepEqual(heartbeats, [GATE_BLOCKED_STATUS.heartbeatMs, null], 'both heads were judged');
  assert.equal(ids.get('3595')[0].gateBlocked, true);
  assert.equal(ids.get('3600')[0].gateBlocked, false, 'the other plan is NOT gate-blocked');
});

test('originExecutedPlanIds (plan 3619): an unreadable status channel degrades to the pre-3619 path', () => {
  const logged = [];
  const ids = originExecutedPlanIds('/repo', {
    _exec: () => statusLsRemote('3595', GATE_BLOCKED_STATUS.slug),
    _readStatuses: () => {
      throw new Error('status fetch exploded');
    },
    _deadSeed: (_sha, hb) => {
      assert.equal(hb, null, 'no status ⇒ no heartbeat, exactly as before this plan');
      return { dead: false, ageMs: 120_000, reason: 'fresh' };
    },
    log: (m) => logged.push(m),
  });
  assert.equal(ids.get('3595')[0].gateBlocked, false);
  assert.equal(ids.get('3595')[0].fresh, true);
  assert.match(logged.join('\n'), /drain statuses unreadable/);
});

test('selectEligible (plan 3619): a gate-blocked marker renders DISTINCTLY from a never-started one', () => {
  const gateBlocked = selectEligible([meta({ id: 3595 })], {
    onOriginIds: new Map([
      [
        '3595',
        [
          {
            name: GATE_BLOCKED_STATUS.branch,
            fresh: true,
            livenessUnknown: false,
            gateBlocked: true,
            status: GATE_BLOCKED_STATUS,
          },
        ],
      ],
    ]),
  });
  assert.equal(gateBlocked.excluded[0].exclude, 'gate-blocked');
  assert.notEqual(
    gateBlocked.excluded[0].exclude,
    'already-on-origin',
    'the whole point: it must not read as a plan awaiting adoption or a threshold',
  );

  // The same marker WITHOUT a heartbeat is the old, indistinguishable state — the control.
  const neverStarted = selectEligible([meta({ id: 3595 })], {
    onOriginIds: new Map([
      [
        '3595',
        [{ name: GATE_BLOCKED_STATUS.branch, fresh: true, gateBlocked: false, status: null }],
      ],
    ]),
  });
  assert.equal(neverStarted.excluded[0].exclude, 'already-on-origin');
  assert.notEqual(neverStarted.excluded[0].reason, gateBlocked.excluded[0].reason);
});

test('selectEligible (plan 3619): the gate-blocked reason names the held commits, the gate and the session', () => {
  // The reason string IS the operator-facing surface: the ready-board renders the exclude code in
  // its Cloud cell and this text as the footnote, so everything a human needs to act has to be here.
  const r = selectEligible([meta({ id: 3595 })], {
    onOriginIds: new Map([
      [
        '3595',
        [
          {
            name: GATE_BLOCKED_STATUS.branch,
            fresh: true,
            livenessUnknown: false,
            gateBlocked: true,
            status: GATE_BLOCKED_STATUS,
          },
        ],
      ],
    ]),
  });
  const reason = r.excluded[0].reason;
  assert.match(reason, /4 commits/);
  assert.match(reason, /scripts-battery/);
  assert.match(reason, /cse_01DypFRSuzjnWGnLodeBDWiC/);
  assert.match(reason, /claude\/status\/3595-SOL-Infra-recurring-oneoff-archive-sweep/);
  // The WORK branch too (review fix): the reader's next move is to look at the held commits, and
  // pointing only at the heartbeat left them to guess where those are.
  assert.match(
    reason,
    /Its work is on `claude\/drain-3595-SOL-Infra-recurring-oneoff-archive-sweep`/,
  );
  assert.match(reason, /NOT a dead seed/);
});

test('selectEligible (plan 3619): a gate-blocked marker outranks an adoptBranch stamp', () => {
  // A stamp says "this branch is DEAD work, inherit it". A live heartbeat says the opposite, and
  // the heartbeat is the fresher evidence — waving a drain into a worktree on top of a session that
  // is still working is precisely the double-execution this whole gate exists to prevent.
  const r = selectEligible([meta({ id: 3595, adoptBranch: GATE_BLOCKED_STATUS.branch })], {
    onOriginIds: new Map([
      [
        '3595',
        [
          {
            name: GATE_BLOCKED_STATUS.branch,
            fresh: true,
            livenessUnknown: false,
            gateBlocked: true,
            status: GATE_BLOCKED_STATUS,
          },
        ],
      ],
    ]),
  });
  assert.equal(r.excluded[0].exclude, 'gate-blocked');
  assert.equal(r.next, undefined, 'the adopt carve-out must NOT hand this plan out');
});

test('selectEligible (plan 3619): the singular held-commit count reads naturally', () => {
  const r = selectEligible([meta({ id: 3595 })], {
    onOriginIds: new Map([
      [
        '3595',
        [
          {
            name: 'claude/drain-3595-x',
            fresh: true,
            livenessUnknown: false,
            gateBlocked: true,
            status: { ...GATE_BLOCKED_STATUS, heldCommits: 1 },
          },
        ],
      ],
    ]),
  });
  assert.match(r.excluded[0].reason, /1 commit /);
});

test('selectEligible (plan 3619): a status with no held count and no gate name still reads honestly', () => {
  const r = selectEligible([meta({ id: 3595 })], {
    onOriginIds: new Map([
      [
        '3595',
        [
          {
            name: 'claude/drain-3595-x',
            fresh: true,
            livenessUnknown: false,
            gateBlocked: true,
            status: { slug: '3595-x', heldCommits: null, blockedOn: null, session: null },
          },
        ],
      ],
    ]),
  });
  const reason = r.excluded[0].reason;
  assert.match(reason, /an unreported number of commits/);
  assert.match(reason, /an unnamed gate/);
  assert.doesNotMatch(reason, /Session:/, 'no session id ⇒ no dangling "Session:" fragment');
});

// gpt-review round 2 (plan 3767): `fresh: false` is not proof of death. `originExecutedPlanIds`
// renders a THROWN liveness probe the same way it renders a genuinely finished, carries-work
// head — so the collapse needs an explicit "we could not tell" signal to refuse on, or a probe
// failure silently becomes evidence that a live twin is a dead duplicate.
test('collapseSameShaBranches (plan 3767 r2): a head whose liveness probe THREW never collapses', () => {
  const list = [
    { name: 'claude/drain-3652-X', sha: 'abc123', fresh: false, livenessUnknown: true },
    { name: 'worktree-3652-X', sha: 'abc123', fresh: false },
  ];
  const r = collapseSameShaBranches(list);
  assert.deepEqual(r.branches, list, 'unknown liveness is never read as death');
  assert.deepEqual(r.duplicates, []);
});

test('originExecutedPlanIds (plan 3767 r2): a THROWING dead-seed probe marks the head livenessUnknown', () => {
  const onOriginIds = originExecutedPlanIds('/repo', {
    _exec: () =>
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/claude/drain-3652-X\n' +
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/worktree-3652-X\n',
    _deadSeed: () => {
      throw new Error('git cat-file failed');
    },
    log: () => {},
  });
  const heads = onOriginIds.get('3652');
  assert.equal(heads.length, 2, 'both heads survive a failed probe');
  for (const h of heads) assert.equal(h.livenessUnknown, true, `${h.name} carries the marker`);
  // and the marker survives the per-id fold, which is where a dropped field would undo the guard
  assert.deepEqual(collapseSameShaBranches(heads).duplicates, [], 'so the pair does not collapse');
});

// --- plan 4255: the land-phase axis (landCloudExec) for a /cloud-land hand-off ---------------

// A ready/ plan a LOCAL session built and handed off: cloudExec: false for its BUILD, plus the
// land-phase carrier, the adopt stamp and the hand-off note. Each part can be dropped.
function landHandoffPlan({
  cloud = 'false',
  carrier = true,
  env = 'full',
  adopt = 'worktree-4255-X-test',
  note = true,
  extra = '',
} = {}) {
  const fm = [
    '---',
    'summary: test',
    'stage: specced',
    'specReview: abc1234',
    'specReviewBy: test/high',
    'execModel: fable',
    `cloudExec: ${cloud}`,
    ...(carrier ? ['landCloudExec: true'] : []),
    ...(carrier && env ? [`landCloudEnv: ${env}`] : []),
    ...(adopt ? [`adoptBranch: ${adopt}`] : []),
    '---',
  ];
  const noteText = note
    ? `\n## Cloud-land hand-off 2026-09-26T22:00:00Z\n\n- **Branch:** \`${adopt}\` — BUILT, REVIEWED and PUSHED; only the land remains.\n`
    : '';
  return `${fm.join('\n')}\n\n> 🟩 **${MUTATION_BANNER_LABEL}: no** — test.\n\n# Test plan\n\n${extra}\n${noteText}`;
}

const FABLE_FULL = { cloudOnly: true, fableLane: true, lane: 'full' };

test('parsePlanMeta --cloud (plan 4255): a COMPLETE land hand-off of a cloudExec:false plan is admitted, land-only', () => {
  const m = parsePlanMeta('4255-X-test.md', landHandoffPlan(), FABLE_FULL);
  assert.equal(m.exclude, null, m.excludeReason);
  assert.equal(m.landHandoff, true);
  assert.equal(m.landPhaseAdmit, true, 'admitted THROUGH the land carrier, not cloudExec');
});

test('parsePlanMeta --cloud (plan 4255): an UNBUILT cloudExec:false plan is still never admitted', () => {
  const m = parsePlanMeta(
    '4255-X-test.md',
    landHandoffPlan({ carrier: false, adopt: null, note: false }),
    FABLE_FULL,
  );
  assert.equal(m.exclude, 'cloud');
  assert.match(m.excludeReason, /cloudExec: false/);
});

test('parsePlanMeta --cloud (plan 4255): landCloudExec:true WITHOUT adoptBranch is never admitted', () => {
  const m = parsePlanMeta('4255-X-test.md', landHandoffPlan({ adopt: null }), FABLE_FULL);
  assert.equal(m.exclude, 'cloud');
  assert.match(m.excludeReason, /adoptBranch/);
});

test('parsePlanMeta --cloud (plan 4255): landCloudExec:true WITHOUT the hand-off note is never admitted', () => {
  const m = parsePlanMeta('4255-X-test.md', landHandoffPlan({ note: false }), FABLE_FULL);
  assert.equal(m.exclude, 'cloud');
  assert.match(m.excludeReason, /Cloud-land hand-off/);
});

test('parsePlanMeta --cloud (plan 4255): the land routes on landCloudEnv — a trusted lane refuses a full land', () => {
  const m = parsePlanMeta('4255-X-test.md', landHandoffPlan(), {
    cloudOnly: true,
    fableLane: true,
    lane: 'trusted',
  });
  assert.equal(m.exclude, 'full-env');
});

test('parsePlanMeta --cloud (plan 4255): an absent landCloudEnv defaults to full, never to trusted', () => {
  const m = parsePlanMeta('4255-X-test.md', landHandoffPlan({ env: null }), {
    cloudOnly: true,
    fableLane: true,
    lane: 'trusted',
  });
  assert.equal(m.exclude, 'full-env');
});

test('parsePlanMeta --cloud (plan 4255): the build-phase operator gate does not hold back a built branch', () => {
  const m = parsePlanMeta(
    '4255-X-test.md',
    landHandoffPlan({ extra: 'Operator supplies the export first.' }),
    FABLE_FULL,
  );
  assert.equal(m.exclude, null, m.excludeReason);
});

test('parsePlanMeta --cloud (plan 4255): the lane gate still applies to a land hand-off', () => {
  const m = parsePlanMeta('4255-X-test.md', landHandoffPlan(), {
    cloudOnly: true,
    fableLane: false,
    lane: 'full',
  });
  assert.equal(m.exclude, 'fable');
});

test('parsePlanMeta (plan 4255): off-cloud a complete hand-off is flagged but never land-phase-admitted', () => {
  const m = parsePlanMeta('4255-X-test.md', landHandoffPlan(), { fableLane: true });
  assert.equal(m.landHandoff, true);
  assert.equal(m.landPhaseAdmit, false);
});

test('selectEligible (plan 4255): a land-phase admit whose branch is on origin is selected with landOnly', () => {
  const m = parsePlanMeta('4255-X-test.md', landHandoffPlan(), FABLE_FULL);
  const r = selectEligible([m], { onOriginIds: originMap({ 4255: 'worktree-4255-X-test' }) });
  assert.equal(r.next.slug, '4255-X-test');
  assert.equal(r.next.adoptBranch, 'worktree-4255-X-test');
  assert.equal(r.next.landOnly, true, 'the taker must adopt and land, never re-execute');
});

test('selectEligible (plan 4255): a land-phase admit whose branch is GONE from origin is excluded, never re-executed', () => {
  const m = parsePlanMeta('4255-X-test.md', landHandoffPlan(), FABLE_FULL);
  for (const onOriginIds of [null, new Map(), originMap({ 9999: 'worktree-9999-other' })]) {
    const r = selectEligible([m], { onOriginIds });
    assert.equal(r.next, undefined, 'nothing selected');
    assert.equal(r.excluded[0].exclude, 'cloud');
    assert.match(r.excluded[0].reason, /not on origin|could not read origin/);
  }
});

test("selectEligible (plan 4255): a cloudExec:true hand-off whose branch vanished falls back to today's re-execute path", () => {
  // Review fix (gpt-review r1, findings c0d8db/0ccdde/04487a): pinning landOnly on a hand-off whose
  // branch is gone told the drain "adopt, never re-execute" for a branch it cannot adopt, so the
  // plan cycled ready → refused adopt → ready forever. A cloud-safe plan re-executes instead.
  const m = parsePlanMeta('4255-X-test.md', landHandoffPlan({ cloud: 'true' }), FABLE_FULL);
  assert.equal(m.landPhaseAdmit, false);
  for (const onOriginIds of [new Map(), originMap({ 9999: 'worktree-9999-other' })]) {
    const r = selectEligible([m], { onOriginIds });
    assert.equal(r.next.slug, '4255-X-test');
    assert.equal(r.next.landOnly, undefined, 'no branch to land ⇒ not land-only');
  }
});

test('selectEligible (plan 4255): a cloudExec:true hand-off whose branch IS on origin stays landOnly', () => {
  const m = parsePlanMeta('4255-X-test.md', landHandoffPlan({ cloud: 'true' }), FABLE_FULL);
  const r = selectEligible([m], { onOriginIds: originMap({ 4255: 'worktree-4255-X-test' }) });
  assert.equal(r.next.landOnly, true);
});

test("parsePlanMeta --cloud (plan 4255): a hand-off's land env below full (trusted, a typo) still routes to full", () => {
  // Review fix (gpt-review r1, finding a7a1c6): an edited or mistyped landCloudEnv must never
  // land on a trusted drain, which has no WebKit for the mobile gate.
  for (const env of ['trusted', 'fulll', 'TRUSTED']) {
    const m = parsePlanMeta('4255-X-test.md', landHandoffPlan({ env }), {
      cloudOnly: true,
      fableLane: true,
      lane: 'trusted',
    });
    assert.equal(m.exclude, 'full-env', env);
  }
  const browser = parsePlanMeta('4255-X-test.md', landHandoffPlan({ env: 'browser' }), FABLE_FULL);
  assert.equal(browser.exclude, 'browser-env', 'a HIGHER rung is honoured');
});

test('parsePlanMeta (plan 4255, review r4 c35d3b): a complete hand-off is never batch-held — it is land-only, not train work', () => {
  const heldBy = new Map([['4255', 'batch-with-a-handed-off-member']]);
  const cloud = parsePlanMeta('4255-X-test.md', landHandoffPlan(), {
    ...FABLE_FULL,
    batchHeldBy: heldBy,
  });
  assert.equal(cloud.exclude, null, cloud.excludeReason);
  assert.equal(cloud.batchHold, null);
  const local = parsePlanMeta('4255-X-test.md', landHandoffPlan(), {
    fableLane: true,
    batchHeldBy: heldBy,
  });
  assert.equal(
    local.exclude,
    null,
    'the local oracle reports it solo too, so local-drain-filter can drop it as landOnly',
  );
  const unbuilt = parsePlanMeta(
    '4255-X-test.md',
    landHandoffPlan({ cloud: 'true', carrier: false, adopt: null, note: false }),
    { ...FABLE_FULL, batchHeldBy: heldBy },
  );
  assert.equal(unbuilt.exclude, 'batch', 'an ordinary member is still held');
});
