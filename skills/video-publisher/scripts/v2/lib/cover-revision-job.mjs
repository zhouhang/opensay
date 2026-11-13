import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readPackage } from '../../lib/content-package.mjs';
import { buildIdentity } from './identity.mjs';
import { validPersistence } from './persistence.mjs';
import { readDraftSaveJournal } from './draft-save-journal.mjs';

const PLATFORM = 'xiaohongshu';
const BROWSER_PLATFORMS = ['xiaohongshu', 'bilibili', 'wechat_channels'];
const ORIGINS = { xiaohongshu: 'https://creator.xiaohongshu.com', bilibili: 'https://member.bilibili.com', wechat_channels: 'https://channels.weixin.qq.com' };
const digestBytes = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(`replace-cover ${message}`); };
const sameVideo = (left, right) => left?.sha256 === right?.sha256 && left?.size === right?.size;
const sameTargets = (left, right) => isDeepStrictEqual([...left].sort(), [...right].sort());

export function isXhsNativeCoverRevision(pkg, state, args) {
  return Boolean(Object.hasOwn(pkg.cover?.platforms?.xiaohongshu || {}, 'nativeRatio')
    && args.platforms.includes(PLATFORM) || state.coverRevisionIntent
    || state.coverRevision?.nextFingerprint === state.fingerprint && args.platforms.includes(PLATFORM));
}

export function isBrowserCoverRevision(_pkg, state, args) {
  return Boolean(state.coverRevisionIntent || state.coverRevision?.nextFingerprint === state.fingerprint
    || args.platforms.length && args.platforms.every(platform => BROWSER_PLATFORMS.includes(platform)));
}

export function coverRevisionPlatformFingerprint(state, platform) {
  return state.platformFingerprints?.[platform] || state.fingerprint;
}

export function coverRevisionContext(state, platform) {
  const revision = state.coverRevision;
  if (!revision || revision.nextFingerprint !== state.fingerprint || !revision.sources?.[platform]) return null;
  return { previousFingerprint: revision.previousFingerprint, nextFingerprint: revision.nextFingerprint,
    ...revision.sources[platform] };
}

export function coverRevisionReceiptCheckpointPath(store, state, platform) {
  return coverRevisionContext(state, platform)
    ? `${store.receiptCheckpointPath(platform)}.covers-${state.fingerprint}.json`
    : store.receiptCheckpointPath(platform);
}

export function coverRevisionDraftJournalPath(store, state, platform) {
  return coverRevisionContext(state, platform)
    ? `${store.receiptCheckpointPath(platform)}.covers-${state.fingerprint}.draft-save.json`
    : '';
}

export async function loadCoverRevisionReceiptCheckpoint(store, state, platform, taskSpaceId = null) {
  const fingerprint = coverRevisionPlatformFingerprint(state, platform);
  if (!coverRevisionContext(state, platform)) return store.loadReceiptCheckpoint(platform, fingerprint, taskSpaceId);
  const file = coverRevisionReceiptCheckpointPath(store, state, platform);
  if (!fs.existsSync(file)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    return [1, 2].includes(payload.schemaVersion) && payload.platform === platform && payload.fingerprint === fingerprint
      && payload.receipts && typeof payload.receipts === 'object' && !Array.isArray(payload.receipts)
      && (payload.taskSpaceId == null || taskSpaceId == null || Number(payload.taskSpaceId) === Number(taskSpaceId))
      ? payload : null;
  } catch { return null; }
}

function originalJournalPath(store, state, platform) {
  if (coverRevisionContext(state, platform)) return coverRevisionDraftJournalPath(store, state, platform);
  const suffix = state.tagRevision?.nextFingerprint === state.fingerprint ? `.tags-${state.fingerprint}` : '';
  return `${store.receiptCheckpointPath(platform)}${suffix}.draft-save.json`;
}

function validateProof(proof, platform, fingerprint) {
  if (!proof || proof.version !== 2 || proof.platform !== platform || proof.fingerprint !== fingerprint
    || proof.method !== 'draft-list-reopen' || proof.documentChanged !== true
    || !proof.draftId || proof.listEntryId !== proof.draftId || proof.reopenedId !== proof.draftId) {
    fail(`cannot prove the original saved resource: ${platform}`);
  }
  if (platform === PLATFORM && (proof.storageScope !== 'browser-local' || !proof.uid
    || !/^[a-f0-9]{64}$/.test(proof.snapshotHash || ''))) fail('cannot prove the original browser-local saved resource');
  for (const value of [proof.listUrl, proof.reopenedUrl]) {
    const url = new URL(value);
    if (url.origin !== ORIGINS[platform] || url.username || url.password) fail('source proof contains an untrusted native draft route');
  }
}

function proofMatchesJournal(proof, journal, platform) {
  if (!proof || !journal?.plan?.id || proof.draftId !== String(journal.plan.id)
    || proof.savedAt !== journal.savedAt || proof.listUrl !== journal.plan.listUrl) return false;
  if (platform === PLATFORM) return proof.uid === journal.plan.uid && proof.snapshotHash === journal.plan.snapshotHash;
  const fields = platform === 'bilibili' ? ['title', 'videoName', 'videoStem', 'beforeIds'] : ['description', 'beforeIds'];
  return fields.every(key => Object.hasOwn(journal.plan, key) && isDeepStrictEqual(proof.lookup?.[key], journal.plan[key]));
}

function sourceProof(item, platform, fingerprint, journal) {
  const files = [...new Set([item.lastEvidencePath, ...(item.history || []).slice().reverse().map(entry => entry.evidencePath)].filter(Boolean))];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let observation;
    try { observation = JSON.parse(fs.readFileSync(file, 'utf8')).observation; } catch { continue; }
    const proof = observation?.gates?.persistedDraft?.evidence;
    if (observation?.platform !== platform || observation.fingerprint !== fingerprint || !validPersistence(observation)
      || Number(observation.taskSpaceId) !== Number(item.taskSpaceId)
      || observation.gates?.video?.ok !== true || observation.gates?.draftIdentity?.ok !== true
      || observation.finalPublishClicked !== false || !proofMatchesJournal(proof, journal, platform)) continue;
    const restored = observation.gates.draftIdentity.evidence?.restoredIdentity;
    if (restored && (restored.ok !== true || String(restored.actualId || restored.draftId || '') !== proof.draftId
      || platform === PLATFORM && restored.videoFileId && restored.videoFileId !== journal.plan.videoFileId)) continue;
    validateProof(proof, platform, fingerprint);
    return proof;
  }
  fail(`cannot prove the original saved UUID, account, snapshot and video identity from independent evidence: ${platform}`);
}

function validateSource(source, revision, item, platform) {
  const fingerprint = source.sourceFingerprint || revision.previousFingerprint;
  validateProof(source.sourcePersistedDraft, platform, fingerprint);
  const proof = source.sourcePersistedDraft;
  if (source.sourceDraftId !== proof.draftId || platform === PLATFORM && !source.sourceVideoFileId
    || Number(source.sourceTaskSpaceId) !== Number(item?.taskSpaceId) || source.sourceTaskSpaceName !== item?.taskSpaceName
    || !source.sourceJournalPath || !/^[a-f0-9]{64}$/.test(source.sourceJournalSha256 || '')) fail('source binding or original task space changed');
  if (digestBytes(fs.readFileSync(source.sourceJournalPath)) !== source.sourceJournalSha256) fail('original save journal changed; no cover migration or resave is allowed');
  const journal = readDraftSaveJournal(source.sourceJournalPath, { platform, fingerprint });
  if (journal?.status !== 'confirmed' || !proofMatchesJournal(proof, journal, platform)
    || platform === PLATFORM && journal.plan.videoFileId !== source.sourceVideoFileId) fail('requires the exact confirmed original save journal');
}

function assertTargets(args) {
  if (!args.platforms.length || new Set(args.platforms).size !== args.platforms.length
    || args.platforms.some(platform => !BROWSER_PLATFORMS.includes(platform))) fail('browser cover revision may target only existing Xiaohongshu, Bilibili or WeChat drafts');
  if (args.forceFreshSpace || args.spaceName || args.spaceSuffix) fail('browser cover revision cannot replace the original task space');
}

function assertReplay(revision, state, identity, args) {
  assertTargets(args);
  if (revision.nextFingerprint !== identity.fingerprint || revision.nextPackagePath !== args.packagePath
    || !sameTargets(revision.platforms, args.platforms) || revision.contentFingerprint !== identity.contentFingerprint
    || !sameVideo(revision.video, identity.video)) fail('conflicts with the bound cover revision package or unfinished intent');
  for (const platform of revision.platforms) validateSource(revision.sources?.[platform] || {}, revision, state.platforms[platform], platform);
}

function validateCoverReceipt(receipt, priorIdentity, platform) {
  const slots = platform === 'wechat_channels' ? Object.values(receipt?.slots || {}) : [receipt];
  if (!slots.length || platform === 'wechat_channels' && (!receipt.slots?.vertical || !receipt.slots?.horizontal)
    || slots.some(slot => !slot?.assetPath || !slot.afterUrl
      || !priorIdentity.assets.some(asset => path.resolve(asset.path) === path.resolve(slot.assetPath)))) {
    fail(`cannot prove the old accepted custom cover receipt: ${platform}`);
  }
}

/** Revisions bind exact saved native drafts before any package identity changes. */
export async function prepareBrowserCoverRevisionJob({ store, state, pkg, identity, args }) {
  assertTargets(args);
  const nativeRatio = pkg.cover?.platforms?.xiaohongshu?.nativeRatio;
  if (args.platforms.includes(PLATFORM) && nativeRatio !== undefined && !['3:4', '4:3', '16:9'].includes(nativeRatio)) {
    fail('requires a supported Xiaohongshu nativeRatio');
  }
  if (state.coverRevision?.nextFingerprint === identity.fingerprint && state.fingerprint === identity.fingerprint) {
    assertReplay(state.coverRevision, state, identity, args);
    return state.coverRevision;
  }
  const pending = state.coverRevisionIntent;
  if (pending) assertReplay(pending, state, identity, args);
  if (!pending && state.status !== 'ready') fail('requires an independently verified READY original draft before a new cover revision');
  if (state.tagRevisionIntent) fail('cannot replace covers while a tag revision intent is unfinished');
  if (identity.cover?.uploadCustomCover !== true) fail('requires explicitly enabled custom cover upload');
  const previousPackagePath = pending?.previousPackagePath || state.packagePath;
  const priorPkg = readPackage(previousPackagePath);
  const priorIdentity = await buildIdentity(priorPkg);
  if (priorIdentity.fingerprint !== state.fingerprint || pending && pending.previousFingerprint !== state.fingerprint) fail('original approved package or cover assets changed');
  if (!sameVideo(priorIdentity.video, identity.video) || !sameVideo(state.video, identity.video)) fail('cannot change the approved video file');
  if (priorIdentity.contentFingerprint !== identity.contentFingerprint || state.contentFingerprint !== identity.contentFingerprint) fail('may change only cover configuration and files; exact approved content must stay unchanged');
  const affected = Object.keys(identity.coverFingerprints).filter(platform => priorIdentity.coverFingerprints[platform] !== identity.coverFingerprints[platform]);
  if (!sameTargets(affected, args.platforms)) fail('requires every changed cover platform to be selected and unchanged sibling platform covers');
  for (const platform of args.platforms) {
    const item = state.platforms[platform];
    if (!item || item.status !== 'ready' || !Number.isInteger(item.taskSpaceId) || item.taskSpaceId <= 0 || !item.taskSpaceName) {
      fail(`has no independently READY original task space: ${platform}`);
    }
  }

  let revision = pending;
  if (!revision) {
    const sources = {};
    for (const platform of args.platforms) {
      const item = state.platforms[platform];
      const sourceFingerprint = coverRevisionPlatformFingerprint(state, platform);
      const sourceJournalPath = originalJournalPath(store, state, platform);
      const journal = readDraftSaveJournal(sourceJournalPath, { platform, fingerprint: sourceFingerprint });
      if (journal?.status !== 'confirmed' || !journal.plan?.id
        || platform === PLATFORM && (!journal.plan.uid || !journal.plan.videoFileId)) fail(`requires a confirmed original draft save; uncertain attempts cannot be resaved: ${platform}`);
      const proof = sourceProof(item, platform, sourceFingerprint, journal);
      const coverReceipt = item.receipts?.cover;
      validateCoverReceipt(coverReceipt, priorIdentity, platform);
      sources[platform] = { sourceFingerprint, sourceDraftId: proof.draftId, sourcePersistedDraft: proof,
        ...(platform === PLATFORM ? { sourceVideoFileId: journal.plan.videoFileId } : {}),
        sourceTaskSpaceId: item.taskSpaceId, sourceTaskSpaceName: item.taskSpaceName,
        sourceJournalPath, sourceJournalSha256: digestBytes(fs.readFileSync(sourceJournalPath)), sourceCoverReceipt: structuredClone(coverReceipt) };
    }
    revision = { at: new Date().toISOString(), previousFingerprint: state.fingerprint, nextFingerprint: identity.fingerprint,
      previousPackagePath, nextPackagePath: args.packagePath, platforms: [...args.platforms],
      affectedPlatforms: affected, contentFingerprint: identity.contentFingerprint, video: identity.video,
      previousPlatformFingerprints: Object.fromEntries(Object.keys(state.platforms).map(platform => [platform, coverRevisionPlatformFingerprint(state, platform)])), sources };
    for (const platform of args.platforms) validateSource(revision.sources[platform], revision, state.platforms[platform], platform);
    state.coverRevisionIntent = revision;
    // This write must precede any committed package identity or receipt change.
    await store.save();
  }

  state.schemaVersion = 4;
  state.fingerprint = identity.fingerprint;
  state.contentFingerprint = identity.contentFingerprint;
  state.coverFingerprint = identity.coverFingerprint;
  state.coverFingerprints = identity.coverFingerprints;
  state.cover = identity.cover;
  state.packagePath = args.packagePath;
  state.video = identity.video;
  state.assets = identity.assets;
  state.platformFingerprints = { ...revision.previousPlatformFingerprints,
    ...Object.fromEntries(args.platforms.map(platform => [platform, identity.fingerprint])) };
  state.coverRevision = revision;
  delete state.coverRevisionIntent;
  state.revisions ||= [];
  state.revisions.push({ at: revision.at, operation: 'replace-cover', from: revision.previousFingerprint,
    to: revision.nextFingerprint, packagePath: args.packagePath, platforms: args.platforms });
  if (state.revisions.length > 20) state.revisions = state.revisions.slice(-20);
  // Original checkpoints and journals are immutable; every selected platform gets separate revision files.
  for (const platform of args.platforms) {
    const item = state.platforms[platform];
    item.receipts = { ...(item.receipts || {}) };
    delete item.receipts.cover;
    if (item.videoReceipt) item.videoReceipt = { ...item.videoReceipt, fingerprint: identity.fingerprint };
    if (item.receipts.uploadStart?.fingerprint) item.receipts.uploadStart = { ...item.receipts.uploadStart, fingerprint: identity.fingerprint };
    item.verdict = null;
    item.status = 'needs_mutation';
  }
  state.status = 'blocked';
  await store.save();
  return revision;
}

// Kept for callers of the original single-platform safe revision API.
export const prepareXhsCoverRevisionJob = prepareBrowserCoverRevisionJob;
