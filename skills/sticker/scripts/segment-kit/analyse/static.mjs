/* 静态节拍解析：从渲染器源码里读出「设计上的动作时间点」。
 *
 *  为什么需要它：像素差分只能测出「画面在动」，测不出「作者设计的第 2 张卡在 2.35s 弹出」。
 *  设计节拍在源码里是确定的常量表达式（如 P(t, 1.0 + i * 1.35, 1.85 + i * 1.35)），
 *  解析它拿到精确时间，再用像素探针在上面做**验证**，两者互为证据。
 *
 * 支持形态：
 *   P(t, A, B) / smooth(P(t, A, B)) / clamp(P(t, A, B))  —— A/B 可含变量 i
 *  直接调用 x(t, A, B) 这类自定义缓动不解析（探针兜底）
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_UNROLL = 6;

function evalExpr(expr, vars) {
  const keys = Object.keys(vars);
  try {
    const fn = new Function(...keys, `"use strict"; return (${expr});`);
    const v = fn(...keys.map(k => vars[k]));
    return Number.isFinite(v) ? v : null;
  } catch (_) { return null; }
}

/** 从源码里按函数体切分，返回 { 函数名: 函数体 } */
function splitFunctions(src) {
  const out = {};
  const re = /function\s+([A-Za-z_$][\w$]*)\s*\(t\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    let depth = 1, i = start;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    out[m[1]] = src.slice(start, i - 1);
  }
  return out;
}

/** MODULES 映射：'numbered-trio': numberedTrio */
function moduleMap(src) {
  const map = {};
  const re = /['"]([a-z0-9-]+)['"]\s*:\s*([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) map[m[1]] = m[2];
  return map;
}

export function parseBeats(rendererPath, maxSeconds = 12) {
  const src = fs.readFileSync(rendererPath, 'utf8');
  const fns = splitFunctions(src);
  const map = moduleMap(src);
  const result = {};
  for (const [moduleId, fnName] of Object.entries(map)) {
    const body = fns[fnName];
    if (!body) continue;
    // 循环上界：源码里的 i < N / Array(N) / length: N
    const bounds = [...body.matchAll(/i\s*<\s*(\d+)|Array\((\d+)\)|length\s*:\s*(\d+)/g)]
      .map(m => Number(m[1] || m[2] || m[3])).filter(n => Number.isFinite(n) && n > 0);
    const loopN = Math.min(MAX_UNROLL, Math.max(...bounds, 3));

    // 局部常量：const at = 1.0 + i * 1.35
    const consts = [...body.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*([^,;]+)/g)]
      .map(m => [m[1], m[2]]).filter(([n]) => !/^(ctx|d|L|B|p|e|u|o|g|cv)$/.test(n));

    const pRe = /P\(\s*t\s*,\s*([^,()]+(?:\([^)]*\))?)\s*,\s*([^,()]+(?:\([^)]*\))?)\s*\)/g;
    const pExprs = [...body.matchAll(pRe)].map(m => [m[1], m[2]]);

    const times = new Set();
    for (let i = 0; i < loopN; i++) {
      const env = { i, t: 0 };
      for (const [name, expr] of consts) {
        const v = evalExpr(expr, env);
        if (v != null) env[name] = v;
      }
      for (const pair of pExprs) {
        for (const expr of pair) {
          const v = evalExpr(expr, env);
          if (v != null && v > 0.03 && v <= maxSeconds) times.add(Math.round(v * 1000) / 1000);
        }
      }
    }
    result[moduleId] = [...times].sort((x, y) => x - y);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [renderer, max] = process.argv.slice(2);
  const beats = parseBeats(renderer, Number(max || 12));
  console.log(JSON.stringify(beats, null, 1));
}
