#!/usr/bin/env node
// scripts/coord/atomic-write.mjs — the shared fsync+tmp-then-rename write behind
// `landing-lock.mjs` (writeRegistry), `test-queue.mjs` (writeTicket) — plan 1761 —
// and `git-metadata-heal.mjs` (config rebuild; text form, plan 1778).
//
// WHY: both files independently hand-rolled the same plan-1733 atomic-replace shape
// (open temp → write → fsync → close → rename over the target, temp cleanup on
// failure), and the copies had ALREADY drifted: test-queue's copy lacked the fsync
// ENOTSUP/EINVAL tolerance, the success-path close-error check, the full-buffer
// fd-form writeFileSync, and the squatter-directory-capable rmSync cleanup that
// landing-lock's plan-1733 review hardening added. A hardening applied to one copy
// silently missing the other is the exact class `excl-lock.mjs` (plan 1678) was
// extracted to close for the acquire/reap path — this module closes it for the
// write path. Flagged twice by /sonnet-review on plan 1750; extraction was
// deliberately deferred out of that plan (landing-lock is tandapp-adopted and
// mid-plan refactor risk was disproportionate) onto plan 1761.
//
// SCOPE — deliberately narrow (the excl-lock precedent): this is ONLY the
// crash-safe single-file replace. It knows nothing about:
//   - orphan-temp SWEEPING (landing-lock's reapOrphanRegistryTemps owns that,
//     age-gated under its registry mutex; test-queue's temps are inert to its
//     ticket regex and self-heal on the next beat) — but the tmp NAMING is a
//     cross-file contract with that sweep, so TMP_SEP is exported below, never
//     re-spelled by a caller.
//   - delete/empty semantics (landing-lock unlinks the registry on release-to-
//     zero; test-queue unlinks tickets on release/prune) — deletion is not a
//     write and stays with each caller.
//   - retry / fail-open-vs-fail-closed policy. A failed write CLEANS UP its own
//     temp (best-effort) and RETHROWS; landing-lock propagates fail-closed
//     (exit 5 / --wait retry, plan 1703), test-queue retries per-poll and
//     fails OPEN (its landing-queue lesson). Neither policy belongs here.
//
// CROSS-REPO: a NEW coordShare member adopted by tandapp in the same beat
// (coord.config.json `adopt` list, same commit — the dependency-ordering rule in
// docs/runbooks/coord-sharing.md), because BOTH importers (landing-lock.mjs,
// test-queue.mjs) are byte-identical-synced to tandapp already.

import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';

// The tmp-name infix: a write to `<path>` stages at `<path>.tmp.<pid>`. Exported
// because landing-lock's orphan sweep scans its lock directory for
// `${basename(lockPath)}${TMP_SEP}` — if the naming here ever changed without the
// sweep following, orphaned temps would accumulate invisibly. One spelling, here.
export const TMP_SEP = '.tmp.';

// The one temp-path remover — rm (recursive+force), not unlink, so a squatter
// DIRECTORY at a temp path (landing-lock review 1733 [1]: it would survive unlink
// forever AND wedge every later openSync from the same pid) is reapable too.
// Shared by the error path below and landing-lock's orphan sweep so the two can't
// drift. Throws on failure; every caller catches-and-skips (a failed reap never
// blocks anything — the temp is inert and gets retried later).
export const rmTempPath = (p) => rmSync(p, { recursive: true, force: true });

// Atomically replace `path` with `data` (a pre-serialized string). The target is
// always either the old complete content or the new complete content — never
// truncated (a plain writeFileSync opens O_TRUNC, so a mid-write fs error — the
// AV/sync-scan EBUSY/EACCES/EPERM class, or EIO/disk-full — would leave a
// previously-valid file TORN; plan 1733). renameSync replaces an existing target
// on every platform Node supports (MoveFileEx + MOVEFILE_REPLACE_EXISTING on
// Windows — atomic on one volume), which is exactly the refresh path the callers
// rely on.
//
// The atomicity is against MID-WRITE failure only: concurrent same-target writers
// are the CALLER's problem (landing-lock excludes them with its registry mutex;
// test-queue's tickets are per-process files no rival ever writes;
// git-metadata-heal's config rebuild runs when every git process on the clone is
// already dead). Any error still propagates to the caller after best-effort temp
// cleanup — no retry layer here.
//
// This text form IS the shared core (plan 1778, extracted from git-metadata-heal's
// plan-1771 local mirror before it could drift): atomicWriteJsonSync below is a
// thin JSON.stringify wrapper so every hardening lands in exactly one place.
export function atomicWriteTextSync(path, data) {
  const tmpPath = `${path}${TMP_SEP}${process.pid}`;
  try {
    const fd = openSync(tmpPath, 'w');
    let bodyOk = false;
    try {
      // fd-form writeFileSync: Node itself loops the underlying write() until the
      // whole buffer is flushed (a silently short temp would survive fsync+rename
      // as a corrupt target).
      writeFileSync(fd, data);
      try {
        fsyncSync(fd); // tiny file, cheap — keeps an OS crash from landing the rename before the data
      } catch (e) {
        // fsync is belt-and-suspenders (the atomicity comes from the rename); a
        // filesystem that simply doesn't support it must not fail every write that
        // used to succeed un-fsynced. Real I/O failures still propagate.
        if (e.code !== 'ENOTSUP' && e.code !== 'EINVAL') throw e;
      }
      bodyOk = true;
    } finally {
      try {
        closeSync(fd);
      } catch (closeErr) {
        // On the SUCCESS path a close error is the only remaining signal the data
        // may not have landed (delayed write-back on some mounts) — it must fail
        // the write, never be renamed over the good target. With a write/fsync
        // error already propagating, stay silent so the close error can't MASK
        // the original one.
        if (bodyOk) throw closeErr;
      }
    }
    renameSync(tmpPath, path);
  } catch (e) {
    try {
      rmTempPath(tmpPath);
    } catch {
      /* still held (AV scan) — inert; the caller's own sweep/next write retries */
    }
    throw e;
  }
}

// The original entry point (plan 1761) — JSON callers (landing-lock writeRegistry,
// test-queue writeTicket) serialize here and share the text core's guarantees.
export function atomicWriteJsonSync(path, value) {
  atomicWriteTextSync(path, JSON.stringify(value));
}
