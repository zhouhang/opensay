const wechatJournalFile = () => browserDraftSaveJournalFile();
const wechatJournalIdentity = () => ({ platform, fingerprint: jobFingerprint });
const wechatDraftListUrl = 'https://channels.weixin.qq.com/platform/post/draftListManager';

async function findWechatPostComponent() {
  return await js(`(() => {
    const roots = [document, ...[...document.querySelectorAll('*')].map(el => el.shadowRoot).filter(Boolean)];
    const save = roots.flatMap(root => [...root.querySelectorAll('button')])
      .find(el => el.getBoundingClientRect().width > 0 && el.innerText.trim() === '保存草稿');
    let vm = save?.parentElement?.__vue__;
    while (vm && !vm.draftStore) vm = vm.$parent;
    if (!vm?.draftStore) return null;
    return { objectId: vm.draftStore.objectId ? String(vm.draftStore.objectId) : '', hasPost: Boolean(vm.draftStore.post) };
  })()`);
}

async function readWechatDraftList() {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await js(`(async () => {
        const roots = [document, ...[...document.querySelectorAll('*')].map(el => el.shadowRoot).filter(Boolean)];
        const candidates = roots.flatMap(root => [...root.querySelectorAll('*')]).map(el => el.__vue__).filter(Boolean);
        let vm = candidates.find(item => item.draftStore?.getDraftList);
        if (!vm) {
          const save = roots.flatMap(root => [...root.querySelectorAll('button')]).find(el => el.innerText.trim() === '保存草稿');
          vm = save?.parentElement?.__vue__; while (vm && !vm.draftStore) vm = vm.$parent;
        }
        const store = vm?.draftStore;
        const entry = post => ({ objectId: String(post.objectId || ''),
          description: String(post.desc?.description || ''), mediaType: post.mediaType,
          coverUrl: String(post.coverUrl || post.thumbUrl || post.desc?.media?.[0]?.coverUrl || post.desc?.media?.[0]?.thumbUrl || '') });
        if (store?.getDraftList) {
          await store.getDraftList();
          return (store.list || []).map(entry);
        }
        // The current native draft-list component exposes its loaded posts on
        // visible row VMs instead of the old draftStore. Read those objects only;
        // do not invoke its fetch methods or guess an empty-list result.
        const url = new URL(location.href);
        if (url.origin !== 'https://channels.weixin.qq.com'
          || !['/platform/post/draftListManager', '/platform/post/draftListManager/'].includes(url.pathname)) {
          throw new Error('WeChat native draft store unavailable: row readback is restricted to the native draft-list route');
        }
        const visible = el => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          for (let parent = el; parent; parent = parent.parentElement || parent.getRootNode?.()?.host || null) {
            const style = getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false;
          }
          return true;
        };
        const rows = [...new Set(roots.flatMap(root => [...root.querySelectorAll('.post-draft-item')]))].filter(visible);
        const listNodes = roots.flatMap(root => [...root.querySelectorAll('.post-list')]).filter(visible);
        const controllers = new Set(listNodes.map(el => el.__vue__).filter(Boolean));
        for (const row of rows) {
          for (let controller = row.__vue__, depth = 0; controller && depth < 12; controller = controller.$parent, depth++) {
            controllers.add(controller);
          }
        }
        const nativeLists = [...controllers].filter(controller => typeof controller.listLoading === 'boolean'
          && typeof controller.getFetchTaskList === 'function' && typeof controller.goToPost === 'function');
        if (nativeLists.length !== 1 || nativeLists[0].listLoading !== false) {
          throw new Error('WeChat native draft store unavailable: native row list has no unique finished-loading controller');
        }
        if (!rows.length) throw new Error('WeChat native draft store unavailable: no visible native rows; empty-list truth is unproven');
        const entries = rows.map(row => {
          const post = row.__vue__?.post;
          if (!post || !String(post.objectId || '').trim()) throw new Error('WeChat native draft row has no nonempty native objectId');
          return { ...entry(post), readbackSource: 'visible-native-post-draft-item',
            nativeListUrl: url.href, listLoading: false };
        });
        if (new Set(entries.map(item => item.objectId)).size !== entries.length) {
          throw new Error('WeChat native draft rows have duplicate objectIds; list identity is ambiguous');
        }
        return entries;
      })()`);
    } catch (error) {
      lastError = error;
      if (!String(error?.message || error).includes('WeChat native draft store unavailable')) throw error;
      await wait(0.5);
    }
  }
  throw lastError || new Error('WeChat native draft store unavailable');
}

async function readWechatRestoredIdentity() {
  const coverRevision = readBrowserCoverRevisionSource();
  const videoRevision = typeof readBrowserVideoRevisionSource === 'function' ? readBrowserVideoRevisionSource() : null;
  const revision = videoRevision || readBrowserTagRevisionSource() || coverRevision;
  const journal = readDraftSaveJournal(wechatJournalFile(), wechatJournalIdentity());
  const current = await findWechatPostComponent();
  const existingDraft = Boolean(current?.objectId);
  if (revision) {
    const id = revision.sourceDraftId;
    return { ok: existingDraft && current.objectId === id && (!journal?.plan?.id || String(journal.plan.id) === id),
      existingDraft, actualId: current?.objectId || null, draftId: id, ...(revision === videoRevision ? { videoRevision: true } : revision === coverRevision ? { coverRevision: true } : { tagRevision: true }) };
  }
  if (journal?.status !== 'confirmed' || !journal.plan.id) return { ok: false, existingDraft, actualId: current?.objectId || null };
  return { ok: existingDraft && current.objectId === String(journal.plan.id), existingDraft,
    actualId: current?.objectId || null, draftId: String(journal.plan.id) };
}

function findWechatDraft(entries, plan) {
  const matches = entries.filter(entry => entry.objectId
    && (!plan.id || entry.objectId === String(plan.id))
    && (plan.id || !plan.beforeIds.includes(entry.objectId))
    && compactText(entry.description) === compactText(plan.description));
  return matches.length === 1 ? matches[0] : null;
}

function wechatRevisionCreatedCopies(entries, plan) {
  if (!plan.tagRevision && !plan.coverRevision && !plan.videoRevision) return [];
  return entries.filter(entry => findWechatDraft([entry], { ...plan, id: undefined }))
    .map(entry => entry.objectId);
}

async function readWechatPersistenceProof() {
  const proof = await js(`window[${JSON.stringify(PERSISTED_DRAFT_KEY)}] || null`);
  if (!proof || proof.verificationRunId !== verificationRunId || proof.fingerprint !== jobFingerprint || proof.platform !== platform) {
    return failedGate({ reason: 'No current WeChat draft reopen proof' });
  }
  const [current, entries, url] = await Promise.all([findWechatPostComponent(), readWechatDraftList(), js('location.href')]);
  const createdCopies = wechatRevisionCreatedCopies(entries, proof.lookup);
  if (createdCopies.length) return failedGate({ reason: 'Revision created additional native draft IDs', createdCopies });
  const match = findWechatDraft(entries, { ...proof.lookup, id: proof.draftId });
  return current?.objectId === proof.draftId && match?.objectId === proof.draftId && url === proof.reopenedUrl
    ? okGate({ ...proof, readAt: new Date().toISOString() })
    : failedGate({ reason: 'WeChat draft list or reopened editor no longer matches', current, url });
}

async function clickWechatDraftFromList(id) {
  const point = await js(`(id => {
    const roots = [document, ...[...document.querySelectorAll('*')].map(el => el.shadowRoot).filter(Boolean)];
    const all = roots.flatMap(root => [...root.querySelectorAll('*')]);
    const bound = all.filter(el => String(el.__vue__?.post?.objectId || '') === id);
    const legacy = roots.flatMap(root => [...root.querySelectorAll('.post-draft-item')]);
    const rows = [...new Set([...bound, ...legacy])].filter(el => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        && (String(el.__vue__?.post?.objectId || '') === id || [...el.querySelectorAll('*')].some(child => String(child.__vue__?.post?.objectId || '') === id));
    });
    const candidates = rows.flatMap(row => [row, row.parentElement, row.parentElement?.parentElement].filter(Boolean).map(container => ({row,container})))
      .filter(({container}) => { const r=container.getBoundingClientRect(); return r.width>80&&r.height>30&&r.height<600; });
    const edits = candidates.flatMap(({row,container}) => [...container.querySelectorAll('.opr .opr-item,button,[role="button"],[title*="编辑"],[aria-label*="编辑"]')].map(el=>({row,container,el}))).filter(({el}) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (el.querySelector('[name="edit"], .icon-edit') || /编辑/.test(el.innerText || ''));
    });
    const unique=[...new Map(edits.map(item=>[item.el,item])).values()].sort((a,b)=>{const ar=a.container.getBoundingClientRect(),br=b.container.getBoundingClientRect();return ar.width*ar.height-br.width*br.height});
    if (unique.length < 1) return { ok: false, count: 0, boundCount: bound.length, rowCount: rows.length,
      samples: bound.slice(0,4).map(el=>({className:String(el.className||''),text:String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,240),html:el.outerHTML.slice(0,1200)})) };
    const rect = unique[0].el.getBoundingClientRect(),root=unique[0].el.getRootNode(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
    const hit=typeof root.elementFromPoint==='function'?root.elementFromPoint(x,y):document.elementFromPoint(x,y);
    if(!hit||!(hit===unique[0].el||unique[0].el.contains(hit)))return{ok:false,count:unique.length,boundCount:bound.length,rowCount:rows.length,reason:'wechat draft edit hit target obscured'};
    return { ok: true, x, y, boundCount:bound.length,rowCount:rows.length };
  })(${JSON.stringify(String(id))})`);
  if (!point.ok) return point;
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return { ok: true };
}

async function persistWechatDraft(inspect) {
  const coverRevision = readBrowserCoverRevisionSource();
  const videoRevision = typeof readBrowserVideoRevisionSource === 'function' ? readBrowserVideoRevisionSource() : null;
  const revision = videoRevision || readBrowserTagRevisionSource() || coverRevision;
  const file = wechatJournalFile(), identity = wechatJournalIdentity();
  let journal = readDraftSaveJournal(file, identity);
  if (revision && journal?.plan?.id && String(journal.plan.id) !== revision.sourceDraftId) {
    return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号修订日志不属于原草稿 ID') };
  }
  if (journal?.status === 'intent' && !journal.plan.tagRevision && !journal.plan.coverRevision && !journal.plan.videoRevision) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号上次保存结果不确定；核对草稿列表前禁止再次保存') };
  if (!journal) {
    const before = await inspect();
    const missing = Object.entries(before.gates).filter(([key, gate]) => key !== 'persistedDraft' && !gate.ok).map(([key]) => key);
    if (before.blocker || missing.length) return { ...before, blocker: before.blocker || typedBlocker('PERSISTENCE_UNVERIFIED', '视频号保存前字段校验未通过', { evidence: { missing } }) };
    const current = await findWechatPostComponent();
    if (!current || (revision ? current.objectId !== revision.sourceDraftId : Boolean(current.objectId))) {
      return { ...before, blocker: typedBlocker('STATE_AMBIGUOUS', '视频号当前编辑器已绑定未授权草稿或原生 store 不可用',
        { evidence: { current, sourceDraftId: revision?.sourceDraftId || null } }) };
    }
    const entries = await readWechatDraftList();
    if (revision && !findWechatDraft(entries, { id: revision.sourceDraftId,
      description: revision.sourcePersistedDraft.lookup?.description, beforeIds: [] })) {
      return { ...before, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号原草稿 ID 在原生列表中没有唯一匹配原描述的记录') };
    }
    const url = await js('location.href');
    const plan = { lookupToken: createHash('sha256').update(wechatDescription).digest('hex'), description: wechatDescription,
      beforeIds: entries.map(entry => entry.objectId).filter(Boolean), url, listUrl: wechatDraftListUrl, saveLabel: '保存草稿',
      ...(revision ? { id: revision.sourceDraftId,
        [revision === videoRevision ? 'videoRevision' : revision === coverRevision ? 'coverRevision' : 'tagRevision']: revision === videoRevision ? browserVideoRevisionPlan(revision) : browserTagRevisionPlan(revision) } : {}) };
    journal = beginDraftSave(file, identity, plan);
    const clicked = await clickDedicatedDraftButton(['保存草稿']);
    if (!clicked.ok) return { ...before, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号专用保存控件操作未通过；保留日志', { evidence: clicked }) };
    let match, saved;
    for (let n = 0; n < 30 && !match; n++) {
      await wait(1); saved = await findWechatPostComponent();
      if ((plan.tagRevision || plan.coverRevision || plan.videoRevision) && saved?.objectId && saved.objectId !== String(plan.id)) {
        return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号保存返回了不同草稿 ID；保留原稿保存意图，禁止接受新增记录', { evidence: { sourceDraftId: plan.id, savedId: saved.objectId } }) };
      }
      if (saved?.objectId) {
        const entries = await readWechatDraftList();
        const createdCopies = wechatRevisionCreatedCopies(entries, plan);
        if (createdCopies.length) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号原稿修订出现同内容的新增草稿 ID；保留保存意图，禁止接受副本', { evidence: { createdCopies } }) };
        match = findWechatDraft(entries, { ...plan, id: saved.objectId });
      }
    }
    if (!saved?.objectId || match?.objectId !== saved.objectId) {
      return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号未读到保存后的 objectId 和唯一列表记录；禁止重复保存') };
    }
    if (!plan.tagRevision && !plan.coverRevision && !plan.videoRevision) journal = confirmDraftSave(file, identity, journal.attemptId, new Date().toISOString(), { id: saved.objectId });
  }
  const plan = journal.plan;
  const entries = await readWechatDraftList();
  const createdCopies = wechatRevisionCreatedCopies(entries, plan);
  if (createdCopies.length) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号原稿修订出现同内容的新增草稿 ID；禁止重复保存或接受副本', { evidence: { createdCopies } }) };
  if (!findWechatDraft(entries, plan)) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号草稿列表中没有唯一匹配记录') };
  const guard = await inspectFinalPublishGuard();
  if (!guard.armed || guard.blockedAttempts) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号重开前安全守卫未通过') };
  const documentToken = `${verificationRunId}:wechat-before-reopen`;
  await js(`window.__publisherDocumentToken = ${JSON.stringify(documentToken)}`);
  await gotoAndWait(plan.listUrl, { timeout: 45, settle: 2 });
  const changed = await js(`window.__publisherDocumentToken !== ${JSON.stringify(documentToken)}`);
  if (!changed) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号未进入新的草稿列表页面') };
  let listed = false;
  for (let n = 0; n < 30; n++) { listed = Boolean(findWechatDraft(await readWechatDraftList(), plan)); if (listed) break; await wait(1); }
  if (!listed) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号新页面未读到同一草稿 ID') };
  const clicked = await clickWechatDraftFromList(plan.id);
  if (!clicked.ok) return { gates: {}, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号草稿列表中没有唯一原生编辑项', { evidence: clicked }) };
  let current;
  for (let n = 0; n < 30; n++) { await wait(1); current = await findWechatPostComponent(); if (current?.objectId === String(plan.id)) break; }
  await armFinalPublishGuard();
  if (current?.objectId !== String(plan.id)) return { ...(await inspect()), blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号未重开同一草稿 ID') };
  let after = await inspect();
  // objectId is assigned before initDefaultFileList finishes restoring media
  // and cover cards. Observing it alone is not editor-readiness evidence.
  // Recovery remains read-only: wait in this same reopened original draft.
  const restoreDeadline=Date.now()+90000;
  const restoring=state=>state.evidence?.initToast===true||state.gates.video?.ok===false||state.gates.cover?.ok===false;
  for(let n=0;n<90&&restoring(after);n++){
    if(after.blocker||after.gates.authenticated?.ok===false||Date.now()>=restoreDeadline)break;
    await wait(1);
    const restored=await findWechatPostComponent();
    if(restored?.objectId!==String(plan.id))return {...after,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','视频号初始化期间原草稿 objectId 发生变化；禁止保存或重传')};
    after=await inspect();
  }
  const missing = Object.entries(after.gates).filter(([key, gate]) => key !== 'persistedDraft' && !gate.ok).map(([key]) => key);
  if (after.blocker || missing.length) return { ...after, blocker: after.blocker || typedBlocker('PERSISTENCE_UNVERIFIED',
    plan.tagRevision || plan.coverRevision || plan.videoRevision
      ? '视频号原草稿重开后的修订字段不一致；保留保存意图，禁止重复保存'
      : '视频号原草稿重开后的业务字段尚未恢复；禁止重复保存或重传', { evidence: { missing } }) };
  if (plan.tagRevision || plan.coverRevision || plan.videoRevision) {
    const createdCopies = wechatRevisionCreatedCopies(await readWechatDraftList(), plan);
    if (createdCopies.length) return { ...after, blocker: typedBlocker('PERSISTENCE_UNVERIFIED', '视频号原稿修订重开后出现同内容的新增草稿 ID；保留保存意图', { evidence: { createdCopies } }) };
    if (journal.status === 'intent') journal = confirmDraftSave(file, identity, journal.attemptId, new Date().toISOString());
  }
  const reopenedUrl = await js('location.href');
  const proof = { version: 2, method: 'draft-list-reopen', platform, fingerprint: jobFingerprint, verificationRunId,
    savedAt: journal.savedAt, readAt: new Date().toISOString(), draftId: String(plan.id), listEntryId: String(plan.id),
    listUrl: plan.listUrl, reopenedId: current.objectId, reopenedUrl, documentChanged: true,
    lookup: { description: plan.description, beforeIds: plan.beforeIds, tagRevision: plan.tagRevision || null, coverRevision: plan.coverRevision || null, videoRevision: plan.videoRevision || null } };
  await js(`window[${JSON.stringify(PERSISTED_DRAFT_KEY)}] = ${JSON.stringify(proof)}`);
  after.gates.persistedDraft = await readWechatPersistenceProof();
  return after;
}
