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
// ── shallow-clone guard (plan 3274; cumulative-deepen repair, plan 4189) — a SEPARATE
// axis, not an extension of the stale-master repair above ─────────────────────────────
// A FULL-egress cloud container has also been observed booting on a SHALLOW checkout
// (.git/shallow present, graft boundaries, only ~71 commits of origin/master visible).
// In that state `git merge-base <older-branch> origin/master` returns EMPTY with rc=1
// (the connecting history was never fetched, so two grafted roots share no visible
// ancestor), which silently corrupts every ahead/behind judgment below and kills a
// rebase of any older branch mid-flight instead of failing up front. Detection uses
// `git rev-parse --is-shallow-repository` — git's own answer, which resolves the real
// (common) git dir itself, so it is correct under a linked-worktree layout without this
// script hand-resolving `.git/shallow`'s path.
//
// Repair (plan 4189) is BOUNDED, CUMULATIVE `git fetch --deepen=<n>` rounds, not one
// all-or-nothing `git fetch --unshallow` — the earlier single-call design (plan 3274)
// could not fit this repo's real history (~703k objects / ~520 MiB over ~84k commits,
// measured 2026-08-28; a 2026-08-18 estimate of ~75k commits / ~2.4GB in this comment
// was stale and wrong) inside any bound short enough not to hang a whole firing, and a
// KILLED `--unshallow` keeps nothing (its objects sit in a discarded temporary pack), so
// every retry restarted from zero and never converged — two dead cloud firings
// (2026-08-28, 2026-09-25) before the fix. `--deepen=<n>` is different: a round that
// COMPLETES moves `.git/shallow`'s boundary and keeps its objects, so progress survives
// both a killed round and a rerun of this whole preflight in the same container. See the
// DEEPEN_* constants below for the schedule (start/max depth, per-round and total-budget
// timeouts) and `main()`'s shallow-clone block for the loop, the halve-on-timeout retry,
// the "completed but no boundary movement" closer, and the PARTIAL-budget-exhaustion exit
// (rerun-safe, not a dead end). Calling `--unshallow`/`--deepen` on an already-complete
// repo is itself a git error ("does not make sense"), so this runs ONLY when the shallow
// check is true, never unconditionally. Every repair fetch (and the orient fetch below)
// names ORIGIN_MASTER_REFSPEC explicitly: the cloud clones' configured wildcard refspec
// made each "250-commit" round also fetch all ~371 origin heads — the leading suspect for
// not one round ever completing on a cloud box (2026-09-25, plan 4221). The repair fetches
// also pass `--filter=blob:none` (REPAIR_FILTER), so the checkout ends as a non-shallow
// PARTIAL clone: commits and trees are local, old blobs are fetched lazily. Success means
// origin/master's history is whole — a leftover `.git/shallow` line that no origin/master
// commit reaches (a boundary of some other, e.g. since-deleted, ref) is logged and
// accepted, not a wedge. A repair that fails outright, or that exhausts every round
// without completing origin/master's history, FAILS LOUD (exit 1, named cause)
// rather than letting a corrupted merge-base surface later mid-rebase. Runs after guards
// 1-4 (same disposability envelope) and before the stale-master path, so a shallow
// boundary can never skew that path's own rev-list/merge-base math.
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
// Shallow-clone repair bounds (plan 4189, cumulative-deepen; plan 3274 original).
// Measured 2026-08-28: this repo's full history is ~703k objects / ~520 MiB over ~84k
// commits, and at the ~1.5 MiB/s cloud-egress rate observed the same day that is ~350s of
// pure transfer plus server-side counting — too large for any single bounded
// `git fetch --unshallow` call, which is why the repair now runs as rounds instead of one
// all-or-nothing fetch:
//   - DEEPEN_ROUND_TIMEOUT_MS bounds EACH round's `git fetch --deepen=<n>` (or the
//     closer's `--unshallow`) call — a wedged network/proxy fails that one round loud
//     instead of hanging the whole firing.
//   - DEEPEN_TOTAL_BUDGET_MS bounds the WHOLE repair loop across all rounds; a healthy
//     ~350s transfer fits in one run, a slower path finishes across a rerun (S5: budget
//     exhaustion after real progress is reported PARTIAL, not a dead end — progress is
//     kept in `.git/shallow` and a rerun in the same container picks up from there).
//   - DEEPEN_START is the first round's `--deepen=<n>` depth (commits); it DOUBLES after
//     every round that completes and moves the boundary, capped at DEEPEN_MAX. A round
//     that TIMES OUT instead halves its depth (floor DEEPEN_FLOOR) and retries; a timeout
//     AT the floor aborts as wedged rather than retrying forever.
// Each round (and the closer) fetches master ONLY, via ORIGIN_MASTER_REFSPEC below — never
// the configured `remote.origin.fetch`, whose wildcard pulled every origin head into every
// round — and filtered by REPAIR_FILTER (plan 4221). Measured 2026-09-26 on a cloud-shaped
// clone of GitHub: master's full history is ~1.8 GiB unfiltered but ~78 MiB / ~108k commits
// with blob:none (49s), hence the larger START/MAX below. Never `tree:0`: path-limited
// `git log` then timed out at 300s.
// DEEPEN_TOTAL_BUDGET_MS is overridable per-run (tests use a sub-second value; a
// genuinely slow environment can raise it) via the env var below — read through the same
// injectable `env` param guard 2 already uses, never bare `process.env`. The env var's
// NAME is unchanged from the original single-call design (plan 3274) — only its MEANING
// changed, from "bound the one --unshallow call" to "bound the whole repair loop" — so no
// existing caller or documented override string breaks.
export const DEEPEN_ROUND_TIMEOUT_MS = 150_000; // 2.5 minutes per round
export const DEEPEN_TOTAL_BUDGET_MS = 540_000; // 9 minutes total, across all rounds
export const DEEPEN_START = 16_000; // first round's --deepen=<n> depth, in commits
export const DEEPEN_MAX = 64_000; // per-round depth cap after doubling
export const DEEPEN_FLOOR = 250; // per-round depth floor after halving on timeout
export const UNSHALLOW_TIMEOUT_ENV = 'CLOUD_CHECKOUT_UNSHALLOW_TIMEOUT_MS';
// The one refspec every fetch in this file names (plan 4221): nothing downstream reads a
// remote-tracking ref other than origin/master.
export const ORIGIN_MASTER_REFSPEC = '+refs/heads/master:refs/remotes/origin/master';
// The partial-clone filter every repair fetch passes (plan 4221): commits and trees only,
// blobs on demand — enough for merge-base and path-limited `git log`.
export const REPAIR_FILTER = 'blob:none';

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
  // plan 4189 S1: the ONE injectable seam for the shallow-clone repair loop below — a
  // function `(depthOrUnshallow, { timeoutMs }) => void` that either runs
  // `git fetch --deepen=<depthOrUnshallow>` (a number) or, for the closer,
  // `git fetch --unshallow` (the literal string `'unshallow'`), and throws the same
  // `ETIMEDOUT`-coded error `execFileSync`'s own `timeout` option throws on a kill. Left
  // undefined, the default below runs the real fetch through the same `runGit` closure
  // every other git call in this file uses. Shallow-state and progress reads (is this
  // still shallow; did `.git/shallow` change) are NEVER routed through this seam — they
  // stay on the real `git` closure / a direct read of `.git/shallow`, so a test injecting
  // a fake fetch still exercises the real detection logic.
  deepenFetch,
  // plan 4189: the injectable clock the repair loop's TOTAL-budget bookkeeping reads —
  // never a real timer a test would have to wait on (vetapp CLAUDE.md's ambient-load-state
  // rule). Defaults to the real wall clock.
  now = Date.now,
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
    // Read the TOTAL-budget bound through the injectable `env` param (same guard-2
    // seam), never bare process.env — falls back to the default on anything
    // unset/blank/non-positive. Same env var as the original single-call design (plan
    // 3274); only its meaning changed (see the constants' header above).
    const rawTimeout = env[UNSHALLOW_TIMEOUT_ENV];
    const parsedTimeout = Number(rawTimeout);
    const totalBudgetMs =
      rawTimeout !== undefined &&
      rawTimeout !== null &&
      String(rawTimeout).trim() !== '' &&
      Number.isFinite(parsedTimeout) &&
      parsedTimeout > 0
        ? parsedTimeout
        : DEEPEN_TOTAL_BUDGET_MS;

    // Progress reads are NEVER routed through the injectable `deepenFetch` seam (S1/S2) —
    // a direct read of the real `.git/shallow` file under `dir`. `null` means either
    // "never was shallow" (not reached here) or "fully unshallowed" (the file is removed
    // once no boundary remains); a non-null Buffer is compared byte-for-byte across
    // rounds to detect a moved boundary, never via string coercion (shallow-file content
    // is a list of 40-char shas, one per line — a byte compare is exact and cheap).
    const shallowFilePath = join(dir, '.git', 'shallow');
    const readShallowRaw = () => {
      try {
        return readFileSync(shallowFilePath);
      } catch {
        return null;
      }
    };

    // The default seam (S1): a real `git fetch --deepen=<n>` (or, for the closer, the
    // literal string 'unshallow' → `git fetch --unshallow`), bounded by the caller's
    // `timeoutMs` and reusing the same `runGit`/ETIMEDOUT contract the rest of this file
    // relies on. A test overrides this by passing its own `deepenFetch` to `main()`.
    const runDeepenFetch =
      deepenFetch ||
      ((depthOrUnshallow, { timeoutMs }) => {
        const arg =
          depthOrUnshallow === 'unshallow' ? '--unshallow' : `--deepen=${depthOrUnshallow}`;
        runGit(undefined, { timeout: timeoutMs, killSignal: 'SIGTERM' })(
          'fetch',
          arg,
          `--filter=${REPAIR_FILTER}`,
          '-q',
          'origin',
          ORIGIN_MASTER_REFSPEC,
        );
      });

    // Is origin/master's history whole? A filtered repair leaves a partial (promisor) clone
    // that is simply not shallow, so it counts as whole. True when git no longer reports
    // shallow, OR when no `.git/shallow` line is an ancestor of (or equal to) origin/master — the leftover
    // boundaries then belong to other refs' history only. `--is-ancestor` exits 1 for a
    // clean "no"; any other failure is an error and throws, never read as "not ancestor".
    // An unreadable or empty shallow file while git says shallow proves nothing: not whole.
    const originMasterHistoryWhole = () => {
      if (git('rev-parse', '--is-shallow-repository').trim() !== 'true') {
        return { whole: true, remaining: 0 };
      }
      const raw = readShallowRaw();
      const boundaries = (raw === null ? '' : raw.toString('utf8'))
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (boundaries.length === 0) return { whole: false, remaining: 0 };
      for (const b of boundaries) {
        try {
          git('merge-base', '--is-ancestor', b, 'refs/remotes/origin/master');
          return { whole: false, remaining: boundaries.length };
        } catch (e) {
          if (e.status !== 1) throw e;
        }
      }
      return { whole: true, remaining: boundaries.length };
    };

    log(
      `SHALLOW CLONE detected (.git/shallow) — repairing in bounded, cumulative ` +
        `\`git fetch --deepen\` rounds (start ${DEEPEN_START}, max ${DEEPEN_MAX} ` +
        `commits/round, ${DEEPEN_ROUND_TIMEOUT_MS}ms/round, ${totalBudgetMs}ms total ` +
        `budget, override via ${UNSHALLOW_TIMEOUT_ENV}).`,
    );

    const startTime = now();
    let depth = DEEPEN_START;
    let rounds = 0;
    // Completed rounds that actually MOVED the boundary — the only progress a rerun keeps
    // (S2), and so the one thing that turns a budget/closer stop into a PARTIAL (S5).
    let progressRounds = 0;
    let fullyRepaired = false;
    let noProgressRound = false;
    // S5: real progress was made and is kept in `.git/shallow` — a rerun, not a dead end.
    // Exit code stays 1 (the prompts' "on ANY non-zero exit do not proceed" contract is
    // untouched); the distinct `PARTIAL —` line is what tells the drain prompt (see
    // CHECKOUT_PREFLIGHT_BLOCK) to rerun instead of giving up.
    const partial = () => {
      err(
        `PARTIAL — shallow-clone repair made progress (${progressRounds} rounds, boundary ` +
          `moved) but ran out of its ${totalBudgetMs}ms budget; rerun the same ` +
          'command once, progress is kept.',
      );
      return 1;
    };

    while (true) {
      const elapsedMs = now() - startTime;
      const remainingMs = totalBudgetMs - elapsedMs;
      if (remainingMs <= 0) break; // total budget exhausted — handled below the loop
      const roundTimeoutMs = Math.min(DEEPEN_ROUND_TIMEOUT_MS, remainingMs);
      const before = readShallowRaw();
      log(`round ${rounds + 1}: git fetch --deepen=${depth} (bounded to ${roundTimeoutMs}ms).`);
      try {
        runDeepenFetch(depth, { timeoutMs: roundTimeoutMs });
      } catch (e) {
        // A real execFileSync timeout kill reports `code: 'ETIMEDOUT'` with `signal` set
        // to the killSignal and `status: null` — distinct from an ordinary non-zero exit
        // (status set, code undefined). Verified empirically (plan 3274) on this
        // platform. That distinction is the point: an operator or an unattended drain
        // reading this output must be able to tell "this one round was too slow" apart
        // from "the fetch was rejected" — so a timeout gets its own cause line, never the
        // generic one below. S2: a killed round does not reliably keep its pack (the
        // objects sit in a discarded temporary pack), so it is NEVER counted as progress
        // — only a round that RETURNS is read for a moved boundary.
        if (e && e.code === 'ETIMEDOUT') {
          if (depth <= DEEPEN_FLOOR) {
            err(
              `ABORT — shallow-clone repair TIMED OUT after ${roundTimeoutMs}ms at the ` +
                `floor depth (${DEEPEN_FLOOR} commits) — the network path is too slow or ` +
                'wedged even at the smallest round this repair will attempt.',
            );
            err(
              'This checkout cannot be trusted for merge-base/rebase against ' +
                'origin/master — do not proceed to land. Fix the fetch path ' +
                '(network/credentials/proxy) and rerun.',
            );
            return 1;
          }
          const halved = Math.max(DEEPEN_FLOOR, Math.floor(depth / 2));
          log(
            `round at depth ${depth} TIMED OUT after ${roundTimeoutMs}ms — halving to ` +
              `${halved} and retrying.`,
          );
          depth = halved;
          continue;
        }
        err('ABORT — shallow-clone repair failed (cause: git fetch --deepen origin).');
        err(`${e.message}`);
        err(
          'This checkout cannot be trusted for merge-base/rebase against origin/master — ' +
            'do not proceed to land. Fix the fetch path (network/credentials/proxy) and rerun.',
        );
        return 1;
      }
      rounds++;
      const after = readShallowRaw();
      if (after === null) {
        fullyRepaired = true;
        break;
      }
      if (before === null || before.equals(after)) {
        // A round that reports success but never moved the boundary — the closer below
        // owns this shape (S4), not another identical round. An unreadable pre-round
        // snapshot (`before === null` while git still reports shallow) proves nothing
        // moved, so it is never counted as progress either.
        noProgressRound = true;
        break;
      }
      progressRounds++;
      depth = Math.min(DEEPEN_MAX, depth * 2);
    }

    if (!fullyRepaired) {
      if (noProgressRound) {
        // S4: the closer. The boundary is presumably at or near the roots by now, so one
        // plain `git fetch --unshallow` bounded by whatever budget remains is cheap.
        const elapsedMs = now() - startTime;
        const remainingMs = totalBudgetMs - elapsedMs;
        if (remainingMs <= 0) {
          // Earlier rounds that moved the boundary are kept — a rerun finishes the job.
          if (progressRounds > 0) return partial();
          err(
            'ABORT — shallow-clone repair is wedged: a completed round made no progress ' +
              '(.git/shallow unchanged) and no budget remains for the closing ' +
              '`git fetch --unshallow`.',
          );
          err(
            'This checkout cannot be trusted for merge-base/rebase against origin/master ' +
              '— do not proceed to land. Fix the fetch path (network/credentials/proxy) ' +
              'and rerun.',
          );
          return 1;
        }
        log(
          'a completed round made no progress — running the closer: one plain ' +
            `\`git fetch --unshallow\`, bounded to the remaining ${remainingMs}ms.`,
        );
        try {
          runDeepenFetch('unshallow', { timeoutMs: remainingMs });
        } catch (e) {
          // Same timeout-vs-rejection split as the round catch above. A TIMED-OUT closer
          // after rounds that moved the boundary keeps that progress, so it is a rerun
          // (PARTIAL); a rejected closer is a broken fetch path whatever came before.
          if (e && e.code === 'ETIMEDOUT') {
            if (progressRounds > 0) return partial();
            err(
              `ABORT — shallow-clone repair TIMED OUT after ${remainingMs}ms (cause: the ` +
                'closing git fetch --unshallow origin exceeded the remaining budget, and no ' +
                'round ever moved the boundary — the network path is too slow or wedged).',
            );
          } else {
            err(
              'ABORT — shallow-clone repair failed (cause: closing git fetch --unshallow origin).',
            );
            err(`${e.message}`);
          }
          err(
            'This checkout cannot be trusted for merge-base/rebase against origin/master ' +
              '— do not proceed to land. Fix the fetch path (network/credentials/proxy) ' +
              'and rerun.',
          );
          return 1;
        }
        // Fall through to the stillShallow re-check below — the closer reporting success
        // is not itself proof: a wedged repair (S4/S2's "no progress" case) is caught
        // there, not here.
      } else {
        // The while loop exited because the TOTAL budget ran out mid-round-schedule, not
        // because a round completed with nothing to show for it.
        if (progressRounds > 0) return partial();
        err(
          'ABORT — shallow-clone repair is wedged: no round completed within its ' +
            `${totalBudgetMs}ms total budget.`,
        );
        err(
          'This checkout cannot be trusted for merge-base/rebase against origin/master — ' +
            'do not proceed to land. Fix the fetch path (network/credentials/proxy) and rerun.',
        );
        return 1;
      }
    }

    let masterHistory;
    try {
      masterHistory = originMasterHistoryWhole();
    } catch (e) {
      err(`cannot re-verify shallow-clone state after repair: ${e.message}`);
      return 1;
    }
    if (!masterHistory.whole) {
      err(
        'ABORT — shallow-clone repair is wedged: still shallow after the repair reported ' +
          'success (no round ever moved the boundary). Do not proceed to land.',
      );
      return 1;
    }
    if (masterHistory.remaining > 0) {
      log(
        `shallow-clone REPAIRED for origin/master (${masterHistory.remaining} boundary ` +
          'line(s) remain on other refs, none reachable from origin/master).',
      );
    } else {
      log(
        `shallow-clone REPAIRED (${rounds} deepen round(s)) — full history fetched, ` +
          '.git/shallow cleared.',
      );
    }
  }

  // ── orient against a FRESH origin/master ───────────────────────────────────────────
  try {
    // No explicit --filter: once a filtered repair ran, git recorded remote.origin.promisor +
    // partialclonefilter, so this fetch is filtered the same way anyway.
    git('fetch', '-q', 'origin', ORIGIN_MASTER_REFSPEC);
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
  const nowSha = git('rev-parse', 'refs/heads/master').trim();
  const originNow = git('rev-parse', 'refs/remotes/origin/master').trim();
  if (nowSha !== originNow) {
    err(`reset landed on ${nowSha}, expected origin/master ${originNow} — inspect by hand.`);
    return 1;
  }
  log(
    `REPAIRED — local master reset to origin/master (${nowSha.slice(0, 12)}); stale tip preserved at ${backup}.`,
  );
  return 0;
}

// CLI only (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main({}));
}
