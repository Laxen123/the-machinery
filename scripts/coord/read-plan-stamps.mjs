#!/usr/bin/env node
// scripts/read-plan-stamps.mjs — the contracted plan-stamp reader (plan 2423).
//
// WHY THIS FILE EXISTS: plan 2396 consolidated the plan-frontmatter stamp read behind
// `readFrontmatterScalar` (build-index-lib.mjs) for `/local-drain` and `queue-drain.mjs`, but its
// acceptance criterion 3 ("exactly ONE implementation reachable from all three consumers") landed
// PARTIALLY MET: the THIRD consumer, the `/cloud-eligibility` skill master, lived OUTSIDE this
// repo at the time (a per-account junction-layer master under the operator's personal skills
// directory) and carried its own inline `/^---\r?\n([\s\S]*?)\r?\n---/` parser. A
// markdown skill body cannot import an ESM module from a heredoc, so the only way to give it the
// shared reader was a repo script with a declared CLI contract — this file. Plan 2468 later moved
// the skill masters in-clone (`coord/skills/`), and plan 2525 then retired the `/cloud-eligibility`
// skill outright (superseded by `/ready-plans` — `scripts/ready-board.mjs`, plan 2524) — but this
// script's contract predates and outlives that one consumer: `ready-board.mjs` depends on the same
// STAMP_KEYS column set today, so the CLI shape below is kept.
//
// The duplication was never cosmetic. Each consumer rediscovered the SAME bugs independently:
//   - 2026-07-19: the skill inferred a plan's lane from the oracle's exclude codes and filed every
//     `cloudExec: false` SONNET plan under a bogus FABLE heading (1701 / 2018 / 2023 / 2045).
//   - 2026-07-25: the skill sliced frontmatter at 1500 chars and misfiled plan 2365 — the same
//     byte-window defect plan 2396 fixed in `/local-drain` on the same day, in a second place.
//
// ORACLE AGREEMENT IS THE POINT, not merely "one parser". The retired `/cloud-eligibility` skill
// existed to REPORT what `queue-drain.mjs` decides (as `/ready-plans` does today), so its stamp
// values had to be normalized exactly the way the oracle normalizes them: `readFrontmatterScalar(...)`
// (frontmatter-scoped, no byte window, CRLF-safe, trailing-inline-comment stripped) lower-cased,
// `null` when absent. The retired skill's regex `/^execModel:\s*fable\b/m` disagreed with the oracle on a hand-decorated stamp
// (`execModel: fable CONFIRMED — …`, `execModel: fable.`): the oracle calls those sonnet-lane,
// the regex called them fable. read-plan-stamps.test.mjs pins it.
//
// CITATION CORRECTED 2026-07-26 (plan 2488 review): this header and that test used to call those
// two values "both real, both in `archive/`". They are real SHAPES, written in plan PROSE
// (archive/1587's spec verdict line), but NOT — today — inside any plan's frontmatter fence. A
// measured sweep of the whole corpus found 44 decorated frontmatter `execModel` values and every
// one is `fable # <comment>` shaped, on which the retired regex and the scalar read AGREE. So the
// divergence this file exists to prevent is LATENT, not a live mislabel. That does not weaken the
// case for one reader — it is exactly why the pin has to live in a test rather than in a row.
//
// THE ONE PLACE THIS COUNT LIVES (plan 2495): that "44" fact was independently restated, verbatim,
// in FOUR files (this one, mine-sonnet-lane-executor-telemetry.mjs, and both their test files) —
// the exact citation-drift shape 2488's own review was filed to catch, just for a corpus fact
// instead of a bug. `DECORATED_EXECMODEL_VALUES_MEASURED` below is now the one export that carries
// the digit; the other three cite it by name (a read-plan-stamps.test.mjs regression test fails if
// the bare count creeps back into either sibling file).
//
// `cloudExec` specifically routes through `readCloudExecStamp` (local-drain-filter.mjs) — the ONE
// normalization `queue-drain.mjs` itself derives its value from — rather than a second
// `readFrontmatterScalar(content, 'cloudExec')` call, so this reader cannot drift from the two
// consumers that already share it.
//
// build-index-lib.mjs is sibling-ADOPTED (`coord.config.json`): importing it needs no sibling
// sync, EDITING it would — so this module only ever reads through it.
//
// Usage:
//   node scripts/read-plan-stamps.mjs --json                  # id → stamps, active folders only
//   node scripts/read-plan-stamps.mjs --json --include-archive
//   node scripts/read-plan-stamps.mjs --json --root <plansDir>
//
// Output (stdout, the declared interface):
//   { "<id>": { stage, execModel, cloudExec, cloudEnv, loop, priority, cloudRepos, evidence, specReview, path, folder, category }, … }
// Every STAMP_KEYS value is the lower-cased frontmatter scalar or `null` (except `priority`, whose
// absent-default is `'medium'`, never `null`); `folder` is the plan's status folder name (`ready`,
// `in-progress`, `waiting-operator`, …) and `category` (plan 2678, additive) is the optional
// one-level subfolder BELOW that status (`denmark` for `parked/denmark/9-X-y.md`), `null` when the
// plan sits flat — which is the default and, today, every plan. `specReview` (plan 2495, additive — see the contract note
// above STAMP_KEYS below) is NOT lower-cased and is NOT part of STAMP_KEYS, but IS returned by
// readPlanStamps() itself since plan 2571. `path` remains collectPlanStamps()-only: readPlanStamps()
// alone does not return it.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readFrontmatterScalar,
  readPriorityTier,
  walkPlanTree,
  PRIORITY_BY_DIRECTIVES,
} from './build-index-lib.mjs';

// Re-exported, not re-declared (plan 3999) — build-index-lib.mjs is this array's canonical
// home (see the "Canonical home" comment on PRIORITY_BY_DIRECTIVES there for why: this module
// already imports FROM build-index-lib.mjs, so owning the array here would be an import
// cycle). A consumer of THIS module's contract (e.g. a board renderer wanting to show the
// legal directive names) imports it from here rather than reaching past this module into
// build-index-lib.mjs directly.
export { PRIORITY_BY_DIRECTIVES };
import { readCloudExecStamp, UNSET, NO_FRONTMATTER } from './local-drain-filter.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';

const REPO_ROOT = repoRootFrom(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_PLANS_ROOT = path.join(REPO_ROOT, 'docs', 'superpowers', 'plans');

// Measured 2026-07-26 (see the CITATION CORRECTED header comment above for the sweep and its
// methodology): the plan corpus carries this many decorated (non-bare) frontmatter `execModel`
// values. Plan 2495 — THE ONE export for this fact; mine-sonnet-lane-executor-telemetry.mjs and
// both test files cite this constant instead of retyping the digit.
export const DECORATED_EXECMODEL_VALUES_MEASURED = 44;

// The stamp axes this reader contracts. Deliberately NOT "every frontmatter key": these are the
// routing/lifecycle axes the drain oracle gates on, which is what a consumer asking "which lane /
// which env / is it specced" needs. `summary` is read elsewhere by the scripts that own that
// surface; adding a key HERE (to STAMP_KEYS, hence to readPlanStamps()) is a contract change, not
// a free extra.
//
// `specReview` is a NAMED EXCEPTION (plan 2495, folded into readPlanStamps()'s own key-loop by
// plan 2571): it is NOT in STAMP_KEYS — nothing importing STAMP_KEYS or iterating it is affected —
// but readPlanStamps(content) DOES always compute and return it (plan 2571; previously
// collectPlanStamps() bolted it on via a second, separate readFrontmatterScalar call after calling
// readPlanStamps(), which was two top-level calls into the frontmatter-scalar-reading subsystem
// per file instead of one). That is deliberately narrower than widening STAMP_KEYS itself: it lets
// mine-sonnet-lane-executor-telemetry.mjs's buildPlanIndex() reuse this walk (retiring its own
// hand-rolled duplicate) without asking every STAMP_KEYS consumer — including ready-board.mjs (the
// in-repo `/ready-plans` renderer, plan 2524, and the retired `/cloud-eligibility` skill's
// successor) — to reason about a routing/lifecycle axis that was never theirs. Adding specReview
// to readPlanStamps()'s output is safe for that consumer for the same reason widening STAMP_KEYS
// would be: it only ever reads the specific keys it expects off the object, so an extra
// key it never asked for is invisible to it. `path`, `folder` and `category` (plan 2678) stay
// collectPlanStamps()-only — they need the per-file tree-walk context readPlanStamps() doesn't
// have. Never rename or remove a key either function already returns.
//
// `cloudEnv` is present even though plan 2423's body listed only {stage, execModel, cloudExec,
// loop}: `/ready-plans` (and, before its 2525 retirement, `/cloud-eligibility`) tags rows
// `(full-env)` from `cloudEnv:`, so without it the renderer would have had to keep a frontmatter
// regex and the plan's whole acceptance criterion 2 would fail.
//
// `priority` joined the contract at plan 2520 (the three-tier `{high, medium, low}` ruling closed
// the same drift class on this axis that this reader closed for execModel/cloudEnv at 2423: FIVE
// independent `=== 'high'` inlines that had to agree by convention, with no test binding them).
// Unlike every other key here it is NOT null-means-absent — the ruled vocabulary's own default IS
// a value (`medium`), so an absent stamp reads `'medium'` here exactly as it does at every other
// consumer, never `null`.
//
// `cloudRepos` joined at plan 2577 for the SAME reason `cloudEnv` did: it is a routing axis the
// oracle now carries (which extra repos a drain must clone beside vetapp), and a human-facing
// consumer that cannot see it has no way to explain why a plan needing a second repo behaves
// differently — short of opening the plan file, exactly the regex-in-the-skill situation this
// reader exists to retire. It is the RAW lower-cased frontmatter scalar (e.g. `'hobby-main'`, or
// `'hobby-main, other'`), null-means-absent like every key but `priority` — NOT the parsed array
// `queue-drain.mjs` builds, because this contract is defined as lower-cased scalars and a
// consumer wanting the list can split on `/[\s,]+/` (or import parseCloudRepos).
//
// REMOVING A KEY IS A SILENT BREAK for `scripts/ready-board.mjs` (the `/ready-plans` renderer,
// plan 2524), the sole consumer of this contract now that plan 2525 retired the out-of-repo
// `/cloud-eligibility` skill master: `ready-board.mjs` does `s.cloudEnv === 'full'`, and a dropped
// key makes that `undefined === 'full'` → every full-env plan quietly loses its tag, with no error
// anywhere. So the CLI test (`read-plan-stamps.test.mjs`, 'CLI --json prints the id → stamps map
// the skill consumes' — named for the retired skill, still binding for its in-repo successor)
// deepEquals the WHOLE object including every key name — trimming this list goes RED there. Keep
// it that way; that assertion is the only thing standing in for `ready-board.mjs`. The board reads
// `priority` under plan 2520's vocabulary — `'high'` → ⚡, every other tier (including the
// `'medium'` an unstamped plan reads as) unflagged — the same predicate `build-index-lib.mjs`
// applies, so the board and the INDEX bullet cannot disagree about which plans are flagged.
// `evidence` joined at plan 2943 — the evidence-floor class (docs/runbooks/plans-workflow.md
// § Evidence floor: observed-wave | observed-live | observed-measured | operator | latent).
// Same shape as every scalar key here (the raw lower-cased frontmatter value, null when
// absent — a MISSING key is the grandfathered-pool default, never a routing refusal by
// itself); the promotion-time REFUSAL for a `latent` product-family plan lives at
// `move-plan.mjs`'s `assertEvidenceFloorOk`, not here — this reader only ever surfaces the
// stamp for a consumer (`/ready-plans`, the drain oracle) to display.
// `landGate` joined at plan 3295 — the per-plan LAND-GATE tier. Same shape as every scalar key
// here (raw lower-cased frontmatter value, null when absent — and absent is the overwhelming
// default: it means "use the environment default", which is once-per-land on a LOCAL land and
// full-every-land on a cloud one). It is on the contract for `cloudEnv`'s reason: a human-facing
// board row that cannot see the tier has no way to explain why one plan's land ran a diff-scoped
// selection where its neighbour ran the full suite, short of opening the plan file — the
// regex-in-the-consumer situation this reader exists to retire. The NORMALIZING read the land
// spine itself gates on is `readLandGate()` below, not this raw scalar.
// `priorityBy` joined at plan 3999 — the provenance stamp `priority: high` now requires (see
// PRIORITY_BY_DIRECTIVES / priorityStampProblem in build-index-lib.mjs for the vocabulary and
// the write-time gate). Same shape as every scalar key here: the raw lower-cased frontmatter
// value, null when absent. A board row showing `⚡` with no way to see WHO authorized it is the
// same short-of-opening-the-file gap `landGate`/`cloudRepos` closed for their own axes.
export const STAMP_KEYS = [
  'stage',
  'execModel',
  'cloudExec',
  'cloudEnv',
  'loop',
  'priority',
  'priorityBy',
  'cloudRepos',
  'evidence',
  'landGate',
  'lane',
];

// The ONE stampable `landGate` value (plan 3295). A closed vocabulary of exactly one member is
// deliberate: the tier exists to OPT OUT of the environment default, and "no stamp" already means
// the default — so a second spelling for the default would only create a way to disagree with it.
export const LAND_GATE_SELECTIVE = 'selective';

// The ONE stampable `lane` value (plan 3967) — the opt-in review-round fastlane. Same closed-
// vocabulary shape as LAND_GATE_SELECTIVE and the same reason: the axis exists to opt OUT of the
// default review-round cap, so a second spelling for "no stamp" would only invite disagreement
// with it. NOTE: this is a DIFFERENT axis from `execModel`'s sonnet/fable/sol "lane" — several
// board renderers (ready-board.mjs, in-progress-board.mjs) already use the bare word "lane" for
// the execution lane; this stamp's frontmatter key happens to share the English word but not the
// vocabulary or the code path.
export const LANE_FAST = 'fast';

// Read every contracted stamp out of ONE plan file's CONTENT. Mirrors `queue-drain.mjs`'s own
// normalization line-for-line: the scalar, lower-cased, or `null` when the key (or the whole
// frontmatter block) is absent. `null` rather than `''` because that is the absent-value contract
// every existing consumer of these stamps already compares against.
export function readPlanStamps(content) {
  const text = String(content);
  const out = {};
  for (const key of STAMP_KEYS) {
    if (key === 'cloudExec') {
      // The ONE cloudExec normalization (local-drain-filter.mjs), collapsed to the null-means-
      // absent shape exactly as queue-drain.mjs collapses it.
      const stamp = readCloudExecStamp(text);
      out[key] = stamp === UNSET || stamp === NO_FRONTMATTER ? null : stamp;
      continue;
    }
    if (key === 'priority') {
      // The ONE priority normalization (build-index-lib.mjs — the same module every consumer of
      // this field already imports readFrontmatterScalar from) — deliberately NOT null-means-
      // absent: the ruled vocabulary's default IS `medium`, matching what queue-drain's sort,
      // the INDEX ⚡ marker, and the board row flag all already treat an unstamped plan as.
      out[key] = readPriorityTier(text);
      continue;
    }
    const raw = readFrontmatterScalar(text, key);
    out[key] = raw ? raw.toLowerCase() : null;
  }
  // `specReview` (plan 2495, folded here at plan 2571): NOT a STAMP_KEYS entry — see the contract
  // comment above STAMP_KEYS — but always computed off the SAME `text` already in scope, so this
  // remains the ONE call into the frontmatter-scalar-reading subsystem per file. Non-lower-cased
  // (a review-provenance marker/sha, not a routing enum, so no canonical case to normalize to);
  // `''` (absent, or an empty scalar) collapses to `null` like every other key here.
  out.specReview = readFrontmatterScalar(text, 'specReview') || null;
  // `specReviewBy` (plan 3004 work item A, folded here at plan 3047): the SECOND named exception,
  // for exactly `specReview`'s reason and on exactly its terms — not a STAMP_KEYS entry, computed
  // off the SAME `text` already in scope, so this stays ONE call per file into the
  // frontmatter-scalar-reading subsystem rather than a bolted-on second walk. It is the spec-pass
  // effort EXPERIMENT's arm label (`<model>/<effort>`, or the literal `undeclared` a cloud sweep
  // stamps), and plan 3047's readout joins it per plan id against outcomes; without it here,
  // mine-spec-pass-effort-arms.mjs would have had to re-read all ~3.3k plan files a second way,
  // which is the duplicate-walk shape plans 2495/2571 retired at this very seam.
  // Non-lower-cased for `specReview`'s reason (a provenance marker, not a routing enum) — the
  // effort half IS a closed vocabulary, but normalizing it belongs to the consumer that compares
  // arms, not to this reader, which contracts raw stamps. `''` collapses to `null` like every
  // other key here.
  out.specReviewBy = readFrontmatterScalar(text, 'specReviewBy') || null;
  return out;
}

// The NORMALIZED land-gate tier for ONE plan file's content (plan 3295) — `'selective'` or `null`.
//
// Why this exists beside `readPlanStamps().landGate`, which reads the same key: the two answer
// different questions on purpose. The STAMP_KEYS scalar reports what is WRITTEN (whatever
// lower-cased string the frontmatter carries), which is what a board renderer wants to show. This
// one reports what the land gate will DO, and the gate has exactly one non-default behaviour — so
// every value that is not the stampable one collapses to `null` = "the environment default"
// (LOCAL: once-per-land; cloud: full every land). A typo (`landGate: selektive`), a retired tier
// name, or a hand-decorated value must NEVER half-honour the tier: a plan whose author meant
// `selective` and mistyped it lands under the default, which is the SAFE direction (more testing,
// not less). The inverse — treating any non-empty value as "selective" — would silently downgrade
// a land's gate on a typo, which is the failure this narrowing exists to prevent.
//
// Reads through `readFrontmatterScalar` like every other stamp: frontmatter-scoped, no byte
// window, CRLF-safe, trailing-inline-comment stripped (so `landGate: selective # plan 3295`
// reads as the tier). Tolerant of a null/empty/undefined `content` because the spine calls it on
// a plan file it may not have found.
export function readLandGate(content) {
  if (!content) return null;
  const raw = readFrontmatterScalar(String(content), 'landGate');
  const value = raw ? raw.trim().toLowerCase() : '';
  return value === LAND_GATE_SELECTIVE ? LAND_GATE_SELECTIVE : null;
}

// The NORMALIZED review-round lane for ONE plan file's content (plan 3967) — `'fast'` or `null`.
// Mirrors readLandGate exactly, on the same reasoning: `fast` is the only stampable value, so a
// typo, a retired lane name, or a hand-decorated value all collapse to `null` = the default
// review-round cap, never a half-honoured fastlane. The SAFE direction on a mis-stamp is the
// default (more review rounds, not fewer).
export function readLane(content) {
  if (!content) return null;
  const raw = readFrontmatterScalar(String(content), 'lane');
  const value = raw ? raw.trim().toLowerCase() : '';
  return value === LANE_FAST ? LANE_FAST : null;
}

// `readLane`, resolved by PLAN ID against a checkout's plans tree rather than against
// already-in-hand content — the shape `scripts/hooks/review-round-cap-guard.mjs` and
// `scripts/record-review.mjs` need: both know a plan id (derived from the branch/slug), not the
// plan file's content, at the point they must decide the review-round cap.
//
// FAILS OPEN, unconditionally (plan 3967 § Execution notes, "Failure modes to avoid" #1): a
// missing plans root, an unreadable directory, an absent plan file, or any other error all return
// `null` — the default lane — because a lookup error must never DENY a review that the default
// cap would have allowed. This mirrors collectPlanStamps' own race tolerance (a plan can move
// between a parallel session's `move-plan`/`pickup-plan` and this read) without adopting its
// throw-on-missing-root contract, which is right for a CLI report but wrong for a fail-open guard.
//
// plan 3967 fix round 1 (findings 16/17/18): a plan may legally rest ONE category level below its
// status folder (`in-progress/infra/<id>-…md`, plan 2678) — the shape this reader used to miss
// entirely (a flat `readdirSync(statusDir)` sees the category DIRECTORY, never descends into it,
// and falls back to `null`, which is the default lane, so a fastlane plan nested this way silently
// loses its one-round cap). This now shares `walkPlanTree` (build-index-lib.mjs) — the ONE
// recursive plan-tree walker every other enumerator in this repo already routes through — instead
// of a second hand-rolled, one-level-only scan. `isPlanFile` is narrowed to the id's own filename
// pattern so the walk never has to classify every OTHER plan file in the tree.
export function readLaneById(repoRoot, planId, { plansRoot } = {}) {
  try {
    const id = String(planId ?? '').trim();
    if (!id) return null;
    const root = plansRoot || path.join(String(repoRoot ?? ''), 'docs', 'superpowers', 'plans');
    if (!existsSync(root)) return null;
    // Idclaim shape: `<id>-` at the start of the basename, matching every other reader in this
    // repo (idTakenByOther, resolvePlanRel) — never a bare digit-prefix test that a longer id
    // sharing the same 3-digit prefix could false-match.
    const rx = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-.*\\.md$`);
    const entries = walkPlanTree({
      readdir: (segments) => {
        try {
          return readdirSync(path.join(root, ...segments), { withFileTypes: true });
        } catch (e) {
          // A folder that vanished mid-walk (a parallel move-plan) — skip it, same race
          // tolerance collectPlanStamps applies to its own readdir seam.
          const code = (e && e.code) || 'UNKNOWN';
          if (code === 'ENOENT' || code === 'ENOTDIR') return [];
          throw e;
        }
      },
      // `readLaneById` is reached for a plan that could be ANYWHERE, including archive (the
      // pre-existing behavior this preserves — this reader's own top-level scan used to include
      // every directory readdirSync returned, archive included; only the one-level-only NESTING
      // limit is what this fix lifts).
      includeArchive: true,
      isPlanFile: (name) => rx.test(name),
    });
    if (entries.length === 0) return null;
    // Last match in the walk's own sorted order wins on a transient double-file (the same
    // tie-break collectPlanStamps uses) — arbitrary but reproducible, never a throw.
    const found = path.join(root, ...entries[entries.length - 1].rel.split('/'));
    return readLane(readFileSync(found, 'utf8'));
  } catch {
    return null;
  }
}

// Walk a plans ROOT (one directory per status folder) and return `{ id: {…stamps, folder} }`.
//
// `archive/` is excluded by default: every consumer of this map is asking about the ACTIVE board
// (which lane can take this plan, where does it rest), and archive is ~10x the file count.
// `includeArchive: true` is there for the retrospective miners.
//
// Ordering: folder names and filenames are both sorted before the walk, so a plan id that
// transiently exists in TWO folders (a parallel session mid-`move-plan`) resolves deterministically
// — last folder in sorted order wins — instead of depending on readdir order, which differs across
// filesystems. Which of the two you get is arbitrary either way; that it is REPRODUCIBLE is not.
// `readFile` is injectable for the same reason local-drain-filter.mjs's `stampFor` injects it:
// the mid-walk race below is untestable otherwise (you cannot schedule a deletion between a
// readdir and a readFileSync from a test).
export function collectPlanStamps({
  root = DEFAULT_PLANS_ROOT,
  includeArchive = false,
  readFile = (p) => readFileSync(p, 'utf8'),
} = {}) {
  if (!existsSync(root)) {
    // A silent `{}` here reads exactly like "the board is empty" to every caller — and the most
    // likely cause is a wrong cwd, the same systematic failure local-drain-filter.mjs's
    // wrong-cwd discrimination exists to stop masquerading as ordinary churn.
    throw new Error(
      `read-plan-stamps: plans root does not exist: ${root} — run from the repo (or pass --root).`,
    );
  }
  const stamps = {};
  // plan 2678: the walk is RECURSIVE via the shared walker — a plan clumped into an
  // optional category subfolder (`parked/denmark/…`) used to vanish from this map
  // entirely, taking it off `/ready-plans` and every other stamp consumer with no
  // error anywhere. `folder` deliberately keeps meaning the STATUS (every consumer
  // branches on it); `category` is a NEW, additive, null-when-flat field.
  const entries = walkPlanTree({
    // ENOENT-tolerant below the root for the same reason the per-file read below is: a
    // concurrent `move-plan` can empty (and a close-out can remove) a folder between the
    // parent's readdir and this one. The ROOT itself is not tolerated — that is the
    // wrong-cwd case existsSync above already turns into a loud throw.
    readdir: (segments) => {
      try {
        return readdirSync(path.join(root, ...segments), { withFileTypes: true });
      } catch (e) {
        const code = (e && e.code) || 'UNKNOWN';
        if (segments.length && (code === 'ENOENT' || code === 'ENOTDIR')) return [];
        throw e;
      }
    },
    includeArchive,
    isPlanFile: (name) => name.endsWith('.md') && /^\d+/.test(name),
  });
  for (const { statusFolder: folder, category, basename: name, rel } of entries) {
    const id = name.match(/^(\d+)/)[1];
    const fullPath = path.join(root, ...rel.split('/'));
    let content;
    try {
      content = readFile(fullPath);
    } catch (e) {
      // MID-WALK RACE (sonnet-review finding, 2026-07-26). ~5-7 sessions mutate this tree
      // continuously; a `move-plan`/`pickup-plan` between the readdir above and this read
      // makes the file vanish. Letting that ENOENT propagate would discard the stamps
      // already collected for every OTHER plan and — because callers of this script (the
      // retired /cloud-eligibility skill, and ready-board.mjs today) do not wrap its
      // execFileSync — lose the whole report over one raced row.
      // Skip it, the same "race with a concurrent archive move — skip, stay conservative"
      // queue-drain.mjs's readArchivedIds takes.
      //
      // DISCRIMINATED, not swallowed (local-drain-filter.mjs's stampFor precedent): only the
      // vanished-path errnos are the race. Any OTHER errno — EACCES, EISDIR, EBUSY — is a
      // real defect, and a reader that quietly reports a plan as absent because it could not
      // be READ is the silent-misreport class this whole plan exists to kill. Those throw.
      const code = (e && e.code) || 'UNKNOWN';
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw e;
    }
    // `path` is collectPlanStamps()-only (the per-file tree-walk context readPlanStamps() doesn't
    // have); `specReview` and `specReviewBy` (plan 3047, the second named exception on identical
    // terms — see readPlanStamps()) now come straight off readPlanStamps()'s own key-loop — ONE
    // call into the frontmatter-scalar-reading subsystem per file, not a second bolted-on one.
    stamps[id] = { ...readPlanStamps(content), path: fullPath, folder, category };
  }
  return stamps;
}

// --- CLI --------------------------------------------------------------------

const USAGE =
  'usage: node scripts/read-plan-stamps.mjs [--json] [--include-archive] [--root <plansDir>]';

export function parseArgs(argv) {
  const opts = { root: DEFAULT_PLANS_ROOT, includeArchive: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `--json` is accepted and explicit because that is how the contract was written down in the
    // now-retired /cloud-eligibility master (and how the header above still documents the CLI),
    // but JSON is the ONLY output mode — there is no other shape to opt out of, so the flag is a
    // no-op rather than a mode switch that could be forgotten.
    if (a === '--json') continue;
    if (a === '--include-archive') {
      opts.includeArchive = true;
      continue;
    }
    if (a === '--root') {
      opts.root = argv[++i];
      if (!opts.root) throw new Error(`--root needs a directory\n${USAGE}`);
      continue;
    }
    if (a === '--help' || a === '-h') {
      opts.help = true;
      continue;
    }
    // Loud, not lenient: a consumer that mistypes a flag must not get a silently-different board.
    throw new Error(`unknown option: ${a}\n${USAGE}`);
  }
  return opts;
}

export function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log(USAGE);
    return;
  }
  log(JSON.stringify(collectPlanStamps(opts), null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (e) {
    console.error(e.message || e);
    process.exitCode = 2;
  }
}
