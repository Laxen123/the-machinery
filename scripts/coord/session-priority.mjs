#!/usr/bin/env node
// scripts/session-priority.mjs — "what scheduling class is THIS session?" (plan 2716).
//
// THE GAP THIS CLOSES: ~5-7 sessions share one dev box. Every queue was strict FIFO and every
// child process ran at the OS default priority class, so a background drain could hold both
// test-queue slots (and saturate the cores) while a high-priority operator-in-the-loop session —
// the expensive kind, because operator attention is the scarcest resource — sat behind it. Plan
// 2520 already ruled a canonical `priority:` frontmatter vocabulary for plans; nothing carried it
// down to the MACHINE. This module is that bridge: a session's claimed plan's tier becomes the
// scheduling class of its heavy work.
//
// TWO CONSUMERS, ONE ANSWER — now resolved through ONE queue read (`resolveSchedulingClass`,
// plan 3226):
//   - `test-queue.mjs` tickets carry the tier, so a waiting `high` ticket is served before waiting
//     `low` ones (never preempting a RUNNING job — see that file's TICKET PROTOCOL note). The
//     landing-queue head resolves `high` regardless of its own plan's `priority:` stamp — see
//     "THE HEAD OUTRANKS EVERYTHING" below.
//   - The SessionStart hook establishes a Windows BelowNormal baseline for every session tree.
//     `applyCpuClass()` steps ANY tier's heavy children down to Windows IDLE / POSIX nice +19 while
//     a LOCAL land is in flight at the queue head and this session is not it (`yieldToHead`, plan
//     3226). The two axes remain independent: a yielding `high` sibling still outranks a waiting
//     `medium` ticket, while its heavy child yields the CPU to the head.
//
// PRIORITY ORDERS ADMISSION; IT DOES NOT THROTTLE A SLOT-HOLDER (plan 4236 T4, folding plan 4234
// Task 2 — the operator-confirmed reading, paraphrased: priority decides the order in which
// waiting jobs get a slot, but a job that already holds a slot is no longer slowed down for being
// low priority; the plan about to land keeps first claim on the CPU). Before plan 4236 a `low`
// tier ALSO demoted its admitted heavy tree to IDLE, so a low job that had waited its turn for one
// of the two slots then crawled inside it — holding the slot longer, which is exactly what makes
// the next waiter time out. The `low` tier now orders queue admission only; the plan-3226 head
// yield is unchanged, and dropping a demote is not an elevation (see NO ELEVATION below).
//
// THE HEAD OUTRANKS EVERYTHING (plan 3226, operator directive 2026-08-16 — "the plan that is
// ahead in the landing queue that is about to land has priority over the CPU"). The landing-queue
// head (state IN_LAND *or* HOLDING — the head is what everyone waits on either way) resolves
// `high` even with no `priority:` stamp of its own, matched via the spine's `LANDING_QUEUE_HEAD`
// env (set at head-acquisition, inherited by every at-head child) or this session's own worktree
// branch (`readLandingHead` + the head-match in `resolveSchedulingClass`). Separately, every OTHER
// LOCAL session's heavy children yield the CPU class (`yieldToHead`) while that head is actually
// IN_LAND, on THIS host, with a live pid, and a heartbeat no older than `DEFAULT_STEAL_STALE_MIN`
// — never for a merely-queued or HOLDING head. Escape hatch: `LANDING_HEAD_YIELD=0` opts a session
// out (operator ruling 2026-08-16: "a session you are actively babysitting can set
// LANDING_HEAD_YIELD=0"). Fail-open throughout — a queue read/parse failure, empty queue,
// cross-host head, dead pid, or stale heartbeat all resolve to "no yield", never a throw.
//
// NO ELEVATION, EVER — pinned at spec (plan 2716 design sketch 3). `high` never gets
// AboveNormal/HIGH_PRIORITY_CLASS: elevating above Normal starves system interactivity, and the
// whole win comes from demoting the bulk lane rather than boosting the head. `applyCpuClass` is
// a one-directional demote by construction; keep it that way — `yieldToHead` demotes, it never
// elevates the head, and there is no restore-when-the-land-completes path (see
// `resolveSchedulingClass` below for why that would break the one-directional-demote contract).
//
// COOPERATIVE ONLY — a session classifies ITS OWN children at spawn time. No session ever renices
// or kills another session's processes (plan 2716 "Out of scope"): cross-session process surgery
// on a shared box is how a debugging session ends up throttling a live gate run.
//
// TIER RESOLUTION goes through `read-plan-stamps.mjs` (the plan-2423 contracted stamp reader) and
// `redgreen-lib.mjs`'s `slugFromBranch` — never a hand-rolled frontmatter parse or a re-inlined
// `=== 'high'`. Plan 2520 closed exactly that drift class (FIVE independent inlines that had to
// agree by convention); a sixth here would reopen it. The vocabulary is {high, medium, low} with
// `medium` as the unstamped default, so "no claim / not a worktree / unreadable plan" all resolve
// to `medium` — the same value an unstamped plan reads as, never a null a caller must special-case.
//
// WHY THE MAIN CHECKOUT'S PLAN FILE, not the worktree's own copy: a worktree is cut once and then
// diverges. If the operator bumps a plan to `priority: high` mid-flight (the exact moment the tier
// matters most), the worktree's frozen copy would never see it. The main checkout tracks master, so
// the bump takes effect on the session's very next heavy run with no rebase. The worktree's own
// tree is the fallback when the main checkout can't be located.
//
// Usage:
//   node scripts/session-priority.mjs            # prints the tier (high|medium|low)
//   node scripts/session-priority.mjs --explain  # …tier + why, plus the yield-to-head line
//   import { resolveSessionTier, resolveSchedulingClass, applyCpuClass } from './session-priority.mjs';

import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRIORITY_DEFAULT, PRIORITY_VALUES, planIdOf, walkPlanTree } from './build-index-lib.mjs';
import { readPlanStamps } from './read-plan-stamps.mjs';
import { slugFromBranch } from './redgreen-lib.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';
import {
  parseQueue,
  headOf,
  decorateWithHeartbeatRefs,
  ageIsFresh,
  IN_LAND_STATE,
  DEFAULT_STEAL_STALE_MIN,
} from './landing-queue-lib.mjs';
import { readLocalHeartbeatRef } from './queue-heartbeat-ref.mjs';
// plan 3973: the queue doc's ONE accessor; `fetch: false` keeps this off the origin round trip.
import { readQueueDoc } from './landing-queue-ref.mjs';
import { ageMinutes } from './landing-lock.mjs';
import { pidAlive as pidAliveProbe } from './worktree-lock.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';

const REPO_ROOT = repoRootFrom(path.dirname(fileURLToPath(import.meta.url)));

// The escape hatch AND the test seam: an explicit tier wins over every derivation below. Named
// for the session (not the queue) because it governs the CPU class too — a batch driver that
// wants its whole fan-out demoted exports this once rather than threading a flag through.
export const TIER_ENV = 'SESSION_PRIORITY_TIER';

// Set by the done-worktree spine at head-acquisition (`process.env.LANDING_QUEUE_HEAD =
// state.slug`, plan 3226) and inherited by every at-head child. The load-bearing signal for the
// ephemeral detached-HEAD merge push, whose branch is literally "HEAD" — `slugFromBranch` returns
// null there, so the branch fallback alone would misread that push as a sibling and self-yield.
export const LANDING_QUEUE_HEAD_ENV = 'LANDING_QUEUE_HEAD';

// Operator escape hatch (2026-08-16 ruling): a session being actively babysat can opt out of
// yielding to the landing-queue head by setting this to '0'. Any other value (including unset)
// leaves the default "everyone yields" behavior in place.
export const LANDING_HEAD_YIELD_ENV = 'LANDING_HEAD_YIELD';

// os.setPriority's nice-scale constant that libuv maps to IDLE_PRIORITY_CLASS on Windows
// and nice(+19) on POSIX. Named here so the one demotion target is greppable, and so nothing can
// quietly pass a NEGATIVE value (which is what elevation would look like).
export const CPU_CLASS_DEMOTED = os.constants.priority.PRIORITY_LOW;

// git — one spawnSync, never throws, returns trimmed stdout or null. Deliberately not coord-git's
// machinery: this runs on the hot path of every heavy spawn and must stay a single cheap call.
function git(args, cwd) {
  try {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitRepoIsolatedEnv(),
    });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    const out = r.stdout.trim();
    return out || null;
  } catch {
    return null;
  }
}

// The MAIN checkout's directory — the first `worktree` line of `git worktree list --porcelain` is
// always the main working tree, which is exactly what done-worktree.mjs's `$MAIN` resolution uses.
// null when git is unavailable or this is not a repo.
function mainCheckoutDir(cwd) {
  const out = git(['worktree', 'list', '--porcelain'], cwd);
  if (!out) return null;
  const m = /^worktree (.+)$/m.exec(out);
  return m ? m[1].trim() : null;
}

// Locate the plan file for `planId` under a plans root, WITHOUT reading every plan in the corpus
// (collectPlanStamps reads a few hundred files; this walk is readdir-only until the one hit).
// Uses the shared walker so a plan clumped into a category subfolder is still found (plan 2678).
// `archive/` is excluded: an archived plan is not a live claim.
export function findPlanFile(planId, { plansRoot, readdir } = {}) {
  const root = plansRoot;
  const readdirAt =
    readdir ??
    ((segments) => {
      try {
        return readdirSync(path.join(root, ...segments), { withFileTypes: true });
      } catch (e) {
        // Tolerated BELOW the root for the same reason read-plan-stamps tolerates it: ~5-7
        // sessions mutate this tree continuously, so a folder can vanish mid-walk. A missing
        // ROOT yields [] at the top level and simply means "no plan found" — this helper is a
        // best-effort tier hint, never a gate, so it must not throw into a spawn path.
        const code = (e && e.code) || 'UNKNOWN';
        if (code === 'ENOENT' || code === 'ENOTDIR') return [];
        throw e;
      }
    });
  let entries;
  try {
    entries = walkPlanTree({
      readdir: readdirAt,
      includeArchive: false,
      isPlanFile: (name) => name.endsWith('.md') && /^\d+/.test(name),
    });
  } catch {
    return null;
  }
  // planIdOf is THE numeric-prefix rule (build-index-lib.mjs), not a re-rolled `/^(\d+)/`. The
  // difference is load-bearing: a legacy date-prefixed plan (`2026-05-17-vetpris-retry.md`) would
  // have yielded "2026" under a bare digit-prefix match, so a session on a branch for plan 2026
  // could have resolved its tier from an unrelated 2026-dated plan. planIdOf requires ≥3 digits
  // followed by a LETTER-category segment, which sends those names to Infinity instead.
  if (!Number.isFinite(planId)) return null;
  for (const e of entries) {
    if (planIdOf(e.basename) === planId) return path.join(root, ...e.rel.split('/'));
  }
  return null;
}

// The plan-stamp derivation ONLY (branch → worktree slug → plan file → `priority:` stamp) — the
// TIER_ENV override and the landing-queue-head axis both live one level up, in
// `resolveSchedulingClass`, which is the only caller. Kept as a private function (not exported)
// so there is exactly one place that decides derivation ORDER; this is just the tail of it.
//   mainDir    — the ALREADY-resolved main checkout (never re-resolves it; resolveSchedulingClass
//                resolves it once for the landing-queue read and hands the same value down, so
//                the two axes can never disagree about which checkout they are reading)
//   branch     — the already-resolved branch name (never calls git itself)
//   plansRoot  — skip the main-checkout lookup entirely
//   readFile   — read the located plan file
function deriveStampTier({ mainDir, branch, plansRoot, readdir, readFile }) {
  if (!branch)
    return { tier: PRIORITY_DEFAULT, reason: 'no git branch (not a repo / git unavailable)' };
  const slug = slugFromBranch(branch);
  if (!slug)
    return { tier: PRIORITY_DEFAULT, reason: `branch "${branch}" is not a worktree claim` };

  // A batch-lane slug (`batch-2026-07-05-coord-fable`) carries no single plan id — the train's
  // members can hold different tiers, and picking one of them would be arbitrary. planIdOf
  // returns Infinity for those (and for legacy date-prefixed slugs), which is the "no id" signal.
  const planId = planIdOf(slug);
  if (!Number.isFinite(planId)) {
    return { tier: PRIORITY_DEFAULT, reason: `slug "${slug}" carries no plan id` };
  }

  const root = plansRoot ?? (mainDir ? path.join(mainDir, 'docs', 'superpowers', 'plans') : null);
  const file = root ? findPlanFile(planId, { plansRoot: root, readdir }) : null;
  if (!file) return { tier: PRIORITY_DEFAULT, reason: `no active plan file for id ${planId}` };

  let content;
  try {
    content = readFile(file);
  } catch (e) {
    return {
      tier: PRIORITY_DEFAULT,
      reason: `plan ${planId} unreadable (${e?.code ?? e?.message ?? e})`,
    };
  }
  // THE contracted read (plan 2423 + 2520): `priority` here is already normalized to
  // {high, medium, low} with medium as the absent-default — no second normalization anywhere.
  const { priority } = readPlanStamps(content);
  return { tier: priority, reason: `plan ${planId} priority: ${priority}` };
}

// The main checkout, resolved ONCE per resolveSchedulingClass call and shared by both axes (the
// landing-queue read and the plan-stamp lookup). Before plan 3226 the stamp path re-resolved this
// independently, which cost a second `git worktree list --porcelain` spawn on the hot path and
// let the two axes silently read different checkouts when a caller injected only one of them.
function defaultMainDir(cwd) {
  return mainCheckoutDir(cwd) ?? git(['rev-parse', '--show-toplevel'], cwd) ?? REPO_ROOT;
}

// Cross-host comparison target for the head's `host` cell (plan 3226): landing-queue.mjs writes
// `host: flags.host ?? hostname()`, which "can disagree in case/form on Windows" with
// `os.hostname()` (see done-worktree-lib.mjs's own note on this). Compare only the first DNS
// label, case-insensitively — the cheapest normalization that survives that drift without
// over-matching two DIFFERENT machines that happen to share a short first label.
function firstHostLabel(h) {
  return String(h ?? '')
    .trim()
    .split('.')[0]
    .toLowerCase();
}

// The liveness probe default is worktree-lock.mjs's `pidAlive` itself (imported as
// `pidAliveProbe` only to clear the destructured parameter name below) — the SAME probe
// battery-lock.mjs and landing-queue-watch.mjs use, not a fourth hand-rolled copy. Convention:
// process.kill(pid, 0) throwing anything but ESRCH counts as alive, so an uncertain read leans
// toward "still running" — this gates a CPU-class demotion of a possibly-live coordination head,
// and an uncertain read must never manufacture a yield. It returns null for a non-integer/≤0
// pid, which readLandingHead maps to "no pid to check" (the spec's "head.pid absent OR alive").

// Read the landing-queue doc straight from the shared `.git`'s tracking ref of the queue's
// coord ref (plan 3973: `refs/remotes/origin/coord/landing-queue`), no fetch (every local queue
// write and every default-refspec fetch already refreshes it; the same no-fetch shape this had
// against origin/master). Returns null (never throws) on any git failure or an untrusted read —
// readLandingHead below treats that as fail-open.
//
// `fetchIfAbsent` is the ONE exception to no-fetch, and it is not an optimisation to skip: a
// MISSING tracking ref (a single-branch clone, a sandbox that has only ever fetched master) is
// indistinguishable from an empty queue here, and reading it as "no head" makes every session
// decline to yield to a land that IS in flight (plan 3973 review, key 515a94). One fetch, only
// while the ref is unknown to this checkout; once it exists, every queue write refreshes it.
// Its COST on the spawn hot path is bounded by construction and is not cached away (plan 3973
// review round 2, keys c42bdb / 0cd5da — WONTFIX by decision): the fetch fires only while this
// checkout has no tracking ref at all, i.e. once per checkout lifetime, and from then on this
// reader is exactly as stale as the pre-3973 no-fetch `origin/master` read it replaced — every
// queue verb's own fetch refreshes the ref for everyone sharing the `.git`.
//
// No SEPARATE refresh of the pre-cut-over master doc is owed here (plan 3973 review round 3, key
// 3140ed — WONTFIX by decision): that document is the queue's source only until `migrate` runs,
// after which master is the tombstone and the ref is the only transport; and the `fetchIfAbsent`
// fetch now names `master` alongside the queue refspec in ONE round trip anyway, so the seed
// view it falls back to is refreshed by the same call rather than by a second one.
function defaultReadQueueDoc(mainDir) {
  try {
    const q = readQueueDoc(mainDir, { fetch: false, fetchIfAbsent: true });
    return q.fault ? null : q.doc;
  } catch {
    return null;
  }
}

// The freshest ("newest timestamp" = smallest age) heartbeat for `head`, in whole minutes as of
// `nowMs`. null when nothing parses — readLandingHead treats "can't prove liveness" as "not
// fresh", never as fresh.
//
// The doc-vs-local-ref fold goes through landing-queue-lib's `decorateWithHeartbeatRefs`, the
// SAME helper landing-queue.mjs uses, rather than a private min() over the raw stamps. That is
// load-bearing, not just DRY: the helper drops a local ref stamped at-or-before the entry's
// `enqueuedIso`, because a leftover ref from a PREVIOUS residency of the same slug (the
// documented dequeue → `reenter` path) would otherwise make the current residency look alive and
// demote every sibling off a foreign-residency timestamp.
function freshestHeartbeatAgeMinutes({ head, mainDir, readHeartbeatRef, nowMs }) {
  const localStamp = readHeartbeatRef(mainDir, head.slug);
  const [decorated = head] = decorateWithHeartbeatRefs(
    [head],
    localStamp ? { [head.slug]: localStamp } : null,
  );
  const ages = [decorated.heartbeatIso, decorated.progressIso]
    .filter(Boolean)
    .map((iso) => ageMinutes(iso, nowMs))
    .filter((a) => a !== null);
  return ages.length ? Math.min(...ages) : null;
}

// Axis 1 ("who is the head") and axis 2 ("is a LOCAL land in flight at that head right now")
// share this ONE read (plan 3226). `head` is returned for ANY head state — a HOLDING head still
// answers "who does axis 1 treat as the head", since a parked-on-rework head is still what
// everyone in the queue is waiting on. `inFlightLocal` is the narrower axis-2 predicate (IN_LAND
// + this host + a live pid + a fresh heartbeat) that governs whether everyone ELSE yields the
// CPU. Every external input is injectable; this NEVER throws — it is one of the ~2 git calls on
// the spawn hot path (see the module header + plan 3226's Execution notes), and a read/parse
// failure degrades to "no head, don't yield", never a wedge.
export function readLandingHead({
  mainDir,
  readQueueDoc = defaultReadQueueDoc,
  readHeartbeatRef = readLocalHeartbeatRef,
  now = () => Date.now(),
  hostname: hostnameFn = os.hostname,
  pidAlive = pidAliveProbe,
} = {}) {
  if (!mainDir) return { head: null, inFlightLocal: false, reason: 'no main checkout resolved' };
  let doc;
  try {
    doc = readQueueDoc(mainDir);
  } catch (e) {
    return {
      head: null,
      inFlightLocal: false,
      reason: `queue doc unreadable (${e?.message ?? e})`,
    };
  }
  if (!doc) return { head: null, inFlightLocal: false, reason: 'queue doc unavailable' };
  let entries;
  try {
    ({ entries } = parseQueue(doc));
  } catch (e) {
    return {
      head: null,
      inFlightLocal: false,
      reason: `queue doc unparseable (${e?.message ?? e})`,
    };
  }
  const head = headOf(entries);
  if (!head) return { head: null, inFlightLocal: false, reason: 'landing queue is empty' };
  if (head.state !== IN_LAND_STATE) {
    return {
      head,
      inFlightLocal: false,
      reason: `head "${head.slug}" is ${head.state ?? 'queued, not yet at head-acquisition'} (not IN_LAND)`,
    };
  }
  const localLabel = firstHostLabel(hostnameFn());
  const headLabel = firstHostLabel(head.host);
  if (!headLabel || headLabel !== localLabel) {
    return {
      head,
      inFlightLocal: false,
      reason: `head "${head.slug}" is on host "${head.host}" (this host is "${hostnameFn()}")`,
    };
  }
  // `pidAlive` returns null for an absent/unparseable pid — "no pid to check", which the spec
  // treats as passing (the head.pid cell is optional). Only an explicit `false` is a dead head.
  const pid = Number(head.pid);
  if (Number.isFinite(pid) && pid > 0 && pidAlive(pid) === false) {
    return { head, inFlightLocal: false, reason: `head "${head.slug}" pid ${pid} is not alive` };
  }
  const nowMs = now();
  const age = freshestHeartbeatAgeMinutes({ head, mainDir, readHeartbeatRef, nowMs });
  if (age === null) {
    return {
      head,
      inFlightLocal: false,
      reason: `head "${head.slug}" has no readable heartbeat`,
    };
  }
  // `ageIsFresh` is landing-queue-lib's own freshness predicate — the same one the steal/reap
  // path uses — so this module cannot drift from the queue's definition of stale.
  if (!ageIsFresh(age, DEFAULT_STEAL_STALE_MIN)) {
    return {
      head,
      inFlightLocal: false,
      reason: `head "${head.slug}" heartbeat is ${age}m old (stale > ${DEFAULT_STEAL_STALE_MIN}m)`,
    };
  }
  return {
    head,
    inFlightLocal: true,
    reason: `local land in flight at head: ${head.slug}, heartbeat ${age}m ago`,
  };
}

// Is THIS session the landing-queue head? Matched two ways (either is sufficient): the spine's
// LANDING_QUEUE_HEAD env (set at head-acquisition, inherited by every at-head child — the ONLY
// signal the ephemeral detached-HEAD merge push has, since its branch is literally "HEAD" and
// slugFromBranch('HEAD') is null), or this session's own worktree branch resolving to the head
// slug (the hand-run-inside-the-worktree fallback).
function isSelfHead(head, { env, branch }) {
  if (!head) return false;
  const envSlug = (env[LANDING_QUEUE_HEAD_ENV] ?? '').trim();
  if (envSlug && envSlug === head.slug) return true;
  const branchSlug = branch ? slugFromBranch(branch) : null;
  return branchSlug != null && branchSlug === head.slug;
}

// THE single entry point (plan 3226): one landing-queue read serving BOTH scheduling axes.
//   tier/reason         — axis 1. Order: the TIER_ENV override (keeps winning) > "I am the
//                          landing-queue head" (high, regardless of my own plan's stamp) > the
//                          plan-stamp derivation (deriveStampTier).
//   yieldToHead/yieldReason — axis 2, independent of axis 1 (including of a TIER_ENV override):
//                          true iff a LOCAL land is in flight at the head (readLandingHead's
//                          `inFlightLocal`) AND this session is not that head AND the operator
//                          escape hatch is not set.
// Every seam `readLandingHead` takes is threaded through unchanged; `resolveSessionTier` and
// `explainSessionTier` below are thin wrappers over this — see the module header.
export function resolveSchedulingClass({
  cwd = process.cwd(),
  env = process.env,
  branch,
  plansRoot,
  readdir,
  readFile = (p) => readFileSync(p, 'utf8'),
  warn = (m) => console.error(m),
  mainDir,
  discoverMainDir,
  readQueueDoc,
  readHeartbeatRef,
  now,
  hostname,
  pidAlive,
} = {}) {
  const gitBranch = branch ?? git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  // Should we go FIND a real main checkout when the caller did not hand us one? Production passes
  // nothing at all and gets `true` — both axes read the real repo, which is the whole point of the
  // module. The default flips to `false` only for a caller that supplied its own `plansRoot`
  // WITHOUT any queue seam: that combination is the battery's derivation seam, and discovering a
  // real checkout behind its back is what would silently point the pre-3226 hermetic tests at the
  // live shared landing queue, making them depend on whichever sibling session happens to be
  // landing. `discoverMainDir` makes that an explicit, overridable decision rather than an
  // inference: pass `true` to keep the head axis while redirecting only the plan-stamp lookup.
  const shouldDiscover = discoverMainDir ?? !(plansRoot && !readQueueDoc);
  // Resolved ONCE here and shared by BOTH axes below — see defaultMainDir.
  const resolvedMainDir = mainDir ?? (shouldDiscover ? defaultMainDir(cwd) : null);
  const {
    head,
    inFlightLocal,
    reason: headReadReason,
  } = readLandingHead({
    mainDir: resolvedMainDir,
    readQueueDoc,
    readHeartbeatRef,
    now,
    hostname,
    pidAlive,
  });

  const amHead = isSelfHead(head, { env, branch: gitBranch });

  const forced = (env[TIER_ENV] ?? '').trim().toLowerCase();
  let tier;
  let reason;
  if (forced && PRIORITY_VALUES.includes(forced)) {
    tier = forced;
    reason = `${TIER_ENV}=${forced}`;
  } else {
    if (forced) {
      // Loud but non-fatal, matching normalizePriorityTier's soft-fail backstop: a typo in an
      // env var must not wedge a heavy run, but it must not silently do nothing either.
      warn(
        `session-priority: ignoring ${TIER_ENV}="${env[TIER_ENV]}" — not one of ${PRIORITY_VALUES.join('/')}`,
      );
    }
    if (amHead) {
      tier = 'high';
      reason = `landing-queue head (${head.slug})`;
    } else {
      ({ tier, reason } = deriveStampTier({
        // Non-null whenever it is actually needed: resolvedMainDir only goes null on the
        // plansRoot-injected path, and deriveStampTier prefers plansRoot over mainDir there.
        mainDir: resolvedMainDir,
        branch: gitBranch,
        plansRoot,
        readdir,
        readFile,
      }));
    }
  }

  const yieldEscape = (env[LANDING_HEAD_YIELD_ENV] ?? '').trim();
  let yieldToHead = false;
  let yieldReason;
  if (amHead) {
    yieldReason = 'this session is the landing-queue head';
  } else if (!inFlightLocal) {
    yieldReason = headReadReason;
  } else if (yieldEscape === '0') {
    yieldReason = `${LANDING_HEAD_YIELD_ENV}=0`;
  } else {
    yieldToHead = true;
    yieldReason = headReadReason;
  }

  return { tier, reason, yieldToHead, yieldReason };
}

// Thin wrapper over resolveSchedulingClass (plan 3226) — same signature/behavior as before this
// plan, plus the landing-queue-head axis. Every seam is injectable so the battery can exercise
// each branch without a repo, a claim, or a git binary.
//   cwd        — where to ask git about the branch and the main checkout (default process.cwd())
//   env        — for the TIER_ENV / LANDING_QUEUE_HEAD / LANDING_HEAD_YIELD reads (default
//                process.env)
//   branch     — skip the git call entirely (tests / a caller that already knows)
//   plansRoot  — resolve the plan stamp from THIS tree instead of looking up a main checkout.
//                On its own it also suppresses main-checkout DISCOVERY entirely, which turns the
//                landing-queue-head axis off (no checkout ⇒ no queue doc ⇒ no head, no yield) —
//                that is what keeps a plansRoot-only caller hermetic. Pass `discoverMainDir: true`
//                (or a `mainDir` / `readQueueDoc` seam) to redirect only the stamp lookup and keep
//                the head axis live.
//   readFile   — read the located plan file
export function explainSessionTier(opts = {}) {
  const { tier, reason } = resolveSchedulingClass(opts);
  return { tier, reason };
}

// Deliberately NOT memoized. A process-wide cache would have made the tier a hidden global that
// pins the FIRST answer for the process's lifetime: a long-lived driver could never observe the
// operator bumping its plan to `high`, and the cache's "no opts means cacheable" rule was a
// subtlety every future caller would have to know. Callers that spawn many children resolve once
// and pass the tier down — which both production callers already do — so the cache was buying a
// ~30 ms git call back on a path that runs once per multi-minute heavy run.
export function resolveSessionTier(opts = {}) {
  return explainSessionTier(opts).tier;
}

// Demote ONE child process (and, by OS inheritance, everything it spawns afterwards) to the
// IDLE class while a local land is in flight at the queue head and this session is not it
// (`yieldToHead`, plan 3226) — one rung below the BelowNormal baseline the SessionStart hook
// already established for the whole session tree (plan 3544). Returns whether the demotion was
// applied. `tier` no longer demotes anything (plan 4236 T4: priority orders ADMISSION, it does not
// throttle a slot-holder — see the header); the parameter stays so both production callers keep
// their call shape.
//
// WHY inheritance is enough: both Windows priority class and POSIX nice are inherited by children
// created AFTER the change, and callers apply this synchronously on the pid spawnWithTreeKill just
// returned — before that child has had a scheduling quantum to fork its own workers. A pnpm→vitest
// or python→pytest tree therefore comes up demoted end-to-end. The residual race (a child that
// forks in its very first microseconds) leaves a stray worker at Normal; that is a throughput
// nuance, never a correctness problem, and is not worth a descendant-walk on a hot path.
//
// NEVER THROWS: a failed demotion (EPERM under an odd token, a pid that already exited) must not
// take down the heavy run it was trying to be polite about — warn once and proceed at the default
// class. Without `yieldToHead` every tier returns false without touching the process at all (no
// elevation, ever, and since plan 4236 no tier-driven demotion either).
export function applyCpuClass(
  pid,
  tier,
  {
    yieldToHead = false,
    setPriority = (p, v) => os.setPriority(p, v),
    warn = (m) => console.error(m),
  } = {},
) {
  if (!yieldToHead) return false;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    setPriority(pid, CPU_CLASS_DEMOTED);
    return true;
  } catch (e) {
    warn(
      `session-priority: could not demote pid ${pid} to the idle CPU class ` +
        `(${e?.message ?? e}) - the run proceeds at the inherited class`,
    );
    return false;
  }
}

// --- CLI --------------------------------------------------------------------

export function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const explain = argv.includes('--explain');
  const { tier, reason, yieldToHead, yieldReason } = resolveSchedulingClass();
  if (!explain) {
    log(tier);
    return;
  }
  log(`${tier} (${reason})`);
  log(yieldToHead ? `yield: yes (${yieldReason})` : `yield: no (${yieldReason})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
