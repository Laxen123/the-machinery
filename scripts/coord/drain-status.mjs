#!/usr/bin/env node
// scripts/drain-status.mjs — the gate-EXEMPT, origin-visible drain status channel (plan 3619).
//
// THE PROBLEM THIS EXISTS FOR. Successful pushes to origin are the system's only channel for a
// cloud drain's state — and that channel sits behind the very pre-push gate that can fail. A drain
// whose push is gate-rejected is byte-identical, on every observability surface, to a drain that
// never started: the ready-board renders its empty stake marker as "already-on-origin, hands off",
// `deadSeedVerdict` counts toward declaring the marker a DEAD SEED (freeing the plan for a second
// drain to redo the same work), and `wake-stalls` cannot see the session at all. Measured incident
// 2026-09-01 (plan 3595): 4 finished commits held ~3.5h behind a failing scripts-battery gate,
// across two sessions and one human intervention, invisible to everything.
// Full chain: output/reports/2026-09-01-drain-3595-stall-structural-root-cause.md.
//
// THE CHANNEL. A drain publishes `.drain-status/<slug>.json` — heartbeat + held-commit count +
// the name of the gate that is rejecting it — onto its OWN branch, `claude/status/<slug>`. Three
// design constraints shaped that, and each is load-bearing:
//
//   1. BRANCH-shaped, not `refs/drain-status/*`. An UNCLAIMED (no-PAT) drain is exactly
//      the case that most needs this channel, and it can push nothing but ordinary branches — the
//      sandbox proxy 403s `refs/coord/*` and `refs/claims/*`, and the PAT reroute that fixes that
//      exists only when the PAT is provisioned. `refs/heads/*` is the one namespace it always has.
//
//   2. Its own namespace, NOT a status commit on the `claude/drain-<slug>` stake marker. On the
//      unclaimed path the marker IS the work branch: `cut-worktree.mjs <slug> --adopt=claude/drain-
//      <slug>` cuts from it and `done-worktree.mjs` merges it, so a status file committed there
//      would ride into the landed master diff — on precisely the path the marker exists to serve.
//      `claude/status/*` also deliberately does NOT match the `refs/heads/claude/drain-*` glob that
//      `queue-drain.mjs` (ORIGIN_EXECUTED_BRANCH_RXS) and `reconcile-worktree-branches.mjs` already
//      read, so no existing consumer can mis-parse a status branch as an execution branch.
//
//   3. The commit is PINNED TO ITS FORK SNAPSHOT. Each write takes its tree from the PREVIOUS
//      status tip when one exists, and only from `origin/master` on the very first write. Re-reading
//      `origin/master` on every heartbeat is the tempting shape and is wrong: once master advances,
//      the branch's fork-point diff carries every intervening master change and the content-based
//      pre-push exemption (`compute-push-diff.mjs` § isDrainStatusOnlyPush) stops firing — the one
//      property this whole channel depends on. Pinning keeps the branch's entire diff equal to
//      exactly one file, forever. An orphan (parentless) commit was rejected for the mirror reason:
//      it has no merge-base with origin/master, so the diff computation throws and the push gets no
//      exemption at all.
//
// Every write is git PLUMBING against a temp index — read-tree → update-index → write-tree →
// commit-tree → push. No checkout, no branch switch, nothing in the caller's working tree is
// touched (the `claim-plan.mjs` reserve-by-push idiom), so a drain can heartbeat from inside a
// dirty worktree mid-gate without disturbing the work it is trying to push.
//
// CLI:
//   node scripts/drain-status.mjs write <slug> --blocked-on <gate> [--plan <id>] [--branch <b>]
//                                             [--held-commits N] [--session <id>] [--note <s>]
//   node scripts/drain-status.mjs read [<slug>]      # JSON of one, or every published status
//   node scripts/drain-status.mjs clear <slug>       # delete the status branch (drain finished)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, errSummary, lsRemoteTimed, parseFlags } from './coord-git.mjs';
import { coordinationSessionId } from './coord-session-id.mjs';

// Every network call in this module is capped. It runs on a gate-blocked drain's critical path and
// inside the oracle's per-firing selection, so a hung origin has to degrade to "no status" rather
// than wedge either. Matches `lsRemoteTimed`'s own 5s default for the same reason it has one.
const REMOTE_TIMEOUT_MS = 5000;

export const DRAIN_STATUS_DIR = '.drain-status';
export const DRAIN_STATUS_BRANCH_PREFIX = 'claude/status/';
// The ONE ls-remote pattern for the namespace, so `queue-drain.mjs` and any future consumer add it
// to their existing single ls-remote call rather than each spelling the glob themselves.
export const DRAIN_STATUS_REF_GLOB = `refs/heads/${DRAIN_STATUS_BRANCH_PREFIX}*`;

// Same id grammar the execution-branch regexes use (queue-drain.mjs ORIGIN_EXECUTED_BRANCH_RXS):
// a 3+ digit plan id, terminated by end-of-string or a `-` followed by a letter, so a slug like
// `3619-FABLE-Coord-…` yields 3619 and a bare numeric suffix can never be read as an id.
const SLUG_PLAN_ID_RX = /^(\d{3,})(?:-(?=[A-Za-z])|$)/;

export function planIdFromSlug(slug) {
  const m = SLUG_PLAN_ID_RX.exec(String(slug || ''));
  return m ? m[1] : null;
}

export function statusPathFor(slug) {
  return `${DRAIN_STATUS_DIR}/${slug}.json`;
}

export function statusBranchFor(slug) {
  return `${DRAIN_STATUS_BRANCH_PREFIX}${slug}`;
}

export function statusRefFor(slug) {
  return `refs/heads/${statusBranchFor(slug)}`;
}

// Parse `git ls-remote` output into the status heads it carries. Deliberately tolerant of the
// OTHER ref patterns in the same output: `queue-drain.mjs` reads the drain markers, the worktree
// branches and this namespace in ONE ls-remote call (one network round trip per firing, the
// property plan 2863 established), so every parser over that output must ignore what is not its own.
export function parseStatusHeads(stdout) {
  const heads = [];
  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const [sha, ref] = line.split('\t');
    if (!sha || !ref) continue;
    if (!ref.startsWith(`refs/heads/${DRAIN_STATUS_BRANCH_PREFIX}`)) continue;
    const slug = ref.slice(`refs/heads/${DRAIN_STATUS_BRANCH_PREFIX}`.length);
    if (!slug) continue;
    heads.push({ sha, ref, slug, planId: planIdFromSlug(slug) });
  }
  return heads;
}

export function buildStatusPayload({
  slug,
  planId = null,
  branch = null,
  blockedOn = null,
  heldCommits = null,
  session = null,
  note = null,
  nowMs = Date.now(),
}) {
  return {
    slug,
    planId: planId ?? planIdFromSlug(slug),
    branch,
    blockedOn,
    heldCommits,
    session,
    note,
    heartbeatAt: new Date(nowMs).toISOString(),
  };
}

// A published status is EVIDENCE, not a flag — it is trusted only as far as it parses. Anything
// malformed degrades to "no status" (the pre-3619 behaviour) rather than to a state that could
// suspend a dead-seed clock on garbage.
export function parseStatusPayload(raw, { slug = null } = {}) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const heartbeatMs = Date.parse(obj.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return null;
  return {
    slug: typeof obj.slug === 'string' ? obj.slug : slug,
    planId: typeof obj.planId === 'string' ? obj.planId : planIdFromSlug(obj.slug ?? slug ?? ''),
    branch: typeof obj.branch === 'string' ? obj.branch : null,
    blockedOn: typeof obj.blockedOn === 'string' ? obj.blockedOn : null,
    heldCommits: Number.isFinite(obj.heldCommits) ? obj.heldCommits : null,
    session: typeof obj.session === 'string' ? obj.session : null,
    note: typeof obj.note === 'string' ? obj.note : null,
    heartbeatMs,
  };
}

// ── Write ───────────────────────────────────────────────────────────────────

// The base commit a new status commit parents on and takes its tree from: the previous status tip
// when the branch already exists, else origin/master. See design note 3 in the header for why this
// is NOT re-read from origin/master on every heartbeat.
function resolveStatusBase(mainDir, slug, _git) {
  const ref = statusRefFor(slug);
  // Every remote read here is TIME-CAPPED. A heartbeat runs on the drain's own critical path and,
  // via the oracle, on every firing's selection path — a hung origin must degrade, never wedge.
  const ls = lsRemoteTimed(mainDir, ref, { _git }).trim();
  if (ls) {
    const sha = ls.split('\t')[0];
    // `--force` for the same reason the namespace fetch uses `+`: a slug reused after a clear can
    // make its ref non-fast-forward, and a fetch that refused there would blind the write path.
    _git(mainDir, ['fetch', '--quiet', '--force', 'origin', `${ref}:${ref}`], {
      env: { HUSKY: '0' },
      timeout: REMOTE_TIMEOUT_MS,
    });
    return sha;
  }
  return _git(mainDir, ['rev-parse', 'origin/master']).trim();
}

// The whole "nothing in the caller's working tree is touched" guarantee rests on ONE thing: the git
// seam actually passing `opts.env` through, so `GIT_INDEX_FILE` redirects the index work to a temp
// file. `coord-git.mjs`'s `git()`/`gitRaw()` do (env is composed by `spawnEnv` and handed to
// execFileSync), but this module takes an INJECTABLE `_git`, and a seam that silently drops env
// would run `read-tree`/`update-index` against the caller's REAL index — staging a stray
// `.drain-status/*.json` into the very commit a drain is about to push. That is exactly the
// pollution this design avoided by keeping status off the work marker, so it is checked rather than
// assumed, BEFORE anything is mutated. `git var` reads and writes nothing, so the probe itself is
// harmless whichever way it comes out.
const ENV_PROBE_NAME = 'drain-status-env-probe';

function assertGitSeamHonoursEnv(mainDir, _git) {
  let out = '';
  try {
    out = _git(mainDir, ['var', 'GIT_AUTHOR_IDENT'], {
      env: { GIT_AUTHOR_NAME: ENV_PROBE_NAME, GIT_AUTHOR_EMAIL: 'probe@drain-status.invalid' },
    });
  } catch {
    out = '';
  }
  if (!String(out).includes(ENV_PROBE_NAME)) {
    throw new Error(
      'drain-status: the injected git seam does not pass `opts.env` through, so GIT_INDEX_FILE ' +
        "would not redirect the index and the status file would be staged into the caller's REAL " +
        'index. Refusing to write. Pass a seam that forwards env (coord-git.mjs `git()` does).',
    );
  }
}

export function writeDrainStatus(mainDir, slug, fields = {}, { _git = git } = {}) {
  const payload = buildStatusPayload({ slug, ...fields });
  const path = statusPathFor(slug);
  assertGitSeamHonoursEnv(mainDir, _git);
  const scratch = mkdtempSync(join(tmpdir(), 'drain-status-'));
  try {
    const base = resolveStatusBase(mainDir, slug, _git);
    const indexFile = join(scratch, 'index');
    const env = { GIT_INDEX_FILE: indexFile, HUSKY: '0' };
    // hash-object from a FILE, never stdin: the shared git() seam spreads its options into
    // execFileSync but this module must not depend on that surface carrying `input`.
    const blobFile = join(scratch, 'status.json');
    writeFileSync(blobFile, `${JSON.stringify(payload, null, 2)}\n`);
    const blob = _git(mainDir, ['hash-object', '-w', blobFile]).trim();
    _git(mainDir, ['read-tree', base], { env });
    // Belt-and-braces on the probe above: `read-tree` CREATES the index it writes, so if the temp
    // file is absent afterwards the redirect did not take and the real index was written instead.
    if (!existsSync(indexFile)) {
      throw new Error(
        `drain-status: GIT_INDEX_FILE was not honoured (${indexFile} was never created) — aborting ` +
          "before write-tree rather than committing a tree built from the caller's real index.",
      );
    }
    _git(mainDir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
    const tree = _git(mainDir, ['write-tree'], { env }).trim();
    const subject = `chore(drain-status): ${slug}${payload.blockedOn ? ` — blocked on ${payload.blockedOn}` : ''}`;
    const commit = _git(mainDir, ['commit-tree', tree, '-p', base, '-m', subject]).trim();
    _git(mainDir, ['push', '--quiet', 'origin', `${commit}:${statusRefFor(slug)}`], {
      timeout: REMOTE_TIMEOUT_MS,
    });
    return { branch: statusBranchFor(slug), commit, path, payload };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Clearing is BEST-EFFORT by necessity: the sandbox proxy hard-403s ref/branch DELETES, and the
// unclaimed no-PAT drain is exactly the population this channel serves — so the very runs
// that most need to publish a heartbeat are the ones that cannot delete it afterwards. That is
// designed for rather than fought: an uncleared status branch simply goes STALE, the dead-seed clock
// resumes on its own (see coord-git.mjs § deadSeedVerdict — a stale heartbeat is never a veto), and
// nothing is pinned. So a failed delete is reported, never thrown.
export function clearDrainStatus(mainDir, slug, { _git = git, log = console.error } = {}) {
  const ref = statusRefFor(slug);
  try {
    // The PROBE is inside the best-effort boundary too. It is a network call like any other, and a
    // clear that threw on an unreachable origin would turn "tidy up afterwards" into a step that can
    // fail a drain's happy path — the opposite of best-effort.
    if (!lsRemoteTimed(mainDir, ref, { _git }).trim()) return { deleted: false };
    _git(mainDir, ['push', '--quiet', 'origin', `:${ref}`], { timeout: REMOTE_TIMEOUT_MS });
  } catch (e) {
    log(
      `drain-status: could not delete ${statusBranchFor(slug)} (${errSummary(e)}). Harmless: the ` +
        'heartbeat will go stale and the dead-seed clock resumes on its own.',
    );
    return { deleted: false, error: errSummary(e) };
  }
  return { deleted: true };
}

// ── Read ────────────────────────────────────────────────────────────────────

// Bring the whole namespace local in ONE fetch, then read every tip's payload from local objects.
// Per-slug fetching would put a network round trip on each candidate; the namespace is normally
// empty and never large, and each commit is a one-file delta against a master commit the client
// already has.
export function readDrainStatuses(mainDir, heads, { _git = git, log = console.error } = {}) {
  const byPlanId = new Map();
  if (!heads || heads.length === 0) return byPlanId;
  try {
    _git(
      mainDir,
      [
        'fetch',
        '--quiet',
        'origin',
        // `+` forces the local tracking refs to match origin. Heartbeats are always fast-forwards,
        // so this should never bite — but a namespace that CAN go non-ff (a slug reused after a
        // clear, say) would otherwise fail the whole fetch and blind the read for every plan.
        `+${DRAIN_STATUS_REF_GLOB}:refs/remotes/origin/${DRAIN_STATUS_BRANCH_PREFIX}*`,
      ],
      { env: { HUSKY: '0' }, timeout: REMOTE_TIMEOUT_MS },
    );
  } catch (e) {
    // Fail OPEN, loudly: an unreadable status namespace must degrade to the pre-3619 behaviour
    // (no status ⇒ the ordinary dead-seed age test), never to a silent suspension of that clock.
    log(`drain-status: WARNING — status fetch failed, statuses ignored: ${errSummary(e)}`);
    return byPlanId;
  }
  for (const head of heads) {
    if (!head.planId) continue;
    let parsed = null;
    try {
      parsed = parseStatusPayload(
        _git(mainDir, ['show', `${head.sha}:${statusPathFor(head.slug)}`]),
        {
          slug: head.slug,
        },
      );
    } catch (e) {
      log(`drain-status: WARNING — unreadable status for ${head.slug}: ${errSummary(e)}`);
      continue;
    }
    if (!parsed) continue;
    // Newest heartbeat wins when one plan somehow published under two slugs.
    const prev = byPlanId.get(head.planId);
    if (!prev || parsed.heartbeatMs > prev.heartbeatMs) byPlanId.set(head.planId, parsed);
  }
  return byPlanId;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

// The SHARED parser (`scripts/coord/parse-flags.mjs` via coord-git), not a hand-rolled one: it throws
// LOUDLY on an unknown flag instead of swallowing a typo as data. That matters more here than
// usual — this CLI is invoked by an unattended drain mid-gate, where a silently-ignored
// `--blocked-on` would publish a heartbeat naming no gate and nobody would be watching to notice.
// Held commits: what this sandbox has committed but has not got onto origin. ADVISORY — a failure
// to count must never stop the heartbeat, which is the whole point of the channel. (Deleted by
// accident when the hand-rolled flag parser was swapped for the shared one, leaving its call site
// behind: `write` without an explicit `--held-commits` — the way the routine prompt actually calls
// it — died with a ReferenceError. Restored, and now pinned by a test that walks the default path.)
export function countHeldCommits(mainDir, branch, { _exec = execFileSync } = {}) {
  try {
    const upstream = branch ? `origin/${branch}` : '@{u}';
    return Number(
      _exec('git', ['-C', mainDir, 'rev-list', '--count', `${upstream}..HEAD`], {
        encoding: 'utf8',
        timeout: REMOTE_TIMEOUT_MS,
        // stderr swallowed: the ordinary miss here is `fatal: no upstream configured`, and this
        // count is advisory. Printing git's `fatal:` into an unattended drain's transcript beside a
        // heartbeat that SUCCEEDED reads like the heartbeat failed.
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    return null;
  }
}

const CLI_SPEC = {
  label: 'drain-status',
  subcommand: true,
  // requireValues: a bare `--blocked-on` (its value accidentally omitted) must REFUSE, not fall
  // through to the `null` default and publish a heartbeat naming no gate — an unattended drain
  // writing a status that says nothing is the very state this plan exists to remove.
  requireValues: true,
  value: ['repo', 'plan', 'branch', 'blocked-on', 'held-commits', 'session', 'note'],
};

// `requireValues` alone does not cover the shape that actually bites here: `--blocked-on --session
// cse_x` is a MISSING value, but the shared parser happily consumes the next token, so the run
// published `blockedOn: "--session"` — a heartbeat naming a gate that does not exist, written by an
// unattended drain with nobody watching. Checked at THIS boundary rather than in `parse-flags.mjs`,
// whose consume-the-next-token semantics other callers may rely on.
export function assertNoFlagShapedValues(flags) {
  for (const [name, value] of Object.entries(flags)) {
    if (typeof value === 'string' && value.startsWith('--')) {
      throw new Error(
        `drain-status: --${name} was given the flag-shaped value "${value}" — its real value is ` +
          'missing. Refusing rather than publishing a heartbeat that names it as the gate.',
      );
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  const { cmd, positionals, flags } = parseFlags(argv, CLI_SPEC);
  assertNoFlagShapedValues(flags);
  const positional = positionals[0];
  const mainDir = flags.repo || process.cwd();

  if (cmd === 'write') {
    if (!positional) throw new Error('drain-status: write needs a <slug>');
    const branch = flags.branch ?? null;
    const held =
      flags['held-commits'] != null && flags['held-commits'] !== ''
        ? Number(flags['held-commits'])
        : countHeldCommits(mainDir, branch);
    const r = writeDrainStatus(mainDir, positional, {
      planId: flags.plan ?? null,
      branch,
      blockedOn: flags['blocked-on'] ?? null,
      heldCommits: Number.isFinite(held) ? held : null,
      // An explicit CLI value is the heartbeat's declared identity. Otherwise the shared
      // resolver refuses ambiguous nested-runtime ownership before this status write.
      session: flags.session ?? coordinationSessionId(),
      note: flags.note ?? null,
    });
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return;
  }

  if (cmd === 'clear') {
    if (!positional) throw new Error('drain-status: clear needs a <slug>');
    process.stdout.write(`${JSON.stringify(clearDrainStatus(mainDir, positional))}\n`);
    return;
  }

  if (cmd === 'read') {
    const out = lsRemoteTimed(mainDir, DRAIN_STATUS_REF_GLOB);
    let heads = parseStatusHeads(out);
    if (positional) heads = heads.filter((h) => h.slug === positional);
    const statuses = readDrainStatuses(mainDir, heads);
    process.stdout.write(`${JSON.stringify(Object.fromEntries(statuses), null, 2)}\n`);
    return;
  }

  throw new Error(
    'drain-status: unknown command (use: write <slug> [--blocked-on <gate>] [--branch <b>] ' +
      '[--held-commits N] [--plan <id>] [--session <id>] [--note <s>] | read [<slug>] | clear <slug>)',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
