#!/usr/bin/env node
// scripts/coord/assert-no-personal-data.mjs — the coord-kit's own personal-data scrub gate
// (plan 3958).
//
// WHY: coord-kit is a ONE-TIME public snapshot of vetapp's generic coordination machinery
// (plan lanes, claims, worktrees, the landing queue, hooks, skills, docs). The noun map
// (scripts/project/coord-kit-noun-map.json) rewrites the obvious project nouns in the skill
// and slash-command prose it touches, but it is a fixed, hand-maintained list applied to two
// narrow surfaces — it cannot prove the WHOLE tree the build writes is clean, and it says
// nothing about a personal detail that was never a "project noun" in the first place (an
// e-mail address, a home directory path, a machine hostname, a cloud sandbox id). This module
// is that proof: a generic, tree-wide sweep run over the kit's OUTPUT directory (or, via
// coord-init, whatever it adopts into) that catches what the noun map cannot reach and any
// personal detail a hand-written doc or skill body leaked on its own.
//
// SHIP CONSTRAINT (docs/runbooks/scripts-module-layout.md § Rule 3): this module lives under
// scripts/coord/, which the kit ships verbatim, so it may import ONLY node: builtins and
// scripts/coord/** siblings — no bare package specifier, no reach into scripts/ or
// scripts/assert-coord-docs-generic.mjs. The e-mail regex SHAPE below is copied from that
// gate's denylist entry, not imported — see that file's own header for the reasoning.
//
// NO PROJECT-SPECIFIC LITERAL LIVES IN THIS FILE (or its test): coord-kit ships this gate
// verbatim into a public repo, so every project/person name it used to hard-code (a GitHub
// handle, an outreach persona name) has moved to the denylist file passed via --denylist,
// which stays in the private project (scripts/project/personal-data-denylist.json here) and
// never ships. The rules left below are all generic SHAPES, not literals.
//
// WHAT IT SCANS: every text file under --root, skipping `.git`, `node_modules`, and any
// directory named on --exclude. A file is treated as binary (and skipped whole) when its
// first 8 KB contains a NUL byte — the cheap, standard heuristic; this gate has no reason to
// try harder than that for a coordination-doc tree.
//
// WHAT IT FLAGS, one finding `{ file, line, kind, match }` per (line, kind) it fires on:
//   email          — any e-mail address (assert-coord-docs-generic.mjs's regex shape), except
//                    an obviously-fixture address: an RFC 2606 reserved domain (example.com,
//                    example.net, example.org, or any .invalid/.test/.example/.localhost TLD)
//                    or the literal `git@github.com` (the standard GitHub SSH remote user, not
//                    a person).
//   hostname       — a machine hostname shaped like DESKTOP-<6+ alnum>, case-insensitive.
//   home-path      — a `C:\Users\<name>`, `C:/Users/<name>`, `/home/<name>` or `/Users/<name>`
//                    path, for any <name> EXCEPT the literal "user" (cloud sandboxes run as
//                    /home/user, which is generic and not a personal detail) or a name that is
//                    only dots (`...`, a documentation placeholder, not a real leaf).
//   cloud-env-id   — a Claude Code cloud sandbox id, `env_<26 alnum>`.
//   denylist       — a case-insensitive literal-substring hit against a denylist (no default;
//                    pass --denylist <file>, a plain JSON array of strings — JSON has no
//                    comment syntax, so the array is documented at its call site rather than
//                    inline). This is the ONLY project-specific rule left in this module —
//                    every literal project/person name (including the outreach persona name
//                    and the maintainer's GitHub handle) lives in the denylist file that stays
//                    in the private project, never in this shipped gate. A denylist entry can
//                    fire on the SAME line as another kind — that is expected, not a bug: two
//                    different named things leaked, so both are reported (mirrors
//                    assert-coord-docs-generic.mjs's own one-finding-per-term-per-line
//                    contract).
//
// WAIVER: a line containing the literal `personal-data-ok:` suppresses the four BUILT-IN shape
// rules only (email, hostname, home-path, cloud-env-id) — the repo's established
// `// <axis>-ok: <reason>` shape (see `// platform-assert-ok:` in
// scripts/assert-posix-path-assertions.mjs). Used by this module's own shipped test file to mark
// its intentional synthetic fixtures, so this scrub gate can scan itself.
//
// THE WAIVER NEVER SUPPRESSES A DENYLIST HIT. A denylist entry is an exact, hand-picked personal
// string (a real name, handle, or hostname) passed in from the private project — no shipped
// fixture ever legitimately needs to contain one, so there is no legitimate reason for a waiver
// comment to hide one. Before this rule a `personal-data-ok:` comment trailing a real hostname or
// name in a shipped test fixture silently defeated the ONE check built specifically to catch
// exact literals the shape rules can't (findings that motivated this: the real machine hostname
// sat behind three such waivers in shipped test files and the scrub gate reported 0 findings).
//
// CLI: node scripts/coord/assert-no-personal-data.mjs --root <dir> [--denylist <file>]
//      [--json] [--exclude <dirname>...]
// Exit 0 clean, 1 findings, 2 usage/IO error (bad args, --root not a directory, malformed
// denylist file). No --denylist means no denylist check at all — this shipped gate must not
// depend on a file that stays behind in the private project. Human output is one line per
// finding — `<file>:<line>: <kind> "<match>"` — then a count; --json prints
// `{ root, findings, count }`. Findings are sorted (file, then line, then kind, then match) so
// the output — and a test asserting it — is deterministic regardless of directory-walk order.
//
// PURE CORE, IMPURE SHELL: scanText(text, opts) and scanTree(root, opts) do the real work and
// take no CLI/process dependency, so assert-no-personal-data.test.mjs exercises them directly
// without spawning a subprocess for every case; main() is the argv/exit-code/console wiring.
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

// ── built-in rules ──────────────────────────────────────────────────────────────────────────
// Each rule is `(line) => match string | null` — the first hit on that line, or null. One
// finding per (line, kind), mirroring assert-coord-docs-generic.mjs's own contract; a line
// with two DIFFERENT kinds of hit is two findings, a line with the same kind twice is one.

// The e-mail regex shape is assert-coord-docs-generic.mjs's DENYLIST entry verbatim (see that
// file's own comment for the two version-pin false-positive rules it is built to avoid).
const EMAIL_RX = /[\w.+-]+@(?!(?:[\w-]+\.)*\d+\.)[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?![\w-])/iu;
// RFC 2606 reserved domains/TLDs — always a fixture, never a real address — plus the standard
// GitHub SSH remote user, `git@github.com` (that literal names the protocol, not a person).
const FIXTURE_EMAIL_DOMAIN_RX =
  /(?:^|\.)(?:example\.(?:com|net|org)|invalid|test|example|localhost)$/i;
function ruleEmail(line) {
  const m = EMAIL_RX.exec(line);
  if (!m) return null;
  const address = m[0];
  if (address.toLowerCase() === 'git@github.com') return null;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  if (FIXTURE_EMAIL_DOMAIN_RX.test(domain)) return null;
  return address;
}

// Hostnames are ASCII by construction, so a plain `\b` (no Unicode boundary needed) is correct.
const HOSTNAME_RX = /\bDESKTOP-[A-Za-z0-9]{6,}\b/i;
function ruleHostname(line) {
  const m = HOSTNAME_RX.exec(line);
  return m ? m[0] : null;
}

// Four path flavors, one capture group (the leaf name) each. `/home/user` and its siblings are
// excluded — every cloud sandbox runs as that user, so it is a generic path, not a personal
// one — and so is a leaf that is only dots (`...`, a documentation placeholder, never a real
// name). Scanned with `g` so a line carrying both an excluded and a real hit still reports the
// real one, regardless of which comes first.
const HOME_PATH_RX = /(?:C:\\Users\\|C:\/Users\/|\/home\/|\/Users\/)([A-Za-z0-9_.-]+)/g;
function ruleHomePath(line) {
  HOME_PATH_RX.lastIndex = 0;
  let m;
  while ((m = HOME_PATH_RX.exec(line))) {
    const leaf = m[1];
    if (leaf.toLowerCase() === 'user') continue;
    if (/^\.+$/.test(leaf)) continue;
    return m[0];
  }
  return null;
}

const CLOUD_ENV_ID_RX = /\benv_[A-Za-z0-9]{26}\b/;
function ruleCloudEnvId(line) {
  const m = CLOUD_ENV_ID_RX.exec(line);
  return m ? m[0] : null;
}

const BUILTIN_RULES = [
  { kind: 'email', run: ruleEmail },
  { kind: 'hostname', run: ruleHostname },
  { kind: 'home-path', run: ruleHomePath },
  { kind: 'cloud-env-id', run: ruleCloudEnvId },
];

// Per-line waiver, the repo's established `// <axis>-ok: <reason>` shape (see
// `// platform-assert-ok:` in scripts/assert-posix-path-assertions.mjs). A line carrying
// `personal-data-ok:` suppresses the four BUILT-IN shape rules — this is how this module's own
// shipped test file marks its intentional synthetic fixtures (a fake hostname, a fake
// cloud-sandbox id, a fake e-mail address, …) so the tree-wide scan doesn't flag its own test
// suite (findings cd2539 / ce75bb). It does NOT suppress a `denylist` hit — see the file header's
// WAIVER section for why.
const WAIVER_RX = /personal-data-ok:/;

// ── pure core ────────────────────────────────────────────────────────────────────────────────

/**
 * Pure: every finding `{ line, kind, match }` (1-based line numbers) in `text` — the built-in
 * rules above, plus a case-insensitive literal-substring check against `denylist` (an array of
 * strings; each hit is its own `{ kind: 'denylist', match }`, matched text preserving the
 * source line's own casing).
 */
export function scanText(text, { denylist = [] } = {}) {
  const lines = text.split('\n');
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // The waiver suppresses the four built-in SHAPE rules only — a denylist hit (an exact,
    // hand-picked personal literal) always fires, waiver or not. See the WAIVER section above.
    if (!WAIVER_RX.test(line)) {
      for (const { kind, run } of BUILTIN_RULES) {
        const match = run(line);
        if (match != null) findings.push({ line: i + 1, kind, match });
      }
    }
    for (const entry of denylist) {
      const needle = String(entry).toLowerCase();
      const idx = line.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      findings.push({ line: i + 1, kind: 'denylist', match: line.slice(idx, idx + entry.length) });
    }
  }
  return findings;
}

// A file is "binary" when a NUL byte appears in its first 8 KB — cheap and standard; this gate
// has no reason to sniff harder than that. Reads only that sniff window (not the whole file —
// a large binary asset would otherwise be loaded fully just to be discarded) into ONE reused
// buffer, since scanTree walks files strictly one at a time.
const BINARY_SNIFF_BYTES = 8192;
const sniffBuffer = Buffer.alloc(BINARY_SNIFF_BYTES);
function looksBinary(absPath) {
  const fd = openSync(absPath, 'r');
  let bytesRead;
  try {
    bytesRead = readSync(fd, sniffBuffer, 0, BINARY_SNIFF_BYTES, 0);
  } finally {
    closeSync(fd);
  }
  for (let i = 0; i < bytesRead; i++) {
    if (sniffBuffer[i] === 0) return true;
  }
  return false;
}

const DEFAULT_SKIP_DIRS = Object.freeze(['.git', 'node_modules']);

// Exported so the CLI, the test, and any other caller share one ordering — findings sort by
// (file, line, kind, match), independent of directory-walk order (readdirSync order is not
// guaranteed across platforms/filesystems), so output is deterministic run to run.
export function compareFindings(a, b) {
  return (
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.kind.localeCompare(b.kind) ||
    a.match.localeCompare(b.match)
  );
}

/**
 * Pure-ish (fs reads only, no writes): every finding `{ file, line, kind, match }` under
 * `root`, sorted (compareFindings) — `file` is root-relative with POSIX slashes, always.
 * Walks every subdirectory except `.git`, `node_modules`, and any name listed in `exclude`;
 * skips a file whose first 8 KB contains a NUL byte. `denylist` is forwarded to scanText
 * unchanged.
 */
export function scanTree(root, { denylist = [], exclude = [] } = {}) {
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...exclude]);
  const findings = [];

  const walk = (relSegments) => {
    const absDir = relSegments.length ? join(root, ...relSegments) : root;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const segs = [...relSegments, entry.name];
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(segs);
        continue;
      }
      if (!entry.isFile()) continue; // skip symlinks, sockets, etc.
      const absPath = join(root, ...segs);
      if (looksBinary(absPath)) continue;
      const text = readFileSync(absPath, 'utf8');
      const relFile = segs.join('/');
      for (const f of scanText(text, { denylist })) {
        findings.push({ file: relFile, ...f });
      }
    }
  };
  walk([]);
  findings.sort(compareFindings);
  return findings;
}

// ── CLI shell ────────────────────────────────────────────────────────────────────────────────

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { root: null, denylist: null, json: false, exclude: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') {
      opts.root = argv[++i];
    } else if (a === '--denylist') {
      opts.denylist = argv[++i];
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--exclude') {
      // Variadic: every following token up to the next `--flag` (or end of argv) is a dirname.
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        opts.exclude.push(argv[++i]);
      }
    } else {
      throw new UsageError(`assert-no-personal-data: unknown argument "${a}"`);
    }
  }
  if (!opts.root) throw new UsageError('assert-no-personal-data: --root <dir> is required');
  return opts;
}

function loadDenylistFile(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(
      `assert-no-personal-data: could not read denylist file ${path}: ${err.message}`,
    );
  }
  if (!Array.isArray(raw) || raw.some((e) => typeof e !== 'string' || !e)) {
    throw new UsageError(
      `assert-no-personal-data: denylist file must be a JSON array of non-empty strings: ${path}`,
    );
  }
  return raw;
}

function reportHuman(findings) {
  if (findings.length === 0) {
    console.log('assert-no-personal-data: clean.');
    return;
  }
  for (const f of findings) {
    console.log(`${f.file}:${f.line}: ${f.kind} "${f.match}"`);
  }
  console.log(`assert-no-personal-data: ${findings.length} finding(s).`);
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }

  let denylist = [];
  let root;
  try {
    if (opts.denylist) denylist = loadDenylistFile(opts.denylist);
    root = resolve(opts.root);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new UsageError(`assert-no-personal-data: --root is not a directory: ${root}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }

  let findings;
  try {
    findings = scanTree(root, { denylist, exclude: opts.exclude });
  } catch (err) {
    console.error(`assert-no-personal-data: I/O error while scanning ${root}: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({ root, findings, count: findings.length }));
  } else {
    reportHuman(findings);
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
