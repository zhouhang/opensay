import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';
import * as helpers from '../lib/video-replacement-journal.mjs';
const main=fs.readFileSync(new URL('../platforms/xiaohongshu.mjs',import.meta.url),'utf8');
const persistence=fs.readFileSync(new URL('../platforms/xiaohongshu-persistence.mjs',import.meta.url),'utf8');

function harness({foreignId=false,foreignUid=false,published=false,changedCopy=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vp-xhs-replace-')),file=path.join(dir,'intent.json'),video=path.join(dir,'new.mp4'),cover=path.join(dir,'cover.webp');
  fs.writeFileSync(video,Buffer.alloc(64,7));fs.writeFileSync(cover,'approved cover bytes');const stat=fs.statSync(video);
  const local={path:video,size:64,lastModified:Math.trunc(stat.mtimeMs),sha256:createHash('sha256').update(fs.readFileSync(video)).digest('hex')};
  const sourceSnapshot={title:'Title',description:'Body #AI',descriptionHtml:'<p>Body <a>#AI</a></p>',videoFileId:'spectrum/old',transcodeFileId:'',coverFileId:'spectrum/approved-cover',original:true};
  const r={sourceDraftId:'original-uuid',sourceUid:'user-1',sourceVideoFileId:'spectrum/old',sourceTaskSpaceId:81,
    sourcePersistedDraft:{uid:'user-1',snapshotHash:helpers.videoReplacementSnapshotHash(sourceSnapshot)},sourceVideoIdentity:{sha256:'a'.repeat(64)},nextVideoIdentity:{sha256:local.sha256}};
  let injected=0,mutations=0;
  let native={available:true,isFromDraft:true,id:foreignId?'foreign':'original-uuid',uid:foreignUid?'foreign':'user-1',publication:{noteId:published?'published-note':null},live:{...sourceSnapshot},
    record:{id:'original-uuid',uid:'user-1',snapshot:{...sourceSnapshot}}};
  const observation=()=>({gates:Object.fromEntries(['authenticated','draftIdentity','video','title','description','tags','original','cover','noBlockingDialog','finalButton'].map(key=>[key,{ok:true,evidence:{}}]))});
  const context=vm.createContext({fs,path,Buffer,createHash,...helpers,pkg:{platformTitle:{xiaohongshu:'Title'},xhsTopics:['AI'],xhsDescription:'Body',cover:{uploadCustomCover:true,vertical3x4Path:cover}},
    platform:'xiaohongshu',jobFingerprint:'new-fingerprint',activeTaskSpace:{id:81},videoReplacementJournalPath:file,videoPath:video,localMediaMetadata:local,expectedReceipts:{},
    readBrowserVideoRevisionSource:()=>r,readNative:async()=>structuredClone(native),readDetails:async()=>({fileid:native.live.videoFileId,size:64,ready:true}),
    baseObservation:observation,xhsSnapshotHash:helpers.videoReplacementSnapshotHash,typedBlocker:(code,message,options)=>({code,message,...options}),okGate:evidence=>({ok:true,evidence}),failedGate:evidence=>({ok:false,evidence}),
    observedInject:async()=>{assert.equal(helpers.readVideoReplacementJournal(file,{platform:'xiaohongshu',fingerprint:'new-fingerprint'}).status,'intent');injected++;native.live.videoFileId='spectrum/new';native.record.snapshot.videoFileId='spectrum/new';return {ok:true}},
    observedMetadata:async()=>{mutations++;if(changedCopy)native.live.description='Changed';return {ok:true,current:observation(),actions:{}}},wait:async()=>{}});
  vm.runInContext(main,context);
  vm.runInContext(`openXhsOriginalVideoRevision=async()=>({ok:true});readXhsNativeDraft=readNative;readXhsReplacementVideoDetails=readDetails;injectXhsOriginalVideoReplacement=observedInject;ensureXiaohongshuEarlyMetadata=observedMetadata;ensureXhsOriginal=async()=>({ok:true});inspectXiaohongshu=async()=>{const o=baseObservation();o.gates.replaceVideo=await readXhsVideoReplacementProof(o,await readNative());return o}`,context);
  return {run:()=>vm.runInContext('replaceOriginalDraftVideo()',context),journal:()=>helpers.readVideoReplacementJournal(file,{platform:'xiaohongshu',fingerprint:'new-fingerprint'}),
    context,native:()=>native,source:r,counters:()=>({injected,mutations}),cleanup:()=>fs.rmSync(dir,{recursive:true,force:true}),
    pending:()=>helpers.beginVideoReplacement(file,{platform:'xiaohongshu',fingerprint:'new-fingerprint'},
      {sourceDraftId:'original-uuid',sourceTaskSpaceId:81,sourceNativeFileIds:['spectrum/old'],sourceVideoSha256:'a'.repeat(64),nextVideoSha256:local.sha256,
        sourceMetadataHash:helpers.videoReplacementSnapshotHash({title:sourceSnapshot.title,description:sourceSnapshot.description,descriptionHtml:sourceSnapshot.descriptionHtml,original:true}),
        sourceCoverHash:vm.runInContext('xhsReplacementCoverHash()',context),originalDraftVerified:true,liveSourceDraftId:'original-uuid',nextVideoPath:video,nextVideoSize:64,nextVideoMtimeMs:local.lastModified})};
}

test('XHS replacement records durable intent before exact native reupload and replay never reinjects',async()=>{
  const h=harness();try{const result=await h.run();assert.equal(result.gates.replaceVideo.ok,true);assert.equal(h.journal().status,'confirmed');assert.deepEqual(Array.from(h.journal().evidence.nativeFileIds),['spectrum/new']);assert.equal(h.journal().evidence.draftId,'original-uuid');assert.equal((await h.run()).gates.replaceVideo.ok,true);assert.equal(h.counters().injected,1)}finally{h.cleanup()}
});

test('XHS original UUID, account and positive published signals block before intent or injection',async()=>{
  for(const options of [{foreignId:true},{foreignUid:true},{published:true}]){const h=harness(options);try{assert.equal((await h.run()).blocker.code,'STATE_AMBIGUOUS');assert.equal(h.journal(),null);assert.equal(h.counters().injected,0)}finally{h.cleanup()}}
});

test('XHS unresolved reupload intent cannot inject another copy or silently restart',async()=>{
  const h=harness();try{h.pending();assert.equal((await h.run()).blocker.code,'PERSISTENCE_UNVERIFIED');assert.equal(h.journal().status,'intent');assert.equal(h.counters().injected,0)}finally{h.cleanup()}
});

test('XHS new native file cannot confirm with a changed source description or topic HTML',async()=>{
  const h=harness({changedCopy:true});try{assert.equal((await h.run()).blocker.code,'PERSISTENCE_UNVERIFIED');assert.equal(h.journal().status,'intent');assert.equal(h.counters().injected,1)}finally{h.cleanup()}
});

test('XHS native media reader uses persisted fsize, not filename or a cover-only signal',async()=>{
  const app={config:{globalProperties:{$pinia:{_s:new Map([['draft',{video:{fileid:'spectrum/new',fsize:115032686,width:1280,height:720}}]])}}}};
  const context=vm.createContext({pkg:{platformTitle:{xiaohongshu:'Title'},xhsTopics:[],cover:{}},videoPath:'/new.mp4',
    js:async expression=>vm.runInNewContext(expression,{document:{querySelectorAll:()=>[{__vue_app__:app}]}})});
  vm.runInContext(main,context);const result=await vm.runInContext('readXhsReplacementVideoDetails()',context);assert.equal(result.size,115032686);assert.equal(result.fileid,'spectrum/new');
});

test('XHS source record account, UUID, original file and full snapshot are checked before opening the editor',async()=>{
  const original=main.slice(main.indexOf('async function openXhsOriginalVideoRevision('),main.indexOf('async function injectXhsOriginalVideoReplacement('));
  for(const changed of ['account','recordUid','uuid','file','snapshot']){
    let interactions=0;
    const snapshot={title:'Title',videoFileId:'spectrum/old'};
    const stored={uid:'user-1',record:{id:'original-uuid',uid:'user-1',snapshot:{...snapshot}}};
    if(changed==='account')stored.uid='other';if(changed==='recordUid')stored.record.uid='other';if(changed==='uuid')stored.record.id='other';if(changed==='file')stored.record.snapshot.videoFileId='other';if(changed==='snapshot')stored.record.snapshot.title='other';
    const context=vm.createContext({platform:'xiaohongshu',jobFingerprint:'new',videoReplacementJournalPath:'/unused',
      readVideoReplacementJournal:()=>null,readXhsStoredDraft:async()=>stored,xhsSnapshotHash:helpers.videoReplacementSnapshotHash,
      js:async expression=>{if(expression==='location.href')return 'https://creator.xiaohongshu.com/publish/publish';interactions++;throw new Error('UI action was not allowed')},
      readXhsNativeDraft:async()=>{throw new Error('source mismatch should stop before editor access')},
      xhsVideoRevisionPublished:()=>false,PLATFORM_URLS:{xiaohongshu:'https://creator.xiaohongshu.com/publish/publish'}});
    vm.runInContext(original,context);
    const result=await vm.runInContext(`openXhsOriginalVideoRevision(${JSON.stringify({sourceDraftId:'original-uuid',sourceUid:'user-1',sourceVideoFileId:'spectrum/old',sourcePersistedDraft:{snapshotHash:helpers.videoReplacementSnapshotHash(snapshot)}})})`,context);
    assert.equal(result.ok,false,changed);assert.equal(interactions,0,changed);
  }
});

test('XHS restored identity allows the confirmed replacement file only on the same original account and UUID',async()=>{
  const h=harness();try{await h.run();const c=h.context;
    c.readBrowserTagRevisionSource=()=>null;c.readBrowserCoverRevisionSource=()=>null;c.readDraftSaveJournal=()=>null;c.browserDraftSaveJournalFile=()=>'/unused';
    vm.runInContext(persistence,c);vm.runInContext('readXhsNativeDraft=readNative',c);
    assert.equal((await vm.runInContext('readXhsRestoredIdentity()',c)).ok,true);
    h.native().live.videoFileId='spectrum/substituted';assert.equal((await vm.runInContext('readXhsRestoredIdentity()',c)).ok,false);
  }finally{h.cleanup()}
});
