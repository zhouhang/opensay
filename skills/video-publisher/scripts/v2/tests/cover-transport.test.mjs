import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readExplicitLosslessPngTransport, explicitCoverTransportMatches } from '../lib/cover-transport.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function webp(width = 40, height = 30) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF'); bytes.writeUInt32LE(22, 4); bytes.write('WEBPVP8 ', 8); bytes.writeUInt32LE(10, 16);
  bytes.set([0x10, 0, 0, 0x9d, 1, 0x2a], 20); bytes.writeUInt16LE(width, 26); bytes.writeUInt16LE(height, 28);
  return bytes;
}
function png(width = 40, height = 30) {
  const bytes = Buffer.alloc(33);
  bytes.set([137,80,78,71,13,10,26,10]); bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); bytes[24] = 8; bytes[25] = 6;
  return bytes;
}
function fixture(t, reason = 'bilibili-native-webp-rejection') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-transport-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'approved.webp'), transportPath = path.join(root, 'transport.png');
  const manifestPath = path.join(root, 'manifest.json'), sourceBytes = webp(), transportBytes = png();
  fs.writeFileSync(sourcePath, sourceBytes); fs.writeFileSync(transportPath, transportBytes);
  const manifest = { version: 1, sourcePath, sourceSha256: hash(sourceBytes), transportPath,
    transportSha256: hash(transportBytes), width: 40, height: 30, pixelMode: 'RGBA',
    sourcePixelSha256: 'a'.repeat(64), transportPixelSha256: 'a'.repeat(64), conversion: 'lossless-png', reason };
  const write = value => fs.writeFileSync(manifestPath, JSON.stringify(value)); write(manifest);
  const options = { manifestPath, sourcePath, ratio: '4:3', reason };
  return { root, sourcePath, transportPath, manifestPath, sourceBytes, transportBytes, manifest, write, options };
}

test('explicit transport preserves source identity and binds exact PNG, manifest bytes, ratio and pixel attestation', t => {
  const f = fixture(t), result = readExplicitLosslessPngTransport(f.options);
  assert.equal(result.ok, true); assert.equal(result.uploadPath, f.transportPath);
  assert.equal(result.transport.sourcePath, f.sourcePath);
  assert.equal(result.transport.sourceSha256, hash(f.sourceBytes));
  assert.equal(result.transport.transportSha256, hash(f.transportBytes));
  assert.equal(result.transport.manifestSha256, hash(fs.readFileSync(f.manifestPath)));
  assert.equal(result.transport.sourcePixelSha256, result.transport.transportPixelSha256);
  assert.equal(explicitCoverTransportMatches(result.transport, f.options), true);
  assert.deepEqual(readExplicitLosslessPngTransport({ ...f.options, manifestPath: '' }),
    { ok: true, uploadPath: f.sourcePath, transport: null });
});

test('changed files, manifest, purpose, ratio or pixel binding fail closed with no original fallback', t => {
  const mutations = [
    f => f.write({ ...f.manifest, sourceSha256: 'b'.repeat(64) }),
    f => f.write({ ...f.manifest, transportSha256: 'b'.repeat(64) }),
    f => f.write({ ...f.manifest, sourcePixelSha256: 'b'.repeat(64) }),
    f => f.write({ ...f.manifest, reason: 'other' }),
    f => fs.appendFileSync(f.sourcePath, 'changed'),
    f => fs.appendFileSync(f.transportPath, 'changed'),
  ];
  for (const mutate of mutations) {
    const f = fixture(t); mutate(f);
    const result = readExplicitLosslessPngTransport(f.options);
    assert.equal(result.ok, false); assert.equal(result.uploadPath, undefined);
  }
  const ratio = fixture(t);
  assert.equal(readExplicitLosslessPngTransport({ ...ratio.options, ratio: '3:4' }).ok, false);
  const purpose = fixture(t);
  assert.equal(readExplicitLosslessPngTransport({ ...purpose.options, reason: 'wechat-channels-native-webp-rejection' }).ok, false);
  const manifest = fixture(t), accepted = readExplicitLosslessPngTransport(manifest.options).transport;
  fs.appendFileSync(manifest.manifestPath, '\n');
  assert.equal(explicitCoverTransportMatches(accepted, manifest.options), false);
});

test('source must be WebP and transport must be PNG with the same declared dimensions', t => {
  for (const [sourceBytes, transportBytes] of [[png(), png()], [webp(), webp()], [webp(41,30), png()], [webp(), png(41,30)]]) {
    const f = fixture(t); fs.writeFileSync(f.sourcePath, sourceBytes); fs.writeFileSync(f.transportPath, transportBytes);
    f.write({ ...f.manifest, sourceSha256: hash(sourceBytes), transportSha256: hash(transportBytes) });
    assert.equal(readExplicitLosslessPngTransport(f.options).ok, false);
  }
});
