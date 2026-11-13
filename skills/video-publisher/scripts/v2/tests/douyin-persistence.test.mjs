import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { browserTagRevisionSourceCode } from './persistence-fixture.mjs';

const source = fs.readFileSync(new URL('../platforms/douyin-persistence.mjs', import.meta.url), 'utf8');
const editorUrl = 'https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page';
const uploadUrl = 'https://creator.douyin.com/creator-micro/content/upload?enter_from=publish';
const reopenedUrl = 'https://creator.douyin.com/creator-micro/content/post/video?enter_from=draft';

function harness({ existing = false, unresolved = false, wrongReopen = false, cacheMismatch = false,
  revision = false, sourceId = null, savedRevision = false } = {}) {
  let stage = savedRevision ? 'reopened' : existing ? 'slot' : 'editor', proof, saves = 0, resumes = 0, navigations = 0;
  const plan = { id: 'creation-123456789', lookupToken: 'lookup', title: 'Approved title', url: editorUrl,
    listUrl: uploadUrl, saveLabel: '暂存离开', previousCacheDigests: ['publish_form_cache:uid:00000000'],
    cacheKey: 'publish_form_cache:uid', cacheDigest: 'abcdef12' };
  let journal = existing || unresolved ? { version: 1, platform: 'douyin', fingerprint: 'approved',
    status: unresolved ? 'intent' : 'confirmed', attemptId: 'attempt', startedAt: new Date().toISOString(),
    savedAt: new Date().toISOString(), plan } : null;
  const slot = () => ({ available: stage === 'slot', continueCount: stage === 'slot' ? 1 : 0,
    cacheEntries: [{ key: 'publish_form_cache:uid', active: stage === 'slot' || stage === 'reopened', length: stage === 'slot' || stage === 'reopened' ? 500 : 4,
      digest: cacheMismatch ? 'wrong' : savedRevision && saves ? 'fedcba98' : stage === 'slot' || stage === 'reopened' ? 'abcdef12' : '00000000' }],
    url: stage === 'slot' ? uploadUrl : stage === 'reopened' ? reopenedUrl : editorUrl });
  const editor = () => ({ available: stage !== 'slot' && stage !== 'invalid', creationId: stage === 'invalid' ? '' : stage === 'reopened' ? (wrongReopen ? '' : 'editor-reopened-987654321') : 'creation-123456789',
    candidates: [], scene: [stage === 'reopened' || stage === 'invalid' ? 'draft' : 'create'], existingDraft: stage === 'reopened' || stage === 'invalid',
    url: stage === 'reopened' || stage === 'invalid' ? reopenedUrl : editorUrl });
  const context = vm.createContext({ createHash, platform: 'douyin', jobFingerprint: 'approved', verificationRunId: 'run-1',
    tagRevisionContext: revision ? { previousFingerprint: 'previous', nextFingerprint: 'approved',
      sourceDraftId: sourceId || (savedRevision ? 'editor-reopened-987654321' : 'creation-123456789'),
      ...(savedRevision ? { sourcePersistedDraft: { version: 2, platform: 'douyin', fingerprint: 'previous',
        method: 'resume-slot-reopen', draftId: 'synthetic-source-resume-slot', resumeSlotId: 'synthetic-source-resume-slot',
        reopenedId: 'editor-reopened-987654321', cacheKey: plan.cacheKey, cacheDigest: plan.cacheDigest } } : {}) } : null,
    receiptCheckpointPath: '/unused/checkpoint', douyinTitle: 'Approved title', douyinDescription: 'Approved description',
    videoPath: '/approved.mp4', PERSISTED_DRAFT_KEY: 'proof',
    readDraftSaveJournal: () => journal,
    beginDraftSave: (_file, identity, p) => { journal = { version: 1, ...identity, status: 'intent', attemptId: 'attempt',
      startedAt: new Date().toISOString(), plan: p }; return journal; },
    confirmDraftSave: (_file, _identity, id, savedAt, patch) => { assert.equal(id, 'attempt');
      journal = { ...journal, status: 'confirmed', savedAt, plan: { ...journal.plan, ...patch } }; return journal; },
    restartConfirmedResumeSlotSave: () => { throw new Error('unexpected resume-slot resave'); },
    inspect: async () => ({ gates: { video: { ok: true }, title: { ok: true }, description: { ok: true }, tags: { ok: true },
      settings: { ok: true }, cover: { ok: true }, noBlockingDialog: { ok: true }, finalButton: { ok: true }, draftIdentity: { ok: true } } }),
    inspectFinalPublishGuard: async () => ({ armed: true, blockedAttempts: 0 }), armFinalPublishGuard: async () => {},
    clickDedicatedDraftButton: async labels => { assert.deepEqual(Array.from(labels), ['暂存离开']); saves++; stage = 'slot'; return { ok: true }; },
    clickContinue: async () => { resumes++; stage = 'reopened'; return { ok: true }; },
    wait: async () => {}, gotoAndWait: async url => { assert.equal(url, uploadUrl); stage = 'slot'; navigations++; },
    readSlot: async () => slot(), current: async () => editor(),
    js: async expression => {
      if (expression === 'location.href') return stage === 'slot' ? uploadUrl : stage === 'reopened' || stage === 'invalid' ? reopenedUrl : editorUrl;
      if (expression.includes('window["proof"] || null')) return proof;
      if (expression.startsWith('window["proof"] = ')) { proof = JSON.parse(expression.slice('window["proof"] = '.length)); return; }
      if (expression.includes('window.__publisherDouyinNeedsResave ===')) return false;
      if (expression === 'window.__publisherDouyinNeedsResave = null') return;
      if (expression.includes('window.__publisherDocumentToken !==')) return stage === 'reopened';
      if (expression.startsWith('window.__publisherDocumentToken =')) return;
      throw new Error(`Unexpected JS: ${expression.slice(0, 80)}`);
    },
    typedBlocker: (code, message, options) => ({ code, message, ...options }), okGate: evidence => ({ ok: true, evidence }),
    failedGate: evidence => ({ ok: false, evidence }),
  });
  vm.runInContext(browserTagRevisionSourceCode + source + '\nreadDouyinResumeSlot = readSlot; readDouyinEditorIdentity = current; clickDouyinResumeContinue = clickContinue;', context);
  return { run: () => vm.runInContext('persistDouyinDraft(inspect)', context), read: () => vm.runInContext('readDouyinPersistenceProof()', context),
    identity: (matches = false) => vm.runInContext(`readDouyinRestoredIdentity(${matches})`, context), invalidate: () => { stage = 'invalid'; },
    counters: () => ({ saves, resumes, navigations }) };
}

test('Douyin binds the resume-slot cache and accepts a rotated editor instance after exact readback', async () => {
  const h = harness(), result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.persistedDraft.evidence.draftId.length, 64);
  assert.equal(result.gates.persistedDraft.evidence.reopenedId, 'editor-reopened-987654321');
  assert.equal(result.gates.persistedDraft.evidence.routeChanged, true);
  assert.deepEqual(h.counters(), { saves: 1, resumes: 1, navigations: 1 });
  assert.equal((await h.identity(true)).ok, true);
});

test('Douyin confirmed recovery never saves a second time', async () => {
  const h = harness({ existing: true });
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 0);
});

test('Douyin unresolved save, changed cache, and wrong reopened ID fail closed', async () => {
  const unresolved = harness({ unresolved: true });
  assert.equal((await unresolved.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.deepEqual(unresolved.counters(), { saves: 0, resumes: 0, navigations: 0 });
  const cache = harness({ existing: true, cacheMismatch: true });
  assert.match((await cache.run()).blocker.message, /同一恢复槽位缓存/);
  const wrong = harness({ wrongReopen: true });
  assert.match((await wrong.run()).blocker.message, /新的草稿编辑实例/);
});

test('Douyin proof is invalid when the current editor loses the saved creation ID', async () => {
  const h = harness(), result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  h.invalidate();
  assert.equal((await h.read()).ok, false);
});

test('Douyin implementation reads React-native creation state and exact resume copy', () => {
  assert.match(source, /__reactFiber\$/);
  assert.match(source, /props\.contentType !== 'video'/);
  assert.match(source, /你还有上次未发布的视频\.\*是否继续编辑/);
  assert.match(source, /compact\(el\.innerText \|\| el\.textContent \|\| ''\) !== '继续编辑'/);
});

test('Douyin unsaved tag revision binds the observed source creation ID and saves once', async () => {
  const h = harness({ revision: true });
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 1);
  const foreign = harness({ revision: true, sourceId: 'other-creation' });
  assert.equal((await foreign.run()).blocker.code, 'STATE_AMBIGUOUS');
  assert.equal(foreign.counters().saves, 0);
});

test('Douyin saved tag revision binds the source editor ID independently of its synthetic resume-slot ID', async () => {
  const h = harness({ revision: true, savedRevision: true });
  const identity = await h.identity(false);
  assert.equal(identity.ok, true);
  assert.equal(identity.actualId, 'editor-reopened-987654321');
  assert.equal(identity.draftId, 'synthetic-source-resume-slot');
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 1);
  const foreign = harness({ revision: true, savedRevision: true, cacheMismatch: true });
  assert.equal((await foreign.identity()).ok, false);
  const wrong = harness({ revision: true, savedRevision: true, wrongReopen: true });
  assert.equal((await wrong.run()).blocker.code, 'STATE_AMBIGUOUS');
  assert.equal(wrong.counters().saves, 0);
});
