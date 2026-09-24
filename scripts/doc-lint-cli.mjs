#!/usr/bin/env node
// scripts/doc-lint-cli.mjs — the shared CLI spine of the doc-freshness lints (plan 3204).
//
// `assert-doc-pointers.mjs` and `assert-plan-pointers.mjs` ask different questions of the same
// corpus, but everything AROUND the question is identical: which flags exist, what an
// explicitly-scoped run means, how a grandfather file is read, when a finding prints versus
// counts, and which exit code each mode produces. Written twice, those ninety lines drift —
// one lint grows a flag the other does not, or the two disagree about whether `--check` and
// `--json` compose. Written once, they cannot.
//
// The QUESTION stays with each lint, injected as three hooks:
//   parse(doc, text) → item        what this lint needs from a document (references, or the
//                                  raw text) — run for every document before anything resolves
//   prepare(items, root) → ctx     one whole-run setup pass, so a lint can batch what would
//                                  otherwise be a per-document subprocess (the dead-pointer
//                                  lint's single `git check-ignore`, the plan lint's single
//                                  `git ls-files` over the plans tree)
//   lintItem(item, {grandfather, ctx}) → {findings, grandfathered}
//
// Every finding is `{doc, line, kind, message}`; the spine formats and counts, never judges.
//
// ── The flags, and why an empty SCOPED run is not an empty run ───────────────────
//   --check            exit 1 when there are findings (the mode a promotion to blocking
//                      would turn on; both lints are WARN-only by default)
//   --stdin            newline-separated paths on stdin — how the pre-push hook scopes to
//                      the pushed diff without the hook restating the corpus rules
//   --json             machine-readable findings on stdout
//   --no-grandfather   report the frozen pre-existing backlog too
//
// SCOPED means the caller named the files, positionally or on stdin. An empty scoped run must
// lint NOTHING, never fall through to the whole corpus: a pre-push hook whose changed-file
// list happens to hold no live doc would otherwise sweep 200 files and report a stranger's
// backlog on somebody's push.
//
// Exit codes: 0 clean, or findings printed in the default WARN-only mode · 1 findings +
// --check · 2 a usage error (an unknown flag), which is a bug in the caller, not a doc finding.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// The repo's ONE stdin reader (plan 2900's consolidation), rather than a fourth bare
// `readFileSync(0)` — it owns the EAGAIN/EOF handling a raw fd read gets wrong.
import { readStdin } from './coord/stdin-read.mjs';

export const KNOWN_FLAGS = ['--check', '--stdin', '--json', '--no-grandfather'];

/**
 * Parse the shared flag set. Returns `{ unknown }` non-empty for a caller bug; the runner
 * turns that into exit 2 rather than guessing what was meant.
 */
export function parseArgs(argv) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = argv.filter((a) => !a.startsWith('--'));
  return {
    unknown: flags.filter((f) => !KNOWN_FLAGS.includes(f)),
    check: flags.includes('--check'),
    asJson: flags.includes('--json'),
    useGrandfather: !flags.includes('--no-grandfather'),
    useStdin: flags.includes('--stdin'),
    scoped: flags.includes('--stdin') || positional.length > 0,
    positional,
  };
}

/**
 * Read a grandfather snapshot: one `<doc> <key>` pair per line, `#` comments and blanks
 * ignored, missing file → empty set. `normalizeKey` lets a lint canonicalise its half of the
 * pair (the plan lint strips zero-padding so `007` and `7` are one plan).
 */
export function readGrandfatherFile(root, file, normalizeKey = (k) => k) {
  const abs = join(root, file);
  if (!existsSync(abs)) return new Set();
  const out = new Set();
  for (const line of readFileSync(abs, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [doc, key] = t.split(/\s+/);
    if (doc && key) out.add(`${doc} ${normalizeKey(key)}`);
  }
  return out;
}

/**
 * Run one doc-freshness lint end to end. `opts` carries the test seams (`root`, `files`,
 * `readDoc`, and whatever `prepare` chooses to accept), so the exit-code contract is pinned by
 * a battery rather than only by a human running the command.
 */
export function runLint(spec, argv = process.argv.slice(2), opts = {}) {
  const {
    name,
    grandfatherFile,
    isCorpusFile,
    listCorpus,
    parse,
    prepare = () => undefined,
    lintItem,
    normalizeGrandfatherKey,
    noun,
    advice,
  } = spec;

  const root = opts.root ?? spec.repoRoot;
  const args = parseArgs(argv);
  if (args.unknown.length) {
    console.error(`${name}: unknown flag(s): ${args.unknown.join(', ')}`);
    return 2;
  }

  let files = args.positional;
  if (args.useStdin) files = files.concat(readStdin().split(/\r?\n/).filter(Boolean));
  // Whatever the caller named, only corpus files are ever linted — so the pre-push hook can
  // hand over its whole changed-file list without re-implementing the corpus rules.
  files = args.scoped ? files.filter((p) => isCorpusFile(p)) : (opts.files ?? listCorpus(root));

  const readDoc =
    opts.readDoc ??
    ((p) => {
      const abs = join(root, p);
      return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    });

  const items = [];
  for (const doc of files) {
    const text = readDoc(doc);
    if (text == null) continue; // deleted in the pushed range — nothing to point at
    items.push(parse(doc, text));
  }

  const ctx = prepare(items, root, opts);
  const grandfather = args.useGrandfather
    ? readGrandfatherFile(root, grandfatherFile, normalizeGrandfatherKey)
    : new Set();

  const findings = [];
  let grandfathered = 0;
  for (const item of items) {
    const r = lintItem(item, { grandfather, ctx });
    findings.push(...r.findings);
    grandfathered += r.grandfathered;
  }

  if (args.asJson) {
    console.log(JSON.stringify({ findings, grandfathered, docs: items.length }, null, 2));
    return findings.length && args.check ? 1 : 0;
  }

  for (const note of ctx?.notes ?? []) console.error(`${name}: NOTE — ${note}`);

  if (!findings.length) {
    if (grandfathered) {
      console.error(
        `${name}: clean (${grandfathered} known ${noun.many} still grandfathered in ${grandfatherFile}).`,
      );
    }
    return 0;
  }

  const label = args.check ? `${name}: FAILED` : `${name}: WARN (advisory, push continues)`;
  console.error(`${label} — ${findings.length} ${noun.many} across ${items.length} doc(s):`);
  for (const f of findings) console.error(`  ${f.doc}:${f.line}  [${f.kind}]  ${f.message}`);
  console.error(`  ${advice}`);
  if (grandfathered) {
    console.error(
      `  (${grandfathered} further known ${noun.many} are grandfathered in ${grandfatherFile} and not listed.)`,
    );
  }
  return args.check ? 1 : 0;
}
