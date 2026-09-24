// scripts/coord/html-escape.mjs — the ONE HTML-escape helper (plan 4096 T6).
//
// Four lines, moved out of scripts/lib/decision-dossier/inline.mjs so that a caller needing ONLY
// this can stop importing the dossier renderer. `batches-view.mjs` is a coord-kit command and its
// single offending closure edge was exactly that: it wanted `escapeHtml` and got the whole
// inliner, which reads sibling CSS/JS ASSETS off disk and belongs to the dossier feature, not to
// the generic core. inline.mjs re-exports from here, so the dossier side is unchanged and there is
// still exactly one implementation.
//
// Deliberately NOT a general-purpose sanitiser: it escapes the four characters that matter when
// interpolating text into element content or a double-quoted attribute value. A single-quoted
// attribute or an unquoted one needs more, and neither this repo's dossier nor batches-view emits
// those — so widening it would be adding a rule for a caller that does not exist.

export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}
