// scripts/coord/findings-sidecar-io.mjs  (plan 2936, lifted from record-review.mjs's plan-2891 T1/T4)
//
// The ONE findings-sidecar READ policy, fs-touching (readFileSync), so it cannot live in
// done-worktree-lib.mjs — that module's own header contract is "No fs, no child_process, no
// git — every function here is a total function of its inputs", and a sidecar read is exactly
// none of those things. This module exists ONLY to give that read policy a home outside a
// fs-free module without duplicating it: record-review.mjs (the writer/repin path) and
// gpt-review.mjs (plan 2936 T1's prior-dispositions reader) both consume the SAME function, so
// there is exactly one place in the tree that decides how an unreadable/unparseable sidecar is
// handled. It may import the PURE parts it needs (parseFindingsRecord, findingsSidecarPath)
// from done-worktree-lib.mjs — those stay fs-free; only the read itself lives here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// plan 3959 T2: parseFindingsRecord moved to scripts/coord/review-markers.mjs.
import { parseFindingsRecord } from './review-markers.mjs';

// ── plan 2891 T1 + T4: the ONE findings-sidecar read policy ────────────────────────────────
//
// Every sidecar read in this file used to be its own `readFileSync` in a bare `catch {}`, and a
// bare catch cannot tell "there is no sidecar" from "there is a sidecar and I could not read
// it". Any I/O error on a sidecar that EXISTS — EACCES (a permission flip), EISDIR (something
// created a directory at that path), EIO — therefore read as ABSENT, which is the most
// destructive possible misreading of that state: a re-pin advances marker-only and STRANDS the
// findings; a re-record starts every finding open and (since plan 2864) resets the round
// counter; a disposition reports "no findings recorded — record them first".
//
// The rule (decision SETTLED at spec-pass 2026-08-05): `err.code === 'ENOENT'` is the ONLY
// errno that means genuinely absent. Every other errno REFUSES, naming the file AND the errno.
// This is the same trade plan 2844 Task 3 already accepted one layer up for the
// exists-but-unparseable case — a refusal can block a record on a transient error, and that is
// better than silently writing over state we could not read — so the errno split is that same
// decision applied consistently rather than a new one.
//
// T4 folds the read, the parse and the refusal WORDING into this one helper so the four (now
// five, now six with gpt-review.mjs's plan-2936 T1 reader) call sites cannot drift: they differ
// only in HOW a refusal is delivered — a gate-time probe returns it, a write-time re-assert
// throws it, a CLI entry prints it and exits, a review-prompt injector logs and skips — which
// is the caller's business, not the read's. Returns exactly one of:
//   { absent: true }  no sidecar (ENOENT) — the marker-only path is legitimate
//   { rec }           a parsed findings record
//   { refuse: msg }   unreadable (non-ENOENT) or exists-but-unparseable
export function readSidecarOrRefuse(dir, sidecarRel) {
  let raw;
  try {
    raw = readFileSync(join(dir, sidecarRel), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { absent: true };
    return {
      // The errno is named ONCE: node's own message already leads with it ("EISDIR: illegal
      // operation on a directory, read"), so prefixing err.code as well printed it twice.
      refuse:
        `REFUSED — ${sidecarRel} EXISTS but could not be read (${err?.message || err?.code || err}). ` +
        `Treating an unreadable sidecar as an absent one would strand whatever findings and ` +
        `dispositions it still holds — a re-pin would advance marker-only, and a re-record would ` +
        `start every finding open. Nothing was written. Fix the file's readability (permissions, ` +
        `or something occupying that path) and re-run.`,
    };
  }
  return parseSidecarOrRefuse(raw, sidecarRel);
}

// The PARSE half of the policy above, split out (plan 2936 review round 1) for the one caller
// that cannot use `readSidecarOrRefuse`'s fs read: gpt-review.mjs resolves the sidecar
// ORIGIN-FIRST (`git show origin/master:<path>`), because record-review.mjs's default write path
// lands the sidecar on origin/master through a disposable coord-checkout that never touches the
// calling worktree's files — so on a worktree branch the sidecar for the CURRENT plan is
// routinely absent from disk while sitting on origin. That caller already holds the CONTENT and
// only needs the parse + refusal wording, which stays spelled exactly once, here.
//
// "Absent" is deliberately NOT a case this function can return: absence is a property of the
// LOOKUP (no such file / not on that ref), which each caller establishes before it has content
// to hand. Returns { rec } or { refuse: msg }.
export function parseSidecarOrRefuse(raw, sidecarRel) {
  const rec = parseFindingsRecord(raw);
  if (!rec) {
    return {
      refuse:
        `REFUSED — ${sidecarRel} exists but is not a parseable findings record. Replacing it ` +
        `would discard whatever findings and dispositions it still holds. Nothing was written. ` +
        `Inspect it, and delete it deliberately if it is genuinely lost.`,
    };
  }
  return { rec };
}
