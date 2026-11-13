#!/usr/bin/env python3
"""Issue and verify one-time user approval for building a release package.

The producer is responsible for asking the user whether a package should be built.
This module records that answer and binds it to the exact handoff, referenced media
bytes, release revision, local OS account, and destination directory.  It never asks
the user a second time.
"""

from __future__ import annotations

import getpass
import hashlib
import json
import os
import pwd
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

import build_publish_package


APPROVAL_SCHEMA = "release-package-approval-v1"
DEFAULT_APPROVAL_TTL_SECONDS = 15 * 60
MAX_APPROVAL_TTL_SECONDS = 60 * 60


class PackageApprovalError(RuntimeError):
    """Raised when package generation is not authorized by a current receipt."""


def _canonical_json_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise PackageApprovalError(f"value is not canonical JSON: {exc}") from exc


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _current_user() -> str:
    """Return the effective OS account, ignoring spoofable environment variables."""
    try:
        return pwd.getpwuid(os.geteuid()).pw_name
    except (KeyError, AttributeError):
        return getpass.getuser()


def _coerce_now(value: datetime | None) -> datetime:
    current = value or datetime.now(timezone.utc)
    if current.tzinfo is None or current.utcoffset() is None:
        raise PackageApprovalError("now must be timezone-aware")
    return current.astimezone(timezone.utc)


def _timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _parse_timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise PackageApprovalError(f"{field} must be a non-empty timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise PackageApprovalError(f"{field} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise PackageApprovalError(f"{field} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PackageApprovalError(f"cannot read {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise PackageApprovalError(f"{label} root must be an object")
    return value


def _atomic_write_json(path: Path, value: Mapping[str, Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(
        dict(value), ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False
    ) + "\n"
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            delete=False,
        ) as handle:
            temporary_name = handle.name
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
        temporary_name = None
    finally:
        if temporary_name is not None:
            try:
                Path(temporary_name).unlink()
            except FileNotFoundError:
                pass


def _validate_ttl(ttl_seconds: int) -> int:
    if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int):
        raise PackageApprovalError("ttl_seconds must be an integer")
    if ttl_seconds <= 0 or ttl_seconds > MAX_APPROVAL_TTL_SECONDS:
        raise PackageApprovalError(
            f"ttl_seconds must be between 1 and {MAX_APPROVAL_TTL_SECONDS}"
        )
    return ttl_seconds


def _input_manifest(
    handoff_path: Path,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]], str]:
    handoff_path = handoff_path.expanduser().resolve()
    handoff = build_publish_package.read_json(handoff_path)
    resolved = build_publish_package.validate_handoff(handoff)
    inputs: dict[str, dict[str, Any]] = {}
    for field, path in sorted(resolved.items()):
        current = path.resolve()
        inputs[field] = {
            "path": str(current),
            "size_bytes": current.stat().st_size,
            "sha256": _file_sha256(current),
        }
    return handoff, inputs, _sha256_bytes(_canonical_json_bytes(inputs))


def create_package_approval(
    handoff_path: Path,
    output_dir: Path,
    output_path: Path,
    *,
    confirmed_by_user: bool,
    ttl_seconds: int = DEFAULT_APPROVAL_TTL_SECONDS,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Record the producer's explicit, current user confirmation."""
    if confirmed_by_user is not True:
        raise PackageApprovalError(
            "package approval requires an explicit --confirmed-by-user attestation"
        )
    ttl = _validate_ttl(ttl_seconds)
    handoff_path = handoff_path.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    handoff, inputs, manifest_hash = _input_manifest(handoff_path)
    approved_at = _coerce_now(now)
    receipt = {
        "schema_version": APPROVAL_SCHEMA,
        "approval_id": str(uuid.uuid4()),
        "confirmed_by_user": True,
        "approved_by_os_user": _current_user(),
        "approved_at": _timestamp(approved_at),
        "expires_at": _timestamp(approved_at + timedelta(seconds=ttl)),
        "handoff": str(handoff_path),
        "handoff_sha256": _file_sha256(handoff_path),
        "producer_skill": handoff["producer_skill"],
        "release_revision_id": handoff["release_revision_id"],
        "output_dir": str(output_dir),
        "inputs": inputs,
        "inputs_sha256": manifest_hash,
    }
    _atomic_write_json(output_path, receipt)
    return receipt


def verify_package_approval(
    approval_path: Path,
    handoff_path: Path,
    output_dir: Path,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Require an unexpired receipt for these exact current inputs and destination."""
    approval_path = approval_path.expanduser().resolve()
    handoff_path = handoff_path.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    receipt = _read_json(approval_path, "package approval")

    if receipt.get("schema_version") != APPROVAL_SCHEMA:
        raise PackageApprovalError(
            f"package approval schema_version must be {APPROVAL_SCHEMA}"
        )
    if receipt.get("confirmed_by_user") is not True:
        raise PackageApprovalError("package approval lacks explicit user confirmation")
    if receipt.get("approved_by_os_user") != _current_user():
        raise PackageApprovalError("package approval belongs to a different OS user")

    current = _coerce_now(now)
    approved_at = _parse_timestamp(receipt.get("approved_at"), "approved_at")
    expires_at = _parse_timestamp(receipt.get("expires_at"), "expires_at")
    if expires_at <= approved_at:
        raise PackageApprovalError("package approval expiry is not after approval time")
    if current < approved_at:
        raise PackageApprovalError("package approval is not active yet")
    if current >= expires_at:
        raise PackageApprovalError("package approval expired; ask the user again")

    if receipt.get("handoff") != str(handoff_path):
        raise PackageApprovalError("package approval is bound to a different handoff")
    if receipt.get("output_dir") != str(output_dir):
        raise PackageApprovalError("package approval is bound to a different output directory")
    try:
        current_handoff_hash = _file_sha256(handoff_path)
    except OSError as exc:
        raise PackageApprovalError(f"cannot hash current handoff: {exc}") from exc
    if receipt.get("handoff_sha256") != current_handoff_hash:
        raise PackageApprovalError("handoff changed after package approval")

    try:
        handoff, inputs, manifest_hash = _input_manifest(handoff_path)
    except build_publish_package.HandoffError as exc:
        raise PackageApprovalError(f"current handoff is invalid: {exc}") from exc
    if receipt.get("release_revision_id") != handoff.get("release_revision_id"):
        raise PackageApprovalError("release_revision_id changed after package approval")
    if receipt.get("producer_skill") != handoff.get("producer_skill"):
        raise PackageApprovalError("producer_skill changed after package approval")
    if receipt.get("inputs") != inputs or receipt.get("inputs_sha256") != manifest_hash:
        raise PackageApprovalError("handoff-referenced input bytes changed after approval")

    return receipt
