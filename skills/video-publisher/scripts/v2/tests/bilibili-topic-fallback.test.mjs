import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(DIR, '..', 'platforms', 'bilibili.mjs'), 'utf8');

function loadResolver() {
  const start = source.indexOf('function resolveBilibiliExactTopicCandidate');
  const end = source.indexOf('async function inspectBilibiliTopicDialogV2', start);
  assert.ok(start >= 0 && end > start, 'the exact-topic resolver must remain independently testable');
  const context = vm.createContext({});
  vm.runInContext(`${source.slice(start, end)}\nthis.resolve = resolveBilibiliExactTopicCandidate;`, context);
  return (rows, tag) => context.resolve(rows, tag);
}

test('Bilibili topic fallback accepts one case-insensitive exact existing non-activity topic', () => {
  const resolve = loadResolver();
  const result = resolve([
    { name: 'Other', topicId: 8, nonActivityProven: true, activitySignals: [] },
    { name: 'CREATION IDEAS', topicId: 42, nonActivityProven: true, activitySignals: [], selector: '#exact' },
  ], 'Creation Ideas');
  assert.equal(result.ok, true);
  assert.equal(result.candidate.topicId, 42);
  assert.equal(result.candidate.selector, '#exact');
  assert.equal(result.exactCount, 1);
});

test('Bilibili topic fallback blocks zero and multiple exact results without fuzzy selection', () => {
  const resolve = loadResolver();
  const zero = resolve([{ name: '创作', topicId: 1, nonActivityProven: true, activitySignals: [] }], '创作灵感');
  assert.equal(zero.ok, false);
  assert.equal(zero.requiresUser, true);
  assert.equal(zero.exactCount, 0);

  const multiple = resolve([
    { name: '创作灵感', topicId: 2, nonActivityProven: true, activitySignals: [] },
    { name: '创作灵感', topicId: 3, nonActivityProven: true, activitySignals: [] },
  ], '创作灵感');
  assert.equal(multiple.ok, false);
  assert.equal(multiple.requiresUser, true);
  assert.equal(multiple.exactCount, 2);
});

test('Bilibili topic fallback blocks activity semantics and unknown activity state', () => {
  const resolve = loadResolver();
  const activity = resolve([
    { name: '创作灵感', topicId: 4, nonActivityProven: false, activitySignals: ['mission_id=99'] },
  ], '创作灵感');
  assert.equal(activity.ok, false);
  assert.equal(activity.requiresUser, true);
  assert.match(activity.reason, /活动|mission|activity/i);

  const unknown = resolve([
    { name: '创作灵感', topicId: 5, nonActivityProven: false, activitySignals: [] },
  ], '创作灵感');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.requiresUser, true);
  assert.match(unknown.reason, /无法证明非活动/);
});

test('Bilibili topic fallback never accepts or clicks the topic_id=-1 creation row', () => {
  const resolve = loadResolver();
  const creation = resolve([
    { name: '创作灵感', topicId: -1, nonActivityProven: true, activitySignals: [], selector: '#must-not-click' },
  ], '创作灵感');
  assert.equal(creation.ok, false);
  assert.equal(creation.requiresUser, true);
  assert.equal(creation.candidate, undefined);
  assert.match(creation.reason, /创建话题|topic_id=-1/);

  const fallbackStart = source.indexOf('async function addExistingBilibiliTopicV2');
  const fallbackEnd = source.indexOf('async function rebuildBilibiliTagsV2', fallbackStart);
  assert.ok(fallbackStart >= 0 && fallbackEnd > fallbackStart);
  const fallback = source.slice(fallbackStart, fallbackEnd);
  assert.match(fallback, /assessBilibiliExactTopicV2/);
  assert.match(fallback, /if\(!resolution\.ok\)return/);
  assert.ok(fallback.indexOf('if(!resolution.ok)return') < fallback.indexOf('click(resolution.candidate.selector'),
    'candidate validation, including topic_id=-1 rejection, must happen before the first result-row click');
  assert.doesNotMatch(fallback, /topicId===-1[^]*click|创建话题[^]*click/);
});

test('Bilibili opens topic search only for the exact topic-only toast class', () => {
  const exactToast = 'Σ( ° △ °|||) 当前tag为话题专用，不允许自定义添加，可在话题搜索页进行搜索';
  assert.match(source, /topicOnlyMessages/);
  assert.match(source, /当前tag为话题专用，不允许自定义添加，可在话题搜索页进行搜索/);
  const rebuildStart = source.indexOf('async function rebuildBilibiliTagsV2');
  const rebuildEnd = source.indexOf('async function uploadBilibiliCoverV2', rebuildStart);
  const rebuild = source.slice(rebuildStart, rebuildEnd);
  assert.match(rebuild, /action\.topicOnlyRejection===true/);
  assert.match(rebuild, /addExistingBilibiliTopicV2\(tag/);
  assert.ok(exactToast.includes('当前tag为话题专用'));
});

test('Bilibili topic fallback uses only the proven dialog controls and verifies a fresh chip', () => {
  for (const selector of ['.tag-more', '.topic-dialog-search input', '.loading-modal', '.topic-dialog .dialog-item', '.topic-dialog .submit-add']) {
    assert.ok(source.includes(selector), `missing selector ${selector}`);
  }
  const start = source.indexOf('async function addExistingBilibiliTopicV2');
  const end = source.indexOf('async function rebuildBilibiliTagsV2', start);
  const fallback = source.slice(start, end);
  assert.match(fallback, /visible/);
  assert.match(fallback, /exactCount/);
  assert.match(fallback, /topicId>0|topicId <= 0|topicId<=0/);
  assert.match(fallback, /inspectBilibili\(\)/);
  assert.match(fallback, /chips/);
  assert.match(fallback, /evidence/);
});
