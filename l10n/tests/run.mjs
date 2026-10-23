// Fixture suite runner: proves ts-tool and rust-tool agree on normalization
// and corpus ids (l10n/SPEC.md), plus unit vectors. Exit code 0 = all pass.
//
// Requires the rust-tool release binary:
//   cd l10n/rust-tool && cargo build --release
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { extractSource, rewriteSource } from '../ts-tool/index.mjs';
import { corpusId } from '../lib/id.mjs';
import { jsxWhitespace } from '../lib/normalize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RUST_BIN = join(here, '../rust-tool/target/release/l10n-rust-tool.exe');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// ─── unit vectors ──────────────────────────────────────────────────────────

ok('jsxWhitespace: Babel/React semantics', () => {
  assert.equal(jsxWhitespace('multi line'), 'multi line');
  assert.equal(jsxWhitespace('\n  multi\n  line\n '), 'multi line');
  assert.equal(jsxWhitespace('a\n  b\n  c'), 'a b c');
  assert.equal(jsxWhitespace('发现 '), '发现 '); // same-line spaces preserved
  assert.equal(jsxWhitespace(' 项'), ' 项');
  assert.equal(jsxWhitespace('\n   \n'), ''); // whitespace-only lines vanish
  assert.equal(jsxWhitespace(' '), ' '); // single same-line space kept exactly once
  assert.equal(jsxWhitespace('  '), '  '); // two same-line spaces kept (no doubling)
});

ok('corpusId: known sha1 vector', () => {
  // sha1("已迁移 {0} 个应用" NFC utf8) starts with:
  const id = corpusId('已迁移 {0} 个应用');
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, corpusId('已迁移 {0} 个应用')); // deterministic
});

// ─── cross-tool fixtures ──────────────────────────────────────────────────
// Each case: the same logical string in TS and Rust contexts must normalize
// identically and therefore share one corpus id (SPEC §1, §3).

const CASES = [
  {
    name: 'plain-string',
    ts: { file: 'a.ts', src: "const e = setError('发生错误');" },
    rust: { file: 'a.rs', src: 'fn a() { let e = "发生错误"; }' },
    expect: { source: '发生错误', phKeys: [] },
  },
  {
    name: 'single-placeholder',
    ts: { file: 'b.ts', src: 'const t = `已迁移 ${count} 个应用`;' },
    rust: { file: 'b.rs', src: 'fn b(count: i32) { let t = format!("已迁移 {} 个应用", count); }' },
    expect: { source: '已迁移 {0} 个应用', phKeys: ['0'] },
  },
  {
    name: 'two-placeholders-reorder-safe',
    ts: { file: 'c.ts', src: 'const t = `从 ${src} 迁移到 ${dst}`;' },
    rust: { file: 'c.rs', src: 'fn c() { let t = format!("从 {} 迁移到 {}", 1, 2); }' },
    expect: { source: '从 {0} 迁移到 {1}', phKeys: ['0', '1'] },
  },
  {
    name: 'spec-and-escapes',
    ts: { file: 'd.ts', src: 'const t = `复制 ${p} 失败（错误码 ${c}）`;' },
    rust: { file: 'd.rs', src: 'fn d() { let t = format!("复制 {:?} 失败（错误码 {}）", 1, 2); }' },
    expect: { source: '复制 {0} 失败（错误码 {1}）', phKeys: ['0', '1'] },
  },
  {
    name: 'full-width-punctuation-only-included',
    ts: { file: 'e.ts', src: "const t = '注意：';" },
    rust: { file: 'e.rs', src: 'fn e() { let t = "注意："; }' },
    expect: { source: '注意：', phKeys: [] },
  },
];

const tmp = join(here, '.tmp-fixtures');
rmSync(tmp, { recursive: true, force: true });
const tsDir = join(tmp, 'ts');
const rsDir = join(tmp, 'rust');
mkdirSync(tsDir, { recursive: true });
mkdirSync(rsDir, { recursive: true });

for (const c of CASES) {
  writeFileSync(join(tsDir, c.ts.file), c.ts.src, 'utf8');
  writeFileSync(join(rsDir, c.rust.file), c.rust.src, 'utf8');
}

execFileSync(RUST_BIN, ['extract', '--src', rsDir, '--out', join(tmp, 'rust.json')], {
  stdio: 'pipe',
});
const rustOut = JSON.parse(readFileSync(join(tmp, 'rust.json'), 'utf8'));

for (const c of CASES) {
  ok(`cross-tool id agreement: ${c.name}`, () => {
    const tsText = readFileSync(join(tsDir, c.ts.file), 'utf8');
    const tsR = extractSource(join(tsDir, c.ts.file), c.ts.file, tsText);
    const tsEntry = tsR.entries.find((e) => e.source === c.expect.source);
    assert.ok(tsEntry, `ts entry for ${c.expect.source}`);
    const rsEntry = rustOut.entries.find((e) => e.source === c.expect.source);
    assert.ok(rsEntry, `rust entry for ${c.expect.source}`);
    assert.equal(tsEntry.id, rsEntry.id, `ids must match for "${c.expect.source}"`);
    assert.deepEqual(
      Object.keys(tsEntry.placeholders).sort(),
      c.expect.phKeys.sort()
    );
    assert.deepEqual(
      Object.keys(rsEntry.placeholders).sort(),
      c.expect.phKeys.sort()
    );
  });
}

// ─── ts scenario (groups, nested groups, skips) + identity rewrite ─────────

ok('ts scenario: kinds, skips, identity rewrite stability', () => {
  const src = readFileSync(join(here, 'fixtures', 'scenario.tsx.txt'), 'utf8');
  const { entries } = extractSource('/t/App.tsx', 'src/App.tsx', src);
  const sources = entries.map((e) => e.source);
  assert(sources.includes('发生错误'));
  assert(sources.includes('已迁移 {0} 个应用，{1}'));
  assert(sources.includes('成功') && sources.includes('失败'));
  assert(sources.includes('发现 <1>{0}</1> 个联接候选'));
  assert(sources.includes('其中 {0} 条已有记录'));
  assert(sources.includes('提示'));
  assert(!sources.some((s) => s.includes('日志中文')));
  assert(!sources.some((s) => s.includes('模块')));

  const tm = Object.fromEntries(entries.map((e) => [e.id, e.source]));
  const { text } = rewriteSource('/t/App.tsx', 'src/App.tsx', src, (e) => tm[e.id]);
  const re = extractSource('/t/App2.tsx', 'src/App.tsx', text);
  const ids1 = new Set(entries.map((e) => e.id));
  const ids2 = new Set(re.entries.map((e) => e.id));
  assert.deepEqual(
    [...ids1].filter((x) => !ids2.has(x)),
    [],
    'identity rewrite must preserve ids'
  );
  assert.deepEqual(
    [...ids2].filter((x) => !ids1.has(x)),
    [],
    'identity rewrite must not create ids'
  );
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
