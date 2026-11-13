const PERSISTED_DRAFT_KEY = '__VIDEO_PUBLISHER_PERSISTED_DRAFT_V2__';

function readBrowserVideoRevisionSource() {
  const r = typeof videoRevisionContext === 'undefined' ? null : videoRevisionContext;
  if (!r) return null;
  const p = r.sourcePersistedDraft;
  if (!['bilibili', 'wechat_channels', 'xiaohongshu'].includes(platform) || r.nextFingerprint !== jobFingerprint
    || !r.sourceFingerprint || r.sourceFingerprint === r.nextFingerprint
    || !r.sourceDraftId || p?.version !== 2 || p.platform !== platform
    || p.fingerprint !== r.sourceFingerprint || p.method !== 'draft-list-reopen'
    || p.documentChanged !== true || p.draftId !== r.sourceDraftId
    || p.listEntryId !== r.sourceDraftId || p.reopenedId !== r.sourceDraftId
    || !r.sourceVideoIdentity?.sha256 || !r.nextVideoIdentity?.sha256
    || r.sourceVideoIdentity.sha256 === r.nextVideoIdentity.sha256
    || !Number.isSafeInteger(r.sourceTaskSpaceId) || !r.sourceTaskSpaceName) {
    throw new Error('Video revision requires the exact independently saved original native resource and new source bytes');
  }
  if (platform === 'xiaohongshu' && (p.storageScope !== 'browser-local' || p.uid !== r.sourceUid
    || !r.sourceVideoFileId || !p.snapshotHash || r.userAuthorization?.kind !== 'user_attested_original_draft_replacement'
    || r.userAuthorization.uid !== r.sourceUid || r.userAuthorization.sourceDraftId !== r.sourceDraftId
    || r.userAuthorization.sourceVideoFileId !== r.sourceVideoFileId
    || r.userAuthorization.nextVideoSha256 !== r.nextVideoIdentity.sha256)) throw new Error('XHS video replacement requires exact human-attested original UUID/account/media, distinct from native publication evidence');
  const origin = { bilibili: 'https://member.bilibili.com', wechat_channels: 'https://channels.weixin.qq.com',
    xiaohongshu: 'https://creator.xiaohongshu.com' }[platform];
  for (const route of [p.listUrl, p.reopenedUrl]) {
    const u = new URL(route);
    if (u.origin !== origin || u.username || u.password) throw new Error('Video revision contains an untrusted original draft route');
  }
  return r;
}

function browserVideoRevisionPlan(revision) {
  return revision ? { previousFingerprint: revision.previousFingerprint, sourceFingerprint: revision.sourceFingerprint,
    nextFingerprint: revision.nextFingerprint, sourceDraftId: revision.sourceDraftId,
    sourceVideoSha256: revision.sourceVideoIdentity.sha256, nextVideoSha256: revision.nextVideoIdentity.sha256 } : null;
}

function readBrowserCoverRevisionSource() {
  const revision = typeof coverRevisionContext === 'undefined' ? null : coverRevisionContext;
  if (!revision) return null;
  const proof = revision.sourcePersistedDraft?.evidence || revision.sourcePersistedDraft;
  const sourceDraftId = String(revision.sourceDraftId || '');
  const sourceFingerprint = revision.sourceFingerprint || revision.previousFingerprint;
  if (!['xiaohongshu', 'bilibili', 'wechat_channels'].includes(platform)
    || revision.sourcePersistedDraft?.ok === false || !revision.previousFingerprint || !sourceFingerprint
    || sourceFingerprint === revision.nextFingerprint || revision.previousFingerprint === revision.nextFingerprint
    || revision.nextFingerprint !== jobFingerprint || !sourceDraftId
    || proof?.version !== 2 || proof.platform !== platform || proof.fingerprint !== sourceFingerprint
    || proof.method !== 'draft-list-reopen' || proof.documentChanged !== true
    || String(proof.draftId) !== sourceDraftId || String(proof.reopenedId) !== sourceDraftId
    || String(proof.listEntryId) !== sourceDraftId
    || platform === 'xiaohongshu' && (!revision.sourceVideoFileId
      || proof.storageScope !== 'browser-local' || !proof.uid || !proof.snapshotHash)) {
    throw new Error('Cover revision requires the original saved native draft and video identity');
  }
  const origin = { xiaohongshu: 'https://creator.xiaohongshu.com', bilibili: 'https://member.bilibili.com',
    wechat_channels: 'https://channels.weixin.qq.com' }[platform];
  for (const route of [proof.listUrl, proof.reopenedUrl]) {
    const url = new URL(route);
    if (url.origin !== origin || url.username || url.password) {
      throw new Error('Cover revision source contains an untrusted draft route');
    }
  }
  return { ...revision, sourcePersistedDraft: proof, sourceDraftId, sourceFingerprint };
}

function readBrowserTagRevisionSource() {
  const revision = typeof tagRevisionContext === 'undefined' ? null : tagRevisionContext;
  if (!revision) return null;
  if (!revision.previousFingerprint || revision.previousFingerprint === revision.nextFingerprint
    || revision.nextFingerprint !== jobFingerprint) {
    throw new Error('Tag revision fingerprint binding does not match the current package');
  }
  const proof = revision.sourcePersistedDraft?.evidence || revision.sourcePersistedDraft || null;
  const sourceDraftId = String(revision.sourceDraftId || revision.sourceEditorId
    || (platform === 'douyin' ? proof?.reopenedId : proof?.draftId) || '');
  if (!sourceDraftId || revision.sourcePersistedDraft?.ok === false) {
    throw new Error('Tag revision requires a bound source native draft ID');
  }
  if (proof && (proof.version !== 2 || proof.platform !== platform
    || proof.fingerprint !== revision.previousFingerprint || !proof.draftId
    || String(platform === 'douyin' ? proof.reopenedId || '' : proof.draftId) !== sourceDraftId)) {
    throw new Error('Tag revision source persistence identity does not match the original draft');
  }
  if (proof && platform === 'douyin' && (proof.method !== 'resume-slot-reopen'
    || proof.resumeSlotId !== proof.draftId || !proof.cacheKey || !proof.cacheDigest)) {
    throw new Error('Tag revision requires the original Douyin resume-slot cache identity');
  }
  if (['bilibili', 'wechat_channels'].includes(platform)) {
    if (!proof || proof.method !== 'draft-list-reopen' || proof.documentChanged !== true
      || String(proof.listEntryId || '') !== sourceDraftId || String(proof.reopenedId || '') !== sourceDraftId) {
      throw new Error('Tag revision requires confirmed native list and editor evidence for the original draft');
    }
    const origin = platform === 'bilibili' ? 'https://member.bilibili.com' : 'https://channels.weixin.qq.com';
    for (const value of [proof.listUrl, proof.reopenedUrl]) {
      const url = new URL(value);
      if (url.origin !== origin || url.username || url.password) {
        throw new Error('Tag revision source contains an untrusted native draft route');
      }
    }
  }
  return { ...revision, sourcePersistedDraft: proof, sourceDraftId };
}

function browserTagRevisionPlan(revision) {
  return revision ? { previousFingerprint: revision.previousFingerprint, nextFingerprint: revision.nextFingerprint,
    sourceDraftId: revision.sourceDraftId } : null;
}

function browserDraftSaveJournalFile() {
  return typeof draftSaveJournalPath === 'string' && draftSaveJournalPath
    ? draftSaveJournalPath : receiptCheckpointPath ? `${receiptCheckpointPath}.draft-save.json` : '';
}

async function readPersistedDraft() {
  if (platform === 'xiaohongshu') {
    return phase === 'park' ? readXhsParkedPersistenceProof() : readXhsPersistenceProof();
  }
  if (platform === 'douyin') return readDouyinPersistenceProof();
  if (platform === 'bilibili') return readBiliPersistenceProof();
  if (platform === 'wechat_channels') return readWechatPersistenceProof();
  const proof = await js(`window[${JSON.stringify(PERSISTED_DRAFT_KEY)}] || null`);
  const url = await js('location.href');
  const current = new URL(url);
  const id = draftPersistenceContract.idKeys.map(key => current.searchParams.get(key)).find(Boolean);
  return proof && proof.verificationRunId === verificationRunId && proof.fingerprint === jobFingerprint
    && proof.reopenedUrl === url && proof.draftId === id
    ? okGate({ ...proof, readAt: new Date().toISOString() })
    : failedGate({ reason: 'no current-run draft-list reopen evidence', url });
}

async function persistAndReopenDraft(inspect) {
  if (phase !== 'persist') throw new Error('Draft saving is allowed only during persist');
  try {
    if (platform === 'xiaohongshu') return await persistXhsDraft(inspect);
    if (platform === 'douyin') return await persistDouyinDraft(inspect);
    if (platform === 'bilibili') return await persistBiliDraft(inspect);
    if (platform === 'wechat_channels') return await persistWechatDraft(inspect);
    return await persistAndReopenDraftWithJournal(inspect);
  } catch (error) {
    if (/USER_CONTROL|INPUT_CHANNEL_BROKEN|user controls|user-owned|task space.*(?:inactive|unassigned)|browser.*disconnect|connection.*closed/i.test(String(error?.code || '') + ' ' + String(error?.message || ''))) throw error;
    return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '保存或重开过程未完成；保留保存日志，禁止盲目重复保存', { evidence: { reason: String(error?.message || error) } }) };
  }
}

async function persistAndReopenDraftWithJournal(inspect) {
  const journalFile = browserDraftSaveJournalFile();
  const identity = { platform, fingerprint: jobFingerprint };
  const journal = readDraftSaveJournal(journalFile, identity);
  if (journal?.status === 'intent') return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '上次存草稿结果不确定；禁止再次保存，需先核对原草稿', { evidence: { attemptId: journal.attemptId, startedAt: journal.startedAt } }) };
  const before = await inspect();
  const missing = Object.entries(before.gates).filter(([key, value]) => key !== 'persistedDraft' && value.ok !== true).map(([key]) => key);
  if (!journal && (before.blocker || missing.length)) return { ...before, blocker: before.blocker || typedBlocker('PERSISTENCE_UNVERIFIED', '保存前字段尚未全部校验通过', { evidence: { missing } }) };
  const guard = await inspectFinalPublishGuard();
  if (!guard.armed || guard.blockedAttempts) return { ...before, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '安全守卫没有通过') };
  // Missing routes are blockers, never permission to invent an endpoint or click Save/Publish.
  const plan = journal?.plan || await js(`(contract => {
    const visible = el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
    const label = el => String(el.innerText || el.textContent || '').trim();
    const url = new URL(location.href);
    const id = contract.idKeys.map(key => url.searchParams.get(key)).find(Boolean);
    const saves = [...document.querySelectorAll('button,[role="button"]')].filter(el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && contract.saveLabels.includes(label(el)));
    const lists = [...document.querySelectorAll('a[href]')].filter(el => visible(el) && contract.listLabels.includes(label(el)) && el.origin === location.origin && el.href !== location.href);
    return { id, url: location.href, saveLabel: saves.length === 1 ? label(saves[0]) : null, listUrl: lists.length === 1 ? lists[0].href : null, text: document.body.innerText };
  })(${JSON.stringify(draftPersistenceContract)})`);
  if (!plan.id || !plan.saveLabel || !plan.listUrl) {
    return { ...before, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '无法唯一确认草稿 ID、专用存草稿按钮或草稿箱入口；保留编辑页，需平台实测适配', { evidence: { id: plan.id, saveLabel: plan.saveLabel, listUrl: plan.listUrl } }) };
  }
  let savedAt = journal?.savedAt;
  if (!journal) {
    if (/草稿保存成功|保存草稿成功|已保存至草稿箱/.test(plan.text)) return { ...before, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '已有保存提示，无法证明本次保存结果') };
    const attempt = beginDraftSave(journalFile, identity, { id: plan.id, url: plan.url, listUrl: plan.listUrl, saveLabel: plan.saveLabel });
    const clicked = await clickDedicatedDraftButton([plan.saveLabel]);
    if (!clicked.ok) return { ...before, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '专用草稿按钮操作未通过；保留日志，不自动重试', { evidence: clicked }) };
    let saved = false;
    for (let n = 0; n < 12; n++) {
      await wait(1);
      saved = await js('/草稿保存成功|保存草稿成功|已保存至草稿箱/.test(document.body.innerText)');
      if (saved) break;
    }
    if (!saved) return { ...(await inspect()), blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '没有观察到本次存草稿确认；不会离开未确认保存的编辑页') };
    savedAt = new Date().toISOString();
    const savedGuard = await inspectFinalPublishGuard();
    if (!savedGuard.armed || savedGuard.blockedAttempts) return { ...before, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '存草稿期间安全守卫未通过') };
    confirmDraftSave(journalFile, identity, attempt.attemptId, savedAt);
  }
  await gotoAndWait(plan.listUrl, { timeout: 45, settle: 2 });
  await armFinalPublishGuard();
  const link = await js(`(args => {
    const matches = [...document.querySelectorAll('a[href]')].filter(el => {
      if (!el.getBoundingClientRect().width || el.origin !== location.origin) return false;
      const u = new URL(el.href);
      return args.keys.some(key => u.searchParams.get(key) === args.id);
    });
    return matches.length === 1 ? matches[0].href : null;
  })(${JSON.stringify({ keys: draftPersistenceContract.idKeys, id: plan.id })})`);
  if (!link) return { ...(await inspect()), blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '草稿箱中没有唯一匹配同一 ID 的编辑入口') };
  const documentToken = `${verificationRunId}:before-reopen`;
  const listGuard = await inspectFinalPublishGuard();
  if (!listGuard.armed || listGuard.blockedAttempts) return { ...before, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '草稿箱安全守卫未通过') };
  await js(`window.__publisherDocumentToken = ${JSON.stringify(documentToken)}`);
  await gotoAndWait(link, { timeout: 45, settle: 2 });
  await armFinalPublishGuard();
  const changed = await js(`window.__publisherDocumentToken !== ${JSON.stringify(documentToken)}`);
  const after = await inspect();
  const reopenedUrl = await js('location.href');
  const u = new URL(reopenedUrl);
  const reopenedId = draftPersistenceContract.idKeys.map(key => u.searchParams.get(key)).find(Boolean);
  const proof = { version: 2, method: 'draft-list-reopen', platform, fingerprint: jobFingerprint,
    verificationRunId, savedAt, readAt: new Date().toISOString(), draftId: plan.id,
    listEntryId: plan.id, listUrl: plan.listUrl, reopenedId, reopenedUrl, documentChanged: changed === true };
  if (changed && reopenedId === plan.id) await js(`window[${JSON.stringify(PERSISTED_DRAFT_KEY)}] = ${JSON.stringify(proof)}`);
  after.gates.persistedDraft = await readPersistedDraft();
  return after;
}
