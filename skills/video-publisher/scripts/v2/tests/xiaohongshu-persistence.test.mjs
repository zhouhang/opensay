import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { browserTagRevisionSourceCode } from './persistence-fixture.mjs';

const source = fs.readFileSync(new URL('../platforms/xiaohongshu-persistence.mjs', import.meta.url), 'utf8');
const adapterSource = fs.readFileSync(new URL('../platforms/xiaohongshu.mjs', import.meta.url), 'utf8');
const coverMatcherSource = adapterSource.slice(adapterSource.indexOf('function xhsCoverReceiptMatches('),
  adapterSource.indexOf('async function readXhsCoverEditorRatio('));
const url = 'https://creator.xiaohongshu.com/publish/publish?target=video';
const live = { title: 'Approved title', description: 'Approved body', descriptionHtml: '<p>Approved body</p>',
  videoFileId: 'uploaded-file-1', transcodeFileId: 'transcoded-file-1', coverFileId: 'uploaded-cover-1', original: true };
const normalizedLive = { ...live, descriptionHtml: '<p>Approved body</p><p><br></p>' };
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');

function harness({ existing = false, unresolved = false, full = false, corruptSaved = false, corruptRestored = false,
  missingCover = false, foreign = false, normalizedAfterReopen = false, foreignRecordUid = false,
  foreignRecordVideo = false, foreignRecordId = false, foreignEditorUid = false, foreignDraftId = false,
  foreignLiveVideo = false, revision = false, sourceId = 'native-uuid', savedRevision = false, coverRevision = false,
  autosyncedCover = false, snapshotDrift = {}, liveOnlyDrift = {}, receiptOverride = {},
  sourceCoverOverride = {}, liveCoverOverride = {}, recordCoverOverride = {}, previewOverride = {},
  topicHtmlBefore = null, topicHtmlAfter = null } = {}) {
  let proof, stage = foreign || normalizedAfterReopen || savedRevision ? 'restored' : 'editor', saves = 0, navigations = 0, inspections = 0;
  const sourceSnapshot = { ...live, ...(autosyncedCover ? { coverFileId: 'spectrum/old-cover' } : {}),
    ...(topicHtmlBefore ? { descriptionHtml: topicHtmlBefore } : {}) };
  const currentSnapshot = { ...(normalizedAfterReopen ? normalizedLive : sourceSnapshot),
    ...(autosyncedCover ? { coverFileId: 'spectrum/new-cover' } : {}),
    ...(topicHtmlAfter ? { descriptionHtml: topicHtmlAfter } : {}), ...snapshotDrift };
  const plan = { id: 'native-uuid', uid: 'owner', videoFileId: live.videoFileId,
    title: live.title, snapshotHash: digest(sourceSnapshot), url, listUrl: url, storageScope: 'browser-local' };
  let journal = existing || unresolved ? { version: 1, platform: 'xiaohongshu', fingerprint: 'approved',
    status: unresolved ? 'intent' : 'confirmed', savedAt: new Date().toISOString(), plan } : null;
  let record = existing || savedRevision ? { id: foreignRecordId ? 'other-draft' : plan.id, uid: foreignRecordUid ? 'other-owner' : plan.uid,
    snapshot: { ...(autosyncedCover || topicHtmlAfter ? currentSnapshot : live), ...(foreignRecordVideo ? { videoFileId: 'other-video' } : {}) }, timeStamp: Date.now() } : null;
  const getNative = async () => ({ available: true, id: foreignDraftId ? 'other-draft' : plan.id,
    uid: foreignEditorUid ? 'other-owner' : plan.uid, isFromDraft: stage === 'restored',
    live: { ...currentSnapshot, ...liveOnlyDrift, ...(foreignLiveVideo ? { videoFileId: 'other-video' } : {}),
      ...(corruptRestored && stage === 'restored' ? { coverFileId: 'wrong-cover' } : {}) },
    liveCover: { fileid: currentSnapshot.coverFileId, width: 1600, height: 1200, ...liveCoverOverride },
    recordCover: { fileid: record?.snapshot.coverFileId, width: 1600, height: 1200, ...recordCoverOverride },
    record, videoCount: full ? 100 : 1, totalCount: full ? 100 : 1 });
  const context = vm.createContext({ createHash, platform: 'xiaohongshu', jobFingerprint: 'approved', verificationRunId: 'run-1',
    URL, pkg: { cover: { nativeRatio: '4:3' } },
    expectedReceipts: { cover: { version: 2, assetPath: '/approved/cover-4x3.png', ratio: '4:3', nativeRatio: '4:3',
      nativeSlot: 'landscape', nativeFileId: 'spectrum/new-cover', assetHash: digest('approved-cover'),
      afterUrl: 'https://ros-preview.xhscdn.com/spectrum/new-cover?sign=current', ...receiptOverride } },
    xhsCoverPath: '/approved/cover-4x3.png', xhsCoverRatio: '4:3', xhsCoverSlot: 'landscape',
    xhsLocalCoverHash: () => digest('approved-cover'),
    xhsCoverObjectKey: value => String(value || '').match(/(?:^|\/)spectrum\/([^?"')\\]+)/)?.[1] || '',
    xhsCoverRatioMatches: cover => cover?.width > 0 && cover?.height > 0 && Math.abs(cover.width / cover.height - 4 / 3) < 0.01,
    readXhsCoverPreview: async () => ({ ok: true, count: 1, direction: 'landscape',
      bg: 'url("https://ros-preview.xhscdn.com/spectrum/new-cover?sign=current")', ...previewOverride }),
    coverRevisionContext: coverRevision ? { previousFingerprint: 'previous', nextFingerprint: 'approved',
      sourceDraftId: sourceId, sourceVideoFileId: live.videoFileId,
      sourceCoverReceipt: { afterUrl: 'https://ros-preview.xhscdn.com/spectrum/old-cover?sign=prior', ...sourceCoverOverride },
      sourcePersistedDraft: { version: 2, platform: 'xiaohongshu', fingerprint: 'previous', method: 'draft-list-reopen',
        documentChanged: true, storageScope: 'browser-local', draftId: plan.id, listEntryId: plan.id,
        reopenedId: plan.id, uid: plan.uid, snapshotHash: plan.snapshotHash, listUrl: url, reopenedUrl: url } } : null,
    tagRevisionContext: revision ? { previousFingerprint: 'previous', nextFingerprint: 'approved', sourceDraftId: sourceId,
      ...(savedRevision ? { sourcePersistedDraft: { version: 2, platform: 'xiaohongshu', fingerprint: 'previous',
        draftId: plan.id, reopenedId: plan.id, uid: plan.uid, snapshotHash: plan.snapshotHash } } : {}) } : null,
    receiptCheckpointPath: '/unused/receipt', xhsTitle: live.title, PERSISTED_DRAFT_KEY: 'proof', PLATFORM_URLS: { xiaohongshu: url },
    readDraftSaveJournal: () => journal,
    beginDraftSave: (_file, identity, p) => { journal = { ...identity, plan: p, attemptId: 'attempt', status: 'intent', startedAt: new Date().toISOString() }; return journal; },
    restartConfirmedDraftSave: (_file, identity, p, reason) => {
      assert.equal(journal.status, 'confirmed');
      journal = { ...identity, plan: p, attemptId: 'attempt', status: 'intent', startedAt: new Date().toISOString(),
        supersededAttempts: [{ reason }] };
      return journal;
    },
    confirmDraftSave: (_file, _identity, id, savedAt) => { assert.equal(id, 'attempt'); journal = { ...journal, status: 'confirmed', savedAt }; return journal; },
    clickDedicatedDraftButton: async labels => { assert.deepEqual(Array.from(labels), ['暂存离开']); saves++;
      record = { id: plan.id, uid: plan.uid, timeStamp: Date.now() + 1,
        snapshot: { ...currentSnapshot, ...liveOnlyDrift, ...(corruptSaved ? { videoFileId: 'wrong-file' } : {}) } }; return { ok: true }; },
    inspectFinalPublishGuard: async () => ({ armed: true, blockedAttempts: 0 }),
    armFinalPublishGuard: async () => {}, wait: async () => {},
    gotoAndWait: async dest => { assert.equal(dest, url); navigations++; stage = 'landing'; },
    inspect: async () => { inspections++; return { gates: { video: { ok: true }, title: { ok: true }, cover: { ok: !(missingCover && stage === 'restored') } } }; },
    js: async expression => {
      if (expression === 'location.href') return url;
      if (expression.includes('window["proof"] || null')) return proof;
      if (expression.startsWith('window["proof"] = ')) { proof = JSON.parse(expression.slice('window["proof"] = '.length)); return; }
      if (expression.includes('window.__publisherDocumentToken !==')) return stage === 'landing';
      if (expression.startsWith('window.__publisherDocumentToken =')) return;
      if (expression.includes('.draft-title-box')) return true;
      if (expression.includes('.draft-item[data-draft-type')) { stage = 'restored'; return true; }
      throw new Error('Unexpected browser call');
    },
    getNative,
    typedBlocker: (code, message, options) => ({ code, message, ...options }),
    okGate: evidence => ({ ok: true, evidence }), failedGate: evidence => ({ ok: false, evidence }),
  });
  vm.runInContext(browserTagRevisionSourceCode + coverMatcherSource + source + '\nreadXhsNativeDraft = getNative;', context);
  return { run: () => vm.runInContext('persistXhsDraft(inspect)', context),
    read: () => vm.runInContext('readXhsPersistenceProof()', context),
    identity: () => vm.runInContext('readXhsRestoredIdentity()', context),
    journal: () => journal,
    counters: () => ({ saves, navigations, inspections }),
    changeRecord: () => { record.snapshot.coverFileId = 'other-cover'; } };
}

test('XHS saves by native UUID, reads local storage, and reopens the matching list entry', async () => {
  const h = harness(), result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.persistedDraft.evidence.storageScope, 'browser-local');
  assert.equal(result.gates.persistedDraft.evidence.draftId, 'native-uuid');
  assert.deepEqual(h.counters(), { saves: 1, navigations: 1, inspections: 2 });
  assert.equal((await h.identity()).ok, true);
});

test('XHS cover-only replacement retains the original local UUID and video', async () => {
  const h = harness({ coverRevision: true, savedRevision: true });
  assert.equal((await h.identity()).ok, true);
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.persistedDraft.evidence.draftId, 'native-uuid');
  assert.equal(h.journal().plan.coverRevision.sourceDraftId, 'native-uuid');
  assert.equal(h.journal().plan.tagRevision, undefined);
  assert.equal(h.counters().saves, 1);
});

test('XHS cover-only replacement rejects substituted source account, UUID or video before saving', async () => {
  for (const options of [{ foreignEditorUid: true }, { foreignRecordUid: true }, { foreignDraftId: true },
    { foreignRecordId: true }, { foreignLiveVideo: true }, { foreignRecordVideo: true }]) {
    const h = harness({ coverRevision: true, savedRevision: true, ...options });
    assert.equal((await h.identity()).ok, false);
    assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
    assert.equal(h.counters().saves, 0);
  }
});

test('XHS cover-only confirmed restart reopens without saving twice', async () => {
  const h = harness({ coverRevision: true, savedRevision: true, existing: true });
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 0);
});

test('XHS autosynced native cover only restores source identity until dedicated save and list reopen', async () => {
  const h = harness({ coverRevision: true, savedRevision: true, autosyncedCover: true });
  assert.equal((await h.identity()).ok, true);
  assert.equal(h.journal(), null);
  assert.equal((await h.read()).ok, false);
  assert.equal(h.counters().saves, 0);
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 1);
  assert.equal(h.journal().plan.snapshotHash, digest({ ...live, coverFileId: 'spectrum/new-cover' }));
  assert.equal(h.journal().plan.coverRevision.sourceDraftId, 'native-uuid');
});

test('XHS autosynced cover rejects each non-cover snapshot drift in both record and live before saving', async () => {
  for (const field of ['title', 'description', 'descriptionHtml', 'videoFileId', 'transcodeFileId', 'original']) {
    for (const driftTarget of ['snapshotDrift', 'liveOnlyDrift']) {
      const h = harness({ coverRevision: true, savedRevision: true, autosyncedCover: true,
        [driftTarget]: { [field]: field === 'original' ? false : 'unapproved-change' } });
      assert.equal((await h.identity()).ok, false, `${field}/${driftTarget}`);
      assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
      assert.equal(h.counters().saves, 0);
    }
  }
});

test('XHS autosynced cover requires the accepted exact file, native ratio, source cover and both native objects', async () => {
  for (const options of [
    { receiptOverride: { version: 1 } }, { receiptOverride: { assetPath: '/other/file.png' } },
    { receiptOverride: { assetHash: '0'.repeat(64) } }, { receiptOverride: { ratio: '3:4' } },
    { receiptOverride: { nativeRatio: '3:4' } }, { receiptOverride: { nativeSlot: 'portrait' } },
    { receiptOverride: { nativeFileId: 'spectrum/other-cover' } },
    { sourceCoverOverride: { afterUrl: '', nativeFileId: '' } },
    { sourceCoverOverride: { nativeFileId: 'spectrum/unrelated-cover' } },
    { liveCoverOverride: { fileid: 'spectrum/other-cover' } }, { liveCoverOverride: { width: 1200, height: 1600 } },
    { recordCoverOverride: { fileid: 'spectrum/other-cover' } }, { recordCoverOverride: { width: 1200, height: 1600 } },
    { previewOverride: { bg: 'url("https://ros-preview.xhscdn.com/spectrum/other-cover")' } },
    { previewOverride: { direction: 'portrait' } },
  ]) {
    const h = harness({ coverRevision: true, savedRevision: true, autosyncedCover: true, ...options });
    assert.equal((await h.identity()).ok, false, JSON.stringify(options));
    assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
    assert.equal(h.counters().saves, 0);
  }
});

test('XHS tag revisions cannot use the cover-only source snapshot substitution', async () => {
  const h = harness({ revision: true, coverRevision: false, savedRevision: true, autosyncedCover: true });
  assert.equal((await h.identity()).ok, false);
  assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.equal(h.counters().saves, 0);
});

test('XHS confirmed recovery reopens without another save', async () => {
  const h = harness({ existing: true });
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 0);
  assert.equal(h.counters().navigations, 1);
});

test('XHS confirmed snapshot drift never authorizes another save or reopen', async () => {
  for (const missingCover of [false, true]) {
    const h = harness({ existing: true, normalizedAfterReopen: true, missingCover });
    const result = await h.run();
    assert.equal(result.blocker.code, 'PERSISTENCE_UNVERIFIED');
    assert.deepEqual(h.counters(), { saves: 0, navigations: 0, inspections: 0 });
    assert.equal(h.journal().plan.snapshotHash, digest(live));
    assert.equal(result.blocker.evidence.liveSnapshotHash, digest(normalizedLive));
  }
});

test('XHS canonical recovery rejects any foreign stable identity before inspection', async () => {
  for (const options of [
    { foreignDraftId: true }, { foreignEditorUid: true }, { foreignLiveVideo: true },
    { foreignRecordId: true }, { foreignRecordUid: true }, { foreignRecordVideo: true },
  ]) {
    const h = harness({ existing: true, normalizedAfterReopen: true, ...options });
    const result = await h.run();
    assert.equal(result.blocker.code, 'PERSISTENCE_UNVERIFIED');
    assert.deepEqual(h.counters(), { saves: 0, navigations: 0, inspections: 0 });
    assert.equal(result.blocker.evidence.planSnapshotHash, digest(live));
  }
});

test('XHS restored draft without this job binding is not an empty upload page', async () => {
  const h = harness({ foreign: true });
  const identity = await h.identity();
  assert.equal(identity.ok, false);
  assert.equal(identity.existingDraft, true);
  assert.equal(h.counters().saves, 0);
});

test('XHS refuses uncertain save and native capacity eviction', async () => {
  const pending = harness({ unresolved: true });
  assert.equal((await pending.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.deepEqual(pending.counters(), { saves: 0, navigations: 0, inspections: 0 });
  const full = harness({ full: true });
  assert.match((await full.run()).blocker.message, /自动删除旧稿/);
  assert.equal(full.counters().saves, 0);
});

test('XHS mismatched stored bytes prevent leaving the current editor', async () => {
  const h = harness({ corruptSaved: true });
  assert.equal((await h.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.equal(h.counters().saves, 1);
  assert.equal(h.counters().navigations, 0);
  await h.run();
  assert.equal(h.counters().saves, 1);
});

test('XHS restored state mismatch cannot generate persistence proof', async () => {
  const h = harness({ corruptRestored: true });
  const result = await h.run();
  assert.equal(result.blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.equal(result.blocker.evidence.planSnapshotHash, digest(live));
  assert.equal(result.blocker.evidence.recordSnapshotHash, digest(live));
  assert.notEqual(result.blocker.evidence.liveSnapshotHash, digest(live));
  assert.deepEqual(JSON.parse(JSON.stringify(result.blocker.evidence.recordLiveDiff)), ['coverFileId']);
  assert.equal((await h.read()).ok, false);
});

test('XHS cover gate remains independent and later native changes invalidate proof', async () => {
  const h = harness({ missingCover: true });
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  assert.equal(result.gates.cover.ok, false);
  h.changeRecord();
  assert.equal((await h.read()).ok, false);
});

test('XHS unsaved tag revision binds the source UUID and refuses another uploaded editor', async () => {
  const h = harness({ revision: true });
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 1);
  const foreign = harness({ revision: true, sourceId: 'another-uuid' });
  assert.equal((await foreign.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
  assert.equal(foreign.counters().saves, 0);
});

test('XHS saved tag revision reuses the source UUID, account, and stored uploaded-file identity', async () => {
  const h = harness({ revision: true, savedRevision: true });
  assert.equal((await h.identity()).ok, true);
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal((await h.run()).gates.persistedDraft.ok, true);
  assert.equal(h.counters().saves, 1);
  for (const options of [{ foreignRecordUid: true }, { foreignRecordVideo: true }, { foreignLiveVideo: true }]) {
    const foreign = harness({ revision: true, savedRevision: true, ...options });
    assert.equal((await foreign.identity()).ok, false);
    assert.equal((await foreign.run()).blocker.code, 'PERSISTENCE_UNVERIFIED');
    assert.equal(foreign.counters().saves, 0);
  }
});

const topicAttribute = value => JSON.stringify(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const topicAnchor = value => `<a class="tiptap-topic" data-topic="${topicAttribute(value)}">#${value.name}<span class="content-hide">[话题]#</span></a>`;
const topicsBefore = ['AI', 'AI工具'].map((name, i) => ({ id: `topic-${i}`, link: i ? `xhsdiscover://topic/v2/topic-${i}` : '', name }));
const topicsAfter = topicsBefore.map(({ id, link, name }) => ({ id, name, link, type: 'topic' }));
const topicHtmlBefore = '<p>Approved body</p><p></p><p>' + topicsBefore.map(t => topicAnchor(t) + '&nbsp; ').join('') + '</p>';
const topicHtmlAfter = '<p>Approved body</p><p></p><p>' + topicsAfter.map(topicAnchor).join('&nbsp;&nbsp;') + '</p>';
const roundtripHarness = options => harness({ existing: true, topicHtmlBefore, topicHtmlAfter, ...options });

function snapshotMatcher() {
  const context = vm.createContext({ createHash });
  vm.runInContext(source, context);
  return (snapshot, hash) => {
    context.snapshot = snapshot;
    context.expectedHash = hash;
    return vm.runInContext('xhsSnapshotMatchesHash(snapshot, expectedHash)', context);
  };
}

test('XHS recognizes only the observed native topic HTML roundtrip against the entire original hash', () => {
  const matches = snapshotMatcher();
  const before = { ...live, descriptionHtml: topicHtmlBefore };
  const after = { ...live, descriptionHtml: topicHtmlAfter };
  assert.notEqual(digest(before), digest(after));
  assert.equal(matches(after, digest(before)), true);
  assert.equal(matches(before, digest(before)), true);
  for (const field of ['title', 'description', 'videoFileId', 'transcodeFileId', 'coverFileId', 'original']) {
    const changed = { ...after, [field]: field === 'original' ? false : 'different-value' };
    assert.equal(matches(changed, digest(before)), false, field);
  }
});

test('XHS topic roundtrip refuses changed entity identities, content, links, types, wrappers and unrelated HTML drift', () => {
  const matches = snapshotMatcher(), expected = digest({ ...live, descriptionHtml: topicHtmlBefore });
  const variants = [
    topicHtmlAfter.replace('topic-0', 'different-id'),
    topicHtmlAfter.replace('xhsdiscover://topic/v2/topic-1', 'xhsdiscover://topic/v2/different'),
    topicHtmlAfter.replaceAll('AI工具', 'other-topic'),
    topicHtmlAfter.replace('topic&quot;', 'hashtag&quot;'),
    topicHtmlAfter.replace('&quot;type&quot;', '&quot;extra&quot;'),
    topicHtmlAfter.replace('<p>Approved body</p>', '<p>Changed body</p>'),
    topicHtmlAfter.replace('<a class="tiptap-topic"', '<a target="_blank" class="tiptap-topic"'),
    topicHtmlAfter.replace('&nbsp;&nbsp;', '<br>'),
    topicHtmlAfter.replace('</p>', '</p><p><br></p>'),
    topicHtmlAfter.replace('#AI<span', '#wrong-label<span'),
    topicHtmlAfter.replaceAll(',&quot;type&quot;:&quot;topic&quot;', ''),
  ];
  for (const html of variants) assert.equal(matches({ ...live, descriptionHtml: html }, expected), false, html);
});

test('XHS confirmed native topic serialization reopens the same resource without another save and binds current native bytes', async () => {
  const h = roundtripHarness(), originalHash = h.journal().plan.snapshotHash;
  const result = await h.run();
  assert.equal(result.gates.persistedDraft.ok, true);
  const proof = result.gates.persistedDraft.evidence;
  assert.equal(proof.draftId, 'native-uuid');
  assert.equal(proof.savedSnapshotHash, digest({ ...live, descriptionHtml: topicHtmlBefore }));
  assert.equal(proof.snapshotHash, digest({ ...live, descriptionHtml: topicHtmlAfter }));
  assert.equal(proof.nativeSerializationRoundtrip.checkedFullSnapshot, true);
  assert.equal(h.journal().plan.snapshotHash, originalHash, 'historical journal is immutable');
  assert.equal(h.counters().saves, 0);
  assert.equal(h.counters().navigations, 1);
  assert.equal((await h.read()).ok, true);
  h.changeRecord();
  assert.equal((await h.read()).ok, false, 'later native cover change still invalidates proof');
});

test('XHS topic serialization equivalence cannot excuse foreign account, UUID, media, or one-sided drift', async () => {
  for (const options of [{ foreignEditorUid: true }, { foreignRecordUid: true }, { foreignDraftId: true },
    { foreignRecordId: true }, { foreignLiveVideo: true }, { foreignRecordVideo: true },
    { liveOnlyDrift: { title: 'different-title' } }, { liveOnlyDrift: { coverFileId: 'other-cover' } }]) {
    const h = roundtripHarness(options), result = await h.run();
    assert.equal(result.blocker.code, 'PERSISTENCE_UNVERIFIED', JSON.stringify(options));
    assert.equal(h.counters().saves, 0);
    assert.equal((await h.read()).ok, false);
  }
});
