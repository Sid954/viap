# Phase 6 Report — Automated verification suite

**Date:** 2026-10-25 · **Status: complete — all checks green, all sabotage fixtures caught.**

`l10n/tests/suite.mjs` runs the plan's seven invariant families against the REAL data
(corpus + translation memory + a freshly rewritten tree), then proves the safety-net
checks catch deliberate sabotage. Wired into `release-en.yml` as a blocking gate before
apply (parameterized `--upstream/--corpus/--pubkey`).

## Checks (all passing)

| # | Check | What it proves on this data |
|---|---|---|
| 1+2 | Every translation passes the Phase 3 validators (placeholders, tags, pin tokens, newlines, no CJK, 0.4–6× length, glossary) | 1312-entry effective TM — overrides win over model output; needs_review without an override is a failure |
| 3 | Pinned-fragment invariant | all 7 runtime `.includes()` fragments appear verbatim in every containing message, and nested fragment chains hold (outer EN ⊇ inner EN) |
| 4 | Exact-match (class A) literals | every compared/match-arm/object-key literal has one shared English (id-hash consistency) |
| 5 | Denylist integrity | 拒绝访问 / 需要提升 / 卸载@occurrence / 微信@test-fixture survive unchanged in the rewritten tree (matched by file+source, tolerant of line drift) |
| 6 | Idempotency + determinism | apply+patch twice on a fresh copy → identical tree hash |
| 7 | No scope creep | `git diff --no-index -U0` pristine→rewritten; every deleted line must be an occurrence line (exact offset→line maps, UTF-16 for TS / bytes for Rust), a fork-patch line (Chunyu33/Sid954/pubkey/zh-CN→en/quark), re-emitted verbatim in the hunk, or still present unchanged elsewhere in the file |

## Deliberate-failure fixtures (plan evidence) — all caught

- **3**: fragment English tampered to `ZZZ-TAMPERED-ZZZ` → containment failure reported with the offending message.
- **5**: 拒绝访问 removed from the rewritten tree → denied-id-missing reported.
- **7**: a `const` line edited outside any occurrence/patch range → reported with file:line.

## What building the suite caught in the real data (fixed)

- Glossary longest-match shadowing missing (微信 re-required inside 企业微信; 校验 inside 完整性校验) — validator now shadows contained keys.
- Glossary inflection gaps (migrating/restoring/restored/validation/in-use/taking-up forms) — options extended.
- ~20 hand-written overrides reworded for glossary compliance (e.g. "No apps found to migrate", "Checking files in use…", "taking up space").
- One real linguistic lesson recorded: "restoring" does NOT contain "restore" — substring glossary checks need inflected forms.
- Check 7 needed real diff semantics: unchanged lines realigned by group rebuilds are excused (content present in the applied file), patch lines matched on both pristine and patched forms.

## Test inventory (local, all green)

- `node l10n/tests/suite.mjs` — 6 check groups + 3 sabotage fixtures (this phase)
- `node l10n/tests/run.mjs` — 9 unit/cross-tool checks (Phase 1/2)
- `cargo test -p l10n-rust-tool` — 12 Rust tool tests (Phases 1–2)
- `node l10n/tests/pin-demo.mjs` — 7/7 real-fragment pin demonstration (Phase 2)
- CI: suite wired as a blocking gate in `release-en.yml` (after corpus extraction, before apply)
