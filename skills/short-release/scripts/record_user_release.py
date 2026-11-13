#!/usr/bin/env python3
"""Record the title, description and hashtags the user typed in the chat, exactly as typed.

The agent passes the user's whole message and the three pieces taken from it. Every piece must
appear verbatim in the message: this script never writes, rewrites, shortens or completes text.
Writes <out>/user_chat_snapshot.json and <out>/release_copy.json (the user-supplied-release-v1 fields
for the handoff). Missing or extra pieces are reported so the agent can ask the user.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from user_release_source import POLICY, SNAPSHOT_SCHEMA, digest, validate_user_release_source  # noqa: E402


def build(message: str, title: str, description: str, tags: list[str], out: Path, over_limit_ok: bool = False) -> dict:
    out = out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    snapshot = {'schema': SNAPSHOT_SCHEMA, 'actor': 'user', 'user_message': message, 'user_message_sha256': digest(message),
                'title': title, 'description': description, 'hashtags': tags,
                'recorded_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    if over_limit_ok:
        snapshot['description_over_limit_confirmed'] = True
    snap_path = out / 'user_chat_snapshot.json'
    snap_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    copy = {'title': title, 'description': description, 'hashtags': tags, 'status': 'approved', 'description_policy': POLICY,
            'user_release_source': {'policy': POLICY, 'snapshot_path': str(snap_path), 'snapshot_sha256': hashlib.sha256(snap_path.read_bytes()).hexdigest(),
                                    'authorization_note': message},
            'title_source': {'policy': 'reuse-upstream-title-v1', 'field': 'user-supplied', 'value': title,
                             'sha256': hashlib.sha256(title.encode('utf-8')).hexdigest(), 'approval_note': message}}
    errors: list[str] = []
    validate_user_release_source(copy, errors)
    if errors:
        snap_path.unlink(missing_ok=True)
        return {'passed': False, 'errors': errors, 'next': '把缺的或对不上的项列给用户，请用户补或改；不要代写'}
    (out / 'release_copy.json').write_text(json.dumps(copy, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'passed': True, 'release_copy': str(out / 'release_copy.json'), 'snapshot': str(snap_path)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--message-file', type=Path, required=True, help='the user\'s exact chat message, saved as UTF-8 text')
    ap.add_argument('--title', required=True)
    ap.add_argument('--description', required=True)
    ap.add_argument('--tag', action='append', default=[], help='repeat for each hashtag, as the user typed it')
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--description-over-limit-confirmed', action='store_true', help='only when the user explicitly keeps a description over 50 characters')
    a = ap.parse_args()
    result = build(a.message_file.read_text(encoding='utf-8'), a.title, a.description, a.tag, a.out, a.description_over_limit_confirmed)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['passed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
