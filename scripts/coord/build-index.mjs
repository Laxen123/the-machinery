#!/usr/bin/env node
// scripts/build-index.mjs
// Generate docs/INDEX.md's active plan-bullet region from per-plan metadata.
// INDEX is derived data — the plan FILE is the single source of truth — so no
// session ever hand-edits the bullet list again (plan 249). A plan move becomes
// "git mv + re-run this", and INDEX↔plans drift becomes structurally impossible.
//
// Source of plan paths: `git ls-files` (NOT a filesystem walk). An untracked
// foreign plan another session dropped in ready/ is therefore INVISIBLE here —
// it can't gate anyone's push (kills the orphan-paralysis trigger that Task 2's
// lint flip relies on).
//
// Usage:
//   node scripts/build-index.mjs            # rewrite docs/INDEX.md in place
//   node scripts/build-index.mjs --check    # exit 1 (no write) if INDEX would change
//   node scripts/build-index.mjs --print    # write the regenerated INDEX to stdout
//
// Only the region between the INDEX:PLANS-START / INDEX:PLANS-END sentinels is
// owned here. The prose conventions above them and the archive narrative below
// them are preserved verbatim.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePlanMeta,
  parseSpecMeta,
  renderPlansBlock,
  renderSpecsBlock,
  splicePlansBlock,
  spliceSpecsBlock,
  SPECS_PREFIX,
  STATUS_ORDER,
  PLAN_FILENAME_RX,
  classifyPlanRel,
  planRelFor,
} from './build-index-lib.mjs';
import { loadCoordConfig } from './coord-config.mjs';
import { GIT_MAXBUFFER, git, coordWrite } from './coord-git.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';

const REPO_ROOT = repoRootFrom(dirname(fileURLToPath(import.meta.url)));
const INDEX_REL = 'docs/INDEX.md';
const INDEX_PATH = join(REPO_ROOT, INDEX_REL);
const PLANS_PREFIX = 'docs/superpowers/plans/';

// PLAN_FILENAME_RX is imported from build-index-lib.mjs (plan 1945) — the single
// source every consumer (this file, lint-board.mjs, next-plan-id.mjs) now derives
// from, instead of three independently hand-typed copies of the same literal.

// Sanctioned non-plan docs that legitimately live under a STATUS_ORDER folder's
// filename shape but aren't plans — exempted by NAME (plan 1945), never by loosening
// PLAN_FILENAME_RX itself. FOG.md (plan-shaped material not yet a plan, plans root)
// is the only member today; it's already excluded upstream by folder location (it
// has no STATUS_ORDER subfolder), but the allowlist makes that exemption explicit and
// future-proof against FOG.md (or a sibling doc) ever moving under a status folder.
const NON_PLAN_FILENAME_ALLOWLIST = new Set(['FOG.md']);

function gitLsPlans() {
  const out = execFileSync('git', ['ls-files', `${PLANS_PREFIX}*.md`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: GIT_MAXBUFFER, // plan 850: uniform with the spine; the plans tree should never need it but stays safe
    env: gitRepoIsolatedEnv(),
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// plan 2678: status is the FIRST segment under plans/, with an optional single category
// folder between it and the file. The old first-slash split returned
// `{status: 'ready', basename: 'infra/2678-Coord-x.md'}` for a categorised plan, whose
// basename then failed PLAN_FILENAME_RX — turning a legal `git mv` into a hard
// plan-1928 "INVISIBLE to docs/INDEX.md" error. classifyPlanRel is the shared splitter.
function statusAndBasename(relPath) {
  const { statusFolder, category, basename } = classifyPlanRel(relPath.slice(PLANS_PREFIX.length));
  return { status: statusFolder, category, basename };
}

// opts (plan 651) injects the two IO seams so the half-staged-rename skip is
// unit-testable without mutating the real repo's git index: `lsFiles` → the tracked
// plan paths (default `gitLsPlans`); `readFile(rel)` → that path's content (default
// reads REPO_ROOT/rel), throwing an ENOENT-coded error for a tracked-but-missing path.
export function collectPlans({
  lsFiles = gitLsPlans,
  readFile = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8'),
  // plan 924: a `loadConfig` seam alongside lsFiles/readFile so an in-process caller
  // (claim-plan's regenIndexContent) can read coord.config.json from the SAME mainDir it
  // injects for lsFiles/readFile — not the module-level REPO_ROOT, which is build-index.mjs's
  // own checkout and can differ from the main checkout when imported from a linked worktree.
  loadConfig = () => loadCoordConfig(REPO_ROOT),
} = {}) {
  const plans = [];
  const warnings = [];
  const errors = [];
  const cfg = loadConfig();
  for (const rel of lsFiles()) {
    const { status, category, basename } = statusAndBasename(rel);
    if (!STATUS_ORDER.includes(status)) continue; // archive/, root, off-convention
    // plan 2678: the plans-relative path as it really is, so every message below (and
    // the bullet itself) names the file an operator can actually open.
    const shown = planRelFor({ status, category, basename });
    // plan 4122: a lane-keeper file (`README.md`/`README.txt`, landed so an otherwise-empty
    // status folder survives `git mv`-into-an-emptied-lane — see coord-git.mjs's
    // ensureMvDestDir, which now makes the keeper unnecessary but not forbidden) is not a
    // plan and is skipped SILENTLY here, before the PLAN_FILENAME_RX check below — never
    // added to NON_PLAN_FILENAME_ALLOWLIST (that set is for sanctioned non-plan DOCS like
    // FOG.md, a different exemption) and never by loosening PLAN_FILENAME_RX itself, which
    // every other non-matching basename still fails against as a hard ERROR.
    //
    // Keyed to a DIRECT lane entry (`category === null`), not to the basename alone
    // (gpt-review finding 4038e4): a keeper exists to hold a STATUS FOLDER open, so
    // `ready/infra/README.md` is a misplaced file rather than a keeper — exempting it
    // by basename would reinstate the plan-1928 invisibility one directory down.
    if (!category && (basename === 'README.md' || basename === 'README.txt')) continue;
    if (!PLAN_FILENAME_RX.test(basename)) {
      // plan 1945: a tracked ACTIVE-folder plan whose basename fails PLAN_FILENAME_RX
      // (e.g. a lowercase category tag) used to be silently `continue`d here — the
      // 1928 incident: minted, spec-passed, board-passed, routed to ready/, and
      // COMPLETELY INVISIBLE to docs/INDEX.md, with the regenerate-and-diff pre-push
      // lint green throughout (the regen skips it too, so generated == committed).
      // A sanctioned non-plan doc (FOG.md) is exempted BY NAME, never by loosening the
      // regex; everything else is now a hard ERROR, not a silent skip.
      if (!NON_PLAN_FILENAME_ALLOWLIST.has(basename)) {
        errors.push(
          `${shown} — filename fails PLAN_FILENAME_RX (needs an uppercase-led ` +
            `Category tag right after the id, e.g. "tooling" → "Tooling") — this plan is ` +
            `INVISIBLE to docs/INDEX.md until renamed (the plan-1928 failure mode).`,
        );
      }
      continue; // still not indexed — renaming it is the fix, not indexing it as-is
    }
    // plan 651: a tracked path whose working file is missing — the half-staged
    // `git mv` state (deletion unstaged + untracked archive copy) a crashed close-out
    // can leave — must NOT ENOENT-crash the whole INDEX regen. `git ls-files` still
    // lists the OLD in-progress path while the file already sits at archive/ on disk;
    // skip it with a warning (the in-flight close-out's own regen, run AFTER its staged
    // mv, sees the corrected ls-files and indexes the plan in its real folder).
    let content;
    try {
      content = readFile(rel);
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        warnings.push(`${shown} — tracked but missing on disk (half-staged rename?); skipped`);
        continue;
      }
      throw e;
    }
    const meta = parsePlanMeta(content, { seedLane: cfg.seedLane });
    if (!meta.hasFrontmatterSummary) {
      warnings.push(`${shown} — no \`summary:\` frontmatter (used H1 fallback)`);
    }
    plans.push({ status, category, basename, marker: meta.marker, summary: meta.summary });
  }
  return { plans, warnings, errors };
}

function gitLsSpecs() {
  // `git ls-files docs/superpowers/specs/*.md`: git's `*` matches `/`, so the one
  // glob enumerates BOTH the top-level (active) specs AND everything under
  // archive/ (incl. the nested investigation/redesign sub-folders) — every spec
  // file, tracked-only. An untracked foreign spec another session dropped in is
  // therefore invisible here, same as collectPlans (it can't gate a push).
  const out = execFileSync('git', ['ls-files', `${SPECS_PREFIX}*.md`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: GIT_MAXBUFFER,
    env: gitRepoIsolatedEnv(),
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// Mirrors collectPlans' IO seams (plan 651) so the missing-on-disk skip is
// unit-testable: `lsFiles` → tracked spec paths; `readFile(rel)` → that path's text.
export function collectSpecs({
  lsFiles = gitLsSpecs,
  readFile = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8'),
} = {}) {
  const specs = [];
  const warnings = [];
  for (const rel of lsFiles()) {
    const displayPath = rel.slice(SPECS_PREFIX.length);
    let content;
    try {
      content = readFile(rel);
    } catch (e) {
      // Same half-staged-rename tolerance as collectPlans: a tracked path whose
      // working file is momentarily missing must warn-and-skip, never crash the regen.
      if (e && e.code === 'ENOENT') {
        warnings.push(`${rel} — tracked but missing on disk (half-staged rename?); skipped`);
        continue;
      }
      throw e;
    }
    const { blurb, source } = parseSpecMeta(content);
    if (source === 'none') {
      warnings.push(`${rel} — no frontmatter summary/title or H1 (used '(no summary)')`);
    }
    specs.push({ displayPath, blurb });
  }
  return { specs, warnings };
}

// ─── In-process, mainDir-parameterised INDEX maintenance (plan 926) ──────────
// main() below regenerates THIS checkout's docs/INDEX.md off the module-level
// REPO_ROOT, by spawning a process. These three helpers do the same work for an
// ARBITRARY mainDir, IN-PROCESS (no spawned `node build-index.mjs` child) — so a
// caller that must regenerate + stage docs/INDEX.md inside ONE commit (move-plan,
// claim-plan) closes the wide clobber window a child-process spawn opens. ROOT
// CAUSE (plan 924/926): between a spawned build-index's writeFileSync and the
// caller's pathspec commit there is a full process lifetime, during which a
// PARALLEL coord process on the shared main checkout can forcibly overwrite the
// working-tree docs/INDEX.md (a sibling coordWrite rollback's `git restore`, a
// sibling build-index's writeFileSync, a sibling move-plan rollback's `git
// checkout`) — so the pathspec commit (which re-reads the WORKING TREE) captures a
// STALE INDEX (the moved file is in its new folder but its bullet stayed in the
// old). In-process regen shrinks that window to consecutive synchronous git calls.

// Regenerate mainDir's docs/INDEX.md text (both generated regions) from its tracked
// plan/spec set — the in-process equivalent of `build-index --print` for ANY checkout.
// Reads the set straight from mainDir's git index via collectPlans/collectSpecs' IO
// seams, and coord.config.json from mainDir (NOT the module REPO_ROOT, which is this
// file's own checkout and can differ from the main checkout when imported from a linked
// worktree). Returns the full regenerated INDEX text.
export function regenerateIndex(mainDir) {
  const split = (out) =>
    out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  const readFile = (rel) => readFileSync(join(mainDir, rel), 'utf8');
  const { plans, errors } = collectPlans({
    lsFiles: () => split(git(mainDir, ['ls-files', `${PLANS_PREFIX}*.md`])),
    readFile,
    loadConfig: () => loadCoordConfig(mainDir),
  });
  // plan 1945 (sonnet-review finding): this in-process regen (claim-plan.mjs,
  // move-plan.mjs, stamp-lib.mjs all call it, alongside healIndexDrift/indexIsCurrent
  // below) used to silently omit a bad-filename ACTIVE plan just like the pre-1945
  // CLI did. Not thrown here — these callers run for an UNRELATED plan's write, and
  // throwing would crash that write over a stray file elsewhere in the tree (the
  // exact over-broad failure the CLI's own --check-only scope avoids, see main()).
  // The pre-push `build-index --check` (lint-plan-index.mjs, unconditional on every
  // push) is what actually blocks a push until the file is renamed; this is a loud
  // diagnostic for whoever is watching this process's stderr in the meantime.
  for (const e of errors) console.error(`build-index: ERROR ${e}`);
  const { specs } = collectSpecs({
    lsFiles: () => split(git(mainDir, ['ls-files', `${SPECS_PREFIX}*.md`])),
    readFile,
  });
  const current = readFileSync(join(mainDir, INDEX_REL), 'utf8');
  return spliceSpecsBlock(
    splicePlansBlock(current, renderPlansBlock(plans)),
    renderSpecsBlock(specs),
  );
}

// Is mainDir's on-disk docs/INDEX.md already consistent with its tracked plan/spec set?
// (The in-process, mainDir-parameterised equivalent of `build-index --check`.)
export function indexIsCurrent(mainDir) {
  return readFileSync(join(mainDir, INDEX_REL), 'utf8') === regenerateIndex(mainDir);
}

// Idempotently regenerate + commit docs/INDEX.md through coordWrite until it is
// consistent with the committed plan/spec set, bounded by `attempts`. The all-caller
// backstop for the microsecond residual that survives in-process regen: even if a
// parallel coord process clobbers the working-tree INDEX in the regen→commit window so
// a move commits a STALE INDEX, this re-commits the correct one before the caller
// proceeds. coordWrite's no-op short-circuit makes the already-consistent case (the
// common one) a ZERO-commit no-op. It converges because, once the rename is committed,
// `git ls-files` stably reports the plan in its real folder and the regen→add are
// consecutive in-process git calls (no child spawn). `label` names the triggering
// operation for the commit/throw messages; `deps` injects indexIsCurrent/coordWrite for
// unit tests. Returns { healed, attempts }; throws if it never converges.
export function healIndexDrift(mainDir, { label, attempts = 5 } = {}, deps = {}) {
  const isCurrent = deps.indexIsCurrent || (() => indexIsCurrent(mainDir));
  const write = deps.coordWrite || coordWrite;
  for (let i = 0; i < attempts; i++) {
    if (isCurrent()) return { healed: i > 0, attempts: i };
    write(mainDir, {
      relPaths: [INDEX_REL],
      mutate: () => writeFileSync(join(mainDir, INDEX_REL), regenerateIndex(mainDir)),
      message: `docs(plans): heal INDEX repath drift after ${label}`,
      tool: 'index',
    });
  }
  if (!isCurrent())
    throw new Error(
      `docs/INDEX.md still drifted for ${label} after ${attempts} heal attempts. ` +
        `Repair manually: \`node scripts/build-index.mjs\` then \`node scripts/coord-edit.mjs --paths docs/INDEX.md --message "heal INDEX drift"\`.`,
    );
  return { healed: true, attempts };
}

export function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const print = args.includes('--print');

  const { plans, warnings: planWarnings, errors } = collectPlans();
  const { specs, warnings: specWarnings } = collectSpecs();
  const warnings = [...planWarnings, ...specWarnings];
  const current = readFileSync(INDEX_PATH, 'utf8');
  // Splice both generated regions; they live in disjoint parts of the file
  // (specs above "## Plans", plans between the INDEX:PLANS sentinels), so order
  // is irrelevant.
  const next = spliceSpecsBlock(
    splicePlansBlock(current, renderPlansBlock(plans)),
    renderSpecsBlock(specs),
  );

  for (const w of warnings) console.error(`build-index: WARN ${w}`);
  for (const e of errors) console.error(`build-index: ERROR ${e}`);

  // plan 1945: a bad-filename ACTIVE plan is now a hard stop — but ONLY for --check
  // (and therefore the pre-push lint, which runs unconditionally on every push —
  // lint-plan-index.mjs — so this is loud within one push regardless of what that
  // push itself touches). The default write mode is deliberately NOT hard-failed
  // here: `done-worktree.mjs`'s `regenIndex()` invokes the plain (no-flag) CLI
  // unconditionally on EVERY land close-out, for whichever plan is landing — an
  // unrelated bad-filename plan elsewhere in the tree must not crash every
  // session's land (a sonnet-review finding on this plan's own diff). The bad file
  // stays un-indexed (same skip as before this plan) but now LOUD via the ERROR
  // lines above; --check is what actually blocks a push until it's renamed.
  if (check && errors.length > 0) {
    console.error(
      `build-index: ${errors.length} ACTIVE plan filename(s) fail PLAN_FILENAME_RX — ` +
        `rename the file(s) above (e.g. via \`git mv\` + \`node scripts/move-plan.mjs\`) ` +
        `before regenerating docs/INDEX.md.`,
    );
    return 1;
  }

  if (print) {
    process.stdout.write(next);
    return 0;
  }
  if (check) {
    if (next !== current) {
      console.error(
        'build-index: docs/INDEX.md is STALE — run `node scripts/build-index.mjs` and stage it.',
      );
      return 1;
    }
    console.log(
      `build-index: docs/INDEX.md up to date (${plans.length} active plans, ${specs.length} specs).`,
    );
    return 0;
  }
  if (next !== current) {
    writeFileSync(INDEX_PATH, next);
    console.log(
      `build-index: regenerated docs/INDEX.md (${plans.length} active plans, ${specs.length} specs, ${warnings.length} warnings).`,
    );
  } else {
    console.log(
      `build-index: docs/INDEX.md already current (${plans.length} active plans, ${specs.length} specs).`,
    );
  }
  return 0;
}

// CLI only (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
