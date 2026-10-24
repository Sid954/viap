#!/usr/bin/env node
// Residue scan (plan §Phase 4 evidence): re-extract the APPLIED tree and map
// every remaining CJK entry to a category:
//   denied-id / denied-occurrence / pending-translation (expected until the
//   full corpus run) / UNKNOWN → hard fail.
//   node l10n/residue.mjs --src <applied dir> --corpus <corpus.json> --tm l10n/data
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const src = get('--src');
const corpusPath = get('--corpus');
const tmDir = get('--tm') ?? join(here, 'data');
if (!src || !corpusPath) {
  console.error('usage: residue.mjs --src DIR --corpus F [--tm DIR] [--strict]');
  process.exit(2);
}
const STRICT = args.includes('--strict'); // strict = release gate: pending must be 0

const tmp = mkdtempSync(join(tmpdir(), 'l10n-residue-'));
const out = join(tmp, 'residue.json');
execFileSync(process.execPath, [join(here, 'extract.mjs'), '--src', src, '--out', out], {
  stdio: 'pipe',
});
const residue = JSON.parse(readFileSync(out, 'utf8'));
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const translations = existsSync(join(tmDir, 'translations.json'))
  ? JSON.parse(readFileSync(join(tmDir, 'translations.json'), 'utf8'))
  : {};
const overrides = existsSync(join(tmDir, 'overrides.json'))
  ? JSON.parse(readFileSync(join(tmDir, 'overrides.json'), 'utf8'))
  : {};
const denylist = JSON.parse(readFileSync(join(tmDir, 'denylist.json'), 'utf8'));
const deniedIds = new Set(Object.keys(denylist.ids ?? {}));
const deniedOcc = new Set((denylist.occurrences ?? []).map((o) => `${o.file}:${o.line}`));
const translated = new Set(
  Object.entries({ ...translations, ...overrides })
    .filter(([, v]) => (v && typeof v === 'object' ? !v.needs_review && !!v.en : !!v))
    .map(([id]) => id)
);
const corpusIds = new Set(corpus.entries.map((e) => e.id));

const cats = { denied: [], pending: [], unknown: [], translated_but_present: [] };
for (const e of residue.entries) {
  if (deniedIds.has(e.id)) {
    cats.denied.push(e);
    continue;
  }
  const nonDeniedOcc = e.occurrences.filter((o) => !deniedOcc.has(`${o.file}:${o.line}`));
  if (nonDeniedOcc.length === 0) {
    cats.denied.push(e); // every occurrence denylisted
    continue;
  }
  if (!corpusIds.has(e.id)) {
    cats.unknown.push(e);
    continue;
  }
  if (translated.has(e.id)) {
    // translated id still showing CJK somewhere → occurrence-level issue
    cats.translated_but_present.push(e);
    continue;
  }
  cats.pending.push(e);
}

const sample = (arr) => arr.slice(0, 3).map((e) => `${e.source.slice(0, 30)} @ ${e.occurrences[0].file}:${e.occurrences[0].line}`);
console.log(`residue: ${residue.entries.length} CJK entries in applied tree`);
console.log(`  denied (denylist):      ${cats.denied.length}`);
console.log(`  pending translation:    ${cats.pending.length}${cats.pending.length ? ' e.g. ' + JSON.stringify(sample(cats.pending)) : ''}`);
console.log(`  unknown (FAIL):         ${cats.unknown.length}${cats.unknown.length ? ' e.g. ' + JSON.stringify(sample(cats.unknown)) : ''}`);
console.log(`  translated-but-present: ${cats.translated_but_present.length}${cats.translated_but_present.length ? ' e.g. ' + JSON.stringify(sample(cats.translated_but_present)) : ''}`);

if (cats.unknown.length > 0 || cats.translated_but_present.length > 0) process.exit(1);
if (STRICT && cats.pending.length > 0) {
  console.error('STRICT mode: pending translations remain — release gate fails');
  process.exit(1);
}
console.log('residue scan OK');
