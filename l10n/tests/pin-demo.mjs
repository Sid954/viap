#!/usr/bin/env node
// Phase 2 evidence: pin round-trip on the REAL v1.3.2 fragments.
// Shows, for every class-B fragment F: the pinned source the model would
// receive, a representative model output keeping {PN}, the substituted
// English, and the containment check M_en.includes(F_en). Also proves a
// dropped pin is caught.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { applyPins, substitutePins, validatePinned } from '../lib/pins.mjs';
import { corpusId } from '../lib/id.mjs';

const corpus = JSON.parse(readFileSync('../.l10n-work/corpus-v1.3.2.json', 'utf8'));
const byId = new Map(corpus.entries.map((e) => [e.id, e]));

// Demo English for the fragments (hand-written; the real translations come
// from the local model in Phase 3 — this proves the MECHANISM).
// Nested fragments (deps) require the OUTER English to contain the INNER
// English verbatim, case-sensitively: "Cancelled by user" ⊃ "Cancel",
// "the following programs are running" ⊃ "the following programs".
const FRAGMENT_EN = {
  [corpusId('卸载命令执行失败')]: 'uninstall command failed to run',
  [corpusId('用户取消了迁移')]: 'Cancelled by user',
  [corpusId('取消')]: 'Cancel',
  [corpusId('另一个恢复任务')]: 'another recovery task',
  [corpusId('检测到以下程序')]: 'the following programs',
  [corpusId('检测到以下程序正在运行')]: 'the following programs are running',
  [corpusId('仍检测到应用存在')]: 'the app is still present',
};

// Model simulation: for each pinned message we hand-write the {PN}-keeping
// output for one representative M per fragment (mechanism demo).
const MODEL_OUTPUT = new Map(
  [
    ['用户取消了迁移（目标路径已存在）', 'Migration was {P1} (the target path already exists)'],
    ['用户取消了迁移（目标路径已存在残留目录）', 'Migration was {P1} (leftover folders exist at the target path)'],
    ['检测到以下程序正在运行，请关闭后重试：\n{0}', '{P1}; close them and try again:\n{0}'],
    ['卸载命令已执行，但仍检测到应用存在：可能卸载程序还在后台运行，或未在卸载向导中确认完成：{0}',
      'The uninstall command ran, but {P1}: the uninstaller may still be running in the background or was not confirmed in its wizard: {0}'],
    ['卸载命令执行失败：{0}', 'The {P1}: {0}'],
    ['另一个恢复任务正在进行中，请等待完成后再试', '{P1} is in progress; wait for it to finish and try again'],
    ['取消迁移', '{P1} migration'],
    ['已取消', '{P1}ed'],
  ].map(([zh, en]) => [corpusId(zh), en])
);

const fragments = Object.keys(FRAGMENT_EN).map((id) => ({ id, source: byId.get(id).source }));

// dep-chain invariant: a fragment nested inside a longer fragment must have
// its English contained (verbatim, case-sensitive) in the longer one's
for (const F of fragments) {
  for (const G of fragments) {
    if (G.id !== F.id && G.source.includes(F.source)) {
      assert.ok(
        FRAGMENT_EN[G.id].includes(FRAGMENT_EN[F.id]),
        `nested fragment "${F.source}" English must appear inside "${G.source}" English: ` +
          `"${FRAGMENT_EN[G.id]}" ⊅ "${FRAGMENT_EN[F.id]}"`
      );
    }
  }
}

let demonstrated = 0;
const lines = [];
for (const F of fragments) {
  const ms = corpus.entries.filter((m) => m.id !== F.id && m.source.includes(F.source));
  assert.ok(ms.length > 0, `fragment ${F.source} must have containing messages`);
  // demonstrate on the first M that has a hand-written model output
  const M = ms.find((m) => MODEL_OUTPUT.has(m.id)) ?? ms[0];
  const { text: pinnedSource, pins } = applyPins(M.source, fragments);
  const modelOut =
    MODEL_OUTPUT.get(M.id) ??
    (() => {
      throw new Error(`no demo output for M: ${M.source}`);
    })();
  const violations = validatePinned(modelOut, pins);
  assert.deepEqual(violations, [], `pin violations for "${M.source}": ${violations}`);
  const { text: finalEn, missing } = substitutePins(modelOut, pins, FRAGMENT_EN);
  assert.deepEqual(missing, []);
  assert.ok(
    finalEn.includes(FRAGMENT_EN[F.id]),
    `"${finalEn}" must contain "${FRAGMENT_EN[F.id]}"`
  );
  demonstrated += 1;
  lines.push(`F="${F.source}"\n  M_pinned = ${JSON.stringify(pinnedSource)}\n  model   = ${JSON.stringify(modelOut)}\n  M_en    = ${JSON.stringify(finalEn)}  ✓ contains F_en`);
}
console.log(lines.join('\n'));
console.log(`\n${demonstrated}/7 fragments demonstrated: M_en.includes(F_en) holds after substitution`);

// deliberate failure: model drops the pin → caught before substitution
const { text: badSource, pins: badPins } = applyPins('用户取消了迁移（目标路径已存在）', fragments);
const badOut = 'Migration cancelled (target exists)'; // dropped {P1}
const caught = validatePinned(badOut, badPins);
assert.equal(caught.length, 1);
assert.match(caught[0], /dropped pin/);
console.log(`deliberate violation caught: ${caught[0]} ✓`);
