#!/usr/bin/env node
// Fresh-context review fix brief (plan 3545 T2). `--round N` reads that round's artifact and the
// routed session sidecar; `--round-dir` / `--sidecar` override input and `--out` overrides stdout.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import nodePath, { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { culpritTestTargets } from './coord/assert-no-landed-reversion.mjs';
import { gitRepoIsolatedEnv } from './coord/child-env.mjs';
import { loadCoordConfig } from './coord/coord-config.mjs';
// plan 3959 T2: the findings-sidecar machinery moved to scripts/coord/review-markers.mjs.
import {
  findingKey,
  findingBlocksLand,
  sidecarOwnerConflict,
  normalizeDisposition,
  parseFindingsRecord,
  planIdInTree,
} from './coord/review-markers.mjs';
import { readSidecarForSlug } from './gpt-review.mjs';
import { normalizeRel } from './coord/main-checkout-allowlist.mjs';
import { reviewFindingsPath } from './coord/review-round-cap.mjs';

const FIX_RULES = [
  'failing test first, and confirm it FAILS on the pre-fix code;',
  'the smallest change that makes that test pass in its lowest-debt form — reuse a canonical helper over a new local copy, and delete over patch;',
  'if the fix needs a new mechanism (a new lock, cache, parser, comparison algebra, retry loop) or grows the touched file by more than ~40 lines, STOP and report `SIMPLIFY: <what to delete instead>` — do not build it;',
  'if the finding is about a mechanism the previous round added, prefer DELETING that mechanism over patching it.',
  // plan 4078 T2 — the single most common round-2+ regression shape in the plan's own 83-plan
  // sample: a fix landed at one call site and left a sibling carrying the same defect.
  'sibling-site sweep: before writing the fix, list every OTHER call site of the function you are changing and every other place the same pattern appears (grep the symbol, grep the shape); each one is either fixed in the same diff or named in the report as deliberately untouched with a reason — a fix that lands at one site and leaves a sibling is the single most common regression the next round finds;',
  // plan 4078 T2 — the second recurring shape: an over-correction that breaks the case the
  // pre-fix code handled correctly.
  "keep-the-old-case test: alongside the failing-test-first test for the flagged input, add (or point at) one test for the case the pre-fix code handled CORRECTLY, so an over-correction turns red instead of shipping — the two tests together are the fix's verifier of record; the delta re-review stays a second check.",
  // plan 3944. The tool already existed (`_select_tests.py`, plan 2273, import-closure walk with
  // "run more, never skip" as its fail direction); the gap was that in-round workers never ran it
  // and picked "related" tests by judgment from the changed symbol's NAME instead. Plan 3858
  // (2026-09-11) left two tests red from round 1 through round 4 while every round reported green.
  // A review-FIX round is the same shape — a worker changing a shared function under time pressure
  // — so the instruction rides this brief too, not only the plan-execution dispatches in
  // docs/coord/orchestrator-loop.md and coord/skills/batch-train/references/thin-orchestrator.md.
  'if your fix changes what a shared function returns, stamps, or filters, run `python -X utf8 backend/scripts/_select_tests.py --changed-file <file listing the changed repo-relative paths>` before trusting your green run: `SUBSET <n> test files` means run every file it lists, and `FULL <reason>` means you may not narrow by judgment — queue the full suite (`node scripts/queued-run.mjs <cmd…>`) or say plainly that you did not and that green is therefore unverified. A changed `scripts/**` `.mjs` module has no such selector: run its name-paired `*.test.mjs` plus every `*.test.mjs` that greps for the changed symbol.',
];

// The canonical malformed/identity classifier (done-worktree-lib.mjs's `findingWithCanonicalKey`,
// the same one findingsGate uses) is not itself exported — only its public JSON-record entry
// point, `parseFindingsRecord`, is. Routing every findings array through that shared entry point
// (rather than re-implementing the "does this entry have a usable file+summary" check locally)
// is what keeps this brief's malformed-detection from drifting from the land gate's (plan 3624,
// findings 1u4tyh9 / vul15p / 1nt2873 / g7ywnq): a malformed entry comes back as
// `{malformedIndex, malformedReason}` instead of a finding, and is never turned into a synthetic
// fix target here.
function canonicalizeFindings(findings) {
  return parseFindingsRecord(JSON.stringify({ findings: findings || [] }))?.findings || [];
}

// Workflow-recovery findings can carry an ABSOLUTE finding path; the sibling-test resolver below
// (and the paired-test existence check) only understands repo-relative ones (plan 3624, finding
// 1mgghh8). Normalize once, here, rather than at each call site.
//
// `_path` is injectable (defaults to the real `node:path`, the plan-2489 pattern) so a Windows
// separator/drive-letter shape can be exercised from any host. `node:path`'s own `relative()`
// returns BACKSLASH-separated segments on win32 — the sibling-test resolver and the rendered file
// allowlist both expect forward slashes (plan 3624, findings 102d50/c6c779/371bd7/48db1a), so this
// routes the result through the canonical `normalizeRel` (main-checkout-allowlist.mjs) rather than
// hand-rolling a second copy of that normalization.
//
// plan 3624 round 2 tried to also cover a Windows-absolute path recorded on a POSIX-reading host
// (the routine cloud-drain case: a findings sidecar written on the Windows checkout, read on a
// Linux runner) by detecting a drive-letter prefix and lexically string-prefix-stripping it. A
// scoped re-review of that mechanism came back with ~21 CONFIRMED findings against it — it
// compared paths case-sensitively where Windows is not, it accepted `..`-escaping paths because
// containment was tested before dot-segments were canonicalized, and it could not work in
// principle: `root` here is always the READING host's own repo root, so a Windows-written
// absolute path has no prefix relationship with a POSIX root to strip in the first place — there
// is no string manipulation that recovers the repo-relative path in that case, because the
// writing host's root is simply not knowable from here. Round 3 deletes that mechanism. A finding
// path recorded on a host whose absolute-path style differs from the reading host's is left as-is
// (`_path.isAbsolute` is false for it here) — the sibling-test lookup below just misses for such a
// path, which is a degraded brief, not a wrong one. Round 4 makes that "left as-is" literal: such
// a path is returned BYTE-IDENTICAL rather than run through normalizeRel, which would otherwise
// rewrite `C:\repo\x.mjs` to `C:/repo/x.mjs` — a path that resolves no better and no longer
// matches what was recorded (findings c0f9f4 / 3a58c5).
// Drive-letter AND UNC (`\\server\share\…`): both are rooted on the writing host and equally
// unresolvable here, so both are preserved byte-identically rather than half-normalized into a
// path that resolves no better and no longer matches what was recorded (plan 3657 review cbb528
// extends this from the drive-letter-only form).
const FOREIGN_ABSOLUTE_RX = /^([A-Za-z]:[\\/]|\\)/;
export function toRepoRelative(root, file, _path = nodePath) {
  if (typeof file !== 'string' || !file) return file;
  // A drive-letter path the reading host does not consider absolute belongs to the other host:
  // preserve it verbatim instead of half-normalizing a path we cannot resolve anyway.
  if (!_path.isAbsolute(file)) return FOREIGN_ABSOLUTE_RX.test(file) ? file : normalizeRel(file);
  const rel = normalizeRel(_path.relative(root, file));
  // Parent-escape is a SEGMENT test, not a prefix test: `..hidden/foo.ts` is an ordinary in-repo
  // file whose name merely starts with two dots, and only `..` or a `../` prefix leaves the root
  // (findings 2f9984 / 24d9cc / 4bcadc / 632e9d).
  const escapesRoot = rel === '..' || rel.startsWith('../');
  return rel && !_path.isAbsolute(rel) && !escapesRoot ? rel : file;
}

// May this path be handed to the fix worker as something it MAY modify? Containment is checked
// lexically AND after symlinks resolve, because a link inside the checkout can point anywhere
// outside it (plan 3623 round-4 finding 83cf67); a backtick or newline is refused outright since
// the allowlist is rendered as a markdown code span and neither can occur in a real repo path.
//
// A FOREIGN-ABSOLUTE path (`C:\…`) is refused here on BOTH hosts, not just the one that calls it
// absolute. `nodePath.isAbsolute` alone is a host-relative test: on a POSIX reader a drive-letter
// path is not absolute at all — backslashes are ordinary filename characters — so `resolve()`
// would place it INSIDE the root and this authorization would hand the fix worker a MAY-modify
// entry for it. That is precisely the cross-host case this module already documents above (a
// findings sidecar written on the Windows checkout, read on a Linux cloud runner), where
// `toRepoRelative` deliberately preserves such a path verbatim for the finding TEXT. The allowlist
// is an authorization, not text, so it must refuse what it cannot resolve — and refuse it
// identically on Windows and Linux rather than only where the host happens to agree.
function realpathOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path; // not present yet — a fix may legitimately create it; the lexical check stands
  }
}

// The deepest ancestor of `abs` that exists, with symlinks resolved. `realpath` throws on a path
// that is not written yet, and the old fallback ("use the unresolved path") is what let a
// not-yet-created file under an ESCAPING DIRECTORY SYMLINK pass containment: the link is resolvable
// right now even though the leaf is not (plan 3657 review finding ccea64). Walking up finds the
// escape at the link, while a genuinely new file under a real in-repo directory still resolves to
// that directory and stays contained.
function realpathNearestExisting(abs) {
  let current = abs;
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      // realpath failed. If the entry nevertheless EXISTS as a link (lstat sees a dangling
      // symlink, where realpath cannot), we must not keep walking up: its target is
      // unresolvable, so containment is unknowable and the only safe answer is "outside".
      // Walking past it is what let a dangling escape link pass (review finding c839b3).
      try {
        lstatSync(current);
        return null;
      } catch {
        /* genuinely absent — a fix may create it; keep walking up */
      }
      const parent = nodePath.dirname(current);
      if (parent === current) return abs; // reached the filesystem root without an existing ancestor
      current = parent;
    }
  }
}

// A `..` SEGMENT is refused outright rather than resolved. `resolve()` collapses `link/../x`
// LEXICALLY, to `root/x`, while the filesystem would follow `link` first and land somewhere else
// entirely — so a lexical containment check on a path containing `..` is answering a different
// question from the one that matters (review finding 0c85d2). No legitimate finding path needs a
// parent segment, so refusing the whole shape is both simpler and strictly safer than modelling
// it. This is narrower than `toRepoRelative`'s rule above, which only refuses `..` that ESCAPES —
// right for finding TEXT, too weak for an authorization.
export function containedRepoPath(root, file) {
  if (
    typeof file !== 'string' ||
    !file ||
    /[`\r\n]/.test(file) ||
    nodePath.isAbsolute(file) ||
    FOREIGN_ABSOLUTE_RX.test(file) ||
    file.split(/[\\/]/).includes('..')
  ) {
    return null;
  }
  const rootAbs = realpathOrSelf(resolve(root));
  const inside = (p) => p !== null && (p === rootAbs || p.startsWith(rootAbs + nodePath.sep));
  const abs = resolve(rootAbs, file);
  return inside(abs) && inside(realpathNearestExisting(abs)) ? file : null;
}

function typescriptSiblingTest(root, file) {
  if (!/\.tsx?$/i.test(file) || /\.test\.tsx?$/i.test(file)) return null;
  const candidate = file.replace(/(\.tsx?)$/i, '.test$1');
  return existsSync(join(root, candidate)) ? candidate : null;
}

function cannotBriefLines(unbriefable) {
  return unbriefable.length === 0
    ? []
    : ['', '## Cannot brief — fix the sidecar', '', ...unbriefable.map((r, i) => `${i + 1}. ${r}`)];
}

export function renderReviewFixBrief(
  slug,
  record,
  { root = process.cwd(), planExists = () => false } = {},
) {
  const findings = canonicalizeFindings(record?.findings);
  const byIdentity = new Map();
  const unbriefable = [];
  for (const finding of findings) {
    if (finding && 'malformedIndex' in finding) {
      unbriefable.push(finding.malformedReason);
      continue;
    }
    // plan 3623 item 4: the brief owes a fix round for exactly the set that BLOCKS THE LAND, so it
    // routes through the same exported predicate findingsGate and record-review use. The old
    // `!isMustFixFinding(finding) || classifyFinding(...) === 'ok'` was the same partition bug item
    // 4 fixed in findingsGate: an ADVISORY finding whose `plan` disposition names a plan that does
    // not exist halts the land, but was skipped here — so the brief said "no fix round is owed"
    // about work the land refuses to let through. review-fix-brief is the FOURTH consumer of that
    // partition, found by sweeping every caller rather than fixing only the reported one.
    if (!findingBlocksLand(finding, planExists)) continue;
    const file = toRepoRelative(root, finding.file);
    const normalized = file === finding.file ? finding : { ...finding, file };
    const key = findingKey(normalized.file, normalized.line, normalized.summary);
    if (!byIdentity.has(key)) byIdentity.set(key, normalized);
  }
  const mustFix = [...byIdentity.values()];
  if (mustFix.length === 0) {
    const lines = [
      `No fix round is owed for ${slug}: the must-fix set is empty.`,
      ...cannotBriefLines(unbriefable),
    ];
    return `${lines.join('\n')}\n`;
  }

  const files = [];
  const missingPairedTests = new Set();
  for (const finding of mustFix) {
    // We want only culpritTestTargets' sibling-test fallback, which is the canonical
    // existence-checked resolver (it knows this repo's backend/scripts/__tests__/test_<name>.py
    // convention). Its plan-glob branch runs first and is keyed on a culprit PLAN id, which we do
    // not have here; a NUL id cannot appear in any filename, so that branch always misses and the
    // fallback is what answers. siblingTestTargetFor itself is private to that module (plan 3624
    // finding 1fmpbbg: the clean fix is exporting a shared resolver from
    // assert-no-landed-reversion.mjs, which is outside this plan's file allowlist — reported, not
    // fixed here). finding.file is already repo-relative by this point (toRepoRelative above).
    const NO_CULPRIT_PLAN = '\0';
    const paired =
      culpritTestTargets(root, {
        path: finding.file,
        plans: [{ id: NO_CULPRIT_PLAN }],
      })[0]?.targets[0] || typescriptSiblingTest(root, finding.file);
    if (!paired) missingPairedTests.add(finding.file);
    for (const file of [finding.file, paired]) {
      // plan 3623 round-4 findings 28f6b1 / f467bb / 2122f2 / 1d8018: this list is an
      // AUTHORIZATION — it is what the dispatched fix worker is told it MAY modify — so every path
      // entering it is checked for containment. `toRepoRelative` above deliberately returns a
      // repo-escaping or foreign-absolute path UNCHANGED (it cannot resolve one, and rewriting it
      // would only make it less faithful to what was recorded), which is right for the finding
      // TEXT but must not carry into the allowlist: `{file:'../../outside.mjs', summary:'…'}` would
      // otherwise authorize an edit outside the checkout. A rejected path is still named in the
      // findings section below — naming the lead is the point, authorizing it is not.
      if (!file || files.includes(file)) continue;
      if (!containedRepoPath(root, file)) continue;
      files.push(file);
    }
  }
  const dispositions = findings.flatMap((finding) => {
    if (finding && 'malformedIndex' in finding) return [];
    const d = normalizeDisposition(finding?.disposition);
    if (!d) return [];
    return [
      {
        key: findingKey(finding?.file, finding?.line, finding?.summary),
        type: d.type,
        reason: d.reason || d.planId || 'completed',
      },
    ];
  });
  const lines = [
    '## SCOPE — DO NOT EXCEED',
    '',
    `**Goal:** Fix the listed must-fix findings for ${slug}, nothing else.`,
    '',
    '**Files you MAY modify:**',
    ...files.map((file) => `- \`${file}\``),
    ...(missingPairedTests.size > 0
      ? [
          '',
          `No existing paired test file was found for ${missingPairedTests.size} scoped source file(s).`,
        ]
      : []),
    '',
    '**Files you MUST NOT touch:** Everything else.',
    '',
    'Report, do not fix, anything else you notice.',
    '',
    'If the correct fix needs a file outside the allowlist, STOP and report which file and why.',
    '',
    '## Must-fix findings',
    '',
  ];
  mustFix.forEach((finding, index) => {
    lines.push(
      `${index + 1}. **${finding.file}:${finding.line ?? '?'}**`,
      `   - Defect: ${finding.summary || '(no summary recorded)'}`,
      `   - Failure scenario: ${finding.failure_scenario || '(legacy record: failure scenario was not recorded)'}`,
      `   - Adjudicator evidence: ${finding.evidence || '(legacy record: adjudicator evidence was not recorded)'}`,
    );
  });
  lines.push('', '## Fix rules', '', ...FIX_RULES.map((rule) => `- ${rule}`));
  lines.push('', '## Prior-round dispositions', '');
  if (dispositions.length === 0) {
    lines.push('None recorded.');
  } else {
    lines.push(...dispositions.map((item) => `- ${item.key} — ${item.type}: ${item.reason}`));
  }
  lines.push(...cannotBriefLines(unbriefable));
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const [slug, ...rest] = argv;
  if (!slug || slug.startsWith('--')) throw new Error('a plan slug is required');
  const args = { slug };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!['--round', '--round-dir', '--sidecar', '--out'].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    args[flag.slice(2).replace('-', '')] = value;
  }
  const round = Number.parseInt(args.round, 10);
  if (!Number.isSafeInteger(round) || round < 1 || String(round) !== args.round) {
    throw new Error('--round requires a positive integer');
  }
  if (args.rounddir && args.sidecar) throw new Error('use --round-dir or --sidecar, not both');
  return { ...args, round };
}

function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    env: gitRepoIsolatedEnv(),
  }).trim();
}

function readFindingsRecord(file) {
  const record = parseFindingsRecord(readFileSync(file, 'utf8'));
  if (!record) throw new Error(`invalid findings record: ${file}`);
  return record;
}

// plan 3624 finding g7ywnq: this used to hand-roll findings normalization — an independent copy
// of what findingWithCanonicalKey already computes, which could drift from the canonicalizer AND
// (since it hashed file/line/summary without ever checking for "no file") mismatched a malformed
// entry from one side against a malformed entry from the other, both hashing to the same
// "empty everything" key. Canonicalizing both sides through the shared parseFindingsRecord entry
// point — same one renderReviewFixBrief uses — fixes the malformed half: a malformed entry is
// skipped on either side rather than colliding. Identity itself stays the CONTENT hash
// (findingKey on file/line/summary), never the finding's own stored `.key` — two reports of the
// same defect routinely carry different raw keys (round-to-round re-scans, different finder
// angles), and matching on the raw key would treat them as unrelated findings.
function mergePriorDispositions(record, prior, root) {
  if (!prior || prior === record) return record;
  const priorFindings = canonicalizeFindings(prior.findings);
  const currentFindings = canonicalizeFindings(record.findings);
  // The main render loop normalizes finding.file via toRepoRelative BEFORE computing its identity
  // key; this merge ran earlier and skipped that step, so a prior-round finding recorded with an
  // ABSOLUTE path hashed to a different identity than the same defect recorded relative, and its
  // wontfix/deferred-by-tag disposition silently failed to carry over (plan 3624, findings
  // 94a23c/b9994a). Same normalization, same root, here.
  const identity = (finding) => {
    const file = root ? toRepoRelative(root, finding.file) : finding.file;
    return findingKey(file, finding.line, finding.summary);
  };
  const priorDisposed = new Map();
  for (const finding of priorFindings) {
    if ('malformedIndex' in finding) continue;
    const disposition = normalizeDisposition(finding.disposition);
    if (['wontfix', 'deferred-by-tag'].includes(disposition?.type)) {
      priorDisposed.set(identity(finding), { ...finding, disposition });
    }
  }
  const currentKeys = new Set();
  const findings = currentFindings.map((finding) => {
    if ('malformedIndex' in finding) return finding;
    const key = identity(finding);
    currentKeys.add(key);
    return Object.hasOwn(finding, 'disposition') || !priorDisposed.has(key)
      ? finding
      : { ...finding, disposition: priorDisposed.get(key).disposition };
  });
  for (const [key, finding] of priorDisposed) if (!currentKeys.has(key)) findings.push(finding);
  return { ...record, findings };
}

export function writeBriefOutput(
  brief,
  outFile,
  { write = writeFileSync, mkdir = mkdirSync } = {},
) {
  if (!outFile) {
    process.stdout.write(brief);
    return;
  }
  const resolved = resolve(outFile);
  // plan 4078 fix round 2 (gpt-review keys 72590e/594a32): create the parent. The T1 fix-brief
  // denial hands the operator `--out <the slug-keyed default>`, and that directory need not exist
  // — a plan whose review artifacts were never written, or a cleaned .scratch, has no such folder.
  // Without this the remedy ENOENTs and the launch stays denied with no brief produced, which is
  // the same dead-end the round-1 fix (a command that wrote nothing at all) already closed once.
  mkdir(nodePath.dirname(resolved), { recursive: true });
  write(resolved, brief);
}

// The reviewed HEAD's own commits, unioned with origin/master (plan 3624 finding 31x9yl): a
// plan minted ON the branch under review — committed there, not yet on origin/master — must
// still resolve as existing. `git ls-tree` reads a REF's tree directly (unlike `ls-files
// --with-tree=<ref>`, which — without --error-unmatch — is a no-op and silently lists the
// index instead, the bug this replaces); each ref is resolved independently so an absent
// origin/master (fresh clone, throwaway repo) never blanks out what the reviewed HEAD itself
// carries.
function planIdsTreeText(root, refs) {
  const parts = [];
  for (const ref of refs) {
    try {
      parts.push(
        execFileSync(
          'git',
          ['-C', root, 'ls-tree', '-r', '--name-only', ref, '--', 'docs/superpowers/plans/'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitRepoIsolatedEnv() },
        ),
      );
    } catch {
      // This ref doesn't resolve here (never fetched, detached/empty repo, …) — it contributes
      // no entries; every plan checked only against it reads as absent, same as before.
    }
  }
  return parts.join('\n');
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    let record;
    let root;
    let headSha = null;
    const captureHeadSha = () => {
      try {
        return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
          env: gitRepoIsolatedEnv(),
        }).trim();
      } catch {
        return null; // detached/empty repo: the reviewed-HEAD half of the plan-listing is skipped.
      }
    };
    if (args.sidecar) {
      record = readFindingsRecord(resolve(args.sidecar));
      // plan 3624 finding hdosru: the explicit override used to skip the same-plan-sidecar check
      // the default path applies below — a brief could be built from another plan's sidecar.
      const ownerConflict = sidecarOwnerConflict(record, args.slug, args.sidecar);
      if (ownerConflict) throw new Error(ownerConflict);
      // plan 3624 finding 7ecc67: the acceptance-bullet-2 "state the source out loud" line was
      // only ever printed on the default path — the explicit --sidecar override stayed silent
      // about where its brief came from. Same wording, same site in the flow.
      console.error(`review-fix-brief: brief source: explicit --sidecar ${resolve(args.sidecar)}`);
      try {
        root = repoRoot();
      } catch {
        root = process.cwd(); // --sidecar has never required running inside a git checkout.
      }
      headSha = captureHeadSha();
    } else {
      root = repoRoot();
      headSha = captureHeadSha();
      const priorRead = readSidecarForSlug(root, args.slug, loadCoordConfig(root).paths, {
        headSha,
      });
      if (priorRead?.refuse) throw new Error(priorRead.refuse);
      const prior = priorRead?.rec || null;
      const ownerConflict = sidecarOwnerConflict(prior, args.slug, 'the routed findings sidecar');
      if (ownerConflict) throw new Error(ownerConflict);
      // plan 3624 findings 1yw98m2 + m57y8f: reviewFindingsPath is the ONE place gpt-review's
      // real (flat, slug-keyed) --out layout is derived; --round no longer selects a directory,
      // since the writer never creates one per round. --round-dir stays a full override.
      const findingsFile = args.rounddir
        ? join(resolve(args.rounddir), 'findings.json')
        : reviewFindingsPath(root, args.slug);
      const usingRoundArtifact = existsSync(findingsFile);
      if (!usingRoundArtifact && !prior) {
        throw new Error(
          `no findings at ${findingsFile} and no session sidecar exists for ${args.slug}`,
        );
      }
      // plan 3624 acceptance bullet 2: state the source out loud, every time — a silent fallback
      // to the sidecar is indistinguishable from success and can brief a worker on a stale round.
      console.error(
        usingRoundArtifact
          ? `review-fix-brief: brief source: round artifact at ${findingsFile}`
          : `review-fix-brief: brief source: routed session sidecar (no round artifact at ${findingsFile})`,
      );
      record = usingRoundArtifact
        ? { findings: JSON.parse(readFileSync(findingsFile, 'utf8')) }
        : prior;
      record = mergePriorDispositions(record, prior, root);
    }
    const planFiles = planIdsTreeText(root, [
      ...new Set(['origin/master', headSha].filter(Boolean)),
    ]);
    const brief = renderReviewFixBrief(args.slug, record, {
      root,
      planExists: (id) => planIdInTree(planFiles, id),
    });
    writeBriefOutput(brief, args.out);
  } catch (error) {
    console.error(`review-fix-brief: ${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
