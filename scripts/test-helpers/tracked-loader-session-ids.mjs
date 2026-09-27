// scripts/test-helpers/tracked-loader-session-ids.mjs — loader session ids that cannot
// collide and cannot leak a marker dir (plan 3211).
//
// WHAT A LOADER TEST DOES, AND WHY IT LEAKS. A wiki-loader test picks a session id, drives
// the loader with it, and the loader writes one marker FILE per injected page under
// `<cache root>/<session id>/` so the same page is not injected twice in one session. Eight
// test files built that id from `process.pid` alone (`t${pid}`, `pw-${pid}`, `pp-${pid}`,
// `sw-${pid}`, `cr-${pid}`, `stop-t${pid}`, `codex-<thing>-${pid}`, `relay-t${pid}`) and
// swept it by hand — each `after` naming ONE cache root, or naming the ids one by one, or
// (build-codex-hooks, a per-record loader test) sweeping inline at the end of a test / not at
// all. Both halves were wrong in the same way:
//
//   1. A pid is not unique over time. Windows recycles pids in a small space, so a later
//      run that draws a leaked run's pid starts with pages ALREADY marked injected for its
//      own session: `selectFresh` skips them and an "it injects" assertion fails on a
//      machine where nothing is wrong. It passes on the next run, so it reads as flake.
//   2. `collectAll` drives EVERY loader, not only the one under test, so a test can create
//      markers in roots its own sweep never named. A hand-written root list is also one
//      more place to forget a root when the next loader is added.
//
// Measured on the operator's TEMP on 2026-08-15: 1,037 orphaned `relay-t<pid>-stop` dirs,
// 582 of them holding an `anicura` marker. That is the incident this helper generalizes —
// `wiki-loader-relay-guard.test.mjs` was fixed single-file in the plan-3197 land and now
// consumes this helper like the rest. The real total was larger: the plan-3211 sweep on
// 2026-08-16 removed 4,719 test-shaped dirs across the four wiki roots, 3,695 of them
// `stop-t<pid>-*` from `wiki-loaders-stop.test.mjs` — a file that had NO sweep at all and so
// was never counted, while its hook drives every loader through `collectAll`.
//
// THE SHAPE THAT MATTERS: MINT, DON'T SPELL. The run base is a closure variable and is not
// exported, so the ONLY way to obtain an id is to call the minter — and everything the
// minter hands out is on the list its own `after` sweeps. A caller cannot build
// `${RUN}-newcase` by hand and forget to add it to the sweep list, because there is no RUN
// in scope to build it from. That is the same "make the leak unrepresentable" move
// `tracked-tmpdir.mjs` makes by shadowing the `mkdtempSync` name, and it is the exact
// failure the `-stop` id hit: it was created in one place and swept from a list written in
// another.
//
// The uuid is FULL length, never truncated. An earlier cut of the 3197 fix used
// `randomUUID().slice(0, 8)`, which keeps 32 bits and so is merely unlikely to collide with
// the orphans still on disk while claiming to be impossible (that review's round-1 finding).
// The id is never read by a human, so shortening it buys nothing.
//
// The sweep is `clearAllRegisteredMarkers` — loader-common's own union-clearing entry point,
// covering every registered root PLUS the opt-in ones — never a hand-rolled walk over
// CACHE_ROOTS. A root added to loader-common later is therefore covered without editing any
// test file. It also takes the per-context `<session>-agent-<agentId>` sibling dirs, so a
// test that fires a loader with an `agent_id` needs no extra bookkeeping.
//
// Importing a hook lib from here is allowed: `assert-scripts-self-contained.mjs` scans every
// `scripts/**/*.mjs` EXCEPT `*.test.mjs` and everything under `scripts/test-helpers/`
// (docs/runbooks/scripts-module-layout.md).
import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { clearAllRegisteredMarkers } from '../hooks/lib/loader-common.mjs';

// `_randomUUID` / `_clear` / `_after` / `_pid` are injectable purely so this helper is
// itself unit-testable (see tracked-loader-session-ids.test.mjs) without registering a real
// hook or touching a real cache root. Production callers pass `prefix` and nothing else.
export function trackedLoaderSessionIds(
  prefix,
  {
    _randomUUID = randomUUID,
    _clear = clearAllRegisteredMarkers,
    _after = after,
    _pid = process.pid,
  } = {},
) {
  // A prefix outside the marker-safe alphabet would be rewritten by `safeMarkerKey` on the
  // way to disk, so the id a test holds and the dir it produces would differ — fail loud
  // here rather than leave that mismatch for whoever debugs the next stale marker.
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9_-]+$/.test(prefix)) {
    throw new TypeError(
      `trackedLoaderSessionIds: prefix must be a non-empty [A-Za-z0-9_-] string, got ${JSON.stringify(prefix)}`,
    );
  }

  const run = `${prefix}-${_pid}-${_randomUUID()}`;
  const minted = [];

  const sid = (suffix) => {
    const id = suffix === undefined ? run : `${run}-${suffix}`;
    // De-duped so a suffix reused across two tests (a deliberate "same session" case) is
    // swept once rather than twice; the sweep is idempotent either way.
    if (!minted.includes(id)) minted.push(id);
    return id;
  };

  // Exposed for this helper's own tests; production callers only ever call `sid(suffix)`.
  sid.minted = minted;
  sid.sweep = () => {
    // Splice as we go so a second sweep (defensive — a suite could call it explicitly) is a
    // no-op rather than re-clearing ids already handled.
    while (minted.length > 0) {
      const id = minted.pop();
      try {
        _clear(id);
      } catch {
        /* best-effort: a locked or already-gone marker dir must never fail the suite */
      }
    }
  };

  _after(() => sid.sweep());
  return sid;
}
