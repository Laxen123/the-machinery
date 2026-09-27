#!/usr/bin/env node
// scripts/apply-workflow-file.mjs — the sanctioned route for an unattended cloud drain to
// edit a repo-tracked file under `.claude/workflows/**` (plan 2965, operator ruling
// 2026-08-08 during plan 2957's grilling: "I think allow it").
//
// WHY THIS EXISTS. Every raw `Edit`/`Write` under `.claude/**` raises a `safetyCheck`
// permission ask in the cloud that nobody is there to approve — two drains froze 109 and
// 225 minutes on exactly that (2026-07-20, plans 2096 and 2071+2099; the anatomy is
// recorded in this project's own incident history). The classifier flags the TOOL CALL on the
// path, not the underlying file op: a write issued through a Bash coord tool
// (`edit-plan.mjs`, `move-plan.mjs`, `board.mjs`) is never flagged (plan 2055 fallback,
// same runbook). This script is that mechanism for `.claude/workflows/**` — and ONLY that
// subtree; the operator's ruling was scoped there (review-quality blast radius), never to
// `.claude/settings*.json` or `.claude/commands/**` (session-control blast radius stays
// hard-forbidden to unattended sessions). Hook logic itself moved out of `.claude/`
// entirely (plan 3765, to `scripts/hooks/**`), so it is no longer a `.claude/` subtree
// this exclusion needs to name.
//
// Contract: `node scripts/apply-workflow-file.mjs --target .claude/workflows/<file> --from
// <scratch file>`. The worker authors the FULL new file content in `.scratch/` with its
// normal tools (an unflagged path), and this script:
//   (a) resolves `--target` and REFUSES anything outside `<repo>/.claude/workflows/` —
//       traversal-safe, symlink-safe (containment is anchored on the realpath of the
//       PARENT dir, since a creation target legitimately does not exist yet);
//   (b) for `.js`/`.mjs` targets, runs `node --check` on the STAGED content and refuses a
//       syntax-broken write (other extensions copy without the check);
//   (c) copies the full content in (full-file-from-scratch, NOT patch application — patch
//       fragility is the failure mode the coord tools already rejected) and prints one
//       audit line (target, byte count, content sha256).
//
// Per docs/coord/scripts-layout.md this module imports only from within
// `scripts/` and node builtins — the isolated-plan-repo test scaffold runs COPIES of the
// `scripts/` tree, so an escaping import would die there.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './coord/parse-flags.mjs';
import { atomicWriteTextSync } from './coord/atomic-write.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

/** Realpath that tolerates a path whose tail does not exist yet (a creation target): walks
 *  up from `absPath` until it finds the longest EXISTING ancestor, realpath's that ancestor
 *  (collapsing any symlink in it), then re-joins the non-existent tail LITERALLY (a
 *  non-existent path segment cannot itself be a symlink). This is what lets the containment
 *  check below say yes to "create a brand-new file under workflows/" while still catching a
 *  symlinked ancestor DIRECTORY that escapes the sandbox. */
function tolerantRealpath(absPath) {
  let current = absPath;
  const tail = [];
  for (;;) {
    try {
      const real = (realpathSync.native || realpathSync)(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      const parent = dirname(current);
      if (parent === current) throw err; // hit the filesystem root and still nothing resolves
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** Pure: is `childReal` strictly inside `parentReal` (both already realpath'd)? Equal paths
 *  are NOT contained — the workflows dir itself is never a valid file target. */
function isWithin(childReal, parentReal) {
  if (childReal === parentReal) return false;
  const rel = relative(parentReal, childReal);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** Resolve `target` (repo-relative or absolute) and refuse anything that is not a plain file
 *  strictly inside `<repoRoot>/.claude/workflows/` — the whole point of the sanctioned route.
 *  Returns the resolved absolute path on success; throws on any containment failure. */
export function assertTargetContained({ target, repoRoot = REPO_ROOT } = {}) {
  if (!target || !String(target).trim()) {
    throw new Error('apply-workflow-file: --target <path under .claude/workflows/> is required');
  }
  const workflowsDir = join(repoRoot, '.claude', 'workflows');
  if (!existsSync(workflowsDir)) {
    throw new Error(`apply-workflow-file: workflows dir does not exist: ${workflowsDir}`);
  }
  // The containment ANCHOR must itself be inside the repo. Anchoring only on
  // `realpath(.claude/workflows)` would make a symlinked workflows ROOT self-authorising: if
  // `.claude/workflows` pointed at /elsewhere, every target under it would resolve inside
  // /elsewhere and pass `isWithin`, so the route would happily write outside the checkout
  // while its audit line still printed a repo-relative path (gpt-review 89a62a + 70a48d,
  // two independent angles). Verify the anchor against the repo root before trusting it.
  const repoRootReal = tolerantRealpath(repoRoot);
  const workflowsDirReal = tolerantRealpath(workflowsDir);
  if (!isWithin(workflowsDirReal, repoRootReal)) {
    throw new Error(
      `apply-workflow-file: refusing — the ".claude/workflows" anchor resolves to ` +
        `"${workflowsDirReal}", which is outside the repo root (${repoRootReal}). A symlinked ` +
        'workflows root would let every target escape the checkout, so the anchor itself is checked.',
    );
  }
  const targetAbs = resolve(repoRoot, target);

  // Defense in depth: an EXISTING target that is itself a symlink is refused outright — the
  // sanctioned route writes plain file content in place, never through a redirect. (The
  // ancestor-symlink case — a symlinked DIRECTORY somewhere in the target's path — is caught
  // below by the tolerant-realpath containment check on the parent.)
  let lst = null;
  try {
    lst = lstatSync(targetAbs);
  } catch {
    /* target does not exist yet — the common "create a new file" case, handled below */
  }
  if (lst?.isSymbolicLink()) {
    throw new Error(
      `apply-workflow-file: refusing — target "${target}" is a symlink; the apply script only ` +
        'writes plain files under .claude/workflows/, never through a redirect.',
    );
  }

  const parentReal = tolerantRealpath(dirname(targetAbs));
  const candidateReal = join(parentReal, basename(targetAbs));
  if (!isWithin(candidateReal, workflowsDirReal)) {
    throw new Error(
      `apply-workflow-file: refusing — target "${target}" resolves to "${candidateReal}", which ` +
        `is outside the sanctioned ".claude/workflows/" subtree (${workflowsDirReal}). Traversal ` +
        'and symlink-escape targets are refused by design (plan 2965, operator ruling 2026-08-08).',
    );
  }
  return targetAbs;
}

/** Run `node --check` against `content` AS the extension it will land under (`.js`/`.mjs`
 *  matters — Node's module-type detection differs), via a real temp file rather than stdin
 *  so detection matches how the file would actually load. Throws on a syntax error; returns
 *  silently on success.
 *
 *  TWO PASSES, because a workflow script is NOT a plain module. The Workflow runtime executes
 *  the script BODY inside an async function ("the script body runs in an async context"), so a
 *  top-level `return` — the standard early-exit in these files — is legal there and illegal to
 *  a bare `node --check`. Measured: two of this project's own workflow files early-return at
 *  their own top level, so a one-pass gate refuses 2 of the 3
 *  real workflow files and the sanctioned route cannot update them at all (gpt-review c8e951).
 *  Pass 1 checks the content as written (this is what `sonnet-review.js` needs — it uses
 *  top-level `export`, which is legal in a module and illegal inside a function wrapper, so the
 *  two shapes are mutually exclusive and cannot share one pass). ONLY when pass 1 fails
 *  specifically on an illegal top-level return does pass 2 re-check it wrapped in an async
 *  function, mirroring how the runtime actually evaluates it. Every other syntax error still
 *  refuses, and the reported detail comes from whichever pass is diagnostic. */
function assertSyntaxOk(content, { target, ext }) {
  const dir = mkdtempSync(join(tmpdir(), 'apply-workflow-file-'));
  const refuse = (detail) =>
    new Error(
      `apply-workflow-file: refusing — staged content for "${target}" fails \`node --check\`:\n${detail}`,
    );
  const check = (src, name) => {
    const checkPath = join(dir, `${name}${ext}`);
    writeFileSync(checkPath, src);
    execFileSync(process.execPath, ['--check', checkPath], { stdio: 'pipe' });
  };
  try {
    try {
      check(content, 'staged');
      return;
    } catch (err) {
      const detail = err.stderr ? err.stderr.toString() : err.message;
      // Two pass-1 failures earn the runtime-shaped re-check. The obvious one is the top-level
      // return. The second is module DETECTION: the staged copy is checked in a temp dir with no
      // ancestor `package.json`, and this repo's root sets no `"type"`, so whether a `.js`
      // workflow parses as ESM rests on Node's automatic module-syntax detection rather than on
      // anything we control. It does detect today (Node 22.22 — `sonnet-review.js`, a `.js` file
      // opening with `export const meta`, round-trips clean), but a runtime that did not would
      // report `Unexpected token 'export'` and, with a return-only trigger, refuse a file that is
      // perfectly valid to the workflow runtime. Accepting both keeps the gate honest across that
      // difference; pass 2 still has to actually parse, so nothing is waved through.
      if (!/Illegal return statement|Unexpected token '?export'?/.test(detail))
        throw refuse(detail);
      // Top-level return → re-check as the runtime sees it: the body inside an async function.
      // The real files carry BOTH shapes at once — every workflow opens with `export const meta`
      // AND early-returns — so a bare wrapper trades "Illegal return" for "Unexpected token
      // 'export'". Drop the top-level `export ` marker (declaration intact) before wrapping.
      // This transform is CHECK-ONLY and never reaches disk: `applyWorkflowFile` always writes
      // the original bytes verbatim, so at worst a lenient transform misses a syntax error — it
      // can never alter what lands.
      // KNOWN LIMITS of this line-based strip, stated rather than papered over: it only matches
      // `export` at column 0, so an INDENTED top-level export is missed (pass 2 then refuses a
      // valid file — visible and recoverable), and a column-0 `export` sitting inside a template
      // literal is stripped too (which only ever RELAXES the check). Both directions are bounded
      // because this is a syntax gate, not the writer: `applyWorkflowFile` emits the original
      // bytes either way, and pass 1 — the real module check — already ran unmodified.
      const wrapped =
        'async function __workflowBody__() {\n' +
        content.replace(
          /^export\s+(?=(?:default\s+|async\s+)?(?:const|let|var|function|class)\b)/gm,
          '',
        ) +
        '\n}';
      try {
        check(wrapped, 'staged-wrapped');
        return;
      } catch (wrappedErr) {
        const wrappedDetail = wrappedErr.stderr ? wrappedErr.stderr.toString() : wrappedErr.message;
        throw refuse(wrappedDetail);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The whole apply: containment → syntax gate (js/mjs only) → full-file write → one audit
 *  line. Throws on any refusal (containment, missing --from, syntax); never partially
 *  writes — the target file is untouched unless every check passes. */
export function applyWorkflowFile({ target, from, repoRoot = REPO_ROOT } = {}) {
  if (!from || !String(from).trim()) {
    throw new Error('apply-workflow-file: --from <scratch file> is required');
  }
  const targetAbs = assertTargetContained({ target, repoRoot });

  const fromAbs = resolve(from);
  if (!existsSync(fromAbs)) {
    throw new Error(`apply-workflow-file: --from file not found: ${fromAbs}`);
  }
  const content = readFileSync(fromAbs, 'utf8');

  const ext = extname(targetAbs);
  if (ext === '.js' || ext === '.mjs') {
    assertSyntaxOk(content, { target, ext });
  }

  mkdirSync(dirname(targetAbs), { recursive: true });
  // Temp-file + fsync + rename, via the repo's existing seam — never a bare truncating write.
  // A `writeFileSync` here opens the tracked workflow with O_TRUNC before the new bytes land,
  // so a kill or disk-full mid-write leaves it empty or torn — and the file it would corrupt is
  // the review workflow the drains depend on (gpt-review 0e4451/0fa774/ce3620/1e1379). The
  // rename also replaces the NAME rather than following it, which closes the check-then-write
  // window on a target swapped to a symlink after validation.
  // A rename-based replace installs the TEMP file's mode, so an existing target's permission
  // bits (the exec bit above all) would silently reset on every apply — git tracks that bit, so
  // the drop would surface later as an unrelated-looking diff. Carry the prior mode across.
  let priorMode = null;
  try {
    priorMode = lstatSync(targetAbs).mode;
  } catch {
    /* creation case — no prior mode to preserve */
  }
  atomicWriteTextSync(targetAbs, content);
  if (priorMode !== null) chmodSync(targetAbs, priorMode & 0o7777);

  const bytes = Buffer.byteLength(content, 'utf8');
  const sha = createHash('sha256').update(content, 'utf8').digest('hex');
  const relTarget = relative(repoRoot, targetAbs).split(sep).join('/');
  const line = `apply-workflow-file: wrote ${relTarget} (${bytes} bytes, sha256:${sha})`;
  console.log(line);
  return { target: targetAbs, relTarget, bytes, sha, line };
}

export function main({ argv = process.argv.slice(2), repoRoot = REPO_ROOT } = {}) {
  let flags;
  try {
    ({ flags } = parseFlags(argv, {
      label: 'apply-workflow-file',
      value: ['target', 'from'],
    }));
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (!flags.target || !flags.from) {
    console.error(
      'apply-workflow-file: usage: node scripts/apply-workflow-file.mjs --target .claude/workflows/<file> --from <scratch file>',
    );
    return 2;
  }
  try {
    applyWorkflowFile({ target: flags.target, from: flags.from, repoRoot });
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

// CLI only (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main({}));
}
