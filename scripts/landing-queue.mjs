#!/usr/bin/env node
// scripts/landing-queue.mjs (plan 504)
// FIFO landing queue for the done-worktree spine — the cross-session ordering
// layer the 2026-06-10 two-seed-write livelock was missing. Since plan 3973 the queue
// document lives on the coord ref `refs/heads/coord/landing-queue` (the one file in its
// tree, `landing-queue.md`) and is written ONLY through landing-queue-ref.mjs's CAS loop
// (`mutateQueueRef`: read the tip → transform → commit with that tip as parent → NON-force
// push; a non-ff rejection re-reads and re-runs the transform), so ordering is race-safe
// for free: enqueue-appends commute under the retry, and push order on origin = queue
// order (the same reserve-by-push idea as next-plan-id claim). No queue verb commits to
// master any more; the master-side docs/handoff/landing-queue.md is a one-line tombstone.
// The `migrate` verb below is the one bounded heal for an old-code session that still
// wrote the master doc (plan 3973 D4).
//
// Usage:
//   node scripts/landing-queue.mjs enqueue <slug> --lane seed|free [--priority] [--session N] [--host H] [--json]
//   node scripts/landing-queue.mjs status [<slug>] [--json]
//   node scripts/landing-queue.mjs dequeue <slug>
//   node scripts/landing-queue.mjs requeue <slug> --lane seed|free [--session N] [--host H] [--note "…"] [--json]
//   node scripts/landing-queue.mjs reenter <slug> --lane seed|free [--priority] [--session N] [--host H] [--json]
//   node scripts/landing-queue.mjs heartbeat <slug>
//   node scripts/landing-queue.mjs steal <stealer-slug> [--stale-min 45] --confirm-holder-gone
//   node scripts/landing-queue.mjs demote <demoter-slug> [--stale-min 15] [--operator-override "<reason>"] [--json]
//   node scripts/landing-queue.mjs mark-holding <slug> on|off [--json]
//   node scripts/landing-queue.mjs mark-in-land <slug> [--json]
//   node scripts/landing-queue.mjs overtake <overtaker-slug> [--json]
//   node scripts/landing-queue.mjs reap <waiter-slug> [--stale-min 45] [--grace-min 10] [--json]
//   node scripts/landing-queue.mjs sweep [--json]
//   node scripts/landing-queue.mjs migrate [--no-tombstone] [--json]
//
// migrate (plan 3973): the ONE bounded heal across the transport cut-over. Reads the
// master-side doc at origin/master; when it is a real queue table (pre-cut-over, or an
// old-code session wrote it after), appends its entries and audit lines that the ref's doc
// lacks to the ref's TAIL in their order (one CAS write — the ref is bootstrapped from that
// doc when absent), then re-tombstones the master doc through coordWrite. `--no-tombstone`
// is the PRE-LAND seeding form: fold/seed only, master untouched (the tombstone comes from
// the cut-over land itself). Idempotent; exit 0 with "nothing to migrate" on a tombstone.
//
// sweep (plan 3450): the only verb with NO slug — a GHOST caller that is not a queue member.
// Every eviction above must be asked by a live waiter, and all of them run only inside
// landing-queue-watch's poll loop, so a queue whose head AND waiters are all dead sessions has
// nobody left to run them (2026-08-25: a dead head + a dead sole waiter stood 65 min past every
// threshold). `sweep` prunes landed orphans, then asks demote and then reap AS IF from a
// hypothetical tail waiter (see SWEEP_CALLER / withGhostWaiter in landing-queue-lib.mjs — the
// membership gate is SATISFIED by a verdict-only ghost entry, never weakened for real callers).
// It performs NO steal (a steal needs a holder-gone assertion an unattended process cannot
// make). Idempotent, safe from any checkout, exit 0 on nothing-to-do; exit 2 ONLY when the head
// could not be judged. The same sweep also rides every queue MUTATE (enqueue always, the
// flagless heartbeat throttled) — see maybeSweepAfterMutate.
// The QUEUE half is all this verb owns: the sibling corpse one surface over — a stranded
// 🟢 LANDING board row — belongs to plan 3443's reaper (board-lib.mjs `landingRowReapVerdict`
// + queue-drain.mjs `reapRowIfStale`), and two reapers for one class is debt, not depth.
//
// reap (plan 2331): a mechanical, non-destructive dequeue of a dead head — the
// complementary corpse class to plan 2266's mechanical steal (which needs a same-host
// pid; a cross-host/cloud head can never satisfy it) and to plan 1682's demote (which
// is capped at 2/slug/24h — past the cap, a genuinely dead head has no recourse).
// Three senses of "reap" now live in this file — see the header comment on
// reapVerdict in landing-queue-lib.mjs for the disambiguation. Gates: the waiter must
// be queued behind the head; the head's heartbeat must be > --stale-min old (default
// 45); the head must hold NO 🟢 LANDING board row AND no queue-doc HOLDING state
// (LAND_BLOCKED_HOLDING keeps its board row — `overtake` is that head's recourse, not
// reap); AND the reap must be ARMED >= --grace-min ago (default 10) — the FIRST
// otherwise-eligible invocation only stamps the arm and refuses (exit 2); a LATER
// invocation past the grace fires. Unlike steal, a reap only ever REMOVES the head
// entry — no branch/tenure/lock touched; a live-but-wedged head just re-enqueues at
// the tail on its next done-worktree run.
//
// mark-holding / overtake (plan 2275): the bounded HOLDING-overtake. The done-worktree
// spine stamps `mark-holding <slug> on` when it seams out at LAND_BLOCKED_HOLDING (the
// merge attempt aborted — the head is parked on rework, provably NOT in the merge
// window) and runs `mark-holding <slug> off` on resume, where `off` REFUSES unless the
// slug is at position 1 — that position-1-verdicted clear is the overtake/resume race
// settlement: overtake refuses unless head.state is HOLDING, the clear refuses unless
// back at head, and both re-verdict inside the coordWrite mutate, so whichever commits
// first on origin wins and the loser aborts cleanly. `overtake` lets ONE 🟩 free-lane
// waiter (never a 🟥 — a 🟩 holds no landing-lock and no 🟢 LANDING row, so the parked
// holder's retained tenure stays uncontended) whose branch diff is PATH-DISJOINT from
// the holder's branch diff swap to position 1, holder to position 2 (never the tail),
// capped at 2 overtakes per holder per 24h (audit-counted starvation guard — every
// overtake advances master and stales the holder's replay target; the 2274 watcher
// probe tells the holder immediately).
//
// demote (plan 1682): a blocked WAITER moves a stale, NOT-landing head to the TAIL —
// the liveness-keyed "release on reopen" enforcement (runbook § Queue slot = readiness;
// the 1674 hog). Sits between plan 1528's in-spine requeue trip (never fires for a
// session off reworking OUTSIDE the spine) and the 45-min steal (which REMOVES the
// entry, so demands the holder be GONE — a live-but-not-ready head is unstealable by
// design). Gates: the demoter must be queued behind the head; the head's heartbeat
// must be > --stale-min old (default 15 — clears the merge-step battery's heartbeat
// gap); the head must hold NO 🟢 LANDING board row (batch heads resolve member rows,
// the plan-1462 pattern; a LAND_BLOCKED_HOLDING 🟥 keeps its row, so seed
// hold-through-conflict is demote-immune); the demoter must not share a SESSION with
// the head (plan 2414 item 4 — a session never evicts its own other land); the head
// must NOT be IN_LAND with a provably-live holder (plan 2414 items 1+2 — the free
// lane's own liveness token, since a 🟩 land never sets the 🟢 LANDING row above; see
// mark-in-land and IN_LAND_STATE in landing-queue-lib.mjs); and ≤ 2 auto-demotes per
// slug per 24h (starvation cap — past it, the steal is the recourse). The verdict
// re-runs INSIDE the mutate, so a head that heartbeats or goes LANDING mid-demote
// aborts the write. A demote MOVES the entry (one atomic requeue commit); it can
// never remove one.
//
// demote --operator-override "<reason>" (plan 3000): the AUTHORITY path past those
// staleness gates — the 2026-08-08 operator ruling ("even on my demand, we should be able
// to move around our demote plans in the planning queue"). Every displacement verb here is
// keyed on the head being provably stale or provably gone; none models "the operator, who
// owns every session in this queue, has decided this ordering", and for a LIVE head the
// staleness axis is unreachable by construction — a head re-heartbeating every 45 s never
// leaves age 0m, so NO positive --stale-min can clear the gate (--stale-min 0 is rejected
// outright). The documented recourse was hand-editing the queue file, which bypasses the
// atomic requeue commit, the audit line AND the starvation cap at once: the worst possible
// override. This is the authenticated one.
//   SKIPPED: heartbeat staleness, the convergence axis, the IN_LAND immunity (plan 2414),
//     the ≤2/24h starvation cap (an override does not spend the automatic budget — the cap
//     protects against automated ping-pong, and the operator is who it protects), and the
//     heartbeat-ref read refusal (a guard on the staleness axes, see heartbeatRefusalFor).
//   KEPT: every structural gate — the demoter must be queued behind the head, must not
//     share a SESSION with it, the move is one atomic MOVE-not-remove requeue, and the
//     verdict re-runs INSIDE the mutate. The queue-doc read stays fail-closed.
//   ONE RESIDUAL REFUSAL: a head holding the 🟢 LANDING row is refused even under override
//     — it is inside the spine-owned merge window, so the refusal protects the merge, not
//     the head's queue position. That window is minutes wide and the message says to retry.
//   MANDATORY REASON, audited: stamped into the requeue commit subject (the
//     `edit-plan.mjs --claimed-override` precedent) and written to a SEPARATE
//     `operator-demote:` audit template, so the automatic and operator counts stay
//     structurally separable. Before acting, the command prints what the move discards —
//     head state, heartbeat age, and that the head's gate battery re-runs from the tail.
//
// mark-in-land (plan 2414): the done-worktree spine stamps `mark-in-land <slug>` at
// head-acquisition (mirrors mark-holding's shape but one-directional — see the
// function header). It is the free-lane liveness token demote's IN_LAND immunity
// keys on; a 🟩 land never acquires the landing-lock or the 🟢 LANDING board row (the
// ONLY pre-2414 "actively mid-land" signal), so without it the entire free lane was
// demote-eligible on heartbeat age alone the moment a long gate-phase battery
// outlived the last spine heartbeat.
//
// status reads the queue ref (after an explicit-refspec fetch) — the authoritative
// cross-PC view; the local tracking ref may be stale between fetches.
//
// steal: a waiter may take the head slot ONLY when the head's heartbeat is stale
// (> --stale-min, default 45) AND the caller has verified the holder is actually
// gone (no 🟢 LANDING board row, no recent commits from that session) — assert
// that with --confirm-holder-gone. A steal writes an audit line into the doc.
// plan 1462: when the head is a BATCH slug, the tool ALSO checks liveness itself —
// a batch's 🟢 LANDING marker lives on a representative MEMBER row (not a batch-slug
// row), so the steal resolves the member rows and REFUSES (even with
// --confirm-holder-gone) while any member row holds LANDING; the batch slug's own
// absence from the board must never be mistaken for "holder gone".
//
// heartbeat transport (plan 2603): a FLAGLESS `heartbeat <slug>` no longer writes this
// doc at all — it stamps the git ref refs/coord/queue-heartbeat/<slug> (no coord lock, no
// commit, no history), and every verdict that reads heartbeat AGE folds those stamps back
// over the doc's cells via decorateWithHeartbeatRefs. A heartbeat carrying `--pid` or
// `--state IN_LAND` writes real doc CONTENT, so it keeps its doc write (the queue-ref CAS
// since plan 3973) and does not stamp the heartbeat ref. Two asymmetric fail-safes, both
// load-bearing: a failed ref WRITE falls back to the doc write (a dropped ping gets a live
// head demoted/reaped), and a failed ref READ makes
// steal/demote/reap REFUSE (doc-only, every live head reads as stale). Channel rationale —
// and why a common-dir file or an inferred holder-pid could not be used, the cross-HOST
// `host=vm` case — lives in queue-heartbeat-ref.mjs.
//
// Exit codes: 0 ok · 2 refused (steal/demote not eligible / unconfirmed / heartbeat refs
// unreadable) · 5 error. dequeue/heartbeat are idempotent and always exit 0 — abort paths
// must never be blocked by queue bookkeeping.

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  resolveMain,
  git,
  gitWithLockRetry,
  coordWrite,
  withCoordCheckout,
  parseFlags,
  coordRetry,
} from './coord/coord-git.mjs';
import { loadCoordConfig, loadCoordConfigAtOrigin } from './coord/coord-config.mjs';
import { isBatchSlug } from './coord/claim-plan-lib.mjs';
import { resolveManifestAtRefTri } from './coord/batch-paths.mjs';
import {
  initialQueueDoc,
  parseQueue,
  renderQueue,
  renderQueueRow,
  isQueueTombstone,
  QUEUE_TOMBSTONE,
  enqueueEntry,
  insertPriorityEntry,
  dequeueEntry,
  requeueEntry,
  reenterEntry,
  requeueAuditLine,
  reenterAuditLine,
  heartbeatEntry,
  pruneLanded,
  pruneLandedBatches,
  positionOf,
  headOf,
  stealVerdict,
  applySteal,
  batchMemberLandingRows,
  DEFAULT_STEAL_STALE_MIN,
  demoteVerdict,
  applyDemote,
  slugHoldsLandingRow,
  DEFAULT_DEMOTE_STALE_MIN,
  DEFAULT_CONVERGE_STALE_MIN,
  CONVERGE_AXIS,
  HEARTBEAT_AXIS,
  OPERATOR_AXIS,
  normalizeOverrideReason,
  mechanicalHolderGoneVerdict,
  HOLDING_STATE,
  IN_LAND_STATE,
  UNKNOWN_SESSION,
  setEntryState,
  overtakeVerdict,
  applyOvertake,
  reapVerdict,
  armReapEntry,
  applyReap,
  DEFAULT_REAP_STALE_MIN,
  DEFAULT_REAP_GRACE_MIN,
  decorateWithHeartbeatRefs,
  demoteLocallyEligible,
  reapLocallyEligible,
  // plan 3450: the ghost sweep caller (pure; see its header in landing-queue-lib.mjs for why
  // the membership gate is SATISFIED rather than weakened) and the reserved-name guard that
  // keeps the ghost's no-collision property true at the write seam.
  SWEEP_CALLER,
  withGhostWaiter,
  reservedSlugRefusal,
} from './coord/landing-queue-lib.mjs';
// plan 3450: the sweep's throttle stamp lives beside landing-lock.json in the shared git
// COMMON dir — one stamp per checkout-family, so N parallel worktree sessions heartbeating
// against one `.git` share a single mutate-path sweep budget instead of each keeping its own.
import { resolveCommonDirPath } from './coord/lock-path.mjs';
// plan 2603: a flagless heartbeat is a ref update, not a coord write. This module owns
// the ref channel end-to-end (why it is a ref, why refs/coord/, and the two asymmetric
// fail-safes the callers below implement); landing-queue-lib.mjs owns the pure fold of
// those stamps back over the doc's cells.
import {
  HEARTBEAT_REF_PREFIX,
  readHeartbeatRefs,
  writeHeartbeatRef,
  deleteHeartbeatRef,
} from './coord/queue-heartbeat-ref.mjs';
// plan 3973: the queue DOCUMENT's transport — the coord ref, its accessor and its CAS loop.
// This module never names the ref's file or builds its refname; that is all in there.
import {
  QUEUE_REF,
  QUEUE_REF_LOCAL,
  readQueueDoc,
  readMasterQueueDoc,
  masterDocDivergence,
  mutateQueueRef,
  validateQueueDoc,
} from './coord/landing-queue-ref.mjs';
// plan 2266: the mechanical reap's landing-lock release runs IN-PROCESS via
// landing-lock.mjs's own exported primitives (review fix — avoids an extra child spawn
// and, more importantly, keeps the release verdict's {action, holder} detail instead of
// collapsing it to "did execFileSync throw" — a FOREIGN/NOT_FOUND outcome is a real
// signal, not the same as a clean RELEASED).
import { releaseAt, resolveLockPath } from './coord/landing-lock.mjs';

// plan 2266: board.mjs is still shelled out to (no importable in-process seam) for the
// mechanical reap's board-row flip.
const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD_CLI = join(HERE, 'board.mjs');

// The MASTER-side queue file path (the pre-3973 transport, now the tombstone `migrate`
// re-writes), resolved against the TARGET repo (mainDir), not this script's location — so a
// tool operating on any checkout (incl. test temp repos) uses THAT repo's coord.config.json
// (plan 857). Production: resolveMain()=vetapp → docs/handoff/landing-queue.md; a config-less
// repo → legacy landing-queue.md. The LIVE queue doc is on the ref (landing-queue-ref.mjs).
export function queueRelFor(mainDir) {
  return loadCoordConfig(mainDir).paths.queueFile;
}
// A queued slug whose plan file lives in plans/archive/ has LANDED — its entry is an
// orphan to reap (plan 574). Inside a mutate the archive axis is read at the pinned
// origin/master sha (plan 3459); the status read shares that snapshot and heals the doc
// fully on the next mutate.
const ARCHIVE_REL = 'docs/superpowers/plans/archive';
const archiveRelFor = (slug) => `${ARCHIVE_REL}/${slug}.md`;

// ── The pinned ground-truth snapshot (plan 3459) ────────────────────────────────────────
// Every displacement verb reads the queue doc at `origin/master` and then filters it through
// two OTHER questions — "has this plan landed?" (an archive/<slug>.md file) and "does this
// batch still have a claim manifest?" — to decide who is head. Before this seam those two
// were answered against the MUTABLE MAIN CHECKOUT via existsSync, and issued independently
// of the doc read and of each other. Three consequences, all of them able to displace the
// wrong session:
//   • A checkout that has not pulled reports a landed plan as still live (phantom head), and
//     a locally-created archive entry that origin/master has never seen as landed — the
//     direction that PRUNES A LIVE ENTRY.
//   • `git show <ref>:<path>` cannot tell "absent at that commit" from "could not read", so
//     an unreadable batch manifest read as "the batch landed" and its queue entry was pruned.
//   • Separate reads with no shared sha can mix one commit's queue with another commit's
//     archive when a land happens in between (a torn view).
//
// The fix is one COMMIT, pinned once per verdict, addressed by SHA (never by ref name) for
// every subsequent read. A `source` is that snapshot reified: it answers both prune axes and
// the board read at the same commit, in TRI-STATE — present / absent / fault — because
// absent-at-a-resolvable-sha is DATA while a read fault is a REFUSAL, and collapsing them is
// exactly the defect above. `git ls-tree` is the primitive that separates them: exit 0 with
// empty stdout for an absent path (at any depth, including a missing intermediate directory),
// non-zero when the tree walk itself faults.
//
// When `origin/master` cannot be resolved at all — an offline clone, a repo with no origin,
// a fresh test fixture — the source degrades to the WORKING TREE and carries `sha: null`.
// That null is load-bearing: a fallback to the working tree must DROP the sha, or a caller
// reads "pinned" from a snapshot that is nothing of the kind. See readFresh, which nulls it
// on every fallback path.
// `present` means a BLOB at exactly that path — not merely "ls-tree printed something".
// `ls-tree -- <rel>` also reports a TREE or a gitlink sitting at that name, and every path
// this seam probes (an archive entry, a claim manifest, the board, the queue doc) is a file.
// A wrong-TYPE entry gets its own state, because the two questions this seam asks want
// opposite answers for it (review round 1's archive finding, generalized):
//   • "does this FILE exist?" (the archive axis) — a directory called `<slug>.md` is not a
//     landed plan, so `notfile` reads as ABSENT and the queue entry is kept. Safe.
//   • "give me this file's CONTENT" (the board, the manifest, the queue doc) — a directory
//     there means the content cannot be read, so `notfile` is a FAULT. Degrading it to absent
//     would hand back an empty board, vacuously clearing the one refusal that protects an
//     actively-landing head.
// The pre-3459 existsSync collapsed both onto "true".
function probePathAtSha(dir, sha, rel) {
  let out;
  try {
    out = git(dir, ['ls-tree', '-z', sha, '--', rel]);
  } catch (error) {
    return { state: 'fault', error };
  }
  // `<mode> SP <type> SP <sha> TAB <name>` per NUL-terminated record.
  const record = out.split('\0')[0] ?? '';
  if (!record.trim()) return { state: 'absent' };
  const type = (/^\S+\s+(\S+)\s/.exec(record) || [])[1];
  return type === 'blob' ? { state: 'present' } : { state: 'notfile', type };
}

// The "does this FILE exist?" reading of a probe: a wrong-type entry is not the file we asked
// about, so it answers ABSENT (keep the queue entry) rather than fault.
const existenceOf = (probe) => (probe.state === 'notfile' ? { state: 'absent' } : probe);

// The pinned commit for this verdict, or null when origin/master does not resolve.
// `^{commit}` so a sha is what comes back even if the ref were ever peeled oddly.
function resolveOriginSha(dir) {
  try {
    return git(dir, ['rev-parse', '--verify', '--quiet', 'origin/master^{commit}']).trim() || null;
  } catch {
    return null;
  }
}

// Read a path's CONTENT at the pinned sha, tri-state. `ls-tree` first (it is the only read
// that can say "absent" without lying), `git show` only once the path is known present — so a
// show that then fails is unambiguously a fault, never an absence.
function readAtShaTri(dir, sha, rel) {
  const probe = probePathAtSha(dir, sha, rel);
  if (probe.state === 'notfile') {
    // A content read cannot succeed on a tree/gitlink — that is a fault, never an absence.
    return { state: 'fault', error: new Error(`${rel} is a ${probe.type} at ${sha}, not a file`) };
  }
  if (probe.state !== 'present') return probe;
  try {
    return { state: 'present', raw: git(dir, ['show', `${sha}:${rel}`]) };
  } catch (error) {
    return { state: 'fault', error };
  }
}

// Where the coord paths (board file, queue file) come from is itself part of the snapshot:
// resolving them from the checkout's MUTABLE coord.config.json would probe a path the pinned
// commit may not use, read "absent", and — for the board — vacuously clear the one refusal
// protecting an actively-landing head (review round 1, three angles). `loadCoordConfigAtOrigin`
// reads the config AT the sha, falling back to the local one when the file is absent there.
// Probed with ls-tree first, and NOT read straight through `loadCoordConfigAtOrigin`: that
// helper reaches its fallback via a failed `git show`, whose `fatal: path … does not exist`
// git prints to stderr — on every verdict, in any repo that legitimately has no
// coord.config.json. ls-tree is silent about an absent path, which is the whole reason this
// seam probes with it.
//
// Tri-state, like everything else here (review round 2, nine findings): ABSENT at the pinned
// commit is data — a repo with no coord.config.json — and falls back to the local defaults.
// A config that could not be READ is not, and must not quietly hand back whatever paths THIS
// checkout's file names: the seam would then probe a path the pinned commit does not use,
// read "absent", and vacuously clear the one refusal protecting an actively-landing head.
// That is the round-1 collapse again, one level further out. Returns `{ paths }` or
// `{ fault }`; memoized per source, so a source costs one probe, not one per method call.
function coordPathsAt(dir, sha) {
  const probe = probePathAtSha(dir, sha, 'coord.config.json');
  if (probe.state === 'absent') {
    // The LOCAL read throws on an unreadable/malformed config (coord-config.mjs's own
    // behaviour). Inside a source that promises tri-state answers, that would escape as a raw
    // exception past every fault channel here — so it becomes a fault like any other read
    // failure (review round 3, two angles).
    try {
      return { paths: loadCoordConfig(dir).paths };
    } catch (error) {
      return { fault: error };
    }
  }
  if (probe.state !== 'present') {
    return {
      fault: probe.error ?? new Error(`coord.config.json is a ${probe.type} at ${sha}, not a file`),
    };
  }
  try {
    return { paths: loadCoordConfigAtOrigin(dir, sha).paths };
  } catch (error) {
    return { fault: error }; // unreadable or malformed AT the pinned commit
  }
}

function originSnapshotSource(dir, sha) {
  let paths = null; // memoized: one config probe per source, not one per method call
  const relOr = (key, then) => {
    paths ??= coordPathsAt(dir, sha);
    return paths.fault ? { state: 'fault', error: paths.fault } : then(paths.paths[key]);
  };
  return {
    sha,
    landed: (slug) => existenceOf(probePathAtSha(dir, sha, archiveRelFor(slug))),
    // New-path-first / legacy-second, through batch-paths' ONE candidate loop (plan 1523's
    // rule: never re-roll it in a consumer). Tri-state, so a fault at the new path
    // short-circuits instead of being mistaken for "try legacy, also absent, batch landed".
    manifest: (slug) => resolveManifestAtRefTri(slug, (rel) => readAtShaTri(dir, sha, rel)),
    // A board file that is simply ABSENT at a resolvable commit is a repo with no board yet,
    // which genuinely holds no 🟢 LANDING rows — data, not a fault (the same distinction
    // originMasterUnresolvable draws for the operator-override path).
    board: () =>
      relOr('boardFile', (rel) => {
        const r = readAtShaTri(dir, sha, rel);
        return r.state === 'absent' ? { state: 'present', raw: '' } : r;
      }),
    // plan 3973: the queue doc is NOT a member of this snapshot any more — it lives on its own
    // ref, read through landing-queue-ref.mjs's accessor (readFresh below), and the verdict's
    // pin is the PAIR (master sha for the ground truth, queue-ref sha for the doc).
  };
}

// The offline / no-origin degradation: the same three questions, answered from the working
// tree, with `sha: null` so no caller can mistake this for a pinned view. It is still
// internally COHERENT — doc, archive, manifest and board all come from that one tree — which
// is the torn-read property; it simply is not authoritative cross-PC.
//
// It is a DEGRADED source, not a fault-free one (review round 1, eleven findings across five
// angles). `existsSync`/`catch {}` can only ever answer present-or-absent, so wiring them
// straight into a tri-state contract re-creates the very collapse this plan closes — one level
// down, where nothing would ever notice. Every read below therefore distinguishes ENOENT (the
// path is genuinely not there — DATA) from any other errno (a fault), and requires a regular
// FILE, so a directory shaped like an archive entry is not mistaken for a landed plan.
function workingTreeSource(dir) {
  // "Does this FILE exist?" — present iff a regular file; a directory of that name is not the
  // file we asked about, so it is ABSENT (mirrors existenceOf on the pinned side).
  const statFile = (abs) => {
    try {
      return statSync(abs).isFile() ? { state: 'present' } : { state: 'absent' };
    } catch (error) {
      return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
        ? { state: 'absent' }
        : { state: 'fault', error };
    }
  };
  // "Give me this file's CONTENT" — ONLY a genuinely missing path (ENOENT) is absent.
  // Everything else is a fault: EISDIR (a directory of that name), and ENOTDIR too, which
  // means a PARENT component is not a directory — something wrong-type is sitting in the
  // path, which is not the same statement as "this file was never written" (review round 2,
  // seven findings). An unreadable board must never degrade into an empty one.
  const readFile = (abs) => {
    try {
      return { state: 'present', raw: readFileSync(abs, 'utf8') };
    } catch (error) {
      return error?.code === 'ENOENT' ? { state: 'absent' } : { state: 'fault', error };
    }
  };
  return {
    sha: null,
    landed: (slug) => statFile(join(dir, archiveRelFor(slug))),
    // The SAME candidate loop as the pinned source (batch-paths owns it) — resolveManifestRel's
    // own existsSync probe cannot report a fault, so this drives the tri-state resolver directly.
    manifest: (slug) => resolveManifestAtRefTri(slug, (rel) => readFile(join(dir, rel))),
    board: () =>
      localRel('boardFile', (rel) => {
        const r = readFile(join(dir, rel));
        return r.state === 'absent' ? { state: 'present', raw: '' } : r; // no board ⇒ no rows
      }),
  };
  // Resolving the local config can THROW (an unreadable/malformed coord.config.json). Inside a
  // source that promises tri-state answers that would escape past every fault channel, so it
  // becomes a fault like any other read failure — the same treatment coordPathsAt gives the
  // pinned side (review round 3).
  function localRel(key, then) {
    let rel;
    try {
      rel = loadCoordConfig(dir).paths[key];
    } catch (error) {
      return { state: 'fault', error };
    }
    return then(rel);
  }
}

// Exported for the name-paired suite (plan 3459): the pinning property — that a verdict's
// answer is a function of the SHA alone, not of the working tree or of "now" — is only
// assertable by building two sources at two known commits over one unchanged checkout.
export const groundTruthSource = (dir, sha) =>
  sha ? originSnapshotSource(dir, sha) : workingTreeSource(dir);

// The refusal text every verb prints when a prune axis could not be judged. Names the axis,
// the snapshot it was read at, and the direction the refusal protects — so the operator can
// tell this apart from an ordinary "the head is fresh" verdict refusal.
function snapshotFaultReason(verb, fault, source) {
  const at = source.sha ? `pinned origin/master ${source.sha.slice(0, 10)}` : 'the working tree';
  const detail = String(fault.error?.message ?? fault.error ?? 'unknown error').trim();
  return (
    `${verb} cannot judge which queue entries have landed — ${fault.what} could not be read ` +
    `at ${at}: ${detail}. Refusing rather than treating an unreadable path as an absent one, ` +
    `which would prune a LIVE entry and change who is judged head.`
  );
}

// plan 1364 Ship 3 / review R1 (F1): the source's BATCH axis (`source.manifest`), feeding
// pruneLandedBatches — a batch-slugged entry (see claim-plan.mjs batch) never has an
// archive/<slug>.md file (its MEMBERS archive individually), so the archive axis alone can
// never reap it; that left every landed batch queue entry a permanent phantom head
// (CONFIRMED review finding). Ground truth mirrors done-worktree.mjs closeOutBatch: the
// manifest docs/handoff/batches/<slug>.json is deleted in the SAME commit that archives
// every member, so "manifest gone" ⇔ "batch landed".
//
// plan 1364 review R2 (R2-1): isBatchSlug now imported from claim-plan-lib.mjs — the
// single owner of the "batch-" prefix convention (was a locally hand-rolled copy here).
// plan 1467: the manifest MOVED to docs/superpowers/batches/<slug>/manifest.json (was
// docs/handoff/batches/<slug>.json). Both source shapes resolve BOTH paths new-first/
// legacy-second (through batch-paths' one candidate loop), so an in-flight batch
// grandfathered at the old path still reads as live; "landed" ⇔ manifest gone from BOTH.
// Compose both ground-truth prunes: single-plan entries via pruneLanded (archive/ file),
// batch entries via pruneLandedBatches (manifest absence) — each predicate only ever fires
// for its own slug shape, so composing them is safe regardless of order.
//
// plan 1364 review R2 (R2-4): a batch-slugged entry NEVER has an archive/<slug>.md file
// (isBatchSlug is structurally exclusive with the archive-file shape), so paying for the
// probe on every batch entry inside pruneLanded is pure waste — short-circuit it via
// `!isBatchSlug(s) && …` and let pruneLandedBatches be the only ground-truth check batch
// entries ever pay for.
//
// plan 3459: THE one prune core, now parameterized by its ground-truth `source` (above)
// rather than by a directory — that parameterization is the entire seam, and there is
// deliberately still exactly ONE copy of the policy for all five call sites.
//
// Returns `{ entries, fault }` instead of throwing, because the five callers need three
// DIFFERENT policies over the same read and a throw would force one on all of them:
//   • the displacement verbs REFUSE on a fault (exit 2, and `unjudgeable` on the two verbs
//     that own a report channel) — a fault must never surface as a clean "nothing to do";
//   • `status` is a read-only reporter and degrades to "did not prune";
//   • `mutateQueue`'s in-mutate self-heal degrades too — skipping one round of a self-heal
//     is harmless and heals on the next write, whereas making `dequeue` fail on a faulting
//     object store would break its documented always-safe/idempotent guarantee for nothing.
// On a fault the returned `entries` are the ORIGINAL, fully UNPRUNED list, so the safe
// direction ("never drop an entry we could not prove landed") holds structurally at every
// call site regardless of which policy it applies. Both per-axis predicates independently
// fail in that same direction, so a caller that ignores `fault` is still never wrong-way-up.
export function pruneAllLanded(source, entries) {
  let fault = null;
  const noteFault = (what, error) => {
    fault ??= { what, error };
  };
  const singles = pruneLanded(entries, (s) => {
    if (isBatchSlug(s)) return false;
    const p = source.landed(s);
    if (p.state === 'fault') {
      noteFault(`the archive entry ${archiveRelFor(s)}`, p.error);
      return false; // unproven ⇒ keep the entry
    }
    return p.state === 'present';
  });
  const live = pruneLandedBatches(singles, isBatchSlug, (s) => {
    const m = source.manifest(s);
    if (m.fault) {
      noteFault(`batch ${s}'s claim manifest (${m.fault.rel})`, m.fault.error);
      return true; // unproven ⇒ report "manifest still there" ⇒ keep the entry
    }
    return m.rel !== null;
  });
  return fault ? { entries, fault } : { entries: live, fault: null };
}

// Boolean-aware arg parser — since plan 1777 a spec'd wrapper over parseFlags's shared
// subcommand mode (semantics live in parse-flags.mjs's header): unknown flags throw
// loudly, and `--json status <slug>` resolves cmd='status' instead of '--json'.
export function parseQueueArgs(argv) {
  return parseFlags(argv, {
    label: 'landing-queue',
    subcommand: true,
    value: [
      'lane',
      'session',
      'host',
      'note',
      'stale-min',
      // plan 2485: demote's convergence-axis bound (see DEFAULT_CONVERGE_STALE_MIN).
      'converge-min',
      // plan 3000: demote's operator-authority override; its VALUE is the mandatory reason.
      'operator-override',
      'grace-min',
      // plan 2517: `--enqueued-iso` (the plan-2170 reenter position ticket) is GONE —
      // dropped from the recognized-flag vocabulary too, so a stale caller still passing
      // it gets a loud "unknown flag" refusal instead of a silently-ignored no-op.
      'pid',
      'state',
    ],
    // plan 2485: `progress` marks a heartbeat as a land-PROGRESS stamp (spine-only).
    // plan 3973: `no-tombstone` is migrate's pre-land seeding form (fold only, master untouched).
    boolean: ['json', 'confirm-holder-gone', 'priority', 'progress', 'no-tombstone'],
  });
}

// Lane normalization: the spine passes its detectLane() result (seed|free);
// the doc stores the plan-banner emoji.
export function laneEmoji(lane) {
  if (lane === 'seed' || lane === '🟥') return '🟥';
  if (lane === 'free' || lane === '🟩') return '🟩';
  throw new Error(`landing-queue: --lane must be seed|free (got "${lane}")`);
}

// Test hook (mirrors DW_FAKE_*): freeze the clock for deterministic staleness tests.
const nowIso = () => process.env.LQ_FAKE_NOW || new Date().toISOString();

// plan 2266: the OS liveness probe for the mechanical steal — deliberately the ONLY
// side-effecting piece of the mechanical-holder-gone check (mechanicalHolderGoneVerdict
// in landing-queue-lib.mjs stays pure and takes this as a plain boolean, per that file's
// "no fs, no child_process" contract). `process.kill(pid, 0)` sends no signal — it only
// asks the OS whether the pid exists and is signalable, preferred over shelling to
// `tasklist` (this codebase's landing-lock.mjs header notes tasklist's empty-result flake
// on at least one host). ESRCH is the unambiguous "no such process" — anything else
// (EPERM: exists, owned by another user; or any other unexpected error) fails SAFE as
// "still running", since a pid this prober cannot disprove must never be mechanically
// declared gone.
//
// review note: heal-main.mjs has its OWN `pidAlive` probe, deliberately NOT reused here —
// the two need OPPOSITE fail-safe directions for their opposite risk profiles. heal-main's
// reclaims an ABANDONED lock (an uncertain read should lean toward reclaiming, so it
// returns true ONLY on the specific EPERM case and treats anything else, including an
// unexpected error code, as dead); this probe instead GATES an irreversible steal of a
// possibly-LIVE coordination head (an uncertain read must lean toward "still running", so
// it returns true on anything but the unambiguous ESRCH). Sharing one implementation would
// force one of the two call sites onto the wrong policy for its own risk profile.
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== 'ESRCH';
  }
}

// plan 2656 (round-3 review): the head-pid liveness probe, ONE definition. cmdSteal runs
// it twice — once in its pre-check and once re-proved inside the mutate — and the
// convention it encodes is load-bearing in a non-obvious direction: an unparseable, zero,
// or absent pid reports as RUNNING, so mechanicalHolderGoneVerdict falls through to the
// manual --confirm-holder-gone path instead of mechanically authorizing a steal off a pid
// it never actually probed. Two copy-pasted expressions of that rule is one edit away from
// the fallback flipping in only one of them.
function probeHeadPid(head) {
  const pid = Number(head?.pid);
  return { pidRunning: Number.isFinite(pid) && pid > 0 ? isPidAlive(pid) : true };
}

// plan 2266: collapse a best-effort cleanup step (must never fail the caller, only log
// non-fatally) to one line per call site — the mechanical reap's two tenure-release steps
// (landing-lock, board row) shared this exact try/catch-and-log shape verbatim.
function bestEffort(label, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`landing-queue: mechanical reap — ${label} failed (non-fatal): ${e.message}`);
  }
}

// The authoritative cross-PC read (plan 3973): fetch origin/master (the prune's ground truth:
// archive entries, batch manifests, the board), then the queue doc through the ref accessor
// (`readQueueDoc`, which fetches the ref by explicit refspec), then the heartbeat refs.
//
// THREE independent fetches, in this order, each with its own failure meaning — the plan-2656
// split, extended by one:
//   1. fetch origin/master        -> the ground-truth pin (`originSha`). A failure here still
//      REFUSES the destructive verbs (`docFetched`): a stale archive view could keep a landed
//      orphan at the head, or prune a live entry a fresher master would have kept.
//   2. fetch + show the queue ref -> `doc` / `queueSha` / `docSource` / `docFault`. The
//      accessor's tri-state (plan 3973 D3): a ref proven ABSENT on origin is data (the doc
//      degrades to origin/master's pre-cut-over table when there is one, else an empty queue),
//      a failed fetch is `docFetched: false` with the CACHED tracking ref as the doc (a reporter
//      still shows the last-known queue; a displacing verb refuses), and an unreadable ref — or
//      the D4 loud-fail, a NON-tombstone master doc beside a live ref — is `docFault`.
//   3. fetch + read the heartbeat refs -> `hb`, narrowed by its own failures alone.
//
// COST, stated honestly: three origin round trips per call (it was two). The reason they stay
// separate is unchanged from plan 2656: one combined fetch under one try/catch let a single
// corrupt heartbeat ref poison the doc read, and a shared `alreadyFetched` flag is a footgun
// pointed at the one direction this module must never fail in (a stale ping reads as a dead
// head). The queue-ref fetch is the ONE round trip plan 3973 adds; the coord LOCK hold every
// write used to pay (~8.6 s under contention) is gone.
//
// `docFetched` is the AND of fetches 1 and 2: `docReadRefusal` names whichever failed. The
// `originSha` pin is kept even when the doc came from elsewhere — the doc and the ground truth
// are on different refs now, so "same tree" is no longer a property to preserve; what the
// verdict pins is the pair (originSha, queueSha), and both are reported.
function readFresh(mainDir) {
  let masterFetched = true;
  try {
    gitWithLockRetry(mainDir, ['fetch', '--quiet', 'origin', 'master']);
  } catch {
    /* offline, or origin unreachable — the pinned read below still uses the last-known ref */
    masterFetched = false;
  }
  const originSha = resolveOriginSha(mainDir);
  const q = readQueueDoc(mainDir, { fetch: true });
  const hb = readHeartbeatRefs(mainDir);
  return {
    doc: q.doc ?? initialQueueDoc(),
    docFetched: masterFetched && q.fetched,
    masterFetched,
    queueFetched: q.fetched,
    docFault: q.fault,
    docSource: q.source,
    hb,
    originSha,
    queueSha: q.sha,
  };
}

// The doc twin of snapshotFaultReason: the queue doc itself could not be read at a commit that
// resolves. Same rule, same direction — refuse rather than judge a queue this run never saw.
function docFaultRefusal(docFault, verb) {
  if (!docFault) return null;
  return (
    `${verb} cannot judge the queue — the queue doc could not be trusted from the queue ref ` +
    `${QUEUE_REF} (${String(docFault.message ?? docFault).trim()}). Refusing rather than ` +
    `displacing a head on a list that did not come from origin.`
  );
}

// The fail-closed gate, shared by the three staleness-keyed verbs (steal/demote/reap).
// Each of them decides to DISPLACE a head purely on heartbeat age, so an unreadable
// heartbeat namespace must produce a refusal, never a judgement — a doc-only view now
// makes every ref-pinged (i.e. every live) head look stale.
function heartbeatReadRefusal(hb, verb) {
  if (hb.ok) return null;
  return (
    `${verb} cannot judge head liveness — the heartbeat refs (${HEARTBEAT_REF_PREFIX}*) could ` +
    `not be read: ${hb.error}. Refusing rather than treating an unreadable ping as a missing ` +
    `one. Fix connectivity to origin and retry.`
  );
}

// The two shapes above, packaged once each — steal/demote/reap were carrying six
// copy-pasted variants of "read, refuse if unreadable, otherwise decorate", and the copies
// had already drifted in control-flow style (throw vs. set-outcome). The fail-closed
// contract is supposed to be IDENTICAL across the three verbs, so it lives in exactly two
// functions and each verb states only its own abort mechanism.

// The doc half of the same fail-closed contract (plan 2656 self-review). Before the
// readFresh split, a failed origin/master fetch forced hb.ok=false and therefore a
// refusal, because both rode ONE combined fetch. Splitting them made the heartbeat half
// able to succeed on its own, so without this the three destructive verbs would compute a
// verdict against whatever stale queue snapshot was on hand and never refuse. The doc is
// the list of WHO is in the queue and in what order; judging a displacement off a stale
// one can act on an entry another session already dequeued.
function docReadRefusal(docFetched, verb) {
  if (docFetched) return null;
  return (
    `${verb} cannot judge the queue — origin/master could not be fetched (or the queue ref ` +
    `${QUEUE_REF} could not), so the queue doc may be arbitrarily stale and entries another ` +
    `session has already changed would be invisible. Refusing rather than displacing a head ` +
    `on an out-of-date list. Fix connectivity to origin and retry.`
  );
}

// plan 3000: the two halves of the fail-closed read contract are NOT symmetric under an
// operator override, and the asymmetry is the point.
//   - The DOC refusal always stands, override or not. It answers "who is queued, in what
//     order" — the structural facts the override still relies on (is the caller behind the
//     head? which entry IS the head?). Overriding on a stale list could act on an entry
//     another session already dequeued, which is corruption, not authority.
//   - The HEARTBEAT refusal is skipped under an override. It exists solely because an
//     unreadable ping makes every live head read as stale, i.e. it is a guard on the
//     STALENESS axes — the very axes the override sets aside. Left in, it would be one more
//     unreachable-by-construction refusal standing between the operator and a queue reorder,
//     which is exactly the defect plan 3000 closes. `readHeartbeatRefs` returns `map: {}` on
//     failure, so the only consequence is that the reported heartbeat age falls back to the
//     doc's own cell — a reporting degradation in the warning text, not a decision input.
function heartbeatRefusalFor(hb, verb, operatorOverride) {
  return operatorOverride ? null : heartbeatReadRefusal(hb, verb);
}

// Pre-verdict, outside any mutate: the doc and the refs, each freshened independently.
// Returns { refusal } on an unreadable namespace, else { entries, auditLines, source }.
//
// plan 3459: `source` is the pinned snapshot the doc itself came from — every ground-truth
// read this verdict goes on to make (the prune's two axes, the 🟢 LANDING board read, a batch's
// member manifest) is addressed at that one commit, so no later read can see a different world
// than the queue it is judging. `livePrune` is the one way to consume it: it applies the shared
// prune core and turns a read fault into this verb's refusal instead of a silent no-op.
function readVerdictBase(MAIN, verb, { operatorOverride = false } = {}) {
  const { doc, docFetched, docFault, hb, originSha } = readFresh(MAIN);
  const refusal =
    docReadRefusal(docFetched, verb) ??
    docFaultRefusal(docFault, verb) ??
    heartbeatRefusalFor(hb, verb, operatorOverride);
  if (refusal) return { refusal };
  const parsed = parseQueue(doc);
  return {
    entries: decorateWithHeartbeatRefs(parsed.entries, hb.map),
    auditLines: parsed.auditLines,
    source: groundTruthSource(MAIN, originSha),
  };
}

// The pre-verdict prune, for the verbs that DISPLACE. Returns `{ entries }` on success or
// `{ refusal }` when an axis could not be judged — never a pruned-but-unproven list, and
// never a quiet "nothing to do", which is what a fault used to degrade into.
function livePrune(verb, base) {
  const { entries, fault } = pruneAllLanded(base.source, base.entries);
  if (fault) return { refusal: snapshotFaultReason(verb, fault, base.source) };
  return { entries };
}

// Inside a mutate transform: the refs are re-read RATHER than reused from the
// pre-verdict, because catching a mid-command ping is the re-verdict's entire job and a
// ping now lands in the heartbeat namespace, which the queue-doc freshen does not see.
// Verdict-only — every caller applies its mutation to the UNDECORATED entries, so a
// ref-derived timestamp is never written back into the doc.
function decorateForReverdict(MAIN, verb, entries, { operatorOverride = false } = {}) {
  const hb = readHeartbeatRefs(MAIN);
  const refusal = heartbeatRefusalFor(hb, verb, operatorOverride);
  if (refusal) return { refusal };
  return { entries: decorateWithHeartbeatRefs(entries, hb.map) };
}

// plan 2656 (review finding on 2603): cmdSteal/cmdDemote/cmdReap each print+return the
// same 4-line "if (X.refusal) { console.error(...); return 2; }" block right after their
// own readVerdictBase call. The block can't move fully into readVerdictBase (each caller
// needs its OWN early `return`), so this collapses it to one line per call site instead.
// plan 2656 (self-review): ONE definition of the head-changed race guard. Both cmdSteal
// and cmdOvertake establish a proof about a SPECIFIC head in their pre-check (steal: that
// head's holder is mechanically gone; overtake: this branch's paths are disjoint from that
// head's) and then commit inside a mutateQueue transform which RE-RUNS against a freshened
// base on every non-fast-forward retry. If the head changed in between — the old one
// landed and was pruned, resumed, or was itself displaced — the proof describes a head
// that no longer holds the slot, and applying it would act on a head nothing was ever
// proven about. Abort; a fresh invocation re-proves against whoever holds the slot now.
// `proof` is the phrase naming what was established, and completes the sentence
// "<proof> was established against the old head".
function assertHeadUnchanged({ verb, preHead, reHead, proof }) {
  if (reHead.slug === preHead.slug) return;
  throw Object.assign(
    new Error(
      `${verb} aborted: head changed mid-${verb} (${preHead.slug} → ${reHead.slug}) — ` +
        `${proof} was established against the old head; re-run to re-prove against the new one`,
    ),
    { refusal: true },
  );
}

function reportPreVerdictRefusal(refusal) {
  if (!refusal) return false;
  console.error(`REFUSED — ${refusal}`);
  return true;
}

// plan 1462: the AUTHORITATIVE cross-PC board read, for the batch-aware steal check.
// The 🟢 LANDING mutex is a cross-session marker (a sibling PC may hold it), so — like
// board.mjs's own landing-held gate — it must be read from origin/master, not the local
// working tree. The caller's readFresh has already fetched, so no re-fetch here.
//
// plan 3459: it now reads at the verdict's PINNED sha (`source.board()`), not at the ref
// name, so the 🟢 LANDING check and the queue it guards describe the same commit — a land
// completing between the two reads can no longer produce a torn view. A board file ABSENT at
// a resolvable commit is a repo with no board yet, i.e. genuinely no rows; only a read FAULT
// is a fault, and it is raised (never degraded to '' — an empty board vacuously clears the
// one refusal protecting an actively-landing head).
function readBoardFresh(source, verb) {
  const r = source.board();
  if (r.state === 'fault') {
    throw Object.assign(
      new Error(snapshotFaultReason(verb, { what: 'the board', error: r.error }, source)),
      { refusal: true, unjudgeable: true },
    );
  }
  return r.raw;
}

// plan 1462: a batch's member plan IDS, read from its claim manifest at the pinned snapshot
// (authoritative cross-PC, matching readBoardFresh). Resolution order lives in
// batch-paths.mjs's resolveManifestAtRefTri (plan 1523 — shared with the Gate-1 pre-push
// guard, never re-rolled here). Returns [] when no manifest resolves (the batch already
// landed — manifest deleted at close-out — or was never claimed) OR when the resolved
// manifest is unparseable/memberless, which makes the batch-liveness gate a no-op and
// lets the ordinary steal path reap the landed orphan.
//
// plan 3459: read at the verdict's PINNED sha, and TRI-STATE. This read is the worst of the
// two collapsed axes: `[]` members makes the batch-liveness gate a no-op, so an UNREADABLE
// manifest used to read as "the batch landed" and let a steal past the 🟢 LANDING guard of a
// batch that was actively mid-land — a FIFO double-land on the lane. Absent at the pinned
// commit is still data (the batch really did land, or was never claimed) and still returns
// `[]`; a read FAULT now throws instead, flagged `unjudgeable` so a sweep reports a run that
// proved nothing rather than a verdict. An unparseable-or-memberless manifest keeps its old
// degradation: the bytes WERE read, so that is a content judgment, not a read failure.
function readBatchManifestMembersFresh(source, slug, verb) {
  const found = source.manifest(slug);
  if (found.fault) {
    throw Object.assign(
      new Error(
        snapshotFaultReason(
          verb,
          { what: `batch ${slug}'s claim manifest (${found.fault.rel})`, error: found.fault.error },
          source,
        ),
      ),
      { refusal: true, unjudgeable: true },
    );
  }
  if (found.rel === null) return [];
  try {
    const obj = JSON.parse(found.raw);
    if (Array.isArray(obj.members) && obj.members.length) return obj.members.map(String);
  } catch {
    /* unparseable manifest — degrade to no members, same as never-claimed */
  }
  return [];
}

// plan 1682: the head's fresh 🟢 LANDING row(s), lane-shape-aware — a batch head
// resolves its member rows (the plan-1462 pattern), a single-plan head checks its own
// row (queue slug == board-row slug). Non-empty ⇒ the head is actively mid-land and
// must not be demoted, regardless of heartbeat age (the master push's pre-push battery
// can outlive the last spine heartbeat). Reads origin/master via readBoardFresh — call
// only after a fetch (readFresh / a coordWrite attempt) has freshened the ref.
function headLandingRows(source, headSlug, verb) {
  const board = readBoardFresh(source, verb);
  if (isBatchSlug(headSlug)) {
    return batchMemberLandingRows(board, readBatchManifestMembersFresh(source, headSlug, verb));
  }
  return slugHoldsLandingRow(board, headSlug) ? [headSlug] : [];
}

// plan 3450 review round 2 (G3): the IN-MUTATE half of the same read. Demote's and reap's 🟢
// LANDING re-verifications used to ask MAIN's mutable working tree, which can describe a
// different world than the one the transform is about to write. Reading through the pinned
// `source` (plan 3459; since plan 3973 the sha is origin/master's, re-freshened and re-pinned on
// every CAS attempt) puts the mutex check on the same snapshot as the verdict it guards.
//
// Fail-closed on the ONE case readBoardFresh cannot tell apart from "no rows": an origin/master
// that does not resolve at all, where the degraded '' board would vacuously clear the single
// refusal protecting an actively-landing head. `unjudgeable` so the sweep reports it as a run
// that proved nothing rather than as a verdict (the plan-3450 F2 channel).
//
// plan 3459: the unresolvable-origin test is now `source.sha === null` — the SAME question,
// asked of the snapshot that already resolved it, instead of a second independent rev-parse
// of the ref. (`originMasterUnresolvable` itself stays: cmdDemote's operator-override path
// still asks it directly, before any source exists.)
function headLandingRowsInMutate(verb, source, headSlug) {
  if (source.sha === null) {
    throw Object.assign(
      new Error(
        `${verb} aborted: origin/master does not resolve from the coord checkout, so the 🟢 ` +
          `LANDING board read would degrade to "no landing row" and the one refusal protecting ` +
          `an actively-landing head would pass vacuously. Fix connectivity to origin and retry.`,
      ),
      { refusal: true, unjudgeable: true },
    );
  }
  return headLandingRows(source, headSlug, verb);
}

// plan 3000: `readBoardFresh` degrades an unreadable board to '' — i.e. to "no 🟢 LANDING
// row" — which is a sane fail-open while the staleness axes still stand behind it. Under an
// operator override they do not: the LANDING row is the ONE refusal left, so the same
// degradation would silently hand the operator a merge-window head. `docReadRefusal` already
// covers the common cause (origin unfetchable) for every verb, so this only has to close the
// residual case: an origin/master that does not resolve AT ALL, where every `git show
// origin/master:…` throws and the board read has nothing authoritative to say. A board file
// that is simply ABSENT at a resolvable origin/master is NOT this case — that is a repo with
// no board yet, which genuinely holds no LANDING rows.
function originMasterUnresolvable(mainDir) {
  try {
    git(mainDir, ['rev-parse', '--verify', '--quiet', 'origin/master']);
    return null;
  } catch (e) {
    return (
      `an operator override cannot judge the 🟢 LANDING mutex — origin/master does not ` +
      `resolve (${e.message.trim()}), so the board read would degrade to "no landing row" ` +
      `and the override's one remaining refusal would pass vacuously. Fix connectivity to ` +
      `origin and retry.`
    );
  }
}

// plan 3450 review round 2 (G1): `sweep` reports how many landed orphans THE WHOLE SWEEP
// removed — but a sweep performs up to three mutates: step 1's explicit prune, plus the demote's
// and the reap's own (mutateQueue prunes before EVERY transform). Reading only the first call's
// count under-reports the sweep: an entry that lands between step 1 and the eviction ladder is
// removed by the NESTED mutate and reported as `pruned: 0`. This accumulator sums every mutate
// that actually returned inside the scope, so the number describes the sweep rather than its
// first call. Scoped rather than global: nothing outside `withPruneAccounting` pays for it, and
// a nested scope restores its parent on the way out.
let pruneAccumulator = null;
function withPruneAccounting(fn) {
  const prev = pruneAccumulator;
  const acc = { pruned: 0 };
  pruneAccumulator = acc;
  try {
    return { result: fn(), pruned: acc.pruned };
  } finally {
    pruneAccumulator = prev;
  }
}

// One queue mutation through the sanctioned write path (plan 3973: the CAS loop on the queue
// ref, `mutateQueueRef`, where this used to be a coordWrite of the master doc). `transform(
// entries, auditLines, mainDir, source)` returns {entries, auditLines} and is RE-RUN on every
// CAS attempt against the freshened doc — that re-run is what makes concurrent enqueues commute
// into FIFO push order. The third argument used to be the disposable coord-checkout the write
// landed in; no transform ever read it (every re-verdict reads through `source`), and there is
// no checkout in this path any more, so it is `mainDir` now. `source` (plan 3459) is the
// ground-truth snapshot PINNED to origin/master's sha — the archive/manifest/board reads the
// prune and every in-mutate re-verdict make; the queue doc itself comes from the ref. That pin
// is rebuilt INSIDE the per-attempt callback, so a retry judges the freshened queue against an
// equally fresh board (plan 3973 review; see the comment at the fetch below).
//
// No coord-write lock is taken: the CAS IS the mutex (plan 3973 D2). The audit line a transform
// appends gets ` · attempt=<n>` stamped on the COMMITTED run, and every ref commit carries a
// `Queue-Attempt: <n>` trailer, so T4 can count collisions from either surface.
function mutateQueue(mainDir, message, transform, { prune = true } = {}) {
  let result = null;
  // plan 3450 review F3: how many landed orphans the self-heal below actually removed, from
  // the COMMITTED run of the mutate (the same closure-capture rule demote/reap use for their
  // reported numbers — the transform re-runs on every CAS retry, and the last run is the one
  // whose write landed). `sweep` reports this as its `pruned` count; before, it reported the
  // SURVIVING entries and claimed a cleanup that never happened.
  let prunedCount = 0;
  const written = mutateQueueRef(mainDir, {
    message,
    mutate: (doc, { attempt }) => {
      // The ground truth (archive entries, batch manifests, the board) is read at origin/master,
      // and it is re-freshened and re-pinned ON EVERY CAS ATTEMPT — never once before the loop
      // (plan 3973 review, keys eabd36 / 5af627 / ef8569). A retry happens precisely when a
      // sibling wrote the queue first, which is exactly when the board may ALSO have gained the
      // 🟢 LANDING row that demote/reap/steal's in-mutate re-verdict exists to see: judging a
      // freshened queue doc against a stale board snapshot is how plan 3450 G3's race comes
      // back. The pin stays per-attempt-immutable, so within one transform run the prune and
      // every re-verdict still read ONE snapshot.
      try {
        gitWithLockRetry(mainDir, ['fetch', '--quiet', 'origin', 'master']);
      } catch {
        /* offline — the pinned read below uses the last-known origin/master, as readFresh does */
      }
      const source = groundTruthSource(mainDir, resolveOriginSha(mainDir));
      const { entries, auditLines } = parseQueue(doc);
      // Self-heal: drop any entry whose plan has already landed BEFORE the mutation runs (and
      // the result persists). This reaps a teardown-crash orphan (561) on the next queue op of
      // any session, and can never touch a live waiter (its plan is still in in-progress/).
      // `steal` opts OUT (prune:false): it has its own staleness verdict and must keep its
      // exact semantics — pruning before its inside-mutate re-verdict would make a stealer
      // whose only blocker was a reaped orphan throw "already head" and discard the write.
      // Orphans heal on the common enqueue/dequeue/heartbeat ops instead. (plan 574)
      //
      // A read fault here degrades to "did not prune", never to a refusal: this prune is a
      // SELF-HEAL, not the mutation, so skipping one round costs nothing (the next write heals
      // it) while refusing would break `dequeue`'s documented always-safe/idempotent guarantee
      // on a faulting object store. The displacement verbs do NOT rely on this — each refuses
      // at its own pre-verdict livePrune before ever reaching here.
      //
      // What makes the degrade SAFE rather than merely convenient, for the in-mutate
      // re-verdicts that do read these entries (review round 1 asked): not pruning can only
      // ever leave MORE entries visible, never fewer, so the head under a skipped prune is
      // either the true head or a landed orphan sitting in front of it. Demoting or reaping an
      // orphan is a no-op on a dead entry, and refusing because one is head is a refusal, not a
      // displacement. There is no path here that evicts a LIVE head it would otherwise have
      // protected — which is why this stays a degrade instead of growing a second policy knob
      // on the one function every verb writes through.
      const pruned = prune ? pruneAllLanded(source, entries) : { entries, fault: null };
      if (pruned.fault) {
        console.error(
          `landing-queue: self-heal prune skipped this write — ${pruned.fault.what} could not ` +
            `be read (${String(pruned.fault.error?.message ?? pruned.fault.error).trim()}); ` +
            `keeping every entry rather than dropping one that may be live`,
        );
      }
      const live = pruned.entries;
      prunedCount = entries.length - live.length;
      result = transform(live, auditLines, mainDir, source);
      // Stamp the attempt on the audit line THIS run appended (never on an older line), so a
      // steal/demote/reap/requeue/overtake line says how many CAS rounds it took to land.
      let audit = result.auditLines;
      if (audit.length > auditLines.length) {
        audit = [...audit];
        audit[audit.length - 1] = `${audit[audit.length - 1]} · attempt=${attempt}`;
      }
      return renderQueue(doc, result.entries, audit);
    },
  });
  // Only a mutate that RETURNED contributes to the enclosing sweep's prune total: a transform
  // that throws aborts the whole write, so its prune never reached the doc either.
  if (pruneAccumulator) pruneAccumulator.pruned += prunedCount;
  return result === null
    ? null
    : { ...result, prunedCount, queueSha: written.sha, attempts: written.attempts };
}

function printStatus(entries, slugArg, asJson) {
  const head = headOf(entries);
  if (slugArg) {
    // plan 2517: resolved once, shared by `lane` below and the new `heartbeatIso` field —
    // the queried slug's OWN entry (distinct from `headHeartbeatIso`, the HEAD's).
    const mine = entries.find((e) => e.slug === slugArg);
    const payload = {
      slug: slugArg,
      position: positionOf(entries, slugArg),
      total: entries.length,
      head: head ? head.slug : null,
      // plan 2517: the queried slug's OWN heartbeat — lets a flagless done-worktree
      // re-invoke notice (read-only, no spawn) that ITS OWN entry has gone stale between
      // invocations, since nothing refreshes it outside the (--wait/--wait-chunk) near-head
      // self-arm (plan 2085). null when not queued or a blank cell.
      heartbeatIso: mine ? (mine.heartbeatIso ?? null) : null,
      // plan 2280: expose the head's recorded {host, pid} (already on the parsed entry —
      // plan 2266) so a waiter can pre-check mechanicalHolderGoneVerdict's cross-host/pid-less
      // refusal LOCALLY, before spawning a `steal` subprocess (and its own git fetch) that
      // would only refuse for the same reason. null on a headless queue, a pre-2266 entry
      // (no pid column), or a blank pid cell — matches mechanicalHolderGoneVerdict's own
      // "no evidence" handling.
      headHost: head ? (head.host ?? null) : null,
      headPid: head ? (head.pid ?? null) : null,
      // plan 2275: the head's state cell ('HOLDING' | null) — lets a waiter pre-check
      // overtake eligibility locally before spawning the overtake subprocess (the same
      // spawn-avoidance idea as headHost/headPid for the mechanical steal, plan 2280).
      headState: head ? (head.state ?? null) : null,
      // plan 2334: the head's heartbeat stamp — the same spawn-avoidance idea for the two
      // STALENESS-keyed verbs (demote, reap), whose first gate is a heartbeat-age
      // comparison a waiter can now run locally (landing-queue-lib's
      // demoteLocallyEligible / reapLocallyEligible) instead of spawning the CLI and its
      // own `git fetch origin master` against a head it can already see is fresh. null on
      // a headless queue or a blank cell — both read as "not fresh" there, so the caller
      // falls back to spawning, matching every other field's fail-open handling.
      headHeartbeatIso: head ? (head.heartbeatIso ?? null) : null,
      // plan 2485: the head's land-PROGRESS stamp — the second half of demote's local
      // pre-check (demoteLocallyEligible). Without it a waiter facing an
      // alive-but-not-converging head would filter the demote out locally (its heartbeat
      // IS fresh) and never spawn the CLI that can now displace it. null on a headless
      // queue, a pre-2485 row, or a blank cell — all read as "axis abstains", so the
      // pre-check falls back to the heartbeat answer, matching every other field's
      // fail-open handling.
      headProgressIso: head ? (head.progressIso ?? null) : null,
      // plan 2275: the queried slug's OWN lane — the other half of that local pre-check
      // (a 🟥 waiter is never overtake-eligible, so it should never pay the spawn).
      lane: mine?.lane ?? null,
    };
    console.log(
      asJson
        ? JSON.stringify(payload)
        : payload.position
          ? `${slugArg}: position ${payload.position}/${payload.total} (head: ${payload.head})`
          : `${slugArg}: not queued (${payload.total} queued, head: ${payload.head ?? 'none'})`,
    );
    return;
  }
  if (asJson) {
    console.log(
      JSON.stringify({
        head: head ? head.slug : null,
        total: entries.length,
        entries: entries.map((e, i) => ({ ...e, position: i + 1 })),
      }),
    );
    return;
  }
  if (!entries.length) {
    console.log('landing queue: empty');
    return;
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    console.log(
      `${i + 1}. ${e.slug} ${e.lane}${e.priority ? ' ⚡' : ''} session=${e.session} host=${e.host} enqueued=${e.enqueuedIso} heartbeat=${e.heartbeatIso}` +
        (e.state ? ` state=${e.state}` : ''),
    );
  }
}

// Shared tail of every mutating command's report payload: where `slug` sits in
// the post-write queue. Spread into the command's own identity field so the
// --json shape can't drift between enqueue/requeue/demote (plan 2061 review).
function positionPayload(entries, slug) {
  return {
    position: positionOf(entries, slug),
    total: entries.length,
    head: headOf(entries)?.slug ?? null,
  };
}

// plan 3450 review F5: the same tail for a verb that may have been asked by the GHOST caller.
// The ghost is verdict-only — it is never in `entries` — so `positionOf` would resolve it
// through the absent-entry branch and report a confident `position: 0`, which read as a real
// queue position in the sweep's captured output ("(sweep) at position 0/2" beside a demote
// that in fact succeeded). A caller with no position reports `null`: the field keeps its shape
// for a JSON consumer, and no number in the payload derives from the ghost. `total`/`head`
// are computed from the real, ghost-free post-mutation entries either way.
function callerPositionPayload(entries, slug, ghost) {
  if (!ghost) return positionPayload(entries, slug);
  return { position: null, total: entries.length, head: headOf(entries)?.slug ?? null };
}

function cmdStatus({ MAIN, positionals, flags }) {
  // Show the EFFECTIVE queue: reap landed orphans from the view so a reader never
  // sees a phantom entry (best-effort working-tree check; the mutate path persists
  // the reap on the next write). (plan 574)
  // plan 2603: fold the heartbeat refs in before printing — printStatus's heartbeatIso /
  // headHeartbeatIso / headProgressIso cells are what done-worktree's LOCAL pre-checks
  // read to decide whether spawning demote/steal/reap is worth a subprocess, so an
  // un-decorated status would show every live head as un-pinged. A FAILED ref read is
  // deliberately NOT surfaced as an error here: status is a read-only reporter, and the
  // resulting (stale-looking) cells only ever make a pre-check spawn the real CLI, which
  // then applies the fail-closed refusal itself.
  //
  // plan 3459 (acceptance 4): status SHARES the pinned snapshot — its prune is answered at
  // the same commit its doc came from, so a reader and a displacing verb agree on who the
  // head is. What it does NOT share is the fault POLICY: a read fault degrades to "did not
  // prune" plus a one-line note, rather than the exit-2 refusal the displacement verbs take.
  // Deliberate, for the same reason the ref-read failure above is not surfaced as an error:
  // status is a read-only reporter whose cells only ever decide whether a waiter bothers to
  // SPAWN the real CLI, and an unpruned phantom makes it spawn one — which then applies the
  // fail-closed refusal properly. Refusing here would instead turn a reporter into a blocker.
  const { doc, hb, docFault, docSource, originSha } = readFresh(MAIN);
  if (docFault) {
    console.error(
      `landing-queue: the queue doc could not be trusted from ${QUEUE_REF} ` +
        `(${String(docFault.message ?? docFault).trim()}) — ` +
        (docSource === 'none'
          ? `nothing could be read, so the queue below is EMPTY because nothing could be read, ` +
            `NOT because nobody is queued`
          : `showing the ref's doc as read, unreconciled`),
    );
  } else if (docSource === 'ref-cached') {
    console.error(
      `landing-queue: ${QUEUE_REF} could not be fetched — showing the last-known copy on ` +
        `${QUEUE_REF_LOCAL}, which may be stale`,
    );
  }
  const { entries } = parseQueue(doc);
  const pruned = pruneAllLanded(groundTruthSource(MAIN, originSha), entries);
  if (pruned.fault) {
    console.error(
      `landing-queue: status could not judge landed-ness — ${pruned.fault.what} could not be ` +
        `read (${String(pruned.fault.error?.message ?? pruned.fault.error).trim()}); showing ` +
        `every entry unpruned`,
    );
  }
  const live = decorateWithHeartbeatRefs(pruned.entries, hb.map);
  printStatus(live, positionals[0], flags.json === true);
  return 0;
}

function cmdEnqueue({ MAIN, slug, flags }) {
  if (flags.lane == null) {
    // no silent default: a 🟥 seed plan enqueued bare would be mislabeled 🟩
    // and read as safe-to-parallelize by operators scanning the queue.
    console.error('landing-queue: enqueue requires --lane seed|free');
    return 5;
  }
  const lane = laneEmoji(flags.lane);
  // plan 2328: a --priority enqueue INSERTS at the front block (behind the head, FIFO
  // among priority entries — insertPriorityEntry) instead of appending; the persisted
  // ⚡ cell keeps the class visible to later inserts and to the overtake leapfrog guard.
  const priority = flags.priority === true;
  const entry = {
    slug,
    lane,
    session: flags.session ?? UNKNOWN_SESSION,
    host: flags.host ?? hostname(),
    enqueuedIso: nowIso(),
    heartbeatIso: nowIso(),
    priority,
  };
  const r = mutateQueue(
    MAIN,
    `coord(queue): enqueue ${slug} (${lane}${priority ? ' ⚡' : ''})`,
    (entries, audit) => ({
      entries: priority ? insertPriorityEntry(entries, entry) : enqueueEntry(entries, entry),
      auditLines: audit,
    }),
  );
  const payload = { slug, ...positionPayload(r.entries, slug) };
  console.log(
    flags.json === true
      ? JSON.stringify(payload)
      : `enqueued ${slug}${priority ? ' (⚡ priority)' : ''} at position ${payload.position}/${payload.total} (head: ${payload.head})`,
  );
  // plan 3450 Phase A: a fresh arrival is the queue's own evidence that someone alive is
  // waiting — so run the eviction verdicts right here, instead of leaving them to a watcher
  // poll that may be minutes away or (the 2026-08-25 incident) may never come at all.
  // Deliberately AFTER the caller's own report line: the enqueue is committed either way.
  // `r.entries` is the queue this enqueue just committed — the head's own cells are already in
  // hand, so a healthy head costs no round trip at all (see maybeSweepAfterMutate).
  maybeSweepAfterMutate(MAIN, flags, 'enqueue', r.entries);
  return 0;
}

function cmdDequeue({ MAIN, slug }) {
  mutateQueue(MAIN, `coord(queue): dequeue ${slug}`, (entries, audit) => ({
    entries: dequeueEntry(entries, slug),
    auditLines: audit,
  }));
  // plan 2603: retire this slug's heartbeat ref with its entry. Purely hygiene for the
  // shared namespace — correctness does not depend on it, because the read-side fold
  // ignores any stamp at or before a (re-)enqueue — and it is best-effort by design:
  // dequeue is documented as idempotent and always-exit-0, so a failed ref delete must
  // never turn a successful dequeue into an error.
  deleteHeartbeatRef(MAIN, slug);
  console.log(`dequeued ${slug}`);
  return 0;
}

// plan 1528 Phase B: release the head slot to the TAIL in ONE coordWrite commit —
// done-worktree's requeue-to-tail on heavy head rework (LAND_BLOCKED_REQUEUED). The
// dequeue+enqueue pair rides one transform (requeueEntry), so a crash/race can never
// leave the slug dequeued-but-not-enqueued; lane/session/host carry over from the
// existing entry (--lane etc. only seed the fallback when the entry was stolen/reaped
// mid-flight). --note lands in the audit region (the same trail steals write).
function cmdRequeue({ MAIN, slug, flags }) {
  if (flags.lane == null) {
    console.error('landing-queue: requeue requires --lane seed|free (fallback re-insert lane)');
    return 5;
  }
  const fallback = {
    slug,
    lane: laneEmoji(flags.lane),
    session: flags.session ?? UNKNOWN_SESSION,
    host: flags.host ?? hostname(),
  };
  const r = mutateQueue(MAIN, `coord(queue): requeue ${slug} to tail`, (entries, audit) => {
    const rq = requeueEntry(entries, slug, nowIso(), fallback);
    return {
      entries: rq.entries,
      auditLines: [...audit, requeueAuditLine(nowIso(), slug, flags.note)],
    };
  });
  const payload = { slug, ...positionPayload(r.entries, slug) };
  console.log(
    flags.json === true
      ? JSON.stringify(payload)
      : `requeued ${slug} to position ${payload.position}/${payload.total} (head: ${payload.head})`,
  );
  // plan 1682: requeue keeps a slot a not-ready session may drain back to head on —
  // the exact 1674 hog (requeue into an empty queue = still head). Say so at the
  // point of use, not only in the runbook.
  console.error(
    'note: requeue keeps a queue slot (now at the tail). For OPEN-ENDED rework — triage, ' +
      'a re-review — prefer `dequeue` and re-enqueue when actually ready: an entry that ' +
      'drains back to head while its session is not landing gets auto-demoted by waiters ' +
      '(plan 1682; runbook § Queue slot = readiness).',
  );
  return 0;
}

// plan 2517 (supersedes plan 2170 Ship 2's position-preserving re-entry): a rework
// re-entry is now a PLAIN TAIL enqueue — the operator ruling reversed the old
// preserved-position semantics ("a plan carries no priority... it re-enters at the
// TAIL"). There is no `--enqueued-iso` any more: no position is being restored, so
// there is nothing to pin. `reenterEntry` is behaviorally identical to `enqueueEntry`'s
// idempotent tail append; this verb survives only so the audit trail can name a
// rework re-entry distinctly from a first-time enqueue (`reenterAuditLine`'s tail
// wording).
function cmdReenter({ MAIN, slug, flags }) {
  if (flags.lane == null) {
    console.error('landing-queue: reenter requires --lane seed|free');
    return 5;
  }
  const entry = {
    slug,
    lane: laneEmoji(flags.lane),
    session: flags.session ?? UNKNOWN_SESSION,
    host: flags.host ?? hostname(),
    enqueuedIso: nowIso(),
    heartbeatIso: nowIso(),
    priority: flags.priority === true,
  };
  const r = mutateQueue(
    MAIN,
    `coord(queue): reenter ${slug} (${entry.lane})`,
    (entries, audit) => ({
      entries: reenterEntry(entries, entry),
      auditLines: [...audit, reenterAuditLine(nowIso(), slug)],
    }),
  );
  const payload = { slug, ...positionPayload(r.entries, slug) };
  console.log(
    flags.json === true
      ? JSON.stringify(payload)
      : `re-entered ${slug} at position ${payload.position}/${payload.total} (head: ${payload.head})`,
  );
  return 0;
}

function cmdHeartbeat({ MAIN, slug, flags }) {
  // plan 2266 item 1: an optional --pid rides this same call — markHeadAcquired
  // (done-worktree.mjs) passes it at head-acquisition so the QUEUE ENTRY itself carries
  // this residency's process identity (not just the local land-attempt sidecar). Every
  // OTHER heartbeat call site omits it, and heartbeatEntry leaves an existing pid alone
  // when it does.
  const pid = flags.pid != null ? String(flags.pid) : undefined;
  // plan 2437: an optional --state IN_LAND folds markQueueInLand's separate
  // mark-in-land coordWrite into THIS SAME mutateQueue transform (see stampInLand,
  // shared with cmdMarkInLand) — markHeadAcquired and markQueueInLand (done-worktree.mjs)
  // both fire at the identical head-acquisition arrival point, so the pid stamp and the
  // IN_LAND stamp are one logical event, not two sequential coordWrites.
  const state = flags.state != null ? String(flags.state) : undefined;
  if (state != null && state !== IN_LAND_STATE) {
    console.error(`landing-queue: heartbeat --state only supports ${IN_LAND_STATE}`);
    return 5;
  }
  // plan 2485: `--progress` marks this heartbeat as a LAND-PROGRESS stamp (a completed
  // spine step / head acquisition), additionally refreshing progressIso — the only signal
  // that resets the convergence clock demoteVerdict now reads. Deliberately opt-in: the
  // callers that must NOT pass it are the ones whose ticks made a non-converging head look
  // healthy (the plan-2085 near-head self-arm, the plan-1805 pre-convergence rounds, the
  // landing-queue-watch waiter tick), and a default-on flag would rebuild the overloaded
  // stamp this plan just split.
  const progress = flags.progress === true;
  // review fix (plan 2437): the pid stamp is DELIBERATELY UNCONDITIONAL (plan 2266 — a
  // later waiter's mechanical steal-verdict depends on it), and folding IN_LAND into
  // the same transform must never make a lost-head-race refusal drag the pid write down
  // with it. Capture stampInLand's throw INSIDE the transform (so heartbeatEntry's
  // result still commits) and re-throw it AFTER mutateQueue returns, once the pid write
  // has landed — same refusal, same message, same exit code, just no collateral pid loss.
  // plan 2603 — THE WRITE SEAM. A heartbeat is only "an idempotent timestamp nobody reads
  // back" when it carries no flags; `--pid` (plan 2266 residency identity) and `--state
  // IN_LAND` (plan 2437's fold) are genuine doc CONTENT other verdicts read as more than
  // an age, so those keep the doc write (mutateQueue) exactly as before — and DELIBERATELY do
  // not also stamp the ref. There is nothing for a second write to buy: decorateWithHeartbeatRefs
  // folds the two channels with max(), so a doc stamp that is newer than the last
  // ref stamp already wins every staleness verdict. Writing both would add a second push
  // (and a second failure mode) to the once-per-residency calls purely to keep two copies
  // of a number that is only ever read through that max().
  //
  // The flagless class is the bursty one this plan exists to move: done-worktree's
  // per-completed-step stamps and landing-queue-watch's 300s near-head self-arm. It writes
  // the ref ONLY.
  //
  // Fail-safe (write direction): if the ref write throws, fall THROUGH to the doc write.
  // A ping that silently did not land lets a live head be demoted or reaped, so paying the
  // old cost on a rare failure is strictly the right trade.
  const pureStamp = pid === undefined && state === undefined;
  if (pureStamp) {
    const ts = nowIso();
    try {
      writeHeartbeatRef(MAIN, slug, { ts, progressIso: progress ? ts : null });
      console.log(`heartbeat ${slug} (ref)${progress ? ' (progress)' : ''}`);
      // plan 3450 Phase A: the flagless heartbeat is the ONE call every live queue member
      // makes on a timer, so it is where a sweep reaches a queue nobody is enqueueing into.
      // Throttled (see SWEEP_THROTTLE_MIN) precisely because it is bursty, and stamped after
      // this ping so the sweep's own read sees THIS heartbeat — a head that just pinged must
      // never be judged stale by the sweep its own ping triggered.
      maybeSweepAfterMutate(MAIN, flags, 'heartbeat');
      return 0;
    } catch (e) {
      console.error(
        `landing-queue: heartbeat ref write failed (${e.message}) — falling back to the ` +
          `queue-doc coord write so this liveness stamp is not silently dropped`,
      );
    }
  }
  let headGateError = null;
  mutateQueue(MAIN, `coord(queue): heartbeat ${slug}`, (entries, audit) => {
    const heartbeated = heartbeatEntry(entries, slug, nowIso(), pid, progress);
    if (state == null) return { entries: heartbeated, auditLines: audit };
    try {
      return { entries: stampInLand(heartbeated, slug), auditLines: audit };
    } catch (e) {
      headGateError = e;
      return { entries: heartbeated, auditLines: audit };
    }
  });
  if (headGateError) throw headGateError;
  console.log(
    `heartbeat ${slug}${pid ? ` (pid ${pid})` : ''}${state ? ` (state ${state})` : ''}` +
      `${progress ? ' (progress)' : ''}`,
  );
  return 0;
}

function cmdSteal({ MAIN, slug, flags }) {
  const staleMin =
    flags['stale-min'] != null ? Number(flags['stale-min']) : DEFAULT_STEAL_STALE_MIN;
  // verdict against the FRESH cross-PC view first (clean refusal without a write)…
  const base = readVerdictBase(MAIN, 'steal');
  if (reportPreVerdictRefusal(base.refusal)) return 2;
  const pre = stealVerdict({
    entries: base.entries,
    stealer: slug,
    nowMs: Date.parse(nowIso()),
    staleMin,
  });
  if (!pre.ok) {
    console.error(`REFUSED — ${pre.reason}`);
    return 2;
  }
  // plan 1462: batch-aware holder-liveness. A BATCH head's 🟢 LANDING mutex marker lives
  // on a representative MEMBER board row (claim-plan.mjs batch never creates a batch-slug
  // row; done-worktree resolves it onto the first present member row — plan 1454). The
  // steal recovery convention "verify the holder is gone via the queue slug's board row"
  // is therefore BLIND for a batch: the batch slug has no row, so a verifier reads "no
  // LANDING" and could steal the head of a batch that is actively mid-LANDING — a FIFO
  // double-land on the same lane. So when the stale head is a batch slug, resolve its
  // member rows and REFUSE if any holds 🟢 LANDING — REGARDLESS of --confirm-holder-gone,
  // because that flag asserts a check made against a row that does not exist. (A batch
  // whose members are all idle — a genuinely crashed land — has no member marker, so this
  // is a no-op and the ordinary confirm-holder-gone path can still reclaim it.)
  //
  // plan 2266 review note: this gate deliberately stays BATCH-ONLY, not widened to
  // single-plan heads (unlike cmdDemote's own board check below), and deliberately NOT
  // consulted by the mechanical path either. A single-plan head's queue-entry pid IS the
  // pid of the ONE process that owns its entire land (head-acquisition through the final
  // push — every step runs execFileSync from that one process, see markHeadAcquired);
  // after the plan-2266 review fix that makes the pid stamp track the CURRENT process on
  // every invocation (not just a "fresh" residency), "recorded pid verifiably not
  // running" is equivalent to "the land's owning process is dead" with no residual gap a
  // board check would catch. Gating the mechanical path on board-LANDING would instead
  // make it refuse the EXACT incident this plan exists to auto-recover (2208: board
  // flipped 🟢 LANDING at 09:43:09, the owning process died 09:43:09, pid verifiably dead
  // for hours) — requiring the pre-2266 manual --confirm-holder-gone path for precisely
  // the case plan 2266 was written to close. A batch's per-member LANDING marker is a
  // genuinely different signal (routing/indirection a human --confirm-holder-gone could
  // miss, plan 1462), not a pid-staleness compensation, so it keeps its own gate above,
  // batch-only, for both the manual and mechanical paths.
  if (isBatchSlug(pre.head.slug)) {
    // plan 3459: both reads ride the verdict's PINNED snapshot, so the manifest, the board and
    // the queue that named this head all describe one commit. An unreadable manifest used to
    // read as `[]` members here — i.e. as "the batch landed" — which made this whole gate a
    // no-op and let the steal through against a batch that was actively mid-land; it now
    // throws, caught below as a refusal.
    let members;
    let landing;
    try {
      members = readBatchManifestMembersFresh(base.source, pre.head.slug, 'steal');
      landing = batchMemberLandingRows(readBoardFresh(base.source, 'steal'), members);
    } catch (e) {
      if (!e?.refusal) throw e;
      console.error(`REFUSED — ${e.message}`);
      return 2;
    }
    if (landing.length) {
      console.error(
        `REFUSED — batch head ${pre.head.slug} is stale by heartbeat (age ${pre.ageMin ?? '?'}m) but is ` +
          `ACTIVELY mid-LANDING: its 🟢 LANDING mutex is held on member row(s) ${landing.join(', ')} ` +
          `(a batch's marker lives on a MEMBER row, not a batch-slug row). The holder is NOT gone — ` +
          `stealing now would double-land the lane. Wait for the member row's LANDING to clear.`,
      );
      return 2;
    }
  }
  // plan 2266: a MECHANICAL alternative to the human --confirm-holder-gone assertion — the
  // head's recorded {host, pid} (stamped at head-acquisition, see markHeadAcquired) proves
  // the exact process that took the slot is verifiably gone (same host as this prober, and
  // its pid no longer answers a signal-0 probe). Cross-host heads and pre-2266/unstamped
  // entries (no recorded pid) fall through to the existing manual path unchanged.
  const probingHost = flags.host ?? hostname();
  const { pidRunning } = probeHeadPid(pre.head);
  const mech = mechanicalHolderGoneVerdict({ head: pre.head, probingHost, pidRunning });
  if (!mech.mechanical && flags['confirm-holder-gone'] !== true) {
    console.error(
      `REFUSED — head ${pre.head.slug} is stale (age ${pre.ageMin ?? '?'}m > ${staleMin}m) but a steal also needs ` +
        `proof the holder is GONE (${mech.reason}): check handoff-board.md for its row and \`git log\` for recent ` +
        `commits from that session, then re-run with --confirm-holder-gone. A live-but-slow conflict resolution ` +
        `must NOT be stolen.`,
    );
    return 2;
  }
  // …then re-verify INSIDE the mutate (re-run on each retry against the freshened
  // base) so a head that heartbeats mid-steal aborts the write.
  // review 1682 delta: report the victim the COMMITTED transform run actually removed
  // (closure capture, same F-008 class as demote's fix) — the transform re-runs against
  // a freshened base on a coordWrite retry, so the head can differ from `pre.head`.
  let stolenSlug = pre.head.slug;
  let stolenAgeMin = pre.ageMin;
  // The holder-gone proof the COMMITTED transform run actually made (see its re-probe
  // below). `mech` above only authorized ENTERING the mutate; everything downstream that
  // acts on "the holder was mechanically proven gone" must read the re-proved verdict.
  // Starts NULL, not `= mech` (round-3 review finding): seeding it with the pre-check
  // verdict would make a future early-return inside the transform silently fall back to
  // the stale proof — exactly the bug the re-probe exists to prevent — instead of tripping
  // the assertion below. Unset here means "the transform never re-proved", which is a bug,
  // not a default.
  let committedMech = null;
  const mutated = mutateQueue(
    MAIN,
    `coord(queue): steal — ${slug} takes the stale head slot`,
    (entries, audit, _mainDir, source) => {
      // plan 2603: re-read the heartbeat refs HERE, not reuse the pre-verdict's map —
      // catching a mid-steal ping is this re-verdict's whole job, and a ping now lands in
      // the ref namespace rather than in the doc coordWrite has just freshened. The
      // decoration feeds the VERDICT only; applySteal still operates on the undecorated
      // entries, so no ref-derived timestamp is ever written back into the doc.
      const rv = decorateForReverdict(MAIN, 'steal', entries);
      if (rv.refusal) {
        throw Object.assign(new Error(`steal aborted: ${rv.refusal}`), { refusal: true });
      }
      const v = stealVerdict({
        entries: rv.entries,
        stealer: slug,
        nowMs: Date.parse(nowIso()),
        staleMin,
      });
      if (!v.ok) throw Object.assign(new Error(`steal aborted: ${v.reason}`), { refusal: true });
      // plan 2656 (review finding on 2603): `mech` was computed ONCE, before this mutate,
      // against `pre.head` — either its pid-dead proof authorized this steal, or the
      // operator's own --confirm-holder-gone did, but both were judgments about
      // `pre.head` specifically. If the re-verdict above lands on a DIFFERENT head (the
      // old head landed/was displaced/was itself stolen between the pre-check and this
      // commit), applying `mech.mechanical` unconditionally below would release THIS
      // new head's landing-lock and flip its board row on a proof that was never made
      // about it. cmdOvertake already refuses on the identical race (review 2275 F1);
      // steal follows the same rule — abort and let a fresh invocation re-prove against
      // whoever holds the head now.
      assertHeadUnchanged({
        verb: 'steal',
        preHead: pre.head,
        reHead: v.head,
        proof: 'the holder-gone proof',
      });
      // …and the SAME slug is still not the same PROOF (plan 2656 self-review). The slug
      // guard above catches a different head; it does not catch this head being re-taken
      // by a NEW process. done-worktree stamps a fresh pid onto the SAME entry whenever a
      // resumed/restarted residency reaches the head ("exactly the case a resumed process
      // reaches head under a NEW pid" — its own comment at the queueHeartbeat call), and
      // since plan 2603 that pid lands in the DOC while the ping lands in a REF, two
      // separate writes. So a re-verdict can legitimately see the doc's new pid alongside
      // a ref timestamp fetched just before the new ping was pushed: still stale, so
      // stealVerdict still says ok, and the slug is unchanged. Reusing `mech` there would
      // release the landing-lock of a process proven dead minutes ago and now replaced by
      // a LIVE one — a double-land on the lane, the exact hazard steal exists to prevent.
      // So re-probe against the head this transform is actually committing against, the
      // same way cmdDemote recomputes demoteHolderPidAlive inside its own mutate, and
      // capture it for the post-mutate tenure release (closure capture, same reason
      // stolenSlug/stolenAgeMin are captured).
      const rvProbe = probeHeadPid(v.head);
      const rvMech = mechanicalHolderGoneVerdict({
        head: v.head,
        probingHost,
        pidRunning: rvProbe.pidRunning,
      });
      // The head can keep its slug and still be a DIFFERENT RESIDENCY (round-3 review
      // finding). done-worktree stamps a fresh pid onto the same entry whenever a resumed
      // or restarted land reaches the head, so `assertHeadUnchanged` above can pass while
      // the process holding the slot is not the one either proof was made about — and
      // BOTH proofs are pid-scoped: the mechanical one probed `pre.head.pid`, and the
      // operator's --confirm-holder-gone was an assertion about the process they went and
      // inspected. Neither transfers to a successor. So a pid CHANGE refuses regardless of
      // the flag.
      //
      // Deliberately keyed on pid IDENTITY, not on liveness: refusing whenever the head's
      // pid merely answers a probe would break --confirm-holder-gone's whole purpose (see
      // the "a LIVE pid on the same host is NOT mechanically reaped" test). A signal-0
      // probe proves a pid EXISTS, not that the session is doing anything — a wedged land
      // still answers it, and forcing past exactly that is the escape hatch the flag is
      // for. The operator may overrule the probe about the process they inspected; nobody
      // gets to overrule it about a process that arrived afterwards.
      if (String(pre.head.pid ?? '') !== String(v.head.pid ?? '')) {
        throw Object.assign(
          new Error(
            `steal aborted: ${v.head.slug} kept the head slot but changed residency ` +
              `(pid ${pre.head.pid ?? 'none'} → ${v.head.pid ?? 'none'}) between the ` +
              `pre-check and this write — the holder-gone proof, mechanical or ` +
              `--confirm-holder-gone, was made about the OLD process. Re-run to re-judge ` +
              `against the one holding it now.`,
          ),
          { refusal: true },
        );
      }
      if (!rvMech.mechanical && flags['confirm-holder-gone'] !== true) {
        throw Object.assign(
          new Error(
            `steal aborted: the holder-gone proof no longer holds against the head being ` +
              `committed (${rvMech.reason}) — the slot was re-taken between the pre-check and ` +
              `this write; re-run to re-prove against the process holding it now`,
          ),
          { refusal: true },
        );
      }
      committedMech = rvMech;
      stolenSlug = v.head.slug;
      stolenAgeMin = v.ageMin;
      // plan 1462 review-fix: the batch-aware LANDING gate above ran only against the `pre`
      // snapshot taken BEFORE this mutate — a member that begins 🟢 LANDING between that
      // snapshot and this commit would slip past it and double-land the lane. So re-check the
      // member-LANDING state HERE too, against a board re-read fresh at the moment of the write
      // (coordWrite has freshened origin/master before this transform runs), exactly mirroring
      // how stealVerdict is itself re-run inside the mutate to catch a mid-steal heartbeat.
      //
      // plan 3459: read from the transform's own pinned `source` (origin/master's sha), not
      // from MAIN — MAIN's working tree is mutable and shared, so it could describe a
      // different world than the commit this write lands against. Same fix plan 3450's G3
      // made for demote/reap's in-mutate LANDING check; steal's copy had been left behind.
      if (isBatchSlug(v.head.slug)) {
        const members = readBatchManifestMembersFresh(source, v.head.slug, 'steal');
        const landing = batchMemberLandingRows(readBoardFresh(source, 'steal'), members);
        if (landing.length) {
          throw Object.assign(
            new Error(
              `steal aborted: batch head ${v.head.slug} is ACTIVELY mid-LANDING — its 🟢 LANDING ` +
                `mutex is held on member row(s) ${landing.join(', ')}; stealing now would double-land the lane`,
            ),
            { refusal: true },
          );
        }
      }
      const r = applySteal(
        entries,
        slug,
        nowIso(),
        v.ageMin,
        rvMech.mechanical ? 'MECHANICAL reap: pid verified not running' : undefined,
      );
      return { entries: r.entries, auditLines: [...audit, r.auditLine] };
    },
    { prune: false }, // steal keeps its exact verdict semantics — see mutateQueue (plan 574)
  );
  // plan 2266 item 3: "reap = steal + tenure release" — on a MECHANICAL reap only (a manual
  // operator --confirm-holder-gone steal is unchanged, existing behavior), also release the
  // same-PC landing-lock and flip a single-plan head's board row LANDING → IN-PROGRESS —
  // mirrors done-worktree.mjs's releaseHeadTenureAfterRequeue so a dead head no longer
  // leaves the mutex + board row dangling behind the reaped queue entry (the 2208 incident).
  // Best-effort: the steal itself already committed above; a tenure-release failure here
  // must never be reported as the steal having failed (bestEffort below never throws).
  // landing-lock's releaseAt is a NOOP on an absent/foreign holder (never an error).
  // board.mjs's non-LANDING set-state already tolerates an absent row natively (F-018) —
  // no row-absence special-casing needed here.
  // A batch slug (isBatchSlug) has no board row of its own (its 🟢 LANDING marker lives on a
  // MEMBER row — plan 1462), and the pre-steal gate above already proved no member holds
  // LANDING, so the board flip is single-plan-only; the landing-lock release still applies
  // (it is keyed by the queue/land slug either way, batch included).
  // plan 2603: the stolen entry is gone from the doc — retire its heartbeat ref too, on
  // the same best-effort/never-fail-the-verb footing as the landing-lock and board-row
  // releases below (namespace hygiene only; the read-side fold already ignores a stamp
  // that predates a re-enqueue).
  deleteHeartbeatRef(MAIN, stolenSlug);
  // The transform ran to completion (mutateQueue returned), so it MUST have re-proved.
  // Loud rather than falling back to a stale verdict — see committedMech's declaration.
  if (!committedMech) {
    throw new Error(
      'landing-queue: internal — steal committed without re-proving the holder-gone verdict',
    );
  }
  if (committedMech.mechanical) {
    bestEffort('landing-lock release', () => {
      const r = releaseAt(resolveLockPath(), { slug: stolenSlug });
      if (r.action === 'FOREIGN' || r.action === 'NOT_FOUND') {
        console.error(
          `landing-queue: mechanical reap — landing-lock release for ${stolenSlug} returned ` +
            `${r.action} (held by ${r.holder?.slug ?? 'unknown'}) — left untouched, non-fatal`,
        );
      }
    });
    if (!isBatchSlug(stolenSlug)) {
      // coordRetry(false, …) = the short, bounded non-wait budget (retryTransientCoordDirt,
      // ~4 attempts): a sibling's transient sub-second coord-doc write in the shared main
      // checkout must not permanently strand this row at 🟢 LANDING — the queue entry is
      // already gone by this point, so no LATER poll ever revisits this slug to retry a
      // bare, unretried failure (review finding: board.mjs's own coordWrite carries no
      // built-in retry).
      bestEffort('board set-state', () => {
        coordRetry(false, () =>
          execFileSync('node', [BOARD_CLI, 'set-state', stolenSlug, 'IN-PROGRESS'], {
            encoding: 'utf8',
          }),
        );
      });
    }
  }
  // F-008: report the slug that ACTUALLY ends up at head after the write — stealVerdict's
  // membership check makes this equal `slug` by construction, but reading it back off the
  // post-mutate entries (rather than trusting the caller's argument) is the belt-and-suspenders
  // the finding asked for, and correctly reports "(queue now empty)" in the edge case where the
  // stolen-into slug was the LAST entry.
  const newHead = headOf(mutated.entries);
  console.log(
    `stole head slot: ${stolenSlug} removed (heartbeat age ${stolenAgeMin ?? '?'}m)${committedMech.mechanical ? ' [MECHANICAL]' : ''}; ` +
      `${newHead ? newHead.slug : '(queue now empty)'} promoted to head`,
  );
  return 0;
}

// plan 2414: the pid half of demote's IN_LAND liveness immunity — same OS probe as
// cmdSteal's mechanical path (isPidAlive), gated the same cross-host/no-pid way as
// mechanicalHolderGoneVerdict (a foreign pid can never be verified, and "no evidence"
// must never read as "verified alive"). Returns the tri-state demoteVerdict expects:
// true (verified alive) / false (verified NOT running) / null (unprobeable — the
// caller falls back to the heartbeat-age leash). Only ever consulted when the head is
// actually stamped IN_LAND, so this is skipped (no syscall) otherwise.
function demoteHolderPidAlive(head, probingHost) {
  if (!head || head.state !== IN_LAND_STATE) return null;
  if (!head.host || head.host !== probingHost) return null;
  const pidNum = Number(head.pid);
  if (!head.pid || !Number.isFinite(pidNum) || pidNum <= 0) return null;
  return isPidAlive(pidNum);
}

// plan 1682 — see the header block. Structure mirrors steal: clean pre-verdict on the
// fresh cross-PC view (refusal without a write), the board LANDING gate, then the
// re-verdict + re-gate INSIDE the mutate against the freshened base.
// plan 3450: `ghost` runs this verb for the SWEEP's hypothetical tail waiter (slug ===
// SWEEP_CALLER) — the only change is that every verdict sees `withGhostWaiter(entries)`
// instead of `entries`, which satisfies the membership gate rather than weakening it. Each
// mutation below still applies to the real, ghost-free array. `report` is the sweep's
// outcome channel (the CLI text/JSON here is captured, not printed, on that path).
function cmdDemote({ MAIN, slug, flags, ghost = false, report = null }) {
  const staleMin =
    flags['stale-min'] != null ? Number(flags['stale-min']) : DEFAULT_DEMOTE_STALE_MIN;
  if (!Number.isFinite(staleMin) || staleMin <= 0) {
    console.error(
      `landing-queue: --stale-min must be a positive number (got "${flags['stale-min']}")`,
    );
    return 5;
  }
  // plan 2485: the convergence-axis bound, same validation shape as --stale-min. `0`
  // disables the axis (pre-2485 liveness-only semantics) and is therefore ALLOWED here,
  // unlike --stale-min's positive-only rule — an operator debugging a suspected
  // false-positive demote needs a way to take the new axis out of the picture without
  // editing the constant.
  const convergeMin =
    flags['converge-min'] != null ? Number(flags['converge-min']) : DEFAULT_CONVERGE_STALE_MIN;
  if (!Number.isFinite(convergeMin) || convergeMin < 0) {
    console.error(
      `landing-queue: --converge-min must be a non-negative number (got "${flags['converge-min']}")`,
    );
    return 5;
  }
  // plan 3000: the operator-authority override. Presence of the flag IS the assertion; its
  // value is the mandatory reason. A bare `--operator-override` (parseFlags yields the next
  // token, or `undefined` at end-of-argv) and a blank/whitespace reason both fail here
  // rather than proceeding anonymously — exit 5 (a malformed request), not 2 (a refused
  // verdict), matching --stale-min's own arg-validation shape.
  // PRESENCE, not truthiness: parseFlags only sets a key when the flag was actually typed,
  // and a `value` flag running off the end of argv stores `undefined` under it. A `!= null`
  // test would read that bare `--operator-override` as "no override requested" and silently
  // run an ORDINARY demote — the operator's authority assertion swallowed by a missing
  // argument, refused on staleness with no hint that the flag was dropped.
  const operatorOverride = Object.hasOwn(flags, 'operator-override');
  // plan 3450: the ghost caller is MACHINERY, never authority. An override is the operator's
  // personal assertion, recorded under their reason; a scheduled sweep can hold no such
  // assertion, so the two are refused as a combination rather than silently composed.
  if (ghost && operatorOverride) {
    console.error(
      'landing-queue: the sweep never carries --operator-override — an override is an ' +
        'operator authority assertion, and the sweep is an unattended process',
    );
    return 5;
  }
  const rawReason = operatorOverride ? flags['operator-override'] : '';
  // A `value` flag consumes the NEXT token unconditionally (parse-flags.mjs's pinned
  // semantics), so `--operator-override --json` would otherwise take "--json" as the reason
  // AND swallow the flag: an anonymous-in-substance override recorded under a nonsense
  // justification, with the operator's `--json` silently gone. record-review.mjs's flagVal
  // already refuses a flag-shaped value for exactly this reason; the same rule applies here,
  // where the value IS the accountability record. Refused unconditionally rather than only
  // for the space-separated form: parseFlags splits `--name=value` before classification and
  // keeps no record of which spelling was typed, so the two are indistinguishable here — and
  // a genuine justification that opens with a dash is not a real case worth the ambiguity.
  // SINGLE dash included: a `value` flag consumes the next token whatever its shape, so
  // `--operator-override -m` swallows `-m` exactly as it swallows `--json`, and this CLI
  // declares no short aliases — every `-x` here is a mistake, never a reason.
  const reasonIsFlagShaped = typeof rawReason === 'string' && /^-/.test(rawReason);
  const operatorReason = operatorOverride ? normalizeOverrideReason(rawReason) : '';
  if (operatorOverride && (!operatorReason || reasonIsFlagShaped)) {
    console.error(
      'landing-queue: --operator-override requires a reason ' +
        '(e.g. --operator-override "operator ruling: 2988 lands first") — it is stamped into ' +
        'the audit trail and the requeue commit subject, so an override is never anonymous.' +
        (reasonIsFlagShaped
          ? ` Got the flag-shaped value "${rawReason}", which is a missing reason that ` +
            `swallowed the next flag, not a justification.`
          : ''),
    );
    return 5;
  }
  const probingHost = flags.host ?? hostname();
  const fresh = readVerdictBase(MAIN, 'demote', { operatorOverride });
  // plan 3450 review F2: a fail-closed READ refusal ("I could not judge this head") is
  // reported on the outcome channel too, not only as console text and exit 2. The sweep is the
  // one caller that must tell it apart from an ordinary verdict refusal ("the head is fresh"),
  // because the first means its run proved nothing and the second means there was nothing to
  // do — and only the first may be reported to a scheduled task as a failure.
  if (fresh.refusal) {
    report?.({ outcome: 'unjudgeable', head: null, reason: fresh.refusal });
    reportPreVerdictRefusal(fresh.refusal);
    return 2;
  }
  // AFTER readVerdictBase, never before: that call owns the fetch that CREATES the local
  // origin/master ref. Probing first would refuse a clone that simply had not fetched yet —
  // a false refusal manufactured by check order, in the one command whose whole purpose is
  // to stop refusing spuriously.
  if (operatorOverride && reportPreVerdictRefusal(originMasterUnresolvable(MAIN))) return 2;
  // prune landed orphans from the view first (same as status) — a landed head is
  // reaped by the next mutate, not demoted; the verdict must judge the LIVE queue.
  // plan 3459: at the pinned snapshot, and an unjudgeable axis REFUSES on the same channel
  // as an unreadable doc/ref above rather than silently judging an unpruned queue.
  const live = livePrune('demote', fresh);
  if (live.refusal) {
    report?.({ outcome: 'unjudgeable', head: null, reason: live.refusal });
    reportPreVerdictRefusal(live.refusal);
    return 2;
  }
  const freshLive = live.entries;
  const pre = demoteVerdict({
    entries: ghost ? withGhostWaiter(freshLive) : freshLive,
    auditLines: fresh.auditLines,
    demoter: slug,
    nowMs: Date.parse(nowIso()),
    staleMin,
    convergeMin,
    holderPidAlive: demoteHolderPidAlive(headOf(freshLive), probingHost),
    operatorOverride,
    operatorReason,
  });
  if (!pre.ok) {
    console.error(`REFUSED — ${pre.reason}`);
    return 2;
  }
  let preLanding;
  try {
    preLanding = headLandingRows(fresh.source, pre.head.slug, 'demote');
  } catch (e) {
    if (!e?.refusal) throw e;
    report?.({ outcome: 'unjudgeable', head: pre.head.slug, reason: e.message });
    reportPreVerdictRefusal(e.message);
    return 2;
  }
  if (preLanding.length) {
    // plan 2485: name the axis that actually reached this gate. The 🟢 LANDING immunity is
    // unchanged and absolute (invariant: a merge-window head is NEVER demote-eligible,
    // whatever its convergence reading) — only the diagnostic was heartbeat-specific.
    console.error(
      `REFUSED — head ${pre.head.slug} is ` +
        (pre.staleAxis === OPERATOR_AXIS
          ? `operator-override-demanded (heartbeat age ${pre.ageMin ?? '?'}m)`
          : pre.staleAxis === CONVERGE_AXIS
            ? `convergence-stale (no land progress; heartbeat age ${pre.ageMin ?? '?'}m)`
            : `heartbeat-stale (age ${pre.ageMin ?? '?'}m)`) +
        ` but holds the 🟢 LANDING mutex on row(s) ${preLanding.join(', ')} — it is actively ` +
        `mid-land (a long merge-step battery outlives the last spine heartbeat); not demote-eligible.` +
        // plan 3000 (execution note 3): the ONE residual refusal an operator override does
        // not clear. This is data integrity, not queue politics — the head is inside the
        // spine-owned merge window, where moving it does not reorder a queue so much as
        // interrupt a half-applied merge. It is also the shortest-lived refusal in the file,
        // so "retry" is a real answer rather than a brush-off.
        (operatorOverride
          ? ` The operator override does NOT clear this one axis: a merge-window head is ` +
            `never demote-eligible, because the refusal protects the merge itself rather than ` +
            `the head's queue position. This window is MINUTES wide — retry the same command ` +
            `once the 🟢 LANDING row clears (watch it with \`landing-queue.mjs status\`).`
          : ''),
    );
    return 2;
  }
  // plan 3000 (execution note 5): print what the override is throwing away BEFORE acting.
  // A demoted mid-land head loses its whole gate battery (the reproduction's head was ~23
  // minutes into a pytest preflight) and re-runs it from the tail. This is deliberately a
  // loud, unconditional warning on every override — not just the IN_LAND case — because the
  // discarded work is real whenever the head is live, and IN_LAND is a stamp the head may
  // simply not have written yet.
  if (operatorOverride) {
    console.error(
      `OPERATOR OVERRIDE — demoting head ${pre.head.slug} to the tail on operator authority.\n` +
        `  head state:     ${pre.head.state ?? 'none'}\n` +
        `  heartbeat age:  ${pre.ageMin ?? 'unparseable'}${pre.ageMin == null ? '' : 'm'}\n` +
        `  reason:         ${operatorReason}\n` +
        `  DISCARDED: the head's in-flight gate battery. It re-runs from the tail on its next ` +
        `done-worktree — a full preflight (tests, prettier, coord-drift, review checks), tens ` +
        `of minutes of work, not a resumable checkpoint.` +
        (pre.head.state === IN_LAND_STATE
          ? `\n  NOTE: this head is stamped IN_LAND — it is actively mid-land right now, so the ` +
            `discarded battery is work in progress, not a finished one.`
          : ''),
    );
  }
  // The warning above is a DISCLOSURE established about one specific head — the same kind of
  // proof cmdSteal and cmdOvertake establish pre-verdict — and the transform below re-runs
  // against a freshened base, so it can settle on a DIFFERENT head. For an automatic demote
  // that only affects the reported numbers; for an override it would mean the operator was
  // shown one head's discarded cost and a different head was moved on their authority. Abort
  // instead; a fresh invocation re-warns against whoever holds the slot then.
  const preHeadForOverride = operatorOverride ? pre.head : null;
  // review 1682 [1] (the steal F-008 class): the transform RE-RUNS against a freshened
  // base on every coordWrite attempt, so the head it actually demotes can differ from
  // `pre.head` — report the slug/age the COMMITTED transform run saw (closure capture;
  // the last run is the one whose write landed), and keep the fixed commit message
  // head-neutral (the audit line inside the same commit names the actual victim).
  let demotedSlug = null;
  let demotedAgeMin = null;
  let demotedAxis = null;
  let demotedBound = null;
  let demotedProgressMin = null;
  const mutated = mutateQueue(
    MAIN,
    // plan 3000 (execution note 2): the reason rides in the COMMIT SUBJECT, mirroring
    // `edit-plan.mjs --claimed-override`'s precedent — so `git log` on the queue doc shows
    // WHY an override happened without opening the audit region. Same head-neutral rule as
    // the automatic subject: the re-verdict inside the transform may land on a different
    // head, and the audit line in this same commit names the actual victim.
    operatorOverride
      ? `coord(queue): OPERATOR-OVERRIDE demote head to tail — waiter ${slug} — reason: ${operatorReason}`
      : `coord(queue): demote stale not-landing head to tail — waiter ${slug}`,
    (entries, audit, _mainDir, source) => {
      // plan 2603: re-read the refs inside the mutate (see the same note in cmdSteal) —
      // a head that pings mid-demote must abort this write, and its ping is a ref update
      // now, invisible to coordWrite's doc freshen. Verdict-only decoration: applyDemote
      // moves the UNDECORATED entry, so the doc never absorbs a ref-derived stamp.
      const rv = decorateForReverdict(MAIN, 'demote', entries, { operatorOverride });
      if (rv.refusal) {
        // plan 3450 review F2: the in-mutate half of the same fail-closed read — flagged
        // `unjudgeable` so the sweep's catch can tell it from the genuine mid-mutate aborts
        // below (head changed, head went 🟢 LANDING), which ARE verdicts.
        throw Object.assign(new Error(`demote aborted: ${rv.refusal}`), {
          refusal: true,
          unjudgeable: true,
        });
      }
      const decorated = ghost ? withGhostWaiter(rv.entries) : rv.entries;
      const v = demoteVerdict({
        entries: decorated,
        auditLines: audit,
        demoter: slug,
        nowMs: Date.parse(nowIso()),
        staleMin,
        convergeMin,
        holderPidAlive: demoteHolderPidAlive(headOf(decorated), probingHost),
        // plan 3000: the override re-asserts INSIDE the mutate too. The structural gates it
        // keeps (caller still queued behind the head, still not the head's own session) are
        // re-judged against the freshened base on every retry, exactly like the automatic
        // path — an override skips the staleness axes, never the re-verdict itself.
        operatorOverride,
        operatorReason,
      });
      if (!v.ok) throw Object.assign(new Error(`demote aborted: ${v.reason}`), { refusal: true });
      if (preHeadForOverride) {
        assertHeadUnchanged({
          verb: 'demote',
          preHead: preHeadForOverride,
          reHead: v.head,
          proof: "the operator's discarded-work disclosure",
        });
      }
      const landing = headLandingRowsInMutate('demote', source, v.head.slug);
      if (landing.length) {
        throw Object.assign(
          new Error(
            `demote aborted: head ${v.head.slug} went 🟢 LANDING mid-demote (row(s) ${landing.join(', ')}) — ` +
              `it is actively mid-land`,
          ),
          { refusal: true },
        );
      }
      demotedSlug = v.head.slug;
      demotedAgeMin = v.ageMin;
      // plan 2485: the axis AND its numbers ride from the COMMITTED transform run's own
      // verdict (same closure-capture rule as demotedSlug/demotedAgeMin — the re-verdict
      // inside the mutate can land on a different head, and therefore a different axis and
      // bound, than `pre`). Carrying the verdict's own bound/progress forward is what keeps
      // the operator line, the audit line and the actual gate reporting one set of numbers
      // (review [2]/[6]/[7]).
      demotedAxis = v.staleAxis ?? HEARTBEAT_AXIS;
      demotedBound = v.convergeBound ?? null;
      demotedProgressMin = v.convergeProgressMin ?? null;
      const r = applyDemote(entries, slug, nowIso(), v.ageMin, staleMin, {
        staleAxis: demotedAxis,
        convergeMin,
        convergeBound: v.convergeBound,
        convergeProgressMin: v.convergeProgressMin,
        operatorReason,
      });
      return { entries: r.entries, auditLines: [...audit, r.auditLine] };
    },
  );
  const payload = {
    demoted: demotedSlug,
    // plan 2485: which axis fired, so an operator (and the telemetry miner) can tell a
    // classic silent-head demote from an alive-but-not-converging one without re-deriving
    // it from the audit text.
    axis: demotedAxis,
    // The bound actually applied (the IN_LAND leash is wider than `convergeMin`) and the
    // progress age measured against it — null on a heartbeat-axis demote.
    convergeBound: demotedBound,
    convergeProgressMin: demotedProgressMin,
    // plan 3000: the override and its reason are machine-readable too — a scripted caller
    // (or the telemetry miner) must be able to tell an authority move from a staleness one
    // without re-parsing the audit text. `false`/`null` on every automatic demote.
    operatorOverride: demotedAxis === OPERATOR_AXIS,
    operatorReason: demotedAxis === OPERATOR_AXIS ? operatorReason : null,
    ...callerPositionPayload(mutated.entries, slug, ghost),
  };
  console.log(
    flags.json === true
      ? JSON.stringify(payload)
      : `demoted ${payload.demoted} → tail (` +
          (demotedAxis === OPERATOR_AXIS
            ? `operator override: ${operatorReason}`
            : demotedAxis === CONVERGE_AXIS
              ? // review [2]/[7]: print the bound the VERDICT used, never the raw
                // `convergeMin` — an IN_LAND head is judged against the wider leash, and a
                // console line saying "> 45m" beside an audit line saying "> 90m" for the
                // same event is a directly contradictory report on the one line an operator
                // reads live.
                `alive but not converging: no land progress ${demotedProgressMin ?? '?'}m > ${demotedBound ?? '?'}m`
              : `heartbeat age ${demotedAgeMin ?? '?'}m`) +
          `); head now ${payload.head}; ` +
          // plan 3450 review F5: the ghost has no position to report — say what the queue
          // looks like instead of printing "(sweep) at position 0/N".
          (ghost
            ? `${payload.total} queued (asked by the sweep, which is not a queue member)`
            : `${slug} at position ${payload.position}/${payload.total}`),
  );
  report?.({ outcome: 'demoted', head: demotedSlug, ageMin: demotedAgeMin, axis: demotedAxis });
  return 0;
}

// ── plan 2275: mark-holding + overtake ──────────────────────────────────────────────

// Stamp/clear the head's HOLDING state (spine-only in practice — the done-worktree seam
// emit stamps `on`, the resume path runs `off`). Both directions are position-1-gated
// and re-verdicted inside the mutate:
//   on  — refuses when <slug> is not head (a demote/steal raced it out mid-seam; stamping
//         a non-head entry would be dead state nothing ever clears).
//   off — refuses when <slug> is not head. This is the overtake/resume race settlement:
//         a resume may only clear HOLDING (and re-enter the merge) once it is provably
//         back at position 1 on the freshened base; if an overtake committed first, the
//         clear refuses and the resume re-enters the queue wait instead.
// Idempotent in the no-op direction (already stamped / already clear at head) — coordWrite
// short-circuits an empty diff.
// review fix (plan 2414): the shared head-gate refusal both mark-* verbs need — only
// the entry currently AT position 1 may have its `state` cell stamped (a raced-away
// head slot must refuse harmlessly rather than stamp a non-head entry with dead state
// nothing ever clears). `verb`/`why` name the caller so the two commands' error text
// stays distinct even though the gate itself is now one function.
function assertIsHead(entries, slug, verb, why) {
  const head = headOf(entries);
  if (head?.slug !== slug) {
    const reason = `${slug} is not the queue head (head: ${head?.slug ?? 'none'}) — ${why}`;
    throw Object.assign(new Error(`${verb} refused: ${reason}`), { refusal: true });
  }
}

function cmdMarkHolding({ MAIN, slug, positionals, flags }) {
  const dir = positionals[1];
  if (dir !== 'on' && dir !== 'off') {
    console.error('landing-queue: mark-holding needs on|off (e.g. `mark-holding <slug> on`)');
    return 5;
  }
  const want = dir === 'on' ? HOLDING_STATE : null;
  mutateQueue(MAIN, `coord(queue): mark-holding ${dir} ${slug}`, (entries, audit) => {
    assertIsHead(
      entries,
      slug,
      'mark-holding',
      dir === 'on'
        ? 'only the parked head itself is ever marked HOLDING'
        : 'a resume may only clear HOLDING once it is back at position 1 (an overtaker ' +
            'is mid-land — re-enter the queue wait and retry when head again)',
    );
    return { entries: setEntryState(entries, slug, want), auditLines: audit };
  });
  const payload = { slug, holding: dir === 'on' };
  console.log(
    flags.json === true ? JSON.stringify(payload) : `mark-holding ${dir}: ${slug} (head)`,
  );
  return 0;
}

// plan 2414: stamp the queue entry IN_LAND at head-acquisition — the free-lane liveness
// token markHeadAcquired (done-worktree.mjs) rides in alongside its existing pid stamp.
// One-directional by design (mirrors queueHeartbeat, not mark-holding's on/off pair):
// there is no explicit "off" because IN_LAND is cleared STRUCTURALLY by every seam/exit
// (see the IN_LAND_STATE header comment in landing-queue-lib.mjs) — a dequeue removes
// the entry, a requeue/demote nulls `state` unconditionally, and `mark-holding on`
// overwrites it with HOLDING_STATE in the same column. Head-gated like mark-holding:
// a raced-away head slot refuses harmlessly (the spine's caller is best-effort, see
// markQueueInLand in done-worktree.mjs).
// plan 2437 (review fix): the ONE place both `mark-in-land` and `heartbeat --state
// IN_LAND` apply the stamp — shared so the head-gate invariant can never drift between
// the two callers. Throws (uncaught) on a raced-away head slot; cmdHeartbeat catches
// it to keep its pid write unconditional (see its own comment for why).
function stampInLand(entries, slug) {
  assertIsHead(entries, slug, 'mark-in-land', 'only the current head is ever stamped IN_LAND');
  return setEntryState(entries, slug, IN_LAND_STATE);
}

function cmdMarkInLand({ MAIN, slug, flags }) {
  mutateQueue(MAIN, `coord(queue): mark-in-land ${slug}`, (entries, audit) => ({
    entries: stampInLand(entries, slug),
    auditLines: audit,
  }));
  console.log(
    flags.json === true ? JSON.stringify({ slug, inLand: true }) : `mark-in-land: ${slug} (head)`,
  );
  return 0;
}

// Changed-path set of origin/<branch> since its merge-base with origin/master, or null
// when un-computable (missing remote ref, no merge-base) — the caller REFUSES on null
// (fail-safe: disjointness that cannot be proven is treated as overlap). Lock-retried
// (review 2275 F3): on the shared MAIN checkout a sibling's transient index/ref write
// must not masquerade as "branch missing" and wrongly refuse a legitimate overtake for
// a whole throttle period — gitWithLockRetry rides out the lock class; a genuinely
// missing ref still fails through to null.
//
// plan 3459: `base` is the verdict's PINNED sha, not the ref name. Both branches are compared
// against the SAME commit that produced the queue and the head — a sibling advancing
// origin/master between the pin and this probe used to move one side's merge base out from
// under the other, which can drop a genuinely conflicting path and prove a disjointness that
// was never true (review round 1). It falls back to the ref only when nothing was pinned.
function branchChangedPaths(mainDir, branch, base) {
  try {
    const out = gitWithLockRetry(mainDir, [
      'diff',
      '--name-only',
      `${base || 'origin/master'}...origin/${branch}`,
    ]);
    return new Set(
      out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

// One 🟩 waiter swaps past a LAND_BLOCKED_HOLDING head (overtaker → position 1, holder →
// position 2). Eligibility is overtakeVerdict (pure: head HOLDING, overtaker queued + 🟩,
// starvation cap) plus the PATH-DISJOINTNESS probe here (IO): the overtaker's branch diff
// vs the holder's branch diff must not intersect — an overlapping overtaker would seed
// NEW conflicts into the holder's patch-replay rebuild (the 2233 loop). Un-computable
// diffs (missing remote branch — e.g. a batch head whose branch name doesn't resolve)
// REFUSE, fail-safe. The queue verdict re-runs inside the mutate (steal/demote pattern);
// the path probe deliberately does NOT re-run there — it is a protective heuristic for
// the holder's later rebuild, not a serialization primitive (the single-lander invariant
// rests entirely on position 1 + the HOLDING re-verdict), and the branch tips it read
// were fetched moments earlier.
function cmdOvertake({ MAIN, slug, flags }) {
  // plan 2656 (round-3 review finding): overtake DISPLACES the head like steal/demote/reap
  // do, so it takes the same fail-closed doc read — via readFresh, not readDocFresh, which
  // throws `docFetched` away. Without this, an unreachable origin let overtake judge
  // against a stale queue and then chase the WRONG diagnostic: it would go on to fetch
  // `origin/worktree-<staleHeadSlug>` for the disjointness probe and refuse with "missing
  // remote branch", pointing the operator at a pruned branch instead of at the
  // connectivity failure the other three verbs now name outright.
  const { doc, docFetched, docFault, originSha } = readFresh(MAIN);
  if (reportPreVerdictRefusal(docReadRefusal(docFetched, 'overtake'))) return 2;
  if (reportPreVerdictRefusal(docFaultRefusal(docFault, 'overtake'))) return 2;
  const fresh = parseQueue(doc);
  // plan 3459: the pinned snapshot the doc itself came from, so this verb's prune reads the
  // same commit as the queue it is judging — and refuses rather than judging an unpruned one.
  const live = livePrune('overtake', { ...fresh, source: groundTruthSource(MAIN, originSha) });
  if (reportPreVerdictRefusal(live.refusal)) return 2;
  const pre = overtakeVerdict({
    entries: live.entries,
    auditLines: fresh.auditLines,
    overtaker: slug,
    nowMs: Date.parse(nowIso()),
  });
  if (!pre.ok) {
    console.error(`REFUSED — ${pre.reason}`);
    return 2;
  }
  const headBranch = `worktree-${pre.head.slug}`;
  const myBranch = `worktree-${slug}`;
  try {
    // review 2275 F7: master is NOT re-fetched here — readFresh above fetched it
    // moments ago (and coordWrite freshens again inside the mutate); only the two
    // branch refs the disjointness probe needs are new.
    gitWithLockRetry(MAIN, ['fetch', '--quiet', 'origin', headBranch, myBranch]);
  } catch {
    console.error(
      `REFUSED — cannot fetch origin/${headBranch} + origin/${myBranch} to prove path-disjointness ` +
        `(missing remote branch or offline); unprovable disjointness is treated as overlap`,
    );
    return 2;
  }
  const headPaths = branchChangedPaths(MAIN, headBranch, originSha);
  const myPaths = branchChangedPaths(MAIN, myBranch, originSha);
  if (!headPaths || !myPaths) {
    console.error(
      `REFUSED — cannot compute the changed-path sets for origin/${headBranch} vs origin/${myBranch}; ` +
        `unprovable disjointness is treated as overlap`,
    );
    return 2;
  }
  const overlap = [...myPaths].filter((p) => headPaths.has(p));
  if (overlap.length) {
    console.error(
      `REFUSED — ${slug} overlaps the holding head ${pre.head.slug} on ${overlap.length} path(s) ` +
        `(${overlap.slice(0, 5).join(', ')}${overlap.length > 5 ? ', …' : ''}) — an overlapping ` +
        `overtake would seed new conflicts into the holder's rebuild`,
    );
    return 2;
  }
  // re-verdict INSIDE the mutate against the freshened base — a head that resumed
  // (cleared HOLDING) or was displaced mid-overtake aborts the write cleanly.
  let pastSlug = pre.head.slug;
  const mutated = mutateQueue(
    MAIN,
    `coord(queue): overtake — ${slug} past HOLDING head`,
    (entries, audit) => {
      const v = overtakeVerdict({
        entries,
        auditLines: audit,
        overtaker: slug,
        nowMs: Date.parse(nowIso()),
      });
      if (!v.ok) throw Object.assign(new Error(`overtake aborted: ${v.reason}`), { refusal: true });
      // review 2275 F1: the path-disjointness proof above was computed against
      // pre.head's branch SPECIFICALLY — if the head changed between the pre-check and
      // this mutate (the old head landed and was pruned, resumed, or was itself
      // displaced) the re-verdict may pass against a DIFFERENT head whose diff was
      // never probed. Refuse instead: a fresh `overtake` run re-proves disjointness
      // against whoever holds the head now.
      assertHeadUnchanged({
        verb: 'overtake',
        preHead: pre.head,
        reHead: v.head,
        proof: 'path-disjointness',
      });
      pastSlug = v.head.slug;
      const r = applyOvertake(entries, slug, nowIso());
      return { entries: r.entries, auditLines: [...audit, r.auditLine] };
    },
  );
  const payload = { slug, past: pastSlug, ...positionPayload(mutated.entries, slug) };
  console.log(
    flags.json === true
      ? JSON.stringify(payload)
      : `overtook HOLDING head ${pastSlug}: ${slug} now at position ${payload.position}/${payload.total} ` +
          `(holder retains position 2 and resumes when ${slug} dequeues)`,
  );
  return 0;
}

// ── plan 2331: reap ──────────────────────────────────────────────────────────────────
// A mechanical, non-destructive dequeue of a provably-dead head — see the header
// comment on reapVerdict (landing-queue-lib.mjs) and the file-header usage doc above
// for the full rationale and the arm-then-fire grace. Structure mirrors demote: a
// clean pre-verdict on the fresh cross-PC view (refusal without a write for the hard
// cases), the board 🟢 LANDING gate, then a SINGLE mutateQueue call whose transform
// re-verifies everything against the freshened base and decides — via closure-capture
// (the F-008 class fix demote/steal already apply) — whether this invocation arms,
// fires, or is a clean no-op (coordWrite's own no-op short-circuit makes a "grace still
// pending" re-verify inside the mutate free of any actual commit).
// plan 3450: `ghost`/`report` mean exactly what they mean on cmdDemote above — the sweep asks
// this verb as a hypothetical tail waiter (verdict view only; the mutation still runs on the
// real entries), and `report` carries the arm/fire/refuse outcome back to the sweep, which is
// the one caller that must distinguish "armed" from "refused" without reading console text.
function cmdReap({ MAIN, slug, flags, ghost = false, report = null }) {
  const staleMin = flags['stale-min'] != null ? Number(flags['stale-min']) : DEFAULT_REAP_STALE_MIN;
  const graceMin = flags['grace-min'] != null ? Number(flags['grace-min']) : DEFAULT_REAP_GRACE_MIN;
  if (!Number.isFinite(staleMin) || staleMin <= 0) {
    console.error(
      `landing-queue: --stale-min must be a positive number (got "${flags['stale-min']}")`,
    );
    return 5;
  }
  if (!Number.isFinite(graceMin) || graceMin <= 0) {
    console.error(
      `landing-queue: --grace-min must be a positive number (got "${flags['grace-min']}")`,
    );
    return 5;
  }
  const fresh = readVerdictBase(MAIN, 'reap');
  // plan 3450 review F2: same fail-closed report as cmdDemote — "could not judge" reaches the
  // sweep's outcome channel, so it can never be collapsed into a clean nothing-to-do.
  if (fresh.refusal) {
    report?.({ outcome: 'unjudgeable', head: null, reason: fresh.refusal });
    reportPreVerdictRefusal(fresh.refusal);
    return 2;
  }
  // prune landed orphans first (same as demote/status) — a landed head is reaped by
  // the next mutate's own prune, not by this verb; the verdict must judge the LIVE queue.
  // plan 3459: at the pinned snapshot; an unjudgeable axis reaches the `unjudgeable` channel
  // rather than becoming a verdict over an unpruned queue.
  const live = livePrune('reap', fresh);
  if (live.refusal) {
    report?.({ outcome: 'unjudgeable', head: null, reason: live.refusal });
    reportPreVerdictRefusal(live.refusal);
    return 2;
  }
  const freshLive = live.entries;
  const pre = reapVerdict({
    entries: ghost ? withGhostWaiter(freshLive) : freshLive,
    waiter: slug,
    nowMs: Date.parse(nowIso()),
    staleMin,
    graceMin,
  });
  // Hard refusal (empty queue / caller is head / not queued behind / fresh heartbeat /
  // HOLDING head) — clean, no write, mirrors demote/steal.
  if (!pre.ok && !pre.armed) {
    console.error(`REFUSED — ${pre.reason}`);
    return 2;
  }
  let preLanding;
  try {
    preLanding = headLandingRows(fresh.source, pre.head.slug, 'reap');
  } catch (e) {
    if (!e?.refusal) throw e;
    report?.({ outcome: 'unjudgeable', head: pre.head.slug, reason: e.message });
    reportPreVerdictRefusal(e.message);
    return 2;
  }
  if (preLanding.length) {
    console.error(
      `REFUSED — head ${pre.head.slug} is heartbeat-stale (age ${pre.ageMin ?? '?'}m) but holds the ` +
        `🟢 LANDING mutex on row(s) ${preLanding.join(', ')} — it is actively mid-land (a long ` +
        `merge-step battery outlives the last spine heartbeat, or it is LAND_BLOCKED_HOLDING and ` +
        `keeps its row); not reap-eligible.`,
    );
    return 2;
  }
  // Already armed with grace still pending → nothing to write; refuse cleanly without
  // ever touching mutateQueue (avoids a pointless fetch+checkout on every wait-loop poll
  // during the common "still waiting out the grace" state).
  if (pre.armed && pre.head.reapArmedIso && !pre.ok) {
    console.error(`REFUSED — ${pre.reason}`);
    return 2;
  }
  // Either needs arming (pre.armed && !pre.head.reapArmedIso) or fires (pre.ok) — both
  // funnel through ONE mutateQueue call, re-verifying from scratch against the
  // freshened base (the demote/steal mid-mutate-abort pattern).
  let outcome = 'refused'; // 'armed' | 'fired' | 'refused'
  // plan 3450 review F2: was this run's `refused` a VERDICT, or a fail-closed read that could
  // not judge at all? Re-set on every transform run (it re-runs per coordWrite attempt), so it
  // always describes the run whose result was returned.
  let unjudgeable = false;
  let vHead = pre.head;
  let vAgeMin = pre.ageMin;
  let vArmAgeMin = pre.armAgeMin ?? null;
  let vReason = pre.reason;
  const mutated = mutateQueue(
    MAIN,
    `coord(queue): reap — waiter ${slug}`,
    (entries, audit, _mainDir, source) => {
      // plan 2603: refs re-read inside the mutate (same rule as steal/demote) — a mid-reap
      // ping now lands in the ref namespace, not in the doc coordWrite just freshened.
      // Verdict-only decoration; applyReap/armReapEntry act on the undecorated entries.
      unjudgeable = false;
      const rv = decorateForReverdict(MAIN, 'reap', entries);
      if (rv.refusal) {
        outcome = 'refused';
        unjudgeable = true;
        vReason = rv.refusal;
        return { entries, auditLines: audit };
      }
      const v = reapVerdict({
        entries: ghost ? withGhostWaiter(rv.entries) : rv.entries,
        waiter: slug,
        nowMs: Date.parse(nowIso()),
        staleMin,
        graceMin,
      });
      if (v.head) {
        vHead = v.head;
        vAgeMin = v.ageMin;
        vArmAgeMin = v.armAgeMin ?? null;
      }
      vReason = v.reason;
      if (!v.ok && !v.armed) {
        outcome = 'refused'; // head heartbeated / went HOLDING / etc. mid-reap
        return { entries, auditLines: audit };
      }
      const landing = headLandingRowsInMutate('reap', source, v.head.slug);
      if (landing.length) {
        outcome = 'refused';
        vReason = `head ${v.head.slug} went 🟢 LANDING mid-reap (row(s) ${landing.join(', ')}) — actively mid-land`;
        return { entries, auditLines: audit };
      }
      if (v.ok) {
        outcome = 'fired';
        const r = applyReap(entries, slug, nowIso(), v.ageMin, v.armAgeMin);
        return { entries: r.entries, auditLines: [...audit, r.auditLine] };
      }
      // v.armed && !v.ok
      if (!v.head.reapArmedIso) {
        outcome = 'armed';
        return { entries: armReapEntry(entries, v.head.slug, nowIso()), auditLines: audit };
      }
      // race: someone else armed it between our pre-check and this mutate, grace still
      // pending — no-op (coordWrite's diff-cached check makes this free of a commit).
      outcome = 'refused';
      return { entries, auditLines: audit };
    },
  );
  if (outcome === 'fired') {
    // plan 2603: same ref retirement as the steal path — the reaped entry no longer
    // exists, so neither should its heartbeat ref. Best-effort by the same rule.
    deleteHeartbeatRef(MAIN, vHead.slug);
    const newHead = headOf(mutated.entries);
    // plan 3450 review F5: ghost-aware, exactly as in cmdDemote — the sweep is not a queue
    // member, so it has no position for this payload to report.
    const payload = { reaped: vHead.slug, ...callerPositionPayload(mutated.entries, slug, ghost) };
    console.log(
      flags.json === true
        ? JSON.stringify(payload)
        : `reaped head slot: ${vHead.slug} removed (heartbeat age ${vAgeMin ?? '?'}m, armed ${vArmAgeMin ?? '?'}m ago); ` +
            `${newHead ? newHead.slug : '(queue now empty)'} promoted to head`,
    );
    report?.({ outcome: 'reaped', head: vHead.slug, ageMin: vAgeMin });
    return 0;
  }
  if (outcome === 'armed') {
    console.error(
      `REFUSED — armed: head ${vHead.slug} reap ARMED (heartbeat age ${vAgeMin ?? '?'}m > ${staleMin}m) — ` +
        `fires after a ${graceMin}m grace`,
    );
    report?.({ outcome: 'armed', head: vHead.slug, ageMin: vAgeMin });
    return 2;
  }
  console.error(`REFUSED — ${vReason}`);
  report?.({
    outcome: unjudgeable ? 'unjudgeable' : 'refused',
    head: vHead?.slug ?? null,
    reason: vReason,
  });
  return 2;
}

// ── plan 3450: the waiter-independent sweep ──────────────────────────────────────────
// The incident this closes (2026-08-25): head 3435 and its sole waiter 3424 were both dead
// cloud sessions. Every threshold was crossed, and nothing ran the verdicts — demote/steal/
// reap fire ONLY from inside a live waiter's landing-queue-watch poll loop, so a queue whose
// live sessions have all died has no process left to evict anything. It cleared 65 minutes
// later only because an unrelated local session happened to enqueue.
//
// Two paths, one mechanism (`sweepQueueHead` below), both asking the EXISTING verdicts as the
// ghost caller (see SWEEP_CALLER in landing-queue-lib.mjs):
//   A. every queue MUTATE piggybacks a sweep (maybeSweepAfterMutate) — so any new arrival
//      immediately evicts or arms, instead of waiting for its own watcher's first poll. This
//      closes "somebody new arrives behind a dead head", NOT "nobody ever arrives".
//   C. `landing-queue.mjs sweep` is the answer to the second half: a verb no queue member has
//      to be alive to run, safe from any checkout, idempotent, exit 0 on nothing-to-do.
//      Scheduled every ~10 min on the always-on local host.
// The sweep performs NO steal: a steal REMOVES an entry on a `--confirm-holder-gone`
// assertion (or a same-host pid proof) that an unattended process cannot make. `reap` was
// built for exactly this cross-host corpse and keeps its arm-then-fire grace.

// A mutate-path sweep costs two origin round trips (readFresh), so the bursty flagless
// heartbeat — the call plan 2603 moved OFF coordWrite precisely to make it cheap — sweeps at
// most this often per checkout-family. `enqueue` is rare and always sweeps: a fresh arrival
// behind a dead head is the exact incident shape, and making it wait out a throttle window
// would reintroduce the delay this plan removes. Override with LQ_SWEEP_THROTTLE_MIN (0 =
// every heartbeat, the test setting); LQ_NO_MUTATE_SWEEP=1 disables the piggyback entirely.
//
// ── Why this is a THROTTLE and not a LOCK ────────────────────────────────────────────
// Two sweeps running at once is SAFE, so nothing here tries to exclude them. The exclusion
// that matters already exists one layer down, and it is a real one:
//   • Every queue mutation goes through the queue-ref CAS, which serializes writers and RE-RUNS the
//     transform (and therefore the verdict) against the freshened base on every attempt. A
//     second sweep that took its verdict from a stale read cannot commit it — the re-verdict
//     inside the mutate refuses on the queue that actually exists.
//   • The sweep is idempotent. Its two rungs are demote (moves a stale head to the tail) and
//     reap (arm, then remove). Run twice against a head that has already been evicted, both
//     verdicts simply refuse: the head is no longer the head.
//   • DEMOTE_CAP bounds the repeats that could matter — a slug cannot be auto-demoted more
//     than twice in 24h however many processes ask.
// So this stamp buys exactly one thing: it bounds the COST (two origin round trips per sweep)
// of the bursty heartbeat path. A read-then-write timestamp file is the right shape for that
// and the wrong shape for mutual exclusion — do not grow it into a lease.
const SWEEP_THROTTLE_MIN = 5;

function sweepStampPath(mainDir) {
  return join(resolveCommonDirPath({ anchor: mainDir }), 'landing-queue-sweep.json');
}

// `lastSweepIso` — the SUCCESS stamp: a sweep that actually judged the head. Round 2's G5 moved
// this to AFTER the verdicts, so a sweep that could not judge (an unreadable heartbeat-ref
// namespace, an origin read that blipped) leaves it untouched and the very next mutate retries
// immediately instead of buying the wedge five more minutes of immunity.
function readSweepStamp(mainDir) {
  try {
    const st = JSON.parse(readFileSync(sweepStampPath(mainDir), 'utf8'));
    return st && typeof st === 'object' ? st : {};
  } catch {
    return {};
  }
}

function writeSweepStamp(mainDir, state) {
  try {
    writeFileSync(sweepStampPath(mainDir), `${JSON.stringify(state)}\n`);
  } catch {
    /* best-effort: a lost stamp costs one extra sweep, never a failed caller */
  }
}

// Throttle state is best-effort and fails OPEN (sweep) in both directions: an unreadable
// stamp means "no record of a recent sweep", and a failed write only costs one extra sweep.
// It must never be able to fail a heartbeat or an enqueue.
function sweepThrottleElapsed(mainDir, nowMs, throttleMin) {
  if (throttleMin <= 0) return true;
  const last = Date.parse(readSweepStamp(mainDir).lastSweepIso);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= throttleMin * 60_000;
}

function stampSweepRun(mainDir, iso) {
  writeSweepStamp(mainDir, { lastSweepIso: iso });
}

// The ghost verbs print their own operator-facing text (six call sites each, all of them the
// right words for a HUMAN who typed `demote`/`reap`). The sweep is not that caller: it wants
// ONE line, and on the piggyback path usually none at all. Capturing is deliberately
// preferred over threading a printer through both verbs — their messages are the reviewed,
// long-standing wording, and a second output mode is a second thing to drift.
function withCapturedConsole(fn) {
  const lines = [];
  const push =
    (stream) =>
    (...a) =>
      lines.push({ stream, text: a.join(' ') });
  const origLog = console.log;
  const origErr = console.error;
  console.log = push('out');
  console.error = push('err');
  try {
    return { code: fn(), lines };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

// Ask the two eviction verdicts as the ghost tail waiter, demote first (it MOVES the head and
// is the lighter remedy) and reap only when demote declines — the same ladder a live waiter's
// watcher walks. Returns the outcome plus the verbs' own captured text. Never throws: a
// verdict abort inside a mutate is a refusal like any other, and this runs on paths (a
// heartbeat, an enqueue) that are contractually exit-0.
// The ghost verbs get a DELIBERATELY MINIMAL flag set — the caller's own flags (an enqueue's
// `--lane`/`--priority`, a `--json`, an `--operator-override`) are never forwarded into a
// verdict they were not typed for. Only `--host` rides through: it is the probing host for
// demote's IN_LAND pid check, and a wrong one silently disables that probe.
// plan 3450 review F2: `outcome: 'none'` means "the head was JUDGED and nothing was eligible"
// — a healthy queue. Two other things used to arrive here wearing that same word, and both are
// the opposite of healthy: a fail-closed read refusal (the heartbeat-ref namespace or
// origin/master unreadable, so this run proved nothing about the head) and an unexpected
// internal error. A scheduled sweep reporting either as a clean no-op is precisely how the
// wedge this plan exists to close would go unnoticed again — so they ride out on `refusal`,
// which the standalone verb turns into exit 2 and the piggyback logs to stderr.
function sweepQueueHead(MAIN, { host } = {}) {
  const flags = host != null ? { host } : {};
  let outcome = null;
  const report = (o) => {
    outcome = o;
  };
  const unjudged = [];
  const run = (verb, fn) => {
    try {
      const r = withCapturedConsole(fn);
      // A verdict that could not be taken (the verb reported it on the outcome channel) is
      // NOT this ladder's outcome — clear it so the next rung, and the final `none`, are not
      // decided by a refusal that judged nothing.
      if (outcome?.outcome === 'unjudgeable') {
        unjudged.push(`${verb}: ${outcome.reason}`);
        outcome = null;
      }
      return r;
    } catch (e) {
      // An unexpected throw (code 5) is never a verdict; a `refusal:true` throw is one UNLESS
      // it is the in-mutate fail-closed read, which marks itself `unjudgeable`.
      if (!e.refusal || e.unjudgeable) unjudged.push(`${verb}: ${e.message}`);
      return {
        code: e.refusal ? 2 : 5,
        lines: [{ stream: 'err', text: `REFUSED — ${e.message}` }],
      };
    }
  };
  // plan 3450 review round 2 (G2): the unjudged list is the run's refusal channel, and it is
  // read on EVERY exit — not only the `none` one. A demote that threw an unexpected internal
  // error (a coord-write fault, a collision assert) followed by a reap that happened to work
  // used to return `refusal: null`, so a scheduled sweep recorded a clean success over a rung
  // that had proved nothing. An eviction and an unjudgeable stage are not mutually exclusive:
  // the payload reports both, the action on `action`/`target` and the failure here.
  const refusalOf = () => (unjudged.length ? unjudged.join('; ') : null);
  const demote = run('demote', () =>
    cmdDemote({ MAIN, slug: SWEEP_CALLER, flags, ghost: true, report }),
  );
  if (demote.code === 0 && outcome) {
    return { ...outcome, lines: demote.lines, refusal: refusalOf() };
  }
  const reap = run('reap', () => cmdReap({ MAIN, slug: SWEEP_CALLER, flags, ghost: true, report }));
  const lines = [...demote.lines, ...reap.lines];
  if (outcome && (outcome.outcome === 'reaped' || outcome.outcome === 'armed')) {
    return { ...outcome, lines, refusal: refusalOf() };
  }
  return {
    outcome: 'none',
    head: null,
    lines,
    refusal: refusalOf(),
  };
}

// The board-row corpse — a stranded 🟢 LANDING row whose session died — is the SIBLING of
// the wedge above and was a second stage of this sweep in the first cut. It was removed:
// plan 3443 ships the reaper for that class (board-lib.mjs's landingRowReapVerdict, driven
// by queue-drain.mjs reapRowIfStale), and two independent reapers for one mutex is debt.
// This verb owns the QUEUE half only.

// The piggyback (Phase A). Wrapped so it can NEVER fail its caller: enqueue reports a
// position the operator is waiting on, and a heartbeat is contractually idempotent/exit-0.
//
// `entries` — when the caller has just written the queue and therefore already holds it — buys
// the common case for FREE: if the head is not even LOCALLY eligible for a demote or a reap,
// there is nothing for a sweep to do and its two origin round trips are pure waste. The
// predicates are the exported ones the waiter-side pre-checks already use (plan 2334/2485), so
// the boundary minute and both demote axes cannot drift from the real verdicts. The direction
// is the safe one in both readings: the doc's cells are a LOWER bound on the effective stamps
// (decorateWithHeartbeatRefs folds the refs by max), so "doc says fresh" ⇒ genuinely fresh
// ⇒ skipping is correct, while "doc says stale" may still be a live head — and that only costs
// a sweep whose own fail-closed verdict then refuses.
function maybeSweepAfterMutate(MAIN, flags, source, entries = null) {
  if (process.env.LQ_NO_MUTATE_SWEEP === '1') return;
  try {
    const now = nowIso();
    if (entries) {
      const head = headOf(entries);
      const nowMs = Date.parse(now);
      const worthIt =
        head &&
        (demoteLocallyEligible({
          headHeartbeatIso: head.heartbeatIso,
          nowMs,
          headState: head.state ?? null,
          headProgressIso: head.progressIso ?? null,
        }) ||
          reapLocallyEligible({
            headState: head.state ?? null,
            headHeartbeatIso: head.heartbeatIso,
            nowMs,
          }));
      if (!worthIt) return;
    }
    const throttleMin =
      process.env.LQ_SWEEP_THROTTLE_MIN != null
        ? Number(process.env.LQ_SWEEP_THROTTLE_MIN)
        : SWEEP_THROTTLE_MIN;
    // `enqueue` always sweeps (see SWEEP_THROTTLE_MIN's header); the bursty heartbeat waits
    // out the window. A non-numeric override falls back to the default rather than to 0 —
    // a typo must not turn every heartbeat into two origin round trips.
    const forced = source === 'enqueue';
    if (
      !forced &&
      !sweepThrottleElapsed(
        MAIN,
        Date.parse(now),
        Number.isFinite(throttleMin) ? throttleMin : SWEEP_THROTTLE_MIN,
      )
    ) {
      return;
    }
    const r = sweepQueueHead(MAIN, { host: flags?.host });
    // plan 3450 review round 2 (G5): the throttle stamp is the record of a sweep that actually
    // JUDGED the head, so it is written AFTER the verdicts and only when they succeeded.
    // Stamping first meant one transient fault — an unreadable heartbeat-ref namespace, an
    // origin read that blipped — bought the wedge five more minutes of immunity from every
    // heartbeat-triggered retry, which is the opposite of what a failed sweep should cost.
    if (!r.refusal) stampSweepRun(MAIN, now);
    // plan 3450 review F2: this path keeps its never-fail-the-caller wrap by design (an
    // enqueue reports a position the operator is waiting on), but a sweep that could not JUDGE
    // the head must not be silently swallowed as well as tolerated — say so on stderr and let
    // the caller's own exit code stand.
    if (r.refusal) {
      console.error(
        `landing-queue: ${source} sweep could not judge the head (non-fatal, the ${source} ` +
          `itself is unaffected): ${r.refusal}`,
      );
    }
    // Silent on the common "head is healthy" outcome — this rides every enqueue and every
    // throttled heartbeat, and a refusal line per call would bury the caller's own report.
    // An actual eviction is loud: it changed the FIFO order under everyone.
    if (r.outcome === 'none') return;
    console.error(
      `landing-queue: ${source} swept the head — ${r.outcome}${r.head ? ` ${r.head}` : ''} ` +
        `(plan 3450: the verdicts run on every mutate, not only inside a live waiter's watcher)`,
    );
    for (const l of r.lines) console.error(`  ${l.text}`);
  } catch (e) {
    console.error(`landing-queue: mutate-path sweep failed (non-fatal): ${e.message}`);
  }
}

// `sweep` (Phase C): the ghost caller as a first-class verb. Exit 2 ONLY when this run COULD
// NOT JUDGE the head — the fail-closed read refusals (an unreadable heartbeat-ref namespace /
// an unfetchable origin), whether they surface in this function's own pre-reads or one layer
// deeper inside the ghost verbs, plus any unexpected internal error there (plan 3450 review
// F2: those used to arrive as a clean `none`). Everything else — a healthy head, a starvation
// cap, a 🟢 LANDING row, an IN_LAND head, a reap still waiting out its grace — is
// nothing-to-do and exits 0 with the reason reported.
function cmdSweep({ MAIN, flags }) {
  // The fail-closed gate FIRST and on its own: the ghost verbs below apply it too, but they
  // report it as an ordinary refusal, and "I could not read the heartbeat namespace" must not
  // be reported to a scheduled task as "nothing to do".
  const base = readVerdictBase(MAIN, 'sweep');
  if (reportPreVerdictRefusal(base.refusal)) return 2;
  // plan 3459: the landed-ness axes get the same treatment, and HERE — before the ladder's
  // mutates run — so an unjudgeable prune refuses at the top rather than surfacing three
  // steps later as a report about a queue this run was never able to judge.
  if (reportPreVerdictRefusal(livePrune('sweep', base).refusal)) return 2;
  // Steps 1+2 under ONE prune accounting scope (review round 2, G1): the eviction ladder's own
  // mutates prune landed orphans too, and `pruned` below must be the total this sweep removed.
  // The standalone verb never checks the throttle — a scheduled sweep always runs, by design.
  const { result: swept, pruned: prunedTotal } = withPruneAccounting(() => {
    // Step 1: persist the landed-orphan prune (mutateQueue prunes before every transform;
    // an unchanged doc is a no-op on the ref, so this is free when there is nothing to reap).
    mutateQueue(MAIN, 'coord(queue): sweep — prune landed orphans', (e, a) => ({
      entries: e,
      auditLines: a,
    }));
    // Step 2: the eviction ladder, asked as the ghost tail waiter.
    return sweepQueueHead(MAIN, { host: flags.host });
  });
  // Step 3: re-read, so the reported head/queue describe the POST-eviction queue.
  const after = readVerdictBase(MAIN, 'sweep');
  if (reportPreVerdictRefusal(after.refusal)) return 2;
  // The same orphan filter `status` and every eviction verb use — this verb reads the queue
  // the way the rest of the CLI does. plan 3459: at the pinned snapshot, and a fault refuses
  // on the `unjudgeable` channel rather than reporting a post-sweep queue it could not judge.
  const live = livePrune('sweep', after);
  if (live.refusal) {
    reportPreVerdictRefusal(live.refusal);
    return 2;
  }
  const liveEntries = live.entries;
  const payload = {
    action: swept.outcome,
    // plan 3450 review F4: `head` is the head AFTER this sweep, always — it used to prefer the
    // slug the eviction ladder returned, which on a demote is the entry that was just moved
    // OFF the head, so the report said "head now dead-head" while dead-waiter held the slot.
    head: headOf(liveEntries)?.slug ?? null,
    // The slug the action applied to, named separately: the demoted or reaped entry, or (on
    // `armed`) the head the reap was armed against, which is still head and not yet evicted.
    // null when there was nothing to do.
    target: swept.outcome === 'none' ? null : (swept.head ?? null),
    queued: liveEntries.length,
    // plan 3450 review F3: the number of landed orphans actually removed. It used to report the
    // SURVIVING entries, so a two-entry queue with nothing to clean up claimed `pruned: 2`.
    // Review round 2 (G1): summed across EVERY mutate this sweep performed, not just step 1's —
    // an entry that lands mid-sweep is removed by the eviction ladder's own nested prune.
    pruned: prunedTotal,
    // plan 3450 review F2: non-null only when this run could not judge the head (a fail-closed
    // read, or an unexpected internal error) — the exit-2 case below, surfaced in the payload
    // so a --json consumer sees it without parsing stderr.
    refusal: swept.refusal ?? null,
  };
  if (flags.json === true) {
    console.log(JSON.stringify(payload));
  } else {
    console.log(
      `sweep: ${swept.outcome === 'none' ? 'no eviction' : `${swept.outcome} ${payload.target}`}; ` +
        `head now ${payload.head ?? 'none'} (${payload.queued} queued, ${payload.pruned} pruned)`,
    );
    for (const l of swept.lines) console.error(`  ${l.text}`);
  }
  // plan 3450 review F2: the head could not be judged — the same class as the pre-verdict
  // refusals above, reached one layer deeper (the ghost verbs' own reads, or an unexpected
  // error inside them). A scheduled task must see this run as a failure, never as a clean
  // no-op with a wedged head still sitting at the front of the queue.
  if (swept.refusal) {
    console.error(
      `REFUSED — sweep could not judge the queue head: ${swept.refusal}.` +
        // review round 2 (G2): a rung can now fail while a LATER one still evicts, so this line
        // reports what actually happened rather than always claiming a no-op.
        (payload.target
          ? ` A later rung did act (${payload.action} ${payload.target}), but this run left a ` +
            `stage unjudged — re-run it.`
          : ` The queue was NOT swept; nothing was evicted.`),
    );
    return 2;
  }
  // plan 3450 review round 2 (G5): stamped LAST and only on a completed judgement. A sweep that
  // refused above leaves the throttle untouched, so the next heartbeat is free to retry instead
  // of skipping the wedge for five more minutes on the strength of a run that proved nothing.
  stampSweepRun(MAIN, nowIso());
  return 0;
}

// The command registry — the ONE place a command exists. Dispatch, the two CLI
// error messages, and the --json hint all derive from it, so a command cannot
// reach the dispatcher without also reaching every help string (plan 2061:
// demote was dispatched but unlisted; the review of the first fix showed a
// parallel COMMANDS array just moves that drift one level up and fails closed).
// json: accepts --json for machine-readable output (must match the handler's
// actual flags.json use). needsSlug: first positional is a required <slug>.
// writesSlug: this verb can CREATE an entry for <slug>, so the reserved-name guard
// (reservedSlugRefusal — plan 3450 review F6) refuses it here with a friendly exit 5 instead of
// letting the write seam's own assert (landing-queue-lib's assertWritableSlug, review round 2
// G4) throw at it. The seam is the ENFORCEMENT — every writer inherits it; this table is the
// good error message for a human who typed the verb.
// Deliberately not on every needsSlug verb: dequeue/heartbeat/demote of a name that can never
// exist is already a harmless no-op, and refusing there would only add a second error shape.
// plan 3973 D4: the ONE bounded heal across the transport cut-over (see the usage header), and
// the ONLY thing that ever bootstraps the queue ref deliberately.
//
// THE FOLD AND THE TOMBSTONE ARE ONE coordWrite. The master doc that gets folded is the very
// copy the same commit replaces with the tombstone (`coordWrite` freshens master and RE-RUNS
// its mutate on every attempt, so a rebase re-reads and re-folds). Reading master once up front
// and tombstoning it in a second, unconditional write is how an old-code entry written inside
// that window was folded nowhere and then erased from master (plan 3973 review, keys 324e39 /
// 80c1b8 / cf62c3). The ref side of the fold is CAS and append-only, so re-running it is a
// no-op — which is what makes the enclosing retry safe.
//
//   ref ABSENT  → seed it WHOLESALE from that fresh master copy (a parentless CAS commit).
//   ref PRESENT → append the master rows and audit lines the ref lacks, in their order.
//   rows the REF has and master lacks (an old-code dequeue, or any new-code write since) are
//               never dropped — they are reported as a warning for the operator to dequeue
//               explicitly, because this heal cannot tell a stale ghost from a live waiter.
//   rows BOTH carry with different columns keep the REF's version (the ref is the live
//               transport); the warning names them with both spellings so nothing is silent.
//   the same rows in a different ORDER keep the REF's order — the ref is the live FIFO — and the
//               warning prints both orders slug-by-slug and names `overtake`/`demote` as the way
//               to re-apply an old-code reorder on the ref. Nothing is folded in this case.
//   a master doc that cannot be READ is a REFUSAL (exit 2), never "nothing to migrate": the heal
//               must not seed the ref from a document whose live waiters it never saw.
// Which rows are missing / changed / merely reordered comes from `masterDocDivergence`, the same
// comparator every reader's D4 refusal uses — never a second hand-rolled comparison here.
//
// `--no-tombstone` folds/seeds only and leaves master alone (no coordWrite at all).
// No silent merge anywhere else: every other reader refuses on a divergent master doc.
function cmdMigrate({ MAIN, flags }) {
  try {
    gitWithLockRetry(MAIN, ['fetch', '--quiet', 'origin', 'master']);
  } catch (e) {
    console.error(`landing-queue: migrate cannot fetch origin/master (${e.message}) — refusing`);
    return 2;
  }
  const master = readMasterQueueDoc(MAIN);
  const report = (payload, line) => {
    console.log(flags.json === true ? JSON.stringify(payload) : line);
    return 0;
  };
  if (master.state === 'fault') {
    // A master doc that could not be READ is not an absent one (plan 3973 review round 2, keys
    // 4f5837 / a9af40 / 0fc891). Reporting it as "nothing to migrate", exit 0, tells the operator
    // — and any automation that runs the heal off another verb's refusal — that the cut-over is
    // done while the ref is unseeded and every ordinary queue write still refuses.
    console.error(
      `landing-queue: migrate cannot read the pre-3973 queue doc` +
        `${master.rel ? ` (${master.rel})` : ''} at origin/master — ` +
        `${String(master.error?.message ?? master.error).trim()}. It may still carry live queue ` +
        `entries, so this heal refuses rather than seed the ref without them. Fix the object ` +
        `store / connectivity to origin (or coord.config.json) and re-run.`,
    );
    return 2;
  }
  if (master.state !== 'present') {
    return report(
      { migrated: false, reason: master.state, folded: 0, auditFolded: 0 },
      `migrate: nothing to migrate — the master doc is ${master.state === 'tombstone' ? 'already the tombstone' : 'absent'}`,
    );
  }
  // Through the accessor's ONE validator, not a bare `parseQueue` (plan 3973 review round 4, key
  // 4ba3a8): a master doc whose sentinels survived while the header did not parses to
  // `entries: []` without throwing, and this pre-check waving it through is what let the fold
  // find nothing and the tombstone discard its waiter.
  const masterCheck = validateQueueDoc(
    master.raw,
    `the pre-3973 queue doc (${master.rel}) at origin/master`,
    `git show origin/master:${master.rel}`,
  );
  if (masterCheck.fault) {
    console.error(
      `landing-queue: migrate cannot parse the master doc at ${master.rel}: ${masterCheck.fault.message}`,
    );
    return 5;
  }
  let folded = 0;
  let auditFolded = 0;
  let written = null;
  // One fold of ONE master-doc text onto the ref. Idempotent by construction (it only appends
  // what the ref lacks), so the enclosing coordWrite may re-run it on a rebase.
  const foldIntoRef = (masterRaw) => {
    // The pre-check validated the doc as origin/master had it; the copy this coordWrite attempt
    // is about to replace can be a different (and broken) one. Same validator, so a headerless
    // copy refuses here too instead of folding nothing and tombstoning a live waiter away.
    const v = validateQueueDoc(
      masterRaw,
      `the pre-3973 queue doc (${master.rel})`,
      `git show origin/master:${master.rel}`,
    );
    if (v.fault) {
      // Refuse legibly instead of aborting the write with a raw parser stack.
      throw Object.assign(
        new Error(
          `landing-queue: migrate cannot parse the master doc at ${master.rel}: ${v.fault.message}`,
        ),
        { migrateParse: true },
      );
    }
    const parsedMaster = v.parsed;
    folded = 0;
    auditFolded = 0;
    const refOnlySlugs = new Set();
    const changedRows = [];
    let reorder = null;
    written = mutateQueueRef(MAIN, {
      message: `coord(queue): migrate — fold ${master.rel} into ${QUEUE_REF} (plan 3973)`,
      loudFail: false,
      mutate: (doc, { source }) => {
        if (source !== 'ref') {
          // The ref is ABSENT: seed it wholesale from THIS master text (not from the accessor's
          // own origin/master read, which is a different — and staler — snapshot than the copy
          // the same coordWrite is about to tombstone).
          folded = parsedMaster.entries.length;
          auditFolded = parsedMaster.auditLines.length;
          return masterRaw;
        }
        const { entries, auditLines } = parseQueue(doc);
        // masterDocDivergence is THE comparator for "how do these two documents differ" (plan
        // 3973 review round 2, key bd6e60): the D4 refusal every READER prints and the heal that
        // answers it must never disagree about which rows are missing, changed or merely
        // reordered — a second, hand-rolled slug-map comparison here is one canonical-rendering
        // change away from folding a different set than the refusal named.
        const d = masterDocDivergence(parsedMaster, { entries, auditLines });
        const masterOnly = new Set(d.masterOnly);
        const masterRows = new Map(parsedMaster.entries.map((e) => [e.slug, renderQueueRow(e)]));
        const refRows = new Map(entries.map((e) => [e.slug, renderQueueRow(e)]));
        const missing = parsedMaster.entries.filter((e) => masterOnly.has(e.slug));
        const haveAudit = new Set(auditLines);
        const missingAudit = parsedMaster.auditLines.filter((l) => !haveAudit.has(l));
        refOnlySlugs.clear();
        for (const slug of d.refOnly) refOnlySlugs.add(slug);
        changedRows.length = 0;
        for (const slug of d.changed)
          changedRows.push({ slug, ref: refRows.get(slug), master: masterRows.get(slug) });
        // A different ORDER — an old-code `overtake`/`demote` that reordered the master table
        // (key 906a8e / 65fa01). The ref is the live FIFO and keeps ITS order, exactly as it
        // keeps its version of a changed row; but the heal is about to tombstone the master doc,
        // so the discarded order has to be SAID, with the two verbs that re-apply it on the ref
        // if it was deliberate.
        //
        // Reported on EITHER region's order flag and NEVER gated on the rest of the fold being
        // empty (plan 3973 review round 3, keys 9e10de / 35e276 / d80584 / 44d85f / 2ea1c8). The
        // old `!masterOnly && !refOnly && !changed` gate silenced exactly the cases that most
        // need saying: a master doc that both reordered the FIFO and carried one extra row or
        // one changed heartbeat cell discarded its order with no warning at all. And an
        // AUDIT-ONLY reorder is the one shape that reaches here with nothing to fold — set-based
        // `missingAudit` finds no missing line — while the shared comparator still counts it as
        // divergence, i.e. it is what sent the operator here via the D4 refusal.
        reorder =
          d.orderDiffers || d.auditOrderDiffers
            ? {
                rows: d.orderDiffers,
                audit: d.auditOrderDiffers,
                ref: entries.map((e) => e.slug),
                master: parsedMaster.entries.map((e) => e.slug),
              }
            : null;
        folded = missing.length;
        auditFolded = missingAudit.length;
        if (!missing.length && !missingAudit.length) return doc;
        return renderQueue(doc, [...entries, ...missing], [...auditLines, ...missingAudit]);
      },
    });
    if (refOnlySlugs.size) {
      console.error(
        `landing-queue: migrate WARNING — ${QUEUE_REF} carries entr${refOnlySlugs.size === 1 ? 'y' : 'ies'} ` +
          `${[...refOnlySlugs].join(', ')} that ${master.rel} does not. They are KEPT (this heal ` +
          `cannot tell an old-code dequeue from a live waiter); dequeue any that are dead with ` +
          `\`node scripts/landing-queue.mjs dequeue <slug>\`.`,
      );
    }
    for (const c of changedRows) {
      console.error(
        `landing-queue: migrate WARNING — row ${c.slug} differs between the two transports; the ` +
          `ref's version is kept.\n  ref:    ${c.ref}\n  master: ${c.master}`,
      );
    }
    if (reorder) {
      const what =
        reorder.rows && reorder.audit
          ? 'row order and audit-line order'
          : reorder.rows
            ? 'row order'
            : 'audit-line order';
      console.error(
        `landing-queue: migrate WARNING — the two transports differ in ${what}; the ref's order ` +
          `is KEPT and ${master.rel}'s is discarded with the tombstone.\n` +
          (reorder.rows
            ? `  ref (kept): ${reorder.ref.join(', ')}\n  master:     ${reorder.master.join(', ')}\n`
            : '') +
          // The remediation is ROW-order advice, so an audit-only divergence gets its own line
          // (plan 3973 review round 4, keys 00891a / cad6ef): `overtake`/`demote` move queue
          // ROWS, and following them for a reshuffled audit region would change the live FIFO
          // over history that carries no FIFO meaning at all.
          (reorder.rows
            ? `  The ref is the live FIFO. If the master order was a deliberate old-code reorder, ` +
              `re-apply it on the ref with \`node scripts/landing-queue.mjs overtake <slug>\` / ` +
              `\`demote <slug>\` — this heal never reorders the live queue on its own.`
            : `  Audit lines are append-only history, not FIFO order: nothing to re-apply, and no ` +
              `queue verb reorders them.`),
      );
    }
  };

  let tombstoned = false;
  try {
    if (flags['no-tombstone'] === true) {
      foldIntoRef(master.raw);
    } else {
      const queueRel = queueRelFor(MAIN);
      withCoordCheckout(MAIN, (cdir) => {
        coordWrite(cdir, {
          relPaths: [queueRel],
          tool: 'landing-queue',
          message: `coord(queue): migrate — fold + tombstone ${queueRel} (moved to ${QUEUE_REF}, plan 3973)`,
          mutate: () => {
            // The FRESH master copy this attempt is about to replace — read inside the mutate so
            // an old-code write that landed since the pre-check is folded, not erased.
            const fresh = readFileSync(join(cdir, queueRel), 'utf8');
            if (!isQueueTombstone(fresh)) foldIntoRef(fresh);
            writeFileSync(join(cdir, queueRel), QUEUE_TOMBSTONE);
          },
        });
      });
      tombstoned = true;
    }
  } catch (e) {
    if (!e?.migrateParse) throw e;
    console.error(e.message);
    return 5;
  }
  if (written === null) {
    // The master doc turned into the tombstone between the pre-check and the coordWrite: a
    // sibling migrated first, and there is nothing left to fold.
    return report(
      { migrated: false, reason: 'tombstone', folded: 0, auditFolded: 0, tombstoned },
      `migrate: nothing to migrate — the master doc is already the tombstone`,
    );
  }
  return report(
    {
      migrated: true,
      folded,
      auditFolded,
      bootstrapped: written.bootstrapped,
      queueSha: written.sha,
      attempts: written.attempts,
      tombstoned,
    },
    `migrate: ${written.bootstrapped ? `bootstrapped ${QUEUE_REF} from ${master.rel}` : `folded ${folded} entr${folded === 1 ? 'y' : 'ies'} + ${auditFolded} audit line(s) into ${QUEUE_REF}`}` +
      ` (${written.sha.slice(0, 10)}, attempt ${written.attempts})` +
      (tombstoned
        ? `; ${master.rel} tombstoned on master`
        : `; master doc left as is (--no-tombstone)`),
  );
}

const COMMANDS = {
  // Null prototype: a cmd like "constructor" or "toString" must miss, not resolve
  // an inherited Object.prototype member and crash past the unknown-command guard.
  __proto__: null,
  status: { json: true, run: cmdStatus },
  enqueue: { json: true, needsSlug: true, writesSlug: true, run: cmdEnqueue },
  dequeue: { needsSlug: true, run: cmdDequeue },
  requeue: { json: true, needsSlug: true, writesSlug: true, run: cmdRequeue },
  reenter: { json: true, needsSlug: true, writesSlug: true, run: cmdReenter },
  heartbeat: { needsSlug: true, run: cmdHeartbeat },
  steal: { needsSlug: true, run: cmdSteal },
  demote: { json: true, needsSlug: true, run: cmdDemote },
  'mark-holding': { json: true, needsSlug: true, run: cmdMarkHolding },
  'mark-in-land': { json: true, needsSlug: true, run: cmdMarkInLand },
  overtake: { json: true, needsSlug: true, run: cmdOvertake },
  reap: { json: true, needsSlug: true, run: cmdReap },
  // plan 3450: the one verb with NO slug — the sweep is a ghost caller, not a queue member.
  sweep: { json: true, run: cmdSweep },
  // plan 3973: the transport cut-over heal — no slug either.
  migrate: { json: true, run: cmdMigrate },
};

function main() {
  const { cmd, positionals, flags } = parseQueueArgs(process.argv.slice(2));
  if (!cmd) {
    console.error(`landing-queue: no command (${Object.keys(COMMANDS).join('|')})`);
    return 5;
  }
  const spec = COMMANDS[cmd];
  if (!spec) {
    const jsonNames = Object.keys(COMMANDS)
      .filter((c) => COMMANDS[c].json)
      .join('/');
    console.error(
      `landing-queue: unknown command "${cmd}" (valid: ${Object.keys(COMMANDS).join('|')}; ` +
        `${jsonNames} accept --json for machine-readable output)`,
    );
    return 5;
  }
  const MAIN = resolveMain();
  const slug = positionals[0];
  if (spec.needsSlug && !slug) {
    console.error(`landing-queue: "${cmd}" needs a <slug>`);
    return 5;
  }
  // plan 3450 review F6: refuse a reserved (ghost-shaped) name at the ONE place every
  // entry-creating verb passes through, so the sweep's collision assert can never be reached
  // by a queue this CLI itself wrote. Exit 5 — a malformed request, not a refused verdict.
  if (spec.writesSlug) {
    const reserved = reservedSlugRefusal(slug);
    if (reserved) {
      console.error(`landing-queue: ${reserved}`);
      return 5;
    }
  }
  return spec.run({ MAIN, slug, positionals, flags });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error('landing-queue:', e.message);
    process.exit(e.refusal ? 2 : 5);
  }
}
