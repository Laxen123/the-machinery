// scripts/coord/land/gates-core.mjs — plan 3961 T1: the CORE prepGate roster.
//
// WHAT IS DECLARED HERE vs INJECTED. This module owns the core's gate roster as DATA — which
// gates the generic spine contributes, their names, their order, their stage, whether they
// chunk. It does NOT own their implementations: `coreGates(impl)` takes them as parameters.
//
// That split is not stylistic, it is what Rule 3 forces and what the plan's own handoff note
// ("design the injection seam before moving any code") is about. A non-test module under
// scripts/coord/ may import only scripts/coord/** and node: builtins, so a core gate module
// CANNOT import anything under scripts/project/ — and, at the time this module was written,
// could not import done-worktree-lib.mjs, land-lib.mjs or coord-config.mjs either. All three have
// SINCE moved under scripts/coord/ themselves (plan 4096's coord-kit extraction program), but this
// module still takes them as `impl` parameters rather than importing them directly, unchanged.
// Every generic helper a core gate needs must therefore either move under
// scripts/coord/ or arrive as a parameter — and § Execution notes' do-not-touch list
// (landing-lock.mjs, landing-queue*.mjs, excl-lock.mjs, coord-edit.mjs) means some of them must
// be parameters permanently, not just until T3 gets round to them.
//
// So `impl` is the seam, and the shape below is the contract T2/T3 move code INTO. At T1 every
// implementation is still a thin wrapper closing over the existing call-site logic inside
// done-worktree.mjs, which is exactly what "every existing gate still runs through its old code
// path at this point" means: this file changes the ADDRESSING of a gate, never its behaviour.
//
// WHAT IS DELIBERATELY NOT HERE. A project's own additional gates — e.g. a UI-verification
// suite, a per-file test gate, a data-trust check, or a locale-copy check. They register through
// coord.config.json's `plugins.prepGates` from
// scripts/project/land-gates.mjs (T2). The core neither names them nor knows they exist — which
// is the whole point, and why `order` and `stage` are per-entry rather than something the core
// arranges.
import { PREP_GATE_STAGES, optionalEntryKeys } from './registry.mjs';

// Fields the core spec itself sets on every entry (`name`/`order`/`stage`/`chunkable`/`run` above)
// and therefore owns — an impl bag supplying one of these is a bug, not an override, so it is
// refused rather than silently applied or silently ignored (see the throw below).
const CORE_OWNED_FIELDS = Object.freeze(new Set(['chunkable', 'stage']));

// Every OTHER optional field registry.mjs declares for a prepGates entry is fair game to relay
// from an impl bag. Deriving this from optionalEntryKeys('prepGates') — instead of hand-listing
// `applies`, `cacheKey`, `passCacheGate`, … a second time here — is the whole point of this file's
// relay: a field newly declared optional in the registry (plan 4042 added `select`, `reclassify`,
// `remainder`, `invalidatedBy`, `seams`) reaches this relay with NO edit to this module, and a key
// on an impl bag that neither the registry nor the core spec recognizes throws below instead of
// vanishing the way `seams` did before this change.
const RELAYABLE_FIELDS = optionalEntryKeys('prepGates').filter((k) => !CORE_OWNED_FIELDS.has(k));

/**
 * The core's own gate roster, as data. Order values are the spine's inline step labels; see
 * registry.mjs's header for why those are usable as sort keys within one registry.
 *
 * `prettier-drift` is the one that earns the `stage` field: it runs in phaseLaneMerge AFTER the
 * rebase (step 3b.5), because post-rebase drift is precisely what it inspects — running it in
 * phasePreflight would inspect a tree the merge has not produced yet.
 */
export const CORE_PREP_GATE_SPECS = Object.freeze([
  Object.freeze({ key: 'build', name: 'build', order: 2.6, stage: 'preflight', chunkable: true }),
  Object.freeze({
    key: 'battery',
    name: 'scripts-battery',
    order: 2.662,
    stage: 'preflight',
    chunkable: true,
  }),
  Object.freeze({
    key: 'prettier',
    name: 'prettier-drift',
    order: 3.5,
    stage: 'lane-merge',
    chunkable: false,
  }),
]);

/**
 * Build the core prepGate entries from an `impl` bag.
 *
 * `impl` is keyed by the `key` field above (`build`, `battery`, `prettier`), each value an object
 * `{ run, ...optional }` whose `run` carries today's behaviour. A missing key means the host does
 * not provide that gate and it is simply not registered — a repo with no frontend has no build
 * gate, and that must not be an error. `...optional` is whatever RELAYABLE_FIELDS names above
 * (today: `applies`, `cacheKey`, `passCacheGate`, `prepPass`, `select`, `reclassify`, `remainder`,
 * `invalidatedBy`, `seams` — always registry.mjs's own `optionalEntryKeys('prepGates')` minus
 * `chunkable`/`stage`, never a list copied here) — every value is relayed opaquely, never
 * interpreted by this module: registry.mjs's normalizeEntry is what gives each one meaning, and
 * this file's job stops at "the impl bag said so, so the entry carries it."
 *
 * Returns a plain array, ready to hand to buildRegistry('prepGates', [{ where: 'core', entries }]).
 */
export function coreGates(impl = {}) {
  // The BAG itself must be a plain object (review round 3, finding 267615): `Object.keys(false)`
  // and `Object.keys([])` are both empty, so a non-object bag sailed through the unknown-key check
  // below and then read every spec as absent — registering NOTHING, silently.
  if (impl === null || typeof impl !== 'object' || Array.isArray(impl)) {
    throw new Error(
      `gates-core: impl must be a plain object keyed by gate key (got ` +
        `${Array.isArray(impl) ? 'an array' : typeof impl})`,
    );
  }
  // An UNKNOWN impl key is refused (review round 2, finding 224f94). `coreGates({ buidl: {…} })`
  // registered nothing and said nothing — a typo that silently drops a gate, the same class as
  // registry.mjs's own unknown-entry-key refusal.
  const known = new Set(CORE_PREP_GATE_SPECS.map((s) => s.key));
  const unknown = Object.keys(impl).filter((k) => !known.has(k));
  if (unknown.length) {
    throw new Error(
      `gates-core: impl has unknown key(s) ${unknown.join(', ')} — valid keys: ` +
        `${[...known].join(', ')}`,
    );
  }
  const entries = [];
  for (const spec of CORE_PREP_GATE_SPECS) {
    const provided = impl[spec.key];
    // An absent key declines the gate, and so does an explicit `null` — the two ways a host spells
    // "I am not registering this one" (review round 1, findings dff9bd/c9a4e5). Every OTHER falsy
    // value is refused below rather than swallowed: `!provided` used to accept `false`, `0` and
    // `''` too, so a host that computed its impl bag and produced a falsy value by accident would
    // silently drop that gate, which is the silent-skip class this registry exists to make
    // impossible. gpt-review, round 1: this comment previously claimed ONLY absence declines,
    // which the line below has never done — the code is right and the sentence was not.
    if (provided === undefined || provided === null) continue;
    if (typeof provided !== 'object') {
      throw new Error(
        `gates-core: impl.${spec.key} must be an object with run() (got ${typeof provided}) — ` +
          `omit the key entirely to decline "${spec.name}"`,
      );
    }
    if (typeof provided.run !== 'function') {
      throw new Error(
        `gates-core: impl.${spec.key} must provide run() — it is the gate's implementation, and ` +
          `omitting the whole key is how you decline to register "${spec.name}"`,
      );
    }
    const entry = {
      name: spec.name,
      order: spec.order,
      stage: spec.stage,
      chunkable: spec.chunkable,
      run: provided.run,
    };
    // A key the impl bag has no business setting: either the core spec already owns it (the
    // entry above sets `chunkable`/`stage` from CORE_PREP_GATE_SPECS, and a per-host override
    // would silently win or silently lose depending on object key order — refused instead), or
    // it is not a field registry.mjs declares for a prepGates entry at all (the same unknown-key
    // defect class as the impl-bag-key check above, one level down: a typo here used to register
    // a gate simply missing the field it meant to set).
    for (const key of Object.keys(provided)) {
      if (key === 'run') continue;
      if (CORE_OWNED_FIELDS.has(key)) {
        throw new Error(
          `gates-core: impl.${spec.key} sets "${key}", but the core gate spec already owns ` +
            `"${key}" for "${spec.name}" (${JSON.stringify(spec[key])}) — remove it from the ` +
            `impl bag; change the spec in CORE_PREP_GATE_SPECS instead if the value is wrong`,
        );
      }
      if (!RELAYABLE_FIELDS.includes(key)) {
        throw new Error(
          `gates-core: impl.${spec.key} has unknown field "${key}" for gate "${spec.name}" — ` +
            `valid fields: run, ${RELAYABLE_FIELDS.join(', ')}`,
        );
      }
    }
    // PRESENCE, not truthiness (review round 2, findings 485547/6ff4a3): `if (provided.applies)`
    // silently dropped a falsy-but-present value (`applies: 0`) instead of passing it on to
    // registry.mjs's normalizeEntry, which would reject it as a non-function. Dropping it turns a
    // typo into a gate that always applies; forwarding it turns the same typo into an error. The
    // relay now covers every field in RELAYABLE_FIELDS, not three hand-picked names, so a field
    // newly declared optional in registry.mjs reaches here with no edit to this loop.
    for (const key of RELAYABLE_FIELDS) {
      if (provided[key] !== undefined) entry[key] = provided[key];
    }
    entries.push(entry);
  }
  return entries;
}

// Re-exported so a project gate module can spell its own `stage` against the same frozen list
// without importing the registry directly (and so this file's own stages are provably members).
export { PREP_GATE_STAGES };
