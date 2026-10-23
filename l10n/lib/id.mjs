import { createHash } from 'node:crypto';

// id = first 16 hex chars of sha1(utf8(NFC(normalized))) — l10n/SPEC.md §1.
// rust-tool/src/id.rs implements the identical algorithm; fixtures prove agreement.
export function corpusId(normalizedSource) {
  return createHash('sha1')
    .update(Buffer.from(normalizedSource.normalize('NFC'), 'utf8'))
    .digest('hex')
    .slice(0, 16);
}
