#!/usr/bin/env python3
"""Where does a module differ from its reference shot? Use when fidelity_report.py flags a pair (too still, frozen tail, too many/few
beats) and you need to know WHAT is missing before changing code.

  python3 diff_regions.py --ref /abs/ref.mp4 --start 49.0 --end 52.0 --mod /abs/module.mp4 [--grid 3x3] [--fps 10]
         [--sample 0.5,2.9]            # also print colours of both at these times on a 5x5 point grid

Prints, per 0.1 s step, how much of each region changes (share of a 192x108 luma thumbnail moving by >10 levels) for the
reference and the module side by side, then a per-region summary: active steps and mean change. A region where the reference
keeps moving and the module does not is the place to look (open full-resolution frames of the reference there at 30 fps).
Fix by reproducing the motion the reference has in that region; do not add motion the reference does not have just to pass the gate.
"""
import argparse, subprocess
import numpy as np

W, H = 192, 108


def frames(path, start=None, dur=None, fps=10, gray=True):
    cmd = ['ffmpeg', '-v', 'error'] + (['-ss', str(start), '-t', str(dur)] if start is not None else []) + ['-i', path, '-vf', f'fps={fps},scale={W}:{H}' + (',format=gray' if gray else ''),
                                                                                                            *([] if gray else ['-pix_fmt', 'rgb24']), '-f', 'rawvideo', '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape((-1, H, W) if gray else (-1, H, W, 3)).astype(np.int16)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--ref', required=True); ap.add_argument('--start', type=float, required=True); ap.add_argument('--end', type=float, required=True)
    ap.add_argument('--mod', required=True); ap.add_argument('--grid', default='3x3'); ap.add_argument('--fps', type=int, default=10); ap.add_argument('--sample', default='')
    a = ap.parse_args(); gx, gy = map(int, a.grid.split('x')); dur = a.end - a.start
    r, m = frames(a.ref, a.start, dur, a.fps), frames(a.mod, 0, dur, a.fps); n = min(len(r), len(m))
    names = [f'{"top mid bot".split()[j] if gy == 3 else "r" + str(j)}-{"left mid right".split()[i] if gx == 3 else "c" + str(i)}' for j in range(gy) for i in range(gx)]
    def regions(f, k):
        d = np.abs(f[k] - f[k - 1]) > 10
        return [float(d[j * H // gy:(j + 1) * H // gy, i * W // gx:(i + 1) * W // gx].mean()) for j in range(gy) for i in range(gx)]
    R = np.array([regions(r, k) for k in range(1, n)]); M = np.array([regions(m, k) for k in range(1, n)])
    print('step   ' + '  '.join(f'{x:>13}' for x in names) + '   (ref/mod share of region changing)')
    for k in range(n - 1):
        cells = []
        for c in range(len(names)):
            mark = ' <' if R[k, c] >= .02 and M[k, c] < R[k, c] / 3 else (' >' if M[k, c] >= .02 and R[k, c] < M[k, c] / 3 else '  ')
            cells.append(f'{R[k, c]:.3f}/{M[k, c]:.3f}{mark}')
        print(f'{(k + 1) / a.fps:4.1f}s  ' + ' '.join(f'{x:>15}' for x in cells))
    print('\nregion summary (active = steps with >=2% of the region changing):')
    for c, nm in enumerate(names):
        ra, ma = int((R[:, c] >= .02).sum()), int((M[:, c] >= .02).sum())
        verdict = 'module stiller here' if ra > ma * 1.5 + 1 else 'module busier here' if ma > ra * 1.5 + 1 else 'similar'
        print(f'  {nm:>12}: ref active {ra:3d}, mean {R[:, c].mean():.3f} | mod active {ma:3d}, mean {M[:, c].mean():.3f}  -> {verdict}')
    print("  ('<' in the table = the reference moves there and the module hardly does; '>' = the opposite)")
    for ts in [float(x) for x in a.sample.split(',') if x.strip()]:
        rc = frames(a.ref, a.start + ts, .1, 10, gray=False)[0]; mc = frames(a.mod, ts, .1, 10, gray=False)[0]
        print(f'\ncolours at {ts:.2f}s (ref | mod), 5x5 points:')
        for j in range(5):
            row = []
            for i in range(5):
                y, x = int((j + .5) * H / 5), int((i + .5) * W / 5)
                rr, mm = rc[y - 1:y + 2, x - 1:x + 2].mean((0, 1)).astype(int), mc[y - 1:y + 2, x - 1:x + 2].mean((0, 1)).astype(int)
                row.append('#%02X%02X%02X|#%02X%02X%02X' % (*rr, *mm))
            print('  ' + ' '.join(row))


if __name__ == '__main__':
    main()
