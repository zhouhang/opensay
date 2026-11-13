#!/usr/bin/env python3
"""Shared release gate used by producer cleanup and delivery workflows."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import validate_publish_package as validator


class ReleaseGateError(RuntimeError):
    """Raised when a package is stale, incomplete, or not approved."""


def package_file_path(package_path: Path, value: Any) -> Path:
    path = Path(str(value)).expanduser()
    return path.resolve() if path.is_absolute() else (package_path.parent / path).resolve()


def require_current_publish_validation(package_path: Path) -> Path:
    """Require a current PASS bound to the package's exact metadata and artifact bytes."""
    package_path = package_path.resolve()
    try:
        package = json.loads(package_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseGateError(f"cannot read publish package: {exc}") from exc
    if not isinstance(package, dict):
        raise ReleaseGateError("publish package root must be an object")
    if package.get("status") != "approved":
        raise ReleaseGateError("publish package status must remain approved")

    report_value = package.get("publish_package_validation")
    if not isinstance(report_value, str) or not report_value.strip():
        raise ReleaseGateError("publish package is missing publish_package_validation")
    report_path = package_file_path(package_path, report_value)
    try:
        stored = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseGateError(f"cannot read publish-package validation: {exc}") from exc
    if not isinstance(stored, dict) or stored.get("passed") is not True:
        raise ReleaseGateError("publish-package validation did not pass")

    current = validator.validate_package(package_path)
    if current.get("passed") is not True:
        detail = "; ".join(str(item) for item in current.get("errors", []))
        raise ReleaseGateError(f"current package no longer validates: {detail}")
    for field in (
        "release_revision_id",
        "release_revision_hash",
        "cover_profile_id",
        "primary_cover_variant_id",
        "artifact_hashes",
    ):
        if stored.get(field) != current.get(field):
            raise ReleaseGateError(f"publish-package validation is stale: {field} changed")
    return report_path


def verify_release_ready(package_path: Path) -> dict[str, Any]:
    """Verify both the producer media gate and the shared current-package gate."""
    package_path = package_path.resolve()
    package = json.loads(package_path.read_text(encoding="utf-8"))
    media_value = package.get("release_media_validation")
    if not isinstance(media_value, str) or not media_value.strip():
        raise ReleaseGateError("publish package is missing release_media_validation")
    media_path = package_file_path(package_path, media_value)
    try:
        media_report = json.loads(media_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseGateError(f"cannot read release_media_validation: {exc}") from exc
    if not isinstance(media_report, dict) or media_report.get("passed") is not True:
        raise ReleaseGateError("release_media_validation did not pass")
    package_report = require_current_publish_validation(package_path)
    current = validator.validate_package(package_path)
    return {
        "status": "package_validated",
        "package": str(package_path),
        "release_media_validation": str(media_path),
        "publish_package_validation": str(package_report),
        "release_revision_id": current.get("release_revision_id"),
        "release_revision_hash": current.get("release_revision_hash"),
    }

