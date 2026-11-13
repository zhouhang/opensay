import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const safe = o => o?.finalPublishClicked === false && o.gates?.safety?.ok === true
  && o.gates.safety.evidence?.guardArmed === true
  && o.gates.safety.evidence?.blockedAttempts === 0
  && o.gates.safety.evidence?.finalPublishClicked === false;

// This historical artifact grants only same-resource native reopening. It is
// never a video-upload receipt, persistence proof or current READY verdict.
export function validateXhsAutosaveRecoverySource(source, expected) {
  if (!source || source.version !== 1 || !path.isAbsolute(source.evidencePath || '')
    || !/^[a-f0-9]{64}$/.test(source.evidenceSha256 || '')
    || !Number.isInteger(source.originalSourceTaskSpaceId) || source.originalSourceTaskSpaceId <= 0
    || !Number.isInteger(source.taskSpaceId) || source.taskSpaceId <= 0) throw new Error('Invalid XHS autosave source binding');
  const bytes = fs.readFileSync(source.evidencePath);
  if (digest(bytes) !== source.evidenceSha256) throw new Error('XHS autosave source artifact changed');
  const o = JSON.parse(bytes.toString('utf8')).observation;
  const id = o?.gates?.draftIdentity?.evidence?.restoredIdentity;
  if (!o || o.platform !== 'xiaohongshu' || o.fingerprint !== expected.fingerprint
    || Number(o.taskSpaceId) !== Number(source.originalSourceTaskSpaceId) || o.taskSpace !== expected.taskSpaceName
    || o.taskSpaceRecovery?.recreated || !Number.isFinite(Date.parse(o.observedAt)) || !safe(o)
    || o.gates?.authenticated?.ok !== true || o.gates?.draftIdentity?.ok !== true
    || o.gates?.draftIdentity?.evidence?.filenameVisible !== true || o.gates?.video?.ok !== true
    || o.gates?.video?.evidence?.filename !== expected.videoName
    || !id?.actualId || !id.uid || !id.videoFileId
    || source.draftId !== id.actualId || source.uid !== id.uid || source.videoFileId !== id.videoFileId
    || source.fingerprint !== expected.fingerprint || Number(source.taskSpaceId) !== Number(expected.taskSpaceId)
    || source.taskSpaceName !== expected.taskSpaceName || source.videoName !== expected.videoName) {
    throw new Error('XHS autosave source does not prove the original uploaded resource');
  }
  return source;
}

export function xhsAutosaveRecoverySource(state) {
  const item = state?.platforms?.xiaohongshu;
  const fingerprint = state?.platformFingerprints?.xiaohongshu || state?.fingerprint;
  if (!fingerprint || !item?.taskSpaceId || !item.taskSpaceName
    || [state.tagRevision, state.coverRevision, state.videoRevision].some(r => r
      && (r.sources?.xiaohongshu || !Array.isArray(r.platforms) || r.platforms.includes('xiaohongshu')))) return null;
  const sources = [];
  const files = [...new Set([...(item.history || []).map(entry => entry?.evidencePath), item.lastEvidencePath].filter(Boolean))];
  for (const file of files) {
    try {
      const bytes = fs.readFileSync(file), o = JSON.parse(bytes.toString('utf8')).observation;
      const identity = o?.gates?.draftIdentity?.evidence;
      const native = identity?.restoredIdentity;
      if (!native?.actualId || !native.uid || !native.videoFileId) continue;
      const source = { version: 1, evidencePath: path.resolve(file), evidenceSha256: digest(bytes),
        fingerprint, taskSpaceId: item.taskSpaceId, originalSourceTaskSpaceId: o.taskSpaceId, taskSpaceName: item.taskSpaceName,
        videoName: o.gates?.video?.evidence?.filename || '',
        draftId: native.actualId, uid: native.uid, videoFileId: native.videoFileId };
      validateXhsAutosaveRecoverySource(source, { fingerprint, taskSpaceId: item.taskSpaceId, originalSourceTaskSpaceId: o.taskSpaceId,
        taskSpaceName: item.taskSpaceName, videoName: source.videoName });
      sources.push(source);
    } catch { /* An incomplete observation grants no recovery authority. */ }
  }
  if (!sources.length || new Set(sources.map(s => JSON.stringify([s.draftId, s.uid, s.videoFileId, s.videoName]))).size !== 1) return null;
  return sources.at(-1);
}
