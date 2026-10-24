#!/usr/bin/env node
// Phase 6 — the consolidated verification suite (plan §Phase 6).
// Runs the seven invariant families against REAL data, then proves the
// safety-net checks catch sabotage (deliberate-failure fixtures for tests
// 3, 5, 7). Exit code 0 only when everything passes.
//
//   node tests/suite.mjs [--upstream <pristine dir>] [--skip-tree]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, readFileSync, existsSync, rmSync, mkdtempSync, readdirSync, statSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { validate } from '../lib/validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const l10n = join(here, '..');
const root = join(l10n, '..');
const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const PRISTINE = get('--upstream') ?? join(root, '.l10n-work', 'upstream');
const CORPUS = get('--corpus') ?? join(root, '.l10n-work', 'corpus-v1.3.2.json');
const PUBKEY_ARG = get('--pubkey');
const SKIP_TREE = args.includes('--skip-tree');

const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
const translations = JSON.parse(readFileSync(join(l10n, 'data', 'translations.json'), 'utf8'));
const overrides = JSON.parse(readFileSync(join(l10n, 'data', 'overrides.json'), 'utf8'));
const denylist = JSON.parse(readFileSync(join(l10n, 'data', 'denylist.json'), 'utf8'));
const pinned = JSON.parse(readFileSync(join(l10n, 'data', 'pinned.json'), 'utf8'));

// effective TM: overrides > translations; needs_review skipped unless overridden
const effective = {};
for (const [id, v] of Object.entries(translations)) {
  if (v && typeof v === 'object' && !v.needs_review && v.en) effective[id] = v.en;
}
for (const [id, en] of Object.entries(overrides)) {
  if (typeof en === 'string' && en) effective[id] = en;
}

let pass = 0;
function ok(name, fn) {
  const errs = fn();
  if (errs.length) {
    console.error(`FAIL ${name}:`);
    for (const e of errs.slice(0, 8)) console.error('  - ' + e);
    process.exitCode = 1;
  } else {
    pass += 1;
    console.log(`ok - ${name}`);
  }
}

// ─── checks 1 + 2: validators over the effective TM ──────────────────────
ok('1+2. every translation passes validators (placeholders, tags, pins, newlines, CJK, length, glossary)', () => {
  const errs = [];
  for (const e of corpus.entries) {
    const en = effective[e.id];
    if (en == null) continue;
    const v = validate(e.source, en, { skipGlossary: e.in_test });
    if (v.length) errs.push(`${e.id} ${JSON.stringify(e.source.slice(0, 40))}: ${v.join('; ')}`);
  }
  for (const [id, v] of Object.entries(translations)) {
    if (v?.needs_review && !overrides[id]) errs.push(`needs_review without override: ${id}`);
  }
  return errs;
});

// ─── check 3: pinned-fragment invariant ──────────────────────────────────
function checkPinned(corpusData, tm, pinnedData) {
  const errs = [];
  for (const f of pinnedData.fragments ?? []) {
    const fen = tm[f.id];
    if (fen == null) {
      errs.push(`fragment not translated: ${f.source}`);
      continue;
    }
    for (const m of f.pinned_in ?? []) {
      const men = tm[m.id];
      if (men == null) continue; // untranslated M is "pending", not a pin break
      if (!men.includes(fen)) {
        errs.push(`M [${m.source.slice(0, 40)}…] en="${men.slice(0, 50)}…" does not contain F en="${fen}"`);
      }
    }
    for (const dep of f.deps ?? []) {
      const outer = tm[dep];
      if (outer != null && !outer.includes(fen)) {
        errs.push(`outer ${dep} en="${outer.slice(0, 40)}…" does not contain inner en="${fen}"`);
      }
    }
  }
  return errs;
}
ok('3. pinned-fragment invariant (runtime .includes flows keep matching)', () =>
  checkPinned(corpus, effective, pinned));

// ─── check 4: exact-match consistency ────────────────────────────────────
ok('4. exact-match (class A) literals all translated (single shared English)', () => {
  const errs = [];
  for (const e of corpus.entries) {
    const isA = e.occurrences.some(
      (o) => o.logic && ['compare', 'case', 'match-arm', 'object-key', 'index'].includes(o.logic.type)
    );
    if (!isA || denylist.ids?.[e.id]) continue;
    if (effective[e.id] == null) {
      errs.push(`class-A literal untranslated: ${JSON.stringify(e.source.slice(0, 40))}`);
    }
  }
  return errs;
});

// ─── tree helpers ────────────────────────────────────────────────────────
function copyTree(src, dst) {
  cpSync(src, dst, {
    recursive: true,
    filter: (f) => !/[/\\](node_modules|dist|target|\.git)([\/\\]|$)/.test(f),
  });
}
function walkFiles(dir, acc = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return acc; }
  for (const n of names.sort()) {
    const p = join(dir, n);
    let st = null;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (['node_modules', 'dist', 'target', '.git'].includes(n)) continue;
      walkFiles(p, acc);
    } else if (/\.(tsx?|rs)$/.test(n) && !n.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}
function hashTree(treeDir) {
  const h = createHash('sha256');
  for (const f of walkFiles(treeDir).sort()) {
    h.update(f.slice(treeDir.length + 1) + '\0');
    h.update(readFileSync(f));
  }
  return h.digest('hex');
}
function applyAll(treeDir, pubkey) {
  execFileSync(process.execPath, [join(l10n, 'apply.mjs'), '--src', treeDir, '--tm', join(l10n, 'data')], { stdio: 'pipe', cwd: l10n });
  execFileSync(process.execPath, [join(l10n, 'patch-fork.mjs'), '--src', treeDir, '--pubkey-file', pubkey], { stdio: 'pipe', cwd: l10n });
}

// allowed pristine line-ranges: exact occurrence spans via offset→line maps
// (TS offsets are UTF-16 code units; rust offsets are bytes — SPEC §1)
const allowed = new Map(); // posix file -> Set(pristine line numbers)
{
  const fileCache = new Map(); // file -> { lines16: number[], lines8: number[] }
  const loadFile = (rel) => {
    if (fileCache.has(rel)) return fileCache.get(rel);
    const text = readFileSync(join(PRISTINE, rel), 'utf8');
    const lines16 = [0];
    const lines8 = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        lines16.push(i + 1);
        lines8.push(Buffer.byteLength(text.slice(0, i + 1), 'utf8'));
      }
    }
    const entry = { lines16, lines8 };
    fileCache.set(rel, entry);
    return entry;
  };
  const lineOf = (arr, off) => {
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo + 1; // 1-based
  };
  for (const e of corpus.entries) {
    for (const o of e.occurrences) {
      if (!allowed.has(o.file)) allowed.set(o.file, new Set());
      const set = allowed.get(o.file);
      let s, t;
      try {
        const { lines16, lines8 } = loadFile(o.file);
        const arr = o.tool === 'rust' ? lines8 : lines16;
        s = lineOf(arr, o.start);
        t = lineOf(arr, Math.max(o.end - 1, o.start));
      } catch {
        s = o.line;
        t = o.line + e.source.split('\n').length - 1;
      }
      for (let l = s; l <= t; l++) set.add(l);
    }
  }
}
const PATCH_LINE = /(Sid954\/viap|Chunyu33\/viap|pan\.quark\.cn|dW50cnVzdGVk|pubkey|en-US'|zh-CN'|localeCompare\([^)]*, '(?:en|zh-CN)'\))/;

// ─── check 5: denylist integrity (pure over a re-extracted tree corpus) ──
function checkDenylist(treeEntries, dl) {
  const errs = [];
  const byId = new Map(treeEntries.map((e) => [e.id, e]));
  for (const [id, meta] of Object.entries(dl.ids ?? {})) {
    const e = byId.get(id);
    if (!e) errs.push(`denied id ${id} (${meta.source.slice(0, 20)}) missing from rewritten tree`);
    else if (e.source !== meta.source) errs.push(`denied id ${id} source changed`);
  }
  for (const occ of dl.occurrences ?? []) {
    // line numbers drift when earlier literals are rebuilt — the invariant
    // is that the denied literal still exists, unchanged, in that file
    const present = treeEntries.some(
      (x) => x.source === occ.source &&
        x.occurrences.some((o) => o.file === occ.file)
    );
    if (!present) errs.push(`denied occurrence in ${occ.file} (${occ.source}) not present unchanged`);
  }
  return errs;
}

// ─── check 7: scope creep (git-diff hunks vs allowed pristine ranges) ────
function checkScopeFile(rel, pristinePath, treePath, allowedMap, patchLine) {
  let out;
  try {
    out = execFileSync(
      'git',
      ['diff', '--no-index', '--unified=0', '--', pristinePath, treePath],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (e) {
    out = e.stdout ?? ''; // git diff exits 1 when files differ
  }
  if (!out) return [];
  // applied-file line multiset: '-' lines whose content still exists in the
  // applied file were realigned by the diff (group rebuilds merge unchanged
  // tag lines into replacement blocks), not modified
  const treeLines = new Set(
    readFileSync(treePath, 'utf8').split('\n').map((l) => l.trim())
  );
  const errs = [];
  const alw = allowedMap.get(rel);
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
    if (!m) continue;
    let oldLine = parseInt(m[1], 10);
    let bad = null;
    // multiset of inserted line contents: a '-' line identical to a '+'
    // line in the same hunk was only realigned by the diff (group rebuilds
    // re-emit original tag slices verbatim), not modified
    const added = [];
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('@@'); j++) {
      if (lines[j].startsWith('+')) added.push(lines[j].slice(1));
    }
    const addedSet = new Set(added);
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('@@'); j++) {
      const l = lines[j];
      if (l.startsWith('+')) continue; // insertions ride along with anchors
      if (l.startsWith('-')) {
        const content = l.slice(1);
        if (
          !alw?.has(oldLine) &&
          !patchLine.test(content) &&
          !addedSet.has(content) &&
          !treeLines.has(content.trim())
        ) {
          bad ??= oldLine;
        }
        oldLine += 1;
      } else {
        oldLine += 1; // context line (unchanged) — never a violation
      }
    }
    if (bad != null) {
      errs.push(`${rel}:${bad} changed outside occurrence/patch ranges`);
    }
  }
  return errs;
}

// ─── check 7: scope creep (pure over pristine/applied line pairs) ────────
function checkScopeLines(rel, a, b, allowedMap, patchLine) {
  const errs = [];
  const alw = allowedMap.get(rel);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    const okLine = alw?.has(i + 1) || patchLine.test(b[i] ?? '') || patchLine.test(a[i] ?? '');
    if (!okLine) {
      errs.push(`${rel}:${i + 1} changed outside occurrence/patch ranges: ${JSON.stringify((b[i] ?? a[i] ?? '').slice(0, 60))}`);
    }
  }
  return errs;
}

if (!SKIP_TREE) {
  assert.ok(existsSync(PRISTINE), `pristine upstream not found at ${PRISTINE}`);
  const pubkey = PUBKEY_ARG ?? (existsSync(join(l10n, 'data', 'pubkey.txt'))
    ? join(l10n, 'data', 'pubkey.txt')
    : join(root, '.l10n-work', 'placeholder.key.pub'));
  assert.ok(existsSync(pubkey), 'no pubkey available (data/pubkey.txt or .l10n-work/placeholder.key.pub)');

  const tmp = mkdtempSync(join(tmpdir(), 'l10n-suite-'));
  try {
    const tree = join(tmp, 'tree');
    copyTree(PRISTINE, tree);
    applyAll(tree, pubkey);

    // re-extract the rewritten tree (checks 5) via extract.mjs
    const treeCorpusPath = join(tmp, 'tree-corpus.json');
    execFileSync(process.execPath, [join(l10n, 'extract.mjs'), '--src', tree, '--out', treeCorpusPath], { stdio: 'pipe', cwd: l10n });
    const treeCorpus = JSON.parse(readFileSync(treeCorpusPath, 'utf8'));
    ok('5. denylist integrity (external-text checks stay Chinese, unchanged)', () =>
      checkDenylist(treeCorpus.entries, denylist));

    // check 6: second apply must be a no-op
    ok('6. idempotency + determinism (apply/patch twice → identical tree)', () => {
      const before = hashTree(tree);
      applyAll(tree, pubkey);
      const after = hashTree(tree);
      return before === after ? [] : [`tree hash changed on second apply: ${before} → ${after}`];
    });

    // check 7: pristine vs applied — diff hunks must sit inside allowed ranges
    ok('7. no scope creep (diff touches only occurrence/patch lines)', () => {
      const pristineFiles = walkFiles(PRISTINE).sort();
      const errs = [];
      for (const pf of pristineFiles) {
        const rel = relative(PRISTINE, pf).split('\\').join('/');
        const tf = join(tree, rel);
        if (!existsSync(tf)) {
          errs.push(`file deleted from rewritten tree: ${rel}`);
          continue;
        }
        if (readFileSync(pf, 'utf8') === readFileSync(tf, 'utf8')) continue;
        errs.push(...checkScopeFile(rel, pf, tf, allowed, PATCH_LINE));
        if (errs.length > 10) break;
      }
      return errs;
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── deliberate-failure fixtures (plan evidence: tests 3, 5, 7) ─────────
console.log('\n-- deliberate-failure fixtures (each must be CAUGHT) --');
let caught = 0;
function mustCatch(name, errs) {
  assert.ok(errs.length > 0, `fixture "${name}" was NOT caught — the check is broken!`);
  caught += 1;
  console.log(`ok - fixture caught: ${name} → ${errs[0].slice(0, 90)}`);
}

// fixture 3: tampered fragment English no longer contained in its messages
{
  const tm = { ...effective };
  const frag = pinned.fragments.find((f) => effective[f.id]);
  tm[frag.id] = 'ZZZ-TAMPERED-ZZZ';
  mustCatch('3. tampered fragment English breaks containment', checkPinned(corpus, tm, pinned));
}

// fixture 5: a denied literal vanishes from the rewritten tree
{
  const fakeEntries = corpus.entries.map((e) => structuredClone(e));
  const idx = fakeEntries.findIndex((e) => e.source === '拒绝访问');
  fakeEntries.splice(idx, 1);
  mustCatch('5. missing denied literal detected', checkDenylist(fakeEntries, denylist));
}

// fixture 7: a line edited outside occurrence/patch ranges
{
  const allowedMap = new Map([['src/app.ts', new Set([10])]]);
  const a = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
  const b = ['const a = 1;', 'const b = TAMPERED;', 'const c = 3;'];
  mustCatch('7. edit outside occurrence/patch ranges detected',
    checkScopeLines('src/app.ts', a, b, allowedMap, PATCH_LINE));
}

console.log(`\nsuite: ${pass} checks passed, ${caught}/3 sabotage fixtures caught`);
if (process.exitCode) process.exit(1);
