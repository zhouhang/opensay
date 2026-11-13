import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { evaluateObservation } from '../lib/model.mjs';

const source = fs.readFileSync(new URL('../platforms/xiaohongshu-parking.mjs', import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const url = 'https://creator.xiaohongshu.com/publish/publish?target=video';
const snapshot = { title: 'Approved title', description: 'Approved body', descriptionHtml: '<p>Approved body</p>',
  videoFileId: 'spectrum/video', transcodeFileId: 'spectrum/transcode', coverFileId: 'spectrum/cover', original: true };
const cover = { fileid: snapshot.coverFileId, width: 1515, height: 2020 };
const ok = evidence => ({ ok: true, evidence });

function harness(options = {}) {
  let navigations = 0, listOpens = 0, saves = 0, proof = null;
  const started = new Date(Date.now() - 1000).toISOString();
  const editor = { platform: 'xiaohongshu', phase: 'verify', fingerprint: 'approved',
    verificationRunId: options.historical ? 'previous-run' : 'run', taskSpaceId: 71, observedAt: started,
    gates: Object.fromEntries(['authenticated', 'draftIdentity', 'video', 'title', 'description', 'tags', 'original', 'cover', 'noBlockingDialog', 'finalButton', 'persistedDraft', 'safety'].map(name => [name, ok({})])) };
  editor.gates.title = ok({ actual: snapshot.title, expected: snapshot.title });
  editor.gates.draftIdentity = ok({ restoredIdentity: { ok: true, draftId: 'uuid', videoFileId: snapshot.videoFileId } });
  editor.gates.cover = ok({ nativeCoverFileId: cover.fileid, nativeCover: { ...cover }, recordCover: { ...cover } });
  editor.gates.persistedDraft = ok({ version: 2, method: 'draft-list-reopen', platform: 'xiaohongshu', fingerprint: 'approved',
    verificationRunId: editor.verificationRunId, storageScope: 'browser-local', draftId: 'uuid', uid: 'owner', snapshotHash: hash(snapshot),
    listEntryId: 'uuid', reopenedId: 'uuid', savedAt: started, readAt: started, documentChanged: true, listUrl: url, reopenedUrl: url });
  editor.gates.safety = ok({ finalPublishClicked: false, guardArmed: true, blockedAttempts: 0 });
  const context = { observation: editor, observationHash: hash(editor), evidencePath: '/job/evidence/verify.json',
    historical: options.historical === true, parkOnly: options.historical === true };
  if (options.badHash) context.observationHash = '0'.repeat(64);
  const native = { available: true, id: 'uuid', uid: 'owner', isFromDraft: true,
    live: { ...snapshot }, liveCover: { ...cover }, recordCover: { ...cover },
    record: { id: 'uuid', uid: 'owner', snapshot: { ...snapshot }, timeStamp: Date.now() }, ...options.native };
  const parkedRows = [{ id: 'uuid', title: snapshot.title, visible: true,
    thumbnailImages: [{ src: 'https://ros-preview.xhscdn.com/spectrum/cover?current', complete: true,
      naturalWidth: 1515, naturalHeight: 2020, visible: true, decoded: true }],
    thumbnailUrls: ['https://ros-preview.xhscdn.com/spectrum/cover?current'] }];
  const stored = { available: true, uid: 'owner', activeId: 'new-empty-uuid', activeVideoFileId: '', activeTitle: '', activeDescription: '',
    url, record: native.record, recordCover: { ...cover }, rows: structuredClone(parkedRows), ...options.stored };
  const scope = vm.createContext({ createHash, platform: 'xiaohongshu', jobFingerprint: 'approved', verificationRunId: 'run',
    activeTaskSpace: { id: 71 }, xhsParkingContext: context, xhsSnapshotHash: hash,
    xhsCoverObjectKey: value => String(value || '').match(/(?:^|\/)spectrum\/([^?"')\\]+)/)?.[1] || '',
    xhsRecordMatches: (state, p) => state.available && state.uid === p.uid && state.record?.uid === p.uid
      && state.record.id === p.id && hash(state.record.snapshot) === p.snapshotHash,
    readXhsNativeDraft: async () => native,
    inspectXiaohongshu: async () => ({ gates: { ...editor.gates,
      ...(options.businessFail ? { tags: { ok: false } } : {}) } }),
    inspectFinalPublishGuard: async () => ({ armed: !options.guardFail, blockedAttempts: options.blockedAttempt ? 1 : 0 }),
    armFinalPublishGuard: async () => {}, wait: async () => {},
    gotoAndWait: async dest => { assert.equal(dest, url); navigations++; },
    clickDedicatedDraftButton: async () => { saves++; throw new Error('Parking cannot save'); },
    PLATFORM_URLS: { xiaohongshu: url }, PERSISTED_DRAFT_KEY: 'proof',
    typedBlocker: (code, message, extra) => ({ code, message, ...extra }), okGate: ok, failedGate: evidence => ({ ok: false, evidence }),
    getStored: async () => stored,
    js: async expression => {
      if (expression === 'location.href') return url;
      if (expression.includes('window["proof"] || null')) return proof;
      if (expression.startsWith('window["proof"] = ')) { proof = JSON.parse(expression.slice('window["proof"] = '.length)); return; }
      if (expression.startsWith('window.__publisherDocumentToken =')) return;
      if (expression.includes('window.__publisherDocumentToken !==')) return !options.sameDocument;
      if (expression.includes('.draft-title-box')) {
        listOpens++;
        if (options.missingList) return false;
        if (options.reopenRowsOnListClick) stored.rows = structuredClone(options.reopenedRows || parkedRows);
        return true;
      }
      throw new Error('Unexpected browser call: ' + expression);
    },
  });
  vm.runInContext(source + '\nreadXhsStoredDraft = getStored;', scope);
  return { run: () => vm.runInContext('parkXhsDraft()', scope), read: () => vm.runInContext('readXhsParkedPersistenceProof()', scope),
    counters: () => ({ navigations, listOpens, saves }), stored, context, native };
}

test('parking leaves the original editor and verifies an unchanged native record without saving or editing', async () => {
  const h = harness(), result = await h.run();
  assert.equal(result.surface, 'xhs-draft-list-parked');
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.finalButton, undefined);
  assert.equal(result.gates.persistedDraft.evidence.draftId, 'uuid');
  assert.equal(result.gates.persistedDraft.evidence.coverWidth, 1515);
  assert.deepEqual(h.counters(), { navigations: 1, listOpens: 1, saves: 0 });
  const observation = { ...result, platform: 'xiaohongshu', phase: 'park', fingerprint: 'approved', verificationRunId: 'run',
    taskSpaceId: 71, observedAt: new Date().toISOString(), gates: { ...result.gates,
      safety: ok({ finalPublishClicked: false, guardArmed: true, blockedAttempts: 0 }) } };
  assert.equal(evaluateObservation(observation).ready, true, JSON.stringify(evaluateObservation(observation)));
});

test('repeated park reads the already parked native list without reopening or saving', async () => {
  const h = harness({ historical: true });
  const first = await h.run();
  assert.equal(first.gates.persistedDraft.ok, true);
  h.context.priorParking = { proof: first.gates.persistedDraft.evidence, evidencePath: '/job/evidence/park.json' };
  h.native.available = false; h.native.id = 'empty'; h.native.isFromDraft = false;
  const second = await h.run();
  assert.equal(second.gates.persistedDraft.ok, true);
  assert.equal(second.gates.persistedDraft.evidence.transitionReused, true);
  assert.equal(second.gates.persistedDraft.evidence.parkedAt, first.gates.persistedDraft.evidence.parkedAt);
  assert.deepEqual(h.counters(), { navigations: 1, listOpens: 1, saves: 0 });
});


test('protective park reopens a closed native drawer and then requires the loaded cover image', async () => {
  const h = harness({ historical: true, reopenRowsOnListClick: true });
  const first = await h.run();
  assert.equal(first.gates.persistedDraft.ok, true);
  h.context.priorParking = { proof: first.gates.persistedDraft.evidence, evidencePath: '/job/evidence/park.json' };
  h.native.available = false; h.native.id = 'empty'; h.native.isFromDraft = false;
  h.stored.rows = [];
  const second = await h.run();
  assert.equal(second.gates.persistedDraft.ok, true);
  assert.equal(second.gates.persistedDraft.evidence.transitionReused, true);
  assert.deepEqual(h.counters(), { navigations: 1, listOpens: 2, saves: 0 });
});

test('protective park rejects a reopened drawer whose cover image is still gray', async () => {
  const grayRows = [{ id: 'uuid', title: snapshot.title, visible: true,
    thumbnailImages: [{ src: 'https://ros-preview.xhscdn.com/spectrum/cover?current', complete: true,
      naturalWidth: 0, naturalHeight: 0, visible: true, decoded: false }],
    thumbnailUrls: ['https://ros-preview.xhscdn.com/spectrum/cover?current'] }];
  const h = harness({ historical: true, reopenRowsOnListClick: true, reopenedRows: grayRows });
  const first = await h.run();
  assert.equal(first.blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.deepEqual(h.counters(), { navigations: 1, listOpens: 1, saves: 0 });
});

test('explicit park-only keeps historical editor evidence immutable', async () => {
  const h = harness({ historical: true }), original = JSON.stringify(h.context.observation);
  const result = await h.run();
  assert.equal(result.gates.editorVerified.evidence.historical, true);
  assert.equal(result.gates.persistedDraft.evidence.editorVerification.observation.verificationRunId, 'previous-run');
  assert.equal(JSON.stringify(h.context.observation), original);
  assert.equal(h.counters().saves, 0);
});

test('source tampering and current business or guard drift block before navigating', async () => {
  for (const options of [{ badHash: true }, { businessFail: true }, { guardFail: true }, { blockedAttempt: true },
    { native: { id: 'other' } }, { native: { uid: 'other' } }, { native: { live: { ...snapshot, description: 'changed' } } },
    { native: { liveCover: { ...cover, height: 2019 } } }, { native: { recordCover: { ...cover, width: 1514 } } }]) {
    const h = harness(options), result = await h.run();
    assert.equal(result.blocker.code, 'PERSISTENCE_UNVERIFIED', JSON.stringify(options));
    assert.deepEqual(h.counters(), { navigations: 0, listOpens: 0, saves: 0 });
  }
});

test('park failure never returns editor READY and never attempts another save', async () => {
  const image = overrides => ({ src: 'https://ros-preview.xhscdn.com/spectrum/cover?current', complete: true,
    naturalWidth: 1515, naturalHeight: 2020, visible: true, decoded: true, ...overrides });
  const row = images => ({ id: 'uuid', title: snapshot.title, visible: true, thumbnailImages: images,
    thumbnailUrls: images.map(item => item.src) });
  for (const options of [{ sameDocument: true }, { missingList: true },
    { stored: { activeId: 'uuid' } }, { stored: { activeVideoFileId: snapshot.videoFileId } },
    { stored: { rows: [] } }, { stored: { recordCover: { ...cover, height: 2021 } } },
    { stored: { rows: [{ id: 'uuid', title: snapshot.title, visible: true,
      thumbnailUrls: ['https://ros-preview.xhscdn.com/spectrum/cover?current'] }] } },
    { stored: { rows: [row([image({ naturalWidth: 0, naturalHeight: 0, decoded: false })])] } },
    { stored: { rows: [row([image({ complete: false, decoded: false })])] } },
    { stored: { rows: [row([image({ decoded: false })])] } },
    { stored: { rows: [row([image({ visible: false })])] } },
    { stored: { rows: [row([image({ src: 'https://cdn/spectrum/other' })])] } },
    { stored: { rows: [row([image(), image()])] } },
    { stored: { rows: [row([image({ visible: false }), image({ src: 'https://cdn/spectrum/other' })])] } }]) {
    const h = harness(options), result = await h.run();
    assert.equal(result.blocker.code, 'PERSISTENCE_UNVERIFIED', JSON.stringify(options));
    assert.equal(result.gates.persistedDraft, undefined);
    assert.equal(h.counters().saves, 0);
  }
});

test('fresh parked readback rejects native storage drift without reopening an editor', async () => {
  const h = harness();
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  h.stored.record.snapshot = { ...snapshot, title: 'changed' };
  assert.equal((await h.read()).ok, false);
  assert.equal(h.counters().navigations, 1);
  assert.equal(h.counters().saves, 0);
});
