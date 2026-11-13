import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluateObservation } from './model.mjs';
import { xhsParkedVideoReplacementGate } from './xiaohongshu-parked-video-replacement.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const xhsCoverKey = value => typeof value === 'string'
  ? value.match(/(?:^|\/)spectrum\/([^?"')\\]+)/)?.[1] || '' : '';
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// Before thumbnail decoding became a parking requirement, parked artifacts
// recorded only the row's thumbnail URL. Such an artifact may identify the
// original task space for a protective retry, but it is never current READY
// evidence. The runtime must still read the native record and a freshly loaded,
// decoded image before it can mint a new parked proof.
function legacyThumbnailLocatorOnly(observation, { fingerprint, taskSpaceId }) {
  const proof = observation?.gates?.persistedDraft?.evidence;
  const row = observation?.evidence?.currentListRows?.[0];
  const native = observation?.evidence?.currentNativeRecord;
  const nativeCover = observation?.evidence?.currentNativeCover;
  if (observation?.platform !== 'xiaohongshu' || observation.phase !== 'park'
    || observation.surface !== 'xhs-draft-list-parked' || observation.blocker
    || observation.fingerprint !== fingerprint || Number(observation.taskSpaceId) !== Number(taskSpaceId)
    || proof?.method !== 'xhs-draft-list-parked' || proof.platform !== 'xiaohongshu'
    || proof.fingerprint !== fingerprint || Number(proof.taskSpaceId) !== Number(taskSpaceId)
    || ![proof.draftId, proof.uid, proof.videoFileId, proof.snapshotHash, proof.coverFileId].every(nonempty)
    || !/^[a-f0-9]{64}$/.test(proof.snapshotHash)
    || !Number.isFinite(proof.coverWidth) || proof.coverWidth <= 0
    || !Number.isFinite(proof.coverHeight) || proof.coverHeight <= 0
    || native?.id !== proof.draftId || native.uid !== proof.uid
    || native.snapshot?.videoFileId !== proof.videoFileId || native.snapshot?.coverFileId !== proof.coverFileId
    || digest(native.snapshot) !== proof.snapshotHash
    || nativeCover?.fileid !== proof.coverFileId || nativeCover.width !== proof.coverWidth
    || nativeCover.height !== proof.coverHeight
    || !Array.isArray(observation.evidence?.currentListRows) || observation.evidence.currentListRows.length !== 1
    || row?.id !== proof.draftId || row.title !== proof.visibleRowTitle || row.visible === false
    || Array.isArray(row.thumbnailImages)
    || !Array.isArray(row.thumbnailUrls)
    || !row.thumbnailUrls.some(url => xhsCoverKey(url) === xhsCoverKey(proof.coverFileId))
    || new Set(row.thumbnailUrls.map(xhsCoverKey).filter(Boolean)).size !== 1) return false;
  const recorded = evaluateObservation(observation);
  if (recorded.ready || recorded.missing.length !== 1 || recorded.missing[0] !== 'persistedDraft'
    || recorded.blocker?.code !== 'PERSISTENCE_UNVERIFIED') return false;
  const probe = structuredClone(observation);
  const probeRow = probe.evidence.currentListRows[0];
  probeRow.visible = true;
  probeRow.thumbnailImages = [{ src: row.thumbnailUrls.find(url => xhsCoverKey(url) === xhsCoverKey(proof.coverFileId)),
    complete: true, naturalWidth: proof.coverWidth, naturalHeight: proof.coverHeight, visible: true, decoded: true }];
  return evaluateObservation(probe).ready === true;
}

// Only a real recorded independent verify may authorize parking. This loader
// deliberately rejects a compact READY flag or a persist action receipt.
export function loadXhsParkingContext({ evidencePath, fingerprint, taskSpaceId, verificationRunId, historical = false }) {
  const artifact = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  let observation = artifact.observation;
  let priorParking = null;
  if (observation?.surface === 'xhs-draft-list-parked') {
    const recorded = evaluateObservation(observation);
    const derivedReplacement = xhsParkedVideoReplacementGate(observation);
    const missingReplacementOnly = !observation.blocker || observation.blocker.code === 'STATE_AMBIGUOUS'
      && observation.blocker.message === 'New video upload lacks its durable original-draft injection evidence and fresh native-file readback';
    const independentlyReconciled = recorded.missing.length === 1 && recorded.missing[0] === 'replaceVideo'
      && missingReplacementOnly && derivedReplacement.ok && evaluateObservation({ ...observation, blocker: null,
        gates: { ...observation.gates, replaceVideo: derivedReplacement } }).ready;
    const legacyLocator = historical && legacyThumbnailLocatorOnly(observation, { fingerprint, taskSpaceId });
    if (!historical || !recorded.ready && !independentlyReconciled && !legacyLocator) throw new Error('Previous parked artifact is incomplete');
    priorParking = { proof: observation.gates.persistedDraft.evidence, evidencePath,
      observationHash: digest(observation), ...(legacyLocator ? { legacyThumbnailLocatorOnly: true } : {}) };
    const prior = observation.gates?.persistedDraft?.evidence?.editorVerification;
    if (!prior?.evidencePath || digest(prior.observation) !== prior.observationHash) throw new Error('Parked source lost its original editor artifact');
    const original = JSON.parse(fs.readFileSync(prior.evidencePath, 'utf8'));
    if (digest(original.observation) !== prior.observationHash) throw new Error('Original editor verification artifact changed');
    observation = original.observation;
    evidencePath = prior.evidencePath;
  }
  if (observation?.platform !== 'xiaohongshu' || observation.phase !== 'verify'
    || observation.fingerprint !== fingerprint || Number(observation.taskSpaceId) !== Number(taskSpaceId)
    || (!historical && observation.verificationRunId !== verificationRunId)
    || !evaluateObservation(observation).ready) throw new Error('Parking source must be the unchanged independent editor verify artifact');
  return { observation, observationHash: digest(observation), evidencePath,
    historical, parkOnly: historical, priorParking };
}

export function recoverXhsParkingContext({ item, fingerprint, taskSpaceId }) {
  if (!item || !taskSpaceId) throw new Error('Protective parking requires the original recorded task space');
  const saved = item.parkingSource;
  // A durable binding may never be discarded in favour of a different artifact.
  if (saved && (saved.fingerprint !== fingerprint || Number(saved.taskSpaceId) !== Number(taskSpaceId)
    || !saved.evidencePath || !saved.observationHash)) throw new Error('Durable parking source identity changed');
  if (saved) {
    const source = loadXhsParkingContext({ evidencePath: saved.evidencePath, fingerprint, taskSpaceId, historical: true });
    if (source.observationHash !== saved.observationHash) throw new Error('Durable parking source artifact changed');
  }
  const candidates = [...new Set([item.lastEvidencePath,
    ...(item.history || []).slice().reverse().filter(entry => ['park', 'verify'].includes(entry.phase)).map(entry => entry.evidencePath),
    saved?.evidencePath].filter(Boolean))];
  for (const evidencePath of candidates) {
    try {
      const context = loadXhsParkingContext({ evidencePath, fingerprint, taskSpaceId, historical: true });
      if (saved && context.observationHash !== saved.observationHash) continue;
      return context;
    } catch { /* Failed parking evidence is history, never a new source. */ }
  }
  throw new Error('No unchanged independent editor verification artifact can authorize protective parking');
}

export function rememberXhsParkingSource(item, context, fingerprint, taskSpaceId) {
  const source = { version: 1, fingerprint, taskSpaceId, evidencePath: context.evidencePath,
    observationHash: context.observationHash };
  if (item.parkingSource && JSON.stringify(item.parkingSource) !== JSON.stringify(source)) {
    // A fresh independent verify in a new normal run may supersede the source,
    // but protective retries must preserve the immutable previous binding.
    if (context.historical) throw new Error('Protective parking cannot replace its durable source');
  }
  item.parkingSource = source;
  item.parkingSourceEvidencePath = source.evidencePath;
  return source;
}
