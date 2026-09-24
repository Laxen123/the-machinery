#!/usr/bin/env node
// scripts/lint-filename-execmodel-drift.mjs — pre-push guard: the filename `FABLE-`/
// `SOL-` segment and the frontmatter `execModel:` field must agree (plan 1292 work
// item 4c; extended to `sol` by plan 3341).
//
// WHY: plan 1292 work item 4 makes a fable-routed plan's basename carry a `FABLE-`
// segment right after the numeric id (`NNNN-FABLE-Category-slug.md`) so the VS Code
// file tree — what the operator actually reads, per the same-day supersession of the
// INDEX-chip idea — visibly flags it. Plan 3341 gives the `sol` lane the same
// treatment with a `SOL-` segment, mutually exclusive with `FABLE-` in one basename.
// But the orchestrator drain's execModel filter reads the FRONTMATTER field, never
// the filename (filename is display, frontmatter is truth, per the plan's
// work-item-4(b) rule). Without this lint the two can drift independently — a
// hand-renamed file with stale/absent frontmatter, or a frontmatter edit with no
// matching rename — silently misleading either the operator (filename lies) or the
// drain (frontmatter lies). scripts/stamp-exec-model.mjs is the ONE sanctioned tool
// that keeps them in lockstep; this lint is the backstop that catches anything else
// (a hand `git mv`, a hand-edited frontmatter) that skipped it.
//
// RULE (same shape for both marker segments; `FABLE-`/`execModel: fable` below reads
// identically for `SOL-`/`execModel: sol`):
//   • pending-approval/, ready/, waiting-*/ — TWO-WAY: a `FABLE-` segment without
//     `execModel: fable` is an error; `execModel: fable` without the segment is an
//     error. The rename only ever happens at stamp time in these folders, so the two
//     should never legitimately diverge.
//   • in-progress/ — ONE-WAY: a `FABLE-` segment REQUIRES `execModel: fable` (a
//     picked-up plan's frontmatter must not silently drift off what its filename still
//     claims); but `execModel: fable` WITHOUT the segment is ALLOWED — stamp-exec-model
//     refuses to rename in-progress/ (the basename is coupled to the worktree
//     slug/branch there), so a fable plan picked up before this plan's filename
//     convention existed, or a plan whose spec-pass ran post-pickup, legitimately has
//     no segment.
//   • archive/ — skipped entirely (closed, nothing to route).
//   • A basename can never carry BOTH a `FABLE-` and a `SOL-` segment — not merely by
//     convention, but structurally: hasFableSegment/hasSolSegment below are both
//     anchored at the identical position (right after `\d{3,}-`) and each demands a
//     DIFFERENT literal there, so whatever text actually sits at that position can
//     match at most one of them. No separate detection code exists for this (there is
//     nothing for it to catch).
//
// SCOPE (plan 2540): `.husky/pre-push` diff-scopes only WHETHER this gate runs (a push
// touching plans/), not WHAT it scans once running — it used to always scan the whole
// tracked corpus via `git ls-files`, so a stray drifted plan ANYWHERE blocked every other
// session's push that merely touched a different plan file. The hook now pipes its
// already-computed `$CHANGED` list on stdin (one repo-relative path per line, same contract
// as select-battery-tests.mjs); this scopes the scan to those paths. `--all` forces the old
// corpus-wide sweep (board-pass / a manual full check) and takes priority over stdin. With
// no `--all` and no piped stdin (an interactive manual run), this falls back to a full
// sweep too — only the automated hook path is scoped. A push that touches TOOLING_PATHS
// (this lint, or a module it reads its rules from) also forces a full sweep regardless of
// what else is in the diff — see resolveLintChangeScope in build-index-lib.mjs, the shared
// scoping logic this file and its plan-priority sibling both use.
//
// Exit codes: 0 clean · 1 drifted (push blocked) · 2 error.

import { readFileSync, existsSync } from 'node:fs';
// plan 2615: the shared reader (bounded EAGAIN retry + a temp-file diagnostic). Was a local
// `readFileSync(0)` in a bare catch, which made a Windows read failure indistinguishable from
// empty input — the silent-skip class this plan exists to close. Fail-open shape unchanged.
import { readStdin } from './stdin-read.mjs';
import { execFileSync } from 'node:child_process';
import { gitRepoIsolatedEnv } from './child-env.mjs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  readFrontmatterScalar,
  resolveLintChangeScope,
  ARCHIVE_FOLDER,
  PARKED_FOLDER,
  IN_PROGRESS_FOLDER,
} from './build-index-lib.mjs';
// plan 3341 code-review follow-up: the marker vocabulary itself (hasFableSegment/
// hasSolSegment/LANE_SEGMENTS) moved to a dependency-free leaf module so build-index-lib.mjs
// and done-worktree-lib.mjs can derive their OWN basename grammars from it without importing
// this file — which imports build-index-lib.mjs above, so a reverse import from there would be
// a real two-file cycle. Re-exported below under the SAME names so every existing importer of
// this file (batches-view.mjs, done-worktree.mjs, exec-model-stamp.mjs, move-plan.mjs,
// ready-board.mjs, and this file's own tests) is unaffected.
import { hasFableSegment, hasSolSegment, LANE_SEGMENTS } from './plan-lane-segments.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';
export { hasFableSegment, hasSolSegment, LANE_SEGMENTS };

const REPO_ROOT = repoRootFrom(dirname(fileURLToPath(import.meta.url)));
const PLANS_PREFIX = 'docs/superpowers/plans/';
// A push touching any of these forces a full-corpus sweep (see resolveLintChangeScope) —
// this lint's own source, or a module it derives its validation rules from.
const TOOLING_PATHS = [
  'scripts/lint-filename-execmodel-drift.mjs',
  'scripts/stamp-exec-model.mjs',
  'scripts/coord/plan-lane-segments.mjs',
];

// The marker-only view this file's own drift check reads, DERIVED from LANE_SEGMENTS so
// the marker strings have exactly one source. `sonnet` (and any unrecognized value,
// INCLUDING a JS-prototype property name like `constructor`/`toString`) resolves to
// null, i.e. wants no segment at all.
//
// plan 3341 delta-review follow-up (key bfefd8): this used to be a bare `{ [lane]:
// marker }` object indexed as `SEGMENT_FOR_LANE[execModel]` — a plain object literal
// (Object.fromEntries) inherits Object.prototype, so `execModel: constructor` resolved
// through the prototype chain to the Object constructor FUNCTION (a truthy,
// non-string "segment") instead of `undefined`. That printed the function's own source
// text (`function Object() { [native code] }`) into the operator-facing drift message
// and — because `wantedSegment` was then treated as a real segment-bearing lane —
// built a remediation command (`stamp-exec-model.mjs <base> constructor`) the stamping
// tool itself refuses, a blocked push with unusable advice. wantedSegmentFor below finds
// the lane by STRICT EQUALITY against LANE_SEGMENTS' own `lane` field rather than by
// indexing a string into an object, so no prototype-chain name can ever resolve to
// anything but the intended `null`.
function wantedSegmentFor(execModel) {
  const seg = LANE_SEGMENTS.find(({ lane }) => lane === execModel);
  return seg ? seg.marker : null;
}

// Read `execModel:` and normalise it — readFrontmatterScalar (build-index-lib.mjs)
// already strips a trailing YAML inline comment the same way plan-body-state.mjs's
// getUnblock does for `unblock:` (some hand-stamped fable plans carry an
// explanatory comment after the value, e.g.
// `execModel: fable # umbrella tracker — NOT drain-eligible`); this just
// lowercases on top so the comparison is case-insensitive. Returns '' when the
// plan has no frontmatter or no execModel key.
export function readExecModel(content) {
  return readFrontmatterScalar(content, 'execModel').toLowerCase();
}

// pure: given [{ path, content }] (repo-relative plan path + its text), return one
// { basename, message } per drifted plan. `path` must be
// `docs/superpowers/plans/<status>/<basename>.md`.
export function findExecModelDrift(entries) {
  const problems = [];
  for (const { path, content } of entries) {
    const rel = path.slice(PLANS_PREFIX.length);
    const status = rel.split('/')[0];
    if (status === ARCHIVE_FOLDER) continue; // closed — never gated
    if (status === PARKED_FOLDER) continue; // frozen long-term (plan 1426) — filename never churns on a park
    const base = basename(path);
    // plan 3341 delta-review follow-up (key 179dd6): actualSegment used to be a
    // hardcoded two-way ternary over hasFableSegment/hasSolSegment BY NAME — a THIRD
    // segment-bearing lane (one new LANE_SEGMENTS row, nothing else) would leave a
    // correctly-marked plan for that lane looking markerless here, and this lint would
    // then report it as MISSING a segment it structurally already carries, hard-blocking
    // every push touching that lane's plans. Routed through LANE_SEGMENTS generically
    // instead — a new lane needs only its LANE_SEGMENTS row, never a new branch here.
    // `.find()` can never need a tie-break: LANE_SEGMENTS' predicates are anchored at the
    // identical position (right after `\d{3,}-`) and each demands a DIFFERENT literal
    // there, so whatever literal text actually sits at that position can match at most
    // one row — a structural guarantee, not a checked invariant.
    const matchedSegment = LANE_SEGMENTS.find(({ test }) => test(base));
    const actualSegment = matchedSegment ? matchedSegment.marker : null;
    const execModel = readExecModel(content);

    // resolver-driven (plan 3341): the wanted segment is whichever LANE_SEGMENTS row's
    // `lane` matches the CURRENT execModel (null ⇒ sonnet/unrecognized ⇒ no segment at
    // all), and "does the basename's actual marker agree with it" replaces the old
    // `isFable` single-lane boolean.
    const wantedSegment = wantedSegmentFor(execModel);
    const agrees = wantedSegment ? wantedSegment === actualSegment : actualSegment === null;
    if (agrees) continue;

    if (status === IN_PROGRESS_FOLDER) {
      // one-way: an actual marker segment REQUIRES the matching execModel. execModel-
      // without-segment is allowed (stamp-exec-model never renames in-progress/).
      if (actualSegment) {
        // plan 3341 review round 3 (keys 48ff8d/4a7d7a): read the lane off the row that
        // ALREADY matched (matchedSegment, above) instead of re-deriving it from the marker
        // string with a hardcoded FABLE-vs-sol binary — with exactly two lanes today that
        // binary was accidentally correct, but a third segment-bearing lane (say `opus` /
        // `OPUS-`) would have been reported here as wanting "sol", and the remediation
        // command below would then try to rename the plan TOWARD sol instead of opus.
        const wantModel = matchedSegment.lane;
        problems.push({
          basename: base,
          message:
            `${base} (in-progress/): filename carries a ${actualSegment} segment but ` +
            `frontmatter execModel is "${execModel || '(none)'}", not "${wantModel}". ` +
            `stamp-exec-model refuses to rename in-progress/ plans — fix the frontmatter ` +
            `directly (execModel: ${wantModel}).`,
        });
      }
      continue;
    }

    // two-way (pending-approval/, ready/, any waiting-*/)
    if (actualSegment && actualSegment !== wantedSegment) {
      // plan 3341 review round 3 (keys 48ff8d/4a7d7a): same fix as the in-progress/ branch
      // above — the matched row's own `.lane` field, never a re-derived FABLE-vs-sol guess.
      const wantModel = matchedSegment.lane;
      problems.push({
        basename: base,
        message:
          `${base} (${status}/): filename carries a ${actualSegment} segment but ` +
          `frontmatter execModel is "${execModel || '(none)'}", not "${wantModel}". Run: ` +
          `node scripts/stamp-exec-model.mjs ${base} ${wantModel}`,
      });
    } else if (!actualSegment && wantedSegment) {
      problems.push({
        basename: base,
        message:
          `${base} (${status}/): frontmatter execModel: ${execModel} but the filename ` +
          `carries no ${wantedSegment} segment. Run: node scripts/stamp-exec-model.mjs ` +
          `${base} ${execModel}`,
      });
    }
  }
  return problems;
}

// `changedPaths == null` ⇒ full corpus sweep via `git ls-files`. Otherwise, read exactly
// the changed plan paths directly off disk (plan 2540 review fix) — NOT an intersection
// against a separate `git ls-files` listing of the CURRENT checkout, which could silently
// drop a path the pushed commit touched but that no longer matches the working tree (e.g.
// a worktree whose HEAD has since moved). A changed path that no longer exists on disk
// (deleted/renamed away later in the same push) has nothing left to lint — skipped, not
// an error.
function trackedPlans(changedPaths) {
  if (changedPaths) {
    return changedPaths
      .filter((rel) => existsSync(join(REPO_ROOT, rel)))
      .map((rel) => ({ path: rel, content: readFileSync(join(REPO_ROOT, rel), 'utf8') }));
  }
  const out = execFileSync('git', ['ls-files', `${PLANS_PREFIX}*.md`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: gitRepoIsolatedEnv(),
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((rel) => ({ path: rel, content: readFileSync(join(REPO_ROOT, rel), 'utf8') }));
}

export function main() {
  const forceAll = process.argv.slice(2).includes('--all');
  let changedPaths = null;
  if (!forceAll && !process.stdin.isTTY) {
    let raw = '';
    try {
      raw = readStdin();
    } catch {
      raw = '';
    }
    changedPaths = resolveLintChangeScope(raw, {
      plansPrefix: PLANS_PREFIX,
      toolingPaths: TOOLING_PATHS,
    });
  }
  let entries;
  try {
    entries = trackedPlans(changedPaths);
  } catch (e) {
    console.error('lint-filename-execmodel-drift: could not list plan files:', e.message);
    return 2;
  }
  const problems = findExecModelDrift(entries);
  if (problems.length === 0) return 0;

  console.error('');
  console.error(
    'lint-filename-execmodel-drift: FABLE- filename marker / execModel frontmatter drift:',
  );
  for (const p of problems) console.error(`  - ${p.message}`);
  console.error('');
  console.error('  Emergency escape: git push --no-verify (but fix the drift first).');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
