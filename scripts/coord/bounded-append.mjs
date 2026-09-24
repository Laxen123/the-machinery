// scripts/coord/bounded-append.mjs — plan 4096 T1: the bounded capture buffer every queued
// heavy-command runner shares, moved here from nightly-windows-suite.mjs (which re-exports it).
//
// The land spine's `runViaTestQueue` (scripts/coord/land/gates-runner.mjs) caps the output it
// captures from a queued child with this; it used to reach it as `D.nightlyWindowsSuite.
// boundedAppend` off the dependency container, because a core module may not import that
// vetapp-only module. A pure string helper is core by nature, so it now lives here and the core
// imports it directly — which is also what lets the `scriptsBattery` container group (named
// `nightlyWindowsSuite` until review b1f480) get an honest no-op default when no project layer
// is loaded (deps.mjs).
//
// Imports nothing.

// 4 MiB of captured text per stream: enough for any real failure tail, while still bounding a
// pathological run's memory footprint to a fixed ceiling instead of "however much the process
// printed before it was killed".
export const MAX_CAPTURED_OUTPUT_CHARS = 4 * 1024 * 1024;

/** Pure: append `chunk` to `current`, keeping only the TAIL once the result exceeds the cap —
 *  bounded, not unbounded, string growth. */
export function boundedAppend(current, chunk, max = MAX_CAPTURED_OUTPUT_CHARS) {
  const next = current + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}
