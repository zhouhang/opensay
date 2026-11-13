import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { videoRevisionContext, videoRevisionDraftJournalPath, videoReplacementJournalPath } from './video-revision-job.mjs';
import { readVideoReplacementSpaceBinding } from './video-replacement-authorization.mjs';
import { readVideoReplacementJournal, validateVideoReplacementEvidence } from './video-replacement-journal.mjs';
import { readDraftSaveJournal } from './draft-save-journal.mjs';
import { evaluateObservation } from './model.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Only unchanged cover receipts may follow an explicitly authorized recovered
// XHS task space, after the new video has already been independently verified.
// This never changes old upload receipts or old checkpoint/journal bytes.
export function reconcileRecoveredVideoReceiptSpace({ store, state, platform }) {
  if (platform !== 'xiaohongshu') return false;
  const item = state.platforms[platform], r = videoRevisionContext(state, platform);
  if (!r?.sourceTaskSpaceRecovery || !r.originalSourceTaskSpaceId || item.receiptTaskSpaceId !== r.originalSourceTaskSpaceId
    || item.taskSpaceId !== r.sourceTaskSpaceId || item.taskSpaceName !== r.sourceTaskSpaceName) return false;
  const binding = readVideoReplacementSpaceBinding(r.spaceBindingPath, r);
  if (binding?.status !== 'confirmed' || binding.taskSpaceId !== item.taskSpaceId
    || binding.previousTaskSpaceId !== item.receiptTaskSpaceId
    || hash(fs.readFileSync(r.userAuthorization.manifestPath)) !== r.userAuthorization.manifestSha256
    || hash(fs.readFileSync(r.sourceJournalPath)) !== r.sourceJournalSha256
    || hash(fs.readFileSync(r.sourceEvidencePath)) !== r.sourceEvidenceSha256) return false;
  const sourceCover = r.sourceReceipts?.cover;
  if (!sourceCover?.nativeFileId || !sourceCover.assetHash || !item.receipts?.cover
    || Object.keys(item.receipts).some(key => key !== 'cover')
    || !isDeepStrictEqual(item.receipts.cover, sourceCover)) return false;
  const source = item.parkingSource;
  if (!source?.evidencePath || source.fingerprint !== r.nextFingerprint || source.taskSpaceId !== item.taskSpaceId) return false;
  const bytes = fs.readFileSync(source.evidencePath), observation = JSON.parse(bytes).observation;
  if (hash(JSON.stringify(observation)) !== source.observationHash || observation?.phase !== 'verify'
    || observation.platform !== platform || observation.taskSpaceId !== item.taskSpaceId
    || observation.fingerprint !== r.nextFingerprint || !evaluateObservation(observation).ready) return false;
  const proof = observation.gates.persistedDraft.evidence;
  const cover = observation.gates.cover.evidence;
  const journalIdentity = { platform, fingerprint: r.nextFingerprint };
  const injected = readVideoReplacementJournal(videoReplacementJournalPath(store, state, platform), journalIdentity);
  const saved = readDraftSaveJournal(videoRevisionDraftJournalPath(store, state, platform), journalIdentity);
  const replacement = observation.gates.replaceVideo?.evidence;
  if (injected?.status !== 'confirmed' || saved?.status !== 'confirmed'
    || !validateVideoReplacementEvidence(replacement, injected.plan)
    || injected.plan.nextVideoSha256 !== r.nextVideoIdentity.sha256 || injected.plan.sourceTaskSpaceId !== item.taskSpaceId
    || injected.plan.sourceDraftId !== r.sourceDraftId || proof.draftId !== r.sourceDraftId || proof.uid !== r.sourceUid
    || saved.plan.id !== r.sourceDraftId || saved.plan.uid !== r.sourceUid
    || saved.plan.videoFileId !== injected.evidence.nativeFileIds[0] || saved.plan.snapshotHash !== proof.snapshotHash
    || cover.nativeCoverFileId !== sourceCover.nativeFileId || !isDeepStrictEqual(cover.receipt, sourceCover)) return false;
  const prior = item.receiptTaskSpaceId;
  item.receiptTaskSpaceId = item.taskSpaceId;
  item.receiptSpaceRecovery = { at: new Date().toISOString(), kind: 'unchanged-source-cover-after-independent-new-video-verify',
    previousTaskSpaceId: prior, taskSpaceId: item.taskSpaceId, sourceDraftId: r.sourceDraftId,
    sourceFingerprint: r.sourceFingerprint, fingerprint: r.nextFingerprint, bindingAttemptId: binding.attemptId,
    bindingPath: r.spaceBindingPath, bindingSha256: hash(fs.readFileSync(r.spaceBindingPath)),
    independentVerifyPath: source.evidencePath, independentVerifySha256: hash(bytes),
    sourceCoverAssetHash: sourceCover.assetHash, nativeCoverFileId: sourceCover.nativeFileId };
  return true;
}
