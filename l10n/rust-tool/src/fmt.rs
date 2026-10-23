// Rust format-string parse/emit per l10n/SPEC.md §5.3.
// Placeholders are normalized to {N} in order of appearance; the side map
// keeps the original token. Rust forbids mixing implicit and explicit
// positional args, so each string is all-implicit or all-explicit/named.

/// Parses `{{`/`}}`, implicit/explicit/named placeholders with specs.
pub struct ParsedFormat {
    pub normalized: String,
    pub placeholders: std::collections::BTreeMap<String, String>, // "N" -> original token
}

pub fn parse_format(cooked: &str) -> ParsedFormat {
    let mut normalized = String::new();
    let mut placeholders = std::collections::BTreeMap::new();
    let chars: Vec<char> = cooked.chars().collect();
    let mut i = 0;
    let mut n: usize = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '{' {
            if i + 1 < chars.len() && chars[i + 1] == '{' {
                normalized.push_str("{{");
                i += 2;
                continue;
            }
            // find matching '}'
            if let Some(close) = chars[i + 1..].iter().position(|&x| x == '}') {
                let content: String = chars[i + 1..i + 1 + close].iter().collect();
                let token = format!("{{{}}}", content);
                placeholders.insert(n.to_string(), token);
                normalized.push_str(&format!("{{{}}}", n));
                n += 1;
                i += close + 2;
            } else {
                // unbalanced — keep verbatim (extractor flags CJK strings with
                // stray braces via the brace-in-rust-str review rule)
                normalized.push(c);
                i += 1;
            }
        } else if c == '}' && i + 1 < chars.len() && chars[i + 1] == '}' {
            normalized.push_str("}}");
            i += 2;
        } else {
            normalized.push(c);
            i += 1;
        }
    }
    ParsedFormat { normalized, placeholders }
}

/// Classify an original placeholder token into its emission for apply.
/// - implicit `{}` / `{:spec}` → `{N}` / `{N:spec}` (explicit-index upgrade,
///   reorder-safe because N equals the original implicit position)
/// - explicit `{k}` / `{k:spec}` → verbatim index
/// - named `{name}` / `{name:spec}` → verbatim (name-bound, reorder-safe)
fn emit_placeholder(original: &str, n: usize) -> String {
    let inner = original
        .strip_prefix('{')
        .and_then(|s| s.strip_suffix('}'))
        .unwrap_or(original);
    let (name_part, spec_part) = match inner.find(':') {
        Some(idx) => (&inner[..idx], &inner[idx + 1..]),
        None => (inner, ""),
    };
    let spec = if spec_part.is_empty() {
        String::new()
    } else {
        format!(":{}", spec_part)
    };
    if name_part.is_empty() {
        // implicit positional
        format!("{{{}{}}}", n, spec)
    } else {
        // explicit index or named — keep verbatim
        format!("{{{}{}}}", name_part, spec)
    }
}

/// Rebuild a Rust literal body from a translated normalized string.
pub fn emit_format(translated: &str, placeholders: &std::collections::BTreeMap<String, String>) -> String {
    let chars: Vec<char> = translated.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '{' {
            if i + 1 < chars.len() && chars[i + 1] == '{' {
                out.push_str("{{");
                i += 2;
                continue;
            }
            if let Some(close) = chars[i + 1..].iter().position(|&x| x == '}') {
                let key: String = chars[i + 1..i + 1 + close].iter().collect();
                if let Ok(n) = key.parse::<usize>() {
                    if let Some(orig) = placeholders.get(&key) {
                        out.push_str(&emit_placeholder(orig, n));
                        i += close + 2;
                        continue;
                    }
                }
                // unknown placeholder — emit verbatim
                out.push_str(&format!("{{{}}}", key));
                i += close + 2;
                continue;
            }
            out.push(c);
            i += 1;
        } else if c == '}' && i + 1 < chars.len() && chars[i + 1] == '}' {
            out.push_str("}}");
            i += 2;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn implicit_two_args() {
        let p = parse_format("迁移成功！应用已从 {} 迁移到 {}");
        assert_eq!(p.normalized, "迁移成功！应用已从 {0} 迁移到 {1}");
        assert_eq!(p.placeholders["0"], "{}");
        assert_eq!(p.placeholders["1"], "{}");
        assert_eq!(
            emit_format("Migrated! App moved from {0} to {1}", &p.placeholders),
            "Migrated! App moved from {0} to {1}"
        );
        // reordered translation stays correct because indices are explicit
        assert_eq!(
            emit_format("到 {1} 从 {0} 迁移", &p.placeholders),
            "到 {1} 从 {0} 迁移"
        );
    }

    #[test]
    fn spec_and_named_and_escapes() {
        let p = parse_format("失败：{:?}（{source}，代码 {{E{}}}）");
        assert_eq!(p.normalized, "失败：{0}（{1}，代码 {{E{2}}}）");
        assert_eq!(p.placeholders["0"], "{:?}");
        assert_eq!(p.placeholders["1"], "{source}");
        assert_eq!(p.placeholders["2"], "{}");
        let e = emit_format("Failed: {0} ({1}, code {{E{2}}})", &p.placeholders);
        assert_eq!(e, "Failed: {0:?} ({source}, code {{E{2}}})");
    }

    #[test]
    fn explicit_kept_verbatim() {
        let p = parse_format("{0} 大于 {1}");
        assert_eq!(p.placeholders["0"], "{0}");
        assert_eq!(emit_format("{0} gt {1}", &p.placeholders), "{0} gt {1}");
    }
}
