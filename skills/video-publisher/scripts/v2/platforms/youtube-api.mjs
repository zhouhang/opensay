import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { coverForPlatform, getImageDimensions, uniqueCleanTags } from '../../lib/content-package.mjs';
import { requiredGates, gate } from '../lib/model.mjs';

const API = 'https://www.googleapis.com/youtube/v3/';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/';
const PARTS = 'snippet,status,processingDetails,paidProductPlacementDetails';
export const YOUTUBE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameSet = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
const booleanPropertyEvidence = (object, key) => {
  const present = object !== null && typeof object === 'object' && Object.hasOwn(object, key);
  const value = present ? object[key] : undefined;
  return { present, type: present ? (value === null ? 'null' : typeof value) : 'missing',
    value: typeof value === 'boolean' ? value : null };
};
const apiErrors = new WeakSet();
const fail = (code, message) => {
  const error = Object.assign(new Error(message), { code });
  apiErrors.add(error);
  return error;
};
const revisionTagFields = new Set(['tags', 'xhsTopics', 'douyinTopics', 'bilibiliTags', 'wechatTags', 'youtubeTags']);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const packageWithoutTags = pkg => Object.fromEntries(Object.entries(pkg).filter(([key]) => !revisionTagFields.has(key)));

function onlyRevisionTagsChanged(previousPkg, nextPkg) {
  const previous = packageWithoutTags(previousPkg);
  const next = packageWithoutTags(nextPkg);
  if (previous.wechatDescription !== next.wechatDescription) {
    if (typeof previous.wechatDescription !== 'string' || typeof next.wechatDescription !== 'string') return false;
    const match = previous.wechatDescription.match(/^([\s\S]*(?:\r?\n){2})(#[^\r\n]+)$/u);
    if (!match || !/^#[^\s#]+(?:[ \t]+#[^\s#]+)*$/u.test(match[2])) return false;
    const source = [nextPkg.wechatTags, nextPkg.topics, nextPkg.tags].find(Array.isArray) || [];
    const expectedTail = uniqueCleanTags(source).map(tag => `#${tag}`).join(' ');
    if (!expectedTail || next.wechatDescription !== `${match[1]}${expectedTail}`) return false;
    delete previous.wechatDescription;
    delete next.wechatDescription;
  }
  return canonical(previous) === canonical(next);
}

export function youtubeAuthorizationUrl({ clientId, redirectUri, state, codeChallenge }) {
  if (![clientId, redirectUri, state, codeChallenge].every(Boolean)) {
    throw new Error('OAuth authorization URL requires clientId, redirectUri, state and codeChallenge');
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: YOUTUBE_OAUTH_SCOPE,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.href;
}

export const oauthPath = () => process.env.VIDEO_PUBLISHER_YOUTUBE_OAUTH_FILE
  || path.join(os.homedir(), '.config/video-publisher/youtube-oauth.json');

export function oauthStatus() {
  const file = oauthPath();
  if (!fs.existsSync(file)) return { configured: false, path: file, missing: ['client_id', 'client_secret', 'refresh_token', 'channel_id'] };
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  const missing = ['client_id', 'client_secret', 'refresh_token', 'channel_id'].filter(k => !p[k]);
  const privateFile = (fs.statSync(file).mode & 0o077) === 0;
  return { configured: !missing.length && privateFile, path: file, missing, privateFile };
}

function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function expectedYoutube(pkg, credentials) {
  if (pkg.youtubeVisibility !== 'private') throw fail('API_CONFIGURATION_REQUIRED', 'API delivery only permits private videos, not public/unlisted publishing');
  if (pkg.youtubePlaylist) throw fail('API_CONFIGURATION_REQUIRED', 'Playlist API verification is not implemented; do not silently omit the requested playlist');
  const categoryId = String(pkg.youtubeCategory || credentials.default_category_id || '');
  if (!/^\d+$/.test(categoryId)) throw fail('API_CONFIGURATION_REQUIRED', 'Set a numeric youtubeCategory or OAuth default_category_id');
  return {
    snippet: { title: pkg.platformTitle?.youtube || pkg.title, description: pkg.youtubeDescription,
      tags: [...(pkg.youtubeTags || [])], categoryId, ...(pkg.youtubeLanguage ? { defaultLanguage: pkg.youtubeLanguage } : {}) },
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: pkg.youtubeAudience === 'made_for_kids',
      license: pkg.youtubeLicense === 'creative_commons' ? 'creativeCommon' : 'youtube',
      embeddable: pkg.youtubeAllowEmbedding !== false, containsSyntheticMedia: pkg.youtubeAlteredContent === true },
    paidProductPlacementDetails: { hasPaidProductPlacement: pkg.youtubePaidPromotion === true },
  };
}

export class YoutubeClient {
  constructor(credentials, fetchImpl = fetch) { this.credentials = credentials; this.fetch = fetchImpl; }
  async authenticate() {
    const r = await this.fetch('https://oauth2.googleapis.com/token', { method: 'POST',
      signal: AbortSignal.timeout(30000), body: new URLSearchParams({
        client_id: this.credentials.client_id, client_secret: this.credentials.client_secret,
        refresh_token: this.credentials.refresh_token, grant_type: 'refresh_token',
      }) });
    if (!r.ok) throw fail('AUTH_REQUIRED', `YouTube OAuth refresh failed (${r.status}); authorize again`);
    const token = await r.json();
    if (!token.access_token) throw fail('AUTH_REQUIRED', 'OAuth returned no access token');
    this.token = token.access_token;
    const channels = await this.json(`${API}channels?part=id&mine=true`);
    if (!channels.items?.some(item => item.id === this.credentials.channel_id)) throw fail('AUTH_REQUIRED', 'Authorized YouTube channel does not match configured channel_id');
  }
  async request(url, options = {}) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'www.googleapis.com') throw fail('STATE_AMBIGUOUS', 'Refusing non-Google API/session URL');
    const r = await this.fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(120000),
      headers: { Authorization: `Bearer ${this.token}`, ...options.headers } });
    if (r.status === 308) return r;
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const reason = body.error?.errors?.[0]?.reason || '';
      const code = r.status === 401 ? 'AUTH_REQUIRED' : /quota|rateLimit/i.test(reason) ? 'QUOTA_EXCEEDED' : 'ACTION_FAILED';
      throw fail(code, `YouTube API ${r.status}${reason ? ` (${reason})` : ''}`);
    }
    return r;
  }
  async json(url, options) { return (await this.request(url, options)).json(); }
  async video(id) {
    const resource = await this.json(`${API}videos?part=${PARTS}&id=${encodeURIComponent(id)}`, {
      cache: 'no-store', headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (resource.items?.length !== 1 || resource.items[0].id !== id) throw fail('STATE_AMBIGUOUS', 'Uploaded video ID not found; no automatic replacement upload');
    return resource.items[0];
  }
  async thumbnailDigest(url, { allowMissing = false } = {}) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !['i.ytimg.com', 'i9.ytimg.com'].includes(u.hostname)) throw fail('PERSISTENCE_UNVERIFIED', 'Unexpected thumbnail host');
    const r = await this.fetch(u.href, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (r.status === 404 && allowMissing) return hash(Buffer.from('youtube-thumbnail-absent-v1'));
    if (!r.ok || !r.headers.get('content-type')?.startsWith('image/')) throw fail('PERSISTENCE_UNVERIFIED', 'Thumbnail image cannot be read back');
    return hash(Buffer.from(await r.arrayBuffer()));
  }
}

export async function bindExistingYoutubeVideo({ pkg, fingerprint, checkpointPath, videoId }, dependencies = {}) {
  if (!pkg || !fingerprint || !checkpointPath || !videoId) {
    throw fail('API_CONFIGURATION_REQUIRED', 'Existing YouTube binding requires package, fingerprint, checkpoint path and video ID');
  }
  const status = dependencies.credentials ? null : oauthStatus();
  if (status && !status.configured) {
    throw fail('API_CONFIGURATION_REQUIRED', `YouTube OAuth configuration missing or not mode 0600: ${status.path}`);
  }
  const credentials = dependencies.credentials || JSON.parse(fs.readFileSync(status.path, 'utf8'));
  const expected = expectedYoutube(pkg, credentials);
  const client = dependencies.client || new YoutubeClient(credentials);
  await client.authenticate();
  const video = await client.video(videoId);
  if (video.snippet?.channelId !== credentials.channel_id) throw fail('FOREIGN_DRAFT', 'Existing YouTube video owner mismatch');
  if (video.status?.privacyStatus !== 'private') throw fail('STATE_AMBIGUOUS', 'Existing YouTube video is not private; refusing migration');
  if (video.processingDetails?.processingStatus !== 'succeeded' || video.status?.uploadStatus !== 'processed') {
    throw fail('PLATFORM_REJECTED_ASSET', 'Existing YouTube video has not completed processing');
  }
  if (video.snippet?.title !== expected.snippet.title
    || video.snippet?.description !== expected.snippet.description
    || !sameSet(video.snippet?.tags, expected.snippet.tags)) {
    throw fail('STATE_AMBIGUOUS', 'Existing YouTube video content metadata does not match the approved package');
  }
  const stateFile = `${checkpointPath}.youtube-api.json`;
  if (fs.existsSync(stateFile)) {
    const existing = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (existing.fingerprint !== fingerprint || existing.channelId !== credentials.channel_id
      || (existing.videoId && existing.videoId !== videoId) || existing.sessionUrl || existing.uploadIntent) {
      throw fail('STATE_AMBIGUOUS', 'Existing API checkpoint conflicts with this package, channel or video ID');
    }
  }
  const savedAt = new Date().toISOString();
  const state = {
    fingerprint,
    channelId: credentials.channel_id,
    videoId,
    savedAt,
    binding: {
      method: 'youtube.videos.list',
      boundAt: savedAt,
      contentMetadataVerified: true,
      private: true,
      processed: true,
    },
  };
  atomicJson(stateFile, state);
  return { bound: true, videoId, channelId: credentials.channel_id, fingerprint, stateFile };
}

export async function prepareYoutubeTagRevision({ previousPkg, nextPkg, previousFingerprint, nextFingerprint, checkpointPath, expectedVideoId, fetchImpl }, dependencies = {}) {
  if (!previousPkg || !nextPkg || !checkpointPath || !previousFingerprint || !nextFingerprint
    || previousFingerprint === nextFingerprint || typeof expectedVideoId !== 'string'
    || !expectedVideoId || expectedVideoId.trim() !== expectedVideoId) {
    throw fail('API_CONFIGURATION_REQUIRED', 'YouTube tag revision requires both approved packages, distinct fingerprints, an existing checkpoint path and the original verified video ID');
  }
  if (!onlyRevisionTagsChanged(previousPkg, nextPkg)) {
    throw fail('STATE_AMBIGUOUS', 'YouTube tag revision may change only tags and the exact existing WeChat hashtag tail; video, titles, description prose, settings and covers must stay unchanged');
  }
  const stateFile = `${checkpointPath}.youtube-api.json`;
  let checkpointBytes, state;
  try {
    checkpointBytes = fs.readFileSync(stateFile, 'utf8');
    state = JSON.parse(checkpointBytes);
  } catch {
    throw fail('STATE_AMBIGUOUS', 'YouTube tag revision requires a readable existing API checkpoint; no new upload is permitted');
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || typeof state.videoId !== 'string' || !state.videoId.trim()) {
    throw fail('STATE_AMBIGUOUS', 'YouTube tag revision requires a completed upload with the same recorded video ID; upload-in-progress checkpoints cannot migrate');
  }
  if (state.videoId !== expectedVideoId) {
    throw fail('STATE_AMBIGUOUS', 'YouTube tag revision checkpoint video ID does not match the original verified video ID');
  }
  if (![previousFingerprint, nextFingerprint].includes(state.fingerprint)) {
    throw fail('STATE_AMBIGUOUS', 'YouTube tag revision checkpoint belongs to an unknown content fingerprint');
  }
  let credentials;
  try {
    const status = dependencies.credentials ? null : oauthStatus();
    if (status && !status.configured) throw fail('API_CONFIGURATION_REQUIRED', 'YouTube OAuth configuration is missing or not mode 0600');
    credentials = dependencies.credentials || JSON.parse(fs.readFileSync(status.path, 'utf8'));
  } catch {
    throw fail('API_CONFIGURATION_REQUIRED', 'YouTube OAuth configuration is missing, unreadable or not mode 0600');
  }
  if (state.channelId !== credentials.channel_id) {
    throw fail('FOREIGN_DRAFT', 'YouTube tag revision checkpoint owner does not match the configured channel');
  }
  const previousMetadata = expectedYoutube(previousPkg, credentials);
  const nextMetadata = expectedYoutube(nextPkg, credentials);
  const expectedRevision = {
    version: 1, kind: 'tags', platform: 'youtube', from: previousFingerprint, to: nextFingerprint,
    videoId: expectedVideoId, channelId: state.channelId,
    previousPackageDigest: hash(canonical(previousPkg)), nextPackageDigest: hash(canonical(nextPkg)),
    previousTags: previousMetadata.snippet.tags, nextTags: nextMetadata.snippet.tags,
    method: 'youtube.videos.list', private: true, processed: true, previousMetadataVerified: true,
  };
  const replay = state.fingerprint === nextFingerprint;
  if (replay && (!state.metadataRevision
    || Object.entries(expectedRevision).some(([key, value]) => canonical(state.metadataRevision[key]) !== canonical(value))
    || typeof state.metadataRevision.preparedAt !== 'string' || !Number.isFinite(Date.parse(state.metadataRevision.preparedAt)))) {
    throw fail('STATE_AMBIGUOUS', 'YouTube tag revision checkpoint has no exact recorded migration for these packages, channel and video ID');
  }
  if (!replay && state.metadataRevision && (state.metadataRevision.to !== previousFingerprint
    || state.metadataRevision.version !== 1 || state.metadataRevision.kind !== 'tags'
    || state.metadataRevision.videoId !== state.videoId || state.metadataRevision.channelId !== state.channelId
    || (state.metadataRevisionHistory && !Array.isArray(state.metadataRevisionHistory)))) {
    throw fail('STATE_AMBIGUOUS', 'YouTube tag revision checkpoint contains a conflicting metadata migration');
  }
  const client = dependencies.client || new YoutubeClient(credentials, fetchImpl);
  try {
    await client.authenticate();
    const video = await client.video(expectedVideoId);
    if (video.id !== expectedVideoId) throw fail('STATE_AMBIGUOUS', 'YouTube tag revision readback did not return the original verified video ID');
    if (video.snippet?.channelId !== credentials.channel_id) throw fail('FOREIGN_DRAFT', 'YouTube tag revision video owner mismatch');
    if (video.status?.privacyStatus !== 'private') throw fail('STATE_AMBIGUOUS', 'YouTube tag revision requires an existing private video');
    if (video.processingDetails?.processingStatus !== 'succeeded' || video.status?.uploadStatus !== 'processed') {
      throw fail('PLATFORM_REJECTED_ASSET', 'YouTube tag revision requires a video that has completed processing');
    }
    const tagsArePrevious = sameSet(video.snippet?.tags, previousMetadata.snippet.tags);
    const tagsAreNext = replay && sameSet(video.snippet?.tags, nextMetadata.snippet.tags);
    if (!tagsArePrevious && !tagsAreNext) {
      throw fail('STATE_AMBIGUOUS', 'YouTube tag revision readback tags do not match the approved package or recorded migration');
    }
    const cover = coverForPlatform(previousPkg, 'youtube');
    let thumbnailVerified = !cover.uploadCustomCover;
    if (cover.uploadCustomCover || state.thumbnail) {
      const receipt = state.thumbnail;
      const url = video.snippet?.thumbnails?.high?.url;
      if (!receipt?.assetHash || !receipt.beforeDigest || !receipt.serverDigest || receipt.serverDigest === receipt.beforeDigest || !url) {
        throw fail('PERSISTENCE_UNVERIFIED', 'YouTube tag revision requires the previously accepted thumbnail checkpoint and server image');
      }
      if (cover.uploadCustomCover && hash(fs.readFileSync(cover.horizontal16x9Path)) !== receipt.assetHash) {
        throw fail('PERSISTENCE_UNVERIFIED', 'YouTube tag revision thumbnail asset does not match the accepted checkpoint');
      }
      thumbnailVerified = await client.thumbnailDigest(url) === receipt.serverDigest;
      if (!thumbnailVerified) throw fail('PERSISTENCE_UNVERIFIED', 'YouTube tag revision server thumbnail differs from the accepted checkpoint');
    }
    const metadata = tagsAreNext ? nextMetadata : previousMetadata;
    const readback = youtubeReadback(previousPkg, metadata, video, state, {
      channelId: credentials.channel_id, fingerprint: state.fingerprint, verificationRunId: randomUUID(),
      phase: 'prepare-tag-revision', thumbnailVerified,
    });
    if (['title', 'description', 'audience', 'settings', 'cover'].some(key => !readback.gates[key].ok)) {
      throw fail('STATE_AMBIGUOUS', 'YouTube tag revision readback differs from the previously approved title, description, audience, settings or thumbnail');
    }
    const currentCheckpointBytes = fs.readFileSync(stateFile, 'utf8');
    if (currentCheckpointBytes !== checkpointBytes) {
      throw fail('STATE_AMBIGUOUS', 'YouTube tag revision checkpoint changed during verification; retain it and retry under the job lock');
    }
    if (JSON.parse(currentCheckpointBytes).videoId !== expectedVideoId) {
      throw fail('STATE_AMBIGUOUS', 'YouTube tag revision checkpoint no longer matches the original verified video ID');
    }
    if (!replay) {
      if (state.metadataRevision) state.metadataRevisionHistory = [...(state.metadataRevisionHistory || []), state.metadataRevision];
      state.fingerprint = nextFingerprint;
      state.metadataRevision = { ...expectedRevision, preparedAt: new Date().toISOString() };
      // Migrate identity before the job commits. A retry can verify either approved tag set
      // only when this exact from/to record exists; it never starts an upload session.
      atomicJson(stateFile, state);
    }
    return { prepared: true, idempotent: replay, videoId: state.videoId, channelId: state.channelId,
      fingerprint: nextFingerprint, stateFile, metadataRevision: state.metadataRevision };
  } catch (error) {
    if (apiErrors.has(error)) throw error;
    throw fail('ACTION_FAILED', 'YouTube tag revision verification failed; retain the checkpoint and retry without creating another upload');
  }
}

export async function uploadResumable(client, pkg, metadata, state, save) {
  if (state.videoId) return state.videoId;
  const size = fs.statSync(pkg.videoPath).size;
  if (!state.sessionUrl) {
    if (state.uploadIntent) throw fail('STATE_AMBIGUOUS', 'Upload session creation outcome is uncertain; refusing duplicate videos.insert');
    state.uploadIntent = true; save();
    const r = await client.request(`${UPLOAD}videos?uploadType=resumable&part=snippet,status,paidProductPlacementDetails&notifySubscribers=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size) }, body: JSON.stringify(metadata),
    });
    state.sessionUrl = r.headers.get('location');
    if (!state.sessionUrl) throw fail('STATE_AMBIGUOUS', 'No resumable upload session URL');
    save();
  }
  // Probe the same session after every interruption; never restart videos.insert.
  let probe = await client.request(state.sessionUrl, { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` } });
  if (probe.status !== 308) {
    const resource = await probe.json();
    if (!resource.id) throw fail('STATE_AMBIGUOUS', 'Completed upload response has no video ID');
    state.videoId = resource.id; state.savedAt = new Date().toISOString(); save(); return resource.id;
  }
  const range = probe.headers.get('range');
  if (range && !/^bytes=0-\d+$/.test(range)) throw fail('STATE_AMBIGUOUS', 'Invalid upload range');
  let offset = range ? Number(range.split('-')[1]) + 1 : 0;
  const file = fs.openSync(pkg.videoPath, 'r');
  try {
    while (offset < size) {
      const length = Math.min(8 * 1024 * 1024, size - offset);
      const bytes = Buffer.alloc(length);
      if (fs.readSync(file, bytes, 0, length, offset) !== length) throw fail('ACTION_FAILED', 'Source video changed during upload');
      probe = await client.request(state.sessionUrl, { method: 'PUT', headers: {
        'Content-Type': 'video/mp4', 'Content-Length': String(length), 'Content-Range': `bytes ${offset}-${offset + length - 1}/${size}`,
      }, body: bytes });
      if (probe.status !== 308) {
        const resource = await probe.json();
        if (!resource.id) throw fail('STATE_AMBIGUOUS', 'Completed upload response has no video ID');
        state.videoId = resource.id; state.savedAt = new Date().toISOString(); save(); return resource.id;
      }
      const accepted = probe.headers.get('range');
      if (!/^bytes=0-\d+$/.test(accepted || '')) throw fail('UPLOAD_STALLED', 'Missing accepted upload range');
      const next = Number(accepted.split('-')[1]) + 1;
      if (next <= offset || next > offset + length) throw fail('UPLOAD_STALLED', 'Upload range did not advance correctly');
      offset = next;
    }
  } finally { fs.closeSync(file); }
  throw fail('UPLOAD_STALLED', 'Final video ID is not available; resume the same session');
}

export function youtubeReadback(pkg, metadata, video, state, context) {
  const gates = Object.fromEntries(requiredGates('youtube').map(name => [name, gate(false)]));
  const check = (key, actual, expected) => { gates[key] = gate(JSON.stringify(actual) === JSON.stringify(expected), { actual, expected }); };
  gates.authenticated = gate(true, { channelId: context.channelId });
  gates.draftIdentity = gate(video.id === state.videoId && video.snippet?.channelId === context.channelId, { id: video.id, channelId: video.snippet?.channelId });
  gates.video = gate(video.processingDetails?.processingStatus === 'succeeded' && video.status?.uploadStatus === 'processed', { processingStatus: video.processingDetails?.processingStatus, uploadStatus: video.status?.uploadStatus, uploading: video.processingDetails?.processingStatus === 'processing' });
  check('title', video.snippet?.title, metadata.snippet.title);
  check('description', video.snippet?.description, metadata.snippet.description);
  gates.tags = gate(sameSet(video.snippet?.tags, metadata.snippet.tags), { actual: video.snippet?.tags || [], expected: metadata.snippet.tags });
  check('audience', video.status?.selfDeclaredMadeForKids, metadata.status.selfDeclaredMadeForKids);
  check('visibility', video.status?.privacyStatus, 'private');
  const expected = { category: metadata.snippet.categoryId, license: metadata.status.license, embedding: metadata.status.embeddable,
    synthetic: metadata.status.containsSyntheticMedia, promotion: metadata.paidProductPlacementDetails.hasPaidProductPlacement,
    ...(metadata.snippet.defaultLanguage ? { language: metadata.snippet.defaultLanguage } : {}) };
  const actual = { category: video.snippet?.categoryId, license: video.status?.license, embedding: video.status?.embeddable,
    synthetic: video.status?.containsSyntheticMedia === true, promotion: video.paidProductPlacementDetails?.hasPaidProductPlacement === true,
    ...(metadata.snippet.defaultLanguage ? { language: video.snippet?.defaultLanguage } : {}) };
  check('settings', actual, expected);
  // Preserve absence separately from false; do not expose arbitrary response values.
  gates.settings.evidence.syntheticField = booleanPropertyEvidence(video.status, 'containsSyntheticMedia');
  const cover = coverForPlatform(pkg, 'youtube');
  gates.cover = gate(!cover.uploadCustomCover || context.thumbnailVerified === true, { custom: cover.uploadCustomCover, receipt: state.thumbnail || null });
  gates.noBlockingDialog = gate(true, { notApplicable: 'API transport' });
  gates.finalButton = gate(true, { notApplicable: 'private API upload, not a Studio draft' });
  gates.safety = gate(video.status?.privacyStatus === 'private', { finalPublishClicked: false, guardArmed: true, blockedAttempts: 0, transport: 'youtube_data_api', privateOnly: true, notifySubscribers: false });
  const now = new Date().toISOString();
  gates.persistedDraft = gate(gates.draftIdentity.ok && gates.visibility.ok, { version: 2, platform: 'youtube', method: 'youtube.videos.list',
    verificationRunId: context.verificationRunId, fingerprint: context.fingerprint, draftId: state.videoId, actualId: video.id,
    channelVerified: gates.draftIdentity.ok, private: gates.visibility.ok, savedAt: state.savedAt, readAt: now });
  return { platform: 'youtube', phase: context.phase, observedAt: now, fingerprint: context.fingerprint,
    verificationRunId: context.verificationRunId, finalPublishClicked: false, gates,
    evidence: { deliveryKind: 'private_video', videoId: video.id, copyrightChecks: 'not exposed by Data API', notifySubscribers: 'write-only request parameter; not claimed as read back' } };
}

export async function runYoutubeApi({ pkg, phase, packagePath }, dependencies = {}) {
  const env = dependencies.env || process.env;
  const fingerprint = env.VIDEO_PUBLISHER_V2_FINGERPRINT;
  const context = { fingerprint, phase, verificationRunId: env.VIDEO_PUBLISHER_V2_VERIFICATION_RUN_ID || randomUUID() };
  try {
    if (!fingerprint || !env.VIDEO_PUBLISHER_V2_CHECKPOINT_PATH) throw fail('API_CONFIGURATION_REQUIRED', 'Use the production job runner with a content fingerprint and checkpoint path');
    const status = dependencies.credentials ? null : oauthStatus();
    if (status && !status.configured) throw fail('API_CONFIGURATION_REQUIRED', `YouTube OAuth configuration missing or not mode 0600: ${status.path}`);
    const credentials = dependencies.credentials || JSON.parse(fs.readFileSync(status.path, 'utf8'));
    const expected = expectedYoutube(pkg, credentials);
    context.channelId = credentials.channel_id;
    const client = dependencies.client || new YoutubeClient(credentials);
    const stateFile = `${env.VIDEO_PUBLISHER_V2_CHECKPOINT_PATH}.youtube-api.json`;
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { fingerprint, channelId: credentials.channel_id };
    const oldReceipts = JSON.parse(env.VIDEO_PUBLISHER_V2_RECEIPTS || '{}');
    if (!state.videoId && Object.keys(oldReceipts).some(key => key !== 'youtubeApi')) throw fail('API_CONFIGURATION_REQUIRED', 'Legacy Studio draft exists; bind and verify its video ID before migration, no duplicate API upload');
    if (state.fingerprint !== fingerprint || state.channelId !== credentials.channel_id) throw fail('STATE_AMBIGUOUS', 'API checkpoint belongs to different content/channel; explicit migration required, no reupload');
    const save = () => atomicJson(stateFile, state);
    await client.authenticate();
    if (!state.videoId && !['upload_start', 'upload'].includes(phase)) {
      return { platform: 'youtube', phase, gates: { authenticated: gate(true), draftIdentity: gate(true), video: gate(false, { reason: 'No API upload for this job' }) } };
    }
    if (!state.videoId) await uploadResumable(client, pkg, expected, state, save);
    let video = await client.video(state.videoId);
    if (phase === 'upload') {
      for (let n = 0; n < 30 && video.processingDetails?.processingStatus === 'processing'; n++) {
        await (dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(2000);
        video = await client.video(state.videoId);
      }
    }
    if (video.snippet?.channelId !== credentials.channel_id) throw fail('FOREIGN_DRAFT', 'API video owner mismatch');
    if (video.status?.privacyStatus !== 'private') throw fail('STATE_AMBIGUOUS', 'Video was made public/unlisted elsewhere; no further changes allowed');
    if (phase === 'mutate') {
      const updated = await client.json(`${API}videos?part=snippet,status,paidProductPlacementDetails`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: state.videoId, ...expected }) });
      // Keep a selected write receipt for diagnosis. Only later videos.list reads
      // can satisfy metadata gates, even when this response already has new tags.
      state.metadataUpdate = { method: 'youtube.videos.update', fingerprint, requestedVideoId: state.videoId,
        returnedVideoId: typeof updated?.id === 'string' ? updated.id : null,
        returnedTags: Array.isArray(updated?.snippet?.tags) && updated.snippet.tags.every(tag => typeof tag === 'string') ? [...updated.snippet.tags] : null,
        expectedTags: [...expected.snippet.tags],
        requestedContainsSyntheticMedia: expected.status.containsSyntheticMedia,
        returnedContainsSyntheticMedia: booleanPropertyEvidence(updated?.status, 'containsSyntheticMedia'),
        returnedPrivacyStatus: typeof updated?.status?.privacyStatus === 'string' ? updated.status.privacyStatus : null,
        returnedChannelId: typeof updated?.snippet?.channelId === 'string' ? updated.snippet.channelId : null,
        etag: typeof updated?.etag === 'string' ? updated.etag : null,
        receivedAt: new Date().toISOString(), writeReceiptOnly: true };
      state.savedAt = new Date().toISOString(); save();
      if (state.metadataUpdate.returnedVideoId !== state.videoId) throw fail('STATE_AMBIGUOUS', 'YouTube metadata update response did not identify the existing video');
      if (state.metadataUpdate.returnedChannelId && state.metadataUpdate.returnedChannelId !== credentials.channel_id) throw fail('FOREIGN_DRAFT', 'YouTube metadata update response owner mismatch');
      if (state.metadataUpdate.returnedPrivacyStatus && state.metadataUpdate.returnedPrivacyStatus !== 'private') throw fail('STATE_AMBIGUOUS', 'YouTube metadata update response is not private');
    }
    const cover = coverForPlatform(pkg, 'youtube');
    if (cover.uploadCustomCover && video.processingDetails?.processingStatus === 'succeeded' && ['mutate', 'persist', 'verify', 'inspect'].includes(phase)) {
      const asset = fs.readFileSync(cover.horizontal16x9Path);
      const assetHash = hash(asset);
      const url = video.snippet?.thumbnails?.high?.url;
      if (!url) throw fail('PERSISTENCE_UNVERIFIED', 'No server thumbnail to verify');
      if (phase === 'mutate' && state.thumbnail?.assetHash !== assetHash) {
        const png = asset.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpeg = asset[0] === 255 && asset[1] === 216;
        const dimensions = !png && !jpeg ? getImageDimensions(cover.horizontal16x9Path) : null;
        const webp = dimensions?.format === 'webp' && dimensions.width * 9 === dimensions.height * 16;
        if ((!png && !jpeg && !webp) || asset.length > 2 * 1024 * 1024) throw fail('PLATFORM_REJECTED_ASSET', 'API thumbnail must be the exact PNG/JPEG or valid 16:9 WebP asset, at most 2 MB');
        // thumbnails.set documents application/octet-stream media uploads.
        // Preserve validated WebP bytes; only the server can establish decoder support.
        // https://developers.google.com/youtube/data/reference/rest/v3/thumbnails/set
        const mimeType = png ? 'image/png' : jpeg ? 'image/jpeg' : 'application/octet-stream';
        const beforeDigest = await client.thumbnailDigest(url, { allowMissing: true });
        await client.json(`${UPLOAD}thumbnails/set?videoId=${encodeURIComponent(state.videoId)}&uploadType=media`, { method: 'POST', headers: { 'Content-Type': mimeType }, body: asset });
        state.thumbnail = { assetHash, beforeDigest, uploadedAt: new Date().toISOString() }; save();
      }
      video = await client.video(state.videoId);
      const readUrl = video.snippet?.thumbnails?.high?.url;
      const readDigest = state.thumbnail && readUrl ? await client.thumbnailDigest(readUrl) : null;
      const receipt = state.thumbnail;
      if (receipt?.assetHash === assetHash && readDigest && readDigest !== receipt.beforeDigest) {
        context.thumbnailVerified = !receipt.serverDigest || receipt.serverDigest === readDigest;
        if (context.thumbnailVerified && !receipt.serverDigest) { receipt.serverDigest = readDigest; receipt.url = readUrl; save(); }
      }
    }
    // Verification never reuses the insert/update response as the resource truth.
    video = await client.video(state.videoId);
    let result = youtubeReadback(pkg, expected, video, state, context);
    const pendingTagRevision = state.metadataRevision?.kind === 'tags'
      && state.metadataRevision.to === fingerprint && state.metadataRevision.videoId === state.videoId;
    const onlyTagsMissing = observation => observation.gates.tags.ok === false
      && requiredGates('youtube').every(name => name === 'tags' || observation.gates[name]?.ok === true);
    let tagReadbackRetries = 0;
    while (phase === 'mutate' && pendingTagRevision && onlyTagsMissing(result) && tagReadbackRetries < 4) {
      await (dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(2000);
      video = await client.video(state.videoId);
      tagReadbackRetries++;
      if (cover.uploadCustomCover) {
        const url = video.snippet?.thumbnails?.high?.url;
        const digest = url ? await client.thumbnailDigest(url) : null;
        context.thumbnailVerified = Boolean(state.thumbnail?.serverDigest && digest
          && digest === state.thumbnail.serverDigest && digest !== state.thumbnail.beforeDigest);
      }
      result = youtubeReadback(pkg, expected, video, state, context);
    }
    result.evidence.metadataReadback = { method: 'youtube.videos.list', tagReadbackRetries,
      maxTagReadbackRetries: phase === 'mutate' && pendingTagRevision ? 4 : 0,
      etag: typeof video.etag === 'string' ? video.etag : null };
    if (state.metadataUpdate?.fingerprint === fingerprint && state.metadataUpdate.requestedVideoId === state.videoId) {
      result.evidence.metadataUpdate = Object.fromEntries(['method', 'fingerprint', 'requestedVideoId', 'returnedVideoId',
        'returnedTags', 'expectedTags', 'requestedContainsSyntheticMedia', 'returnedContainsSyntheticMedia',
        'returnedPrivacyStatus', 'returnedChannelId', 'etag', 'receivedAt', 'writeReceiptOnly']
        .map(key => [key, state.metadataUpdate[key]]));
    }
    result.receipts = { youtubeApi: { videoId: state.videoId, deliveryKind: 'private_video', fingerprint } };
    if (['failed', 'terminated'].includes(video.processingDetails?.processingStatus) || ['failed', 'rejected', 'deleted'].includes(video.status?.uploadStatus)) {
      result.blocker = { code: 'PLATFORM_REJECTED_ASSET', message: 'YouTube processing failed or upload rejected' };
    }
    return result;
  } catch (error) {
    return { platform: 'youtube', phase, observedAt: new Date().toISOString(), fingerprint,
      verificationRunId: context.verificationRunId, gates: {}, blocker: { code: error.code || 'ACTION_FAILED',
        message: error.code ? error.message : 'YouTube API request failed; retain checkpoint and resume without creating another upload',
        requiresUser: ['AUTH_REQUIRED', 'API_CONFIGURATION_REQUIRED'].includes(error.code), retryable: false } };
  }
}
