import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { browserTagRevisionSourceCode } from './persistence-fixture.mjs';

const source = fs.readFileSync(new URL('../platforms/douyin-persistence.mjs', import.meta.url), 'utf8');
const fileBytes = Buffer.from('approved-native-local-video');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const key = 'publish_form_cache:verified-uid';
const originalDigest = '2991b2fb', normalizedDigest = 'f4f61c40';
const metadata = { path: '/approved/video.mp4', size: fileBytes.length, lastModified: 1700000000000,
  durationSeconds: 75.034, width: 1080, height: 1920, sha256: sha256(fileBytes) };
const vertical = '14c27b2dac3c49b4b27860a598789217', horizontal = '50fa966de3d0465daf275b4d67e9f78c';
const media = { name: 'video.mp4', size: metadata.size, lastModified: metadata.lastModified, duration: metadata.durationSeconds,
  width: metadata.width, height: metadata.height };
const payload = { cache: { longFileInfo: { ...media, vid: 'native-video-id', uri: 'tos-cn-v/native-video-object' },
  longFileMetaInfo: media, coverInfo: { uri: `tos-cn-p/${vertical}`, coverUrl: `https://p3.douyinpic.com/${vertical}?x-expires=1&x-signature=old` },
  coverHorizontalInfo: { uri: `tos-cn-p/${horizontal}` }, coverUrl: `https://p3.douyinpic.com/${vertical}?x-expires=1&x-signature=old`,
  coverHorizontalUrl: `https://p3.douyinpic.com/${horizontal}?x-expires=1&x-signature=old`,
  itemTitle: 'Approved title', sync: 0, visibilityType: 0, scheduleTime: -1, xiguaSyncSwitch: false,
  textResult: { text: 'Approved body #One #Two', caption: 'Approved body', activity: [], textExtra: [
    { start: 14, end: 18, type: 1, hashtag_name: 'One', hashtag_id: '123', user_id: '', extra: { kind: 'recommend' } },
    { start: 19, end: 23, type: 1, hashtag_name: 'Two', hashtag_id: '456', user_id: '', extra: { kind: 'recommend' } },
  ] }, unknownNativeSetting: { keep: true } } };
const receipts = { cover: { slots: { portrait: { afterUrl: `https://p3.douyinpic.com/${vertical}~tplv-cover.jpeg` },
  landscape: { afterUrl: `https://p3.douyinpic.com/${horizontal}~tplv-cover.jpeg` } } } };
const allGates = () => Object.fromEntries(['authenticated', 'draftIdentity', 'video', 'title', 'description', 'tags', 'settings', 'cover', 'noBlockingDialog', 'finalButton', 'safety']
  .map(name => [name, { ok: true, evidence: name === 'safety' ? { guardArmed: true, blockedAttempts: 0 } : {} }]));

function harness({ mutation, failedReadback = false } = {}) {
  let stage = 'slot', saves = 0, resumes = 0, auditWrites = 0, proof;
  const currentPayload = structuredClone(payload);
  const plan = { id: 'original-creation-id', lookupToken: 'content-token', cacheKey: key, cacheDigest: originalDigest,
    listUrl: 'https://creator.douyin.com/creator-micro/content/upload?enter_from=publish' };
  let journal = { version: 1, platform: 'douyin', fingerprint: 'approved', status: 'confirmed', attemptId: 'original-attempt',
    startedAt: '2026-10-09T12:00:00.000Z', savedAt: '2026-10-09T12:00:01.000Z', plan };
  const draftId = sha256(`${plan.lookupToken}\n${key}\n${originalDigest}`);
  const inspection = { platform: 'douyin', phase: 'inspect', fingerprint: 'approved', verificationRunId: 'crash-retry',
    taskSpaceId: 17, observedAt: '2026-10-09T12:02:00.000Z', finalPublishClicked: false, gates: allGates() };
  inspection.gates.draftIdentity.evidence.restoredIdentity = { ok: true, existingDraft: true, actualId: 'editor-source-before-crash', consumedSlot: true };
  const failure = { platform: 'douyin', phase: 'persist', fingerprint: 'approved', verificationRunId: 'crash-retry',
    taskSpaceId: 17, observedAt: '2026-10-09T12:03:00.000Z', finalPublishClicked: false,
    blocker: { code: 'PERSISTENCE_UNVERIFIED', evidence: { available: true, continueCount: 1,
      cacheEntries: [{ key, digest: normalizedDigest, active: true }] } } };
  const proofObservation = { platform: 'douyin', fingerprint: 'approved', verificationRunId: 'prior-ready',
    observedAt: '2026-10-09T12:01:01.000Z', gates: allGates() };
  proofObservation.gates.persistedDraft = { ok: true, evidence: { version: 2, platform: 'douyin', fingerprint: 'approved',
    verificationRunId: 'prior-ready', method: 'resume-slot-reopen', draftId, resumeSlotId: draftId, resumeSlotObserved: true,
    reopenedId: 'editor-source-before-crash', routeChanged: true, contentReadback: true,
    cacheKey: key, cacheDigest: originalDigest, savedAt: journal.savedAt, readAt: '2026-10-09T12:01:00.000Z' } };
  const recoverySource = { inspection, failure, proof: proofObservation };
  const mutableMetadata = { ...metadata };
  const mutableReceipts = structuredClone(receipts);
  mutation?.({ payload: currentPayload, recoverySource, metadata: mutableMetadata, receipts: mutableReceipts, journal });
  const cache = () => ({ key, active: true, digest: normalizedDigest, payload: currentPayload });
  const slot = () => ({ available: stage === 'slot', continueCount: stage === 'slot' ? 1 : 0, cacheEntries: [cache()] });
  const context = vm.createContext({ createHash, URL, fs: { statSync: () => ({ isFile: () => true, size: metadata.size, mtimeMs: metadata.lastModified }), readFileSync: () => fileBytes }, path,
    platform: 'douyin', jobFingerprint: 'approved', verificationRunId: 'recovery-current', activeTaskSpace: { id: 17 },
    videoPath: metadata.path, douyinTitle: 'Approved title', douyinDescription: 'Approved body', douyinTopics: ['One', 'Two'],
    localMediaMetadata: mutableMetadata, expectedReceipts: mutableReceipts, douyinResumeRecoverySource: recoverySource,
    receiptCheckpointPath: '/unused/checkpoint', PERSISTED_DRAFT_KEY: 'proof',
    readDraftSaveJournal: () => journal,
    recordConfirmedResumeSlotNormalization: (_file, _identity, attemptId, normalization) => {
      assert.equal(attemptId, journal.attemptId); auditWrites++;
      journal = { ...journal, plan: { ...journal.plan, cacheSemanticSnapshot: normalization.snapshot }, normalizationAudit: [normalization] };
      return journal;
    },
    clickDedicatedDraftButton: async () => { saves++; throw new Error('Recovery must never save'); },
    readSlot: async () => slot(), readEditor: async () => ({ available: stage === 'editor', existingDraft: stage === 'editor',
      creationId: stage === 'editor' ? 'editor-recovered' : '', url: stage === 'editor' ? 'https://creator.douyin.com/post/video?enter_from=draft' : plan.listUrl }),
    inspect: async () => ({ gates: { ...allGates(), ...(failedReadback ? { tags: { ok: false } } : {}) } }),
    inspectFinalPublishGuard: async () => ({ armed: true, blockedAttempts: 0 }), armFinalPublishGuard: async () => {}, wait: async () => {},
    gotoAndWait: async () => { stage = 'slot'; }, resume: async () => { resumes++; stage = 'editor'; return { ok: true }; },
    js: async expression => {
      if (expression === 'location.href') return stage === 'editor' ? 'https://creator.douyin.com/post/video?enter_from=draft' : plan.listUrl;
      if (expression.includes('window.__publisherDouyinNeedsResave ===')) return false;
      if (expression === 'window.__publisherDouyinNeedsResave = null' || expression.startsWith('window.__publisherDocumentToken =')) return;
      if (expression.includes('window.__publisherDocumentToken !==')) return true;
      if (expression.includes('window["proof"] || null')) return proof;
      if (expression.startsWith('window["proof"] = ')) { proof = JSON.parse(expression.slice('window["proof"] = '.length)); return; }
      throw new Error('Unexpected browser expression');
    },
    typedBlocker: (code, message, options = {}) => ({ code, message, ...options }), okGate: evidence => ({ ok: true, evidence }), failedGate: evidence => ({ ok: false, evidence }),
  });
  vm.runInContext(browserTagRevisionSourceCode + source + '\nreadDouyinResumeSlot = readSlot; readDouyinEditorIdentity = readEditor; clickDouyinResumeContinue = resume;', context);
  return { inspect: () => vm.runInContext('inspectDouyinResumeRecovery()', context), run: () => vm.runInContext('persistDouyinDraft(inspect)', context),
    snapshot: value => { context.payloadUnderTest = value; return vm.runInContext('douyinCacheSnapshot(payloadUnderTest)', context); },
    setSnapshot: value => { journal.plan.cacheSemanticSnapshot = value; },
    payload: () => currentPayload,
    journal: () => journal, counters: () => ({ saves, resumes, auditWrites }) };
}

const sortKeys = value => Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;
const nativeImage = index => `tos-cn-i-jm8ajry58r/${index.toString(16).padStart(32, '0')}`;
function customCoverRecommendations({ payload }) {
  const cache = payload.cache;
  for (const [name, uri] of [['coverInfo', vertical], ['coverHorizontalInfo', horizontal]]) {
    Object.assign(cache[name], { uri: `tos-cn-i-jm8ajry58r/${uri}`, edited: true, type: 2,
      coverEditLogInfo: { video_cover_source: 'upload', unknownLog: 'unchanged' } });
  }
  cache.payVideoInfo = { isOpen: false, agreementChecked: false, showConfig: false, marketingSwitch: false,
    trialTime: null, marketingEnableChange: true };
  cache.payVideoCoverInfo = { coverType: 0, defaultCoverUri: nativeImage(90) };
  cache.previewVideoList = Array.from({ length: 9 }, (_, index) => ({ isCurrent: index === 1, frameIndex: index,
    coverUrl: `https://p3-sign.douyinpic.com/frame-${index}.jpeg?l=20261010000700&x-expires=1&x-signature=old&quality=80` }));
  cache.recommendCoverList = Array.from({ length: 3 }, (_, index) => ({ id: index.toString(16).padStart(32, 'a'),
    src: `blob:https://creator.douyin.com/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa${index}`,
    previewBlobSrc: `blob:https://creator.douyin.com/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb${index}`,
    uri: index === 0 ? nativeImage(10) : 'NOT_READY', uri1: 'NOT_READY', time: index, frameIndex: index,
    crops: [1, 2], fileName: 'cover.png', isAIGen: false, rawBlob: {} }));
  cache.recommendImgStr = Array.from({ length: 5 }, (_, index) => nativeImage(index + 20)).join(',');
}
function refreshOnlyObservedRecommendations({ payload }) {
  const cache = payload.cache;
  for (const [index, preview] of cache.previewVideoList.entries()) {
    if (index === 1) continue;
    preview.coverUrl = preview.coverUrl.replace('l=20261010000700&x-expires=1&x-signature=old', 'l=20261010003500&x-expires=2&x-signature=new');
  }
  for (const recommendation of cache.recommendCoverList) {
    recommendation.id = 'c'.repeat(32);
    recommendation.src = 'blob:https://creator.douyin.com/cccccccc-cccc-cccc-cccc-cccccccccccc';
    recommendation.previewBlobSrc = 'blob:https://creator.douyin.com/dddddddd-dddd-dddd-dddd-dddddddddddd';
  }
  cache.recommendCoverList[0].uri = 'NOT_READY';
  cache.recommendImgStr = Array.from({ length: 5 }, (_, index) => nativeImage(index + 40)).join(',');
  cache.payVideoCoverInfo.defaultCoverUri = nativeImage(99);
}
function legacySnapshot(value) {
  const canonical = sortKeys(structuredClone(value));
  return { version: 1, vid: value.cache.longFileInfo.vid, uri: value.cache.longFileInfo.uri,
    hash: sha256(JSON.stringify(canonical)), value: canonical };
}

test('legacy consumed-slot recovery validates native payload then reopens without another save', async () => {
  const h = harness();
  assert.equal((await h.inspect()).ok, true);
  const originalSavedAt = h.journal().savedAt;
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(h.journal().status, 'confirmed');
  assert.equal(h.journal().plan.cacheDigest, originalDigest);
  assert.equal(h.journal().savedAt, originalSavedAt);
  assert.equal(h.journal().normalizationAudit[0].provenance.kind, 'legacy-consumed-slot-readback');
  assert.deepEqual(h.counters(), { saves: 0, resumes: 1, auditWrites: 1 });
  const originalJournal = JSON.stringify(h.journal());
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(JSON.stringify(h.journal()), originalJournal);
  assert.deepEqual(h.counters(), { saves: 0, resumes: 2, auditWrites: 1 });
});

test('legacy recovery rejects missing lineage, wrong media/covers/entities/settings and a different failure digest', async () => {
  for (const mutation of [
    ({ recoverySource }) => { recoverySource.inspection.verificationRunId = 'foreign-run'; },
    ({ recoverySource }) => { recoverySource.inspection.taskSpaceId = 99; },
    ({ recoverySource }) => { recoverySource.inspection.gates.draftIdentity.evidence.restoredIdentity.consumedSlot = false; },
    ({ recoverySource }) => { recoverySource.proof.gates.persistedDraft.evidence.reopenedId = 'foreign-editor'; },
    ({ recoverySource }) => { recoverySource.failure.blocker.evidence.cacheEntries[0].digest = 'deadbeef'; },
    ({ payload }) => { payload.cache.longFileInfo.size++; },
    ({ payload }) => { payload.cache.longFileMetaInfo.width++; },
    ({ metadata }) => { metadata.sha256 = '0'.repeat(64); },
    ({ payload }) => { payload.cache.coverInfo.uri = 'tos-cn-p/ffffffffffffffffffffffffffffffff'; },
    ({ payload }) => { payload.cache.textResult.textExtra[0].hashtag_name = 'Other'; },
    ({ payload }) => { payload.cache.textResult.textExtra[0].hashtag_id = ''; },
    ({ payload }) => { payload.cache.sync = 1; },
    ({ payload }) => { payload.cache.scheduleTime = 123; },
  ]) {
    const h = harness({ mutation });
    assert.equal((await h.inspect()).ok, false);
    assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
    assert.deepEqual(h.counters(), { saves: 0, resumes: 0, auditWrites: 0 });
  }
});

test('semantic cache identity allows only observed cover signature refreshes and object key order', async () => {
  const baselineHarness = harness(), baseline = baselineHarness.snapshot(payload);
  const h = harness({ mutation: ({ payload }) => {
    payload.cache.coverUrl = payload.cache.coverUrl.replace('x-expires=1&x-signature=old', 'x-signature=new&x-expires=999');
    payload.cache.coverInfo.coverUrl = payload.cache.coverInfo.coverUrl.replace('x-expires=1&x-signature=old', 'x-signature=new&x-expires=999');
  } });
  h.setSnapshot(baseline);
  assert.equal((await h.inspect()).ok, true);
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 0);
  for (const mutation of [
    ({ payload }) => { payload.cache.longFileInfo.vid = 'foreign-native-vid'; },
    ({ payload }) => { payload.cache.longFileInfo.uri = 'foreign-native-uri'; },
    ({ payload }) => { payload.cache.unknownNativeSetting.keep = false; },
    ({ payload }) => { payload.cache.coverUrl += '&unknown=changed'; },
  ]) {
    const foreign = harness({ mutation }); foreign.setSnapshot(baseline);
    assert.equal((await foreign.inspect()).ok, false);
    assert.equal((await foreign.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
    assert.deepEqual(foreign.counters(), { saves: 0, resumes: 0, auditWrites: 0 });
  }
});

test('native reopen with failed business readback cannot persist normalization evidence', async () => {
  const h = harness({ failedReadback: true });
  assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.deepEqual(h.counters(), { saves: 0, resumes: 1, auditWrites: 0 });
  assert.equal(h.journal().plan.cacheSemanticSnapshot, undefined);
});

test('v2 normalization accepts only observed unselected recommendations while retaining the v1 journal byte-for-byte', async () => {
  const before = harness({ mutation: customCoverRecommendations });
  const original = legacySnapshot(before.payload()), originalBytes = JSON.stringify(original);
  const h = harness({ mutation: args => { customCoverRecommendations(args); refreshOnlyObservedRecommendations(args); } });
  h.setSnapshot(original);
  const journalBytes = JSON.stringify(h.journal()), inspection = await h.inspect();
  assert.equal(inspection.ok, true);
  assert.equal(inspection.normalizationVersion, 3);
  assert.equal(inspection.originalSnapshotHash, original.hash);
  assert.equal(inspection.canonicalSnapshotHash, h.snapshot(h.payload()).hash);
  assert.notEqual(inspection.canonicalSnapshotHash, original.hash);
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.persistedDraft.evidence.cacheSemanticNormalizationVersion, 3);
  assert.equal(result.gates.persistedDraft.evidence.savedCacheSemanticHash, original.hash);
  assert.equal(result.gates.persistedDraft.evidence.cacheSemanticHash, inspection.canonicalSnapshotHash);
  assert.equal(JSON.stringify(original), originalBytes);
  assert.equal(JSON.stringify(h.journal()), journalBytes);
  assert.deepEqual(h.counters(), { saves: 0, resumes: 1, auditWrites: 0 });
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(JSON.stringify(h.journal()), journalBytes);
  assert.deepEqual(h.counters(), { saves: 0, resumes: 2, auditWrites: 0 });
});

test('v2 normalization remains exact for selected assets, paid settings, and all unobserved recommendation fields', async () => {
  const before = harness({ mutation: customCoverRecommendations }), original = legacySnapshot(before.payload());
  const variants = [
    ['selected custom URI', cache => { cache.coverInfo.uri = nativeImage(999); }],
    ['selected horizontal URI', cache => { cache.coverHorizontalInfo.uri = nativeImage(999); }],
    ['selected custom cover status', cache => { cache.coverInfo.edited = false; }],
    ['selected cover origin', cache => { cache.coverInfo.coverEditLogInfo.video_cover_source = 'recommend'; }],
    ['paid enabled', cache => { cache.payVideoInfo.isOpen = true; }],
    ['paid agreement', cache => { cache.payVideoInfo.agreementChecked = true; }],
    ['paid config', cache => { cache.payVideoInfo.showConfig = true; }],
    ['paid marketing', cache => { cache.payVideoInfo.marketingSwitch = true; }],
    ['paid cover type', cache => { cache.payVideoCoverInfo.coverType = 1; }],
    ['selected preview query', cache => { cache.previewVideoList[1].coverUrl += '&l=changed'; }],
    ['preview selection state', cache => { cache.previewVideoList[0].isCurrent = true; }],
    ['preview host', cache => { cache.previewVideoList[0].coverUrl = cache.previewVideoList[0].coverUrl.replace('p3-sign.douyinpic.com', 'foreign.example'); }],
    ['unknown preview query', cache => { cache.previewVideoList[0].coverUrl += '&unknown=changed'; }],
    ['preview object path', cache => { cache.previewVideoList[0].coverUrl = cache.previewVideoList[0].coverUrl.replace('frame-0.jpeg', 'foreign.jpeg'); }],
    ['unknown recommendation field', cache => { cache.recommendCoverList[0].frameIndex = 999; }],
    ['unknown recommendation URI', cache => { cache.recommendCoverList[1].uri = nativeImage(10); }],
    ['unknown recommendation uri1', cache => { cache.recommendCoverList[0].uri1 = nativeImage(10); }],
    ['foreign recommendation resource', cache => { cache.recommendCoverList[0].src = 'blob:https://foreign.example/cccccccc-cccc-cccc-cccc-cccccccccccc'; }],
    ['recommendation list extent', cache => { cache.recommendCoverList.push(structuredClone(cache.recommendCoverList[0])); }],
    ['recommended image count', cache => { cache.recommendImgStr += ',' + nativeImage(100); }],
    ['unknown root setting', cache => { cache.unknownNativeSetting.keep = false; }],
    ['native video identity', cache => { cache.longFileInfo.vid = 'foreign'; }],
    ['caption', cache => { cache.textResult.caption = 'foreign'; }],
    ['native tag ID', cache => { cache.textResult.textExtra[0].hashtag_id = '999'; }],
  ];
  for (const [label, mutate] of variants) {
    const h = harness({ mutation: args => { customCoverRecommendations(args); refreshOnlyObservedRecommendations(args); mutate(args.payload.cache); } });
    h.setSnapshot(original);
    const originalJournal = JSON.stringify(h.journal());
    assert.equal((await h.inspect()).ok, false, label);
    assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED', label);
    assert.equal(JSON.stringify(h.journal()), originalJournal, label);
    assert.deepEqual(h.counters(), { saves: 0, resumes: 0, auditWrites: 0 }, label);
  }
});

test('v2 canonical snapshots are idempotent and reject corrupt saved baseline hashes', async () => {
  const h = harness({ mutation: customCoverRecommendations }), baseline = h.snapshot(h.payload());
  assert.equal(h.snapshot(baseline.value).hash, baseline.hash);
  h.setSnapshot({ ...baseline, hash: '0'.repeat(64) });
  assert.equal((await h.inspect()).ok, false);
  assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.deepEqual(h.counters(), { saves: 0, resumes: 0, auditWrites: 0 });
});

function nativeFrameRecommendations(args) {
  customCoverRecommendations(args);
  const cache = args.payload.cache;
  cache.coverCheckInfo = { isEnable: true, status: 2, problemList: [], hProblemList: [],
    problemConclusion: '', hProblemConclusion: '', logData: { uid: 'verified-uid', recommendCoverAB: 2 } };
  cache.recommendCoverInfo = { isFromRecommend: true, isDefaultSelect: false, isRecommendClickFrom: '',
    selectInfo: {}, editingInfo: {}, isStartEditing: true };
  for (const [index, item] of cache.recommendCoverList.entries()) {
    Object.assign(item, { fileName: cache.longFileInfo.name, cropHeight: cache.longFileInfo.height,
      cropWidth: 1080, cropBox: [0, 0, 0.75, 1], cropBox2: [0.08, 0, 0.51, 1] });
    if (index === 0) item.uri1 = nativeImage(70);
  }
}
function refreshNativeFrameRecommendations(args) {
  refreshOnlyObservedRecommendations(args);
  const cache = args.payload.cache;
  cache.coverCheckInfo.status = 5;
  delete cache.recommendCoverInfo.isStartEditing;
  for (const [index, item] of cache.recommendCoverList.entries()) {
    Object.assign(item, { cropWidth: 1079.99998, cropBox: [0.04, 0, 0.79, 1], cropBox2: [0.17, 0, 0.60, 1],
      frameIndex: index + 10, time: 21 + index * 2.1 });
    if (index === 0) item.uri1 = nativeImage(71);
  }
}

test('v3 compares refreshed unselected native frames and empty cover-check progress without changing a confirmed journal', async () => {
  const before = harness({ mutation: nativeFrameRecommendations }), baseline = before.snapshot(before.payload());
  const h = harness({ mutation: args => { nativeFrameRecommendations(args); refreshNativeFrameRecommendations(args); } });
  h.setSnapshot(baseline);
  const journalBytes = JSON.stringify(h.journal());
  assert.equal((await h.inspect()).ok, true);
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(JSON.stringify(h.journal()), journalBytes);
  assert.equal(h.snapshot(baseline.value).hash, baseline.hash);
  assert.deepEqual(h.counters(), { saves: 0, resumes: 2, auditWrites: 0 });
});

test('v3 keeps problematic checks, selected recommendations, malformed geometry and unknown fields fail-closed', async () => {
  const before = harness({ mutation: nativeFrameRecommendations }), baseline = before.snapshot(before.payload());
  const variants = [
    ['problem', cache => { cache.coverCheckInfo.problemList.push('real-warning'); }],
    ['horizontal problem', cache => { cache.coverCheckInfo.hProblemList.push('real-warning'); }],
    ['conclusion', cache => { cache.coverCheckInfo.problemConclusion = 'warning'; }],
    ['unknown check status', cache => { cache.coverCheckInfo.status = 7; }],
    ['disabled checks', cache => { cache.coverCheckInfo.isEnable = false; }],
    ['different check account', cache => { cache.coverCheckInfo.logData.uid = 'foreign'; }],
    ['selected recommendation', cache => { cache.recommendCoverInfo.isDefaultSelect = true; }],
    ['recommendation selection', cache => { cache.recommendCoverInfo.selectInfo.uri = nativeImage(71); }],
    ['editing selection', cache => { cache.recommendCoverInfo.editingInfo.uri = nativeImage(71); }],
    ['unknown editing state', cache => { cache.recommendCoverInfo.isStartEditing = false; }],
    ['wrong filename', cache => { cache.recommendCoverList[0].fileName = 'foreign.mp4'; }],
    ['oversized crop', cache => { cache.recommendCoverList[0].cropWidth = 9999; }],
    ['reversed crop', cache => { cache.recommendCoverList[0].cropBox = [0.9, 0, 0.1, 1]; }],
    ['negative crop', cache => { cache.recommendCoverList[0].cropBox2[0] = -1; }],
    ['out of range frame', cache => { cache.recommendCoverList[0].frameIndex = 999; }],
    ['out of range time', cache => { cache.recommendCoverList[0].time = 999; }],
    ['new uri field', cache => { cache.recommendCoverList[1].uri1 = nativeImage(71); }],
    ['unexpected blob state', cache => { cache.recommendCoverList[0].rawBlob.unknown = true; }],
    ['selected cover geometry', cache => { cache.coverInfo.unknownCrop = [0, 0, 1, 1]; }],
    ['body changed', cache => { cache.textResult.text += 'foreign'; }],
  ];
  for (const [label, change] of variants) {
    const h = harness({ mutation: args => { nativeFrameRecommendations(args); refreshNativeFrameRecommendations(args); change(args.payload.cache); } });
    h.setSnapshot(baseline);
    const journalBytes = JSON.stringify(h.journal());
    assert.equal((await h.inspect()).ok, false, label);
    assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED', label);
    assert.equal(JSON.stringify(h.journal()), journalBytes, label);
    assert.deepEqual(h.counters(), { saves: 0, resumes: 0, auditWrites: 0 }, label);
  }
});
