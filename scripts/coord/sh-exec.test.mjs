// scripts/sh-exec.test.mjs — name-pair of the new scripts/coord/sh-exec.mjs module (plan 3219).
// (That name-pairing is the standing justification for a NEW battery test file; there is no
// existing file whose module these cases belong to.)
//
// Every case injects `platform` and `env` explicitly and drives the spawn through the
// module's `_execFileSync` seam, so the whole file is platform-parameterized and spawns
// nothing real — it asserts the same things on Windows, Linux and macOS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bashExe,
  gitTopDirs,
  pathKeyOf,
  resetShExeCache,
  shCandidates,
  shellChildPath,
  shellEnv,
  shExe,
} from './sh-exec.mjs';

// A PowerShell-shaped Windows env: Git's `cmd` dir is on PATH, `usr\bin` is NOT.
const PWSH_ENV = {
  PATH: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd;C:\\Program Files\\nodejs',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\X\\AppData\\Local',
};

// The conventional-install shell, pinned into shellChildPath's `shell` option so these cases
// assert composition without paying (or depending on) a real resolution probe.
const PF_SH = 'C:\\Program Files\\Git\\usr\\bin\\sh.exe';

// A Git-Bash-shaped Windows env: Node still reports a Windows-form PATH, but the MSYS bin
// dirs are on it. This is the shape every currently-green run already has.
const GITBASH_ENV = {
  PATH:
    'C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\Git\\usr\\bin;' +
    'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',
  ProgramFiles: 'C:\\Program Files',
};

// ── shCandidates ──────────────────────────────────────────────────────────────

test('shCandidates: a non-Windows platform has the bare name ONLY (no Git-for-Windows paths)', () => {
  assert.deepEqual(shCandidates('sh', { platform: 'linux', env: PWSH_ENV }), ['sh']);
  assert.deepEqual(shCandidates('bash', { platform: 'darwin', env: PWSH_ENV }), ['bash']);
});

test('shCandidates: win32 leads with the Git-derived usr\\bin exe and keeps the bare name LAST', () => {
  const cands = shCandidates('bash', { platform: 'win32', env: PWSH_ENV });
  assert.equal(cands[0], 'C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  assert.equal(
    cands[cands.length - 1],
    'bash',
    'the bare name is the LAST resort — C:\\Windows\\System32\\bash.exe (WSL) would otherwise win it',
  );
  assert.ok(
    cands.every((c) => c === 'bash' || /\\usr\\bin\\bash\.exe$/.test(c)),
    `every explicit candidate is a usr\\bin exe, never bin\\ (which prepends its own PATH): ${cands}`,
  );
});

test('shCandidates: the name is honoured — sh resolves sh.exe, not bash.exe', () => {
  const cands = shCandidates('sh', { platform: 'win32', env: PWSH_ENV });
  assert.equal(cands[0], 'C:\\Program Files\\Git\\usr\\bin\\sh.exe');
});

// ── gitTopDirs ────────────────────────────────────────────────────────────────

test('gitTopDirs: PATH-proven roots come first, then the conventional install locations', () => {
  const roots = gitTopDirs(PWSH_ENV);
  assert.equal(roots[0], 'C:\\Program Files\\Git', 'the PATH-proven root leads');
  assert.ok(
    roots.includes('C:\\Users\\X\\AppData\\Local\\Programs\\Git'),
    `the per-user install location is a fallback candidate: ${roots}`,
  );
});

test('gitTopDirs: a root proven twice by PATH is not duplicated (case-insensitive)', () => {
  const roots = gitTopDirs({
    PATH: 'C:\\Program Files\\Git\\cmd;c:\\program files\\git\\usr\\bin',
    ProgramFiles: 'C:\\Program Files',
  });
  assert.equal(roots.length, 1, `one install, one root: ${roots}`);
});

test('gitTopDirs: no Git anywhere on PATH still yields the conventional locations', () => {
  const roots = gitTopDirs({ PATH: 'C:\\Windows\\system32', ProgramFiles: 'C:\\Program Files' });
  assert.deepEqual(roots, ['C:\\Program Files\\Git']);
});

test('gitTopDirs: an env with neither PATH nor the location vars yields nothing (no crash)', () => {
  assert.deepEqual(gitTopDirs({}), []);
});

test('gitTopDirs: a PORTABLE install whose root is not named "Git" is still found', () => {
  const roots = gitTopDirs({ PATH: 'C:\\Windows\\system32;D:\\Tools\\PortableGit-2.49\\cmd' });
  assert.deepEqual(roots, ['D:\\Tools\\PortableGit-2.49']);
});

test('gitTopDirs: a Git-NAMED root outranks a loose one found earlier on PATH', () => {
  const roots = gitTopDirs({ PATH: 'D:\\Tools\\PortableGit\\cmd;C:\\Program Files\\Git\\cmd' });
  assert.deepEqual(roots, ['C:\\Program Files\\Git', 'D:\\Tools\\PortableGit']);
});

// VETAPP_GIT_ROOT carries forward the escape hatch retired with plan 3099's
// test-helpers/resolve-git-bash.mjs (`GUARD_TEST_BASH`), widened from an executable to a root
// so shellChildPath() can also reach that install's coreutils.
test('gitTopDirs: VETAPP_GIT_ROOT outranks every discovered root', () => {
  const roots = gitTopDirs({
    VETAPP_GIT_ROOT: 'E:\\odd\\Git',
    PATH: 'C:\\Program Files\\Git\\cmd',
    ProgramFiles: 'C:\\Program Files',
  });
  assert.equal(roots[0], 'E:\\odd\\Git', 'the explicit override must be tried first');
  assert.ok(roots.includes('C:\\Program Files\\Git'), 'discovery still contributes behind it');
});

test('gitTopDirs: VETAPP_GIT_ROOT is not duplicated when PATH proves the same root', () => {
  const roots = gitTopDirs({
    VETAPP_GIT_ROOT: 'C:\\Program Files\\Git',
    PATH: 'c:\\program files\\git\\cmd',
  });
  assert.deepEqual(roots, ['C:\\Program Files\\Git']);
});

test('shCandidates: VETAPP_GIT_ROOT reaches BOTH sh and bash, not just bash', () => {
  const env = { VETAPP_GIT_ROOT: 'E:\\odd\\Git', PATH: '' };
  assert.equal(shCandidates('sh', { platform: 'win32', env })[0], 'E:\\odd\\Git\\usr\\bin\\sh.exe');
  assert.equal(
    shCandidates('bash', { platform: 'win32', env })[0],
    'E:\\odd\\Git\\usr\\bin\\bash.exe',
  );
});

// ── shExe / bashExe ───────────────────────────────────────────────────────────

test('shExe: the first candidate that launches wins, and the probe is memoized', () => {
  resetShExeCache();
  const probed = [];
  const _execFileSync = (cand) => {
    probed.push(cand);
    if (cand.startsWith('C:\\Program Files')) throw new Error('ENOENT');
    return '';
  };
  const first = shExe('sh', { _execFileSync, platform: 'win32', env: PWSH_ENV });
  assert.equal(first, 'C:\\Users\\X\\AppData\\Local\\Programs\\Git\\usr\\bin\\sh.exe');
  assert.deepEqual(probed, [
    'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
    'C:\\Users\\X\\AppData\\Local\\Programs\\Git\\usr\\bin\\sh.exe',
  ]);
  const second = shExe('sh', { _execFileSync, platform: 'win32', env: PWSH_ENV });
  assert.equal(second, first);
  assert.equal(probed.length, 2, 'the memo must not re-probe');
  resetShExeCache();
});

test('shExe: on win32 the BARE name must prove it is an MSYS shell, not WSL bash', () => {
  resetShExeCache();
  const scripts = new Map();
  const _execFileSync = (cand, args) => {
    scripts.set(cand, args[1]);
    throw new Error('ENOENT');
  };
  shExe('bash', { _execFileSync, platform: 'win32', env: PWSH_ENV });
  assert.equal(
    scripts.get('C:\\Program Files\\Git\\usr\\bin\\bash.exe'),
    'exit 0',
    'an explicit Git path needs no identity proof',
  );
  assert.match(
    scripts.get('bash'),
    /OSTYPE/,
    'the bare name must be identity-checked — C:\\Windows\\System32\\bash.exe passes `exit 0`',
  );
  resetShExeCache();
});

test('shExe: the memo is keyed by the CANDIDATES, so a different install location re-resolves', () => {
  resetShExeCache();
  const _execFileSync = (cand) => {
    if (!cand.startsWith('C:\\Users\\Y')) throw new Error('ENOENT');
    return '';
  };
  const samePathOtherInstall = { ...PWSH_ENV, LOCALAPPDATA: 'C:\\Users\\Y\\AppData\\Local' };
  assert.equal(shExe('sh', { _execFileSync, platform: 'win32', env: PWSH_ENV }), 'sh');
  assert.equal(
    shExe('sh', { _execFileSync, platform: 'win32', env: samePathOtherInstall }),
    'C:\\Users\\Y\\AppData\\Local\\Programs\\Git\\usr\\bin\\sh.exe',
    'same PATH, different install location — a PATH-only memo key would serve the stale answer',
  );
  resetShExeCache();
});

test('shExe: the memo is keyed by ENVIRONMENT, not by name alone', () => {
  resetShExeCache();
  const _execFileSync = (cand) => {
    if (!cand.startsWith('D:\\')) throw new Error('ENOENT');
    return '';
  };
  const other = { PATH: 'D:\\Tools\\PortableGit\\cmd' };
  assert.equal(shExe('sh', { _execFileSync, platform: 'win32', env: PWSH_ENV }), 'sh');
  assert.equal(
    shExe('sh', { _execFileSync, platform: 'win32', env: other }),
    'D:\\Tools\\PortableGit\\usr\\bin\\sh.exe',
    'a second env must be resolved on its own merits, not served the first env’s answer',
  );
  resetShExeCache();
});

test('shExe: the probe is bounded by a timeout — a blocked shell must not hang the process', () => {
  resetShExeCache();
  const seen = [];
  const _execFileSync = (cand, args, opts) => {
    seen.push(opts);
    return '';
  };
  shExe('sh', { _execFileSync, platform: 'win32', env: PWSH_ENV });
  assert.ok(seen[0].timeout > 0, `the probe must pass a timeout: ${JSON.stringify(seen[0])}`);
  resetShExeCache();
});

test('shExe: when NOTHING launches it returns the bare name, so the caller sees an honest ENOENT', () => {
  resetShExeCache();
  const _execFileSync = () => {
    throw new Error('ENOENT');
  };
  assert.equal(shExe('sh', { _execFileSync, platform: 'win32', env: PWSH_ENV }), 'sh');
  resetShExeCache();
});

test('shExe/bashExe: sh and bash memoize independently (one name never answers for the other)', () => {
  resetShExeCache();
  const _execFileSync = (cand) => {
    if (cand === 'sh' || cand === 'bash') throw new Error('ENOENT');
    return '';
  };
  const opts = { _execFileSync, platform: 'win32', env: PWSH_ENV };
  assert.equal(shExe('sh', opts), 'C:\\Program Files\\Git\\usr\\bin\\sh.exe');
  assert.equal(bashExe(opts), 'C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  resetShExeCache();
});

// A bare name that LAUNCHED and proved it is NOT an MSYS shell is worse than no shell: a
// guard hook run under WSL writes nothing to stdout, which every guard test here reads as
// "the guard allowed it". Exit 9 is MSYS_PROOF_SCRIPT's own verdict.
test('shExe: a bare name PROVEN to be WSL is never returned — the fallback becomes a Git path', () => {
  resetShExeCache();
  const _execFileSync = (cand) => {
    if (cand === 'bash') {
      const e = new Error('not msys');
      e.status = 9;
      throw e;
    }
    throw new Error('ENOENT');
  };
  assert.equal(
    shExe('bash', { _execFileSync, platform: 'win32', env: PWSH_ENV }),
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'the refuted bare name must not be handed back as the answer',
  );
  resetShExeCache();
});

test('shExe: a bare name that merely FAILED TO LAUNCH is still the honest-ENOENT fallback', () => {
  resetShExeCache();
  const _execFileSync = () => {
    const e = new Error('spawn ENOENT'); // no `.status` — never ran, so nothing was disproved
    e.code = 'ENOENT';
    throw e;
  };
  assert.equal(shExe('bash', { _execFileSync, platform: 'win32', env: PWSH_ENV }), 'bash');
  resetShExeCache();
});

test('shExe: the memo key includes PATH — the bare name resolves through it at spawn time', () => {
  resetShExeCache();
  const _execFileSync = (cand, args) => {
    // Same candidate list both times (no Git root on either PATH); only PATH differs, and
    // `bash` is an MSYS shell on the second one.
    if (cand !== 'bash') throw new Error('ENOENT');
    if (!args[1].includes('OSTYPE')) throw new Error('unexpected script');
    throw Object.assign(new Error('not msys'), { status: 9 });
  };
  const bare = { PATH: 'C:\\Windows\\system32' };
  const withGitBash = { PATH: 'C:\\Windows\\system32;C:\\Program Files\\Git\\usr\\bin' };
  assert.equal(shExe('bash', { _execFileSync, platform: 'win32', env: bare }), 'bash');
  const second = shExe('bash', {
    _execFileSync: (cand) => {
      if (cand === 'bash') return '';
      throw new Error('ENOENT');
    },
    platform: 'win32',
    env: withGitBash,
  });
  assert.equal(second, 'bash', 'a different PATH must be resolved on its own merits');
  resetShExeCache();
});

test('shExe: probing is bounded by ONE budget across candidates, not per candidate', () => {
  resetShExeCache();
  const timeouts = [];
  const _execFileSync = (cand, args, opts) => {
    timeouts.push(opts.timeout);
    throw new Error('ENOENT');
  };
  const many = {
    PATH: 'D:\\A\\Git\\cmd;D:\\B\\Git\\cmd;D:\\C\\Git\\cmd',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\X\\AppData\\Local',
  };
  shExe('sh', { _execFileSync, platform: 'win32', env: many });
  assert.ok(timeouts.length > 1, 'several candidates were probed');
  assert.ok(
    timeouts.reduce((a, b) => a + b, 0) <= timeouts.length * 15000,
    'each probe is capped at the per-probe ceiling',
  );
  assert.ok(
    timeouts.every((t) => t > 0 && t <= 20000),
    'no probe may be granted more than the whole shared budget',
  );
  resetShExeCache();
});

// ── shellChildPath ────────────────────────────────────────────────────────────

test('shellChildPath: on a non-Windows platform it is exactly prefix + the caller PATH', () => {
  const out = shellChildPath(['/fake/bin'], {
    platform: 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin' },
  });
  // path-assert-ok: the POSIX spelling IS the case — `platform: 'linux'` is injected above, and
  // shellChildPath only joins strings (no fs, no path primitive), so this is byte-exact by design.
  assert.equal(out, '/fake/bin:/usr/local/bin:/usr/bin');
});

test('shellChildPath: a Git-Bash caller PATH gains only the prefix (its MSYS dirs are already there)', () => {
  const out = shellChildPath(['C:\\fake\\bin'], {
    platform: 'win32',
    env: GITBASH_ENV,
    shell: PF_SH,
  });
  assert.equal(out, `C:\\fake\\bin;${GITBASH_ENV.PATH}`);
});

test('shellChildPath: a STALE foreign Git usr\\bin on PATH does not suppress the resolved install', () => {
  // The regression this pins: testing for "any Git usr\bin on PATH" let a dead install
  // stand in for the live one, leaving the resolved shell without its own coreutils.
  const env = { PATH: 'D:\\Old\\Git\\usr\\bin;C:\\Windows\\system32' };
  const out = shellChildPath([], { platform: 'win32', env, shell: PF_SH });
  assert.equal(
    out,
    `C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\Git\\usr\\bin;${env.PATH}`,
  );
});

test('shellChildPath: `name` selects the shell being composed for — bash, not always sh', () => {
  const probed = [];
  const _execFileSync = (cand) => {
    probed.push(cand);
    return '';
  };
  resetShExeCache();
  shellChildPath([], { platform: 'win32', env: PWSH_ENV, name: 'bash', _execFileSync });
  assert.ok(
    probed[0].endsWith('bash.exe'),
    `a bash-named composition must resolve bash: ${probed[0]}`,
  );
  resetShExeCache();
});

test('shellChildPath: a PowerShell caller PATH gets the MSYS bin dirs BEHIND the prefix, AHEAD of Windows', () => {
  const out = shellChildPath(['C:\\fake\\bin'], { platform: 'win32', env: PWSH_ENV, shell: PF_SH });
  assert.equal(
    out,
    'C:\\fake\\bin;C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\Git\\usr\\bin;' +
      PWSH_ENV.PATH,
    'prefix, then MSYS, then the caller PATH — the ordering is the whole point',
  );
  assert.ok(
    out.indexOf('Git\\usr\\bin') < out.indexOf('C:\\Windows\\system32'),
    'MSYS must beat system32, whose sort.exe/find.exe answer POSIX flags with an error',
  );
});

test('shellChildPath: on win32 every entry stays a WINDOWS path in a `;`-joined list', () => {
  // Both halves matter: a POSIX `/usr/bin` entry is invisible to .NET Process.Start (which
  // prepush-job-wrapper.ps1 uses to start `sh`), and a `C:\…` entry inside a `:`-joined
  // list gets split at its drive colon.
  const out = shellChildPath(['C:\\fake\\bin'], { platform: 'win32', env: PWSH_ENV, shell: PF_SH });
  assert.ok(!out.includes('/'), `no POSIX-form entry may leak in: ${out}`);
  for (const entry of out.split(';')) {
    assert.match(entry, /^[A-Za-z]:\\/, `every entry is an absolute Windows path: ${entry}`);
  }
});

test('shellChildPath: the MSYS dirs come from the RESOLVED shell, not the first Git root on PATH', () => {
  // The stale-install case: `D:\OldGit\cmd` sits ahead of a working install, so shExe()
  // falls through to the second one. Pairing that shell with the FIRST root's coreutils
  // would put sed/grep/awk back out of reach — the exact failure this pins against.
  const env = { PATH: 'D:\\OldGit\\cmd;C:\\Program Files\\Git\\cmd' };
  const out = shellChildPath([], { platform: 'win32', env, shell: PF_SH });
  assert.equal(
    out,
    `C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\Git\\usr\\bin;${env.PATH}`,
  );
  assert.ok(!out.startsWith('D:\\OldGit'), 'the stale root must not supply the coreutils');
});

test('shellChildPath: a bare-name shell (resolution failed) adds NO guessed install', () => {
  const out = shellChildPath([], { platform: 'win32', env: PWSH_ENV, shell: 'sh' });
  assert.equal(out, PWSH_ENV.PATH, 'no install was resolved, so none may be named');
});

test('shellChildPath: win32 with NO Git install anywhere adds nothing it cannot name', () => {
  const out = shellChildPath([], {
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\system32' },
    shell: 'sh',
  });
  assert.equal(out, 'C:\\Windows\\system32');
});

test('shellChildPath: no prefix and an empty PATH does not emit a stray empty entry', () => {
  assert.equal(shellChildPath([], { platform: 'linux', env: {} }), '');
});

// Presence is not precedence: system32 ships its own sort.exe/find.exe, so MSYS dirs sitting
// BEHIND it on PATH are shadowed exactly as if they were absent.
test('shellChildPath: MSYS dirs already on PATH but BEHIND system32 are hoisted in front of it', () => {
  const behind = {
    PATH:
      'C:\\Windows\\system32;C:\\Program Files\\Git\\mingw64\\bin;' +
      'C:\\Program Files\\Git\\usr\\bin',
    ProgramFiles: 'C:\\Program Files',
  };
  const out = shellChildPath([], { platform: 'win32', env: behind, shell: PF_SH });
  assert.equal(
    out,
    'C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\system32',
    'the resolved install must beat system32, and its old later copies must not linger',
  );
});

test('shellChildPath: hoisting is idempotent — the same dirs are not duplicated', () => {
  const once = shellChildPath([], { platform: 'win32', env: GITBASH_ENV, shell: PF_SH });
  const twice = shellChildPath([], {
    platform: 'win32',
    env: { ...GITBASH_ENV, PATH: once },
    shell: PF_SH,
  });
  // path-assert-ok: BYTE-identity is the assertion, not path equivalence — idempotence means
  // re-composing an already-composed PATH changes nothing at all. `platform: 'win32'` is
  // injected on both calls and shellChildPath only joins strings (no fs, no path primitive),
  // so normalizing here would weaken the case into one a duplicate entry could pass.
  assert.equal(twice, once);
});

// ── pathKeyOf / shellEnv ──────────────────────────────────────────────────────

test('pathKeyOf: finds whichever case variant the env actually carries', () => {
  assert.equal(pathKeyOf({ Path: 'x' }, 'win32'), 'Path', 'Windows spreads process.env as `Path`');
  assert.equal(pathKeyOf({ PATH: 'x' }, 'win32'), 'PATH');
  assert.equal(pathKeyOf({}, 'win32'), 'PATH', 'a PATH-less env still gets a canonical key');
  assert.equal(
    pathKeyOf({ Path: 'a', PATH: 'b' }, 'win32'),
    'PATH',
    'an exact PATH always wins — `{...process.env, PATH: x}` means x',
  );
});

test('pathKeyOf: on POSIX a lowercase `path` is an ordinary variable, never THE PATH', () => {
  assert.equal(pathKeyOf({ path: '/x' }, 'linux'), 'PATH');
  assert.equal(pathKeyOf({ Path: '/x' }, 'darwin'), 'PATH');
});

test('shellEnv: on win32 a base carrying BOTH Path and PATH ends up with exactly one', () => {
  // `{...process.env, PATH: override}` is the shape that produces this on Windows; leaving
  // both lets the OS resolve the case-insensitive collision to the stale value, which
  // silently discards the fake-bin and MSYS dirs composed here.
  const out = shellEnv({ Path: 'C:\\Windows\\system32', PATH: 'C:\\override', OTHER: 'keep' }, [], {
    platform: 'win32',
    shell: 'sh',
  });
  assert.deepEqual(
    Object.keys(out).filter((k) => /^path$/i.test(k)),
    ['PATH'],
  );
  assert.equal(out.PATH, 'C:\\override', 'the surviving value is the one the caller assigned');
  assert.equal(out.OTHER, 'keep');
});

test('shellEnv: writes back to the SAME key, so the child never receives Path AND PATH', () => {
  const out = shellEnv({ Path: 'C:\\Windows\\system32', OTHER: 'keep' }, ['C:\\fake\\bin'], {
    platform: 'win32',
  });
  assert.equal(Object.keys(out).filter((k) => /^path$/i.test(k)).length, 1);
  assert.equal(out.OTHER, 'keep', 'unrelated vars survive');
  assert.ok(out.Path.startsWith('C:\\fake\\bin;'));
});

test('shellEnv: the base env is not mutated', () => {
  const base = { PATH: '/usr/bin' };
  shellEnv(base, ['/fake'], { platform: 'linux' });
  assert.equal(base.PATH, '/usr/bin');
});

// shellEnv IS a child-env seam — its callers hand it process.env and spawn the real hooks
// with the result — so it owes the same scrub as every other one. plan 3832 retired
// ALLOW_LANDED_REVERSION with the landed-reversion halt it released, and CHILD_ENV_STRIP (the
// base list shellEnv's bare `childEnv(base)` call draws from) is now `[]` — see child-env.mjs's
// own comment. So there is no longer a named var shellEnv's own call site strips on its own; what
// survives, and what this now pins, is the MECHANISM underneath it — `childEnv()`'s explicit
// `names` strip, the same one CHILD_ENV_STRIP used to populate and any future in-process-only var
// would use again.
test('shellEnv: routes an ordinary var through untouched now that CHILD_ENV_STRIP is empty, and the underlying childEnv() explicit-name strip still works', async () => {
  const { childEnv } = await import('./child-env.mjs');
  const out = shellEnv({ PATH: '/usr/bin', KEEP: 'yes' }, [], { platform: 'linux' });
  assert.equal(out.KEEP, 'yes', 'everything survives shellEnv with an empty CHILD_ENV_STRIP');
  // The seam shellEnv is built on still supports scrubbing an explicitly-named in-process-only
  // var — shellEnv's own call site (`childEnv(base)`, no extra options) just has none to pass.
  assert.equal(
    childEnv(
      { PATH: '/usr/bin', SOME_IN_PROCESS_ONLY_VAR: '1' },
      {
        names: ['SOME_IN_PROCESS_ONLY_VAR'],
      },
    ).SOME_IN_PROCESS_ONLY_VAR,
    undefined,
    'an explicitly-named var is still stripped by the mechanism shellEnv relies on',
  );
});
