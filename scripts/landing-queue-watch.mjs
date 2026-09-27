#!/usr/bin/env node
// scripts/landing-queue-watch.mjs — path-compat shim: the real module moved to
// scripts/coord/landing-queue-watch.mjs (move-to-coord.mjs pattern, vetapp plan 4096 T2). Any
// hook, skill, runbook, or the spine's own by-path detached spawn (scripts/coord/land/queue.mjs's
// `dispatchLandPrep`) keeps invoking this exact path unchanged.
//
// THIS FILE ALSO CARRIES THE PROJECT WIRING the core module cannot hold itself: a module under
// scripts/coord/** may import only coord siblings and node: builtins (Rule 3,
// docs/coord/scripts-layout.md), so the dead-land desktop notifier
// (scripts/project/land-notify.mjs) is loaded HERE, through the guarded optional-import seam
// (scripts/coord/optional-import.mjs), and pushed into the core module via its injected
// `setDeadLandToast` dependency (no-op default) before `main` runs. A checkout without a project
// layer simply keeps the no-op default; a present-but-broken project module surfaces its load
// error through the same exit-5 arm as any other startup failure.
import { pathToFileURL } from 'node:url';
import { main, setDeadLandToast } from './coord/landing-queue-watch.mjs';
import { importOptional } from './coord/optional-import.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  importOptional(
    new URL('./project/land-notify.mjs', import.meta.url),
    () => import('./project/land-notify.mjs'),
  )
    .then((notify) => {
      if (notify?.deadLandToast) setDeadLandToast(notify.deadLandToast);
      return main(process.argv.slice(2));
    })
    .then(
      (c) => process.exit(c),
      (e) => {
        console.error('landing-queue-watch:', e.message);
        process.exit(5);
      },
    );
}
