import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = value => /^[a-f0-9]{64}$/.test(value || '');
const ids = values => Array.isArray(values) && values.length > 0
  && values.every(value => typeof value === 'string' && value.length > 0)
  && new Set(values).size === values.length;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = message => { throw new Error(`Video replacement ${message}`); };

function validate(value, identity) {
  if (!value || value.version !== 1 || value.platform !== identity.platform
    || value.fingerprint !== identity.fingerprint || !identity.fingerprint
    || !['intent', 'confirmed'].includes(value.status) || !value.attemptId
    || !Number.isFinite(Date.parse(value.startedAt))) fail('journal identity mismatch; reinjection prohibited');
  const p = value.plan;
  if (!p?.sourceDraftId || !Number.isSafeInteger(p.sourceTaskSpaceId) || p.sourceTaskSpaceId <= 0
    || !ids(p.sourceNativeFileIds) || !sha(p.sourceVideoSha256) || !sha(p.nextVideoSha256)
    || p.sourceVideoSha256 === p.nextVideoSha256 || !sha(p.sourceMetadataHash)
    || !sha(p.sourceCoverHash) || p.originalDraftVerified !== true
    || p.liveSourceDraftId !== p.sourceDraftId || !p.nextVideoPath
    || !Number.isSafeInteger(p.nextVideoSize) || p.nextVideoSize <= 0
    || !Number.isSafeInteger(p.nextVideoMtimeMs)) fail('intent lacks exact live original draft and source-file binding');
  if (value.status === 'confirmed' && (!validateVideoReplacementEvidence(value.evidence, p)
    || !(Date.parse(value.confirmedAt) >= Date.parse(value.startedAt)))) fail('confirmation is incomplete');
  return value;
}

export function validateVideoReplacementEvidence(e, plan) {
  return Boolean(e && plan && ['sourceVideoSha256', 'nextVideoSha256', 'sourceMetadataHash', 'sourceCoverHash'].every(key => sha(plan[key]))
    && plan.sourceVideoSha256 !== plan.nextVideoSha256 && ids(plan.sourceNativeFileIds)
    && typeof plan.sourceDraftId === 'string' && plan.sourceDraftId.length > 0
    && Number.isSafeInteger(plan.sourceTaskSpaceId) && plan.sourceTaskSpaceId > 0
    && typeof plan.nextVideoPath === 'string' && plan.nextVideoPath.length > 0
    && Number.isSafeInteger(plan.nextVideoSize) && plan.nextVideoSize > 0 && Number.isSafeInteger(plan.nextVideoMtimeMs)
    && e.sourceDraftId === plan.sourceDraftId && e.draftId === plan.sourceDraftId
    && e.sourceTaskSpaceId === plan.sourceTaskSpaceId && e.sourceVideoSha256 === plan.sourceVideoSha256
    && e.nextVideoSha256 === plan.nextVideoSha256 && same(e.sourceNativeFileIds, plan.sourceNativeFileIds)
    && ids(e.nativeFileIds) && e.nativeFileIds.every(id => !plan.sourceNativeFileIds.includes(id))
    && e.sourceMetadataHash === plan.sourceMetadataHash && e.currentMetadataHash === plan.sourceMetadataHash
    && e.sourceCoverHash === plan.sourceCoverHash && e.currentCoverHash === plan.sourceCoverHash
    && e.metadataUnchanged === true && e.coversUnchanged === true && e.uploadComplete === true
    && e.localFile?.path === plan.nextVideoPath && e.localFile.size === plan.nextVideoSize
    && e.localFile.lastModified === plan.nextVideoMtimeMs && e.localFile.sha256 === plan.nextVideoSha256
    && Number.isFinite(Date.parse(e.observedAt)));
}

export function readVideoReplacementJournal(file, identity) {
  if (!file || !fs.existsSync(file)) return null;
  return validate(JSON.parse(fs.readFileSync(file, 'utf8')), identity);
}

function write(file, value) {
  if (!file) fail('requires a durable journal before file injection');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined; fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return value;
}

// A pending intent is never automatically restarted: the caller must reconcile
// its exact original draft without injecting the same media a second time.
export function beginVideoReplacement(file, identity, plan) {
  if (readVideoReplacementJournal(file, identity)) fail('attempt already exists; reconcile without another injection');
  return write(file, validate({ version: 1, ...identity, status: 'intent', attemptId: randomUUID(),
    startedAt: new Date().toISOString(), plan }, identity));
}

export function confirmVideoReplacement(file, identity, attemptId, evidence) {
  const old = readVideoReplacementJournal(file, identity);
  if (!old || old.status !== 'intent' || old.attemptId !== attemptId
    || !validateVideoReplacementEvidence(evidence, old.plan)) fail('cannot confirm another draft, file or changed metadata');
  return write(file, validate({ ...old, status: 'confirmed', confirmedAt: new Date().toISOString(), evidence }, identity));
}

export const videoReplacementSnapshotHash = hash;
