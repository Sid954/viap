# Phase 4 Report — Apply + fork-patch on a pristine checkout

**Date:** 2026-10-24 · **Tier:** patch list cheap/fast; rewriters were Phase 1's expensive tier

Deliverables: `l10n/apply.mjs`, `l10n/patch-fork.mjs`, `l10n/residue.mjs`.
Scratch tree: `.l10n-work/phase4` — robocopy of pristine upstream v1.3.2 incl. `.git`
(excludes node_modules/dist/target); `npm ci` fresh; cargo reused the upstream clone's
target dir via `CARGO_TARGET_DIR` (identical pristine sources ⇒ valid incremental build).

Translation state applied: the **30 real Qwen3-8B entries** from Phase 3 (0 needs_review,
0 overrides) + denylist (2 ids, 3 occurrences). This is a partial-TM run by design — the
full-corpus translation is the owner's `translate.bat` run; all gates below hold for any
TM size and are re-run by CI (Phase 5).

## Gate results

| Gate | Result |
|---|---|
| apply | 11/50 TS + 8/44 Rust files rewritten; deny ids + deny-occ honored (`卸载` UI translated, file-name check stays Chinese) |
| patch-fork (6 edits) | all anchors asserted & applied: updater pubkey ×2, endpoint, release base URL, portable API URL, `PORTABLE_UPDATE_URL` + `PORTABLE_CLOUD_UPDATE_URL` (Quark link → fork), 6 locale sites (4×`toLocaleString`→`en-US`, 3×`localeCompare`→`en`); no residual `'zh-CN'` |
| `npx tsc --noEmit` | **PASS — 0 errors** |
| `npm run build` | PASS (2.88 s) |
| `cargo check` | **PASS** (42 s incremental) |
| `cargo test` | **80 passed, 0 failed — identical to the Phase 0 baseline** (incl. the 115 in-test strings: none of the 30 translated entries broke an assertion) |
| residue scan | 1277 CJK entries remain: **1274 pending translation + 3 denylisted; 0 unknown, 0 translated-but-present** — every residue accounted for |
| idempotency | tree hash after run 1 = run 2 = `19f39604f76337902a1d5f894b3d4edf2390eac3`; second apply rewrote 0 files; patch-fork detected already-patched state |

Evidence files: `l10n/reports/evidence/phase4/` (diff-stat, full six-edit diff, locale
diffs, idempotency hashes, cargo-test log).

## Placeholder signing key (IMPORTANT — owner action before any release)

The fork's real updater key is a human-only step (plan §8.1–8.3). This phase used a
**throwaway keypair** generated locally (`tauri signer generate`, empty password) living
only in gitignored `.l10n-work/placeholder.key{,.pub}` — the private half is never
committed and signs nothing. Purpose: prove the pipeline end-to-end and keep
`cargo check`/build green (tauri validates the pubkey format).

**Before Phase 5's first real release the owner must:**
1. `npm run tauri -- signer generate -w "%USERPROFILE%\.tauri\viap-en.key"` (in the upstream clone dir), pick a password;
2. put the `.pub` content into `l10n/data/pubkey.txt` (committed);
3. `gh secret set TAURI_SIGNING_PRIVATE_KEY` and `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD` on `Sid954/viap`.
The patch automatically switches to `l10n/data/pubkey.txt` when it exists.

## Notes

- `apply.mjs` precedence: `overrides.json` > `translations.json`; `needs_review` entries
  are skipped unless `--include-needs-review`.
- `residue.mjs --strict` (release gate, Phase 5/10): pending must additionally be 0.
- Cargo gates reused the upstream clone's target — the scratch tree contains no build
  artifacts, keeping the idempotency hash clean.
- The six-edit diff also shows a real translation with its named `{error}` placeholder
  preserved verbatim (`无法读取当前程序文件: {error}` → `Cannot read current program file: {error}`).
