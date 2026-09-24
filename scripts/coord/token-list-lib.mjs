// scripts/coord/token-list-lib.mjs — generic parse/validate for a comma+whitespace separated
// scalar token list (a frontmatter value, or a CLI flag) against an INJECTED valid-key
// set. Extracted from scripts/coord/cloud-repos-lib.mjs's `parseCloudRepos` (plan 3962 P1):
// that module's real job is the project-specific EXTRA-REPO registry (hardcodes this
// project's own repo/owner values), but its token-splitting/dedup/validate mechanics are generic
// and queue-drain.mjs — destined for the generic scripts/coord/** core — needed them
// without importing a project module (Rule 3, scripts/assert-scripts-self-contained.mjs:
// a core-destined module must not import a project one).
//
// Pure, zero-import leaf: no fs, no node built-ins, no project knowledge. The valid-key
// set, any strictness choice, and any custom error text all belong to the CALLER —
// mirrors the shape scripts/coord/main-checkout-allowlist.mjs uses for `jobOutputPrefixes`
// (a pure function taking the project's rows as a parameter, never resolving them
// itself).

// Comma- and/or whitespace-separated, case-insensitive, dedup NOT applied here (that is
// validateTokenList's job once the valid set is known) — a raw split only.
// Absent/blank → `[]`.
export function parseTokenList(raw) {
  if (raw === undefined || raw === null) return [];
  return String(raw)
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

// Filters `tokens` down to `validKeys`, order-preserving and deduped.
//
// `strict` THROWS on the first unknown token — a stamp-time typo must be a loud refusal.
// `strict: false` (the default) DROPS it instead — one bad token in one plan body must
// never take a whole corpus scan down. `formatUnknownError(token, validKeys)` lets the
// caller supply project-specific error text (e.g. "register the repo in
// scripts/coord/cloud-repos-lib.mjs…"); omitted, a generic message is used.
export function validateTokenList(tokens, validKeys, { strict = false, formatUnknownError } = {}) {
  const out = [];
  for (const t of tokens) {
    if (!validKeys.includes(t)) {
      if (strict) {
        const message = formatUnknownError
          ? formatUnknownError(t, validKeys)
          : `unknown key \`${t}\` — known keys: ${validKeys.join(', ')}`;
        throw Object.assign(new Error(message), { fatal: true });
      }
      continue;
    }
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// Convenience: parse then validate in one call — the common case for both consumers.
export function parseAndValidateTokenList(raw, validKeys, opts) {
  return validateTokenList(parseTokenList(raw), validKeys, opts);
}
