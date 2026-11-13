#!/usr/bin/env node
import fs from "node:fs";
import { createHash } from 'node:crypto';
import { requiredGates } from "../lib/model.mjs";
import { persistenceEvidence } from './persistence-fixture.mjs';

const [platform, packagePath, phase, taskSuffix, taskSpaceRaw] = process.argv.slice(2);
const taskSpaceId = Number(process.env.VIDEO_PUBLISHER_V2_MOCK_TASK_SPACE_ID || taskSpaceRaw) || ({ xiaohongshu: 11, douyin: 12, bilibili: 13, wechat_channels: 14, youtube: 15 }[platform]);
const taskSpace = process.env.VIDEO_PUBLISHER_V2_TASK_NAME || `video publisher v2 ${platform} ${taskSuffix}`;
const phaseKey = `${platform}:${phase}`;
const delays = JSON.parse(process.env.VIDEO_PUBLISHER_V2_MOCK_DELAYS || "{}");
const blockers = JSON.parse(process.env.VIDEO_PUBLISHER_V2_MOCK_BLOCKERS || "{}");
const at = Date.now();
if (process.env.VIDEO_PUBLISHER_V2_MOCK_LOG) fs.appendFileSync(process.env.VIDEO_PUBLISHER_V2_MOCK_LOG, JSON.stringify({ at, event: "start", platform, phase, noUpload: process.env.VIDEO_PUBLISHER_V2_NO_UPLOAD, tagRevision: JSON.parse(process.env.VIDEO_PUBLISHER_V2_TAG_REVISION || 'null'), journalPath: process.env.VIDEO_PUBLISHER_V2_DRAFT_SAVE_JOURNAL_PATH }) + "\n");
const delayMs = Number(delays[phaseKey] ?? (["upload_start", "upload"].includes(phase) ? 30 : 0));
if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
const brokenChannel = process.env.VIDEO_PUBLISHER_V2_MOCK_BROKEN_CHANNEL === phaseKey;
const configuredBlocker = blockers[phaseKey] || null;
const gates = Object.fromEntries(requiredGates(platform).map(name => [name, { ok: ["mutate", "persist", "verify"].includes(phase), evidence: {} }]));
const expectedReceipts = JSON.parse(process.env.VIDEO_PUBLISHER_V2_RECEIPTS || "{}");
const packageData = JSON.parse(fs.readFileSync(packagePath, "utf8"));
if (process.env.VIDEO_PUBLISHER_V2_MOCK_EXISTING_READY === "1" && phase === "inspect") {
  for (const name of Object.keys(gates)) gates[name] = { ok: true, evidence: {} };
  if (packageData.cover?.uploadCustomCover === true && !expectedReceipts.cover) {
    gates.cover = { ok: false, evidence: { reason: "desired cover receipt missing" } };
  }
}
gates.authenticated = { ok: true, evidence: {} };
if (process.env.VIDEO_PUBLISHER_V2_NO_UPLOAD === '1' && phase === 'inspect') gates.video = { ok: true, evidence: { stable: true } };
gates.draftIdentity = { ok: true, evidence: {} };
gates.noBlockingDialog = { ok: true, evidence: {} };
gates.finalButton = { ok: true, evidence: { text: "final", disabled: false } };
gates.safety = { ok: true, evidence: { finalPublishClicked: false, guardArmed: true, blockedAttempts: 0 } };
if (phase === "upload") gates.video = { ok: true, evidence: { stable: true } };
if (phase === "upload_start") gates.video = { ok: false, evidence: { uploading: true, failed: false } };
if (phase === "prefill") {
  gates.video = { ok: false, evidence: { uploading: true, failed: false } };
  for (const name of ["title", "description", "tags", "settings"]) {
    if (gates[name]) gates[name] = { ok: true, evidence: {} };
  }
}
if (configuredBlocker?.mockVideoComplete === true) {
  gates.video = { ok: true, evidence: { stable: true, uploading: false, failed: false } };
}
if (configuredBlocker?.code === "AUTH_REQUIRED") gates.authenticated = { ok: false, evidence: { reason: "mock authentication required" } };
if (["UPLOAD_NOT_STARTED", "UPLOAD_STALLED", "PLATFORM_REJECTED_ASSET"].includes(configuredBlocker?.code)) {
  gates.video = { ok: false, evidence: { uploading: configuredBlocker.code === "UPLOAD_STALLED" } };
}
if (brokenChannel) {
  for (const name of Object.keys(gates)) gates[name] = { ok: false, evidence: { reason: "mock input channel broken" } };
  gates.safety = { ok: false, evidence: { finalPublishClicked: false, guardArmed: false, blockedAttempts: 0 } };
}
const fingerprint = process.env.VIDEO_PUBLISHER_V2_FINGERPRINT;
const verificationRunId = process.env.VIDEO_PUBLISHER_V2_VERIFICATION_RUN_ID;
if (!brokenChannel) gates.persistedDraft = { ok: ['persist', 'verify'].includes(phase), evidence: persistenceEvidence(platform, fingerprint, verificationRunId) };
const mockSnapshot = { title: packageData.title, description: 'mock body', descriptionHtml: '<p>mock body</p>',
  videoFileId: 'spectrum/mock-video', transcodeFileId: 'spectrum/mock-transcode', coverFileId: 'spectrum/mock-cover', original: true };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mockCover = { fileid: mockSnapshot.coverFileId, width: 1515, height: 2020 };
if (platform === 'xiaohongshu' && !brokenChannel && ['persist', 'verify'].includes(phase)) {
  gates.title = { ok: true, evidence: { expected: packageData.title, actual: packageData.title } };
  gates.draftIdentity = { ok: true, evidence: { restoredIdentity: { ok: true, draftId: 'draft-test', videoFileId: mockSnapshot.videoFileId } } };
  gates.cover = { ok: true, evidence: { nativeCoverFileId: mockCover.fileid, nativeCover: { ...mockCover }, recordCover: { ...mockCover } } };
  Object.assign(gates.persistedDraft.evidence, { uid: 'mock-owner', snapshotHash: hash(mockSnapshot), storageScope: 'browser-local' });
}
let parked = null, parkedEvidence = null;
if (platform === 'xiaohongshu' && phase === 'park' && !brokenChannel) {
  const context = JSON.parse(process.env.VIDEO_PUBLISHER_V2_XHS_PARKING_CONTEXT || 'null');
  if (!context) throw new Error('Mock parking requires a real host-loaded verify context');
  const editor = context.observation, old = editor.gates.persistedDraft.evidence;
  const now = new Date().toISOString();
  parked = { version: 2, method: 'xhs-draft-list-parked', platform, fingerprint, verificationRunId, taskSpaceId,
    draftId: old.draftId, uid: old.uid, videoFileId: mockSnapshot.videoFileId, snapshotHash: old.snapshotHash,
    coverFileId: mockCover.fileid, coverWidth: mockCover.width, coverHeight: mockCover.height,
    savedAt: old.savedAt, editorVerifiedAt: editor.observedAt, parkedAt: now, readAt: now,
    listUrl: 'https://creator.xiaohongshu.com/publish/publish?target=video',
    parkedUrl: 'https://creator.xiaohongshu.com/publish/publish?target=video',
    listEntryId: old.draftId, visibleRowCount: 1, visibleRowTitle: packageData.title,
    documentChanged: true, oldEditorAbsent: true, parkOnly: context.parkOnly === true,
    editorVerification: { observation: editor, observationHash: context.observationHash,
      evidencePath: context.evidencePath, historical: context.historical === true } };
  for (const name of Object.keys(gates)) delete gates[name];
  gates.authenticated = { ok: true, evidence: { uid: parked.uid } };
  gates.draftIdentity = { ok: true, evidence: { draftId: parked.draftId, uid: parked.uid, videoFileId: parked.videoFileId, snapshotHash: parked.snapshotHash } };
  gates.editorVerified = { ok: true, evidence: { historical: context.historical === true, observationHash: context.observationHash,
    evidencePath: context.evidencePath, verificationRunId: editor.verificationRunId } };
  gates.parkedDraft = { ok: true, evidence: structuredClone(parked) };
  gates.persistedDraft = { ok: true, evidence: parked };
  gates.noActiveEditor = { ok: true, evidence: { oldEditorAbsent: true, documentChanged: true } };
  gates.safety = { ok: true, evidence: { finalPublishClicked: false, guardArmed: true, blockedAttempts: 0 } };
  parkedEvidence = { currentNativeRecord: { id: parked.draftId, uid: parked.uid, snapshot: mockSnapshot }, currentNativeCover: mockCover,
    currentListRows: [{ id: parked.draftId, title: packageData.title, visible: true,
      thumbnailUrls: ['https://cdn.example/spectrum/mock-cover'],
      thumbnailImages: [{ src: 'https://cdn.example/spectrum/mock-cover', complete: true,
        naturalWidth: mockCover.width, naturalHeight: mockCover.height, visible: true, decoded: true }] }],
    currentEditor: { activeId: 'empty-editor', activeVideoFileId: '', activeTitle: '', activeDescription: '', url: parked.parkedUrl } };
}
const result = {
  schemaVersion: 1,
  platform,
  phase,
  taskSpaceId,
  taskSpace,
  observedAt: new Date().toISOString(),
  fingerprint,
  verificationRunId,
  finalPublishClicked: false,
  gates,
  ...(parked ? { surface: 'xhs-draft-list-parked', deliveryKind: 'browser_local_draft', evidence: parkedEvidence } : {}),
  ...(brokenChannel
    ? { blocker: { code: "INPUT_CHANNEL_BROKEN", message: "mock Ego exit", retryable: true, requiresUser: false } }
    : configuredBlocker ? { blocker: configuredBlocker } : {}),
  ...(process.env.VIDEO_PUBLISHER_V2_MOCK_TASK_SPACE_RECREATED === "1" ? { taskSpaceRecovery: { recreated: true, previousTaskSpaceId: taskSpaceId, taskSpaceId } } : {}),
  ...(phase === "upload_start" ? { actions: { upload: { mode: "injected", stage: "editable_uploading", earlyMutationReady: true } }, evidence: { earlyMutation: { ready: true, uploading: true } } } : {}),
  ...(phase === "prefill" ? { actions: { prefill: { completedDuringUpload: true } }, evidence: { earlyMutation: { ready: true, uploading: true } } } : {}),
  ...(phase === "mutate" ? { receipts: { cover: { mock: true, taskSpaceId } } } : {}),
};
if (process.env.VIDEO_PUBLISHER_V2_MOCK_LOG) fs.appendFileSync(process.env.VIDEO_PUBLISHER_V2_MOCK_LOG, JSON.stringify({ at: Date.now(), event: "end", platform, phase }) + "\n");
console.log("VIDEO_PUBLISHER_V2_RESULT:" + JSON.stringify(result));
