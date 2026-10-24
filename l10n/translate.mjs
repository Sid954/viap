#!/usr/bin/env node
// Local-model translation engine — plan §Phase 3. Node 18+, zero deps.
//
//   node l10n/translate.mjs [--endpoint URL] [--pending data/pending.json]
//       [--out data/translations.json] [--batch 30] [--limit N] [--no-git]
//       [--model NAME]
//
// Endpoint: L10N_ENDPOINT or http://127.0.0.1:8080/v1/chat/completions
// (llama-server / LM Studio, OpenAI-compatible).
//
// Order: fragments inner-first (their English is substituted into the outer
// fragments and messages that pin them). Batches of --batch; on failures the
// batch halves, then single-string mode; after that the best attempt is kept
// flagged needs_review. temperature 0, fixed seed, JSON in/out.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt, buildUserMessage } from './lib/prompts.mjs';
import { sanitizePunctuation, validate, validateContainment } from './lib/validate.mjs';
import { substitutePins } from './lib/pins.mjs';

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const has = (k) => args.includes(k);

// data paths resolve against the l10n dir so translate.bat works from any cwd
const here = dirname(fileURLToPath(import.meta.url));
const resolveIn = (p) => (p && !p.match(/^[A-Za-z]:[\\/]/) && !p.startsWith('/') ? join(here, p) : p);
const PENDING = resolveIn(get('--pending') ?? 'data/pending.json');
const OUT = resolveIn(get('--out') ?? 'data/translations.json');
const MODEL_ARG = get('--model') ?? process.env.L10N_MODEL ?? null;
const BATCH = Number(get('--batch') ?? 15); // 15 keeps worst-case batches within a 12k ctx
const LIMIT = Number(get('--limit') ?? 0);
const NO_GIT = has('--no-git');

if (!existsSync(PENDING)) {
  console.log(`pending file ${PENDING} not found — nothing to do`);
  process.exit(0);
}
const pending = JSON.parse(readFileSync(PENDING, 'utf8'));
let items = pending.entries ?? [];
if (items.length === 0) {
  console.log('pending is empty — nothing to do');
  process.exit(0);
}
if (LIMIT > 0) items = items.slice(0, LIMIT);

// ─── server discovery (LlamaApp port varies; probe common candidates) ─────
const CANDIDATES = [
  get('--endpoint') ?? process.env.L10N_ENDPOINT,
  'http://127.0.0.1:8080',
  'http://127.0.0.1:1234',
  'http://127.0.0.1:9931',
  'http://127.0.0.1:52961',
  'http://127.0.0.1:11434',
].filter(Boolean);
let ENDPOINT = null;
let MODEL = MODEL_ARG;
for (const base0 of CANDIDATES) {
  const base = base0.replace(/\/v1\/chat\/completions$/, '').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) continue;
    const j = await r.json().catch(() => ({}));
    const ids = (j.data ?? []).map((m) => m.id).filter(Boolean);
    if (ids.length === 0 && !MODEL_ARG) continue;
    ENDPOINT = `${base}/v1/chat/completions`;
    if (!MODEL) MODEL = ids[0];
    console.log(`model server: ${base} (${MODEL})`);
    break;
  } catch {
    /* try next */
  }
}
if (!ENDPOINT) {
  console.error('no model server found on ports: ' + CANDIDATES.join(', '));
  console.error('Start the Llama app server (Qwen3-8B), or pass --endpoint URL.');
  process.exit(1);
}
const base = ENDPOINT.replace(/\/chat\/completions$/, '');

// ─── git pull (plan §3.1) ─────────────────────────────────────────────────
if (!NO_GIT) {
  try {
    execFileSync('git', ['pull', '--ff-only'], { stdio: 'pipe' });
  } catch (e) {
    console.warn(`git pull failed (${e.status ?? 'offline'}) — continuing with local state`);
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────
const SYSTEM = buildSystemPrompt();

async function chat(userMsg) {
  const mkBody = (jsonMode) => ({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userMsg },
    ],
    temperature: 0,
    seed: 42,
    stream: false,
    // disable Qwen3 thinking per-request (verified against llama.cpp b11706);
    // harmless if the server/model does not know the kwarg
    chat_template_kwargs: { enable_thinking: false },
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });
  let res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mkBody(true)),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok && res.status === 400) {
    // server may not support response_format — retry without it
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mkBody(false)),
      signal: AbortSignal.timeout(300000),
    });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('no message.content in response');
  return content;
}

function parseTranslations(content) {
  let s = content.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'');
  const cut = s.indexOf('{');
  const startArr = s.indexOf('[');
  const useArr = startArr !== -1 && (cut === -1 || startArr < cut);
  const j = JSON.parse(useArr ? s.slice(startArr) : s.slice(cut));
  const list = Array.isArray(j)
    ? j
    : Array.isArray(j.translations)
      ? j.translations
      : Object.entries(j).map(([id, en]) => ({ id, en }));
  const map = {};
  for (const t of list) {
    if (t && typeof t.id === 'string') map[t.id] = typeof t.en === 'string' ? t.en : '';
  }
  return map;
}

/**
 * Validate one item's raw model output against its pinned source, then
 * substitute pins and validate the final translation.
 * Returns { ok, final, errs, finalErrs }.
 */
function processItem(item, rawEn, enById) {
  const en = sanitizePunctuation(rawEn);
  const errs = validate(item.pinned_source, en);
  if (errs.length > 0) return { ok: false, final: en, errs, finalErrs: [] };
  if (Object.keys(item.pins ?? {}).length > 0) {
    const { text, missing } = substitutePins(en, item.pins, enById);
    if (missing.length) return { ok: false, final: en, errs: [`pins missing: ${missing}`], finalErrs: [] };
    const finalErrs = [
      ...validate(item.source, text),
      ...validateContainment(text, item.pins, enById),
    ];
    if (finalErrs.length > 0) return { ok: false, final: text, errs: [], finalErrs };
    return { ok: true, final: text, errs: [], finalErrs: [] };
  }
  return { ok: true, final: en, errs: [], finalErrs: [] };
}

// ─── main loop ────────────────────────────────────────────────────────────
const t0 = Date.now();
const results = {}; // id -> {en, model, ts, needs_review, attempts}
const attempts = {}; // id -> n
const bestAttempt = {}; // id -> best raw output
const enById = {}; // id -> final English (grows as we go, incl. prior translations)

// seed with existing translations (overrides/substitutions may depend on them)
if (existsSync(OUT)) {
  const prev = JSON.parse(readFileSync(OUT, 'utf8'));
  for (const [id, v] of Object.entries(prev)) {
    if (v && typeof v === 'object' && v.en) enById[id] = v.en;
  }
}

let queue = [...items];
let translated = 0;
let retriedIds = new Set();
let batchSize = Math.max(1, Math.min(BATCH, 40));
const MAX_ROUNDS = 3;
const TOTAL = items.length;

console.log(
  `translating ${TOTAL} strings in batches of ~${batchSize} (each batch takes 1–3 min; progress prints after every batch; Ctrl+C is safe — results are saved after each batch)`
);

function progressLine(failedCount) {
  const min = (Date.now() - t0) / 60000;
  const rate = translated / Math.max(min, 1e-9);
  const remaining = TOTAL - translated;
  const eta = rate > 0 ? (remaining / rate).toFixed(0) : '—';
  return `[${String(translated).padStart(String(TOTAL).length, ' ')}/${TOTAL}] ${rate.toFixed(1)}/min | ${min.toFixed(1)} min elapsed | ETA ~${eta} min${failedCount ? ` | ${failedCount} to retry` : ''}`;
}

// incremental checkpoint: merge current results into OUT after every batch
function checkpoint() {
  const prevOut = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  writeFileSync(OUT, JSON.stringify({ ...prevOut, ...results }, null, 2) + '\n', 'utf8');
}

for (let round = 1; round <= MAX_ROUNDS && queue.length > 0; round++) {
  const failed = [];
  for (let i = 0; i < queue.length; i += batchSize) {
    const chunk = queue.slice(i, i + batchSize);
    if (round === 1) {
      const preview = chunk[0].pinned_source.slice(0, 30).replace(/\n/g, ' ');
      console.log(`batch ${Math.floor(i / batchSize) + 1}: ${chunk.length} strings, starting "${preview}…"`);
    }
    let modelMap;
    try {
      const content = await chat(buildUserMessage(chunk.map((it) => ({
        id: it.id,
        source: it.pinned_source,
        kinds: it.kinds,
        hint: it.hint,
      }))));
      modelMap = parseTranslations(content);
    } catch (e) {
      console.warn(`batch request failed (round ${round}): ${e.message}`);
      failed.push(...chunk);
      continue;
    }
    let chunkOk = 0;
    for (const it of chunk) {
      attempts[it.id] = (attempts[it.id] ?? 0) + 1;
      if (attempts[it.id] > 1) retriedIds.add(it.id);
      const raw = modelMap[it.id];
      if (raw == null) {
        bestAttempt[it.id] ??= '';
        failed.push(it);
        continue;
      }
      bestAttempt[it.id] = raw;
      const r = processItem(it, raw, enById);
      if (r.ok) {
        results[it.id] = {
          en: r.final,
          model: MODEL,
          ts: new Date().toISOString(),
          needs_review: false,
          attempts: attempts[it.id],
        };
        enById[it.id] = r.final;
        translated += 1;
        chunkOk += 1;
      } else {
        console.warn(
          `invalid (${it.id}, attempt ${attempts[it.id]}): ${[...r.errs, ...r.finalErrs].join('; ').slice(0, 160)}`
        );
        failed.push(it);
      }
    }
    if (round === 1) {
      console.log(`  ${chunkOk}/${chunk.length} valid | ${progressLine(failed.length)}`);
      checkpoint();
    }
  }
  queue = failed;
  if (queue.length > 0 && round < MAX_ROUNDS) console.log(`retry round ${round + 1}: ${queue.length} strings, batch size ${Math.max(1, Math.floor(batchSize / 2))}`);
  batchSize = Math.max(1, Math.floor(batchSize / 2)); // smaller batches, then singles
}

// leftovers → needs_review with the best attempt kept (does not block);
// items that never received a single model response stay untranslated so
// they remain pending for the next run
const needsReview = [];
for (const it of queue) {
  if (!attempts[it.id]) continue; // no response ever — leave for next run
  const raw = bestAttempt[it.id] ?? '';
  const r = processItem(it, raw, enById);
  results[it.id] = {
    en: sanitizePunctuation(raw),
    model: MODEL,
    ts: new Date().toISOString(),
    needs_review: true,
    attempts: attempts[it.id] ?? 0,
    review_reasons: [...r.errs, ...r.finalErrs].slice(0, 5),
  };
  needsReview.push(it.id);
}

// fragment chain sanity over everything we now have
for (const [id, v] of Object.entries(results)) {
  if (v.needs_review) continue;
  // containment of nested fragments in fragments is enforced per item; nothing more here
  void id;
}

// ─── write results ────────────────────────────────────────────────────────
const prevOut = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const merged = { ...prevOut, ...results };
writeFileSync(OUT, JSON.stringify(merged, null, 2) + '\n', 'utf8');

const elapsedMin = (Date.now() - t0) / 60000;
const rate = elapsedMin > 0 ? (translated / elapsedMin).toFixed(1) : '∞';
console.log(
  `\ntranslate: ${translated} ok, ${retriedIds.size} retried, ${needsReview.length} needs_review, ${elapsedMin.toFixed(1)} min (${rate} strings/min)`
);
if (needsReview.length) console.log('needs_review ids:', needsReview.join(', '));

// ─── commit & push (plan §3.7) ───────────────────────────────────────────
if (!NO_GIT && translated > 0) {
  try {
    execFileSync('git', ['add', 'l10n/data'], { stdio: 'pipe' });
    execFileSync(
      'git',
      ['commit', '-m', `l10n: translate ${translated} strings (${pending.tag ?? 'batch'})`],
      { stdio: 'pipe' }
    );
    execFileSync('git', ['push'], { stdio: 'pipe' });
    console.log('committed and pushed l10n/data');
  } catch (e) {
    console.warn(`git commit/push failed: ${e.message?.slice(0, 120)}`);
  }
}
