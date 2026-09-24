#!/usr/bin/env node
// scripts/lint-coord-lockctx.mjs  (plan 2435 item 3)
//
// Enforce the plan-2393 lever-1 forwarding invariant:
//
//   A withCoordCheckout callback that TAKES the coord lock handle may not mutate the
//   coord-checkout after its coordWrite(…) call.
//
// coordWrite hands the coord lock back after its commit, so everything the callback does
// AFTER it runs unserialized against a shared checkout a sibling may already be resetting
// (`resolveCoordCheckout` does `reset --hard` + `clean -fd` on it). Until this lint the rule
// was enforced by nothing but an inline comment at each of the four wired call sites plus a
// paragraph in docs/runbooks/branch-hygiene.md § The coord-write critical section — so a future
// caller that forwards the handle and then keeps touching the tree got NO signal at all, which is
// the exact class lever 1 was careful to avoid. Cheapest of the three mechanisms the plan weighed
// (vs a runtime "spent ctx" tripwire, or a sentinel coordWrite return): static, zero runtime cost,
// and it fires at the moment the mistake is written.
//
// WIRED as its own `.husky/pre-push` step beside the rest of the lint-*.mjs family — NOT left to
// the scripts/*.test.mjs battery, which is import-closure SELECTED: a violation introduced in a
// caller like board.mjs would never pull lint-coord-lockctx.test.mjs into the selection. ~100 ms
// over all of scripts/, no git range, so it can run unconditionally.
//
// DETECTION — deliberately FAIL-CLOSED (review 2026-07-26, findings 2 + 4). The first cut keyed on
// the callback TEXTUALLY forwarding its second parameter into coordWrite (`lockCtx,` or
// `lockCtx: <param>`), which two independent reviewers defeated in one line each: an alias
// (`const ctx = lockCtx; coordWrite(…, { lockCtx: ctx })`) and a non-arrow callback shape
// (`function (cdir, lockCtx) {…}`) both slipped through as "unwired" and took their post-coordWrite
// mutation with them. So the trigger is now the weaker, safer predicate:
//
//   a callback (arrow OR function expression) that DECLARES a second parameter,
//   whose body calls coordWrite(…), and which mentions that parameter anywhere.
//
// `withCoordCheckout` passes the handle as arg 2 and nothing else, so DECLARING a second parameter
// IS the opt-in — no need to track it through aliases. This over-approximates: a callback that
// takes the handle, does NOT forward it, and then mutates would be flagged. That direction is
// correct — if you took the handle you are reasoning about the lock, and a mutation after
// coordWrite in such a callback is worth a human look. Under-approximating is what lets the race
// back in.
//
// Comments and string literals are blanked by the SHARED house tokenizer
// (write-lint-common.mjs → stripJsCommentsAndStrings, also used by scroll-lock-write-lint.mjs)
// rather than a second hand-rolled one (review finding 8, and the 9/10 rule): it is
// length-preserving so offsets and line numbers stay exact, and it terminates '…'/"…" at a newline
// the way the engine's own error recovery does — which is precisely the runaway-to-EOF bug the
// hand-rolled version shipped with. Its documented limitation is that it does NOT tokenize regex
// literals. For THIS lint that limitation is safe-direction: an untokenized regex containing a
// denylisted name can only produce a FALSE POSITIVE — a loud, investigable gate failure — never the
// silent false-negative a blocking correctness gate must not have.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripJsCommentsAndStrings } from './coord/write-lint-common.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Tree-mutating seams, as regex source fragments. fs writers, every git-invoking helper (a `git()`
// call can be a `commit`, `reset`, `clean`…, and distinguishing verb-by-verb would be a parser's
// job, so ANY git call after coordWrite is the violation), and the coord/land helpers that mutate a
// checkout themselves. Entries are FRAGMENTS, not literals, so a family can be covered in one line
// — `atomicWrite\w*` exists because the first cut listed a bare `atomicWrite`, which matches
// nothing: the real exports are atomicWriteTextSync / atomicWriteJsonSync (review finding 3).
export const MUTATING_CALLS = [
  // node:fs write surface
  'writeFileSync',
  'appendFileSync',
  'rmSync',
  'rmdirSync',
  'unlinkSync',
  'mkdirSync',
  'renameSync',
  'copyFileSync',
  'cpSync',
  'truncateSync',
  'ftruncateSync',
  'chmodSync',
  'chownSync',
  'utimesSync',
  'symlinkSync',
  'linkSync',
  'openSync',
  'writeSync',
  'createWriteStream',
  'atomicWrite\\w*',
  // git / subprocess seams
  'git',
  'gitRaw',
  'gitWithLockRetry',
  'execFileSync',
  'execSync',
  'spawnSync',
  // coord helpers that mutate the checkout
  'coordWrite',
  'resolveCoordCheckout',
  'revertPathsToHead',
  'gitMoveCommit',
  'ensureMvDestDir',
  'deleteStaleArchiveDups',
  'makePushFn',
];

// Index just past the matching close of the bracket at `open` (which must be one of `{([`).
// Runs on ALREADY-BLANKED code, so a bracket inside a comment or string can never desynchronize it.
function matchBracket(code, open) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const close = pairs[code[open]];
  if (!close) return -1;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === code[open]) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const lineOf = (code, idx) => code.slice(0, idx).split('\n').length;

// Split a parameter list's source into top-level parameter texts.
function splitParams(raw) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of raw) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// Callback headers that can receive withCoordCheckout's (dir, lockCtx) pair: an arrow with a
// parenthesised parameter list, or a function expression/declaration. Both are matched on the
// blanked source, and the capture is the raw parameter text.
const CALLBACK_HEADERS = [
  /\(([^()]*)\)\s*=>\s*\{/g, // (a, b) => {
  /function\s*(?:[A-Za-z_$][\w$]*)?\s*\(([^()]*)\)\s*\{/g, // function name?(a, b) {
];

// Every callback that DECLARES a second parameter and calls coordWrite in its body, paired with the
// span that follows each such coordWrite call inside that body.
export function findWiredSites(rawSrc) {
  const code = stripJsCommentsAndStrings(rawSrc);
  const sites = [];
  // Only functions passed as an ARGUMENT to withCoordCheckout can receive the lock handle — it is
  // the sole thing that hands one out. Scoping to those argument spans is what keeps the
  // fail-closed "declares a second parameter" trigger from also matching an ordinary enclosing
  // function that happens to take two params and call a coord tool (which would attribute code
  // after the whole withCoordCheckout(…) call as "after coordWrite").
  const spans = [];
  const WCC = /\bwithCoordCheckout\s*\(/g;
  let w;
  while ((w = WCC.exec(code))) {
    const open = w.index + w[0].length - 1;
    const close = matchBracket(code, open);
    if (close !== -1) spans.push([open, close]);
  }
  if (!spans.length) return { code, sites };
  const inSpan = (i) => spans.some(([a, b]) => i > a && i < b);
  for (const rx of CALLBACK_HEADERS) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(code))) {
      if (!inSpan(m.index)) continue;
      const params = splitParams(m[1]);
      if (params.length < 2) continue; // never received a lock handle
      const handle = /^[A-Za-z_$][\w$]*$/.test(params[1]) ? params[1] : null;
      const bodyStart = code.indexOf('{', m.index + m[0].length - 1);
      const bodyEnd = matchBracket(code, bodyStart);
      if (bodyStart === -1 || bodyEnd === -1) continue;
      const body = code.slice(bodyStart, bodyEnd);
      // Fail-closed: an unparseable second param (destructured/defaulted) counts as "took the
      // handle" rather than being skipped.
      if (handle && !new RegExp(`\\b${handle}\\b`).test(body)) continue;
      const CW = /\bcoordWrite\s*\(/g;
      let cw;
      while ((cw = CW.exec(body))) {
        const openParen = bodyStart + cw.index + cw[0].length - 1;
        const closeParen = matchBracket(code, openParen);
        if (closeParen === -1) continue;
        sites.push({
          handle,
          coordWriteLine: lineOf(rawSrc, openParen),
          tailStart: closeParen,
          tailEnd: bodyEnd - 1,
        });
      }
    }
  }
  return { code, sites };
}

// Violations: a tree-mutating call appearing after a coordWrite, inside the same handle-taking callback.
export function findLockCtxViolations(rawSrc) {
  const { code, sites } = findWiredSites(rawSrc);
  const rx = new RegExp(`\\b(${MUTATING_CALLS.join('|')})\\s*\\(`, 'g');
  const violations = [];
  const seen = new Set();
  for (const s of sites) {
    const tail = code.slice(s.tailStart, s.tailEnd);
    rx.lastIndex = 0;
    let v;
    while ((v = rx.exec(tail))) {
      const abs = s.tailStart + v.index;
      const line = lineOf(rawSrc, abs);
      // The two header patterns can both match one callback (and nested callbacks overlap), so the
      // same offence can be reached twice — report each distinct location once.
      const key = `${line}:${v[1]}:${abs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({
        callee: v[1],
        line,
        coordWriteLine: s.coordWriteLine,
        snippet: rawSrc.split('\n')[line - 1]?.trim().slice(0, 120) || '',
      });
    }
  }
  return violations.sort((a, b) => a.line - b.line);
}

// TRACKED scripts only (`git ls-files`), matching the lint-*.mjs family convention: an untracked
// scratch .mjs a sibling session happens to have left in scripts/ must never gate someone's push.
export function trackedScripts() {
  const out = execFileSync('git', ['ls-files', 'scripts/*.mjs'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((rel) => !rel.endsWith('.test.mjs'))
    .map((rel) => ({ path: rel, content: readFileSync(join(REPO_ROOT, rel), 'utf8') }));
}

export function main(argv = process.argv.slice(2)) {
  let entries;
  try {
    entries = argv.length
      ? argv.map((p) => ({ path: p, content: readFileSync(p, 'utf8') }))
      : trackedScripts();
  } catch (e) {
    console.error(`lint-coord-lockctx: cannot read the scripts tree: ${e.message}`);
    return 2; // tool error, distinct from a drift failure
  }
  const offenders = [];
  for (const { path, content } of entries) {
    if (!content.includes('coordWrite')) continue; // cheap pre-filter
    for (const v of findLockCtxViolations(content)) offenders.push({ file: basename(path), ...v });
  }
  if (offenders.length) {
    console.error(
      `lint-coord-lockctx: ${offenders.length} lockCtx violation(s) — a callback that TAKES the coord\n` +
        `lock handle mutates the coord-checkout again AFTER its coordWrite:\n` +
        offenders
          .map(
            (o) =>
              `  ${o.file}:${o.line}  ${o.callee}(…) runs after the coordWrite at line ${o.coordWriteLine}\n` +
              `      ${o.snippet}`,
          )
          .join('\n') +
        `\n\ncoordWrite hands the coord lock BACK after its commit (plan 2393 lever 1), so anything the\n` +
        `callback does afterwards is unserialized against a checkout a sibling may already be resetting\n` +
        `(resolveCoordCheckout does \`reset --hard\` + \`clean -fd\` on it).\n` +
        `Fix EITHER by moving the mutation BEFORE the coordWrite call, or by not taking the lock handle\n` +
        `in this callback at all (a one-arg callback keeps the whole-op hold — correct, just slower).\n` +
        `Rationale: docs/runbooks/branch-hygiene.md § The coord-write critical section ends at the COMMIT.\n` +
        `  Emergency escape: git push --no-verify (but fix the violation first).`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main());
