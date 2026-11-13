import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { xhsNativePublicationBlocker } from './xiaohongshu-publication-guard.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`XHS original-draft reconciliation: ${message}`); };
const SCOPES = ['unpublished', 'original-recovery', 'replace-video'];

export function validateXhsHumanAuthorization(a, expected, now = Date.now()) {
  if (a?.version !== 2 || a.kind !== 'user_attested_original_draft_replacement'
    || a.platform !== 'xiaohongshu' || a.authorizationSource?.type !== 'direct-human-message'
    || !String(a.authorizationSource.answer || '').trim() || !String(a.authorizationSource.source || '').trim()
    || !SCOPES.every(scope => a.scopes?.includes(scope))
    || a.nativePublicationStatusProof !== false) fail('requires a directly attributed human answer and explicit recovery scopes; never native status');
  const time = Date.parse(a.attestedAt);
  if (!Number.isFinite(time) || time > now + 60000 || now - time > 86400000) fail('human authorization is stale or invalid');
  for (const key of ['jobId', 'sourceFingerprint', 'sourceTaskSpaceId', 'sourceTaskSpaceName', 'uid',
    'sourceDraftId', 'sourceVideoFileId', 'nextVideoSha256']) {
    if (expected[key] !== a[key]) fail(`authorization does not bind ${key}`);
  }
  if (!/^[a-f0-9]{64}$/.test(a.sourceJournalSha256 || '') || !/^[a-f0-9]{64}$/.test(a.nextVideoSha256 || '')) fail('missing source-journal or next-video hash');
  return a;
}

export function readXhsHumanAuthorization(file, expected, now = Date.now()) {
  const bytes = fs.readFileSync(file), value = JSON.parse(bytes);
  return { ...validateXhsHumanAuthorization(value, expected, now),
    manifestPath: path.resolve(file), manifestSha256: hash(bytes) };
}

export function explicitXhsReconcileAuthorization(r, operation, phase) {
  if (operation !== 'reconcile-xhs-original' || !['persist', 'verify', 'park'].includes(phase)
    || r?.platform !== 'xiaohongshu' || !r.userAuthorization?.manifestPath || !r.userAuthorization.manifestSha256) return false;
  try {
    const a = r.userAuthorization;
    if (hash(fs.readFileSync(a.manifestPath)) !== a.manifestSha256) return false;
    validateXhsHumanAuthorization(a, {
      jobId: r.jobId, sourceFingerprint: r.sourceFingerprint, sourceTaskSpaceId: r.originalSourceTaskSpaceId || r.sourceTaskSpaceId,
      sourceTaskSpaceName: r.sourceTaskSpaceName, uid: r.sourceUid, sourceDraftId: r.sourceDraftId,
      sourceVideoFileId: r.sourceVideoFileId, nextVideoSha256: r.nextVideoIdentity?.sha256,
    });
    return a.sourceJournalSha256 === r.originalJournalSha256;
  } catch { return false; }
}

export function validateXhsReconcileNative(native, inspection, r) {
  const published = xhsNativePublicationBlocker(native);
  if (published) fail('native resource has a positive published marker');
  if (!native?.available || !native.isFromDraft || native.id !== r.sourceDraftId || native.uid !== r.sourceUid
    || native.record?.id !== r.sourceDraftId || native.record.uid !== r.sourceUid
    || native.live?.videoFileId !== r.sourceVideoFileId || native.record.snapshot?.videoFileId !== r.sourceVideoFileId
    || hash(JSON.stringify(native.live)) !== hash(JSON.stringify(native.record.snapshot))) fail('native account, UUID, video or record/live snapshot differs');
  const required = ['authenticated', 'draftIdentity', 'video', 'title', 'description', 'tags', 'original', 'cover', 'noBlockingDialog', 'finalButton', 'safety'];
  const missing = required.filter(key => inspection?.gates?.[key]?.ok !== true);
  if (inspection?.blocker || missing.length) fail(`original package gates are not verified: ${missing.join(',')}`);
  return { snapshotHash: hash(JSON.stringify(native.live)), draftId: native.id, uid: native.uid,
    videoFileId: native.live.videoFileId, checkedGates: required };
}

export function archiveXhsOriginalJournal(file, archivePath, expectedHash) {
  const bytes = fs.readFileSync(file);
  if (hash(bytes) !== expectedHash) fail('original journal changed before archiving');
  fs.mkdirSync(path.dirname(archivePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(archivePath)) {
    if (hash(fs.readFileSync(archivePath)) !== expectedHash) fail('original-journal archive differs');
  } else {
    const fd = fs.openSync(archivePath, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const directory = fs.openSync(path.dirname(archivePath), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  return { path: archivePath, sha256: expectedHash };
}
