import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';
import * as journalHelpers from '../lib/video-replacement-journal.mjs';

function harness(platform,{foreign=false,published=false,changedMetadata=false,oldNativeFile=false,coverPixelsFail=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vp-native-replace-'));
  const file=path.join(dir,'replacement.json'),cover=path.join(dir,'approved.png');
  fs.writeFileSync(cover,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('approved cover bytes')]));
  const video=path.join(dir,'new.mp4');fs.writeFileSync(video,Buffer.alloc(64,7));const stat=fs.statSync(video);
  const local={path:video,size:stat.size,lastModified:Math.trunc(stat.mtimeMs),sha256:createHash('sha256').update(fs.readFileSync(video)).digest('hex'),width:1280,height:720};
  const source={sourceDraftId:'original-1',sourceTaskSpaceId:72,sourceVideoIdentity:{sha256:'a'.repeat(64)},nextVideoIdentity:{sha256:local.sha256}};
  let injected=0,cleared=0,mutations=0;
  let native={draftId:foreign?'foreign':'original-1',existingDraft:true,published,partCount:1,mediaCount:1,fileCount:1,
    nativeFileIds:['old-file'],uploadComplete:true,selectedFile:{name:'old.mp4',size:1},nativeSize:1,
    width:1280,height:720,metadata:{title:'Title',tid:231,copyright:null,noReprint:null}};
  const base=()=>({gates:Object.fromEntries(['authenticated','draftIdentity','video','title','description','tags','original','cover','noBlockingDialog','finalButton','shortTitle'].map(k=>[k,{ok:true,evidence:{}}]))});
  function observation(){const o=base();Object.assign(o.gates.title.evidence,{actual:'Title'});Object.assign(o.gates.description.evidence,{actual:changedMetadata&&mutations?'Changed':'Approved body'});Object.assign(o.gates.tags.evidence,{chips:['AI']});Object.assign(o.gates.original.evidence,{noMark:true,selfMade:true,enabled:true});Object.assign(o.gates.shortTitle.evidence,{actual:''});return o;}
  const context=vm.createContext({fs,Buffer,createHash,...journalHelpers,platform,jobFingerprint:'new-fingerprint',activeTaskSpace:{id:72},
    videoReplacementJournalPath:file,localMediaMetadata:local,videoPath:local.path,expectedReceipts:{},expectedVideoReceipt:null,
    pkg:{platformTitle:{bilibili:'Title'},bilibiliDescription:'Approved body',bilibiliTags:['AI'],bilibiliAllowedAutoTags:[],wechatDescription:'Approved body',
      cover:{uploadCustomCover:true,horizontal4x3Path:cover,vertical3x4Path:cover}},
    readBiliDraftList:async()=>[{id:'original-1'}],biliEntryId:entry=>entry.id,readWechatDraftList:async()=>[{objectId:'original-1'}],
    readBrowserVideoRevisionSource:()=>source,readNative:async()=>structuredClone(native),baseObservation:observation,
    observedInjection:async()=>{assert.equal(journalHelpers.readVideoReplacementJournal(file,{platform,fingerprint:'new-fingerprint'}).status,'intent');injected++;
      if(!oldNativeFile)native={...native,nativeFileIds:['new-file'],uploadComplete:true,selectedFile:{name:'new.mp4',size:local.size},nativeSize:local.size};return {ok:true};},
    observedClear:async()=>{assert.equal(journalHelpers.readVideoReplacementJournal(file,{platform,fingerprint:'new-fingerprint'}).status,'intent');cleared++;return {ok:true};},
    observedMutation:async()=>{mutations++;return observation();},nativePixels:async()=>({ok:!coverPixelsFail}),wait:async()=>{},activateWechatLifecycle:async()=>{},
    okGate:evidence=>({ok:true,evidence}),failedGate:evidence=>({ok:false,evidence}),typedBlocker:(code,message,options)=>({code,message,...options})});
  const sourceFile=platform==='bilibili'?'bilibili.mjs':'wechat-channels.mjs';
  vm.runInContext(fs.readFileSync(new URL('../platforms/'+sourceFile,import.meta.url),'utf8'),context);
  const prefix=platform==='bilibili'?'Bilibili':'Wechat';
  vm.runInContext(`read${prefix}VideoRevisionNative=readNative;\n`+
    (platform==='bilibili'?`injectBilibiliOriginalPartReplacement=observedInjection; mutateBilibili=observedMutation;`:
      `clearWechatOriginalDraftVideo=observedClear;injectWechatVideo=observedInjection;mutateWechatChannels=observedMutation;compareWechatReplacementCoverPixels=nativePixels;activateWechatLifecycle=async()=>{};`)+
    `inspect${platform==='bilibili'?'Bilibili':'WechatChannels'}=async()=>{const o=baseObservation();o.gates.replaceVideo=await read${prefix}VideoReplacementProof(o);return o}`,context);

  return {run:()=>vm.runInContext('replaceOriginalDraftVideo()',context),
    journal:()=>journalHelpers.readVideoReplacementJournal(file,{platform,fingerprint:'new-fingerprint'}),
    setPending:()=>{const metadataHash=platform==='bilibili'?journalHelpers.videoReplacementSnapshotHash({archive:native.metadata,title:'Title',description:'Approved body',tags:['AI'],original:{noMark:true,selfMade:true}}):journalHelpers.videoReplacementSnapshotHash({description:'Approved body',shortTitle:'',original:true});
      const coverHash=vm.runInContext(platform==='bilibili'?'bilibiliReplacementCoverHash()':'wechatReplacementCoverHash()',context);
      journalHelpers.beginVideoReplacement(file,{platform,fingerprint:'new-fingerprint'},{sourceDraftId:'original-1',sourceTaskSpaceId:72,sourceNativeFileIds:['old-file'],sourceVideoSha256:'a'.repeat(64),nextVideoSha256:local.sha256,sourceMetadataHash:metadataHash,sourceCoverHash:coverHash,originalDraftVerified:true,liveSourceDraftId:'original-1',nextVideoPath:local.path,nextVideoSize:local.size,nextVideoMtimeMs:local.lastModified});},
    normalized:(valid=false)=>{native={...native,nativeFileIds:['processed-native-md5'],nativeSize:local.size-1};context.readWechatServerMediaNormalization=()=>({ok:valid,evidence:{method:'official-native-download-full-content-comparison'}})},
    counters:()=>({injected,cleared,mutations}),cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}

for(const platform of ['bilibili','wechat_channels']){
  test(`${platform}: durable intent precedes native input and confirmed rerun never injects again`,async()=>{
    const h=harness(platform);try{const first=await h.run();assert.equal(first.gates.replaceVideo.ok,true);assert.equal(h.journal().status,'confirmed');assert.deepEqual(Array.from(h.journal().evidence.nativeFileIds),['new-file']);assert.equal((await h.run()).gates.replaceVideo.ok,true);assert.equal(h.counters().injected,1);assert.equal(h.counters().cleared,platform==='wechat_channels'?1:0)}finally{h.cleanup()}
  });
  test(`${platform}: original-ID and publication guards run before any clear, intent or injection`,async()=>{
    for(const options of [{foreign:true},{published:true}]){const h=harness(platform,options);try{assert.equal((await h.run()).blocker.code,'STATE_AMBIGUOUS');assert.equal(h.journal(),null);assert.deepEqual(h.counters(),{injected:0,cleared:0,mutations:0})}finally{h.cleanup()}}
  });
  test(`${platform}: unresolved intent never injects the same media a second time`,async()=>{
    const h=harness(platform);try{h.setPending();assert.equal((await h.run()).blocker.code,'PERSISTENCE_UNVERIFIED');assert.equal(h.counters().injected,0);assert.equal(h.counters().cleared,0);assert.equal(h.journal().status,'intent')}finally{h.cleanup()}
  });
  test(`${platform}: changed copy cannot confirm new media`,async()=>{
    const h=harness(platform,{changedMetadata:true});try{assert.equal((await h.run()).blocker.code,'PERSISTENCE_UNVERIFIED');assert.equal(h.journal().status,'intent');assert.equal(h.counters().injected,1)}finally{h.cleanup()}
  });
}

test('WeChat: wrong native cover pixels stop before original video removal',async()=>{
  const h=harness('wechat_channels',{coverPixelsFail:true});try{assert.equal((await h.run()).blocker.code,'STATE_AMBIGUOUS');assert.equal(h.journal(),null);assert.equal(h.counters().cleared,0)}finally{h.cleanup()}
});


test('WeChat processed native IDs require an explicit verified normalization lineage and retain original upload byte identity',async()=>{
  const h=harness('wechat_channels');try{assert.equal((await h.run()).gates.replaceVideo.ok,true);
    const original=JSON.stringify(h.journal());h.normalized(false);assert.equal((await h.run()).blocker.code,'PERSISTENCE_UNVERIFIED');
    h.normalized(true);const result=await h.run();assert.equal(result.gates.replaceVideo.ok,true);
    assert.equal(result.gates.replaceVideo.evidence.localFile.size,64);assert.equal(result.gates.replaceVideo.evidence.nativeVideoSize,63);
    assert.equal(result.gates.replaceVideo.evidence.serverNormalization.method,'official-native-download-full-content-comparison');
    assert.equal(JSON.stringify(h.journal()),original);assert.equal(h.counters().injected,1);
  }finally{h.cleanup()}
});
