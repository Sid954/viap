# Phase 1 Report — String extraction (upstream v1.3.2)

**Date:** 2026-10-24 · **Tier used:** expensive/reasoning (as planned)

## Deliverables

| Path | What |
|---|---|
| `l10n/SPEC.md` | the contract: normalization, ids, 8 kinds, skip lists, apply semantics, determinism rules |
| `l10n/lib/` | `cjk.mjs` (ranges), `id.mjs` (sha1[0:16]), `normalize.mjs` (Babel/React JSX whitespace, JS escaping) |
| `l10n/ts-tool/` | extract + rewrite for `.ts/.tsx` (TypeScript compiler API); span-tree splicer, never regex |
| `l10n/rust-tool/` | Cargo crate (syn 2, proc-macro2 span-locations, sha1): extract + rewrite for `.rs` |
| `l10n/extract.mjs` | unified driver: runs both tools, merges by id → one corpus |
| `l10n/tests/` | fixture suite (`run.mjs` incl. cross-tool id agreement), `identity-roundtrip.mjs`, `fixtures/` |
| `l10n/package.json` | single dependency: typescript 5.9.3 (as planned) |

Corpus artifact (generated, gitignored): `.l10n-work/corpus-v1.3.2.json`.

## Entry counts (real numbers)

| Metric | Value |
|---|---|
| TS files scanned / entries | 47 / 720 |
| Rust files scanned / entries | 44 / 586 |
| **Unified corpus entries** | **1306** |
| Shared by both tools (same id) | 84 — these include the class-A hazard strings (e.g. `用户取消了迁移` = `string`+`rust-str`, `微信`, `系统目录` danger categories) |
| in_test entries | 115 (Rust `#[cfg(test)]`) |

By kind: string 390 · rust-str 347 · rust-format 238 · jsx-group 118 · jsx-text 138 · template 125 · jsx-attr 56 · rust-raw 1.
(Plan's estimate "≈800 TS / ≈700 Rust lines of strings" → 720 TS / 586 Rust *entries*; same order of magnitude, entries ≠ lines.)

**Review items emitted by the tools: 0.** `vec!` / `lazy_static!` were initially flagged as
custom macros and are now on an inert list (extracted, not flagged); the log skip list is
`orbit_log, log_warn` (verified by reading `src-tauri/src/log_macros.rs`) + `println, eprintln,
print, eprint, dbg, info, warn, error, debug, trace, macro_rules`. Format family: `format,
format_args, panic, assert, assert_eq, assert_ne, todo, unimplemented, unreachable, write, writeln`.

## Required samples (all verified present)

- **jsx-group ≥2:** `发现 <1>{0}</1> 个联接候选{1}<2>扫描 {2} 个目录 · 跳过 {3} 个 · 耗时 {4} ms</2>` (`LinkRecoveryModal.tsx:461`, id `475a8580d8f43dda`) — includes a nested group inside expression `{1}` (`其中 {0} 条已有记录`, its own entry); `UserManual.tsx` inline-code groups: `<1>Windows 系统目录：</1>Windows、System32、WinSXS 等系统核心目录…`, `<1>替换阶段：</1>删除原始文件夹后创建目录链接`.
- **template with nested ternary ≥2:** `批量迁移 ({0}/{1}) — {2}` (ph `{2}` = `ke?.display_name||""`), `其他盘{0}` (ph `{0}` = ``Mt.length>0?` (${Mt.join("/")})`:""``). Plus the nested-literal case `` `    · [{0}] {1}{2}` `` whose only CJK is the nested ternary string `（归属待确认）` (extracted as its own `string` entry; the template itself is CJK-free → correctly not an entry per SPEC §2).
- **rust-format multi-arg ≥2:** `迁移成功！应用已从 {0} 迁移到 {1}` (`migration/mod.rs:187`); `检测到以下程序正在运行，请关闭后重试：\n{0}\n\n恢复前必须关闭相关程序，否则文件移动可能失败并导致数据损坏。`
- **`\`-continued string:** the one above (`folder_manager/mod.rs:506`, two-line continuation cooked into one entry); siblings in `migration/links.rs:29,35` and `migration/copy_engine.rs:326`.
- Denylist candidates located as entries: `拒绝访问` (rust-str), `需要提升` (rust-str), `卸载` (multiple entries; classification is Phase 2).
- 10-per-kind sample dump: `.l10n-work/samples.json` (deterministic first-10 per kind, not random, for reproducibility).

## Fixture suite — TS and Rust compute identical ids

- `node l10n/tests/run.mjs` → **8 passed**: JSX whitespace vectors (incl. the whitespace-only-piece regression), id determinism, **5 cross-tool cases** where the same logical string in TS and Rust contexts yields the same id and placeholder keys (`发生错误`; `已迁移 {0} 个应用`; `从 {0} 迁移到 {1}`; `复制 {0} 失败（错误码 {1}）`; `注意：`), and the ts scenario (kinds, skips, identity-rewrite id stability).
- `cargo test -p l10n-rust-tool` → **9 passed**: proc-macro2 column semantics with CJK prefixes (proved column counts **chars**, so `LineIndex` walks chars), format parse/emit (implicit two-arg reorder-safety, `{:?}`/named/`{{}}` escapes, explicit indices kept verbatim), continuation+raw cooking, in_test propagation, skip macros, custom-macro flagging, apply emitting explicit indices.
- Cross-tool agreement is enforced by construction in `extract.mjs`: placeholder key mismatch across tools would raise a `placeholder-mismatch` review item (none occurred on the real tree).

## Real-tree verification

- **Identity round-trip** (`node l10n/tests/identity-roundtrip.mjs`): copy of `src/` + `src-tauri/`, apply with translations ≡ source, re-extract → **1306 ids stable, occurrence counts unchanged**. The identity apply rewrote 24/46 TS + 32/44 Rust files (files with no CJK, or whose CJK strings only appear in kinds that normalize identically, are unchanged).
- **Determinism:** two consecutive extractions → identical SHA-256 of `corpus.json`.
- Residue definition for Phase 4: after a real translation apply, remaining CJK in code must map 1:1 to denylist/review items (Phase 6 test 5/7).

## Findings worth recording

1. **TS scanner gap behavior**: same-line spaces after `}` / `</tag>` live outside AST nodes; React renders them. Normalization prepends the raw gap slice to each text piece (SPEC §4.3). Without this, boundary spaces are lost and ids churn.
2. **Whitespace-only text pieces**: the join-space rule must not fire when there is no later non-empty line (fixed; regression vector in the suite).
3. **Bundle exclusion**: the first run walked `dist/assets/index-*.js` (the built bundle — `.js` matched the filter) adding 212 junk entries; ts-tool now accepts `.ts/.tsx` only and skips `dist`-like dirs (SPEC §1).
4. proc-macro2 fallback spans: `column` counts Unicode chars, `line` is 1-based; byte offsets are recovered via a char-walking `LineIndex` (proven by test).
5. `minified-bundle pollution` aside, upstream `src/` holds 46 `.ts/.tsx` files with CJK (plan estimated ~42).

## Phase 1 evidence checklist

- [x] Entry counts per file type reported (real numbers above)
- [x] Ten samples per kind (`samples.json`) incl. required: 2+ jsx-group, 2+ nested-ternary template, 2+ rust-format multi-arg, the `\`-continued string
- [x] Fixture suite proving identical ids across tools (5 cross-tool cases, all kinds)
- [x] Unified corpus: 1306 entries, 84 shared, 0 review items
- [x] Bonus beyond the phase: identity round-trip + determinism on the real tree (formally Phase 4/6 criteria, already green)
