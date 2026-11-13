import fs from 'node:fs';
import { validPersistence } from './persistence.mjs';

const BUSINESS_GATES = ['authenticated', 'draftIdentity', 'video', 'title', 'description', 'tags',
  'settings', 'cover', 'noBlockingDialog', 'finalButton', 'safety'];
const safeObservation = observation => observation?.finalPublishClicked === false
  && observation.gates?.safety?.ok === true
  && observation.gates.safety.evidence?.finalPublishClicked === false
  && observation.gates.safety.evidence?.guardArmed === true
  && observation.gates.safety.evidence?.blockedAttempts === 0;
const fullEditor = observation => BUSINESS_GATES.every(key => observation.gates?.[key]?.ok === true)
  && safeObservation(observation);
const observedTime = observation => Date.parse(observation?.observedAt);

// Historical evidence only grants a narrowly scoped cache-recovery inspection.
// It is never a current persistence proof or a READY verdict.
export function douyinResumeRecoverySource(state) {
  const item = state?.platforms?.douyin;
  if (!state?.tagRevision || !state.fingerprint || !state.tagRevision.previousFingerprint
    || state.tagRevision.previousFingerprint === state.fingerprint
    || state.tagRevision.nextFingerprint !== state.fingerprint || !item?.taskSpaceId
    || !Array.isArray(item.history || [])) return null;
  const files = [...new Set([...(item.history || []).map(entry => entry?.evidencePath), item.lastEvidencePath].filter(Boolean))];
  const entries = files.map(file => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).observation; } catch { return null; }
  });
  const bound = observation => observation?.platform === 'douyin' && observation.fingerprint === state.fingerprint
    && Number(observation.taskSpaceId) === Number(item.taskSpaceId) && !observation.taskSpaceRecovery?.recreated
    && Number.isFinite(observedTime(observation)) && safeObservation(observation);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const failure = entries[index];
    const cache = failure?.blocker?.evidence;
    if (!bound(failure) || failure.phase !== 'persist' || failure.blocker?.code !== 'PERSISTENCE_UNVERIFIED'
      || cache?.available !== true || cache.continueCount !== 1
      || !Array.isArray(cache.cacheEntries)
      || cache.cacheEntries.some(entry => !entry || typeof entry.active !== 'boolean')
      || cache.cacheEntries.filter(entry => entry.active).length !== 1) continue;
    const activeCache = cache.cacheEntries.find(entry => entry.active);
    if (typeof activeCache.key !== 'string' || !activeCache.key
      || typeof activeCache.digest !== 'string' || !activeCache.digest) continue;
    if (entries.slice(index + 1).some(entry => !bound(entry)
      || !['inspect', 'persist', 'verify'].includes(entry.phase))) return null;
    const inspectionIndex = entries.findLastIndex((entry, entryIndex) => entryIndex < index && bound(entry)
      && entry.phase === 'inspect' && entry.verificationRunId === failure.verificationRunId);
    const inspection = entries[inspectionIndex];
    const restored = inspection?.gates?.draftIdentity?.evidence?.restoredIdentity;
    if (!inspection || inspection.blocker || !fullEditor(inspection) || !inspection.verificationRunId
      || restored?.ok !== true || restored.existingDraft !== true || restored.consumedSlot !== true || !restored.actualId
      || observedTime(inspection) > observedTime(failure)
      || entries.slice(inspectionIndex + 1, index).some(entry => !bound(entry) || entry.phase !== 'inspect'
        || entry.verificationRunId !== failure.verificationRunId
        || observedTime(entry) < observedTime(inspection) || observedTime(entry) > observedTime(failure))) continue;
    const proofIndex = entries.findLastIndex((entry, entryIndex) => entryIndex < inspectionIndex && bound(entry) && !entry.blocker
      && fullEditor(entry) && validPersistence(entry)
      && entry.gates.persistedDraft.evidence.reopenedId === restored.actualId
      && observedTime(entry) <= observedTime(inspection));
    const proof = entries[proofIndex];
    if (!proof) continue;
    if (entries.slice(proofIndex + 1, inspectionIndex).some(entry => !bound(entry)
      || !['inspect', 'persist', 'verify'].includes(entry.phase)
      || observedTime(entry) < observedTime(proof) || observedTime(entry) > observedTime(inspection))) return null;
    const persistence = proof.gates.persistedDraft.evidence;
    if (activeCache.key !== persistence.cacheKey || !persistence.cacheDigest
      || activeCache.digest === persistence.cacheDigest) continue;
    return { inspection, failure, proof };
  }
  return null;
}
