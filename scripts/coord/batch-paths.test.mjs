// scripts/batch-paths.test.mjs (plan 1467) — the batch-folder ABI helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

// Stale-roster safety (plan 2459 item 6): a roster whose members have ALL moved on is
// still reported verbatim by this LOW-LEVEL helper (it never verifies members still
// resolve anywhere) — the "never refuses anything" property is a property of the
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
