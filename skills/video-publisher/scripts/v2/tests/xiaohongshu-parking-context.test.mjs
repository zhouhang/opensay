import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadXhsParkingContext } from '../lib/xiaohongshu-parking-context.mjs';
import { evaluateObservation } from '../lib/model.mjs';
import { parkingObservation } from './xiaohongshu-parking-fixture.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-parking-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const evidencePath = path.join(dir, 'editor.json');
  const observation = parkingObservation({ historical: true, evidencePath })
    .gates.persistedDraft.evidence.editorVerification.observation;
  const write = (value = { observation }) => fs.writeFileSync(evidencePath, JSON.stringify(value));
  const args = { evidencePath, fingerprint: observation.fingerprint, taskSpaceId: 71, verificationRunId: observation.verificationRunId };
  write();
  return { dir, evidencePath, observation, args, write };
}

test('parking context requires current verify run unless historical park-only is explicit', t => {
  const h = fixture(t);
  const current = loadXhsParkingContext(h.args);
  assert.equal(current.historical, false);
  assert.equal(current.parkOnly, false);
  assert.equal(current.observationHash, digest(h.observation));
  assert.throws(() => loadXhsParkingContext({ ...h.args, verificationRunId: 'new-run' }));
  const historical = loadXhsParkingContext({ ...h.args, verificationRunId: 'new-run', historical: true });
  assert.equal(historical.historical, true);
  assert.equal(historical.parkOnly, true);
  assert.equal(historical.observation.verificationRunId, h.observation.verificationRunId);
  assert.equal(historical.observation.observedAt, h.observation.observedAt);
});

test('parking context rejects action receipts, compact READY and wrong identity', t => {
  const h = fixture(t);
  for (const value of [null, [], {}, { ready: true }, { verdict: { ready: true } },
    { observation: { ...h.observation, phase: 'persist' } },
    { observation: { ...h.observation, platform: 'bilibili' } },
    { observation: { ...h.observation, fingerprint: 'global-bili-revision-fingerprint' } },
    { observation: { ...h.observation, taskSpaceId: 72 } }]) {
    h.write(value);
    assert.throws(() => loadXhsParkingContext({ ...h.args, historical: true }));
  }
  h.write();
  for (const gate of ['cover', 'persistedDraft', 'safety', 'finalButton']) {
    const original = h.observation.gates[gate].ok;
    h.observation.gates[gate].ok = false; h.write();
    assert.throws(() => loadXhsParkingContext(h.args), gate);
    h.observation.gates[gate].ok = original;
  }
});

test('parked artifact context reuses unchanged original editor artifact without recasting its run', t => {
  const h = fixture(t);
  const parkedPath = path.join(h.dir, 'parked.json');
  const parked = { observation: parkingObservation({ historical: true, evidencePath: h.evidencePath }) };
  const prior = parked.observation.gates.persistedDraft.evidence.editorVerification;
  fs.writeFileSync(parkedPath, JSON.stringify(parked));
  const args = { ...h.args, evidencePath: parkedPath, verificationRunId: 'new-run', historical: true };
  const context = loadXhsParkingContext(args);
  assert.equal(context.evidencePath, h.evidencePath);
  assert.equal(context.observation.verificationRunId, h.observation.verificationRunId);
  assert.equal(context.observationHash, prior.observationHash);
  assert.equal(context.priorParking.proof.draftId, 'original-native-uuid');
  assert.equal(context.priorParking.evidencePath, parkedPath);
  assert.equal(context.priorParking.observationHash, digest(parked.observation));
  assert.throws(() => loadXhsParkingContext({ ...args, historical: false }));
  h.observation.gates.title.evidence.changed = true; h.write();
  assert.throws(() => loadXhsParkingContext(args), /changed/);
});



test('legacy parked thumbnail evidence is only a locator and still requires a fresh loaded image', t => {
  const h = fixture(t);
  const parkedPath = path.join(h.dir, 'legacy-parked.json');
  const parked = parkingObservation({ historical: true, evidencePath: h.evidencePath });
  const row = parked.evidence.currentListRows[0];
  delete row.visible;
  delete row.thumbnailImages;
  // The native drawer records the same cover as an img URL and CSS background.
  // These two references identify one cover, not two competing objects.
  row.thumbnailUrls.push(`url("${row.thumbnailUrls[0]}")`);
  fs.writeFileSync(parkedPath, JSON.stringify({ observation: parked }));
  assert.equal(evaluateObservation(parked).ready, false, 'legacy evidence must never become READY');
  const context = loadXhsParkingContext({ ...h.args, evidencePath: parkedPath,
    verificationRunId: 'new-run', historical: true });
  assert.equal(context.parkOnly, true);
  assert.equal(context.evidencePath, h.evidencePath);
  assert.equal(context.observationHash, digest(h.observation));
  assert.equal(context.priorParking.legacyThumbnailLocatorOnly, true);
  assert.equal(context.priorParking.proof.draftId, 'original-native-uuid');
  assert.equal(context.priorParking.proof.coverFileId, 'spectrum/accepted-cover');
  assert.equal(context.priorParking.observationHash, digest(parked));
  assert.equal(context.priorParking.proof.editorVerification.observationHash, digest(h.observation));
  assert.throws(() => loadXhsParkingContext({ ...h.args, evidencePath: parkedPath,
    verificationRunId: 'new-run', historical: false }), /incomplete/);

  const fresh = structuredClone(parked);
  fresh.evidence.currentListRows[0].visible = true;
  fresh.evidence.currentListRows[0].thumbnailImages = [{
    src: 'https://ros-preview.xhscdn.com/spectrum/accepted-cover?sign=fresh', complete: true,
    naturalWidth: 1600, naturalHeight: 1200, visible: true, decoded: true,
  }];
  assert.equal(evaluateObservation(fresh).ready, true, 'only a fresh loaded and decoded image restores READY');
});

test('legacy locator rejects blockers, foreign native identity, incomplete fields and changed editor source', t => {
  const changes = [
    o => { o.blocker = { code: 'PERSISTENCE_UNVERIFIED' }; },
    o => { o.fingerprint = 'foreign'; },
    o => { o.taskSpaceId = 72; },
    o => { o.evidence.currentNativeRecord.uid = 'foreign'; },
    o => { o.evidence.currentNativeRecord.snapshot.videoFileId = 'foreign'; },
    o => { o.evidence.currentNativeRecord.snapshot.title = 'changed'; },
    o => { o.evidence.currentNativeCover.fileid = 'spectrum/foreign'; },
    o => { delete o.gates.persistedDraft.evidence.uid; },
    o => { delete o.gates.persistedDraft.evidence.videoFileId; },
    o => { delete o.gates.persistedDraft.evidence.snapshotHash; },
    o => { delete o.gates.persistedDraft.evidence.coverFileId; },
    o => { o.evidence.currentListRows[0].thumbnailImages = [{ src: 'https://cdn/spectrum/accepted-cover',
      complete: true, naturalWidth: 0, naturalHeight: 0, visible: true, decoded: false }]; },
  ];
  for (const change of changes) {
    const h = fixture(t);
    const parkedPath = path.join(h.dir, `legacy-reject-${Math.random()}.json`);
    const parked = parkingObservation({ historical: true, evidencePath: h.evidencePath });
    delete parked.evidence.currentListRows[0].visible;
    delete parked.evidence.currentListRows[0].thumbnailImages;
    change(parked);
    fs.writeFileSync(parkedPath, JSON.stringify({ observation: parked }));
    assert.throws(() => loadXhsParkingContext({ ...h.args, evidencePath: parkedPath,
      verificationRunId: 'new-run', historical: true }), /incomplete/, change.toString());
  }

  const h = fixture(t);
  const parkedPath = path.join(h.dir, 'legacy-bad-source-hash.json');
  const parked = parkingObservation({ historical: true, evidencePath: h.evidencePath });
  delete parked.evidence.currentListRows[0].visible;
  delete parked.evidence.currentListRows[0].thumbnailImages;
  parked.gates.persistedDraft.evidence.editorVerification.observationHash = '0'.repeat(64);
  fs.writeFileSync(parkedPath, JSON.stringify({ observation: parked }));
  assert.throws(() => loadXhsParkingContext({ ...h.args, evidencePath: parkedPath,
    verificationRunId: 'new-run', historical: true }), /source|incomplete/);
});

test('broken JSON, broken nested hash and missing original file are rejected before runtime', t => {
  const h = fixture(t);
  fs.writeFileSync(h.evidencePath, '{broken');
  assert.throws(() => loadXhsParkingContext(h.args));
  for (const prior of [null, {}, { observation: h.observation, observationHash: '0'.repeat(64), evidencePath: '/missing' },
    { observation: h.observation, observationHash: digest(h.observation), evidencePath: path.join(h.dir, 'missing') }]) {
    h.write({ observation: { surface: 'xhs-draft-list-parked', gates: { persistedDraft: { evidence: { editorVerification: prior } } } } });
    assert.throws(() => loadXhsParkingContext({ ...h.args, historical: true }));
  }
});
