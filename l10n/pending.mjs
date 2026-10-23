#!/usr/bin/env node
// Generate l10n/data/pending.json — strings that lack translations.
//   node l10n/pending.mjs --corpus <corpus.json> [--translations data/translations.json]
//         [--pinned data/pinned.json] [--denylist data/denylist.json]
//         --out data/pending.json --tag v1.3.2 [--ids id1,id2,…]
//
// Denylisted ids are never pending. Entries containing class-B fragments get
// a pinned source ({P1} replaces the fragment) and a pinMap {P1: fragmentId}.
// Fragments themselves get pins for shorter fragments nested inside them
// (inner fragments translate first; the outer English then contains the
// inner English by construction — plan §Phase 2 rule B).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { applyPins } from './lib/pins.mjs';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (k) => args.includes(k);

const corpusPath = get('--corpus');
const translationsPath = get('--translations') ?? 'data/translations.json';
const pinnedPath = get('--pinned') ?? 'data/pinned.json';
const denylistPath = get('--denylist') ?? 'data/denylist.json';
const outPath = get('--out');
const tag = get('--tag') ?? 'untagged';
if (!corpusPath || !outPath) {
  console.error('usage: pending.mjs --corpus F --out F [--ids a,b] [--tag T]');
  process.exit(2);
}

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const translations = existsSync(translationsPath)
  ? JSON.parse(readFileSync(translationsPath, 'utf8'))
  : {};
const translatedIds = new Set(
  Object.entries(translations)
    .filter(([, v]) => v && typeof v === 'object' && v.en)
    .map(([id]) => id)
);
const pinned = existsSync(pinnedPath)
  ? JSON.parse(readFileSync(pinnedPath, 'utf8'))
  : { fragments: [] };
const denylist = existsSync(denylistPath)
  ? JSON.parse(readFileSync(denylistPath, 'utf8'))
  : { ids: {}, occurrences: [] };
const deniedIds = new Set(Object.keys(denylist.ids ?? {}));

const fragments = pinned.fragments ?? [];
const fragById = new Map(fragments.map((f) => [f.id, f]));
const onlyIds = has('--ids') ? new Set((get('--ids') ?? '').split(',')) : null;

const items = [];
for (const e of corpus.entries) {
  if (translatedIds.has(e.id)) continue;
  if (deniedIds.has(e.id)) continue;
  if (onlyIds && !onlyIds.has(e.id)) continue;

  const isFragment = fragById.has(e.id);
  // fragments nested inside this source (shorter ones for fragments; all for
  // ordinary messages) become pins
  const nested = fragments
    .filter((f) => f.id !== e.id && e.source.includes(f.source))
    .sort((a, b) => b.source.length - a.source.length);
  let pinnedSource = e.source;
  let pinMap = {};
  if (nested.length > 0) {
    const r = applyPins(
      e.source,
      nested.map((f) => ({ id: f.id, source: f.source }))
    );
    pinnedSource = r.text;
    pinMap = Object.fromEntries(
      Object.entries(r.pins).map(([k, v]) => [k, v.id])
    );
  }
  items.push({
    id: e.id,
    source: e.source,
    pinned_source: pinnedSource,
    pins: pinMap,
    kinds: e.kinds,
    hint: e.hint,
    placeholders: e.placeholders,
    in_test: e.in_test,
    is_fragment: isFragment,
  });
}

// deterministic order: fragments inner-first (shortest first), then the rest
items.sort((a, b) => {
  if (a.is_fragment !== b.is_fragment) return a.is_fragment ? -1 : 1;
  if (a.is_fragment && b.is_fragment) return a.source.length - b.source.length;
  return a.id < b.id ? -1 : 1;
});

const out = { tag, generated: new Date().toISOString(), count: items.length, entries: items };
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.error(`pending: ${items.length} entries (${items.filter((i) => i.is_fragment).length} fragments) → ${outPath}`);
