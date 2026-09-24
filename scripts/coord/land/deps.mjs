// scripts/coord/land/deps.mjs — plan 3961 T3.0: the land spine's dependency container.
//
// WHY THIS EXISTS. A core module under scripts/coord/land/ may import only scripts/coord/** and
// node: builtins (Rule 3, docs/runbooks/scripts-module-layout.md) — but the spine
// (done-worktree.mjs) reaches ~37 plain scripts/*.mjs modules that were NOT moving in this plan
// (landing-lock.mjs, coord-git.mjs, land-lib.mjs, done-worktree-lib.mjs, … — several of these have
// SINCE moved under scripts/coord/ themselves via the later coord-kit extraction program, plan
// 4096, but this container's own binding of them is unchanged). A core module that needs one of
// them cannot import it directly. Threading a bag of them through every helper
// signature as a parameter is the other option, and it is the churn the parity harness
// (scripts/coord/land/parity.test.mjs) exists to avoid: ~150 helper call sites, most of them many
// frames deep, all rewritten in lockstep with zero behaviour change to prove.
//
// The container is the third option: ONE object, assembled once from the real imports the command
// file already holds, bound into this module's own top-level state, and read back by name at call
// time from wherever a core module needs it. It is deliberately module-level state — not a class,
// not a constructor argument threaded everywhere — because it is bound exactly ONCE, at boot,
// before any land runs, and every reader after that sees the same frozen object. Explicit
// (`bindLandDeps` is a real call site in done-worktree.mjs, not implicit module-load wiring),
// validated (a missing group fails loudly at bind time, never as `undefined` at some call site
// hours later), and frozen (nothing downstream can mutate the wiring after boot).
//
// TWO LEVELS OF CHECKING, DELIBERATELY SPLIT.
//   - `bindLandDeps` checks GROUPS by name only — every group named in LAND_DEPS_GROUPS must be
//     present and be an object. It does NOT check members: at T3.0 nothing read a group's members
//     yet, so the member list was not knowable here.
//   - `requireDeps` checks MEMBERS — the same silent-skip discipline as `requireSpine` in
//     scripts/project/land-gates.mjs (a dependency that is absent must fail loudly at the point a
//     module first needs it, never as a quiet `undefined`). Plan 4066 task 0 gave it its
//     production caller: every core module under scripts/coord/land/ that reads this container
//     declares a frozen `CONTAINER_READS` manifest of the members it reads, per group, and
//     scripts/coord/land/container-manifest.mjs asserts every module's whole manifest through
//     this function, ONCE, right after `bindLandDeps` binds the real container in
//     done-worktree.mjs — so a missing or mis-named member now throws here, by name, before any
//     land phase runs, instead of surfacing as a plain `undefined` at its call site. See
//     requireDeps's own docstring and container-manifest.mjs's header for the full mechanism.
//
// TESTING RULE. A unit test that wants FAKE dependencies imports THIS module alone
// (`deps.test.mjs` does exactly that). Importing done-worktree.mjs in the same process binds the
// REAL container as a side effect of module load, and `bindLandDeps` refuses a second bind — so a
// test that needs fakes must never import the command file.
//
// This module imports NOTHING (Rule 3 needs nothing here, and holding injected dependencies is
// the one job that requires no dependencies of its own).

/** The group names bindLandDeps requires. The command file and deps.test.mjs read this SAME list, so neither can drift from what is actually enforced. */
export const LAND_DEPS_GROUPS = Object.freeze([
  'pwshExec',
  'junctionGuard',
  'coordShareLib',
  'scriptsBattery',
  'testQueue',
  'killTree',
  'lockPath',
  'batteryLedger',
  'batteryLock',
  'coordGit',
  'ensureCoordReroute',
  'sweepDeferredWorktrees',
  'coordConfig',
  'claimPlanLib',
  'blockedByLib',
  'batchPaths',
  'boardLib',
  'redgreenLib',
  'readPlanStamps',
  'selectBatteryTests',
  'gatePassCache',
  'buildIndexLib',
  'assertNoLandedReversion',
  'landLib',
  'L',
  'diskHeadroom',
  'worktreePorcelain',
  'spawnDetachedWorktreeChild',
  'reconcileWorktreeBranches',
  'landingQueueLib',
  'landingQueueRef',
  'indexLib',
  'planBodyState',
  'drainRun',
  'coordMetrics',
  'landingLock',
  'landingQueueWatch',
  'planCostBanner',
  'planAdoptBranch',
  'queueDrain',
  'atomicWrite',
  'execModelStamp',
  'preRebaseMainGuard',
  'worktreeLock',
  'coordSessionId',
  // Two synthetic groups: the command file's own spawn primitives (they reach the do-not-edit
  // scripts by name, so they stay in the command file) and the argv-derived boot-time flags.
  'spawn',
  'env',
  // plan 3961 T3.1: a third synthetic group — the command file's own primitives that stay in the
  // command file because they own process-wide state, close over private module-level state, are
  // shared with a non-close-out caller, or are pinned there by a done-worktree.test.mjs SOURCE
  // TEXT assertion — mirroring how scripts/project/*.mjs already receive shared spine primitives
  // (spineBag()). `emitSeam` calls process.exit and mutates spine-wide mutex/queue state directly;
  // `coordStep`/`dequeueQueueIfHeld` close over private module-level test-fakery state
  // (`_fakeForeignDirt`); `findSessionFile` closes over a private memoization cache
  // (`_sessionFileCache`); `tryStep` is shared with teardown/resume, not close-out's alone;
  // `resolvePlanRelForSlug` is a small pure helper with an outside (queue-priority) spine call
  // site. `gateProbe`, `hasStagedChanges`, `closeOutCommitAtHead` and `regenIndex` are, by call-
  // count, close-out-only — but sit outside the T3.1 close-out.mjs move's audited contiguous
  // block, and `pushMaster` stays too (not moved by this plan's T3 order to date) — plan 3961
  // T3.4 update: the "pushMaster specifically CANNOT move" claim this comment used to make here
  // is STALE and was WRONG even when T3.1 wrote it. done-worktree.test.mjs's own pin
  // (`landFnStart(allLandSource(), 'pushMaster(MAIN)')`) resolves against the concatenation of
  // every land-spine file, not against done-worktree.mjs specifically (T3.1c's own
  // generalization, landed before this comment was corrected) — see landFnStart's own header
  // comment, which already documents this. `pushMaster` is simply UNMOVED, like every other name
  // in this list, not unmovable. None of these move to a core module: they are added here so a
  // core module can still call them, at call time, without importing done-worktree.mjs.
  //
  // plan 3961 T3.3b: three more, added ahead of the queue.mjs carve so its moved code can reach
  // them. `stepLog` closes over the private module-level `_stepPhases`/`_stepLogT0` timing
  // state; `worktreeHeadSha` reads the private `let dryMidPassTip` the DRY hooks write, and
  // `originMasterTip` is its pairing sibling (both stay together for the same reason). A fourth,
  // `worktreeLockFor`, joined here too at T3.3b (for queue.mjs's dispatchLandPrep to reach it)
  // and LEFT again at T3.4: that move carved worktreeLockFor itself into head-lock.mjs, so
  // queue.mjs now imports it from there directly (a sibling-core-module reach, no container
  // needed) instead of through this group.
  //
  // plan 3961 T3.3: ten more, added for the queue.mjs carve — none for a private-state reason,
  // each simply because it has a call site OUTSIDE that move's cluster too, so it cannot move
  // with it: `readResultSidecar` (tryReclaimStrandedLandLock's own staleness-reclaim status
  // read, plus two main() call sites); `nowIso` (read at two unrelated spine sites besides
  // queueEnqueueAndGate's own enq()); `logSyncSkipped` / `repinAndReprove` / `tryRebase` /
  // `trySkipSync` / `worktreeMutationKind` (preQueueFreshen's own sync/rebase helpers — every one
  // is ALSO the at-head rebase's own machinery, called from main() well outside this cluster); and
  // `landingBoardSlug` (releaseHeadTenureAfterRequeue's board-row-slug resolver, ALSO called by
  // releaseMutexIfHeld's own board-demote and by main()'s LANDING stamp). `dequeueQueueIfHeld`
  // — a T3.1-era member of this group — moved WITH the queue.mjs carve instead of staying: its
  // only outside caller besides this move's own cluster is this file's own
  // releaseHeldSlotBestEffort/emitSeam/main (now reached via the plain done-worktree.mjs import
  // of queue.mjs) and close-out.mjs (which imports it directly, a sibling-to-sibling reach that
  // needs no container) — so it is REMOVED from this group. `attemptPreconverge` /
  // `preconvergeProbe` — added here at T3.3 because queueEnqueueAndGate calls both directly and
  // preconvergeProbe closes over the private module-level `_preconvergeCache` — LEFT again at
  // T3.4b: that move carved both, and the cache they share, into queue-probe.mjs (the cache's
  // ONLY reader/writer anywhere in the spine was preconvergeProbe itself, so the private binding
  // moved WITH its sole accessor instead of needing a cross-module reach); queue.mjs now imports
  // both from there directly instead.
  //
  // plan 3961 T3.4b: five more, added for the queue-probe.mjs carve — none for a private-state
  // reason, each simply because it has a call site OUTSIDE that move's cluster too, so it cannot
  // move with it: `landSpecMarker` (unstackSpeculativeBase's own read/clear, but ALSO
  // read/written by `clearSpeculativeStackForPrep` and `attemptSpeculativeStack`, both prep-gates
  // territory, not yet carved); `restoreOffSpeculativeBase` (unstackSpeculativeBase's
  // reset-vs-rebase primitive, shared with `clearSpeculativeStackForPrep`'s own prep-side undo);
  // `isAncestor` (called by unstackSpeculativeBase here, but ALSO by the DETACHED-worktree
  // recovery helper, `clearSpeculativeStackForPrep`, and `attemptSpeculativeStack`); and
  // `worktreeMutationInProgress` / `attachmentRefusal` (both called by attemptPreconverge, now
  // queue-probe.mjs's, but each has its own OTHER call site in the at-head/prep-gates flow too).
  // `attemptSpeculativeStack` itself — D9's row for this move — does NOT move: it reads the
  // spine-private `let lastHeadRefError`, the same class of blocker as T3.4's
  // `_retainedEntryHeartbeatDisarm`.
  //
  // plan 3961 T3.5: one more, added for the gates-runner.mjs carve (Zone C — the proof/
  // cache/registry-lookup machinery). `landRegistries` is registry BOOT wiring (T3.8's, alongside
  // `spineBag()`), not a gate implementation, so it stays behind; runPrepGates (now
  // gates-runner.mjs's) reaches it through the container instead of importing it. (T3.5 also
  // added `armDryMidPassTip`/`headShaAfterGate`/`prepPassEndSha` here — all three LEFT again at
  // T3.6, see below.)
  //
  // plan 3961 T3.6: `worktreeHeadSha` and `originMasterTip` LEAVE this group — both moved to
  // scripts/coord/land/rebase-sync.mjs, along with the private `let dryMidPassTip` they/their
  // arm* hooks share, giving the whole worktree-HEAD-reading cluster a single home instead of
  // three separate carves each reaching back into the spine for a slice of it. `trySkipSync` /
  // `tryRebase` / `worktreeMutationKind` / `logSyncSkipped` (T3.3 additions) and `armDryMidPassTip`
  // / `headShaAfterGate` / `prepPassEndSha` (T3.5 additions) LEAVE too — all seven moved to
  // rebase-sync.mjs alongside the cluster above, for the same reason each was added here in the
  // first place (a call site outside its own carve's cluster) rather than any private-state
  // hazard of its own. `landSpecMarker` and `isAncestor` (T3.4b additions) LEAVE for the same
  // reason. Every sibling core module that used to read one of these twelve via `D.spine.*` now
  // imports it from rebase-sync.mjs directly instead (a sibling-core-module reach, no container
  // needed — see each importer's own updated import lines). `repinAndReprove` (a T3.3 addition)
  // and `attachmentRefusal` (a T3.4b addition) do NOT move with this group: T3.6 found each
  // blocked by its own dependency this map did not anticipate — `repinAndReprove`'s private
  // helper reads a module-private `let` written by a not-yet-carved phasePreflight helper and
  // calls three other not-yet-carved, multi-use functions; `attachmentRefusal` reads the
  // spine-private `let lastHeadRefError`, whose other readers/writers are large, not-yet-carved
  // functions with nothing to do with the worktree-HEAD cluster. Both stay `spine` members,
  // unaffected; see T3.6's own execution report for the full reasoning.
  //
  // plan 3961 T3.5 (Zone D): three more, added for the same carve's scripts-battery/build/prettier
  // half — see gates-runner.mjs's own header, THE `spine` GROUP paragraph, for the full reasoning.
  // `toPosixPath` is a module-top-level alias done-worktree.test.mjs pins by exact declaration
  // text (rewriting its RHS to a container read would break that pin, and Rule 3 forbids a bare
  // import of its source module here). `BATTERY_LOCK_ACQUIRE_TIMEOUT_MS` (and the small derivation
  // chain feeding it) is read by that same test as a plain NUMBER in arithmetic/comparisons, so it
  // cannot become a call-time function either. `clearNoStartRoundFor` is a T2.2 chunk-cap/no-start
  // bag member called DIRECTLY, by name, from two of the moved functions — the one place in this
  // whole plan where a core module calls BACK into the spine, rather than the spine calling
  // forward into a core module. Its three siblings moved WITH this carve instead:
  // `chunkGateStartDecision`/`noStartGateResult` stay `spine` members regardless (T3.4 put them
  // there for head-lock.mjs's own direct call, unrelated to this move), now resolving through the
  // plain import of them gates-runner.mjs itself carries; `recordNoProgressRound`/
  // `activeChunkWallVar` needed no `spine` membership even before this move (no caller outside
  // the moved cluster) and still need none now that the cluster is a core module instead of the
  // spine.
  'spine',
]);

let container = null;

/**
 * Bind the land dependency container. Boot-time state: called exactly once, from
 * done-worktree.mjs, after its own consts are defined and before its entrypoint guard runs.
 *
 * Refuses: a second bind (the container is boot-time state, not something later code re-wires); a
 * non-object argument; a MISSING or non-object group, by name — every missing/invalid group is
 * named in ONE message, not just the first, so a bind fixed one group at a time never has to be
 * re-run to discover the next.
 *
 * Freezes the container and each group before returning it, so nothing downstream can mutate the
 * wiring after boot. Groups beyond LAND_DEPS_GROUPS — a project plugin's private groups (see
 * withProjectGroups below) — are optional, but get the same shape check and the same freeze.
 */
export function bindLandDeps(deps) {
  if (container) {
    throw new Error(
      'deps.mjs: bindLandDeps() already bound — the land deps container is boot-time state, not re-bindable',
    );
  }
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
    throw new Error(
      `deps.mjs: bindLandDeps() needs a plain object of dependency groups — got ${Array.isArray(deps) ? 'an array' : typeof deps}`,
    );
  }
  const groupNames = [...new Set([...LAND_DEPS_GROUPS, ...Object.keys(deps)])];
  const bad = [];
  for (const name of groupNames) {
    const group = deps[name];
    if (group === undefined) {
      bad.push(`${name} (missing)`);
    } else if (group === null || typeof group !== 'object' || Array.isArray(group)) {
      bad.push(`${name} (${Array.isArray(group) ? 'an array' : typeof group}, not an object)`);
    }
  }
  if (bad.length) {
    throw new Error(`deps.mjs: bindLandDeps() refused — bad group(s): ${bad.join(', ')}`);
  }
  for (const name of groupNames) {
    try {
      Object.freeze(deps[name]);
    } catch {
      // Most groups here ARE ES module namespace objects (`import * as x from …` in
      // done-worktree.mjs). A namespace object's own [[DefineOwnProperty]] rejects
      // Object.freeze() outright (its exported bindings are configurable: false but
      // writable: true, and freezing needs to flip writable to false, which the exotic
      // object refuses) — but a namespace object is already immutable from the outside:
      // no property can be added, deleted, or reassigned by an importer. There is nothing
      // left for this freeze to enforce, so a refusal here is not a bind failure.
    }
  }
  container = Object.freeze({ ...deps });
  return container;
}

/** The frozen container. Throws if nothing has bound one yet (see bindLandDeps's call site in done-worktree.mjs). */
export function landDeps() {
  if (!container) {
    throw new Error(
      'deps.mjs: landDeps() called before bindLandDeps() — the land spine has not booted its dependency container yet',
    );
  }
  return container;
}

/**
 * Member-level check for ONE already-resolved group object (e.g. `landDeps().coordGit`) — for a
 * core module to assert its own group carries the specific members its moved code calls by name.
 * Mirrors requireSpine (scripts/project/land-gates.mjs): throws naming every missing member (not
 * just the first), otherwise returns `group` unchanged.
 *
 * Plan 4066 task 0 gave this its production caller: scripts/coord/land/container-manifest.mjs's
 * `assertContainerManifests()` calls this once per group, for every core module's declared
 * `CONTAINER_READS` manifest, right after `bindLandDeps` binds the real container in
 * done-worktree.mjs — so a member missing from a bound group now throws here, by name, naming the
 * reading module too, before any land phase runs. Before that plan (T3, plan 3961, is complete)
 * this function had no production caller and only deps.test.mjs exercised it; a member missing
 * from a bound group surfaced only as an ordinary `undefined` wherever a core module read it.
 * container-manifest.test.mjs's own parity test keeps each module's manifest from drifting from
 * the reads its source actually makes, so this function's guarantee stays real as those modules
 * change.
 */
export function requireDeps(group, names, where) {
  if (group === null || typeof group !== 'object' || Array.isArray(group)) {
    throw new Error(
      `deps.mjs: requireDeps() for ${where} needs a dependency group (a plain object) — got ${Array.isArray(group) ? 'an array' : typeof group}`,
    );
  }
  const missing = names.filter((name) => group[name] === undefined);
  if (missing.length) {
    const has = Object.keys(group);
    throw new Error(
      `deps.mjs: ${where} needs dependency member(s) ${missing.join(', ')}, but the group only carries ` +
        `${has.length ? has.join(', ') : '(nothing)'} — see done-worktree.mjs's bindLandDeps() call (plan 3961 T3.0)`,
    );
  }
  return group;
}

// ── plan 4096 T1: the project plugin's container contract ────────────────────────────────────────
//
// The project layer is an OPTIONAL plugin of the land spine (scripts/project/land-plugin.mjs in
// this repo, loaded by done-worktree.mjs through scripts/coord/optional-import.mjs). A plugin's
// `containerGroups` reach the container through `withProjectGroups` below, in three kinds:
//
//   1. CORE-READ, PROJECT-SUPPLIED GROUPS (PROJECT_GROUP_DEFAULTS). A group some core module reads
//      but only a project can fill. It is in LAND_DEPS_GROUPS, and it has a core default here, so
//      the container still binds — and still passes the plan-4066 member net — with no plugin.
//      Today there is one: `scriptsBattery`, the `scripts/*.test.mjs` battery the core's
//      scripts-battery gate reads (in this repo the plugin fills it with nightly-windows-suite.mjs).
//   2. PROJECT-SUPPLIED `spine` MEMBERS (PROJECT_SPINE_DEFAULTS). Same idea, one member at a time,
//      inside the synthetic `spine` group.
//   3. PROJECT-PRIVATE GROUPS. Any other name the plugin chooses, read only by the project's own
//      modules. No core module reads one, so it needs no core default and no core edit: a plugin
//      adds one simply by returning it. It sits OUTSIDE the plan-4066 member net
//      (container-manifest.mjs), because that net is built from core modules' CONTAINER_READS
//      manifests and a core manifest can never name a group the core does not declare
//      (container-manifest.test.mjs pins that) — so there is nothing for the net to check.
//
// What a plugin may NOT do is REPLACE a group the core binds (every other LAND_DEPS_GROUPS name,
// or any group the command file passes) — withProjectGroups refuses that by name.
//
// Each default is the honest answer for a checkout with no project layer, never a guess that
// would let a real gate silently under-run: no battery targets, no worktree-branch commit guard,
// no pre-gate interlude. The two that can only be reached through a project gate (the battery cap
// and the changed-record cohort) THROW, naming the missing layer, instead of inventing a number or
// a cohort.
//
// A default carries every member the core reads (container-manifest.mjs's net asserts the bound
// container, defaults included, so a default missing a member fails the boot — never a quiet
// `undefined`), and container-manifest.test.mjs pins that against the manifests directly.
const noProjectLayer = (what) => () => {
  throw new Error(
    `deps.mjs: ${what} is supplied only by a project layer (scripts/project/land-plugin.mjs), ` +
      `and none is loaded in this checkout — the core reached a project-only path (plan 4096 T1)`,
  );
};

/** Core-read groups only a project supplies, keyed by group name — see this block's header. */
export const PROJECT_GROUP_DEFAULTS = Object.freeze({
  // The scripts battery's roster, file enumeration and whole-run cap. No project → no battery: no
  // targets, and a cap that refuses to be computed.
  scriptsBattery: Object.freeze({
    BATTERIES: Object.freeze([]),
    listScriptsTestFiles: () => [],
    batteryRunCapMs: noProjectLayer('scriptsBattery.batteryRunCapMs'),
  }),
});

/** Container group names a plugin may never use (see withProjectGroups). */
const RESERVED_GROUP_NAMES = new Set(['__proto__']);

/** `spine` members the core reads but only a project can implement — see this block's header. */
export const PROJECT_SPINE_DEFAULTS = Object.freeze({
  freeMemoryReading: () => 'free memory unknown (no project layer)',
  runNodeDepsPreflight: () => {},
  preflightInterlude: null,
  wikiDiffOnWorktreeBranch: () => null,
  WIKI_DIFF_RETRY_EXHAUSTED: Symbol('wikiDiffRetryExhausted (core default: never returned)'),
  LEDGER_FILES_ON_WORKTREE_BRANCH: Object.freeze([]),
  SWEEP_CHECKPOINT_PATHSPEC: Object.freeze([]),
  changedPriceClinics: noProjectLayer('spine.changedPriceClinics'),
});

const isPlainGroup = (g) => g !== null && typeof g === 'object' && !Array.isArray(g);

/**
 * Merge a project plugin's `containerGroups` (or `null` — no project layer) over the core
 * defaults and into the command file's own groups, producing the ONE object bindLandDeps() binds.
 *
 * Accepts, from the plugin: any PROJECT_GROUP_DEFAULTS group (over its default), `spine` members
 * that have a PROJECT_SPINE_DEFAULTS entry, and any project-private group (a name the core
 * neither declares nor binds), which passes through as-is.
 *
 * Refuses, by name: a plugin group that would REPLACE a group the core binds (a LAND_DEPS_GROUPS
 * name without a project default, or any name the command file's own groups carry); a plugin
 * group that is not a plain object; a project `spine` member without a core default here (every
 * project-suppliable member must have one, or the plugin-absent boot would miss it); and a core
 * group set that itself owns a project-suppliable group or `spine` member (one owner per name —
 * otherwise which side wins would depend on spread order).
 */
export function withProjectGroups(coreGroups, projectGroups = null) {
  if (!isPlainGroup(coreGroups)) {
    throw new Error('deps.mjs: withProjectGroups() needs the core groups object');
  }
  const raw = projectGroups ?? {};
  if (!isPlainGroup(raw)) {
    throw new Error(
      `deps.mjs: a project plugin's containerGroups must be a plain object — got ${Array.isArray(raw) ? 'an array' : typeof raw}`,
    );
  }
  // Only the plugin's OWN groups count. Copying them onto a null-prototype object once, here,
  // makes every read below own-only by construction, so nothing inherited — a `spine` or a
  // project-supplied group on the plugin object's prototype, or an Object.prototype name — can
  // leak into the merge (gpt-review 4096 rounds 3–5, one class). On a null-prototype target an
  // own `__proto__` key stays an ordinary key, so the reserved-name refusal below still sees it.
  const project = Object.assign(Object.create(null), raw);
  const coreBound = new Set([
    ...LAND_DEPS_GROUPS.filter((k) => !Object.hasOwn(PROJECT_GROUP_DEFAULTS, k) && k !== 'spine'),
    ...Object.keys(coreGroups).filter((k) => k !== 'spine'),
  ]);
  const replacing = Object.keys(project).filter((k) => coreBound.has(k));
  if (replacing.length) {
    throw new Error(
      `deps.mjs: a project plugin never replaces a core group — refused ${replacing.join(', ')} ` +
        `(a plugin supplies ${Object.keys(PROJECT_GROUP_DEFAULTS).join(', ')}, spine members with a ` +
        `PROJECT_SPINE_DEFAULTS entry, or a project-private group under a name the core does not bind)`,
    );
  }
  const notObjects = Object.keys(project).filter((k) => !isPlainGroup(project[k]));
  if (notObjects.length) {
    throw new Error(
      `deps.mjs: a project plugin's container group(s) ${notObjects.join(', ')} must each be a ` +
        `plain object`,
    );
  }
  // A group name becomes a property of the merged container, and an object spread or assignment
  // treats `__proto__` as the prototype setter, not a key — the group would vanish without a word
  // (gpt-review 4096 round 2). `__proto__` is the ONE such name; every other name, `constructor`
  // and `toString` included, is an ordinary own key because every membership test in this
  // function is an own-property test (round 3), never `in`.
  const reserved = Object.keys(project).filter((k) => RESERVED_GROUP_NAMES.has(k));
  if (reserved.length) {
    throw new Error(
      `deps.mjs: a project plugin may not name a container group ${reserved.join(', ')} — ` +
        `the name is prototype-special and would not survive the merge`,
    );
  }
  const coreSpine = coreGroups.spine ?? {};
  const shadowed = Object.keys(coreSpine).filter((k) => Object.hasOwn(PROJECT_SPINE_DEFAULTS, k));
  if (shadowed.length) {
    throw new Error(
      `deps.mjs: the core spine group sets project-suppliable member(s) ${shadowed.join(', ')} — ` +
        `those come from the project plugin or PROJECT_SPINE_DEFAULTS, never both`,
    );
  }
  const projectSpine = project.spine ?? {};
  const undeclared = Object.keys(projectSpine).filter(
    (k) => !Object.hasOwn(PROJECT_SPINE_DEFAULTS, k),
  );
  if (undeclared.length) {
    throw new Error(
      `deps.mjs: a project plugin supplied spine member(s) ${undeclared.join(', ')} with no core ` +
        `default in PROJECT_SPINE_DEFAULTS — add the default first, so the spine still boots without it`,
    );
  }
  const merged = { ...coreGroups };
  for (const [name, fallback] of Object.entries(PROJECT_GROUP_DEFAULTS)) {
    if (Object.hasOwn(coreGroups, name)) {
      throw new Error(
        `deps.mjs: the core groups set "${name}", a project-supplied group — it comes from the ` +
          `project plugin or PROJECT_GROUP_DEFAULTS, never both`,
      );
    }
    merged[name] = Object.hasOwn(project, name) ? project[name] : fallback;
  }
  // Project-private groups: every remaining plugin group that is neither a project-supplied core
  // group (merged just above) nor `spine` (merged just below).
  for (const [name, group] of Object.entries(project)) {
    if (name === 'spine' || Object.hasOwn(PROJECT_GROUP_DEFAULTS, name)) continue;
    merged[name] = group;
  }
  merged.spine = { ...PROJECT_SPINE_DEFAULTS, ...projectSpine, ...coreSpine };
  return merged;
}
