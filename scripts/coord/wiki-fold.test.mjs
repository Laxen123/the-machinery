// Justification: name-paired test file for the genuinely new scripts/coord/wiki-fold.mjs module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontmatter, splitFold, foldPointerLine } from './wiki-fold.mjs';

test('splitFrontmatter owns LF/CRLF spans and tolerates closing-fence whitespace', () => {
  for (const eol of ['\n', '\r\n']) {
    const plain = `---${eol}name: x${eol}---${eol}body`;
    const spaced = `---${eol}name: x${eol}--- \t ${eol}body`;
    for (const page of [plain, spaced]) {
      const split = splitFrontmatter(page);
      assert.equal(split.frontmatter, 'name: x');
      assert.equal(split.body, 'body');
      assert.equal(split.end, page.indexOf('body'));
    }
  }
});

test('splitFold splits at the first valid marker and preserves no-fold text byte-for-byte', () => {
  assert.deepEqual(splitFold('head\n<!-- fold -->\ntail'), {
    head: 'head\n',
    tail: 'tail',
    tailBytes: 4,
  });
  assert.deepEqual(splitFold('no marker\r\nkept exactly'), {
    head: 'no marker\r\nkept exactly',
    tail: '',
    tailBytes: 0,
  });
});

test('splitFold ignores fenced markers, accepts trailing spaces, and uses the first valid marker', () => {
  const body = [
    '```md',
    '<!-- fold -->',
    '```',
    'kept',
    '<!-- fold -->   ',
    'first tail',
    '<!-- fold -->',
    'second tail',
  ].join('\n');
  const split = splitFold(body);
  assert.equal(split.head, '```md\n<!-- fold -->\n```\nkept\n');
  assert.equal(split.tail, 'first tail\n<!-- fold -->\nsecond tail');
});

test('splitFold handles tilde fences and counts multi-byte tail bytes', () => {
  const split = splitFold('~~~txt\n<!-- fold -->\n~~~\nhead\n<!-- fold -->\nå ä ö');
  assert.equal(split.head, '~~~txt\n<!-- fold -->\n~~~\nhead\n');
  assert.equal(split.tail, 'å ä ö');
  assert.equal(split.tailBytes, Buffer.byteLength('å ä ö', 'utf8'));
});

test('splitFold skips declared frontmatter, including a closing fence with trailing spaces', () => {
  const page = '---\ndescription: <!-- fold -->\n---   \nhead\n<!-- fold -->\ntail';
  assert.deepEqual(splitFold(page, { hasFrontmatter: true }), {
    head: '---\ndescription: <!-- fold -->\n---   \nhead\n',
    tail: 'tail',
    tailBytes: 4,
  });
});

test('splitFold derives its frontmatter scan offset from splitFrontmatter', () => {
  for (const eol of ['\n', '\r\n']) {
    const page = `---${eol}description: <!-- fold -->${eol}--- \t${eol}head${eol}<!-- fold -->${eol}tail`;
    const span = splitFrontmatter(page);
    const implicit = splitFold(page, { hasFrontmatter: true });
    const explicit = splitFold(page, { scanFrom: span.end });
    assert.deepEqual(implicit, explicit);
    assert.equal(implicit.tail, 'tail');
  }
});

test('splitFold treats leading thematic breaks as body when frontmatter is not declared', () => {
  const body = '---\nintro\n---\n<!-- fold -->\ntail';
  assert.deepEqual(splitFold(body), {
    head: '---\nintro\n---\n',
    tail: 'tail',
    tailBytes: 4,
  });
});

test('foldPointerLine renders the one shared fixed pointer', () => {
  assert.equal(
    foldPointerLine('wiki/entities/platforms/x.md', 12.4 * 1024),
    '… tail: 12.4 KB more on this page (Read wiki/entities/platforms/x.md for the full text)',
  );
});
