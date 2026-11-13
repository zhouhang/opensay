import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { browserRevisionSourceCode } from './persistence-fixture.mjs';

const source = fs.readFileSync(new URL('../platforms/bilibili-persistence.mjs', import.meta.url), 'utf8');
const editorUrl = 'https://member.bilibili.com/platform/upload/video/frame';
const title = 'Approved Bilibili title';
const videoName = 'approved-video.mp4';

function harness({ existing = false, unresolved = false, duplicate = false, listDrops = false, wrongEditor = false,
  revision = false, coverRevision = false, videoRevision = false, sourceId = 'new-id', sourceFingerprint = 'previous', saveNoEffect = false, interruptedSave = false,
  unboundExistingEditor = false, preExistingDuplicate = false, reopenedGateFailure = '', coverDropsAfterConfirm = false } = {}) {
  let stage = 'editor', proof, saves = 0, navigations = 0, inspections = 0;
  let revisedFieldsSaved = false;
  const old = { id: 'old', title: 'Other draft', videos: [{ filename: 'other.mp4' }] };
  const created = { id: 'new-id', title, videos: [{ filename: videoName }] };
  const previousCopies = preExistingDuplicate ? [{ ...created, id: 'pre-existing-copy' }] : [];
  let list = existing || revision || coverRevision || videoRevision || unboundExistingEditor ? [old, created, ...previousCopies] : [old, ...previousCopies];
  const plan = { id: existing ? created.id : undefined, lookupToken: 'lookup', title, videoName,
    videoStem: 'approved-video', beforeIds: ['old'], url: editorUrl, listUrl: 'https://member.bilibili.com/platform/upload-manager/article?group=draft', saveLabel: '存草稿' };
  let journal = existing || unresolved ? { version: 1, platform: 'bilibili', fingerprint: 'approved',
    status: unresolved ? 'intent' : 'confirmed', attemptId: 'attempt', startedAt: new Date().toISOString(), savedAt: new Date().toISOString(), plan } : null;
  const context = vm.createContext({ createHash, URL, platform: 'bilibili', jobFingerprint: 'approved', verificationRunId: 'run-1',
    readBrowserVideoRevisionSource: () => videoRevision ? {sourceDraftId: sourceId,sourcePersistedDraft:{lookup:{videoName,videoStem:'approved-video'}}} : null,
    browserVideoRevisionPlan: r => ({sourceDraftId:r.sourceDraftId,sourceVideoSha256:'old',nextVideoSha256:'new'}),
    tagRevisionContext: revision ? { previousFingerprint: 'previous', nextFingerprint: 'approved', sourceDraftId: sourceId,
      sourcePersistedDraft: { version: 2, method: 'draft-list-reopen', platform: 'bilibili', fingerprint: sourceFingerprint,
        draftId: 'new-id', listEntryId: 'new-id', reopenedId: 'new-id', documentChanged: true,
        listUrl: plan.listUrl, reopenedUrl: `${editorUrl}?type=draft&draftId=new-id` } } : null,
    coverRevisionContext: coverRevision ? { previousFingerprint: 'previous', nextFingerprint: 'approved', sourceFingerprint: 'previous', sourceDraftId: sourceId,
      sourcePersistedDraft: { version: 2, method: 'draft-list-reopen', platform: 'bilibili', fingerprint: sourceFingerprint,
        draftId: 'new-id', listEntryId: 'new-id', reopenedId: 'new-id', documentChanged: true,
        listUrl: plan.listUrl, reopenedUrl: `${editorUrl}?type=draft&draftId=new-id` } } : null,
    receiptCheckpointPath: '/unused/checkpoint', bilibiliTitle: title, bilibiliDescription: 'Approved body', bilibiliVideoName: videoName,
    bilibiliVideoStem: 'approved-video', PERSISTED_DRAFT_KEY: 'proof', PLATFORM_URLS: { bilibili: editorUrl },
    readDraftSaveJournal: () => journal,
    beginDraftSave: (_file, identity, p) => { journal = { version: 1, ...identity, status: 'intent', attemptId: 'attempt', startedAt: new Date().toISOString(), plan: p }; return journal; },
    confirmDraftSave: (_file, _identity, id, savedAt, patch) => { assert.equal(id, 'attempt'); journal = { ...journal, status: 'confirmed', savedAt, plan: { ...journal.plan, ...patch } }; return journal; },
    clickDedicatedDraftSelector: async (selector, label, tag) => { assert.deepEqual([selector, label, tag], ['span.submit-draft', '存草稿', 'SPAN']); saves++;
      if (interruptedSave === true) throw new Error('save response interrupted');
      list = [old, created, ...previousCopies, ...(duplicate ? [{ ...created, id: 'new-id-2' }] : [])]; revisedFieldsSaved = !saveNoEffect;
      if (interruptedSave === 'after') throw new Error('save response interrupted after writing');
      return { ok: true }; },
    inspectFinalPublishGuard: async () => ({ armed: true, blockedAttempts: 0 }), armFinalPublishGuard: async () => {},
    inspect: async () => { inspections++; const gates = { video: { ok: true }, title: { ok: true },
      replaceVideo: {ok: !(videoRevision && stage === 'restored' && !revisedFieldsSaved)},
      cover: { ok: !(coverRevision && stage === 'restored' && (!revisedFieldsSaved || coverDropsAfterConfirm && journal?.status === 'confirmed')) },
      tags: { ok: !(revision && stage === 'restored' && !revisedFieldsSaved) } };
      if (reopenedGateFailure && stage === 'restored') gates[reopenedGateFailure] = { ok: false };
      return { gates }; },
    wait: async () => {},
    gotoAndWait: async url => { assert.match(url, /type=draft/); assert.match(url, /draftId=new-id/); stage = 'restored'; proof = undefined; navigations++; },
    readList: async () => listDrops && stage === 'restored' ? [old] : list,
    readEditor: async () => ({ existingDraft: stage === 'restored' || revision || coverRevision || videoRevision || unboundExistingEditor,
      draftId: stage === 'restored' || revision || coverRevision || videoRevision || unboundExistingEditor ? (wrongEditor ? 'wrong' : 'new-id') : '', title,
      filenames: [videoName] }),
    js: async expression => {
      if (expression === 'location.href') return stage === 'restored' ? `${editorUrl}?type=draft&draftId=new-id` : editorUrl;
      if (expression.includes('window["proof"] || null')) return proof;
      if (expression.startsWith('window["proof"] = ')) { proof = JSON.parse(expression.slice('window["proof"] = '.length)); return; }
      if (expression.includes('window.__publisherDocumentToken !==')) return stage === 'restored';
      if (expression.startsWith('window.__publisherDocumentToken =')) return;
      throw new Error(`Unexpected JS: ${expression.slice(0, 40)}`);
    },
    typedBlocker: (code, message, options) => ({ code, message, ...options }), okGate: evidence => ({ ok: true, evidence }),
    failedGate: evidence => ({ ok: false, evidence }),
  });
  vm.runInContext(browserRevisionSourceCode + source + '\nreadBiliDraftList = readList; readBiliEditorIdentity = readEditor;', context);
  return { run: () => vm.runInContext('persistBiliDraft(inspect)', context), read: () => vm.runInContext('readBiliPersistenceProof()', context),
    identity: () => vm.runInContext('readBiliRestoredIdentity()', context), journal: () => journal,
    counters: () => ({ saves, navigations, inspections }) };
}

test('Bilibili binds only the newly listed matching draft and reopens its native id', async () => {
  const h = harness(), result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.persistedDraft.evidence.draftId, 'new-id');
  assert.deepEqual(h.counters(), { saves: 1, navigations: 1, inspections: 2 });
});

test('Bilibili confirmed recovery never saves again', async () => {
  const h = harness({ existing: true });
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 0);
});

test('Bilibili unresolved attempt, duplicate new match and wrong reopened id fail closed', async () => {
  const unresolved = harness({ unresolved: true });
  assert.equal((await unresolved.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.deepEqual(unresolved.counters(), { saves: 0, navigations: 0, inspections: 0 });
  const duplicate = harness({ duplicate: true });
  assert.match((await duplicate.run()).blocker.message, /唯一新增记录/);
  assert.equal(duplicate.counters().saves, 1);
  const wrong = harness({ wrongEditor: true });
  assert.match((await wrong.run()).blocker.message, /同一草稿 ID/);
});

test('Bilibili proof is invalidated when the native list entry disappears', async () => {
  const h = harness({ listDrops: true });
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, false);
  assert.equal((await h.read()).ok, false);
});

test('Bilibili list matcher never accepts a pre-existing id or title-only ambiguity', () => {
  const context = vm.createContext({ createHash });
  vm.runInContext(source, context);
  const result = vm.runInContext(`findBiliDraft([
    {id:'old',title:${JSON.stringify(title)},videos:[]},
    {id:'a',title:${JSON.stringify(title)},videos:[]},
    {id:'b',title:${JSON.stringify(title)},videos:[]}
  ], {title:${JSON.stringify(title)},videoName:${JSON.stringify(videoName)},videoStem:'approved-video',beforeIds:['old']})`, context);
  assert.equal(result, null);
});

test('Bilibili tag revision saves and reopens only the source native ID with pre-existing duplicate titles', async () => {
  const h = harness({ revision: true, preExistingDuplicate: true });
  assert.equal((await h.identity()).ok, true);
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.evidence.draftId, 'new-id');
  assert.equal(h.journal().plan.id, 'new-id');
  assert.equal(h.journal().status, 'confirmed');
  assert.equal(h.counters().saves, 1);
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 1);
});

test('Bilibili tag revision refuses a newly created same-content native ID, including recovery', async () => {
  const h = harness({ revision: true, duplicate: true });
  assert.match((await h.run()).blocker.message, /新增草稿 ID/);
  assert.equal(h.journal().status, 'intent');
  assert.equal(h.counters().navigations, 0);
  assert.match((await h.run()).blocker.message, /新增草稿 ID/);
  assert.equal(h.journal().status, 'intent');
  assert.equal(h.counters().saves, 1);
});

test('Bilibili tag revision rejects mismatched source evidence and foreign editor IDs before saving', async () => {
  for (const options of [{ sourceId: 'foreign' }, { sourceFingerprint: 'foreign' }]) {
    const h = harness({ revision: true, ...options });
    await assert.rejects(h.run(), /source persistence identity/);
    assert.equal(h.counters().saves, 0);
  }
  const foreign = harness({ revision: true, wrongEditor: true });
  assert.equal((await foreign.identity()).ok, false);
  assert.equal((await foreign.run()).blocker.code, 'STATE_AMBIGUOUS');
  assert.equal(foreign.counters().saves, 0);
  const unbound = harness({ unboundExistingEditor: true });
  assert.equal((await unbound.run()).blocker.code, 'STATE_AMBIGUOUS');
  assert.equal(unbound.counters().saves, 0);
});

test('Bilibili unsuccessful or interrupted tag revision remains intent and never repeats save', async () => {
  const unchanged = harness({ revision: true, saveNoEffect: true });
  assert.equal((await unchanged.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.equal(unchanged.journal().status, 'intent');
  assert.equal((await unchanged.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.equal(unchanged.counters().saves, 1);
  const interrupted = harness({ revision: true, interruptedSave: true });
  await assert.rejects(interrupted.run(), /interrupted/);
  assert.equal(interrupted.journal().status, 'intent');
  assert.equal((await interrupted.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.equal(interrupted.counters().saves, 1);
});

test('Bilibili completed tag save with a lost response is recovered by original-ID reopen only', async () => {
  const h = harness({ revision: true, interruptedSave: 'after' });
  await assert.rejects(h.run(), /interrupted/);
  assert.equal(h.journal().status, 'intent');
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.persistedDraft.evidence.draftId, 'new-id');
  assert.equal(h.journal().status, 'confirmed');
  assert.equal(h.counters().saves, 1);
});


test('Bilibili cover revision updates and reopens the original ID with a distinct cover plan', async () => {
  const h = harness({ coverRevision: true, preExistingDuplicate: true });
  const identity = await h.identity();
  assert.equal(identity.ok, true);
  assert.equal(identity.coverRevision, true);
  assert.equal(identity.tagRevision, undefined);
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.persistedDraft.evidence.draftId, 'new-id');
  assert.equal(h.journal().plan.id, 'new-id');
  assert.equal(h.journal().plan.coverRevision.sourceDraftId, 'new-id');
  assert.equal(h.journal().plan.tagRevision, undefined);
  assert.equal(result.gates.persistedDraft.evidence.lookup.tagRevision, null);
  assert.equal(result.gates.persistedDraft.evidence.lookup.coverRevision.sourceDraftId, 'new-id');
  assert.equal(h.journal().status, 'confirmed');
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 1);
});

test('Bilibili cover revision requires new cover and all fields after reopening before confirmation', async () => {
  for (const options of [{ saveNoEffect: true }, { reopenedGateFailure: 'description' }, { reopenedGateFailure: 'tags' }]) {
    const h = harness({ coverRevision: true, ...options });
    assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
    assert.equal(h.journal().status, 'intent');
    assert.equal((await h.read()).ok, false);
    assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
    assert.equal(h.journal().status, 'intent');
    assert.equal(h.counters().saves, 1);
  }
});

test('Bilibili cover revision never accepts an extra matching draft, including recovery', async () => {
  const h = harness({ coverRevision: true, duplicate: true });
  assert.match((await h.run()).blocker.message, /新增草稿 ID/);
  assert.equal(h.journal().status, 'intent');
  assert.match((await h.run()).blocker.message, /新增草稿 ID/);
  assert.equal(h.counters().saves, 1);
  assert.equal(h.counters().navigations, 0);
});

test('Bilibili cover revision rejects foreign source and editor IDs before saving', async () => {
  for (const options of [{ sourceId: 'foreign' }, { sourceFingerprint: 'foreign' }]) {
    const h = harness({ coverRevision: true, ...options });
    await assert.rejects(h.run(), /original saved native draft and video identity/);
    assert.equal(h.counters().saves, 0);
  }
  const h = harness({ coverRevision: true, wrongEditor: true });
  assert.equal((await h.identity()).ok, false);
  assert.equal((await h.run()).blocker.code, 'STATE_AMBIGUOUS');
  assert.equal(h.counters().saves, 0);
});

test('Bilibili cover save interrupted before writing remains intent and never resaves', async () => {
  const h = harness({ coverRevision: true, interruptedSave: true });
  await assert.rejects(h.run(), /interrupted/);
  assert.equal(h.journal().status, 'intent');
  assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.equal(h.counters().saves, 1);
  assert.equal(h.journal().status, 'intent');
});

test('Bilibili cover save with a lost response recovers by original-ID readback only', async () => {
  const h = harness({ coverRevision: true, interruptedSave: 'after' });
  await assert.rejects(h.run(), /interrupted/);
  assert.equal(h.journal().status, 'intent');
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.persistedDraft.evidence.draftId, 'new-id');
  assert.equal(h.journal().status, 'confirmed');
  assert.equal(h.counters().saves, 1);
});

test('Bilibili confirmed cover revision only reopens and still refuses a stale saved cover', async () => {
  const h = harness({ coverRevision: true, coverDropsAfterConfirm: true });
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.journal().status, 'confirmed');
  const next = await h.run();
  assert.equal(next.gates.cover.ok, false);
  assert.equal(next.blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.equal((await h.read()).ok, false);
  assert.equal(h.counters().saves, 1);
  assert.equal(h.counters().navigations, 2);
});


test('Bilibili video revision saves and reopens the original ID once, preserving a distinct revision plan',async()=>{
  const h=harness({videoRevision:true,preExistingDuplicate:true});
  assert.equal((await h.identity()).videoRevision,true);
  assert.equal((await h.run()).gates.persistedDraft.ok,true);
  assert.equal(h.journal().plan.id,'new-id');
  assert.equal(h.journal().plan.videoRevision.sourceDraftId,'new-id');
  assert.equal(h.journal().plan.coverRevision,undefined);
  assert.equal((await h.run()).gates.persistedDraft.ok,true);
  assert.equal(h.counters().saves,1);
});

test('Bilibili video revision rejects old persisted media and never repeats an uncertain save',async()=>{
  const h=harness({videoRevision:true,saveNoEffect:true});
  assert.equal((await h.run()).blocker.code,'PERSISTENCE_UNVERIFIED');
  assert.equal(h.journal().status,'intent');
  assert.equal((await h.run()).blocker.code,'PERSISTENCE_UNVERIFIED');
  assert.equal(h.counters().saves,1);
});

test('Bilibili video revision rejects a new native draft ID',async()=>{
  const h=harness({videoRevision:true,duplicate:true});
  assert.equal((await h.run()).blocker.code,'PERSISTENCE_UNVERIFIED');
  assert.equal(h.journal().status,'intent');
  assert.equal(h.counters().saves,1);
});
