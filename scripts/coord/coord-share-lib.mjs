// scripts/coord/coord-share-lib.mjs — PURE logic for the coord-sharing model (plan 893).
//
// THE PROBLEM: vetapp (canonical) and tandapp (sibling) each carry their OWN copy of
// the coordination machinery (board/claim-plan/done-worktree/index/lint-*/...). Every
// coord improvement was hand-ported between repos and they drift (as of 2026-06-20
// tandapp lagged vetapp on 40 of 53 overlapping scripts). This module + the two CLIs
// (sync-coord-to-siblings.mjs, assert-coord-in-sync.mjs) make a coord change land ONCE:
// edit canonical → `sync` propagates → `assert` fails the push if a sibling drifts.
//
// THE "TOLERATE SUBSET" MODEL (operator decision 2026-06-20, session 858): a sibling
// does NOT have to adopt the whole canonical set at once. Each sibling declares an
// explicit `adopt` allowlist — the subset it keeps byte-identical to canonical. The
// drift GATE enforces only the adopted files; un-adopted canonical files are reported
// as a visible migration backlog, never a hard failure. tandapp can therefore stay on
// its pre-857 subset (no landing-queue / handoff-sessions split / worktree-guard) and
// still pass, while the files it HAS adopted are locked against silent drift. The
// adopted set grows file-by-file (dependency-ordered) as the sibling modernises.
//
// PURE CORE + a thin IO section at the bottom (same split as coord-config.mjs's pure
// normalizeConfig + IO loadCoordConfig): the classification/selection logic is pure
// and unit-tested with plain data; the IO helpers (config load, dir listing, file
// reads, git repo-root resolution) are shared by the two CLIs and exercised by them.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitRepoIsolatedEnv } from './child-env.mjs';
import { stripJsCommentsAndStrings } from './write-lint-common.mjs';

/** Pure: a minimal glob → RegExp. Only `*` is special — it matches any run of
 *  NON-slash chars (segment-scoped, standard glob semantics), so `*.mjs` matches a
 *  top-level basename but NOT a nested `test-helpers/foo.mjs`, and `test-helpers/*.mjs`
 *  matches only that subdirectory. Every other character (the literal `/` in a nested
 *  pattern included) is matched literally. Enough for `*.mjs`, `subdir/*.mjs`, and exact
 *  basenames — the canonical-set include/exclude vocabulary. */
export function globToRegExp(pattern) {
  const esc = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex metachars (NOT '*')
    .replace(/\*/g, '[^/]*'); // then expand the glob star — does NOT cross a '/'
  return new RegExp(`^${esc}$`);
}

/** Pure: does `name` match ANY of the glob patterns? */
export function matchesAny(name, patterns) {
  return (patterns || []).some((p) => globToRegExp(p).test(name));
}

/** Pure: the canonical coord-file set from a listing of candidate names. Candidates may
 *  be bare top-level basenames OR posix relative paths for declared subdirs (e.g.
 *  `test-helpers/isolated-plan-repo.mjs`); the include globs decide which are canonical.
 *  include defaults to ['*.mjs']; exclude removes project-specific / canonical-only
 *  scripts (the data pipeline, statusline, the sharing tooling itself). Sorted, deduped. */
export function selectCanonical(names, { include = ['*.mjs'], exclude = [] } = {}) {
  const picked = (names || []).filter((b) => matchesAny(b, include) && !matchesAny(b, exclude));
  return [...new Set(picked)].sort();
}

/** Pure: the canonical files a sibling has NOT adopted — its migration backlog. THE one
 *  definition of "unadopted": classifySibling's bucket and sync-coord-to-siblings' --list
 *  summary both call this, so a --list count can never disagree with what --apply/--report
 *  classify for the same sibling. Set-difference, never a length subtraction: an adopt
 *  entry outside the canonical set (a badAdopt misconfig) would skew a subtraction, even
 *  negative. Sorted. */
export function unadoptedFiles(canonicalFiles, adopt) {
  const adoptSet = new Set(adopt || []);
  return (canonicalFiles || []).filter((f) => !adoptSet.has(f)).sort();
}

/**
 * Pure: classify ONE sibling's adopted files against the canonical CONTENT.
 *   canonicalFiles: string[]                 — the canonical set (selectCanonical output)
 *   adopt:          string[]                 — the subset this sibling opted into
 *   canon:          Record<basename,content> — canonical file contents (≥ adopt ∪ canonicalFiles)
 *   sib:            Record<basename,content>  — sibling file contents (missing key ⇒ absent)
 * Returns disjoint buckets:
 *   inSync     — adopted, present in sibling, byte-equal to canonical
 *   drift      — adopted, present, DIFFERS  (gate FAILS; sync would overwrite)
 *   missing    — adopted, ABSENT in sibling (gate FAILS; sync would create)
 *   badAdopt   — adopted but NOT in the canonical set (config error; gate FAILS)
 *   unadopted  — canonical files the sibling has NOT adopted (backlog; report only)
 */
export function classifySibling({ canonicalFiles, adopt, canon, sib }) {
  const canonSet = new Set(canonicalFiles || []);
  const inSync = [];
  const drift = [];
  const missing = [];
  const badAdopt = [];
  for (const f of adopt || []) {
    if (!canonSet.has(f)) {
      badAdopt.push(f);
      continue;
    }
    if (!(f in sib) || sib[f] === undefined) {
      missing.push(f);
      continue;
    }
    if (canon[f] === sib[f]) inSync.push(f);
    else drift.push(f);
  }
  return {
    inSync: inSync.sort(),
    drift: drift.sort(),
    missing: missing.sort(),
    badAdopt: badAdopt.sort(),
    unadopted: unadoptedFiles(canonicalFiles, adopt),
  };
}

/** Pure: is this sibling classification a drift-gate FAILURE?
 *  Fails on any drifted, missing, or mis-configured (badAdopt) adopted file. */
export function isFailure(classification) {
  return (
    classification.drift.length > 0 ||
    classification.missing.length > 0 ||
    classification.badAdopt.length > 0
  );
}

/** Pure: the list of basenames `sync` would WRITE into the sibling (drift + missing
 *  among the adopted set). inSync files are skipped; unadopted files are never synced. */
export function filesToWrite(classification) {
  return [...classification.drift, ...classification.missing].sort();
}

/** Pure: normalize + validate a raw `coordShare` config block. Throws on a malformed
 *  shape so a typo fails loudly at the CLI rather than silently syncing nothing. */
export function normalizeCoordShare(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object') throw new Error('coordShare: must be an object');
  const dir = raw.dir || 'scripts';
  const include = raw.include || ['*.mjs'];
  const exclude = raw.exclude || [];
  const siblings = (raw.siblings || []).map((s, i) => {
    if (!s || !s.name) throw new Error(`coordShare.siblings[${i}]: missing "name"`);
    if (!s.path) throw new Error(`coordShare.siblings[${s.name}]: missing "path"`);
    return {
      name: s.name,
      path: s.path,
      dir: s.dir || dir,
      adopt: [...new Set(s.adopt || [])].sort(),
    };
  });
  return { role: raw.role || 'canonical', dir, include, exclude, siblings };
}

/** Pure: the local-import TARGETS a source file's text references — every
 *  `from '<relative-spec>'`, bare `import '<relative-spec>'`, and dynamic
 *  `import('<relative-spec>')` whose specifier starts with `.` (relative, i.e. a
 *  same-repo file, never a bare package specifier). Each spec is resolved against the
 *  importing file's own directory (`fromRel`, a `dir`-relative posix path) and returned
 *  as a `dir`-relative posix path — so a NESTED adopted file (plan 2062:
 *  `test-helpers/isolated-plan-repo.mjs`) whose dependency is itself nested is
 *  attributable by its true `<dir>/<rel>` path, matching how the gate's `changedSet`
 *  entries are built. Best-effort static scan, not a real module resolver, but every
 *  relative import a coord script makes resolves inside the coord `dir` in practice,
 *  so this is precise enough for a blocking decision without embedding a resolver in a
 *  pre-push gate. Lived in assert-coord-in-sync.mjs until plan 2160 hoisted it here so
 *  adoptClosureGaps (below) and the gate share the ONE scanner (the gate re-exports it). */
export function extractLocalImportTargets(source, fromRel = '') {
  const fromDir = posix.dirname(fromRel); // '' → '.', so a top-level importer needs no fallback
  const targets = new Set();
  const src = String(source ?? '');
  // COMMENTS are blanked before matching (plan 2697), using the shared tokenizer in the same
  // `blankStrings: false` mode assert-scripts-self-contained.mjs uses, so specifiers stay
  // readable. A commented-out import — `// import x from './gone.mjs'` in a doc comment — is not
  // a dependency, and treating it as one made adoptClosureGaps report a closure gap for a file
  // nobody imports. Blanking comments cannot lose a real import (code never lives in a comment),
  // so this direction is free.
  //
  // DELIBERATELY STILL AN OVER-APPROXIMATION. Import-shaped text inside a STRING can still yield
  // a phantom target. A plan-2697 revision tried to filter those too, by testing whether the
  // `import`/`from` KEYWORD survived a strings-blanked pass, and that was a mistake worth not
  // repeating: the tokenizer treats a template literal as one string, so a REAL
  // `${import('./dep.mjs')}` was classified as prose and DROPPED. Losing a real dependency is
  // strictly worse than gaining a phantom one — a missed dependency makes two closures hash equal
  // when they are not, and every caller here is a freshness or completeness check. So the rule is:
  // this scanner may over-report, never under-report, and CALLERS MUST BE ROBUST TO A PHANTOM.
  // (done-worktree's land-spine check is: a target it cannot read is simply recorded and walked
  // past.) Making this exact needs a real JS lexer, which is not worth owning for the decisions
  // these two callers make.
  const code = stripJsCommentsAndStrings(src, { blankStrings: false });
  const re = /\b(?:from\s+|import\s*\(\s*|import\s+)(['"])(\.[^'"]+)\1/g;
  let m;
  while ((m = re.exec(code))) {
    const target = posix.join(fromDir, m[2]); // posix.join normalizes the ../ segments
    if (target) targets.add(target);
  }
  return [...targets];
}

/** Dependency-closure gaps in a sibling's adopt list (plan 2160): adopted `.mjs`
 *  files whose CANONICAL source imports a relative target that is not itself adopted.
 *  The invariant this enforces: **an adopted file must never depend on a non-adopted
 *  one** — such a file is byte-identical yet DEAD ON ARRIVAL in the sibling (the
 *  stamp-exec-model / plan-2160 lint-board incidents). `readSource(rel)` returns the
 *  canonical file's text or null (an absent canonical file is missing/badAdopt's job,
 *  skipped here). `.test.mjs` entries are walked too — a synced test importing an
 *  unmanaged file strands the sibling's pre-push just the same (plan 1323). Returns
 *  [{ file, target }] sorted by file then target; empty array = the closure holds
 *  (verified computationally — the hand-maintained-list era ended with the
 *  operator-ruled 2ba1cd3350 prune this check now locks in). */
export function adoptClosureGaps(adopt, readSource) {
  const adopted = new Set(adopt || []);
  const gaps = [];
  for (const f of [...adopted].sort()) {
    if (!f.endsWith('.mjs')) continue;
    const src = readSource(f);
    if (src == null) continue;
    for (const t of extractLocalImportTargets(src, f).sort()) {
      if (!adopted.has(t)) gaps.push({ file: f, target: t });
    }
  }
  return gaps;
}

// --- IO ----------------------------------------------------------------------

/** IO: read <canonicalRoot>/coord.config.json and return its normalized `coordShare`
 *  block (or null when the file or the block is absent). */
export function loadCoordShareConfig(canonicalRoot) {
  const p = join(canonicalRoot, 'coord.config.json');
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return normalizeCoordShare(raw.coordShare);
}

/** IO: the canonical coord-file set actually present under `absDir`, as bare basenames
 *  for the root plus posix relative paths for any DECLARED subdirectory. An include glob
 *  may name a subdir (`test-helpers/*.mjs`); we scan the root plus each distinct directory
 *  prefix an include pattern references — bounded to exactly the declared dirs, never a
 *  blind recursion — and build relative-path candidates that selectCanonical then filters.
 *  So a nested coord file becomes canonical only once an include pattern opts its dir in
 *  (a new subdir file is invisible until then), and it is keyed by its relative path, never
 *  a bare basename that could collide with a top-level one. */
export function listCanonical(absDir, { include = ['*.mjs'], exclude } = {}) {
  const relDirs = new Set(['']); // '' = the root itself, always scanned
  for (const pat of include) {
    const i = pat.lastIndexOf('/');
    if (i !== -1) relDirs.add(pat.slice(0, i));
  }
  const names = [];
  for (const rel of relDirs) {
    const d = rel ? join(absDir, rel) : absDir;
    if (!existsSync(d)) continue;
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      // Keep entries that are REGULAR FILES after following symlinks. Dirent's own
      // isFile()/isDirectory() never follow, so neither predicate alone is right: a bare
      // isFile() drops a symlinked coord script the pre-2062 flat readdir kept, while a
      // bare !isDirectory() lets a symlink-to-DIRECTORY through (Dirent.isDirectory() is
      // false for any symlink), which later blows up as EISDIR on read. statSync follows,
      // so symlink-to-file is in, symlink-to-dir / real dir / broken symlink are out.
      const st = statSync(join(d, ent.name), { throwIfNoEntry: false });
      if (st?.isFile()) names.push(rel ? `${rel}/${ent.name}` : ent.name);
    }
  }
  return selectCanonical(names, { include, exclude });
}

/** IO: read the contents of `basenames` under `absDir`; absent files are simply
 *  omitted from the returned map (so classifySibling sees them as missing). */
export function readFiles(absDir, basenames) {
  const out = {};
  for (const b of basenames) {
    const p = join(absDir, b);
    if (existsSync(p)) out[b] = readFileSync(p, 'utf8');
  }
  return out;
}

/** IO: the CURRENT checkout's repo root (worktree-aware) — the canonical source whose
 *  scripts/ we propagate. During a worktree-branch push this is the worktree (the NEW
 *  files); in the main checkout / CI it is the repo root. */
export function canonicalRepoRoot() {
  // plan 4096: an ambient GIT_DIR/GIT_WORK_TREE could otherwise redirect this cwd-scoped
  // read at a different repo than the one this process is actually sitting in (see
  // scripts/coord/child-env.mjs gitRepoIsolatedEnv()). Local, network-free read.
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    env: gitRepoIsolatedEnv(),
  }).trim();
}

/** IO: the MAIN worktree root (first `git worktree list` entry). Sibling paths are
 *  resolved against THIS, not the cwd — a sibling `../tandapp` must point at the real
 *  sibling repo even when the gate runs from a nested `.claude/worktrees/<slug>/`
 *  worktree (where a cwd-relative `../tandapp` would resolve inside the worktree tree).
 *  Read-only: unlike coord-git's resolveMain() it does NOT assert master. */
export function mainRepoRoot() {
  // plan 4096: same ambient-GIT_DIR hazard as canonicalRepoRoot() above.
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    env: gitRepoIsolatedEnv(),
  });
  const first = out.split('\n').find((l) => l.startsWith('worktree '));
  if (!first) throw new Error('coord-share: cannot resolve main worktree root');
  return first.slice('worktree '.length).trim();
}

/** IO: gather everything needed to classify ONE sibling against canonical.
 *  Returns { name, dir, root, present, classification } — classification is null only
 *  when the sibling REPO ROOT is absent on disk (a fresh clone / CI checkout without
 *  the umbrella sibling — the caller skips it, never fails). NOTE the skip keys on the
 *  repo ROOT, not on `<root>/<dir>`: a present repo whose coord dir is missing or
 *  renamed must NOT skip — readFiles then yields nothing, every adopted file lands in
 *  `missing`, and the gate FAILS (a mis-pointed `dir` is a real problem, not a pass). */
export function gatherSibling({ canonicalDir, canonicalFiles, mainRoot, sibling }) {
  const root = resolve(mainRoot, sibling.path);
  const siblingDir = join(root, sibling.dir);
  if (!existsSync(root))
    return { name: sibling.name, dir: siblingDir, root, present: false, classification: null };
  const canon = readFiles(canonicalDir, [...new Set([...canonicalFiles, ...sibling.adopt])]);
  const sib = readFiles(siblingDir, sibling.adopt);
  const classification = classifySibling({ canonicalFiles, adopt: sibling.adopt, canon, sib });
  // `canon` rides along so closureGapsForSibling can reuse the already-read sources
  // instead of a second per-file disk pass (plan 2160 review [6]).
  return { name: sibling.name, dir: siblingDir, root, present: true, classification, canon };
}

/** IO: closure gaps for ONE sibling against the canonical sources — the shared entry
 *  point both CLIs use (plan 2160 review [5]: the readSource closure and the gap
 *  message must not live as two hand-synced copies). `canon` may carry gatherSibling's
 *  already-read contents; anything absent from it is read from disk once, and a read
 *  failure degrades to null (adoptClosureGaps skips it — missing/badAdopt's job). */
export function closureGapsForSibling({ canonicalDir, sibling, canon = {} }) {
  return adoptClosureGaps(sibling.adopt, (rel) => {
    if (rel in canon) return canon[rel];
    try {
      return readFileSync(join(canonicalDir, rel), 'utf8');
    } catch {
      return null;
    }
  });
}

/** Pure: the ONE human-readable closure-gap line (both CLIs print it verbatim). */
export function formatClosureGap(gap) {
  return `${gap.file} → ${gap.target} — adopt the target (dependency-ordered, coord-sharing.md) or prune the importer from the adopt list`;
}
