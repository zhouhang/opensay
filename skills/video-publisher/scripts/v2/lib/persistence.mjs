import { createHash } from 'node:crypto';

export const PERSISTENCE_VERSION = 2;
export const XHS_PARKED_SURFACE = 'xhs-draft-list-parked';

const XHS_EDITOR_GATES = ['authenticated', 'draftIdentity', 'video', 'title', 'description',
  'tags', 'original', 'cover', 'noBlockingDialog', 'finalButton', 'safety', 'persistedDraft'];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const hash = value => {
  try { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  catch { return null; }
};
const sameSpace = (left, right) => Number.isSafeInteger(Number(left)) && Number(left) > 0
  && Number(left) === Number(right);
const cleanSafety = gate => gate?.ok === true && gate.evidence?.finalPublishClicked === false
  && gate.evidence?.guardArmed === true && gate.evidence?.blockedAttempts === 0;
const xhsCoverKey = value => typeof value === 'string'
  ? value.match(/(?:^|\/)spectrum\/([^?"')\\]+)/)?.[1] || '' : '';
const trustedXhsUrl = value => {
  try {
    const url = new URL(value);
    return url.origin === 'https://creator.xiaohongshu.com' && !url.username && !url.password;
  } catch { return false; }
};

// The old editor verification is immutable evidence. A parked page must prove
// its own current account, native record and list row, rather than inventing
// editor controls on a page that no longer contains that editor.
export function validXhsParkedPersistence(observation) {
  const p = observation?.gates?.persistedDraft?.evidence;
  if (observation?.platform !== 'xiaohongshu' || observation.surface !== XHS_PARKED_SURFACE
    || observation.gates?.persistedDraft?.ok !== true || p?.method !== XHS_PARKED_SURFACE
    || p.version !== PERSISTENCE_VERSION || p.platform !== observation.platform
    || !nonempty(observation.verificationRunId) || p.verificationRunId !== observation.verificationRunId
    || !nonempty(observation.fingerprint) || p.fingerprint !== observation.fingerprint
    || !sameSpace(p.taskSpaceId, observation.taskSpaceId)
    || !['draftId', 'uid', 'videoFileId', 'coverFileId', 'visibleRowTitle'].every(key => nonempty(p[key]))
    || !/^[a-f0-9]{64}$/.test(p.snapshotHash || '')
    || !Number.isFinite(p.coverWidth) || p.coverWidth <= 0
    || !Number.isFinite(p.coverHeight) || p.coverHeight <= 0
    || p.listEntryId !== p.draftId || p.visibleRowCount !== 1
    || p.documentChanged !== true || p.oldEditorAbsent !== true
    || !trustedXhsUrl(p.listUrl) || !trustedXhsUrl(p.parkedUrl)
    || p.listUrl !== p.parkedUrl) return false;
  const times = [p.savedAt, p.editorVerifiedAt, p.parkedAt, p.readAt, observation.observedAt].map(Date.parse);
  if (!times.every(Number.isFinite) || times.some((time, index) => index > 0 && time < times[index - 1])
    || times[4] - times[3] > 60000) return false;
  const native = observation.evidence?.currentNativeRecord;
  const nativeCover = observation.evidence?.currentNativeCover;
  const rows = observation.evidence?.currentListRows;
  const active = observation.evidence?.currentEditor;
  const coverKey = xhsCoverKey(p.coverFileId);
  const matchingLoadedImages = Array.isArray(rows?.[0]?.thumbnailImages) ? rows[0].thumbnailImages.filter(image =>
    image?.visible === true && image.complete === true && image.decoded === true
      && Number(image.naturalWidth) > 0 && Number(image.naturalHeight) > 0
      && xhsCoverKey(image.src) === coverKey) : [];
  if (!native || native.id !== p.draftId || native.uid !== p.uid
    || native.snapshot?.videoFileId !== p.videoFileId || native.snapshot?.coverFileId !== p.coverFileId
    || hash(native.snapshot) !== p.snapshotHash || nativeCover?.fileid !== p.coverFileId
    || nativeCover.width !== p.coverWidth || nativeCover.height !== p.coverHeight
    || !Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== p.draftId
    || rows[0].visible !== true || rows[0].title !== p.visibleRowTitle || !coverKey
    || matchingLoadedImages.length !== 1
    || !active || !(active.activeId === null || nonempty(active.activeId))
    || active.activeId === p.draftId || active.activeVideoFileId !== ''
    || active.activeTitle !== '' || active.activeDescription !== '' || active.url !== p.parkedUrl) return false;
  const source = p.editorVerification;
  const editor = source?.observation;
  const historical = source?.historical === true;
  if (!editor || !nonempty(source.evidencePath) || !/^[a-f0-9]{64}$/.test(source.observationHash || '')
    || source.observationHash !== hash(editor) || editor.platform !== 'xiaohongshu'
    || editor.phase !== 'verify' || editor.surface === XHS_PARKED_SURFACE || editor.blocker
    || editor.fingerprint !== p.fingerprint || !sameSpace(editor.taskSpaceId, p.taskSpaceId)
    || !nonempty(editor.verificationRunId)
    || (historical ? p.parkOnly !== true : editor.verificationRunId !== observation.verificationRunId)
    || Date.parse(editor.observedAt) !== times[1]
    || !XHS_EDITOR_GATES.every(name => editor.gates?.[name]?.ok === true)
    || !cleanSafety(editor.gates.safety) || !validPersistence(editor)) return false;
  const ep = editor.gates.persistedDraft.evidence;
  const cover = editor.gates.cover.evidence;
  const identity = editor.gates.draftIdentity.evidence?.restoredIdentity;
  if (ep.method !== 'draft-list-reopen' || ep.storageScope !== 'browser-local'
    || ep.draftId !== p.draftId || ep.uid !== p.uid || ep.snapshotHash !== p.snapshotHash
    || Date.parse(ep.savedAt) !== times[0]
    || identity?.ok !== true || identity.draftId !== p.draftId || identity.videoFileId !== p.videoFileId
    || (ep.videoFileId !== undefined && ep.videoFileId !== p.videoFileId)
    || editor.gates.title.evidence?.actual !== p.visibleRowTitle
    || cover?.nativeCoverFileId !== p.coverFileId
    || ![cover?.nativeCover, cover?.recordCover].every(nativeCover => nativeCover?.fileid === p.coverFileId
      && nativeCover.width === p.coverWidth && nativeCover.height === p.coverHeight)) return false;
  const gates = observation.gates;
  const editorGate = gates.editorVerified?.evidence;
  const identityGate = gates.draftIdentity?.evidence;
  const parked = gates.parkedDraft;
  return gates.authenticated?.ok === true && gates.authenticated.evidence?.uid === p.uid
    && gates.draftIdentity?.ok === true
    && ['draftId', 'uid', 'videoFileId', 'snapshotHash'].every(key => identityGate?.[key] === p[key])
    && gates.editorVerified?.ok === true && editorGate?.historical === historical
    && editorGate.observationHash === source.observationHash && editorGate.evidencePath === source.evidencePath
    && editorGate.verificationRunId === editor.verificationRunId
    && parked?.ok === true && hash(parked.evidence) === hash(p)
    && gates.noActiveEditor?.ok === true && gates.noActiveEditor.evidence?.oldEditorAbsent === true
    && gates.noActiveEditor.evidence?.documentChanged === true
    && cleanSafety(gates.safety);
}

// Action receipts and receipts recovered from disk cannot prove this run's state.
export function validPersistence(observation) {
  if (observation?.surface === XHS_PARKED_SURFACE
    || observation?.gates?.persistedDraft?.evidence?.method === XHS_PARKED_SURFACE) {
    return validXhsParkedPersistence(observation);
  }
  const p = observation.gates?.persistedDraft?.evidence;
  if (observation.gates?.persistedDraft?.ok !== true || !p) return false;
  if (p.version !== PERSISTENCE_VERSION || !observation.verificationRunId
    || p.verificationRunId !== observation.verificationRunId
    || !observation.fingerprint || p.fingerprint !== observation.fingerprint
    || p.platform !== observation.platform || !p.draftId) return false;
  const saved = Date.parse(p.savedAt);
  const read = Date.parse(p.readAt);
  const observed = Date.parse(observation.observedAt);
  if (!Number.isFinite(saved) || !Number.isFinite(read) || !Number.isFinite(observed)
    || read < saved || observed < read || observed - read > 60000) return false;
  if (observation.platform === 'youtube') {
    return p.method === 'youtube.videos.list' && p.private === true
      && p.actualId === p.draftId && p.channelVerified === true;
  }
  if (observation.platform === 'douyin') {
    return p.method === 'resume-slot-reopen' && p.resumeSlotObserved === true
      && p.resumeSlotId === p.draftId && Boolean(p.reopenedId)
      && p.routeChanged === true && p.contentReadback === true
      && Boolean(p.uploadUrl) && Boolean(p.reopenedUrl);
  }
  return p.method === 'draft-list-reopen' && p.listEntryId === p.draftId
    && p.reopenedId === p.draftId && p.documentChanged === true
    && Boolean(p.listUrl) && Boolean(p.reopenedUrl);
}
