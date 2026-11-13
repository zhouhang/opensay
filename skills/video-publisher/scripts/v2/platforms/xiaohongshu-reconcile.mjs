// Loaded only by the maintained XHS adapter. No video or business-field mutation.
function readXhsReconcileContext() {
  const r = typeof xhsReconcileContext === 'undefined' ? null : xhsReconcileContext;
  if (!r) return null;
  if (platform !== 'xiaohongshu' || !explicitXhsReconcileAuthorization(r, 'reconcile-xhs-original', phase)
    || r.sourceFingerprint !== jobFingerprint || r.sourceTaskSpaceName !== taskName) throw new Error('Invalid explicit XHS original-reconcile authority');
  return r;
}

async function openXhsReconcileOriginal() {
  const r = readXhsReconcileContext();
  if (!r || phase !== 'persist') return;
  let current = await readXhsNativeDraft(r.sourceDraftId);
  const published = xhsNativePublicationBlocker(current);
  if (published) throw new Error('Native original resource is already published');
  if (current.available) {
    if (current.uid !== r.sourceUid || current.id !== r.sourceDraftId
      && (current.live?.videoFileId || current.live?.title || current.live?.description)) throw new Error('Foreign live editor; reconciliation will not navigate or overwrite it');
    if (current.isFromDraft) return;
  }
  await gotoAndWait(PLATFORM_URLS.xiaohongshu, { timeout: 45, settle: 2 });
  await armFinalPublishGuard();
  const stored = await js(`(async r => {
    const apps=[...document.querySelectorAll('*')].map(e=>e.__vue_app__||e.__vueParentComponent?.appContext?.app).filter(Boolean);
    const pinia=apps.find(a=>a.config?.globalProperties?.$pinia)?.config.globalProperties.$pinia;
    const uid=pinia?._s.get('user')?.userInfo?.id;
    if(uid!==r.sourceUid)return {ok:false,reason:'account mismatch'};
    if(!(await indexedDB.databases()).some(db=>db.name==='draft-database-v1'))return {ok:false,reason:'original local database missing'};
    const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('draft-database-v1');q.onupgradeneeded=()=>{q.transaction.abort();reject(new Error('database changed'));};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    try {const record=await new Promise((resolve,reject)=>{const q=db.transaction('video-draft','readonly').objectStore('video-draft').get(r.sourceDraftId);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
      const p=record?.content?.publisherStore||{};
      return {ok:record?.uid===r.sourceUid&&record.draftId===r.sourceDraftId&&record.content?.draftStore?.video?.fileid===r.sourceVideoFileId,
        published:Boolean(p.noteId)||p.hasBeenPublished===true||p.hasBeenPublishSuccess===true};
    }finally{db.close();}
  })(${JSON.stringify(r)})`);
  if (!stored.ok || stored.published) throw new Error('Exact authorized local account/UUID/video record missing or published');
  let opened = false;
  for (let n=0;n<15&&!opened;n++) {
    opened=await js(`(()=>{const e=[...document.querySelectorAll('.draft-title-box')].filter(e=>e.getBoundingClientRect().width>0&&/^草稿箱/.test(e.innerText));if(e.length!==1)return false;e[0].click();return true;})()`);
    if(!opened)await wait(1);
  }
  if(!opened)throw new Error('Native draft-list entry unavailable');
  const selected=await js(`(id=>{const rows=[...document.querySelectorAll('.draft-item[data-draft-type="video"]')].filter(e=>e.dataset.draftId===id&&e.getBoundingClientRect().width>0);if(rows.length!==1)return false;const edits=[...rows[0].querySelectorAll('.draft-actions .btn')].filter(e=>e.innerText.trim()==='编辑'&&e.getBoundingClientRect().width>0);if(edits.length!==1)return false;edits[0].click();return true;})(${JSON.stringify(r.sourceDraftId)})`);
  if(!selected)throw new Error('Original UUID has no unique native edit control');
  for(let n=0;n<30;n++) {
    await wait(1);current=await readXhsNativeDraft(r.sourceDraftId);
    if(xhsNativePublicationBlocker(current))throw new Error('Original resource published while reopening');
    if(current.available&&current.isFromDraft&&current.id===r.sourceDraftId&&current.uid===r.sourceUid)break;
  }
  await armFinalPublishGuard();
  if(!current.available||!current.isFromDraft||current.id!==r.sourceDraftId||current.uid!==r.sourceUid)throw new Error('Native original UUID did not reopen');
}

async function reconcileXhsConfirmedJournal(native, inspection, journal, file, identity) {
  const r=readXhsReconcileContext();
  if(!r||phase!=='persist'||journal.status!=='confirmed')throw new Error('Only explicitly authorized confirmed-original reconciliation can restart saving');
  const deadline=Date.now()+30000;let checked;
  for(let attempt=0;attempt<20;attempt++) {
    const guard=await inspectFinalPublishGuard();
    inspection={...inspection,gates:{...inspection.gates,safety:{ok:guard.armed===true&&guard.blockedAttempts===0,
      evidence:{guardArmed:guard.armed===true,blockedAttempts:guard.blockedAttempts||0,finalPublishClicked:false}}}};
    try{checked=validateXhsReconcileNative(native,inspection,r);break;}
    catch(error){
      // Restored Pinia identity can precede the visible editor by a render tick.
      // Wait only for full business gates, never a different identity or a published resource.
      if(!String(error?.message||error).includes('original package gates are not verified')
        ||Date.now()>=deadline||attempt===19)throw error;
    }
    await wait(1);native=await readXhsNativeDraft(r.sourceDraftId);inspection=await inspectXiaohongshu();
  }
  if(!r.userAuthorization?.manifestPath||r.originalJournalSha256!==createHash('sha256').update(fs.readFileSync(file)).digest('hex'))throw new Error('Original journal changed before native reconciliation');
  const archived=archiveXhsOriginalJournal(file,r.originalJournalArchivePath,r.originalJournalSha256);
  const evidence={version:1,kind:'actual-original-native-revalidation',at:new Date().toISOString(),
    verificationRunId,taskSpaceId:activeTaskSpace.id,sourceJournal:archived,
    humanAuthorization:{path:r.userAuthorization.manifestPath,sha256:r.userAuthorization.manifestSha256,nativePublicationStatusProof:false},
    ...checked,recordSnapshot:native.record.snapshot,liveSnapshot:native.live,
    publication:native.publication,gates:inspection.gates};
  const body=JSON.stringify(evidence,null,2)+'\n';
  if(fs.existsSync(r.recoveryEvidencePath))throw new Error('Revalidation evidence already exists; inspect the pending same attempt');
  const fd=fs.openSync(r.recoveryEvidencePath,'wx',0o600);try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const directory=fs.openSync(path.dirname(r.recoveryEvidencePath),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
  return restartConfirmedDraftSave(file,identity,{...journal.plan,snapshotHash:checked.snapshotHash,
    createdVerificationRunId:verificationRunId,previousTimestamp:native.record.timeStamp||0,
    recoveryEvidence:{...checked,kind:evidence.kind,evidencePath:r.recoveryEvidencePath,
      evidenceSha256:createHash('sha256').update(body).digest('hex'),originalJournalArchivePath:archived.path,
      originalJournalSha256:archived.sha256,authorizationManifestSha256:r.userAuthorization.manifestSha256}},
    'Explicit human-attested unpublished same-original revalidation; original journal archived byte-for-byte');
}
