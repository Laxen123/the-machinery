#!/usr/bin/env node
// scripts/coord/wiki-updated-merge-driver.mjs (plan 1528 A2)
// Custom git merge driver for wiki/**/*.md, scoped to ONE recurring conflict class: the
// frontmatter `updated: YYYY-MM-DD` line. Hot wiki pages are bumped by many parallel
// sessions (every write-back bumps `updated:`), and wiki/coord commits bypass the landing
// queue — so a rebase/merge under a landing-queue head recurrently conflicts on that ONE
// line (twice in a single land on 2026-07-06, each costing a session halt). The honest
// resolution is fully mechanical: take the LATER date. Everything else about the page is
// deliberately NOT auto-resolved — any conflict hunk beyond a lone `updated:` line on both
// sides exits 1 and leaves standard conflict markers for the session, exactly like the
// default driver.
//
// Invocation (registered by scripts/ensure-wiki-merge-driver.mjs — config + the attribute
// live together in .git/{config,info/attributes}, so an unregistered clone has NEITHER and
// git falls back to the default text merge):
//   node scripts/coord/wiki-updated-merge-driver.mjs %O %A %B
// %O ancestor · %A ours (the result must be written here) · %B theirs.
// Exit 0 = merged clean (possibly via the updated:-line rule) · 1 = genuine conflict
// (markers left in %A) · 2 = driver error (git treats nonzero as conflict — fail-safe).
//
// Self-contained on node built-ins (a merge driver must never drag repo deps); the pure
// resolution functions are exported for scripts/coord/wiki-updated-merge-driver.test.mjs.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Accepts both the bare `updated: YYYY-MM-DD` form and the wiki page-budget contract's
// annotated superset `updated: YYYY-MM-DD (plan NNNN: ...)` (plan 3415 Item C fix 3 — this
// generalises what used to be a SECOND, drifting copy of this exact rule inline in
// wiki-commit.mjs's own hand-rolled merge-file fallback; that copy is gone, wiki-commit now
// calls resolveUpdatedOnlyConflicts below directly).
// Exported (plan 3415 item C review, cluster 10) so wiki-commit.mjs's containment guard can
// reuse this SAME grammar instead of hand-rolling a second copy that could drift from it.
export const UPDATED_LINE_RE = /^updated:\s*(\d{4}-\d{2}-\d{2})(?:\s+(\(.*\)))?\s*$/;

// One conflict block's ours/theirs bodies → the resolved text, or null when this block
// is NOT the updated:-line class (anything but exactly one `updated:` line per side).
// ISO dates compare lexicographically — take the later bump (both sides DID write). On an
// EXACT tie (the normal case on a hot page many sessions touch the same day) neither side's
// provenance annotation is dropped silently (plan 3415 Item C fix 2): mergeSameDateAnnotations
// combines them, deduplicating an identical parenthetical.
export function resolveUpdatedBlock(ours, theirs, opts = {}) {
  const one = (s) => {
    const lines = String(s)
      .split(/\r?\n/)
      .filter((l, i, a) => !(l === '' && i === a.length - 1));
    return lines.length === 1 ? lines[0] : null;
  };
  const o = one(ours);
  const t = one(theirs);
  if (o == null || t == null) return null;
  const om = o.match(UPDATED_LINE_RE);
  const tm = t.match(UPDATED_LINE_RE);
  if (!om || !tm) return null;
  if (om[1] > tm[1]) return `${o}\n`;
  if (tm[1] > om[1]) return `${t}\n`;
  return mergeSameDateAnnotations(om[1], om[2], tm[2], opts);
}

// The combined `updated:` VALUE (date + annotation) still owes the page-budget contract's
// 400-byte cap (WIKI.md § Page budgets rule 3; the canonical constant is wiki-size-lint.mjs's
// UPDATED_MAX — NOT imported here, since this file is deliberately self-contained on node
// built-ins only, per the file header: a merge driver must never drag repo deps. Exported so
// wiki-updated-merge-driver.test.mjs can assert it stays pinned to wiki-size-lint.mjs's
// UPDATED_MAX — a test, unlike this module, may freely import both).
export const UPDATED_VALUE_MAX_BYTES = 400;

// Both sides bumped `updated:` to the SAME date. `oursAnn`/`theirsAnn` are the matched `(...)`
// group or undefined (bare form).
//
// plan 3415 Item C round 3 (findings 1xugg58 / yz4ii4 / 1bfdsx4): the prior design split each
// annotation into `; `-separated "entries" and deduped/trimmed at that granularity. Measured
// against the real vault (85 committed `updated:` lines, 2026-08-25): 38 contain a semicolon,
// and in the real data a semicolon is ordinary sentence punctuation inside ONE narrative note
// just as often as it is an entry delimiter — e.g. `updated: 2026-08-16 (plan 3201 retire-back
// sweep: \`REQUIRED_PRICE_AXES\` bullet now names \`kremering\` (joined plan 2691, 2026-08-02);
// added the \`isKastreringLeadingBundleRow\` addendum (plan 2994). Full history in wiki/log.md)`.
// Splitting that on `;` corrupts the note. "`; ` delimits discrete provenance entries" is
// factually wrong against the corpus this resolver actually sees, so entry-level parsing is
// gone entirely — free-text provenance is not machine-decomposable, and this function no
// longer tries to decompose it:
//   - identical annotations (including both bare) collapse to one copy, unchanged;
//   - distinct annotations are kept BOTH, WHOLE, joined by `; ` — never split, deduped, or
//     reordered internally (ours first, then theirs);
//   - if the combined value would overflow the 400-byte `updated:` cap (WIKI.md § Page
//     budgets rule 3), the merge REFUSES explicitly (returns null, exactly like any other
//     unresolvable conflict block — markers stay for a human) rather than silently trimming.
//     Round 2's oldest-first trim reintroduced exactly the silent-provenance-loss shape plan
//     3415 Item C rules unacceptable (finding 1bfdsx4); overflow is precisely where an explicit
//     refusal is the sanctioned option, not a hazard to route around.
// `pagePath` (threaded from resolveUpdatedOnlyConflicts → main(), the registered git
// merge/rebase path) only NAMES the file in the refusal warning below — never required for
// correctness, so a caller that has no path handy (e.g. wiki-commit.mjs's hand-rolled merge)
// can omit it.
function mergeSameDateAnnotations(date, oursAnn, theirsAnn, { pagePath } = {}) {
  // ONE budget policy for both paths. The identical-annotation path used to return early without
  // any check (plan 3415 round-3 review), so two sides agreeing on an already-oversized line
  // propagated it silently — the exact silent-overflow class the refusal below exists to stop.
  // Both paths now build `value` first and run the same check on it.
  const inner = (ann) => (ann ? ann.replace(/^\(|\)$/g, '') : '');
  const value =
    oursAnn === theirsAnn
      ? `${date}${oursAnn ? ` ${oursAnn}` : ''}`
      : (() => {
          const combined = [inner(oursAnn), inner(theirsAnn)].filter(Boolean).join('; ');
          return combined ? `${date} (${combined})` : date;
        })();
  if (Buffer.byteLength(value, 'utf8') > UPDATED_VALUE_MAX_BYTES) {
    console.error(
      `wiki-updated-merge-driver: refusing to auto-merge${pagePath ? ` ${pagePath}` : ''}'s ` +
        `updated: line — both sides bumped to the same date (${date}) but keeping BOTH ` +
        `annotations whole would exceed the ${UPDATED_VALUE_MAX_BYTES}-byte updated: cap ` +
        `(ours: ${JSON.stringify(oursAnn ?? '(none)')}, theirs: ${JSON.stringify(theirsAnn ?? '(none)')}). ` +
        'Leaving conflict markers for a human to resolve by hand — never silently trimming ' +
        "one side's provenance (plan 3415 Item C round 3).",
    );
    return null; // explicit refusal, never a silent trim
  }
  return `updated: ${value}\n`;
}

// Fence rule mirrors build-index-lib.mjs's frontmatterEnd (a line that is EXACTLY `---`,
// trailing whitespace tolerated, leading whitespace not) — duplicated rather than imported
// because this file is self-contained on node built-ins only (file header: a merge driver
// must never drag repo deps). Returns the LINE INDEX of the closing fence, or -1 when there is
// no leading frontmatter block.
function frontmatterEndLine(lines) {
  const isFence = (l) => (l ?? '').replace(/\s+$/, '') === '---';
  if (!isFence(lines[0])) return -1;
  for (let i = 1; i < lines.length; i++) {
    if (isFence(lines[i])) return i;
  }
  return -1;
}

// Resolve every conflict block in `text` (git merge-file / merge-style markers, diff3
// tolerated — the optional `|||||||` base section is skipped) IFF every block is the
// updated:-line class. Returns the fully-resolved text, or null when ANY block refuses
// (the caller then leaves the markers in place and exits conflicted — no half-resolve:
// a partially auto-resolved file would hide which hunks a human still owes).
//
// plan 3415 Item C review (finding a9ocvj): a block is only EVER the updated:-line class when
// it sits INSIDE the page's leading `---` frontmatter fence — never a body line that merely
// LOOKS like `updated: YYYY-MM-DD (...)` (a quoted example, a changelog bullet). Scoped by the
// conflict block's own line position against the frontmatter's closing fence line, computed
// once against the pre-conflict-resolution text (the fence lines themselves are never part of
// an updated:-only hunk, so they survive untouched regardless of how many conflict blocks
// precede the closing fence).
export function resolveUpdatedOnlyConflicts(text, { pagePath } = {}) {
  const str = String(text);
  const closeLine = frontmatterEndLine(str.split(/\r?\n/));
  const re =
    /^<{7}[^\n]*\r?\n([\s\S]*?)(?:^\|{7}[^\n]*\r?\n[\s\S]*?)?^={7}\r?\n([\s\S]*?)^>{7}[^\n]*\r?\n?/gm;
  let sawBlock = false;
  let resolvedAll = true;
  const out = str.replace(re, (block, ours, theirs, offset) => {
    sawBlock = true;
    const blockLine = str.slice(0, offset).split(/\r?\n/).length - 1;
    if (closeLine === -1 || blockLine >= closeLine) {
      resolvedAll = false; // outside frontmatter — never this class, regardless of shape
      return block;
    }
    const r = resolveUpdatedBlock(ours, theirs, { pagePath });
    if (r == null) {
      resolvedAll = false;
      return block;
    }
    return r;
  });
  return sawBlock && resolvedAll ? out : null;
}

export function main(argv) {
  const [O, A, B] = argv;
  if (!O || !A || !B) {
    console.error('wiki-updated-merge-driver: expected %O %A %B (ancestor ours theirs)');
    return 2;
  }
  // Standard three-way first — clean merges (the overwhelmingly common case) stay
  // byte-identical to the default driver. Nonzero exit = number of conflicts, with
  // markers already written into A.
  try {
    // coord-git-repo-selector-waiver: `git merge-file` never consults a repository (a bogus
    // GIT_DIR provably doesn't change its output) and this file's own header keeps it
    // self-contained on node builtins — importing the sibling child-env.mjs here breaks the
    // isolated-plan-repo merge-driver test, which copies only this one file into a scratch repo.
    execFileSync('git', ['merge-file', A, O, B], { stdio: 'ignore' });
    return 0;
  } catch (e) {
    if (!(typeof e.status === 'number' && e.status > 0)) {
      console.error(`wiki-updated-merge-driver: git merge-file failed — ${e.message}`);
      return 2;
    }
  }
  const resolved = resolveUpdatedOnlyConflicts(readFileSync(A, 'utf8'), { pagePath: A });
  if (resolved == null) return 1; // genuine conflict — markers stay for the session
  writeFileSync(A, resolved);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error('wiki-updated-merge-driver:', e.message);
    process.exit(2);
  }
}
