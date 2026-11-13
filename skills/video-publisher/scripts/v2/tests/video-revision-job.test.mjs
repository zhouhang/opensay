import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPackage } from '../../lib/content-package.mjs';
import { buildIdentity } from '../lib/identity.mjs';
import { JobStore } from '../lib/job-store.mjs';
import { beginDraftSave, confirmDraftSave } from '../lib/draft-save-journal.mjs';
import { prepareVideoRevisionJob, videoRevisionContext, videoRevisionDraftJournalPath,
  videoRevisionReceiptCheckpointPath } from '../lib/video-revision-job.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
function mp4(seconds) {
  const box = (type, payload) => { const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(b.length); b.write(type, 4); payload.copy(b, 8); return b; };
  const mvhd = Buffer.alloc(20); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(seconds * 1000, 16);
  return Buffer.concat([box('ftyp', Buffer.alloc(4)), box('moov', box('mvhd', mvhd))]);
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-revision-job-'));
  const prev = process.env.VIDEO_PUBLISHER_CONFIG;
  t.after(() => { if (prev === undefined) delete process.env.VIDEO_PUBLISHER_CONFIG; else process.env.VIDEO_PUBLISHER_CONFIG = prev; fs.rmSync(root, { recursive: true, force: true }); });
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, onboarding: { completed: true }, sourceDirectory: root,
    availablePlatforms: ['bilibili', 'wechat_channels', 'youtube', 'xiaohongshu'], defaultPlatforms: ['bilibili'], declarations: { originalityPolicy: 'all_videos_original' } }));
  process.env.VIDEO_PUBLISHER_CONFIG = configPath;
  const oldFile = path.join(root, 'approved-original.mp4'), newFile = path.join(root, 'approved-new-audio.mp4');
  fs.writeFileSync(oldFile, mp4(30)); fs.writeFileSync(newFile, mp4(31));
  const originalPath = path.join(root, 'original.json'), nextPath = path.join(root, 'next.json');
  const oldRaw = { videoPath: oldFile, title: 'Approved unchanged title', description: 'Exact approved prose', tags: ['AI'], cover: { uploadCustomCover: false } };
  fs.writeFileSync(originalPath, JSON.stringify(oldRaw)); fs.writeFileSync(nextPath, JSON.stringify({ ...oldRaw, videoPath: newFile }));
  const previous = await buildIdentity(readPackage(originalPath)), pkg = readPackage(nextPath), identity = await buildIdentity(pkg);
  const store = new JobStore(path.join(root, 'original-job'), { schemaVersion: 4, jobId: 'original-job', status: 'blocked', packagePath: originalPath,
    ...previous, platforms: { bilibili: { taskSpaceId: 72, taskSpaceName: 'original Bilibili space', status: 'needs_persistence',
      videoReceipt: { fingerprint: previous.fingerprint, mode: 'injected', taskSpaceId: 72 }, receipts: { uploadStart: { fingerprint: previous.fingerprint } }, history: [] },
      youtube: { taskSpaceId: null, status: 'ready', receipts: { untouched: true }, verdict: { ready: true, verificationVersion: 2 }, history: [] } } });
  const state = await store.initialize();
  const sourceJournal = `${store.receiptCheckpointPath('bilibili')}.draft-save.json`;
  const plan = { id: 'original-native-id', title: oldRaw.title, videoName: path.basename(oldFile), videoStem: 'approved-original', beforeIds: ['original-native-id'],
    url: 'https://member.bilibili.com/platform/upload/video/frame?type=draft&draftId=original-native-id', listUrl: 'https://member.bilibili.com/platform/upload-manager/article?group=draft' };
  const journalIdentity = { platform: 'bilibili', fingerprint: previous.fingerprint };
  const attempt = beginDraftSave(sourceJournal, journalIdentity, plan), now = new Date().toISOString();
  confirmDraftSave(sourceJournal, journalIdentity, attempt.attemptId, now);
  const proof = { version: 2, platform: 'bilibili', fingerprint: previous.fingerprint, verificationRunId: 'source-verify', savedAt: now, readAt: now,
    method: 'draft-list-reopen', documentChanged: true, draftId: plan.id, listEntryId: plan.id, reopenedId: plan.id,
    listUrl: plan.listUrl, reopenedUrl: plan.url, lookup: { title: plan.title, videoName: plan.videoName, videoStem: plan.videoStem, beforeIds: plan.beforeIds } };
  const sourceEvidence = path.join(store.evidenceDir, 'immutable-verify.json');
  fs.writeFileSync(sourceEvidence, JSON.stringify({ observation: { platform: 'bilibili', phase: 'verify', fingerprint: previous.fingerprint,
    verificationRunId: proof.verificationRunId, observedAt: now, taskSpaceId: 72, finalPublishClicked: false,
    gates: { video: { ok: true }, draftIdentity: { ok: true }, persistedDraft: { ok: true, evidence: proof } } } }));
  state.platforms.bilibili.history = [{ phase: 'verify', evidencePath: sourceEvidence }];
  const lastInspect = path.join(store.evidenceDir, 'current-inspect.json'); fs.writeFileSync(lastInspect, JSON.stringify({ observation: { phase: 'inspect', gates: {} } }));
  state.platforms.bilibili.lastEvidencePath = lastInspect;
  fs.writeFileSync(store.receiptCheckpointPath('bilibili'), JSON.stringify({ original: true }));
  await store.save();
  const args = { platforms: ['bilibili'], packagePath: nextPath };
  return { root, configPath, store, state, pkg, identity, previous, args, originalPath, nextPath, oldRaw, oldFile, newFile,
    sourceJournal, sourceEvidence, input: () => ({ store, state, pkg, identity, args }) };
}

test('video revision binds immutable independent source after a read-only inspect downgrade and preserves original journals/siblings', async t => {
  const f = await fixture(t), source = fs.readFileSync(f.sourceJournal), oldCheckpoint = fs.readFileSync(f.store.receiptCheckpointPath('bilibili'));
  const sibling = structuredClone(f.state.platforms.youtube), oldUpload = structuredClone(f.state.platforms.bilibili.videoReceipt);
  const r = await prepareVideoRevisionJob(f.input());
  assert.equal(r.sources.bilibili.sourceDraftId, 'original-native-id');
  assert.equal(r.sources.bilibili.sourceEvidencePath, f.sourceEvidence);
  assert.equal(f.state.platforms.bilibili.videoReceipt, null, 'old upload receipt must not be relabeled as new-video proof');
  assert.deepEqual(r.sources.bilibili.sourceVideoReceipt, oldUpload);
  assert.deepEqual(f.state.platforms.youtube, sibling);
  assert.equal(f.state.platformFingerprints.youtube, f.previous.fingerprint);
  assert.equal(f.state.platformPackagePaths.youtube, f.originalPath);
  assert.equal(f.state.platformPackagePaths.bilibili, f.nextPath);
  assert.deepEqual(fs.readFileSync(f.sourceJournal), source);
  assert.deepEqual(fs.readFileSync(f.store.receiptCheckpointPath('bilibili')), oldCheckpoint);
  assert.match(videoRevisionDraftJournalPath(f.store, f.state, 'bilibili'), /\.video-.+\.draft-save\.json$/);
  assert.match(videoRevisionReceiptCheckpointPath(f.store, f.state, 'bilibili'), /\.video-.+\.json$/);
  assert.equal(videoRevisionContext(f.state, 'youtube'), null);
  const before = structuredClone(f.state); f.store.save = async () => { throw new Error('replay wrote'); };
  await prepareVideoRevisionJob(f.input()); assert.deepEqual(f.state, before);
});

test('video revision refuses changed approved copy, missing originals, same bytes, forged source and unsupported platforms before source mutations', async t => {
  const f = await fixture(t), original = fs.readFileSync(f.sourceJournal);
  for (const patch of [{ title: 'Changed title' }, { tags: ['Changed'] }, { description: 'Changed body' }, { videoPath: f.oldFile }]) {
    fs.writeFileSync(f.nextPath, JSON.stringify({ ...f.oldRaw, videoPath: f.newFile, ...patch }));
    const pkg = readPackage(f.nextPath), identity = await buildIdentity(pkg);
    await assert.rejects(prepareVideoRevisionJob({ ...f.input(), pkg, identity }), /may change only|different source video bytes/);
    assert.equal(f.state.fingerprint, f.previous.fingerprint);
  }
  await assert.rejects(prepareVideoRevisionJob({ ...f.input(), args: { ...f.args, platforms: ['youtube'] } }), /ORIGINAL_VIDEO_REPLACEMENT_UNSUPPORTED/);
  fs.writeFileSync(f.sourceEvidence, JSON.stringify({ observation: { phase: 'verify', gates: { video: { ok: true } } } }));
  await assert.rejects(prepareVideoRevisionJob(f.input()), /immutable independent verify evidence/);
  assert.deepEqual(fs.readFileSync(f.sourceJournal), original);
});

test('crash after durable video revision intent replays the same native resource without rewriting source proof', async t => {
  const f = await fixture(t), save = f.store.save.bind(f.store);
  f.store.save = async () => { await save(); if (f.state.videoRevisionIntent) throw new Error('crash after source intent'); };
  await assert.rejects(prepareVideoRevisionJob(f.input()), /crash after source intent/);
  const restored = new JobStore(f.store.jobDir, { fingerprint: null }), state = await restored.initialize();
  assert.ok(state.videoRevisionIntent); assert.equal(state.fingerprint, f.previous.fingerprint);
  await prepareVideoRevisionJob({ ...f.input(), store: restored, state });
  assert.equal(state.fingerprint, f.identity.fingerprint); assert.equal(state.videoRevisionIntent, undefined);
  assert.equal(state.revisions.length, 1); assert.equal(state.videoRevision.sources.bilibili.sourceDraftId, 'original-native-id');
});

test('a later XHS sibling revision binds its original media/account while preserving an already replaced Bilibili draft', async t => {
  const f = await fixture(t);
  const oldAuthorization = process.env.VIDEO_PUBLISHER_VIDEO_REPLACEMENT_AUTHORIZATION_PATH;
  t.after(() => { if (oldAuthorization === undefined) delete process.env.VIDEO_PUBLISHER_VIDEO_REPLACEMENT_AUTHORIZATION_PATH;
    else process.env.VIDEO_PUBLISHER_VIDEO_REPLACEMENT_AUTHORIZATION_PATH = oldAuthorization; });
  const source = structuredClone(f.state.platforms.bilibili);
  source.taskSpaceId = 71; source.taskSpaceName = 'original XHS space'; source.history = [];
  f.state.platforms.xiaohongshu = source;
  const identity = { platform: 'xiaohongshu', fingerprint: f.previous.fingerprint };
  const plan = { id: 'original-xhs-uuid', uid: 'original-user', videoFileId: 'spectrum/original-video', snapshotHash: 'c'.repeat(64),
    url: 'https://creator.xiaohongshu.com/publish/publish?target=video', listUrl: 'https://creator.xiaohongshu.com/publish/publish?target=video' };
  const journal = `${f.store.receiptCheckpointPath('xiaohongshu')}.draft-save.json`;
  const attempt = beginDraftSave(journal, identity, plan), saved = new Date().toISOString(); confirmDraftSave(journal, identity, attempt.attemptId, saved);
  const proof = { version: 2, platform: identity.platform, fingerprint: identity.fingerprint, method: 'draft-list-reopen', documentChanged: true,
    verificationRunId: 'old-xhs-run', savedAt: saved, readAt: saved, draftId: plan.id, listEntryId: plan.id, reopenedId: plan.id,
    listUrl: plan.listUrl, reopenedUrl: plan.url, uid: plan.uid, snapshotHash: plan.snapshotHash, storageScope: 'browser-local' };
  const evidence = path.join(f.store.evidenceDir, 'old-xhs-independent-verify.json');
  fs.writeFileSync(evidence, JSON.stringify({ observation: { platform: 'xiaohongshu', phase: 'verify', fingerprint: identity.fingerprint,
    verificationRunId: proof.verificationRunId, taskSpaceId: 71, observedAt: saved, finalPublishClicked: false,
    gates: { video: { ok: true }, draftIdentity: { ok: true }, persistedDraft: { ok: true, evidence: proof } } } }));
  source.lastEvidencePath = evidence; source.history = [{ phase: 'verify', evidencePath: evidence }];
  await f.store.save();
  await prepareVideoRevisionJob(f.input());
  const replacedBili = structuredClone(f.state.platforms.bilibili);
  const authFile = path.join(f.root, 'user-authorized-original-xhs-replacement.json');
  fs.writeFileSync(authFile, JSON.stringify({ version: 1, kind: 'user_attested_original_draft_replacement', platform: 'xiaohongshu',
    statement: '尚未发布，只更新原草稿', authorizationSource: { type: 'direct-human-message', answer: '尚未发布，只更新原草稿' },
    attestedAt: new Date().toISOString(), jobId: f.state.jobId, sourceFingerprint: identity.fingerprint, sourceTaskSpaceId: 71,
    sourceTaskSpaceName: source.taskSpaceName, uid: plan.uid, sourceDraftId: plan.id, sourceVideoFileId: plan.videoFileId,
    nextVideoSha256: f.identity.video.sha256, allowMissingOriginalTaskSpaceRecovery: true }));
  process.env.VIDEO_PUBLISHER_VIDEO_REPLACEMENT_AUTHORIZATION_PATH = authFile;
  const before = fs.readFileSync(journal);
  const r = await prepareVideoRevisionJob({ ...f.input(), args: { ...f.args, platforms: ['xiaohongshu'] } });
  assert.deepEqual(f.state.platforms.bilibili, replacedBili);
  assert.deepEqual(fs.readFileSync(journal), before);
  assert.equal(r.sources.xiaohongshu.sourceVideoIdentity.sha256, f.previous.video.sha256);
  assert.equal(r.sources.xiaohongshu.sourceUid, plan.uid);
  assert.equal(r.sources.xiaohongshu.sourceVideoFileId, plan.videoFileId);
  assert.equal(videoRevisionContext(f.state, 'xiaohongshu').nextVideoIdentity.sha256, f.identity.video.sha256);
  assert.equal(r.sources.bilibili.sourceDraftId, 'original-native-id');
});

test('maintained publisher executes only original-draft replacement, save and independent verification; exact replay does not inject again', async t => {
  const f = await fixture(t), events = path.join(f.root, 'events.jsonl'), runner = path.join(f.root, 'runner.mjs');
  const modulePath = name => new URL(`../lib/${name}.mjs`, import.meta.url).href;
  fs.writeFileSync(runner, `import fs from 'node:fs'; import path from 'node:path';
import { requiredGates } from ${JSON.stringify(modulePath('model'))};
import { beginVideoReplacement, confirmVideoReplacement, readVideoReplacementJournal } from ${JSON.stringify(modulePath('video-replacement-journal'))};
import { beginDraftSave, confirmDraftSave, readDraftSaveJournal } from ${JSON.stringify(modulePath('draft-save-journal'))};
const [platform,pkgPath,phase,,space]=process.argv.slice(2), pkg=JSON.parse(fs.readFileSync(pkgPath)), r=JSON.parse(process.env.VIDEO_PUBLISHER_V2_VIDEO_REVISION);
const fingerprint=process.env.VIDEO_PUBLISHER_V2_FINGERPRINT, identity={platform,fingerprint}, now=new Date().toISOString(), stat=fs.statSync(pkg.videoPath), file=process.env.VIDEO_PUBLISHER_V2_VIDEO_REPLACEMENT_JOURNAL_PATH;
fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({phase,pkgPath,space,checkpoint:process.env.VIDEO_PUBLISHER_V2_CHECKPOINT_PATH})+'\\n');
let j=readVideoReplacementJournal(file,identity);
if(!j){const p={sourceDraftId:r.sourceDraftId,sourceTaskSpaceId:Number(space),sourceNativeFileIds:['old-native-file'],sourceVideoSha256:r.sourceVideoIdentity.sha256,nextVideoSha256:r.nextVideoIdentity.sha256,sourceMetadataHash:'c'.repeat(64),sourceCoverHash:'d'.repeat(64),originalDraftVerified:true,liveSourceDraftId:r.sourceDraftId,nextVideoPath:pkg.videoPath,nextVideoSize:stat.size,nextVideoMtimeMs:Math.trunc(stat.mtimeMs)};
j=beginVideoReplacement(file,identity,p);fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({event:'input-injected',attempt:j.attemptId})+'\\n');
j=confirmVideoReplacement(file,identity,j.attemptId,{sourceDraftId:p.sourceDraftId,draftId:p.sourceDraftId,sourceTaskSpaceId:p.sourceTaskSpaceId,sourceNativeFileIds:p.sourceNativeFileIds,sourceVideoSha256:p.sourceVideoSha256,nextVideoSha256:p.nextVideoSha256,nativeFileIds:['new-native-file'],sourceMetadataHash:p.sourceMetadataHash,currentMetadataHash:p.sourceMetadataHash,sourceCoverHash:p.sourceCoverHash,currentCoverHash:p.sourceCoverHash,metadataUnchanged:true,coversUnchanged:true,uploadComplete:true,localFile:{path:pkg.videoPath,size:stat.size,lastModified:Math.trunc(stat.mtimeMs),sha256:p.nextVideoSha256},observedAt:now});}
const gates=Object.fromEntries(requiredGates(platform).map(name=>[name,{ok:true,evidence:{}}]));gates.replaceVideo={ok:true,evidence:j.evidence};
gates.video.evidence.replacement=j.evidence;gates.safety.evidence={finalPublishClicked:false,guardArmed:true,blockedAttempts:0};
const saveFile=process.env.VIDEO_PUBLISHER_V2_DRAFT_SAVE_JOURNAL_PATH;let s=readDraftSaveJournal(saveFile,identity);
if(phase==='persist'&&!s){const old=r.sourcePersistedDraft,plan={id:r.sourceDraftId,url:old.reopenedUrl,listUrl:old.listUrl,title:pkg.title,videoName:path.basename(pkg.videoPath),videoStem:path.basename(pkg.videoPath,'.mp4'),beforeIds:[r.sourceDraftId],videoRevision:{sourceDraftId:r.sourceDraftId}};s=beginDraftSave(saveFile,identity,plan);s=confirmDraftSave(saveFile,identity,s.attemptId,new Date().toISOString());}
gates.persistedDraft={ok:phase!=='replace_video',evidence:s?{version:2,platform,fingerprint,verificationRunId:process.env.VIDEO_PUBLISHER_V2_VERIFICATION_RUN_ID,savedAt:s.savedAt,readAt:new Date().toISOString(),draftId:r.sourceDraftId,listEntryId:r.sourceDraftId,reopenedId:r.sourceDraftId,method:'draft-list-reopen',documentChanged:true,listUrl:s.plan.listUrl,reopenedUrl:s.plan.url,lookup:s.plan}:null};
console.log('VIDEO_PUBLISHER_V2_RESULT:'+JSON.stringify({platform,phase,fingerprint,verificationRunId:process.env.VIDEO_PUBLISHER_V2_VERIFICATION_RUN_ID,taskSpaceId:Number(space),taskSpace:process.env.VIDEO_PUBLISHER_V2_TASK_NAME,observedAt:new Date().toISOString(),finalPublishClicked:false,gates}));`);
  const env = { ...process.env, VIDEO_PUBLISHER_CONFIG: f.configPath, VIDEO_PUBLISHER_V2_RUNNER: runner,
    VIDEO_PUBLISHER_V2_LOCK_ROOT: path.join(f.root, 'locks'), VIDEO_PUBLISHER_DRAFTBOX_LEDGER_PATH: path.join(f.root, 'ledger.json') };
  const args = [path.join(dir, '..', 'publisher.mjs'), '--package', f.nextPath, '--job-id', 'original-job', '--state-root', f.root,
    '--platforms', 'bilibili', '--operation', 'replace-video', '--no-cleanup-stale-spaces'];
  const sourceBytes = fs.readFileSync(f.sourceJournal);
  const first = spawnSync(process.execPath, args, { env, encoding: 'utf8' }); assert.equal(first.status, 0, first.stderr + first.stdout);
  const current = JSON.parse(fs.readFileSync(f.store.statePath));
  assert.equal(current.platforms.bilibili.verdict.ready, true); assert.equal(current.platforms.bilibili.taskSpaceId, 72);
  assert.equal(current.platforms.bilibili.videoReceipt.sha256, f.identity.video.sha256);
  assert.deepEqual(fs.readFileSync(f.sourceJournal), sourceBytes);
  const rows = fs.readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.filter(e => e.phase).map(e => e.phase), ['replace_video', 'persist', 'verify']);
  assert.equal(rows.filter(e => e.event === 'input-injected').length, 1);
  const repeat = spawnSync(process.execPath, args, { env, encoding: 'utf8' }); assert.equal(repeat.status, 0, repeat.stderr + repeat.stdout);
  assert.equal(fs.readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.event === 'input-injected').length, 1);
  assert.deepEqual(fs.readFileSync(f.sourceJournal), sourceBytes);
});
