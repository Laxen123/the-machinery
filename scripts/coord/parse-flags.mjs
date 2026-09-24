// scripts/coord/parse-flags.mjs — the ONE shared value-aware flag parser (plan 1769), extracted
// from coord-git.mjs by plan 1777 so ADOPTED coord files can import it. coord-git.mjs
// re-exports it, so every pre-1777 vetapp importer is unchanged; the extraction exists
// because siblings adopt some parseFlags CONSUMERS (landing-lock.mjs, stamp-exec-model.mjs
// — see coord.config.json) while their coord-git.mjs is a deliberately slim local shim that
// is NOT byte-synced. Import rule: an ADOPTED file imports parseFlags from HERE (this file
// is itself adopted, so the import resolves in every sibling); vetapp-only files may keep
// importing via coord-git.mjs. Hand-copying the function into a sibling's coord-git instead
// would recreate exactly the parser-copy drift plans 1769/1777 exist to kill.
//
// It lives alongside (NOT replacing) coord-git's subcommand parseArgs. parseArgs is
// deliberately value-only — every `--x` greedily consumes the next token, no booleans, no
// short flags — which is right for the subcommand CLIs (board/index/move-plan) but forced
// wiki-commit/coord-edit/edit-plan/fb-log to each hand-roll a near-identical spec'd loop.
// Those copies drifted (plan 1678 findings [2]/[3]); this is their single replacement.
// Semantics, each pinned by a caller's tests:
//   - `value` flags consume the NEXT token unconditionally, so `--replace --dry` yields
//     replace='--dry' (edit-plan F1: pre-stripping booleans would eat a flag-shaped VALUE);
//     a value flag as the last token gets `undefined` (callers treat it as missing).
//   - `boolean` flags set `true`; never consume a token.
//   - `multi` flags collect EVERY following token up to the next `--`-prefixed one into an
//     array, appending across repeats (coord-edit --paths; a single-dash token IS collected).
//   - `optional` flags (plan 1968) take a value ONLY via the `=`-joined form: bare `--adopt`
//     sets `true`, `--adopt=<v>` sets the string — NEVER the next token (the exact slug
//     ambiguity cut-worktree's `--adopt[=<branch>]` exists to dodge). Callers discriminate
//     with `typeof flags.x === 'string'`.
//   - `--name=value` (plan 1968) splits on the FIRST `=` before classification: a `value`
//     flag takes the joined value and does NOT consume the next token; a `multi` flag seeds
//     its list with the joined value then keeps collecting; a `boolean` flag with a joined
//     value throws (`--force=x` is always a mistake). `--flag=` yields `''` (caller-visible,
//     distinct from missing). No `=` handling on short flags (`-m=x` is unknown) or on the
//     subcommand-mode leading-boolean peel (a `=`-joined leading token ends the peel and
//     surfaces verbatim as cmd, same as any other non-peelable token).
//   - `requireValues: true` (plan 2734) makes a `value` flag THROW when its value is missing in
//     effect: off the END of argv, or explicitly empty/whitespace-only (`--x=`, `--x "  "`).
//     Off by default because storing `undefined` under the key is a pinned contract
//     (coord-git.test.mjs) and the only way to tell "absent" from "present but valueless" —
//     `'x' in flags`; and because `--x=` is a legitimate caller-visible empty string elsewhere.
//     Opt in when the caller does NOT make those distinctions, which is almost all of them:
//     there, `flags.x ?? DEFAULT` takes the DEFAULT for both shapes, and the malformed request
//     silently succeeds against the wrong thing (a wrong lock tier, the real machine lock
//     instead of a fixture, auto-detection instead of the branch the caller named).
//   - Short flags exist only via `alias` (e.g. {m:'message'}); any other `-x` is unknown.
//     `-` alone is a positional. `--m` is NOT `-m` — aliases don't apply to long names.
//   - An unknown flag throws LOUDLY (`<label>: unknown flag --x`) — a typo'd flag must never
//     be silently swallowed as data; the message carries the ORIGINAL token (`--typo=x`, not
//     `--typo`) so the caller sees what was actually typed. `messages.unknownFlag` overrides
//     the text (fb-log pins `unexpected argument "…"`); `positionals: false` rejects bare
//     tokens with `messages.positional ?? 'unexpected argument "…"'`.
// Flag keys land in `flags` under their long name VERBATIM (kebab: 'no-push', 'base-sha'),
// only when present — callers apply their own defaults/camelCase at their boundary so their
// exported shapes stay byte-compatible. record-review.mjs is deliberately NOT migrated: its
// has()/val()/flagVal() idiom has different intentional semantics on two axes (unknown flags
// are tolerated anywhere in argv, and flagVal REFUSES a flag-shaped value — `--wontfix
// --no-push` must read as a MISSING reason, not consume it) — see its own comment.
//
// `subcommand: true` (review 1777 [3] — the ONE shared subcommand mode, so callers stop
// hand-rolling `const [cmd] = argv` peels that drift): returns `{ cmd, positionals, flags }`.
// LEADING spec'd boolean flags peel off first (so `--force derail <id>` / `--ready claim …`
// resolve the real subcommand — the pre-1777 pre-strip's order-independence), then the NEXT
// token is taken as `cmd` VERBATIM even when it is flag-shaped. That verbatim take is
// deliberate: `--host acquire <id>` must surface as the caller's `unknown command "--host"`
// (naming the true offending token), NOT let a value flag swallow the subcommand and fall
// through to a silent default — the next-plan-id silent-peek regression (review 1777 [1]).
// The rest of argv parses normally. `cmd` is undefined only when argv holds nothing but
// leading booleans.
export function parseFlags(argv, spec = {}) {
  const {
    label = 'args',
    value = [],
    boolean = [],
    multi = [],
    optional = [],
    alias = {},
    positionals: allowPositionals = true,
    messages = {},
    subcommand = false,
    requireValues = false,
  } = spec;
  const valueSet = new Set(value);
  const boolSet = new Set(boolean);
  const multiSet = new Set(multi);
  const optionalSet = new Set(optional);
  // plan 1968 review [1]: a flag declared under two kinds is an authoring bug — the
  // dispatch order below (multi → value → optional → boolean) would silently pick one
  // semantics (e.g. a leftover value:['adopt'] beside optional:['adopt'] re-introduces
  // the slug-swallowing ambiguity the optional kind exists to kill). Throw at parse
  // time so the ambiguity surfaces the first time the spec is exercised.
  {
    const seen = new Map();
    for (const [kind, names] of [
      ['value', value],
      ['boolean', boolean],
      ['multi', multi],
      ['optional', optional],
    ]) {
      for (const n of names) {
        if (seen.has(n))
          throw new Error(
            `${label}: flag --${n} declared as both ${seen.get(n)} and ${kind} (ambiguous spec)`,
          );
        seen.set(n, kind);
      }
    }
  }
  const unknownFlagMsg = messages.unknownFlag ?? ((a) => `unknown flag ${a}`);
  const positionalMsg = messages.positional ?? ((a) => `unexpected argument "${a}"`);
  if (subcommand) {
    let i = 0;
    const leading = {};
    // Peel leading spec'd booleans, resolving short-flag aliases exactly like the main
    // loop below (review 1777 r3 [2]: a long-only peel would let `-f derail` reintroduce
    // the flag-swallows-subcommand bug via the alias path). Anything else — a value flag,
    // an unknown flag, a bare token — ends the peel and becomes cmd verbatim.
    while (i < argv.length) {
      const a = argv[i];
      const name = a.startsWith('--')
        ? a.slice(2)
        : a.startsWith('-') && a.length > 1
          ? alias[a.slice(1)]
          : undefined;
      if (name === undefined || !boolSet.has(name)) break;
      leading[name] = true;
      i++;
    }
    const cmd = argv[i]; // verbatim — may be flag-shaped or undefined; see the doc block above
    const rest = parseFlags(argv.slice(cmd === undefined ? i : i + 1), {
      ...spec,
      subcommand: false,
    });
    return { cmd, positionals: rest.positionals, flags: { ...leading, ...rest.flags } };
  }
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let name;
    // `=`-joined value ('' included) — undefined when the token carries no `=` (plan 1968)
    let joined;
    if (a.startsWith('--')) {
      name = a.slice(2);
      const eq = name.indexOf('=');
      if (eq !== -1) {
        joined = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
    } else if (a.startsWith('-') && a.length > 1) {
      name = alias[a.slice(1)];
      if (name === undefined) throw new Error(`${label}: ${unknownFlagMsg(a)}`);
    } else {
      if (!allowPositionals) throw new Error(`${label}: ${positionalMsg(a)}`);
      positionals.push(a);
      continue;
    }
    if (multiSet.has(name)) {
      const list = Array.isArray(flags[name]) ? flags[name] : (flags[name] = []);
      if (joined !== undefined) list.push(joined);
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) list.push(argv[++i]);
    } else if (valueSet.has(name)) {
      // A value flag that runs off the END of argv stores `undefined` but SETS THE KEY. That is the
      // DEFAULT and it is deliberate — coord-git.test.mjs pins it, and it is the only reason a
      // caller can tell "flag absent" from "flag present, value missing" at all (`'x' in flags`,
      // never `flags.x != null`). But almost no caller actually makes that distinction, so for them
      // the stored `undefined` reads as "absent" and the malformed request silently takes the
      // DEFAULT: `battery-lock path --tier` printed the wrong tier's path, `--lock-path` fell back
      // to the real machine lock, `--branch` fell back to auto-detection. Plan 2734 went through
      // both wrong answers before this one — first making it throw for EVERYONE (which broke the
      // pinned contract), then reverting to a `--tier`-only workaround (which left every other flag
      // silently defaultable). `requireValues: true` in a caller's spec is the opt-in strict mode:
      // the pinned contract stays the default, and a caller that does not do `in`-checks says so
      // once in its spec instead of hand-rolling a guard per flag.
      // Strict mode covers BOTH ways a value can be absent-in-effect (review round 5): running off
      // the end of argv, and an explicitly empty or whitespace-only one. `--lock-path=` stores `''`,
      // which is falsy but not nullish, so it slips past `??` and `== null` alike and lands as a
      // path — every strict caller then had to hand-roll its own emptiness loop, and battery-lock
      // simply didn't. One check here, none at the call sites.
      const missing = joined === undefined && i + 1 >= argv.length;
      const v = missing ? undefined : joined !== undefined ? joined : argv[i + 1];
      if (requireValues && (missing || String(v).trim() === ''))
        throw new Error(
          `${label}: flag --${name} is missing its value ` +
            (missing ? '(end of arguments)' : `(got ${JSON.stringify(v)})`),
        );
      flags[name] = joined !== undefined ? joined : argv[++i];
    } else if (optionalSet.has(name)) {
      flags[name] = joined !== undefined ? joined : true;
    } else if (boolSet.has(name)) {
      if (joined !== undefined)
        throw new Error(`${label}: flag --${name} takes no value (got "${a}")`);
      flags[name] = true;
    } else {
      throw new Error(`${label}: ${unknownFlagMsg(a)}`);
    }
  }
  return { positionals, flags };
}

// plan 2514: the shared closed-vocabulary CLI-flag validator — one throw shape for every
// "VALID_X array + membership check + invalid-value error" call site instead of four
// hand-rolled copies (move-plan's VALID_TARGETS, stamp-exec-model's VALID_EXEC_MODELS,
// stamp-cloud-exec's VALID_CLOUD_EXEC/VALID_CLOUD_ENV, claim-plan-lib's DISPATCH_MODES).
// Returns `value` unchanged on success; throws a single unified message on a miss so a
// later wording change (e.g. a --help hint) touches one place instead of four. `prefix`
// (sonnet-review 2026-07-27, plan 2514) folds each script's own "<script>: " lead-in into
// the thrown message itself, so a caller's catch block never re-derives it — it just prints
// `e.message` and returns its own exit code; only `prefix`-less claim-plan-lib.mjs lets the
// throw propagate raw, as it always has.
export function assertOneOf(value, validValues, { label, prefix } = {}) {
  if (!validValues.includes(value)) {
    const msg = `invalid ${label} "${value}". One of: ${validValues.join(', ')}`;
    throw new Error(prefix ? `${prefix}: ${msg}` : msg);
  }
  return value;
}
