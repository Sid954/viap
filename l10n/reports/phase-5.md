# Phase 5 Report — Workflows

**Date:** 2026-10-24 · **Status: built, committed, locally verified — CI evidence BLOCKED by a GitHub account-level Actions disablement (owner action required).**

## Deliverables (pushed `c72db19` + `14b93b1`)

| Path | What |
|---|---|
| `.github/workflows/l10n-check.yml` | daily cron + push (data paths) + manual. Ubuntu. Builds both extractors, gets upstream latest tag, compares with `l10n/data/state.json`, checks out upstream at the tag, **drift-checks upstream `release.yml` (SHA-256 → `l10n-drift` issue)**, extracts/classifies/diffs, **auto-translates new strings via GitHub Models when `GH_MODELS_TOKEN` is set** (endpoint/model overridable via repo variables; 429 backoff; same validators/denylist/pins), commits data, dispatches `release-en`, or commits `pending.json` + files/updates one `l10n` issue. |
| `.github/workflows/release-en.yml` | windows-latest, inputs `tag`/`dry-run`/`prerelease`. Checkout fork + upstream@tag → apply + patch (pubkey: `l10n/data/pubkey.txt`, or an **ephemeral throwaway key for dry-runs**) → gates: `tsc --noEmit`, fixture suite, frontend build, **cargo test (baseline match)**, **strict residue scan** → dry-run: build installer + upload as workflow artifact, no publishing → real: English release notes from upstream `CHANGELOG.md` + unofficial-build footer, `tauri-action@v0.5` (projectPath `upstream`), integrity signing via upstream's `scripts/prepare-integrity-exe.ps1`, exact upstream asset names, `release-extras` job (offline WebView2 + portable with English `Portable-README.txt`), then updates `state.last_built_tag`. Failure files an issue; nothing publishes on any gate failure. |
| `l10n/state.mjs` + `l10n/data/state.json` | state helper; seeded with `last_seen_tag: v1.3.2` and the v1.3.2 `release.yml` SHA-256 `a8adf6bd…` |
| `l10n/translate.mjs` | + `Authorization: Bearer $L10N_TOKEN` (GitHub Models), + 429 backoff |

Actions pinned (`checkout@v4`, `setup-node@v4`, `dtolnay/rust-toolchain@stable`, `swatinem/rust-cache@v2`, `tauri-action@v0.5`, `softprops/action-gh-release@v2`, `upload-artifact@v4`); `concurrency` per tag; labels `l10n` / `l10n-drift` created on the fork.

## Verified locally

- Both workflows parse as valid YAML.
- The full check-pipeline command sequence runs green on the real data:
  `pending: 0 → would dispatch release-en` (with `last_built_tag` unset).
- The release pipeline's core (apply + patch + every gate + NSIS build) is exactly
  what Phase 4 proved end-to-end on this PC.

## Blocked: GitHub account-level Actions disablement

Every `workflow_dispatch` (both workflows) returns
`HTTP 422: "Actions has been disabled for this user"` — while repo settings verify
`{"enabled":true,"allowed_actions":"all"}`. That combination means an
**account-level block** (automated flagging or a billing hold), which only the
owner can resolve:

1. Open https://github.com/Sid954/viap/actions — follow any warning banner's
   contact/appeal link, or use https://support.github.com/contact
   ("account flagged / Actions disabled"). Legit accounts are usually re-enabled quickly.
2. Check https://github.com/settings/billing for holds.
3. Once re-enabled, tell the agent — the dry-run dispatch command is ready:
   `gh workflow run release-en.yml -R Sid954/viap --ref main -f tag=v1.3.2 -f dry-run=true`

## Remaining owner items before the FIRST REAL release (checklist in review-needed.json)

1. `npm run tauri -- signer generate -w "%USERPROFILE%\.tauri\viap-en.key"` (run in `.l10n-work/upstream`) — this replaces the placeholder key everywhere automatically.
2. Commit the `.pub` content as `l10n/data/pubkey.txt`.
3. `gh secret set TAURI_SIGNING_PRIVATE_KEY` / `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Optional but recommended: `gh secret set GH_MODELS_TOKEN` (PAT with Models access) — enables CI auto-translation so future upstream updates need no local llama at all.

## Phase 5 evidence checklist

- [x] Workflows written, committed, registered (both show `active` via `gh workflow list`)
- [x] YAML validity + local pipeline smoke (check path → dispatch decision)
- [ ] Dry-run run URL + green gates + installer artifact — **blocked on account re-enable**
- [ ] Real pre-release run with all five asset types + `.sig` files — **needs secrets (§8.1–8.3)**
