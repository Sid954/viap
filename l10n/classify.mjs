#!/usr/bin/env node
// Phase 2 — logic-literal classification (plan §Phase 2, §6).
//
//   node l10n/classify.mjs --corpus <corpus.json>
//
// Consumes corpus occurrences with their `logic` context (emitted by both
// extractors) and produces:
//   l10n/data/denylist.json  — C literals (never translated): id-level and
//                              occurrence-level
//   l10n/data/pinned.json    — B fragments, their containing messages, pin
//                              layout, and fragment→fragment dependencies
//   review additions         — printed as JSON (the driver appends them to
//                              l10n/data/review-needed.json)
//   a classification table   — stdout / --report file
//
// Classification rules (priority C > B > A > U, per OCCURRENCE first, then
// folded per entry over non-C occurrences):
//   C  matched against OS/external text. Rust method-arg sites are C by
//      default (this codebase matches error strings / file names there);
//      each one is also emitted to review-needed for human confirmation.
//      TS method-arg receivers here are backend-produced messages → not C.
//   B  substring match against internal text (TS includes/… on backend
//      messages) → pinned-fragment algorithm.
//   A  exact match (compare / case / match-arm / object-key / index) →
//      translated through the shared memory; verified to have a production
//      (non-logic) occurrence — logic-only literals are external → C.
//   U  plain UI text.
import { readFileSync, writeFileSync } from 'node:fs';
import { corpusId } from './lib/id.mjs';
import { applyPins } from './lib/pins.mjs';

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const corpusPath = get('--corpus') ?? '../.l10n-work/corpus-v1.3.2.json';
const outDir = get('--out-dir') ?? './data';
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

// Methods whose CJK argument is consistency-sensitive (separators, patterns)
// but not substring matching — rely on id-sharing; surfaced for review.
const WATCH_METHODS = new Set(['split', 'join', 'replace', 'replaceAll']);

const review = [];
const denyIds = {}; // id -> {source, reason}
const denyOccurrences = []; // {file, line, source, reason}
const rows = []; // classification table rows

// ─── per-occurrence classification ────────────────────────────────────────
for (const e of corpus.entries) {
  for (const o of e.occurrences) {
    const lg = o.logic;
    if (!lg) continue;
    if (lg.type === 'method-arg') {
      if (!lg.known) {
        if (WATCH_METHODS.has(lg.method)) {
          review.push({
            added_in_phase: 2,
            item: 'watch-method',
            file: o.file,
            line: o.line,
            detail: `.${lg.method}('…') with CJK argument at ${o.file}:${o.line} — separator/pattern semantics; safe only because both producer and consumer share the corpus id (${e.id}). Confirm translation keeps them consistent.`,
          });
        }
        continue; // unknown methods (expect/map_err/push/…) are production, not matching
      }
      if (o.tool === 'rust') {
        // rust matches OS/external text (error strings, file names) — C
        denyOccurrences.push({
          file: o.file,
          line: o.line,
          source: e.source,
          reason: `class C: Rust .${lg.method}() on external text (receiver: ${lg.receiver})`,
        });
        rows.push({ source: e.source, file: o.file, line: o.line, cls: 'C', decision: `deny occurrence (.${lg.method} on "${lg.receiver}")` });
      } else {
        rows.push({ source: e.source, file: o.file, line: o.line, cls: 'B', decision: `pin fragment (TS .${lg.method} on backend message "${lg.receiver}")` });
      }
    } else if (lg.type === 'compare' || lg.type === 'case' || lg.type === 'match-arm' || lg.type === 'object-key' || lg.type === 'index') {
      rows.push({ source: e.source, file: o.file, line: o.line, cls: 'A', decision: `exact-match ${lg.type}${lg.op ? ' ' + lg.op : ''} — translate via shared id` });
    } else if (lg.type === 'call-arg') {
      // plain function call argument — production, not logic
    }
  }
}

// ─── fold occurrences into entry classes ──────────────────────────────────
// Logic occurrences: known match-method args and exact-match forms.
// Unknown method args (expect/map_err/push/…, known:false) and plain call
// args are PRODUCTION sites — they do not make an entry logic-only.
const isLogicOcc = (o) =>
  (o.logic?.type === 'method-arg' && o.logic.known) ||
  ['compare', 'case', 'match-arm', 'object-key', 'index'].includes(o.logic?.type);

const deniedOccKeys = new Set(denyOccurrences.map((d) => `${d.file}:${d.line}`));
const entryClass = new Map();
for (const e of corpus.entries) {
  let cls = 'U';
  const hasProduction = e.occurrences.some((o) => !isLogicOcc(o));
  for (const o of e.occurrences) {
    if (o.logic?.type === 'method-arg' && o.logic.known && o.tool === 'rust') continue; // C occurrence, folded separately
    if (o.logic?.type === 'method-arg' && o.logic.known) cls = cls === 'A' ? 'A+B' : 'B';
    else if (isLogicOcc(o)) cls = cls === 'B' ? 'A+B' : 'A';
  }
  entryClass.set(e.id, { cls, hasProduction });
}

// logic-only invariant — for EXACT-MATCH (A) literals only: a compared
// literal with no producing site matches external text → C. B fragments are
// expected to be logic-only (their production sites are the containing
// messages M); their external test is the no-M rule below.
for (const e of corpus.entries) {
  const { cls, hasProduction } = entryClass.get(e.id);
  const logicOnly = e.occurrences.length > 0 && !hasProduction;
  if (logicOnly && cls === 'A') {
    if (!denyIds[e.id]) {
      denyIds[e.id] = {
        source: e.source,
        reason: `class C (logic-only): every occurrence of this literal is a match/comparison with no producing site in the codebase — matched against external text`,
      };
    }
    entryClass.set(e.id, { cls: 'C', hasProduction });
    review.push({
      added_in_phase: 2,
      item: 'logic-only-literal',
      file: e.occurrences[0].file,
      line: e.occurrences[0].line,
      detail: `"${e.source.slice(0, 60)}" only ever appears in match positions — treated as external text (C, untranslated). Confirm.`,
    });
  }
}

// rust C-suspects whose entry has NO other occurrence → id-level deny as well
for (const e of corpus.entries) {
  const cOcc = e.occurrences.filter(
    (o) => o.logic?.type === 'method-arg' && o.logic.known && o.tool === 'rust'
  );
  if (cOcc.length === 0) continue;
  const nonC = e.occurrences.filter((o) => !deniedOccKeys.has(`${o.file}:${o.line}`));
  if (nonC.length === 0) {
    denyIds[e.id] = {
      source: e.source,
      reason: `class C: ${cOcc[0].logic.method}() on external text (receiver: ${cOcc[0].logic.receiver}) — no other occurrences`,
    };
  }
  for (const o of cOcc) {
    review.push({
      added_in_phase: 2,
      item: 'class-C-confirm',
      file: o.file,
      line: o.line,
      detail: `"${e.source.slice(0, 40)}" matched against external text via .${o.logic.method}() (receiver: ${o.logic.receiver}). Denylisted${nonC.length ? ' at this occurrence only' : ''}. Confirm this is Windows/external text.`,
    });
  }
}

// ─── B fragments: M-sets, pins, dependencies ──────────────────────────────
const fragments = [];
const byId = new Map(corpus.entries.map((e) => [e.id, e]));
for (const e of corpus.entries) {
  const { cls } = entryClass.get(e.id);
  if (cls !== 'B' && cls !== 'A+B') continue;
  if (/\{\d+\}|<[/\d]+>/.test(e.source)) {
    review.push({
      added_in_phase: 2,
      item: 'fragment-with-placeholders',
      file: e.occurrences[0].file,
      line: e.occurrences[0].line,
      detail: `class-B fragment "${e.source.slice(0, 60)}" contains placeholders/tags — cannot pin; kept untranslated pending manual resolution.`,
    });
    denyIds[e.id] = { source: e.source, reason: 'B fragment with placeholders — unpinnable, kept Chinese' };
    continue;
  }
  const ms = corpus.entries.filter((m) => m.id !== e.id && m.source.includes(e.source));
  if (ms.length === 0) {
    denyIds[e.id] = { source: e.source, reason: 'class C (no-M): B fragment no corpus message contains — matches external text' };
    review.push({
      added_in_phase: 2,
      item: 'no-M-fragment',
      file: e.occurrences[0].file,
      line: e.occurrences[0].line,
      detail: `Fragment "${e.source.slice(0, 60)}" is matched against text the codebase never produces → kept untranslated (C). Confirm.`,
    });
    continue;
  }
  const pinnedIn = [];
  for (const m of ms) {
    const { text, pins } = applyPins(m.source, [{ id: e.id, source: e.source }]);
    pinnedIn.push({ id: m.id, source: m.source, pinned_source: text, pin: Object.keys(pins)[0] });
  }
  // fragment chains: F contained in a longer fragment F′ → F must be inside F′_en
  const deps = corpus.entries
    .filter(
      (f) => f.id !== e.id && (entryClass.get(f.id)?.cls === 'B' || entryClass.get(f.id)?.cls === 'A+B') &&
        f.source.includes(e.source)
    )
    .map((f) => f.id);
  fragments.push({ id: e.id, source: e.source, deps, pinned_in: pinnedIn });
}

const pinned = {
  note: 'B fragments: translate fragments first (longest first — deps), then messages with {PN} tokens; substitute and validate M_en.includes(F_en).',
  fragments,
};
writeFileSync(`${outDir}/pinned.json`, JSON.stringify(pinned, null, 2) + '\n', 'utf8');
writeFileSync(
  `${outDir}/denylist.json`,
  JSON.stringify(
    {
      note: 'ids: never translate these entries. occurrences: deny only this occurrence (file:line), keep other occurrences translatable.',
      ids: denyIds,
      occurrences: denyOccurrences,
    },
    null,
    2
  ) + '\n',
  'utf8'
);

// ─── output: table + review JSON ──────────────────────────────────────────
const clsOf = (id) => entryClass.get(id)?.cls ?? '?';
const counts = {};
for (const e of corpus.entries) counts[clsOf(e.id)] = (counts[clsOf(e.id)] ?? 0) + 1;

const lines = [];
lines.push(`# Phase 2 classification — ${new Date().toISOString().slice(0, 10)}`);
lines.push('');
lines.push(`Entry classes: ${JSON.stringify(counts)} (A+B = exact-match and substring both)`);
lines.push('');
lines.push('## A / B / C occurrence table (logic sites only)');
lines.push('');
lines.push('| class | literal | site | decision |');
lines.push('|---|---|---|---|');
for (const r of rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
  lines.push(`| ${r.cls} | \`${r.source.slice(0, 40).replace(/\|/g, '\\|')}\` | ${r.file}:${r.line} | ${r.decision} |`);
}
lines.push('');
lines.push('## B fragments → pinned messages');
lines.push('');
for (const f of fragments) {
  lines.push(`### \`${f.source.slice(0, 60)}\` (${f.id})${f.deps.length ? ` deps: ${f.deps.join(', ')}` : ''}`);
  for (const m of f.pinned_in.slice(0, 8)) {
    lines.push(`- \`${m.pinned_source.slice(0, 90)}\` (${m.id})`);
  }
  if (f.pinned_in.length > 8) lines.push(`- … ${f.pinned_in.length - 8} more`);
  lines.push('');
}
const report = lines.join('\n');
if (get('--report')) writeFileSync(get('--report'), report + '\n', 'utf8');
console.log(report);
writeFileSync(`${outDir}/review-generated.json`, JSON.stringify(review, null, 2) + '\n', 'utf8');
console.log(`denylist: ${Object.keys(denyIds).length} ids, ${denyOccurrences.length} occurrences; fragments: ${fragments.length}; review items: ${review.length}`);
