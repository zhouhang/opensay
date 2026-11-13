import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../platforms/wechat-channels.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function confirmWechatCustomCoverEditor');
const end=source.indexOf('async function uploadWechatCover',start);
assert.ok(start>=0&&end>start);
const helper=source.slice(start,end);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;

function element({text='',classes='',parent=null,disabled=false}={}){
  return {
    innerText:text,textContent:text,className:classes,parentElement:parent,disabled,shadowRoot:null,
    style:{display:'block',visibility:'visible',opacity:'1'},queries:{},clicks:0,
    querySelectorAll(selector){return this.queries[selector]||[]},
    getBoundingClientRect(){return {width:100,height:32}},
    getRootNode(){return {}},
    getAttribute(){return null},
    matches(selector){return selector.split('.').filter(Boolean).every(cls=>this.className.split(/\s+/).includes(cls))},
    closest(selector){for(let current=this;current;current=current.parentElement){if(current.matches(selector))return current}return null},
    click(){this.clicks+=1},
  };
}

function dialog(title,buttonLabel='确认'){
  const wrapper=element({text:title+' 上传封面 取消 '+buttonLabel,classes:'weui-desktop-dialog__wrp'});
  const button=element({text:buttonLabel,parent:wrapper});
  const cancel=element({text:'取消',parent:wrapper});
  wrapper.queries['button,[role="button"]']=[button,cancel];
  return {wrapper,button,cancel};
}

function fixture({title='编辑分享卡片',shadow=false,crop=false}={}){
  const parent=dialog(title);
  const dialogs=[parent.wrapper];
  const cropDialog=crop?dialog('裁剪封面图','确定'):null;
  if(cropDialog)dialogs.push(cropDialog.wrapper);
  const popovers=[];
  const query={'.weui-desktop-dialog__wrp':dialogs,'[role="tooltip"],.ant-popover':popovers};
  const root={querySelectorAll:selector=>query[selector]||[]};
  const document=shadow?{visibilityState:'visible',querySelectorAll:selector=>selector==='*'?[{shadowRoot:root}]:[]}:{visibilityState:'visible',querySelectorAll:selector=>selector==='*'?[]:query[selector]||[]};
  const js=async expression=>vm.runInNewContext(expression,{document,getComputedStyle:el=>el.style});
  const run=new AsyncFunction('js','title',`${helper}\nreturn await confirmWechatCustomCoverEditor(title);`);
  return {run:(requested='编辑分享卡片')=>run(js,requested),parent,crop:cropDialog,dialogs,popovers,document};
}

function recommendation(f,{hidden=false}={}){
  const host=element();if(hidden)host.style.opacity='0';
  const popover=element({classes:'ant-popover',parent:host});
  const tooltip=element({classes:'ant-popover-inner',parent:popover});
  const title=element({text:'使用此素材作为封面？',classes:'title',parent:tooltip});
  const material=element({text:'使用素材',parent:tooltip});
  popover.queries['.title']=[title];popover.queries['button,[role="button"]']=[material];
  f.popovers.push(popover,tooltip);
  return {host,popover,tooltip,title,material};
}

test('WeChat custom cover confirms its unique enabled matching parent editor',async()=>{
  const f=fixture();
  const result=await f.run();
  assert.equal(result.ok,true);
  assert.equal(result.confirmed,true);
  assert.equal(f.parent.button.clicks,1);
  assert.equal(f.parent.cancel.clicks,0);
});

test('WeChat custom cover confirmation works across an open shadow root',async()=>{
  const f=fixture({shadow:true});
  assert.equal((await f.run()).ok,true);
  assert.equal(f.parent.button.clicks,1);
});

test('WeChat custom cover ignores an old recommendation hidden by its ancestor',async()=>{
  const f=fixture();
  const old=recommendation(f,{hidden:true});
  assert.equal(old.material.style.opacity,'1');
  assert.equal(old.material.getBoundingClientRect().height,32);
  const result=await f.run();
  assert.equal(result.ok,true);
  assert.equal(old.material.clicks,0);
  assert.equal(f.parent.button.clicks,1);
  assert.equal(JSON.parse(result.evidence).material.popovers,0);
});

test('WeChat custom cover does not choose recommended material even when genuinely visible',async()=>{
  const f=fixture();
  const material=recommendation(f);
  const result=await f.run();
  assert.equal(result.ok,true);
  assert.equal(material.material.clicks,0);
  assert.deepEqual(JSON.parse(result.evidence).material,{popovers:1,buttons:1,clicked:false});
});

test('WeChat custom cover refuses a parent or confirm button hidden by an ancestor',async()=>{
  for(const setting of ['display','visibility','opacity']){
    const f=fixture();const ancestor=element();f.parent.wrapper.parentElement=ancestor;
    ancestor.style[setting]=setting==='display'?'none':setting==='visibility'?'hidden':'0';
    assert.equal((await f.run()).ok,false);
    assert.equal(f.parent.button.clicks,0);
  }
  const f=fixture();
  const buttonParent=element({parent:f.parent.wrapper});buttonParent.style.opacity='0';f.parent.button.parentElement=buttonParent;
  const result=await f.run();
  assert.equal(result.ok,false);
  assert.equal(f.parent.button.clicks,0);
  const evidence=JSON.parse(result.evidence);
  assert.equal(evidence.button.opacity,'1');
  assert.equal(evidence.button.visible,false);
});

test('WeChat custom cover rejects disabled and duplicate confirmation controls',async()=>{
  for(const change of [f=>f.parent.button.disabled=true,f=>f.parent.button.getAttribute=name=>name==='aria-disabled'?'true':null,f=>f.parent.button.className='weui-desktop-btn_disabled',f=>f.parent.wrapper.queries['button,[role="button"]'].push(element({text:'确认',parent:f.parent.wrapper}))]){
    const f=fixture();change(f);
    assert.equal((await f.run()).ok,false);
    assert.equal(f.parent.button.clicks,0);
  }
});

test('WeChat custom cover rejects a different slot title and duplicate matching parent dialogs',async()=>{
  const wrong=fixture({title:'编辑个人主页卡片'});
  assert.equal((await wrong.run()).ok,false);
  assert.equal(wrong.parent.button.clicks,0);
  const f=fixture();const other=dialog('编辑分享卡片');f.dialogs.push(other.wrapper);
  assert.equal((await f.run()).ok,false);
  assert.equal(f.parent.button.clicks,0);
  assert.equal(other.button.clicks,0);
});

test('WeChat custom cover accepts only a unique complete generic cover editor fallback',async()=>{
  const f=fixture({title:'编辑封面'});
  assert.equal((await f.run()).ok,true);
  for(const text of ['编辑封面 取消 确认','编辑个人主页卡片 编辑封面 上传封面 取消 确认']){
    const bad=fixture();bad.parent.wrapper.innerText=text;
    assert.equal((await bad.run()).ok,false);
    assert.equal(bad.parent.button.clicks,0);
  }
});

test('WeChat custom cover confirms the known crop before its matching parent',async()=>{
  const f=fixture({crop:true});
  const cropped=await f.run();
  assert.equal(cropped.ok,false);
  assert.equal(cropped.cropConfirmed,true);
  assert.equal(f.crop.button.clicks,1);
  assert.equal(f.parent.button.clicks,0);
  f.crop.wrapper.style.display='none';
  assert.equal((await f.run()).ok,true);
  assert.equal(f.parent.button.clicks,1);
});

test('WeChat custom cover crop requires a unique enabled exact control and the correct slot',async()=>{
  for(const change of [f=>f.crop.button.disabled=true,f=>f.crop.button.innerText='保存',f=>f.crop.wrapper.queries['button,[role="button"]'].push(element({text:'确定',parent:f.crop.wrapper})),f=>f.dialogs.push(dialog('裁剪封面图','确定').wrapper),f=>f.parent.wrapper.innerText='编辑个人主页卡片 上传封面 取消 确认']){
    const f=fixture({crop:true});change(f);
    assert.equal((await f.run()).ok,false);
    assert.equal(f.crop.button.clicks,0);
    assert.equal(f.parent.button.clicks,0);
  }
});

test('WeChat custom cover does not confirm an orphan crop or one with duplicate slot parents',async()=>{
  for(const change of [f=>f.dialogs.splice(0,1),f=>f.dialogs.push(dialog('编辑分享卡片').wrapper),f=>f.parent.wrapper.style.display='none',f=>f.parent.wrapper.innerText='编辑封面 上传封面 取消 确认']){
    const f=fixture({crop:true});change(f);
    const result=await f.run();
    assert.equal(result.ok,false);
    assert.equal(result.cropConfirmed,undefined);
    assert.equal(f.crop.button.clicks,0);
    assert.equal(f.parent.button.clicks,0);
  }
});

test('WeChat custom cover failure evidence is bounded and does not read image URLs',async()=>{
  const f=fixture();f.parent.button.disabled=true;
  f.parent.wrapper.queries.img=[{src:'data:image/png;base64,secret-image-payload'}];
  const result=await f.run();
  assert.equal(result.ok,false);
  assert.ok(result.evidence.length<=500);
  const evidence=JSON.parse(result.evidence);
  assert.equal(evidence.title,'编辑分享卡片');
  assert.equal(evidence.documentVisibility,'visible');
  assert.equal(evidence.button.disabled,true);
  assert.equal(evidence.button.w,100);
  assert.equal(evidence.button.h,32);
  assert.equal(evidence.button.opacity,'1');
  assert.equal(evidence.button.display,'block');
  assert.equal(evidence.crop.dialogs,0);
  assert.equal(evidence.material.popovers,0);
  assert.ok(!result.evidence.includes('data:image'));
});

test('WeChat custom cover retains its original bounded confirmation loop and last probe evidence',()=>{
  const flow=source.slice(source.indexOf('async function uploadWechatCover'),source.indexOf('async function ensureWechatEarlyMetadata'));
  assert.match(flow,/for\(let i=0;i<20;i\+=1\)\{await activateWechatLifecycle\(\);confirmed=await confirmWechatCustomCoverEditor\(asset\.dialogTitle\)/);
  assert.match(flow,/evidence:confirmed\.evidence/);
  assert.doesNotMatch(helper,/material(?:Buttons)?\[\d+\]\.click\(\)|\.src|data:image/);
});
