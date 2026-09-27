#!/usr/bin/env node
// scripts/hooks/prompt-wiki-dispatch.mjs — UserPromptSubmit dispatcher (plan 4238).
//
// WHY: every prompt used to start FIVE separate `node` processes, one per wiki loader, each
// reading the same stdin JSON. On a loaded Windows box those starts are what made
// "UserPromptSubmit hook timed out" notices appear. This module runs the same five loaders
// IN ONE PROCESS: stdin is read once and each loader's own `evaluateHook(payload)` runs
// in-process, in the old registration order.
//
// WHAT MUST NOT CHANGE: which pages each loader injects and when. Each loader still does its
// own matching, its own per-session marker / dedup writes, and renders its own text. When
// only one loader has something to inject, this prints that loader's envelope unchanged;
// several are merged by scripts/hooks/lib/hook-dispatch.mjs (contexts joined with a blank
// line, system messages with ' · ' — the separators the Codex prompt adapter already used
// when it ran the five loaders one by one, so Codex's merged text is unchanged too).
//
// One ordering note: separate hooks were launched in PARALLEL, so when two of the loaders below
// could inject the same page (two of them share the subjects marker root), which one won was a
// race. Here they run in order, so the earlier loader always wins; the page is still injected
// exactly once.
//
// FOUR OF THE FIVE LOADERS ARE THE PROJECT'S OWN (plan 4238's coord-kit follow-up): this file
// ships in the public coord-kit, but a project's own prompt loaders generally do not — see
// scripts/project/prompt-loaders.mjs's own header for exactly what that means here. They are
// loaded through `importOptional` (scripts/coord/optional-import.mjs — the same seam
// done-worktree.mjs uses for its own project plugin): the `import()` keeps a LITERAL specifier,
// so build-coord-kit.mjs's closure gate reads the edge as OPTIONAL and does not require the
// target to ship for THIS file to be closure-clean; in a checkout that never ships that module,
// the loaders it would have supplied are silently absent, the same fail-open posture as
// everything else in this dispatcher; in THIS checkout, where it exists, behaviour is unchanged.
// This file itself names no project vocabulary on purpose, since it is the one that does ship.
//
// LOAD FAILURES ARE ISOLATED, like a loader that throws. Before the fold each loader was its own
// process, so a broken module broke only itself. Here: a project loaders module that EXISTS but
// fails to load (importOptional rethrows that case rather than calling it absent) costs a
// one-line stderr note and the project's loaders for that prompt, and subject-wiki-loader still
// runs. subject-wiki-loader, the one loader that ships everywhere, is imported through its
// registry entry's `load` thunk, so a failure there is isolated the same way by the shared
// runner (scripts/hooks/lib/hook-dispatch.mjs). Its specifier stays a LITERAL outside any
// importOptional(…) call, so the module graph still reads it as a REQUIRED edge.
//
// Fails OPEN: an empty/malformed payload, or any loader error, never breaks the turn.

import { fileURLToPath } from 'node:url';
import { runHookCli } from './lib/loader-common.mjs';
import { runGuards } from './lib/hook-dispatch.mjs';
import { importOptional } from '../coord/optional-import.mjs';

// The one loader every checkout, including the public coord-kit, ships.
export const SUBJECT_WIKI_LOADER = {
  name: 'subject-wiki-loader',
  load: () => import('./subject-wiki-loader.mjs'),
};

const defaultStderr = (t) => process.stderr.write(t);

// The project's own loaders where this checkout ships them, [] where it does not, and [] plus a
// stderr note where the module exists but fails to load. The `() => import(…)` must stay
// written INLINE in the importOptional(…) call: that is what makes module-graph.mjs read the
// edge as OPTIONAL (a loader passed in from outside the call would make it required, and the
// coord-kit closure gate would then block this file).
export async function loadProjectLoaders({ stderr = defaultStderr } = {}) {
  try {
    const mod = await importOptional(
      new URL('../project/prompt-loaders.mjs', import.meta.url),
      () => import('../project/prompt-loaders.mjs'),
    );
    return mod?.PROJECT_PROMPT_LOADERS ?? [];
  } catch (err) {
    stderr(`project prompt loaders: failed open (${err?.message ?? err})\n`);
    return [];
  }
}

// The registry: the project's own loaders (if this checkout ships them and they load), in their
// own order, then subject-wiki-loader. UserPromptSubmit carries no matcher, so every loader in
// the registry sees every prompt.
export async function loadPromptLoaders(opts = {}) {
  return [...(await loadProjectLoaders(opts)), SUBJECT_WIKI_LOADER];
}

export async function evaluateHook(payload, opts = {}) {
  const loaders = await loadPromptLoaders({ stderr: opts.stderr });
  return runGuards(payload, loaders, { hookEventName: 'UserPromptSubmit', ...opts });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runHookCli(evaluateHook);
  } catch {
    // fail open — a prompt hook must never break the turn
  }
  process.exit(0);
}
