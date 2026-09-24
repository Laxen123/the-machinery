#!/usr/bin/env node
// scripts/coord/board-write-gate.mjs  (plan 2378 step 2)
//
// Enforce board-state invariants where board state is WRITTEN, not only at a pre-push
// that the writers never run.
//
// THE ASYMMETRY THIS CLOSES. Every plan-mutating tool (`next-plan-id claim`,
// `edit-plan`, `move-plan`) writes through `withCoordCheckout`'s DISPOSABLE
// coord-checkout (plan 989) and pushes from there. That push runs NO git hooks, for two
// independent reasons (measured 2026-07-25, both confirmed):
//
//   1. PRIMARY — the hook shim does not exist in that checkout. `core.hooksPath` is
//      `.husky/_`, ordinary per-repository config shared by every linked worktree, and
//      it resolves relative to EACH worktree's own top-level directory. But `.husky/_/`
//      is generated, never tracked (`.husky/_/.gitignore` is a bare `*`; `git ls-files
//      .husky/` lists only the three wrapper scripts), and it is materialized solely by
//      the root package.json `prepare` script (`husky`) on `pnpm install`.
//      `resolveCoordCheckout` creates the coord-checkout with a bare
//      `git worktree add --detach` and never installs, so `.husky/_/` is simply absent
//      there. `git hook run pre-push` inside it fails "cannot find a hook named
//      pre-push" while the same command in the main checkout runs the full gate chain.
//   2. SECONDARY — `coordWrite` sets `HUSKY: '0'` in the env it passes to every git
//      invocation including the push (coord-git.mjs), and husky's `.husky/_/h` shim
//      short-circuits `[ "${HUSKY-}" = "0" ] && exit 0`. This is the one that actually
//      fires on the `COORD_MAIN_DIR` path, where `withCoordCheckout` short-circuits onto
//      a checkout that DOES have `.husky/_/`.
//
// Neither is a bug to fix by installing hooks in a disposable, node_modules-less
// checkout — a coord write is a docs-only mutation and must not drag the whole heavy
// gate list (vitest tiers, tsc, next build, the WebKit mobile gate) behind it. So the
// fix is this module: call the CHEAP, PURE board lints directly from the write path.
//
// SCOPED TO WHAT THIS WRITE TOUCHES — the single most important property here. The gate
// reports violations ONLY for plan files named in the write's own `relPaths`. A
// pre-existing violation elsewhere in the corpus is NOT this write's fault, and failing
// it would merely move the "innocent session eats someone else's misfile" wedge earlier
// in time — the exact dynamic plan 2378 exists to end. The pre-push lints remain the
// (advisory) corpus-wide backstop.
//
// NO SECOND COPY OF ANY INVARIANT: every predicate below is imported from the module
// that already owns it — `findStageFolderViolations` from lint-plan-index.mjs,
// `findBlockedByInActiveFolder` from lint-stale-blocked.mjs.
//
// STRICT IMPROVEMENT IS ADMITTED (plan 2892). The gate above is absolute about the
// POST-state, and that absoluteness is what wedged plan bookkeeping at least 7 times
// between 2026-07-30 and 08-04: `stamp-exec-model --spec-review` flips `stage: specced`
// while the plan rests in `pending-approval/` without touching the body, after which the
// plan carries TWO violations at once (the stage/folder one, plus whatever body defect it
// already had). `edit-plan` then refuses EVERY write to that file — including the write
// that FIXES the body defect — because the stage/folder violation survives it; and
// `move-plan <id> ready` refuses on the body defect. Each tool's fix menu prescribes the
// other. The recovery that actually worked, every time, was to hand-craft a
// violation-REDUCING edit; this module now recognises that shape as a rule:
//
//   a write is admitted when, FOR EACH plan file it touches, the post-state violation
//   set is a STRICT SUBSET of that same file's pre-state (HEAD) violation set —
//   at least one violation removed, NONE added, and none substituted.
//
// Equal-count substitution is a refusal, not a pass (operator ruling, plan 2892
// spec-pass): swapping one violation identity for another is not progress. Identity is
// the gate's own `kind` vocabulary — `stage-folder` / `stage-status-prose` /
// `live-blocked-by` — never a parallel classification invented for this rule. And the
// pre-state is read from `HEAD` in the SAME tree, so a file with no pre-image (a freshly
// authored plan) has an empty pre-set and therefore can never claim an improvement: a
// mint must still be clean. The load-bearing property is unchanged — no write that
// increases, or preserves-while-mutating, this file's violations is ever admitted.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { gitRepoIsolatedEnv } from './child-env.mjs';
import { findStageFolderViolations, STAGE_FOLDER_SCOPE } from './lint-plan-index.mjs';
import {
  findBlockedByInActiveFolder,
  LIVE_BLOCKED_FOLDERS,
  PLAN_PATH_RE,
} from './lint-stale-blocked.mjs';
import { makeArchiveIsShipped } from './blocked-by-lib.mjs';
import {
  dropBlockedBy,
  findStageStatusProseViolations as findStageStatusProseViolationsImpl,
} from './plan-body-state.mjs';

// Re-exported so this module stays the address every existing consumer and test knows
// (plan 2892 moved the implementation down to its owner — see the pointer below).
export { findStageStatusProseViolationsImpl as findStageStatusProseViolations };
const findStageStatusProseViolations = findStageStatusProseViolationsImpl;
// readFrontmatterScalar / splitFrontmatter are the SAME frontmatter-scoped readers every
// other stamp check in this repo goes through (plan 2587) — readFrontmatterScalar already
// restricts its scan to the leading `---\n…\n---` fence (frontmatterEnd), so a `stage:` or
// `cloudExec:` token appearing in body PROSE can never be misread as the stamp. No second
// frontmatter parser is written here.
import {
  readFrontmatterScalar,
  splitFrontmatter,
  specVerdictRegions,
  stripFencedBlocks,
  IN_PROGRESS_FOLDER,
} from './build-index-lib.mjs';

// Kept as a local literal rather than imported from move-plan.mjs's export (review
// finding): move-plan.mjs imports THIS module, so importing it back would close a cycle.
// `PLAN_PATH_RE` is imported from lint-stale-blocked.mjs, which owns it — one copy of the
// plan-1002 `(?=[A-Za-z])` guard, not two.
const PLANS_PREFIX = 'docs/superpowers/plans/';

/** Error thrown when a write would introduce a board-state violation. Carries the
 * structured violations so a caller (a test, or a tool wanting a `--force` path) can
 * inspect them rather than re-parsing the message. */
export class BoardInvariantError extends Error {
  constructor(message, violations) {
    super(message);
    this.name = 'BoardInvariantError';
    this.boardInvariantViolations = violations;
  }
}

/** Repo-relative plan paths among `relPaths` (everything else — INDEX, board, session
 * entries — is not this gate's concern). Tolerates absolute paths by suffix match. */
export function planPathsAmong(relPaths) {
  return (relPaths || [])
    .map((p) => String(p).replace(/\\/g, '/'))
    .map((p) => {
      const i = p.indexOf(PLANS_PREFIX);
      return i === -1 ? null : p.slice(i);
    })
    .filter((p) => p && PLAN_PATH_RE.test(p));
}

// Build the id→folder + id→path corpus view the Blocked-by classifier needs. Sourced
// from `git ls-files` against the POST-mutation tree (`dir`) — the same TRACKED-only
// philosophy as build-index/lint-stale-blocked, so an untracked foreign plan a parallel
// session dropped in the checkout can never gate this write. A newly-authored plan is
// not yet tracked at gate time, so its own path is folded in from `relPaths` below.
//
// EXPORTED since plan 2426: the claim paths need the SAME `statusOf`/`isShipped` view to
// decide whether a plan's Blocked-by line is stale (drop it) or live (refuse / require
// `--blocked-ok`). Re-deriving that view anywhere else would be a second corpus reader
// that could disagree with the gate about which blockers are cleared.
//
// ── How fresh is `dir`? (plan 2426 review finding, CONFIRMED) ──────────────────────────
// This function is a pure read of whatever `dir` holds RIGHT NOW; it never fetches. Before
// plan 2426 every caller handed it a tree that had just been cut or reset off origin/master
// (`withCoordCheckout`'s disposable checkout, reset --hard on every retry attempt; or MAIN
// under COORD_MAIN_DIR, an ephemeral detached worktree the spine cuts fresh), so "fresh"
// went without saying. `drain-run`'s call site breaks that: it passes the long-lived SHARED
// main checkout, which persists across drain iterations with no fetch immediately before.
//
// That is ACCEPTED, not overlooked, for one reason: on that path the same tree also feeds
// the ORACLE (`queue-drain.mjs` resolves its own blocked-plan gate against the same
// checkout), so a stale tree makes selection and gating stale TOGETHER — the oracle simply
// does not offer the plan, rather than offering one the gate then wrongly refuses. And in
// the residual case where they do disagree, ruling Q3's posture is fail-safe by
// construction: the drain records a skip and leaves the plan untouched in `ready/`, so the
// worst outcome is one plan deferred to the next run, never a wrong board write.
export function loadCorpusView(dir, planRels) {
  let tracked = [];
  try {
    tracked = execFileSync('git', ['ls-files', `${PLANS_PREFIX}*.md`], {
      cwd: dir,
      encoding: 'utf8',
      env: gitRepoIsolatedEnv(),
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    /* no plans tree / not a repo — fall through with just our own paths */
  }
  const statusMap = new Map();
  const relById = new Map();
  for (const rel of [...tracked, ...planRels]) {
    const m = rel.match(PLAN_PATH_RE);
    if (!m) continue;
    // planRels come LAST on purpose: this write's own (possibly just-moved) location
    // must win over the stale pre-mutation `ls-files` entry for the same id.
    statusMap.set(m[2], m[1]);
    relById.set(m[2], rel);
  }
  return {
    statusOf: (id) => statusMap.get(id) ?? null,
    isShipped: makeArchiveIsShipped(relById, (rel) => readFileSync(join(dir, rel), 'utf8')),
  };
}

/**
 * Collect `{ path, content, basename, folder }` for the plan files this write touches,
 * read from the POST-mutation tree. A path the mutation DELETED (the old side of a
 * `git mv`) is skipped, not a crash — only the destination is judged.
 */
export function collectTouchedPlans(dir, relPaths) {
  const out = [];
  for (const rel of planPathsAmong(relPaths)) {
    let content;
    try {
      content = readFileSync(join(dir, rel), 'utf8');
    } catch {
      continue; // moved-away / deleted by this mutation — nothing to judge at this path
    }
    out.push({ path: rel, content, basename: basename(rel), folder: rel.split('/')[3] });
  }
  return out;
}

/**
 * The write-time gate. Throws BoardInvariantError if THIS write's own plan files would
 * land a board-state violation; returns the (possibly empty) list of violations it
 * ADMITTED under the strict-improvement rule (plan 2892 — see this file's header) so a
 * caller can report what still remains after the write lands.
 *
 * @param {string} dir        the post-mutation tree. FRESHNESS IS THE CALLER'S CONTRACT and
 *        it is NOT uniform across callers — see § "How fresh is `dir`?" below, which plan
 *        2426 added because its two new call sites do not both hand over a just-reset tree.
 * @param {string[]} relPaths the write's pathspec
 * @param {object} [opts]
 * @param {string} [opts.tool] tool name for the error message
 * @param {boolean} [opts.allowLiveBlockedBy] skip ONLY the axis-A live-Blocked-by check
 *        (the `--force` escape hatch on edit-plan; the stage/folder invariant is never
 *        forceable here — routing a specced plan out is always a one-command fix).
 * @param {{statusOf:Function,isShipped:Function}} [opts.corpus] a corpus view the caller
 *        ALREADY built (normally via `loadCorpusView`) for the same `dir` and the same
 *        mutation. Passing it skips the internal rebuild — a `git ls-files` shell-out over
 *        every tracked plan file plus a fresh isShipped cache. Omit and one is built here.
 */
export function assertBoardInvariants(
  dir,
  relPaths,
  { tool = 'coord', allowLiveBlockedBy = false, corpus = null } = {},
) {
  return assertTouched(dir, collectTouchedPlans(dir, relPaths), {
    tool,
    allowLiveBlockedBy,
    corpus,
  });
}

/**
 * The SAME gate, judging a mutation that has NOT been applied to `dir` yet: each entry is
 * `{ path, content }` — the repo-relative path the plan file WILL occupy, and the body it
 * WILL carry.
 *
 * Why this shape exists (plan 2426). The three plan-2378 call sites all mutate a
 * DISPOSABLE coord-checkout, so gating the post-mutation tree costs nothing: a refusal
 * throws and the tree is discarded. The two call sites this plan wires do not have that
 * luxury —
 *
 *   - `claim-plan`'s `projectClaim` / `projectBatchClaim` mutate the coord-checkout inside
 *     a reset-hard-and-reapply retry loop; gating BEFORE the first `writeFileSync`/`git mv`
 *     means a refusal leaves the tree byte-identical to origin/master, with no rename to
 *     un-do (the half-applied-rename hazard edit-plan has to compensate for by hand).
 *   - `drain-run`'s `movePlanOnMaster` mutates the SHARED MAIN checkout directly. There is
 *     no disposable tree to throw away there, so the gate MUST refuse before the working
 *     tree is touched, or an unattended refusal leaves foreign dirt in the checkout every
 *     other parallel session's coord writes then trip over.
 *
 * Same invariants, same messages, same `allowLiveBlockedBy` waiver — only the source of
 * `{ path, content }` differs. `opts.corpus` is the same passthrough documented on
 * `assertBoardInvariants` above.
 */
export function assertBoardInvariantsForPending(
  dir,
  entries,
  { tool = 'coord', allowLiveBlockedBy = false, corpus = null } = {},
) {
  const touched = (entries || [])
    .map(({ path, content }) => ({ path: String(path).replace(/\\/g, '/'), content }))
    .filter((e) => PLAN_PATH_RE.test(e.path))
    .map((e) => ({ ...e, basename: basename(e.path), folder: e.path.split('/')[3] }));
  return assertTouched(dir, touched, { tool, allowLiveBlockedBy, corpus });
}

// plan 2587 Check A (Status prose vs stage stamp) MOVED to plan-body-state.mjs by plan
// 2892 — that module already owns readStatusToken and the "which Status line is this
// plan's own" selection rule, and the pre-stamp promotability check needs the same
// predicate WITHOUT importing this gate (which would close a module cycle). Imported
// and re-exported above so this file's existing consumers and tests are unchanged.

// plan 2587 Check B (WARN-ONLY, never blocks) — a plan's own `cloudExec` / `execModel` /
// `stage` prose ASSERTION (not just a mention) contradicting its own frontmatter stamp.
//
// Scoped to exactly two region shapes — the plan's OWN self-assertions, never arbitrary
// body prose. This scoping is the entire design: a naive whole-body value scan measured
// TWO false positives before this was narrowed —
//
//   - plan 2576: a numbered task/acceptance bullet reading "the re-stamp sweep flips at
//     least the ready-lane members of the measured bucket to `cloudExec: true`" — this is
//     the plan's OWN stamp is `cloudExec: false`, but the sentence is describing OTHER
//     plans' stamps (the ones the sweep will flip), not asserting its own.
//   - plan 2384: ordinary body prose "A Places-dependent plan needs to run with
//     `cloudExec: true`" — again describing a general rule, not this plan's own value
//     (own stamp `cloudExec: false`).
//
// Both are internally CONSISTENT records; scoping to (1) the `> ☁️ **cloudExec: …**`
// banner line and (2) the "Spec-pass verdict" paragraph is exactly what excludes them —
// neither false-positive sentence lives in either region. This design was validated
// against the whole active corpus before implementation: it produced exactly ONE hit
// (plan 2010's verdict paragraph — the plan-2587 Task-1c(i) row, itself already cleaned)
// and zero false positives. Ship WARN-only; promote to blocking only after a soak shows
// this scoping holds up against fresh plans (Check A's stronger self-assertion shape does
// not need that soak — the Status line has no equivalent "discussing another plan" case).
//
// plan 3943: the verdict-paragraph anchor moved to build-index-lib.mjs as
// SPEC_VERDICT_MARKER_RX (imported above) and was widened there to also recognize the
// `## Spec-pass verdict` H2 heading — the new canonical form a `stage: specced` stamp now
// requires (plan-promotable-lib.mjs's blocker) — alongside the pre-3943 bold-paragraph
// form every already-specced plan carries. ONE regex, two callers; see its own comment.
const CLOUD_BANNER_LINE_RX = /^>\s*☁️.*$/gm;

function stampProseRegions(body) {
  // Fenced text is an ILLUSTRATION everywhere in this function, not just inside a verdict
  // region (review round 4): a plan showing what a `cloudExec: false` banner looks like is
  // not asserting one. Stripped once, up front, so the banner scan and the verdict regions
  // below are judged on the same footing.
  const live = stripFencedBlocks(body);
  const regions = [...live.matchAll(CLOUD_BANNER_LINE_RX)].map((m) => m[0]);
  // plan 3943 review round 1 (CONFIRMED): the paragraph-split this used to do is wrong for
  // the H2 form — a canonical `## Spec-pass verdict` heading is followed by a BLANK LINE,
  // so the paragraph carrying the marker is the heading alone and Check B scanned nothing.
  // specVerdictRegion owns the shape-per-form decision (and the fence-awareness this loop
  // never had); see its header.
  // EVERY verdict region, not just the first (review round 2): the pre-3943 paragraph loop
  // pushed one per matching paragraph, and a plan carrying a re-verdict has two blocks.
  // Fenced text inside a verdict region is an ILLUSTRATION (a sibling plan's stamp, an
  // example of the shape), never this plan asserting its own — stripped before Check B
  // reads it, the same way the two content-judging checks do (review round 3).
  // `live` preserves line count, so specVerdictRegions' indices address it identically.
  for (const r of specVerdictRegions(live)) regions.push(live.slice(r.start, r.end));
  return regions;
}

export function findStampProseContradictions(entries) {
  const findings = [];
  for (const { path, content, basename: bn } of entries) {
    const { body } = splitFrontmatter(content);
    const regions = stampProseRegions(body);
    if (!regions.length) continue;

    // absent stamp defaults, per plan 2587: cloudExec absent ⇒ false; execModel absent ⇒
    // sonnet (the documented grandfather default); stage absent ⇒ skip (no stamp to compare).
    const cloudExecStamp = readFrontmatterScalar(content, 'cloudExec').toLowerCase() || 'false';
    const execModelStamp = readFrontmatterScalar(content, 'execModel').toLowerCase() || 'sonnet';
    const stageStamp = readFrontmatterScalar(content, 'stage').toLowerCase();

    const checks = [
      {
        key: 'cloudExec',
        rx: /\bcloudExec[`"']?[:\s]+[`"']?(true|false)\b/gi,
        stamped: cloudExecStamp,
      },
      {
        key: 'execModel',
        // plan 3341: widened to recognize `sol` alongside sonnet/fable — before this, a sol
        // plan's own prose correctly stating `execModel: sol` could never be RECOGNIZED by
        // this check at all (the alternation excluded it), so it stayed permanently
        // uncompared and any genuine sol-vs-stamp drift went undetected. Still warn-only.
        rx: /\bexecModel[`"']?[:\s]+[`"']?(sonnet|fable|sol)\b/gi,
        stamped: execModelStamp,
      },
      ...(stageStamp
        ? [
            {
              key: 'stage',
              rx: /\bstage[`"']?[:\s]+[`"']?(stub|specced)\b/gi,
              stamped: stageStamp,
            },
          ]
        : []),
    ];

    for (const region of regions) {
      for (const { key, rx, stamped } of checks) {
        for (const m of region.matchAll(rx)) {
          const asserted = m[1].toLowerCase();
          if (asserted !== stamped) {
            findings.push({
              path,
              basename: bn,
              key,
              asserted,
              stamped,
              detail:
                `${bn}: own prose asserts \`${key}: ${asserted}\` in its Status/verdict ` +
                `region while the frontmatter stamp says \`${key}: ${stamped}\` — the ` +
                `FRONTMATTER is the tooled value; fix the prose sentence.`,
            });
          }
        }
      }
    }
  }
  return findings;
}

/**
 * Every violation ONE plan-file entry carries, in the gate's own `kind` vocabulary.
 *
 * Split out of `assertTouched` by plan 2892 for one reason: the strict-improvement rule
 * needs violations ATTRIBUTED to a file (to compare that file's post-set against its own
 * pre-set), and the three finders return flat lists with no path handle. Feeding them a
 * one-entry array gives attribution for free without re-rolling any predicate — the
 * finders already loop over their input, so a one-entry call is the same code path.
 *
 * `corpusView` may be null ONLY when `allowLiveBlockedBy` is set (the axis that needs it
 * is then skipped entirely).
 */
function evaluateEntry(entry, { allowLiveBlockedBy, corpusView }) {
  const one = [entry];
  const out = [];

  // (1) stage/folder invariant — plan 1371 D7, the check that landed dfa892aae5 on
  // 2026-07-04 and was still being violated three weeks later by 2373 + 2375, both of
  // which minted `stage: specced` straight into pending-approval/ and reached
  // origin/master unchallenged.
  for (const v of findStageFolderViolations(one)) {
    out.push({ kind: 'stage-folder', detail: v.trim() });
  }

  // (1.5) plan 2587 Check A — Status prose vs stage stamp (BLOCKING, never waivable by
  // allowLiveBlockedBy — that flag is scoped to the live-Blocked-by axis only).
  for (const v of findStageStatusProseViolations(one)) {
    out.push({ kind: 'stage-status-prose', detail: v });
  }

  // (2) axis-A: a LIVE Blocked-by on a plan this write leaves in ready/ or in-progress/.
  // This is the authoring moment for the misfile — 2358 and 2367 each acquired their
  // Blocked-by line IN PLACE via a later edit-plan commit, with the folder left alone
  // and no gate participating at any point.
  if (!allowLiveBlockedBy) {
    const { live } = findBlockedByInActiveFolder(one, corpusView.statusOf, corpusView.isShipped);
    for (const f of live) {
      const why =
        f.kind === 'review' ? 'a non-plan gate remains' : `open blockers: ${f.ids.join(', ')}`;
      out.push({
        kind: 'live-blocked-by',
        detail:
          `${f.basename}: a LIVE **Blocked-by:** line (${why}) while the plan sits in ` +
          `${f.folder}/ — a folder that means "takeable".`,
      });
    }
  }

  return out;
}

/**
 * The violation IDENTITY set used by the strict-improvement rule (plan 2892) — the gate's
 * own `kind` values, nothing invented alongside them. Per-FILE, so a `kind` identifies a
 * violation uniquely within the set being compared (each finder reports at most one
 * finding per kind per entry).
 */
export function violationKeys(violations) {
  return new Set((violations || []).map((v) => v.kind));
}

/**
 * True iff `postKeys` is a STRICT SUBSET of `preKeys`: at least one violation removed,
 * none added, none substituted. Equal sets are NOT an improvement (the write changed
 * nothing the gate cares about), and an equal-COUNT swap fails on the membership loop
 * before the size test is ever reached — the substitution case the spec-pass ruling
 * settled explicitly.
 */
export function isStrictImprovement(preKeys, postKeys) {
  for (const k of postKeys) if (!preKeys.has(k)) return false;
  return postKeys.size < preKeys.size;
}

// HEAD's plan tree as id → repo-relative path, for pre-image lookup. `git ls-tree HEAD`
// rather than `git ls-files`: the latter reads the INDEX, which on the edit-plan path
// already carries this write's staged `git mv` and would hand back the POST-mutation
// path. Keyed by plan id (not path) precisely so a write that MOVES a plan between
// folders still finds its own pre-image.
function headPlanIndex(dir) {
  let rels = [];
  try {
    rels = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', PLANS_PREFIX], {
      cwd: dir,
      encoding: 'utf8',
      env: gitRepoIsolatedEnv(),
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    /* no HEAD (a fresh repo) or not a repo — every file is then pre-image-less, i.e. no
       improvement can be claimed, which is the conservative direction. */
  }
  const byId = new Map();
  for (const rel of rels) {
    const m = rel.match(PLAN_PATH_RE);
    if (m) byId.set(m[2], rel);
  }
  return byId;
}

// The `{ path, content, basename, folder }` entry this plan file had at HEAD, or null
// when it has no pre-image (newly authored, or unreadable). Read through `git show` so it
// works identically on the two mutation shapes the gate serves: a tree already mutated
// in place (assertBoardInvariants) and one not yet touched (…ForPending).
function preImageEntry(dir, headIdx, postPath) {
  const m = postPath.match(PLAN_PATH_RE);
  if (!m) return null;
  const preRel = headIdx.get(m[2]);
  if (!preRel) return null;
  let content;
  try {
    content = execFileSync('git', ['show', `HEAD:${preRel}`], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: gitRepoIsolatedEnv(),
    });
  } catch {
    return null;
  }
  return { path: preRel, content, basename: basename(preRel), folder: preRel.split('/')[3] };
}

// The shared core both entry points above funnel into: judge already-collected
// `{ path, content, basename, folder }` entries. Never exported — a caller that has
// entries in hand goes through assertBoardInvariantsForPending, which normalizes them.
function assertTouched(dir, touched, { tool, allowLiveBlockedBy, corpus = null }) {
  if (!touched.length) return [];

  // Built once for the whole write (and reused for every pre-image evaluation): the
  // corpus view answers questions about OTHER plans' statuses, so holding it fixed across
  // the pre/post comparison is what isolates the comparison to THIS file's own change.
  const corpusView = allowLiveBlockedBy
    ? null
    : corpus ||
      loadCorpusView(
        dir,
        touched.map((t) => t.path),
      );
  const opts = { allowLiveBlockedBy, corpusView };

  const violations = [];
  const admitted = [];
  let headIdx = null;

  for (const entry of touched) {
    // plan 2587 Check B — stamp-VALUE contradiction in the plan's own Status/verdict
    // prose. WARN-ONLY: logged and never added to `violations`, so it can never make this
    // throw, and it is deliberately OUTSIDE the improvement rule for the same reason —
    // a warning has nothing to admit or refuse. See findStampProseContradictions' header
    // for the two measured false-positive shapes it must not reproduce.
    for (const w of findStampProseContradictions([entry])) {
      console.warn(`${tool}: WARN — ${w.detail}`);
    }

    const post = evaluateEntry(entry, opts);
    if (!post.length) continue;

    // plan 2892 — does this write strictly IMPROVE this file? Only computed for a file
    // that would otherwise be refused, so a clean write pays no `git ls-tree`/`git show`.
    if (headIdx === null) headIdx = headPlanIndex(dir);
    const pre = preImageEntry(dir, headIdx, entry.path);
    const preViolations = pre ? evaluateEntry(pre, opts) : [];
    if (isStrictImprovement(violationKeys(preViolations), violationKeys(post))) {
      admitted.push(...post);
      continue;
    }
    violations.push(...post);
  }

  if (admitted.length) {
    console.warn(
      `${tool}: ADMITTED under the strict-improvement rule (plan 2892) — this write removes ` +
        `at least one board-state violation and adds none. Still outstanding afterwards:`,
    );
    for (const v of admitted) console.warn(`  • ${v.detail}`);
  }

  if (!violations.length) return admitted;

  const lines = [
    `${tool}: REFUSING this write — it would land a board-state violation on origin/master.`,
    '',
    ...violations.map((v) => `  • ${v.detail}`),
    '',
    '  Fixes:',
    '    stage/folder    → route it out:      node scripts/move-plan.mjs <id> ready|<waiting-state>',
    '    live Blocked-by → move, do not edit: node scripts/move-plan.mjs <id> waiting-blocked',
    '    Status prose    → stamp wins, edit the line: node scripts/edit-plan.mjs <id> --find … --replace …',
    '',
    '  Stacked violations are NOT a deadlock (plan 2892): a write that clears at least one',
    '  of them and adds none is admitted even while the others remain, so you can fix them',
    '  one at a time in any order. This refusal means the write clears none of them.',
    '',
    '  This gate runs at WRITE time because the coord-checkout push runs no git hooks',
    "  (see this file's header). It is scoped to the plan files THIS write touches — it",
    '  never fails you for a pre-existing violation someone else left in the corpus.',
  ];
  throw new BoardInvariantError(lines.join('\n'), violations);
}

/**
 * Can EITHER invariant fire for a plan landing in `folder`? False means calling the gate is
 * provably a no-op: the stage/folder check early-`continue`s on anything but
 * `pending-approval/`, and the live-Blocked-by check only looks at LIVE_BLOCKED_FOLDERS.
 *
 * Exported for `drain-run` (plan 2426 review round 2). Its `movePlanOnMaster` choke point
 * has FIVE callers, but only the claim can ever trip the gate — the other four park into a
 * waiting lane. Letting a caller skip a provably-inert call is not an optimization: it keeps
 * four error-handling-free park paths (the drain's OWN recovery routes) structurally outside
 * the gate's blast radius, so a bug anywhere under `classifyBlocked` cannot reach them. The
 * folder set is READ FROM the owning lint module — never re-listed here.
 */
export function gateAppliesToFolder(folder) {
  return LIVE_BLOCKED_FOLDERS.has(folder) || folder === STAGE_FOLDER_SCOPE;
}

/**
 * The `blockedView` shape `flipStatusToInProgress` expects, built from a `loadCorpusView`
 * result. A one-line factory rather than three hand-built object literals (projectClaim,
 * projectBatchClaim's per-member loop, drain-run's claimPlan): the shape is a contract
 * between two modules, so a future field added here must not depend on three call sites
 * being found and updated in lockstep.
 */
export function blockedViewFor(corpus, planBasename) {
  return { basename: planBasename, statusOf: corpus.statusOf, isShipped: corpus.isShipped };
}

/**
 * plan 2426 (operator ruling Q2) — the CLAIM-side counterpart of the promote path's
 * unconditional `dropBlockedBy`: drop a plan's `**Blocked-by:**` line at claim time iff it
 * is STALE, and never when it is LIVE.
 *
 * The three write paths deliberately differ, and the asymmetry is the point:
 *
 *   promote     (`move-plan <id> ready`)      — an operator's explicit re-file IS the
 *                                               clearing act → UNCONDITIONAL drop.
 *   claim       (`claim-plan` / `pickup-plan`) — taking work is not clearing it → drop only
 *                                               a dead line; a live one is refused by the
 *                                               gate above, and if claimed anyway via
 *                                               `--blocked-ok` it stays in the body VERBATIM
 *                                               (the plan really is part-blocked; the
 *                                               advisory pre-push lint re-flagging it until
 *                                               the blocker clears is accepted signal).
 *   drain claim (`drain-run`)                  — unattended → refuse + skip, never mutate.
 *
 * Staleness is judged by `findBlockedByInActiveFolder`, NOT by a second call to
 * `classifyBlocked`: that function owns the inert-line skips too (a strikethrough idiom or a
 * `none — <id> landed …` cleared-declaration line is deliberately NOT reported, so it is
 * deliberately NOT dropped either), and re-deriving them here would be the second copy of an
 * invariant this module's header forbids. An entry lands in `stale` exactly when
 * classifyBlocked says `'promotable'` — every named blocker archived AND shipped, with no
 * residual non-plan gate.
 *
 * Pure: `statusOf`/`isShipped` come from the caller (normally `loadCorpusView`), so this
 * stays unit-testable without a repo.
 *
 * @param {string} content   the plan body
 * @param {object} view
 * @param {string} view.basename   the plan's basename (its leading id is the self-id
 *                                 classifyBlocked excludes from its own blocker set)
 * @param {(id:string)=>(string|null)} view.statusOf
 * @param {(id:string)=>boolean} view.isShipped
 * @returns {string} the body, with a STALE Blocked-by line removed; unchanged otherwise.
 */
export function dropStaleBlockedBy(content, { basename: planBasename, statusOf, isShipped }) {
  // `folder: 'in-progress'` is where the claim is taking this plan — the destination is what
  // both the STALE bucket and the gate judge, so the two always agree about one body.
  const { stale } = findBlockedByInActiveFolder(
    [{ basename: planBasename, content, folder: IN_PROGRESS_FOLDER }],
    statusOf,
    isShipped,
  );
  return stale.length ? dropBlockedBy(content) : content;
}
