#!/usr/bin/env node
// Identity round-trip on a real tree copy: apply with translations == source
// normalized text, re-extract, and require the exact same id set per tool.
//   node tests/identity-roundtrip.mjs --src <upstream> --work <tmpdir>
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const RUST_BIN = join(here, '../rust-tool/target/release/l10n-rust-tool.exe');
const TS_BIN = join(here, '../ts-tool/bin.mjs');
const EXTRACT = join(here, '../extract.mjs');

const args = process.argv.slice(2);
const get = (k) => args[args.indexOf(k) + 1];
const src = get('--src');
const work = get('--work');

rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'tree'), { recursive: true });
cpSync(join(src, 'src'), join(work, 'tree', 'src'), { recursive: true });
cpSync(join(src, 'src-tauri'), join(work, 'tree', 'src-tauri'), {
  recursive: true,
  filter: (f) => !f.includes('target'),
});

function extract(out) {
  execFileSync(process.execPath, [EXTRACT, '--src', join(work, 'tree'), '--out', out], {
    stdio: 'pipe',
  });
  return JSON.parse(readFileSync(out, 'utf8'));
}

const before = extract(join(work, 'corpus-before.json'));
const tm = Object.fromEntries(before.entries.map((e) => [e.id, e.source]));
const { writeFileSync } = await import('node:fs');
writeFileSync(join(work, 'tm.json'), JSON.stringify(tm), 'utf8');

execFileSync(process.execPath, [TS_BIN, 'apply', '--src', join(work, 'tree', 'src'), '--tm', join(work, 'tm.json')], { stdio: 'inherit' });
execFileSync(RUST_BIN, ['apply', '--src', join(work, 'tree'), '--tm', join(work, 'tm.json')], { stdio: 'inherit' });

const after = extract(join(work, 'corpus-after.json'));

const idsBefore = new Set(before.entries.map((e) => e.id));
const idsAfter = new Set(after.entries.map((e) => e.id));
const lost = [...idsBefore].filter((x) => !idsAfter.has(x));
const gained = [...idsAfter].filter((x) => !idsBefore.has(x));
assert.deepEqual(lost, [], `ids lost after identity apply: ${JSON.stringify(lost.slice(0, 5))}`);
assert.deepEqual(gained, [], `ids gained after identity apply: ${JSON.stringify(gained.slice(0, 5))}`);

// occurrence counts must also match per entry
for (const e of after.entries) {
  const b = before.entries.find((x) => x.id === e.id);
  assert.equal(
    e.occurrences.length,
    b.occurrences.length,
    `occurrence count changed for ${e.id} (${e.source.slice(0, 40)})`
  );
}

console.log(`identity round-trip OK: ${idsAfter.size} ids stable, occurrence counts unchanged`);
