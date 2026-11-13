#!/usr/bin/env python3
"""Workflow host check only. This does not authenticate a client or protect files."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import stat
import subprocess

REPORT_SCHEMA = 'opensay-builder-host-context-v1'


def inspect_host(ancestors: list[str], env: dict[str, str]) -> dict:
    process_hosts = set()
    for executable in ancestors:
        name = Path(executable).name.lower()
        if name in {'codex', 'codex.exe', 'codex-app-server', 'codex-app-server.exe'}:
            process_hosts.add('codex')
        if name in {'claude', 'claude.exe'}:
            process_hosts.add('claude-code')
    environment_hosts = set()
    # Presence is an accidental-use hint, never an attestation. Do not print values.
    if env.get('CODEX_THREAD_ID'):
        environment_hosts.add('codex')
    if env.get('CLAUDECODE') == '1':
        environment_hosts.add('claude-code')
    all_hosts = process_hosts | environment_hosts
    conflict = len(all_hosts) > 1
    host = next(iter(all_hosts)) if len(all_hosts) == 1 else 'unknown'
    model = env.get('OPENSAY_EFFECTIVE_MODEL')
    return {
        'schema': REPORT_SCHEMA,
        'observed_host': host,
        'allowed_by_workflow': host in {'codex', 'claude-code'} and not conflict,
        'detection': 'conflicting' if conflict else 'process' if process_hosts else 'environment_hint' if environment_hosts else 'unknown',
        'process_evidence': sorted(process_hosts),
        'environment_presence': {key: bool(env.get(key)) for key in ['CODEX_THREAD_ID', 'CLAUDECODE']},
        'authenticated': False,
        'security_boundary': 'none; process names and environment can be imitated by the same OS user',
        'model': {'identifier': model or 'unknown', 'evidence': 'unverified_environment_hint' if model else 'not_exposed', 'verified': False},
        'next_action': 'continue_authorized_template_work_without_silent_model_downgrade' if host in {'codex', 'claude-code'} and not conflict else 'handoff_request_only; keep_template_read_only',
    }


def parent_executables() -> list[str]:
    result, seen = [], set()
    pid = os.getppid()
    for _ in range(12):
        if pid <= 1 or pid in seen:
            break
        seen.add(pid)
        try:
            row = subprocess.run(['ps', '-p', str(pid), '-o', 'ppid=,comm='], capture_output=True, text=True, timeout=3)
            parts = row.stdout.strip().split(None, 1)
            if row.returncode or len(parts) != 2:
                break
            pid = int(parts[0])
            result.append(parts[1])
        except (OSError, ValueError, subprocess.TimeoutExpired):
            break
    return result


def write_report(destination: Path, payload: str, library_roots: list[Path], refresh: bool = False) -> None:
    """Create a work report, or explicitly refresh the same report schema.

    This is an accidental-output safeguard, not a permission boundary against
    concurrent malicious filesystem changes by the same OS user.
    """
    requested = destination.expanduser()
    if requested.is_symlink():
        raise ValueError('Report destination must not be a symbolic link')
    actual = requested.resolve()
    protected_roots = [root.expanduser().resolve() for root in library_roots]
    if any(actual.is_relative_to(root) for root in protected_roots):
        raise ValueError('Report destination must be outside every OpenSay template library')
    # A custom library may not have been supplied as a CLI option. A template's
    # own capability marker still forbids writing diagnostic output inside it.
    if any((parent / 'capability.json').is_file() for parent in actual.parents):
        raise ValueError('Report destination must be outside a template directory')
    actual.parent.mkdir(parents=True, exist_ok=True)
    nofollow = getattr(os, 'O_NOFOLLOW', 0)
    if not refresh:
        descriptor = os.open(actual, os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            stream.write(payload)
        return
    # Opening without O_CREAT means an explicit refresh cannot accidentally
    # create another file. O_NOFOLLOW also covers last-component link races.
    descriptor = os.open(actual, os.O_RDWR | nofollow)
    with os.fdopen(descriptor, 'r+', encoding='utf-8') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('Refresh requires one regular, single-link host report file')
        try:
            previous = json.load(stream)
        except (ValueError, UnicodeError) as exc:
            raise ValueError('Refresh requires an existing report with the same schema') from exc
        if not isinstance(previous, dict) or previous.get('schema') != REPORT_SCHEMA:
            raise ValueError('Refresh requires an existing report with the same schema')
        stream.seek(0)
        stream.write(payload)
        stream.truncate()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, help='Save the non-secret observation to an episode work directory')
    parser.add_argument('--refresh-report', action='store_true', help='Explicitly refresh an existing host report of the same schema; never overwrite other files')
    parser.add_argument('--library-root', type=Path, action='append', default=[], help='Additional OpenSay library to protect; default Desktop/opensay remains protected')
    args = parser.parse_args()
    if args.refresh_report and not args.report:
        parser.error('--refresh-report requires --report')
    report = inspect_host(parent_executables(), os.environ)
    payload = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.report:
        try:
            write_report(args.report, payload, [Path.home() / 'Desktop/opensay', *args.library_root], args.refresh_report)
        except (OSError, ValueError, RuntimeError) as exc:
            print(json.dumps({'schema': REPORT_SCHEMA, 'allowed_by_workflow': False, 'report_written': False, 'errors': [str(exc)]}, ensure_ascii=False))
            return 2
    print(payload, end='')
    return 0 if report['allowed_by_workflow'] else 3


if __name__ == '__main__':
    raise SystemExit(main())
