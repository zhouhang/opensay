import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../ego/core.mjs', import.meta.url), 'utf8');
const selection = source.slice(source.indexOf('function explicitVideoTaskRecoveryAllowed()'), source.indexOf('async function armFinalPublishGuard'));

test('tag revision never recreates a missing or recycled original task space', async () => {
  for (const missing of [false, true]) {
    const calls = [];
    const context = vm.createContext({noUpload:true,platform:'douyin',taskSpaceRef:'42',taskName:'original',activeTaskSpace:null,taskSpaceRecovery:null,
      useOrCreateTaskSpace: async ref => { calls.push(ref); if (missing) throw new Error('task space not found'); return {id:42,name:'foreign'}; }});
    vm.runInContext(selection,context);
    await assert.rejects(context.selectTaskSpace(),/Tag-only revision original task space/);
    assert.deepEqual(calls,[42]);
  }
});

test('tag revision keeps the exact original task space and refuses a missing creator tab', async () => {
  let opened=0;
  const context=vm.createContext({noUpload:true,taskSpaceRef:'42',taskName:'original',activeTaskSpace:null,taskSpaceRecovery:null,
    platform:'douyin',PLATFORM_HOSTS:{douyin:/douyin/},useOrCreateTaskSpace:async()=>({id:42,name:'original'}),
    listTabs:async()=>[],openOrReuseTab:async()=>{opened++}});
  vm.runInContext(selection,context);
  assert.equal((await context.selectTaskSpace()).id,42);
  await assert.rejects(context.selectPlatformTab(),/creator tab is missing/);
  assert.equal(opened,0);
});
