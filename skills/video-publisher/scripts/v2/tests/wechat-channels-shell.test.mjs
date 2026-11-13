import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(DIR, '..', 'platforms', 'wechat-channels.mjs');

function loadShellClassifier() {
  const source = fs.readFileSync(ADAPTER, 'utf8');
  const start = source.indexOf('function classifyWechatPageShell');
  const end = source.indexOf('async function inspectWechatChannels', start);
  assert.ok(start >= 0 && end > start, 'the WeChat page-shell classifier must remain independently testable');
  const typedBlocker = (code, message, options = {}) => ({
    code,
    message,
    retryable: options.retryable === true,
    requiresUser: options.requiresUser === true,
    evidence: options.evidence || null,
  });
  return new Function('typedBlocker', `${source.slice(start, end)}\nreturn { classifyWechatPageShell, wechatPageShellBlocker };`)(typedBlocker);
}

const emptyEditorMarkers = {
  wujieRoot: false,
  videoInput: false,
  descriptionEditor: false,
  shortTitleInput: false,
  coverCard: false,
  originalControl: false,
};

test('WeChat login shell wins over its adjacent load-failure copy', () => {
  const { classifyWechatPageShell, wechatPageShellBlocker } = loadShellClassifier();
  const shell = classifyWechatPageShell({
    text: '视频号助手 登录视频号助手 加载失败，点击重试',
    url: 'https://channels.weixin.qq.com/platform/post/create',
    rootCount: 1,
    editorMarkers: emptyEditorMarkers,
  });
  const blocker = wechatPageShellBlocker(shell);

  assert.equal(shell.login.required, true);
  assert.equal(shell.load.failed, true);
  assert.equal(blocker.code, 'AUTH_REQUIRED');
  assert.equal(blocker.requiresUser, true);
  assert.equal(blocker.retryable, false);
  assert.deepEqual(Object.keys(blocker.evidence).sort(), ['load', 'login', 'rootCount', 'url']);
});

test('WeChat logged-in load failure remains a distinct retryable blocker with page evidence', () => {
  const { classifyWechatPageShell, wechatPageShellBlocker } = loadShellClassifier();
  const shell = classifyWechatPageShell({
    text: '视频管理 动态管理 加载失败，点击重试',
    url: 'https://channels.weixin.qq.com/platform/post/create',
    rootCount: 1,
    editorMarkers: emptyEditorMarkers,
  });
  const blocker = wechatPageShellBlocker(shell);

  assert.equal(shell.login.required, false);
  assert.equal(blocker.code, 'RISK_CONTROL');
  assert.equal(blocker.retryable, true);
  assert.equal(blocker.requiresUser, false);
  assert.equal(blocker.evidence.login.required, false);
  assert.equal(blocker.evidence.load.failed, true);
  assert.equal(blocker.evidence.rootCount, 1);
  assert.equal(blocker.evidence.url, shell.url);
});

test('WeChat editor markers prevent navigation login copy from invalidating a live session', () => {
  const { classifyWechatPageShell, wechatPageShellBlocker } = loadShellClassifier();
  const shell = classifyWechatPageShell({
    text: '登录视频号助手 视频描述 封面预览 个人主页卡片',
    url: 'https://channels.weixin.qq.com/platform/post/create',
    rootCount: 2,
    editorMarkers: { ...emptyEditorMarkers, wujieRoot: true, descriptionEditor: true },
  });

  assert.equal(shell.login.textMatched, true);
  assert.equal(shell.login.editorMarkersPresent, true);
  assert.equal(shell.login.required, false);
  assert.equal(wechatPageShellBlocker(shell), null);
});

test('WeChat upload and mutation flows preserve page-shell blockers before recovery work', () => {
  const source = fs.readFileSync(ADAPTER, 'utf8');
  for (const [name, next] of [
    ['startWechatChannelsUpload', 'uploadWechatChannels'],
    ['prefillWechatChannels', 'mutateWechatChannels'],
    ['mutateWechatChannels', 'runPlatformPhase'],
  ]) {
    const start = source.indexOf(`async function ${name}`);
    const end = source.indexOf(`async function ${next}`, start);
    assert.ok(start >= 0 && end > start, `${name} must remain discoverable`);
    const flow = source.slice(start, end);
    assert.match(flow, /if\(before\.blocker\)return before/, `${name} must stop on the classified page shell`);
  }
  const waitStart = source.indexOf('async function waitWechatEarlyMutationReady');
  const waitEnd = source.indexOf('async function startWechatChannelsUpload', waitStart);
  assert.match(source.slice(waitStart, waitEnd), /if\(current\.blocker\)return current/,
    'an authentication or load failure appearing during upload startup must retain its typed blocker');
});
