#!/usr/bin/env node
// scripts/lint-coord-trailer.mjs  (plan 421, Plan B)
// Reject any commit in the pushed range that mutates a guarded coordination doc
// (handoff-board.md, or the INDEX:PLANS generated region of docs/INDEX.md) WITHOUT a
// `Coord-Write:` trailer — i.e. a hand-edited / multi-step write that bypassed the
// coord tools (board.mjs / index.mjs / move-plan.mjs / next-plan-id.mjs claim), all
// of which route through coordWrite (or stamp the trailer) and so never trip this.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { INDEX_PLANS_START, INDEX_PLANS_END } from './coord/build-index-lib.mjs';
import { GIT_MAXBUFFER, resolveGuardRanges, errText } from './coord/coord-git.mjs';
import { loadCoordConfig, LEGACY_PATHS } from './coord/coord-config.mjs';

const TRAILER_RX = /^Coord-Write:\s*\S+/m;
export const hasTrailer = (msg) => TRAILER_RX.test(msg);

export function commitNeedsTrailer({ files, indexTouchesGenerated, paths = LEGACY_PATHS }) {
  if (files.includes(paths.boardFile)) return true;
  // plan 3973: the landing queue doc (plan 504) is no longer guarded here — it lives on the
  // coord ref refs/heads/coord/landing-queue, and the master-side file is a one-line tombstone
  // the cut-over land / `landing-queue.mjs migrate` writes. A hand edit of the tombstone is
  // caught by the readers' loud-fail (landing-queue-ref.mjs), not by a trailer.
  if (files.includes('docs/INDEX.md') && indexTouchesGenerated) return true;
  return false;
}

// Given the post-image lines of docs/INDEX.md and the 1-based changed line numbers
// from the commit's diff, is any change inside the INDEX:PLANS sentinels?
export function indexHunkInGenerated(lines, changedLineNos) {
  const start = lines.findIndex((l) => l.includes(INDEX_PLANS_START));
  const end = lines.findIndex((l) => l.includes(INDEX_PLANS_END));
  if (start === -1 || end === -1) return true; // sentinels missing → be strict
  return changedLineNos.some((n) => n - 1 >= start && n - 1 <= end);
}

// 1-based post-image line numbers touched by a commit's diff of one file, from the
// `-U0` hunk headers. A pure-deletion hunk (`+n,0`) records the boundary line `n`
// so removing a generated bullet still counts as a generated-region edit.
function changedLineNos(diff) {
  return [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].flatMap((m) => {
    const s = +m[1];
    const c = m[2] === undefined ? 1 : +m[2];
    if (c === 0) return [s];
    return Array.from({ length: c }, (_, k) => s + k);
  });
}

function main() {
  // Resolve config from the repo being CHECKED (the cwd the guard runs in), not this
  // script's location — so the guard matches that repo's coord.config.json (plan 857).
  const { paths } = loadCoordConfig(process.cwd());
  // Ranges come as argv[2..] (plan 1289): the pre-push hook passes the per-ref
  // pushed-delta ranges compute-push-diff.mjs resolves (one per pushed ref, so a
  // rare multi-ref push carries several); CI passes its single <BASE>..HEAD. With
  // no args, resolveGuardRanges falls back to origin/master..HEAD (manual
  // invocation). Commit sets of all ranges are unioned (deduped). A single
  // range's rev-list failure SKIPS THAT RANGE with a visible warning and keeps
  // checking the others — never a silent drop (invisible partial coverage), and
  // never an all-ranges abort (an un-trailered commit in a perfectly-resolvable
  // sibling range must still block); CI + the next push re-check the skipped
  // range.
  const ranges = resolveGuardRanges(process.cwd());
  if (ranges === null) {
    console.warn(
      'lint-coord-trailer: SKIPPED (origin/master unresolvable — CI + the next push re-check).',
    );
    return 0;
  }
  // pass 1307: a MERGE-BEARING branch push (the plan-507 freshen flow) carries
  // origin/master's own history inside its pushed range — those commits landed
  // through their own push gates (incl. this one) and the coord tools' trailers
  // live on master; re-linting them here flagged 26 master commits on the first
  // post-flip freshen push. Exclude commits already reachable from
  // origin/master; when it is unresolvable, fall back to the unexcluded range
  // (same fail-open shape as resolveGuardRanges).
  let notMaster = [];
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'origin/master'], {
      encoding: 'utf8',
    });
    notMaster = ['--not', 'origin/master'];
  } catch {
    /* origin/master unresolvable — lint the raw range */
  }
  const shaSet = new Set();
  for (const range of ranges) {
    try {
      for (const sha of execFileSync('git', ['rev-list', range, ...notMaster], {
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean))
        shaSet.add(sha);
    } catch (e) {
      console.warn(
        `lint-coord-trailer: range ${range} SKIPPED (rev-list failed — transient shared-.git ` +
          `churn?; CI + the next push re-check it). Other ranges still checked. [${errText(e)}]`,
      );
    }
  }
  const shas = [...shaSet];
  const offenders = [];
  for (const sha of shas) {
    const files = execFileSync('git', ['show', '--name-only', '--format=', sha], {
      encoding: 'utf8',
      maxBuffer: GIT_MAXBUFFER, // plan 850: a large-data commit's name-only list overflows the 1MB default (pre-push + CI)
    })
      .split('\n')
      .filter(Boolean);
    let indexTouchesGenerated = false;
    if (files.includes('docs/INDEX.md')) {
      try {
        const diff = execFileSync('git', ['show', '--format=', '-U0', sha, '--', 'docs/INDEX.md'], {
          encoding: 'utf8',
        });
        const lines = execFileSync('git', ['show', `${sha}:docs/INDEX.md`], {
          encoding: 'utf8',
        }).split('\n');
        indexTouchesGenerated = indexHunkInGenerated(lines, changedLineNos(diff));
      } catch {
        indexTouchesGenerated = true; // can't resolve the post-image (e.g. deletion) → strict
      }
    }
    if (commitNeedsTrailer({ files, indexTouchesGenerated, paths })) {
      const msg = execFileSync('git', ['show', '-s', '--format=%B', sha], { encoding: 'utf8' });
      if (!hasTrailer(msg)) offenders.push(sha.slice(0, 9));
    }
  }
  if (offenders.length) {
    console.error(
      `lint-coord-trailer: ${offenders.length} commit(s) edited ${paths.boardFile} / the INDEX generated region by hand (no Coord-Write trailer): ${offenders.join(', ')}.\n` +
        `Route shared-doc edits through the coord tools (board.mjs / index.mjs / landing-queue.mjs / move-plan.mjs / next-plan-id.mjs claim) — they call coordWrite and stamp the trailer.\n` +
        `Genuine exception: re-commit through the tool, or bypass with \`git push --no-verify\` (investigate first).`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main());
