#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  coverForPlatform,
  readPackage,
  validateBilibiliPackage,
  validateDouyinPackage,
  validateWechatChannelsPackage,
  validateXiaohongshuPackage,
  validateYoutubePackage,
} from "../lib/content-package.mjs";
import { loadConfig } from "../lib/config.mjs";
import { inspectMediaFile, validateMediaForPlatform } from "../lib/media.mjs";
import { acquireJobLock, assertJobLockOwner, registerJobLockMember, resolvePublisherLockDirectory } from "./lib/job-lock.mjs";
import { PLATFORMS, requiredGates } from "./lib/model.mjs";
import { acquirePlatformLock } from "./lib/platform-lock.mjs";
import { parseV2Result, V2_RESULT_PREFIX } from "./lib/result-line.mjs";
import { runYoutubeApi } from './platforms/youtube-api.mjs';
import { readDraftSaveJournal } from './lib/draft-save-journal.mjs';
import { explicitVideoReplacementAuthorization } from './lib/video-replacement-authorization.mjs';
import { checkXhsRecoveryPublication } from './lib/xiaohongshu-publication-guard.mjs';
import { validateXhsVerifySavedContext } from './lib/xiaohongshu-verify-saved.mjs';
import { validateXhsAutosaveRecoverySource } from './lib/xiaohongshu-autosave-recovery-source.mjs';
import { explicitXhsReconcileAuthorization } from './lib/xiaohongshu-reconcile-authorization.mjs';
import { readUnsavedBilibiliTagContext } from './lib/bilibili-unsaved-tag-revision.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const validators = {
  xiaohongshu: validateXiaohongshuPackage,
  douyin: validateDouyinPackage,
  bilibili: validateBilibiliPackage,
  wechat_channels: validateWechatChannelsPackage,
  youtube: validateYoutubePackage,
};
const platformFiles = {
  xiaohongshu: "xiaohongshu.mjs",
  douyin: "douyin.mjs",
  bilibili: "bilibili.mjs",
  wechat_channels: "wechat-channels.mjs",
  youtube: "youtube.mjs",
};

function usage() {
  return "Usage: run-platform.mjs <platform> <package.json> <inspect|upload_start|prefill|upload|mutate|persist|verify|park|replace_video|quarantine> [task-suffix] [task-space-id] [--confirm-original-rights]";
}

function runEgo(script, onSpawn) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.VIDEO_PUBLISHER_V2_EGO_COMMAND || "ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
    let releaseMember = () => {};
    let settled = false;
    const fail = error => {
      releaseMember();
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.on("error", fail);
    try {
      releaseMember = onSpawn(child.pid);
    } catch (error) {
      child.kill("SIGTERM");
      fail(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => {
      releaseMember();
      if (settled) return;
      settled = true;
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(script);
  });
}

const rawArgs = process.argv.slice(2);
const originalRightsConfirmed = rawArgs.includes("--confirm-original-rights");
const positional = rawArgs.filter(arg => arg !== "--confirm-original-rights");
if (positional.some(arg => arg.startsWith("--"))) {
  console.error(usage());
  process.exit(2);
}
const [platform, rawPackagePath, phase, taskSuffix = "manual", taskSpaceRef = ""] = positional;
if (!PLATFORMS.includes(platform) || !rawPackagePath || !["inspect", "upload_start", "prefill", "upload", "mutate", "persist", "verify", "park", "replace_video", "quarantine"].includes(phase)) {
  console.error(usage());
  process.exit(2);
}
if (phase === "quarantine" && platform !== "bilibili") {
  console.error("quarantine is supported only for bilibili");
  process.exit(2);
}
if (phase === 'replace_video' && !['bilibili', 'wechat_channels', 'xiaohongshu'].includes(platform)) throw new Error('ORIGINAL_VIDEO_REPLACEMENT_UNSUPPORTED');
if (phase === 'park' && platform !== 'xiaohongshu') throw new Error('park is supported only for xiaohongshu');
const config = loadConfig({ requireOnboarded: true });
if (!config.availablePlatforms.includes(platform)) {
  console.error(`Platform is not configured as available: ${platform}. Update Video Publisher onboarding before browser work.`);
  process.exit(2);
}
const standingOriginalityPolicy = config.declarations.originalityPolicy === "all_videos_original";
if (['mutate', 'replace_video'].includes(phase) && ["xiaohongshu", "bilibili", "wechat_channels"].includes(platform) && !standingOriginalityPolicy && !originalRightsConfirmed) {
  console.error(`Originality confirmation is required before ${platform} mutation; set declarations.originalityPolicy=all_videos_original during onboarding, or add --confirm-original-rights after confirming this run.`);
  process.exit(2);
}
const packagePath = path.resolve(rawPackagePath);
if (!fs.existsSync(packagePath)) throw new Error(`Package JSON not found: ${packagePath}`);
const pkg = readPackage(packagePath);
const videoRevision = JSON.parse(process.env.VIDEO_PUBLISHER_V2_VIDEO_REVISION || 'null');
const suppliedTagRevision = JSON.parse(process.env.VIDEO_PUBLISHER_V2_TAG_REVISION || 'null');
const unsavedBilibiliTagRevision = suppliedTagRevision?.kind === 'bilibili-unsaved-tag-correction-v1' ? suppliedTagRevision : null;
const xhsReconcile = JSON.parse(process.env.VIDEO_PUBLISHER_V2_XHS_RECONCILE || 'null');
const xhsVerifySaved = JSON.parse(process.env.VIDEO_PUBLISHER_V2_XHS_VERIFY_SAVED || 'null');
if (process.env.VIDEO_PUBLISHER_V2_OPERATION === 'verify-saved-xhs' || xhsVerifySaved) {
  validateXhsVerifySavedContext(xhsVerifySaved, {operation: process.env.VIDEO_PUBLISHER_V2_OPERATION, platform, phase,
    fingerprint: process.env.VIDEO_PUBLISHER_V2_FINGERPRINT, taskSpaceId: taskSpaceRef,
    taskSpaceName: process.env.VIDEO_PUBLISHER_V2_TASK_NAME});
  if (process.env.VIDEO_PUBLISHER_V2_NO_UPLOAD !== '1' || videoRevision || xhsReconcile || suppliedTagRevision)
    throw new Error('Saved-draft verification cannot enable writes or revisions');
}
const xhsAutosaveRecovery = JSON.parse(process.env.VIDEO_PUBLISHER_V2_XHS_AUTOSAVE_RECOVERY_SOURCE || 'null');
if (xhsAutosaveRecovery) {
  if (platform !== 'xiaohongshu') throw new Error('XHS autosave recovery requires the original XHS platform');
  validateXhsAutosaveRecoverySource(xhsAutosaveRecovery, { fingerprint: process.env.VIDEO_PUBLISHER_V2_FINGERPRINT,
    taskSpaceId: taskSpaceRef, taskSpaceName: process.env.VIDEO_PUBLISHER_V2_TASK_NAME, videoName: path.basename(pkg.videoPath) });
}
if (xhsReconcile && (platform !== 'xiaohongshu' || !explicitXhsReconcileAuthorization(xhsReconcile,
  process.env.VIDEO_PUBLISHER_V2_OPERATION, phase))) throw new Error('Invalid explicit original XHS reconciliation context');
if (platform === 'xiaohongshu' && phase !== 'park' && !xhsVerifySaved) {
  const journalPath = process.env.VIDEO_PUBLISHER_V2_DRAFT_SAVE_JOURNAL_PATH
    || (process.env.VIDEO_PUBLISHER_V2_CHECKPOINT_PATH ? `${process.env.VIDEO_PUBLISHER_V2_CHECKPOINT_PATH}.draft-save.json` : '');
  const journal = readDraftSaveJournal(journalPath, { platform, fingerprint: process.env.VIDEO_PUBLISHER_V2_FINGERPRINT });
  if (journal && journal.plan.createdVerificationRunId !== process.env.VIDEO_PUBLISHER_V2_VERIFICATION_RUN_ID
    && !explicitVideoReplacementAuthorization(videoRevision, process.env.VIDEO_PUBLISHER_V2_OPERATION)
    && !explicitXhsReconcileAuthorization(xhsReconcile, process.env.VIDEO_PUBLISHER_V2_OPERATION, phase)) {
    const recovery = checkXhsRecoveryPublication({ journal, statusPath: process.env.VIDEO_PUBLISHER_XHS_PUBLICATION_STATUS_PATH });
    if (recovery.blocker) throw new Error(`${recovery.blocker.code}: ${recovery.blocker.message}`);
  }
}
if (process.env.VIDEO_PUBLISHER_V2_NO_UPLOAD === '1' && ['upload', 'upload_start', 'prefill', 'quarantine'].includes(phase)) throw new Error('Original-resource revision prohibits upload, prefill or quarantine');
if (platform === 'youtube' && process.env.VIDEO_PUBLISHER_V2_NO_UPLOAD === '1') {
  const revision = JSON.parse(process.env.VIDEO_PUBLISHER_V2_TAG_REVISION || 'null');
  const checkpoint = JSON.parse(fs.readFileSync(`${process.env.VIDEO_PUBLISHER_V2_CHECKPOINT_PATH}.youtube-api.json`, 'utf8'));
  if (!revision?.sourceDraftId || revision.nextFingerprint !== process.env.VIDEO_PUBLISHER_V2_FINGERPRINT
    || checkpoint.fingerprint !== revision.nextFingerprint || checkpoint.videoId !== revision.sourceDraftId) {
    throw new Error('Tag-only revision must keep the original verified YouTube video ID and checkpoint');
  }
}
const media = inspectMediaFile(pkg.videoPath);
const errors = [...validators[platform](pkg), ...validateMediaForPlatform(pkg, platform, media)];
if (errors.length) throw new Error(`Package preflight failed for ${platform}: ${errors.join("; ")}`);
const douyinResumeRecoverySource = JSON.parse(process.env.VIDEO_PUBLISHER_V2_DOUYIN_RESUME_RECOVERY_SOURCE || 'null');
let localMediaMetadata = null;
if (phase === 'replace_video' && !videoRevision) throw new Error('replace_video requires durable original-resource revision authority');
if (videoRevision || unsavedBilibiliTagRevision || platform === 'douyin' && douyinResumeRecoverySource) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,width,height', '-of', 'json', path.resolve(pkg.videoPath)], { encoding: 'utf8' }));
  const stream = probe.streams?.find(item => item.codec_type === 'video');
  const stat = fs.statSync(pkg.videoPath);
  localMediaMetadata = { path: path.resolve(pkg.videoPath), size: stat.size, lastModified: Math.trunc(stat.mtimeMs),
    durationSeconds: Number(probe.format?.duration), width: stream?.width, height: stream?.height,
    sha256: createHash('sha256').update(fs.readFileSync(pkg.videoPath)).digest('hex') };
}
if (unsavedBilibiliTagRevision) readUnsavedBilibiliTagContext(unsavedBilibiliTagRevision,
  { fingerprint: process.env.VIDEO_PUBLISHER_V2_FINGERPRINT, platform, localMediaMetadata });

const header = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  'import { createHash } from "node:crypto";',
  `import { xhsParkedVideoReplacementGate } from ${JSON.stringify(new URL('./lib/xiaohongshu-parked-video-replacement.mjs', import.meta.url).href)};`,
  `import { readVideoReplacementSpaceBinding, beginVideoReplacementSpaceRecovery, confirmVideoReplacementSpaceRecovery } from ${JSON.stringify(new URL('./lib/video-replacement-authorization.mjs', import.meta.url).href)};`,
  `import { readExplicitLosslessPngTransport, explicitCoverTransportMatches } from ${JSON.stringify(new URL('./lib/cover-transport.mjs', import.meta.url).href)};`,
  `import { readVideoReplacementJournal, beginVideoReplacement, confirmVideoReplacement, validateVideoReplacementEvidence, videoReplacementSnapshotHash } from ${JSON.stringify(new URL('./lib/video-replacement-journal.mjs', import.meta.url).href)};`,
  `import { readWechatServerMediaNormalization } from ${JSON.stringify(new URL('./platforms/wechat-channels-normalization.mjs', import.meta.url).href)};`,
  `import { readDraftSaveJournal, beginDraftSave, restartConfirmedDraftSave, restartConfirmedResumeSlotSave, restartUnconfirmedDraftSave, confirmDraftSave, recordConfirmedResumeSlotNormalization } from ${JSON.stringify(new URL('./lib/draft-save-journal.mjs', import.meta.url).href)};`,
  `import { xhsNativePublicationBlocker } from ${JSON.stringify(new URL('./lib/xiaohongshu-publication-guard.mjs', import.meta.url).href)};`,
  `import { validateXhsAutosaveRecoverySource } from ${JSON.stringify(new URL('./lib/xiaohongshu-autosave-recovery-source.mjs', import.meta.url).href)};`,
  `import { explicitXhsReconcileAuthorization, validateXhsReconcileNative, archiveXhsOriginalJournal } from ${JSON.stringify(new URL('./lib/xiaohongshu-reconcile-authorization.mjs', import.meta.url).href)};`,
  `const platform = ${JSON.stringify(platform)};`,
  `const phase = ${JSON.stringify(phase)};`,
  `const taskName = ${JSON.stringify(process.env.VIDEO_PUBLISHER_V2_TASK_NAME || `video publisher v2 ${platform} ${taskSuffix}`)};`,
  `const taskSpaceRef = ${JSON.stringify(taskSpaceRef)};`,
  `const packagePath = ${JSON.stringify(packagePath)};`,
  `const pkg = ${JSON.stringify({ ...pkg, cover: coverForPlatform(pkg, platform) })};`,
  `const videoPath = ${JSON.stringify(path.resolve(pkg.videoPath))};`,
  `const expectedReceipts = ${JSON.stringify(JSON.parse(process.env.VIDEO_PUBLISHER_V2_RECEIPTS || "{}"))};`,
  `const expectedVideoReceipt = ${JSON.stringify(JSON.parse(process.env.VIDEO_PUBLISHER_V2_VIDEO_RECEIPT || "null"))};`,
  `const receiptCheckpointPath = ${JSON.stringify(process.env.VIDEO_PUBLISHER_V2_CHECKPOINT_PATH || "")};`,
  `const jobFingerprint = ${JSON.stringify(process.env.VIDEO_PUBLISHER_V2_FINGERPRINT || "")};`,
  `const tagRevisionContext = ${JSON.stringify(unsavedBilibiliTagRevision ? null : suppliedTagRevision)};`,
  `const unsavedBilibiliTagRevisionContext = ${JSON.stringify(unsavedBilibiliTagRevision)};`,
  `const videoRevisionContext = ${JSON.stringify(videoRevision)};`,
  `const xhsReconcileContext = ${JSON.stringify(xhsReconcile)};`,
  `const xhsVerifySavedContext = ${JSON.stringify(xhsVerifySaved)};`,
  `const xhsAutosaveRecoveryContext = ${JSON.stringify(xhsAutosaveRecovery)};`,
  `const videoReplacementJournalPath = ${JSON.stringify(process.env.VIDEO_PUBLISHER_V2_VIDEO_REPLACEMENT_JOURNAL_PATH || '')};`,
  `const coverRevisionContext = ${JSON.stringify(JSON.parse(process.env.VIDEO_PUBLISHER_V2_COVER_REVISION || 'null'))};`,
  `const draftSaveJournalPath = ${JSON.stringify(process.env.VIDEO_PUBLISHER_V2_DRAFT_SAVE_JOURNAL_PATH || '')};`,
  `const noUpload = ${JSON.stringify(process.env.VIDEO_PUBLISHER_V2_NO_UPLOAD === '1')};`,
  `const xhsCoverTransportManifestPath = ${JSON.stringify(process.env.VIDEO_PUBLISHER_XHS_COVER_TRANSPORT_MANIFEST || '')};`,
  `const bilibiliCoverTransportManifestPath = ${JSON.stringify(process.env.VIDEO_PUBLISHER_BILIBILI_COVER_TRANSPORT_MANIFEST || '')};`,
  `const wechatVerticalCoverTransportManifestPath = ${JSON.stringify(process.env.VIDEO_PUBLISHER_WECHAT_VERTICAL_COVER_TRANSPORT_MANIFEST || '')};`,
  `const wechatHorizontalCoverTransportManifestPath = ${JSON.stringify(process.env.VIDEO_PUBLISHER_WECHAT_HORIZONTAL_COVER_TRANSPORT_MANIFEST || '')};`,
  `const xhsParkingContext = ${JSON.stringify(JSON.parse(process.env.VIDEO_PUBLISHER_V2_XHS_PARKING_CONTEXT || 'null'))};`,
  `const douyinResumeRecoverySource = ${JSON.stringify(douyinResumeRecoverySource)};`,
  `const localMediaMetadata = ${JSON.stringify(localMediaMetadata)};`,
  `const verificationRunId = ${JSON.stringify(process.env.VIDEO_PUBLISHER_V2_VERIFICATION_RUN_ID || randomUUID())};`,
].join("\n");
const fragments = [
  header,
  fs.readFileSync(path.join(DIR, "ego", "core.mjs"), "utf8"),
  fs.readFileSync(path.join(DIR, "ego", "semantic-controls.mjs"), "utf8"),
  fs.readFileSync(path.join(DIR, "ego", "persisted-draft.mjs"), "utf8"),
  fs.readFileSync(path.join(DIR, "platforms", platformFiles[platform]), "utf8"),
  platform === 'xiaohongshu' ? fs.readFileSync(path.join(DIR, 'platforms', 'xiaohongshu-persistence.mjs'), 'utf8') : '',
  platform === 'xiaohongshu' ? fs.readFileSync(path.join(DIR, 'platforms', 'xiaohongshu-autosave-recovery.mjs'), 'utf8') : '',
  platform === 'xiaohongshu' ? fs.readFileSync(path.join(DIR, 'platforms', 'xiaohongshu-parking.mjs'), 'utf8') : '',
  platform === 'xiaohongshu' ? fs.readFileSync(path.join(DIR, 'platforms', 'xiaohongshu-reconcile.mjs'), 'utf8') : '',
  platform === 'xiaohongshu' ? fs.readFileSync(path.join(DIR, 'platforms', 'xiaohongshu-readonly.mjs'), 'utf8') : '',
  platform === 'douyin' ? fs.readFileSync(path.join(DIR, 'platforms', 'douyin-persistence.mjs'), 'utf8') : '',
  platform === 'bilibili' ? fs.readFileSync(path.join(DIR, 'platforms', 'bilibili-persistence.mjs'), 'utf8') : '',
  platform === 'wechat_channels' ? fs.readFileSync(path.join(DIR, 'platforms', 'wechat-channels-persistence.mjs'), 'utf8') : '',
  fs.readFileSync(path.join(DIR, "platforms", "dispatch.mjs"), "utf8"),
].join("\n\n");

const publisherLockDirectory = resolvePublisherLockDirectory();
const inheritedPublisherToken = process.env.VIDEO_PUBLISHER_V2_PUBLISHER_LOCK_TOKEN || "";
const releasePublisherLock = inheritedPublisherToken
  ? (assertJobLockOwner(publisherLockDirectory, inheritedPublisherToken), () => {})
  : acquireJobLock(publisherLockDirectory, {
    jobId: `direct-${platform}-${phase}`,
    packagePath,
    scope: "publisher",
  });
const activePublisherToken = inheritedPublisherToken || releasePublisherLock.token;
let releasePlatformLock = () => {};
let execution;
try {
  releasePlatformLock = acquirePlatformLock(platform, phase);
  try {
    execution = platform === 'youtube' ? {
      code: 0, stderr: '', stdout: V2_RESULT_PREFIX + JSON.stringify(await runYoutubeApi({ pkg, phase, packagePath })),
    } : await runEgo(fragments, pid => registerJobLockMember(publisherLockDirectory, activePublisherToken, {
      pid,
      role: `${platform}:${phase}:ego`,
    }));
  } catch (error) {
    execution = { code: 1, stdout: "", stderr: String(error?.stack || error) };
  }
} finally {
  releasePlatformLock();
  releasePublisherLock();
}
const combined = `${execution.stdout}\n${execution.stderr}`;
let result;
try {
  result = parseV2Result(combined, "Ego runner");
} catch (error) {
  const detail = combined.trim().slice(-1600);
  const userControl = /user (?:has|had) taken control|user took control|user is controlling|user controls|用户.*控制|not assigned to an agent|task space.*inactive/i.test(detail);
  if (execution.code === 0 && detail) {
    console.error(detail);
    throw error;
  }
  const failureEvidence = { reason: "ego runner unavailable", exitCode: execution.code, detail };
  const gates = Object.fromEntries(requiredGates(platform).map(name => [name, { ok: false, evidence: failureEvidence }]));
  gates.safety = { ok: false, evidence: { finalPublishClicked: false, guardArmed: false, blockedAttempts: 0 } };
  result = {
    schemaVersion: 1,
    platform,
    phase,
    taskSpaceId: Number(taskSpaceRef) || null,
    observedAt: new Date().toISOString(),
    finalPublishClicked: false,
    gates,
    blocker: {
      code: userControl ? "USER_CONTROL" : "INPUT_CHANNEL_BROKEN",
      message: userControl ? "Ego Lite 任务空间已由用户接管" : "Ego Lite 已退出或无法返回页面证据",
      retryable: !userControl,
      requiresUser: userControl,
      evidence: failureEvidence,
    },
  };
}
console.log(V2_RESULT_PREFIX + JSON.stringify(result));
