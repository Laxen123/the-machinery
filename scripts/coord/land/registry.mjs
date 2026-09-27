// scripts/coord/land/registry.mjs — plan 3961 T1: the land spine's extension-point registry.
//
// WHAT THIS IS. The land spine interleaves generic "land a branch" steps with project-only ones
// (a UI-verification gate, a slow per-file test gate, a data-trust gate, a domain-specific landing-lock,
// a documentation-coverage checkpoint, the deploy trigger). This module is the seam that lets the
// generic half stop knowing about the project half: a step declares itself as an ENTRY in one of
// five registries, the spine runs each registry in order, and which entries exist is a property
// of the repo's configuration rather than of the spine's source.
//
// It is deliberately PURE — no fs, no child_process, no git, and (Rule 3,
// docs/coord/scripts-layout.md) no import of anything at all. Every function here is a
// total function of its inputs. The IO lives in the spine, which builds the entries and calls
// these runners; that is what makes the registry testable without a git sandbox and what keeps a
// public extraction of scripts/coord/ able to load this file on its own.
//
// ── THE FIVE EXTENSION POINTS ─────────────────────────────────────────────────────────────────
// Four come from the plan's § Design table; `contextExtras` is the fifth, added here for the
// project pieces that table does not cover (a domain-lane resolution, a domain-gate view hoist,
// a domain-specific landing-lock). Those are not gates or seams — they are domain-specific
// CONTEXT the spine computes and hands to gates — and the alternative to an extension point for
// them is pushing domain vocabulary into the core, which is the thing this split exists to stop.
// See the plan's § Appendix "Boundary read-off for T1-T3".
//
//   prepGates[]      { name, order, applies(diff, ctx), run(ctx) -> {ok, seam, detail},
//                      select(diff, ctx)?, reclassify(classification, result, ctx)?,
//                      provesGate(result)?, seams?, lifecycle+step (preflight stage only), ... }
//   landSeams[]      { name, order, check(ctx) -> {ok, seam, message} }
//   contextExtras[]  { name, order, run(ctx) -> object | null }   merged into ctx
//   postMerge[]      { name, order, run(ctx) }                    after the merge is on origin
//   closeOutExtras[] { name, order, run(ctx) }                    after archive/board/INDEX
//
// ── WHY EVERY ENTRY CARRIES AN EXPLICIT `order` ───────────────────────────────────────────────
// The § Design table does not list one; it is added here because without it the registry cannot
// do its job. A project gate frequently belongs BETWEEN two core gates (a project's data-trust
// gate runs before the core build gate; its UI-verification and per-file-test gates run between the core
// build and the core second heavy gate), and the whole point of the split is that the core does
// not know those gates exist — so it cannot place them, and registration order alone would force
// the core to enumerate its extenders. An explicit sort key is the smallest thing that lets each
// side declare only its own position.
//
// The values are FLOATS, and today's values are exactly the spine's own inline step labels
// (`2.5`, `2.55`, `2.59`, `2.6`, `2.66`, `2.661`, `2.662`, `2.67`, `2.672`, `2.68`). That is a
// deliberate reuse of vocabulary a reader of done-worktree.mjs and of
// docs/coord/land-spine.md already has, and it is why a fractional key is
// the right shape: `2.661` sits between `2.66` and `2.67` with nothing renumbered, which is
// precisely the insertion the spine's own history keeps performing.
//
// A CAVEAT worth stating, because those runbooks state the opposite about the labels and both
// statements are true at their own scope: the spine's step numbers are documented as "names, not
// execution order", and ACROSS the whole spine they genuinely are not ordered — the cheap
// paperwork seams (2.67, 2.672, 2.68) run BEFORE the slow gates (2.59, 2.6, 2.66, 2.661, 2.662)
// since plan 3499, so a single numeric sort over all ten would reorder the spine. WITHIN each
// registry, though, today's labels do sort correctly: seams run 2.5, 2.55, 2.67, 2.672, 2.68 and
// gates run 2.59, 2.6, 2.66, 2.661, 2.662, each ascending. Splitting gates from seams is exactly
// what removes the interleaving that made the labels unsortable. So the numbers are usable as
// keys HERE without contradicting the runbook — but they are keys because each entry declares
// one, never because a label is parsed, and a future reordering changes the key rather than
// the label's meaning.

/**
 * The five extension points, in the order the spine runs them across a land.
 *
 * landSeams come BEFORE prepGates, which is easy to get backwards (review round 1, finding
 * 2040f1 — this list had it wrong): since plan 3499 the cheap paperwork seams (2.5, 2.55, 2.67,
 * 2.672, 2.68) all run BEFORE the slow preflight gates (2.59, 2.6, 2.66, 2.661, 2.662), so the
 * spine stops on a missing review marker or an open finding without first paying for a build.
 * Nothing dispatches off this order today — buildRegistries builds every point regardless — so
 * it is documentation, which is exactly why it has to be right.
 */
export const EXTENSION_POINTS = Object.freeze([
  'contextExtras',
  'landSeams',
  'prepGates',
  'postMerge',
  'closeOutExtras',
]);

/**
 * Where in the spine a prepGate runs. NOT every prepGate runs at the same point, which the
 * § Design table does not say and the § Appendix's own read-off does:
 *
 *   preflight   — inside phasePreflight, pre-queue. build (2.6), a second heavy gate (2.662), and
 *                 a project's data-trust (2.59) / UI-verification (2.66) / per-file-test (2.661) gates.
 *   lane-merge  — inside phaseLaneMerge, AFTER the rebase, because that is what it inspects:
 *                 the prettier-drift check (3b.5) cannot run earlier and mean anything.
 *   deploy-wall — only behind `--deploy`, in phaseDeployCheck's mandatory pre-deploy battery.
 *                 a project's locale-copy gate runs here and NOWHERE else.
 *
 * This is a field rather than something the spine infers, for the same reason `order` is: the
 * alternative is the core hardcoding which gate NAMES run where, and a locale-copy gate is a
 * project-specific gate — so that would put project knowledge back in the core, which is the
 * coupling this split exists to remove. Default 'preflight' (the common case).
 */
export const PREP_GATE_STAGES = Object.freeze(['preflight', 'lane-merge', 'deploy-wall']);

/**
 * How much machinery the preflight driver wraps around a gate's own step (plan 4056).
 *
 *   generic — the driver hands the step a prepared `runPrepGateLifecycle` runner as its second
 *             argument, already closed over this registry and this entry's name. The step calls
 *             it with its own options bag and reads the outcome.
 *   custom  — the driver hands the step `null`. The gate owns its whole protocol, because the
 *             shared lifecycle has no slot for it: today that means a fixed multi-way outcome
 *             precedence and a partial-proof recording (plan 4042 D-M14 measured what adopting
 *             the lifecycle would cost such a gate and ruled the hooks out).
 *
 * The driver DISPATCHES off this, which is the whole point of the field: a declaration the
 * driver does not act on would be a label, and this registry's own history (D-M17, and the two
 * fields plan 4042 deleted) is that a label reads as a supported capability and is worse than
 * nothing. NO DEFAULT — an entry that runs at preflight says which it is.
 */
export const PREP_GATE_LIFECYCLES = Object.freeze(['generic', 'custom']);

// Per-point shape: which function keys are required, and which are optional. Kept as data so the
// validator, the error messages and the tests all read one description instead of three.
const POINT_SHAPES = Object.freeze({
  prepGates: Object.freeze({
    required: ['run'],
    optional: [
      'applies',
      'cacheKey',
      'passCacheGate',
      'chunkable',
      'stage',
      'prepPass',
      // plan 4042 (D-M7/D-M8/D-M9): the generic gate lifecycle's two named hooks for the variance
      // the measured contract found genuine — a scoped-vs-full selection, and a
      // red-into-a-different-verdict reclassification — plus the `seams` metadata below. Both are
      // OPTIONAL with a stated default (see normalizeEntry's own validation and the lifecycle's
      // own header for exactly what "no hook declared" means at each).
      //
      // plan 4042 (D-M14, 2026-09-17): `remainder` and `invalidatedBy` were declared here by the
      // same change and are GONE again, having been declared and never implemented — the
      // lifecycle called neither, and a read-only survey of the gates they were declared FOR
      // established that the declared shapes were wrong anyway (the one real remainder narrows to
      // a domain-entity id list, which a `remainder(provenSha, ctx)` signature cannot express).
      // A declared field with no implementation and no adopter is worse than an absent one: it
      // reads as a supported capability. If a later pass needs either, it arrives WITH its
      // adopter, in the same change, shaped by that adopter.
      'select',
      'reclassify',
      // plan 4042 (D-M12): does a run() that comes back green actually prove this gate's
      // subject, or is it a success that verified nothing (a configured escape hatch that
      // executed nothing)? Optional, defaulting to always-true (see the lifecycle's own
      // `withUnprovenClassification`), so an entry that never has this shape of green declares
      // nothing and keeps classifying exactly as it does today.
      'provesGate',
      'seams',
      // plan 4056 (the gate fold): the entry's own preflight STEP, and the declaration of which
      // machinery surrounds it. Listed as optional HERE because this table is per-POINT, and
      // these two are per-STAGE: the conditional check below requires them on a preflight-stage
      // entry and refuses them on any other. See that check for why the condition is mechanical
      // rather than a convention.
      'lifecycle',
      'step',
    ],
  }),
  // plan 4056 (the seam fold): three optional fields that let ONE generic driver run a seam
  // end to end, instead of each seam's own bespoke wrapper re-spelling the same seven-step
  // shape (an applicability guard, a marker lookup deliberately outside the `--resume` guard,
  // the resume skip, the check, a stale-marker re-pin + re-check, the rework-halt-that-releases-
  // the-slot, and the marker-table halt). Three wrappers spelled that shape three times, which
  // is the duplication finding `elukwb` names.
  //
  // This IS a widening of an extension point's contract — honestly describable as "a sixth
  // extension point in disguise" — and it is deliberate, bounded, and arrives WITH its adopters
  // in the same change (D-M14/D-M17; two fields declared without adopters were deleted at plan
  // 4042 for exactly that reason). Every field stays OPTIONAL: a seam that declares none is run
  // exactly as it is today.
  //
  //   applies(diff, ctx)   the outer guard the wrapper used to spell inline. No predicate =>
  //                        always applies, as at every other point.
  //   seamCode             the `--resume <CODE>` name this seam is waived by. A seam that
  //                        declares none has no resume valve and is never skipped.
  //   markerFamily         `{ key, lookup, recorder }` for a seam whose halt is satisfied by a
  //                        recorded marker: `key` is a marker-family key (validated for SHAPE
  //                        here and for MEMBERSHIP by the driver, which can import the family
  //                        table this import-free module cannot), `lookup(ctx)` reads the
  //                        marker, `recorder` names the script a stale marker re-pins through.
  //                        A seam that declares none halts bare, with no lookup and no re-pin.
  landSeams: Object.freeze({
    required: ['check'],
    optional: ['applies', 'seamCode', 'markerFamily'],
  }),
  contextExtras: Object.freeze({ required: ['run'], optional: ['applies'] }),
  postMerge: Object.freeze({ required: ['run'], optional: ['applies'] }),
  closeOutExtras: Object.freeze({ required: ['run'], optional: ['applies'] }),
});

/** Pure: is `p` one of the five names? Exported so a config validator need not re-list them. */
export function isExtensionPoint(p) {
  return EXTENSION_POINTS.includes(p);
}

function shapeFor(point) {
  const shape = POINT_SHAPES[point];
  if (!shape) {
    throw new Error(
      `land-registry: unknown extension point ${JSON.stringify(point)} ` +
        `(expected one of: ${EXTENSION_POINTS.join(', ')})`,
    );
  }
  return shape;
}

/**
 * Pure: the optional field names an entry may carry at `point`, as POINT_SHAPES declares them.
 *
 * Exported so a sibling core module can build its own relay allowlist FROM this declaration
 * instead of hand-listing the same names a second time (see gates-core.mjs's `coreGates`, whose
 * header explains why a hand-written second list is exactly the defect class this registry exists
 * to prevent — a field added here and forgotten there is silently dropped, not an error). Returns
 * a fresh array each call; POINT_SHAPES itself is frozen and never handed out directly.
 */
export function optionalEntryKeys(point) {
  return [...shapeFor(point).optional];
}

/**
 * Pure: validate ONE entry for `point`, returning a normalized copy.
 *
 * `where` names the entry's origin (a module path, or 'core') and appears in every error, because
 * the failure this validator exists to make legible is a project's plugin module exporting the
 * wrong shape — an error naming only the entry is one the reader cannot act on.
 *
 * Validation is strict on purpose: an entry with a typo'd key would otherwise register as a gate
 * that silently never runs, which on the land spine is the failure mode with no symptom.
 */
export function normalizeEntry(point, entry, where = 'unknown') {
  const shape = shapeFor(point);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`land-registry: ${point} entry from ${where} is not an object`);
  }
  const { name, order } = entry;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`land-registry: a ${point} entry from ${where} has no non-empty "name"`);
  }
  if (typeof order !== 'number' || !Number.isFinite(order)) {
    throw new Error(
      `land-registry: ${point} entry "${name}" (${where}) needs a finite numeric "order" — ` +
        `it is the sort key that places this entry among the others (see this module's header)`,
    );
  }
  for (const key of shape.required) {
    if (typeof entry[key] !== 'function') {
      throw new Error(
        `land-registry: ${point} entry "${name}" (${where}) must define ${key}() as a function`,
      );
    }
  }
  for (const key of shape.optional) {
    // Three optional keys are values rather than functions: `chunkable`/`prepPass` (boolean),
    // `stage` (one of PREP_GATE_STAGES) and `passCacheGate` (a string — see its own note below).
    if (entry[key] === undefined) continue;
    if (key === 'chunkable' || key === 'prepPass') {
      if (typeof entry[key] !== 'boolean') {
        throw new Error(
          `land-registry: ${point} entry "${name}" (${where}) has a non-boolean "${key}"`,
        );
      }
      continue;
    }
    if (key === 'stage') {
      if (!PREP_GATE_STAGES.includes(entry[key])) {
        throw new Error(
          `land-registry: ${point} entry "${name}" (${where}) has stage ` +
            `${JSON.stringify(entry[key])} — expected one of: ${PREP_GATE_STAGES.join(', ')}`,
        );
      }
      continue;
    }
    // plan 3961 T3.5b: `passCacheGate` names WHICH entry of the host's own content-cache registry
    // (e.g. scripts/gate-pass-cache.mjs's `GATES`) this once-per-land gate is keyed against — a
    // plain string, unlike `cacheKey` (a function; a different, still-unwired extension point).
    // This module cannot know or validate the host's cache-gate names (Rule 3: a coord/ module
    // imports only coord/** and node: builtins) — only that a HOST that declares one means it, so
    // a typo becomes an error here instead of a silently-never-cached gate three files away.
    if (key === 'passCacheGate') {
      if (typeof entry[key] !== 'string' || !entry[key].trim()) {
        throw new Error(
          `land-registry: ${point} entry "${name}" (${where}) has a non-string "${key}"`,
        );
      }
      continue;
    }
    // plan 4042 (D-M7): the entry owns its OWN seam names — the runner emits whichever of
    // these three the gate's own outcome selects, never a hardcoded SEAM link. The exit code
    // for each stays where it already lives (the host's SEAM/EXIT enum, keyed by the seam code
    // this names) — see the gate lifecycle's own header for why a code is enough here.
    if (key === 'seams') {
      const seams = entry[key];
      if (!seams || typeof seams !== 'object' || Array.isArray(seams)) {
        throw new Error(
          `land-registry: ${point} entry "${name}" (${where}) has a non-object "seams"`,
        );
      }
      const seamSlots = new Set(['failed', 'chunked', 'starved']);
      const unknownSlots = Object.keys(seams).filter((k) => !seamSlots.has(k));
      if (unknownSlots.length) {
        throw new Error(
          `land-registry: ${point} entry "${name}" (${where}) has unknown seams key(s) ` +
            `${unknownSlots.join(', ')} — valid keys: ${[...seamSlots].join(', ')}`,
        );
      }
      for (const slot of seamSlots) {
        if (seams[slot] === undefined) continue;
        if (typeof seams[slot] !== 'string' || !seams[slot].trim()) {
          throw new Error(
            `land-registry: ${point} entry "${name}" (${where}) has a non-string seams.${slot}`,
          );
        }
      }
      continue;
    }
    // plan 4056: a landSeam's `--resume` code. Same reasoning as `passCacheGate` above — this
    // module cannot know the host's SEAM enum (Rule 3), only that a host declaring one means it,
    // so a non-string is an error here rather than a seam whose resume valve silently never
    // matches.
    if (key === 'seamCode') {
      if (typeof entry[key] !== 'string' || !entry[key].trim()) {
        throw new Error(
          `land-registry: ${point} entry "${name}" (${where}) has a non-string "${key}"`,
        );
      }
      continue;
    }
    // plan 4056: `{ key, lookup, recorder }`. SHAPE only — whether `key` names a real marker
    // family is the driver's check, because the family table lives in a module this import-free
    // one may not reach. Both halves matter: a typo'd key with no membership check yields no
    // rework label and no preflight-marker slot, silently, which is the failure mode this
    // registry exists to turn into an error.
    if (key === 'markerFamily') {
      const fam = entry[key];
      if (!fam || typeof fam !== 'object' || Array.isArray(fam)) {
        throw new Error(
          `land-registry: ${point} entry "${name}" (${where}) has a non-object "markerFamily"`,
        );
      }
      const famKeys = new Set(['key', 'lookup', 'recorder']);
      const unknownFam = Object.keys(fam).filter((k) => !famKeys.has(k));
      if (unknownFam.length) {
        throw new Error(
          `land-registry: ${point} entry "${name}" (${where}) has unknown markerFamily key(s) ` +
            `${unknownFam.join(', ')} — valid keys: ${[...famKeys].join(', ')}`,
        );
      }
      for (const strKey of ['key', 'recorder']) {
        if (typeof fam[strKey] !== 'string' || !fam[strKey].trim()) {
          throw new Error(
            `land-registry: ${point} entry "${name}" (${where}) needs a non-empty string ` +
              `markerFamily.${strKey}`,
          );
        }
      }
      if (typeof fam.lookup !== 'function') {
        throw new Error(
          `land-registry: ${point} entry "${name}" (${where}) must define markerFamily.lookup() ` +
            `as a function`,
        );
      }
      continue;
    }
    // plan 4056: the gate fold's `lifecycle` is an enum, not a function. Validated by VALUE here
    // and by STAGE below — the two halves answer different questions ("is this a lifecycle we
    // know?" vs "may this entry carry one at all?").
    if (key === 'lifecycle') {
      if (!PREP_GATE_LIFECYCLES.includes(entry[key])) {
        throw new Error(
          `land-registry: ${point} entry "${name}" (${where}) has lifecycle ` +
            `${JSON.stringify(entry[key])} — expected one of: ${PREP_GATE_LIFECYCLES.join(', ')}`,
        );
      }
      continue;
    }
    if (typeof entry[key] !== 'function') {
      throw new Error(
        `land-registry: ${point} entry "${name}" (${where}) has a non-function "${key}"`,
      );
    }
  }
  // plan 4056 (the gate fold, D-4056-12): `lifecycle` and `step` are REQUIRED on a
  // preflight-stage prepGate and REFUSED on every other stage.
  //
  // Scoped rather than universal because the preflight driver is the only thing that reads them:
  // a lane-merge gate is driven from the post-rebase step and a deploy-wall gate from the deploy
  // wall's own table, and neither looks at a `step`. Requiring one there would register a field
  // nothing calls — the D-M17 shape ("a declaration nothing checks is not a contract") this
  // module already deleted two fields for, and the exact fig leaf `lifecycle` exists to avoid.
  //
  // Scoped MECHANICALLY rather than by convention, because an unstated condition is the other
  // half of the same defect: a preflight entry that simply forgot both fields would otherwise be
  // a gate the driver skips in silence, which this module's header calls the failure mode with no
  // symptom. Both directions are errors naming the entry.
  if (point === 'prepGates') {
    const stage = entry.stage ?? 'preflight';
    const declared = ['lifecycle', 'step'].filter((k) => entry[k] !== undefined);
    if (stage === 'preflight') {
      for (const key of ['lifecycle', 'step']) {
        if (entry[key] === undefined) {
          throw new Error(
            `land-registry: prepGates entry "${name}" (${where}) runs at stage "preflight" and ` +
              `must declare "${key}" — the preflight driver executes registered entries, so a ` +
              `gate that declares no step is one it silently never runs`,
          );
        }
      }
      // A `step` that is PRESENT but not a function needs no check here: it is an ordinary
      // optional key, so the loop above already refused it ("has a non-function step"), naming
      // the entry. What this block adds is the part that loop cannot see — presence/absence
      // conditioned on the stage.
    } else if (declared.length) {
      throw new Error(
        `land-registry: prepGates entry "${name}" (${where}) runs at stage ` +
          `${JSON.stringify(stage)} and must NOT declare ${declared.join('/')} — only the ` +
          `preflight driver reads them, so an entry at this stage would be declaring a ` +
          `capability nothing calls`,
      );
    }
  }
  // Reject keys the point does not define. A plugin that spells `applies` as `appliesTo` would
  // otherwise register a gate whose applies() is missing, i.e. one that always runs — a silent
  // behaviour change rather than an error.
  const known = new Set(['name', 'order', ...shape.required, ...shape.optional]);
  const unknown = Object.keys(entry).filter((k) => !known.has(k));
  if (unknown.length) {
    throw new Error(
      `land-registry: ${point} entry "${name}" (${where}) has unknown key(s) ` +
        `${unknown.join(', ')} — valid keys: ${[...known].join(', ')}`,
    );
  }
  return { ...entry, where };
}

/**
 * Pure: validate + order the entries of ONE extension point.
 *
 * Sort is by `order` ascending, with registration index as a STABLE tiebreak so two entries
 * sharing a key keep the order their source listed them in (deterministic, and a golden over the
 * phase trace therefore cannot flap). Duplicate NAMES are refused outright — two gates called
 * `build` make every by-name consumer (`gatesProven`'s roster, the resume seams, the telemetry
 * rows) ambiguous, and silently keeping one of them is how a gate stops running.
 */
export function buildRegistry(point, sources = []) {
  shapeFor(point);
  const entries = [];
  for (const source of sources) {
    const where = source?.where ?? 'unknown';
    // A source with no `entries` key at all is a BUG, not an empty source (review round 1,
    // finding a572d8): `{ where, gates: [...] }` — the plausible typo — used to register nothing
    // and say nothing. An explicitly EMPTY array stays legal; that is a real "this module
    // contributes none".
    if (!source || !('entries' in source)) {
      throw new Error(
        `land-registry: ${point} source ${where} has no "entries" — an empty array is how a ` +
          `source declares it contributes nothing`,
      );
    }
    const list = source.entries;
    if (!Array.isArray(list)) {
      throw new Error(`land-registry: ${point} source ${where} did not provide an array`);
    }
    for (const raw of list) entries.push(normalizeEntry(point, raw, where));
  }
  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.name)) {
      throw new Error(
        `land-registry: ${point} has two entries named "${e.name}" ` +
          `(${seen.get(e.name)} and ${e.where}) — names are how gatesProven, --resume and the ` +
          `gate telemetry address an entry, so they must be unique`,
      );
    }
    seen.set(e.name, e.where);
  }
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.order - b.e.order || a.i - b.i)
    .map(({ e }) => e);
}

/**
 * Pure: build all five registries at once. `sources` maps a point name to an array of
 * `{ where, entries }` records — typically the core's own entries followed by each configured
 * plugin module's. A point with no source is an EMPTY registry, never an error: a config-less
 * repo registers nothing and still lands.
 */
export function buildRegistries(sources = {}) {
  for (const key of Object.keys(sources)) {
    if (!isExtensionPoint(key)) {
      throw new Error(
        `land-registry: sources names "${key}", which is not an extension point ` +
          `(expected one of: ${EXTENSION_POINTS.join(', ')})`,
      );
    }
  }
  const out = {};
  for (const point of EXTENSION_POINTS) out[point] = buildRegistry(point, sources[point] ?? []);
  return Object.freeze(out);
}

/** The stage a prepGate runs at, defaulting to 'preflight' when the entry declares none. */
export function prepGateStage(gate) {
  return gate.stage ?? 'preflight';
}

/**
 * Does this prepGate ALSO run in the `--prep` pre-pass, or only at land time?
 *
 * A third axis beside `stage` and `order`, and a genuinely separate question from either: `stage`
 * says WHERE in a land a gate runs, `prepPass` says whether the out-of-band pre-pass — which
 * proves the slow gates while a branch waits for the FIFO head, so the land itself can skip them —
 * covers this gate at all. Today exactly one preflight-stage gate declines: a project's
 * data-trust gate (2.59) has no prep counterpart and is land-only, which
 * `PREP_GATE_TO_LAND_GATE`'s own comment in done-worktree-lib.mjs already records in prose.
 *
 * It is a registry field rather than a list the pre-pass keeps, for the reason every other field
 * here is: the alternative is a second roster somewhere else that has to be kept in step with this
 * one by hand, and "a gate that runs at land but not at prep, with nothing to catch it" is exactly
 * the divergence this plan's T1d exists to close. DEFAULT TRUE — a gate says nothing and is
 * covered by both passes, so declining is the deliberate act, not the accident.
 *
 * SCOPE, because the default reads as a stronger claim than it is (gpt-review ebfa7d): the `--prep`
 * pre-pass runs PREFLIGHT-stage gates and nothing else — it proves the slow pre-queue gates while a
 * branch waits for the FIFO head, and a lane-merge gate (prettier-drift inspects the POST-rebase
 * tree) or a deploy-wall gate (a locale-copy gate runs only behind `--deploy`) has no meaning there. So
 * this axis distinguishes a PREFLIGHT gate that is nonetheless land-only; on a gate of any other
 * stage the default `true` is not a claim that the pre-pass runs it, and `stage` already keeps it
 * out. That is why selectPrepGates takes `stage` and `prepPassOnly` as separate, composable
 * options rather than folding one into the other.
 */
export function prepGateRunsInPrepPass(gate) {
  return gate.prepPass !== false;
}

/**
 * Pure: which prepGates apply to this land, in order.
 *
 * An entry with no `applies` always applies. Pass `{ prepPassOnly: true }` to drop the gates that
 * decline the `--prep` pre-pass — see prepGateRunsInPrepPass. It is an option rather than a
 * caller-side `.filter()` so the pre-pass and the land read their roster through ONE function and
 * cannot drift in how they spell the question.
 *
 * Pass `{ stage }` to take only the gates that run at
 * one point in the spine — phasePreflight asks for 'preflight', phaseLaneMerge for 'lane-merge',
 * and the `--deploy` wall for 'deploy-wall'. Omitting it returns every stage.
 *
 * The once-per-land `gatesProven` ROSTER (which gate NAMES a sidecar may legitimately carry,
 * plan 3961 T2.7a) is NOT built by calling this with `stage` omitted — it wants preflight-stage
 * names only, and it wants them regardless of whether today's diff would trigger each one, since a
 * proof already banked on disk by an earlier invocation must stay recognized even when the current
 * diff does not re-trigger that gate. `entryApplies` filtering is therefore wrong for a roster and
 * right for a run: done-worktree.mjs's `landGateRosterFromRegistry` reads `registry.prepGates`
 * directly and filters on `prepGateStage(g) === 'preflight'` alone, bypassing this function.
 *
 * Selection is separated from RUNNING on purpose: the spine runs each gate itself because a
 * gate's surroundings (chunk budget, the gatesProven capture-before/re-read-after proof, the
 * cloud-only disk prune, per-gate telemetry) differ enough that a single generic runner would
 * have to re-grow all of it. What the registry owns is membership, stage and order; what the
 * spine owns is how a gate is run.
 */
export function selectPrepGates(gates, diff, ctx, { stage = null, prepPassOnly = false } = {}) {
  // Same refusal shape as the stage check below, for the same reason: a caller passing a
  // truthy-but-not-boolean `prepPassOnly` (a string, say) has a bug, and silently treating it as
  // `true` would drop gates without a word.
  if (typeof prepPassOnly !== 'boolean') {
    throw new Error(
      `land-registry: selectPrepGates: prepPassOnly must be a boolean (got ` +
        `${JSON.stringify(prepPassOnly)})`,
    );
  }
  // An unknown stage is REFUSED rather than matching nothing (review round 1, finding 2212df).
  // A typo at a spine call site would otherwise return an empty list — every gate silently
  // skipped, which this module's header calls out as the failure mode with no symptom.
  if (stage !== null && stage !== undefined && !PREP_GATE_STAGES.includes(stage)) {
    throw new Error(
      `land-registry: selectPrepGates: unknown stage ${JSON.stringify(stage)} — expected one of: ` +
        `${PREP_GATE_STAGES.join(', ')} (or null/omitted for every stage)`,
    );
  }
  return gates
    .filter((g) => stage === null || stage === undefined || prepGateStage(g) === stage)
    .filter((g) => !prepPassOnly || prepGateRunsInPrepPass(g))
    .filter((g) => entryApplies(g, diff, ctx, 'prepGates entry'));
}

// Both synchronous runners below refuse a thenable return. They are sync on purpose — the spine's
// seams and its context extras are computed from state already in hand — and an async one would
// have its Promise read as a truthy object and never awaited, i.e. a seam that always "passes".
// Loud refusal beats that silently (review round 1, alongside findings 01f446/efebc2).
function refuseThenable(value, what, name, where) {
  if (value && typeof value.then === 'function') {
    // Mark it handled before throwing (review round 2, findings e2348b/d4b985). Abandoning the
    // promise here meant a REJECTING one resurfaced later as an unhandled rejection — on the land
    // spine, a process-level crash attributed to the wrong place, long after this useful error
    // was already thrown.
    try {
      // `.then()` returns a NEW promise, and on a custom thenable that one can itself reject
      // (review round 3, finding 8faf63) — so the round-2 fix could create exactly the unhandled
      // rejection it was closing. Swallow both: the original, and whatever .then() handed back.
      const settled = value.then(
        () => {},
        () => {},
      );
      if (settled && typeof settled.then === 'function') {
        settled.then(
          () => {},
          () => {},
        );
      }
    } catch {
      /* a thenable whose then() throws is already the caller's bug; the throw below names it */
    }
    throw new Error(
      `land-registry: ${what} "${name}" (${where}) returned a Promise, but this runner is ` +
        `synchronous — its result would never be awaited. Make it synchronous, or move the work ` +
        `to a postMerge/closeOutExtras step, which are awaited.`,
    );
  }
  return value;
}

/**
 * Evaluate an entry's `applies()` predicate. ALWAYS synchronous, at every extension point
 * (review round 2, findings cc6ae9/aa3f53/8dfd76/fbf2e7): `!somePromise` is always false, so an
 * async predicate silently made its gate/extra/step ALWAYS apply — the same silent-inclusion bug
 * as round 1's truthy `ok`, one level down. An entry with no predicate always applies.
 */
function entryApplies(entry, diff, ctx, what) {
  if (typeof entry.applies !== 'function') return true;
  return Boolean(
    refuseThenable(entry.applies(diff, ctx), `${what} applies()`, entry.name, entry.where),
  );
}

/**
 * Pure: does this landSeam apply to the land in hand?
 *
 * Exported (plan 4056) so the generic seam driver asks the SAME question, through the same
 * thenable-refusing reader, that every other extension point asks — rather than reading
 * `entry.applies` itself and re-acquiring the async-predicate hole `entryApplies` closes (an
 * `async applies` makes `!promise` false, i.e. the seam always applies). A seam with no
 * predicate always applies.
 */
export function landSeamApplies(seam, diff, ctx) {
  return entryApplies(seam, diff, ctx, 'landSeams entry');
}

/**
 * Run `landSeams` in order, stopping at the FIRST seam that reports `ok: false`.
 *
 * Returns `{ ok, seam, message, name }` — `ok: true` with no seam when every check passed. The
 * stop-at-first contract mirrors what the spine does today (each seam `emitSeam()`s and exits),
 * and matters for a reason beyond cost: the seams are ordered cheapest-first, so reporting the
 * first is reporting the one the operator should act on.
 *
 * A check that returns a non-object, or `ok: false` with no `seam`, is a bug in that entry rather
 * than a land failure to report vaguely — it throws, naming the entry.
 */
export function runLandSeams(seams, ctx) {
  for (const s of seams) {
    const r = refuseThenable(s.check(ctx), 'landSeams entry', s.name, s.where);
    if (!r || typeof r !== 'object') {
      throw new Error(
        `land-registry: landSeams entry "${s.name}" (${s.where}) returned no result object`,
      );
    }
    // STRICT boolean (review round 1, findings 9fcc44/b1096e/68f22c/562bb1). `if (r.ok)` accepted
    // any truthy value, so a seam returning `{ok: 'false', seam: 'BLOCK'}` — a stringified verdict,
    // the shape a JSON round-trip or a shell-ish helper produces — read as PASSED and let an
    // unsafe land through. There are exactly two legal values and anything else is a bug in the
    // entry, reported as such rather than guessed at.
    if (typeof r.ok !== 'boolean') {
      throw new Error(
        `land-registry: landSeams entry "${s.name}" (${s.where}) returned a non-boolean "ok" ` +
          `(${JSON.stringify(r.ok)}) — a seam result must be exactly true or false`,
      );
    }
    if (r.ok) continue;
    if (!r.seam) {
      throw new Error(
        `land-registry: landSeams entry "${s.name}" (${s.where}) reported a failure with no "seam" code`,
      );
    }
    return { ok: false, seam: r.seam, message: r.message ?? '', name: s.name };
  }
  return { ok: true, seam: null, message: '', name: null };
}

/**
 * Run `contextExtras` in order, merging each one's returned object into a copy of `ctx`.
 *
 * Each extra sees the ctx the PREVIOUS extras already extended, so a later extra may build on an
 * earlier one's value (a project's domain-gate view hoist reads the domain lane the lane
 * resolution just computed). Returning `null`/`undefined` contributes nothing. An extra that
 * returns a non-object throws, naming itself.
 *
 * A key COLLISION is refused rather than silently overwritten: two extras both defining the same
 * context key would make the winner depend on registry order, which is exactly the kind of
 * order-dependent invisible coupling a registry is supposed to remove.
 */
export function runContextExtras(extras, ctx, diff) {
  let out = { ...ctx };
  const owner = new Map();
  for (const x of extras) {
    if (!entryApplies(x, diff, out, 'contextExtras entry')) continue;
    const add = refuseThenable(x.run(out), 'contextExtras entry', x.name, x.where);
    if (add === null || add === undefined) continue;
    if (typeof add !== 'object' || Array.isArray(add)) {
      throw new Error(
        `land-registry: contextExtras entry "${x.name}" (${x.where}) returned a non-object`,
      );
    }
    for (const key of Object.keys(add)) {
      if (owner.has(key)) {
        throw new Error(
          `land-registry: contextExtras entries "${owner.get(key)}" and "${x.name}" both define ` +
            `ctx.${key} — which one wins would depend on registry order`,
        );
      }
      owner.set(key, x.name);
    }
    out = { ...out, ...add };
  }
  return out;
}

/**
 * Run a plain `{ name, run(ctx) }` registry (`postMerge`, `closeOutExtras`) in order. ASYNC — each
 * step is awaited before the next begins, because these are the two points where the spine's work
 * genuinely is asynchronous (the deploy check talks to a hosting provider's API).
 *
 * Returns the list of entries that ran, so a caller can log or assert coverage. Errors propagate
 * by default; `{ bestEffort: true }` catches each entry's throw OR rejection and reports it in the
 * result instead, which is the contract the close-out extras want — a periodic
 * documentation-coverage sweep must never be why an otherwise-complete land reports failure, and
 * the spine treats it as best-effort today.
 */
export async function runStepRegistry(entries, ctx, { bestEffort = false, diff = null } = {}) {
  const ran = [];
  for (const e of entries) {
    // ASYNC, and the `applies()` call is INSIDE the guarded region (review round 1, findings
    // 01f446 / efebc2 / 097b26). Three separate holes closed by this shape:
    //   - postMerge's deploy check is genuine network IO, so an unawaited run() reported the step
    //     complete before it was, and the next step started underneath it;
    //   - a rejected promise escaped `try`/`catch` entirely, so bestEffort did not cover the very
    //     failures it exists for;
    //   - applies() ran outside the guard, so a throwing predicate killed the whole close-out
    //     sweep that bestEffort is meant to protect.
    const step = async () => {
      if (!entryApplies(e, diff, ctx, 'step entry')) return false;
      await e.run(ctx);
      return true;
    };
    if (!bestEffort) {
      if (await step()) ran.push({ name: e.name, ok: true, error: null });
      continue;
    }
    try {
      if (await step()) ran.push({ name: e.name, ok: true, error: null });
    } catch (err) {
      ran.push({ name: e.name, ok: false, error: err });
    }
  }
  return ran;
}
