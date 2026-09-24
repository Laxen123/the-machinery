// scripts/coord/sh-exec.mjs — shared POSIX-shell resolver seam (plan 3219).
//
// Six sites in this repo spawn a POSIX shell by the BARE name (`sh` / `bash`) to run the
// real push hooks, the real PreToolUse guards, or a tripCheck command. A bare name resolves
// against the PARENT process's PATH, and only Git Bash puts a POSIX shell there: measured
// 2026-08-15 on the operator's Windows machine, `spawnSync('sh', ['-c','echo hi'])` returns `status: 0`
// under the Bash tool and `status: null` / `error.code: ENOENT` under the PowerShell tool.
// So every one of those sites was silently Bash-tool-only, and a battery run (or a land,
// whose preflight runs the battery) launched from PowerShell went RED on ~40 tests whose
// assertion text — `hook should exit 0; got null` — reads exactly like a real hook
// regression. This module is the one place that resolution lives.
//
// Shape mirrors `scripts/coord/pwsh-exec.mjs` (plan 2405): a PURE candidate order that unit-tests
// without spawning anything, plus an impure probe/memoize/honest-fallback on top with an
// injectable spawn seam.
//
// ── Why `usr\bin\bash.exe` and NOT `bin\bash.exe` (measured, do not re-derive) ───────────
// Git for Windows ships two POSIX shells, and they differ in a way that matters here:
//
//   `<GitRoot>\bin\bash.exe`      PREPENDS `/mingw64/bin:/usr/bin` to the PATH it is handed.
//                                 Coreutils resolve, but so does the REAL git — ahead of a
//                                 caller-supplied fake-bin dir. The pre-push harness exists
//                                 precisely to shadow `git`/`node`/`pnpm`/`python` with
//                                 fakes, so this flavour silently defeats the test.
//   `<GitRoot>\usr\bin\bash.exe`  keeps the caller's PATH order, so a fake-bin prefix wins —
//                                 but nothing from `/usr/bin` is on PATH, so `sed`, `grep`,
//                                 `awk` and `/usr/bin/env` all go MISSING.
//
// The working combination is `usr\bin` + `shellChildPath()`, which inserts the MSYS bin
// dirs BEHIND the caller's own prefix dirs but AHEAD of the inherited Windows PATH: the
// fake bin still shadows, and the coreutils still beat `C:\Windows\system32`'s same-named
// `sort.exe`/`find.exe`. Under Git Bash the resolved exe is that same install's
// `usr\bin\sh.exe` (the file the bare name resolved to there anyway) and the caller's PATH
// already carries its `usr\bin`, so shellChildPath adds nothing and the path is unchanged.

import { execFileSync } from 'node:child_process';
import { childEnv } from './child-env.mjs';

// The MSYS bin dirs, relative to a Git-for-Windows install root. Order matches what Git
// Bash itself hands a child.
const MSYS_BIN_SUBDIRS = ['mingw64\\bin', 'usr\\bin'];

// A PATH entry that names one of Git-for-Windows' four bin dirs, capturing the install root.
const GIT_BIN_DIR_RX = /^(.*[\\/]Git)[\\/](?:cmd|bin|usr[\\/]bin|mingw64[\\/]bin)[\\/]?$/i;

// The same, without requiring the root to be literally NAMED `Git` — a portable install
// (`D:\Tools\PortableGit-2.49\cmd`) is a supported shape the strict form misses. A plain
// `bin` is included even though it matches unrelated entries: every root is PROBED for an
// actual `usr\bin\<name>.exe` before use, so a wrong guess costs one immediate ENOENT and
// never a wrong answer, while excluding it would miss a portable install exposed only
// through its `bin` dir.
// Tried in order, MOST SPECIFIC FIRST, and deliberately not one alternation: `.*` is greedy,
// so a single `(?:…|bin|usr[\\/]bin|…)` alternation resolves `…\Git\usr\bin` against the
// SHORTEST suffix it can — capturing `…\Git\usr` as the root.
const GIT_BIN_DIR_LOOSE_RXS = [
  /^(.*)[\\/]usr[\\/]bin$/i,
  /^(.*)[\\/]mingw64[\\/]bin$/i,
  /^(.*)[\\/]cmd$/i,
  /^(.*)[\\/]bin$/i,
];

function looseGitRoot(entry) {
  const trimmed = entry.replace(/[\\/]+$/, '');
  for (const rx of GIT_BIN_DIR_LOOSE_RXS) {
    const m = rx.exec(trimmed);
    if (m) return m[1];
  }
  return null;
}

// The shell exe shapes shellChildPath can read an install root back out of.
const RESOLVED_SHELL_RX = /^(.*)[\\/]usr[\\/]bin[\\/](?:sh|bash)\.exe$/i;

// A blocked candidate must not hang every consumer: a Windows `bash.exe` that waits on a
// service (WSL with no distro registered, an AV-wrapped shell) would otherwise block the
// first shExe() call in the process forever, since execFileSync has no default timeout.
// Generous on purpose — a cold, AV-scanned first spawn is slow, and a candidate rejected
// for slowness is worse than one rejected for absence: the fallback below it may be a
// WORSE shell, not no shell.
const PROBE_TIMEOUT_MS = 15000;

// …but one SLOW candidate must not license N slow candidates. This is the ceiling on the
// whole resolution, shared across every candidate probed, so a machine with several stale or
// AV-blocked Git roots still resolves (or falls back) inside a bound a caller can advertise.
const PROBE_BUDGET_MS = 20000;

// A bare-name probe on Windows must PROVE it reached an MSYS/Cygwin shell. `$OSTYPE` is
// `msys` under Git Bash and `linux-gnu` under WSL's `C:\Windows\System32\bash.exe`, which
// is the one impostor that both sits on PATH by default and passes `-c 'exit 0'`.
const MSYS_PROOF_SCRIPT = 'case "$OSTYPE" in msys*|cygwin*|mingw*) exit 0;; *) exit 9;; esac';

// pathKeyOf — Windows env keys are case-insensitive and `{...process.env}` preserves the OS
// casing (`Path`), so a plain `env.PATH` read misses on a spread copy. Return the key that
// is actually present, so callers read AND write the same one instead of leaving a child
// with both `Path` and `PATH`. An exact `PATH` always wins; only Windows falls back to the
// case-insensitive match, and only there is `path` a PATH at all (on POSIX it is an
// ordinary, unrelated variable). The LAST match wins because object spread is
// last-assignment-wins: `{...process.env, PATH: x}` means `x`.
export function pathKeyOf(env, platform = process.platform) {
  const keys = Object.keys(env ?? {});
  if (keys.includes('PATH')) return 'PATH';
  if (platform !== 'win32') return 'PATH';
  return keys.filter((k) => /^path$/i.test(k)).pop() ?? 'PATH';
}

function pathValueOf(env, platform = process.platform) {
  return env?.[pathKeyOf(env, platform)] ?? '';
}

// gitTopDirs — pure. Ordered Git-for-Windows install roots, cheapest-first: an explicit
// VETAPP_GIT_ROOT, then the ones the caller's own PATH proves are installed, then the
// conventional install locations. Reading PATH keeps this env-only (no probe spawn) and
// survives a non-default install path.
//
// VETAPP_GIT_ROOT is the successor to plan 3099's `GUARD_TEST_BASH` (retired with
// test-helpers/resolve-git-bash.mjs). Same purpose — name the install when it sits somewhere
// none of the rules below find it — but it names the ROOT rather than the bash executable,
// which is what shellChildPath() needs to put that install's own coreutils on a child's PATH;
// an executable-only override cannot supply those, and it would fix `bash` while leaving `sh`
// unresolved.
export function gitTopDirs(env = process.env, platform = process.platform) {
  const roots = [];
  const add = (r) => {
    if (r && !roots.some((seen) => seen.toLowerCase() === r.toLowerCase())) roots.push(r);
  };
  add(env.VETAPP_GIT_ROOT);
  const entries = pathValueOf(env, platform)
    .split(';')
    .map((e) => e.trim());
  for (const entry of entries) {
    const m = GIT_BIN_DIR_RX.exec(entry);
    if (m) add(m[1]);
  }
  for (const entry of entries) add(looseGitRoot(entry));
  if (env.ProgramFiles) add(`${env.ProgramFiles}\\Git`);
  if (env['ProgramFiles(x86)']) add(`${env['ProgramFiles(x86)']}\\Git`);
  if (env.LOCALAPPDATA) add(`${env.LOCALAPPDATA}\\Programs\\Git`);
  return roots;
}

// shCandidates — pure. Ordered executables to try for `name` ('sh' | 'bash'), most-preferred
// first.
//
// On Windows the Git-derived absolute paths come BEFORE the bare name, which looks backwards
// until you check what a bare `bash` resolves to there: `C:\Windows\System32\bash.exe`, the
// WSL launcher, ships with Windows and sits on PATH ahead of Git's dirs. It is a real POSIX
// shell that satisfies `-c 'exit 0'` whenever a distro is registered — so a bare-name-first
// order memoizes WSL's bash as THE shell for the whole process, and every consumer then
// hands it Windows-form paths and a Windows-form PATH it cannot read. (On this machine
// `Test-Path C:\Windows\System32\bash.exe` is True and only the absent distro — exit 1 —
// kept the bare-name probe from selecting it.) Preferring the explicit Git install costs
// nothing under Git Bash, where the bare name resolves to that very same binary.
//
// Why that mis-resolution is worse than a plain crash (plan 3099, whose `test-helpers/
// resolve-git-bash.mjs` this module retires — same bug, found independently, narrower fix
// that non-test callers like `trip-status.mjs` could not import): with no distro registered
// the WSL stub prints `execvpe(/bin/bash) failed` to stdERR and writes NOTHING to stdout.
// Every hook-shelling guard test here reads empty stdout as "the guard allowed it", so a
// test that should be DENYING something instead reports "not denied" — a security guard
// silently failing OPEN, indistinguishable from the guard being genuinely broken.
export function shCandidates(name, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return [name];
  return [...gitTopDirs(env, platform).map((root) => `${root}\\usr\\bin\\${name}.exe`), name];
}

const _resolved = new Map();

// shExe — probe each candidate (in shCandidates() order) with a no-op `-c 'exit 0'`,
// memoize the first that launches, and fall back if none work. The fallback is normally the
// LAST candidate (unprobed) — the bare name, so a caller sees an honest ENOENT from its own
// invocation rather than a silently swallowed resolution failure, and never a made-up
// absolute path that would ENOENT on a file instead. `_execFileSync` is the injectable
// spawn seam.
//
// ONE exception, and it is the whole point of the MSYS proof: if the bare name LAUNCHED and
// proved it is not an MSYS shell (WSL's `C:\Windows\System32\bash.exe` with a distro
// registered), handing it back would defeat the check that just rejected it — callers would
// launch WSL with Windows-form paths, and a guard hook run that way writes nothing to
// stdout, which every guard test here reads as "the guard allowed it". A shell PROVEN wrong
// is worse than no shell, so the fallback becomes the first Git-derived candidate instead:
// that ENOENTs honestly and names the install the machine is missing.
//
// The memo is keyed by the CANDIDATE LIST *and* (on Windows) the PATH those candidates were
// probed against. The candidate list alone is not enough: the bare name resolves through
// PATH at spawn time, so two environments sharing a candidate list can still resolve it to
// different shells, and the first one's answer must not be served to the second.
export function shExe(
  name = 'sh',
  { _execFileSync = execFileSync, platform = process.platform, env = process.env } = {},
) {
  const cands = shCandidates(name, { platform, env });
  const key = `${platform}|${cands.join('|')}|${
    platform === 'win32' ? pathValueOf(env, platform) : ''
  }`;
  const memo = _resolved.get(key);
  if (memo) return memo;
  // The bare name is the only candidate whose IDENTITY is unknown before it runs — every
  // other one is an explicit `<GitRoot>\usr\bin\…` path. So it alone has to prove it is an
  // MSYS shell rather than WSL's same-named launcher.
  const bare = cands[cands.length - 1];
  const script = (c) => (platform === 'win32' && c === bare ? MSYS_PROOF_SCRIPT : 'exit 0');
  // One budget across ALL candidates, not PROBE_TIMEOUT_MS each: several stale or AV-blocked
  // Git roots would otherwise stack their timeouts and spend minutes before the first real
  // work, blowing the hard caps callers advertise (trip-status's ~90s board-pass cap).
  const started = Date.now();
  let impostor = false;
  for (const cand of cands) {
    const left = PROBE_BUDGET_MS - (Date.now() - started);
    if (left <= 0) break;
    try {
      _execFileSync(cand, ['-c', script(cand)], {
        stdio: 'ignore',
        timeout: Math.min(PROBE_TIMEOUT_MS, left),
        windowsHide: true,
        env,
      });
      _resolved.set(key, cand);
      return cand;
    } catch (e) {
      // Exit 9 is MSYS_PROOF_SCRIPT's own verdict: it RAN, and it is not an MSYS shell. A
      // spawn failure (ENOENT) or a probe-timeout kill leaves `impostor` false, so the
      // ordinary honest-ENOENT fallback still applies.
      if (cand === bare && e?.status === 9) impostor = true;
    }
  }
  const fallback = impostor && cands.length > 1 ? cands[0] : bare;
  _resolved.set(key, fallback);
  return fallback;
}

// bashExe — the `bash` twin of shExe. Separate memo entry, same contract.
export function bashExe(opts) {
  return shExe('bash', opts);
}

// resetShExeCache — test hook: the memo above is module-level state.
export function resetShExeCache() {
  _resolved.clear();
}

// shellChildPath — compose the PATH a spawned POSIX shell should receive: `prefixDirs`
// first (the fake-bin dirs the hook harnesses use to shadow real tools), then — only on
// Windows, and only when they are not already there — the resolved install's MSYS bin
// dirs, then the caller's own PATH. Joined with the PLATFORM's separator, so the
// result is an ordinary Windows PATH on Windows: MSYS converts one natively (it is what
// every Windows program hands bash), and so does anything else downstream that has to read
// it — `scripts/prepush-job-wrapper.ps1` starts `sh` through .NET `Process.Start`, which
// resolves Windows paths only. A POSIX-form `/usr/bin` entry would satisfy the shell and
// strand the wrapper, and a Windows entry inside a `:`-joined list gets split at its drive
// colon. Both were observed in the plan-3219 verification run.
//
// The MSYS dirs must sit BEFORE the caller's PATH, not after it: `C:\Windows\system32`
// ships its own `sort.exe` and `find.exe`, which answer `sort -u` with a Windows
// "cannot find the file" error rather than doing anything (also observed in that run —
// worktree-guard.sh's `… | sort -u`). Same order Git Bash itself uses, with a caller's own
// prefix ahead of both.
//
// The MSYS dirs are derived from the install `shExe()` actually RESOLVED, never from
// "the first Git root on PATH": with a stale `D:\OldGit\cmd` ahead of a working install,
// those are different answers, and pairing one install's shell with another's coreutils
// puts `sed`/`grep`/`awk` back out of reach. `shell` is exposed as an option so a unit test
// can pin it and stay spawn-free; the default resolves (and memoizes) the real one.
// `name` selects WHICH shell is being composed for, because `shellEnv(…, {name:'bash'})`
// must describe the install `bashExe()` resolved: on a half-broken install the two names
// can resolve to different roots, and a bash launched with sh's coreutils is the same
// mismatch this whole function exists to prevent.
export function shellChildPath(
  prefixDirs = [],
  {
    env = process.env,
    platform = process.platform,
    name = 'sh',
    _execFileSync = undefined,
    shell = undefined,
  } = {},
) {
  const sep = platform === 'win32' ? ';' : ':';
  const base = pathValueOf(env, platform);
  if (platform !== 'win32') return [...prefixDirs, base].filter(Boolean).join(sep);

  const exe = shell ?? shExe(name, { platform, env, ...(_execFileSync ? { _execFileSync } : {}) });
  const root = RESOLVED_SHELL_RX.exec(exe)?.[1];
  // No root means resolution fell back to the bare name — there is no install to name, so
  // adding a guessed one would be worse than adding nothing.
  if (!root) return [...prefixDirs, base].filter(Boolean).join(sep);

  const dirs = MSYS_BIN_SUBDIRS.map((sub) => `${root}\\${sub}`);
  // MOVE these dirs to the front rather than skipping when they are already present
  // somewhere: presence is not precedence. A PATH of
  // `C:\Windows\system32;…\Git\mingw64\bin;…\Git\usr\bin` carries both — and still resolves
  // `sort`/`find` to system32's same-named Windows programs, which answer `sort -u` with
  // "cannot find the file" instead of sorting. Only what THIS install contributes is
  // relocated; a stale `D:\Old\Git\usr\bin` keeps its position, behind ours.
  const own = new Set(dirs.map((d) => d.toLowerCase()));
  const norm = (e) =>
    e
      .trim()
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  const rest = base.split(sep).filter((e) => e.trim() && !own.has(norm(e)));
  return [...prefixDirs, ...dirs, ...rest].filter(Boolean).join(sep);
}

// shellEnv — the `{ ...base, PATH: shellChildPath(…) }` wrapper. It writes back to whichever
// case-variant PATH key `base` carries (see pathKeyOf) AND drops every other variant: a base
// built as `{...process.env, PATH: x}` on Windows carries both `Path` and `PATH`, and the
// child would resolve the case-insensitive collision to whichever the OS picked — silently
// ignoring the fake-bin and MSYS dirs inserted here.
//
// The copy goes through `childEnv()` rather than a bare spread, because this IS a child-env
// seam: its callers hand it `process.env` and spawn the real hooks with the result. Owning a
// second, unscrubbed copy of that step is the four-divergent-copies failure `child-env.mjs`
// was written to end — historically, `ALLOW_LANDED_REVERSION` riding into the guard tests that
// asserted the reversion check FIRES (plan 2598; that var and that halt were both retired by
// plan 3832, and `CHILD_ENV_STRIP` is empty today). The reason stands independently of any
// current entry: a scrub added there must reach these spawns too, and a second copy would
// silently miss it.
export function shellEnv(base = process.env, prefixDirs = [], opts = {}) {
  const platform = opts.platform ?? process.platform;
  const out = childEnv(base);
  const key = pathKeyOf(base, platform);
  if (platform === 'win32') {
    for (const k of Object.keys(out)) if (k !== key && /^path$/i.test(k)) delete out[k];
  }
  out[key] = shellChildPath(prefixDirs, { env: base, ...opts });
  return out;
}
