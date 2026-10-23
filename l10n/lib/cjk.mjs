// CJK detection — ranges MUST match l10n/SPEC.md §2 and rust-tool/src/cjk.rs
export const CJK_RE =
  /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60]/;

export function hasCJK(s) {
  return typeof s === 'string' && CJK_RE.test(s);
}
