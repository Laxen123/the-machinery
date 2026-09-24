#!/usr/bin/env node
// scripts/coord/coord-child-probe.mjs — plan 4087 T3.
//
// heal-main.mjs's live hang probe: lists processes whose COMMAND LINE targets the shared
// coord checkout (.claude/coord-worktree) and reports each by pid + age, and (opt-in only,
// see killHungCoordChildren below) kills the ones older than a caller-supplied age ceiling.
//
// WHY ITS OWN MODULE: the probe has real testable surface of its own — a Windows CIM-shaped
// reader, a POSIX `ps`-shaped reader, age computation, and the opt-in kill — none of which
// heal-main.mjs's other steps need, and folding it into that 1500+-line file would make none
// of it independently unit-testable. Name-paired with coord-child-probe.test.mjs per the
// vetapp new-test-file rule.
//
// PLATFORM SYMBOLS (vetapp CLAUDE.md "the platform is the commonest case, and for it you must
// supply that platform's SYMBOLS too, not just its name"): a test exercising the Windows
// branch injects a raw PowerShell-shaped `_exec` returning the actual CIM field names
// (ProcessId/CommandLine) plus the ISO-8601 CreationDateIso string our own -Command script
// forces — never a bare `process.platform` fake. A test exercising the POSIX branch injects a
// `ps -eo pid,lstart,args`-shaped `_exec` the same way. `platform` is itself a parameter (not
// read from `process.platform` until the outermost caller) so BOTH branches are exercisable
// from either host, matching confirmTreeDead's own pattern in kill-tree.mjs.
import { execFileSync } from 'node:child_process';
// plan 4087 review fix (lrgecf/1ms5c76/g7cc53): killProcessByPid below replaces killProcessTree
// as the default kill (see its own header) — it needs the same descendant-tree primitives
// killProcessTree itself is built on, not killProcessTree itself, because a probe-discovered
// pid has no real ChildProcess handle for killProcessTree's `.kill()` call to land on.
// plan 4087 review round 2 (reuse finding coord-child-probe.mjs:194): the actual tree-kill
// mechanics now live ONE place, kill-tree.mjs's killProcessTreeByPid — this module no longer
// hand-rolls a second copy (that copy had dropped kill-tree.mjs's self-pid guard).
import { killProcessTreeByPid } from './kill-tree.mjs';

// plan 4087 T1: the kill-eligibility ceiling gets wired here once T0's coord-op-journal
// measurement lands (proposal in the plan: p95 * 3, floor 30s, ceiling 180s). Deliberately
// null until then — killHungCoordChildren refuses to run without an explicit ageMs, so no
// placeholder number gets baked in and later mistaken for a measured one. heal-main's CLI
// pairs `--kill-hung-coord-children` with a required `--kill-age-ms=<n>` override until T1
// sets this constant, at which point the CLI can fall back to it.
export const HUNG_COORD_CHILD_KILL_AGE_MS = null;

// plan 4087 review round 3 (findings coord-child-probe.mjs:194 e9c5aa/5dbc34): every raw
// process-enumeration subprocess below (`powershell.exe` / `ps`) carries this as an explicit
// `execFileSync` `timeout` — this file is RECOVERY tooling (heal-main's live hang probe), and a
// spawned enumeration with no timeout of its own could itself hang the very tool that exists to
// unstick a hang. A timed-out read throws (Node's own ETIMEDOUT), which every caller already
// degrades safely: `listCoordChildren`'s own try/catch upstream in heal-main reports the probe
// blind rather than blocking the run, and killProcessByPid's own pre-kill identity re-check
// (currentProcessRow, called fresh per child — see killHungCoordChildren's own header) treats a
// failed read as "no identity evidence" — a safe kill refusal for that one child, never a hang.
const PROCESS_ENUMERATION_TIMEOUT_MS = 10_000;

// ── Windows reader: PowerShell Get-CimInstance Win32_Process ────────────────────────────
// CreationDate is forced to round-trip ("o", UTC) ISO-8601 inside the -Command script itself
// rather than trusting ConvertTo-Json's own DateTime serialization (which varies by PowerShell
// version/culture) — the parser below only ever has to understand ONE date shape.
const WIN_PS_SCRIPT =
  'Get-CimInstance Win32_Process | ' +
  'Where-Object { $_.CommandLine } | ' +
  'Select-Object ProcessId, CommandLine, ' +
  '@{Name="CreationDateIso";Expression={$_.CreationDate.ToUniversalTime().ToString("o")}} | ' +
  'ConvertTo-Json -Compress';

// Raw Windows process rows: [{ pid, commandLine, creationDateMs }]. `exec` is the ONE
// testability seam (mirrors heal-main.mjs's own `exec` seams) — no production caller passes
// it; a test injects it with canned Win32_Process-shaped JSON so this can be pinned without
// spawning real powershell.exe. `ConvertTo-Json` on a single match returns an object rather
// than a one-element array — normalized below.
export function listWindowsProcessRows({ exec = execFileSync } = {}) {
  const out = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS_SCRIPT], {
    encoding: 'utf8',
    timeout: PROCESS_ENUMERATION_TIMEOUT_MS,
  });
  const parsed = JSON.parse(out && out.trim() ? out : '[]');
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.filter(Boolean).map((row) => ({
    pid: row.ProcessId,
    commandLine: row.CommandLine,
    creationDateMs: Date.parse(row.CreationDateIso),
  }));
}

// ── POSIX reader: `ps -eo pid,lstart,args` ───────────────────────────────────────────────
// kill-tree.mjs's own enumeration primitives (listPidPpidPairs, procStatFields) answer "who
// are pid X's descendants" for a KNOWN pid; they never read a command line, which this probe
// needs to find candidates in the first place. `lstart` is ctime-format ("Mon Sep 22
// 10:00:00 2026") — fixed-width enough to split off deterministically before the free-form
// `args` tail.
//
// plan 4087 review round 4 (finding coord-child-probe.mjs:99): `lstart`'s day/month names are
// LOCALIZED by `ps` (e.g. "lör 22 sep" on a Swedish box), which the fixed-English regex below
// cannot read — `LC_ALL=C` pins the format regardless of locale, merged into the existing env so
// PATH etc. still resolves.
export function listPosixProcessRows({ exec = execFileSync } = {}) {
  const out = exec('ps', ['-eo', 'pid,lstart,args'], {
    encoding: 'utf8',
    timeout: PROCESS_ENUMERATION_TIMEOUT_MS,
    env: { ...process.env, LC_ALL: 'C' },
  });
  const lines = String(out || '')
    .split('\n')
    .slice(1); // drop the header row
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(
      /^(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/,
    );
    if (!m) continue; // an unparseable row is skipped, not fatal to the whole probe
    rows.push({ pid: Number(m[1]), commandLine: m[3], creationDateMs: Date.parse(m[2]) });
  }
  return rows;
}

// Normalise a filesystem path (or a whole command line) for boundary matching — win32 ONLY:
// backslashes become forward slashes and the whole string is lower-cased, since NTFS/ReFS paths
// use either slash interchangeably and compare case-insensitively (a child spawned with a
// different drive-letter case, or a forward-slash spelling, or a different directory-segment
// case must still match). POSIX paths are left untouched: backslash is an ordinary filename
// character there, not a separator, and POSIX filesystems compare case-sensitively.
function normalizePathForMatch(s, platform) {
  const str = String(s);
  return platform === 'win32' ? str.replace(/\\/g, '/').toLowerCase() : str;
}

// plan 4087 review fix (1ih0n1u/nceh4n/iwtsw4/zq14ns/1d7x87q): whether `commandLine` targets
// `targetDir` — matched on a PATH BOUNDARY, never a bare substring. The pre-fix version
// (`commandLine.includes(coordDir)`) had three distinct bugs, all closed here: it matched a
// SIBLING directory whose name merely EXTENDS coordDir as a substring (e.g.
// ".claude/coord-worktree-old", or coordDir appearing inside an unrelated argument), it was
// CASE-SENSITIVE against Windows paths that compare case-insensitively, and it required the
// command line to carry the EXACT native slash spelling of `targetDir`.
//
// The fix: normalise both sides (see normalizePathForMatch) and require the match be flanked by
// a path/argument boundary — start-of-string, whitespace, a quote, `=` (an `--opt=path` form)
// before it, and end-of-string, whitespace, a quote, or `/` (a further path segment) after it.
//
// SPELLINGS THIS CATCHES: the directory embedded inside a quoted argument or ahead of a further
// path segment on any platform, and — win32 only — a different drive-letter case, forward-slash
// vs backslash spelling, or any case difference in the directory segments themselves.
// SPELLINGS THIS DOES NOT CATCH (an honest stated limit, not a silent one): an 8.3 short path
// (`COORD-~1`), a UNC form (`\\?\C:\...` or `\\server\share\...`) spelled differently from
// `targetDir`, a different drive letter mounting the SAME volume, or a relative path resolved
// against a cwd other than the one `targetDir` is already absolute against — none of these share
// a normalisable textual form with the absolute `targetDir` string this probe is handed.
export function commandLineTargetsPath(
  commandLine,
  targetDir,
  { platform = process.platform } = {},
) {
  if (typeof commandLine !== 'string' || !targetDir) return false;
  const hay = normalizePathForMatch(commandLine, platform);
  const needle = normalizePathForMatch(targetDir, platform);
  if (!needle) return false;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    const before = idx === 0 ? '' : hay[idx - 1];
    const after = idx + needle.length >= hay.length ? '' : hay[idx + needle.length];
    if ((before === '' || /[\s"'=]/.test(before)) && (after === '' || /[\s"'/]/.test(after))) {
      return true;
    }
    idx = hay.indexOf(needle, idx + 1);
  }
  return false;
}

// Dispatch to the platform-appropriate raw reader (unless `listRows` is injected directly —
// the seam a heal-main test uses so it never has to fake `process.platform` at all), filter to
// rows whose command line targets `coordDir` at a path boundary (commandLineTargetsPath), and
// compute each one's age against `now`.
export function listCoordChildren(
  coordDir,
  { now = Date.now(), platform = process.platform, listRows, exec } = {},
) {
  const reader = listRows || (() => listAllProcessRows({ platform, exec }));
  const rows = reader() || [];
  return rows
    .filter((row) => commandLineTargetsPath(row.commandLine, coordDir, { platform }))
    .map((row) => ({
      pid: row.pid,
      commandLine: row.commandLine,
      ageMs: Number.isFinite(row.creationDateMs) ? now - row.creationDateMs : null,
      // plan 4087 review round 2 (identity-check finding coord-child-probe.mjs:194/228): the raw
      // creation timestamp discovery read, carried alongside the derived `ageMs` so a LATER kill
      // attempt can re-read the same pid's CURRENT creation time and refuse to kill if it no
      // longer matches — see killProcessByPid's own header for why (pids get reused, especially
      // on Windows). `null` (never NaN) when the row's own creation date was unparseable.
      creationDateMs: Number.isFinite(row.creationDateMs) ? row.creationDateMs : null,
    }));
}

// plan 4087 review round 3 (efficiency e9c5aa/5dbc34), round 4 (reuse — three independent copies
// of this same win32-or-POSIX ternary had drifted into existence): the ONE platform dispatcher
// for "read every live process row, unfiltered" — listCoordChildren and currentProcessRow both
// call this instead of each hand-rolling their own copy.
export function listAllProcessRows({ platform = process.platform, exec } = {}) {
  return platform === 'win32' ? listWindowsProcessRows({ exec }) : listPosixProcessRows({ exec });
}

// `ms` → a short human string ("45s", "3min", "an unknown age" for a row whose creation date
// this probe could not parse). Shared by heal-main.mjs's report lines and the CLI.
export function formatAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return 'an unknown age';
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}min`;
}

// Read the CURRENT row for `pid`, right now — the default `_currentRow` for killProcessByPid's
// identity re-check below. It MUST re-read the SAME source discovery read, in the SAME shape:
// discovery's `creationDateMs` is epoch ms parsed from the CIM row on Windows and from
// `ps -o lstart` on POSIX, and `commandLine` is the same raw string discovery filtered on — so
// this re-runs that same platform reader (listAllProcessRows) and picks out the pid's row whole,
// not just one field of it (round 3 finding coord-child-probe.mjs:258 needs BOTH the start time
// and the command line off the SAME re-read, never two independent subprocess spawns). An
// earlier version read only the start time via kill-tree.mjs's `processStartTime` on POSIX, a
// raw /proc starttime in clock TICKS, which can never equal an epoch-ms value — every POSIX kill
// was refused as "identity changed"; that bug is why this reads through the SAME reader
// discovery uses, not a different primitive. Called fresh per pid, right before that pid's kill
// (round 4 fix — see killHungCoordChildren's own header for the stale-batch-snapshot it replaced).
// Returns null (never throws) when the pid cannot be found or its row cannot be read —
// killProcessByPid treats that as "cannot confirm identity", same as a mismatch.
export function currentProcessRow(pid, { platform = process.platform, exec } = {}) {
  try {
    return listAllProcessRows({ platform, exec }).find((r) => r.pid === pid) ?? null;
  } catch {
    return null;
  }
}

// plan 4087 review fix (lrgecf/1ms5c76/g7cc53): the default kill, BY PID — actually terminates
// the process on both platforms. A probe-discovered pid (from the Windows CIM reader or the
// POSIX `ps` reader above) is never a real ChildProcess, so routing it through kill-tree.mjs's
// killProcessTree (which POSIX-branches to `proc.kill(signal)`, a method a plain object does not
// have) silently did nothing on POSIX — the TypeError landed in killProcessTree's own outer
// try/catch, which exists to swallow "already dead" races, not a missing method.
//
// plan 4087 review round 2 (identity-check finding coord-child-probe.mjs:194/228): a pid is
// enumerated at discovery time, and by the time the kill actually runs (report → decide →
// kill) the OS may have reused that pid number for an unrelated process — pids get reused
// especially on Windows. `expectedStartTime` is the identity token discovery recorded
// (listCoordChildren's `creationDateMs`); when supplied, this re-reads the pid's CURRENT row via
// `_currentRow` and REFUSES to kill on any mismatch — including "the pid can no longer be found
// at all", which is not evidence of anything except that there is nothing of ours left to kill.
// Callers that never had discovery data (no `expectedStartTime`) get the old unchecked
// behaviour — this is an additive safety check, not a new requirement to call this function at
// all.
//
// plan 4087 review round 3 (finding coord-child-probe.mjs:258 — second-resolution identity):
// `ps -o lstart` (and the CIM `CreationDate` parsed from it) is only ONE-SECOND precise, so a
// pid recycled to an unrelated process WITHIN the same rounded second still carries the exact
// same recorded start time and would pass a start-time-only check. `coordDir`, when supplied
// alongside `expectedStartTime`, ALSO requires the pid's CURRENT command line to still target
// that path (the same boundary-matching `commandLineTargetsPath` discovery itself filters on) —
// an unrelated process coincidentally sharing both the rounded start second AND a command line
// targeting this exact directory is not a realistic collision.
//
// plan 4087 review round 4 (finding coord-child-probe.mjs:311/312 — a documented-optional
// fallback that never fires): `coordDir` used to be described as optional with a start-time-only
// fallback, but `commandLineTargetsPath(current.commandLine, coordDir, …)` returns `false`
// whenever `coordDir` is falsy — so "omitted" and "present but wrong" were silently the SAME
// outcome, and the fallback never fired. `coordDir` is now REQUIRED whenever `expectedStartTime`
// is supplied — this throws a clear error instead. A caller that supplies neither still skips the
// identity check entirely, exactly as before; killHungCoordChildren below always supplies both.
//
// Once identity is confirmed (or was never asked to be checked), the actual mechanics —
// win32 `taskkill /pid <p> /T /F`, POSIX SIGKILL of the pid plus a best-effort SIGKILL of its
// descendant tree — are kill-tree.mjs's own killProcessTreeByPid (plan 4087 review round 2
// reuse finding: this module used to hand-roll a SECOND copy of that walk, which had dropped
// kill-tree.mjs's self-pid guard).
//
// Returns `{ ok, reason }`: `reason` is `'killed'` on success, `'identity-changed'` when the
// pre-kill re-check refused, `'kill-failed'` when the kill itself was attempted but did not
// succeed (already dead, permission blip), or `'descendants-survived'` (plan 4087 review round 3,
// finding kill-tree.mjs:427/428; widened round 4, finding kill-tree.mjs:454) when the target pid
// itself died but killProcessTreeByPid could not confirm every descendant dead — either a
// signalled descendant survived (`descendantsFailed` carries its pid list) or the descendant
// ENUMERATION ITSELF failed (`enumerationFailed`, `descendantsFailed: []` — we never got far
// enough to know which pids to check). Both mean the same thing to a caller: not a confirmed-clean
// kill. Four genuinely different outcomes (see killHungCoordChildren below, and heal-main.mjs's
// report line) that must never collapse into one.
//
// `platform`/`_processKill`/`_taskkill`/`_listPairs`/`_currentRow` are testability seams so
// every branch is exercisable from either host with that platform's REAL symbols injected — per
// vetapp CLAUDE.md, never a bare `process.platform` fake. `_taskkill` carries no local default
// (same reasoning as `_listPairs` below): undefined forwards straight through to
// killProcessTreeByPid's own default, the one place that mechanic should live — this module used
// to hand-roll a second, `execFileSync`-based taskkill wrapper here specifically because
// kill-tree.mjs's own default silently ignored taskkill's exit status (round 3 finding
// kill-tree.mjs:386); now that that default itself checks and throws on failure, keeping a
// second implementation here would only be the exact duplicate-mechanics drift this file's
// header already warns against.
export function killProcessByPid(
  pid,
  {
    platform = process.platform,
    signal = 'SIGKILL',
    expectedStartTime,
    coordDir,
    exec,
    _processKill = (p, s) => process.kill(p, s),
    _taskkill,
    // No local default here — undefined forwards straight through to killProcessTreeByPid's
    // own default (kill-tree.mjs's listPidPpidPairs), the one place that primitive should live.
    _listPairs,
    _currentRow = (p) => currentProcessRow(p, { platform, exec }),
  } = {},
) {
  if (expectedStartTime != null) {
    // round 4 fix (coord-child-probe.mjs:311/312, see header above): a caller-programming error,
    // not a runtime race — throws rather than a silent, permanent identity-changed refusal.
    if (!coordDir) {
      throw new Error(
        'killProcessByPid: coordDir is required whenever expectedStartTime is supplied — ' +
          "the identity check has no start-time-only fallback (see this function's header)",
      );
    }
    let current;
    try {
      current = _currentRow(pid);
    } catch {
      current = null; // a failed identity re-read is "cannot confirm" — refuse, same as a mismatch
    }
    // Both sides of the start-time comparison are epoch ms from the same platform reader
    // (currentProcessRow above); an exact match is necessary but — per the round-3 header above
    // — no longer sufficient on its own.
    const sameStart =
      current != null && String(current.creationDateMs) === String(expectedStartTime);
    const stillTargetsCoordDir =
      current != null && commandLineTargetsPath(current.commandLine, coordDir, { platform });
    if (!sameStart || !stillTargetsCoordDir) {
      return { ok: false, reason: 'identity-changed' };
    }
  }
  const treeResult = killProcessTreeByPid(pid, {
    platform,
    signal,
    _processKill,
    _taskkill,
    _listPairs,
  });
  if (!treeResult.ok) return { ok: false, reason: 'kill-failed' };
  // plan 4087 review round 4 (finding kill-tree.mjs:454): an enumeration failure is exactly as
  // uncertain as a signalled descendant that survived — neither lets us say the tree is clean.
  if (treeResult.descendantsFailed.length || treeResult.enumerationFailed) {
    return {
      ok: false,
      reason: 'descendants-survived',
      descendantsFailed: treeResult.descendantsFailed,
    };
  }
  return { ok: true, reason: 'killed' };
}

// Opt-in kill (heal-main's `--kill-hung-coord-children`, never default): kill only the
// children in `children` whose ageMs is >= ageMs, by pid (killProcessByPid above), re-checking
// each one's identity against what discovery recorded (`creationDateMs` + the coord checkout
// path) immediately before the kill. `ageMs` is REQUIRED (see HUNG_COORD_CHILD_KILL_AGE_MS
// above) — this throws rather than guess a number.
//
// plan 4087 review round 2 (finding coord-child-probe.mjs:250/251): returns every ELIGIBLE
// child (age at/above the ceiling), each annotated with the true outcome (`reason` — see
// killProcessByPid's own header for the four values) — never silently reported as killed when
// the kill itself failed or was refused. A child below the age ceiling is simply absent from the
// result, same as before this fix — callers distinguish "never attempted" (not in the array)
// from "attempted and failed" (in the array with `reason !== 'killed'`). Plan 4087 review round
// 3 (finding coord-child-probe.mjs:298, simplification): `killed` used to ride alongside
// `reason` as a second, fully-derivable field — dropped; a reader checks `reason === 'killed'`.
//
// plan 4087 review round 4 (finding coord-child-probe.mjs:397, angle-B/C/altitude — a stale batch
// snapshot): round 3 read the live process table ONCE for the whole batch and reused it for every
// eligible child's identity check, so a later kill could be confirmed against an increasingly
// stale picture. Kills are opt-in and rare, so the simple read is also the correct one: each
// child's identity is checked with its own fresh, current read, right before ITS kill (`exec`
// threads through to killProcessByPid's own default `_currentRow` — see currentProcessRow's
// header). A failed read for one child degrades only that child to a safe identity-changed
// refusal, never any other child's.
//
// `_kill` is a testability seam (default killProcessByPid) so a test can assert WHICH children
// were selected and with what outcome, without spawning taskkill/SIGKILL for real.
export function killHungCoordChildren(
  children,
  ageMs,
  { platform = process.platform, exec, coordDir, _kill = killProcessByPid } = {},
) {
  if (ageMs == null || !Number.isFinite(ageMs)) {
    throw new Error(
      'killHungCoordChildren: no kill-age ceiling supplied (plan 4087 T1 has not landed a ' +
        'measured default yet) — pass an explicit ageMs',
    );
  }
  const eligible = children.filter((child) => child.ageMs != null && child.ageMs >= ageMs);
  return eligible.map((child) => {
    const outcome = _kill(child.pid, {
      platform,
      exec,
      expectedStartTime: child.creationDateMs,
      coordDir,
    });
    return {
      ...child,
      reason: outcome?.reason ?? 'kill-failed',
      ...(outcome?.descendantsFailed ? { descendantsFailed: outcome.descendantsFailed } : {}),
    };
  });
}
