import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parkingObservation } from './xiaohongshu-parking-fixture.mjs';
import { xhsParkedVideoReplacementGate } from '../lib/xiaohongshu-parked-video-replacement.mjs';
import { evaluateObservation } from '../lib/model.mjs';
import { loadXhsParkingContext } from '../lib/xiaohongshu-parking-context.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture(evidencePath) {
  const o = parkingObservation({ evidencePath });
  const p = o.gates.persistedDraft.evidence, editor = p.editorVerification.observation;
  const local = { path: '/approved/new.mp4', size: 115032686, lastModified: 123456789, sha256: 'b'.repeat(64) };
  const plan = { sourceDraftId: p.draftId, sourceTaskSpaceId: p.taskSpaceId, sourceNativeFileIds: ['old-native-file'],
    sourceVideoSha256: 'a'.repeat(64), nextVideoSha256: local.sha256,
    sourceMetadataHash: hash({ title: 'Approved title' }), sourceCoverHash: 'c'.repeat(64),
    nextVideoPath: local.path, nextVideoSize: local.size, nextVideoMtimeMs: local.lastModified };
  const e = { ...plan, draftId: p.draftId, uid: p.uid, nativeFileIds: [p.videoFileId],
    currentMetadataHash: plan.sourceMetadataHash, currentCoverHash: plan.sourceCoverHash,
    metadataUnchanged: true, coversUnchanged: true, uploadComplete: true, localFile: local, observedAt: editor.observedAt };
  o.videoRevision = { sourceDraftId: p.draftId, sourceTaskSpaceId: p.taskSpaceId,
    sourceVideoSha256: plan.sourceVideoSha256, nextVideoSha256: plan.nextVideoSha256 };
  editor.videoRevision = { ...o.videoRevision }; editor.gates.replaceVideo = { ok: true, evidence: e };
  p.editorVerification.observationHash = hash(editor);
  o.gates.editorVerified.evidence.observationHash = p.editorVerification.observationHash;
  o.gates.parkedDraft.evidence = structuredClone(p);
  o.evidence.currentNativeVideo = { fileid: p.videoFileId, size: local.size, width: 1280, height: 720 };
  const options = { journal: { status: 'confirmed', plan, evidence: e }, currentLocalFile: local, currentCoverHash: plan.sourceCoverHash };
  return { o, options };
}

test('fresh parked original IDB media derives replacement evidence without reopening or saving the empty editor', () => {
  const { o, options } = fixture();
  assert.equal(evaluateObservation(o).ready, false);
  const gate = xhsParkedVideoReplacementGate(o, options);
  assert.equal(gate.ok, true);
  assert.equal(gate.evidence.verificationMethod, 'xhs-parked-native-record-and-immutable-editor-verify');
  assert.equal(evaluateObservation({ ...o, gates: { ...o.gates, replaceVideo: gate } }).ready, true);
  assert.equal(o.gates.replaceVideo, undefined, 'derivation must not mutate historical observation bytes');
});

test('fresh parked replacement fails for substituted bytes, native file, account, original snapshot and cover assets', () => {
  for (const change of [
    (o, opts) => { o.evidence.currentNativeVideo.size = 1; },
    (o, opts) => { o.evidence.currentNativeVideo.fileid = 'foreign'; },
    (o, opts) => { o.evidence.currentNativeRecord.uid = 'foreign'; },
    (o, opts) => { o.evidence.currentNativeRecord.snapshot.title = 'Changed metadata'; },
    (o, opts) => { opts.currentLocalFile = { ...opts.currentLocalFile, sha256: 'd'.repeat(64) }; },
    (o, opts) => { opts.currentCoverHash = 'd'.repeat(64); },
    (o, opts) => { opts.journal.status = 'intent'; },
  ]) {
    const { o, options } = fixture(); change(o, options);
    assert.equal(xhsParkedVideoReplacementGate(o, options).ok, false, change.toString());
  }
});

test('a prior park blocked only by the missing replacement gate can authorize another read-only park, while retaining raw immutable proof hashes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-park-replacement-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const verify = path.join(root, 'independent-verify.json'), failed = path.join(root, 'park-missing-gate.json');
  const { o } = fixture(verify);
  fs.writeFileSync(verify, JSON.stringify({ observation: o.gates.persistedDraft.evidence.editorVerification.observation }));
  o.blocker = { code: 'STATE_AMBIGUOUS', message: 'New video upload lacks its durable original-draft injection evidence and fresh native-file readback' };
  fs.writeFileSync(failed, JSON.stringify({ observation: o }));
  const bytes = fs.readFileSync(failed);
  const context = loadXhsParkingContext({ evidencePath: failed, fingerprint: o.fingerprint, taskSpaceId: 71, historical: true });
  assert.equal(context.priorParking.proof.videoFileId, o.gates.persistedDraft.evidence.videoFileId);
  assert.equal(context.priorParking.observationHash, hash(o));
  assert.deepEqual(fs.readFileSync(failed), bytes);
  o.blocker = { code: 'RISK_CONTROL', message: 'Real platform failure' };
  fs.writeFileSync(failed, JSON.stringify({ observation: o }));
  assert.throws(() => loadXhsParkingContext({ evidencePath: failed, fingerprint: o.fingerprint, taskSpaceId: 71, historical: true }), /incomplete/);
});
