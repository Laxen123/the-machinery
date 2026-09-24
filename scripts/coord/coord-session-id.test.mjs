// NEW-TEST-FILE JUSTIFICATION: name-paired tests for the new coordination identity module.
import assert from 'node:assert/strict';
import test from 'node:test';

import { COORD_IDENTITY_ENV_NAMES, coordinationSessionId } from './coord-session-id.mjs';

test('returns null when no identity variable is populated', () => {
  assert.equal(coordinationSessionId({}), null);
  assert.equal(
    coordinationSessionId(Object.fromEntries(COORD_IDENTITY_ENV_NAMES.map((name) => [name, '']))),
    null,
  );
});

test('accepts each native identity independently', () => {
  assert.equal(coordinationSessionId({ CLAUDE_CODE_SESSION_ID: 'claude-1' }), 'claude-1');
  assert.equal(coordinationSessionId({ CODEX_SESSION_ID: 'codex-1' }), 'codex-1');
  assert.equal(coordinationSessionId({ CODEX_THREAD_ID: 'thread-1' }), 'thread-1');
  assert.equal(coordinationSessionId({ GROK_SESSION_ID: 'grok-1' }), 'grok-1');
});

test('uses the Codex thread identity when its session tree has a different ID', () => {
  assert.equal(
    coordinationSessionId({ CODEX_SESSION_ID: 'parent-session', CODEX_THREAD_ID: 'child-thread' }),
    'child-thread',
  );
  assert.equal(
    coordinationSessionId({
      CLAUDE_CODE_SESSION_ID: 'child-thread',
      CODEX_SESSION_ID: 'parent-session',
      CODEX_THREAD_ID: 'child-thread',
    }),
    'child-thread',
  );
});

test('validates a supplied Codex session ID even when the thread ID owns the claim', () => {
  for (const CODEX_SESSION_ID of [42, 'bad\nidentity']) {
    assert.throws(
      () => coordinationSessionId({ CODEX_THREAD_ID: 'thread-owner', CODEX_SESSION_ID }),
      /CODEX_SESSION_ID must/,
    );
  }
});

test('accepts matching native aliases as one identity', () => {
  assert.equal(
    coordinationSessionId({
      CLAUDE_CODE_SESSION_ID: 'shared-id',
      CODEX_SESSION_ID: 'shared-id',
      CODEX_THREAD_ID: 'shared-id',
      GROK_SESSION_ID: 'shared-id',
    }),
    'shared-id',
  );
});

test('refuses conflicting native identities without leaking their values', () => {
  const env = {
    CLAUDE_CODE_SESSION_ID: 'secret-claude-value',
    CODEX_SESSION_ID: 'secret-codex-value',
    CODEX_THREAD_ID: 'secret-codex-value',
  };
  assert.throws(
    () => coordinationSessionId(env),
    (error) => {
      assert.match(error.message, /Ambiguous coordination identity/);
      assert.match(error.message, /CLAUDE_CODE_SESSION_ID/);
      assert.match(error.message, /CODEX_THREAD_ID/);
      assert.doesNotMatch(error.message, /secret-(?:claude|codex)-value/);
      return true;
    },
  );
});

test('refuses a Grok identity that disagrees with Claude or Codex', () => {
  assert.throws(
    () =>
      coordinationSessionId({
        GROK_SESSION_ID: 'secret-grok-value',
        CLAUDE_CODE_SESSION_ID: 'secret-claude-value',
      }),
    (error) => {
      assert.match(error.message, /Ambiguous coordination identity/);
      assert.match(error.message, /GROK_SESSION_ID/);
      assert.match(error.message, /CLAUDE_CODE_SESSION_ID/);
      assert.doesNotMatch(error.message, /secret-(?:grok|claude)-value/);
      return true;
    },
  );
});

test('a nonempty explicit override wins over conflicting or invalid native values', () => {
  assert.equal(
    coordinationSessionId({
      COORD_SESSION_ID: 'delegated-owner',
      CLAUDE_CODE_SESSION_ID: 'claude-owner',
      CODEX_SESSION_ID: 'codex-owner',
      CODEX_THREAD_ID: 42,
      GROK_SESSION_ID: 'grok-owner',
    }),
    'delegated-owner',
  );
});

test('rejects non-string populated values', () => {
  for (const name of COORD_IDENTITY_ENV_NAMES) {
    assert.throws(
      () => coordinationSessionId({ [name]: 123 }),
      new RegExp(`${name} must be a string`),
    );
  }
});

test('rejects whitespace and line or control character injection', () => {
  for (const value of [
    ' leading',
    'trailing ',
    'two words',
    'line\nbreak',
    'tab\tbreak',
    'nul\0byte',
  ]) {
    assert.throws(
      () => coordinationSessionId({ COORD_SESSION_ID: value }),
      /must not contain whitespace or control characters/,
    );
  }
});

test('rejects an invalid env container', () => {
  assert.throws(() => coordinationSessionId(null), /env must be an object/);
  assert.throws(() => coordinationSessionId('env'), /env must be an object/);
});

test('exported identity names include Grok so test harnesses can scrub the live session', () => {
  assert.deepEqual(
    [...COORD_IDENTITY_ENV_NAMES],
    [
      'COORD_SESSION_ID',
      'CLAUDE_CODE_SESSION_ID',
      'CODEX_SESSION_ID',
      'CODEX_THREAD_ID',
      'GROK_SESSION_ID',
    ],
  );
});
