// scripts/usage-parse.mjs — pure parsers for the /api/oauth/usage payload shape (the same
// object the statusline caches to .usage_cache.json). A LEAF module with ZERO imports so
// the read-only pacer (orchestrator-budget.mjs) can reuse the five_hour parser without
// dragging in cloud-usage-guard's HTTP/fs/credentials dependency graph on every spawn (plan
// 1959 review finding [3]). cloud-usage-guard.mjs re-exports these for its existing
// consumers (usage-broadcast imports windowFromUsage from there).

// Pull one { utilization, resets_at } window out of a parsed usage payload. Single parser
// for the payload shape — a field rename fixes here and nowhere else. null when unusable.
export function windowFromUsage(usage, key) {
  const w = usage?.[key];
  if (!w || typeof w.utilization !== 'number') return null;
  return { utilization: w.utilization, resets_at: w.resets_at ?? null };
}

// Pull the 5-hour utilization out of a parsed usage payload (null if absent / non-numeric).
export function utilizationFromUsage(usage) {
  return windowFromUsage(usage, 'five_hour')?.utilization ?? null;
}
