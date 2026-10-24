#!/usr/bin/env node
// Phase 4 — fork patches (plan §Phase 4, exactly six edits). Every edit
// asserts its anchor count and is idempotent (already-patched → no-op).
//   node l10n/patch-fork.mjs --src <scratch dir> [--owner Sid954] [--repo viap]
//         [--pubkey-file <minisign .pub>]
// Pubkey resolution: --pubkey-file > l10n/data/pubkey.txt. Without either,
// the run FAILS — never guess a key.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const src = get('--src');
const OWNER = get('--owner') ?? 'Sid954';
const REPO = get('--repo') ?? 'viap';
const pubkeyFile = get('--pubkey-file') ?? join(here, 'data', 'pubkey.txt');
if (!src || !existsSync(pubkeyFile)) {
  console.error('usage: patch-fork.mjs --src DIR [--owner O --repo R --pubkey-file F]');
  console.error(`pubkey file missing: ${pubkeyFile}`);
  process.exit(2);
}
const PUBKEY = readFileSync(pubkeyFile, 'utf8').trim();
if (!PUBKEY.startsWith('dW50cnVzdGVk')) {
  console.error(`pubkey does not look like a minisign public key: ${PUBKEY.slice(0, 40)}…`);
  process.exit(2);
}

const UPSTREAM_PUBKEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDYxOURGMjI0MTFGMTE5NEEKUldSS0dmRVJKUEtkWVlEUjV1d3dvdVg4S2p6VUFLN1Q4enhraVVkZ01tcDU5MXpVRGEyNjN5R0UK';
const FORK_LATEST = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const UP_LATEST = 'https://github.com/Chunyu33/viap/releases/latest';

const edits = [];
function editFile(file, label) {
  const p = join(src, file);
  const text = existsSync(p) ? readFileSync(p, 'utf8') : null;
  return {
    file,
    label,
    read: () => readFileSync(p, 'utf8'),
    exists: () => text !== null,
    write: (t) => writeFileSync(p, t, 'utf8'),
  };
}
function applyReplacer(f, label, pairs) {
  let text = f.read();
  let changed = 0;
  for (const [oldStr, newStr, expect = 1] of pairs) {
    const nOld = text.split(oldStr).length - 1;
    const nNew = text.split(newStr).length - 1;
    if (nOld === expect && nNew === 0) {
      text = text.split(oldStr).join(newStr);
      changed += expect;
      edits.push(`${label}: replaced ${expect}× [${oldStr.slice(0, 48)}…]`);
    } else if (nOld === 0 && nNew >= expect) {
      edits.push(`${label}: already patched (${label.includes('pubkey') ? 'key' : newStr.slice(0, 48)})`);
    } else {
      console.error(
        `FAIL ${label}: anchor count mismatch for [${oldStr.slice(0, 60)}…] old=${nOld} (expected ${expect}) new=${nNew}`
      );
      process.exit(1);
    }
  }
  if (changed > 0) f.write(text);
}

// 1. tauri.conf.json — updater pubkey + endpoint (identifier kept: plan D1)
const conf = editFile('src-tauri/tauri.conf.json', 'tauri.conf.json');
applyReplacer(conf, 'tauri.conf.json updater', [
  [`"pubkey": "${UPSTREAM_PUBKEY}"`, `"pubkey": "${PUBKEY}"`],
  [
    `"${UP_LATEST}/download/latest.json"`,
    `"${FORK_LATEST}/download/latest.json"`,
  ],
]);

// 2. integrity/mod.rs — same pubkey + release base URL
const integrity = editFile('src-tauri/src/integrity/mod.rs', 'integrity/mod.rs');
applyReplacer(integrity, 'integrity updater key/url', [
  [`const UPDATER_PUBLIC_KEY: &str = "${UPSTREAM_PUBKEY}";`, `const UPDATER_PUBLIC_KEY: &str = "${PUBKEY}";`],
  [
    'const GITHUB_RELEASE_BASE_URL: &str = "https://github.com/Chunyu33/viap/releases/download";',
    `const GITHUB_RELEASE_BASE_URL: &str = "https://github.com/${OWNER}/${REPO}/releases/download";`,
  ],
]);

// 3. portable_update.rs — GitHub API latest-release URL
const portable = editFile('src-tauri/src/portable_update.rs', 'portable_update.rs');
applyReplacer(portable, 'portable update api url', [
  [
    '"https://api.github.com/repos/Chunyu33/viap/releases/latest"',
    `"https://api.github.com/repos/${OWNER}/${REPO}/releases/latest"`,
  ],
]);

// 4. useUpdater.ts — portable URLs; the Quark cloud link is repointed to the
//    fork (plan: do not leave a link to the author's Chinese cloud builds)
const updater = editFile('src/hooks/useUpdater.ts', 'useUpdater.ts');
applyReplacer(updater, 'useUpdater portable urls', [
  [`export const PORTABLE_UPDATE_URL = '${UP_LATEST}';`, `export const PORTABLE_UPDATE_URL = '${FORK_LATEST}';`],
  [
    "export const PORTABLE_CLOUD_UPDATE_URL = 'https://pan.quark.cn/s/4761ee4ba698';",
    `export const PORTABLE_CLOUD_UPDATE_URL = '${FORK_LATEST}';`,
  ],
]);

// 5. locale switches — the six sites from plan §3 (toLocaleString → en-US,
//    localeCompare → en)
const localeFiles = [
  'src/components/AppList.tsx',
  'src/pages/MigrationHistory.tsx',
  'src/components/LinkRecoveryModal.tsx',
  'src/pages/Settings.tsx',
];
for (const file of localeFiles) {
  const f = editFile(file, file);
  let text = f.read();
  const nTLS = text.split("toLocaleString('zh-CN'").length - 1;
  const nNewTLS = text.split("toLocaleString('en-US'").length - 1;
  if (nTLS > 0 && nNewTLS === 0) {
    text = text.split("toLocaleString('zh-CN'").join("toLocaleString('en-US'");
    edits.push(`${file}: ${nTLS}× toLocaleString → 'en-US'`);
  } else if (nTLS === 0 && nNewTLS > 0) {
    edits.push(`${file}: toLocaleString already 'en-US'`);
  } else if (nTLS > 0) {
    console.error(`FAIL ${file}: unexpected toLocaleString state zh=${nTLS} en=${nNewTLS}`);
    process.exit(1);
  }
  const cmpRe = /localeCompare\(([^)]*),\s*'zh-CN'\)/g;
  const nCmp = (text.match(cmpRe) ?? []).length;
  const nCmpEn = (text.match(/localeCompare\([^)]*,\s*'en'\)/g) ?? []).length;
  if (nCmp > 0 && nCmpEn === 0) {
    text = text.replace(cmpRe, (m, g1) => `localeCompare(${g1}, 'en')`);
    edits.push(`${file}: ${nCmp}× localeCompare → 'en'`);
  } else if (nCmp === 0 && nCmpEn > 0) {
    edits.push(`${file}: localeCompare already 'en'`);
  } else if (nCmp > 0) {
    console.error(`FAIL ${file}: unexpected localeCompare state zh=${nCmp} en=${nCmpEn}`);
    process.exit(1);
  }
  f.write(text);
}

// 6/7. Fork identity: About section + FeedbackModal (owner spec, credit
// preserved as an explicit "Original project" row; LICENSE untouched — MIT).
// All anchors are ASCII (URLs/identifiers) so they survive translation.
// Idempotent; balanced-JSX block removal; cleans dangling state/props/icons
// (tsconfig has noUnusedLocals/noUnusedParameters).
{
  const p = join(src, 'src/pages/Settings.tsx');
  let s = readFileSync(p, 'utf8');
  const before = s;

  const swapOnce = (oldStr, newStr, label) => {
    const nOld = s.split(oldStr).length - 1;
    if (nOld === 1) {
      s = s.replace(oldStr, newStr);
      edits.push(`Settings: ${label}`);
    } else if (nOld === 0) {
      edits.push(`Settings: ${label} (already)`);
    } else {
      console.error(`FAIL Settings ${label}: anchor count ${nOld}`);
      process.exit(1);
    }
  };

  // remove the balanced JSX block whose ROOT open tag is `rootTag` and which
  // contains `token`; includes the {/* comment */} line above the root
  const removeBlock = (token, rootTag, label) => {
    const ti = s.indexOf(token);
    if (ti === -1) {
      edits.push(`Settings: ${label} (already removed)`);
      return;
    }
    const start = s.lastIndexOf(rootTag, ti);
    if (start === -1 || ti - start > 3000) {
      console.error(`FAIL Settings ${label}: root ${rootTag} not found before anchor`);
      process.exit(1);
    }
    const tagRe = /<\/?([A-Za-z][\w.]*)[^>]*?(\/?)>/g;
    tagRe.lastIndex = start;
    let depth = 0;
    let end = -1;
    let m;
    while ((m = tagRe.exec(s))) {
      if (m[2] === '/') continue; // self-closing
      if (m[0].startsWith('</')) {
        depth -= 1;
        if (depth === 0) {
          end = tagRe.lastIndex;
          break;
        }
      } else {
        depth += 1;
      }
    }
    if (end === -1) {
      console.error(`FAIL Settings ${label}: unbalanced block`);
      process.exit(1);
    }
    // extend to end of line
    const eol = s.indexOf('\n', end);
    end = eol === -1 ? s.length : eol;
    // include the comment line above, if any
    let lineStart = s.lastIndexOf('\n', start) + 1;
    let cutStart = start;
    const lineAboveEnd = lineStart - 1;
    const lineAboveStart = s.lastIndexOf('\n', lineAboveEnd - 1) + 1;
    const lineAbove = s.slice(lineAboveStart, lineAboveEnd);
    if (/^\s*\{\/\//.test(lineAbove)) cutStart = lineAboveStart;
    s = s.slice(0, cutStart) + s.slice(end + 1); // also swallow one \n
    edits.push(`Settings: ${label}`);
  };

  const removeLineContaining = (needle, label) => {
    const lines = s.split('\n');
    const kept = lines.filter((l) => !l.includes(needle));
    if (kept.length === lines.length) {
      edits.push(`Settings: ${label} (already)`);
      return;
    }
    s = kept.join('\n');
    edits.push(`Settings: ${label}`);
  };

  // 7.1 website row → fork repo
  swapOnce('https://viap.evan666.cc/', `https://github.com/${OWNER}/${REPO}`, 'website → fork repo');
  // 7.2 GitHub row → fork repo + label
  // (gate on the label: the credits row inserted below re-uses the plain
  // upstream URL, so on a re-run the URL anchor alone is ambiguous)
  if (s.includes(`>${OWNER}</span>`)) {
    edits.push('Settings: github row → fork (already)');
  } else {
    swapOnce(`"https://github.com/Chunyu33/viap"`, `"https://github.com/${OWNER}/${REPO}"`, 'github row → fork');
    swapOnce('>Chunyu33</span>', `>${OWNER}</span>`, 'github label → Sid954');
  }
  // 7.3 changelog row → fork
  swapOnce(
    'https://github.com/Chunyu33/viap/blob/main/CHANGELOG.md',
    `https://github.com/${OWNER}/${REPO}/blob/main/CHANGELOG.md`,
    'changelog → fork'
  );
  // 7.4 credits row after the changelog row
  if (s.includes('Original project')) {
    edits.push('Settings: credits row (already)');
  } else {
    const anchor = `https://github.com/${OWNER}/${REPO}/blob/main/CHANGELOG.md`;
    const ai = s.indexOf(anchor);
    const closeA = s.indexOf('</a>', ai);
    if (ai === -1 || closeA === -1) {
      console.error('FAIL Settings: changelog anchor for credits row not found');
      process.exit(1);
    }
    const insertAt = closeA + 4;
    const creditsRow = [
      '',
      '            {/* original project credit */}',
      `            <a href="https://github.com/Chunyu33/viap" target="_blank" rel="noopener noreferrer"`,
      '              className="setting-item no-underline"',
      `              style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}>`,
      '              <div className="flex items-center gap-3">',
      `                <div className="w-8 h-8 rounded flex items-center justify-center" style={{ background: 'var(--bg-row-hover)' }}>`,
      `                  <Users className="w-4 h-4" style={{ color: 'var(--text-tertiary)' }} />`,
      '                </div>',
      `                <span className="text-[12px]" style={{ color: 'var(--text-primary)' }}>Original project</span>`,
      '              </div>',
      '              <div className="flex items-center gap-1.5">',
      `                <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Chunyu33 (Evan Lau)</span>`,
      `                <ExternalLink className="w-3 h-3" style={{ color: 'var(--text-tertiary)' }} />`,
      '              </div>',
      '            </a>',
    ].join('\n');
    s = s.slice(0, insertAt) + creditsRow + s.slice(insertAt);
    edits.push('Settings: credits row inserted (Chunyu33 / Evan Lau)');
  }
  // 7.5-7.8 row removals (root tags are the row containers, not inner buttons)
  removeBlock(`'bilibili'`, '<div className="setting-item"', 'removed B站/抖音 row');
  removeBlock(`, 'qq')`, '<div className="setting-item"', 'removed QQ group row');
  removeBlock('setPromoModalOpen(true)', '<button', 'removed promo row');
  removeBlock('setDonateModalOpen(true)', '<button', 'removed support-author row');
  // 7.9 modal renders
  removeLineContaining('<ProjectPromoModal ', 'removed ProjectPromoModal render');
  removeLineContaining('<DonateModal ', 'removed DonateModal render');
  // 7.10 imports
  removeLineContaining("import DonateModal from '../components/DonateModal';", 'removed DonateModal import');
  removeLineContaining("import ProjectPromoModal from '../components/ProjectPromoModal';", 'removed ProjectPromoModal import');
  // 7.11 dangling state
  removeLineContaining('[promoModalOpen, setPromoModalOpen]', 'removed promo state');
  removeLineContaining('[donateModalOpen, setDonateModalOpen]', 'removed donate state');

  // 7.12 strip icons that are no longer used anywhere in the file (rewrite
  // the possibly multi-line lucide-react import statement cleanly)
  {
    const strip = ['Video', 'Rocket', 'Heart'].filter(
      (icon) => (s.split(new RegExp(`\\b${icon}\\b`)).length - 1) === 1 // only the import remains
    );
    if (strip.length) {
      const importRe = /import\s*\{([^}]*)\}\s*from\s*'lucide-react';/;
      s = s.replace(importRe, (whole, names) => {
        const kept = names.split(',').map((n) => n.trim()).filter((n) => n && !strip.includes(n));
        return `import { ${kept.join(', ')} } from 'lucide-react';`;
      });
      edits.push(`Settings: stripped unused icons ${strip.join(', ')}`);
    }
  }

  // 7.13 FeedbackModal — issues URL to fork
  swapOnce(
    "'https://github.com/Chunyu33/viap/issues'",
    `'https://github.com/${OWNER}/${REPO}/issues'`,
    'ISSUES_URL → fork'
  );
  removeBlock(`onCopy(email, 'email')`, '<div style={rowStyle}', 'removed feedback email row');
  removeBlock('feedback-qq', '<div style={{', 'removed feedback QQ row');
  removeLineContaining("const QQ_GROUP = '834582563';", 'removed QQ_GROUP const');
  // valueStyle only served the removed email/QQ rows
  s = s.replace(/const valueStyle: React\.CSSProperties = \{[^}]*\};\n?/, '');
  edits.push('Settings: removed unused valueStyle');
  // email prop: type line, destructure, call site
  removeLineContaining('  email: string;', 'removed email prop type');
  s = s.replace(
    'function FeedbackModal({ isOpen, onClose, email, copiedLabel, onCopy }: {',
    'function FeedbackModal({ isOpen, onClose, copiedLabel, onCopy }: {'
  );
  s = s.replace(/\s*email=\{APP_INFO\.email\}/, '');

  if (s !== before) writeFileSync(p, s, 'utf8');
}

// final sweep — no 'zh-CN' may remain anywhere in frontend sources
const { execFileSync } = await import('node:child_process');
try {
  const out = execFileSync('git', ['-C', src, 'grep', "-n", "'zh-CN'", '--', 'src'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (out.trim()) {
    console.error(`FAIL: residual zh-CN locale tags:\n${out}`);
    process.exit(1);
  }
} catch (e) {
  const o = e.stdout ?? '';
  if (o.trim()) {
    console.error(`FAIL: residual zh-CN locale tags:\n${o}`);
    process.exit(1);
  }
}

console.log(edits.join('\n'));
console.log('patch-fork: all six edits applied/verified');
