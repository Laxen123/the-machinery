// scripts/hooks/lib/hook-dispatch.mjs — the shared machinery of the two in-process hook
// dispatchers (plan 4238): scripts/hooks/pretool-dispatch.mjs (PreToolUse guards) and
// scripts/hooks/prompt-wiki-dispatch.mjs (UserPromptSubmit wiki loaders).
//
// A dispatcher holds a REGISTRY of { name, matcher?, if?, evaluate | load } entries. It runs
// each entry whose own matcher (and optional condition) fits the payload, in registry order,
// in-process, each isolated from the others, and merges what they return the way Claude
// Code merges separate hooks. An entry either carries its `evaluate` function directly, or a
// `load: () => import('./<hook>.mjs')` thunk whose module's `evaluateHook` is called — the
// module is imported only when the entry's matcher and condition fit, so a tool call no entry
// matches imports nothing:
//   - exactly ONE entry speaks → its envelope object is returned UNCHANGED, so the printed
//     JSON is byte-identical to what that hook printed as its own process;
//   - permissionDecision: deny > ask > allow. The winning decision's reasons are kept; one
//     passes through unchanged, several are joined, each prefixed with its hook name;
//   - additionalContext: concatenated in order (a blank line between); systemMessage: joined (' · ') —
//     the same separators the Codex prompt adapter (.codex/hooks/codex-context.mjs) uses to
//     merge separate loaders, so a Codex session sees the same merged text as before;
//   - suppressOutput: kept only when EVERY speaking entry set it.
// A throwing entry writes a one-line note to stderr and is skipped (exit stays 0, so it is
// non-blocking, the same as a crashed separate hook); the others still run. A `load` that
// fails (a syntax error, a missing import, a module without `evaluateHook`) is the same
// case: before the fold such a hook broke only its own process, so here it breaks only its
// own entry.

// The dispatcher's own settings.json matcher: the union of every guard's matcher, in
// first-seen order. A test pins the registered entry to this value.
export function unionMatcher(guards) {
  const seen = [];
  for (const g of guards) {
    for (const tool of g.matcher.split('|')) if (!seen.includes(tool)) seen.push(tool);
  }
  return seen.join('|');
}

// Claude Code treats a matcher as a regex over the whole tool name ("Bash" is exact,
// "Bash|Workflow" an alternation). Anchored so "Bash" never matches "BashOutput".
export function matcherMatches(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(String(toolName ?? ''));
  } catch {
    return false;
  }
}

const DECISION_RANK = { deny: 3, ask: 2, allow: 1 };

// Merge the guards' envelopes. `results` is [{ name, out }] in run order, `out` non-null.
// Exactly one result → that object unchanged (byte-identical to the old separate hook).
export function mergeOutcomes(results, hookEventName = 'PreToolUse') {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0].out;

  const hso = { hookEventName };
  let best = 0;
  for (const { out } of results) {
    const rank = DECISION_RANK[out?.hookSpecificOutput?.permissionDecision] ?? 0;
    if (rank > best) best = rank;
  }
  if (best > 0) {
    const decision = Object.keys(DECISION_RANK).find((k) => DECISION_RANK[k] === best);
    const reasons = results
      .filter(({ out }) => out?.hookSpecificOutput?.permissionDecision === decision)
      .map(({ name, out }) => ({ name, reason: out.hookSpecificOutput.permissionDecisionReason }))
      .filter(({ reason }) => typeof reason === 'string' && reason !== '');
    hso.permissionDecision = decision;
    if (reasons.length === 1) hso.permissionDecisionReason = reasons[0].reason;
    else if (reasons.length > 1) {
      hso.permissionDecisionReason = reasons.map((r) => `[${r.name}] ${r.reason}`).join('\n\n');
    }
  }
  const contexts = results
    .map(({ out }) => out?.hookSpecificOutput?.additionalContext)
    .filter((c) => typeof c === 'string' && c !== '');
  if (contexts.length) hso.additionalContext = contexts.join('\n\n');

  const merged = { hookSpecificOutput: hso };
  const messages = results
    .map(({ out }) => out?.systemMessage)
    .filter((m) => typeof m === 'string' && m !== '');
  if (messages.length) merged.systemMessage = messages.join(' · ');
  if (results.every(({ out }) => out?.suppressOutput === true)) merged.suppressOutput = true;
  return merged;
}

// The entry's evaluate function: its own `evaluate`, or the `evaluateHook` of the module its
// `load` thunk imports. Throws when neither yields a function, so the caller's isolation
// handles a bad module exactly like a throwing hook.
export async function entryEvaluate(entry) {
  if (typeof entry.evaluate === 'function') return entry.evaluate;
  if (typeof entry.load !== 'function') throw new Error('entry has neither evaluate nor load');
  const mod = await entry.load();
  if (typeof mod?.evaluateHook !== 'function') throw new Error('module exports no evaluateHook');
  return mod.evaluateHook;
}

// Run every matching guard in order, each isolated. `stderr` is a seam for tests.
export async function runGuards(
  payload,
  guards,
  { hookEventName = 'PreToolUse', stderr = (t) => process.stderr.write(t) } = {},
) {
  const results = [];
  const toolName = payload?.tool_name;
  for (const guard of guards) {
    if (!matcherMatches(guard.matcher, toolName)) continue;
    if (guard.if && !guard.if(payload)) continue;
    try {
      const evaluate = await entryEvaluate(guard);
      const out = await evaluate(payload);
      if (out) results.push({ name: guard.name, out });
    } catch (err) {
      // A crashed separate hook was non-blocking and silent to the model; keep it that way,
      // but leave a trace for the transcript/debug view.
      stderr(`${guard.name}: failed open (${err?.message ?? err})\n`);
    }
  }
  return mergeOutcomes(results, hookEventName);
}
