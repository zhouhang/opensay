import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(new URL('../platforms/xiaohongshu.mjs', import.meta.url), 'utf8');
const helpers = source.slice(0, source.indexOf('async function inspectXiaohongshu'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const envKey = 'VIDEO_PUBLISHER_XHS_COVER_TRANSPORT_MANIFEST';

function webp(width = 30, height = 40) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF'); bytes.writeUInt32LE(22, 4); bytes.write('WEBPVP8 ', 8); bytes.writeUInt32LE(10, 16);
  bytes.set([0x10, 0, 0, 0x9d, 1, 0x2a], 20);
  bytes.writeUInt16LE(width, 26); bytes.writeUInt16LE(height, 28);
  return bytes;
}
function png(width = 30, height = 40) {
  const bytes = Buffer.alloc(33);
  bytes.set([137,80,78,71,13,10,26,10]); bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); bytes[24] = 8; bytes[25] = 6;
  return bytes;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-cover-transport-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'approved-original.webp'), transportPath = path.join(root, 'transport.png');
  const manifestPath = path.join(root, 'transport.json');
  const sourceBytes = webp(), transportBytes = png();
  fs.writeFileSync(sourcePath, sourceBytes); fs.writeFileSync(transportPath, transportBytes);
  const manifest = { version: 1, sourcePath, sourceSha256: hash(sourceBytes), transportPath,
    transportSha256: hash(transportBytes), width: 30, height: 40, pixelMode: 'RGBA',
    sourcePixelSha256: 'a'.repeat(64), transportPixelSha256: 'a'.repeat(64),
    conversion: 'lossless-png', reason: 'xiaohongshu-native-webp-rejection' };
  const write = value => fs.writeFileSync(manifestPath, JSON.stringify(value)); write(manifest);
  const processStub = { env: { [envKey]: manifestPath } };
  const pkg = { platformTitle: { xiaohongshu: 'Approved' }, xhsTopics: [],
    cover: { uploadCustomCover: true, nativeRatio: '3:4', vertical3x4Path: sourcePath } };
  const run = (tail, dependencies = {}) => {
    const values = { pkg, videoPath: '/approved-video.mp4', fs, path, createHash, process: processStub, ...dependencies };
    return new AsyncFunction(...Object.keys(values), `${helpers}\n${tail}`)(...Object.values(values));
  };
  const read = () => run('return readXhsCoverTransport();');
  const inject = ({ upload = async () => {}, thumbnail = null, wait = async () => {} } = {}) => {
    let reads = 0;
    const thumbnailReader = thumbnail || (() => (++reads === 1
      ? { loaded: true, pending: false, src: 'blob:old' }
      : { loaded: true, pending: false, src: 'blob:fresh' }));
    const calls = [];
    return run(`
      exposeXhsCoverImageInput=async()=>({ok:true,selector:'#active-native-image-input'});
      readXhsUploadedCoverThumbnail=thumbnailReader;
      return injectExactXhsCover();`, { thumbnailReader, wait, uploadFile: async (selector, uploadPath) => {
      calls.push({ selector, path: uploadPath }); await upload(selector, uploadPath);
    } }).then(result => ({ result, calls }));
  };
  return { root, sourcePath, transportPath, manifestPath, sourceBytes, transportBytes, manifest, write, processStub, run, read, inject };
}

test('no opt-in preserves direct original-file upload and its ordinary receipt shape', async t => {
  const f = fixture(t); f.processStub.env = {};
  assert.deepEqual(await f.read(), { ok: true, uploadPath: f.sourcePath, transport: null });
  const { result, calls } = await f.inject();
  assert.equal(result.ok, true);
  assert.equal(result.assetPath, f.sourcePath);
  assert.equal(result.assetHash, hash(f.sourceBytes));
  assert.equal(result.transport, undefined);
  assert.deepEqual(calls, [{ selector: '#active-native-image-input', path: f.sourcePath }]);
});

test('explicit lossless PNG transport binds both files, dimensions and pixel attestations', async t => {
  const f = fixture(t), plan = await f.read();
  assert.equal(plan.ok, true);
  assert.equal(plan.uploadPath, f.transportPath);
  for (const [key, value] of Object.entries(f.manifest)) assert.equal(plan.transport[key], value);
  assert.equal(plan.transport.manifestPath, f.manifestPath);
  assert.equal(plan.transport.manifestSha256, hash(fs.readFileSync(f.manifestPath)));
  const { result, calls } = await f.inject();
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ selector: '#active-native-image-input', path: f.transportPath }]);
  assert.equal(result.assetPath, f.sourcePath);
  assert.equal(result.assetHash, f.manifest.sourceSha256);
  assert.deepEqual(result.transport, plan.transport);
  assert.deepEqual(fs.readFileSync(f.sourcePath), f.sourceBytes);
  assert.deepEqual(fs.readFileSync(f.transportPath), f.transportBytes);
});

test('serialized runner manifest remains authoritative when the remote runtime has no inherited env', async t => {
  const f = fixture(t);
  const plan = await f.run('return readXhsCoverTransport();', {
    process: { env: {} }, xhsCoverTransportManifestPath: f.manifestPath,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.uploadPath, f.transportPath);
  assert.equal(plan.transport.sourceSha256, f.manifest.sourceSha256);
  const c = await coverReceipt(f);
  const remote = { process: { env: {} }, xhsCoverTransportManifestPath: f.manifestPath };
  assert.equal(await c.match(remote), true);
  assert.equal(await c.match({ ...remote, receipt: { ...c.receipt, transport: undefined } }), false);
  const noOptIn = await f.run('return readXhsCoverTransport();', { xhsCoverTransportManifestPath: '' });
  assert.equal(noOptIn.uploadPath, f.sourcePath);
  assert.equal(noOptIn.transport, null);
});

test('real platform runner serializes the opt-in into the generated remote script without env mutation', async t => {
  const f = fixture(t);
  const videoPath = path.join(f.root, 'video.mp4'), packagePath = path.join(f.root, 'package.json');
  const configPath = path.join(f.root, 'config.json'), capturedPath = path.join(f.root, 'generated.mjs');
  const fakeEgoPath = path.join(f.root, 'capture-ego.mjs');
  const box = (type, payload) => {
    const bytes = Buffer.alloc(8 + payload.length); bytes.writeUInt32BE(bytes.length); bytes.write(type, 4); payload.copy(bytes, 8); return bytes;
  };
  const mvhd = Buffer.alloc(20); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(30000, 16);
  fs.writeFileSync(videoPath, Buffer.concat([box('ftyp', Buffer.alloc(4)), box('moov', box('mvhd', mvhd))]));
  fs.writeFileSync(packagePath, JSON.stringify({ videoPath, title: '封面测试', xhsTopics: ['AI'],
    cover: { uploadCustomCover: true, vertical3x4Path: f.sourcePath, platforms: { xiaohongshu: { nativeRatio: '3:4' } } } }));
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, onboarding: { completed: true }, sourceDirectory: f.root,
    availablePlatforms: ['xiaohongshu'], defaultPlatforms: ['xiaohongshu'] }));
  fs.writeFileSync(fakeEgoPath, `#!${process.execPath}\nimport fs from 'node:fs';\nlet script='';for await (const part of process.stdin) script+=part;\nfs.writeFileSync(process.env.CAPTURE_XHS_SCRIPT,script);process.exit(1);\n`, { mode: 0o755 });
  const runner = fileURLToPath(new URL('../run-platform.mjs', import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, 'xiaohongshu', packagePath, 'inspect'], {
      env: { ...process.env, VIDEO_PUBLISHER_CONFIG: configPath, [envKey]: f.manifestPath,
        VIDEO_PUBLISHER_V2_EGO_COMMAND: fakeEgoPath, CAPTURE_XHS_SCRIPT: capturedPath,
        VIDEO_PUBLISHER_V2_LOCK_ROOT: path.join(f.root, 'isolated-locks'), VIDEO_PUBLISHER_V2_PUBLISHER_LOCK_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
    child.on('error', reject); child.on('close', code => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  const generated = fs.readFileSync(capturedPath, 'utf8');
  const declaration = generated.match(/^const xhsCoverTransportManifestPath = (.+);$/m);
  assert.ok(declaration);
  assert.equal(JSON.parse(declaration[1]), f.manifestPath);
  assert.doesNotMatch(generated, /process\.env\.VIDEO_PUBLISHER_XHS_COVER_TRANSPORT_MANIFEST\s*=/);
  const adapterPackage = JSON.parse(generated.match(/^const pkg = (.+);$/m)[1]);
  assert.equal(adapterPackage.cover.vertical3x4Path, f.sourcePath);
  const run = new AsyncFunction('pkg', 'videoPath', 'fs', 'path', 'createHash', 'process',
    `${declaration[0]}\n${helpers}\nreturn readXhsCoverTransport();`);
  const plan = await run(adapterPackage, videoPath, fs, path, createHash, { env: {} });
  assert.equal(plan.ok, true);
  assert.equal(plan.uploadPath, f.transportPath);
  assert.equal(plan.transport.sourcePath, f.sourcePath);
});

test('malformed manifests and every changed binding reject before upload without fallback', async t => {
  const changes = [
    { version: 2 }, { sourcePath: '/foreign.webp' }, { transportPath: 'relative.png' },
    { sourceSha256: 'b'.repeat(64) }, { transportSha256: 'b'.repeat(64) },
    { sourcePixelSha256: 'short' }, { transportPixelSha256: 'b'.repeat(64) },
    { pixelMode: 'RGB' }, { conversion: 'jpeg' }, { reason: 'other' },
    { width: 31 }, { height: 0 }, { height: 40.1 }, { width: '30' },
  ];
  for (const change of changes) {
    const f = fixture(t); f.write({ ...f.manifest, ...change });
    const { result, calls } = await f.inject();
    assert.equal(result.ok, false, JSON.stringify(change)); assert.equal(calls.length, 0);
  }
  for (const content of ['{', 'null', '[]', '{}']) {
    const f = fixture(t); fs.writeFileSync(f.manifestPath, content);
    const { result, calls } = await f.inject();
    assert.equal(result.ok, false); assert.equal(calls.length, 0);
  }
  const f = fixture(t); f.write({ ...f.manifest, transportPath: f.sourcePath });
  assert.equal((await f.read()).ok, false);
  f.processStub.env[envKey] = 'relative-manifest.json';
  assert.equal((await f.read()).ok, false);
});

test('source WebP and PNG format/dimensions are inspected independently of matching file hashes', async t => {
  for (const [sourceBytes, transportBytes] of [
    [Buffer.from('not-webp'), png()], [webp().subarray(0, -1), png()],
    [png(), png()], [webp(), webp()], [webp(31, 40), png()], [webp(), png(30, 41)],
  ]) {
    const f = fixture(t);
    fs.writeFileSync(f.sourcePath, sourceBytes); fs.writeFileSync(f.transportPath, transportBytes);
    f.write({ ...f.manifest, sourceSha256: hash(sourceBytes), transportSha256: hash(transportBytes) });
    assert.equal((await f.read()).ok, false);
  }
  const f = fixture(t);
  await f.run('pkg.cover.nativeRatio="4:3";pkg.cover.horizontal4x3Path=pkg.cover.vertical3x4Path;return true;');
  assert.equal((await f.read()).ok, false, 'same source and transport dimensions must still match the selected native ratio');
});

test('source, PNG, manifest and env mapping changes during injection cannot mint a receipt', async t => {
  for (const change of [
    f => fs.appendFileSync(f.sourcePath, 'changed'),
    f => fs.appendFileSync(f.transportPath, 'changed'),
    f => fs.appendFileSync(f.manifestPath, '\n'),
    f => { f.processStub.env = {}; },
  ]) {
    const f = fixture(t);
    const { result } = await f.inject({ upload: async () => change(f) });
    assert.equal(result.ok, false);
    assert.equal(result.assetHash, undefined);
  }
});

test('a changed manifest while waiting for upload completion fails closed', async t => {
  const f = fixture(t); let reads = 0;
  const { result } = await f.inject({
    thumbnail: async () => (++reads === 1 ? { loaded: true, src: 'blob:old' }
      : reads === 2 ? { loaded: true, pending: true, src: 'blob:fresh' }
        : { loaded: true, pending: false, src: 'blob:fresh' }),
    wait: async () => fs.appendFileSync(f.manifestPath, '\n'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.assetHash, undefined);
});

test('opt-in transport still requires a fresh, loaded and non-pending native thumbnail', async t => {
  for (const thumbnail of [
    { loaded: true, pending: false, src: 'blob:old' },
    { loaded: true, pending: true, src: 'blob:fresh' },
    { loaded: false, pending: false, src: 'blob:fresh' },
    { ambiguous: true, loaded: true, src: 'blob:fresh' },
  ]) {
    const f = fixture(t); let first = true;
    const { result } = await f.inject({ thumbnail: async () => {
      if (first) { first = false; return { loaded: true, pending: false, src: 'blob:old' }; }
      return thumbnail;
    } });
    assert.equal(result.ok, false); assert.equal(result.transport, undefined);
  }
});

test('a slow native upload waits for server completion without reinjecting the file', async t => {
  const f = fixture(t); let reads = 0, waits = 0;
  const { result, calls } = await f.inject({
    thumbnail: async () => ++reads === 1
      ? { loaded: false, pending: false, src: '' }
      : reads < 82
        ? { loaded: true, pending: true, src: 'blob:local-preview' }
        : { loaded: true, pending: false, src: 'https://native.example/accepted-cover' },
    wait: async () => { waits += 1; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.thumbnailSource, 'https://native.example/accepted-cover');
  assert.equal(calls.length, 1);
  assert.equal(waits, 80);
});

async function coverReceipt(f, changes = {}) {
  const plan = await f.read();
  const fileid = 'spectrum/native-accepted-cover';
  const afterUrl = `https://ros-preview.xhscdn.com/${fileid}?signature=fresh`;
  const receipt = { version: 2, assetPath: f.sourcePath, assetHash: f.manifest.sourceSha256,
    ratio: '3:4', nativeRatio: '3:4', nativeSlot: 'portrait', nativeFileId: fileid,
    afterUrl, transport: plan.transport, ...changes };
  const preview = { ok: true, count: 1, direction: 'portrait', bg: `url("${afterUrl}")` };
  const native = { live: { coverFileId: fileid }, liveCover: { fileid, width: 30, height: 40 },
    record: { id: 'existing-draft' }, recordCover: { fileid, width: 30, height: 40 } };
  const proof = { ok: true, evidence: { draftId: 'existing-draft' } };
  const match = (overrides = {}) => f.run('return xhsCoverReceiptMatches(receipt,preview,native,proof);', { receipt, preview, native, proof, ...overrides });
  return { receipt, preview, native, proof, match };
}

test('transport receipt remains bound to original source, exact current mapping and native draft proof', async t => {
  const f = fixture(t), c = await coverReceipt(f);
  assert.equal(await c.match(), true);
  assert.equal(await c.match({ receipt: { ...c.receipt, assetPath: f.transportPath } }), false);
  assert.equal(await c.match({ receipt: { ...c.receipt, assetHash: f.manifest.transportSha256 } }), false);
  assert.equal(await c.match({ receipt: { ...c.receipt, transport: undefined } }), false);
  assert.equal(await c.match({ receipt: { ...c.receipt, transport: { ...c.receipt.transport, transportSha256: 'b'.repeat(64) } } }), false);
  await f.run('delete pkg.cover.nativeRatio;return true;');
  assert.equal(await c.match({ receipt: { ...c.receipt, version: 1, assetHash: undefined } }), false,
    'transport receipts require original-source hash and v2 identity even for the legacy default native ratio');
  assert.equal(await c.match({ native: { ...c.native, live: { coverFileId: 'spectrum/foreign' } } }), false);
  assert.equal(await c.match({ native: { ...c.native, record: { id: 'foreign-draft' } } }), false);
  assert.equal(await c.match({ preview: { ...c.preview, direction: 'landscape' } }), false);
  f.processStub.env = {};
  assert.equal(await c.match(), false, 'a transport receipt cannot silently revert to the no-opt-in path');
});

test('reopen rejects changed original, derived PNG or manifest even with the same accepted native object key', async t => {
  for (const change of [
    f => fs.appendFileSync(f.sourcePath, 'changed'),
    f => fs.appendFileSync(f.transportPath, 'changed'),
    f => fs.appendFileSync(f.manifestPath, '\n'),
    f => f.write({ ...f.manifest, sourcePixelSha256: 'b'.repeat(64), transportPixelSha256: 'b'.repeat(64) }),
  ]) {
    const f = fixture(t), c = await coverReceipt(f); assert.equal(await c.match(), true);
    change(f); assert.equal(await c.match(), false);
  }
});

test('the actual locally prepared manifest binds the original WebP and independently compared RGBA PNG', {
  skip: !process.env.XHS_COVER_TRANSPORT_FIXTURE,
}, async () => {
  const manifestPath = process.env.XHS_COVER_TRANSPORT_FIXTURE;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const run = new AsyncFunction('pkg', 'videoPath', 'fs', 'path', 'createHash', 'process', `${helpers}\nreturn readXhsCoverTransport();`);
  const result = await run({ platformTitle: { xiaohongshu: 'Approved' }, xhsTopics: [],
    cover: { nativeRatio: '3:4', vertical3x4Path: manifest.sourcePath } }, '/approved-video.mp4', fs, path, createHash,
  { env: { [envKey]: manifestPath } });
  assert.equal(result.ok, true);
  assert.equal(result.transport.sourceSha256, manifest.sourceSha256);
  assert.equal(result.transport.transportSha256, manifest.transportSha256);
  assert.equal(result.transport.sourcePixelSha256, result.transport.transportPixelSha256);
  assert.equal(result.uploadPath, manifest.transportPath);
});
