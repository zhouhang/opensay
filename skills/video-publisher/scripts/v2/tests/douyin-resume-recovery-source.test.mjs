import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { douyinResumeRecoverySource } from '../lib/douyin-resume-recovery-source.mjs';

const BUSINESS_GATES = ['authenticated', 'draftIdentity', 'video', 'title', 'description', 'tags',
  'settings', 'cover', 'noBlockingDialog', 'finalButton', 'safety'];
const nativeId = 'original-native-editor-id';
const cacheKey = 'publish_form_cache:original-account';
const at = second => `2026-10-09T12:${second < 60 ? '00' : '01'}:${String(second % 60).padStart(2, '0')}.000Z`;

function safeGate() {
  return { ok: true, evidence: { finalPublishClicked: false, guardArmed: true, blockedAttempts: 0 } };
}

function observation(phase, second, run = 'recovery-run') {
  return {
    platform: 'douyin', fingerprint: 'approved-tags-fingerprint', taskSpaceId: 42,
    phase, observedAt: at(second), verificationRunId: run, finalPublishClicked: false,
    gates: { ...Object.fromEntries(BUSINESS_GATES.map(key => [key, { ok: true, evidence: {} }])), safety: safeGate() },
  };
}

function fixture() {
  const proof = observation('verify', 3, 'earlier-ready-run');
  proof.gates.persistedDraft = { ok: true, evidence: {
    version: 2, method: 'resume-slot-reopen', platform: 'douyin', fingerprint: proof.fingerprint,
    verificationRunId: proof.verificationRunId, draftId: 'stable-resume-slot-id', resumeSlotId: 'stable-resume-slot-id',
    resumeSlotObserved: true, reopenedId: nativeId, routeChanged: true, contentReadback: true,
    savedAt: at(1), readAt: at(2), uploadUrl: 'https://creator.douyin.com/creator-micro/content/upload?enter_from=publish',
    reopenedUrl: 'https://creator.douyin.com/creator-micro/content/post/video?enter_from=draft',
    cacheKey, cacheDigest: 'old-raw-cache-digest',
  } };
  const inspection = observation('inspect', 60);
  inspection.gates.draftIdentity.evidence.restoredIdentity = {
    ok: true, existingDraft: true, consumedSlot: true, actualId: nativeId, draftId: 'stable-resume-slot-id',
  };
  const failure = observation('persist', 62);
  failure.gates = { safety: safeGate() };
  failure.blocker = { code: 'PERSISTENCE_UNVERIFIED', evidence: {
    available: true, continueCount: 1, cacheEntries: [
      { key: cacheKey, digest: 'changed-raw-cache-digest', active: true, length: 100 },
      { key: 'publish_form_cache:inactive-account', digest: 'inactive', active: false, length: 4 },
    ],
  } };
  const records = [proof, inspection, failure].map((value, index) => ({
    path: `/virtual/douyin-history/${index}.json`, observation: value,
  }));
  const state = {
    fingerprint: proof.fingerprint,
    tagRevision: { previousFingerprint: 'original-fingerprint', nextFingerprint: proof.fingerprint },
    platforms: { douyin: { taskSpaceId: 42, history: records.map(record => ({ evidencePath: record.path })), lastEvidencePath: records.at(-1).path } },
  };
  return { state, records };
}

// The selector reads only this in-memory evidence map. These tests never read or
// write personal configuration, browser state, or a real job directory.
function harness(t) {
  let data = fixture();
  t.mock.method(fs, 'readFileSync', file => {
    const record = data.records.find(entry => entry.path === String(file));
    if (!record || record.missing) throw new Error('missing synthetic evidence');
    return record.raw ?? JSON.stringify({ observation: record.observation, verdict: { ready: true } });
  });
  return {
    get state() { return data.state; },
    get records() { return data.records; },
    get proof() { return data.records[0].observation; },
    get inspection() { return data.records.find(entry => entry.path.endsWith('/1.json')).observation; },
    get failure() { return data.records.find(entry => entry.path.endsWith('/2.json')).observation; },
    reset() { data = fixture(); },
    read() { return douyinResumeRecoverySource(data.state); },
    insert(value, index = data.records.length) {
      data.records.splice(index, 0, { path: `/virtual/douyin-history/extra-${data.records.length}.json`, observation: value });
      this.sync();
    },
    sync() {
      data.state.platforms.douyin.history = data.records.map(record => ({ evidencePath: record.path }));
      data.state.platforms.douyin.lastEvidencePath = data.records.at(-1).path;
    },
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('extracts the exact prior READY, same-run consumed editor inspection, and cache mismatch failure', t => {
  const h = harness(t);
  const result = h.read();
  assert.deepEqual(result, { inspection: h.inspection, failure: h.failure, proof: h.proof });
  assert.deepEqual(Object.keys(result).sort(), ['failure', 'inspection', 'proof']);
  assert.equal(result.ready, undefined);
  assert.notEqual(result.proof.verificationRunId, result.inspection.verificationRunId);
  assert.equal(result.inspection.verificationRunId, result.failure.verificationRunId);
});

test('accepts equivalent numeric space IDs and de-duplicates lastEvidencePath', t => {
  const h = harness(t);
  h.state.platforms.douyin.taskSpaceId = '42';
  h.state.platforms.douyin.history.push({ evidencePath: h.state.platforms.douyin.lastEvidencePath });
  assert.notEqual(h.read(), null);
});

test('rejects a missing or inconsistent revision and absent recorded task space', t => {
  const h = harness(t);
  for (const edit of [
    state => { delete state.tagRevision; },
    state => { state.tagRevision.nextFingerprint = 'another'; },
    state => { state.tagRevision.previousFingerprint = state.fingerprint; },
    state => { delete state.tagRevision.previousFingerprint; },
    state => { delete state.fingerprint; },
    state => { delete state.platforms.douyin; },
    state => { state.platforms.douyin.taskSpaceId = null; },
    state => { state.platforms.douyin.history = {}; },
  ]) {
    h.reset(); edit(h.state); assert.equal(h.read(), null);
  }
  assert.equal(douyinResumeRecoverySource(undefined), null);
  assert.equal(douyinResumeRecoverySource(null), null);
  assert.equal(douyinResumeRecoverySource({}), null);
});

test('rejects cross-platform, cross-fingerprint and cross-space evidence in every role', t => {
  const h = harness(t);
  for (const role of ['proof', 'inspection', 'failure']) {
    for (const [field, value] of Object.entries({ platform: 'xiaohongshu', fingerprint: 'different-fingerprint', taskSpaceId: 43 })) {
      h.reset(); h[role][field] = value;
      assert.equal(h.read(), null, `${role}.${field}`);
    }
    h.reset(); h[role].taskSpaceRecovery = { recreated: true };
    assert.equal(h.read(), null, `${role}.recreated`);
  }
});

test('inspection and failure must share a nonempty verification run', t => {
  const h = harness(t);
  h.failure.verificationRunId = 'other-run';
  assert.equal(h.read(), null);
  for (const role of ['inspection', 'failure']) {
    h.reset(); delete h[role].verificationRunId; assert.equal(h.read(), null, role);
  }
  h.reset(); h.inspection.verificationRunId = ''; h.failure.verificationRunId = '';
  assert.equal(h.read(), null);
});

test('the consumed editor native ID must match the original persistence proof', t => {
  const h = harness(t);
  for (const edit of [
    () => { h.proof.gates.persistedDraft.evidence.reopenedId = 'different-native-id'; },
    () => { h.inspection.gates.draftIdentity.evidence.restoredIdentity.actualId = 'different-native-id'; },
    () => { delete h.inspection.gates.draftIdentity.evidence.restoredIdentity.actualId; },
    () => { h.inspection.gates.draftIdentity.evidence.restoredIdentity.ok = false; },
    () => { h.inspection.gates.draftIdentity.evidence.restoredIdentity.existingDraft = false; },
    () => { h.inspection.gates.draftIdentity.evidence.restoredIdentity.consumedSlot = false; },
  ]) {
    h.reset(); edit(); assert.equal(h.read(), null);
  }
});

test('every business gate is required on both the READY proof and consumed editor inspection', t => {
  const h = harness(t);
  for (const role of ['proof', 'inspection']) {
    for (const gate of BUSINESS_GATES) {
      h.reset(); delete h[role].gates[gate]; assert.equal(h.read(), null, `${role}.${gate} missing`);
      h.reset(); h[role].gates[gate].ok = false; assert.equal(h.read(), null, `${role}.${gate} false`);
    }
  }
});

test('every source observation must carry an armed, untouched final publish guard', t => {
  const h = harness(t);
  for (const role of ['proof', 'inspection', 'failure']) {
    for (const [field, value] of Object.entries({ guardArmed: false, blockedAttempts: 1, finalPublishClicked: true })) {
      h.reset(); h[role].gates.safety.evidence[field] = value;
      assert.equal(h.read(), null, `${role}.safety.${field}`);
    }
    h.reset(); delete h[role].gates.safety.evidence.finalPublishClicked;
    assert.equal(h.read(), null, `${role}.missing final click proof`);
    h.reset(); h[role].gates.safety.ok = false; assert.equal(h.read(), null, `${role}.false safety gate`);
  }
});

test('top-level finalPublishClicked must be explicitly false on every source observation', t => {
  const h = harness(t);
  for (const role of ['proof', 'inspection', 'failure']) {
    for (const value of [true, undefined, null, 0, 'false']) {
      h.reset(); h[role].finalPublishClicked = value;
      assert.equal(h.read(), null, `${role}.${String(value)}`);
    }
  }
});

test('rejects an invalid or stale original persistence proof', t => {
  const h = harness(t);
  const edits = [
    proof => { proof.gates.persistedDraft.ok = false; },
    proof => { delete proof.gates.persistedDraft; },
    proof => { proof.verificationRunId = 'unbound-run'; },
    proof => { proof.gates.persistedDraft.evidence.version = 1; },
    proof => { proof.gates.persistedDraft.evidence.platform = 'youtube'; },
    proof => { proof.gates.persistedDraft.evidence.fingerprint = 'unbound-fingerprint'; },
    proof => { proof.gates.persistedDraft.evidence.method = 'draft-list-reopen'; },
    proof => { proof.gates.persistedDraft.evidence.resumeSlotId = 'different-slot'; },
    proof => { proof.gates.persistedDraft.evidence.resumeSlotObserved = false; },
    proof => { proof.gates.persistedDraft.evidence.routeChanged = false; },
    proof => { proof.gates.persistedDraft.evidence.contentReadback = false; },
    proof => { proof.gates.persistedDraft.evidence.savedAt = 'invalid'; },
    proof => { proof.gates.persistedDraft.evidence.readAt = at(0); },
    proof => { proof.gates.persistedDraft.evidence.uploadUrl = ''; },
    proof => { proof.gates.persistedDraft.evidence.reopenedUrl = ''; },
    proof => { proof.observedAt = '2026-10-09T12:01:03.000Z'; },
    proof => { proof.blocker = { code: 'STATE_AMBIGUOUS' }; },
  ];
  for (const edit of edits) {
    h.reset(); edit(h.proof); assert.equal(h.read(), null);
  }
});

test('requires a persist failure with exactly one active cache and the original cache key', t => {
  const h = harness(t);
  const edits = [
    failure => { failure.phase = 'verify'; },
    failure => { failure.blocker.code = 'STATE_AMBIGUOUS'; },
    failure => { failure.blocker.evidence.available = false; },
    failure => { failure.blocker.evidence.continueCount = 0; },
    failure => { failure.blocker.evidence.continueCount = 2; },
    failure => { failure.blocker.evidence.cacheEntries = []; },
    failure => { failure.blocker.evidence.cacheEntries[0].active = false; },
    failure => { failure.blocker.evidence.cacheEntries[1].active = true; },
    failure => { failure.blocker.evidence.cacheEntries[0].key = 'publish_form_cache:foreign-account'; },
    failure => { failure.blocker.evidence.cacheEntries[0].digest = ''; },
    failure => { failure.blocker.evidence.cacheEntries[0].digest = 'old-raw-cache-digest'; },
  ];
  for (const edit of edits) {
    h.reset(); edit(h.failure); assert.equal(h.read(), null);
  }
});

test('malformed cache evidence fails closed without throwing', t => {
  const h = harness(t);
  for (const value of [undefined, null, {}, 'cache', [null], [1], [{ active: 'true' }]]) {
    h.reset(); h.failure.blocker.evidence.cacheEntries = value;
    assert.doesNotThrow(() => h.read());
    assert.equal(h.read(), null);
  }
  h.reset(); delete h.failure.blocker.evidence;
  assert.equal(h.read(), null);
});

test('observation times must be finite and ordered proof, inspection, then failure', t => {
  const h = harness(t);
  for (const role of ['proof', 'inspection', 'failure']) {
    for (const value of [undefined, 'invalid']) {
      h.reset(); h[role].observedAt = value; assert.equal(h.read(), null, role);
    }
  }
  h.reset(); h.failure.observedAt = at(59); assert.equal(h.read(), null);
  h.reset(); h.inspection.observedAt = at(0); assert.equal(h.read(), null);
});

test('a blocked consumed editor inspection cannot authorize cache recovery', t => {
  const h = harness(t);
  h.inspection.blocker = { code: 'FOREIGN_DRAFT' };
  assert.equal(h.read(), null);
});

test('mutation after the READY proof, after inspection, or after failure invalidates the source', t => {
  const h = harness(t);
  for (const [index, second] of [[1, 30], [2, 61], [3, 63]]) {
    for (const phase of ['mutate', 'upload', 'upload_start', 'prefill', 'quarantine']) {
      h.reset(); h.insert(observation(phase, second), index);
      assert.equal(h.read(), null, `${phase} at ${index}`);
    }
  }
});

test('cross-run, cross-space and cross-fingerprint intervening inspections invalidate the chain', t => {
  const h = harness(t);
  for (const [field, value] of Object.entries({ verificationRunId: 'another-run', taskSpaceId: 43, fingerprint: 'another-fingerprint' })) {
    h.reset(); const middle = observation('inspect', 61); middle[field] = value; h.insert(middle, 2);
    assert.equal(h.read(), null, field);
  }
});

test('unarmed or clicked safety guards on subsequent read-only rows invalidate the source', t => {
  const h = harness(t);
  for (const phase of ['inspect', 'persist', 'verify']) {
    for (const [field, value] of Object.entries({ guardArmed: false, blockedAttempts: 1, finalPublishClicked: true })) {
      h.reset(); const later = observation(phase, 63); later.gates.safety.evidence[field] = value; h.insert(later);
      assert.equal(h.read(), null, `${phase}.${field}`);
    }
  }
});

test('safe subsequent read-only rows do not turn the historical source into a READY verdict', t => {
  const h = harness(t);
  for (const phase of ['inspect', 'persist', 'verify']) {
    h.reset(); h.insert(observation(phase, 63));
    const result = h.read();
    assert.deepEqual(result, { inspection: h.inspection, failure: h.failure, proof: h.proof });
    assert.equal(result.ready, undefined);
  }
});

test('unreadable or malformed history after the prior proof cannot hide a mutation', t => {
  const h = harness(t);
  for (const index of [1, 2, 3]) {
    for (const raw of [null, 'not-json', '{"observation":null}']) {
      h.reset(); h.insert(observation('inspect', index === 1 ? 30 : index === 2 ? 61 : 63), index);
      const inserted = h.records[index];
      if (raw === null) inserted.missing = true;
      else inserted.raw = raw;
      assert.equal(h.read(), null, `${index}:${raw}`);
    }
  }
});

test('an unreadable record preceding a later valid READY proof does not invalidate that fresh chain', t => {
  const h = harness(t);
  h.insert(observation('inspect', 0), 0);
  h.records[0].missing = true;
  assert.notEqual(h.read(), null);
});

test('returns the latest complete valid recovery chain after a newer READY baseline', t => {
  const h = harness(t);
  const newerProof = structuredClone(h.proof);
  newerProof.observedAt = at(50);
  newerProof.gates.persistedDraft.evidence.readAt = at(49);
  newerProof.gates.persistedDraft.evidence.savedAt = at(48);
  h.insert(observation('mutate', 30), 1);
  h.insert(newerProof, 2);
  const result = h.read();
  assert.notEqual(result, null);
  assert.deepEqual(result.proof, newerProof);
});

test('selection is read-only for frozen state and evidence inputs', t => {
  const h = harness(t);
  const beforeState = structuredClone(h.state);
  const beforeRecords = structuredClone(h.records);
  deepFreeze(h.state);
  deepFreeze(h.records);
  assert.notEqual(h.read(), null);
  assert.deepEqual(h.state, beforeState);
  assert.deepEqual(h.records, beforeRecords);
});
