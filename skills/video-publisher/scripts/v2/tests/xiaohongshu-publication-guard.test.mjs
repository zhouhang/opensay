import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { checkXhsRecoveryPublication, readXhsPublicationStatus, xhsNativePublicationBlocker } from '../lib/xiaohongshu-publication-guard.mjs';

const plan = { id: 'uuid-original', uid: 'owner', videoFileId: 'spectrum/original-file' };
const now = Date.now();
function fixture(patch = {}, recordPatch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-publication-'));
  const evidencePath = path.join(dir, 'native-status.json');
  const native = { platform: 'xiaohongshu', sourceUrl: 'https://creator.xiaohongshu.com/publish/publish',
    observedAt: new Date(now).toISOString(), complete: true,
    resources: [{ uid: plan.uid, draftId: plan.id, videoFileId: plan.videoFileId,
      published: false, noteId: null, statusAuthority: 'native-resource-detail', ...recordPatch }], ...patch };
  fs.writeFileSync(evidencePath, JSON.stringify(native));
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, platform: 'xiaohongshu', evidencePath,
    evidenceSha256: createHash('sha256').update(fs.readFileSync(evidencePath)).digest('hex') }));
  return { file, evidencePath, dir };
}

test('stale editor false publication flags are not proof that a resource is unpublished', () => {
  assert.equal(xhsNativePublicationBlocker({ publication: { hasBeenPublished: false, hasBeenPublishSuccess: false } }), null);
  assert.equal(checkXhsRecoveryPublication({ journal: { status: 'confirmed', plan }, now }).blocker.code, 'STATE_AMBIGUOUS');
});

test('all positive native publication signals block old editor mutation', () => {
  for (const publication of [{ noteId: 'native-note' }, { hasBeenPublished: true }, { hasBeenPublishSuccess: true }]) {
    assert.equal(xhsNativePublicationBlocker({ id: plan.id, uid: plan.uid, live: { videoFileId: plan.videoFileId }, publication }).code, 'ALREADY_PUBLISHED');
  }
});

test('fresh explicit native resource detail permits only the exact original identity', () => {
  const f = fixture();
  try {
    assert.equal(readXhsPublicationStatus(f.file, plan, now).allowed, true);
    for (const wrong of [{ ...plan, id: 'other' }, { ...plan, uid: 'other' }, { ...plan, videoFileId: 'other' }]) {
      assert.equal(readXhsPublicationStatus(f.file, wrong, now).blocker.code, 'STATE_AMBIGUOUS');
    }
  } finally { fs.rmSync(f.dir, { recursive: true }); }
});

test('published note identity remains terminal after freshness expires', () => {
  const f = fixture({ observedAt: '2025-01-01T00:00:00Z' }, { published: true, noteId: 'native-note' });
  try { assert.equal(readXhsPublicationStatus(f.file, plan, now).blocker.code, 'ALREADY_PUBLISHED'); }
  finally { fs.rmSync(f.dir, { recursive: true }); }
});

test('absence, titles, incomplete lists, expired details, changed files and corruption fail closed', () => {
  for (const patch of [{ resources: [] }, { complete: false }, { observedAt: new Date(now - 60001).toISOString() },
    { observedAt: new Date(now + 1).toISOString() }, { sourceUrl: 'https://example.test/status' }]) {
    const f = fixture(patch);
    try { assert.equal(readXhsPublicationStatus(f.file, plan, now).blocker.code, 'STATE_AMBIGUOUS'); }
    finally { fs.rmSync(f.dir, { recursive: true }); }
  }
  for (const record of [{ statusAuthority: 'title-match' }, { draftId: undefined }, { noteId: '' }, { published: undefined }]) {
    const f = fixture({}, record);
    try { assert.equal(readXhsPublicationStatus(f.file, plan, now).blocker.code, 'STATE_AMBIGUOUS'); }
    finally { fs.rmSync(f.dir, { recursive: true }); }
  }
  const f = fixture();
  try {
    fs.appendFileSync(f.evidencePath, ' ');
    assert.equal(readXhsPublicationStatus(f.file, plan, now).blocker.code, 'STATE_AMBIGUOUS');
    fs.writeFileSync(f.file, '{');
    assert.equal(readXhsPublicationStatus(f.file, plan, now).blocker.code, 'STATE_AMBIGUOUS');
  } finally { fs.rmSync(f.dir, { recursive: true }); }
});

test('protective park is allowed without status proof; fresh unsaved jobs are unaffected', () => {
  assert.equal(checkXhsRecoveryPublication({ journal: { status: 'confirmed', plan }, operation: 'park' }).protectiveParking, true);
  assert.equal(checkXhsRecoveryPublication({ journal: null, operation: 'auto' }).allowed, true);
});
