#!/usr/bin/env node
// ts-tool CLI: extract / apply over a source tree.
// Usage:
//   node ts-tool/bin.mjs extract --src <root> --out corpus-ts.json [--prefix src]
//   node ts-tool/bin.mjs apply   --src <root> --tm <translations.json> [--deny deny.json]
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { extractSource, rewriteSource } from './index.mjs';

function walk(root, filter, acc = []) {
  let names;
  try {
    names = readdirSync(root).sort();
  } catch {
    return acc;
  }
  for (const n of names) {
    const p = join(root, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (
        n === 'node_modules' ||
        n === 'target' ||
        n === '.git' ||
        n === 'dist' ||
        n === 'dist-ssr' ||
        n === 'build' ||
        n === 'out' ||
        n === 'coverage'
      )
        continue;
      walk(p, filter, acc);
    } else if (filter(p)) acc.push(p);
  }
  return acc;
}

const toPosix = (p) => p.split(sep).join('/');

const [, , cmd, ...rest] = process.argv;
const args = {};
for (let i = 0; i < rest.length; i += 2) args[rest[i]] = rest[i + 1];

if (cmd === 'extract') {
  const srcRoot = args['--src'];
  const prefix = args['--prefix'] ?? '';
  const files = walk(srcRoot, (p) => /\.tsx?$/.test(p) && !p.endsWith('.d.ts'));
  const entries = new Map();
  const review = [];
  for (const abs of files) {
    const rel = toPosix(relative(srcRoot, abs));
    const text = readFileSync(abs, 'utf8');
    const r = extractSource(abs, prefix ? `${prefix}/${rel}` : rel, text);
    for (const e of r.entries) {
      const got = entries.get(e.id);
      if (got) {
        got.occurrences.push(...e.occurrences.filter((o) => o.tool === 'ts'));
        got.occurrences.sort((a, b) => (a.file === b.file ? a.start - b.start : a.file < b.file ? -1 : 1));
        for (const k of e.kinds) if (!got.kinds.includes(k)) got.kinds.push(k);
        if (e.hint && !got.hint.includes(e.hint)) got.hint = `${got.hint} | ${e.hint}`;
      } else {
        entries.set(e.id, e);
      }
    }
    review.push(...r.review);
  }
  const out = {
    tool: 'ts',
    file_count: files.length,
    entries: [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    review,
  };
  writeFileSync(args['--out'], JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.error(`ts-tool: ${files.length} files, ${out.entries.length} entries, ${review.length} review items`);
} else if (cmd === 'apply') {
  const srcRoot = args['--src'];
  const tm = JSON.parse(readFileSync(args['--tm'], 'utf8')); // id -> english
  const deny = args['--deny'] ? JSON.parse(readFileSync(args['--deny'], 'utf8')) : [];
  const files = walk(srcRoot, (p) => /\.[jt]sx?$/.test(p) && !p.endsWith('.d.ts'));
  let changed = 0;
  for (const abs of files) {
    const rel = toPosix(relative(srcRoot, abs));
    const text = readFileSync(abs, 'utf8');
    const r = rewriteSource(abs, rel, text, (entry) =>
      deny.includes(entry.id) ? null : tm[entry.id] ?? null
    );
    if (r.changed) {
      writeFileSync(abs, r.text, 'utf8');
      changed += 1;
    }
  }
  console.error(`ts-tool apply: ${changed}/${files.length} files rewritten`);
} else {
  console.error('usage: bin.mjs extract|apply ...');
  process.exit(2);
}
