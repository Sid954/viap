// Validators — plan §Phase 3.5. Reused verbatim by CI (Phase 6) over
// translations.json, so they must stay pure functions of (source, en).
import { hasCJK } from './cjk.mjs';
import { glossaryFor } from './glossary.mjs';

const FULLWIDTH_MAP = {
  '，': ',', '、': ',', '。': '.', '：': ':', '；': ';',
  '（': '(', '）': ')', '「': '"', '」': '"', '『': '"', '』': '"',
  '！': '!', '？': '?', '…': '...', '·': ' · ',
};

/** Convert full-width punctuation to ASCII (plan §7). Ellipsis '……' → '...'. */
export function sanitizePunctuation(s) {
  let out = s.replace(/……/g, '...').replace(/…/g, '...');
  out = out.replace(/[，、。：；（）「」『』！？·]/g, (c) => FULLWIDTH_MAP[c] ?? c);
  return out;
}

const PH_RE = /\{(\d+)\}/g;
const TAG_RE = /<(\/?)(\d+)(\/?)>/g;
const PIN_RE = /\{(P\d+)\}/g;

function all(re, s) {
  return s.match(re) ?? [];
}

/**
 * Validate a translation against its (normalized) source.
 * `pins` maps {PN} → fragment id when the source was pinned (optional).
 * Returns an array of violation strings; empty = valid.
 */
export function validate(source, en, opts = {}) {
  const errs = [];
  if (typeof en !== 'string' || en.trim() === '') return ['empty translation'];

  // 1. placeholder multiset
  const phS = all(PH_RE, source).sort().join(',');
  const phE = all(PH_RE, en).sort().join(',');
  if (phS !== phE) errs.push(`placeholders: source [${phS}] != output [${phE}]`);

  // 2. tag sequence (order + form)
  const tagsS = all(TAG_RE, source).join(' ');
  const tagsE = all(TAG_RE, en).join(' ');
  if (tagsS !== tagsE) errs.push(`tags: source [${tagsS}] != output [${tagsE}]`);

  // 3. pinned tokens
  const pinS = all(PIN_RE, source).sort().join(',');
  const pinE = all(PIN_RE, en).sort().join(',');
  if (pinS !== pinE) errs.push(`pins: source [${pinS}] != output [${pinE}]`);

  // 4. newlines preserved
  const nlS = (source.match(/\n/g) ?? []).length;
  const nlE = (en.match(/\n/g) ?? []).length;
  if (nlS !== nlE) errs.push(`newlines: source ${nlS} != output ${nlE}`);

  // 5. no remaining CJK (glossary proper nouns translate too)
  if (hasCJK(en)) errs.push('output still contains CJK');

  // 6. length sanity 0.4×–6×
  const ratio = en.length / Math.max(source.length, 1);
  if (ratio < 0.4 || ratio > 6) errs.push(`length ratio ${ratio.toFixed(2)} outside 0.4–6`);

  // 7. glossary compliance (case-insensitive, any option). Longest-match
  // wins: a shorter key fully inside a longer matched key (微信 inside
  // 企业微信, 校验 inside 完整性校验) must not double-require its own term.
  if (!opts.skipGlossary) {
    const matched = glossaryFor(source);
    for (const g of matched) {
      const shadowed = matched.some(
        (h) => h.zh.length > g.zh.length && h.zh.includes(g.zh)
      );
      if (shadowed) continue;
      const ok = g.en.some((opt) => en.toLowerCase().includes(opt.toLowerCase()));
      if (!ok) errs.push(`glossary: "${g.zh}" missing (${g.en.join('/')})`);
    }
  }

  return errs;
}

/**
 * Post-substitution containment for pinned entries: the final English must
 * contain every pinned fragment's English verbatim.
 */
export function validateContainment(finalEn, pinMap, enById) {
  const errs = [];
  for (const [token, fragId] of Object.entries(pinMap)) {
    const fragEn = enById[fragId];
    if (fragEn == null) {
      errs.push(`pin ${token}: fragment ${fragId} not translated yet`);
    } else if (!finalEn.includes(fragEn)) {
      errs.push(`pin ${token}: "${finalEn}" does not contain "${fragEn}"`);
    }
  }
  return errs;
}
