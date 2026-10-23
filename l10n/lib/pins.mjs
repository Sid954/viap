// Pinned-fragment machinery (plan Phase 2, class B) — shared by classify.mjs
// (preview), translate.mjs (prompt building, Phase 3), and the Phase 6
// invariant tests.
//
// A fragment F (class B literal) must appear verbatim inside the English of
// every corpus message M that contained F, because runtime code does
// M.includes(F). We pin: replace F in M's source with {P1} before sending M
// to the model, then substitute {P1} → F's English afterwards.

/**
 * Replace fragments in a normalized source with {P1}, {P2}, … tokens,
 * longest fragment first (so nested fragments like 取消 inside
 * 用户取消了迁移 are consumed by the longer one), non-overlapping.
 *
 * @param {string} source normalized corpus source
 * @param {{id:string, source:string}[]} fragments class-B entries
 * @returns {{text:string, pins:Record<string,{id:string,source:string}>}}
 */
export function applyPins(source, fragments) {
  const sorted = [...fragments].sort((a, b) => b.source.length - a.source.length);
  let text = source;
  const pins = {};
  let n = 0;
  for (const f of sorted) {
    // longest-first order makes nested fragments (取消 inside 用户取消了迁移)
    // collapse into the longer pin; fragments not present are skipped
    if (!f.source || !text.includes(f.source)) continue;
    n += 1;
    const key = `P${n}`;
    pins[key] = { id: f.id, source: f.source };
    text = text.split(f.source).join(`{${key}}`);
  }
  return { text, pins };
}

/**
 * Substitute {PN} tokens with the fragment's English.
 * Returns { text, missing: string[] } — missing lists pins whose English is
 * absent from enById (dependency must be translated first).
 */
export function substitutePins(translated, pins, enById) {
  const missing = [];
  let text = translated;
  for (const [key, { id }] of Object.entries(pins)) {
    const en = enById[id];
    if (en == null) {
      missing.push(id);
      continue;
    }
    text = text.split(`{${key}}`).join(en);
  }
  return { text, missing };
}

/**
 * Validate a pinned translation (before substitution):
 * - every {PN} the source was given must still be present
 * - no unexpected {P…} tokens
 * Returns array of violation strings (empty = valid).
 */
export function validatePinned(translated, pins) {
  const errs = [];
  for (const key of Object.keys(pins)) {
    if (!translated.includes(`{${key}}`)) {
      errs.push(`dropped pin {${key}} (${pins[key].source})`);
    }
  }
  const leftovers = translated.match(/\{P\d+\}/g) ?? [];
  for (const tok of leftovers) {
    if (!(tok.slice(1, -1) in pins)) errs.push(`unknown pin ${tok}`);
  }
  return errs;
}
