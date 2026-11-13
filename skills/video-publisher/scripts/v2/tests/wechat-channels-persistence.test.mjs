import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { browserRevisionSourceCode } from './persistence-fixture.mjs';

const source = fs.readFileSync(new URL('../platforms/wechat-channels-persistence.mjs', import.meta.url), 'utf8');
const createUrl = 'https://channels.weixin.qq.com/platform/post/create';
const listUrl = 'https://channels.weixin.qq.com/platform/post/draftListManager';
const description = 'Approved description #topic';

function harness({ existing = false, unresolved = false, duplicate = false, wrongReopen = false, listDrops = false,
  revision = false, coverRevision = false, videoRevision = false, sourceId = 'new-id', sourceFingerprint = 'previous', foreignEditor = false, differentSavedId = false, interruptedSave = false,
  saveNoEffect = false, preExistingDuplicate = false, reopenedGateFailure = '', coverDropsAfterConfirm = false, reopenInitializingInspections = 0,
  reopenDelayedBusinessInspections = 0, driftObjectIdDuringRestore = false } = {}) {
  let stage = 'editor', proof, saves = 0, listClicks = 0, navigations = 0, inspections = 0;
  let revisedCoverSaved = false, reopenedInspections = 0, reopenedBusinessInspections = 0, reopenedCurrentReads = 0;
  const old = { objectId: 'old', description: 'Other description' };
  const created = { objectId: 'new-id', description };
  const original = { ...created, description: revision ? 'Previous description #oldtopic' : description };
  const previousCopies = preExistingDuplicate ? [{ ...created, objectId: 'pre-existing-copy' }] : [];
  let entries = revision || coverRevision || videoRevision ? [old, original, ...previousCopies] : existing ? [old, created, ...previousCopies] : [old, ...previousCopies];
  const plan = { id: existing ? created.objectId : undefined, lookupToken: 'lookup', description,
    beforeIds: ['old'], url: createUrl, listUrl, saveLabel: '保存草稿' };
  let journal = existing || unresolved ? { version: 1, platform: 'wechat_channels', fingerprint: 'approved',
    status: unresolved ? 'intent' : 'confirmed', attemptId: 'attempt', startedAt: new Date().toISOString(),
    savedAt: new Date().toISOString(), plan } : null;
  const context = vm.createContext({ createHash, URL, platform: 'wechat_channels', jobFingerprint: 'approved', verificationRunId: 'run-1',
    readBrowserVideoRevisionSource: () => videoRevision ? {sourceDraftId: sourceId,sourcePersistedDraft:{lookup:{description:original.description}}} : null,
    browserVideoRevisionPlan: r => ({sourceDraftId:r.sourceDraftId,sourceVideoSha256:'old',nextVideoSha256:'new'}),
    tagRevisionContext: revision ? { previousFingerprint: 'previous', nextFingerprint: 'approved', sourceDraftId: sourceId,
      sourcePersistedDraft: { version: 2, method: 'draft-list-reopen', platform: 'wechat_channels', fingerprint: 'previous',
        draftId: 'new-id', listEntryId: 'new-id', reopenedId: 'new-id', documentChanged: true,
        listUrl, reopenedUrl: createUrl, lookup: { description: original.description } } } : null,
    coverRevisionContext: coverRevision ? { previousFingerprint: 'previous', nextFingerprint: 'approved', sourceFingerprint: 'previous', sourceDraftId: sourceId,
      sourcePersistedDraft: { version: 2, method: 'draft-list-reopen', platform: 'wechat_channels', fingerprint: sourceFingerprint,
        draftId: 'new-id', listEntryId: 'new-id', reopenedId: 'new-id', documentChanged: true,
        listUrl, reopenedUrl: createUrl, lookup: { description: original.description } } } : null,
    receiptCheckpointPath: '/unused/checkpoint', wechatDescription: description, PERSISTED_DRAFT_KEY: 'proof',
    compactText: value => String(value || '').replace(/\s+/g, ' ').trim(),
    readDraftSaveJournal: () => journal,
    beginDraftSave: (_file, identity, p) => { journal = { version: 1, ...identity, status: 'intent', attemptId: 'attempt', startedAt: new Date().toISOString(), plan: p }; return journal; },
    confirmDraftSave: (_file, _identity, id, savedAt, patch) => { assert.equal(id, 'attempt'); journal = { ...journal, status: 'confirmed', savedAt, plan: { ...journal.plan, ...patch } }; return journal; },
    inspect: async () => { inspections++; const gates = { video: { ok: true }, description: { ok: true },
      replaceVideo: {ok: !(videoRevision && stage === 'reopened' && !revisedCoverSaved)},
      cover: { ok: !(coverRevision && stage === 'reopened' && (!revisedCoverSaved || coverDropsAfterConfirm && journal?.status === 'confirmed')) },
      tags: { ok: !(revision && saveNoEffect && stage === 'reopened') } };
      if (reopenedGateFailure && stage === 'reopened') gates[reopenedGateFailure] = { ok: false };
      const initializing=stage==='reopened'&&reopenedInspections++<reopenInitializingInspections;
      const delayedBusiness=stage==='reopened'&&reopenedBusinessInspections++<reopenDelayedBusinessInspections;
      if(initializing){gates.video={ok:false};gates.cover={ok:false};gates.replaceVideo={ok:false};}
      if(delayedBusiness){gates.video={ok:false};gates.cover={ok:false};}
      return { gates, evidence:{initToast:initializing} }; },
    inspectFinalPublishGuard: async () => ({ armed: true, blockedAttempts: 0 }), armFinalPublishGuard: async () => {},
    clickDedicatedDraftButton: async labels => { assert.deepEqual(Array.from(labels), ['保存草稿']); saves++;
      if (interruptedSave === true) throw new Error('save response interrupted');
      entries = differentSavedId ? [old, original, { ...created, objectId: 'duplicate-id' }]
        : [old, created, ...previousCopies, ...(duplicate ? [{ ...created, ...(revision || coverRevision || videoRevision ? { objectId: 'duplicate-id' } : {}) }] : [])];
      stage = 'saved'; revisedCoverSaved = !saveNoEffect;
      if (interruptedSave === 'after') throw new Error('save response interrupted after writing');
      return { ok: true }; },
    wait: async () => {}, gotoAndWait: async url => { assert.equal(url, listUrl); stage = 'list'; proof = undefined; navigations++; },
    readList: async () => listDrops && stage === 'reopened' ? [old] : entries,
    current: async () => { const drifted=stage==='reopened'&&driftObjectIdDuringRestore&&reopenedCurrentReads++>0;return { objectId: stage === 'saved' && differentSavedId ? 'duplicate-id'
      : stage === 'saved' || stage === 'reopened' || revision || coverRevision || videoRevision ? (foreignEditor || wrongReopen && stage === 'reopened' || drifted ? 'wrong' : 'new-id') : '',
      hasPost: stage === 'reopened' }; },
    clickList: async id => { assert.equal(id, 'new-id'); listClicks++; stage = 'reopened'; return { ok: true }; },
    js: async expression => {
      if (expression === 'location.href') return stage === 'reopened' ? createUrl : stage === 'list' ? listUrl : createUrl;
      if (expression.includes('window["proof"] || null')) return proof;
      if (expression.startsWith('window["proof"] = ')) { proof = JSON.parse(expression.slice('window["proof"] = '.length)); return; }
      if (expression.includes('window.__publisherDocumentToken !==')) return stage === 'list';
      if (expression.startsWith('window.__publisherDocumentToken =')) return;
      throw new Error(`Unexpected JS: ${expression.slice(0, 50)}`);
    },
    typedBlocker: (code, message, options) => ({ code, message, ...options }), okGate: evidence => ({ ok: true, evidence }),
    failedGate: evidence => ({ ok: false, evidence }),
  });
  vm.runInContext(browserRevisionSourceCode + source + '\nreadWechatDraftList = readList; findWechatPostComponent = current; clickWechatDraftFromList = clickList;', context);
  return { run: () => vm.runInContext('persistWechatDraft(inspect)', context), read: () => vm.runInContext('readWechatPersistenceProof()', context),
    identity: () => vm.runInContext('readWechatRestoredIdentity()', context), journal: () => journal,
    counters: () => ({ saves, listClicks, navigations, inspections }) };
}

test('WeChat binds save objectId, rereads the list, and opens its native edit action', async () => {
  const h = harness(), result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.persistedDraft.evidence.draftId, 'new-id');
  assert.deepEqual(h.counters(), { saves: 1, listClicks: 1, navigations: 1, inspections: 2 });
  assert.equal((await h.identity()).ok, true);
});

test('WeChat confirmed recovery does not save a second time', async () => {
  const h = harness({ existing: true });
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 0);
});

test('WeChat unresolved, duplicate and wrong reopened ids fail closed', async () => {
  const unresolved = harness({ unresolved: true });
  assert.equal((await unresolved.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.deepEqual(unresolved.counters(), { saves: 0, listClicks: 0, navigations: 0, inspections: 0 });
  const duplicate = harness({ duplicate: true });
  assert.match((await duplicate.run()).blocker.message, /objectId/);
  assert.equal(duplicate.counters().saves, 1);
  const wrong = harness({ wrongReopen: true });
  assert.match((await wrong.run()).blocker.message, /同一草稿 ID/);
});

test('WeChat proof fails after the matching list record disappears', async () => {
  const h = harness({ listDrops: true });
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, false);
  assert.equal((await h.read()).ok, false);
});

test('WeChat matcher requires both exact objectId and exact normalized description', () => {
  const context = vm.createContext({ createHash, compactText: value => String(value || '').replace(/\s+/g, ' ').trim() });
  vm.runInContext(source, context);
  assert.equal(vm.runInContext(`findWechatDraft([{objectId:'id',description:'wrong'}], {id:'id',description:${JSON.stringify(description)},beforeIds:[]})`, context), null);
  const matched = vm.runInContext(`findWechatDraft([{objectId:'id',description:${JSON.stringify(description)}}], {id:'id',description:${JSON.stringify(description)},beforeIds:[]})`, context);
  assert.equal(matched.objectId, 'id');
});

test('WeChat list reopen targets the unique edit icon instead of the draft row', () => {
  assert.match(source, /String\(el\.__vue__\?\.post\?\.objectId \|\| ''\) === id/);
  assert.match(source, /querySelectorAll\('\.opr \.opr-item,button/);
  assert.match(source, /root\.elementFromPoint/);
  assert.match(source, /querySelector\('\[name="edit"\], \.icon-edit'\)/);
  assert.doesNotMatch(source, /const rect = rows\[0\]\.getBoundingClientRect\(\)/);
});

test('WeChat tag revision saves the authorized objectId alongside pre-existing same-content duplicates', async () => {
  const h = harness({ revision: true, preExistingDuplicate: true });
  assert.equal((await h.identity()).ok, true);
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.persistedDraft.evidence.draftId, 'new-id');
  assert.equal(h.journal().status, 'confirmed');
  assert.equal(h.journal().plan.id, 'new-id');
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 1);
});

test('WeChat tag revision refuses a newly created same-content objectId, including recovery', async () => {
  const h = harness({ revision: true, duplicate: true });
  assert.match((await h.run()).blocker.message, /新增草稿 ID/);
  assert.equal(h.journal().status, 'intent');
  assert.equal(h.counters().navigations, 0);
  assert.match((await h.run()).blocker.message, /新增草稿 ID/);
  assert.equal(h.journal().status, 'intent');
  assert.equal(h.counters().saves, 1);
});

test('WeChat tag revision refuses mismatched source, editor, and changed save objectIds', async () => {
  const sourceMismatch = harness({ revision: true, sourceId: 'foreign' });
  await assert.rejects(sourceMismatch.run(), /source persistence identity/);
  assert.equal(sourceMismatch.counters().saves, 0);
  const foreign = harness({ revision: true, foreignEditor: true });
  assert.equal((await foreign.identity()).ok, false);
  assert.equal((await foreign.run()).blocker.code, 'STATE_AMBIGUOUS');
  assert.equal(foreign.counters().saves, 0);
  const changed = harness({ revision: true, differentSavedId: true });
  assert.match((await changed.run()).blocker.message, /不同草稿 ID/);
  assert.equal(changed.journal().status, 'intent');
  assert.equal(changed.counters().navigations, 0);
  assert.equal((await changed.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.equal(changed.counters().saves, 1);
});

test('WeChat tag revision confirms only after field readback and never repeats an interrupted save', async () => {
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

test('WeChat completed tag save with a lost response is recovered by original objectId readback only', async () => {
  const h = harness({ revision: true, interruptedSave: 'after' });
  await assert.rejects(h.run(), /interrupted/);
  assert.equal(h.journal().status, 'intent');
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.persistedDraft.evidence.draftId, 'new-id');
  assert.equal(h.journal().status, 'confirmed');
  assert.equal(h.counters().saves, 1);
});


test('WeChat cover revision preserves original objectId and records a distinct cover plan', async () => {
  const h = harness({ coverRevision: true, preExistingDuplicate: true });
  const identity = await h.identity();
  assert.equal(identity.ok, true);
  assert.equal(identity.coverRevision, true);
  assert.equal(identity.tagRevision, undefined);
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.persistedDraft.evidence.draftId, 'new-id');
  assert.equal(h.journal().status, 'confirmed');
  assert.equal(h.journal().plan.id, 'new-id');
  assert.equal(h.journal().plan.coverRevision.sourceDraftId, 'new-id');
  assert.equal(h.journal().plan.tagRevision, undefined);
  assert.equal(result.gates.persistedDraft.evidence.lookup.tagRevision, null);
  assert.equal(result.gates.persistedDraft.evidence.lookup.coverRevision.sourceDraftId, 'new-id');
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 1);
});

test('WeChat cover revision requires persisted new covers and every reopened business field', async () => {
  for (const options of [{ saveNoEffect: true }, { reopenedGateFailure: 'shortTitle' }, { reopenedGateFailure: 'originalDeclaration' }]) {
    const h = harness({ coverRevision: true, ...options });
    assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
    assert.equal(h.journal().status, 'intent');
    assert.equal((await h.read()).ok, false);
    assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
    assert.equal(h.journal().status, 'intent');
    assert.equal(h.counters().saves, 1);
  }
});

test('WeChat cover revision rejects extra native copies during save and interrupted recovery', async () => {
  const h = harness({ coverRevision: true, duplicate: true });
  assert.match((await h.run()).blocker.message, /新增草稿 ID/);
  assert.equal(h.journal().status, 'intent');
  assert.match((await h.run()).blocker.message, /新增草稿 ID/);
  assert.equal(h.counters().saves, 1);
  assert.equal(h.counters().navigations, 0);
});

test('WeChat cover revision refuses foreign source, editor and save response objectIds', async () => {
  for (const options of [{ sourceId: 'foreign' }, { sourceFingerprint: 'foreign' }]) {
    const h = harness({ coverRevision: true, ...options });
    await assert.rejects(h.run(), /original saved native draft and video identity/);
    assert.equal(h.counters().saves, 0);
  }
  const foreign = harness({ coverRevision: true, foreignEditor: true });
  assert.equal((await foreign.identity()).ok, false);
  assert.equal((await foreign.run()).blocker.code, 'STATE_AMBIGUOUS');
  assert.equal(foreign.counters().saves, 0);
  const changed = harness({ coverRevision: true, differentSavedId: true });
  assert.match((await changed.run()).blocker.message, /不同草稿 ID/);
  assert.equal(changed.journal().status, 'intent');
  assert.equal((await changed.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.equal(changed.counters().saves, 1);
});

test('WeChat cover save interrupted before writing remains intent and never resaves', async () => {
  const h = harness({ coverRevision: true, interruptedSave: true });
  await assert.rejects(h.run(), /interrupted/);
  assert.equal(h.journal().status, 'intent');
  assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.equal(h.journal().status, 'intent');
  assert.equal(h.counters().saves, 1);
});

test('WeChat cover save with lost response recovers by original objectId readback only', async () => {
  const h = harness({ coverRevision: true, interruptedSave: 'after' });
  await assert.rejects(h.run(), /interrupted/);
  assert.equal(h.journal().status, 'intent');
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.persistedDraft.evidence.draftId, 'new-id');
  assert.equal(h.journal().status, 'confirmed');
  assert.equal(h.counters().saves, 1);
});

test('WeChat confirmed cover revision reopens without saving and rejects a reverted cover', async () => {
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


test('WeChat video revision saves and reopens the original ID once, preserving a distinct revision plan',async()=>{
  const h=harness({videoRevision:true,preExistingDuplicate:true});
  assert.equal((await h.identity()).videoRevision,true);
  assert.equal((await h.run()).gates.persistedDraft.ok,true);
  assert.equal(h.journal().plan.id,'new-id');
  assert.equal(h.journal().plan.videoRevision.sourceDraftId,'new-id');
  assert.equal(h.journal().plan.coverRevision,undefined);
  assert.equal((await h.run()).gates.persistedDraft.ok,true);
  assert.equal(h.counters().saves,1);
});

test('WeChat video revision rejects old persisted media and never repeats an uncertain save',async()=>{
  const h=harness({videoRevision:true,saveNoEffect:true});
  assert.equal((await h.run()).blocker.code,'PERSISTENCE_UNVERIFIED');
  assert.equal(h.journal().status,'intent');
  assert.equal((await h.run()).blocker.code,'PERSISTENCE_UNVERIFIED');
  assert.equal(h.counters().saves,1);
});

test('WeChat video revision rejects a new native draft ID',async()=>{
  const h=harness({videoRevision:true,duplicate:true});
  assert.equal((await h.run()).blocker.code,'PERSISTENCE_UNVERIFIED');
  assert.equal(h.journal().status,'intent');
  assert.equal(h.counters().saves,1);
});


test('WeChat video revision waits for same-objectId native media initialization after reopening without another save',async()=>{
  const h=harness({videoRevision:true,reopenInitializingInspections:3});
  const result=await h.run();
  assert.equal(result.gates.persistedDraft.ok,true);
  assert.equal(h.journal().status,'confirmed');
  assert.equal(h.counters().saves,1);
  assert.equal(h.counters().listClicks,1);
  assert.ok(h.counters().inspections>=5);
  assert.equal((await h.run()).gates.persistedDraft.ok,true);
  assert.equal(h.counters().saves,1);
});

test('WeChat initialization timeout preserves the original save intent and never resaves',async()=>{
  const h=harness({videoRevision:true,reopenInitializingInspections:1000});
  assert.equal((await h.run()).blocker.code,'PERSISTENCE_UNVERIFIED');
  assert.equal(h.journal().status,'intent');
  assert.equal(h.counters().saves,1);
});


test('WeChat confirmed recovery waits when init toast is absent but native video and covers mount later',async()=>{
  const h=harness({existing:true,reopenDelayedBusinessInspections:3});
  const result=await h.run();
  assert.equal(result.gates.persistedDraft.ok,true);
  assert.equal(h.counters().saves,0);
  assert.equal(h.counters().listClicks,1);
  assert.ok(h.counters().inspections>=4);
});

test('WeChat confirmed recovery rejects video and covers that never mount without saving or uploading again',async()=>{
  const h=harness({existing:true,reopenDelayedBusinessInspections:1000});
  const result=await h.run();
  assert.equal(result.blocker.code,'PERSISTENCE_UNVERIFIED');
  assert.deepEqual(Array.from(result.blocker.evidence.missing).sort(),['cover','video']);
  assert.equal(h.counters().saves,0);
  assert.equal(h.journal().status,'confirmed');
  assert.equal((await h.read()).ok,false);
});

test('WeChat confirmed recovery rejects objectId drift during delayed native media restore and never saves',async()=>{
  const h=harness({existing:true,reopenDelayedBusinessInspections:3,driftObjectIdDuringRestore:true});
  const result=await h.run();
  assert.equal(result.blocker.code,'PERSISTENCE_UNVERIFIED');
  assert.match(result.blocker.message,/objectId 发生变化/);
  assert.equal(h.counters().saves,0);
  assert.equal(h.journal().status,'confirmed');
  assert.equal((await h.read()).ok,false);
});
