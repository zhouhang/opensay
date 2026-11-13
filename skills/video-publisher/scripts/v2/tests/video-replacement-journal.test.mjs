import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginVideoReplacement, readVideoReplacementJournal, confirmVideoReplacement,
  validateVideoReplacementEvidence } from '../lib/video-replacement-journal.mjs';
import { evaluateObservation, requiredGates } from '../lib/model.mjs';
import { persistenceEvidence } from './persistence-fixture.mjs';

const plan = { sourceDraftId: 'original-native-id', sourceTaskSpaceId: 72,
  sourceNativeFileIds: ['original-native-file'], sourceVideoSha256: 'a'.repeat(64), nextVideoSha256: 'b'.repeat(64),
  sourceMetadataHash: 'c'.repeat(64), sourceCoverHash: 'd'.repeat(64), originalDraftVerified: true,
  liveSourceDraftId: 'original-native-id', nextVideoPath: '/approved/new.mp4', nextVideoSize: 1234, nextVideoMtimeMs: 123456789 };
const evidence = () => ({ sourceDraftId: plan.sourceDraftId, draftId: plan.sourceDraftId,
  sourceTaskSpaceId: plan.sourceTaskSpaceId, sourceNativeFileIds: plan.sourceNativeFileIds,
  sourceVideoSha256: plan.sourceVideoSha256, nextVideoSha256: plan.nextVideoSha256,
  nativeFileIds: ['new-native-file'], sourceMetadataHash: plan.sourceMetadataHash, currentMetadataHash: plan.sourceMetadataHash,
  sourceCoverHash: plan.sourceCoverHash, currentCoverHash: plan.sourceCoverHash,
  metadataUnchanged: true, coversUnchanged: true, uploadComplete: true,
  localFile: { path: plan.nextVideoPath, size: plan.nextVideoSize, lastModified: plan.nextVideoMtimeMs, sha256: plan.nextVideoSha256 },
  observedAt: new Date().toISOString() });

test('durable source injection intent survives process boundaries and blocks double injection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replacement-journal-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'new-video.replacement.json'), identity = { platform: 'bilibili', fingerprint: 'new-package' };
  const intent = beginVideoReplacement(file, identity, plan);
  assert.equal(JSON.parse(fs.readFileSync(file)).status, 'intent');
  assert.deepEqual(readVideoReplacementJournal(file, identity), intent);
  assert.throws(() => beginVideoReplacement(file, identity, plan), /already exists/);
  assert.throws(() => confirmVideoReplacement(file, identity, 'other-attempt', evidence()), /cannot confirm/);
  const saved = confirmVideoReplacement(file, identity, intent.attemptId, evidence());
  assert.equal(saved.status, 'confirmed');
  assert.equal(saved.plan.sourceDraftId, plan.sourceDraftId);
  assert.throws(() => beginVideoReplacement(file, identity, plan), /already exists/);
  assert.throws(() => readVideoReplacementJournal(file, { ...identity, fingerprint: 'foreign' }), /identity mismatch/);
});

test('native ID replacement evidence rejects stale media, different drafts, changed copy and changed covers', () => {
  assert.equal(validateVideoReplacementEvidence(evidence(), plan), true);
  for (const patch of [ { draftId: 'new-created-copy' }, { sourceDraftId: 'foreign' }, { sourceTaskSpaceId: 99 },
    { nativeFileIds: plan.sourceNativeFileIds }, { nextVideoSha256: plan.sourceVideoSha256 },
    { sourceNativeFileIds: ['another-original-file'] }, { currentMetadataHash: 'e'.repeat(64) },
    { currentCoverHash: 'f'.repeat(64) }, { metadataUnchanged: false }, { uploadComplete: false },
    { localFile: { ...evidence().localFile, sha256: plan.sourceVideoSha256 } } ]) {
    assert.equal(validateVideoReplacementEvidence({ ...evidence(), ...patch }, plan), false, JSON.stringify(patch));
  }
});

test('source replacement cannot reach READY through ordinary historical video or persistence gates', () => {
  const now = new Date().toISOString();
  const gates = Object.fromEntries(requiredGates('bilibili').map(name => [name, { ok: true, evidence: {} }]));
  gates.safety.evidence = { finalPublishClicked: false, guardArmed: true, blockedAttempts: 0 };
  gates.persistedDraft.evidence = { ...persistenceEvidence('bilibili', 'new-package', 'current-run'),
    draftId: plan.sourceDraftId, listEntryId: plan.sourceDraftId, reopenedId: plan.sourceDraftId };
  const o = { platform: 'bilibili', phase: 'verify', taskSpaceId: 72, observedAt: now,
    fingerprint: 'new-package', verificationRunId: 'current-run', finalPublishClicked: false, gates,
    videoRevision: { sourceDraftId: plan.sourceDraftId, sourceTaskSpaceId: 72,
      sourceVideoSha256: plan.sourceVideoSha256, nextVideoSha256: plan.nextVideoSha256 } };
  assert.equal(evaluateObservation(o).ready, false);
  gates.replaceVideo = { ok: true, evidence: evidence() };
  o.observedAt = new Date().toISOString();
  assert.equal(evaluateObservation(o).ready, true);
  gates.replaceVideo.evidence.nativeFileIds = plan.sourceNativeFileIds;
  assert.equal(evaluateObservation(o).ready, false);
  gates.replaceVideo.evidence = evidence();
  gates.persistedDraft.evidence.draftId = 'silently-created-copy';
  assert.equal(evaluateObservation(o).ready, false);
});
