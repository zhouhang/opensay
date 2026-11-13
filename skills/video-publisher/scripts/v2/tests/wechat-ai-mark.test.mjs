import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../platforms/wechat-channels.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function ensureWechatAiGenerated');
const end = source.indexOf('async function ensureWechatOriginal', start);
assert.ok(start >= 0 && end > start);

function harness(sequence, inspected = true) {
  const calls = [];
  const context = vm.createContext({
    js: async expression => { calls.push(String(expression)); return sequence[calls.length - 1] ?? { ok: false, reason: 'unexpected call' }; },
    wait: async () => {},
    inspectWechatChannels: async () => ({ gates: { aiGenerated: inspected ? { ok: true, evidence: { requested: true, actual: '含AI生成内容' } } : { ok: false, evidence: { requested: true, actual: '选择视频标注' } } } }),
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, calls };
}

test('WeChat AI mark selects the exact visible 含AI生成内容 option and re-reads it', async () => {
  const h = harness([
    { ok: true, opened: true, actual: '选择视频标注', selector: '.mark-tag-select .select-display' },
    { ok: true, clicked: true, label: '含AI生成内容', selector: '.mark-tag-select .mark-tag-option .option-main' },
  ]);
  const result = await vm.runInContext('ensureWechatAiGenerated()', h.context);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0], /\.mark-tag-select/);
  assert.match(h.calls[1], /含AI生成内容/);
});

test('WeChat AI mark fails closed when the exact option is ambiguous', async () => {
  const h = harness([
    { ok: true, opened: true, actual: '选择视频标注', selector: '.mark-tag-select .select-display' },
    { ok: false, reason: 'wechat AI video-mark option is not unique or visible', count: 0 },
  ]);
  const result = await vm.runInContext('ensureWechatAiGenerated()', h.context);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not unique|visible/);
  assert.equal(h.calls.length, 2);
});
