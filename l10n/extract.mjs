#!/usr/bin/env node
// Unified extraction driver: runs both tools over an upstream tree, merges
// into one corpus (SPEC §1: one id per normalized source across tools).
//
//   node l10n/extract.mjs --src <upstream checkout> --out corpus.json
//
// Merge rules: kinds union; occurrences concat + sort; hints joined " | ";
// in_test = OR; placeholder KEYS must agree (mismatch → review flag, keys of
// first kept); placeholder values prefer the ts side (expression sources).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RUST_BIN = join(here, 'rust-tool/target/release/l10n-rust-tool.exe');

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const srcRoot = get('--src');
const outFile = get('--out');
if (!srcRoot || !outFile) {
  console.error('usage: extract.mjs --src DIR --out FILE');
  process.exit(2);
}

const partDir = dirname(outFile);
const tsOut = join(partDir, '.ts.part.json');
const rustOut = join(partDir, '.rust.part.json');

execFileSync(
  process.execPath,
  [join(here, 'ts-tool/bin.mjs'), 'extract', '--src', srcRoot, '--out', tsOut],
  { stdio: 'inherit' }
);
execFileSync(RUST_BIN, ['extract', '--src', srcRoot, '--out', rustOut, '--prefix', ''], {
  stdio: 'inherit',
});

const ts = JSON.parse(readFileSync(tsOut, 'utf8'));
const rs = JSON.parse(readFileSync(rustOut, 'utf8'));

const merged = new Map();
const review = [...ts.review, ...rs.review];

function mergeOne(e, tool) {
  const got = merged.get(e.id);
  if (!got) {
    merged.set(e.id, {
      id: e.id,
      source: e.source,
      kinds: [...e.kinds],
      hint: e.hint,
      // ts values preferred (expression sources); rust tokens kept otherwise
      placeholders: { ...e.placeholders },
      in_test: e.in_test,
      occurrences: e.occurrences.map((o) => ({ ...o, tool })),
    });
    return;
  }
  for (const k of e.kinds) if (!got.kinds.includes(k)) got.kinds.push(k);
  if (e.hint && !got.hint.includes(e.hint)) got.hint = `${got.hint} | ${e.hint}`;
  if (e.in_test) got.in_test = true;
  const keysA = Object.keys(got.placeholders).sort().join(',');
  const keysB = Object.keys(e.placeholders).sort().join(',');
  if (keysA !== keysB) {
    review.push({
      item: 'placeholder-mismatch',
      file: e.occurrences[0]?.file ?? '?',
      line: e.occurrences[0]?.line ?? 0,
      detail: `id ${e.id} keys differ across tools: [${keysA}] vs [${keysB}]`,
    });
  } else if (tool === 'ts') {
    got.placeholders = { ...e.placeholders };
  }
  got.occurrences.push(...e.occurrences.map((o) => ({ ...o, tool })));
  got.occurrences.sort((a, b) =>
    a.file === b.file ? a.start - b.start : a.file < b.file ? -1 : 1
  );
}

for (const e of ts.entries) mergeOne(e, 'ts');
for (const e of rs.entries) mergeOne(e, 'rust');

const corpus = {
  generated_from: srcRoot.replace(/\\/g, '/'),
  counts: {
    files_ts: ts.file_count,
    files_rust: rs.file_count,
    entries: merged.size,
    shared_by_both_tools: [...merged.values()].filter((e) =>
      e.occurrences.some((o) => o.tool === 'ts') && e.occurrences.some((o) => o.tool === 'rust')
    ).length,
    by_kind: Object.fromEntries(
      [...merged.values()]
        .flatMap((e) => e.kinds)
        .reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map())
        .entries()
    ),
    in_test: [...merged.values()].filter((e) => e.in_test).length,
  },
  entries: [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
  review,
};

writeFileSync(outFile, JSON.stringify(corpus, null, 2) + '\n', 'utf8');
console.log(
  `corpus: ${merged.size} entries (${corpus.counts.shared_by_both_tools} shared), review: ${review.length}`
);
