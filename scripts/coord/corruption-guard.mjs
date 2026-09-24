// scripts/coord/corruption-guard.mjs -- plan 1634
//
// Cheap NUL-corruption signature check shared by every automated committer that might
// otherwise commit/capture a disk-zeroed file as if it were a legitimate edit (the
// 2026-07-09 incident: a disk event zero-filled 15 tracked coord docs on the main
// checkout; the Stop auto-heal hook saw them as ordinary idle dirt and pushed them to
// master). detectCorruption/isAllNul/looksBinary are pure string-in/string-out -- no git
// or fs calls -- so callers pass in whatever content they already have in hand (a
// working-copy read, a captured patch pre-image). Uses charCodeAt (never an embedded NUL
// literal in this source) so the corruption-detection code itself can't be mistaken for
// the thing it detects.
//
// Three signatures, any one is treated as corruption, never a legitimate edit:
//   'all-nul'      -- the CURRENT content is non-empty and every character is code point 0.
//   'baseline-all-nul' -- the BASELINE (pre-image, typically the HEAD blob) is all-NUL,
//                    even if the current content looks fine (an already-corrupted-and-
//                    committed pre-image a capture/apply pipeline would otherwise build on).
//   'binary-flip'  -- the CURRENT content contains a NUL byte but the BASELINE did not --
//                    a text file that flipped to binary between one known-good read and now.
// A brand-new file (no baseline available) only gets the 'all-nul' check -- there is
// nothing to flip FROM, so 'binary-flip'/'baseline-all-nul' never fire without a baseline.
//
// scanForCorruption() adds two more signatures for the CALLERS that read the working copy
// and a git HEAD blob via injected functions (pre-yield-guard.mjs, coord-edit.mjs) -- an
// 'unreadable' / 'baseline-unreadable' read failure is NOT provably clean, so it is
// reported as corruption-suspect rather than silently let through (a review-caught gap:
// the first cut of this guard treated ANY read/git failure as "clean", which would let a
// corrupted file slip past under exactly the transient-I/O/git-contention conditions a
// shared, multi-session `.git` produces).

import { RED, BOLD, OFF } from './ansi-colors.mjs';

const NUL_CODE = 0;

// True when `text` is non-empty and consists ENTIRELY of NUL (code point 0) characters.
// An empty string is not corruption -- a genuinely empty file is an unusual but
// legitimate state, not a zero-fill signature.
export function isAllNul(text) {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== NUL_CODE) return false;
  }
  return true;
}

// git's own "is this blob binary" heuristic is "contains a NUL byte" -- mirrored here on
// the decoded text (a lone NUL byte survives a UTF-8 round-trip byte-for-byte, so this is
// accurate for the corruption signatures we care about even though it's not a full binary
// sniff for arbitrary content).
export function looksBinary(text) {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === NUL_CODE) return true;
  }
  return false;
}

// Returns a short reason code ('all-nul' | 'baseline-all-nul' | 'binary-flip') or null
// when `text` (the CURRENT / post-image content of a file) shows no corruption signature
// relative to `baseline` (its last-known-good / pre-image content, typically the HEAD
// blob -- pass null/undefined when none exists, e.g. a new file). Checks the POST-image
// first (the common case: a working copy got zeroed after a good HEAD), then the
// PRE-image (a capture/apply pipeline's baseline is itself already-corrupted-and-committed
// content -- coord-edit.mjs captures a patch FROM the pre-image, so a corrupted pre-image
// must refuse just as loudly as a corrupted post-image), then the binary-flip signature.
export function detectCorruption(text, baseline) {
  if (isAllNul(text)) return 'all-nul';
  if (baseline != null && isAllNul(baseline)) return 'baseline-all-nul';
  if (baseline != null && !looksBinary(baseline) && looksBinary(text)) return 'binary-flip';
  return null;
}

// git's exact wording for "this path is not in HEAD" (verified against real git output):
//   fatal: path 'x' does not exist in 'HEAD'                (never existed)
//   fatal: path 'x' exists on disk, but not in 'HEAD'        (untracked/new file)
// Any OTHER git failure (ref contention, a sibling mid-rebase/push, git-for-windows fork()
// flakiness) does NOT match and must not be treated as "no baseline" -- see scanForCorruption.
const NOT_IN_HEAD_RX = /does not exist in|exists on disk, but not in/i;

// Scans `paths` for a corruption signature, shared by every caller that reads a working
// copy + a HEAD blob before committing/capturing a set of candidate paths (pre-yield-
// guard.mjs's commitSafe path, coord-edit.mjs's capture step) so the corruption-vs-
// transient-error classification lives in exactly one place. `readWorkingCopy(path)` and
// `readHeadBlob(path)` are injected (each caller uses its own git/fs wrapper + env) and
// are expected to throw on failure -- `readWorkingCopy` a Node fs error with `.code`,
// `readHeadBlob` a git-invocation error whose `.message`/`.stderr` carries git's stderr text.
//
// Returns { clean, corrupted } where corrupted is [{ path, reason }]:
//   - a working-copy read failure is 'clean' (nothing to check) when `e.code === 'ENOENT'`
//     (the file is genuinely gone -- a deletion, not corruption) OR `'EISDIR'` (the path is
//     a directory -- `git status --porcelain` collapses an entirely-untracked directory
//     into one `?? dir/` entry, a normal shape, not a corruption signal; expanding it into
//     individual files is the CALLER's job, same as staleArchiveDuplicatePaths already does
//     for the plans/ subtree). Any OTHER failure (EBUSY/EPERM from an antivirus/sync tool
//     mid-scan, EMFILE, ...) is NOT provably clean, so it is reported as corrupted
//     ('unreadable') rather than silently let through.
//   - a HEAD-blob read failure is "no baseline, all-NUL check alone still applies" ONLY
//     when git's own error names the path as absent from HEAD (NOT_IN_HEAD_RX). Any OTHER
//     git failure means the baseline is UNKNOWN, not absent -- reported as corrupted
//     ('baseline-unreadable') so a transient git hiccup can never silently disable the
//     baseline-all-nul / binary-flip checks.
export function scanForCorruption(paths, readWorkingCopy, readHeadBlob) {
  const clean = [];
  const corrupted = [];
  for (const p of paths) {
    let text;
    try {
      text = readWorkingCopy(p);
    } catch (e) {
      if (e?.code === 'ENOENT' || e?.code === 'EISDIR') {
        clean.push(p);
      } else {
        corrupted.push({ path: p, reason: 'unreadable' });
      }
      continue;
    }
    let baseline = null;
    let baselineUnreadable = false;
    try {
      baseline = readHeadBlob(p);
    } catch (e) {
      const msg = `${e?.stderr || ''}${e?.message || ''}`;
      if (!NOT_IN_HEAD_RX.test(msg)) baselineUnreadable = true;
      // else: genuinely not in HEAD (new file) -- baseline stays null.
    }
    if (baselineUnreadable) {
      corrupted.push({ path: p, reason: 'baseline-unreadable' });
      continue;
    }
    const reason = detectCorruption(text, baseline);
    if (reason) corrupted.push({ path: p, reason });
    else clean.push(p);
  }
  return { clean, corrupted };
}

// The RED, prominent, single-line warning naming the file and the corruption signature.
// ANSI colour degrades gracefully to readable text on a terminal that strips it.
export function corruptionWarning(relPath, reason) {
  const what = {
    'all-nul': 'is all-NUL (zero-filled)',
    'baseline-all-nul': 'has an all-NUL (zero-filled) baseline/pre-image',
    'binary-flip': 'flipped from text to binary vs its last-known-good content',
    unreadable: 'could not be read (not ENOENT) -- treating conservatively as corruption-suspect',
    'baseline-unreadable':
      "its HEAD baseline could not be read (not a 'new file' error) -- treating conservatively as corruption-suspect",
  }[reason];
  return (
    `${RED}${BOLD}corruption-guard: ${relPath} ${what} -- a disk-corruption signature, ` +
    `never a legitimate edit.${OFF}${RED} Excluding it; leave it for a human/heal ` +
    `(docs/superpowers/plans/archive/1634-*.md).${OFF}`
  );
}

// Shared NUL-byte test fixture generator -- was copy-pasted identically into
// corruption-guard.test.mjs, coord-edit.test.mjs, and pre-yield-guard.test.mjs; exported
// once here so all three import the same generator.
export function nulBytes(n) {
  return String.fromCharCode(...Array(n).fill(NUL_CODE));
}
