// Shared normalization helpers — l10n/SPEC.md §3–§4.
// jsxWhitespace implements Babel/React `cleanJSXElementLiteralChild` semantics.

export function nfc(s) {
  return s.normalize('NFC');
}

/**
 * JSX text whitespace normalization (SPEC §4.3).
 * - leading [ \t]+ stripped on every line except the first physical line
 * - trailing [ \t]+ stripped on every line except the last physical line
 * - whitespace-only lines vanish; non-last non-empty lines are joined with one space
 * - spaces adjacent to tags/expressions on the same physical line are preserved
 */
export function jsxWhitespace(text) {
  const lines = text.split(/\r?\n/);
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/[^ \t]/.test(lines[i])) lastNonEmpty = i;
  }
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    let t = lines[i];
    if (i > 0) t = t.replace(/^[ \t]+/, '');
    if (i < lines.length - 1) t = t.replace(/[ \t]+$/, '');
    if (t !== '') {
      // only append the join space when there is a later non-empty line
      if (lastNonEmpty >= 0 && i !== lastNonEmpty) t += ' ';
      out += t;
    }
  }
  return out;
}

/** Escape a translated string into a JS string literal body with quote `q`. */
export function escapeJsString(s, q) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += '\\' + q;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp === 0x7f)
      out += '\\u' + cp.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out;
}
