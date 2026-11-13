const draftPersistenceContract = { idKeys: [], saveLabels: ['保存草稿'], listLabels: ['草稿箱'] };
const inspectPersistedPlatform = () => inspectWechatChannels();
const wechatDescription = pkg.wechatDescription;
const wechatSettings = pkg.platformSettings?.wechat_channels || {};
const wechatShortTitle = String(wechatSettings.shortTitle || '').trim();
const wechatAiGenerated = wechatSettings.aiGenerated === true;

function wechatShortTitleGate(state) {
  const actual = String(state.shortTitle || '').trim();
  const evidence = { expected: wechatShortTitle, actual, found: state.shortTitleFound === true };
  return actual === wechatShortTitle && (!wechatShortTitle || evidence.found)
    ? okGate(evidence) : failedGate(evidence);
}

function wechatAiGeneratedGate(state) {
  if (!wechatAiGenerated) return okGate({ requested: false, skipped: true });
  return state.aiGenerated === true
    ? okGate({ requested: true, enabled: true, ...(state.aiGeneratedEvidence || {}) })
    : failedGate({ requested: true, enabled: state.aiGenerated === true,
      reason: 'AI生成标注尚未由视频号页面控件独立确认', ...(state.aiGeneratedEvidence || {}) });
}
const wechatCustomCover = pkg.cover?.uploadCustomCover === true;
const wechatCoverAssets = [
  {slot:'vertical',ratio:'3:4',path:String(pkg.cover?.vertical3x4Path||''),wrap:'.vertical-cover-wrap',image:'img.vertical-img-size',dialogTitle:'编辑个人主页卡片'},
  {slot:'horizontal',ratio:'4:3',path:String(pkg.cover?.horizontal4x3Path||''),wrap:'.horizon-cover-wrap',image:'img.horizon-img-size',dialogTitle:'编辑分享卡片'},
];

function wechatCoverManifestPath(asset) {
  if (asset.slot === 'vertical') return String(typeof wechatVerticalCoverTransportManifestPath !== 'undefined'
    ? wechatVerticalCoverTransportManifestPath
    : typeof process !== 'undefined' ? process.env?.VIDEO_PUBLISHER_WECHAT_VERTICAL_COVER_TRANSPORT_MANIFEST || '' : '');
  return String(typeof wechatHorizontalCoverTransportManifestPath !== 'undefined'
    ? wechatHorizontalCoverTransportManifestPath
    : typeof process !== 'undefined' ? process.env?.VIDEO_PUBLISHER_WECHAT_HORIZONTAL_COVER_TRANSPORT_MANIFEST || '' : '');
}

function readWechatCoverAsset(asset) {
  try {
    const manifestPath = wechatCoverManifestPath(asset);
    const transportPlan = manifestPath ? readExplicitLosslessPngTransport({ manifestPath,
      sourcePath: asset.path, ratio: asset.ratio, reason: 'wechat-channels-native-webp-rejection' })
      : { ok: true, uploadPath: asset.path, transport: null };
    if (!transportPlan.ok) return { ok: false, reason: `wechat ${asset.slot} ${transportPlan.reason}` };
    const bytes = fs.readFileSync(asset.path);
    return { ok: true, assetPath: asset.path, assetHash: createHash('sha256').update(bytes).digest('hex'),
      uploadPath: transportPlan.uploadPath, transport: transportPlan.transport };
  } catch { return { ok: false, reason: `wechat ${asset.slot} approved cover image cannot be read` }; }
}

function wechatCoverTransportMatches(asset, expected) {
  const manifestPath = wechatCoverManifestPath(asset);
  if (!manifestPath) return !expected;
  return explicitCoverTransportMatches(expected, { manifestPath,
    sourcePath: asset.path, ratio: asset.ratio, reason: 'wechat-channels-native-webp-rejection' });
}

function wechatCoverReceiptTransportMatches(asset, receipt) {
  const manifestPath = wechatCoverManifestPath(asset);
  if (!manifestPath && !receipt?.transport) return true;
  const approved = readWechatCoverAsset(asset);
  return approved.ok === true && receipt?.assetHash === approved.assetHash
    && wechatCoverTransportMatches(asset, receipt.transport || null);
}

function classifyWechatUploadText(text=''){
  const value=String(text||'').replace(/\s+/g,' ').trim();
  const failureText=value.match(/上传失败|网络(?:错误|出错)|文件格式不支持/)?.[0]||null;
  const failed=Boolean(failureText);
  // A failed upload can retain stale progress copy and generated cover cards.
  // Explicit failure always wins over those incomplete/completion signals.
  const uploading=!failed&&/上传中|正在上传|正在处理文件|处理中|生成中|剩余时间|上传进度|取消上传|(?:^|\s)\d{1,3}%(?:\s|$)/.test(value);
  const coverCards=/封面预览/.test(value)&&/个人主页卡片|分享卡片/.test(value);
  return {uploaded:coverCards&&!uploading&&!failed,uploading,failed,failureText};
}

function wechatUploadFailureBlocker(state={}){
  if(state.failed!==true)return null;
  return typedBlocker('PLATFORM_REJECTED_ASSET','视频号视频上传失败：'+(state.failureText||'平台明确报告上传失败'),{
    retryable:true,evidence:{failed:true,uploaded:false,uploading:false,failureText:state.failureText||null,stage:'video_upload'},
  });
}

function collectWechatFailureControls(roots,text=''){
  const failurePattern=/网络出错[，,]?\s*请重新上传[。.]?|上传失败|网络错误|文件格式不支持/;
  if(!failurePattern.test(String(text||'')))return {present:false,panels:[]};
  const compact=value=>String(value||'').replace(/\s+/g,' ').trim();
  const visible=el=>{
    if(!el?.getBoundingClientRect)return false;
    const rect=el.getBoundingClientRect();if(rect.width<4||rect.height<4)return false;
    let node=el;
    while(node?.nodeType===1){const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity||1)===0)return false;node=node.parentElement||node.getRootNode?.().host;}
    return true;
  };
  const rectOf=el=>{const r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}};
  const safeHtml=el=>String(el.outerHTML||'')
    .replace(/\s(?:src|srcset|href|poster|style|value|token|auth|authorization|cookie|access[_-]?token|data-[\w:-]+|on[\w:-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,' [attribute-redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi,'[url-redacted]').slice(0,1800);
  const signature=el=>({tag:el.tagName,class:String(el.className||''),text:compact(el.innerText||el.textContent||'').slice(0,160)});
  const retryText=/^(?:重新上传|重试|删除|取消上传)$/;
  const selector='button,[role="button"],a,input[type="button"],input[type="submit"],[class*="btn"],[class*="button"],[class*="retry"],[class*="delete"],[class*="remove"],[class*="cancel"]';
  const controlsIn=panel=>[...new Set([...panel.querySelectorAll(selector),...[...panel.querySelectorAll('div,span')].filter(el=>retryText.test(compact(el.innerText||el.textContent||'')))])].filter(visible);
  const anchors=roots.flatMap(root=>[...root.querySelectorAll('*')]).filter(el=>visible(el)&&failurePattern.test(compact(el.innerText||el.textContent||''))&&![...el.children].some(child=>failurePattern.test(compact(child.innerText||child.textContent||'')))).slice(0,3);
  const seen=new Set(),panels=[];
  for(const anchor of anchors){
    let panel=anchor;const ancestors=[];
    for(let depth=0,node=anchor;node&&depth<=6;depth+=1,node=node.parentElement){
      const sample=compact(node.innerText||node.textContent||'');
      if(sample.length>1800||/视频描述|保存草稿|定时发表/.test(sample))break;
      const controls=controlsIn(node),inputs=[...node.querySelectorAll('input[type="file"]')];
      ancestors.push({...signature(node),depth,rect:rectOf(node),visibleControlCount:controls.length,fileInputCount:inputs.length});
      panel=node;
      if(controls.length||inputs.length)break;
    }
    if(seen.has(panel))continue;seen.add(panel);
    const controls=controlsIn(panel).slice(0,24).map(el=>{
      const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
      const root=el.getRootNode?.();const hit=(typeof root?.elementFromPoint==='function'?root.elementFromPoint(x,y):document.elementFromPoint(x,y));
      return {...signature(el),disabled:el.disabled===true||el.getAttribute('aria-disabled')==='true',rect:rectOf(el),outerHTML:safeHtml(el),hit:hit?signature(hit):null,hitWithinControl:Boolean(hit&&(hit===el||el.contains(hit)))};
    });
    const inputs=[...panel.querySelectorAll('input[type="file"]')].map(el=>({accept:String(el.accept||''),disabled:el.disabled===true,filesCount:el.files?.length||0,visible:visible(el),outerHTML:safeHtml(el)}));
    panels.push({anchor:signature(anchor),panel:signature(panel),rect:rectOf(panel),ancestors,controls,inputs});
  }
  return {present:true,panels,scope:'nearest bounded failure panel; excludes editor-wide controls',reason:panels.length?null:'No bounded visible failure panel found'};
}

function classifyWechatPageShell({text='',url='',rootCount=0,editorMarkers={},loginTextMatched,loadFailed}={}){
  const markers={
    wujieRoot:editorMarkers.wujieRoot===true,
    videoInput:editorMarkers.videoInput===true,
    descriptionEditor:editorMarkers.descriptionEditor===true,
    shortTitleInput:editorMarkers.shortTitleInput===true,
    coverCard:editorMarkers.coverCard===true,
    originalControl:editorMarkers.originalControl===true,
  };
  const editorMarkersPresent=Object.values(markers).some(Boolean);
  const matchedLoginText=loginTextMatched===undefined
    ? /登录视频号助手|扫码登录|请登录|登录后|安全验证|验证码/.test(String(text||''))
    : loginTextMatched===true;
  const matchedLoadFailure=loadFailed===undefined
    ? /加载失败(?:[，,、]\s*)?(?:请)?点击重试/.test(String(text||''))
    : loadFailed===true;
  return {
    login:{required:matchedLoginText&&!editorMarkersPresent,textMatched:matchedLoginText,editorMarkersPresent,editorMarkers:markers},
    load:{failed:matchedLoadFailure,textMatched:matchedLoadFailure},
    rootCount:Number(rootCount)||0,
    url:String(url||''),
  };
}

function wechatPageShellBlocker(shell){
  const evidence={login:shell.login,load:shell.load,rootCount:shell.rootCount,url:shell.url};
  if(shell.login?.required)return typedBlocker('AUTH_REQUIRED','视频号需要登录',{requiresUser:true,evidence});
  if(shell.load?.failed)return typedBlocker('RISK_CONTROL','视频号创作页加载失败',{retryable:true,evidence});
  return null;
}

async function inspectWechatChannels() {
  const uploadStartReceipt=expectedReceipts.uploadStart||null;
  const trustedVideoReceipt=Boolean(
    (expectedVideoReceipt?.fingerprint===jobFingerprint
      && Number(expectedVideoReceipt?.taskSpaceId)===Number(activeTaskSpace?.id)
      && ['injected','resume_existing'].includes(expectedVideoReceipt?.mode))
    || (uploadStartReceipt?.fingerprint===jobFingerprint
      && Number(uploadStartReceipt?.taskSpaceId)===Number(activeTaskSpace?.id)
      && ['injected','resume_existing'].includes(uploadStartReceipt?.mode))
  );
  const state=await js(String.raw`((expectedDescription, trustedVideoReceipt) => {
    const compact=v=>String(v||'').replace(/\s+/g,' ').trim();const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'};const text=compact(roots.map(root=>root.body?.innerText||root.host?.innerText||'').join('\n'));
    const descEditors=roots.flatMap(root=>[...root.querySelectorAll('[contenteditable="true"],[contenteditable=""],textarea')]).filter(visible).filter(el=>/input-editor|视频描述|editor/i.test(String(el.className||''))&&!/chatInput/.test(String(el.className||'')));
    const description=compact(descEditors[0]?.innerText||descEditors[0]?.value||descEditors[0]?.textContent||'');
    const shortInput=roots.flatMap(root=>[...root.querySelectorAll('input')]).find(el=>visible(el)&&(el.placeholder||'').includes('短标题'));const shortTitle=String(shortInput?.value||'').trim();
    const markSelects=roots.flatMap(root=>[...root.querySelectorAll('.mark-tag-select')]).filter(visible);const markSelect=markSelects.length===1?markSelects[0]:null;const markDisplay=markSelect?.querySelector('.select-display');const markSelected=compact(markDisplay?.innerText||markDisplay?.textContent||'');const markOptions=[...(markSelect?.querySelectorAll('.mark-tag-option .option-main')||[])].map(el=>({label:compact(el.innerText||el.textContent||''),visible:visible(el)})).filter(item=>item.label);const aiGenerated=markSelected==='含AI生成内容';const aiGeneratedEvidence={requested:false, actual:markSelected, options:markOptions.map(item=>item.label), selector:'.mark-tag-select .select-display', found:markSelects.length===1};
    const initToast=/页面初始化中/.test(text);const {uploaded,uploading,failed,failureText}=(${classifyWechatUploadText.toString()})(text);const failureControls=failed?(${collectWechatFailureControls.toString()})(roots,text):{present:false,panels:[]};
    const loginTextMatched=/登录视频号助手|扫码登录|请登录|登录后|安全验证|验证码/.test(text);const loadFailed=/加载失败(?:[，,、]\s*)?(?:请)?点击重试/.test(text);const identityMatches=!uploaded||description===compact(expectedDescription)||trustedVideoReceipt;const identityAmbiguous=uploaded&&!description&&!trustedVideoReceipt;const identityForeign=uploaded&&!identityMatches&&!identityAmbiguous;
    const originalInput=roots.flatMap(root=>[...root.querySelectorAll('.declare-original-checkbox input[type="checkbox"],.form-item.post-with-link input.ant-checkbox-input')]).find(visible);const originalEnabled=Boolean(originalInput?.checked||/checked|active/.test(String(originalInput?.closest('.ant-checkbox')?.className||'')));
    const verticalWrap=roots.flatMap(root=>[...root.querySelectorAll('.vertical-cover-wrap')]).find(visible),horizontalWrap=roots.flatMap(root=>[...root.querySelectorAll('.horizon-cover-wrap')]).find(visible);const combinedCover=Boolean(verticalWrap&&!horizontalWrap&&/个人主页和分享卡片\s*\(3:4\)/.test(compact(verticalWrap.parentElement?.innerText||verticalWrap.parentElement?.textContent||'')));
    const coverUrlsBySlot={vertical:roots.flatMap(root=>[...root.querySelectorAll('.vertical-cover-wrap img.vertical-img-size')]).map(el=>el.currentSrc||el.src||'').filter(Boolean),horizontal:roots.flatMap(root=>[...root.querySelectorAll('.horizon-cover-wrap img.horizon-img-size')]).map(el=>el.currentSrc||el.src||'').filter(Boolean)};const coverUrls=[...new Set([...coverUrlsBySlot.vertical,...coverUrlsBySlot.horizontal])];
    const dialogs=roots.flatMap(root=>[...root.querySelectorAll('[role="dialog"],[class*="modal"],.weui-desktop-dialog__wrp,[class*="dialog-mask"]')]).map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {text:compact(el.innerText||el.textContent||'').slice(0,500),cls:String(el.className||''),w:r.width,h:r.height,display:s.display,visibility:s.visibility,opacity:s.opacity}}).filter(item=>item.w>20&&item.h>20&&item.display!=='none'&&item.visibility!=='hidden'&&!/popover/i.test(item.cls)&&!(/leave-active/.test(item.cls)&&Number(item.opacity)===0));
    const videoInputs=roots.flatMap(root=>[...root.querySelectorAll('input[type=file]')]).filter(el=>/video/.test(el.accept||'')).map(el=>({accept:el.accept,files:el.files?.length||0}));
    const wujieRoot=roots.slice(1).some(root=>/wujie/i.test([root.host?.tagName,root.host?.id,root.host?.className].map(value=>String(value||'')).join(' ')));const editorMarkers={wujieRoot,videoInput:videoInputs.length>0,descriptionEditor:visible(descEditors[0]),shortTitleInput:visible(shortInput),coverCard:Boolean(verticalWrap||horizontalWrap),originalControl:Boolean(originalInput),markTagControl:markSelects.length===1};
    const earlyMutation={ready:Boolean(visible(descEditors[0])&&visible(shortInput)),uploading,uploaded,controls:{description:visible(descEditors[0]),shortTitle:visible(shortInput)}};
    return {text:text.slice(0,3000),url:location.href,description,shortTitle,shortTitleFound:Boolean(shortInput),markSelected,markOptions,aiGenerated,aiGeneratedEvidence,initToast,uploaded,uploading,failed,failureText,failureControls,loginTextMatched,loadFailed,editorMarkers,identityMatches,identityAmbiguous,identityForeign,trustedVideoReceipt,originalEnabled,originalFound:Boolean(originalInput),coverUrls,coverUrlsBySlot,combinedCover,dialogs,videoInputs,rootCount:roots.length,earlyMutation}
  })(${JSON.stringify(wechatDescription)}, ${JSON.stringify(trustedVideoReceipt)})`);
  if (state.aiGeneratedEvidence) state.aiGeneratedEvidence.requested = wechatAiGenerated;
  const pageShell=classifyWechatPageShell(state);
  const pageBlocker=wechatPageShellBlocker(pageShell)||wechatUploadFailureBlocker(state);
  const restoredIdentity=await readWechatRestoredIdentity();
  if(restoredIdentity.existingDraft)state.identityMatches=restoredIdentity.ok;
  const buttons=await inspectFinalButtons(/^发表$/);const finalButton=buttons.find(button=>button.buttonish)||buttons[0]||null;const receipt=expectedReceipts.cover||null;
  const requiredCoverAssets=state.combinedCover?wechatCoverAssets.filter(asset=>asset.slot==='vertical'):wechatCoverAssets;
  const customCoverOk=Boolean(wechatCustomCover&&receipt?.slots&&(state.combinedCover?receipt.layout==='combined_3x4':receipt.layout!=='combined_3x4')&&requiredCoverAssets.every(asset=>{const item=receipt.slots[asset.slot],live=state.coverUrlsBySlot[asset.slot]||[];return item?.assetPath===asset.path&&item?.ratio===asset.ratio&&item?.confirmed===true&&wechatCoverReceiptTransportMatches(asset,item)&&live.length>0&&live.some(url=>url===item.afterUrl||!(item.beforeUrls||[]).includes(url))}));const defaultCoverOk=!wechatCustomCover&&state.uploaded;
  const observation={gates:{
    authenticated:pageShell.login.required?failedGate({loginRequired:true,...pageBlocker.evidence}):okGate({url:pageShell.url||PLATFORM_URLS.wechat_channels,login:pageShell.login}),
    draftIdentity:state.identityMatches?okGate({description:state.description,trustedVideoReceipt:state.trustedVideoReceipt,restoredIdentity}):failedGate({foreign:state.identityForeign,ambiguous:state.identityAmbiguous,description:state.description,expected:wechatDescription,restoredIdentity}),
    video:state.uploaded&&!state.uploading&&!state.failed?okGate({stable:true,coverCards:true}):failedGate({uploaded:state.uploaded,uploading:state.uploading,failed:state.failed,failureText:state.failureText,initToast:state.initToast,videoInputs:state.videoInputs}),
    description:state.description===compactText(wechatDescription)?okGate({expected:wechatDescription,actual:state.description}):failedGate({expected:wechatDescription,actual:state.description}),
    shortTitle:wechatShortTitleGate(state),
    aiGenerated:wechatAiGeneratedGate(state),
    original:state.originalEnabled?okGate({enabled:true}):failedGate({enabled:false,found:state.originalFound}),
    cover:customCoverOk||defaultCoverOk?okGate({custom:wechatCustomCover,layout:state.combinedCover?'combined_3x4':'separate',urls:state.coverUrls,urlsBySlot:state.coverUrlsBySlot,receipt}):failedGate({custom:wechatCustomCover,layout:state.combinedCover?'combined_3x4':'separate',urls:state.coverUrls,urlsBySlot:state.coverUrlsBySlot,receipt,reason:wechatCustomCover&&!receipt?'custom cover receipt missing':'cover not verified'}),
    noBlockingDialog:state.dialogs.length===0?okGate({active:[]}):failedGate({active:state.dialogs}),
    finalButton:finalButton&&!finalButton.disabled?okGate(finalButton):failedGate({buttons}),
  },evidence:{pageSample:state.text,pageShell,failureControls:state.failureControls,initToast:state.initToast,rootCount:state.rootCount,earlyMutation:state.earlyMutation,videoInputs:state.videoInputs},...(pageBlocker?{blocker:pageBlocker}:{})};
  if(typeof readBrowserVideoRevisionSource==='function'&&readBrowserVideoRevisionSource()){
    observation.gates.replaceVideo=await readWechatVideoReplacementProof(observation);
    if(observation.gates.replaceVideo.ok)observation.gates.video.evidence.replacement=observation.gates.replaceVideo.evidence;
  }
  if(typeof phase!=='undefined'&&phase==='inspect'&&observation.blocker?.code==='PLATFORM_REJECTED_ASSET'&&observation.blocker.evidence?.stage==='video_upload'){
    const previousFailure=observation.blocker;
    const recovery=await assessWechatFailedUploadRetryForScheduling(observation);
    observation.evidence.failedUploadRecovery={...recovery,previousFailure,status:'previous_attempt_failed_next_upload_not_started'};
    // An action blocker freezes the production scheduler regardless of its
    // retryable flag. Only a fully proven, read-only eligible inspection may
    // proceed through the normal missing-video -> upload_start path. The failed
    // video gate and its exact error remain unchanged; upload_start rechecks all
    // authority before the one bounded reset performs any native UI action.
    if(recovery.eligible===true)delete observation.blocker;
  }
  return observation;
}

async function getWechatUploadProbe(){return await js(String.raw`(() => {const compact=v=>String(v||'').replace(/\s+/g,' ').trim();const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];const text=compact(roots.map(root=>root.body?.innerText||root.host?.innerText||'').join('\n'));const input=roots.flatMap(root=>[...root.querySelectorAll('input[type=file]')]).find(el=>/video/.test(el.accept||''));const uploadState=(${classifyWechatUploadText.toString()})(text);return {initToast:/页面初始化中/.test(text),hasInput:Boolean(input),...uploadState,sample:text.slice(0,1000)}})()`)}

async function activateWechatLifecycle(){await cdp('Page.bringToFront',{}).catch(()=>null);await cdp('Page.setWebLifecycleState',{state:'active'}).catch(()=>null);await cdp('Emulation.setFocusEmulationEnabled',{enabled:true}).catch(()=>null)}

async function waitWechatSdkReady(seconds){for(let i=0;i<seconds;i+=2){await activateWechatLifecycle();const probe=await getWechatUploadProbe();if(probe.failed)return {ok:false,probe};if(probe.uploaded||(!probe.initToast&&probe.hasInput))return {ok:true,probe};await wait(2)}return {ok:false,probe:await getWechatUploadProbe()}}

async function injectWechatVideo(){const evaluated=await cdp('Runtime.evaluate',{expression:String.raw`(() => {const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];return roots.flatMap(root=>[...root.querySelectorAll('input[type=file]')]).find(el=>/video/.test(el.accept||''))})()`,objectGroup:'video-publisher-v2-wechat',includeCommandLineAPI:true});const objectId=evaluated?.result?.objectId;if(!objectId)return {ok:false,reason:'wechat video input objectId missing'};await cdp('DOM.setFileInputFiles',{objectId,files:[videoPath]});return {ok:true,objectId}}

async function waitWechatUploadCompletion(){let stableSince=0;for(let i=0;i<180;i+=1){await activateWechatLifecycle();const current=await inspectWechatChannels();if(current.blocker)return current;if(current.gates.video.ok){if(!stableSince)stableSince=Date.now();if(Date.now()-stableSince>=10000)return current}else stableSince=0;await wait(5)}const after=await inspectWechatChannels();if(after.blocker)return after;return {...after,blocker:typedBlocker('UPLOAD_STALLED','视频号上传没有在等待窗口内稳定完成',{retryable:true,evidence:after.gates.video.evidence})}}

function trustedWechatUploadStartReceipt(){
  const receipt=expectedReceipts.uploadStart||null;
  return receipt?.fingerprint===jobFingerprint
    && Number(receipt?.taskSpaceId)===Number(activeTaskSpace?.id)
    && ['injected','resume_existing'].includes(receipt?.mode)
    ? receipt
    : null;
}

function createWechatUploadStartReceipt(mode){
  if(!jobFingerprint||activeTaskSpace?.id==null)return null;
  const prior=trustedWechatUploadStartReceipt();
  return {fingerprint:jobFingerprint,taskSpaceId:activeTaskSpace.id,mode,observedAt:new Date().toISOString(),
    ...(prior?.failedUploadRetry?{failedUploadRetry:prior.failedUploadRetry}:{})};
}

function completeWechatUploadStartObservation(current,mode,stage,receipt,fallbackDispatched=false){
  if(receipt)expectedReceipts.uploadStart=receipt;
  current.gates.draftIdentity=okGate({trustedUploadAction:true,mode,uploadStartReceipt:Boolean(receipt)});
  const receipts=receipt?{uploadStart:receipt}:{};
  const actions={upload:{mode,stage,earlyMutationReady:true,fallbackDispatched}};
  if(receipt?.failedUploadRetry)actions.failedUploadRecovery=receipt.failedUploadRetry;
  if(receipt)actions.receiptCheckpoint=checkpointReceipts(receipts);
  return {...current,actions,receipts};
}

async function dispatchWechatUploadChange(){
  return await js(String.raw`(() => {const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];const input=roots.flatMap(root=>[...root.querySelectorAll('input[type=file]')]).find(el=>/video/.test(el.accept||''));if(input)input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));return {files:input?.files?.length||0}})()`);
}

async function waitWechatEarlyMutationReady(mode,receipt,allowFallback=false){
  if(receipt)expectedReceipts.uploadStart=receipt;
  let fallbackDispatched=false;
  for(let attempt=1;attempt<=30;attempt+=1){
    await activateWechatLifecycle();
    const current=await inspectWechatChannels();
    if(current.blocker)return current;
    if(!current.gates.authenticated.ok)return {...current,blocker:typedBlocker('AUTH_REQUIRED','视频号登录状态失效',{requiresUser:true,evidence:current.gates.authenticated.evidence})};
    if(current.gates.video.ok)return completeWechatUploadStartObservation(current,mode,'complete',receipt,fallbackDispatched);
    if(current.gates.video.evidence?.failed===true)return {...current,blocker:typedBlocker('UPLOAD_NOT_STARTED','视频号上传失败',{retryable:true,evidence:current.gates.video.evidence})};
    if(current.gates.video.evidence?.uploading===true&&current.evidence?.earlyMutation?.ready===true){
      return completeWechatUploadStartObservation(current,mode,'editable_uploading',receipt,fallbackDispatched);
    }
    if(allowFallback&&attempt===4&&!fallbackDispatched){
      await dispatchWechatUploadChange();
      fallbackDispatched=true;
    }
    await wait(1);
  }
  const after=await inspectWechatChannels();
  if(after.blocker)return after;
  return {...after,blocker:typedBlocker('UPLOAD_NOT_STARTED','视频号上传启动后描述与短标题控件未及时进入可编辑状态',{retryable:true,evidence:after.evidence?.earlyMutation})};
}

let wechatFailedUploadRetryTaken=false;

function wechatFailedUploadRetryEligibility(current,{receipt,journal,native,source,fingerprint,taskSpaceId,expectedDescription,expectedVideoPath,reservationId=null,requireFailed=true}={}){
  const reasons=[],video=current?.gates?.video,identity=current?.gates?.draftIdentity?.evidence||{};
  const text=String(current?.evidence?.pageSample||'');
  if(current?.gates?.authenticated?.ok!==true)reasons.push('authentication not confirmed');
  if(current?.gates?.draftIdentity?.ok!==true||identity.trustedVideoReceipt!==true)reasons.push('same-job injected target not confirmed');
  if(compactText(identity.description)!==compactText(expectedDescription))reasons.push('approved description differs');
  if(!receipt||receipt.mode!=='injected'||receipt.fingerprint!==fingerprint||Number(receipt.taskSpaceId)!==Number(taskSpaceId))reasons.push('injected upload-start receipt does not match');
  if(receipt?.failedUploadRetry&&receipt.failedUploadRetry.id!==reservationId)reasons.push('failed upload retry already reserved');
  if(journal)reasons.push('save journal exists; saved or uncertain draft must be preserved');
  if(!native||!Object.hasOwn(native,'objectId')||String(native.objectId||'')!=='')reasons.push('native unsaved editor identity not confirmed');
  if(identity.restoredIdentity?.existingDraft!==false||identity.restoredIdentity?.actualId||identity.restoredIdentity?.ok===true)reasons.push('restored or saved native draft may exist');
  if(!source||source.path!==expectedVideoPath||!source.size||!/^[a-f0-9]{64}$/.test(source.sha256||''))reasons.push('exact local video source not bound');
  // The observed failed widget retains the advisory 文件上传中. Real transfer /
  // processing controls, cancellation or percentage progress must still veto reset.
  if(/取消上传|正在上传|正在处理文件|处理中|生成中|剩余时间|上传进度|(?:^|\s)\d{1,3}%(?:\s|$)/.test(text))reasons.push('active upload or processing signal remains');
  if(requireFailed){
    if(video?.ok!==false||video.evidence?.failed!==true||video.evidence?.uploaded!==false||video.evidence?.uploading!==false||video.evidence?.failureText!=='网络出错')reasons.push('exact observed inactive network failure not confirmed');
    if(current?.blocker?.code!=='PLATFORM_REJECTED_ASSET'||current.blocker.evidence?.stage!=='video_upload')reasons.push('not an explicit video-upload failure');
  }else if(video?.evidence?.failed===true||video?.evidence?.uploading===true)reasons.push('failure or active upload remained after reset');
  return {ok:reasons.length===0,reasons};
}

function probeWechatFailedUploadRecovery(stage,classifyUploadText){
  const compact=value=>String(value||'').replace(/\s+/g,' ').trim();
  const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];
  const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let node=el;node;node=node.parentElement||node.getRootNode?.()?.host||null){const s=getComputedStyle(node);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity||1)===0)return false;}return true;};
  const text=compact(roots.map(root=>root.body?.innerText||root.host?.innerText||'').join('\n'));
  if(location.origin!=='https://channels.weixin.qq.com'||!/^\/platform\/post\/create\/?$/.test(location.pathname))return {ok:false,reason:'not the native unsaved create route'};
  if(/取消上传|正在上传|正在处理文件|处理中|生成中|剩余时间|上传进度|(?:^|\s)\d{1,3}%(?:\s|$)/.test(text))return {ok:false,reason:'active upload or processing signal remains'};
  const errors=[...new Set(roots.flatMap(root=>[...root.querySelectorAll('.media-status-content .status-msg.error .msg-tip')]))].filter(visible);
  const inputs=[...new Set(roots.flatMap(root=>[...root.querySelectorAll('input[type="file"]')]))].filter(el=>/video/.test(el.accept||''));
  if(stage==='cleared'){
    const state=classifyUploadText(text);
    if(errors.length||state.failed)return {ok:false,reason:'failed media container remains',waiting:true};
    if(inputs.length!==1||inputs[0].disabled||inputs[0].isConnected===false||(inputs[0].files?.length||0)!==0)return {ok:false,reason:'empty enabled original video input is not unique'};
    return {ok:true,stage,errorCount:0,input:{accept:inputs[0].accept,disabled:false,filesCount:0}};
  }
  const state=classifyUploadText(text);
  if(!state.failed||state.failureText!=='网络出错'||state.uploading||state.uploaded||errors.length!==1||compact(errors[0].innerText||errors[0].textContent)!=='网络出错，请重新上传。')return {ok:false,reason:'unique exact failed attachment is not confirmed'};
  const panel=errors[0].closest('.media-status-content');
  const leaves=panel?[...panel.querySelectorAll('.media-opr .weui-desktop-popover__target .tag-inner')].filter(el=>visible(el)&&compact(el.innerText||el.textContent)==='删除'&&el.children.length===0):[];
  if(leaves.length!==1)return {ok:false,reason:'failed attachment delete entry is not unique'};
  const wrapper=leaves[0].closest('.weui-desktop-popover__wrp');
  if(!wrapper||!panel.contains(wrapper))return {ok:false,reason:'delete entry is outside its failed-media popover'};
  const popovers=[...wrapper.querySelectorAll('.weui-desktop-popover')].filter(visible);
  let control=leaves[0];
  if(stage==='entry'){
    if(popovers.length)return {ok:false,reason:'an unexpected confirmation is already open'};
  }else if(stage==='confirm'){
    if(popovers.length===0)return {ok:false,reason:'native failed-attachment confirmation is not visible',waiting:true};
    if(popovers.length!==1)return {ok:false,reason:'failed attachment confirmation is not unique'};
    const prompts=[...popovers[0].querySelectorAll('.confirm-del .content')].filter(visible);
    const buttons=[...popovers[0].querySelectorAll('button')].filter(visible);
    const deletes=buttons.filter(el=>compact(el.innerText||el.textContent)==='删除');
    if(prompts.length!==1||compact(prompts[0].innerText||prompts[0].textContent)!=='删除后需重新上传'||buttons.length!==2||buttons.filter(el=>compact(el.innerText||el.textContent)==='取消').length!==1||deletes.length!==1)return {ok:false,reason:'unknown or ambiguous failed-attachment confirmation'};
    control=deletes[0];
  }else return {ok:false,reason:'unsupported failed-attachment recovery probe'};
  if(control.disabled||control.getAttribute('aria-disabled')==='true')return {ok:false,reason:'native recovery control is disabled'};
  const r=control.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,root=control.getRootNode();
  const hit=typeof root.elementFromPoint==='function'?root.elementFromPoint(x,y):document.elementFromPoint(x,y);
  if(!hit||!(hit===control||control.contains(hit)))return {ok:false,reason:'native recovery control is obscured'};
  return {ok:true,stage,x,y,label:compact(control.innerText||control.textContent),tag:control.tagName,className:String(control.className||''),panelClass:String(panel.className||''),errorText:'网络出错，请重新上传。',confirmationText:stage==='confirm'?'删除后需重新上传':null,hitWithinControl:true};
}

async function inspectWechatFailedUploadRecoveryControl(stage){
  return await js(`(${probeWechatFailedUploadRecovery.toString()})(${JSON.stringify(stage)},(${classifyWechatUploadText.toString()}))`);
}

function readWechatFailedUploadRetrySource(){
  const stat=fs.statSync(videoPath),bytes=fs.readFileSync(videoPath);
  if(!stat.isFile()||bytes.length!==stat.size)throw new Error('approved local video source changed during read');
  return {path:videoPath,size:stat.size,lastModified:stat.mtimeMs,sha256:createHash('sha256').update(bytes).digest('hex')};
}

async function assessWechatFailedUploadRetryForScheduling(current){
  try{
    const source=readWechatFailedUploadRetrySource(),native=await findWechatPostComponent();
    const result=wechatFailedUploadRetryEligibility(current,{receipt:trustedWechatUploadStartReceipt(),journal:readDraftSaveJournal(wechatJournalFile(),wechatJournalIdentity()),native,source,fingerprint:jobFingerprint,taskSpaceId:activeTaskSpace?.id,expectedDescription:wechatDescription,expectedVideoPath:videoPath});
    if(wechatFailedUploadRetryTaken)result.reasons.push('failed upload retry already attempted in this runner');
    if(result.reasons.length)return {eligible:false,reasons:result.reasons};
    const guard=await inspectFinalPublishGuard();
    if(guard.armed!==true||guard.blockedAttempts!==0)return {eligible:false,reasons:['final-publish guard not armed or already blocked an action']};
    const entry=await inspectWechatFailedUploadRecoveryControl('entry');
    if(!entry.ok)return {eligible:false,reasons:[entry.reason],entry};
    return {eligible:true,reasons:[],source,nativeUnsaved:true,entry,failed:true,failureText:current.gates.video.evidence.failureText};
  }catch(error){return {eligible:false,reasons:['read-only retry eligibility could not be confirmed: '+String(error?.message||error)]};}
}

async function recoverWechatFailedUpload(){
  let current=await inspectWechatChannels();
  const receipt=trustedWechatUploadStartReceipt();
  let source;
  try{source=readWechatFailedUploadRetrySource();}catch(error){return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','视频号失败附件恢复无法绑定批准的视频源',{evidence:{reason:String(error?.message||error)}})};}
  const eligibility=(observation,native,requireFailed=true,reservationId=null)=>wechatFailedUploadRetryEligibility(observation,{receipt:trustedWechatUploadStartReceipt(),journal:readDraftSaveJournal(wechatJournalFile(),wechatJournalIdentity()),native,source,fingerprint:jobFingerprint,taskSpaceId:activeTaskSpace?.id,expectedDescription:wechatDescription,expectedVideoPath:videoPath,reservationId,requireFailed});
  const allowed=eligibility(current,await findWechatPostComponent());
  if(wechatFailedUploadRetryTaken||!allowed.ok)return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','视频号失败附件不满足同目标一次恢复条件',{evidence:{...allowed,alreadyAttempted:wechatFailedUploadRetryTaken}})};
  const guard=await inspectFinalPublishGuard();
  if(guard.armed!==true||guard.blockedAttempts!==0)return {...current,blocker:typedBlocker('INPUT_CHANNEL_BROKEN','视频号失败附件恢复缺少最终发布保护',{evidence:guard})};
  const entry=await inspectWechatFailedUploadRecoveryControl('entry');
  if(!entry.ok)return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','视频号失败附件删除入口无法唯一确认',{evidence:entry})};
  wechatFailedUploadRetryTaken=true;
  let record={id:jobFingerprint+':'+activeTaskSpace.id+':'+Date.now(),attempts:1,status:'intent',fingerprint:jobFingerprint,taskSpaceId:activeTaskSpace.id,source,startedAt:new Date().toISOString(),entry};
  const saveRecord=patch=>{
    record={...record,...patch};expectedReceipts.uploadStart={...receipt,failedUploadRetry:record};
    const saved=checkpointReceipts({...expectedReceipts,uploadStart:expectedReceipts.uploadStart});
    if(saved?.ok!==true)throw new Error('failed-upload retry intent checkpoint was not persisted');
    return saved;
  };
  const stop=async(reason,evidence)=>({...await inspectWechatChannels(),actions:{failedUploadRecovery:record},receipts:{...expectedReceipts},blocker:typedBlocker('STATE_AMBIGUOUS',reason,{evidence})});
  const recheck=async(requireFailed=true)=>{
    current=await inspectWechatChannels();const native=await findWechatPostComponent(),guard=await inspectFinalPublishGuard();
    const checked=eligibility(current,native,requireFailed,record.id),nowSource=readWechatFailedUploadRetrySource();
    if(JSON.stringify(nowSource)!==JSON.stringify(source))checked.reasons.push('approved source bytes or file identity changed');
    if(guard.armed!==true||guard.blockedAttempts!==0)checked.reasons.push('final-publish guard changed');
    return {...checked,ok:checked.reasons.length===0};
  };
  try{
    saveRecord({status:'entry_intent'});
    const beforeEntry=await recheck();if(!beforeEntry.ok)return await stop('视频号失败附件入口点击前身份发生变化',beforeEntry);
    const liveEntry=await inspectWechatFailedUploadRecoveryControl('entry');if(!liveEntry.ok)return await stop('视频号失败附件入口已变化',liveEntry);
    await click([liveEntry.x,liveEntry.y],{label:'open same-job failed WeChat attachment confirmation'});
    saveRecord({status:'confirmation_pending',entry:liveEntry});
    let confirm;
    for(let n=0;n<10;n+=1){await activateWechatLifecycle();confirm=await inspectWechatFailedUploadRecoveryControl('confirm');if(confirm.ok||!confirm.waiting)break;await wait(.5);}
    if(!confirm?.ok)return await stop('视频号失败附件出现未知或不唯一的确认层',confirm);
    const beforeConfirm=await recheck();if(!beforeConfirm.ok)return await stop('视频号失败附件确认前身份发生变化',beforeConfirm);
    confirm=await inspectWechatFailedUploadRecoveryControl('confirm');if(!confirm.ok)return await stop('视频号失败附件确认控件已变化',confirm);
    saveRecord({status:'confirm_intent',confirmation:confirm});
    await click([confirm.x,confirm.y],{label:'confirm removal of same-job failed unsaved WeChat attachment'});
    let cleared;
    for(let n=0;n<10;n+=1){await activateWechatLifecycle();cleared=await inspectWechatFailedUploadRecoveryControl('cleared');if(cleared.ok||!cleared.waiting)break;await wait(.5);}
    if(!cleared?.ok)return await stop('视频号失败附件未清除或原生视频输入未就绪',cleared);
    saveRecord({status:'cleared',cleared});
    const beforeInjection=await recheck(false);if(!beforeInjection.ok)return await stop('视频号失败附件清除后身份或批准视频源发生变化',beforeInjection);
    cleared=await inspectWechatFailedUploadRecoveryControl('cleared');if(!cleared.ok)return await stop('视频号重新上传前原生输入已变化',cleared);
    saveRecord({status:'inject_intent'});
    const injected=await injectWechatVideo();if(!injected.ok)return await stop('视频号同目标重新上传未开始',injected);
    saveRecord({status:'restarted',injectedAt:new Date().toISOString(),injected});
    const retryReceipt=createWechatUploadStartReceipt('injected');
    expectedReceipts.uploadStart=retryReceipt;checkpointReceipts({...expectedReceipts,uploadStart:retryReceipt});
    const restarted=await waitWechatEarlyMutationReady('injected',retryReceipt,true);
    return {...restarted,actions:{...restarted.actions,failedUploadRecovery:record},receipts:{...restarted.receipts,uploadStart:retryReceipt}};
  }catch(error){return await stop('视频号失败附件一次恢复中断；保留意图，禁止重复删除或注入',{reason:String(error?.message||error)});}
}

async function startWechatChannelsUpload(){
  const before=await inspectWechatChannels();
  if(before.blocker?.code==='PLATFORM_REJECTED_ASSET'&&before.blocker.evidence?.stage==='video_upload'&&before.gates.video.evidence?.failed===true)return await recoverWechatFailedUpload();
  if(before.blocker)return before;
  const confirmedJournal=readDraftSaveJournal(wechatJournalFile(),wechatJournalIdentity());
  if(confirmedJournal?.status==='confirmed'&&confirmedJournal.plan?.id){
    const current=await findWechatPostComponent();
    if(current?.objectId!==String(confirmedJournal.plan.id))return await persistWechatDraft(inspectWechatChannels);
  }
  if(!before.gates.draftIdentity.ok){
    const ambiguous=before.gates.draftIdentity.evidence?.ambiguous===true;
    return {...before,blocker:typedBlocker(ambiguous?'STATE_AMBIGUOUS':'FOREIGN_DRAFT',ambiguous?'视频号存在描述为空且来源无法证明的已上传草稿':'视频号当前编辑器属于其他视频草稿',{evidence:before.gates.draftIdentity.evidence})};
  }
  const existingReceipt=trustedWechatUploadStartReceipt();
  if(existingReceipt?.failedUploadRetry&&(existingReceipt.failedUploadRetry.status!=='restarted'||!before.gates.video.ok&&before.gates.video.evidence?.uploading!==true))return {...before,actions:{failedUploadRecovery:existingReceipt.failedUploadRetry},blocker:typedBlocker('STATE_AMBIGUOUS','视频号失败附件恢复意图尚未由当前上传状态确认；禁止再次注入',{evidence:existingReceipt.failedUploadRetry})};
  if(before.gates.video.ok){
    const mode=existingReceipt?.mode||'already_ready';
    return completeWechatUploadStartObservation(before,mode,'complete',existingReceipt,false);
  }
  if(before.gates.video.evidence?.uploading){
    const receipt=existingReceipt||createWechatUploadStartReceipt('resume_existing');
    return await waitWechatEarlyMutationReady('resume_existing',receipt,false);
  }
  let ready=await waitWechatSdkReady(30);
  if(ready.probe?.failed)return await inspectWechatChannels();
  if(!ready.ok){
    await gotoAndWait(PLATFORM_URLS.wechat_channels,{timeout:45,settle:2});
    const guard=await armFinalPublishGuard();
    if(!guard.ok||!guard.armed){
      const after=await inspectWechatChannels();
      return {...after,blocker:typedBlocker('INPUT_CHANNEL_BROKEN','视频号导航后无法重新挂载最终发布保护',{retryable:true,evidence:guard})};
    }
    ready=await waitWechatSdkReady(90);
  }
  if(ready.probe?.failed)return await inspectWechatChannels();
  if(!ready.ok){
    const after=await inspectWechatChannels();
    if(after.blocker)return after;
    return {...after,blocker:typedBlocker('RISK_CONTROL','视频号 Wujie 上传 SDK 没有在激活页面生命周期后完成初始化',{retryable:true,evidence:ready.probe})};
  }
  const injected=await injectWechatVideo();
  if(!injected.ok)return {...before,blocker:typedBlocker('UPLOAD_NOT_STARTED',injected.reason,{retryable:true})};
  const receipt=createWechatUploadStartReceipt('injected');
  // Persist successful injection before any asynchronous readiness timeout can lose it.
  if(receipt){expectedReceipts.uploadStart=receipt;checkpointReceipts({...expectedReceipts,uploadStart:receipt});}
  return await waitWechatEarlyMutationReady('injected',receipt,true);
}

async function uploadWechatChannels(){
  const started=await startWechatChannelsUpload();
  if(started.blocker)return started;
  const mode=started.actions?.upload?.mode||'already_ready';
  if(started.gates.video.ok)return {...started,actions:{...started.actions,upload:{mode}}};
  const current=await waitWechatUploadCompletion();
  if(current.gates.video.ok)current.gates.draftIdentity=okGate({trustedUploadAction:true,mode});
  return {...current,actions:{...started.actions,...current.actions,upload:{mode}},receipts:started.receipts||{}};
}

async function setWechatDescription(){return await js(String.raw`((value) => {const compact=v=>String(v||'').replace(/\s+/g,' ').trim();const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];const editor=roots.flatMap(root=>[...root.querySelectorAll('[contenteditable="true"],[contenteditable=""]')]).find(el=>/input-editor|视频描述|editor/i.test(String(el.className||''))&&!/chatInput/.test(String(el.className||'')));if(!editor)return {ok:false,reason:'wechat description editor missing'};editor.focus();const sel=window.getSelection(),range=document.createRange();range.selectNodeContents(editor);sel.removeAllRanges();sel.addRange(range);document.execCommand('delete',false);document.execCommand('insertText',false,value);editor.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:value}));editor.dispatchEvent(new Event('change',{bubbles:true,composed:true}));return {ok:compact(editor.innerText||editor.textContent||'')===compact(value),actual:editor.innerText||editor.textContent||''}})(${JSON.stringify(wechatDescription)})`)}

async function setWechatShortTitle(){
  return await js(String.raw`((value) => {
    const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];
    const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'};
    const inputs=roots.flatMap(root=>[...root.querySelectorAll('input')]).filter(el=>visible(el)&&(el.placeholder||'').includes('短标题'));
    if(inputs.length!==1)return {ok:false,reason:'wechat short-title input is not unique',count:inputs.length};
    const input=inputs[0];
    if(input.value===value)return {ok:true,already:true,actual:input.value};
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
    if(!setter)return {ok:false,reason:'wechat short-title native setter missing'};
    setter.call(input,value);
    input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:value?'insertText':'deleteContentBackward',data:value}));
    input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
    return {ok:input.value===value,actual:input.value};
  })(${JSON.stringify(wechatShortTitle)})`);
}

async function ensureWechatAiGenerated(){
  const open=await js(String.raw`(() => {
    const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0};
    const selects=roots.flatMap(root=>[...root.querySelectorAll('.mark-tag-select')]).filter(visible);
    if(selects.length!==1)return {ok:false,reason:'wechat video-mark selector is not unique',count:selects.length};
    const select=selects[0],display=select.querySelector('.select-display');
    if(!display||!visible(display))return {ok:false,reason:'wechat video-mark display control missing'};
    const actual=String(display.innerText||display.textContent||'').replace(/\s+/g,' ').trim();
    if(actual==='含AI生成内容')return {ok:true,already:true,actual,selector:'.mark-tag-select .select-display'};
    display.click();
    return {ok:true,opened:true,actual,selector:'.mark-tag-select .select-display'};
  })()`);
  if(!open.ok)return open;
  if(open.already)return {ok:true,already:true,evidence:{requested:true,actual:open.actual,selector:open.selector}};
  await wait(.5);
  const choose=await js(String.raw`(() => {
    const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0};
    const selects=roots.flatMap(root=>[...root.querySelectorAll('.mark-tag-select')]).filter(visible);
    if(selects.length!==1)return {ok:false,reason:'wechat video-mark selector changed after open',count:selects.length};
    const options=[...selects[0].querySelectorAll('.mark-tag-option .option-main')].filter(visible).filter(el=>String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim()==='含AI生成内容');
    if(options.length!==1)return {ok:false,reason:'wechat AI video-mark option is not unique or visible',count:options.length,options:[...selects[0].querySelectorAll('.mark-tag-option .option-main')].map(el=>String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim())};
    options[0].click();return {ok:true,clicked:true,label:'含AI生成内容',selector:'.mark-tag-select .mark-tag-option .option-main'};
  })()`);
  if(!choose.ok)return choose;
  await wait(1);
  const after=await inspectWechatChannels();
  return after.gates.aiGenerated.ok
    ? {ok:true,changed:true,evidence:after.gates.aiGenerated.evidence}
    : {ok:false,reason:'wechat AI video-mark selection did not persist',evidence:after.gates.aiGenerated.evidence};
}

async function ensureWechatOriginal(){
  const result=await js(String.raw`(() => {const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'};const input=roots.flatMap(root=>[...root.querySelectorAll('.declare-original-checkbox input[type="checkbox"],.form-item.post-with-link input.ant-checkbox-input')]).find(visible);if(!input)return {ok:false,reason:'wechat original checkbox missing'};if(!input.checked)(input.closest('label.ant-checkbox-wrapper')||input).click();return {ok:true,checked:input.checked}})()`);
  if(!result.ok)return result;
  await wait(1);
  const agreement=await js(String.raw`(() => {const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden'};const dialog=roots.flatMap(root=>[...root.querySelectorAll('.weui-desktop-dialog__wrp,[role="dialog"],[class*="modal"]')]).find(el=>visible(el)&&/原创权益|原创声明须知/.test(el.innerText||el.textContent||''));if(!dialog)return {ok:true,modal:false};const input=[...dialog.querySelectorAll('input[type="checkbox"]')][0];if(input&&!input.checked)(input.closest('label')||input).click();return {ok:true,modal:true,agreementChecked:input?input.checked:true}})()`);
  if(!agreement.ok)return agreement;
  if(agreement.modal){
    await wait(1);
    const confirmed=await js(String.raw`(() => {const compact=v=>String(v||'').replace(/\s+/g,' ').trim();const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden'};const dialog=roots.flatMap(root=>[...root.querySelectorAll('.weui-desktop-dialog__wrp,[role="dialog"],[class*="modal"]')]).find(el=>visible(el)&&/原创权益|原创声明须知/.test(el.innerText||el.textContent||''));if(!dialog)return {ok:true,alreadyClosed:true};const button=[...dialog.querySelectorAll('button,[role="button"]')].find(el=>compact(el.innerText||el.textContent||'')==='声明原创'&&!el.disabled&&!/disabled/.test(String(el.className||'')));if(!button)return {ok:false,reason:'wechat original confirm missing or disabled'};button.click();return {ok:true,clicked:true}})()`);
    if(!confirmed.ok)return confirmed;
  }
  await wait(2);
  const after=await inspectWechatChannels();
  return {ok:after.gates.original.ok&&after.gates.noBlockingDialog.ok,evidence:{original:after.gates.original.evidence,dialogs:after.gates.noBlockingDialog.evidence}};
}

async function dismissWechatCoverEditor(){
  const dismissed=await js(String.raw`(() => {const compact=v=>String(v||'').replace(/\s+/g,' ').trim();const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0};const coverDialog=el=>{const text=compact(el.innerText||el.textContent||'');return /编辑个人主页卡片|编辑分享卡片|编辑封面|裁剪封面图/.test(text)&&/上传封面|从视频中选择封面|裁剪封面图/.test(text)};const dialog=roots.flatMap(root=>[...root.querySelectorAll('.weui-desktop-dialog__wrp')]).find(el=>visible(el)&&coverDialog(el));if(!dialog)return {ok:true,dismissed:false};const button=[...dialog.querySelectorAll('button,[role="button"]')].find(el=>compact(el.innerText||el.textContent||'')==='取消'&&visible(el))||[...dialog.querySelectorAll('.weui-desktop-dialog__close-btn')].find(el=>el.getBoundingClientRect().width>0);if(!button)return {ok:false,reason:'wechat cover recovery button missing'};button.click();return {ok:true,dismissed:true}})()`);
  if(!dismissed.ok)return dismissed;
  for(let i=0;i<12;i+=1){await activateWechatLifecycle();const active=await js(String.raw`(() => {const compact=v=>String(v||'').replace(/\s+/g,' ').trim();const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];return roots.flatMap(root=>[...root.querySelectorAll('.weui-desktop-dialog__wrp')]).some(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el),text=compact(el.innerText||el.textContent||'');return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0&&/编辑个人主页卡片|编辑分享卡片|编辑封面|裁剪封面图/.test(text)&&/上传封面|从视频中选择封面|裁剪封面图/.test(text)})})()`);if(!active)return dismissed;await wait(1)}
  return {ok:false,reason:'wechat cover editor recovery did not close'};
}

async function confirmWechatCustomCoverEditor(title){
  return await js(String.raw`((title) => {
    const compact=v=>String(v||'').replace(/\s+/g,' ').trim();
    const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let current=el;current;current=current.parentElement||current.getRootNode?.().host){const s=getComputedStyle(current);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity||1)<=0)return false}return true};
    const text=el=>compact(el?.innerText||el?.textContent||'');
    const dialogs=roots.flatMap(root=>[...root.querySelectorAll('.weui-desktop-dialog__wrp')]).filter(visible);
    const crops=dialogs.filter(el=>/^裁剪封面图(?:\s|$)/.test(text(el)));
    const parents=dialogs.filter(el=>text(el).includes(title));
    const generic=dialogs.filter(el=>!/编辑个人主页卡片|编辑分享卡片/.test(text(el))&&/编辑封面/.test(text(el))&&/上传封面/.test(text(el))&&/取消/.test(text(el))&&/确认/.test(text(el)));
    const candidates=parents.length?parents:generic;
    const parent=candidates.length===1?candidates[0]:null;
    const popovers=[...new Set(roots.flatMap(root=>[...root.querySelectorAll('[role="tooltip"],.ant-popover')]).filter(visible).map(el=>el.closest('.ant-popover')||el))].filter(visible).filter(el=>[...el.querySelectorAll('.title')].some(label=>visible(label)&&text(label)==='使用此素材作为封面？'));
    const materialButtons=popovers.length===1?[...popovers[0].querySelectorAll('button,[role="button"]')].filter(el=>visible(el)&&text(el)==='使用素材'):[];
    const scope=crops.length===1?crops[0]:parent;
    const label=crops.length===1?'确定':'确认';
    const allButtons=[...(scope?.querySelectorAll('button,[role="button"]')||[])].filter(el=>text(el)===label);
    const buttons=allButtons.filter(visible);
    const disabled=el=>Boolean(el?.disabled||el?.getAttribute('aria-disabled')==='true'||/disabled/.test(String(el?.className||'')));
    const probe=buttons[0]||allButtons[0];
    const rect=probe?.getBoundingClientRect();const style=probe?getComputedStyle(probe):null;
    const evidence=JSON.stringify({title,visibleDialogTexts:dialogs.filter(el=>/编辑个人主页卡片|编辑分享卡片|编辑封面|裁剪封面图/.test(text(el))).slice(0,2).map(el=>text(el).slice(0,60)),button:probe?{label,w:rect.width,h:rect.height,disabled:disabled(probe),opacity:style.opacity,display:style.display,visible:visible(probe),count:buttons.length}:null,material:{popovers:popovers.length,buttons:materialButtons.length,clicked:false},crop:{dialogs:crops.length},documentVisibility:document.visibilityState}).slice(0,500);
    const blocked=reason=>({ok:false,waiting:true,reason,evidence});
    if(crops.length>1)return blocked('wechat cover crop dialog is not unique');
    if(crops.length===1){
      if(parents.length!==1)return blocked('wechat cover crop does not have a unique matching slot editor');
      const foreign=dialogs.some(el=>el!==crops[0]&&/编辑个人主页卡片|编辑分享卡片/.test(text(el))&&!text(el).includes(title));
      if(foreign)return blocked('wechat cover crop has a different slot editor');
    }else if(candidates.length!==1)return blocked('wechat cover parent editor is not unique or does not match the requested slot');
    if(buttons.length!==1)return blocked('wechat cover confirm button is not uniquely visible');
    if(disabled(buttons[0]))return blocked('wechat cover confirm button is disabled');
    buttons[0].click();
    return crops.length===1?{ok:false,waiting:true,cropConfirmed:true,evidence}:{ok:true,confirmed:true,evidence};
  })(${JSON.stringify(title)})`);
}

async function openWechatShareCoverMaterialEditor(selector,slot,entryClicked,choiceState){
  if(slot!=='horizontal'||entryClicked!==true)return {ok:true,skipped:true,reason:'share cover entry was not clicked'};
  if(choiceState.clicked===true)return {ok:true,skipped:true,reason:'share cover direct editor already selected'};
  const selected=await js(String.raw`((selector) => {
    const compact=v=>String(v||'').replace(/\s+/g,' ').trim();
    const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=4||r.height<=4)return false;for(let current=el;current;current=current.parentElement||current.getRootNode?.().host){const s=getComputedStyle(current);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity||1)<=0)return false}return true};
    const dialogs=roots.flatMap(root=>[...root.querySelectorAll('.weui-desktop-dialog__wrp')]).filter(visible);
    if(dialogs.some(el=>/编辑个人主页卡片|编辑分享卡片|编辑封面|裁剪封面图/.test(compact(el.innerText||el.textContent||''))))return {ok:true,skipped:true,editorOpen:true};
    const triggers=roots.flatMap(root=>[...root.querySelectorAll(selector)]).filter(el=>visible(el)&&el.matches('.horizon-cover-wrap.img-popover-wrap.ant-popover-open'));
    if(triggers.length!==1)return {ok:false,waiting:true,reason:'share cover material trigger is not uniquely open'};
    const popovers=[...new Set(roots.flatMap(root=>[...root.querySelectorAll('[role="tooltip"],.ant-popover')]).filter(visible).map(el=>el.closest('.ant-popover')||el))].filter(visible).filter(el=>[...el.querySelectorAll('.title')].some(title=>visible(title)&&compact(title.innerText||title.textContent||'')==='使用此素材作为封面？'));
    if(popovers.length!==1)return {ok:false,waiting:true,reason:'share cover material popover is not unique'};
    const buttons=[...popovers[0].querySelectorAll('button')].filter(el=>visible(el)&&compact(el.innerText||el.textContent||'')==='直接编辑');
    if(buttons.length!==1)return {ok:false,waiting:true,reason:'share cover direct edit button is not unique'};
    const button=buttons[0];
    if(!button.closest('.btn-directly-edit')||button.disabled||button.getAttribute('aria-disabled')==='true'||/disabled/.test(String(button.className||'')))return {ok:false,waiting:true,reason:'share cover direct edit button is not enabled in the known material action'};
    button.click();
    return {ok:true,clicked:true,label:'直接编辑'};
  })(${JSON.stringify(selector)})`);
  if(selected.clicked===true)choiceState.clicked=true;
  return selected;
}

async function uploadWechatCover(asset){
  if(!wechatCustomCover)return {ok:true,skipped:true};
  const approved=readWechatCoverAsset(asset);
  if(!approved.ok)return approved;
  await activateWechatLifecycle();
  const before=(await inspectWechatChannels()).gates.cover.evidence?.urlsBySlot?.[asset.slot]||[];
  const prepared=await js(String.raw`((selector,slot) => {const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];const wrap=roots.flatMap(root=>[...root.querySelectorAll(selector)]).find(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden'});if(!wrap)return {ok:false,reason:'wechat cover card missing'};wrap.id='vp2-wechat-cover-'+slot;wrap.scrollIntoView({block:'center',inline:'center'});const r=wrap.getBoundingClientRect();return {ok:true,selector:'#'+wrap.id,x:r.left+r.width/2,y:r.top+r.height/2}})(${JSON.stringify(asset.wrap)},${JSON.stringify(asset.slot)})`);
  if(!prepared.ok)return prepared;
  await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:prepared.x,y:prepared.y});await wait(.6);
  const entry=await js(String.raw`((selector) => {const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];const wrap=roots.map(root=>root.querySelector(selector)).find(Boolean);const candidates=[wrap?.querySelector('.edit-btn'),wrap?.querySelector('img')].filter(Boolean);for(const el of candidates){const r=el.getBoundingClientRect(),s=getComputedStyle(el);if(r.width<=4||r.height<=4||s.display==='none'||s.visibility==='hidden')continue;const x=r.left+r.width/2,y=r.top+r.height/2,root=el.getRootNode(),hit=(typeof root.elementFromPoint==='function'?root.elementFromPoint(x,y):document.elementFromPoint(x,y));if(hit&&(hit===el||el.contains(hit)||wrap.contains(hit)))return{ok:true,x,y,tag:el.tagName,cls:String(el.className||''),hitTag:hit.tagName,hitCls:String(hit.className||'')}}return{ok:false,reason:'wechat cover edit entry missing after hover'}})(${JSON.stringify(prepared.selector)})`);
  let opened=entry;
  if(entry.ok){try{await click([entry.x,entry.y],{label:`open wechat ${asset.slot} cover editor`});opened={...entry,clicked:true}}catch(error){opened={ok:false,reason:String(error?.message||error),entry}}}
  if(!opened.ok){
    const controls=await js(String.raw`(() => {const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];return roots.flatMap(root=>[...root.querySelectorAll('.vertical-cover-wrap,.horizon-cover-wrap')]).map(el=>({className:el.className,html:el.parentElement.outerHTML.slice(0,6500)}))})()`);
    return {...opened,controls};
  }
  const materialChoice={clicked:false};let materialEntry=null;
  let dialogOpened=false;for(let i=0;i<15;i+=1){await wait(.5);dialogOpened=await js(String.raw`(() => {const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];return roots.flatMap(root=>[...root.querySelectorAll('.weui-desktop-dialog__wrp')]).some(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden'&&/编辑封面|编辑个人主页卡片|编辑分享卡片/.test(el.innerText||el.textContent||'')})})()`);if(dialogOpened)break;materialEntry=await openWechatShareCoverMaterialEditor(prepared.selector,asset.slot,opened.clicked,materialChoice)}
  if(!dialogOpened)return {ok:false,reason:'wechat cover editor did not open after proven native click',entry,materialEntry};
  await activateWechatLifecycle();
  const evaluated=await cdp('Runtime.evaluate',{expression:String.raw`((title) => {const compact=v=>String(v||'').replace(/\s+/g,' ').trim();const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0};const dialogs=roots.flatMap(root=>[...root.querySelectorAll('.weui-desktop-dialog__wrp')]).filter(visible);const dialog=dialogs.find(el=>String(el.innerText||el.textContent||'').includes(title))||dialogs.find(el=>{const text=compact(el.innerText||el.textContent||'');return /编辑封面/.test(text)&&/上传封面/.test(text)&&/取消/.test(text)&&/确认/.test(text)});return dialog?.querySelector('input[type=file][accept*="image"]')||roots.flatMap(root=>[...root.querySelectorAll('input[type=file]')]).find(el=>/image|png|jpe?g/i.test(el.accept||''))})(${JSON.stringify(asset.dialogTitle)})`,objectGroup:'video-publisher-v2-wechat-cover',includeCommandLineAPI:true});
  const objectId=evaluated?.result?.objectId;
  if(!objectId)return {ok:false,reason:'wechat cover image input objectId missing'};
  try{await cdp('DOM.setFileInputFiles',{objectId,files:[approved.uploadPath]})}catch(error){return {ok:false,reason:String(error?.message||error)}}
  let previewReady=false;
  for(let i=0;i<20;i+=1){await activateWechatLifecycle();previewReady=await js(String.raw`(() => {const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)];return roots.flatMap(root=>[...root.querySelectorAll('.single-cover-uploader-wrap img')]).some(el=>/^(data:|blob:|https?:)/.test(el.currentSrc||el.src||''))})()`);if(previewReady)break;await wait(1)}
  if(!previewReady)return {ok:false,reason:'wechat custom cover preview did not become ready'};
  const afterPreviewAsset=readWechatCoverAsset(asset);
  if(!afterPreviewAsset.ok||afterPreviewAsset.assetHash!==approved.assetHash
    ||!wechatCoverTransportMatches(asset,approved.transport||null))return {ok:false,reason:'wechat approved cover or explicit transport changed after injection'};
  let confirmed={ok:false,reason:'wechat cover confirm missing or disabled'};
  for(let i=0;i<20;i+=1){await activateWechatLifecycle();confirmed=await confirmWechatCustomCoverEditor(asset.dialogTitle);if(confirmed.ok)break;await wait(1)}
  if(!confirmed.ok)return {ok:false,reason:confirmed.reason||'wechat cover confirm missing or disabled',evidence:confirmed.evidence};
  let after=[];let dialogClosed=false;
  for(let i=0;i<30;i+=1){await activateWechatLifecycle();const state=await inspectWechatChannels();after=state.gates.cover.evidence?.urlsBySlot?.[asset.slot]||[];dialogClosed=state.gates.noBlockingDialog.ok;if(after.some(url=>!before.includes(url))&&dialogClosed)break;await wait(1)}
  const afterUrl=after.find(url=>!before.includes(url));
  if(!afterUrl)return {ok:false,reason:`wechat ${asset.slot} cover card did not change`,before,after};
  if(!dialogClosed)return {ok:false,reason:'wechat vertical cover confirmation dialog did not close',before,after};
  const finalAsset=readWechatCoverAsset(asset);
  if(!finalAsset.ok||finalAsset.assetHash!==approved.assetHash
    ||!wechatCoverTransportMatches(asset,approved.transport||null))return {ok:false,reason:'wechat approved cover or explicit transport changed before receipt'};
  return {ok:true,receipt:{assetPath:asset.path,assetHash:approved.assetHash,ratio:asset.ratio,beforeUrls:before,afterUrl,confirmed:true,
    ...(approved.transport?{transport:approved.transport}:{})}};
}

async function ensureWechatEarlyMetadata(before){
  const actions={};
  if(!before.gates.description.ok)actions.description=await setWechatDescription();
  if(actions.description&&!actions.description.ok){
    const current=await inspectWechatChannels();
    if(current.blocker)return {ok:false,actions,current,blocker:current.blocker};
    return {ok:false,actions,current,blocker:typedBlocker('ACTION_FAILED',actions.description.reason)};
  }
  let current=await inspectWechatChannels();
  if(current.blocker)return {ok:false,actions,current,blocker:current.blocker};
  if(!current.gates.shortTitle.ok)actions.shortTitle=await setWechatShortTitle();
  current=await inspectWechatChannels();
  if(current.blocker)return {ok:false,actions,current,blocker:current.blocker};
  if(!current.gates.description.ok||!current.gates.shortTitle.ok){
    return {ok:false,actions,current,blocker:typedBlocker('ACTION_FAILED','视频号描述或短标题没有持久化',{evidence:{description:current.gates.description.evidence,shortTitle:current.gates.shortTitle.evidence}})};
  }
  return {ok:true,actions,current};
}

async function prefillWechatChannels(){
  const before=await inspectWechatChannels();
  if(before.blocker)return before;
  if(!before.gates.authenticated.ok)return {...before,blocker:typedBlocker('AUTH_REQUIRED','视频号登录状态失效',{requiresUser:true,evidence:before.gates.authenticated.evidence})};
  if(!before.gates.draftIdentity.ok)return {...before,blocker:typedBlocker(before.gates.draftIdentity.evidence?.ambiguous?'STATE_AMBIGUOUS':'FOREIGN_DRAFT','视频号无法证明当前草稿属于本任务',{evidence:before.gates.draftIdentity.evidence})};
  const uploading=before.gates.video.evidence?.uploading===true;
  if(!before.gates.video.ok&&(!uploading||before.evidence?.earlyMutation?.ready!==true)){
    return {...before,blocker:typedBlocker('STATE_AMBIGUOUS','视频号上传中的描述与短标题控件尚未完整就绪',{retryable:true,evidence:before.evidence?.earlyMutation})};
  }
  const metadata=await ensureWechatEarlyMetadata(before);
  if(!metadata.ok)return {...metadata.current,actions:metadata.actions,blocker:metadata.blocker};
  return {...metadata.current,actions:{...metadata.actions,prefill:{completedDuringUpload:uploading}}};
}

function wechatCoverOnlyMissingFields(before,revision){
  const required=['authenticated','draftIdentity','video','description','shortTitle','aiGenerated','original','finalButton'];
  const missing=required.filter(key=>before.gates[key]?.ok!==true);
  const restored=before.gates.draftIdentity?.evidence?.restoredIdentity;
  if(restored?.ok!==true||String(restored.actualId||'')!==revision.sourceDraftId)missing.push('sourceDraftId');
  return missing;
}

async function mutateWechatChannels(){
  let before=await inspectWechatChannels();
  const coverRevision=typeof readBrowserCoverRevisionSource==='function'?readBrowserCoverRevisionSource():null;
  if(coverRevision){
    if(before.blocker)return before;
    const actions={coverOnly:true};
    const check=async current=>{const missing=wechatCoverOnlyMissingFields(current,coverRevision),guard=await inspectFinalPublishGuard();if(guard.armed!==true||guard.blockedAttempts!==0)missing.push('safety');return {missing,guard}};
    let checked=await check(before);
    if(checked.missing.length)return {...before,blocker:typedBlocker('STATE_AMBIGUOUS','视频号封面替换时原稿字段、原生 ID 或安全状态发生变化；禁止同时修改其他字段',{evidence:checked})};
    if(before.gates.noBlockingDialog?.ok!==true){
      const dialogs=before.gates.noBlockingDialog?.evidence?.active||[];
      const onlyCoverEditor=dialogs.length>0&&dialogs.every(item=>/编辑个人主页卡片|编辑分享卡片|编辑封面|裁剪封面图/.test(item.text||'')&&/上传封面|从视频中选择封面|裁剪封面图/.test(item.text||''));
      if(!onlyCoverEditor)return {...before,blocker:typedBlocker('STATE_AMBIGUOUS','视频号封面替换遇到非封面弹窗；禁止继续修改',{evidence:before.gates.noBlockingDialog?.evidence})};
      actions.coverRecovery=await dismissWechatCoverEditor();
      if(!actions.coverRecovery.ok)return {...(await inspectWechatChannels()),actions,blocker:typedBlocker('STATE_AMBIGUOUS',actions.coverRecovery.reason,{retryable:true,evidence:actions.coverRecovery})};
      before=await inspectWechatChannels();
      if(before.blocker)return {...before,actions};
      checked=await check(before);
      if(checked.missing.length||before.gates.noBlockingDialog?.ok!==true)return {...before,actions,blocker:typedBlocker('STATE_AMBIGUOUS','视频号封面弹窗恢复后原稿或安全状态未通过；禁止继续修改',{evidence:checked})};
    }
    // The original-resource cover revision may not repair metadata or rights.
    return await finishWechatCoverMutation(before,actions);
  }
  if(before.blocker)return before;
  if(!before.gates.draftIdentity.ok)return {...before,blocker:typedBlocker(before.gates.draftIdentity.evidence?.ambiguous?'STATE_AMBIGUOUS':'FOREIGN_DRAFT','视频号无法证明当前已上传草稿属于本任务',{evidence:before.gates.draftIdentity.evidence})};
  if(!before.gates.video.ok)return {...before,blocker:typedBlocker('STATE_AMBIGUOUS','视频号没有可修复的已上传视频')};
  const actions={};
  if(!before.gates.noBlockingDialog.ok&&before.gates.noBlockingDialog.evidence?.active?.some(item=>/编辑个人主页卡片|编辑分享卡片|裁剪封面图/.test(item.text||''))){
    actions.coverRecovery=await dismissWechatCoverEditor();
    if(!actions.coverRecovery.ok)return {...(await inspectWechatChannels()),blocker:typedBlocker('STATE_AMBIGUOUS',actions.coverRecovery.reason,{retryable:true,evidence:actions.coverRecovery})};
    before=await inspectWechatChannels();
    if(before.blocker)return before;
  }
  if(!before.gates.noBlockingDialog.ok)return {...before,blocker:typedBlocker('STATE_AMBIGUOUS','视频号存在未识别的阻塞弹窗',{retryable:true,evidence:before.gates.noBlockingDialog.evidence})};
  const metadata=await ensureWechatEarlyMetadata(before);
  Object.assign(actions,metadata.actions);
  if(!metadata.ok)return {...metadata.current,actions,blocker:metadata.blocker};
  before=metadata.current;
  if (!before.gates.aiGenerated.ok) {
    actions.aiGenerated=await ensureWechatAiGenerated();
    if(!actions.aiGenerated.ok){
      const afterAi=await inspectWechatChannels();
      return {...afterAi,actions,blocker:typedBlocker('SELECTOR_DRIFT',actions.aiGenerated.reason||'视频号AI生成标注控件尚未完成独立核验，保留当前草稿',{evidence:actions.aiGenerated.evidence||before.gates.aiGenerated.evidence})};
    }
    before=await inspectWechatChannels();
    if(before.blocker)return {...before,actions};
  }
  actions.original=await ensureWechatOriginal();
  if(!actions.original.ok){
    const afterOriginal=await inspectWechatChannels();
    if(afterOriginal.blocker)return afterOriginal;
    return {...afterOriginal,blocker:typedBlocker('ACTION_FAILED',actions.original.reason||'视频号原创声明没有完成',{evidence:actions.original})};
  }
  return await finishWechatCoverMutation(before,actions);
}

async function finishWechatCoverMutation(before,actions={}){
  const live=await inspectWechatChannels();
  if(live.blocker)return {...live,actions};
  if(!live.gates.video.ok)return {...live,actions,blocker:typedBlocker('STATE_AMBIGUOUS','视频号视频尚未上传完成；禁止编辑封面',{retryable:true,evidence:live.gates.video.evidence})};
  before=live;
  const receipts={};
  if(wechatCustomCover){
    const combined=before.gates.cover.evidence?.layout==='combined_3x4';
    const assets=combined?wechatCoverAssets.filter(asset=>asset.slot==='vertical'):wechatCoverAssets;
    receipts.cover={layout:combined?'combined_3x4':'separate',slots:{}};
    for(const asset of assets){
      const uploaded=await uploadWechatCover(asset);
      (actions.covers||=[]).push({asset,...uploaded});
      if(!uploaded.ok){
        const afterCover=await inspectWechatChannels();
        if(afterCover.blocker)return afterCover;
        return {...afterCover,blocker:typedBlocker('PLATFORM_REJECTED_ASSET',uploaded.reason,{retryable:true,evidence:uploaded})};
      }
      receipts.cover.slots[asset.slot]=uploaded.receipt;
      actions.receiptCheckpoint=checkpointReceipts({...expectedReceipts,...receipts});
    }
    expectedReceipts.cover=receipts.cover;
  }
  actions.receiptCheckpoint=checkpointReceipts({...expectedReceipts,...receipts});
  const after=await inspectWechatChannels();
  return {...after,actions,receipts};
}

async function runPlatformPhase(){if(phase==='inspect'||phase==='verify')return await inspectWechatChannels();if(phase==='upload_start')return await startWechatChannelsUpload();if(phase==='prefill')return await prefillWechatChannels();if(phase==='upload')return await uploadWechatChannels();if(phase==='mutate')return await mutateWechatChannels();return {...(await inspectWechatChannels()),blocker:typedBlocker('ACTION_FAILED',`unsupported WeChat phase: ${phase}`)}}

async function readWechatVideoRevisionNative(){
  return await js(String.raw`(() => {
    const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)],all=roots.flatMap(root=>[...root.querySelectorAll('*')]);
    const save=all.find(el=>el.tagName==='BUTTON'&&String(el.innerText||'').trim()==='保存草稿');
    let vm=save?.parentElement?.__vue__;while(vm&&!vm.draftStore)vm=vm.$parent;
    const material=all.map(el=>el.__vue__).find(v=>Array.isArray(v?.fileList)&&typeof v.handleDeleteFile==='function'&&v.postStore);
    const media=material?.postStore?.postObjDesc?.media||[],fileList=material?.fileList||[],m=media[0]||{},f=fileList[0]||{};
    return {draftId:String(vm?.draftStore?.objectId||''),mediaCount:media.length,fileCount:fileList.length,
      nativeFileIds:media.length===1&&m.md5sum?['md5sum:'+String(m.md5sum)]:[],
      nativeSize:Number(m.fileSize||0),width:Number(m.width||0),height:Number(m.height||0),duration:Number(m.videoPlayLen||0),
      uploadComplete:media.length===1&&fileList.length===1&&f.status==='done'&&String(m.md5sum||'')===String(f.uuid||''),
      selectedFile:{name:String(f.name||''),size:Number(f.size||0),lastModified:Number(f.lastModified||0)},
      mediaObjectId:String(m._objectId||''),cdnTaskId:String(m.urlCdnTaskId||''),published:vm?.draftStore?.post?.isPublished===true,
      materialReady:Boolean(material)};
  })()`);
}

function wechatReplacementMetadata(observation){
  return {description:observation.gates.description?.evidence?.actual,shortTitle:observation.gates.shortTitle?.evidence?.actual,
    original:observation.gates.original?.evidence?.enabled===true};
}

function wechatReplacementCoverAssets(){
  return wechatCoverAssets.map(asset=>{const bytes=fs.readFileSync(asset.path);return {...asset,sha256:createHash('sha256').update(bytes).digest('hex'),
    dataUrl:'data:image/'+(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':bytes[0]===255?'jpeg':'webp')+';base64,'+bytes.toString('base64')};});
}

function wechatReplacementLocalFile(){
  const stat=fs.statSync(localMediaMetadata.path);
  return {path:localMediaMetadata.path,size:stat.size,lastModified:Math.trunc(stat.mtimeMs),
    sha256:createHash('sha256').update(fs.readFileSync(localMediaMetadata.path)).digest('hex')};
}

function wechatReplacementCoverHash(){
  return videoReplacementSnapshotHash(wechatReplacementCoverAssets().map(({slot,path,ratio,sha256})=>({slot,path,ratio,sha256})));
}

async function compareWechatReplacementCoverPixels(observation){
  if(observation.gates.cover?.ok!==true)return {ok:false,reason:'native custom cover contract failed'};
  const assets=wechatReplacementCoverAssets();
  const layout=observation.gates.cover.evidence?.layout;
  const required=layout==='combined_3x4'?assets.filter(a=>a.slot==='vertical'):assets;
  const pairs=required.map(asset=>({slot:asset.slot,source:asset.dataUrl,url:observation.gates.cover.evidence.urlsBySlot?.[asset.slot]?.[0]||'',assetSha256:asset.sha256}));
  return await js(String.raw`(async pairs=>{
    const load=src=>new Promise((resolve,reject)=>{const image=new Image();image.crossOrigin='anonymous';const timer=setTimeout(()=>reject(new Error('cover decode timed out')),12000);image.onload=()=>{clearTimeout(timer);resolve(image)};image.onerror=()=>{clearTimeout(timer);reject(new Error('cover decode failed'))};image.src=src});
    const sample=image=>{
      // The source is 1344/1792 px while WeChat exports 540/720 px. A single
      // giant default-quality draw aliases their text differently. Prefilter
      // in <=2x stages before sampling; comparison thresholds stay unchanged.
      let current=image,width=Number(image.naturalWidth||image.width),height=Number(image.naturalHeight||image.height);
      const draw=(input,w,h)=>{const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const context=canvas.getContext('2d',{willReadFrequently:true});context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.drawImage(input,0,0,w,h);return canvas};
      while(width>96||height>96){width=Math.max(48,Math.ceil(width/2));height=Math.max(48,Math.ceil(height/2));current=draw(current,width,height)}
      const canvas=draw(current,48,48),ctx=canvas.getContext('2d',{willReadFrequently:true});
      const rgba=ctx.getImageData(0,0,48,48).data,rgb=[],luma=[];for(let i=0;i<rgba.length;i+=4){rgb.push(rgba[i],rgba[i+1],rgba[i+2]);luma.push(.2126*rgba[i]+.7152*rgba[i+1]+.0722*rgba[i+2])}const mean=luma.reduce((a,b)=>a+b,0)/luma.length,std=Math.sqrt(luma.reduce((a,b)=>a+(b-mean)**2,0)/luma.length);return {rgb,luma,mean,std}};
    const results=[];for(const pair of pairs){try{if(!pair.url||!/^https:\/\//.test(pair.url))throw new Error('native cover URL missing');const a=sample(await load(pair.source)),b=sample(await load(pair.url));const rmse=Math.sqrt(a.rgb.reduce((sum,v,i)=>sum+(v-b.rgb[i])**2,0)/a.rgb.length),correlation=a.std*b.std?a.luma.reduce((sum,v,i)=>sum+(v-a.mean)*(b.luma[i]-b.mean),0)/a.luma.length/a.std/b.std:0;results.push({slot:pair.slot,assetSha256:pair.assetSha256,ok:a.std>8&&b.std>8&&rmse<=18&&correlation>=.97,rmse,correlation,nativeStd:b.std})}catch(error){results.push({slot:pair.slot,ok:false,reason:String(error.message||error)})}}return {ok:results.length>0&&results.every(item=>item.ok),slots:results};
  })(${JSON.stringify(pairs)})`);
}

async function wechatReplacementEvidence(journal,observation,native,normalization=null){
  const p=journal.plan,currentMetadataHash=videoReplacementSnapshotHash(wechatReplacementMetadata(observation)),currentCoverHash=wechatReplacementCoverHash();
  const nativeCoverPixels=await compareWechatReplacementCoverPixels(observation);
  return {...p,draftId:native.draftId,nativeFileIds:native.nativeFileIds,currentMetadataHash,currentCoverHash,nativeCoverPixels,
    metadataUnchanged:currentMetadataHash===p.sourceMetadataHash,coversUnchanged:currentCoverHash===p.sourceCoverHash&&nativeCoverPixels.ok===true,
    uploadComplete:native.uploadComplete&&(native.nativeSize===localMediaMetadata.size||normalization?.ok===true)&&native.width===localMediaMetadata.width&&native.height===localMediaMetadata.height,
    ...(normalization?.ok===true?{serverNormalization:normalization.evidence,nativeVideoSize:native.nativeSize}:{}),
    localFile:wechatReplacementLocalFile(),observedAt:new Date().toISOString()};
}

async function readWechatVideoReplacementProof(observation){
  const journal=readVideoReplacementJournal(videoReplacementJournalPath,{platform,fingerprint:jobFingerprint});
  if(!journal||journal.status!=='confirmed')return failedGate({reason:'Original WeChat video replacement is not confirmed'});
  const native=await readWechatVideoRevisionNative();
  const originalUploadIds=JSON.stringify(native.nativeFileIds)===JSON.stringify(journal.evidence.nativeFileIds);
  const normalization=!originalUploadIds&&typeof readWechatServerMediaNormalization==='function'
    ?readWechatServerMediaNormalization({journalPath:videoReplacementJournalPath,journal,native}):null;
  const evidence=await wechatReplacementEvidence(journal,observation,native,normalization);
  return !native.published&&native.draftId===journal.plan.sourceDraftId&&(originalUploadIds||normalization?.ok===true)
    &&validateVideoReplacementEvidence(evidence,journal.plan)
    ?okGate(evidence):failedGate({reason:'WeChat original objectId, new native file, metadata or cover pixels changed',draftId:native.draftId,nativeFileIds:native.nativeFileIds,nativeCoverPixels:evidence.nativeCoverPixels,
      ...(normalization?{serverNormalization:normalization}:{})});
}

async function clearWechatOriginalDraftVideo(sourceDraftId){
  return await js(String.raw`(async id=>{
    const roots=[document,...[...document.querySelectorAll('*')].map(el=>el.shadowRoot).filter(Boolean)],all=roots.flatMap(root=>[...root.querySelectorAll('*')]);
    const save=all.find(el=>el.tagName==='BUTTON'&&String(el.innerText||'').trim()==='保存草稿');let parent=save?.parentElement?.__vue__;while(parent&&!parent.draftStore)parent=parent.$parent;
    if(String(parent?.draftStore?.objectId||'')!==id)return {ok:false,reason:'original objectId changed before removing media'};
    const material=all.map(el=>el.__vue__).find(v=>Array.isArray(v?.fileList)&&typeof v.handleDeleteFile==='function'&&v.postStore);
    const wrap=roots.flatMap(root=>[...root.querySelectorAll('.post-edit-wrap.material-edit-wrap')]).find(el=>el.querySelector('video'));
    const previews=wrap?[...wrap.querySelectorAll('.post-media-preview-wrap')].filter(el=>typeof el.__vue__?.handleDelete==='function'):[];
    const preview=previews.length===1?previews[0].__vue__:null;
    const source=String(preview?.$options?.methods?.handleDelete||'');
    if(!material||material.fileList.length!==1||!preview||!source.includes('$emit("delete",0)'))return {ok:false,reason:'exact native single-video delete command unavailable'};
    // Observed native preview command emits delete(index 0); it does not reset draftStore.objectId.
    preview.handleDelete();await preview.$nextTick();
    const actualId=String(parent.draftStore.objectId||'');
    return {ok:actualId===id&&material.fileList.length===0,draftId:actualId,remaining:material.fileList.length};
  })(${JSON.stringify(sourceDraftId)})`);
}

async function replaceOriginalDraftVideo(){
  const r=readBrowserVideoRevisionSource(),identity={platform,fingerprint:jobFingerprint};
  let current=await inspectWechatChannels(),native=await readWechatVideoRevisionNative();
  if(!r||Number(activeTaskSpace.id)!==r.sourceTaskSpaceId||native.draftId!==r.sourceDraftId||native.published)
    return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','视频号替换未绑定授权的未发布原草稿 objectId')};
  let journal=readVideoReplacementJournal(videoReplacementJournalPath,identity);
  const recoveringIntent=journal?.status==='intent';
  if(journal?.status==='confirmed')return current.gates.replaceVideo?.ok?current:{...current,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','视频号已替换文件或原稿字段发生变化；禁止重传')};
  if(!journal){
    const missing=['authenticated','draftIdentity','video','description','shortTitle','aiGenerated','original','cover','noBlockingDialog','finalButton'].filter(key=>current.gates[key]?.ok!==true);
    const coverPixels=await compareWechatReplacementCoverPixels(current);
    if(missing.length||!coverPixels.ok||!native.uploadComplete||!native.nativeFileIds.length||localMediaMetadata?.sha256!==r.nextVideoIdentity.sha256)
      return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','视频号原稿字段、封面像素或新文件绑定未通过',{evidence:{missing,coverPixels}})};
    const originalEntries=await readWechatDraftList();
    if(originalEntries.filter(entry=>entry.objectId===r.sourceDraftId).length!==1)return {...current,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','视频号原草稿 ID 不在当前原生草稿列表中；禁止替换')};
    const local=wechatReplacementLocalFile();
    if(local.sha256!==r.nextVideoIdentity.sha256||local.size!==localMediaMetadata.size||local.lastModified!==localMediaMetadata.lastModified)return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','视频号批准的本地视频已发生变化')};
    const plan={sourceDraftId:r.sourceDraftId,sourceTaskSpaceId:r.sourceTaskSpaceId,sourceNativeFileIds:native.nativeFileIds,
      sourceVideoSha256:r.sourceVideoIdentity.sha256,nextVideoSha256:r.nextVideoIdentity.sha256,
      sourceMetadataHash:videoReplacementSnapshotHash(wechatReplacementMetadata(current)),sourceCoverHash:wechatReplacementCoverHash(),
      originalDraftVerified:true,liveSourceDraftId:native.draftId,nextVideoPath:localMediaMetadata.path,nextVideoSize:localMediaMetadata.size,nextVideoMtimeMs:localMediaMetadata.lastModified};
    // This durable intent precedes clearing current media and setting the new input.
    journal=beginVideoReplacement(videoReplacementJournalPath,identity,plan);
    const cleared=await clearWechatOriginalDraftVideo(r.sourceDraftId);
    if(!cleared.ok)return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','视频号原生清除视频命令未保持原稿身份',{evidence:cleared})};
    const injected=await injectWechatVideo();
    if(!injected.ok)return {...current,blocker:typedBlocker('UPLOAD_NOT_STARTED',injected.reason)};
  }
  for(let n=0;n<180;n++){
    await activateWechatLifecycle();native=await readWechatVideoRevisionNative();
    if(native.draftId!==r.sourceDraftId||native.published||native.mediaCount>1||native.fileCount>1)return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','视频号替换过程中原稿 ID 或单视频约束发生变化')};
    const changed=native.nativeFileIds.length===1&&native.nativeFileIds.every(id=>!journal.plan.sourceNativeFileIds.includes(id));
    if(changed&&native.uploadComplete){
      if(native.nativeSize!==localMediaMetadata.size||native.selectedFile.size!==localMediaMetadata.size)return {...current,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','视频号新视频原生字节大小不匹配批准文件')};
      current=await mutateWechatChannels();if(current.blocker)return current;
      native=await readWechatVideoRevisionNative();const evidence=await wechatReplacementEvidence(journal,current,native);
      if(!validateVideoReplacementEvidence(evidence,journal.plan))return {...current,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','视频号新版源文件、原文案或双封面像素未通过最终核对',{evidence:{nativeCoverPixels:evidence.nativeCoverPixels}})};
      journal=confirmVideoReplacement(videoReplacementJournalPath,identity,journal.attemptId,evidence);
      return await inspectWechatChannels();
    }
    if(n===0&&recoveringIntent&&!changed&&!native.uploadComplete)return {...current,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','视频号已有视频替换意图且来源尚无法确认；禁止自动再次注入')};
    if(n===0&&recoveringIntent&&native.uploadComplete&&!changed)return {...current,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','视频号原稿仍是旧文件；禁止自动重复注入')};
    await wait(5);
  }
  return {...(await inspectWechatChannels()),blocker:typedBlocker('UPLOAD_STALLED','视频号原稿视频替换尚未稳定完成；保留意图并仅允许核对')};
}
