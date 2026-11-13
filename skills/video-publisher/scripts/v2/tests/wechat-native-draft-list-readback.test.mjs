import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../platforms/wechat-channels-persistence.mjs', import.meta.url), 'utf8');
const reader = source.slice(source.indexOf('async function readWechatDraftList()'), source.indexOf('async function readWechatRestoredIdentity()'));
const nativeUrl = 'https://channels.weixin.qq.com/platform/post/draftListManager';
const record = { objectId: 'export/original-native-id', desc: { description: 'Original description #topic',
  media: [{ thumbUrl: 'https://finder.video.qq.com/native-cover.jpg' }] }, mediaType: 2 };

function node({ controller, post, hidden = false, parent = null } = {}) {
  return { __vue__: controller || (post === undefined ? undefined : { post }), parentElement: parent,
    style: { display: hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' },
    getBoundingClientRect: () => ({ width: 300, height: 180 }), getRootNode: () => ({}) };
}

function fixture({ url = nativeUrl, posts = [record], loading = false, missingController = false,
  duplicateControllers = false, legacy = false, hiddenParent = false, shadow = false, loadAfter = false } = {}) {
  let reads = 0, waits = 0, legacyFetches = 0, forbiddenFetches = 0;
  const nativeController = { listLoading: loading,
    getFetchTaskList() { forbiddenFetches++; throw new Error('native fetch method must never run'); },
    goToPost() { throw new Error('navigation method must never run'); } };
  const parent = hiddenParent ? node({ hidden: true }) : null;
  const rows = posts.map(post => node({ post, parent }));
  if (!missingController) for (const row of rows) row.__vue__.$parent = nativeController;
  const lists = missingController ? [] : [node({ controller: nativeController })];
  if (duplicateControllers) lists.push(node({ controller: { ...nativeController } }));
  const legacyNode = legacy ? node({ controller: { draftStore: { list: [record], async getDraftList() { legacyFetches++; } } } }) : null;
  const elements = [...rows, ...lists, ...(legacyNode ? [legacyNode] : [])];
  const query = selector => selector === '*' ? elements : selector === 'button' ? []
    : selector === '.post-draft-item' ? rows : selector === '.post-list' ? lists : [];
  const shadowRoot = { querySelectorAll: query };
  const host = node(); host.shadowRoot = shadowRoot;
  const document = { querySelectorAll: selector => shadow ? selector === '*' ? [host] : [] : query(selector) };
  const browser = vm.createContext({ document, location: { href: url }, URL,
    getComputedStyle: element => element.style, console });
  const context = vm.createContext({
    js: async expression => { reads++; if (loadAfter && reads === 2) nativeController.listLoading = false;
      return vm.runInContext(expression, browser); },
    wait: async seconds => { assert.equal(seconds, 0.5); waits++; },
  });
  vm.runInContext(reader, context);
  return { run: () => vm.runInContext('readWechatDraftList()', context),
    counts: () => ({ reads, waits, legacyFetches, forbiddenFetches }) };
}

test('new native list reads visible Vue posts without invoking fetch/navigation methods', async () => {
  const f = fixture(), result = JSON.parse(JSON.stringify(await f.run()));
  assert.deepEqual(result, [{ objectId: record.objectId, description: record.desc.description, mediaType: 2,
    coverUrl: record.desc.media[0].thumbUrl, readbackSource: 'visible-native-post-draft-item',
    nativeListUrl: nativeUrl, listLoading: false }]);
  assert.deepEqual(f.counts(), { reads: 1, waits: 0, legacyFetches: 0, forbiddenFetches: 0 });
});

test('the existing real draftStore route remains preferred and unchanged', async () => {
  const f = fixture({ legacy: true, url: 'https://channels.weixin.qq.com/platform/post/create' });
  const result = JSON.parse(JSON.stringify(await f.run()));
  assert.deepEqual(result, [{ objectId: record.objectId, description: record.desc.description, mediaType: 2,
    coverUrl: record.desc.media[0].thumbUrl }]);
  assert.equal(f.counts().legacyFetches, 1); assert.equal(f.counts().forbiddenFetches, 0);
});

test('native list rows can be read inside the existing open shadow root', async () => {
  const f = fixture({ shadow: true }), result = await f.run();
  assert.equal(result[0].objectId, record.objectId); assert.equal(f.counts().forbiddenFetches, 0);
});

test('fallback refuses other routes/origins and never invents empty or hidden-row results', async () => {
  for (const options of [
    { url: 'https://channels.weixin.qq.com/platform/post/create' },
    { url: 'https://foreign.example/platform/post/draftListManager' },
    { posts: [] }, { hiddenParent: true }, { missingController: true }, { duplicateControllers: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.run(), /WeChat native draft store unavailable/);
    assert.equal(f.counts().forbiddenFetches, 0);
  }
});

test('loading must explicitly finish before native rows become evidence', async () => {
  const pending = fixture({ loading: true });
  await assert.rejects(pending.run(), /finished-loading controller/);
  assert.equal(pending.counts().reads, 20); assert.equal(pending.counts().forbiddenFetches, 0);
  const finished = fixture({ loading: true, loadAfter: true });
  assert.equal((await finished.run())[0].objectId, record.objectId);
  assert.equal(finished.counts().reads, 2); assert.equal(finished.counts().waits, 1);
});

test('missing or duplicate native objectIds block instead of silently dropping rows', async () => {
  for (const posts of [[{ ...record, objectId: '' }], [{ ...record, objectId: '  ' }], [record, { ...record }]]) {
    const f = fixture({ posts });
    await assert.rejects(f.run(), /nonempty native objectId|duplicate objectIds/);
    assert.equal(f.counts().reads, 1); assert.equal(f.counts().forbiddenFetches, 0);
  }
});
