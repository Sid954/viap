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

## Pending (owner action, cannot be automated — plan §8.4)

**No model server is running** (probed `127.0.0.1:8080` and `:1234`). The
real-model evidence and throughput measurement require the owner to start
llama-server (Vulkan build) or LM Studio:

```
llama-server.exe -m Qwen3-8B-Q4_K_M.gguf -ngl 99 -c 8192 --port 8080 --jinja
```

(verify flags against `llama-server --help`; update the Intel Arc driver first —
plan §8.4). Then:

```
node l10n\pending.mjs --corpus .l10n-work\corpus-v1.3.2.json --out l10n\data\pending.json --tag v1.3.2 --ids <30-evidence-ids>
node l10n\translate.mjs            # or translate.bat
```

The engine is already proven against the mock; the real run exercises the same
path with a live endpoint. Mock throughput (pipeline overhead only):
~15 000 strings/min — real-model strings/min to be recorded here when the
server is up. Logged in `l10n/data/review-needed.json` as owner action
`model-server`.

## Deviations / notes

- `substitutePins` accepts both pin shapes (bare id from pending.mjs, {id,source}
  from applyPins) — caught by the e2e run.
- needs_review entries keep `review_reasons` in translations.json for Phase 7
  prompt tuning and the owner's review sheet.
- Engine commits only when >0 translated and not `--no-git` (tests use scratch
  outputs under `.l10n-work/`).
