import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getImageDimensions } from "../lib/content-package.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-webp-cover-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;
const unknown = { width: 0, height: 0, format: "unknown" };
function inspect(bytes) {
  const file = path.join(root, `${serial++}.image`);
  fs.writeFileSync(file, bytes);
  return getImageDimensions(file);
}
function chunk(type, payload) {
  const result = Buffer.alloc(8 + payload.length + payload.length % 2);
  result.write(type, 0, 4, "ascii");
  result.writeUInt32LE(payload.length, 4);
  payload.copy(result, 8);
  return result;
}
function webp(...chunks) {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0);
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8);
  return Buffer.concat([header, body]);
}
function vp8(width, height) {
  const payload = Buffer.from([0x10, 0, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0]);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return chunk("VP8 ", payload);
}
function vp8l(width, height, alpha = false) {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE(((width - 1) | ((height - 1) << 14) | (alpha ? 1 << 28 : 0)) >>> 0, 1);
  return chunk("VP8L", payload);
}
function vp8x(width, height, extra = Buffer.alloc(0)) {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return chunk("VP8X", Buffer.concat([payload, extra]));
}
function expected(width, height) { return { width, height, format: "webp" }; }

test("lossy VP8 dimensions ignore scale bits and retain the significant FourCC space", () => {
  assert.deepEqual(inspect(webp(vp8(1792 | 0xc000, 1344 | 0x8000))), expected(1792, 1344));
  assert.deepEqual(inspect(webp(chunk("VP8?", vp8(30, 40).subarray(8)))), unknown);
});

test("lossless VP8L reads packed dimensions, alpha hint, and their inclusive bounds", () => {
  assert.deepEqual(inspect(webp(vp8l(1344, 1792, true))), expected(1344, 1792));
  assert.deepEqual(inspect(webp(vp8l(1, 1))), expected(1, 1));
  assert.deepEqual(inspect(webp(vp8l(16384, 16384))), expected(16384, 16384));
});

test("extended VP8X uses canvas dimensions with metadata and image data", () => {
  assert.deepEqual(inspect(webp(vp8x(2048, 1152), chunk("ICCP", Buffer.from([1, 2, 3])), vp8(2048, 1152))), expected(2048, 1152));
  assert.deepEqual(inspect(webp(vp8x(1152, 2048), vp8l(1152, 2048), chunk("XMP ", Buffer.from("metadata")))), expected(1152, 2048));
});

test("unrelated chunks and zero padding are skipped while the whole container is scanned", () => {
  assert.deepEqual(inspect(webp(chunk("JUNK", Buffer.from([7])), vp8l(30, 40), chunk("EXIF", Buffer.from([3])))), expected(30, 40));
  assert.deepEqual(inspect(webp(vp8x(30, 40, Buffer.from([5])), vp8(30, 40))), expected(30, 40));
});

test("every truncation of a complete WebP fails closed without an out-of-bounds read", () => {
  const complete = webp(vp8x(30, 40), vp8l(30, 40), chunk("EXIF", Buffer.from([3])));
  for (let length = 0; length < complete.length; length += 1) {
    assert.deepEqual(inspect(complete.subarray(0, length)), unknown, `length=${length}`);
  }
});

test("RIFF size disagreement, trailing data, odd file size, and wrong signatures fail closed", () => {
  const valid = webp(vp8(30, 40));
  const smaller = Buffer.from(valid); smaller.writeUInt32LE(valid.length - 10, 4);
  const larger = Buffer.from(valid); larger.writeUInt32LE(valid.length - 6, 4);
  const odd = Buffer.from(valid); odd.writeUInt32LE(valid.length - 7, 4);
  const wrong = Buffer.from(valid); wrong.write("WAVE", 8);
  for (const bytes of [smaller, larger, odd, wrong, Buffer.concat([valid, Buffer.from([0, 0])])]) {
    assert.deepEqual(inspect(bytes), unknown);
  }
});

test("incomplete chunk headers and declared payload overruns are rejected even after dimensions", () => {
  const incompleteHeader = webp(vp8(30, 40), Buffer.alloc(2));
  const overrun = chunk("EXIF", Buffer.from([1, 2])); overrun.writeUInt32LE(0xffffffff, 4);
  assert.deepEqual(inspect(incompleteHeader), unknown);
  assert.deepEqual(inspect(webp(vp8l(30, 40), overrun)), unknown);
});

test("missing or nonzero odd-chunk padding is rejected", () => {
  const odd = chunk("JUNK", Buffer.from([7]));
  odd[odd.length - 1] = 1;
  assert.deepEqual(inspect(webp(odd, vp8(30, 40))), unknown);
  assert.deepEqual(inspect(webp(vp8l(30, 40)).subarray(0, -1)), unknown);
});

test("undersized image headers and malformed codec signatures fail closed", () => {
  for (const [type, length] of [["VP8 ", 9], ["VP8L", 4], ["VP8X", 9]]) {
    assert.deepEqual(inspect(webp(chunk(type, Buffer.alloc(length)))), unknown);
  }
  const interframe = vp8(30, 40); interframe[8] |= 1;
  const badSync = vp8(30, 40); badSync[11] = 0;
  const reservedVp8Version = vp8(30, 40); reservedVp8Version[8] |= 8;
  const badLosslessSignature = vp8l(30, 40); badLosslessSignature[8] = 0;
  const reservedLosslessVersion = vp8l(30, 40); reservedLosslessVersion[12] |= 0x20;
  for (const image of [interframe, badSync, reservedVp8Version, badLosslessSignature, reservedLosslessVersion]) {
    assert.deepEqual(inspect(webp(image)), unknown);
  }
});

test("invalid dimensions, conflicting headers, and duplicate image headers are rejected", () => {
  for (const bytes of [
    webp(vp8(0, 30)), webp(vp8(30, 0)), webp(vp8x(65536, 65536)),
    webp(vp8x(30, 40), vp8(31, 40)), webp(vp8x(30, 40), vp8x(30, 40)),
    webp(vp8(30, 40), vp8l(30, 40)), webp(chunk("JUNK", Buffer.alloc(0))),
  ]) assert.deepEqual(inspect(bytes), unknown);
});

test("existing PNG and JPEG header dimensions remain compatible", () => {
  const png = Buffer.alloc(24);
  png[0] = 0x89; png.write("PNG", 1);
  png.writeUInt32BE(1080, 16); png.writeUInt32BE(1440, 20);
  assert.deepEqual(inspect(png), { width: 1080, height: 1440, format: "png" });
  const jpeg = Buffer.alloc(15);
  jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8]);
  jpeg.writeUInt16BE(1200, 7); jpeg.writeUInt16BE(1600, 9);
  assert.deepEqual(inspect(jpeg), { width: 1600, height: 1200, format: "jpeg" });
});
