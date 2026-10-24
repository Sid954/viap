#!/usr/bin/env node
// Tiny state-file helper used by CI workflows.
//   node l10n/state.mjs get <key>
//   node l10n/state.mjs set <key> <value>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), 'data', 'state.json');
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const [, , cmd, key, value] = process.argv;
if (cmd === 'get') {
  const v = state[key];
  console.log(v == null ? '' : String(v));
} else if (cmd === 'set') {
  state[key] = value;
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
  console.log(`${key} = ${value}`);
} else {
  console.error('usage: state.mjs get|set key [value]');
  process.exit(2);
}
