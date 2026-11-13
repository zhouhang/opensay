import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { xhsAutosaveRecoverySource, validateXhsAutosaveRecoverySource } from '../lib/xiaohongshu-autosave-recovery-source.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprint = 'a'.repeat(64);
const space = 'original exact XHS task name';
const title = 'Approved title';
const recoverySource = fs.readFileSync(new URL('../platforms/xiaohongshu-autosave-recovery.mjs', import.meta.url), 'utf8');
const adapter = fs.readFileSync(new URL('../platforms/xiaohongshu.mjs', import.meta.url), 'utf8');
const persistence = fs.readFileSync(new URL('../platforms/xiaohongshu-persistence.mjs', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function originalObservation() {
  return { platform:'xiaohongshu',fingerprint,taskSpaceId:7,taskSpace:space,
    observedAt:'2026-11-02T09:57:14.468Z',finalPublishClicked:false,
    gates:{authenticated:{ok:true},draftIdentity:{ok:true,evidence:{filenameVisible:true,
      restoredIdentity:{actualId:'original-uuid',uid:'owner',videoFileId:'spectrum/original-video'}}},
      video:{ok:true,evidence:{filename:'original.mp4'}},
      safety:{ok:true,evidence:{guardArmed:true,blockedAttempts:0,finalPublishClicked:false}}} };
}
function sourceFixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vp-xhs-autosave-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'original.json');
  const write=o=>fs.writeFileSync(file,JSON.stringify({observation:o}));
  write(originalObservation());
  const state={fingerprint,platforms:{xiaohongshu:{taskSpaceId:10,taskSpaceName:space,history:[{evidencePath:file}],lastEvidencePath:file}}};
  return {file,state,write,source:()=>xhsAutosaveRecoverySource(state)};
}

test('immutable filename-visible original upload grants only its exact account/UUID/video identity across same-name space recovery', t=>{
  const h=sourceFixture(t),s=h.source();
  assert.equal(s.draftId,'original-uuid');assert.equal(s.uid,'owner');
  assert.equal(s.originalSourceTaskSpaceId,7);assert.equal(s.taskSpaceId,10);
  assert.equal(s.evidenceSha256,hash(fs.readFileSync(h.file)));
  assert.equal(s.ready,undefined);assert.equal(s.persistedDraft,undefined);
  assert.equal(validateXhsAutosaveRecoverySource(s,{fingerprint,taskSpaceId:10,taskSpaceName:space,videoName:'original.mp4'}),s);
});

test('source rejects changed bytes, task name, filename, package, account, UUID or file ID bindings',t=>{
  const h=sourceFixture(t),s=h.source();
  const expected={fingerprint,taskSpaceId:10,taskSpaceName:space,videoName:'original.mp4'};
  for(const update of [{draftId:'other'},{uid:'other'},{videoFileId:'other'},{taskSpaceId:9},
    {originalSourceTaskSpaceId:9},{taskSpaceName:'other'},{fingerprint:'b'.repeat(64)},
    {videoName:'other.mp4'},{evidenceSha256:'0'.repeat(64)}]) {
    assert.throws(()=>validateXhsAutosaveRecoverySource({...s,...update},expected),JSON.stringify(update));
  }
  fs.appendFileSync(h.file,' ');
  assert.throws(()=>validateXhsAutosaveRecoverySource(s,expected),/artifact changed/);
});

test('plain title matches, partial uploads, unsafe history or recreated original-space evidence grant no recovery',t=>{
  const h=sourceFixture(t);
  for(const mutate of [o=>o.gates.video.ok=false,o=>o.gates.draftIdentity.evidence.filenameVisible=false,
    o=>o.gates.draftIdentity.evidence.restoredIdentity.videoFileId='',o=>o.gates.safety.evidence.blockedAttempts=1,
    o=>o.finalPublishClicked=true,o=>o.taskSpace='foreign',o=>o.taskSpaceRecovery={recreated:true}]) {
    const o=originalObservation();mutate(o);h.write(o);assert.equal(h.source(),null);
  }
});

test('unrelated Bilibili tag revision retains XHS original fingerprint; XHS revisions cannot use this first-delivery recovery',t=>{
  const h=sourceFixture(t);
  h.state.fingerprint='b'.repeat(64);h.state.platformFingerprints={xiaohongshu:fingerprint};
  h.state.tagRevision={platforms:['bilibili'],sources:{bilibili:{}}};
  assert.equal(h.source().fingerprint,fingerprint);
  h.state.tagRevision={platforms:['xiaohongshu'],sources:{xiaohongshu:{}}};
  assert.equal(h.source(),null);
});

test('conflicting historical native upload identities are ambiguous and cannot authorize either original',t=>{
  const h=sourceFixture(t),other=path.join(path.dirname(h.file),'conflict.json'),o=originalObservation();
  o.gates.draftIdentity.evidence.restoredIdentity.actualId='another-uuid';
  fs.writeFileSync(other,JSON.stringify({observation:o}));h.state.platforms.xiaohongshu.history.push({evidencePath:other});
  assert.equal(h.source(),null);
});

function nativeFixture(){return {uid:'owner',activeId:'empty-fresh-uuid',activeVideoFileId:'',activeTitle:'',activeDescription:'',
  isFromDraft:false,publication:{noteId:null,hasBeenPublished:false,hasBeenPublishSuccess:false},
  record:{id:'original-uuid',uid:'owner',publication:{},snapshot:{title,videoFileId:'spectrum/original-video'}},
  rows:[{id:'original-uuid',title,editCount:1}]};}
function recoveryHarness(options={}) {
  const s={draftId:'original-uuid',uid:'owner',videoFileId:'spectrum/original-video'},native=nativeFixture();
  options.mutate?.(native);let editClicks=0,listClicks=0,waits=0,arms=0;
  const scope=vm.createContext({xhsTitle:title,typedBlocker:(code,message,options)=>({code,message,...options}),
    inspectFinalPublishGuard:async()=>({armed:!options.badGuard,blockedAttempts:0}),
    armFinalPublishGuard:async()=>{arms++;},wait:async()=>{waits++;},
    probe:async()=>({source:s,native:structuredClone(native)}),
    js:async expression=>{
      if(expression.includes('.draft-title-box')){listClicks++;native.rows=[{id:s.draftId,title,editCount:1}];return true;}
      if(expression.includes('.draft-actions .btn')){
        editClicks++;
        if(!options.stuck){native.activeId=s.draftId;native.activeVideoFileId=s.videoFileId;native.isFromDraft=true;}
        return true;
      }
      throw new Error('Unexpected browser action');
    }});
  vm.runInContext(recoverySource+'\nprobeXhsAutosaveRecovery=probe;',scope);
  return {run:()=>vm.runInContext('recoverXhsAutosavedUpload()',scope),native,counters:()=>({editClicks,listClicks,waits,arms})};
}

test('recovery opens only the exact unique original UUID edit action and freshly checks account/video identity',async()=>{
  const h=recoveryHarness(),result=await h.run();
  assert.equal(result.ok,true);assert.equal(result.reopened,true);
  assert.deepEqual(h.counters(),{editClicks:1,listClicks:0,waits:1,arms:1});
  assert.equal(h.native.activeId,'original-uuid');
});

test('foreign or missing account/UUID/video, foreign active editor, publication markers and unsafe controls block before edit',async()=>{
  for(const mutate of [n=>n.uid='other',n=>n.record=null,n=>n.record.id='other',n=>n.record.uid='other',
    n=>n.record.snapshot.videoFileId='other',n=>n.record.snapshot.title='other',
    n=>n.activeVideoFileId='foreign',n=>n.activeTitle='foreign',n=>n.activeDescription='foreign',
    n=>n.publication.noteId='published',n=>n.record.publication.hasBeenPublished=true,
    n=>n.rows.push({...n.rows[0]}),n=>n.rows[0].editCount=2,n=>n.rows[0].title='other']) {
    const h=recoveryHarness({mutate});assert.equal((await h.run()).ok,false);assert.equal(h.counters().editClicks,0);
  }
  const h=recoveryHarness({badGuard:true});assert.equal((await h.run()).ok,false);assert.equal(h.counters().editClicks,0);
});

test('recovery does not re-click original edit or reinject video after a stuck native transition',async()=>{
  const h=recoveryHarness({stuck:true}),result=await h.run();
  assert.equal(result.ok,false);assert.equal(h.counters().editClicks,1);assert.equal(h.counters().waits,30);
});

test('already reopened original is reused without navigation, edit, saving or upload',async()=>{
  const h=recoveryHarness({mutate:n=>{n.activeId='original-uuid';n.activeVideoFileId='spectrum/original-video';n.isFromDraft=true;}});
  assert.equal((await h.run()).reused,true);assert.equal(h.counters().editClicks,0);
});

test('upload_start and upload cannot fall through to file injection when original recovery fails or remains unverified',async()=>{
  for(const method of ['startXiaohongshuUpload','uploadXiaohongshu'])for(const kind of ['blocked','unverified','ready']){
    let uploads=0,inspects=0;
    const run=new AsyncFunction('pkg','videoPath','inspect','recover','uploadFile','typedBlocker',`${adapter}\ninspectXiaohongshu=inspect;const recoverXhsAutosavedUpload=recover;return ${method}();`);
    const result=await run({platformTitle:{xiaohongshu:title},xhsTopics:[],cover:{}},'/original.mp4',async()=>{
      inspects++;return {gates:{video:{ok:kind==='ready'&&inspects>1,evidence:{}},draftIdentity:{ok:true}}};
    },async()=>kind==='blocked'?{ok:false,blocker:{code:'STATE_AMBIGUOUS'}}:{ok:true,reopened:true},
    async()=>{uploads++;throw new Error('No injection allowed');},(code,message,extra)=>({code,message,...extra}));
    assert.equal(uploads,0);assert.equal(inspects,2);
    if(kind==='ready')assert.equal(result.actions.upload.mode,'resume_existing');else assert.equal(result.blocker.code,'STATE_AMBIGUOUS');
  }
});

test('autosave reopening grants restored identity only for exact original and stored account/UUID/video; no persistence proof minted',async()=>{
  const source={draftId:'original-uuid',uid:'owner',videoFileId:'spectrum/original-video',evidencePath:'/source',evidenceSha256:'a'.repeat(64)};
  const native={available:true,isFromDraft:true,id:source.draftId,uid:source.uid,live:{videoFileId:source.videoFileId},
    record:{id:source.draftId,uid:source.uid,snapshot:{videoFileId:source.videoFileId}}};
  const run=new AsyncFunction('readNative','source','readDraftSaveJournal','browserDraftSaveJournalFile','platform','jobFingerprint',`${persistence}\nreadXhsNativeDraft=readNative;const readBrowserTagRevisionSource=()=>null,readBrowserCoverRevisionSource=()=>null,readXhsAutosaveRecoverySource=()=>source;return readXhsRestoredIdentity();`);
  const invoke=n=>run(async()=>n,source,()=>null,()=>'/absent','xiaohongshu',fingerprint);
  const result=await invoke(native);assert.equal(result.ok,true);assert.equal(result.autosaveRecovery,true);assert.equal(result.persistedDraft,undefined);
  for(const mutate of [n=>n.id='other',n=>n.uid='other',n=>n.record.uid='other',n=>n.live.videoFileId='other',n=>n.record.snapshot.videoFileId='other',n=>n.isFromDraft=false]){
    const n=structuredClone(native);mutate(n);assert.equal((await invoke(n)).ok,false);
  }
});
