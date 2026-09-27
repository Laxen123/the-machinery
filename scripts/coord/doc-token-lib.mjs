#!/usr/bin/env node
// scripts/coord/doc-token-lib.mjs — generic path-token helpers for doc-freshness lints (plan 3958).
//
// WHY THIS MODULE EXISTS: `scripts/assert-doc-pointers.mjs` and `scripts/assert-plan-pointers.mjs`
// are themselves generic (no vetapp semantics of their own — they check docs/, wiki/, WIKI.md,
// CLAUDE.md for dead path references and stale "plan N" claims), but until this extraction they
// imported their brace-expander / glob-matcher / gitignore-batcher / word-splitter / token-trimmer
// from the project's pipeline-doc lint, which hard-imports the project's pipeline-doc parser (the
// project's own stage-map parser, project-only) for its OWN stage-heading grammar. That
// coupling put a vetapp-only module in the doc-pointer lints' import closure even though they
// never call anything PIPELINE.md-specific, which is why coord-kit's build routed them through a
// project seam (`pp_project_doc_pointer_lints` in a project's own pre-push hook, commit
// ed545cf3750) instead of shipping them in core. This module is the fix: the five helpers those
// two lints actually need, with no import of `pipeline-doc.mjs` or anything else project-shaped,
// so their closure can go clean and the check can move back into `pre-push-core.sh`.
//
// SHIP CONSTRAINT (docs/coord/scripts-layout.md § Rule 3): this module lives under
// scripts/coord/, which the kit ships verbatim, so it may import ONLY node: builtins and
// scripts/coord/** siblings.
//
// `lint-pipeline-doc.mjs` now imports these same five from here too (rather than keeping a
// second copy), so PIPELINE.md's own check (A) and the doc-pointer lints share one brace-expander,
// one glob-matcher and one gitignore-batcher — a second copy is exactly how the `{a,b}` /
// `<PLACEHOLDER>` / trailing-`/` edge cases (two review rounds to get right the first time) would
// drift apart.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The shared regex-escape one-liner plan 1328 consolidated (four copies → one export) — see
// segmentMatcher() below for why coord-share-lib's globToRegExp is NOT used despite looking like
// the closer fit.
import { escapeRegex } from './build-index-lib.mjs';
import { gitIsolatedEnv } from './child-env.mjs';

// Default `root` for globMatches/gitIgnoredSet below, matching the pre-extraction behaviour in
// lint-pipeline-doc.mjs (both callers there, and this module's own tests, call these with a
// caller-supplied root; this default only matters for a caller that omits it).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Trim quoting/prose punctuation a path picks up from surrounding text.
 */
export function trimToken(word) {
  return word.replace(/^[('"[]+/, '').replace(/[)'"\],;.]+$/, '');
}

/**
 * Split a backtick span's contents into candidate words. Whitespace is the primary
 * separator, but a comma OUTSIDE a `{a,b}` brace group also separates: two real paths
 * written comma-adjacent (`` `docs/<a>.md,docs/<b>.md` ``) would otherwise fuse into one
 * always-missing token and WARN forever on two files that both exist (review finding,
 * 2026-07-30). Commas INSIDE braces are brace-group syntax and must survive.
 */
export function splitSpanWords(span) {
  const words = [];
  let buf = '';
  let depth = 0;
  for (const ch of span) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    const isSep = /\s/.test(ch) || (ch === ',' && depth === 0);
    if (isSep) {
      if (buf) words.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf) words.push(buf);
  return words;
}

/** Expand `{a,b}` groups into concrete alternatives (single level, left to right). */
export function expandBraces(token) {
  const m = token.match(/\{([^{}]*)\}/);
  if (!m) return [token];
  return m[1]
    .split(',')
    .flatMap((alt) =>
      expandBraces(token.slice(0, m.index) + alt + token.slice(m.index + m[0].length)),
    );
}

/**
 * `*` → `[^/]*`, every other character literal.
 *
 * Deliberately NOT coord-share-lib's `globToRegExp`, which looks like a drop-in and is not:
 * its escape class is `[.+^${}()|[\]\\]`, which omits `?`, so a segment carrying a literal
 * `?` would match with `?` acting as a REGEX QUANTIFIER — silently widening the matcher and
 * letting a genuinely-missing path read as present. `escapeRegex` is the shared one-liner
 * plan 1328 consolidated and its class DOES include `?`, so this stays de-duplicated without
 * the escaping hole.
 */
function segmentMatcher(seg) {
  return new RegExp('^' + seg.split('*').map(escapeRegex).join('[^/]*') + '$');
}

/** Does `pattern` (possibly containing `*`) match at least one path under `root`? */
export function globMatches(pattern, root = REPO_ROOT) {
  const wantsDir = pattern.endsWith('/');
  const segs = pattern.replace(/\/$/, '').split('/');

  const walk = (dir, i) => {
    if (i === segs.length) {
      if (!existsSync(dir)) return false;
      return wantsDir ? statSync(dir).isDirectory() : true;
    }
    const seg = segs[i];
    if (!seg.includes('*')) return walk(join(dir, seg), i + 1);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }
    const re = segmentMatcher(seg);
    return entries.some((e) => re.test(e) && walk(join(dir, e), i + 1));
  };

  return walk(root, 0);
}

/**
 * Paths the tree deliberately does not track — transient by design, so never a finding.
 *
 * Returns `{ ignored, gitAvailable }` instead of logging: the git-unavailable fact is
 * REPORTED UP rather than printed from library depth, so a caller can state it once per RUN
 * (a once-per-PROCESS flag would hide the cause for every document after the first) and a
 * test can assert it through the same seam as everything else. It deliberately stays OUT of
 * a caller's findings array — findings drive `--check`'s exit 1, and an unavailable gitignore
 * must fail OPEN: it is a caveat on the run, not a defect in the document.
 */
export function gitIgnoredSet(paths, root = REPO_ROOT) {
  if (!paths.length) return { ignored: new Set(), gitAvailable: true };
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: root,
      input: paths.join('\n'),
      encoding: 'utf8',
      // A local, network-free read (checking paths against the ignore rules of the repo at
      // `root`) — the blanket strip is correct here (scripts/coord/child-env.mjs
      // gitIsolatedEnv()): an ambient GIT_DIR/GIT_WORK_TREE could otherwise redirect this call
      // away from `root` (e.g. when this lib runs from inside a git hook subprocess).
      env: gitIsolatedEnv(),
    });
    return { ignored: new Set(out.split('\n').filter(Boolean)), gitAvailable: true };
  } catch (err) {
    // exit 1 = "no input path is ignored" — git's normal answer, not an error.
    // Anything else means git could not answer (not a repo, git missing, a broken index).
    return { ignored: new Set(), gitAvailable: !!err && err.status === 1 };
  }
}
