// scripts/coord/review-markers.test.mjs — moved from scripts/done-worktree-lib.test.mjs
// (plan 3959 T2), alongside every function/const it exercises: session-entry resolution, the
// sha-pinned marker family, and the findings-sidecar/disposition machinery.
//
// findingsGate itself (and its wiki/conclusion-marker-delegate siblings) stay tested in
// done-worktree-lib.test.mjs — those are land-spine gates (SEAM-coded), not generic marker
// plumbing, so this file never imports them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePaths, LEGACY_PATHS } from './coord-config.mjs';
// findingsGate itself stays in done-worktree-lib.mjs (land-spine, SEAM-coded) — imported here only
// because a few of the moved buildFindingsRecord tests cross-check its behavior on the built
// record. Legal from a TEST file (Rule 3 binds only non-test scripts/coord/ modules).
import { findingsGate, SEAM } from './done-worktree-lib.mjs';
import {
  checkRecordBranch,
  sameCommitSha,
  REVIEW_METHODS,
  REVIEW_FANOUT_METHODS,
  MARKER_FAMILIES,
  SESSION_BRANCH_LINE_PATTERN,
  normalizeMarkerPatchId,
  markerRegExp,
  parseMarkerAny,
  markerStatusRow,
  markerIdentityMatch,
  parseMarkerCurrent,
  upsertMarker,
  parseReviewMarker,
  parseReviewMarkerAny,
  parseReviewMarkerFull,
  repinDecision,
  upsertReviewMarker,
  buildReviewProvenance,
  findingKey,
  malformedFindingPathText,
  normalizeRounds,
  buildFindingsRecord,
  normalizeDisposition,
  parseFindingsRecord,
  dispositionFinding,
  isMustFixFinding,
  classifyFinding,
  sidecarOwnedBy,
  sidecarOwnerConflict,
  planIdInTree,
  findingsSidecarPath,
  isArchiveSessionPath,
  isSessionEntryPath,
  sessionEntryPathspec,
  sessionEntryAnchor,
  sessionEntryOwnerSlug,
  rankSessionFiles,
  pickSessionFile,
  resolveSessionEntry,
  pickMarkerSourceEntry,
  markerLineOf,
  carryMarkerLine,
  resolveSessionChainOverRefs,
  originFirstCandidates,
  repinMarkerLine,
  isGitPathAbsentError,
  isFsPathAbsentError,
  gitGrepNoMatch,
  markerLineIdentity,
  markerIdentityUnchanged,
  assertSessionEntryOwner,
  sessionEntryOwnerMessage,
  ambiguousSessionEntryMessage,
} from './review-markers.mjs';

// ── shared fixtures (module scope, mirroring done-worktree-lib.test.mjs's own) ──────────────
const SHA = 'abc1234def5678901234567890abcdef12345678';
const PID = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PID2 = 'ffeeddccbbaa99887766554433221100aabbccdd';
const REV = MARKER_FAMILIES.review;
const F1 = {
  file: 'backend/src/a.ts',
  line: 10,
  summary: 'null deref on cold cache',
  verdict: 'CONFIRMED',
  kind: 'correctness',
};
const F2 = {
  file: 'backend/src/b.ts',
  line: 20,
  summary: 'reimplements existing helper',
  verdict: 'PLAUSIBLE',
  kind: 'cleanup',
};

const P2838 = derivePaths('docs/handoff');
const SD = 'docs/handoff/sessions';

// A fake `grep(pattern, pathspec)` over an in-memory {path: content} corpus — the same contract
// the two real callers implement (`git grep -l -F <pattern> <ref> -- <pathspec…>`, '' on no match).
function fakeGrep(corpus) {
  return (pattern, pathspec, mode) => {
    const restrictTo = pathspec.some((s) => s.endsWith('/*.md')) ? null : new Set(pathspec);
    // 'regex' patterns are line-anchored EREs (git grep -E is per LINE, so `^` binds to a line)
    const hit =
      mode === 'regex'
        ? (c) => c.split('\n').some((line) => new RegExp(pattern).test(line))
        : (c) => c.includes(pattern);
    return Object.entries(corpus)
      .filter(([p]) => (restrictTo ? restrictTo.has(p) : true))
      .filter(([, c]) => hit(c))
      .map(([p]) => `HEAD:${p}`)
      .join('\n');
  };
}

// the entry-content reader the real callers back with `git show <ref>:<path>`
const fakeRead = (corpus) => (p) => {
  if (!(p in corpus)) throw new Error(`no such path ${p}`);
  return corpus[p];
};

const entry = (slug, extra = '') =>
  `# session\n\n**Branch:** \`worktree-${slug}\` · worktree \`.claude/worktrees/x\`\n${extra}`;

test('checkRecordBranch: ok when on the slug branch', () => {
  assert.deepEqual(checkRecordBranch('worktree-foo-plan', 'foo-plan'), { ok: true });
});

test('checkRecordBranch: refuses from master (the from-MAIN footgun) naming the expected branch', () => {
  const r = checkRecordBranch('master', 'foo-plan', 'record-review');
  assert.equal(r.ok, false);
  assert.match(r.message, /^record-review:/);
  assert.match(r.message, /worktree-foo-plan/);
});

test('checkRecordBranch: refuses on a DIFFERENT worktree branch', () => {
  assert.equal(checkRecordBranch('worktree-bar-plan', 'foo-plan').ok, false);
});

test('checkRecordBranch: detached HEAD gets an accurate (not "cd in") message', () => {
  const r = checkRecordBranch('HEAD', 'foo-plan', 'record-wiki');
  assert.equal(r.ok, false);
  assert.match(r.message, /^record-wiki:/);
  assert.match(r.message, /detached HEAD/);
});

test('checkRecordBranch: tool name defaults to "record"', () => {
  assert.match(checkRecordBranch('master', 'foo').message, /^record:/);
});

test('parseReviewMarker: PASS @ matching sha → PASS', () => {
  assert.equal(parseReviewMarker(`work\n**Review:** clean. Review: PASS @ ${SHA}\n`, SHA), 'PASS');
});

test('parseReviewMarker: NITS @ matching sha → NITS', () => {
  assert.equal(parseReviewMarker(`Review: NITS @ ${SHA}`, SHA), 'NITS');
});

test('parseReviewMarker: BUGS-FOUND @ matching sha → BUGS-FOUND', () => {
  assert.equal(parseReviewMarker(`Review: BUGS-FOUND @ ${SHA}`, SHA), 'BUGS-FOUND');
});

test('parseReviewMarker: short (7-char) marker sha is a prefix of full HEAD → honored', () => {
  assert.equal(parseReviewMarker(`Review: PASS @ ${SHA.slice(0, 7)}`, SHA), 'PASS');
});

test('parseReviewMarker: stale sha (different commit) → null (re-review)', () => {
  assert.equal(parseReviewMarker(`Review: PASS @ ${SHA}`, 'f00ba12' + SHA.slice(7)), null);
});

test('parseReviewMarker: no marker in text → null', () => {
  assert.equal(parseReviewMarker('just a normal handoff entry, no verdict', SHA), null);
});

test('parseReviewMarker: bare marker with no @sha → null (cannot verify freshness)', () => {
  assert.equal(parseReviewMarker('Review: PASS — looks good', SHA), null);
});

test('parseReviewMarker: multiple markers → the LAST (most recent) wins', () => {
  const old = 'dead' + SHA.slice(4);
  const txt = `Review: BUGS-FOUND @ ${old}\n...later, fixed...\nReview: PASS @ ${SHA}\n`;
  assert.equal(parseReviewMarker(txt, SHA), 'PASS');
});

test('parseReviewMarker: missing text or currentSha → null', () => {
  assert.equal(parseReviewMarker('', SHA), null);
  assert.equal(parseReviewMarker(`Review: PASS @ ${SHA}`, ''), null);
});

test('upsertReviewMarker: appends a marker when none exists; parseReviewMarker round-trips it', () => {
  const out = upsertReviewMarker('# session entry\n\nWhat shipped.\n', 'PASS', SHA);
  assert.match(out, new RegExp(`Review: PASS @ ${SHA}`));
  assert.equal(parseReviewMarker(out, SHA), 'PASS');
});

test('upsertReviewMarker: replaces a stale marker (idempotent — exactly one marker remains)', () => {
  const stale = `entry\nReview: PASS @ ${'0'.repeat(40)}\n`;
  const out = upsertReviewMarker(stale, 'NITS', SHA);
  assert.equal((out.match(/Review:\s*(?:PASS|NITS|BUGS-FOUND)\s*@/g) || []).length, 1);
  assert.equal(parseReviewMarker(out, SHA), 'NITS');
});

test('upsertReviewMarker: running twice is idempotent (still one marker)', () => {
  const once = upsertReviewMarker('entry\n', 'PASS', SHA);
  const twice = upsertReviewMarker(once, 'PASS', SHA);
  assert.equal((twice.match(/Review:\s*(?:PASS|NITS|BUGS-FOUND)\s*@/g) || []).length, 1);
});

test('upsertReviewMarker: leaves a prose **Review:** line (no @sha) untouched', () => {
  const prose = '**Review:** clean, looks good\n';
  const out = upsertReviewMarker(prose, 'PASS', SHA);
  assert.match(out, /\*\*Review:\*\* clean, looks good/);
  assert.equal(parseReviewMarker(out, SHA), 'PASS');
});

test('buildReviewProvenance: method + counts → compact token', () => {
  assert.equal(
    buildReviewProvenance({ method: 'sonnet-review', finders: 6, verifiers: 4, adjudicated: 1 }),
    'sonnet-review f=6 v=4 adj=1',
  );
});

test('buildReviewProvenance: substitute / self-read carry the bare method token', () => {
  assert.equal(buildReviewProvenance({ method: 'substitute' }), 'substitute');
  assert.equal(buildReviewProvenance({ method: 'self-read' }), 'self-read');
});

test('buildReviewProvenance: counts are DROPPED for a non-fan-out method (review [1])', () => {
  // a stale --review-stats attached to substitute must not forge a `substitute f=6 …` token
  assert.equal(
    buildReviewProvenance({ method: 'substitute', finders: 6, verifiers: 4, adjudicated: 1 }),
    'substitute',
  );
  assert.equal(buildReviewProvenance({ method: 'self-read', finders: 3 }), 'self-read');
});

test('buildReviewProvenance: no method → empty (provenance undeclared)', () => {
  assert.equal(buildReviewProvenance({}), '');
  assert.equal(buildReviewProvenance(), '');
});

test('buildReviewProvenance: null/empty/negative/non-integer counts are DROPPED, not coerced to 0 (review [0]/[3])', () => {
  // null / '' must NOT become adj=0 (a coerced 0 would falsely certify zero adjudications)
  assert.equal(
    buildReviewProvenance({ method: 'sonnet-review', adjudicated: null }),
    'sonnet-review',
  );
  assert.equal(
    buildReviewProvenance({ method: 'sonnet-review', adjudicated: '' }),
    'sonnet-review',
  );
  assert.equal(buildReviewProvenance({ method: 'sonnet-review', verifiers: -1 }), 'sonnet-review');
  // non-integer dropped (parseReviewProvenance's `\d+` couldn't read it back → keep marker in sync)
  assert.equal(buildReviewProvenance({ method: 'sonnet-review', finders: 6.5 }), 'sonnet-review');
  assert.equal(buildReviewProvenance({ method: 'sonnet-review', finders: '6.5' }), 'sonnet-review');
  // a genuine 0 (integer) IS emitted — 0 finders is a real, declarable count
  assert.equal(
    buildReviewProvenance({ method: 'sonnet-review', adjudicated: 0 }),
    'sonnet-review adj=0',
  );
  // integer-valued strings from the CLI still coerce
  assert.equal(buildReviewProvenance({ method: 'code-review', finders: '5' }), 'code-review f=5');
});

test('upsertReviewMarker: threads provenance detail; round-trips via parseReviewMarkerFull', () => {
  const detail = 'sonnet-review f=6 v=4 adj=1';
  const out = upsertReviewMarker('# entry\n', 'PASS', SHA, detail);
  assert.match(
    out,
    new RegExp(`Review: PASS:${detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} @ ${SHA}`),
  );
  // bare-verdict parse is unchanged; the full parse surfaces the provenance
  assert.equal(parseReviewMarker(out, SHA), 'PASS');
  // plan 2743: `patchId` is always on the parse result — null for a sha-only marker.
  assert.deepEqual(parseReviewMarkerFull(out, SHA), {
    verdict: 'PASS',
    detail,
    sha: SHA,
    patchId: null,
  });
});

test('upsertReviewMarker: re-record replaces marker AND its provenance (one marker remains)', () => {
  const first = upsertReviewMarker('entry\n', 'PASS', SHA, 'substitute');
  const second = upsertReviewMarker(first, 'PASS', SHA, 'sonnet-review f=6 v=4 adj=1');
  assert.equal((second.match(/Review:\s*(?:PASS|NITS|BUGS-FOUND)/g) || []).length, 1);
  assert.equal(parseReviewMarkerFull(second, SHA).detail, 'sonnet-review f=6 v=4 adj=1');
});

test('parseReviewMarkerFull: honors the staleness guard (stale sha → null)', () => {
  const out = upsertReviewMarker('entry\n', 'PASS', SHA, 'substitute');
  assert.equal(parseReviewMarkerFull(out, 'f00ba12' + SHA.slice(7)), null);
});

test('markerStatusRow: review with provenance shows it; without → "provenance undeclared"', () => {
  const fam = MARKER_FAMILIES.review;
  const withProv = { verdict: 'PASS', detail: 'sonnet-review f=6 v=4 adj=1', sha: SHA };
  assert.match(markerStatusRow(fam, withProv, SHA), /PASS \(sonnet-review f=6 v=4 adj=1\) @/);
  const undeclared = { verdict: 'PASS', detail: '', sha: SHA };
  assert.match(markerStatusRow(fam, undeclared, SHA), /PASS \(provenance undeclared\) @/);
});

test('markerStatusRow: legacy provenance-less review marker reads as undeclared, not fresh-blank', () => {
  // a marker recorded before plan 2162 parses with detail '' → visibly undeclared
  const legacy = parseReviewMarkerAny(`Review: PASS @ ${SHA}\n`);
  assert.equal(legacy.detail, '');
  assert.match(markerStatusRow(MARKER_FAMILIES.review, legacy, SHA), /provenance undeclared/);
});

test('findingKey: stable + sensitive to file/line/summary', () => {
  const k = findingKey(F1.file, F1.line, F1.summary);
  assert.equal(k, findingKey(F1.file, F1.line, F1.summary)); // deterministic
  assert.notEqual(k, findingKey(F1.file, 11, F1.summary)); // line matters
  assert.notEqual(k, findingKey('other.ts', F1.line, F1.summary)); // file matters
  assert.notEqual(k, findingKey(F1.file, F1.line, 'different')); // summary matters
  assert.equal(k, findingKey(F1.file, F1.line, '  ' + F1.summary + '  ')); // summary trimmed
});

test('buildFindingsRecord: rounds defaults to 1 when omitted; stamps whatever integer it is given', () => {
  assert.equal(buildFindingsRecord('NITS', SHA, [F1]).rounds, 1);
  assert.equal(buildFindingsRecord('NITS', SHA, [F1], null, { rounds: 3 }).rounds, 3);
  // non-integer input is NOT trusted either — same "absent ⇒ 1" fallback as a missing value.
  assert.equal(buildFindingsRecord('NITS', SHA, [F1], null, { rounds: 2.5 }).rounds, 1);
  assert.equal(buildFindingsRecord('NITS', SHA, [F1], null, { rounds: 'nope' }).rounds, 1);
  // gpt-review [5]/[8]/[9]: the counter's domain is the POSITIVE integers — round 1 is the
  // initial review. A zero or negative from a corrupt/hand-edited sidecar is out of domain and
  // falls back to 1, so it can never suppress the cap warning by counting downward.
  assert.equal(buildFindingsRecord('NITS', SHA, [F1], null, { rounds: 0 }).rounds, 1);
  assert.equal(buildFindingsRecord('NITS', SHA, [F1], null, { rounds: -7 }).rounds, 1);
});

test('normalizeRounds: the one coercion — positive integers pass, everything else floors to 1', () => {
  assert.equal(normalizeRounds(1), 1);
  assert.equal(normalizeRounds(9), 9);
  // Number.MAX_SAFE_INTEGER + 1 is an `isInteger` that can no longer be incremented, so it
  // would freeze the counter below the cap forever — out of domain, same as a negative.
  for (const bad of [0, -1, -7, 2.5, '3', null, undefined, NaN, Infinity, {}, [], 2 ** 53]) {
    assert.equal(normalizeRounds(bad), 1, `${String(bad)} should floor to 1`);
  }
});

test('parseFindingsRecord: rounds absent (legacy) or non-integer parses as 1, never throws', () => {
  assert.equal(parseFindingsRecord(JSON.stringify({ sha: SHA, findings: [] })).rounds, 1);
  assert.equal(
    parseFindingsRecord(JSON.stringify({ sha: SHA, findings: [], rounds: 4 })).rounds,
    4,
  );
  assert.equal(
    parseFindingsRecord(JSON.stringify({ sha: SHA, findings: [], rounds: 'four' })).rounds,
    1,
  );
  assert.equal(
    parseFindingsRecord(JSON.stringify({ sha: SHA, findings: [], rounds: 2.7 })).rounds,
    1,
  );
});

test('buildFindingsRecord: keys, defaults undispositioned, preserves malformed, dedups', () => {
  const rec = buildFindingsRecord('NITS', SHA, [F1, F2, { file: '', summary: 'no file' }, F1]);
  assert.equal(rec.sha, SHA);
  assert.equal(rec.verdict, 'NITS');
  assert.equal(rec.findings.length, 3); // malformed survives, dup F1 collapses
  assert.equal(rec.findings[0].disposition, null);
  assert.equal(rec.findings[0].key, findingKey(F1.file, F1.line, F1.summary));
  assert.equal(rec.findings[0].kind, 'correctness');
  assert.deepEqual(rec.findings[2], {
    key: null,
    file: '',
    line: null,
    summary: 'Malformed finding entry at index 2: expected non-empty file and summary',
    disposition: null,
  });
});

test('buildFindingsRecord: malformed current findings survive for the gate to block', () => {
  const malformed = { file: '', summary: 'no file' };
  const rec = buildFindingsRecord('NITS', SHA, [F1, malformed]);

  assert.deepEqual(rec.findings[1], {
    key: null,
    file: '',
    line: null,
    summary: 'Malformed finding entry at index 1: expected non-empty file and summary',
    disposition: null,
  });
  const s = findingsGate('NITS', rec, SHA);
  assert.equal(s.code, SEAM.FINDINGS_OPEN);
  assert.deepEqual(s.payload.malformed, [1]);
});

test('buildFindingsRecord: malformed non-object findings become undispositionable placeholders', () => {
  const rec = buildFindingsRecord('NITS', SHA, [null, F1]);

  assert.deepEqual(rec.findings[0], {
    key: null,
    file: '',
    line: null,
    summary: 'Malformed finding entry at index 0: expected non-empty file and summary',
    disposition: null,
  });
  assert.doesNotThrow(() => rec.findings.filter((finding) => finding.preExisting));
  assert.equal(dispositionFinding(rec, 'null', { type: 'fixed' }).found, false);
  const s = findingsGate('NITS', rec, SHA);
  assert.equal(s.code, SEAM.FINDINGS_OPEN);
  assert.deepEqual(s.payload.malformed, [0]);
  assert.doesNotMatch(s.reason, /\[undefined\]/);
});

test('buildFindingsRecord: honors a pre-set valid disposition; drops an invalid one', () => {
  const rec = buildFindingsRecord('NITS', SHA, [
    { ...F1, disposition: { type: 'fixed' } },
    { ...F2, disposition: { type: 'bogus' } },
  ]);
  assert.deepEqual(rec.findings[0].disposition, { type: 'fixed' });
  assert.equal(rec.findings[1].disposition, null);
});

test('normalizeDisposition: plan requires planId, wontfix requires reason, fixed bare', () => {
  assert.deepEqual(normalizeDisposition({ type: 'plan', planId: '1234' }), {
    type: 'plan',
    planId: '1234',
  });
  assert.equal(normalizeDisposition({ type: 'plan' }), null); // no planId
  assert.deepEqual(normalizeDisposition({ type: 'wontfix', reason: 'low value' }), {
    type: 'wontfix',
    reason: 'low value',
  });
  assert.equal(normalizeDisposition({ type: 'wontfix' }), null); // no reason
  assert.equal(normalizeDisposition({ type: 'wontfix', reason: '  ' }), null); // blank reason
  assert.deepEqual(normalizeDisposition({ type: 'fixed' }), { type: 'fixed' });
  assert.equal(normalizeDisposition(null), null);
  assert.equal(normalizeDisposition({ type: 'nope' }), null);
});

test('normalizeDisposition: deferred-by-tag keeps both tags and its reason', () => {
  assert.deepEqual(
    normalizeDisposition({
      type: 'deferred-by-tag',
      preExisting: true,
      blocksLand: false,
      reason: 'preExisting=true: unchanged line; blocksLand=false: warning only',
    }),
    {
      type: 'deferred-by-tag',
      preExisting: true,
      blocksLand: false,
      reason: 'preExisting=true: unchanged line; blocksLand=false: warning only',
    },
  );
});

test('plan 2942: normalizeDisposition keeps a STRING observed pointer and drops every non-string', () => {
  assert.deepEqual(normalizeDisposition({ type: 'plan', planId: '2951', observed: 'wave-B b2' }), {
    type: 'plan',
    planId: '2951',
    observed: 'wave-B b2',
  });
  // Trimmed, and a blank pointer is no pointer.
  assert.deepEqual(normalizeDisposition({ type: 'plan', planId: '2951', observed: '  x  ' }), {
    type: 'plan',
    planId: '2951',
    observed: 'x',
  });
  assert.deepEqual(normalizeDisposition({ type: 'plan', planId: '2951', observed: '   ' }), {
    type: 'plan',
    planId: '2951',
  });
  // A non-string from a hand-edited/corrupt sidecar must DEGRADE to "no pointer" (which warns),
  // never coerce to a truthy one — `String(false)` was the pointer "false", `String({})` was
  // "[object Object]", and either silently certified a latent deferral as observed.
  for (const bad of [false, true, 0, 1, 123, {}, { source: 'live' }, ['wave-B'], null])
    assert.deepEqual(
      normalizeDisposition({ type: 'plan', planId: '2951', observed: bad }),
      { type: 'plan', planId: '2951' },
      `observed:${JSON.stringify(bad)} must not survive as a pointer`,
    );
  // planId itself stays BARE — planIdInTree matches it as a plan-tree filename prefix, so a
  // bracketed id would classify every observed deferral 'dangling' and halt the land.
  assert.equal(
    normalizeDisposition({ type: 'plan', planId: '2951', observed: 'wave-B' }).planId,
    '2951',
  );
});

test('parseFindingsRecord: round-trips a built record; null on garbage/shape', () => {
  const rec = buildFindingsRecord('NITS', SHA, [F1]);
  assert.deepEqual(parseFindingsRecord(JSON.stringify(rec)), rec);
  assert.equal(parseFindingsRecord('not json'), null);
  assert.equal(parseFindingsRecord(JSON.stringify({ sha: SHA })), null); // no findings array
  assert.equal(parseFindingsRecord(''), null);
});

test('dispositionFinding: sets one by key; found=false for unknown key', () => {
  const rec = buildFindingsRecord('NITS', SHA, [F1, F2]);
  const k = rec.findings[0].key;
  const { record, found } = dispositionFinding(rec, k, { type: 'plan', planId: '1300' });
  assert.equal(found, true);
  assert.deepEqual(record.findings[0].disposition, { type: 'plan', planId: '1300' });
  assert.equal(record.findings[1].disposition, null); // untouched
  assert.equal(dispositionFinding(rec, 'nope', { type: 'fixed' }).found, false);
});

test('isMustFixFinding: UNVERIFIED fails closed while explicit weak/refuted verdicts do not', () => {
  const tags = {
    preExisting: false,
    preExistingWhy: 'inside the reviewed plus side',
    blocksLand: true,
    blocksLandWhy: 'wrong target-surface output',
  };
  assert.equal(isMustFixFinding({ ...tags, verdict: 'UNVERIFIED' }), true);
  assert.equal(isMustFixFinding({ ...tags, verdict: 'PLAUSIBLE' }), false);
  assert.equal(isMustFixFinding({ ...tags, verdict: 'REFUTED' }), false);
});

test('isMustFixFinding: plan 3623 item 2 — an unsettled verdict fails closed on the TAG axis too', () => {
  // The Luna-REFUTED-then-Sol-failed path: the finder's own advisory tags survive
  // classifyRound2 downgrading the verdict to UNVERIFIED, but no adjudicator ever confirmed
  // them — must-fix regardless of what the tags say.
  const advisoryTags = {
    preExisting: true,
    preExistingWhy: 'Luna judged this pre-existing before Sol failed to verify',
    blocksLand: false,
    blocksLandWhy: 'Luna judged this advisory before Sol failed to verify',
  };
  assert.equal(isMustFixFinding({ ...advisoryTags, verdict: 'UNVERIFIED' }), true);
  // Absent verdict + advisory tags: still must-fix — no settled judgment exists at all.
  assert.equal(isMustFixFinding({ ...advisoryTags }), true);
  // Unknown/garbage verdict string + advisory tags: same fail-closed treatment as absent.
  assert.equal(isMustFixFinding({ ...advisoryTags, verdict: 'SOMETHING_ELSE' }), true);
  // CONFIRMED is the one settled verdict the tag axis actually decides — unchanged: advisory
  // tags DO clear it.
  assert.equal(isMustFixFinding({ ...advisoryTags, verdict: 'CONFIRMED' }), false);
  // A legacy finding with no verdict AND no tags at all stays must-fix (unchanged: both the
  // unsettled-verdict fail-closed and the tag defaults — blocksLand:true, preExisting:false —
  // agree here).
  assert.equal(isMustFixFinding({}), true);
});

test('buildFindingsRecord: a malformed entry persists the path it claimed', () => {
  const rec = buildFindingsRecord('NITS', SHA, [{ file: 'scripts/written.mjs', summary: '' }]);
  assert.equal(rec.findings[0].malformedFile, 'scripts/written.mjs');
  assert.match(rec.findings[0].summary, /scripts\/written\.mjs/);
  // …and it survives the round trip a real land makes: write, read back, gate.
  const reread = parseFindingsRecord(JSON.stringify(rec));
  assert.equal(reread.findings[0].malformedFile, 'scripts/written.mjs');
  assert.match(findingsGate('NITS', reread, SHA).reason, /scripts\/written\.mjs/);
});

test('malformedFindingPathText: flattens control characters and caps the length', () => {
  assert.equal(malformedFindingPathText('  a\r\n\tb  '), 'a b');
  assert.equal(malformedFindingPathText(undefined), '');
  assert.equal(malformedFindingPathText(42), '');
  const long = malformedFindingPathText('x'.repeat(500));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('...'));
});

test('sameCommitSha: prefix match both ways, ≥7 floor, case-insensitive', () => {
  assert.equal(sameCommitSha(SHA, SHA), true);
  assert.equal(sameCommitSha(SHA.slice(0, 7), SHA), true); // short marker vs full HEAD
  assert.equal(sameCommitSha(SHA, SHA.slice(0, 7)), true); // and vice-versa
  assert.equal(sameCommitSha(SHA.toUpperCase(), SHA), true); // case-insensitive
  assert.equal(sameCommitSha('f00ba12' + SHA.slice(7), SHA), false); // different commit
  assert.equal(sameCommitSha('abc', SHA), false); // < 7 floor
  assert.equal(sameCommitSha('', SHA), false);
  assert.equal(sameCommitSha(null, SHA), false);
});

test('planIdInTree: basename-prefix match, ignores partial-id collisions', () => {
  const tree =
    'docs/superpowers/plans/in-progress/1205-Other-foo.md\ndocs/superpowers/plans/archive/77-Fix-bar.md';
  assert.equal(planIdInTree(tree, '1205'), true);
  assert.equal(planIdInTree(tree, '77'), true);
  assert.equal(planIdInTree(tree, '120'), false); // 120 must not match 1205-… (prefix is "1205-")
  assert.equal(planIdInTree(tree, '7'), false); // 7 must not match 77-…
  assert.equal(planIdInTree(tree, '9999'), false);
  assert.equal(planIdInTree('', '1205'), false);
  assert.equal(planIdInTree(tree, ''), false);
});

test('findingsSidecarPath: derives the .findings.json sibling of the session entry', () => {
  assert.equal(
    findingsSidecarPath('docs/handoff/sessions/2026-06-30-session-1.md'),
    'docs/handoff/sessions/2026-06-30-session-1.findings.json',
  );
});

test('buildFindingsRecord: prior-merge carries forward a disposition for an OMITTED field at same sha', () => {
  const prior = buildFindingsRecord('NITS', SHA, [{ ...F1, disposition: { type: 'fixed' } }, F2]);
  // re-record the same findings (no disposition field — the /sonnet-review export shape)
  const next = buildFindingsRecord('NITS', SHA, [F1, F2], prior);
  assert.deepEqual(next.findings[0].disposition, { type: 'fixed' }, 'prior fixed carried forward');
  assert.equal(next.findings[1].disposition, null, 'still-open stays open');
});

test('buildFindingsRecord: a malformed prior sibling is skipped without discarding valid carry-forward', () => {
  const prior = buildFindingsRecord('NITS', SHA, [{ ...F1, disposition: { type: 'fixed' } }]);
  prior.findings.push(null, 'broken entry');
  let next;
  assert.doesNotThrow(() => {
    next = buildFindingsRecord('NITS', SHA, [F1], prior);
  });
  assert.deepEqual(
    next.findings[0].disposition,
    { type: 'fixed' },
    'the valid sibling still carries forward',
  );
});

test('buildFindingsRecord: an EXPLICIT null disposition reopens (wins over the prior-merge)', () => {
  const prior = buildFindingsRecord('NITS', SHA, [
    { ...F1, disposition: { type: 'wontfix', reason: 'x' } },
  ]);
  const next = buildFindingsRecord('NITS', SHA, [{ ...F1, disposition: null }], prior);
  assert.equal(
    next.findings[0].disposition,
    null,
    'explicit null reopens, not restored from prior',
  );
});

test('buildFindingsRecord: a STALE prior (different sha) is ignored — no merge', () => {
  const prior = buildFindingsRecord('NITS', '0'.repeat(40), [
    { ...F1, disposition: { type: 'fixed' } },
  ]);
  const next = buildFindingsRecord('NITS', SHA, [F1], prior);
  assert.equal(
    next.findings[0].disposition,
    null,
    'stale prior does not leak a disposition forward',
  );
});

test('buildFindingsRecord: carryAcrossSha merges a prior at a DIFFERENT sha by finding key', () => {
  const prior = buildFindingsRecord('NITS', '0'.repeat(40), [
    { ...F1, disposition: { type: 'fixed' } },
    F2,
  ]);
  const next = buildFindingsRecord('NITS', SHA, [F1, F2], prior, { carryAcrossSha: true });
  assert.equal(next.sha, SHA, 'record is pinned to the NEW sha');
  assert.deepEqual(
    next.findings[0].disposition,
    { type: 'fixed' },
    'disposition carried across the sha bump (findingKey is sha-independent)',
  );
  assert.equal(next.findings[1].disposition, null, 'still-open stays open');
});

test('buildFindingsRecord: carryAcrossSha — explicit disposition still wins; vanished/new keys behave as today', () => {
  const prior = buildFindingsRecord('NITS', '0'.repeat(40), [
    { ...F1, disposition: { type: 'wontfix', reason: 'x' } },
    { ...F2, disposition: { type: 'fixed' } },
  ]);
  const fresh = { file: 'backend/src/c.ts', line: 30, summary: 'new finding this round' };
  // F2 vanished from the incoming set; F1 arrives with an EXPLICIT null (reopen); one new key.
  const next = buildFindingsRecord('NITS', SHA, [{ ...F1, disposition: null }, fresh], prior, {
    carryAcrossSha: true,
  });
  assert.equal(next.findings.length, 2, 'vanished prior key drops, not resurrected by the carry');
  assert.equal(next.findings[0].disposition, null, 'explicit null reopens — wins over the carry');
  assert.equal(next.findings[1].disposition, null, 'a new key starts undispositioned');
});

test('classifyFinding: ok / open / dangling', () => {
  assert.equal(classifyFinding({ disposition: { type: 'fixed' } }), 'ok');
  assert.equal(
    classifyFinding({ disposition: { type: 'plan', planId: '1' } }, (id) => id === '1'),
    'ok',
  );
  assert.equal(classifyFinding({ disposition: null }), 'open');
  assert.equal(classifyFinding({ disposition: { type: 'wontfix' } }), 'open'); // no reason → malformed
  assert.equal(
    classifyFinding({ disposition: { type: 'plan', planId: '9' } }, () => false),
    'dangling',
  );
  assert.equal(classifyFinding({ disposition: { type: 'plan', planId: '9' } }), 'dangling'); // default fail-closed
});

test('plan 642: pickSessionFile drops handoff/sessions/archive/ even when it sorts last lexically', () => {
  // git grep returns paths sorted; archive/… sorts AFTER 2026-* → it was hits[last].
  const out = [
    'HEAD:handoff/sessions/2026-06-15-session-555.md',
    'HEAD:handoff/sessions/archive/handoff-pre-205-history.md',
  ].join('\n');
  assert.equal(pickSessionFile(out, LEGACY_PATHS), 'handoff/sessions/2026-06-15-session-555.md');
});

test('plan 642: pickSessionFile returns null when the ONLY hit is the archive', () => {
  assert.equal(
    pickSessionFile('HEAD:handoff/sessions/archive/handoff-pre-205-history.md', LEGACY_PATHS),
    null,
  );
  assert.equal(pickSessionFile('', LEGACY_PATHS), null);
  assert.equal(pickSessionFile(null, LEGACY_PATHS), null);
});

test('plan 642: pickSessionFile picks the most-recent entry by DATE prefix (multi-session plan)', () => {
  const out = [
    'HEAD:handoff/sessions/2026-06-14-session-540.md',
    'HEAD:handoff/sessions/2026-06-16-session-560.md',
    'HEAD:handoff/sessions/2026-06-15-session-555.md',
  ].join('\n');
  assert.equal(pickSessionFile(out, LEGACY_PATHS), 'handoff/sessions/2026-06-16-session-560.md');
});

test('plan 642: pickSessionFile breaks a same-day tie by NUMERIC session number (not lexical)', () => {
  // lexical-last would pick session-9 (since "9" > "100"); numeric must pick session-100.
  const out = [
    'HEAD:handoff/sessions/2026-06-15-session-9.md',
    'HEAD:handoff/sessions/2026-06-15-session-100.md',
  ].join('\n');
  assert.equal(pickSessionFile(out, LEGACY_PATHS), 'handoff/sessions/2026-06-15-session-100.md');
});

test('plan 642: pickSessionFile strips the HEAD: prefix and ignores blank lines', () => {
  assert.equal(
    pickSessionFile('\nHEAD:handoff/sessions/2026-06-15-session-569.md\n', LEGACY_PATHS),
    'handoff/sessions/2026-06-15-session-569.md',
  );
});

test('plan 642: isArchiveSessionPath backs the flipSessionCompleted write guard', () => {
  // The close-out write guard throws iff this predicate is true.
  assert.equal(
    isArchiveSessionPath('handoff/sessions/archive/handoff-pre-205-history.md', LEGACY_PATHS),
    true,
  );
  assert.equal(
    isArchiveSessionPath('HEAD:handoff/sessions/archive/anything.md', LEGACY_PATHS),
    true,
  );
  assert.equal(
    isArchiveSessionPath('handoff/sessions/2026-06-15-session-569.md', LEGACY_PATHS),
    false,
  );
  assert.equal(isArchiveSessionPath('handoff.md', LEGACY_PATHS), false);
  assert.equal(isArchiveSessionPath('', LEGACY_PATHS), false);
  assert.equal(isArchiveSessionPath(null, LEGACY_PATHS), false);
});

test('plan 857: isArchiveSessionPath + pickSessionFile honour injected docs/handoff paths', () => {
  const paths = derivePaths('docs/handoff');
  assert.equal(
    isArchiveSessionPath('docs/handoff/sessions/archive/handoff-pre-205-history.md', paths),
    true,
  );
  assert.equal(
    isArchiveSessionPath('docs/handoff/sessions/2026-06-20-session-848.md', paths),
    false,
  );
  const out =
    'HEAD:docs/handoff/sessions/2026-06-20-session-848.md\n' +
    'HEAD:docs/handoff/sessions/archive/handoff-pre-205-history.md';
  assert.equal(pickSessionFile(out, paths), 'docs/handoff/sessions/2026-06-20-session-848.md');
});

test('plan 2838: sessionEntryPathspec restricts the grep to *.md and still excludes the archive', () => {
  assert.deepEqual(sessionEntryPathspec(P2838), [`${SD}/*.md`, `:(exclude)${SD}/archive/`]);
});

test('plan 2838: sessionEntryAnchor is LINE-anchored, closes the backtick, and escapes the slug', () => {
  const rx = new RegExp(sessionEntryAnchor('2838-FABLE-Coord-x'));
  assert.ok(sessionEntryAnchor('x').startsWith(SESSION_BRANCH_LINE_PATTERN));
  assert.ok(rx.test('**Branch:** `worktree-2838-FABLE-Coord-x` · worktree `.claude/worktrees/x`'));
  // the real non-canonical committed form (session 2141) still anchors — the slug may sit
  // anywhere on the Branch line, not only immediately after the label
  assert.ok(
    rx.test('**Branch:** resuming in existing worktree `worktree-2838-FABLE-Coord-x` at C:'),
  );
  // the trailing backtick stops `worktree-<slug>-extra` from anchoring
  assert.ok(!rx.test('**Branch:** `worktree-2838-FABLE-Coord-x-extra`'));
  // LINE anchoring stops prose elsewhere in a sibling entry from counting as ownership
  assert.ok(!rx.test('we quoted **Branch:** `worktree-2838-FABLE-Coord-x` from the sibling'));
  // a `.` in a slug is escaped, not treated as "any character"
  assert.ok(!new RegExp(sessionEntryAnchor('a.c')).test('**Branch:** `worktree-abc`'));
});

test('plan 2838: resolveSessionEntry — the incident shape resolves to the OWNER, not the sibling', () => {
  const corpus = {
    // the older session that actually owns the slug
    [`${SD}/2026-08-04-session-2697.md`]: entry('2808-Pipe-stage7-consensus'),
    // a NEWER sibling whose entry and sidecar both merely QUOTE it
    [`${SD}/2026-08-04-session-2698.md`]: entry('2816-Coord-worktree-lock'),
    [`${SD}/2026-08-04-session-2698.findings.json`]:
      '{"findings":[{"summary":"seen alongside 2808-Pipe-stage7-consensus"}]}',
  };
  const r = resolveSessionEntry(fakeGrep(corpus), '2808-Pipe-stage7-consensus', P2838);
  assert.equal(r.sf, `${SD}/2026-08-04-session-2697.md`);
  assert.equal(r.anchored, true);
  assert.equal(r.ambiguous, false);
});

test('plan 2838: resolveSessionEntry — a re-pickup (many anchored entries) still resolves most-recent, never ambiguous', () => {
  // Deliberate: an anchored hit is a session ASSERTING ownership, and a slug maps to exactly one
  // plan — so N of them is a legitimate multi-session plan (K=3 retry queue / re-pickup), which is
  // precisely what plan 642's most-recent-wins tiebreak exists to serve. Refusing here would wedge
  // every re-pickup land.
  const corpus = {
    [`${SD}/2026-08-01-session-9.md`]: entry('700-Plan-worked-twice'),
    [`${SD}/2026-08-04-session-100.md`]: entry('700-Plan-worked-twice'),
  };
  const r = resolveSessionEntry(fakeGrep(corpus), '700-Plan-worked-twice', P2838);
  assert.equal(r.sf, `${SD}/2026-08-04-session-100.md`);
  assert.equal(r.ambiguous, false);
  assert.equal(r.candidates.length, 2);
});

// ── plan 4021: an adopting session's marker-less claim entry must not shadow the older marker ──
// resolveSessionEntry keeps returning the NEWEST owned entry (it is the write target); the READ of
// one marker family falls back to the newest OLDER owned entry that carries a marker of THAT family.
const W4021 = 'adopt-plan-4021';
const S_OLD = `${SD}/2026-09-14-session-4085.md`;
const S_MID = `${SD}/2026-09-14-session-4090.md`;
const S_NEW = `${SD}/2026-09-14-session-4095.md`;
const REVIEW_LINE = `Review: BUGS-FOUND:sonnet-review f=27 v=12 adj=1 @ ${SHA} patch-id:${PID}`;
const WIKI_LINE = `Wiki: WROTE:wiki/foo.md @ ${SHA}`;
const readAll = (corpus) => (p) => (p in corpus ? [corpus[p]] : []);

test('plan 4021: pickMarkerSourceEntry — a marker-less newest entry falls back to the older entry holding the marker', () => {
  const corpus = { [S_OLD]: entry(W4021, `${REVIEW_LINE}\n`), [S_NEW]: entry(W4021) };
  const src = pickMarkerSourceEntry(REV, W4021, [S_NEW, S_OLD], readAll(corpus));
  assert.equal(src.path, S_OLD);
  assert.equal(src.fallback, true);
  assert.equal(parseMarkerAny(REV, src.contents[0]).verdict, 'BUGS-FOUND');
});

test('plan 4021: pickMarkerSourceEntry — a newest entry carrying a STALE marker still wins (no resurrection)', () => {
  const stale = `Review: PASS @ ${'0'.repeat(40)}`;
  const corpus = { [S_OLD]: entry(W4021, `${REVIEW_LINE}\n`), [S_NEW]: entry(W4021, `${stale}\n`) };
  const src = pickMarkerSourceEntry(REV, W4021, [S_NEW, S_OLD], readAll(corpus));
  assert.equal(src.path, S_NEW);
  assert.equal(src.fallback, false);
});

test('plan 4021: pickMarkerSourceEntry — family-scoped: a Wiki marker never makes an entry the Review source', () => {
  const corpus = {
    [S_OLD]: entry(W4021, `${REVIEW_LINE}\n`),
    [S_MID]: entry(W4021, `${WIKI_LINE}\n`),
    [S_NEW]: entry(W4021),
  };
  const order = [S_NEW, S_MID, S_OLD];
  assert.equal(pickMarkerSourceEntry(REV, W4021, order, readAll(corpus)).path, S_OLD);
  assert.equal(
    pickMarkerSourceEntry(MARKER_FAMILIES.wiki, W4021, order, readAll(corpus)).path,
    S_MID,
  );
  // nothing recorded for the family anywhere → the newest entry, not a fallback
  const none = pickMarkerSourceEntry(MARKER_FAMILIES.conclusion, W4021, order, readAll(corpus));
  assert.equal(none.path, S_NEW);
  assert.equal(none.fallback, false);
});

test('plan 4021: pickMarkerSourceEntry — an older entry whose content names ANOTHER owner halts the walk (never used, never skipped past)', () => {
  const corpus = {
    [S_OLD]: entry(W4021, `${REVIEW_LINE}\n`),
    [S_MID]: entry('someone-else', `${REVIEW_LINE}\n`),
    [S_NEW]: entry(W4021),
  };
  // the mid entry's own Branch line disagrees with the grep that listed it → contested → halt,
  // so the still-older owned marker is NOT resurrected past an entry nobody could attribute
  for (const order of [
    [S_NEW, S_MID, S_OLD],
    [S_NEW, S_MID],
  ]) {
    const src = pickMarkerSourceEntry(REV, W4021, order, readAll(corpus));
    assert.equal(src.path, S_NEW);
    assert.equal(src.fallback, false);
    assert.deepEqual(src.contents, [], 'a halted family supplies no marker');
    assert.deepEqual(src.halted, { reason: 'owner', path: S_MID });
  }
});

test('plan 4021 review 321957: a NEWEST entry copy declaring another slug never supplies a marker, and never enables fallback', () => {
  const foreign = entry('someone-else', `${REVIEW_LINE}\n`);
  const read = (p) =>
    p === S_NEW ? [entry(W4021), foreign] : p === S_OLD ? [entry(W4021, `${REVIEW_LINE}\n`)] : [];
  const src = pickMarkerSourceEntry(REV, W4021, [S_NEW, S_OLD], read);
  assert.equal(src.path, S_NEW);
  assert.equal(src.fallback, false);
  assert.deepEqual(src.contents, [], "the foreign copy's Review marker is not selected");
  assert.deepEqual(src.halted, { reason: 'owner', path: S_NEW });
  // a sole foreign copy that carries the marker is refused the same way
  const alone = pickMarkerSourceEntry(REV, W4021, [S_NEW], () => [foreign]);
  assert.deepEqual(alone.contents, []);
  // LEGACY resolution (no Branch line at all): an owner-less copy still reads, a foreign one does not
  const legacy = `# session\n\nclaim ${W4021}\n${REVIEW_LINE}\n`;
  const ok = pickMarkerSourceEntry(REV, W4021, [S_NEW], () => [legacy], { anchored: false });
  assert.equal(parseMarkerAny(REV, ok.contents[0]).verdict, 'BUGS-FOUND');
  const bad = pickMarkerSourceEntry(REV, W4021, [S_NEW], () => [legacy, foreign], {
    anchored: false,
  });
  assert.deepEqual(bad.contents, []);
});

test('plan 4021 review 0b3b0d: an UNREADABLE entry halts the walk — the newest never falls back, an older one is never skipped past', () => {
  const older = { [S_OLD]: [entry(W4021, `${REVIEW_LINE}\n`)], [S_MID]: [entry(W4021)] };
  const throwsFor = (bad) => (p) => {
    if (p === bad) throw new Error(`EIO ${p}`);
    return p === S_NEW ? [entry(W4021)] : older[p];
  };
  // newest throws
  let src = pickMarkerSourceEntry(REV, W4021, [S_NEW, S_OLD], throwsFor(S_NEW));
  assert.deepEqual(src.contents, []);
  assert.equal(src.fallback, false);
  assert.deepEqual(src.halted, { reason: 'unreadable', path: S_NEW });
  // newest yields no content at all — equally "could not find out"
  src = pickMarkerSourceEntry(REV, W4021, [S_NEW, S_OLD], (p) => (p === S_NEW ? [] : older[p]));
  assert.deepEqual(src.halted, { reason: 'unreadable', path: S_NEW });
  // an older candidate throws BETWEEN the newest and a still-older valid marker
  src = pickMarkerSourceEntry(REV, W4021, [S_NEW, S_MID, S_OLD], throwsFor(S_MID));
  assert.equal(src.fallback, false);
  assert.deepEqual(src.contents, []);
  assert.deepEqual(src.halted, { reason: 'unreadable', path: S_MID });
  // a READABLE marker-less owned middle entry is still skipped (the adoption shape itself)
  src = pickMarkerSourceEntry(REV, W4021, [S_NEW, S_MID, S_OLD], throwsFor(null));
  assert.equal(src.path, S_OLD);
  assert.equal(src.fallback, true);
});

test('plan 4021 review fb94f6: carryMarkerLine copies the last marker line unaltered (round + scope tokens kept) and replaces a same-family line', () => {
  const src = entry(
    W4021,
    `Review: PASS @ ${'1'.repeat(40)}\n${REVIEW_LINE} scope:narrowed review-round:3\nWiki: SKIP:x @ ${SHA}\n`,
  );
  assert.equal(markerLineOf(REV, src), `${REVIEW_LINE} scope:narrowed review-round:3`);
  assert.equal(markerLineOf(REV, entry(W4021)), null);
  const carried = carryMarkerLine(REV, entry(W4021, 'notes\n'), src);
  assert.ok(carried.endsWith(`notes\n${REVIEW_LINE} scope:narrowed review-round:3\n`));
  assert.ok(!carried.includes('Wiki:'), 'family-scoped: the wiki line is not carried');
  assert.equal(parseMarkerAny(REV, carried).verdict, 'BUGS-FOUND');
  const replaced = carryMarkerLine(REV, entry(W4021, `Review: PASS @ ${'2'.repeat(40)}`), src);
  assert.equal((replaced.match(/Review:/g) || []).length, 1);
  assert.equal(carryMarkerLine(REV, entry(W4021), entry(W4021)), null);
});

test('plan 4021: pickMarkerSourceEntry — a newest entry with the marker never reads older entries; empty input is null', () => {
  const read = (p) => {
    if (p !== S_NEW) throw new Error(`older entry ${p} must not be read`);
    return [entry(W4021, `${REVIEW_LINE}\n`)];
  };
  assert.equal(pickMarkerSourceEntry(REV, W4021, [S_NEW, S_OLD], read).path, S_NEW);
  assert.equal(pickMarkerSourceEntry(REV, W4021, [], read), null);
});

// ── plan 4021 review round 2 ─────────────────────────────────────────────────────────────────
// Cluster A: an unreadable or contested anchored candidate must REACH the picker as an explicit
// state, so its halt rules fire; the resolver's WRITE target (`sf`) is unchanged.
const chainFor = (corpus, throwFor = []) =>
  resolveSessionChainOverRefs({
    refs: ['HEAD'],
    slug: W4021,
    paths: P2838,
    tool: 'test',
    report: () => {},
    grepFor: () => fakeGrep(corpus),
    readEntryFor: () => (p) => {
      if (throwFor.includes(p)) throw new Error(`EIO ${p}`);
      return corpus[p];
    },
  });

test('plan 4021 r2 b4b258/71e883/6d93aa: an UNREADABLE newest anchored candidate stays in the chain and halts the marker walk', () => {
  const corpus = { [S_OLD]: entry(W4021, `${REVIEW_LINE}\n`), [S_NEW]: entry(W4021) };
  const chain = chainFor(corpus, [S_NEW]);
  assert.equal(chain.sf, S_OLD, 'the write target is still the newest READABLE owned entry');
  assert.deepEqual(chain.entries, [{ path: S_NEW, halt: 'unreadable' }, S_OLD]);
  const src = pickMarkerSourceEntry(REV, W4021, chain.entries, readAll(corpus));
  assert.deepEqual(src.contents, []);
  assert.deepEqual(src.halted, { reason: 'unreadable', path: S_NEW });
});

test('plan 4021 r2 71e883: a contested (another-owner) candidate OLDER than the write target halts the fallback; a NEWER one is not ours and is skipped', () => {
  const contested = `# s\n\n**Branch:** \`worktree-other\` then \`worktree-${W4021}\`\n${REVIEW_LINE}\n`;
  const older = {
    [S_OLD]: entry(W4021, `${REVIEW_LINE}\n`),
    [S_MID]: contested,
    [S_NEW]: entry(W4021),
  };
  const chain = chainFor(older);
  assert.equal(chain.sf, S_NEW);
  assert.deepEqual(chain.entries, [S_NEW, { path: S_MID, halt: 'owner' }, S_OLD]);
  assert.deepEqual(pickMarkerSourceEntry(REV, W4021, chain.entries, readAll(older)).halted, {
    reason: 'owner',
    path: S_MID,
  });
  // a NEWER `**Branch:** none` prose mention declares no worktree: never ours, never a halt
  const newer = {
    [S_OLD]: entry(W4021, `${REVIEW_LINE}\n`),
    [S_NEW]: `# s\n\n**Branch:** none — reviewed \`worktree-${W4021}\`\n`,
  };
  const c2 = chainFor(newer);
  assert.equal(c2.sf, S_OLD);
  assert.deepEqual(c2.entries, [S_OLD]);
  const src = pickMarkerSourceEntry(REV, W4021, c2.entries, readAll(newer));
  assert.equal(src.path, S_OLD);
  assert.equal(src.fallback, false);
});

test('plan 4021 r2 1b7464/4dbea7/a50dd4: originFirstCandidates skips only a genuine absence; strict mode throws on any other read failure', () => {
  const fail = (message, code) => () => {
    throw Object.assign(new Error(message), code ? { code } : {});
  };
  const ok = (t) => () => t;
  const absent = [
    fail("Command failed: git show\nfatal: path 'x.md' does not exist in 'origin/master'"),
    fail("fatal: path 'x.md' exists on disk, but not in 'origin/master'"),
    fail("fatal: invalid object name 'origin/master'."),
  ];
  assert.deepEqual(originFirstCandidates(ok('o'), ok('w'), { strict: true }), ['o', 'w']);
  // review round 3: a working-tree ENOENT is absence only when the lstat probe finds nothing too
  const nothingThere = fail('lstat', 'ENOENT');
  for (const show of absent)
    assert.deepEqual(
      originFirstCandidates(show, fail('nope', 'ENOENT'), {
        strict: true,
        probeTree: nothingThere,
      }),
      [],
    );
  assert.throws(
    () => originFirstCandidates(fail('fatal: unable to read abc123'), ok('w'), { strict: true }),
    /unable to read/,
  );
  assert.throws(
    () =>
      originFirstCandidates(ok('o'), fail('EISDIR: illegal operation', 'EISDIR'), { strict: true }),
    /EISDIR/,
  );
  // non-strict keeps the historical swallow-everything contract for advisory readers
  assert.deepEqual(originFirstCandidates(fail('fatal: unable to read'), fail('x', 'EACCES')), []);
});

// Cluster D: an explicit `**Branch:** none` is NOT an ownerless legacy entry.
test('plan 4021 r2 bb4455: a legacy resolution never takes a marker from a copy declaring `**Branch:** none`', () => {
  const legacy = `# session\n\nclaim ${W4021}\n${REVIEW_LINE}\n`;
  const none = `# session\n\n**Branch:** none — main checkout\n${REVIEW_LINE}\n`;
  const mixed = pickMarkerSourceEntry(REV, W4021, [S_NEW], () => [legacy, none], {
    anchored: false,
  });
  assert.deepEqual(mixed.contents, []);
  assert.deepEqual(mixed.halted, { reason: 'owner', path: S_NEW });
  const alone = pickMarkerSourceEntry(REV, W4021, [S_NEW], () => [none], { anchored: false });
  assert.deepEqual(alone.contents, []);
});

// Cluster E: one marker grammar for recognising and stripping a line.
test('plan 4021 r2 f4cea5: stripMarkerLines and markerLineOf share ONE grammar, so a carry never duplicates a line', () => {
  const src = entry(W4021, `xReview: NITS @ ${SHA}\n`);
  const carried = carryMarkerLine(REV, src, src);
  assert.equal((carried.match(/Review: NITS/g) || []).length, 1);
});

// Cluster C: a re-pin moves only the sha + patch-id and keeps every trailing token.
test('plan 4021 r2 998229/59ba2e: repinMarkerLine re-pins in place, keeping review-round / scope / past-cap tokens', () => {
  const tail = ' scope-narrowed[excluded=2] review-round:3 past-cap-reason="r"';
  const line = `Review: BUGS-FOUND:gpt-review f=3 @ ${SHA}${tail}`;
  const NEW = 'f'.repeat(40);
  const out = repinMarkerLine(REV, entry(W4021, `${line}\nnotes\n`), NEW, PID2);
  assert.ok(
    out.endsWith(`notes\nReview: BUGS-FOUND:gpt-review f=3 @ ${NEW} patch-id:${PID2}${tail}\n`),
    out,
  );
  const again = repinMarkerLine(REV, out, SHA, PID);
  assert.ok(again.includes(`@ ${SHA} patch-id:${PID}${tail}`), again);
  assert.equal((again.match(/patch-id:/g) || []).length, 1);
  assert.equal(repinMarkerLine(REV, entry(W4021), SHA, PID), null);
});

// ── plan 4021 review round 3: ONE strict read classification ─────────────────────────────────
// A read error is never absence. Absence is only git saying the path/ref does not exist, or the
// filesystem saying ENOENT while an lstat of the path ALSO finds nothing. Every platform-specific
// errno below is injected as a parameter, never coaxed out of the host filesystem.
const errOf = (message, extra = {}) => Object.assign(new Error(message), extra);
const throwing = (e) => () => {
  throw e;
};

test('plan 4021 r3 4fcf38/2a36b2: a working-tree ENOENT is absence ONLY when lstat also finds nothing (dangling link and ENOTDIR halt)', () => {
  const absentShow = throwing(errOf("fatal: path 'x.md' does not exist in 'origin/master'"));
  const enoent = throwing(errOf('ENOENT: no such file or directory', { code: 'ENOENT' }));
  const nothingThere = throwing(errOf('lstat', { code: 'ENOENT' }));
  const linkThere = () => ({ isSymbolicLink: () => true });
  const strict = (readTree, probeTree) =>
    originFirstCandidates(absentShow, readTree, { strict: true, probeTree });
  assert.deepEqual(strict(enoent, nothingThere), [], 'nothing at the path: genuine absence');
  assert.throws(() => strict(enoent, linkThere), /ENOENT/, 'a dangling symlink is not absence');
  assert.throws(
    () => strict(enoent, undefined),
    /ENOENT/,
    'an unprobed ENOENT cannot prove absence',
  );
  assert.throws(
    () => strict(throwing(errOf('ENOTDIR: not a directory', { code: 'ENOTDIR' })), nothingThere),
    /ENOTDIR/,
  );
  assert.equal(
    isFsPathAbsentError(errOf('x', { code: 'ENOENT' }), throwing(errOf('l', { code: 'EACCES' }))),
    false,
    "the probe's own non-ENOENT failure is 'could not find out'",
  );
});

test('plan 4021 r3 3f6485/5ffd98/41f896: one git classifier — show and grep absence vs a real error', () => {
  for (const msg of [
    "fatal: path 'a.md' does not exist in 'HEAD'",
    "fatal: invalid object name 'origin/master'.",
    'fatal: unable to resolve revision: origin/master',
  ])
    assert.equal(isGitPathAbsentError(errOf(msg)), true, msg);
  assert.equal(
    isGitPathAbsentError(
      errOf('Command failed', { stderr: 'fatal: unable to resolve revision: x' }),
    ),
    true,
  );
  assert.equal(isGitPathAbsentError(errOf('fatal: unable to read tree (371ef13d)')), false);
  const grepErr = (status, stderr, stdout = '') =>
    errOf('Command failed', { status, stderr, stdout });
  assert.equal(gitGrepNoMatch(grepErr(1, '')), true, 'exit 1 with no output is no match');
  assert.equal(
    gitGrepNoMatch(grepErr(128, 'fatal: unable to resolve revision: origin/master')),
    true,
  );
  assert.equal(gitGrepNoMatch(grepErr(128, 'fatal: unable to read tree (371ef13d)')), false);
  assert.equal(gitGrepNoMatch(grepErr(1, 'fatal: something else')), false);
  assert.equal(gitGrepNoMatch(errOf('spawn git ENOENT', { code: 'ENOENT' })), false);
});

test('plan 4021 r3 5ffd98/41f896: a lookup ERROR on a ref halts the chain with a named reason, never "no hit" then a fall-through', () => {
  const head = { [S_OLD]: entry(W4021, `${REVIEW_LINE}\n`) };
  const reports = [];
  const chain = resolveSessionChainOverRefs({
    refs: ['origin/master', 'HEAD'],
    slug: W4021,
    paths: P2838,
    tool: 'test',
    report: (m) => reports.push(m),
    grepFor: (ref) =>
      ref === 'origin/master'
        ? throwing(errOf('fatal: unable to read tree (371ef13d)'))
        : fakeGrep(head),
    readEntryFor: () => (p) => head[p],
  });
  assert.equal(chain, null);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /origin\/master/);
  assert.match(reports[0], /unable to read tree/);
});

test('plan 4021 r3 939d7d: candidates rejected on a fresher ref that resolved NOTHING still reach the marker walk', () => {
  // origin holds both entries but cannot read either; MAIN's HEAD lags and has only the older one
  const origin = { [S_OLD]: entry(W4021, `${REVIEW_LINE}\n`), [S_NEW]: entry(W4021) };
  const head = { [S_OLD]: entry(W4021, `${REVIEW_LINE}\n`) };
  const chain = resolveSessionChainOverRefs({
    refs: ['origin/master', 'HEAD'],
    slug: W4021,
    paths: P2838,
    tool: 'test',
    report: () => {},
    grepFor: (ref) => fakeGrep(ref === 'HEAD' ? head : origin),
    readEntryFor: (ref) => (p) => {
      if (ref !== 'HEAD') throw new Error(`EIO ${p}`);
      return head[p];
    },
  });
  assert.equal(chain.sf, S_OLD, 'the write target is unchanged');
  assert.deepEqual(chain.entries, [
    { path: S_NEW, halt: 'unreadable' },
    { path: S_OLD, halt: 'unreadable' },
  ]);
  assert.deepEqual(pickMarkerSourceEntry(REV, W4021, chain.entries, readAll(head)).halted, {
    reason: 'unreadable',
    path: S_NEW,
  });
  // a provably-foreign NEWER candidate on the fresher ref stays skipped, as on a single ref
  const noneNewer = {
    [S_OLD]: entry(W4021, `${REVIEW_LINE}\n`),
    [S_NEW]: `# s\n\n**Branch:** none — reviewed \`worktree-${W4021}\`\n`,
  };
  const c2 = resolveSessionChainOverRefs({
    refs: ['origin/master', 'HEAD'],
    slug: W4021,
    paths: P2838,
    tool: 'test',
    report: () => {},
    grepFor: (ref) => fakeGrep(ref === 'HEAD' ? head : { [S_NEW]: noneNewer[S_NEW] }),
    readEntryFor: (ref) => (p) => (ref === 'HEAD' ? head : noneNewer)[p],
  });
  assert.deepEqual(c2.entries, [S_OLD]);
});

test('plan 4021 r3 ac5821: repinMarkerLine keeps only grammar-defined trailing tokens; marker-shaped metadata never becomes the parsed marker', () => {
  const NEW = 'f'.repeat(40);
  const OTHER = 'e'.repeat(40);
  const line =
    `Review: PASS:gpt-review f=1 @ ${SHA} scope-narrowed[excluded=2] review-round:4 ` +
    `past-cap-reason="run: Review: NITS @ ${OTHER}" trailing prose`;
  const out = repinMarkerLine(REV, entry(W4021, `${line}\n`), NEW, PID2);
  const parsed = parseMarkerAny(REV, out);
  assert.equal(parsed.sha, NEW, out);
  assert.equal(parsed.verdict, 'PASS');
  assert.ok(
    out.endsWith(`@ ${NEW} patch-id:${PID2} scope-narrowed[excluded=2] review-round:4\n`),
    out,
  );
  const benign = `Review: PASS @ ${SHA} review-round:4 past-cap-reason="run: fix \\"x\\" now"`;
  const kept = repinMarkerLine(REV, entry(W4021, `${benign}\n`), NEW, PID2);
  assert.ok(kept.endsWith(`review-round:4 past-cap-reason="run: fix \\"x\\" now"\n`), kept);
});

test('plan 4021 r3 3ba933/4de3b4: the apply-time identity covers patch-id and trailing identity tokens, not only verdict/detail/sha', () => {
  const NEW = 'f'.repeat(40);
  const base = `Review: NITS:gpt-review f=2 @ ${SHA} patch-id:${PID} scope-narrowed[excluded=1] review-round:2`;
  const idOf = (l) => markerLineIdentity(REV, entry(W4021, `${l}\n`));
  const gate = idOf(base);
  assert.equal(markerIdentityUnchanged(gate, idOf(base), NEW, PID2), true);
  const siblingRepinned = base.replace(`@ ${SHA} patch-id:${PID}`, `@ ${NEW} patch-id:${PID2}`);
  assert.equal(markerIdentityUnchanged(gate, idOf(siblingRepinned), NEW, PID2), true);
  for (const changed of [
    base.replace(`patch-id:${PID}`, `patch-id:${PID2}`),
    base.replace(' scope-narrowed[excluded=1]', ''),
    base.replace('review-round:2', 'review-round:3'),
    base.replace('NITS', 'BUGS-FOUND'),
    base.replace('f=2', 'f=3'),
    `${base} past-cap-reason="run: x"`,
  ])
    assert.equal(markerIdentityUnchanged(gate, idOf(changed), NEW, PID2), false, changed);
  assert.equal(markerIdentityUnchanged(gate, null, NEW, PID2), false);
  assert.equal(markerLineIdentity(REV, entry(W4021)), null);
});

test('plan 2838: resolveSessionEntry — a LEGACY entry (no Branch line) still resolves via the fallback', () => {
  // ~95 of 2296 live entries predate the Branch line; dropping the substring fallback would
  // strand every one of them.
  const corpus = { [`${SD}/2026-01-02-session-11.md`]: '# session\n\nclaim: 300-Old-plan\n' };
  const r = resolveSessionEntry(fakeGrep(corpus), '300-Old-plan', P2838);
  assert.equal(r.sf, `${SD}/2026-01-02-session-11.md`);
  assert.equal(r.anchored, false);
  assert.equal(r.ambiguous, false);
});

test('plan 2838: resolveSessionEntry — a mention inside ANOTHER session’s owned entry resolves to nothing', () => {
  // The entry carries a Branch line, and the anchored pass already proved it does not name us —
  // so it demonstrably belongs to someone else. Better no entry (the caller refuses) than theirs.
  const corpus = {
    [`${SD}/2026-08-04-session-2698.md`]: entry(
      '2816-Coord-worktree-lock',
      'ran beside 2808-Pipe\n',
    ),
  };
  const r = resolveSessionEntry(fakeGrep(corpus), '2808-Pipe', P2838);
  assert.equal(r.sf, null);
  assert.equal(r.ambiguous, false);
});

test('plan 2838: resolveSessionEntry — >1 un-anchorable legacy match is AMBIGUOUS, never a silent tiebreak', () => {
  const corpus = {
    [`${SD}/2026-01-02-session-11.md`]: '# session\n\nclaim: 300-Old-plan\n',
    [`${SD}/2026-01-03-session-12.md`]: '# session\n\nalso mentions 300-Old-plan\n',
  };
  const r = resolveSessionEntry(fakeGrep(corpus), '300-Old-plan', P2838);
  assert.equal(r.sf, null, 'refuses instead of picking session 12');
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.candidates, [
    `${SD}/2026-01-02-session-11.md`,
    `${SD}/2026-01-03-session-12.md`,
  ]);
  const msg = ambiguousSessionEntryMessage('record-review', '300-Old-plan', r.candidates);
  for (const c of r.candidates) assert.ok(msg.includes(c), `names candidate ${c}`);
  assert.match(msg, /AMBIGUOUS/);
});

test('plan 2838: resolveSessionEntry — no hit and no slug both resolve to nothing', () => {
  assert.equal(resolveSessionEntry(fakeGrep({}), 'nope', P2838).sf, null);
  assert.equal(resolveSessionEntry(fakeGrep({}), '', P2838).sf, null);
});

test('plan 2838: rankSessionFiles orders oldest-first and pickSessionFile is its most-recent tip', () => {
  const out =
    `HEAD:${SD}/2026-06-15-session-100.md\n` +
    `HEAD:${SD}/2026-06-15-session-9.md\n` +
    `HEAD:${SD}/2026-06-14-session-999.md`;
  assert.deepEqual(rankSessionFiles(out, P2838), [
    `${SD}/2026-06-14-session-999.md`,
    `${SD}/2026-06-15-session-9.md`,
    `${SD}/2026-06-15-session-100.md`,
  ]);
  assert.equal(pickSessionFile(out, P2838), `${SD}/2026-06-15-session-100.md`);
});

test('plan 2838: sidecarOwnerConflict refuses a cross-owner write and waves the legacy/own cases', () => {
  const rel = `${SD}/2026-08-04-session-2698.findings.json`;
  // owned by someone else → refuse, naming BOTH owners
  const msg = sidecarOwnerConflict({ slug: '2816-Coord-worktree-lock' }, '2808-Pipe', rel);
  assert.ok(msg, 'a cross-owner write is refused');
  assert.match(msg, /2816-Coord-worktree-lock/);
  assert.match(msg, /2808-Pipe/);
  assert.match(msg, /REFUSED/);
  // own sidecar → allowed
  assert.equal(sidecarOwnerConflict({ slug: '2808-Pipe' }, '2808-Pipe', rel), null);
  // legacy sidecar (pre-2838, no slug) → un-ownable, so allowed: failing closed would wedge
  // every branch whose sidecar predates this plan
  assert.equal(sidecarOwnerConflict({ sha: 'abc' }, '2808-Pipe', rel), null);
  assert.equal(sidecarOwnerConflict(null, '2808-Pipe', rel), null);
});

test('plan 2838: sessionEntryOwnerSlug — worktree slug, explicit none, and legacy all read distinctly', () => {
  assert.equal(sessionEntryOwnerSlug(entry('700-Plan')), '700-Plan');
  // the non-canonical committed form still yields the owner
  assert.equal(
    sessionEntryOwnerSlug(
      '# s\n\n**Branch:** resuming in existing worktree `worktree-2141-X` at C:\n',
    ),
    '2141-X',
  );
  // a Branch line that declares NO worktree is not a conflict, but is not legacy either
  assert.equal(
    sessionEntryOwnerSlug('# s\n\n**Branch:** none — wiki-only, worktree-exempt.\n'),
    '',
  );
  // no Branch line at all → unknown
  assert.equal(sessionEntryOwnerSlug('# s\n\nclaim: 300-Old-plan\n'), null);
  assert.equal(sessionEntryOwnerSlug(''), null);
});

test('plan 2838: assertSessionEntryOwner refuses an entry whose Branch line names another session', () => {
  // review 2838 [5]/[15]/[18]: the last line of defence, and the ONLY one that bites the legacy
  // sidecar population (all 1093 committed sidecars are unowned, but their entries are not).
  const corpus = { [`${SD}/2026-08-04-session-2698.md`]: entry('2816-Coord-lock') };
  const resolved = {
    sf: `${SD}/2026-08-04-session-2698.md`,
    candidates: [],
    anchored: false,
    ambiguous: false,
    ownerConflict: null,
  };
  const bad = assertSessionEntryOwner(resolved, '2808-Pipe', fakeRead(corpus));
  assert.equal(bad.sf, null, 'refuses rather than returning the stranger’s entry');
  assert.deepEqual(bad.ownerConflict, {
    path: `${SD}/2026-08-04-session-2698.md`,
    owner: '2816-Coord-lock',
  });
  const msg = sessionEntryOwnerMessage('record-review', '2808-Pipe', bad.ownerConflict);
  assert.match(msg, /REFUSED/);
  assert.match(msg, /2816-Coord-lock/);
  // my OWN entry passes through untouched
  assert.equal(
    assertSessionEntryOwner(resolved, '2816-Coord-lock', fakeRead(corpus)).sf,
    resolved.sf,
  );
  // a legacy entry (no Branch line) cannot be judged → passes through
  const legacy = { ...resolved, sf: `${SD}/2026-01-02-session-11.md` };
  const lc = { [`${SD}/2026-01-02-session-11.md`]: '# s\n\nclaim: 300-Old\n' };
  assert.equal(assertSessionEntryOwner(legacy, '300-Old', fakeRead(lc)).sf, legacy.sf);
  // an unreadable entry cannot be judged either → passes through, caller's own gates still apply
  assert.equal(assertSessionEntryOwner(legacy, '300-Old', fakeRead({})).sf, legacy.sf);
  // no resolution / no reader → identity
  assert.equal(assertSessionEntryOwner({ sf: null }, 'x', fakeRead({})).sf, null);
});

test('plan 2838 re-review [0]/[1]: a `**Branch:** none` line’s prose worktree mention is NOT ownership', () => {
  // Both of these are REAL committed entries. Reading their historical worktree mention as
  // ownership would let a live branch of that name resolve onto a worktree-exempt session’s
  // entry — the same hijack, re-introduced by the very relaxation that fixed the 2141 form.
  const noneWithMention =
    '# s\n\n**Branch:** none — **no worktree** (operator-action plan). One throwaway worktree ' +
    '`worktree-562-runbook-no-cf-hub` was cut + landed + torn down.\n';
  const noneYet =
    '# s\n\n**Branch:** (none yet — a `worktree-skane-hero-photos` is created later).\n';
  assert.equal(sessionEntryOwnerSlug(noneWithMention), '');
  assert.equal(sessionEntryOwnerSlug(noneYet), '');
  // …while a genuine owner, canonical or not, still reads as ownership
  assert.equal(sessionEntryOwnerSlug(entry('562-runbook-no-cf-hub')), '562-runbook-no-cf-hub');

  // and end-to-end through the resolver: the grep alone WOULD match (it is only a prefilter),
  // so this is exactly the case the readEntry verification exists to catch.
  const corpus = { [`${SD}/2026-06-07-session-363.md`]: noneWithMention };
  const g = fakeGrep(corpus);
  assert.ok(
    g(sessionEntryAnchor('562-runbook-no-cf-hub'), [`${SD}/*.md`], 'regex'),
    'precondition: the anchored grep DOES hit — the parser is what refuses',
  );
  const r = resolveSessionEntry(g, '562-runbook-no-cf-hub', P2838, fakeRead(corpus));
  assert.equal(r.sf, null, 'verified against the file, the entry declares no worktree');
});

test('plan 2838 re-review [15]: sidecarOwnedBy is the boolean twin of sidecarOwnerConflict', () => {
  const rel = `${SD}/x.findings.json`;
  for (const [rec, slug] of [
    [{ slug: 'a' }, 'a'],
    [{ sha: 'z' }, 'a'],
    [null, 'a'],
  ]) {
    assert.equal(sidecarOwnedBy(rec, slug), true);
    assert.equal(sidecarOwnerConflict(rec, slug, rel), null, 'the two agree');
  }
  assert.equal(sidecarOwnedBy({ slug: 'b' }, 'a'), false);
  assert.ok(sidecarOwnerConflict({ slug: 'b' }, 'a', rel), 'the two agree');
});

test('plan 2838: buildFindingsRecord stamps the owning slug (and omits it when unknown)', () => {
  const f = [{ file: 'a.ts', line: 1, summary: 's' }];
  const owned = buildFindingsRecord('NITS', 'abc123', f, null, { slug: '2838-Coord-x' });
  assert.equal(owned.slug, '2838-Coord-x');
  assert.equal(owned.verdict, 'NITS');
  assert.equal(owned.findings.length, 1);
  assert.ok(!('slug' in buildFindingsRecord('NITS', 'abc123', f)), 'no slug ⇒ no key written');
});

test('plan 2743 normalizeMarkerPatchId: accepts a hex digest and the literal "empty"; refuses anything else', () => {
  assert.equal(normalizeMarkerPatchId(PID), PID);
  assert.equal(normalizeMarkerPatchId(PID.toUpperCase()), PID, 'normalized to lower case');
  // rangePatchId returns the literal 'empty' for an empty diff — two empty ranges must compare
  // equal, so the token vocabulary has to carry it.
  assert.equal(normalizeMarkerPatchId('empty'), 'empty');
  for (const bad of [null, undefined, '', 'zzzz', 'abc', 'a1b2 c3', `a@${PID}`, `${PID}\nx`])
    assert.equal(normalizeMarkerPatchId(bad), null, `refuses ${JSON.stringify(bad)}`);
});

test('plan 2743 upsertMarker: writes the patch-id token after the sha, round-trips, and drops a value outside the vocabulary', () => {
  const out = upsertMarker(REV, '# entry\n', 'PASS', SHA, 'sonnet-review f=6', PID);
  assert.match(out, new RegExp(`Review: PASS:sonnet-review f=6 @ ${SHA} patch-id:${PID}`));
  const back = parseMarkerAny(REV, out);
  assert.equal(back.patchId, PID);
  assert.equal(back.sha, SHA);
  assert.equal(back.detail, 'sonnet-review f=6', 'the detail is unaffected by the new token');

  // omitted ⇒ the legacy line, byte for byte
  assert.equal(upsertMarker(REV, '# entry\n', 'PASS', SHA, ''), `# entry\nReview: PASS @ ${SHA}\n`);
  // a value the parser could not read back is DROPPED, never written
  assert.equal(
    upsertMarker(REV, '# entry\n', 'PASS', SHA, '', 'not-a-patch-id'),
    `# entry\nReview: PASS @ ${SHA}\n`,
  );
  // re-record still leaves exactly ONE marker (the strip regex sees the trailing token)
  const second = upsertMarker(REV, out, 'NITS', SHA, 'substitute', PID2);
  assert.equal((second.match(/Review:\s*(?:PASS|NITS|BUGS-FOUND)/g) || []).length, 1);
  assert.equal(parseMarkerAny(REV, second).patchId, PID2);
});

test('plan 2743 parseMarkerAny: a legacy sha-only marker parses with patchId null (no backfill, still readable)', () => {
  assert.equal(parseMarkerAny(REV, `Review: PASS @ ${SHA}\n`).patchId, null);
  assert.equal(parseMarkerAny(REV, `Review: PASS:substitute @ ${SHA}\n`).patchId, null);
});

test('plan 2743 parseMarkerCurrent: a patch-id-identical rebase keeps the marker CURRENT — the halt (and its re-pin commit) never happens', () => {
  const doc = upsertMarker(REV, '# entry\n', 'PASS', SHA, 'sonnet-review', PID);
  const REBASED = 'deadbeef00112233445566778899aabbccddeeff';

  // sha fast path is unchanged and never consults the patch-id
  assert.equal(parseMarkerCurrent(REV, doc, SHA).verdict, 'PASS');
  assert.equal(parseMarkerCurrent(REV, doc, SHA).rebasePinned, undefined);

  // stale sha + SAME content identity ⇒ current, flagged as rebase-pinned
  const viaRebase = parseMarkerCurrent(REV, doc, REBASED, PID);
  assert.equal(viaRebase.verdict, 'PASS');
  assert.equal(viaRebase.rebasePinned, true);
  assert.equal(viaRebase.sha, SHA, 'still reports the sha it was recorded at — honest');

  // a thunk works too (that is how the spine avoids spawning git on the fast path)
  assert.equal(parseMarkerCurrent(REV, doc, REBASED, () => PID).verdict, 'PASS');

  // DIFFERENT content ⇒ stale. This is the safety property: a rework still invalidates.
  assert.equal(parseMarkerCurrent(REV, doc, REBASED, PID2), null);
  // uncomputable HEAD patch-id ⇒ stale, exactly the pre-2743 behavior
  assert.equal(parseMarkerCurrent(REV, doc, REBASED, null), null);
  assert.equal(
    parseMarkerCurrent(REV, doc, REBASED, () => null),
    null,
  );
  // a LEGACY marker has no rebase-stable identity to honor ⇒ stale, repin path intact
  const legacy = upsertMarker(REV, '# entry\n', 'PASS', SHA, '');
  assert.equal(parseMarkerCurrent(REV, legacy, REBASED, PID), null);
});

test('plan 2743 parseMarkerCurrent: the fast path never invokes the patch-id thunk (no git spawn for a fresh marker)', () => {
  const doc = upsertMarker(REV, '# entry\n', 'PASS', SHA, '', PID);
  let calls = 0;
  const thunk = () => {
    calls += 1;
    return PID;
  };
  assert.equal(parseMarkerCurrent(REV, doc, SHA, thunk).verdict, 'PASS');
  assert.equal(calls, 0, 'a marker already pinning HEAD must cost nothing extra');
});

test('plan 2743 re-review [1]: markerIdentityMatch is the ONE comparator behind both the marker and the findings-sidecar reads', () => {
  const REBASED = 'deadbeef00112233445566778899aabbccddeeff';
  // reports HOW it matched, so parseMarkerCurrent can flag rebasePinned and the sidecar can't drift
  assert.equal(
    markerIdentityMatch(SHA, PID, SHA, PID),
    'sha',
    'sha wins first, no patch-id needed',
  );
  assert.equal(markerIdentityMatch(SHA, PID, SHA, null), 'sha', 'fast path needs no head patch-id');
  assert.equal(markerIdentityMatch(SHA, PID, REBASED, PID), 'patch-id');
  assert.equal(
    markerIdentityMatch(SHA, PID, REBASED, () => PID),
    'patch-id',
    'thunk accepted',
  );
  assert.equal(markerIdentityMatch(SHA, PID, REBASED, PID2), null, 'content changed ⇒ stale');
  assert.equal(markerIdentityMatch(SHA, null, REBASED, PID), null, 'legacy ⇒ sha-only');
  assert.equal(markerIdentityMatch(SHA, PID, REBASED, null), null, 'uncomputable ⇒ stale');
  // plan 2743 grill Q2: a MISSING recorded sha must fall THROUGH to the patch-id comparison
  // (what the three inline implementations did) — not short-circuit to stale. `sameCommitSha`
  // already rejects a falsy sha, so the fast path simply misses.
  assert.equal(
    markerIdentityMatch(null, PID, REBASED, PID),
    'patch-id',
    'no recorded sha but a matching patch-id ⇒ still current',
  );
  assert.equal(
    markerIdentityMatch(null, PID, REBASED, PID2),
    null,
    'no recorded sha and a differing patch-id ⇒ stale',
  );
  assert.equal(markerIdentityMatch(null, null, REBASED, PID), null, 'no identity at all ⇒ stale');
  assert.equal(markerIdentityMatch(SHA, PID, null, PID), null);
  // and it is what parseMarkerCurrent reports through
  const doc = upsertMarker(REV, '', 'PASS', SHA, '', PID);
  assert.equal(parseMarkerCurrent(REV, doc, REBASED, PID).rebasePinned, true);
  assert.equal(parseMarkerCurrent(REV, doc, SHA, PID).rebasePinned, undefined);
});

test('plan 2743 markerStatusRow: a rebase-pinned marker reads as fresh, not STALE', () => {
  const marker = parseMarkerAny(REV, upsertMarker(REV, '', 'PASS', SHA, 'sonnet-review', PID));
  const REBASED = 'deadbeef00112233445566778899aabbccddeeff';
  assert.match(markerStatusRow(REV, marker, REBASED, PID), /fresh \(patch-id .* across a rebase\)/);
  assert.match(markerStatusRow(REV, marker, REBASED, PID2), /STALE/);
  // omitted ⇒ unchanged output (no caller is forced to compute a patch-id to render a row)
  assert.match(markerStatusRow(REV, marker, REBASED), /STALE/);
  assert.match(markerStatusRow(REV, marker, SHA), /fresh \(pins HEAD\)/);
});

test('plan 3295 markerIdentityMatch: the seed-only fallback is REVIEW-only, tried lazily only after sha AND patch-id both fail', () => {
  const REBASED = 'deadbeef00112233445566778899aabbccddeeff';
  // sha matches ⇒ 'sha', seedOnlyDelta never even consulted (would throw if called)
  const boom = () => {
    throw new Error('must not be called — the sha fast path already matched');
  };
  assert.equal(markerIdentityMatch(SHA, PID, SHA, PID, boom), 'sha');
  // patch-id matches ⇒ 'patch-id', seedOnlyDelta still never consulted
  assert.equal(markerIdentityMatch(SHA, PID, REBASED, PID, boom), 'patch-id');
  // both fail, seedOnlyDelta says yes ⇒ 'seed-only'
  let calls = 0;
  const yes = (recordedSha, currentSha) => {
    calls += 1;
    assert.equal(recordedSha, SHA);
    assert.equal(currentSha, REBASED);
    return true;
  };
  assert.equal(markerIdentityMatch(SHA, PID, REBASED, PID2, yes), 'seed-only');
  assert.equal(calls, 1, 'called exactly once — lazily, only after sha+patch-id both failed');
  // both fail, seedOnlyDelta says no ⇒ stale, exactly as before plan 3295
  assert.equal(
    markerIdentityMatch(SHA, PID, REBASED, PID2, () => false),
    null,
  );
  // no recordedSha ⇒ never consulted (nothing to diff FROM)
  assert.equal(markerIdentityMatch(null, null, REBASED, null, boom), null);
  // omitted (as every wiki/conclusion call site leaves it) ⇒ byte-identical to pre-3295 behavior
  assert.equal(markerIdentityMatch(SHA, PID, REBASED, PID2), null);
  // a plain boolean value (not a function) works too, same contract as headPatchId
  assert.equal(markerIdentityMatch(SHA, PID, REBASED, PID2, true), 'seed-only');
  assert.equal(markerIdentityMatch(SHA, PID, REBASED, PID2, false), null);
});

test('plan 3295 parseReviewMarkerFull / parseReviewMarker: a marker recorded at X is honored at Y for a seed-only X..Y delta, and STALE for any non-seed path in the delta', () => {
  const doc = upsertMarker(REV, '# entry\n', 'PASS', SHA, 'sonnet-review', PID);
  const Y = 'deadbeef00112233445566778899aabbccddeeff';
  const seedOnly = () => true;
  const notSeedOnly = () => false;

  // valid: a seed-only delta carries the review
  const carried = parseReviewMarkerFull(doc, Y, PID2, seedOnly);
  assert.equal(carried?.verdict, 'PASS');
  assert.equal(carried?.seedOnlyCarried, true);
  assert.equal(carried?.rebasePinned, undefined, 'this is the seed-only path, not the rebase path');
  assert.equal(carried?.sha, SHA, 'still reports the sha it was recorded at — honest');
  assert.equal(parseReviewMarker(doc, Y, PID2, seedOnly), 'PASS');

  // stale: any non-seed path in the delta (the predicate returning false) refuses, same as before
  assert.equal(parseReviewMarkerFull(doc, Y, PID2, notSeedOnly), null);
  assert.equal(parseReviewMarker(doc, Y, PID2, notSeedOnly), null);

  // omitted ⇒ unchanged (pre-3295) behavior — no caller is forced to pass it
  assert.equal(parseReviewMarkerFull(doc, Y, PID2), null);
  assert.equal(parseReviewMarker(doc, Y, PID2), null);

  // a LEGACY marker with no recorded sha to diff FROM never seed-only-carries
  const legacy = upsertMarker(REV, '# entry\n', 'PASS', SHA, '');
  assert.equal(parseReviewMarkerFull(legacy, Y, PID2, seedOnly)?.seedOnlyCarried, true);
  assert.equal(
    parseReviewMarkerFull(legacy, Y, null, seedOnly)?.seedOnlyCarried,
    true,
    'a legacy sha-only marker still carries via seed-only — it has a sha to diff from, just no patch-id',
  );
});

test('plan 3295 markerStatusRow: seed-only carry reads as fresh with its own label; wiki/conclusion rows are unaffected (they never pass seedOnlyDelta)', () => {
  const marker = parseMarkerAny(REV, upsertMarker(REV, '', 'PASS', SHA, 'sonnet-review', PID));
  const Y = 'deadbeef00112233445566778899aabbccddeeff';
  assert.match(
    markerStatusRow(REV, marker, Y, PID2, () => true),
    /fresh \(seed-only delta carries HEAD .* from .*\)/,
  );
  assert.match(
    markerStatusRow(REV, marker, Y, PID2, () => false),
    /STALE/,
  );
  // omitted (the wiki/conclusion rows never pass it) ⇒ unchanged output
  assert.match(markerStatusRow(REV, marker, Y, PID2), /STALE/);

  const wikiFam = MARKER_FAMILIES.wiki;
  const wikiMarker = parseMarkerAny(wikiFam, upsertMarker(wikiFam, '', 'WROTE', SHA, '', PID));
  // even if a caller mistakenly passed a truthy seedOnlyDelta to a wiki row, the family label
  // stays 'Wiki' and the row still renders — this just documents that nothing here special-cases
  // the family internally; the opt-in is structural (only review's delegate exposes the param).
  assert.match(
    markerStatusRow(wikiFam, wikiMarker, Y, PID2, () => true),
    /^Wiki: /,
  );
});

test('plan 1528: repinDecision — identical patch-ids repin; different = rework; uncomputable refuses without the rework claim', () => {
  const base = { markerSha: 'aaaaaaaaa1', headSha: 'bbbbbbbbb2' };
  assert.deepEqual(repinDecision({ ...base, oldPatchId: 'p1', newPatchId: 'p1' }), { repin: true });
  const differ = repinDecision({ ...base, oldPatchId: 'p1', newPatchId: 'p2' });
  assert.equal(differ.repin, false);
  assert.equal(differ.rework, true, 'different patch-ids PROVE rework (Phase B arm b)');
  const uncomputable = repinDecision({ ...base, oldPatchId: null, newPatchId: 'p2' });
  assert.equal(uncomputable.repin, false);
  assert.ok(!uncomputable.rework, 'an unresolvable old tip must NOT claim rework');
  // empty ranges compare equal via the stable 'empty' literal
  assert.deepEqual(repinDecision({ ...base, oldPatchId: 'empty', newPatchId: 'empty' }), {
    repin: true,
  });
  // marker already current / missing inputs all refuse
  assert.equal(
    repinDecision({
      markerSha: 'aaaaaaaaa1',
      headSha: 'aaaaaaaaa1',
      oldPatchId: 'p',
      newPatchId: 'p',
    }).repin,
    false,
  );
  assert.equal(repinDecision({ markerSha: null, headSha: 'b' }).repin, false);
  assert.equal(repinDecision({ markerSha: 'a1a1a1a1a', headSha: null }).repin, false);
});
test('REVIEW_METHODS / REVIEW_FANOUT_METHODS: the fixed vocabularies', () => {
  assert.deepEqual(REVIEW_METHODS, [
    'sonnet-review',
    'code-review',
    'gpt-review',
    'substitute',
    'self-read',
  ]);
  assert.deepEqual(REVIEW_FANOUT_METHODS, ['sonnet-review', 'code-review', 'gpt-review']);
});

test('keyless finding identity is normalized exactly like the writer before key derivation', () => {
  const raw = { file: ` ${F1.file} `, line: String(F1.line), summary: ` ${F1.summary} ` };
  const parsed = parseFindingsRecord(
    JSON.stringify({ sha: SHA, verdict: 'NITS', findings: [raw] }),
  );
  const written = buildFindingsRecord('NITS', SHA, [raw]);

  assert.equal(parsed.findings[0].key, written.findings[0].key);
});

test('plan 642: a non-numbered session file (drain orchestrate meta-log) never out-ranks a real numbered per-plan entry on the same date', () => {
  // -session-drain-orchestrate has no numeric session → sess=0 by design, so flipping
  // that SHARED meta-log (it mentions many slugs) can never win over the plan's own entry.
  const out = [
    'HEAD:handoff/sessions/2026-06-15-session-9.md',
    'HEAD:handoff/sessions/2026-06-15-session-drain-orchestrate.md',
  ].join('\n');
  assert.equal(pickSessionFile(out, LEGACY_PATHS), 'handoff/sessions/2026-06-15-session-9.md');
  // a numbered drain entry (601drain → 601) IS a real per-plan entry and resolves normally.
  assert.equal(
    pickSessionFile('HEAD:handoff/sessions/2026-06-15-session-601drain.md', LEGACY_PATHS),
    'handoff/sessions/2026-06-15-session-601drain.md',
  );
});

test('plan 2838: a .findings.json sidecar is never a session ENTRY — not even as the newest hit', () => {
  assert.equal(isSessionEntryPath(`${SD}/2026-08-04-session-2697.md`), true);
  assert.equal(isSessionEntryPath(`${SD}/2026-08-04-session-2698.findings.json`), false);
  // The incident's exact grep output: the sibling's sidecar sorts NEWER (2698 > 2697) and would
  // have won the tiebreak. pickSessionFile must still return the older session's own entry.
  const out =
    `HEAD:${SD}/2026-08-04-session-2697.md\n` + `HEAD:${SD}/2026-08-04-session-2698.findings.json`;
  assert.equal(pickSessionFile(out, P2838), `${SD}/2026-08-04-session-2697.md`);
  // and a sidecar-ONLY match resolves to nothing rather than to the sidecar
  assert.equal(pickSessionFile(`HEAD:${SD}/2026-08-04-session-2698.findings.json`, P2838), null);
});

test('plan 2838: the entry predicate requires the DATED session-entry shape, not just .md', () => {
  // review 2838 [1]/[8]/[14]/[16]: README.md is the one live non-entry .md in the sessions dir,
  // and a bare `.md` suffix would keep admitting it (plus any future note landing beside them).
  assert.equal(isSessionEntryPath(`${SD}/2026-08-04-session-2697.md`), true);
  assert.equal(isSessionEntryPath(`${SD}/2026-08-04-session-601drain.md`), true);
  assert.equal(isSessionEntryPath(`${SD}/README.md`), false);
  assert.equal(isSessionEntryPath(`${SD}/notes.md`), false);
  assert.equal(pickSessionFile(`HEAD:${SD}/README.md`, P2838), null);
});

test('plan 2838: an entry declaring ANY Branch form is not claimable as a legacy mention', () => {
  // review 2838 [17]: `**Branch:** none — …` is a real committed form. Treating it as "legacy,
  // therefore claimable" would let a prose mention hijack that session's entry.
  const corpus = {
    [`${SD}/2026-08-04-session-50.md`]:
      '# s50\n\n**Branch:** none — wiki-only session.\nran beside 400-Other-plan\n',
  };
  const r = resolveSessionEntry(fakeGrep(corpus), '400-Other-plan', P2838);
  assert.equal(r.sf, null);
  assert.equal(r.ambiguous, false);
});

test('plan 2844 Task 2: the entry predicate is narrowed back to the dated-only shape — a --date-malformed name is no longer admitted', () => {
  // The fork the 2838 re-review [21] comment used to document is CLOSED: plan 2844 Task 1
  // now REFUSES a malformed --date at both claim-plan call sites before any session-entry
  // filename is ever built, so `20260804-session-7.md` can no longer be a REAL entry — the
  // `-session-` alternative that used to admit it had no remaining real entry to protect,
  // only a widened surface whose date-prefix `rankSessionFiles` sort key falls back to '' and
  // sorts oldest (exactly the bug class this narrowing closes).
  assert.equal(isSessionEntryPath(`${SD}/20260804-session-7.md`), false);
  assert.equal(
    isSessionEntryPath(`${SD}/2026-08-04-session-7.md`),
    true,
    'the dated shape is still admitted',
  );
  assert.equal(isSessionEntryPath(`${SD}/README.md`), false);
  // …and the resolver, which filters candidates through this same predicate, can no longer
  // resolve onto a non-ISO-shaped name at all.
  const corpus = { [`${SD}/20260804-session-7.md`]: entry('900-Odd-date') };
  const r = resolveSessionEntry(fakeGrep(corpus), '900-Odd-date', P2838, fakeRead(corpus));
  assert.equal(r.sf, null, 'the non-ISO-shaped file is no longer resolvable as a session entry');
});
