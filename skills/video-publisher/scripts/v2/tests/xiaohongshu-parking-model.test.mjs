import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validPersistence, validXhsParkedPersistence, XHS_PARKED_SURFACE } from '../lib/persistence.mjs';
import { classifyVerdict, compactVerdict, evaluateObservation, requiredGates } from '../lib/model.mjs';

import { parkingObservation as fixture } from './xiaohongshu-parking-fixture.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const at = second => new Date(Date.UTC(2026, 9, 20, 1, 0, second)).toISOString();

function alterProof(observation, change) {
  change(observation.gates.persistedDraft.evidence);
  observation.gates.parkedDraft.evidence = structuredClone(observation.gates.persistedDraft.evidence);
}

function refreshEditorHash(observation) {
  const source = observation.gates.persistedDraft.evidence.editorVerification;
  source.observationHash = digest(source.observation);
  observation.gates.editorVerified.evidence.observationHash = source.observationHash;
  observation.gates.parkedDraft.evidence = structuredClone(observation.gates.persistedDraft.evidence);
}

test('XHS parked proof validates a real verified source without a current final button', () => {
  const o = fixture();
  assert.equal(o.gates.finalButton, undefined);
  assert.equal(validXhsParkedPersistence(o), true);
  assert.equal(validPersistence(o), true);
  const verdict = evaluateObservation(o);
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.required, ['authenticated', 'draftIdentity', 'editorVerified', 'parkedDraft',
    'noActiveEditor', 'persistedDraft', 'safety']);
  const compact = compactVerdict(verdict);
  assert.equal(compact.surface, XHS_PARKED_SURFACE);
  assert.equal(compact.deliveryKind, 'browser_local_draft');
  assert.equal(compact.parkedProof.draftId, 'original-native-uuid');
});

test('parked proof fails closed for every native identity, surface and document mismatch', () => {
  const changes = [
    p => { p.version = 1; }, p => { p.platform = 'bilibili'; }, p => { p.method = 'draft-list-reopen'; },
    p => { p.verificationRunId = 'old-run'; }, p => { p.fingerprint = 'foreign-package'; },
    p => { p.taskSpaceId = 72; }, p => { p.draftId = 'other-uuid'; }, p => { p.uid = 'other-user'; },
    p => { p.videoFileId = 'other-video'; }, p => { p.snapshotHash = '0'.repeat(64); },
    p => { p.coverFileId = 'other-cover'; }, p => { p.coverWidth = 1200; }, p => { p.coverHeight = 1600; },
    p => { p.listEntryId = 'other-uuid'; }, p => { p.visibleRowCount = 0; }, p => { p.visibleRowCount = 2; },
    p => { p.visibleRowTitle = 'Different title'; }, p => { p.documentChanged = false; },
    p => { p.oldEditorAbsent = false; }, p => { p.listUrl = 'https://evil.example/'; },
    p => { p.parkedUrl = 'https://creator.xiaohongshu.com/other'; },
    p => { p.listUrl = p.parkedUrl = 'https://user:secret@creator.xiaohongshu.com/'; },
  ];
  for (const change of changes) {
    const o = fixture(); alterProof(o, change);
    assert.equal(validPersistence(o), false, change.toString());
    assert.equal(evaluateObservation(o).ready, false, change.toString());
    assert.equal(classifyVerdict(evaluateObservation(o)), 'blocked', change.toString());
  }
});

test('parked sequence and independent read must be complete, ordered and fresh', () => {
  for (const [field, value] of [
    ['savedAt', ''], ['editorVerifiedAt', at(0)], ['parkedAt', at(2)],
    ['readAt', at(3)], ['readAt', at(7)],
  ]) {
    const o = fixture(); alterProof(o, p => { p[field] = value; });
    assert.equal(validPersistence(o), false, field + ':' + value);
  }
  const stale = fixture(); stale.observedAt = at(66);
  assert.equal(validPersistence(stale), false);
});

test('historical editor READY is accepted only by explicit park-only mode and remains historical', () => {
  const o = fixture({ historical: true });
  assert.equal(validPersistence(o), true);
  assert.equal(o.gates.persistedDraft.evidence.editorVerification.observation.verificationRunId, 'original-verification-run');
  assert.equal(evaluateObservation(o).ready, true);
  const noOptIn = fixture({ historical: true }); alterProof(noOptIn, p => { delete p.parkOnly; });
  assert.equal(validPersistence(noOptIn), false);
  const recast = fixture({ historical: true });
  alterProof(recast, p => { p.editorVerification.historical = false; });
  recast.gates.editorVerified.evidence.historical = false;
  assert.equal(validPersistence(recast), false);
  const lyingGate = fixture({ historical: true }); lyingGate.gates.editorVerified.evidence.historical = false;
  assert.equal(validPersistence(lyingGate), false);
});

test('a historical source hash or READY boolean cannot replace the original independent evidence', () => {
  const changes = [
    editor => { editor.phase = 'persist'; }, editor => { editor.blocker = { code: 'STATE_AMBIGUOUS' }; },
    editor => { editor.fingerprint = 'other-package'; }, editor => { editor.taskSpaceId = 72; },
    editor => { editor.gates.cover.ok = false; }, editor => { editor.gates.finalButton.ok = false; },
    editor => { editor.gates.safety.evidence.blockedAttempts = 1; },
    editor => { editor.gates.persistedDraft.evidence.documentChanged = false; },
    editor => { editor.gates.persistedDraft.evidence.uid = 'foreign'; },
    editor => { editor.gates.persistedDraft.evidence.draftId = 'foreign'; },
    editor => { editor.gates.persistedDraft.evidence.snapshotHash = '0'.repeat(64); },
    editor => { editor.gates.draftIdentity.evidence.restoredIdentity.videoFileId = 'foreign'; },
    editor => { editor.gates.cover.evidence.nativeCoverFileId = 'foreign'; },
    editor => { editor.gates.cover.evidence.nativeCover.width = 1200; },
    editor => { editor.gates.cover.evidence.recordCover.fileid = 'foreign'; },
  ];
  for (const change of changes) {
    const o = fixture({ historical: true });
    alterProof(o, p => change(p.editorVerification.observation));
    refreshEditorHash(o);
    assert.equal(validPersistence(o), false, change.toString());
  }
  const changed = fixture(); changed.gates.persistedDraft.evidence.editorVerification.observation.ready = true;
  assert.equal(validPersistence(changed), false);
});

test('parked gate booleans require matching independent evidence', () => {
  const changes = [
    o => { o.gates.authenticated.evidence.uid = 'foreign'; },
    o => { o.gates.draftIdentity.evidence.videoFileId = 'foreign'; },
    o => { o.gates.editorVerified.evidence.observationHash = '0'.repeat(64); },
    o => { o.gates.editorVerified.evidence.evidencePath = '/other/evidence.json'; },
    o => { o.gates.editorVerified.evidence.verificationRunId = 'other-run'; },
    o => { o.gates.parkedDraft.evidence.visibleRowCount = 2; },
    o => { o.gates.noActiveEditor.evidence.oldEditorAbsent = false; },
    o => { o.gates.noActiveEditor.evidence.documentChanged = false; },
    o => { o.gates.safety.evidence.guardArmed = false; },
    o => { o.gates.safety.evidence.blockedAttempts = 1; },
  ];
  for (const change of changes) {
    const o = fixture(); change(o);
    assert.equal(validPersistence(o), false, change.toString());
    assert.equal(evaluateObservation(o).ready, false);
  }
});

test('parked READY independently validates raw native record, cover, visible thumbnail and empty editor', () => {
  const changes = [
    o => { delete o.evidence; },
    o => { o.evidence.currentNativeRecord.id = 'foreign'; },
    o => { o.evidence.currentNativeRecord.uid = 'foreign'; },
    o => { o.evidence.currentNativeRecord.snapshot.videoFileId = 'foreign'; },
    o => { o.evidence.currentNativeRecord.snapshot.coverFileId = 'foreign'; },
    o => { o.evidence.currentNativeRecord.snapshot.extra = 'changed'; },
    o => { o.evidence.currentNativeCover.fileid = 'foreign'; },
    o => { o.evidence.currentNativeCover.width = 1200; },
    o => { o.evidence.currentNativeCover.height = 1600; },
    o => { o.evidence.currentListRows = {}; },
    o => { o.evidence.currentListRows = []; },
    o => { o.evidence.currentListRows.push(structuredClone(o.evidence.currentListRows[0])); },
    o => { o.evidence.currentListRows[0].id = 'foreign'; },
    o => { o.evidence.currentListRows[0].title = 'different'; },
    o => { o.evidence.currentListRows[0].visible = false; },
    o => { delete o.evidence.currentListRows[0].thumbnailImages; },
    o => { o.evidence.currentListRows[0].thumbnailImages[0].complete = false; },
    o => { o.evidence.currentListRows[0].thumbnailImages[0].naturalWidth = 0; },
    o => { o.evidence.currentListRows[0].thumbnailImages[0].naturalHeight = 0; },
    o => { o.evidence.currentListRows[0].thumbnailImages[0].visible = false; },
    o => { o.evidence.currentListRows[0].thumbnailImages[0].decoded = false; },
    o => { o.evidence.currentListRows[0].thumbnailImages[0].src = 'https://example.test/spectrum/other-cover'; },
    o => { o.evidence.currentListRows[0].thumbnailImages.push(structuredClone(o.evidence.currentListRows[0].thumbnailImages[0])); },
    o => { delete o.evidence.currentEditor; },
    o => { delete o.evidence.currentEditor.activeId; },
    o => { o.evidence.currentEditor.activeId = 'original-native-uuid'; },
    o => { o.evidence.currentEditor.activeVideoFileId = 'original-upload-file'; },
    o => { o.evidence.currentEditor.activeTitle = 'Approved title'; },
    o => { o.evidence.currentEditor.activeDescription = 'old body'; },
    o => { o.evidence.currentEditor.url = 'https://creator.xiaohongshu.com/other'; },
    o => { delete o.gates.parkedDraft.evidence; },
  ];
  for (const change of changes) {
    const o = fixture(); change(o);
    assert.doesNotThrow(() => validPersistence(o), change.toString());
    assert.equal(validPersistence(o), false, change.toString());
    assert.equal(evaluateObservation(o).ready, false, change.toString());
  }
});

test('an XHS surface label alone cannot bypass editor gates or claim a parked delivery', () => {
  const o = fixture();
  o.gates.persistedDraft = structuredClone(o.gates.persistedDraft.evidence.editorVerification.observation.gates.persistedDraft);
  assert.equal(evaluateObservation(o).ready, false);
  assert.equal(compactVerdict(evaluateObservation(o)).parkedProof, null);
  const nonXhs = fixture(); nonXhs.platform = 'bilibili';
  assert.equal(requiredGates('bilibili', XHS_PARKED_SURFACE).includes('finalButton'), true);
  assert.equal(validPersistence(nonXhs), false);
});

test('ALREADY_PUBLISHED is terminal even when video state is absent or caller requests retry', () => {
  const o = fixture(); o.blocker = { code: 'ALREADY_PUBLISHED', retryable: true };
  delete o.gates.draftIdentity;
  const verdict = evaluateObservation(o);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.blocker.code, 'ALREADY_PUBLISHED');
  assert.equal(verdict.blocker.retryable, false);
  assert.equal(classifyVerdict(verdict), 'blocked');
});
