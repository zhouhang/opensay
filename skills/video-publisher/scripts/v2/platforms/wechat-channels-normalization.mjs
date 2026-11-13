import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=message=>{throw new Error(`WeChat server normalization ${message}`)};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const fileIdentity=file=>{const bytes=fs.readFileSync(file);return {path:path.resolve(file),size:bytes.length,sha256:hashBytes(bytes),md5:createHash('md5').update(bytes).digest('hex')}};

function validateAnalysis(report,journal,processed){
  const transformed=report?.version===2&&report.kind==='wechat-server-media-content-verification-v2';
  if((!transformed&&(report?.version!==1||report.kind!=='wechat-server-media-content-verification-v1'))||report.passed!==true
    ||report.approved?.path!==journal.plan.nextVideoPath||report.approved.sha256!==journal.plan.nextVideoSha256
    ||report.approved.size!==journal.plan.nextVideoSize||report.processed?.path!==processed.path
    ||report.processed.sha256!==processed.sha256||report.processed.md5!==processed.md5||report.processed.size!==processed.size)
    fail('content analysis does not bind the actual approved and processed files');
  const a=report.audio;
  if(!a||a.sampleRate!==12000||a.channels!==1||!digest(a.approvedPcmSha256)||!digest(a.processedPcmSha256)
    ||!(transformed?Number.isFinite(a.alignmentOffsetSamples):Number.isInteger(a.alignmentOffsetSamples))||Math.abs(a.alignmentOffsetSamples)>a.sampleRate*.5
    ||!(a.coverageFraction>=.999)||!(Math.abs(a.durationDifferenceSeconds)<=.1)
    ||!(a.globalCorrelation>=.98)||!(a.minCorrelation>=.95)
    ||!Number.isFinite(a.oldNegativeControlCorrelation)||!(a.globalCorrelation-a.oldNegativeControlCorrelation>=.15)
    ||!Array.isArray(a.windows)||a.windows.length<49)fail('full audio comparison or old-mix negative control is incomplete');
  if(transformed){
    const t=report.transformation;
    if(t?.kind!=='single-global-platform-audio-gain-and-delay'||t.version!==1||t.perWindowIndependentGainFit!==false||t.perWindowIndependentTimeStretch!==false||!Number.isFinite(t.globalDelaySamples)
      ||Math.abs(t.globalDelaySamples-a.alignmentOffsetSamples)>1e-9||!(t.globalGainLinear>0)||!Number.isFinite(t.globalGainDb)
      ||Math.abs(t.globalGainDb-20*Math.log10(t.globalGainLinear))>1e-5
      ||!(t.windowGainResidualMaxDb<=1)||!Number.isFinite(t.windowGainResidualMaxDb))
      fail('requires one explicit measured global delay and global linear gain, without per-window fitting');
  }
  let end=0;
  for(const w of a.windows){
    if(!Number.isFinite(w.startSeconds)||!Number.isFinite(w.endSeconds)||Math.abs(w.startSeconds-end)>.02
      ||!(w.endSeconds>w.startSeconds)||w.endSeconds-w.startSeconds>5.02
      ||!(w.correlation>=.95)||!Number.isFinite(w.rmsDifferenceDb)||Math.abs(w.rmsDifferenceDb)>1
      ||!Number.isInteger(w.localOffsetSamples)||(transformed?w.localOffsetSamples!==0:Math.abs(w.localOffsetSamples)>a.sampleRate*.025))fail('audio windows have gaps or do not match the approved soundtrack');
    end=w.endSeconds;
  }
  if(!(end>=Math.min(report.approved.durationSeconds,report.processed.durationSeconds)-.1)
    ||!(report.approved.durationSeconds>240)||!(report.processed.durationSeconds>240))fail('audio analysis does not cover the full video');
  const v=report.visual;
  if(!v||v.sampleCount<49||v.allPass!==true||!(v.maxRgbRmse<=18)||!(v.minLumaCorrelation>=.98))fail('stratified full-video visual verification failed');
  if(transformed&&v.undefinedCorrelationFrameCount){
    if(!Number.isInteger(v.undefinedCorrelationFrameCount)||!Array.isArray(v.constantEquivalentFrames)
      ||v.constantEquivalentFrames.length!==v.undefinedCorrelationFrameCount||v.uniformSpatialStdMaximum!==.5
      ||!v.constantEquivalentFrames.every(frame=>frame.constantEquivalent===true
        &&Array.isArray(frame.sourceSpatialStdPerChannel)&&frame.sourceSpatialStdPerChannel.length===3
        &&Array.isArray(frame.processedSpatialStdPerChannel)&&frame.processedSpatialStdPerChannel.length===3
        &&[...frame.sourceSpatialStdPerChannel,...frame.processedSpatialStdPerChannel].every(value=>Number.isFinite(value)&&value<=.5)))
      fail('undefined visual correlation requires explicitly measured equivalent constant frames');
  }
  return report;
}

function validateInputs({journalPath,journal,analysisPath,downloadReceiptPath}){
  if(journal?.status!=='confirmed'||journal.platform!=='wechat_channels'||!journal.evidence?.nativeFileIds?.length)fail('requires an immutable confirmed original upload');
  const actualJournal=read(journalPath);
  if(!same(actualJournal,journal))fail('confirmed injection journal changed');
  const receipt=read(downloadReceiptPath),processed=fileIdentity(receipt.localPath),approved=fileIdentity(journal.plan.nextVideoPath);
  const media=receipt.media;
  if(receipt.objectId!==journal.plan.sourceDraftId||media?._objectId!==journal.plan.sourceDraftId
    ||processed.path!==receipt.localPath||processed.size!==receipt.size||processed.size!==Number(media.fileSize)
    ||processed.sha256!==receipt.sha256||processed.md5!==receipt.md5||processed.md5!==media.md5sum
    ||!media.urlCdnTaskId||!/^https:\/\/finder\.video\.qq\.com\//.test(media.url||'')
    ||Date.parse(receipt.observedAt)<Date.parse(journal.confirmedAt))fail('download receipt does not prove the current original-draft server media');
  if(approved.path!==journal.plan.nextVideoPath||approved.size!==journal.plan.nextVideoSize||approved.sha256!==journal.plan.nextVideoSha256)
    fail('approved upload source bytes changed');
  const report=validateAnalysis(read(analysisPath),journal,processed);
  if(report.processed.width!==Number(media.width)||report.processed.height!==Number(media.height)
    ||Math.abs(report.processed.durationSeconds-Number(media.videoPlayLen))>1.1)fail('decoded server video does not match native dimensions and duration');
  return {receipt,processed,approved,report};
}

export function createWechatServerMediaNormalization({journalPath,journal,analysisPath,downloadReceiptPath,manifestPath=`${journalPath}.normalization.json`}){
  const {receipt,processed,approved}=validateInputs({journalPath,journal,analysisPath,downloadReceiptPath});
  const value={version:1,kind:'wechat-server-media-normalization-v1',platform:'wechat_channels',fingerprint:journal.fingerprint,
    sourceDraftId:journal.plan.sourceDraftId,sourceTaskSpaceId:journal.plan.sourceTaskSpaceId,
    replacementJournalPath:journalPath,replacementJournalSha256:hashBytes(fs.readFileSync(journalPath)),
    uploadedNativeFileIds:journal.evidence.nativeFileIds,normalizedNativeFileIds:[`md5sum:${processed.md5}`],
    approved,processed,nativeCdnTaskId:String(receipt.media.urlCdnTaskId),
    downloadReceipt:{path:downloadReceiptPath,sha256:hashBytes(fs.readFileSync(downloadReceiptPath))},
    analysis:{path:analysisPath,sha256:hashBytes(fs.readFileSync(analysisPath))},observedAt:new Date().toISOString()};
  if(fs.existsSync(manifestPath)){
    const existing=read(manifestPath),{observedAt:a,...prior}=existing,{observedAt:b,...next}=value;
    if(!same(prior,next))fail('manifest already exists with a different lineage; overwrite prohibited');
    return existing;
  }
  fs.mkdirSync(path.dirname(manifestPath),{recursive:true,mode:0o700});
  const temporary=`${manifestPath}.${randomUUID()}.tmp`;let fd;
  try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.linkSync(temporary,manifestPath);const dir=fs.openSync(path.dirname(manifestPath),'r');try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}
  }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary)}
  return value;
}

export function readWechatServerMediaNormalization({journalPath,journal,native,manifestPath=`${journalPath}.normalization.json`}){
  if(!fs.existsSync(manifestPath))return {ok:false,reason:'explicit server-normalization lineage proof missing'};
  try{
    const m=read(manifestPath);
    if(m?.version!==1||m.kind!=='wechat-server-media-normalization-v1'||m.platform!=='wechat_channels'||m.fingerprint!==journal.fingerprint
      ||m.sourceDraftId!==journal.plan.sourceDraftId||m.sourceTaskSpaceId!==journal.plan.sourceTaskSpaceId||m.replacementJournalPath!==journalPath
      ||m.replacementJournalSha256!==hashBytes(fs.readFileSync(journalPath))||!same(m.uploadedNativeFileIds,journal.evidence.nativeFileIds)
      ||m.downloadReceipt?.sha256!==hashBytes(fs.readFileSync(m.downloadReceipt.path))||m.analysis?.sha256!==hashBytes(fs.readFileSync(m.analysis.path)))fail('manifest or immutable proof artifact changed');
    const {processed,approved,report,receipt}=validateInputs({journalPath,journal,analysisPath:m.analysis.path,downloadReceiptPath:m.downloadReceipt.path});
    if(!same(processed,m.processed)||!same(approved,m.approved)||!same(m.normalizedNativeFileIds,[`md5sum:${processed.md5}`])
      ||!same(native.nativeFileIds,m.normalizedNativeFileIds)||native.draftId!==m.sourceDraftId||native.mediaObjectId!==m.sourceDraftId
      ||String(native.cdnTaskId)!==m.nativeCdnTaskId||String(receipt.media.urlCdnTaskId)!==m.nativeCdnTaskId
      ||native.nativeSize!==processed.size||native.width!==report.processed.width||native.height!==report.processed.height
      ||Math.abs(native.duration-report.processed.durationSeconds)>1.1||native.uploadComplete!==true||native.mediaCount!==1||native.fileCount!==1)
      fail('fresh original native resource no longer matches the proven processed rendition');
    return {ok:true,evidence:{version:1,method:'official-native-download-full-content-comparison',manifestPath,manifestSha256:hashBytes(fs.readFileSync(manifestPath)),
      replacementJournalSha256:m.replacementJournalSha256,uploadedNativeFileIds:m.uploadedNativeFileIds,normalizedNativeFileIds:m.normalizedNativeFileIds,
      nativeCdnTaskId:m.nativeCdnTaskId,approvedVideoSha256:approved.sha256,nativeVideoSha256:processed.sha256,nativeVideoMd5:processed.md5,nativeVideoSize:processed.size,
      analysisSha256:m.analysis.sha256,downloadReceiptSha256:m.downloadReceipt.sha256,
      ...(report.version===2?{transformation:report.transformation,contentLineageOnly:true}:{}),readAt:new Date().toISOString()}};
  }catch(error){return {ok:false,reason:String(error.message||error)}}
}
