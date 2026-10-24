// Extraction + rewrite of Rust sources per l10n/SPEC.md §5.
use crate::fmt::{emit_format, parse_format};
use crate::util::{corpus_id, escape_rust_literal, has_cjk, is_cjk, nfc, LineIndex};
use proc_macro2::{TokenStream, TokenTree};
use quote::ToTokens;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use syn::spanned::Spanned;
use syn::visit::Visit;
use syn::{File, ImplItemFn, ItemFn, ItemMod, Lit, LitStr, Macro};

pub const SKIP_MACROS: &[&str] = &[
    "orbit_log", "log_warn", // src-tauri/src/log_macros.rs
    "println", "eprintln", "print", "eprint", "dbg", "macro_rules",
    "info", "warn", "error", "debug", "trace", // log-crate style, if present
];

pub const FORMAT_FAMILY: &[&str] = &[
    "format", "format_args", "panic", "assert", "assert_eq", "assert_ne",
    "todo", "unimplemented", "unreachable", "write", "writeln",
];

/// Inert data macros: contents extracted normally but never flagged for
/// review (they hold data, not logging). `matches!` is NOT inert — its
/// pattern literals are exact-match logic (class A) and get reviewed.
pub const INERT_MACROS: &[&str] = &["vec", "lazy_static", "boxed"];

/// Methods whose string argument is matched against other text (Phase 2 B).
pub const LOGIC_METHODS: &[&str] = &["contains", "starts_with", "ends_with", "find", "rfind"];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum LogicInfo {
    MethodArg { method: String, receiver: String, known: bool },
    Compare { op: String },
    MatchArm,
}

#[derive(Clone, Debug)]
enum PendingLogic {
    /// literals whose span falls inside the region get `info`
    Region {
        start: proc_macro2::LineColumn,
        end: proc_macro2::LineColumn,
        info: LogicInfo,
    },
    /// literals in the current pattern are match arms
    Arm,
}

fn lc_le(a: proc_macro2::LineColumn, b: proc_macro2::LineColumn) -> bool {
    a.line < b.line || (a.line == b.line && a.column <= b.column)
}

fn region_contains(
    r: (proc_macro2::LineColumn, proc_macro2::LineColumn),
    s: (proc_macro2::LineColumn, proc_macro2::LineColumn),
) -> bool {
    lc_le(r.0, s.0) && lc_le(s.1, r.1)
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Occurrence {
    pub file: String,
    pub line: usize,
    pub col: usize,
    pub start: usize, // byte offsets
    pub end: usize,
    pub tool: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logic: Option<LogicInfo>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Entry {
    pub id: String,
    pub source: String,
    pub kinds: Vec<String>,
    pub hint: String,
    pub placeholders: BTreeMap<String, String>,
    pub in_test: bool,
    pub occurrences: Vec<Occurrence>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ReviewItem {
    pub item: String,
    pub file: String,
    pub line: usize,
    pub detail: String,
}

#[derive(Clone, Debug)]
struct Edit {
    start: usize, // byte offset
    end: usize,
    text: String,
}

pub struct Extractor<'a> {
    text: &'a str,
    rel_path: String,
    line_index: LineIndex<'a>,
    pub entries: BTreeMap<String, Entry>,
    pub review: Vec<ReviewItem>,
    fn_stack: Vec<String>,
    macro_stack: Vec<String>,
    in_test: bool,
    pending_logic: Option<PendingLogic>,
    tm: Option<&'a HashMap<String, String>>,
    deny: Option<&'a HashSet<String>>,
    deny_occ: Option<&'a HashSet<(String, usize)>>, // (file, line) occurrence denies
    pub edits: Vec<Edit>,
}

pub struct ExtractResult {
    pub entries: Vec<Entry>,
    pub review: Vec<ReviewItem>,
    pub changed: bool,
    pub new_text: Option<String>,
}

fn collect_idents(tts: &TokenStream, out: &mut Vec<String>) {
    for tt in tts.clone().into_iter() {
        match tt {
            TokenTree::Ident(i) => out.push(i.to_string()),
            TokenTree::Group(g) => collect_idents(&g.stream(), out),
            _ => {}
        }
    }
}

fn cfg_is_test(mod_attrs: &[syn::Attribute]) -> bool {
    for attr in mod_attrs {
        if !attr.path().is_ident("cfg") {
            continue;
        }
        let mut idents = Vec::new();
        collect_idents(&attr.to_token_stream(), &mut idents);
        // [test], [all, test, ..], [any, test, ..] → true; [not, test] → false
        if idents.first().map(|s| s.as_str()) == Some("not") {
            continue;
        }
        if idents.iter().any(|s| s == "test") {
            return true;
        }
    }
    false
}

impl<'a> Extractor<'a> {
    pub fn new(
        text: &'a str,
        rel_path: &str,
        tm: Option<&'a HashMap<String, String>>,
        deny: Option<&'a HashSet<String>>,
        deny_occ: Option<&'a HashSet<(String, usize)>>,
    ) -> Self {
        Extractor {
            text,
            rel_path: rel_path.to_string(),
            line_index: LineIndex::new(text),
            entries: BTreeMap::new(),
            review: Vec::new(),
            fn_stack: Vec::new(),
            macro_stack: Vec::new(),
            in_test: false,
            pending_logic: None,
            tm,
            deny,
            deny_occ,
            edits: Vec::new(),
        }
    }

    fn hint(&self) -> String {
        let mut parts = Vec::new();
        if let Some(f) = self.fn_stack.last() {
            parts.push(format!("fn:{}", f));
        }
        if let Some(m) = self.macro_stack.last() {
            parts.push(format!("macro:{}", m));
        }
        parts.join("+")
    }

    fn handle_str_literal(&mut self, s: &LitStr, format_position: bool) {
        let cooked = s.value();
        if !has_cjk(&cooked) {
            return;
        }
        let parsed = if format_position {
            Some(parse_format(&cooked))
        } else {
            None
        };
        let has_placeholders = parsed
            .as_ref()
            .map(|p| !p.placeholders.is_empty())
            .unwrap_or(false);

        let span = s.span();
        let start = self.line_index.offset(span.start().line, span.start().column);
        let end = self.line_index.offset(span.end().line, span.end().column);
        let raw = {
            let at = &self.text[start..];
            at.starts_with("r\"") || at.starts_with("r#") || at.starts_with("br\"") || at.starts_with("br#")
        };

        let kind = if format_position && has_placeholders {
            "rust-format"
        } else if raw {
            "rust-raw"
        } else {
            "rust-str"
        };

        // non-format-position literals with braces are ambiguous → review
        if !format_position && (cooked.contains('{') || cooked.contains('}')) {
            self.review.push(ReviewItem {
                item: "braces-in-rust-str".to_string(),
                file: self.rel_path.clone(),
                line: span.start().line,
                detail: format!("literal outside format position contains braces: {:?}", cooked),
            });
        }

        let (normalized, placeholders) = match parsed {
            Some(p) => (p.normalized, p.placeholders),
            None => (nfc(&cooked), BTreeMap::new()),
        };
        let normalized = nfc(&normalized);
        let id = corpus_id(&normalized);

        let hint = self.hint();
        let logic = match &self.pending_logic {
            Some(PendingLogic::Region { start, end, info })
                if region_contains((*start, *end), (span.start(), span.end())) =>
            {
                Some(info.clone())
            }
            Some(PendingLogic::Arm) => Some(LogicInfo::MatchArm),
            _ => None,
        };
        let occ = Occurrence {
            file: self.rel_path.clone(),
            line: span.start().line,
            col: span.start().column + 1,
            start,
            end,
            tool: "rust",
            logic,
        };
        let entry = self.entries.entry(id.clone()).or_insert_with(|| Entry {
            id: id.clone(),
            source: normalized.clone(),
            kinds: Vec::new(),
            hint: String::new(),
            placeholders: placeholders.clone(),
            in_test: self.in_test,
            occurrences: Vec::new(),
        });
        if !entry.kinds.contains(&kind.to_string()) {
            entry.kinds.push(kind.to_string());
        }
        if !hint.is_empty() && !entry.hint.contains(&hint) {
            entry.hint = if entry.hint.is_empty() {
                hint.clone()
            } else {
                format!("{} | {}", entry.hint, hint)
            };
        }
        if self.in_test {
            entry.in_test = true;
        }
        entry.occurrences.push(occ);
        entry
            .occurrences
            .sort_by(|a, b| a.file.cmp(&b.file).then(a.start.cmp(&b.start)));

        // rewrite mode
        if let (Some(tm), Some(deny)) = (self.tm, self.deny) {
            if !deny.contains(&id) {
                let occurrence_denied = self
                    .deny_occ
                    .map(|d| d.contains(&(self.rel_path.clone(), span.start().line)))
                    .unwrap_or(false);
                if !occurrence_denied {
                    if let Some(translated) = tm.get(&id) {
                        let body = if kind == "rust-format" {
                            emit_format(translated, &placeholders)
                        } else {
                            translated.clone()
                        };
                        self.edits.push(Edit {
                            start,
                            end,
                            text: format!("\"{}\"", escape_rust_literal(&body)),
                        });
                    }
                }
            }
        }
    }

    /// Walk macro token trees. `allow_format_position` is true only for the
    /// direct children of a format-family macro stream (depth 0).
    fn walk_tokens(&mut self, tts: &TokenStream, allow_format_position: bool) -> usize {
        let mut cjk_literals = 0usize;
        let mut format_taken = false;
        // Token-level attributes are skipped — including doc comments, which
        // proc-macro2 renders as `#[doc = "…"]` inside macro bodies (SPEC
        // §5.4: comments are never translated).
        let trees: Vec<TokenTree> = tts.clone().into_iter().collect();
        let mut i = 0;
        while i < trees.len() {
            match &trees[i] {
                TokenTree::Punct(p) if p.as_char() == '#' => {
                    let mut j = i + 1;
                    if j < trees.len() {
                        if let TokenTree::Punct(b) = &trees[j] {
                            if b.as_char() == '!' {
                                j += 1;
                            }
                        }
                    }
                    if j < trees.len() {
                        if let TokenTree::Group(g) = &trees[j] {
                            if g.delimiter() == proc_macro2::Delimiter::Bracket {
                                i = j + 1;
                                continue;
                            }
                        }
                    }
                    i += 1;
                }
                TokenTree::Literal(lit) => {
                    if let Lit::Str(s) = syn::Lit::new(lit.clone()) {
                        let is_fmt_pos = allow_format_position && !format_taken;
                        if is_fmt_pos {
                            format_taken = true;
                        }
                        if has_cjk(&s.value()) {
                            cjk_literals += 1;
                        }
                        self.handle_str_literal(&s, is_fmt_pos);
                    }
                }
                TokenTree::Group(g) => {
                    cjk_literals += self.walk_tokens(&g.stream(), false);
                }
                _ => {}
            }
            i += 1;
        }
        cjk_literals
    }
}

impl<'a> Visit<'a> for Extractor<'_> {
    // SPEC §5.4: skip all attributes (incl. doc comments)
    fn visit_attribute(&mut self, _i: &'a syn::Attribute) {}

    fn visit_item_fn(&mut self, i: &'a ItemFn) {
        self.fn_stack.push(i.sig.ident.to_string());
        syn::visit::visit_item_fn(self, i);
        self.fn_stack.pop();
    }

    fn visit_impl_item_fn(&mut self, i: &'a ImplItemFn) {
        self.fn_stack.push(i.sig.ident.to_string());
        syn::visit::visit_impl_item_fn(self, i);
        self.fn_stack.pop();
    }

    fn visit_item_mod(&mut self, i: &'a ItemMod) {
        let saved = self.in_test;
        if cfg_is_test(&i.attrs) {
            self.in_test = true;
        }
        syn::visit::visit_item_mod(self, i);
        self.in_test = saved;
    }

    fn visit_macro(&mut self, mac: &Macro) {
        let name = mac
            .path
            .segments
            .last()
            .map(|s| s.ident.to_string())
            .unwrap_or_default();
        if SKIP_MACROS.iter().any(|m| *m == name) {
            return;
        }
        if FORMAT_FAMILY.iter().any(|m| *m == name) {
            self.macro_stack.push(name.clone());
            self.walk_tokens(&mac.tokens, true);
            self.macro_stack.pop();
        } else {
            // custom macro: never guess whether UI or log → extract + review
            self.macro_stack.push(name.clone());
            let found = self.walk_tokens(&mac.tokens, false);
            self.macro_stack.pop();
            if found > 0 && !INERT_MACROS.iter().any(|m| *m == name) {
                self.review.push(ReviewItem {
                    item: "custom-macro".to_string(),
                    file: self.rel_path.clone(),
                    line: mac.path.span().start().line,
                    detail: format!("custom macro `{}` contains {} CJK literal(s); classify manually (UI text vs log)", name, found),
                });
            }
        }
    }

    fn visit_expr_method_call(&mut self, i: &'a syn::ExprMethodCall) {
        let method = i.method.to_string();
        let known = LOGIC_METHODS.contains(&method.as_str());
        let receiver_src = i.receiver.to_token_stream().to_string();
        let args_region = match (i.args.first(), i.args.last()) {
            (Some(f), Some(l)) => Some((f.span().start(), l.span().end())),
            _ => None,
        };
        let saved = self.pending_logic.take();
        syn::visit::visit_expr(self, &i.receiver);
        self.pending_logic = args_region.map(|(s, e)| PendingLogic::Region {
            start: s,
            end: e,
            info: LogicInfo::MethodArg {
                method: method.clone(),
                receiver: receiver_src.clone(),
                known,
            },
        });
        for arg in &i.args {
            syn::visit::visit_expr(self, arg);
        }
        self.pending_logic = saved;
    }

    fn visit_expr_binary(&mut self, i: &'a syn::ExprBinary) {
        let op = match &i.op {
            syn::BinOp::Eq(_) => "==",
            syn::BinOp::Ne(_) => "!=",
            _ => {
                syn::visit::visit_expr_binary(self, i);
                return;
            }
        };
        let saved = self.pending_logic.take();
        let info = LogicInfo::Compare {
            op: op.to_string(),
        };
        self.pending_logic = Some(PendingLogic::Region {
            start: i.left.span().start(),
            end: i.left.span().end(),
            info: info.clone(),
        });
        syn::visit::visit_expr(self, &i.left);
        self.pending_logic = Some(PendingLogic::Region {
            start: i.right.span().start(),
            end: i.right.span().end(),
            info,
        });
        syn::visit::visit_expr(self, &i.right);
        self.pending_logic = saved;
    }

    fn visit_arm(&mut self, i: &'a syn::Arm) {
        let saved = self.pending_logic.take();
        self.pending_logic = Some(PendingLogic::Arm);
        syn::visit::visit_pat(self, &i.pat);
        self.pending_logic = None;
        if let Some((_, g)) = &i.guard {
            syn::visit::visit_expr(self, g);
        }
        syn::visit::visit_expr(self, &i.body);
        self.pending_logic = saved;
    }

    fn visit_lit(&mut self, i: &Lit) {
        match i {
            Lit::Str(s) => {
                self.handle_str_literal(s, false);
            }
            Lit::Char(c) => {
                if is_cjk(c.value()) {
                    self.review.push(ReviewItem {
                        item: "cjk-char-literal".to_string(),
                        file: self.rel_path.clone(),
                        line: c.span().start().line,
                        detail: format!("CJK char literal {:?} — potential single-char logic match", c.value()),
                    });
                }
            }
            _ => {}
        }
        // literals are leaves — no descent
    }
}

/// Extract (and optionally rewrite) one source file.
pub fn process_source(
    text: &str,
    rel_path: &str,
    tm: Option<&HashMap<String, String>>,
    deny: Option<&HashSet<String>>,
    deny_occ: Option<&HashSet<(String, usize)>>,
) -> ExtractResult {
    let ast: File = match syn::parse_file(text) {
        Ok(f) => f,
        Err(e) => {
            return ExtractResult {
                entries: Vec::new(),
                review: vec![ReviewItem {
                    item: "parse-error".to_string(),
                    file: rel_path.to_string(),
                    line: e.span().start().line,
                    detail: format!("syn parse failed: {}", e),
                }],
                changed: false,
                new_text: None,
            };
        }
    };
    let mut ex = Extractor::new(text, rel_path, tm, deny, deny_occ);
    ex.visit_file(&ast);

    let changed = !ex.edits.is_empty();
    let new_text = if changed {
        let mut edits = ex.edits.clone();
        edits.sort_by(|a, b| b.start.cmp(&a.start));
        for i in 1..edits.len() {
            if edits[i - 1].start < edits[i].end {
                panic!("overlapping rust edits in {}", rel_path);
            }
        }
        let mut t = text.to_string();
        for e in &edits {
            t.replace_range(e.start..e.end, &e.text);
        }
        Some(t)
    } else {
        None
    };

    ExtractResult {
        entries: ex.entries.into_values().collect(),
        review: ex.review,
        changed,
        new_text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find_entry<'x>(r: &'x ExtractResult, needle: &str) -> &'x Entry {
        r.entries.iter().find(|e| e.source.contains(needle)).expect(needle)
    }

    #[test]
    fn span_offsets_with_cjk_prefix() {
        // CJK chars before the literal on the same line: proves whether
        // proc-macro2's fallback column counts chars (spec'd) or bytes.
        let src = "fn f() { let a = \"中文提示\"; let b = \"目标字符串\"; }\n";
        let r = process_source(src, "t.rs", None, None, None);
        let e = find_entry(&r, "目标字符串");
        let occ = &e.occurrences[0];
        let expect_start = src.find("\"目标字符串\"").unwrap();
        assert_eq!(occ.start, expect_start, "col semantics mismatch");
        assert_eq!(&src[occ.start..occ.end], "\"目标字符串\"");
        assert_eq!(occ.line, 1);
        assert_eq!(occ.col, src[..expect_start].chars().count() + 1);
    }

    #[test]
    fn format_implicit_and_skip_logs() {
        let src = r#"
fn migrate(source: &str, target: &str) -> Result<()> {
    orbit_log!("INFO", "mod", "迁移开始 {} -> {}", source, target);
    let msg = format!("迁移成功！应用已从 {} 迁移到 {}", source, target);
    let plain = "纯文本消息";
    eprintln!("调试信息 {}", msg);
    Ok(())
}
"#;
        let r = process_source(src, "t.rs", None, None, None);
        assert!(!r.entries.iter().any(|e| e.source.contains("迁移开始")), "orbit_log skipped");
        assert!(!r.entries.iter().any(|e| e.source.contains("调试信息")), "eprintln skipped");
        let f = find_entry(&r, "迁移成功");
        assert_eq!(f.source, "迁移成功！应用已从 {0} 迁移到 {1}");
        assert_eq!(f.placeholders["0"], "{}");
        assert_eq!(f.kinds, vec!["rust-format".to_string()]);
        assert!(f.hint.contains("fn:migrate"));
        assert!(f.hint.contains("macro:format"));
        assert!(r.entries.iter().any(|e| e.source == "纯文本消息"));
    }

    #[test]
    fn continuation_and_raw() {
        let src = "fn f() -> String {\n    format!(\"检测到以下程序正在运行，请关闭后重试：\\n{}\\n\\n\\\n               如需强制结束，请手动关闭后重试\")\n}\nfn g() { let r = r#\"原始文本\"#; let _ = r; }\n";
        let r = process_source(src, "t.rs", None, None, None);
        assert!(!r.review.iter().any(|x| x.item == "parse-error"), "{:?}", r.review);
        let c = find_entry(&r, "检测到以下程序");
        assert_eq!(c.source, "检测到以下程序正在运行，请关闭后重试：\n{0}\n\n如需强制结束，请手动关闭后重试");
        assert_eq!(c.placeholders["0"], "{}");
        let raw = find_entry(&r, "原始文本");
        assert!(raw.kinds.contains(&"rust-raw".to_string()), "{:?}", raw.kinds);
    }

    #[test]
    fn in_test_and_named_args() {
        let src = "#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {\n        let m = format!(\"来源 {source} 失败：{err}\", source = \"s\", err = \"e\");\n        assert!(m.contains(\"失败\"));\n    }\n}\n";
        let r = process_source(src, "t.rs", None, None, None);
        assert!(!r.review.iter().any(|x| x.item == "parse-error"), "{:?}", r.review);
        let e = find_entry(&r, "来源");
        assert_eq!(e.source, "来源 {0} 失败：{1}");
        assert_eq!(e.placeholders["0"], "{source}");
        assert_eq!(e.placeholders["1"], "{err}");
        assert!(e.in_test);
        let frag = r.entries.iter().find(|e| e.source == "失败").expect("exact 失败");
        assert!(frag.kinds.contains(&"rust-str".to_string()));
    }

    #[test]
    fn custom_macro_flagged_and_rewrite() {
        let src = "fn h() { custom_banner!(\"自定义宏消息 {}\", 1); let plain = \"普通\"; }";
        let r = process_source(src, "t.rs", None, None, None);
        assert!(!r.review.iter().any(|x| x.item == "parse-error"), "{:?}", r.review);
        assert!(r.review.iter().any(|rv| rv.item == "custom-macro"));
        assert!(r.review.iter().any(|rv| rv.item == "braces-in-rust-str"));
        // custom-macro literals are rust-str: braces stay literal, no {N} parse
        assert!(r.entries.iter().any(|e| e.source == "自定义宏消息 {}"));

        // rewrite: custom macro literal is rust-str (no placeholder parse)
        let mut tm = HashMap::new();
        let id = corpus_id("普通");
        tm.insert(id.clone(), "Normal".to_string());
        let r2 = process_source(src, "t.rs", Some(&tm), Some(&HashSet::new()), None);
        assert!(r2.changed);
        let t = r2.new_text.unwrap();
        assert!(t.contains("\"Normal\""), "{}", t);
        assert!(t.contains("自定义宏消息"));
    }

    #[test]
    fn occurrence_level_deny() {
        let src = "fn f(name: &str) -> bool {
    name.contains(\"卸载\")
}
fn g() -> String {
    \"卸载\".to_string()
}
";
        let mut tm = HashMap::new();
        tm.insert(corpus_id("卸载"), "Uninstall".to_string());
        let mut deny_occ = HashSet::new();
        deny_occ.insert(("t.rs".to_string(), 2usize));
        let r = process_source(src, "t.rs", Some(&tm), Some(&HashSet::new()), Some(&deny_occ));
        let t = r.new_text.unwrap();
        assert!(t.contains("name.contains(\"卸载\")"), "denied occurrence stays Chinese: {}", t);
        assert!(t.contains("\"Uninstall\".to_string()"), "other occurrence translated: {}", t);
    }

    use std::collections::HashSet as StdHashSet;
    #[test]
    fn logic_context_detection() {
        let src = "fn f(location_label: &str, e: &str, x: &str) -> bool {\n    let is_install = location_label == \"安装目录\";\n    let denied = e.contains(\"拒绝访问\");\n    let r = match x { \"浏览器\" => true, _ => false };\n    is_install && denied && r\n}\n";
        let r = process_source(src, "t.rs", None, None, None);
        assert!(!r.review.iter().any(|x| x.item == "parse-error"), "{:?}", r.review);
        let cmp = r.entries.iter().find(|e| e.source == "安装目录").unwrap();
        assert!(cmp.occurrences.iter().any(|o| matches!(o.logic, Some(LogicInfo::Compare { .. }))));
        let c = r.entries.iter().find(|e| e.source == "拒绝访问").unwrap();
        let has_contains = c.occurrences.iter().any(|o| {
            matches!(&o.logic,
                Some(LogicInfo::MethodArg { method, receiver, known: true })
                if method == "contains" && receiver.contains("e"))
        });
        assert!(has_contains);
        let m = r.entries.iter().find(|e| e.source == "浏览器").unwrap();
        assert!(m.occurrences.iter().any(|o| matches!(o.logic, Some(LogicInfo::MatchArm))));
    }

    #[test]
    fn matches_macro_flagged_not_inert() {
        let src = "fn f(l: &str) -> bool { matches!(l, \"安装目录\") }";
        let r = process_source(src, "t.rs", None, None, None);
        assert!(r.review.iter().any(|x| x.item == "custom-macro"));
        assert!(r.entries.iter().any(|e| e.source == "安装目录"));
    }

    #[test]
    fn rewrite_format_emits_explicit_indices() {
        let src = "fn f(a: &str, b: &str) { let m = format!(\"从{}迁移到{}\", a, b); }";
        let parsed_entry = {
            let r = process_source(src, "t.rs", None, None, None);
            r.entries.into_iter().next().unwrap()
        };
        let mut tm = HashMap::new();
        tm.insert(parsed_entry.id.clone(), "Migrated from {0} to {1}".to_string());
        let r = process_source(src, "t.rs", Some(&tm), Some(&StdHashSet::new()), None);
        let t = r.new_text.unwrap();
        assert!(t.contains("format!(\"Migrated from {0} to {1}\", a, b)"), "{}", t);
    }
}
