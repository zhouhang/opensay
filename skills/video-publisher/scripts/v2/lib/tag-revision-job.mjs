import fs from 'node:fs';
import { readPackage } from '../../lib/content-package.mjs';
import { buildIdentity } from './identity.mjs';
import { validateTagRevision } from './tag-revision.mjs';
import { validPersistence } from './persistence.mjs';
import { prepareYoutubeTagRevision } from '../platforms/youtube-api.mjs';
import { prepareUnsavedBilibiliTagRevision } from './bilibili-unsaved-tag-revision.mjs';

function sourceProof(item, platform, fingerprint) {
  const files = [...new Set([item.lastEvidencePath, ...(item.history || []).slice().reverse().map(entry => entry.evidencePath)].filter(Boolean))];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const observation = JSON.parse(fs.readFileSync(file, 'utf8')).observation;
    const gate = observation?.gates?.persistedDraft;
    const proof = gate?.evidence;
    if (observation?.platform === platform && validPersistence(observation) && proof.fingerprint === fingerprint
      && (platform === 'youtube' || Number(observation.taskSpaceId) === Number(item.taskSpaceId))) return proof;
  }
  return null;
}

function sourceEditorId(item, platform, fingerprint) {
  const file = item.lastEvidencePath;
  if (!file || !fs.existsSync(file)) return null;
  const observation = JSON.parse(fs.readFileSync(file, 'utf8')).observation;
  if (observation?.platform !== platform || observation?.fingerprint !== fingerprint
    || Number(observation.taskSpaceId) !== Number(item.taskSpaceId)
    || !observation.gates?.video?.ok || !observation.gates?.draftIdentity?.ok) return null;
  return observation.gates.draftIdentity.evidence?.restoredIdentity?.actualId || null;
}

// A durable intent precedes checkpoint migration. A crash between the two writes
// can replay the exact migration, never a fresh upload or a new native draft.
export async function prepareTagRevisionJob({ store, state, pkg, identity, args }, dependencies = {}) {
  const prepareYoutube = dependencies.prepareYoutube || prepareYoutubeTagRevision;
  const priorPkg = readPackage(state.packagePath);
  const priorIdentity = await buildIdentity(priorPkg);
  if (priorIdentity.fingerprint !== state.fingerprint) throw new Error('update-tags original package was changed or its asset identity cannot be proved');
  const { affectedPlatforms } = validateTagRevision({
    previousPackage: priorPkg, nextPackage: pkg, previousIdentity: state,
    nextIdentity: identity, platforms: args.platforms, existingPlatforms: state.platforms,
  });
  if (state.fingerprint === identity.fingerprint) {
    if (state.tagRevision?.nextFingerprint !== identity.fingerprint) throw new Error('update-tags found no approved tag revision to resume');
    return state.tagRevision;
  }
  if (!affectedPlatforms.length) throw new Error('update-tags found no effective tag change');
  if (args.platforms.length === 1 && args.platforms[0] === 'bilibili'
    && args.confirmTagChange === true && state.platforms.bilibili?.status !== 'ready'
    && !sourceProof(state.platforms.bilibili, 'bilibili', state.platformFingerprints?.bilibili || state.fingerprint)) {
    return await prepareUnsavedBilibiliTagRevision({ store, state, identity, args, affectedPlatforms });
  }
  // Every existing delivery needs a new identity-bound readback, including a
  // platform whose effective tags happen not to change through shared fallback.
  const omitted = Object.keys(state.platforms).filter(platform => !args.platforms.includes(platform));
  if (omitted.length) throw new Error(`update-tags must verify every existing delivery: ${omitted.join(', ')}`);
  for (const platform of args.platforms) {
    if (platform !== 'youtube' && !state.platforms[platform]?.taskSpaceId) throw new Error(`update-tags has no original browser space: ${platform}`);
  }
  const intent = state.tagRevisionIntent;
  if (intent && (intent.previousFingerprint !== state.fingerprint || intent.nextFingerprint !== identity.fingerprint
    || intent.nextPackagePath !== args.packagePath)) throw new Error('update-tags conflicts with an unfinished revision intent');
  const sources = intent?.sources || Object.fromEntries(args.platforms.map(platform => {
    const item = state.platforms[platform];
    const proof = sourceProof(item, platform, state.fingerprint);
    if (['bilibili', 'wechat_channels', 'youtube'].includes(platform) && !proof) throw new Error(`update-tags cannot prove the original saved resource: ${platform}`);
    const nativeId = platform === 'douyin'
      ? sourceEditorId(item, platform, state.fingerprint) || proof?.reopenedId
      : proof?.draftId || sourceEditorId(item, platform, state.fingerprint);
    if (['douyin', 'xiaohongshu'].includes(platform) && !nativeId) throw new Error(`update-tags needs a current original-package native editor inspection: ${platform}`);
    return [platform, { sourcePersistedDraft: proof, sourceDraftId: nativeId, taskSpaceId: item.taskSpaceId ?? null }];
  }));
  const revision = intent || {
    at: new Date().toISOString(), previousFingerprint: state.fingerprint, nextFingerprint: identity.fingerprint,
    previousPackagePath: state.packagePath, nextPackagePath: args.packagePath,
    platforms: args.platforms, affectedPlatforms, sources,
  };
  state.tagRevisionIntent = revision;
  await store.save();
  if (args.platforms.includes('youtube')) {
    await prepareYoutube({ previousPkg: priorPkg, nextPkg: pkg,
      previousFingerprint: revision.previousFingerprint, nextFingerprint: identity.fingerprint,
      expectedVideoId: revision.sources.youtube.sourceDraftId,
      checkpointPath: store.receiptCheckpointPath('youtube') });
  }
  state.fingerprint = identity.fingerprint;
  state.contentFingerprint = identity.contentFingerprint;
  state.packagePath = args.packagePath;
  state.tagRevision = revision;
  delete state.tagRevisionIntent;
  state.revisions ||= [];
  state.revisions.push({ at: revision.at, operation: 'update-tags', from: revision.previousFingerprint,
    to: revision.nextFingerprint, packagePath: args.packagePath, platforms: args.platforms });
  state.status = 'blocked';
  for (const [platform, item] of Object.entries(state.platforms)) {
    if (item.videoReceipt) item.videoReceipt = { ...item.videoReceipt, fingerprint: identity.fingerprint };
    item.receipts ||= {};
    if (item.receipts.uploadStart?.fingerprint) item.receipts.uploadStart = { ...item.receipts.uploadStart, fingerprint: identity.fingerprint };
    if (item.receipts.youtubeApi?.fingerprint) item.receipts.youtubeApi = { ...item.receipts.youtubeApi, fingerprint: identity.fingerprint };
    item.verdict = null;
    item.status = 'needs_mutation';
    await store.clearReceiptCheckpoint(platform);
  }
  await store.save();
  return revision;
}

export function tagRevisionContext(state, platform) {
  const revision = state.tagRevision;
  if (!revision || revision.nextFingerprint !== state.fingerprint || !revision.sources?.[platform]) return null;
  return { previousFingerprint: revision.previousFingerprint, nextFingerprint: revision.nextFingerprint,
    ...revision.sources[platform] };
}
