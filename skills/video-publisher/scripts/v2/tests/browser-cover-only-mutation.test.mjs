import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { browserRevisionSourceCode } from './persistence-fixture.mjs';

const sources = Object.fromEntries(['bilibili', 'wechat-channels'].map(name => [name,
  fs.readFileSync(new URL(`../platforms/${name}.mjs`, import.meta.url), 'utf8')]));

function harness(platform, { revision = true, failedGate = '', nativeId = 'source-id', bound = true,
  invalidSource = false, dialogs = [], guard = { armed: true, blockedAttempts: 0 }, recoveryFailure = false,
  postRecoveryFailure = '', uploadFailure = false, pageBlocker = null } = {}) {
  const bili = platform === 'bilibili';
  const origin = bili ? 'https://member.bilibili.com' : 'https://channels.weixin.qq.com';
  const keys = bili ? ['authenticated', 'draftIdentity', 'video', 'title', 'description', 'tags', 'original', 'finalButton']
    : ['authenticated', 'draftIdentity', 'video', 'description', 'shortTitle', 'original', 'finalButton'];
  const state = { gates: Object.fromEntries(keys.map(key => [key, { ok: true }])), ...(pageBlocker ? { blocker: pageBlocker } : {}) };
  state.gates.draftIdentity.evidence = { restoredIdentity: { ok: bound, existingDraft: bound, actualId: bound ? nativeId : null } };
  state.gates.cover = { ok: false, evidence: { layout: 'separate' } };
  state.gates.noBlockingDialog = { ok: dialogs.length === 0, evidence: { active: dialogs.map(text => ({ text })) } };
  if (failedGate) state.gates[failedGate] = { ...state.gates[failedGate], ok: false };
  const calls = [];
  const inspect = async () => structuredClone(state);
  const receipt = { version: 2, assetPath: '/cover-4x3.webp', ratio: '4:3', afterUrl: `${origin}/accepted-cover` };
  const upload = async asset => {
    calls.push(asset ? `cover:${asset.slot}` : 'cover');
    if (uploadFailure) return { ok: false, reason: 'cover rejected' };
    state.gates.cover.ok = true;
    state.gates.noBlockingDialog = { ok: true, evidence: { active: [] } };
    return { ok: true, receipt: asset ? { ...receipt, assetPath: asset.path, ratio: asset.ratio } : receipt };
  };
  const context = vm.createContext({
    platform, jobFingerprint: 'current', videoPath: '/video.mp4',
    pkg: { platformTitle: { bilibili: 'Approved title' }, bilibiliDescription: 'Approved body', bilibiliTags: ['AI'],
      bilibiliAllowedAutoTags: [], wechatDescription: 'Approved body #AI',
      cover: { uploadCustomCover: true, horizontal4x3Path: '/cover-4x3.webp', vertical3x4Path: '/cover-3x4.webp' } },
    coverRevisionContext: revision ? { previousFingerprint: 'previous', nextFingerprint: 'current', sourceFingerprint: 'previous',
      sourceDraftId: 'source-id', sourcePersistedDraft: { version: 2, platform, fingerprint: invalidSource ? 'foreign' : 'previous',
        method: 'draft-list-reopen', draftId: 'source-id', reopenedId: 'source-id', listEntryId: 'source-id', documentChanged: true,
        listUrl: `${origin}/drafts`, reopenedUrl: `${origin}/draft/source-id` } } : null,
    expectedReceipts: {}, URL,
    inspectFinalPublishGuard: async () => guard,
    checkpointReceipts: value => { calls.push('checkpoint'); return { ok: true }; },
    setNativeInputValue: async () => { calls.push('title'); state.gates.title.ok = true; return { ok: true }; },
    typedBlocker: (code, message, extra = {}) => ({ code, message, ...extra }),
    inspectStub: inspect, uploadStub: upload,
    descriptionStub: async () => { calls.push('description'); state.gates.description.ok = true; return { ok: true }; },
    declarationStub: async () => { calls.push('original'); state.gates.original.ok = true; return { ok: true }; },
    tagsStub: async () => { calls.push('tags'); state.gates.tags.ok = true; return { ok: true }; },
    metadataStub: async () => { calls.push('metadata'); state.gates.description.ok = true; state.gates.shortTitle.ok = true;
      return { ok: true, actions: {}, current: await inspect() }; },
    recoveryStub: async () => { calls.push('coverRecovery');
      if (recoveryFailure) return { ok: false, reason: 'known cover dialog did not close' };
      state.gates.noBlockingDialog = { ok: true, evidence: { active: [] } };
      if (postRecoveryFailure) state.gates[postRecoveryFailure] = { ...state.gates[postRecoveryFailure], ok: false };
      return { ok: true, dismissed: true }; },
  });
  const overrides = bili
    ? 'inspectBilibili=inspectStub;uploadBilibiliCoverV2=uploadStub;setBilibiliDescriptionV2=descriptionStub;ensureBilibiliDeclarationV2=declarationStub;rebuildBilibiliTagsV2=tagsStub;'
    : 'inspectWechatChannels=inspectStub;uploadWechatCover=uploadStub;ensureWechatEarlyMetadata=metadataStub;ensureWechatOriginal=declarationStub;dismissWechatCoverEditor=recoveryStub;';
  vm.runInContext(browserRevisionSourceCode + sources[bili ? 'bilibili' : 'wechat-channels'] + '\n' + overrides, context);
  return { run: () => vm.runInContext(bili ? 'mutateBilibili()' : 'mutateWechatChannels()', context), calls };
}

for (const platform of ['bilibili', 'wechat_channels']) {
  test(`${platform} cover-only mutation changes only the requested covers and receipt checkpoint`, async () => {
    const h = harness(platform);
    const result = await h.run();
    assert.equal(result.blocker || null, null);
    assert.equal(result.actions.coverOnly, true);
    assert.equal(result.gates.cover.ok, true);
    assert.deepEqual(h.calls.filter(call => call !== 'checkpoint'), platform === 'bilibili' ? ['cover'] : ['cover:vertical', 'cover:horizontal']);
    assert.ok(result.receipts.cover);
  });

  test(`${platform} cover-only mutation refuses each changed non-cover business field with no side effects`, async () => {
    const fields = platform === 'bilibili'
      ? ['authenticated', 'draftIdentity', 'video', 'title', 'description', 'tags', 'original', 'finalButton']
      : ['authenticated', 'draftIdentity', 'video', 'description', 'shortTitle', 'original', 'finalButton'];
    for (const failedGate of fields) {
      const h = harness(platform, { failedGate });
      const result = await h.run();
      assert.equal(result.blocker.code, 'STATE_AMBIGUOUS', failedGate);
      assert.ok(result.blocker.evidence.missing?.includes(failedGate) || result.blocker.evidence.missing === undefined);
      assert.deepEqual(h.calls, [], failedGate);
    }
  });

  test(`${platform} cover-only mutation refuses an unbound or foreign native editor even if content matches`, async () => {
    for (const options of [{ bound: false }, { nativeId: 'foreign-id' }]) {
      const h = harness(platform, options);
      const result = await h.run();
      assert.equal(result.blocker.code, 'STATE_AMBIGUOUS');
      assert.deepEqual(h.calls, []);
    }
    const invalid = harness(platform, { invalidSource: true });
    await assert.rejects(invalid.run(), /original saved native draft/);
    assert.deepEqual(invalid.calls, []);
  });

  test(`${platform} cover-only mutation requires armed guard and zero blocked attempts`, async () => {
    for (const guard of [{ armed: false, blockedAttempts: 0 }, { armed: true, blockedAttempts: 1 }]) {
      const h = harness(platform, { guard });
      assert.equal((await h.run()).blocker.code, 'STATE_AMBIGUOUS');
      assert.deepEqual(h.calls, []);
    }
  });

  test(`${platform} cover-only mutation never dismisses an unknown or mixed dialog`, async () => {
    for (const dialogs of [['原创声明须知'], ['编辑封面 上传封面 取消 确认', '安全验证']]) {
      const h = harness(platform, { dialogs });
      assert.equal((await h.run()).blocker.code, 'STATE_AMBIGUOUS');
      assert.deepEqual(h.calls, []);
    }
  });

  test(`${platform} cover-only mutation preserves a page blocker without any repair`, async () => {
    const h = harness(platform, { pageBlocker: { code: 'RISK_CONTROL', message: 'load failed' } });
    assert.equal((await h.run()).blocker.code, 'RISK_CONTROL');
    assert.deepEqual(h.calls, []);
  });

  test(`${platform} ordinary mutation retains metadata and declaration handling`, async () => {
    const h = harness(platform, { revision: false, failedGate: platform === 'bilibili' ? 'title' : 'description' });
    const result = await h.run();
    assert.equal(result.blocker || null, null);
    assert.ok(h.calls.includes(platform === 'bilibili' ? 'title' : 'metadata'));
    if (platform === 'wechat_channels') assert.ok(h.calls.includes('original'));
    assert.equal(result.actions.coverOnly, undefined);
  });
}

test('Bilibili cover-only mutation can continue only the known cover editor', async () => {
  const h = harness('bilibili', { dialogs: ['封面制作 首页推荐封面（4:3） 上传封面 完成'] });
  assert.equal((await h.run()).blocker || null, null);
  assert.deepEqual(h.calls, ['cover', 'checkpoint']);
});

test('WeChat cover-only mutation recovers one known cover editor without metadata repair', async () => {
  const h = harness('wechat_channels', { dialogs: ['编辑封面 上传封面 取消 确认'] });
  assert.equal((await h.run()).blocker || null, null);
  assert.deepEqual(h.calls.filter(call => call !== 'checkpoint'), ['coverRecovery', 'cover:vertical', 'cover:horizontal']);
});

test('WeChat cover-only recovery rechecks original fields and never uploads on drift or failed dismissal', async () => {
  for (const options of [{ postRecoveryFailure: 'description' }, { postRecoveryFailure: 'draftIdentity' }, { recoveryFailure: true }]) {
    const h = harness('wechat_channels', { dialogs: ['裁剪封面图 确定 取消'], ...options });
    assert.equal((await h.run()).blocker.code, 'STATE_AMBIGUOUS');
    assert.deepEqual(h.calls, ['coverRecovery']);
  }
  const h = harness('wechat_channels', { failedGate: 'description', dialogs: ['编辑封面 上传封面 取消 确认'] });
  assert.equal((await h.run()).blocker.code, 'STATE_AMBIGUOUS');
  assert.deepEqual(h.calls, []);
});
