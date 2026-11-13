import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../platforms/wechat-channels.mjs', import.meta.url), 'utf8');

function gates(settings = {}) {
  const context = vm.createContext({
    pkg: { platformSettings: { wechat_channels: settings } },
    okGate: evidence => ({ ok: true, evidence }),
    failedGate: evidence => ({ ok: false, evidence }),
  });
  vm.runInContext(source.slice(0, source.indexOf('const wechatCustomCover')), context);
  return state => {
    context.state = state;
    return vm.runInContext('({ shortTitle: wechatShortTitleGate(state), aiGenerated: wechatAiGeneratedGate(state) })', context);
  };
}

test('WeChat leaves the short title empty by default and requires the exact requested value', () => {
  assert.equal(gates()({shortTitle:''}).shortTitle.ok, true);
  assert.equal(gates()({shortTitle:'stale'}).shortTitle.ok, false);
  const read = gates({ shortTitle: 'Agent工具区别' });
  assert.equal(read({shortTitle:'Agent工具区别',shortTitleFound:true}).shortTitle.ok, true);
  assert.equal(read({shortTitle:'Agent工具区别',shortTitleFound:false}).shortTitle.ok, false);
  assert.equal(read({shortTitle:'Agent工具',shortTitleFound:true}).shortTitle.ok, false);
});

test('WeChat requested AI generation requires independent observed evidence', () => {
  assert.equal(gates()({}).aiGenerated.ok, true);
  const read = gates({ aiGenerated: true });
  for (const state of [{}, {aiGenerated:false}, {aiGeneratedEvidence:{clicked:true}}]) {
    assert.equal(read(state).aiGenerated.ok, false);
  }
  assert.equal(read({aiGenerated:true}).aiGenerated.ok, true);
});

async function shortTitleHarness(value, initial = '', count = 1) {
  const events = [];
  class Input { constructor() { this._value = initial; this.placeholder = '请填写短标题'; } }
  Object.defineProperty(Input.prototype, 'value', { get() { return this._value; }, set(value) { this._value = value; } });
  Input.prototype.getBoundingClientRect = () => ({width:200,height:40});
  Input.prototype.dispatchEvent = event => events.push(event);
  const input = new Input();
  const document = { querySelectorAll: selector => selector === '*' ? [] : Array.from({length:count}, () => input) };
  class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  const page = vm.createContext({ document, HTMLInputElement: Input, InputEvent: Event, Event,
    getComputedStyle: () => ({display:'block',visibility:'visible'}) });
  const context = vm.createContext({ wechatShortTitle: value, js: expression => vm.runInContext(expression, page) });
  const start = source.indexOf('async function setWechatShortTitle()');
  const end = source.indexOf('async function ensureWechatOriginal()', start);
  vm.runInContext(source.slice(start, end), context);
  const result = await vm.runInContext('setWechatShortTitle()', context);
  return {result,input,events};
}

test('WeChat writes requested short title through native setter and leaves a matching field untouched', async () => {
  const changed = await shortTitleHarness('Agent工具区别');
  assert.equal(changed.result.ok,true);
  assert.equal(changed.input.value,'Agent工具区别');
  assert.deepEqual(changed.events.map(e => e.type), ['input','change']);
  const matching = await shortTitleHarness('Agent工具区别','Agent工具区别');
  assert.equal(matching.result.already,true);
  assert.equal(matching.events.length,0);
  const cleared = await shortTitleHarness('','stale');
  assert.equal(cleared.input.value,'');
  assert.equal(cleared.events[0].inputType,'deleteContentBackward');
});

test('WeChat refuses missing or ambiguous short-title input without dispatching changes', async () => {
  for (const count of [0, 2]) {
    const h = await shortTitleHarness('Agent工具区别','stale',count);
    assert.equal(h.result.ok,false);
    assert.equal(h.input.value,'stale');
    assert.equal(h.events.length,0);
  }
});
