#!/usr/bin/env node
// Explicit one-original repair. No upload, title/body/cover mutation or publishing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readPackage } from './lib/content-package.mjs';
import { buildIdentity } from './v2/lib/identity.mjs';
import { acquireJobLock, registerJobLockMember, resolvePublisherLockDirectory } from './v2/lib/job-lock.mjs';
import { JobStore } from './v2/lib/job-store.mjs';
import { readDraftSaveJournal } from './v2/lib/draft-save-journal.mjs';
import { readXhsHumanAuthorization } from './v2/lib/xiaohongshu-reconcile-authorization.mjs';
import { readVideoReplacementSpaceBinding } from './v2/lib/video-replacement-authorization.mjs';
import { parseV2Result } from './v2/lib/result-line.mjs';
import { evaluateObservation, compactVerdict } from './v2/lib/model.mjs';
import { loadXhsParkingContext, rememberXhsParkingSource } from './v2/lib/xiaohongshu-parking-context.mjs';

const DIR=path.dirname(fileURLToPath(import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
function redactCapture(value) {
  return String(value || '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'$1[REDACTED]')
    .replace(/([?&](?:token|access_token|refresh_token|key|signature|sign)=)[^&\s"'<>]+/gi,'$1[REDACTED]')
    .replace(/("(?:token|access_token|refresh_token|client_secret|authorization|password|publisherLockToken)"\s*:\s*")[^"]*(")/gi,'$1[REDACTED]$2')
    .replace(/((?:VIDEO_PUBLISHER_V2_PUBLISHER_LOCK_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)=)[^\s]+/g,'$1[REDACTED]');
}
function saveExecutionCapture(root, runId, phase, execution, observation, parseError) {
  const directory=path.join(root,'attempts',runId);fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,`${phase}-execution.json`);
  const body=JSON.stringify({version:1,kind:'actual-child-execution-diagnostic',capturedAt:new Date().toISOString(),
    exitCode:execution.code,stdout:redactCapture(execution.out),stderr:redactCapture(execution.err),
    observation:observation?JSON.parse(redactCapture(JSON.stringify(observation))):null,
    parseError:parseError?redactCapture(parseError.message||parseError):null},null,2)+'\n';
  const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const dir=fs.openSync(directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  return file;
}
const argv=process.argv.slice(2), flags={};
for(let i=0;i<argv.length;i+=2){
  if(!['--package','--job-id','--authorization','--state-root'].includes(argv[i])||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('Usage: reconcile-xhs-original.mjs --package <original.json> --job-id <existing> --authorization <human-v2.json> [--state-root <dir>]');
  flags[argv[i]]=argv[i+1];
}
if(!flags['--package']||!flags['--job-id']||!flags['--authorization']||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(flags['--job-id']))throw new Error('Original package, existing job and authorization are required');
const packagePath=path.resolve(flags['--package']),jobId=flags['--job-id'];
const jobDir=path.join(path.resolve(flags['--state-root']||path.join(os.homedir(),'.video-publisher/v2-jobs')),jobId);
if(!fs.existsSync(path.join(jobDir,'state.json')))throw new Error('Reconciliation cannot create a job');
const releasePublisher=acquireJobLock(resolvePublisherLockDirectory(),{jobId,packagePath,scope:'publisher'});
let releaseJob=()=>{},store;
try{
  releaseJob=acquireJobLock(jobDir,{jobId,packagePath});
  const existing=JSON.parse(fs.readFileSync(path.join(jobDir,'state.json')));
  const pkg=readPackage(packagePath),identity=await buildIdentity(pkg);
  if(![identity.fingerprint,identity.previousFingerprint,identity.legacyFingerprint].includes(existing.fingerprint)
    || existing.video?.sha256!==identity.video.sha256 || path.resolve(existing.platformPackagePaths?.xiaohongshu||existing.packagePath)!==packagePath
    || existing.videoRevision || existing.videoRevisionIntent || existing.coverRevisionIntent || existing.tagRevisionIntent)throw new Error('Use only the unchanged original package before any media revision');
  store=new JobStore(jobDir,{fingerprint:existing.fingerprint});
  const state=await store.initialize(),item=state.platforms.xiaohongshu;
  if(!item?.taskSpaceName||!Number.isSafeInteger(item.taskSpaceId)||item.verdict?.blocker?.code==='ALREADY_PUBLISHED')throw new Error('No original XHS resource or resource is already published');
  const journalPath=`${store.receiptCheckpointPath('xiaohongshu')}.draft-save.json`;
  const journal=readDraftSaveJournal(journalPath,{platform:'xiaohongshu',fingerprint:state.fingerprint});
  if(journal?.status!=='confirmed'||!journal.plan.uid||!journal.plan.videoFileId)throw new Error('Reconcile only an original confirmed journal, never an uncertain save intent');
  const raw=JSON.parse(fs.readFileSync(flags['--authorization']));
  const recovered=journal.plan.recoveryEvidence;
  const originalSpace=recovered?.originalSourceTaskSpaceId||raw.sourceTaskSpaceId;
  const auth=readXhsHumanAuthorization(flags['--authorization'],{jobId,sourceFingerprint:state.fingerprint,
    sourceTaskSpaceId:originalSpace,sourceTaskSpaceName:item.taskSpaceName,uid:journal.plan.uid,
    sourceDraftId:String(journal.plan.id),sourceVideoFileId:journal.plan.videoFileId,nextVideoSha256:raw.nextVideoSha256});
  const root=path.join(jobDir,'reconciliations',auth.manifestSha256);
  const archive=path.join(root,'original-draft-save.json');
  const journalHash=hash(fs.readFileSync(journalPath));
  if(journalHash!==auth.sourceJournalSha256&&(!recovered||recovered.authorizationManifestSha256!==auth.manifestSha256
    || !fs.existsSync(archive)||hash(fs.readFileSync(archive))!==auth.sourceJournalSha256))throw new Error('Original journal changed without this archived same-resource reconciliation');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const context={platform:'xiaohongshu',jobId,sourceFingerprint:state.fingerprint,
    sourceDraftId:String(journal.plan.id),sourceUid:journal.plan.uid,sourceVideoFileId:journal.plan.videoFileId,
    sourceTaskSpaceId:item.taskSpaceId,originalSourceTaskSpaceId:originalSpace,sourceTaskSpaceName:item.taskSpaceName,
    originalJournalSha256:auth.sourceJournalSha256,originalJournalArchivePath:archive,
    recoveryEvidencePath:path.join(root,'native-revalidation.json'),userAuthorization:auth,
    nextVideoIdentity:{sha256:auth.nextVideoSha256},spaceBindingPath:path.join(root,'space-binding.json')};
  const recoveredBinding=readVideoReplacementSpaceBinding(context.spaceBindingPath,context);
  if(item.taskSpaceId!==originalSpace&&recovered?.authorizationManifestSha256!==auth.manifestSha256
    && !(recoveredBinding?.status==='confirmed'&&recoveredBinding.previousTaskSpaceId===originalSpace
      && recoveredBinding.taskSpaceId===item.taskSpaceId&&recoveredBinding.taskSpaceName===item.taskSpaceName))throw new Error('Original task-space binding changed before authorized recovery');
  if(recoveredBinding?.status==='confirmed') {
    context.sourceTaskSpaceId=recoveredBinding.taskSpaceId;
    context.sourceTaskSpaceRecovery=recoveredBinding;
  }
  const runId=randomUUID();let parkingContext=null;
  for(const phase of ['persist','verify','park']){
    const args=[path.join(DIR,'v2/run-platform.mjs'),'xiaohongshu',packagePath,phase,state.taskSuffix||'original-reconcile',String(context.sourceTaskSpaceId)];
    const env={...process.env,VIDEO_PUBLISHER_V2_OPERATION:'reconcile-xhs-original',VIDEO_PUBLISHER_V2_NO_UPLOAD:'1',
      VIDEO_PUBLISHER_V2_XHS_RECONCILE:JSON.stringify(context),VIDEO_PUBLISHER_V2_FINGERPRINT:state.fingerprint,
      VIDEO_PUBLISHER_V2_TASK_NAME:item.taskSpaceName,VIDEO_PUBLISHER_V2_VERIFICATION_RUN_ID:runId,
      VIDEO_PUBLISHER_V2_CHECKPOINT_PATH:store.receiptCheckpointPath('xiaohongshu'),
      VIDEO_PUBLISHER_V2_DRAFT_SAVE_JOURNAL_PATH:journalPath,VIDEO_PUBLISHER_V2_RECEIPTS:JSON.stringify(item.receipts||{}),
      VIDEO_PUBLISHER_V2_VIDEO_RECEIPT:JSON.stringify(item.videoReceipt||null),
      VIDEO_PUBLISHER_V2_VIDEO_REVISION:'null',VIDEO_PUBLISHER_V2_TAG_REVISION:'null',VIDEO_PUBLISHER_V2_COVER_REVISION:'null',
      VIDEO_PUBLISHER_V2_XHS_PARKING_CONTEXT:JSON.stringify(parkingContext),
      VIDEO_PUBLISHER_V2_PUBLISHER_LOCK_TOKEN:releasePublisher.token};
    const execution=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,args,{env,stdio:['ignore','pipe','pipe']});let out='',err='';
      const unregister=registerJobLockMember(resolvePublisherLockDirectory(),releasePublisher.token,{pid:child.pid,role:`reconcile-xhs:${phase}`});
      child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
      child.on('error',error=>{unregister();reject(error);});child.on('close',code=>{unregister();resolve({code,out,err});});
    });
    let observation,parseError;
    try{observation=parseV2Result(`${execution.out}\n${execution.err}`);}catch(error){parseError=error;}
    const capturePath=saveExecutionCapture(root,runId,phase,execution,observation,parseError);
    if(parseError)throw new Error(`Reconciliation child returned no valid observation; inspect ${capturePath}`);
    // run-platform's failure envelope intentionally has no native taskSpace name.
    // Preserve its real blocker rather than confusing it with an identity mismatch.
    if(observation.blocker&&typeof observation.taskSpace!=='string')throw new Error(
      `Reconciliation ${phase} blocked: ${observation.blocker.code}: ${redactCapture(observation.blocker.message)}; inspect ${capturePath}`);
    const currentBinding=readVideoReplacementSpaceBinding(context.spaceBindingPath,context);
    const expectedSpaceId=currentBinding?.status==='confirmed'?currentBinding.taskSpaceId:context.sourceTaskSpaceId;
    if(observation.taskSpace!==item.taskSpaceName||!Number.isSafeInteger(observation.taskSpaceId)
      || observation.taskSpaceId!==expectedSpaceId)throw new Error(`Reconciliation lost original task-space identity; inspect ${capturePath}`);
    item.taskSpaceId=observation.taskSpaceId;context.sourceTaskSpaceId=item.taskSpaceId;
    if(observation.receipts)item.receipts={...(item.receipts||{}),...observation.receipts};
    item.receiptTaskSpaceId=item.taskSpaceId;
    const verdict=evaluateObservation(observation,{verificationRunId:runId,fingerprint:state.fingerprint,taskSpaceId:item.taskSpaceId});
    item.status=verdict.ready?'ready':'blocked';
    await store.record('xiaohongshu',phase,observation,compactVerdict(verdict));
    console.error(`[xhs-original-reconcile] ${phase}: ${verdict.ready?'READY':observation.blocker?.code||verdict.missing.join(',')}`);
    if(observation.blocker||!verdict.ready)throw new Error(`Reconciliation ${phase} failed; inspect ${item.lastEvidencePath}`);
    if(phase==='verify'){
      parkingContext=loadXhsParkingContext({evidencePath:item.lastEvidencePath,fingerprint:state.fingerprint,taskSpaceId:item.taskSpaceId,verificationRunId:runId});
      rememberXhsParkingSource(item,parkingContext,state.fingerprint,item.taskSpaceId);await store.save();
    }
  }
  state.keepSpace=true;state.status=Object.values(state.platforms).every(p=>p.verdict?.ready)?'ready':'blocked';
  state.revisions||=[];state.revisions.push({at:new Date().toISOString(),operation:'reconcile-xhs-original',
    authorizationPath:auth.manifestPath,authorizationSha256:auth.manifestSha256,sourceDraftId:context.sourceDraftId,
    originalJournalArchivePath:archive,originalSourceTaskSpaceId:originalSpace,taskSpaceId:item.taskSpaceId});
  await store.save();console.log(JSON.stringify({ready:true,jobId,draftId:context.sourceDraftId,taskSpaceId:item.taskSpaceId,
    evidencePath:item.lastEvidencePath,originalJournalArchivePath:fs.existsSync(archive)?archive:null},null,2));
}finally{if(store)await store.close();releaseJob();releasePublisher();}
