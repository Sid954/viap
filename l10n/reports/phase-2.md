# Phase 2 Report — Logic-literal classification (upstream v1.3.2)

**Date:** 2026-10-24 · **Tier used:** expensive/reasoning (as planned)

Deliverables: `l10n/classify.mjs` (classifier), `l10n/lib/pins.mjs` (pin machinery),
`l10n/data/denylist.json`, `l10n/data/pinned.json`, logic-context emission in both
extractors (`logic` field on occurrences), occurrence-level deny in rust-tool
(`--deny-occ`), `l10n/tests/pin-demo.mjs` (real-fragment demonstration).

Entry classes over the 1306-entry corpus: **U 1292 · A 7 · B 7 · C 2** (+3 occurrence-level C denies).

## The A/B/C occurrence table (all logic sites; auto-generated: `reports/phase-2-table.md`)

### Class C — external text, never translated (denylist)

| literal | site | receiver (what is matched) | decision |
|---|---|---|---|
| `拒绝访问` | `src-tauri/src/migration/mod.rs:628` | `e` — error string from file ops (paired in code with `"Access is denied"`, `"os error 5"` — zh-CN Windows output) | deny id (only occurrence) + review |
| `需要提升` | `src-tauri/src/app_manager/uninstaller.rs:1694` | `normalized` — lowercased error from elevation attempt (Windows "elevation"/"os error 740" companions) | deny id (only occurrence) + review |
| `卸载` | `src-tauri/src/app_manager/uninstaller.rs:2979` | `lower` — lowercased **file name** (uninstaller exe detection, alongside `"unin"`/`"uninstall"`) | deny **occurrence only** — the same id is a UI string at `AppList.tsx:284` and must translate |

Manual receiver review: these are the ONLY three Rust known-method match sites in the
codebase (verified by exhaustive dump of `logic` occurrences); all three receivers are
external (io/error text ×2, file name ×1). No other `.contains/starts_with/ends_with/find`
on external text exists in v1.3.2.

### Class B — substring match on internal (backend-produced) text → pinned fragments

All B sites are TS `.includes()` on backend message strings (receiver `errStr`, `result.message`, `message`, `l`):

| fragment F | match sites | M (containing messages) | notes |
|---|---|---|---|
| `用户取消了迁移` | AppMigration.tsx:1374,1684; LargeFolders.tsx:680,927 | 2 (＋itself excluded) | dep of `取消` |
| `取消` | LinkRecoveryModal.tsx:163 | 15 | nested inside `用户取消了迁移` (dep chain) |
| `检测到以下程序正在运行` | AppMigration.tsx:1342,1591; LargeFolders.tsx:835 | 3 | produced by `folder_manager/mod.rs:506` continuation string |
| `检测到以下程序` | AppMigration.tsx:1346,1593; LargeFolders.tsx:837 | 4 | nested inside the above (dep chain) |
| `仍检测到应用存在` | AppMigration.tsx:1086 | 1 | produced by `uninstaller.rs:1324` |
| `卸载命令执行失败` | AppMigration.tsx:1086 | 1 | produced by `uninstaller.rs:1339` |
| `另一个恢复任务` | MigrationHistory.tsx:581 | 1 | **new find** — not in the plan's hazard list; same mechanism |

### Class A — exact match, translated via shared id (consistency is structural)

| literal | logic sites | production sites | boundary |
|---|---|---|---|
| `系统目录` `浏览器` `GPU驱动` `办公软件` `运行时` `开发工具` | Rust `match` arms `danger_rules.rs:199-204` **and** TS object keys `useDangerousPathCheck.ts:385-390` | `danger_rules.rs` `category:` values (plain) | **cross Rust/TS — same ids, verified in the 84-entry shared set** |
| `安装目录` | `uninstall_snapshot.rs:356,502` `==` | label production (plain occurrences) | Rust-internal |

The plan's "verify, do not assume" check: every A literal has non-logic (production)
occurrences — mechanically enforced by the **logic-only invariant** (an exact-match literal
with no production site is external → C). It fired on zero A entries.

## Pinned-fragment demonstration (`node l10n/tests/pin-demo.mjs`)

For all 7 fragments, with hand-written demo English (real translations come from the
local model in Phase 3), the full pipeline was executed: multi-fragment longest-first
pinning → `{PN}`-keeping "model output" → substitution → containment. Example
(the nested case that matters most):

```
F  = 取消                       F_en = "Cancel"
F′ = 用户取消了迁移              F′_en = "Cancelled by user"   (must ⊇ "Cancel" — dep edge)
M  = 用户取消了迁移（目标路径已存在）
M_pinned  = "{P1}（目标路径已存在）"          ← 取消 consumed by the longer fragment
model     = "Migration was {P1} (the target path already exists)"
M_en      = "Migration was Cancelled by user (the target path already exists)"
M_en.includes(F′_en) ✓   M_en.includes(F_en) ✓   (runtime .includes('取消') → .includes('Cancel') still matches)
```

All 7 fragments pass `M_en.includes(F_en)` after substitution; a deliberately dropped
`{P1}` is caught by `validatePinned` before substitution. The **nested-dependency
invariant** (outer fragment's English must contain the inner fragment's English,
case-sensitively) is asserted and documented — it constrains Phase 3: fragments
translate longest-first, and validators must check dep chains.

## Watchlist (review-needed.json, generated)

12 `watch-method` items: `.join('、')` / `.split('、')` / `.replace(...)` with CJK
arguments (report builders, detector). These are consistency-sensitive but **not**
substring matching; they are safe because producer and consumer share the corpus id
(both occurrences of `、` translate identically). Phase 6 test 4 covers this.

## Files emitted

- `l10n/data/denylist.json` — `{ ids: {拒绝访问, 需要提升}, occurrences: [3 sites incl. 卸载@2979] }`
- `l10n/data/pinned.json` — 7 fragments with M-sets, pinned sources, dep edges
- `l10n/data/review-needed.json` — 15 generated additions (3 class-C-confirm, 12 watch-method)
- `l10n/reports/phase-2-table.md` — auto-generated full occurrence table

## Section 6 hazards — coverage checklist

- [x] AppMigration.tsx:1086 `仍检测到应用存在` + `卸载命令执行失败` → B, M's found, pinned
- [x] AppMigration.tsx:1342/1591, LargeFolders.tsx:835 `检测到以下程序正在运行` (+ line iteration `检测到以下程序`) → B chained
- [x] AppMigration.tsx:1374/1684, LargeFolders.tsx:680/927 `用户取消了迁移` → B
- [x] LinkRecoveryModal.tsx:163 `取消` → B (15 M's, nested dep)
- [x] `TARGET_EXISTS:`/`TARGET_EXISTS_RETRY:` ASCII protocol prefixes — no CJK, untouched (corpus excludes them automatically)
- [x] useDangerousPathCheck ↔ danger_rules.rs category pairs → A, cross-boundary same-id verified
- [x] uninstall_snapshot.rs `安装目录` == → A with production sites
- [x] migration/mod.rs:628 `拒绝访问` → C (deny + review)
- [x] uninstaller.rs:1694 `需要提升` → C; :2979 `卸载` → C-occurrence (UI twin translates)
- [x] exhaustive sweep: zero other Rust match sites on external text in v1.3.2
