#!/usr/bin/env node
// scripts/hooks/hand-rolled-step-guard.mjs — PreToolUse hook (plan 2848).
//
// WARNS (never denies) when a Bash command hand-rolls a mechanical step this
// repo already owns a purpose-built tool for. The failure it targets is not
// "forgot a rule" but "did not think to look": a session reaches for a generic
// shell construct precisely because the step FEELS too trivial to look up,
// which is the one condition under which no amount of prose guidance fires.
// Session 2711 walked past the existing CLAUDE.md rule twice in one sitting.
//
// BOUNDED BY PLAN 2819's spine-over-guard principle: where a spine owns the
// moment, the right fix is to make the spine do it automatically, never to warn
// a human. A guard is the fallback ONLY for moments no spine owns — where the
// human still has to choose the right command unprompted. That test was applied
// per candidate at plan 2848's spec-pass and DROPPED the "git push retry while
// one is already alive" row (scripts/hooks/pre-push.sh already runs inside every
// push and could check for an alive push itself; recorded as one line in
// docs/handoff/infra-debt.md, NOT implemented here). Any future candidate an
// owning script could handle belongs in that script, not in this file.
//
// SEVEN pinned patterns (deliberately narrow — see § Tight patterns below):
//   1. heavy-test-unqueued  — a whole-suite / whole-directory test run not
//                             wrapped in scripts/queued-run.mjs
//   2. bare-main-install    — a bare `pnpm install` in the MAIN checkout
//   3. seed-corpus-walk     — a WILDCARD walk over the seed record shards
//   4. env-walk-up          — a `dotenv` import (there is no dotenv in this
//                             workspace; the hand-rolled form throws)
//   5. stale-lock-rm        — an `rm` of a git LOCK file (plan 3752): the
//                             blind form a session reaches for on a crash
//                             leftover, where clear-stale-worktree-lock.mjs
//                             already exists AND is already allow-listed
//   6. review-debt-hand-mint — a `next-plan-id.mjs claim` naming a
//                             `--slug review-debt-*` (plan 3967): the shape
//                             a session reaches for when it hand-mints a
//                             fastlane plan's follow-up review-debt plan
//                             instead of the review-findings parking tool,
//                             which also dispositions every parked finding
//                             into it in the SAME write — a hand mint skips
//                             that half entirely, leaving the findings
//                             undispositioned.
//   7. prettier-hand-check  — a hand-run `prettier --check`/`--write`
//                             (plan 4211): can silently examine ZERO files
//                             and still report success (an ignored path, or
//                             any path under another checkout's ignore
//                             files), where node scripts/prettier-check.mjs
//                             checks per file via prettier's Node API and
//                             never prints a false clean.
//
// § Pattern 5 is the one that cost real time rather than risk. 2026-09-05 an
// unattended cloud drain hand-rolled `GD=…; rm -f "$GD"/index.lock …` and sat
// on a permission ask for 8h24m: the cloud allow-list is deliberately narrow
// and cannot match a `VAR=`-prefixed shell script, while the sanctioned
// `node scripts/clear-stale-worktree-lock.mjs` is allow-listed verbatim and
// would have run with zero clicks. So this row's payoff is not "safer" (though
// it is — the tool only removes a provably-idle lock, a blind `rm -f` also
// nukes a live one); it is that the named tool AUTO-APPROVES where the
// hand-rolled form structurally never can.
//
// § WARN, never DENY. Exit 0 always; the warning rides PreToolUse
// `hookSpecificOutput.additionalContext` via loader-common's shared
// `injectionEnvelope` (the envelope `emitInjection` prints) (the non-blocking channel the wiki loaders use).
// Legitimate one-offs exist and the value is naming the tool at the moment of
// the mistake, not blocking. A deny here would get the hook muted within a day.
//
// § EVERYTHING IS PER SEGMENT. The command is split into shell segments and each
// is judged on its own, against the cwd IN EFFECT AT THAT POINT. Two review
// rounds drove this: a command-wide exemption let a sanctioned tool in one
// segment silence a violation in another, and a single final cwd made
// `cd <worktree> && pnpm install && cd ../../.. && pnpm install` judge BOTH
// installs by where the LAST one ran. Nothing here reasons about the whole
// command any more except the emit itself.
//
// § A NEWLINE IS A SEPARATOR, like `;` (plan 3752 review). It is one in every
// shell, and treating it as ordinary text made a MULTI-LINE script read as one
// giant segment — which silenced three ways at once: a leading `cd` line
// swallowed the whole rest of the command as its target, a leading `echo` or
// `git status` line made the entire block read as prose, and any leading plain
// word put every later command out of command position. All three were CONFIRMED
// against the very shape this hook exists for, since an unattended drain writes
// multi-line scripts. Two exceptions keep it faithful to the shell: a
// BACKSLASH-escaped newline is a line CONTINUATION (blanked away, so the halves
// join), and a HEREDOC BODY is data, not commands (blanked before anything else,
// so `cat <<EOF … pnpm install … EOF` writes a file rather than running one).
//
// § Never fire on the sanctioned tools themselves, per pattern AND per segment.
// `queued-run.mjs` runs the very command it wraps, so a guard that flags its own
// recommended replacement is self-discrediting. Two tokens from the spec's list
// (`push-queue-status.mjs`, `landing-queue-watch.mjs`) are deliberately GONE:
// they exempted the push-retry row that the spec-pass dropped and a
// landing-queue wait that was never a pattern, so they could only ever silence
// something else by accident.
//
// § A runner must be in COMMAND POSITION. `pytest` as a flag VALUE to some other
// tool (`node run.mjs --runner pytest`) is not a test run. A segment's leading
// tokens must all be wrappers (an env assignment, `pnpm`, `exec`, `python -m`, …)
// for the runner token to count. This is what keeps the matcher from being a
// substring search over the command text.
//
// § Tight patterns over broad ones. Prefer a miss to a false positive — the
// whole asset is that the warning still means something the tenth time it
// fires. Concretely: a single-FILE test run never fires (and the file must look
// like a TEST file, so `vitest run --config vitest.config.ts` is still a whole
// suite); a glob must sit ON the seed path, in the same token; a WORKTREE
// install never fires (worktree installs are lock-free by design, per
// docs/coord/worktrees.md § The install lock); a segment that merely
// PRINTS or COMMITS text (`echo`, `printf`, `git commit`) runs nothing at all;
// and a SEARCHER (`grep`/`rg`/…) hunting for dotenv usage is auditing it, not
// importing it.
//
// § Quoted spans are prose, not invocations — worktree-guard.sh's plan-496
// lesson, enforced two ways for two jobs:
//   • SEGMENT SPLITTING and the whole-segment REGEXES read a BLANKED view whose
//     quoted content is spaces (length preserved, so offsets stay aligned), so
//     a `&&` inside a quoted sentence is not a separator.
//   • Every TOKEN WALK reads the RAW segment through a QUOTE-AWARE tokenizer
//     that keeps a quoted span as ONE token. That gives the same protection
//     (a quoted sentence never yields a bare `pnpm` token) while preserving the
//     VALUES the walks need — a cd target, a test-file argument, a seed glob, a
//     `git -C "path with space"` — which a whitespace split destroyed.
//
// § Scope is vetapp-only (operator ruling 2026-08-04, plan 2848 § Operator
// rulings — chosen over "machine-wide now"). The patterns name vetapp's own
// tools, so a segment whose cwd is outside this repo is skipped entirely: a
// `cd ../tandapp && pnpm install` is a sibling repo's business.
//
// § Known limit, accepted: a `cd` inside a subshell is treated as persistent for
// the rest of the command. Tracking subshell scope properly needs a real shell
// parser, which is far beyond a warn-only hook — and the failure direction is a
// missed warning, not a false one.
//
// § Measurement. One line per firing (ISO timestamp + pattern key) is appended
// to ~/.claude/session-state/hand-rolled-guard-firings.log — the wedge-kills.log
// precedent. No follow-up-detection machinery: the log makes a later "does
// anyone heed it" analysis possible at zero build cost.
//
// § A SECOND CLI classifier flag lives here too: `--unqueued-pytest-sweep-json`
// (plan 3969 T2), the twin of `--stale-lock-rm-json` — worktree-guard.sh calls
// it to DENY an unwrapped whole-directory pytest sweep, reusing this file's
// own pytest recognition (`unqueuedPytestSweepHits`) so there is one parser,
// not two. This file's own never-deny posture is unchanged: the flag only
// PRINTS hits, exactly like the stale-lock one, and the block itself lives in
// the shell hook.
//
// § A THIRD CLI classifier flag, `--unqueued-heavy-test-json` (plan 4241),
// same shape again: worktree-guard.sh DENIES a bare `node --test <file>` when
// <file>'s repo-relative PATH is on the MEASURED heavy list
// scripts/heavy-test-files.mjs regenerates from the battery ledger
// (scripts/coord/heavy-test-files.json) — matched on path, not basename, so
// two same-named files in different directories (review round: findings
// ee6714/147420) are never conflated. See `unqueuedHeavyTestFileHits`'s own
// doc comment below for the match shape and the fail-open contract. The two
// DENY classifiers do not share a
// predicate (pytest sweeps vs. a single `node --test` file are unrelated
// shapes) but share every other convention: segment walk, command position,
// fail-open on doubt, one parser for both this file and the shell hook.
//
// Fails OPEN on any parse/IO error — a tool hook must never break the turn.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectionEnvelope, readStdin, runHookCli } from './lib/loader-common.mjs';
import { loadCoordConfig } from '../coord/coord-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

export const FIRING_LOG = join(
  homedir(),
  '.claude',
  'session-state',
  'hand-rolled-guard-firings.log',
);

// ── quoting + segmentation ───────────────────────────────────────────────────
// Drop every backslash-ESCAPE PAIR, walking left to right so parity is right by
// construction: `\*` is a literal asterisk and vanishes, while `\\*` is an
// escaped BACKSLASH followed by a live glob and keeps its `*`. A regex pass
// cannot do this — /\\./ matches the second backslash of `\\` and reads the
// character after it as escaped (review round 9).
function stripEscapes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      i++;
      continue;
    }
    out += s[i];
  }
  return out;
}

// ONE left-to-right pass, PRESERVING LENGTH so an index into the blanked text
// addresses the same character in the raw text. It blanks two things:
//   • the CONTENT of every quoted span, so a `&&` inside a sentence is not a
//     separator;
//   • a backslash-escaped SEPARATOR, which is a literal character — `printf
//     foo\; pnpm test` was being torn into two segments and the invented one
//     drew a false heavy-test warning (review round 8).
// A single scan is what makes the second one CORRECT: the round-8 regex form
// had no backslash parity, so `cd <path>\\;pnpm test` — a real separator after
// an escaped backslash — was swallowed and the whole command went unwarned
// (review round 9). Escapes are only special OUTSIDE quotes here, matching the
// tokenizer, and only a separator gets blanked: blanking every `\X` pair would
// eat the backslashes in every Windows path this repo's commands carry.
export function blankQuotedSpans(cmd) {
  const s = String(cmd);
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (quote) out += '  ';
      // A backslash-escaped NEWLINE is a line continuation: blanking both
      // characters joins the halves, so `rm -f \<newline>  .git/index.lock`
      // stays one command once newlines became separators (plan 3752).
      else out += '&|;()\n\r'.includes(next) ? '  ' : c + next;
      i++;
      continue;
    }
    if (quote) {
      out += c === quote ? c : ' ';
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

// A HEREDOC BODY is data the shell writes, not commands it runs, so it must not
// yield segments — otherwise a `cat <<EOF … pnpm install … EOF` that WRITES a
// runbook line reads as an install (a false positive newline-splitting would
// have introduced, plan 3752). Length-preserving like every other blanking pass:
// body characters become spaces, the newlines stay, so the body collapses into
// empty segments that segmentPairs filters out. Runs BEFORE quote blanking,
// because a quoted delimiter (`<<'EOF'`) would otherwise have its own name
// blanked away before this pass could read it.
const HEREDOC_OPEN_RE = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;

export function blankHeredocBodies(cmd) {
  const s = String(cmd);
  const re = new RegExp(HEREDOC_OPEN_RE.source, 'g');
  const blank = (from, to) => s.slice(from, to).replace(/[^\n\r]/g, ' ');
  let out = '';
  let cursor = 0; // everything before this is already decided
  let m;
  while ((m = re.exec(s))) {
    if (m.index < cursor) continue; // an opener INSIDE a body is body text
    const bodyStart = s.indexOf('\n', m.index + m[0].length);
    if (bodyStart < 0) break; // no body at all — nothing to blank
    // The terminator is the delimiter ALONE on its line (leading whitespace is
    // allowed: `<<-` strips tabs, and being generous here can only blank more
    // body, never less command).
    const end = new RegExp(`^[ \\t]*${m[2]}[ \\t]*\\r?$`, 'm');
    const rest = s.slice(bodyStart + 1);
    const hit = rest.match(end);
    // An UNTERMINATED heredoc runs to the end of the command — the shape a
    // truncated or still-being-typed script has.
    const bodyEnd = hit ? bodyStart + 1 + hit.index : s.length;
    out += s.slice(cursor, bodyStart + 1) + blank(bodyStart + 1, bodyEnd);
    cursor = bodyEnd;
  }
  return out + s.slice(cursor);
}

// `&&` and `||` first so the single-char class never splits them in half. The
// bare `&` (background) and the subshell parens are separators too — a review
// round found both missing, and each one silently glued two commands into a
// segment that then matched neither. A NEWLINE is a separator for the same
// reason it is one in the shell (plan 3752) — without it a multi-line script was
// ONE segment, and its first line decided the fate of every line below it.
const SEPARATOR_RE = /&&|\|\||[;|&()\n\r]/g;

// Split into shell segments on the BLANKED text, returning both views of each.
// Blanking once here is the ONLY place it happens per evaluation.
function segmentPairs(cmd) {
  const raw = String(cmd);
  const blanked = blankQuotedSpans(blankHeredocBodies(raw));
  const out = [];
  const re = new RegExp(SEPARATOR_RE.source, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(blanked))) {
    out.push({ raw: raw.slice(last, m.index), scan: blanked.slice(last, m.index) });
    last = m.index + m[0].length;
  }
  out.push({ raw: raw.slice(last), scan: blanked.slice(last) });
  return out.filter((s) => s.scan.trim());
}

function stripQuotes(tok) {
  const t = String(tok).trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// QUOTE-AWARE tokenizer, run over the RAW segment: a quoted span is ONE token,
// however many spaces it contains. A plain whitespace split shattered
// `git -C "path with space" commit` into fake tokens (so `-C` ate a stray quote
// and the real subcommand was never found) and broke `FOO="bar baz" pnpm test`
// out of its env assignment — review round 6, both realistic on this machine.
//
// It also SUBSUMES what the blanked view was doing for token walks: a quoted
// sentence collapses to a single token, so `echo "… pnpm install …"` never
// yields a bare `pnpm` token to match on. The blanked view is still what splits
// SEGMENTS (a `&&` inside quotes is not a separator) and what the whole-segment
// regexes read.
// Memoised: one command is tokenised by the prose check, by each pattern's
// exemption check, by every command-position test and by the seed check. The
// hook is a one-shot process, so this is bounded by one command's segments; the
// cap only matters to the test process, which imports the module once and calls
// it thousands of times.
const TOKEN_CACHE = new Map();
const TOKEN_CACHE_MAX = 512;

export function tokensOf(seg) {
  const s = String(seg);
  const hit = TOKEN_CACHE.get(s);
  if (hit) return hit;
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // A backslash escapes the NEXT character, inside quotes and out. Both halves
    // are kept verbatim (a Windows path's `\U` is unchanged); what matters is
    // that the escaped character cannot act as a quote or as a separator.
    // Without this the tokenizer and `blankQuotedSpans` — which has always used
    // `\\.` — DISAGREED about where a quoted span ends, so `"a \" b"` closed
    // early here and not there, and `path\ with\ space` shattered into fake
    // tokens that hid the real git subcommand (review round 7).
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[i + 1];
      i++;
      continue;
    }
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  // FROZEN: a cached array is handed to every caller, so a caller that sorted or
  // popped it would silently rewrite what later detectors see (review round 8).
  Object.freeze(out);
  if (TOKEN_CACHE.size >= TOKEN_CACHE_MAX) TOKEN_CACHE.clear();
  TOKEN_CACHE.set(s, out);
  return out;
}

// The same tokens with their quotes stripped — the form every caller actually
// wanted. Memoised separately because `.map(stripQuotes)` was being redone by
// each detector, by commandTokenIndex inside it, and again by the git parse
// (review round 8); one path also means one place for the normalisation to be
// wrong in.
const NORM_CACHE = new Map();

export function normTokensOf(seg) {
  const s = String(seg);
  const hit = NORM_CACHE.get(s);
  if (hit) return hit;
  const out = Object.freeze(tokensOf(s).map(stripQuotes));
  if (NORM_CACHE.size >= TOKEN_CACHE_MAX) NORM_CACHE.clear();
  NORM_CACHE.set(s, out);
  return out;
}

// ── command position ─────────────────────────────────────────────────────────
// Tokens that may precede a runner without making it an argument: inline env
// assignments and the wrappers this repo actually uses to invoke one.
const WRAPPERS = new Set([
  'time',
  'timeout',
  'nice',
  'sudo',
  'env',
  'command',
  'npx',
  'pnpm',
  'exec',
  'dlx',
  'run',
  'python',
  'python3',
  '-m',
  'uv',
  'uvx',
  'poetry',
]);
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// GNU `timeout`'s DURATION positional (`timeout 900 <cmd>`, `timeout 30s <cmd>`).
// It is a bare number with an optional single-letter suffix — never a flag, never
// the runner itself — and prefixOk's walk below treats it as transparent ONLY
// while a `timeout` wrapper token is still awaiting one (plan 4140). Not folded
// into the generic "any token may be a value" rule on purpose: that rule is
// gated on the PRECEDING token being a dash-flag, and widening it to admit a
// bare digit-shaped token unconditionally would let a real runner argument that
// happens to look like a bare number (unlikely, but untested) slip through the
// same hole the review rounds at ~line 403 closed.
// GNU timeout parses DURATION with a C FLOAT parser, so the accepted spellings
// are the whole C-float grammar with an optional `[smhd]` suffix: `900`, `0.5s`,
// a leading-dot `.5s`, a trailing-dot `1.s`, an exponent `1e2s`, and `inf` /
// `infinity` in any case. Matching the GRAMMAR rather than enumerating
// spellings is deliberate — review rounds 1 and 2 (findings a58427 / 80e7b8 /
// 50b7d5, then ffc170 / 454c7e / b4afb5) each named a further spelling an
// enumeration had missed, and every miss leaves the plan-4140 fix a NO-OP for
// that shape: the duration token ends prefixOk's walk and the guard goes as
// blind as it was before `timeout` was a wrapper at all.
//
// Widening is safe because the blast radius is exactly ONE token: the slot is
// consumed only while `timeoutAwaitingDuration` is armed (i.e. immediately
// after a literal `timeout`, across its own options), and the single optional
// suffix letter keeps ordinary words out — `inform` is not `inf` + suffix.
// Three bounds, each pinned by a test (review round 3 — ed1ff0 / 1169e0 /
// cc4cb3):
//   · the SUFFIX is lowercase-only. GNU's own suffix check is, so `timeout 1S`
//     is REJECTED by timeout and never launches anything — a blanket /i made
//     the guard warn and, worse, DENY on a command that cannot run. On a
//     shared DENY path a false positive parks an unattended session on a
//     prompt nobody can approve, so too WIDE is the worse error here.
//   · only `inf`/`infinity` is case-insensitive, because strtod parses that
//     spelling case-insensitively while the suffix is timeout's own check.
//   · the digit quantifiers do not overlap (`\d+(?:\.\d*)?`, never `\d+\.?\d*`),
//     so a long malformed token is rejected without repartitioning the digits.
// Hexadecimal float durations (`0x1p2`) are deliberately NOT matched: strtod
// accepts them, but nothing types them, and every character of grammar widens
// the one-token slot for no reachable gain — the § Tight patterns refusal.
// The leading `+` sits OUTSIDE the alternation: strtod parses a sign before
// INF/INFINITY too, so `timeout +inf <cmd>` is launchable and must not be a
// hole (review round 4 — e043d6).
const TIMEOUT_DURATION_RE =
  /^\+?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?)[smhd]?$/;

// Shell CONTROL KEYWORDS are transparent: the word after `then` / `do` / `else`
// IS a command, not an argument. Segments split on `;`, so `if true; then rm -f
// …` hands the detector a segment whose first token is `then` — and without this
// the real command behind it was out of command position and went unseen (plan
// 3752 review). It is the same for every pattern: `… ; then pnpm install` is an
// install. `!` and `{` are the other two transparent leaders in this family.
const CONTROL_KEYWORDS = new Set(['then', 'do', 'else', 'elif', '!', '{']);

// Is `tokenRe` matched by a token that occupies the segment's COMMAND position —
// i.e. everything before it is an env assignment or a wrapper?
// A wrapper's own OPTIONS (`env -i`, `sudo -E`, `pnpm --filter x`) sit between
// the wrapper and the runner and must not break the chain (review round 4).
// They cannot open a hole: a non-wrapper WORD like `node` still ends it.
// Everything before the runner must be an env assignment, a wrapper, a wrapper
// OPTION, or that option's VALUE. The value clause is what lets
// `pnpm --filter @vetapp/frontend exec vitest run` and `sudo -u user pnpm test`
// through (review round 5) without loosening the rule that a bare non-wrapper
// WORD ends the chain — which is what still keeps `node run.mjs --runner pytest`
// silent.
function prefixOk(toks, upTo) {
  // Set the moment a literal `timeout` token is accepted below and cleared the
  // moment its duration positional is consumed — NOT simply "was the previous
  // token literally `timeout`", because GNU timeout admits its own options
  // (`-k <dur>`, `-s <sig>`, `--foreground`, …) between the wrapper and its
  // duration (`timeout -k 30 900 <cmd>`). Those options are already accepted by
  // the ordinary dash/value branches below without touching this flag, so it
  // stays armed across them and is spent by the first token that actually looks
  // like a duration (plan 4140).
  let timeoutAwaitingDuration = false;
  for (let j = 0; j < upTo; j++) {
    const t = toks[j];
    const prev = j > 0 ? toks[j - 1] : '';
    // `-m`'s value is the MODULE python runs — it IS the command, not a wrapper
    // option value. `python -m pytest` is a pytest run; `python -m coverage
    // pytest` runs coverage and hands it the word pytest (review round 6).
    // Tested BEFORE the wrapper clause because a module name can itself be a
    // wrapper word: with the old ordering `python -m time pytest` and
    // `python -m run pytest` both read as pytest runs (review round 7).
    if (prev === '-m') return false;
    if (t === 'timeout') {
      timeoutAwaitingDuration = true;
      continue;
    }
    if (ENV_ASSIGN_RE.test(t) || WRAPPERS.has(t) || CONTROL_KEYWORDS.has(t) || t.startsWith('-'))
      continue;
    if (prev.startsWith('-') && !prev.includes('=')) continue; // this token is that flag's value
    // The duration positional is checked LAST, after the ordinary flag-value
    // branch above, so a value-taking timeout option's own value (`-k 30`) is
    // explained by THAT branch and never mistaken for the awaited duration —
    // only a bare token with no dash-flag in front of it can consume the slot.
    if (timeoutAwaitingDuration && TIMEOUT_DURATION_RE.test(t)) {
      timeoutAwaitingDuration = false;
      continue;
    }
    return false;
  }
  return true;
}

// The value-taking options of the wrappers above. Enumerated rather than
// assumed, exactly as GIT_VALUE_FLAGS is: treating EVERY flag as value-taking
// silently killed `env -i pnpm install` and `sudo -E pnpm test`, whose flags are
// booleans and whose next token really is the command. `-m` is absent on
// purpose — it takes a value, but that value IS the command, which prefixOk
// handles.
const WRAPPER_VALUE_FLAGS = new Set([
  '-u', // sudo --user
  '--user',
  '-c', // python/sh -c <script>
  '--filter', // pnpm
  '-C', // pnpm --dir
  '--dir',
  '-n', // nice --adjustment
  '--adjustment',
  '--prefix',
  // GNU timeout's own value-taking flags (`-k`/`--kill-after`, `-s`/`--signal`)
  // are deliberately NOT here (plan 4140, review round 1 — findings 05b879 /
  // 595db9 / 91a19e). This set is WRAPPER-AGNOSTIC: `isOptionValue` applies it
  // to every wrapper, and `-s`/`-k` are BOOLEAN options of `sudo` (--shell,
  // --reset-timestamp), so adding them silenced `sudo -s pytest <dir>` — a
  // shape that warns AND denies on master. They are not needed anyway:
  // prefixOk's generic "token after a dash-flag is that flag's value" branch
  // already carries `timeout -k 30 900 <cmd>` and `timeout -s KILL 900 <cmd>`
  // to the runner, which the tests pin. `--preserve-status`, `--foreground`
  // and `-v`/`--verbose` take no value and are transparent as plain options.
]);

// Is `toks[i]` the immediate VALUE of the option in front of it? A value is
// never a command, however much it looks like one — `sudo -u pytest …` names a
// user, `python -c 'pytest'` is a script body, `pnpm --filter test exec …` names
// a package (review round 7; all three warned before this).
// An `--opt=value` token carries its own value, so the token after it is a
// command again.
function isOptionValue(toks, i) {
  if (i === 0) return false;
  const prev = toks[i - 1];
  return WRAPPER_VALUE_FLAGS.has(prev) && !prev.includes('=');
}

// The index of the first token matching `tokenRe` at the segment's COMMAND
// position, or -1. Detectors that need to read what FOLLOWS the command (which
// script pnpm was handed, whether vitest got `run`) take the index; the boolean
// wrapper below is for the ones that only ask whether it is there at all.
export function commandTokenIndex(seg, tokenRe) {
  const toks = normTokensOf(seg);
  for (let i = 0; i < toks.length; i++) {
    if (tokenRe.test(toks[i]) && !isOptionValue(toks, i) && prefixOk(toks, i)) return i;
  }
  return -1;
}

export function atCommandPosition(seg, tokenRe) {
  return commandTokenIndex(seg, tokenRe) >= 0;
}

// ── cwd ──────────────────────────────────────────────────────────────────────
// A segment that IS a `cd` returns its target; the walk applies it and moves on.
// (Because segments are already split on separators, the target is simply the
// rest of the segment — no second separator scan, and no `)` to strip.)
function segmentCdTarget({ raw, scan }) {
  const m = scan.match(/^\s*cd\s+(?=\S)/);
  if (!m) return null;
  return stripQuotes(raw.slice(m[0].length)).replace(/\\/g, '/') || null;
}

function samePathFamily(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Is `cwd` this repo (or a worktree/subdir of it)? A pure path test — no git
// spawn — because both the repo root and every worktree live under REPO_ROOT by
// this project's convention (.claude/worktrees/<slug>).
export function isUnder(path, root) {
  const r = resolve(root);
  const p = resolve(path);
  if (samePathFamily(p, r)) return true;
  const sep = process.platform === 'win32' ? '\\' : '/';
  const prefix = r.endsWith('/') || r.endsWith('\\') ? r : r + sep;
  return samePathFamily(p.slice(0, prefix.length), prefix);
}

export function isInsideRepo(cwd, repoRoot = REPO_ROOT) {
  return isUnder(cwd, repoRoot);
}

export function isWorktreeCwd(cwd) {
  return /[\\/]\.claude[\\/]worktrees[\\/]/.test(String(cwd));
}

// The cwd left behind after the whole command — the fold below, run to the end.
// Exported for the tests that pin cd handling directly.
export function resolveCwd(cmd, payloadCwd, repoRoot = REPO_ROOT) {
  let dir = payloadCwd ? String(payloadCwd) : repoRoot;
  for (const seg of segmentPairs(cmd)) {
    const target = segmentCdTarget(seg);
    if (!target) continue;
    try {
      dir = resolve(dir, target);
    } catch {
      /* unparseable target — keep the current dir */
    }
  }
  try {
    return resolve(dir);
  } catch {
    return repoRoot;
  }
}

// ── pattern shapes ───────────────────────────────────────────────────────────
// A bare `test` SCRIPT token in a pnpm invocation: `pnpm test`, `pnpm run test`,
// `pnpm --filter @vetapp/backend test`. The negative lookahead keeps
// `test:queued` out — the token must be exactly `test` — while `test:e2e` is
// named explicitly, because it is the full Playwright suite (`package.json`
// `test:e2e` → `pnpm --filter @vetapp/frontend test:e2e` → `playwright test`)
// and the CLAUDE.md queue rule covers "any other heavy run".
// These read TOKENS, not the blanked segment text. The blanked view erases a
// quoted script name, so `pnpm run "test"` — a real heavy run — went unwarned
// while every other check had already moved to tokens (review round 7).
const PNPM_RE = /^pnpm$/;
const PNPM_HEAVY_SCRIPTS = new Set(['test', 'test:e2e']);
const VITEST_RE = /^vitest$/;
const PYTEST_RE = /^pytest$/;
const PNPM_INSTALL_SUBCOMMANDS = new Set(['install', 'i']);

// What pnpm ITSELF was asked to do: its subcommand, or — for `pnpm run <script>`
// — the script name. PARSED at its real position, never scanned for anywhere in
// the tail: a scan read the `install` in `pnpm exec playwright install
// --with-deps webkit` (.github/workflows/ci.yml) as pnpm's own install and told
// the operator to run install-main.mjs on a browser download (review round 8 —
// a false positive on a committed command, the exact failure this guard's
// tightness rule exists to prevent).
// pnpm's OWN value-taking options. Its short --filter alias `-F` is the one that
// mattered: `pnpm -F test install` filtered to a package called `test` warned as
// a heavy test run AND missed the install (review round 9).
const PNPM_VALUE_FLAGS = new Set([
  '--filter',
  '-F',
  '--filter-prod',
  '--dir',
  '-C',
  '--reporter',
  '--config',
  '--store-dir',
  '--child-concurrency',
  '--workspace-concurrency',
  '--use-node-version',
]);
// Subcommands that merely say "across packages" and then take the real target.
const PNPM_PASSTHROUGH = new Set(['recursive', 'multi', 'm']);

function pnpmTarget(toks, pnpmIndex) {
  let j = pnpmIndex + 1;
  const nextWord = () => {
    while (j < toks.length) {
      const t = toks[j];
      if (t.startsWith('-')) {
        j += (PNPM_VALUE_FLAGS.has(t) || WRAPPER_VALUE_FLAGS.has(t)) && !t.includes('=') ? 2 : 1;
        continue;
      }
      return toks[j++];
    }
    return null;
  };
  let word = nextWord();
  while (PNPM_PASSTHROUGH.has(word)) word = nextWord();
  // `run`'s target is a SCRIPT NAME, never a subcommand — `pnpm run install`
  // runs a package script that happens to be called install, and reading it as
  // pnpm's own install told the operator to go run install-main.mjs (review
  // round 9). The flag is what lets the install detector refuse it while the
  // test detector still accepts `pnpm run test`, which really is the suite.
  const fromRun = word === 'run';
  return { target: fromRun ? nextWord() : word, fromRun };
}

// A SINGLE-FILE target — the shape that makes a run ticket-free. For the JS
// runners the token must look like a TEST file (`*.test.ts`, `*.spec.mjs`), not
// merely any `.ts`: `vitest run --config vitest.config.ts` runs the whole suite
// and must not read as single-file. For pytest a `.py` path (optionally with a
// `::node` selector) is the target shape. The trailing `["']?` matters: these
// run against the RAW segment, where a quoted path's closing quote sits right
// after the extension.
const JS_TEST_FILE_ARG_RE = /\S+\.(?:test|spec)\.(?:m|c)?[jt]sx?(?::\d+)?["']?(?=\s|$)/;
const PY_FILE_ARG_RE = /\S+\.py(?:::[^\s"']*)?["']?(?=\s|$)/;

// A runner invoked for INFORMATION, not to run tests. Narrow on purpose:
// `--collect-only` was in this list and is NOT free — pytest collection imports
// the whole target tree (measured: 1133 tests through a live probe), so it
// competes with the land batteries exactly like a real run. `--fixtures` and
// `--markers` collect too, and are out for the same reason.
const TEST_INFO_FLAG_RE = /(?:^|\s)(?:--version|-V|--help|-h)(?=\s|$)/;

// The seed corpus, referenced either by its shard directory or by a shard
// filename — and the glob must sit ON that reference, in the SAME whitespace
// token. A single named shard read never fires, and an unrelated wildcard
// elsewhere in the command no longer drags one in.
// The seed shard tree, RESOLVED — the glob token is resolved against the cwd in
// effect and tested for membership, never matched as text. Two review rounds
// pushed it here: a text match on the path both MISSED the real corpus (the repo
// tracks thousands of record-shaped `<record>-NNN.json` files OUTSIDE the seed,
// under per-pass extract directories, which a bare filename-glob trigger
// false-fired on) and could be escaped by a `..` traversal that still contained
// the seed text. Resolution answers both at once, and it is what makes
// `cd <shard tree>/SE && ls <record>-*.json` fire while
// `ls <shard tree>/../extract/<record>-*.json` does not.
//
// plan 4172: the tree is coord.config.json's, never a literal here — `seedShardDir` joined with
// the LITERAL leading directory segments of `shardIdPattern` (the part before the first regex
// construct), so it is exactly the directory the per-record shard files live under. A project
// with no shard layout gets null, and the seed-walk detector stays silent.
export function seedShardTreeRel({ seedShardDir, shardIdPattern } = {}) {
  if (!seedShardDir) return null;
  const lead = [];
  for (const seg of String(shardIdPattern || '')
    .split('/')
    .slice(0, -1)) {
    if (!/^[\w.-]+$/.test(seg)) break;
    lead.push(seg);
  }
  return [seedShardDir, ...lead].join('/');
}

function configuredSeedShardTreeRel(repoRoot) {
  try {
    return seedShardTreeRel(loadCoordConfig(repoRoot));
  } catch {
    return null; // an unreadable config never blocks a Bash command — the detector just stays off
  }
}
// A glob token only counts as a PATH if it looks like one — a bare `*` from an
// unrelated flag value (`--ignore='*'`) must not resolve into a seed walk just
// because the cwd happens to be a shard dir.
const PATHISH_RE = /\.json$|[\\/]/i;
const GLOB_RE = /[*?]/;

// The three dotenv import shapes. NOT a bare `\bdotenv\b`: a command that
// merely names the word must stay silent.
const DOTENV_RE =
  /require\(\s*['"]dotenv['"]|import\s+[^;\n]*['"]dotenv['"]|import\s+dotenv(?=\s|$)|from\s+['"]dotenv['"]|from\s+dotenv\s+import/;

// A segment whose job is to PRINT or RECORD text, not to run anything. Its
// arguments are prose by definition, so no pattern may fire inside it.
// Recognised at COMMAND POSITION, so a wrapper or an env assignment in front
// (`env echo …`) does not smuggle prose past the skip (review round 3).
const PROSE_CMD_RE = /^(?:echo|printf)$/;
// Basename-matched, so a path-qualified `/usr/bin/git` is still git (round 5).
const GIT_RE = /(?:^|[\\/])git(?:\.exe)?$/i;
// git's own value-taking global options — needed to tell `git -C commit status`
// (subcommand `status`, a real command) from `git -C <dir> commit` (prose). The
// round-4 fixed-size token window got both of these wrong in opposite
// directions, so this parses the subcommand instead of guessing at a distance.
// `--super-prefix` is deliberately NOT here: the installed git (2.53) rejects it
// as an unknown option, so the only thing it could ever match is a command no
// shell would run — a parser branch whose test asserted an impossible input
// (review round 7).
const GIT_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);

function gitSubcommand(toks, gitIndex) {
  for (let j = gitIndex + 1; j < toks.length; j++) {
    const t = toks[j];
    if (GIT_VALUE_FLAGS.has(t)) {
      j++; // skip its value
      continue;
    }
    if (t.startsWith('-')) continue;
    return t;
  }
  return null;
}

function isGitCommitSegment(raw) {
  // The git token AT COMMAND POSITION, not merely the first one that matches:
  // a wrapper flag's VALUE can literally be `git` (`sudo -u git commit …`), and
  // parsing the subcommand from there reads the wrong command — which SUPPRESSED
  // a real warning, since prose is a skip (review rounds 6 and 7).
  const i = commandTokenIndex(raw, GIT_RE);
  return i >= 0 && gitSubcommand(normTokensOf(raw), i) === 'commit';
}

// Token walks read the RAW segment (the quote-aware tokenizer collapses a
// quoted span to one token, which is the same protection blanking gave and more
// precise); whole-segment REGEXES still read the blanked view.
const isProseSegment = ({ raw }) => atCommandPosition(raw, PROSE_CMD_RE) || isGitCommitSegment(raw);

// A segment whose job is to SEARCH text. An audit hunting for banned dotenv
// usage quotes the very import shape it is looking for; warning that it is
// "hand-rolling an env walk-up" is pure noise. Deliberately NOT applied to the
// seed pattern — a grep walking the whole shard corpus IS the hand-rolled walk
// that pattern exists to name.
const SEARCHER_RE = /^\s*(?:git\s+)?(?:grep|rg|ripgrep|ag|ack|findstr|select-string)\b/i;

// `rm` at command position, basename-matched like GIT_RE so a path-qualified
// `/bin/rm` still counts.
const RM_RE = /(?:^|[\\/])rm(?:\.exe)?$/i;
// A GIT LOCK basename, recognised on its own because these names are git's and
// nobody else's — `rm -f index.lock` run from inside the gitdir carries no
// `.git/` in the path at all, and that is exactly the shape the incident used.
// `next-index-*.lock` keeps its glob: the wildcard IS part of the hand-rolled
// form, and a token is never expanded here.
// Case-INSENSITIVE, like RM_RE: the Windows filesystem is, so `rm -f
// .git/INDEX.LOCK` deletes the real lock and must warn like any other spelling.
const GIT_LOCK_BASENAME_RE = /^(?:index\.lock(?:\.lock)?|next-index-[^\\/]*\.lock)$/i;
// Any OTHER `.lock` counts only when the path says `.git/` — `HEAD.lock`,
// `config.lock`, `refs/heads/x.lock` are all git locks there, while a
// `package.lock` somewhere else is not this hook's business.
const LOCK_SUFFIX_RE = /\.lock$/i;
const GIT_DIR_PATH_RE = /(?:^|\/)\.git(?:\/|$)/i;

// Deliberately keyed on `.lock`, which is what keeps the already-allow-listed
// `rm -f .git/objects/pack/tmp_pack_*` silent: a pack tmp file is a different
// crash leftover with a different (and sanctioned) recipe.
function isGitLockToken(tok) {
  const path = flagValue(stripQuotes(tok)).replace(/\\/g, '/');
  if (!path) return false;
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (GIT_LOCK_BASENAME_RE.test(base)) return true;
  return LOCK_SUFFIX_RE.test(base) && GIT_DIR_PATH_RE.test(path);
}

const PATTERNS = {
  'heavy-test-unqueued': {
    what: 'This looks like a heavy test run outside the queue.',
    tool: 'node scripts/queued-run.mjs <cmd...>   (backend suite: pnpm --filter @vetapp/backend test:queued)',
    doc: "your project's `CLAUDE.md` § Pre-commit / pre-land checks",
    exempt: ['queued-run.mjs', 'test:queued'],
  },
  'bare-main-install': {
    what: 'This looks like a bare pnpm install in the MAIN checkout.',
    tool: 'node scripts/install-main.mjs   (single-holder mutex + heals a torn node_modules/.pnpm store first)',
    doc: 'docs/coord/worktrees.md § The install lock',
    exempt: ['install-main.mjs'],
  },
  'seed-corpus-walk': {
    what: 'This looks like a hand-rolled wildcard walk over the seed record shards.',
    tool: '_pp_census_corpus (Python) / @vetapp/shared seed-io (TS/JS)',
    doc: "your project's `CLAUDE.md` — the seed source-of-truth rule: read/write ONLY through the seam",
    exempt: ['_pp_census_corpus', 'seed-io'],
  },
  'env-walk-up': {
    what: 'This looks like a hand-rolled env walk-up. There is no dotenv in this workspace — the import throws.',
    tool: "the project's own env loader (Node) / its Python twin — never a second hand-rolled walk-up",
    doc: "your project's `CLAUDE.md` § Secrets / env",
    exempt: ['hobby-env.mjs', '_load_env'],
  },
  'stale-lock-rm': {
    what: 'This looks like a hand-rolled rm of a stale git lock file.',
    tool: 'node scripts/clear-stale-worktree-lock.mjs   (removes a lock only when provably idle, never one a live op holds; from MAIN it sweeps every worktree — for a MAIN-checkout wedge the tool is node scripts/heal-main.mjs). Both forms are allow-listed, so they auto-approve where a raw rm cannot.',
    doc: 'docs/coord/worktrees.md § Stale index.lock self-heal',
    exempt: ['clear-stale-worktree-lock.mjs', 'heal-main.mjs'],
  },
  'review-debt-hand-mint': {
    what: 'This looks like a hand-minted review-debt follow-up plan.',
    tool: 'the review-findings parking tool (project-side): mints the follow-up plan from the recorded review sidecar AND dispositions every parked finding into it, in one write',
    doc: 'docs/coord/review.md § The calibration ladder',
    exempt: ['park-review-findings.mjs'],
  },
  'prettier-hand-check': {
    what: "This looks like a hand-run prettier --check/--write, which can silently examine ZERO of the files it was asked about and still report success (an ignored path exits 0; a path under another checkout's ignore files — e.g. a worktree path checked from the main checkout — is swallowed the same way).",
    tool: 'node scripts/prettier-check.mjs <paths…> [--allow-ignored]   (per-file prettier Node-API wrapper — reports IGNORED/CLEAN/DIRTY/MISSING per file, never a false clean)',
    doc: 'docs/runbooks/cloud-drain-landing.md (the hand-run prettier note)',
    exempt: ['prettier-check.mjs'],
  },
};

export const PATTERN_KEYS = Object.keys(PATTERNS);

// The union, kept as a named export for the test that pins the per-pattern
// scoping (and as the honest answer to "which tools does this hook know?").
export const EXEMPT_TOKENS = Object.values(PATTERNS).flatMap((p) => p.exempt);

// Read the RAW segment, never the blanked one: a seam is often invoked from
// INSIDE a quoted script body (`python -c "import _pp_census_corpus"`), and
// blanking would erase the very token that proves the sanctioned tool is in
// use. The failure direction is a missed warning, which is the safe one.
// FLAG tokens are excluded: `--label=seed-io` names the seam in a label, it does
// not invoke it, and letting it exempt turned a real seed walk silent (review
// round 3). Everything else is still a substring test on purpose — see the
// wontfix reasoning on the "exemptions match arbitrary substrings" finding.
// An ENV ASSIGNMENT is excluded for the same reason a flag is (plan 3752
// review): `LOCK_HELPER=clear-stale-worktree-lock.mjs rm -f .git/index.lock`
// NAMES the sanctioned tool in a variable and then hand-rolls the step anyway.
const exemptIn = ({ raw }, key) =>
  normTokensOf(raw)
    .filter((tok) => !tok.startsWith('-') && !ENV_ASSIGN_RE.test(tok))
    .some((tok) => PATTERNS[key].exempt.some((t) => tok.includes(t)));

// ── per-segment detectors ────────────────────────────────────────────────────
// Each takes one segment ({raw, scan}) and answers for THAT segment alone.

function isHeavyTestSegment(seg) {
  const { raw, scan } = seg;
  if (exemptIn(seg, 'heavy-test-unqueued')) return false;
  if (TEST_INFO_FLAG_RE.test(scan)) return false;
  const toks = normTokensOf(raw);
  // The single-file exemption reads the RAW segment so a quoted path survives.
  const pnpmAt = commandTokenIndex(raw, PNPM_RE);
  if (pnpmAt >= 0 && PNPM_HEAVY_SCRIPTS.has(pnpmTarget(toks, pnpmAt).target)) {
    return !JS_TEST_FILE_ARG_RE.test(raw);
  }
  const vitestAt = commandTokenIndex(raw, VITEST_RE);
  if (vitestAt >= 0 && toks[vitestAt + 1] === 'run') {
    return !JS_TEST_FILE_ARG_RE.test(raw);
  }
  if (atCommandPosition(raw, PYTEST_RE)) return !PY_FILE_ARG_RE.test(raw);
  return false;
}

function isInstallSegment(seg) {
  const { raw } = seg;
  if (exemptIn(seg, 'bare-main-install')) return false;
  const pnpmAt = commandTokenIndex(raw, PNPM_RE);
  if (pnpmAt < 0) return false;
  const { target, fromRun } = pnpmTarget(normTokensOf(raw), pnpmAt);
  return !fromRun && PNPM_INSTALL_SUBCOMMANDS.has(target);
}

// A glob applied TO the seed corpus: one whitespace token carrying both the
// seed reference and a wildcard. Read from the RAW segment, so a QUOTED glob
// path still counts (the prose-command skip is what keeps a commit message out,
// not blanking).
// `--out=<path>` carries a real path in its VALUE; classify that, not the whole
// `--flag=` token (review round 4).
// The value is unquoted in turn: `--out="…/records/*.json"` kept its leading
// quote and resolved outside the seed root (round 5). The name charset admits a
// dot so a dotted flag (`--out.dir=`) is stripped too.
const flagValue = (tok) => {
  const m = tok.match(/^--?[\w.-]+=(.*)$/);
  return m ? stripQuotes(m[1]) : tok;
};

function isSeedWalkSegment(seg, { dir, seedRoot }) {
  if (!seedRoot) return false; // plan 4172: no configured shard tree
  if (exemptIn(seg, 'seed-corpus-walk')) return false;
  return tokensOf(seg.raw).some((tok) => {
    // An ESCAPED wildcard is a literal character — the shell expands nothing, so
    // there is no walk to warn about (review round 8).
    if (!GLOB_RE.test(tok.includes('\\') ? stripEscapes(tok) : tok)) return false;
    const path = flagValue(stripQuotes(tok)).replace(/\\/g, '/');
    if (!path || !PATHISH_RE.test(path)) return false;
    try {
      return isUnder(resolve(dir, path), seedRoot);
    } catch {
      return false;
    }
  });
}

// DOTENV_RE reads the RAW segment — every shape it matches IS a quoted string.
function isEnvWalkSegment(seg) {
  const { raw, scan } = seg;
  if (exemptIn(seg, 'env-walk-up')) return false;
  if (SEARCHER_RE.test(scan)) return false;
  return DOTENV_RE.test(raw);
}

// A hand-minted review-debt follow-up plan: `next-plan-id.mjs claim` naming a `--slug
// review-debt-*` (plan 3967). Read directly off the TOKEN LIST rather than through
// commandTokenIndex/prefixOk's wrapper-chain machinery — `node` is not itself a recognized
// WRAPPER here (this repo's every other pattern targets a bare `pnpm`/`git`/`rm` sitting first),
// so a `node scripts/next-plan-id.mjs claim …` invocation's real command token sits one position
// AFTER a leader that chain cannot see through. A literal basename match on `next-plan-id.mjs`
// immediately followed by the literal token `claim`, plus an explicit `--slug review-debt-*`, is
// tight enough on its own — the false-positive floor a bare substring scan would risk is closed by
// requiring both anchors in the same segment, in this exact relative order.
const NEXT_PLAN_ID_RE = /(?:^|[\\/])next-plan-id\.mjs$/i;
const REVIEW_DEBT_SLUG_RE = /^review-debt-/i;

function isReviewDebtHandMintSegment(seg) {
  if (exemptIn(seg, 'review-debt-hand-mint')) return false;
  const toks = normTokensOf(seg.raw);
  const scriptIdx = toks.findIndex((t) => NEXT_PLAN_ID_RE.test(t));
  if (scriptIdx < 0 || toks[scriptIdx + 1] !== 'claim') return false;
  const slugIdx = toks.indexOf('--slug');
  if (slugIdx >= 0) {
    return REVIEW_DEBT_SLUG_RE.test(stripQuotes(toks[slugIdx + 1] ?? ''));
  }
  // plan 3967 fix round 1: the ATTACHED flag form (`--slug=<value>`) is just as valid argv as the
  // separated form above and must be caught the same way — `flagValue` already unwraps this exact
  // shape for isSeedWalkSegment, reused here rather than re-rolled.
  const attached = toks.find((t) => t.startsWith('--slug='));
  return attached ? REVIEW_DEBT_SLUG_RE.test(flagValue(attached)) : false;
}

// An `rm` whose TARGET LIST names a git lock. The command-position test is what
// keeps a mere mention out (`node scripts/<name>.mjs --keep rm index.lock` is not an
// rm), and the target walk skips FLAG tokens so `-f`/`--force` never counts.
function isStaleLockRmSegment(seg) {
  if (exemptIn(seg, 'stale-lock-rm')) return false;
  // The same target recogniser the deny classifier uses. The warn fires on ANY
  // git lock, whatever its scope — it only names a tool, so it does not need the
  // scope call the deny does. No variables here: a per-segment detector cannot
  // see an earlier line's assignment, and a lock BASENAME is already enough.
  return lockTargetsIn(seg, new Map()).length > 0;
}

// A hand-run `prettier --check`/`--write` (plan 4211): prettier's CLI can silently examine ZERO
// of the files it was asked about and still print the success sentence with exit 0 — an ignored
// path is swallowed with no warning, and any path under ANOTHER checkout's ignore files (a
// `.claude/worktrees/<slug>/…` file checked from the MAIN checkout, whose own
// `.gitignore`/`.prettierignore` swallow it) is silently skipped too. The automated land/push
// gates are unaffected (repo/worktree-root cwd, relative paths); this pattern is for the hand-run
// shape only. Five spellings recognised: bare `prettier`, `npx prettier`, `pnpm exec prettier`,
// `pnpm prettier`, and `node node_modules/prettier/bin/prettier.cjs` — the first four share one
// command-position lookup (`npx`/`pnpm`/`exec` are already WRAPPERS, so prefixOk's chain already
// carries them to a bare `prettier` token); the fifth is `node` at command position followed by a
// token naming that exact bin path.
const PRETTIER_RE = /(?:^|[\\/])prettier(?:\.cmd|\.exe)?$/i;
const PRETTIER_NODE_RE = /(?:^|[\\/])node(?:\.exe)?$/i;
const PRETTIER_CJS_PATH_RE = /(?:^|[\\/])node_modules[\\/]prettier[\\/]bin[\\/]prettier\.cjs$/i;
// Only `--check`/`--write` matter — a bare `prettier <file>` with neither flag only echoes the
// formatted file to stdout and asserts nothing, so it is not the false-green shape this warns
// about.
const PRETTIER_CHECK_OR_WRITE_RE = /(?:^|\s)(?:--check|--write)(?=[\s=]|$)/;

function isPrettierHandRunSegment(seg) {
  if (exemptIn(seg, 'prettier-hand-check')) return false;
  const { raw } = seg;
  if (atCommandPosition(raw, PRETTIER_RE)) return PRETTIER_CHECK_OR_WRITE_RE.test(raw);
  const nodeAt = commandTokenIndex(raw, PRETTIER_NODE_RE);
  if (nodeAt < 0) return false;
  const target = stripQuotes(normTokensOf(raw)[nodeAt + 1] ?? '').replace(/\\/g, '/');
  if (!PRETTIER_CJS_PATH_RE.test(target)) return false;
  return PRETTIER_CHECK_OR_WRITE_RE.test(raw);
}

// ── the stale-lock classifier, shared with worktree-guard.sh ─────────────────
// worktree-guard.sh DENIES this same shape (plan 3752 T4), and its first cut
// re-implemented the parsing in shell regexes — which promptly missed
// `command rm`, `/bin/rm`, a `\`-continuation, `if …; then rm`, and a
// backslash path, while its command-WIDE scope test denied a MAIN-checkout
// cleanup whose command merely mentioned a worktree path elsewhere (13 review
// findings, one root cause). Everything needed was already here: segmentation,
// command position, quote-aware tokens, exact lock basenames. So the shell hook
// calls THIS, and there is one parser, not two.

// The LEADING assignments of one segment, recorded into `vars` IN ORDER — the
// walk is per segment and interleaved with the rm reads below, never a
// pre-collected map of the whole command: shell order matters, and a global map
// applied a LATER writer's value to an EARLIER `rm` (review round 3).
// The DECLARATION KEYWORDS are transparent in front of them, because that is how
// this repo actually writes an assignment in a script (`export` in
// scripts/hooks/pre-push.sh), and so are the control keywords, so
// `… ; then GD=… ; rm …` is still read.
// The VALUE is unquoted: `GD="$root/x"` must store the path, not the quotes.
const ASSIGNMENT_PREFIXES = new Set(['export', 'local', 'declare', 'typeset', 'readonly']);

function recordAssignments(seg, vars) {
  for (const tok of normTokensOf(seg.raw)) {
    if (ASSIGNMENT_PREFIXES.has(tok) || CONTROL_KEYWORDS.has(tok)) continue;
    if (!ENV_ASSIGN_RE.test(tok)) break; // the leading run is over
    const eq = tok.indexOf('=');
    vars.set(tok.slice(0, eq), stripQuotes(tok.slice(eq + 1)));
  }
}

// `$NAME` / `${NAME}` against those assignments. Bounded depth, because one
// assignment routinely names another (`GD="$root/worktrees/x"`) and an
// unbounded walk would hang on a self-reference.
export function expandVars(text, vars, depth = 4) {
  let out = String(text ?? '');
  for (let i = 0; i < depth; i++) {
    const next = out.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (m, a, b) => (vars.has(a ?? b) ? vars.get(a ?? b) : m),
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

// Where a lock path lives, once expanded and slash-normalised. `worktree` is the
// only scope worktree-guard.sh denies: `clear-stale-worktree-lock.mjs` never
// touches the shared MAIN lock, so pointing a MAIN cleanup at it would name the
// wrong tool.
export function lockScopeOf(path) {
  const p = String(path ?? '').replace(/\\/g, '/');
  if (/(^|\/)\.git\/worktrees\//i.test(p)) return 'worktree';
  if (/(^|\/)\.git(\/|$)/i.test(p)) return 'gitdir';
  return 'unknown';
}

// One rm segment's git-lock TARGETS, expanded against the variables in effect.
// The single place a target is recognised — the warn detector and the deny
// classifier both call it, so the two hooks cannot disagree about what a lock is.
// Quote characters are dropped from the EXPANDED text, not just the token:
// `"$GD"/index.lock` expands to a path with a quote still sitting mid-string.
function lockTargetsIn(seg, vars) {
  const toks = normTokensOf(seg.raw);
  const rmAt = commandTokenIndex(seg.raw, RM_RE);
  if (rmAt < 0) return [];
  const out = [];
  for (const tok of toks.slice(rmAt + 1)) {
    if (tok.startsWith('-')) continue;
    const path = expandVars(flagValue(stripQuotes(tok)), vars).replace(/['"]/g, '');
    if (isGitLockToken(path)) out.push({ token: tok, path });
  }
  return out;
}

// Every git-lock TARGET of an `rm` at command position, each with its own scope.
// Per TARGET, not per command: `echo .git/worktrees/x && rm -f .git/index.lock`
// removes the MAIN lock and must not be judged by the unrelated mention.
//
// Accepted misses, all fail-SAFE (the warn-only pattern still fires, and the
// shell hook simply does not deny): a path built by COMMAND SUBSTITUTION
// (`GD=$(git rev-parse --git-dir)`) cannot be resolved without running it; a
// CWD-RELATIVE lock (`cd <gitdir> && rm -f index.lock`) carries no scope in its
// own text and is reported `unknown`; and `..` traversal is not normalised away.
export function staleLockRmHits(cmd) {
  const command = String(cmd ?? '');
  if (!command.trim()) return [];
  const vars = new Map();
  const hits = [];
  for (const seg of segmentPairs(command)) {
    recordAssignments(seg, vars); // in order: this segment's writers, then its reads
    if (isProseSegment(seg)) continue;
    for (const { token, path } of lockTargetsIn(seg, vars)) {
      hits.push({ token, path, scope: lockScopeOf(path) });
    }
  }
  return hits;
}

const DETECTORS = {
  'heavy-test-unqueued': isHeavyTestSegment,
  'bare-main-install': isInstallSegment,
  'seed-corpus-walk': isSeedWalkSegment,
  'env-walk-up': isEnvWalkSegment,
  'stale-lock-rm': isStaleLockRmSegment,
  'review-debt-hand-mint': isReviewDebtHandMintSegment,
  'prettier-hand-check': isPrettierHandRunSegment,
};

// Returns the pattern keys this command trips, in PATTERNS order. `[]` = silent.
// `seedTreeRel` (plan 4172): the repo-relative shard tree; omitted, it is read from the repo's own
// coord.config.json (a test passes it explicitly instead of standing up a config).
export function evaluate(cmd, { cwd = process.cwd(), repoRoot = REPO_ROOT, seedTreeRel } = {}) {
  const command = String(cmd ?? '');
  if (!command.trim()) return [];

  let dir = cwd ? String(cwd) : repoRoot;
  // Invariant per evaluation — resolved once, not per segment (review round 4).
  const treeRel = seedTreeRel === undefined ? configuredSeedShardTreeRel(repoRoot) : seedTreeRel;
  const seedRoot = treeRel ? resolve(repoRoot, treeRel) : null;
  const hits = new Set();

  for (const seg of segmentPairs(command)) {
    const target = segmentCdTarget(seg);
    if (target) {
      try {
        dir = resolve(dir, target);
      } catch {
        /* unparseable target — keep the current dir */
      }
      continue;
    }
    // vetapp-only (operator ruling): a sibling repo's install/test is not this
    // hook's business, and its tools are not the ones named above.
    if (!isInsideRepo(dir, repoRoot)) continue;
    if (isProseSegment(seg)) continue;

    for (const key of PATTERN_KEYS) {
      if (hits.has(key)) continue;
      // Worktree installs stay silent — they are lock-free by design, judged by
      // the cwd in effect for THIS segment.
      if (key === 'bare-main-install' && isWorktreeCwd(dir)) continue;
      if (DETECTORS[key](seg, { dir, repoRoot, seedRoot })) hits.add(key);
    }
  }

  return PATTERN_KEYS.filter((k) => hits.has(k));
}

export function formatWarning(hits) {
  const lines = ['⚠️  hand-rolled-step guard'];
  for (const key of hits) {
    const p = PATTERNS[key];
    if (!p) continue;
    lines.push(`   ${p.what}`);
    lines.push(`   vetapp owns a tool for this:  ${p.tool}`);
    lines.push(`   See ${p.doc}.`);
  }
  lines.push('   Proceed anyway if this is genuinely a one-off.');
  return lines.join('\n');
}

// One line per firing: ISO timestamp + pattern key. Best-effort — a failed
// append must never affect the warning or the exit code. `logPath` is a test
// seam (and the HAND_ROLLED_GUARD_LOG env override its spawn-test equivalent)
// so a test run never pollutes the real machine log.
export function logFirings(
  hits,
  { logPath = process.env.HAND_ROLLED_GUARD_LOG || FIRING_LOG, now = new Date() } = {},
) {
  if (!hits.length) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, hits.map((k) => `${now.toISOString()} ${k}\n`).join(''));
  } catch {
    /* best-effort measurement; never breaks the turn */
  }
}

// The hook's whole outcome as DATA (plan 4238): the warn envelope it would print, or
// null for silence. The firing-log append is a side effect it still performs itself
// (same as before the fold). The in-process PreToolUse dispatcher (pretool-dispatch.mjs)
// calls this; main() below is a thin CLI wrapper that prints it.
export function evaluateHook(payload) {
  const cmd = String(payload?.tool_input?.command ?? '');
  if (!cmd) return null;

  const hits = evaluate(cmd, { cwd: payload?.cwd ?? process.cwd() });
  if (!hits.length) return null;

  logFirings(hits);
  // The SHARED injection envelope (loader-common), not a private copy of its
  // shape — a future change to the contract then lands in one place.
  return injectionEnvelope(
    formatWarning(hits),
    `⚠️  hand-rolled-step guard: ${hits.join(', ')}`,
    'PreToolUse',
  );
}

function main() {
  return runHookCli(evaluateHook);
}

// CLI mode for worktree-guard.sh (plan 3752 T4): same PreToolUse payload on
// stdin, prints one JSON line of the stale-lock hits. A flag on this file rather
// than a second entry point, so the shell hook cannot drift from the parser.
function classifyMain() {
  const raw = readStdin();
  let cmd = '';
  try {
    cmd = String(JSON.parse(raw)?.tool_input?.command ?? '');
  } catch {
    cmd = '';
  }
  process.stdout.write(JSON.stringify({ hits: staleLockRmHits(cmd) }));
}

// ── the unqueued-pytest-sweep classifier, shared with worktree-guard.sh ─────
// (plan 3969, T2 — the twin of the stale-lock classifier above). A serial
// whole-directory pytest sweep was measured (plan 3941) running four times at
// ~40 minutes each through an UNWRAPPED `python -m pytest <dir>`, while the
// push gate printed the parallel form (`-n 9 --dist loadfile`, ~8 minutes) in
// the very same session. WARNing is not enough — this hook's own contract is
// WARN-never-DENY — so the block lives in worktree-guard.sh, the hook that
// already matches Bash and already emits denies; this file supplies the ONE
// parser both hooks share, exactly as staleLockRmHits does for pattern 5.
//
// Reuses the same command-position recogniser as isHeavyTestSegment
// (`atCommandPosition`/`commandTokenIndex` against PYTEST_RE) and the segment
// walk `evaluate` already does (cd tracking, in-repo check, prose skip) — one
// recogniser for "is this pytest at command position", not a second copy that
// could disagree. What counts as a single-file run is shared with
// isHeavyTestSegment too: both read PY_FILE_ARG_RE against the raw text. Fix
// rounds 1 and 2 tried a stricter, deny-only rule (a per-token walk, then a
// filesystem-resolved one) and both were reverted — see the comment on
// pytestSweepHitInText below for the measured reason. TEST_INFO_
// FLAG_RE (`--version`/`--help`) is kept too: `pytest --version` collects
// nothing and must not be denied, the same reason isHeavyTestSegment excludes
// it — read from the quote-blanked `scan`, per R3 below.
//
// Deliberately NOT reusing exemptIn(seg, 'heavy-test-unqueued') — that check
// exempts a MENTION of the string "queued-run.mjs" anywhere in the segment's
// tokens, which is the right call for a warning (naming the tool once is
// enough) but the wrong one for a deny. It is also unnecessary here: the
// wrapped form `node scripts/queued-run.mjs -- python -m pytest <dir>` is
// already excluded on STRUCTURAL grounds — `node` is not in WRAPPERS, so
// prefixOk fails at its very first token and `pytest` never reaches command
// position — while a hand-rolled sweep that merely NAMES the wrapper in a
// `--label` or a comment must still be denied.
// A pytest-shaped SEGMENT is sweep-shaped: pytest at command position, no
// info-only flag, and no `.py` argument anywhere in the segment.
//
// This is the plan's PINNED predicate, and rounds 1 and 2 are the argument for
// staying on it. The predicate has ONE known miss-shape — a segment that names
// a `.py` file AND sweeps (`pytest <dir> <file.py>`, `--ignore <x.py>`,
// `> out.py`, `-k foo.py`) reads as "single-file" and is allowed. Round 1
// tightened it to a per-token walk and round 2 to a filesystem-resolved walk;
// each round closed that miss and opened a NEW batch of shell-semantics
// findings (option values, redirect operands, quoting, `$VAR` expansion,
// subshell `cd`, concatenated quoted words), because deciding what pytest will
// actually collect from a raw command string is a job for a shell, not a
// regex. Twenty-odd land-blocking findings over two rounds, several of them
// FALSE DENIES of legitimate single-file runs (`pytest "$TEST_DIR/test_x.py"`,
// `cd missing-dir; pytest <file>.py`).
//
// The asymmetry decides it. A MISS costs one serial sweep — the warn still
// fires, the wrapper still injects whenever it is used, and the operator
// still gets the parallel shape from `queued-run.mjs`. A FALSE DENY parks an
// unattended session on a permission prompt nobody can approve. So this
// classifier fails OPEN on everything it cannot decide from the segment text
// alone, and the miss-shapes above are accepted, documented gaps rather than
// defects to iterate on. (The 16+-bare-file disagreement with the wrapper that
// the plan already records is the same kind of gap.)
//
// R3 (finding e4f696) is kept, and is the one place `seg.scan` — the
// quote-blanked view — is read instead of `seg.raw`: the WARN-only
// isHeavyTestSegment above already tests `scan`, and this classifier had
// drifted to the unblanked `raw`, so a `--version`/`-V`/`--help`/`-h` token
// sitting INSIDE a quoted argument value (e.g. `-k "... --help ..."`) falsely
// exempted a real sweep. The `.py` test deliberately stays on `raw`: blanking
// quotes there would hide a quoted `"test_x.py"` and turn a legitimate
// single-file run into a false deny — the exact failure this function is
// written to avoid.
function pytestSweepHitInText(seg) {
  if (TEST_INFO_FLAG_RE.test(seg.scan)) return false;
  if (PY_FILE_ARG_RE.test(seg.raw)) return false;
  return commandTokenIndex(seg.raw, PYTEST_RE) >= 0;
}

// R1 (fix round 2): back to the plan's PINNED design — reuse evaluate()'s own
// segment walk, prose-segment skip included. Fix round 1 added a scan of
// command-SUBSTITUTION contents ($( … ) / backtick) BEFORE the prose skip, to
// catch `echo "$(pytest backend/scripts)"` (the substitution runs regardless
// of whether the segment around it merely prints). That hand-rolled
// approximation of shell substitution parsing drew thirteen land-blocking
// findings of its own — catching the shape properly needs a real shell
// lexer, and a hand-rolled one risks a false DENY, which parks an unattended
// session on a prompt nobody can approve. That trade is deliberate: a pytest
// sweep hidden inside a command substitution is NOT denied by this
// classifier. Accepted, documented gap — not iterated on further here.
export function unqueuedPytestSweepHits(cmd, { cwd = process.cwd(), repoRoot = REPO_ROOT } = {}) {
  const command = String(cmd ?? '');
  if (!command.trim()) return [];

  let dir = cwd ? String(cwd) : repoRoot;
  const hits = [];

  for (const seg of segmentPairs(command)) {
    const target = segmentCdTarget(seg);
    if (target) {
      try {
        dir = resolve(dir, target);
      } catch {
        /* unparseable target — keep the current dir */
      }
      continue;
    }
    // vetapp-only, same as evaluate(): a sibling repo's pytest run is not
    // this hook's business.
    if (!isInsideRepo(dir, repoRoot)) continue;
    if (isProseSegment(seg)) continue;
    if (pytestSweepHitInText(seg)) hits.push({ segment: seg.raw.trim() });
  }

  return hits;
}

// CLI mode for worktree-guard.sh (plan 3969 T2), twinning `--stale-lock-rm-json`
// above: same PreToolUse payload on stdin, prints the unqueued-pytest-sweep
// hits. `cwd` is read from the payload (the segment walk needs it for `cd`
// tracking and the in-repo check), falling back to this process's cwd exactly
// as `main()` does for the warn path.
function classifyUnqueuedPytestSweepMain() {
  const raw = readStdin();
  let cmd = '';
  let cwd;
  try {
    const payload = JSON.parse(raw);
    cmd = String(payload?.tool_input?.command ?? '');
    cwd = payload?.cwd;
  } catch {
    cmd = '';
  }
  process.stdout.write(
    JSON.stringify({ hits: unqueuedPytestSweepHits(cmd, { cwd: cwd ?? process.cwd() }) }),
  );
}

// ── the unqueued-heavy-single-test-file classifier, shared with worktree-guard.sh
// (plan 4241) ────────────────────────────────────────────────────────────────
// A KNOWN-heavy `node --test <file>` run currently passes through no wrapper at
// all — single-file runs are ticket-free BY RULE (vetapp/CLAUDE.md § Pre-commit
// / pre-land checks: "Single-file runs stay ticket-free"), which is right for a
// 5s file and wrong for one measured at 1,499,615 ms
// (scripts/pre-push-hook.test.mjs, before plan 4228 shrank it). Session // dangling-ok: dated measurement of a project test file
// decisions S1-S7 on plan 4241 are the design record; this comment only
// restates what a reader of THIS classifier needs.
//
// THE LIST IS DATA, NEVER HAND-TYPED HERE (S1). `heavyPaths` — a Set of
// repo-relative PATHS (normalized: backslashes to `/`, a leading `./`
// stripped), not basenames — comes from scripts/coord/heavy-test-files.json,
// which scripts/heavy-test-files.mjs regenerates from the battery ledger's
// measured `durationMs` values. This module never decides what counts as
// heavy; it only matches a command shape against whatever the list currently
// says.
//
// MATCH SHAPE (S4, mirrors pytestSweepHitInText's own tightness discipline —
// prefer a MISS to a false DENY, the plan-3969 lesson): a segment whose
// command token is `node` (node flags before `--test` are transparent,
// INCLUDING the separate value token of a known value-taking node option
// written without `=` — `-r`/`--require`, `--import`, `--loader`,
// `--experimental-loader`, `--env-file(-if-exists)`, `-C`/`--conditions`,
// `--input-type`, `--inspect-port`, `--title`, `--stack-size`, see
// NODE_VALUE_FLAGS below — so `node --require preload.cjs --test <file>`
// still reaches `--test` instead of stopping at `preload.cjs` as a positional
// [findings 09455b/abec6a]; a non-flag, non-value, non-`--test` token there
// still means node's first positional is a script path, not the `--test`
// flag itself, which is also what structurally excludes the wrapped form: in
// `node scripts/queued-run.mjs -- node --test <file>` the OUTER `node`'s
// first positional is `scripts/queued-run.mjs`, so it never reaches the
// literal `--test` token and the classifier reports no hit for that command
// position — no name-based exemption needed, same structural trick
// unqueuedPytestSweepHits already relies on for its own wrapped form), the
// literal token `--test`, then (after any further flags — an inner
// `--test-reporter=…`, another node flag, OR the separate value token of a
// value-taking `--test-*`/node option, see NODE_TEST_VALUE_FLAGS below, which
// is skipped rather than compared to the list [finding b64789] —
// `--test-name-pattern pre-push-hook.test.mjs scripts/light.test.mjs` must // dangling-ok: illustrative project test names
// not deny `light.test.mjs` on the strength of the PATTERN's value) an
// argument whose repo-relative PATH — not its basename — matches a listed
// heavy file [findings ee6714/147420: two files sharing a basename in
// different directories, e.g. scripts/coord/land/registry.test.mjs vs.
// scripts/fb-responder/registry.test.mjs, must not be conflated]. The // dangling-ok: illustrative project test name
// argument matches when it is RESOLVED against the command's own working
// directory and then made relative to that checkout's toplevel (the worktree
// root when `dir` sits under `.claude/worktrees/<slug>`, the main repoRoot
// otherwise), and that relative path (posix separators) equals a listed path
// EXACTLY and does not escape the toplevel (round-2 review: a suffix-only
// match at :1492 let an unrelated path merely ENDING in a listed path false-
// DENY, e.g. `unrelated/scripts/coord/land/registry.test.mjs` or an absolute
// path outside the repo that happens to end in a listed suffix; :1539 — a
// relative target is now resolved against the tracked cwd, not compared as
// raw text; :1573 — an absolute target outside the checkout now fails the
// relative-path check instead of being treated as a repo heavy test). A bare
// basename typed from inside the wrong directory does NOT match and stays
// allowed (fail open, not a false DENY); so does anything that throws while
// resolving (unknown cwd/toplevel). `$( … )`, a glob-hidden target, `vitest`,
// and the backend suite all stay allowed — none of them match this shape at
// all.
//
// FAIL OPEN, same direction as the list load below: a heavy list of ZERO
// paths (not yet regenerated, or genuinely measured empty per S7) means
// this classifier never fires — checked first, before spawning the segment
// walk, so an empty list costs nothing per call.
const NODE_RE = /^node$/;

// Node options that take a value in a SEPARATE token (never just `=value`) —
// enumerated per current Node CLI docs, the same "list the known shapes,
// don't invent a general next-token-is-a-value rule" discipline
// WRAPPER_VALUE_FLAGS above already uses. Not exhaustive: a value-taking flag
// missing here only widens the pre-`--test` MISS (finding 09455b/abec6a is a
// documented, acceptable miss direction), it never causes a false DENY.
const NODE_VALUE_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '--env-file-if-exists',
  '-C',
  '--conditions',
  '--input-type',
  '--inspect-port',
  '--title',
  '--stack-size',
]);

// `--test-*` options that take a value in a separate token (finding b64789):
// skipped post-`--test` so the VALUE is never compared to the heavy list.
const NODE_TEST_VALUE_FLAGS = new Set([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-concurrency',
  '--test-timeout',
  '--test-shard',
  '--test-isolation',
  '--test-coverage-include',
  '--test-coverage-exclude',
]);

// scripts/coord/heavy-test-files.json — read fresh on every hook invocation
// (this repo's existing convention for small hook-time config; see
// configuredSeedShardTreeRel above for the same shape over coord.config.json).
// A PreToolUse hook process is one-shot, so there is no staleness to manage.
// FAIL OPEN on every doubt: a missing file (not yet regenerated), an
// unreadable one, malformed JSON, or a non-array `files` all yield an EMPTY
// Set — which unqueuedHeavyTestFileHits below reads as "nothing is heavy",
// never as an error to surface. PATHS, not basenames (findings ee6714/147420):
// normalized to forward slashes with any leading `./` stripped, since that is
// the one normalisation the loader owns and heavyTestFileHitInSegment's match
// is now on the full repo-relative path.
// `HEAVY_TEST_FILES_JSON_OVERRIDE` is a test seam (mirrors the
// `HAND_ROLLED_GUARD_LOG` override `logFirings` already uses) so a shell-level
// worktree-guard.test.mjs case can point the CLI classifier at a fixture list
// without mutating the real, ship-empty committed JSON.
function normalizeHeavyPath(p) {
  const s = String(p).replace(/\\/g, '/');
  return s.startsWith('./') ? s.slice(2) : s;
}

function loadHeavyTestFilePaths(repoRoot) {
  const path =
    process.env.HEAVY_TEST_FILES_JSON_OVERRIDE ||
    join(repoRoot, 'scripts', 'coord', 'heavy-test-files.json');
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const files = Array.isArray(raw?.files) ? raw.files : [];
    return new Set(
      files.filter((f) => typeof f === 'string' && f.length > 0).map(normalizeHeavyPath),
    );
  } catch {
    return new Set(); // missing/unreadable/malformed ⇒ fail open, nothing is heavy
  }
}

// The git toplevel for `dir` (round-2 review, :1539/:1573): a worktree's
// toplevel is the worktree root itself, never the outer main-checkout
// repoRoot, mirroring what `git rev-parse --show-toplevel` would report from
// inside that worktree — this repo's worktrees live at a fixed convention,
// `<repoRoot>/.claude/worktrees/<slug>` (the same convention `isWorktreeCwd`/
// `isUnder` already rely on), so the toplevel is derived from that fixed
// shape with pure path text, no git spawn. A `dir` NOT under `.claude/
// worktrees/` (the main checkout, or anywhere else) uses `repoRoot` as-is.
function toplevelFor(dir, repoRoot) {
  const norm = String(dir).replace(/\\/g, '/');
  const m = norm.match(/^(.*[\\/]\.claude[\\/]worktrees[\\/][^\\/]+)(?:[\\/]|$)/);
  return resolve(m ? m[1] : repoRoot);
}

// Does argument text `argPath`, RESOLVED against the command's own working
// directory `dir` and then made relative to `toplevel`, name one of the
// listed heavy paths? A hit requires the relative path (posix separators) to
// equal a listed path EXACTLY and to not escape `toplevel` (a leading `..`,
// or — the cross-drive-on-Windows case `path.relative` returns as an
// unrelated absolute path — `isAbsolute`). Round-2 review: the old
// suffix-only match (`argPath.endsWith('/' + listed)`) let an unrelated path
// merely ENDING in a listed path false-DENY (:1492, two findings — an
// unrelated repo-relative path, or an absolute path outside the checkout
// that happens to share a listed suffix) and never resolved a relative
// target against the tracked cwd at all (:1539). ANY failure to resolve
// (bad path text, `dir`/`toplevel` unknown) fails OPEN, same direction as
// every other doubt in this file.
function matchesHeavyPath(argPath, dir, toplevel, heavyPaths) {
  if (!dir || !toplevel) return false;
  try {
    const abs = resolve(dir, argPath);
    const rel = relative(toplevel, abs).replace(/\\/g, '/');
    // Round-3 review: escape means a whole `..` SEGMENT, not any name starting with two dots.
    if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      return false;
    // Round-3 review: Windows paths are case-insensitive, so `SCRIPTS/X.TEST.MJS` must still hit.
    // Compared case-insensitively everywhere — a false DENY would need two tracked files that
    // differ only in case, which a Windows-worked repo cannot hold.
    const key = rel.toLowerCase();
    for (const p of heavyPaths) if (p.toLowerCase() === key) return true;
    return false;
  } catch {
    return false; // fail open — malformed path text, never a false DENY
  }
}

// One segment's own match against S4's pinned shape. Reads the RAW segment's
// quote-aware tokens (normTokensOf), same as pytestSweepHitInText's sibling
// detectors — a quoted file argument must still match. `dir` is the cwd this
// segment runs from (the walk's own cd-tracking in unqueuedHeavyTestFileHits
// below) and `repoRoot` is the outer main-checkout root; `toplevelFor` turns
// those into the checkout whose heavy-list paths the argument is compared
// against.
function heavyTestFileHitInSegment(seg, heavyPaths, dir, repoRoot) {
  if (heavyPaths.size === 0) return false;
  const toplevel = toplevelFor(dir, repoRoot);
  const toks = normTokensOf(seg.raw);
  const nodeAt = commandTokenIndex(seg.raw, NODE_RE);
  if (nodeAt < 0) return false;
  let i = nodeAt + 1;
  let sawTestFlag = false;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t === '--test') {
      sawTestFlag = true;
      i++;
      break;
    }
    if (t.startsWith('-')) {
      // A value-taking node option written WITHOUT `=` consumes the next
      // token too, so it is never mistaken for node's first positional
      // (findings 09455b/abec6a).
      if (!t.includes('=') && NODE_VALUE_FLAGS.has(t)) i++;
      continue;
    }
    // A positional token before `--test` ever appears: node's first argument
    // is not the test flag (a script path, e.g. the wrapped form's
    // `scripts/queued-run.mjs`) — not this shape.
    return false;
  }
  if (!sawTestFlag) return false;
  for (; i < toks.length; i++) {
    const raw = toks[i];
    if (raw.startsWith('-')) {
      // Skip the separate value token of a value-taking `--test-*`/node
      // option so its VALUE is never compared to the heavy list (finding
      // b64789). An `--opt=value` form already carries its own value, so it
      // never consumes the following token.
      if (!raw.includes('=') && (NODE_TEST_VALUE_FLAGS.has(raw) || NODE_VALUE_FLAGS.has(raw))) {
        i++;
      }
      continue;
    }
    const argPath = stripQuotes(raw);
    if (matchesHeavyPath(argPath, dir, toplevel, heavyPaths)) return true;
  }
  return false;
}

// Same segment-walk contract as unqueuedPytestSweepHits: cd-tracking,
// vetapp-only (a sibling repo's test run is not this hook's business), prose
// segments skipped. `heavyPaths` is an injectable override for tests (mirrors
// `seedTreeRel` on `evaluate()`) — a Set of normalized repo-relative PATHS,
// not basenames (findings ee6714/147420); omitted, it is loaded fresh from
// the repo's own scripts/coord/heavy-test-files.json.
export function unqueuedHeavyTestFileHits(
  cmd,
  { cwd = process.cwd(), repoRoot = REPO_ROOT, heavyPaths } = {},
) {
  const command = String(cmd ?? '');
  if (!command.trim()) return [];
  const paths = heavyPaths ?? loadHeavyTestFilePaths(repoRoot);
  if (paths.size === 0) return [];

  let dir = cwd ? String(cwd) : repoRoot;
  const hits = [];

  for (const seg of segmentPairs(command)) {
    const target = segmentCdTarget(seg);
    if (target) {
      try {
        dir = resolve(dir, target);
      } catch {
        /* unparseable target — keep the current dir */
      }
      continue;
    }
    if (!isInsideRepo(dir, repoRoot)) continue;
    if (isProseSegment(seg)) continue;
    if (heavyTestFileHitInSegment(seg, paths, dir, repoRoot))
      hits.push({ segment: seg.raw.trim() });
  }

  return hits;
}

// CLI mode for worktree-guard.sh (plan 4241), twinning `--unqueued-pytest-sweep-json`
// above: same PreToolUse payload on stdin, prints the unqueued-heavy-test-file hits.
function classifyUnqueuedHeavyTestMain() {
  const raw = readStdin();
  let cmd = '';
  let cwd;
  try {
    const payload = JSON.parse(raw);
    cmd = String(payload?.tool_input?.command ?? '');
    cwd = payload?.cwd;
  } catch {
    cmd = '';
  }
  process.stdout.write(
    JSON.stringify({ hits: unqueuedHeavyTestFileHits(cmd, { cwd: cwd ?? process.cwd() }) }),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv[2] === '--stale-lock-rm-json') classifyMain();
    else if (process.argv[2] === '--unqueued-pytest-sweep-json') classifyUnqueuedPytestSweepMain();
    else if (process.argv[2] === '--unqueued-heavy-test-json') classifyUnqueuedHeavyTestMain();
    else await main();
  } catch {
    // fail open — a tool hook must never break the turn
  }
  process.exit(0);
}
