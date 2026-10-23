# Phase 3 Report — Local translation engine

**Date:** 2026-10-24 · **Tier used:** cheap/fast (as planned)

## Deliverables

| Path | What |
|---|---|
| `l10n/translate.mjs` | engine: git pull → pending.json → batches (temp 0, seed 42, JSON in/out, `response_format` with fallback) → sanitize → validate → pin substitution → retry (batch ÷2 → singles, 3 rounds) → needs_review best-attempt → commit+push. `L10N_ENDPOINT` configurable. |
| `translate.bat` | one-command local step (plan §4) |
| `l10n/lib/prompts.mjs` | system prompt: role, §7 style rules, full glossary, hard rules ({N}, <N>…</N>, {PN}, newlines, no additions) |
| `l10n/lib/validate.mjs` | shared validators (reused by CI/Phase 6): placeholder multiset, tag sequence, pin tokens, newlines, no CJK, length 0.4–6×, glossary compliance, full-width punctuation sanitizer |
| `l10n/lib/glossary.mjs` | §7 starter glossary (26 entries, multi-option) |
| `l10n/pending.mjs` | pending generator: corpus − translations − denylist; B-fragment pinning (fragments pin their inner fragments; messages pin all contained fragments) |
| `l10n/tests/mock-server.mjs` | deterministic OpenAI-compatible mock (glossary-aware pseudo-English + failure injection) |
| `l10n/tests/translate-e2e.mjs` | evidence harness (below) |

Ordering note (design refinement over the plan wording): fragments translate
**inner-first** (shortest first), because the outer fragment's source pins the
inner fragment (`用户{P1}了迁移`), so the outer English *contains* the inner
English by substitution — the Phase 2 dep invariant holds mechanically.

## Evidence 1 — 30 real corpus entries through the full engine (mock model)

Full table in the test output; summary of what it proves:

- **All kinds covered**: jsx-group (incl. `<1>{0}</1>个应用`, the multi-line
  `{0} 条记录 · 最近备份{1}{2}`), jsx-attr, jsx-text, string, template (incl. the
  4-line `\n`-preserving one), rust-str, rust-format, and the plain `卸载` UI
  entry (translates as "uninstall"; its file-name-check occurrence is denied
  separately at apply time).
- **All 7 class-B fragments + pinned messages**: e.g.
  `用户{P1}了迁移 → "aaaaamigrate"` (P1 = 取消's English substituted),
  `{P1}正在运行 → "aaaaaaaaaaa"` (contains the inner fragment's English) — the
  Phase 2 containment invariant enforced by the engine, not assumed.
- **Deliberate failure 1 — dropped `{0}`**: `已结束 {0} 个进程` came back
  without `{0}` on attempt 1 → validator caught `placeholders: source [{0}] != output []`
  → retried → **valid on attempt 2**.
- **Deliberate failure 2 — hopeless output (persistent CJK)**:
  `正在计算目录大小...` returned `...中文` every time → 3 attempts →
  **needs_review** with the best attempt kept; pipeline not blocked.
- Glossary visible in outputs (`portable edition`, `app data`, `leftovers`,
  `uninstall`), full-width punctuation sanitized, newlines preserved.
- Score: **28 valid, 1 retried-then-valid, 1 needs_review** — as designed.

## Evidence 2 — validator unit checks (`tests/run.mjs`)

9 checks green: JSX whitespace vectors, id determinism, pins nesting/
substitution/violation-catching, 5 cross-tool id-agreement fixtures, ts
scenario identity-rewrite stability.

## Evidence 3 — REAL model run (Qwen3-8B Q4_K_M, llama.cpp @ 127.0.0.1:9931)

Owner started the server (llama.cpp, `Aldaris/Qwen3-8B-Q4_K_M-GGUF:Q4_K_M`). The same
deterministic 30-entry evidence set was translated by the real model:

- **30 ok, 2 retried, 0 needs_review — 14.7 min (2.0 strings/min)** on the A750.
- Round 1's single 30-item batch exceeded the 5-min request timeout → the retry
  machinery halved the batch and completed — resilience proven against the live server.
- One first-attempt glossary violation (`恢复` missing "restore") was caught by the
  validator and passed on retry.
- **Pin invariants hold on real model output**: `用户{P1}了迁移 → "User Cancel migration"`
  ⊵ "Cancel", and `{P1}正在运行 → "Detected the following program is running"` ⊵
  "Detected the following program".
- Placeholder/newline fidelity: `目标位置已存在同名目录：\n{0}\n\n…` kept its exact
  `\n{0}\n\n` structure; `v{0}` version reference preserved.

Sample outputs (full set in `l10n/data/translations.json`):

| source (pinned) | en |
|---|---|
| `取消` | `Cancel` |
| `用户{P1}了迁移` | `User Cancel migration` |
| `已结束 {0} 个进程` | `Terminated {0} Processes` |
| `打开目录失败：{0}` | `Failed to Open Directory: {0}` |
| `便携版不提供自动更新。请手动下载 v{0} 覆盖当前程序，数据目录会保留。` | `Portable Edition Does Not Support Auto-Update. Please Manually Download v{0} …` |

**Findings for Phase 7 (style, not structure):** the model over-applies Title Case to
sentence-length descriptions ("Scanning App Data Directory Size, Mechanical Hard Drives
May Take Long"), and fragment grammar is stilted ("User Cancel migration" — preferable
"Migration cancelled by user", which still ⊵ "Cancel"). All structural validators pass;
prompt tuning targets these categories. Throughput 2.0 strings/min ⇒ full corpus ≈ 11 h
(one overnight run); Phase 7 bench should evaluate smaller/parallel batches and
`--parallel` slots on llama-server.

Note: the model name must match the served alias exactly (`Aldaris/Qwen3-8B-Q4_K_M-GGUF:Q4_K_M`);
the engine now records it from `/v1/models`. Items that never receive a model response
(batch-level HTTP failure) stay pending instead of being flagged needs_review.

## Owner instructions for the FULL corpus run (unchanged)

```
node l10n\pending.mjs --corpus .l10n-work\corpus-v1.3.2.json --out l10n\data\pending.json --tag v1.3.2
translate.bat          # engine handles fragments first, batches, retries, commit+push
```

## Deviations / notes

- `substitutePins` accepts both pin shapes (bare id from pending.mjs, {id,source}
  from applyPins) — caught by the e2e run.
- needs_review entries keep `review_reasons` in translations.json for Phase 7
  prompt tuning and the owner's review sheet.
- Engine commits only when >0 translated and not `--no-git` (tests use scratch
  outputs under `.l10n-work/`).
