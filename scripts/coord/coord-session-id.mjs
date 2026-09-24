const OVERRIDE_NAME = 'COORD_SESSION_ID';

export const COORD_IDENTITY_ENV_NAMES = Object.freeze([
  'COORD_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'GROK_SESSION_ID',
]);

function readId(env, name) {
  const value = env[name];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string when set`);
  }
  if (/\s/u.test(value)) {
    throw new Error(`${name} must not contain whitespace or control characters`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw new Error(`${name} must not contain whitespace or control characters`);
  }
  return value;
}

/**
 * Resolve the stable coordination owner for Claude, Codex, or Grok.
 *
 * An explicit COORD_SESSION_ID is authoritative. Codex's thread ID identifies
 * the current worker; its session ID is shared by a tree of threads and is only
 * a fallback. Grok exposes one native id, GROK_SESSION_ID. A simultaneously
 * present native identity from another host must match the selected one so a
 * nested host cannot silently act as the wrong owner.
 */
export function coordinationSessionId(env = process.env) {
  if (env === null || typeof env !== 'object') {
    throw new TypeError('coordinationSessionId env must be an object');
  }

  const override = readId(env, OVERRIDE_NAME);
  if (override !== null) return override;

  const threadId = readId(env, 'CODEX_THREAD_ID');
  const sessionId = readId(env, 'CODEX_SESSION_ID');
  const grokId = readId(env, 'GROK_SESSION_ID');
  const codexName = threadId === null ? 'CODEX_SESSION_ID' : 'CODEX_THREAD_ID';
  const populated = [
    ['CLAUDE_CODE_SESSION_ID', readId(env, 'CLAUDE_CODE_SESSION_ID')],
    [codexName, threadId ?? sessionId],
    ['GROK_SESSION_ID', grokId],
  ].filter(([, value]) => value !== null);
  if (populated.length === 0) return null;

  const unique = new Set(populated.map(([, value]) => value));
  if (unique.size === 1) return populated[0][1];

  const names = populated.map(([name]) => name).join(', ');
  throw new Error(
    `Ambiguous coordination identity: populated native variables disagree (${names}); ` +
      `set ${OVERRIDE_NAME} explicitly for the owning command tree`,
  );
}
