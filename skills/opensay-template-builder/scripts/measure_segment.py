#!/usr/bin/env python3
"""Measure one reference segment for its replication spec (step 3 of replicate-reference.md).

Gives the numbers a spec needs that eyes get wrong: when things change (beats), how much of the picture moves
(camera vs local motion), when it settles, where the content sits (bounding box of non-background pixels) and the
palette. It also dumps frames at --fps (default 10) at full resolution so element positions, type sizes and motion
paths can be read off real pixels instead of thumbnails.

Writes into --out: measure.json, frames/ (full-resolution JPEGs), curve.txt (change per step, for plotting).
measure.json also lists audio_onsets: seconds (relative to --start) where a sound attacks (typing, hits, cut whooshes, beats),
for spec item 13; the reference audio is only used to locate sounds, never copied into the library.
Usage: python3 measure_segment.py --video /abs/ref.mp4 --start 32.0 --end 36.2 --out /abs/work/specs/bars/measure [--fps 10]
Run it on a module render too (--start 0 --end <duration>) to compare like with like.
"""
from __future__ import annotations
import argparse, json, subprocess
from pathlib import Path
import numpy as np


def grab(video, start, end, fps, w, h, gray):
    vf = f'fps={fps},scale={w}:{h}' + (',format=gray' if gray else '')
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{start:.3f}', '-to', f'{end:.3f}', '-i', str(video), '-vf', vf,
                          *([] if gray else ['-pix_fmt', 'rgb24']), '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape((-1, h, w) if gray else (-1, h, w, 3)).astype(np.int16)


def audio_onsets(video, start, end):
    """Attack times of sounds in [start, end) relative to start: high-passed energy jumps (>1.2 in log) at local maxima above -40 dB."""
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{start:.3f}', '-to', f'{end:.3f}', '-i', str(video), '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], capture_output=True).stdout
    x = np.frombuffer(raw, np.float32)
    if len(x) < 1600: return []
    hop = 160; n = len(x) // hop; fr = x[:n * hop].reshape(n, hop)
    db = 20 * np.log10(np.sqrt((fr ** 2).mean(1)) + 1e-6)
    hp = np.diff(x, prepend=0)[:n * hop].reshape(n, hop); e = np.sqrt((hp ** 2).mean(1))
    on = np.maximum(0, np.diff(np.log(e + 1e-5), prepend=0))
    return [round(i / 100, 2) for i in range(2, n - 2) if on[i] > 1.2 and on[i] == on[i - 2:i + 3].max() and db[i] > -40]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', required=True); ap.add_argument('--start', type=float, required=True); ap.add_argument('--end', type=float, required=True)
    ap.add_argument('--out', required=True); ap.add_argument('--fps', type=float, default=10)
    a = ap.parse_args(); out = Path(a.out).resolve(); (out / 'frames').mkdir(parents=True, exist_ok=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{a.start:.3f}', '-to', f'{a.end:.3f}', '-i', a.video, '-vf', f'fps={a.fps}', '-q:v', '3',
                    str(out / 'frames' / 'f%04d.jpg')], check=True)
    g = grab(a.video, a.start, a.end, 10, 192, 108, True)
    ch = [float((np.abs(g[i] - g[i - 1]) > 10).mean()) for i in range(1, len(g))]
    active = [c >= .005 for c in ch]
    beats, quiet = [], 3
    for i, act in enumerate(active):
        if act and quiet >= 3: beats.append(round((i + 1) / 10, 1))
        quiet = 0 if act else quiet + 1
    last = max([i for i, act in enumerate(active) if act], default=-1)
    c = grab(a.video, a.start, a.end, 2, 480, 270, False)
    boxes, pal = [], {}
    for k, fr in enumerate(c):
        q = (fr // 16).reshape(-1, 3); key = q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2]; counts = np.bincount(key, minlength=4096)
        bgk = int(counts.argmax()); bg = np.array([bgk // 256, bgk // 16 % 16, bgk % 16]) * 16 + 8
        mask = (np.abs(fr - bg).max(2) > 18); ys, xs = np.nonzero(mask)
        boxes.append({'t': round(k / 2, 1), 'content_box_1920': [int(xs.min() * 4), int(ys.min() * 4), int((xs.max() - xs.min()) * 4), int((ys.max() - ys.min()) * 4)] if len(xs) else None,
                      'fill': round(float(mask.mean()), 3), 'background_hex': '#%02X%02X%02X' % tuple(int(v) for v in bg)})
        for idx in np.argsort(counts)[-6:]:
            if counts[idx]: pal[int(idx)] = pal.get(int(idx), 0) + int(counts[idx])
    total = sum(pal.values()) or 1
    palette = [{'hex': '#%02X%02X%02X' % (i // 256 * 16 + 8, i // 16 % 16 * 16 + 8, i % 16 * 16 + 8), 'share': round(v / total, 3)} for i, v in sorted(pal.items(), key=lambda x: -x[1])[:8]]
    res = {'schema': 'opensay-segment-measure-v1', 'video': a.video, 'start': a.start, 'end': a.end, 'seconds': round(a.end - a.start, 2),
           'beats_at': beats, 'beats_per_10s': round(len(beats) / max(a.end - a.start, .1) * 10, 1),
           'hold_share': round(1 - sum(active) / max(len(active), 1), 2), 'camera_share': round(sum(c >= .35 for c in ch) / max(len(ch), 1), 2),
           'audio_onsets': audio_onsets(a.video, a.start, a.end), 'settles_at': round((last + 1) / 10, 1) if last >= 0 else 0, 'frozen_tail': round(1 - (last + 1) / max(len(active), 1), 2) if last >= 0 else 1,
           'layout': boxes, 'palette': palette, 'frames_dir': str(out / 'frames'), 'frames_fps': a.fps,
           'definitions': {'beat': 'start of a burst of change (>=0.5% of a 192x108 thumbnail changes by >10 levels per 0.1 s) after >=0.3 s of stillness',
                           'camera_share': 'share of 0.1 s steps where >=35% of the picture changes (whole-picture motion)'}}
    (out / 'curve.txt').write_text('\n'.join(f'{(i + 1) / 10:.1f}\t{c:.4f}' for i, c in enumerate(ch)))
    (out / 'measure.json').write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print(json.dumps({k: res[k] for k in ('seconds', 'beats_at', 'beats_per_10s', 'hold_share', 'camera_share', 'settles_at', 'audio_onsets')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
