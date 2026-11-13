/* html-seek 适配器：把任何「可 seek 的网页渲染器」变成可逐帧取样的片段源。
 *
 * 约定（最小要求，不要求模板声明任何东西）：
 *   - 页面 URL 里带 {id} 与 {d} 占位，打开后 document.title 变 done（或 renderAt 可用）
 *   - window.renderAt(t) 可用（同步或 async 均可）
 *   - 画面画在某个 canvas 上；找不到 canvas 时退回整页截图
 *
 * 取样只回传标量（帧差 / 底部占比），不回传像素，避免 CDP 传输成为瓶颈。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function loadChromium() {
  // environment variables first, then the standard npm lookup (local node_modules, then global)
  for (const p of [
    process.env.PLAYWRIGHT_PATH,
    process.env.OPENSAY_PLAYWRIGHT_MODULE,
    'playwright-core',
    'playwright',
  ]) {
    if (!p) continue;
    try { const m = require(p); if (m.chromium) return m.chromium; } catch (_) {}
  }
  throw new Error('playwright-core not found: run `npm install playwright-core` (then `npx playwright install chromium`) or set PLAYWRIGHT_PATH');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

export async function startServer(root) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/favicon.ico')) { res.writeHead(204); res.end(); return; }
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(base, rel);
    if (!file.startsWith(base) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}

/* 在页面里装一个取样器：把 canvas 缩到 160x90，算与上一帧的平均像素差 + 底部 18% 非背景占比 */
const SAMPLER = `(() => {
  if (window.__probe) return;
  const SRC = document.querySelector('canvas') || document.getElementById('stage') || document.body;
  const W = 160, H = 90;
  const off = document.createElement('canvas'); off.width = W; off.height = H;
  const g = off.getContext('2d', { willReadFrequently: true });
  let prev = null;
  window.__probe = async (t) => {
    if (typeof window.renderAt === 'function') {
      await window.renderAt(t);
    }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    g.clearRect(0, 0, W, H);
    try { g.drawImage(SRC, 0, 0, W, H); }
    catch (e) { const r = SRC.getBoundingClientRect(); g.drawImage(SRC, 0, 0, r.width, r.height, 0, 0, W, H); }
    const d = g.getImageData(0, 0, W, H).data;
    const gray = new Float32Array(W * H);
    let lit = 0;
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      const v = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
      gray[i] = v;
      if (v > 60) lit++;
    }
    let changed = 0, mean = 0;
    if (prev) {
      let sum = 0, hits = 0;
      for (let i = 0; i < gray.length; i++) { const dd = Math.abs(gray[i] - prev[i]); sum += dd; if (dd > 12) hits++; }
      changed = hits / gray.length;
      mean = sum / gray.length;
    }
    prev = gray;
    // 底部带「内容占比」：相对该带中位色偏离 >25 的像素比（深浅模块都适用）
    const bandTop = Math.floor(H * 0.82);
    const band = [];
    for (let y = bandTop; y < H; y++) for (let x = 0; x < W; x++) band.push(gray[y * W + x]);
    band.sort((a, b) => a - b);
    const med = band[Math.floor(band.length / 2)] || 0;
    let bandContent = 0;
    for (const v of band) if (Math.abs(v - med) > 25) bandContent++;
    return { changed: Math.round(changed * 10000) / 10000, mean: Math.round(mean * 1000) / 1000,
             lit: Math.round((lit / gray.length) * 1000) / 1000,
             bottom: Math.round((bandContent / Math.max(1, band.length)) * 1000) / 1000 };
  };
})();`;

export async function openSegment(page, origin, entryTemplate, id, durationSeconds) {
  const url = origin + '/' + entryTemplate
    .replaceAll('{id}', encodeURIComponent(id))
    .replaceAll('{d}', durationSeconds.toFixed(3));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(
    () => document.title === 'done' || (document.title || '').startsWith('error') || typeof window.renderAt === 'function',
    { timeout: 30000 });
  const title = await page.title();
  if ((title || '').startsWith('error')) throw new Error(`${id}: ${title}`);
  await page.evaluate(SAMPLER);
}

export async function sampleSegment(page, durationSeconds, fps) {
  const step = 1 / fps;
  const n = Math.max(2, Math.round(durationSeconds * fps) + 1);
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t = Math.min(durationSeconds, i * step);
    const s = await page.evaluate(t => window.__probe(t), t);
    samples.push({ t: Math.round(t * 1000) / 1000, ...s });
  }
  return samples;
}
