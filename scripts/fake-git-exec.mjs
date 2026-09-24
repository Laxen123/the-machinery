// scripts/fake-git-exec.mjs (plan 1664 review [2]/[3]/[4]/[6]/[7])
// Shared test double for the `_exec` seam used by computeDriftIsInherited (and its
// lint-plan-index.mjs / lint-board.mjs wrappers) — was copy-pasted verbatim into three
// test files; extracted here so a future change to the git call shape (an added arg, a
// renamed flag) needs updating in exactly one place instead of three in lockstep.
//
// `script` maps the first distinctive git arg to either a string (stdout) or a function
// (called; throw to simulate a non-zero exit).
export function fakeExec(script) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push(args.join(' '));
    const key = args.includes('rev-parse')
      ? 'rev-parse'
      : args.includes('merge-base')
        ? 'merge-base'
        : args.includes('diff')
          ? 'diff'
          : args.includes('status')
            ? 'status'
            : args[0];
    const handler = script[key];
    if (handler === undefined) throw new Error(`fakeExec: unexpected git ${key}`);
    if (typeof handler === 'function') return handler(args);
    return handler;
  };
  fn.calls = calls;
  return fn;
}
