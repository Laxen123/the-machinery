// scripts/coord/axis-tags.mjs — the fixed `[axis: <tag>]` vocabulary a parked plan's Blocked-by line
// (waiting-operator/) or a `## Grill questions` item (waiting-grill/) may declare (plan 4069
// task 1).
//
// Review round 2 (R2-9, key 79 efficiency): extracted out of move-plan.mjs into its own leaf so a
// consumer that needs only this DATA — drain-run.mjs's park writers — never has to import
// move-plan.mjs's whole heavyweight CLI module (node:fs, child_process, and ~15 coordination
// modules) for three constants + one regex. move-plan.mjs imports and RE-EXPORTS these under
// their existing names, so every pre-existing consumer/test keeps working unchanged.
//
// ZERO imports by design — the repo rule ("a non-test module under scripts/ must not import
// outside scripts/") is trivially satisfied by a pure-constants leaf, and it is what lets
// drain-run.mjs pull in this vocabulary without pulling in move-plan.mjs's dependency graph.

// The fixed axis vocabulary a parked question may declare — DATA, so the grill/operator gates,
// the park-writing skills (spec-pass, board-pass, pickup-plan, grill-lane, unblock-lane) and the
// cloud spec-sweep prompt all cite the SAME list rather than five independently-typed copies that
// could drift. `hold`/`manual` are OPERATOR-LANE-ONLY — an operator-imposed blanket hold, or an
// out-of-band action only the operator can take — never admitted on a waiting-grill/ question
// (see AXIS_TAGS_BY_UNBLOCK below for where they DO apply). Operator ruling 2026-09-20 (plan
// 4069): a session never brings the operator a technical design or plan-scope choice — it
// decides, records the choice under `## Session decisions`, and proceeds. Only a question that
// genuinely needs one of these seven axes may still park.
export const AXIS_TAGS = ['product', 'policy', 'money', 'access', 'data-ruling', 'hold', 'manual'];

// The axis subset each waiting-operator/ `unblock:` value admits: `unblock: decision` is a
// go/no-go or content call on an already-specified action — every axis except the out-of-band
// `manual` one; `unblock: manual` is an out-of-band operator action — `manual` or `access` only
// (the shape today's `unblock: manual` parks already carry by convention, now enforced by code
// instead of prose alone).
export const AXIS_TAGS_BY_UNBLOCK = {
  decision: AXIS_TAGS.filter((t) => t !== 'manual'),
  manual: ['manual', 'access'],
};

// The waiting-grill/ lane admits only the FIVE grill-shaped axes — `hold` and `manual` are
// OPERATOR-LANE-ONLY (per AXIS_TAGS' own header comment) and must never pass the grill gate, even
// though they are valid members of the canonical AXIS_TAGS list used by the waiting-operator/
// gates above. A `[axis: hold]` or `[axis: manual]` question belongs in waiting-operator/, not
// waiting-grill/.
export const GRILL_AXIS_TAGS = AXIS_TAGS.filter((t) => t !== 'hold' && t !== 'manual');

// Matches a `[axis: <tag>]` marker, optionally backtick-wrapped — the shape this repo's own
// grill sections already write it in. Not anchored: a waiting-operator/ `--blocked-by` reason
// only needs to CARRY the marker, while a per-question scan re-anchors it to each question's own
// opening text.
export const AXIS_TAG_RX = /`?\[axis:\s*([a-z0-9-]+)\]`?/i;
