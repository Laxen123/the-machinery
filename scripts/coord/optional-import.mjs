// scripts/coord/optional-import.mjs — plan 4096 T1: the ONE guarded optional-import seam.
//
// A core entry point (the land spine, the landing-queue watcher, the queued test wrapper) may load
// a project module that a checkout without a project layer simply does not have. "Does not have"
// must mean exactly one thing: the OPTIONAL MODULE ITSELF is absent. Everything else — the module
// exists but throws while loading, or it exists and one of ITS OWN imports is missing — is a broken
// project layer, and swallowing that would turn a broken gate module into a land that silently
// runs core-only with a green result to show for it (plan 4096 § Execution notes, E3(a)).
//
// So the guard is on the SPECIFIER, not on the error class: an ERR_MODULE_NOT_FOUND is swallowed
// only when the module Node could not find is the very URL the caller asked for.
//
// THE CALL SHAPE IS DELIBERATE: `importOptional(new URL('./x.mjs', import.meta.url), () =>
// import('./x.mjs'))`. The `import()` stays at the call site with a LITERAL specifier because
// select-battery-tests.mjs's pass-cache and module-graph.mjs's closure both read literal dynamic
// imports as ordinary edges, and only a COMPUTED specifier forces the repo-wide widen
// (`DYNAMIC_SPECIFIER_RX` exempts a plain quoted literal). Passing a computed URL into an
// `import()` inside this helper would be exactly that widen.
//
// Imports only node: builtins (Rule 3).
import { fileURLToPath } from 'node:url';

/**
 * True iff `err` is Node's not-found error for exactly `url` (a URL or an href string) — never for
 * a module that `url` itself tried to import.
 *
 * Node 20+ carries the unresolved module's URL on the error (`err.url`); that is the primary
 * check. Without it (an older runtime), the fallback reads the quoted path at the head of Node's
 * own message ("Cannot find module '<path>' imported from <importer>") and compares it exactly —
 * the importer half is ignored, so a missing dependency of the optional module, whose message
 * names the OPTIONAL module as its importer, never matches.
 */
export function isMissingModule(err, url) {
  if (!err || err.code !== 'ERR_MODULE_NOT_FOUND') return false;
  const href = String(url instanceof URL ? url.href : url);
  if (typeof err.url === 'string') return err.url === href;
  const m = /^Cannot find module '([^']+)'/.exec(String(err.message || ''));
  if (!m) return false;
  let wanted;
  try {
    wanted = fileURLToPath(href);
  } catch {
    return false;
  }
  return m[1] === wanted;
}

/**
 * Run `load()` (the caller's own literal `import()`), returning its namespace — or `null` when,
 * and only when, the module at `url` does not exist. Any other failure is rethrown unchanged.
 */
export async function importOptional(url, load) {
  if (typeof load !== 'function') {
    throw new TypeError('importOptional: `load` must be a function wrapping a literal import()');
  }
  try {
    return await load();
  } catch (err) {
    if (isMissingModule(err, url)) return null;
    throw err;
  }
}
