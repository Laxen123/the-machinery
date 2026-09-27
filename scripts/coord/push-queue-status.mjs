#!/usr/bin/env node
// scripts/push-queue-status.mjs — THE one probe for "is my push queued, or dead?" (plan 1795).
//
// WHY: during the 2026-07-13 storm (894 procs, 3 concurrent full batteries), sessions watching a
// silent `git push` through a 2-minute default Bash timeout concluded the push had FAILED and
// retried — each retry adding another pre-push battery to an already-saturated machine. The caps
// (battery-lock, test-queue, vitest pool) all held; the amplification came from BLIND RETRIES,
// because nothing told a session "your push is alive, position N in a machine-wide queue". This
// probe is that surface: run it BEFORE any push retry (the rule lives in vetapp CLAUDE.md +
// docs/coord/worktrees.md § Push retry discipline).
//
// Aggregates the three places a silently-waiting push can be queued behind:
//   1. battery-lock — the scripts/*.test.mjs battery mutex in the shared .git common dir
//      (scripts/battery-lock.mjs; this clone only).
//   2. test-queue — the machine-global heavy-test slot queue in os.tmpdir() (scripts/coord/test-queue.mjs;
//      every repo on the box).
//   3. live push machinery processes — sh running .husky/pre-push, node run-land-tests.mjs,
//      node --test trees (Windows CIM scan; null elsewhere or on scan failure).
//   4. live `git push` processes themselves, with orphan-aware ancestry (plan 2731): a wedge-
//      sweeper/timeout kill can sever a running push from its session — the harness reports the
//      task FAILED while git lives on, still holding its battery-lock queue slot. A push whose
//      command line names the CURRENT branch gets an explicit DO-NOT-RE-PUSH verdict, making the
//      "never re-push while the first process is alive" rule checkable rather than advisory.
//
// READ-ONLY, always exit 0: a probe must never mutate a queue, reap a lock, or block anything —
// failures degrade to a reported field, never a non-zero exit (a caller's `&&` chain must not
// mistake a probe hiccup for "the queue is broken"). Usage:
//   node scripts/push-queue-status.mjs            # human-readable
//   node scripts/push-queue-status.mjs --json     # machine-readable
// Test seams: --queue-dir <dir> / --lock-path <path> / --overflow-lock-path <path> point the reads
// at fixtures.

import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  readEntry,
  resolveLockPath,
  resolveTierPaths,
  describeEntry,
  isStale,
  holderProvedDead,
  assertFlagValue,
  DEFAULT_STALE_MIN,
} from './battery-lock.mjs';
import { parseFlags } from './coord-git.mjs';
// The git GLOBAL options that take a separate-token value (`git -C <dir> push …`). One table, not
// two — see classifyPushCmd's note (plan-2734 review round 6).
import { GLOBAL_VALUE_FLAGS } from './git-maintenance-guard.mjs';
import { pwshExe, pwshCandidates } from './pwsh-exec.mjs';
import {
  readTickets,
  computeHolders,
  compareWaiting,
  defaultLowPromoteMs,
  effectiveTier,
  normalizeTier,
  isLiveTicket,
  resolveTestQueueConcurrency,
  DEFAULT_QUEUE_DIR,
  DEFAULT_CONCURRENCY,
  STALE_MS,
} from './test-queue.mjs';

// --- pure core (unit-tested without fs/processes) ----------------------------

function describeTicket(t, now, { waiting = true } = {}) {
  const label = t.label ?? '?';
  const waitedSec = Math.max(0, Math.round((now - t.startedWaiting) / 1000));
  // Plan 2716. For a WAITER, show the EFFECTIVE tier — after the starvation guard — because that
  // is what decides the serve order this list exists to explain. For a RUNNING holder, show its
  // PLAIN tier: the guard is a waiting-only rule (it reorders a queue; it cannot reorder work
  // already in flight), so passing a holder through effectiveTier would relabel a long-running
  // `low` job as `medium` purely because it had been running a while — a tier the queue never
  // assigned it and never acts on.
  const tier = waiting ? effectiveTier(t, now) : normalizeTier(t.tier);
  return {
    pid: t.pid,
    label,
    host: t.host ?? '?',
    tier,
    waitedSec,
    line: `pid ${t.pid} "${label}" [${tier}] (host ${t.host ?? '?'}, ${waitedSec}s in queue)`,
  };
}

// `git push` options that consume the NEXT token as their value. Module-level so the Set is built
// once, not per classification — this runs against every live push in a scan, during a storm.
const VALUE_OPTS = new Set([
  '-o',
  '--push-option',
  '--repo',
  '--receive-pack',
  '--exec',
  '--recurse-submodules', // check|on-demand|only|no — takes a value in the split form too
]);

// classifyPushCmd — does this live `git push` command line target `branch`? (plan 2731 review)
//   'match'          an explicit refspec token names the branch (either side of src:dst)
//   'indeterminate'  the push has no explicit refspec (bare `git push`, `HEAD`, `HEAD:x`,
//                    --all/--mirror) — its target depends on that process's OWN repo/HEAD,
//                    which a command line cannot reveal. Reported separately, never silently
//                    dropped: `git push origin HEAD:master` is a real production shape here
//                    (the land spine, branch-hygiene.md), and the incident's whole lesson is
//                    that an invisible live push gets duplicated.
//   'other'          explicit refspec(s) present, none naming the branch
// Substring matching is NOT enough (first-review finding): `worktree-2731-x` must not match a
// push of `worktree-2731-x-v2`, so only whole refspec tokens count.
export function classifyPushCmd(cmd, branch) {
  // Quote-aware tokenization: a quoted span is ONE token with its quotes stripped. The first cut
  // DELETED quoted spans outright to get rid of the Windows exe path (`"C:\Program Files\Git\…"`,
  // which contains spaces) — but that also deleted a quoted REFSPEC, so a perfectly explicit
  // `git push origin "HEAD:refs/heads/worktree-x"` lost its refspec and fell through to the weakest
  // verdict, 'indeterminate' (plan-2734 delta review). Keeping the span as a token fixes that while
  // still solving the original problem: the exe path survives as a single token that simply is not
  // the literal `push`, so it cannot shift the refspec positions below.
  const tokens = (String(cmd ?? '').match(/"[^"]*"|\S+/g) ?? []).map((t) =>
    t.length > 1 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t,
  );
  // Find the SUBCOMMAND. Three constraints had to hold at once, each from a different review round:
  //   - `git -C <dir> push …` — every coord script drives a temp checkout this way, so a global
  //     option's VALUE must be consumed with it or a directory named `push` becomes the subcommand
  //     (round 5). GLOBAL_VALUE_FLAGS is git-maintenance-guard's table, imported rather than
  //     re-listed: the local copy this replaced was already missing --config-env and
  //     --super-prefix, and a global value read as the subcommand reports a live push as 'other'.
  //   - `push origin <branch>` with NO executable token — a command line may carry arguments only,
  //     so index 0 cannot be assumed to be the exe (round 6).
  //   - `git log --grep push …` must NOT read as a push. Hence at most ONE leading bare token is
  //     skipped as the executable; a second one means a different subcommand, and we stop.
  // Accepted limitation: an UNQUOTED executable path containing spaces splits into several bare
  // tokens and stops the scan (⇒ 'other'). Win32 command lines quote such paths, and the tokenizer
  // above keeps a quoted span whole, so this is unreachable in the shape this probe actually reads.
  let at = -1;
  let sawExe = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (GLOBAL_VALUE_FLAGS.has(t))
      i++; // consume the flag AND its value
    else if (t.startsWith('-'))
      continue; // a valueless global (--no-pager, --bare) — skip
    else if (t === 'push') {
      at = i;
      break;
    } else if (sawExe)
      break; // a SECOND bare token that isn't `push` ⇒ a different subcommand
    else sawExe = true; // the first bare token is the executable — or, if it were `push`, the
    // subcommand itself, which the branch above already took
  }
  if (at < 0) return 'other';
  const rest = tokens.slice(at + 1);
  // ONE pass over the push's own arguments. The option scan and the mode flags must share it: read
  // separately, `git push -o --tags origin` counted the `-o` VALUE as a real `--tags` and reported
  // the push as tag-only (review round 6). A token consumed as a value is not an option at all.
  // `--follow-tags` is deliberately absent from the tag test — it pushes the BRANCH and its tags.
  let tagsOnly = false;
  let everyBranch = false;
  const args = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (VALUE_OPTS.has(t))
      i++; // skip the flag AND its value
    else if (t === '--all' || t === '--mirror' || t === '--branches') everyBranch = true;
    else if (t === '--tags') tagsOnly = true;
    else if (!t.startsWith('-')) args.push(t);
  }
  if (everyBranch) return 'indeterminate'; // every branch of ITS repo — may or may not include ours
  // The first positional is ALWAYS the repository; refspecs follow it. `--repo` does NOT change
  // that — review round 4 claimed it did (git's docs say a command-line repository "takes
  // precedence", which reads like --repo substitutes for one when absent), round 5 claimed the
  // opposite, and neither is evidence. Measured on real git instead:
  //   $ git push --repo https://example.invalid/x.git aaa master --dry-run
  //   fatal: 'aaa' does not appear to be a git repository
  // The positional was taken as the REPOSITORY with --repo present, so positional parsing is
  // unaffected and the round-4 special case is reverted. Consuming --repo's VALUE (above) is still
  // right and is a separate matter — that value must never land in this positional list.
  const refspecs = args.slice(1);
  if (refspecs.length === 0) return tagsOnly ? 'other' : 'indeterminate';
  let sawHead = false;
  // A token names the branch iff it IS the branch name, or that name under its one legal
  // `refs/heads/` prefix. `branch` is a branch NAME (what `git rev-parse --abbrev-ref HEAD` emits)
  // and is NEVER normalized — DO NOT "helpfully" strip a prefix off it. Two rounds of this:
  //   1. Testing only `=== branch` missed `git push origin HEAD:refs/heads/<branch>` — the fully
  //      qualified form, the one you reach for BECAUSE it is unambiguous — which fell through to
  //      `sawHead` ⇒ 'indeterminate'. The most explicit refspec a caller can write produced the
  //      WEAKEST verdict, exactly when a session needs certainty about whether to retry.
  //   2. Normalizing BOTH sides then conflated a branch legitimately NAMED `refs/heads/foo` (git
  //      allows it, and `--abbrev-ref` reports it verbatim) with the branch `foo`.
  // A RESIDUAL ambiguity survives and is accepted, not overlooked: for a branch actually named
  // `refs/heads/foo`, the token `refs/heads/foo` is BOTH its short form and the qualified form of
  // the ordinary branch `foo`. Git resolves that against the real ref namespace; a command line
  // cannot. The error direction is the safe one — over-matching yields "a push of your branch is
  // live, do not re-push", so the session WAITS rather than duplicating a push, which is the
  // failure this probe exists to prevent. Whole-token throughout, never substring: `worktree-x`
  // cannot match `worktree-x-v2`, the property the plan-2731 review pinned.
  const qualified = `refs/heads/${branch}`; // hoisted: rebuilt per endpoint in the first cut
  const namesBranch = (r) => r === branch || r === qualified;
  for (const raw of refspecs) {
    const t = raw.replace(/^\+/, ''); // +refspec = force, same target
    const [src, dst] = t.includes(':') ? t.split(':', 2) : [t, t];
    if (namesBranch(src) || namesBranch(dst)) return 'match';
    if (src === 'HEAD' || t === 'HEAD') sawHead = true;
  }
  return sawHead ? 'indeterminate' : 'other';
}

// summarize — pure aggregation of the two queue reads + the process scan into one status object.
// batteryEntry: undefined = free, null = corrupt-but-held, object = held (readEntry's contract).
export function summarize({
  batteryEntry,
  batteryError = null,
  batteryHolderDead = false,
  // plan 2734: the OVERFLOW tier — the single slot an admitted timed-out waiter holds while it runs
  // a clamped battery. Same readEntry contract as batteryEntry (undefined = free). Omitting it (an
  // older caller, a fixture written before the tier existed) reports 'free', which is exactly the
  // pre-2734 picture rather than a crash.
  overflowEntry,
  overflowError = null,
  overflowHolderDead = false,
  tickets,
  queueError = null,
  processes,
  now,
  concurrency = DEFAULT_CONCURRENCY,
  staleMs = STALE_MS,
  currentBranch = null,
}) {
  // A present-but-REAPABLE entry (past the age ceiling, OR — plan 2549 — a same-host entry whose
  // DECLARED holder pid is provably dead; the caller computes `batteryHolderDead` via battery-lock's
  // holderProvedDead so this stays pure) is reported as its own state and does NOT count as busy:
  // the next real `acquire` reaps it and passes straight through, so telling a session to wait on
  // it would mask the push's actual problem (review finding 1 — exactly the post-storm state where
  // lingering locks are most likely; review 2549 finding [1] — an age-only probe told sessions to
  // wait out a 120-min ceiling on a lock the next acquire would reap instantly).
  // One classifier for both tiers (plan 2734) — a second hand-rolled copy would be free to drift on
  // the stale-vs-held boundary, which is precisely the distinction this probe exists to report.
  const classifyLock = (entry, error, holderDead) =>
    error
      ? { state: 'unknown', error }
      : entry === undefined
        ? { state: 'free' }
        : isStale(entry, now, DEFAULT_STALE_MIN) || holderDead
          ? { state: 'stale', holder: describeEntry(entry, now) }
          : { state: 'held', holder: describeEntry(entry, now) };
  const battery = classifyLock(batteryEntry, batteryError, batteryHolderDead);
  const overflow = classifyLock(overflowEntry, overflowError, overflowHolderDead);

  // `live` exists for the holders/waiting DISPLAY split below. computeHolders re-runs the same
  // isLiveTicket boundary internally (it filters whatever it is given), so feeding it `live` is
  // merely harmless — the predicate still runs twice, in two call sites that must stay in
  // lockstep by convention (delta-review finding 3; test-queue.mjs owns the boundary either way).
  const live = (tickets ?? []).filter((t) => isLiveTicket(t, now, staleMs));
  const holderPids = computeHolders(live, now, concurrency, staleMs);
  const byFifo = (a, b) => a.startedWaiting - b.startedWaiting || a.pid - b.pid;
  // Waiters are listed in the order they will actually be SERVED — tier first, then FIFO — via
  // the queue's own comparator (plan 2716). A local re-rolled sort here would drift from the
  // assignment core the moment either side changed, and a status probe that shows a different
  // order than the queue serves is worse than no probe. Holders keep plain FIFO: they are all
  // running already, so arrival order is the only meaningful thing left to say about them.
  // Resolved ONCE (it parses an env var) rather than per comparison inside the sort.
  const promoteMs = defaultLowPromoteMs();
  const testQueue = queueError
    ? { state: 'unknown', error: queueError, concurrency, holders: [], waiting: [] }
    : {
        state: 'ok',
        concurrency,
        holders: live
          .filter((t) => holderPids.has(t.pid))
          .sort(byFifo)
          .map((t) => describeTicket(t, now, { waiting: false })),
        waiting: live
          .filter((t) => !holderPids.has(t.pid))
          .sort((a, b) => compareWaiting(a, b, now, promoteMs))
          .map((t) => describeTicket(t, now)),
      };

  // Live pushes for THIS branch (plan 2731), matched on whole refspec tokens via classifyPushCmd
  // (branch names are repo-agnostic keys: a worktree branch name is globally unique; `master` is
  // weak and can also match a sibling repo's push, which still errs on the safe side — the
  // verdict is "don't add another push to the pile"). Implicit-target pushes (bare/HEAD/--all)
  // are surfaced as their own bucket rather than silently missed. An ORPHANED push (dead
  // ancestor chain — its wrapper was sweeper/timeout-killed) is exactly the case the session
  // cannot see: its task reported FAILED, yet git still runs and still holds queue position.
  const pushes = processes?.pushes ?? [];
  const livePushes = currentBranch
    ? pushes.filter((p) => classifyPushCmd(p.cmd, currentBranch) === 'match')
    : [];
  const indeterminatePushes = currentBranch
    ? pushes.filter((p) => classifyPushCmd(p.cmd, currentBranch) === 'indeterminate')
    : [];

  // busy — the verdict the retry-discipline rule keys on: ANY of these means a silent push on
  // this machine is plausibly QUEUED, so a retry is the wrong move. Unknown/stale reads count as
  // NOT busy on their own (a probe error / a crashed holder's leftover is not evidence of load),
  // but the verdict line names them. ALL THREE process counts vote (review finding 0): a live
  // run-land-tests or node --test tree is machine load even when its sh wrapper is already gone
  // or it runs outside the pre-push hook entirely. ANY live push is push machinery and votes
  // busy regardless of branch (second-review finding); the branch filter only decides which
  // pushes earn the explicit DO-NOT-RE-PUSH verdict.
  // ── THE BYPASS THIS PROBE WAS BLIND TO (plan 2734) ────────────────────────────────────────────
  // Measured 2026-08-02: this tool printed `test-queue: 0/2 slot(s) held, 0 waiting` while the SAME
  // probe counted 27 pre-push shells and 11 live `node --test` processes. Nothing was queued because
  // every waiter had already timed out PAST the queue and run unserialized — so the occupancy line
  // read REASSURING at the exact moment the mechanism had been abandoned. Occupancy can never see
  // that on its own, because an unserialized battery holds nothing. The observable signature is
  // LIVE TEST TREES WITH NO LOCK TIER BEHIND THEM, and it needs no new writer anywhere:
  //   'unlocked'      — test trees live while NEITHER tier is held. NOTHING on this machine holds a
  //                     battery lock, so whatever is running is running unserialized. The strongest
  //                     statement the available data supports, and the one the storm needed.
  //   'partly-owned'  — a tier IS held while test trees are live. It does NOT say those trees belong
  //                     to the holder, and it does NOT say any runner is accounted for: nothing here
  //                     attributes a process to a lock (one battery spawns many `node --test`
  //                     children, so the live set may be entirely the holder's — or may include a
  //                     manual run and a second unadmitted battery beside it, indistinguishable).
  //                     Three review rounds walked this claim back: the first cut called the state
  //                     'accounted' and suppressed the warning entirely; the second said "at least
  //                     one runner has an owner", which is still unsupported — a lock can be held
  //                     through a setup phase, or by another clone, while every scanned runner is
  //                     unserialized. The report now states the two facts and asserts no link.
  //   'none'          — no live test trees.
  //   'lock-unreadable' — test trees live, no tier READS as held, but at least one tier could not be
  //                     read at all. "NEITHER tier is held" is then unestablished, so this must not
  //                     collapse into 'unlocked' and fire the loud alarm on what may be a perfectly
  //                     serialized machine (delta review) — nor into 'partly-owned', which would
  //                     understate a real bypass. Its own state, its own caveat line.
  //   'unknown'       — no process scan (non-Windows, or a failed CIM scan). Deliberately NOT 'none':
  //                     absence of evidence is not evidence of a quiet machine, the same posture the
  //                     QUIET verdict's own scan caveat takes.
  // Deliberately NOT claimed in any state: that a live `node --test` IS a battery. It may be a manual
  // run (`pnpm test`, a debug loop). That distinction does not change the operational advice — an
  // unserialized test tree is machine load either way — so the wording names test RUNS, not batteries.
  const nodeTestRunners = processes?.nodeTestRunners ?? null;
  const anyTierHeld = battery.state === 'held' || overflow.state === 'held';
  const anyTierUnreadable = battery.state === 'unknown' || overflow.state === 'unknown';
  const unserialized =
    nodeTestRunners == null
      ? { state: 'unknown', nodeTestRunners: null }
      : nodeTestRunners === 0
        ? { state: 'none', nodeTestRunners: 0 }
        : anyTierHeld
          ? { state: 'partly-owned', nodeTestRunners }
          : anyTierUnreadable
            ? { state: 'lock-unreadable', nodeTestRunners }
            : { state: 'unlocked', nodeTestRunners };

  const busy =
    battery.state === 'held' ||
    // A held overflow slot is a clamped battery actively running — machine load by any reading, and
    // the plan-1795 retry-discipline verdict must count it (plan 2734).
    overflow.state === 'held' ||
    testQueue.holders.length > 0 ||
    testQueue.waiting.length > 0 ||
    (processes?.prePushHooks ?? 0) > 0 ||
    (processes?.landTestRuns ?? 0) > 0 ||
    (processes?.nodeTestRunners ?? 0) > 0 ||
    pushes.length > 0;

  return {
    battery,
    overflow,
    unserialized,
    testQueue,
    processes: processes ?? null,
    currentBranch,
    livePushes,
    indeterminatePushes,
    busy,
  };
}

export function formatStatus(s, { now = Date.now(), host = hostname() } = {}) {
  const lines = [`push-queue-status @ ${new Date(now).toISOString()} (host ${host})`];
  lines.push(
    s.battery.state === 'held'
      ? `battery-lock: held by ${s.battery.holder}`
      : s.battery.state === 'stale'
        ? `battery-lock: STALE leftover from ${s.battery.holder} — a crashed holder's file; the next acquire reaps it (not counted as busy)`
        : s.battery.state === 'free'
          ? 'battery-lock: free'
          : `battery-lock: UNKNOWN (${s.battery.error})`,
  );
  // The overflow tier gets its OWN line, always — plan 2734. A report that names only the serialized
  // lock says "free" on a machine that is deliberately running a clamped bypass battery, which is
  // the same class of reassuring-but-wrong readout as the `0/2 held` line below.
  if (s.overflow) {
    lines.push(
      s.overflow.state === 'held'
        ? `battery-overflow: held by ${s.overflow.holder} — an admitted timed-out waiter is running a battery at reduced parallelism (by design; it holds this slot so a second one cannot join it)`
        : s.overflow.state === 'stale'
          ? `battery-overflow: STALE leftover from ${s.overflow.holder} — the next admission reaps it (not counted as busy)`
          : s.overflow.state === 'free'
            ? 'battery-overflow: free'
            : `battery-overflow: UNKNOWN (${s.overflow.error})`,
    );
  }
  // And the one line that makes `0/2 held` unable to read as a quiet machine ever again.
  if (s.unserialized?.state === 'unlocked') {
    lines.push(
      `UNSERIALIZED: ${s.unserialized.nodeTestRunners} live node --test process(es) while NEITHER lock tier is held — ` +
        'test runs are executing OUTSIDE the mutex (a battery that timed out past the queue, or a ' +
        'manual run; either way it is machine load). Queue occupancy cannot see this because an ' +
        'unserialized run holds nothing, so do NOT read the queue lines above as a quiet machine.',
    );
  } else if (s.unserialized?.state === 'partly-owned') {
    // Not silence, and not attribution either: a held tier means SOME serialized work exists on the
    // machine, never that any scanned process belongs to it (review round 3 — the earlier 'accounted'
    // state suppressed this line entirely, and the wording that replaced it still claimed "at least
    // one runner has an owner", which the data does not support).
    lines.push(
      `note:         ${s.unserialized.nodeTestRunners} live node --test process(es), and a lock tier IS held. Nothing here ` +
        'ties a process to the holder: one battery spawns many children, so these may all be its — ' +
        'or may include a manual run or a second unadmitted battery beside it.',
    );
  } else if (s.unserialized?.state === 'lock-unreadable') {
    lines.push(
      `note:         ${s.unserialized.nodeTestRunners} live node --test process(es), and a lock tier could NOT be read ` +
        '(see the tier lines above). No tier reads as held, but "neither is held" is not established, ' +
        'so this is not reported as an unserialized bypass. Fix the unreadable lock read before ' +
        'treating the queue lines as a quiet machine.',
    );
  }
  if (s.testQueue.state === 'unknown') {
    lines.push(`test-queue:   UNKNOWN (${s.testQueue.error})`);
  } else {
    const { holders, waiting, concurrency } = s.testQueue;
    lines.push(
      `test-queue:   ${holders.length}/${concurrency} slot(s) held, ${waiting.length} waiting`,
    );
    for (const h of holders) lines.push(`  holding: ${h.line}`);
    for (const w of waiting) lines.push(`  waiting: ${w.line}`);
  }
  lines.push(
    s.processes
      ? // prePushHooks counts sh PROCESSES with pre-push on their command line — one push spawns
        // several (husky wrapper + hook + subshells), so read it as a load gauge, not a push count.
        // Same for the git-push count: MSYS git chains cmd\git.exe -> mingw64\bin\git.exe, so one
        // push shows as ≥2 processes.
        `processes:    ${s.processes.prePushHooks} pre-push shell(s) (≫ pushes: several per push), ${s.processes.landTestRuns} run-land-tests, ${s.processes.nodeTestRunners} node --test process(es), ${(s.processes.pushes ?? []).length} git-push process(es)`
      : 'processes:    (scan unavailable on this platform / failed — see queues above)',
  );
  for (const p of s.livePushes ?? []) {
    lines.push(
      `live push:    pid ${p.pid}${
        p.orphaned
          ? ' ORPHANED (dead ancestor chain — its wrapper was killed, but the push is still running and still holds its queue slot)'
          : ''
      } — ${p.cmd}`,
    );
  }
  for (const p of s.indeterminatePushes ?? []) {
    lines.push(
      `live push:    pid ${p.pid}${p.orphaned ? ' ORPHANED' : ''} — IMPLICIT target (bare/HEAD/--all refspec; its branch depends on that process's own repo) — if your last push used an implicit refspec, treat this as YOUR push still running — ${p.cmd}`,
    );
  }
  lines.push(
    (s.livePushes ?? []).length > 0
      ? `verdict:      DO NOT RE-PUSH — a live \`git push\` for YOUR branch (${s.currentBranch}) is ` +
          'already running, even if your background task reported FAILED (a killed wrapper orphans ' +
          'the push, it does not end it — plan 2731). Wait for it to finish; if it is orphaned and ' +
          'provably stuck, kill that pid deliberately BEFORE any retry.'
      : s.busy
        ? 'verdict:      BUSY — a silent `git push` on this machine is presumed QUEUED, not dead. ' +
          'Do NOT retry; re-run this probe in a few minutes and only investigate if the queues drain ' +
          'while your push stays silent.'
        : 'verdict:      QUIET — no held lock, no queued test runs, no live push machinery. A silent ' +
          'push is NOT explained by the test queues (check the process itself, network, credentials).' +
          // Under heavy load the CIM scan is the read most likely to fail/time out — exactly when
          // its signal matters most (review finding 3) — so a QUIET verdict without it is weaker.
          (s.processes
            ? ''
            : ' CAVEAT: the process scan was unavailable — this verdict rests on the queue reads alone; ' +
              're-run before acting on it.') +
          // Same posture for an unreadable LOCK (delta review): "no held lock" is the first clause of
          // this verdict, and a tier that could not be read cannot support it. An unreadable lock is
          // not evidence of load, so it does not flip the verdict to BUSY — but it must not be
          // invisible in the one line an operator reads before deciding to retry a push.
          (s.battery?.state === 'unknown' || s.overflow?.state === 'unknown'
            ? ' CAVEAT: a lock tier could not be read (see above) — "no held lock" is unverified for ' +
              'that tier; re-run before acting on it.'
            : ''),
  );
  return lines.join('\n');
}

// --- impure reads -------------------------------------------------------------

// Windows CIM scan for the push machinery's live processes. One powershell spawn; null on any
// failure or off-Windows — the probe's queues sections stand on their own.
//
// Unfiltered Win32_Process on purpose (plan 2731): the live-push report needs git.exe PLUS the
// full pid -> (ppid, created) table to walk each push's ancestry. A chain that dies out (missing
// parent, or a "parent" younger than its child — a recycled pid) before reaching a session/console
// root is an ORPHANED push: its wrapper was killed, the push lives on, invisible to its session.
export function scanProcesses({ _exec = execFileSync, _platform = process.platform } = {}) {
  if (_platform !== 'win32') return null;
  const ps = [
    // -Property trims the WMI payload to the five fields the scan reads (second-review finding).
    '$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate);',
    '$tbl = @{}; foreach ($p in $all) { $tbl[[int64]$p.ProcessId] = $p };',
    '$procs = @($all | Where-Object { $_.CommandLine });',
    "$hooks = @($procs | Where-Object { $_.Name -eq 'sh.exe' -and $_.CommandLine -like '*pre-push*' }).Count;",
    "$rlt = @($procs | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*run-land-tests*' }).Count;",
    "$nt = @($procs | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*--test*' }).Count;",
    "$roots = @('claude.exe','explorer.exe','cmd.exe','powershell.exe','pwsh.exe','WindowsTerminal.exe','services.exe','wininit.exe');",
    "$pushes = @(); foreach ($g in @($procs | Where-Object { $_.Name -eq 'git.exe' -and $_.CommandLine -match '(^|\\s)push(\\s|$)' })) {",
    '  $cur = $g; $orphaned = $false;',
    // 32 hops is a CYCLE guard, not a truncation: recycled ppids can loop the walk (same reason
    // tab-light depth-caps all_descendants); real chains on this machine are < 10 deep.
    '  for ($i = 0; $i -lt 32; $i++) {',
    '    $par = $tbl[[int64]$cur.ParentProcessId];',
    '    if (-not $par -or ($par.CreationDate -and $cur.CreationDate -and $par.CreationDate -gt $cur.CreationDate)) { $orphaned = $true; break };',
    '    if ($roots -contains $par.Name) { break };',
    '    $cur = $par;',
    '  };',
    '  $pushes += [pscustomobject]@{ pid = [int64]$g.ProcessId; ppid = [int64]$g.ParentProcessId; orphaned = $orphaned; cmd = [string]$g.CommandLine } };',
    '[pscustomobject]@{ hooks = $hooks; rlt = $rlt; nt = $nt; pushes = $pushes } | ConvertTo-Json -Compress -Depth 4',
  ].join(' ');
  try {
    // 60s: the storm this probe exists for is exactly when Win32_Process enumeration is slowest
    // (review finding 3), so the original 30s risked losing the scan's signal when it matters
    // most — but the probe itself is typically invoked under a caller's ~120s default command
    // timeout, so a 120s child cap would let the WHOLE probe appear hung/killed under load
    // (delta-review finding 2). 60s absorbs a slow scan while leaving the caller headroom; a
    // still-slower scan degrades to null and the QUIET verdict says so (see formatStatus).
    // The shared resolver (pwsh-exec.mjs), not a hardcoded 'powershell' (second-review finding).
    // The candidate ORDER is passed in by this caller, not imported by the resolver (plan 4061 T3).
    const out = _exec(
      pwshExe({ candidates: pwshCandidates(process.platform) }),
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      {
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    const raw = JSON.parse(out.trim().split(/\r?\n/).pop() ?? '');
    if (
      typeof raw?.hooks !== 'number' ||
      typeof raw?.rlt !== 'number' ||
      typeof raw?.nt !== 'number'
    )
      return null;
    // ConvertTo-Json unrolls a one-element array to a bare object — normalize both shapes.
    const rawPushes =
      raw.pushes == null ? [] : Array.isArray(raw.pushes) ? raw.pushes : [raw.pushes];
    // MSYS git chains cmd\git.exe -> mingw64\bin\git.exe with the SAME command line — one real
    // push, two matching processes (second-review finding). Keep only the topmost of each
    // parent-child pair so the report counts pushes, not wrappers. Credentials embedded in a
    // remote URL (https://user:token@host/…) are redacted before the cmd line leaves this scan.
    const pids = new Set(rawPushes.map((p) => p.pid));
    return {
      prePushHooks: raw.hooks,
      landTestRuns: raw.rlt,
      nodeTestRunners: raw.nt,
      pushes: rawPushes
        .filter((p) => !pids.has(p.ppid))
        .map((p) => ({
          pid: p.pid,
          orphaned: Boolean(p.orphaned),
          cmd: String(p.cmd ?? '').replace(/\/\/[^@/\s]+@/g, '//***@'),
        })),
    };
  } catch {
    return null;
  }
}

// The branch a same-branch live push should be matched against. Detached HEAD / not-a-repo both
// degrade to null (no branch matching; the other surfaces still report). Exported for tests.
export function detectBranch({ _exec = execFileSync } = {}) {
  try {
    const b = _exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 15_000,
    }).trim();
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}

export function main() {
  // The shared coord parser (coord-git.mjs), not a re-rolled one (review finding 10). A flag
  // typo throws → the entry point's catch still exits 0 (the probe contract).
  const { flags } = parseFlags(process.argv.slice(2), {
    label: 'push-queue-status',
    value: ['queue-dir', 'lock-path', 'overflow-lock-path', 'branch'],
    boolean: ['json'],
    positionals: false,
    // Same reason as battery-lock's spec (plan-2734 review): every flag here is read with `??`, so
    // a valueless one at the end of argv read as absent and silently took the default — a fixture
    // probe would have pointed at the REAL machine lock, and `--branch` would have auto-detected
    // instead of matching the branch the caller named.
    requireValues: true,
  });
  // parseFlags consumes the NEXT token as a value-flag's value even when it is itself a flag
  // (`--lock-path --json` would silently set lock-path='--json' and lose --json — delta-review
  // finding 1). battery-lock's own assertFlagValue owns that check (second-review finding);
  // The EMPTY-value shape (`--lock-path=`) is refused by `requireValues` in the spec above, for
  // every flag at once — this loop used to hand-roll it per flag, and battery-lock (which needs the
  // same guard) never got a copy (review rounds 4→5). assertFlagValue still owns the OTHER shape,
  // which the parser cannot see: a value that is itself a flag (`--lock-path --json` sets
  // lock-path='--json' and loses --json), since a flag-shaped string is a perfectly good value in
  // general and only this caller knows it never is here.
  for (const k of ['queue-dir', 'lock-path', 'overflow-lock-path', 'branch'])
    assertFlagValue(flags[k], k);
  const now = Date.now();

  // ONE common-dir resolution for both tiers (review round 2): resolveLockPath per tier spawned a
  // synchronous `git rev-parse --git-common-dir` per tier, and this probe is what a session runs
  // DURING a process storm — the moment an extra spawn is least affordable. Resolved inside the try
  // so a non-repo cwd still degrades to a reported field rather than throwing, and skipped whenever
  // NO tier still needs a default (delta review): spawning git for a value that is then discarded is
  // pure cost on the same storm path, and it made those invocations depend on the cwd being a repo
  // for nothing. `--lock-path` alone is enough — the overflow tier deliberately does NOT derive its
  // path from it (see below), so an unset `--overflow-lock-path` means "treat overflow as absent",
  // which needs no resolution either. A first cut required BOTH flags and so kept the spawn on the
  // lock-path-only fixture path, which is most of them.
  let tierPaths = null;
  let tierPathsError = null;
  if (flags['lock-path'] == null) {
    try {
      tierPaths = resolveTierPaths();
    } catch (e) {
      tierPathsError = e?.message ?? String(e);
    }
  }

  let batteryEntry;
  let batteryError = null;
  try {
    const p = flags['lock-path'] ?? tierPaths?.serialized;
    if (!p) throw new Error(tierPathsError ?? 'could not resolve the battery lock path');
    batteryEntry = readEntry(p);
  } catch (e) {
    batteryError = e?.message ?? String(e); // e.g. not inside a git repo — the other surfaces still report
  }

  // The overflow tier (plan 2734), read independently so one tier's failure never blanks the other.
  // `--overflow-lock-path` is its own test seam, deliberately NOT derived from `--lock-path`: a
  // fixture pointing --lock-path at a temp file must not silently make this read the REAL machine
  // lock, and deriving a sibling filename from an arbitrary fixture path would be guesswork.
  let overflowEntry; // left undefined ⇒ classified 'free', readEntry's own contract
  let overflowError = null;
  try {
    const overflowPath =
      flags['overflow-lock-path'] ??
      // With --lock-path given but no --overflow-lock-path, the caller is pointing this probe at a
      // fixture world that has no overflow tier: report it free rather than mixing a fixture read
      // with a real-machine one. No path ⇒ no read at all (never readEntry(undefined), which would
      // throw and surface as a bogus UNKNOWN).
      (flags['lock-path'] ? null : tierPaths?.overflow);
    if (overflowPath) overflowEntry = readEntry(overflowPath);
    else if (!flags['lock-path'] && tierPathsError) throw new Error(tierPathsError);
  } catch (e) {
    overflowError = e?.message ?? String(e);
  }

  let tickets = [];
  let queueError = null;
  try {
    tickets = readTickets(flags['queue-dir'] ?? DEFAULT_QUEUE_DIR);
  } catch (e) {
    if (e?.code === 'ENOENT')
      tickets = []; // queue dir never created ⇔ empty queue, not an error
    else queueError = e?.message ?? String(e);
  }

  // The queue's own env validation (test-queue.mjs), not a drift-prone inline copy (finding 9).
  const concurrency = resolveTestQueueConcurrency();

  const processes = scanProcesses();
  const s = summarize({
    batteryEntry,
    batteryError,
    overflowEntry,
    overflowError,
    overflowHolderDead: holderProvedDead(overflowEntry),
    // Impure probe at the edge (kill(pid,0) against the entry's declared holder), so summarize
    // itself stays a pure aggregation. False for undefined/corrupt/foreign/undeclared entries.
    batteryHolderDead: holderProvedDead(batteryEntry),
    tickets,
    queueError,
    processes,
    now,
    concurrency,
    // --branch is a test seam + explicit override; default is the cwd's checked-out branch,
    // resolved only when there is a live push to match against (second-review finding — the
    // git spawn is pointless when the scan found nothing or is unavailable). Pass the NAME git
    // reports (`git rev-parse --abbrev-ref HEAD`), not a `refs/heads/…` form: classifyPushCmd
    // deliberately does not treat the two as synonyms — see its comment.
    currentBranch: flags.branch ?? (processes?.pushes?.length ? detectBranch() : null),
  });

  if (flags.json === true) {
    console.log(JSON.stringify({ at: new Date(now).toISOString(), host: hostname(), ...s }));
  } else {
    console.log(formatStatus(s, { now }));
  }
  return 0; // read-only probe: NEVER non-zero (errors are fields, not exits)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error('push-queue-status:', e?.message ?? e);
    process.exit(0); // even a crashed probe must not fail a caller's chain
  }
}
