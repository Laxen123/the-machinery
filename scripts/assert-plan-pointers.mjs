#!/usr/bin/env node
// scripts/assert-plan-pointers.mjs — LANDED-PLAN-POINTER lint over the live docs corpus (plan 3204).
//
// The second mechanical staleness class the 2026-08-15 docs audit measured
// (`output/reports/2026-08-15-docs-staleness-gap-audit.md`, Class 2, ~14 instances): a doc
// says work is still coming — "until plan 2631 lands", "tracked as plan 1817" — and that plan
// archived weeks ago. The reader is told a shipped behaviour is a future one, which is worse
// than silence: it sends them looking for a workaround that no longer applies.
//
// THE CHECK. For each `plan NNNN` mention sitting inside one of the PENDING_PATTERNS below,
// if `docs/superpowers/plans/archive/NNNN-*` exists (and no live status folder holds that id),
// warn. Nothing else — the id is either archived or it is not.
//
// This is a HEURISTIC and stays WARN-ONLY permanently (plan 3204 § Scope 2), unlike its
// dead-pointer sibling whose promotion to blocking is at least discussable. "Is this sentence
// claiming the plan is still open?" is a judgement about English, and no regex settles it.
// The design therefore buys precision with narrowness:
//
//   • Each pattern carries the plan id INSIDE it, so the trigger phrase is next to the id, not
//     merely somewhere in the same sentence. "Pending" appearing 200 characters away in a long
//     runbook line is not evidence about this id.
//   • The land patterns match `lands`, never `landed`. That single choice removes the whole
//     past-tense false-positive family ("once plan 2631 had landed…") without a suppressor
//     list that would have to fight its own pending list for precedence.
//   • Every window is bounded by `.`, `;` and the end of line, so a match can never span two
//     sentences.
//
// The sharpest pattern is the last one and it is not a heuristic at all: a doc citing
// `docs/superpowers/plans/ready/1817-…md` for a plan that lives in `archive/` is stating the
// status in the path itself. `assert-doc-pointers.mjs` deliberately skips `plans/` paths
// (plans move between status folders by design, so a bare existence check there is noise) —
// this is the check that owns them, and it only fires when the id is genuinely archived.
//
// WAIVER — the same marker as the dead-pointer lint, so a reader learns one syntax:
//   … until plan 2631 lands <!-- doc-pointer-ok: quoting the 2026-07 plan text verbatim -->
// and `<!-- doc-pointer-ok-section: … -->` for a whole passage down to the next heading.
//
// GRANDFATHER — `scripts/plan-pointer-grandfather.txt`, seeded from the full-corpus run at
// land so the sibling doc sweeps own the existing cleanups instead of every push being warned
// about them. One `<doc> <planId>` pair per line; the list only shrinks.
//
// Modes and exit codes mirror assert-doc-pointers.mjs exactly:
//   node scripts/assert-plan-pointers.mjs                 # full corpus (the weekly run)
//   node scripts/assert-plan-pointers.mjs docs/<page>.md …     # just these files
//   … | node scripts/assert-plan-pointers.mjs --stdin     # how pre-push scopes to the diff
//   --check · --no-grandfather · --json
// 0 clean or WARN-only findings · 1 findings + --check · 2 usage error.

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The corpus definition and the waiver grammar are ONE fact each, owned by the dead-pointer
// lint and imported here — the two lints must never disagree about which documents are live
// or about what a waiver looks like.
import { isCorpusFile, listCorpus, waivedLines } from './assert-doc-pointers.mjs';
// The repo's ONE plans-path parser (plan 2678 — it owns the category-subfolder form) and its
// ONE "which id does this basename claim" parser (plan 2082 — it owns the date-shape exclusion).
import { claimedIdOfBasename, classifyPlanPaths } from './coord/build-index-lib.mjs';
// The repo's ONE plan-id normaliser (plan 2518) — '007' and '7' are the same plan. Kept as a
// shared helper rather than a local variant: a second normaliser is how two surfaces end up
// disagreeing about which id a row belongs to.
import { canonicalPlanId } from './coord/batch-paths.mjs';
import { readGrandfatherFile, runLint } from './doc-lint-cli.mjs';

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

export const PLANS_DIR = 'docs/superpowers/plans';

export const GRANDFATHER_FILE = 'scripts/plan-pointer-grandfather.txt';

/**
 * The auxiliaries that put a verb phrase in the PAST or the HYPOTHETICAL, as a chain of
 * negative lookbehinds. "The rollout WAS blocked on plan 2631 before it landed" is a historical
 * statement and correct forever; "the rollout IS blocked on plan 2631" is the claim this lint
 * exists to catch. Written once and shared by both verb-phrase patterns, so the pair cannot
 * drift into disagreeing about which tenses count as history.
 *
 * Spelled out one form at a time rather than collapsed into one alternation, because a bare
 * `been` cannot decide the case that matters: "HAD been blocked on plan 2631" is finished,
 * while "HAS been blocked on plan 2631" is present perfect and still true right now. So the
 * suppressors are only the unambiguous ones — `has been` / `have been` deliberately fall
 * through and report.
 *
 * MODALS is the COUNTERFACTUAL set only. `will` / `must` / `can` / `shall` are deliberately
 * absent: "it WILL be blocked on plan 2631" asserts a real future dependency, and if 2631 has
 * archived that is exactly the stale claim this lint is for. Suppressing it would silence the
 * finding rather than a false positive.
 *
 * Every entry is a form a trigger phrase can actually follow. There is no bare `(?:MODALS)\s`
 * entry, because every trigger is a past participle or an adjectival phrase ("blocked on",
 * "deferred to", "tracked as") — "would blocked on" is not English, so such a lookbehind could
 * never fire and would only read as coverage it does not provide.
 */
const MODALS = 'would|could|might|should';
const NOT_PAST_OR_HYPOTHETICAL = [
  '(?<!\\bwas\\s)',
  '(?<!\\bwere\\s)',
  '(?<!\\bhad\\s)',
  '(?<!\\bhad been\\s)',
  `(?<!\\b(?:${MODALS}) be\\s)`, // "would be blocked on plan N"
  `(?<!\\b(?:${MODALS}) have\\s)`, // "could have deferred to plan N"
  `(?<!\\b(?:${MODALS}) have been\\s)`, // "would have been blocked on plan N"
].join('');

/** A verb-phrase pattern: not-past-or-hypothetical, the trigger phrase, then the plan id. */
function verbPhrase(triggers) {
  return new RegExp(
    `${NOT_PAST_OR_HYPOTHETICAL}\\b(?:${triggers})\\b[^.;\\n("]{0,20}?\\bplans?\\s*(?:\\*\\*)?#?(\\d+)\\b`,
    'gi',
  );
}

/**
 * The phrasings that CLAIM a plan is still to come. Data, not code: adding a phrasing is one
 * row, and each row is reviewable on its own.
 *
 * Every pattern captures the plan id in group 1 and bounds its own window with `[^.;\n]` runs,
 * so a match cannot reach across a sentence boundary. `plans?\s*(?:\*\*)?#?` accepts the four
 * forms the corpus actually uses: `plan 2631`, `plans 2631`, `plan **2631**`, `plan #2631`.
 *
 * Three characters are excluded from the gaps, each after a measured false positive on the
 * first full-corpus run:
 *   `(`  a parenthesised id is a CITATION, not the object of the verb — "gated on GB seed
 *        depth (plan 3130)" says the gate is the seed depth and plan 3130 is where to read
 *        about it, which is true and past-tense.
 *   `"`  same shape with a quoted object — 'deferred to "decide at enable time" (plan 709)'.
 *   `'`  a possessive turns the land into a NOUN: "after plan 2603's land" is a reference to
 *        a land that happened, while "after plan 2603 lands" is a claim that it has not.
 * The two patterns whose window follows the id exclude `)` for the same citation reason, from
 * the other side: "…(plan 1320), but the class is open" is a sentence about the class.
 *
 * The two verb-phrase patterns also carry the NOT_PAST_OR_HYPOTHETICAL guard below. The land
 * patterns get the same protection for free from matching `lands` and never `landed`.
 *
 * The id capture is `\d+`, not a width — `next-plan-id` keeps counting, and a width silently
 * stops matching (never mis-matching) the day it is exceeded, which is the kind of expiry
 * nothing would notice. The trigger phrase before it is what bounds the match.
 */
export const PENDING_PATTERNS = [
  {
    name: 'until-lands',
    // "until plan 2631 lands", "once plan 2631 lands", "after plan 2631 lands".
    // `lands`/`land`, deliberately NOT `landed` — see the header.
    re: /\b(?:until|once|when|after|before)\b[^.;\n]{0,40}?\bplans?\s*(?:\*\*)?#?(\d+)(?:\*\*)?\b[^.;\n'()]{0,30}?\blands?\b/gi,
  },
  {
    name: 'blocked-on',
    re: verbPhrase(
      'blocked (?:on|by)|waiting (?:on|for)|gated on|depends on|deferred to|routed to',
    ),
  },
  {
    name: 'tracked-as',
    re: verbPhrase(
      'tracked (?:as|in|by)|filed as|filed in|carried into|carry-forwards? to|follow-ups? in',
    ),
  },
  {
    name: 'still-open',
    re: /\bplans?\s*(?:\*\*)?#?(\d+)(?:\*\*)?\b[^.;\n()"]{0,20}?\b(?:is|are|remains?)\s+(?:still\s+)?(?:open|pending|unlanded|not yet\b)/gi,
  },
  {
    name: 'pending-plan',
    // `pending(?!-)` so the FOLDER NAME `pending-approval/` never reads as the adjective.
    re: /\b(?:pending(?!-)|awaiting|not yet landed in)\b[^.;\n("]{0,20}?\bplans?\s*(?:\*\*)?#?(\d+)\b/gi,
  },
  {
    name: 'open-folder',
    // A path that states the status: `docs/superpowers/plans/ready/1817-….md`. Not a heuristic
    // — the doc is asserting the folder, and the folder is wrong. The optional segments before
    // the filename are the CATEGORY form `move-plan` emits (`parked/denmark/588-….md`, plan
    // 2678); without them a categorised plan's stale pointer is invisible to both lints, since
    // the dead-pointer sibling skips every `plans/` path by design.
    re: /docs\/superpowers\/plans\/(?:ready|pending-approval|in-progress|parked|waiting-[a-z-]+)\/(?:[A-Za-z0-9._-]+\/)*0*(\d+)[-.]/g,
  },
];

/**
 * Where each plan id lives today: `archive` or the name of a live status folder. Built from
 * the git index so an untracked stray plan file cannot flip a verdict. `lsFiles` is injected
 * for the battery.
 *
 * The PATH half routes through `build-index-lib.mjs::classifyPlanPaths`, the module that
 * already owns it — it understands the CATEGORY subfolder form `parked/denmark/588-….md`,
 * which a naive `<status>/<basename>` rebuild silently flattens.
 *
 * The ID half is `claimedIdOfBasename` — the module's "leading digits, minus the one
 * false-positive date shape" parser (plan 2082), NOT its `planIdOf`. That distinction is
 * measured, not stylistic: `planIdOf` requires a LETTER after the id, and **86 archived plans**
 * are named `NNN-YYYY-MM-DD-title.md` (`001-2026-05-21-fb-insta-ui-surface.md`), so it drops
 * every one of them and a doc claiming plan 1 is still coming goes unnoticed.
 * `claimedIdOfBasename` admits those 86, still returns null for the four LEGACY plans named by
 * date ALONE (`2026-05-17-….md`, where naive leading digits mint a phantom archived plan 2026),
 * and caps the id at no width — which matters, because the pending-phrase patterns match `\d+`
 * and a filename parser that stopped short would silently disagree with them.
 *
 * Ids are keyed by their numeric value as a string, because the corpus writes them both ways:
 * the file is `007-P07-….md` and the prose says "plan 7".
 */
export function planFolders(root = REPO_ROOT, lsFiles = defaultLsFiles) {
  const byId = new Map();
  for (const { statusFolder, basename: base } of classifyPlanPaths(lsFiles(root))) {
    const claimed = claimedIdOfBasename(base);
    if (claimed === null) continue;
    const key = canonicalPlanId(claimed);
    // Any status but `archive` means the plan is still open — including `parked`, which is a
    // deliberate freezer for a live, resurrectable plan — so a "still coming" claim is correct
    // and this lint stays quiet.
    if (statusFolder !== 'archive' || !byId.has(key)) byId.set(key, statusFolder);
  }
  return byId;
}

function defaultLsFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z', '--', `${PLANS_DIR}/*.md`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

/**
 * Every pending-phrased plan mention in `text`, with its line number, matched pattern and id.
 * Waived lines are dropped here, so a waiver costs nothing downstream.
 */
export function extractPlanClaims(text, patterns = PENDING_PATTERNS) {
  const waived = waivedLines(text);
  const claims = [];
  const seen = new Set(); // one claim per (line, id), whichever pattern spotted it first

  text.split('\n').forEach((line, idx) => {
    const lineNo = idx + 1;
    if (waived.has(lineNo)) return;
    for (const { name, re } of patterns) {
      // The patterns are module-level /g regexes shared across every line and every document
      // in a run. `matchAll` copies lastIndex into its own matcher and leaves the source
      // untouched, so this reset is a no-op TODAY — it is here so that a future refactor to
      // `re.exec` (the obvious way to reach for match offsets) cannot silently start each line
      // mid-way through the previous one and drop matches with no test failing.
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        const id = canonicalPlanId(m[1]);
        const key = `${lineNo} ${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        claims.push({ line: lineNo, id, pattern: name, text: m[0].trim() });
      }
    }
  });

  return claims.sort((a, b) => a.line - b.line);
}

/**
 * Read the frozen snapshot of already-stale claims: one `<doc> <planId>` pair per line. Ids are
 * normalised to their numeric value, so a zero-padded `007` and a bare `7` are one plan — the
 * same normalisation `planFolders` and `extractPlanClaims` apply.
 */
export function readGrandfather(root = REPO_ROOT, file = GRANDFATHER_FILE) {
  return readGrandfatherFile(root, file, canonicalPlanId);
}

/** Lint one document. Pure — `folders` decides plan state, so the battery needs no plans tree. */
export function lintDocument(doc, { folders, grandfather = new Set(), claims, text }) {
  const findings = [];
  let grandfathered = 0;
  for (const claim of claims ?? extractPlanClaims(text)) {
    if (folders.get(claim.id) !== 'archive') continue;
    if (grandfather.has(`${doc} ${claim.id}`)) {
      grandfathered += 1;
      continue;
    }
    findings.push({
      doc,
      line: claim.line,
      kind: 'landed-plan-pointer',
      id: claim.id,
      pattern: claim.pattern,
      message: `plan ${claim.id} has ARCHIVED, but this reads as still-coming [${claim.pattern}]: "${truncate(claim.text)}"`,
    });
  }
  return { findings, grandfathered };
}

function truncate(s, n = 100) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * CLI entry. `opts.root` / `opts.files` / `opts.readDoc` / `opts.folders` are the battery seams.
 * The command SHAPE is doc-lint-cli.mjs's, shared with the dead-pointer lint.
 */
export function main(argv = process.argv.slice(2), opts = {}) {
  return runLint(
    {
      name: 'assert-plan-pointers',
      repoRoot: REPO_ROOT,
      grandfatherFile: GRANDFATHER_FILE,
      isCorpusFile,
      listCorpus,
      noun: { many: 'landed-plan pointer(s)' },
      normalizeGrandfatherKey: canonicalPlanId,
      parse: (doc, text) => ({ doc, claims: extractPlanClaims(text) }),
      // ONE `git ls-files` over the plans tree for the whole run, not one per document.
      prepare: (_items, root, o) => ({ folders: o.folders ?? planFolders(root) }),
      lintItem: ({ doc, claims }, { grandfather, ctx }) =>
        lintDocument(doc, { folders: ctx.folders, grandfather, claims }),
      advice:
        'Rewrite the sentence in the past tense (the behaviour shipped — say what it DOES), ' +
        'or, if the mention is deliberately quoting history, mark it in place with ' +
        '`<!-- doc-pointer-ok: <reason> -->`. This lint is a heuristic and never blocks; ' +
        'see the header of scripts/assert-plan-pointers.mjs.',
    },
    argv,
    opts,
  );
}

// CLI entry — `pathToFileURL`, never a hand-built `file://` (plan 1555; see the twin note in
// scripts/assert-doc-pointers.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
