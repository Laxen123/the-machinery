#!/usr/bin/env node
// scripts/cloud-checkout-preflight.mjs — guarded stale-master repair for DISPOSABLE
// cloud checkouts ONLY (plan 2049).
//
// The FULL-egress cloud environments have booted on checkouts whose local master
// carried stale snapshot residue — detached HEAD and/or a master diverged hundreds of
// commits both ways from origin/master. That state burned whole drain firings
// (2026-07-16..19, nine hand-rolled backup/stale-local-master-* branches), and
// heal-main.mjs CANNOT own the repair: its ahead/diverged path treats local commits as
// precious unpushed work (pushMasterWithRebase), which in a disposable container would
// replay stale residue onto the SHARED coordination master. heal-main also must never
// gain a discard path — its settings.json allowlisting rests on its command surface
// containing no destructive verbs (see its header). So the discard lives HERE, behind
// guards that make it unrunnable anywhere that isn't provably disposable.
//
//   node scripts/cloud-checkout-preflight.mjs --yes-discard-local-master
//
// Four independent guards — every one must pass, none alone authorizes anything:
//   1. the explicit opt-in flag above (its name states the destructive consequence)
//   2. a POSITIVE disposability signal: CLAUDE_CODE_ACCOUNT_UUID is present in the env
//      (set in every cloud sandbox — the usage gate keys off it each firing; a local
//      shell does not carry it). Default-deny: an unrecognized machine REFUSES instead
//      of sailing through a blocklist gap (2049 land-review finding 2)
//   3. the host is NOT a known operator machine (localHostDenylist, coord.config.json) —
//      belt on top of guard 2 for an operator shell that happens to export the var
//   4. the checkout has NO LIVE linked worktrees (a main checkout with live worktrees
//      is a shared working machine, never a fresh disposable container). Entries git
//      itself flags `prunable` (orphaned .git/worktrees/ metadata whose directory is
//      gone — exactly what stale snapshot residue leaves behind) do NOT count as live
//      (2049 land-review finding 1)
//
// Behaviour, in order (the ordering IS the safety property — not optional, not
// reorderable): fetch → exit 0 fast if local master is not ahead/diverged (behind-only
// is heal-main's ffMaster territory, left alone) → push the stale tip to origin as
// backup/stale-local-master-<UTC-date>-<sha10> (fixed 10-char sha prefix, not git's
// adaptive-length --short) FIRST → only if that push succeeded
// AND is verified present on origin, reset local master to origin/master. A failed
// backup push aborts WITHOUT resetting, non-zero — even a mis-fired run can lose
// nothing that isn't already safe on origin.
//
// Never: touches linked worktrees, deletes branches, force-pushes.
//
// ── shallow-clone guard (plan 3274) — a SEPARATE axis, not an extension of the
// stale-master repair above ─────────────────────────────────────────────────────────
// A FULL-egress cloud container has also been observed booting on a SHALLOW checkout
// (.git/shallow present, graft boundaries, only ~71 commits of origin/master visible).
// In that state `git merge-base <older-branch> origin/master` returns EMPTY with rc=1
// (the connecting history was never fetched, so two grafted roots share no visible
// ancestor), which silently corrupts every ahead/behind judgment below and kills a
// rebase of any older branch mid-flight instead of failing up front. Detection uses
// `git rev-parse --is-shallow-repository` — git's own answer, which resolves the real
// (common) git dir itself, so it is correct under a linked-worktree layout without this
// script hand-resolving `.git/shallow`'s path. Repair is one `git fetch --unshallow`,
// TIME-BOUNDED (execFileSync `timeout`, default UNSHALLOW_TIMEOUT_MS = 5 min, override
// via env UNSHALLOW_TIMEOUT_ENV) — a wedged network/proxy fails loud instead of hanging
// the whole firing, which would be worse than the shallow clone it repairs (that at
// least fails fast); calling `--unshallow` on an already-complete repo is itself a git
// error ("does not make sense"), so it runs ONLY when the shallow check is true, never
// unconditionally. A repair that fails — including a timeout, named as such and never
// conflated with an ordinary rejected fetch — or leaves the repo still shallow FAILS
// LOUD (exit 1, named cause) rather than letting a corrupted merge-base surface later
// mid-rebase. Runs after guards 1-4 (same disposability envelope) and before the
// stale-master path, so a shallow boundary can never skew that path's own
// rev-list/merge-base math.
//
// ── HEAD-attachment check (plan 3813) — a THIRD, separate axis from both above ─────────
// A FULL-egress cloud sandbox has also been observed booting with the MAIN checkout's HEAD
// attached to a NAMED non-master branch (the harness's `claude/<slug>` checkout branch,
// plan 3111), never detached and with local master itself perfectly clean. The two checks
// above never look at HEAD's own branch name, so that boot reports CLEAN and every coord
// tool downstream then refuses because the checkout is not on master (observed at least 15
// consecutive firings, infra-debt line `cloud-checkout-preflight-inspects-master-not-HEAD`).
// Before the local-master read, this script now reads HEAD's attached branch name: if it is
// neither `master` nor detached, and it carries zero commits unique over the FETCHED
// `origin/master` AND a clean tree, it is safe to assume it is exactly that disposable
// harness stub — `git checkout master`, then the existing fast-forward-to-origin path,
// printing `fixed [head-branch]`. Anything else on that branch (a unique commit, or dirt)
// may be real work, so it is refused loudly (branch name, unique-commit count, and dirt
// state, plus the manual remedy) — never silently switched away from.
// The baseline is origin/master, NOT local master: a cloud container boots with local master
// far behind origin (1719 commits on the firing that motivated this) while the harness branch
// sits at origin/master, so a local-master baseline would misread origin's own history as the
// branch's work and refuse the exact shape this repairs.
//
// Node built-ins only (plus the zero-dependency worktree-porcelain.mjs) — must work
// before `pnpm install` (invoked by the FULL-lane routine prompts right after the
// credential setup, before the usage gate). Do not import from coord-git.mjs /
// heal-main.mjs / any lock primitive.
//
// Exit codes: 0 = clean or repaired (stale-master, shallow-clone, or HEAD-reattach repair);
// 1 = a repair was attempted and failed (backup push failure, or shallow-clone repair
// failure, included) — do NOT proceed to claim; 2 = refused by a guard (including a
// non-master HEAD branch carrying a unique commit or a dirty tree).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRepoIsolatedEnv } from './child-env.mjs';
// plan 2058: THE canonical `git worktree list --porcelain` parser (also used by
// land-lib.mjs) — zero-dependency, safe to import before `pnpm install`.
import { parseWorktreePorcelain } from './worktree-porcelain.mjs';

export const OPT_IN_FLAG = '--yes-discard-local-master';
// Guard 2's positive signal: present in every cloud sandbox env (usage-broadcast.mjs
// already keys each firing off it), absent in a plain local shell.
export const CLOUD_SIGNAL_ENV = 'CLAUDE_CODE_ACCOUNT_UUID';

// Guard 3's operator-LOCAL-machine hostname list — a backstop on top of guard 2's
// default-deny. Plan 4071 D4: this used to be a hardcoded LOCAL_HOST_DENYLIST literal
// here; it now lives in coord.config.json's `localHostDenylist[]` (the same key
// landing-queue-board.mjs's originLabel reads for the identical local/cloud judgment).
// Read DIRECTLY here, never via coord-config.mjs's loadCoordConfig — that module imports
// coord-git.mjs, which this file's own header forbids (it must keep working before `pnpm
// install`, ahead of any assumption the checkout is trustworthy — exactly the state this
// script exists to repair). A missing file, unreadable JSON, or a non-array field all
// degrade to `[]`: a config-read failure must narrow toward MORE refusal-safe (guard 2
// alone still applies), never crash the caller into "no guard at all".
// Entries are TRIMMED and UPPERCASED here (plan 4071 review round 1, extended round 2 key
// 94827c) — hostnames are case-insensitive, and the comparison below uppercases the HOST
// side (`String(host).toUpperCase()`), so a config entry typed in any other case must be
// normalized at THIS seam or it silently never matches and the local-machine refusal is
// skipped. Round 1 added the uppercase step but not a trim: a config entry with stray
// whitespace (`" BUILD-HOST-01"`, a paste artifact) still failed to match after
// uppercasing alone, since the host side never carries that whitespace — trimming closes
// that gap. An entry that is empty AFTER trimming is DROPPED rather than kept as `''`,
// which would otherwise not match any real host but is worth pruning outright so a
// malformed row (e.g. `["", "  "]`) can never silently expand to "matches nothing" in a
// way that looks like a working denylist. coord-config.mjs's own independent parse of this
// same key (for landing-queue-board.mjs / in-progress-board.mjs) normalizes it the same
// way — this file cannot share that code (see the no-coord-config-import rule above), so
// the normalization is duplicated deliberately, once per reader, not routed around.
// Review round 3 (4071, key 30957d): a NON-STRING entry (e.g. `[123]`) used to be silently
// filtered out rather than rejected, so a malformed config like that collapsed to `[]` --
// which, paired with guard 2's cloud signal plus the destructive opt-in, let the
// local-master discard guard skip guard 3's refusal entirely on the operator's own machine.
// A blank/whitespace-only entry stays a silent drop after trimming (that is paste noise,
// not a type error), but a non-string element is a config-authoring bug and must fail LOUD
// -- it throws a plain Error here rather than degrading to `[]` like the catch block below,
// which stays reserved for the "file itself is missing/unreadable/malformed" case.
function readLocalHostDenylist(dir) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'coord.config.json'), 'utf8'));
  } catch {
    return [];
  }
  const list = raw && raw.localHostDenylist;
  if (!Array.isArray(list)) return [];
  for (const h of list) {
    if (typeof h !== 'string') {
      throw new Error(
        `coord.config.json: localHostDenylist has a non-string entry (${JSON.stringify(h)}) -- ` +
          `every entry must be a hostname string`,
      );
    }
  }
  return list.map((h) => h.trim().toUpperCase()).filter((h) => h !== '');
}
// Shallow-clone repair bound (plan 3274). This repo's full history is ~75k commits /
// ~2.4GB packed (measured 2026-08-18) — a genuinely bounded amount of data, not
// "forever" — so a few minutes is generous for a normal cloud-egress path while still
// being a real bound: a wedged network/proxy now fails LOUD instead of hanging the
// whole firing. Overridable per-run (tests use a sub-second value; a genuinely slow
// environment can raise it) via the env var below — read through the same injectable
// `env` param guard 2 already uses, never bare `process.env`.
export const UNSHALLOW_TIMEOUT_MS = 300_000; // 5 minutes
export const UNSHALLOW_TIMEOUT_ENV = 'CLOUD_CHECKOUT_UNSHALLOW_TIMEOUT_MS';

const TAG = 'cloud-checkout-preflight';

export function main({
  argv = process.argv.slice(2),
  dir = process.cwd(),
  host = hostname(),
  env = process.env,
  // plan 4071 D4: injectable so a test can supply a fixture list without a coord.config.json
  // on disk — defaults to a direct read of `dir`'s own coord.config.json (see
  // readLocalHostDenylist's header for why that read is inlined rather than routed through
  // coord-config.mjs).
  localHostDenylist = readLocalHostDenylist(dir),
} = {}) {
  const log = (m) => console.log(`${TAG}: ${m}`);
  const err = (m) => console.error(`${TAG}: ${m}`);
  // One shared runner so the two named helpers below (and the timed unshallow call
  // further down) cannot drift. The child env is process.env-based, NOT the injectable
  // `env` param — that param is a guard-signal input (CLOUD_SIGNAL_ENV) and may
  // legitimately be a narrow object (the test harness's is), which must never strip
  // PATH/credentials from a spawned git. `extraOpts` is a plain execFileSync-options
  // passthrough (e.g. `{ timeout, killSignal }`) — never `encoding`/`env`, which this
  // runner already owns. plan 4135: `gitRepoIsolatedEnv()` drops only the ambient
  // repo-selector vars (GIT_DIR/GIT_WORK_TREE/…) so the explicit `-C dir` above can't be
  // silently overridden — NOT `gitIsolatedEnv()`, whose blanket `GIT_*` strip would also
  // take down transport/credential vars the backup push (a real network push) needs.
  const runGit =
    (extraEnv, extraOpts) =>
    (...a) =>
      execFileSync('git', ['-C', dir, ...a], {
        encoding: 'utf8',
        env: gitRepoIsolatedEnv(extraEnv || {}),
        ...(extraOpts || {}),
      });
  const git = runGit();
  // The backup push ONLY. `scripts/hooks/pre-push.sh` passes through refs/claims/* and
  // refs/coord/* (and pure deletions) but NOT refs/heads/backup/*, so in the baked
  // cloud image (where `pnpm install` already wired husky) an archival backup push
  // gets the full gate battery run against the stale tree it is archiving — which
  // fails by construction. Observed 2026-07-19: session cse_018NLjwZ's hand-rolled
  // backup push was rejected by that gate and it had to reset FIRST, inverting the
  // ordering this script exists to enforce. Same HUSKY=0 precedent claim-plan.mjs
  // uses for its ref pushes: the pushed ref carries no reviewable work, so no gate
  // applies.
  const gitNoHooks = runGit({ HUSKY: '0' });

  // ── guards — refuse loudly, mutate nothing ─────────────────────────────────────────
  if (!argv.includes(OPT_IN_FLAG)) {
    err(`REFUSED — missing ${OPT_IN_FLAG}. This script discards local master on a`);
    err('disposable cloud checkout; the flag is the explicit consent to that discard.');
    return 2;
  }
  if (!String(env[CLOUD_SIGNAL_ENV] || '').trim()) {
    err(`REFUSED — no positive cloud-sandbox signal (${CLOUD_SIGNAL_ENV} unset/empty).`);
    err('This checkout is not provably a disposable cloud container. Default-deny: an');
    err('unrecognized machine refuses rather than trusting a hostname blocklist. On a');
    err('local machine use `node scripts/heal-main.mjs` instead.');
    return 2;
  }
  if (localHostDenylist.includes(String(host).toUpperCase())) {
    err(`REFUSED — host "${host}" is a known operator machine (localHostDenylist).`);
    err('On a local machine, local master commits may be real unpushed work: use');
    err('`node scripts/heal-main.mjs` (the sanctioned local recovery path) instead.');
    return 2;
  }
  let worktrees;
  try {
    worktrees = git('worktree', 'list', '--porcelain');
  } catch (e) {
    err(`cannot inspect worktrees: ${e.message}`);
    return 1;
  }
  // Porcelain output is one block per worktree, main checkout first; `prunable`-flagged
  // entries don't count as live (rationale: guard 4 in the header — the single
  // authoritative description).
  const liveLinked = parseWorktreePorcelain(worktrees)
    .slice(1)
    .filter((e) => !e.prunable);
  if (liveLinked.length > 0) {
    err(`REFUSED — ${liveLinked.length} live linked worktree(s) exist. A checkout with`);
    err('live worktrees is a shared working machine, not a disposable container.');
    return 2;
  }

  // ── shallow-clone detection + repair (a SEPARATE guard axis — see header) ──────────
  let shallow;
  try {
    shallow = git('rev-parse', '--is-shallow-repository').trim() === 'true';
  } catch (e) {
    err(`cannot determine shallow-clone state: ${e.message}`);
    return 1;
  }
  if (shallow) {
    // Read the bound through the injectable `env` param (same guard-2 seam), never bare
    // process.env — falls back to the default on anything unset/blank/non-positive.
    const rawTimeout = env[UNSHALLOW_TIMEOUT_ENV];
    const parsedTimeout = Number(rawTimeout);
    const unshallowTimeoutMs =
      rawTimeout !== undefined &&
      rawTimeout !== null &&
      String(rawTimeout).trim() !== '' &&
      Number.isFinite(parsedTimeout) &&
      parsedTimeout > 0
        ? parsedTimeout
        : UNSHALLOW_TIMEOUT_MS;
    log(
      `SHALLOW CLONE detected (.git/shallow) — attempting one-time repair: git fetch ` +
        `--unshallow, bounded to ${unshallowTimeoutMs}ms (override via ${UNSHALLOW_TIMEOUT_ENV}).`,
    );
    try {
      runGit(undefined, { timeout: unshallowTimeoutMs, killSignal: 'SIGTERM' })(
        'fetch',
        '--unshallow',
        '-q',
        'origin',
      );
    } catch (e) {
      // A real execFileSync timeout kill reports `code: 'ETIMEDOUT'` with `signal` set to
      // the killSignal above and `status: null` — distinct from an ordinary non-zero exit
      // (status set, code undefined). Verified empirically (plan 3274) on this platform.
      // That distinction is the point: an operator or an unattended drain reading this
      // output must be able to tell "the network was too slow" apart from "the fetch was
      // rejected" — so a timeout gets its OWN cause line, never the generic one below.
      if (e && e.code === 'ETIMEDOUT') {
        err(
          `ABORT — shallow-clone repair TIMED OUT after ${unshallowTimeoutMs}ms (cause: ` +
            'git fetch --unshallow origin exceeded its time bound — the network path is ' +
            'too slow or wedged, the fetch was never rejected).',
        );
        err(
          `Raise the bound with ${UNSHALLOW_TIMEOUT_ENV}=<ms> if this environment's ` +
            'network path is genuinely slower than the default; otherwise this points at ' +
            'a wedged proxy/network — do not just retry blindly.',
        );
      } else {
        err('ABORT — shallow-clone repair failed (cause: git fetch --unshallow origin).');
        err(`${e.message}`);
      }
      err(
        'This checkout cannot be trusted for merge-base/rebase against origin/master — ' +
          'do not proceed to land. Fix the fetch path (network/credentials/proxy) and rerun.',
      );
      return 1;
    }
    let stillShallow;
    try {
      stillShallow = git('rev-parse', '--is-shallow-repository').trim() === 'true';
    } catch (e) {
      err(`cannot re-verify shallow-clone state after repair: ${e.message}`);
      return 1;
    }
    if (stillShallow) {
      err(
        'ABORT — shallow-clone repair failed (cause: still shallow after ' +
          '`git fetch --unshallow` reported success). Do not proceed to land.',
      );
      return 1;
    }
    log('shallow-clone REPAIRED — full history fetched, .git/shallow cleared.');
  }

  // ── orient against a FRESH origin/master ───────────────────────────────────────────
  try {
    git('fetch', '-q', 'origin');
  } catch (e) {
    err(`git fetch origin failed — cannot judge divergence: ${e.message}`);
    return 1;
  }
  try {
    git('rev-parse', '-q', '--verify', 'refs/remotes/origin/master^{commit}');
  } catch {
    err('origin/master missing after fetch — cannot establish the baseline.');
    return 1;
  }
  const headBranch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  const detached = headBranch === 'HEAD';

  // ── the third state: HEAD attached to a NAMED non-master branch (the cloud harness's
  // claude/<slug> checkout branch and the like) — master itself may be perfectly clean,
  // but every coord tool downstream refuses because the MAIN checkout is not on master.
  //
  // Two deliberate placements, both load-bearing:
  //
  //  • The baseline is the FETCHED `origin/master`, never the local `master` ref. A cloud
  //    container routinely boots with local master hundreds of commits BEHIND origin/master
  //    while the harness branch sits exactly AT origin/master (measured: 1719 behind on the
  //    2026-09-08 firing). Counting `master..<branch>` would read all 1719 of origin's own
  //    commits as the branch's private work and refuse — precisely the shape this check
  //    exists to repair. `origin/master..<branch>` counts only what the branch really adds.
  //
  //  • It runs BEFORE the no-local-master early return below: a checkout with no local
  //    master at all is still wedged for every coord tool when HEAD sits on a harness
  //    branch, so returning 0 there would report success for a checkout that is not on
  //    master.
  //
  // Judged strictly by the branch's OWN unique history and OWN tree — a harness branch can
  // carry commits/dirt while master reads ahead === 0, and silently switching those away
  // would be exactly the "discard something real" failure this script prevents elsewhere.
  if (!detached && headBranch !== 'master') {
    let headAhead;
    try {
      headAhead = Number(git('rev-list', '--count', `origin/master..${headBranch}`).trim());
    } catch (e) {
      err(`cannot count ${headBranch}'s unique commits over origin/master: ${e.message}`);
      return 1;
    }
    let dirty;
    try {
      // --untracked-files=normal EXPLICITLY: a bare `git status --porcelain` inherits the
      // checkout's `status.showUntrackedFiles`, so a container configured with `no` would
      // report a tree carrying untracked files as clean and get switched away from it.
      dirty = git('status', '--porcelain', '--untracked-files=normal').trim() !== '';
    } catch (e) {
      err(`cannot read working-tree status: ${e.message}`);
      return 1;
    }
    // A local master may not exist at all here (the early return below owns that case for
    // every other path), which changes both what the repair does and what the refusal can
    // honestly tell the operator to run — so probe once, for both branches.
    let hasLocalMaster = true;
    try {
      git('rev-parse', '-q', '--verify', 'refs/heads/master^{commit}');
    } catch {
      hasLocalMaster = false;
    }
    if (headAhead === 0 && !dirty) {
      log(
        `HEAD is attached to "${headBranch}" (0 unique commits over origin/master, clean ` +
          'tree) — reattaching to master.',
      );
      try {
        // Where a local master exists, attach to it AS-IS — never `-B`, which would reset it
        // to origin/master and discard stale-snapshot residue behind the back of the
        // backup-push path further down. Where it does not, create it at the fetched
        // baseline; there is nothing to lose. Never `-f`: the tree is proven clean above.
        if (hasLocalMaster) git('checkout', '-q', 'master');
        else git('checkout', '-q', '-B', 'master', 'origin/master');
      } catch (e) {
        err(`checkout master failed: ${e.message}`);
        return 1;
      }
      // Then bring that master UP TO the fetched baseline. Without this the container is
      // handed back the same stale master it booted with (measured 1719 commits behind on
      // the 2026-09-08 firing) and the drain's next commands read an old checkout. Scoped
      // deliberately to THIS repair — the script's standing behind-only contract ("normal
      // and heal-main/ff territory, left alone") is unchanged for the on-master and
      // detached paths. `--ff-only` is lossless by construction: it REFUSES rather than
      // rewriting when local master carries anything origin/master lacks, and that case
      // falls through to the backup-then-reset path below, the only thing allowed to
      // discard local commits.
      // Ask FIRST whether a fast-forward is even possible, so the two ways this can fail
      // stay distinguishable. A local master carrying its own commits is legitimately not
      // fast-forwardable — the expected, benign case, owned by the backup-then-reset path
      // below. Any OTHER failure (a stale index.lock from a crashed container, an I/O
      // error — exactly the half-finished git state this script exists to repair) must be
      // loud: swallowed, it would leave master stale and still be reported CLEAN by the
      // ahead === 0 path, handing the drain an old checkout under a success verdict.
      let ffPossible = false;
      try {
        git('merge-base', '--is-ancestor', 'refs/heads/master', 'refs/remotes/origin/master');
        ffPossible = true;
      } catch (e) {
        // `--is-ancestor` documents exit 1 for a clean "no, it is not an ancestor" and a
        // status ABOVE 1 for an actual error. Only the former is the benign divergence
        // case; swallowing the latter would reintroduce, one level up, exactly the
        // stale-master-under-a-CLEAN-verdict hole the ff abort below closes.
        if (e.status !== 1) {
          err(
            'ABORT — cannot determine whether master fast-forwards to origin/master ' +
              `(an operational error, not divergence): ${e.message}`,
          );
          return 1;
        }
      }
      if (ffPossible) {
        try {
          git('merge', '--ff-only', '-q', 'origin/master');
        } catch (e) {
          err(
            'ABORT — master is a strict ancestor of origin/master but the fast-forward ' +
              `failed (an operational error, not divergence): ${e.message}`,
          );
          return 1;
        }
      }
      log(`fixed [${headBranch}]`);
      // Fall through to the existing fast-forward-to-origin path below, now on master.
    } else {
      // The remedy must be a command that actually RUNS here, on two axes: `git checkout
      // master` fails outright when there is no local master to check out, and an unquoted
      // path is re-tokenized by the operator's shell (this project's own checkouts live
      // under `98 Hobby/`, a path with a space in it).
      const q = `"${dir}"`;
      const remedy = hasLocalMaster
        ? `git -C ${q} checkout master`
        : `git -C ${q} checkout -B master origin/master`;
      err(
        `REFUSED — HEAD is attached to "${headBranch}", not master (${headAhead} unique ` +
          `commit(s) over origin/master; tree is ${dirty ? 'DIRTY' : 'clean'}). This may be ` +
          'real work — never silently switched away. Manual remedy: inspect ' +
          `"${headBranch}" by hand (\`git -C ${q} log origin/master..${headBranch}\`, ` +
          `\`git -C ${q} status\`), then \`${remedy}\` once it is safe.`,
      );
      return 2;
    }
  }

  let masterSha;
  try {
    masterSha = git('rev-parse', '-q', '--verify', 'refs/heads/master^{commit}').trim();
  } catch {
    log('no local master branch — nothing this preflight owns; proceeding (exit 0).');
    return 0;
  }

  const [behind, ahead] = git('rev-list', '--left-right', '--count', 'origin/master...master')
    .trim()
    .split(/\s+/)
    .map(Number);

  if (ahead === 0) {
    log(
      `CLEAN — local master carries no local-only commits (behind by ${behind}; ` +
        'behind-only is normal and heal-main/ff territory, left alone).',
    );
    if (detached)
      log(
        'note: HEAD is detached (master itself is clean) — `node scripts/heal-main.mjs` ' +
          'owns the safe reattach.',
      );
    return 0;
  }

  // ── diverged/ahead: backup-push FIRST, reset only after the backup is proven ───────
  const date = new Date().toISOString().slice(0, 10);
  // Derived from masterSha (read once above) so the branch suffix and the verified
  // backup sha can never refer to different commits; fixed 10 chars, not --short
  // (whose adaptive length varies by repo).
  const backup = `backup/stale-local-master-${date}-${masterSha.slice(0, 10)}`;
  log(
    `local master is ahead ${ahead} / behind ${behind} of origin/master — stale ` +
      `snapshot residue. Backing up ${masterSha.slice(0, 12)} to origin as ${backup} ` +
      'BEFORE any reset.',
  );
  try {
    // No --force: a same-name/different-content collision must fail (the sha in the
    // name makes a benign same-content re-push an up-to-date no-op instead).
    gitNoHooks('push', '-q', 'origin', `master:refs/heads/${backup}`);
  } catch (e) {
    err(`ABORT — backup push failed; local master left UNTOUCHED. ${e.message}`);
    err('Nothing was reset. Fix the push path (credentials/proxy) and rerun.');
    return 1;
  }
  // Belt-and-braces: the reset is authorized by the backup EXISTING ON ORIGIN, not by
  // a push exit code — verify before discarding anything (this env pushes through a
  // rewriting proxy; trust nothing).
  let remoteSha = '';
  try {
    remoteSha = (git('ls-remote', 'origin', `refs/heads/${backup}`).split('\t')[0] || '').trim();
  } catch (e) {
    err(`ABORT — cannot verify the backup on origin; local master left UNTOUCHED. ${e.message}`);
    return 1;
  }
  if (remoteSha !== masterSha) {
    err(
      `ABORT — backup on origin is "${remoteSha || '(absent)'}", expected ${masterSha}; ` +
        'local master left UNTOUCHED.',
    );
    return 1;
  }
  log(`backup verified on origin (${remoteSha.slice(0, 12)}). Resetting to origin/master.`);
  try {
    // One command == attach-to-master (fixes a detached HEAD) + reset --hard
    // origin/master (discards the stale local commits and any dirty tracked files).
    // Untracked files are deliberately left alone — they are not this signature.
    git('checkout', '-q', '-f', '-B', 'master', 'origin/master');
  } catch (e) {
    err(`reset failed after a successful backup (tip is safe at ${backup}): ${e.message}`);
    return 1;
  }
  const now = git('rev-parse', 'refs/heads/master').trim();
  const originNow = git('rev-parse', 'refs/remotes/origin/master').trim();
  if (now !== originNow) {
    err(`reset landed on ${now}, expected origin/master ${originNow} — inspect by hand.`);
    return 1;
  }
  log(
    `REPAIRED — local master reset to origin/master (${now.slice(0, 12)}); stale tip preserved at ${backup}.`,
  );
  return 0;
}

// CLI only (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main({}));
}
