import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../platforms/wechat-channels.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function openWechatShareCoverMaterialEditor');
const end=source.indexOf('async function uploadWechatCover',start);
assert.ok(start>=0&&end>start);
const helper=source.slice(start,end);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;

function element({text='',classes='',parent=null,visible=true,disabled=false,attrs={}}={}){
  return {
    innerText:text,textContent:text,className:classes,parentElement:parent,disabled,shadowRoot:null,
    style:{display:visible?'block':'none',visibility:'visible',opacity:'1'},
    queries:{},clicks:0,
    querySelectorAll(selector){return this.queries[selector]||[]},
    getBoundingClientRect(){return {width:100,height:32}},
    getRootNode(){return {}},
    getAttribute(name){return attrs[name]??null},
    matches(selector){return selector.split('.').filter(Boolean).every(cls=>this.className.split(/\s+/).includes(cls))},
    closest(selector){for(let current=this;current;current=current.parentElement){if(current.matches(selector))return current}return null},
    click(){this.clicks+=1},
  };
}

function fixture({prompt='使用此素材作为封面？',open=true,dialog=false,disabled=false,shadow=false}={}){
  const trigger=element({classes:'horizon-cover-wrap img-popover-wrap'+(open?' ant-popover-open':'')});
  const popover=element({classes:'ant-popover'});
  const tooltip=element({classes:'ant-popover-inner',parent:popover});
  const title=element({text:prompt,classes:'title',parent:tooltip});
  const directWrap=element({classes:'btn-directly-edit',parent:tooltip});
  const button=element({text:'直接编辑',parent:directWrap,disabled});
  const useWrap=element({classes:'btn-use',parent:tooltip});
  const useButton=element({text:'使用素材',parent:useWrap});
  popover.queries['.title']=[title];
  popover.queries.button=[button,useButton];
  const dialogs=dialog?[element({text:'编辑分享卡片 上传封面 取消 确认'})]:[];
  const query={
    '#vp2-wechat-cover-horizontal':[trigger],
    '.weui-desktop-dialog__wrp':dialogs,
    '[role="tooltip"],.ant-popover':[popover,tooltip],
  };
  const root={querySelectorAll:selector=>query[selector]||[]};
  const document=shadow?{querySelectorAll:selector=>selector==='*'?[{shadowRoot:root}]:[]}:{querySelectorAll:selector=>selector==='*'?[]:query[selector]||[]};
  let evaluations=0;
  const js=async expression=>{evaluations+=1;return vm.runInNewContext(expression,{document,getComputedStyle:el=>el.style})};
  const run=new AsyncFunction('js','slot','entryClicked','choiceState',`${helper}\nreturn await openWechatShareCoverMaterialEditor('#vp2-wechat-cover-horizontal',slot,entryClicked,choiceState);`);
  return {run:(slot='horizontal',entryClicked=true,choiceState={clicked:false})=>run(js,slot,entryClicked,choiceState),trigger,popover,tooltip,title,directWrap,button,useButton,query,evaluations:()=>evaluations};
}

test('WeChat share cover selects the unique known direct editor, not material reuse',async()=>{
  const f=fixture();
  const selected=await f.run();
  assert.equal(selected.clicked,true);
  assert.equal(selected.label,'直接编辑');
  assert.equal(f.button.clicks,1);
  assert.equal(f.useButton.clicks,0);
});

test('WeChat share cover recognizes the known popover across an open shadow root',async()=>{
  const f=fixture({shadow:true});
  assert.equal((await f.run()).clicked,true);
  assert.equal(f.button.clicks,1);
});

test('WeChat share cover requires a successfully clicked horizontal entry',async()=>{
  for(const [slot,clicked] of [['vertical',true],['horizontal',false],['horizontal',undefined]]){
    const f=fixture();
    const actualClicked=clicked===undefined?null:clicked;
    assert.equal((await f.run(slot,actualClicked)).skipped,true);
    assert.equal(f.button.clicks,0);
    assert.equal(f.evaluations(),0);
  }
});

test('WeChat share cover requires its corresponding open material trigger',async()=>{
  for(const change of [f=>f.trigger.className='horizon-cover-wrap img-popover-wrap',f=>f.trigger.className='vertical-cover-wrap img-popover-wrap ant-popover-open',f=>f.query['#vp2-wechat-cover-horizontal'].push(element({classes:f.trigger.className}))]){
    const f=fixture();change(f);
    assert.equal((await f.run()).clicked,undefined);
    assert.equal(f.button.clicks,0);
  }
});

test('WeChat share cover leaves an already open editor unchanged',async()=>{
  const f=fixture({dialog:true});
  const result=await f.run();
  assert.equal(result.editorOpen,true);
  assert.equal(result.skipped,true);
  assert.equal(f.button.clicks,0);
});

test('WeChat share cover ignores foreign or similar material popovers',async()=>{
  for(const prompt of ['是否使用素材？','使用此素材作为封面','使用此素材作为封面？继续发布']){
    const f=fixture({prompt});
    assert.equal((await f.run()).clicked,undefined);
    assert.equal(f.button.clicks,0);
    assert.equal(f.useButton.clicks,0);
  }
});

test('WeChat share cover fails closed on two visible matching popovers',async()=>{
  const f=fixture();
  const other=element({classes:'ant-popover'});
  other.queries['.title']=[element({text:'使用此素材作为封面？',classes:'title',parent:other})];
  other.queries.button=[element({text:'直接编辑',parent:element({classes:'btn-directly-edit',parent:other})})];
  f.query['[role="tooltip"],.ant-popover'].push(other);
  assert.equal((await f.run()).clicked,undefined);
  assert.equal(f.button.clicks,0);
  assert.equal(other.queries.button[0].clicks,0);
});

test('WeChat share cover fails closed on duplicate direct edit buttons',async()=>{
  const f=fixture();
  const other=element({text:'直接编辑',parent:f.directWrap});
  f.popover.queries.button.push(other);
  assert.equal((await f.run()).clicked,undefined);
  assert.equal(f.button.clicks,0);
  assert.equal(other.clicks,0);
});

test('WeChat share cover never clicks disabled or foreign action buttons',async()=>{
  for(const change of [f=>f.button.disabled=true,f=>f.button.getAttribute=name=>name==='aria-disabled'?'true':null,f=>f.button.className='weui-desktop-btn_disabled',f=>f.directWrap.className='foreign-edit']){
    const f=fixture();change(f);
    assert.equal((await f.run()).clicked,undefined);
    assert.equal(f.button.clicks,0);
  }
});

test('WeChat share cover does not use a hidden popover or a button hidden by its ancestor',async()=>{
  for(const change of [f=>f.popover.style.display='none',f=>f.directWrap.style.opacity='0',f=>f.button.style.visibility='hidden']){
    const f=fixture();change(f);
    assert.equal((await f.run()).clicked,undefined);
    assert.equal(f.button.clicks,0);
  }
});

test('WeChat share cover clicks the same proven entry choice at most once',async()=>{
  const f=fixture();
  const choiceState={clicked:false};
  assert.equal((await f.run('horizontal',true,choiceState)).clicked,true);
  assert.equal(choiceState.clicked,true);
  assert.equal((await f.run('horizontal',true,choiceState)).skipped,true);
  assert.equal(f.button.clicks,1);
  assert.equal(f.evaluations(),1);
});

test('WeChat cover opens the direct editor only after a proven native entry click and before image injection',()=>{
  const flow=source.slice(source.indexOf('async function uploadWechatCover'),source.indexOf('async function ensureWechatEarlyMetadata'));
  const nativeClick=flow.indexOf('await click([entry.x,entry.y]');
  const choice=flow.indexOf('await openWechatShareCoverMaterialEditor(prepared.selector,asset.slot,opened.clicked,materialChoice)');
  const injection=flow.indexOf("await cdp('DOM.setFileInputFiles'");
  assert.ok(nativeClick>=0&&choice>nativeClick&&injection>choice);
  assert.match(flow,/opened=\{\.\.\.entry,clicked:true\}/);
  assert.match(helper,/button\.click\(\)/);
  assert.doesNotMatch(helper,/使用素材['"]|\.btn-use|发布|发表|保存/);
});
