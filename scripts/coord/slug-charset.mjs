// scripts/coord/slug-charset.mjs (plan 3450) — the repository-wide slug/category charset,
// extracted to a LEAF module (no fs/child_process/git imports) so a consumer that only
// needs the grammar (landing-queue-lib.mjs) does not have to pull in claim-plan-lib.mjs's
// coord-config -> coord-git -> board-write-gate import chain just to validate a slug.
//
// F-004/F-015 (plan 1313, 2026-07-02 coord audit): the ONE slug/category charset every entry
// point that can EVER write a raw slug into a filename, a branch name, or a PowerShell `-like`
// pattern validates against. LLM-authored free text (a slug drafted from a record name, a plan
// description) can carry a space, an apostrophe, or a non-ASCII character (Swedish öäå) that
// reaches:
//   - a filename computeNextId's ASCII-only id-scanner then can't see (F-015 — a non-ASCII slug
//     mints a file invisible to the scanner but visible to idTakenByOther's tolerant dup-guard,
//     so EVERY future mint retry re-collides and allocatePlanId exhausts its budget — repro
//     `scan:001, taken:true` — until a manual rename);
//   - a single-quoted PowerShell `-like` pattern interpolated with NO escaping in the
//     worktree-teardown kill command (F-004 — an apostrophe breaks out of the quoted context
//     into a `Stop-Process -Force` execution context, and a bare PS wildcard silently widens
//     the match).
// Validated ONCE, here, at every entry point that accepts a raw slug/category from the caller
// (next-plan-id's `claim`, claim-plan's `acquire`/`batch`, cut-worktree's standalone CLI) —
// never downstream after it is already baked into a filename/branch/pwsh command.
export const SLUG_CHARSET_RX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSlugCharset(value, label) {
  if (!SLUG_CHARSET_RX.test(String(value ?? ''))) {
    throw new Error(
      `--${label} "${value}" must match ${SLUG_CHARSET_RX} — ASCII letters/digits/._- only, ` +
        `starting with a letter or digit. A space, apostrophe, or non-ASCII character (e.g. ` +
        `Swedish öäå) here can wedge every future plan-id mint (plan-1313 F-015) or break out of ` +
        `the worktree-teardown PowerShell command (plan-1313 F-004). Pick an ASCII-only ${label}.`,
    );
  }
}
