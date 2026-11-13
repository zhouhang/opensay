#!/usr/bin/env python3
"""Resolve sticker's sample/full output profiles and verify real rendered media.

Only stage geometry is projected; the source plan, voice and seconds timeline
are never edited. Frame-based plans must be recompiled from their true seconds
before changing fps, rather than silently replaying old frame numbers.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

SCHEMA = 'sticker-output-profiles-v1'
STAGES = {'sample': (1080, 30), 'full': (1080, 30)}


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError(f'Expected a JSON object: {path}')
    return value


def save_new(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as f:
        f.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def positive_integer(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f'{label} must be a positive integer')
    return value


def ratio_of(plan: dict) -> Fraction:
    value = plan.get('aspect_ratio')
    if value is not None:
        match = re.fullmatch(r'\s*(\d+)\s*[:：/]\s*(\d+)\s*', str(value))
        if not match or int(match[1]) <= 0 or int(match[2]) <= 0:
            raise ValueError('aspect_ratio must be a positive ratio such as16:9')
        return Fraction(int(match[1]), int(match[2]))
    output = plan.get('output') or {}
    if output.get('width') and output.get('height'):
        return Fraction(positive_integer(output['width'], 'output.width'),
                        positive_integer(output['height'], 'output.height'))
    raise ValueError('Missing episode aspect_ratio or known output width/height; do not guess orientation')


def even_round(value: Fraction) -> int:
    return max(2, 2 * round(value / 2))


def resolve_profiles(plan: dict) -> dict:
    ratio = ratio_of(plan)
    overrides = plan.get('output_profiles') or {}
    if not isinstance(overrides, dict) or overrides.get('schema', SCHEMA) != SCHEMA:
        raise ValueError(f'output_profiles must be {SCHEMA}')
    profiles = {'schema': SCHEMA}
    for stage, (short, fps) in STAGES.items():
        width, height = ((even_round(short * ratio), short) if ratio >= 1
                         else (short, even_round(short / ratio)))
        profile = {'width': width, 'height': height, 'fps': fps}
        override = overrides.get(stage, {})
        if not isinstance(override, dict) or set(override) - set(profile):
            raise ValueError(f'output_profiles.{stage} only accepts width/height/fps')
        if ('width' in override) != ('height' in override):
            raise ValueError(f'{stage} dimension override needs both width and height')
        profile.update(override)
        for key in profile:
            positive_integer(profile[key], f'{stage}.{key}')
        if profile['width'] % 2 or profile['height'] % 2:
            raise ValueError(f'{stage} dimensions must be even for the delivery codec')
        profiles[stage] = profile
    return profiles


def frame_fields(value, prefix=''):
    """Find cached frame clocks; their rate cannot be inferred from their names."""
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            location = f'{prefix}.{key}' if prefix else key
            if key in {'frames', 'durationFrames', 'startFrame', 'endFrame', 'atFrame',
                       'hostStartFrame', 'screenStartFrame'} or key.endswith(('_frame', '_frames')):
                found.append(location)
            else:
                found += frame_fields(item, location)
    elif isinstance(value, list):
        for i, item in enumerate(value):
            found += frame_fields(item, f'{prefix}[{i}]')
    return found


def project_plan(plan: dict, stage: str, duration_seconds: float | None = None) -> tuple[dict, dict]:
    if stage not in STAGES:
        raise ValueError('stage must be sample or full')
    profiles = resolve_profiles(plan)
    target = profiles[stage]
    old_output = plan.get('output') or {}
    old_fps = old_output.get('fps')
    if old_fps is not None:
        positive_integer(old_fps, 'output.fps')
    content = {k: v for k, v in plan.items() if k not in {'output', 'output_profiles', 'output_stage'}}
    cached = frame_fields(content)
    output_frames = [k for k in old_output if k in {'frames', 'durationFrames'} or k.endswith('_frames')]
    # Output-local clocks need the same guard as shot clocks. Duration counts can
    # be derived again; positions must be recompiled by the actual executor.
    cached += [key for key in frame_fields(old_output, 'output')
               if key.removeprefix('output.') not in output_frames]
    if (cached or output_frames) and old_fps is None:
        raise ValueError('Frame-based plan has no declared output.fps; rebuild from the true seconds timeline')
    if cached and old_fps != target['fps']:
        raise ValueError('Recompile frame-based fields from the unchanged seconds timeline before changing fps: '
                         + ', '.join(cached[:8]))
    result = deepcopy(plan)
    result['output_profiles'] = profiles
    result['output_stage'] = stage
    result['output'] = {**old_output, **target}
    duration = duration_seconds
    if duration is None:
        duration = old_output.get('duration_seconds')
    if duration is None and output_frames:
        counts = {Fraction(str(old_output[k])) / old_fps for k in output_frames}
        if len(counts) != 1:
            raise ValueError('Conflicting output frame counts; resolve against actual audio duration')
        duration = float(counts.pop())
    if duration is not None:
        exact = Fraction(str(duration))
        if exact <= 0:
            raise ValueError('duration_seconds must be positive')
        result['output']['duration_seconds'] = float(exact)
        for key in output_frames:
            result['output'][key] = round(exact * target['fps'])
    profile = {'schema': 'sticker-render-stage-v1', 'stage': stage, 'target': target,
               'duration_seconds': float(duration) if duration is not None else None,
               'timeline_policy': 'Seconds and original voice unchanged; compile frame clocks at targetfps.',
               'native_render_policy': 'Render text/vector/layout at target canvas. Declare raster-source limits; no claim of recovered detail.',
               'approval': None}
    return result, profile


def prepare(plan_path: Path, stage: str, out_dir: Path, duration_seconds=None) -> dict:
    if out_dir.exists():
        raise ValueError('Use a new stage output directory; original plan and prior stage are preserved')
    plan, profile = project_plan(load(plan_path), stage, duration_seconds)
    source = {'path': str(plan_path.resolve()), 'sha256': sha(plan_path)}
    out_dir.mkdir(parents=True)
    runtime = out_dir / 'episode_plan.json'
    save_new(runtime, plan)
    profile.update(source_plan=source, runtime_plan={'path': str(runtime.resolve()), 'sha256': sha(runtime)})
    save_new(out_dir / 'output-profile.json', profile)
    return profile


def check_spec(profile: dict, spec: dict) -> dict:
    target = profile['target']
    errors = [f'{key}: expected{target[key]}, got{spec.get(key)}'
              for key in ('width', 'height', 'fps') if spec.get(key) != target[key]]
    duration = profile.get('duration_seconds')
    if duration is not None:
        frames = spec.get('duration_frames')
        if isinstance(frames, bool) or not isinstance(frames, int) or abs(frames - duration * target['fps']) > 1:
            errors.append('duration_frames does not match unchanged seconds at this stagefps')
    return {'passed': not errors, 'errors': errors, 'stage': profile['stage'], 'target': target}


def check_media(profile: dict, video: Path) -> dict:
    result = subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0',
                             '-show_streams', '-show_format', '-of', 'json', str(video)],
                            capture_output=True, text=True, check=True)
    data = json.loads(result.stdout)
    streams = data.get('streams') or []
    if len(streams) != 1:
        raise ValueError('No unambiguous first video stream in the actual file')
    v = streams[0]; target = profile['target']; errors = []
    actual = {'width': v['width'], 'height': v['height'],
              'fps': v.get('avg_frame_rate'), 'r_frame_rate': v.get('r_frame_rate'),
              'decoded_frames': int(v['nb_read_frames']),
              'duration_seconds': float(v.get('duration') or data['format']['duration'])}
    for key in ('width', 'height'):
        if actual[key] != target[key]:
            errors.append(f'Actual {key} differs from stage target')
    if any(Fraction(actual[key] or '0/1') != target['fps'] for key in ('fps', 'r_frame_rate')):
        errors.append('Actual video rate differs from stage target')
    duration = profile.get('duration_seconds')
    if duration is not None:
        if abs(actual['decoded_frames'] - duration * target['fps']) > 1:
            errors.append('Decoded frame count differs from unchanged duration at targetfps')
        if abs(actual['duration_seconds'] - duration) * target['fps'] > 1.00001:
            errors.append('Actual duration differs by more than one target frame')
    return {'schema': 'sticker-stage-media-check-v1', 'passed': not errors, 'errors': errors,
            'stage': profile['stage'], 'target': target, 'actual': actual,
            'video': str(video.resolve()), 'video_sha256': sha(video),
            'scope': 'Stage geometry/frame-count guard only; also run a full decode, audio and subtitle QC on the final file.',
            'user_approved': False}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    cmd = sub.add_parser('prepare')
    cmd.add_argument('--plan', type=Path, required=True)
    cmd.add_argument('--stage', choices=STAGES, required=True)
    cmd.add_argument('--out-dir', type=Path, required=True)
    cmd.add_argument('--duration-seconds', type=float)
    for name in ('check-spec', 'check-media'):
        cmd = sub.add_parser(name)
        cmd.add_argument('--profile', type=Path, required=True)
        cmd.add_argument('--spec' if name == 'check-spec' else '--video', type=Path, required=True)
        cmd.add_argument('--out', type=Path)
    args = p.parse_args()
    try:
        if args.command == 'prepare':
            value = prepare(args.plan, args.stage, args.out_dir, args.duration_seconds)
        else:
            profile = load(args.profile)
            if profile.get('schema') != 'sticker-render-stage-v1':
                raise ValueError('Expected a prepared sticker-render-stage-v1 profile')
            value = (check_spec(profile, load(args.spec)) if args.command == 'check-spec'
                     else check_media(profile, args.video))
            if args.out:
                save_new(args.out, value)
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 0 if value.get('passed', True) else 1
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print(json.dumps({'passed': False, 'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
