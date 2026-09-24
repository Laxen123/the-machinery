#!/usr/bin/env node
// scripts/coord/land-typecheck-rows.mjs — the `land.typecheckCommands[]` reader (plan 4096 T5).
//
// WHY THIS EXISTS. `scripts/hooks/pre-push-core.sh` used to spell three typecheck gates out
// literally — `pnpm --filter @vetapp/frontend exec tsc --noEmit` and two `@vetapp/backend`
// siblings. Those are vetapp's package names and vetapp's pnpm workspace; a coordination-core
// checkout with no workspace at all cannot run any of them, so a "core" file was carrying three
// project commands. They are DATA now, in `coord.config.json → land.typecheckCommands[]`, with
// an EMPTY core default — the same posture plan 3960 gave `deployServices[]` and plan 4071 gave
// the rest of the vetapp literals that had ended up inside `scripts/coord/**`.
//
// The hook reads this module's CLI, never the JSON directly: a `sh` that has to parse JSON is a
// worse idea than one node spawn on the vanishingly rare push that reaches the gate at all (the
// rows are diff-scoped, so a docs-only push never invokes this).
//
// ── THE WORD-SPLITTING CONTRACT (this is the sharp edge) ──────────────────────────────────────
// The hook runs each row as `run_bounded <cap> $cmd` with `$cmd` UNQUOTED, because `run_bounded`
// needs the command as separate argv words and dash has no arrays. That means the command string
// is split on whitespace by the shell, with no quoting and no escaping available. A row whose
// command needed a quoted argument (`--flag "two words"`), a glob, or any shell metacharacter
// would silently run as something other than what it says.
//
// So this module REFUSES such a row (exit 2, naming it) rather than emitting it. Failing closed
// here is the whole point: the alternative — emit it and let the shell mangle it — is a gate that
// runs the wrong command and reports a verdict for it. Every real row today is plain words.
//
// ── OUTPUT FORMAT ─────────────────────────────────────────────────────────────────────────────
// One TAB-separated record per row, in config order, for `while IFS=<tab> read` in the hook:
//
//   <name>\t<label>\t<changed>\t<group>\t<groupDiffLabel>\t<capSeconds>\t<isLastOfGroup>\t<plural>\t<failHint>\t<command>
//
// `command` is LAST so a future extra field cannot be confused with it, and because it is the one
// field that legitimately contains spaces. `isLastOfGroup` ("1"/"0") drives the group's trailing
// "… clean" line; `plural` reproduces the existing "300s cap each" wording for a multi-row group.
// Tabs and newlines are rejected in every field (a config value carrying one would desynchronise
// the reader), again by refusal rather than by escaping.
//
// NO FIELD IS EVER EMPTY, and that is a correctness requirement of the reader, not a style rule.
// The hook splits with `IFS=<tab> read`, and TAB is an IFS *whitespace* character — POSIX has the
// shell collapse a run of IFS whitespace into ONE delimiter, so an empty field would silently
// shift every later field one position left. `plural` is therefore the literal token `each` or
// `single`, never `each` or `""`; every other field is validated non-empty above.

import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { loadCoordConfig } from './coord-config.mjs';

// A command this module will hand to an unquoted shell expansion: plain words only. Anything a
// shell would treat specially — quotes, $, backtick, glob, redirect, pipe, semicolon, &, (), {},
// [], \, newline, tab — makes the row unrunnable through that seam, so it is refused.
const SHELL_UNSAFE_RX = /[|&;<>()$`\\"'*?[\]{}\t\n\r]/;

const FIELD_UNSAFE_RX = /[\t\n\r]/;

// A gate NAME reaches `gate_needs_run "$1"`, which interpolates it into a grep expression when it
// looks the gate up in the pass-cache decisions file — UNESCAPED. So a name carrying a regex
// metacharacter would not merely look odd: it would match the wrong line, or none, and the gate's
// cached verdict would silently belong to some other gate. The name is also the pass-cache KEY, so
// it has to be a stable plain token anyway. Restricted to the shape every existing gate name
// already has (`tsc-frontend`, `pytest-backend-scripts`, `vitest-backend-seed-sanity`).
//
// `.` is deliberately NOT in the set (review round 2): it is the one character that looks
// innocuous in a name yet is a regex metacharacter, so `tsc.frontend` would match `tscXfrontend`
// in that lookup — the very wrong-gate read this allowlist exists to prevent. No gate name in this
// repo has ever contained one.
const GATE_NAME_RX = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// POSIX ERE constructs that JavaScript's RegExp accepts but `grep -E` does not. The `changed`
// pattern is validated HERE in JS and executed THERE by `grep -E`, so a JS-only construct passes
// this reader and then either errors inside the hook or — worse — matches something different,
// silently changing which pushes the gate fires on. `new RegExp()` alone cannot catch that: it is
// the wrong dialect.
//
// This is a deliberately CONSERVATIVE intersection, not a full ERE parser: it rejects the
// JavaScript-only spellings that actually appear in practice, and accepts the ERE subset every
// real row uses. A pattern this rejects always has an ERE equivalent — `\d` is `[0-9]`, `(?:…)` is
// `(…)`, `\b` is a word-boundary ERE does not have at all. Erring toward refusal is the safe
// direction: a refused row is a loud config error, an accepted-but-misbehaving one is a gate
// quietly watching the wrong paths.
const ERE_UNSUPPORTED = [
  [
    /\(\?/,
    'a `(?…)` group (non-capturing, lookahead, lookbehind or named) — ERE has none of these',
  ],
  [
    /\\[dDwWsSbBAZzG]/,
    'a `\\d`/`\\w`/`\\s`/`\\b`-style shorthand class — ERE has no such escapes (use a bracket expression such as `[0-9]`)',
  ],
  [
    /[*+?}]\?/,
    'a lazy/non-greedy quantifier (`*?`, `+?`, `??`, `}?`) — ERE quantifiers are always greedy',
  ],
  [/\\[1-9]/, 'a backreference — ERE has none'],
  [/\\[pPuxk]/, 'a `\\p`/`\\u`/`\\x`/`\\k` escape — ERE has none'],
  // Review round 2: JavaScript control escapes. These are the quiet ones — `\n` is a NEWLINE to
  // JavaScript and a literal `n` to `grep -E`, so the pattern compiles in both dialects and
  // matches DIFFERENT things. No error anywhere; just a gate watching paths nobody intended.
  [
    /\\[ntrfv0]/,
    'a `\\n`/`\\t`/`\\r`/`\\f`/`\\v`/`\\0` control escape — ERE reads these as the bare letter, so the two dialects silently match different text',
  ],
  [/\\c[A-Za-z]/, 'a `\\cX` control escape — ERE has none'],
];

/**
 * Why `pattern` cannot be handed to `grep -E`, or null when it can.
 *
 * Exported so the name-paired test can pin each rejection independently of the row plumbing.
 */
export function ereUnsupportedReason(pattern) {
  for (const [rx, why] of ERE_UNSUPPORTED) {
    if (rx.test(pattern)) return why;
  }
  return null;
}

/** Rows are grouped by consecutive equal `group` — the header/trailer prose is per GROUP. */
function groupSpans(rows) {
  const lastOfGroup = new Array(rows.length).fill(false);
  const sizeOfGroup = new Array(rows.length).fill(1);
  let start = 0;
  for (let i = 0; i <= rows.length; i++) {
    if (i === rows.length || rows[i].group !== rows[start].group) {
      lastOfGroup[i - 1] = true;
      for (let j = start; j < i; j++) sizeOfGroup[j] = i - start;
      start = i;
    }
  }
  return { lastOfGroup, sizeOfGroup };
}

/**
 * Validate + normalize `land.typecheckCommands[]`. Returns `{ rows }` or throws with a message
 * naming the offending row — never a silent drop, because a dropped typecheck row is a gate that
 * stops running with a green push to show for it.
 */
export function typecheckRows(config) {
  const raw = config?.land?.typecheckCommands ?? [];
  if (!Array.isArray(raw)) {
    throw new Error('land.typecheckCommands must be an array (got ' + typeof raw + ')');
  }
  const seen = new Set();
  const rows = raw.map((r, i) => {
    const at = `land.typecheckCommands[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error(`${at} must be an object`);
    }
    const str = (key, { required = true } = {}) => {
      const v = r[key];
      if (v == null && !required) return '';
      if (typeof v !== 'string' || v === '') {
        throw new Error(`${at}.${key} must be a non-empty string`);
      }
      if (FIELD_UNSAFE_RX.test(v)) {
        throw new Error(`${at}.${key} must not contain a tab or newline`);
      }
      return v;
    };
    const name = str('name');
    if (!GATE_NAME_RX.test(name)) {
      throw new Error(
        `${at}.name must match ${GATE_NAME_RX} — the hook interpolates it UNESCAPED into the ` +
          `pass-cache lookup expression, so a regex metacharacter here makes the gate read some ` +
          `other gate's cached verdict (or none) instead of its own. Got: ${name}`,
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `${at}.name duplicates an earlier row ("${name}") — gate names are cache keys`,
      );
    }
    seen.add(name);
    const changed = str('changed');
    // Both dialects, in this order. `new RegExp` catches plain malformedness (an unterminated
    // bracket expression is invalid in either), and ereUnsupportedReason catches the subtler and
    // more dangerous case: syntax JavaScript accepts that `grep -E`, the ACTUAL consumer, does not.
    try {
      new RegExp(changed);
    } catch (e) {
      throw new Error(`${at}.changed is not a valid regular expression: ${e.message}`);
    }
    const ereWhy = ereUnsupportedReason(changed);
    if (ereWhy) {
      throw new Error(
        `${at}.changed is valid JavaScript but NOT POSIX ERE, and the hook runs it through ` +
          `\`grep -E\`, not JavaScript: it uses ${ereWhy}. Rewrite it in ERE. Got: ${changed}`,
      );
    }
    const command = str('command');
    if (SHELL_UNSAFE_RX.test(command)) {
      throw new Error(
        `${at}.command contains a shell metacharacter, which this seam cannot run: the hook ` +
          `expands it UNQUOTED so the shell splits it into argv words, with no quoting available ` +
          `(see this module's header). Rewrite it as plain words, or give the gate its own ` +
          `project hook seam in scripts/hooks/pre-push-project.sh. Got: ${command}`,
      );
    }
    const capSeconds = r.capSeconds;
    if (!Number.isInteger(capSeconds) || capSeconds <= 0) {
      throw new Error(`${at}.capSeconds must be a positive integer (got ${String(capSeconds)})`);
    }
    return {
      name,
      label: str('label'),
      changed,
      group: str('group'),
      groupDiffLabel: str('groupDiffLabel'),
      capSeconds,
      failHint: str('failHint'),
      command,
    };
  });
  // A group must be contiguous AND internally consistent: every row in it shares one `changed`
  // pattern and one `groupDiffLabel`, because the hook tests the pattern ONCE per group and
  // prints that label once. A config that disagreed with itself here would silently run a row
  // under another row's diff trigger.
  const groupStartOf = new Map();
  rows.forEach((row, i) => {
    if (!groupStartOf.has(row.group)) {
      groupStartOf.set(row.group, i);
      return;
    }
    const first = rows[groupStartOf.get(row.group)];
    if (rows[i - 1]?.group !== row.group) {
      throw new Error(
        `land.typecheckCommands: group "${row.group}" is not contiguous (row ${i} rejoins it ` +
          `after another group) — the hook evaluates one diff trigger per contiguous group`,
      );
    }
    for (const key of ['changed', 'groupDiffLabel']) {
      if (row[key] !== first[key]) {
        throw new Error(
          `land.typecheckCommands: rows in group "${row.group}" disagree on ${key} ` +
            `("${first[key]}" vs "${row[key]}") — one trigger and one label per group`,
        );
      }
    }
  });
  return rows;
}

/** The TAB-separated records the hook consumes. See this module's header for the field order. */
export function typecheckRecords(config) {
  const rows = typecheckRows(config);
  const { lastOfGroup, sizeOfGroup } = groupSpans(rows);
  return rows.map((r, i) =>
    [
      r.name,
      r.label,
      r.changed,
      r.group,
      r.groupDiffLabel,
      String(r.capSeconds),
      lastOfGroup[i] ? '1' : '0',
      sizeOfGroup[i] > 1 ? 'each' : 'single',
      r.failHint,
      r.command,
    ].join('\t'),
  );
}

export function main(argv = []) {
  const root = argv[0] || process.cwd();
  const records = typecheckRecords(loadCoordConfig(root));
  if (records.length) process.stdout.write(records.join('\n') + '\n');
  return 0;
}

// CLI-entry detection, REALPATH-compared — deliberately not the bare
// `import.meta.url === pathToFileURL(process.argv[1]).href` idiom the sibling coord modules use.
// Node resolves a module's own URL through symlinks while `process.argv[1]` keeps the spelling
// the caller typed, so the bare form silently answers "not the entry point" when this file is
// reached through a symlinked path — `main()` never runs, nothing is printed, and the process
// exits 0. For most CLIs that is a harmless no-op; for THIS one it is a fail-OPEN, because the
// hook reads empty-output-and-exit-0 as "no typecheck configured" and skips all three gates on a
// green push. Measured, not theorised: a symlinked `scripts/coord` in this module's own test
// harness reproduced exactly that. Comparing realpaths costs two stat calls and removes the
// silent skip; an unreadable argv[1] falls back to the plain comparison rather than throwing.
function isCliEntry() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(self) === realpathSync(argv1);
  } catch {
    return import.meta.url === pathToFileURL(argv1).href;
  }
}

if (isCliEntry()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error('land-typecheck-rows:', e?.message ?? e);
    process.exitCode = 2;
  }
}
