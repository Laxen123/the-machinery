// scripts/coord/land/seams-core.mjs — plan 3961 T1: the CORE landSeam roster.
//
// Same shape, and the same injection reasoning, as gates-core.mjs: this module declares WHICH
// seams the generic spine contributes and in what order; `coreSeams(impl)` takes their
// implementations as parameters because Rule 3 forbids a scripts/coord/ module from importing
// done-worktree-lib.mjs, where reviewSeam and findingsGate live today.
//
// ── conclusion-review (2.672) IS a core seam, whose field list is configuration ────────────────
// The plan's § Design table lists "conclusion review" among the CORE seams; T1's header (this
// paragraph's predecessor) left that open against the § Appendix phase map's counter-claim that it
// is project-specific ("world-claim fields"). T2.6 closes it: the seam's MECHANISM (an established
// world-claim may not be overwritten without a fresh adversarial-review verdict) is entirely
// generic over sharded record files, and only the FIELD LIST is project vocabulary — the same
// shape deployServices took in plan 3960. That field list now lives at `coord.config.json ->
// land.worldClaimFields` (default empty, so a config-less repo gets no conclusion-review gate at
// all), and `conclusionReviewSeam` (done-worktree-lib.mjs) takes it as a parameter rather than
// reading its own retired `WORLD_CLAIM_FIELDS` constant.
import { optionalEntryKeys } from './registry.mjs';
/**
 * Adapt the spine's own seam convention (`null` = cleared, a `seam()`-shaped `{code,reason,…}`
 * object = halt) to the registry's `{ ok, seam, message }` contract.
 *
 * Plan 3961 T2 review (key 34fbae): this was a byte-identical private copy in BOTH
 * done-worktree.mjs's `coreSeamImpls()` (its `review`/`findings`/`conclusion` entries) and
 * scripts/project/land-seams.mjs's own project seam entries — a future
 * change to one copy without the other would make core and project seams emit inconsistent
 * `ok`/`message` results with nothing to catch it. ONE definition here, imported by both.
 *
 * gpt-review acb447 (CONFIRMED, land-blocking): the adapter first shipped as `…check(ctx).raw` —
 * unwrapping a field the registry's landSeams contract (`{ ok, seam, message }`) does not
 * mention. A seam returning the documented shape therefore yielded `undefined`, and every call
 * site spells its halt as `if (seam)`, so a registered land seam read as CLEARED and the land
 * continued. `seamResult` must emit ONLY the documented `{ ok, seam, message }` — see this
 * module's own test for the pin.
 */
export function seamResult(s) {
  return s ? { ok: false, seam: s.code, message: s.reason } : { ok: true, seam: null, message: '' };
}

// plan 4056: every optional field registry.mjs declares for a landSeams entry is relayed from the
// impl bag onto the entry this module builds. DERIVED from optionalEntryKeys('landSeams'), never
// hand-listed — gates-core.mjs's own RELAYABLE_FIELDS header explains why a second hand-written
// copy is the same defect class this registry exists to prevent, and this file had the bug it
// describes: `coreSeams` built `{ name, order, check }` and dropped everything else, so the one
// core-registered seam that now needs `applies`/`seamCode`/`markerFamily` would have had them
// vanish silently on the way to the registry. `name`/`order` stay owned by the spec below.
const RELAYABLE_SEAM_FIELDS = optionalEntryKeys('landSeams');

/**
 * The core's own seam roster, as data. Order values are the spine's inline step labels; within
 * the landSeams registry they sort into the documented seam order (registry.mjs's header explains
 * why that is true per-registry even though it is false across the whole spine).
 */
export const CORE_LAND_SEAM_SPECS = Object.freeze([
  Object.freeze({ key: 'review', name: 'review-marker', order: 2.5 }),
  Object.freeze({ key: 'findings', name: 'findings-open', order: 2.55 }),
  Object.freeze({ key: 'conclusion', name: 'conclusion-review', order: 2.672 }),
]);

/**
 * Build the core landSeam entries from an `impl` bag.
 *
 * `impl` is keyed by the `key` field above, each value `{ check }` — a function taking the land
 * ctx and returning `{ ok, seam, message }`. A missing key is not registered rather than being an
 * error, matching coreGates: a host that does not do code review has no review seam.
 */
export function coreSeams(impl = {}) {
  // The BAG itself must be a plain object (review round 3, finding 267615): `Object.keys(false)`
  // and `Object.keys([])` are both empty, so a non-object bag sailed through the unknown-key check
  // below and read every spec as absent — here that means the review-marker and findings-open
  // seams, the two that stop an unreviewed diff from landing, silently disappearing.
  if (impl === null || typeof impl !== 'object' || Array.isArray(impl)) {
    throw new Error(
      `seams-core: impl must be a plain object keyed by seam key (got ` +
        `${Array.isArray(impl) ? 'an array' : typeof impl})`,
    );
  }
  // An UNKNOWN impl key is refused, same as coreGates (review round 2, finding 224f94's sibling):
  // a typo'd key would silently register no seam at all.
  const known = new Set(CORE_LAND_SEAM_SPECS.map((s) => s.key));
  const unknown = Object.keys(impl).filter((k) => !known.has(k));
  if (unknown.length) {
    throw new Error(
      `seams-core: impl has unknown key(s) ${unknown.join(', ')} — valid keys: ` +
        `${[...known].join(', ')}`,
    );
  }
  const entries = [];
  for (const spec of CORE_LAND_SEAM_SPECS) {
    const provided = impl[spec.key];
    // ONLY an absent key declines the seam (review round 1, findings 881148/c6acdb). `!provided`
    // also swallowed `false`/`0`/`''`, which would silently drop the review-marker or
    // findings-open seam — the two that stop an unreviewed diff from landing.
    if (provided === undefined || provided === null) continue;
    if (typeof provided !== 'object') {
      throw new Error(
        `seams-core: impl.${spec.key} must be an object with check() (got ${typeof provided}) — ` +
          `omit the key entirely to decline "${spec.name}"`,
      );
    }
    if (typeof provided.check !== 'function') {
      throw new Error(
        `seams-core: impl.${spec.key} must provide check() — omitting the whole key is how you ` +
          `decline to register "${spec.name}"`,
      );
    }
    // An impl-bag key that is neither `check` nor a field the registry declares optional for a
    // landSeams entry is refused, not ignored — the gates-core twin of the same check, and the
    // reason is the same: a typo would otherwise register a seam simply missing the field it
    // meant to set (an absent `applies` means ALWAYS applies, an absent `seamCode` means no
    // resume valve at all). `name`/`order` come from the spec, so an impl bag setting either is
    // a bug rather than an override.
    for (const key of Object.keys(provided)) {
      if (key === 'check') continue;
      if (key === 'name' || key === 'order') {
        throw new Error(
          `seams-core: impl.${spec.key} sets "${key}", but the core seam spec already owns it ` +
            `for "${spec.name}" (${JSON.stringify(spec[key])}) — change CORE_LAND_SEAM_SPECS ` +
            `instead if the value is wrong`,
        );
      }
      if (!RELAYABLE_SEAM_FIELDS.includes(key)) {
        throw new Error(
          `seams-core: impl.${spec.key} has unknown field "${key}" for seam "${spec.name}" — ` +
            `valid fields: check, ${RELAYABLE_SEAM_FIELDS.join(', ')}`,
        );
      }
    }
    const entry = { name: spec.name, order: spec.order, check: provided.check };
    // PRESENCE, not truthiness — same reasoning as gates-core's relay: forwarding a falsy-but-
    // present value turns a typo into registry.mjs's own error instead of a silently absent field.
    for (const key of RELAYABLE_SEAM_FIELDS) {
      if (provided[key] !== undefined) entry[key] = provided[key];
    }
    entries.push(entry);
  }
  return entries;
}
