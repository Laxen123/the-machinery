// scripts/index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage } from './index.mjs';

test('buildMessage produces a docs(plans) commit subject per command', () => {
  assert.match(
    buildMessage('add', '100-Other-alpha.md'),
    /^docs\(plans\): index .*100-Other-alpha\.md/,
  );
  assert.match(buildMessage('archive', '100-Other-alpha.md'), /archive/);
  assert.match(buildMessage('move', '100-Other-alpha.md'), /move|repath/);
  // plan 3971: condense-archive takes no positional (key === 'archive-region'), still a
  // real commit subject.
  assert.match(buildMessage('condense-archive', 'archive-region'), /condense-archive/);
});
