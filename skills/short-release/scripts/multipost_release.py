#!/usr/bin/env python3
"""Approval-gated orchestration for MultiPost Desktop.

This module is intentionally a thin policy layer over ``multipost_desktop`` and
``multipost_distribution``.  It never submits a batch: every prepared target has its
own group, screenshot, approval, idempotency key, and reconciliation receipt.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import multipost_distribution as distribution
import release_gate
from multipost_desktop import DEFAULT_BASE_URL, MultiPostDesktopClient


PREPARED_EVIDENCE_SCHEMA = "multipost-prepared-evidence-v1"
APPROVAL_EVIDENCE_SCHEMA = "multipost-approval-evidence-v1"
SUBMISSION_EVIDENCE_SCHEMA = "multipost-submission-evidence-v1"
STATUS_EVIDENCE_SCHEMA = "multipost-status-evidence-v1"
TARGETS_SCHEMA = "multipost-targets-v1"
MAX_POLL_TIMEOUT_SECONDS = 30 * 60.0
MAX_POLL_INTERVAL_SECONDS = 60.0

_TERMINAL_SUCCESS = frozenset({"success", "succeeded", "published", "completed"})
_TERMINAL_FAILED = frozenset({"failed", "error", "rejected", "cancelled", "canceled"})
_PREPARE_ACTIVE = frozenset({"pending", "preparing", "filling", "uploading", "processing"})
_SUBMIT_ACTIVE = frozenset({"pending", "publishing", "submitting", "processing", "uploading"})


class MultiPostReleaseError(RuntimeError):
    """A fail-closed orchestration or evidence check failed."""


def _read_json(path: Path | str, label: str) -> dict[str, Any]:
    resolved = Path(path).expanduser().resolve()
    try:
        value = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MultiPostReleaseError(f"cannot read {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise MultiPostReleaseError(f"{label} root must be an object")
    return value


def _write_json(path: Path | str, value: Mapping[str, Any]) -> Path:
    resolved = Path(path).expanduser().resolve()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(dict(value), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=resolved.parent, prefix=f".{resolved.name}.", delete=False
        ) as handle:
            temporary = handle.name
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, resolved)
        temporary = None
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
    return resolved


def _sha256_file(path: Path | str) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise MultiPostReleaseError(f"{field} must be a non-empty string")
    return value.strip()


def _list_field(value: Any, field: str) -> list[dict[str, Any]]:
    if not isinstance(value, Mapping):
        raise MultiPostReleaseError(f"{field} response must be an object")
    items = value.get(field)
    if not isinstance(items, list):
        raise MultiPostReleaseError(f"{field} response is missing {field}[]")
    if not all(isinstance(item, dict) for item in items):
        raise MultiPostReleaseError(f"{field} response contains a non-object item")
    return items


def _runtime_health_version(value: Any) -> str:
    if not isinstance(value, Mapping):
        raise MultiPostReleaseError("Desktop health response must be an object")
    raw_status = value.get("status")
    if not isinstance(raw_status, str) or raw_status.strip().lower() not in {
        "healthy",
        "ok",
    }:
        raise MultiPostReleaseError("Desktop health status is not explicitly healthy/ok")
    return _require_string(value.get("version"), "Desktop health version")


def _validate_poll_timing(timeout_seconds: float, poll_interval: float) -> None:
    for value, label, maximum in (
        (timeout_seconds, "timeout_seconds", MAX_POLL_TIMEOUT_SECONDS),
        (poll_interval, "poll_interval", MAX_POLL_INTERVAL_SECONDS),
    ):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise MultiPostReleaseError(f"{label} must be a finite number")
        numeric = float(value)
        if not math.isfinite(numeric):
            raise MultiPostReleaseError(f"{label} must be finite")
        if numeric < 0 or numeric > maximum:
            raise MultiPostReleaseError(
                f"{label} must be between 0 and {maximum:g} seconds"
            )


def _platform_id(item: Mapping[str, Any]) -> str:
    return _require_string(item.get("id"), "platform.id")


def _account_id(item: Mapping[str, Any]) -> str:
    return _require_string(item.get("id"), "account.id")


def _supported_types(platform: Mapping[str, Any]) -> set[str]:
    raw = platform.get("supportedContentTypes")
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        raise MultiPostReleaseError("runtime platform is missing supportedContentTypes[]")
    return {item.strip().upper() for item in raw if item.strip()}


def _is_wechat_channels(platform: str) -> bool:
    value = platform.lower().replace("-", "_")
    return value in {"wechat_channels", "weixin_channels", "wechat_video", "weixin_video"} or (
        ("wechat" in value or "weixin" in value) and ("channel" in value or "video" in value)
    )


def _is_ig_or_x(platform: str) -> bool:
    return platform.lower() in {"instagram", "ig", "x", "twitter"}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_publish_timing(value: Any) -> tuple[dict[str, str], int | None]:
    if not isinstance(value, Mapping):
        raise MultiPostReleaseError("targets[].publish_timing must be an object")
    mode = _require_string(value.get("mode"), "targets[].publish_timing.mode")
    if mode == "immediate":
        if set(value) != {"mode"}:
            raise MultiPostReleaseError(
                "immediate publish_timing must contain only mode"
            )
        return {"mode": "immediate"}, None
    if mode != "scheduled_at":
        raise MultiPostReleaseError(
            "targets[].publish_timing.mode must be immediate or scheduled_at"
        )
    if set(value) != {"mode", "scheduled_at"}:
        raise MultiPostReleaseError(
            "scheduled_at publish_timing must contain only mode and scheduled_at"
        )
    scheduled_at = _require_string(
        value.get("scheduled_at"), "targets[].publish_timing.scheduled_at"
    )
    try:
        parsed = datetime.fromisoformat(scheduled_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise MultiPostReleaseError(
            "targets[].publish_timing.scheduled_at must be ISO-8601"
        ) from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise MultiPostReleaseError(
            "targets[].publish_timing.scheduled_at must include a timezone"
        )
    normalized = parsed.astimezone(timezone.utc)
    if normalized <= _utc_now():
        raise MultiPostReleaseError(
            "targets[].publish_timing.scheduled_at must be in the future"
        )
    epoch_delta = normalized - datetime(1970, 1, 1, tzinfo=timezone.utc)
    milliseconds = (
        epoch_delta.days * 86_400_000
        + epoch_delta.seconds * 1_000
        + epoch_delta.microseconds // 1_000
    )
    canonical = normalized.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return {"mode": "scheduled_at", "scheduled_at": canonical}, milliseconds


def _normalize_target(raw: Mapping[str, Any]) -> dict[str, Any]:
    platform = _require_string(raw.get("platform"), "targets[].platform")
    account_id = _require_string(raw.get("account_id"), "targets[].account_id")
    content_type = _require_string(raw.get("content_type"), "targets[].content_type").upper()
    data = raw.get("data")
    if not isinstance(data, Mapping):
        raise MultiPostReleaseError("targets[].data must be an object")
    surface = raw.get("surface")
    if _is_wechat_channels(platform):
        raise MultiPostReleaseError(
            f"{platform}:{account_id} is manual_required/canary_blocked: "
            "the installed Desktop contract has no proven two-cover mapping"
        )
    if _is_ig_or_x(platform):
        if content_type != "DYNAMIC" or surface != "ordinary_post":
            raise MultiPostReleaseError(
                f"{platform}:{account_id} supports only DYNAMIC ordinary_post in this adapter"
            )
    elif content_type != "VIDEO":
        raise MultiPostReleaseError(
            f"{platform}:{account_id} must use VIDEO in this video release adapter"
        )
    try:
        normalized_data = json.loads(
            json.dumps(dict(data), ensure_ascii=False, sort_keys=True, allow_nan=False)
        )
    except (TypeError, ValueError) as exc:
        raise MultiPostReleaseError(f"targets[].data must be canonical JSON: {exc}") from exc
    for field in ("scheduledPublishTime", "publish_timing", "scheduled_at"):
        if field in normalized_data:
            raise MultiPostReleaseError(
                f"targets[].data.{field} is control metadata; use top-level publish_timing"
            )
    visibility = _require_string(
        normalized_data.get("visibility"), "targets[].data.visibility"
    )
    normalized_data["visibility"] = visibility
    publish_timing, scheduled_publish_time = _normalize_publish_timing(
        raw.get("publish_timing")
    )
    if scheduled_publish_time is not None:
        # MultiPost's documented Desktop payload field is milliseconds. Keep the
        # human-readable intent in control evidence and send only the derived field.
        normalized_data["scheduledPublishTime"] = scheduled_publish_time

    if _is_ig_or_x(platform):
        cover_policy = _require_string(
            raw.get("cover_policy"), "targets[].cover_policy"
        )
        if cover_policy != "not_applicable":
            raise MultiPostReleaseError(
                f"{platform}:{account_id} ordinary_post cover_policy must be not_applicable"
            )
        forbidden_cover_fields = {
            field
            for field in ("cover", "verticalCover", "horizontalCover")
            if field in normalized_data
        }
        if forbidden_cover_fields:
            fields = ", ".join(sorted(forbidden_cover_fields))
            raise MultiPostReleaseError(
                f"{platform}:{account_id} ordinary_post forbids cover fields: {fields}"
            )
    else:
        if "cover_policy" in raw:
            raise MultiPostReleaseError(
                f"{platform}:{account_id} VIDEO cover_policy is derived from package cover"
            )
        _require_string(normalized_data.get("cover"), f"{platform}:{account_id}.data.cover")
        cover_policy = "package_cover"

    control = {
        "visibility": visibility,
        "publish_timing": publish_timing,
        "cover_policy": cover_policy,
    }
    return {
        "platform": platform,
        "account_id": account_id,
        "content_type": content_type,
        "surface": surface,
        "visibility": visibility,
        "publish_timing": publish_timing,
        "cover_policy": cover_policy,
        "data": normalized_data,
        # The state layer hashes this wrapper, including the content type.  The Desktop
        # transport receives only the exact nested data object below, never control.
        "payload": {
            "contentType": content_type,
            "data": normalized_data,
            "control": control,
        },
    }


def load_targets(path: Path | str) -> list[dict[str, Any]]:
    document = _read_json(path, "MultiPost targets")
    schema = document.get("schema_version")
    if schema not in {None, TARGETS_SCHEMA}:
        raise MultiPostReleaseError(f"unsupported targets schema: {schema}")
    raw_targets = document.get("targets")
    if not isinstance(raw_targets, list) or not raw_targets:
        raise MultiPostReleaseError("targets must be a non-empty list")
    normalized = [_normalize_target(item) for item in raw_targets if isinstance(item, Mapping)]
    if len(normalized) != len(raw_targets):
        raise MultiPostReleaseError("every target must be an object")
    keys = [distribution.target_key(item["platform"], item["account_id"]) for item in normalized]
    if len(keys) != len(set(keys)):
        raise MultiPostReleaseError("targets contain a duplicate platform/account_id")
    return normalized


def _package_artifact_path(package_path: Path, value: Any, field: str) -> Path:
    text = _require_string(value, field)
    candidate = Path(text).expanduser()
    return candidate.resolve() if candidate.is_absolute() else (package_path.parent / candidate).resolve()


def _bind_targets_to_package(package_path: Path, targets: Sequence[Mapping[str, Any]]) -> None:
    """Require the exact verified package media in every outbound payload."""
    package = _read_json(package_path, "publish package")
    video = _package_artifact_path(package_path, package.get("video"), "package.video")
    master = _package_artifact_path(
        package_path, package.get("cover_master"), "package.cover_master"
    )
    variants = package.get("cover_variants")
    if not isinstance(variants, Mapping) or not variants:
        raise MultiPostReleaseError("package.cover_variants must be a non-empty object")
    variant_paths = {
        str(name): _package_artifact_path(
            package_path, value, f"package.cover_variants.{name}"
        )
        for name, value in variants.items()
    }
    allowed_covers = {master, *variant_paths.values()}

    for target in targets:
        data = target["data"]
        platform = str(target["platform"]).lower()
        key = distribution.target_key(target["platform"], target["account_id"])
        if target["content_type"] == "VIDEO":
            outbound_video = _package_artifact_path(
                package_path, data.get("video"), f"{key}.data.video"
            )
            if outbound_video != video:
                raise MultiPostReleaseError(f"{key} data.video is not the verified package video")
            outbound_cover = _package_artifact_path(
                package_path, data.get("cover"), f"{key}.data.cover"
            )
            if outbound_cover not in allowed_covers:
                raise MultiPostReleaseError(
                    f"{key} data.cover is not a verified package cover"
                )
        elif _is_ig_or_x(platform):
            outbound_videos = data.get("videos")
            if not isinstance(outbound_videos, list) or len(outbound_videos) != 1:
                raise MultiPostReleaseError(
                    f"{key} DYNAMIC ordinary_post data.videos must contain exactly the package video"
                )
            outbound_video = _package_artifact_path(
                package_path, outbound_videos[0], f"{key}.data.videos[0]"
            )
            if outbound_video != video:
                raise MultiPostReleaseError(
                    f"{key} data.videos does not contain the verified package video"
                )

        for cover_field in ("cover", "verticalCover", "horizontalCover"):
            if cover_field not in data:
                continue
            outbound_cover = _package_artifact_path(
                package_path, data[cover_field], f"{key}.data.{cover_field}"
            )
            if outbound_cover not in allowed_covers:
                raise MultiPostReleaseError(
                    f"{key} data.{cover_field} is not a verified package cover"
                )

        required_variant: str | None = None
        if platform in {"douyin", "tiktok_cn"} or "douyin" in platform:
            required_variant = "douyin_cover"
        elif platform in {"xiaohongshu", "xhs", "rednote"} or "xiaohongshu" in platform:
            required_variant = "xiaohongshu_cover"
        if required_variant is not None:
            expected_cover = variant_paths.get(required_variant)
            if expected_cover is None:
                raise MultiPostReleaseError(
                    f"package is missing required cover variant: {required_variant}"
                )
            if "cover" not in data or _package_artifact_path(
                package_path, data["cover"], f"{key}.data.cover"
            ) != expected_cover:
                raise MultiPostReleaseError(
                    f"{key} data.cover must use package.cover_variants.{required_variant}"
                )


def _extract_group_id(response: Any) -> str:
    if not isinstance(response, Mapping):
        raise MultiPostReleaseError("create_publish returned a non-object response")
    return _require_string(response.get("groupId") or response.get("id"), "groupId")


def _status_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip().lower()
    if isinstance(value, Mapping):
        return _status_text(value.get("status"))
    return "unknown"


def _target_snapshot(
    snapshot: Any,
    *,
    group_id: str,
    account_id: str,
    platform: str,
) -> tuple[str, Mapping[str, Any]]:
    if not isinstance(snapshot, Mapping):
        return "unknown", {}
    if snapshot.get("groupId") != group_id:
        return "unknown", {}
    targets = snapshot.get("targets")
    if not isinstance(targets, list):
        return "unknown", {}
    exact = [
        item
        for item in targets
        if isinstance(item, Mapping) and item.get("accountId") == account_id
    ]
    if len(exact) != 1:
        return "unknown", {}
    target = exact[0]
    runtime_platform = target.get("platform") or target.get("platformId")
    if runtime_platform is not None and runtime_platform != platform:
        return "unknown", {}
    return _status_text(target.get("status")), target


def _require_runtime_target_ready(
    snapshot: Any, *, group_id: str, account_id: str, platform: str
) -> Mapping[str, Any]:
    if not isinstance(snapshot, Mapping):
        raise MultiPostReleaseError("runtime publish status is not an object")
    runtime_group = snapshot.get("groupId")
    if runtime_group != group_id:
        raise MultiPostReleaseError("runtime publish group differs from prepared group")
    targets = snapshot.get("targets")
    if not isinstance(targets, list):
        raise MultiPostReleaseError("runtime publish status has no exact target list")
    exact = [
        item
        for item in targets
        if isinstance(item, Mapping) and item.get("accountId") == account_id
    ]
    if len(exact) != 1:
        raise MultiPostReleaseError("runtime exact account target is missing or duplicated")
    target = exact[0]
    runtime_platform = target.get("platform") or target.get("platformId")
    if runtime_platform is not None and runtime_platform != platform:
        raise MultiPostReleaseError("runtime target platform differs from prepared platform")
    if _status_text(target.get("status")) != "ready":
        raise MultiPostReleaseError("runtime target is no longer ready; re-prepare and approve")
    return target


def _poll(
    client: MultiPostDesktopClient,
    group_id: str,
    account_id: str,
    *,
    platform: str,
    terminal: set[str] | frozenset[str],
    active: set[str] | frozenset[str],
    timeout_seconds: float,
    poll_interval: float,
    sleeper: Callable[[float], None] = time.sleep,
) -> tuple[str, Mapping[str, Any], Mapping[str, Any]]:
    if timeout_seconds < 0 or poll_interval < 0:
        raise MultiPostReleaseError("poll timing values must not be negative")
    deadline = time.monotonic() + timeout_seconds
    while True:
        snapshot = client.get_publish_status(group_id)
        status, target = _target_snapshot(
            snapshot,
            group_id=group_id,
            account_id=account_id,
            platform=platform,
        )
        if status in terminal or status not in active:
            return status, target, snapshot if isinstance(snapshot, Mapping) else {}
        if time.monotonic() >= deadline:
            return "unknown", target, snapshot if isinstance(snapshot, Mapping) else {}
        sleeper(min(poll_interval, max(0.0, deadline - time.monotonic())))


def preflight(
    output: Path | str,
    *,
    client: MultiPostDesktopClient | None = None,
    base_url: str = DEFAULT_BASE_URL,
) -> dict[str, Any]:
    desktop = client or MultiPostDesktopClient(base_url)
    health = desktop.health()
    runtime_version = _runtime_health_version(health)
    platforms = desktop.list_platforms()
    accounts = desktop.list_accounts()
    # Strictly parse the two capability arrays before reporting success.
    _list_field(platforms, "platforms")
    _list_field(accounts, "accounts")
    result = {
        "schema_version": "multipost-preflight-v1",
        "status": "preflight_ok",
        "base_url": desktop.base_url,
        "runtime_version": runtime_version,
        "health": health,
        "platforms": platforms,
        "accounts": accounts,
    }
    _write_json(output, result)
    return result


def _runtime_match(
    target: Mapping[str, Any], platforms_response: Any, accounts_response: Any
) -> None:
    platforms = {_platform_id(item): item for item in _list_field(platforms_response, "platforms")}
    accounts = {_account_id(item): item for item in _list_field(accounts_response, "accounts")}
    platform_id = target["platform"]
    account_id = target["account_id"]
    if platform_id not in platforms:
        raise MultiPostReleaseError(f"runtime platform ID is unavailable: {platform_id}")
    if target["content_type"] not in _supported_types(platforms[platform_id]):
        raise MultiPostReleaseError(
            f"runtime platform {platform_id} does not support {target['content_type']}"
        )
    account = accounts.get(account_id)
    if account is None:
        raise MultiPostReleaseError(f"runtime account ID is unavailable: {account_id}")
    if account.get("platform") != platform_id:
        raise MultiPostReleaseError(
            f"runtime account {account_id} belongs to {account.get('platform')}, not {platform_id}"
        )
    if account.get("isLoggedIn") is not True:
        raise MultiPostReleaseError(f"runtime account is not logged in: {account_id}")


def _state_dir_from_prepared(prepared: Mapping[str, Any]) -> Path:
    value = _require_string(prepared.get("state_dir"), "prepared.state_dir")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise MultiPostReleaseError("prepared.state_dir must be absolute")
    return path.resolve()


def _verify_prepared_evidence(prepared_path: Path | str) -> tuple[dict[str, Any], Path]:
    evidence = _read_json(prepared_path, "prepared evidence")
    if evidence.get("schema_version") != PREPARED_EVIDENCE_SCHEMA:
        raise MultiPostReleaseError("unsupported prepared evidence schema")
    state_dir = _state_dir_from_prepared(evidence)
    screenshot = Path(_require_string(evidence.get("screenshot_path"), "screenshot_path"))
    if not screenshot.is_absolute() or not screenshot.is_file():
        raise MultiPostReleaseError("prepared screenshot is missing")
    if _sha256_file(screenshot) != evidence.get("screenshot_sha256"):
        raise MultiPostReleaseError("prepared screenshot bytes changed after preparation")
    canonical = Path(
        _require_string(evidence.get("canonical_prepare_receipt"), "canonical_prepare_receipt")
    )
    if not canonical.is_absolute() or not canonical.is_file():
        raise MultiPostReleaseError("canonical prepare receipt is missing")
    if _sha256_file(canonical) != evidence.get("canonical_prepare_receipt_sha256"):
        raise MultiPostReleaseError("canonical prepare receipt changed after evidence was written")
    if evidence.get("status") != "ready" or evidence.get("auto_submit") is not False:
        raise MultiPostReleaseError("only an autoSubmit=false ready target can proceed")
    runtime_version = _runtime_health_version(evidence.get("runtime_health"))
    if evidence.get("runtime_version") != runtime_version:
        raise MultiPostReleaseError("prepared runtime version differs from health evidence")
    if evidence.get("canary_status") != "passed":
        raise MultiPostReleaseError("prepared non-public runtime canary did not pass")
    canary = evidence.get("runtime_canary")
    if not isinstance(canary, Mapping):
        raise MultiPostReleaseError("prepared runtime canary evidence is missing")
    expected_canary = {
        "canary_status": "passed",
        "runtime_version": runtime_version,
        "platform": evidence.get("platform"),
        "content_type": evidence.get("content_type"),
        "account_id": evidence.get("account_id"),
        "group_id": evidence.get("group_id"),
        "auto_submit": False,
        "runtime_status": "ready",
        "screenshot_sha256": evidence.get("screenshot_sha256"),
    }
    if dict(canary) != expected_canary:
        raise MultiPostReleaseError("prepared runtime canary binding mismatch")
    canary_sha256 = distribution.payload_sha256(expected_canary)
    if evidence.get("runtime_canary_sha256") != canary_sha256:
        raise MultiPostReleaseError("prepared runtime canary hash mismatch")
    canonical_receipt = _read_json(canonical, "canonical prepare receipt")
    payload = evidence.get("payload")
    if not isinstance(payload, Mapping):
        raise MultiPostReleaseError("prepared payload evidence is missing")
    payload_sha256 = distribution.payload_sha256(payload)
    if (
        evidence.get("payload_sha256") != payload_sha256
        or canonical_receipt.get("payload_sha256") != payload_sha256
    ):
        raise MultiPostReleaseError("prepared payload/control hash binding mismatch")
    data = payload.get("data")
    control = payload.get("control")
    if not isinstance(data, Mapping) or not isinstance(control, Mapping):
        raise MultiPostReleaseError("prepared payload data/control binding is missing")
    expected_control = {
        "visibility": evidence.get("visibility"),
        "publish_timing": evidence.get("publish_timing"),
        "cover_policy": evidence.get("cover_policy"),
    }
    if dict(control) != expected_control or data.get("visibility") != evidence.get(
        "visibility"
    ):
        raise MultiPostReleaseError("prepared target control metadata binding mismatch")
    try:
        current_timing, scheduled_publish_time = _normalize_publish_timing(
            evidence.get("publish_timing")
        )
    except MultiPostReleaseError as exc:
        raise MultiPostReleaseError(
            f"prepared publish_timing is invalid or expired: {exc}"
        ) from exc
    if current_timing != evidence.get("publish_timing"):
        raise MultiPostReleaseError("prepared publish_timing is not canonical")
    if scheduled_publish_time is None:
        if "scheduledPublishTime" in data:
            raise MultiPostReleaseError(
                "immediate prepared payload must not contain scheduledPublishTime"
            )
    else:
        actual_scheduled_time = data.get("scheduledPublishTime")
        if (
            isinstance(actual_scheduled_time, bool)
            or not isinstance(actual_scheduled_time, int)
            or actual_scheduled_time != scheduled_publish_time
        ):
            raise MultiPostReleaseError(
                "prepared scheduledPublishTime does not match publish_timing"
            )
    if (
        canonical_receipt.get("runtime_canary") != expected_canary
        or canonical_receipt.get("runtime_canary_sha256") != canary_sha256
    ):
        raise MultiPostReleaseError("canonical prepare receipt has a different runtime canary")
    return evidence, state_dir


def prepare(
    package: Path | str,
    targets_path: Path | str,
    output_dir: Path | str,
    *,
    client: MultiPostDesktopClient | None = None,
    base_url: str = DEFAULT_BASE_URL,
    verify_func: Callable[[Path], Mapping[str, Any]] = release_gate.verify_release_ready,
    timeout_seconds: float = 300.0,
    poll_interval: float = 2.0,
    sleeper: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    _validate_poll_timing(timeout_seconds, poll_interval)
    package_path = Path(package).expanduser().resolve()
    verified = dict(verify_func(package_path))
    revision_id = _require_string(verified.get("release_revision_id"), "release_revision_id")
    revision_hash = _require_string(
        verified.get("release_revision_hash"), "release_revision_hash"
    )
    targets = load_targets(targets_path)
    _bind_targets_to_package(package_path, targets)
    desktop = client or MultiPostDesktopClient(base_url)
    health = desktop.health()
    runtime_version = _runtime_health_version(health)
    platforms = desktop.list_platforms()
    accounts = desktop.list_accounts()
    for target in targets:
        _runtime_match(target, platforms, accounts)

    root = Path(output_dir).expanduser().resolve()
    # State location is derived only from the verified package.  Callers cannot evade
    # an existing idempotency receipt by choosing another --output-dir.
    state_dir = package_path.parent / "multipost_distribution"
    plan = distribution.create_distribution_plan(
        state_dir,
        release_package=package_path,
        release_revision_id=revision_id,
        release_revision_hash=revision_hash,
        targets=[
            {
                "platform": item["platform"],
                "account_id": item["account_id"],
                "payload": item["payload"],
            }
            for item in targets
        ],
    )

    evidence_items: list[dict[str, Any]] = []
    all_ready = True
    stop_after_non_ready = False
    for target in targets:
        key = distribution.target_key(target["platform"], target["account_id"])
        if stop_after_non_ready:
            evidence_items.append(
                {
                    "target_key": key,
                    "status": "not_attempted",
                    "error": "a previous target was not ready; fail-closed preparation stopped",
                }
            )
            all_ready = False
            continue
        try:
            response = desktop.create_publish(
                content_type=target["content_type"],
                account_ids=[target["account_id"]],
                data=target["data"],
                auto_submit=False,
            )
            group_id = _extract_group_id(response)
            status, target_status, snapshot = _poll(
                desktop,
                group_id,
                target["account_id"],
                platform=target["platform"],
                terminal={"ready", *_TERMINAL_FAILED},
                active=_PREPARE_ACTIVE,
                timeout_seconds=timeout_seconds,
                poll_interval=poll_interval,
                sleeper=sleeper,
            )
            if status != "ready":
                state_status = "failed" if status in _TERMINAL_FAILED else "unknown"
                receipt = distribution.record_prepared_target(
                    state_dir,
                    platform=target["platform"],
                    account_id=target["account_id"],
                    group_id=group_id,
                    prepared_payload=target["payload"],
                    auto_submit=False,
                    status=state_status,
                )
                evidence_items.append(
                    {
                        "target_key": key,
                        "status": state_status,
                        "group_id": group_id,
                        "canonical_prepare_receipt": str(
                            distribution.prepare_receipt_path(state_dir, key)
                        ),
                        "runtime_status": status,
                    }
                )
                all_ready = False
                stop_after_non_ready = True
                continue

            screenshot_path = root / "screenshots" / f"{hashlib.sha256(key.encode()).hexdigest()[:24]}.png"
            screenshot_path.parent.mkdir(parents=True, exist_ok=True)
            screenshot_bytes = desktop.take_screenshot(
                group_id=group_id, account_id=target["account_id"]
            )
            if not screenshot_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
                raise MultiPostReleaseError("Desktop screenshot is not a PNG")
            screenshot_path.write_bytes(screenshot_bytes)
            receipt = distribution.record_prepared_target(
                state_dir,
                platform=target["platform"],
                account_id=target["account_id"],
                group_id=group_id,
                prepared_payload=target["payload"],
                auto_submit=False,
                status="ready",
                screenshot_path=screenshot_path,
                runtime_version=runtime_version,
                canary_passed=True,
            )
            canonical = distribution.prepare_receipt_path(state_dir, key)
            evidence_path = root / f"{hashlib.sha256(key.encode()).hexdigest()[:24]}.json"
            evidence = {
                "schema_version": PREPARED_EVIDENCE_SCHEMA,
                "status": "ready",
                "auto_submit": False,
                "state_dir": str(state_dir),
                "target_key": key,
                "platform": target["platform"],
                "account_id": target["account_id"],
                "content_type": target["content_type"],
                "surface": target["surface"],
                "visibility": target["visibility"],
                "publish_timing": target["publish_timing"],
                "cover_policy": target["cover_policy"],
                "payload": target["payload"],
                "payload_sha256": receipt["payload_sha256"],
                "group_id": group_id,
                "release_revision_id": revision_id,
                "release_revision_hash": revision_hash,
                "screenshot_path": str(screenshot_path),
                "screenshot_sha256": _sha256_file(screenshot_path),
                "canonical_prepare_receipt": str(canonical),
                "canonical_prepare_receipt_sha256": _sha256_file(canonical),
                "runtime_health": health,
                "runtime_version": runtime_version,
                "canary_status": "passed",
                "runtime_canary": receipt["runtime_canary"],
                "runtime_canary_sha256": receipt["runtime_canary_sha256"],
                "runtime_target": dict(target_status),
                "runtime_snapshot": dict(snapshot),
                "prepare_receipt_id": receipt["prepare_receipt_id"],
            }
            _write_json(evidence_path, evidence)
            evidence_items.append(
                {"target_key": key, "status": "ready", "prepared": str(evidence_path)}
            )
        except Exception as exc:
            all_ready = False
            stop_after_non_ready = True
            evidence_items.append(
                {"target_key": key, "status": "failed", "error": str(exc)}
            )

    result = {
        "schema_version": "multipost-prepare-summary-v1",
        "status": "ready" if all_ready else "partial_or_blocked",
        "state_dir": str(state_dir),
        "distribution_plan_id": plan["distribution_plan_id"],
        "release_revision_id": revision_id,
        "release_revision_hash": revision_hash,
        "runtime_version": runtime_version,
        "targets": evidence_items,
    }
    _write_json(root / "prepare-summary.json", result)
    return result


def approve(
    prepared_path: Path | str,
    target_key: str,
    output: Path | str,
    *,
    confirmed_by_user: bool,
    approval_note: str = "",
    ttl_seconds: int = distribution.DEFAULT_APPROVAL_TTL_SECONDS,
) -> dict[str, Any]:
    prepared, state_dir = _verify_prepared_evidence(prepared_path)
    requested_key = _require_string(target_key, "target")
    if prepared.get("target_key") != requested_key:
        raise MultiPostReleaseError("--target does not match the prepared target")
    approval = distribution.approve_target(
        state_dir,
        platform=prepared["platform"],
        account_id=prepared["account_id"],
        confirmed_by_user=confirmed_by_user,
        approval_note=approval_note,
        ttl_seconds=ttl_seconds,
    )
    canonical = distribution.approval_path(state_dir, requested_key)
    evidence = {
        "schema_version": APPROVAL_EVIDENCE_SCHEMA,
        "status": "approved",
        "state_dir": str(state_dir),
        "target_key": requested_key,
        "runtime_version": prepared["runtime_version"],
        "canary_status": prepared["canary_status"],
        "runtime_canary_sha256": prepared["runtime_canary_sha256"],
        "payload_sha256": prepared["payload_sha256"],
        "visibility": prepared["visibility"],
        "publish_timing": prepared["publish_timing"],
        "cover_policy": prepared["cover_policy"],
        "prepared_evidence": str(Path(prepared_path).expanduser().resolve()),
        "prepared_evidence_sha256": _sha256_file(prepared_path),
        "canonical_approval": str(canonical),
        "canonical_approval_sha256": _sha256_file(canonical),
        "approval": approval,
    }
    _write_json(output, evidence)
    return evidence


def _verify_approval_evidence(
    approval_path: Path | str, prepared_path: Path | str, state_dir: Path, target_key: str
) -> dict[str, Any]:
    evidence = _read_json(approval_path, "approval evidence")
    if evidence.get("schema_version") != APPROVAL_EVIDENCE_SCHEMA:
        raise MultiPostReleaseError("unsupported approval evidence schema")
    if evidence.get("state_dir") != str(state_dir) or evidence.get("target_key") != target_key:
        raise MultiPostReleaseError("approval evidence target/state binding mismatch")
    if evidence.get("prepared_evidence") != str(Path(prepared_path).expanduser().resolve()):
        raise MultiPostReleaseError("approval belongs to different prepared evidence")
    if evidence.get("prepared_evidence_sha256") != _sha256_file(prepared_path):
        raise MultiPostReleaseError("prepared evidence changed after approval")
    prepared = _read_json(prepared_path, "prepared evidence")
    for field in (
        "runtime_version",
        "canary_status",
        "runtime_canary_sha256",
        "payload_sha256",
        "visibility",
        "publish_timing",
        "cover_policy",
    ):
        if evidence.get(field) != prepared.get(field):
            raise MultiPostReleaseError(f"approval prepared binding mismatch: {field}")
    canonical = Path(_require_string(evidence.get("canonical_approval"), "canonical_approval"))
    expected = distribution.approval_path(state_dir, target_key)
    if canonical.resolve() != expected.resolve() or not canonical.is_file():
        raise MultiPostReleaseError("canonical approval path is invalid")
    if evidence.get("canonical_approval_sha256") != _sha256_file(canonical):
        raise MultiPostReleaseError("canonical approval changed after evidence was written")
    return evidence


def _authorization_from_receipt(receipt: Mapping[str, Any]) -> dict[str, Any]:
    fields = (
        "authorization_id",
        "approval_id",
        "distribution_plan_id",
        "release_revision_id",
        "release_revision_hash",
        "target_key",
        "target_id",
        "platform",
        "account_id",
        "payload_sha256",
        "idempotency_key",
        "group_id",
        "runtime_canary_sha256",
    )
    authorization = {field: receipt.get(field) for field in fields}
    authorization["authorized"] = True
    return authorization


def _remote_metadata(target: Mapping[str, Any]) -> tuple[str | None, str | None, str | None]:
    post_id = target.get("postId") or target.get("remotePostId") or target.get("id")
    post_url = target.get("url") or target.get("postUrl") or target.get("remotePostUrl")
    error = target.get("error") or target.get("message")
    return (
        str(post_id) if post_id is not None else None,
        str(post_url) if post_url is not None else None,
        str(error) if error is not None else None,
    )


def submit(
    package: Path | str,
    prepared_path: Path | str,
    approval_path: Path | str,
    output: Path | str,
    *,
    client: MultiPostDesktopClient | None = None,
    base_url: str = DEFAULT_BASE_URL,
    verify_func: Callable[[Path], Mapping[str, Any]] = release_gate.verify_release_ready,
    timeout_seconds: float = 180.0,
    poll_interval: float = 2.0,
    sleeper: Callable[[float], None] = time.sleep,
    retry_failed: bool = False,
) -> dict[str, Any]:
    _validate_poll_timing(timeout_seconds, poll_interval)
    prepared, state_dir = _verify_prepared_evidence(prepared_path)
    target_key = prepared["target_key"]
    _verify_approval_evidence(approval_path, prepared_path, state_dir, target_key)
    package_path = Path(package).expanduser().resolve()
    plan = distribution.load_distribution_plan(state_dir)
    if plan.get("release_package") != str(package_path):
        raise MultiPostReleaseError("--package differs from the prepared distribution plan")
    verified = dict(verify_func(package_path))
    revision_id = _require_string(verified.get("release_revision_id"), "release_revision_id")
    revision_hash = _require_string(
        verified.get("release_revision_hash"), "release_revision_hash"
    )
    arguments = {
        "platform": prepared["platform"],
        "account_id": prepared["account_id"],
        "group_id": prepared["group_id"],
        "payload": prepared["payload"],
        "current_release_revision_id": revision_id,
        "current_release_revision_hash": revision_hash,
    }
    # Recheck the visible browser target immediately before reserving submission.  A
    # missing token, stopped Desktop app, changed account, or target that left `ready`
    # must fail without writing a `submitting` receipt.
    desktop = client or MultiPostDesktopClient(base_url)
    current_runtime_version = _runtime_health_version(desktop.health())
    if current_runtime_version != prepared["runtime_version"]:
        raise MultiPostReleaseError(
            "Desktop runtime version changed after the preparation canary; re-prepare and approve"
        )
    current_snapshot = desktop.get_publish_status(prepared["group_id"])
    _require_runtime_target_ready(
        current_snapshot,
        group_id=prepared["group_id"],
        account_id=prepared["account_id"],
        platform=prepared["platform"],
    )
    if retry_failed:
        begin = distribution.retry_failed_target(state_dir, **arguments)
    else:
        begin = distribution.begin_submission(state_dir, **arguments)
    # Use only the authorization atomically persisted by begin_submission.  Performing
    # a separate pre-check would create a TOCTOU window where an approval is replaced
    # between validation and idempotency reservation.
    authorization = _authorization_from_receipt(begin)
    try:
        desktop.submit_target(
            prepared["group_id"], prepared["account_id"], approval=authorization
        )
        status, target, _ = _poll(
            desktop,
            prepared["group_id"],
            prepared["account_id"],
            platform=prepared["platform"],
            terminal=_TERMINAL_SUCCESS | _TERMINAL_FAILED,
            active=_SUBMIT_ACTIVE,
            timeout_seconds=timeout_seconds,
            poll_interval=poll_interval,
            sleeper=sleeper,
        )
        remote_id, remote_url, remote_error = _remote_metadata(target)
        if status in _TERMINAL_SUCCESS:
            result_status = "success"
        elif status in _TERMINAL_FAILED:
            result_status = "failed"
        else:
            result_status = "unknown"
            remote_error = remote_error or f"unreconciled runtime state: {status}"
    except Exception as exc:
        # The submit call may have reached the browser before the error surfaced.
        # Therefore failure is never assumed; unknown blocks unsafe retries.
        result_status = "unknown"
        remote_id = remote_url = None
        remote_error = f"submit outcome is unknown: {exc}"
    receipt = distribution.record_publish_result(
        state_dir,
        authorization,
        status=result_status,
        remote_post_id=remote_id,
        remote_post_url=remote_url,
        error=remote_error,
    )
    evidence = {
        "schema_version": SUBMISSION_EVIDENCE_SCHEMA,
        "status": receipt["status"],
        "state_dir": str(state_dir),
        "target_key": target_key,
        "group_id": prepared["group_id"],
        "account_id": prepared["account_id"],
        "runtime_version": prepared["runtime_version"],
        "canary_status": prepared["canary_status"],
        "runtime_canary_sha256": prepared["runtime_canary_sha256"],
        "canonical_publish_receipt": str(
            distribution.publish_receipt_path(state_dir, begin["idempotency_key"])
        ),
        "receipt": receipt,
    }
    _write_json(output, evidence)
    return evidence


def status(
    receipt_path: Path | str,
    output: Path | str,
    *,
    client: MultiPostDesktopClient | None = None,
    base_url: str = DEFAULT_BASE_URL,
) -> dict[str, Any]:
    submission = _read_json(receipt_path, "submission evidence")
    if submission.get("schema_version") not in {
        SUBMISSION_EVIDENCE_SCHEMA,
        STATUS_EVIDENCE_SCHEMA,
    }:
        raise MultiPostReleaseError("unsupported submission/status evidence schema")
    state_dir = Path(_require_string(submission.get("state_dir"), "state_dir"))
    if not state_dir.is_absolute():
        raise MultiPostReleaseError("state_dir must be absolute")
    canonical = Path(
        _require_string(submission.get("canonical_publish_receipt"), "canonical_publish_receipt")
    )
    if not canonical.is_file():
        raise MultiPostReleaseError("canonical publish receipt is missing")
    current = _read_json(canonical, "canonical publish receipt")
    if current.get("target_key") != submission.get("target_key"):
        raise MultiPostReleaseError("submission evidence target binding mismatch")
    runtime_version = _require_string(
        submission.get("runtime_version"), "submission runtime_version"
    )
    if submission.get("canary_status") != "passed":
        raise MultiPostReleaseError("submission evidence has no passed runtime canary")
    canary_sha256 = _require_string(
        submission.get("runtime_canary_sha256"), "submission runtime_canary_sha256"
    )
    if current.get("runtime_canary_sha256") != canary_sha256:
        raise MultiPostReleaseError("submission runtime canary differs from canonical receipt")

    if current.get("status") in {"submitting", "unknown"}:
        desktop = client or MultiPostDesktopClient(base_url)
        snapshot = desktop.get_publish_status(current["group_id"])
        remote_status, target = _target_snapshot(
            snapshot,
            group_id=current["group_id"],
            account_id=current["account_id"],
            platform=current["platform"],
        )
        if remote_status in _TERMINAL_SUCCESS | _TERMINAL_FAILED:
            remote_id, remote_url, remote_error = _remote_metadata(target)
            current = distribution.record_publish_result(
                state_dir,
                _authorization_from_receipt(current),
                status="success" if remote_status in _TERMINAL_SUCCESS else "failed",
                remote_post_id=remote_id,
                remote_post_url=remote_url,
                error=remote_error,
            )
    evidence = {
        "schema_version": STATUS_EVIDENCE_SCHEMA,
        "status": current["status"],
        "state_dir": str(state_dir.resolve()),
        "target_key": current["target_key"],
        "group_id": current["group_id"],
        "account_id": current["account_id"],
        "runtime_version": runtime_version,
        "canary_status": "passed",
        "runtime_canary_sha256": canary_sha256,
        "canonical_publish_receipt": str(canonical.resolve()),
        "receipt": current,
    }
    _write_json(output, evidence)
    return evidence


__all__ = [
    "MultiPostReleaseError",
    "approve",
    "load_targets",
    "preflight",
    "prepare",
    "status",
    "submit",
]
