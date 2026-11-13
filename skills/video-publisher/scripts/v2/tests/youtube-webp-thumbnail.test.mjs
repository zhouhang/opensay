import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expectedYoutube, runYoutubeApi } from '../platforms/youtube-api.mjs';

const videoId = '3wM2IdlPmPo';
const credentials = { client_id: 'test', client_secret: 'test', refresh_token: 'test', channel_id: 'channel' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function chunk(type, payload) {
  const bytes = Buffer.alloc(8 + payload.length + payload.length % 2);
  bytes.write(type, 0, 4, 'ascii'); bytes.writeUInt32LE(payload.length, 4); payload.copy(bytes, 8);
  return bytes;
}
function webp(width = 2048, height = 1152, extra = []) {
  const payload = Buffer.from([0x10, 0, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0]);
  payload.writeUInt16LE(width, 6); payload.writeUInt16LE(height, 8);
  const body = Buffer.concat([chunk('VP8 ', payload), ...extra]);
  const header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(body.length + 4, 4); header.write('WEBP', 8);
  return Buffer.concat([header, body]);
}
function fixture(t, asset, { remoteChanges = true, rejectThumbnail = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-webp-thumbnail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetPath = path.join(root, 'thumbnail.image'); fs.writeFileSync(assetPath, asset);
  const checkpoint = path.join(root, 'checkpoint');
  const stateFile = `${checkpoint}.youtube-api.json`;
  fs.writeFileSync(stateFile, JSON.stringify({ fingerprint: 'fp', channelId: 'channel', videoId,
    savedAt: '2026-10-20T00:00:00.000Z', uploadIntent: true, sessionUrl: 'https://www.googleapis.com/upload/completed-session' }));
  const pkg = { title: 'Test', youtubeDescription: 'Exact description', youtubeTags: ['AI'],
    youtubeAudience: 'not_made_for_kids', youtubeVisibility: 'private', youtubeCategory: '28',
    youtubeLicense: 'standard_youtube', youtubeAllowEmbedding: true,
    cover: { uploadCustomCover: true, horizontal16x9Path: assetPath } };
  const expected = expectedYoutube(pkg, credentials);
  const resource = () => ({ id: videoId, ...structuredClone(expected),
    snippet: { ...structuredClone(expected.snippet), channelId: 'channel',
      thumbnails: { high: { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` } } },
    status: { ...expected.status, uploadStatus: 'processed' }, processingDetails: { processingStatus: 'succeeded' } });
  const calls = [];
  let thumbnailUploaded = false;
  const client = {
    authenticate: async () => {},
    video: async id => { assert.equal(id, videoId); calls.push({ kind: 'read', id }); return resource(); },
    request: async () => { throw new Error('Existing checkpoint must never create or transfer a video upload'); },
    json: async (url, options) => {
      calls.push({ kind: 'write', url, options });
      if (url.includes('/thumbnails/set?')) {
        assert.equal(new URL(url).searchParams.get('videoId'), videoId);
        if (rejectThumbnail) throw Object.assign(new Error('invalidImage'), { code: 'PLATFORM_REJECTED_ASSET' });
        thumbnailUploaded = true;
        return { items: [{ url: 'write-response-is-not-read-evidence' }] };
      }
      assert.equal(options.method, 'PUT');
      assert.ok(url.includes('/videos?part='));
      assert.equal(JSON.parse(options.body).id, videoId);
      return resource();
    },
    thumbnailDigest: async (_url, options = {}) => {
      calls.push({ kind: 'thumbnail-read', options });
      return thumbnailUploaded && remoteChanges ? 'independent-server-digest' : 'before-upload-digest';
    },
  };
  const dependencies = { credentials, client, env: { VIDEO_PUBLISHER_V2_FINGERPRINT: 'fp',
    VIDEO_PUBLISHER_V2_CHECKPOINT_PATH: checkpoint, VIDEO_PUBLISHER_V2_VERIFICATION_RUN_ID: 'run' } };
  const run = phase => runYoutubeApi({ pkg, phase }, dependencies);
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const thumbnailWrites = () => calls.filter(call => call.kind === 'write' && call.url.includes('/thumbnails/set?'));
  return { assetPath, calls, run, state, thumbnailWrites };
}

test('valid 16:9 WebP uses exact original bytes with documented octet-stream MIME on the existing video', async t => {
  const asset = webp();
  const f = fixture(t, asset);
  const result = await f.run('mutate');
  assert.equal(result.blocker, undefined);
  assert.equal(result.gates.cover.ok, true);
  const [write] = f.thumbnailWrites();
  assert.equal(write.options.method, 'POST');
  assert.equal(write.options.headers['Content-Type'], 'application/octet-stream');
  assert.deepEqual(write.options.body, asset);
  assert.deepEqual(fs.readFileSync(f.assetPath), asset);
  assert.equal(f.thumbnailWrites().length, 1);
  const state = f.state();
  assert.equal(state.videoId, videoId);
  assert.equal(state.sessionUrl, 'https://www.googleapis.com/upload/completed-session');
  assert.equal(state.thumbnail.assetHash, digest(asset));
  assert.equal(state.thumbnail.beforeDigest, 'before-upload-digest');
  assert.equal(state.thumbnail.serverDigest, 'independent-server-digest');
  assert.notEqual(state.thumbnail.serverDigest, state.thumbnail.assetHash);
  assert.equal('serverHash' in state.thumbnail, false);
  assert.ok(f.calls.filter(call => call.kind === 'read').length >= 3);
  assert.equal((await f.run('verify')).gates.cover.ok, true);
  assert.equal((await f.run('mutate')).gates.cover.ok, true);
  assert.equal(f.thumbnailWrites().length, 1, 'same asset receipt must avoid another thumbnail upload');
});

test('the user-provided original WebP is submitted byte for byte without conversion', {
  skip: !process.env.YOUTUBE_WEBP_THUMBNAIL_FIXTURE,
}, async t => {
  const original = fs.readFileSync(process.env.YOUTUBE_WEBP_THUMBNAIL_FIXTURE);
  const f = fixture(t, original);
  const result = await f.run('mutate');
  assert.equal(result.blocker, undefined);
  assert.equal(result.gates.cover.ok, true);
  assert.deepEqual(f.thumbnailWrites()[0].options.body, original);
  assert.equal(f.thumbnailWrites()[0].options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(f.state().thumbnail.assetHash, digest(original));
});

test('corrupt, unknown, non-16:9 and oversized assets never submit a thumbnail or a video insert', async t => {
  const corrupt = webp(); corrupt.writeUInt32LE(0xffffffff, 4);
  const badSignature = webp(); badSignature[23] = 0;
  const oversized = webp(2048, 1152, [chunk('JUNK', Buffer.alloc(2 * 1024 * 1024))]);
  for (const asset of [corrupt, badSignature, webp(1344, 1792), Buffer.from('unknown-image'), oversized]) {
    const f = fixture(t, asset);
    const result = await f.run('mutate');
    assert.equal(result.blocker.code, 'PLATFORM_REJECTED_ASSET');
    assert.equal(f.thumbnailWrites().length, 0);
    assert.equal(f.state().videoId, videoId);
    assert.equal(f.state().thumbnail, undefined);
    assert.ok(f.calls.filter(call => call.kind === 'write').every(call => call.options.method === 'PUT'));
  }
});

test('PNG and JPEG retain their existing MIME and exact bytes', async t => {
  for (const [asset, mime] of [
    [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]), 'image/png'],
    [Buffer.from([255, 216, 255, 224, 1, 2]), 'image/jpeg'],
  ]) {
    const f = fixture(t, asset);
    assert.equal((await f.run('mutate')).blocker, undefined);
    assert.equal(f.thumbnailWrites()[0].options.headers['Content-Type'], mime);
    assert.deepEqual(f.thumbnailWrites()[0].options.body, asset);
  }
});

test('a successful write without a changed independent server digest never verifies the cover', async t => {
  const f = fixture(t, webp(), { remoteChanges: false });
  const result = await f.run('mutate');
  assert.equal(result.gates.cover.ok, false);
  assert.equal(f.state().thumbnail.serverDigest, undefined);
  assert.equal(f.state().videoId, videoId);
});

test('server invalidImage preserves the existing video checkpoint and does not fabricate an accepted receipt', async t => {
  const f = fixture(t, webp(), { rejectThumbnail: true });
  const result = await f.run('mutate');
  assert.equal(result.blocker.code, 'PLATFORM_REJECTED_ASSET');
  assert.equal(result.blocker.message, 'invalidImage');
  assert.equal(f.state().videoId, videoId);
  assert.equal(f.state().thumbnail, undefined);
  assert.equal(f.thumbnailWrites().length, 1);
});

test('upload phase resumes a persisted video ID solely by reading it, never videos.insert', async t => {
  const f = fixture(t, webp());
  const result = await f.run('upload');
  assert.equal(result.blocker, undefined);
  assert.equal(result.receipts.youtubeApi.videoId, videoId);
  assert.equal(f.calls.filter(call => call.kind === 'write').length, 0);
  assert.equal(f.state().videoId, videoId);
});
