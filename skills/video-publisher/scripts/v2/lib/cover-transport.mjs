import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HASH_RE = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function imageHeaderDimensions(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 && width <= 0x7fffffff && height <= 0x7fffffff
      ? { width, height, format: 'png' } : null;
  }
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  const size = bytes.readUInt32LE(4);
  if (size < 4 || size > 0xfffffff6 || size % 2 || size + 8 !== bytes.length) return null;
  let canvas = null, image = null;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) return null;
    const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length, next = end + length % 2;
    if (next > bytes.length || (length % 2 && bytes[end] !== 0)) return null;
    let dimensions = null;
    if (type === 'VP8X') {
      if (length < 10 || canvas) return null;
      canvas = { width: bytes.readUIntLE(start + 4, 3) + 1, height: bytes.readUIntLE(start + 7, 3) + 1, format: 'webp' };
      if (canvas.width * canvas.height > 0xffffffff) return null;
    } else if (type === 'VP8 ') {
      if (length < 10 || (bytes[start] & 1) || ((bytes[start] >> 1) & 7) > 3
        || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a) return null;
      dimensions = { width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff, format: 'webp' };
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[start] !== 0x2f) return null;
      const bits = bytes.readUInt32LE(start + 1);
      if (bits >>> 29) return null;
      dimensions = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, format: 'webp' };
    }
    if (dimensions) {
      if (image || !dimensions.width || !dimensions.height) return null;
      image = dimensions;
    }
    offset = next;
  }
  if (canvas && image && (canvas.width !== image.width || canvas.height !== image.height)) return null;
  return canvas || image;
}

/**
 * Resolve an explicitly authorized WebP -> lossless PNG transport without changing
 * the approved source identity. Pixel equality is independently attested by the
 * manifest; this reader binds that attestation to both exact files, dimensions,
 * native ratio, purpose and the exact manifest bytes.
 */
export function readExplicitLosslessPngTransport({ manifestPath = '', sourcePath, ratio, reason }) {
  if (!manifestPath) return { ok: true, uploadPath: sourcePath, transport: null };
  try {
    if (!path.isAbsolute(manifestPath)) throw new Error('transport manifest path must be absolute');
    if (!path.isAbsolute(sourcePath)) throw new Error('approved source path must be absolute');
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (!manifest || Array.isArray(manifest) || manifest.version !== 1
      || manifest.sourcePath !== sourcePath || !path.isAbsolute(manifest.sourcePath)
      || typeof manifest.transportPath !== 'string' || !path.isAbsolute(manifest.transportPath)
      || manifest.transportPath === manifest.sourcePath || manifest.pixelMode !== 'RGBA'
      || manifest.conversion !== 'lossless-png' || manifest.reason !== reason
      || !['sourceSha256', 'transportSha256', 'sourcePixelSha256', 'transportPixelSha256']
        .every(key => HASH_RE.test(manifest[key] || ''))
      || manifest.sourcePixelSha256 !== manifest.transportPixelSha256
      || !Number.isSafeInteger(manifest.width) || !Number.isSafeInteger(manifest.height)
      || manifest.width <= 0 || manifest.height <= 0) throw new Error('transport manifest binding is invalid');
    const sourceBytes = fs.readFileSync(manifest.sourcePath), transportBytes = fs.readFileSync(manifest.transportPath);
    if (sha256(sourceBytes) !== manifest.sourceSha256 || sha256(transportBytes) !== manifest.transportSha256) {
      throw new Error('transport source or PNG bytes changed');
    }
    const source = imageHeaderDimensions(sourceBytes), transport = imageHeaderDimensions(transportBytes);
    const [ratioWidth, ratioHeight] = String(ratio || '').split(':').map(Number);
    if (!Number.isSafeInteger(ratioWidth) || !Number.isSafeInteger(ratioHeight) || ratioWidth <= 0 || ratioHeight <= 0
      || source?.format !== 'webp' || transport?.format !== 'png'
      || source.width !== manifest.width || source.height !== manifest.height
      || transport.width !== manifest.width || transport.height !== manifest.height
      || manifest.width * ratioHeight !== manifest.height * ratioWidth) {
      throw new Error('transport source/PNG dimensions or native ratio do not match');
    }
    const receipt = { version: 1, manifestPath, manifestSha256: sha256(manifestBytes) };
    for (const key of ['sourcePath', 'sourceSha256', 'transportPath', 'transportSha256', 'width', 'height',
      'pixelMode', 'sourcePixelSha256', 'transportPixelSha256', 'conversion', 'reason']) receipt[key] = manifest[key];
    return { ok: true, uploadPath: manifest.transportPath, transport: receipt };
  } catch (error) {
    return { ok: false, reason: `explicit cover transport invalid: ${String(error?.message || error)}` };
  }
}

export function explicitCoverTransportMatches(expected, options) {
  const current = readExplicitLosslessPngTransport(options);
  if (!current.ok) return false;
  if (!expected) return current.transport === null;
  return current.transport !== null && Object.keys(expected).length === Object.keys(current.transport).length
    && Object.entries(current.transport).every(([key, value]) => expected[key] === value);
}
