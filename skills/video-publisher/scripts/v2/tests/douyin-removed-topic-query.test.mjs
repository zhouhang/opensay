import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const source=fs.readFileSync(new URL('../platforms/douyin.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function resolveDouyinRemovedTopicQuery');
const end=source.indexOf('async function recoverDouyinTopicPrefix',start);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function resolve({query='#GPT61',actualId='native1',fingerprint='new',context=true,old=['AI','GPT6.1','remotion']}={}){
 const ctx=context?{sourceDraftId:'native1',previousFingerprint:'old',nextFingerprint:'new'}:null;
 const state={fingerprint,tagRevision:{previousFingerprint:'old',nextFingerprint:'new',previousPackagePath:'/old.json',nextPackagePath:'/new.json',sources:{douyin:{sourceDraftId:'native1'}}}};
 const fileSystem={readFileSync:file=>JSON.stringify(file==='/old.json'?{douyinTopics:old}:state)};
 const normalize=value=>String(value).replace(/^#/,'').replace(/\s+/g,'').toLowerCase();
 const run=new AsyncFunction('fs','path','tagRevisionContext','receiptCheckpointPath','jobFingerprint','packagePath','douyinTopics','normalizeDouyinTopic','inspectDouyinTrailingPlainText','before',source.slice(start,end)+';return await resolveDouyinRemovedTopicQuery(before);');
 return run(fileSystem,path,ctx,'/job/checkpoints/douyin.receipts.json','new','/new.json',['AI','remotion'],normalize,async()=>({ok:true,trimmed:query}),{gates:{draftIdentity:{evidence:{restoredIdentity:{actualId}}}}});
}
test('approved removed model topic query is recoverable only on original native editor',async()=>{
 const result=await resolve();assert.equal(result.query,'GPT61');assert.equal(result.removedTopic,'GPT6.1');assert.equal(result.sourceDraftId,'native1');
 assert.equal((await resolve({query:'#GPT6.1'})).query,'GPT6.1');
});
test('unknown residue, prose and retained topics remain unmodifiable',async()=>{
 for(const options of [{query:'#other'},{query:'prose #GPT61'},{query:'#remotion'},{old:['AI','remotion']}])assert.equal(await resolve(options),null);
});
test('missing approval context, different native resource or different fingerprint fail closed',async()=>{
 for(const options of [{context:false},{actualId:'other-native'},{fingerprint:'wrong'}])assert.equal(await resolve(options),null);
});
