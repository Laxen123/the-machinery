// scripts/test-helpers/with-env-var.mjs — shared save/set/restore dance for env vars around a
// callback (plan 2309, extracted from install-lock.test.mjs). `vars` maps name → the value to SET
// for the duration of `fn`; a value of `undefined` means "delete it for the duration".
//
// Review finding [3] (round 3, install-lock.test.mjs): this restore used to fire the instant `fn()`
// RETURNED, not when it SETTLED — for a synchronous `fn` (every current caller) those are the same
// moment, but for a future `async` callback "returned" means "the Promise was CREATED", long before
// the callback's own body (past its first `await`) has actually run — the env would already be back
// to production values while the async body was still executing, silently, with no error at the
// point of the mistake. withEnvVar is sync-only by design; enforce that LOUDLY instead of silently
// mishandling a future async caller: a returned thenable is a caller bug to surface immediately, not
// support.
export function withEnvVar(vars, fn) {
  const prev = {};
  for (const [name, value] of Object.entries(vars)) {
    prev[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      throw new Error(
        'withEnvVar is sync-only — its callback returned a Promise/thenable; make the callback ' +
          'genuinely synchronous, or extend withEnvVar to be async-aware if an async caller is ' +
          'truly needed',
      );
    }
    return result;
  } finally {
    for (const [name, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
