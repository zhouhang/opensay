import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(DIR, '..', 'platforms', 'wechat-channels.mjs'), 'utf8');
const typedBlocker = (code, message, options = {}) => ({ code, message, ...options });
const okGate = evidence => ({ ok: true, evidence });
const failedGate = evidence => ({ ok: false, evidence });
const helperStart = SOURCE.indexOf('function classifyWechatUploadText');
const helperEnd = SOURCE.indexOf('async function inspectWechatChannels', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const helpers = new Function('typedBlocker', `${SOURCE.slice(helperStart, helperEnd)}
return {classifyWechatUploadText, wechatUploadFailureBlocker, collectWechatFailureControls, classifyWechatPageShell, wechatPageShellBlocker};`)(typedBlocker);

function loadFunction(name, nextName, context) {
  const start = SOURCE.indexOf(`async function ${name}`);
  const end = SOURCE.indexOf(`async function ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `${name} must remain independently testable`);
  return new Function(...Object.keys(context), `${SOURCE.slice(start, end)}\nreturn ${name};`)(...Object.values(context));
}

const failureCopy = '视频号 · 助手 网络出错，请重新上传。 删除 封面预览 文件上传中，请等待完成后再编辑 编辑 个人主页卡片 3:4 编辑 分享卡片 4:3';

test('observed network failure wins over retained upload copy and cover cards', () => {
  const state = helpers.classifyWechatUploadText(failureCopy);
  assert.equal(state.failed, true);
  assert.equal(state.failureText, '网络出错');
  assert.equal(state.uploading, false);
  assert.equal(state.uploaded, false);
  const blocker = helpers.wechatUploadFailureBlocker(state);
  assert.equal(blocker.code, 'PLATFORM_REJECTED_ASSET');
  assert.equal(blocker.retryable, true);
  assert.equal(blocker.evidence.stage, 'video_upload');
});

test('all explicit failure variants remain terminal with and without stale progress', () => {
  for (const message of ['上传失败', '网络错误', '网络出错', '文件格式不支持']) {
    for (const suffix of ['', ' 100% 取消上传 封面预览 个人主页卡片 分享卡片']) {
      const state = helpers.classifyWechatUploadText(message + suffix);
      assert.equal(state.failed, true, message);
      assert.equal(state.uploading, false, message);
      assert.equal(state.uploaded, false, message);
    }
  }
});

test('progress and cover previews cannot pass the existing completion gate', () => {
  const state = helpers.classifyWechatUploadText('50% 取消上传 封面预览 个人主页卡片 分享卡片');
  assert.equal(state.failed, false);
  assert.equal(state.uploading, true);
  assert.equal(state.uploaded, false);
});

test('normal completed cover cards still qualify without misclassifying a retry label', () => {
  const state = helpers.classifyWechatUploadText('封面预览 个人主页卡片 分享卡片 重新上传');
  assert.equal(state.failed, false);
  assert.equal(state.uploading, false);
  assert.equal(state.uploaded, true);
  assert.equal(helpers.wechatUploadFailureBlocker(state), null);
});

function fakeDocument(text) {
  return {
    body: { innerText: text },
    querySelectorAll(selector) {
      return selector === 'input[type=file]' ? [{ accept: 'video/mp4', files: [] }] : [];
    },
  };
}

function evaluatePageExpression(text) {
  return expression => new Function('document', 'location', `return ${expression};`)(
    fakeDocument(text), { href: 'https://channels.weixin.qq.com/platform/post/create' },
  );
}

test('the actual SDK probe uses the failure classifier instead of accepting an input', async () => {
  const probe = loadFunction('getWechatUploadProbe', 'activateWechatLifecycle', {
    js: evaluatePageExpression(failureCopy), ...helpers,
  });
  const state = await probe();
  assert.equal(state.hasInput, true);
  assert.equal(state.failed, true);
  assert.equal(state.uploaded, false);
  assert.equal(state.uploading, false);
});

test('the actual inspector emits a failed video gate and explicit failure blocker', async () => {
  const inspect = loadFunction('inspectWechatChannels', 'getWechatUploadProbe', {
    ...helpers,
    js: evaluatePageExpression(failureCopy),
    expectedReceipts: {}, expectedVideoReceipt: null, jobFingerprint: 'test', activeTaskSpace: { id: 8 },
    wechatDescription: 'Approved description', wechatAiGenerated: false, wechatCustomCover: false, wechatCoverAssets: [],
    compactText: value => String(value || '').replace(/\s+/g, ' ').trim(),
    readWechatRestoredIdentity: async () => ({ existingDraft: false, ok: false }),
    inspectFinalButtons: async () => [],
    wechatShortTitleGate: () => okGate({}), wechatAiGeneratedGate: () => okGate({}),
    PLATFORM_URLS: { wechat_channels: 'https://channels.weixin.qq.com/platform/post/create' },
    okGate, failedGate,
  });
  const observation = await inspect();
  assert.equal(observation.gates.video.ok, false);
  assert.equal(observation.gates.video.evidence.failed, true);
  assert.equal(observation.gates.video.evidence.uploading, false);
  assert.equal(observation.blocker.code, 'PLATFORM_REJECTED_ASSET');
});

test('SDK readiness stops on explicit failure before navigation or injection', async () => {
  let activations = 0;
  const ready = loadFunction('waitWechatSdkReady', 'injectWechatVideo', {
    activateWechatLifecycle: async () => { activations += 1; },
    getWechatUploadProbe: async () => ({ hasInput: true, failed: true, uploading: false, uploaded: false }),
    wait: async () => { throw new Error('must not keep waiting after explicit failure'); },
  });
  const result = await ready(30);
  assert.equal(result.ok, false);
  assert.equal(result.probe.failed, true);
  assert.equal(activations, 1);
});

test('completion wait exits immediately on explicit failure instead of spending its timeout', async () => {
  const observation = { gates: { video: failedGate({ failed: true }) }, blocker: { code: 'PLATFORM_REJECTED_ASSET' } };
  const completion = loadFunction('waitWechatUploadCompletion', 'dispatchWechatUploadChange', {
    activateWechatLifecycle: async () => {}, inspectWechatChannels: async () => observation,
    wait: async () => { throw new Error('must not keep waiting after explicit failure'); },
  });
  assert.equal(await completion(), observation);
});

test('an unclassified blocker is returned without reinjection or retry UI actions', async () => {
  const observation = { blocker: { code: 'RISK_CONTROL' } };
  const start = loadFunction('startWechatChannelsUpload', 'uploadWechatChannels', {
    inspectWechatChannels: async () => observation,
    injectWechatVideo: async () => { throw new Error('failed target must not be overwritten'); },
  });
  assert.equal(await start(), observation);
});

test('cover work rechecks video failure before opening any editor', async () => {
  const live = { gates: { video: failedGate({ failed: true }) }, blocker: { code: 'PLATFORM_REJECTED_ASSET' } };
  const finish = loadFunction('finishWechatCoverMutation', 'runPlatformPhase', {
    inspectWechatChannels: async () => live,
    uploadWechatCover: async () => { throw new Error('must not open a cover editor on a failed video'); },
  });
  const result = await finish({ gates: { video: okGate({}) } }, { original: { ok: true } });
  assert.equal(result.blocker.code, 'PLATFORM_REJECTED_ASSET');
  assert.deepEqual(result.actions, { original: { ok: true } });
});

test('cover work also blocks a new progress state that appears after earlier checks', async () => {
  const live = { gates: { video: failedGate({ uploading: true }) } };
  const finish = loadFunction('finishWechatCoverMutation', 'runPlatformPhase', {
    inspectWechatChannels: async () => live, typedBlocker,
    uploadWechatCover: async () => { throw new Error('must not open cover editor while uploading'); },
  });
  const result = await finish({ gates: { video: okGate({}) } });
  assert.equal(result.blocker.code, 'STATE_AMBIGUOUS');
  assert.equal(result.gates.video.ok, false);
});

test('failure diagnostics stay inside the nearest panel and redact media/auth attributes', () => {
  let root;
  const node = (tag, text, className = '', extra = {}) => ({
    nodeType: 1, tagName: tag, innerText: text, textContent: text, className,
    children: [], parentElement: null, disabled: false,
    outerHTML: `<${tag.toLowerCase()} class="${className}">${text}</${tag.toLowerCase()}>`,
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 100, height: 30 }),
    getAttribute: () => null,
    getRootNode: () => root,
    contains(other) { return this === other || this.querySelectorAll('*').includes(other); },
    querySelectorAll(selector) {
      const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return all;
      if (selector === 'input[type="file"]') return all.filter(child => child.tagName === 'INPUT');
      if (selector === 'div,span') return all.filter(child => ['DIV', 'SPAN'].includes(child.tagName));
      return all.filter(child => child.tagName === 'BUTTON');
    },
    ...extra,
  });
  const error = node('DIV', '网络出错，请重新上传。', 'upload-error');
  const retry = node('BUTTON', '重新上传', 'retry-btn', {
    outerHTML: '<button class="retry-btn" data-token="private" href="https://upload.example/?token=secret">重新上传</button>',
  });
  const file = node('INPUT', '', '', {
    accept: 'video/mp4', files: [], outerHTML: '<input type="file" accept="video/mp4" value="private-path">',
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  });
  const panel = node('DIV', error.innerText + ' 重新上传', 'failed-video');
  panel.children = [error, retry, file];
  for (const child of panel.children) child.parentElement = panel;
  const unrelatedDelete = node('BUTTON', '删除', 'delete-existing-draft');
  const editor = node('DIV', panel.innerText + ' 视频描述 保存草稿 删除', 'editor');
  editor.children = [panel, unrelatedDelete]; panel.parentElement = editor; unrelatedDelete.parentElement = editor;
  root = { querySelectorAll: () => [editor, ...editor.querySelectorAll('*')], elementFromPoint: () => retry };
  const collect = new Function('getComputedStyle', 'document', `return (${helpers.collectWechatFailureControls.toString()});`)(
    () => ({ display: 'block', visibility: 'visible', opacity: '1' }), root,
  );
  const result = collect([root], editor.innerText);
  assert.equal(result.panels.length, 1);
  assert.equal(result.panels[0].panel.class, 'failed-video');
  assert.deepEqual(result.panels[0].controls.map(control => control.text), ['重新上传']);
  assert.equal(result.panels[0].controls[0].hitWithinControl, true);
  assert.equal(result.panels[0].inputs[0].filesCount, 0);
  assert.equal(result.panels[0].inputs[0].accept, 'video/mp4');
  assert.doesNotMatch(JSON.stringify(result), /private|secret|upload\.example|delete-existing-draft/);
});
