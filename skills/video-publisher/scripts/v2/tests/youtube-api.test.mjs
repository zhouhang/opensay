import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bindExistingYoutubeVideo, prepareYoutubeTagRevision, expectedYoutube, YoutubeClient, uploadResumable, youtubeReadback, runYoutubeApi, youtubeAuthorizationUrl } from '../platforms/youtube-api.mjs';
import { evaluateObservation, classifyVerdict } from '../lib/model.mjs';

const pkg = { title: 'Test', youtubeDescription: 'Exact description', youtubeTags: ['a', 'b'], youtubeAudience: 'not_made_for_kids',
  youtubeVisibility: 'private', youtubeCategory: '28', youtubeLicense: 'standard_youtube', youtubeAllowEmbedding: true, cover: {} };
const credentials = { client_id: 'test', client_secret: 'test', refresh_token: 'test', channel_id: 'channel' };
function resource(id = 'video') {
  const expected = expectedYoutube(pkg, credentials);
  return { id, ...expected, snippet: { ...expected.snippet, channelId: 'channel' },
    status: { ...expected.status, uploadStatus: 'processed' }, processingDetails: { processingStatus: 'succeeded' } };
}
test('API transport never permits public or unlisted output', () => {
  for (const visibility of ['public', 'unlisted']) assert.throws(() => expectedYoutube({ ...pkg, youtubeVisibility: visibility }, credentials), /only permits private/);
});
test('OAuth setup builds a complete offline PKCE authorization URL', () => {
  const url = new URL(youtubeAuthorizationUrl({
    clientId: 'client-id', redirectUri: 'http://127.0.0.1:4321/oauth/callback', state: 'state', codeChallenge: 'challenge',
  }));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.pathname, '/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:4321/oauth/callback');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.force-ssl');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge');
  assert.equal(url.searchParams.get('state'), 'state');
});
test('unsupported playlist/category requests block instead of being omitted', () => {
  assert.throws(() => expectedYoutube({ ...pkg, youtubePlaylist: 'Wanted playlist' }, credentials), /Playlist/);
  assert.throws(() => expectedYoutube({ ...pkg, youtubeCategory: 'Unknown' }, credentials), /numeric/);
});
test('readback requires processed video, exact fields, owner and private status', () => {
  const expected = expectedYoutube(pkg, credentials);
  const state = { videoId: 'video', savedAt: new Date().toISOString() };
  const context = { channelId: 'channel', fingerprint: 'fp', verificationRunId: 'run', phase: 'verify' };
  const make = video => evaluateObservation(youtubeReadback(pkg, expected, video, state, context));
  assert.equal(make(resource()).ready, true);
  for (const mutate of [v => v.status.privacyStatus = 'public', v => v.snippet.title = 'Wrong',
    v => v.snippet.description = 'Wrong', v => v.snippet.channelId = 'another-channel',
    v => v.processingDetails.processingStatus = 'processing', v => delete v.status.selfDeclaredMadeForKids,
    v => v.status.containsSyntheticMedia = true, v => v.snippet.tags.push('unwanted')]) {
    const video = resource(); mutate(video); assert.equal(make(video).ready, false);
  }
});
test('readback treats omitted false-only YouTube settings as false', () => {
  const video = resource();
  delete video.status.containsSyntheticMedia;
  delete video.paidProductPlacementDetails.hasPaidProductPlacement;
  const observation = youtubeReadback(pkg, expectedYoutube(pkg, credentials), video,
    { videoId: 'video', savedAt: new Date().toISOString() },
    { channelId: 'channel', fingerprint: 'fp', verificationRunId: 'run', phase: 'verify' });
  assert.equal(observation.gates.settings.ok, true);
});
test('synthetic-content declaration writes true and distinguishes false from an absent readback field', () => {
  const declaredPkg = { ...pkg, youtubeAlteredContent: true };
  const expected = expectedYoutube(declaredPkg, credentials);
  assert.equal(expected.status.containsSyntheticMedia, true);
  for (const value of [true, false, undefined]) {
    const video = resource();
    if (value === undefined) delete video.status.containsSyntheticMedia;
    else video.status.containsSyntheticMedia = value;
    const observation = youtubeReadback(declaredPkg, expected, video,
      { videoId: 'video', savedAt: new Date().toISOString() },
      { channelId: 'channel', fingerprint: 'fp', verificationRunId: 'run', phase: 'verify' });
    assert.equal(observation.gates.settings.ok, value === true);
    assert.deepEqual(observation.gates.settings.evidence.syntheticField, {
      present: value !== undefined, type: value === undefined ? 'missing' : 'boolean', value: value ?? null,
    });
  }
});
test('mutation safely records synthetic-content request and response without trusting the write response', async t => {
  const declaredPkg = { ...pkg, youtubeAlteredContent: true };
  for (const [returned, actual] of [[true, true], [true, false], [false, false], [undefined, undefined],
    ['private-untrusted-response', false]]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-synthetic-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const checkpoint = path.join(root, 'checkpoint');
    fs.writeFileSync(`${checkpoint}.youtube-api.json`, JSON.stringify({ fingerprint: 'fp', channelId: 'channel',
      videoId: 'video', savedAt: new Date().toISOString() }));
    let reads = 0, writes = 0;
    const client = { authenticate: async () => {}, video: async id => {
      assert.equal(id, 'video'); reads++;
      const video = resource();
      if (actual === undefined) delete video.status.containsSyntheticMedia;
      else video.status.containsSyntheticMedia = actual;
      return video;
    }, json: async (url, options) => {
      assert.equal(options.method, 'PUT');
      assert.ok(new URL(url).searchParams.get('part').split(',').includes('status'));
      const body = JSON.parse(options.body);
      assert.equal(body.id, 'video');
      assert.equal(body.status.containsSyntheticMedia, true);
      assert.equal(body.status.privacyStatus, 'private');
      writes++;
      const updated = resource();
      if (returned === undefined) delete updated.status.containsSyntheticMedia;
      else updated.status.containsSyntheticMedia = returned;
      updated.access_token = 'never-copy-response-token';
      return updated;
    }, request: async () => { throw new Error('No upload session or new video is permitted'); } };
    const result = await runYoutubeApi({ pkg: declaredPkg, phase: 'mutate' }, { credentials, client,
      env: { VIDEO_PUBLISHER_V2_FINGERPRINT: 'fp', VIDEO_PUBLISHER_V2_CHECKPOINT_PATH: checkpoint,
        VIDEO_PUBLISHER_V2_VERIFICATION_RUN_ID: 'run' } });
    assert.equal(writes, 1);
    assert.equal(reads, 2);
    assert.equal(evaluateObservation(result).ready, actual === true);
    assert.equal(result.evidence.metadataUpdate.requestedContainsSyntheticMedia, true);
    assert.deepEqual(result.evidence.metadataUpdate.returnedContainsSyntheticMedia, {
      present: returned !== undefined, type: returned === undefined ? 'missing' : typeof returned,
      value: typeof returned === 'boolean' ? returned : null,
    });
    assert.equal(result.evidence.metadataUpdate.writeReceiptOnly, true);
    const stateBytes = fs.readFileSync(`${checkpoint}.youtube-api.json`, 'utf8');
    assert.equal(JSON.parse(stateBytes).videoId, 'video');
    assert.equal(stateBytes.includes('private-untrusted-response'), false);
    assert.equal(stateBytes.includes('never-copy-response-token'), false);
    assert.equal(JSON.stringify(result).includes('private-untrusted-response'), false);
    assert.equal(JSON.stringify(result).includes('never-copy-response-token'), false);
  }
});
test('custom thumbnail requires independently fetched image evidence', () => {
  const o = youtubeReadback({ ...pkg, cover: { uploadCustomCover: true } }, expectedYoutube(pkg, credentials), resource(),
    { videoId: 'video', savedAt: new Date().toISOString() }, { channelId: 'channel', fingerprint: 'fp', verificationRunId: 'run', phase: 'verify' });
  assert.equal(o.gates.cover.ok, false);
});
test('resumable upload checkpoints before transfer and does not duplicate insert after a lost response', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-api-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const videoPath = path.join(root, 'video.mp4'); fs.writeFileSync(videoPath, 'video bytes');
  const state = {}; let inserts = 0; let completed = false; const saves = [];
  const client = { request: async (url, options) => {
    if (options.method === 'POST') { inserts++; return new Response(null, { status: 200, headers: { location: 'https://www.googleapis.com/upload/session' } }); }
    if (options.headers['Content-Length'] === '0') return completed ? Response.json({ id: 'video' }) : new Response(null, { status: 308 });
    completed = true; throw new Error('lost completion response');
  } };
  await assert.rejects(uploadResumable(client, { ...pkg, videoPath }, expectedYoutube(pkg, credentials), state, () => saves.push(structuredClone(state))));
  assert.equal(saves[0].uploadIntent, true);
  assert.ok(saves[1].sessionUrl);
  const id = await uploadResumable(client, { ...pkg, videoPath }, expectedYoutube(pkg, credentials), state, () => {});
  assert.equal(id, 'video'); assert.equal(inserts, 1);
});
test('uncertain session creation does not issue another insert', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-api-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const videoPath = path.join(root, 'video.mp4'); fs.writeFileSync(videoPath, 'video');
  let calls = 0;
  await assert.rejects(uploadResumable({ request: () => { calls++; } }, { ...pkg, videoPath }, {}, { uploadIntent: true }, () => {}), /refusing duplicate/);
  assert.equal(calls, 0);
});
test('authorization verifies configured channel and never leaks refresh token to an arbitrary upload URL', async () => {
  let calls = 0;
  const c = new YoutubeClient(credentials, async url => {
    calls++;
    return url.includes('oauth2') ? Response.json({ access_token: 'token' }) : Response.json({ items: [{ id: 'wrong' }] });
  });
  await assert.rejects(c.authenticate(), /does not match/);
  await assert.rejects(c.request('https://attacker.test/upload'), /Refusing/);
  assert.equal(calls, 2);
});
test('existing private video binding validates identity before atomically seeding the API checkpoint', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-bind-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkpoint = path.join(root, 'youtube.receipts.json');
  const result = await bindExistingYoutubeVideo({ pkg, fingerprint: 'fp', checkpointPath: checkpoint, videoId: 'video' }, {
    credentials,
    client: { authenticate: async () => {}, video: async () => resource() },
  });
  assert.equal(result.bound, true);
  const state = JSON.parse(fs.readFileSync(`${checkpoint}.youtube-api.json`, 'utf8'));
  assert.equal(state.videoId, 'video');
  assert.equal(state.binding.contentMetadataVerified, true);
  assert.equal(state.binding.private, true);
  assert.equal(state.binding.processed, true);
});
test('existing video binding rejects foreign, public and metadata-mismatched resources without writing state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-bind-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkpoint = path.join(root, 'youtube.receipts.json');
  for (const mutate of [v => v.snippet.channelId = 'foreign', v => v.status.privacyStatus = 'public', v => v.snippet.title = 'Wrong']) {
    const video = resource(); mutate(video);
    await assert.rejects(bindExistingYoutubeVideo({ pkg, fingerprint: 'fp', checkpointPath: checkpoint, videoId: 'video' }, {
      credentials,
      client: { authenticate: async () => {}, video: async () => video },
    }));
    assert.equal(fs.existsSync(`${checkpoint}.youtube-api.json`), false);
  }
});
test('API transport exposes resumable 308 responses without following or rejecting them', async () => {
  let options;
  const c = new YoutubeClient(credentials, async (_url, supplied) => {
    options = supplied;
    return new Response(null, { status: 308, headers: { range: 'bytes=0-3' } });
  });
  c.token = 'token';
  const response = await c.request('https://www.googleapis.com/upload/session', { method: 'PUT' });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('range'), 'bytes=0-3');
  assert.equal(options.redirect, 'manual');
});
test('independent videos.list reads explicitly bypass caching on the same video ID', async () => {
  let requestedUrl, options;
  const client = new YoutubeClient(credentials, async (url, supplied) => {
    requestedUrl = url; options = supplied;
    return Response.json({ items: [resource()] });
  });
  client.token = 'test-access-token';
  assert.equal((await client.video('video')).id, 'video');
  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get('id'), 'video');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.headers['Cache-Control'], 'no-cache');
  assert.equal(options.headers.Pragma, 'no-cache');
  assert.equal(options.redirect, 'manual');
});
test('API runner reads persisted resource in verify and never writes or opens Ego', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-api-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkpoint = path.join(root, 'checkpoint');
  fs.writeFileSync(`${checkpoint}.youtube-api.json`, JSON.stringify({ fingerprint: 'fp', channelId: 'channel', videoId: 'video', savedAt: new Date().toISOString() }));
  let reads = 0;
  const client = { authenticate: async () => {}, video: async () => { reads++; return resource(); }, json: () => { throw new Error('unexpected write'); } };
  const result = await runYoutubeApi({ pkg, phase: 'verify' }, { client, credentials,
    env: { VIDEO_PUBLISHER_V2_FINGERPRINT: 'fp', VIDEO_PUBLISHER_V2_CHECKPOINT_PATH: checkpoint, VIDEO_PUBLISHER_V2_VERIFICATION_RUN_ID: 'run' } });
  assert.equal(evaluateObservation(result).ready, true);
  assert.equal(reads, 2);
});
test('legacy Studio receipts block migration without duplicate upload', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-api-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await runYoutubeApi({ pkg, phase: 'upload' }, { credentials, client: { authenticate: () => { throw new Error('should not contact API'); } },
    env: { VIDEO_PUBLISHER_V2_FINGERPRINT: 'fp', VIDEO_PUBLISHER_V2_CHECKPOINT_PATH: path.join(root, 'checkpoint'), VIDEO_PUBLISHER_V2_RECEIPTS: '{"cover":{}}' } });
  assert.equal(result.blocker.code, 'API_CONFIGURATION_REQUIRED');
  assert.match(result.blocker.message, /Legacy Studio/);
});

test('empty API job schedules upload after inspection instead of becoming an action blocker', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-api-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await runYoutubeApi({ pkg, phase: 'inspect' }, { credentials, client: { authenticate: async () => {} },
    env: { VIDEO_PUBLISHER_V2_FINGERPRINT: 'fp', VIDEO_PUBLISHER_V2_CHECKPOINT_PATH: path.join(root, 'checkpoint') } });
  assert.equal(result.blocker, undefined);
  assert.equal(classifyVerdict(evaluateObservation(result)), 'needs_upload');
});

function tagRevisionFixture(t, stateOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-tag-revision-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkpointPath = path.join(root, 'checkpoint');
  const stateFile = `${checkpointPath}.youtube-api.json`;
  const state = { fingerprint: 'previous-fp', channelId: 'channel', videoId: 'video',
    savedAt: '2026-10-09T00:00:00.000Z', ...stateOverrides };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const args = { previousPkg: structuredClone(pkg), nextPkg: { ...structuredClone(pkg), youtubeTags: ['new', 'tags'] },
    previousFingerprint: 'previous-fp', nextFingerprint: 'next-fp', checkpointPath, expectedVideoId: 'video' };
  let reads = 0;
  const client = { authenticate: async () => {}, video: async () => { reads++; return resource(); },
    json: async () => { throw new Error('unexpected API write'); },
    request: async () => { throw new Error('unexpected upload session'); } };
  return { root, stateFile, state, args, client, reads: () => reads };
}

test('tag revision authenticates and reads the same completed private video, with no insert or API mutation', async t => {
  const fixture = tagRevisionFixture(t, { uploadIntent: true, sessionUrl: 'https://www.googleapis.com/upload/completed-session' });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'test-access-token' });
    if (url.endsWith('channels?part=id&mine=true')) return Response.json({ items: [{ id: 'channel' }] });
    if (url.includes('/youtube/v3/videos?part=') && !options.method) return Response.json({ items: [resource()] });
    throw new Error('unexpected API mutation or upload');
  };
  const result = await prepareYoutubeTagRevision({ ...fixture.args, fetchImpl }, { credentials });
  assert.equal(result.prepared, true);
  assert.equal(result.idempotent, false);
  assert.equal(result.videoId, 'video');
  assert.equal(calls.length, 3);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(calls.every(call => !call.url.includes('/upload/')));
  const saved = JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8'));
  assert.equal(saved.fingerprint, 'next-fp');
  assert.equal(saved.videoId, fixture.state.videoId);
  assert.equal(saved.savedAt, fixture.state.savedAt);
  assert.equal(saved.sessionUrl, fixture.state.sessionUrl);
  assert.equal(saved.metadataRevision.from, 'previous-fp');
  assert.equal(saved.metadataRevision.to, 'next-fp');
  assert.equal(saved.metadataRevision.previousMetadataVerified, true);
  assert.deepEqual(saved.metadataRevision.previousTags, pkg.youtubeTags);
  assert.deepEqual(saved.metadataRevision.nextTags, fixture.args.nextPkg.youtubeTags);
  assert.equal(fs.readFileSync(fixture.stateFile, 'utf8').includes('test-access-token'), false);
  assert.equal(fs.statSync(fixture.stateFile).mode & 0o077, 0);
});

test('tag revision replay is byte-idempotent before the job commits and after metadata update', async t => {
  const fixture = tagRevisionFixture(t);
  await prepareYoutubeTagRevision(fixture.args, { credentials, client: fixture.client });
  const preparedBytes = fs.readFileSync(fixture.stateFile, 'utf8');
  for (const tags of [pkg.youtubeTags, fixture.args.nextPkg.youtubeTags]) {
    const client = { ...fixture.client, video: async () => {
      const video = resource(); video.snippet.tags = [...tags]; return video;
    } };
    const result = await prepareYoutubeTagRevision(fixture.args, { credentials, client });
    assert.equal(result.idempotent, true);
    assert.equal(result.videoId, 'video');
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), preparedBytes);
  }
});

test('tag revision rejects missing, ambiguous and upload-in-progress identities before contacting the API', async t => {
  const states = [
    { fingerprint: 'foreign-fp' }, { fingerprint: 'next-fp' }, { videoId: undefined },
    { videoId: '', uploadIntent: true, sessionUrl: 'https://www.googleapis.com/upload/session' },
    { channelId: 'foreign-channel' }, { metadataRevision: { to: 'unrelated-fp', videoId: 'video', channelId: 'channel' } },
  ];
  for (const state of states) {
    const fixture = tagRevisionFixture(t, state);
    const before = fs.readFileSync(fixture.stateFile, 'utf8');
    let authenticated = false;
    await assert.rejects(prepareYoutubeTagRevision(fixture.args, { credentials, client: {
      authenticate: async () => { authenticated = true; },
    } }), error => ['STATE_AMBIGUOUS', 'FOREIGN_DRAFT'].includes(error.code));
    assert.equal(authenticated, false);
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
  }
  const missing = tagRevisionFixture(t);
  fs.unlinkSync(missing.stateFile);
  await assert.rejects(prepareYoutubeTagRevision(missing.args, { credentials, client: missing.client }), /readable existing API checkpoint/);
  assert.equal(fs.existsSync(missing.stateFile), false);
  const malformed = tagRevisionFixture(t);
  fs.writeFileSync(malformed.stateFile, 'not JSON containing a secret');
  await assert.rejects(prepareYoutubeTagRevision(malformed.args, { credentials, client: malformed.client }), error =>
    error.code === 'STATE_AMBIGUOUS' && !error.message.includes('secret'));
  assert.equal(malformed.reads(), 0);
});

test('tag revision requires the original verified video ID before contacting the API', async t => {
  for (const expectedVideoId of [undefined, '', ' ', ' video ', 123]) {
    const fixture = tagRevisionFixture(t);
    const before = fs.readFileSync(fixture.stateFile, 'utf8');
    let authenticated = false;
    await assert.rejects(prepareYoutubeTagRevision({ ...fixture.args, expectedVideoId }, { credentials, client: {
      authenticate: async () => { authenticated = true; },
    } }), error => error.code === 'API_CONFIGURATION_REQUIRED' && /original verified video ID/.test(error.message));
    assert.equal(authenticated, false);
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
  }
});

test('tag revision cannot retarget a same-channel private video with identical metadata, including replay', async t => {
  for (const replay of [false, true]) {
    const fixture = tagRevisionFixture(t);
    if (replay) await prepareYoutubeTagRevision(fixture.args, { credentials, client: fixture.client });
    const checkpoint = JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8'));
    checkpoint.videoId = 'another-identical-video';
    if (checkpoint.metadataRevision) checkpoint.metadataRevision.videoId = checkpoint.videoId;
    fs.writeFileSync(fixture.stateFile, JSON.stringify(checkpoint));
    const before = fs.readFileSync(fixture.stateFile, 'utf8');
    let calls = 0;
    await assert.rejects(prepareYoutubeTagRevision({ ...fixture.args, fetchImpl: async () => {
      calls++;
      return Response.json({ items: [resource('another-identical-video')] });
    } }, { credentials }), error => error.code === 'STATE_AMBIGUOUS' && /original verified video ID/.test(error.message));
    assert.equal(calls, 0);
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
  }
});

test('tag revision rejects every change beyond tags without API calls or checkpoint writes', async t => {
  for (const mutate of [
    p => p.title = 'Changed', p => p.youtubeDescription = 'Changed', p => p.videoPath = '/different.mp4',
    p => p.youtubeAudience = 'made_for_kids', p => p.youtubeVisibility = 'unlisted',
    p => p.youtubeCategory = '22', p => p.youtubeLicense = 'creative_commons',
    p => p.youtubeAllowEmbedding = false, p => p.youtubeAlteredContent = true,
    p => p.youtubePaidPromotion = true, p => p.youtubeLanguage = 'en',
    p => p.youtubeNotifySubscribers = true, p => p.cover = { uploadCustomCover: true, horizontal16x9Path: '/different.png' },
  ]) {
    const fixture = tagRevisionFixture(t);
    mutate(fixture.args.nextPkg);
    const before = fs.readFileSync(fixture.stateFile, 'utf8');
    await assert.rejects(prepareYoutubeTagRevision(fixture.args, { credentials, client: fixture.client }), /may change only tags/);
    assert.equal(fixture.reads(), 0);
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
  }
});

test('tag revision allows the coordinated final WeChat hashtag tail and preserves exact description prose', async t => {
  const fixture = tagRevisionFixture(t);
  fixture.args.previousPkg.wechatDescription = 'Exact approved WeChat body\n\n#a #b';
  fixture.args.previousPkg.wechatTags = ['a', 'b'];
  fixture.args.nextPkg.wechatDescription = 'Exact approved WeChat body\n\n#new #tags';
  fixture.args.nextPkg.wechatTags = ['new', 'tags'];
  for (const field of ['tags', 'xhsTopics', 'douyinTopics', 'bilibiliTags']) {
    fixture.args.previousPkg[field] = ['a', 'b'];
    fixture.args.nextPkg[field] = ['new', 'tags'];
  }
  await prepareYoutubeTagRevision(fixture.args, { credentials, client: fixture.client });
  assert.equal(JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8')).fingerprint, 'next-fp');
  assert.equal((await prepareYoutubeTagRevision(fixture.args, { credentials, client: fixture.client })).idempotent, true);
  for (const [previousDescription, nextDescription] of [
    ['Approved body\n\n#a #b', 'Changed body\n\n#new #tags'],
    ['Approved body\n\n#a #b', 'Approved body\n\n#wrong #tags'],
    ['Approved body\n\n#a #b', 'Approved body\n#new #tags'],
    ['Approved body', 'Approved body\n\n#new #tags'],
    ['Approved body\n\n#a #b\n', 'Approved body\n\n#new #tags'],
    ['Approved body\n\n#a #b', 'Approved body\n\n#new #tags\n'],
  ]) {
    const invalid = tagRevisionFixture(t);
    invalid.args.previousPkg.wechatDescription = previousDescription;
    invalid.args.nextPkg.wechatDescription = nextDescription;
    invalid.args.nextPkg.wechatTags = ['new', 'tags'];
    const before = fs.readFileSync(invalid.stateFile, 'utf8');
    await assert.rejects(prepareYoutubeTagRevision(invalid.args, { credentials, client: invalid.client }), /may change only tags/);
    assert.equal(invalid.reads(), 0);
    assert.equal(fs.readFileSync(invalid.stateFile, 'utf8'), before);
  }
});

test('tag revision independently verifies ownership, private processing, approved fields and all settings', async t => {
  for (const mutate of [
    v => v.id = 'different-video', v => v.snippet.channelId = 'foreign',
    v => v.status.privacyStatus = 'public', v => v.status.privacyStatus = 'unlisted',
    v => v.processingDetails.processingStatus = 'processing', v => v.status.uploadStatus = 'uploaded',
    v => v.snippet.title = 'Changed', v => v.snippet.description = 'Changed',
    v => v.snippet.tags = ['unapproved'], v => v.status.selfDeclaredMadeForKids = true,
    v => delete v.status.selfDeclaredMadeForKids, v => v.snippet.categoryId = '22',
    v => v.status.license = 'creativeCommon', v => v.status.embeddable = false,
    v => v.status.containsSyntheticMedia = true, v => v.paidProductPlacementDetails.hasPaidProductPlacement = true,
  ]) {
    const fixture = tagRevisionFixture(t);
    const video = resource(); mutate(video);
    const before = fs.readFileSync(fixture.stateFile, 'utf8');
    await assert.rejects(prepareYoutubeTagRevision(fixture.args, { credentials,
      client: { ...fixture.client, video: async () => video } }));
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
  }
  const fixture = tagRevisionFixture(t);
  fixture.args.previousPkg.youtubeLanguage = 'zh';
  fixture.args.nextPkg.youtubeLanguage = 'zh';
  await assert.rejects(prepareYoutubeTagRevision(fixture.args, { credentials, client: fixture.client }), /previously approved/);
});

test('tag revision permits new tags only on replay of the exact recorded migration', async t => {
  const fixture = tagRevisionFixture(t);
  const newTagsClient = { ...fixture.client, video: async () => {
    const video = resource(); video.snippet.tags = fixture.args.nextPkg.youtubeTags; return video;
  } };
  await assert.rejects(prepareYoutubeTagRevision(fixture.args, { credentials, client: newTagsClient }), /tags do not match/);
  await prepareYoutubeTagRevision(fixture.args, { credentials, client: fixture.client });
  const preparedBytes = fs.readFileSync(fixture.stateFile, 'utf8');
  for (const mutate of [
    s => s.metadataRevision.from = 'unrelated-fp', s => s.metadataRevision.to = 'unrelated-fp',
    s => s.metadataRevision.videoId = 'different-video', s => s.metadataRevision.channelId = 'foreign-channel',
    s => s.metadataRevision.previousTags = ['unapproved'], s => s.metadataRevision.nextPackageDigest = 'incorrect',
    s => s.metadataRevision.private = false, s => delete s.metadataRevision.preparedAt,
  ]) {
    const state = JSON.parse(preparedBytes); mutate(state);
    fs.writeFileSync(fixture.stateFile, JSON.stringify(state));
    const before = fs.readFileSync(fixture.stateFile, 'utf8');
    await assert.rejects(prepareYoutubeTagRevision(fixture.args, { credentials, client: newTagsClient }), /exact recorded migration/);
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
  }
  fs.writeFileSync(fixture.stateFile, preparedBytes);
  await assert.rejects(prepareYoutubeTagRevision(fixture.args, { credentials, client: {
    ...fixture.client, video: async () => { const video = resource(); video.snippet.tags = ['third-party-change']; return video; },
  } }), /tags do not match/);
});

test('tag revision preserves accepted thumbnail evidence and normal mutate updates only the same existing video', async t => {
  const fixture = tagRevisionFixture(t);
  const asset = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const coverPath = path.join(fixture.root, 'cover.png');
  fs.writeFileSync(coverPath, asset);
  const cover = { uploadCustomCover: true, horizontal16x9Path: coverPath };
  fixture.args.previousPkg.cover = cover;
  fixture.args.nextPkg.cover = structuredClone(cover);
  const thumbnail = { assetHash: createHash('sha256').update(asset).digest('hex'),
    beforeDigest: 'before-upload', serverDigest: 'accepted-image', url: 'https://i.ytimg.com/vi/video/hqdefault.jpg',
    uploadedAt: '2026-10-08T00:00:00.000Z' };
  const state = { ...fixture.state, thumbnail };
  fs.writeFileSync(fixture.stateFile, JSON.stringify(state));
  let video = resource();
  video.snippet.thumbnails = { high: { url: thumbnail.url } };
  const writes = [];
  const client = { authenticate: async () => {}, video: async id => {
    assert.equal(id, 'video'); return structuredClone(video);
  }, thumbnailDigest: async url => {
    assert.equal(url, thumbnail.url); return 'accepted-image';
  }, json: async (url, options) => {
    assert.ok(url.startsWith('https://www.googleapis.com/youtube/v3/videos?'));
    assert.equal(options.method, 'PUT');
    const update = JSON.parse(options.body);
    writes.push(update);
    video = { ...video, ...update, snippet: { ...video.snippet, ...update.snippet },
      status: { ...video.status, ...update.status } };
    return video;
  }, request: async () => { throw new Error('unexpected videos.insert'); } };
  await prepareYoutubeTagRevision(fixture.args, { credentials, client });
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8')).thumbnail, thumbnail);
  const result = await runYoutubeApi({ pkg: fixture.args.nextPkg, phase: 'mutate' }, { credentials, client,
    env: { VIDEO_PUBLISHER_V2_FINGERPRINT: 'next-fp', VIDEO_PUBLISHER_V2_CHECKPOINT_PATH: fixture.args.checkpointPath } });
  assert.equal(evaluateObservation(result).ready, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, 'video');
  assert.deepEqual(writes[0].snippet.tags, ['new', 'tags']);
  const updated = JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8'));
  assert.equal(updated.videoId, 'video');
  assert.deepEqual(updated.thumbnail, thumbnail);
  assert.equal(updated.metadataRevision.from, 'previous-fp');
  assert.equal((await prepareYoutubeTagRevision(fixture.args, { credentials, client })).idempotent, true);
});

test('tag revision blocks unknown thumbnail acceptance, local changes and remote changes without writing', async t => {
  for (const failure of ['no-receipt', 'unverified-receipt', 'local-changed', 'remote-changed']) {
    const fixture = tagRevisionFixture(t);
    const coverPath = path.join(fixture.root, 'cover.png');
    fs.writeFileSync(coverPath, 'approved-thumbnail');
    const cover = { uploadCustomCover: true, horizontal16x9Path: coverPath };
    fixture.args.previousPkg.cover = cover; fixture.args.nextPkg.cover = structuredClone(cover);
    const thumbnail = { assetHash: createHash('sha256').update('approved-thumbnail').digest('hex'),
      beforeDigest: 'before-upload', serverDigest: 'accepted-image' };
    if (failure === 'unverified-receipt') delete thumbnail.serverDigest;
    if (failure === 'local-changed') fs.writeFileSync(coverPath, 'different-thumbnail');
    const state = { ...fixture.state, ...(failure === 'no-receipt' ? {} : { thumbnail }) };
    fs.writeFileSync(fixture.stateFile, JSON.stringify(state));
    const before = fs.readFileSync(fixture.stateFile, 'utf8');
    const video = resource(); video.snippet.thumbnails = { high: { url: 'https://i.ytimg.com/vi/video/hqdefault.jpg' } };
    await assert.rejects(prepareYoutubeTagRevision(fixture.args, { credentials, client: {
      ...fixture.client, video: async () => video,
      thumbnailDigest: async () => failure === 'remote-changed' ? 'unexpected-image' : 'accepted-image',
    } }), error => error.code === 'PERSISTENCE_UNVERIFIED');
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
  }
});

test('tag revision detects concurrent checkpoint replacement and sanitizes unexpected request failures', async t => {
  const fixture = tagRevisionFixture(t);
  const replacement = { ...fixture.state, videoId: 'another-video' };
  await assert.rejects(prepareYoutubeTagRevision(fixture.args, { credentials, client: {
    ...fixture.client, video: async () => {
      fs.writeFileSync(fixture.stateFile, JSON.stringify(replacement)); return resource();
    },
  } }), /changed during verification/);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8')), replacement);
  fs.writeFileSync(fixture.stateFile, JSON.stringify(fixture.state));
  for (const code of [undefined, 'AUTH_REQUIRED']) {
    await assert.rejects(prepareYoutubeTagRevision(fixture.args, { credentials, client: {
      authenticate: async () => {
        throw Object.assign(new Error('Bearer private-access-token; refresh_token=private-refresh-token'), { code });
      },
    } }), error => error.code === 'ACTION_FAILED' && !error.message.includes('token'));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8')), fixture.state);
});

async function migratedRunnerFixture(t) {
  const fixture = tagRevisionFixture(t);
  await prepareYoutubeTagRevision(fixture.args, { credentials, client: fixture.client });
  return { ...fixture, env: { VIDEO_PUBLISHER_V2_FINGERPRINT: 'next-fp',
    VIDEO_PUBLISHER_V2_CHECKPOINT_PATH: fixture.args.checkpointPath, VIDEO_PUBLISHER_V2_VERIFICATION_RUN_ID: 'current-run' },
  updatedResource: () => {
    const video = resource();
    video.snippet.tags = [...fixture.args.nextPkg.youtubeTags];
    video.etag = 'read-new-etag';
    return video;
  } };
}

test('tag mutation waits for independent readback to converge and keeps its PUT receipt separate', async t => {
  const fixture = await migratedRunnerFixture(t);
  let reads = 0, updates = 0;
  const sleeps = [];
  const client = { authenticate: async () => {}, video: async id => {
    assert.equal(id, 'video'); reads++;
    return reads < 4 ? resource() : fixture.updatedResource();
  }, json: async (url, options) => {
    assert.equal(options.method, 'PUT');
    assert.ok(url.startsWith('https://www.googleapis.com/youtube/v3/videos?'));
    assert.equal(JSON.parse(options.body).id, 'video');
    updates++;
    return { ...fixture.updatedResource(), etag: 'write-response-etag',
      access_token: 'never-include-token', refresh_token: 'never-include-refresh-token', untrustedExtra: { secret: 'omit' } };
  } };
  const result = await runYoutubeApi({ pkg: fixture.args.nextPkg, phase: 'mutate' }, { credentials, client,
    env: fixture.env, sleep: async ms => { sleeps.push(ms); } });
  assert.equal(evaluateObservation(result).ready, true);
  assert.equal(updates, 1);
  assert.equal(reads, 4);
  assert.deepEqual(sleeps, [2000, 2000]);
  assert.equal(result.evidence.metadataReadback.tagReadbackRetries, 2);
  assert.equal(result.evidence.metadataReadback.etag, 'read-new-etag');
  assert.equal(result.evidence.metadataUpdate.etag, 'write-response-etag');
  assert.equal(result.evidence.metadataUpdate.writeReceiptOnly, true);
  assert.equal(result.evidence.metadataUpdate.requestedVideoId, 'video');
  assert.equal(result.evidence.metadataUpdate.returnedVideoId, 'video');
  assert.deepEqual(result.evidence.metadataUpdate.returnedTags, ['new', 'tags']);
  assert.equal(result.gates.persistedDraft.evidence.method, 'youtube.videos.list');
  assert.deepEqual(result.gates.tags.evidence.actual, ['new', 'tags']);
  const savedBytes = fs.readFileSync(fixture.stateFile, 'utf8');
  assert.equal(savedBytes.includes('never-include'), false);
  assert.equal(JSON.stringify(result).includes('never-include'), false);
});

test('a matching metadata PUT response cannot make stale list tags READY after four bounded reads', async t => {
  const fixture = await migratedRunnerFixture(t);
  let reads = 0, updates = 0;
  const sleeps = [];
  const client = { authenticate: async () => {}, video: async id => {
    assert.equal(id, 'video'); reads++; return resource();
  }, json: async (_url, options) => {
    assert.equal(options.method, 'PUT'); updates++; return fixture.updatedResource();
  } };
  const result = await runYoutubeApi({ pkg: fixture.args.nextPkg, phase: 'mutate' }, { credentials, client,
    env: fixture.env, sleep: async ms => { sleeps.push(ms); } });
  assert.equal(evaluateObservation(result).ready, false);
  assert.deepEqual(evaluateObservation(result).missing, ['tags']);
  assert.equal(updates, 1);
  assert.equal(reads, 6);
  assert.deepEqual(sleeps, [2000, 2000, 2000, 2000]);
  assert.equal(result.evidence.metadataReadback.tagReadbackRetries, 4);
  assert.deepEqual(result.gates.tags.evidence.actual, pkg.youtubeTags);
  assert.deepEqual(result.evidence.metadataUpdate.returnedTags, ['new', 'tags']);
  const checkpoint = JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8'));
  assert.equal(checkpoint.videoId, 'video');
  assert.equal(checkpoint.metadataRevision.videoId, 'video');
});

test('inspect, persist and verify never wait or mutate while tag readback still lags', async t => {
  for (const phase of ['inspect', 'persist', 'verify']) {
    const fixture = await migratedRunnerFixture(t);
    const before = fs.readFileSync(fixture.stateFile, 'utf8');
    let reads = 0, sleeps = 0, updates = 0;
    const result = await runYoutubeApi({ pkg: fixture.args.nextPkg, phase }, { credentials,
      env: fixture.env, sleep: async () => { sleeps++; }, client: {
        authenticate: async () => {}, video: async () => { reads++; return resource(); },
        json: async () => { updates++; throw new Error('unexpected API write'); },
      } });
    assert.equal(evaluateObservation(result).ready, false);
    assert.equal(reads, 2);
    assert.equal(sleeps, 0);
    assert.equal(updates, 0);
    assert.equal(result.evidence.metadataReadback.tagReadbackRetries, 0);
    assert.equal(fs.readFileSync(fixture.stateFile, 'utf8'), before);
  }
});

test('tag mutation does not wait when another metadata, identity, private or processing gate is unknown', async t => {
  for (const change of [v => delete v.status.selfDeclaredMadeForKids,
    v => delete v.status.license, v => v.snippet.title = 'unapproved-title',
    v => v.snippet.channelId = 'foreign-owner', v => v.status.privacyStatus = 'public',
    v => v.processingDetails.processingStatus = 'processing']) {
    const fixture = await migratedRunnerFixture(t);
    let reads = 0, sleeps = 0;
    const result = await runYoutubeApi({ pkg: fixture.args.nextPkg, phase: 'mutate' }, { credentials,
      env: fixture.env, sleep: async () => { sleeps++; }, client: {
        authenticate: async () => {}, video: async () => {
          reads++; const video = resource(); if (reads > 1) change(video); return video;
        }, json: async () => fixture.updatedResource(),
      } });
    assert.equal(evaluateObservation(result).ready, false);
    assert.equal(reads, 2);
    assert.equal(sleeps, 0);
    assert.equal(result.evidence.metadataReadback.tagReadbackRetries, 0);
  }
});

test('bounded tag rereads stop immediately if a later read no longer proves another required gate', async t => {
  const fixture = await migratedRunnerFixture(t);
  let reads = 0, sleeps = 0;
  const result = await runYoutubeApi({ pkg: fixture.args.nextPkg, phase: 'mutate' }, { credentials,
    env: fixture.env, sleep: async () => { sleeps++; }, client: {
      authenticate: async () => {}, video: async id => {
        assert.equal(id, 'video'); reads++;
        const video = reads > 2 ? fixture.updatedResource() : resource();
        if (reads > 2) delete video.status.license;
        return video;
      }, json: async () => fixture.updatedResource(),
    } });
  assert.equal(evaluateObservation(result).ready, false);
  assert.equal(result.gates.tags.ok, true);
  assert.equal(result.gates.settings.ok, false);
  assert.equal(reads, 3);
  assert.equal(sleeps, 1);
});

test('tag rereads reverify the accepted thumbnail and stop if its independent bytes change', async t => {
  const fixture = tagRevisionFixture(t);
  const asset = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const assetPath = path.join(fixture.root, 'cover.png');
  fs.writeFileSync(assetPath, asset);
  const cover = { uploadCustomCover: true, horizontal16x9Path: assetPath };
  fixture.args.previousPkg.cover = cover;
  fixture.args.nextPkg.cover = structuredClone(cover);
  const thumbnail = { assetHash: createHash('sha256').update(asset).digest('hex'),
    beforeDigest: 'before-upload', serverDigest: 'accepted-image', url: 'https://i.ytimg.com/vi/video/hqdefault.jpg' };
  fs.writeFileSync(fixture.stateFile, JSON.stringify({ ...fixture.state, thumbnail }));
  const withThumbnail = tags => {
    const video = resource();
    video.snippet.tags = [...tags];
    video.snippet.thumbnails = { high: { url: thumbnail.url } };
    return video;
  };
  await prepareYoutubeTagRevision(fixture.args, { credentials, client: { authenticate: async () => {},
    video: async () => withThumbnail(pkg.youtubeTags), thumbnailDigest: async () => 'accepted-image' } });
  let reads = 0, imageReads = 0, sleeps = 0, updates = 0;
  const result = await runYoutubeApi({ pkg: fixture.args.nextPkg, phase: 'mutate' }, { credentials,
    env: { VIDEO_PUBLISHER_V2_FINGERPRINT: 'next-fp', VIDEO_PUBLISHER_V2_CHECKPOINT_PATH: fixture.args.checkpointPath },
    sleep: async () => { sleeps++; }, client: {
      authenticate: async () => {}, video: async id => {
        assert.equal(id, 'video'); reads++;
        return withThumbnail(reads > 3 ? fixture.args.nextPkg.youtubeTags : pkg.youtubeTags);
      }, thumbnailDigest: async () => { imageReads++; return imageReads === 1 ? 'accepted-image' : 'changed-server-image'; },
      json: async (_url, options) => {
        assert.equal(options.method, 'PUT'); updates++;
        return withThumbnail(fixture.args.nextPkg.youtubeTags);
      },
    } });
  assert.equal(evaluateObservation(result).ready, false);
  assert.equal(result.gates.tags.ok, true);
  assert.equal(result.gates.cover.ok, false);
  assert.equal(reads, 4);
  assert.equal(imageReads, 2);
  assert.equal(sleeps, 1);
  assert.equal(updates, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8')).thumbnail, thumbnail);
});

test('ordinary metadata mutation without a recorded tag migration does not add waits', async t => {
  const fixture = tagRevisionFixture(t);
  let sleeps = 0;
  const video = resource(); video.snippet.tags = ['old-other-tags'];
  const result = await runYoutubeApi({ pkg, phase: 'mutate' }, { credentials,
    env: { VIDEO_PUBLISHER_V2_FINGERPRINT: 'previous-fp', VIDEO_PUBLISHER_V2_CHECKPOINT_PATH: fixture.args.checkpointPath },
    sleep: async () => { sleeps++; }, client: {
      authenticate: async () => {}, video: async () => structuredClone(video), json: async () => resource(),
    } });
  assert.equal(evaluateObservation(result).ready, false);
  assert.equal(sleeps, 0);
  assert.equal(result.evidence.metadataReadback.maxTagReadbackRetries, 0);
});

test('metadata update responses for another ID, owner or visibility cannot continue mutations', async t => {
  for (const change of [v => v.id = 'wrong-video', v => v.snippet.channelId = 'foreign-owner',
    v => v.status.privacyStatus = 'public']) {
    const fixture = await migratedRunnerFixture(t);
    let reads = 0, updates = 0, sleeps = 0;
    const updated = fixture.updatedResource(); change(updated);
    const result = await runYoutubeApi({ pkg: fixture.args.nextPkg, phase: 'mutate' }, { credentials,
      env: fixture.env, sleep: async () => { sleeps++; }, client: {
        authenticate: async () => {}, video: async () => { reads++; return resource(); },
        json: async () => { updates++; return updated; },
      } });
    assert.ok(['STATE_AMBIGUOUS', 'FOREIGN_DRAFT'].includes(result.blocker.code));
    assert.equal(reads, 1);
    assert.equal(updates, 1);
    assert.equal(sleeps, 0);
    const state = JSON.parse(fs.readFileSync(fixture.stateFile, 'utf8'));
    assert.equal(state.videoId, 'video');
    assert.equal(state.metadataUpdate.writeReceiptOnly, true);
    assert.equal(state.metadataUpdate.requestedVideoId, 'video');
  }
});


test('missing default thumbnail is allowed only as an upload baseline, never accepted evidence', async () => {
  const url = 'https://i9.ytimg.com/vi/video/hqdefault.jpg';
  const client = new YoutubeClient(credentials, async () => new Response('', { status: 404 }));
  await assert.rejects(client.thumbnailDigest(url), /cannot be read back/);
  assert.equal(await client.thumbnailDigest(url, { allowMissing: true }),
    createHash('sha256').update('youtube-thumbnail-absent-v1').digest('hex'));
  const unavailable = new YoutubeClient(credentials, async () => new Response('', { status: 503 }));
  await assert.rejects(unavailable.thumbnailDigest(url, { allowMissing: true }), /cannot be read back/);
});
