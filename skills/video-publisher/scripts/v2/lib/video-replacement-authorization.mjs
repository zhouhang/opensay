import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateXhsHumanAuthorization } from './xiaohongshu-reconcile-authorization.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = text => { throw new Error(`Original-video authorization ${text}`); };

export function readVideoReplacementAuthorization(file, expected) {
  if (!file || !fs.existsSync(file)) fail('requires a direct human attestation for the exact XHS original draft');
  const bytes = fs.readFileSync(file), a = JSON.parse(bytes);
  if (a.version === 2) {
    validateXhsHumanAuthorization(a, expected);
    return { ...a, manifestPath: path.resolve(file), manifestSha256: hash(bytes) };
  }
  if (a.version !== 1 || a.kind !== 'user_attested_original_draft_replacement'
    || a.platform !== 'xiaohongshu' || a.statement !== '尚未发布，只更新原草稿'
    || a.authorizationSource?.type !== 'direct-human-message' || a.authorizationSource.answer !== a.statement
    || !Number.isFinite(Date.parse(a.attestedAt)) || Date.parse(a.attestedAt) > Date.now() + 60000
    || Date.now() - Date.parse(a.attestedAt) > 24 * 60 * 60 * 1000) fail('must be a recent, explicitly scoped human statement, not fabricated native status');
  for (const key of ['jobId', 'sourceFingerprint', 'sourceTaskSpaceId', 'sourceTaskSpaceName', 'uid', 'sourceDraftId', 'sourceVideoFileId', 'nextVideoSha256']) {
    if (a[key] !== expected[key]) fail(`does not bind ${key}`);
  }
  return { ...a, manifestPath: path.resolve(file), manifestSha256: hash(bytes) };
}

export function explicitVideoReplacementAuthorization(revision, operation) {
  if (operation !== 'replace-video' || !revision?.userAuthorization) return false;
  const a = revision.userAuthorization;
  const humanScope = a.version === 2
    ? ['unpublished', 'original-recovery', 'replace-video'].every(scope => a.scopes?.includes(scope))
      && a.nativePublicationStatusProof === false && Boolean(String(a.authorizationSource?.answer || '').trim())
    : a.statement === '尚未发布，只更新原草稿' && a.authorizationSource?.answer === a.statement;
  if (a.kind !== 'user_attested_original_draft_replacement' || !humanScope
    || a.authorizationSource?.type !== 'direct-human-message'
    || a.uid !== revision.sourceUid || a.sourceDraftId !== revision.sourceDraftId
    || a.sourceFingerprint !== revision.sourceFingerprint || a.sourceVideoFileId !== revision.sourceVideoFileId
    || a.nextVideoSha256 !== revision.nextVideoIdentity?.sha256 || !a.manifestPath || !a.manifestSha256) return false;
  try { return hash(fs.readFileSync(a.manifestPath)) === a.manifestSha256; } catch { return false; }
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`, fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return value;
}

function bound(value, r) {
  const a = r.userAuthorization;
  return value?.version === 1 && ['intent', 'confirmed'].includes(value.status) && a?.kind === 'user_attested_original_draft_replacement'
    && a.allowMissingOriginalTaskSpaceRecovery === true && value.authorizationManifestSha256 === a.manifestSha256
    && value.sourceDraftId === r.sourceDraftId && value.sourceFingerprint === r.sourceFingerprint
    && value.previousTaskSpaceId === (r.originalSourceTaskSpaceId || r.sourceTaskSpaceId)
    && value.taskSpaceName === r.sourceTaskSpaceName && value.nextVideoSha256 === r.nextVideoIdentity.sha256
    && Array.isArray(value.beforeIds) && value.beforeIds.every(Number.isSafeInteger);
}

export function readVideoReplacementSpaceBinding(file, revision) {
  if (!file || !fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file));
  if (!bound(value, revision) || value.status === 'confirmed'
    && (!Number.isSafeInteger(value.taskSpaceId) || value.taskSpaceId <= 0 || value.beforeIds.includes(value.taskSpaceId)
      || value.taskSpaceId === value.previousTaskSpaceId)) fail('task-space recovery binding changed');
  return value;
}

export function beginVideoReplacementSpaceRecovery(file, r, beforeIds) {
  if (readVideoReplacementSpaceBinding(file, r)) fail('task recovery intent already exists');
  const value = { version: 1, status: 'intent', at: new Date().toISOString(), attemptId: randomUUID(),
    sourceDraftId: r.sourceDraftId, sourceFingerprint: r.sourceFingerprint,
    authorizationManifestSha256: r.userAuthorization?.manifestSha256,
    previousTaskSpaceId: r.originalSourceTaskSpaceId || r.sourceTaskSpaceId,
    taskSpaceName: r.sourceTaskSpaceName, nextVideoSha256: r.nextVideoIdentity.sha256,
    beforeIds: [...beforeIds] };
  if (!bound(value, r) || beforeIds.includes(value.previousTaskSpaceId)) fail('cannot recover a live original task space');
  return write(file, value);
}

export function confirmVideoReplacementSpaceRecovery(file, r, attemptId, taskSpaceId, taskSpaceName) {
  const old = readVideoReplacementSpaceBinding(file, r);
  if (old?.status !== 'intent' || old.attemptId !== attemptId || taskSpaceName !== old.taskSpaceName
    || !Number.isSafeInteger(taskSpaceId) || taskSpaceId <= 0 || old.beforeIds.includes(taskSpaceId)) fail('cannot adopt an existing or different task space');
  return write(file, { ...old, status: 'confirmed', taskSpaceId, confirmedAt: new Date().toISOString() });
}
