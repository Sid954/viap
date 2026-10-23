#!/usr/bin/env node
// Deterministic OpenAI-compatible mock for testing translate.mjs without a
// real model. Produces validator-passing pseudo-English (glossary terms are
// real English; remaining CJK chars become 'a'), with configurable failure
// injection:
//   node tests/mock-server.mjs [port] --fail <file.json>
// fail file: {"<id>": "drop-ph-once" | "always-cjk"}
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { glossarySorted } from '../lib/glossary.mjs';

const argv = process.argv.slice(2);
const failIdx = argv.indexOf('--fail');
const failFile = failIdx >= 0 ? argv[failIdx + 1] : null;
const port = Number(argv.find((a) => /^\d+$/.test(a)) ?? 8123);
const failRules = failFile ? JSON.parse(readFileSync(failFile, 'utf8')) : {};
const attempts = new Map(); // id -> request count

function mockTranslate(s) {
  let out = s;
  for (const g of glossarySorted()) out = out.split(g.zh).join(g.en[0]);
  return out.replace(/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60]/g, 'a');
}

function applyFailRules(id, en) {
  const rule = failRules[id];
  if (!rule) return en;
  const n = (attempts.get(id) ?? 0); // already incremented for this request
  if (rule === 'drop-ph-once') {
    if (n === 1) return en.replace('{0}', ''); // model drops a placeholder
    return en;
  }
  if (rule === 'always-cjk') return en + '中文'; // hopeless model output
  return en;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    return;
  }
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        const user = j.messages.find((m) => m.role === 'user').content;
        const jsonStart = user.indexOf('[');
        const items = JSON.parse(user.slice(jsonStart));
        const translations = items.map((it) => {
          attempts.set(it.id, (attempts.get(it.id) ?? 0) + 1);
          return { id: it.id, en: applyFailRules(it.id, mockTranslate(it.source)) };
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ translations }) } },
            ],
          })
        );
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock server on http://127.0.0.1:${port}/v1`);
});
