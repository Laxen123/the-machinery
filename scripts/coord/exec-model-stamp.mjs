#!/usr/bin/env node
// scripts/coord/exec-model-stamp.mjs — shared FABLE-/SOL- filename auto-stamp logic (plan
// 1362; extended to the `sol` lane by plan 3341).
//
// The `FABLE-` filename segment (`NNNN-FABLE-Category-slug.md`) mirrors a plan's
// `execModel: fable` frontmatter (plan 1292 work item 4) so the VS Code file tree —
// what the operator actually reads — visibly flags a fable-routed plan; plan 3341
// gives the `sol` lane the same treatment with a `SOL-` segment, mutually exclusive
// with `FABLE-` in one basename (renameForExecModel below replaces one marker with
// the other, it never produces both). Originally only scripts/stamp-exec-model.mjs
// (a manual CLI) kept the two in sync; every other HUSKY=0 writer that can introduce
// the drift (a fresh mint, a body edit that ADDS execModel: fable/sol, a status move)
// left it for the NEXT session's pre-push lint-filename-execmodel-drift.mjs to catch —
// plan 1362's whole point is self-lint at write time, not on the next unrelated
// pusher. This module is the shared core BOTH stamp-exec-model.mjs (the manual CLI)
// AND the three auto-stamping writers (next-plan-id.mjs claim, edit-plan.mjs,
// move-plan.mjs) call, so the rename shape and severity can never drift between them
// (D4 — shared logic by import, never copy).
//
// Exports:
//   renameForExecModel(basename, target) — pure basename transform (moved here
//     verbatim from stamp-exec-model.mjs, generalized to `sol` by plan 3341). Throws
//     on a basename that doesn't match the `<id>-<Category>-<slug>.md` shape.
//   canRenameForStatus(status) — never auto-rename in-progress/ (the basename is
//     worktree-coupled there) or archive/ (closed) — mirrors assertStampableStatus's
//     restriction below, but as a silent boolean the three auto-stamp callers use to
//     SKIP rather than throw (a hard-fail there would abort an unrelated write; the
//     lint's own one-way in-progress rule already tolerates a segment-less fable/sol
//     plan there, so skipping is correct, not a gap).
//   stampedRelForExecModel(rel, content) — the auto-stamp core (D2; generalized to
//     `sol` by plan 3341): given a plan's CURRENT rel path and its (about-to-be-
//     written) content, returns the FABLE-/SOL--stamped rel — same folder, only the
//     basename changes — or null when no rename is needed. Does NOT gate on
//     canRenameForStatus; callers already know their target status for their own
//     reasons and gate separately.
//   assertExecModelFilenameOk(relPath, content) — belt-and-suspenders (D2): re-runs
//     lint-filename-execmodel-drift.mjs's OWN check function against the file this
//     module just (re)named, so a rename-logic bug fails LOUD here instead of
//     silently landing the exact drift the pre-push lint exists to catch. Should be
//     unreachable once the three callers are wired correctly.
//   assertStampableStatus(status, basename) — the manual-CLI throwing guard
//     (stamp-exec-model.mjs), moved here verbatim so the ONE restriction lives once.
//   parseRemoteHeadTips(stdout) / planExecutionBranchRename(opts) /
//     applyExecutionBranchRename(opts) — plan 3919's raw-origin parser, read-only rename
//     planner, and post-master-push mutator. Splitting the last two keeps retryable preflight
//     incapable of changing origin before the plan-file stamp is durable.
//   categoryCarriesFableSegment(category) / categoryCarriesSolSegment(category) —
//     true when a `--category` value itself bakes in the `FABLE-`/`SOL-` segment
//     (e.g. `FABLE-DQ`), the REVERSE of the frontmatter→filename direction above
//     (plan 1561; the sol twin added by plan 3341 — both now WIRED into
//     ensureExecModelForCategory below, not merely parity vocabulary).
//   stripFableSegment(category) / stripSolSegment(category) — the same convention's
//     strip (plan 2329): `FABLE-DQ` → `DQ` (or `SOL-DQ` → `DQ`), unchanged when no
//     segment; each gated on its own categoryCarries*Segment so the strip shares ONE
//     shape source with the detection.
//   stripExecModelSegment(category) — the table-driven "strip WHICHEVER marker segment
//     this category carries, if any" (plan 3341) — next-plan-id.mjs's category-allowlist
//     gate uses this ONE call instead of chaining the per-lane strips above by hand.
//   ensureExecModelForCategory(content, category) — the reverse auto-stamp (plan
//     1561; made table-driven and extended to `sol` by plan 3341): back-fills the
//     matching `execModel:` into `content`'s frontmatter — creating the block if the
//     plan has none — when `category` carries a recognized marker segment but the
//     frontmatter doesn't say so yet, so next-plan-id's mint never hits
//     assertExecModelFilenameOk's "should be unreachable" drift on a frontmatter-less
//     marker-segment category body. Loops the SAME SEGMENT_CHECK_FOR_EXEC_MODEL table
//     stampedRelForExecModel reads, so a fourth segment-bearing lane needs one new
//     table row, never a second hardcoded branch here.

// plan 3341 review: LANE_SEGMENTS is lint-filename-execmodel-drift.mjs's single source for
// the lane/marker/test triple — this file used to re-implement that mapping locally as two
// separate hand-maintained tables (SEGMENT_CHECK_FOR_EXEC_MODEL, MARKER_FOR_TARGET) that
// could drift from the lint's own table (and from each other) as lanes were added. Both are
// now DERIVED from LANE_SEGMENTS below; hasFableSegment/hasSolSegment are no longer imported
// directly, since LANE_SEGMENTS already carries each lane's test function.
import {
  LANE_SEGMENTS,
  readExecModel,
  findExecModelDrift,
} from './lint-filename-execmodel-drift.mjs';
// plan 3341 delta-review follow-up (key 4fb6b9): the marker group used to be hardcoded
// here as its own `(FABLE-|SOL-)?` regex fragment — a SEPARATE grammar from the one
// LANE_SEGMENTS/MARKER_FOR_TARGET below already derive from plan-lane-segments.mjs. A
// future lane's marker could be GENERATED into LANE_SEGMENTS while this basename regex
// stayed unaware of it, so restamping an already-marked basename for that lane would
// fail to parse it (the whole basename falls into the `rest` capture, marker and all),
// risking a duplicated marker and a filename/frontmatter drift that blocks the move or
// push. LANE_MARKER_ALTERNATION (plan-lane-segments.mjs) is the SAME escaped alternation
// move-plan.mjs's rename grammar reads — importing it here instead of re-typing the
// marker literals keeps this file's basename grammar unable to disagree with it.
import { LANE_MARKER_ALTERNATION } from './plan-lane-segments.mjs';
import {
  readFrontmatterScalar,
  upsertFrontmatterKey,
  IN_PROGRESS_FOLDER,
  ARCHIVE_FOLDER,
  PARKED_FOLDER,
} from './build-index-lib.mjs';
import { execModelDefaultLane } from './exec-model-default-lib.mjs';

const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });

// The execution-branch namespace is an axis of the existing branch, not a property of the
// target lane. queue-drain.mjs owns the canonical execution-branch grammar; repeating its two
// prefixes here is intentional because this shared library must keep its seven-module static
// graph. The CLI injects the heavy queue authority instead of importing more of that graph here.
export const EXECUTION_BRANCH_PREFIXES = ['worktree-', 'claude/drain-'];

export function parseRemoteHeadTips(stdout) {
  const tips = new Map();
  for (const line of String(stdout || '').split(/\r?\n/u)) {
    const [sha, ref] = line.trim().split(/\s+/u);
    if (sha && ref?.startsWith('refs/heads/')) tips.set(ref.slice('refs/heads/'.length), sha);
  }
  return tips;
}

function remotePatterns(planId, ...basenames) {
  // Plan 3919 fix c2f4e2: execution slugs preserve the filename's literal id spelling,
  // while claim/oracle keys intentionally use the canonical numeric spelling.
  const ids = new Set([String(planId)]);
  for (const basename of basenames) {
    const literalId = /^(\d+)-/u.exec(basename || '')?.[1];
    if (literalId) ids.add(literalId);
  }
  return [...ids].flatMap((id) =>
    EXECUTION_BRANCH_PREFIXES.map((prefix) => `refs/heads/${prefix}${id}-*`),
  );
}

const defaultDescribeHolder = (claim) => {
  const holder = claim?.holder;
  return holder
    ? `${holder.sessionUuid || 'unknown session'}${holder.host ? ` on ${holder.host}` : ''}`
    : 'an unknown holder';
};

function recovery(planId, mainDir, sources, destination) {
  const sourceRefs = sources?.length ? sources : [{ name: '<source-ref>', sha: '<source-sha>' }];
  const sourceSha = sourceRefs[0].sha || '<source-sha>';
  const destinationName = destination?.name || '<destination-ref>';
  const deleteRefs = sourceRefs.filter(({ name }) => name !== destinationName);
  const git = `git -C ${JSON.stringify(mainDir || '.')}`;
  return (
    `\nRefs involved: ${sourceRefs.map(({ name, sha }) => `${name}@${sha}`).join(', ')}` +
    `\nAfter inspecting origin, recover with:\n` +
    `${git} push --force-with-lease=refs/heads/${destinationName}: origin ` +
    `${sourceSha}:refs/heads/${destinationName}\n` +
    deleteRefs
      .map(
        ({ name, sha }) =>
          `${git} push --force-with-lease=refs/heads/${name}:${sha} origin :refs/heads/${name}\n`,
      )
      .join('') +
    `node scripts/plan-adopt-branch.mjs ${planId}`
  );
}

function refusal(message, planId, source, destination, mainDir, sources = [source]) {
  return fatal(`${message}${recovery(planId, mainDir, sources, destination)}`);
}

// Plan 3919: preflight plans from two joined views but mutates neither. Raw ls-remote owns
// existence; the oracle map contributes liveness only. Keeping this synchronous preserves
// stamp-lib's synchronous preflight contract and keeps the shared module's import graph light.
export function planExecutionBranchRename({
  mainDir,
  planId,
  oldBasename,
  newBasename,
  body,
  branchMap,
  lsRemote,
  claimStatus,
  collapse,
  applyAdopt,
  branchName = (prefix, slug) => `${prefix}${slug}`,
  describeHolder = defaultDescribeHolder,
  log = console.error,
}) {
  void log;
  if (!planId)
    return {
      action: 'noop-idless',
      planId: null,
      sourceRefs: [],
      destination: null,
      adoptAction: 'noop',
      adoptBranch: null,
    };
  if (!(branchMap instanceof Map) || !lsRemote || !claimStatus || !collapse || !applyAdopt)
    throw new TypeError('planExecutionBranchRename requires injected branch authorities');

  const status = claimStatus(mainDir, planId);
  if (status?.held && !status.youAreHolder) {
    const holder = describeHolder(status);
    throw fatal(
      `stamp-exec-model: refusing to rename plan ${planId}'s execution branch — plan ${planId} ` +
        `is HELD by ${holder}. Release the claim or stamp after the land; nothing was changed.`,
    );
  }

  const oldSlug = oldBasename.replace(/\.md$/u, '');
  const newSlug = newBasename.replace(/\.md$/u, '');
  const oldCandidates = EXECUTION_BRANCH_PREFIXES.map((prefix) => branchName(prefix, oldSlug));
  const newCandidates = EXECUTION_BRANCH_PREFIXES.map((prefix) => branchName(prefix, newSlug));
  const projectedDestinationFor = ({ name, sha }) => {
    const namespaceIndex = EXECUTION_BRANCH_PREFIXES.findIndex((prefix) => name.startsWith(prefix));
    return { name: newCandidates[Math.max(0, namespaceIndex)], sha };
  };
  const expected = new Set([...oldCandidates, ...newCandidates]);
  // A failed timed read is a fatal, side-effect-free preflight refusal. Let the authority's
  // original error through so connectivity diagnostics are not hidden by a generic wrapper.
  const patterns = remotePatterns(planId, oldBasename, newBasename);
  const rawTips = parseRemoteHeadTips(lsRemote(mainDir, patterns));
  const unexpected = [...rawTips].filter(([name]) => !expected.has(name));
  if (unexpected.length) {
    const [sourceName, sourceSha] = unexpected[0];
    throw refusal(
      `stamp-exec-model: refusing to rename ${oldBasename} — origin carries unexpected ` +
        `execution ref(s) ${[...rawTips].map(([n, s]) => `${n}@${s}`).join(', ')}; which slug ` +
        'is truth is a human call.',
      planId,
      { name: sourceName, sha: sourceSha },
      projectedDestinationFor({ name: sourceName, sha: sourceSha }),
      mainDir,
      [...rawTips].map(([name, sha]) => ({ name, sha })),
    );
  }

  const oracleByName = new Map(
    (branchMap.get(String(planId)) || []).map((entry) => [entry.name, entry]),
  );
  const merged = [];
  for (const [name, sha] of rawTips) {
    const oracle = oracleByName.get(name);
    if (!oracle)
      throw refusal(
        `stamp-exec-model: refusing to reconcile ${name}@${sha} — it exists on origin, but ` +
          `the oracle's liveness-filtered view does not carry it (a dead-seed marker or a head ` +
          'whose liveness probe was dropped). Its liveness is UNKNOWN and reconciling it is a ' +
          'human call.',
        planId,
        { name, sha },
        projectedDestinationFor({ name, sha }),
        mainDir,
        [...rawTips].map(([rawName, rawSha]) => ({ name: rawName, sha: rawSha })),
      );
    // Plan 3919 fix c9d9f4: name equality does not make liveness metadata portable
    // across commits. A moved origin head is unknown under the older oracle snapshot.
    if (oracle.sha !== sha)
      throw refusal(
        `stamp-exec-model: refusing to reconcile ${name} — origin moved under the oracle ` +
          `snapshot: oracle carried ${oracle.sha}, origin now carries ${sha}. Its liveness is ` +
          'UNKNOWN and reconciling it is a human call.',
        planId,
        { name, sha },
        projectedDestinationFor({ name, sha }),
        mainDir,
        [...rawTips].map(([rawName, rawSha]) => ({ name: rawName, sha: rawSha })),
      );
    merged.push({ ...oracle, name, sha });
  }

  // Plan 3919 fix 677b37: collapseSameShaBranches only arbitrates multi-ref sets. A
  // singleton live/unknown head is equally hands-off and must not reach the mutator.
  const unsafe = merged.find((entry) => entry.fresh || entry.livenessUnknown);
  if (unsafe) {
    const reason = unsafe.livenessUnknown
      ? 'its liveness probe failed'
      : 'the oracle reports it live';
    throw refusal(
      `stamp-exec-model: refusing to reconcile ${unsafe.name}@${unsafe.sha} — ${reason}; ` +
        'stamp after that session lands.',
      planId,
      unsafe,
      projectedDestinationFor(unsafe),
      mainDir,
      merged,
    );
  }

  const oldRefs = merged.filter((entry) => oldCandidates.includes(entry.name));
  const newRefs = merged.filter((entry) => newCandidates.includes(entry.name));
  const distinctShas = new Set(merged.map((entry) => entry.sha));
  if (distinctShas.size > 1) {
    const source = merged[0];
    throw refusal(
      `stamp-exec-model: refusing to reconcile divergent refs ${merged
        .map((entry) => `${entry.name}@${entry.sha}`)
        .join(', ')} — which is truth is a human call.`,
      planId,
      source,
      projectedDestinationFor(source),
      mainDir,
      merged,
    );
  }

  let action = 'none';
  let destination = null;
  if (oldRefs.length === 0 && newRefs.length > 0) {
    const collapsed = collapse(newRefs).branches;
    if (collapsed.length !== 1)
      throw refusal(
        `stamp-exec-model: refusing to reconcile new refs ${newRefs
          .map((entry) => entry.name)
          .join(', ')} — their liveness metadata forbids choosing one; which namespace is truth ` +
          'is a human call.',
        planId,
        newRefs[0],
        newRefs[1],
        mainDir,
        newRefs,
      );
    action = 'already-new';
    destination = { name: collapsed[0].name, sha: collapsed[0].sha };
  } else if (oldRefs.length > 0) {
    const collapsed = collapse(oldRefs).branches;
    if (collapsed.length !== 1)
      throw refusal(
        `stamp-exec-model: refusing to reconcile old refs ${oldRefs
          .map((entry) => entry.name)
          .join(', ')} — their liveness metadata forbids choosing one; which namespace is truth ` +
          'is a human call.',
        planId,
        oldRefs[0],
        projectedDestinationFor(oldRefs[0]),
        mainDir,
        oldRefs,
      );
    const preferred = collapsed[0];
    const namespaceIndex = oldCandidates.indexOf(preferred.name);
    destination = { name: newCandidates[namespaceIndex], sha: preferred.sha };
    const matchingDestination = newRefs.find((entry) => entry.name === destination.name);
    const opposite = newRefs.find((entry) => entry.name !== destination.name);
    if (opposite)
      throw refusal(
        `stamp-exec-model: refusing mixed-namespace refs ${preferred.name}@${preferred.sha} and ` +
          `${opposite.name}@${opposite.sha}; the destination namespace must follow the source, ` +
          'and choosing between these is a human call.',
        planId,
        preferred,
        destination,
        mainDir,
        oldRefs,
      );
    action = matchingDestination ? 'finish-delete' : 'rename';
  }

  const projectedNames = destination ? [destination.name] : [];
  const adopt = applyAdopt(body, projectedNames);
  return {
    action,
    planId,
    sourceRefs: oldRefs.map(({ name, sha }) => ({ name, sha })),
    destination: destination ? { ...destination } : null,
    adoptAction: adopt.action,
    adoptBranch: adopt.branch,
    patterns,
    expectedRefs: [...expected],
  };
}

// Plan 3919: this is the only remote mutator, and stamp-lib invokes it only after the plan-file
// commit is durable on origin. The second raw read rejects a stale preflight snapshot; the empty
// destination lease then closes the final check-to-push race atomically.
export function applyExecutionBranchRename({
  mainDir,
  plan,
  gitImpl,
  lsRemote,
  claimStatus,
  describeHolder = defaultDescribeHolder,
  log = console.error,
}) {
  if (plan.action === 'noop-idless') return { action: plan.action, mutated: false };

  const patterns = plan.patterns || remotePatterns(plan.planId);
  if (['none', 'already-new'].includes(plan.action)) {
    // Plan 3919 fix 6f7056: the stamp is durable, so drift here is advisory and points at
    // the authority that can re-sync adoptBranch instead of failing the completed stamp.
    try {
      const observed = parseRemoteHeadTips(lsRemote(mainDir, patterns));
      const expected =
        plan.action === 'already-new' && plan.destination
          ? new Map([[plan.destination.name, plan.destination.sha]])
          : new Map();
      const matches =
        observed.size === expected.size &&
        [...expected].every(([name, sha]) => observed.get(name) === sha);
      if (!matches)
        log(
          `stamp-exec-model: WARNING — stamped branch ${plan.adoptBranch || '<none>'}, but ` +
            `origin now carries ${
              [...observed].map(([name, sha]) => `${name}@${sha}`).join(', ') || '<none>'
            }; run node scripts/plan-adopt-branch.mjs ${plan.planId} to re-sync.`,
        );
    } catch (error) {
      log(
        `stamp-exec-model: WARNING — stamped branch ${plan.adoptBranch || '<none>'}, but ` +
          `origin could not be re-read (${error.message}); run node ` +
          `scripts/plan-adopt-branch.mjs ${plan.planId} to re-sync.`,
      );
    }
    return { action: plan.action, mutated: false, destination: plan.destination, leftovers: [] };
  }

  // Plan 3919 round-2 finding 351: preflight is not a lock, but only an action that will mutate
  // execution refs may reject a late claim after the plan-file stamp is already durable.
  const status = claimStatus?.(mainDir, plan.planId);
  if (status?.held && !status.youAreHolder) {
    const holder = describeHolder(status);
    throw fatal(
      `stamp-exec-model: refusing to rename plan ${plan.planId}'s execution branch — plan ` +
        `${plan.planId} is HELD by ${holder}. Release the claim or stamp after the land; ` +
        'nothing was changed.',
    );
  }

  const tips = parseRemoteHeadTips(lsRemote(mainDir, patterns));
  const destination = { ...plan.destination };
  const sourceRefs = plan.sourceRefs.map((entry) => ({ ...entry }));
  const unexpected = [...tips].filter(
    ([name]) => plan.expectedRefs && !plan.expectedRefs.includes(name),
  );
  if (unexpected.length) {
    const [name, sha] = unexpected[0];
    throw refusal(
      `stamp-exec-model: refusing to rename — origin carries unexpected execution ref(s) ` +
        `${[...tips].map(([n, s]) => `${n}@${s}`).join(', ')}; which slug is truth is a human call.`,
      plan.planId,
      { name, sha },
      destination,
      mainDir,
      sourceRefs,
    );
  }
  for (const source of sourceRefs) {
    const actual = tips.get(source.name);
    if (actual !== source.sha)
      throw refusal(
        `stamp-exec-model: refusing stale copy from ${source.name}: expected ${source.sha}, ` +
          `origin now has ${actual || 'no ref'}; destination ${destination.name} was not copied.`,
        plan.planId,
        source,
        destination,
        mainDir,
        sourceRefs,
      );
  }
  const destinationTip = tips.get(destination.name);
  if (destinationTip && destinationTip !== destination.sha)
    throw refusal(
      `stamp-exec-model: refusing to copy ${sourceRefs.map((r) => r.name).join(', ')} to ` +
        `${destination.name}: expected destination ${destination.sha}, origin has ${destinationTip}; ` +
        'nothing was overwritten.',
      plan.planId,
      sourceRefs[0],
      destination,
      mainDir,
      sourceRefs,
    );

  let renameAlreadyCompleted = false;
  if (!destinationTip) {
    // Plan 3919 round-2 finding 432: fetch only when the copy needs an object absent locally,
    // and classify fetch/verification failures through the same recovery path as the push.
    const fetchedSource = sourceRefs[0];
    try {
      let objectIsLocal = true;
      try {
        gitImpl(mainDir, ['cat-file', '-e', `${fetchedSource.sha}^{commit}`]);
      } catch {
        objectIsLocal = false;
      }
      if (!objectIsLocal) {
        gitImpl(mainDir, ['fetch', 'origin', `refs/heads/${fetchedSource.name}`]);
        const fetchedTip = String(gitImpl(mainDir, ['rev-parse', 'FETCH_HEAD']) || '').trim();
        if (fetchedTip !== fetchedSource.sha)
          throw new Error(
            `fetched source ${fetchedSource.name} moved: expected ${fetchedSource.sha}, ` +
              `fetched ${fetchedTip || 'no sha'}`,
          );
      }
      // Plan 3919 round-3 findings 434/436/440: object availability and source freshness are
      // separate. Re-read both sides immediately before the copy on local-object and fetch paths.
      const copyTips = parseRemoteHeadTips(lsRemote(mainDir, patterns));
      const copyUnexpected = [...copyTips].filter(
        ([name]) => plan.expectedRefs && !plan.expectedRefs.includes(name),
      );
      if (copyUnexpected.length) {
        const [name, sha] = copyUnexpected[0];
        throw refusal(
          `stamp-exec-model: refusing final pre-copy read — origin carries unexpected execution ` +
            `ref(s) ${[...copyTips].map(([n, s]) => `${n}@${s}`).join(', ')}; nothing was copied.`,
          plan.planId,
          { name, sha },
          destination,
          mainDir,
          sourceRefs,
        );
      }
      for (const source of sourceRefs) {
        const actualSource = copyTips.get(source.name);
        if (actualSource !== source.sha)
          throw refusal(
            `stamp-exec-model: refusing stale copy from ${source.name}: expected ${source.sha}, ` +
              `origin now has ${actualSource || 'no ref'}; destination ${destination.name} was ` +
              'not copied.',
            plan.planId,
            source,
            destination,
            mainDir,
            sourceRefs,
          );
      }
      const actualDestination = copyTips.get(destination.name);
      if (actualDestination && actualDestination !== destination.sha)
        throw refusal(
          `stamp-exec-model: refusing to copy to ${destination.name}: expected destination absent ` +
            `or at ${destination.sha}, origin now has ${actualDestination}; nothing was overwritten.`,
          plan.planId,
          sourceRefs[0],
          destination,
          mainDir,
          sourceRefs,
        );
      gitImpl(mainDir, [
        'push',
        `--force-with-lease=refs/heads/${destination.name}:`,
        'origin',
        `${destination.sha}:refs/heads/${destination.name}`,
      ]);
    } catch (copyError) {
      if (copyError.fatal) throw copyError;
      // Plan 3919 fix 7e461b: distinguish an accepted-but-lost reply, a real lease loss,
      // and a transport failure before reporting what happened.
      let refreshed;
      try {
        refreshed = parseRemoteHeadTips(lsRemote(mainDir, patterns));
      } catch (readError) {
        throw refusal(
          `stamp-exec-model: copy to ${destination.name} failed (${copyError.message}) and the ` +
            `outcome is unknown because origin re-read failed (${readError.message}).`,
          plan.planId,
          sourceRefs[0],
          destination,
          mainDir,
          sourceRefs,
        );
      }
      const refreshedUnexpected = [...refreshed].find(
        ([name]) => plan.expectedRefs && !plan.expectedRefs.includes(name),
      );
      if (refreshedUnexpected) {
        const [name, sha] = refreshedUnexpected;
        throw refusal(
          `stamp-exec-model: refusing copy recovery because unexpected execution ref ${name}@${sha} ` +
            `appeared; ${destination.name} was not treated as reconciled.`,
          plan.planId,
          { name, sha },
          destination,
          mainDir,
          sourceRefs,
        );
      }
      const actual = refreshed.get(destination.name);
      // Plan 3919 round-3 finding 472: a lost copy reply can be followed by another actor
      // retiring every source. Destination-at-plan plus absent sources means the rename finished.
      if (actual === destination.sha && sourceRefs.every((source) => !refreshed.has(source.name))) {
        renameAlreadyCompleted = true;
      } else {
        // Plan 3919 round-2 finding 464: a destination-only check can misreport a source race as
        // lease loss. Reconcile the complete planned source set before classifying the destination.
        for (const source of sourceRefs) {
          const actualSource = refreshed.get(source.name);
          if (actualSource !== source.sha)
            throw refusal(
              `stamp-exec-model: refusing copy recovery because source ${source.name} moved: ` +
                `expected ${source.sha}, origin now has ${actualSource || 'no ref'}; ` +
                `${destination.name} was not treated as reconciled.`,
              plan.planId,
              source,
              destination,
              mainDir,
              sourceRefs,
            );
        }
      }
      if (actual !== destination.sha) {
        const detail = actual
          ? `the destination now has ${actual}, so the empty-value lease was lost`
          : `nothing was copied; the destination is still absent; push failed: ${copyError.message}`;
        throw refusal(
          `stamp-exec-model: refusing to copy to ${destination.name} at ${destination.sha} — ` +
            `${detail}; source ref(s) were not retired.`,
          plan.planId,
          sourceRefs[0],
          destination,
          mainDir,
          sourceRefs,
        );
      }
    }
  }

  if (renameAlreadyCompleted)
    return { action: 'renamed', mutated: true, destination, leftovers: [] };

  const leftovers = [];
  let leftoverKind = null;
  for (const source of sourceRefs) {
    try {
      gitImpl(mainDir, [
        'push',
        '--atomic',
        `--force-with-lease=refs/heads/${source.name}:${source.sha}`,
        `--force-with-lease=refs/heads/${destination.name}:${destination.sha}`,
        'origin',
        `:refs/heads/${source.name}`,
        `${destination.sha}:refs/heads/${destination.name}`,
      ]);
    } catch {
      try {
        const refreshed = parseRemoteHeadTips(lsRemote(mainDir, patterns));
        const actual = refreshed.get(source.name);
        if (!actual) {
          if (refreshed.get(destination.name) === destination.sha) continue;
          // Plan 3919 round-3 finding 527: source absence proves the delete only when the
          // installed destination still carries the planned commit. Both refs gone is divergence.
          leftovers.push(source.name);
          leftoverKind = 'divergent';
          log(
            `stamp-exec-model: WARNING — DIVERGENT refs ${source.name}@missing and ` +
              `${destination.name}@${refreshed.get(destination.name) || 'missing'} remain after ` +
              'the leased delete failed; this is a human call.',
          );
          continue;
        }
        leftovers.push(source.name);
        if (actual === destination.sha && refreshed.get(destination.name) === destination.sha) {
          if (leftoverKind === null) leftoverKind = 'same-sha';
          log(
            `stamp-exec-model: WARNING — origin kept leftover ref ${source.name} after ` +
              `${destination.name} was installed at the same sha; run ` +
              "this project's dead-claims reaper with `--gc-refs --apply` during the coordination-ref " +
              'cleanup chore.',
          );
        } else {
          if (leftoverKind !== 'unknown') leftoverKind = 'divergent';
          log(
            `stamp-exec-model: WARNING — DIVERGENT refs ${source.name}@${actual} and ` +
              `${destination.name}@${refreshed.get(destination.name) || 'missing'} remain after ` +
              'the leased delete failed; this is a human call.',
          );
        }
      } catch {
        leftovers.push(source.name);
        leftoverKind = 'unknown';
        log(
          `stamp-exec-model: WARNING — the leased delete of ${source.name} failed after ` +
            `${destination.name} was installed, and origin could not be re-read; the remaining ` +
            'refs are unknown.',
        );
      }
    }
  }

  return {
    action:
      leftoverKind === 'unknown'
        ? 'renamed-leftover-unknown'
        : leftoverKind === 'divergent'
          ? 'renamed-leftover-divergent'
          : leftovers.length
            ? 'renamed-leftover'
            : 'renamed',
    mutated: true,
    destination,
    leftovers,
  };
}

// Basename shape: `<id>-<optional FABLE- or SOL- segment><rest>.md`. `rest` is
// whatever follows the id (and the marker segment, if present) — the
// Category-slug.md tail. The alternation is a single capture group, so a basename
// can only ever carry ONE of the two markers by construction (plan 3341) — there is
// no shape this regex accepts that has both. The marker group itself is DERIVED from
// LANE_MARKER_ALTERNATION (plan-lane-segments.mjs), not hand-typed, so a fourth
// segment-bearing lane's marker is recognized here automatically.
export const BASENAME_RX = new RegExp(`^(\\d{3,})-(${LANE_MARKER_ALTERNATION})?(.+)$`);

// The basename marker segment for each execModel target that carries one; `sonnet`
// (and, defensively, anything else) carries none. DERIVED from LANE_SEGMENTS (plan 3341
// review) — extend the table there when a fourth lane needs its own segment, never by
// adding another `target === '<lane>'` branch or a second hand-typed map here.
const MARKER_FOR_TARGET = Object.fromEntries(
  LANE_SEGMENTS.map(({ lane, marker }) => [lane, marker]),
);

// plan 3341 review round 3 (key 2d6c4b): MARKER_FOR_TARGET/SEGMENT_CHECK_FOR_EXEC_MODEL are
// plain object literals, so a bare `table[key]` lookup can resolve an INHERITED
// Object.prototype property (constructor, toString, valueOf, hasOwnProperty, __proto__, …)
// for a key that was never one of this table's real entries — truthy, so a `!result` guard
// doesn't catch it. In stampedRelForExecModel below the resolved value then gets CALLED as a
// function, crashing the write (`TypeError: hasSegmentCheck is not a function`) instead of
// cleanly returning null for an unrecognized lane. Own-property lookup used wherever the key
// can arrive from something OTHER than this table's own generated key set (readExecModel
// against untrusted plan frontmatter, or a caller-supplied CLI `target`) — see each call
// site's own comment for why a given lookup does or doesn't need it.
function ownLookup(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// The renamed basename for `target` (fable|sonnet|sol), or the SAME basename when
// the marker segment already agrees with the target (idempotent re-stamp — no
// double segment, no accidental strip). A target whose marker differs from what's
// currently there REPLACES it (never stacks both) — this is what makes FABLE-/SOL-
// mutually exclusive by construction rather than by a separate check (plan 3341).
// Throws if `basename` doesn't match the expected `<id>-...` shape at all (a
// malformed plan filename, caught here rather than silently mis-renaming).
export function renameForExecModel(basename, target) {
  const m = basename.match(BASENAME_RX);
  if (!m)
    throw fatal(
      `exec-model-stamp: basename "${basename}" doesn't match the expected ` +
        `<id>-<Category>-<slug>.md shape — refusing to guess a rename.`,
    );
  const [, id, currentMarker, rest] = m;
  // plan 3341 review round 3 (key 2d6c4b sweep): `target` is validated against
  // VALID_EXEC_MODELS by every CURRENT caller (stamp-exec-model.mjs's CLI via assertOneOf,
  // next-plan-id.mjs's onPick via an EXEC_MODELS_WITH_SEGMENT membership check) before it
  // ever reaches here — so this is a defensive hardening, not a fix for a reachable bug
  // today. Own-property lookup so a future/unvalidated caller passing e.g. `target:
  // "hasOwnProperty"` degrades to the safe `''` fallback (an unrenamed basename) instead of
  // resolving an inherited Object.prototype function that then gets string-interpolated
  // into the returned filename below (`[object Object]`/`function …` corruption, not a
  // crash — `!==` against a function is merely always false, no TypeError here).
  const wantMarker = ownLookup(MARKER_FOR_TARGET, target) || '';
  if ((currentMarker || '') === wantMarker) return basename; // already correct — no-op
  return `${id}-${wantMarker}${rest}`;
}

// Never auto-rename in-progress/ (the basename is coupled to the worktree
// slug/branch there — a rename would desync them), archive/ (closed; nothing to
// route), or parked/ (frozen long-term, plan 1426 — a park is a PLAIN move; the
// filename must not churn on it). Every other status folder is fair game for the
// auto-stamp.
export function canRenameForStatus(status) {
  return status !== IN_PROGRESS_FOLDER && status !== ARCHIVE_FOLDER && status !== PARKED_FOLDER;
}

// Which hasXSegment check applies for a segment-bearing execModel — the fast-path
// "already correctly marked, nothing to do" test below. Only the two lanes that
// actually carry a segment appear here; sonnet (or anything unrecognized) is handled
// by the caller's `!hasSegmentCheck` bail before this map is even consulted. DERIVED
// from LANE_SEGMENTS (plan 3341 review), same source as MARKER_FOR_TARGET above — a
// fourth segment-bearing lane needs one new LANE_SEGMENTS row, never a second map here.
const SEGMENT_CHECK_FOR_EXEC_MODEL = Object.fromEntries(
  LANE_SEGMENTS.map(({ lane, test }) => [lane, test]),
);

// The auto-stamp core (plan 1362, D2; generalized to `sol` by plan 3341). Given a
// plan's CURRENT rel path and its (about to be written) content, returns the
// FABLE-/SOL--stamped rel — same folder, only the basename changes — when
// execModel: fable/sol is set and the basename doesn't already carry the matching
// segment. Returns null when: execModel isn't a segment-bearing lane, the segment is
// already present, or the basename doesn't match the expected shape (a
// malformed/foreign filename — not this auto-stamp's job to fix; the pre-push lint
// still catches a genuine drift there).
export function stampedRelForExecModel(rel, content) {
  const execModel = readExecModel(content);
  // plan 3341 review round 3 (key 2d6c4b, CONFIRMED crash): `execModel` comes straight from
  // plan frontmatter — UNTRUSTED. A bare `SEGMENT_CHECK_FOR_EXEC_MODEL[execModel]` lookup
  // resolves `execModel: __proto__` (or constructor/toString/hasOwnProperty/…) to an
  // inherited, truthy Object.prototype value, which the `!hasSegmentCheck` guard below then
  // fails to catch — and `hasSegmentCheck(basename)` a few lines down CALLS it as a function,
  // throwing `TypeError: hasSegmentCheck is not a function` and aborting the write (in
  // edit-plan.mjs/move-plan.mjs) instead of cleanly returning null for an unrecognized lane.
  // Own-property lookup closes it: any key not one of LANE_SEGMENTS' real lanes now resolves
  // to `undefined`, same as a genuinely absent/sonnet execModel always did.
  const hasSegmentCheck = ownLookup(SEGMENT_CHECK_FOR_EXEC_MODEL, execModel);
  if (!hasSegmentCheck) return null;
  const idx = rel.lastIndexOf('/');
  const dir = rel.slice(0, idx + 1);
  const basename = rel.slice(idx + 1);
  if (hasSegmentCheck(basename)) return null;
  let newBasename;
  try {
    newBasename = renameForExecModel(basename, execModel);
  } catch {
    return null;
  }
  return newBasename === basename ? null : dir + newBasename;
}

// The table-driven core (plan 3341) behind BOTH categoryCarries*Segment functions AND
// ensureExecModelForCategory below: true when `category` (the raw --category value,
// BEFORE the id/slug are glued on) already bakes `execModel`'s marker segment in — e.g.
// `--category FABLE-DQ` for `fable` — rather than relying on the frontmatter->filename
// rename direction above. Checked via SEGMENT_CHECK_FOR_EXEC_MODEL's hasXSegment against
// a synthetic 3-digit-id basename so this can never drift from the exact shape the
// pre-push lint / findExecModelDrift flags on the real minted filename (the id's own
// digits never affect the match). `execModel` not in the table (sonnet, or a future
// non-segment-bearing lane) is unconditionally false — nothing to detect.
//
// plan 3341 review round 3 (key 2d6c4b sweep): bare bracket lookup left AS-IS here,
// deliberately — traced every call site (categoryCarriesFableSegment/-SolSegment below
// pass the hardcoded literal 'fable'/'sol'; stripExecModelSegment and
// ensureExecModelForCategory further down both loop `Object.keys(SEGMENT_CHECK_FOR_EXEC_
// MODEL)`, i.e. that SAME table's own generated keys). `execModel` here can therefore never
// be a value outside this table's closed, self-generated key set — never plan frontmatter,
// never a CLI argument — so there is no untrusted-key path into this lookup to harden. Not
// the same shape as the stampedRelForExecModel/renameForExecModel fixes above.
function categoryCarriesSegmentFor(execModel, category) {
  const hasSegmentCheck = SEGMENT_CHECK_FOR_EXEC_MODEL[execModel];
  return hasSegmentCheck ? hasSegmentCheck(`000-${category}-x.md`) : false;
}

export function categoryCarriesFableSegment(category) {
  return categoryCarriesSegmentFor('fable', category);
}

// plan 3341: the `sol` twin of categoryCarriesFableSegment above, now WIRED into
// ensureExecModelForCategory below (not merely parity vocabulary — see that function's
// header for the drift this closes).
export function categoryCarriesSolSegment(category) {
  return categoryCarriesSegmentFor('sol', category);
}

// Strip the `FABLE-` exec-model segment off a raw `--category` value (`FABLE-DQ` ->
// `DQ`), or return it unchanged when it carries none (plan 2329). Gated on
// categoryCarriesFableSegment so the strip decision and the segment detection share
// the ONE shape source (FABLE_SEGMENT_RX) — no second hardcoded `/^FABLE-/` literal to
// drift. Callers that need the bare category (e.g. next-plan-id's category-allowlist
// gate) use this rather than re-encoding the prefix.
export function stripFableSegment(category) {
  return categoryCarriesFableSegment(category) ? category.slice('FABLE-'.length) : category;
}

// plan 3341: the `sol` twin of stripFableSegment above, gated on
// categoryCarriesSolSegment for the same shape-source reason.
export function stripSolSegment(category) {
  return categoryCarriesSolSegment(category) ? category.slice('SOL-'.length) : category;
}

// plan 3341: the table-driven "strip WHICHEVER marker segment (if any) this category
// carries" — one call for next-plan-id.mjs's category-allowlist gate to make, instead of
// chaining stripFableSegment/stripSolSegment/… by hand for every lane (a chain that would
// need one more link per future lane). Loops the SAME SEGMENT_CHECK_FOR_EXEC_MODEL/
// MARKER_FOR_TARGET tables everything else in this file reads; a category carrying no
// recognized marker segment (or already bare) is returned unchanged.
//
// plan 3341 review round 3 (key 2d6c4b sweep): `MARKER_FOR_TARGET[execModel]` below is a
// bare bracket lookup too, but `execModel` here is drawn from
// `Object.keys(SEGMENT_CHECK_FOR_EXEC_MODEL)` — that table's OWN enumerable keys, which
// `Object.keys` never extends to the prototype chain — so it is always a real own key of
// MARKER_FOR_TARGET as well (both are built from the same LANE_SEGMENTS `lane` field).
// Never plan frontmatter, never a CLI argument: no untrusted-key path reaches this one.
export function stripExecModelSegment(category) {
  for (const execModel of Object.keys(SEGMENT_CHECK_FOR_EXEC_MODEL)) {
    if (categoryCarriesSegmentFor(execModel, category)) {
      return category.slice(MARKER_FOR_TARGET[execModel].length);
    }
  }
  return category;
}

// The reverse auto-stamp (plan 1561; made table-driven and extended to `sol` by plan
// 3341): given a plan body about to be minted under `category`, back-fill the matching
// `execModel:` into its frontmatter when the CATEGORY already carries a marker segment
// but the frontmatter doesn't say so yet — upsertFrontmatterKey creates the leading
// `---` block when the body has none, so this works identically whether `content`
// already has frontmatter or not. Returns `content` unchanged when the category carries
// no recognized marker segment at all; `keepExisting` also makes it a no-op whenever an
// `execModel:` key is already present — any value — so an author's own value (even one
// that disagrees) is never silently overwritten: a residual sonnet/FABLE- (or
// sonnet/SOL-) conflict is a real authoring error for the operator to resolve, not this
// helper's job to paper over.
//
// plan 3341: this used to be a hardcoded fable-only branch — `--category SOL-Pipe`
// minted with the `-SOL-` filename segment but NO `execModel: sol` backfill, which the
// drift lint (extended to `sol` in this same plan) would then hard-block at push time
// (a loud failure, not a silent misroute — see plan 3341's coordination notes for why
// this was left dormant rather than urgent). Loops SEGMENT_CHECK_FOR_EXEC_MODEL's own
// keys — the SAME table stampedRelForExecModel/categoryCarriesSegmentFor read — so a
// FOURTH segment-bearing lane needs one new table row, never a second branch here.
export function ensureExecModelForCategory(content, category) {
  for (const execModel of Object.keys(SEGMENT_CHECK_FOR_EXEC_MODEL)) {
    if (categoryCarriesSegmentFor(execModel, category)) {
      return upsertFrontmatterKey(content, 'execModel', execModel, { keepExisting: true });
    }
  }
  return content; // no recognized marker segment in `category` — nothing to back-fill
}

// The lane the Tier-0 `exempt-mechanical` backfill below stamps — the ONE
// script-enforced execModel default in this repo.
//
// It is READ FROM CONFIG, never written here (plan 3656). Operator ruling 2026-09-03,
// verbatim: "I'd also like for the flip to be faster. It shouldn't be a plan and
// reviews, and it should just be a toggle somewhere." A literal in this file made every
// flip a `scripts/**` diff, which triggers the mandatory code review, on top of a
// six-surface prose rewrite; plans 3461 and 3617 each paid a full plan + review + land
// cycle for a one-word preference. The value now lives in
// `scripts/exec-model-default.json`, so a flip is a config-only, review-exempt edit:
//   node scripts/exec-model-default.mjs set <lane> --reason "<operator verbatim>"
//
// Resolved at module load, not per call: a mid-process change to the toggle would mean
// two plans stamped in one run could disagree, and the read is the cheapest possible.
// A malformed or unknown-lane toggle THROWS here rather than falling back — see
// exec-model-default-lib.mjs for why a fallback would resurrect the second, invisible
// statement of the default this plan exists to delete.
//
// The LANE gate and the DEFAULT are still two different things: whatever this names, a
// plan that already carries `execModel: sol` stays drain-claimable and executes per
// `coord/skills/pickup-plan/SKILL.md` § 8.7. History of the value itself (2026-08-20
// lane minted, 2026-08-26 Sol default, 2026-09-01 suspended, 2026-09-03 restored) is
// in `docs/coord/plan-lanes.md` § Executor lanes and model allocation; the CURRENT value is only
// ever in the JSON.
export const EXEMPT_MECHANICAL_DEFAULT_LANE = execModelDefaultLane();

// Tier-0 plans deliberately skip spec-pass by carrying `specReview:
// exempt-mechanical`, so they also skip the litmus that elects a lane. Leaving the
// value absent is not neutral: resolveExecLane's legacy grandfather clause reads an
// absent execModel as Sonnet, so an unstamped Tier-0 plan is ALREADY treated as
// sonnet by every consumer — writing the stamp explicitly makes that reading visible
// on the plan itself instead of implicit in a fallback. Both writers that can place
// one of these plans directly into ready/ call this helper before they compute or
// verify the filename, so the stamp and the (now segment-less) basename stay in the
// same commit. `keepExisting` is structural precedence: an explicit lane — including
// the FABLE-/SOL- category backfill applied first by next-plan-id — always wins, so
// an operator who wants a specific Tier-0 plan on Sol still just says so.
export function ensureExecModelForExemptMechanical(content) {
  const specReview = readFrontmatterScalar(content, 'specReview');
  if (specReview === '' || specReview.toLowerCase() !== 'exempt-mechanical') return content;
  return upsertFrontmatterKey(content, 'execModel', EXEMPT_MECHANICAL_DEFAULT_LANE, {
    keepExisting: true,
  });
}

// Belt-and-suspenders (D2): re-run the pre-push lint's OWN check function against
// the file this module just (re)named, so a rename-logic bug fails LOUD right here
// instead of silently landing the exact drift lint-filename-execmodel-drift.mjs
// exists to catch. `relPath` must be `docs/superpowers/plans/<status>/<basename>`
// (the shape findExecModelDrift expects). Should be unreachable once the three
// auto-stamp callers are wired correctly — a throw here is a bug in the CALLER's
// wiring, not a legitimate plan-content problem.
export function assertExecModelFilenameOk(relPath, content) {
  const problems = findExecModelDrift([{ path: relPath, content }]);
  if (problems.length) {
    throw new Error(
      `exec-model-stamp: internal — ${relPath} still drifted after auto-stamp ` +
        `(should be unreachable): ${problems.map((p) => p.message).join(' ')}`,
    );
  }
}

// Manual-CLI guard (stamp-exec-model.mjs): refuse a stamp against in-progress/ or
// archive/ with an explanatory throw (vs. the silent skip canRenameForStatus's
// callers use) — moved here verbatim so the ONE restriction lives in one place.
// `tool` names the refusing CLI in the message (plan-1781 review finding [3], fixed
// plan 1797: the hardcoded "stamp-exec-model:" prefix misattributed a
// stamp-cloud-exec refusal); the default keeps pre-1797 callers' output unchanged.
export function assertStampableStatus(status, basename, tool = 'stamp-exec-model') {
  if (status === IN_PROGRESS_FOLDER)
    throw fatal(
      `${tool}: refusing to stamp ${basename} — it is in-progress/. The basename is ` +
        `coupled to the worktree slug/branch there, so renaming it would desync them. Stamp ` +
        `BEFORE pickup (pending-approval/, ready/, or a waiting-*/ folder) instead.`,
    );
  if (status === ARCHIVE_FOLDER)
    throw fatal(
      `${tool}: refusing to stamp ${basename} — it is archive/ (closed). ` +
        `Nothing to route on a completed plan.`,
    );
}
