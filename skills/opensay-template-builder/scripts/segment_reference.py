#!/usr/bin/env python3
"""Cut a reference film into segments for the shot inventory (step 1 of replicate-reference.md).

A new segment starts at a hard cut OR when the page changes: at 2 fps, more than 30% of a 96x54 luma thumbnail differs
from one second earlier by more than 24 levels. That catches hard cuts and the in-page changes of slide-like films that a
cut detector misses; continuous camera moves inside one shot mostly stay below it. The numbers are an inventory starting
point, not the final shot list: every segment must still be opened at full resolution and described by a person/agent.

Writes into --out:
  segments.json   one row per segment with times, keyframes, strip and EMPTY fields to fill (type_id, what, beats,
                  reproduce, notes) - the inventory is not done while any of them is empty
  keyframes/      full-resolution JPEGs at 15%, 50%, 85% of each segment (look at these, not at thumbnails)
  strips/         6 frames per segment at 480 px for the contact sheet
  contact.html    the contact sheet to browse
Usage: python3 segment_reference.py --video /abs/ref.mp4 --out /abs/work/inventory [--min-len 1.2]
"""
from __future__ import annotations
import argparse, html, json, subprocess
from pathlib import Path
import numpy as np


def frames(video: Path, fps: float, w: int = 96, h: int = 54) -> np.ndarray:
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(video), '-vf', f'fps={fps},scale={w}:{h},format=gray', '-f', 'rawvideo', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.int16)


def duration(video: Path) -> float:
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(video)],
                                capture_output=True, text=True, check=True).stdout)


def boundaries(video: Path, min_len: float) -> list[float]:
    f2 = frames(video, 2)
    page = [i / 2 for i in range(2, len(f2)) if (np.abs(f2[i] - f2[i - 2]) > 24).mean() > .30]
    f10 = frames(video, 10)
    cuts = [i / 10 for i in range(1, len(f10)) if np.abs(f10[i] - f10[i - 1]).mean() > 45]
    out = [0.0]
    for t in sorted(page + cuts):
        if t - out[-1] >= min_len: out.append(t)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--min-len', type=float, default=1.2)
    a = ap.parse_args()
    video, out = Path(a.video).resolve(), Path(a.out).resolve()
    for d in ('keyframes', 'strips'): (out / d).mkdir(parents=True, exist_ok=True)
    total = duration(video); starts = boundaries(video, a.min_len); ends = starts[1:] + [total]
    rows = []
    for i, (s, e) in enumerate(zip(starts, ends), 1):
        sid = f'S{i:03d}'; keys = []
        for q in (.15, .5, .85):
            k = out / 'keyframes' / f'{sid}-{int(q * 100)}.jpg'
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{s + (e - s) * q:.3f}', '-i', str(video), '-frames:v', '1', '-q:v', '3', str(k)], check=True)
            keys.append(str(k.relative_to(out)))
        strip = out / 'strips' / f'{sid}.jpg'; n = 6
        fps = n / max(e - s, .2)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{s:.3f}', '-t', f'{e - s:.3f}', '-i', str(video), '-vf', f'fps={fps:.4f},scale=480:-1,tile={n}x1',
                        '-frames:v', '1', '-q:v', '4', str(strip)], check=True)
        rows.append({'id': sid, 'start': round(s, 2), 'end': round(e, 2), 'seconds': round(e - s, 2), 'keyframes': keys, 'strip': str(strip.relative_to(out)),
                     'type_id': None, 'what': None, 'beats': None, 'reproduce': None, 'notes': None})
    meta = {'schema': 'opensay-reference-inventory-v1', 'video': str(video), 'seconds': round(total, 2), 'segments': rows,
            'fill_in': {'type_id': 'shot type this segment belongs to (same layout + same motion mechanism = same type)',
                        'what': 'one sentence: what is on screen and what moves',
                        'beats': 'list of {at: seconds from segment start, action} seen on full-resolution frames',
                        'reproduce': 'code | code+user-material | webgl | external-data | live-footage',
                        'notes': 'anything needed to rebuild it (fonts, assets, tech); split or merge segments here if the cut is wrong'}}
    (out / 'segments.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    cards = ''.join(f'<tr><td><b>{r["id"]}</b><br>{r["start"]:.1f}–{r["end"]:.1f}s<br>{r["seconds"]:.1f}s</td><td><img src="{r["strip"]}" loading="lazy"></td>'
                    f'<td>{" ".join(f"<a href={html.escape(k)}>全图</a>" for k in r["keyframes"])}</td></tr>' for r in rows)
    (out / 'contact.html').write_text(f'<!doctype html><meta charset="utf-8"><title>Reference inventory</title><style>body{{font:14px -apple-system,sans-serif;margin:16px}}'
                                      f'img{{width:100%;max-width:1440px}}td{{vertical-align:top;padding:4px 8px;border-bottom:1px solid #ddd}}</style>'
                                      f'<h1>{html.escape(video.name)} · {len(rows)} segments · {total:.0f}s</h1><table>{cards}</table>')
    print(json.dumps({'segments': len(rows), 'seconds': round(total, 1), 'out': str(out)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
