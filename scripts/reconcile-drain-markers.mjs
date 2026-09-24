#!/usr/bin/env node
// Project unclaimed cloud-drain marker branches into the plan-folder state machine.
// A drain that cannot push refs/claims/* can still execute on claude/drain-<slug>;
// plan 3659 makes that durable signal authoritative enough to move ready/ → in-progress/.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COORD_TRAILER,
  assertPushReachedOrigin,
  ensureMvDestDir,
  gitWithLockRetry,
  isNonFastForward,
  lsRemoteTimed,
  masterPushSpec,
  resolveMain,
  withCoordCheckout,
} from './coord/coord-git.mjs';
import {
  claimedIdOfBasename,
  SEED_BANNER_RX,
  STATUS_LINE_RX,
  walkPlanStatusDir,
} from './coord/build-index-lib.mjs';
import { regenerateIndex } from './coord/build-index.mjs';
import { stampPromotedStatus } from './coord/plan-body-state.mjs';
// coord-refs.mjs imports nothing, so this adds no new cross-tree edge (plan 3756 step 2).
// Legacy constructors only — this step does not flip the namespace. `planIdFromClaimRef`
// already canonicalises a leading-zero plan id; the local strip below is retired in favour
// of routing through this seam (item 4).
import { heldClaimsMap } from './coord/claim-plan.mjs';

const PLANS_PREFIX = 'docs/superpowers/plans/';
const MARKER_PREFIX = 'refs/heads/claude/drain-';
const UNCLAIMED_RX = /^\*\*Unclaimed-drain:\*\* .*$/m;

// `pattern` may be an array — plan 3756's claim refs live in two namespaces at once, and
// lsRemoteTimed passes every pattern to one `git ls-remote`.
function lsRemote(mainDir, pattern) {
  return lsRemoteTimed(mainDir, pattern)
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean);
}

function planRecordsById(mainDir) {
  const root = join(mainDir, PLANS_PREFIX);
  const byId = new Map();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const records = walkPlanStatusDir({
      statusFolder: entry.name,
      readdir: (segments) =>
        readdirSync(join(root, entry.name, ...segments), { withFileTypes: true }),
    });
    for (const record of records) {
      const raw = claimedIdOfBasename(record.basename);
      if (!raw) continue;
      const id = raw.replace(/^0+(?=\d)/, '');
      const matches = byId.get(id) ?? [];
      matches.push(record);
      byId.set(id, matches);
    }
  }
  return byId;
}

function planIdFromSlug(slug) {
  const raw = slug.match(/^(\d{3,})-/)?.[1];
  return raw ? raw.replace(/^0+(?=\d)/, '') : null;
}

// plan 3756 review: HELD plan ids, not ref names. The old existence-based set counted a
// release tombstone as a live claim, which here does not merely misreport — `classifyMarker`
// skips a marker whose plan "has a live claim ref", so a released claim would have blocked
// that plan's drain-marker projection permanently.
// Not caught: an unreadable claim namespace must abort the pass, never fail open. This set is
// what stops a marker being projected over a plan somebody is actively holding, so an empty set
// would project every one of them (plan 3756 review).
function heldClaimIds(mainDir) {
  return new Set(Object.keys(heldClaimsMap(mainDir)));
}

function resolvePlan(recordsById, id) {
  if (!id) return null;
  const matches = recordsById.get(id) ?? [];
  return matches.find((p) => p.statusFolder === 'ready') ?? matches[0] ?? null;
}

export function setUnclaimedDrainMarker(body, branch) {
  const line = `**Unclaimed-drain:** ${branch}`;
  if (UNCLAIMED_RX.test(body)) return body.replace(UNCLAIMED_RX, () => line);
  const match = SEED_BANNER_RX.exec(body);
  if (!match) return null;
  const end = match.index + match[0].length;
  return `${body.slice(0, end)}\n\n${line}${body.slice(end)}`;
}

function classifyMarker(ref, recordsById, claimRefs) {
  const slug = ref.slice(MARKER_PREFIX.length);
  const id = planIdFromSlug(slug);
  const plan = resolvePlan(recordsById, id);
  if (!plan) return { ref, slug, id, action: 'skipped', reason: 'no plan file resolves for slug' };
  if (plan.statusFolder !== 'ready')
    return {
      ref,
      slug,
      id,
      plan,
      action: 'skipped',
      reason: `plan is in ${plan.statusFolder}/, not ready/`,
    };
  if (claimRefs.has(id))
    return { ref, slug, id, plan, action: 'skipped', reason: 'live claim ref exists' };
  return { ref, slug, id, plan, action: 'project' };
}

function report(item, dry = false) {
  if (item.action === 'project')
    console.log(`${item.ref}: ${dry ? 'would project' : 'projected'} ${item.plan.basename}`);
  else console.log(`${item.ref}: skipped — ${item.reason}`);
}

async function main() {
  const dry = process.argv.slice(2).includes('--dry-run');
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--dry-run');
  if (unknown.length) {
    console.error(`usage: reconcile-drain-markers.mjs [--dry-run]`);
    return 2;
  }
  const mainDir = resolveMain();
  const markerRefs = lsRemote(mainDir, `${MARKER_PREFIX}*`).sort();
  if (!markerRefs.length) return 0;

  return withCoordCheckout(mainDir, async (cdir) => {
    // plan 3659 race ruling: these reads happen only after withCoordCheckout has reset its
    // disposable tree to fresh origin/master. Re-read BOTH folder state and claims here;
    // a real claimant racing the earlier marker enumeration therefore wins cleanly.
    // plan 3659 review A/H: walk the whole plan tree once and index it by canonical id. The
    // whole-tree view preserves the operational distinction between an unknown marker and a
    // known plan outside ready/, while only a ready/ match is eligible for projection. The
    // immediately-before-mutation reads below stay fresh: they are the authority race guard.
    const records = planRecordsById(cdir);
    const claimRefs = heldClaimIds(cdir);
    const decisions = markerRefs.map((ref) => classifyMarker(ref, records, claimRefs));
    if (dry) {
      for (const item of decisions) report(item, true);
      return 0;
    }

    // plan 3659 review H: one fresh, post-classification remote snapshot serves every
    // immediately-following mutation. It is deliberately distinct from the cached decision
    // snapshot above, while avoiding one serialized network round-trip per marker.
    const mutateClaimRefs = heldClaimIds(cdir);
    const projected = [];
    for (const item of decisions) {
      if (item.action !== 'project') continue;
      // Re-check the exact READY path immediately before EACH mutation. This filesystem read
      // is fresh (not another cached/tree-wide scan); the remote claim snapshot immediately
      // above is likewise fresh for this tightly serialized mutation batch.
      const now = item.plan;
      if (!existsSync(join(cdir, PLANS_PREFIX, now.rel))) {
        item.action = 'skipped';
        item.reason = 'plan is no longer resolvable in ready/';
        continue;
      }
      if (mutateClaimRefs.has(item.id)) {
        item.action = 'skipped';
        item.reason = 'live claim ref exists';
        continue;
      }
      const oldRel = `${PLANS_PREFIX}${now.rel}`;
      const newRel = `${PLANS_PREFIX}in-progress/${now.basename}`;
      const body = readFileSync(join(cdir, oldRel), 'utf8');
      const marked = setUnclaimedDrainMarker(body, item.ref.replace(/^refs\/heads\//, ''));
      if (marked === null) {
        item.action = 'skipped';
        item.reason = 'no SEED-WRITE banner found';
        continue;
      }
      const date = new Date().toISOString().slice(0, 10);
      const promoted = stampPromotedStatus(marked, {
        target: 'in-progress',
        fromStatus: 'ready',
        date,
      }).replace(
        STATUS_LINE_RX,
        () =>
          `**Status:** 🔄 IN PROGRESS — being executed by an unclaimed drain; re-filed ready→in-progress ${date}.`,
      );
      ensureMvDestDir(cdir, newRel);
      gitWithLockRetry(cdir, ['mv', oldRel, newRel]);
      writeFileSync(join(cdir, newRel), promoted);
      item.plan = now;
      projected.push({ oldRel, newRel });
    }

    if (!projected.length) {
      for (const item of decisions) report(item);
      return 0;
    }
    writeFileSync(join(cdir, 'docs/INDEX.md'), regenerateIndex(cdir));
    const paths = projected.flatMap(({ oldRel, newRel }) => [oldRel, newRel]);
    const newPaths = projected.map(({ newRel }) => newRel);
    // git mv already staged each old-path deletion: add only the paths that still exist,
    // while commit selects both old and new paths from the index to include every rename.
    gitWithLockRetry(cdir, ['add', '-f', '--', ...newPaths, 'docs/INDEX.md']);
    const message = `docs(plans): reconcile unclaimed drain markers\n\n${COORD_TRAILER}: reconcile-drain-markers`;
    gitWithLockRetry(cdir, ['commit', '-m', message, '--', ...paths, 'docs/INDEX.md'], {
      env: { ...process.env, HUSKY: '0' },
    });
    // coordLandCommit owns the commit step and therefore does not fit this already-committed
    // batch. Keep the retry local so masterPushSpec preserves HEAD:master in the detached coord
    // checkout. After every non-ff rebase, regenerate and amend the generated INDEX before the
    // next push; a concurrent master tip may otherwise leave the rebased projection's index stale.
    const env = { ...process.env, HUSKY: '0' };
    const pushSpec = masterPushSpec(cdir, env);
    const retries = 8;
    let projectionSha;
    for (let attempt = 0; ; attempt++) {
      projectionSha = gitWithLockRetry(cdir, ['rev-parse', 'HEAD'], { env }).trim();
      try {
        gitWithLockRetry(cdir, ['push', 'origin', pushSpec], { env });
        break;
      } catch (error) {
        if (!isNonFastForward(error) || attempt >= retries) throw error;
        gitWithLockRetry(cdir, ['fetch', 'origin', 'master'], { env });
        gitWithLockRetry(cdir, ['rebase', 'origin/master'], { env });
        writeFileSync(join(cdir, 'docs/INDEX.md'), regenerateIndex(cdir));
        gitWithLockRetry(cdir, ['add', '-f', '--', 'docs/INDEX.md'], { env });
        gitWithLockRetry(cdir, ['commit', '--amend', '--no-edit', '--', 'docs/INDEX.md'], { env });
      }
    }
    assertPushReachedOrigin(cdir, pushSpec, env, {
      sha: projectionSha,
      label: 'reconcile-drain-markers',
    });
    for (const item of decisions) report(item);
    return 0;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`reconcile-drain-markers: ${error.message}`);
      process.exit(1);
    },
  );
}
