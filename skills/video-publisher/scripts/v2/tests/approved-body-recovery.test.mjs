import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { evaluateObservation, requiredGates, gate } from '../lib/model.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const douyin = fs.readFileSync(new URL('../platforms/douyin.mjs', import.meta.url), 'utf8');
const xhs = fs.readFileSync(new URL('../platforms/xiaohongshu.mjs', import.meta.url), 'utf8');

async function tail({body, last, whole, entities = []}) {
  const inspect = new AsyncFunction('pkg', 'js', `${douyin}
    locateDouyinEditor=async()=>({ok:true});
    return await inspectDouyinTrailingPlainText();`);
  const node = {nodeValue:last,parentElement:{closest:()=>null}};
  const editor = {innerText:whole,querySelectorAll:()=>entities.map(name=>({innerText:'#'+name}))};
  const document = {querySelector:()=>editor,createTreeWalker:()=>{
    let returned=false;
    return {nextNode:()=>returned?null:(returned=true,node)};
  }};
  return inspect({platformTitle:{douyin:'title'},douyinDescription:body,douyinTopics:[]},
    async expression=>vm.runInNewContext(expression,{document,NodeFilter:{SHOW_TEXT:4}}));
}

test('first Douyin topic is isolated only after the complete multiline body matches', async()=>{
  const body='第一段。\n最后一段。';
  assert.equal((await tail({body,last:'最后一段。 #人工智能',whole:body+' #人工智能'})).trimmed,'#人工智能');
  assert.equal((await tail({body,last:'最后一段。',whole:body})).trimmed,'');
  assert.equal((await tail({body,last:'最后一段。 #人工智能',whole:'错误第一段。\n最后一段。 #人工智能'})).trimmed,'最后一段。 #人工智能');
  assert.equal((await tail({body,last:' #科技',whole:body+' #人工智能 #科技',entities:['人工智能']})).trimmed,'#科技');
});

test('Xiaohongshu description is a required independent READY gate', ()=>{
  const gates=Object.fromEntries(requiredGates('xiaohongshu').map(name=>[name,gate(true)]));
  gates.description=gate(false,{expected:'approved body',actual:''});
  const verdict=evaluateObservation({platform:'xiaohongshu',phase:'verify',gates});
  assert.equal(verdict.ready,false);
  assert.ok(verdict.missing.includes('description'));
});

test('legacy body fallback requires three identical bound platform descriptions', async()=>{
  const get=new AsyncFunction('pkg','videoPath',`${xhs}\nreturn xhsDescription;`);
  const base={platformTitle:{xiaohongshu:'title'},xhsTopics:[],douyinDescription:'正文',bilibiliDescription:'正文',youtubeDescription:'正文'};
  assert.equal(await get(base,'/video.mp4'),'正文');
  assert.equal(await get({...base,youtubeDescription:'different'},'/video.mp4'),'');
  assert.equal(await get({...base,xhsDescription:'明确正文'},'/video.mp4'),'明确正文');
  assert.equal(await get({...base,xhsDescription:''},'/video.mp4'),'');
});

test('Douyin removes only one unexpected final entity after an intact approved prefix', async()=>{
  const run=new AsyncFunction('pkg','fixture',`${douyin}
    const deleted=[];
    inspectDouyinTrailingPlainText=async()=>({trimmed:''});
    focusDouyinEditorEnd=async()=>({ok:true});
    const pressKey=async key=>deleted.push(key),wait=async()=>{};
    inspectDouyin=async()=>({gates:{description:{ok:true},tags:{evidence:{entityNames:['one']}}}});
    return {result:await removeDouyinUnexpectedFinalTopic(fixture),deleted};`);
  const pkg={platformTitle:{douyin:'title'},douyinTopics:['one','two']};
  const fixture={gates:{description:{ok:true},tags:{evidence:{entityNames:['one','wrong'],unexpected:['wrong']}}}};
  const good=await run(pkg,fixture);
  assert.equal(good.result.ok,true);
  assert.deepEqual(good.deleted,['Backspace']);
  fixture.gates.tags.evidence.entityNames=['wrong','one'];
  const unsafe=await run(pkg,fixture);
  assert.equal(unsafe.result.ok,false);
  assert.deepEqual(unsafe.deleted,[]);
});

test('WeChat checkpoints actual file injection before a readiness timeout', async()=>{
  const source=fs.readFileSync(new URL('../platforms/wechat-channels.mjs',import.meta.url),'utf8');
  const saved=[];
  const run=new AsyncFunction('pkg','expectedReceipts','jobFingerprint','activeTaskSpace','checkpointReceipts','readDraftSaveJournal','wechatJournalFile','wechatJournalIdentity',`${source}
    inspectWechatChannels=async()=>({gates:{draftIdentity:{ok:true},video:{ok:false,evidence:{}}}});
    waitWechatSdkReady=async()=>({ok:true});
    injectWechatVideo=async()=>({ok:true});
    waitWechatEarlyMutationReady=async()=>{throw new Error('readiness timeout')};
    return await startWechatChannelsUpload();`);
  await assert.rejects(run({wechatDescription:'body'},{},'bound-fingerprint',{id:26},receipt=>saved.push(receipt),()=>null,()=>'',()=>({})),/readiness timeout/);
  assert.equal(saved.length,1);
  assert.equal(saved[0].uploadStart.mode,'injected');
  assert.equal(saved[0].uploadStart.fingerprint,'bound-fingerprint');
  assert.equal(saved[0].uploadStart.taskSpaceId,26);
});

test('YouTube unselected promotion radios remain unknown, never false by default', ()=>{
  const source=fs.readFileSync(new URL('../platforms/youtube.mjs',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('    const paidYes ='),source.indexOf('    const allowEmbedding ='));
  const read=new Function('radioChecked','checked','paidPromotionControl',code+'\nreturn paidPromotion;');
  assert.equal(read(()=>null,()=>null,{}),null);
  assert.equal(read(names=>names.includes('VIDEO_PAID_PRODUCT_PLACEMENT_NO')?{}:null,()=>null,{}),false);
  assert.equal(read(names=>names.includes('VIDEO_PAID_PRODUCT_PLACEMENT_NOTIFY')?{}:null,()=>null,{}),true);
});
