// scripts/coord/ansi-colors.mjs — the one shared set of ANSI escape constants for a prominent
// terminal warning (RED/YELLOW/BOLD, reset). Degrades gracefully to readable text on a
// terminal that strips ANSI. Used by post-checkout-claim-guard.mjs, corruption-guard.mjs and
// pre-rebase-main-guard.mjs so a future color-scheme change (or NO_COLOR support) has
// exactly one place to edit.
//
// RED vs YELLOW carries meaning, so pick by SEVERITY, not by taste: RED is a rule that was
// already broken and needs repair (post-checkout's unclaimed worktree), YELLOW is an
// advisory fired BEFORE the fact, where the flagged action is often legitimate
// (pre-rebase's raw rebase on MAIN). Painting an advisory red is how a warning channel
// gets tuned out.
export const RED = '\x1b[31m';
export const YELLOW = '\x1b[33m';
export const BOLD = '\x1b[1m';
export const OFF = '\x1b[0m';
