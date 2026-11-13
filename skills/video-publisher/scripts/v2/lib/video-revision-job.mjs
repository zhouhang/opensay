import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readPackage } from '../../lib/content-package.mjs';
import { buildIdentity } from './identity.mjs';
import { validPersistence } from './persistence.mjs';
import { readVideoReplacementAuthorization, readVideoReplacementSpaceBinding } from './video-replacement-authorization.mjs';
import { readDraftSaveJournal } from './draft-save-journal.mjs';
import { coverRevisionContext, coverRevisionDraftJournalPath, coverRevisionPlatformFingerprint,
  coverRevisionReceiptCheckpointPath } from './cover-revision-job.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`replace-video ${message}`); };
const onlyMedia = pkg => Object.fromEntries(Object.entries(pkg).filter(([key]) => key !== 'videoPath'));
const supported = ['bilibili', 'wechat_channels', 'xiaohongshu'];
const origins = { xiaohongshu: 'https://creator.xiaohongshu.com', bilibili: 'https://member.bilibili.com', wechat_channels: 'https://channels.weixin.qq.com' };

export function videoRevisionContext(state, platform) {
  const r = state.videoRevision;
  if (!r || !r.sources?.[platform]
    || r.nextFingerprint !== coverRevisionPlatformFingerprint(state, platform)) return null;
  const context = { previousFingerprint: r.previousFingerprint, nextFingerprint: r.nextFingerprint,
    ...r.sources[platform], nextVideoIdentity: r.video };
  const binding = context.spaceBindingPath ? readVideoReplacementSpaceBinding(context.spaceBindingPath, context) : null;
  if (binding?.status === 'confirmed') {
    context.originalSourceTaskSpaceId = context.sourceTaskSpaceId;
    context.sourceTaskSpaceId = binding.taskSpaceId;
    context.sourceTaskSpaceRecovery = binding;
  }
  return context;
}

export function videoRevisionReceiptCheckpointPath(store, state, platform) {
  const r = videoRevisionContext(state, platform);
  return r ? `${store.receiptCheckpointPath(platform)}.video-${r.nextFingerprint}.json`
    : coverRevisionReceiptCheckpointPath(store, state, platform);
}

export function videoRevisionDraftJournalPath(store, state, platform) {
  const r = videoRevisionContext(state, platform);
  return r ? `${store.receiptCheckpointPath(platform)}.video-${r.nextFingerprint}.draft-save.json` : '';
}

export function videoReplacementJournalPath(store, state, platform) {
  const r = videoRevisionContext(state, platform);
  return r ? `${store.receiptCheckpointPath(platform)}.video-${r.nextFingerprint}.replacement.json` : '';
}

export async function loadVideoRevisionReceiptCheckpoint(store, state, platform, taskSpaceId) {
  if (!videoRevisionContext(state, platform)) return null;
  const file = videoRevisionReceiptCheckpointPath(store, state, platform);
  if (!fs.existsSync(file)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(file));
    return [1, 2].includes(payload.schemaVersion) && payload.platform === platform
      && payload.fingerprint === coverRevisionPlatformFingerprint(state, platform)
      && Number(payload.taskSpaceId) === Number(taskSpaceId) && payload.receipts
      && typeof payload.receipts === 'object' && !Array.isArray(payload.receipts) ? payload : null;
  } catch { return null; }
}

function journalPath(store, state, platform) {
  if (videoRevisionContext(state, platform)) return videoRevisionDraftJournalPath(store, state, platform);
  if (coverRevisionContext(state, platform)) return coverRevisionDraftJournalPath(store, state, platform);
  const suffix = state.tagRevision?.nextFingerprint === coverRevisionPlatformFingerprint(state, platform)
    ? `.tags-${state.tagRevision.nextFingerprint}` : '';
  return `${store.receiptCheckpointPath(platform)}${suffix}.draft-save.json`;
}

function validSourceProof(proof, platform, fingerprint, journal) {
  if (proof?.version !== 2 || proof.platform !== platform || proof.fingerprint !== fingerprint
    || proof.method !== 'draft-list-reopen' || proof.documentChanged !== true
    || !proof.draftId || proof.draftId !== String(journal?.plan?.id || '')
    || proof.listEntryId !== proof.draftId || proof.reopenedId !== proof.draftId
    || proof.savedAt !== journal.savedAt || proof.listUrl !== journal.plan.listUrl) return false;
  for (const route of [proof.listUrl, proof.reopenedUrl]) {
    try { const u = new URL(route); if (u.origin !== origins[platform] || u.username || u.password) return false; }
    catch { return false; }
  }
  if (platform === 'xiaohongshu') return proof.storageScope === 'browser-local'
    && proof.uid === journal.plan.uid && proof.snapshotHash === journal.plan.snapshotHash
    && /^[a-f0-9]{64}$/.test(proof.snapshotHash || '') && Boolean(journal.plan.videoFileId);
  const keys = platform === 'bilibili' ? ['title', 'videoName', 'videoStem', 'beforeIds'] : ['description', 'beforeIds'];
  return keys.every(key => Object.hasOwn(journal.plan, key) && isDeepStrictEqual(proof.lookup?.[key], journal.plan[key]));
}

function independentSource(item, platform, fingerprint, journal) {
  const candidates = [...new Set([item.lastEvidencePath,
    ...(item.history || []).slice().reverse().map(entry => entry.evidencePath)].filter(Boolean))];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let o; try { o = JSON.parse(fs.readFileSync(file)).observation; } catch { continue; }
    if (o?.phase !== 'verify' || o.platform !== platform || o.fingerprint !== fingerprint
      || Number(o.taskSpaceId) !== Number(item.taskSpaceId) || o.finalPublishClicked !== false || o.blocker
      || o.gates?.video?.ok !== true || o.gates?.draftIdentity?.ok !== true
      || !validPersistence(o) || !validSourceProof(o.gates.persistedDraft.evidence, platform, fingerprint, journal)) continue;
    return { sourceEvidencePath: file, sourceEvidenceSha256: hash(fs.readFileSync(file)),
      sourcePersistedDraft: o.gates.persistedDraft.evidence };
  }
  fail(`lacks immutable independent verify evidence for the original native draft: ${platform}`);
}

function validateSource(source, state, platform) {
  const item = state.platforms[platform];
  const context = { ...source, nextVideoIdentity: state.videoRevision?.video || state.videoRevisionIntent?.video };
  const binding = source?.spaceBindingPath && context.nextVideoIdentity ? readVideoReplacementSpaceBinding(source.spaceBindingPath, context) : null;
  const expectedSpace = binding?.status === 'confirmed' ? binding.taskSpaceId : source.sourceTaskSpaceId;
  if (source?.userAuthorization && hash(fs.readFileSync(source.userAuthorization.manifestPath)) !== source.userAuthorization.manifestSha256) fail('human authorization manifest changed');
  if (!source?.sourceDraftId || ![expectedSpace, source.sourceTaskSpaceId].map(Number).includes(Number(item?.taskSpaceId))
    || item.taskSpaceName !== source.sourceTaskSpaceName || !source.sourceJournalPath || !source.sourceEvidencePath
    || hash(fs.readFileSync(source.sourceJournalPath)) !== source.sourceJournalSha256
    || hash(fs.readFileSync(source.sourceEvidencePath)) !== source.sourceEvidenceSha256) fail('original task space, journal or immutable verify artifact changed');
  const journal = readDraftSaveJournal(source.sourceJournalPath, { platform, fingerprint: source.sourceFingerprint });
  if (journal?.status !== 'confirmed' || !validSourceProof(source.sourcePersistedDraft, platform, source.sourceFingerprint, journal)) fail('original confirmed native resource binding changed');
}

function assertTargets(args) {
  if (!args.platforms?.length || args.platforms.some(p => !supported.includes(p))) {
    const error = new Error('ORIGINAL_VIDEO_REPLACEMENT_UNSUPPORTED: this platform has no independently proven original draft replacement; no new upload, draft or private video is authorized by this operation');
    error.code = 'ORIGINAL_VIDEO_REPLACEMENT_UNSUPPORTED'; throw error;
  }
  if (args.forceFreshSpace || args.spaceName || args.spaceSuffix || args.inspectOnly) fail('requires original draft spaces and cannot recreate them');
}

export async function prepareVideoRevisionJob({ store, state, pkg, identity, args }) {
  assertTargets(args);
  const committed = state.videoRevision?.nextFingerprint === identity.fingerprint ? state.videoRevision : null;
  const replay = state.videoRevisionIntent || (committed && args.platforms.every(p => committed.sources[p]) ? committed : null);
  if (replay) {
    if (replay.nextFingerprint !== identity.fingerprint || replay.nextPackagePath !== args.packagePath
      || !args.platforms.every(p => replay.sources[p]) || !isDeepStrictEqual(replay.video, identity.video)) fail('conflicts with the durable original-video revision');
    for (const p of args.platforms) validateSource(replay.sources[p], state, p);
    if (state.videoRevision === replay) {
      for (const p of args.platforms) {
        const context = videoRevisionContext(state, p);
        if (context?.sourceTaskSpaceRecovery?.status === 'confirmed' && state.platforms[p].taskSpaceId !== context.sourceTaskSpaceId) {
          state.platforms[p].taskSpaceId = context.sourceTaskSpaceId; await store.save();
        }
      }
      return replay;
    }
  }
  if (state.coverRevisionIntent || state.tagRevisionIntent) fail('another original-draft revision is unfinished');
  const previousPackagePath = replay?.previousPackagePath || state.platformPackagePaths?.[args.platforms[0]] || state.packagePath;
  const previousPkg = readPackage(previousPackagePath);
  const previous = await buildIdentity(previousPkg);
  if (!committed && (previous.fingerprint !== state.fingerprint || previous.video.sha256 !== state.video?.sha256)) fail('original approved package or file changed');
  if (!isDeepStrictEqual(onlyMedia(previousPkg), onlyMedia(pkg)) || previous.coverFingerprint !== identity.coverFingerprint) fail('may change only videoPath and video bytes; all titles, prose, tags, settings and cover files must remain exact');
  if (previous.video.sha256 === identity.video.sha256) fail('requires different source video bytes');
  let revision = replay;
  if (!revision) {
    const sources = { ...(committed?.sources || {}) };
    for (const platform of args.platforms) {
      const item = state.platforms[platform];
      if (!item || !Number.isSafeInteger(item.taskSpaceId) || item.taskSpaceId <= 0 || !item.taskSpaceName
        || item.verdict?.blocker?.code === 'ALREADY_PUBLISHED') fail(`original native resource is missing or published: ${platform}`);
      const sourceFingerprint = coverRevisionPlatformFingerprint(state, platform);
      const sourceJournalPath = journalPath(store, state, platform);
      const journal = readDraftSaveJournal(sourceJournalPath, { platform, fingerprint: sourceFingerprint });
      if (journal?.status !== 'confirmed') fail(`requires original confirmed save journal: ${platform}`);
      let userAuthorization = null;
      if (platform === 'xiaohongshu') {
        userAuthorization = readVideoReplacementAuthorization(process.env.VIDEO_PUBLISHER_VIDEO_REPLACEMENT_AUTHORIZATION_PATH, {
          jobId: state.jobId, sourceFingerprint, sourceTaskSpaceId: item.taskSpaceId, sourceTaskSpaceName: item.taskSpaceName,
          uid: journal.plan.uid, sourceDraftId: String(journal.plan.id), sourceVideoFileId: journal.plan.videoFileId,
          nextVideoSha256: identity.video.sha256 });
      }
      sources[platform] = { sourceFingerprint, sourceDraftId: String(journal.plan.id),
        sourceTaskSpaceId: item.taskSpaceId, sourceTaskSpaceName: item.taskSpaceName,
        sourceVideoIdentity: previous.video,
        ...(platform === 'xiaohongshu' ? { sourceUid: journal.plan.uid, sourceVideoFileId: journal.plan.videoFileId, userAuthorization,
          spaceBindingPath: `${store.receiptCheckpointPath(platform)}.video-${identity.fingerprint}.space-binding.json` } : {}), sourceVideoReceipt: structuredClone(item.videoReceipt || null),
        sourceReceipts: structuredClone(item.receipts || {}), sourceJournalPath,
        sourceJournalSha256: hash(fs.readFileSync(sourceJournalPath)),
        ...independentSource(item, platform, sourceFingerprint, journal) };
    }
    revision = { at: new Date().toISOString(), previousFingerprint: committed?.previousFingerprint || state.fingerprint,
      nextFingerprint: identity.fingerprint, previousPackagePath, nextPackagePath: args.packagePath,
      platforms: [...new Set([...(committed?.platforms || []), ...args.platforms])], video: identity.video, sources,
      previousPlatformFingerprints: Object.fromEntries(Object.keys(state.platforms).map(p => [p, coverRevisionPlatformFingerprint(state, p)])),
      previousPlatformPackagePaths: Object.fromEntries(Object.keys(state.platforms).map(p => [p, state.platformPackagePaths?.[p] || state.packagePath])) };
    state.videoRevisionIntent = revision;
    for (const p of args.platforms) validateSource(sources[p], state, p);
    await store.save(); // Commit immutable source authority before changing package identity.
  }
  state.schemaVersion = 4;
  for (const key of ['fingerprint', 'contentFingerprint', 'coverFingerprint', 'coverFingerprints', 'cover', 'video', 'assets']) state[key] = identity[key];
  state.packagePath = args.packagePath;
  state.platformFingerprints = { ...revision.previousPlatformFingerprints,
    ...Object.fromEntries(args.platforms.map(p => [p, identity.fingerprint])) };
  state.platformPackagePaths = { ...revision.previousPlatformPackagePaths,
    ...Object.fromEntries(args.platforms.map(p => [p, args.packagePath])) };
  state.videoRevision = revision; delete state.videoRevisionIntent;
  state.revisions ||= [];
  state.revisions.push({ at: revision.at, operation: 'replace-video', from: revision.previousFingerprint,
    to: revision.nextFingerprint, packagePath: args.packagePath, platforms: [...args.platforms] });
  for (const p of args.platforms) {
    const item = state.platforms[p];
    item.videoReceipt = null; // Old upload receipts never become evidence for new media.
    item.receipts = { ...(item.receipts || {}) };
    delete item.receipts.uploadStart; delete item.receipts.videoReplacement;
    item.verdict = null; item.status = 'needs_video_replacement';
  }
  state.status = 'blocked'; await store.save(); return revision;
}
