#!/usr/bin/env python3
"""Compatibility entry: return shared OpenSay discovery, not all raw manifests."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path,
                        default=Path(os.environ.get('OPENSAY_LIBRARY_ROOT', str(Path.home() / 'Desktop/opensay'))))
    args = parser.parse_args()
    root = args.root.expanduser().resolve()
    cli = root / '.opensay/opensay.py'
    if not cli.is_file():
        print(json.dumps({'schema': 'opensay-template-discovery-v1', 'templates': [],
                          'errors': ['CONSUMER_NOT_INSTALLED: install the library shared .opensay tools first'],
                          'production_ready': False}, ensure_ascii=False))
        return 2
    completed = subprocess.run([sys.executable, str(cli), 'discover'], cwd=root,
                               capture_output=True, text=True, check=False)
    try:
        payload = json.loads(completed.stdout)
    except ValueError:
        payload = {'schema': 'opensay-template-discovery-v1', 'templates': [],
                   'errors': ['DISCOVERY_FAILED: shared tool did not return JSON'],
                   'production_ready': False}
        completed.returncode = 2
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return completed.returncode


if __name__ == '__main__':
    raise SystemExit(main())
