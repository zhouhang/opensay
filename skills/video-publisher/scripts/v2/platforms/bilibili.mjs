const draftPersistenceContract = { idKeys: ['draftId'], saveLabels: ['存草稿'], listLabels: ['草稿'] };
const inspectPersistedPlatform = () => inspectBilibili();
const bilibiliTitle = pkg.platformTitle.bilibili;
const bilibiliDescription = pkg.bilibiliDescription;
const bilibiliTags = pkg.bilibiliTags;
const bilibiliAllowedAutoTags = pkg.bilibiliAllowedAutoTags;
const bilibiliSettings = pkg.platformSettings?.bilibili || {};
const bilibiliAiGenerated = bilibiliSettings.aiGenerated === true;
const bilibiliVideoName = videoPath.split('/').pop();
const bilibiliVideoStem = bilibiliVideoName.replace(/\.[^.]+$/,'');
const bilibiliCustomCover = pkg.cover?.uploadCustomCover === true;
const bilibiliCoverPath = String(pkg.cover?.horizontal4x3Path || '');

function readBilibiliCoverTransport() {
  const manifestPath = String(typeof bilibiliCoverTransportManifestPath !== 'undefined'
    ? bilibiliCoverTransportManifestPath
    : typeof process !== 'undefined' ? process.env?.VIDEO_PUBLISHER_BILIBILI_COVER_TRANSPORT_MANIFEST || '' : '');
  if (!manifestPath) return { ok: true, uploadPath: bilibiliCoverPath, transport: null };
  return readExplicitLosslessPngTransport({ manifestPath, sourcePath: bilibiliCoverPath, ratio: '4:3',
    reason: 'bilibili-native-webp-rejection' });
}

function bilibiliCoverTransportMatches(expected) {
  const manifestPath = String(typeof bilibiliCoverTransportManifestPath !== 'undefined'
    ? bilibiliCoverTransportManifestPath
    : typeof process !== 'undefined' ? process.env?.VIDEO_PUBLISHER_BILIBILI_COVER_TRANSPORT_MANIFEST || '' : '');
  if (!manifestPath) return !expected;
  return explicitCoverTransportMatches(expected, { manifestPath, sourcePath: bilibiliCoverPath, ratio: '4:3',
    reason: 'bilibili-native-webp-rejection' });
}

function readBilibiliCoverAsset() {
  try {
    const transportPlan = readBilibiliCoverTransport();
    if (!transportPlan.ok) return { ok: false, reason: `bilibili ${transportPlan.reason}` };
    const bytes = fs.readFileSync(bilibiliCoverPath);
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg'
        : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : '';
    if (!mime) return { ok: false, reason: 'bilibili approved cover image header is unsupported' };
    return { ok: true, assetPath: bilibiliCoverPath, assetHash: createHash('sha256').update(bytes).digest('hex'),
      uploadPath: transportPlan.uploadPath, transport: transportPlan.transport,
      dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
  } catch { return { ok: false, reason: 'bilibili approved cover image cannot be read' }; }
}

async function compareBilibiliCoverPixels(asset, target) {
  if (!asset?.ok) return { ok: false, reason: asset?.reason || 'bilibili approved cover is unavailable' };
  return await js(String.raw`(async (sourceDataUrl,target) => {
    const sampleWidth=64,sampleHeight=48;
    const load=src=>new Promise((resolve,reject)=>{
      const image=new Image();image.crossOrigin='anonymous';
      const timer=setTimeout(()=>reject(new Error('image decode timed out')),15000);
      image.onload=()=>{clearTimeout(timer);image.naturalWidth>0&&image.naturalHeight>0?resolve(image):reject(new Error('empty decoded image'))};
      image.onerror=()=>{clearTimeout(timer);reject(new Error('image decode failed'))};image.src=src;
    });
    const pixels=(image,requireRatio=true)=>{
      const width=Number(image.naturalWidth||image.width),height=Number(image.naturalHeight||image.height);
      if(!width||!height||(requireRatio&&width*3!==height*4))throw new Error('decoded cover is not exactly 4:3');
      const canvas=document.createElement('canvas');canvas.width=sampleWidth;canvas.height=sampleHeight;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)throw new Error('2d pixel readback unavailable');
      ctx.fillStyle='#fff';ctx.fillRect(0,0,sampleWidth,sampleHeight);ctx.drawImage(image,0,0,sampleWidth,sampleHeight);
      const rgba=ctx.getImageData(0,0,sampleWidth,sampleHeight).data,rgb=new Uint8Array(sampleWidth*sampleHeight*3),luma=[];
      for(let n=0;n<sampleWidth*sampleHeight;n++){rgb[n*3]=rgba[n*4];rgb[n*3+1]=rgba[n*4+1];rgb[n*3+2]=rgba[n*4+2];luma.push(.2126*rgba[n*4]+.7152*rgba[n*4+1]+.0722*rgba[n*4+2])}
      const mean=luma.reduce((sum,value)=>sum+value,0)/luma.length;
      const std=Math.sqrt(luma.reduce((sum,value)=>sum+(value-mean)**2,0)/luma.length);
      return {width,height,rgb,luma,mean,std};
    };
    const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    try{
      const source=pixels(await load(sourceDataUrl)),sourcePixelSha256=await digest(source.rgb);
      if(source.std<=8)return {ok:false,reason:'approved source cover is uniform or lacks measurable detail',sourceStd:source.std};
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<32||r.height<24)return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity||1)<=0)return false}return true};
      let images=[];
      if(target.url){if(!/^https:\/\/(?:archive\.)?biliimg\.com\//.test(target.url))throw new Error('native cover URL is outside the Bilibili image host');images=[{image:await load(target.url),identity:target.url}];}
      else{
        const editors=[...document.querySelectorAll(target.editorSelector)].filter(visible);
        if(editors.length!==1)throw new Error('native cover editor is missing or ambiguous');
        // Fabric's main paint canvases may be 16:9 even for a 4:3 export.
        // Upper interaction overlays and recommendation thumbnails are not source paint.
        images=[...editors[0].querySelectorAll('canvas.lower-canvas[data-fabric="main"]')].filter(visible)
          .map((image,index)=>({image,identity:'native-main-canvas:'+index}));
      }
      const candidates=[];
      for(const {image,identity} of images){
        try{
          const native=pixels(image,!target.editorSelector),nativePixelSha256=await digest(native.rgb);
          let squares=0,covariance=0;
          for(let n=0;n<source.rgb.length;n++)squares+=(source.rgb[n]-native.rgb[n])**2;
          for(let n=0;n<source.luma.length;n++)covariance+=(source.luma[n]-source.mean)*(native.luma[n]-native.mean);
          const rmse=Math.sqrt(squares/source.rgb.length),correlation=source.std>0&&native.std>0?covariance/source.luma.length/source.std/native.std:0;
          const comparisonMetrics={sampleWidth,sampleHeight,pixelMode:'RGB',sourceWidth:source.width,sourceHeight:source.height,nativeWidth:native.width,nativeHeight:native.height,
            sourceMean:source.mean,nativeMean:native.mean,sourceStd:source.std,nativeStd:native.std,rmse,correlation};
          const ok=native.std>8&&(Boolean(target.editorSelector)||rmse<=18&&correlation>=.97);
          candidates.push({ok,identity,key:identity+'|'+nativePixelSha256,sourcePixelSha256,nativePixelSha256,comparisonMetrics});
        }catch(error){candidates.push({ok:false,identity,reason:String(error.message||error)})}
      }
      const matching=candidates.filter(candidate=>candidate.ok);
      return matching.length?{ok:true,...matching[0],candidates}:{ok:false,reason:'native cover pixels do not match the approved source',sourcePixelSha256,candidates};
    }catch(error){return {ok:false,reason:String(error.message||error)}}
  })(${JSON.stringify(asset.dataUrl)},${JSON.stringify(target)})`);
}

function bilibiliCoverReceiptMatches(receipt, urls, asset, comparison) {
  const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  return Boolean(receipt?.version===2&&receipt.assetPath===bilibiliCoverPath&&receipt.ratio==='4:3'
    &&/^https:\/\/(?:archive\.)?biliimg\.com\//.test(receipt.afterUrl||'')&&urls.includes(receipt.afterUrl)
    &&asset?.ok&&isHash(receipt.assetHash)&&receipt.assetHash===asset.assetHash
    &&receipt.verification==='source-native-pixels-v1'&&receipt.sourcePreview?.fresh===true
    &&receipt.sourcePreview.assetHash===asset.assetHash&&receipt.sourcePreview.sourcePixelSha256===receipt.sourcePixelSha256
    &&comparison?.ok===true&&isHash(receipt.sourcePixelSha256)&&isHash(receipt.nativePixelSha256)
    &&receipt.sourcePixelSha256===comparison.sourcePixelSha256&&receipt.nativePixelSha256===comparison.nativePixelSha256
    &&JSON.stringify(receipt.comparisonMetrics)===JSON.stringify(comparison.comparisonMetrics)
    &&(typeof bilibiliCoverTransportMatches!=='function'||bilibiliCoverTransportMatches(receipt.transport || null)));
}

function bilibiliAiGeneratedGate(state) {
  if (!bilibiliAiGenerated) return okGate({ requested: false, skipped: true });
  return state.aiGenerated === true && state.noMark !== true
    ? okGate({ requested: true, enabled: true, label: state.aiGeneratedLabel || null })
    : failedGate({ requested: true, enabled: false, reason: 'B站AI生成标注尚未由页面控件独立确认', label: state.aiGeneratedLabel || null, declarationOptions: state.declarationOptions || [] });
}

function bilibiliOriginalGate(state) {
  const declarationOk = bilibiliAiGenerated ? state.aiGenerated === true && state.noMark !== true : state.noMark === true;
  const evidence = { noMark: state.noMark === true, aiGenerated: state.aiGenerated === true,
    requestedAiGenerated: bilibiliAiGenerated, selfMade: state.selfMade === true,
    aiGeneratedLabel: state.aiGeneratedLabel || null, inputValue: state.creationInput || '' };
  return declarationOk && state.selfMade === true ? okGate(evidence) : failedGate(evidence);
}

async function inspectBilibili() {
  const state=await js(String.raw`((expectedName,expectedStem,expectedTitle,expectedDescription,requestedTags,allowedAutoTags) => {
    const compact=v=>String(v||'').replace(/\s+/g,' ').trim();const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'};const text=compact(document.body?.innerText||'');
    const titleInput=[...document.querySelectorAll('input')].find(el=>(el.placeholder||'').includes('稿件标题'));const title=String(titleInput?.value||'').trim();
    const desc=compact([...document.querySelectorAll('.ql-editor[contenteditable="true"],[contenteditable="true"]')].find(el=>/ql-editor/.test(String(el.className||'')))?.innerText||'');
    const chips=[...document.querySelectorAll('#tag-container .tag-pre-wrp .label-item-v2-container')].map(el=>compact(el.querySelector('.label-item-v2-content')?.innerText||el.innerText||el.textContent||'')).filter(Boolean);
    const requestedLower=requestedTags.map(tag=>String(tag).toLowerCase());const allowedLower=allowedAutoTags.map(tag=>String(tag).toLowerCase());const missing=requestedTags.filter(tag=>!chips.some(chip=>chip.toLowerCase()===String(tag).toLowerCase()));const duplicates=chips.filter((v,i)=>chips.findIndex(x=>x.toLowerCase()===v.toLowerCase())!==i);const malformed=chips.filter(v=>requestedTags.some(tag=>v.toLowerCase()===String(tag+tag).toLowerCase()));const unexpected=chips.filter(tag=>!requestedLower.includes(tag.toLowerCase())&&!allowedLower.includes(tag.toLowerCase()));
    const declarationSelect=[...document.querySelectorAll('.bcc-select')].find(el=>el.querySelector('input[placeholder*="创作声明"]'));
    const declarationOptions=[...(declarationSelect?.querySelectorAll('.bcc-option,[role="option"]')||[])].map(el=>{const r=el.getBoundingClientRect(),style=getComputedStyle(el);return {text:compact(el.innerText||el.textContent||''),visible:r.width>4&&r.height>4&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity||1)>0,selected:el.getAttribute('aria-selected')==='true'||/selected|active/.test(String(el.className||''))}}).filter(item=>item.text);
    const creationInput=String([...document.querySelectorAll('input')].find(el=>(el.placeholder||'').includes('创作声明'))?.value||'');
    const tagInput=[...document.querySelectorAll('input')].find(el=>(el.placeholder||'').includes('按回车键Enter创建标签'));
    const selected=[...document.querySelectorAll('li,div,span,p')].map(el=>({text:compact(el.innerText||el.textContent||''),cls:String(el.className||''),aria:el.getAttribute('aria-selected')})).filter(item=>item.text&&(/selected/i.test(item.cls)||item.aria==='true'));
    const noMark=/内容无需标注/.test(creationInput)||selected.some(item=>item.text==='内容无需标注');
    const aiGenerated=/AI\s*生成内容|含(?:有)?\s*AI\s*生成|AI生成/.test(creationInput)||selected.some(item=>/AI\s*生成内容|含(?:有)?\s*AI\s*生成|AI生成/.test(item.text));
    const aiGeneratedLabel=creationInput.match(/[^，。；;]*AI\s*生成[^，。；;]*/i)?.[0]||selected.find(item=>/AI\s*生成内容|含(?:有)?\s*AI\s*生成|AI生成/.test(item.text))?.text||'';
    const selfMade=/内容为自制|未经作者允许，禁止转载/.test(creationInput)||selected.some(item=>/^内容为自制/.test(item.text)||/未经作者允许，禁止转载/.test(item.text));
    const anyUploaded=/上传完成/.test(text);const filenameVisible=text.includes(expectedName)||text.includes(expectedStem);const uploaded=anyUploaded&&filenameVisible;const uploading=/上传中|转码中|上传进度|\d{1,3}%/.test(text)&&!anyUploaded;const failed=/上传失败|网络错误/.test(text);
    const loginRequired=/扫码登录|请登录|登录后|安全验证|验证码/.test(text)&&!/发布视频|内容管理/.test(text);
    const restoreBanner=/本地浏览器存在.*未提交的视频|继续编辑/.test(text);const identityMatches=!restoreBanner&&(!anyUploaded||filenameVisible||title===expectedTitle);
    const coverRoot=document.querySelector('.cover-content .cover-main .cover-module-main');
    const urls=[...(coverRoot?.querySelectorAll('.cover-img,img,[style]')||[])].flatMap(el=>{const values=[];if(el.src)values.push(el.src);const bg=getComputedStyle(el).backgroundImage;const match=bg.match(/url\(["']?([^"')]+)/);if(match)values.push(match[1]);return values}).filter(src=>/blob:|biliimg|archive\.biliimg/.test(src));
    const dialogs=[...document.querySelectorAll('[role="dialog"],.bcc-dialog,.bcc-modal,[class*="modal-mask"],[class*="dialog-mask"]')].map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {text:compact(el.innerText||el.textContent||'').slice(0,500),cls:String(el.className||''),w:r.width,h:r.height,display:s.display,visibility:s.visibility,opacity:s.opacity}}).filter(item=>item.w>20&&item.h>20&&item.display!=='none'&&item.visibility!=='hidden'&&!(/leave-active/.test(item.cls)&&Number(item.opacity)===0));
    const earlyMutation={ready:Boolean(visible(titleInput)&&visible(tagInput)),uploading,uploaded,controls:{title:visible(titleInput),tags:visible(tagInput)}};
    return {text:text.slice(0,3000),title,desc,chips,missing,duplicates:[...new Set(duplicates)],malformed:[...new Set(malformed)],unexpected:[...new Set(unexpected)],creationInput,declarationOptions,noMark,aiGenerated,aiGeneratedLabel,selfMade,anyUploaded,uploaded,uploading,failed,filenameVisible,loginRequired,restoreBanner,identityMatches,coverUrls:[...new Set(urls)],dialogs,earlyMutation}
  })(${JSON.stringify(bilibiliVideoName)},${JSON.stringify(bilibiliVideoStem)},${JSON.stringify(bilibiliTitle)},${JSON.stringify(bilibiliDescription)},${JSON.stringify(bilibiliTags)},${JSON.stringify(bilibiliAllowedAutoTags)})`);
  const restoredIdentity=await readBiliRestoredIdentity();
  if(restoredIdentity.ok&&!state.uploading&&!state.failed)state.uploaded=true;
  if(restoredIdentity.existingDraft)state.identityMatches=restoredIdentity.ok;
  const buttons=await inspectFinalButtons(/^立即投稿$/);const finalButton=buttons.find(button=>button.buttonish)||buttons[0]||null;const receipt=expectedReceipts.cover||null;
  let coverComparison=null,customCoverOk=false;
  if(bilibiliCustomCover&&receipt?.assetHash&&state.coverUrls.includes(receipt.afterUrl)){
    const asset=readBilibiliCoverAsset();
    if(asset.ok&&asset.assetHash===receipt.assetHash){
      coverComparison=await compareBilibiliCoverPixels(asset,{url:receipt.afterUrl});
      const afterAsset=readBilibiliCoverAsset();
      customCoverOk=afterAsset.ok&&afterAsset.assetHash===asset.assetHash&&bilibiliCoverReceiptMatches(receipt,state.coverUrls,asset,coverComparison);
    }
  }
  const defaultCoverOk=!bilibiliCustomCover&&(/封面设置|更换封面|封面/.test(state.text));
  const observation={gates:{
    authenticated:state.loginRequired?failedGate({loginRequired:true}):okGate({url:PLATFORM_URLS.bilibili}),
    draftIdentity:state.identityMatches?okGate({filenameVisible:state.filenameVisible,title:state.title,restoredIdentity}):failedGate({foreign:true,title:state.title,expectedName:bilibiliVideoName,restoredIdentity}),
    video:state.uploaded&&!state.uploading&&!state.failed?okGate({filename:bilibiliVideoName,stable:true,anyUploaded:state.anyUploaded,filenameVisible:state.filenameVisible}):failedGate({uploaded:state.uploaded,uploading:state.uploading,failed:state.failed,restoreBanner:state.restoreBanner,anyUploaded:state.anyUploaded,filenameVisible:state.filenameVisible}),
    title:state.title===bilibiliTitle?okGate({expected:bilibiliTitle,actual:state.title}):failedGate({expected:bilibiliTitle,actual:state.title}),
    description:state.desc===compactText(bilibiliDescription)?okGate({expected:bilibiliDescription,actual:state.desc}):failedGate({expected:bilibiliDescription,actual:state.desc}),
    tags:state.missing.length===0&&state.malformed.length===0&&state.duplicates.length===0&&state.unexpected.length===0?okGate({requested:bilibiliTags,chips:state.chips,allowedAuto:bilibiliAllowedAutoTags}):failedGate({requested:bilibiliTags,chips:state.chips,missing:state.missing,malformed:state.malformed,duplicates:state.duplicates,unexpected:state.unexpected,allowedAuto:bilibiliAllowedAutoTags}),
    aiGenerated:bilibiliAiGeneratedGate(state),
    original:bilibiliOriginalGate(state),
    cover:customCoverOk||defaultCoverOk?okGate({custom:bilibiliCustomCover,urls:state.coverUrls,receipt,comparison:coverComparison}):failedGate({custom:bilibiliCustomCover,urls:state.coverUrls,receipt,comparison:coverComparison,reason:bilibiliCustomCover&&!receipt?'custom cover receipt missing':'cover source and native pixels not verified'}),
    noBlockingDialog:state.dialogs.length===0?okGate({active:[]}):failedGate({active:state.dialogs}),
    finalButton:finalButton&&!finalButton.disabled?okGate(finalButton):failedGate({buttons}),
  },evidence:{pageSample:state.text,earlyMutation:state.earlyMutation,nativeUploadIdentity:await readBilibiliVideoRevisionNative()}};
  if(typeof unsavedBilibiliTagRevisionContext!=='undefined'&&unsavedBilibiliTagRevisionContext){
    const binding=validateBilibiliUnsavedTagCorrection(observation.evidence.nativeUploadIdentity);
    if(!binding.ok)observation.blocker=typedBlocker('STATE_AMBIGUOUS','B站首次标签纠正与原上传身份不一致，禁止重传或保存',{evidence:binding});
  }
  if(typeof readBrowserVideoRevisionSource==='function'&&readBrowserVideoRevisionSource()){
    observation.gates.replaceVideo=await readBilibiliVideoReplacementProof(observation);
    if(observation.gates.replaceVideo.ok)observation.gates.video.evidence.replacement=observation.gates.replaceVideo.evidence;
  }
  return observation;
}

async function resumeBilibiliLocalDraftIfPresent(){return await js(String.raw`(() => {const c=v=>String(v||'').replace(/\s+/g,' ').trim();const button=[...document.querySelectorAll('button,[role="button"],div,span')].find(el=>c(el.innerText||el.textContent||'')==='继续编辑'&&el.getBoundingClientRect().width>10);if(!button)return {ok:true,skipped:true};button.click();return {ok:true,clicked:true}})()`)}

async function activateBilibiliUploadLifecycle(){
  await cdp('Page.bringToFront',{});
  await cdp('Page.setWebLifecycleState',{state:'active'});
  await cdp('Emulation.setFocusEmulationEnabled',{enabled:true});
  return await js(String.raw`(() => ({url:location.href,readyState:document.readyState,visibilityState:document.visibilityState,hasFocus:document.hasFocus()}))()`);
}

async function exposeBilibiliVideoInput(){
  return await js(String.raw`(() => {
    const compact=value=>String(value||'').replace(/\s+/g,' ').trim();
    const videoLike=el=>/\.(mp4|flv|avi|wmv|mov|webm|mkv|m4v|ts|mpg|rmvb)\b/i.test(el.accept||'');
    for(const stale of document.querySelectorAll('#vp2-bili-video'))stale.removeAttribute('id');
    const input=[...document.querySelectorAll('.bcc-upload-wrapper input[type=file]')].find(videoLike);
    const evidence={url:location.href,readyState:document.readyState,visibilityState:document.visibilityState,hasFocus:document.hasFocus(),bodySample:compact(document.body?.innerText||'').slice(0,280)};
    if(!input)return {ok:false,reason:'bilibili video input missing',...evidence};
    input.id='vp2-bili-video';
    const parentRect=input.parentElement?.getBoundingClientRect();
    return {ok:true,selector:'#vp2-bili-video',accept:input.accept||'',parentWidth:Math.round(parentRect?.width||0),parentHeight:Math.round(parentRect?.height||0),...evidence};
  })()`);
}

async function waitForBilibiliUploadEntry(){
  const probes=[];
  let navigationAttempts=0;
  let restoreAttempts=0;
  for(let attempt=1;attempt<=24;attempt+=1){
    if(attempt===1||attempt%4===0)await activateBilibiliUploadLifecycle();
    const current=await inspectBilibili();
    const videoEvidence=current.gates.video.evidence||{};
    if(!current.gates.authenticated.ok){
      return {kind:'blocked',current,blocker:typedBlocker('AUTH_REQUIRED','B站登录状态失效',{requiresUser:true,evidence:current.gates.authenticated.evidence}),recovery:{attempt,navigationAttempts,restoreAttempts,probes:probes.slice(-8)}};
    }
    if(current.gates.video.ok)return {kind:'ready',current,recovery:{attempt,navigationAttempts,restoreAttempts,probes:probes.slice(-8)}};
    if(videoEvidence.restoreBanner){
      if(restoreAttempts<2){
        const resumed=await resumeBilibiliLocalDraftIfPresent();
        restoreAttempts+=1;
        probes.push({attempt,action:'resume_local_draft',ok:resumed.ok,clicked:resumed.clicked===true});
        if(!resumed.ok)return {kind:'blocked',current,blocker:typedBlocker('ACTION_FAILED',resumed.reason||'B站本地草稿恢复失败',{retryable:true,evidence:resumed}),recovery:{attempt,navigationAttempts,restoreAttempts,probes:probes.slice(-8)}};
      }
      await wait(2);
      continue;
    }
    if(!current.gates.draftIdentity.ok){
      return {kind:'blocked',current,blocker:typedBlocker('FOREIGN_DRAFT','B站当前编辑器属于其他视频草稿',{retryable:true,evidence:current.gates.draftIdentity.evidence}),recovery:{attempt,navigationAttempts,restoreAttempts,probes:probes.slice(-8)}};
    }
    if(videoEvidence.uploading===true)return {kind:'uploading',current,recovery:{attempt,navigationAttempts,restoreAttempts,probes:probes.slice(-8)}};
    let exposed=await exposeBilibiliVideoInput();
    if(exposed.ok&&(exposed.visibilityState!=='visible'||exposed.hasFocus!==true)){
      await activateBilibiliUploadLifecycle();
      exposed=await exposeBilibiliVideoInput();
    }
    probes.push({attempt,ok:exposed.ok,url:exposed.url,readyState:exposed.readyState,visibilityState:exposed.visibilityState,hasFocus:exposed.hasFocus,reason:exposed.reason||null});
    if(exposed.ok)return {kind:'input',current,exposed,recovery:{attempt,navigationAttempts,restoreAttempts,probes:probes.slice(-8)}};
    if(attempt===6&&navigationAttempts===0&&videoEvidence.anyUploaded!==true){
      navigationAttempts+=1;
      probes.push({attempt,action:'navigate_upload_url',url:PLATFORM_URLS.bilibili});
      await gotoAndWait(PLATFORM_URLS.bilibili,{timeout:45,settle:2});
      const guard=await armFinalPublishGuard();
      if(!guard.ok||!guard.armed){
        const currentAfterNavigation=await inspectBilibili();
        return {kind:'blocked',current:currentAfterNavigation,blocker:typedBlocker('INPUT_CHANNEL_BROKEN','B站定向恢复后无法重新挂载最终发布保护',{retryable:true,evidence:guard}),recovery:{attempt,navigationAttempts,restoreAttempts,probes:probes.slice(-8)}};
      }
      await activateBilibiliUploadLifecycle();
      await wait(2);
      continue;
    }
    await wait(2);
  }
  const current=await inspectBilibili();
  const recovery={attempt:24,navigationAttempts,restoreAttempts,probes:probes.slice(-8)};
  return {kind:'blocked',current,blocker:typedBlocker('SELECTOR_DRIFT','B站上传页在等待和一次定向恢复后仍未出现真实视频输入框',{retryable:true,evidence:recovery}),recovery};
}

async function waitBilibiliUploadCompletion(mode,entryRecovery=null){let stableSince=0;for(let i=0;i<180;i+=1){const current=await inspectBilibili();if(current.gates.video.ok){if(!stableSince)stableSince=Date.now();if(Date.now()-stableSince>=10000)return {...current,actions:{upload:{mode,entryRecovery}}}}else stableSince=0;await wait(5)}const after=await inspectBilibili();return {...after,actions:{upload:{mode,entryRecovery}},blocker:typedBlocker('UPLOAD_STALLED','B站视频没有在等待窗口内稳定完成',{retryable:true,evidence:after.gates.video.evidence})}}

async function waitForBilibiliUploadStart(){
  for(let attempt=1;attempt<=20;attempt+=1){
    const current=await inspectBilibili();
    if(current.gates.video.ok||current.gates.video.evidence?.uploading===true)return {ok:true,current,attempt};
    if(current.gates.video.evidence?.failed===true)return {ok:false,current,attempt,reason:'B站在文件注入后报告上传失败'};
    await wait(1);
  }
  const current=await inspectBilibili();
  return {ok:false,current,attempt:20,reason:'B站在文件注入后 20 秒内没有进入上传状态'};
}

async function uploadBilibili(){
  const entry=await waitForBilibiliUploadEntry();
  if(entry.kind==='blocked')return {...entry.current,uploadEntryRecovery:entry.recovery,blocker:entry.blocker};
  if(entry.kind==='ready')return {...entry.current,actions:{upload:{mode:'already_ready',entryRecovery:entry.recovery}}};
  if(entry.kind==='uploading')return await waitBilibiliUploadCompletion('resume_existing',entry.recovery);
  await activateBilibiliUploadLifecycle();
  const liveExposed=await exposeBilibiliVideoInput();
  if(!liveExposed.ok)return {...entry.current,uploadEntryRecovery:entry.recovery,blocker:typedBlocker('UPLOAD_NOT_STARTED',liveExposed.reason,{retryable:true,evidence:liveExposed})};
  try{await uploadFile(liveExposed.selector,videoPath)}catch(error){return {...entry.current,uploadEntryRecovery:entry.recovery,blocker:typedBlocker('UPLOAD_NOT_STARTED',String(error?.message||error),{retryable:true,evidence:liveExposed})}}
  const started=await waitForBilibiliUploadStart();
  if(!started.ok)return {...started.current,actions:{upload:{mode:'injected',entryRecovery:entry.recovery}},blocker:typedBlocker('UPLOAD_NOT_STARTED',started.reason,{retryable:true,evidence:{attempt:started.attempt,video:started.current.gates.video.evidence,liveExposed}})};
  return await waitBilibiliUploadCompletion('injected',entry.recovery);
}

async function waitBilibiliEarlyMutationReady(mode,entryRecovery=null){
  for(let attempt=1;attempt<=30;attempt+=1){
    const current=await inspectBilibili();
    if(!current.gates.authenticated.ok)return {...current,blocker:typedBlocker('AUTH_REQUIRED','B站登录状态失效',{requiresUser:true,evidence:current.gates.authenticated.evidence})};
    if(current.gates.video.ok)return {...current,actions:{upload:{mode,stage:'complete',earlyMutationReady:true,entryRecovery}}};
    if(current.gates.video.evidence?.failed===true)return {...current,blocker:typedBlocker('UPLOAD_NOT_STARTED','B站上传失败',{retryable:true,evidence:current.gates.video.evidence})};
    if(current.gates.video.evidence?.uploading===true&&current.evidence?.earlyMutation?.ready===true){
      return {...current,actions:{upload:{mode,stage:'editable_uploading',earlyMutationReady:true,entryRecovery}}};
    }
    await wait(1);
  }
  const after=await inspectBilibili();
  return {...after,blocker:typedBlocker('UPLOAD_NOT_STARTED','B站上传启动后标题与标签控件未及时就绪',{retryable:true,evidence:after.evidence?.earlyMutation})};
}

async function startBilibiliUpload(){
  const entry=await waitForBilibiliUploadEntry();
  if(entry.kind==='blocked')return {...entry.current,uploadEntryRecovery:entry.recovery,blocker:entry.blocker};
  if(entry.kind==='ready')return {...entry.current,actions:{upload:{mode:'already_ready',stage:'complete',earlyMutationReady:true,entryRecovery:entry.recovery}}};
  if(entry.kind==='uploading')return await waitBilibiliEarlyMutationReady('resume_existing',entry.recovery);
  await activateBilibiliUploadLifecycle();
  const liveExposed=await exposeBilibiliVideoInput();
  if(!liveExposed.ok)return {...entry.current,uploadEntryRecovery:entry.recovery,blocker:typedBlocker('UPLOAD_NOT_STARTED',liveExposed.reason,{retryable:true,evidence:liveExposed})};
  try{await uploadFile(liveExposed.selector,videoPath)}catch(error){return {...entry.current,uploadEntryRecovery:entry.recovery,blocker:typedBlocker('UPLOAD_NOT_STARTED',String(error?.message||error),{retryable:true,evidence:liveExposed})}}
  const started=await waitForBilibiliUploadStart();
  if(!started.ok)return {...started.current,actions:{upload:{mode:'injected',entryRecovery:entry.recovery}},blocker:typedBlocker('UPLOAD_NOT_STARTED',started.reason,{retryable:true,evidence:{attempt:started.attempt,video:started.current.gates.video.evidence,liveExposed}})};
  return await waitBilibiliEarlyMutationReady('injected',entry.recovery);
}

async function setBilibiliDescriptionV2(){
  const write=await js(String.raw`((value) => {const compact=v=>String(v||'').replace(/\s+/g,' ').trim();const container=document.querySelector('.ql-container');if(!container?.__quill||typeof container.__quill.setText!=='function'||typeof container.__quill.getText!=='function')return {ok:false,reason:'bilibili Quill description model missing'};container.__quill.setText(value,'user');const immediateRaw=String(container.__quill.getText()||'');const immediate=compact(immediateRaw);const expected=compact(value);return {ok:immediate===expected,expected,immediate,immediateRaw,source:'ql-container.__quill.getText'}})(${JSON.stringify(bilibiliDescription)})`);
  if(!write.ok)return {...write,reason:write.reason||'bilibili Quill description did not retain the exact text immediately'};
  await wait(1);
  const after=await inspectBilibili();
  return {...write,ok:after.gates.description.ok,reason:after.gates.description.ok?null:'bilibili description gate did not persist after Quill update',evidence:after.gates.description.evidence};
}

// The creation-declaration list is rendered inside .bcc-select but stays collapsed
// until the select is really opened; a closed list is not selector drift.
async function openBilibiliCreationDeclarationV2(){
  const located=await js(String.raw`(() => {
    const compact=v=>String(v||'').replace(/\s+/g,' ').trim();
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0};
    const input=[...document.querySelectorAll('input')].find(el=>(el.placeholder||'').includes('创作声明'));
    const select=input?.closest('.bcc-select');
    if(!input||!select)return {ok:false,reason:'bilibili creation declaration select missing'};
    const options=[...select.querySelectorAll('.bcc-option,[role="option"]')];
    if(options.some(visible))return {ok:true,alreadyOpen:true,visibleCount:options.filter(visible).length};
    const wrap=input.closest('.bcc-select-input-wrap')||input;
    const r=wrap.getBoundingClientRect();
    if(!(r.width>4&&r.height>4))return {ok:false,reason:'bilibili creation declaration control is not visibly actionable'};
    return {ok:true,point:{x:r.left+r.width/2,y:r.top+r.height/2},knownOptions:options.map(el=>compact(el.innerText||el.textContent||'')).filter(Boolean)};
  })()`);
  if(!located.ok||located.alreadyOpen)return located;
  try{await click([located.point.x,located.point.y],{label:'open bilibili creation declaration'})}
  catch(error){return {ok:false,reason:'bilibili creation declaration dropdown click failed: '+String(error?.message||error)}}
  let probe={visibleCount:0,knownOptions:located.knownOptions||[]};
  for(let poll=0;poll<12;poll+=1){
    await wait(.25);
    probe=await js(String.raw`(() => {
      const compact=v=>String(v||'').replace(/\s+/g,' ').trim();
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0};
      const select=[...document.querySelectorAll('.bcc-select')].find(el=>el.querySelector('input[placeholder*="创作声明"]'));
      const options=[...(select?.querySelectorAll('.bcc-option,[role="option"]')||[])];
      return {visibleCount:options.filter(visible).length,visibleOptions:options.filter(visible).map(el=>compact(el.innerText||el.textContent||'')).filter(Boolean),total:options.length};
    })()`);
    if(probe.visibleCount>0)return {ok:true,opened:true,...probe};
  }
  return {ok:false,reason:'bilibili creation declaration options did not become visible',...probe};
}

async function applyBilibiliAiDeclarationV2(){
  return await js(String.raw`(() => {
    const compact=v=>String(v||'').replace(/\s+/g,' ').trim();
    const aiLabel=/^(?:AI\s*(?:辅助)?生成内容|含(?:有)?\s*AI\s*生成(?:内容)?|AI生成)$/i;
    const input=[...document.querySelectorAll('input')].find(el=>(el.placeholder||'').includes('创作声明'));
    const select=input?.closest('.bcc-select');
    if(!input||!select)return {ok:false,code:'SELECTOR_DRIFT',reason:'bilibili AI generation declaration control missing'};
    const current=compact(input.value||select.__vue__?.selectedLabel||'');
    const selectedCurrent=aiLabel.test(current);
    let declaration=selectedCurrent,selectedLabel=current,changed=false;
    if(!declaration){
      const pool=[...new Set([...(select.querySelectorAll('.bcc-option,[role="option"]')||[]),
        ...[...document.querySelectorAll('.bcc-select-dropdown .bcc-option,[role="listbox"] [role="option"]')].filter(el=>!select.contains(el))])];
      const options=pool.filter(el=>{
        const r=el.getBoundingClientRect(),style=getComputedStyle(el),text=compact(el.innerText||el.textContent||'');
        return aiLabel.test(text)&&r.width>4&&r.height>4&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity||1)>0;
      });
      if(options.length===0)return {ok:false,code:'NEED_OPEN',reason:'bilibili AI generation declaration options are collapsed',optionCount:0,current,knownOptions:pool.map(el=>compact(el.innerText||el.textContent||'')).filter(Boolean)};
      if(options.length>1)return {ok:false,code:'SELECTOR_DRIFT',reason:'bilibili AI generation declaration is ambiguous',optionCount:options.length,current};
      const option=options[0],label=compact(option.innerText||option.textContent||'');
      if(typeof option.__vue__?.selectOptionClick==='function')option.__vue__.selectOptionClick();
      else { input.closest('.bcc-select-input-wrap')?.click?.(); option.click(); }
      selectedLabel=compact(input.value||select.__vue__?.selectedLabel||label);declaration=aiLabel.test(selectedLabel);changed=true;
    }
    const container=[...document.querySelectorAll('.creation-statement-container')].find(el=>compact(el.innerText||el.textContent||'').includes('内容为自制'));
    let selfMade=Boolean(container?.__vue__?.isAuthChecked);
    if(!selfMade&&typeof container?.__vue__?.handleAuthCheckboxClick==='function'){container.__vue__.handleAuthCheckboxClick({stopPropagation(){},preventDefault(){},target:container});selfMade=Boolean(container.__vue__.isAuthChecked)}
    if(!selfMade){
      const target=[...document.querySelectorAll('.auth-content,.option-text,label,span,div')].find(el=>compact(el.innerText||el.textContent||'').startsWith('内容为自制'));
      const row=target?.closest('label,[class*="radio"],[class*="check"],.auth-content')||target;
      if(!row)return {ok:false,code:'SELECTOR_DRIFT',reason:'bilibili self-made declaration control missing',declaration,selectedLabel,changed};
      row.click();selfMade=Boolean(container?.__vue__?.isAuthChecked);
    }
    return {ok:declaration&&selfMade,changed,declaration,selectedLabel,selfMade};
  })()`);
}

async function ensureBilibiliAiDeclarationV2(){
  let result=await applyBilibiliAiDeclarationV2();
  let opened=null;
  if(!result.ok&&result.code==='NEED_OPEN'){
    opened=await openBilibiliCreationDeclarationV2();
    if(!opened.ok)return {ok:false,code:'SELECTOR_DRIFT',reason:'bilibili AI generation declaration option missing',open:opened,initial:result};
    await wait(.4);
    result=await applyBilibiliAiDeclarationV2();
  }
  const open=opened&&!opened.alreadyOpen?opened:undefined;
  if(!result.ok)return {...result,open};
  await wait(1);
  const after=await inspectBilibili();
  return {...result,open,ok:after.gates.original.ok&&after.gates.aiGenerated.ok,evidence:after.gates.original.evidence,aiGeneratedEvidence:after.gates.aiGenerated.evidence};
}

async function ensureBilibiliDeclarationV2(){
  if(bilibiliAiGenerated)return await ensureBilibiliAiDeclarationV2();
  const result=await js(String.raw`(() => {const compact=v=>String(v||'').replace(/\s+/g,' ').trim();const input=[...document.querySelectorAll('input')].find(el=>(el.placeholder||'').includes('创作声明'));const select=input?.closest('.bcc-select');let noMark=false;const option=[...(select?.querySelectorAll('.bcc-option')||[])].find(el=>compact(el.innerText||el.textContent||'')==='内容无需标注');if(/内容无需标注/.test(input?.value||''))noMark=true;else if(select?.__vue__&&option?.__vue__?.selectOptionClick){option.__vue__.selectOptionClick();noMark=/内容无需标注/.test(input?.value||select.__vue__.selectedLabel||'')}else{(input?.closest('.bcc-select-input-wrap')||select||input)?.click();const visible=[...document.querySelectorAll('.bcc-option')].find(el=>compact(el.innerText||el.textContent||'')==='内容无需标注');visible?.click();noMark=/内容无需标注/.test(input?.value||'')}
const container=[...document.querySelectorAll('.creation-statement-container')].find(el=>compact(el.innerText||el.textContent||'').includes('内容为自制'));let selfMade=Boolean(container?.__vue__?.isAuthChecked);if(!selfMade&&typeof container?.__vue__?.handleAuthCheckboxClick==='function'){container.__vue__.handleAuthCheckboxClick({stopPropagation(){},preventDefault(){},target:container});selfMade=Boolean(container.__vue__.isAuthChecked)}if(!selfMade){const target=[...document.querySelectorAll('.auth-content,.option-text,label,span,div')].find(el=>compact(el.innerText||el.textContent||'').startsWith('内容为自制'));(target?.closest('label,[class*="radio"],[class*="check"],.auth-content')||target)?.click()}
return {ok:noMark&&(selfMade||Boolean(container?.__vue__?.isAuthChecked)),noMark,selfMade:Boolean(selfMade||container?.__vue__?.isAuthChecked)}})()`);await wait(1);const after=await inspectBilibili();return {...result,ok:after.gates.original.ok,evidence:after.gates.original.evidence};
}

async function inspectBilibiliTagInputV2(){
  return await js(String.raw`(() => {
    const compact=value=>String(value||'').replace(/\s+/g,' ').trim();
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0};
    const input=[...document.querySelectorAll('input')].find(el=>(el.placeholder||'').includes('按回车键Enter创建标签'));
    const feedback=[...document.querySelectorAll('.toaster-v2-wrp .msg-text,.bcc-message,.bcc-toast,.bcc-notification,[role="alert"],[class*="toast"],[class*="message"],[class*="error"],[class*="tip"]')]
      .filter(visible).map(el=>compact(el.innerText||el.textContent||'')).filter(text=>text&&text.length<=240);
    const rejection=/((标签|tag).*(不可|不能|不允许|不支持|不符合|违规|敏感|封禁|达到上限|添加失败|创建失败|仅限|只支持))|((不可|不能|不允许).*(创建|添加).*(标签|tag))|(仅可|只能).*话题|同名话题|请(?:从|在)参与话题(?:中)?选择|从参与话题(?:中)?选择|最多(?:添加)?\d+个标签/i;
    const rejectionMessages=[...new Set(feedback.filter(text=>rejection.test(text)))];
    const topicOnlyMessages=[...new Set(feedback.filter(text=>text.includes('当前tag为话题专用，不允许自定义添加，可在话题搜索页进行搜索')))];
    const value=String(input?.value||'');const focused=document.activeElement===input;const inputVisible=visible(input);
    return {ok:Boolean(input),value,focused,visible:inputVisible,disabled:Boolean(input?.disabled)||input?.getAttribute('aria-disabled')==='true',checking:/标签正在请求校验中/.test(document.body?.innerText||'')||feedback.some(text=>/标签正在请求校验中/.test(text)),rawFeedback:[...new Set(feedback)],rejectionMessages,topicOnlyMessages,hint:!input?'tag input missing':!inputVisible?'tag input not visible':!focused?'tag input not focused':value?'tag input contains text':'tag input ready'};
  })()`);
}

async function waitForBilibiliTagSetStable(options={}){
  const stablePolls=Number(options.stablePolls||4);const maxPolls=Number(options.maxPolls||20);const snapshots=[];
  let lastSignature=null,consecutive=0,current=null,inputProbe=null;
  for(let poll=1;poll<=maxPolls;poll+=1){
    current=await inspectBilibili();inputProbe=await inspectBilibiliTagInputV2();
    const chips=current.gates.tags.evidence?.chips||[];const signature=JSON.stringify(chips.map(value=>String(value).toLowerCase()).sort());
    consecutive=signature===lastSignature&&inputProbe.checking!==true?consecutive+1:1;lastSignature=signature;
    snapshots.push({poll,chips:[...chips],checking:inputProbe.checking===true,inputVisible:inputProbe.visible===true,inputFocused:inputProbe.focused===true});
    if(consecutive>=stablePolls)return {ok:true,current,inputProbe,stablePolls:consecutive,snapshots:snapshots.slice(-8)};
    await wait(.5);
  }
  return {ok:false,reason:'bilibili tag set did not become stable',current,inputProbe,stablePolls:consecutive,snapshots:snapshots.slice(-8)};
}

async function removeOneBilibiliTagChipV2(target){
  return await js(String.raw`((target) => {const compact=v=>String(v||'').replace(/\s+/g,' ').trim();const matches=[...document.querySelectorAll('#tag-container .tag-pre-wrp .label-item-v2-container')].filter(el=>compact(el.querySelector('.label-item-v2-content')?.innerText||el.innerText||el.textContent||'').toLowerCase()===String(target).toLowerCase());const el=matches[0];if(!el)return {ok:false,reason:'unexpected bilibili tag chip missing',target};if(typeof el.__vue__?.close==='function')el.__vue__.close();else{const close=el.querySelector('.close,[class*="close"],svg');if(!close)return {ok:false,reason:'bilibili tag close control missing',target};close.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}))}return {ok:true,target,countBefore:matches.length}})(${JSON.stringify(target)})`);
}

function resolveBilibiliExactTopicCandidate(rows,tag){
  const lower=value=>String(value||'').trim().toLowerCase();
  const exact=(rows||[]).filter(row=>lower(row.name)===lower(tag));
  if(exact.length!==1)return {ok:false,requiresUser:true,reason:`B站话题搜索没有得到唯一精确同名项: ${tag}`,exactCount:exact.length,evidence:{tag,rows}};
  const candidate=exact[0];
  if(Number(candidate.topicId)===-1)return {ok:false,requiresUser:true,reason:`B站精确同名结果是创建话题行（topic_id=-1），不会点击: ${tag}`,exactCount:1,evidence:{tag,candidate}};
  if(!(Number(candidate.topicId)>0))return {ok:false,requiresUser:true,reason:`B站精确同名话题缺少有效 topic_id: ${tag}`,exactCount:1,evidence:{tag,candidate}};
  if(candidate.nonActivityProven!==true){const signals=candidate.activitySignals||[];return {ok:false,requiresUser:true,reason:signals.length?`B站精确同名话题带有活动语义: ${signals.join('；')}`:`B站精确同名话题无法证明非活动: ${tag}`,exactCount:1,evidence:{tag,candidate}}}
  return {ok:true,candidate,exactCount:1,evidence:{tag,candidate}};
}

function assessBilibiliExactTopicV2(tag,snapshot){
  const lower=value=>String(value||'').trim().toLowerCase();
  const rows=(snapshot?.rows||[]).filter(row=>lower(row.name)===lower(tag));
  const topics=(snapshot?.topics||[]).filter(topic=>lower(topic.topic_name)===lower(tag));
  const evidence={tag,rows:rows.map(row=>({name:row.name,selector:row.selector})),topics};
  if(rows.length!==1)return {ok:false,requiresUser:true,reason:`B站话题搜索没有得到唯一精确同名行: ${tag}`,exactCount:rows.length,evidence};
  if(topics.length!==1)return {ok:false,requiresUser:true,reason:`B站话题数据没有得到唯一精确同名项: ${tag}`,exactCount:topics.length,evidence};
  const topic=topics[0];
  const has=key=>Object.prototype.hasOwnProperty.call(topic,key);
  const safetyFieldsPresent=['topic_id','mission_id','show_activity_icon','activity_description','activity_text'].every(has);
  const activitySignals=[];
  if(Number(topic.mission_id)!==0)activitySignals.push(`mission_id=${String(topic.mission_id)}`);
  if(topic.show_activity_icon!==false)activitySignals.push(`show_activity_icon=${String(topic.show_activity_icon)}`);
  if(String(topic.activity_description||'').trim())activitySignals.push(`activity_description=${String(topic.activity_description).trim()}`);
  if(String(topic.activity_text||'').trim())activitySignals.push(`activity_text=${String(topic.activity_text).trim()}`);
  const nonActivityProven=safetyFieldsPresent&&activitySignals.length===0;
  const resolution=resolveBilibiliExactTopicCandidate([{name:rows[0].name,selector:rows[0].selector,topicId:topic.topic_id,nonActivityProven,activitySignals,topic}],tag);
  return resolution.ok?{...resolution,row:rows[0],topic,evidence}:{...resolution,evidence:{...evidence,safetyFieldsPresent,activitySignals}};
}

async function inspectBilibiliTopicDialogV2(){
  return await js(String.raw`(() => {
    const compact=value=>String(value||'').replace(/\s+/g,' ').trim();
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0};
    const wraps=[...document.querySelectorAll('.dialog.bcc-dialog__wrap,.bcc-dialog__wrap,[role="dialog"]')].filter(visible);
    const wrap=wraps.find(el=>el.querySelector('.topic-dialog,.topic-dialog-search')&&/参与话题/.test(compact(el.innerText||el.textContent||'')));
    const dialog=wrap?.querySelector('.topic-dialog')||wrap;
    const input=wrap?.querySelector('.topic-dialog-search input');
    const rows=[...(wrap?.querySelectorAll('.topic-dialog .dialog-item')||[])].filter(visible).map((el,index)=>{const name=compact(el.querySelector('.topic-tag-name')?.innerText||el.querySelector('.topic-tag-name')?.textContent||'');el.id='vp2-bilibili-topic-row-'+index;return {name,selector:'#vp2-bilibili-topic-row-'+index}}).filter(row=>row.name);
    const vueCandidates=[...document.querySelectorAll('.topic-dialog'),dialog,wrap,...(wrap?.querySelectorAll('*')||[])].map(el=>el?.__vue__).filter((candidate,index,list)=>candidate&&list.indexOf(candidate)===index);
    const topicVms=vueCandidates.filter(candidate=>Array.isArray(candidate?.topics)||Array.isArray(candidate?._data?.topics));
    const query=String(input?.value||'').trim().toLowerCase();
    const boundVms=topicVms.filter(candidate=>String(candidate?.keyName??candidate?._data?.keyName??'').trim().toLowerCase()===query&&(candidate?.topics||candidate?._data?.topics||[]).length>0);
    const vm=boundVms.length===1?boundVms[0]:null;
    const topicItems=Array.isArray(vm?.topics)?vm.topics:(Array.isArray(vm?._data?.topics)?vm._data.topics:[]);
    const topics=topicItems.map(topic=>({activity_description:String(topic?.activity_description||''),activity_text:String(topic?.activity_text||''),description:String(topic?.description||''),mission_id:topic?.mission_id,topic_id:topic?.topic_id,topic_name:String(topic?.topic_name||''),show_activity_icon:topic?.show_activity_icon}));
    const current=vm?.currentTopic?{activity_description:String(vm.currentTopic.activity_description||''),activity_text:String(vm.currentTopic.activity_text||''),mission_id:vm.currentTopic.mission_id,topic_id:vm.currentTopic.topic_id,topic_name:String(vm.currentTopic.topic_name||''),show_activity_icon:vm.currentTopic.show_activity_icon}:null;
    return {open:Boolean(wrap),input:input?{value:String(input.value||''),visible:visible(input),focused:document.activeElement===input,point:(()=>{const r=input.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()}:null,rows,topics,current,dataBinding:{topicVmCount:topicVms.length,boundVmCount:boundVms.length,keyName:String(vm?.keyName??vm?._data?.keyName??'')},loading:Boolean(vm?.showLoading)||[...(wrap?.querySelectorAll('.loading-modal,[class*="loading"]')||[])].some(visible)};
  })()`);
}

async function closeBilibiliTopicDialogV2(){
  const control=await js(String.raw`(() => {const compact=value=>String(value||'').replace(/\s+/g,' ').trim();const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0};const wraps=[...document.querySelectorAll('.dialog.bcc-dialog__wrap,.bcc-dialog__wrap,[role="dialog"]')].filter(visible);const wrap=wraps.find(el=>el.querySelector('.topic-dialog,.topic-dialog-search')&&/参与话题/.test(compact(el.innerText||el.textContent||'')));if(!wrap)return {ok:true,alreadyClosed:true};const button=[...wrap.querySelectorAll('button,[role="button"]')].find(el=>visible(el)&&compact(el.innerText||el.textContent||'')==='取消');if(!button)return {ok:false,reason:'bilibili topic cancel control missing'};const r=button.getBoundingClientRect();return {ok:true,point:{x:r.left+r.width/2,y:r.top+r.height/2}}})()`);
  if(!control.ok||control.alreadyClosed)return control;
  try{await click([control.point.x,control.point.y],{label:'close bilibili topic search'})}catch(error){return {ok:false,reason:'bilibili topic dialog close failed',error:String(error?.message||error)}}
  for(let poll=0;poll<10;poll+=1){await wait(.2);if(!(await inspectBilibiliTopicDialogV2()).open)return {ok:true}}
  return {ok:false,reason:'bilibili topic dialog remained open'};
}

async function addExistingBilibiliTopicV2(tag){
  const action={tag,ok:false,requiresUser:false,stage:'open'};
  const entry=await js(String.raw`(() => {const compact=value=>String(value||'').replace(/\s+/g,' ').trim();const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0};const entries=[...document.querySelectorAll('.tag-more')].filter(el=>visible(el)&&compact(el.innerText||el.textContent||'').includes('搜索更多话题'));if(entries.length!==1)return {ok:false,reason:'bilibili exact topic search entry is not unique',count:entries.length};const r=entries[0].getBoundingClientRect();return {ok:true,point:{x:r.left+r.width/2,y:r.top+r.height/2}}})()`);
  action.entry=entry;
  if(!entry.ok)return {...action,reason:entry.reason};
  try{await click([entry.point.x,entry.point.y],{label:`search bilibili topic ${tag}`})}catch(error){return {...action,reason:'bilibili topic search entry click failed',error:String(error?.message||error)}}
  let dialog=null;
  for(let poll=0;poll<20;poll+=1){await wait(.2);dialog=await inspectBilibiliTopicDialogV2();if(dialog.open&&dialog.input?.visible)break}
  if(!dialog?.open||!dialog.input?.visible){const closed=await closeBilibiliTopicDialogV2();return {...action,stage:'search',reason:'bilibili topic search dialog did not expose a visible input',dialog,closed}}
  try{await click([dialog.input.point.x,dialog.input.point.y],{label:`type bilibili topic ${tag}`})}catch(error){const closed=await closeBilibiliTopicDialogV2();return {...action,stage:'search',reason:'bilibili topic search input focus failed',error:String(error?.message||error),closed}}
  const selection=await js(String.raw`(() => {const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'};const wraps=[...document.querySelectorAll('.dialog.bcc-dialog__wrap,.bcc-dialog__wrap,[role="dialog"]')].filter(visible);const wrap=wraps.find(el=>el.querySelector('.topic-dialog-search'));const input=wrap?.querySelector('.topic-dialog-search input');if(!input)return {ok:false};input.focus();const hadValue=Boolean(input.value);if(hadValue)input.select();return {ok:true,hadValue,value:String(input.value||''),focused:document.activeElement===input}})()`);
  if(!selection.ok||!selection.focused){const closed=await closeBilibiliTopicDialogV2();return {...action,stage:'search',reason:'bilibili topic search input did not retain focus',selection,closed}}
  if(selection.hadValue){try{await pressKey('Backspace')}catch(error){const closed=await closeBilibiliTopicDialogV2();return {...action,stage:'search',reason:'bilibili topic search residual query could not be cleared',error:String(error?.message||error),closed}}}
  try{await cdp('Input.insertText',{text:tag})}catch(error){const closed=await closeBilibiliTopicDialogV2();return {...action,stage:'search',reason:'bilibili topic search text insertion failed',error:String(error?.message||error),closed}}
  let stableSignature='';let stablePolls=0;
  for(let poll=0;poll<30;poll+=1){await wait(.3);dialog=await inspectBilibiliTopicDialogV2();const signature=JSON.stringify({rows:dialog.rows?.map(row=>row.name),topics:dialog.topics?.map(topic=>[topic.topic_name,topic.topic_id,topic.mission_id,topic.show_activity_icon,topic.activity_description,topic.activity_text])});stablePolls=!dialog.loading&&signature===stableSignature?stablePolls+1:(!dialog.loading?1:0);stableSignature=signature;if(stablePolls>=3&&dialog.rows?.length)break}
  action.dialog=dialog;
  const resolution=assessBilibiliExactTopicV2(tag,dialog);action.resolution=resolution;action.exactCount=resolution.exactCount;
  if(!resolution.ok)return {...action,stage:'safety',requiresUser:resolution.requiresUser===true,reason:resolution.reason,closed:await closeBilibiliTopicDialogV2()};
  if(!(resolution.candidate.topicId>0))return {...action,stage:'safety',requiresUser:true,reason:`B站精确同名话题缺少有效 topic_id: ${tag}`,closed:await closeBilibiliTopicDialogV2()};
  try{await click(resolution.candidate.selector,{label:`select exact bilibili topic ${tag}`})}catch(error){const closed=await closeBilibiliTopicDialogV2();return {...action,stage:'select',reason:'bilibili exact topic selection failed',error:String(error?.message||error),closed}}
  await wait(.4);const selected=await inspectBilibiliTopicDialogV2();action.selected=selected.current;
  if(String(selected.current?.topic_name||'').toLowerCase()!==String(tag).toLowerCase()||Number(selected.current?.topic_id)!==Number(resolution.candidate.topicId)){const closed=await closeBilibiliTopicDialogV2();return {...action,stage:'select',reason:'bilibili exact topic selection was not reflected by the dialog model',closed}}
  const submit=await js(String.raw`(() => {const compact=value=>String(value||'').replace(/\s+/g,' ').trim();const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0};const wraps=[...document.querySelectorAll('.dialog.bcc-dialog__wrap,.bcc-dialog__wrap,[role="dialog"]')].filter(visible);const wrap=wraps.find(el=>el.querySelector('.topic-dialog,.topic-dialog-search')&&/参与话题/.test(compact(el.innerText||el.textContent||'')));const buttons=[...(wrap?.querySelectorAll('.topic-dialog .submit-add,.topic-dialog button,.topic-dialog [role="button"]')||[])].filter(el=>visible(el)&&compact(el.innerText||el.textContent||'')==='确定'&&!el.disabled&&el.getAttribute('aria-disabled')!=='true');if(buttons.length!==1)return {ok:false,reason:'bilibili topic submit control is not uniquely actionable',count:buttons.length};const r=buttons[0].getBoundingClientRect();return {ok:true,point:{x:r.left+r.width/2,y:r.top+r.height/2}}})()`);action.submit=submit;
  if(!submit.ok){const closed=await closeBilibiliTopicDialogV2();return {...action,stage:'submit',reason:submit.reason,closed}}
  try{await click([submit.point.x,submit.point.y],{label:`confirm bilibili topic ${tag}`})}catch(error){const closed=await closeBilibiliTopicDialogV2();return {...action,stage:'submit',reason:'bilibili topic submit click failed',error:String(error?.message||error),closed}}
  let current=null;
  for(let poll=0;poll<20;poll+=1){await wait(.3);current=await inspectBilibili();if(current.gates.tags.evidence?.chips?.some(chip=>chip.toLowerCase()===tag.toLowerCase()))return {...action,ok:true,stage:'verified',evidence:current.gates.tags.evidence}}
  const closed=await closeBilibiliTopicDialogV2();return {...action,stage:'verify',reason:`bilibili exact topic did not persist as a tag chip: ${tag}`,evidence:current?.gates.tags.evidence,closed};
}

async function addOneBilibiliTagV2(tag,attempt){
  const action={tag,attempt,committed:false,explicitPlatformRejection:false,topicOnlyRejection:false,feedbackSeen:[]};const feedbackSeen=action.feedbackSeen;const rejectionSeen=[];const topicOnlySeen=[];
  const rememberFeedback=probe=>{for(const message of probe?.rawFeedback||[])if(!feedbackSeen.includes(message))feedbackSeen.push(message);for(const message of probe?.rejectionMessages||[])if(!rejectionSeen.includes(message))rejectionSeen.push(message);for(const message of probe?.topicOnlyMessages||[])if(!topicOnlySeen.includes(message))topicOnlySeen.push(message)};
  let located;
  try{
    located=await js(String.raw`(() => {const input=[...document.querySelectorAll('input')].find(el=>(el.placeholder||'').includes('按回车键Enter创建标签'));if(!input)return {ok:false,reason:'bilibili tag input missing'};input.scrollIntoView({block:'center'});const r=input.getBoundingClientRect(),s=getComputedStyle(input);return {ok:true,visible:r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden',point:{x:r.left+r.width/2,y:r.top+r.height/2}}})()`);
  }catch(error){return {...action,reason:'bilibili tag input lookup failed',inputError:{stage:'locate',message:String(error?.message||error)}}}
  action.located=located;
  if(!located.ok||!located.visible)return {...action,reason:located.reason||'bilibili tag input is not visibly actionable'};
  try{await click([located.point.x,located.point.y],{label:`focus bilibili tag ${tag}`})}
  catch(error){
    action.inputProbe=await inspectBilibiliTagInputV2().catch(probeError=>({ok:false,hint:'tag input probe failed',error:String(probeError?.message||probeError)}));
    return {...action,reason:'bilibili tag input focus action failed',inputError:{stage:'focus',message:String(error?.message||error)}};
  }
  let selection;
  try{
    selection=await js(String.raw`(() => {const input=[...document.querySelectorAll('input')].find(el=>(el.placeholder||'').includes('按回车键Enter创建标签'));if(!input)return {ok:false,reason:'bilibili tag input missing'};input.focus();const hadValue=Boolean(input.value);if(hadValue)input.select();const r=input.getBoundingClientRect(),s=getComputedStyle(input);return {ok:true,hadValue,value:String(input.value||''),focused:document.activeElement===input,visible:r.width>4&&r.height>4&&s.display!=='none'&&s.visibility!=='hidden'}})()`);
  }catch(error){return {...action,reason:'bilibili tag input selection failed',inputError:{stage:'select',message:String(error?.message||error)}}}
  action.selection=selection;
  if(!selection.ok||!selection.focused||!selection.visible)return {...action,reason:selection.reason||'bilibili tag input did not retain visible focus'};
  if(selection.hadValue){
    try{await pressKey('Backspace')}
    catch(error){return {...action,reason:'bilibili residual tag query could not be cleared',inputError:{stage:'clear',message:String(error?.message||error)}}}
  }
  try{await cdp('Input.insertText',{text:tag})}
  catch(error){
    action.inputProbe=await inspectBilibiliTagInputV2().catch(probeError=>({ok:false,hint:'tag input probe failed',error:String(probeError?.message||probeError)}));
    return {...action,reason:'bilibili tag text insertion failed',inputError:{stage:'insert',message:String(error?.message||error)}};
  }
  await wait(.3);
  action.inputProbe=await inspectBilibiliTagInputV2();
  rememberFeedback(action.inputProbe);
  if(!action.inputProbe.ok||!action.inputProbe.visible||!action.inputProbe.focused||action.inputProbe.value!==tag){
    return {...action,reason:'bilibili tag input did not visibly retain the inserted text'};
  }
  if(rejectionSeen.length)return {...action,reason:`B站明确拒绝标签 ${tag}: ${rejectionSeen.join('；')}`,explicitPlatformRejection:true,topicOnlyRejection:topicOnlySeen.length>0,rejectionMessages:rejectionSeen,topicOnlyMessages:topicOnlySeen};
  try{await pressKey('Enter')}
  catch(error){
    action.commitProbe=await inspectBilibiliTagInputV2().catch(probeError=>({ok:false,hint:'tag input probe failed',error:String(probeError?.message||probeError)}));
    return {...action,reason:'bilibili tag commit action failed',inputError:{stage:'commit',message:String(error?.message||error)}};
  }
  let current=null;
  for(let poll=1;poll<=20;poll+=1){
    await wait(.5);current=await inspectBilibili();action.commitProbe=await inspectBilibiliTagInputV2();
    rememberFeedback(action.commitProbe);
    action.committed=Boolean(current.gates.tags.evidence?.chips?.some(chip=>chip.toLowerCase()===tag.toLowerCase()));
    if(action.committed)return {...action,ok:true,poll,feedbackSeen};
    if(rejectionSeen.length){
      return {...action,reason:`B站明确拒绝标签 ${tag}: ${rejectionSeen.join('；')}`,explicitPlatformRejection:true,topicOnlyRejection:topicOnlySeen.length>0,rejectionMessages:rejectionSeen,topicOnlyMessages:topicOnlySeen,feedbackSeen,evidence:current.gates.tags.evidence};
    }
    if(!action.commitProbe.checking&&poll>=8)break;
  }
  return {...action,reason:`bilibili tag did not persist: ${tag}`,feedbackSeen,evidence:current?.gates.tags.evidence};
}

async function rebuildBilibiliTagsV2(){
  const removed=[];const attempts=[];const topicFallbacks=[];const stability=[];
  for(let step=1;step<=40;step+=1){
    const settled=await waitForBilibiliTagSetStable({stablePolls:step===1?5:3,maxPolls:24});stability.push({step,ok:settled.ok,snapshots:settled.snapshots});
    if(!settled.ok)return {ok:false,reason:settled.reason,removed,attempts,stability,inputProbe:settled.inputProbe,evidence:settled.current?.gates.tags.evidence};
    const evidence=settled.current.gates.tags.evidence||{};const unexpected=evidence.unexpected||[];const missing=evidence.missing||[];const malformed=evidence.malformed||[];const duplicates=evidence.duplicates||[];
    const finalCleanup=missing.length===0;
    const removalTarget=unexpected[0]||malformed[0]||duplicates[0];
    if(removalTarget){
      let result;
      try{result=await removeOneBilibiliTagChipV2(removalTarget)}catch(error){return {ok:false,reason:'bilibili tag removal action failed',removed,attempts,stability,inputError:{stage:'remove',message:String(error?.message||error)},evidence}}
      if(!result.ok)return {ok:false,reason:result.reason,removed,attempts,stability,evidence};
      removed.push({tag:removalTarget,finalCleanup});
      continue;
    }
    if(missing.length){
      const tag=missing[0];const priorAttempts=attempts.filter(item=>item.tag.toLowerCase()===tag.toLowerCase()).length;
      const action=await addOneBilibiliTagV2(tag,priorAttempts+1);attempts.push(action);
      if(!action.ok){
        if(action.topicOnlyRejection===true){
          const topicAction=await addExistingBilibiliTopicV2(tag);topicFallbacks.push(topicAction);
          if(topicAction.ok)continue;
          return {ok:false,reason:topicAction.reason,requiresUser:topicAction.requiresUser===true,explicitPlatformRejection:topicAction.requiresUser===true,removed,attempts,topicFallbacks,stability,inputProbe:action.inputProbe||action.commitProbe,inputError:topicAction.error?{stage:`topic_${topicAction.stage||'unknown'}`,message:topicAction.error}:null,feedbackSeen:action.feedbackSeen||[],rejectionMessages:action.rejectionMessages||[],evidence:topicAction.evidence||topicAction.resolution?.evidence||evidence};
        }
        if(action.explicitPlatformRejection!==true&&priorAttempts<1)continue;
        return {ok:false,reason:action.reason,explicitPlatformRejection:action.explicitPlatformRejection===true,removed,attempts,topicFallbacks,stability,inputProbe:action.inputProbe||action.commitProbe,inputError:action.inputError||null,feedbackSeen:action.feedbackSeen||[],rejectionMessages:action.rejectionMessages||[],evidence:action.evidence||evidence};
      }
      continue;
    }
    const finalSettled=await waitForBilibiliTagSetStable({stablePolls:6,maxPolls:24});stability.push({step,finalCleanup:true,ok:finalSettled.ok,snapshots:finalSettled.snapshots});
    if(!finalSettled.ok)return {ok:false,reason:finalSettled.reason,removed,attempts,stability,inputProbe:finalSettled.inputProbe,evidence:finalSettled.current?.gates.tags.evidence};
    if(finalSettled.current.gates.tags.ok)return {ok:true,removed,attempts,topicFallbacks,stability,finalCleanup:true,evidence:finalSettled.current.gates.tags.evidence};
  }
  const after=await inspectBilibili();
  return {ok:false,reason:'bilibili tag set did not converge within the bounded repair loop',removed,attempts,stability,evidence:after.gates.tags.evidence};
}

async function prepareBilibiliCoverEntry(){
  return await js(String.raw`(() => {
    const compact=value=>String(value||'').replace(/\s+/g,' ').trim();
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=8||r.height<=8)return false;for(let current=el;current;current=current.parentElement){const style=getComputedStyle(current);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity||1)<=0)return false}return true};
    const all=[...new Set(document.querySelectorAll('.bcc-dialog,.bcc-modal,[role="dialog"]'))].filter(visible);
    const dialogs=all.filter(el=>!all.some(child=>child!==el&&el.contains(child)));
    if(dialogs.length){
      if(dialogs.length===1&&/封面制作/.test(compact(dialogs[0].innerText||dialogs[0].textContent||'')))return {ok:true,alreadyOpen:true};
      return {ok:false,reason:'bilibili active dialog is not a unique visible cover editor'};
    }
    const cards=[...document.querySelectorAll('.cover .cover-content .cover-img')].filter(visible);
    const main=cards.filter(el=>el.closest('.cover-module-main'));
    const preferred=main.length?main:cards;
    if(preferred.length>1)return {ok:false,reason:'bilibili main cover entry is not unique'};
    let target=preferred[0];
    if(!target){
      const emptyMainEntries=[...document.querySelectorAll('.cover .cover-content .cover-main .cover-module-main .cover-empty-pill')].filter(el=>visible(el)&&compact(el.innerText||el.textContent||'')==='添加封面');
      const controls=[...new Set([...emptyMainEntries,...document.querySelectorAll('.cover button,.cover [role="button"],.cover .edit-text')])].filter(el=>visible(el)&&/^(更换封面|封面设置|上传封面|添加主封面|添加封面)$/.test(compact(el.innerText||el.textContent||'')));
      if(controls.length!==1)return {ok:false,reason:'bilibili visible cover entry missing or ambiguous'};
      target=controls[0];
    }
    target.scrollIntoView({block:'center',inline:'center'});
    const r=target.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    if(!hit||!(hit===target||target.contains(hit))||hit.closest('.cover-delete-btn'))return {ok:false,reason:'bilibili cover entry hit target is obscured'};
    target.id='vp2-bili-cover-entry-'+Date.now().toString(36);
    return {ok:true,selector:'#'+target.id,source:preferred.length?'main-cover-card':'visible-cover-control'};
  })()`);
}

async function exposeBilibiliCoverImageInput(){
  return await js(String.raw`(() => {
    const compact=value=>String(value||'').replace(/\s+/g,' ').trim();
    const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect();if(r.width<=20||r.height<=20)return false;for(let current=el;current;current=current.parentElement){const style=getComputedStyle(current);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity||1)<=0)return false}return true};
    const all=[...new Set(document.querySelectorAll('.bcc-dialog,.bcc-modal,[role="dialog"]'))].filter(visible);
    const dialogs=all.filter(el=>!all.some(child=>child!==el&&el.contains(child)));
    if(!dialogs.length)return {ok:false,waiting:true,reason:'bilibili cover editor did not open'};
    if(dialogs.length!==1||!/封面制作/.test(compact(dialogs[0].innerText||dialogs[0].textContent||'')))return {ok:false,terminal:true,reason:'bilibili active dialog is not a unique visible cover editor'};
    const editor=dialogs[0];
    const inputs=[...editor.querySelectorAll('input[type=file]')].filter(input=>{
      const accepts=String(input.accept||'').split(',').map(value=>value.trim()).filter(Boolean);
      if(input.disabled||!accepts.length||!accepts.every(value=>/^(image\/[^,]+|\.(png|jpe?g|webp|bmp|gif))$/i.test(value)))return false;
      for(let current=input.parentElement;current&&current!==editor;current=current.parentElement){const style=getComputedStyle(current);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity||1)<=0)return false}
      return true;
    });
    const primary4x3=inputs.filter(input=>{
      const slot=input.closest('.cover-editor-panel-canvas-empty.ratio_4_3');
      return Boolean(slot&&editor.contains(slot));
    });
    if(primary4x3.length>1)return {ok:false,waiting:true,reason:'bilibili 4:3 cover image input is ambiguous in active editor',imageInputs:inputs.length,primary4x3Inputs:primary4x3.length};
    const ratioSlots=[...editor.querySelectorAll('.cover-editor-panel-canvas-empty.ratio_4_3,.cover-editor-panel-canvas-empty.ratio_16_9')];
    let input=null,source=null;
    if(primary4x3.length===1){input=primary4x3[0];source='primary-4:3-slot'}
    else if(inputs.length===1&&!ratioSlots.length){input=inputs[0];source='legacy-single-input'}
    else return {ok:false,waiting:true,reason:'bilibili cover image input missing or ambiguous in active editor',imageInputs:inputs.length,primary4x3Inputs:0,ratioSlots:ratioSlots.length};
    editor.id='vp2-bili-cover-editor-'+Date.now().toString(36);
    input.id=editor.id+'-input';
    return {ok:true,selector:'#'+editor.id+' #'+input.id,editorSelector:'#'+editor.id,source,imageInputs:inputs.length,primary4x3Inputs:primary4x3.length};
  })()`);
}

async function uploadBilibiliCoverV2(){
  if(!bilibiliCustomCover)return {ok:true,skipped:true};
  const asset=readBilibiliCoverAsset();
  if(!asset.ok)return asset;
  const before=(await inspectBilibili()).gates.cover.evidence?.urls||[];
  const opened=await prepareBilibiliCoverEntry();
  if(!opened.ok)return opened;
  if(!opened.alreadyOpen){
    try{await click(opened.selector,{label:'open bilibili main cover editor'})}catch(error){return {ok:false,reason:'bilibili cover entry click failed: '+String(error?.message||error),entry:opened}}
  }
  let exposed;
  for(let poll=0;poll<30;poll+=1){
    exposed=await exposeBilibiliCoverImageInput();
    if(exposed.ok)break;
    if(exposed.terminal)return exposed;
    await wait(.5);
  }
  if(!exposed?.ok)return {...exposed,ok:false,reason:exposed?.reason||'bilibili cover image input missing in active editor'};
  const beforePreview=await compareBilibiliCoverPixels(asset,{editorSelector:exposed.editorSelector});
  if(!beforePreview.sourcePixelSha256)return {ok:false,reason:'bilibili approved source could not be decoded before injection',comparison:beforePreview};
  const priorPaint=new Set((beforePreview.candidates||[]).map(candidate=>candidate.key).filter(Boolean));
  // Decoding and sampling the approved image is asynchronous. The platform may
  // replace its file input while that read is pending, so resolve the unique
  // active 4:3 input again immediately before injecting the same approved file.
  exposed=await exposeBilibiliCoverImageInput();
  if(!exposed?.ok)return {...exposed,ok:false,reason:exposed?.reason||'bilibili cover input changed before injection'};
  try{await uploadFile(exposed.selector,asset.uploadPath||asset.assetPath||bilibiliCoverPath)}catch(error){return {ok:false,reason:String(error?.message||error)}}
  if(readBilibiliCoverAsset().assetHash!==asset.assetHash)return {ok:false,reason:'bilibili approved source changed during injection'};
  let freshPaint=null,lastPreview=null;
  for(let poll=0;poll<40&&!freshPaint;poll+=1){
    lastPreview=await compareBilibiliCoverPixels(asset,{editorSelector:exposed.editorSelector});
    freshPaint=(lastPreview.candidates||[]).find(candidate=>candidate.ok&&!priorPaint.has(candidate.key))||null;
    if(!freshPaint)await wait(.5);
  }
  if(!freshPaint)return {ok:false,reason:'bilibili injected cover did not produce fresh nonuniform native source paint',comparison:lastPreview};
  if(readBilibiliCoverAsset().assetHash!==asset.assetHash)return {ok:false,reason:'bilibili approved source changed before native cover confirmation'};
  let confirmControl=null;
  for(let poll=0;poll<90&&!confirmControl;poll+=1){
    await wait(.5);
    confirmControl=await js(String.raw`((editorSelector) => {const c=v=>String(v||'').replace(/\s+/g,' ').trim();const dialog=document.querySelector(editorSelector);const active=dialog&&/封面制作/.test(c(dialog.innerText||dialog.textContent||''))?[dialog].filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0}):[];const candidates=active.flatMap(dialog=>[...dialog.querySelectorAll('.button.submit,button,[role="button"],div,span')]).filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return /^(完成|确定|保存|使用|应用)$/.test(c(el.innerText||el.textContent||''))&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&r.width>20&&r.height>15&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0}).map(el=>({el,r:el.getBoundingClientRect(),submit:/submit/.test(String(el.className||''))})).sort((a,b)=>Number(b.submit)-Number(a.submit)||(a.r.width*a.r.height-b.r.width*b.r.height));if(!candidates[0])return null;const el=candidates[0].el;el.id='vp2-bili-cover-confirm';return {selector:'#vp2-bili-cover-confirm',text:c(el.innerText||el.textContent||''),className:String(el.className||'')}})(${JSON.stringify(exposed.editorSelector)})`);
  }
  if(!confirmControl)return {ok:false,reason:'bilibili cover confirm missing'};
  let primaryClickError=null;
  let frameworkFallbackUsed=false;
  try{await click(confirmControl.selector,{label:'confirm bilibili cover'})}catch(error){
    primaryClickError=String(error?.message||error);
    const fallback=await js(String.raw`(() => {const c=v=>String(v||'').replace(/\s+/g,' ').trim();const dialog=[...document.querySelectorAll('.bcc-dialog,.bcc-modal,[role="dialog"]')].find(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden'&&/封面制作/.test(c(el.innerText||el.textContent||''))});const button=[...(dialog?.querySelectorAll('.button.submit')||[])].find(el=>c(el.innerText||el.textContent||'')==='完成'&&!el.disabled&&el.getAttribute('aria-disabled')!=='true');if(!button)return{ok:false};button.click();return{ok:true}})()`);
    if(!fallback.ok)return {ok:false,reason:`bilibili cover confirm click failed: ${primaryClickError}`,confirmControl};
    frameworkFallbackUsed=true;
  }
  let after=[];
  let dialogClosed=false;
  let afterUrl='',nativeComparison=null;
  for(let poll=0;poll<60;poll+=1){
    await wait(.5);
    const state=await inspectBilibili();
    after=state.gates.cover.evidence?.urls||[];
    dialogClosed=state.gates.noBlockingDialog.ok;
    afterUrl=after.find(url=>!before.includes(url)&&/^https:\/\/(?:archive\.)?biliimg\.com\//.test(url))
      ||after.find(url=>/^https:\/\/(?:archive\.)?biliimg\.com\//.test(url))||'';
    if(dialogClosed&&afterUrl){
      nativeComparison=await compareBilibiliCoverPixels(asset,{url:afterUrl});
      if(nativeComparison.ok)break;
    }
    if(poll===10&&!dialogClosed){
      const fallback=await js(String.raw`(() => {const c=v=>String(v||'').replace(/\s+/g,' ').trim();const dialog=[...document.querySelectorAll('.bcc-dialog,.bcc-modal,[role="dialog"]')].find(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden'&&/封面制作/.test(c(el.innerText||el.textContent||''))});const button=[...(dialog?.querySelectorAll('.button.submit')||[])].find(el=>c(el.innerText||el.textContent||'')==='完成'&&!el.disabled&&el.getAttribute('aria-disabled')!=='true');if(!button)return{ok:false};button.click();return{ok:true}})()`);
      frameworkFallbackUsed=fallback.ok===true;
    }
  }
  if(!dialogClosed)return {ok:false,reason:'bilibili cover editor did not close after confirmation',before,after,frameworkFallbackUsed};
  if(!afterUrl)return {ok:false,reason:'bilibili main cover did not expose CDN receipt',before,after};
  if(!nativeComparison?.ok)return {ok:false,reason:'bilibili exported native cover pixels do not match the approved source',before,after,comparison:nativeComparison};
  if(readBilibiliCoverAsset().assetHash!==asset.assetHash)return {ok:false,reason:'bilibili approved source changed during exported-image verification'};
  return {ok:true,frameworkFallbackUsed,primaryClickError,receipt:{version:2,assetPath:bilibiliCoverPath,assetHash:asset.assetHash,ratio:'4:3',slots:['homepage-4:3'],beforeUrls:before,afterUrl,deduplicated:before.includes(afterUrl),
    ...(asset.transport?{transport:asset.transport}:{}),
    verification:'source-native-pixels-v1',sourcePixelSha256:nativeComparison.sourcePixelSha256,nativePixelSha256:nativeComparison.nativePixelSha256,comparisonMetrics:nativeComparison.comparisonMetrics,
    sourcePreview:{fresh:true,assetHash:asset.assetHash,identity:freshPaint.identity,key:freshPaint.key,sourcePixelSha256:freshPaint.sourcePixelSha256,nativePixelSha256:freshPaint.nativePixelSha256,comparisonMetrics:freshPaint.comparisonMetrics}}};
}

async function ensureBilibiliEarlyMetadata(before){
  const actions={};
  if(!before.gates.title.ok)actions.title=await setNativeInputValue('input[placeholder*="稿件标题"]',bilibiliTitle);
  let current=await inspectBilibili();
  if(!current.gates.title.ok)return {ok:false,actions,current,blocker:typedBlocker('ACTION_FAILED','B站标题没有持久化',{evidence:current.gates.title.evidence})};
  if(!current.gates.tags.ok)actions.tags=await rebuildBilibiliTagsV2();
  if(actions.tags&&!actions.tags.ok){
    current=await inspectBilibili();
    return {ok:false,actions,current,blocker:bilibiliTagFailureBlocker(actions.tags)};
  }
  current=await inspectBilibili();
  return {ok:current.gates.title.ok&&current.gates.tags.ok,actions,current};
}

function bilibiliTagFailureBlocker(result){
  const code=result.explicitPlatformRejection===true?'PLATFORM_REJECTED_METADATA':'ACTION_FAILED';
  return typedBlocker(code,result.reason||'B站标签修复失败',{retryable:result.requiresUser!==true,requiresUser:result.requiresUser===true,evidence:result});
}

async function prefillBilibili(){
  const before=await inspectBilibili();
  if(!before.gates.authenticated.ok)return {...before,blocker:typedBlocker('AUTH_REQUIRED','B站登录状态失效',{requiresUser:true,evidence:before.gates.authenticated.evidence})};
  if(!before.gates.draftIdentity.ok)return {...before,blocker:typedBlocker('FOREIGN_DRAFT','B站当前编辑器属于其他视频草稿',{evidence:before.gates.draftIdentity.evidence})};
  const uploading=before.gates.video.evidence?.uploading===true;
  if(!before.gates.video.ok&&(!uploading||before.evidence?.earlyMutation?.ready!==true)){
    return {...before,blocker:typedBlocker('STATE_AMBIGUOUS','B站上传中的标题与标签控件尚未完整就绪',{retryable:true,evidence:before.evidence?.earlyMutation})};
  }
  const metadata=await ensureBilibiliEarlyMetadata(before);
  if(!metadata.ok)return {...metadata.current,actions:metadata.actions,blocker:metadata.blocker};
  return {...metadata.current,actions:{...metadata.actions,prefill:{completedDuringUpload:uploading}}};
}

async function mutateBilibili(){
  const before=await inspectBilibili();
  if(before.blocker)return before;
  const coverRevision=typeof readBrowserCoverRevisionSource==='function'?readBrowserCoverRevisionSource():null;
  if(coverRevision){
    if(before.blocker)return before;
    const required=['authenticated','draftIdentity','video','title','description','tags','original','finalButton'];
    const missing=required.filter(key=>before.gates[key]?.ok!==true);
    const restored=before.gates.draftIdentity?.evidence?.restoredIdentity;
    if(restored?.ok!==true||String(restored.actualId||'')!==coverRevision.sourceDraftId)missing.push('sourceDraftId');
    const guard=await inspectFinalPublishGuard();
    if(guard.armed!==true||guard.blockedAttempts!==0)missing.push('safety');
    if(missing.length)return {...before,blocker:typedBlocker('STATE_AMBIGUOUS','B站封面替换时原稿字段、原生 ID 或安全状态发生变化；禁止同时修改其他字段',{evidence:{missing,guard}})};
    const dialogs=before.gates.noBlockingDialog?.evidence?.active||[];
    const onlyCoverEditor=dialogs.length>0&&dialogs.every(item=>/封面制作/.test(item.text||'')&&/首页推荐封面|个人空间封面|上传封面|添加主封面/.test(item.text||''));
    if(before.gates.noBlockingDialog?.ok!==true&&!onlyCoverEditor)return {...before,blocker:typedBlocker('STATE_AMBIGUOUS','B站封面替换遇到非封面弹窗；禁止继续修改',{evidence:before.gates.noBlockingDialog?.evidence})};
    // The original-resource cover revision may not repair metadata or rights.
    return await finishBilibiliCoverMutation(before,{coverOnly:true});
  }
  if(!before.gates.video.ok)return {...before,blocker:typedBlocker('STATE_AMBIGUOUS','B站没有可修复的已上传视频')};
  const actions={};
  const mutationBlockers=[];
  if(!before.gates.title.ok)actions.title=await setNativeInputValue('input[placeholder*="稿件标题"]',bilibiliTitle);
  if(!before.gates.description.ok)actions.description=await setBilibiliDescriptionV2();
  if(actions.description&&!actions.description.ok)return {...(await inspectBilibili()),blocker:typedBlocker('ACTION_FAILED',actions.description.reason)};
  if(!before.gates.original.ok)actions.declaration=await ensureBilibiliDeclarationV2();
  if(actions.declaration&&!actions.declaration.ok)return {...(await inspectBilibili()),actions,blocker:typedBlocker(actions.declaration.code||'ACTION_FAILED',actions.declaration.reason||'B站创作声明没有持久化',{evidence:actions.declaration})};
  if(!before.gates.tags.ok){
    actions.tags=await rebuildBilibiliTagsV2();
    if(!actions.tags.ok)mutationBlockers.push(bilibiliTagFailureBlocker(actions.tags));
  }
  return await finishBilibiliCoverMutation(before,actions,mutationBlockers);
}

async function finishBilibiliCoverMutation(before,actions={},mutationBlockers=[]){
  const receipts={};
  if(bilibiliCustomCover&&!before.gates.cover.ok){
    actions.cover=await uploadBilibiliCoverV2();
    if(!actions.cover.ok)mutationBlockers.push(typedBlocker('PLATFORM_REJECTED_ASSET',actions.cover.reason,{retryable:true,evidence:actions.cover}));
    else{receipts.cover=actions.cover.receipt;expectedReceipts.cover=receipts.cover}
  }else if(bilibiliCustomCover){
    actions.cover={ok:true,skipped:true,reason:'already_verified'};
  }
  actions.receiptCheckpoint=checkpointReceipts(receipts);
  const after=await inspectBilibili();
  return {...after,actions,receipts,mutationBlockers,blocker:after.blocker||mutationBlockers[0]||null};
}

async function quarantineBilibili(){let before=await inspectBilibili();if(before.gates.video.evidence?.restoreBanner){const resumed=await resumeBilibiliLocalDraftIfPresent();if(!resumed.ok)return {...before,blocker:typedBlocker('ACTION_FAILED',resumed.reason)};await wait(4);before=await inspectBilibili();if(before.gates.draftIdentity.ok)return {...before,quarantine:{safeToUpload:true,resumedTarget:true}}}return await quarantineBiliForeignDraft(before)}

async function runPlatformPhase(){if(phase==='inspect'||phase==='verify')return await inspectBilibili();if(phase==='upload_start')return await startBilibiliUpload();if(phase==='prefill')return await prefillBilibili();if(phase==='upload')return await uploadBilibili();if(phase==='mutate')return await mutateBilibili();if(phase==='quarantine')return await quarantineBilibili();return {...(await inspectBilibili()),blocker:typedBlocker('ACTION_FAILED',`unsupported Bilibili phase: ${phase}`)}}

// Video replacement is bound to an existing native draft and one native part.
// The ordinary upload input adds a part and must never be used here.
async function readBilibiliVideoRevisionNative(){
  return await js(String.raw`(() => {
    const root=document.querySelector('.video-basic-wrp')?.__vue__,task=root?.getCurrentTask?.(),a=task?.archive||{},videos=task?.videoTasks||[];
    const video=videos[0]||{},file=video.file;
    return {draftId:a.draftId==null?'':String(a.draftId),existingDraft:root?.isEditDraftMode===true,
      nativeFileIds:videos.length===1&&video.filename?['filename:'+String(video.filename)]:[],partCount:videos.length,
      uploadComplete:videos.length===1&&Number(video.status)===3,
      selectedFile:file?{name:String(file.name||''),size:Number(file.size||0),lastModified:Number(file.lastModified||0)}:null,
      nativeSize:Number(video.size||0),cid:video.cid==null?'':String(video.cid),
      metadata:{title:String(a.title||''),tid:Number(a.tid||0),copyright:a.copyright??null,noReprint:a.no_reprint??a.noReprint??null},
      published:Boolean(a.aid||a.bvid||Number(a.upStatus||0)>0)};
  })()`);
}

function validateBilibiliUnsavedTagCorrection(native){
  const r=unsavedBilibiliTagRevisionContext,source=r.sourceNativeUpload;
  const journal=readDraftSaveJournal(biliJournalFile(),biliJournalIdentity());
  const sameSpace=Number(activeTaskSpace?.id)===r.sourceTaskSpaceId&&activeTaskSpace?.name===r.sourceTaskSpaceName;
  const sameMedia=native?.published===false&&native.partCount===1&&native.uploadComplete===true
    &&String(native.cid||'')===String(source.cid)&&JSON.stringify(native.nativeFileIds)===JSON.stringify(source.nativeFileIds);
  const unsaved=native.existingDraft===false&&!native.draftId;
  const saved=journal?.status==='confirmed'&&journal.plan?.id&&native.existingDraft===true
    &&String(native.draftId)===String(journal.plan.id);
  return {ok:sameSpace&&sameMedia&&(unsaved||saved),sameSpace,sameMedia,unsaved,saved:Boolean(saved),
    actual:{draftId:native.draftId,cid:native.cid,nativeFileIds:native.nativeFileIds,partCount:native.partCount,published:native.published}};
}

function bilibiliReplacementMetadata(observation,native){
  const g=observation.gates;
  return {archive:native.metadata,title:g.title?.evidence?.actual,description:g.description?.evidence?.actual,
    tags:g.tags?.evidence?.chips,original:{noMark:g.original?.evidence?.noMark===true,selfMade:g.original?.evidence?.selfMade===true}};
}

function bilibiliReplacementLocalFile(){
  const stat=fs.statSync(localMediaMetadata.path);
  return {path:localMediaMetadata.path,size:stat.size,lastModified:Math.trunc(stat.mtimeMs),
    sha256:createHash('sha256').update(fs.readFileSync(localMediaMetadata.path)).digest('hex')};
}

function bilibiliReplacementCoverHash(){
  const asset=readBilibiliCoverAsset();
  if(!asset.ok)throw new Error(asset.reason);
  return videoReplacementSnapshotHash({assetPath:asset.assetPath,assetHash:asset.assetHash,ratio:'4:3'});
}

async function readbackBilibiliOriginalDraftCover(observation,native,revision){
  const required=['authenticated','draftIdentity','video','title','description','tags','aiGenerated','original','noBlockingDialog','finalButton'];
  const sameOriginal=value=>Boolean(revision&&Number(activeTaskSpace?.id)===revision.sourceTaskSpaceId
    &&value?.existingDraft===true&&value.draftId===revision.sourceDraftId&&value.published===false
    &&value.partCount===1&&value.uploadComplete===true&&value.nativeFileIds?.length===1);
  const nativeUrls=value=>[...new Set(value?.gates?.cover?.evidence?.urls||[])]
    .filter(url=>/^https:\/\/(?:archive\.)?biliimg\.com\//.test(url));
  if(phase!=='replace_video'||!bilibiliCustomCover||!sameOriginal(native)
    ||required.some(key=>observation.gates?.[key]?.ok!==true)){
    return {ok:false,reason:'original draft identity or business fields do not permit cover readback'};
  }
  const restored=observation.gates.draftIdentity.evidence?.restoredIdentity;
  if(restored?.ok!==true||String(restored.actualId||'')!==revision.sourceDraftId){
    return {ok:false,reason:'cover readback requires the exact restored original draft'};
  }
  const guard=await inspectFinalPublishGuard();
  if(guard.armed!==true||guard.blockedAttempts!==0)return {ok:false,reason:'cover readback safety guard is not clean'};
  const prior=expectedReceipts.cover,source=revision.sourceReceipts?.cover,asset=readBilibiliCoverAsset();
  if(!asset.ok||prior?.version!==2||source?.version!==2||prior.assetPath!==asset.assetPath
    ||source.assetPath!==asset.assetPath||prior.assetHash!==asset.assetHash||source.assetHash!==asset.assetHash
    ||prior.ratio!=='4:3'||prior.verification!=='source-native-pixels-v1'
    ||prior.sourcePreview?.fresh!==true||prior.sourcePreview.assetHash!==asset.assetHash){
    return {ok:false,reason:'cover readback lacks unchanged approved-source and prior native-preview bindings'};
  }
  const urls=nativeUrls(observation);
  if(urls.length!==1||urls[0]===prior.afterUrl)return {ok:false,reason:'cover readback requires one different current native CDN image'};
  // A restored draft may retain a different JPEG encoding of the same approved
  // PNG. Read its real pixels; neither a historical pass nor a URL is proof.
  const comparison=await compareBilibiliCoverPixels(asset,{url:urls[0]});
  const afterAsset=readBilibiliCoverAsset();
  if(!comparison.ok||!afterAsset.ok||afterAsset.assetHash!==asset.assetHash
    ||comparison.sourcePixelSha256!==prior.sourcePixelSha256
    ||comparison.sourcePixelSha256!==prior.sourcePreview.sourcePixelSha256){
    return {ok:false,reason:'current native cover pixels do not rebind the unchanged approved source',comparison};
  }
  const afterNative=await readBilibiliVideoRevisionNative(),after=await inspectBilibili();
  if(!sameOriginal(afterNative)||JSON.stringify(afterNative.nativeFileIds)!==JSON.stringify(native.nativeFileIds)
    ||required.some(key=>after.gates?.[key]?.ok!==true)||JSON.stringify(nativeUrls(after))!==JSON.stringify(urls)){
    return {ok:false,reason:'original draft, media, metadata or native cover changed during readback'};
  }
  const receipt={...prior,afterUrl:urls[0],sourcePixelSha256:comparison.sourcePixelSha256,
    nativePixelSha256:comparison.nativePixelSha256,comparisonMetrics:comparison.comparisonMetrics,
    nativeReadback:{version:1,kind:'same-original-draft-approved-cover-readback',observedAt:new Date().toISOString(),
      sourceDraftId:revision.sourceDraftId,taskSpaceId:revision.sourceTaskSpaceId,sourceFingerprint:revision.sourceFingerprint,
      priorReceiptSha256:createHash('sha256').update(JSON.stringify(prior)).digest('hex'),priorAfterUrl:prior.afterUrl,
      nativeUrl:urls[0],nativeFileIds:[...native.nativeFileIds],sourceAssetHash:asset.assetHash,
      sourcePreviewPreserved:true,uploadedDuringReadback:false}};
  if(!bilibiliCoverReceiptMatches(receipt,urls,asset,comparison))return {ok:false,reason:'fresh native-cover readback failed the normal receipt contract'};
  const checkpoint=checkpointReceipts({cover:receipt});
  if(checkpoint.ok!==true)return {ok:false,reason:'fresh native-cover readback could not be checkpointed'};
  expectedReceipts.cover=receipt;
  return {ok:true,receipt,comparison,checkpoint};
}

function bilibiliReplacementEvidence(journal,observation,native){
  const p=journal.plan,currentMetadataHash=videoReplacementSnapshotHash(bilibiliReplacementMetadata(observation,native));
  const currentCoverHash=bilibiliReplacementCoverHash();
  return {...p,draftId:native.draftId,nativeFileIds:native.nativeFileIds,currentMetadataHash,currentCoverHash,
    metadataUnchanged:currentMetadataHash===p.sourceMetadataHash,coversUnchanged:currentCoverHash===p.sourceCoverHash&&observation.gates.cover?.ok===true,
    uploadComplete:native.uploadComplete&&native.partCount===1,
    localFile:bilibiliReplacementLocalFile(),
    observedAt:new Date().toISOString()};
}

async function readBilibiliVideoReplacementProof(observation){
  const r=readBrowserVideoRevisionSource(),identity={platform,fingerprint:jobFingerprint};
  const journal=readVideoReplacementJournal(videoReplacementJournalPath,identity);
  if(!journal||journal.status!=='confirmed')return failedGate({reason:'Original Bilibili video replacement is not confirmed'});
  const native=await readBilibiliVideoRevisionNative(),evidence=bilibiliReplacementEvidence(journal,observation,native);
  return !native.published&&native.existingDraft&&JSON.stringify(native.nativeFileIds)===JSON.stringify(journal.evidence.nativeFileIds)
    &&validateVideoReplacementEvidence(evidence,journal.plan)
    ?okGate(evidence):failedGate({reason:'Bilibili original draft, new native media, metadata or approved cover changed',draftId:native.draftId,nativeFileIds:native.nativeFileIds});
}

async function injectBilibiliOriginalPartReplacement(sourceDraftId){
  const entry=await js(String.raw`(id=>{
    const root=document.querySelector('.video-basic-wrp')?.__vue__,task=root?.getCurrentTask?.();
    if(root?.isEditDraftMode!==true||String(task?.archive?.draftId||'')!==id||(task.videoTasks||[]).length!==1)return {ok:false,reason:'original draft or single part changed'};
    const candidates=[...document.querySelectorAll('.file-item-content-operate .icon-text-btn')].filter(el=>String(el.innerText||el.textContent||'').trim()==='更换视频'&&el.getBoundingClientRect().width>0);
    if(candidates.length!==1)return {ok:false,reason:'dedicated part replacement control is missing or ambiguous'};
    for(const el of document.querySelectorAll('#vp2-bili-replace-original-part'))el.removeAttribute('id');
    candidates[0].id='vp2-bili-replace-original-part';return {ok:true,selector:'#vp2-bili-replace-original-part'};
  })(${JSON.stringify(sourceDraftId)})`);
  if(!entry.ok)return entry;
  const nativeSpace=await taskSpace(Number(activeTaskSpace.id));
  const tabs=(await nativeSpace.tabs()).filter(tab=>{try{const u=new URL(tab.url);return u.hostname==='member.bilibili.com'&&u.searchParams.get('type')==='draft'&&u.searchParams.get('draftId')===sourceDraftId}catch{return false}});
  if(tabs.length!==1||!tabs[0].label)return {ok:false,reason:'dedicated replacement requires one managed original-draft page'};
  const page=nativeSpace.page(tabs[0].label);
  const chooserPromise=page.waitForFileChooser({timeout:15000});
  // Only this native control creates the ephemeral single-file changeFile input.
  await page.click(entry.selector);
  const chooser=await chooserPromise;
  const result=await chooser.setFiles(videoPath);
  if(result?.dialog)return {ok:false,reason:'native replacement file selection returned an unexpected dialog'};
  return {ok:true,mode:'original_part_replacement'};
}

async function replaceOriginalDraftVideo(){
  const r=readBrowserVideoRevisionSource(),identity={platform,fingerprint:jobFingerprint};
  let current=await inspectBilibili(),native=await readBilibiliVideoRevisionNative();
  if(!r||Number(activeTaskSpace.id)!==r.sourceTaskSpaceId||native.draftId!==r.sourceDraftId||!native.existingDraft||native.published||native.partCount!==1)
    return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','B站视频替换没有绑定唯一未发布的原草稿和原分P')};
  let journal=readVideoReplacementJournal(videoReplacementJournalPath,identity);
  const recoveringIntent=journal?.status==='intent';
  if(journal?.status==='confirmed')return current.gates.replaceVideo?.ok?current:{...current,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','B站已替换视频的当前身份不一致；禁止再次注入')};
  let coverReadback=null;
  if(!journal){
    if(current.gates.cover?.ok!==true){
      coverReadback=await readbackBilibiliOriginalDraftCover(current,native,r);
      if(!coverReadback.ok)return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','B站原稿当前封面无法与批准源图重新绑定；未重传封面或视频',{evidence:coverReadback})};
      current=await inspectBilibili();native=await readBilibiliVideoRevisionNative();
    }
    const missing=['authenticated','draftIdentity','video','title','description','tags','original','cover','noBlockingDialog','finalButton'].filter(key=>current.gates[key]?.ok!==true);
    if(missing.length||!localMediaMetadata||localMediaMetadata.sha256!==r.nextVideoIdentity.sha256)
      return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','B站原稿字段或新版本地视频校验未通过',{evidence:{missing}})};
    const originalEntries=await readBiliDraftList();
    if(originalEntries.filter(entry=>biliEntryId(entry)===r.sourceDraftId).length!==1)return {...current,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','B站原草稿 ID 不在当前原生草稿列表中；禁止替换')};
    const local=bilibiliReplacementLocalFile();
    if(local.sha256!==r.nextVideoIdentity.sha256||local.size!==localMediaMetadata.size||local.lastModified!==localMediaMetadata.lastModified)return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','B站批准的本地视频已发生变化')};
    const plan={sourceDraftId:r.sourceDraftId,sourceTaskSpaceId:r.sourceTaskSpaceId,sourceNativeFileIds:native.nativeFileIds,
      sourceVideoSha256:r.sourceVideoIdentity.sha256,nextVideoSha256:r.nextVideoIdentity.sha256,
      sourceMetadataHash:videoReplacementSnapshotHash(bilibiliReplacementMetadata(current,native)),sourceCoverHash:bilibiliReplacementCoverHash(),
      originalDraftVerified:true,liveSourceDraftId:native.draftId,nextVideoPath:localMediaMetadata.path,nextVideoSize:localMediaMetadata.size,nextVideoMtimeMs:localMediaMetadata.lastModified};
    // Atomic durable intent is written before chooser creation and any file selection.
    journal=beginVideoReplacement(videoReplacementJournalPath,identity,plan);
    const injected=await injectBilibiliOriginalPartReplacement(r.sourceDraftId);
    if(!injected.ok)return {...current,blocker:typedBlocker('UPLOAD_NOT_STARTED',injected.reason,{evidence:injected})};
  }
  // An existing intent only observes the same original draft; it never selects files again.
  for(let n=0;n<180;n++){
    native=await readBilibiliVideoRevisionNative();
    if(native.draftId!==r.sourceDraftId||native.partCount!==1||native.published)return {...current,blocker:typedBlocker('STATE_AMBIGUOUS','B站替换后原草稿 ID、分P数量或发布状态发生变化')};
    const changed=native.nativeFileIds.length===1&&native.nativeFileIds.every(id=>!journal.plan.sourceNativeFileIds.includes(id));
    if(changed&&native.uploadComplete){
      if(!native.selectedFile||native.selectedFile.size!==localMediaMetadata.size||native.selectedFile.name!==videoPath.split('/').pop())
        return {...current,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','B站新上传源文件没有精确匹配批准的本地视频；禁止接受旧视频或盲目重传')};
      current=await inspectBilibili();
      const mutated=await mutateBilibili();if(mutated.blocker)return mutated;current=mutated;
      native=await readBilibiliVideoRevisionNative();
      const evidence=bilibiliReplacementEvidence(journal,current,native);
      if(!validateVideoReplacementEvidence(evidence,journal.plan))return {...current,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','B站新视频完成后原文案或封面未保持一致')};
      journal=confirmVideoReplacement(videoReplacementJournalPath,identity,journal.attemptId,evidence);
      return {...(await inspectBilibili()),...(coverReadback?.receipt?{receipts:{cover:coverReadback.receipt},actions:{coverReadback:{ok:true,uploaded:false,checkpoint:coverReadback.checkpoint}}}:{})};
    }
    if(n===0&&recoveringIntent&&native.uploadComplete&&!changed)return {...current,blocker:typedBlocker('PERSISTENCE_UNVERIFIED','B站替换意图已存在但仍是旧文件；禁止自动再次注入')};
    await wait(5);
  }
  return {...(await inspectBilibili()),blocker:typedBlocker('UPLOAD_STALLED','B站原稿视频替换尚未稳定完成；保留意图并仅允许核对')};
}
