// This fragment runs in Ego's Node process. All browser reads below are native
// DOM/Pinia/IndexedDB reads; parking never invokes a save or an edit action.
async function selectXhsParkingTab(tabs) {
  try {
    const context = typeof xhsParkingContext !== 'undefined' ? xhsParkingContext : null;
    const { proof, identity } = xhsParkingSource(context);
    const candidates = tabs.filter(tab => {
      try {
        const url = new URL(tab.url);
        return url.origin === 'https://creator.xiaohongshu.com' && url.pathname === '/publish/publish'
          && !url.username && !url.password;
      } catch { return false; }
    });
    const matching = [];
    for (const tab of candidates) {
      await switchTab(tab.targetId);
      const native = await readXhsNativeDraft(proof.draftId);
      if (native.available && native.isFromDraft && native.id === proof.draftId && native.uid === proof.uid
        && native.live?.videoFileId === identity.videoFileId) {
        matching.push(tab);
      } else if (context.parkOnly === true && context.priorParking?.proof) {
        const stored = await readXhsStoredDraft(proof.draftId);
        if (xhsParkedIdentityMatches(stored, context.priorParking.proof)) matching.push(tab);
      }
    }
    if (matching.length !== 1) return { ok: false, blocker: typedBlocker('STATE_AMBIGUOUS',
      '未找到唯一匹配原账号、草稿 UUID 与视频文件的现有小红书标签；禁止导航或新建编辑器',
      { evidence: { candidateCount: candidates.length, matchingCount: matching.length, draftId: proof.draftId } }) };
    await switchTab(matching[0].targetId);
    return { ok: true, targetId: matching[0].targetId };
  } catch (error) {
    return { ok: false, blocker: typedBlocker('STATE_AMBIGUOUS', '小红书停放标签身份无法确认；禁止导航或新建编辑器',
      { evidence: { reason: String(error?.message || error) } }) };
  }
}

async function readXhsStoredDraft(draftId) {
  return await js(`(async draftId => {
    const apps = [...document.querySelectorAll('*')].map(el => el.__vue_app__ || el.__vueParentComponent?.appContext?.app).filter(Boolean);
    const pinia = apps.find(app => app.config?.globalProperties?.$pinia)?.config.globalProperties.$pinia;
    const publisher = pinia?._s.get('publisher'), draft = pinia?._s.get('draft');
    const uid = pinia?._s.get('user')?.userInfo?.id;
    const result = { available: Boolean(uid), uid: uid || null, record: null, recordCover: null,
      activeId: publisher?.draftId || null, activeVideoFileId: draft?.video?.fileid || '',
      activeTitle: draft?.title || '', activeDescription: draft?.desc || '',
      publication: { noteId: publisher?.noteId || null, hasBeenPublished: publisher?.hasBeenPublished === true,
        hasBeenPublishSuccess: publisher?.hasBeenPublishSuccess === true }, url: location.href,
      rows: [] };
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let current = el; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0) return false;
      }
      return true;
    };
    const rows = [...document.querySelectorAll('.draft-item[data-draft-type="video"]')]
      .filter(el => el.dataset.draftId === draftId && visible(el));
    for (const row of rows) {
      const thumbnailImages = [];
      for (const image of [...row.querySelectorAll('img')]) {
        const src = String(image.currentSrc || image.src || image.getAttribute?.('src') || '');
        const complete = image.complete === true;
        const naturalWidth = Number(image.naturalWidth || 0), naturalHeight = Number(image.naturalHeight || 0);
        let decoded = false, decodeError = null;
        if (complete && naturalWidth > 0 && naturalHeight > 0 && typeof image.decode === 'function') {
          try {
            await Promise.race([image.decode(), new Promise((_, reject) => setTimeout(() => reject(new Error('decode timeout')), 3000))]);
            decoded = true;
          } catch (error) { decodeError = String(error?.message || error); }
        } else if (typeof image.decode !== 'function') decodeError = 'HTMLImageElement.decode unavailable';
        const finalSrc = String(image.currentSrc || image.src || image.getAttribute?.('src') || '');
        const finalComplete = image.complete === true;
        const finalNaturalWidth = Number(image.naturalWidth || 0), finalNaturalHeight = Number(image.naturalHeight || 0);
        if (decoded && finalSrc !== src) { decoded = false; decodeError = 'image source changed during decode'; }
        const rect = image.getBoundingClientRect();
        thumbnailImages.push({ src: finalSrc, complete: finalComplete, naturalWidth: finalNaturalWidth,
          naturalHeight: finalNaturalHeight, visible: visible(image), decoded,
          decodeError, renderedWidth: rect.width, renderedHeight: rect.height });
      }
      result.rows.push({ id: row.dataset.draftId, title: row.querySelector('.draft-title-text')?.textContent.trim() || '', visible: true,
        thumbnailImages,
        thumbnailUrls: [...row.querySelectorAll('*')].flatMap(node => [node.currentSrc || node.src || '', getComputedStyle(node).backgroundImage || '']).filter(Boolean).slice(0, 100) });
    }
    if (!uid || !(await indexedDB.databases()).some(db => db.name === 'draft-database-v1')) return result;
    const db = await new Promise((resolve, reject) => { const q = indexedDB.open('draft-database-v1');
      q.onupgradeneeded = () => { q.transaction.abort(); reject(new Error('Draft database changed')); };
      q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
    try {
      if (!db.objectStoreNames.contains('video-draft')) return result;
      const tx = db.transaction(['video-draft'], 'readonly');
      const record = await new Promise((resolve, reject) => { const q = tx.objectStore('video-draft').get(draftId);
        q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
      if (!record) return result;
      const d = record.content?.draftStore || {}, s = record.content?.settingStore || {}, c = record.content?.contextStore || {};
      const cover = c.coverContext?.cover?.fileid ? c.coverContext.cover : d.cover;
      result.record = { id: record.draftId, uid: record.uid, timeStamp: record.timeStamp,
        snapshot: { title: d.title || '', description: d.desc || '', descriptionHtml: d.descInnerHTML || '',
          videoFileId: d.video?.fileid || '', transcodeFileId: d.video?.transcodeVideoFileId || '',
          coverFileId: cover?.fileid || '', original: s.original } };
      result.recordCover = { fileid: cover?.fileid || '', width: Number(cover?.width || 0), height: Number(cover?.height || 0) };
      result.recordVideo = { fileid: d.video?.fileid || '', size: Number(d.video?.fsize || 0),
        width: Number(d.video?.width || 0), height: Number(d.video?.height || 0) };
      return result;
    } finally { db.close(); }
  })(${JSON.stringify(draftId)})`);
}

function xhsParkingSource(context) {
  const source = context?.observation, proof = source?.gates?.persistedDraft?.evidence;
  const cover = source?.gates?.cover?.evidence;
  const identity = source?.gates?.draftIdentity?.evidence?.restoredIdentity;
  if (!source || source.platform !== 'xiaohongshu' || source.phase !== 'verify'
    || source.fingerprint !== jobFingerprint || source.blocker || !context.evidencePath
    || xhsSnapshotHash(source) !== context.observationHash
    || (!context.historical && source.verificationRunId !== verificationRunId)
    || (context.historical && context.parkOnly !== true)
    || proof?.version !== 2 || !proof.draftId || !proof.uid || !proof.snapshotHash || !identity?.videoFileId
    || identity.ok !== true || identity.draftId !== proof.draftId
    || proof.fingerprint !== source.fingerprint || proof.verificationRunId !== source.verificationRunId
    || proof.method !== 'draft-list-reopen' || proof.storageScope !== 'browser-local'
    || proof.listEntryId !== proof.draftId || proof.reopenedId !== proof.draftId || proof.documentChanged !== true
    || !Number.isFinite(Date.parse(proof.savedAt)) || Date.parse(proof.readAt) < Date.parse(proof.savedAt)
    || !Number.isFinite(Date.parse(proof.readAt)) || Date.parse(source.observedAt) < Date.parse(proof.readAt)
    || Date.parse(source.observedAt) - Date.parse(proof.readAt) > 60000
    || !cover?.nativeCoverFileId || !cover.nativeCover?.width || !cover.nativeCover?.height
    || cover.nativeCover.fileid !== cover.nativeCoverFileId || cover.recordCover?.fileid !== cover.nativeCoverFileId
    || cover.recordCover.width !== cover.nativeCover.width || cover.recordCover.height !== cover.nativeCover.height) {
    throw new Error('Parking requires the immutable independently verified editor artifact');
  }
  const required = ['authenticated', 'draftIdentity', 'video', 'title', 'description', 'tags', 'original',
    'cover', 'noBlockingDialog', 'finalButton', 'persistedDraft', 'safety'];
  if (required.some(key => source.gates[key]?.ok !== true)
    || source.gates.safety.evidence?.guardArmed !== true || source.gates.safety.evidence?.blockedAttempts !== 0
    || source.gates.safety.evidence?.finalPublishClicked !== false) throw new Error('Source editor verification is incomplete');
  return { source, proof, cover, identity };
}

function xhsParkedIdentityMatches(state, proof) {
  try {
    const cover = state?.recordCover;
    return state?.available === true && state.uid === proof.uid && state.record?.uid === proof.uid
      && state.record.id === proof.draftId && state.record.snapshot?.videoFileId === proof.videoFileId
      && state.record.snapshot?.coverFileId === proof.coverFileId
      && xhsSnapshotHash(state.record.snapshot) === proof.snapshotHash
      && cover?.fileid === proof.coverFileId && cover.width === proof.coverWidth && cover.height === proof.coverHeight
      && state.activeId !== proof.draftId && !state.activeVideoFileId && !state.activeTitle && !state.activeDescription
      && state.url === proof.parkedUrl;
  } catch { return false; }
}

function xhsParkedRecordMatches(state, proof) {
  try {
  if (!xhsParkedIdentityMatches(state, proof)) return false;
  const row = state?.rows?.[0];
  const matchingLoadedImages = Array.isArray(row?.thumbnailImages) ? row.thumbnailImages.filter(image =>
    image?.visible === true && image.complete === true && image.decoded === true
      && Number(image.naturalWidth) > 0 && Number(image.naturalHeight) > 0
      && xhsCoverObjectKey(image.src) === xhsCoverObjectKey(proof.coverFileId)) : [];
  const thumbnailMatches = row?.visible === true && matchingLoadedImages.length === 1;
  return state.rows?.length === 1 && row.id === proof.draftId
    && row.title === proof.visibleRowTitle && thumbnailMatches;
  } catch { return false; }
}

async function readXhsParkedPersistenceProof() {
  const proof = await js(`window[${JSON.stringify(PERSISTED_DRAFT_KEY)}] || null`);
  if (proof?.method !== 'xhs-draft-list-parked' || proof.verificationRunId !== verificationRunId
    || proof.fingerprint !== jobFingerprint) return failedGate({ reason: 'No current parked-list proof' });
  const state = await readXhsStoredDraft(proof.draftId);
  if (!xhsParkedRecordMatches(state, proof)) return failedGate({ reason: 'Parked native record, list row, thumbnail or empty editor changed', draftId: proof.draftId });
  return okGate({ ...proof, readAt: new Date().toISOString() });
}

async function parkXhsDraft() {
  try {
    const context = typeof xhsParkingContext !== 'undefined' ? xhsParkingContext : null;
    const { source, proof: original, cover, identity } = xhsParkingSource(context);
    if (Number(source.taskSpaceId) !== Number(activeTaskSpace?.id)) throw new Error('Parking task-space identity changed');
    const plan = { id: original.draftId, uid: original.uid, snapshotHash: original.snapshotHash };
    const before = await readXhsNativeDraft(original.draftId);
    const priorPark = context.parkOnly === true ? context.priorParking?.proof : null;
    const alreadyParked = priorPark?.method === 'xhs-draft-list-parked' && priorPark.draftId === original.draftId
      && priorPark.uid === original.uid && priorPark.snapshotHash === original.snapshotHash
      && priorPark.videoFileId === identity.videoFileId && priorPark.fingerprint === jobFingerprint
      && priorPark.editorVerification?.observationHash === context.observationHash
      && priorPark.documentChanged === true && priorPark.oldEditorAbsent === true
      && Number(priorPark.taskSpaceId) === Number(activeTaskSpace.id)
      && (!before.available || before.id !== original.draftId || !before.isFromDraft);
    if (!alreadyParked && (!xhsRecordMatches(before, plan) || before.id !== original.draftId || !before.isFromDraft
      || xhsSnapshotHash(before.live) !== original.snapshotHash || before.live.videoFileId !== identity.videoFileId
      || before.liveCover?.fileid !== cover.nativeCoverFileId || before.recordCover?.fileid !== cover.nativeCoverFileId
      || before.liveCover.width !== cover.nativeCover.width || before.liveCover.height !== cover.nativeCover.height
      || before.recordCover.width !== cover.nativeCover.width || before.recordCover.height !== cover.nativeCover.height)) {
      throw new Error('Current editor and native record differ from the independently verified source');
    }
    // Re-read every business field in the current editor even in protective
    // park-only mode. An old READY flag alone never authorizes navigation.
    const current = alreadyParked ? null : await inspectXiaohongshu();
    const business = ['authenticated', 'draftIdentity', 'video', 'title', 'description', 'tags', 'original', 'cover', 'noBlockingDialog', 'finalButton'];
    if (!alreadyParked && (current.blocker || business.some(key => current.gates[key]?.ok !== true))) throw new Error('Current editor business readback is incomplete');
    const guard = await inspectFinalPublishGuard();
    if (!guard.armed || guard.blockedAttempts) throw new Error('Pre-parking publish guard is not clean');
    const token = `${verificationRunId}:xhs-before-park`;
    const listUrl = PLATFORM_URLS.xiaohongshu;
    if (!alreadyParked) {
      await js(`window.__publisherDocumentToken = ${JSON.stringify(token)}`);
      await gotoAndWait(listUrl, { timeout: 45, settle: 2 });
      const changed = await js(`window.__publisherDocumentToken !== ${JSON.stringify(token)}`);
      if (!changed) throw new Error('Parking did not replace the editor document');
      await armFinalPublishGuard();
      let opened = false;
      for (let n = 0; n < 15 && !opened; n++) {
        opened = await js(`(() => { const nodes = [...document.querySelectorAll('.draft-title-box')].filter(el => el.getBoundingClientRect().width > 0 && /^草稿箱/.test(el.innerText)); if (nodes.length !== 1) return false; nodes[0].click(); return true; })()`);
        if (!opened) await wait(1);
      }
      if (!opened) throw new Error('Native draft-list entry is unavailable');
    }
    const parkedAt = alreadyParked ? priorPark.parkedAt : new Date().toISOString();
    const parkedUrl = await js('location.href');
    const parked = { version: 2, method: 'xhs-draft-list-parked', platform, fingerprint: jobFingerprint,
      verificationRunId, taskSpaceId: activeTaskSpace.id, storageScope: 'browser-local',
      draftId: original.draftId, uid: original.uid, videoFileId: identity.videoFileId,
      snapshotHash: original.snapshotHash, coverFileId: cover.nativeCoverFileId,
      coverWidth: cover.nativeCover.width, coverHeight: cover.nativeCover.height,
      savedAt: original.savedAt, editorVerifiedAt: source.observedAt, parkedAt, readAt: parkedAt,
      listUrl, parkedUrl, listEntryId: original.draftId, visibleRowCount: 1,
      visibleRowTitle: source.gates.title.evidence.actual, documentChanged: true, oldEditorAbsent: true,
      ...(alreadyParked ? { transitionReused: true, priorParkingEvidencePath: context.priorParking.evidencePath } : {}),
      parkOnly: context.parkOnly === true,
      editorVerification: { observation: source, observationHash: context.observationHash,
        evidencePath: context.evidencePath, historical: context.historical === true } };
    let stored;
    if (alreadyParked) {
      stored = await readXhsStoredDraft(parked.draftId);
      if (!xhsParkedIdentityMatches(stored, parked)) throw new Error('Parked native identity changed before reopening its list');
      if (!xhsParkedRecordMatches(stored, parked)) {
        const opened = await js(`(() => { const nodes = [...document.querySelectorAll('.draft-title-box')].filter(el => el.getBoundingClientRect().width > 0 && /^草稿箱/.test(el.innerText)); if (nodes.length !== 1) return false; nodes[0].click(); return true; })()`);
        if (!opened) throw new Error('Unique native draft-list control is unavailable');
      }
    }
    for (let n = 0; n < 10; n++) {
      stored = await readXhsStoredDraft(parked.draftId);
      if (xhsParkedRecordMatches(stored, parked)) break;
      await wait(1);
    }
    if (!xhsParkedRecordMatches(stored, parked)) throw new Error('Native list UUID, thumbnail, stored snapshot or empty editor could not be verified');
    const afterGuard = await inspectFinalPublishGuard();
    if (!afterGuard.armed || afterGuard.blockedAttempts) throw new Error('Parked publish guard is not clean');
    parked.readAt = new Date().toISOString();
    await js(`window[${JSON.stringify(PERSISTED_DRAFT_KEY)}] = ${JSON.stringify(parked)}`);
    const persisted = await readXhsParkedPersistenceProof();
    if (before.publication?.noteId || before.publication?.hasBeenPublished || before.publication?.hasBeenPublishSuccess) {
      return { surface: 'xhs-draft-list-parked', gates: {}, evidence: { parked: true, currentNativeRecord: stored.record },
        blocker: typedBlocker('ALREADY_PUBLISHED', '已将编辑器安全停放；原资源已有发布标记，不计作新的草稿投递') };
    }
    return { surface: 'xhs-draft-list-parked', deliveryKind: 'browser_local_draft',
      gates: { authenticated: okGate({ uid: parked.uid }),
        draftIdentity: okGate({ draftId: parked.draftId, uid: parked.uid, videoFileId: parked.videoFileId, snapshotHash: parked.snapshotHash }),
        editorVerified: okGate({ historical: context.historical === true, observationHash: context.observationHash,
          evidencePath: context.evidencePath, verificationRunId: source.verificationRunId }),
        parkedDraft: persisted, persistedDraft: persisted,
        noActiveEditor: okGate({ oldEditorAbsent: true, documentChanged: true }) },
      evidence: { parked: true, currentNativeRecord: stored.record, currentNativeCover: stored.recordCover,
        currentNativeVideo: stored.recordVideo,
        currentListRows: stored.rows, currentEditor: { activeId: stored.activeId, activeVideoFileId: stored.activeVideoFileId,
          activeTitle: stored.activeTitle, activeDescription: stored.activeDescription, url: stored.url },
        sourceEditorEvidence: context.evidencePath } };
  } catch (error) {
    return { surface: 'xhs-draft-list-parked', gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED',
      '小红书停放验收未通过；不会重传、重开或再次暂存', { evidence: { reason: String(error?.message || error) } }) };
  }
}
