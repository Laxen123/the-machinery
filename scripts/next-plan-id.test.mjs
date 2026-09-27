// scripts/next-plan-id.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeNextId,
  allocatePlanId,
  nextIdFromRepo,
  nextIdWithFloor,
  readPlanIdFloor,
  raisePlanIdFloor,
  parsePlanIdFloor,
  PLAN_ID_FLOOR_REF,
  ensureReadyStatusLine,
  ensureSummaryFrontmatter,
  ensureStageFrontmatter,
  idTakenByOther,
  buildClaimOps,
  doClaim,
  findExistingSlugPlan,
  mintBanner,
  _getLoadConfigCallCount,
  _resetLoadConfigCallCount,
} from './next-plan-id.mjs';
import {
  readFrontmatterSummary,
  readFrontmatterKey,
  upsertFrontmatterKey,
  READY_FOLDER,
} from './coord/build-index-lib.mjs';
import { indexIsCurrent, regenerateIndex } from './coord/build-index.mjs';
import { MINT_BANNER_LINE } from './coord/mint-lines.mjs';
import { findStageStatusProseViolations } from './coord/board-write-gate.mjs';
// plan 3341 review (key 0dff51): the SAME table onPick's EXEC_MODELS_WITH_SEGMENT is
// now derived from — imported here (not re-declared) so the regression test below
// exercises whatever lanes the table carries, rather than naming 'fable'/'sol' itself.
import { LANE_SEGMENTS } from './coord/lint-filename-execmodel-drift.mjs';
import { execModelDefaultLane } from './coord/exec-model-default-lib.mjs';
import { MUTATION_BANNER_LABEL } from './coord/build-index-lib.mjs';
// loadCoordConfig is used directly against isolated fixture roots below (never against this
// repo's own root) — e.g. the config-read-count test that snapshots r.seed's own config.
import { loadCoordConfig } from './coord/coord-config.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'next-plan-id.mjs');

// plan 3958: same rationale as build-index-lib.test.mjs's own `sw()` — MUTATION_BANNER_LABEL is
// the kit's neutral 'DATA-WRITE' default there, not vetapp's real 'SEED-WRITE' row, and is the
// IDENTITY function on vetapp itself (where the label really is 'SEED-WRITE').
const sw = (s) => s.replaceAll('SEED-WRITE', MUTATION_BANNER_LABEL);

// plan 4071 D1/D2: buildClaimOps takes the allowlist from `loadCoordConfig(mainDir)` — a bare
// mkdtempSync tmpdir (this file's usual direct-call fixture) carries NO coord.config.json of
// its own, so its default read is `[]` (no category gate, D1). Tests below that mean to
// exercise the REAL vetapp taxonomy drop an equivalent coord.config.json into that tmpdir first
// (writeVetappCategoryConfig), matching done-worktree.test.mjs's precedent for fixture config.
// plan 3958: this module ships as-is into the public coord-kit, so a shipped core test must not
// pin THIS repo's real coord.config.json planCategories row (the kit's own config carries none
// at all) — a fixed, portable fixture (today's real vetapp values, kept as a snapshot) instead.
const VETAPP_PLAN_CATEGORIES = {
  allowlist: ['Coord', 'Pipe', 'Infra', 'DQ', 'App', 'UI', 'SEO', 'Biz', 'MAIL', 'Other'],
  evidenceGated: ['Pipe', 'DQ', 'App', 'UI'],
};
function writeVetappCategoryConfig(dir) {
  writeFileSync(
    join(dir, 'coord.config.json'),
    JSON.stringify({ planCategories: { allowlist: VETAPP_PLAN_CATEGORIES.allowlist } }),
  );
}
// Same idea for the evidence-floor gate's OWN key — the `claim --ready` F5/R5 CLI tests below
// drive the real subprocess against a `makeCheckout()` fixture that (like the bare tmpdir
// above) carries no coord.config.json of its own.
function writeVetappEvidenceGateConfig(dir) {
  writeFileSync(
    join(dir, 'coord.config.json'),
    JSON.stringify({ planCategories: { evidenceGated: VETAPP_PLAN_CATEGORIES.evidenceGated } }),
  );
}

// Plan 3656: the Tier-0 `exempt-mechanical` backfill stamps whatever lane
// `scripts/exec-model-default.json` names, so the basename segment these assertions expect
// follows the toggle rather than a pinned lane — a flip must never turn the suite red.
const DEFAULT_LANE = execModelDefaultLane();
const DEFAULT_SEG = LANE_SEGMENTS.find((s) => s.lane === DEFAULT_LANE)?.marker ?? '';

// plan 338: clear inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE so the temp-repo
// helpers below honour `git -C <tmpdir>` / `cwd` even when this suite runs inside
// a git hook (which exports those vars and would otherwise redirect git ops onto
// the real repo — shared user.name corruption + junk commits, proven 2026-06-04).
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

// --- pure --------------------------------------------------------------------

test('computeNextId returns max(NNN)+1 zero-padded', () => {
  assert.equal(computeNextId(['001-P07-a.md', '229-Other-b.md', '014-ARCH-c.md']), '230');
  assert.equal(computeNextId(['ready/009-P06b-x.md', 'archive/231-Other-y.md']), '232');
  assert.equal(computeNextId([]), '001');
});

test('computeNextId ignores 3-digit runs that are not plan-id prefixes', () => {
  // "120 req/min" or "5500 lines" in prose must not inflate the counter
  assert.equal(
    computeNextId(['rate limit 120 req/min', 'see 5500 lines', '042-Other-z.md']),
    '043',
  );
});

test('computeNextId counts only real plan filenames, not record refs / mid-name numbers', () => {
  // Regression for the dogfooding bug: INDEX archive prose carries record refs
  // (`record-783`, no .md) and a mid-filename number (…-429-quota-…md); neither
  // is a plan id. Only the leading NNN of an actual `.md` plan file counts.
  assert.equal(
    computeNextId([
      '- `077-Other-claude-haiku-429-quota-strategy.md` — shipped', // → 077, NOT 429
      'archive narrative mentions record-783-foo and record-744-bar', // no .md → ignored
      'docs/superpowers/plans/archive/233-UI-mobile-safari.md', // → 233
    ]),
    '234',
  );
});

test('computeNextId reads ids from backticked INDEX refs', () => {
  assert.equal(
    computeNextId(['- 🟩 something → `in-progress/137-Other-x.md`', '`ready/138-P07-y.md`']),
    '139',
  );
});

test('computeNextId sees 4-digit ids (plan 1000+) — never re-mints a live id', () => {
  // The rollover bug: with `\d{3}` the counter capped at 999 and the next mint re-minted
  // 1000, colliding with the live plan. `\d{3,}` sees the 4-digit id so the counter advances.
  assert.equal(computeNextId(['999-Other-a.md', '1000-Infra-b.md']), '1001');
  assert.equal(computeNextId(['ready/1000-Infra-seedwrite.md']), '1001');
  assert.equal(computeNextId(['`in-progress/1234-DQ-x.md`']), '1235');
});

test('computeNextId: F-015 — sees a non-ASCII (Swedish öäå) slug body, aligned with idTakenByOther', () => {
  // Pre-fix, the ASCII-only `\w` body class made this filename INVISIBLE to the id-scanner
  // (while idTakenByOther's tolerant `[^/]*` could still see it as taken) — a mismatch that
  // exhausted every future mint's retry budget (repro: scan:001, taken:true). Mint-time
  // charset validation (assertSlugCharset) now prevents this file from EVER being authored, but
  // computeNextId must still see one if it somehow exists (a pre-existing bad file, or a future
  // schema change) — defense-in-depth, not the primary fix.
  assert.equal(computeNextId(['230-Other-öppettider-ändring.md']), '231');
  assert.equal(computeNextId(['docs/superpowers/plans/ready/230-Other-café.md']), '231');
});

test('computeNextId: the widened body class still excludes real separators — no over-consumption across scanned names', () => {
  // The widened Unicode body class (F-015) must NOT become fully permissive like
  // idTakenByOther's `[^/]*` — that would risk a greedy match swallowing PAST a real word
  // boundary and hiding a LATER digit-run in the same scanned blob (a real risk in INDEX.md's
  // multi-bullet text, which concatenates many bullets with plain spaces between them). A name
  // with an embedded literal space is not itself a valid mint (assertSlugCharset rejects it at
  // the source, so it's correctly invisible here too — same as before this fix) — but a
  // WELL-FORMED id later in the same scanned list must still be seen, proving the body class
  // stayed bounded rather than swallowing across the space into the next entry.
  assert.equal(computeNextId(['230-Other-with space.md', '235-Other-fine.md']), '236');
});

test('idTakenByOther: detects a sibling file sharing the id, ignores our own + other ids', () => {
  const paths = [
    'docs/superpowers/plans/archive/229-Other-old.md',
    'docs/superpowers/plans/ready/230-DQ-sibling.md',
    'docs/superpowers/plans/in-progress/231-UI-mine.md',
  ];
  // 230 is taken by a DIFFERENT file than the one we're about to write
  assert.equal(idTakenByOther(paths, '230', 'docs/superpowers/plans/ready/230-UI-mine.md'), true);
  // our own path doesn't count as a collision
  assert.equal(
    idTakenByOther(paths, '231', 'docs/superpowers/plans/in-progress/231-UI-mine.md'),
    false,
  );
  // a free id
  assert.equal(idTakenByOther(paths, '300', 'docs/superpowers/plans/ready/300-UI-mine.md'), false);
});

test('idTakenByOther: year-2026 collision - legacy date-prefixed basenames are NOT id claims', () => {
  // 2026-07-18 repo-wide mint wedge: the id counter reached 2026, and the old
  // `${id}-[^/]*` guard read `archive/2026-05-17-....md` (a DATE-prefixed legacy
  // basename) as "id 2026 taken", while computeNextId (anchored on a LETTER after
  // the id dash) kept proposing 2026 - every mint exhausted its attempt budget.
  // The guard now shares computeNextId's letter rule; keep both parsers agreeing.
  const legacy = [
    'docs/superpowers/plans/archive/2026-05-17-adaptive-bouncing-castle-uiux-session.md',
    'docs/superpowers/plans/archive/2026-05-29-phone-only-opening-hours-backfill.md',
  ];
  assert.equal(
    idTakenByOther(legacy, '2026', 'docs/superpowers/plans/pending-approval/2026-Infra-x.md'),
    false,
  );
  // and computeNextId agrees: the date form contributes no id either
  assert.equal(computeNextId(legacy), '001');
  // a REAL modern id-2026 plan file is still detected as taken
  assert.equal(
    idTakenByOther(
      ['docs/superpowers/plans/pending-approval/2026-Infra-other.md'],
      '2026',
      'docs/superpowers/plans/pending-approval/2026-Infra-x.md',
    ),
    true,
  );
  // an older `<id>-YYYY-MM-DD-slug.md` archived shape (a REAL id, just dated) is
  // also still detected as taken — the exclusion only matches a bare MM-DD
  // continuation right after the id dash, not a full date one level over (plan 2039).
  assert.equal(
    idTakenByOther(
      ['docs/superpowers/plans/archive/100-2026-05-16-card-ux-followups.md'],
      '100',
      'docs/superpowers/plans/pending-approval/100-Infra-x.md',
    ),
    true,
  );
});

test('idTakenByOther: a longer id sharing the same 3-digit prefix is not a collision', () => {
  // 2300-… / 7720-… must not match the 230 / 772 guard (boundary + literal `-`)
  const paths = [
    'docs/superpowers/plans/ready/2300-Other-x.md',
    'docs/superpowers/plans/ready/0772-Other-y.md',
  ];
  assert.equal(idTakenByOther(paths, '230', 'docs/superpowers/plans/ready/230-UI-z.md'), false);
  assert.equal(idTakenByOther(paths, '772', 'docs/superpowers/plans/ready/772-UI-z.md'), false);
});

test('idTakenByOther: matches a basename with non-ASCII / spaces (verbatim path from ls-files -z)', () => {
  // `-z` emits paths VERBATIM (no C-quoting), and the `[^/]*` body matches any
  // basename chars — so a dup is caught even when the filename is non-conventional.
  const paths = [
    'docs/superpowers/plans/ready/230-Other-café.md',
    'docs/superpowers/plans/ready/231-Other-with spaces.md',
  ];
  assert.equal(idTakenByOther(paths, '230', 'docs/superpowers/plans/ready/230-UI-mine.md'), true);
  assert.equal(idTakenByOther(paths, '231', 'docs/superpowers/plans/ready/231-UI-mine.md'), true);
});

// plan 2678: a plan filed one level down in a category subfolder must still be seen
// as an id claim — idClaimPattern anchors on `(?:^|/)` + the id digits, which is
// oblivious to how many path segments precede the basename, so this is a REGRESSION
// PIN of already-correct behaviour (not a fix): without it, a category-subfolder
// plan's id could silently collide with a fresh mint that only ever scanned flat paths.
test("idTakenByOther: still sees a category-subfolder plan's id as taken (plan 2678)", () => {
  const paths = ['docs/superpowers/plans/ready/infra/500-Infra-nested.md'];
  assert.equal(
    idTakenByOther(paths, '500', 'docs/superpowers/plans/ready/500-Infra-mine.md'),
    true,
  );
  assert.equal(
    idTakenByOther(paths, '501', 'docs/superpowers/plans/ready/501-Infra-mine.md'),
    false,
  );
});

// --- slug/content-dup guard (plan 882) --------------------------------------

test('findExistingSlugPlan: matches category+slug across folders, excludes own, ignores different category / absent', () => {
  const paths = [
    'docs/superpowers/plans/archive/638-Other-docs-bloat.md',
    'docs/superpowers/plans/ready/879-DQ-stockholm12-foo.md',
    'docs/superpowers/plans/in-progress/882-Infra-minter-slug-content-dup-guard.md',
  ];
  // exact category+slug, any id, any folder
  assert.equal(
    findExistingSlugPlan(paths, 'DQ', 'stockholm12-foo'),
    'docs/superpowers/plans/ready/879-DQ-stockholm12-foo.md',
  );
  // our own path is excluded (the file we're authoring)
  assert.equal(
    findExistingSlugPlan(
      paths,
      'Infra',
      'minter-slug-content-dup-guard',
      'docs/superpowers/plans/in-progress/882-Infra-minter-slug-content-dup-guard.md',
    ),
    null,
  );
  // same slug, DIFFERENT category → not a match
  assert.equal(findExistingSlugPlan(paths, 'UI', 'stockholm12-foo'), null);
  // absent slug → null
  assert.equal(findExistingSlugPlan(paths, 'DQ', 'absent'), null);
});

test('findExistingSlugPlan: a 4-digit-id sibling IS caught as a dup; full-filename anchor; slug regex chars literal (plan 1002)', () => {
  const paths = [
    'docs/superpowers/plans/ready/1002-Infra-minter-slug-content-dup-guard.md', // 4-digit id
    'docs/superpowers/plans/ready/230-Other-aXbXc.md',
  ];
  // `\d{3,}` (plan 1002): a 4-digit-id plan with the SAME category+slug is now caught as a
  // dup. Under the old `\d{3}` it was silently missed (1002 → "100" then "2", no `-`), so the
  // minter would mint a SECOND id for an already-filed plan.
  assert.equal(
    findExistingSlugPlan(paths, 'Infra', 'minter-slug-content-dup-guard'),
    'docs/superpowers/plans/ready/1002-Infra-minter-slug-content-dup-guard.md',
  );
  // still a FULL-filename anchor, not a prefix: a different slug under the same id is NOT a match.
  assert.equal(findExistingSlugPlan(paths, 'Infra', 'minter-slug'), null);
  // a `.`-bearing search slug is escaped → it must NOT match the literal `aXbXc`
  assert.equal(findExistingSlugPlan(paths, 'Other', 'a.b.c'), null);
});

test('findExistingSlugPlan: recognizes lane-marked basenames without consuming a marker-prefixed category', () => {
  const paths = [
    'docs/superpowers/plans/ready/230-SOL-Other-retried-claim.md',
    'docs/superpowers/plans/ready/231-FABLE-DQ-category-marker.md',
  ];
  assert.equal(
    findExistingSlugPlan(paths, 'Other', 'retried-claim'),
    'docs/superpowers/plans/ready/230-SOL-Other-retried-claim.md',
  );
  assert.equal(
    findExistingSlugPlan(paths, 'FABLE-DQ', 'category-marker'),
    'docs/superpowers/plans/ready/231-FABLE-DQ-category-marker.md',
  );
});

// plan 3463 delta-review (key 277249, CONFIRMED): the MARKER-SWAP case. A `--category
// FABLE-DQ` mint whose --body carries an explicit `execModel: sol` keeps that lane
// (`keepExisting`), and renameForExecModel REPLACES the basename's marker rather than
// stacking one — so the file lands as `230-SOL-DQ-<slug>.md` while the caller still
// searches under the raw category `FABLE-DQ`. Matching the raw category (with or without
// an optional marker in front of it) can never find that file, so a retry mints a
// duplicate under a fresh id — the recurring 878/879 class this guard exists to stop.
// The lane marker is orthogonal routing, so the duplicate question is category+slug with
// the marker stripped from BOTH sides: hence stripExecModelSegment on the category, the
// same normalization the category-allowlist gate above already applies.
test('findExistingSlugPlan: a marker-SWAPPED basename still matches its marker-prefixed category', () => {
  const paths = ['docs/superpowers/plans/ready/230-SOL-DQ-swapped-lane.md'];
  assert.equal(
    findExistingSlugPlan(paths, 'FABLE-DQ', 'swapped-lane'),
    'docs/superpowers/plans/ready/230-SOL-DQ-swapped-lane.md',
  );
  // and the bare-category spelling of the same plan is the same duplicate
  assert.equal(
    findExistingSlugPlan(paths, 'DQ', 'swapped-lane'),
    'docs/superpowers/plans/ready/230-SOL-DQ-swapped-lane.md',
  );
});

// --- state machine (injected ops) -------------------------------------------

test('allocatePlanId returns the picked id when the first push wins', async () => {
  let picks = 0;
  const res = await allocatePlanId({
    scanIds: () => '230',
    onPick: () => {
      picks++;
      return { cleanup: () => {} };
    },
    tryCommitPush: () => {},
  });
  assert.deepEqual(res, { id: '230', attempts: 1 });
  assert.equal(picks, 1);
});

test('allocatePlanId bumps + retries when the loser is rejected, cleaning up the stale attempt', async () => {
  const scans = ['230', '231']; // fresh fetch sees 230 taken on the 2nd scan
  let s = 0;
  const cleaned = [];
  let push = 0;
  const res = await allocatePlanId({
    scanIds: () => scans[s++],
    onPick: (id) => ({ cleanup: () => cleaned.push(id) }),
    tryCommitPush: () => {
      if (++push === 1) {
        const e = new Error('non-ff');
        e.nonFastForward = true;
        throw e;
      }
    },
  });
  assert.deepEqual(res, { id: '231', attempts: 2 });
  assert.deepEqual(cleaned, ['230'], 'the stale 230 artefacts were cleaned up exactly once');
});

test('allocatePlanId gives up after maxAttempts of persistent rejection', async () => {
  let cleaned = 0;
  await assert.rejects(
    () =>
      allocatePlanId({
        scanIds: () => '230',
        onPick: () => ({ cleanup: () => cleaned++ }),
        tryCommitPush: () => {
          const e = new Error('non-ff');
          e.nonFastForward = true;
          throw e;
        },
        maxAttempts: 3,
      }),
    /could not allocate an id after 3 attempts/,
  );
  assert.equal(cleaned, 3);
});

test('allocatePlanId rethrows non-nonFastForward errors immediately', async () => {
  await assert.rejects(
    () =>
      allocatePlanId({
        scanIds: () => '230',
        onPick: () => ({ cleanup: () => {} }),
        tryCommitPush: () => {
          throw new Error('pre-push hook failed');
        },
      }),
    /pre-push hook failed/,
  );
});

// --- real-git: nextIdFromRepo reads the actual tree --------------------------

function makeCheckout() {
  const remote = mkdtempSync(join(tmpdir(), 'nextid-remote-'));
  execFileSync('git', ['init', '--bare', '-q', remote]);
  const seed = mkdtempSync(join(tmpdir(), 'nextid-seed-'));
  const g = (...a) => execFileSync('git', ['-C', seed, ...a], { encoding: 'utf8' });
  execFileSync('git', ['clone', '-q', remote, seed]);
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  g('checkout', '-q', '-b', 'master');
  mkdirSync(join(seed, 'docs', 'superpowers', 'plans', 'ready'), { recursive: true });
  mkdirSync(join(seed, 'docs', 'superpowers', 'plans', 'archive'), { recursive: true });
  writeFileSync(
    join(seed, 'docs', 'superpowers', 'plans', 'archive', '229-Other-old.md'),
    '# old\n',
  );
  writeFileSync(
    join(seed, 'docs', 'INDEX.md'),
    [
      '# Plans index',
      '',
      '## Active / open',
      '',
      '## Archive',
      '',
      'Moved to `docs/superpowers/plans/archive/` on 2026-01-01:',
      '- `229-Other-old.md` — shipped',
      '',
    ].join('\n'),
  );
  g('add', '-A');
  g('commit', '-qm', 'seed');
  g('push', '-q', '-u', 'origin', 'master');
  return {
    remote,
    seed,
    g,
    cleanup: () => [remote, seed].forEach((d) => rmSync(d, { recursive: true, force: true })),
  };
}

// Push a plan file `<id>-<cat>-<slug>.md` to the bare `remote`'s master from a
// throwaway clone — simulating a parallel session that won the id while we were
// mid-claim. File-only (no INDEX bullet): the ff-dup guard keys on the filename,
// and `nextIdFromRepo` re-scans it via ls-tree on the next attempt.
function landSibling(remote, id, cat, slug) {
  const sib = mkdtempSync(join(tmpdir(), 'nextid-sib-'));
  const g = (...a) => execFileSync('git', ['-C', sib, ...a], { encoding: 'utf8' });
  execFileSync('git', ['clone', '-q', '-b', 'master', remote, sib]);
  g('config', 'user.email', 's@s.s');
  g('config', 'user.name', 'S');
  const dir = join(sib, 'docs', 'superpowers', 'plans', 'ready');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}-${cat}-${slug}.md`), `# sibling ${id}\n`);
  g('add', '-A');
  g('commit', '-qm', `sibling ${id}`);
  g('push', '-q', 'origin', 'HEAD:master');
  rmSync(sib, { recursive: true, force: true });
}

// plan 3999 review fix round 1 (key 8116d5): push arbitrary CONTENT to an exact repo-relative
// path on the bare `remote`'s master from a throwaway clone, bypassing next-plan-id.mjs entirely
// — the regression-pin test below uses this to simulate the grandfathered-corpus shape (a plan
// already on origin with a bare `priority: high`, pre-dating the `priorityBy:` requirement)
// without going through a gate that would (correctly) refuse to author it fresh.
function landFileContent(remote, relPath, content) {
  const sib = mkdtempSync(join(tmpdir(), 'nextid-sib-'));
  const g = (...a) => execFileSync('git', ['-C', sib, ...a], { encoding: 'utf8' });
  execFileSync('git', ['clone', '-q', '-b', 'master', remote, sib]);
  g('config', 'user.email', 's@s.s');
  g('config', 'user.name', 'S');
  const full = join(sib, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  g('add', '-A');
  g('commit', '-qm', `hand-stamp ${relPath}`);
  g('push', '-q', 'origin', 'HEAD:master');
  rmSync(sib, { recursive: true, force: true });
}

test('claim bumps past a sibling id that landed in the read→push window (ff-dup guard, plan 777)', async () => {
  const r = makeCheckout(); // origin max id = 229 → next 230
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# Race plan\n\nbody\n'));
    const ops = buildClaimOps(r.seed, {
      category: 'UI',
      slug: 'mine',
      body: bodyFile,
      blurb: 'my plan',
    });
    // Wrap scanIds: the FIRST scan reads origin (max 229 → 230); right AFTER that
    // read, a sibling lands 230 on origin — the exact ff-dup window. The freshen
    // inside coordWrite then pulls the sibling 230 as a clean fast-forward, and
    // the guard must bump us to 231 instead of pushing a duplicate 230.
    const realScan = ops.scanIds;
    let scans = 0;
    ops.scanIds = () => {
      const id = realScan();
      if (scans++ === 0) landSibling(r.remote, '230', 'DQ', 'sibling');
      return id;
    };

    const res = await allocatePlanId(ops);
    assert.equal(res.id, '231', 'claim bumped past the sibling 230');
    assert.equal(res.attempts, 2, 'one bump (attempt 1 detected the dup, attempt 2 won)');

    // On origin: our 231 plus the sibling 230, each exactly once — no duplicate id.
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ],
      { encoding: 'utf8' },
    );
    assert.match(
      tree,
      /pending-approval\/231-UI-mine\.md/,
      'our claim landed as 231 (default mint → pending-approval/, plan 1022)',
    );
    assert.match(tree, /ready\/230-DQ-sibling\.md/, 'the sibling 230 is intact');
    const count = (re) => (tree.match(re) || []).length;
    assert.equal(count(/(?:^|\/)230-[A-Za-z][\w.-]*\.md$/gm), 1, 'exactly one 230-* file');
    assert.equal(count(/(?:^|\/)231-[A-Za-z][\w.-]*\.md$/gm), 1, 'exactly one 231-* file');

    // And the INDEX bullet points at 231, not a duplicated 230.
    const index = execFileSync('git', ['-C', r.seed, 'show', 'origin/master:docs/INDEX.md'], {
      encoding: 'utf8',
    });
    assert.match(index, /🟩 my plan → `pending-approval\/231-UI-mine\.md`/);
  } finally {
    r.cleanup();
  }
});

test('nextIdFromRepo computes the next id from a real tree (229 → 230)', () => {
  const r = makeCheckout();
  try {
    assert.equal(nextIdFromRepo(r.seed, { fromOrigin: true }), '230');
  } finally {
    r.cleanup();
  }
});

// plan 2678: scanAllocatedNames' enumeration (`git ls-tree -r`) is ALREADY recursive —
// this is a regression PIN of already-correct behaviour, not a fix. Without it a plan
// filed one level down in a category subfolder could silently be invisible to the
// counter, re-minting a live id (the exact class idTakenByOther's own plan-2678 pin,
// above, guards from the other side of the mint).
test('plan 2678: nextIdFromRepo counts a plan filed in a category subfolder toward the max id', () => {
  const r = makeCheckout(); // origin max id 229 → next 230
  try {
    const dir = join(r.seed, 'docs', 'superpowers', 'plans', 'ready', 'infra');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '500-Infra-nested.md'), '# nested\n');
    r.g('add', '-A');
    r.g('commit', '-qm', 'nested plan');
    r.g('push', '-q', 'origin', 'master');
    assert.equal(
      nextIdFromRepo(r.seed, { fromOrigin: true }),
      '501',
      'the category-subfolder plan (id 500) must be counted, not skipped',
    );
  } finally {
    r.cleanup();
  }
});

test('claim CLI commits the plan file + INDEX bullet and pushes to origin', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# Smoke plan\n\nbody\n'));
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'smoke',
        '--body',
        bodyFile,
        '--blurb',
        'smoke test plan',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(out.trim(), '230', 'CLI prints the claimed id');

    // The plan file and its INDEX bullet must be on origin/master.
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ],
      { encoding: 'utf8' },
    );
    assert.match(tree, /pending-approval\/230-Other-smoke\.md/);
    const index = execFileSync('git', ['-C', r.seed, 'show', 'origin/master:docs/INDEX.md'], {
      encoding: 'utf8',
    });
    assert.match(index, /🟩 smoke test plan → `pending-approval\/230-Other-smoke\.md`/);
  } finally {
    r.cleanup();
  }
});

// plan 1362 (D2) — a mint whose body already carries `execModel: fable` lands with the
// FABLE- filename segment from birth, so it never needs a follow-up stamp-exec-model run
// (and never trips lint-filename-execmodel-drift.mjs on a LATER, unrelated push).
test('claim CLI: a body carrying execModel: fable mints with the FABLE- filename segment (plan 1362)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      [
        '---',
        'execModel: fable',
        '---',
        '',
        sw('> 🟩 SEED-WRITE: NO'),
        '',
        '# Fable plan',
        '',
        'body',
        '',
      ].join('\n'),
    );
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'fable-mint',
        '--body',
        bodyFile,
        '--blurb',
        'fable mint test plan',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(out.trim(), '230', 'CLI prints the claimed id (unaffected by the stamp)');

    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ],
      { encoding: 'utf8' },
    );
    assert.match(
      tree,
      /pending-approval\/230-FABLE-Other-fable-mint\.md/,
      'mint carries the FABLE- segment',
    );
    assert.doesNotMatch(
      tree,
      /pending-approval\/230-Other-fable-mint\.md$/m,
      'no unstamped duplicate',
    );
    const index = execFileSync('git', ['-C', r.seed, 'show', 'origin/master:docs/INDEX.md'], {
      encoding: 'utf8',
    });
    assert.match(
      index,
      /🟩 fable mint test plan → `pending-approval\/230-FABLE-Other-fable-mint\.md`/,
      'INDEX bullet points at the stamped filename',
    );
    const body = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'show',
        'origin/master:docs/superpowers/plans/pending-approval/230-FABLE-Other-fable-mint.md',
      ],
      { encoding: 'utf8' },
    );
    assert.match(body, /^execModel: fable$/m);
  } finally {
    r.cleanup();
  }
});

// plan 1561: --category FABLE-DQ bakes the FABLE- segment into the CATEGORY itself
// (the reverse of plan 1362's frontmatter-driven rename above) with a body that
// carries NO leading `---` frontmatter block at all — the exact repro that used to
// abort mid-mint with "exec-model-stamp: internal — ... should be unreachable" and
// roll the attempt back.
test('claim CLI: a frontmatter-less body + a FABLE- category mints cleanly, auto-stamping execModel: fable (plan 1561)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    // Deliberately no leading `---` frontmatter block.
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# Frontmatter-less FABLE plan\n\nbody\n'));
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'FABLE-DQ',
        '--slug',
        'no-frontmatter',
        '--body',
        bodyFile,
        '--blurb',
        'frontmatter-less fable mint test plan',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(out.trim(), '230', 'CLI prints the claimed id (mint did not abort/roll back)');

    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ],
      { encoding: 'utf8' },
    );
    assert.match(
      tree,
      /pending-approval\/230-FABLE-DQ-no-frontmatter\.md/,
      'mint lands under the FABLE-DQ category as given, no crash/rollback',
    );
    const body = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'show',
        'origin/master:docs/superpowers/plans/pending-approval/230-FABLE-DQ-no-frontmatter.md',
      ],
      { encoding: 'utf8' },
    );
    assert.match(body, /^execModel: fable$/m, 'execModel: fable was auto-stamped into frontmatter');
    assert.match(body, /^summary: /m, 'the summary/stage ensure*Frontmatter stamps still ran');
  } finally {
    r.cleanup();
  }
});

test('claim CLI: a fresh mint body carries `stage: stub` frontmatter + the spec-pass-pending Status note (plan 1292)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# Stage plan\n\nbody\n'));
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'stage',
        '--body',
        bodyFile,
        '--blurb',
        'stage test plan',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    ).trim();
    assert.equal(out, '230');

    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const planFile = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'show',
        'origin/master:docs/superpowers/plans/pending-approval/230-Other-stage.md',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(readFrontmatterKey(planFile, 'stage'), 'stub', 'fresh mint carries stage: stub');
    // Same frontmatter block also carries the back-filled summary (no duplicate `---` blocks).
    assert.equal(readFrontmatterSummary(planFile), 'stage test plan');
    assert.equal((planFile.match(/^---$/gm) || []).length, 2, 'a single frontmatter block');
    assert.match(
      planFile,
      /\*\*Status:\*\* 📋 STUB — opened \d{4}-\d{2}-\d{2}\. <!-- spec-pass pending -->/,
      'the Status line carries the spec-pass-pending note',
    );
  } finally {
    r.cleanup();
  }
});

test('claim CLI: a body that already has frontmatter with other keys gets `stage: stub` merged in, and an existing `stage:` is never overwritten (plan 1292)', () => {
  const r = makeCheckout();
  try {
    // Body already carries a frontmatter block (an `unblock:` key, the 954 shape) but no
    // `stage:` — the mint must merge `stage: stub` in without clobbering `unblock:`.
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      sw('---\nunblock: manual\n---\n\n> 🟩 SEED-WRITE: NO\n\n# Merge plan\n\nbody\n'),
    );
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'merge-stage',
        '--body',
        bodyFile,
        '--blurb',
        'merge stage plan',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    ).trim();
    assert.equal(out, '230');

    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const planFile = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'show',
        'origin/master:docs/superpowers/plans/pending-approval/230-Other-merge-stage.md',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(readFrontmatterKey(planFile, 'stage'), 'stub', 'stage: stub was merged in');
    assert.equal(readFrontmatterKey(planFile, 'unblock'), 'manual', 'unblock: survives untouched');
    assert.equal((planFile.match(/^---$/gm) || []).length, 2, 'still a single frontmatter block');
  } finally {
    r.cleanup();
  }
});

test('claim CLI: a body with a pre-existing `stage:` value is never overwritten by the mint (plan 1292)', () => {
  const r = makeCheckout();
  try {
    // Body already carries a fully-formed frontmatter block, including its own `stage:`
    // stamp (e.g. authored by a spec-pass upstream, or hand-carried between tools) — the
    // mint must leave it exactly as-is.
    //
    // plan 2378: this mint takes `--ready`. A `stage: specced` body minted into the
    // DEFAULT pending-approval/ is the plan-1371 D7 violation itself (pending-approval/
    // holds only `stage: stub`) — the exact shape plans 2373 and 2375 landed on
    // origin/master unchallenged on 2026-07-25, wedging an unrelated docs-only push until
    // both were hand-corrected. The write-time gate now REFUSES it, so the old fixture was
    // asserting the mint's behaviour on a tree state the repo forbids. `--ready` is the
    // sanctioned home for an already-specced body ("hand this to the drain now", plan
    // 1022) and preserves this test's actual intent unchanged: the pre-existing stamp
    // survives the mint.
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      "---\nsummary: 'already specced'\nstage: specced\nspecReview: exempt-mechanical\n---\n\n" +
        sw(
          '> 🟩 SEED-WRITE: NO\n\n> 💰 **Cost forecast:** $0 — no LLM spend.\n\n# Preserved stage plan\n\nbody\n',
        ),
    );
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'preserved-stage',
        '--body',
        bodyFile,
        '--ready',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    ).trim();
    assert.equal(out, '230');

    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const planFile = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'show',
        // Plan 3656: an exempt-mechanical ready mint stamps whatever lane the toggle
        // names, so the basename marker (if any) is derived, not pinned.
        `origin/master:docs/superpowers/plans/ready/230-${DEFAULT_SEG}Other-preserved-stage.md`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(
      readFrontmatterKey(planFile, 'stage'),
      'specced',
      'the pre-existing stage: specced stamp is NOT overwritten to stub',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2378: the mint REFUSES a `stage: specced` body landing in the default pending-approval/', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      "---\nsummary: 'already specced'\nstage: specced\n---\n\n" +
        sw('> 🟩 SEED-WRITE: NO\n\n# Specced stub in the stub pen\n\nbody\n'),
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            CLI,
            'claim',
            '--category',
            'Other',
            '--slug',
            'specced-in-stub-pen',
            '--body',
            bodyFile,
          ],
          { cwd: r.seed, encoding: 'utf8', stdio: 'pipe' },
        ),
      (e) => {
        const out = `${e.stdout || ''}${e.stderr || ''}`;
        assert.match(out, /REFUSING this write/);
        assert.match(out, /stage: specced in pending-approval\//);
        assert.match(out, /move-plan\.mjs <id> ready/);
        return true;
      },
    );
    // and nothing was minted: no plan file reached origin/master
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      ['-C', r.seed, 'ls-tree', '-r', '--name-only', 'origin/master', 'docs/superpowers/plans/'],
      { encoding: 'utf8' },
    );
    assert.doesNotMatch(tree, /specced-in-stub-pen/);
  } finally {
    r.cleanup();
  }
});

test('claim is idempotent on a re-claim of an identical plan (plan 882): returns the existing id, no second file', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    // Explicit Status line ⇒ ensureReadyStatusLine is a no-op ⇒ planBody is
    // date-independent, so both claims compare byte-identical.
    writeFileSync(
      bodyFile,
      sw(
        '> 🟩 SEED-WRITE: NO\n\n**Status:** 📋 STUB — opened 2026-01-01.\n\n# Idem plan\n\nbody\n',
      ),
    );
    const run = () =>
      execFileSync(
        process.execPath,
        [
          CLI,
          'claim',
          '--category',
          'Other',
          '--slug',
          'idem',
          '--body',
          bodyFile,
          '--blurb',
          'idem plan',
        ],
        { cwd: r.seed, encoding: 'utf8' },
      ).trim();
    assert.equal(run(), '230', 'first claim allocates 230');
    assert.equal(run(), '230', 're-claim returns the SAME id (idempotent), not a bumped 231');

    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(
      (tree.match(/-Other-idem\.md/g) || []).length,
      1,
      'exactly one idem plan file — no duplicate',
    );
    assert.doesNotMatch(tree, /(?:^|\/)231-/m, 'no 231 was minted by the re-claim');
  } finally {
    r.cleanup();
  }
});

test('claim idempotent re-claim of a 4-DIGIT plan returns its FULL id, not a 3-char slice (plan 1002)', () => {
  const r = makeCheckout();
  try {
    // Bump the next id past 999 so the first claim allocates a 4-digit id (plan 1000+).
    writeFileSync(join(r.seed, 'docs/superpowers/plans/archive/999-Other-filler.md'), '# filler\n');
    r.g('add', '-A');
    r.g('commit', '-qm', 'seed 999');
    r.g('push', '-q', 'origin', 'master');

    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      sw(
        '> 🟩 SEED-WRITE: NO\n\n**Status:** 📋 STUB — opened 2026-01-01.\n\n# Idem4 plan\n\nbody\n',
      ),
    );
    const run = () =>
      execFileSync(
        process.execPath,
        [
          CLI,
          'claim',
          '--category',
          'Infra',
          '--slug',
          'idem4',
          '--body',
          bodyFile,
          '--blurb',
          'idem4 plan',
        ],
        { cwd: r.seed, encoding: 'utf8' },
      ).trim();
    assert.equal(run(), '1000', 'first claim allocates the 4-digit id 1000');
    // Idempotent re-claim returns the EXISTING id. Under the old `.slice(0, 3)` this
    // returned "100" (wrong plan); the dup-guard must report the full "1000".
    assert.equal(run(), '1000', 're-claim of a 4-digit dup returns 1000, not the sliced "100"');
  } finally {
    r.cleanup();
  }
});

test('claim idempotent re-claim is CRLF-immune (plan 882): a CRLF --body still matches the LF blob', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body-crlf.md');
    // CRLF body — git stores the blob as LF (autocrlf), so the re-claim's planBody
    // (read back as CRLF) must be line-ending-normalized to match git show's LF blob.
    // Without the norm() in preflightSlugGuard this re-claim would hard-fail "DIFFERENT
    // content" and exit non-zero (execFileSync would throw) instead of returning 230.
    writeFileSync(
      bodyFile,
      sw(
        '> 🟩 SEED-WRITE: NO\r\n\r\n**Status:** 📋 STUB — opened 2026-01-01.\r\n\r\n# CRLF plan\r\n\r\nbody\r\n',
      ),
    );
    const run = () =>
      execFileSync(
        process.execPath,
        [
          CLI,
          'claim',
          '--category',
          'Other',
          '--slug',
          'crlf',
          '--body',
          bodyFile,
          '--blurb',
          'crlf plan',
        ],
        { cwd: r.seed, encoding: 'utf8' },
      ).trim();
    assert.equal(run(), '230', 'first claim allocates 230');
    assert.equal(
      run(),
      '230',
      're-claim with the same CRLF body returns the SAME id (CRLF-immune)',
    );
  } finally {
    r.cleanup();
  }
});

test('claim hard-fails on the same slug with DIFFERENT content (plan 882) — no duplicate, no bump', () => {
  const r = makeCheckout();
  try {
    const a = join(r.seed, 'a.md');
    const b = join(r.seed, 'b.md');
    writeFileSync(
      a,
      sw(
        '> 🟩 SEED-WRITE: NO\n\n**Status:** 📋 STUB — opened 2026-01-01.\n\n# Version A\n\nalpha\n',
      ),
    );
    writeFileSync(
      b,
      sw(
        '> 🟩 SEED-WRITE: NO\n\n**Status:** 📋 STUB — opened 2026-01-01.\n\n# Version B\n\nbeta\n',
      ),
    );
    const claim = (body) =>
      execFileSync(
        process.execPath,
        [
          CLI,
          'claim',
          '--category',
          'Other',
          '--slug',
          'collide',
          '--body',
          body,
          '--blurb',
          'collide plan',
        ],
        { cwd: r.seed, encoding: 'utf8' },
      );
    assert.equal(claim(a).trim(), '230', 'first claim allocates 230');
    assert.throws(
      () => claim(b),
      (e) =>
        /already exists as 230[\s\S]*DIFFERENT content/.test(`${e.stderr || ''}${e.message || ''}`),
      'a same-slug different-content claim is rejected',
    );

    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(
      (tree.match(/-Other-collide\.md/g) || []).length,
      1,
      'no second collide file authored',
    );
    assert.doesNotMatch(tree, /(?:^|\/)231-/m, 'no 231 was minted by the rejected claim');
  } finally {
    r.cleanup();
  }
});

test('ensureReadyStatusLine: leaves a body that already has a Status line unchanged', () => {
  const body = '# T\n\n**Status:** 🔄 IN PROGRESS — picked up.\n\nbody\n';
  assert.equal(ensureReadyStatusLine(body, '2026-06-06'), body);
});

test('ensureReadyStatusLine: inserts a READY line after the cost-forecast banner', () => {
  const body =
    sw('> 🟩 **SEED-WRITE: NO** — code only.\n') +
    '> 💰 **Cost forecast:** $0.\n' +
    '\n# T\n\nbody\n';
  const out = ensureReadyStatusLine(body, '2026-06-06');
  assert.match(
    out,
    /\*\*Cost forecast:\*\* \$0\.\n\n\*\*Status:\*\* 📋 STUB — opened 2026-06-06\./,
  );
});

test('ensureReadyStatusLine: preserves $-pattern sequences ($&, $$) in the anchor banner', () => {
  const body = '> 💰 **Cost forecast:** weird $& and $$ signs.\n\n# T\n\nbody\n';
  const out = ensureReadyStatusLine(body, '2026-06-06');
  assert.match(out, /\*\*Cost forecast:\*\* weird \$& and \$\$ signs\.\n\n\*\*Status:\*\* 📋 STUB/);
});

test('ensureReadyStatusLine: splices at the REAL anchor match, not an earlier occurrence of the same literal text (review finding, plan 2409)', () => {
  // The H1 line's literal text also appears earlier, quoted inside a prose
  // sentence. A literal body.replace(anchor, …) would splice into that FIRST
  // occurrence; the real anchor match (found via body.match) is the second, real
  // H1 line — spliceAtMatch must use the match's own index, not a string search.
  const body = 'Quoting the heading here: "# T" for reference.\n\n# T\n\nbody\n';
  const out = ensureReadyStatusLine(body, '2026-06-06');
  assert.match(out, /^Quoting the heading here: "# T" for reference\.\n\n# T\n\n\*\*Status:\*\*/);
  assert.doesNotMatch(out, /"# T\n\n\*\*Status:\*\*/);
});

test('ensureReadyStatusLine: falls back to the SEED-WRITE banner, then the H1, then prepend', () => {
  assert.match(
    ensureReadyStatusLine(sw('> 🟥 **SEED-WRITE: YES**\n\n# T\nx\n'), '2026-06-06'),
    new RegExp(`\\*\\*${MUTATION_BANNER_LABEL}: YES\\*\\*\\n\\n\\*\\*Status:\\*\\* 📋 STUB`),
  );
  assert.match(
    ensureReadyStatusLine('# Only a heading\n\nx\n', '2026-06-06'),
    /# Only a heading\n\n\*\*Status:\*\* 📋 STUB/,
  );
  assert.match(
    ensureReadyStatusLine('plain prose, no structure\n', '2026-06-06'),
    /^\*\*Status:\*\* 📋 STUB — opened 2026-06-06\. <!-- spec-pass pending -->\n\nplain prose/,
  );
});

// plan 1292: the Status line a fresh mint constructs now carries a trailing HTML-comment
// note flagging that no spec-pass has reviewed the plan yet.
test('ensureReadyStatusLine: a freshly constructed Status line carries the spec-pass-pending note', () => {
  const out = ensureReadyStatusLine('# T\n\nx\n', '2026-06-06');
  assert.match(out, /\*\*Status:\*\* 📋 STUB — opened 2026-06-06\. <!-- spec-pass pending -->/);
});

// plan 2587: the token is DERIVED from the effective `stage:` stamp, computed exactly as
// ensureStageFrontmatter computes it (`keepExisting: true` → the body's own `stage:` wins,
// else `stub`) — so a fresh mint can never author the `stage: stub` / `**Status:** READY`
// pair board-write-gate's `stage-status-prose` check refuses.
test('ensureReadyStatusLine: the Status token follows the effective stage stamp (plan 2587)', () => {
  // no `stage:` in the body → ensureStageFrontmatter will stamp `stage: stub` → STUB
  assert.match(
    ensureReadyStatusLine("---\nsummary: 'x'\n---\n\n# T\n\nx\n", '2026-06-06'),
    /\*\*Status:\*\* 📋 STUB — opened 2026-06-06\./,
  );
  // an author-supplied `stage: stub` → STUB (keepExisting keeps it)
  assert.match(
    ensureReadyStatusLine("---\nsummary: 'x'\nstage: stub\n---\n\n# T\n\nx\n", '2026-06-06'),
    /\*\*Status:\*\* 📋 STUB — opened 2026-06-06\./,
  );
  // an author-supplied `stage: specced` survives ensureStageFrontmatter → READY
  assert.match(
    ensureReadyStatusLine("---\nsummary: 'x'\nstage: specced\n---\n\n# T\n\nx\n", '2026-06-06'),
    /\*\*Status:\*\* 📋 READY — opened 2026-06-06\./,
  );
  // a body that ALREADY carries a Status line is returned unchanged, stage notwithstanding
  const withStatus = "---\nsummary: 'x'\nstage: specced\n---\n\n**Status:** 📋 SPECCED — kept.\n";
  assert.equal(ensureReadyStatusLine(withStatus, '2026-06-06'), withStatus);
});

// plan 2587 review finding (CONFIRMED): the early `return body` on an EXISTING Status line
// used to be unconditional, so a --body file copy-pasted from any pre-2587 plan (all of
// which carry a literal `**Status:** 📋 READY`) with no `stage:` of its own sailed past the
// heal, got `stage: stub` stamped by ensureStageFrontmatter, and the mint's own
// assertBoardInvariants call then REFUSED the write and rolled the whole claim back.
test('ensureReadyStatusLine: reconciles an existing Status token that contradicts the stage the mint will stamp (plan 2587)', () => {
  // the exact regression: pre-2587 template body, no stage key → mint stamps `stage: stub`
  const copied = sw(
    '> 🟩 SEED-WRITE: NO\n\n**Status:** 📋 READY — opened 2026-07-27.\n\n# T\n\nbody\n',
  );
  const out = ensureReadyStatusLine(copied, '2026-07-28');
  assert.match(out, /\*\*Status:\*\* 📋 STUB — opened 2026-07-27\./); // token swapped…
  assert.ok(!out.includes('📋 READY'));
  // …and the author's own remainder + the rest of the body are preserved byte-for-byte.
  assert.equal(out, copied.replace('📋 READY', '📋 STUB'));
  // and the reconciled body is CLEAN under the gate that used to refuse it
  assert.deepEqual(
    findStageStatusProseViolations([
      {
        path: 'docs/superpowers/plans/pending-approval/999-Other-t.md',
        content: ensureStageFrontmatter(out),
        basename: '999-Other-t.md',
        folder: 'pending-approval',
      },
    ]),
    [],
  );

  // the reverse pair: an author-supplied `stage: specced` body carrying a STUB token
  const specced =
    "---\nsummary: 'x'\nstage: specced\n---\n\n**Status:** 📋 STUB — opened 2026-07-27.\n";
  assert.match(ensureReadyStatusLine(specced, '2026-07-28'), /\*\*Status:\*\* 📋 READY — opened/);
});

// plan 2587 re-review finding (CONFIRMED): the reconcile used to match the RAW body, so a
// `summary:` quoting a Status-shaped line could be "fixed" instead of the plan's real line —
// and because board-write-gate's Check A stripped frontmatter, the gate then cleared the
// decoy and the real line kept contradicting, invisibly. Both now share readStatusToken.
test('ensureReadyStatusLine: a frontmatter-quoted Status decoy never steals the reconcile (plan 2587)', () => {
  const decoy = [
    '---',
    "summary: 'documents that the mint writes **Status:** 📋 READY — opened <date>. into bodies'",
    '---',
    '',
    sw('> 🟩 SEED-WRITE: NO'),
    '',
    '**Status:** 📋 READY — opened 2026-07-27.',
    '',
    '# T',
    '',
    'body',
  ].join('\n');
  const out = ensureReadyStatusLine(decoy, '2026-07-28');
  // the REAL line was reconciled…
  assert.match(out, /\n\*\*Status:\*\* 📋 STUB — opened 2026-07-27\./);
  // …and the frontmatter summary is byte-identical (its quoted READY must NOT be rewritten)
  assert.match(
    out,
    /summary: 'documents that the mint writes \*\*Status:\*\* 📋 READY — opened <date>\. into bodies'/,
  );
  // and the mint's own gate is satisfied by the result
  assert.deepEqual(
    findStageStatusProseViolations([
      {
        path: 'docs/superpowers/plans/pending-approval/999-Other-t.md',
        content: ensureStageFrontmatter(out),
        basename: '999-Other-t.md',
        folder: 'pending-approval',
      },
    ]),
    [],
  );
});

test('ensureReadyStatusLine: a NON-contradicting existing Status line is returned byte-identical (plan 2587)', () => {
  for (const line of [
    '**Status:** 📋 SPECCED — kept.',
    '**Status:** 🔄 IN PROGRESS — kept.',
    '**Status:** ✅ COMPLETED — kept.',
    '**Status:** 📅 WAITING-DATE — kept.',
    '**Status:** 📋 STUB — kept.', // agrees with the stub the mint will stamp
  ]) {
    const body = `---\nsummary: 'x'\n---\n\n# T\n\n${line}\n`;
    assert.equal(ensureReadyStatusLine(body, '2026-07-28'), body, line);
  }
});

// --- ensureSummaryFrontmatter (plan 959) -------------------------------------

test('ensureSummaryFrontmatter: injects a `---` block + single-quoted summary when the body has no frontmatter', () => {
  // A blurb with the full set of YAML-hazard characters: a colon, both quote
  // kinds, an arrow, and brackets — the exact shape build-index reads back.
  const blurb = '**[Infra]** fix X: don\'t drop the bullet → see `ready/y.md` ["q"]';
  const out = ensureSummaryFrontmatter('# Plain plan\n\nbody\n', blurb);
  // A leading frontmatter block was created.
  assert.match(out, /^---\nsummary: '/);
  // The original body is preserved after the block.
  assert.match(out, /---\n\n# Plain plan\n\nbody\n$/);
  // The build-index parser reads the blurb back VERBATIM (round-trip).
  assert.equal(readFrontmatterSummary(out), blurb);
});

test('ensureSummaryFrontmatter: a body that ALREADY has a summary key is left unchanged (author wins)', () => {
  const body = "---\nsummary: 'A richer hand-written summary.'\n---\n\n# T\n\nbody\n";
  assert.equal(ensureSummaryFrontmatter(body, 'a different blurb'), body);
});

test('ensureSummaryFrontmatter: merges summary into an existing frontmatter block WITHOUT dropping other keys (the 954 shape)', () => {
  // The 954 shape: a frontmatter block carrying `unblock:` but no `summary:`.
  const body = '---\nunblock: manual\n---\n\n# T\n\nbody\n';
  const blurb = 'merged-in blurb: with a colon';
  const out = ensureSummaryFrontmatter(body, blurb);
  // The pre-existing key survives.
  assert.equal(readFrontmatterKey(out, 'unblock'), 'manual');
  // The blurb is now readable as summary.
  assert.equal(readFrontmatterSummary(out), blurb);
  // Still exactly one leading frontmatter block (one opening + one closing `---`).
  assert.equal((out.match(/^---$/gm) || []).length, 2);
});

test('ensureSummaryFrontmatter: YAML single-quote escaping survives a blurb that contains apostrophes', () => {
  const blurb = "it's a record's 'quoted' phrase";
  const out = ensureSummaryFrontmatter('# T\n\nbody\n', blurb);
  // Doubled '' escaping is used inside the single-quoted scalar.
  assert.match(out, /summary: 'it''s a record''s ''quoted'' phrase'/);
  assert.equal(readFrontmatterSummary(out), blurb);
});

// --- ensureStageFrontmatter (plan 1292) --------------------------------------

test('ensureStageFrontmatter: injects a `---` block carrying `stage: stub` when the body has no frontmatter', () => {
  const out = ensureStageFrontmatter('# Plain plan\n\nbody\n');
  assert.match(out, /^---\nstage: stub\n---\n\n# Plain plan\n\nbody\n$/);
  assert.equal(readFrontmatterKey(out, 'stage'), 'stub');
});

test('ensureStageFrontmatter: merges `stage: stub` into an existing frontmatter block WITHOUT dropping other keys', () => {
  const body = "---\nsummary: 'a body summary'\nunblock: manual\n---\n\n# T\n\nbody\n";
  const out = ensureStageFrontmatter(body);
  // Pre-existing keys survive.
  assert.equal(readFrontmatterSummary(out), 'a body summary');
  assert.equal(readFrontmatterKey(out, 'unblock'), 'manual');
  // stage: stub was merged in.
  assert.equal(readFrontmatterKey(out, 'stage'), 'stub');
  // Still exactly one leading frontmatter block.
  assert.equal((out.match(/^---$/gm) || []).length, 2);
});

test('ensureStageFrontmatter: an existing `stage:` value is NEVER overwritten', () => {
  const body = '---\nstage: specced\n---\n\n# T\n\nbody\n';
  assert.equal(ensureStageFrontmatter(body), body, 'unchanged — the existing stamp wins');
  assert.equal(readFrontmatterKey(ensureStageFrontmatter(body), 'stage'), 'specced');
});

test('ensureStageFrontmatter + ensureSummaryFrontmatter compose into a SINGLE frontmatter block (buildClaimOps call order)', () => {
  // buildClaimOps calls ensureStageFrontmatter(ensureSummaryFrontmatter(body, blurb)) — when
  // the body starts with NO frontmatter at all, both keys must land in the SAME block, not
  // two separate `---` blocks.
  const out = ensureStageFrontmatter(ensureSummaryFrontmatter('# Plain plan\n\nbody\n', 'a blurb'));
  assert.equal((out.match(/^---$/gm) || []).length, 2, 'exactly one frontmatter block');
  assert.equal(readFrontmatterSummary(out), 'a blurb');
  assert.equal(readFrontmatterKey(out, 'stage'), 'stub');
});

test('buildClaimOps: a FABLE- category backfills execModel: fable even on a frontmatter-less body (plan 1561)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-fable-category-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'));
    const ops = buildClaimOps(dir, {
      category: 'FABLE-DQ',
      slug: 'x',
      body: bodyFile,
      blurb: 'a blurb',
    });
    assert.equal(readFrontmatterKey(ops.planBody, 'execModel'), 'fable');
    assert.equal(
      readFrontmatterKey(ops.planBody, 'stage'),
      'stub',
      'other ensure* stamps still ran',
    );
    assert.equal(
      (ops.planBody.match(/^---$/gm) || []).length,
      2,
      'still a single frontmatter block',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 3341: the `sol` twin of the FABLE- backfill test above — ensureExecModelForCategory
// is now table-driven, so a `SOL-` category backfills `execModel: sol` exactly the way a
// `FABLE-` one has always backfilled `execModel: fable`. This is the fix for the two-way
// drift the display-sites worker found: a `--category SOL-Pipe` mint used to get the
// `-SOL-` filename segment with NO execModel backfill, which the drift lint (extended to
// `sol` in this same plan) would then hard-block at push time.
test('buildClaimOps: a SOL- category backfills execModel: sol even on a frontmatter-less body (plan 3341)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-sol-category-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'));
    const ops = buildClaimOps(dir, {
      category: 'SOL-DQ',
      slug: 'x',
      body: bodyFile,
      blurb: 'a blurb',
    });
    assert.equal(readFrontmatterKey(ops.planBody, 'execModel'), 'sol');
    assert.equal(
      readFrontmatterKey(ops.planBody, 'stage'),
      'stub',
      'other ensure* stamps still ran',
    );
    assert.equal(
      (ops.planBody.match(/^---$/gm) || []).length,
      2,
      'still a single frontmatter block',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaimOps: FABLE- category wins over the exempt-mechanical default backfill', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-fable-exempt-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(
      bodyFile,
      sw('---\nspecReview: exempt-mechanical\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n'),
    );
    const ops = buildClaimOps(dir, {
      category: 'FABLE-DQ',
      slug: 'x',
      body: bodyFile,
      blurb: 'a blurb',
      mintFolder: 'ready',
    });
    assert.equal(readFrontmatterKey(ops.planBody, 'execModel'), 'fable');
    assert.doesNotMatch(ops.planBody, /^execModel: sol$/m);
    assert.doesNotMatch(ops.planBody, /^execModel: sonnet$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaimOps: exempt-mechanical preserves an explicit execModel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-explicit-exempt-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(
      bodyFile,
      sw(
        '---\nspecReview: exempt-mechanical\nexecModel: sonnet\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n',
      ),
    );
    const ops = buildClaimOps(dir, {
      category: 'Other',
      slug: 'x',
      body: bodyFile,
      blurb: 'a blurb',
      mintFolder: 'ready',
    });
    assert.equal(readFrontmatterKey(ops.planBody, 'execModel'), 'sonnet');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 3341: buildClaimOps refuses a mint whose --body already carries an execModel value
// this repo doesn't recognize — the same hole edit-plan.mjs's --body/--find-replace paths
// had before this plan. ensureExecModelForCategory's own backfill can never be the source
// of an invalid value (it only ever writes out of its own table), so this can only be an
// author-supplied typo in the authored --body file.
test('buildClaimOps: refuses to mint a --body carrying an unrecognized execModel (plan 3341)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-bad-execmodel-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(
      bodyFile,
      sw("---\nsummary: 'x'\nexecModel: opus\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n"),
    );
    // VALID_EXEC_MODELS (stamp-exec-model.mjs) is now DERIVED from the lane table rather than
    // hand-listed, so its join order is "sonnet / fable / sol", not the old hand-written
    // "fable / sonnet / sol" — key ordering isn't a fact worth pinning (edit-plan.test.mjs's
    // invalidExecModelMessage test already treats it the same way), so this asserts the prefix
    // and that all three lane names appear, regardless of order.
    assert.throws(
      () => buildClaimOps(dir, { category: 'Other', slug: 'x', body: bodyFile }),
      (e) =>
        /refusing to mint with execModel: "opus" — must be one of/.test(e.message) &&
        /\bfable\b/.test(e.message) &&
        /\bsonnet\b/.test(e.message) &&
        /\bsol\b/.test(e.message),
      'must name execModel "opus" and list all three valid lanes, in any order',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── plan 3999: `priority: high` needs a named priorityBy authority ─────────────────────────
//
// review fix round 1 (key 8116d5): the priority-stamp gate moved OUT of buildClaimOps (which has
// no knowledge of origin state) and into doClaim, run AFTER preflightSlugGuard's idempotent-
// re-claim short-circuit — mirroring the evidence-floor gate's own R5 relocation further below in
// this file. The four REFUSAL tests below now drive the real CLI (`claimVia`, defined further down
// this file — function declarations hoist) instead of calling buildClaimOps directly, so they
// exercise the ACTUAL gate location instead of a code path that no longer performs the check. The
// two CLEAN-MINT tests right after them are unaffected — they only assert on `ops.planBody`, which
// buildClaimOps still computes identically — so they stay buildClaimOps-direct.

test('claim CLI: refuses to mint a --body carrying priority: high with no priorityBy (plan 3999)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      sw("---\nsummary: 'x'\npriority: high\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n"),
    );
    const rest = ['--category', 'Other', '--slug', 'unbacked-high-x', '--body', bodyFile];
    assert.throws(
      () => claimVia(r.seed, [], rest),
      (e) => {
        const msg = `${e.stderr || ''}${e.message || ''}`;
        return (
          /refusing to mint with priority: high and no priorityBy:/.test(msg) &&
          /operator <YYYY-MM-DD>/.test(msg) &&
          /directive <name>/.test(msg) &&
          /2141-critical-path/.test(msg)
        );
      },
    );
  } finally {
    r.cleanup();
  }
});

test('buildClaimOps: a --body with priority: high and priorityBy: operator <date> mints cleanly (plan 3999)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-backed-high-operator-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(
      bodyFile,
      "---\nsummary: 'x'\npriority: high\npriorityBy: operator 2026-09-13\n---\n\n" +
        sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'),
    );
    const ops = buildClaimOps(dir, { category: 'Other', slug: 'x', body: bodyFile });
    assert.equal(readFrontmatterKey(ops.planBody, 'priority'), 'high');
    assert.equal(readFrontmatterKey(ops.planBody, 'priorityBy'), 'operator 2026-09-13');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaimOps: a --body with priority: high and priorityBy: directive 2141-critical-path mints cleanly (plan 3999)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-backed-high-directive-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(
      bodyFile,
      "---\nsummary: 'x'\npriority: high\npriorityBy: directive 2141-critical-path\n---\n\n" +
        sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'),
    );
    const ops = buildClaimOps(dir, { category: 'Other', slug: 'x', body: bodyFile });
    assert.equal(readFrontmatterKey(ops.planBody, 'priority'), 'high');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claim CLI: refuses to mint a --body carrying a priorityBy stranded on a non-high plan (plan 3999)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      "---\nsummary: 'x'\npriority: medium\npriorityBy: operator 2026-09-13\n---\n\n" +
        sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'),
    );
    const rest = ['--category', 'Other', '--slug', 'stale-priorityby-x', '--body', bodyFile];
    assert.throws(
      () => claimVia(r.seed, [], rest),
      (e) =>
        /refusing to mint with a `priorityBy:` stamp on a plan whose priority is not high/.test(
          `${e.stderr || ''}${e.message || ''}`,
        ),
    );
  } finally {
    r.cleanup();
  }
});

test('claim CLI: refuses to mint a --body carrying an unparseable priorityBy value (plan 3999)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      sw(
        "---\nsummary: 'x'\npriority: high\npriorityBy: vibes\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n",
      ),
    );
    const rest = ['--category', 'Other', '--slug', 'bad-priorityby-x', '--body', bodyFile];
    assert.throws(
      () => claimVia(r.seed, [], rest),
      (e) =>
        /refusing to mint with `priorityBy: vibes` — does not parse/.test(
          `${e.stderr || ''}${e.message || ''}`,
        ),
    );
  } finally {
    r.cleanup();
  }
});

test('claim CLI: refuses to mint a --body carrying priorityBy: operator <impossible date> (plan 3999)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      "---\nsummary: 'x'\npriority: high\npriorityBy: operator 2026-13-45\n---\n\n" +
        sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'),
    );
    const rest = ['--category', 'Other', '--slug', 'bad-date-priorityby-x', '--body', bodyFile];
    assert.throws(
      () => claimVia(r.seed, [], rest),
      (e) =>
        /refusing to mint with `priorityBy: operator 2026-13-45` — does not parse/.test(
          `${e.stderr || ''}${e.message || ''}`,
        ),
    );
  } finally {
    r.cleanup();
  }
});

test('claim CLI: refuses to mint a --body carrying priorityBy: operator <a FUTURE date> (plan 3999 review fix round 1, keys dbf9e7/2a0c54)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      "---\nsummary: 'x'\npriority: high\npriorityBy: operator 2099-01-01\n---\n\n" +
        sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'),
    );
    const rest = ['--category', 'Other', '--slug', 'future-date-priorityby-x', '--body', bodyFile];
    assert.throws(
      () => claimVia(r.seed, [], rest),
      (e) =>
        /refusing to mint with `priorityBy: operator 2099-01-01` — does not parse/.test(
          `${e.stderr || ''}${e.message || ''}`,
        ),
      'an operator sitting cannot have happened on a date that has not occurred yet',
    );
  } finally {
    r.cleanup();
  }
});

// CLI-level (acceptance criterion, plan 3999): exits non-zero, prints the fix, and — because
// the priority gate in doClaim runs BEFORE allocatePlanId is ever called — reserves NO id:
// origin's max stays 229, so the very next mint still claims 230.
test('claim CLI: priority: high with no priorityBy exits non-zero, prints the fix, and reserves NO id (plan 3999)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      sw('---\npriority: high\n---\n\n> 🟩 SEED-WRITE: NO\n\n# Unbacked high\n\nbody\n'),
    );
    const res = spawnSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'unbacked-high',
        '--body',
        bodyFile,
        '--blurb',
        'a blurb',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.notEqual(res.status, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /refusing to mint with priority: high/);

    // No id reserved: origin's max plan id is still 229, so the next claim still gets 230.
    const bodyFile2 = join(r.seed, 'body2.md');
    writeFileSync(bodyFile2, sw('> 🟩 SEED-WRITE: NO\n\n# After refusal\n\nbody\n'));
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'after-refusal',
        '--body',
        bodyFile2,
        '--blurb',
        'a blurb',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    ).trim();
    assert.equal(out, '230', 'the refused claim reserved no id — 230 is still free');
  } finally {
    r.cleanup();
  }
});

// review fix round 1 (key 8116d5): the regression pin for the gate's NEW seam. Before this fix
// the priority check ran inside buildClaimOps — BEFORE preflightSlugGuard's idempotent
// short-circuit — so a re-claim of an EXISTING plan already carrying a bare `priority: high` (the
// grandfathered-corpus shape, predating this plan's `priorityBy:` requirement — e.g. one of the
// ten plans BARE_HIGH_GRANDFATHERED_2026_09_13 names) would have been wrongly refused instead of
// returning the existing id, exactly like the evidence-floor gate's own R5 bug.
test('claim CLI: a re-claim of an ALREADY-FILED bare-`priority: high` plan is a clean idempotent no-op, not a refusal (plan 3999 review fix round 1, key 8116d5)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'bare-high-reclaim.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'));
    const rest = [
      '--category',
      'Coord',
      '--slug',
      'bare-high-reclaim',
      '--body',
      bodyFile,
      '--blurb',
      'b',
    ];
    // First mint normally — the body carries no priority stamp at all, so the gate never fires.
    const id = claimVia(r.seed, [], rest).trim();
    // Simulate the pre-fix, already-on-origin shape the grandfathered corpus is in: the SETTLED
    // body (the exact bytes next-plan-id itself just wrote) with a bare `priority: high` hand-
    // added directly on origin, bypassing the CLI entirely — exactly like the ten corpus plans
    // this feature grandfathers, all of which predate the `priorityBy:` requirement.
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const relPath = `docs/superpowers/plans/pending-approval/${id}-Coord-bare-high-reclaim.md`;
    const settled = execFileSync('git', ['-C', r.seed, 'show', `origin/master:${relPath}`], {
      encoding: 'utf8',
    });
    const withBareHigh = upsertFrontmatterKey(settled, 'priority', 'high');
    landFileContent(r.remote, relPath, withBareHigh);

    // A local re-claim carrying the IDENTICAL settled-plus-stamp body must see the SAME content
    // already on origin and return the SAME id — never re-enter the priority gate for a plan
    // that already exists.
    writeFileSync(bodyFile, withBareHigh);
    assert.equal(
      claimVia(r.seed, [], rest).trim(),
      id,
      'a re-claim of an existing bare priority: high plan must return the SAME id, not throw',
    );
  } finally {
    r.cleanup();
  }
});

test('buildClaimOps: a recognized execModel (sol) in the --body mints cleanly (plan 3341)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-sol-body-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(
      bodyFile,
      sw("---\nsummary: 'x'\nexecModel: sol\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n"),
    );
    const ops = buildClaimOps(dir, { category: 'Other', slug: 'x', body: bodyFile });
    assert.equal(readFrontmatterKey(ops.planBody, 'execModel'), 'sol');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 3341: onPick's filename-generation check was hardcoded to `=== 'fable'` only
// (found while wiring the category-allowlist fix above, confirmed via a direct probe
// against the pre-fix code) — a body carrying `execModel: sol` under a PLAIN category
// (no SOL- prefix baked into the category text itself) minted a filename with NO marker
// at all, a mismatch the pre-push drift lint would then hard-block on the very next
// unrelated push. This exercises onPick directly (not just planBody's frontmatter, which
// the test above already covers) so a regression back to the fable-only check fails here.
test('buildClaimOps: onPick mints the SOL- filename segment for a sol body under a plain category (plan 3341)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-sol-onpick-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(
      bodyFile,
      sw("---\nsummary: 'x'\nexecModel: sol\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n"),
    );
    const ops = buildClaimOps(dir, { category: 'Other', slug: 'sol-plain-cat', body: bodyFile });
    ops.onPick('230');
    assert.equal(ops.mintedFilename(), '230-SOL-Other-sol-plain-cat.md');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 3341 review (key 0dff51): onPick's EXEC_MODELS_WITH_SEGMENT used to be its own
// hand-typed `['fable', 'sol']` literal — a SEPARATE list from LANE_SEGMENTS
// (plan-lane-segments.mjs) that exec-model-stamp.mjs's marker/segment tables are already
// derived from. That kind of list going stale is a real failure shape: a future
// segment-bearing lane added to LANE_SEGMENTS would mint here with NO marker at all,
// which the pre-push drift lint then hard-blocks on the very next unrelated push. Fixed
// by deriving EXEC_MODELS_WITH_SEGMENT from LANE_SEGMENTS itself. This test iterates the
// REAL table rather than naming 'fable'/'sol' by hand, so it exercises whatever lanes
// LANE_SEGMENTS carries today — a regression back to a hardcoded list fails here the
// moment it drops a lane the table still has, and a FOURTH segment-bearing lane added to
// LANE_SEGMENTS is automatically exercised by this same test with no edit required.
test('buildClaimOps: onPick marks EVERY LANE_SEGMENTS lane under a plain category, not a hardcoded pair (plan 3341 review 0dff51)', () => {
  assert.ok(LANE_SEGMENTS.length >= 2, 'sanity: LANE_SEGMENTS should still carry fable + sol');
  for (const { lane, marker } of LANE_SEGMENTS) {
    const dir = mkdtempSync(join(tmpdir(), `nextid-lanecheck-${lane}-`));
    try {
      const bodyFile = join(dir, 'body.md');
      writeFileSync(
        bodyFile,
        `---\nsummary: 'x'\nexecModel: ${lane}\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n`,
      );
      const ops = buildClaimOps(dir, {
        category: 'Other',
        slug: `${lane}-plain-cat`,
        body: bodyFile,
      });
      ops.onPick('231');
      assert.equal(
        ops.mintedFilename(),
        `231-${marker}Other-${lane}-plain-cat.md`,
        `onPick should mint the ${marker} segment for execModel: ${lane} under a plain category`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ── plan 2943: the OPTIONAL --evidence flag on claim ──────────────────────────

test('buildClaimOps: --evidence writes the evidence-floor class into the fresh mint frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-evidence-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'));
    const ops = buildClaimOps(dir, {
      category: 'Other',
      slug: 'x',
      body: bodyFile,
      blurb: 'a blurb',
      evidence: 'observed-wave',
    });
    assert.equal(readFrontmatterKey(ops.planBody, 'evidence'), 'observed-wave');
    assert.equal(
      (ops.planBody.match(/^---$/gm) || []).length,
      2,
      'still a single frontmatter block',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaimOps: an OMITTED --evidence leaves the key absent (forward-only, grandfathered pool)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-evidence-absent-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'));
    const ops = buildClaimOps(dir, { category: 'Other', slug: 'x', body: bodyFile, blurb: 'b' });
    assert.equal(readFrontmatterKey(ops.planBody, 'evidence'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaimOps: --evidence NEVER clobbers an author-supplied evidence: already in the body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-evidence-keep-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(
      bodyFile,
      sw('---\nevidence: operator\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'),
    );
    const ops = buildClaimOps(dir, {
      category: 'Other',
      slug: 'x',
      body: bodyFile,
      blurb: 'b',
      evidence: 'latent',
    });
    assert.equal(readFrontmatterKey(ops.planBody, 'evidence'), 'operator');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaimOps: an invalid --evidence value is rejected, naming the valid vocabulary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-evidence-bad-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'));
    assert.throws(
      () =>
        buildClaimOps(dir, {
          category: 'Other',
          slug: 'x',
          body: bodyFile,
          blurb: 'b',
          evidence: 'vibes',
        }),
      /invalid --evidence value.*One of: observed-wave, observed-live, observed-measured, operator, latent/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claim CLI persists --evidence as evidence: frontmatter in the written plan body (plan 2943)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# Evidence plan\n\nbody\n'));
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'evidence-flag',
        '--body',
        bodyFile,
        '--blurb',
        'a blurb',
        '--evidence',
        'operator',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    ).trim();
    assert.equal(out, '230', 'CLI prints the claimed id');

    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const planFile = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'show',
        'origin/master:docs/superpowers/plans/pending-approval/230-Other-evidence-flag.md',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(readFrontmatterKey(planFile, 'evidence'), 'operator');
  } finally {
    r.cleanup();
  }
});

test('claim CLI rejects an invalid --evidence value before writing any artefact', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# Evidence plan\n\nbody\n'));
    const res = spawnSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'evidence-bad',
        '--body',
        bodyFile,
        '--blurb',
        'a blurb',
        '--evidence',
        'vibes',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.notEqual(res.status, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /invalid --evidence value/);
  } finally {
    r.cleanup();
  }
});

test('claim CLI persists --blurb as summary: frontmatter in the written plan body (plan 959)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# Summary plan\n\nbody\n'));
    // A blurb with the hazard characters that routinely appear in real blurbs.
    const blurb = "**[Infra]** persist X: don't drop it → `ready/z.md`";
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'summary',
        '--body',
        bodyFile,
        '--blurb',
        blurb,
      ],
      { cwd: r.seed, encoding: 'utf8' },
    ).trim();
    assert.equal(out, '230', 'CLI prints the claimed id');

    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const planFile = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'show',
        'origin/master:docs/superpowers/plans/pending-approval/230-Other-summary.md',
      ],
      { encoding: 'utf8' },
    );
    // The written plan body carries a `summary:` frontmatter equal to the blurb,
    // and build-index reads it back verbatim — so no later regen degrades to H1.
    assert.equal(
      readFrontmatterSummary(planFile),
      blurb,
      'the minted plan body carries the blurb as summary: frontmatter',
    );
  } finally {
    r.cleanup();
  }
});

// --- plan 990: the INDEX bullet is derived from the body summary (no drift) --

// ── review fix round (2943+2944, F5): `claim --ready` used to mint STRAIGHT into ready/,
// ── bypassing move-plan's evidence-floor gate entirely (that gate only runs on a move-plan
// ── invocation) — 2943's acceptance ("a Pipe/DQ/App/UI plan stamped evidence: latent cannot
// ── reach ready/") had a hole at this second ingress. `claim` now reuses the SAME shared
// ── assertEvidenceFloorOk (build-index-lib.mjs) against the same placeholder-basename shape the
// ── mint already builds.
//
// ── review fix round R2 (R5): the gate moved OUT of buildClaimOps (which has no knowledge of
// ── origin state) and into doClaim, run AFTER preflightSlugGuard's idempotent-re-claim
// ── short-circuit — mirroring the existing --ready cost-banner gate's own placement (see
// ── "claim --ready refuses a bannerless body" above). The tests below now drive the real CLI
// ── (like that cost-banner test) rather than calling buildClaimOps directly, so they exercise
// ── the ACTUAL gate location instead of a code path that no longer performs the check.

function claimVia(seed, extraArgs, rest) {
  return execFileSync(process.execPath, [CLI, 'claim', ...extraArgs, ...rest], {
    cwd: seed,
    encoding: 'utf8',
  });
}

test('claim --ready F5/R5: --evidence latent + a gated category (DQ) REFUSES a FRESH mint outright', () => {
  const r = makeCheckout();
  try {
    writeVetappEvidenceGateConfig(r.seed);
    const bodyFile = join(r.seed, 'latent-dq.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'));
    const rest = [
      '--category',
      'DQ',
      '--slug',
      'latent-dq',
      '--body',
      bodyFile,
      '--blurb',
      'b',
      '--evidence',
      'latent',
    ];
    assert.throws(
      () => claimVia(r.seed, ['--ready'], rest),
      (e) =>
        /cannot promote to ready\/.*evidence: latent.*product family/s.test(
          `${e.stderr || ''}${e.message || ''}`,
        ),
      'a gated-category --ready mint stamped evidence: latent must be refused',
    );
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ],
      { encoding: 'utf8' },
    );
    assert.doesNotMatch(
      tree,
      /ready\/\d+-DQ-latent-dq\.md/,
      'a refused mint must not land on origin',
    );
  } finally {
    r.cleanup();
  }
});

// Review fix round (4071 T2, one config snapshot per claim): buildClaimOps and doClaim used
// to each independently call loadCoordConfig(mainDir) — a concurrent coord.config.json edit
// between the two reads could let category validation (buildClaimOps) and the evidence-floor
// gate (doClaim) judge the SAME claim against two DIFFERENT snapshots of policy. doClaim now
// reuses buildClaimOps's own resolved `ops.planCategories` instead of loading a second time.
// This drives doClaim DIRECTLY (not via the CLI subprocess) specifically so the in-process
// `_loadConfig` call counter — a thin seam over loadCoordConfig added for this test, next-
// plan-id.mjs has no other DI/mocking seam of its own — can observe both callers' behaviour in
// one process. Uses a gated category (DQ) + evidence: latent so the evidence-floor gate
// ACTUALLY runs (proving reuse, not just that the counter is trivially 1 because the gate
// never fired) and asserts the refusal AND the read count together.
test("claim: one config snapshot per claim — doClaim reuses buildClaimOps's config load instead of reading coord.config.json a second time (plan 4071 review fix)", async () => {
  const r = makeCheckout();
  try {
    writeVetappEvidenceGateConfig(r.seed);
    const bodyFile = join(r.seed, 'latent-dq-direct.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'));
    _resetLoadConfigCallCount();
    await assert.rejects(
      () =>
        doClaim(r.seed, {
          category: 'DQ',
          slug: 'latent-dq-direct',
          body: bodyFile,
          blurb: 'b',
          evidence: 'latent',
          mintFolder: READY_FOLDER,
        }),
      /cannot promote to ready\/.*evidence: latent.*product family/s,
      'the evidence-floor gate inside doClaim must still refuse, proving it saw the SAME ' +
        'evidenceGated list buildClaimOps validated --category against',
    );
    assert.equal(
      _getLoadConfigCallCount(),
      1,
      "exactly ONE loadCoordConfig(mainDir) call for this whole claim attempt — buildClaimOps' " +
        'own load, reused by doClaim, never a second independent read',
    );
  } finally {
    r.cleanup();
  }
});

// Review fix round 2 (4071, finding 65b196): main() must resolve coord.config.json's
// mutationBanner.flag BEFORE parseFlags can run (to build the accepted --value flag list), i.e.
// before flags — and therefore buildClaimOps/doClaim — even exist. That read used to be a bare
// loadCoordConfig(mainDir) call sitting on top of buildClaimOps' own load: TWO reads for one CLI
// invocation, the exact cross-read hazard the test above closed one call frame further in. The
// fix threads main()'s own already-resolved snapshot down through doClaim into buildClaimOps via
// the new `config` parameter on both. This test stands in for main(): it resolves a config
// snapshot the way main() now does (a single external load, never touching the `_loadConfig`
// counting seam itself, exactly like main()'s ONE call to it) and hands it to doClaim, then
// asserts doClaim/buildClaimOps add ZERO further coord.config.json reads of their own — proving
// the whole CLI path (main()'s one load + doClaim's reuse) is a single read end to end, not two.
test('claim: doClaim/buildClaimOps add no further coord.config.json reads when handed an external config snapshot, the way main() now supplies one (plan 4071 review round 2)', async () => {
  const r = makeCheckout();
  try {
    writeVetappCategoryConfig(r.seed);
    const bodyFile = join(r.seed, 'external-config-claim.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'));
    const mainsOwnSnapshot = loadCoordConfig(r.seed);
    _resetLoadConfigCallCount();
    // Deliberately the DEFAULT (pending-approval/) mintFolder, not --ready: this test is only
    // about the config-read count, and pending-approval/ skips the ready-only spec-pass/evidence/
    // cost-forecast gates that would otherwise need their own fixture setup unrelated to the fix.
    const { id } = await doClaim(
      r.seed,
      {
        category: 'Infra',
        slug: 'external-config-claim',
        body: bodyFile,
        blurb: 'b',
      },
      mainsOwnSnapshot,
    );
    assert.ok(id, 'the claim must still succeed when driven off an externally-supplied config');
    assert.equal(
      _getLoadConfigCallCount(),
      0,
      'doClaim and buildClaimOps must add ZERO coord.config.json reads of their own when the ' +
        "caller (main(), in production) already handed down a snapshot — main()'s own single " +
        'load is the only read for the whole invocation',
    );
  } finally {
    r.cleanup();
  }
});

// plan 3341 fix: before this, `assertEvidenceFloorOk` was called against
// `000-SOL-DQ-<slug>.md` — build-index-lib.mjs's EVIDENCE_FLOOR_BASENAME_RX only
// special-cases an optional `FABLE-` before the category capture, so a `SOL-`-embedded
// category mis-parsed as category "SOL" (not gated) instead of "DQ" (gated), and the
// evidence-floor refusal silently never fired. next-plan-id.mjs now builds the check's
// basename from the marker-STRIPPED category instead, so this must refuse exactly like
// the plain-FABLE case above.
test('claim --ready F5/R5 (plan 3341 fix): --evidence latent + a SOL--embedded gated category (SOL-DQ) REFUSES a FRESH mint outright', () => {
  const r = makeCheckout();
  try {
    writeVetappEvidenceGateConfig(r.seed);
    const bodyFile = join(r.seed, 'latent-sol-dq.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'));
    const rest = [
      '--category',
      'SOL-DQ',
      '--slug',
      'latent-sol-dq',
      '--body',
      bodyFile,
      '--blurb',
      'b',
      '--evidence',
      'latent',
    ];
    assert.throws(
      () => claimVia(r.seed, ['--ready'], rest),
      (e) =>
        /cannot promote to ready\/.*evidence: latent.*product family/s.test(
          `${e.stderr || ''}${e.message || ''}`,
        ),
      'a SOL--embedded gated-category --ready mint stamped evidence: latent must be refused',
    );
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ],
      { encoding: 'utf8' },
    );
    assert.doesNotMatch(
      tree,
      /ready\/\d+-SOL-DQ-latent-sol-dq\.md/,
      'a refused mint must not land on origin',
    );
  } finally {
    r.cleanup();
  }
});

test('claim --ready F5: the SAME refusal fires when the authored --body ALREADY carries evidence: latent (no --evidence flag needed)', () => {
  const r = makeCheckout();
  try {
    writeVetappEvidenceGateConfig(r.seed);
    const bodyFile = join(r.seed, 'latent-body.md');
    writeFileSync(
      bodyFile,
      sw('---\nevidence: latent\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'),
    );
    const rest = [
      '--category',
      'Pipe',
      '--slug',
      'latent-body',
      '--body',
      bodyFile,
      '--blurb',
      'b',
    ];
    assert.throws(
      () => claimVia(r.seed, ['--ready'], rest),
      (e) =>
        /cannot promote to ready\/.*evidence: latent/s.test(`${e.stderr || ''}${e.message || ''}`),
    );
  } finally {
    r.cleanup();
  }
});

test('claim --ready F5: names BOTH return paths (fold to a line, or upgrade the class)', () => {
  const r = makeCheckout();
  try {
    writeVetappEvidenceGateConfig(r.seed);
    const bodyFile = join(r.seed, 'latent-app.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'));
    const rest = [
      '--category',
      'App',
      '--slug',
      'latent-app',
      '--body',
      bodyFile,
      '--blurb',
      'b',
      '--evidence',
      'latent',
    ];
    assert.throws(
      () => claimVia(r.seed, ['--ready'], rest),
      (e) => /fold it to a line.*upgrade the class/s.test(`${e.stderr || ''}${e.message || ''}`),
    );
  } finally {
    r.cleanup();
  }
});

test('claim F5: NOT gated — a DEFAULT (pending-approval/) mint with evidence: latent proceeds normally', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'latent-default.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'));
    // mintFolder omitted — defaults to pending-approval/, ungated (plan 2943's gate is a
    // ready/-promotion gate only).
    const id = claimVia(
      r.seed,
      [],
      [
        '--category',
        'DQ',
        '--slug',
        'latent-default',
        '--body',
        bodyFile,
        '--blurb',
        'b',
        '--evidence',
        'latent',
      ],
    ).trim();
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const planFile = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'show',
        `origin/master:docs/superpowers/plans/pending-approval/${id}-DQ-latent-default.md`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(readFrontmatterKey(planFile, 'evidence'), 'latent');
  } finally {
    r.cleanup();
  }
});

test('claim --ready F5: NOT gated — evidence: latent on an UNGATED category (Infra) proceeds normally', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'latent-infra.md');
    writeFileSync(
      bodyFile,
      sw(
        '---\nspecReview: exempt-mechanical\n---\n\n> 🟩 SEED-WRITE: NO\n> 💰 **Cost forecast:** $0\n\n# T\n\nbody\n',
      ),
    );
    const id = claimVia(
      r.seed,
      ['--ready'],
      [
        '--category',
        'Infra',
        '--slug',
        'latent-infra',
        '--body',
        bodyFile,
        '--blurb',
        'b',
        '--evidence',
        'latent',
      ],
    ).trim();
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const planFile = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'show',
        // Plan 3656: an exempt-mechanical ready mint stamps whatever lane the toggle
        // names, so the basename marker (if any) is derived, not pinned.
        `origin/master:docs/superpowers/plans/ready/${id}-${DEFAULT_SEG}Infra-latent-infra.md`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(readFrontmatterKey(planFile, 'evidence'), 'latent');
  } finally {
    r.cleanup();
  }
});

test('claim --ready F5: NOT gated — a NON-latent evidence class (observed-wave) on a gated category proceeds normally', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'nonlatent-ui.md');
    writeFileSync(
      bodyFile,
      sw(
        '---\nspecReview: exempt-mechanical\n---\n\n> 🟩 SEED-WRITE: NO\n> 💰 **Cost forecast:** $0\n\n# T\n\nbody\n',
      ),
    );
    const id = claimVia(
      r.seed,
      ['--ready'],
      [
        '--category',
        'UI',
        '--slug',
        'nonlatent-ui',
        '--body',
        bodyFile,
        '--blurb',
        'b',
        '--evidence',
        'observed-wave',
      ],
    ).trim();
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const planFile = execFileSync(
      'git',
      // Plan 3656: an exempt-mechanical ready mint stamps whatever lane the toggle
      // names, so the basename marker (if any) is derived, not pinned.
      [
        '-C',
        r.seed,
        'show',
        `origin/master:docs/superpowers/plans/ready/${id}-${DEFAULT_SEG}UI-nonlatent-ui.md`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(readFrontmatterKey(planFile, 'evidence'), 'observed-wave');
  } finally {
    r.cleanup();
  }
});

test('claim --ready R5: a re-claim of an ALREADY-FILED evidence: latent plan is a clean idempotent no-op, not a refusal', () => {
  const r = makeCheckout();
  try {
    writeVetappEvidenceGateConfig(r.seed);
    const bodyFile = join(r.seed, 'latent-reclaim.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# T\n\nbody\n'));
    const rest = [
      '--category',
      'DQ',
      '--slug',
      'latent-reclaim',
      '--body',
      bodyFile,
      '--blurb',
      'b',
      '--evidence',
      'latent',
    ];
    // First mint into the default pending-approval/ (ungated) so the plan genuinely exists on
    // origin with evidence: latent already stamped.
    const id = claimVia(r.seed, [], rest).trim();
    // Re-claim the IDENTICAL category+slug+body, this time asking for --ready. Before R5, the
    // evidence-floor check ran BEFORE preflightSlugGuard's idempotent short-circuit and refused
    // this outright even though nothing new is being minted (the plan never actually re-enters
    // ready/ on the idempotent path — see the bannerless-reclaim precedent above). After R5, the
    // idempotent short-circuit fires first and this must return the SAME id, not throw.
    assert.equal(
      claimVia(r.seed, ['--ready'], rest).trim(),
      id,
      'a --ready re-claim of an existing evidence: latent plan must return the SAME id, not throw',
    );
  } finally {
    r.cleanup();
  }
});

test('buildClaimOps: WARNs when --blurb differs from the body summary; --blurb is OPTIONAL when the body has one (plan 990)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-warn-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(
      bodyFile,
      sw("---\nsummary: 'the real body summary'\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nx\n"),
    );
    const errs = [];
    const orig = console.error;
    console.error = (m) => errs.push(String(m));
    try {
      // A --blurb that differs from the body summary must WARN, not throw.
      buildClaimOps(dir, {
        category: 'Other',
        slug: 'warn',
        body: bodyFile,
        blurb: 'a DIFFERENT blurb',
      });
    } finally {
      console.error = orig;
    }
    assert.ok(
      errs.some((e) => /--blurb differs from the body `summary:`/.test(e)),
      'a blurb-vs-summary mismatch WARN was emitted',
    );
    // No --blurb at all is fine when the body carries its own summary (no throw).
    assert.doesNotThrow(() =>
      buildClaimOps(dir, { category: 'Other', slug: 'nb', body: bodyFile }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaimOps: requires --blurb when the body has NO summary: frontmatter (plan 990 — 959 back-fill source)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-noblurb-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# No frontmatter here\n\nx\n'));
    assert.throws(
      () => buildClaimOps(dir, { category: 'Other', slug: 'x', body: bodyFile }),
      /claim needs --blurb/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- F-015 (plan 1313 coord audit): mint-time slug/category charset validation --------

test('buildClaimOps: F-015 — rejects a --slug with a space BEFORE it ever reaches a filename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-slugcharset-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw("---\nsummary: 'x'\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nx\n"));
    assert.throws(
      () => buildClaimOps(dir, { category: 'Other', slug: 'my plan', body: bodyFile }),
      /--slug "my plan" must match/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaimOps: F-015 — rejects a non-ASCII (Swedish öäå) --slug', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-slugcharset-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw("---\nsummary: 'x'\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nx\n"));
    assert.throws(
      () => buildClaimOps(dir, { category: 'Other', slug: 'öppettider-ändring', body: bodyFile }),
      /--slug "öppettider-ändring" must match/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaimOps: F-015 — rejects an apostrophe in --slug (the F-004 PowerShell-injection charset overlap)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-slugcharset-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw("---\nsummary: 'x'\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nx\n"));
    assert.throws(
      () => buildClaimOps(dir, { category: 'Other', slug: "record's-fix", body: bodyFile }),
      /--slug/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaimOps: F-015 — rejects a malformed --category the same way', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-catcharset-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw("---\nsummary: 'x'\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nx\n"));
    assert.throws(
      () => buildClaimOps(dir, { category: 'Bad Category', slug: 'fine-slug', body: bodyFile }),
      /--category "Bad Category" must match/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaimOps: F-015 — a normal ASCII category/slug still mints fine (no regression)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-slugcharset-ok-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw("---\nsummary: 'x'\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nx\n"));
    assert.doesNotThrow(() =>
      buildClaimOps(dir, { category: 'Other', slug: 'fine-slug_v2.1', body: bodyFile }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- plan 1945: mint-time PLAN_FILENAME_RX tag-shape gate ----------------------------
// assertSlugCharset (F-015 above) allows a lowercase-leading category (SLUG_CHARSET_RX
// only requires an ASCII letter/digit start) — but build-index.mjs's PLAN_FILENAME_RX
// requires an UPPERCASE-led category tag, and a mismatch silently vanishes the minted
// plan from docs/INDEX.md (the plan-1928 incident this gate closes).

test('buildClaimOps: plan 1945 — rejects a lowercase --category tag (the plan-1928 repro)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-tagshape-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw("---\nsummary: 'x'\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nx\n"));
    assert.throws(
      () =>
        buildClaimOps(dir, {
          category: 'tooling',
          slug: 'routine-ctl-no-llm-trigger-cli',
          body: bodyFile,
        }),
      /--category "tooling" would mint a plan invisible to docs\/INDEX\.md.*Try --category Tooling/s,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaimOps: plan 1945 — an uppercase-led allowlisted --category tag mints fine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-tagshape-ok-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw("---\nsummary: 'x'\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nx\n"));
    // `Infra` is both uppercase-led (passes PLAN_FILENAME_RX) AND in the plan-2329
    // allowlist — so it clears both mint gates. (Pre-2329 this used `Tooling`, which
    // the allowlist gate now rejects; the allowlist itself is covered below.)
    assert.doesNotThrow(() =>
      buildClaimOps(dir, { category: 'Infra', slug: 'routine-ctl', body: bodyFile }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// sonnet-review findings on plan 1945 itself: the capitalize-and-retry suggestion must
// only be offered when it would ACTUALLY pass PLAN_FILENAME_RX — a leading-digit or
// too-short category makes a bare `charAt(0).toUpperCase()` a no-op suggestion (the
// caller retries with the identical rejected value and loops forever).

test('buildClaimOps: plan 1945 — a leading-digit --category gets a real fix hint, not a no-op suggestion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-tagshape-digit-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw("---\nsummary: 'x'\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nx\n"));
    assert.throws(
      () => buildClaimOps(dir, { category: '123tooling', slug: 'x', body: bodyFile }),
      (err) => {
        assert.match(err.message, /--category "123tooling"/);
        assert.doesNotMatch(err.message, /Try --category 123tooling\./, 'no no-op suggestion');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaimOps: plan 1945 — a single-char --category (already uppercase) gets a real fix hint, not a no-op suggestion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-tagshape-short-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw("---\nsummary: 'x'\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nx\n"));
    // "T" passes assertSlugCharset (single ASCII letter) but PLAN_FILENAME_RX's category
    // group `[A-Z][A-Za-z0-9]+` needs 2+ chars — this is a real, pre-existing shape
    // requirement (build-index would ALSO never index a 000-T-x.md), not a casing bug.
    assert.throws(
      () => buildClaimOps(dir, { category: 'T', slug: 'x', body: bodyFile }),
      (err) => {
        assert.match(err.message, /--category "T"/);
        assert.doesNotMatch(err.message, /Try --category T\./, 'no no-op suggestion');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- plan 2329: category-allowlist mint gate --------------------------------------
// A NEW mint's --category must be one of the taxonomy tags in PLAN_CATEGORY_ALLOWLIST
// (case-sensitive), optionally carrying a leading FABLE- exec-model segment. An unknown
// category hard-fails at mint time with the valid set spelled out in the error.

test('buildClaimOps: plan 2329 — an unknown (but shape-valid) --category is rejected with the allowlist in the message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-catallow-'));
  try {
    // plan 4071 D1/D2: a config-less tmpdir degrades to an EMPTY allowlist (no gate) — drop
    // in the REAL vetapp taxonomy so this negative test still exercises the refusal.
    writeVetappCategoryConfig(dir);
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw("---\nsummary: 'x'\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nx\n"));
    // `Frobnicate` passes assertSlugCharset AND PLAN_FILENAME_RX (uppercase-led ASCII) —
    // so ONLY the plan-2329 allowlist gate can reject it.
    assert.throws(
      () => buildClaimOps(dir, { category: 'Frobnicate', slug: 'do-a-thing', body: bodyFile }),
      (err) => {
        assert.match(err.message, /--category "Frobnicate" is not an allowed plan category/);
        // the full valid set is spelled out verbatim
        for (const cat of VETAPP_PLAN_CATEGORIES.allowlist) {
          assert.match(err.message, new RegExp(`\\b${cat}\\b`), `message lists ${cat}`);
        }
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaimOps: plan 2329 — every allowlisted --category mints fine (plain, FABLE- prefixed, and SOL- prefixed)', () => {
  for (const category of VETAPP_PLAN_CATEGORIES.allowlist) {
    const dir = mkdtempSync(join(tmpdir(), 'nextid-catallow-ok-'));
    try {
      // Real taxonomy dropped in so this loop genuinely proves EVERY vetapp category mints,
      // not just that an empty (default) allowlist never refuses anything.
      writeVetappCategoryConfig(dir);
      const bodyFile = join(dir, 'body.md');
      writeFileSync(bodyFile, sw("---\nsummary: 'x'\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nx\n"));
      assert.doesNotThrow(
        () => buildClaimOps(dir, { category, slug: 'se-fine-slug', body: bodyFile }),
        `plain ${category} should mint`,
      );
      // a leading FABLE- exec-model segment is orthogonal routing — stripped before the check
      assert.doesNotThrow(
        () =>
          buildClaimOps(dir, {
            category: `FABLE-${category}`,
            slug: 'se-fine-slug',
            body: bodyFile,
          }),
        `FABLE-${category} should mint`,
      );
      // plan 3341: the SOL- twin — stripExecModelSegment (exec-model-stamp.mjs) covers both
      // markers, so this must mint exactly as cleanly as the FABLE- case above.
      assert.doesNotThrow(
        () =>
          buildClaimOps(dir, {
            category: `SOL-${category}`,
            slug: 'se-fine-slug',
            body: bodyFile,
          }),
        `SOL-${category} should mint`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('buildClaimOps: plan 2329 — a FABLE- segment on an UNKNOWN category is still rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-catallow-fable-'));
  try {
    writeVetappCategoryConfig(dir);
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw("---\nsummary: 'x'\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nx\n"));
    assert.throws(
      () => buildClaimOps(dir, { category: 'FABLE-Frobnicate', slug: 'x', body: bodyFile }),
      /--category "FABLE-Frobnicate" is not an allowed plan category/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 3341: the SOL- twin of the FABLE- case above — before this plan, next-plan-id.mjs
// called stripFableSegment only, so a `SOL-` prefix never even got the chance to be
// stripped and a SOL-<known category> mint was rejected as an unknown category outright
// (a different, more severe bug than this test — see the doesNotThrow test above for
// that one); this test pins the still-rejected shape once the strip is correct.
test('buildClaimOps: plan 2329 — a SOL- segment on an UNKNOWN category is still rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextid-catallow-sol-'));
  try {
    writeVetappCategoryConfig(dir);
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, sw("---\nsummary: 'x'\n---\n\n> 🟩 SEED-WRITE: NO\n\n# T\n\nx\n"));
    assert.throws(
      () => buildClaimOps(dir, { category: 'SOL-Frobnicate', slug: 'x', body: bodyFile }),
      /--category "SOL-Frobnicate" is not an allowed plan category/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Canonicalize a fresh checkout's INDEX so it carries build-index's generated sentinels
// (the baseline a real repo always has), commit + push it. Returns once indexIsCurrent.
function canonicalizeIndex(r) {
  const indexPath = join(r.seed, 'docs', 'INDEX.md');
  writeFileSync(indexPath, regenerateIndex(r.seed)); // inserts the sentinels (first pass)
  writeFileSync(indexPath, regenerateIndex(r.seed)); // settle (idempotent once present)
  r.g('add', '-A');
  r.g('commit', '-qm', 'canonicalize index');
  r.g('push', '-q', 'origin', 'master');
}

test('claim derives the INDEX bullet from the body summary; build-index --check stays clean (plan 990 regression — the 987/988 drift that stalled the 972 land)', () => {
  const r = makeCheckout();
  try {
    canonicalizeIndex(r);
    assert.equal(indexIsCurrent(r.seed), true, 'baseline INDEX is canonical');

    // The 987/988 shape: a RICH author summary in the body + a SHORTER, DIFFERENT --blurb.
    const bodyFile = join(r.seed, 'rich.md');
    const richSummary =
      'A deliberately rich author summary: longer than the blurb, with an arrow → and `backticks`.';
    writeFileSync(
      bodyFile,
      `---\nsummary: '${richSummary.replace(/'/g, "''")}'\n---\n\n` +
        sw(
          '> 🟩 SEED-WRITE: NO\n\n**Status:** 📋 STUB — opened 2026-01-01.\n\n# Rich plan\n\nbody\n',
        ),
    );
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'rich',
        '--body',
        bodyFile,
        '--blurb',
        'short blurb',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    ).trim();
    assert.equal(out, '230', 'CLI prints the claimed id');

    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const index = execFileSync('git', ['-C', r.seed, 'show', 'origin/master:docs/INDEX.md'], {
      encoding: 'utf8',
    });
    assert.match(index, /A deliberately rich author summary/, 'the bullet uses the BODY summary');
    assert.doesNotMatch(index, /short blurb/, 'the --blurb is NOT used for the bullet');

    // The exact gap that stalled the 972 land: build-index --check is clean right after the mint.
    assert.equal(
      indexIsCurrent(r.seed),
      true,
      'no blurb-vs-summary drift — build-index --check is clean immediately after the mint',
    );
  } finally {
    r.cleanup();
  }
});

test('claim back-fills the bullet from --blurb when the body has no summary; build-index --check stays clean (plan 990 — 959 path preserved)', () => {
  const r = makeCheckout();
  try {
    canonicalizeIndex(r);

    const bodyFile = join(r.seed, 'plain.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# Plain plan\n\nbody\n'));
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'plain',
        '--body',
        bodyFile,
        '--blurb',
        'the only summary source',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    ).trim();
    assert.equal(out, '230');

    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const index = execFileSync('git', ['-C', r.seed, 'show', 'origin/master:docs/INDEX.md'], {
      encoding: 'utf8',
    });
    assert.match(index, /the only summary source → `pending-approval\/230-Other-plain\.md`/);
    assert.equal(indexIsCurrent(r.seed), true, 'the 959 back-fill path is also drift-free');
  } finally {
    r.cleanup();
  }
});

// Enable the seed lane in a fresh checkout so readSeedMarker reads the body banner (the
// config-less makeCheckout has seedLane=false → marker is forced 🟩, which can't exercise 🟥).
function makeSeedLaneCheckout() {
  const r = makeCheckout();
  writeFileSync(
    join(r.seed, 'coord.config.json'),
    JSON.stringify({ seedLaneFile: 'backend/src/data/seed-clinics.json', handoffLayout: 'single' }), // project-word-ok: real retired monolith config literal, seedLaneFile
  );
  r.g('add', '-A');
  r.g('commit', '-qm', 'enable seed lane');
  r.g('push', '-q', 'origin', 'master');
  return r;
}

test('claim: a 🟥 SEED-WRITE body yields a 🟥 INDEX bullet (marker from the banner, NOT --seed-write); flag/banner disagreement WARNs; build-index --check clean (plan 990)', () => {
  const r = makeSeedLaneCheckout();
  try {
    canonicalizeIndex(r);
    assert.equal(indexIsCurrent(r.seed), true, 'baseline INDEX is canonical');

    const bodyFile = join(r.seed, 'seedy.md');
    writeFileSync(
      bodyFile,
      "---\nsummary: 'A seed-writing plan'\n---\n\n" +
        sw('> 🟥 **SEED-WRITE: YES** — touches the seed.\n\n') +
        '**Status:** 📋 STUB — opened 2026-01-01.\n\n# Seed plan\n\nbody\n',
    );
    // Pass --seed-write no ON PURPOSE: the flag must NOT override the 🟥 body banner, and the
    // disagreement must WARN (loud) instead of silently downgrading the marker to 🟩.
    const res = spawnSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'seedy',
        '--body',
        bodyFile,
        '--seed-write',
        'no',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), '230', 'stdout is the bare id (messages go to stderr)');
    assert.match(
      res.stderr,
      /--seed-write no disagrees with the body SEED-WRITE/,
      'the flag/banner disagreement is WARNed at mint time, not silent',
    );

    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const index = execFileSync('git', ['-C', r.seed, 'show', 'origin/master:docs/INDEX.md'], {
      encoding: 'utf8',
    });
    assert.match(
      index,
      /🟥 A seed-writing plan → `pending-approval\/230-Other-seedy\.md`/,
      'the bullet carries 🟥 from the body banner (the flag was ignored)',
    );
    assert.equal(indexIsCurrent(r.seed), true, 'no drift — build-index --check is clean');
  } finally {
    r.cleanup();
  }
});

// plan 3961 review fix (FIX 1): a repo that configures a DIFFERENT mutationBanner.flag (e.g.
// --data-write) used to make close-out.mjs's carry-forward mint THROW mid-land — its
// D.buildIndexLib.MUTATION_BANNER_FLAG constant passed the configured flag straight through to
// this CLI's parseFlags call, whose `value` list only ever declared 'seed-write'. The fix derives
// the CLI's accepted flags from the SAME config the constant reads, and accepts the configured
// flag IN ADDITION TO --seed-write (never instead of it), so a repo mid-migration between the two
// names has both accepted.
function makeMutationBannerFlagCheckout(flag) {
  const r = makeCheckout();
  writeFileSync(
    join(r.seed, 'coord.config.json'),
    JSON.stringify({
      seedLaneFile: 'backend/src/data/seed-clinics.json', // project-word-ok: real retired monolith config literal, seedLaneFile
      handoffLayout: 'single',
      mutationBanner: { flag },
    }),
  );
  r.g('add', '-A');
  r.g('commit', '-qm', 'configure a non-default mutationBanner.flag');
  r.g('push', '-q', 'origin', 'master');
  return r;
}

test('claim: a configured mutationBanner.flag (e.g. --data-write) is accepted by parseFlags — never "unknown flag" — and --seed-write still works too (plan 3961 review fix FIX 1)', () => {
  const r = makeMutationBannerFlagCheckout('--data-write');
  try {
    const bodyFile = join(r.seed, 'databody.md');
    writeFileSync(
      bodyFile,
      "---\nsummary: 'A configured-flag plan'\n---\n\n" +
        sw('> 🟥 **SEED-WRITE: YES** — touches the seed.\n\n') +
        '**Status:** 📋 STUB — opened 2026-01-01.\n\n# Plan\n\nbody\n',
    );
    // The CONFIGURED flag name, disagreeing with the body banner on purpose — must WARN under
    // its OWN name, not throw "unknown flag".
    const res1 = spawnSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'databody',
        '--body',
        bodyFile,
        '--data-write',
        'no',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(res1.status, 0, res1.stderr);
    assert.match(
      res1.stderr,
      /--data-write no disagrees with the body SEED-WRITE/,
      'the configured flag name is accepted and named in the WARN, not rejected as unknown',
    );

    // The DEFAULT `--seed-write` flag must ALSO still work on this same (non-default-configured)
    // repo — accepted in addition to the configured flag, never instead of it.
    const bodyFile2 = join(r.seed, 'databody2.md');
    writeFileSync(
      bodyFile2,
      "---\nsummary: 'A second configured-flag plan'\n---\n\n" +
        sw('> 🟩 **SEED-WRITE: NO** — no seed touch.\n\n') +
        '**Status:** 📋 STUB — opened 2026-01-01.\n\n# Plan\n\nbody\n',
    );
    const res2 = spawnSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'databody2',
        '--body',
        bodyFile2,
        '--seed-write',
        'yes',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(res2.status, 0, res2.stderr);
    assert.match(
      res2.stderr,
      /--seed-write yes disagrees with the body SEED-WRITE/,
      '--seed-write is still accepted (and still WARNs on disagreement) even though this repo configures a different flag',
    );
  } finally {
    r.cleanup();
  }
});

// Review round 3 (4071, key 11ac94): a project config whose mutationBanner.flag names one of
// this CLI's OWN fixed flags (e.g. `--ready`, a real BOOLEAN flag declared on the parseFlags()
// call below) used to reach that call with the configured name pushed into the VALUE list
// while it was ALSO declared boolean — parseFlags throws "declared as both value and boolean
// (ambiguous spec)" before any subcommand (peek/claim) can even dispatch, taking down the
// whole CLI for that repo. The fix rejects the collision loudly, up front, naming the
// offending flag and the config key — reusing makeMutationBannerFlagCheckout from the FIX 1
// test above, whose only difference from a normal checkout is the configured
// mutationBanner.flag.
test('claim: a mutationBanner.flag colliding with a built-in flag (e.g. --ready) is a loud config error, not a parseFlags crash (plan 4071 review round 3, key 11ac94)', () => {
  const r = makeMutationBannerFlagCheckout('--ready');
  try {
    const bodyFile = join(r.seed, 'readycollide.md');
    writeFileSync(
      bodyFile,
      "---\nsummary: 'A ready-collision plan'\n---\n\n" +
        sw('> 🟥 **SEED-WRITE: YES** — touches the seed.\n\n') +
        '**Status:** 📋 STUB — opened 2026-01-01.\n\n# Plan\n\nbody\n',
    );
    const res = spawnSync(
      process.execPath,
      [CLI, 'claim', '--category', 'Other', '--slug', 'readycollide', '--body', bodyFile],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(res.status, 2, res.stderr);
    assert.match(
      res.stderr,
      /mutationBanner\.flag \("--ready"\) collides with this CLI's built-in --ready flag/,
    );
    // The collision check runs before parseFlags dispatches a subcommand at all, so the SAME
    // config error surfaces even on the default (no-subcommand → 'peek') path.
    const resPeek = spawnSync(process.execPath, [CLI], { cwd: r.seed, encoding: 'utf8' });
    assert.equal(resPeek.status, 2, resPeek.stderr);
    assert.match(
      resPeek.stderr,
      /mutationBanner\.flag \("--ready"\) collides with this CLI's built-in --ready flag/,
    );
  } finally {
    r.cleanup();
  }
});

// --- plan 1022: pending-approval/ default + --ready opt-in + the mint banner ----------

test('mintBanner: pending-approval variant warns NOT auto-drainable and names the two next steps', () => {
  const b = mintBanner('512', 'pending-approval');
  assert.match(b, /pending-approval\//);
  assert.match(b, /NOT auto-drainable/);
  assert.match(b, /pickup-plan 512/);
  assert.match(b, /move-plan\.mjs 512 ready/);
  assert.match(b, /NEVER `git worktree add` by hand/);
});

// Print-site pinning (plan 1324): the pending-approval banner must embed the shared
// mint-lines.mjs template VERBATIM, so every print site stays in sync with the
// single-authority template instead of drifting into hand-copied duplicates.
test('mintBanner: pending-approval variant renders MINT_BANNER_LINE verbatim (template coupling)', () => {
  assert.ok(mintBanner('512', 'pending-approval').includes(MINT_BANNER_LINE('512')));
});

test('mintBanner: ready variant says it IS auto-drainable now (the --ready opt-in)', () => {
  const b = mintBanner('512', 'ready');
  assert.match(b, /minted into ready\//);
  assert.match(b, /IS auto-drainable/);
  assert.match(b, /--ready/);
  assert.match(b, /`git worktree add` by hand/);
});

// The default mint lands in pending-approval/ (covered by the CLI tests above); --ready is the
// explicit "hand it to the orchestrator" opt-in that lands in ready/. `--ready` is a bare
// boolean placed BEFORE the value flags here, proving it's order-independent (main() strips
// it from argv before parseArgs, which would otherwise swallow the following flag).
test('claim --ready mints into ready/ (orchestrator opt-in), order-independent', () => {
  const r = makeCheckout(); // origin max id = 229 → next 230
  try {
    const bodyFile = join(r.seed, 'body.md');
    // plan 1260: a --ready mint needs a parseable Cost forecast banner (it enters ready/).
    // plan 1292 bugfix: a --ready mint ALSO needs to have already cleared spec-pass — carry
    // a `specReview:` stamp in the frontmatter so this mechanics-focused test (order-
    // independence of the bare --ready flag) isn't itself caught by that gate (covered
    // separately below).
    writeFileSync(
      bodyFile,
      sw(
        '---\nspecReview: exempt-mechanical\n---\n\n> 🟩 SEED-WRITE: NO\n> 💰 **Cost forecast:** $0 — no LLM spend.\n\n# Release plan\n\nbody\n',
      ),
    );
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--ready',
        '--category',
        'Other',
        '--slug',
        'release-now',
        '--body',
        bodyFile,
        '--blurb',
        'release now',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(out.trim(), '230', 'CLI prints the claimed id');
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ],
      { encoding: 'utf8' },
    );
    // Plan 3656: an exempt-mechanical ready mint stamps whatever lane the toggle names,
    // so the basename marker (if any) is derived, not pinned.
    assert.match(
      tree,
      new RegExp(`ready/230-${DEFAULT_SEG}Other-release-now\\.md`),
      '--ready lands the plan in ready/',
    );
    assert.doesNotMatch(
      tree,
      new RegExp(`pending-approval/230-${DEFAULT_SEG}Other-release-now\\.md`),
      'NOT in pending-approval/',
    );
    const index = execFileSync('git', ['-C', r.seed, 'show', 'origin/master:docs/INDEX.md'], {
      encoding: 'utf8',
    });
    assert.match(
      index,
      new RegExp(`🟩 release now → \`ready/230-${DEFAULT_SEG}Other-release-now\\.md\``),
    );
  } finally {
    r.cleanup();
  }
});

// ── Plan 2973 fix round: `claim --ready` is a FOURTH ready/-entry point cloudExecUnstampedWarning
// ── (build-index-lib.mjs) needs wiring into — it mints DIRECTLY into ready/, so an unstamped
// ── plan minted here would otherwise land cloud-invisible with nothing said. WARN only: the
// ── mint must still succeed either way.

test('claim --ready: a mint with no cloudExec: key WARNs to stderr, and the mint STILL SUCCEEDS', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      sw(
        '---\nspecReview: exempt-mechanical\n---\n\n> 🟩 SEED-WRITE: NO\n> 💰 **Cost forecast:** $0 — no LLM spend.\n\n# Release plan\n\nbody\n',
      ),
    );
    const res = spawnSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--ready',
        '--category',
        'Other',
        '--slug',
        'no-cloudexec',
        '--body',
        bodyFile,
        '--blurb',
        'no cloudExec stamp',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout.trim(), /^\d+$/, 'stdout is still the bare id — the mint succeeded');
    const mintedId = res.stdout.trim();
    assert.match(
      res.stderr,
      /next-plan-id: WARN — .*has no cloudExec: frontmatter key/,
      'the missing stamp is warned, prefixed for this tool',
    );
    assert.match(res.stderr, /stamp-cloud-exec\.mjs/, 'names the remediation command');
    // FIX ROUND 2 (round-1 bug): the warn used to run BEFORE the id was allocated, so its
    // remediation command always named the placeholder id "000" — a plan that never exists.
    // Assert it now names the REAL minted id instead.
    assert.notEqual(mintedId, '000', 'sanity: the real minted id is never the placeholder "000"');
    assert.match(
      res.stderr,
      new RegExp(`stamp-cloud-exec\\.mjs ${mintedId} true `),
      'the remediation command names the REAL minted id, not the placeholder "000"',
    );
    assert.doesNotMatch(
      res.stderr,
      /stamp-cloud-exec\.mjs 000 /,
      'must never name the placeholder id "000" — that plan never exists',
    );
  } finally {
    r.cleanup();
  }
});

test('claim --ready: a body carrying cloudExec: true mints SILENTLY (no cloudExec WARN)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      sw(
        '---\nspecReview: exempt-mechanical\ncloudExec: true\n---\n\n> 🟩 SEED-WRITE: NO\n> 💰 **Cost forecast:** $0 — no LLM spend.\n\n# Release plan\n\nbody\n',
      ),
    );
    const res = spawnSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--ready',
        '--category',
        'Other',
        '--slug',
        'cloudexec-true',
        '--body',
        bodyFile,
        '--blurb',
        'cloudExec true',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /cloudExec/, 'a real cloudExec: true stamp draws no warning');
  } finally {
    r.cleanup();
  }
});

test('claim --ready: a body carrying cloudExec: false mints SILENTLY (no cloudExec WARN)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      sw(
        '---\nspecReview: exempt-mechanical\ncloudExec: false\n---\n\n> 🟩 SEED-WRITE: NO\n> 💰 **Cost forecast:** $0 — no LLM spend.\n\n# Release plan\n\nbody\n',
      ),
    );
    const res = spawnSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--ready',
        '--category',
        'Other',
        '--slug',
        'cloudexec-false',
        '--body',
        bodyFile,
        '--blurb',
        'cloudExec false',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(
      res.stderr,
      /cloudExec/,
      'a deliberate cloudExec: false stamp draws no warning',
    );
  } finally {
    r.cleanup();
  }
});

// Round 3 fix: the warn used to reconstruct the basename as `${id}-${category}-${slug}.md`,
// which drops the FABLE- segment onPick mints into the filename whenever the plan body's
// execModel is fable — so the warning named a file (`NNNN-Other-slug.md`) that never existed
// on disk while the real file was `NNNN-FABLE-Other-slug.md`. Assert the warning now names
// the REAL minted basename (read off the repo the mint just committed, not hard-coded).
test('claim --ready: a body carrying execModel: fable (no cloudExec: key) WARNs naming the basename WITH the FABLE- segment (plan 2973 round 3)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(
      bodyFile,
      sw(
        '---\nexecModel: fable\nspecReview: exempt-mechanical\n---\n\n> 🟩 SEED-WRITE: NO\n> 💰 **Cost forecast:** $0 — no LLM spend.\n\n# Release plan\n\nbody\n',
      ),
    );
    const res = spawnSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--ready',
        '--category',
        'Other',
        '--slug',
        'fable-no-cloudexec',
        '--body',
        bodyFile,
        '--blurb',
        'fable no cloudExec stamp',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(res.status, 0, res.stderr);
    const mintedId = res.stdout.trim();
    assert.match(mintedId, /^\d+$/, 'stdout is still the bare id — the mint succeeded');

    // Read the REAL minted filename off the repo the mint just committed — not hard-coded —
    // so this test can't pass by asserting the same wrong shape the bug would have produced.
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans/ready',
      ],
      { encoding: 'utf8' },
    );
    const lines = tree.split('\n').filter(Boolean);
    const realPath = lines.find(
      (p) => p.includes(`${mintedId}-`) && p.includes('fable-no-cloudexec'),
    );
    assert.ok(realPath, `expected a minted file for id ${mintedId} in:\n${tree}`);
    const realBasename = realPath.split('/').pop();
    assert.match(
      realBasename,
      new RegExp(`^${mintedId}-FABLE-Other-fable-no-cloudexec\\.md$`),
      'sanity: the real minted file on disk carries the FABLE- segment',
    );

    assert.match(
      res.stderr,
      /next-plan-id: WARN — .*has no cloudExec: frontmatter key/,
      'the missing stamp is warned',
    );
    assert.ok(
      res.stderr.includes(realBasename),
      `the warning must name the basename WITH the FABLE- segment (${realBasename}); got:\n${res.stderr}`,
    );
    assert.doesNotMatch(
      res.stderr,
      new RegExp(`${mintedId}-Other-fable-no-cloudexec\\.md(?!\\S)`),
      'must never name the un-segmented basename — that file was never created',
    );
    assert.match(
      res.stderr,
      new RegExp(`stamp-cloud-exec\\.mjs ${mintedId} true `),
      'the remediation command still names the bare numeric id, not id-FABLE-Other-slug',
    );
  } finally {
    r.cleanup();
  }
});

test('claim (default, pending-approval/) mint never runs the cloudExec WARN — --ready only', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'body.md');
    writeFileSync(bodyFile, '# Plain plan\n\nbody\n');
    const res = spawnSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'plain-default',
        '--body',
        bodyFile,
        '--blurb',
        'plain default mint',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(
      res.stderr,
      /cloudExec/,
      'the default pending-approval/ mint never checks the cloudExec stamp',
    );
  } finally {
    r.cleanup();
  }
});

// plan 1292 bugfix: `claim --ready` used to skip the stage/specReview spec-pass gate
// entirely (assertSpecReviewOk only runs on a move-plan PROMOTE, never a fresh mint), so
// a bare `--ready` mint landed an unreviewed `stage: stub` plan straight into ready/ where
// the autonomous drain could pick it up immediately. Bare --ready must now be refused;
// a body that already carries a `specReview:` stamp succeeds; the default pending-approval/ mint
// of the SAME bare body is unaffected (the gate only fires for a ready/ mint).
test('claim --ready refuses a bare mint with no stage/specReview stamp (plan 1292 spec-pass gate)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'bare.md');
    writeFileSync(
      bodyFile,
      sw(
        '> 🟩 SEED-WRITE: NO\n> 💰 **Cost forecast:** $0 — no LLM spend.\n\n# Bare plan\n\nbody\n',
      ),
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            CLI,
            'claim',
            '--ready',
            '--category',
            'Other',
            '--slug',
            'bare-ready',
            '--body',
            bodyFile,
            '--blurb',
            'bare ready',
          ],
          { cwd: r.seed, encoding: 'utf8' },
        ),
      (e) => {
        const out = `${e.stderr || ''}${e.message || ''}`;
        return (
          /refusing a --ready mint/.test(out) &&
          /stage: stub without a specReview stamp/.test(out) &&
          /Mint to the default \(pending-approval\/\) instead/.test(out)
        );
      },
      'a bare --ready mint (no specReview stamp) must be refused, naming both fixes',
    );
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ],
      { encoding: 'utf8' },
    );
    assert.doesNotMatch(tree, /bare-ready\.md/, 'nothing landed anywhere on a refused mint');
  } finally {
    r.cleanup();
  }
});

// plan 4202: the same shared gate (specReviewGateError, build-index-lib.mjs) now also
// refuses a real specReview sha stamped with specReviewBy: undeclared — a spec-pass of
// unknown provenance must not be minted straight into ready/ any more than a bare stub can.
test('claim --ready refuses a body carrying specReview + specReviewBy: undeclared (plan 4202)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'undeclared.md');
    writeFileSync(
      bodyFile,
      sw(
        '---\nstage: specced\nspecReview: 9f8e7d6\nspecReviewBy: undeclared\n---\n\n' +
          '> 🟩 SEED-WRITE: NO\n> 💰 **Cost forecast:** $0 — no LLM spend.\n\n# Undeclared plan\n\nbody\n',
      ),
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            CLI,
            'claim',
            '--ready',
            '--category',
            'Other',
            '--slug',
            'undeclared-ready',
            '--body',
            bodyFile,
            '--blurb',
            'undeclared ready',
          ],
          { cwd: r.seed, encoding: 'utf8' },
        ),
      (e) => {
        const out = `${e.stderr || ''}${e.message || ''}`;
        return (
          /refusing a --ready mint/.test(out) &&
          /specReviewBy: undeclared/.test(out) &&
          /Mint to the default \(pending-approval\/\) instead/.test(out)
        );
      },
      'a --ready mint with an undeclared-provenance specReview must be refused',
    );
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ],
      { encoding: 'utf8' },
    );
    assert.doesNotMatch(tree, /undeclared-ready\.md/, 'nothing landed anywhere on a refused mint');
  } finally {
    r.cleanup();
  }
});

test('claim --ready with a body carrying specReview: exempt-mechanical succeeds', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'exempt.md');
    writeFileSync(
      bodyFile,
      sw(
        '---\nspecReview: exempt-mechanical\n---\n\n> 🟩 SEED-WRITE: NO\n> 💰 **Cost forecast:** $0 — no LLM spend.\n\n# Exempt plan\n\nbody\n',
      ),
    );
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--ready',
        '--category',
        'Other',
        '--slug',
        'exempt-ready',
        '--body',
        bodyFile,
        '--blurb',
        'exempt ready',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(out.trim(), '230');
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ],
      { encoding: 'utf8' },
    );
    // Plan 3656: an exempt-mechanical ready mint stamps whatever lane the toggle names,
    // so the basename marker (if any) is derived, not pinned.
    assert.match(tree, new RegExp(`ready/230-${DEFAULT_SEG}Other-exempt-ready\\.md`));
    const body = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'show',
        `origin/master:docs/superpowers/plans/ready/230-${DEFAULT_SEG}Other-exempt-ready.md`,
      ],
      { encoding: 'utf8' },
    );
    assert.match(body, new RegExp(`^execModel: ${DEFAULT_LANE}$`, 'm'));
  } finally {
    r.cleanup();
  }
});

test('claim (default, pending-approval/) mint is unaffected by the --ready spec-pass gate, even with a bare stub body', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'bare-draft.md');
    writeFileSync(
      bodyFile,
      sw(
        '> 🟩 SEED-WRITE: NO\n> 💰 **Cost forecast:** $0 — no LLM spend.\n\n# Bare draft plan\n\nbody\n',
      ),
    );
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        'claim',
        '--category',
        'Other',
        '--slug',
        'bare-draft',
        '--body',
        bodyFile,
        '--blurb',
        'bare draft',
      ],
      { cwd: r.seed, encoding: 'utf8' },
    );
    assert.equal(out.trim(), '230');
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ],
      { encoding: 'utf8' },
    );
    assert.match(
      tree,
      /pending-approval\/230-Other-bare-draft\.md/,
      'default mint still lands in pending-approval/',
    );
  } finally {
    r.cleanup();
  }
});

// plan 1260: a --ready mint lands directly in ready/, where the drain reads it and
// lint-plan-cost-forecast gates repo-wide — so a bannerless --ready mint must be refused
// at mint time (with the shared help), not discovered as a push-blocker by the next pusher.
// A default (pending-approval/) mint of the SAME bannerless body is fine (the drain never reads it).
test('claim --ready refuses a bannerless body; the same body mints fine into pending-approval/ (plan 1260)', () => {
  const r = makeCheckout();
  try {
    const bodyFile = join(r.seed, 'nobanner.md');
    writeFileSync(bodyFile, sw('> 🟩 SEED-WRITE: NO\n\n# No-banner plan\n\nbody\n'));
    const claim = (extraArgs) =>
      execFileSync(
        process.execPath,
        [
          CLI,
          'claim',
          ...extraArgs,
          '--category',
          'Other',
          '--slug',
          'nobanner',
          '--body',
          bodyFile,
          '--blurb',
          'no banner',
        ],
        { cwd: r.seed, encoding: 'utf8' },
      );
    // --ready is refused, naming the missing banner + showing an example.
    assert.throws(
      () => claim(['--ready']),
      (e) => {
        const out = `${e.stderr || ''}${e.message || ''}`;
        return (
          /parseable 💰 Cost forecast banner/.test(out) &&
          /Cost forecast:\*\* Cash \$0 · Claude \$0/.test(out)
        );
      },
      'a bannerless --ready mint must be refused with the shared help',
    );
    // Nothing landed in ready/ on origin.
    execFileSync('git', ['-C', r.seed, 'fetch', '-q', 'origin', 'master']);
    const tree = execFileSync(
      'git',
      [
        '-C',
        r.seed,
        'ls-tree',
        '-r',
        '--name-only',
        'origin/master',
        '--',
        'docs/superpowers/plans',
      ],
      { encoding: 'utf8' },
    );
    assert.doesNotMatch(
      tree,
      /ready\/\d+-Other-nobanner\.md/,
      'bannerless plan must NOT reach ready/',
    );
    // The default (pending-approval/) mint of the same body succeeds — the drain never reads pending-approval/.
    assert.equal(
      claim([]).trim(),
      '230',
      'a default pending-approval/ mint of the bannerless body is fine',
    );
    // plan 1260 (review finding 2): a --ready RE-CLAIM of the now-existing bannerless plan must
    // be the idempotent no-op it always was (returns the existing id, WARNs --ready had no
    // effect) — NOT a hard banner throw. The gate runs AFTER doClaim's idempotent short-circuit,
    // so a re-claim that never actually enters ready/ is not gated.
    assert.equal(
      claim(['--ready']).trim(),
      '230',
      'a --ready re-claim of an existing bannerless plan is an idempotent no-op, not a throw',
    );
  } finally {
    r.cleanup();
  }
});

// ── plan 4237 T4: the plan-id floor ───────────────────────────────────────────────────────────
// 2026-09-26: a rollback commit deleted plans 4231/4232 (files AND INDEX bullets) and the next two
// mints re-issued both ids. The floor ref remembers the highest id ever reserved.

test('plan 4237 T4: parsePlanIdFloor reads floor=<N>, 0 for anything else', () => {
  assert.equal(parsePlanIdFloor('floor=4232\nnonce=abc'), 4232);
  assert.equal(parsePlanIdFloor(''), 0);
  assert.equal(parsePlanIdFloor(null), 0);
  assert.equal(parsePlanIdFloor('session=12'), 0);
  // review 2e8ef6: conflicting floor lines resolve to the HIGHEST (the fail-safe direction)
  assert.equal(parsePlanIdFloor('floor=100\nfloor=400'), 400);
  assert.equal(PLAN_ID_FLOOR_REF, 'refs/heads/coord/plan-id-floor');
});

// Delete every non-archive plan file AND its INDEX bullet on origin — the c8c55d9e704 shape.
function rollBackMints(remote, ids) {
  const sib = mkdtempSync(join(tmpdir(), 'nextid-rollback-'));
  const g = (...a) => execFileSync('git', ['-C', sib, ...a], { encoding: 'utf8' });
  execFileSync('git', ['clone', '-q', '-b', 'master', remote, sib]);
  g('config', 'user.email', 'r@r.r');
  g('config', 'user.name', 'R');
  const files = g('ls-files', 'docs/superpowers/plans').split('\n').filter(Boolean);
  for (const f of files) if (ids.some((id) => f.includes(`/${id}-`))) g('rm', '-q', f);
  const indexPath = join(sib, 'docs', 'INDEX.md');
  const kept = readFileSync(indexPath, 'utf8')
    .split('\n')
    .filter((l) => !ids.some((id) => l.includes(`${id}-`)));
  writeFileSync(indexPath, kept.join('\n'));
  g('add', '-A');
  g('commit', '-qm', 'rollback (the stale-index shape)');
  g('push', '-q', 'origin', 'HEAD:master');
  rmSync(sib, { recursive: true, force: true });
}

test('plan 4237 T4: with the two highest plan files deleted from the tree, the next mint stays ABOVE the floor', async () => {
  const r = makeCheckout(); // origin max id = 229 → next 230
  try {
    const claim = async (slug) => {
      const bodyFile = join(r.seed, `body-${slug}.md`);
      writeFileSync(bodyFile, sw(`> 🟩 SEED-WRITE: NO\n\n# ${slug}\n\nbody\n`));
      return allocatePlanId(
        buildClaimOps(r.seed, { category: 'Infra', slug, body: bodyFile, blurb: slug }),
      );
    };
    assert.equal((await claim('first')).id, '230');
    assert.equal((await claim('second')).id, '231');
    assert.equal(readPlanIdFloor(r.seed).floor, 231, 'each mint raised the floor to its id');
    rollBackMints(r.remote, ['230', '231']);
    // the tree alone would now answer 230 again — the floor must win
    assert.equal(nextIdFromRepo(r.seed), '230', 'control: the tree scan has forgotten both');
    assert.equal(nextIdWithFloor(r.seed), '232');
    assert.equal((await claim('third')).id, '232', 'no id is ever re-issued');
    assert.equal(readPlanIdFloor(r.seed).floor, 232);
  } finally {
    r.cleanup();
  }
});

test('plan 4237 T4: raisePlanIdFloor is monotonic — a lower id never lowers it', () => {
  const r = makeCheckout();
  try {
    assert.equal(readPlanIdFloor(r.seed).floor, 0, 'absent ref reads as 0');
    assert.equal(raisePlanIdFloor(r.seed, '300'), 300);
    assert.equal(raisePlanIdFloor(r.seed, '250'), 300, 'a lower id leaves the floor alone');
    assert.equal(readPlanIdFloor(r.seed).floor, 300);
    assert.equal(raisePlanIdFloor(r.seed, '301'), 301);
  } finally {
    r.cleanup();
  }
});

test('plan 4237 review 24db67: a present floor ref without floor=<N> fails closed', () => {
  const r = makeCheckout();
  try {
    const tree = r.g('mktree').trim();
    const c = execFileSync('git', ['-C', r.seed, 'commit-tree', tree, '-m', 'garbage'], {
      encoding: 'utf8',
    }).trim();
    r.g('push', '-q', 'origin', `${c}:${PLAN_ID_FLOOR_REF}`);
    assert.throws(() => readPlanIdFloor(r.seed), /carries no floor=<N> line/);
  } finally {
    r.cleanup();
  }
});

test('plan 4237 review f9528b: the raise reuses the scan snapshot — no second floor read when it wins', () => {
  const r = makeCheckout();
  try {
    const snapshot = readPlanIdFloor(r.seed);
    const calls = [];
    const gitImpl = (dir, args, opts) => {
      calls.push(args[0]);
      return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', ...(opts || {}) });
    };
    assert.equal(raisePlanIdFloor(r.seed, '400', { gitImpl, snapshot }), 400);
    assert.equal(calls.includes('fetch'), false, 'no re-fetch of the floor on the first attempt');
    assert.equal(calls.filter((c) => c === 'ls-remote').length, 0);
    assert.equal(readPlanIdFloor(r.seed).floor, 400);
  } finally {
    r.cleanup();
  }
});
