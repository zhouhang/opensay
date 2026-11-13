import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JobStore } from '../lib/job-store.mjs';
import { prepareUnsavedBilibiliTagRevision, readUnsavedBilibiliTagContext } from '../lib/bilibili-unsaved-tag-revision.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const native = () => ({ draftId: '', existingDraft: false, published: false, partCount: 1,
  uploadComplete: true, nativeFileIds: ['filename:original-upload-token'], cid: '123456', nativeSize: 123 });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-unsaved-tags-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldFingerprint = 'a'.repeat(64), nextFingerprint = 'b'.repeat(64);
  const videoPath = path.join(root, 'approved.mp4');
  fs.writeFileSync(videoPath, 'approved bytes');
  const video = { path: videoPath, size: 14, sha256: digest('approved bytes') };
  const oldPackagePath = path.join(root, 'old.json'), nextPackagePath = path.join(root, 'new.json');
  const store = new JobStore(path.join(root, 'job'), { fingerprint: oldFingerprint, packagePath: oldPackagePath,
    video, status: 'blocked', platforms: {} });
  const state = await store.initialize();
  const evidence = phase => ({ platform: 'bilibili', phase, fingerprint: oldFingerprint,
    taskSpaceId: 12, taskSpace: 'original-bili-space', observedAt: new Date().toISOString(),
    gates: { video: { ok: true, evidence: { filename: 'approved.mp4', stable: true } }, draftIdentity: { ok: true } },
    evidence: { nativeUploadIdentity: native() } });
  const uploadFile = path.join(store.evidenceDir, 'original-completed-upload.json');
  const freshFile = path.join(store.evidenceDir, 'fresh-inspect.json');
  fs.writeFileSync(uploadFile, JSON.stringify({ observation: evidence('mutate') }));
  fs.writeFileSync(freshFile, JSON.stringify({ observation: evidence('inspect') }));
  state.platforms.bilibili = { taskSpaceId: 12, taskSpaceName: 'original-bili-space', status: 'blocked_user',
    lastEvidencePath: freshFile, history: [{ evidencePath: uploadFile }, { evidencePath: freshFile }],
    receipts: { cover: { unchanged: true } }, verdict: { ready: false }, videoReceipt: null };
  for (const platform of ['youtube', 'wechat_channels', 'xiaohongshu']) {
    state.platforms[platform] = { status: platform === 'xiaohongshu' ? 'blocked' : 'ready',
      verdict: { ready: platform !== 'xiaohongshu' }, receipts: { accepted: platform }, taskSpaceId: platform === 'youtube' ? null : 22 };
    fs.writeFileSync(store.receiptCheckpointPath(platform), JSON.stringify({ original: platform }));
  }
  await store.save();
  const identity = { fingerprint: nextFingerprint, contentFingerprint: 'c'.repeat(64) };
  const args = { confirmTagChange: true, platforms: ['bilibili'], packagePath: nextPackagePath };
  return { root, store, state, identity, args, uploadFile, freshFile, video,
    input: () => ({ store, state, identity, args, affectedPlatforms: ['bilibili'] }) };
}

test('unfinished Bili correction binds existing CID and preserves all sibling identities, states and checkpoints', async t => {
  const f = await fixture(t);
  const siblings = Object.fromEntries(['youtube', 'wechat_channels', 'xiaohongshu'].map(p => [p, structuredClone(f.state.platforms[p])]));
  const oldFingerprint = f.state.fingerprint, oldPath = f.state.packagePath;
  const revision = await prepareUnsavedBilibiliTagRevision(f.input());
  assert.equal(f.state.fingerprint, f.identity.fingerprint);
  assert.equal(revision.sources.bilibili.sourceNativeUpload.cid, '123456');
  assert.equal(f.state.platformFingerprints.bilibili, f.identity.fingerprint);
  assert.deepEqual(f.state.platforms.bilibili.receipts, { cover: { unchanged: true } });
  for (const p of Object.keys(siblings)) {
    assert.deepEqual(f.state.platforms[p], siblings[p]);
    assert.equal(f.state.platformFingerprints[p], oldFingerprint);
    assert.equal(f.state.platformPackagePaths[p], oldPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.store.receiptCheckpointPath(p))), { original: p });
  }
  const context = { previousFingerprint: revision.previousFingerprint, nextFingerprint: revision.nextFingerprint, ...revision.sources.bilibili };
  assert.equal(readUnsavedBilibiliTagContext(context, { platform: 'bilibili', fingerprint: f.identity.fingerprint, localMediaMetadata: f.video }), context);
  fs.appendFileSync(f.uploadFile, ' ');
  assert.throws(() => readUnsavedBilibiliTagContext(context, { platform: 'bilibili', fingerprint: f.identity.fingerprint, localMediaMetadata: f.video }), /source evidence changed/);
});

test('a crash after the durable correction intent replays the same evidence and commits once', async t => {
  const f = await fixture(t), realSave = f.store.save.bind(f.store);
  let saves = 0;
  f.store.save = async () => { if (++saves === 2) throw new Error('fixture crash before commit'); await realSave(); };
  await assert.rejects(prepareUnsavedBilibiliTagRevision(f.input()), /fixture crash/);
  const onDisk = JSON.parse(fs.readFileSync(f.store.statePath));
  assert.equal(onDisk.fingerprint, 'a'.repeat(64));
  assert.ok(onDisk.tagRevisionIntent);
  const resumed = new JobStore(f.store.jobDir, { fingerprint: onDisk.fingerprint });
  const state = await resumed.initialize();
  await prepareUnsavedBilibiliTagRevision({ ...f.input(), store: resumed, state });
  const after = JSON.parse(fs.readFileSync(resumed.statePath));
  assert.equal(after.fingerprint, f.identity.fingerprint);
  assert.equal(after.revisions.length, 1);
  assert.equal(after.tagRevisionIntent, undefined);
});

test('unsafe targets, stale evidence, changed native identity and any prior save attempt fail closed', async t => {
  for (const kind of ['unconfirmed', 'sibling-change', 'saved-editor', 'no-cid', 'not-completed', 'stale', 'old-save-intent', 'wrong-space']) {
    await t.test(kind, async st => {
      const f = await fixture(st), input = f.input();
      const fresh = JSON.parse(fs.readFileSync(f.freshFile));
      if (kind === 'unconfirmed') input.args = { ...f.args, confirmTagChange: false };
      if (kind === 'sibling-change') input.affectedPlatforms = ['bilibili', 'youtube'];
      if (kind === 'saved-editor') fresh.observation.evidence.nativeUploadIdentity.existingDraft = true;
      if (kind === 'no-cid') fresh.observation.evidence.nativeUploadIdentity.cid = '';
      if (kind === 'not-completed') fresh.observation.evidence.nativeUploadIdentity.uploadComplete = false;
      if (kind === 'stale') fresh.observation.observedAt = '2000-01-01T00:00:00Z';
      if (kind === 'wrong-space') fresh.observation.taskSpaceId = 999;
      if (kind === 'old-save-intent') fs.writeFileSync(`${f.store.receiptCheckpointPath('bilibili')}.draft-save.json`, '{}');
      fs.writeFileSync(f.freshFile, JSON.stringify(fresh));
      const before = fs.readFileSync(f.store.statePath, 'utf8');
      await assert.rejects(prepareUnsavedBilibiliTagRevision(input), /update-tags unfinished Bilibili/);
      assert.equal(fs.readFileSync(f.store.statePath, 'utf8'), before);
    });
  }
});

test('live media binding accepts only the original unsaved upload or its own confirmed first-save journal', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../platforms/bilibili.mjs', import.meta.url)), 'utf8');
  const fn = source.slice(source.indexOf('function validateBilibiliUnsavedTagCorrection('), source.indexOf('\nfunction bilibiliReplacementMetadata('));
  let journal = null;
  const context = vm.createContext({ unsavedBilibiliTagRevisionContext: { sourceNativeUpload: native(), sourceTaskSpaceId: 12, sourceTaskSpaceName: 'original' },
    activeTaskSpace: { id: 12, name: 'original' }, readDraftSaveJournal: () => journal, biliJournalFile: () => '', biliJournalIdentity: () => ({}) });
  vm.runInContext(fn, context);
  context.current = native();
  assert.equal(vm.runInContext('validateBilibiliUnsavedTagCorrection(current).ok', context), true);
  context.current.cid = 'different';
  assert.equal(vm.runInContext('validateBilibiliUnsavedTagCorrection(current).ok', context), false);
  context.current = { ...native(), existingDraft: true, draftId: 'new-first-save-id' };
  assert.equal(vm.runInContext('validateBilibiliUnsavedTagCorrection(current).ok', context), false);
  journal = { status: 'confirmed', plan: { id: 'new-first-save-id' } };
  assert.equal(vm.runInContext('validateBilibiliUnsavedTagCorrection(current).ok', context), true);
});
