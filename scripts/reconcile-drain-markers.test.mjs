// Name-paired test file for the genuinely new reconcile-drain-markers.mjs module (plan 3659).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isolatedRepoFactory, runTool } from './test-helpers/isolated-plan-repo.mjs';
// plan 4071: mutationBanner.label/flag moved to coord.config.json, with a project-neutral
// DATA-WRITE/--data-write core default (was the hardcoded SEED-WRITE/--seed-write literal) —
// vetapp's own values now live as an explicit row in vetapp's own coord.config.json. Read them
// the same way stamp-lib.test.mjs's plan-4071 fixture reads planCategories, instead of
// hardcoding the literal a second time in this file.
import { loadCoordConfig } from './coord/coord-config.mjs';
import { repoRootFrom } from './coord/scripts-anchor.mjs';

const { mutationBanner: VETAPP_MUTATION_BANNER } = loadCoordConfig(
  repoRootFrom(import.meta.dirname),
);
// plan 3958: makeRepo() below already writes VETAPP_MUTATION_BANNER into every fixture repo's
// own coord.config.json, but BODY itself still hardcoded the literal "SEED-WRITE" text — a
// mismatch the moment VETAPP_MUTATION_BANNER.label isn't 'SEED-WRITE' (the kit's own neutral
// 'DATA-WRITE' default): the fixture repo's config then says the banner label is 'DATA-WRITE'
// while the body still writes "SEED-WRITE", so SEED_BANNER_RX never matches and every marker
// projection in this file silently no-ops. Identity function on vetapp itself.
const sw = (s) => s.replaceAll('SEED-WRITE', VETAPP_MUTATION_BANNER.label);

const BODY = [
  '---',
  'summary: Reconcile fixture',
  '---',
  '',
  sw('> 🟩 **SEED-WRITE: NO** — coordination only.'),
  '',
  '# Test plan',
  '',
  'Body.',
  '',
].join('\n');
const BASENAME = '3659-Coord-reconcile-fixture.md';
const makeFixtureRepo = isolatedRepoFactory({
  prefix: 'reconcile-drain',
  basename: BASENAME,
  body: BODY,
  tools: { reconcile: 'reconcile-drain-markers.mjs' },
});

// plan 4071 fixture fix: the isolated repo carries no coord.config.json of its own, so
// build-index-lib.mjs's SEED_BANNER_RX (resolved at module-import time, anchored on the
// fixture's OWN copied scripts/ tree via scripts-anchor.mjs) degrades to the generic
// DATA-WRITE label instead of vetapp's SEED-WRITE — and every BODY above carries the real
// vetapp banner text, so every marker in this file would fall through to "no SEED-WRITE
// banner found" without this row. That read is a plain synchronous fs check done at import
// time off the fixture's own root (never fetched through git), so writing the file into
// repo.dir is enough on its own — no commit/push needed here (contrast stamp-lib.test.mjs's
// planCategories fixture, whose gate reads config AFTER an origin ff-sync).
function makeRepo(opts) {
  const repo = makeFixtureRepo(opts);
  writeFileSync(
    join(repo.dir, 'coord.config.json'),
    JSON.stringify({ mutationBanner: VETAPP_MUTATION_BANNER }),
  );
  return repo;
}

function marker(repo, slug = '3659-Coord-reconcile-fixture') {
  repo.g('push', '-q', 'origin', `HEAD:refs/heads/claude/drain-${slug}`);
}

function claim(repo, id = '3659') {
  repo.g('push', '-q', 'origin', `HEAD:refs/claims/${id}`);
}

function run(repo, args = []) {
  return runTool(repo.dir, args, repo.reconcile);
}

test('ready marker projects to flat in-progress with marker and resynced INDEX', () => {
  const repo = makeRepo();
  try {
    marker(repo);
    const result = run(repo);
    assert.equal(result.code, 0, result.stderr);
    repo.g('pull', '-q', '--ff-only', 'origin', 'master');
    const dst = join(repo.dir, 'docs/superpowers/plans/in-progress', BASENAME);
    const body = readFileSync(dst, 'utf8');
    assert.match(body, /\*\*Unclaimed-drain:\*\* claude\/drain-3659-/);
    assert.match(body, /\*\*Status:\*\* 🔄 IN PROGRESS .*ready→in-progress/);
    assert.match(
      readFileSync(join(repo.dir, 'docs/INDEX.md'), 'utf8'),
      /in-progress\/3659-Coord-reconcile-fixture\.md/,
    );
    assert.equal(
      repo.g('log', '-1', '--format=%B').includes('Coord-Write: reconcile-drain-markers'),
      true,
    );
  } finally {
    repo.cleanup();
  }
});

test('colon-outside-bold SEED-WRITE banner is a valid marker anchor', () => {
  const repo = makeRepo({
    body: BODY.replace(
      `**${VETAPP_MUTATION_BANNER.label}: NO**`,
      `**${VETAPP_MUTATION_BANNER.label}**: NO`,
    ),
  });
  try {
    marker(repo);
    const result = run(repo);
    assert.equal(result.code, 0, result.stderr);
    repo.g('pull', '-q', '--ff-only', 'origin', 'master');
    assert.match(
      readFileSync(join(repo.dir, 'docs/superpowers/plans/in-progress', BASENAME), 'utf8'),
      /\*\*Unclaimed-drain:\*\*/,
    );
  } finally {
    repo.cleanup();
  }
});

test('missing banner skips only that marker while another marker still projects', () => {
  const repo = makeRepo({
    body: BODY.replace(new RegExp(`^>.*${VETAPP_MUTATION_BANNER.label}.*\\n\\n`, 'm'), ''),
  });
  try {
    const other = '3660-Coord-valid.md';
    writeFileSync(join(repo.dir, 'docs/superpowers/plans/ready', other), BODY);
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'add valid sibling plan');
    repo.g('push', '-q', 'origin', 'master');
    marker(repo);
    marker(repo, '3660-Coord-valid');
    const result = run(repo);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /3659-.*skipped — no SEED-WRITE banner found/);
    assert.match(result.stdout, /3660-.*projected 3660-Coord-valid\.md/);
  } finally {
    repo.cleanup();
  }
});

test('ready plan wins when archive contains another plan with the same canonical id', () => {
  const repo = makeRepo();
  try {
    writeFileSync(
      join(repo.dir, 'docs/superpowers/plans/archive/3659-Coord-old.md'),
      BODY.replace('Reconcile fixture', 'Archived fixture'),
    );
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'add archived same-id plan');
    repo.g('push', '-q', 'origin', 'master');
    marker(repo);
    const result = run(repo);
    assert.equal(result.code, 0, result.stderr);
    repo.g('pull', '-q', '--ff-only', 'origin', 'master');
    assert.match(
      readFileSync(join(repo.dir, 'docs/superpowers/plans/in-progress', BASENAME), 'utf8'),
      /\*\*Unclaimed-drain:\*\*/,
    );
  } finally {
    repo.cleanup();
  }
});

test('branch replacement syntax is written literally', () => {
  const repo = makeRepo();
  try {
    marker(repo, '3659-$&-literal');
    const result = run(repo);
    assert.equal(result.code, 0, result.stderr);
    repo.g('pull', '-q', '--ff-only', 'origin', 'master');
    assert.match(
      readFileSync(join(repo.dir, 'docs/superpowers/plans/in-progress', BASENAME), 'utf8'),
      /\*\*Unclaimed-drain:\*\* claude\/drain-3659-\$&-literal/,
    );
  } finally {
    repo.cleanup();
  }
});

test('zero-padded marker and claim ids compare canonically', () => {
  const projected = makeRepo();
  try {
    marker(projected, '03659-Coord-reconcile-fixture');
    assert.equal(run(projected).code, 0);
    projected.g('pull', '-q', '--ff-only', 'origin', 'master');
    assert.match(
      readFileSync(join(projected.dir, 'docs/superpowers/plans/in-progress', BASENAME), 'utf8'),
      /Unclaimed-drain/,
    );
  } finally {
    projected.cleanup();
  }

  const claimed = makeRepo();
  try {
    marker(claimed);
    claim(claimed, '03659');
    const result = run(claimed);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /skipped — live claim ref exists/);
  } finally {
    claimed.cleanup();
  }
});

test('marker for a plan outside ready is skipped (plan 3652 shape)', () => {
  const repo = makeRepo({ startFolder: 'waiting-blocked' });
  try {
    marker(repo);
    const before = repo.g('rev-parse', 'origin/master').trim();
    const result = run(repo);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /skipped — plan is in waiting-blocked\/, not ready\//);
    assert.equal(repo.g('rev-parse', 'origin/master').trim(), before);
  } finally {
    repo.cleanup();
  }
});

test('live claim wins over a ready marker', () => {
  const repo = makeRepo();
  try {
    marker(repo);
    claim(repo);
    const result = run(repo);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /skipped — live claim ref exists/);
  } finally {
    repo.cleanup();
  }
});

test('marker with no resolvable plan is a clean skip', () => {
  const repo = makeRepo();
  try {
    marker(repo, '9999-Coord-missing');
    const result = run(repo);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /skipped — no plan file resolves for slug/);
  } finally {
    repo.cleanup();
  }
});

test('a second run is an idempotent no-op and does not duplicate the marker', () => {
  const repo = makeRepo();
  try {
    marker(repo);
    assert.equal(run(repo).code, 0);
    const tip = execFileSync('git', ['--git-dir', repo.origin, 'rev-parse', 'master'], {
      encoding: 'utf8',
    }).trim();
    const second = run(repo);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /skipped — plan is in in-progress\/.*not ready\//);
    assert.equal(
      execFileSync('git', ['--git-dir', repo.origin, 'rev-parse', 'master'], {
        encoding: 'utf8',
      }).trim(),
      tip,
    );
    repo.g('pull', '-q', '--ff-only', 'origin', 'master');
    const body = readFileSync(
      join(repo.dir, 'docs/superpowers/plans/in-progress', BASENAME),
      'utf8',
    );
    assert.equal((body.match(/\*\*Unclaimed-drain:\*\*/g) || []).length, 1);
  } finally {
    repo.cleanup();
  }
});

test('the shared walker finds a ready plan in a category subfolder', () => {
  const repo = makeRepo();
  try {
    const nested = join(repo.dir, 'docs/superpowers/plans/ready/infra', BASENAME);
    mkdirSync(join(repo.dir, 'docs/superpowers/plans/ready/infra'), { recursive: true });
    repo.g('mv', repo.srcRel, `docs/superpowers/plans/ready/infra/${BASENAME}`);
    writeFileSync(nested, BODY);
    repo.g('commit', '-qam', 'nest ready plan');
    repo.g('push', '-q', 'origin', 'master');
    marker(repo);
    const result = run(repo);
    assert.equal(result.code, 0, result.stderr);
    repo.g('pull', '-q', '--ff-only', 'origin', 'master');
    assert.equal(
      readFileSync(join(repo.dir, 'docs/superpowers/plans/in-progress', BASENAME), 'utf8').includes(
        'Unclaimed-drain',
      ),
      true,
    );
  } finally {
    repo.cleanup();
  }
});
