import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=fs.readFileSync(new URL('../platforms/bilibili.mjs',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('async function prepareBilibiliCoverEntry'),source.indexOf('async function uploadBilibiliCoverV2'));
const upload=source.slice(source.indexOf('async function uploadBilibiliCoverV2'),source.indexOf('async function ensureBilibiliEarlyMetadata'));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
function el({text='',parent=null,accept='',classes=''}={}){
  return {innerText:text,textContent:text,parentElement:parent,accept,className:classes,id:'',disabled:false,clicks:0,
    style:{display:'block',visibility:'visible',opacity:'1'},queries:{},
    getBoundingClientRect(){return {left:0,top:0,width:200,height:120}},
    querySelectorAll(selector){return this.queries[selector]||[]},
    scrollIntoView(){},click(){this.clicks++},
    contains(child){for(let current=child;current;current=current.parentElement)if(current===this)return true;return false},
    closest(selector){const required=selector.split('.').filter(Boolean);for(let current=this;current;current=current.parentElement){const present=current.className.split(' ').filter(Boolean);if(required.every(value=>present.includes(value)))return current}return null},
  };
}
function fixture(){
  const main=el({classes:'cover-module-main'}),card=el({parent:main,classes:'cover-img'});
  const span=el({text:'封面设置',parent:card,classes:'edit-text'});span.style.opacity='0';
  const dialogs=[],outsideInput=el({accept:'image/*'});
  const query={'.bcc-dialog,.bcc-modal,[role="dialog"]':dialogs,'.cover .cover-content .cover-img':[card],
    '.cover button,.cover [role="button"],.cover .edit-text':[span],'input[type=file]':[outsideInput]};
  const document={querySelectorAll:selector=>query[selector]||[],elementFromPoint:()=>card};
  const js=async expression=>vm.runInNewContext(expression,{document,getComputedStyle:element=>element.style});
  const prepare=new AsyncFunction('js',helpers+'\nreturn await prepareBilibiliCoverEntry();');
  const expose=new AsyncFunction('js',helpers+'\nreturn await exposeBilibiliCoverImageInput();');
  function editor({text='封面制作 首页推荐封面 上传封面 完成',accept='image/*'}={}){
    const dialog=el({text,classes:'bcc-dialog'}),input=el({parent:dialog,accept});
    input.style.display='none';dialog.queries['input[type=file]']=[input];dialogs.push(dialog);return {dialog,input};
  }
  return {prepare:()=>prepare(js),expose:()=>expose(js),card,span,dialogs,query,document,outsideInput,editor};
}

function emptyCoverFixture(){
  const f=fixture();f.query['.cover .cover-content .cover-img']=[];
  const nodes=[];
  function node(options){const value=el(options);nodes.push(value);return value}
  const cover=node({classes:'cover'}),content=node({parent:cover,classes:'cover-content'});
  const main=node({parent:content,classes:'cover-main'}),module=node({parent:main,classes:'cover-module cover-module-main'});
  function entry({parent=module,text='添加封面'}={}){
    const slot=node({parent,classes:'cover-slot'}),empty=node({parent:slot,classes:'cover-empty'});
    const pill=node({parent:empty,classes:'cover-empty-pill',text});
    const label=node({parent:pill,classes:'add-text',text});
    return {pill,label,empty,slot};
  }
  // Match descendant class selectors against the fixture hierarchy so a broader
  // production selector would also expose recommendation entries to these tests.
  function matchesDescendants(candidate,selector){
    const classes=selector.split(/\s+/);
    const matches=(element,part)=>part.startsWith('.')&&part.slice(1).split('.').every(value=>element.className.split(/\s+/).includes(value));
    if(!matches(candidate,classes.pop()))return false;
    let current=candidate.parentElement;
    while(classes.length){
      const part=classes.pop();while(current&&!matches(current,part))current=current.parentElement;
      if(!current)return false;current=current.parentElement;
    }
    return true;
  }
  f.document.querySelectorAll=selector=>Object.hasOwn(f.query,selector)?f.query[selector]:nodes.filter(node=>matchesDescendants(node,selector));
  const active=entry();f.document.elementFromPoint=()=>active.label;
  return {...f,active,entry,recommendationParent:node({parent:content,classes:'cover-recommend-list cover-ai-recommend'})};
}

test('Bilibili cover entry selects the unique visible main card instead of a hidden text span',async()=>{
  const f=fixture(),result=await f.prepare();
  assert.equal(result.ok,true);assert.equal(result.source,'main-cover-card');
  assert.equal(result.selector,'#'+f.card.id);assert.notEqual(f.card.id,'');
  assert.equal(f.span.id,'');assert.equal(f.span.clicks,0);assert.equal(f.card.clicks,0,'opening is delegated to the real click channel');
});
test('Bilibili cover entry rejects a hidden main card and hidden text instead of using their nonzero layout boxes',async()=>{
  const f=fixture();f.card.style.opacity='0';
  assert.equal((await f.prepare()).ok,false);assert.equal(f.span.clicks,0);
});
test('Bilibili cover entry refuses duplicate visible main cards',async()=>{
  const f=fixture();f.query['.cover .cover-content .cover-img'].push(el({parent:f.card.parentElement}));
  assert.equal((await f.prepare()).ok,false);
});
test('Bilibili new draft opens its exact visible main empty-cover pill through the real click channel',async()=>{
  const f=emptyCoverFixture(),result=await f.prepare();
  assert.equal(result.ok,true);assert.equal(result.selector,'#'+f.active.pill.id);
  assert.notEqual(f.active.pill.id,'');assert.equal(f.active.label.id,'');
  assert.equal(f.active.pill.clicks,0,'prepare only exposes the target for real pointer input');
});
test('Bilibili empty-cover entry rejects hidden pills and ancestor-hidden pills despite layout boxes',async()=>{
  for(const [target,property,value] of [['pill','opacity','0'],['pill','visibility','hidden'],['empty','display','none']]){
    const f=emptyCoverFixture();f.active[target].style[property]=value;
    assert.equal((await f.prepare()).ok,false,`${target} ${property}`);
    assert.equal(f.active.pill.id,'');
  }
});
test('Bilibili empty-cover entry requires the exact 添加封面 label',async()=>{
  for(const text of ['添加封面 推荐','添加封面设置','AI生成','']){
    const f=emptyCoverFixture();f.active.pill.innerText=text;f.active.pill.textContent=text;
    assert.equal((await f.prepare()).ok,false,text);
  }
});
test('Bilibili empty-cover entry refuses duplicate visible main pills',async()=>{
  const f=emptyCoverFixture(),duplicate=f.entry();
  assert.equal((await f.prepare()).ok,false);
  assert.equal(f.active.pill.id,'');assert.equal(duplicate.pill.id,'');
});
test('Bilibili empty-cover selector excludes recommendation pills and chooses only the main entry',async()=>{
  const f=emptyCoverFixture(),recommended=f.entry({parent:f.recommendationParent});
  assert.equal((await f.prepare()).ok,true);assert.notEqual(f.active.pill.id,'');assert.equal(recommended.pill.id,'');
  const onlyRecommended=emptyCoverFixture();onlyRecommended.active.empty.style.display='none';
  onlyRecommended.entry({parent:onlyRecommended.recommendationParent});
  assert.equal((await onlyRecommended.prepare()).ok,false);
});
test('Bilibili empty-cover entry rejects an obscured real pointer target',async()=>{
  const f=emptyCoverFixture();f.document.elementFromPoint=()=>el({classes:'unrelated-overlay'});
  assert.equal((await f.prepare()).ok,false);assert.equal(f.active.pill.id,'');
});
test('Bilibili empty-cover entry is ambiguous when another visible exact cover control exists',async()=>{
  const f=emptyCoverFixture();f.query['.cover button,.cover [role="button"],.cover .edit-text'].push(el({text:'添加封面'}));
  assert.equal((await f.prepare()).ok,false);assert.equal(f.active.pill.id,'');
});
test('Bilibili already-open cover editor must be uniquely visible and exact',async()=>{
  const f=fixture();f.editor();
  assert.equal((await f.prepare()).alreadyOpen,true);
  f.editor();assert.equal((await f.prepare()).ok,false);
  const other=fixture();other.editor({text:'批量操作 确定 取消'});
  assert.equal((await other.prepare()).ok,false);
});
test('Bilibili image input belongs to the visible cover editor and may itself be a native hidden file input',async()=>{
  const f=fixture(),{dialog,input}=f.editor({accept:'.jpg,.png,.webp'});
  const result=await f.expose();assert.equal(result.ok,true);
  assert.equal(result.selector,`#${dialog.id} #${input.id}`);assert.equal(result.source,'legacy-single-input');assert.equal(f.outsideInput.id,'');
});
test('Bilibili new cover editor selects only the unique native input in the 4:3 canvas slot',async()=>{
  const f=fixture(),{dialog,input:generic}=f.editor({accept:'image/png, image/jpeg'});
  const slot4x3=el({parent:dialog,classes:'cover-editor-panel-canvas-empty ratio_4_3'});
  const slot16x9=el({parent:dialog,classes:'cover-editor-panel-canvas-empty ratio_16_9'});
  const input4x3=el({parent:slot4x3,accept:'image/png, image/jpeg'});
  const input16x9=el({parent:slot16x9,accept:'image/png, image/jpeg'});
  generic.parentElement=el({parent:dialog,classes:'bcc-upload cover-upload cover-editor-panel-select-item'});
  dialog.queries['input[type=file]']=[input4x3,input16x9,generic];
  const result=await f.expose();
  assert.equal(result.ok,true);assert.equal(result.source,'primary-4:3-slot');
  assert.equal(result.imageInputs,3);assert.equal(result.primary4x3Inputs,1);
  assert.equal(result.selector,`#${dialog.id} #${input4x3.id}`);
  assert.notEqual(input4x3.id,'');assert.equal(input16x9.id,'');assert.equal(generic.id,'');
});
test('Bilibili new cover editor does not treat a lone 16:9 slot input as the legacy single-input UI',async()=>{
  const f=fixture(),{dialog,input}=f.editor({accept:'image/png, image/jpeg'});
  const slot16x9=el({parent:dialog,classes:'cover-editor-panel-canvas-empty ratio_16_9'});input.parentElement=slot16x9;
  dialog.queries['.cover-editor-panel-canvas-empty.ratio_4_3,.cover-editor-panel-canvas-empty.ratio_16_9']=[slot16x9];
  const result=await f.expose();
  assert.equal(result.ok,false);assert.equal(result.imageInputs,1);assert.equal(result.primary4x3Inputs,0);assert.equal(result.ratioSlots,1);
  assert.equal(input.id,'');
});
test('Bilibili new cover editor rejects duplicate native inputs in the 4:3 canvas slot',async()=>{
  const f=fixture(),{dialog}=f.editor({accept:'image/png, image/jpeg'});
  const slot4x3=el({parent:dialog,classes:'cover-editor-panel-canvas-empty ratio_4_3'});
  const first=el({parent:slot4x3,accept:'image/png, image/jpeg'}),second=el({parent:slot4x3,accept:'image/png, image/jpeg'});
  dialog.queries['input[type=file]']=[first,second];
  const result=await f.expose();
  assert.equal(result.ok,false);assert.equal(result.primary4x3Inputs,2);assert.match(result.reason,/4:3 cover image input is ambiguous/);
  assert.equal(first.id,'');assert.equal(second.id,'');
});
test('Bilibili new cover editor never falls back by DOM order when multiple image inputs have no 4:3 slot',async()=>{
  const f=fixture(),{dialog,input:first}=f.editor({accept:'image/png, image/jpeg'});
  const second=el({parent:dialog,accept:'image/png, image/jpeg'});
  dialog.queries['input[type=file]']=[first,second];
  const result=await f.expose();
  assert.equal(result.ok,false);assert.equal(result.imageInputs,2);assert.equal(result.primary4x3Inputs,0);
  assert.equal(first.id,'');assert.equal(second.id,'');
});
test('Bilibili input discovery never falls back to an unrelated global image input',async()=>{
  const f=fixture();assert.equal((await f.expose()).ok,false);
  const {dialog}=f.editor();dialog.queries['input[type=file]']=[];
  const result=await f.expose();assert.equal(result.ok,false);assert.equal(result.imageInputs,0);
  assert.equal(f.outsideInput.id,'');
});
test('Bilibili input discovery rejects non-image, duplicate and ancestor-hidden stale inputs',async()=>{
  for(const accept of ['video/*','.txt','image/*,video/*','']){
    const f=fixture();f.editor({accept});assert.equal((await f.expose()).ok,false,accept);
  }
  const duplicate=fixture(),{dialog}=duplicate.editor();dialog.queries['input[type=file]'].push(el({parent:dialog,accept:'image/jpeg'}));
  assert.equal((await duplicate.expose()).ok,false);
  const stale=fixture(),active=stale.editor(),hiddenParent=el({parent:active.dialog});hiddenParent.style.display='none';active.input.parentElement=hiddenParent;
  assert.equal((await stale.expose()).ok,false);
});

function uploadHarness({inputMissing=false,alreadyOpen=false,inputReplacedDuringDecode=false}={}){
  const calls=[];let injected=false,inputGeneration=0;
  const inputSelector=()=>inputReplacedDuringDecode?'#editor #image-input-'+inputGeneration:'#editor #image-input';
  const inspectBilibili=async()=>({gates:{cover:{evidence:{urls:[injected?'https://archive.biliimg.com/new.jpg':'https://archive.biliimg.com/old.jpg']}},noBlockingDialog:{ok:true}}});
  const prepareBilibiliCoverEntry=async()=>({ok:true,selector:'#main-card',alreadyOpen});
  const exposeBilibiliCoverImageInput=async()=>inputMissing?{ok:false,waiting:true,reason:'bilibili cover image input missing in active editor'}:{ok:true,selector:inputSelector(),editorSelector:'#editor'};
  const click=async selector=>calls.push('click:'+selector);
  const uploadFile=async(selector,path)=>{if(inputReplacedDuringDecode&&selector!==inputSelector())throw Error('Native file input was replaced');calls.push('upload:'+selector+':'+path);injected=true};
  const js=async expression=>{assert.ok(expression.includes('editorSelector'));return {selector:'#cover-confirm',text:'完成'}};
  const readBilibiliCoverAsset=()=>({ok:true,assetHash:'a'.repeat(64)});
  const compareBilibiliCoverPixels=async(_asset,target)=>{if(inputReplacedDuringDecode&&!injected)inputGeneration=1;return {ok:true,sourcePixelSha256:'b'.repeat(64),nativePixelSha256:'c'.repeat(64),comparisonMetrics:{rmse:0,correlation:1},
    candidates:target.editorSelector?[{ok:injected,key:injected?'new-paint':'old-paint',sourcePixelSha256:'b'.repeat(64),nativePixelSha256:'c'.repeat(64)}]:[]};};
  const run=new AsyncFunction('bilibiliCustomCover','bilibiliCoverPath','inspectBilibili','prepareBilibiliCoverEntry','exposeBilibiliCoverImageInput','click','uploadFile','js','wait','readBilibiliCoverAsset','compareBilibiliCoverPixels',upload+'\nreturn await uploadBilibiliCoverV2();');
  return {run:()=>run(true,'/approved.webp',inspectBilibili,prepareBilibiliCoverEntry,exposeBilibiliCoverImageInput,click,uploadFile,js,async()=>{},readBilibiliCoverAsset,compareBilibiliCoverPixels),calls};
}
test('Bilibili cover upload uses the real main-card click before the active editor image input',async()=>{
  const h=uploadHarness();assert.equal((await h.run()).ok,true);
  assert.deepEqual(h.calls,['click:#main-card','upload:#editor #image-input:/approved.webp','click:#cover-confirm']);
});
test('Bilibili cover upload does not inject any file when the real editor has no image input',async()=>{
  const h=uploadHarness({inputMissing:true}),result=await h.run();
  assert.equal(result.ok,false);assert.match(result.reason,/image input missing/);assert.deepEqual(h.calls,['click:#main-card']);
});
test('Bilibili cover upload reuses only the previously proven unique visible editor',async()=>{
  const h=uploadHarness({alreadyOpen:true});assert.equal((await h.run()).ok,true);
  assert.deepEqual(h.calls,['upload:#editor #image-input:/approved.webp','click:#cover-confirm']);
});

test('Bilibili survives native input replacement while source-pixel decode is pending',async()=>{
  const h=uploadHarness({inputReplacedDuringDecode:true});assert.equal((await h.run()).ok,true);
  assert.deepEqual(h.calls,['click:#main-card','upload:#editor #image-input-1:/approved.webp','click:#cover-confirm']);
});
