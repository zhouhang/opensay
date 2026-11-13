import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readVideoReplacementAuthorization, explicitVideoReplacementAuthorization,
  beginVideoReplacementSpaceRecovery, confirmVideoReplacementSpaceRecovery,
  readVideoReplacementSpaceBinding } from '../lib/video-replacement-authorization.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-authorization-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'human-authorization.json');
  const expected = { jobId: 'original-job', sourceFingerprint: 'old-fingerprint', sourceTaskSpaceId: 71,
    sourceTaskSpaceName: 'exact original task name', uid: 'actual-user', sourceDraftId: 'actual-draft-uuid',
    sourceVideoFileId: 'actual-native-source-file', nextVideoSha256: 'b'.repeat(64) };
  const value = { version: 1, kind: 'user_attested_original_draft_replacement', platform: 'xiaohongshu',
    statement: '尚未发布，只更新原草稿', attestedAt: new Date().toISOString(), ...expected,
    allowMissingOriginalTaskSpaceRecovery: true,
    authorizationSource: { type: 'direct-human-message', answer: '尚未发布，只更新原草稿', questionItemId: 'trusted-human-reply' } };
  fs.writeFileSync(file, JSON.stringify(value));
  const authorization = readVideoReplacementAuthorization(file, expected);
  const revision = { ...expected, sourceUid: expected.uid, sourceVideoIdentity: { sha256: 'a'.repeat(64) },
    nextVideoIdentity: { sha256: expected.nextVideoSha256 }, userAuthorization: authorization,
    spaceBindingPath: path.join(root, 'space-binding.json') };
  return { root, file, expected, value, authorization, revision };
}

test('human non-publication statement authorizes only the exact explicit source replacement, never automatic old-draft recovery', t => {
  const f = fixture(t);
  assert.equal(explicitVideoReplacementAuthorization(f.revision, 'replace-video'), true);
  for (const op of ['auto', 'resume', 'inspect', 'park', 'replace-cover']) assert.equal(explicitVideoReplacementAuthorization(f.revision, op), false);
  for (const key of Object.keys(f.expected)) assert.throws(() => readVideoReplacementAuthorization(f.file,
    { ...f.expected, [key]: typeof f.expected[key] === 'number' ? 999 : 'foreign' }), /does not bind/);
  fs.writeFileSync(f.file, JSON.stringify({ ...f.value, uid: 'another-user' }));
  assert.equal(explicitVideoReplacementAuthorization(f.revision, 'replace-video'), false, 'later manifest edits cannot change a bound scope');
});

test('native status flags or a generic confirmation cannot masquerade as trusted human authorization', t => {
  const f = fixture(t);
  for (const patch of [ { kind: 'native_unpublished' }, { statement: '继续' }, { authorizationSource: { type: 'agent-inference', answer: '尚未发布，只更新原草稿' } },
    { attestedAt: new Date(Date.now() - 25 * 3600000).toISOString() } ]) {
    fs.writeFileSync(f.file, JSON.stringify({ ...f.value, ...patch }));
    assert.throws(() => readVideoReplacementAuthorization(f.file, f.expected), /recent|explicit|human/);
  }
});

test('closed task recovery journal refuses live spaces and adopting any preexisting task, and preserves the immutable original identity', t => {
  const f = fixture(t), file = f.revision.spaceBindingPath;
  assert.throws(() => beginVideoReplacementSpaceRecovery(file, f.revision, [7, 71, 76]), /live original/);
  const intent = beginVideoReplacementSpaceRecovery(file, f.revision, [7, 76]);
  assert.equal(intent.previousTaskSpaceId, 71); assert.equal(intent.status, 'intent');
  assert.throws(() => beginVideoReplacementSpaceRecovery(file, f.revision, [7, 76]), /already exists/);
  assert.throws(() => confirmVideoReplacementSpaceRecovery(file, f.revision, intent.attemptId, 76, f.expected.sourceTaskSpaceName), /existing or different/);
  assert.throws(() => confirmVideoReplacementSpaceRecovery(file, f.revision, intent.attemptId, 80, 'other-owner-task'), /existing or different/);
  const saved = confirmVideoReplacementSpaceRecovery(file, f.revision, intent.attemptId, 80, f.expected.sourceTaskSpaceName);
  assert.equal(saved.previousTaskSpaceId, 71); assert.equal(saved.taskSpaceId, 80);
  assert.deepEqual(readVideoReplacementSpaceBinding(file, f.revision), saved);
});

test('browser recovery creates only the exact missing task name and cannot take over a same-named existing task', async t => {
  const f = fixture(t);
  const core = fs.readFileSync(new URL('../ego/core.mjs', import.meta.url), 'utf8');
  const selected = core.slice(core.indexOf('function explicitVideoTaskRecoveryAllowed()'), core.indexOf('async function selectPlatformTab()'));
  async function run(spaces, create) {
    const context = vm.createContext({ platform: 'xiaohongshu', phase: 'replace_video', taskName: f.expected.sourceTaskSpaceName,
      taskSpaceRef: '71', videoRevisionContext: structuredClone(f.revision), noUpload: true,
      activeTaskSpace: null, taskSpaceRecovery: null, listTaskSpaces: async () => spaces,
      useOrCreateTaskSpace: async ref => { if (ref === 71) throw new Error('task space not found'); return create(ref); },
      beginVideoReplacementSpaceRecovery, confirmVideoReplacementSpaceRecovery, readVideoReplacementSpaceBinding });
    vm.runInContext(selected, context);
    return vm.runInContext('selectTaskSpace()', context);
  }
  let calls = 0;
  await assert.rejects(run([{ id: 76, name: f.expected.sourceTaskSpaceName }], async () => { calls++; }), /already belongs/);
  assert.equal(calls, 0);
  const recovered = await run([{ id: 76, name: 'other task' }], async name => {
    assert.equal(name, f.expected.sourceTaskSpaceName); calls++; return { id: 80, name };
  });
  assert.equal(recovered.id, 80); assert.equal(calls, 1);
  assert.equal(readVideoReplacementSpaceBinding(f.revision.spaceBindingPath, f.revision).previousTaskSpaceId, 71);
});
