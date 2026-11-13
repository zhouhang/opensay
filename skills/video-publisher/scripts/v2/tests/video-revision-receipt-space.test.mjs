import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parkingObservation } from './xiaohongshu-parking-fixture.mjs';
import { evaluateObservation } from '../lib/model.mjs';
import { validateVideoReplacementEvidence } from '../lib/video-replacement-journal.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = fs.readFileSync(new URL('../lib/video-revision-receipt-space.mjs', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export function reconcile')).replace('export function', 'function');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovered-receipt-scope-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (name, value) => { const p = path.join(root, name); fs.writeFileSync(p, JSON.stringify(value)); return p; };
  const cover = { nativeFileId: 'spectrum/accepted-cover', assetHash: 'c'.repeat(64), assetPath: '/approved/cover.png' };
  const r = { sourceTaskSpaceRecovery: { status: 'confirmed' }, originalSourceTaskSpaceId: 71, sourceTaskSpaceId: 81,
    sourceTaskSpaceName: 'original task name', sourceDraftId: 'original-native-uuid', sourceUid: 'original-account',
    sourceFingerprint: 'old-package', nextFingerprint: 'new-package', nextVideoIdentity: { sha256: 'b'.repeat(64) },
    sourceReceipts: { cover }, spaceBindingPath: file('binding.json', { previousTaskSpaceId: 71, taskSpaceId: 81 }),
    sourceJournalPath: file('source-journal.json', { status: 'confirmed', fingerprint: 'old-package' }),
    sourceEvidencePath: file('source-verify.json', { immutable: true }),
    userAuthorization: { manifestPath: file('authorization.json', { kind: 'user_attested_original_draft_replacement' }) } };
  r.userAuthorization.manifestSha256 = hash(fs.readFileSync(r.userAuthorization.manifestPath));
  r.sourceJournalSha256 = hash(fs.readFileSync(r.sourceJournalPath)); r.sourceEvidenceSha256 = hash(fs.readFileSync(r.sourceEvidencePath));
  const observation = parkingObservation().gates.persistedDraft.evidence.editorVerification.observation;
  observation.taskSpaceId = 81; observation.fingerprint = r.nextFingerprint;
  observation.gates.persistedDraft.evidence.fingerprint = r.nextFingerprint;
  observation.gates.cover.evidence.receipt = structuredClone(cover);
  const p = observation.gates.persistedDraft.evidence;
  const plan = { sourceDraftId: r.sourceDraftId, sourceTaskSpaceId: 81, sourceNativeFileIds: ['old-file'],
    sourceVideoSha256: 'a'.repeat(64), nextVideoSha256: r.nextVideoIdentity.sha256,
    sourceMetadataHash: 'd'.repeat(64), sourceCoverHash: 'e'.repeat(64), nextVideoPath: '/approved/new.mp4', nextVideoSize: 1234, nextVideoMtimeMs: 123456789 };
  const replacement = { ...plan, draftId: r.sourceDraftId, nativeFileIds: ['original-upload-file'],
    currentMetadataHash: plan.sourceMetadataHash, currentCoverHash: plan.sourceCoverHash, metadataUnchanged: true, coversUnchanged: true, uploadComplete: true,
    localFile: { path: plan.nextVideoPath, size: plan.nextVideoSize, lastModified: plan.nextVideoMtimeMs, sha256: plan.nextVideoSha256 }, observedAt: observation.observedAt };
  observation.videoRevision = { sourceDraftId: r.sourceDraftId, sourceTaskSpaceId: 81,
    sourceVideoSha256: plan.sourceVideoSha256, nextVideoSha256: plan.nextVideoSha256 };
  observation.gates.replaceVideo = { ok: true, evidence: replacement };
  const verifyPath = file('new-independent-verify.json', { observation });
  const item = { taskSpaceId: 81, taskSpaceName: r.sourceTaskSpaceName, receiptTaskSpaceId: 71, receipts: { cover: structuredClone(cover) },
    parkingSource: { evidencePath: verifyPath, fingerprint: r.nextFingerprint, taskSpaceId: 81, observationHash: hash(JSON.stringify(observation)) } };
  const injected = { status: 'confirmed', plan, evidence: replacement };
  const saved = { status: 'confirmed', plan: { id: r.sourceDraftId, uid: r.sourceUid,
    videoFileId: replacement.nativeFileIds[0], snapshotHash: p.snapshotHash } };
  const binding = { status: 'confirmed', previousTaskSpaceId: 71, taskSpaceId: 81, attemptId: 'bound-recovery-attempt' };
  const context = vm.createContext({ fs, JSON, hash, isDeepStrictEqual, evaluateObservation, validateVideoReplacementEvidence,
    videoRevisionContext: () => r, readVideoReplacementSpaceBinding: () => binding,
    videoReplacementJournalPath: () => 'new-injection-journal', videoRevisionDraftJournalPath: () => 'new-save-journal',
    readVideoReplacementJournal: () => injected, readDraftSaveJournal: () => saved });
  vm.runInContext(body, context);
  const state = { platforms: { xiaohongshu: item } }, run = () => context.reconcileRecoveredVideoReceiptSpace({ store: {}, state, platform: 'xiaohongshu' });
  assert.equal(evaluateObservation(observation).ready, true);
  return { root, r, item, observation, verifyPath, injected, saved, binding, run };
}

test('unchanged source cover receipt follows only the confirmed recovered space after independent new-media verification', t => {
  const f = fixture(t), originalFiles = [f.r.sourceJournalPath, f.r.sourceEvidencePath, f.r.spaceBindingPath];
  const bytes = originalFiles.map(p => fs.readFileSync(p)), cover = structuredClone(f.item.receipts.cover);
  assert.equal(f.run(), true); assert.equal(f.item.receiptTaskSpaceId, 81);
  assert.equal(f.item.receiptSpaceRecovery.previousTaskSpaceId, 71);
  assert.equal(f.item.receiptSpaceRecovery.nativeCoverFileId, cover.nativeFileId);
  assert.deepEqual(f.item.receipts.cover, cover);
  originalFiles.forEach((p, i) => assert.deepEqual(fs.readFileSync(p), bytes[i]));
});

test('foreign cover receipts, weak replacement proof, wrong saved UUID or unconfirmed space never migrate receipt ownership', t => {
  for (const change of [
    f => { f.item.receipts.cover.assetHash = 'f'.repeat(64); },
    f => { f.item.receipts.uploadStart = { fingerprint: 'old' }; },
    f => { f.binding.status = 'intent'; }, f => { f.saved.plan.id = 'new-copy'; },
    f => { f.saved.plan.videoFileId = 'foreign-file'; }, f => { f.injected.status = 'intent'; },
    f => { fs.appendFileSync(f.r.sourceJournalPath, 'changed'); },
  ]) { const f = fixture(t); change(f); assert.equal(f.run(), false, change.toString()); assert.equal(f.item.receiptTaskSpaceId, 71); }
});

test('a failed or modified current editor verify cannot authorize source receipt reuse in a recovered task', t => {
  const f = fixture(t);
  f.observation.gates.cover.ok = false;
  fs.writeFileSync(f.verifyPath, JSON.stringify({ observation: f.observation }));
  f.item.parkingSource.observationHash = hash(JSON.stringify(f.observation));
  assert.equal(f.run(), false); assert.equal(f.item.receiptTaskSpaceId, 71);
});
