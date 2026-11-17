#!/usr/bin/env python3
"""Reference-vs-module fidelity report: the gate of step 6 in replicate-reference.md.

For every pair it cuts the reference shot, takes the module render (rendered with constructed look-alike materials,
never with the reference's own frames or text), and writes a side-by-side clip, a frame-pair strip at the same relative
progress, and the same motion/layout metrics for both. Each pair gets automatic flags against the thresholds below and
the reviewer's verdict (close / partial / far) with concrete gaps, read from the "review" block of the input.
A module is admitted only when its flags are clear AND its verdict is "close".

Input JSON (--pairs):
{"title": "...",
 "pairs": [{"id": "bars", "what": "...", "ref": {"video": "/abs/ref.mp4", "start": 32.0, "end": 36.2},
            "module": {"video": "/abs/render.mp4", "label": "sr-bars · fidelity set"}}],
 "uncovered": [{"video": "/abs/ref.mp4", "start": 9, "end": 12, "what": "...", "reproduce": "webgl"}],
 "review": {"bars": {"verdict": "close|partial|far", "gaps": ["..."], "causes": ["..."]}}}
Output (--out): media/, metrics.json, report.html.   Usage: python3 fidelity_report.py --pairs pairs.json --out /abs/report
"""
from __future__ import annotations
import argparse, html, json, subprocess
from pathlib import Path
import numpy as np

SCALE = 'scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p'
# initial thresholds; calibrated on the pilot by comparing repeated instances of one shot type inside the reference itself
LIMITS = {'duration_ratio': (0.67, 1.5), 'beats_abs': 2.5, 'beats_rel': 0.4, 'camera_abs': 0.12, 'hold_abs': 0.2, 'tail_over': 0.15}


def run(cmd): subprocess.run(cmd, check=True, capture_output=True)
def dur(p): return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)], capture_output=True, text=True).stdout)
def cut(src, a, b, out):
    run(['ffmpeg', '-v', 'error', '-y', '-ss', str(a), '-to', str(b), '-i', str(src), '-an', '-vf', SCALE, '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-movflags', '+faststart', str(out)])


def strip(clips, out, tmp, n=6):
    rows = []
    for i, c in enumerate(clips):
        d = dur(c); fr = []
        for k in range(n):
            f = tmp / f'_f{i}{k}.jpg'; run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{d * (.04 + .9 * k / (n - 1)):.3f}', '-i', str(c), '-frames:v', '1', '-vf', 'scale=480:270', str(f)]); fr.append(f)
        row = tmp / f'_row{i}.jpg'; run(['ffmpeg', '-v', 'error', '-y', *sum([['-i', str(f)] for f in fr], []), '-filter_complex', ''.join(f'[{k}]' for k in range(n)) + f'hstack={n}', str(row)]); rows.append(row)
    if len(rows) == 1: rows[0].replace(out)
    else: run(['ffmpeg', '-v', 'error', '-y', *sum([['-i', str(r)] for r in rows], []), '-filter_complex', ''.join(f'[{k}]' for k in range(len(rows))) + f'vstack={len(rows)}', '-q:v', '3', str(out)])
    for f in tmp.glob('_*.jpg'): f.unlink()


def sbs(a, b, out):
    da, db = dur(a), dur(b); m = max(da, db)
    run(['ffmpeg', '-v', 'error', '-y', '-i', str(a), '-i', str(b), '-filter_complex',
         f'[0]tpad=stop_mode=clone:stop_duration={m - da + .05:.3f}[x];[1]tpad=stop_mode=clone:stop_duration={m - db + .05:.3f}[y];[x][y]hstack=2,trim=duration={m:.3f}',
         '-c:v', 'libx264', '-crf', '24', '-preset', 'veryfast', '-movflags', '+faststart', str(out)])


def frames(p, w=96, h=54, fps=10, gray=True):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(p), '-vf', f'fps={fps},scale={w}:{h}' + (',format=gray' if gray else ''), *([] if gray else ['-pix_fmt', 'rgb24']), '-f', 'rawvideo', '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape((-1, h, w) if gray else (-1, h, w, 3)).astype(np.int16)


def metrics(p):
    f = frames(p); ch = np.array([(np.abs(f[i] - f[i - 1]) > 10).mean() for i in range(1, len(f))])
    active = ch >= .005; bursts = 0; quiet = 3
    for a in active:
        if a and quiet >= 3: bursts += 1
        quiet = 0 if a else quiet + 1
    last = np.nonzero(active)[0]; tail = 1 - ((last[-1] + 1) / len(active) if len(last) else 0)
    fills = []
    for fr in frames(p, 192, 108, 2, gray=False):
        q = (fr // 16).reshape(-1, 3); k = q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2]; bg = np.bincount(k).argmax()
        ref = np.array([bg // 256, bg // 16 % 16, bg % 16]) * 16 + 8; fills.append((np.abs(fr.reshape(-1, 3) - ref).max(1) > 14).mean())
    d = len(f) / 10
    return {'seconds': round(d, 1), 'hold': round(float((~active).mean()), 2), 'camera': round(float((ch >= .35).mean()), 2),
            'beats_per_10s': round(bursts / max(d, .1) * 10, 1), 'frozen_tail': round(float(tail), 2), 'fill': round(float(np.median(fills)), 2)}


def flags(r, m):
    out = []
    ratio = m['seconds'] / max(r['seconds'], .1)
    if not LIMITS['duration_ratio'][0] <= ratio <= LIMITS['duration_ratio'][1]: out.append(f'时长是原片的 {ratio:.2f} 倍')
    if abs(m['beats_per_10s'] - r['beats_per_10s']) > max(LIMITS['beats_abs'], LIMITS['beats_rel'] * r['beats_per_10s']): out.append(f'每 10 秒变化 {m["beats_per_10s"]} 次，原片 {r["beats_per_10s"]} 次')
    if abs(m['camera'] - r['camera']) > LIMITS['camera_abs']: out.append(f'整画面运动 {m["camera"]:.0%}，原片 {r["camera"]:.0%}')
    if abs(m['hold'] - r['hold']) > LIMITS['hold_abs']: out.append(f'静止占比 {m["hold"]:.0%}，原片 {r["hold"]:.0%}')
    if m['frozen_tail'] > r['frozen_tail'] + LIMITS['tail_over']: out.append(f'最后 {m["frozen_tail"]:.0%} 不动，原片 {r["frozen_tail"]:.0%}')
    return out


def main() -> None:
    ap = argparse.ArgumentParser(); ap.add_argument('--pairs', required=True); ap.add_argument('--out', required=True); a = ap.parse_args()
    C = json.loads(Path(a.pairs).read_text()); out = Path(a.out).resolve(); media = out / 'media'; media.mkdir(parents=True, exist_ok=True)
    review = C.get('review', {}); M = {'pairs': {}, 'uncovered': [], 'limits': LIMITS}; E = html.escape
    for p in C['pairs']:
        if not Path(p['module']['video']).is_file(): raise SystemExit(f"MODULE_RENDER_MISSING: {p['id']} -> {p['module']['video']} (render the fidelity set first)")
        ref, mod = media / f"{p['id']}-ref.mp4", media / f"{p['id']}-mod.mp4"
        cut(p['ref']['video'], p['ref']['start'], p['ref']['end'], ref); cut(p['module']['video'], 0, dur(p['module']['video']), mod)
        sbs(ref, mod, media / f"{p['id']}-sbs.mp4"); strip([ref, mod], media / f"{p['id']}-strip.jpg", media)
        r, m = metrics(ref), metrics(mod); fl = flags(r, m); rv = review.get(p['id'], {})
        M['pairs'][p['id']] = {'ref': r, 'mod': m, 'flags': fl, 'verdict': rv.get('verdict'), 'admitted': not fl and rv.get('verdict') == 'close'}
        print(p['id'], 'flags', fl, 'verdict', rv.get('verdict'), flush=True)
    for i, u in enumerate(C.get('uncovered', [])):
        clip = media / f'un-{i:02d}.mp4'; cut(u['video'], u['start'], u['end'], clip); strip([clip], media / f'un-{i:02d}-strip.jpg', media)
        M['uncovered'].append({**u, 'clip': clip.name, 'strip': f'un-{i:02d}-strip.jpg'})
    (out / 'metrics.json').write_text(json.dumps(M, ensure_ascii=False, indent=1))
    VL = {'close': '接近', 'partial': '部分对上', 'far': '差距大', None: '未评审'}
    rows = [('时长（秒）', 'seconds', '{:.1f}'), ('每 10 秒画面变化次数', 'beats_per_10s', '{:.1f}'), ('静止占比', 'hold', '{:.0%}'), ('整画面运动占比', 'camera', '{:.0%}'), ('最后不动的比例', 'frozen_tail', '{:.0%}'), ('画面填充度', 'fill', '{:.0%}')]
    cards = ''
    for p in C['pairs']:
        mm = M['pairs'][p['id']]; rv = review.get(p['id'], {})
        table = ''.join(f'<tr><td>{k}</td><td>{f.format(mm["ref"][key])}</td><td>{f.format(mm["mod"][key])}</td></tr>' for k, key, f in rows)
        cards += (f'<article id="{E(p["id"])}"><h3>{E(p["id"])} <small>{E(p.get("what", ""))}</small> <span class="v {mm["verdict"] or "none"}">{VL[mm["verdict"]]}</span> '
                  f'<span class="g {"ok" if mm["admitted"] else "no"}">{"通过" if mm["admitted"] else "未通过"}</span></h3>'
                  f'<p class="lab">左：原片 {p["ref"]["start"]}–{p["ref"]["end"]}s　右：{E(p["module"].get("label", "模块"))}</p>'
                  f'<video src="media/{E(p["id"])}-sbs.mp4" controls muted loop playsinline preload="metadata"></video><img src="media/{E(p["id"])}-strip.jpg" loading="lazy">'
                  f'<div class="cols"><table><tr><th>指标</th><th>原片</th><th>模块</th></tr>{table}</table><div>'
                  + (f'<p class="fl">自动标记：{"；".join(E(x) for x in mm["flags"])}</p>' if mm['flags'] else '<p class="ok2">自动指标在阈值内</p>')
                  + ''.join(f'<li>{E(g)}</li>' for g in rv.get('gaps', [])) + '</div></div></article>')
    unc = ''.join(f'<figure><img src="media/{u["strip"]}" loading="lazy"><figcaption>{u["start"]}–{u["end"]}s {E(u["what"])} · {E(u.get("reproduce", ""))} <a href="media/{u["clip"]}">片段</a></figcaption></figure>' for u in M['uncovered'])
    ok = sum(v['admitted'] for v in M['pairs'].values())
    doc = (f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>复刻对照</title><style>'
           ':root{--bg:#F6F6F8;--p:#fff;--l:#E2E3E8;--fg:#17181C;--d:#5E6270}@media (prefers-color-scheme:dark){:root{--bg:#111214;--p:#1A1C20;--l:#2C2F36;--fg:#ECECEE;--d:#A3A6AE}}'
           'body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"PingFang SC",sans-serif}main{max-width:1200px;margin:auto;padding:24px 16px}'
           'article{background:var(--p);border:1px solid var(--l);border-radius:12px;padding:14px;margin:0 0 18px}video,img{width:100%;display:block;border-radius:6px;margin-top:6px}'
           '.cols{display:grid;grid-template-columns:minmax(240px,340px) 1fr;gap:16px;margin-top:10px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid var(--l);padding:4px 6px;text-align:left}'
           '.v,.g{font-size:12px;padding:2px 8px;border-radius:10px;color:#fff;margin-left:6px}.close,.ok{background:#2F7D55}.partial{background:#8A6A1F}.far,.no{background:#9A3434}.none{background:#666}'
           '.fl{color:#C0504D}.ok2{color:#2F7D55}.lab,small{color:var(--d);font-size:13px}@media (max-width:720px){.cols{grid-template-columns:1fr}}</style><main>'
           f'<h1>{E(C.get("title", "复刻对照"))}</h1><p class="lab">{ok}/{len(C["pairs"])} 个模块通过（自动指标在阈值内且评审为「接近」）。模块侧用构造的同类素材渲染，不用原片的文字和画面。</p>'
           f'{cards}<h2>没有对应模块的原片片段</h2>{unc}</main></html>')
    (out / 'report.html').write_text(doc); print(json.dumps({'pairs': len(C['pairs']), 'admitted': ok, 'report': str(out / 'report.html')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
