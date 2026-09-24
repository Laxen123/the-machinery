// scripts/test-helpers/inject-transient-git.mjs — the ONE fault-injection shim that simulates the
// plan-980 half-land race for the coord-land protocol suites (plan 2580 review finding 5).
//
// WHY THIS IS A SHARED HELPER. coord-git.test.mjs and coord-edit.test.mjs both need to reproduce
// the same race: git DID the work (the commit object exists, HEAD moved), and only then the index
// write failed — after which gitWithLockRetry's retry finds nothing staged and reports a genuine
// "nothing to commit". That is the exact condition `coordLandCommit`'s half-land tolerance exists
// to absorb, and since plan 2580 BOTH callers run that one implementation. Two independently
// maintained copies of the shim proving it would be the same failure mode plan 2580 removed from
// the protocol itself (and the plan-1678 class generally): a change to the injected error text or
// the op-matching would be applied to one suite and silently forgotten in the other, leaving the
// two suites quietly asserting tolerance of DIFFERENT races.
//
// `rawGit` is passed in rather than imported so each suite keeps using its own real-git binding
// (coord-git.test.mjs and coord-edit.test.mjs bind it differently).

// Wrap `rawGit` so the FIRST call whose argv[0] is `op` runs for real and THEN throws the
// transient index-write failure. Subsequent calls pass straight through.
export function injectTransientOnFirst(rawGit, op) {
  let fired = false;
  return (d, a, o) => {
    const out = rawGit(d, a, o);
    if (a[0] === op && !fired) {
      fired = true;
      throw new Error('fatal: repository has been updated, but unable to write new index file.');
    }
    return out;
  };
}
