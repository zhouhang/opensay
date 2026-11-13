import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parkingObservation } from './xiaohongshu-parking-fixture.mjs';

const core = fs.readFileSync(new URL('../ego/core.mjs', import.meta.url), 'utf8');
const selectCore = core.slice(core.indexOf('async function selectPlatformTab()'),
  core.indexOf('\nasync function armFinalPublishGuard()'));
const parking = fs.readFileSync(new URL('../platforms/xiaohongshu-parking.mjs', import.meta.url), 'utf8');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publishUrl = 'https://creator.xiaohongshu.com/publish/publish?target=video';
const tab = (targetId, url = publishUrl, active = false) => ({ targetId, url, active });

function harness({ tabs = [tab('p1'), tab('p2', 'https://creator.xiaohongshu.com/new/note-manager', true)],
  states = {}, historical = false, priorParking = false, phase = 'park', sourcePatch, info } = {}) {
  const parked = parkingObservation({ historical });
  const source = parked.gates.persistedDraft.evidence.editorVerification;
  const context = { ...source, historical, parkOnly: historical,
    ...(priorParking ? { priorParking: { proof: parked.gates.persistedDraft.evidence } } : {}) };
  sourcePatch?.(context);
  const original = { available: true, isFromDraft: true, id: 'original-native-uuid', uid: 'original-account',
    live: { videoFileId: 'original-upload-file' } };
  let active = tabs.find(item => item.active)?.targetId || null;
  const calls = { switches: [], nativeReads: [], storedReads: [], forbidden: [], pageReads: 0 };
  const forbidden = name => async () => { calls.forbidden.push(name); throw new Error(`Forbidden ${name}`); };
  const sandbox = vm.createContext({ URL, platform: 'xiaohongshu', phase,
    noUpload: true, xhsParkingContext: context, jobFingerprint: parked.fingerprint,
    verificationRunId: parked.verificationRunId, activeTaskSpace: { id: 71 },
    PLATFORM_HOSTS: { xiaohongshu: /creator\.xiaohongshu\.com/ },
    PLATFORM_URLS: { xiaohongshu: publishUrl }, xhsSnapshotHash: digest,
    xhsCoverObjectKey: value => String(value || '').match(/(?:^|\/)spectrum\/([^?"')\\]+)/)?.[1] || '',
    listTabs: async () => tabs,
    switchTab: async targetId => { assert.ok(tabs.some(item => item.targetId === targetId)); active = targetId; calls.switches.push(targetId); },
    nativeReader: async draftId => {
      assert.equal(draftId, 'original-native-uuid'); calls.nativeReads.push(active);
      if (states[active]?.error) throw states[active].error;
      return states[active]?.native || original;
    },
    storedReader: async draftId => {
      assert.equal(draftId, 'original-native-uuid'); calls.storedReads.push(active);
      return states[active]?.stored || { available: false };
    },
    pageInfo: async () => { calls.pageReads++; return info || { w: 1280, h: 720, url: tabs.find(item => item.targetId === active)?.url }; },
    wait: async () => {}, typedBlocker: (code, message, options) => ({ code, message, ...options }),
    openOrReuseTab: forbidden('openOrReuseTab'), gotoAndWait: forbidden('gotoAndWait'),
    js: forbidden('js'), clickDedicatedDraftButton: forbidden('save'),
  });
  vm.runInContext(parking + '\nreadXhsNativeDraft = nativeReader; readXhsStoredDraft = storedReader;\n' + selectCore, sandbox);
  return { run: () => vm.runInContext('selectPlatformTab()', sandbox), calls, active: () => active,
    parkedState: { available: true, uid: 'original-account', record: parked.evidence.currentNativeRecord,
      recordCover: parked.evidence.currentNativeCover, rows: parked.evidence.currentListRows,
      activeId: null, activeVideoFileId: '', activeTitle: '', activeDescription: '', url: publishUrl } };
}

test('XHS park skips active note-manager and selects the exact existing original editor', async () => {
  const h = harness();
  assert.equal((await h.run()).ok, true);
  assert.equal(h.active(), 'p1');
  assert.deepEqual(h.calls.nativeReads, ['p1']);
  assert.ok(!h.calls.switches.includes('p2'));
  assert.deepEqual(h.calls.forbidden, []);
});

test('XHS park reselects its unique match after inspecting another foreign publish tab', async () => {
  const h = harness({ tabs: [tab('p1'), tab('p3', publishUrl, true)],
    states: { p3: { native: { available: true, isFromDraft: true, id: 'foreign', uid: 'original-account', live: { videoFileId: 'original-upload-file' } } } } });
  assert.equal((await h.run()).ok, true);
  assert.deepEqual(h.calls.nativeReads, ['p1', 'p3']);
  assert.equal(h.active(), 'p1');
  assert.deepEqual(h.calls.forbidden, []);
});

test('XHS park rejects wrong UUID, account, video and non-restored pages without opening or navigating', async () => {
  const changes = [
    { id: 'foreign-uuid' }, { uid: 'foreign-account' }, { live: { videoFileId: 'foreign-video' } },
    { isFromDraft: false }, { available: false }, { live: null },
  ];
  for (const patch of changes) {
    const h = harness({ states: { p1: { native: { available: true, isFromDraft: true,
      id: 'original-native-uuid', uid: 'original-account', live: { videoFileId: 'original-upload-file' }, ...patch } } } });
    const result = await h.run();
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(result.blocker.code, 'STATE_AMBIGUOUS');
    assert.deepEqual(h.calls.forbidden, []);
    assert.equal(h.calls.pageReads, 0);
  }
});

test('XHS park refuses two matching native editors instead of choosing the active one', async () => {
  const h = harness({ tabs: [tab('p1'), tab('p3', publishUrl, true)] });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(result.blocker.code, 'STATE_AMBIGUOUS');
  assert.equal(result.blocker.evidence.matchingCount, 2);
  assert.deepEqual(h.calls.forbidden, []);
  assert.equal(h.calls.pageReads, 0);
});

test('XHS park rejects missing, foreign-host, credential-bearing and other-route candidate tabs', async () => {
  for (const tabs of [[], [tab('p2', 'https://creator.xiaohongshu.com/new/note-manager', true)],
    [tab('p1', 'https://creator.xiaohongshu.com.evil.test/publish/publish')],
    [tab('p1', 'https://user:secret@creator.xiaohongshu.com/publish/publish')],
    [tab('p1', 'https://creator.xiaohongshu.com/publish/publish/other')]]) {
    const h = harness({ tabs });
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.blocker.code, 'STATE_AMBIGUOUS');
    assert.deepEqual(h.calls.nativeReads, []);
    assert.deepEqual(h.calls.forbidden, []);
  }
});

test('XHS park-only can select an already empty native list with its prior exact saved proof', async () => {
  const states = { p1: { native: { available: true, isFromDraft: false, id: 'new-empty-id', uid: 'original-account', live: {} } } };
  const h = harness({ historical: true, priorParking: true, states });
  states.p1.stored = { ...h.parkedState, rows: [] };
  assert.equal((await h.run()).ok, true);
  assert.equal(h.active(), 'p1');
  assert.deepEqual(h.calls.storedReads, ['p1']);
  assert.deepEqual(h.calls.forbidden, []);
});


test('XHS park-only identity selection rejects foreign account, snapshot and cover before reopening a drawer', async () => {
  const changes = [
    state => { state.uid = 'foreign-account'; },
    state => { state.record.uid = 'foreign-account'; },
    state => { state.record.snapshot.title = 'foreign-title'; },
    state => { state.record.snapshot.videoFileId = 'foreign-video'; },
    state => { state.record.snapshot.coverFileId = 'spectrum/foreign-cover'; },
    state => { state.recordCover.fileid = 'spectrum/foreign-cover'; },
    state => { state.recordCover.width = 1; },
    state => { state.activeVideoFileId = 'foreign-video'; },
    state => { state.url = 'https://creator.xiaohongshu.com/other'; },
  ];
  for (const change of changes) {
    const states = { p1: { native: { available: true, isFromDraft: false, id: 'new-empty-id', uid: 'original-account', live: {} } } };
    const h = harness({ historical: true, priorParking: true, states });
    const stored = { ...h.parkedState, rows: [], record: structuredClone(h.parkedState.record),
      recordCover: { ...h.parkedState.recordCover } };
    change(stored);
    states.p1.stored = stored;
    const result = await h.run();
    assert.equal(result.ok, false, change.toString());
    assert.equal(result.blocker.code, 'STATE_AMBIGUOUS', change.toString());
    assert.deepEqual(h.calls.forbidden, [], change.toString());
  }
});

test('XHS normal park never treats an empty list as a current verified editor', async () => {
  const h = harness({ states: { p1: { native: { available: true, isFromDraft: false, live: {} } } } });
  assert.equal((await h.run()).blocker.code, 'STATE_AMBIGUOUS');
  assert.deepEqual(h.calls.storedReads, []);
  assert.deepEqual(h.calls.forbidden, []);
});

test('XHS park fails closed on damaged source context or native read exception', async () => {
  for (const options of [
    { sourcePatch: context => { context.observationHash = '0'.repeat(64); } },
    { sourcePatch: context => { context.observation.platform = 'bilibili'; } },
    { states: { p1: { error: new Error('native read unavailable') } } },
  ]) {
    const h = harness(options);
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.blocker.code, 'STATE_AMBIGUOUS');
    assert.deepEqual(h.calls.forbidden, []);
  }
});

test('the exact XHS park tab still must pass common viewport and native-dialog checks', async () => {
  for (const [info, code] of [[{ w: 1280, h: 720, dialog: { message: 'confirm' } }, 'STATE_AMBIGUOUS'],
    [{ w: 100, h: 100 }, 'INPUT_CHANNEL_BROKEN']]) {
    const h = harness({ info });
    assert.equal((await h.run()).blocker.code, code);
    assert.deepEqual(h.calls.forbidden, []);
  }
});

test('non-park XHS selection preserves the existing active-tab behavior', async () => {
  const h = harness({ phase: 'inspect' });
  assert.equal((await h.run()).ok, true);
  assert.equal(h.active(), 'p2');
  assert.deepEqual(h.calls.nativeReads, []);
  assert.deepEqual(h.calls.forbidden, []);
});
