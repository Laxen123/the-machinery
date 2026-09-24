// scripts/coord/claude-env.test.mjs — moved from scripts/fb-responder/classify.test.mjs
// (plan 3959 T2), alongside the cleanClaudeEnv it name-pairs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanClaudeEnv } from './claude-env.mjs';

test('cleanClaudeEnv strips CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY, keeps everything else', () => {
  const source = {
    CLAUDE_CODE_OAUTH_TOKEN: 'foreign-token',
    ANTHROPIC_API_KEY: 'foreign-key',
    CLAUDE_CONFIG_DIR: '/opt/claude-config',
    PATH: '/usr/bin',
  };
  const cleaned = cleanClaudeEnv(source);
  assert.equal(cleaned.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(cleaned.ANTHROPIC_API_KEY, undefined);
  assert.equal(cleaned.CLAUDE_CONFIG_DIR, '/opt/claude-config');
  assert.equal(cleaned.PATH, '/usr/bin');
});

test('cleanClaudeEnv does not mutate the source object', () => {
  const source = { CLAUDE_CODE_OAUTH_TOKEN: 'foreign-token' };
  cleanClaudeEnv(source);
  assert.equal(source.CLAUDE_CODE_OAUTH_TOKEN, 'foreign-token');
});
