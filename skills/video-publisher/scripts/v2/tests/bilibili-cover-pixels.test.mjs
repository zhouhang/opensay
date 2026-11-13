import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';

const source=fs.readFileSync(new URL('../platforms/bilibili.mjs',import.meta.url),'utf8');
const prefix=source.slice(0,source.indexOf('async function inspectBilibili'));
const inspection=source.slice(0,source.indexOf('async function resumeBilibiliLocalDraftIfPresent'));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const nativeUrl='https://archive.biliimg.com/bfs/archive/accepted.jpg';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

function pattern(change=0){
  const rgba=new Uint8ClampedArray(64*48*4);
  for(let y=0;y<48;y++)for(let x=0;x<64;x++){
    const n=(y*64+x)*4;
    rgba[n]=Math.min(255,20+(x*7+y*3)%200+change);
    rgba[n+1]=Math.min(255,25+(x*3+y*11)%195+change);
    rgba[n+2]=Math.min(255,30+(x*13+y*5)%190+change);rgba[n+3]=255;
  }
  return rgba;
}
function uniform(r=13,g=7,b=7){const rgba=new Uint8ClampedArray(64*48*4);for(let n=0;n<rgba.length;n+=4)rgba.set([r,g,b,255],n);return rgba;}
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bili-cover-pixels-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const assetPath=path.join(root,'approved.png'),bytes=Buffer.alloc(33);
  bytes.set([137,80,78,71,13,10,26,10]);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(1792,16);bytes.writeUInt32BE(1344,20);
  fs.writeFileSync(assetPath,bytes);
  const pkg={platformTitle:{bilibili:'Approved'},bilibiliDescription:'Body',bilibiliTags:[],bilibiliAllowedAutoTags:[],cover:{uploadCustomCover:true,horizontal4x3Path:assetPath}};
  const run=(tail,extra={},body=prefix)=>{
    const values={pkg,videoPath:'/approved.mp4',fs,createHash,...extra};
    return new AsyncFunction(...Object.keys(values),`${body}\n${tail}`)(...Object.values(values));
  };
  return {root,assetPath,bytes,pkg,run,asset:()=>run('return readBilibiliCoverAsset();')};
}
function pixelBrowser({sourcePixels=pattern(),nativePixels=pattern(),nativeWidth=960,nativeHeight=720,broken=false,tainted=false,editorPaint=[]}={}){
  const images=[];
  class Image{
    constructor(){this.crossOrigin='';this.complete=true;images.push(this);}
    set src(value){this._src=value;this.naturalWidth=value.startsWith('data:')?1792:nativeWidth;this.naturalHeight=value.startsWith('data:')?1344:nativeHeight;this.pixels=value.startsWith('data:')?sourcePixels:nativePixels;
      queueMicrotask(()=>broken&&!value.startsWith('data:')?this.onerror?.():this.onload?.());}
    get src(){return this._src;}
  }
  const document={createElement:()=>({width:0,height:0,getContext:()=>{
    let painted;
    return {fillRect(){},drawImage(image){painted=image.pixels;},getImageData(){if(tainted)throw new Error('SecurityError: tainted canvas');return {data:painted};}};
  }}),querySelectorAll:selector=>selector==='#editor'?[{parentElement:null,getBoundingClientRect:()=>({width:840,height:472}),
    querySelectorAll:query=>query==='canvas.lower-canvas[data-fabric="main"]'?editorPaint.map(pixels=>({tagName:'CANVAS',width:840,height:472,pixels,parentElement:null,getBoundingClientRect:()=>({width:840,height:472})})):[]}]:[]};
  return {images,js:expression=>vm.runInNewContext(expression,{document,Image,crypto:webcrypto,setTimeout,clearTimeout,Uint8Array,queueMicrotask,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})})};
}
async function compare(f,browser,target={url:nativeUrl}){
  return f.run('const asset=readBilibiliCoverAsset();return compareBilibiliCoverPixels(asset,target);',{js:browser.js,target});
}

test('Bili native JPEG can differ slightly from source while preserving the exact source binding',async t=>{
  const f=fixture(t),browser=pixelBrowser({nativePixels:pattern(2)}),result=await compare(f,browser);
  assert.equal(result.ok,true);assert.ok(result.comparisonMetrics.rmse>0&&result.comparisonMetrics.rmse<3);
  assert.ok(result.comparisonMetrics.correlation>.99);
  assert.match(result.sourcePixelSha256,/^[a-f0-9]{64}$/);assert.match(result.nativePixelSha256,/^[a-f0-9]{64}$/);
  assert.notEqual(result.sourcePixelSha256,result.nativePixelSha256);
  assert.ok(browser.images.every(image=>image.crossOrigin==='anonymous'));
  assert.deepEqual(fs.readFileSync(f.assetPath),f.bytes);
});

test('the observed uniform near-black server image cannot pass even with a valid CDN URL',async t=>{
  const f=fixture(t),result=await compare(f,pixelBrowser({nativePixels:uniform()}));
  assert.equal(result.ok,false);assert.ok(result.candidates[0].comparisonMetrics.nativeStd<1e-9);
});

test('wrong, changed, unreadable, tainted and wrong-ratio native images fail closed',async t=>{
  const wrong=pattern();for(let n=0;n<wrong.length;n+=4){const r=wrong[n];wrong[n]=wrong[n+2];wrong[n+2]=r;}
  for(const options of [{nativePixels:wrong},{nativePixels:pattern(30)},{broken:true},{tainted:true},{nativeWidth:1280,nativeHeight:720}]){
    const f=fixture(t);assert.equal((await compare(f,pixelBrowser(options))).ok,false,JSON.stringify(Object.keys(options)));
  }
});

test('native editor validates only main paint canvases, allowing their actual 16:9 working canvas',async t=>{
  const f=fixture(t),before=await compare(f,pixelBrowser({editorPaint:[uniform()]}),{editorSelector:'#editor'});
  assert.equal(before.ok,false);assert.ok(before.candidates[0].comparisonMetrics.nativeStd<1e-9);
  const after=await compare(f,pixelBrowser({editorPaint:[pattern()]}),{editorSelector:'#editor'});
  assert.equal(after.ok,true);assert.notEqual(after.key,before.candidates[0].key);
  assert.equal(after.comparisonMetrics.nativeWidth,840);assert.equal(after.comparisonMetrics.nativeHeight,472);
  assert.equal((await compare(f,pixelBrowser({editorPaint:[]}),{editorSelector:'#editor'})).ok,false);
});

function receipt(asset,comparison){return {version:2,assetPath:asset.assetPath,assetHash:asset.assetHash,ratio:'4:3',afterUrl:nativeUrl,
  verification:'source-native-pixels-v1',sourcePixelSha256:comparison.sourcePixelSha256,nativePixelSha256:comparison.nativePixelSha256,
  comparisonMetrics:comparison.comparisonMetrics,sourcePreview:{fresh:true,assetHash:asset.assetHash,sourcePixelSha256:comparison.sourcePixelSha256}};}

test('receipt acceptance rebinds source hash, fresh preview, current native digests and measured metrics',async t=>{
  const f=fixture(t),asset=await f.asset(),comparison=await compare(f,pixelBrowser()),approved=receipt(asset,comparison);
  const match=(value=approved,current=comparison)=>f.run('return bilibiliCoverReceiptMatches(receipt,[nativeUrl],asset,comparison);',{receipt:value,nativeUrl,asset,comparison:current});
  assert.equal(await match(),true);
  for(const changed of [{assetHash:undefined},{assetHash:'f'.repeat(64)},{nativePixelSha256:'f'.repeat(64)},
    {sourcePixelSha256:'f'.repeat(64)},{sourcePreview:{...approved.sourcePreview,fresh:false}},
    {comparisonMetrics:{...comparison.comparisonMetrics,rmse:0.1}},{verification:undefined}]){
    assert.equal(await match({...approved,...changed}),false);
  }
  assert.equal(await match(approved,{...comparison,ok:false}),false);
  const legacy={version:2,assetPath:asset.assetPath,ratio:'4:3',afterUrl:nativeUrl,deduplicated:true};
  assert.equal(await match(legacy),false,'a historical CDN URL alone is no longer accepted');
});

async function inspect(f,coverReceipt,comparison,{changeSource=false}={}){
  const state={text:'上传完成',title:'Approved',desc:'Body',chips:[],missing:[],duplicates:[],malformed:[],unexpected:[],
    creationInput:'内容无需标注 内容为自制',noMark:true,selfMade:true,uploaded:true,anyUploaded:true,filenameVisible:true,
    identityMatches:true,coverUrls:[nativeUrl],dialogs:[]};
  return f.run(`compareBilibiliCoverPixels=async()=>{if(changeSource)fs.appendFileSync(bilibiliCoverPath,'changed');return suppliedComparison};return inspectBilibili();`,{
    js:async()=>state,readBiliRestoredIdentity:async()=>({ok:true,existingDraft:true}),readBilibiliVideoRevisionNative:async()=>({}),inspectFinalButtons:async()=>[{buttonish:true,disabled:false}],
    expectedReceipts:{cover:coverReceipt},PLATFORM_URLS:{bilibili:'https://member.bilibili.com/'},
    okGate:evidence=>({ok:true,evidence}),failedGate:evidence=>({ok:false,evidence}),compactText:value=>value,
    suppliedComparison:comparison,changeSource},inspection);
}

test('real inspect gate blocks legacy and black image receipts even though the page retains their URL',async t=>{
  const f=fixture(t),asset=await f.asset(),good=await compare(f,pixelBrowser()),approved=receipt(asset,good);
  assert.equal((await inspect(f,approved,good)).gates.cover.ok,true);
  const black=await compare(f,pixelBrowser({nativePixels:uniform()}));
  assert.equal((await inspect(f,approved,black)).gates.cover.ok,false);
  assert.equal((await inspect(f,{version:2,assetPath:asset.assetPath,ratio:'4:3',afterUrl:nativeUrl},good)).gates.cover.ok,false);
  assert.equal((await inspect(f,approved,good,{changeSource:true})).gates.cover.ok,false);
});

async function upload(f,{fresh=true,nativeOk=true,sameUrl=false,changeSource=false}={}){
  const asset=await f.asset(),calls=[];let injected=false,confirmed=false;
  const comparison={ok:true,sourcePixelSha256:'a'.repeat(64),nativePixelSha256:'b'.repeat(64),comparisonMetrics:{sampleWidth:64,sampleHeight:48,pixelMode:'RGB',rmse:1,correlation:.999,nativeStd:40,sourceStd:40}};
  const result=await f.run(`
    inspectBilibili=inspectStub;prepareBilibiliCoverEntry=async()=>({ok:true,selector:'#main'});
    exposeBilibiliCoverImageInput=async()=>({ok:true,selector:'#editor input',editorSelector:'#editor'});
    compareBilibiliCoverPixels=comparisonStub;
    return uploadBilibiliCoverV2();`,{
    inspectStub:async()=>({gates:{cover:{evidence:{urls:confirmed||sameUrl?[nativeUrl]:['https://archive.biliimg.com/old.jpg']}},noBlockingDialog:{ok:confirmed||!injected}}}),
    comparisonStub:async(_asset,target)=>target.editorSelector?{sourcePixelSha256:comparison.sourcePixelSha256,
      candidates:[{...comparison,ok:injected,key:injected&&fresh?'fresh-paint':'old-paint',identity:'native-main-canvas:0'}]}:{...comparison,ok:nativeOk},
    uploadFile:async(selector,uploadPath)=>{calls.push({action:'upload',selector,path:uploadPath});injected=true;if(changeSource)fs.appendFileSync(f.assetPath,'changed');},
    click:async selector=>{calls.push({action:'click',selector});if(selector==='#complete')confirmed=true;},
    js:async()=>({selector:'#complete',text:'完成'}),wait:async()=>{},
  },source);
  return {result,calls,asset};
}

test('upload requires newly painted source before Complete and final source-matching CDN pixels',async t=>{
  const f=fixture(t),{result,calls,asset}=await upload(f);
  assert.equal(result.ok,true);assert.equal(result.receipt.assetHash,asset.assetHash);
  assert.equal(result.receipt.verification,'source-native-pixels-v1');assert.equal(result.receipt.sourcePreview.fresh,true);
  assert.deepEqual(calls.map(call=>call.action+':'+(call.selector||'')),['click:#main','upload:#editor input','click:#complete']);
  const same=await upload(f,{sameUrl:true});assert.equal(same.result.ok,true);assert.equal(same.result.receipt.deduplicated,true);
  assert.ok(same.result.receipt.nativePixelSha256,'same URL is allowed only with fresh painted action and verified native pixels');
});

test('stale source paint, changed source and black export can never mint an accepted receipt',async t=>{
  for(const options of [{fresh:false},{changeSource:true},{nativeOk:false}]){
    const f=fixture(t),{result,calls}=await upload(f,options);
    assert.equal(result.ok,false);assert.equal(result.receipt,undefined);
    if(options.fresh===false||options.changeSource)assert.equal(calls.some(call=>call.selector==='#complete'),false);
  }
});

async function originalCoverReadback(t,options={}){
  const f=fixture(t),asset=await f.asset(),previousComparison=await compare(f,pixelBrowser());
  const previous={...receipt(asset,previousComparison),afterUrl:'https://archive.biliimg.com/bfs/archive/unsaved-new-export.jpg'};
  const expected={cover:previous},checkpoints=[],browser=pixelBrowser(options.pixels);
  const native={draftId:'123',existingDraft:true,published:false,partCount:1,uploadComplete:true,nativeFileIds:['filename:original']};
  const revision={sourceDraftId:'123',sourceTaskSpaceId:42,sourceFingerprint:'old-fingerprint',sourceReceipts:{cover:structuredClone(previous)}};
  const required=['authenticated','draftIdentity','video','title','description','tags','aiGenerated','original','noBlockingDialog','finalButton'];
  const observation={gates:Object.fromEntries(required.map(name=>[name,{ok:true,evidence:{}}]))};
  observation.gates.draftIdentity.evidence={restoredIdentity:{ok:true,actualId:'123'}};
  observation.gates.cover={ok:false,evidence:{urls:[nativeUrl]}};
  const after=structuredClone(observation),afterNative=structuredClone(native);
  const context={native,revision,observation,after,afterNative,previous,asset,f,browser};
  options.change?.(context);
  const beforeBytes=Buffer.from(fs.readFileSync(f.assetPath));
  const result=await f.run(`
    inspectBilibili=async()=>after;
    readBilibiliVideoRevisionNative=async()=>afterNative;
    return readbackBilibiliOriginalDraftCover(observation,native,revision);
  `,{
    observation,native,revision,after,afterNative,phase:options.phase||'replace_video',
    activeTaskSpace:{id:42},expectedReceipts:expected,
    js:async expression=>{const result=await browser.js(expression);if(options.changeAsset)fs.appendFileSync(f.assetPath,'changed');return result;},
    inspectFinalPublishGuard:async()=>options.guard||({armed:true,blockedAttempts:0}),
    checkpointReceipts:value=>{checkpoints.push(value);return {ok:options.checkpointFails!==true,path:'/revision-cover-checkpoint.json'};},
  },source);
  return {result,checkpoints,expected,previous,beforeBytes,...context};
}

test('original-draft cover readback verifies a different native JPEG without uploading or rewriting the old receipt',async t=>{
  const row=await originalCoverReadback(t,{pixels:{nativePixels:pattern(2)}}),r=row.result;
  assert.equal(r.ok,true);assert.equal(row.checkpoints.length,1);assert.equal(r.receipt.afterUrl,nativeUrl);
  assert.equal(r.receipt.nativeReadback.kind,'same-original-draft-approved-cover-readback');
  assert.equal(r.receipt.nativeReadback.sourceDraftId,'123');assert.equal(r.receipt.nativeReadback.taskSpaceId,42);
  assert.equal(r.receipt.nativeReadback.uploadedDuringReadback,false);
  assert.equal(r.receipt.nativeReadback.priorReceiptSha256,hash(JSON.stringify(row.previous)));
  assert.equal(row.previous.afterUrl,'https://archive.biliimg.com/bfs/archive/unsaved-new-export.jpg');
  assert.strictEqual(r.receipt.sourcePreview,row.previous.sourcePreview);
  assert.strictEqual(row.expected.cover,r.receipt);
  assert.deepEqual(fs.readFileSync(row.f.assetPath),row.beforeBytes);
  assert.ok(r.comparison.comparisonMetrics.rmse<3&&r.comparison.comparisonMetrics.correlation>.99);
});

test('readback cannot escape the exact unpublished one-part original or bypass incomplete metadata',async t=>{
  for(const change of [
    row=>{row.native.draftId='foreign';},row=>{row.native.published=true;},
    row=>{row.native.partCount=2;},row=>{row.native.uploadComplete=false;},
    row=>{row.revision.sourceTaskSpaceId=43;},
    row=>{row.observation.gates.description.ok=false;},row=>{row.observation.gates.aiGenerated.ok=false;},
    row=>{row.observation.gates.draftIdentity.evidence.restoredIdentity.actualId='foreign';},
    row=>{row.revision.sourceReceipts.cover.assetHash='f'.repeat(64);},
    row=>{row.previous.sourcePreview.fresh=false;},
  ]){
    const row=await originalCoverReadback(t,{change});
    assert.equal(row.result.ok,false);assert.equal(row.checkpoints.length,0);assert.equal(row.browser.images.length,0);
  }
  for(const options of [{phase:'inspect'},{guard:{armed:true,blockedAttempts:1}},{guard:{armed:false,blockedAttempts:0}}]){
    const row=await originalCoverReadback(t,options);assert.equal(row.result.ok,false);assert.equal(row.checkpoints.length,0);
  }
});

test('fresh current-CDN pixels must independently pass the unchanged black-image, ratio and similarity thresholds',async t=>{
  for(const pixels of [{nativePixels:uniform()},{nativePixels:pattern(30)},
    {nativeWidth:1280,nativeHeight:720},{broken:true},{tainted:true}]){
    const row=await originalCoverReadback(t,{pixels});
    assert.equal(row.result.ok,false);assert.equal(row.checkpoints.length,0);assert.strictEqual(row.expected.cover,row.previous);
  }
});

test('ambiguous native URLs, source mutation and concurrent draft/media/metadata changes cannot mint readback receipts',async t=>{
  for(const change of [
    row=>{row.observation.gates.cover.evidence.urls=[nativeUrl,'https://archive.biliimg.com/bfs/archive/other.jpg'];},
    row=>{row.observation.gates.cover.evidence.urls=['https://foreign.example/cover.jpg'];},
    row=>{row.afterNative.nativeFileIds=['filename:changed'];},
    row=>{row.afterNative.draftId='changed';},
    row=>{row.after.gates.title.ok=false;},
    row=>{row.after.gates.cover.evidence.urls=['https://archive.biliimg.com/bfs/archive/changed.jpg'];},
  ]){
    const row=await originalCoverReadback(t,{change});assert.equal(row.result.ok,false);assert.equal(row.checkpoints.length,0);
  }
  const changed=await originalCoverReadback(t,{changeAsset:true});
  assert.equal(changed.result.ok,false);assert.equal(changed.checkpoints.length,0);
});

test('a failed revision checkpoint leaves the expected receipt untouched and cannot permit replacement',async t=>{
  const row=await originalCoverReadback(t,{checkpointFails:true});
  assert.equal(row.result.ok,false);assert.equal(row.checkpoints.length,1);assert.strictEqual(row.expected.cover,row.previous);
});
