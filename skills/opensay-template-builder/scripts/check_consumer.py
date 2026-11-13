#!/usr/bin/env python3
"""Run the library-owned admission check for a new template or changed modules.

This wrapper never promotes a template or signs user/artistic approval. The
library's checker owns the contract and fixture rules; this skill stores only
an invocation receipt bound to the checked current bytes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(template: Path, library_root: Path | None = None,
          modules: list[str] | None = None, timeout: int = 180) -> dict:
    template = template.expanduser().resolve()
    root = (library_root.expanduser().resolve() if library_root else template.parent)
    result = {'schema': 'opensay-builder-admission-v1', 'template_path': str(template),
              'structure_valid': False, 'production_ready': False,
              'evidence_current': False, 'passed': False, 'errors': [], 'warnings': [],
              'user_approval': 'not_evaluated', 'artistic_approval': 'not_evaluated'}
    cli = root / '.opensay/opensay.py'
    manifest = template / 'capability/consumer.v1.json'
    if not template.is_relative_to(root) or template == root:
        result['errors'].append('TEMPLATE_OUTSIDE_LIBRARY: choose a template directory in the selected library')
        return result
    if not cli.is_file() or not manifest.is_file():
        result['errors'].append('CONSUMER_NOT_INSTALLED: library .opensay/opensay.py and template capability/consumer.v1.json are required')
        return result
    before, cli_hash = sha256(manifest), sha256(cli)
    command = [sys.executable, str(cli), 'builder-check', '--template', str(template)]
    if modules:
        command.extend(['--modules', ','.join(modules)])
    result['contract'] = {'path': str(manifest), 'sha256': before}
    result['checker'] = {'path': str(cli), 'sha256': cli_hash}
    result['requested_modules'] = modules or 'all'
    try:
        completed = subprocess.run(command, cwd=root, capture_output=True, text=True,
                                   timeout=timeout, check=False)
        report = json.loads(completed.stdout)
        if not isinstance(report, dict):
            raise ValueError('shared checker must return one JSON object')
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        result['errors'].append(f'CHECKER_FAILED: {exc}')
        return result
    result['shared_report'] = report
    result['checker_exit_code'] = completed.returncode
    for name in ('structure_valid', 'production_ready', 'evidence_current'):
        result[name] = report.get(name) is True
    result['modules'] = report.get('modules', [])
    result['errors'].extend(report.get('errors') or [])
    result['warnings'].extend(report.get('warnings') or [])
    if completed.returncode != 0:
        result['errors'].append(f'ADMISSION_REJECTED: shared checker exited {completed.returncode}')
    if not all(result[name] for name in ('structure_valid', 'production_ready', 'evidence_current')):
        result['errors'].append('ADMISSION_INCOMPLETE: structure, current evidence and production readiness must all pass')
    if not manifest.is_file() or sha256(manifest) != before or sha256(cli) != cli_hash:
        result['errors'].append('CHECK_INPUT_CHANGED: rerun the check against stable current files')
    result['passed'] = not result['errors']
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--template', required=True, type=Path)
    parser.add_argument('--library-root', type=Path,
                        default=Path(os.environ['OPENSAY_LIBRARY_ROOT']) if os.environ.get('OPENSAY_LIBRARY_ROOT') else None)
    parser.add_argument('--modules', help='Comma-separated newly added or changed module IDs; omit to check all')
    parser.add_argument('--report', type=Path, help='New work receipt path; existing receipts are never overwritten')
    args = parser.parse_args()
    modules = [v.strip() for v in (args.modules or '').split(',') if v.strip()]
    report = check(args.template, args.library_root, modules)
    payload = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.report:
        try:
            destination = args.report.expanduser().resolve()
            root = (args.library_root.expanduser().resolve() if args.library_root else args.template.expanduser().resolve().parent)
            if destination.is_relative_to(root):
                raise ValueError('admission receipts belong to the work directory, outside the library')
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open('x', encoding='utf-8') as stream:
                stream.write(payload)
        except (OSError, ValueError) as exc:
            report['passed'] = False
            report['errors'].append(f'REPORT_NOT_WRITTEN: {exc}')
            payload = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    print(payload, end='')
    return 0 if report['passed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
