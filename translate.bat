@echo off
rem One-command local translation step (plan §4): pulls, reads pending.json,
rem translates with the local model, validates, commits and pushes.
cd /d %~dp0
node l10n\translate.mjs %*
