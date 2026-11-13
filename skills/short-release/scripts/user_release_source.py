"""Validate user-written release text (title, description, hashtags) without generating any wording.

The user types the text in the chat. The agent records that exact message in a snapshot
(record_user_release.py); every field must appear verbatim in it. This is an evidence record,
not a claim that hashes prove human authorship.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
from typing import Any

POLICY = "user-supplied-release-v1"
SNAPSHOT_SCHEMA = "short-release-user-chat-snapshot-v1"
DESCRIPTION_EXCEPTION_SCHEMA = "sticker-description-exception-v1"
DESCRIPTION_MAX = 50
# v1 evidence was issued for descriptions above the previous 30-character limit.
# Preserve that contract so existing exact-text authorizations remain verifiable.
LEGACY_DESCRIPTION_EXCEPTION_MAX = 30


def digest(value: bytes | str) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def is_user_release(data: dict[str, Any]) -> bool:
    return "user_release_source" in data or data.get("description_policy") == POLICY


def _nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _file(value: Any, expected_hash: Any, label: str, errors: list[str]) -> Path | None:
    if not _nonempty(value) or not Path(value).is_absolute():
        errors.append(f"{label} must be an absolute local file path")
        return None
    path = Path(value)
    try:
        contents = path.read_bytes()
    except OSError as exc:
        errors.append(f"{label} cannot be read: {exc}")
        return None
    if not contents or expected_hash != digest(contents):
        errors.append(f"{label} bytes do not match the recorded sha256")
        return None
    return path


def validate_description_authorization(payload: Any, description: str, record_id: str, errors: list[str]) -> bool:
    """Validate exact-text v1 evidence, including historical 31–50-character copies."""
    start = len(errors)
    count = sum(not c.isspace() for c in description)
    if not isinstance(payload, dict):
        errors.append("description authorization must be an object")
        return False
    expected = {"schema": DESCRIPTION_EXCEPTION_SCHEMA, "actor": "user",
                "decision": "preserve-exact-description", "record_id": record_id,
                "description_sha256": digest(description), "actual_count": count}
    for key, value in expected.items():
        if payload.get(key) != value or (key == "actual_count" and type(payload.get(key)) is not int):
            errors.append(f"description authorization differs at {key}")
    if count <= LEGACY_DESCRIPTION_EXCEPTION_MAX:
        errors.append(f"v1 description authorization is only for an exact description over {LEGACY_DESCRIPTION_EXCEPTION_MAX} characters")
    for key in ("instruction", "source"):
        if not _nonempty(payload.get(key)):
            errors.append(f"description authorization requires actual user {key}")
    return len(errors) == start


def validate_description_authorization_file(binding: Any, description: str, record_id: str,
                                            errors: list[str]) -> bool:
    if not isinstance(binding, dict):
        errors.append("long user description requires exact-text description authorization")
        return False
    path = _file(binding.get("path"), binding.get("sha256"), "description authorization", errors)
    if path is None:
        return False
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        errors.append(f"description authorization is invalid JSON: {exc}")
        return False
    return validate_description_authorization(payload, description, record_id, errors)


def _text(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, list) and all(isinstance(x, dict) and isinstance(x.get("text"), str) for x in value):
        return "".join(x["text"] for x in value)
    if isinstance(value, list) and len(value) == 1 and isinstance(value[0], str):
        return value[0]
    return value


def _tags(value: Any) -> list[str] | None:
    if isinstance(value, str):
        value = value.strip()
        if value.startswith("["):
            try:
                return _tags(json.loads(value))
            except ValueError:
                return None
        if "#" in value:
            if value.split("#", 1)[0].strip():
                return None
            value = value.split("#")[1:]
        elif re.search(r"[,，、;；\r\n]", value):
            value = re.split(r"[,，、;；\r\n]+", value)
        elif any(c.isspace() for c in value):
            return None
        else:
            value = [value]
    if not isinstance(value, list) or not all(isinstance(x, str) and x.strip() for x in value):
        return None
    return [x.strip().removeprefix("#").strip() for x in value]


def _row(payload: dict, record_id: str) -> dict:
    data = payload.get("data")
    if isinstance(data, dict) and isinstance(data.get("fields"), list) and "record_id_list" in data:
        matches = [v for rid, v in zip(data["record_id_list"], data.get("data", [])) if rid == record_id]
        if len(matches) != 1 or len(matches[0]) != len(data["fields"]):
            raise ValueError("archived row export does not identify the exact record")
        return dict(zip(data["fields"], matches[0]))
    fields = payload.get("fields", payload)
    rid = payload.get("_record_id") or payload.get("record_id") or fields.get("_record_id") or fields.get("record_id")
    if rid != record_id:
        raise ValueError("archived row export record_id differs")
    return fields


def validate_user_release_source(data: dict[str, Any], errors: list[str]) -> dict | None:
    """Read current snapshot/evidence bytes each time; exact wording is significant."""
    if not is_user_release(data):
        return None
    source = data.get("user_release_source")
    if not isinstance(source, dict):
        errors.append("user_release_source must be an object")
        return None
    if source.get("policy") != POLICY:
        errors.append(f"user_release_source.policy must be {POLICY}")
    if data.get("description_policy") != POLICY:
        errors.append(f"description_policy must be {POLICY} for user release inputs")
    if "doubao_source" in data:
        errors.append("user-written release copy must not contain doubao_source")
    if data.get("status") != "approved":
        errors.append("user-written release copy requires the recorded production instruction and approved status")
    path = _file(source.get("snapshot_path"), source.get("snapshot_sha256"), "user release snapshot", errors)
    if path is None:
        return None
    try:
        snapshot = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        errors.append(f"user release snapshot is invalid JSON: {exc}")
        return None
    if not isinstance(snapshot, dict) or snapshot.get("schema") != SNAPSHOT_SCHEMA:
        errors.append(f"user release snapshot schema must be {SNAPSHOT_SCHEMA}")
        return None
    message = snapshot.get("user_message")
    if not _nonempty(message):
        errors.append("user chat snapshot needs the user's exact message (user_message)")
        return None
    if snapshot.get("user_message_sha256") != digest(message):
        errors.append("user_message_sha256 must match the recorded user message")
    for field in ("title", "description", "hashtags"):
        if data.get(field) != snapshot.get(field):
            errors.append(f"{field} must exactly equal the user chat snapshot")
    title, desc, tags = snapshot.get("title"), snapshot.get("description"), snapshot.get("hashtags")
    if not _nonempty(title) or title.strip() not in message:
        errors.append("title must appear verbatim in the user's message; never write or rewrite it")
    if not _nonempty(desc):
        errors.append(f"user description must contain 1–{DESCRIPTION_MAX} Unicode code points excluding whitespace")
    else:
        if desc.strip() not in message:
            errors.append("description must appear verbatim in the user's message; never write or rewrite it")
        if sum(not x.isspace() for x in desc) > DESCRIPTION_MAX and snapshot.get("description_over_limit_confirmed") is not True:
            errors.append(f"user description over {DESCRIPTION_MAX} characters needs the user's explicit confirmation to keep it as is")
    if not isinstance(tags, list) or len(tags) != 5 or not all(_nonempty(x) for x in tags):
        errors.append("user hashtags must contain exactly five non-empty strings; list what is missing and ask the user, never auto-fill")
    elif len(set(tags)) != len(tags):
        errors.append("user hashtags contain duplicate labels; never auto-deduplicate")
    elif any(str(x).lstrip("#＃").strip() not in message for x in tags):
        errors.append("every hashtag must appear verbatim in the user's message")
    if snapshot.get("actor") != "user":
        errors.append("user chat snapshot actor must be user")
    if source.get("authorization_note") != message:
        errors.append("user_release_source.authorization_note must exactly equal the recorded user message")
    title_source = data.get("title_source")
    if not isinstance(title_source, dict) or title_source.get("approval_note") != message:
        errors.append("title_source approval must reuse the user's recorded message")
    return snapshot
