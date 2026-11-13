import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { beginVideoReplacement, confirmVideoReplacement } from '../lib/video-replacement-journal.mjs';
import { createWechatServerMediaNormalization, readWechatServerMediaNormalization } from '../platforms/wechat-channels-normalization.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),md5=b=>createHash('md5').update(b).digest('hex');

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vp-wc-normalization-')),approvedPath=path.join(dir,'approved.mp4'),processedPath=path.join(dir,'processed.mp4');
  fs.writeFileSync(approvedPath,Buffer.alloc(1024,7));fs.writeFileSync(processedPath,Buffer.alloc(900,13));
  const approved={path:approvedPath,size:1024,sha256:sha(fs.readFileSync(approvedPath)),durationSeconds:245.933333},processed={path:processedPath,size:900,sha256:sha(fs.readFileSync(processedPath)),md5:md5(fs.readFileSync(processedPath)),width:1280,height:720,durationSeconds:245.933659};
  const journalPath=path.join(dir,'replacement.json'),identity={platform:'wechat_channels',fingerprint:'new-fingerprint'};
  const plan={sourceDraftId:'original-object',sourceTaskSpaceId:76,sourceNativeFileIds:['md5sum:old-source'],sourceVideoSha256:'a'.repeat(64),nextVideoSha256:approved.sha256,
    sourceMetadataHash:'c'.repeat(64),sourceCoverHash:'d'.repeat(64),originalDraftVerified:true,liveSourceDraftId:'original-object',nextVideoPath:approvedPath,nextVideoSize:1024,nextVideoMtimeMs:Math.trunc(fs.statSync(approvedPath).mtimeMs)};
  const intent=beginVideoReplacement(journalPath,identity,plan);
  const journal=confirmVideoReplacement(journalPath,identity,intent.attemptId,{...plan,draftId:'original-object',nativeFileIds:['md5sum:uploaded-uuid'],currentMetadataHash:plan.sourceMetadataHash,currentCoverHash:plan.sourceCoverHash,
    metadataUnchanged:true,coversUnchanged:true,uploadComplete:true,localFile:{path:approvedPath,size:1024,lastModified:plan.nextVideoMtimeMs,sha256:approved.sha256},observedAt:new Date().toISOString()});
  const downloadReceiptPath=path.join(dir,'native-download.json');
  const receipt={observedAt:new Date().toISOString(),objectId:'original-object',media:{url:'https://finder.video.qq.com/251/20302/stodownload',fileSize:'900',mediaType:4,width:1280,height:720,videoPlayLen:245,md5sum:processed.md5,urlCdnTaskId:'native-task',_objectId:'original-object'},
    localPath:processedPath,size:900,sha256:processed.sha256,md5:processed.md5};
  fs.writeFileSync(downloadReceiptPath,JSON.stringify(receipt));
  const windows=Array.from({length:50},(_,i)=>({startSeconds:i*5,endSeconds:Math.min((i+1)*5,245.933333),correlation:.999,rmsDifferenceDb:.01,localOffsetSamples:0}));
  const report={version:1,kind:'wechat-server-media-content-verification-v1',approved,processed,audio:{sampleRate:12000,channels:1,approvedPcmSha256:'e'.repeat(64),processedPcmSha256:'f'.repeat(64),alignmentOffsetSamples:0,coverageFraction:1,durationDifferenceSeconds:.000326,windows,minCorrelation:.999,globalCorrelation:.999,oldNegativeControlCorrelation:.02},visual:{sampleCount:49,maxRgbRmse:2,minLumaCorrelation:.999,allPass:true},passed:true};
  const analysisPath=path.join(dir,'full-content-qc.json');fs.writeFileSync(analysisPath,JSON.stringify(report));
  const args={journalPath,journal,analysisPath,downloadReceiptPath};
  const native={draftId:'original-object',mediaObjectId:'original-object',cdnTaskId:'native-task',nativeFileIds:[`md5sum:${processed.md5}`],nativeSize:900,width:1280,height:720,duration:245,uploadComplete:true,mediaCount:1,fileCount:1};
  return {dir,args,native,report,analysisPath,journalPath,processedPath,create:()=>createWechatServerMediaNormalization(args),read:(n=native)=>readWechatServerMediaNormalization({...args,native:n}),cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}

test('WeChat normalization binds immutable uploaded UUID to actual native MD5 through independently bound full content proof',()=>{
  const f=fixture();try{const original=fs.readFileSync(f.journalPath);const manifest=f.create();assert.equal(f.read().ok,true);assert.deepEqual(manifest.uploadedNativeFileIds,['md5sum:uploaded-uuid']);assert.deepEqual(manifest.normalizedNativeFileIds,f.native.nativeFileIds);assert.equal(manifest.approved.size,1024);assert.equal(manifest.processed.size,900);assert.deepEqual(fs.readFileSync(f.journalPath),original);assert.deepEqual(f.create(),manifest)}finally{f.cleanup()}
});

test('WeChat normalized rendition cannot bypass current objectId, task, MD5, size, dimensions or single-media identity',()=>{
  const f=fixture();try{f.create();for(const changes of [{draftId:'foreign'},{mediaObjectId:'foreign'},{cdnTaskId:'other-task'},{nativeFileIds:['md5sum:other']},{nativeSize:899},{width:1279},{height:719},{duration:240},{uploadComplete:false},{mediaCount:2},{fileCount:2}])assert.equal(f.read({...f.native,...changes}).ok,false,JSON.stringify(changes))}finally{f.cleanup()}
});

test('WeChat normalization is explicit: absent proof, edited QC, changed actual bytes or changed upload journal fail closed',()=>{
  for(const kind of ['absent','qc','processed','journal']){const f=fixture();try{if(kind==='absent'){assert.equal(f.read().ok,false);continue}f.create();if(kind==='qc')fs.appendFileSync(f.analysisPath,' ');if(kind==='processed')fs.appendFileSync(f.processedPath,'x');if(kind==='journal')fs.appendFileSync(f.journalPath,' ');assert.equal(f.read().ok,false,kind)}finally{f.cleanup()}}
});

test('WeChat cannot create normalization from old soundtrack, incomplete windows, drifted audio or wrong visual content',()=>{
  const mutations=[r=>r.audio.oldNegativeControlCorrelation=.99,r=>r.audio.windows[20].startSeconds+=.2,r=>r.audio.windows[20].correlation=.9,
    r=>r.audio.windows[20].rmsDifferenceDb=2,r=>r.audio.windows[20].localOffsetSamples=301,r=>r.audio.coverageFraction=.95,
    r=>r.visual.maxRgbRmse=19,r=>r.visual.minLumaCorrelation=.97,r=>r.approved.sha256='0'.repeat(64),r=>r.processed.sha256='0'.repeat(64)];
  for(const mutate of mutations){const f=fixture();try{mutate(f.report);fs.writeFileSync(f.analysisPath,JSON.stringify(f.report));assert.throws(f.create,/WeChat server normalization/);assert.equal(fs.existsSync(f.journalPath+'.normalization.json'),false)}finally{f.cleanup()}}
});


test('WeChat measured global fractional delay and platform gain can prove content lineage without claiming unchanged loudness',()=>{
  const f=fixture();try{f.report.version=2;f.report.kind='wechat-server-media-content-verification-v2';f.report.audio.alignmentOffsetSamples=315.75;
    f.report.transformation={kind:'single-global-platform-audio-gain-and-delay',version:1,globalDelaySamples:315.75,globalGainLinear:2.55,globalGainDb:20*Math.log10(2.55),windowGainResidualMaxDb:.24,perWindowIndependentGainFit:false,perWindowIndependentTimeStretch:false};
    f.report.visual.undefinedCorrelationFrameCount=1;f.report.visual.uniformSpatialStdMaximum=.5;f.report.visual.constantEquivalentFrames=[{constantEquivalent:true,sourceSpatialStdPerChannel:[0,0,0],processedSpatialStdPerChannel:[.1,.1,.1]}];
    fs.writeFileSync(f.analysisPath,JSON.stringify(f.report));f.create();const proof=f.read();assert.equal(proof.ok,true);assert.equal(proof.evidence.contentLineageOnly,true);assert.equal(proof.evidence.transformation.globalDelaySamples,315.75);
  }finally{f.cleanup()}
});

test('WeChat global transformation proof rejects per-window gain fitting, invented gain and nonconstant frames',()=>{
  for(const kind of ['independentGain','gainMismatch','windowShift','nonconstant']){const f=fixture();try{f.report.version=2;f.report.kind='wechat-server-media-content-verification-v2';f.report.audio.alignmentOffsetSamples=315.75;
    f.report.transformation={kind:'single-global-platform-audio-gain-and-delay',version:1,globalDelaySamples:315.75,globalGainLinear:2.55,globalGainDb:20*Math.log10(2.55),windowGainResidualMaxDb:.24,perWindowIndependentGainFit:false,perWindowIndependentTimeStretch:false};
    if(kind==='independentGain')f.report.transformation.perWindowIndependentGainFit=true;if(kind==='gainMismatch')f.report.transformation.globalGainDb=0;if(kind==='windowShift')f.report.audio.windows[0].localOffsetSamples=1;
    if(kind==='nonconstant'){Object.assign(f.report.visual,{undefinedCorrelationFrameCount:1,uniformSpatialStdMaximum:.5,constantEquivalentFrames:[{constantEquivalent:true,sourceSpatialStdPerChannel:[0,0,0],processedSpatialStdPerChannel:[1,1,1]}]})}
    fs.writeFileSync(f.analysisPath,JSON.stringify(f.report));assert.throws(f.create,/WeChat server normalization/);
  }finally{f.cleanup()}}
});
