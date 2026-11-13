const xhsSnapshotHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Mojito's native TipTap restore adds type:"topic", orders the entity fields,
// and serializes the separators as two nbsp characters. Keep historical hashes
// byte-for-byte; accept only the exact inverse of that observed roundtrip whose
// complete snapshot still reproduces the saved hash. Body markup, topic IDs,
// names/links, media and every other snapshot field remain covered by that hash.
function xhsTopicRoundtripInputHtml(html) {
  if (typeof html !== 'string') return null;
  const paragraph = /^(.*)<p>(<a class="tiptap-topic" data-topic="[\s\S]*)<\/p>$/.exec(html);
  if (!paragraph) return null;
  const source = paragraph[2], entries = [];
  const entity = /<a class="tiptap-topic" data-topic="([^"]*)">#([^<]*)<span class="content-hide">\[话题\]#<\/span><\/a>/gy;
  const unescape = value => value.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const escapeText = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapeAttribute = value => escapeText(value).replace(/"/g, '&quot;');
  let offset = 0;
  while (offset < source.length) {
    entity.lastIndex = offset;
    const match = entity.exec(source);
    if (!match) return null;
    let topic;
    try { topic = JSON.parse(unescape(match[1])); } catch { return null; }
    if (!topic || typeof topic !== 'object' || Array.isArray(topic)
      || Object.keys(topic).sort().join(',') !== 'id,link,name,type'
      || topic.type !== 'topic' || !['id', 'link', 'name'].every(key => typeof topic[key] === 'string')
      || !topic.id || !topic.name || match[2] !== escapeText(topic.name)) return null;
    const data = escapeAttribute(JSON.stringify({ id: topic.id, link: topic.link, name: topic.name }));
    entries.push(`<a class="tiptap-topic" data-topic="${data}">#${match[2]}<span class="content-hide">[话题]#</span></a>&nbsp; `);
    offset = entity.lastIndex;
    if (offset === source.length) break;
    // This is the native serializer's observed between-entity representation,
    // not arbitrary whitespace or a text-content-only HTML comparison.
    if (source.slice(offset, offset + 12) !== '&nbsp;&nbsp;') return null;
    offset += 12;
  }
  return entries.length ? `${paragraph[1]}<p>${entries.join('')}</p>` : null;
}

function xhsSnapshotMatchesHash(snapshot, expectedHash) {
  if (!snapshot || !expectedHash) return false;
  if (xhsSnapshotHash(snapshot) === expectedHash) return true;
  const inputHtml = xhsTopicRoundtripInputHtml(snapshot.descriptionHtml);
  return inputHtml !== null && xhsSnapshotHash({ ...snapshot, descriptionHtml: inputHtml }) === expectedHash;
}
const xhsSnapshotDiff = (left, right) => [...new Set([
  ...Object.keys(left || {}), ...Object.keys(right || {}),
])].filter(key => JSON.stringify(left?.[key]) !== JSON.stringify(right?.[key])).sort();
const xhsSnapshotEvidence = (state, plan) => ({
  planSnapshotHash: plan?.snapshotHash || null,
  recordSnapshotHash: state?.record?.snapshot ? xhsSnapshotHash(state.record.snapshot) : null,
  liveSnapshotHash: state?.live ? xhsSnapshotHash(state.live) : null,
  recordLiveDiff: xhsSnapshotDiff(state?.record?.snapshot, state?.live),
});
const xhsJournalFile = () => browserDraftSaveJournalFile();
const xhsJournalIdentity = () => ({ platform, fingerprint: jobFingerprint });

async function readXhsNativeDraft(requestedId = null) {
  return await js(`(async requestedId => {
    const apps = [...document.querySelectorAll('*')].map(el => el.__vue_app__ || el.__vueParentComponent?.appContext?.app).filter(Boolean);
    const pinia = apps.find(app => app.config?.globalProperties?.$pinia)?.config.globalProperties.$pinia;
    const publisher = pinia?._s.get('publisher'), draft = pinia?._s.get('draft'), settings = pinia?._s.get('settings'), context = pinia?._s.get('context');
    const uid = pinia?._s.get('user')?.userInfo?.id;
    if (!publisher?.draftId || !uid || !draft || !settings) return { available: false,
      publication: { noteId: publisher?.noteId || null, hasBeenPublished: publisher?.hasBeenPublished === true,
        hasBeenPublishSuccess: publisher?.hasBeenPublishSuccess === true } };
    const snapshot = (d, s, c) => ({ title: d.title || '', description: d.desc || '', descriptionHtml: d.descInnerHTML || '',
      videoFileId: d.video?.fileid || '', transcodeFileId: d.video?.transcodeVideoFileId || '',
      // The current Mojito cover editor persists its accepted cover in contextStore.
      // Older editors used draftStore.cover, so retain that as a compatibility fallback.
      coverFileId: c?.coverContext?.cover?.fileid || d.cover?.fileid || '', original: s.original });
    // Keep the historical snapshot hash shape unchanged. Ratio acceptance is an
    // independent business gate, read from the real exported native cover.
    const coverInfo = (d, c) => {
      const cover = c?.coverContext?.cover?.fileid ? c.coverContext.cover : d?.cover;
      return { fileid: cover?.fileid || '', width: Number(cover?.width || 0), height: Number(cover?.height || 0) };
    };
    const result = { available: true, id: publisher.draftId, uid, isFromDraft: publisher.isFromDraft === true,
      publication: { noteId: publisher.noteId || null, hasBeenPublished: publisher.hasBeenPublished === true,
        hasBeenPublishSuccess: publisher.hasBeenPublishSuccess === true },
      live: snapshot(draft, settings, context), liveCover: coverInfo(draft, context), recordCover: null,
      record: null, videoCount: 0, totalCount: 0 };
    if (!(await indexedDB.databases()).some(db => db.name === 'draft-database-v1')) return result;
    const db = await new Promise((resolve, reject) => {
      const q = indexedDB.open('draft-database-v1');
      q.onupgradeneeded = () => { q.transaction.abort(); reject(new Error('Draft database changed')); };
      q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error);
    });
    try {
      const names = [...db.objectStoreNames];
      if (!names.includes('video-draft')) return result;
      const tx = db.transaction(names, 'readonly');
      const request = q => new Promise((resolve, reject) => { q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
      const reads = names.map(name => request(tx.objectStore(name).count()));
      const stored = request(tx.objectStore('video-draft').get(requestedId || publisher.draftId));
      const [counts, record] = await Promise.all([Promise.all(reads), stored]);
      result.videoCount = counts[names.indexOf('video-draft')];
      result.totalCount = counts.reduce((a, b) => a + b, 0);
      if (record) result.record = { id: record.draftId, uid: record.uid, timeStamp: record.timeStamp,
        snapshot: snapshot(record.content?.draftStore || {}, record.content?.settingStore || {}, record.content?.contextStore || {}) };
      if (record) result.recordCover = coverInfo(record.content?.draftStore || {}, record.content?.contextStore || {});
      return result;
    } finally { db.close(); }
  })(${JSON.stringify(requestedId)})`);
}

function xhsRecordMatches(state, plan) {
  return Boolean(state.available && state.uid === plan.uid && state.record?.uid === plan.uid
    && state.record.id === plan.id && xhsSnapshotMatchesHash(state.record.snapshot, plan.snapshotHash));
}

async function xhsCoverRevisionMatchesSourceSnapshot(state, revision) {
  const receipt = expectedReceipts?.cover;
  if (!revision?.sourcePersistedDraft || receipt?.version !== 2) return false;
  const originalKey = xhsCoverObjectKey(revision.sourceCoverReceipt?.afterUrl);
  const originalFileId = revision.sourceCoverReceipt?.nativeFileId || (originalKey ? `spectrum/${originalKey}` : '');
  if (!originalFileId || !state.live || !state.record?.snapshot) return false;
  // The native cover editor can update the browser-local draft record before
  // 暂存离开 without advancing its save timestamp. Permit only that exact
  // coverFileId substitution: every other byte of both historical snapshots
  // must still reproduce the original saved proof.
  const sourceHash = revision.sourcePersistedDraft.snapshotHash;
  if (xhsSnapshotHash({ ...state.live, coverFileId: originalFileId }) !== sourceHash
    || xhsSnapshotHash({ ...state.record.snapshot, coverFileId: originalFileId }) !== sourceHash) return false;
  const preview = await readXhsCoverPreview();
  return xhsCoverReceiptMatches(receipt, preview, state,
    { ok: true, evidence: { draftId: revision.sourceDraftId } });
}

async function readXhsRestoredIdentity() {
  const tagRevision = readBrowserTagRevisionSource(), coverRevision = readBrowserCoverRevisionSource();
  const videoRevision = typeof readBrowserVideoRevisionSource === 'function' ? readBrowserVideoRevisionSource() : null;
  const revision = videoRevision || tagRevision || coverRevision;
  const journal = readDraftSaveJournal(xhsJournalFile(), xhsJournalIdentity());
  const autosaveSource = !journal && !revision && typeof readXhsAutosaveRecoverySource === 'function'
    ? readXhsAutosaveRecoverySource() : null;
  const state = await readXhsNativeDraft(journal?.plan?.id || revision?.sourceDraftId || autosaveSource?.draftId || null);
  if (videoRevision) {
    const proof=videoRevision.sourcePersistedDraft;
    const replacement=readVideoReplacementJournal(videoReplacementJournalPath,{platform,fingerprint:jobFingerprint});
    const sameOriginal=state.available&&state.isFromDraft&&state.id===videoRevision.sourceDraftId&&state.uid===proof.uid
      &&state.record?.id===videoRevision.sourceDraftId&&state.record.uid===proof.uid;
    let mediaMatches=false;
    if(journal?.status==='confirmed')mediaMatches=state.live?.videoFileId===journal.plan.videoFileId&&journal.plan.id===videoRevision.sourceDraftId;
    else if(replacement?.status==='confirmed')mediaMatches=replacement.evidence.nativeFileIds.includes(String(state.live?.videoFileId||''));
    else if(replacement?.status==='intent')mediaMatches=Boolean(state.live?.videoFileId);
    else mediaMatches=state.live?.videoFileId===videoRevision.sourceVideoFileId&&state.record?.snapshot?.videoFileId===videoRevision.sourceVideoFileId
      &&xhsSnapshotHash(state.live)===proof.snapshotHash&&xhsSnapshotHash(state.record.snapshot)===proof.snapshotHash;
    return {ok:sameOriginal&&mediaMatches,existingDraft:state.isFromDraft===true,actualId:state.id||null,
      draftId:videoRevision.sourceDraftId,uid:state.uid||null,videoFileId:state.live?.videoFileId||null,videoRevision:true,storageScope:'browser-local'};
  }
  if (!journal && revision?.sourcePersistedDraft) {
    const proof = revision.sourcePersistedDraft;
    const sourceSnapshotMatches = Boolean(state.record?.snapshot) && xhsSnapshotHash(state.record.snapshot) === proof.snapshotHash
      || (!tagRevision && coverRevision && await xhsCoverRevisionMatchesSourceSnapshot(state, coverRevision));
    return { ok: state.available && state.isFromDraft && state.id === revision.sourceDraftId && state.uid === proof.uid
      && state.record?.id === revision.sourceDraftId && state.record.uid === proof.uid
      && sourceSnapshotMatches
      && (!revision.sourceVideoFileId || state.live.videoFileId === revision.sourceVideoFileId)
      && Boolean(state.live?.videoFileId) && state.live.videoFileId === state.record.snapshot.videoFileId,
      existingDraft: state.isFromDraft === true, actualId: state.id || null, draftId: revision.sourceDraftId,
      uid: state.uid || null, videoFileId: state.live?.videoFileId || null,
      ...(coverRevision && !tagRevision ? { coverRevision: true } : { tagRevision: true }) };
  }
  if (autosaveSource) {
    const source = autosaveSource;
    return { ok: state.available && state.isFromDraft && state.id === source.draftId && state.uid === source.uid
      && state.record?.id === source.draftId && state.record.uid === source.uid
      && state.live?.videoFileId === source.videoFileId && state.record.snapshot?.videoFileId === source.videoFileId,
      existingDraft: state.isFromDraft === true, actualId: state.id || null, draftId: source.draftId,
      uid: state.uid || null, videoFileId: state.live?.videoFileId || null,
      autosaveRecovery: true, sourceEvidencePath: source.evidencePath, sourceEvidenceSha256: source.evidenceSha256 };
  }
  if (journal?.status !== 'confirmed' || !journal.plan.videoFileId) return { ok: false, existingDraft: state.isFromDraft === true,
    actualId: state.available ? String(state.id || '') : null, uid: state.uid || null, videoFileId: state.live?.videoFileId || null };
  return { ok: state.available && state.isFromDraft && state.id === journal.plan.id
    && state.uid === journal.plan.uid && state.live.videoFileId === journal.plan.videoFileId
    && (!revision || (state.id === revision.sourceDraftId && state.uid === revision.sourcePersistedDraft.uid
      && (!revision.sourceVideoFileId || state.live.videoFileId === revision.sourceVideoFileId))),
    existingDraft: state.isFromDraft === true, draftId: state.id, videoFileId: state.live?.videoFileId || null, storageScope: 'browser-local' };
}

async function readXhsPersistenceProof() {
  const proof = await js(`window[${JSON.stringify(PERSISTED_DRAFT_KEY)}] || null`);
  if (!proof || proof.verificationRunId !== verificationRunId || proof.fingerprint !== jobFingerprint
    || proof.platform !== platform || proof.storageScope !== 'browser-local') return failedGate({ reason: 'No current local-draft reopen proof' });
  const state = await readXhsNativeDraft(proof.draftId);
  const url = await js('location.href');
  const plan = { id: proof.draftId, uid: proof.uid, snapshotHash: proof.snapshotHash };
  const snapshotEvidence = xhsSnapshotEvidence(state, plan);
  return xhsRecordMatches(state, plan) && state.isFromDraft && state.id === proof.draftId
    && xhsSnapshotHash(state.live) === proof.snapshotHash && url === proof.reopenedUrl
    ? okGate({ ...proof, snapshotEvidence, readAt: new Date().toISOString() })
    : failedGate({ reason: 'Local draft record or reopened editor changed', draftId: proof.draftId, snapshotEvidence });
}

async function persistXhsDraft(inspect) {
  const readOnly = typeof xhsVerifySavedMode === 'function' && xhsVerifySavedMode();
  if (readOnly) await assertXhsReadOnlyGuard();
  const coverRevision = readBrowserCoverRevisionSource();
  const videoRevision = typeof readBrowserVideoRevisionSource === 'function' ? readBrowserVideoRevisionSource() : null;
  const revision = videoRevision || readBrowserTagRevisionSource() || coverRevision;
  const file = xhsJournalFile(), identity = xhsJournalIdentity();
  let journal = readDraftSaveJournal(file, identity);
  if (readOnly && journal?.status !== 'confirmed') return {gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED',
    '只读核验必须使用现有 confirmed 保存日志；禁止新暂存或恢复不确定写入')};
  if (journal?.status === 'intent') return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '小红书上次暂存结果不确定；核对原草稿前禁止再次保存') };
  let attemptStarted = false;
  let saveInspection = null;
  if (journal?.status === 'confirmed') {
    const native = await readXhsNativeDraft(journal.plan.id);
    const snapshotEvidence = xhsSnapshotEvidence(native, journal.plan);
    const snapshotMatchesPlan = xhsRecordMatches(native, journal.plan)
      && xhsSnapshotMatchesHash(native.live, journal.plan.snapshotHash);
    if (!snapshotMatchesPlan) {
      if (!readOnly && typeof xhsReconcileContext !== 'undefined' && xhsReconcileContext) {
        saveInspection = await inspect();
        journal = await reconcileXhsConfirmedJournal(native, saveInspection, journal, file, identity);
        attemptStarted = true;
      } else {
      return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED',
        '已确认草稿的原生内容发生变化；自动恢复禁止再次暂存，须先核对发布状态和原资源',
        { evidence: snapshotEvidence }) };
      }
    }
  }
  if (!journal) {
    saveInspection = await inspect();
    const missing = Object.entries(saveInspection.gates).filter(([key, gate]) => key !== 'persistedDraft' && !gate.ok).map(([key]) => key);
    if (saveInspection.blocker || missing.length) return { ...saveInspection, blocker: saveInspection.blocker || typedBlocker('PERSISTENCE_UNVERIFIED', '小红书暂存前字段校验未通过', { evidence: { missing } }) };
    const native = await readXhsNativeDraft();
    if (!native.available || !native.live.videoFileId || native.live.title !== xhsTitle
      || (revision?.sourceDraftId && native.id !== revision.sourceDraftId)) {
      return { ...saveInspection, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '无法绑定当前账号、草稿 UUID 和上传文件 ID') };
    }
    if (revision?.sourcePersistedDraft && !(await readXhsRestoredIdentity()).ok) {
      return { ...saveInspection, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '小红书当前编辑器、账号或上传文件与原生保存记录不一致') };
    }
    // Native saving evicts the oldest draft at the per-type limit. Never authorize that implicitly.
    if (!native.record && (native.videoCount >= 100 || native.totalCount >= 1000)) {
      return { ...saveInspection, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '本地草稿数量到达上限；原生暂存可能自动删除旧稿，已停止', { requiresUser: true }) };
    }
    const url = await js('location.href');
    const plan = { id: native.id, uid: native.uid, videoFileId: native.live.videoFileId,
      createdVerificationRunId: verificationRunId,
      snapshotHash: xhsSnapshotHash(native.live), title: xhsTitle, url, listUrl: PLATFORM_URLS.xiaohongshu,
      saveLabel: '暂存离开', storageScope: 'browser-local', previousTimestamp: native.record?.timeStamp || 0,
      ...(videoRevision ? { videoRevision: browserVideoRevisionPlan(videoRevision) } : coverRevision ? { coverRevision: browserTagRevisionPlan(coverRevision) }
        : revision ? { tagRevision: browserTagRevisionPlan(revision) } : {}) };
    journal = beginDraftSave(file, identity, plan);
    attemptStarted = true;
  }
  if (attemptStarted) {
    if (readOnly) throw new Error('Saved-draft read-only verification cannot click save');
    const plan = journal.plan;
    const clicked = await clickDedicatedDraftButton(['暂存离开']);
    if (!clicked.ok) return { ...(saveInspection || {}), blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '小红书暂存操作未通过；保留日志', { evidence: clicked }) };
    let stored;
    for (let n = 0; n < 20; n++) {
      await wait(1);
      stored = await readXhsNativeDraft(plan.id);
      if (xhsRecordMatches(stored, plan) && stored.record.timeStamp >= Date.parse(journal.startedAt)
        && stored.record.timeStamp > plan.previousTimestamp) break;
    }
    if (!xhsRecordMatches(stored, plan) || stored.record.timeStamp < Date.parse(journal.startedAt)
      || stored.record.timeStamp <= plan.previousTimestamp) {
      return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '未读到本次暂存后的匹配本地记录；禁止重复暂存',
        { evidence: xhsSnapshotEvidence(stored, plan) }) };
    }
    journal = confirmDraftSave(file, identity, journal.attemptId, new Date(stored.record.timeStamp).toISOString());
  }
  const plan = journal.plan;
  const preReopen = await readXhsNativeDraft(plan.id);
  if (!xhsRecordMatches(preReopen, plan)) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '本地草稿记录不存在、账号不同或内容已改变，保留当前编辑页',
    { evidence: xhsSnapshotEvidence(preReopen, plan) }) };
  const clean = await inspectFinalPublishGuard();
  if (!clean.armed || clean.blockedAttempts) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '重开前安全守卫未通过') };
  const documentToken = `${verificationRunId}:xhs-before-reopen`;
  await js(`window.__publisherDocumentToken = ${JSON.stringify(documentToken)}`);
  await gotoAndWait(plan.listUrl, { timeout: 45, settle: 2 });
  const changed = await js(`window.__publisherDocumentToken !== ${JSON.stringify(documentToken)}`);
  if (!changed) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '未创建新的草稿恢复页面') };
  await armFinalPublishGuard();
  let opened = false;
  for (let n = 0; n < 15 && !opened; n++) {
    opened = await js(`(() => { const nodes = [...document.querySelectorAll('.draft-title-box')].filter(el => el.getBoundingClientRect().width > 0 && /^草稿箱/.test(el.innerText)); if (nodes.length !== 1) return false; nodes[0].click(); return true; })()`);
    if (!opened) await wait(1);
  }
  if (!opened) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '小红书草稿箱入口不可用') };
  let selected = false;
  for (let n = 0; n < 10 && !selected; n++) {
    selected = await js(`(plan => {
      const rows = [...document.querySelectorAll('.draft-item[data-draft-type="video"]')].filter(el => el.dataset.draftId === plan.id && el.getBoundingClientRect().width > 0);
      if (rows.length !== 1 || rows[0].querySelector('.draft-title-text')?.textContent.trim() !== plan.title) return false;
      const edits = [...rows[0].querySelectorAll('.draft-actions .btn')].filter(el => el.innerText.trim() === '编辑' && el.getBoundingClientRect().width > 0);
      if (edits.length !== 1) return false; edits[0].click(); return true;
    })(${JSON.stringify({ id: plan.id, title: plan.title })})`);
    if (!selected) await wait(1);
  }
  if (!selected) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '草稿箱中没有唯一匹配 UUID 和标题的编辑入口') };
  let restored;
  for (let n = 0; n < 30; n++) {
    await wait(1);
    restored = await readXhsNativeDraft(plan.id);
    if (readOnly) {
      await assertXhsReadOnlyGuard();
      const published = xhsNativePublicationBlocker(restored);
      if (published) return {gates: {}, blocker: published};
    }
    if (restored.isFromDraft && restored.id === plan.id && xhsRecordMatches(restored, plan)
      && xhsSnapshotMatchesHash(restored.live, plan.snapshotHash)
      && xhsSnapshotHash(restored.live) === xhsSnapshotHash(restored.record.snapshot)) break;
  }
  await armFinalPublishGuard();
  if (!restored.isFromDraft || restored.id !== plan.id || !xhsRecordMatches(restored, plan)
    || !xhsSnapshotMatchesHash(restored.live, plan.snapshotHash)
    || xhsSnapshotHash(restored.live) !== xhsSnapshotHash(restored.record.snapshot)) {
    return { ...(await inspect()), blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '从草稿箱重开的内容与本次保存不一致',
      { evidence: xhsSnapshotEvidence(restored, plan) }) };
  }
  const reopenedUrl = await js('location.href');
  const proof = { version: 2, method: 'draft-list-reopen', platform, fingerprint: jobFingerprint, verificationRunId,
    savedAt: journal.savedAt, readAt: new Date().toISOString(), draftId: plan.id, listEntryId: plan.id,
    listUrl: plan.listUrl, reopenedId: restored.id, reopenedUrl, documentChanged: true,
    // Park and later fresh reads bind the current native bytes, while retaining
    // the unchanged original save hash and evidence of the checked roundtrip.
    storageScope: 'browser-local', uid: plan.uid, snapshotHash: xhsSnapshotHash(restored.live),
    savedSnapshotHash: plan.snapshotHash,
    ...(xhsSnapshotHash(restored.live) !== plan.snapshotHash ? { nativeSerializationRoundtrip: {
      kind: 'mojito-tiptap-topic-restore-v1', savedSnapshotHash: plan.snapshotHash,
      restoredSnapshotHash: xhsSnapshotHash(restored.live), checkedFullSnapshot: true,
    } } : {}),
    snapshotEvidence: xhsSnapshotEvidence(restored, plan), recoveryEvidence: plan.recoveryEvidence || null };
  await js(`window[${JSON.stringify(PERSISTED_DRAFT_KEY)}] = ${JSON.stringify(proof)}`);
  const after = await inspect();
  after.gates.persistedDraft = await readXhsPersistenceProof();
  return after;
}
