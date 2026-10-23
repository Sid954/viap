// Shared utilities: CJK detection, corpus ids, escaping, line index.
use sha1::{Digest, Sha1};

/// CJK ranges — MUST match l10n/lib/cjk.mjs (SPEC §2).
pub fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{3000}'..='\u{303F}'
        | '\u{3400}'..='\u{4DBF}'
        | '\u{4E00}'..='\u{9FFF}'
        | '\u{F900}'..='\u{FAFF}'
        | '\u{FF01}'..='\u{FF60}')
}

pub fn has_cjk(s: &str) -> bool {
    s.chars().any(is_cjk)
}

pub fn nfc(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    s.nfc().collect::<String>()
}

/// id = first 16 hex chars of sha1(utf8(NFC(normalized))) — SPEC §1.
pub fn corpus_id(normalized: &str) -> String {
    let mut h = Sha1::new();
    h.update(nfc(normalized).as_bytes());
    hex::encode(h.finalize())[..16].to_string()
}

/// Escape into a normal double-quoted Rust literal body (SPEC §6).
pub fn escape_rust_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\u{{{:x}}}", c as u32))
            }
            c => out.push(c),
        }
    }
    out
}

/// Byte offset of a (line, column) proc-macro2 LineColumn.
/// `column` in the fallback span engine counts Unicode scalar values
/// (verified by unit test line_index_counts_chars); this helper walks chars.
pub struct LineIndex<'a> {
    text: &'a str,
    line_starts: Vec<usize>, // byte offset of each line start
}

impl<'a> LineIndex<'a> {
    pub fn new(text: &'a str) -> Self {
        let mut starts = vec![0usize];
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                starts.push(i + 1);
            }
        }
        LineIndex { text, line_starts: starts }
    }

    /// line is 1-based, column is 0-based in chars from proc-macro2 fallback.
    pub fn offset(&self, line: usize, column: usize) -> usize {
        let base = self.line_starts[line - 1];
        let mut off = base;
        let mut remaining = column;
        for c in self.text[base..].chars() {
            if remaining == 0 {
                break;
            }
            off += c.len_utf8();
            remaining -= 1;
        }
        off
    }
}
