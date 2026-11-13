import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { beginDraftSave, restartConfirmedDraftSave, restartConfirmedResumeSlotSave, restartUnconfirmedDraftSave, confirmDraftSave, readDraftSaveJournal, recordConfirmedResumeSlotNormalization } from '../lib/draft-save-journal.mjs';
import { browserTagRevisionSourceCode } from './persistence-fixture.mjs';

const identity = { platform: 'bilibili', fingerprint: 'approved-video-and-cover' };
const plan = { id: '123', url: 'https://member.bilibili.com/platform/upload/video/frame?draftId=123',
  listUrl: 'https://member.bilibili.com/platform/upload-manager/article?group=draft', saveLabel: '存草稿' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'receipts.json.draft-save.json');
}

test('save intent survives restart, is private, and refuses a second attempt', t => {
  const file = fixture(t);
  const intent = beginDraftSave(file, identity, plan);
  assert.equal(intent.status, 'intent');
  assert.equal(readDraftSaveJournal(file, identity).attemptId, intent.attemptId);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.throws(() => beginDraftSave(file, identity, plan), /already exists/);
});

test('only the pending attempt can confirm and confirmation does not permit another save', t => {
  const file = fixture(t), intent = beginDraftSave(file, identity, plan);
  assert.throws(() => confirmDraftSave(file, identity, 'different', intent.startedAt), /does not match/);
  assert.throws(() => confirmDraftSave(file, identity, intent.attemptId, '2000-01-01'), /confirmation time/);
  const saved = confirmDraftSave(file, identity, intent.attemptId, new Date().toISOString());
  assert.equal(saved.status, 'confirmed');
  assert.throws(() => beginDraftSave(file, identity, plan), /already exists/);
  assert.throws(() => confirmDraftSave(file, identity, intent.attemptId, saved.savedAt), /does not match/);
});

test('post-save draft id can be bound atomically at confirmation', t => {
  const file = fixture(t);
  const pending = beginDraftSave(file, identity, { ...plan, id: undefined, lookupToken: 'pre-save-list-snapshot' });
  const saved = confirmDraftSave(file, identity, pending.attemptId, new Date().toISOString(), { id: 'resolved-after-save' });
  assert.equal(saved.plan.id, 'resolved-after-save');
  assert.equal(readDraftSaveJournal(file, identity).plan.id, 'resolved-after-save');
});

test('confirmation cannot retarget an intent already bound to a native draft ID', t => {
  const file = fixture(t);
  const pending = beginDraftSave(file, identity, plan);
  assert.throws(() => confirmDraftSave(file, identity, pending.attemptId, new Date().toISOString(), { id: 'duplicate' }), /bound native draft ID/);
  assert.equal(readDraftSaveJournal(file, identity).status, 'intent');
  assert.equal(readDraftSaveJournal(file, identity).plan.id, plan.id);
});

test('a new fingerprint revision journal preserves the original confirmed journal', t => {
  const originalFile = fixture(t);
  const initial = beginDraftSave(originalFile, identity, plan);
  confirmDraftSave(originalFile, identity, initial.attemptId, new Date().toISOString());
  const originalBytes = fs.readFileSync(originalFile, 'utf8');
  const revisedIdentity = { ...identity, fingerprint: 'approved-tag-revision' };
  const revisedFile = `${originalFile}.tag-revision`;
  const revision = beginDraftSave(revisedFile, revisedIdentity, { ...plan, tagRevision: { previousFingerprint: identity.fingerprint,
    nextFingerprint: revisedIdentity.fingerprint, sourceDraftId: plan.id } });
  assert.equal(readDraftSaveJournal(revisedFile, revisedIdentity).attemptId, revision.attemptId);
  assert.equal(readDraftSaveJournal(originalFile, identity).status, 'confirmed');
  assert.equal(fs.readFileSync(originalFile, 'utf8'), originalBytes);
  assert.throws(() => beginDraftSave(revisedFile, revisedIdentity, plan), /already exists/);
});

test('each browser platform uses the dedicated revision journal override with the legacy fallback intact', () => {
  for (const [file, selector] of [
    ['bilibili', 'biliJournalFile'], ['wechat-channels', 'wechatJournalFile'],
    ['douyin', 'douyinJournalFile'], ['xiaohongshu', 'xhsJournalFile'],
  ]) {
    const source = fs.readFileSync(new URL(`../platforms/${file}-persistence.mjs`, import.meta.url), 'utf8');
    for (const override of [undefined, '', '/durable/tag-revision-save.json']) {
      const context = vm.createContext({ receiptCheckpointPath: '/durable/receipts.json',
        ...(override === undefined ? {} : { draftSaveJournalPath: override }) });
      vm.runInContext(browserTagRevisionSourceCode + source, context);
      assert.equal(vm.runInContext(`${selector}()`, context), override || '/durable/receipts.json.draft-save.json', file);
    }
  }
});

test('tag revision source binding requires the original native ID for unsaved local editors', () => {
  for (const platform of ['douyin', 'xiaohongshu']) {
    const context = vm.createContext({ platform, jobFingerprint: 'next', tagRevisionContext: {
      previousFingerprint: 'previous', nextFingerprint: 'next',
    } });
    vm.runInContext(browserTagRevisionSourceCode, context);
    assert.throws(() => vm.runInContext('readBrowserTagRevisionSource()', context), /bound source native draft ID/);
  }
});

test('a confirmed save can restart only for the same stable draft id and keeps audit history', t => {
  const file = fixture(t);
  const first = beginDraftSave(file, identity, plan);
  confirmDraftSave(file, identity, first.attemptId, new Date().toISOString());
  assert.throws(() => restartConfirmedDraftSave(file, identity, { ...plan, id: 'different' }, 'repair'), /same stable draft ID/);
  const next = restartConfirmedDraftSave(file, identity, { ...plan, snapshotHash: 'new' }, 'same draft repaired');
  assert.equal(next.status, 'intent');
  assert.notEqual(next.attemptId, first.attemptId);
  assert.equal(next.supersededAttempts.at(-1).attemptId, first.attemptId);
  assert.equal(next.supersededAttempts.at(-1).reason, 'same draft repaired');
});

test('a confirmed resume-slot save may restart for a new editor id only on the same cache identity', t => {
  const file = fixture(t);
  const slotIdentity = { platform: 'douyin', fingerprint: 'approved-video-and-cover' };
  const slotPlan = { id: 'editor-old', lookupToken: 'lookup', cacheKey: 'publish_form_cache:uid',
    url: 'https://creator.douyin.com/edit', listUrl: 'https://creator.douyin.com/list', saveLabel: '暂存离开' };
  const first = beginDraftSave(file, slotIdentity, slotPlan);
  confirmDraftSave(file, slotIdentity, first.attemptId, new Date().toISOString(), { cacheDigest: 'old' });
  assert.throws(() => restartConfirmedResumeSlotSave(file, slotIdentity, { ...slotPlan, id: 'editor-new', cacheKey: 'other' }, 'repair'), /same confirmed cache slot/);
  const restarted = restartConfirmedResumeSlotSave(file, slotIdentity, { ...slotPlan, id: 'editor-new' }, 'repair persisted formatting');
  assert.equal(restarted.status, 'intent');
  assert.equal(restarted.plan.id, 'editor-new');
  assert.equal(restarted.supersededAttempts[0].priorEditorId, 'editor-old');
});

test('an unconfirmed save can restart only for the same lookup token with a no-effect audit reason', t => {
  const file = fixture(t);
  const unsaved = { ...plan, id: undefined, lookupToken: 'same-unsaved-content' };
  const first = beginDraftSave(file, identity, unsaved);
  assert.throws(() => restartUnconfirmedDraftSave(file, identity, { ...unsaved, lookupToken: 'different' }, 'no effect'), /same lookup token/);
  const next = restartUnconfirmedDraftSave(file, identity, unsaved, 'verified no platform side effect');
  assert.equal(next.status, 'intent');
  assert.notEqual(next.attemptId, first.attemptId);
  assert.equal(next.supersededAttempts.at(-1).outcome, 'verified_no_effect');
});

test('foreign content, channel origin, malformed or absent durable path fail closed', t => {
  const file = fixture(t);
  assert.throws(() => beginDraftSave('', identity, plan), /checkpoint path/);
  for (const listUrl of ['javascript:alert(1)', 'https://member.bilibili.com.evil.test/drafts', 'https://user:password@member.bilibili.com/drafts']) {
    assert.throws(() => beginDraftSave(file, identity, { ...plan, listUrl }), /untrusted route/);
    assert.equal(fs.existsSync(file), false);
  }
  beginDraftSave(file, identity, plan);
  assert.throws(() => readDraftSaveJournal(file, { ...identity, fingerprint: 'changed' }), /mismatch/);
  assert.throws(() => readDraftSaveJournal(file, { ...identity, platform: 'douyin' }), /mismatch/);
  fs.writeFileSync(file, '{');
  assert.throws(() => readDraftSaveJournal(file, identity));
});

test('uncertain save is blocked before inspection or another browser action', async t => {
  const file = fixture(t);
  const recoveryIdentity = identity;
  const recoveryPlan = plan;
  beginDraftSave(file, recoveryIdentity, recoveryPlan);
  const source = fs.readFileSync(new URL('../ego/persisted-draft.mjs', import.meta.url), 'utf8');
  const context = vm.createContext({ phase: 'persist', platform: recoveryIdentity.platform, jobFingerprint: recoveryIdentity.fingerprint,
    receiptCheckpointPath: file.replace(/\.draft-save\.json$/, ''),
    readDraftSaveJournal, beginDraftSave, confirmDraftSave,
    typedBlocker: (code, message, options) => ({ code, message, ...options }),
    inspect: () => { throw new Error('Must not inspect or interact while save is unresolved'); },
  });
  vm.runInContext(source, context);
  const result = await vm.runInContext('persistAndReopenDraftWithJournal(inspect)', context);
  assert.equal(result.blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.match(result.blocker.message, /禁止再次保存/);
});

test('confirmed journal is only a recovery locator, never READY proof', async t => {
  const recoveryIdentity = identity;
  const recoveryPlan = plan;
  const file = fixture(t), intent = beginDraftSave(file, recoveryIdentity, recoveryPlan);
  confirmDraftSave(file, recoveryIdentity, intent.attemptId, new Date().toISOString());
  const source = fs.readFileSync(new URL('../ego/persisted-draft.mjs', import.meta.url), 'utf8');
  const visited = [];
  const context = vm.createContext({ phase: 'persist', platform: recoveryIdentity.platform, jobFingerprint: recoveryIdentity.fingerprint,
    receiptCheckpointPath: file.replace(/\.draft-save\.json$/, ''), draftPersistenceContract: { idKeys: ['draftId'] },
    readDraftSaveJournal, beginDraftSave, confirmDraftSave,
    inspect: async () => ({ gates: {} }),
    inspectFinalPublishGuard: async () => ({ armed: true, blockedAttempts: 0 }),
    armFinalPublishGuard: async () => {},
    gotoAndWait: async url => visited.push(url), js: async () => null,
    clickDedicatedDraftButton: () => { throw new Error('Must not save again'); },
    typedBlocker: (code, message, options) => ({ code, message, ...options }),
  });
  vm.runInContext(source, context);
  const result = await vm.runInContext('persistAndReopenDraftWithJournal(inspect)', context);
  assert.deepEqual(visited, [recoveryPlan.listUrl]);
  assert.equal(result.blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.match(result.blocker.message, /唯一匹配同一 ID/);
  assert.equal(result.gates.persistedDraft, undefined);
});

test('confirmed resume-slot normalization preserves save identity and is byte-idempotent after bootstrap', t => {
  const file = fixture(t), slotIdentity = { platform: 'douyin', fingerprint: 'approved' };
  const slotPlan = { id: 'editor-original', lookupToken: 'lookup', cacheKey: 'publish_form_cache:uid',
    url: 'https://creator.douyin.com/edit', listUrl: 'https://creator.douyin.com/upload', saveLabel: '暂存离开' };
  const first = beginDraftSave(file, slotIdentity, slotPlan);
  const saved = confirmDraftSave(file, slotIdentity, first.attemptId, new Date().toISOString(), { cacheDigest: '2991b2fb' });
  const value = { cache: { longFileInfo: { uri: 'native-uri', vid: 'native-vid' }, unknown: { preserved: true } } };
  const snapshot = { version: 1, vid: 'native-vid', uri: 'native-uri', value,
    hash: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
  const normalization = { cacheKey: slotPlan.cacheKey, originalCacheDigest: saved.plan.cacheDigest, observedCacheDigest: 'f4f61c40', snapshot,
    verificationRunId: 'current-run', priorEditorId: 'editor-original', reopenedId: 'editor-reopened', routeChanged: true,
    contentReadback: true, observedAt: new Date().toISOString(), provenance: { kind: 'legacy-consumed-slot-readback' } };
  const normalized = recordConfirmedResumeSlotNormalization(file, slotIdentity, saved.attemptId, normalization);
  assert.equal(normalized.status, 'confirmed');
  assert.equal(normalized.attemptId, saved.attemptId);
  assert.equal(normalized.savedAt, saved.savedAt);
  assert.equal(normalized.plan.id, saved.plan.id);
  assert.equal(normalized.plan.cacheDigest, saved.plan.cacheDigest);
  assert.equal(normalized.normalizationAudit.length, 1);
  const bytes = fs.readFileSync(file, 'utf8');
  recordConfirmedResumeSlotNormalization(file, slotIdentity, saved.attemptId, { ...normalization, verificationRunId: 'later-run' });
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  for (const changed of [
    { originalCacheDigest: 'ffffffff' }, { cacheKey: 'publish_form_cache:other' }, { contentReadback: false },
    { snapshot: { ...snapshot, vid: 'foreign-vid' } }, { snapshot: { ...snapshot, hash: '0'.repeat(64) } },
  ]) assert.throws(() => recordConfirmedResumeSlotNormalization(file, slotIdentity, saved.attemptId, { ...normalization, ...changed }), /unchanged native semantic identity/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});
