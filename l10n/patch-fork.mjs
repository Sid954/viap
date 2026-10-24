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

// 6. Settings/donate/promo links: intentionally untouched (credit stays).

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
