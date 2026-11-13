import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(DIR, '..', 'platforms', 'bilibili.mjs'), 'utf8');
const start = source.indexOf('async function inspectBilibiliTagInputV2');
const end = source.indexOf('async function uploadBilibiliCoverV2', start);
const tagFlow = source.slice(start, end);

function harness({ initialChips = [], requested = [], lateAutoTag = '', focusError = '', rejectedTag = '', rejectionMessage = '' }) {
  const chips = [...initialChips];
  const events = [];
  let inputValue = '';
  let focused = false;
  let ticks = 0;
  let lateAt = Infinity;
  let lateInserted = false;
  let visibleRejection = '';

  const evidence = () => {
    const lower = value => String(value).toLowerCase();
    const missing = requested.filter(tag => !chips.some(chip => lower(chip) === lower(tag)));
    const unexpected = chips.filter(tag => !requested.some(wanted => lower(wanted) === lower(tag)));
    const duplicates = chips.filter((value, index) => chips.findIndex(item => lower(item) === lower(value)) !== index);
    return { requested, chips: [...chips], missing, unexpected, duplicates: [...new Set(duplicates)], malformed: [] };
  };

  const context = vm.createContext({
    JSON,
    bilibiliTags: requested,
    inspectBilibili: async () => {
      const tags = evidence();
      return { gates: { tags: { ok: !tags.missing.length && !tags.unexpected.length && !tags.duplicates.length, evidence: tags } } };
    },
    js: async expression => {
      if (expression.includes('const rejection=')) {
        return { ok: true, value: inputValue, focused, visible: true, disabled: false, checking: false,
          rawFeedback: visibleRejection ? [visibleRejection] : [], rejectionMessages: visibleRejection ? [visibleRejection] : [],
          hint: focused ? (inputValue ? 'tag input contains text' : 'tag input ready') : 'tag input not focused' };
      }
      if (expression.includes('unexpected bilibili tag chip missing')) {
        const index = chips.findIndex(tag => !requested.some(wanted => wanted.toLowerCase() === tag.toLowerCase()));
        if (index < 0) return { ok: false, reason: 'unexpected bilibili tag chip missing' };
        const [target] = chips.splice(index, 1);
        events.push({ type: 'remove', tag: target });
        return { ok: true, target, countBefore: 1 };
      }
      if (expression.includes("const hadValue=Boolean(input.value)")) {
        focused = true;
        return { ok: true, hadValue: Boolean(inputValue), value: inputValue, focused: true, visible: true };
      }
      if (expression.includes("point:{x:r.left+r.width/2")) {
        return { ok: true, visible: true, point: { x: 10, y: 10 } };
      }
      throw new Error(`unexpected page expression: ${expression.slice(0, 80)}`);
    },
    click: async () => {
      if (focusError) throw new Error(focusError);
      focused = true;
    },
    cdp: async (method, params) => {
      assert.equal(method, 'Input.insertText');
      inputValue = params.text;
    },
    pressKey: async key => {
      if (key === 'Backspace') inputValue = '';
      if (key !== 'Enter') return;
      const tag = inputValue;
      events.push({ type: 'enter', tag });
      inputValue = '';
      if (tag === rejectedTag) {
        visibleRejection = rejectionMessage || `标签不可添加：${tag}`;
        return;
      }
      if (!chips.some(item => item.toLowerCase() === tag.toLowerCase())) chips.push(tag);
      if (lateAutoTag && tag === requested.at(-1)) lateAt = ticks + 2;
    },
    wait: async () => {
      ticks += 1;
      if (!lateInserted && ticks >= lateAt) {
        lateInserted = true;
        chips.push(lateAutoTag);
        events.push({ type: 'late-auto', tag: lateAutoTag });
      }
    },
  });
  vm.runInContext(`${tagFlow}\nthis.runTags = rebuildBilibiliTagsV2;`, context);
  return { run: () => context.runTags(), chips, events };
}

const assessmentContext = vm.createContext({});
vm.runInContext(`${tagFlow}\nthis.assessTopic = assessBilibiliExactTopicV2;`, assessmentContext);
const assessTopic = (tag, snapshot) => assessmentContext.assessTopic(tag, snapshot);

const safeTopic = (name = 'WorkBuddy', id = 1335932) => ({
  activity_description: '',
  activity_text: '',
  description: 'WorkBuddy技能分享',
  mission_id: 0,
  topic_id: id,
  topic_name: name,
  show_activity_icon: false,
});

test('Bilibili tag repair removes early and late automatic chips one at a time', async () => {
  const run = harness({ initialChips: ['自动旧标签'], requested: ['AI', 'WorkBuddy'], lateAutoTag: '自动晚到标签' });
  const result = await run.run();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(run.chips, ['AI', 'WorkBuddy']);
  assert.deepEqual(run.events, [
    { type: 'remove', tag: '自动旧标签' },
    { type: 'enter', tag: 'AI' },
    { type: 'enter', tag: 'WorkBuddy' },
    { type: 'late-auto', tag: '自动晚到标签' },
    { type: 'remove', tag: '自动晚到标签' },
  ]);
  assert.equal(result.removed.at(-1).finalCleanup, true);
});

test('Bilibili tag repair returns recoverable input evidence instead of swallowing focus errors', async () => {
  const run = harness({ requested: ['WorkBuddy'], focusError: 'pointer channel timed out' });
  const result = await run.run();
  assert.equal(result.ok, false);
  assert.equal(result.explicitPlatformRejection, false);
  assert.equal(result.attempts.length, 2, 'a bounded retry may occur, but both failures must remain recorded');
  assert.equal(result.inputError.stage, 'focus');
  assert.match(result.inputError.message, /pointer channel timed out/);
  assert.equal(result.inputProbe.visible, true);
  assert.equal(result.inputProbe.focused, false);
});

test('Bilibili tag repair marks rejection only when visible platform feedback is captured', async () => {
  const run = harness({ requested: ['仅话题标签'], rejectedTag: '仅话题标签' });
  const result = await run.run();
  assert.equal(result.ok, false);
  assert.equal(result.explicitPlatformRejection, true);
  assert.deepEqual(Array.from(result.rejectionMessages), ['标签不可添加：仅话题标签']);
  assert.equal(result.attempts.length, 1, 'an explicit platform rejection must not be retried blindly');
});

test('Bilibili tag repair preserves same-name topic feedback without selecting a topic', async () => {
  const message = '已存在同名话题，请从参与话题中选择';
  const run = harness({ requested: ['创作灵感'], rejectedTag: '创作灵感', rejectionMessage: message });
  const result = await run.run();
  assert.equal(result.ok, false);
  assert.equal(result.explicitPlatformRejection, true);
  assert.deepEqual(Array.from(result.feedbackSeen), [message]);
  assert.deepEqual(Array.from(result.rejectionMessages), [message]);
  assert.equal(run.events.filter(item => item.type === 'enter').length, 1);
  assert.equal(run.events.some(item => item.type === 'select-topic'), false);
});

test('Bilibili exact-topic safety accepts one exact existing non-activity topic independent of list order', () => {
  const result = assessTopic('WorkBuddy', {
    rows: [{ name: 'workbuddy仓库提效', point: { x: 1, y: 1 } }, { name: 'WorkBuddy', point: { x: 2, y: 2 } }],
    topics: [safeTopic('workbuddy做遥感', 2), safeTopic('WorkBuddy', 1335932)],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.row.name, 'WorkBuddy');
  assert.equal(result.topic.topic_id, 1335932);
});

test('Bilibili exact-topic safety blocks zero or multiple exact matches', () => {
  const none = assessTopic('WorkBuddy', { rows: [{ name: 'WorkBuddy别名' }], topics: [safeTopic('WorkBuddy别名')] });
  assert.equal(none.ok, false);
  assert.equal(none.requiresUser, true);
  const multiple = assessTopic('WorkBuddy', {
    rows: [{ name: 'WorkBuddy' }, { name: 'workbuddy' }],
    topics: [safeTopic('WorkBuddy')],
  });
  assert.equal(multiple.ok, false);
  assert.equal(multiple.requiresUser, true);
});

test('Bilibili exact-topic safety blocks activity, unknown-safety, and create-topic records', () => {
  const row = [{ name: 'WorkBuddy' }];
  for (const topic of [
    { ...safeTopic(), mission_id: 9 },
    { ...safeTopic(), show_activity_icon: true },
    { ...safeTopic(), activity_text: '活动话题' },
    Object.fromEntries(Object.entries(safeTopic()).filter(([key]) => key !== 'mission_id')),
    { ...safeTopic(), topic_id: -1 },
  ]) {
    const result = assessTopic('WorkBuddy', { rows: row, topics: [topic] });
    assert.equal(result.ok, false, JSON.stringify(topic));
    assert.equal(result.requiresUser, true);
  }
});
