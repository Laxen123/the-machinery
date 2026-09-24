// scripts/coord/wiki-fold.mjs — single-owner wiki fold parsing and pointer rendering.
//
// Loader callers declare whether they pass a frontmatter-stripped body or a whole file.
// Whole-file callers opt in with `{ hasFrontmatter: true }`, which prevents a body that
// starts with a Markdown `---` thematic break from being mistaken for YAML frontmatter.

const FRONTMATTER_RX = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

// Split a whole wiki page at its leading frontmatter fence. `end` is the canonical
// scan offset for callers that must retain the whole input (for example splitFold
// and wiki-size-lint); `body` is for loaders that strip metadata before injection.
// A closing fence may carry Markdown-legal horizontal whitespace.
export function splitFrontmatter(value) {
  const text = String(value);
  const match = text.match(FRONTMATTER_RX);
  if (!match) return { frontmatter: '', body: text, end: 0 };
  return {
    frontmatter: match[1],
    body: text.slice(match[0].length),
    end: match[0].length,
  };
}

// Split at the first standalone `<!-- fold -->` line outside a fenced code block.
// The marker itself is omitted from both halves. No marker preserves the input exactly.
export function splitFold(value, { hasFrontmatter = false, scanFrom } = {}) {
  const text = String(value);
  const frontmatterEnd =
    scanFrom === undefined && hasFrontmatter ? splitFrontmatter(text).end : undefined;
  const foldScanFrom = scanFrom ?? frontmatterEnd ?? 0;
  const lineRx = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  lineRx.lastIndex = foldScanFrom;
  let fence = null;

  for (const match of text.matchAll(lineRx)) {
    const line = match[0];
    if (!line) break;
    const content = line.replace(/(?:\r\n|\n|\r)$/, '');
    const fenceMatch = content.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { char: marker[0], length: marker.length };
      } else if (
        marker[0] === fence.char &&
        marker.length >= fence.length &&
        new RegExp(`^ {0,3}${fence.char === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`).test(
          content,
        )
      ) {
        fence = null;
      }
      continue;
    }
    if (!fence && /^<!-- fold -->[ \t]*$/.test(content)) {
      const head = text.slice(0, match.index);
      const tail = text.slice(match.index + line.length);
      return { head, tail, tailBytes: Buffer.byteLength(tail, 'utf8') };
    }
  }

  return { head: text, tail: '', tailBytes: 0 };
}

export function foldPointerLine(rel, tailBytes) {
  return `… tail: ${(tailBytes / 1024).toFixed(1)} KB more on this page (Read ${rel} for the full text)`;
}
