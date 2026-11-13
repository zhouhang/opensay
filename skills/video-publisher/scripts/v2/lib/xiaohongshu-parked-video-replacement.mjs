import { validXhsParkedPersistence } from './persistence.mjs';
import { validateVideoReplacementEvidence } from './video-replacement-journal.mjs';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The parked upload form is intentionally empty. New media is verified through
// the freshly read original IndexedDB record and its immutable editor verify,
// never by reopening that editor or pretending an empty upload form has video.
export function xhsParkedVideoReplacementGate(observation, { journal = null, revision = null,
  currentLocalFile = null, currentCoverHash = null } = {}) {
  const fail = reason => ({ ok: false, evidence: { reason } });
  const marker = observation?.videoRevision;
  const proof = observation?.gates?.persistedDraft?.evidence;
  const editor = proof?.editorVerification?.observation;
  const e = editor?.gates?.replaceVideo?.evidence;
  if (!marker || observation.platform !== 'xiaohongshu' || observation.surface !== 'xhs-draft-list-parked'
    || !validXhsParkedPersistence(observation) || editor?.gates?.replaceVideo?.ok !== true || !e) return fail('Parked original record lacks complete independent replacement verification');
  const plan = journal?.plan || { ...e, nextVideoPath: e.localFile?.path,
    nextVideoSize: e.localFile?.size, nextVideoMtimeMs: e.localFile?.lastModified };
  const current = observation.evidence?.currentNativeRecord?.snapshot;
  if (journal) {
    const video = observation.evidence?.currentNativeVideo;
    const metadataHash = hash({ title: current?.title, description: current?.description,
      descriptionHtml: current?.descriptionHtml, original: current?.original });
    if (video?.fileid !== proof.videoFileId || video.size !== plan.nextVideoSize
      || metadataHash !== plan.sourceMetadataHash || currentCoverHash !== plan.sourceCoverHash
      || !validateVideoReplacementEvidence({ ...e, localFile: currentLocalFile }, plan)) return fail('Fresh parked native size, metadata, local bytes or approved cover changed');
  }
  if (journal && journal.status !== 'confirmed' || !validateVideoReplacementEvidence(e, plan)
    || marker.sourceDraftId !== proof.draftId || marker.sourceTaskSpaceId !== proof.taskSpaceId
    || marker.sourceVideoSha256 !== e.sourceVideoSha256 || marker.nextVideoSha256 !== e.nextVideoSha256
    || editor.videoRevision?.sourceDraftId !== marker.sourceDraftId
    || editor.videoRevision?.nextVideoSha256 !== marker.nextVideoSha256
    || e.draftId !== proof.draftId || e.uid !== proof.uid || e.sourceTaskSpaceId !== proof.taskSpaceId
    || e.nativeFileIds?.length !== 1 || e.nativeFileIds[0] !== proof.videoFileId
    || revision && (revision.sourceDraftId !== proof.draftId || revision.sourceUid !== proof.uid
      || revision.nextVideoIdentity.sha256 !== e.nextVideoSha256
      || revision.sourceVideoIdentity.sha256 !== e.sourceVideoSha256)) return fail('Fresh parked UUID/account/video differs from the confirmed replacement');
  return { ok: true, evidence: { ...e, observedAt: proof.readAt,
    verificationMethod: 'xhs-parked-native-record-and-immutable-editor-verify',
    parkedNativeSnapshotHash: proof.snapshotHash, editorObservationHash: proof.editorVerification.observationHash } };
}
