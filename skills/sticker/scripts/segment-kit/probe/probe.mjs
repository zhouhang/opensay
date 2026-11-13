/* 探针：把任意 html-seek 模板跑成一份可用的片段事实表（segment-v2 的物理事实部分）。
 *
 * 用法：
 *   node probe/probe.mjs \
 *     --template /path/to/opensay/character-theater \
 *     --entry "modules/index.html?m={id}&t=0&d={d}&data=%7B%7D" \
 *     --modules numbered-trio,data-glyph,... \
 *     --max-seconds 12 --fps 8 \
 *     --params-from modules/module-catalog.json \
 *     --out .cache/probe.json
 *
 * 只写事实，不写政策，不写语义。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadChromium, startServer, openSegment, sampleSegment } from '../adapt/html-seek.mjs';
import { parseBeats } from '../analyse/static.mjs';
import { slotCandidates } from './slot-candidates.mjs';

const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const template = path.resolve(val('template'));
const entry = val('entry');
const maxSeconds = Number(val('max-seconds', 12));
const fps = Number(val('fps', 8));
const outPath = path.resolve(val('out', '.cache/probe.json'));
const paramsFrom = val('params-from');
const moduleIds = (val('modules') || '').split(',').map(s => s.trim()).filter(Boolean);

const STATE_RATIO = Number(process.env.STATE_RATIO || 0.012);   // 结构性变化：单帧变化像素占比
const SETTLE_RATIO = Number(process.env.SETTLE_RATIO || 0.0025); // 低于此值视为静止
const AMBIENT_RATIO = Number(process.env.AMBIENT_RATIO || 0.0015);

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function findRenderer(templateDir) {
  const candidates = ['modules/render.js', 'runtime/render.mjs', 'runtime/entry.py', 'view/src/main.js'];
  for (const rel of candidates) {
    const p = path.join(templateDir, rel);
    if (fs.existsSync(p)) return { path: p, rel, sha256: sha256(fs.readFileSync(p)) };
  }
  return { path: null, rel: null, sha256: null };
}


function analyse(samples, duration) {
  const ratios = samples.map(s => s.changed);
  // 局部峰检测：动画连续推进时只记一个切点，但两张卡先后弹出会各记一个
  const states = [];
  const win = Math.max(1, Math.round(0.30 * (samples.length - 1) / Math.max(0.001, duration)));
  for (let i = 1; i < samples.length; i++) {
    const d = ratios[i];
    if (d < STATE_RATIO) continue;
    let isMax = true;
    for (let k = Math.max(1, i - win); k <= Math.min(samples.length - 1, i + win); k++) {
      if (k !== i && ratios[k] > d) { isMax = false; break; }
    }
    if (!isMax) continue;
    if (states.length && samples[i].t - states[states.length - 1].at < 0.3) continue;
    states.push({ at: samples[i].t, strength: Math.min(100, +(d * 400).toFixed(1)) });
  }
  let settle = 0;
  for (let i = 1; i < samples.length; i++) if (ratios[i] >= SETTLE_RATIO) settle = samples[i].t;
  const tail = samples.filter(s => s.t >= Math.max(0, duration - 1.5));
  const ambientMean = tail.length ? tail.reduce((n, s) => n + s.changed, 0) / tail.length : 0;
  const ambient = ambientMean >= AMBIENT_RATIO;
  const strong = samples.slice(1).reduce((n, s) => n + (s.changed >= STATE_RATIO ? 1 : 0), 0);
  const bottom = samples.reduce((n, s) => n + s.bottom, 0) / Math.max(1, samples.length);
  const changeRate = states.length / Math.max(0.001, duration);
  const min = Math.max(2.5, Math.round((Math.min(settle, duration) * 0.65) * 2) / 2);
  const ideal = Math.round(Math.min(duration, settle + 0.4) * 2) / 2;
  const max = Math.round(Math.min(maxSeconds, Math.max(ideal + 1.5, settle + 2.5)) * 2) / 2;
  return {
    states, settleSeconds: settle, ambient, changeRate: Math.round(changeRate * 100) / 100,
    strongSamples: strong, bottomOccupancy: Math.round(bottom * 1000) / 1000,
    suggestedShot: { min, ideal, max },
    probeConfidence: states.length >= 2 ? 'high' : states.length === 1 ? 'medium' : 'low',
  };
}

const renderer = findRenderer(template);
if (!renderer.sha256) throw new Error('找不到渲染器入口（modules/render.js / runtime/render.mjs / runtime/entry.py / view/src/main.js）');
const rendererSrc = fs.readFileSync(renderer.path, 'utf8');

let catalog = null;
if (paramsFrom) {
  const p = path.join(template, paramsFrom);
  if (fs.existsSync(p)) catalog = JSON.parse(fs.readFileSync(p, 'utf8'));
}
const catalogById = new Map((catalog?.modules || []).map(m => [m.id, m]));

if (!moduleIds.length) {
  moduleIds.push(...[...catalogById.keys()]);
}
if (!moduleIds.length) throw new Error('没有指定 --modules，且目录里没有可自动发现的模块列表');

const { server, origin } = await startServer(template);
const chromium = loadChromium();
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--force-color-profile=srgb', '--font-render-hinting=none'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const segments = [];
const staticBeats = parseBeats(renderer.path, maxSeconds);
const VERIFY_CHANGED = Number(process.env.VERIFY_CHANGED || 0.0015);

async function sampleOnce(page, t) {
  const s = await page.evaluate(tt => window.__probe(tt), Math.max(0, t));
  return s.changed;
}

for (const id of moduleIds) {
  const meta = catalogById.get(id);
  const dur = Math.min(maxSeconds, Number(process.env.MAX_SECONDS || maxSeconds));
  let coarse;
  try {
    await openSegment(page, origin, entry, id, dur + 1.5);
    coarse = await sampleSegment(page, dur, 4);          // 4fps 全片粗扫：只用来判断尾部是否仍在动
  } catch (err) {
    segments.push({ id, name: meta?.name, error: String(err.message || err) });
    console.error(JSON.stringify({ id, error: String(err.message || err) }));
    continue;
  }

  const candidates = (staticBeats[id] || []).filter(t => t <= dur);
  const verified = [];
  for (const t of candidates) {
    // 取动作窗口首尾两帧直接比：t-0.15 与 t+0.25。
    // 快弹（卡片）和慢淡入（注释条）都能被这一次比较覆盖。
    const a = Math.max(0, t - 0.15);
    const b = Math.min(dur, t + 0.25);
    await sampleOnce(page, a);
    const strength = await sampleOnce(page, b);
    if (strength >= VERIFY_CHANGED) verified.push({ at: Math.round(t * 1000) / 1000, changed: Math.round(strength * 10000) / 10000 });
  }
  verified.sort((a, b) => a.at - b.at);
  // 去掉过密的重复点（<0.12s 视为同一次动作）
  const states = [];
  for (const v of verified) {
    if (states.length && v.at - states[states.length - 1].at < 0.12) continue;
    states.push({ at: v.at, strength: Math.min(100, +(v.changed * 400).toFixed(1)) });
  }

  const settle = states.length ? states[states.length - 1].at : 0;
  const tail = coarse.filter(s => s.t >= Math.max(0, dur - 1.5));
  const tailMean = tail.length ? tail.reduce((n, s) => n + s.changed, 0) / tail.length : 0;
  const ambient = tailMean >= 0.0008;
  const bottom = coarse.reduce((n, s) => n + s.bottom, 0) / Math.max(1, coarse.length);
  const minShot = Math.max(2.5, Math.round(Math.min(settle, dur) * 0.65 * 2) / 2);
  const ideal = Math.round(Math.min(dur, settle + 0.4) * 2) / 2;
  const maxShot = Math.round(Math.min(maxSeconds, (ambient ? settle + 4.5 : settle + 2.0)) * 2) / 2;

  segments.push({
    id,
    name: meta?.name,
    expresses: meta?.expresses,
    notExpresses: meta?.not_expresses,
    sourceReference: meta?.source_reference,
    states, settleSeconds: settle, ambient,
    changeRate: Math.round((states.length / Math.max(0.001, dur)) * 100) / 100,
    suggestedShot: { min: minShot, ideal: Math.max(minShot, ideal), max: Math.max(minShot + 1, maxShot) },
    assetSlots: [],
    assetSlotCandidates: slotCandidates(rendererSrc, meta?.params),
    assetSlotsVerified: false,
    captionSafeBand: [0.80, 0.97],
    bottomOccupancy: Math.round(bottom * 1000) / 1000,
    probeConfidence: states.length >= 3 ? 'high' : states.length ? 'medium' : 'low',
    _candidates: candidates.length,
  });
  console.error(JSON.stringify({ id, candidates: candidates.length, verified: states.length, settle, ambient, bottom: +(bottom * 1000).toFixed(1) }));
}

await browser.close();
await new Promise(r => server.close(r));

const result = {
  contractVersion: 'segment-v2',
  source: 'probed',
  templateId: path.basename(template),
  templatePath: template,
  renderer: renderer.rel,
  rendererSha256: renderer.sha256,
  probedAt: new Date().toISOString(),
  probeSettings: { maxSeconds, coarseFps: 4, verifyChanged: VERIFY_CHANGED },
  canvas: { width: 1920, height: 1080, fps: 60 },
  segments,
};
await fsp.mkdir(path.dirname(outPath), { recursive: true });
await fsp.writeFile(outPath, JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify({ out: path.relative(process.cwd(), outPath), segments: segments.length, errors: segments.filter(s => s.error).length }));
