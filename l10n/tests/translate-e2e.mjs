#!/usr/bin/env node
// Phase 3 evidence: run translate.mjs end-to-end over 30 REAL corpus entries
// (all kinds + all 7 class-B fragments + pinned messages) against the mock
// server, with two failure injections:
//   - one template id drops {0} on the first attempt  → must be retried and pass
//   - one string id always returns CJK                → must land needs_review
// Prints the evidence table (input → output, validator verdict, attempts)
// and throughput. Uses a scratch translations file — real data/ untouched.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const work = join(root, '..', '.l10n-work');
const PORT = 8127;

const corpus = JSON.parse(readFileSync(join(work, 'corpus-v1.3.2.json'), 'utf8'));
const byId = new Map(corpus.entries.map((e) => [e.id, e]));

// ─── deterministic 30-entry sample covering all kinds + fragments + M's ───
const pinnedData = JSON.parse(readFileSync(join(root, 'data/pinned.json'), 'utf8'));
const fragIds = pinnedData.fragments.map((f) => f.id);
const pick = (pred, n, taken) => {
  const out = [];
  for (const e of corpus.entries) {
    if (out.length >= n) break;
    if (taken.has(e.id)) continue;
    if (pred(e)) {
      out.push(e);
      taken.add(e.id);
    }
  }
  return out;
};
const taken = new Set();
const sample = [];
for (const id of fragIds) {
  sample.push(byId.get(id));
  taken.add(id);
} // 7 fragments
sample.push(...pick((e) => e.occurrences.some((o) => o.logic?.type === 'method-arg' && o.logic.known) && !e.occurrences.every((o) => o.logic), 3, taken)); // pinned M's
sample.push(...pick((e) => e.kinds.includes('jsx-group'), 4, taken));
sample.push(...pick((e) => e.kinds.includes('template'), 4, taken));
sample.push(...pick((e) => e.kinds.includes('jsx-text'), 3, taken));
sample.push(...pick((e) => e.kinds.includes('jsx-attr'), 2, taken));
sample.push(...pick((e) => e.kinds.includes('rust-format'), 4, taken));
sample.push(...pick((e) => e.kinds.includes('rust-str'), 2, taken));
// fill the remainder with any not-yet-taken entry (deterministic order)
for (const e of corpus.entries) {
  if (sample.length >= 30) break;
  if (!taken.has(e.id)) {
    sample.push(e);
    taken.add(e.id);
  }
}
assert.equal(sample.length, 30, `sample size ${sample.length}`);

// ─── pending + failure rules ──────────────────────────────────────────────
const pendingOut = join(work, 'pending-e2e.json');
execFileSync(
  process.execPath,
  [
    join(root, 'pending.mjs'),
    '--corpus', join(work, 'corpus-v1.3.2.json'),
    '--out', pendingOut,
    '--tag', 'v1.3.2-e2e',
    '--ids', sample.map((e) => e.id).join(','),
  ],
  { stdio: 'pipe' }
);
const dropPhId = sample.find((e) => e.kinds.includes('template') && !fragIds.includes(e.id) && !/\{P/.test(e.source)).id;
const lateSample = sample.slice(10);
const alwaysBad =
  lateSample.find(
    (e) => e.kinds.includes('string') && e.source.length > 6 && Object.keys(e.placeholders ?? {}).length === 0 && !fragIds.includes(e.id)
  ) ?? lateSample.find((e) => !fragIds.includes(e.id) && Object.keys(e.placeholders ?? {}).length === 0);
const alwaysBadId = alwaysBad.id;
const failFile = join(work, 'mock-fail-e2e.json');
writeFileSync(failFile, JSON.stringify({ [dropPhId]: 'drop-ph-once', [alwaysBadId]: 'always-cjk' }), 'utf8');

// ─── run ──────────────────────────────────────────────────────────────────
rmSync(join(work, 'translations-e2e.json'), { force: true });
const mock = spawn(process.execPath, [join(here, 'mock-server.mjs'), String(PORT), '--fail', failFile], {
  stdio: 'pipe',
});
await new Promise((resolve) => {
  mock.stdout.once('data', resolve);
  setTimeout(resolve, 2000).unref?.();
});
await new Promise((r) => setTimeout(r, 300));

const t0 = Date.now();
let stdout = '';
try {
  stdout = execFileSync(
    process.execPath,
    [
      join(root, 'translate.mjs'),
      '--endpoint', `http://127.0.0.1:${PORT}/v1/chat/completions`,
      '--pending', pendingOut,
      '--out', join(work, 'translations-e2e.json'),
      '--no-git',
      '--model', 'mock-model',
    ],
    { encoding: 'utf8', cwd: root }
  );
} finally {
  mock.kill();
}
const elapsedMin = (Date.now() - t0) / 60000;

// ─── verify + evidence table ──────────────────────────────────────────────
const results = JSON.parse(readFileSync(join(work, 'translations-e2e.json'), 'utf8'));
assert.equal(Object.keys(results).length, 30, 'all 30 translated-or-flagged');

const retried = Object.entries(results).filter(([, v]) => v.attempts > 1 && !v.needs_review);
assert.equal(retried.length, 1, `expected exactly 1 retried-then-passed, got ${retried.length}`);
assert.equal(retried[0][0], dropPhId, 'the drop-{0} id is the one retried');

const flagged = Object.entries(results).filter(([, v]) => v.needs_review);
assert.equal(flagged.length, 1, `expected exactly 1 needs_review, got ${flagged.length}`);
assert.equal(flagged[0][0], alwaysBadId);

// pinned messages: final EN must contain the fragment EN
const fragEn = Object.fromEntries(fragIds.map((id) => [id, results[id]?.en]).filter(([, v]) => v));
const pendingItems = JSON.parse(readFileSync(pendingOut, 'utf8')).entries;
for (const it of pendingItems) {
  if (!it.pins || Object.keys(it.pins).length === 0 || !results[it.id] || results[it.id].needs_review) continue;
  for (const [tok, fragId] of Object.entries(it.pins)) {
    assert.ok(
      results[it.id].en.includes(fragEn[fragId]),
      `pinned ${it.id} "${results[it.id].en}" must contain fragment ${fragEn[fragId]}`
    );
  }
}

console.log('=== evidence table (id | kind | pinned source → en | verdict | attempts) ===');
for (const it of pendingItems) {
  const r = results[it.id];
  const verdict = r.needs_review ? `NEEDS_REVIEW (${r.review_reasons[0]})` : 'valid';
  const src = it.pinned_source.length > 46 ? it.pinned_source.slice(0, 46) + '…' : it.pinned_source;
  const en = r.en.length > 60 ? r.en.slice(0, 60) + '…' : r.en;
  console.log(`${it.id} | ${it.kinds.join('+')} | ${JSON.stringify(src)} → ${JSON.stringify(en)} | ${verdict} | ${r.attempts}`);
}
console.log(`\nmock throughput: ${(30 / Math.max(elapsedMin, 1e-9)).toFixed(0)} strings/min (pipeline overhead only — real-model throughput measured when llama-server is up)`);
console.log('E2E OK: 28 valid, 1 retried-then-valid (dropped {0} caught), 1 needs_review (persistent CJK)');
