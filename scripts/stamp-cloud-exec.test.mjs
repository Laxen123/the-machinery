// scripts/stamp-cloud-exec.test.mjs — modeled on stamp-exec-model.test.mjs: unit
// tests for the pure helpers (setFrontmatterKey, upsertCloudExecReason,
// stripCloudExecReason) PLUS end-to-end subprocess tests against a throwaway
// isolated git repo (the shared test-helpers/isolated-plan-repo.mjs scaffold —
// plan 1797; it also clears the inherited git env vars at import, plan 338).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolatedRepoFactory, runTool as runStamp } from './test-helpers/isolated-plan-repo.mjs';
import {
  setFrontmatterKey,
  upsertCloudExecReason,
  stripCloudExecReason,
  upsertClaudeDirOverride,
  findClaudeDirReference,
  upsertHuskyOverride,
  findHuskyDirReference,
  assertNoBrowserDowngrade,
  VALID_CLOUD_ENV,
  CLOUD_ENV_RUNGS,
  upsertCloudReposBanner,
} from './stamp-cloud-exec.mjs';
import { parseCloudRepos, VALID_CLOUD_REPOS, CLOUD_REPOS } from './coord/cloud-repos-lib.mjs';
// plan 2323: queue-drain.mjs cannot import stamp-cloud-exec.mjs (queue-drain.mjs
// is adopted byte-identical by the tandapp sibling; stamp-cloud-exec.mjs is not),
// so it carries its own ported-verbatim mirror of CLOUD_ENV_RUNGS — imported here
// (rather than from queue-drain.test.mjs) so the AUTHORITATIVE table's own test
// file is the one asserting no drift, the same pattern blocked-by-lib.test.mjs
// uses for BLOCKED_BY_LINE_RE vs queue-drain.mjs's copy.
import { CLOUD_ENV_RUNGS as QUEUE_DRAIN_CLOUD_ENV_RUNGS } from './coord/queue-drain.mjs';

// ─────────────────────────── pure-function tests ───────────────────────────

test('setFrontmatterKey: inserts cloudExec into an existing block, preserving siblings', () => {
  const out = setFrontmatterKey('---\nsummary: x\n---\n\n# T\n', 'cloudExec', 'true');
  assert.match(out, /^summary: x$/m);
  assert.match(out, /^cloudExec: true$/m);
  assert.equal((out.match(/^---$/gm) || []).length, 2);
});

test('setFrontmatterKey: replaces an existing cloudExec value in place', () => {
  const out = setFrontmatterKey(
    '---\nsummary: x\ncloudExec: false\n---\n\n# T\n',
    'cloudExec',
    'true',
  );
  assert.equal((out.match(/^cloudExec:/gm) || []).length, 1);
  assert.match(out, /^cloudExec: true$/m);
});

test('upsertCloudExecReason: inserts a new banner right after the last SEED-WRITE/Cost banner', () => {
  const body = [
    '---',
    'summary: x',
    '---',
    '',
    '> 🟩 **SEED-WRITE: no**',
    '> 💰 **Cost forecast:** $0',
    '',
    '# T',
    '',
  ].join('\n');
  const out = upsertCloudExecReason(body, 'needs Playwright/Chrome the sandbox lacks');
  assert.match(
    out,
    /^> ☁️ \*\*cloudExec: false\*\* — needs Playwright\/Chrome the sandbox lacks$/m,
  );
  // it sits directly below the Cost-forecast banner (the last banner line)
  const lines = out.split('\n');
  const costIdx = lines.findIndex((l) => /Cost forecast/.test(l));
  assert.match(lines[costIdx + 1], /cloudExec: false/);
});

test('upsertCloudExecReason: replaces an existing cloudExec banner in place (idempotent, no dup)', () => {
  const body = [
    '---',
    'summary: x',
    '---',
    '',
    '> 🟩 **SEED-WRITE: no**',
    '> ☁️ **cloudExec: false** — old reason',
    '',
    '# T',
    '',
  ].join('\n');
  const out = upsertCloudExecReason(body, 'new reason');
  assert.equal((out.match(/cloudExec: false/g) || []).length, 1);
  assert.match(out, /cloudExec: false\*\* — new reason/);
  assert.doesNotMatch(out, /old reason/);
});

test('upsertCloudExecReason: no banners present ⇒ inserts right after the frontmatter block', () => {
  const out = upsertCloudExecReason('---\nsummary: x\n---\n\n# T\n', 'no local keys');
  const lines = out.split('\n');
  // frontmatter closes at the second '---'; the banner follows it
  const fenceIdxs = lines.reduce((a, l, i) => (l === '---' ? [...a, i] : a), []);
  assert.match(lines[fenceIdxs[1] + 1], /cloudExec: false/);
});

test('stripCloudExecReason: removes a cloudExec banner and collapses the doubled blank', () => {
  const body = [
    '---',
    'summary: x',
    '---',
    '',
    '> 🟩 **SEED-WRITE: no**',
    '> ☁️ **cloudExec: false** — some reason',
    '',
    '# T',
    '',
  ].join('\n');
  const out = stripCloudExecReason(body);
  assert.doesNotMatch(out, /cloudExec/);
  assert.doesNotMatch(out, /\n\n\n/); // no triple-newline left behind
  assert.match(out, /SEED-WRITE: no/);
});

test('stripCloudExecReason: no-op when there is no banner', () => {
  const body = '---\nsummary: x\n---\n\n# T\n';
  assert.equal(stripCloudExecReason(body), body);
});

// plan 1781 review [1]: a CRLF body must collapse the doubled blank too — a bare
// `/\n{3,}/` no-ops on CRLF (the interleaved `\r` breaks the run of `\n`s). The
// banner sits BETWEEN two blank lines, so removing it leaves them adjacent.
test('stripCloudExecReason: collapses the doubled blank on a CRLF body (EOL-agnostic)', () => {
  const body = [
    '---',
    'summary: x',
    '---',
    '',
    '> ☁️ **cloudExec: false** — r',
    '',
    '# T',
    '',
  ].join('\r\n');
  const out = stripCloudExecReason(body);
  assert.doesNotMatch(out, /cloudExec/);
  assert.doesNotMatch(out, /\r\n\r\n\r\n/); // the removal's doubled blank was collapsed
  assert.match(out, /---\r\n\r\n# T/); // exactly one blank between frontmatter and heading
});

// ─────────────────────────── subprocess / repo tests ───────────────────────────

const DEFAULT_BODY = [
  '---',
  'summary: Test plan for stamp-cloud-exec',
  'seedWrite: false',
  '---',
  '',
  '> 🟩 **SEED-WRITE: no**',
  '> 💰 **Cost forecast:** $0',
  '',
  '**Status:** 📋 READY — opened 2026-07-13.',
  '',
  '# 1000-Other-foo',
  '',
  'Body.',
  '',
].join('\n');

// The shared isolated-plan-repo scaffold with this suite's defaults baked in; the
// `stampCloudExec` key is the COPIED tool inside the temp repo (run that copy,
// never the real tool). `coordConfig` (plan 3958) gives the fixture a `cloudRepos`
// registry keyed `hobby-main` with synthetic values (never this project's real
// registered repo/owner/token-env-var literals) — the copied stamp-cloud-exec.mjs
// imports the copied cloud-repos-lib.mjs, which now self-resolves its registry from
// THIS temp repo's own coord.config.json (see cloud-repos-lib.mjs's header), so the
// `--repos hobby-main` subprocess cases below need that key registered here to pass.
const makeIsolatedRepo = isolatedRepoFactory({
  prefix: 'stampcloud',
  basename: '1000-Other-foo.md',
  body: DEFAULT_BODY,
  tools: { stampCloudExec: 'stamp-cloud-exec.mjs' },
  coordConfig: {
    cloudRepos: [
      {
        key: 'hobby-main',
        url: 'https://example.invalid/hobby-main',
        dir: 'hobby-main',
        tokenEnv: 'TEST_CLOUD_REPO_PAT',
        note: 'Synthetic fixture row for the isolated-plan-repo test scaffold.',
      },
    ],
  },
});

test('stamp-cloud-exec: stamping true sets cloudExec: true (no body banner)', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'true'], repo.stampCloudExec);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: true$/m);
    assert.doesNotMatch(body, /☁️/);
    assert.match(body, /^summary: Test plan for stamp-cloud-exec$/m); // siblings preserved
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: stamping false sets cloudExec: false AND records the reason banner', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'false', '--reason', 'needs Playwright/Chrome the sandbox lacks'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: false$/m);
    assert.match(
      body,
      /^> ☁️ \*\*cloudExec: false\*\* — needs Playwright\/Chrome the sandbox lacks$/m,
    );
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: a false stamp with NO --reason fails (exit 2) and mutates nothing', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'false'], repo.stampCloudExec);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /REQUIRES --reason/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.doesNotMatch(body, /cloudExec/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: re-stamping true STRIPS a prior false reason banner', () => {
  const repo = makeIsolatedRepo();
  try {
    let res = runStamp(
      repo.dir,
      ['1000', 'false', '--reason', 'no local keys'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 0, `false stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    res = runStamp(repo.dir, ['1000', 'true'], repo.stampCloudExec);
    assert.equal(res.code, 0, `true stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: true$/m);
    assert.doesNotMatch(body, /☁️/);
    assert.doesNotMatch(body, /no local keys/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: refuses in-progress/ and leaves a clean, unstamped tree', () => {
  const repo = makeIsolatedRepo({ startFolder: 'in-progress' });
  try {
    const res = runStamp(repo.dir, ['1000', 'true'], repo.stampCloudExec);
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /refusing to stamp .* in-progress\//);
    assert.equal(
      repo.g('status', '--porcelain', '--untracked-files=no').trim(),
      '',
      'MAIN tracked tree should be untouched',
    );
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: --dry previews without mutating anything', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'true', '--dry'], repo.stampCloudExec);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /\[dry\] set cloudExec: true/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.doesNotMatch(body, /cloudExec/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: invalid cloudExec value is rejected (exit 2)', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'maybe'], repo.stampCloudExec);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /invalid cloudExec value/);
  } finally {
    repo.cleanup();
  }
});

// ─────────────────────────── plan 1925: the --env (cloudEnv) axis ───────────────────────────

test('stamp-cloud-exec: true --env full writes BOTH frontmatter keys in one atomic stamp', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'true', '--env', 'full'], repo.stampCloudExec);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: true$/m);
    assert.match(body, /^cloudEnv: full$/m);
    assert.match(body, /^summary: Test plan for stamp-cloud-exec$/m); // siblings preserved
    // one commit carries both keys — the axes can never be half-stamped
    const subject = repo.g('log', '-1', '--format=%s', 'origin/master');
    assert.match(subject, /cloudExec: true cloudEnv: full/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: true --env trusted writes an explicit cloudEnv: trusted', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'true', '--env', 'trusted'], repo.stampCloudExec);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudEnv: trusted$/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: --env alongside a false stamp REFUSES (exit 2) and mutates nothing', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'false', '--env', 'full', '--reason', 'x'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /--env is only legal alongside a `true` stamp/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.doesNotMatch(body, /cloudExec|cloudEnv/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: invalid --env value is rejected (exit 2)', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'true', '--env', 'open'], repo.stampCloudExec);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /invalid --env value/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: bare stamps leave an existing cloudEnv key untouched (independent axes)', () => {
  // Chain: true --env full → false --reason (bare) → true (bare). The cloudEnv
  // key written by the first stamp must survive both bare restamps — a cloudExec
  // flip must never silently clear a plan's env routing. (Each step changes
  // content; an idempotent same-value restamp has nothing to commit and errors,
  // which is pre-existing stamp-lib behavior, deliberately not exercised here.)
  const repo = makeIsolatedRepo();
  try {
    let res = runStamp(repo.dir, ['1000', 'true', '--env', 'full'], repo.stampCloudExec);
    assert.equal(res.code, 0, `env stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    res = runStamp(
      repo.dir,
      ['1000', 'false', '--reason', 'blocker appeared'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 0, `false stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    let body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: false$/m);
    assert.match(body, /^cloudEnv: full$/m); // routing survived the false stamp
    res = runStamp(repo.dir, ['1000', 'true'], repo.stampCloudExec);
    assert.equal(res.code, 0, `bare restamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: true$/m);
    assert.match(body, /^cloudEnv: full$/m); // …and the bare true restamp
    assert.doesNotMatch(body, /☁️/); // the false banner was stripped as usual
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: --dry with --env previews both keys and mutates nothing', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'true', '--env', 'full', '--dry'], repo.stampCloudExec);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /\[dry\] set cloudExec: true/);
    assert.match(res.stdout, /\[dry\] set cloudEnv: full/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.doesNotMatch(body, /cloudExec|cloudEnv/);
  } finally {
    repo.cleanup();
  }
});

// ─────────────────────────── plan 2250: --env browser + the anti-downgrade guard ───────────────────────────

test('assertNoBrowserDowngrade: throws (fatal) when the body already has cloudEnv: browser and newEnv is full', () => {
  const body = '---\nsummary: x\ncloudEnv: browser\n---\n\n# T\n';
  assert.throws(
    () => assertNoBrowserDowngrade(body, 'full'),
    (e) => e.fatal === true && /refusing to restamp cloudEnv: browser → full/.test(e.message),
  );
});

test('assertNoBrowserDowngrade: throws (fatal) when the body already has cloudEnv: browser and newEnv is trusted — the SAME lesson, the other rung down', () => {
  const body = '---\nsummary: x\ncloudEnv: browser\n---\n\n# T\n';
  assert.throws(
    () => assertNoBrowserDowngrade(body, 'trusted'),
    (e) => e.fatal === true && /refusing to restamp cloudEnv: browser → trusted/.test(e.message),
  );
});

test('assertNoBrowserDowngrade: no-op when newEnv is not full/trusted (e.g. browser→browser, or unset)', () => {
  const body = '---\nsummary: x\ncloudEnv: browser\n---\n\n# T\n';
  assert.doesNotThrow(() => assertNoBrowserDowngrade(body, 'browser'));
  assert.doesNotThrow(() => assertNoBrowserDowngrade(body, undefined));
});

test('assertNoBrowserDowngrade: no-op when the body has no existing cloudEnv (first stamp)', () => {
  assert.doesNotThrow(() => assertNoBrowserDowngrade('---\nsummary: x\n---\n\n# T\n', 'full'));
  assert.doesNotThrow(() => assertNoBrowserDowngrade('---\nsummary: x\n---\n\n# T\n', 'trusted'));
});

test('assertNoBrowserDowngrade: no-op when the body already has cloudEnv: full or trusted', () => {
  assert.doesNotThrow(() =>
    assertNoBrowserDowngrade('---\nsummary: x\ncloudEnv: full\n---\n\n# T\n', 'full'),
  );
  assert.doesNotThrow(() =>
    assertNoBrowserDowngrade('---\nsummary: x\ncloudEnv: trusted\n---\n\n# T\n', 'full'),
  );
  assert.doesNotThrow(() =>
    assertNoBrowserDowngrade('---\nsummary: x\ncloudEnv: full\n---\n\n# T\n', 'trusted'),
  );
  assert.doesNotThrow(() =>
    assertNoBrowserDowngrade('---\nsummary: x\ncloudEnv: trusted\n---\n\n# T\n', 'trusted'),
  );
});

test('stamp-cloud-exec: true --env browser writes cloudEnv: browser', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'true', '--env', 'browser'], repo.stampCloudExec);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: true$/m);
    assert.match(body, /^cloudEnv: browser$/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: restamping cloudEnv: browser → --env full REFUSES (exit 2, fatal) and mutates nothing (the 2241 lesson as a check)', () => {
  const repo = makeIsolatedRepo();
  try {
    let res = runStamp(repo.dir, ['1000', 'true', '--env', 'browser'], repo.stampCloudExec);
    assert.equal(res.code, 0, `browser stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    res = runStamp(repo.dir, ['1000', 'true', '--env', 'full'], repo.stampCloudExec);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /refusing to restamp cloudEnv: browser → full/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudEnv: browser$/m); // unchanged — the refusal must not partially land
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: restamping cloudEnv: browser → --env trusted REFUSES too (exit 2, fatal) and mutates nothing', () => {
  const repo = makeIsolatedRepo();
  try {
    let res = runStamp(repo.dir, ['1000', 'true', '--env', 'browser'], repo.stampCloudExec);
    assert.equal(res.code, 0, `browser stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    res = runStamp(repo.dir, ['1000', 'true', '--env', 'trusted'], repo.stampCloudExec);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /refusing to restamp cloudEnv: browser → trusted/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudEnv: browser$/m); // unchanged — the refusal must not partially land
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: restamping cloudEnv: browser → --env browser (idempotent direction) is fine', () => {
  const repo = makeIsolatedRepo();
  try {
    let res = runStamp(repo.dir, ['1000', 'true', '--env', 'browser'], repo.stampCloudExec);
    assert.equal(res.code, 0);
    // a bare true restamp (no --env) leaves cloudEnv: browser untouched — independent axes
    res = runStamp(repo.dir, ['1000', 'false', '--reason', 'temp'], repo.stampCloudExec);
    assert.equal(res.code, 0, `false stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    res = runStamp(repo.dir, ['1000', 'true'], repo.stampCloudExec);
    assert.equal(res.code, 0, `bare restamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudEnv: browser$/m);
  } finally {
    repo.cleanup();
  }
});

// ───────── plan 2151: the `.claude/` gate on a `true` stamp + --claude-dir-ok ─────────

const fm = (...body) => ['---', 'summary: x', '---', '', ...body, ''].join('\n');

test('findClaudeDirReference: fires on a .claude/ path in a Scope section', () => {
  const hit = findClaudeDirReference(
    fm('## Scope', '', '1. Add a guard hook at `.claude/hooks/foo.mjs`.'),
  );
  assert.ok(hit, 'expected a hit');
  assert.match(hit.line, /\.claude\/hooks\/foo\.mjs/);
  assert.equal(typeof hit.lineNo, 'number');
});

test('findClaudeDirReference: null on a plan that never names .claude/', () => {
  assert.equal(findClaudeDirReference(fm('## Scope', '', '1. Edit `scripts/foo.mjs`.')), null);
});

test('findClaudeDirReference: ignores a .claude/ path inside a fenced code block', () => {
  assert.equal(
    findClaudeDirReference(fm('## Scope', '', '```bash', 'cat .claude/settings.json', '```')),
    null,
  );
});

test('findClaudeDirReference: ignores a ~~~ fence too, and resumes scanning after it closes', () => {
  assert.equal(findClaudeDirReference(fm('~~~', 'ls .claude/hooks/', '~~~')), null);
  const hit = findClaudeDirReference(
    fm('~~~', 'ls .claude/hooks/', '~~~', '', 'Edit `.claude/x`.'),
  );
  assert.ok(hit, 'the post-fence mention must still fire');
  assert.match(hit.line, /Edit/);
});

test('findClaudeDirReference: ignores lines under a "## Do NOT touch" heading', () => {
  assert.equal(
    findClaudeDirReference(fm('## Do NOT touch', '', '- `.claude/hooks/**` itself.')),
    null,
  );
});

test('findClaudeDirReference: the Do-not-touch skip ENDS at the next heading', () => {
  const hit = findClaudeDirReference(
    fm('## Do-not-touch', '', '- `.claude/hooks/**`.', '', '## Scope', '', '1. `.claude/x.mjs`'),
  );
  assert.ok(hit, 'a mention after the section must still fire');
  assert.match(hit.line, /1\. `\.claude\/x\.mjs`/);
});

// plan 2216 review: a "do not touch" heading with NO space after the hashes (`##Do not touch`)
// matches DO_NOT_TOUCH_RX's `\s*` but not HEADING_LEVEL_RX's required `\s`, so doNotTouchBounds
// must derive the anchor's own level independently rather than reusing a possibly-null `m` —
// otherwise this throws instead of returning a hit/null.
test('findClaudeDirReference: a heading with no space after the hashes does not crash the scan', () => {
  assert.doesNotThrow(() =>
    findClaudeDirReference(fm('##Do not touch', '', '- `.claude/hooks/**` itself.')),
  );
  assert.equal(
    findClaudeDirReference(fm('##Do not touch', '', '- `.claude/hooks/**` itself.')),
    null,
  );
});

test('findClaudeDirReference: does not fire on sibling config dirs or a bare prose ".claude"', () => {
  assert.equal(findClaudeDirReference(fm('Keys live in `~/.claude-work/settings.json`.')), null);
  assert.equal(findClaudeDirReference(fm('The .claude directory holds hooks.')), null);
});

test('findClaudeDirReference: fires on the `.claude/**` glob form and skips frontmatter', () => {
  assert.equal(findClaudeDirReference('---\nsummary: touches .claude/hooks\n---\n\n# T\n'), null);
  assert.ok(findClaudeDirReference(fm('Work lands under `.claude/**`.')));
});

const CLAUDE_DIR_BODY = [
  '---',
  'summary: Test plan naming a claude dir path',
  'seedWrite: false',
  '---',
  '',
  '> 🟩 **SEED-WRITE: no**',
  '> 💰 **Cost forecast:** $0',
  '',
  '**Status:** 📋 READY — opened 2026-07-20.',
  '',
  '# 1000-Other-foo',
  '',
  '## Scope',
  '',
  '1. Add a guard hook at `.claude/hooks/guard.mjs`.',
  '',
].join('\n');

const makeClaudeDirRepo = isolatedRepoFactory({
  prefix: 'stampcloudclaudedir',
  basename: '1000-Other-foo.md',
  body: CLAUDE_DIR_BODY,
  tools: { stampCloudExec: 'stamp-cloud-exec.mjs' },
});

test('stamp-cloud-exec: a true stamp on a .claude/-touching plan REFUSES (exit 2), mutates nothing', () => {
  const repo = makeClaudeDirRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'true'], repo.stampCloudExec);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    const out = `${res.stderr}${res.stdout}`;
    assert.match(out, /REFUSING cloudExec: true/);
    assert.match(out, /\.claude\/hooks\/guard\.mjs/); // names the matched line
    assert.match(out, /--claude-dir-ok/); // points at the escape hatch
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.doesNotMatch(body, /cloudExec/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: the gate also fires under --dry (a dry run never lies about the outcome)', () => {
  const repo = makeClaudeDirRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'true', '--dry'], repo.stampCloudExec);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /REFUSING cloudExec: true/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: --claude-dir-ok overrides the gate and records the justification banner', () => {
  const repo = makeClaudeDirRepo();
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'true', '--claude-dir-ok', 'prose mention only; the work is scripts/'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: true$/m);
    assert.match(
      body,
      /^> ☁️ \*\*cloudExec: true — `\.claude\/` gate overridden\*\* — prose mention only; the work is scripts\/$/m,
    );
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: a FALSE stamp is never gated, even on a .claude/-touching plan', () => {
  const repo = makeClaudeDirRepo();
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'false', '--reason', 'writes under .claude/, local lane only'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: false$/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: an ordinary plan still stamps true with no override needed', () => {
  const repo = makeIsolatedRepo(); // DEFAULT_BODY — never names .claude/
  try {
    const res = runStamp(repo.dir, ['1000', 'true'], repo.stampCloudExec);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: true$/m);
    assert.doesNotMatch(body, /☁️/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: --claude-dir-ok alongside a false stamp REFUSES (exit 2)', () => {
  const repo = makeClaudeDirRepo();
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'false', '--reason', 'x', '--claude-dir-ok', 'y'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(
      `${res.stderr}${res.stdout}`,
      /--claude-dir-ok is only legal alongside a `true` stamp/,
    );
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: a later false restamp REPLACES the override banner (never doubled)', () => {
  // Override first (gate cleared, banner written), then flip to false: the override
  // record must not outlive the stamp that justified it.
  const repo = makeClaudeDirRepo();
  try {
    let res = runStamp(
      repo.dir,
      ['1000', 'true', '--claude-dir-ok', 'prose only'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 0, `override stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    res = runStamp(repo.dir, ['1000', 'false', '--reason', 'reconsidered'], repo.stampCloudExec);
    assert.equal(res.code, 0, `false stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: false$/m);
    assert.doesNotMatch(body, /gate overridden/);
    assert.match(body, /reconsidered/);
  } finally {
    repo.cleanup();
  }
});

// ───────── plan 2151 review fixes — regressions for findings 0-4 ─────────

// Finding 0: an unclosed fence must NOT disable the scanner for the rest of the body.
// A running inFence toggle stuck ON is a silent bypass of the whole gate.
test('findClaudeDirReference: an UNCLOSED fence does not exempt the rest of the body', () => {
  const hit = findClaudeDirReference(
    fm(
      '```bash',
      'echo "someone forgot the closing fence"',
      '',
      '## Scope',
      '',
      '1. Add a guard hook at `.claude/hooks/guard.mjs`.',
    ),
  );
  assert.ok(hit, 'the unterminated opener must be treated as prose, not a fence');
  assert.match(hit.line, /\.claude\/hooks\/guard\.mjs/);
});

test('findClaudeDirReference: an odd number of fences still scans the unmatched tail', () => {
  const hit = findClaudeDirReference(
    fm('```', 'closed', '```', '', '```', 'never closed', '', '`.claude/settings.json`'),
  );
  assert.ok(hit, 'text after the unmatched third fence must still be scanned');
  assert.match(hit.line, /settings\.json/);
});

// Finding 4: the Do-NOT-touch carve-out must end only at a SAME-OR-SHALLOWER heading,
// so a deeper sub-heading inside it is content, not a boundary (build-index-lib ruling R1).
test('findClaudeDirReference: a ### sub-heading does not end the Do-NOT-touch carve-out', () => {
  assert.equal(
    findClaudeDirReference(
      fm(
        '## Do NOT touch',
        '',
        '- the hooks themselves.',
        '',
        '### Rationale',
        '',
        '- `.claude/hooks/**` is plan 2140 territory.',
      ),
    ),
    null,
  );
});

test('findClaudeDirReference: the carve-out DOES end at the next same-level heading', () => {
  const hit = findClaudeDirReference(
    fm(
      '## Do NOT touch',
      '',
      '### Rationale',
      '',
      '- `.claude/hooks/**` is plan 2140 territory.',
      '',
      '## Scope',
      '',
      '1. `.claude/settings.json`',
    ),
  );
  assert.ok(hit, 'the Scope mention after the carve-out must fire');
  assert.match(hit.line, /settings\.json/);
});

test('findClaudeDirReference: a path named in the carve-out HEADING itself is exempt', () => {
  assert.equal(findClaudeDirReference(fm('## Do NOT touch `.claude/hooks/**`', '', 'Body.')), null);
});

// ───────── second review pass — the tool's own override banner + carve-out fence-safety ─────────

// The `--claude-dir-ok` banner itself contains a literal `.claude/` token; a later plain
// re-stamp of the same plan must not refuse, citing the tool's own audit-trail line.
test("findClaudeDirReference: the tool's own --claude-dir-ok override banner never re-triggers the gate", () => {
  const body = upsertClaudeDirOverride(
    fm('## Scope', '', '1. Add a guard hook — see justification below.'),
    'only names .claude/** in prose; the work is scripts/',
  );
  assert.match(body, /cloudExec: true — `\.claude\/` gate overridden/);
  assert.equal(findClaudeDirReference(body), null);
});

// The banner skip must not blind the scanner to a REAL .claude/ reference living
// elsewhere in the same body, alongside a stamped override banner from a past pass.
test('findClaudeDirReference: a real .claude/ reference still fires alongside an override banner', () => {
  const body = upsertClaudeDirOverride(
    fm('## Scope', '', '1. Add a guard hook — see justification below.'),
    'the FIRST .claude/ mention was safe',
  );
  const withNewWork = body.replace(
    '1. Add a guard hook — see justification below.',
    '1. Add a guard hook — see justification below.\n2. Edit `.claude/hooks/new-guard.mjs`.',
  );
  const hit = findClaudeDirReference(withNewWork);
  assert.ok(
    hit,
    'a genuine new .claude/ reference must still fire even with a stale override banner present',
  );
  assert.match(hit.line, /new-guard\.mjs/);
});

// An unclosed fence INSIDE the Do-NOT-touch section must not swallow a later real Scope
// section into the exempt carve-out (the same failure class as finding 0, now for the
// carve-out's own boundary search rather than the direct scan).
test('findClaudeDirReference: an unclosed fence inside Do-NOT-touch does not swallow a later Scope section', () => {
  const hit = findClaudeDirReference(
    fm(
      '## Do NOT touch',
      '',
      '- the hooks themselves.',
      '',
      '```bash',
      'echo no closing fence here',
      '',
      '## Scope',
      '',
      '1. Edit `.claude/hooks/guard.mjs`.',
    ),
  );
  assert.ok(hit, 'the unclosed fence must not extend the Do-NOT-touch carve-out through EOF');
  assert.match(hit.line, /\.claude\/hooks\/guard\.mjs/);
});

// Finding 2: the pre-existing status refusal must win over the new gate. Both apply to an
// in-progress/ plan that names .claude/ — the actionable one is the folder, not the gate.
const IN_PROGRESS_CLAUDE_BODY = [
  '---',
  'summary: In-progress plan that also names a claude dir path',
  '---',
  '',
  '# 1000-Other-foo',
  '',
  '## Scope',
  '',
  '1. Edit `.claude/hooks/guard.mjs`.',
  '',
].join('\n');

test('stamp-cloud-exec: in-progress/ + a .claude/ mention reports the STATUS refusal, not the gate', () => {
  const repo = isolatedRepoFactory({
    prefix: 'stampcloudorder',
    basename: '1000-Other-foo.md',
    body: IN_PROGRESS_CLAUDE_BODY,
    tools: { stampCloudExec: 'stamp-cloud-exec.mjs' },
  })({ startFolder: 'in-progress' });
  try {
    const res = runStamp(repo.dir, ['1000', 'true'], repo.stampCloudExec);
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    const out = `${res.stderr}${res.stdout}`;
    assert.match(out, /refusing to stamp .* in-progress\//);
    assert.doesNotMatch(out, /REFUSING cloudExec: true/); // the gate must not pre-empt it
  } finally {
    repo.cleanup();
  }
});

// Finding 1: the gate must never silently stand aside. It now runs inside the stamp
// spine, so an unresolvable plan yields the spine's own error — never a cleared gate.
test('stamp-cloud-exec: an unknown plan id errors from the resolver, never a silent true stamp', () => {
  const repo = makeClaudeDirRepo();
  try {
    const res = runStamp(repo.dir, ['9999', 'true'], repo.stampCloudExec);
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.doesNotMatch(body, /cloudExec/);
  } finally {
    repo.cleanup();
  }
});

// Finding 3: the gate reads the body the stamp will actually mutate. A plan whose ORIGIN
// copy names .claude/ must refuse even when the local working tree looks clean.
test('stamp-cloud-exec: the gate reads the ff-synced body, not a stale local working tree', () => {
  const repo = makeIsolatedRepo(); // seeded with DEFAULT_BODY — no .claude/ mention
  try {
    // Push a .claude/-naming edit to origin, then rewind the local checkout so its working
    // tree no longer shows it — the stamp must still refuse, because stampImpl ff-syncs
    // from origin before the preflight reads the body.
    const rel = 'docs/superpowers/plans/ready/1000-Other-foo.md';
    const dirty = `${DEFAULT_BODY}\n## Scope\n\n1. Edit \`.claude/hooks/late.mjs\`.\n`;
    writeFileSync(join(repo.dir, rel), dirty);
    repo.g('add', '--', rel);
    repo.g('commit', '-qm', 'add a .claude/ step');
    repo.g('push', '-q', 'origin', 'master');
    repo.g('reset', '-q', '--hard', 'HEAD~1');
    const res = runStamp(repo.dir, ['1000', 'true'], repo.stampCloudExec);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /\.claude\/hooks\/late\.mjs/);
  } finally {
    repo.cleanup();
  }
});

// ───────── plan 2213: the `.husky/` gate on a `true` stamp + --husky-ok ─────────

test('findHuskyDirReference: fires on a .husky/ path in a Scope section', () => {
  const hit = findHuskyDirReference(
    fm('## Scope', '', '1. Extend the gate at `.husky/pre-push:1452`.'),
  );
  assert.ok(hit, 'expected a hit');
  assert.match(hit.line, /\.husky\/pre-push:1452/);
  assert.equal(typeof hit.lineNo, 'number');
});

test('findHuskyDirReference: null on a plan that never names .husky/', () => {
  assert.equal(findHuskyDirReference(fm('## Scope', '', '1. Edit `scripts/foo.mjs`.')), null);
});

test('findHuskyDirReference: ignores a .husky/ path inside a fenced code block', () => {
  assert.equal(
    findHuskyDirReference(fm('## Scope', '', '```bash', 'cat .husky/pre-push', '```')),
    null,
  );
});

test('findHuskyDirReference: ignores lines under a "## Do NOT touch" heading', () => {
  assert.equal(
    findHuskyDirReference(fm('## Do NOT touch', '', '- `.husky/pre-push` itself.')),
    null,
  );
});

test('findHuskyDirReference: does not fire on a bare prose ".husky" mention', () => {
  assert.equal(findHuskyDirReference(fm('The .husky directory holds git hooks.')), null);
});

const HUSKY_DIR_BODY = [
  '---',
  'summary: Test plan naming a husky hook path',
  'seedWrite: false',
  '---',
  '',
  '> 🟩 **SEED-WRITE: no**',
  '> 💰 **Cost forecast:** $0',
  '',
  '**Status:** 📋 READY — opened 2026-07-21.',
  '',
  '# 1000-Other-foo',
  '',
  '## Scope',
  '',
  '1. Extend the gate at `.husky/pre-push:1452`.',
  '',
].join('\n');

const makeHuskyDirRepo = isolatedRepoFactory({
  prefix: 'stampcloudhuskydir',
  basename: '1000-Other-foo.md',
  body: HUSKY_DIR_BODY,
  tools: { stampCloudExec: 'stamp-cloud-exec.mjs' },
});

test('stamp-cloud-exec: a true stamp on a .husky/-touching plan REFUSES (exit 2), mutates nothing', () => {
  const repo = makeHuskyDirRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'true'], repo.stampCloudExec);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    const out = `${res.stderr}${res.stdout}`;
    assert.match(out, /REFUSING cloudExec: true/);
    assert.match(out, /\.husky\/pre-push:1452/); // names the matched line
    assert.match(out, /--husky-ok/); // points at the escape hatch
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.doesNotMatch(body, /cloudExec/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: --husky-ok overrides the .husky/ gate and records the justification banner', () => {
  const repo = makeHuskyDirRepo();
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'true', '--husky-ok', 'prose mention only; the work is scripts/'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: true$/m);
    assert.match(
      body,
      /^> ☁️ \*\*cloudExec: true — `\.husky\/` gate overridden\*\* — prose mention only; the work is scripts\/$/m,
    );
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: a FALSE stamp is never gated, even on a .husky/-touching plan', () => {
  const repo = makeHuskyDirRepo();
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'false', '--reason', 'writes a shared git hook under .husky/, local lane only'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: false$/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: --husky-ok alongside a false stamp REFUSES (exit 2)', () => {
  const repo = makeHuskyDirRepo();
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'false', '--reason', 'x', '--husky-ok', 'y'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /--husky-ok is only legal alongside a `true` stamp/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: a plan naming BOTH gated dirs needs BOTH overrides, records one combined banner', () => {
  const bothBody = [
    '---',
    'summary: Test plan naming both gated dirs',
    'seedWrite: false',
    '---',
    '',
    '> 🟩 **SEED-WRITE: no**',
    '> 💰 **Cost forecast:** $0',
    '',
    '# 1000-Other-foo',
    '',
    '## Scope',
    '',
    '1. Extend `.claude/hooks/guard.mjs`.',
    '2. Extend `.husky/pre-push:1452`.',
    '',
  ].join('\n');
  const repo = isolatedRepoFactory({
    prefix: 'stampcloudbothdir',
    basename: '1000-Other-foo.md',
    body: bothBody,
    tools: { stampCloudExec: 'stamp-cloud-exec.mjs' },
  })();
  try {
    // Only overriding one gate still refuses on the other.
    let res = runStamp(
      repo.dir,
      ['1000', 'true', '--claude-dir-ok', 'claude reason'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /\.husky\/pre-push:1452/);

    res = runStamp(
      repo.dir,
      ['1000', 'true', '--claude-dir-ok', 'claude reason', '--husky-ok', 'husky reason'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: true$/m);
    assert.match(body, /`\.claude\/` \+ `\.husky\/` gates overridden/);
    assert.match(body, /claude reason/);
    assert.match(body, /husky reason/);
  } finally {
    repo.cleanup();
  }
});

// plan 2216: the preflight now parses the body ONCE (scanGatedPaths) and tests every
// registered class against that single pass, instead of one full-document scan per class.
// A body naming both gated dirs, with NEITHER override flag supplied, must still refuse on
// exactly the first-registered class (`.claude/`) — same outcome as the old two-independent-
// scans code, proving the shared-parse refactor didn't change which gate wins.
test('stamp-cloud-exec: a plan naming BOTH gated dirs with no overrides refuses on the first-registered gate', () => {
  const bothBody = [
    '---',
    'summary: Test plan naming both gated dirs, no overrides',
    'seedWrite: false',
    '---',
    '',
    '> 🟩 **SEED-WRITE: no**',
    '> 💰 **Cost forecast:** $0',
    '',
    '# 1000-Other-foo',
    '',
    '## Scope',
    '',
    '1. Extend `.claude/hooks/guard.mjs`.',
    '2. Extend `.husky/pre-push:1452`.',
    '',
  ].join('\n');
  const repo = isolatedRepoFactory({
    prefix: 'stampcloudbothdirnoov',
    basename: '1000-Other-foo.md',
    body: bothBody,
    tools: { stampCloudExec: 'stamp-cloud-exec.mjs' },
  })();
  try {
    const res = runStamp(repo.dir, ['1000', 'true'], repo.stampCloudExec);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    const out = `${res.stderr}${res.stdout}`;
    assert.match(out, /REFUSING cloudExec: true/);
    assert.match(out, /\.claude\/hooks\/guard\.mjs/); // the first-registered gate names its hit
    assert.doesNotMatch(out, /\.husky\/pre-push:1452/); // the husky gate is never even reported
  } finally {
    repo.cleanup();
  }
});

// ─────────────────────────── plan 2313: --env webkit + the extended anti-downgrade guard ───────────────────────────

test('VALID_CLOUD_ENV: webkit is a legal value, slotted between full and browser on the ladder', () => {
  assert.deepEqual(VALID_CLOUD_ENV, ['trusted', 'full', 'webkit', 'browser']);
});

// ─────────────────────────── plan 2323: the CLOUD_ENV_RUNGS ladder table ───────────────────────────

test('CLOUD_ENV_RUNGS: queue-drain.mjs’s ported-verbatim mirror stays deeply identical to this file’s authoritative table', () => {
  assert.deepEqual(QUEUE_DRAIN_CLOUD_ENV_RUNGS, CLOUD_ENV_RUNGS);
});

test('assertNoBrowserDowngrade: throws (fatal) when the body already has cloudEnv: browser and newEnv is webkit — a WebKit lane cannot run a pixel-acceptance plan', () => {
  const body = '---\nsummary: x\ncloudEnv: browser\n---\n\n# T\n';
  assert.throws(
    () => assertNoBrowserDowngrade(body, 'webkit'),
    (e) => e.fatal === true && /refusing to restamp cloudEnv: browser → webkit/.test(e.message),
  );
});

test('assertNoBrowserDowngrade: no-op when the body already has cloudEnv: webkit — webkit→full/trusted is deliberately NOT guarded (full lane admits every non-browser rung)', () => {
  assert.doesNotThrow(() =>
    assertNoBrowserDowngrade('---\nsummary: x\ncloudEnv: webkit\n---\n\n# T\n', 'full'),
  );
  assert.doesNotThrow(() =>
    assertNoBrowserDowngrade('---\nsummary: x\ncloudEnv: webkit\n---\n\n# T\n', 'trusted'),
  );
  assert.doesNotThrow(() =>
    assertNoBrowserDowngrade('---\nsummary: x\ncloudEnv: webkit\n---\n\n# T\n', 'webkit'),
  );
});

test('stamp-cloud-exec: true --env webkit writes cloudEnv: webkit', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'true', '--env', 'webkit'], repo.stampCloudExec);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: true$/m);
    assert.match(body, /^cloudEnv: webkit$/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: restamping cloudEnv: browser → --env webkit REFUSES (exit 2, fatal) and mutates nothing', () => {
  const repo = makeIsolatedRepo();
  try {
    let res = runStamp(repo.dir, ['1000', 'true', '--env', 'browser'], repo.stampCloudExec);
    assert.equal(res.code, 0, `browser stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    res = runStamp(repo.dir, ['1000', 'true', '--env', 'webkit'], repo.stampCloudExec);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /refusing to restamp cloudEnv: browser → webkit/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudEnv: browser$/m); // unchanged
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: restamping cloudEnv: webkit → --env full succeeds — the deliberate non-guard direction', () => {
  const repo = makeIsolatedRepo();
  try {
    let res = runStamp(repo.dir, ['1000', 'true', '--env', 'webkit'], repo.stampCloudExec);
    assert.equal(res.code, 0, `webkit stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    res = runStamp(repo.dir, ['1000', 'true', '--env', 'full'], repo.stampCloudExec);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudEnv: full$/m);
  } finally {
    repo.cleanup();
  }
});

// ───────────────── the cloudRepos axis (plan 2577) ─────────────────
// The extra-repo axis: which repos beyond vetapp a drain must clone. Orthogonal to
// cloudEnv (a hobby-main plan is Trusted-env runnable), hence its own key, its own
// TRUE-only guard, and its own banner slot.

// plan 3958: CLOUD_REPOS is read from THIS checkout's own coord.config.json — cloud-repos-lib.mjs's
// own header comment names the shape the public coord-kit ships: "a config-less repo therefore
// ships with no extra-repo registry at all... parseCloudRepos simply has nothing to validate
// against". The four tests below exercise real, checkout-specific registry data (vetapp's real
// key is 'hobby-main'), so an empty registry has nothing to validate or parse against — skip
// rather than fail, the same posture the module documents for itself.
const [FIRST_VALID_CLOUD_REPO_KEY] = VALID_CLOUD_REPOS;

test('CLOUD_REPOS: every registry row carries the fields all three consumers read', (t) => {
  if (CLOUD_REPOS.length === 0) {
    t.skip('this checkout configures no coord.config.json cloudRepos rows');
    return;
  }
  for (const r of CLOUD_REPOS) {
    for (const f of ['key', 'url', 'dir', 'tokenEnv', 'note']) {
      assert.ok(r[f], `registry row ${r.key} is missing \`${f}\``);
    }
    assert.match(r.key, /^[a-z0-9-]+$/, 'keys are kebab-case frontmatter tokens');
    assert.match(r.url, /^https:\/\//, 'clone URL is HTTPS');
    assert.doesNotMatch(r.url, /@/, 'no credential may ever be embedded in the clone URL');
  }
  assert.equal(
    new Set(VALID_CLOUD_REPOS).size,
    VALID_CLOUD_REPOS.length,
    'registry keys must be unique',
  );
});

test('parseCloudRepos: splits on commas and/or whitespace, lower-cases, dedupes, preserves order', (t) => {
  if (!FIRST_VALID_CLOUD_REPO_KEY) {
    t.skip('this checkout configures no coord.config.json cloudRepos rows');
    return;
  }
  const key = FIRST_VALID_CLOUD_REPO_KEY;
  assert.deepEqual(parseCloudRepos(key), [key]);
  assert.deepEqual(parseCloudRepos(key.toUpperCase()), [key]);
  assert.deepEqual(parseCloudRepos(`${key}, ${key}`), [key]);
  assert.deepEqual(parseCloudRepos(`  ${key}  `), [key]);
});

test('parseCloudRepos: absent/blank ⇒ empty list (the overwhelmingly common case)', () => {
  assert.deepEqual(parseCloudRepos(undefined), []);
  assert.deepEqual(parseCloudRepos(null), []);
  assert.deepEqual(parseCloudRepos(''), []);
  assert.deepEqual(parseCloudRepos('   '), []);
});

test('parseCloudRepos: strict THROWS on an unknown key, non-strict DROPS it', (t) => {
  // The asymmetry is deliberate: a typo at STAMP time must refuse loudly (the plan would
  // otherwise sit stamped-but-unclonable and the drain would skip it forever in silence),
  // while the ORACLE must never let one bad token in one plan body take selection down. Both
  // lines below are portable — 'nope' is unknown in any registry, empty or not.
  assert.throws(() => parseCloudRepos('nope', { strict: true }), /unknown cloudRepos key/);
  assert.deepEqual(parseCloudRepos('nope'), []);
  if (!FIRST_VALID_CLOUD_REPO_KEY) {
    t.skip(
      'this checkout configures no coord.config.json cloudRepos rows — cannot exercise the mixed known+unknown case',
    );
    return;
  }
  assert.deepEqual(parseCloudRepos(`nope, ${FIRST_VALID_CLOUD_REPO_KEY}`), [
    FIRST_VALID_CLOUD_REPO_KEY,
  ]);
});

test('upsertCloudReposBanner: idempotent, and does NOT collide with the cloudExec banner slot', () => {
  const body = [
    '---',
    'stage: specced',
    '---',
    '',
    '> 🟩 **SEED-WRITE: NO**',
    '',
    '> ☁️ **cloudExec: false** — old reason',
    '',
    '## Problem',
  ].join('\n');
  const once = upsertCloudReposBanner(body, ['hobby-main']);
  assert.match(once, /^> 📦 \*\*cloudRepos: hobby-main\*\* —/m);
  // The two slots are independent — an extra-repo plan can also carry a gate-override banner.
  assert.match(once, /^> ☁️ \*\*cloudExec: false\*\* — old reason$/m);
  assert.equal(upsertCloudReposBanner(once, ['hobby-main']), once, 'second upsert must no-op');
  assert.equal(once.match(/cloudRepos:/g).length, 1, 'never duplicated');
});

test('stamp-cloud-exec: true --repos writes the cloudRepos key AND its banner', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'true', '--repos', 'hobby-main'], repo.stampCloudExec);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: true$/m);
    assert.match(body, /^cloudRepos: hobby-main$/m);
    assert.match(body, /^> 📦 \*\*cloudRepos: hobby-main\*\* —/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: --repos alongside a false stamp REFUSES (exit 2), mutates nothing', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'false', '--reason', 'x', '--repos', 'hobby-main'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /--repos is only legal alongside a `true` stamp/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.doesNotMatch(body, /cloudRepos/);
    assert.doesNotMatch(body, /^cloudExec:/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: an unknown --repos key REFUSES (exit 2), mutates nothing', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'true', '--repos', 'bogus'], repo.stampCloudExec);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /unknown cloudRepos key `bogus`/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.doesNotMatch(body, /cloudRepos/);
    assert.doesNotMatch(body, /^cloudExec:/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-cloud-exec: bare stamps leave an existing cloudRepos key untouched (independent axes)', () => {
  // Mirrors the cloudEnv survival test above, same chain shape and same caveat: every step
  // must CHANGE content, because an idempotent same-value restamp has nothing to commit and
  // errors (pre-existing stamp-lib behavior, deliberately not exercised here).
  // true --repos hobby-main → false --reason (bare) → true (bare): the extra-repo routing
  // must survive both, or a cloudExec flip would silently strand the plan un-clonable.
  const repo = makeIsolatedRepo();
  try {
    let res = runStamp(repo.dir, ['1000', 'true', '--repos', 'hobby-main'], repo.stampCloudExec);
    assert.equal(res.code, 0, `repos stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    res = runStamp(
      repo.dir,
      ['1000', 'false', '--reason', 'blocker appeared'],
      repo.stampCloudExec,
    );
    assert.equal(res.code, 0, `false stamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    let body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: false$/m);
    assert.match(body, /^cloudRepos: hobby-main$/m); // routing survived the false stamp
    assert.match(body, /^> 📦 \*\*cloudRepos: hobby-main\*\* —/m); // and so did its banner…
    assert.match(body, /^> ☁️ \*\*cloudExec: false\*\* — blocker appeared$/m); // …beside the other slot
    res = runStamp(repo.dir, ['1000', 'true'], repo.stampCloudExec);
    assert.equal(res.code, 0, `bare restamp failed\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^cloudExec: true$/m);
    assert.match(body, /^cloudRepos: hobby-main$/m); // …and the bare true restamp
    assert.match(body, /^> 📦 \*\*cloudRepos: hobby-main\*\* —/m);
    assert.doesNotMatch(body, /☁️/); // the false banner was stripped, the 📦 one was not
  } finally {
    repo.cleanup();
  }
});

test('scanGatedPaths: a cloudRepos banner is EXEMPT — the tool never refuses by citing its own banner', () => {
  // sonnet-review finding, plan 2577. Only CLOUD_REASON_RX was exempt, so a cloudRepos banner
  // whose text happened to carry a `.claude/`/`.husky/` token made the NEXT plain `true` restamp
  // REFUSE, citing a line this tool wrote itself — the same self-citation bug the cloudExec
  // exemption exists to prevent.
  const withRepoBanner = [
    '---',
    'stage: specced',
    '---',
    '',
    '> 🟩 **SEED-WRITE: NO**',
    '> 📦 **cloudRepos: hobby-main** — clone it; see .claude/settings.json for the token wiring.',
    '',
    '## Problem',
    'Nothing here declares a gated file surface.',
  ].join('\n');
  assert.equal(findClaudeDirReference(withRepoBanner), null);
  // A REAL declaration elsewhere in the body must still be caught — the exemption is scoped to
  // the banner line, it does not blind the scanner.
  assert.ok(findClaudeDirReference(`${withRepoBanner}\n- edit .claude/hooks/foo.mjs\n`));
});

test('upsertBannerBy: a new banner lands AFTER an existing one, so body order tracks stamp chronology', () => {
  // sonnet-review finding, plan 2577: the anchor loop only matched SEED-WRITE/Cost-forecast, so a
  // cloudRepos banner was spliced AHEAD of a cloudExec banner written moments earlier.
  const base = [
    '---',
    'stage: specced',
    '---',
    '',
    '> 🟩 **SEED-WRITE: NO**',
    '',
    '## Problem',
  ].join('\n');
  const withExec = upsertCloudExecReason(base, 'blocked on something');
  const both = upsertCloudReposBanner(withExec, ['hobby-main']);
  const execAt = both.split('\n').findIndex((l) => /\*\*cloudExec:/.test(l));
  const reposAt = both.split('\n').findIndex((l) => /\*\*cloudRepos:/.test(l));
  assert.ok(execAt >= 0 && reposAt >= 0, 'both banners present');
  assert.ok(reposAt > execAt, `cloudRepos (${reposAt}) must follow cloudExec (${execAt})`);
});
