#!/usr/bin/env node
// scripts/hooks/land-timeout-guard.mjs — PreToolUse hook (plan 3452).
//
// DENIES a land invocation whose inner `timeout` cap is not the ONE sanctioned number.
//
// § WHY. Operator ruling 2026-08-24, verbatim: "I don't want random choices for the
// timeout." The ruling is committed in two runbooks —
// docs/runbooks/branch-hygiene.md § Kill-safety rules and
// coord/skills/done-worktree/SKILL.md § "The invocation shape is FIXED" — and BOTH are
// prose that nothing enforced. Five misfires in two days, every one a number sized to the
// job by eye:
//   2026-08-24  push, 900 s under a 1500 s wrapper  → push killed mid-gate
//   2026-08-24  land, undersized                    → land SIGTERM'd at 56 min
//   2026-08-24  plan 3407, `timeout 3400`           → land killed mid-pytest
//   2026-08-25  plan 3415, `timeout 560`            → land killed mid-pytest
//   2026-08-25  plan 3415, `timeout 1800`           → knowingly undersized, self-killed
// Measured pytest-preflight durations run 1153–3400 s and the longest recorded full land
// is 3635 s, so any "looks about right" number under an hour is a coin flip.
//
// § DENY, not warn — deliberately. hand-rolled-step-guard.mjs warns and is routinely
// proceeded past; this failure mode has already survived TWO committed prose statements,
// so a warning is the option that has demonstrably failed. Every block message quotes the
// ruling verbatim, names the one correct number, and prints the copy-paste invocation
// line, so clearing it is mechanical rather than a reading exercise.
//
// § THE VERDICT MATRIX — mirrors the SKILL.md table so there is ONE contract to keep in
// step. Environment is classified from an INJECTED env object + the payload, never from
// ambient process state, so every branch is a test parameter (vetapp/CLAUDE.md's
// platform-parameter rule).
//
//   LOCAL top-level  (no agent_id, CLAUDE_CODE_REMOTE unset)
//     land with `timeout 14400` (or `4h`)  → ALLOW
//     land with any other `timeout N`      → DENY  local-wrong-land-cap
//     land with no inner `timeout` at all  → DENY  local-missing-land-cap
//     backgrounded `git push` + a wrong inner cap → DENY  local-wrong-push-cap
//   CLOUD drain sandbox  (CLAUDE_CODE_REMOTE === 'true', no agent_id)
//     land in the foreground, no inner `timeout` → ALLOW
//     land carrying ANY inner `timeout`          → DENY  cloud-inner-land-timeout
//   DISPATCHED SUBAGENT  (agent_id present, either environment)
//     → SILENT, always. Full defer to subagent-backgrounding-guard.mjs (plan 3116),
//       which already owns the subagent shape. Emitting here too would double-police one
//       rule from two files with no way to keep their polarity in step.
//
// § WHAT THIS GUARD DELIBERATELY DOES NOT POLICE.
//   - Whether a LOCAL land is BACKGROUNDED. That is the backgrounding mandate, owned by
//     the two existing guards; this plan enforces the CAP. A foreground `timeout 14400`
//     land passes here (and is caught, if at all, elsewhere).
//   - The value 14400 itself. It is an operator ruling; this file enforces it and never
//     re-opens it.
//   - A `git push` with NO inner cap. Plan 3452's scoped-down trigger: firing on a bare
//     push would need `git diff --name-only origin/master...HEAD` to tell a gate-running
//     push from a docs push — a git subprocess on the PreToolUse path of every push, with
//     worktree/detached-HEAD resolution as its brittle half. Four of the five measured
//     incidents were LANDS. So the push half fires only on the unambiguous shape: a
//     BACKGROUNDED push that already carries an inner cap (by definition the gate-running
//     form) whose number is not 14400. Zero git subprocess, no false-positive surface.
//
// § WHY A SEPARATE FILE, not a branch inside either existing guard. Their shared header
// documents OPPOSITE polarity on the same `run_in_background` payload shape (a top-level
// CLOUD session warns where a LOCAL one must stay silent). Folding means re-deriving that
// polarity table on every future edit — plan 3248 made the same call for the same reason.
//
// § FAIL-OPEN, unconditionally. Any internal error — a malformed payload, an unparseable
// command, a thrown exception — ALLOWS. A hook crash that blocks unrelated Bash commands
// across 5–7 parallel sessions is strictly worse than the misfire it polices. The whole
// verdict runs inside a try/catch that exits 0 with no output on a throw;
// LAND_TIMEOUT_GUARD_FORCE_ERROR=1 is the test seam that exercises exactly that path.
//
// Bash only. PowerShell has no GNU `timeout`, so its command text carries nothing this
// guard could grade.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentId, readStdin } from './lib/loader-common.mjs';
// plan 3960 (coord-core step 2): the ONE number is now `land.localTimeoutSeconds`
// (coord.config.json), defaulting to today's exact 14400 — see resolveLandTimeoutSeconds below.
import { loadCoordConfig } from '../coord/coord-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// This hook always runs FROM the main checkout (a worktree's own coord.config.json must never
// be consulted here — no worktree config may be loaded before a land even starts), so its own
// dirname two levels up IS the main checkout root, the same REPO_ROOT-from-dirname idiom every
// other scripts/hooks/*.mjs module already uses (chain-wiki-loader.mjs, hand-rolled-step-guard.mjs, …).
const REPO_ROOT = join(HERE, '..', '..');

// Operator ruling 2026-08-24; out of scope to change here. The number itself still comes from
// coord.config.json's `land.localTimeoutSeconds` (default: this exact value) — see
// resolveLandTimeoutSeconds's fail-open contract below (plan 3452: never block on a config
// read error, not even at module load).
const FALLBACK_LAND_TIMEOUT_SECONDS = 14400;

// `repoRoot`/`loadConfig` are parameters (defaulting to the real REPO_ROOT / loadCoordConfig)
// purely for testability — a test can inject a throwing `loadConfig` or a fabricated config
// object to exercise the fail-open path without touching the real on-disk coord.config.json.
export function resolveLandTimeoutSeconds(repoRoot = REPO_ROOT, loadConfig = loadCoordConfig) {
  try {
    const seconds = loadConfig(repoRoot).land.localTimeoutSeconds;
    if (Number.isSafeInteger(seconds) && seconds > 0) return seconds;
  } catch {
    // fail open — plan 3452 contract: a config-read error must never block a land
  }
  return FALLBACK_LAND_TIMEOUT_SECONDS;
}

export const LAND_TIMEOUT_SECONDS = resolveLandTimeoutSeconds();

export const OPERATOR_RULING = "I don't want random choices for the timeout.";

// Verbatim from coord/skills/done-worktree/SKILL.md § The invocation shape is FIXED. The cap
// is interpolated rather than typed twice, so the printed fix can never drift from the number
// the guard actually enforces. plan 3781 T4: tees the full run to `.scratch/land-<slug>.log`
// (relative — the invocation runs from the main checkout, where the sidecars already live;
// `.scratch/` is gitignored) so the failure report above the ~45-line seam `state` JSON is no
// longer cut by `tail -60` and written nowhere else. The `| tee …` segment is neither a land
// nor a push segment to this guard's grading (splitSegments/parseSegment/isLandSegment) and
// passes by construction — see the acceptance test asserting the guard accepts this exact line.
export const CANONICAL_LOCAL_INVOCATION = `timeout ${LAND_TIMEOUT_SECONDS} node scripts/done-worktree.mjs <slug> 2>&1 | tee .scratch/land-<slug>.log | tail -60; echo "LAND_EXIT=$?"`;

export const CANONICAL_CLOUD_INVOCATION =
  'node scripts/done-worktree.mjs <slug>        # foreground, tool timeout 600000';

const CONTRACT_LINES = [
  '  Contract (both say the same thing, in prose, which is why this hook exists):',
  '    coord/skills/done-worktree/SKILL.md § The invocation shape is FIXED',
  '    docs/runbooks/branch-hygiene.md § Kill-safety rules',
];

// ── shell-text parsing ───────────────────────────────────────────────────────
//
// The command is split into PIPELINE SEGMENTS and each segment parsed as
//     [VAR=val …] [nohup|command|exec] [timeout [flags] <duration>] argv0 args…
// rather than regex-scanned as one string. Two reasons this matters and a substring
// test would not:
//   • `grep done-worktree.mjs …` / `cat …/SKILL.md` must NEVER be denied — the token
//     appears in this repo's own docs constantly. Requiring argv0 to be `node` in the
//     SAME segment is what separates an INVOCATION from a mention.
//   • `--timeout 500` passed to some other script is not a GNU `timeout` cap. Tokenizing
//     first means `--timeout` simply is not the token `timeout`; no lookbehind needed.

// A heredoc OPENER, matched at the CURRENT scan position and only when the scanner is
// outside quotes: `<<EOF`, `<<-EOF`, `<<'MSG'`. Its BODY is document text, not commands —
// this repo writes commit messages, plan bodies and runbook prose through heredocs
// constantly, prose that quotes the land invocation verbatim, so parsing a body as commands
// would deny `git commit -F - <<'MSG' … timeout 560 node scripts/done-worktree.mjs … MSG`,
// which lands nothing. Deliberately NOT a pre-scan over the raw string: `echo "a <<EOF b"`
// carries the token inside quotes, and a pre-scan that truncated there would blind the guard
// to every real land after it. Matched positionally instead, so quoting is respected and
// scanning RESUMES after the terminator line.
// The delimiter is any of bash's four spellings — `'TAG'`, `"TAG"`, `\TAG`, bare `TAG` — and a
// bare one may hold punctuation (`<<EOF-1`, `<<__END__`). An identifier-only charset silently
// truncated `EOF-1` to `EOF`, so the body was never terminated and the rest of the command
// vanished with it.
const HEREDOC_OPENER_AT_RX =
  /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\([^\s;|&<>()]+)|([^\s;|&<>()'"\\]+))/;

// Splits a command into pipeline segments on unquoted `|`, `||`, `&&`, `;`, `&` and
// newlines, skipping heredoc bodies whole.
//
// `&` IS a break (it ends a command, exactly like `;`) except when it belongs to a redirect
// — `2>&1`, `>&2` — which is why the preceding non-space character is checked. The canonical
// land line contains `2>&1`, so an unconditional `&` break would sever it mid-redirect;
// treating `&` as never-a-break instead let `timeout 14400 <land> & timeout 560 <land>` read
// as ONE compliant land and hide the undersized second one.
//
// A BACKSLASH is honoured inside the scan, not by a regex pre-pass. Backslash-newline is a
// LINE CONTINUATION (without it, `timeout 14400 \⏎ node …done-worktree.mjs` splits the cap
// away from the land and denies a correct invocation); any other backslash escapes the next
// character, so `\&`, `\|`, `\;` stay literal text instead of breaking a segment. Doing both
// in the loop is also what makes backslash PARITY correct — a pre-pass regex cannot tell
// `foo\\⏎` (an escaped backslash, then a real newline) from `foo\⏎` (a continuation).
export function splitSegments(command) {
  const cmd = String(command ?? '');
  const out = [];
  let cur = '';
  let quote = null;
  let pendingHeredocs = [];
  let i = 0;
  const flush = () => {
    out.push(cur);
    cur = '';
  };
  while (i < cmd.length) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote && cmd[i - 1] !== '\\') quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      i += 1;
      continue;
    }
    if (c === '\\') {
      const next = cmd[i + 1];
      if (next === '\n') {
        cur += ' ';
        i += 2;
        continue;
      }
      if (next === '\r' && cmd[i + 2] === '\n') {
        cur += ' ';
        i += 3;
        continue;
      }
      if (next !== undefined) {
        cur += c + next;
        i += 2;
        continue;
      }
      cur += c;
      i += 1;
      continue;
    }
    // `<<<` is a herestring, a normal command. BOTH guards are needed: `cmd[i + 2] !== '<'`
    // rejects a scan starting at its FIRST `<`, `cmd[i - 1] !== '<'` a scan starting at its
    // SECOND — where `<< "y"` otherwise reads as a perfectly well-formed heredoc opener.
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<' && cmd[i - 1] !== '<') {
      const m = HEREDOC_OPENER_AT_RX.exec(cmd.slice(i));
      if (m) {
        pendingHeredocs.push({ tag: m[2] ?? m[3] ?? m[4] ?? m[5], strip: m[1] === '-' });
        i += m[0].length;
        continue;
      }
    }
    if (c === '&' && cmd[i + 1] === '&') {
      flush();
      i += 2;
      continue;
    }
    if (c === '&' && cur.trimEnd().slice(-1) !== '>') {
      flush();
      i += 1;
      continue;
    }
    if (c === '\n') {
      flush();
      i += 1;
      // Every heredoc opened on the line just ended contributes its body here, in order.
      while (pendingHeredocs.length) {
        const { tag, strip } = pendingHeredocs.shift();
        while (i < cmd.length) {
          let end = cmd.indexOf('\n', i);
          if (end === -1) end = cmd.length;
          const line = cmd.slice(i, end).replace(/\r$/, '');
          i = end + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === tag) break;
        }
      }
      continue;
    }
    if (c === '|' || c === ';') {
      flush();
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  flush();
  return out.map((s) => s.trim()).filter(Boolean);
}

// Whitespace tokenizer that strips (rather than honors) quotes — `node "C:/a b/x.mjs"`
// must yield the path as ONE token so the land-script test can anchor on its basename.
export function tokenize(segment) {
  const s = String(segment ?? '');
  const out = [];
  let cur = '';
  let started = false;
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== '\\') quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        out.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

const ENV_ASSIGN_RX = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Tokens that can sit in front of the real command without being it. The shell CONTROL
// words matter as much as the wrappers: `if …; then timeout 560 <land>; fi` splits into a
// segment whose first token is `then`, and without this the land behind it goes ungraded.
//
// `env`/`env.exe` added (plan 3944 round 2, a main-checkout-rebase-guard.mjs review finding
// that applies equally here since this Set is shared): `env FOO=1 git -C <main> reset --hard`
// reached parseSegment() with argv0 `env` and no wrapper unwrapped it, so the git invocation
// behind it was invisible to BOTH guards — this file's own land/push grading included.
// `FOO=1 git …` (no explicit `env`) was already handled by the ENV_ASSIGN_RX strip above; `env`
// is the same thing spelled as an explicit command. BEHAVIOUR CHANGE for THIS guard: a land or
// push previously hidden behind a leading `env` is now graded, where it silently passed before —
// the correct direction (an ungraded land/push is a miss, not a feature). Covered three ways: the
// existing 57-case battery re-ran green after this edit (no case relied on `env` staying opaque);
// scripts/land-timeout-guard.test.mjs — this file's own name-pair — gained cases pinning the new
// behaviour for LANDS specifically (a wrong cap behind `env` now denies, a compliant one still
// passes, and `env -i`/`env -u NAME` are consumed rather than read as the wrapped command); and
// scripts/main-checkout-rebase-guard.test.mjs covers the `env FOO=1 git …` shape against this
// SAME shared parseSegment(). The name-paired cases are the ones that matter if LEADING_WRAPPERS
// is ever edited again — without them a future change would break land grading silently.
//
// `env.exe` added (round 3): `basenameOf()` strips only a directory prefix, never a Windows
// `.exe` suffix — the same reason `GIT_BASENAMES`/`NODE_BASENAMES` below list BOTH spellings.
// Without it, Git-for-Windows's `env.exe FOO=1 timeout 560 <land>` read `env.exe` as an
// unrecognized argv0 and the wrapped land went ungraded exactly like the bare `env` gap above.
const ENV_WRAPPER_BASENAMES = new Set(['env', 'env.exe']);

const LEADING_WRAPPERS = new Set([
  'nohup',
  'command',
  'exec',
  'time',
  ...ENV_WRAPPER_BASENAMES,
  'if',
  'while',
  'until',
  'then',
  'else',
  'elif',
  'do',
  '{',
  '(',
  '!',
]);

// The wrappers that take options of their own (`time -p …`). Their flags are consumed with
// them so the wrapped command's own argv0 is what gets read.
const WRAPPERS_WITH_FLAGS = new Set(['time', 'command', 'exec', 'nohup', ...ENV_WRAPPER_BASENAMES]);

// …and the handful of those flags whose VALUE is a separate token (`exec -a name cmd`,
// `env -u NAME cmd` / `env --unset NAME cmd`), which must be consumed too or the value reads
// as the wrapped command.
//
// `-C`/`--chdir`, `-S`/`--split-string` added (round 3) — measured directly via `env --help`
// on this machine (GNU coreutils 8.32): both are documented as value-taking (`-C, --chdir=DIR`,
// `-S, --split-string=S`). Without them, `env -C <dir> git rebase origin/master` left `<dir>`
// as the (mis-)read argv0 and the git invocation behind it was invisible to BOTH guards — the
// same class of miss `-u`/`--unset` above already covers. `--argv0` is also listed (a newer GNU
// coreutils option not present in this machine's `env --help`, so unlike the other four it is
// NOT independently measured here — included anyway because treating an unrecognized-on-this-
// machine but real-elsewhere value-taking flag as value-taking is the safe direction: the cost
// of being wrong about it is zero (git's own `env` would already reject a nonexistent flag on
// this machine, long before this guard's classification matters), while the cost of NOT listing
// a real value-taking flag is exactly the misread bug this whole fix addresses.
const WRAPPER_VALUE_FLAGS = new Set([
  '-a',
  '-u',
  '--unset',
  '-C',
  '--chdir',
  '-S',
  '--split-string',
  '--argv0',
]);
const DURATION_RX = /^(\d+(?:\.\d+)?)([smhd]?)$/;
const DURATION_MULTIPLIER = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

// GNU timeout flags whose VALUE is a separate following token (`-k 30`). The attached
// forms (`-k30`, `--kill-after=30`) carry their value inside the flag token itself.
const TIMEOUT_VALUE_FLAGS = new Set(['-k', '--kill-after', '-s', '--signal']);

const NODE_BASENAMES = new Set(['node', 'node.exe']);
// Exported for main-checkout-rebase-guard.mjs (plan 3944), which needs the same git-argv0
// recognition to find a `git rebase`/`reset --hard`/`pull --rebase`/`merge` invocation —
// reused rather than re-declared so the two guards can never disagree on what counts as git.
export const GIT_BASENAMES = new Set(['git', 'git.exe']);

// Anchored at the token's END so `done-worktree-lib.mjs` (the library, imported by tests
// and tooling) can never be mistaken for the land script.
const LAND_SCRIPT_RX = /(^|\/)done-worktree\.mjs$/;

// Folded to LOWER CASE (review round 4): every consumer of this function's return value is an
// EXECUTABLE-RECOGNITION set lookup — `LEADING_WRAPPERS`/`WRAPPERS_WITH_FLAGS`/
// `ENV_WRAPPER_BASENAMES` via `wrapperBase`, the bare `timeout`/`timeout.exe` `head` check, and
// `NODE_BASENAMES`/`GIT_BASENAMES` via `argv0Base` — and Windows filenames are case-insensitive,
// so `ENV.EXE`/`Env.exe`/`GIT.EXE` name the same executables as their lowercase spellings. The
// pre-existing `git.exe`/`node.exe`/`timeout.exe` entries had this exact same latent gap (an
// uppercase spelling of any of them would have missed too) — round 4 just happened to measure it
// via `env.exe` first. Nothing else in this file goes through `basenameOf()`: the land-script
// path check (`LAND_SCRIPT_RX`) runs its own case-sensitive regex directly against the raw argv
// path, never through this function, and flag VALUES (`-C <path>`, `--rebase=<value>`, …) are
// never basename'd at all — so this fold cannot change either of those.
function basenameOf(token) {
  const t = String(token ?? '').replace(/\\/g, '/');
  const i = t.lastIndexOf('/');
  return (i === -1 ? t : t.slice(i + 1)).toLowerCase();
}

// `14400` / `14400s` / `4h` all mean the same cap and all pass. Returns null for anything
// non-literal (`$CAP`, `"$(…)"`) — an unresolvable cap is graded as a WRONG cap, not a
// missing one, because the fix is identical: write the literal 14400.
export function durationToSeconds(token) {
  const m = DURATION_RX.exec(String(token ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return n * DURATION_MULTIPLIER[m[2]];
}

export function parseSegment(segment) {
  const tokens = tokenize(segment);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGN_RX.test(tokens[i])) i += 1;
  while (i < tokens.length && LEADING_WRAPPERS.has(basenameOf(tokens[i]))) {
    const wrapperBase = basenameOf(tokens[i]);
    const takesFlags = WRAPPERS_WITH_FLAGS.has(wrapperBase);
    i += 1;
    if (takesFlags) {
      while (i < tokens.length && tokens[i].startsWith('-')) {
        const flag = tokens[i];
        i += 1;
        // Split on `=` before the lookup (round 3, mirrors the TIMEOUT_VALUE_FLAGS precedent
        // below): an ATTACHED form (`--chdir=DIR`) already carries its value in this one token,
        // so `!flag.includes('=')` is what stops it from also eating the following token — a
        // bare `bare` check without that guard would double-consume `--chdir=DIR git rebase`'s
        // `git` as if it were `--chdir`'s separate-token value.
        const bare = flag.split('=')[0];
        if (WRAPPER_VALUE_FLAGS.has(bare) && !flag.includes('=') && i < tokens.length) i += 1;
      }
    }
    // `env`/`env.exe` additionally accept NAME=value assignment tokens ahead of its own command
    // (`env FOO=1 BAR=2 git …`) — the explicit-command mirror of the bare `FOO=1 git …` form
    // ENV_ASSIGN_RX already strips above. GNU env's own options (`-i`, `-u <name>`, `-C <dir>`,
    // …) are consumed by the flag loop above via WRAPPER_VALUE_FLAGS; this loop only eats
    // VAR=value pairs.
    if (ENV_WRAPPER_BASENAMES.has(wrapperBase)) {
      while (i < tokens.length && ENV_ASSIGN_RX.test(tokens[i])) i += 1;
    }
  }

  let timeoutRaw = null;
  let timeoutSeconds = null;
  const head = i < tokens.length ? basenameOf(tokens[i]) : '';
  if (head === 'timeout' || head === 'timeout.exe') {
    i += 1;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const flag = tokens[i];
      i += 1;
      const bare = flag.split('=')[0];
      if (TIMEOUT_VALUE_FLAGS.has(bare) && !flag.includes('=') && i < tokens.length) i += 1;
    }
    if (i < tokens.length) {
      timeoutRaw = tokens[i];
      timeoutSeconds = durationToSeconds(tokens[i]);
      i += 1;
    }
  }

  const argv0 = i < tokens.length ? tokens[i] : '';
  return {
    timeoutRaw,
    timeoutSeconds,
    argv0,
    argv0Base: basenameOf(argv0),
    args: tokens.slice(i + 1),
  };
}

// Flags whose VALUE is a separate following token, per host program. The attached forms
// (`-e=…`, `--require=…`) carry their value inside the flag token and need no skip.
const NODE_VALUE_FLAGS = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-r',
  '--require',
  '--import',
  '--loader',
  '--conditions',
  '--experimental-loader',
]);
// Exported for main-checkout-rebase-guard.mjs (plan 3944) — same reuse rationale as
// GIT_BASENAMES above: one grammar for git's own value-taking global options.
export const GIT_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
]);

// `--dry-run` prints the command sequence it WOULD run without touching git, `--prep` is
// explicitly "not a land" (scripts/done-worktree.mjs — `const DRY` / `IS_PREP`), and
// `--finish-close-out` (plan 3375) resumes a DEAD land's PAPERWORK from a fresh session. None
// runs the gates the 4 h cap exists for, so grading them would deny three legitimate calls.
const NON_LAND_MODE_FLAGS = new Set(['--dry-run', '--prep', '--finish-close-out']);

// Index of the FIRST positional argument — for node that is the script it runs, for git the
// subcommand. Deliberately not `args.some(...)`: a token merely CONTAINING the land script's
// path is not an invocation of it. `node scripts/edit-plan.mjs 3452 --replace "node
// scripts/done-worktree.mjs"` writes plan prose about the land and must never be denied; only
// the segment whose node actually EXECUTES done-worktree.mjs is graded. The INDEX (not just
// the value) is what separates the host program's own options from the script's argv — the
// two are graded by different rules, and conflating them is a bypass in both directions.
export function firstPositionalIndex(args, valueFlags) {
  for (let i = 0; i < args.length; i += 1) {
    const t = String(args[i] ?? '');
    if (!t.startsWith('-')) return i;
    const bare = t.split('=')[0];
    if (valueFlags.has(bare) && !t.includes('=')) i += 1;
  }
  return -1;
}

export function firstPositional(args, valueFlags) {
  const i = firstPositionalIndex(args, valueFlags);
  return i === -1 ? '' : String(args[i] ?? '');
}

// `node -e '…' foo.mjs` runs the INLINE code and hands `foo.mjs` to it as plain argv — node
// executes no script file at all. Without this, the first positional after the skipped `-e`
// value reads as the script and an unrelated eval mentioning the land path gets denied.
const NODE_INLINE_CODE_FLAGS = new Set(['-e', '--eval', '-p', '--print']);

// An INVOCATION of the land script, not a mention of it: argv0 must itself be node AND
// the script node runs must be done-worktree.mjs AND the call must not be one of its
// documented non-land modes.
export function isLandSegment(parsed) {
  if (!NODE_BASENAMES.has(parsed.argv0Base)) return false;

  const scriptIdx = firstPositionalIndex(parsed.args, NODE_VALUE_FLAGS);
  // NODE's OWN options end at the script path; everything after it is the SCRIPT's argv.
  // Scanning the whole list for `-e` was a bypass: `node …/done-worktree.mjs <slug> -e`
  // passes `-e` to done-worktree, not to node, yet it exempted the land.
  const nodeOpts = scriptIdx === -1 ? parsed.args : parsed.args.slice(0, scriptIdx);
  if (nodeOpts.some((a) => NODE_INLINE_CODE_FLAGS.has(String(a).split('=')[0]))) return false;
  if (scriptIdx === -1) return false;

  const script = String(parsed.args[scriptIdx] ?? '').replace(/\\/g, '/');
  if (!LAND_SCRIPT_RX.test(script)) return false;

  // Mirror of the same boundary: the non-land modes are the SCRIPT's flags, and matched as
  // EXACT tokens because that is how done-worktree.mjs reads them (`argv.includes('--prep')`).
  // A `--dry-run=false` is not a dry run to that script, so it must not be one here either.
  const scriptArgs = parsed.args.slice(scriptIdx + 1);
  return !scriptArgs.some((a) => NON_LAND_MODE_FLAGS.has(String(a)));
}

export function isPushSegment(parsed) {
  if (!GIT_BASENAMES.has(parsed.argv0Base)) return false;
  return firstPositional(parsed.args, GIT_VALUE_FLAGS) === 'push';
}

// ── the environment gate ─────────────────────────────────────────────────────
//
// Both markers are the ESTABLISHED ones, reused rather than re-coined:
// `CLAUDE_CODE_REMOTE === 'true'` (vetapp/CLAUDE.md and cloud-land-backgrounding-guard.mjs
// both treat it as authoritative) and `agent_id` on the payload via loader-common's
// shared parseAgentId, so a schema rename lands in one place for all three guards.
// `env` is a PARAMETER so every branch is reachable from a test without touching the host
// machine's ambient environment.
export function classifyEnvironment(payload, env = process.env) {
  if (parseAgentId(payload)) return 'subagent';
  if (String(env?.CLAUDE_CODE_REMOTE ?? '').trim() === 'true') return 'cloud';
  return 'local';
}

// ── the verdict ──────────────────────────────────────────────────────────────

// Returns null (ALLOW) or { key, environment, found } (DENY). Pure: no disk, no
// subprocess, no ambient state beyond the injected `env`.
export function evaluate(payload, env = process.env) {
  if (String(payload?.tool_name ?? '') !== 'Bash') return null;
  const input = payload?.tool_input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command) return null;

  const environment = classifyEnvironment(payload, env);
  if (environment === 'subagent') return null; // owned by subagent-backgrounding-guard.mjs

  const segments = splitSegments(command).map(parseSegment);

  // EVERY land segment is graded, not just the first. `<compliant land>; <undersized land>`
  // must not pass on the strength of its first half — a chained or retried second invocation
  // is exactly the shape a session reaches for after a killed land.
  for (const land of segments.filter(isLandSegment)) {
    if (environment === 'cloud') {
      if (land.timeoutRaw !== null) {
        return { key: 'cloud-inner-land-timeout', environment, found: land.timeoutRaw };
      }
      continue;
    }
    if (land.timeoutRaw === null)
      return { key: 'local-missing-land-cap', environment, found: null };
    if (land.timeoutSeconds !== LAND_TIMEOUT_SECONDS) {
      return { key: 'local-wrong-land-cap', environment, found: land.timeoutRaw };
    }
  }

  // The narrowed push half — see § WHAT THIS GUARD DELIBERATELY DOES NOT POLICE. Reached
  // even when the command also carries a (compliant) land: a wrong-capped push alongside a
  // correct land is still a wrong-capped push.
  if (environment === 'local' && input.run_in_background === true) {
    for (const push of segments.filter(isPushSegment)) {
      if (push.timeoutRaw !== null && push.timeoutSeconds !== LAND_TIMEOUT_SECONDS) {
        return { key: 'local-wrong-push-cap', environment, found: push.timeoutRaw };
      }
    }
  }

  return null;
}

// ── block text ───────────────────────────────────────────────────────────────

const WHY_14400 = [
  '  Why 4 h and never "about right": the two errors do not cost the same. Too LONG costs',
  '  NOTHING — the land exits by itself the moment it finishes, and the inner `timeout`',
  '  exists only so the MSYS bash wrapper terminates on its own. Too SHORT kills the land',
  '  mid-gate and burns the wall-clock already spent plus the queue slot. The tail is not',
  "  under your control: a land behind two sessions' full suites routinely exceeds an hour",
  '  of QUEUE-WAIT before its own gates start. A killed land is not lost work — re-invoke',
  '  bare and it resumes from its gate ledger. That is recovery, not a reason to shorten.',
];

export function formatBlock(verdict) {
  const found = verdict?.found;
  const ruling = `  Operator ruling 2026-08-24, verbatim: "${OPERATOR_RULING}"`;

  if (verdict.key === 'cloud-inner-land-timeout') {
    return [
      `land-timeout-guard: this land carries an inner \`timeout ${found}\`, but this is a`,
      '  CLOUD drain sandbox — a cloud land runs in the FOREGROUND with NO inner timeout',
      '  (tool timeout 600000). Drop the inner cap:',
      '',
      `    ${CANONICAL_CLOUD_INVOCATION}`,
      '',
      ruling,
      '  A cloud container runs alone, so the Windows contention the 14400 cap exists for',
      '  does not apply there; and a cloud drain hands the land back rather than parking on',
      '  a wrapper it cannot outlive (plan 3248).',
      ...CONTRACT_LINES,
    ].join('\n');
  }

  if (verdict.key === 'local-wrong-push-cap') {
    return [
      `land-timeout-guard: this backgrounded \`git push\` carries \`timeout ${found}\`.`,
      `  On the shared LOCAL checkout every backgrounded long-running git job uses the SAME`,
      `  inner cap: \`timeout ${LAND_TIMEOUT_SECONDS}\` (4 h). Do not size it to the job, and do not`,
      '  carry one over from another command — a push capped at 900 s under a 1500 s wrapper',
      '  is exactly the 2026-08-24 misfire this rule was written from.',
      '',
      ruling,
      ...CONTRACT_LINES,
    ].join('\n');
  }

  const opening =
    verdict.key === 'local-missing-land-cap'
      ? 'land-timeout-guard: this land invocation carries NO inner `timeout` cap.'
      : `land-timeout-guard: this land invocation carries \`timeout ${found}\` — not the one sanctioned cap.`;

  return [
    opening,
    `  On a LOCAL top-level session a land takes ONE number: \`timeout ${LAND_TIMEOUT_SECONDS}\` (4 h),`,
    '  backgrounded (`run_in_background: true`). Copy-paste the canonical form:',
    '',
    `    ${CANONICAL_LOCAL_INVOCATION}`,
    '',
    ruling,
    ...WHY_14400,
    ...CONTRACT_LINES,
  ].join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(env = process.env) {
  // Fail-open test seam — see § FAIL-OPEN in the header. Throws BEFORE reading stdin so
  // the test exercises the outermost catch, not a parse branch.
  if (String(env?.LAND_TIMEOUT_GUARD_FORCE_ERROR ?? '') === '1') {
    throw new Error('land-timeout-guard: forced error (fail-open test seam)');
  }

  const raw = readStdin();
  if (!raw.trim()) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // malformed → fail open
  }

  const verdict = evaluate(payload, env);
  if (!verdict) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: formatBlock(verdict),
      },
    }),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch {
    // fail open — a tool hook must never break the turn
  }
  process.exit(0);
}

export { main };
