// ts-tool — extract CJK UI strings and rewrite .ts/.tsx per l10n/SPEC.md.
//
// Extraction yields entries keyed by corpus id. Rewriting collects span edits
// and splices them as a containment tree: container edits (jsx-group,
// template) re-emit original source slices via renderSpan(), which resolves
// nested edits recursively. No regex, no partial overlaps (asserted).
import ts from 'typescript';
import { hasCJK } from '../lib/cjk.mjs';
import { corpusId } from '../lib/id.mjs';
import { jsxWhitespace, nfc, escapeJsString } from '../lib/normalize.mjs';

function isTsTestPath(p) {
  return /\.(test|spec)\.[jt]sx?$/.test(p) || p.includes('__tests__/');
}

function calleeName(expr) {
  if (ts.isPropertyAccessExpression(expr)) return expr.getText();
  if (ts.isIdentifier(expr)) return expr.text;
  return null;
}

function isLogCall(call) {
  const name = calleeName(call.expression);
  return name != null && /^(console|logger)(\.|$)/.test(name);
}

/** Methods whose string argument is matched against other text (SPEC § Phase 2 B). */
const LOGIC_METHODS = new Set([
  'includes', 'startsWith', 'endsWith', 'indexOf', 'match', 'test',
]);

/**
 * Logic context of a literal occurrence (Phase 2 classification input):
 * method-arg (substring match), compare (exact match), case, object-key,
 * index (computed property lookup). Unknown methods are recorded with
 * known:false so classify.mjs can flag them for review.
 */
function logicFor(node) {
  const p = node.parent;
  if (!p) return undefined;
  if (ts.isCallExpression(p) && p.arguments.includes(node)) {
    const callee = p.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      return {
        type: 'method-arg',
        method,
        receiver: callee.expression.getText().slice(0, 80),
        known: LOGIC_METHODS.has(method),
      };
    }
    return { type: 'call-arg', callee: callee.getText().slice(0, 60) };
  }
  if (
    ts.isBinaryExpression(p) &&
    ['===', '!==', '==', '!='].includes(p.operatorToken.getText()) &&
    (p.left === node || p.right === node)
  ) {
    return { type: 'compare', op: p.operatorToken.getText() };
  }
  if (ts.isCaseClause(p) && p.expression === node) return { type: 'case' };
  if (ts.isPropertyAssignment(p) && p.name === node) return { type: 'object-key' };
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node)
    return { type: 'index' };
  return undefined;
}

function nearestCallableName(node) {
  let n = node;
  while (n) {
    const p = n.parent;
    if (!p) return null;
    if (
      (ts.isFunctionDeclaration(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isGetAccessorDeclaration(p) ||
        ts.isSetAccessorDeclaration(p)) &&
      p.name
    ) {
      const nm = p.name.getText();
      return /^[A-Z]/.test(nm) ? `component:${nm}` : `fn:${nm}`;
    }
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
      return /^[A-Z]/.test(p.name.text)
        ? `component:${p.name.text}`
        : `fn:${p.name.text}`;
    }
    if (ts.isPropertyAssignment(p) && n !== p.name) {
      const nm = p.name.getText();
      return /^[A-Z]/.test(nm) ? `component:${nm}` : `key:${nm}`;
    }
    n = p;
  }
  return null;
}

function hintFor(node, extra = []) {
  const parts = [];
  const callable = nearestCallableName(node);
  if (callable) parts.push(callable);
  parts.push(...extra.filter(Boolean));
  return parts.join('+');
}

class Extractor {
  constructor(sf, relPath, opts = {}) {
    this.sf = sf;
    this.text = sf.text;
    this.relPath = relPath;
    this.inTest = opts.inTest ?? isTsTestPath(relPath);
    this.entries = new Map();
    this.edits = []; // {start,end,kind,entry,translated,data}
    this.review = [];
    this.translator = opts.translator || null;
    this.pendingData = null; // set by template/group visitors before addEntry
  }

  addEntry(kind, normalized, placeholders, start, end, hintParts, logic) {
    normalized = nfc(normalized);
    if (!hasCJK(normalized)) return null;
    const id = corpusId(normalized);
    let e = this.entries.get(id);
    if (!e) {
      e = {
        id,
        source: normalized,
        kinds: [],
        hint: '',
        placeholders,
        in_test: this.inTest,
        occurrences: [],
      };
      this.entries.set(id, e);
    }
    if (!e.kinds.includes(kind)) e.kinds.push(kind);
    const { line, character } = this.sf.getLineAndCharacterOfPosition(start);
    const occ = {
      file: this.relPath,
      line: line + 1,
      col: character + 1,
      start,
      end,
      tool: 'ts',
    };
    if (logic) occ.logic = logic;
    e.occurrences.push(occ);
    e.occurrences.sort((a, b) =>
      a.file === b.file ? a.start - b.start : a.file < b.file ? -1 : 1
    );
    const h = hintParts.filter(Boolean).join('+');
    if (h && !e.hint.includes(h)) e.hint = e.hint ? `${e.hint} | ${h}` : h;

    if (this.translator) {
      const translated = this.translator(e);
      if (translated != null) {
        this.edits.push({
          start,
          end,
          kind,
          entry: e,
          translated,
          data: this.pendingData || null,
        });
      }
    }
    this.pendingData = null;
    return e;
  }

  /**
   * Rendered text of a JsxText child. TS's scanner moves same-line boundary
   * spaces after `}` or `</tag>` into the un-noded gap before the text node;
   * React still renders them, so prepend the raw gap (the whitespace
   * algorithm then matches Babel/React exactly).
   */
  pieceText(child, prevEnd) {
    const gap = this.text.slice(prevEnd, child.getStart(this.sf));
    return jsxWhitespace(gap + child.getText(this.sf));
  }

  prevEndOf(child) {
    const p = child.parent;
    if (!p || !p.children) return null;
    const idx = p.children.indexOf(child);
    if (idx > 0) return p.children[idx - 1].end;
    if (ts.isJsxElement(p)) return p.openingElement.end;
    if (ts.isJsxFragment(p)) return p.openingFragment.end;
    return null;
  }

  visit(node) {
    if (node == null) return;

    // skips (SPEC §4.6)
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isImportSpecifier(node) ||
      ts.isExportSpecifier(node) ||
      ts.isImportClause(node) ||
      ts.isNamespaceImport(node)
    ) {
      return;
    }
    if (ts.isCallExpression(node) && isLogCall(node)) {
      this.visit(node.expression);
      return;
    }
    if (ts.isTaggedTemplateExpression(node)) {
      this.review.push({
        item: 'tagged-template',
        file: this.relPath,
        line:
          this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf)).line +
          1,
        detail: 'Tagged template skipped per SPEC §4.2',
      });
      return;
    }

    // kinds
    if (ts.isStringLiteral(node) && hasCJK(node.text)) {
      const p = node.parent;
      const isAttr = p && ts.isJsxAttribute(p);
      const extra = isAttr
        ? [`attr:${p.name.getText()}`]
        : [...attrKeyExtra(node), ...typeExtra(node)];
      this.addEntry(
        isAttr ? 'jsx-attr' : 'string',
        node.text,
        {},
        node.getStart(this.sf),
        node.end,
        [hintFor(node, extra)],
        isAttr ? undefined : logicFor(node)
      );
      return;
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      if (hasCJK(node.text)) {
        this.addEntry('template', node.text, {}, node.getStart(this.sf), node.end, [
          hintFor(node),
        ], logicFor(node));
      }
      return;
    }
    if (ts.isTemplateExpression(node)) {
      this.templateEntry(node);
      return;
    }
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      if (this.isGroup(node)) {
        this.groupEntry(node);
        return;
      }
      this.visitAttributes(node);
      for (const c of node.children) this.visit(c);
      return;
    }
    if (ts.isJsxSelfClosingElement(node)) {
      this.visitAttributes(node);
      return;
    }
    if (ts.isJsxText(node)) {
      const prevEnd = this.prevEndOf(node);
      const norm =
        prevEnd != null
          ? this.pieceText(node, prevEnd)
          : jsxWhitespace(node.getText(this.sf));
      if (norm.trim() !== '' && hasCJK(norm)) {
        this.addEntry('jsx-text', norm, {}, node.getStart(this.sf), node.end, [
          hintFor(node, ['jsx-text']),
        ]);
      }
      return;
    }

    ts.forEachChild(node, (c) => this.visit(c));
  }

  visitAttributes(el) {
    const attrs = ts.isJsxElement(el)
      ? el.openingElement.attributes
      : ts.isJsxFragment(el)
        ? null
        : el.attributes;
    if (!attrs) return;
    for (const a of attrs.properties) {
      if (ts.isJsxAttribute(a) && a.initializer) {
        if (ts.isStringLiteral(a.initializer)) {
          if (hasCJK(a.initializer.text)) {
            this.addEntry(
              'jsx-attr',
              a.initializer.text,
              {},
              a.initializer.getStart(this.sf),
              a.initializer.end,
              [hintFor(a.initializer, [`attr:${a.name.getText()}`])]
            );
          }
        } else if (ts.isJsxExpression(a.initializer)) {
          this.visit(a.initializer.expression);
        } else {
          this.visit(a.initializer);
        }
      } else if (ts.isJsxSpreadAttribute(a)) {
        this.visit(a.expression);
      }
    }
  }

  templateEntry(node) {
    let normalized = nfc(node.head.text);
    const placeholders = {};
    const phSpans = {};
    let n = 0;
    for (const span of node.templateSpans) {
      const s = span.expression.getStart(this.sf);
      const e2 = span.expression.end;
      const exprSrc = this.text.slice(s, e2);
      const key = String(n++);
      placeholders[key] = exprSrc;
      phSpans[key] = [s, e2];
      normalized += `{${key}}` + nfc(span.literal.text);
      this.visit(span.expression);
    }
    this.pendingData = { phSpans };
    this.addEntry('template', normalized, placeholders, node.getStart(this.sf), node.end, [
      hintFor(node),
    ], logicFor(node));
  }

  isGroup(el) {
    const children = el.children;
    if (!children || children.length === 0) return false;
    let sig = 0;
    let cjkText = false;
    let prevEnd = ts.isJsxFragment(el)
      ? el.openingFragment.end
      : el.openingElement.end;
    for (const c of children) {
      if (ts.isJsxText(c)) {
        const norm = this.pieceText(c, prevEnd);
        if (norm !== '') {
          sig += 1;
          if (hasCJK(norm)) cjkText = true;
        }
      } else if (ts.isJsxExpression(c)) {
        if (c.expression) sig += 1;
      } else if (
        ts.isJsxElement(c) ||
        ts.isJsxFragment(c) ||
        ts.isJsxSelfClosingElement(c)
      ) {
        sig += 1;
      }
      prevEnd = c.end;
    }
    return sig >= 2 && cjkText;
  }

  groupEntry(el) {
    // the group element's OWN attributes are separate entries (their spans
    // sit inside the open-tag slice the rewrite re-emits)
    this.visitAttributes(el);
    const start = ts.isJsxFragment(el)
      ? el.openingFragment.end
      : el.openingElement.end;
    const end = ts.isJsxFragment(el)
      ? el.closingFragment.getStart(this.sf)
      : el.closingElement.getStart(this.sf);

    const placeholders = {};
    const phSpans = {};
    const tagSpans = {}; // N -> {open:[s,e], close:[s,e]} | {selfClosing:[s,e]}
    let phN = 0;
    let tagN = 0;
    const parts = [];

    const renderChildren = (children, prevEnd) => {
      for (const c of children) {
        if (ts.isJsxText(c)) {
          const norm = this.pieceText(c, prevEnd);
          if (norm !== '') parts.push(norm);
        } else if (ts.isJsxExpression(c)) {
          if (!c.expression) continue;
          const s = c.expression.getStart(this.sf);
          const e2 = c.expression.end;
          const key = String(phN++);
          placeholders[key] = this.text.slice(s, e2);
          phSpans[key] = [s, e2];
          parts.push(`{${key}}`);
        } else if (
          ts.isJsxElement(c) ||
          ts.isJsxFragment(c) ||
          ts.isJsxSelfClosingElement(c)
        ) {
          tagN += 1;
          const myN = tagN; // recursion bumps tagN; close with OUR number
          if (ts.isJsxSelfClosingElement(c)) {
            tagSpans[myN] = {
              selfClosing: [c.getStart(this.sf), c.end],
            };
            parts.push(`<${myN}/>`);
          } else {
            const open = ts.isJsxFragment(c)
              ? [c.openingFragment.getStart(this.sf), c.openingFragment.end]
              : [c.openingElement.getStart(this.sf), c.openingElement.end];
            const close = ts.isJsxFragment(c)
              ? [c.closingFragment.getStart(this.sf), c.closingFragment.end]
              : [c.closingElement.getStart(this.sf), c.closingElement.end];
            tagSpans[myN] = { open, close };
            parts.push(`<${myN}>`);
            renderChildren(c.children, open[1]);
            parts.push(`</${myN}>`);
          }
        }
        prevEnd = c.end;
      }
    };
    renderChildren(el.children, start);

    const hintTag = ts.isJsxElement(el)
      ? `tag:${el.openingElement.tagName.getText()}`
      : 'tag:fragment';
    this.pendingData = { phSpans, tagSpans };
    this.addEntry('jsx-group', parts.join(''), placeholders, start, end, [
      hintFor(el, [hintTag]),
    ]);

    // nested entries: expressions (nested groups/templates/strings) and attrs
    const visitNested = (children) => {
      for (const c of children) {
        if (ts.isJsxExpression(c) && c.expression) {
          this.visit(c.expression);
        } else if (ts.isJsxElement(c) || ts.isJsxFragment(c)) {
          this.visitAttributes(c);
          visitNested(c.children);
        } else if (ts.isJsxSelfClosingElement(c)) {
          this.visitAttributes(c);
        }
      }
    };
    visitNested(el.children);
  }
}

function attrKeyExtra(node) {
  const p = node.parent;
  if (p && ts.isPropertyAssignment(p) && p.name === node)
    return [`key:${node.text}`];
  return [];
}

function typeExtra(node) {
  const p = node.parent;
  if (p && ts.isLiteralTypeNode(p)) {
    if (p.parent && ts.isTypeReferenceNode(p.parent))
      return [`type:${p.parent.getText()}`];
    return ['type:union'];
  }
  return [];
}

/** ─── rewrite: containment tree + renderSpan ───────────────────────────── */

function escapeJsxTextOut(s) {
  return s.replace(/\{/g, "{'{'}").replace(/\}/g, "{'}'}");
}

/** Scan translated template text emitting escaped chars; returns [out, nextIndex]. */
function escapeTemplateChar(s, i) {
  const ch = s[i];
  if (ch === '`') return ['\\`', i + 1];
  if (ch === '$' && s[i + 1] === '{') return ['$\\{', i + 2];
  if (ch === '\\') return ['\\\\', i + 1];
  return [ch, i + 1];
}

/**
 * Apply edits to text. Each container edit's replacement is produced by
 * buildReplacement(edit, renderSpan), where renderSpan resolves nested edits.
 * Returns the new text. Throws on partial overlaps.
 */
export function applyEditsWith(text, edits, buildReplacement) {
  const sorted = [...edits].sort(
    (a, b) => a.start - b.start || b.end - a.end
  );
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const nested = b.start >= a.start && b.end <= a.end;
    const disjoint = b.start >= a.end;
    if (!nested && !disjoint)
      throw new Error(`partial overlap: [${a.start},${a.end}] vs [${b.start},${b.end}]`);
    if (nested && a.start === b.start && a.end === b.end && a !== b)
      throw new Error(`duplicate span: [${a.start},${a.end}]`);
  }
  const kidsOf = new Map(); // parent edit -> children
  const parentOf = new Map();
  const stack = [];
  const top = [];
  for (const e of sorted) {
    while (stack.length) {
      const t = stack[stack.length - 1];
      if (e.start >= t.start && e.end <= t.end) break;
      stack.pop();
    }
    if (!stack.length) top.push(e);
    else {
      const p = stack[stack.length - 1];
      if (!kidsOf.has(p)) kidsOf.set(p, []);
      kidsOf.get(p).push(e);
      parentOf.set(e, p);
    }
    stack.push(e);
  }

  const resolved = new Map(); // edit -> final replacement text
  const renderSpan = (from, to) => {
    // edits fully inside [from,to) whose parent edit is NOT also inside —
    // those roots render their own children recursively
    const inRange = sorted.filter((e) => e.start >= from && e.end <= to);
    const roots = inRange.filter(
      (e) => !parentOf.has(e) || !inRange.includes(parentOf.get(e))
    );
    let out = '';
    let cur = from;
    for (const e of roots) {
      out += text.slice(cur, e.start);
      if (!resolved.has(e)) {
        resolved.set(e, buildReplacement(e, renderSpan));
      }
      out += resolved.get(e);
      cur = e.end;
    }
    out += text.slice(cur, to);
    return out;
  };

  let out = '';
  let cur = 0;
  for (const e of top) {
    out += text.slice(cur, e.start);
    if (!resolved.has(e)) resolved.set(e, buildReplacement(e, renderSpan));
    out += resolved.get(e);
    cur = e.end;
  }
  out += text.slice(cur, text.length);
  return out;
}

function buildReplacement(text, edit, renderSpan) {
  const { kind, translated, entry, data } = edit;
  if (kind === 'string') {
    const q = text[edit.start] === "'" ? "'" : '"';
    return q + escapeJsString(translated, q) + q;
  }
  if (kind === 'jsx-attr') {
    // JSX attribute strings have NO backslash escapes — use entities
    return '"' + translated.replace(/"/g, '&quot;').replace(/\n/g, '&#10;') + '"';
  }
  if (kind === 'jsx-text') {
    return escapeJsxTextOut(translated);
  }
  if (kind === 'template') {
    let out = '`';
    let i = 0;
    while (i < translated.length) {
      const m = /^\{(\d+)\}/.exec(translated.slice(i));
      if (m) {
        const [s, e2] = data.phSpans[m[1]];
        out += '${' + renderSpan(s, e2) + '}';
        i += m[0].length;
      } else {
        const [esc, next] = escapeTemplateChar(translated, i);
        out += esc;
        i = next;
      }
    }
    return out + '`';
  }
  if (kind === 'jsx-group') {
    let out = '';
    let i = 0;
    const src = translated;
    while (i < src.length) {
      const mPh = /^\{(\d+)\}/.exec(src.slice(i));
      if (mPh) {
        const [s, e2] = data.phSpans[mPh[1]];
        out += '{' + renderSpan(s, e2) + '}';
        i += mPh[0].length;
        continue;
      }
      const mSelf = /^<(\d+)\/>/.exec(src.slice(i));
      if (mSelf) {
        const [s, e2] = data.tagSpans[Number(mSelf[1])].selfClosing;
        out += renderSpan(s, e2);
        i += mSelf[0].length;
        continue;
      }
      const mOpen = /^<(\d+)>/.exec(src.slice(i));
      if (mOpen) {
        const [s, e2] = data.tagSpans[Number(mOpen[1])].open;
        out += renderSpan(s, e2);
        i += mOpen[0].length;
        continue;
      }
      const mClose = /^<\/(\d+)>/.exec(src.slice(i));
      if (mClose) {
        const [s, e2] = data.tagSpans[Number(mClose[1])].close;
        out += renderSpan(s, e2);
        i += mClose[0].length;
        continue;
      }
      out += escapeJsxTextOut(src[i]);
      i += 1;
    }
    return out;
  }
  throw new Error(`buildReplacement: unexpected kind ${kind}`);
}

/** ─── public API ───────────────────────────────────────────────────────── */

export function extractSource(filePath, relPath, sourceText) {
  const sf = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const ex = new Extractor(sf, relPath);
  ex.visit(sf);
  return { entries: [...ex.entries.values()], review: ex.review };
}

/**
 * Rewrite one file. translate(entry) → translated normalized text | null
 * (null = leave the Chinese untouched, e.g. denylisted).
 */
export function rewriteSource(filePath, relPath, sourceText, translate) {
  const sf = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const ex = new Extractor(sf, relPath, { translator: translate });
  ex.visit(sf);
  if (ex.edits.length === 0)
    return { text: sourceText, changed: false, entries: [...ex.entries.values()], review: ex.review };
  const text2 = applyEditsWith(sourceText, ex.edits, (edit, renderSpan) =>
    buildReplacement(sourceText, edit, renderSpan)
  );
  return { text: text2, changed: true, entries: [...ex.entries.values()], review: ex.review };
}
