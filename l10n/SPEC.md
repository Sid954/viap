# l10n SPEC — normalization, ids, and corpus format

This document is the contract between `l10n/ts-tool` (TypeScript) and `l10n/rust-tool` (Rust).
Both extractors and both rewriters MUST implement it identically. The shared fixture suite
(`l10n/tests/`) proves agreement; any change here requires updating both tools and the fixtures.

## 1. Corpus entry format

```json
{
  "id": "3f2a9c1d0b7e4f55",
  "source": "已迁移 {0} 个应用",
  "kinds": ["string", "rust-format"],
  "hint": "component:AppMigration | fn:format",
  "placeholders": { "0": "<original expression source or format spec>" },
  "in_test": false,
  "occurrences": [
    { "file": "src/pages/AppMigration.tsx", "line": 10, "col": 5, "start": 0, "end": 0, "tool": "ts" }
  ]
}
```

- `id` — 16 lowercase hex chars: `sha1(utf8(NFC(normalized_source))).hexdigest[0:16]`.
- `source` — the **normalized source** (rules in §3–§6). NFC. Placeholders as `{N}`; JSX inline elements as `<N>…</N>`.
- `kinds` — array of kinds contributing this exact normalized text (merged across tools). One of:
  `jsx-text, jsx-group, jsx-attr, string, template, rust-str, rust-format, rust-raw`.
- `placeholders` — map `{N}` → original content. For TS kinds: the **exact expression source text** (without surrounding braces). For `rust-format`: the **original format placeholder token**, e.g. `{}`, `{:?}`, `{source}`, `{0:>5}`. In the **merged** corpus the keys must agree across tools; values prefer the ts side (expression sources).
- `occurrences[]` — `file` repo-relative POSIX path; `line` 1-based; `col` 1-based;
  `start`/`end`: TS = UTF-16 code-unit offsets (TypeScript standard), Rust = byte offsets;
  `tool`: `ts` | `rust`. Occurrences are sorted by (file, start).
- The unified `corpus.json` is sorted by `id`. JSON output: 2-space indent, LF, trailing newline.
- ts-tool walks only `.ts`/`.tsx` (never `.js`), excluding `node_modules`, `dist`,
  `dist-ssr`, `build`, `out`, `coverage`, `target`, and `.d.ts` files.

## 2. CJK detection

An entry is extracted iff its normalized text contains at least one character in:

```
U+3000–U+303F (CJK punctuation)  U+3400–U+4DBF (Ext A)  U+4E00–U+9FFF (Unified)
U+F900–U+FAFF (compatibility)    U+FF01–U+FF60 (fullwidth forms)
```

Mixed strings (`VS Code 扩展`) are included. Strings with only full-width punctuation and no
other CJK are still included (they are user-visible).

## 3. Shared text normalization

1. NFC (`String.prototype.normalize('NFC')` / `unicode_normalization::UnicodeNormalization::nfc`).
2. Placeholders `{N}` are numbered **by first appearance** in the normalized text, `0,1,2,…`.
3. JSX inline-element tags `<N>…</N>` are numbered by **opening-tag order**, starting at `1`,
   independent of the expression counter. Tag structure in a translation must stay balanced and
   properly nested (validated in Phase 3).
4. `{{` and `}}` in Rust format strings are literal braces and stay verbatim in the normalized
   source; a translation must keep them.

## 4. TypeScript kinds

### 4.1 `string` — `ts.StringLiteral` with CJK

Any string literal in expression or type position, EXCEPT the skips in §4.6.
Normalized = NFC(cooked value). No placeholders.

### 4.2 `template`

- `TemplateExpression`: normalized = NFC(cooked head) + `{N}` for each substitution + NFC(cooked
  spans/tail). `placeholders[N]` = exact expression source text (file slice of the expression,
  no braces). CJK literals **inside** a substitution expression are their own entries.
- `NoSubstitutionTemplateLiteral` with CJK: kind `template`, no placeholders.
- Tagged templates are skipped (none in this codebase; a scan assertion reports any found).

### 4.3 `jsx-text`

A JSX text node with CJK that is **not** inside a `jsx-group` (§4.4) and not pure whitespace.
Normalized = NFC(result of the whitespace algorithm below). No placeholders.

**JSX whitespace algorithm** (matches React/Babel `cleanJSXElementLiteralChild`):

The TS scanner moves same-line boundary spaces after `}` or `</tag>` into the
un-noded gap before the following text node (and may leave a degenerate empty
text node). React still renders those spaces, so each text piece is
**`raw gap slice + node text`** before the algorithm below runs.

```
lines = text.split(/\r?\n/)
lastNonEmpty = index of last line containing a non-[ \t] char
out = ""
for i, line in lines:
  t = line
  if i > 0:            t = t.replace(/^[ \t]+/, "")
  if i < len-1:        t = t.replace(/[ \t]+$/, "")
  if t != "":
    if i != lastNonEmpty: t += " "
    out += t
```

Leading/trailing spaces on the first/last physical line (adjacent to tags/expressions on the same
line) are preserved — they render as spaces. Whitespace-only lines vanish.

### 4.4 `jsx-group`

An element (`JsxElement`) or fragment whose **significant children** number ≥ 2 and at least one
significant jsx-text child contains CJK. Significant children: jsx-text with non-empty
normalized text, `JsxExpressionContainer` with an expression, `JsxElement`,
`JsxSelfClosingElement`, `JsxFragment`.

Normalized composition, in document order:

- jsx-text child → its §4.3-normalized text (must contain the spaces exactly as rendered);
- expression child → `{N}` (numbered globally through the whole entry, first-appearance order);
- element/fragment child → `<N>` + recursive composition of its children + `</N>`; self-closing
  element children render as `<N/>`; the element's nested expressions get their own `{M}` numbers
  in document order; nested elements get further tag numbers.

Only the **outermost** qualifying element is an entry. JSX descendants reached only through
expression containers are evaluated fresh (they may form their own groups — e.g.
`{cond && (<span>其中 {n} 条</span>)}` inside a group is a separate nested `jsx-group` entry whose
span lies inside the outer entry's expression placeholder).

Attributes of grouped elements are never part of the normalized text; they are re-emitted from
their original source slice (their own CJK attribute values are separate `jsx-attr` entries).

Occurrence span: from `openingElement.getEnd()` to `closingElement.getStart()` (fragment analog).

### 4.5 `jsx-attr`

`JsxAttribute` whose initializer is a `StringLiteral` with CJK. Normalized = NFC(cooked).
An expression initializer (`title={'…'}` / `title={`…`}`) is walked as a normal expression
(kinds `string`/`template`), with hint `attr:<name>`.

### 4.6 TypeScript skips

- Import/export module specifiers and import/export specifier names.
- Entire argument subtrees of `console.*` and `logger.*` calls.
- Comments (never in AST), regex literals.
- String-literal **property keys** are NOT skipped (they are class-A lookup keys and must be
  translatable consistently); they are extracted with hint `key:<name>`.

### 4.7 TypeScript hints

Nearest enclosing context, deterministic: `component:<Name>` / `fn:<name>` / `attr:<name>` /
`key:<name>` / `type:<Name>` / `method:<name>` (call arg), joined `+` when several apply
(e.g. `component:LinkRecoveryModal+tag:span`).

## 5. Rust kinds

### 5.1 Macro handling

Macros are classified by name:

- **Skip macros** (entire token stream skipped): `orbit_log`, `log_warn` (both from
  `src-tauri/src/log_macros.rs`), `println`, `eprintln`, `print`, `eprint`, `dbg`,
  `info`, `warn`, `error`, `debug`, `trace` (log-crate style, if present).
- **Format-family** (§5.3 applies): `format`, `format_args`, `panic`, `assert`, `assert_eq`,
  `assert_ne`, `todo`, `unimplemented`, `unreachable`, `write`, `writeln`.
- **Any other macro** containing CJK literals: literals are extracted as `rust-str`, and the
  extraction emits a review-needed candidate `custom-macro` (never guess whether it is UI or log).

Inside a format-family macro's token stream, only the **first top-level string literal** is
format-parsed (it is the format string); further CJK literals in the stream are `rust-str` and
are flagged for review if they contain `{` or `}`.

### 5.2 `rust-str` / `rust-raw`

Plain (possibly `\`-line-continued) string literal with CJK and no format placeholders →
`rust-str`. Raw literal (`r"…"`, `r#"…"#`, …) with CJK and no placeholders → `rust-raw`.
Normalized = NFC(cooked value). Cooking applies escapes (`\n`, `\t`, `\\`, `\"`, `\u{…}`, `\x…`)
and line continuations (`\` + newline + following whitespace removed) exactly as rustc does
(syn `LitStr::value()`).

Char literals with CJK are skipped and flagged `cjk-char-literal` for review (potential class-B
logic on a single character).

### 5.3 `rust-format`

A CJK literal in format-string position (§5.1) whose cooked value contains placeholders.
Rust forbids mixing implicit and explicit positional args, so each string is one of:
all-implicit (`{}`, `{:?}`), all-explicit/named (`{0}`, `{source}`, `{0:>5}`), or argumentless.

Normalization: placeholders in order of appearance become `{0}`, `{1}`, …; `placeholders[N]`
stores the **original token** (`{}`, `{:?}`, `{name}`, `{0:>5}`). `{{`/`}}` stay verbatim.

Apply emission: for each `{N}` in the translation:

- original `{}` or `{:5}`-style positional → emit `{N<spec>}` (explicit index + preserved spec
  suffix, e.g. `{0:?}`, `{1:>5}`) — this keeps reordering safe;
- original named/captured (`{source}`) → emit `{source}` verbatim (name-bound; reordering safe).

### 5.4 Rust skips

- Everything inside any `#[…]` attribute (incl. doc comments; they are attributes in syn).
- Skip macros (§5.1) entirely.
- `in_test: true` for any entry inside a module whose attributes contain `cfg(test)` (including
  `cfg(all(test, …))`), transitively.

### 5.5 Rust hints

`fn:<name>` (nearest enclosing function/method), `+macro:<name>` when inside a macro,
`+field:<name>` for struct-literal fields, `+arm` inside match arms.

## 6. Apply (rewrite) semantics — both tools

Never regex. The rewriter receives the original file text plus a set of
`(span → replacement)` edits produced from the translation memory; edits form a tree by
containment; splicing renders outer edits with inner edits applied inside original slices.
Edits never partially overlap (an assertion kills the run if they do).

- **TS `string`/`jsx-attr`**: replace the literal with a new literal using the original quote
  character; escape `\`, the quote, and newlines (`\n`), tabs (`\t`), other control chars
  (`\uXXXX`).
- **TS `template`**: emit `` `…{N}…` `` with `{N}` → `` ${`` + original expression source + `` }``;
  escape `` ` `` as ``\` `` and `${` as `$\{` in translated text.
- **TS `jsx-text`**: replace the text span with the translated text verbatim, escaping a literal
  `{` → `{'{'}` and `}` → `{'}'}` if ever present.
- **TS `jsx-group`**: rebuild the children span: text runs verbatim (as above), `{N}` → `{`
  + original expression source (with nested edits applied) + `}`, `<N>` → original open-tag
  source slice (with nested attribute edits applied) + translated inner + original close-tag
  slice.
- **Rust literals**: always emit a normal escaped literal (`"` delimited; `\` `"` `\n` `\r` `\t`,
  other control chars as `\u{…}`; raw originals are re-emitted as normal literals —
  semantically identical).
- Idempotency: after apply, extraction of the rewritten file yields the same entry ids for every
  still-Chinese (denylisted) entry and no new entries; translated spans contain no CJK.

## 6a. Logic context (Phase 2) and deny handling

Occurrences may carry a `logic` field describing a match/comparison position:

- TS: `method-arg` (`.includes/.startsWith/.endsWith/.indexOf/.match/.test`
  argument; `receiver` = receiver source, `known` flag), `compare`, `case`,
  `object-key`, `index`; unknown method args are recorded with `known:false`
  and are NOT logic.
- Rust: `method-arg` (`.contains/.starts_with/.ends_with/.find/.rfind`),
  `compare` (`==`/`!=`), `match-arm`; `matches!` is not inert (flagged).

Denylist (`l10n/data/denylist.json`):

- `ids` — never translate the entry anywhere.
- `occurrences` — `[{file, line}]` — deny only that occurrence (rust-tool
  `--deny-occ`); used when an external-text check shares its id with UI text.

Pinned fragments (`l10n/data/pinned.json`): class-B fragments carry M-sets
(messages containing F), pin layout `{P1}` (longest fragment first), and
`deps` (fragment-in-fragment chains). Invariant: the outer fragment's English
must contain the inner fragment's English verbatim (case-sensitive), and
every M_en must contain each pinned F_en.

## 7. Determinism

- File iteration: sorted POSIX paths (`src/**/*.{ts,tsx}` for ts-tool, `src-tauri/src/**/*.rs`
  for rust-tool, excluding `target/`).
- Same input tree + same translation memory ⇒ byte-identical output tree.
- All counters/orderings are document-order; JSON shapes as §1.
