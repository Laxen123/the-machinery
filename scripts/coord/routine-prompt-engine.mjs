// scripts/coord/routine-prompt-engine.mjs (plan 3964 T2)
//
// GENERIC unattended-agent prompt-template engine, split out of the vetapp-specific
// scripts/cloud-routine-prompt-lib.mjs (plan 1947). This module holds the SHAPE — the
// section scaffold, the section ORDERING, the ruling-banner grammar (a bold marker
// sentence followed by its explanation), the attribution-report contract's grammar, and
// the generic (lane, env) axis-validation + axis-gloss-list formatting a project's own
// escape-hatch prose can build on. It contains NO vetapp-specific prose, product name,
// e-mail, repo URL, env-var names, or pipeline vocabulary — every such fact is a field on
// the `RoutineSpec` object the caller (scripts/project/cloud-routine-specs.mjs) supplies.
//
// Rule 3 (docs/runbooks/scripts-module-layout.md, scripts/assert-scripts-self-contained.mjs):
// a module under scripts/coord/ may import only scripts/coord/** and node: builtins. This
// file imports nothing but ./axis-tags.mjs (already inside scripts/coord/) — no fs, no
// child_process, no project module — so it stays a pure content-generation leaf exactly
// like the module it was split from.
//
// A `RoutineSpec` is a plain object combining:
//   - the two axis values for THIS render: `lane`, `env`
//   - axis DATA for validation: `lanes` (array), `envs` (array), `canonical` (array of
//     `{ lane, env, path }` rows — a project's own committed-body registry)
//   - `primaryLane` — which `lane` value takes the "primary" section ordering (claim +
//     worktree, then its own batch/orchestrator block, before Execute); every other lane
//     value takes the "secondary" ordering (orchestrator doctrine before Execute, then
//     claim + worktree, then its own batch block after Execute) — this is the ordering
//     scripts/cloud-routine-prompt-lib.mjs's `renderPrompt` hardcoded as `lane === 'sonnet'`
//   - `isFullEgress(env)` — a project-supplied predicate for the full-egress-family branch
//   - one content-generating function or zero-arg function per named section (see the
//     call sites inside `renderRoutinePrompt` below for the exact contract each one must
//     satisfy — they mirror the original module's function signatures one-for-one, which is
//     what let this split stay byte-identical against the 6 committed prompt bodies).

import { AXIS_TAGS_BY_UNBLOCK } from './axis-tags.mjs';

export { AXIS_TAGS_BY_UNBLOCK };

// Generic (lane, env) axis validator. `lanes`/`envs` are the flat vocabularies; `canonical`
// is the list of rows a real committed body exists for — validating each axis independently
// is not enough once a project's canonical set stops being a full cross-product (see the
// caller's own comment on why the PAIR check matters), so this checks all three.
export function assertAxes(lane, env, { lanes, envs, canonical }) {
  if (!lanes.includes(lane)) throw new Error(`routine-prompt-engine: unknown lane "${lane}"`);
  if (!envs.includes(env)) throw new Error(`routine-prompt-engine: unknown env "${env}"`);
  if (!canonical.some((c) => c.lane === lane && c.env === env)) {
    throw new Error(
      `routine-prompt-engine: unsupported (lane, env) pair "${lane}/${env}" — no canonical body exists for it`,
    );
  }
}

// "a (gloss), b (gloss), … , or z (gloss)" — the prose form a decision-axis list renders in.
// `glossMap` is the project's own human-authored explanation for each tag; this function only
// owns the LIST GRAMMAR (Oxford-comma-style "a, b, or c"), never the tag vocabulary or its
// glosses. Throws loudly (rather than rendering a bare, unexplained tag) when a tag has no
// entry in the supplied gloss map.
export function axisListWithGlosses(tags, glossMap) {
  const parts = tags.map((tag) => {
    const gloss = glossMap[tag];
    if (!gloss) throw new Error(`routine-prompt-engine: no gloss entry for axis "${tag}"`);
    return `${tag} (${gloss})`;
  });
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`;
}

// The ruling-banner grammar: a bold, verbatim-required MARKER sentence immediately followed
// by its explanation. Every standing hard-rule banner in a routine body (never-end-turn,
// composer-trust, …) follows this shape — the marker is what a lint greps for verbatim, the
// explanation is free prose. This function owns only the concatenation grammar; the marker
// text and the explanation are both project-owned content.
export function rulingBanner(marker, explanation) {
  return `${marker} ${explanation}`;
}

// The attribution-report contract's grammar: report certain identifier fields in the final
// summary, additionally persist them to durable storage under a stated condition (so a run
// that never reaches its own normal end still leaves a trail), and exclude one field for a
// stated reason (typically privacy). The fields, the write tool, the condition, the excluded
// field and its reason are all project-owned; this function only owns the SENTENCE SHAPE.
export function attributionReportParagraph({
  planRef,
  fieldsList,
  identifiersLabel,
  writeCondition,
  writeTool,
  excludedField,
  excludedReason,
}) {
  return (
    `Record drain attribution (${planRef}): report the literal ${fieldsList} values in the final ` +
    `summary. Whenever you take ${writeCondition}, also write ${identifiersLabel} into the ` +
    `plan-body handoff section via \`${writeTool}\`. Do NOT record \`${excludedField}\`; ` +
    `${excludedReason}.`
  );
}

// ─── Assembly ────────────────────────────────────────────────────────────────
// Renders the full canonical body for `spec.lane`/`spec.env`. This is the exact section
// scaffold and ordering scripts/cloud-routine-prompt-lib.mjs's own `renderPrompt` used to
// hardcode (see plan 1947's body comment there): the primary lane interleaves claim+worktree
// before its own batch/orchestrator block and has no secondary-orchestrator section; every
// other lane has its orchestrator doctrine before Execute and claim+worktree after Execute.
// Which lane value is "primary" is a project fact (`spec.primaryLane`), never hardcoded here.
export function renderRoutinePrompt(spec) {
  const { lane, env } = spec;
  assertAxes(lane, env, spec);

  const sections = [spec.opening(lane, env)];
  if (spec.isFullEgress(env)) sections.push(spec.fullEgressBlock(env));
  sections.push(spec.gitCredentialSetup(), spec.extraReposBlock());
  if (spec.isFullEgress(env)) sections.push(spec.checkoutPreflightBlock());
  sections.push(spec.diskHeadroomPruneBlock());
  sections.push(
    spec.usageGate(env),
    spec.claimDriftReportBlock(),
    spec.earlyExit(lane, env),
    spec.contract(lane, env),
  );
  if (lane === spec.primaryLane) {
    sections.push(
      spec.claimWorktree(lane),
      spec.primaryBatchBlock(),
      spec.primaryOrchestratorBlock(),
    );
    if (spec.isFullEgress(env)) sections.push(spec.solLaneBlock(lane));
    sections.push(spec.execute(lane, env));
  } else {
    sections.push(spec.secondaryOrchestratorBlock());
    if (spec.isFullEgress(env)) sections.push(spec.solLaneBlock(lane));
    sections.push(spec.execute(lane, env), spec.claimWorktree(lane), spec.secondaryBatchBlock());
  }
  sections.push(
    spec.reviewBlock(env),
    spec.landBlock(),
    spec.landFailureLoop(lane),
    spec.escapeHatch(lane),
    spec.hardLimits(lane),
    spec.finalSummary(lane, env),
  );
  return sections.join('\n\n') + '\n';
}
