import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../platforms/bilibili.mjs', import.meta.url), 'utf8');
const end = source.indexOf('async function inspectBilibili');

function gates(settings, state) {
  const context = vm.createContext({
    pkg: {
      platformTitle: { bilibili: 'Title' }, bilibiliDescription: 'Body', bilibiliTags: [],
      bilibiliAllowedAutoTags: [], cover: {}, platformSettings: { bilibili: settings },
    },
    videoPath: '/tmp/video.mp4', fs: { readFileSync() { throw new Error('not called'); } },
    okGate: evidence => ({ ok: true, evidence }),
    failedGate: evidence => ({ ok: false, evidence }),
  });
  vm.runInContext(source.slice(0, end), context);
  context.state = state;
  return vm.runInContext('({ ai: bilibiliAiGeneratedGate(state), original: bilibiliOriginalGate(state) })', context);
}

test('Bilibili defaults to no-mark while retaining self-made evidence', () => {
  const result = gates({}, { noMark: true, aiGenerated: false, selfMade: true, creationInput: '内容无需标注 内容为自制' });
  assert.equal(result.ai.ok, true);
  assert.equal(result.original.ok, true);
  assert.equal(result.original.evidence.selfMade, true);
});

test('Bilibili AI declaration requires observed AI label and self-made declaration', () => {
  const requested = { aiGenerated: true };
  for (const state of [
    { noMark: true, aiGenerated: false, selfMade: true },
    { noMark: false, aiGenerated: false, selfMade: true },
    { noMark: false, aiGenerated: true, selfMade: false },
    { noMark: true, aiGenerated: true, selfMade: true },
  ]) {
    const result = gates(requested, state);
    assert.equal(result.ai.ok, state.aiGenerated === true && state.noMark !== true, JSON.stringify(state));
    assert.equal(result.original.ok, false, JSON.stringify(state));
  }
  const valid = gates(requested, { noMark: false, aiGenerated: true, selfMade: true, aiGeneratedLabel: 'AI生成内容' });
  assert.equal(valid.ai.ok, true);
  assert.equal(valid.original.ok, true);
  assert.equal(valid.original.evidence.aiGenerated, true);
  assert.equal(valid.original.evidence.selfMade, true);
});
