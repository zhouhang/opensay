#!/usr/bin/env python3
"""Read-only OpenSay request validation. No downloads, template writes or approval."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
from urllib.parse import urlparse

SCHEMA = Path(__file__).resolve().parents[1] / 'references/template-request.schema.json'


def shape(value, schema, where='$') -> list[str]:
    errors = []
    kinds = {'object': lambda v: isinstance(v, dict), 'array': lambda v: isinstance(v, list),
             'string': lambda v: isinstance(v, str), 'integer': lambda v: isinstance(v, int) and not isinstance(v, bool),
             'number': lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)}
    kind = schema.get('type')
    if kind and not kinds[kind](value):
        return [f'{where}: expected {kind}']
    if 'const' in schema and value != schema['const']:
        errors.append(f'{where}: expected {schema["const"]!r}')
    if 'enum' in schema and value not in schema['enum']:
        errors.append(f'{where}: not in allowed values')
    if isinstance(value, dict):
        errors += [f'{where}.{key}: required' for key in schema.get('required', []) if key not in value]
        properties = schema.get('properties', {})
        if schema.get('additionalProperties') is False:
            errors += [f'{where}.{key}: unknown field' for key in value if key not in properties]
        for key, item in value.items():
            if key in properties:
                errors += shape(item, properties[key], f'{where}.{key}')
    if isinstance(value, list):
        if len(value) < schema.get('minItems', 0):
            errors.append(f'{where}: too few items')
        for i, item in enumerate(value):
            errors += shape(item, schema.get('items', {}), f'{where}[{i}]')
    if isinstance(value, str):
        if len(value.strip()) < schema.get('minLength', 0):
            errors.append(f'{where}: empty or too short')
        if 'pattern' in schema and not re.fullmatch(schema['pattern'], value):
            errors.append(f'{where}: invalid format')
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if 'minimum' in schema and value < schema['minimum']:
            errors.append(f'{where}: below minimum')
        if 'exclusiveMinimum' in schema and value <= schema['exclusiveMinimum']:
            errors.append(f'{where}: below exclusive minimum')
    for rule in schema.get('allOf', []):
        if 'if' in rule and not shape(value, rule['if'], where):
            errors += shape(value, rule.get('then', {}), where)
        elif 'if' not in rule:
            errors += shape(value, rule, where)
    return errors


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def absolute_file(value, label, errors):
    path = Path(value).expanduser()
    if not path.is_absolute() or not path.is_file():
        errors.append(f'{label}: absolute existing file required')
        return None
    return path.resolve()


def validate(request: dict) -> dict:
    errors = shape(request, json.loads(SCHEMA.read_text()))
    report = {'schema': 'opensay-template-request-validation-v1', 'passed': False, 'errors': errors,
              'warnings': [], 'scope': 'request_structure_source_hashes_and_shot_binding_only',
              'template_write_performed': False, 'user_approved': False}
    if errors:
        return report
    root = Path(request['library_root']).expanduser()
    if not root.is_absolute() or not root.is_dir():
        errors.append('library_root: absolute existing directory required')
        return report
    root = root.resolve()
    selected = request['target_template']
    target = root / selected['slug']
    report['template_path'] = str(target)
    # Follow symlinks before checking the permitted direct-child boundary.
    if target.resolve().parent != root:
        errors.append('target_template: must resolve to a direct child of library_root')
    for reference in request.get('references', []):
        if reference['kind'] == 'file':
            path = absolute_file(reference['location'], 'reference', errors)
            if path and reference.get('sha256') and sha(path) != reference['sha256']:
                errors.append('reference: file hash changed')
        elif urlparse(reference['location']).scheme not in {'http', 'https'} or not urlparse(reference['location']).netloc:
            errors.append('reference: public HTTP(S) URL required')
    if request['mode'] == 'create-template':
        if target.exists():
            errors.append('target_template: already exists; use extend-template instead of overwriting')
        if any(key in selected for key in ['template_id', 'version', 'capability_sha256']):
            report['warnings'].append('New-template identity is proposed, not an existing verified version')
    else:
        try:
            capability_path = target / 'capability.json'
            capability = json.loads(capability_path.read_text())
            if sha(capability_path) != selected['capability_sha256']:
                errors.append('target_template: capability hash changed')
            if capability.get('template_id') != selected['template_id'] or capability.get('version') != selected['version']:
                errors.append('target_template: current ID/version differs from request')
        except (OSError, ValueError) as exc:
            errors.append(f'target_template: capability unreadable: {exc}')
        episode = request['episode_plan']
        path = absolute_file(episode['path'], 'episode_plan', errors)
        if path:
            if sha(path) != episode['sha256']:
                errors.append('episode_plan: file hash changed')
            try:
                plan = json.loads(path.read_text())
                selected_in_plan = plan.get('template_selection') or {}
                if selected_in_plan.get('id') and selected_in_plan['id'] != selected['template_id']:
                    errors.append('episode_plan: selected template ID differs from request')
                if selected_in_plan.get('path') and Path(selected_in_plan['path']).expanduser().resolve() != target.resolve():
                    errors.append('episode_plan: selected template path differs from request')
                if (selected_in_plan.get('capability_sha256')
                        and selected_in_plan['capability_sha256'] != selected['capability_sha256']):
                    errors.append('episode_plan: template binding predates current capability; reconcile affected changes before development')
                shot_rows = plan.get('shots') or []
                by_id = {shot.get('shot_id'): shot for shot in shot_rows}
                if len(by_id) != len(shot_rows):
                    errors.append('episode_plan: duplicate shot IDs')
                seen = set()
                for issue in request['issues']:
                    sid = issue['shot_id']
                    if sid in seen:
                        errors.append(f'{sid}: duplicate issue; combine its reasons')
                    seen.add(sid)
                    shot = by_id.get(sid)
                    if not shot:
                        errors.append(f'{sid}: no matching shot in bound plan')
                        continue
                    a, b = shot.get('start'), shot.get('end')
                    finite = lambda v: isinstance(v, (float, int)) and not isinstance(v, bool) and math.isfinite(v)
                    if not finite(a) or not finite(b) or a < 0 or b <= a:
                        errors.append(f'{sid}: invalid real shot interval')
                    if not shot.get('sentence_ids') or not shot.get('narration_text') or not shot.get('visual_intent'):
                        errors.append(f'{sid}: sentence IDs, narration and visual intent are required in bound plan')
                report['bound_shots'] = sorted(seen)
            except (OSError, ValueError, TypeError, AttributeError) as exc:
                errors.append(f'episode_plan: invalid plan: {exc}')
    report['warnings'].append('Passing this request does not verify renderer, style, media rights, host authentication or user approval')
    report['passed'] = not errors
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request', type=Path)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    try:
        request = json.loads(args.request.read_text())
        report = validate(request)
    except (OSError, ValueError) as exc:
        report = {'passed': False, 'errors': [str(exc)], 'template_write_performed': False}
    output = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.report:
        destination = args.report.expanduser().resolve()
        library = request.get('library_root') if isinstance(locals().get('request'), dict) else None
        if destination == args.request.expanduser().resolve() or (library and destination.is_relative_to(Path(library).expanduser().resolve())):
            print(json.dumps({'passed': False, 'errors': ['Report must be outside the template library and must not overwrite the request'], 'template_write_performed': False}, ensure_ascii=False))
            return 2
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(output)
    print(output, end='')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
