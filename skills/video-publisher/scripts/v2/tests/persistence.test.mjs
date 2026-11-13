import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateObservation, requiredGates, classifyVerdict } from '../lib/model.mjs';
import { persistenceEvidence } from './persistence-fixture.mjs';

function observation(platform) {
  const gates = Object.fromEntries(requiredGates(platform).map(key => [key, { ok: true }]));
  gates.safety = { ok: true, evidence: { finalPublishClicked: false, guardArmed: true, blockedAttempts: 0 } };
  gates.persistedDraft = { ok: true, evidence: persistenceEvidence(platform) };
  return { platform, phase: 'verify', fingerprint: 'test-content', verificationRunId: 'test-run', observedAt: new Date().toISOString(), gates };
}
for (const platform of ['douyin', 'wechat_channels', 'bilibili', 'xiaohongshu', 'youtube']) {
  test(`${platform}: current persisted proof and all independently read fields are mandatory`, () => {
    const o = observation(platform);
    assert.equal(evaluateObservation(o).ready, true);
    delete o.gates.persistedDraft;
    const v = evaluateObservation(o);
    assert.equal(v.ready, false);
    assert.equal(v.blocker.code, 'PERSISTENCE_UNVERIFIED');
    assert.equal(classifyVerdict(v), 'blocked');
  });
  test(`${platform}: old run, changed content, missing dates and wrong ID cannot pass`, () => {
    for (const patch of [{ verificationRunId: 'old-run' }, { fingerprint: 'other' }, { savedAt: '' },
      { readAt: '2001-01-01T00:00:00Z' }, { platform: 'other' }, { draftId: 'another-id' }]) {
      const o = observation(platform);
      Object.assign(o.gates.persistedDraft.evidence, patch);
      assert.equal(evaluateObservation(o).ready, false, JSON.stringify(patch));
    }
  });
}
test('same editor DOM without a new document is not persistence', () => {
  const o = observation('bilibili');
  o.gates.persistedDraft.evidence.documentChanged = false;
  assert.equal(evaluateObservation(o).ready, false);
});
test('persisted draft with missing cover still fails', () => {
  const o = observation('xiaohongshu');
  o.gates.cover.ok = false;
  assert.equal(evaluateObservation(o).ready, false);
});
