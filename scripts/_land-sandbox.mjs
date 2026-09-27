// scripts/_land-sandbox.mjs (plan 355)
// Real-git sandbox builder shared by land-lib / land-guard / worktree-resolve
// tests. NOT a *.test.mjs file, so `node --test scripts/*.test.mjs` does not run
// it as a suite — it is imported. The spine's git ops aren't meaningfully
// mockable (the wedge was real-git autostash-pop behaviour), so the tests drive
// an actual `git` against a bare "origin" clone.
//
// ── plan 3961 T0b: opt-in coordination fixtures ──────────────────────────────
// The parity harness (the land-spine parity test) needs a sandbox that
// looks enough like a coordination repo for the land spine to reason about it:
// the plan lanes, a coord.config.json, and a shard tree whose paths match
// `shardIdPattern`. Those are OPT-IN via `sandbox(opts)` and, when requested,
// ride the SAME `base` commit — so `sandbox()` with no argument is byte-for-byte
// what it was before this plan, down to the commit count. The five pre-3961
// callers (land-lib, land-guard, worktree-resolve, ensure-coord-reroute,
// ephemeral-merge-equivalence) pass no argument and are unaffected.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const g = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

// Deliberately a LITERAL, not an import of coord-config.mjs's DEFAULTS: this helper is
// imported by five test files that have no reason to pull in coord-config → coord-git, and a
// shared fixture builder should not grow a dependency chain for one string.
// plan 4172: a NEUTRAL record layout of the same shape as a real project's (one country level,
// one capture group for the record id), not any project's own nouns — every sandbox that lays
// this tree also writes this pattern into its own coord.config.json, so the spine under test
// reads the sandbox's layout, never the host repo's. The land-spine parity test pins
// that the laid shard paths and this pattern agree.
export const SANDBOX_SHARD_ID_PATTERN = 'records/[A-Z]{2}/(record-\\d+)\\.json';
export const SANDBOX_SEED_SHARD_DIR = 'backend/src/data/seed';

// Mirrors coord-config.mjs's DEFAULT_LANES (the eight active `order` lanes plus the two
// terminal ones). Same literal-not-import rationale as the pattern above.
export const SANDBOX_PLAN_LANES = Object.freeze([
  'in-progress',
  'ready',
  'pending-approval',
  'waiting-blocked',
  'waiting-operator',
  'waiting-grill',
  'waiting-date',
  'waiting-trip',
  'archive',
  'parked',
]);

const PLANS_ROOT = 'docs/superpowers/plans';

function writeFileDeep(root, rel, body) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return rel;
}

// The plan lanes, each with a .gitkeep so an EMPTY lane survives a git round trip (git tracks
// files, not directories — a lane that exists only as a directory vanishes on clone, which is
// precisely the state a "which lane is this plan in" assertion needs to distinguish).
function layPlanLanes(main, lanes) {
  return lanes.map((lane) => writeFileDeep(main, `${PLANS_ROOT}/${lane}/.gitkeep`, ''));
}

function layCoordConfig(main, config) {
  return [writeFileDeep(main, 'coord.config.json', `${JSON.stringify(config, null, 2)}\n`)];
}

// A minimal shard tree matching SANDBOX_SHARD_ID_PATTERN: `<seedShardDir>/records/<CC>/
// record-<n>.json` plus the per-country `order.json` assembly manifest the real layout carries.
// Shard BODIES are deliberately minimal — the spine's seed-scope logic keys on PATHS (which
// record ids a diff touches), never on row content.
function layShardTree(main, { seedShardDir, country, ids }) {
  const written = [];
  for (const id of ids) {
    written.push(
      writeFileDeep(
        main,
        `${seedShardDir}/records/${country}/record-${id}.json`,
        `${JSON.stringify({ id: `record-${id}`, name: `Sandbox record ${id}` }, null, 2)}\n`,
      ),
    );
  }
  written.push(
    writeFileDeep(
      main,
      `${seedShardDir}/records/${country}/order.json`,
      `${JSON.stringify(
        ids.map((id) => `record-${id}`),
        null,
        2,
      )}\n`,
    ),
  );
  return written;
}

// A bare origin + one clone ("main") with a single `base` commit on master,
// already pushed. Returns { root, origin, main, g, fixtures }.
//
// opts (all optional, all default OFF — `sandbox()` is unchanged from plan 355):
//   planLanes  true | string[]        the plan status folders (default: SANDBOX_PLAN_LANES)
//   coordConfig true | object         coord.config.json (default: a vetapp-shaped minimum)
//   shardTree  true | {seedShardDir, country, ids}   a shard tree matching shardIdPattern
//                                     (default: backend/src/data/seed, SE, ids 1-3)
// `fixtures` is the sorted list of repo-relative paths the options laid down ([] by default),
// so a caller can assert what it asked for without re-deriving the layout.
export function sandbox(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'land-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'master', origin]);
  const main = join(root, 'main');
  execFileSync('git', ['clone', origin, main]);
  g(main, ['config', 'user.email', 't@t']);
  g(main, ['config', 'user.name', 't']);
  writeFileSync(join(main, 'a.txt'), 'base\n');

  const fixtures = [];
  if (opts.planLanes) {
    fixtures.push(
      ...layPlanLanes(main, Array.isArray(opts.planLanes) ? opts.planLanes : SANDBOX_PLAN_LANES),
    );
  }
  if (opts.shardTree) {
    const s = opts.shardTree === true ? {} : opts.shardTree;
    fixtures.push(
      ...layShardTree(main, {
        seedShardDir: s.seedShardDir ?? SANDBOX_SEED_SHARD_DIR,
        country: s.country ?? 'SE',
        ids: s.ids ?? [1, 2, 3],
      }),
    );
  }
  if (opts.coordConfig) {
    // Written LAST so a caller-supplied config can name a seedShardDir the shard tree above
    // already used, and so the default below can reflect the tree that was actually laid down.
    const s = opts.shardTree === true || !opts.shardTree ? {} : opts.shardTree;
    const seedShardDir = s.seedShardDir ?? SANDBOX_SEED_SHARD_DIR;
    fixtures.push(
      ...layCoordConfig(
        main,
        opts.coordConfig === true
          ? {
              seedShardDir,
              shardIdPattern: SANDBOX_SHARD_ID_PATTERN,
              handoffLayout: 'sessions',
              handoffDir: 'docs/handoff',
            }
          : opts.coordConfig,
      ),
    );
  }

  // ONE commit, exactly as before — the fixtures ride `base` rather than adding a second
  // commit, so a caller that counts commits (or diffs master..origin/master) sees no change.
  g(main, ['add', '-A']);
  g(main, ['commit', '-m', 'base']);
  g(main, ['push', 'origin', 'master']);
  return { root, origin, main, g, fixtures: fixtures.sort() };
}
