import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../ego/semantic-controls.mjs', import.meta.url), 'utf8');
const KEY = '__testGuard';

function harness({ phase = 'persist', duplicate = false } = {}) {
  const listeners = new Map();
  const state = { armed: true, blockedAttempts: [] };
  const root = { mode: 'closed', host: { tagName: 'XHS-PUBLISH-BTN' },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  const makeButton = text => ({ tagName: 'BUTTON', textContent: text, isConnected: true, disabled: false,
    ownerDocument: { defaultView: { [KEY]: state } },
    getRootNode: () => root,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 120, height: 40 }),
    matches: () => true,
    click() { this.clicked = (this.clicked || 0) + 1; },
  });
  const publish = makeButton('发布'), save = makeButton('暂存离开');
  const objects = { '1': publish, '2': save };
  if (duplicate) objects['3'] = makeButton('暂存离开');
  const sandbox = vm.createContext({ phase, FINAL_GUARD_KEY: KEY,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    armFinalPublishGuard: async () => {},
    inspectFinalPublishGuard: async () => ({ armed: state.armed, blockedAttempts: state.blockedAttempts.length }),
    cdp: async (method, args) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: Object.entries(objects).map(([id, b]) => ({
        role: { value: 'button' }, name: { value: b.textContent }, backendDOMNodeId: Number(id),
      })) };
      if (method === 'DOM.resolveNode') return { object: { objectId: String(args.backendNodeId) } };
      if (method === 'Runtime.callFunctionOn') {
        const fn = vm.runInContext(`(${args.functionDeclaration})`, sandbox);
        return { result: { value: fn.apply(objects[args.objectId], (args.arguments || []).map(x => x.value)) } };
      }
      throw new Error(`Unexpected CDP method ${method}`);
    },
  });
  vm.runInContext(source, sandbox);
  return { sandbox, state, root, listeners, publish, save, objects,
    run: expression => vm.runInContext(expression, sandbox) };
}

test('semantic controls resolve the actual closed-shadow native button', async () => {
  const h = harness();
  const buttons = await h.run('semanticButtons(/^发布$/g)');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].hostTag, 'XHS-PUBLISH-BTN');
  assert.equal(buttons[0].shadowMode, 'closed');
  h.publish.tagName = 'DIV';
  assert.equal((await h.run('semanticButtons(/^发布$/)')).length, 0);
});

test('closed-shadow guard blocks publish but allows dedicated draft save', async () => {
  const h = harness();
  await h.run('armClosedShadowPublishGuards(/^发布$/)');
  assert.equal((await h.run('inspectClosedShadowPublishGuards(/^发布$/)')).ok, true);
  let blocked = 0;
  const event = button => ({ type: 'click', composedPath: () => [button, h.root],
    preventDefault: () => blocked++, stopImmediatePropagation() {} });
  h.listeners.get('click')(event(h.save));
  assert.equal(blocked, 0);
  h.listeners.get('click')(event(h.publish));
  assert.equal(blocked, 1);
  assert.equal(h.state.blockedAttempts[0].scope, 'closed-shadow');
  assert.equal(h.publish.clicked, undefined);
});

test('replacement shadow root cannot inherit an earlier guarded-state claim', async () => {
  const h = harness();
  await h.run('armClosedShadowPublishGuards(/^发布$/)');
  h.publish.getRootNode = () => ({ mode: 'closed', host: h.root.host });
  assert.equal((await h.run('inspectClosedShadowPublishGuards(/^发布$/)')).ok, false);
});

test('guard rebinds when page state is replaced and stays idempotent', async () => {
  const h = harness();
  await h.run('armClosedShadowPublishGuards(/^发布$/)');
  const original = h.listeners.get('click');
  await h.run('armClosedShadowPublishGuards(/^发布$/)');
  assert.equal(h.listeners.get('click'), original);
  h.publish.ownerDocument.defaultView[KEY] = { armed: true, blockedAttempts: [] };
  assert.equal((await h.run('inspectClosedShadowPublishGuards(/^发布$/)')).ok, false);
  await h.run('armClosedShadowPublishGuards(/^发布$/)');
  assert.notEqual(h.listeners.get('click'), original);
  assert.equal((await h.run('inspectClosedShadowPublishGuards(/^发布$/)')).ok, true);
});

test('draft save refuses wrong phase, unsafe label and ambiguous native controls', async () => {
  const wrong = harness({ phase: 'verify' });
  await assert.rejects(wrong.run('clickDedicatedDraftButton(["暂存离开"])'), /only in persist/);
  const h = harness();
  for (const label of ['发布', '保存', 'Save', '安排时间']) {
    await assert.rejects(h.run(`clickDedicatedDraftButton([${JSON.stringify(label)}])`), /Unsafe/);
  }
  const duplicates = harness({ duplicate: true });
  assert.equal((await duplicates.run('clickDedicatedDraftButton(["暂存离开"])')).ok, false);
  assert.equal(duplicates.save.clicked, undefined);
});

test('save requires a clean guard and an enabled button', async () => {
  const h = harness();
  h.state.blockedAttempts.push({ type: 'click' });
  assert.equal((await h.run('clickDedicatedDraftButton(["暂存离开"])')).ok, false);
  h.state.blockedAttempts.length = 0;
  h.save.disabled = true;
  assert.equal((await h.run('clickDedicatedDraftButton(["暂存离开"])')).ok, false);
  h.save.disabled = false;
  assert.equal((await h.run('clickDedicatedDraftButton(["暂存离开"])')).ok, true);
  assert.equal(h.save.clicked, 1);
  assert.equal(h.publish.clicked, undefined);
});
