// scripts/coord/cloud-land-lib.mjs — the pure half of the `/cloud-land` hand-off (plan 4255).
//
// A LOCAL session that has finished building a plan hands its reviewed, pushed branch to a CLOUD
// drain, which adopts the branch and runs the land gates there, so the land battery (full pytest,
// scripts battery, `next build`, WebKit mobile, price trust) leaves the operator's box. The CLI is
// `scripts/coord/cloud-land.mjs`; this module holds every decision that needs no git, so the
// hand-off writer and the drain oracle (`queue-drain.mjs`) read ONE definition of a hand-off.
//
// The LAND-PHASE AXIS (plan 4255 S1). `cloudExec` judges a plan's whole WORK, and a plan stamped
// `false` because its BUILD needed this box may still have a cloud-safe land. So the hand-off
// stamps a separate pair — `landCloudExec: true` + `landCloudEnv: <env>` — and leaves `cloudExec`
// meaning what it always meant (re-executing the plan from scratch). The oracle admits a
// `cloudExec: false` plan through this carrier ONLY when it is a COMPLETE hand-off: the carrier,
// the `adoptBranch:` stamp (plan 3111), and the hand-off note this module renders. Any one of the
// three missing and the plan stays exactly as excluded as it was before plan 4255.
//
// Module layout: a non-test `.mjs` under `scripts/`, so it imports nothing outside `scripts/`
// (docs/coord/scripts-layout.md § Rule 1).

import { readFrontmatterScalar, upsertFrontmatterKey } from './build-index-lib.mjs';

export const LAND_CLOUD_EXEC_KEY = 'landCloudExec';
export const LAND_CLOUD_ENV_KEY = 'landCloudEnv';

// S2: every land goes to the full env. It is the only env that carries WebKit (the mobile gate)
// and a superset of trusted, so trusted is never the better pick for a land.
export const DEFAULT_LAND_CLOUD_ENV = 'full';

// The heading the hand-off note opens with. The oracle keys "the built-branch note is present" on
// this exact heading, so it is spelled once, here.
export const CLOUD_LAND_NOTE_HEADING = '## Cloud-land hand-off';
const NOTE_HEADING_RX = /^## Cloud-land hand-off\b/gm; // only ever used with String#match (g = all)

// S3: the second hand-off is the one allowed bounce (a cloud-only flake handed back); a third is
// refused and reported, never re-handed.
export const MAX_CLOUD_LAND_HANDOFFS = 2;

export function countCloudLandHandoffs(content) {
  return (String(content ?? '').match(NOTE_HEADING_RX) || []).length;
}

export function hasCloudLandNote(content) {
  return countCloudLandHandoffs(content) > 0;
}

// The frontmatter reads, normalized the way every other stamp on this record is.
export function readLandStamps(content) {
  const exec = (readFrontmatterScalar(content, LAND_CLOUD_EXEC_KEY) || '').toLowerCase() || null;
  const env = (readFrontmatterScalar(content, LAND_CLOUD_ENV_KEY) || '').toLowerCase() || null;
  return { landCloudExec: exec, landCloudEnv: env };
}

// A COMPLETE land hand-off: all three parts present. `adoptBranch` is passed in (the oracle has
// already parsed it) rather than re-read, so the two can never disagree about the stamp.
export function isLandHandoff(content, adoptBranch) {
  return (
    readLandStamps(content).landCloudExec === 'true' &&
    Boolean(adoptBranch) &&
    hasCloudLandNote(content)
  );
}

// What an INCOMPLETE hand-off is missing, for the oracle's exclude reason. Empty when complete or
// when the carrier is not stamped at all (then there is no hand-off to be incomplete).
export function missingHandoffParts(content, adoptBranch) {
  if (readLandStamps(content).landCloudExec !== 'true') return [];
  const missing = [];
  if (!adoptBranch) missing.push('adoptBranch');
  if (!hasCloudLandNote(content)) missing.push(`the "${CLOUD_LAND_NOTE_HEADING}" note`);
  return missing;
}

// Every line of the plan that states a `cloudExec: false` reason (banner, prose or spec verdict).
export function cloudExecFalseReasons(content) {
  return String(content ?? '')
    .split(/\r?\n/)
    .filter(
      (l) => /cloudExec:\s*`?false/i.test(l) && !/^cloudExec:\s*`?false`?\s*$/i.test(l.trim()),
    )
    .map((l) => l.trim());
}

// S2's #2/#3 test on a reason line: a `route: local` host, rubric item #2/#3, or a named secret.
// Whether that host/key is read by the LAND's gates or only by the build is a judgment the script
// cannot make, so a hit refuses unless the caller asserts --gates-cloud-safe "<why>".
const LOCAL_HOST_OR_KEY_RX =
  /route:\s*local|rubric\s*(?:item\s*)?#?[23]\b|(?:^|[\s(+/])#[23]\b|\b[A-Z][A-Z0-9]*_(?:API_)?(?:KEY|TOKEN|SECRET|PAT|B64)\b/;

// The refusals (S2), each naming the rubric item. `changedPaths` is the branch diff vs its
// merge-base with origin/master.
export function judgeLandRefusals({ changedPaths = [], planContent = '', gatesCloudSafe = null }) {
  const refusals = [];
  const touching = (rx) => changedPaths.filter((p) => rx.test(p));
  const claude = touching(/^\.claude\//);
  if (claude.length)
    refusals.push({
      rubric: '#7',
      reason:
        `the branch writes under .claude/** (${claude.slice(0, 3).join(', ')}${claude.length > 3 ? ', …' : ''}) — ` +
        'whether merely merging those files trips the cloud classifier is untested, so this land stays local',
    });
  const husky = touching(/^\.husky\//);
  if (husky.length)
    refusals.push({
      rubric: '#8',
      reason:
        `the branch writes under .husky/** (${husky.slice(0, 3).join(', ')}${husky.length > 3 ? ', …' : ''}) — ` +
        'a classifier-denied path for a cloud session, so this land stays local',
    });
  const wiki = touching(/^wiki\//);
  if (wiki.length)
    refusals.push({
      rubric: 'wiki',
      reason:
        `the branch carries wiki/ changes (${wiki.slice(0, 3).join(', ')}) — wiki pages land via ` +
        'wiki-commit.mjs, never on a worktree branch; the land preflight would refuse it anywhere',
    });
  // Only a plan actually stamped `cloudExec: false` has a local-only reason to judge: a
  // `cloudExec: true` plan's build was already cloud-safe, and prose elsewhere in its body that
  // merely QUOTES another plan's reason must not refuse it.
  const stamped = (readFrontmatterScalar(planContent, 'cloudExec') || '').toLowerCase();
  if (!gatesCloudSafe && stamped !== 'true') {
    for (const line of cloudExecFalseReasons(planContent)) {
      if (!LOCAL_HOST_OR_KEY_RX.test(line)) continue;
      refusals.push({
        rubric: '#2/#3',
        reason:
          `the plan's cloudExec: false reason names a local-only host or a key ("${line.slice(0, 160)}") — ` +
          'if the land gates (pytest, scripts battery, next build, WebKit mobile, price trust) never read it, ' +
          're-run with --gates-cloud-safe "<why>"',
      });
      break;
    }
  }
  return refusals;
}

// The hand-off note appended to the plan body. The drain reads it as the "BUILT and PUSHED, only
// the land remains" statement plan 3248's hand-back also writes.
export function renderHandoffNote({
  iso,
  branch,
  headSha,
  verdict,
  env,
  handoffNumber,
  gatesCloudSafe = null,
  sessionId = null,
}) {
  const lines = [
    `${CLOUD_LAND_NOTE_HEADING} ${iso}`,
    '',
    `- **Branch:** \`${branch}\` at \`${headSha}\` — BUILT, REVIEWED and PUSHED; only the land remains.`,
    `- **Review:** ${verdict} recorded for this HEAD; findings dispositioned.`,
    `- **Land env:** \`${LAND_CLOUD_ENV_KEY}: ${env}\` (\`${LAND_CLOUD_EXEC_KEY}: true\`).`,
    `- **Hand-off:** ${handoffNumber} of at most ${MAX_CLOUD_LAND_HANDOFFS}.` +
      (handoffNumber > 1 ? ' A previous cloud land bounced; see the note above.' : ''),
  ];
  if (gatesCloudSafe) lines.push(`- **Gates cloud-safe (asserted):** ${gatesCloudSafe}`);
  if (sessionId) lines.push(`- **Handed off by session:** ${sessionId}`);
  lines.push(
    '',
    'Taker: claim, `node scripts/cut-worktree.mjs <slug> --adopt=<branch>`, re-record the review only if ' +
      'HEAD moved, then `node scripts/done-worktree.mjs <slug>`. Do NOT re-execute the plan. A genuine gate ' +
      'failure is fixed in place; a cloud-only flake is handed back with the plan-3248 note plus an ' +
      'infra-debt line (docs/runbooks/cloud-drain-landing.md § Cloud-land hand-off).',
  );
  return lines.join('\n');
}

// The new plan content: carrier + env stamped, note appended. Idempotent on a note already present
// for this exact HEAD sha (a re-run after a later step failed must not write a second note, which
// would also count as a bounce).
export function applyHandoff(content, { note, env, headSha }) {
  let out = upsertFrontmatterKey(content, LAND_CLOUD_EXEC_KEY, 'true');
  out = upsertFrontmatterKey(out, LAND_CLOUD_ENV_KEY, env);
  if (tailNoteForSha(out, headSha)) return out;
  const eol = out.includes('\r\n') ? '\r\n' : '\n';
  return `${out.replace(/\s*$/, '')}${eol}${eol}${note.split('\n').join(eol)}${eol}`;
}

// Is the plan body's LAST level-2 section a hand-off note for this HEAD sha? That is the shape a
// re-run of the SAME hand-off sees (idempotence). Once a cloud drain bounces the land, its
// hand-back note follows ours, so a later hand-off of the same sha is a NEW hand-off — it writes its
// own note and counts toward the bounce cap (review r4 5172df).
export function tailNoteForSha(content, headSha) {
  if (!headSha) return false;
  const sections = String(content ?? '').split(/^(?=## )/m);
  const last = sections[sections.length - 1];
  return last.startsWith(CLOUD_LAND_NOTE_HEADING) && last.includes(headSha);
}

// Is there a hand-off note naming this HEAD sha anywhere in the body?
export function noteForSha(content, headSha) {
  if (!headSha) return false;
  // Split at every level-2 heading; a section is a note when it opens with the note heading.
  return String(content ?? '')
    .split(/^(?=## )/m)
    .some((section) => section.startsWith(CLOUD_LAND_NOTE_HEADING) && section.includes(headSha));
}

// ── The hand-off itself (T1) ─────────────────────────────────────────────────────────────────
//
// `judgeHandoff(facts)` decides, from facts the CLI gathered, whether the hand-off may run;
// `runHandoff(facts, ops)` then performs the plan-3248 steps in order through injected `ops`, so the
// order, the idempotence and the "a failed step leaves the plan claimed" contract are all testable
// without git. The order is the load-bearing part:
//
//   1. note     — stamp landCloudExec/landCloudEnv + append the hand-off note (BEFORE anything
//                 makes the plan claimable: a claimable plan with no note reads as unbuilt)
//   2. dequeue  — free any landing-queue slot this session holds for the slug
//   3. move     — `move-plan <id> ready`, which stamps adoptBranch (plan 3111). The claim is still
//                 ours, so no rival can take the plan while the stamp is written
//   4. verify   — the adoptBranch stamp on master names exactly our branch
//   5. release  — only now release the claim
//
// Every step before `release` leaves the claim held on failure; the report names the step.

export const HANDOFF_STEPS = ['note', 'dequeue', 'move', 'verify', 'release'];

// facts: {
//   planId, slug, branch, headSha, originSha, dirtyPaths[], changedPaths[],
//   planContent, planFolder ('in-progress' | 'ready' | …), adoptBranch (stamp on master),
//   claim: { held, youAreHolder }, review: { verdict, sha } | null, findingsOpen: string | null,
//   gatesCloudSafe, env
// }
// Returns { done: true } when a previous run already finished everything for this HEAD, else
// { refusals: [{ rubric|code, reason }], handoffNumber }.
export function judgeHandoff(facts) {
  const {
    headSha,
    originSha,
    dirtyPaths = [],
    changedPaths = [],
    planContent = '',
    planFolder,
    adoptBranch,
    branch,
    claim = {},
    review = null,
    findingsOpen = null,
    gatesCloudSafe = null,
  } = facts;
  const stamps = readLandStamps(planContent);
  const noteHere = tailNoteForSha(planContent, headSha);
  if (
    noteHere &&
    stamps.landCloudExec === 'true' &&
    planFolder === 'ready' &&
    adoptBranch === branch &&
    !(claim.held && claim.youAreHolder)
  )
    return { done: true };

  const refusals = [];
  if (!claim.held || !claim.youAreHolder)
    refusals.push({
      code: 'NOT_CLAIMED',
      reason: claim.held
        ? 'the plan is claimed by ANOTHER session — only the claim holder hands its branch off'
        : 'this session does not hold the plan claim — claim it (pickup-plan) before handing it off',
    });
  if (dirtyPaths.length)
    refusals.push({
      code: 'DIRTY',
      reason: `the worktree has uncommitted changes (${dirtyPaths.slice(0, 5).join(', ')}) — commit and push first`,
    });
  if (!originSha || originSha !== headSha)
    refusals.push({
      code: 'PUSH_UNCONFIRMED',
      reason: originSha
        ? `origin's ${branch} is at ${originSha.slice(0, 10)}, local HEAD is ${String(headSha).slice(0, 10)} — push (and verify with push-queue-status.mjs) first`
        : `${branch} is not on origin — push it first`,
    });
  if (!review || review.sha !== headSha)
    refusals.push({
      code: 'NO_REVIEW',
      reason: review
        ? `the recorded review (${review.verdict} @ ${String(review.sha).slice(0, 10)}) is not for HEAD — re-review the delta and re-run record-review.mjs`
        : 'no review is recorded for this branch — review, then record-review.mjs',
    });
  if (findingsOpen) refusals.push({ code: 'FINDINGS_OPEN', reason: findingsOpen });
  const prior = countCloudLandHandoffs(planContent) - (noteHere ? 1 : 0);
  if (prior >= MAX_CLOUD_LAND_HANDOFFS)
    refusals.push({
      code: 'BOUNCE_LIMIT',
      reason:
        `the plan was already handed to the cloud ${prior} times — a second bounce is a design question, ` +
        'not a third hand-off; land it locally or park it with what broke',
    });
  refusals.push(...judgeLandRefusals({ changedPaths, planContent, gatesCloudSafe }));
  return { refusals, handoffNumber: prior + 1 };
}

// ops: { writePlan(content), dequeue(), moveReady(), readAdoptBranch(), release() } — each may
// throw. Returns { ok: true, ran: [...] } or { ok: false, ran, failedStep, error, claimHeld }.
export function runHandoff(facts, ops, { iso = new Date().toISOString() } = {}) {
  const env = facts.env || DEFAULT_LAND_CLOUD_ENV;
  const ran = [];
  const step = (name, fn) => {
    try {
      const r = fn();
      if (r !== false) ran.push(name);
      return null;
    } catch (e) {
      return {
        ok: false,
        ran,
        failedStep: name,
        error: String(e?.message ?? e),
        claimHeld: name !== 'release',
      };
    }
  };
  const judged = judgeHandoff(facts);
  const failed =
    step('note', () => {
      const stamps = readLandStamps(facts.planContent);
      if (tailNoteForSha(facts.planContent, facts.headSha) && stamps.landCloudExec === 'true')
        return false;
      const note = renderHandoffNote({
        iso,
        branch: facts.branch,
        headSha: facts.headSha,
        verdict: facts.review?.verdict ?? 'unknown',
        env,
        handoffNumber: judged.handoffNumber ?? 1,
        gatesCloudSafe: facts.gatesCloudSafe,
        sessionId: facts.sessionId ?? null,
      });
      ops.writePlan(applyHandoff(facts.planContent, { note, env, headSha: facts.headSha }));
    }) ||
    step('dequeue', () => ops.dequeue()) ||
    step('move', () => (facts.planFolder === 'ready' ? false : ops.moveReady())) ||
    step('verify', () => {
      const stamped = ops.readAdoptBranch();
      if (stamped !== facts.branch)
        throw new Error(
          `adoptBranch on master is ${JSON.stringify(stamped)}, expected ${facts.branch} — run ` +
            `node scripts/plan-adopt-branch.mjs ${facts.planId} and re-run; the claim is still held`,
        );
    }) ||
    step('release', () => ops.release());
  return failed || { ok: true, ran };
}
