#!/usr/bin/env node
// Phase 4 — apply translations to a scratch upstream copy.
//   node l10n/apply.mjs --src <upstream dir> --tm l10n/data
//
// Precedence: overrides.json > translations.json (plan §Phase 4).
// Denylist: ids are never translated; occurrences[] deny only that site
// (rust-tool --deny-occ). needs_review entries are skipped unless
// --include-needs-review (they may violate structure).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const srcRoot = get('--src');
const tmDir = get('--tm') ?? join(here, 'data');
if (!srcRoot) {
  console.error('usage: apply.mjs --src DIR [--tm DIR] [--include-needs-review]');
  process.exit(2);
}

const translations = existsSync(join(tmDir, 'translations.json'))
  ? JSON.parse(readFileSync(join(tmDir, 'translations.json'), 'utf8'))
  : {};
const overrides = existsSync(join(tmDir, 'overrides.json'))
  ? JSON.parse(readFileSync(join(tmDir, 'overrides.json'), 'utf8'))
  : {};
const denylist = existsSync(join(tmDir, 'denylist.json'))
  ? JSON.parse(readFileSync(join(tmDir, 'denylist.json'), 'utf8'))
  : { ids: {}, occurrences: [] };
const includeNeedsReview = args.includes('--include-needs-review');

const tm = {};
let overridden = 0;
for (const [id, v] of Object.entries(translations)) {
  if (v && typeof v === 'object') {
    if (v.needs_review && !includeNeedsReview) continue;
    if (typeof v.en === 'string' && v.en) tm[id] = v.en;
  } else if (typeof v === 'string' && v) {
    tm[id] = v;
  }
}
for (const [id, en] of Object.entries(overrides)) {
  if (typeof en === 'string' && en) {
    tm[id] = en;
    overridden += 1;
  }
}
const denyIds = Object.keys(denylist.ids ?? {});
const denyOcc = denylist.occurrences ?? [];

const tmp = mkdtempSync(join(tmpdir(), 'l10n-apply-'));
const tmFile = join(tmp, 'tm.json');
const denyFile = join(tmp, 'deny.json');
const denyOccFile = join(tmp, 'deny-occ.json');
writeFileSync(tmFile, JSON.stringify(tm), 'utf8');
writeFileSync(denyFile, JSON.stringify(denyIds), 'utf8');
writeFileSync(denyOccFile, JSON.stringify(denyOcc), 'utf8');

console.log(
  `apply: ${Object.keys(tm).length} entries in TM (${overridden} overridden), ${denyIds.length} denied ids, ${denyOcc.length} denied occurrences${includeNeedsReview ? ' (needs_review included)' : ''}`
);

execFileSync(
  process.execPath,
  [join(here, 'ts-tool/bin.mjs'), 'apply', '--src', srcRoot, '--tm', tmFile, '--deny', denyFile],
  { stdio: 'inherit' }
);
execFileSync(
  join(here, 'rust-tool/target/release/l10n-rust-tool.exe'),
  ['apply', '--src', srcRoot, '--tm', tmFile, '--deny', denyFile, '--deny-occ', denyOccFile],
  { stdio: 'inherit' }
);
console.log('apply: done');
