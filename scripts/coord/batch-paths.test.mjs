// scripts/batch-paths.test.mjs (plan 1467) — the batch-folder ABI helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newManifestRel,
  legacyManifestRel,
  batchMdRel,
  resolveManifestRel,
  resolveManifestAtRef,
  manifestExists,
  parseMembersValue,
  parseBatchMd,
  renderBatchMd,
  stampBatchStatus,
  readRunnableBatchMembers,
  readRunnableBatches,
  lazyBatchRoster,
  canonicalPlanId,
  walkBatchFolders,
  isRunnableBatch,
  findRunnableBatchForPlan,
  lazyRunnableBatchMembers,
  batchHoldFor,
  batchHoldReason,
  parseBatchManifest,
  readArchivedPlanIds,
  batchLiveness,
  dissolvedBatchReason,
  readBatchRosterLiveness,
} from './batch-paths.mjs';

function tmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'batch-paths-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function writeRel(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

test('rel-path helpers name the new folder + legacy paths', () => {
  assert.equal(newManifestRel('batch-x'), 'docs/superpowers/batches/batch-x/manifest.json');
  assert.equal(legacyManifestRel('batch-x'), 'docs/handoff/batches/batch-x.json');
  assert.equal(batchMdRel('batch-x'), 'docs/superpowers/batches/batch-x/batch.md');
});

test('resolveManifestRel: new path wins when both exist', (t) => {
  const { root, cleanup } = tmpRepo();
  t.after(cleanup);
  writeRel(root, newManifestRel('batch-x'), '{}');
  writeRel(root, legacyManifestRel('batch-x'), '{}');
  assert.deepEqual(resolveManifestRel(root, 'batch-x'), {
    rel: 'docs/superpowers/batches/batch-x/manifest.json',
    legacy: false,
  });
});

test('resolveManifestRel: falls back to the legacy path (grandfathered in-flight batch)', (t) => {
  const { root, cleanup } = tmpRepo();
  t.after(cleanup);
  writeRel(root, legacyManifestRel('batch-old'), '{}');
  assert.deepEqual(resolveManifestRel(root, 'batch-old'), {
    rel: 'docs/handoff/batches/batch-old.json',
    legacy: true,
  });
  assert.equal(manifestExists(root, 'batch-old'), true);
});

test('resolveManifestRel / manifestExists: neither path (never claimed or already landed)', (t) => {
  const { root, cleanup } = tmpRepo();
  t.after(cleanup);
  assert.deepEqual(resolveManifestRel(root, 'batch-gone'), { rel: null, legacy: false });
  assert.equal(manifestExists(root, 'batch-gone'), false);
});

// --- resolveManifestAtRef (plan 1523) — pure, reader injected -----------------

test('resolveManifestAtRef: new path wins; legacy never read when the new path resolves', () => {
  const reads = [];
  const res = resolveManifestAtRef('batch-x', (rel) => {
    reads.push(rel);
    if (rel === newManifestRel('batch-x')) return '{"members":["1"]}';
    throw new Error('unexpected');
  });
  assert.deepEqual(reads, [newManifestRel('batch-x')]);
  assert.equal(res.rel, newManifestRel('batch-x'));
  assert.equal(res.raw, '{"members":["1"]}');
  assert.equal(res.legacy, false);
});

test('resolveManifestAtRef: falls back to the legacy path when the new path throws', () => {
  const res = resolveManifestAtRef('batch-old', (rel) => {
    if (rel === legacyManifestRel('batch-old')) return '{}';
    throw new Error('not at this ref');
  });
  assert.equal(res.rel, legacyManifestRel('batch-old'));
  assert.equal(res.legacy, true);
  assert.equal(res.misses.length, 1);
  assert.equal(res.misses[0].rel, newManifestRel('batch-old'));
});

test('resolveManifestAtRef: neither path readable → rel null + both misses reported', () => {
  const res = resolveManifestAtRef('batch-gone', () => {
    throw new Error('nope');
  });
  assert.deepEqual(
    { rel: res.rel, raw: res.raw, legacy: res.legacy },
    { rel: null, raw: null, legacy: false },
  );
  assert.deepEqual(
    res.misses.map((m) => m.rel),
    [newManifestRel('batch-gone'), legacyManifestRel('batch-gone')],
  );
});

test('parseMembersValue: inline array, tolerates glyphs + backticks', () => {
  assert.deepEqual(parseMembersValue('[1444, 1453]'), ['1444', '1453']);
  assert.deepEqual(parseMembersValue('[1467 🟢, 1478 🟢]'), ['1467', '1478']);
  assert.deepEqual(parseMembersValue(''), []);
  assert.deepEqual(parseMembersValue(null), []);
});

test('parseBatchMd: full frontmatter + theme body', () => {
  const md = [
    '---',
    'slug: batch-deeplink-repair',
    'lane: 🟥',
    'members: [1444, 1453]',
    'gate: null',
    'status: proposed',
    '---',
    '',
    '# batch-deeplink-repair',
    '',
    'Shared unmapped-service helper + the 20-lane rot repair.',
    '',
  ].join('\n');
  assert.deepEqual(parseBatchMd(md), {
    slug: 'batch-deeplink-repair',
    lane: '🟥',
    members: ['1444', '1453'],
    gate: null,
    status: 'proposed',
    theme: 'Shared unmapped-service helper + the 20-lane rot repair.',
  });
});

test('parseBatchMd: a gate value + claimed status parse; defaults for a bare doc', () => {
  const gated = parseBatchMd(
    '---\nslug: b\nlane: 🟩\nmembers: [908]\ngate: plan 1055 lands\nstatus: claimed\n---\n\n# b\n\nTheme.\n',
  );
  assert.equal(gated.gate, 'plan 1055 lands');
  assert.equal(gated.status, 'claimed');
  // no frontmatter at all → degrade, never throw
  const bare = parseBatchMd('# just a heading\n');
  assert.equal(bare.status, 'proposed');
  assert.deepEqual(bare.members, []);
});

test('renderBatchMd round-trips through parseBatchMd', () => {
  const spec = {
    slug: 'batch-x',
    lane: '🟩',
    members: ['100', '101'],
    gate: null,
    status: 'proposed',
    theme: 'Alpha theme.',
  };
  assert.deepEqual(parseBatchMd(renderBatchMd(spec)), spec);
});

// --- readRunnableBatchMembers (plan 2459 Task 2) ------------------------------

// members default to a 3-digit id: parseMembersValue's `\d{2,}` token match (batch-
// paths.mjs) drops single-digit ids, mirroring real plan ids (always 3+ digits).
function writeBatch(root, slug, spec = {}) {
  writeRel(
    root,
    batchMdRel(slug),
    renderBatchMd({ slug, lane: '🟩', members: ['100'], gate: null, status: 'proposed', ...spec }),
  );
}

// --- canonicalPlanId + the zero-padded-id miss it closes (plan 2459 review) ------
//
// THE BUG THIS PINS: queue-drain's parsePlanMeta carries the plan id as a NUMBER
// (`Number(idM[1])`), so a legacy zero-padded filename id like `007-P07-…md` arrives as 7 and
// re-strings to '7'. The held-map used to be keyed on the roster's RAW token ('007'), so
// `has('7')` missed and the member was silently NOT excluded — the guard failing OPEN on
// exactly the leak-B dissolution it exists to prevent. Both sides now canonicalize.

test('canonicalPlanId: strips leading zeros so a padded roster token and a Number-carried id agree', () => {
  assert.equal(canonicalPlanId('007'), '7');
  assert.equal(canonicalPlanId(7), '7');
  assert.equal(canonicalPlanId('7'), '7');
  assert.equal(canonicalPlanId('2459'), '2459');
  assert.equal(canonicalPlanId(' 042 '), '42'); // tolerates stray whitespace
});

test('canonicalPlanId: a NON-numeric id is left verbatim, never NaN', () => {
  // A malformed roster entry must only ever fail to match — never collide onto another id.
  assert.equal(canonicalPlanId('not-an-id'), 'not-an-id');
  assert.equal(canonicalPlanId(''), '');
});

test('readRunnableBatchMembers: a ZERO-PADDED member id is findable by its unpadded form (the regression)', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-legacy', { members: ['007', '012'] });
    const held = readRunnableBatchMembers(join(root, 'docs/superpowers/batches'));
    // The lookup queue-drain actually performs, for a plan file named `007-P07-….md`:
    assert.equal(held.get(canonicalPlanId(Number('007'))), 'batch-legacy');
    assert.equal(held.get(canonicalPlanId(Number('012'))), 'batch-legacy');
    // And the pre-fix spelling must no longer be what the map is keyed on.
    assert.equal(held.has('007'), false);
    assert.equal(held.size, 2);
  } finally {
    cleanup();
  }
});

// --- readRunnableBatches (plan 2556) -----------------------------------------
//
// The ROSTER twin of readRunnableBatchMembers: queue-drain's runnableBatches pass asks
// "is this whole train takeable?", which the member->slug map cannot answer — rebuilding a
// batch's membership from it would silently drop any member the first-match-wins tiebreak
// awarded elsewhere, turning a malformed roster into a train reported runnable minus a car.

test('readRunnableBatches: returns one entry per runnable batch, members verbatim', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-x', { members: ['2459', '2460'] });
    const batches = readRunnableBatches(join(root, 'docs/superpowers/batches'));
    assert.equal(batches.length, 1);
    assert.equal(batches[0].slug, 'batch-x');
    assert.deepEqual(batches[0].members, ['2459', '2460']);
    assert.equal(batches[0].lane, '🟩');
  } finally {
    cleanup();
  }
});

test('readRunnableBatches: a claimed or gated batch is omitted — same isRunnableBatch predicate as the member map', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-open', { members: ['100'] });
    writeBatch(root, 'batch-claimed', { members: ['200'], status: 'claimed' });
    writeBatch(root, 'batch-gated', { members: ['300'], gate: 'plan 900 lands' });
    const batches = readRunnableBatches(join(root, 'docs/superpowers/batches'));
    assert.deepEqual(
      batches.map((b) => b.slug),
      ['batch-open'],
    );
  } finally {
    cleanup();
  }
});

// Both readers walk the SAME sorted folder list, so the set of slugs they consider runnable
// must be identical for any tree — the invariant that lets queue-drain cross-reference a
// member's holding slug (from the map) against a roster entry (from here).
test('readRunnableBatches agrees with readRunnableBatchMembers about which batches are runnable', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-b', { members: ['200', '201'] });
    writeBatch(root, 'batch-a', { members: ['100'] });
    writeBatch(root, 'batch-claimed', { members: ['300'], status: 'claimed' });
    const dir = join(root, 'docs/superpowers/batches');
    const rosterSlugs = readRunnableBatches(dir).map((b) => b.slug);
    const mapSlugs = [...new Set(readRunnableBatchMembers(dir).values())];
    assert.deepEqual(rosterSlugs.slice().sort(), mapSlugs.slice().sort());
    assert.deepEqual(rosterSlugs, ['batch-a', 'batch-b']); // sorted walk, deterministic
  } finally {
    cleanup();
  }
});

test('readRunnableBatches: no batches dir at all → empty array, no crash', (t) => {
  const { root, cleanup } = tmpRepo();
  t.after(cleanup);
  assert.deepEqual(readRunnableBatches(join(root, 'docs/superpowers/batches')), []);
});

test('readRunnableBatchMembers: no batches dir at all → empty map, no crash', (t) => {
  const { root, cleanup } = tmpRepo();
  t.after(cleanup);
  const held = readRunnableBatchMembers(join(root, 'docs/superpowers/batches'));
  assert.equal(held.size, 0);
});

test('readRunnableBatchMembers: a proposed/gate:null batch — every member maps to its slug', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-x', { members: ['2459', '2460'] });
    const held = readRunnableBatchMembers(join(root, 'docs/superpowers/batches'));
    assert.equal(held.get('2459'), 'batch-x');
    assert.equal(held.get('2460'), 'batch-x');
    assert.equal(held.size, 2);
  } finally {
    cleanup();
  }
});

test('readRunnableBatchMembers: a batch with a non-null gate is OMITTED — its members stay unheld (plan 2459 item 5)', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-gated', { members: ['500'], gate: 'plan 400 lands' });
    const held = readRunnableBatchMembers(join(root, 'docs/superpowers/batches'));
    assert.equal(held.has('500'), false);
    assert.equal(held.size, 0);
  } finally {
    cleanup();
  }
});

test('readRunnableBatchMembers: a claimed/landed batch (status != proposed) is OMITTED', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-claimed', { members: ['501'], status: 'claimed' });
    const held = readRunnableBatchMembers(join(root, 'docs/superpowers/batches'));
    assert.equal(held.has('501'), false);
  } finally {
    cleanup();
  }
});

test('readRunnableBatchMembers: archive/ is excluded (RESERVED_BATCH_DIRS) even if it holds a proposed-shaped batch.md', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeRel(
      root,
      'docs/superpowers/batches/archive/batch-old/batch.md',
      renderBatchMd({
        slug: 'batch-old',
        lane: '🟩',
        members: ['999'],
        gate: null,
        status: 'proposed',
      }),
    );
    const held = readRunnableBatchMembers(join(root, 'docs/superpowers/batches'));
    assert.equal(held.has('999'), false);
  } finally {
    cleanup();
  }
});

test('readRunnableBatchMembers: a stray dir with no readable batch.md is skipped, never crashes', () => {
  const { root, cleanup } = tmpRepo();
  try {
    mkdirSync(join(root, 'docs/superpowers/batches', 'batch-empty'), { recursive: true });
    writeBatch(root, 'batch-real', { members: ['777'] });
    const held = readRunnableBatchMembers(join(root, 'docs/superpowers/batches'));
    assert.equal(held.get('777'), 'batch-real');
    assert.equal(held.size, 1);
  } finally {
    cleanup();
  }
});

// The plan-2459 "known live edge case": a partially-claimed runnable batch (one member
// already in in-progress/, the other still in ready/) is a REAL state on day one — this
// helper reports BOTH members held regardless of where each one currently lives; it is
// the CALLER (queue-drain/claim-plan) that only ever looks up an id it's about to
// claim/list, which is what makes the already-claimed co-member's stale entry harmless.
test('readRunnableBatchMembers: batch-claim-projection shape — [2459, 2460] both held even though only one is still claimable elsewhere', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-claim-projection', { lane: '🟩', members: ['2459', '2460'] });
    const held = readRunnableBatchMembers(join(root, 'docs/superpowers/batches'));
    assert.equal(held.get('2459'), 'batch-claim-projection');
    assert.equal(held.get('2460'), 'batch-claim-projection');
  } finally {
    cleanup();
  }
});

// Called WITHOUT archive information (plan 4246 made it an opt-in `archivedIds`), a roster
// whose members have ALL moved on is still reported as written by this LOW-LEVEL helper (it
// never verifies members still resolve anywhere) — the "never refuses anything" property is a property of the
// CALLERS (queue-drain only scans ready/, claim-plan only checks a resolvable id), not
// of this function. Documented here so a future reader doesn't mistake the map's
// presence for a currently-claimable guarantee.
test('readRunnableBatchMembers: a stale all-archived-members roster still returns its (now-unreachable) ids verbatim', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-stale', { members: ['101', '102'] }); // pretend both are long archived
    const held = readRunnableBatchMembers(join(root, 'docs/superpowers/batches'));
    assert.equal(held.get('101'), 'batch-stale');
    assert.equal(held.get('102'), 'batch-stale');
  } finally {
    cleanup();
  }
});

// --- plan 4246: archived members are finished cars, not missing ones ---------------------
//
// THE BUG THESE PIN: batch-2026-09-26-profile-ui listed [4187, 4233]; 4187 landed solo and
// archived. The batch kept HOLDING 4233 from solo claims while queue-drain refused the whole
// train over the archived 4187 — a deadlock. With `archivedIds`, archived members drop out of
// the live membership; ≥2 live keeps a (smaller) train, ≤1 live dissolves the batch.

const ARCHIVE_REL = 'docs/superpowers/plans/archive';

test('readArchivedPlanIds (disk): filename ids only (flat + one-level subfolder), canonicalized; non-plan files ignored', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeRel(root, `${ARCHIVE_REL}/4187-UI-day-strip.md`, 'x');
    writeRel(root, `${ARCHIVE_REL}/007-P07-legacy.md`, 'x');
    writeRel(root, `${ARCHIVE_REL}/infra/4227-Infra-nested.md`, 'x');
    writeRel(root, `${ARCHIVE_REL}/README.md`, 'x');
    writeRel(root, `${ARCHIVE_REL}/2026-notes.txt`, 'x');
    const ids = readArchivedPlanIds({ archiveDir: join(root, ARCHIVE_REL) });
    assert.deepEqual([...ids].sort(), ['4187', '4227', '7']);
  } finally {
    cleanup();
  }
});

// Review finding b6ad2d: the first cut's local regex demanded a LETTER after `<id>-`, so an
// archived plan with a date slug (`029-2026-05-21-….md`, the older archive shape) was never seen
// as archived and its batch kept holding. The shared claimedIdOfBasename parser reads it, while
// still refusing a dateless `<YYYY>-MM-DD-…` note that only LOOKS like it starts with an id.
test('readArchivedPlanIds: a DATE-slugged archived name (`029-2026-05-21-…`) parses; a dateless `2026-05-17-…` does not', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeRel(root, `${ARCHIVE_REL}/029-2026-05-21-fb-insta-ui-surface.md`, 'x');
    writeRel(root, `${ARCHIVE_REL}/2026-05-17-dateless-note.md`, 'x');
    writeRel(root, `${ARCHIVE_REL}/2026-FABLE-Price-real-plan.md`, 'x');
    const ids = readArchivedPlanIds({ archiveDir: join(root, ARCHIVE_REL) });
    assert.deepEqual([...ids].sort(), ['2026', '29']);
  } finally {
    cleanup();
  }
});

test('readArchivedPlanIds: a missing archive dir / no source fails SAFE — an empty set, never a throw', (t) => {
  const { root, cleanup } = tmpRepo();
  t.after(cleanup);
  assert.equal(readArchivedPlanIds({ archiveDir: join(root, ARCHIVE_REL) }).size, 0);
  assert.equal(readArchivedPlanIds().size, 0);
});

// Review finding 47956f: queue-drain reads ready/ at an ORIGIN commit, so the archive listing must
// come from that same commit — a member archived on origin but not yet pulled locally counts, and
// an archive file that exists only on local disk (never pushed) does not.
test('readArchivedPlanIds (ref): names at the given COMMIT, never local disk', () => {
  const { root, cleanup } = tmpRepo();
  try {
    const g = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'master');
    g('config', 'user.email', 't@t.t');
    g('config', 'user.name', 'T');
    g('config', 'commit.gpgsign', 'false');
    writeRel(root, `${ARCHIVE_REL}/4187-UI-landed.md`, 'x');
    writeRel(root, `${ARCHIVE_REL}/029-2026-05-21-dated.md`, 'x');
    writeRel(root, `${ARCHIVE_REL}/infra/4227-Infra-nested.md`, 'x');
    writeRel(root, 'docs/superpowers/plans/ready/4233-App-live.md', 'x');
    g('add', '-A');
    g('commit', '-qm', 'seed');
    const sha = g('rev-parse', 'HEAD').trim();
    // Diverge the disk from the commit in both directions.
    rmSync(join(root, ARCHIVE_REL, '4187-UI-landed.md'));
    writeRel(root, `${ARCHIVE_REL}/4999-Infra-disk-only.md`, 'x');
    const ids = readArchivedPlanIds({ repoRoot: root, ref: sha, archiveRel: ARCHIVE_REL });
    assert.deepEqual([...ids].sort(), ['29', '4187', '4227']);
    // A trailing slash on archiveRel is tolerated.
    assert.equal(
      readArchivedPlanIds({ repoRoot: root, ref: sha, archiveRel: `${ARCHIVE_REL}/` }).size,
      3,
    );
    // A path absent at the ref → empty (data, not a fault).
    assert.equal(
      readArchivedPlanIds({ repoRoot: root, ref: sha, archiveRel: 'docs/nope' }).size,
      0,
    );
    // No resolvable ref → empty, and no disk fallback.
    assert.equal(
      readArchivedPlanIds({ repoRoot: root, ref: null, archiveRel: ARCHIVE_REL }).size,
      0,
    );
    // A git FAULT (unknown ref) fails safe: empty set, one stderr line through `log`.
    const logged = [];
    const bad = readArchivedPlanIds({
      repoRoot: root,
      ref: 'f'.repeat(40),
      archiveRel: ARCHIVE_REL,
      log: (m) => logged.push(m),
    });
    assert.equal(bad.size, 0);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /treating no batch member as archived/);
  } finally {
    cleanup();
  }
});

// Review finding b35525: the roster can be read at a git COMMIT (walkBatchFolders `at`) so a caller
// judging against origin never combines an origin archive with a stale local batch.md.
test('walkBatchFolders / roster readers `at` a commit: the committed roster wins over local disk; runnable with the 2 live ids', () => {
  const { root, cleanup } = tmpRepo();
  try {
    const g = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'master');
    g('config', 'user.email', 't@t.t');
    g('config', 'user.name', 'T');
    g('config', 'commit.gpgsign', 'false');
    writeBatch(root, 'batch-three', { members: ['100', '101', '102'] });
    writeBatch(root, 'batch-claimed', { members: ['300', '301'], status: 'claimed' });
    writeRel(root, 'docs/superpowers/batches/stray/notes.md', 'no batch.md here');
    writeRel(root, 'docs/superpowers/batches/README.md', 'top-level file');
    writeBatch(root, 'archive/batch-old', { members: ['900', '901'] }); // reserved dir
    writeRel(root, `${ARCHIVE_REL}/101-Infra-landed.md`, 'x');
    g('add', '-A');
    g('commit', '-qm', 'seed');
    const sha = g('rev-parse', 'HEAD').trim();
    // Stale LOCAL roster: drops 102, which would make the batch read as dissolved.
    writeBatch(root, 'batch-three', { members: ['100', '101'] });
    writeBatch(root, 'batch-local-only', { members: ['500', '501'] });

    const dir = join(root, 'docs/superpowers/batches');
    const at = { repoRoot: root, ref: sha };
    const skipped = [];
    const walked = [...walkBatchFolders(dir, { at, onSkip: (n, why) => skipped.push([n, why]) })];
    assert.deepEqual(
      walked.map((w) => w.slug),
      ['batch-claimed', 'batch-three'],
    );
    assert.deepEqual(skipped, [['stray', 'no readable batch.md']]);

    const archivedIds = () =>
      readArchivedPlanIds({ repoRoot: root, ref: sha, archiveRel: ARCHIVE_REL });
    const { runnable, dissolved } = readBatchRosterLiveness(dir, { at, archivedIds });
    assert.deepEqual(
      runnable.map((b) => [b.slug, b.members]),
      [['batch-three', ['100', '102']]],
    );
    assert.deepEqual(dissolved, []);
    assert.equal(findRunnableBatchForPlan(dir, '102', { at, archivedIds }), 'batch-three');
    // `at` may be a thunk, resolved when the walk starts.
    assert.equal(lazyBatchRoster(dir, { at: () => at, archivedIds }).get('102'), 'batch-three');
    // The local disk still reads the stale roster — proof the two sources really differ.
    assert.equal(findRunnableBatchForPlan(dir, '102', { archivedIds }), null);
  } finally {
    cleanup();
  }
});

test('walkBatchFolders `at`: a null ref walks nothing; a git fault goes to onFault, or throws without one', () => {
  const { root, cleanup } = tmpRepo();
  try {
    execFileSync('git', ['-C', root, 'init', '-q', '-b', 'master']);
    const dir = join(root, 'docs/superpowers/batches');
    assert.deepEqual([...walkBatchFolders(dir, { at: { repoRoot: root, ref: null } })], []);
    const badRef = 'f'.repeat(40);
    const faults = [];
    const at = { repoRoot: root, ref: badRef, onFault: (e) => faults.push(e) };
    assert.deepEqual([...walkBatchFolders(dir, { at })], []);
    assert.equal(faults.length, 1);
    assert.throws(() => [...walkBatchFolders(dir, { at: { repoRoot: root, ref: badRef } })]);
  } finally {
    cleanup();
  }
});

test('batchLiveness: the rule table — none archived / ≥2 live / ≤1 live', () => {
  const arch = new Set(['4187']);
  assert.deepEqual(batchLiveness({ members: ['4211', '4227'] }, arch), {
    live: ['4211', '4227'],
    archived: [],
    dissolved: false,
  });
  assert.deepEqual(batchLiveness({ members: ['4187', '4233'] }, arch), {
    live: ['4233'],
    archived: ['4187'],
    dissolved: true,
  });
  assert.deepEqual(batchLiveness({ members: ['4187', '4233', '4234'] }, arch), {
    live: ['4233', '4234'],
    archived: ['4187'],
    dissolved: false,
  });
  // Everything archived → dissolved with nothing live.
  assert.equal(batchLiveness({ members: ['4187'] }, arch).dissolved, true);
  // No archive information at all → verbatim, never dissolved.
  assert.deepEqual(batchLiveness({ members: ['4187', '4233'] }, null), {
    live: ['4187', '4233'],
    archived: [],
    dissolved: false,
  });
  // A zero-padded roster token matches its canonical archive id.
  assert.deepEqual(batchLiveness({ members: ['007', '4233'] }, new Set(['7'])).archived, ['007']);
});

test('dissolvedBatchReason: names the live count, the archived ids, and the solo survivor', () => {
  assert.equal(
    dissolvedBatchReason({ live: ['4233'], archived: ['4187'] }),
    'dissolved: only 1 live member left (4187 archived) — 4233 is claimable solo',
  );
  assert.equal(
    dissolvedBatchReason({ live: [], archived: ['101', '102'] }),
    'dissolved: only 0 live members left (101, 102 archived)',
  );
});

test('2-member batch, 1 archived: DISSOLVED — the survivor is held by nothing, in every reader', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-profile-ui', { members: ['4187', '4233'] });
    const dir = join(root, 'docs/superpowers/batches');
    const archivedIds = new Set(['4187']);
    assert.equal(readRunnableBatchMembers(dir, { archivedIds }).size, 0);
    assert.equal(findRunnableBatchForPlan(dir, '4233', { archivedIds }), null);
    assert.deepEqual(readRunnableBatches(dir, { archivedIds }), []);
    const { runnable, dissolved } = readBatchRosterLiveness(dir, { archivedIds });
    assert.deepEqual(runnable, []);
    assert.equal(dissolved.length, 1);
    assert.equal(dissolved[0].slug, 'batch-profile-ui');
    assert.deepEqual(dissolved[0].members, ['4233']);
    assert.deepEqual(dissolved[0].archivedMembers, ['4187']);
    const lazy = lazyBatchRoster(dir, { archivedIds });
    assert.equal(lazy.has('4233'), false);
    assert.deepEqual(lazy.list(), []);
    assert.deepEqual(
      lazy.dissolved().map((b) => b.slug),
      ['batch-profile-ui'],
    );
    assert.equal(lazyRunnableBatchMembers(dir, { archivedIds }).has('4233'), false);
    // Without archive information the old verbatim behaviour stands (fixture callers).
    assert.equal(findRunnableBatchForPlan(dir, '4233'), 'batch-profile-ui');
  } finally {
    cleanup();
  }
});

test('3-member batch, 1 archived: still RUNNABLE with exactly the 2 live ids', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-three', { members: ['100', '101', '102'] });
    const dir = join(root, 'docs/superpowers/batches');
    const archivedIds = new Set(['101']);
    const batches = readRunnableBatches(dir, { archivedIds });
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].members, ['100', '102']);
    assert.deepEqual(batches[0].archivedMembers, ['101']);
    const held = readRunnableBatchMembers(dir, { archivedIds });
    assert.deepEqual([...held.keys()].sort(), ['100', '102']);
    assert.equal(findRunnableBatchForPlan(dir, '100', { archivedIds }), 'batch-three');
    assert.equal(findRunnableBatchForPlan(dir, '101', { archivedIds }), null);
    const lazy = lazyBatchRoster(dir, { archivedIds });
    assert.deepEqual(lazy.list()[0].members, ['100', '102']);
    assert.deepEqual(lazy.dissolved(), []);
  } finally {
    cleanup();
  }
});

test('archivedIds thunk: invoked at most ONCE per read, and NOT at all when no batch is runnable', () => {
  const { root, cleanup } = tmpRepo();
  try {
    const dir = join(root, 'docs/superpowers/batches');
    let calls = 0;
    const archivedIds = () => {
      calls += 1;
      return new Set(['101']);
    };
    writeBatch(root, 'batch-claimed', { members: ['100', '101'], status: 'claimed' });
    readRunnableBatchMembers(dir, { archivedIds });
    assert.equal(calls, 0, 'no runnable batch → the archive is never listed');
    writeBatch(root, 'batch-a', { members: ['100', '101'] });
    writeBatch(root, 'batch-b', { members: ['200', '201'] });
    const lazy = lazyBatchRoster(dir, { archivedIds });
    assert.equal(calls, 0, 'lazy roster: no read before the first lookup');
    lazy.has('100');
    lazy.list();
    lazy.dissolved();
    assert.equal(calls, 1, 'one listing serves both runnable batches and every shape');
  } finally {
    cleanup();
  }
});

test('stale all-archived roster, WITH archive info: dissolved, holds nothing', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-stale', { members: ['101', '102'] });
    const dir = join(root, 'docs/superpowers/batches');
    const archivedIds = new Set(['101', '102']);
    assert.equal(readRunnableBatchMembers(dir, { archivedIds }).size, 0);
    assert.deepEqual(readBatchRosterLiveness(dir, { archivedIds }).dissolved[0].members, []);
  } finally {
    cleanup();
  }
});

test('stampBatchStatus: replaces an existing status, inserts a missing one', () => {
  const withStatus = '---\nslug: b\nstatus: proposed\n---\n\n# b\n';
  assert.match(stampBatchStatus(withStatus, 'claimed'), /^status: claimed$/m);
  assert.doesNotMatch(stampBatchStatus(withStatus, 'claimed'), /status: proposed/);

  const noStatus = '---\nslug: b\nlane: 🟩\n---\n\n# b\n';
  const stamped = stampBatchStatus(noStatus, 'claimed');
  assert.match(stamped, /^status: claimed$/m);
  assert.equal(parseBatchMd(stamped).status, 'claimed');
  // body preserved
  assert.match(stamped, /# b/);
});

// --- plan 2518: the shared walk, the targeted lookup, the lazy façade, the one message ---

test('walkBatchFolders: SORTED by folder name, archive/ skipped — deterministic, not fs order', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-zulu', { members: ['300'] });
    writeBatch(root, 'batch-alpha', { members: ['301'] });
    writeRel(
      root,
      'docs/superpowers/batches/archive/batch-old/batch.md',
      renderBatchMd({
        slug: 'batch-old',
        lane: '🟩',
        members: ['302'],
        gate: null,
        status: 'proposed',
      }),
    );
    const seen = [...walkBatchFolders(join(root, 'docs/superpowers/batches'))].map((e) => e.name);
    assert.deepEqual(seen, ['batch-alpha', 'batch-zulu']);
  } finally {
    cleanup();
  }
});

test('walkBatchFolders: no batches dir → yields nothing, never throws', () => {
  const { root, cleanup } = tmpRepo();
  try {
    assert.deepEqual([...walkBatchFolders(join(root, 'docs/superpowers/batches'))], []);
  } finally {
    cleanup();
  }
});

test('walkBatchFolders: onSkip names an unreadable batch folder; default stays silent', () => {
  const { root, cleanup } = tmpRepo();
  try {
    mkdirSync(join(root, 'docs/superpowers/batches', 'batch-empty'), { recursive: true });
    writeBatch(root, 'batch-real', { members: ['400'] });
    const skipped = [];
    const rows = [
      ...walkBatchFolders(join(root, 'docs/superpowers/batches'), {
        onSkip: (name, why) => skipped.push([name, why]),
      }),
    ];
    assert.deepEqual(
      rows.map((r) => r.name),
      ['batch-real'],
    );
    assert.deepEqual(skipped, [['batch-empty', 'no readable batch.md']]);
    // the default (no onSkip) must not throw — the guard path passes no hook
    assert.equal([...walkBatchFolders(join(root, 'docs/superpowers/batches'))].length, 1);
  } finally {
    cleanup();
  }
});

test('isRunnableBatch: proposed AND gate:null, nothing else', () => {
  assert.equal(isRunnableBatch({ status: 'proposed', gate: null }), true);
  assert.equal(isRunnableBatch({ status: 'claimed', gate: null }), false);
  assert.equal(isRunnableBatch({ status: 'proposed', gate: 'plan 400 lands' }), false);
});

// Item 4: the single-id lookup must answer IDENTICALLY to the full map build, including
// the zero-padded spelling and the non-runnable exclusions.
test('findRunnableBatchForPlan: agrees with readRunnableBatchMembers on every id in the tree', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-a', { members: ['600', '007'] });
    writeBatch(root, 'batch-gated', { members: ['601'], gate: 'plan 400 lands' });
    writeBatch(root, 'batch-claimed', { members: ['602'], status: 'claimed' });
    const dir = join(root, 'docs/superpowers/batches');
    const held = readRunnableBatchMembers(dir);
    for (const id of ['600', '007', 7, '601', '602', '999']) {
      assert.equal(
        findRunnableBatchForPlan(dir, id),
        held.get(canonicalPlanId(id)) ?? null,
        `disagreement on id ${id}`,
      );
    }
    // and the padded/unpadded spellings both resolve
    assert.equal(findRunnableBatchForPlan(dir, Number('007')), 'batch-a');
  } finally {
    cleanup();
  }
});

// Item 3: the façade must not walk the tree until the FIRST lookup. Proved by building it
// against a tree that does not exist yet and creating the roster afterwards — an eager
// implementation would have already cached "nothing held" and miss the batch.
test('lazyRunnableBatchMembers: defers the fs walk to the first lookup, then memoizes it', () => {
  const { root, cleanup } = tmpRepo();
  try {
    const dir = join(root, 'docs/superpowers/batches');
    const held = lazyRunnableBatchMembers(dir); // no batches dir on disk at all yet
    writeBatch(root, 'batch-late', { members: ['800'] });
    // first touch happens NOW — it must see the roster written after construction
    assert.equal(held.has(canonicalPlanId('800')), true);
    assert.equal(held.get(canonicalPlanId('800')), 'batch-late');
    // memoized: a roster written after the first lookup is NOT re-read
    writeBatch(root, 'batch-later', { members: ['801'] });
    assert.equal(held.has(canonicalPlanId('801')), false);
  } finally {
    cleanup();
  }
});

test('lazyRunnableBatchMembers: a plain Map is a valid substitute (same has/get surface)', () => {
  const map = new Map([['800', 'batch-x']]);
  assert.equal(batchHoldFor('800', map).slug, 'batch-x');
  assert.equal(batchHoldFor('801', map), null);
});

// Item 1: ONE composition of the refusal text. batchHoldFor owns the core; the claim path
// prefixes it. If either consumer ever re-hand-writes the sentence, these drift apart.
test('batchHoldReason: the ONE composition of the refusal core, from a resolved slug', () => {
  assert.equal(
    batchHoldReason('batch-legacy'),
    'member of runnable batch "batch-legacy" (status: proposed, gate: null) — take the ' +
      'whole train via `claim-plan.mjs batch`, or override with --override-batch-solo "<note>"',
  );
});

test('batchHoldFor: the bulk (map-shaped) lookup, keyed canonically', () => {
  const map = new Map([['7', 'batch-legacy']]);
  const hold = batchHoldFor(Number('007'), map); // Number-carried, zero-padded origin
  assert.equal(hold.slug, 'batch-legacy');
  assert.equal(
    hold.reason,
    'member of runnable batch "batch-legacy" (status: proposed, gate: null) — take the ' +
      'whole train via `claim-plan.mjs batch`, or override with --override-batch-solo "<note>"',
  );
});

// plan 2556 review (findings 0 + 5): ONE memoized walk serving BOTH shapes. Two independent
// lazy reads produced two walks AND let the roster read be demand-gated on the member map
// being non-empty — false exactly when every member of a runnable batch has left ready/.
test('lazyBatchRoster: the member map and the roster come from the SAME walk', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-x', { members: ['2459', '2460'] });
    const r = lazyBatchRoster(join(root, 'docs/superpowers/batches'));
    assert.equal(r.get(canonicalPlanId('2459')), 'batch-x');
    assert.deepEqual(
      r.list().map((b) => b.slug),
      ['batch-x'],
    );
    // Same first-match-wins tiebreak as readRunnableBatchMembers, over the same sorted walk.
    assert.equal(r.has('2460'), true);
    assert.equal(r.has('9999'), false);
  } finally {
    cleanup();
  }
});

test('lazyBatchRoster: stays LAZY — a tree with no batches dir costs nothing and degrades empty', () => {
  const { root, cleanup } = tmpRepo();
  try {
    const r = lazyBatchRoster(join(root, 'docs/superpowers/batches'));
    assert.deepEqual(r.list(), []);
    assert.equal(r.has('100'), false);
  } finally {
    cleanup();
  }
});

// The roster must be readable even when NO plan is held — that is the whole point of finding 0.
test('lazyBatchRoster: list() works without any prior member lookup (the finding-0 path)', () => {
  const { root, cleanup } = tmpRepo();
  try {
    writeBatch(root, 'batch-stale', { members: ['100'] });
    const r = lazyBatchRoster(join(root, 'docs/superpowers/batches'));
    assert.deepEqual(
      r.list().map((b) => b.slug),
      ['batch-stale'],
    );
  } finally {
    cleanup();
  }
});

// ───────────────────── plan 1364 Ship 3: batch manifest parsing (pure) ─────────────────────
// Relocated here from done-worktree-lib.test.mjs by plan 3962 Decision 5, alongside
// parseBatchManifest() itself.
test('parseBatchManifest: a valid manifest round-trips with members stringified', () => {
  const m = parseBatchManifest(
    JSON.stringify({ slug: 'batch-x', sessionNum: 5, host: 'H', members: [1362, '1365'] }),
  );
  assert.deepEqual(m, { slug: 'batch-x', sessionNum: 5, host: 'H', members: ['1362', '1365'] });
});

test('parseBatchManifest: absent / empty / garbage / non-object / empty-members → null', () => {
  assert.equal(parseBatchManifest(undefined), null);
  assert.equal(parseBatchManifest(''), null);
  assert.equal(parseBatchManifest('   '), null);
  assert.equal(parseBatchManifest('not json'), null);
  assert.equal(parseBatchManifest('[1,2,3]'), null); // array, not an object
  assert.equal(parseBatchManifest('null'), null);
  assert.equal(parseBatchManifest(JSON.stringify({ slug: 'batch-x' })), null); // no members
  assert.equal(parseBatchManifest(JSON.stringify({ slug: 'batch-x', members: [] })), null);
});
