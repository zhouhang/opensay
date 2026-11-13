import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { validateXhsHumanAuthorization, readXhsHumanAuthorization, explicitXhsReconcileAuthorization,
  validateXhsReconcileNative, archiveXhsOriginalJournal } from '../lib/xiaohongshu-reconcile-authorization.mjs';
import { readVideoReplacementAuthorization, explicitVideoReplacementAuthorization } from '../lib/video-replacement-authorization.mjs';
import { readDraftSaveJournal, restartConfirmedDraftSave } from '../lib/draft-save-journal.mjs';

const expected={jobId:'old-job',sourceFingerprint:'original-fingerprint',sourceTaskSpaceId:135,
  sourceTaskSpaceName:'original XHS space',uid:'owner',sourceDraftId:'stable-uuid',
  sourceVideoFileId:'spectrum/old-file',nextVideoSha256:'a'.repeat(64)};
const auth=()=>({version:2,kind:'user_attested_original_draft_replacement',platform:'xiaohongshu',...expected,
  sourceJournalSha256:'b'.repeat(64),scopes:['unpublished','original-recovery','replace-video'],
  authorizationSource:{type:'direct-human-message',answer:'都还未发布，直接发布算了，包括YouTube',source:'current chat human reply'},
  nativePublicationStatusProof:false,attestedAt:new Date().toISOString(),allowMissingOriginalTaskSpaceRecovery:true});
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'vp-xhs-reconcile-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function native(){const snapshot={title:'approved title',description:'approved body',descriptionHtml:'<p>approved body</p>',
  videoFileId:expected.sourceVideoFileId,transcodeFileId:'',coverFileId:'spectrum/approved-cover',original:true};
  return{available:true,isFromDraft:true,id:expected.sourceDraftId,uid:expected.uid,live:structuredClone(snapshot),
    publication:{noteId:null,hasBeenPublished:false,hasBeenPublishSuccess:false},
    record:{id:expected.sourceDraftId,uid:expected.uid,snapshot:structuredClone(snapshot)}};}
const context=()=>({platform:'xiaohongshu',jobId:expected.jobId,sourceFingerprint:expected.sourceFingerprint,
  sourceTaskSpaceId:135,originalSourceTaskSpaceId:135,sourceTaskSpaceName:expected.sourceTaskSpaceName,
  sourceDraftId:expected.sourceDraftId,sourceUid:expected.uid,sourceVideoFileId:expected.sourceVideoFileId,
  originalJournalSha256:'b'.repeat(64),nextVideoIdentity:{sha256:expected.nextVideoSha256}});
const inspection=()=>({gates:Object.fromEntries(['authenticated','draftIdentity','video','title','description','tags',
  'original','cover','noBlockingDialog','finalButton','safety'].map(key=>[key,{ok:true}]))});

test('v2 preserves actual human answer without requiring a canned quote',()=>{
  const a=auth();assert.equal(validateXhsHumanAuthorization(a,expected).authorizationSource.answer,a.authorizationSource.answer);
});
test('authority is explicit, recent, identity-bound and never labelled native proof',()=>{
  for(const change of [{version:1},{nativePublicationStatusProof:true},{scopes:['unpublished']},
    {authorizationSource:{type:'agent',answer:'yes',source:'agent'}},{sourceVideoFileId:'foreign'},
    {attestedAt:new Date(Date.now()-86400001).toISOString()},{sourceJournalSha256:''}]){
    assert.throws(()=>validateXhsHumanAuthorization({...auth(),...change},expected));
  }
});
test('same auth cannot authorize generic upload, auto recovery, or publishing',t=>{
  const root=fixture(t),file=path.join(root,'authorization.json');fs.writeFileSync(file,JSON.stringify(auth()));
  const r={...context(),userAuthorization:readXhsHumanAuthorization(file,expected)};
  for(const phase of ['persist','verify','park'])assert.equal(explicitXhsReconcileAuthorization(r,'reconcile-xhs-original',phase),true);
  for(const phase of ['upload_start','upload','mutate','replace_video'])assert.equal(explicitXhsReconcileAuthorization(r,'reconcile-xhs-original',phase),false);
  for(const operation of ['auto','resume','inspect','publish'])assert.equal(explicitXhsReconcileAuthorization(r,operation,'persist'),false);
  fs.appendFileSync(file,' ');assert.equal(explicitXhsReconcileAuthorization(r,'reconcile-xhs-original','persist'),false);
});
test('v2 works with existing video-replacement validation and keeps raw answer',t=>{
  const root=fixture(t),file=path.join(root,'authorization.json');fs.writeFileSync(file,JSON.stringify(auth()));
  const a=readVideoReplacementAuthorization(file,expected);
  const r={...context(),userAuthorization:a};
  assert.equal(explicitVideoReplacementAuthorization(r,'replace-video'),true);
  assert.equal(a.authorizationSource.answer,'都还未发布，直接发布算了，包括YouTube');
});
test('native exact original with matching record/live and full business gates may reconcile',()=>{
  assert.equal(validateXhsReconcileNative(native(),inspection(),context()).draftId,expected.sourceDraftId);
});
test('positive published marker always outranks human unpublished attestation',()=>{
  for(const publication of [{noteId:'posted-id'},{hasBeenPublished:true},{hasBeenPublishSuccess:true}]){
    assert.throws(()=>validateXhsReconcileNative({...native(),publication},inspection(),context()),/published/);
  }
});
test('foreign UUID/account/media or record/live drift cannot be saved',()=>{
  for(const change of [{id:'other-id'},{uid:'other-owner'},{isFromDraft:false},{available:false}]){
    assert.throws(()=>validateXhsReconcileNative({...native(),...change},inspection(),context()));
  }
  for(const change of [{videoFileId:'other-file'},{title:'edited title'},{coverFileId:'wrong-cover'}]){
    const n=native();Object.assign(n.live,change);assert.throws(()=>validateXhsReconcileNative(n,inspection(),context()));
  }
});
test('one missing live business or safety gate prevents a journal restart',()=>{
  for(const key of Object.keys(inspection().gates)){
    const i=inspection();i.gates[key].ok=false;assert.throws(()=>validateXhsReconcileNative(native(),i,context()),/not verified/);
  }
  assert.throws(()=>validateXhsReconcileNative(native(),{...inspection(),blocker:{code:'AUTH_REQUIRED'}},context()));
});
test('journal archive preserves exact original bytes and rejects mutation',t=>{
  const root=fixture(t),file=path.join(root,'journal.json'),archive=path.join(root,'reconciliation/original.json');
  const bytes=Buffer.from('{"status":"confirmed"}\n  ');fs.writeFileSync(file,bytes);
  const digest=createHash('sha256').update(bytes).digest('hex');
  archiveXhsOriginalJournal(file,archive,digest);assert.deepEqual(fs.readFileSync(file),bytes);assert.deepEqual(fs.readFileSync(archive),bytes);
  archiveXhsOriginalJournal(file,archive,digest);
  fs.appendFileSync(file,' ');assert.throws(()=>archiveXhsOriginalJournal(file,archive,digest),/changed/);
  assert.deepEqual(fs.readFileSync(archive),bytes);
});

test('confirmed native revalidation archives old bytes before a same-UUID pending real save',async t=>{
  const root=fixture(t),file=path.join(root,'journal.json'),a=auth(),authFile=path.join(root,'authorization.json');
  const id={platform:'xiaohongshu',fingerprint:expected.sourceFingerprint};
  const old={version:1,...id,status:'confirmed',attemptId:'old',startedAt:'2026-10-01T00:00:00Z',savedAt:'2026-10-01T00:01:00Z',
    plan:{id:expected.sourceDraftId,uid:expected.uid,videoFileId:expected.sourceVideoFileId,snapshotHash:'c'.repeat(64),
      url:'https://creator.xiaohongshu.com/publish/publish?target=video',listUrl:'https://creator.xiaohongshu.com/publish/publish?target=video'}};
  const bytes=JSON.stringify(old)+'\n';fs.writeFileSync(file,bytes);a.sourceJournalSha256=createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(authFile,JSON.stringify(a));const r={...context(),originalJournalSha256:a.sourceJournalSha256,
    userAuthorization:readXhsHumanAuthorization(authFile,expected),originalJournalArchivePath:path.join(root,'archive.json'),
    recoveryEvidencePath:path.join(root,'native.json')};
  const code=fs.readFileSync(new URL('../platforms/xiaohongshu-reconcile.mjs',import.meta.url),'utf8');
  const c=vm.createContext({fs,path,createHash,xhsReconcileContext:r,platform:'xiaohongshu',phase:'persist',taskName:expected.sourceTaskSpaceName,
    jobFingerprint:expected.sourceFingerprint,verificationRunId:'new-independent-run',activeTaskSpace:{id:14},
    explicitXhsReconcileAuthorization,validateXhsReconcileNative,archiveXhsOriginalJournal,restartConfirmedDraftSave,
    inspectFinalPublishGuard:async()=>({armed:true,blockedAttempts:0}),n:{...native(),record:{...native().record,timeStamp:123}},
    i:{gates:{...inspection().gates,title:{ok:false}}},journal:old,file,identity:id,waitCalls:0,
    readXhsNativeDraft:async()=>({...native(),record:{...native().record,timeStamp:123}}),inspectXiaohongshu:async()=>inspection()});
  c.wait=async()=>{c.waitCalls++;};
  vm.runInContext(code,c);await vm.runInContext('reconcileXhsConfirmedJournal(n,i,journal,file,identity)',c);
  assert.equal(fs.readFileSync(r.originalJournalArchivePath,'utf8'),bytes);
  const pending=readDraftSaveJournal(file,id);assert.equal(pending.status,'intent');assert.equal(pending.plan.id,expected.sourceDraftId);
  assert.equal(pending.plan.createdVerificationRunId,'new-independent-run');assert.equal(pending.plan.recoveryEvidence.originalJournalSha256,a.sourceJournalSha256);
  assert.equal(c.waitCalls,1,'wait for the real original editor title to render before saving');
  assert.equal(JSON.parse(fs.readFileSync(r.recoveryEvidencePath)).kind,'actual-original-native-revalidation');
  await assert.rejects(()=>vm.runInContext('reconcileXhsConfirmedJournal(n,i,journal,file,identity)',c),/changed/);
});

test('child failure capture preserves actual missing-name observation and redacts token data',t=>{
  const root=fixture(t),source=fs.readFileSync(new URL('../../reconcile-xhs-original.mjs',import.meta.url),'utf8');
  const c=vm.createContext({fs,path});
  vm.runInContext(source.slice(source.indexOf('function redactCapture('),source.indexOf('const argv=')),c);
  c.root=root;c.execution={code:1,out:'token URL https://example.test/?token=secret-one&x=1',err:'Authorization: Bearer secret-two'};
  c.observation={platform:'xiaohongshu',phase:'persist',taskSpaceId:135,blocker:{code:'INPUT_CHANNEL_BROKEN',message:'Ego failed after space recovery'}};
  const file=vm.runInContext('saveExecutionCapture(root,"run1","persist",execution,observation,null)',c);
  const saved=JSON.parse(fs.readFileSync(file));assert.equal(saved.observation.taskSpace,undefined);
  assert.equal(saved.observation.blocker.code,'INPUT_CHANNEL_BROKEN');assert.equal(saved.exitCode,1);
  assert.equal(saved.stdout.includes('secret-one'),false);assert.equal(saved.stderr.includes('secret-two'),false);
  assert.equal(fs.statSync(file).mode&0o777,0o600);
});
