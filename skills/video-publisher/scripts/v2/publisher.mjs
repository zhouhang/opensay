#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  readPackage,
  validateBilibiliPackage,
  validateDouyinPackage,
  validateWechatChannelsPackage,
  validateXiaohongshuPackage,
  validateYoutubePackage,
} from "../lib/content-package.mjs";
import { loadConfig } from "../lib/config.mjs";
import { inspectMediaFile, validateMediaForPlatform } from "../lib/media.mjs";
import { buildIdentity } from "./lib/identity.mjs";
import { checkXiaohongshuVideoClaim, reserveXiaohongshuVideoClaim, hasXiaohongshuSaveJournal } from './lib/xiaohongshu-video-claim.mjs';
import { draftboxLedgerPath, readDraftboxLedger, checkLegacyXiaohongshuDraftbox, recordVerifiedDraftbox } from './lib/draftbox-ledger.mjs';
import { acquireJobLock, JobBusyError, resolvePublisherLockDirectory } from "./lib/job-lock.mjs";
import { JobStore } from "./lib/job-store.mjs";
import { BLOCKER, PLATFORMS, classifyVerdict, compactVerdict, evaluateObservation, videoReceiptFromObservation } from "./lib/model.mjs";
import { parseV2Result } from "./lib/result-line.mjs";
import { runPool, SerialQueue } from "./lib/scheduler.mjs";
import { parsePublisherArgs, uniqueSpaceSuffix } from "./lib/cli-args.mjs";
import { prepareTagRevisionJob, tagRevisionContext } from './lib/tag-revision-job.mjs';
import { isBrowserCoverRevision, prepareBrowserCoverRevisionJob, coverRevisionContext,
  coverRevisionPlatformFingerprint, coverRevisionReceiptCheckpointPath, coverRevisionDraftJournalPath,
  loadCoverRevisionReceiptCheckpoint } from './lib/cover-revision-job.mjs';
import { douyinResumeRecoverySource } from './lib/douyin-resume-recovery-source.mjs';
import { xhsAutosaveRecoverySource } from './lib/xiaohongshu-autosave-recovery-source.mjs';
import { readDraftSaveJournal } from './lib/draft-save-journal.mjs';
import { prepareVideoRevisionJob, videoRevisionContext, videoRevisionReceiptCheckpointPath,
  videoRevisionDraftJournalPath, videoReplacementJournalPath, loadVideoRevisionReceiptCheckpoint } from './lib/video-revision-job.mjs';
import { readVideoReplacementJournal, validateVideoReplacementEvidence } from './lib/video-replacement-journal.mjs';
import { readVideoReplacementSpaceBinding, explicitVideoReplacementAuthorization } from './lib/video-replacement-authorization.mjs';
import { reconcileRecoveredVideoReceiptSpace } from './lib/video-revision-receipt-space.mjs';
import { checkXhsRecoveryPublication } from './lib/xiaohongshu-publication-guard.mjs';
import { buildXhsVerifySavedContext, validateXhsVerifySavedContext, XHS_VERIFY_SAVED_PHASES } from './lib/xiaohongshu-verify-saved.mjs';
import { loadXhsParkingContext, recoverXhsParkingContext, rememberXhsParkingSource } from './lib/xiaohongshu-parking-context.mjs';
import {
  IN_PROGRESS_STATUSES,
  buildCleanupPlan,
  buildSpaceName,
  cleanupTaskSpaces,
  retireCurrentSpaces,
  shouldRotateSpaces,
} from "./lib/spaces.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(os.homedir(), ".video-publisher", "v2-jobs");
const RIGHTS_PLATFORMS = new Set(["xiaohongshu", "bilibili", "wechat_channels"]);
const EARLY_PREFILL_PLATFORMS = new Set(["xiaohongshu", "douyin", "bilibili", "wechat_channels"]);
const validators = {
  xiaohongshu: validateXiaohongshuPackage,
  douyin: validateDouyinPackage,
  bilibili: validateBilibiliPackage,
  wechat_channels: validateWechatChannelsPackage,
  youtube: validateYoutubePackage,
};

class UsageError extends Error {}
const activeLockReleases = [];
let publisherLockToken = "";

function positive(raw, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new UsageError(`${name} must be a positive integer`);
  return value;
}

function parseArgs(argv) {
  return parsePublisherArgs(argv, {
    loadConfig,
    PLATFORMS,
    UsageError,
    positive,
    defaultStateRoot: DEFAULT_ROOT,
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function initialState(jobId, identity, args) {
  return {
    schemaVersion: 4,
    jobId,
    fingerprint: identity.fingerprint,
    contentFingerprint: identity.contentFingerprint,
    coverFingerprint: identity.coverFingerprint,
    coverFingerprints: identity.coverFingerprints,
    cover: identity.cover,
    packagePath: args.packagePath,
    taskSuffix: args.taskSuffix,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "new",
    scheduler: { checkConcurrency: args.checkConcurrency, uploadConcurrency: args.uploadConcurrency, uiConcurrency: 1 },
    video: identity.video,
    assets: identity.assets,
    revisions: [{ at: new Date().toISOString(), operation: args.operation, fingerprint: identity.fingerprint, packagePath: args.packagePath }],
    platforms: Object.fromEntries(args.platforms.map(platform => [platform, { status: "new", taskSpaceId: null, taskSpaceName: null, videoReceipt: null, receipts: {}, verdict: null, history: [] }])),
  };
}

function sameVideo(left, right) {
  return left?.size === right?.size && left?.sha256 === right?.sha256;
}

async function resolveStoredIdentity(state) {
  if (state.contentFingerprint && state.coverFingerprints) return state;
  if (!state.packagePath || !fs.existsSync(state.packagePath)) return null;
  const storedPackage = readPackage(state.packagePath);
  const storedIdentity = await buildIdentity(storedPackage);
  return [storedIdentity.fingerprint, storedIdentity.previousFingerprint, storedIdentity.legacyFingerprint].includes(state.fingerprint) ? storedIdentity : null;
}

async function prepareCoverReplacement(store, state, identity, args, pkg) {
  if (isBrowserCoverRevision(pkg, state, args)) {
    return prepareBrowserCoverRevisionJob({ store, state, pkg, identity, args });
  }
  if (state.status !== "ready") throw new UsageError(`replace-cover requires a READY draft; current status is ${state.status || "unknown"}`);
  if (identity.cover?.uploadCustomCover !== true) throw new UsageError("replace-cover requires cover.uploadCustomCover=true and explicit replacement files");
  const storedIdentity = await resolveStoredIdentity(state);
  if (!storedIdentity?.contentFingerprint || !storedIdentity?.coverFingerprints) {
    throw new UsageError("This legacy job cannot prove its original content identity. Create a fresh verified draft before using replace-cover.");
  }
  if (!sameVideo(state.video || storedIdentity.video, identity.video)) {
    throw new UsageError("replace-cover cannot change the video file");
  }
  if (storedIdentity.contentFingerprint !== identity.contentFingerprint) {
    throw new UsageError("replace-cover may change only cover settings and cover files; title, description, tags, video, and other metadata must stay unchanged");
  }
  const affectedPlatforms = Object.keys(identity.coverFingerprints)
    .filter(platform => storedIdentity.coverFingerprints[platform] !== identity.coverFingerprints[platform]);
  if (!affectedPlatforms.length) throw new UsageError("replace-cover found no changed cover asset");
  const missingTargets = affectedPlatforms.filter(platform => state.platforms[platform] && !args.platforms.includes(platform));
  if (missingTargets.length) {
    throw new UsageError(`replace-cover must include every existing draft whose cover changed: ${missingTargets.join(", ")}`);
  }
  for (const platform of args.platforms) {
    if (!state.platforms[platform]) throw new UsageError(`replace-cover cannot target a platform absent from this job: ${platform}`);
    if (!affectedPlatforms.includes(platform)) throw new UsageError(`replace-cover cover is unchanged for: ${platform}`);
    const item = state.platforms[platform];
    if (!item.taskSpaceId && !item.taskSpaceName) throw new UsageError(`replace-cover has no recorded Ego draft space for: ${platform}`);
  }
  const previous = { at: new Date().toISOString(), operation: "replace-cover", from: state.fingerprint, to: identity.fingerprint, packagePath: args.packagePath, platforms: args.platforms };
  state.schemaVersion = 4;
  state.fingerprint = identity.fingerprint;
  state.contentFingerprint = identity.contentFingerprint;
  state.coverFingerprint = identity.coverFingerprint;
  state.coverFingerprints = identity.coverFingerprints;
  state.cover = identity.cover;
  state.packagePath = args.packagePath;
  state.video = identity.video;
  state.assets = identity.assets;
  state.revisions ||= [];
  state.revisions.push(previous);
  if (state.revisions.length > 20) state.revisions = state.revisions.slice(-20);
  for (const [platform, item] of Object.entries(state.platforms)) {
    if (item.videoReceipt) item.videoReceipt = { ...item.videoReceipt, fingerprint: identity.fingerprint };
    item.receipts ||= {};
    if (item.receipts.uploadStart?.fingerprint) {
      item.receipts.uploadStart = { ...item.receipts.uploadStart, fingerprint: identity.fingerprint };
    }
    await store.clearReceiptCheckpoint(platform);
  }
  for (const platform of args.platforms) {
    const item = state.platforms[platform];
    delete item.receipts.cover;
    item.verdict = null;
    item.status = "needs_mutation";
  }
  args.freshSpace = false;
  args.forceFreshSpace = false;
  await store.save();
}

async function migrateLegacyIdentity(store, state, identity, args) {
  if (![identity.previousFingerprint, identity.legacyFingerprint].includes(state.fingerprint) || state.fingerprint === identity.fingerprint) return;
  const previousFingerprint = state.fingerprint;
  state.schemaVersion = 4;
  state.fingerprint = identity.fingerprint;
  state.contentFingerprint = identity.contentFingerprint;
  state.coverFingerprint = identity.coverFingerprint;
  state.coverFingerprints = identity.coverFingerprints;
  state.cover = identity.cover;
  state.packagePath = args.packagePath;
  state.video = identity.video;
  state.assets = identity.assets;
  state.revisions ||= [];
  state.revisions.push({ at: new Date().toISOString(), operation: "identity-migration", from: previousFingerprint, to: identity.fingerprint, packagePath: args.packagePath });
  for (const [platform, item] of Object.entries(state.platforms || {})) {
    if (item.videoReceipt) item.videoReceipt = { ...item.videoReceipt, fingerprint: identity.fingerprint };
    item.receipts ||= {};
    if (item.receipts.uploadStart?.fingerprint) item.receipts.uploadStart = { ...item.receipts.uploadStart, fingerprint: identity.fingerprint };
    if (platform === "youtube" && previousFingerprint === identity.legacyFingerprint && identity.cover?.uploadCustomCover === true) {
      delete item.receipts.cover;
      item.verdict = null;
      item.status = "needs_mutation";
      state.status = "blocked";
    }
    await store.clearReceiptCheckpoint(platform);
  }
  await store.save();
}

async function persistKeepSpace(store, state, args, closeCurrent) {
  if (args.keepSpace) state.keepSpace = true;
  else if (closeCurrent) state.keepSpace = false;
  await store.save();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cleanupOnly) {
    let state = { jobId: args.jobId || "", platforms: {}, retiredSpaces: [] };
    let statePath = "";
    if (args.packagePath) {
      if (!fs.existsSync(args.packagePath)) throw new Error(`Package JSON not found: ${args.packagePath}`);
      const pkg = readPackage(args.packagePath);
      const identity = await buildIdentity(pkg);
      const jobId = args.jobId || identity.fingerprint.slice(0, 16);
      const jobDir = path.join(args.stateRoot, jobId);
      const release = acquireJobLock(jobDir, { jobId, packagePath: args.packagePath });
      try {
        const store = new JobStore(jobDir, initialState(jobId, identity, args));
        state = await store.initialize();
        statePath = store.statePath;
        const inProgress = IN_PROGRESS_STATUSES.includes(state.status);
        const plan = await maybeCleanupSpaces(args, state, {
          complete: !inProgress,
          userControl: false,
          incomingInProgress: inProgress,
        });
        if (plan?.closeCurrent) state.keepSpace = false;
        await store.save();
        await store.close();
      } finally {
        release();
      }
    } else {
      await maybeCleanupSpaces(args, state, { complete: false, userControl: false, incomingInProgress: false });
    }
    console.log(JSON.stringify({ ok: true, cleanupOnly: true, jobId: state.jobId || "", statePath, stateRoot: args.stateRoot }, null, 2));
    return;
  }
  if (!fs.existsSync(args.packagePath)) throw new Error(`Package JSON not found: ${args.packagePath}`);
  const pkg = readPackage(args.packagePath);
  const media = inspectMediaFile(pkg.videoPath);
  const preflightErrors = Object.fromEntries(args.platforms.map(platform => [platform, [
    ...validators[platform](pkg),
    ...validateMediaForPlatform(pkg, platform, media),
  ]]));
  const runnablePlatforms = args.platforms.filter(platform => preflightErrors[platform].length === 0);
  if (!runnablePlatforms.length) {
    throw new Error(args.platforms
      .map(platform => `Package preflight failed for ${platform}: ${preflightErrors[platform].join("; ")}`)
      .join("\n"));
  }
  const rightsTargets = runnablePlatforms.filter(platform => RIGHTS_PLATFORMS.has(platform));
  const standingOriginalityPolicy = args.originalityPolicy === "all_videos_original";
  if (!args.inspectOnly && !['park', 'verify-saved-xhs'].includes(args.operation) && rightsTargets.length && !standingOriginalityPolicy && !args.originalRightsConfirmed) {
    throw new UsageError(`Originality confirmation is required before browser mutation for: ${rightsTargets.join(", ")}. Complete onboarding with declarations.originalityPolicy=all_videos_original, or confirm this run and add --confirm-original-rights.`);
  }
  const identity = await buildIdentity(pkg);
  const jobId = args.jobId || (args.operation === "repost"
    ? `${identity.fingerprint.slice(0, 12)}-${uniqueSpaceSuffix()}`
    : identity.fingerprint.slice(0, 16));
  const jobDir = path.join(args.stateRoot, jobId);
  const stateExisted = fs.existsSync(path.join(jobDir, "state.json"));
  if (args.operation === 'verify-saved-xhs' && !stateExisted) throw new UsageError('verify-saved-xhs requires an existing original confirmed job');
  if (args.operation === 'park' && !stateExisted) throw new UsageError('park requires an existing verified XHS job');
  if (args.operation === "replace-cover" && !stateExisted) throw new UsageError(`replace-cover job does not exist: ${jobId}`);
  if (args.operation === 'replace-video' && !stateExisted) throw new UsageError(`replace-video job does not exist: ${jobId}`);
  if (args.operation === "update-tags" && !stateExisted) throw new UsageError(`update-tags job does not exist: ${jobId}`);
  if (["resume"].includes(args.operation) && !stateExisted) throw new UsageError(`${args.operation} requires an existing job: ${jobId}`);
  if (["create", "repost"].includes(args.operation) && stateExisted) throw new UsageError(`${args.operation} requires a new job id; job already exists: ${jobId}`);
  const publisherRelease = acquireJobLock(resolvePublisherLockDirectory(), {
    jobId,
    packagePath: args.packagePath,
    scope: "publisher",
  });
  publisherLockToken = publisherRelease.token;
  activeLockReleases.push(publisherRelease);
  activeLockReleases.push(acquireJobLock(jobDir, { jobId, packagePath: args.packagePath }));
  const localDraftboxLedgerPath = draftboxLedgerPath();
  if (!args.inspectOnly) {
    const ledger = readDraftboxLedger(localDraftboxLedgerPath);
    if (runnablePlatforms.includes('xiaohongshu')) checkLegacyXiaohongshuDraftbox({ ledger, video: identity.video,
      jobId, packagePath: args.packagePath, stateExisted, operation: args.operation, confirmNewCopy: args.confirmNewCopy });
  }
  const xhsVideoClaim = runnablePlatforms.includes('xiaohongshu') ? {
    registryPath: path.join(path.dirname(resolvePublisherLockDirectory()), 'xiaohongshu-video-claims.json'),
    stateRoots: [args.stateRoot, DEFAULT_ROOT], video: identity.video, jobDir, jobId,
    fingerprint: identity.fingerprint, operation: args.operation, confirmNewCopy: args.confirmNewCopy,
  } : null;
  // This runs before creating a task space, not after file injection. Full
  // package identities change with title/cover/path; video bytes do not.
  const xhsPriorClaim = xhsVideoClaim && !args.inspectOnly ? checkXiaohongshuVideoClaim(xhsVideoClaim).currentClaim : null;
  const expectedState = initialState(jobId, identity, args);
  if (["replace-cover", "replace-video", "update-tags"].includes(args.operation)) expectedState.fingerprint = null;
  const store = new JobStore(jobDir, expectedState, {
    acceptedFingerprints: ['replace-cover', 'replace-video'].includes(args.operation) ? [] : [identity.previousFingerprint, identity.legacyFingerprint],
  });
  const state = await store.initialize();
  for (const item of Object.values(state.platforms)) {
    if (item.verdict?.ready === true && item.verdict.verificationVersion !== 2) {
      item.status = 'needs_persistence';
      item.verdict = { ...item.verdict, ready: false, missing: ['persistedDraft'], blocker: {
        code: BLOCKER.PERSISTENCE_UNVERIFIED, message: 'Legacy READY did not verify saved draft persistence', retryable: false,
      } };
      state.status = 'blocked';
    }
  }
  if (!["replace-cover", "replace-video", "update-tags"].includes(args.operation)) await migrateLegacyIdentity(store, state, identity, args);
  const incomingStatus = state.status;
  const incomingInProgress = IN_PROGRESS_STATUSES.includes(incomingStatus);
  if (args.operation === "auto" && stateExisted && incomingStatus === "ready") {
    throw new UsageError(`Job ${jobId} is already READY. Use --operation inspect, --operation replace-cover, or --operation repost --confirm-new-copy.`);
  }
  if (args.operation === "resume" && incomingStatus === "ready") {
    throw new UsageError(`Job ${jobId} is already READY; resume will not create another draft`);
  }
  if (args.operation === "replace-cover") await prepareCoverReplacement(store, state, identity, args, pkg);
  else if (args.operation === 'replace-video') await prepareVideoRevisionJob({ store, state, pkg, identity, args });
  else if (args.operation === "update-tags") await prepareTagRevisionJob({ store, state, pkg, identity, args });
  else {
    state.schemaVersion = 4;
    state.contentFingerprint ||= identity.contentFingerprint;
    state.coverFingerprint ||= identity.coverFingerprint;
    state.coverFingerprints ||= identity.coverFingerprints;
    state.cover ||= identity.cover;
  }
  if (args.operation === "inspect" && stateExisted) args.freshSpace = false;
  const tagsOnly = args.operation !== 'park' && state.tagRevision?.nextFingerprint === identity.fingerprint
    && args.platforms.every(platform => Boolean(tagRevisionContext(state, platform)));
  const coversOnly = args.operation !== 'park' && state.coverRevision?.nextFingerprint === identity.fingerprint
    && args.platforms.every(platform => Boolean(coverRevisionContext(state, platform)));
  if (args.operation === 'replace-cover' && !coversOnly) throw new UsageError('Cover revision may operate only on its bound original platform drafts');
  if (state.tagRevisionIntent && args.operation !== 'update-tags') throw new UsageError('An unfinished tag revision must resume with update-tags');
  if (state.coverRevisionIntent && args.operation !== 'replace-cover') throw new UsageError('An unfinished cover revision must replay the same replace-cover operation');
  if (state.videoRevisionIntent && args.operation !== 'replace-video') throw new UsageError('An unfinished video revision must replay the same replace-video operation');
  const videosOnly = args.operation === 'replace-video';
  const verifySavedXhs = args.operation === 'verify-saved-xhs';
  if (verifySavedXhs && (tagsOnly || coversOnly || state.videoRevisionIntent || state.tagRevisionIntent || state.coverRevisionIntent)) {
    throw new UsageError('verify-saved-xhs cannot repair or continue business-field/media revisions');
  }
  if (videosOnly) {
    if (args.platforms.some(platform => !videoRevisionContext(state, platform))) throw new UsageError('Video revision may operate only on its original bound drafts');
    args.freshSpace = false; args.keepSpace = true; args.cleanupStaleSpaces = false;
  }
  if (coversOnly) {
    if (!args.platforms.length || args.platforms.some(platform => !state.coverRevision.platforms.includes(platform)
      || !coverRevisionContext(state, platform))) throw new UsageError('Cover revision may operate only on its bound original platform drafts');
    if (args.forceFreshSpace || args.spaceName || args.spaceSuffix) throw new UsageError('Cover revision cannot replace original spaces');
    args.freshSpace = false; args.keepSpace = true; args.cleanupStaleSpaces = false;
  }
  if (tagsOnly) {
    if (args.forceFreshSpace || args.spaceName || args.spaceSuffix) throw new UsageError('Tag revision cannot replace original spaces');
    args.freshSpace = false; args.keepSpace = true; args.cleanupStaleSpaces = false;
  }
  if (args.keepSpace) state.keepSpace = true;
  if (shouldRotateSpaces(args, state)) {
    if (xhsVideoClaim && (xhsPriorClaim || hasXiaohongshuSaveJournal(jobDir) || state.platforms.xiaohongshu?.videoReceipt
      || state.platforms.xiaohongshu?.receipts?.uploadStart
      || state.platforms.xiaohongshu?.history?.some(entry => ['upload_start', 'upload', 'persist'].includes(entry.phase)))) {
      throw new UsageError('Xiaohongshu already started uploading/saving in this job; preserve and resume its original task space instead of recreating it');
    }
    const stamp = args.spaceSuffix || uniqueSpaceSuffix();
    retireCurrentSpaces(state, args.platforms);
    for (const platform of args.platforms) {
      const item = state.platforms[platform];
      if (!item) continue;
      item.taskSpaceId = null;
      item.taskSpaceName = buildSpaceName({
        spaceName: args.spaceName,
        spacePrefix: args.spacePrefix,
        platform,
        taskSuffix: args.taskSuffix,
        jobId,
        stamp,
      });
      item.receipts = {};
      item.receiptTaskSpaceId = null;
      item.videoReceipt = null;
      await store.clearReceiptCheckpoint(platform);
    }
  } else if (args.spaceName) {
    for (const platform of args.platforms) {
      const item = state.platforms[platform];
      if (!item) continue;
      if (item.taskSpaceName && item.taskSpaceName !== args.spaceName) {
        retireCurrentSpaces(state, [platform]);
        item.taskSpaceId = null;
        item.receipts = {};
        item.receiptTaskSpaceId = null;
        item.videoReceipt = null;
        await store.clearReceiptCheckpoint(platform);
      }
      item.taskSpaceName = args.spaceName;
    }
  }
  await store.save();
  if (store.lastRecovery) {
    console.error(`[video-publisher-v2] restored corrupt job state from atomic backup; preserved=${store.lastRecovery.corruptPath}`);
  }
  if (state.fingerprint !== identity.fingerprint) throw new Error(`Job ${jobId} belongs to another package`);
  for (const platform of args.platforms) state.platforms[platform] ||= { status: "new", taskSpaceId: null, taskSpaceName: null, videoReceipt: null, receipts: {}, verdict: null, history: [] };
  for (const platform of args.platforms) {
    const item = state.platforms[platform];
    if (!item.taskSpaceName && item.lastEvidencePath && fs.existsSync(item.lastEvidencePath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(item.lastEvidencePath, "utf8"));
        const observation = saved.observation || saved;
        if (observation.taskSpace && (item.taskSpaceId == null || Number(observation.taskSpaceId) === Number(item.taskSpaceId))) {
          item.taskSpaceName = observation.taskSpace;
        }
      } catch {}
    }
    if (item.receiptTaskSpaceId != null && item.taskSpaceId != null && Number(item.receiptTaskSpaceId) !== Number(item.taskSpaceId)) {
      const reconciled = reconcileRecoveredVideoReceiptSpace({ store, state, platform });
      if (!reconciled) {
        if (coversOnly || videoRevisionContext(state, platform)) throw new UsageError('Original-resource revision receipt task space changed; no checkpoint may be cleared');
        item.receipts = {};
        item.receiptTaskSpaceId = null;
        await store.clearReceiptCheckpoint(platform);
      }
    }
    if (item.videoReceipt?.taskSpaceId != null && item.taskSpaceId != null
      && Number(item.videoReceipt.taskSpaceId) !== Number(item.taskSpaceId)) item.videoReceipt = null;
    const checkpoint = videoRevisionContext(state, platform)
      ? await loadVideoRevisionReceiptCheckpoint(store, state, platform, item.taskSpaceId)
      : await loadCoverRevisionReceiptCheckpoint(store, state, platform, item.taskSpaceId);
    if (checkpoint) {
      item.receipts = { ...checkpoint.receipts, ...(item.receipts || {}) };
      item.receiptTaskSpaceId = checkpoint.taskSpaceId ?? item.receiptTaskSpaceId ?? item.taskSpaceId ?? null;
    }
  }
  for (const platform of args.platforms.filter(key => preflightErrors[key].length > 0)) {
    const item = state.platforms[platform];
    const observedAt = new Date().toISOString();
    const blocker = {
      code: BLOCKER.PLATFORM_REJECTED_ASSET,
      message: preflightErrors[platform].join("; "),
      retryable: false,
      requiresUser: false,
      evidence: { errors: preflightErrors[platform], media },
    };
    const observation = {
      schemaVersion: 1,
      platform,
      phase: "preflight",
      taskSpaceId: item.taskSpaceId ?? null,
      observedAt,
      finalPublishClicked: false,
      gates: {},
      blocker,
      evidence: { media },
    };
    const verdict = { platform, phase: "preflight", taskSpaceId: item.taskSpaceId ?? null, ready: false, missing: ["preflight"], blocker };
    item.status = "blocked";
    await store.record(platform, "preflight", observation, verdict);
  }
  const parkingContexts = new Map();
  let xhsVerifySavedContext = null;
  if (verifySavedXhs) {
    const item = state.platforms.xiaohongshu;
    xhsVerifySavedContext = buildXhsVerifySavedContext({jobId, item,
      fingerprint: coverRevisionPlatformFingerprint(state, 'xiaohongshu'),
      journalPath: `${store.receiptCheckpointPath('xiaohongshu')}.draft-save.json`,
      guardPath: `${store.receiptCheckpointPath('xiaohongshu')}.verify-saved-readonly.json`});
  }
  if (args.operation === 'park' || verifySavedXhs && state.platforms.xiaohongshu?.parkingSource) {
    const item = state.platforms.xiaohongshu;
    if (!item?.taskSpaceId || !item.lastEvidencePath) {
      throw new UsageError('Protective park requires the original independently verified READY XHS resource');
    }
    const fingerprint = coverRevisionPlatformFingerprint(state, 'xiaohongshu');
    const context = recoverXhsParkingContext({ item, fingerprint, taskSpaceId: item.taskSpaceId });
    rememberXhsParkingSource(item, context, fingerprint, item.taskSpaceId);
    parkingContexts.set('xiaohongshu', context);
  }
  state.status = args.inspectOnly ? "inspecting" : "running";
  await store.save();

  const runnerPath = path.resolve(process.env.VIDEO_PUBLISHER_V2_RUNNER || path.join(DIR, "run-platform.mjs"));
  let inputChannelBroken = false;
  let userControl = false;
  const verifiedPlatforms = new Set();
  const verificationRunId = randomUUID();
  async function invoke(platform, phase) {
    const item = state.platforms[platform];
    if (verifySavedXhs) {
      validateXhsVerifySavedContext(xhsVerifySavedContext, {operation: args.operation, platform, phase,
        fingerprint: coverRevisionPlatformFingerprint(state, platform), taskSpaceId: item.taskSpaceId,
        taskSpaceName: item.taskSpaceName});
      if (!XHS_VERIFY_SAVED_PHASES.includes(phase)) throw new UsageError('Saved-draft verification cannot invoke a write phase');
    }
    const videoContext = videoRevisionContext(state, platform);
    if (videoContext && (!['inspect', 'replace_video', 'persist', 'verify', 'park'].includes(phase)
      || Number(item.taskSpaceId) !== Number(videoContext.sourceTaskSpaceId)
      || item.taskSpaceName !== videoContext.sourceTaskSpaceName)) {
      throw new UsageError('Video revision prohibits generic uploads, mutations or changed original task spaces');
    }
    const xhsSavedResourceOnly = platform === 'xiaohongshu' && hasXiaohongshuSaveJournal(jobDir);
    if (xhsSavedResourceOnly && ['upload_start', 'upload', 'prefill', 'quarantine'].includes(phase)) {
      throw new UsageError('Xiaohongshu has a durable draft-save journal; resolve its original native UUID without another video upload');
    }
    if (platform === 'xiaohongshu' && xhsVideoClaim && !args.inspectOnly
      && ['upload_start', 'upload', 'prefill', 'mutate', 'persist', 'replace_video'].includes(phase)) {
      reserveXiaohongshuVideoClaim({ ...xhsVideoClaim, phase });
    }
    if (coversOnly && !['inspect', 'mutate', 'persist', 'verify', 'park'].includes(phase)) throw new UsageError('Cover revision prohibits upload, prefill, quarantine or new resources');
    const platformFingerprint = coverRevisionPlatformFingerprint(state, platform);
    const coverContext = coverRevisionContext(state, platform);
    const tagContext = tagRevisionContext(state, platform);
    if (tagContext && !['inspect', 'mutate', 'persist', 'verify', 'park'].includes(phase)) {
      throw new UsageError('Tag revision prohibits upload, prefill, quarantine or new resources');
    }
    if (coversOnly && (!coverContext || Number(item.taskSpaceId) !== Number(coverContext.sourceTaskSpaceId)
      || item.taskSpaceName !== coverContext.sourceTaskSpaceName)) throw new UsageError('Cover revision lost its original task space identity');
    const previousTaskSpaceId = item.taskSpaceId;
    const journalPath = videoContext ? videoRevisionDraftJournalPath(store, state, platform)
      : coversOnly ? coverRevisionDraftJournalPath(store, state, platform)
      : tagContext ? `${store.receiptCheckpointPath(platform)}.tags-${state.fingerprint}.draft-save.json`
        : `${store.receiptCheckpointPath(platform)}.draft-save.json`;
    let recoveryBlocker = null;
    if (platform === 'xiaohongshu' && phase !== 'park' && !verifySavedXhs) {
      const journal = readDraftSaveJournal(journalPath, { platform, fingerprint: platformFingerprint });
      if (journal && journal.plan.createdVerificationRunId !== verificationRunId
        && !explicitVideoReplacementAuthorization(videoContext, args.operation)) {
        recoveryBlocker = checkXhsRecoveryPublication({ journal,
          statusPath: process.env.VIDEO_PUBLISHER_XHS_PUBLICATION_STATUS_PATH, operation: args.operation }).blocker || null;
      }
      if (recoveryBlocker) { args.cleanupStaleSpaces = false; args.keepSpace = true; }
    }
    const platformPackagePath = state.platformPackagePaths?.[platform] || args.packagePath;
    const runnerArgs = [runnerPath, platform, platformPackagePath, phase, `${args.taskSuffix}-${jobId}`, item.taskSpaceId ? String(item.taskSpaceId) : ""];
    if (args.originalRightsConfirmed) runnerArgs.push("--confirm-original-rights");
    const execution = recoveryBlocker ? { stdout: `VIDEO_PUBLISHER_V2_RESULT:${JSON.stringify({
      platform, phase, fingerprint: platformFingerprint, verificationRunId,
      taskSpaceId: item.taskSpaceId, taskSpace: item.taskSpaceName,
      observedAt: new Date().toISOString(), gates: {}, blocker: recoveryBlocker,
    })}`, stderr: '' } : await runCapture(process.execPath, runnerArgs, {
      env: {
        ...process.env,
        VIDEO_PUBLISHER_V2_RECEIPTS: JSON.stringify(item.receipts || {}),
        VIDEO_PUBLISHER_V2_VERIFICATION_RUN_ID: verificationRunId,
        VIDEO_PUBLISHER_V2_CHECKPOINT_PATH: videoRevisionReceiptCheckpointPath(store, state, platform),
        VIDEO_PUBLISHER_V2_FINGERPRINT: platformFingerprint,
        VIDEO_PUBLISHER_V2_TASK_NAME: item.taskSpaceName || "",
        VIDEO_PUBLISHER_V2_VIDEO_RECEIPT: JSON.stringify(item.videoReceipt || null),
        VIDEO_PUBLISHER_V2_PUBLISHER_LOCK_TOKEN: publisherLockToken,
        VIDEO_PUBLISHER_V2_TAG_REVISION: JSON.stringify(tagContext),
        VIDEO_PUBLISHER_V2_COVER_REVISION: JSON.stringify(coverContext),
        VIDEO_PUBLISHER_V2_OPERATION: args.operation,
        VIDEO_PUBLISHER_V2_VIDEO_REVISION: JSON.stringify(videoContext),
        VIDEO_PUBLISHER_V2_XHS_VERIFY_SAVED: JSON.stringify(xhsVerifySavedContext),
        VIDEO_PUBLISHER_V2_VIDEO_REPLACEMENT_JOURNAL_PATH: videoReplacementJournalPath(store, state, platform),
        VIDEO_PUBLISHER_V2_NO_UPLOAD: verifySavedXhs || args.operation === 'park' || tagsOnly || tagContext || coversOnly ? '1' : xhsSavedResourceOnly ? '1' : '',
        VIDEO_PUBLISHER_V2_XHS_PARKING_CONTEXT: JSON.stringify(parkingContexts.get(platform) || null),
        VIDEO_PUBLISHER_V2_DRAFT_SAVE_JOURNAL_PATH: videoContext ? videoRevisionDraftJournalPath(store, state, platform)
          : coversOnly ? coverRevisionDraftJournalPath(store, state, platform)
          : tagContext ? `${store.receiptCheckpointPath(platform)}.tags-${state.fingerprint}.draft-save.json` : '',
        VIDEO_PUBLISHER_V2_DOUYIN_RESUME_RECOVERY_SOURCE: tagsOnly && platform === 'douyin' ? JSON.stringify(douyinResumeRecoverySource(state)) : 'null',
        VIDEO_PUBLISHER_V2_XHS_AUTOSAVE_RECOVERY_SOURCE: platform === 'xiaohongshu' ? JSON.stringify(xhsAutosaveRecoverySource(state)) : 'null',
      },
    });
    const observation = parseV2Result(`${execution.stdout}\n${execution.stderr}`);
    let authorizedSpaceRecovery = false;
    if (videoContext) {
      if (platform === 'xiaohongshu' && videoContext.spaceBindingPath) {
        const binding = readVideoReplacementSpaceBinding(videoContext.spaceBindingPath, videoContext);
        if (binding?.status === 'confirmed' && Number(observation.taskSpaceId) === binding.taskSpaceId
          && Number(item.taskSpaceId) === binding.previousTaskSpaceId && observation.taskSpace === binding.taskSpaceName
          && observation.taskSpaceRecovery?.reason === 'user_attested_original_draft_space_recovery'
          && observation.taskSpaceRecovery?.bindingAttemptId === binding.attemptId) {
          authorizedSpaceRecovery = true;
          item.taskSpaceId = binding.taskSpaceId;
          videoContext.originalSourceTaskSpaceId = binding.previousTaskSpaceId;
          videoContext.sourceTaskSpaceId = binding.taskSpaceId;
        }
      }
      if (Number(observation.taskSpaceId) !== Number(item.taskSpaceId) || observation.taskSpace !== item.taskSpaceName
        || observation.taskSpaceRecovery?.recreated === true && !authorizedSpaceRecovery) throw new UsageError('Video revision original task space was changed or recreated; preserving original records');
      observation.videoRevision = { sourceDraftId: videoContext.sourceDraftId,
        sourceTaskSpaceId: videoContext.sourceTaskSpaceId, sourceVideoSha256: videoContext.sourceVideoIdentity.sha256,
        nextVideoSha256: videoContext.nextVideoIdentity.sha256 };
      if (!observation.blocker && phase !== 'inspect') {
        const replacement = readVideoReplacementJournal(videoReplacementJournalPath(store, state, platform),
          { platform, fingerprint: platformFingerprint });
        const evidence = observation.gates?.replaceVideo?.evidence;
        if (replacement?.status !== 'confirmed' || observation.gates?.replaceVideo?.ok !== true
          || !validateVideoReplacementEvidence(evidence, replacement.plan)) {
          observation.blocker = { code: BLOCKER.STATE_AMBIGUOUS, retryable: false, requiresUser: false,
            message: 'New video upload lacks its durable original-draft injection evidence and fresh native-file readback' };
        }
        if (!observation.blocker && ['persist', 'verify'].includes(phase)
          && observation.gates?.persistedDraft?.evidence?.draftId !== videoContext.sourceDraftId) {
          observation.blocker = { code: BLOCKER.PERSISTENCE_UNVERIFIED, retryable: false, requiresUser: false,
            message: 'Video revision was not saved and independently reopened under the original native draft ID' };
        }
      }
    }
    if (coversOnly && (Number(observation.taskSpaceId) !== Number(item.taskSpaceId)
      || observation.taskSpace !== item.taskSpaceName || observation.taskSpaceRecovery?.recreated === true)) {
      throw new UsageError('Cover revision original task space was changed or recreated; preserving all prior receipts and identities');
    }
    if (observation.taskSpace) item.taskSpaceName = observation.taskSpace;
    const taskSpaceChanged = previousTaskSpaceId != null && observation.taskSpaceId != null
      && Number(previousTaskSpaceId) !== Number(observation.taskSpaceId);
    const taskSpaceRecreated = observation.taskSpaceRecovery?.recreated === true;
    if (tagsOnly && (taskSpaceChanged || taskSpaceRecreated)) {
      observation.blocker = { code: BLOCKER.STATE_AMBIGUOUS, message: '原草稿空间丢失或改变；标签更新禁止重建或重传', retryable: false, requiresUser: true };
    }
    if ((taskSpaceChanged || taskSpaceRecreated) && !authorizedSpaceRecovery) {
      item.receipts = {};
      item.videoReceipt = null;
      item.receiptTaskSpaceId = null;
      await store.clearReceiptCheckpoint(platform);
      observation.recovery = {
        ...(observation.recovery || {}),
        taskSpaceRecreated: {
          previousTaskSpaceId: observation.taskSpaceRecovery?.previousTaskSpaceId ?? previousTaskSpaceId,
          taskSpaceId: observation.taskSpaceId,
          numericIdChanged: taskSpaceChanged,
        },
      };
    }
    if (observation.receipts) {
      item.receipts = { ...(item.receipts || {}), ...observation.receipts };
      item.receiptTaskSpaceId = observation.taskSpaceId ?? item.taskSpaceId ?? null;
    }
    const videoReceipt = phase === "upload"
      ? videoReceiptFromObservation(observation, platformFingerprint, item.taskSpaceId)
      : null;
    if (videoReceipt) item.videoReceipt = videoReceipt;
    if (phase === 'replace_video' && !observation.blocker && observation.gates?.replaceVideo?.ok === true) {
      item.videoReceipt = { fingerprint: platformFingerprint, taskSpaceId: item.taskSpaceId, mode: 'replaced_original',
        sha256: videoContext.nextVideoIdentity.sha256, sourceDraftId: videoContext.sourceDraftId,
        replacement: observation.gates.replaceVideo.evidence, observedAt: observation.observedAt };
    }
    const verdict = evaluateObservation(observation);
    if (verdict.blocker?.code === BLOCKER.INPUT_CHANNEL_BROKEN) inputChannelBroken = true;
    if (verdict.blocker?.code === BLOCKER.USER_CONTROL) userControl = true;
    if ((phase === "verify" && platform !== 'xiaohongshu' || phase === 'park' && verdict.ready)
      && verdict.blocker?.code !== BLOCKER.INPUT_CHANNEL_BROKEN
      && verdict.blocker?.code !== BLOCKER.USER_CONTROL) verifiedPlatforms.add(platform);
    item.status = classifyVerdict(verdict);
    const deliveryVerdict = compactVerdict(verdict);
    if (platform === 'xiaohongshu' && verdict.ready && phase !== 'park' && !args.inspectOnly) {
      item.status = 'needs_parking';
      deliveryVerdict.ready = false;
      deliveryVerdict.missing = ['parkedDraft'];
    }
    if (tagsOnly && platform === 'douyin' && phase === 'inspect' && !observation.blocker
      && observation.evidence?.resumeRecovery?.ok === true
      && Number(observation.taskSpaceId) === Number(previousTaskSpaceId)
      && observation.gates.safety?.ok === true && observation.gates.safety.evidence?.guardArmed === true
      && observation.gates.safety.evidence?.blockedAttempts === 0) item.status = 'needs_persistence';
    if (observation.blocker) item.status = verdict.blocker?.requiresUser ? "blocked_user" : "blocked";
    await store.record(platform, phase, observation, deliveryVerdict);
    if (platform === 'xiaohongshu' && phase === 'verify' && verdict.ready) {
      const context = loadXhsParkingContext({ evidencePath: item.lastEvidencePath,
        fingerprint: platformFingerprint, taskSpaceId: item.taskSpaceId, verificationRunId });
      rememberXhsParkingSource(item, context, platformFingerprint, item.taskSpaceId);
      parkingContexts.set(platform, context);
      await store.save();
    }
    console.error(`[video-publisher-v2] ${platform} ${phase}: ${deliveryVerdict.ready ? "READY" : deliveryVerdict.missing.join(",") || verdict.blocker?.code}`);
    return { observation, verdict };
  }

  if (verifySavedXhs) {
    // This path has no upload/metadata/save work and never falls through to the
    // normal scheduler. Confirmed persistence only re-reads and reopens; native
    // autosave is disabled until the verified resource is parked.
    if (parkingContexts.has('xiaohongshu')) {
      await invoke('xiaohongshu', 'park');
    } else {
      const inspected = await invoke('xiaohongshu', 'inspect');
      const business = ['authenticated', 'draftIdentity', 'video', 'title', 'description', 'tags',
        'original', 'cover', 'noBlockingDialog', 'finalButton', 'safety'];
      if (!inspected.observation.blocker && business.every(key => inspected.observation.gates?.[key]?.ok === true)
        && !inputChannelBroken && !userControl) {
        const saved = await invoke('xiaohongshu', 'persist');
        if (!saved.observation.blocker && !inputChannelBroken && !userControl) {
          const checked = await invoke('xiaohongshu', 'verify');
          if (checked.verdict.ready && parkingContexts.has('xiaohongshu') && !inputChannelBroken && !userControl)
            await invoke('xiaohongshu', 'park');
        }
      }
    }
    state.status = Object.values(state.platforms).every(item => item.verdict?.ready === true) ? 'ready' : 'blocked';
    await store.save(); await store.close();
    console.log(JSON.stringify(summary(state, args.platforms, store.statePath), null, 2));
    if (state.platforms.xiaohongshu.verdict?.ready !== true) process.exitCode = 10;
    return;
  }
  if (args.operation === 'park') {
    const parkingUi = new SerialQueue();
    await parkingUi.enqueue(() => invoke('xiaohongshu', 'park'));
    await parkingUi.idle();
    state.status = Object.values(state.platforms).every(item => item.verdict?.ready === true) ? 'ready' : 'blocked';
    await store.save(); await store.close();
    console.log(JSON.stringify(summary(state, args.platforms, store.statePath), null, 2));
    if (state.platforms.xiaohongshu.verdict?.ready !== true) process.exitCode = 10;
    return;
  }

  if (videosOnly) {
    const revisionUi = new SerialQueue();
    for (const platform of runnablePlatforms) await revisionUi.enqueue(async () => {
      const replaced = await invoke(platform, 'replace_video');
      if (replaced.observation.blocker || replaced.observation.gates?.replaceVideo?.ok !== true || inputChannelBroken || userControl) return;
      const saved = await invoke(platform, 'persist');
      if (saved.observation.blocker || inputChannelBroken || userControl) return;
      const checked = await invoke(platform, 'verify');
      if (platform === 'xiaohongshu' && checked.verdict.ready && parkingContexts.has(platform)) await invoke(platform, 'park');
    });
    await revisionUi.idle();
    state.status = Object.values(state.platforms).every(item => item.verdict?.ready === true) ? 'ready' : 'blocked';
    await store.save(); await store.close();
    console.log(JSON.stringify(summary(state, args.platforms, store.statePath), null, 2));
    if (!args.platforms.every(platform => state.platforms[platform].verdict?.ready === true)) process.exitCode = 10;
    return;
  }

  console.error(`[video-publisher-v2] inspect parallel=${args.checkConcurrency}`);
  await runPool(runnablePlatforms, args.checkConcurrency, platform => invoke(platform, "inspect"));
  if (args.inspectOnly) {
    const hardBlocked = args.platforms.some(platform => ["blocked", "blocked_user", "blocked_foreign_draft"].includes(state.platforms[platform].status));
    const allReady = Object.values(state.platforms).every(item => item.verdict?.ready === true);
    state.status = incomingStatus === "ready"
      ? (allReady ? "ready" : "blocked")
      : incomingInProgress ? incomingStatus : (hardBlocked ? "blocked" : "inspected");
    const plan = await maybeCleanupSpaces(args, state, { complete: false, userControl, inputChannelBroken, incomingInProgress });
    await persistKeepSpace(store, state, args, plan?.closeCurrent === true);
    await store.close();
    console.log(JSON.stringify(summary(state, args.platforms, store.statePath), null, 2));
    if (hardBlocked || userControl) process.exitCode = 10;
    return;
  }

  if (userControl) {
    state.status = "paused_user";
    await store.save(); await store.close();
    console.log(JSON.stringify(summary(state, args.platforms, store.statePath), null, 2));
    process.exitCode = 10; return;
  }

  const ui = new SerialQueue();
  if (tagsOnly || coversOnly) {
    for (const platform of runnablePlatforms.filter(key => ['needs_upload', 'needs_quarantine'].includes(state.platforms[key].status))) {
      const item = state.platforms[platform];
      item.status = 'blocked';
      item.verdict = { ready: false, missing: ['originalVideo'], blocker: { code: BLOCKER.STATE_AMBIGUOUS,
        message: coversOnly ? '无法确认原上传视频；封面更新禁止重新上传或生成草稿' : '无法确认原上传视频；标签更新禁止重新上传或生成草稿', retryable: false, requiresUser: true } };
    }
    await store.save();
  }
  const quarantineTargets = inputChannelBroken || tagsOnly || coversOnly ? [] : runnablePlatforms.filter(key => state.platforms[key].status === "needs_quarantine");
  for (const platform of quarantineTargets) {
    if (inputChannelBroken || userControl) break;
    await ui.enqueue(async () => {
      if (inputChannelBroken || userControl) return;
      const result = await invoke(platform, "quarantine");
      if (!inputChannelBroken && !userControl && result.observation.quarantine?.safeToUpload) await invoke(platform, "inspect");
    });
  }

  const terminalStatuses = new Set(["blocked", "blocked_user", "blocked_foreign_draft"]);
  const canAdvance = platform => !terminalStatuses.has(state.platforms[platform].status)
    && ["ready", "needs_mutation", "needs_persistence", "needs_parking"].includes(state.platforms[platform].status);
  const advancementTasks = new Map();

  function scheduleAdvance(platform) {
    if (advancementTasks.has(platform)) return advancementTasks.get(platform);
    const task = ui.enqueue(async () => {
      if (inputChannelBroken || userControl || !canAdvance(platform)) return;

      if (state.platforms[platform].status === "needs_mutation") {
        await invoke(platform, "mutate");
        if (inputChannelBroken || userControl || terminalStatuses.has(state.platforms[platform].status)) return;
      }

      await invoke(platform, "persist");
      if (inputChannelBroken || userControl || terminalStatuses.has(state.platforms[platform].status)) return;
      await invoke(platform, "verify");
      if (inputChannelBroken || userControl || terminalStatuses.has(state.platforms[platform].status)) return;

      // One targeted retry is allowed only for an idempotent mutation whose fresh
      // verifier returned STATE_AMBIGUOUS. Typed action/auth/risk-control failures
      // freeze only that platform and are never looped.
      const verdict = state.platforms[platform].verdict;
      if (state.platforms[platform].status === "needs_mutation"
        && verdict?.blocker?.code === BLOCKER.STATE_AMBIGUOUS) {
        await invoke(platform, "mutate");
        if (inputChannelBroken || userControl || terminalStatuses.has(state.platforms[platform].status)) return;
        await invoke(platform, "persist");
        if (inputChannelBroken || userControl || terminalStatuses.has(state.platforms[platform].status)) return;
        await invoke(platform, "verify");
      }
      if (platform === 'xiaohongshu' && parkingContexts.has(platform)
        && state.platforms[platform].status === 'needs_parking' && !inputChannelBroken && !userControl) {
        await invoke(platform, 'park');
      }
    }).then(
      () => ({ platform, error: null }),
      error => ({ platform, error }),
    );
    advancementTasks.set(platform, task);
    return task;
  }

  // Start every missing upload first. Platforms with live-proven editable upload
  // states may prefill metadata through the same one-wide UI queue, then resume
  // their completion wait before final mutation and verification.
  const uploadTargets = inputChannelBroken || userControl || tagsOnly || coversOnly || args.operation === "replace-cover" ? [] : runnablePlatforms.filter(platform => state.platforms[platform].status === "needs_upload");
  console.error(`[video-publisher-v2] upload parallel=${args.uploadConcurrency}: ${uploadTargets.join(",") || "none"}`);
  const uploadPool = runPool(uploadTargets, args.uploadConcurrency, async platform => {
    if (inputChannelBroken || userControl) return;
    if (EARLY_PREFILL_PLATFORMS.has(platform)) {
      const started=await invoke(platform, "upload_start");
      if (inputChannelBroken || userControl || terminalStatuses.has(state.platforms[platform].status)) return;
      if (started.observation.actions?.upload?.stage === "editable_uploading") {
        let prefillResult = null;
        await ui.enqueue(async () => {
          if (inputChannelBroken || userControl || terminalStatuses.has(state.platforms[platform].status)) return;
          prefillResult = await invoke(platform, "prefill");
        });
        if (inputChannelBroken || userControl) return;
        if (terminalStatuses.has(state.platforms[platform].status)) {
          const prefillVerdict = prefillResult?.verdict;
          const uploadCompletedDuringPrefill = prefillVerdict?.gates?.video?.ok === true;
          const uploadStillActive = prefillVerdict?.gates?.video?.evidence?.uploading === true;
          const safeToDefer = prefillVerdict?.blocker?.retryable === true
            && (uploadStillActive || uploadCompletedDuringPrefill)
            && ![BLOCKER.AUTH_REQUIRED, BLOCKER.USER_CONTROL, BLOCKER.INPUT_CHANNEL_BROKEN, BLOCKER.RISK_CONTROL]
              .includes(prefillVerdict?.blocker?.code);
          if (!safeToDefer) return;
          state.platforms[platform].status = uploadCompletedDuringPrefill ? "needs_mutation" : "needs_upload";
          await store.save();
          console.error(uploadCompletedDuringPrefill
            ? `[video-publisher-v2] ${platform} prefill deferred to final mutation after upload completed: ${prefillVerdict.blocker.code}`
            : `[video-publisher-v2] ${platform} prefill deferred until upload completion: ${prefillVerdict.blocker.code}`);
        }
      }
      if (canAdvance(platform)) {
        scheduleAdvance(platform);
        return;
      }
      if (state.platforms[platform].status !== "needs_upload") return;
    }
    await invoke(platform, "upload");
    if (!inputChannelBroken && !userControl && canAdvance(platform)) scheduleAdvance(platform);
  });

  const immediateTargets = runnablePlatforms.filter(platform => canAdvance(platform));
  console.error(`[video-publisher-v2] rolling UI serial: ${immediateTargets.join(",") || "waiting for uploads"}`);
  for (const platform of immediateTargets) scheduleAdvance(platform);

  await uploadPool;
  const advancementResults = await Promise.all([...advancementTasks.values()]);
  const advancementFailure = advancementResults.find(result => result.error);
  if (advancementFailure) throw advancementFailure.error;
  await ui.idle();

  // INPUT_CHANNEL_BROKEN remains invocation-wide. Work already completed before the
  // signal stays recorded; no new mutation starts after it. One final read-only pass
  // covers only platforms that have not already completed their rolling verification.
  if (inputChannelBroken && !userControl) {
    const verifyTargets = runnablePlatforms.filter(platform => !verifiedPlatforms.has(platform));
    console.error(`[video-publisher-v2] input channel broken; final verify parallel=${args.checkConcurrency}: ${verifyTargets.join(",") || "none"}`);
    await runPool(verifyTargets, args.checkConcurrency, platform => userControl ? null : invoke(platform, "verify"));
  }

  const complete = args.platforms.every(platform => state.platforms[platform].verdict?.ready === true);
  const allReady = Object.values(state.platforms).every(item => item.verdict?.ready === true);
  state.status = userControl ? "paused_user" : allReady ? "ready" : "blocked";
  const plan = await maybeCleanupSpaces(args, state, { complete, userControl, inputChannelBroken, incomingInProgress });
  await persistKeepSpace(store, state, args, plan?.closeCurrent === true);
  await store.close();
  recordVerifiedDraftbox({ file: localDraftboxLedgerPath, video: identity.video, jobId, packagePath: args.packagePath,
    title: pkg.title, platforms: args.platforms, state, verifiedPlatforms });
  console.log(JSON.stringify(summary(state, args.platforms, store.statePath), null, 2));
  if (!complete) process.exitCode = 10;
}

async function maybeCleanupSpaces(args, state, { complete, userControl, inputChannelBroken = false, incomingInProgress = false }) {
  if (args.platforms?.length && args.platforms.every(platform => platform === 'youtube')) return null;
  const plan = buildCleanupPlan(args, state, { complete, userControl, inputChannelBroken, incomingInProgress });
  if (!plan) return null;
  try {
    const cleaned = await cleanupTaskSpaces(plan);
    if (cleaned.closed.length) {
      console.error(`[video-publisher-v2] closed task spaces: ${cleaned.closed.map(item => item.name || item.id).join(", ")}`);
    }
  } catch (error) {
    console.error(`[video-publisher-v2] task space cleanup skipped: ${String(error?.message || error)}`);
  }
  return plan;
}

function summary(state, platforms, statePath) {
  return {
    schemaVersion: 4,
    jobId: state.jobId,
    operation: state.revisions?.at(-1)?.operation || "unknown",
    status: state.status,
    ready: platforms.every(platform => state.platforms[platform].verdict?.ready === true),
    statePath,
    scheduler: state.scheduler,
    platforms: Object.fromEntries(platforms.map(platform => {
      const item = state.platforms[platform];
      return [platform, { status: item.status, verificationVersion: item.verdict?.verificationVersion || null,
        deliveryKind: platform === 'youtube' ? 'private_video' : ['xiaohongshu', 'douyin'].includes(platform) ? 'browser_local_draft' : 'saved_draft',
        taskSpaceId: platform === 'youtube' ? null : item.taskSpaceId, ready: item.verdict?.ready === true,
        ...(platform === 'xiaohongshu' ? { parked: item.verdict?.surface === 'xhs-draft-list-parked' && item.verdict?.ready === true,
          parkedDraft: item.verdict?.parkedProof || null } : {}),
        missing: item.verdict?.missing || [], blocker: item.verdict?.blocker || null, evidencePath: item.lastEvidencePath || null }];
    })),
  };
}

main()
  .catch(error => {
    console.error(`[video-publisher-v2] fatal: ${String(error?.stack || error)}`);
    process.exitCode = error instanceof UsageError ? 2 : error instanceof JobBusyError ? 1 : 1;
  })
  .finally(() => {
    for (const release of activeLockReleases.reverse()) release();
  });
