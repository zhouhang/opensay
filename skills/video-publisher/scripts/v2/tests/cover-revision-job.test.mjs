import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPackage } from '../../lib/content-package.mjs';
import { buildIdentity } from '../lib/identity.mjs';
import { JobStore } from '../lib/job-store.mjs';
import { beginDraftSave, confirmDraftSave } from '../lib/draft-save-journal.mjs';
import { prepareXhsCoverRevisionJob, coverRevisionContext, coverRevisionPlatformFingerprint,
  coverRevisionReceiptCheckpointPath, coverRevisionDraftJournalPath,
  loadCoverRevisionReceiptCheckpoint, isXhsNativeCoverRevision, isBrowserCoverRevision, prepareBrowserCoverRevisionJob } from '../lib/cover-revision-job.mjs';

let suiteRoot;
let previousConfig;
const platforms = ['xiaohongshu', 'wechat_channels', 'bilibili', 'youtube'];
const hash = value => createHash('sha256').update(value).digest('hex');
before(() => {
  suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-revision-job-suite-'));
  const configPath = path.join(suiteRoot, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, availablePlatforms: platforms,
    defaultPlatforms: platforms, sourceDirectory: suiteRoot, onboarding: { completed: true },
    declarations: { originalityPolicy: 'all_videos_original' } }));
  previousConfig = process.env.VIDEO_PUBLISHER_CONFIG;
  process.env.VIDEO_PUBLISHER_CONFIG = configPath;
});
after(() => {
  if (previousConfig === undefined) delete process.env.VIDEO_PUBLISHER_CONFIG;
  else process.env.VIDEO_PUBLISHER_CONFIG = previousConfig;
  fs.rmSync(suiteRoot, { recursive: true, force: true });
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(suiteRoot, 'job-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const videoPath = path.join(root, 'approved.mp4');
  fs.writeFileSync(videoPath, 'exact approved video bytes');
  const cover = { uploadCustomCover: true };
  for (const key of ['vertical3x4Path', 'horizontal4x3Path', 'horizontal16x9Path']) {
    cover[key] = path.join(root, `${key}.png`);
    fs.writeFileSync(cover[key], `exact approved ${key} bytes`);
  }
  const originalPath = path.join(root, 'original.json');
  const nextPath = path.join(root, 'corrected.json');
  const originalRaw = { title: 'Approved title', description: 'Exact approved description', videoPath,
    tags: ['AI'], xhsTopics: ['AI'], bilibiliTags: ['AI'], wechatTags: ['AI'], youtubeTags: ['AI'],
    youtubeVisibility: 'private', youtubeAudience: 'not_made_for_kids', youtubeCategory: '28', cover };
  const nextRaw = structuredClone(originalRaw);
  nextRaw.cover.platforms = { xiaohongshu: { nativeRatio: '4:3' } };
  fs.writeFileSync(originalPath, JSON.stringify(originalRaw));
  fs.writeFileSync(nextPath, JSON.stringify(nextRaw));
  const priorPkg = readPackage(originalPath);
  const pkg = readPackage(nextPath);
  const priorIdentity = await buildIdentity(priorPkg);
  const identity = await buildIdentity(pkg);
  const store = new JobStore(path.join(root, 'original-job'), { schemaVersion: 4, jobId: 'original-job',
    status: 'ready', packagePath: originalPath, ...priorIdentity, platforms: {}, revisions: [] });
  const state = await store.initialize();
  for (const [index, platform] of platforms.entries()) {
    state.platforms[platform] = { status: 'ready', taskSpaceId: platform === 'youtube' ? null : index + 31,
      taskSpaceName: `original ${platform} space`, receipts: { cover: { assetPath: cover.vertical3x4Path,
        ratio: '3:4', afterUrl: 'https://ros-preview.xhscdn.com/spectrum/original-cover' },
        uploadStart: { fingerprint: priorIdentity.fingerprint, original: true } },
      videoReceipt: { fingerprint: priorIdentity.fingerprint, taskSpaceId: platform === 'youtube' ? null : index + 31 },
      verdict: { ready: true, verificationVersion: 2 }, history: [] };
    fs.writeFileSync(store.receiptCheckpointPath(platform), JSON.stringify({ schemaVersion: 2, platform,
      fingerprint: priorIdentity.fingerprint, taskSpaceId: state.platforms[platform].taskSpaceId,
      receipts: state.platforms[platform].receipts }), { mode: 0o600 });
  }
  const journalPaths = {}, evidencePaths = {}, proofs = {}, observations = {};
  for (const platform of ['xiaohongshu', 'bilibili', 'wechat_channels']) {
    const journalPath = `${store.receiptCheckpointPath(platform)}.draft-save.json`;
    const snapshotHash = hash('exact original native snapshot');
    const nativeId = `original-native-${platform}-id`;
    const origin = { xiaohongshu: 'https://creator.xiaohongshu.com', bilibili: 'https://member.bilibili.com', wechat_channels: 'https://channels.weixin.qq.com' }[platform];
    const lookup = platform === 'bilibili' ? { title: originalRaw.title, videoName: path.basename(videoPath), videoStem: 'approved', beforeIds: [] }
      : { description: originalRaw.description, beforeIds: [] };
    const plan = { id: nativeId, url: `${origin}/editor`, listUrl: `${origin}/draft-list`,
      ...(platform === 'xiaohongshu' ? { uid: 'original-account', videoFileId: 'original-video-file-id', snapshotHash } : lookup) };
    const journalIdentity = { platform, fingerprint: priorIdentity.fingerprint };
    const attempt = beginDraftSave(journalPath, journalIdentity, plan);
    const savedAt = new Date().toISOString();
    confirmDraftSave(journalPath, journalIdentity, attempt.attemptId, savedAt);
    const readAt = new Date().toISOString();
    const proof = { version: 2, platform, fingerprint: priorIdentity.fingerprint,
      verificationRunId: `original-verify-run-${platform}`, savedAt, readAt, method: 'draft-list-reopen',
      draftId: nativeId, listEntryId: nativeId, reopenedId: nativeId, documentChanged: true,
      listUrl: plan.listUrl, reopenedUrl: plan.url,
      ...(platform === 'xiaohongshu' ? { storageScope: 'browser-local', uid: plan.uid, snapshotHash } : { lookup }) };
    const evidencePath = path.join(store.evidenceDir, `original-proof-${platform}.json`);
    const observation = { platform, fingerprint: priorIdentity.fingerprint,
      verificationRunId: proof.verificationRunId, observedAt: readAt, taskSpaceId: state.platforms[platform].taskSpaceId,
      finalPublishClicked: false, gates: { video: { ok: true }, draftIdentity: { ok: true },
        persistedDraft: { ok: true, evidence: proof } } };
    fs.writeFileSync(evidencePath, JSON.stringify({ observation }), { mode: 0o600 });
    state.platforms[platform].lastEvidencePath = evidencePath;
    state.platforms[platform].history.push({ phase: 'verify', evidencePath });
    journalPaths[platform] = journalPath; evidencePaths[platform] = evidencePath;
    proofs[platform] = proof; observations[platform] = observation;
    if (platform === 'bilibili') state.platforms[platform].receipts.cover = { assetPath: cover.horizontal4x3Path, afterUrl: `${origin}/old-cover`, ratio: '4:3' };
    if (platform === 'wechat_channels') state.platforms[platform].receipts.cover = { layout: 'separate', slots: {
      vertical: { assetPath: cover.vertical3x4Path, ratio: '3:4', afterUrl: `${origin}/old-portrait-cover` },
      horizontal: { assetPath: cover.horizontal4x3Path, ratio: '4:3', afterUrl: `${origin}/old-landscape-cover` } } };
  }
  const journalPath = journalPaths.xiaohongshu, evidencePath = evidencePaths.xiaohongshu;
  const proof = proofs.xiaohongshu, observation = observations.xiaohongshu;
  const youtubeCheckpoint = `${store.receiptCheckpointPath('youtube')}.youtube-api.json`;
  fs.writeFileSync(youtubeCheckpoint, JSON.stringify({ fingerprint: priorIdentity.fingerprint,
    videoId: 'original-private-video', thumbnailUploadedAt: 'unchanged' }), { mode: 0o600 });
  await store.save();
  const args = { packagePath: nextPath, platforms: ['xiaohongshu'] };
  return { root, store, state, priorPkg, priorIdentity, pkg, identity, originalPath, nextPath, originalRaw, nextRaw,
    args, proof, observation, evidencePath, journalPath, youtubeCheckpoint, journalPaths, evidencePaths, proofs, observations,
    input: () => ({ store, state, pkg, identity, args }) };
}

test('native cover revision preserves all original journals/checkpoints and every unselected platform object', async t => {
  const f = await fixture(t);
  const untouched = Object.fromEntries(platforms.filter(p => p !== 'xiaohongshu').map(p => [p, structuredClone(f.state.platforms[p])]));
  const originalFiles = [f.journalPath, f.youtubeCheckpoint, ...platforms.map(p => f.store.receiptCheckpointPath(p))];
  const bytes = originalFiles.map(file => fs.readFileSync(file));
  const revision = await prepareXhsCoverRevisionJob(f.input());
  assert.equal(f.state.fingerprint, f.identity.fingerprint);
  assert.equal(f.state.packagePath, f.nextPath);
  assert.equal(f.state.coverRevisionIntent, undefined);
  assert.deepEqual(f.state.coverRevision, revision);
  assert.equal(f.state.platforms.xiaohongshu.receipts.cover, undefined);
  assert.equal(f.state.platforms.xiaohongshu.status, 'needs_mutation');
  assert.equal(f.state.platforms.xiaohongshu.videoReceipt.fingerprint, f.identity.fingerprint);
  assert.equal(revision.sources.xiaohongshu.sourceVideoFileId, 'original-video-file-id');
  assert.equal(revision.sources.xiaohongshu.sourceDraftId, f.proof.draftId);
  for (const [platform, value] of Object.entries(untouched)) {
    assert.deepEqual(f.state.platforms[platform], value);
    assert.equal(coverRevisionPlatformFingerprint(f.state, platform), f.priorIdentity.fingerprint);
    assert.equal(coverRevisionContext(f.state, platform), null);
  }
  originalFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), bytes[index]));
  assert.equal(f.state.revisions.length, 1);
});

test('durable cover intent survives a crash before identity commit and replays using the same source without evidence rereads', async t => {
  const f = await fixture(t);
  const realSave = f.store.save.bind(f.store);
  f.store.save = async () => {
    await realSave();
    if (f.state.coverRevisionIntent) throw new Error('fixture crash after durable intent');
  };
  await assert.rejects(prepareXhsCoverRevisionJob(f.input()), /fixture crash/);
  const disk = JSON.parse(fs.readFileSync(f.store.statePath));
  assert.equal(disk.fingerprint, f.priorIdentity.fingerprint);
  assert.equal(disk.platforms.xiaohongshu.status, 'ready');
  assert.ok(disk.coverRevisionIntent);
  fs.unlinkSync(f.evidencePath);
  const restored = new JobStore(f.store.jobDir, { fingerprint: null });
  const state = await restored.initialize();
  const revision = await prepareXhsCoverRevisionJob({ store: restored, state, pkg: f.pkg, identity: f.identity, args: f.args });
  assert.deepEqual(revision, disk.coverRevisionIntent);
  assert.equal(state.revisions.length, 1);
  assert.equal(state.platforms.xiaohongshu.taskSpaceId, 31);
  assert.equal(state.coverRevisionIntent, undefined);
  assert.equal(state.fingerprint, f.identity.fingerprint);
});

test('crash at the final state commit leaves replayable intent rather than an invalidated original draft', async t => {
  const f = await fixture(t);
  const realSave = f.store.save.bind(f.store);
  let calls = 0;
  f.store.save = async () => {
    if (++calls === 2) throw new Error('fixture commit failure');
    return realSave();
  };
  await assert.rejects(prepareXhsCoverRevisionJob(f.input()), /commit failure/);
  const disk = JSON.parse(fs.readFileSync(f.store.statePath));
  assert.equal(disk.fingerprint, f.priorIdentity.fingerprint);
  assert.equal(disk.platforms.xiaohongshu.verdict.ready, true);
  const restored = new JobStore(f.store.jobDir, { fingerprint: null });
  const state = await restored.initialize();
  await prepareXhsCoverRevisionJob({ store: restored, state, pkg: f.pkg, identity: f.identity, args: f.args });
  assert.equal(state.fingerprint, f.identity.fingerprint);
  assert.equal(state.revisions.length, 1);
});

test('exact committed revision replay is idempotent before READY checks and preserves new accepted receipts', async t => {
  const f = await fixture(t);
  const revision = await prepareXhsCoverRevisionJob(f.input());
  f.state.platforms.xiaohongshu.receipts.cover = { version: 2, assetPath: f.pkg.cover.horizontal4x3Path,
    ratio: '4:3', afterUrl: 'https://ros-preview.xhscdn.com/spectrum/new-cover' };
  for (const status of ['blocked', 'running', 'ready']) {
    f.state.status = status;
    const before = structuredClone(f.state);
    f.store.save = async () => { throw new Error('idempotent replay must not write state'); };
    assert.deepEqual(await prepareXhsCoverRevisionJob(f.input()), revision);
    assert.deepEqual(f.state, before);
  }
});

test('a crash after the committed state write reopens the same revision without duplicating migration', async t => {
  const f = await fixture(t);
  const realSave = f.store.save.bind(f.store);
  let calls = 0;
  f.store.save = async () => {
    await realSave();
    if (++calls === 2) throw new Error('fixture crash after committed state write');
  };
  await assert.rejects(prepareXhsCoverRevisionJob(f.input()), /crash after committed/);
  const restored = new JobStore(f.store.jobDir, { fingerprint: f.identity.fingerprint });
  const state = await restored.initialize();
  const before = fs.readFileSync(restored.statePath);
  restored.save = async () => { throw new Error('committed replay must not save again'); };
  const revision = await prepareXhsCoverRevisionJob({ store: restored, state, pkg: f.pkg, identity: f.identity, args: f.args });
  assert.deepEqual(revision, state.coverRevision);
  assert.equal(state.revisions.length, 1);
  assert.deepEqual(fs.readFileSync(restored.statePath), before);
});

test('unfinished cover intent rejects package-path, metadata or task-target mismatches without commit', async t => {
  const f = await fixture(t);
  const realSave = f.store.save.bind(f.store);
  f.store.save = async () => { await realSave(); throw new Error('fixture intent-only'); };
  await assert.rejects(prepareXhsCoverRevisionJob(f.input()), /intent-only/);
  const original = fs.readFileSync(f.store.statePath);
  for (const args of [
    { ...f.args, packagePath: `${f.nextPath}.other` },
    { ...f.args, platforms: ['xiaohongshu', 'bilibili'] },
    { ...f.args, forceFreshSpace: true },
  ]) {
    await assert.rejects(prepareXhsCoverRevisionJob({ ...f.input(), args }), /conflicts|only the existing|original task space/);
    assert.deepEqual(fs.readFileSync(f.store.statePath), original);
  }
  await assert.rejects(prepareXhsCoverRevisionJob({ ...f.input(), identity: { ...f.identity, contentFingerprint: 'foreign' } }), /conflicts/);
});

test('missing original independent persistence evidence blocks migration before any intent write', async t => {
  const f = await fixture(t);
  fs.unlinkSync(f.evidencePath);
  await assert.rejects(prepareXhsCoverRevisionJob(f.input()), /cannot prove the original saved UUID/);
  assert.equal(f.state.coverRevisionIntent, undefined);
  assert.equal(f.state.fingerprint, f.priorIdentity.fingerprint);
});

for (const field of ['draftId', 'uid', 'snapshotHash']) {
  test(`cover source ${field} must exactly match its original confirmed save journal`, async t => {
    const f = await fixture(t);
    f.observation.gates.persistedDraft.evidence[field] = field === 'snapshotHash' ? hash('foreign snapshot') : 'foreign';
    fs.writeFileSync(f.evidencePath, JSON.stringify({ observation: f.observation }));
    await assert.rejects(prepareXhsCoverRevisionJob(f.input()), /cannot prove the original saved UUID/);
    assert.equal(f.state.coverRevisionIntent, undefined);
  });
}

test('uncertain original save intent cannot authorize a replacement or another save attempt', async t => {
  const f = await fixture(t);
  const journal = JSON.parse(fs.readFileSync(f.journalPath));
  journal.status = 'intent';
  delete journal.savedAt;
  fs.writeFileSync(f.journalPath, JSON.stringify(journal));
  const original = fs.readFileSync(f.journalPath);
  await assert.rejects(prepareXhsCoverRevisionJob(f.input()), /confirmed original draft save/);
  assert.deepEqual(fs.readFileSync(f.journalPath), original);
  assert.equal(f.state.coverRevisionIntent, undefined);
});

test('changing approved content, video or sibling covers is rejected before creating cover intent', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareXhsCoverRevisionJob({ ...f.input(), identity: { ...f.identity, contentFingerprint: 'changed' } }), /exact approved content/);
  await assert.rejects(prepareXhsCoverRevisionJob({ ...f.input(), identity: { ...f.identity,
    video: { ...f.identity.video, sha256: hash('changed video') } } }), /approved video/);
  await assert.rejects(prepareXhsCoverRevisionJob({ ...f.input(), identity: { ...f.identity,
    coverFingerprints: { ...f.identity.coverFingerprints, bilibili: 'changed' } } }), /unchanged sibling/);
  assert.equal(f.state.coverRevisionIntent, undefined);
});

test('changed original journal after committed revision blocks replay without overwriting its bytes', async t => {
  const f = await fixture(t);
  await prepareXhsCoverRevisionJob(f.input());
  fs.appendFileSync(f.journalPath, '\n');
  const altered = fs.readFileSync(f.journalPath);
  await assert.rejects(prepareXhsCoverRevisionJob(f.input()), /original save journal changed/);
  assert.deepEqual(fs.readFileSync(f.journalPath), altered);
});

test('cover revision paths and checkpoint reads remain fingerprint- and original-task-space-bound', async t => {
  const f = await fixture(t);
  await prepareXhsCoverRevisionJob(f.input());
  const corrected = coverRevisionReceiptCheckpointPath(f.store, f.state, 'xiaohongshu');
  assert.equal(corrected, `${f.store.receiptCheckpointPath('xiaohongshu')}.covers-${f.identity.fingerprint}.json`);
  assert.equal(coverRevisionDraftJournalPath(f.store, f.state, 'xiaohongshu'),
    `${f.store.receiptCheckpointPath('xiaohongshu')}.covers-${f.identity.fingerprint}.draft-save.json`);
  assert.equal(await loadCoverRevisionReceiptCheckpoint(f.store, f.state, 'xiaohongshu', 31), null);
  const payload = { schemaVersion: 2, platform: 'xiaohongshu', fingerprint: f.identity.fingerprint,
    taskSpaceId: 31, receipts: { cover: { accepted: true } } };
  fs.writeFileSync(corrected, JSON.stringify(payload));
  assert.deepEqual(await loadCoverRevisionReceiptCheckpoint(f.store, f.state, 'xiaohongshu', 31), payload);
  assert.equal(await loadCoverRevisionReceiptCheckpoint(f.store, f.state, 'xiaohongshu', 99), null);
  assert.equal((await loadCoverRevisionReceiptCheckpoint(f.store, f.state, 'bilibili', 33)).fingerprint, f.priorIdentity.fingerprint);
  assert.equal(coverRevisionReceiptCheckpointPath(f.store, f.state, 'bilibili'), f.store.receiptCheckpointPath('bilibili'));
  assert.equal(coverRevisionDraftJournalPath(f.store, f.state, 'bilibili'), '');
});

test('explicit native ratio activates narrow recovery without claiming acceptance for legacy replacements', async t => {
  const f = await fixture(t);
  assert.equal(isXhsNativeCoverRevision(f.pkg, f.state, f.args), true);
  assert.equal(isXhsNativeCoverRevision(f.priorPkg, f.state, f.args), false);
  assert.equal(isXhsNativeCoverRevision(f.pkg, f.state, { platforms: ['bilibili'] }), false);
});

test('publisher carries separate cover context, no-upload, journal and original-space guards through replay and resume', () => {
  const source = fs.readFileSync(new URL('../publisher.mjs', import.meta.url), 'utf8');
  assert.match(source, /VIDEO_PUBLISHER_V2_COVER_REVISION: JSON\.stringify\(coverContext\)/);
  assert.match(source, /VIDEO_PUBLISHER_V2_NO_UPLOAD: args\.operation === 'park' \|\| tagsOnly \|\| coversOnly \? '1'/);
  assert.match(source, /VIDEO_PUBLISHER_V2_DRAFT_SAVE_JOURNAL_PATH: videoContext \? videoRevisionDraftJournalPath/);
  assert.match(source, /if \(coversOnly && !\['inspect', 'mutate', 'persist', 'verify', 'park'\]\.includes\(phase\)\)/);
  assert.match(source, /inputChannelBroken \|\| tagsOnly \|\| coversOnly \? \[\]/);
  assert.match(source, /original task space was changed or recreated; preserving all prior receipts and identities/);
  assert.match(source, /Cover revision may operate only on its bound original platform drafts/);
});

async function browserRevisionInput(f, selected = ['xiaohongshu', 'bilibili', 'wechat_channels']) {
  const nextRaw = structuredClone(f.originalRaw);
  const portrait = path.join(f.root, 'new-portrait.webp'), landscape = path.join(f.root, 'new-landscape.webp');
  fs.writeFileSync(portrait, 'new exact approved portrait bytes');
  fs.writeFileSync(landscape, 'new exact approved landscape bytes');
  nextRaw.cover.platforms = Object.fromEntries(selected.map(platform => [platform, platform === 'xiaohongshu'
    ? { nativeRatio: '3:4', vertical3x4Path: portrait }
    : platform === 'bilibili' ? { horizontal4x3Path: landscape }
      : { vertical3x4Path: portrait, horizontal4x3Path: landscape }]));
  fs.writeFileSync(f.nextPath, JSON.stringify(nextRaw));
  const pkg = readPackage(f.nextPath), identity = await buildIdentity(pkg);
  return { store: f.store, state: f.state, pkg, identity, args: { ...f.args, platforms: selected } };
}

test('three-platform cover revision binds confirmed native saves and preserves all sibling state and original files', async t => {
  const f = await fixture(t), input = await browserRevisionInput(f);
  const sibling = JSON.stringify(f.state.platforms.youtube);
  const originals = [f.youtubeCheckpoint, ...Object.values(f.journalPaths), ...platforms.map(p => f.store.receiptCheckpointPath(p))];
  const bytes = originals.map(file => fs.readFileSync(file));
  const revision = await prepareBrowserCoverRevisionJob(input);
  assert.deepEqual([...revision.affectedPlatforms].sort(), [...input.args.platforms].sort());
  assert.equal(JSON.stringify(f.state.platforms.youtube), sibling);
  assert.equal(coverRevisionPlatformFingerprint(f.state, 'youtube'), f.priorIdentity.fingerprint);
  for (const platform of input.args.platforms) {
    const source = revision.sources[platform], item = f.state.platforms[platform];
    assert.equal(source.sourceFingerprint, f.priorIdentity.fingerprint);
    assert.equal(source.sourceDraftId, f.proofs[platform].draftId);
    assert.equal(source.sourceJournalSha256, hash(fs.readFileSync(f.journalPaths[platform])));
    assert.equal(source.sourceTaskSpaceId, item.taskSpaceId);
    assert.equal(item.videoReceipt.fingerprint, input.identity.fingerprint);
    assert.equal(item.receipts.cover, undefined);
    assert.equal(item.status, 'needs_mutation');
    assert.equal(coverRevisionContext(f.state, platform).sourceFingerprint, f.priorIdentity.fingerprint);
    assert.match(coverRevisionDraftJournalPath(f.store, f.state, platform), new RegExp(`\\.covers-${input.identity.fingerprint}\\.draft-save\\.json$`));
  }
  originals.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), bytes[index]));
  const beforeReplay = structuredClone(f.state);
  f.store.save = async () => { throw new Error('committed replay must not write'); };
  assert.deepEqual(await prepareBrowserCoverRevisionJob(input), revision);
  assert.deepEqual(f.state, beforeReplay);
});

test('three-platform durable intent replays after a crash without rewriting original confirmed journals', async t => {
  const f = await fixture(t), input = await browserRevisionInput(f);
  const originals = Object.values(f.journalPaths), bytes = originals.map(file => fs.readFileSync(file));
  const realSave = f.store.save.bind(f.store);
  f.store.save = async () => { await realSave(); throw new Error('crash after all source bindings were persisted'); };
  await assert.rejects(prepareBrowserCoverRevisionJob(input), /crash after all source/);
  const disk = JSON.parse(fs.readFileSync(f.store.statePath));
  assert.equal(Object.keys(disk.coverRevisionIntent.sources).length, 3);
  assert.equal(disk.fingerprint, f.priorIdentity.fingerprint);
  Object.values(f.evidencePaths).forEach(file => fs.unlinkSync(file));
  const store = new JobStore(f.store.jobDir, { fingerprint: null });
  const state = await store.initialize();
  const revision = await prepareBrowserCoverRevisionJob({ ...input, store, state });
  assert.deepEqual(revision, disk.coverRevisionIntent);
  assert.equal(state.revisions.length, 1);
  originals.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), bytes[index]));
});

for (const platform of ['bilibili', 'wechat_channels']) {
  test(`${platform} cover migration requires exact source lookup, current native identity and fresh independent reopen proof`, async t => {
    for (const corruption of ['missing-journal', 'pending-journal', 'native-id', 'lookup', 'stale-proof', 'untrusted-route']) {
      const f = await fixture(t), input = await browserRevisionInput(f);
      const journalPath = f.journalPaths[platform];
      if (corruption === 'missing-journal') fs.unlinkSync(journalPath);
      else if (corruption === 'pending-journal') {
        const journal = JSON.parse(fs.readFileSync(journalPath));
        journal.status = 'intent'; delete journal.savedAt; fs.writeFileSync(journalPath, JSON.stringify(journal));
      } else {
        const observation = f.observations[platform], proof = observation.gates.persistedDraft.evidence;
        if (corruption === 'native-id') proof.draftId = proof.listEntryId = proof.reopenedId = 'foreign-native-id';
        if (corruption === 'lookup') proof.lookup.beforeIds = ['unrelated-native-id'];
        if (corruption === 'stale-proof') observation.observedAt = new Date(Date.parse(proof.readAt) + 60001).toISOString();
        if (corruption === 'untrusted-route') proof.reopenedUrl = 'https://untrusted.test/editor';
        fs.writeFileSync(f.evidencePaths[platform], JSON.stringify({ observation }));
      }
      await assert.rejects(prepareBrowserCoverRevisionJob(input), /confirmed original|cannot prove|untrusted/);
      assert.equal(f.state.coverRevisionIntent, undefined, corruption);
      assert.equal(f.state.fingerprint, f.priorIdentity.fingerprint, corruption);
    }
  });
  test(`${platform} source journal alteration blocks an exact committed revision replay`, async t => {
    const f = await fixture(t), input = await browserRevisionInput(f);
    await prepareBrowserCoverRevisionJob(input);
    fs.appendFileSync(f.journalPaths[platform], '\n');
    const before = structuredClone(f.state), bytes = fs.readFileSync(f.journalPaths[platform]);
    await assert.rejects(prepareBrowserCoverRevisionJob(input), /original save journal changed/);
    assert.deepEqual(f.state, before);
    assert.deepEqual(fs.readFileSync(f.journalPaths[platform]), bytes);
  });
}

test('all supported domestic cover replacements use source-bound recovery even without native-ratio overrides', async t => {
  const f = await fixture(t);
  for (const platforms of [['xiaohongshu'], ['bilibili'], ['wechat_channels'], ['bilibili', 'xiaohongshu', 'wechat_channels']]) {
    assert.equal(isBrowserCoverRevision(f.priorPkg, f.state, { platforms }), true);
  }
  assert.equal(isBrowserCoverRevision(f.priorPkg, f.state, { platforms: ['youtube'] }), false);
  assert.equal(isBrowserCoverRevision(f.priorPkg, f.state, { platforms: ['douyin'] }), false);
});
