#!/usr/bin/env node
// scripts/coord/smoke.mjs — the coord-kit's fresh-clone smoke test (plan 3958).
//
// Proves the seven coordination lanes actually work end to end on a BRAND-NEW repo, not just
// that the files exist: mint -> claim -> cut -> commit -> review -> land -> assert. It builds a
// disposable bare "origin" + a `git init`ed demo project in a scratch tmp dir, runs
// `coord-init.mjs --target <demo>` to adopt the kit into it (exactly the flow a real adopter
// would run), then drives the seven steps as real subprocesses of the demo repo's OWN copies of
// the shipped commands.
//
// A step whose command was not shipped in THIS kit build (module-graph found its closure escapes
// scripts/coord/**, e.g. next-plan-id/record-review/done-worktree at the plan-3958 sha — see the
// build brief's "Measured facts") is not a failure of the smoke test itself: it is recorded
// `{ ok:false, exitCode:null, note:"command not shipped: <name>" }` and the run stops there,
// exit 3 (BLOCKED) — distinct from exit 1 (a shipped step that genuinely failed). Exit 0 only
// when all seven steps ran and passed. This is why running this file against the REAL kit at
// this sha stops at "mint" with exit 3: next-plan-id.mjs is not shipped yet.
//
// The step runner (`runSteps`) is a PURE function over `{ name, run(ctx) }` records — it knows
// nothing about git, npm, or file existence, only "run the next step, stop on the first failure,
// pick exit 3 vs exit 1 from whether that failure was itself a `blocked` one". That is what makes
// it unit-testable with fake steps (smoke.test.mjs) instead of only through a real, slow,
// network-touching end-to-end run.
//
// Usage:
//   node scripts/coord/smoke.mjs [--kit <dir>] [--keep] [--json] [--no-install]
//     --kit <dir>     the kit checkout to smoke-test (default: two directories up from this
//                      file, i.e. this file's own kit — coord-init.mjs locates itself the same
//                      way, see its own header).
//     --keep           don't delete the scratch tmp dir afterwards; its path is printed.
//     --json           print `{ kit, demo, records, exitCode }` instead of one line per step.
//     --no-install     skip `pnpm install` in the demo repo (for a fast/offline test run — the
//                       seven coordination commands don't need node_modules to run themselves,
//                       only a project's own build/test gates would).
//
// Exit codes: 0 all seven steps passed; 1 a shipped step failed; 2 setup itself failed (no
// coord-init.mjs under --kit, git/npm plumbing error); 3 a step's command was not shipped.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnEnv, gitRepoIsolatedEnv } from './child-env.mjs';
import { loadCoordConfig } from './coord-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// This file lives at <kit>/scripts/coord/smoke.mjs — two levels up is the kit root, the same
// self-location convention coord-init.mjs uses (see its own header).
const DEFAULT_KIT_DIR = resolvePath(__dirname, '..', '..');

const LAND_TIMEOUT_MS = 30 * 60 * 1000; // done-worktree is normally `timeout 14400`-wrapped at
// the top level; a generous but bounded cap here, since this is not a top-level land (see the
// build brief: "call it directly with spawnSync and a generous timeout option").

// ── the pure step runner ──────────────────────────────────────────────────────────────────────
//
// `steps` is an ordered list of `{ name, run(ctx) }`; `run` may be async and returns
// `{ ok, exitCode, note, blocked? }`. Stops at the first `!ok` step: `blocked` (a step whose
// command file was absent) picks exit 3, anything else picks exit 1. `records` mirrors only the
// steps that actually ran — a step after a stop was never attempted and carries no record.
export async function runSteps(steps, ctx) {
  const records = [];
  for (const step of steps) {
    const r = await step.run(ctx);
    records.push({ step: step.name, ok: !!r.ok, exitCode: r.exitCode ?? null, note: r.note || '' });
    if (!r.ok) {
      return { records, exitCode: r.blocked ? 3 : 1 };
    }
  }
  return { records, exitCode: 0 };
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────

function safeRmSync(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort: a locked or already-gone dir must never crash the run */
  }
}

function excerpt(text) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

// Best-effort JSON parse of a command's stdout: most of the seven commands print exactly one
// `console.log(JSON.stringify(...))` line, but tolerate stray console.log noise ahead of it by
// scanning from the last line backwards for the first one that parses.
function parseJsonStdout(stdout) {
  const lines = (stdout || '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

// Run `<baseDir>/scripts/<name>.mjs <args>`. `baseDir` is the tree that decides whether the
// command is SHIPPED (its existence there is the kit's own manifest, by construction — a command
// the kit didn't ship was never copied into the demo repo by coord-init); `cwd` (default
// `baseDir`) is where the child process actually runs, which matters for a command that reads
// the CURRENT git branch/worktree (e.g. record-review from inside the cut worktree).
function runCommand(baseDir, name, args = [], { cwd = baseDir, timeoutMs } = {}) {
  const abs = join(baseDir, 'scripts', `${name}.mjs`);
  if (!existsSync(abs)) {
    return { ok: false, exitCode: null, blocked: true, note: `command not shipped: ${name}` };
  }
  const res = spawnSync(process.execPath, [abs, ...args], {
    cwd,
    env: spawnEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    return {
      ok: false,
      exitCode: res.status ?? null,
      blocked: false,
      note: `spawn error: ${excerpt(res.error.message)}`,
    };
  }
  if (res.status !== 0) {
    return {
      ok: false,
      exitCode: res.status,
      blocked: false,
      note: excerpt(res.stderr || res.stdout) || `exit ${res.status}`,
    };
  }
  return {
    ok: true,
    exitCode: 0,
    blocked: false,
    note: '',
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

function git(cwd, args, extraEnv = {}) {
  // extraEnv is always a literal object at every call site below (e.g. `{ HUSKY: '0' }`), never a
  // `{ ...process.env, ... }` spread, so layering it straight into gitRepoIsolatedEnv's settings
  // position is safe (see scripts/coord/coord-git.mjs gitRaw() for why a caller-built
  // process.env-spread would need stripInheritedRepoSelectors() first). This git() drives real
  // pushes/fetches against the demo repo's own scratch "origin", so it strips only the ambient
  // repo-selector vars (GIT_DIR/GIT_WORK_TREE/…), not transport/credential ones — the exact shape
  // cloud-checkout-preflight.mjs's runGit and git-safe.mjs use (scripts/coord/child-env.mjs
  // gitRepoIsolatedEnv()).
  return execFileSync('git', args, { cwd, env: gitRepoIsolatedEnv(extraEnv), encoding: 'utf8' });
}

// ── the seven real steps ──────────────────────────────────────────────────────────────────────
//
// Each closes over `ctx` (mutated as the run progresses: planId/slug after mint, worktreeDir
// after cut) rather than threading return values through runSteps — runSteps only cares about
// ok/exitCode/note, so step-to-step data lives on the shared context object instead.

function buildSteps() {
  return [
    {
      name: 'mint',
      run(ctx) {
        const bodyFile = join(ctx.tmpDir, 'plan-body.md');
        const label = ctx.mutationBanner.label;
        writeFileSync(
          bodyFile,
          [
            '# Coord-kit smoke test',
            '',
            `> 🟩 **${label}:** NO`,
            '',
            '> 💰 **Cost forecast:** Cash $0 · Claude $0 — smoke-test scratch plan, removed by its own land.',
            '',
            'A disposable plan minted by `scripts/coord/smoke.mjs` to prove the fresh-clone coordination',
            'lanes (mint -> claim -> cut -> commit -> review -> land) work end to end. Safe to delete.',
            '',
          ].join('\n'),
        );
        const r = runCommand(ctx.demoDir, 'next-plan-id', [
          'claim',
          '--category',
          'Coord',
          '--slug',
          'smoke',
          '--blurb',
          'Coord-kit smoke test scratch plan.',
          '--body',
          bodyFile,
          // The mutation-flag NAME comes from coord.config.json's mutationBanner.flag, never
          // hardcoded --data-write — this repo's own default may differ from vetapp's.
          ctx.mutationBanner.flag,
          'no',
        ]);
        if (!r.ok) return r;
        const id = (r.stdout || '').trim().split('\n').pop().trim();
        if (!id)
          return { ok: false, exitCode: 0, blocked: false, note: 'mint: no plan id on stdout' };
        ctx.planId = id;
        ctx.slug = `${id}-Coord-smoke`;
        return { ok: true, exitCode: 0, blocked: false, note: `minted ${id}` };
      },
    },
    {
      name: 'claim',
      run(ctx) {
        // claim-plan.mjs acquire's mutation flag is `--seed-write`, hard-literal in its own
        // parseFlags call — unlike next-plan-id.mjs claim it does NOT read mutationBanner.flag
        // (checked at the plan-3958 sha; see this worker's report for the discrepancy against
        // the build brief, which describes both as config-driven).
        const r = runCommand(ctx.demoDir, 'claim-plan', [
          'acquire',
          ctx.planId,
          '--slug',
          ctx.slug,
          '--seed-write',
          'no',
          // A fresh mint is a stub (no board-pass has run over it yet) — acquire refuses a
          // stub claim without this flag (plan 3958 T7 measurement).
          '--stub-ok',
          'coord-kit smoke test scratch plan',
        ]);
        if (!r.ok) return r;
        const parsed = parseJsonStdout(r.stdout);
        if (!parsed?.won) {
          return {
            ok: false,
            exitCode: 0,
            blocked: false,
            note: `claim did not win: ${excerpt(JSON.stringify(parsed))}`,
          };
        }
        return { ok: true, exitCode: 0, blocked: false, note: 'claimed' };
      },
    },
    {
      name: 'cut',
      run(ctx) {
        // Mirrors smoke's own --no-install: when the operator asked the WHOLE run to skip
        // installs, the cut worktree should too; otherwise cut-worktree's real `pnpm install`
        // is what proves the derived package.json is actually installable (finding 7 / S3).
        const r = runCommand(
          ctx.demoDir,
          'cut-worktree',
          ctx.noInstall ? [ctx.slug, '--no-install'] : [ctx.slug],
        );
        if (!r.ok) return r;
        const parsed = parseJsonStdout(r.stdout);
        if (!parsed?.worktreePath) {
          return { ok: false, exitCode: 0, blocked: false, note: 'cut: no worktreePath on stdout' };
        }
        ctx.worktreeDir = join(ctx.demoDir, parsed.worktreePath);
        return { ok: true, exitCode: 0, blocked: false, note: parsed.worktreePath };
      },
    },
    {
      name: 'commit',
      run(ctx) {
        // No "not shipped" case — this step is plain git, always attempted once cut succeeded.
        try {
          writeFileSync(
            join(ctx.worktreeDir, 'SMOKE.md'),
            `Coord-kit smoke test touch at ${new Date().toISOString()}\n`,
          );
          // Only the one file this step wrote — `git add -A` also swept cut-worktree's OWN
          // pnpm install lockfile churn in the worktree (S3: the kit installs with pnpm), which
          // is not this step's change to commit.
          git(ctx.worktreeDir, ['add', 'SMOKE.md']);
          git(ctx.worktreeDir, ['commit', '-m', 'chore: coord-kit smoke test change'], {
            HUSKY: '0',
          });
          git(ctx.worktreeDir, ['push']);
        } catch (e) {
          return {
            ok: false,
            exitCode: 1,
            blocked: false,
            note: `commit/push failed: ${excerpt(e.message)}`,
          };
        }
        return { ok: true, exitCode: 0, blocked: false, note: 'committed + pushed' };
      },
    },
    {
      name: 'review',
      run(ctx) {
        // Run FROM the worktree (record-review reads the current branch), but the "is this
        // shipped" check stays keyed on the main checkout tree — both are the same commit
        // content, the main checkout is just the canonical place to ask "does the kit ship it".
        const r = runCommand(
          ctx.demoDir,
          'record-review',
          ['PASS', '--review-method', 'self-read'],
          {
            cwd: ctx.worktreeDir,
          },
        );
        return r.ok ? { ok: true, exitCode: 0, blocked: false, note: 'recorded' } : r;
      },
    },
    {
      name: 'land',
      run(ctx) {
        const r = runCommand(ctx.demoDir, 'done-worktree', [ctx.slug], {
          cwd: ctx.demoDir,
          timeoutMs: LAND_TIMEOUT_MS,
        });
        return r.ok ? { ok: true, exitCode: 0, blocked: false, note: 'landed' } : r;
      },
    },
    {
      name: 'assert',
      run(ctx) {
        const problems = [];
        // The land and its coord writes push to origin/master through the coord checkout (a
        // disposable clone of the SAME bare origin); the demo's own checked-out master is never
        // moved by that. Fast-forward before reading, or every check below sees the PRE-land
        // state (plan 3958 T7 measurement).
        try {
          git(ctx.demoDir, ['fetch', 'origin']);
          git(ctx.demoDir, ['merge', '--ff-only', 'origin/master']);
        } catch (e) {
          problems.push(`fast-forward to origin/master failed: ${excerpt(e.message)}`);
        }
        const plansDir = join(ctx.demoDir, 'docs', 'superpowers', 'plans');
        const archived =
          existsSync(join(plansDir, 'archive')) &&
          readdirSync(join(plansDir, 'archive')).some((f) => f.startsWith(`${ctx.planId}-`));
        if (!archived) problems.push('plan file not found under archive/');
        for (const lane of ['ready', 'in-progress', 'pending-approval']) {
          const dir = join(plansDir, lane);
          if (existsSync(dir) && readdirSync(dir).some((f) => f.startsWith(`${ctx.planId}-`))) {
            problems.push(`plan file still present under ${lane}/`);
          }
        }
        // Best-effort INDEX check: if the slug still appears, it must be under the archive
        // marker, not an active-lane section. The real marker build-index-lib.mjs itself writes
        // (ACTIVE_END_RX) is the "Moved to `docs/superpowers/plans/archive/…" paragraph, not a
        // heading — coord-init's own INDEX skeleton (indexSkeleton() in build-coord-kit.mjs)
        // never writes a bare "Archive" heading either (plan 3958 T7 measurement).
        const indexPath = join(ctx.demoDir, 'docs', 'INDEX.md');
        if (existsSync(indexPath)) {
          const indexText = readFileSync(indexPath, 'utf8');
          const bulletIdx = indexText.indexOf(ctx.slug);
          if (bulletIdx !== -1) {
            const archiveMarkerIdx = indexText.search(
              /^\s*Moved to `docs\/superpowers\/plans\/archive\//m,
            );
            if (archiveMarkerIdx === -1 || bulletIdx < archiveMarkerIdx) {
              problems.push('INDEX bullet not found under the archive marker');
            }
          }
        }
        const statusR = runCommand(ctx.demoDir, 'claim-plan', ['status', ctx.planId]);
        if (statusR.blocked) {
          problems.push(statusR.note);
        } else if (!statusR.ok) {
          problems.push(`claim-plan status failed: ${statusR.note}`);
        } else {
          const parsed = parseJsonStdout(statusR.stdout);
          if (parsed?.held) problems.push('claim ref still held');
        }
        if (existsSync(ctx.worktreeDir)) problems.push('worktree directory still present');
        if (problems.length)
          return { ok: false, exitCode: 0, blocked: false, note: problems.join('; ') };
        return {
          ok: true,
          exitCode: 0,
          blocked: false,
          note: 'archived, released, worktree removed',
        };
      },
    },
  ];
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { kit: null, keep: false, json: false, noInstall: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kit') flags.kit = argv[++i];
    else if (a === '--keep') flags.keep = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--no-install') flags.noInstall = true;
    else throw new Error(`smoke: unrecognized argument "${a}"`);
  }
  return flags;
}

export async function main(argv) {
  const flags = parseArgs(argv);
  const kitDir = flags.kit ? resolvePath(flags.kit) : DEFAULT_KIT_DIR;
  const coordInitAbs = join(kitDir, 'scripts', 'coord', 'coord-init.mjs');
  if (!existsSync(coordInitAbs)) {
    console.error(`smoke: no scripts/coord/coord-init.mjs found under --kit ${kitDir}`);
    return 2;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'coord-kit-smoke-'));
  const originDir = join(tmpDir, 'origin.git');
  const demoDir = join(tmpDir, 'demo');

  let records = [];
  let exitCode;
  try {
    mkdirSync(originDir, { recursive: true });
    git(tmpDir, ['init', '--bare', '-b', 'master', originDir]);
    mkdirSync(demoDir, { recursive: true });
    git(demoDir, ['init', '-b', 'master']);
    git(demoDir, ['config', 'user.name', 'coord-kit smoke']);
    git(demoDir, ['config', 'user.email', 'smoke@example.invalid']);
    git(demoDir, ['remote', 'add', 'origin', originDir]);

    const initRes = spawnSync(process.execPath, [coordInitAbs, '--target', demoDir], {
      cwd: kitDir,
      env: spawnEnv(),
      encoding: 'utf8',
    });
    if (initRes.status !== 0) {
      throw new Error(
        `coord-init failed (exit ${initRes.status}): ${excerpt(initRes.stderr || initRes.stdout)}`,
      );
    }

    if (!flags.noInstall) {
      // S3 (2026-09-24, session 4277): the kit is pnpm-only — core cut-worktree and the
      // prettier-drift land gate both already run pnpm, so an npm-installed demo repo could
      // never actually land (PREFLIGHT_FAIL on the first prettier check). `shell: true` on
      // win32 is the same reason cut-worktree's own pnpm install carries it: pnpm resolves to
      // pnpm.cmd there, and spawnSync needs a shell to find a .cmd shim on PATH.
      const installRes = spawnSync('pnpm', ['install'], {
        cwd: demoDir,
        env: spawnEnv(),
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      if (installRes.status !== 0) {
        throw new Error(
          `pnpm install failed (exit ${installRes.status}): ${excerpt(installRes.stderr || installRes.stdout)}`,
        );
      }
    }

    // A stub/minimal coord-init may create nothing at all — guarantee the initial commit is
    // never empty regardless of what coord-init actually copied.
    writeFileSync(
      join(demoDir, '.smoke-init'),
      `coord-kit smoke scaffold ${new Date().toISOString()}\n`,
    );
    git(demoDir, ['add', '-A']);
    git(demoDir, ['commit', '-m', 'chore: coord-init smoke scaffold'], { HUSKY: '0' });
    git(demoDir, ['push', '-u', 'origin', 'master']);

    const { mutationBanner } = loadCoordConfig(demoDir);
    const ctx = { kitDir, demoDir, tmpDir, mutationBanner, noInstall: flags.noInstall };
    const result = await runSteps(buildSteps(), ctx);
    records = result.records;
    exitCode = result.exitCode;
  } catch (e) {
    console.error(`smoke: setup failed: ${e.message || e}`);
    if (!flags.keep) safeRmSync(tmpDir);
    return 2;
  }

  if (flags.json) {
    console.log(JSON.stringify({ kit: kitDir, demo: demoDir, records, exitCode }));
  } else {
    for (const r of records) {
      const status = r.ok ? 'ok' : r.exitCode === null ? 'BLOCKED' : 'FAIL';
      console.log(`${status} ${r.step} ${r.note}`.trim());
    }
  }

  if (flags.keep) {
    console.error(`smoke: --keep set, scratch tree left at ${tmpDir}`);
  } else {
    safeRmSync(tmpDir);
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error('smoke:', e?.message ?? e);
      process.exitCode = 1;
    },
  );
}
