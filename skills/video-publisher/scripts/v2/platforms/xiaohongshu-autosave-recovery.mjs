function readXhsAutosaveRecoverySource() {
  const source = typeof xhsAutosaveRecoveryContext === 'undefined' ? null : xhsAutosaveRecoveryContext;
  if (!source) return null;
  if (platform !== 'xiaohongshu' || taskSpaceRecovery?.recreated) throw new Error('XHS autosave recovery cannot adopt a recreated task space');
  return validateXhsAutosaveRecoverySource(source, { fingerprint: jobFingerprint,
    taskSpaceId: activeTaskSpace?.id, taskSpaceName: taskName, videoName: xhsVideoName });
}

async function probeXhsAutosaveRecovery() {
  const source = readXhsAutosaveRecoverySource();
  if (!source) return null;
  const native = await js(`(async source => {
    const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let n=e;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false;}return true;};
    const apps=[...document.querySelectorAll('*')].map(e=>e.__vue_app__||e.__vueParentComponent?.appContext?.app).filter(Boolean);
    const pinia=apps.find(a=>a.config?.globalProperties?.$pinia)?.config.globalProperties.$pinia;
    const publisher=pinia?._s.get('publisher'),draft=pinia?._s.get('draft');
    const publication=p=>({noteId:p?.noteId||null,hasBeenPublished:p?.hasBeenPublished===true,hasBeenPublishSuccess:p?.hasBeenPublishSuccess===true});
    const result={uid:pinia?._s.get('user')?.userInfo?.id||null,activeId:publisher?.draftId||null,
      activeVideoFileId:draft?.video?.fileid||'',activeTitle:draft?.title||'',activeDescription:draft?.desc||'',
      isFromDraft:publisher?.isFromDraft===true,publication:publication(publisher),record:null,
      rows:[...document.querySelectorAll('.draft-item[data-draft-type="video"]')].filter(e=>e.dataset.draftId===source.draftId&&visible(e))
        .map(e=>({id:e.dataset.draftId,title:e.querySelector('.draft-title-text')?.textContent.trim()||'',
          editCount:[...e.querySelectorAll('.draft-actions .btn')].filter(b=>visible(b)&&b.innerText.trim()==='编辑').length}))};
    if(!(await indexedDB.databases()).some(d=>d.name==='draft-database-v1'))return result;
    const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('draft-database-v1');q.onupgradeneeded=()=>{q.transaction.abort();reject(new Error('Draft database changed'));};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    try {
      if(!db.objectStoreNames.contains('video-draft'))return result;
      const record=await new Promise((resolve,reject)=>{const q=db.transaction('video-draft','readonly').objectStore('video-draft').get(source.draftId);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
      if(!record)return result;
      const d=record.content?.draftStore||{},s=record.content?.settingStore||{},c=record.content?.contextStore||{};
      result.record={id:record.draftId,uid:record.uid,timeStamp:record.timeStamp,
        publication:publication(record.content?.publisherStore),
        snapshot:{title:d.title||'',description:d.desc||'',descriptionHtml:d.descInnerHTML||'',
          videoFileId:d.video?.fileid||'',transcodeFileId:d.video?.transcodeVideoFileId||'',
          coverFileId:c.coverContext?.cover?.fileid||d.cover?.fileid||'',original:s.original}};
      return result;
    } finally {db.close();}
  })(${JSON.stringify(source)})`);
  return { source, native };
}

function xhsAutosaveRecoveryNativeBlocker(probe) {
  const { source, native } = probe;
  const published=p=>Boolean(p?.noteId)||p?.hasBeenPublished===true||p?.hasBeenPublishSuccess===true;
  if (published(native.publication) || published(native.record?.publication)) return typedBlocker('ALREADY_PUBLISHED', '原小红书视频已存在发布标记；停止恢复');
  if (native.uid !== source.uid || native.record?.uid !== source.uid || native.record.id !== source.draftId
    || native.record.snapshot?.videoFileId !== source.videoFileId || native.record.snapshot?.title !== xhsTitle) {
    return typedBlocker('STATE_AMBIGUOUS', '小红书自动暂存记录与原账号、UUID、视频文件或标题不一致；禁止重新上传', { evidence: probe });
  }
  if (native.activeId !== source.draftId && (native.activeVideoFileId || native.activeTitle || native.activeDescription)) {
    return typedBlocker('FOREIGN_DRAFT', '小红书当前已有其他视频编辑器；保留页面', { evidence: probe });
  }
  if (native.activeId === source.draftId && native.activeVideoFileId && native.activeVideoFileId !== source.videoFileId) {
    return typedBlocker('FOREIGN_DRAFT', '小红书原UUID的视频文件已改变；保留页面', { evidence: probe });
  }
  return null;
}

async function recoverXhsAutosavedUpload() {
  let probe = await probeXhsAutosaveRecovery();
  if (!probe) return null;
  let blocker = xhsAutosaveRecoveryNativeBlocker(probe);
  if (blocker) return { ok: false, blocker };
  const source = probe.source;
  if (probe.native.activeId === source.draftId && probe.native.activeVideoFileId === source.videoFileId
    && probe.native.isFromDraft) return { ok: true, reused: true, source };
  if (!probe.native.rows.length) {
    const opened = await js(`(() => {
      const nodes=[...document.querySelectorAll('.draft-title-box')].filter(e=>e.getBoundingClientRect().width>0&&/^草稿箱/.test(e.innerText));
      if(nodes.length!==1)return false;nodes[0].click();return true;
    })()`);
    if (!opened) return { ok: false, blocker: typedBlocker('STATE_AMBIGUOUS', '小红书原UUID草稿箱入口不可用；禁止重新上传') };
    for (let n=0;n<10;n++) {
      await wait(.5); probe=await probeXhsAutosaveRecovery();
      blocker=xhsAutosaveRecoveryNativeBlocker(probe);
      if(blocker)return {ok:false,blocker};
      if(probe.native.rows.length)break;
    }
  }
  const guard = await inspectFinalPublishGuard();
  if (!guard.armed || guard.blockedAttempts) return {ok:false,blocker:typedBlocker('STATE_AMBIGUOUS','小红书原稿恢复前安全守卫未通过')};
  if (probe.native.rows.length !== 1 || probe.native.rows[0].title !== xhsTitle || probe.native.rows[0].editCount !== 1) {
    return {ok:false,blocker:typedBlocker('STATE_AMBIGUOUS','小红书没有唯一匹配原UUID与标题的编辑入口；禁止重新上传',{evidence:probe})};
  }
  const selected = await js(`(source => {
    const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let n=e;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false;}return true;};
    const rows=[...document.querySelectorAll('.draft-item[data-draft-type="video"]')].filter(e=>e.dataset.draftId===source.draftId&&visible(e));
    if(rows.length!==1||rows[0].querySelector('.draft-title-text')?.textContent.trim()!==source.title)return false;
    const edits=[...rows[0].querySelectorAll('.draft-actions .btn')].filter(e=>visible(e)&&e.innerText.trim()==='编辑');
    if(edits.length!==1)return false;edits[0].click();return true;
  })(${JSON.stringify({draftId:source.draftId,title:xhsTitle})})`);
  if (!selected) return {ok:false,blocker:typedBlocker('STATE_AMBIGUOUS','小红书原UUID编辑入口已变化；禁止重新上传')};
  for (let n=0;n<30;n++) {
    await wait(1); probe=await probeXhsAutosaveRecovery();
    blocker=xhsAutosaveRecoveryNativeBlocker(probe);
    if(blocker)return {ok:false,blocker};
    if(probe.native.activeId===source.draftId&&probe.native.activeVideoFileId===source.videoFileId&&probe.native.isFromDraft){
      await armFinalPublishGuard();
      return {ok:true,reopened:true,source};
    }
  }
  return {ok:false,blocker:typedBlocker('STATE_AMBIGUOUS','小红书原UUID、账号和视频未从草稿箱恢复；禁止重新上传',{evidence:probe})};
}
