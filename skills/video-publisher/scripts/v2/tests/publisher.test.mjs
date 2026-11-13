import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from 'node:crypto';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const V2_DIR = path.dirname(DIR);
process.env.VIDEO_PUBLISHER_V2_LOCK_ROOT = path.join(os.tmpdir(), `video-publisher-publisher-test-locks-${process.pid}`);

function closeNamesFromLog(script) {
  const match = [...String(script).matchAll(/const closeNames = new Set\((\[.*?\])\)/gs)].at(-1);
  return match ? JSON.parse(match[1]) : [];
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(options?.env || {}) };
    // Each fixture is an independent publisher installation. Keep durable
    // content claims across its calls, while isolating identical tiny MP4 test
    // fixtures belonging to other tests. Explicit lock-root fixtures still win.
    if (options?.env?.VIDEO_PUBLISHER_CONFIG && (!options?.env?.VIDEO_PUBLISHER_V2_LOCK_ROOT
      || options.env.VIDEO_PUBLISHER_V2_LOCK_ROOT === process.env.VIDEO_PUBLISHER_V2_LOCK_ROOT)) {
      env.VIDEO_PUBLISHER_V2_LOCK_ROOT = path.join(path.dirname(options.env.VIDEO_PUBLISHER_CONFIG), 'publisher-locks');
    }
    if (options?.env?.VIDEO_PUBLISHER_CONFIG && !options?.env?.VIDEO_PUBLISHER_DRAFTBOX_LEDGER_PATH) {
      env.VIDEO_PUBLISHER_DRAFTBOX_LEDGER_PATH = path.join(path.dirname(options.env.VIDEO_PUBLISHER_CONFIG), 'draftbox-ledger.json');
    }
    if (!options?.env?.VIDEO_PUBLISHER_V2_EGO_COMMAND) {
      env.VIDEO_PUBLISHER_V2_EGO_COMMAND = path.join(DIR, "mock-ego-cleanup.mjs");
    }
    const child = spawn(command, args, { ...options, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout="",stderr="";
    child.stdout.on("data",chunk=>{stdout+=chunk}); child.stderr.on("data",chunk=>{stderr+=chunk});
    child.on("error",reject); child.on("close",code=>resolve({code,stdout,stderr}));
  });
}

function box(type, payload) {
  const buffer = Buffer.alloc(8 + payload.length);
  buffer.writeUInt32BE(buffer.length, 0);
  buffer.write(type, 4, "ascii");
  payload.copy(buffer, 8);
  return buffer;
}

function mp4WithDuration(durationSeconds, timescale = 1000) {
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(Math.round(durationSeconds * timescale), 16);
  return Buffer.concat([box("ftyp", Buffer.alloc(4)), box("moov", box("mvhd", payload))]);
}

function pngHeader(width, height, marker = 0) {
  const buffer = Buffer.alloc(25);
  buffer[0] = 0x89;
  buffer.write("PNG", 1, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = marker;
  return buffer;
}

test('update-tags revises the same ready browser job, disables uploads and is replayable', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'video-publisher-tags-'));
  try {
    const videoPath = path.join(root, 'video.mp4');
    const packagePath = path.join(root, 'old.json');
    const nextPath = path.join(root, 'new.json');
    const log = path.join(root, 'events.ndjson');
    const configPath = path.join(root, 'config.json');
    await fs.promises.writeFile(videoPath, mp4WithDuration(30));
    await fs.promises.writeFile(configPath, JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:root,availablePlatforms:['bilibili','wechat_channels'],defaultPlatforms:['bilibili','wechat_channels'],declarations:{originalityPolicy:'all_videos_original'}}));
    const old = {videoPath,title:'Same title',tags:['old'],bilibiliDescription:'Exact prose',wechatDescription:'Exact prose\n\n#old',cover:{uploadCustomCover:false}};
    const next = {...old,tags:['skill','口播剪辑'],wechatDescription:'Exact prose\n\n#skill #口播剪辑'};
    await fs.promises.writeFile(packagePath, JSON.stringify(old));
    await fs.promises.writeFile(nextPath, JSON.stringify(next));
    const env = {VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,'mock-runner.mjs'),VIDEO_PUBLISHER_V2_MOCK_LOG:log};
    const common = [path.join(V2_DIR,'publisher.mjs'),'--job-id','tags-job','--state-root',root,'--no-cleanup-stale-spaces'];
    const first = await run(process.execPath,[...common,'--package',packagePath],{env});
    assert.equal(first.code,0,first.stderr);
    const prior = JSON.parse(await fs.promises.readFile(path.join(root,'tags-job','state.json')));
    await fs.promises.writeFile(log,'');
    const update = [...common,'--package',nextPath,'--operation','update-tags','--confirm-tag-change'];
    const revised = await run(process.execPath,update,{env});
    assert.equal(revised.code,0,revised.stderr);
    const current = JSON.parse(await fs.promises.readFile(path.join(root,'tags-job','state.json')));
    assert.notEqual(current.fingerprint,prior.fingerprint);
    assert.equal(current.tagRevision.previousFingerprint,prior.fingerprint);
    for (const platform of ['bilibili','wechat_channels']) {
      assert.equal(current.platforms[platform].taskSpaceId,prior.platforms[platform].taskSpaceId);
      assert.equal(current.tagRevision.sources[platform].sourceDraftId,'draft-test');
    }
    const events = (await fs.promises.readFile(log,'utf8')).trim().split('\n').map(JSON.parse).filter(e=>e.event==='start');
    assert.ok(events.every(e=>!['upload','upload_start','quarantine','prefill'].includes(e.phase)));
    assert.ok(events.every(e=>e.noUpload==='1' && e.tagRevision.sourceDraftId==='draft-test' && e.journalPath.includes(`.tags-${current.fingerprint}.`)));
    const replay = await run(process.execPath,update,{env});
    assert.equal(replay.code,0,replay.stderr);
    assert.equal(JSON.parse(await fs.promises.readFile(path.join(root,'tags-job','state.json'))).revisions.filter(r=>r.operation==='update-tags').length,1);
    const rejectedPath = path.join(root,'bad.json');
    await fs.promises.writeFile(rejectedPath,JSON.stringify({...next,title:'Unapproved replacement'}));
    await fs.promises.writeFile(log,'');
    const bad = await run(process.execPath,[...common,'--package',rejectedPath,'--operation','update-tags','--confirm-tag-change'],{env});
    assert.notEqual(bad.code,0);
    assert.match(bad.stderr,/(?:title|platformTitle) must stay unchanged/);
    assert.equal(await fs.promises.readFile(log,'utf8'),'');
  } finally { await fs.promises.rm(root,{recursive:true,force:true}); }
});

test('a partial Bilibili tag source retains its no-upload guard and journal in a mixed-platform inspection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-publisher-partial-tags-'));
  try {
    const videoPath = path.join(root, 'video.mp4'), packagePath = path.join(root, 'package.json');
    const configPath = path.join(root, 'config.json'), log = path.join(root, 'events.ndjson');
    fs.writeFileSync(videoPath, mp4WithDuration(30));
    fs.writeFileSync(packagePath, JSON.stringify({ videoPath, title: 'Title', tags: ['approved'],
      bilibiliDescription: 'Exact prose', wechatDescription: 'Exact prose\n\n#approved', cover: { uploadCustomCover: false } }));
    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, onboarding: { completed: true }, sourceDirectory: root,
      availablePlatforms: ['bilibili', 'wechat_channels'], defaultPlatforms: ['bilibili', 'wechat_channels'],
      declarations: { originalityPolicy: 'all_videos_original' } }));
    const env = { VIDEO_PUBLISHER_CONFIG: configPath, VIDEO_PUBLISHER_V2_RUNNER: path.join(DIR, 'mock-runner.mjs'), VIDEO_PUBLISHER_V2_MOCK_LOG: log };
    const common = [path.join(V2_DIR, 'publisher.mjs'), '--package', packagePath, '--job-id', 'partial-tags', '--state-root', root, '--no-cleanup-stale-spaces'];
    const first = await run(process.execPath, common, { env });
    assert.equal(first.code, 0, first.stderr);
    const statePath = path.join(root, 'partial-tags', 'state.json'), state = JSON.parse(fs.readFileSync(statePath));
    state.tagRevision = { previousFingerprint: 'a'.repeat(64), nextFingerprint: state.fingerprint,
      sources: { bilibili: { sourceDraftId: 'draft-test', sourcePersistedDraft: {} } } };
    fs.writeFileSync(statePath, JSON.stringify(state)); fs.writeFileSync(log, '');
    const inspected = await run(process.execPath, [...common, '--inspect-only'], { env });
    assert.equal(inspected.code, 0, inspected.stderr);
    const events = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.event === 'start');
    const bili = events.find(entry => entry.platform === 'bilibili'), wechat = events.find(entry => entry.platform === 'wechat_channels');
    assert.equal(bili.noUpload, '1');
    assert.ok(bili.journalPath.includes(`.tags-${state.fingerprint}.draft-save.json`));
    assert.equal(wechat.noUpload, '');
    assert.equal(wechat.tagRevision, null);
    assert.equal(wechat.journalPath, '');
    assert.ok(events.every(entry => entry.phase === 'inspect'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resuming one platform keeps unfinished siblings resumable", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-subset-resume-"));
  try {
    const videoPath = path.join(root, "video.mp4");
    const packagePath = path.join(root, "package.json");
    const configPath = path.join(root, "config.json");
    const statePath = path.join(root, "subset-job", "state.json");
    await fs.promises.writeFile(videoPath, mp4WithDuration(30));
    await fs.promises.writeFile(packagePath, JSON.stringify({ videoPath, title: "子集恢复", tags: ["测试"] }));
    await fs.promises.writeFile(configPath, JSON.stringify({
      schemaVersion: 2, onboarding: { completed: true }, sourceDirectory: root,
      availablePlatforms: ["xiaohongshu", "douyin"], defaultPlatforms: ["xiaohongshu", "douyin"],
      declarations: { originalityPolicy: "all_videos_original" },
    }));
    const env = {
      ...process.env, VIDEO_PUBLISHER_CONFIG: configPath,
      VIDEO_PUBLISHER_V2_RUNNER: path.join(DIR, "mock-runner.mjs"),
    };
    const base = [path.join(V2_DIR, "publisher.mjs"), "--package", packagePath,
      "--job-id", "subset-job", "--state-root", root, "--no-cleanup-stale-spaces"];
    const blocker = { code: "AUTH_REQUIRED", requiresUser: true };
    const first = await run(process.execPath, [...base, "--platforms", "xiaohongshu,douyin"], {
      env: { ...env, VIDEO_PUBLISHER_V2_MOCK_BLOCKERS: JSON.stringify({ "xiaohongshu:inspect": blocker, "douyin:inspect": blocker }) },
    });
    assert.equal(first.code, 10, first.stderr);
    const second = await run(process.execPath, [...base, "--platform", "xiaohongshu", "--operation", "resume"], { env });
    assert.equal(second.code, 0, second.stderr);
    const partial = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
    assert.equal(partial.platforms.xiaohongshu.verdict.ready, true);
    assert.equal(partial.platforms.douyin.verdict.ready, false);
    assert.equal(partial.status, "blocked", "单平台完成不能将整个 Job 标为 READY");
    const third = await run(process.execPath, [...base, "--platform", "douyin", "--operation", "resume"], { env });
    assert.equal(third.code, 0, third.stderr);
    assert.equal(JSON.parse(await fs.promises.readFile(statePath, "utf8")).status, "ready");
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("publisher prefills Douyin metadata before waiting for upload completion", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-douyin-prefill-test-"));
  const log=path.join(root,"events.ndjson");
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  await fs.promises.writeFile(videoPath,mp4WithDuration(30));
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:root,availablePlatforms:["douyin"],defaultPlatforms:["douyin"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Early prefill",douyinDescription:"Fill while uploading.",douyinTopics:["Test"],cover:{uploadCustomCover:false}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"douyin-prefill","douyin","--state-root",root],{env:{
    ...process.env,
    VIDEO_PUBLISHER_CONFIG:configPath,
    VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),
    VIDEO_PUBLISHER_V2_MOCK_LOG:log,
    VIDEO_PUBLISHER_V2_MOCK_DELAYS:JSON.stringify({"douyin:upload_start":10,"douyin:prefill":20,"douyin:upload":120}),
  }});
  assert.equal(result.code,0,`${result.stderr}\n${result.stdout}`);
  const events=(await fs.promises.readFile(log,"utf8")).trim().split(/\n/).map(line=>JSON.parse(line));
  assert.deepEqual(events.filter(item=>item.event==="start").map(item=>item.phase),["inspect","upload_start","prefill","upload","mutate","persist","verify"]);
  const prefillEnd=events.find(item=>item.phase==="prefill"&&item.event==="end").at;
  const completionWaitStart=events.find(item=>item.phase==="upload"&&item.event==="start").at;
  const finalMutationStart=events.find(item=>item.phase==="mutate"&&item.event==="start").at;
  const completionWaitEnd=events.find(item=>item.phase==="upload"&&item.event==="end").at;
  assert.ok(prefillEnd<=completionWaitStart,{prefillEnd,completionWaitStart});
  assert.ok(finalMutationStart>=completionWaitEnd,{finalMutationStart,completionWaitEnd});
  assert.equal(JSON.parse(result.stdout).ready,true);
});

test("publisher routes YouTube without browser prefill and verifies private upload persistence", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-publisher-v2-youtube-prefill-test-"));
  const log = path.join(root, "events.ndjson");
  const videoPath = path.join(root, "sample-video.mp4");
  const packagePath = path.join(root, "package.json");
  const configPath = path.join(root, "config.json");
  await fs.promises.writeFile(videoPath, mp4WithDuration(30));
  await fs.promises.writeFile(configPath, JSON.stringify({
    schemaVersion: 2,
    onboarding: { completed: true },
    sourceDirectory: root,
    availablePlatforms: ["youtube"],
    defaultPlatforms: ["youtube"],
    declarations: { originalityPolicy: "ask_each_run" },
    platforms: { youtube: { defaultVisibility: "private" } },
    execution: { checkConcurrency: 1, uploadConcurrency: 1 },
  }));
  await fs.promises.writeFile(packagePath, JSON.stringify({
    videoPath,
    title: "YouTube prefill",
    youtubeDescription: "Fill details while uploading.",
    youtubeTags: ["DeepSeek", "Codex"],
    youtubeAudience: "not_made_for_kids",
    youtubeVisibility: "private",
    cover: { uploadCustomCover: false },
  }));
  const result = await run(process.execPath, [
    path.join(V2_DIR, "publisher.mjs"),
    packagePath,
    "youtube-prefill",
    "youtube",
    "--state-root", root,
  ], {
    env: {
      ...process.env,
      VIDEO_PUBLISHER_CONFIG: configPath,
      VIDEO_PUBLISHER_V2_RUNNER: path.join(DIR, "mock-runner.mjs"),
      VIDEO_PUBLISHER_V2_MOCK_LOG: log,
      VIDEO_PUBLISHER_V2_MOCK_DELAYS: JSON.stringify({
        "youtube:upload_start": 10,
        "youtube:prefill": 20,
        "youtube:upload": 100,
      }),
    },
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const events = (await fs.promises.readFile(log, "utf8")).trim().split(/\n/).map(line => JSON.parse(line));
  assert.deepEqual(events.filter(item => item.event === "start").map(item => item.phase), [
    "inspect", "upload", "mutate", "persist", "verify",
  ]);
  assert.equal(JSON.parse(result.stdout).platforms.youtube.ready, true);
});

test("publisher uses upload-time prefill for Xiaohongshu, Bilibili, and WeChat Channels", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-early-prefill-platforms-test-"));
  const log=path.join(root,"events.ndjson");
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  await fs.promises.writeFile(videoPath,mp4WithDuration(30));
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:root,availablePlatforms:["xiaohongshu","bilibili","wechat_channels"],defaultPlatforms:["xiaohongshu","bilibili","wechat_channels"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:3,uploadConcurrency:3}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Early metadata",xhsTopics:["Test"],bilibiliDescription:"Complete after upload.",bilibiliTags:["Test"],wechatDescription:"Early metadata\n\n#Test",wechatTags:["Test"],cover:{uploadCustomCover:false}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"early-prefill-platforms","xiaohongshu","bilibili","wechat_channels","--state-root",root],{env:{
    ...process.env,
    VIDEO_PUBLISHER_CONFIG:configPath,
    VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),
    VIDEO_PUBLISHER_V2_MOCK_LOG:log,
    VIDEO_PUBLISHER_V2_MOCK_DELAYS:JSON.stringify({"xiaohongshu:upload":40,"bilibili:upload":40,"wechat_channels:upload":40}),
  }});
  assert.equal(result.code,0,`${result.stderr}\n${result.stdout}`);
  const events=(await fs.promises.readFile(log,"utf8")).trim().split(/\n/).map(line=>JSON.parse(line));
  for(const platform of ["xiaohongshu","bilibili","wechat_channels"]){
    const phases=events.filter(item=>item.platform===platform&&item.event==="start").map(item=>item.phase);
    assert.deepEqual(phases,["inspect","upload_start","prefill","upload","mutate","persist","verify", ...(platform === 'xiaohongshu' ? ['park'] : [])]);
    const prefillEnd=events.find(item=>item.platform===platform&&item.phase==="prefill"&&item.event==="end").at;
    const uploadStart=events.find(item=>item.platform===platform&&item.phase==="upload"&&item.event==="start").at;
    assert.ok(prefillEnd<=uploadStart,{platform,prefillEnd,uploadStart});
  }
});

test("publisher defers a retryable prefill failure until upload completion", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-prefill-defer-test-"));
  const log=path.join(root,"events.ndjson");
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  await fs.promises.writeFile(videoPath,mp4WithDuration(30));
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:root,availablePlatforms:["bilibili"],defaultPlatforms:["bilibili"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Deferred prefill",bilibiliDescription:"Deferred prefill",bilibiliTags:["Test"],cover:{uploadCustomCover:false}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"prefill-defer","bilibili","--state-root",root],{env:{
    ...process.env,
    VIDEO_PUBLISHER_CONFIG:configPath,
    VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),
    VIDEO_PUBLISHER_V2_MOCK_LOG:log,
    VIDEO_PUBLISHER_V2_MOCK_BLOCKERS:JSON.stringify({"bilibili:prefill":{code:"PLATFORM_REJECTED_METADATA",message:"tag not stable yet",retryable:true,requiresUser:false}}),
  }});
  assert.equal(result.code,0,`${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr,/prefill deferred until upload completion/);
  const phases=(await fs.promises.readFile(log,"utf8")).trim().split(/\n/).map(line=>JSON.parse(line)).filter(item=>item.event==="start").map(item=>item.phase);
  assert.deepEqual(phases,["inspect","upload_start","prefill","upload","mutate","persist","verify"]);
});

test("publisher advances to final mutation when a retryable prefill failure observes upload completion", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-prefill-completed-test-"));
  const log=path.join(root,"events.ndjson");
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  await fs.promises.writeFile(videoPath,mp4WithDuration(30));
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:root,availablePlatforms:["bilibili"],defaultPlatforms:["bilibili"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Completed during prefill",bilibiliDescription:"Complete after prefill.",bilibiliTags:["Test"],cover:{uploadCustomCover:false}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"prefill-completed","bilibili","--state-root",root],{env:{
    ...process.env,
    VIDEO_PUBLISHER_CONFIG:configPath,
    VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),
    VIDEO_PUBLISHER_V2_MOCK_LOG:log,
    VIDEO_PUBLISHER_V2_MOCK_BLOCKERS:JSON.stringify({"bilibili:prefill":{code:"ACTION_FAILED",message:"tag input lost focus",retryable:true,requiresUser:false,mockVideoComplete:true}}),
  }});
  assert.equal(result.code,0,`${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr,/prefill deferred to final mutation after upload completed/);
  const phases=(await fs.promises.readFile(log,"utf8")).trim().split(/\n/).map(line=>JSON.parse(line)).filter(item=>item.event==="start").map(item=>item.phase);
  assert.deepEqual(phases,["inspect","upload_start","prefill","mutate","persist","verify"]);
  assert.equal(JSON.parse(result.stdout).platforms.bilibili.ready,true);
});

test("publisher advances a successful platform before a slow blocked upload exits", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-test-"));
  const log=path.join(root,"events.ndjson");
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  await fs.promises.writeFile(videoPath,mp4WithDuration(30));
  await fs.promises.writeFile(configPath,JSON.stringify({
    schemaVersion:1,
    onboarding:{completed:true},
    sourceDirectory:root,
    defaultPlatforms:["xiaohongshu","douyin"]
  }));
  await fs.promises.writeFile(packagePath,JSON.stringify({
    videoPath,
    title:"Automation test",
    douyinTopics:["Automation","Tutorial"],
    bilibiliDescription:"Generic orchestration test.",
    bilibiliTags:["Automation","Tutorial"],
    xhsTopics:["Automation","Tutorial"],
    wechatDescription:"Automation test\n\n#Automation #Tutorial",
    wechatTags:["Automation","Tutorial"],
    cover:{uploadCustomCover:false}
  }));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"test","xiaohongshu","douyin","--confirm-original-rights","--state-root",root],{env:{
    ...process.env,
    VIDEO_PUBLISHER_CONFIG:configPath,
    VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),
    VIDEO_PUBLISHER_V2_MOCK_LOG:log,
    // Leave room for several real Node process launches under full-suite CPU load.
    // A scheduler that awaits the entire upload pool still fails the ordering assertion.
    VIDEO_PUBLISHER_V2_MOCK_DELAYS:JSON.stringify({"xiaohongshu:upload":10,"douyin:upload":800}),
    VIDEO_PUBLISHER_V2_MOCK_BLOCKERS:JSON.stringify({"douyin:upload":{code:"UPLOAD_STALLED",message:"mock stalled upload",retryable:true,requiresUser:false}}),
  }});
  assert.equal(result.code,10,`${result.stderr}\n${result.stdout}`);
  const events=(await fs.promises.readFile(log,"utf8")).trim().split(/\n/).map(line=>JSON.parse(line));
  const blockedUploadEnd=events.find(item=>item.platform==="douyin"&&item.phase==="upload"&&item.event==="end").at;
  const successfulMutationStart=events.find(item=>item.platform==="xiaohongshu"&&item.phase==="mutate"&&item.event==="start").at;
  assert.ok(successfulMutationStart<blockedUploadEnd,JSON.stringify({successfulMutationStart,blockedUploadEnd}));
  assert.equal(events.some(item=>item.platform==="douyin"&&["mutate","verify"].includes(item.phase)),false,"the blocked platform must be frozen after its typed blocker");
  const summary=JSON.parse(result.stdout);
  assert.equal(summary.ready,false);
  assert.equal(summary.platforms.xiaohongshu.ready,true);
  assert.equal(summary.platforms.douyin.blocker.code,"UPLOAD_STALLED");
  assert.equal(summary.scheduler.uiConcurrency,1);
});

test("publisher isolates authentication failure to one platform", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-auth-isolation-test-"));
  const log=path.join(root,"events.ndjson");
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  await fs.promises.writeFile(videoPath,mp4WithDuration(30));
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:root,availablePlatforms:["xiaohongshu","douyin"],defaultPlatforms:["xiaohongshu","douyin"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:2,uploadConcurrency:2}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Auth isolation",xhsTopics:["Test"],douyinTopics:["Test"],cover:{uploadCustomCover:false}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"auth-isolation","xiaohongshu","douyin","--state-root",root],{env:{
    ...process.env,
    VIDEO_PUBLISHER_CONFIG:configPath,
    VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),
    VIDEO_PUBLISHER_V2_MOCK_LOG:log,
    VIDEO_PUBLISHER_V2_MOCK_BLOCKERS:JSON.stringify({"douyin:inspect":{code:"AUTH_REQUIRED",message:"mock login required",retryable:false,requiresUser:true}}),
  }});
  assert.equal(result.code,10,`${result.stderr}\n${result.stdout}`);
  const summary=JSON.parse(result.stdout);
  assert.equal(summary.status,"blocked");
  assert.equal(summary.platforms.xiaohongshu.ready,true);
  assert.equal(summary.platforms.douyin.blocker.code,"AUTH_REQUIRED");
  const events=(await fs.promises.readFile(log,"utf8")).trim().split(/\n/).map(line=>JSON.parse(line));
  assert.deepEqual(events.filter(item=>item.platform==="douyin").map(item=>item.phase),["inspect","inspect"]);
});

test("publisher keeps explicit user control as a global stop", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-user-control-test-"));
  const log=path.join(root,"events.ndjson");
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  await fs.promises.writeFile(videoPath,mp4WithDuration(30));
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:root,availablePlatforms:["xiaohongshu","douyin"],defaultPlatforms:["xiaohongshu","douyin"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:2,uploadConcurrency:2}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"User control stop",xhsTopics:["Test"],douyinTopics:["Test"],cover:{uploadCustomCover:false}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"user-control","xiaohongshu","douyin","--state-root",root],{env:{
    ...process.env,
    VIDEO_PUBLISHER_CONFIG:configPath,
    VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),
    VIDEO_PUBLISHER_V2_MOCK_LOG:log,
    VIDEO_PUBLISHER_V2_MOCK_BLOCKERS:JSON.stringify({"douyin:inspect":{code:"USER_CONTROL",message:"mock user takeover",retryable:false,requiresUser:true}}),
  }});
  assert.equal(result.code,10,`${result.stderr}\n${result.stdout}`);
  const summary=JSON.parse(result.stdout);
  assert.equal(summary.status,"paused_user");
  const events=(await fs.promises.readFile(log,"utf8")).trim().split(/\n/).map(line=>JSON.parse(line));
  assert.equal(events.some(item=>item.phase!=="inspect"),false,"no browser phase may start after explicit user control");
});

test("publisher circuit-breaks all UI mutation after an upload loses Ego", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-channel-break-test-"));
  const log=path.join(root,"events.ndjson");
  const cleanupLog=path.join(root,"cleanup.log");
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  await fs.promises.writeFile(videoPath,mp4WithDuration(30));
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu","douyin"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:2,uploadConcurrency:2}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Circuit breaker",xhsTopics:["Test"],douyinTopics:["Test"],cover:{uploadCustomCover:false}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"channel-break","xiaohongshu","douyin","--state-root",root],{env:{...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),VIDEO_PUBLISHER_V2_MOCK_LOG:log,VIDEO_PUBLISHER_V2_CLEANUP_LOG:cleanupLog,VIDEO_PUBLISHER_V2_MOCK_BROKEN_CHANNEL:"douyin:upload",VIDEO_PUBLISHER_V2_MOCK_DELAYS:JSON.stringify({"douyin:upload_start":1,"douyin:prefill":1,"douyin:upload":1,"xiaohongshu:upload":150})}});
  assert.equal(result.code,10,`${result.stderr}\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout).platforms.xiaohongshu.parked, false, 'shared channel failure must not claim an editor-only XHS delivery');
  assert.match(result.stderr,/input channel broken; final verify parallel=2/);
  const events=(await fs.promises.readFile(log,"utf8")).trim().split(/\n/).map(line=>JSON.parse(line));
  assert.equal(events.some(item=>item.phase==="mutate"),false,"a sibling that is not yet eligible must not start mutation after a shared Ego channel failure");
  assert.equal(events.filter(item=>item.phase==="verify"&&item.event==="start").length,2,"read-only final verification still records page truth");
  assert.equal(fs.existsSync(cleanupLog),false,"共享输入通道失败后不能继续关闭浏览器空间");
});

test("publisher stops the serial UI queue when a mutator loses Ego", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-mutation-break-test-"));
  const log=path.join(root,"events.ndjson");
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  await fs.promises.writeFile(videoPath,mp4WithDuration(30));
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu","douyin","bilibili","wechat_channels"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:4,uploadConcurrency:4}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Mutation break",xhsTopics:["Test"],douyinTopics:["Test"],bilibiliDescription:"Mutation circuit breaker",bilibiliTags:["Test"],wechatDescription:"Mutation circuit breaker\n\n#Test",wechatTags:["Test"],cover:{uploadCustomCover:false}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"mutation-break","xiaohongshu","douyin","bilibili","wechat_channels","--state-root",root],{env:{...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),VIDEO_PUBLISHER_V2_MOCK_LOG:log,VIDEO_PUBLISHER_V2_MOCK_BROKEN_CHANNEL:"douyin:mutate",VIDEO_PUBLISHER_V2_MOCK_DELAYS:JSON.stringify({"xiaohongshu:upload":1,"douyin:upload_start":1,"douyin:prefill":1,"douyin:upload":40,"bilibili:upload":200,"wechat_channels:upload":250})}});
  assert.equal(result.code,10,`${result.stderr}\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout).platforms.xiaohongshu.parked, false);
  const events=(await fs.promises.readFile(log,"utf8")).trim().split(/\n/).map(line=>JSON.parse(line));
  const mutationStarts=events.filter(item=>item.phase==="mutate"&&item.event==="start").map(item=>item.platform);
  assert.equal(mutationStarts.includes("douyin"),true,"the configured broken mutator must start");
  assert.equal(mutationStarts.some(platform=>["bilibili","wechat_channels"].includes(platform)),false,"platforms queued after the broken mutator must never start UI mutation");
  assert.equal(events.some(item=>item.platform==="xiaohongshu"&&item.phase==="prefill"),true,"safe upload-time prefill may finish before the later shared-channel failure");
  assert.equal(events.filter(item=>item.phase==="verify"&&item.event==="start").length,4,"final read-only verification still records every platform");
});

test("publisher blocks browser work when onboarding is incomplete", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-onboarding-test-"));
  const configPath=path.join(root,"config.json");
  await fs.promises.writeFile(configPath,"{}");
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),path.join(root,"missing-package.json")],{env:{...process.env,VIDEO_PUBLISHER_CONFIG:configPath}});
  assert.equal(result.code,1);
  assert.match(result.stderr,/onboarding is incomplete/);
});

test("inspect-only returns blocked when the Ego input channel is unavailable", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-inspect-blocked-test-"));
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  await fs.promises.writeFile(videoPath,"test video fixture");
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Inspect blocker",xhsTopics:["Test"],cover:{uploadCustomCover:false}}));
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:root,availablePlatforms:["xiaohongshu"],defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"inspect-blocked","xiaohongshu","--inspect-only","--state-root",root],{env:{...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),VIDEO_PUBLISHER_V2_MOCK_BROKEN_CHANNEL:"xiaohongshu:inspect"}});
  assert.equal(result.code,10,`${result.stderr}\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout).status,"blocked");
});

test("publisher rejects a job id that can escape the state root", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-job-id-test-"));
  const configPath=path.join(root,"config.json");
  const escapeName=`escape-${path.basename(root)}`;
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:root,availablePlatforms:["xiaohongshu"],defaultPlatforms:["xiaohongshu"]}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),path.join(root,"missing.json"),"--job-id",`../${escapeName}`],{env:{...process.env,VIDEO_PUBLISHER_CONFIG:configPath}});
  assert.equal(result.code,2);
  assert.match(result.stderr,/--job-id must be/);
  assert.equal(fs.existsSync(path.join(path.dirname(root),escapeName)),false);
});

test("publisher rejects platforms that were not configured as available", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-platform-availability-test-"));
  const configPath=path.join(root,"config.json");
  const log=path.join(root,"events.ndjson");
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:root,availablePlatforms:["xiaohongshu"],defaultPlatforms:["xiaohongshu"]}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),path.join(root,"missing-package.json"),"availability-test","douyin"],{env:{...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_MOCK_LOG:log}});
  assert.equal(result.code,2);
  assert.match(result.stderr,/Platform is not configured as available: douyin/);
  assert.equal(fs.existsSync(log),false,"unavailable platforms must be rejected before browser work");
  await fs.promises.rm(root,{recursive:true,force:true});
});

test("publisher allows an available non-default platform when explicitly selected", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-platform-override-test-"));
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  const log=path.join(root,"events.ndjson");
  await fs.promises.writeFile(videoPath,mp4WithDuration(30));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Availability override",douyinTopics:["Test"],cover:{uploadCustomCover:false}}));
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:root,availablePlatforms:["xiaohongshu","douyin"],defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:2,uploadConcurrency:2}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"availability-override","douyin","--state-root",root],{env:{...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),VIDEO_PUBLISHER_V2_MOCK_LOG:log}});
  assert.equal(result.code,0,`${result.stderr}\n${result.stdout}`);
  const events=(await fs.promises.readFile(log,"utf8")).trim().split(/\n/).map(line=>JSON.parse(line));
  assert.deepEqual(new Set(events.map(item=>item.platform)),new Set(["douyin"]));
  await fs.promises.rm(root,{recursive:true,force:true});
});

test("publisher requires current-run confirmation when onboarding policy asks each run", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-rights-test-"));
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  const log=path.join(root,"events.ndjson");
  await fs.promises.writeFile(videoPath,"test video fixture");
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu"],execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Rights test",xhsTopics:["Test"],cover:{uploadCustomCover:false}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"xiaohongshu"],{env:{...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),VIDEO_PUBLISHER_V2_MOCK_LOG:log}});
  assert.equal(result.code,2);
  assert.match(result.stderr,/Originality confirmation is required/);
  assert.equal(fs.existsSync(log),false,"browser runner must not start without current-run rights confirmation");
});

test("publisher accepts onboarded all-videos-original policy without a one-run flag", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-standing-rights-test-"));
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  const log=path.join(root,"events.ndjson");
  await fs.promises.writeFile(videoPath,"test video fixture");
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Standing rights test",xhsTopics:["Test"],cover:{uploadCustomCover:false}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"xiaohongshu","--state-root",root],{env:{...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),VIDEO_PUBLISHER_V2_MOCK_LOG:log}});
  assert.equal(result.code,0,`${result.stderr}\n${result.stdout}`);
  assert.equal(fs.existsSync(log),true,"browser runner should start under the standing originality policy");
  assert.equal(JSON.parse(result.stdout).ready,true);
});

test("publisher accepts verified long-form Douyin video before browser work", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-duration-test-"));
  const videoPath=path.join(root,"too-long.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  const log=path.join(root,"events.ndjson");
  await fs.promises.writeFile(videoPath,mp4WithDuration(901));
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["douyin"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Duration test",douyinTopics:["Test"],cover:{uploadCustomCover:false}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"duration-test","douyin","--state-root",root],{env:{...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),VIDEO_PUBLISHER_V2_MOCK_LOG:log}});
  assert.equal(result.code,0,`${result.stderr}\n${result.stdout}`);
  assert.equal(fs.existsSync(log),true,"browser runner should start for verified long-form media");
});

test("publisher prepares verified long-form media for Douyin and eligible sibling platforms", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-partial-preflight-test-"));
  const videoPath=path.join(root,"too-long-for-douyin.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  const log=path.join(root,"events.ndjson");
  await fs.promises.writeFile(videoPath,mp4WithDuration(901));
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu","douyin"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:2,uploadConcurrency:2}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Partial preflight",xhsTopics:["Test"],douyinTopics:["Test"],cover:{uploadCustomCover:false}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"partial-preflight","xiaohongshu","douyin","--state-root",root],{env:{...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),VIDEO_PUBLISHER_V2_MOCK_LOG:log}});
  assert.equal(result.code,0,`${result.stderr}\n${result.stdout}`);
  const summary=JSON.parse(result.stdout);
  assert.equal(summary.platforms.xiaohongshu.ready,true);
  assert.equal(summary.platforms.douyin.ready,true);
  const events=(await fs.promises.readFile(log,"utf8")).trim().split(/\n/).map(line=>JSON.parse(line));
  assert.deepEqual(new Set(events.map(item=>item.platform)),new Set(["xiaohongshu","douyin"]));
});

test("publisher invalidates receipts and checkpoints when Ego recreates a task space", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-task-recreate-test-"));
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  const jobId="task-recreate-job";
  await fs.promises.writeFile(videoPath,"test video fixture");
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Task recreate",xhsTopics:["Test"],cover:{uploadCustomCover:false}}));
  const args=[path.join(V2_DIR,"publisher.mjs"),packagePath,"task-recreate","xiaohongshu","--job-id",jobId,"--state-root",root];
  const baseEnv={...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs")};
  const first=await run(process.execPath,args,{env:baseEnv});
  assert.equal(first.code,0,`${first.stderr}\n${first.stdout}`);
  const statePath=path.join(root,jobId,"state.json");
  const state=JSON.parse(await fs.promises.readFile(statePath,"utf8"));
  state.platforms.xiaohongshu.receipts.legacyOnly={stale:true};
  state.platforms.xiaohongshu.receiptTaskSpaceId=11;
  await fs.promises.writeFile(statePath,JSON.stringify(state,null,2));
  const checkpointPath=path.join(root,jobId,"checkpoints","xiaohongshu.receipts.json");
  await fs.promises.writeFile(checkpointPath,JSON.stringify({schemaVersion:2,platform:"xiaohongshu",fingerprint:state.fingerprint,taskSpaceId:11,receipts:{legacyOnly:{stale:true}}}));
  state.status="running";
  await fs.promises.writeFile(statePath,JSON.stringify(state,null,2));
  const second=await run(process.execPath,args,{env:{...baseEnv,VIDEO_PUBLISHER_V2_MOCK_TASK_SPACE_ID:"99"}});
  assert.equal(second.code,0,`${second.stderr}\n${second.stdout}`);
  const recovered=JSON.parse(await fs.promises.readFile(statePath,"utf8"));
  assert.equal(recovered.platforms.xiaohongshu.taskSpaceId,99);
  assert.equal(recovered.platforms.xiaohongshu.receiptTaskSpaceId,99);
  assert.equal(recovered.platforms.xiaohongshu.receipts.cover.taskSpaceId,99);
  assert.equal(recovered.platforms.xiaohongshu.receipts.legacyOnly,undefined);
  assert.equal(fs.existsSync(checkpointPath),false);

  recovered.platforms.xiaohongshu.receipts.legacyOnly={stale:true};
  recovered.status="running";
  await fs.promises.writeFile(statePath,JSON.stringify(recovered,null,2));
  await fs.promises.writeFile(checkpointPath,JSON.stringify({schemaVersion:2,platform:"xiaohongshu",fingerprint:recovered.fingerprint,taskSpaceId:99,receipts:{legacyOnly:{stale:true}}}));
  const recycled=await run(process.execPath,args,{env:{...baseEnv,VIDEO_PUBLISHER_V2_MOCK_TASK_SPACE_ID:"99",VIDEO_PUBLISHER_V2_MOCK_TASK_SPACE_RECREATED:"1"}});
  assert.equal(recycled.code,0,`${recycled.stderr}\n${recycled.stdout}`);
  const recycledState=JSON.parse(await fs.promises.readFile(statePath,"utf8"));
  assert.equal(recycledState.platforms.xiaohongshu.taskSpaceId,99);
  assert.equal(recycledState.platforms.xiaohongshu.receipts.legacyOnly,undefined,"a recreated space must invalidate receipts even when Ego reuses the same numeric id");
  assert.equal(fs.existsSync(checkpointPath),false);
});

test("publisher refuses an implicit duplicate after READY", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-task-name-test-"));
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  const jobId="stable-task-name-job";
  await fs.promises.writeFile(videoPath,"test video fixture");
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Stable task name",xhsTopics:["Test"],cover:{uploadCustomCover:false}}));
  const base=[path.join(V2_DIR,"publisher.mjs"),packagePath];
  const tail=["xiaohongshu","--job-id",jobId,"--state-root",root];
  const env={...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs")};
  const first=await run(process.execPath,[...base,"original-suffix",...tail],{env});
  assert.equal(first.code,0,`${first.stderr}\n${first.stdout}`);
  const statePath=path.join(root,jobId,"state.json");
  const firstState=JSON.parse(await fs.promises.readFile(statePath,"utf8"));
  const recordedName=firstState.platforms.xiaohongshu.taskSpaceName;
  assert.match(recordedName, new RegExp(`^video publisher v2 xiaohongshu original-suffix-${jobId}-[a-z0-9]+-[a-z0-9]+$`));
  const second=await run(process.execPath,[...base,"changed-suffix",...tail],{env});
  assert.equal(second.code,2);
  assert.match(second.stderr,/already READY/);
  const unchanged=JSON.parse(await fs.promises.readFile(statePath,"utf8"));
  assert.equal(unchanged.platforms.xiaohongshu.taskSpaceName,recordedName);
  assert.equal((unchanged.retiredSpaces || []).some(item=>item.name===recordedName),false);
});

test("legacy READY without a confirmed native source cannot authorize a cover replacement", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-replace-cover-test-"));
  const videoPath=path.join(root,"sample-video.mp4");
  const firstCover=path.join(root,"cover-one.png");
  const secondCover=path.join(root,"cover-two.png");
  const firstPackage=path.join(root,"package-one.json");
  const secondPackage=path.join(root,"package-two.json");
  const configPath=path.join(root,"config.json");
  const firstLog=path.join(root,"first.ndjson");
  const replaceLog=path.join(root,"replace.ndjson");
  const jobId="replace-cover-job";
  await fs.promises.writeFile(videoPath,mp4WithDuration(30));
  await fs.promises.writeFile(firstCover,pngHeader(1080,1440,1));
  await fs.promises.writeFile(secondCover,pngHeader(1080,1440,2));
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:root,availablePlatforms:["xiaohongshu"],defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  const shared={videoPath,title:"Replace cover",xhsTopics:["Test"]};
  await fs.promises.writeFile(firstPackage,JSON.stringify({...shared,cover:{uploadCustomCover:true,vertical3x4Path:firstCover}}));
  await fs.promises.writeFile(secondPackage,JSON.stringify({...shared,cover:{uploadCustomCover:true,vertical3x4Path:firstCover,platforms:{xiaohongshu:{vertical3x4Path:secondCover}}}}));
  const env={...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs")};
  const first=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),firstPackage,"replace-cover","xiaohongshu","--job-id",jobId,"--state-root",root],{env:{...env,VIDEO_PUBLISHER_V2_MOCK_LOG:firstLog}});
  assert.equal(first.code,0,`${first.stderr}\n${first.stdout}`);
  const before=JSON.parse(await fs.promises.readFile(path.join(root,jobId,"state.json"),"utf8"));
  const beforeSpace=before.platforms.xiaohongshu.taskSpaceId;
  const beforeFingerprint=before.fingerprint;
  before.platforms.xiaohongshu.videoReceipt={fingerprint:beforeFingerprint,taskSpaceId:beforeSpace,mode:"injected",observedAt:new Date().toISOString()};
  await fs.promises.writeFile(path.join(root,jobId,"state.json"),JSON.stringify(before,null,2));
  const replaced=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),secondPackage,"replace-cover","xiaohongshu","--job-id",jobId,"--state-root",root,"--operation","replace-cover"],{env:{...env,VIDEO_PUBLISHER_V2_MOCK_LOG:replaceLog,VIDEO_PUBLISHER_V2_MOCK_EXISTING_READY:"1"}});
  assert.notEqual(replaced.code,0);
  assert.match(replaced.stderr,/confirmed original draft save/);
  assert.equal(fs.existsSync(replaceLog),false);
  const after=JSON.parse(await fs.promises.readFile(path.join(root,jobId,"state.json"),"utf8"));
  assert.equal(after.fingerprint,beforeFingerprint);
  assert.deepEqual(after.platforms.xiaohongshu,before.platforms.xiaohongshu);
  assert.equal(after.coverRevisionIntent,undefined);
});

test("replace-cover rejects metadata changes before browser work", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-replace-cover-identity-test-"));
  const videoPath=path.join(root,"sample-video.mp4");
  const firstCover=path.join(root,"cover-one.png");
  const secondCover=path.join(root,"cover-two.png");
  const firstPackage=path.join(root,"package-one.json");
  const secondPackage=path.join(root,"package-two.json");
  const configPath=path.join(root,"config.json");
  const log=path.join(root,"replace.ndjson");
  const jobId="replace-cover-identity-job";
  await fs.promises.writeFile(videoPath,mp4WithDuration(30));
  await fs.promises.writeFile(firstCover,pngHeader(1080,1440,1));
  await fs.promises.writeFile(secondCover,pngHeader(1080,1440,2));
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:root,availablePlatforms:["xiaohongshu"],defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(firstPackage,JSON.stringify({videoPath,title:"Original title",xhsTopics:["Test"],cover:{uploadCustomCover:true,vertical3x4Path:firstCover}}));
  await fs.promises.writeFile(secondPackage,JSON.stringify({videoPath,title:"Changed title",xhsTopics:["Test"],cover:{uploadCustomCover:true,vertical3x4Path:secondCover}}));
  const env={...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs")};
  const first=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),firstPackage,"replace-cover","xiaohongshu","--job-id",jobId,"--state-root",root],{env});
  assert.equal(first.code,0,`${first.stderr}\n${first.stdout}`);
  const rejected=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),secondPackage,"replace-cover","xiaohongshu","--job-id",jobId,"--state-root",root,"--replace-cover"],{env:{...env,VIDEO_PUBLISHER_V2_MOCK_LOG:log}});
  assert.notEqual(rejected.code,0);
  assert.match(rejected.stderr,/may change only cover/);
  assert.equal(fs.existsSync(log),false);
});

test("publisher recovers a missing space name from last evidence when reusing a space", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-reuse-space-test-"));
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  const jobId="reuse-task-name-job";
  await fs.promises.writeFile(videoPath,"test video fixture");
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Reuse task name",xhsTopics:["Test"],cover:{uploadCustomCover:false}}));
  const base=[path.join(V2_DIR,"publisher.mjs"),packagePath];
  const tail=["xiaohongshu","--job-id",jobId,"--state-root",root,"--reuse-space"];
  const env={...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs")};
  const first=await run(process.execPath,[...base,"original-suffix",...tail],{env});
  assert.equal(first.code,0,`${first.stderr}\n${first.stdout}`);
  const statePath=path.join(root,jobId,"state.json");
  const firstState=JSON.parse(await fs.promises.readFile(statePath,"utf8"));
  const recordedName=firstState.platforms.xiaohongshu.taskSpaceName;
  assert.equal(recordedName,`video publisher v2 xiaohongshu original-suffix-${jobId}`);
  delete firstState.platforms.xiaohongshu.taskSpaceName;
  firstState.status = "blocked";
  await fs.promises.writeFile(statePath,JSON.stringify(firstState,null,2));
  const second=await run(process.execPath,[...base,"changed-suffix",...tail],{env});
  assert.equal(second.code,0,`${second.stderr}\n${second.stdout}`);
  const recovered=JSON.parse(await fs.promises.readFile(statePath,"utf8"));
  assert.equal(recovered.platforms.xiaohongshu.taskSpaceName,recordedName,"legacy state should recover the stable name from its last evidence");
});

test("publisher keeps the recorded space when resuming an in-progress job", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-resume-space-test-"));
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  const jobId="resume-space-job";
  await fs.promises.writeFile(videoPath,"test video fixture");
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Resume space",xhsTopics:["Test"],cover:{uploadCustomCover:false}}));
  const args=[path.join(V2_DIR,"publisher.mjs"),packagePath,"resume-suffix","xiaohongshu","--job-id",jobId,"--state-root",root];
  const env={...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs")};
  const first=await run(process.execPath,args,{env});
  assert.equal(first.code,0,`${first.stderr}\n${first.stdout}`);
  const statePath=path.join(root,jobId,"state.json");
  const firstState=JSON.parse(await fs.promises.readFile(statePath,"utf8"));
  const recordedName=firstState.platforms.xiaohongshu.taskSpaceName;
  firstState.status = "running";
  await fs.promises.writeFile(statePath,JSON.stringify(firstState,null,2));
  const second=await run(process.execPath,args,{env});
  assert.equal(second.code,0,`${second.stderr}\n${second.stdout}`);
  const resumed=JSON.parse(await fs.promises.readFile(statePath,"utf8"));
  assert.equal(resumed.platforms.xiaohongshu.taskSpaceName, recordedName);
});

test("default READY run leaves the current draft space open", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-default-keep-"));
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  const jobId="default-keep-job";
  const log=path.join(root,"cleanup.log");
  await fs.promises.writeFile(videoPath,"test video fixture");
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Default keep",xhsTopics:["Test"],cover:{uploadCustomCover:false}}));
  const result=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"default-keep","xiaohongshu","--job-id",jobId,"--state-root",root],{env:{
    ...process.env,
    VIDEO_PUBLISHER_CONFIG:configPath,
    VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),
    VIDEO_PUBLISHER_V2_CLEANUP_LOG:log,
  }});
  assert.equal(result.code,0,`${result.stderr}\n${result.stdout}`);
  const state=JSON.parse(await fs.promises.readFile(path.join(root,jobId,"state.json"),"utf8"));
  assert.equal(state.keepSpace,true);
  const name=state.platforms.xiaohongshu.taskSpaceName;
  assert.ok(name);
  if (fs.existsSync(log)) {
    assert.equal(closeNamesFromLog(await fs.promises.readFile(log,"utf8")).includes(name), false);
  }
});

test("inspect-only on an in-progress job keeps the recorded space and status", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-inspect-running-"));
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  const jobId="inspect-running-job";
  const log=path.join(root,"cleanup.log");
  await fs.promises.writeFile(videoPath,"test video fixture");
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Inspect running",xhsTopics:["Test"],cover:{uploadCustomCover:false}}));
  const env={...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),VIDEO_PUBLISHER_V2_CLEANUP_LOG:log};
  const first=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"inspect-run","xiaohongshu","--job-id",jobId,"--state-root",root,"--keep-space"],{env});
  assert.equal(first.code,0,`${first.stderr}\n${first.stdout}`);
  const statePath=path.join(root,jobId,"state.json");
  const firstState=JSON.parse(await fs.promises.readFile(statePath,"utf8"));
  const recordedName=firstState.platforms.xiaohongshu.taskSpaceName;
  firstState.status="running";
  await fs.promises.writeFile(statePath,JSON.stringify(firstState,null,2));
  const inspected=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"inspect-run","xiaohongshu","--job-id",jobId,"--state-root",root,"--inspect-only"],{env});
  assert.equal(inspected.code,0,`${inspected.stderr}\n${inspected.stdout}`);
  const after=JSON.parse(await fs.promises.readFile(statePath,"utf8"));
  assert.equal(after.status,"running");
  assert.equal(after.platforms.xiaohongshu.taskSpaceName,recordedName);
  const script=await fs.promises.readFile(log,"utf8");
  assert.equal(closeNamesFromLog(script).includes(recordedName), false);
});

test("keep-space survives a later job stale sweep", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-keep-space-"));
  const configPath=path.join(root,"config.json");
  const log=path.join(root,"cleanup.log");
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  const env={...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),VIDEO_PUBLISHER_V2_CLEANUP_LOG:log};
  async function writePackage(name) {
    const videoPath=path.join(root,`${name}.mp4`);
    const packagePath=path.join(root,`${name}.json`);
    await fs.promises.writeFile(videoPath,`video ${name}`);
    await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:name,xhsTopics:["Test"],cover:{uploadCustomCover:false}}));
    return packagePath;
  }
  const firstPkg=await writePackage("keep-a");
  const secondPkg=await writePackage("keep-b");
  const first=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),firstPkg,"keep-a","xiaohongshu","--job-id","job-a","--state-root",root,"--keep-space"],{env});
  assert.equal(first.code,0,`${first.stderr}\n${first.stdout}`);
  const kept=JSON.parse(await fs.promises.readFile(path.join(root,"job-a","state.json"),"utf8"));
  assert.equal(kept.keepSpace,true);
  const keptName=kept.platforms.xiaohongshu.taskSpaceName;
  const second=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),secondPkg,"keep-b","xiaohongshu","--job-id","job-b","--state-root",root],{env});
  assert.equal(second.code,0,`${second.stderr}\n${second.stdout}`);
  const script=await fs.promises.readFile(log,"utf8");
  assert.equal(closeNamesFromLog(script).includes(keptName), false);
  assert.equal(JSON.parse(await fs.promises.readFile(path.join(root,"job-a","state.json"),"utf8")).keepSpace,true);
});

test("cleanup-only --package does not close a running job space", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-cleanup-running-"));
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  const jobId="cleanup-running-job";
  const log=path.join(root,"cleanup.log");
  await fs.promises.writeFile(videoPath,"test video fixture");
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Cleanup running",xhsTopics:["Test"],cover:{uploadCustomCover:false}}));
  const env={...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),VIDEO_PUBLISHER_V2_CLEANUP_LOG:log};
  const first=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),packagePath,"cleanup-run","xiaohongshu","--job-id",jobId,"--state-root",root,"--keep-space"],{env});
  assert.equal(first.code,0,`${first.stderr}\n${first.stdout}`);
  const statePath=path.join(root,jobId,"state.json");
  const firstState=JSON.parse(await fs.promises.readFile(statePath,"utf8"));
  const recordedName=firstState.platforms.xiaohongshu.taskSpaceName;
  firstState.status="running";
  await fs.promises.writeFile(statePath,JSON.stringify(firstState,null,2));
  const cleaned=await run(process.execPath,[path.join(V2_DIR,"publisher.mjs"),"--cleanup-only","--package",packagePath,"--job-id",jobId,"--state-root",root],{env});
  assert.equal(cleaned.code,0,`${cleaned.stderr}\n${cleaned.stdout}`);
  const after=JSON.parse(await fs.promises.readFile(statePath,"utf8"));
  assert.equal(after.status,"running");
  assert.equal(after.platforms.xiaohongshu.taskSpaceName,recordedName);
  const script=await fs.promises.readFile(log,"utf8");
  assert.equal(closeNamesFromLog(script).includes(recordedName), false);
});

test("cleanup-only asks Ego to close completed leftover spaces", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-cleanup-only-test-"));
  const other=path.join(root,"ready-job");
  const log=path.join(root,"cleanup.log");
  await fs.promises.mkdir(other, { recursive: true });
  await fs.promises.writeFile(path.join(other,"state.json"), JSON.stringify({
    status: "ready",
    platforms: { douyin: { taskSpaceId: 21, taskSpaceName: "old douyin leftover" } },
  }));
  const result=await run(process.execPath,[
    path.join(V2_DIR,"publisher.mjs"),
    "--cleanup-only",
    "--state-root", root,
    "--no-cleanup-stale-spaces",
  ], { env: { ...process.env, VIDEO_PUBLISHER_V2_CLEANUP_LOG: log } });
  // --no-cleanup-stale-spaces with no package has nothing to close; rerun with default stale cleanup
  const cleaned=await run(process.execPath,[
    path.join(V2_DIR,"publisher.mjs"),
    "--cleanup-only",
    "--state-root", root,
  ], { env: { ...process.env, VIDEO_PUBLISHER_V2_CLEANUP_LOG: log } });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(cleaned.code, 0, `${cleaned.stderr}\n${cleaned.stdout}`);
  const script = await fs.promises.readFile(log, "utf8");
  assert.match(script, /old douyin leftover/);
  assert.match(script, /oil-collect-publish/);
});

test("two publishers for the same job produce one winner and one immediate refusal", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-double-run-test-"));
  const videoPath=path.join(root,"sample-video.mp4");
  const packagePath=path.join(root,"package.json");
  const configPath=path.join(root,"config.json");
  const log=path.join(root,"events.ndjson");
  await fs.promises.writeFile(videoPath,"test video fixture");
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:"Double run",xhsTopics:["Test"],cover:{uploadCustomCover:false}}));
  const args=[path.join(V2_DIR,"publisher.mjs"),packagePath,"double-run","xiaohongshu","--job-id","shared-job","--state-root",root];
  const options={env:{...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),VIDEO_PUBLISHER_V2_MOCK_LOG:log}};
  const results=await Promise.all([run(process.execPath,args,options),run(process.execPath,args,options)]);
  assert.deepEqual(results.map(item=>item.code).sort(),[0,1]);
  const winner=results.find(item=>item.code===0);
  const refused=results.find(item=>item.code===1);
  assert.equal(JSON.parse(winner.stdout).ready,true);
  assert.match(refused.stderr,/already running.+refusing a second orchestrator/);
  assert.equal(fs.existsSync(path.join(root,"shared-job","orchestrator.lock")),false);
});

test("two different jobs under different state roots cannot split platform ownership", async () => {
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),"video-publisher-v2-global-lock-test-"));
  const configPath=path.join(root,"config.json");
  const log=path.join(root,"events.ndjson");
  await fs.promises.writeFile(configPath,JSON.stringify({schemaVersion:1,onboarding:{completed:true},sourceDirectory:root,defaultPlatforms:["xiaohongshu"],declarations:{originalityPolicy:"all_videos_original"},execution:{checkConcurrency:1,uploadConcurrency:1}}));
  const packagePaths=[];
  for (const suffix of ["a","b"]) {
    const videoPath=path.join(root,`sample-${suffix}.mp4`);
    const packagePath=path.join(root,`package-${suffix}.json`);
    await fs.promises.writeFile(videoPath,`test video fixture ${suffix}`);
    await fs.promises.writeFile(packagePath,JSON.stringify({videoPath,title:`Global lock ${suffix}`,xhsTopics:["Test"],cover:{uploadCustomCover:false}}));
    packagePaths.push(packagePath);
  }
  const options={env:{...process.env,VIDEO_PUBLISHER_CONFIG:configPath,VIDEO_PUBLISHER_V2_RUNNER:path.join(DIR,"mock-runner.mjs"),VIDEO_PUBLISHER_V2_MOCK_LOG:log}};
  const stateRootFor=jobId=>path.join(root,`state-${jobId}`);
  const argsFor=(packagePath,jobId)=>[path.join(V2_DIR,"publisher.mjs"),packagePath,"global-lock","xiaohongshu","--job-id",jobId,"--state-root",stateRootFor(jobId)];
  const results=await Promise.all([
    run(process.execPath,argsFor(packagePaths[0],"job-a"),options),
    run(process.execPath,argsFor(packagePaths[1],"job-b"),options),
  ]);
  assert.deepEqual(results.map(item=>item.code).sort(),[0,1]);
  const winner=results.find(item=>item.code===0);
  const refused=results.find(item=>item.code===1);
  assert.equal(JSON.parse(winner.stdout).ready,true);
  assert.match(refused.stderr,/Another video publishing job is already running/);
  const stateFiles=["job-a","job-b"].filter(jobId=>fs.existsSync(path.join(stateRootFor(jobId),jobId,"state.json")));
  assert.equal(stateFiles.length,1,"the refused job must not write state");
  assert.equal(fs.existsSync(path.join(process.env.VIDEO_PUBLISHER_V2_LOCK_ROOT,"publisher","orchestrator.lock")),false);
});

test('three domestic cover revisions retain native drafts, disallow video work, preserve siblings and replay safely', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-publisher-three-cover-'));
  try {
    const selected = ['xiaohongshu', 'bilibili', 'wechat_channels'];
    const all = [...selected, 'douyin'];
    const configPath = path.join(root, 'config.json'), firstPath = path.join(root, 'original.json'), nextPath = path.join(root, 'new-covers.json');
    const videoPath = path.join(root, 'approved.mp4'), log = path.join(root, 'events.ndjson');
    fs.writeFileSync(videoPath, mp4WithDuration(30));
    const covers = {};
    for (const [key, size] of Object.entries({ vertical3x4Path: [1080, 1440], horizontal4x3Path: [1600, 1200], horizontal16x9Path: [1920, 1080] })) {
      covers[key] = path.join(root, `${key}.png`); fs.writeFileSync(covers[key], pngHeader(...size, 1));
    }
    const portrait = path.join(root, 'portrait-new.png'), landscape = path.join(root, 'landscape-new.png');
    fs.writeFileSync(portrait, pngHeader(1080, 1440, 2)); fs.writeFileSync(landscape, pngHeader(1600, 1200, 2));
    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, onboarding: { completed: true }, sourceDirectory: root,
      availablePlatforms: all, defaultPlatforms: all, declarations: { originalityPolicy: 'all_videos_original' } }));
    const first = { videoPath, title: 'Same approved title', description: 'Same approved description', tags: ['AI'], cover: { uploadCustomCover: true, ...covers } };
    const next = structuredClone(first);
    next.cover.platforms = { xiaohongshu: { nativeRatio: '3:4', vertical3x4Path: portrait }, bilibili: { horizontal4x3Path: landscape },
      wechat_channels: { vertical3x4Path: portrait, horizontal4x3Path: landscape } };
    fs.writeFileSync(firstPath, JSON.stringify(first)); fs.writeFileSync(nextPath, JSON.stringify(next));
    const runner = path.join(root, 'runner.mjs');
    fs.writeFileSync(runner, `import fs from 'node:fs';
if (process.env.VIDEO_PUBLISHER_V2_MOCK_LOG) fs.appendFileSync(process.env.VIDEO_PUBLISHER_V2_MOCK_LOG, JSON.stringify({ event: 'context', platform: process.argv[2], phase: process.argv[4], coverRevision: JSON.parse(process.env.VIDEO_PUBLISHER_V2_COVER_REVISION || 'null'), checkpoint: process.env.VIDEO_PUBLISHER_V2_CHECKPOINT_PATH }) + '\\n');
await import(${JSON.stringify(path.join(DIR, 'mock-runner.mjs'))});\n`);
    const env = { VIDEO_PUBLISHER_CONFIG: configPath, VIDEO_PUBLISHER_V2_RUNNER: runner, VIDEO_PUBLISHER_V2_MOCK_LOG: log };
    const common = [path.join(V2_DIR, 'publisher.mjs'), '--job-id', 'three-covers', '--state-root', root, '--no-cleanup-stale-spaces'];
    const created = await run(process.execPath, [...common, '--package', firstPath], { env });
    assert.equal(created.code, 0, created.stderr);
    const jobDir = path.join(root, 'three-covers'), statePath = path.join(jobDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath));
    const savedAt = new Date().toISOString(), originalFiles = [];
    for (const platform of selected) {
      const item = state.platforms[platform], origin = { xiaohongshu: 'https://creator.xiaohongshu.com', bilibili: 'https://member.bilibili.com', wechat_channels: 'https://channels.weixin.qq.com' }[platform];
      const lookup = platform === 'bilibili' ? { title: first.title, videoName: 'approved.mp4', videoStem: 'approved', beforeIds: [] }
        : { description: first.description, beforeIds: [] };
      const plan = { id: 'draft-test', url: `${origin}/editor`, listUrl: `${origin}/drafts`,
        ...(platform === 'xiaohongshu' ? { uid: 'account-test', videoFileId: 'stable-original-video-id', snapshotHash: 'a'.repeat(64) } : lookup) };
      const journalPath = path.join(jobDir, 'checkpoints', `${platform}.receipts.json.draft-save.json`);
      fs.writeFileSync(journalPath, JSON.stringify({ version: 1, platform, fingerprint: state.fingerprint, status: 'confirmed',
        attemptId: `confirmed-${platform}`, startedAt: savedAt, savedAt, plan }));
      const proof = { version: 2, method: 'draft-list-reopen', platform, fingerprint: state.fingerprint, verificationRunId: `prior-${platform}`,
        savedAt, readAt: savedAt, draftId: plan.id, listEntryId: plan.id, reopenedId: plan.id, listUrl: plan.listUrl, reopenedUrl: plan.url, documentChanged: true,
        ...(platform === 'xiaohongshu' ? { uid: plan.uid, snapshotHash: plan.snapshotHash, storageScope: 'browser-local' } : { lookup }) };
      const evidencePath = path.join(jobDir, 'evidence', `confirmed-source-${platform}.json`);
      fs.writeFileSync(evidencePath, JSON.stringify({ observation: { platform, fingerprint: state.fingerprint, verificationRunId: proof.verificationRunId,
        observedAt: savedAt, taskSpaceId: item.taskSpaceId, finalPublishClicked: false,
        gates: { video: { ok: true }, draftIdentity: { ok: true }, persistedDraft: { ok: true, evidence: proof } } } }));
      item.lastEvidencePath = evidencePath; item.history = [{ phase: 'verify', evidencePath }];
      item.videoReceipt = { fingerprint: state.fingerprint, taskSpaceId: item.taskSpaceId, mode: 'injected' };
      item.receipts.cover = platform === 'wechat_channels' ? { layout: 'separate', slots: {
        vertical: { assetPath: covers.vertical3x4Path, afterUrl: `${origin}/old-portrait`, ratio: '3:4' },
        horizontal: { assetPath: covers.horizontal4x3Path, afterUrl: `${origin}/old-landscape`, ratio: '4:3' } } }
        : { assetPath: platform === 'xiaohongshu' ? covers.vertical3x4Path : covers.horizontal4x3Path, afterUrl: `${origin}/old-cover` };
      const receiptPath = path.join(jobDir, 'checkpoints', `${platform}.receipts.json`);
      fs.writeFileSync(receiptPath, JSON.stringify({ schemaVersion: 2, platform, fingerprint: state.fingerprint, taskSpaceId: item.taskSpaceId, receipts: item.receipts }));
      originalFiles.push(journalPath, receiptPath);
    }
    fs.writeFileSync(statePath, JSON.stringify(state));
    const sibling = JSON.stringify(state.platforms.douyin), bytes = originalFiles.map(file => fs.readFileSync(file));
    fs.writeFileSync(log, '');
    const updateArgs = [...common, '--package', nextPath, '--platforms', selected.join(','), '--operation', 'replace-cover'];
    const revised = await run(process.execPath, updateArgs, { env: { ...env, VIDEO_PUBLISHER_V2_MOCK_EXISTING_READY: '1' } });
    assert.equal(revised.code, 0, revised.stderr);
    const after = JSON.parse(fs.readFileSync(statePath));
    assert.equal(after.status, 'ready');
    assert.equal(JSON.stringify(after.platforms.douyin), sibling);
    assert.equal(after.coverRevision.platforms.length, 3);
    const events = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    for (const platform of selected) {
      assert.equal(after.platforms[platform].taskSpaceId, state.platforms[platform].taskSpaceId);
      assert.equal(after.coverRevision.sources[platform].sourceDraftId, 'draft-test');
      assert.equal(after.coverRevision.sources[platform].sourceFingerprint, state.fingerprint);
      const starts = events.filter(e => e.event === 'start' && e.platform === platform);
      assert.deepEqual(starts.map(e => e.phase), ['inspect', 'mutate', 'persist', 'verify', ...(platform === 'xiaohongshu' ? ['park'] : [])]);
      assert.ok(starts.every(e => e.noUpload === '1' && e.journalPath.includes(`.covers-${after.fingerprint}.`)));
      assert.ok(events.filter(e => e.event === 'context' && e.platform === platform).every(e => e.coverRevision.sourceDraftId === 'draft-test'
        && e.coverRevision.sourceFingerprint === state.fingerprint && e.checkpoint.includes(`.covers-${after.fingerprint}.`)));
    }
    originalFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), bytes[index]));
    const replay = await run(process.execPath, updateArgs, { env: { ...env, VIDEO_PUBLISHER_V2_MOCK_EXISTING_READY: '1' } });
    assert.equal(replay.code, 0, replay.stderr);
    assert.equal(JSON.parse(fs.readFileSync(statePath)).revisions.filter(r => r.operation === 'replace-cover').length, 1);
    originalFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), bytes[index]));
    const inspectSubset = await run(process.execPath, [...common, '--package', nextPath, '--platforms', 'bilibili', '--operation', 'inspect'], { env });
    assert.equal(inspectSubset.code, 0, inspectSubset.stderr);
    fs.writeFileSync(log, '');
    const inspectSibling = await run(process.execPath, [...common, '--package', nextPath, '--platforms', 'douyin', '--operation', 'inspect'], { env });
    assert.equal(inspectSibling.code, 0, inspectSibling.stderr);
    const siblingContext = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).find(e => e.event === 'context');
    assert.equal(siblingContext.coverRevision, null, 'unchanged sibling does not inherit another platform cover revision');
    assert.equal(JSON.parse(fs.readFileSync(statePath)).platformFingerprints.douyin, state.fingerprint);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('XHS duplicate bytes with changed path, title, cover/job and state root stop before creator-page access', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'video-publisher-xhs-idempotent-'));
  try {
    const videoPath = path.join(root, 'video.mp4'), renamed = path.join(root, 'renamed.mp4');
    const packagePath = path.join(root, 'first.json'), nextPackage = path.join(root, 'next.json');
    const configPath = path.join(root, 'config.json'), log = path.join(root, 'events.ndjson');
    await fs.promises.writeFile(videoPath, mp4WithDuration(31));
    await fs.promises.copyFile(videoPath, renamed);
    await fs.promises.writeFile(configPath, JSON.stringify({ schemaVersion: 2, onboarding: { completed: true }, sourceDirectory: root,
      availablePlatforms: ['xiaohongshu'], defaultPlatforms: ['xiaohongshu'], declarations: { originalityPolicy: 'all_videos_original' } }));
    await fs.promises.writeFile(packagePath, JSON.stringify({ videoPath, title: 'First title', tags: ['AI'] }));
    await fs.promises.writeFile(nextPackage, JSON.stringify({ videoPath: renamed, title: 'Another title', tags: ['AI'] }));
    const env = { VIDEO_PUBLISHER_CONFIG: configPath, VIDEO_PUBLISHER_V2_RUNNER: path.join(DIR, 'mock-runner.mjs'), VIDEO_PUBLISHER_V2_MOCK_LOG: log };
    const first = await run(process.execPath, [path.join(V2_DIR, 'publisher.mjs'), packagePath, '--job-id', 'original', '--state-root', path.join(root, 'jobs-a'), '--no-cleanup-stale-spaces'], { env });
    assert.equal(first.code, 0, first.stderr);
    await fs.promises.writeFile(log, '');
    const next = await run(process.execPath, [path.join(V2_DIR, 'publisher.mjs'), nextPackage, '--job-id', 'new-copy', '--state-root', path.join(root, 'jobs-b'), '--no-cleanup-stale-spaces'], { env });
    assert.notEqual(next.code, 0);
    assert.match(next.stderr, /XIAOHONGSHU_DUPLICATE_VIDEO/);
    assert.match(next.stderr, /original/);
    assert.equal(await fs.promises.readFile(log, 'utf8'), '', 'no inspect, upload, mutate, persist or verify runner may start');
    assert.equal(fs.existsSync(path.join(root, 'jobs-b', 'new-copy', 'state.json')), false, 'no replacement job state is manufactured');
    const inspect = await run(process.execPath, [path.join(V2_DIR, 'publisher.mjs'), packagePath, '--job-id', 'original', '--state-root', path.join(root, 'jobs-a'), '--inspect-only', '--no-cleanup-stale-spaces'], { env });
    assert.equal(inspect.code, 0, inspect.stderr);
    const events = (await fs.promises.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).filter(item => item.event === 'start');
    assert.deepEqual(events.map(item => item.phase), ['inspect']);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('XHS same-job upload uncertainty cannot be bypassed by forcing another task space', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'video-publisher-xhs-upload-intent-'));
  try {
    const videoPath = path.join(root, 'video.mp4'), packagePath = path.join(root, 'package.json');
    const configPath = path.join(root, 'config.json'), log = path.join(root, 'events.ndjson');
    await fs.promises.writeFile(videoPath, mp4WithDuration(32));
    await fs.promises.writeFile(packagePath, JSON.stringify({ videoPath, title: 'Upload uncertainty', tags: ['AI'] }));
    await fs.promises.writeFile(configPath, JSON.stringify({ schemaVersion: 2, onboarding: { completed: true }, sourceDirectory: root,
      availablePlatforms: ['xiaohongshu'], defaultPlatforms: ['xiaohongshu'], declarations: { originalityPolicy: 'all_videos_original' } }));
    const env = { VIDEO_PUBLISHER_CONFIG: configPath, VIDEO_PUBLISHER_V2_RUNNER: path.join(DIR, 'mock-runner.mjs'), VIDEO_PUBLISHER_V2_MOCK_LOG: log };
    const base = [path.join(V2_DIR, 'publisher.mjs'), packagePath, '--job-id', 'original', '--state-root', path.join(root, 'jobs'), '--no-cleanup-stale-spaces'];
    const failed = await run(process.execPath, base, { env: { ...env, VIDEO_PUBLISHER_V2_MOCK_BLOCKERS: JSON.stringify({ 'xiaohongshu:upload_start': { code: 'UPLOAD_STALLED', retryable: true } }) } });
    assert.equal(failed.code, 10, failed.stderr);
    await fs.promises.writeFile(log, '');
    const fresh = await run(process.execPath, [...base, '--operation', 'resume', '--force-fresh-space'], { env });
    assert.notEqual(fresh.code, 0);
    assert.match(fresh.stderr, /preserve and resume its original task space/);
    assert.equal(await fs.promises.readFile(log, 'utf8'), '');
    const resumed = await run(process.execPath, [...base, '--operation', 'resume'], { env });
    assert.equal(resumed.code, 0, resumed.stderr);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

async function xhsParkingPublisherFixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'video-publisher-xhs-park-'));
  const videoPath = path.join(root, 'video.mp4'), packagePath = path.join(root, 'package.json');
  const configPath = path.join(root, 'config.json'), log = path.join(root, 'events.ndjson');
  await fs.promises.writeFile(videoPath, mp4WithDuration(31));
  await fs.promises.writeFile(packagePath, JSON.stringify({ videoPath, title: 'Protective parking', tags: ['AI'], cover: { uploadCustomCover: false } }));
  await fs.promises.writeFile(configPath, JSON.stringify({ schemaVersion: 2, onboarding: { completed: true }, sourceDirectory: root,
    availablePlatforms: ['xiaohongshu'], defaultPlatforms: ['xiaohongshu'], declarations: { originalityPolicy: 'all_videos_original' } }));
  const env = { VIDEO_PUBLISHER_CONFIG: configPath, VIDEO_PUBLISHER_V2_RUNNER: path.join(DIR, 'mock-runner.mjs'), VIDEO_PUBLISHER_V2_MOCK_LOG: log };
  const base = [path.join(V2_DIR, 'publisher.mjs'), packagePath, '--job-id', 'original', '--state-root', path.join(root, 'jobs'), '--no-cleanup-stale-spaces'];
  return { root, log, env, base, statePath: path.join(root, 'jobs/original/state.json') };
}

test('XHS READY delivery requires parking and protective park repeats only that phase', async () => {
  const f = await xhsParkingPublisherFixture();
  try {
    const first = await run(process.execPath, f.base, { env: f.env });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).platforms.xiaohongshu.parked, true);
    const before = JSON.parse(await fs.promises.readFile(f.statePath));
    await fs.promises.writeFile(f.log, '');
    const parked = await run(process.execPath, [...f.base, '--operation', 'park'], { env: f.env });
    assert.equal(parked.code, 0, parked.stderr);
    const events = (await fs.promises.readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse).filter(e => e.event === 'start');
    assert.deepEqual(events.map(e => e.phase), ['park']);
    assert.equal(events[0].noUpload, '1');
    const after = JSON.parse(await fs.promises.readFile(f.statePath));
    assert.equal(after.fingerprint, before.fingerprint);
    assert.equal(after.platforms.xiaohongshu.taskSpaceId, before.platforms.xiaohongshu.taskSpaceId);
    const proof = after.platforms.xiaohongshu.verdict.parkedProof;
    assert.equal(proof.editorVerification.historical, true);
    assert.equal(proof.editorVerification.observation.verificationRunId,
      before.platforms.xiaohongshu.verdict.parkedProof.editorVerification.observation.verificationRunId);
    await fs.promises.writeFile(f.log, '');
    const repeatAuto = await run(process.execPath, f.base, { env: f.env });
    assert.equal(repeatAuto.code, 2);
    assert.equal(await fs.promises.readFile(f.log, 'utf8'), '');
  } finally { await fs.promises.rm(f.root, { recursive: true, force: true }); }
});

test('XHS park failure removes intermediate READY and never marks the delivery ledger', async () => {
  const f = await xhsParkingPublisherFixture();
  try {
    const result = await run(process.execPath, f.base, { env: { ...f.env,
      VIDEO_PUBLISHER_V2_MOCK_BLOCKERS: JSON.stringify({ 'xiaohongshu:park': { code: 'PERSISTENCE_UNVERIFIED' } }) } });
    assert.equal(result.code, 10, result.stderr);
    const state = JSON.parse(await fs.promises.readFile(f.statePath));
    assert.equal(state.platforms.xiaohongshu.verdict.ready, false);
    assert.equal(state.platforms.xiaohongshu.status, 'blocked');
    assert.equal(fs.existsSync(path.join(f.root, 'draftbox-ledger.json')), false);
    assert.ok(state.platforms.xiaohongshu.parkingSourceEvidencePath, 'source must be durable before the failed park');
    const failedHistory = state.platforms.xiaohongshu.history.at(-1).evidencePath;
    await fs.promises.writeFile(f.log, '');
    const recovered = await run(process.execPath, [...f.base, '--operation', 'park'], { env: f.env });
    assert.equal(recovered.code, 0, recovered.stderr);
    const after = JSON.parse(await fs.promises.readFile(f.statePath));
    assert.equal(after.platforms.xiaohongshu.parkingSourceEvidencePath, state.platforms.xiaohongshu.parkingSourceEvidencePath);
    assert.ok(after.platforms.xiaohongshu.history.some(entry => entry.evidencePath === failedHistory), 'failed attempt remains in history');
    const starts = (await fs.promises.readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse).filter(entry => entry.event === 'start');
    assert.deepEqual(starts.map(entry => entry.phase), ['park'], 'failure recovery cannot reopen, save or mutate');
  } finally { await fs.promises.rm(f.root, { recursive: true, force: true }); }
});

test('legacy failed protective park recovers the unchanged independent verify from history', async () => {
  const f = await xhsParkingPublisherFixture();
  try {
    assert.equal((await run(process.execPath, f.base, { env: f.env })).code, 0);
    const state = JSON.parse(await fs.promises.readFile(f.statePath));
    const item = state.platforms.xiaohongshu;
    delete item.parkingSource; delete item.parkingSourceEvidencePath;
    item.status = 'blocked'; item.verdict.ready = false; state.status = 'blocked';
    const failurePath = path.join(f.root, 'failed-park.json');
    await fs.promises.writeFile(failurePath, JSON.stringify({ observation: { platform: 'xiaohongshu', phase: 'park',
      fingerprint: state.fingerprint, taskSpaceId: item.taskSpaceId, gates: {}, blocker: { code: 'PERSISTENCE_UNVERIFIED' } } }));
    item.lastEvidencePath = failurePath; item.history.push({ phase: 'park', evidencePath: failurePath });
    await fs.promises.writeFile(f.statePath, JSON.stringify(state));
    await fs.promises.writeFile(f.log, '');
    const recovered = await run(process.execPath, [...f.base, '--operation', 'park'], { env: f.env });
    assert.equal(recovered.code, 0, recovered.stderr);
    const after = JSON.parse(await fs.promises.readFile(f.statePath));
    assert.ok(after.platforms.xiaohongshu.parkingSourceEvidencePath);
    assert.ok(after.platforms.xiaohongshu.history.some(entry => entry.evidencePath === failurePath));
    assert.deepEqual((await fs.promises.readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse)
      .filter(entry => entry.event === 'start').map(entry => entry.phase), ['park']);
  } finally { await fs.promises.rm(f.root, { recursive: true, force: true }); }
});

test('old confirmed XHS recovery blocks before any runner for unknown or published state', async () => {
  const f = await xhsParkingPublisherFixture();
  try {
    assert.equal((await run(process.execPath, f.base, { env: f.env })).code, 0);
    const state = JSON.parse(await fs.promises.readFile(f.statePath));
    state.status = 'blocked'; state.platforms.xiaohongshu.status = 'blocked'; state.platforms.xiaohongshu.verdict.ready = false;
    await fs.promises.writeFile(f.statePath, JSON.stringify(state));
    const now = new Date().toISOString(), plan = { id: 'draft-test', uid: 'mock-owner', videoFileId: 'spectrum/mock-video',
      snapshotHash: state.platforms.xiaohongshu.verdict.parkedProof.snapshotHash,
      url: 'https://creator.xiaohongshu.com/publish/publish?target=video', listUrl: 'https://creator.xiaohongshu.com/publish/publish?target=video' };
    const journal = { version: 1, platform: 'xiaohongshu', fingerprint: state.fingerprint, attemptId: 'prior-run',
      status: 'confirmed', startedAt: now, savedAt: now, plan };
    await fs.promises.writeFile(path.join(path.dirname(f.statePath), 'checkpoints/xiaohongshu.receipts.json.draft-save.json'), JSON.stringify(journal));
    const evidencePath = path.join(f.root, 'native-published.json'), manifest = path.join(f.root, 'status-manifest.json');
    await fs.promises.writeFile(evidencePath, JSON.stringify({ platform: 'xiaohongshu', sourceUrl: plan.url,
      observedAt: now, complete: true, resources: [{ uid: plan.uid, draftId: plan.id, videoFileId: plan.videoFileId, published: true, noteId: 'native-published-note' }] }));
    await fs.promises.writeFile(manifest, JSON.stringify({ schemaVersion: 1, platform: 'xiaohongshu', evidencePath,
      evidenceSha256: createHash('sha256').update(await fs.promises.readFile(evidencePath)).digest('hex') }));
    for (const [statusPath, code] of [['', 'STATE_AMBIGUOUS'], [manifest, 'ALREADY_PUBLISHED']]) {
      await fs.promises.writeFile(f.log, '');
      const result = await run(process.execPath, [...f.base, '--operation', 'resume'], { env: { ...f.env,
        VIDEO_PUBLISHER_XHS_PUBLICATION_STATUS_PATH: statusPath } });
      assert.equal(result.code, 10, result.stderr);
      assert.equal(JSON.parse(result.stdout).platforms.xiaohongshu.blocker.code, code);
      assert.equal(await fs.promises.readFile(f.log, 'utf8'), '', 'no old editor may be selected, reopened or saved');
    }
  } finally { await fs.promises.rm(f.root, { recursive: true, force: true }); }
});
