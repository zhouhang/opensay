import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';

const source=fs.readFileSync(new URL('../platforms/wechat-channels.mjs',import.meta.url),'utf8');
const between=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start);return source.slice(start,end);};
const classifier=between('function classifyWechatUploadText','function wechatUploadFailureBlocker');
const probe=between('function probeWechatFailedUploadRecovery','async function inspectWechatFailedUploadRecoveryControl');
const eligible=between('function wechatFailedUploadRetryEligibility','function probeWechatFailedUploadRecovery');
const eligibility=new Function('compactText',eligible+'\nreturn wechatFailedUploadRetryEligibility;')(v=>String(v||'').replace(/\s+/g,' ').trim());
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const errorText='网络出错，请重新上传。';

function pageFixture(options={}){
  const state={cleared:false,injected:false,popoverOpen:false,sourceChanged:false,...options};
  const element=(tag,text,cls,parent=null)=>({
    nodeType:1,tagName:tag,innerText:text,textContent:text,className:cls,parentElement:parent,children:[],shadowRoot:null,
    disabled:false,style:{display:'block',visibility:'visible',opacity:'1'},queries:{},isConnected:true,
    getBoundingClientRect(){return {left:10,top:20,x:10,y:20,width:100,height:30};},
    querySelectorAll(selector){return this.queries[selector]||[];},
    getAttribute(){return null;},getRootNode(){return document;},
    contains(other){for(let n=other;n;n=n.parentElement)if(n===this)return true;return false;},
    closest(selector){for(let n=this;n;n=n.parentElement)if(n.className.split(/\s+/).includes(selector.slice(1)))return n;return null;},
  });
  const panel=element('DIV','', 'media-status-content');
  const error=element('DIV',errorText,'msg-tip',panel);
  const wrapper=element('DIV','','weui-desktop-popover__wrp finder-popover-dialog-wrap',panel);
  const entry=element('DIV','删除','tag-inner',wrapper);
  const popover=element('DIV','','weui-desktop-popover',wrapper);
  const prompt=element('DIV',options.prompt||'删除后需重新上传','content',popover);
  const cancel=element('BUTTON','取消','weui-desktop-btn_default',popover);
  const confirm=element('BUTTON','删除','weui-desktop-btn_primary',popover);
  const input=element('INPUT','','',null);input.accept='video/mp4,video/x-m4v,video/*';input.files=[];
  panel.queries['.media-opr .weui-desktop-popover__target .tag-inner']=[entry];
  wrapper.queries['.weui-desktop-popover']=[popover];
  popover.queries['.confirm-del .content']=[prompt];popover.queries.button=[cancel,confirm];
  const nodes=[panel,error,wrapper,entry,popover,prompt,cancel,confirm,input];
  const document={
    body:{get innerText(){return state.cleared?'视频描述':errorText+' 删除 文件上传中，请等待完成后再编辑 '+(state.activeProgress||'');}},
    querySelectorAll(selector){
      if(selector==='*')return nodes;
      if(selector==='.media-status-content .status-msg.error .msg-tip')return state.cleared?[]:options.duplicateError?[error,error]:[error];
      if(selector==='input[type="file"]')return options.duplicateInput?[input,{...input}]:[input];
      return [];
    },
    elementFromPoint(){return state.obscured?panel:state.popoverOpen?confirm:entry;},
  };
  const getComputedStyle=el=>el===popover?{...el.style,display:state.popoverOpen?'block':'none'}:el.style;
  const context={document,location:{origin:'https://channels.weixin.qq.com',pathname:options.pathname||'/platform/post/create'},getComputedStyle};
  const run=stage=>vm.runInNewContext(classifier+'\n'+probe+`\nprobeWechatFailedUploadRecovery(${JSON.stringify(stage)},classifyWechatUploadText);`,context);
  return {state,run,context,panel,error,entry,wrapper,popover,prompt,cancel,confirm,input};
}

function baseEligibility(){
  const receipt={fingerprint:'bound',taskSpaceId:8,mode:'injected'};
  const current={gates:{authenticated:{ok:true},draftIdentity:{ok:true,evidence:{trustedVideoReceipt:true,description:'Approved body',restoredIdentity:{existingDraft:false,actualId:null,ok:false}}},video:{ok:false,evidence:{failed:true,uploaded:false,uploading:false,failureText:'网络出错'}}},evidence:{pageSample:errorText+' 文件上传中，请等待完成后再编辑'},blocker:{code:'PLATFORM_REJECTED_ASSET',evidence:{stage:'video_upload'}}};
  const context={receipt,journal:null,native:{objectId:'',hasPost:false},source:{path:'/approved.mp4',size:10,sha256:'a'.repeat(64)},fingerprint:'bound',taskSpaceId:8,expectedDescription:'Approved body',expectedVideoPath:'/approved.mp4'};
  return {current,context};
}

test('only the bound explicitly failed unsaved attachment qualifies for recovery',()=>{
  const f=baseEligibility();assert.equal(eligibility(f.current,f.context).ok,true);
});

test('saved, uncertain, foreign, active and unbound targets are rejected before any control click',()=>{
  const changes=[
    f=>f.context.journal={status:'intent'},f=>f.context.journal={status:'confirmed'},
    f=>f.context.native={objectId:'saved-native-id'},f=>f.context.native=null,
    f=>f.current.gates.draftIdentity.evidence.restoredIdentity={existingDraft:true,actualId:'id'},
    f=>f.current.gates.draftIdentity.evidence.trustedVideoReceipt=false,
    f=>f.current.gates.draftIdentity.evidence.description='Other video',
    f=>f.context.receipt.taskSpaceId=9,f=>f.context.receipt.fingerprint='foreign',
    f=>f.context.receipt.mode='resume_existing',f=>f.context.receipt.failedUploadRetry={id:'old'},
    f=>f.current.evidence.pageSample+=' 45% 取消上传',f=>f.current.gates.video.evidence.uploaded=true,
    f=>f.current.gates.video.evidence.uploading=true,f=>f.current.gates.video.evidence.failed=false,
    f=>f.context.source.path='/different.mp4',
  ];
  for(const change of changes){const f=baseEligibility();change(f);assert.equal(eligibility(f.current,f.context).ok,false);}
});

test('entry probe returns only the exact failed panel native leaf and center hit',()=>{
  const f=pageFixture(),r=f.run('entry');assert.equal(r.ok,true);assert.equal(r.label,'删除');assert.equal(r.className,'tag-inner');assert.equal(r.hitWithinControl,true);
  assert.equal(f.state.popoverOpen,false,'read-only probe must not open the popover');
});

test('native confirmation must be visible, same-wrapper, exact, unique, enabled and unobscured',()=>{
  const good=pageFixture();assert.equal(good.run('confirm').waiting,true);good.state.popoverOpen=true;assert.equal(good.run('confirm').ok,true);
  for(const mutate of [
    f=>f.prompt.innerText='删除此草稿？',f=>f.confirm.disabled=true,
    f=>f.popover.queries.button=[f.cancel,f.confirm,{...f.confirm}],
    f=>f.popover.queries['.confirm-del .content']=[f.prompt,{...f.prompt}],
    f=>f.wrapper.queries['.weui-desktop-popover']=[f.popover,{...f.popover}],
    f=>f.state.obscured=true,
  ]){const f=pageFixture();f.state.popoverOpen=true;mutate(f);assert.equal(f.run('confirm').ok,false);}
});

test('wrong route, real progress, nonunique leaf or obscured entry cannot trigger deletion',()=>{
  for(const mutate of [
    f=>f.context.location.pathname='/platform/post/list',f=>f.state.activeProgress='50% 取消上传',
    f=>f.panel.queries['.media-opr .weui-desktop-popover__target .tag-inner']=[f.entry,{...f.entry}],
    f=>f.state.obscured=true,f=>f.state.popoverOpen=true,
  ]){const f=pageFixture();mutate(f);assert.equal(f.run('entry').ok,false);}
});

test('cleared probe requires gone error and one enabled empty original video input',()=>{
  const f=pageFixture();assert.equal(f.run('cleared').ok,false);f.state.cleared=true;assert.equal(f.run('cleared').ok,true);
  f.input.disabled=true;assert.equal(f.run('cleared').ok,false);f.input.disabled=false;f.input.files=[{}];assert.equal(f.run('cleared').ok,false);
  const duplicate=pageFixture({duplicateInput:true});duplicate.state.cleared=true;assert.equal(duplicate.run('cleared').ok,false);
});

async function workflow(t,options={}){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-failed-upload-test-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const videoPath=path.join(tmp,'approved.mp4');fs.writeFileSync(videoPath,'original approved video bytes');
  const f=pageFixture(options),calls=[],checkpoints=[];
  const receipts={uploadStart:{fingerprint:'bound',taskSpaceId:8,mode:'injected',...(options.priorRetry?{failedUploadRetry:options.priorRetry}:{})}};
  let nativeId=options.nativeId||'',description='Approved body';
  const observation=()=>({
    gates:{authenticated:{ok:true},draftIdentity:{ok:true,evidence:{trustedVideoReceipt:options.trusted!==false,description,restoredIdentity:{existingDraft:false,actualId:null,ok:false}}},video:{ok:false,evidence:f.state.injected?{failed:false,uploaded:false,uploading:true}:f.state.cleared?{failed:false,uploaded:false,uploading:false}:{failed:true,uploaded:false,uploading:false,failureText:'网络出错'}}},
    evidence:{pageSample:f.context.document.body.innerText,earlyMutation:{ready:true}},
    ...(!f.state.cleared&&!f.state.injected?{blocker:{code:'PLATFORM_REJECTED_ASSET',evidence:{stage:'video_upload'}}}:{}),
  });
  const context={pkg:{wechatDescription:'Approved body'},expectedReceipts:receipts,expectedVideoReceipt:null,jobFingerprint:'bound',activeTaskSpace:{id:8},videoPath,fs,createHash,
    okGate:evidence=>({ok:true,evidence}),failedGate:evidence=>({ok:false,evidence}),
    compactText:v=>String(v||'').replace(/\s+/g,' ').trim(),typedBlocker:(code,message,extra={})=>({code,message,...extra}),
    inspect:async()=>observation(),native:async()=>({objectId:nativeId,hasPost:false}),
    readDraftSaveJournal:()=>options.journal||null,wechatJournalFile:()=>'/unused',wechatJournalIdentity:()=>({}),
    inspectFinalPublishGuard:async()=>({armed:options.guard!==false,blockedAttempts:0}),
    checkpointReceipts:value=>{calls.push('checkpoint');checkpoints.push(JSON.parse(JSON.stringify(value)));return {ok:options.checkpointFails!==true};},
    js:async expression=>vm.runInNewContext(expression,f.context),activate:async()=>{},wait:async()=>{},
    click:async(point,metadata)=>{
      calls.push(metadata.label);
      if(!f.state.popoverOpen){f.state.popoverOpen=true;
        if(options.changeNativeAfterEntry)nativeId='new-saved-id';
        if(options.changeDescriptionAfterEntry)description='Other video';
        if(options.changeSourceAfterEntry)fs.writeFileSync(videoPath,'changed bytes');
      }else{f.state.cleared=true;f.state.popoverOpen=false;
        if(options.disableInputAfterConfirm)f.input.disabled=true;
        if(options.interruptAfterConfirm)throw new Error('lost native click response');
      }
    },
    inject:async()=>{calls.push('inject:'+videoPath);f.state.injected=true;return {ok:true,objectId:'original-native-video-input'};},
  };
  const names=Object.keys(context);
  const build=new AsyncFunction(...names.filter(name=>!['inspect','native','activate','inject'].includes(name)), 'overrides', source+`
    inspectWechatChannels=overrides.inspect; activateWechatLifecycle=overrides.activate; injectWechatVideo=overrides.inject;
    const findWechatPostComponent=overrides.native;
    return {start:startWechatChannelsUpload,receipts:expectedReceipts};`);
  const args=names.filter(name=>!['inspect','native','activate','inject'].includes(name)).map(name=>context[name]);
  const api=await build(...args,{inspect:context.inspect,native:context.native,activate:context.activate,inject:context.inject});
  return {api,f,calls,checkpoints,videoPath};
}

test('one failed attachment reset checkpoints intent before both native clicks and injects approved source once',async t=>{
  const f=await workflow(t);const result=await f.api.start();
  assert.equal(result.blocker,undefined);assert.equal(result.gates.video.ok,false,'retry start is not completion or READY');
  const clicks=f.calls.filter(call=>call!=='checkpoint');
  assert.deepEqual(clicks,['open same-job failed WeChat attachment confirmation','confirm removal of same-job failed unsaved WeChat attachment','inject:'+f.videoPath]);
  assert.equal(f.calls[0],'checkpoint');assert.equal(f.checkpoints[0].uploadStart.failedUploadRetry.status,'entry_intent');
  assert.equal(result.actions.failedUploadRecovery.attempts,1);assert.equal(result.actions.failedUploadRecovery.status,'restarted');
  assert.equal(result.receipts.uploadStart.failedUploadRetry.source.sha256,createHash('sha256').update(fs.readFileSync(f.videoPath)).digest('hex'));
  await f.api.start();assert.equal(f.calls.filter(call=>call.startsWith('inject:')).length,1,'upload phase must resume, never reinject');
});

test('saved target, missing own injection trust or save intent never clicks or injects',async t=>{
  for(const options of [{nativeId:'saved-id'},{trusted:false},{journal:{status:'intent'}},{journal:{status:'confirmed'}},{guard:false},{priorRetry:{id:'earlier',status:'confirm_intent'}}]){
    const f=await workflow(t,options),result=await f.api.start();assert.ok(result.blocker);assert.equal(f.calls.length,0);
  }
});

test('failed durable retry checkpoint prevents even the first deletion click',async t=>{
  const f=await workflow(t,{checkpointFails:true}),result=await f.api.start();
  assert.ok(result.blocker);assert.deepEqual(f.calls,['checkpoint']);
});

test('native ID, approved description or exact source drift after entry blocks confirmation',async t=>{
  for(const options of [{changeNativeAfterEntry:true},{changeDescriptionAfterEntry:true},{changeSourceAfterEntry:true}]){
    const f=await workflow(t,options),result=await f.api.start();assert.ok(result.blocker);
    assert.equal(f.calls.filter(call=>call.startsWith('confirm removal')).length,0);assert.equal(f.calls.filter(call=>call.startsWith('inject:')).length,0);
  }
});

test('unknown native confirmation remains open without confirming or injecting',async t=>{
  const f=await workflow(t,{prompt:'删除此草稿？'}),result=await f.api.start();assert.ok(result.blocker);
  assert.equal(f.calls.filter(call=>call.startsWith('confirm removal')).length,0);assert.equal(f.calls.filter(call=>call.startsWith('inject:')).length,0);
});

test('input not ready after reset blocks reinjection',async t=>{
  const f=await workflow(t,{disableInputAfterConfirm:true}),result=await f.api.start();assert.ok(result.blocker);
  assert.equal(f.calls.filter(call=>call.startsWith('inject:')).length,0);
});

test('lost confirmation response preserves intent and cannot delete or inject a second time',async t=>{
  const f=await workflow(t,{interruptAfterConfirm:true});const interrupted=await f.api.start();assert.ok(interrupted.blocker);
  assert.equal(interrupted.receipts.uploadStart.failedUploadRetry.status,'confirm_intent','orchestrator must receive the durable intent, not only a browser-local counter');
  const count=f.calls.length;assert.ok((await f.api.start()).blocker);assert.equal(f.calls.length,count);
  assert.equal(f.api.receipts.uploadStart.failedUploadRetry.status,'confirm_intent');
  const nextProcess=await workflow(t,{priorRetry:interrupted.receipts.uploadStart.failedUploadRetry});
  assert.ok((await nextProcess.api.start()).blocker);assert.equal(nextProcess.calls.length,0,'a new upload child must not repeat an uncertain confirmation');
});

test('a second explicit failure is blocked by the durable one-retry receipt',async t=>{
  const f=await workflow(t);await f.api.start();f.f.state.injected=false;f.f.state.cleared=false;
  const count=f.calls.length;const result=await f.api.start();assert.ok(result.blocker);assert.equal(f.calls.length,count);
});
