# Viap — English Edition (unofficial fork)

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" height="128" alt="Viap logo">
</p>

This is the **unofficial English edition** of [Viap](https://github.com/Chunyu33/viap), a Windows
app-management and storage-redirection tool by **Chunyu33 (Evan Lau)**. It moves installed
applications and large data folders off the system drive using NTFS directory junctions /
symbolic links, leaving a redirect point at the original path so everything keeps working.

The app's behavior is unchanged from upstream — only the UI language is English.

## How this fork works

Everything lives in [`l10n/`](l10n/SPEC.md); no upstream source is modified in this repository:

| Stage | Tool | What it does |
|---|---|---|
| Extract | `l10n/ts-tool` + `l10n/rust-tool` | parse TS/Rust sources into a corpus of CJK UI strings (placeholders, JSX groups, format strings preserved) |
| Classify | `l10n/classify.mjs` | logic-dependent literals: exact-match keys, pinned fragments for runtime `.includes()` checks, denylist for OS-text comparisons |
| Translate | `l10n/translate.mjs` / `translate.bat` | local model (llama.cpp / any OpenAI-compatible endpoint) or CI (GitHub Models); validated per string |
| Verify | `l10n/tests/suite.mjs` | 7 invariant families + sabotage fixtures — placeholders, pinned flows, denylist, idempotency, scope creep |
| Build | `.github/workflows/release-en.yml` | gated build + release on a pristine upstream checkout: `tsc`, the 80-test Rust suite, strict residue scan, then the upstream release pipeline |

Upstream releases are detected daily by `l10n-check.yml`; new strings are auto-translated in CI,
and a release is published **only** when every gate passes.

## Downloads

Grab installers (NSIS, offline WebView2, portable) from this fork's
[Releases](https://github.com/Sid954/viap/releases). Builds are unsigned — expect a SmartScreen
prompt ("More info → Run anyway").

## Building locally

```bash
git clone https://github.com/Sid954/viap
cd viap
git clone --depth 1 --branch v1.3.2 https://github.com/Chunyu33/viap .l10n-work/upstream
cd l10n && npm ci && (cd rust-tool && cargo build --release)
node apply.mjs --src ../.l10n-work/upstream --tm data
node patch-fork.mjs --src ../.l10n-work/upstream --pubkey-file <your .pub>
cd ../.l10n-work/upstream && npm ci && npm run tauri build
```

Requirements: Node ≥ 18, Rust (MSVC), VS Build Tools.

## Credits

- **Original project:** [Chunyu33 (Evan Lau)](https://github.com/Chunyu33/viap) — everything that
  makes Viap work is upstream work. 中文原版请访问上游仓库。
- English localization pipeline built for this fork under the same MIT license (see [LICENSE](LICENSE)).

## Disclaimer

This is an unofficial community build, not affiliated with or endorsed by the original author.
Translation issues belong in this fork's [issues](https://github.com/Sid954/viap/issues);
application bugs belong upstream.
