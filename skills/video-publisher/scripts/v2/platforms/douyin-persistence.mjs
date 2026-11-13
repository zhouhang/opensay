const douyinJournalFile = () => browserDraftSaveJournalFile();
const douyinJournalIdentity = () => ({ platform, fingerprint: jobFingerprint });
const douyinResumeUrl = 'https://creator.douyin.com/creator-micro/content/upload?enter_from=publish';
const douyinResumeSlotId = plan => createHash('sha256').update(`${plan.lookupToken}\n${plan.cacheKey}\n${plan.cacheDigest}`).digest('hex');
let douyinActiveNormalization = null;

function douyinCacheSnapshot(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payload.cache?.longFileInfo?.vid || !payload.cache.longFileInfo.uri) return null;
  const cache = payload.cache;
  const selected = [cache.coverInfo, cache.coverHorizontalInfo];
  const receipts = typeof expectedReceipts === 'undefined' ? null : expectedReceipts.cover?.slots;
  const selectedCustomCovers = selected.every((cover, index) => {
    if (cover?.edited !== true || cover.type !== 2 || cover.coverEditLogInfo?.video_cover_source !== 'upload'
      || !/^tos-cn-i-[a-z0-9-]+\/[a-f0-9]{32}$/.test(cover.uri || '')) return false;
    const receipt = receipts?.[index === 0 ? 'portrait' : 'landscape'];
    if (!receipt?.afterUrl) return false;
    try {
      const url = new URL(receipt.afterUrl), key = cover.uri.split('/').at(-1);
      return url.protocol === 'https:' && decodeURIComponent(url.pathname).split(/[\/~.]/).includes(key);
    } catch { return false; }
  }) && selected[0].uri !== selected[1].uri;
  const disabledPay = cache.payVideoInfo?.isOpen === false && cache.payVideoInfo.agreementChecked === false
    && cache.payVideoInfo.showConfig === false && cache.payVideoInfo.marketingSwitch === false && cache.payVideoCoverInfo?.coverType === 0;
  const allowUnselectedRecommendations = selectedCustomCovers && disabledPay;
  const signedCoverPaths = new Set(['cache.coverUrl', 'cache.coverHorizontalUrl', 'cache.coverInfo.coverUrl', 'cache.coverHorizontalInfo.coverUrl']);
  const nativeUri = value => /^tos-cn-i-[a-z0-9-]+\/[a-f0-9]{32}$/.test(value || '');
  const canonicalMarker = '__UNSELECTED_DOCUMENT_RESOURCE__';
  const emptyObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  const recommendationInfo = cache.recommendCoverInfo;
  const allowFrameRefresh = allowUnselectedRecommendations && recommendationInfo?.isFromRecommend === true
    && recommendationInfo.isDefaultSelect === false && recommendationInfo.isRecommendClickFrom === ''
    && emptyObject(recommendationInfo.selectInfo) && emptyObject(recommendationInfo.editingInfo)
    && Array.isArray(cache.recommendCoverList) && cache.recommendCoverList.length === 3
    && cache.recommendCoverList.every(item => item.fileName === cache.longFileInfo.name
      && typeof item.isAIGen === 'boolean' && emptyObject(item.rawBlob) && item.cropHeight === cache.longFileInfo.height);
  const check = cache.coverCheckInfo;
  const allowCheckProgress = allowUnselectedRecommendations && check?.isEnable === true
    && Array.isArray(check.problemList) && check.problemList.length === 0
    && Array.isArray(check.hProblemList) && check.hProblemList.length === 0
    && check.problemConclusion === '' && check.hProblemConclusion === '';
  const canonical = (value, trail = '') => {
    if (allowCheckProgress && trail === 'cache.coverCheckInfo.status'
      && (value === canonicalMarker || value === 2 || value === 5)) return canonicalMarker;
    const frame = allowFrameRefresh && trail.match(/^cache\.recommendCoverList\.[0-2]\.(cropBox|cropBox2|cropWidth|frameIndex|time)$/);
    if (frame) {
      const validCrop = Array.isArray(value) && value.length === 4 && value.every(n => Number.isFinite(n) && n >= 0 && n <= 1)
        && value[2] > value[0] && value[3] > value[1];
      const validWidth = frame[1] === 'cropWidth' && Number.isFinite(value) && value > 0 && value <= cache.longFileInfo.width;
      const validTime = frame[1] === 'time' && Number.isFinite(value) && value >= 0 && value <= cache.longFileInfo.duration;
      const validIndex = frame[1] === 'frameIndex' && Number.isInteger(value) && value >= 0 && value <= Math.ceil(cache.longFileInfo.duration);
      if (value === canonicalMarker || (['cropBox', 'cropBox2'].includes(frame[1]) && validCrop) || validWidth || validTime || validIndex) return canonicalMarker;
    }
    if (Array.isArray(value)) return value.map((item, index) => canonical(item, `${trail}.${index}`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
      .filter(key => !(allowFrameRefresh && trail === 'cache.recommendCoverInfo' && key === 'isStartEditing' && value[key] === true))
      .map(key => [key, canonical(value[key], trail ? `${trail}.${key}` : key)]));
    const preview = trail.match(/^cache\.previewVideoList\.(0|[2-8])\.coverUrl$/);
    const signedPreview = allowUnselectedRecommendations && preview && cache.previewVideoList?.[Number(preview[1])]?.isCurrent === false;
    if (typeof value === 'string' && (signedCoverPaths.has(trail) || signedPreview) && /^https:\/\//.test(value)) {
      const url = new URL(value);
      if (signedPreview && !/(?:^|\.)douyinpic\.com$/.test(url.hostname)) return value;
      for (const key of ['x-expires', 'x-signature']) url.searchParams.delete(key);
      if (signedPreview) url.searchParams.delete('l');
      url.searchParams.sort();
      return url.href;
    }
    if (allowUnselectedRecommendations && typeof value === 'string') {
      const recommended = trail.match(/^cache\.recommendCoverList\.[0-2]\.(id|src|previewBlobSrc)$/);
      if (recommended && (value === canonicalMarker || (recommended[1] === 'id' ? /^[a-f0-9]{32}$/.test(value)
        : /^blob:https:\/\/creator\.douyin\.com\/[a-f0-9-]{36}$/.test(value)))) return canonicalMarker;
      if (trail === 'cache.recommendCoverList.0.uri'
        && (value === canonicalMarker || value === 'NOT_READY' || nativeUri(value))) return canonicalMarker;
      if (allowFrameRefresh && trail === 'cache.recommendCoverList.0.uri1'
        && (value === canonicalMarker || nativeUri(value))) return canonicalMarker;
      if (trail === 'cache.recommendImgStr') {
        const images = value.split(',');
        if (images.length === 5 && images.every(uri => nativeUri(uri) || /^tos-cn-i-[a-z0-9-]+\/__UNSELECTED_DOCUMENT_RESOURCE__$/.test(uri))) {
          return images.map(uri => `${uri.slice(0, uri.lastIndexOf('/') + 1)}${canonicalMarker}`).join(',');
        }
      }
      if (trail === 'cache.payVideoCoverInfo.defaultCoverUri' && (value === canonicalMarker || nativeUri(value))) return canonicalMarker;
    }
    return value;
  };
  const value = canonical(payload);
  return { version: 1, normalizationVersion: 3, vid: String(payload.cache.longFileInfo.vid), uri: String(payload.cache.longFileInfo.uri),
    hash: createHash('sha256').update(JSON.stringify(value)).digest('hex'), value };
}

function douyinSnapshotComparison(snapshot) {
  if (snapshot?.version !== 1 || !snapshot.value || createHash('sha256').update(JSON.stringify(snapshot.value)).digest('hex') !== snapshot.hash) return null;
  const normalized = douyinCacheSnapshot(snapshot.value);
  return normalized?.vid === snapshot.vid && normalized.uri === snapshot.uri ? normalized : null;
}

function douyinSemanticCacheMatches(cache, snapshot) {
  const current = douyinCacheSnapshot(cache?.payload);
  const baseline = douyinSnapshotComparison(snapshot);
  return Boolean(baseline && current && current.vid === baseline.vid && current.uri === baseline.uri && current.hash === baseline.hash);
}

function douyinCachedContentMatches(cache, metadata, receipts) {
  const value = cache?.payload?.cache;
  const info = value?.longFileInfo, meta = value?.longFileMetaInfo;
  if (!info || !meta || !metadata || metadata.path !== videoPath || !/^[a-f0-9]{64}$/.test(metadata.sha256 || '')
    || !info.vid || !info.uri || !Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0
    || !Number.isInteger(metadata.width) || metadata.width <= 0 || !Number.isInteger(metadata.height) || metadata.height <= 0) return false;
  const stat = fs.statSync(videoPath);
  if (!stat.isFile() || stat.size !== metadata.size || Math.trunc(stat.mtimeMs) !== metadata.lastModified
    || createHash('sha256').update(fs.readFileSync(videoPath)).digest('hex') !== metadata.sha256) return false;
  for (const item of [info, meta]) {
    if (item.name !== path.basename(videoPath) || item.size !== metadata.size || item.lastModified !== metadata.lastModified
      || Math.abs(item.duration - metadata.durationSeconds) > 0.05 || item.width !== metadata.width || item.height !== metadata.height) return false;
  }
  const coverMatches = (uri, receipt) => {
    if (!uri || !receipt?.afterUrl) return false;
    const key = String(uri).split('/').at(-1);
    if (!/^[a-f0-9]{32}$/.test(key)) return false;
    const url = new URL(receipt.afterUrl);
    return url.protocol === 'https:' && decodeURIComponent(url.pathname).split(/[\/~.]/).includes(key);
  };
  if (!coverMatches(value.coverInfo?.uri, receipts?.cover?.slots?.portrait)
    || !coverMatches(value.coverHorizontalInfo?.uri, receipts?.cover?.slots?.landscape)
    || value.coverInfo.uri === value.coverHorizontalInfo.uri || value.itemTitle !== douyinTitle
    || value.sync !== 0 || value.visibilityType !== 0 || value.scheduleTime !== -1
    || ![false, 0].includes(value.xiguaSyncSwitch)) return false;
  const text = value.textResult?.text, entities = value.textResult?.textExtra;
  if (typeof text !== 'string' || !Array.isArray(entities) || entities.length !== douyinTopics.length) return false;
  const compact = item => String(item || '').replace(/\s+/g, ' ').trim();
  const topic = item => compact(item).replace(/^#/, '').replace(/\s+/g, '');
  let plain = '', cursor = 0;
  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index];
    if (entity.type !== 1 || !/^\d+$/.test(String(entity.hashtag_id || '')) || entity.user_id !== ''
      || topic(entity.hashtag_name) !== topic(douyinTopics[index]) || !Number.isInteger(entity.start) || !Number.isInteger(entity.end)
      || entity.start < cursor || entity.end <= entity.start || entity.end > text.length
      || topic(text.slice(entity.start, entity.end)) !== topic(entity.hashtag_name)) return false;
    plain += text.slice(cursor, entity.start); cursor = entity.end;
  }
  plain += text.slice(cursor);
  return compact(plain) === compact(douyinDescription);
}

function douyinLegacyRecoveryBinding(journal, slot, cache) {
  const source = typeof douyinResumeRecoverySource === 'undefined' ? null : douyinResumeRecoverySource;
  const metadata = typeof localMediaMetadata === 'undefined' ? null : localMediaMetadata;
  const inspection = source?.inspection, failure = source?.failure, proofObservation = source?.proof;
  const proof = proofObservation?.gates?.persistedDraft?.evidence;
  const restored = inspection?.gates?.draftIdentity?.evidence?.restoredIdentity;
  const gates = ['authenticated', 'draftIdentity', 'video', 'title', 'description', 'tags', 'settings', 'cover', 'noBlockingDialog', 'finalButton', 'safety'];
  const failedCaches = failure?.blocker?.evidence?.cacheEntries?.filter(item => item.active) || [];
  if (!source || !inspection || !failure || !proofObservation || journal?.status !== 'confirmed' || journal.plan.cacheSemanticSnapshot || !cache
    || inspection.platform !== platform || failure.platform !== platform || proofObservation?.platform !== platform
    || inspection.fingerprint !== jobFingerprint || failure.fingerprint !== jobFingerprint || proofObservation.fingerprint !== jobFingerprint
    || !inspection.verificationRunId || failure.verificationRunId !== inspection.verificationRunId
    || Number(inspection.taskSpaceId) !== Number(failure.taskSpaceId) || Number(inspection.taskSpaceId) !== Number(activeTaskSpace?.id)
    || inspection.taskSpaceRecovery?.recreated || failure.taskSpaceRecovery?.recreated
    || inspection.finalPublishClicked !== false || failure.finalPublishClicked !== false || inspection.blocker
    || !gates.every(key => inspection.gates?.[key]?.ok === true)
    || inspection.gates.safety.evidence?.guardArmed !== true || inspection.gates.safety.evidence?.blockedAttempts !== 0
    || restored?.ok !== true || restored.existingDraft !== true || restored.consumedSlot !== true || !restored.actualId
    || proofObservation.gates.persistedDraft.ok !== true || proof?.version !== 2 || proof.platform !== platform || proof.fingerprint !== jobFingerprint
    || !gates.every(key => proofObservation.gates?.[key]?.ok === true)
    || proof.verificationRunId !== proofObservation.verificationRunId || proof.method !== 'resume-slot-reopen'
    || proof.resumeSlotObserved !== true || proof.routeChanged !== true || proof.contentReadback !== true
    || proof.reopenedId !== restored.actualId || proof.draftId !== douyinResumeSlotId(journal.plan)
    || proof.resumeSlotId !== proof.draftId || proof.cacheKey !== journal.plan.cacheKey || proof.cacheDigest !== journal.plan.cacheDigest
    || proof.savedAt !== journal.savedAt || failure.blocker?.code !== 'PERSISTENCE_UNVERIFIED' || failure.phase !== 'persist'
    || failure.blocker.evidence?.available !== true || failure.blocker.evidence?.continueCount !== 1
    || failedCaches.length !== 1 || failedCaches[0].key !== journal.plan.cacheKey || failedCaches[0].digest !== cache.digest
    || slot.available !== true || slot.continueCount !== 1 || cache.key !== journal.plan.cacheKey
    || !(Date.parse(inspection.observedAt) <= Date.parse(failure.observedAt))
    || !(Date.parse(proofObservation.observedAt) <= Date.parse(inspection.observedAt))
    || !(Date.parse(proof.savedAt) <= Date.parse(proof.readAt)) || !(Date.parse(proof.readAt) <= Date.parse(proofObservation.observedAt))
    || Date.parse(proofObservation.observedAt) - Date.parse(proof.readAt) > 60000
    || !douyinCachedContentMatches(cache, metadata, expectedReceipts)) return null;
  return { kind: 'legacy-consumed-slot-readback', priorEditorId: restored.actualId,
    sourceVerificationRunId: inspection.verificationRunId, sourceObservedAt: inspection.observedAt,
    failedObservedAt: failure.observedAt, snapshot: douyinCacheSnapshot(cache.payload) };
}

async function inspectDouyinResumeRecovery() {
  const journal = readDraftSaveJournal(douyinJournalFile(), douyinJournalIdentity());
  const slot = await readDouyinResumeSlot();
  const active = slot.cacheEntries.filter(entry => entry.active);
  if (journal?.status !== 'confirmed' || !slot.available || slot.continueCount !== 1 || active.length !== 1
    || active[0].key !== journal.plan.cacheKey) return { ok: false, reason: 'No unique confirmed resume-slot recovery identity' };
  const cache = active[0];
  const exact = cache.digest === journal.plan.cacheDigest;
  const semantic = douyinSemanticCacheMatches(cache, journal.plan.cacheSemanticSnapshot);
  const legacy = !exact && !semantic ? douyinLegacyRecoveryBinding(journal, slot, cache) : null;
  return exact || semantic || legacy ? { ok: true, cacheKey: cache.key, observedCacheDigest: cache.digest,
    originalCacheDigest: journal.plan.cacheDigest, draftId: douyinResumeSlotId(journal.plan),
    snapshot: journal.plan.cacheSemanticSnapshot || legacy?.snapshot || douyinCacheSnapshot(cache.payload),
    normalizationVersion: 3, canonicalSnapshotHash: douyinSnapshotComparison(journal.plan.cacheSemanticSnapshot || legacy?.snapshot)?.hash || null,
    originalSnapshotHash: journal.plan.cacheSemanticSnapshot?.hash || null,
    provenance: legacy || { kind: exact ? 'original-raw-cache' : 'confirmed-semantic-cache' } }
    : { ok: false, reason: 'Resume-slot raw and semantic identities are unverified' };
}

async function readDouyinEditorIdentity() {
  return await js(`(() => {
    const compact = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const controls = [...document.querySelectorAll('button')].filter(el => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        && ['暂存离开', '发布'].includes(compact(el.innerText || el.textContent || ''));
    });
    const root = controls.find(el => compact(el.innerText || el.textContent || '') === '暂存离开') || controls[0];
    const key = root && Object.keys(root).find(name => name.startsWith('__reactFiber$'));
    let fiber = key ? root[key] : null;
    const candidates = [], scenes = [];
    for (let depth = 0; fiber && depth < 40; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || {};
      if (props.scene) scenes.push(String(props.scene));
      if (props.contentType !== 'video') continue;
      let hook = fiber.memoizedState;
      for (let index = 0; hook && index < 80; index += 1, hook = hook.next) {
        const current = hook.memoizedState?.current;
        if (typeof current === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(current)
          && !['publish_page', 'create', 'draft', 'modify'].includes(current)) candidates.push(current);
        if (['create', 'draft', 'modify'].includes(current)) scenes.push(current);
      }
    }
    const ids = [...new Set(candidates)];
    const url = new URL(location.href);
    return { available: ids.length === 1, creationId: ids.length === 1 ? ids[0] : '', candidates: ids,
      scene: [...new Set(scenes)], existingDraft: url.searchParams.get('enter_from') === 'draft', url: location.href };
  })()`);
}

async function readDouyinResumeSlot() {
  return await js(`(() => {
    const compact = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = el => { const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
    const continuations = [...document.querySelectorAll('span,button,[role="button"]')]
      .filter(el => visible(el) && compact(el.innerText || el.textContent || '') === '继续编辑');
    const matches = continuations.filter(el => {
      let parent = el.parentElement, text = '';
      for (let depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) text += ' ' + compact(parent.innerText || parent.textContent || '');
      return /你还有上次未发布的视频.*是否继续编辑/.test(text);
    });
    const cacheEntries = Object.keys(localStorage).filter(key => key.startsWith('publish_form_cache:')).map(key => {
      const raw = String(localStorage.getItem(key) || '');
      let hash = 2166136261;
      for (let index = 0; index < raw.length; index += 1) { hash ^= raw.charCodeAt(index); hash = Math.imul(hash, 16777619); }
      let payload = null;
      try { payload = JSON.parse(raw); } catch {}
      return { key, active: Boolean(raw && raw !== 'null' && raw !== 'undefined'), length: raw.length,
        digest: (hash >>> 0).toString(16).padStart(8, '0'), payload };
    });
    return { available: matches.length === 1, continueCount: matches.length, cacheEntries, url: location.href };
  })()`);
}

async function readDouyinRestoredIdentity(contentIdentityMatches = false) {
  const revision = readBrowserTagRevisionSource();
  const journal = readDraftSaveJournal(douyinJournalFile(), douyinJournalIdentity());
  const editor = await readDouyinEditorIdentity();
  if (!journal && revision?.sourcePersistedDraft) {
    const proof = revision.sourcePersistedDraft;
    const slot = await readDouyinResumeSlot();
    const active = slot.cacheEntries.filter(entry => entry.active);
    const sameCache = active.length === 1 && active[0].key === proof.cacheKey
      && (active[0].digest === proof.cacheDigest || active[0].digest === proof.observedCacheDigest
        || (proof.cacheSemanticHash && douyinCacheSnapshot(active[0].payload)?.hash === proof.cacheSemanticHash)
        || contentIdentityMatches === true);
    const consumedSlot = active.length === 0 && editor.existingDraft && /[?&]enter_from=draft(?:&|$)/.test(editor.url);
    return { ok: editor.available && editor.existingDraft && editor.creationId === revision.sourceDraftId && (sameCache || consumedSlot),
      existingDraft: editor.existingDraft, actualId: editor.creationId || null, draftId: proof.draftId,
      cacheKey: proof.cacheKey, cacheDigest: sameCache ? active[0].digest : proof.cacheDigest, consumedSlot, tagRevision: true };
  }
  if (journal?.status !== 'confirmed' || !journal.plan.id) {
    return { ok: false, existingDraft: editor.existingDraft, actualId: editor.creationId || null };
  }
  const slot = await readDouyinResumeSlot();
  const cache = slot.cacheEntries.find(entry => entry.key === journal.plan.cacheKey && entry.active);
  const controlledRepair = await js(`window.__publisherDouyinNeedsResave === ${JSON.stringify(jobFingerprint)}`);
  const activeCaches = slot.cacheEntries.filter(entry => entry.active);
  const consumedSlot = editor.existingDraft && /[?&]enter_from=draft(?:&|$)/.test(editor.url) && activeCaches.length === 0;
  const semanticMatch = douyinSemanticCacheMatches(cache, journal.plan.cacheSemanticSnapshot)
    || Boolean(douyinActiveNormalization && douyinActiveNormalization.fingerprint === jobFingerprint
      && douyinActiveNormalization.cacheKey === cache?.key && douyinSemanticCacheMatches(cache, douyinActiveNormalization.snapshot));
  const sameSlot = Boolean((cache && (cache.digest === journal.plan.cacheDigest || semanticMatch || controlledRepair === true)) || consumedSlot);
  const stableId = sameSlot ? douyinResumeSlotId(journal.plan) : '';
  return { ok: editor.available && editor.existingDraft && (contentIdentityMatches === true || controlledRepair === true) && sameSlot,
    existingDraft: editor.existingDraft, actualId: editor.creationId || null, priorEditorId: String(journal.plan.id),
    draftId: stableId || null, cacheKey: cache?.key || null, cacheDigest: cache?.digest || null,
    editorIdRotated: Boolean(editor.creationId && editor.creationId !== String(journal.plan.id)), controlledRepair, consumedSlot, semanticMatch };
}

async function clickDouyinResumeContinue() {
  const point = await js(`(() => {
    const compact = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const nodes = [...document.querySelectorAll('span,button,[role="button"]')].filter(el => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden'
        || compact(el.innerText || el.textContent || '') !== '继续编辑') return false;
      let parent = el.parentElement, text = '';
      for (let depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) text += ' ' + compact(parent.innerText || parent.textContent || '');
      return /你还有上次未发布的视频.*是否继续编辑/.test(text);
    });
    if (nodes.length !== 1) return { ok: false, count: nodes.length };
    const rect = nodes[0].getBoundingClientRect();
    return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point.ok) return point;
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return { ok: true };
}

async function readDouyinPersistenceProof() {
  const proof = await js(`window[${JSON.stringify(PERSISTED_DRAFT_KEY)}] || null`);
  if (!proof || proof.verificationRunId !== verificationRunId || proof.fingerprint !== jobFingerprint
    || proof.platform !== platform || proof.method !== 'resume-slot-reopen') {
    return failedGate({ reason: 'No current Douyin resume-slot reopen proof' });
  }
  const [editor, url, slot] = await Promise.all([readDouyinEditorIdentity(), js('location.href'), readDouyinResumeSlot()]);
  const active = slot.cacheEntries.filter(entry => entry.active);
  const sameCache = active.length === 0 || active.length === 1 && active[0].key === proof.cacheKey
    && (active[0].digest === proof.cacheDigest || proof.cacheSemanticHash && douyinCacheSnapshot(active[0].payload)?.hash === proof.cacheSemanticHash);
  return editor.available && editor.existingDraft && editor.creationId === proof.reopenedId && url === proof.reopenedUrl && sameCache
    ? okGate({ ...proof, readAt: new Date().toISOString() })
    : failedGate({ reason: 'Douyin reopened editor no longer matches the verified resume-slot instance', editor, url });
}

async function persistDouyinDraft(inspect) {
  const revision = readBrowserTagRevisionSource();
  const file = douyinJournalFile(), identity = douyinJournalIdentity();
  let journal = readDraftSaveJournal(file, identity);
  if (journal?.status === 'intent') {
    return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '抖音上次暂存结果不确定；禁止再次暂存，需先核对恢复槽位') };
  }
  if (!journal) {
    const before = await inspect();
    const missing = Object.entries(before.gates).filter(([key, gate]) => key !== 'persistedDraft' && !gate.ok).map(([key]) => key);
    if (before.blocker || missing.length) {
      return { ...before, blocker: before.blocker || typedBlocker('PERSISTENCE_UNVERIFIED', '抖音暂存前字段校验未通过', { evidence: { missing } }) };
    }
    const editor = await readDouyinEditorIdentity();
    const existingRevision = Boolean(revision?.sourcePersistedDraft && editor.existingDraft
      && (await readDouyinRestoredIdentity(true)).ok);
    if (!editor.available || (editor.existingDraft && !existingRevision) || (revision?.sourceDraftId && editor.creationId !== revision.sourceDraftId)) {
      return { ...before, blocker: typedBlocker('STATE_AMBIGUOUS', '抖音当前编辑器无法唯一绑定新建视频的原生 creation ID', { evidence: editor }) };
    }
    const slotBefore = await readDouyinResumeSlot();
    const activeBefore = slotBefore.cacheEntries.filter(entry => entry.active);
    const existingCache = activeBefore[0];
    const sourceCacheKey = existingRevision ? revision.sourcePersistedDraft.cacheKey : null;
    if (slotBefore.available || (existingCache && (!existingRevision || activeBefore.length !== 1 || existingCache.key !== sourceCacheKey))) {
      return { ...before, blocker: typedBlocker('STATE_AMBIGUOUS', '抖音已有未处理的上次未发布视频恢复槽位，拒绝覆盖', { evidence: slotBefore }) };
    }
    const url = await js('location.href');
    const plan = { id: editor.creationId, lookupToken: createHash('sha256').update(`${douyinTitle}\n${douyinDescription}\n${videoPath}`).digest('hex'),
      title: douyinTitle, url, listUrl: douyinResumeUrl, saveLabel: '暂存离开',
      ...(revision ? { tagRevision: browserTagRevisionPlan(revision) } : {}),
      ...(sourceCacheKey ? { sourceCacheKey } : {}),
      previousCacheDigests: slotBefore.cacheEntries.map(entry => `${entry.key}:${entry.digest}`) };
    journal = beginDraftSave(file, identity, plan);
    const documentToken = `${verificationRunId}:douyin-before-save`;
    await js(`window.__publisherDocumentToken = ${JSON.stringify(documentToken)}`);
    const clicked = await clickDedicatedDraftButton(['暂存离开']);
    if (!clicked.ok) return { ...before, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '抖音专用暂存控件操作未通过；保留日志', { evidence: clicked }) };
    let slot;
    for (let n = 0; n < 30; n += 1) {
      await wait(1);
      slot = await readDouyinResumeSlot();
      const active = slot.cacheEntries.filter(entry => entry.active);
      const changed = active.some(entry => !plan.previousCacheDigests.includes(`${entry.key}:${entry.digest}`));
      if (slot.available && active.length === 1 && changed && (!plan.sourceCacheKey || active[0].key === plan.sourceCacheKey)) break;
    }
    const active = slot?.cacheEntries?.filter(entry => entry.active) || [];
    const changed = active.some(entry => !plan.previousCacheDigests.includes(`${entry.key}:${entry.digest}`));
    if (!slot?.available || active.length !== 1 || !changed || (plan.sourceCacheKey && active[0].key !== plan.sourceCacheKey)) {
      return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '抖音暂存后未重新读到唯一恢复提示和已变化的原生缓存；禁止重复暂存', { evidence: slot }) };
    }
    journal = confirmDraftSave(file, identity, journal.attemptId, new Date().toISOString(),
      { cacheKey: active[0].key, cacheDigest: active[0].digest,
        ...(douyinCacheSnapshot(active[0].payload) ? { cacheSemanticSnapshot: douyinCacheSnapshot(active[0].payload) } : {}) });
  }
  const needsResave = await js(`window.__publisherDouyinNeedsResave === ${JSON.stringify(jobFingerprint)}`);
  if (journal?.status === 'confirmed' && needsResave === true) {
    const before = await inspect();
    const missing = Object.entries(before.gates).filter(([key, gate]) => key !== 'persistedDraft' && !gate.ok).map(([key]) => key);
    if (before.blocker || missing.length) {
      return { ...before, blocker: before.blocker || typedBlocker('PERSISTENCE_UNVERIFIED', '抖音更正暂存前字段校验未通过', { evidence: { missing } }) };
    }
    const editor = await readDouyinEditorIdentity();
    const slotBefore = await readDouyinResumeSlot();
    const activeCaches = slotBefore.cacheEntries.filter(entry => entry.active);
    const currentCache = activeCaches.find(entry => entry.key === journal.plan.cacheKey);
    const consumedSlot = activeCaches.length === 0 && /[?&]enter_from=draft(?:&|$)/.test(editor.url);
    if (!editor.available || !editor.existingDraft || !(currentCache || consumedSlot)) {
      return { ...before, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '抖音更正暂存无法绑定同一恢复槽位和当前草稿实例', { evidence: { editor, slotBefore } }) };
    }
    const url = await js('location.href');
    journal = restartConfirmedResumeSlotSave(file, identity, { ...journal.plan, id: editor.creationId, url,
      previousCacheDigests: slotBefore.cacheEntries.map(entry => `${entry.key}:${entry.digest}`) },
    'repair platform-added paragraph markers in the same resume slot');
    const clicked = await clickDedicatedDraftButton(['暂存离开']);
    if (!clicked.ok) return { ...before, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '抖音更正后的专用暂存控件操作未通过；保留日志', { evidence: clicked }) };
    let slot;
    for (let n = 0; n < 30; n += 1) {
      await wait(1); slot = await readDouyinResumeSlot();
      const active = slot.cacheEntries.filter(entry => entry.active);
      if (slot.available && active.length === 1 && active[0].key === journal.plan.cacheKey) break;
    }
    const active = slot?.cacheEntries?.filter(entry => entry.active) || [];
    if (!slot?.available || active.length !== 1 || active[0].key !== journal.plan.cacheKey) {
      return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '抖音更正暂存后未重新读到同一唯一恢复槽位；禁止重复暂存', { evidence: slot }) };
    }
    journal = confirmDraftSave(file, identity, journal.attemptId, new Date().toISOString(),
      { cacheKey: active[0].key, cacheDigest: active[0].digest,
        ...(douyinCacheSnapshot(active[0].payload) ? { cacheSemanticSnapshot: douyinCacheSnapshot(active[0].payload) } : {}) });
  }
  const plan = journal.plan;
  const preNavigation = await readDouyinResumeSlot();
  const knownCache = preNavigation.cacheEntries.find(entry => entry.active && entry.key === plan.cacheKey && entry.digest === plan.cacheDigest);
  const baselineSnapshot = plan.cacheSemanticSnapshot || douyinCacheSnapshot(knownCache?.payload);
  await gotoAndWait(plan.listUrl, { timeout: 45, settle: 2 });
  await armFinalPublishGuard();
  let slot;
  for (let n = 0; n < 20; n += 1) { slot = await readDouyinResumeSlot(); if (slot.available) break; await wait(1); }
  const cache = slot?.cacheEntries?.find(entry => entry.key === plan.cacheKey);
  const active = slot?.cacheEntries?.filter(entry => entry.active) || [];
  const legacy = !baselineSnapshot && cache?.digest !== plan.cacheDigest ? douyinLegacyRecoveryBinding(journal, slot, cache) : null;
  const snapshot = baselineSnapshot || legacy?.snapshot || null;
  const normalized = cache?.digest !== plan.cacheDigest && (douyinSemanticCacheMatches(cache, snapshot));
  if (!slot?.available || slot.continueCount !== 1 || active.length !== 1 || !cache?.active || (cache.digest !== plan.cacheDigest && !normalized)) {
    return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '抖音新页面没有重新读到同一恢复槽位缓存', { evidence: slot }) };
  }
  douyinActiveNormalization = normalized ? { fingerprint: jobFingerprint, cacheKey: cache.key, snapshot } : null;
  const guard = await inspectFinalPublishGuard();
  if (!guard.armed || guard.blockedAttempts) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '抖音重开前安全守卫未通过') };
  const documentToken = `${verificationRunId}:douyin-before-reopen`;
  await js(`window.__publisherDocumentToken = ${JSON.stringify(documentToken)}`);
  const resumePageUrl = await js('location.href');
  const clicked = await clickDouyinResumeContinue();
  if (!clicked.ok) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '抖音恢复提示中没有唯一继续编辑入口', { evidence: clicked }) };
  let editor;
  for (let n = 0; n < 30; n += 1) {
    await wait(1);
    editor = await readDouyinEditorIdentity();
    if (editor.available && editor.existingDraft) break;
  }
  const changedDocument = await js(`window.__publisherDocumentToken !== ${JSON.stringify(documentToken)}`);
  const reopenedUrl = await js('location.href');
  const routeChanged = reopenedUrl !== resumePageUrl && /[?&]enter_from=draft(?:&|$)/.test(reopenedUrl);
  await armFinalPublishGuard();
  if (!routeChanged || !editor?.available || !editor.existingDraft || !editor.creationId) {
    return { ...(await inspect()), blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '抖音未从同一恢复槽位进入新的草稿编辑实例', { evidence: { changedDocument, routeChanged, resumePageUrl, reopenedUrl, editor } }) };
  }
  const after = await inspect();
  const missing = Object.entries(after.gates).filter(([key, gate]) => key !== 'persistedDraft' && !gate.ok).map(([key]) => key);
  if (after.blocker || missing.length) {
    return { ...after, blocker: after.blocker || typedBlocker('PERSISTENCE_UNVERIFIED', '抖音恢复槽位重开后的完整字段回读不一致', { evidence: { missing } }) };
  }
  if (snapshot && !plan.cacheSemanticSnapshot) {
    journal = recordConfirmedResumeSlotNormalization(file, identity, journal.attemptId, {
      cacheKey: plan.cacheKey, originalCacheDigest: plan.cacheDigest, observedCacheDigest: cache.digest,
      snapshot, verificationRunId, priorEditorId: legacy?.priorEditorId || String(plan.id), reopenedId: editor.creationId,
      routeChanged: true, contentReadback: true, observedAt: new Date().toISOString(),
      provenance: legacy ? { ...legacy, snapshot: undefined } : { kind: normalized ? 'semantic-cache-readback' : 'original-raw-cache' },
    });
  }
  const draftId = douyinResumeSlotId(plan);
  const proof = { version: 2, method: 'resume-slot-reopen', platform, fingerprint: jobFingerprint, verificationRunId,
    savedAt: journal.savedAt, readAt: new Date().toISOString(), draftId,
    resumeSlotId: draftId, resumeSlotObserved: true, uploadUrl: plan.listUrl,
    preSaveEditorId: String(plan.id), reopenedId: editor.creationId, reopenedUrl,
    documentChanged: changedDocument === true, routeChanged, contentReadback: true,
    cacheKey: plan.cacheKey, cacheDigest: plan.cacheDigest, observedCacheDigest: cache.digest,
    cacheSemanticHash: douyinSnapshotComparison(snapshot)?.hash || null, cacheSemanticNormalizationVersion: 3,
    savedCacheSemanticHash: snapshot?.hash || null, cacheNormalization: normalized ? legacy?.kind || 'semantic-cache-readback' : null };
  await js('window.__publisherDouyinNeedsResave = null');
  await js(`window[${JSON.stringify(PERSISTED_DRAFT_KEY)}] = ${JSON.stringify(proof)}`);
  after.gates.persistedDraft = await readDouyinPersistenceProof();
  return after;
}
