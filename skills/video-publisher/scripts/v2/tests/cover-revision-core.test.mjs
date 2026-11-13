import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../ego/persisted-draft.mjs', import.meta.url), 'utf8');
const readSource = source.slice(source.indexOf('function readBrowserCoverRevisionSource()'),
  source.indexOf('function readBrowserTagRevisionSource()'));
const proof = { version: 2, platform: 'xiaohongshu', fingerprint: 'old', method: 'draft-list-reopen',
  documentChanged: true, storageScope: 'browser-local', uid: 'owner', snapshotHash: 'saved-original-hash',
  draftId: 'uuid', reopenedId: 'uuid', listEntryId: 'uuid',
  listUrl: 'https://creator.xiaohongshu.com/publish/publish?target=video',
  reopenedUrl: 'https://creator.xiaohongshu.com/publish/publish?target=video' };
const revision = { previousFingerprint: 'old', nextFingerprint: 'new', sourceDraftId: 'uuid',
  sourceVideoFileId: 'original-upload', sourcePersistedDraft: proof };
function read(value = revision, overrides = {}) {
  const context = vm.createContext({ URL, platform: 'xiaohongshu', jobFingerprint: 'new',
    coverRevisionContext: value, ...overrides });
  vm.runInContext(readSource, context);
  return vm.runInContext('readBrowserCoverRevisionSource()', context);
}
test('cover source proof binds existing UUID and video without becoming a new READY proof', () => {
  const result = read();
  assert.equal(result.sourceDraftId, 'uuid');
  assert.equal(result.sourceVideoFileId, 'original-upload');
  assert.equal(result.sourcePersistedDraft.fingerprint, 'old');
  assert.equal(result.ready, undefined);
});
test('legacy jobs without cover revisions remain unchanged', () => assert.equal(read(null), null));
test('a failed source gate cannot be unwrapped into cover revision authority', () => {
  assert.throws(() => read({ ...revision, sourcePersistedDraft: { ok: false, evidence: proof } }), /requires the original/);
  assert.equal(read({ ...revision, sourcePersistedDraft: { ok: true, evidence: proof } }).sourceDraftId, 'uuid');
});
test('cover revision rejects missing video, mismatched fingerprint and another platform', () => {
  for (const value of [ { ...revision, sourceVideoFileId: '' },
    { ...revision, nextFingerprint: 'wrong' }, { ...revision, previousFingerprint: 'new' },
    { ...revision, sourceDraftId: 'other' } ]) assert.throws(() => read(value), /requires the original/);
  assert.throws(() => read(revision, { platform: 'youtube' }), /requires the original/);
});
test('cover revision rejects incomplete or substituted native source evidence', () => {
  for (const patch of [ { uid: '' }, { snapshotHash: '' }, { version: 1 }, { documentChanged: false },
    { storageScope: 'cloud' }, { method: 'clicked-save' }, { fingerprint: 'wrong' },
    { reopenedId: 'other' }, { listEntryId: 'other' } ]) {
    assert.throws(() => read({ ...revision, sourcePersistedDraft: { ...proof, ...patch } }), /requires the original/);
  }
});
test('cover revision rejects foreign routes and URL credentials', () => {
  for (const route of ['https://example.com/drafts', 'https://user:pass@creator.xiaohongshu.com/drafts']) {
    assert.throws(() => read({ ...revision, sourcePersistedDraft: { ...proof, listUrl: route } }), /untrusted draft route/);
  }
});

for (const [platform, origin] of [['bilibili', 'https://member.bilibili.com'],
  ['wechat_channels', 'https://channels.weixin.qq.com']]) {
  test(`${platform} cover revision binds the original native ID and its own source fingerprint`, () => {
    const nativeProof = { version: 2, platform, fingerprint: 'platform-source', method: 'draft-list-reopen',
      documentChanged: true, draftId: 'native-id', reopenedId: 'native-id', listEntryId: 'native-id',
      listUrl: `${origin}/draft-list`, reopenedUrl: `${origin}/draft-editor` };
    const value = { previousFingerprint: 'whole-job-source', sourceFingerprint: 'platform-source', nextFingerprint: 'new',
      sourceDraftId: 'native-id', sourcePersistedDraft: nativeProof };
    assert.equal(read(value, { platform }).sourceFingerprint, 'platform-source');
    for (const patch of [{ fingerprint: 'foreign' }, { platform: 'xiaohongshu' }, { documentChanged: false },
      { listEntryId: 'copy' }, { reopenedId: 'copy' }, { method: 'clicked-save' }]) {
      assert.throws(() => read({ ...value, sourcePersistedDraft: { ...nativeProof, ...patch } }, { platform }), /requires the original/);
    }
    for (const route of ['https://example.com/drafts', origin.replace('https://', 'https://user:pass@') + '/drafts']) {
      assert.throws(() => read({ ...value, sourcePersistedDraft: { ...nativeProof, listUrl: route } }, { platform }), /untrusted draft route/);
    }
    assert.throws(() => read({ ...value, sourceFingerprint: 'new' }, { platform }), /requires the original/);
  });
}
