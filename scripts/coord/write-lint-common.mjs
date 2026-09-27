// scripts/coord/write-lint-common.mjs — shared machinery for the frontend/src
// write-time lint hooks (scroll-lock-write-lint.mjs, hover-gate-write-lint.mjs;
// factored out per plan 2177 review findings F2/F4/F6). Each lint module keeps
// its own rule logic and exports { lintableExtension, lintFile }; this module
// owns the pieces that must never drift between them: the tokenizers, the
// path-scope check, the CSS frame walker, and the hook main() harness.
// A project's own PostToolUse write-lint entry script runs
// every lint in one process.

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
// plan 2615: was `../.claude/hooks/lib/loader-common.mjs` (hooks have since moved inside
// scripts/hooks/ too, plan 3765). A `scripts/*.mjs` module must not import outside
// `scripts/` — scripts/test-helpers/isolated-plan-repo.mjs copies the flat non-test scripts
// tree into a temp repo and runs the COPIES, so a tool reaching outside `scripts/` (as
// `.claude/hooks/` was back then) dies there with ERR_MODULE_NOT_FOUND. Same reader,
// scripts-side home.
import { readStdin } from './stdin-read.mjs';

// Blank out /*…*/ comments and '…'/"…" string literals in one pass (contents
// replaced with spaces so a brace or quote inside one can never desync the
// brace scanner; positions/structure otherwise preserved — the output is
// LENGTH-PRESERVING, so offsets computed against it index correctly into the
// original text). Per the CSS spec, an unescaped newline ENDS a string
// (bad-string) — so a transiently unterminated string in a WIP edit blanks at
// most its own line, never the rest of the file (plan 1293 round-2 review
// finding). An unterminated comment DOES run to EOF (also spec behavior), so
// that case stays blanked.
export function stripCommentsAndStrings(css) {
  const s = String(css);
  let out = '';
  let state = null; // null | '"' | "'" | 'comment'
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (state === 'comment') {
      if (ch === '*' && s[i + 1] === '/') {
        out += '  ';
        i++;
        state = null;
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
    } else if (state === '"' || state === "'") {
      if (ch === '\n' || ch === '\r') {
        out += ch; // spec: unescaped newline terminates the string
        state = null;
      } else if (ch === '\\') {
        out += '  ';
        i++;
      } else if (ch === state) {
        out += ch;
        state = null;
      } else {
        out += ' ';
      }
    } else if (ch === '/' && s[i + 1] === '*') {
      out += '  ';
      i++;
      state = 'comment';
    } else if (ch === '"' || ch === "'") {
      out += ch;
      state = ch;
    } else {
      out += ch;
    }
  }
  return out;
}

// Blank out JS/TS comments and string/template literals, PRESERVING newlines
// so downstream line numbers stay correct. Handles // line comments, /* */
// block comments, '…'/"…" strings (newline-terminated, like the engine's own
// error recovery), and `…` template literals (which legitimately span lines —
// their interpolation code is blanked along with them, an accepted
// simplification). Regex literals are not tokenized (a /…scrollIntoView(…/
// regex would false-positive; none exist in the codebase and the lints are
// advisory).
//
// `blankStrings: false` (plan 2622) keeps string/template CONTENTS intact and blanks only
// the comments — for a caller that must read literal text (import specifiers) but must not
// be fooled by an example import quoted inside a comment. String state is still tracked
// either way, so a `//` inside a string is never mistaken for a comment opener; the option
// only changes what is emitted. Default `true` = the original behaviour, byte-for-byte.
export function stripJsCommentsAndStrings(src, { blankStrings = true } = {}) {
  const s = String(src);
  let out = '';
  let state = null; // null | '"' | "'" | '`' | 'line' | 'block'
  // Inside a string, emit the character itself when the caller wants contents kept;
  // otherwise a space (newlines always pass through, so line numbers never shift).
  const inString = (ch) => (blankStrings ? (ch === '\n' ? '\n' : ' ') : ch);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (state === 'line') {
      if (ch === '\n') {
        out += '\n';
        state = null;
      } else {
        out += ' ';
      }
    } else if (state === 'block') {
      if (ch === '*' && s[i + 1] === '/') {
        out += '  ';
        i++;
        state = null;
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
    } else if (state === '"' || state === "'") {
      if (ch === '\n') {
        out += '\n';
        state = null;
      } else if (ch === '\\') {
        out += blankStrings ? '  ' : ch + (s[i + 1] ?? '');
        i++;
      } else if (ch === state) {
        out += ch;
        state = null;
      } else {
        out += inString(ch);
      }
    } else if (state === '`') {
      if (ch === '\\') {
        out += blankStrings ? '  ' : ch + (s[i + 1] ?? '');
        i++;
      } else if (ch === '`') {
        out += ch;
        state = null;
      } else {
        out += inString(ch);
      }
    } else if (ch === '/' && s[i + 1] === '/') {
      out += '  ';
      i++;
      state = 'line';
    } else if (ch === '/' && s[i + 1] === '*') {
      out += '  ';
      i++;
      state = 'block';
    } else if (ch === '"' || ch === "'" || ch === '`') {
      out += ch;
      state = ch;
    } else {
      out += ch;
    }
  }
  return out;
}

// Split a selector list (or a media-query list) on TOP-LEVEL commas only — a
// comma inside :not(.a, .b) or inside a functional media feature does not
// separate members.
export function splitSelectorList(selectorList) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(selectorList)) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Brace-matched walk over every rule frame in a stylesheet, with PER-FRAME
// body attribution: text between structural tokens accumulates in `pending`;
// on '{' the pending tail after the last ';' is the new frame's selector /
// at-rule prelude (the head, prior declarations, stays with the parent frame);
// on '}' the closing frame owns only its own accumulated text — a nested
// rule's declarations are never attributed to the outer selector.
//
// Comments and strings are blanked first (length-preserving), so
// `frame.selectorStart` indexes correctly into the ORIGINAL text — callers
// that need the raw bytes at a position (e.g. suppression-comment matching)
// can use it directly.
//
// Frame shape: { selector, selectorStart, parent, ownText }. `onOpen(frame)`
// fires before the frame is pushed (parent already carries any custom state a
// caller attached to it — e.g. hover-gate's inherited media-gate flag);
// `onClose(frame)` fires when the frame's body is complete, with `ownText`
// holding the frame's OWN declarations only (consumed by scroll-lock's
// forbidden-property scan; hover-gate ignores it).
export function walkCssFrames(cssText, { onOpen, onClose } = {}) {
  const css = stripCommentsAndStrings(cssText);
  const stack = [];
  let pending = '';
  let pendingStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      const cut = pending.lastIndexOf(';');
      const parentPart = cut === -1 ? '' : pending.slice(0, cut + 1);
      const selectorRaw = pending.slice(cut + 1);
      const leadingWs = selectorRaw.length - selectorRaw.trimStart().length;
      if (stack.length && parentPart) stack[stack.length - 1].ownText += parentPart;
      const frame = {
        selector: selectorRaw.trim(),
        selectorStart: pendingStart + (cut === -1 ? 0 : cut + 1) + leadingWs,
        parent: stack.length ? stack[stack.length - 1] : null,
        ownText: '',
      };
      if (onOpen) onOpen(frame);
      stack.push(frame);
      pending = '';
      pendingStart = i + 1;
    } else if (ch === '}') {
      const frame = stack.pop();
      if (frame) {
        frame.ownText += pending;
        if (onClose) onClose(frame);
      }
      pending = '';
      pendingStart = i + 1;
    } else {
      pending += ch;
    }
  }
}

// Is filePath inside the repo's frontend/src tree (directly, or via an
// in-repo worktree checkout at .claude/worktrees/<slug>/)? Root-relative so
// e.g. docs/examples/frontend/src/ never matches. Relative inputs are taken
// as repo-relative.
export function inFrontendSrc(filePath, root) {
  // Normalise `\`→`/` up front, then do all path math WITHOUT a platform-bound
  // `relative`/`normalize`: the write-time hook runs on Windows paths, the CI
  // node:test runs the SAME assertions on Linux, and plain `relative` would
  // mis-resolve `C:\repo\…` on Linux (backslashes become literal) and flip the
  // result. (plan 1451)
  let rel = String(filePath || '').replace(/\\/g, '/');
  if (/^([a-zA-Z]:)?\//.test(rel) && root) {
    // Absolute input: strip the repo-root prefix. Compare case-INSENSITIVELY so a
    // drive-letter / segment casing mismatch between `root` (CLAUDE_PROJECT_DIR or
    // cwd) and `filePath` on a case-insensitive Windows filesystem can't defeat the
    // match — the tolerance win32.relative gave for free, kept here without a
    // platform-bound call so Windows write-time and Linux CI still agree (plan 1451 review [0]).
    const rootFwd = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!rel.toLowerCase().startsWith(rootFwd.toLowerCase() + '/')) return false;
    rel = rel.slice(rootFwd.length + 1);
  } else {
    // Relative input: resolve ../ segments too, so a traversal like
    // frontend/src/../../backend/x.css can't satisfy the prefix regex
    // (plan 1293 round-2 review finding).
    rel = posix.normalize(rel);
  }
  if (rel.startsWith('..')) return false;
  return /^(\.claude\/worktrees\/[^/]+\/)?frontend\/src\//.test(rel);
}

// The shared PostToolUse(Edit|Write|MultiEdit) main() harness: parse the hook
// payload from stdin, gate on scope + each lint's own extension check BEFORE
// any disk read (a seed edit must pay nothing), resolve content once (Write
// payloads carry it in tool_input.content; Edit falls back to one readFileSync),
// then run every applicable lint in-process and print the combined warnings.
// ADVISORY ONLY: plain-text warnings on stdout, always exit 0, each lint fails
// silent on its own parse error.
export function runWriteLintHook(lints) {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // fail silent
  }
  const ti = payload?.tool_input || {};
  const fp = ti.file_path || '';
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!fp || !inFrontendSrc(fp, root)) return;
  const applicable = lints.filter((l) => l.lintableExtension(fp));
  if (!applicable.length) return;
  let content;
  if (typeof ti.content === 'string') {
    content = ti.content; // Write payload already carries the written content
  } else {
    try {
      content = readFileSync(fp, 'utf8');
    } catch {
      return; // deleted/unreadable → nothing to lint
    }
  }
  const warnings = [];
  for (const l of applicable) {
    try {
      warnings.push(...l.lintFile(fp, content));
    } catch {
      // fail silent per lint — one lint's parse error must not mute the others
    }
  }
  if (warnings.length) process.stdout.write(warnings.join('\n') + '\n');
}
