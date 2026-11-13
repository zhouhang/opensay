const biliJournalFile = () => browserDraftSaveJournalFile();
const biliQuarantineJournalFile = () => receiptCheckpointPath ? `${receiptCheckpointPath}.quarantine-draft-save.json` : '';
const biliJournalIdentity = () => ({ platform, fingerprint: jobFingerprint });
const biliListUrl = 'https://member.bilibili.com/platform/upload-manager/article?group=draft';

async function readBiliDraftList() {
  return await js(`(async () => {
    const response = await fetch('/x/vupre/web/draft/list', { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error('Bilibili draft list HTTP ' + response.status);
    const body = await response.json();
    if (body.code !== 0 || !Array.isArray(body.data)) throw new Error('Bilibili draft list response changed');
    return body.data;
  })()`);
}

function biliEntryId(entry) { return String(entry?.id ?? entry?.draftId ?? entry?.draft_id ?? ''); }
function biliEntryTitle(entry) { return String(entry?.title ?? entry?.archive?.title ?? ''); }
function biliEntryFilenames(entry) {
  const videos = entry?.videos ?? entry?.archive?.videos ?? [];
  return Array.isArray(videos) ? videos.flatMap(video => [video?.filename, video?.title]).filter(Boolean).map(String) : [];
}
function findBiliDraft(entries, plan) {
  const matches = entries.filter(entry => {
    const id = biliEntryId(entry);
    if (!id || plan.id && id !== String(plan.id)) return false;
    if (!plan.id && plan.beforeIds.includes(id)) return false;
    if (biliEntryTitle(entry) !== plan.title) return false;
    const files = biliEntryFilenames(entry);
    return !files.length || files.some(name => name === plan.videoName || name === plan.videoStem || name.startsWith(plan.videoStem));
  });
  return matches.length === 1 ? { id: biliEntryId(matches[0]), entry: matches[0] } : null;
}

function biliRevisionCreatedCopies(entries, plan) {
  if (!plan.tagRevision && !plan.coverRevision && !plan.videoRevision) return [];
  return entries.filter(entry => findBiliDraft([entry], { ...plan, id: undefined }))
    .map(biliEntryId);
}

async function readBiliEditorIdentity() {
  return await js(`(() => {
    const root = document.querySelector('.video-basic-wrp')?.__vue__;
    const task = root?.getCurrentTask?.();
    const draftId = task?.archive?.draftId;
    return { existingDraft: root?.isEditDraftMode === true || new URL(location.href).searchParams.get('type') === 'draft',
      draftId: draftId == null ? '' : String(draftId), title: String(task?.archive?.title || ''),
      filenames: (task?.videoTasks || []).flatMap(video => [video?.filename, video?.title]).filter(Boolean).map(String) };
  })()`);
}

async function readBiliRestoredIdentity() {
  const coverRevision = readBrowserCoverRevisionSource();
  const videoRevision = typeof readBrowserVideoRevisionSource === 'function' ? readBrowserVideoRevisionSource() : null;
  const revision = videoRevision || readBrowserTagRevisionSource() || coverRevision;
  const journal = readDraftSaveJournal(biliJournalFile(), biliJournalIdentity());
  const editor = await readBiliEditorIdentity();
  if (revision) {
    const id = revision.sourceDraftId;
    return { ok: editor.existingDraft && editor.draftId === id && (!journal?.plan?.id || String(journal.plan.id) === id),
      existingDraft: editor.existingDraft, actualId: editor.draftId || null, draftId: id, ...(revision === videoRevision ? { videoRevision: true } : revision === coverRevision ? { coverRevision: true } : { tagRevision: true }) };
  }
  if (journal?.status !== 'confirmed' || !journal.plan.id) return { ok: false, existingDraft: editor.existingDraft, actualId: editor.draftId || null };
  return { ok: editor.existingDraft && editor.draftId === String(journal.plan.id), existingDraft: editor.existingDraft,
    actualId: editor.draftId || null, draftId: String(journal.plan.id) };
}

async function readBiliPersistenceProof() {
  const proof = await js(`window[${JSON.stringify(PERSISTED_DRAFT_KEY)}] || null`);
  if (!proof || proof.verificationRunId !== verificationRunId || proof.fingerprint !== jobFingerprint || proof.platform !== platform) {
    return failedGate({ reason: 'No current Bilibili reopen proof' });
  }
  const [editor, entries, url] = await Promise.all([readBiliEditorIdentity(), readBiliDraftList(), js('location.href')]);
  const createdCopies = biliRevisionCreatedCopies(entries, proof.lookup);
  if (createdCopies.length) return failedGate({ reason: 'Revision created additional native draft IDs', createdCopies });
  const match = findBiliDraft(entries, { ...proof.lookup, id: proof.draftId });
  return editor.existingDraft && editor.draftId === proof.draftId && match?.id === proof.draftId && url === proof.reopenedUrl
    ? okGate({ ...proof, readAt: new Date().toISOString() })
    : failedGate({ reason: 'Bilibili list or reopened editor no longer matches', editor, url });
}

async function persistBiliDraft(inspect) {
  const coverRevision = readBrowserCoverRevisionSource();
  const videoRevision = typeof readBrowserVideoRevisionSource === 'function' ? readBrowserVideoRevisionSource() : null;
  const revision = videoRevision || readBrowserTagRevisionSource() || coverRevision;
  const file = biliJournalFile(), identity = biliJournalIdentity();
  let journal = readDraftSaveJournal(file, identity);
  let attemptStarted = false;
  let saveInspection = null;
  if (revision && journal?.plan?.id && String(journal.plan.id) !== revision.sourceDraftId) {
    return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', 'B站修订日志不属于原草稿 ID') };
  }
  // Revision intents only reopen and reread the bound record; they never save again.
  if (journal?.status === 'intent' && !journal.plan.tagRevision && !journal.plan.coverRevision && !journal.plan.videoRevision) {
    const entries = await readBiliDraftList();
    const match = findBiliDraft(entries, journal.plan);
    if (match) {
      journal = confirmDraftSave(file, identity, journal.attemptId, new Date().toISOString(), { id: match.id });
    } else {
      const settled = Date.now() - Date.parse(journal.startedAt) >= 60000;
      if (!settled) {
        return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', 'B站上次存草稿结果不确定；核对草稿列表前禁止再次保存',
          { evidence: { settled: false, attemptId: journal.attemptId, startedAt: journal.startedAt } }) };
      }
      const editor = await readBiliEditorIdentity();
      const current = await inspect();
      saveInspection = current;
      const missing = Object.entries(current.gates || {}).filter(([key, gate]) => key !== 'persistedDraft' && !gate.ok).map(([key]) => key);
      const currentIds = entries.map(biliEntryId).filter(Boolean).sort();
      const beforeIds = [...journal.plan.beforeIds].sort();
      const sameList = JSON.stringify(currentIds) === JSON.stringify(beforeIds);
      const sameUnsavedEditor = !editor.existingDraft && !editor.draftId && current.gates?.draftIdentity?.ok
        && current.gates?.video?.ok && current.gates?.title?.ok && !current.blocker && missing.length === 0;
      if (!settled || !sameList || !sameUnsavedEditor) {
        return { ...current, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', 'B站上次存草稿结果不确定；核对草稿列表前禁止再次保存',
          { evidence: { settled, sameList, sameUnsavedEditor, missing, editor, currentIds, beforeIds } }) };
      }
      journal = restartUnconfirmedDraftSave(file, identity, { ...journal.plan },
        'draft list unchanged and the same complete unsaved editor remained after the settlement window');
      attemptStarted = true;
    }
  }
  if (!journal) {
    const before = await inspect();
    saveInspection = before;
    const missing = Object.entries(before.gates).filter(([key, gate]) => key !== 'persistedDraft' && !gate.ok).map(([key]) => key);
    if (before.blocker || missing.length) return { ...before, blocker: before.blocker || typedBlocker('PERSISTENCE_UNVERIFIED', 'B站存草稿前字段校验未通过', { evidence: { missing } }) };
    const editor = await readBiliEditorIdentity();
    if (revision ? (!editor.existingDraft || editor.draftId !== revision.sourceDraftId)
      : (editor.existingDraft || editor.draftId)) {
      return { ...before, blocker: typedBlocker('STATE_AMBIGUOUS', 'B站当前编辑器没有绑定授权的原草稿 ID', { evidence: { editor, sourceDraftId: revision?.sourceDraftId || null } }) };
    }
    const entries = await readBiliDraftList();
    const url = await js('location.href');
    const plan = { lookupToken: createHash('sha256').update(`${bilibiliTitle}\n${bilibiliDescription}\n${bilibiliVideoName}`).digest('hex'),
      title: bilibiliTitle, videoName: bilibiliVideoName, videoStem: bilibiliVideoStem,
      beforeIds: entries.map(biliEntryId).filter(Boolean), url, listUrl: biliListUrl, saveLabel: '存草稿',
      ...(revision ? { id: revision.sourceDraftId,
        [revision === videoRevision ? 'videoRevision' : revision === coverRevision ? 'coverRevision' : 'tagRevision']: revision === videoRevision ? browserVideoRevisionPlan(revision) : browserTagRevisionPlan(revision) } : {}) };
    if (revision && !findBiliDraft(entries, revision === videoRevision ? { ...plan, videoName: revision.sourcePersistedDraft.lookup?.videoName || '', videoStem: revision.sourcePersistedDraft.lookup?.videoStem || '' } : plan)) {
      return { ...before, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', 'B站原草稿 ID 在原生列表中没有唯一匹配记录') };
    }
    journal = beginDraftSave(file, identity, plan);
    attemptStarted = true;
  }
  if (attemptStarted) {
    const plan = journal.plan;
    const clicked = await clickDedicatedDraftSelector('span.submit-draft', '存草稿', 'SPAN');
    if (!clicked.ok) return { ...(saveInspection || {}), blocker: typedBlocker('PERSISTENCE_UNVERIFIED', 'B站专用存草稿控件操作未通过；保留日志', { evidence: clicked }) };
    let match;
    for (let n = 0; n < 30 && !match; n++) {
      await wait(1);
      const entries = await readBiliDraftList();
      const createdCopies = biliRevisionCreatedCopies(entries, plan);
      if (createdCopies.length) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', 'B站原稿修订出现同内容的新增草稿 ID；保留保存意图，禁止接受副本', { evidence: { createdCopies } }) };
      match = findBiliDraft(entries, plan);
    }
    if (!match) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', (plan.tagRevision || plan.coverRevision || plan.videoRevision)
      ? 'B站原草稿 ID 保存后没有唯一匹配记录；禁止重复保存' : 'B站草稿列表未出现唯一新增记录；禁止重复保存') };
    if (!plan.tagRevision && !plan.coverRevision && !plan.videoRevision) journal = confirmDraftSave(file, identity, journal.attemptId, new Date().toISOString(), { id: match.id });
  }
  const plan = journal.plan;
  const entries = await readBiliDraftList();
  const createdCopies = biliRevisionCreatedCopies(entries, plan);
  if (createdCopies.length) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', 'B站原稿修订出现同内容的新增草稿 ID；禁止重复保存或接受副本', { evidence: { createdCopies } }) };
  const listed = findBiliDraft(entries, plan);
  if (!listed) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', 'B站草稿列表中没有唯一匹配记录') };
  const guard = await inspectFinalPublishGuard();
  if (!guard.armed || guard.blockedAttempts) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', 'B站重开前安全守卫未通过') };
  const documentToken = `${verificationRunId}:bili-before-reopen`;
  await js(`window.__publisherDocumentToken = ${JSON.stringify(documentToken)}`);
  const reopen = new URL(PLATFORM_URLS.bilibili); reopen.search = ''; reopen.searchParams.set('type', 'draft'); reopen.searchParams.set('draftId', plan.id);
  await gotoAndWait(reopen.href, { timeout: 45, settle: 2 });
  const changed = await js(`window.__publisherDocumentToken !== ${JSON.stringify(documentToken)}`);
  await armFinalPublishGuard();
  let editor;
  for (let n = 0; n < 30; n++) { editor = await readBiliEditorIdentity(); if (editor.existingDraft && editor.draftId === String(plan.id)) break; await wait(1); }
  if (!changed || !editor?.existingDraft || editor.draftId !== String(plan.id)) {
    return { ...(await inspect()), blocker: typedBlocker('PERSISTENCE_UNVERIFIED', 'B站未能重开同一草稿 ID', { evidence: { changed, editor } }) };
  }
  const after = await inspect();
  if (plan.tagRevision || plan.coverRevision || plan.videoRevision) {
    const missing = Object.entries(after.gates).filter(([key, gate]) => key !== 'persistedDraft' && !gate.ok).map(([key]) => key);
    if (after.blocker || missing.length) return { ...after, blocker: after.blocker || typedBlocker('PERSISTENCE_UNVERIFIED', 'B站原草稿重开后的修订字段不一致；保留保存意图，禁止重复保存', { evidence: { missing } }) };
    const createdCopies = biliRevisionCreatedCopies(await readBiliDraftList(), plan);
    if (createdCopies.length) return { ...after, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', 'B站原稿修订重开后出现同内容的新增草稿 ID；保留保存意图', { evidence: { createdCopies } }) };
    if (journal.status === 'intent') journal = confirmDraftSave(file, identity, journal.attemptId, new Date().toISOString());
  }
  const reopenedUrl = await js('location.href');
  const proof = { version: 2, method: 'draft-list-reopen', platform, fingerprint: jobFingerprint, verificationRunId,
    savedAt: journal.savedAt, readAt: new Date().toISOString(), draftId: String(plan.id), listEntryId: String(plan.id),
    listUrl: biliListUrl, reopenedId: editor.draftId, reopenedUrl, documentChanged: true,
    lookup: { title: plan.title, videoName: plan.videoName, videoStem: plan.videoStem, beforeIds: plan.beforeIds,
      tagRevision: plan.tagRevision || null, coverRevision: plan.coverRevision || null, videoRevision: plan.videoRevision || null } };
  await js(`window[${JSON.stringify(PERSISTED_DRAFT_KEY)}] = ${JSON.stringify(proof)}`);
  after.gates.persistedDraft = await readBiliPersistenceProof();
  return after;
}

async function quarantineBiliForeignDraft(before) {
  const file = biliQuarantineJournalFile(), identity = biliJournalIdentity();
  let journal = readDraftSaveJournal(file, identity);
  if (before.gates.draftIdentity.ok) {
    return { ...before, quarantine: { safeToUpload: !before.gates.video.ok, skipped: true } };
  }
  if (!journal) {
    const editor = await readBiliEditorIdentity();
    if (!editor.title || !editor.filenames.length) {
      return { ...before, blocker: typedBlocker('STATE_AMBIGUOUS', 'B站旧草稿缺少可绑定的标题或视频文件身份，拒绝自动保存', { evidence: editor }) };
    }
    const entries = await readBiliDraftList();
    const url = await js('location.href');
    const videoName = editor.filenames[0], videoStem = videoName.replace(/\.[^.]+$/, '');
    const plan = { lookupToken: createHash('sha256').update(`${editor.title}\n${videoName}`).digest('hex'),
      title: editor.title, videoName, videoStem, beforeIds: entries.map(biliEntryId).filter(Boolean),
      url, listUrl: biliListUrl, saveLabel: '存草稿', quarantine: true };
    journal = beginDraftSave(file, identity, plan);
    const clicked = await clickDedicatedDraftSelector('span.submit-draft', '存草稿', 'SPAN');
    if (!clicked.ok) {
      return { ...before, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', 'B站隔离旧稿的专用存草稿控件操作未通过；保留日志', { evidence: clicked }) };
    }
  }
  let match = findBiliDraft(await readBiliDraftList(), journal.plan);
  for (let n = 0; n < 30 && !match; n += 1) {
    await wait(1);
    match = findBiliDraft(await readBiliDraftList(), journal.plan);
  }
  if (!match) {
    return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', 'B站旧稿保存结果无法在草稿列表唯一确认；禁止再次保存') };
  }
  if (journal.status === 'intent') {
    journal = confirmDraftSave(file, identity, journal.attemptId, new Date().toISOString(), { id: match.id });
  }
  const guard = await inspectFinalPublishGuard();
  if (!guard.armed || guard.blockedAttempts) {
    return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', 'B站旧稿隔离后的安全守卫未通过') };
  }
  await gotoAndWait(PLATFORM_URLS.bilibili, { timeout: 45, settle: 2 });
  await armFinalPublishGuard();
  await wait(2);
  const after = await inspectBilibili();
  const safe = !after.gates.video.ok && after.gates.draftIdentity.ok;
  return { ...after, quarantine: { safeToUpload: safe, saved: true, draftId: String(journal.plan.id),
    verifiedInNativeList: true }, blocker: safe ? null : typedBlocker('STATE_AMBIGUOUS', 'B站旧草稿经列表验收后没有回到干净上传页', { retryable: true }) };
}
