import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const DIR=path.dirname(fileURLToPath(import.meta.url)),V2=path.dirname(DIR);
const source=fs.readFileSync(path.join(V2,'platforms/wechat-channels.mjs'),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const box=(name,data)=>{const b=Buffer.alloc(8+data.length);b.writeUInt32BE(b.length);b.write(name,4,'ascii');data.copy(b,8);return b;};
function tinyMp4(){const h=Buffer.alloc(20);h.writeUInt32BE(1000,12);h.writeUInt32BE(30000,16);return Buffer.concat([box('ftyp',Buffer.alloc(4)),box('moov',box('mvhd',h))]);}

async function inspectFixture(videoPath,options={}){
  const body='Approved body';
  const state={text:'网络出错，请重新上传。 删除 文件上传中，请等待完成后再编辑',url:'https://channels.weixin.qq.com/platform/post/create',
    description:body,shortTitle:'',shortTitleFound:true,aiGenerated:false,initToast:false,loginTextMatched:false,loadFailed:false,
    editorMarkers:{videoInput:true,descriptionEditor:true},identityMatches:true,identityAmbiguous:false,identityForeign:false,
    trustedVideoReceipt:true,originalEnabled:false,originalFound:true,coverUrls:[],coverUrlsBySlot:{vertical:[],horizontal:[]},combinedCover:false,
    dialogs:[],videoInputs:[{accept:'video/mp4',files:0}],rootCount:2,earlyMutation:{ready:true},failureControls:{present:true}};
  const context={pkg:{wechatDescription:body,cover:{uploadCustomCover:false}},expectedReceipts:{uploadStart:{fingerprint:'bound',taskSpaceId:8,mode:'injected',...(options.retry?{failedUploadRetry:{id:'old',status:'confirm_intent'}}:{})}},expectedVideoReceipt:null,
    jobFingerprint:'bound',activeTaskSpace:{id:8},phase:options.phase||'inspect',videoPath,fs,createHash,
    compactText:v=>String(v||'').replace(/\s+/g,' ').trim(),okGate:evidence=>({ok:true,evidence}),failedGate:evidence=>({ok:false,evidence}),
    typedBlocker:(code,message,extra={})=>({code,message,...extra}),
    readWechatRestoredIdentity:async()=>({ok:false,existingDraft:false,actualId:null}),
    findWechatPostComponent:async()=>({objectId:options.savedId||'',hasPost:false}),
    readDraftSaveJournal:()=>options.journal||null,wechatJournalFile:()=>'/fixture-only',wechatJournalIdentity:()=>({}),
    inspectFinalPublishGuard:async()=>({armed:options.guard!==false,blockedAttempts:0}),
    inspectFinalButtons:async()=>[{text:'发表',disabled:false,buttonish:true}],PLATFORM_URLS:{wechat_channels:'https://channels.weixin.qq.com/platform/post/create'},
  };
  const names=Object.keys(context);
  const run=new AsyncFunction(...names,'fixtureState','entryResult',`let js;
    ${source}
    js=async()=>({...fixtureState,...classifyWechatUploadText(fixtureState.text)});
    inspectWechatFailedUploadRecoveryControl=async()=>entryResult;
    return await inspectWechatChannels();`);
  return await run(...names.map(name=>context[name]),state,options.entry||{ok:true,stage:'entry',label:'删除',hitWithinControl:true});
}

function runPublisher(args,env){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
}

async function schedulingFixture(t,options={}){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-scheduling-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const videoPath=path.join(tmp,'approved.mp4');fs.writeFileSync(videoPath,tinyMp4());
  const observation=await inspectFixture(videoPath,options);
  assert.equal(observation.gates.video.ok,false);
  assert.equal(observation.gates.video.evidence.failed,true);
  assert.equal(observation.gates.video.evidence.uploading,false);
  assert.equal(observation.gates.video.evidence.failureText,'网络出错');
  const observationPath=path.join(tmp,'observation.json');fs.writeFileSync(observationPath,JSON.stringify(observation));
  const log=path.join(tmp,'events.ndjson'),runner=path.join(tmp,'runner.mjs');
  fs.writeFileSync(runner,`import fs from 'node:fs';
    const [platform,packagePath,phase]=process.argv.slice(2);
    fs.appendFileSync(process.env.TEST_PHASE_LOG,JSON.stringify({phase})+'\\n');
    const o=JSON.parse(fs.readFileSync(process.env.TEST_INSPECTION,'utf8'));
    Object.assign(o,{platform,phase,schemaVersion:1,taskSpaceId:8,taskSpace:process.env.VIDEO_PUBLISHER_V2_TASK_NAME,
      fingerprint:process.env.VIDEO_PUBLISHER_V2_FINGERPRINT,verificationRunId:process.env.VIDEO_PUBLISHER_V2_VERIFICATION_RUN_ID,
      observedAt:new Date().toISOString(),finalPublishClicked:false});
    o.gates.safety={ok:true,evidence:{guardArmed:true,blockedAttempts:0,finalPublishClicked:false}};
    o.gates.persistedDraft={ok:false,evidence:{reason:'fixture has no saved native draft'}};
    if(phase!=='inspect')o.blocker={code:'ACTION_FAILED',message:'Reached upload_start scheduling sentinel; no browser actions',retryable:false};
    console.log('VIDEO_PUBLISHER_V2_RESULT:'+JSON.stringify(o));`);
  const config=path.join(tmp,'config.json'),pkg=path.join(tmp,'package.json');
  fs.writeFileSync(config,JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:tmp,availablePlatforms:['wechat_channels'],defaultPlatforms:['wechat_channels'],declarations:{originalityPolicy:'all_videos_original'}}));
  fs.writeFileSync(pkg,JSON.stringify({videoPath,title:'Test',tags:['test'],wechatDescription:'Approved body',cover:{uploadCustomCover:false}}));
  const args=[path.join(V2,'publisher.mjs'),'--package',pkg,'--platforms','wechat_channels','--job-id','fixture-job','--state-root',tmp,'--no-cleanup-stale-spaces'];
  const result=await runPublisher(args,{VIDEO_PUBLISHER_CONFIG:config,VIDEO_PUBLISHER_V2_RUNNER:runner,
    VIDEO_PUBLISHER_V2_EGO_COMMAND:path.join(DIR,'mock-ego-cleanup.mjs'),VIDEO_PUBLISHER_V2_LOCK_ROOT:path.join(tmp,'locks'),
    VIDEO_PUBLISHER_DRAFTBOX_LEDGER_PATH:path.join(tmp,'ledger.json'),TEST_PHASE_LOG:log,TEST_INSPECTION:observationPath});
  assert.equal(result.code,10,result.stderr);
  const events=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).map(item=>item.phase);
  const job=JSON.parse(fs.readFileSync(path.join(tmp,'fixture-job/state.json')));
  return {observation,result,events,job};
}

test('actual production orchestrator schedules proven recoverable failed inspect into upload_start without making video ready',async t=>{
  const f=await schedulingFixture(t);
  assert.equal(f.observation.blocker,undefined);
  assert.equal(f.observation.evidence.failedUploadRecovery.eligible,true);
  assert.equal(f.observation.evidence.failedUploadRecovery.previousFailure.code,'PLATFORM_REJECTED_ASSET');
  assert.deepEqual(f.events,['inspect','upload_start']);
  assert.equal(f.job.platforms.wechat_channels.verdict.ready,false);
  assert.equal(f.job.platforms.wechat_channels.verdict.blocker.message,'Reached upload_start scheduling sentinel; no browser actions');
});

test('actual production orchestrator freezes nonrecoverable failed inspections and never starts upload',async t=>{
  for(const options of [{savedId:'saved-native-id'},{journal:{status:'intent'}},{retry:true},{guard:false},{entry:{ok:false,reason:'ambiguous entry'}}]){
    const f=await schedulingFixture(t,options);
    assert.equal(f.observation.blocker.code,'PLATFORM_REJECTED_ASSET');
    assert.equal(f.observation.evidence.failedUploadRecovery.eligible,false);
    assert.deepEqual(f.events,['inspect']);
    assert.equal(f.job.platforms.wechat_channels.status,'blocked');
  }
});

test('upload_start inspection retains its action failure for the bounded native recovery entry',async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-phase-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const video=path.join(tmp,'video.mp4');fs.writeFileSync(video,tinyMp4());
  const observation=await inspectFixture(video,{phase:'upload_start'});
  assert.equal(observation.blocker.code,'PLATFORM_REJECTED_ASSET');
  assert.equal(observation.blocker.evidence.stage,'video_upload');
  assert.equal(observation.gates.video.evidence.failed,true);
  assert.equal(observation.gates.video.ok,false);
});
