import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPackage } from '../../lib/content-package.mjs';
import { buildIdentity } from '../lib/identity.mjs';
import { JobStore } from '../lib/job-store.mjs';
import { prepareTagRevisionJob, tagRevisionContext } from '../lib/tag-revision-job.mjs';

let suiteRoot;
let previousConfigPath;
before(() => {
  suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-revision-job-suite-'));
  const configPath = path.join(suiteRoot, 'fixture-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, onboarding: { completed: true },
    sourceDirectory: suiteRoot, availablePlatforms: ['bilibili', 'wechat_channels', 'youtube'],
    defaultPlatforms: ['bilibili', 'wechat_channels', 'youtube'],
    declarations: { originalityPolicy: 'all_videos_original' } }));
  previousConfigPath = process.env.VIDEO_PUBLISHER_CONFIG;
  process.env.VIDEO_PUBLISHER_CONFIG = configPath;
});
after(() => {
  if (previousConfigPath === undefined) delete process.env.VIDEO_PUBLISHER_CONFIG;
  else process.env.VIDEO_PUBLISHER_CONFIG = previousConfigPath;
  fs.rmSync(suiteRoot, { recursive: true, force: true });
});

function proofFor(platform, fingerprint) {
  const now = new Date().toISOString();
  const draftId = `${platform}-original-native-id`;
  return { version: 2, platform, fingerprint, verificationRunId: 'original-verification-run',
    draftId, savedAt: now, readAt: now,
    ...(platform === 'youtube'
      ? { method: 'youtube.videos.list', actualId: draftId, private: true, channelVerified: true }
      : { method: 'draft-list-reopen', listEntryId: draftId, reopenedId: draftId, documentChanged: true,
        listUrl: `https://${platform}.example.test/drafts`, reopenedUrl: `https://${platform}.example.test/edit/${draftId}` }) };
}

async function fixture(t, platforms = ['bilibili', 'wechat_channels', 'youtube']) {
  const root = fs.mkdtempSync(path.join(suiteRoot, 'job-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const videoPath = path.join(root, 'approved-video.mp4');
  const coverPath = path.join(root, 'approved-cover.png');
  fs.writeFileSync(videoPath, 'exact original video bytes');
  fs.writeFileSync(coverPath, 'exact original thumbnail bytes');
  const originalPath = path.join(root, 'original-package.json');
  const nextPath = path.join(root, 'revised-package.json');
  const originalRaw = { videoPath, title: 'Approved title', description: 'Exact approved description',
    bilibiliDescription: 'Exact Bilibili description', wechatDescription: 'Exact WeChat body\n\n#old',
    youtubeDescription: 'Exact YouTube description', tags: ['old'], xhsTopics: ['old'], douyinTopics: ['old'],
    bilibiliTags: ['old'], wechatTags: ['old'], youtubeTags: ['old'], youtubeVisibility: 'private',
    youtubeAudience: 'not_made_for_kids', youtubeCategory: '28',
    cover: { uploadCustomCover: true, horizontal16x9Path: coverPath } };
  const nextRaw = structuredClone(originalRaw);
  for (const platform of platforms) {
    if (platform === 'bilibili') nextRaw.bilibiliTags = ['new', 'tags'];
    if (platform === 'wechat_channels') {
      nextRaw.wechatTags = ['new', 'tags'];
      nextRaw.wechatDescription = 'Exact WeChat body\n\n#new #tags';
    }
    if (platform === 'youtube') nextRaw.youtubeTags = ['new', 'tags'];
  }
  fs.writeFileSync(originalPath, JSON.stringify(originalRaw));
  fs.writeFileSync(nextPath, JSON.stringify(nextRaw));
  const originalPkg = readPackage(originalPath);
  const nextPkg = readPackage(nextPath);
  const originalIdentity = await buildIdentity(originalPkg);
  const identity = await buildIdentity(nextPkg);
  const initial = { schemaVersion: 3, jobId: 'original-job', packagePath: originalPath,
    status: 'ready', ...originalIdentity, platforms: {} };
  const jobDir = path.join(root, 'original-job');
  const store = new JobStore(jobDir, initial);
  const state = await store.initialize();
  const proofs = {};
  const evidencePaths = {};
  for (const [index, platform] of platforms.entries()) {
    const proof = proofFor(platform, originalIdentity.fingerprint);
    proofs[platform] = proof;
    const evidencePath = path.join(store.evidenceDir, `${platform}-original-proof.json`);
    evidencePaths[platform] = evidencePath;
    const taskSpaceId = platform === 'youtube' ? null : index + 101;
    const observation = { platform, phase: 'verify', fingerprint: originalIdentity.fingerprint,
      verificationRunId: proof.verificationRunId, observedAt: proof.readAt, taskSpaceId,
      gates: { video: { ok: true }, draftIdentity: { ok: true, evidence: { id: proof.draftId } },
        persistedDraft: { ok: true, evidence: proof } } };
    fs.writeFileSync(evidencePath, JSON.stringify({ observation, verdict: { ready: true } }));
    state.platforms[platform] = { status: 'ready', taskSpaceId,
      lastEvidencePath: evidencePath, history: [{ phase: 'verify', evidencePath }],
      verdict: { ready: true, verificationVersion: 2 },
      videoReceipt: { fingerprint: originalIdentity.fingerprint, taskSpaceId, mode: 'resume_existing' },
      receipts: { acceptedCover: { digest: 'accepted-cover-digest' },
        uploadStart: { fingerprint: originalIdentity.fingerprint, sourceId: proof.draftId },
        ...(platform === 'youtube' ? { youtubeApi: { fingerprint: originalIdentity.fingerprint,
          videoId: proof.draftId, deliveryKind: 'private_video' } } : {}) } };
    fs.writeFileSync(store.receiptCheckpointPath(platform), JSON.stringify({ schemaVersion: 2, platform,
      fingerprint: originalIdentity.fingerprint, taskSpaceId, receipts: state.platforms[platform].receipts }));
  }
  const apiStatePath = `${store.receiptCheckpointPath('youtube')}.youtube-api.json`;
  if (platforms.includes('youtube')) fs.writeFileSync(apiStatePath, JSON.stringify({
    fingerprint: originalIdentity.fingerprint, channelId: 'fixture-channel', videoId: proofs.youtube.draftId,
    thumbnail: { assetHash: 'original-asset-hash', serverDigest: 'original-server-image', beforeDigest: 'before' } }));
  await store.save();
  const args = { packagePath: nextPath, platforms };
  return { root, store, state, originalRaw, nextRaw, originalPkg, nextPkg, originalIdentity, identity,
    originalPath, nextPath, args, proofs, evidencePaths, apiStatePath,
    input: () => ({ store, state, pkg: nextPkg, identity, args }) };
}

const unexpectedYoutube = async () => { throw new Error('unexpected real YouTube migration dependency'); };

test('revision intent is durable before a YouTube failure and preserves all original sources and checkpoints', async t => {
  const f = await fixture(t);
  const checkpointBytes = fs.readFileSync(f.apiStatePath, 'utf8');
  let calls = 0;
  await assert.rejects(prepareTagRevisionJob(f.input(), { prepareYoutube: async input => {
    calls++;
    const saved = JSON.parse(fs.readFileSync(f.store.statePath, 'utf8'));
    assert.equal(saved.fingerprint, f.originalIdentity.fingerprint);
    assert.equal(saved.packagePath, f.originalPath);
    assert.equal(saved.tagRevision, undefined);
    assert.equal(saved.tagRevisionIntent.nextFingerprint, f.identity.fingerprint);
    assert.equal(saved.tagRevisionIntent.nextPackagePath, f.nextPath);
    for (const platform of f.args.platforms) {
      assert.equal(saved.tagRevisionIntent.sources[platform].sourceDraftId, f.proofs[platform].draftId);
      assert.deepEqual(saved.tagRevisionIntent.sources[platform].sourcePersistedDraft, f.proofs[platform]);
      assert.equal(saved.platforms[platform].status, 'ready');
      assert.equal(fs.existsSync(f.store.receiptCheckpointPath(platform)), true);
    }
    assert.equal(input.checkpointPath, f.store.receiptCheckpointPath('youtube'));
    assert.equal(input.expectedVideoId, f.proofs.youtube.draftId);
    assert.equal(input.previousFingerprint, f.originalIdentity.fingerprint);
    assert.equal(input.nextFingerprint, f.identity.fingerprint);
    throw new Error('fixture migration rejected');
  } }), /fixture migration rejected/);
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(f.apiStatePath, 'utf8'), checkpointBytes);
  const saved = JSON.parse(fs.readFileSync(f.store.statePath, 'utf8'));
  assert.equal(saved.fingerprint, f.originalIdentity.fingerprint);
  assert.equal(saved.tagRevisionIntent.previousFingerprint, f.originalIdentity.fingerprint);
  assert.equal(saved.revisions, undefined);
  assert.equal(fs.statSync(f.store.statePath).mode & 0o077, 0);
});

test('a crash after checkpoint migration resumes the same intent, IDs and browser spaces then commits once', async t => {
  const f = await fixture(t);
  const priorPlatforms = structuredClone(f.state.platforms);
  const originalApi = JSON.parse(fs.readFileSync(f.apiStatePath, 'utf8'));
  const migrationCalls = [];
  let checkpointMigrations = 0;
  const migrate = async input => {
    assert.equal(input.checkpointPath, f.store.receiptCheckpointPath('youtube'));
    assert.equal(input.expectedVideoId, f.proofs.youtube.draftId);
    const saved = JSON.parse(fs.readFileSync(f.store.statePath, 'utf8'));
    assert.ok(saved.tagRevisionIntent);
    migrationCalls.push({ input: structuredClone(input), intent: structuredClone(saved.tagRevisionIntent) });
    const api = JSON.parse(fs.readFileSync(f.apiStatePath, 'utf8'));
    assert.equal(api.videoId, f.proofs.youtube.draftId);
    if (api.fingerprint === f.originalIdentity.fingerprint) {
      checkpointMigrations++;
      api.fingerprint = f.identity.fingerprint;
      api.metadataRevision = { from: input.previousFingerprint, to: input.nextFingerprint, videoId: api.videoId };
      fs.writeFileSync(f.apiStatePath, JSON.stringify(api));
    } else assert.equal(api.fingerprint, f.identity.fingerprint);
  };
  await assert.rejects(prepareTagRevisionJob(f.input(), { prepareYoutube: async input => {
    await migrate(input); throw new Error('fixture crash after migration');
  } }), /fixture crash after migration/);
  const durableIntent = JSON.parse(fs.readFileSync(f.store.statePath, 'utf8')).tagRevisionIntent;
  assert.equal(JSON.parse(fs.readFileSync(f.apiStatePath, 'utf8')).fingerprint, f.identity.fingerprint);
  // Replay uses the recorded sources even if later evidence is unavailable.
  for (const file of Object.values(f.evidencePaths)) fs.unlinkSync(file);
  const resumedStore = new JobStore(f.store.jobDir, { fingerprint: f.originalIdentity.fingerprint });
  const resumedState = await resumedStore.initialize();
  const revision = await prepareTagRevisionJob({ store: resumedStore, state: resumedState,
    pkg: f.nextPkg, identity: f.identity, args: f.args }, { prepareYoutube: migrate });
  assert.equal(checkpointMigrations, 1);
  assert.equal(migrationCalls.length, 2);
  assert.deepEqual(migrationCalls[0].input, migrationCalls[1].input);
  assert.deepEqual(migrationCalls[0].intent, migrationCalls[1].intent);
  assert.deepEqual(revision, durableIntent);
  const saved = JSON.parse(fs.readFileSync(resumedStore.statePath, 'utf8'));
  assert.equal(saved.fingerprint, f.identity.fingerprint);
  assert.equal(saved.contentFingerprint, f.identity.contentFingerprint);
  assert.equal(saved.packagePath, f.nextPath);
  assert.equal(saved.status, 'blocked');
  assert.equal(saved.tagRevisionIntent, undefined);
  assert.deepEqual(saved.tagRevision, durableIntent);
  assert.equal(saved.revisions.length, 1);
  assert.equal(saved.revisions[0].operation, 'update-tags');
  assert.deepEqual(saved.video, f.originalIdentity.video);
  assert.deepEqual(saved.assets, f.originalIdentity.assets);
  for (const platform of f.args.platforms) {
    const item = saved.platforms[platform];
    assert.equal(item.status, 'needs_mutation');
    assert.equal(item.verdict, null);
    assert.equal(item.taskSpaceId, priorPlatforms[platform].taskSpaceId);
    assert.equal(item.videoReceipt.fingerprint, f.identity.fingerprint);
    assert.equal(item.receipts.uploadStart.fingerprint, f.identity.fingerprint);
    assert.equal(item.receipts.uploadStart.sourceId, f.proofs[platform].draftId);
    assert.deepEqual(item.receipts.acceptedCover, priorPlatforms[platform].receipts.acceptedCover);
    assert.equal(fs.existsSync(resumedStore.receiptCheckpointPath(platform)), false);
    const context = tagRevisionContext(saved, platform);
    assert.equal(context.sourceDraftId, f.proofs[platform].draftId);
    assert.equal(context.previousFingerprint, f.originalIdentity.fingerprint);
    assert.equal(context.nextFingerprint, f.identity.fingerprint);
  }
  const migratedApi = JSON.parse(fs.readFileSync(f.apiStatePath, 'utf8'));
  assert.equal(migratedApi.videoId, originalApi.videoId);
  assert.deepEqual(migratedApi.thumbnail, originalApi.thumbnail);
  assert.equal(saved.platforms.youtube.receipts.youtubeApi.videoId, originalApi.videoId);
  assert.equal(saved.platforms.youtube.receipts.youtubeApi.fingerprint, f.identity.fingerprint);
});

test('an unfinished intent rejects a different package fingerprint or target package path before another migration', async t => {
  const f = await fixture(t, ['youtube']);
  await assert.rejects(prepareTagRevisionJob(f.input(), { prepareYoutube: async () => { throw new Error('pending fixture'); } }), /pending fixture/);
  const before = fs.readFileSync(f.store.statePath, 'utf8');
  const conflictingRaw = { ...f.nextRaw, youtubeTags: ['different', 'target'] };
  const conflictingPath = path.join(f.root, 'conflicting-package.json');
  fs.writeFileSync(conflictingPath, JSON.stringify(conflictingRaw));
  const conflictingPkg = readPackage(conflictingPath);
  const conflictingIdentity = await buildIdentity(conflictingPkg);
  await assert.rejects(prepareTagRevisionJob({ ...f.input(), pkg: conflictingPkg, identity: conflictingIdentity,
    args: { ...f.args, packagePath: conflictingPath } }, { prepareYoutube: unexpectedYoutube }), /conflicts with an unfinished revision intent/);
  assert.equal(fs.readFileSync(f.store.statePath, 'utf8'), before);
  const alternatePath = path.join(f.root, 'same-revised-package-another-path.json');
  fs.writeFileSync(alternatePath, JSON.stringify(f.nextRaw));
  await assert.rejects(prepareTagRevisionJob({ ...f.input(), args: { ...f.args, packagePath: alternatePath } },
    { prepareYoutube: unexpectedYoutube }), /conflicts with an unfinished revision intent/);
  assert.equal(fs.readFileSync(f.store.statePath, 'utf8'), before);
});

test('changed original package, video bytes or cover bytes cannot migrate any checkpoint', async t => {
  for (const change of ['package', 'video', 'cover']) {
    await t.test(change, async subtest => {
      const f = await fixture(subtest, ['youtube']);
      const stateBytes = fs.readFileSync(f.store.statePath, 'utf8');
      const apiBytes = fs.readFileSync(f.apiStatePath, 'utf8');
      if (change === 'package') fs.writeFileSync(f.originalPath, JSON.stringify({ ...f.originalRaw, title: 'changed original title' }));
      if (change === 'video') fs.writeFileSync(f.originalRaw.videoPath, 'changed original video bytes');
      if (change === 'cover') fs.writeFileSync(f.originalRaw.cover.horizontal16x9Path, 'changed original cover bytes');
      await assert.rejects(prepareTagRevisionJob(f.input(), { prepareYoutube: unexpectedYoutube }), /original package was changed|asset identity cannot be proved/);
      assert.equal(fs.readFileSync(f.store.statePath, 'utf8'), stateBytes);
      assert.equal(fs.readFileSync(f.apiStatePath, 'utf8'), apiBytes);
      assert.equal(f.state.tagRevisionIntent, undefined);
    });
  }
});

test('a supplied revised identity cannot change video or cover hashes even if files remain unchanged', async t => {
  for (const field of ['video', 'assets', 'coverFingerprint', 'coverFingerprints']) {
    await t.test(field, async subtest => {
      const f = await fixture(subtest, ['youtube']);
      const identity = structuredClone(f.identity);
      if (field === 'video') identity.video.sha256 = 'different-video-hash';
      if (field === 'assets') identity.assets[0].sha256 = 'different-cover-hash';
      if (field === 'coverFingerprint') identity.coverFingerprint = 'different-cover-fingerprint';
      if (field === 'coverFingerprints') identity.coverFingerprints.youtube = 'different-youtube-cover-fingerprint';
      const before = fs.readFileSync(f.store.statePath, 'utf8');
      await assert.rejects(prepareTagRevisionJob({ ...f.input(), identity }, { prepareYoutube: unexpectedYoutube }), /cannot change the video or cover identity/);
      assert.equal(fs.readFileSync(f.store.statePath, 'utf8'), before);
    });
  }
});

test('completed revision replay is idempotent and makes no further YouTube call or state commit', async t => {
  const f = await fixture(t, ['youtube']);
  let calls = 0;
  await prepareTagRevisionJob(f.input(), { prepareYoutube: async () => { calls++; } });
  const before = fs.readFileSync(f.store.statePath, 'utf8');
  const revision = await prepareTagRevisionJob(f.input(), { prepareYoutube: unexpectedYoutube });
  assert.equal(calls, 1);
  assert.deepEqual(revision, f.state.tagRevision);
  assert.equal(fs.readFileSync(f.store.statePath, 'utf8'), before);
  assert.equal(f.state.revisions.length, 1);
  assert.equal(f.state.tagRevisionIntent, undefined);
  assert.equal(tagRevisionContext(f.state, 'youtube').sourceDraftId, f.proofs.youtube.draftId);
});

test('YouTube source proof binds actualId without a browser reopenedId; wrong or missing actualId is refused', async t => {
  const valid = await fixture(t, ['youtube']);
  assert.equal(valid.proofs.youtube.reopenedId, undefined);
  await prepareTagRevisionJob(valid.input(), { prepareYoutube: async () => {} });
  assert.equal(valid.state.tagRevision.sources.youtube.sourceDraftId, valid.proofs.youtube.actualId);
  for (const mismatch of ['wrong', 'missing']) {
    await t.test(mismatch, async subtest => {
      const f = await fixture(subtest, ['youtube']);
      const evidence = JSON.parse(fs.readFileSync(f.evidencePaths.youtube, 'utf8'));
      const proof = evidence.observation.gates.persistedDraft.evidence;
      proof.reopenedId = proof.draftId;
      if (mismatch === 'wrong') proof.actualId = 'different-video-id';
      else delete proof.actualId;
      fs.writeFileSync(f.evidencePaths.youtube, JSON.stringify(evidence));
      await assert.rejects(prepareTagRevisionJob(f.input(), { prepareYoutube: unexpectedYoutube }), /cannot prove the original saved resource: youtube/);
      assert.equal(f.state.tagRevisionIntent, undefined);
    });
  }
});

test('browser source proof requires the same saved native ID after list reopening', async t => {
  for (const platform of ['bilibili', 'wechat_channels']) {
    await t.test(platform, async subtest => {
      const f = await fixture(subtest, [platform]);
      const proof = f.proofs[platform];
      assert.equal(proof.method, 'draft-list-reopen');
      assert.equal(proof.listEntryId, proof.draftId);
      assert.equal(proof.reopenedId, proof.draftId);
      const evidence = JSON.parse(fs.readFileSync(f.evidencePaths[platform], 'utf8'));
      evidence.observation.gates.persistedDraft.evidence.reopenedId = 'different-native-draft';
      fs.writeFileSync(f.evidencePaths[platform], JSON.stringify(evidence));
      await assert.rejects(prepareTagRevisionJob(f.input(), { prepareYoutube: unexpectedYoutube }), /cannot prove the original saved resource/);
      assert.equal(f.state.tagRevisionIntent, undefined);
    });
  }
});

test('all existing deliveries must be targeted and original browser spaces must exist', async t => {
  const subset = await fixture(t);
  await assert.rejects(prepareTagRevisionJob({ ...subset.input(), args: { ...subset.args, platforms: ['youtube'] } },
    { prepareYoutube: unexpectedYoutube }), /must include every existing draft whose tags changed|must verify every existing delivery/);
  assert.equal(subset.state.tagRevisionIntent, undefined);
  const missingSpace = await fixture(t, ['bilibili', 'youtube']);
  missingSpace.state.platforms.bilibili.taskSpaceId = null;
  await assert.rejects(prepareTagRevisionJob(missingSpace.input(), { prepareYoutube: unexpectedYoutube }), /no original browser space: bilibili/);
  assert.equal(missingSpace.state.tagRevisionIntent, undefined);
});

test('a confirmed unfinished Bilibili-only correction uses the completed native upload and leaves saved siblings intact', async t => {
  const f = await fixture(t);
  const nextRaw = { ...f.originalRaw, bilibiliTags: ['new', 'tags'] };
  fs.writeFileSync(f.nextPath, JSON.stringify(nextRaw));
  const pkg = readPackage(f.nextPath), identity = await buildIdentity(pkg);
  const item = f.state.platforms.bilibili;
  item.status = 'blocked_user'; item.taskSpaceName = 'exact-original-bili-space';
  const native = { draftId: '', existingDraft: false, published: false, partCount: 1,
    uploadComplete: true, nativeFileIds: ['filename:original-remote-upload'], cid: '12345678' };
  const source = { platform: 'bilibili', phase: 'mutate', taskSpaceId: item.taskSpaceId,
    taskSpace: item.taskSpaceName, fingerprint: f.originalIdentity.fingerprint, observedAt: new Date().toISOString(),
    gates: { draftIdentity: { ok: true }, video: { ok: true, evidence: { filename: path.basename(f.originalRaw.videoPath), stable: true } } },
    evidence: { nativeUploadIdentity: native } };
  fs.writeFileSync(f.evidencePaths.bilibili, JSON.stringify({ observation: source }));
  const freshPath = path.join(f.store.evidenceDir, 'fresh-bili-unsaved-native.json');
  fs.writeFileSync(freshPath, JSON.stringify({ observation: { ...source, phase: 'inspect' } }));
  item.history = [{ phase: 'mutate', evidencePath: f.evidencePaths.bilibili }, { phase: 'inspect', evidencePath: freshPath }];
  item.lastEvidencePath = freshPath;
  await f.store.save();
  const siblings = structuredClone({ youtube: f.state.platforms.youtube, wechat_channels: f.state.platforms.wechat_channels });
  const apiBytes = fs.readFileSync(f.apiStatePath, 'utf8');
  const args = { ...f.args, platforms: ['bilibili'], confirmTagChange: true };
  await prepareTagRevisionJob({ store: f.store, state: f.state, pkg, identity, args }, { prepareYoutube: unexpectedYoutube });
  assert.equal(f.state.tagRevision.sources.bilibili.kind, 'bilibili-unsaved-tag-correction-v1');
  assert.equal(tagRevisionContext(f.state, 'youtube'), null);
  assert.deepEqual(f.state.platforms.youtube, siblings.youtube);
  assert.deepEqual(f.state.platforms.wechat_channels, siblings.wechat_channels);
  assert.equal(fs.readFileSync(f.apiStatePath, 'utf8'), apiBytes);
  assert.equal(f.state.platformFingerprints.youtube, f.originalIdentity.fingerprint);
  assert.equal(f.state.platformPackagePaths.youtube, f.originalPath);
  const before = fs.readFileSync(f.store.statePath, 'utf8');
  await prepareTagRevisionJob({ store: f.store, state: f.state, pkg, identity, args }, { prepareYoutube: unexpectedYoutube });
  assert.equal(fs.readFileSync(f.store.statePath, 'utf8'), before);
});
