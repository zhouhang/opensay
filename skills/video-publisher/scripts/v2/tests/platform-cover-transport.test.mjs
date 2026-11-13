import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const V2 = fileURLToPath(new URL('..', import.meta.url));
function box(type,payload){const b=Buffer.alloc(8+payload.length);b.writeUInt32BE(b.length);b.write(type,4,'ascii');payload.copy(b,8);return b}
function mp4(){const p=Buffer.alloc(20);p.writeUInt32BE(1000,12);p.writeUInt32BE(30000,16);return Buffer.concat([box('ftyp',Buffer.alloc(4)),box('moov',box('mvhd',p))])}
function webp(width,height){const b=Buffer.alloc(30);b.write('RIFF');b.writeUInt32LE(22,4);b.write('WEBPVP8 ',8);b.writeUInt32LE(10,16);b.set([0x10,0,0,0x9d,1,0x2a],20);b.writeUInt16LE(width,26);b.writeUInt16LE(height,28);return b}
function run(command,args,options){return new Promise((resolve,reject)=>{const child=spawn(command,args,{...options,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}))})}

async function capture(t, platform, env) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),`platform-cover-transport-${platform}-`));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const videoPath=path.join(root,'video.mp4'),packagePath=path.join(root,'package.json'),configPath=path.join(root,'config.json');
  const fake=path.join(root,'fake-ego'),captured=path.join(root,'generated.mjs');
  const portrait=path.join(root,'portrait.webp'),landscape=path.join(root,'landscape.webp');
  fs.writeFileSync(videoPath,mp4());fs.writeFileSync(portrait,webp(30,40));fs.writeFileSync(landscape,webp(40,30));
  fs.writeFileSync(packagePath,JSON.stringify({videoPath,title:'Transport',bilibiliDescription:'Description',bilibiliTags:['tag'],wechatDescription:'Description',
    wechatTags:['tag'],cover:{uploadCustomCover:true,vertical3x4Path:portrait,horizontal4x3Path:landscape}}));
  fs.writeFileSync(configPath,JSON.stringify({schemaVersion:2,onboarding:{completed:true},sourceDirectory:root,availablePlatforms:[platform],defaultPlatforms:[platform]}));
  fs.writeFileSync(fake,'#!/bin/sh\ncat > "$CAPTURE_SCRIPT"\nexit 1\n',{mode:0o755});
  const result=await run(process.execPath,[path.join(V2,'run-platform.mjs'),platform,packagePath,'inspect'],{env:{...process.env,VIDEO_PUBLISHER_CONFIG:configPath,
    VIDEO_PUBLISHER_V2_EGO_COMMAND:fake,CAPTURE_SCRIPT:captured,VIDEO_PUBLISHER_V2_LOCK_ROOT:path.join(root,'locks'),VIDEO_PUBLISHER_V2_PUBLISHER_LOCK_TOKEN:'',...env}});
  assert.equal(result.code,0,result.stderr);return {script:fs.readFileSync(captured,'utf8'),captured,portrait,landscape};
}

test('runner serializes Bilibili transport path while package keeps original WebP identity', async t => {
  const manifest='/absolute/bilibili-transport.json';
  const {script,captured,landscape}=await capture(t,'bilibili',{VIDEO_PUBLISHER_BILIBILI_COVER_TRANSPORT_MANIFEST:manifest});
  assert.equal(JSON.parse(script.match(/^const bilibiliCoverTransportManifestPath = (.+);$/m)[1]),manifest);
  assert.equal(JSON.parse(script.match(/^const pkg = (.+);$/m)[1]).cover.horizontal4x3Path,landscape);
  assert.match(script,/uploadFile\(exposed\.selector,asset\.uploadPath\|\|asset\.assetPath\|\|bilibiliCoverPath\)/);
  assert.match(script,/bilibiliCoverTransportMatches\(receipt\.transport \|\| null\)/);
  assert.match(script,/transport:asset\.transport/);
  const checked=await run(process.execPath,['--check',captured],{});assert.equal(checked.code,0,checked.stderr);
});

test('runner serializes both WeChat slot transports while package keeps both original WebP identities', async t => {
  const vertical='/absolute/wechat-vertical.json',horizontal='/absolute/wechat-horizontal.json';
  const {script,captured,portrait,landscape}=await capture(t,'wechat_channels',{
    VIDEO_PUBLISHER_WECHAT_VERTICAL_COVER_TRANSPORT_MANIFEST:vertical,
    VIDEO_PUBLISHER_WECHAT_HORIZONTAL_COVER_TRANSPORT_MANIFEST:horizontal,
  });
  assert.equal(JSON.parse(script.match(/^const wechatVerticalCoverTransportManifestPath = (.+);$/m)[1]),vertical);
  assert.equal(JSON.parse(script.match(/^const wechatHorizontalCoverTransportManifestPath = (.+);$/m)[1]),horizontal);
  const pkg=JSON.parse(script.match(/^const pkg = (.+);$/m)[1]);
  assert.equal(pkg.cover.vertical3x4Path,portrait);assert.equal(pkg.cover.horizontal4x3Path,landscape);
  assert.match(script,/DOM\.setFileInputFiles',\{objectId,files:\[approved\.uploadPath\]\}/);
  assert.match(script,/assetPath:asset\.path,assetHash:approved\.assetHash/);
  assert.match(script,/wechatCoverReceiptTransportMatches\(asset,item\)/);
  const checked=await run(process.execPath,['--check',captured],{});assert.equal(checked.code,0,checked.stderr);
});
