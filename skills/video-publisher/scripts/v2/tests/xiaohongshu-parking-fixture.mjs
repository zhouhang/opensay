import { createHash } from 'node:crypto';
import { requiredGates } from '../lib/model.mjs';
import { XHS_PARKED_SURFACE } from '../lib/persistence.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const at = second => new Date(Date.UTC(2026, 9, 20, 1, 0, second)).toISOString();
const ok = evidence => ({ ok: true, evidence });
const safety = () => ok({ finalPublishClicked: false, guardArmed: true, blockedAttempts: 0 });
const listUrl = 'https://creator.xiaohongshu.com/publish/publish?target=video';

export function parkingObservation({ historical = false, evidencePath = '/job/evidence/editor-verify.json' } = {}) {
  const fingerprint = 'exact-approved-package';
  const draftId = 'original-native-uuid', uid = 'original-account', videoFileId = 'original-upload-file';
  const coverFileId = 'spectrum/accepted-cover', coverWidth = 1600, coverHeight = 1200;
  const snapshot = { title: 'Approved title', videoFileId, coverFileId };
  const snapshotHash = digest(snapshot);
  const sourceRun = historical ? 'original-verification-run' : 'current-verification-run';
  const nativeCover = { fileid: coverFileId, width: coverWidth, height: coverHeight };
  const editor = {
    platform: 'xiaohongshu', phase: 'verify', fingerprint, verificationRunId: sourceRun,
    taskSpaceId: 71, observedAt: at(3),
    gates: Object.fromEntries(requiredGates('xiaohongshu').map(name => [name, ok({})])),
  };
  editor.gates.safety = safety();
  editor.gates.title = ok({ expected: 'Approved title', actual: 'Approved title' });
  editor.gates.draftIdentity = ok({ restoredIdentity: { ok: true, draftId, videoFileId } });
  editor.gates.cover = ok({ nativeCoverFileId: coverFileId, nativeCover: { ...nativeCover }, recordCover: { ...nativeCover } });
  editor.gates.persistedDraft = ok({ version: 2, method: 'draft-list-reopen', platform: 'xiaohongshu',
    fingerprint, verificationRunId: sourceRun, savedAt: at(1), readAt: at(2),
    draftId, listEntryId: draftId, reopenedId: draftId, listUrl, reopenedUrl: listUrl,
    documentChanged: true, storageScope: 'browser-local', uid, snapshotHash });
  const proof = {
    version: 2, method: XHS_PARKED_SURFACE, platform: 'xiaohongshu', fingerprint,
    verificationRunId: 'current-verification-run', taskSpaceId: 71,
    draftId, uid, videoFileId, snapshotHash, coverFileId, coverWidth, coverHeight,
    savedAt: at(1), editorVerifiedAt: at(3), parkedAt: at(4), readAt: at(5),
    listUrl, parkedUrl: listUrl, listEntryId: draftId, visibleRowCount: 1,
    visibleRowTitle: 'Approved title', documentChanged: true, oldEditorAbsent: true,
    editorVerification: { observation: editor, observationHash: digest(editor), evidencePath, historical },
    ...(historical ? { parkOnly: true } : {}),
  };
  return {
    platform: 'xiaohongshu', phase: 'park', surface: XHS_PARKED_SURFACE,
    fingerprint, verificationRunId: 'current-verification-run', taskSpaceId: 71, observedAt: at(6),
    evidence: {
      currentNativeRecord: { id: draftId, uid, snapshot: { ...snapshot } },
      currentNativeCover: { ...nativeCover },
      currentListRows: [{ id: draftId, title: 'Approved title', visible: true,
        thumbnailImages: [{ src: 'https://ros-preview.xhscdn.com/spectrum/accepted-cover?sign=read', complete: true,
          naturalWidth: coverWidth, naturalHeight: coverHeight, visible: true, decoded: true }],
        thumbnailUrls: ['url("https://ros-preview.xhscdn.com/spectrum/accepted-cover?sign=read")'] }],
      currentEditor: { activeId: null, activeVideoFileId: '', activeTitle: '', activeDescription: '', url: listUrl },
    },
    gates: {
      authenticated: ok({ uid }),
      draftIdentity: ok({ draftId, uid, videoFileId, snapshotHash }),
      editorVerified: ok({ historical, observationHash: proof.editorVerification.observationHash,
        evidencePath: proof.editorVerification.evidencePath, verificationRunId: sourceRun }),
      parkedDraft: ok(structuredClone(proof)),
      noActiveEditor: ok({ oldEditorAbsent: true, documentChanged: true }),
      persistedDraft: ok(proof), safety: safety(),
    },
  };
}

