import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const ORIGINS = {
  xiaohongshu: 'https://creator.xiaohongshu.com',
  douyin: 'https://creator.douyin.com',
  bilibili: 'https://member.bilibili.com',
  wechat_channels: 'https://channels.weixin.qq.com',
};

function validate(value, identity) {
  if (value?.version !== 1 || !identity.platform || !identity.fingerprint
    || value.platform !== identity.platform || value.fingerprint !== identity.fingerprint
    || !['intent', 'confirmed'].includes(value.status) || !value.attemptId
    || !Number.isFinite(Date.parse(value.startedAt)) || (!value.plan?.id && !value.plan?.lookupToken)) {
    throw new Error('Draft-save journal identity or schema mismatch; do not save again');
  }
  for (const url of [value.plan.url, value.plan.listUrl]) {
    const parsed = new URL(url);
    if (parsed.origin !== ORIGINS[identity.platform] || parsed.username || parsed.password) {
      throw new Error('Draft-save journal contains an untrusted route');
    }
  }
  if (value.status === 'confirmed' && !(Date.parse(value.savedAt) >= Date.parse(value.startedAt))) {
    throw new Error('Invalid draft-save confirmation time');
  }
  return value;
}

export function readDraftSaveJournal(file, identity) {
  if (!file || !fs.existsSync(file)) return null;
  return validate(JSON.parse(fs.readFileSync(file, 'utf8')), identity);
}

function write(file, value) {
  if (!file) throw new Error('A durable checkpoint path is required before saving a draft');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return value;
}

// Callers hold the publisher, job and platform locks across this transaction.
export function beginDraftSave(file, identity, plan) {
  if (readDraftSaveJournal(file, identity)) throw new Error('Draft-save attempt already exists; reconcile it without another save');
  const value = { version: 1, ...identity, status: 'intent', attemptId: randomUUID(),
    startedAt: new Date().toISOString(), plan };
  return write(file, validate(value, identity));
}

// A confirmed attempt may be superseded only for the same stable draft ID.
// The caller must independently prove the current editor still belongs to that draft.
export function restartConfirmedDraftSave(file, identity, plan, reason) {
  const previous = readDraftSaveJournal(file, identity);
  if (!previous || previous.status !== 'confirmed' || !previous.plan?.id
    || String(previous.plan.id) !== String(plan?.id || '') || !String(reason || '').trim()) {
    throw new Error('Draft-save restart requires a confirmed attempt for the same stable draft ID');
  }
  const supersededAttempts = [...(previous.supersededAttempts || []), {
    attemptId: previous.attemptId,
    startedAt: previous.startedAt,
    savedAt: previous.savedAt,
    reason: String(reason).trim(),
  }].slice(-20);
  const value = { version: 1, ...identity, status: 'intent', attemptId: randomUUID(),
    startedAt: new Date().toISOString(), plan, supersededAttempts };
  return write(file, validate(value, identity));
}

// Browser-local single-slot drafts may issue a fresh editor instance ID after
// reopening. The caller must prove the same cache slot and content identity.
export function restartConfirmedResumeSlotSave(file, identity, plan, reason) {
  const previous = readDraftSaveJournal(file, identity);
  if (!previous || previous.status !== 'confirmed' || !previous.plan?.lookupToken
    || previous.plan.lookupToken !== plan?.lookupToken || !previous.plan?.cacheKey
    || previous.plan.cacheKey !== plan?.cacheKey || !plan?.id || !String(reason || '').trim()) {
    throw new Error('Resume-slot save restart requires the same confirmed cache slot and lookup token');
  }
  const supersededAttempts = [...(previous.supersededAttempts || []), {
    attemptId: previous.attemptId,
    startedAt: previous.startedAt,
    savedAt: previous.savedAt,
    priorEditorId: previous.plan.id || null,
    reason: String(reason).trim(),
  }].slice(-20);
  const value = { version: 1, ...identity, status: 'intent', attemptId: randomUUID(),
    startedAt: new Date().toISOString(), plan, supersededAttempts };
  return write(file, validate(value, identity));
}

// A pending attempt may be superseded only after the caller proves that it had
// no platform-side effect and the same unsaved content remains in the editor.
export function restartUnconfirmedDraftSave(file, identity, plan, reason) {
  const previous = readDraftSaveJournal(file, identity);
  if (!previous || previous.status !== 'intent' || previous.plan?.id || plan?.id
    || !previous.plan?.lookupToken || previous.plan.lookupToken !== plan?.lookupToken
    || !String(reason || '').trim()) {
    throw new Error('Draft-save retry requires a verified no-effect pending attempt for the same lookup token');
  }
  const supersededAttempts = [...(previous.supersededAttempts || []), {
    attemptId: previous.attemptId,
    startedAt: previous.startedAt,
    outcome: 'verified_no_effect',
    reason: String(reason).trim(),
  }].slice(-20);
  const value = { version: 1, ...identity, status: 'intent', attemptId: randomUUID(),
    startedAt: new Date().toISOString(), plan, supersededAttempts };
  return write(file, validate(value, identity));
}

export function confirmDraftSave(file, identity, attemptId, savedAt, planPatch = {}) {
  const previous = readDraftSaveJournal(file, identity);
  if (!previous || previous.attemptId !== attemptId || previous.status !== 'intent') {
    throw new Error('Draft-save confirmation does not match the pending attempt');
  }
  if (previous.plan.id && planPatch.id && String(previous.plan.id) !== String(planPatch.id)) {
    throw new Error('Draft-save confirmation cannot replace a bound native draft ID');
  }
  const value = { ...previous, status: 'confirmed', savedAt, plan: { ...previous.plan, ...planPatch } };
  return write(file, validate(value, identity));
}

// This records an independently reopened confirmed slot, never a new save or a
// replacement of the original raw cache digest. Unknown snapshot changes fail closed.
export function recordConfirmedResumeSlotNormalization(file, identity, attemptId, normalization) {
  const previous = readDraftSaveJournal(file, identity);
  const snapshot = normalization?.snapshot;
  if (identity.platform !== 'douyin' || previous?.status !== 'confirmed' || previous.attemptId !== attemptId
    || !previous.plan.cacheKey || normalization?.cacheKey !== previous.plan.cacheKey
    || normalization.originalCacheDigest !== previous.plan.cacheDigest
    || !/^[a-f0-9]{8}$/.test(normalization.observedCacheDigest || '')
    || snapshot?.version !== 1 || !snapshot.vid || !snapshot.uri || !/^[a-f0-9]{64}$/.test(snapshot.hash || '')
    || String(snapshot.value?.cache?.longFileInfo?.vid || '') !== snapshot.vid
    || String(snapshot.value?.cache?.longFileInfo?.uri || '') !== snapshot.uri
    || createHash('sha256').update(JSON.stringify(snapshot.value)).digest('hex') !== snapshot.hash
    || (previous.plan.cacheSemanticSnapshot && previous.plan.cacheSemanticSnapshot.hash !== snapshot.hash)
    || !normalization.verificationRunId || !normalization.priorEditorId || !normalization.reopenedId
    || normalization.routeChanged !== true || normalization.contentReadback !== true
    || !(Date.parse(normalization.observedAt) >= Date.parse(previous.savedAt))
    || !normalization.provenance?.kind) {
    throw new Error('Confirmed resume-slot normalization requires unchanged native semantic identity and complete reopen evidence');
  }
  if (previous.plan.cacheSemanticSnapshot) return previous;
  const audit = { ...normalization, snapshot: undefined };
  const value = { ...previous, plan: { ...previous.plan, cacheSemanticSnapshot: snapshot },
    normalizationAudit: [...(previous.normalizationAudit || []), audit].slice(-20) };
  return write(file, validate(value, identity));
}
