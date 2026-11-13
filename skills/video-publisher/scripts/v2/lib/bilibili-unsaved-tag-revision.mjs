import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const fail = message => { throw new Error(`update-tags unfinished Bilibili ${message}`); };
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const oneId = value => Array.isArray(value) && value.length === 1 && /^filename:.+/.test(value[0]);

export function validUnsavedBilibiliNative(native) {
  return Boolean(native && native.existingDraft === false && !native.draftId && native.published === false
    && native.partCount === 1 && native.uploadComplete === true && oneId(native.nativeFileIds)
    && /^[1-9][0-9]*$/.test(String(native.cid || '')));
}

function readObservation(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).observation; }
  catch { fail('requires readable original upload evidence'); }
}

function sameSource(observation, item, fingerprint) {
  return observation?.platform === 'bilibili' && observation.fingerprint === fingerprint
    && Number(observation.taskSpaceId) === Number(item.taskSpaceId)
    && observation.taskSpace === item.taskSpaceName && observation.taskSpaceRecovery?.recreated !== true
    && observation.gates?.draftIdentity?.ok === true && observation.gates?.video?.ok === true;
}

export function readUnsavedBilibiliTagContext(context, { fingerprint, platform, localMediaMetadata } = {}) {
  if (!context) return null;
  if (platform !== 'bilibili' || context.kind !== 'bilibili-unsaved-tag-correction-v1'
    || context.nextFingerprint !== fingerprint || !context.previousFingerprint
    || context.previousFingerprint === fingerprint || !Number.isInteger(context.sourceTaskSpaceId)
    || !context.sourceTaskSpaceName || !validUnsavedBilibiliNative(context.sourceNativeUpload)
    || context.userConfirmedTagChange !== true || !context.sourceVideoIdentity?.sha256) fail('context binding is invalid');
  for (const evidence of [context.sourceUploadEvidence, context.sourceEditorEvidence]) {
    if (!evidence?.path || !path.isAbsolute(evidence.path) || sha(evidence.path) !== evidence.sha256) fail('source evidence changed');
    const observation = readObservation(evidence.path);
    if (!sameSource(observation, { taskSpaceId: context.sourceTaskSpaceId, taskSpaceName: context.sourceTaskSpaceName }, context.previousFingerprint)) fail('source evidence identity changed');
  }
  const sourceEditor = readObservation(context.sourceEditorEvidence.path);
  if (JSON.stringify(sourceEditor.evidence?.nativeUploadIdentity) !== JSON.stringify(context.sourceNativeUpload)) fail('source native upload binding changed');
  if (!localMediaMetadata || localMediaMetadata.sha256 !== context.sourceVideoIdentity.sha256
    || localMediaMetadata.size !== context.sourceVideoIdentity.size
    || localMediaMetadata.path !== context.sourceVideoIdentity.path) fail('approved video file changed');
  return context;
}

/** A first save has no native draft ID yet. Bind the already completed upload instead. */
export async function prepareUnsavedBilibiliTagRevision({ store, state, identity, args, affectedPlatforms }) {
  if (args.confirmTagChange !== true || args.platforms.length !== 1 || args.platforms[0] !== 'bilibili'
    || affectedPlatforms.length !== 1 || affectedPlatforms[0] !== 'bilibili') fail('requires an explicitly confirmed Bilibili-only tag correction');
  const pending = state.tagRevisionIntent;
  if (state.coverRevisionIntent || state.videoRevisionIntent) fail('cannot replace an unfinished resource revision');
  if (pending && (pending.nextFingerprint !== identity.fingerprint || pending.nextPackagePath !== args.packagePath
    || pending.platforms?.length !== 1 || pending.platforms[0] !== 'bilibili'
    || pending.sources?.bilibili?.kind !== 'bilibili-unsaved-tag-correction-v1')) fail('cannot replace an unfinished tag revision');
  const item = state.platforms.bilibili;
  if (!item || !Number.isInteger(item.taskSpaceId) || !item.taskSpaceName || item.status === 'ready') fail('requires the original unfinished browser space');
  if (fs.readdirSync(store.checkpointDir).some(name => name.startsWith('bilibili.') && name.includes('draft-save'))) fail('cannot revise an editor with an existing save attempt');
  const sourceFingerprint = state.platformFingerprints?.bilibili || state.fingerprint;
  let revision = pending;
  if (!revision) {
    const freshFile = item.lastEvidencePath;
    const fresh = readObservation(freshFile);
    if (!sameSource(fresh, item, sourceFingerprint) || fresh.phase !== 'inspect'
      || Date.now() - Date.parse(fresh.observedAt) > 10 * 60 * 1000
      || !Number.isFinite(Date.parse(fresh.observedAt))
      || !validUnsavedBilibiliNative(fresh.evidence?.nativeUploadIdentity)) fail('needs a fresh original-package completed-upload inspection with native CID and filename');
    const historyFiles = [...new Set((item.history || []).map(entry => entry.evidencePath).filter(file => file && file !== freshFile))].reverse();
    const sourceFile = historyFiles.find(file => {
      const observation = readObservation(file);
      return sameSource(observation, item, sourceFingerprint)
        && ['upload', 'mutate', 'inspect'].includes(observation.phase)
        && observation.gates.video.evidence?.filename === path.basename(state.video.path)
        && observation.gates.video.evidence?.stable === true;
    });
    if (!sourceFile) fail('cannot bind the earlier completed original upload');
    const source = { kind: 'bilibili-unsaved-tag-correction-v1', userConfirmedTagChange: true,
      sourceFingerprint, sourceTaskSpaceId: item.taskSpaceId, sourceTaskSpaceName: item.taskSpaceName,
      sourceNativeUpload: fresh.evidence.nativeUploadIdentity, sourceVideoIdentity: structuredClone(state.video),
      sourceUploadEvidence: { path: sourceFile, sha256: sha(sourceFile) },
      sourceEditorEvidence: { path: freshFile, sha256: sha(freshFile) } };
    const previousPlatformFingerprints = Object.fromEntries(Object.keys(state.platforms).map(platform => [platform, state.platformFingerprints?.[platform] || state.fingerprint]));
    const previousPlatformPackagePaths = Object.fromEntries(Object.keys(state.platforms).map(platform => [platform, state.platformPackagePaths?.[platform] || state.packagePath]));
    revision = { at: new Date().toISOString(), previousFingerprint: sourceFingerprint, nextFingerprint: identity.fingerprint,
      previousPackagePath: state.packagePath, nextPackagePath: args.packagePath, platforms: ['bilibili'],
      affectedPlatforms: ['bilibili'], sources: { bilibili: source }, previousPlatformFingerprints, previousPlatformPackagePaths };
    state.tagRevisionIntent = revision;
    await store.save();
  }
  const source = revision.sources.bilibili;
  if (source.sourceTaskSpaceId !== item.taskSpaceId || source.sourceTaskSpaceName !== item.taskSpaceName) fail('original browser space changed during revision');
  readUnsavedBilibiliTagContext({ previousFingerprint: sourceFingerprint, nextFingerprint: identity.fingerprint, ...source },
    { fingerprint: identity.fingerprint, platform: 'bilibili', localMediaMetadata: state.video });
  state.fingerprint = identity.fingerprint;
  state.contentFingerprint = identity.contentFingerprint;
  state.packagePath = args.packagePath;
  state.platformFingerprints = { ...revision.previousPlatformFingerprints, bilibili: identity.fingerprint };
  state.platformPackagePaths = { ...revision.previousPlatformPackagePaths, bilibili: args.packagePath };
  state.tagRevision = revision;
  delete state.tagRevisionIntent;
  state.revisions ||= [];
  state.revisions.push({ at: revision.at, operation: 'update-tags', from: revision.previousFingerprint,
    to: revision.nextFingerprint, packagePath: args.packagePath, platforms: ['bilibili'], kind: source.kind });
  item.verdict = null;
  item.status = 'needs_mutation';
  // Keep sibling fingerprints, checkpoints, verdicts and browser spaces intact.
  state.status = 'blocked';
  await store.save();
  return revision;
}
