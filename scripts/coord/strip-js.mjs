// Shared lexical masks for source readers; no graph or filesystem dependencies.
/**
 * Blank out comments — and optionally string/template contents — so a regex probe cannot match
 * the thing it is looking for inside prose (gpt-review rounds 1 and 2).
 *
 * Shared by module-graph and the battery selector. Kept separate from the graph's CLI and
 * dynamic filesystem census so using this mask does not widen a consumer's battery cache key.
 *
 * TWO REGEX GENERATIONS WERE TRIED AND FAILED BEFORE THIS, both recorded because each looked
 * right: a comments-and-strings regex stripper ate the real `export function main()` out of
 * `select-battery-tests.mjs` and `wiki-commit.mjs` (it cannot know regex or template literals),
 * and column-0 anchoring then traded that for missing every INDENTED top-level export. A scanner
 * is the only thing that is exact in both directions.
 *
 * Newlines always pass through, so line numbers never shift.
 */
export function stripJs(src, { blankStrings = true } = {}) {
  const s = String(src);
  let out = '';
  let tokenContext = ''; // strings/regex become a value token in BOTH output modes
  const controlParens = [];
  let regexClass = false;
  // A STACK, not a scalar: a template literal's `${…}` is code that may itself contain another
  // template (`` `x ${ `y` } z` ``), and a single-slot state desynced on the inner backtick —
  // masking real code from there to end of file (gpt-review round 3).
  const stack = []; // entries: '"' | "'" | '`' | 'line' | 'block' | 'regex' | 'interp'
  const interpolationDepth = [];
  const top = () => stack[stack.length - 1] ?? null;
  const keep = (ch) => (blankStrings ? (ch === '\n' ? '\n' : ' ') : ch);
  // Can a `/` here START a regex literal, or is it division? Decided by the previous meaningful
  // lexical token: after a value (identifier, number, `)`, `]`) it is division; after an
  // operator, `(`, `,`, `=`, `return` etc. it is a regex. Getting this backwards is fatal in both
  // directions — a missed regex corrupts the mask at its first unbalanced quote, and a division
  // read as a regex swallows the rest of the file.
  const regexCanStart = () => {
    const m = tokenContext.match(/([^\s])\s*$/);
    if (!m) return true;
    if (/(?:\+\+|--)\s*$/.test(tokenContext)) return false;
    const c = m[1];
    if (/[)\]}]/.test(c)) return false;
    if (/[A-Za-z0-9_$]/.test(c))
      return /\b(?:return|throw|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)\s*$/.test(
        tokenContext,
      );
    return true;
  };
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    const next = s[i + 1];
    const state = top();
    if (state === 'line') {
      if (ch === '\n') {
        out += '\n';
        stack.pop();
      } else out += ' ';
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        out += '  ';
        i += 1;
        stack.pop();
      } else out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'regex') {
      // Blanked like a comment: a regex literal is never code we probe for, and its contents are
      // exactly what used to corrupt the scan.
      if (ch === '\\') {
        out += '  ';
        i += 1;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      if (ch === '[') regexClass = true;
      if (ch === ']') regexClass = false;
      if (ch === '/' && !regexClass) {
        stack.pop();
        tokenContext += '0';
      }
      continue;
    }
    if (state === '"' || state === "'" || state === '`') {
      if (ch === '\\') {
        out += keep(ch) + keep(next ?? '');
        i += 1;
        continue;
      }
      // `${` inside a template opens real code again.
      if (state === '`' && ch === '$' && next === '{') {
        out += blankStrings ? '  ' : '${';
        i += 1;
        stack.push('interp');
        interpolationDepth.push(0);
        tokenContext += '(';
        continue;
      }
      out += keep(ch);
      if (ch === state) {
        stack.pop();
        tokenContext += '0';
      }
      continue;
    }
    // state === null or 'interp' — both are CODE.
    if (state === 'interp' && ch === '{') {
      interpolationDepth[interpolationDepth.length - 1] += 1;
      out += ch;
      tokenContext += ch;
      continue;
    }
    if (state === 'interp' && ch === '}') {
      if (interpolationDepth[interpolationDepth.length - 1] > 0) {
        interpolationDepth[interpolationDepth.length - 1] -= 1;
        out += ch;
        tokenContext += ch;
      } else {
        out += blankStrings ? ' ' : '}';
        stack.pop();
        interpolationDepth.pop();
        tokenContext += ')';
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      out += '  ';
      i += 1;
      stack.push('line');
      tokenContext += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 1;
      stack.push('block');
      tokenContext += ' ';
      continue;
    }
    if (ch === '/' && regexCanStart()) {
      out += ' ';
      stack.push('regex');
      regexClass = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      stack.push(ch);
      out += keep(ch);
      continue;
    }
    if (ch === '(') {
      const tail = tokenContext.trimEnd();
      const keyword = /\b(?:if|while|for|with|switch|catch)$/.exec(tail.slice(-7));
      controlParens.push(
        Boolean(keyword) && !tail.slice(0, -keyword[0].length).trimEnd().endsWith('.'),
      );
    }
    // A control condition closes into a statement; an ordinary call closes into a value.
    tokenContext += ch === ')' && controlParens.pop() ? ';' : ch;
    out += ch;
  }
  return out;
}
