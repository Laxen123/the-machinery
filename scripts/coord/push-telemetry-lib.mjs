#!/usr/bin/env node
// scripts/coord/push-telemetry-lib.mjs (plan 1731)
//
// Zero-dependency marker helper for pre-push drift-attribution telemetry. The two
// drift-attribution gates (lint-plan-index.mjs, lint-board.mjs) call
// markPushTelemetryHit() at the exact point where each would consult
// computeDriftIsInherited (drift-attribution-lib.mjs) — regardless of whether that
// drift then resolves inherited or strict. scripts/hooks/pre-push.sh's EXIT trap later reads
// the marker file to compose ONE telemetry log line per gate-running push.
//
// Complete no-op unless COORD_PUSH_TELEMETRY_HITS_FILE is set: scripts/hooks/pre-push.sh
// exports it ONLY for a push that reaches the gates (never for the coord-ref-only /
// branch-delete pass-throughs), and no test in this repo sets it ambiently — so
// importing/calling this from either gate changes NOTHING about their existing
// behavior. Mirrors the COORD_DRIFT_BRANCH/COORD_DRIFT_BASE env-handshake convention
// (plan 1669): unset means "no shell precompute for this push", not an error.
//
// Every failure (unset var, missing directory, a readonly/unwritable path, a race
// with another process) is swallowed here — telemetry must NEVER fail, slow, or
// alter a push's pass/fail outcome.
import { appendFileSync } from 'node:fs';

export function markPushTelemetryHit(marker, env = process.env) {
  try {
    // The env read lives INSIDE the try (plan-1731 review finding 4): a null/undefined
    // env (an explicit `markPushTelemetryHit('x', null)`) must be swallowed exactly like
    // any other telemetry failure, not throw before the try even starts.
    const file = env && env.COORD_PUSH_TELEMETRY_HITS_FILE;
    if (!file) return;
    appendFileSync(file, `${marker}\n`);
  } catch {
    // swallow — telemetry must never fail a push
  }
}
