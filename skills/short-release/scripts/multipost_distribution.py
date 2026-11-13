#!/usr/bin/env python3
"""Fail-closed state, approval, and idempotency primitives for MultiPost.

This module deliberately does not call MultiPost and never edits the canonical
``publish_package.json``.  A transport adapter may use these functions to persist a
distribution plan, bind a prepared browser task to an explicit local-user approval,
and reserve an idempotency key *before* performing the public-submit side effect.
"""

from __future__ import annotations

import getpass
import fcntl
import hashlib
import json
import os
import pwd
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence


PLAN_SCHEMA = "multipost-distribution-plan-v1"
PREPARE_RECEIPT_SCHEMA = "multipost-prepare-receipt-v1"
APPROVAL_SCHEMA = "multipost-publish-approval-v1"
PUBLISH_RECEIPT_SCHEMA = "multipost-publish-receipt-v1"

DEFAULT_APPROVAL_TTL_SECONDS = 15 * 60
MAX_APPROVAL_TTL_SECONDS = 60 * 60
BLOCKING_PUBLISH_STATUSES = frozenset({"submitting", "success", "unknown"})
RESULT_STATUSES = frozenset({"success", "failed", "unknown"})


class DistributionStateError(RuntimeError):
    """Base error for an invalid or unsafe distribution-state transition."""


class DistributionValidationError(DistributionStateError):
    """Raised when a plan, receipt, approval, or caller binding is invalid."""


class AuthorizationError(DistributionStateError):
    """Raised when no current explicit approval authorizes the exact submission."""


class SubmissionBlockedError(DistributionStateError):
    """Raised when idempotency state forbids another submit side effect."""


class FailedRetryRequiresExplicitOptIn(SubmissionBlockedError):
    """Raised when a failed target is retryable but retry was not explicitly chosen."""


def _require_nonempty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DistributionValidationError(f"{field} must be a non-empty string")
    return value.strip()


def _require_sha256(value: Any, field: str) -> str:
    text = _require_nonempty_string(value, field).lower()
    if len(text) != 64 or any(character not in "0123456789abcdef" for character in text):
        raise DistributionValidationError(f"{field} must be a lowercase SHA-256 hex digest")
    return text


def _json_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise DistributionValidationError(f"value is not canonical JSON: {exc}") from exc


def payload_sha256(payload: Mapping[str, Any]) -> str:
    if not isinstance(payload, Mapping):
        raise DistributionValidationError("payload must be an object")
    return hashlib.sha256(_json_bytes(dict(payload))).hexdigest()


def _json_copy(value: Any) -> Any:
    return json.loads(_json_bytes(value).decode("utf-8"))


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _coerce_now(value: datetime | None) -> datetime:
    current = value or datetime.now(timezone.utc)
    if current.tzinfo is None or current.utcoffset() is None:
        raise DistributionValidationError("now must be timezone-aware")
    return current.astimezone(timezone.utc)


def _timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_timestamp(value: Any, field: str) -> datetime:
    text = _require_nonempty_string(value, field)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise DistributionValidationError(f"{field} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise DistributionValidationError(f"{field} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _current_user() -> str:
    """Return the effective local OS account, ignoring spoofable environment names."""
    try:
        return pwd.getpwuid(os.geteuid()).pw_name
    except (KeyError, AttributeError):
        return getpass.getuser()


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DistributionValidationError(f"cannot read {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise DistributionValidationError(f"{label} root must be an object")
    return value


def _atomic_write_json(path: Path, value: Mapping[str, Any]) -> None:
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(
        dict(value), ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False
    ) + "\n"
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
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


def _state_dir(value: Path | str) -> Path:
    return Path(value).expanduser().resolve()


def plan_path(state_dir: Path | str) -> Path:
    return _state_dir(state_dir) / "distribution_plan.json"


def target_key(platform: str, account_id: str) -> str:
    platform_value = _require_nonempty_string(platform, "platform")
    account_value = _require_nonempty_string(account_id, "account_id")
    return f"{platform_value}:{account_value}"


def _target_file_stem(key: str) -> str:
    # Account IDs are not necessarily safe filenames and may reveal private identifiers.
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]


def prepare_receipt_path(state_dir: Path | str, key: str) -> Path:
    return _state_dir(state_dir) / "prepare_receipts" / f"{_target_file_stem(key)}.json"


def approval_path(state_dir: Path | str, key: str) -> Path:
    return _state_dir(state_dir) / "approvals" / f"{_target_file_stem(key)}.json"


def publish_receipt_path(state_dir: Path | str, idempotency_key: str) -> Path:
    key = _require_nonempty_string(idempotency_key, "idempotency_key")
    return _state_dir(state_dir) / "publish_receipts" / f"{key}.json"


@contextmanager
def _idempotency_lock(state_dir: Path | str, idempotency_key: str):
    """Serialize check-and-reserve transitions for one logical public submission."""
    key = _require_nonempty_string(idempotency_key, "idempotency_key")
    lock_path = _state_dir(state_dir) / "locks" / f"{key}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def make_idempotency_key(
    release_revision_hash: str,
    platform: str,
    account_id: str,
    exact_payload_sha256: str,
) -> str:
    material = {
        "account_id": _require_nonempty_string(account_id, "account_id"),
        "payload_sha256": _require_sha256(exact_payload_sha256, "payload_sha256"),
        "platform": _require_nonempty_string(platform, "platform"),
        "release_revision_hash": _require_sha256(
            release_revision_hash, "release_revision_hash"
        ),
    }
    return "mp-" + hashlib.sha256(_json_bytes(material)).hexdigest()


def _normalize_target(raw: Mapping[str, Any], release_revision_hash: str) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise DistributionValidationError("every target must be an object")
    platform = _require_nonempty_string(raw.get("platform"), "targets[].platform")
    account_id = _require_nonempty_string(raw.get("account_id"), "targets[].account_id")
    payload = raw.get("payload")
    if not isinstance(payload, Mapping):
        raise DistributionValidationError("targets[].payload must be an object")
    exact_payload = _json_copy(dict(payload))
    payload_hash = payload_sha256(exact_payload)
    key = target_key(platform, account_id)
    return {
        "target_key": key,
        # MultiPost Desktop has no separate target ID.  Binding this stable ID still
        # prevents one prepared account from authorizing another account.
        "target_id": key,
        "platform": platform,
        "account_id": account_id,
        "payload": exact_payload,
        "payload_sha256": payload_hash,
        "idempotency_key": make_idempotency_key(
            release_revision_hash, platform, account_id, payload_hash
        ),
    }


def create_distribution_plan(
    state_dir: Path | str,
    *,
    release_package: Path | str,
    release_revision_id: str,
    release_revision_hash: str,
    targets: Sequence[Mapping[str, Any]],
    now: datetime | None = None,
) -> dict[str, Any]:
    """Create an immutable logical plan without changing the release package.

    Repeating the call with the exact same release and targets returns the existing plan.
    Any changed target, account, payload, or revision requires a new state directory.
    """
    package_path = Path(release_package).expanduser().resolve()
    if not package_path.is_file():
        raise DistributionValidationError("release_package must be an existing file")
    revision_id = _require_nonempty_string(release_revision_id, "release_revision_id")
    revision_hash = _require_sha256(release_revision_hash, "release_revision_hash")
    if isinstance(targets, (str, bytes)) or not isinstance(targets, Sequence) or not targets:
        raise DistributionValidationError("targets must be a non-empty list")
    normalized = [_normalize_target(item, revision_hash) for item in targets]
    normalized.sort(key=lambda item: item["target_key"])
    keys = [item["target_key"] for item in normalized]
    if len(keys) != len(set(keys)):
        raise DistributionValidationError("targets contain a duplicate platform/account_id")

    path = plan_path(state_dir)
    if path.exists():
        existing = load_distribution_plan(state_dir)
        expected_binding = {
            "release_package": str(package_path),
            "release_revision_id": revision_id,
            "release_revision_hash": revision_hash,
            "targets": normalized,
        }
        actual_binding = {field: existing.get(field) for field in expected_binding}
        if actual_binding != expected_binding:
            raise DistributionValidationError(
                "distribution plan already exists with a different revision or target payload"
            )
        return _json_copy(existing)

    created_at = _coerce_now(now)
    plan = {
        "schema_version": PLAN_SCHEMA,
        "distribution_plan_id": "dist-" + uuid.uuid4().hex,
        "created_at": _timestamp(created_at),
        "release_package": str(package_path),
        "release_revision_id": revision_id,
        "release_revision_hash": revision_hash,
        "targets": normalized,
    }
    _atomic_write_json(path, plan)
    return _json_copy(plan)


def load_distribution_plan(state_dir: Path | str) -> dict[str, Any]:
    value = _read_json(plan_path(state_dir), "distribution plan")
    if value.get("schema_version") != PLAN_SCHEMA:
        raise DistributionValidationError("unsupported distribution plan schema")
    _require_nonempty_string(value.get("distribution_plan_id"), "distribution_plan_id")
    _parse_timestamp(value.get("created_at"), "created_at")
    package = Path(_require_nonempty_string(value.get("release_package"), "release_package"))
    if not package.is_absolute():
        raise DistributionValidationError("release_package must be absolute")
    revision_id = _require_nonempty_string(value.get("release_revision_id"), "release_revision_id")
    revision_hash = _require_sha256(value.get("release_revision_hash"), "release_revision_hash")
    targets = value.get("targets")
    if not isinstance(targets, list) or not targets:
        raise DistributionValidationError("distribution plan targets must be a non-empty list")
    normalized = [_normalize_target(item, revision_hash) for item in targets]
    normalized.sort(key=lambda item: item["target_key"])
    if normalized != targets:
        raise DistributionValidationError("distribution plan targets are not canonical")
    keys = [item["target_key"] for item in targets]
    if len(keys) != len(set(keys)):
        raise DistributionValidationError("distribution plan contains duplicate targets")
    # Preserve strict validation of release identity even though it is used through lookup.
    if not revision_id:
        raise DistributionValidationError("release_revision_id is empty")
    return value


def _find_target(plan: Mapping[str, Any], platform: str, account_id: str) -> dict[str, Any]:
    key = target_key(platform, account_id)
    for item in plan["targets"]:
        if item.get("target_key") == key:
            if item.get("platform") != platform or item.get("account_id") != account_id:
                raise DistributionValidationError("target key has inconsistent account binding")
            return item
    raise DistributionValidationError(f"target is not in distribution plan: {key}")


def _target_content_type(target: Mapping[str, Any]) -> str:
    payload = target.get("payload")
    if not isinstance(payload, Mapping):
        raise DistributionValidationError("target payload must be an object")
    return _require_nonempty_string(
        payload.get("contentType") or payload.get("type"), "target.payload.contentType"
    ).upper()


def _runtime_canary(
    target: Mapping[str, Any],
    *,
    runtime_version: str,
    group_id: str,
    screenshot_sha256: str,
) -> dict[str, Any]:
    return {
        "canary_status": "passed",
        "runtime_version": _require_nonempty_string(runtime_version, "runtime_version"),
        "platform": target["platform"],
        "content_type": _target_content_type(target),
        "account_id": target["account_id"],
        "group_id": _require_nonempty_string(group_id, "group_id"),
        "auto_submit": False,
        "runtime_status": "ready",
        "screenshot_sha256": _require_sha256(
            screenshot_sha256, "runtime_canary.screenshot_sha256"
        ),
    }


def record_prepared_target(
    state_dir: Path | str,
    *,
    platform: str,
    account_id: str,
    group_id: str,
    prepared_payload: Mapping[str, Any],
    auto_submit: bool,
    status: str = "ready",
    screenshot_path: Path | str | None = None,
    runtime_version: str | None = None,
    canary_passed: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Record the exact non-submitting browser task returned by MultiPost prepare."""
    plan = load_distribution_plan(state_dir)
    target = _find_target(plan, platform, account_id)
    if auto_submit is not False:
        raise DistributionValidationError("prepared task must have auto_submit=false")
    if status not in {"ready", "failed", "unknown"}:
        raise DistributionValidationError("prepare status must be ready, failed, or unknown")
    exact_payload_hash = payload_sha256(prepared_payload)
    if exact_payload_hash != target["payload_sha256"]:
        raise DistributionValidationError("prepared payload differs from the planned payload")
    group = _require_nonempty_string(group_id, "group_id")
    key = target["target_key"]
    screenshot: str | None = None
    screenshot_sha256: str | None = None
    if screenshot_path is not None:
        screenshot_value = Path(screenshot_path).expanduser()
        if not screenshot_value.is_absolute():
            raise DistributionValidationError("screenshot_path must be absolute")
        screenshot_value = screenshot_value.resolve()
        if not screenshot_value.is_file():
            raise DistributionValidationError("screenshot_path must be an existing file")
        screenshot = str(screenshot_value)
        screenshot_sha256 = _file_sha256(screenshot_value)
    if status == "ready" and screenshot is None:
        raise DistributionValidationError(
            "ready prepare receipt requires a saved review screenshot"
        )
    runtime_canary: dict[str, Any] | None = None
    runtime_canary_sha256: str | None = None
    if status == "ready":
        if canary_passed is not True:
            raise DistributionValidationError(
                "ready prepare receipt requires a passed non-public runtime canary"
            )
        runtime_canary = _runtime_canary(
            target,
            runtime_version=_require_nonempty_string(runtime_version, "runtime_version"),
            group_id=group,
            screenshot_sha256=_require_sha256(screenshot_sha256, "screenshot_sha256"),
        )
        runtime_canary_sha256 = payload_sha256(runtime_canary)
    elif canary_passed is True or runtime_version is not None:
        raise DistributionValidationError(
            "a failed or unknown preparation cannot claim a passed runtime canary"
        )
    prepared_at = _coerce_now(now)
    receipt = {
        "schema_version": PREPARE_RECEIPT_SCHEMA,
        "prepare_receipt_id": "prepare-" + uuid.uuid4().hex,
        "distribution_plan_id": plan["distribution_plan_id"],
        "prepared_at": _timestamp(prepared_at),
        "status": status,
        "auto_submit": False,
        "release_revision_id": plan["release_revision_id"],
        "release_revision_hash": plan["release_revision_hash"],
        "target_key": key,
        "target_id": target["target_id"],
        "platform": target["platform"],
        "account_id": target["account_id"],
        "payload_sha256": target["payload_sha256"],
        "idempotency_key": target["idempotency_key"],
        "group_id": group,
        "screenshot_path": screenshot,
        "screenshot_sha256": screenshot_sha256,
        "runtime_canary": runtime_canary,
        "runtime_canary_sha256": runtime_canary_sha256,
    }
    # Replacing the current prepare receipt is intentional: any earlier approval embeds
    # its byte hash and therefore becomes stale immediately.
    _atomic_write_json(prepare_receipt_path(state_dir, key), receipt)
    return _json_copy(receipt)


def _load_prepare_receipt(
    state_dir: Path | str, plan: Mapping[str, Any], target: Mapping[str, Any]
) -> tuple[Path, dict[str, Any]]:
    path = prepare_receipt_path(state_dir, target["target_key"])
    receipt = _read_json(path, "prepare receipt")
    if receipt.get("schema_version") != PREPARE_RECEIPT_SCHEMA:
        raise DistributionValidationError("unsupported prepare receipt schema")
    expected = {
        "distribution_plan_id": plan["distribution_plan_id"],
        "release_revision_id": plan["release_revision_id"],
        "release_revision_hash": plan["release_revision_hash"],
        "target_key": target["target_key"],
        "target_id": target["target_id"],
        "platform": target["platform"],
        "account_id": target["account_id"],
        "payload_sha256": target["payload_sha256"],
        "idempotency_key": target["idempotency_key"],
    }
    for field, expected_value in expected.items():
        if receipt.get(field) != expected_value:
            raise DistributionValidationError(f"prepare receipt binding mismatch: {field}")
    _require_nonempty_string(receipt.get("prepare_receipt_id"), "prepare_receipt_id")
    _parse_timestamp(receipt.get("prepared_at"), "prepared_at")
    _require_nonempty_string(receipt.get("group_id"), "group_id")
    if receipt.get("auto_submit") is not False:
        raise DistributionValidationError("prepare receipt must preserve auto_submit=false")
    if receipt.get("status") not in {"ready", "failed", "unknown"}:
        raise DistributionValidationError("invalid prepare receipt status")
    screenshot_value = receipt.get("screenshot_path")
    screenshot_hash = receipt.get("screenshot_sha256")
    if receipt.get("status") == "ready":
        screenshot_text = _require_nonempty_string(screenshot_value, "screenshot_path")
        screenshot_path_value = Path(screenshot_text)
        if not screenshot_path_value.is_absolute() or not screenshot_path_value.is_file():
            raise DistributionValidationError(
                "ready prepare receipt screenshot must still exist at an absolute path"
            )
        expected_screenshot_hash = _require_sha256(
            screenshot_hash, "screenshot_sha256"
        )
        if _file_sha256(screenshot_path_value) != expected_screenshot_hash:
            raise DistributionValidationError("prepare review screenshot bytes changed")
        canary = receipt.get("runtime_canary")
        if not isinstance(canary, Mapping):
            raise DistributionValidationError("ready prepare receipt runtime canary is missing")
        expected_canary = _runtime_canary(
            target,
            runtime_version=_require_nonempty_string(
                canary.get("runtime_version"), "runtime_canary.runtime_version"
            ),
            group_id=receipt["group_id"],
            screenshot_sha256=expected_screenshot_hash,
        )
        if dict(canary) != expected_canary:
            raise DistributionValidationError("prepare runtime canary binding mismatch")
        if receipt.get("runtime_canary_sha256") != payload_sha256(expected_canary):
            raise DistributionValidationError("prepare runtime canary hash mismatch")
    elif (
        receipt.get("runtime_canary") is not None
        or receipt.get("runtime_canary_sha256") is not None
    ):
        raise DistributionValidationError(
            "a failed or unknown prepare receipt cannot contain a passed runtime canary"
        )
    return path, receipt


def approve_target(
    state_dir: Path | str,
    *,
    platform: str,
    account_id: str,
    confirmed_by_user: bool,
    approval_note: str = "",
    ttl_seconds: int = DEFAULT_APPROVAL_TTL_SECONDS,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Bind an explicit current-user approval to one exact prepared target."""
    if confirmed_by_user is not True:
        raise AuthorizationError("current user must explicitly confirm this prepared target")
    if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int):
        raise DistributionValidationError("ttl_seconds must be an integer")
    if ttl_seconds < 1 or ttl_seconds > MAX_APPROVAL_TTL_SECONDS:
        raise DistributionValidationError(
            f"ttl_seconds must be between 1 and {MAX_APPROVAL_TTL_SECONDS}"
        )
    if not isinstance(approval_note, str):
        raise DistributionValidationError("approval_note must be a string")
    if len(approval_note) > 1000:
        raise DistributionValidationError("approval_note is too long")

    plan = load_distribution_plan(state_dir)
    target = _find_target(plan, platform, account_id)
    prepare_path, prepared = _load_prepare_receipt(state_dir, plan, target)
    if prepared.get("status") != "ready":
        raise AuthorizationError("prepared target is not ready for approval")
    approved_at = _coerce_now(now)
    approval_id = "approval-" + uuid.uuid4().hex
    authorization_id = "authorization-" + uuid.uuid4().hex
    approval = {
        "schema_version": APPROVAL_SCHEMA,
        "approval_id": approval_id,
        "authorization_id": authorization_id,
        "approved": True,
        "confirmed_by_user": True,
        "approved_by": _current_user(),
        "approval_note": approval_note,
        "approved_at": _timestamp(approved_at),
        "expires_at": _timestamp(approved_at + timedelta(seconds=ttl_seconds)),
        "distribution_plan_id": plan["distribution_plan_id"],
        "release_revision_id": plan["release_revision_id"],
        "release_revision_hash": plan["release_revision_hash"],
        "target_key": target["target_key"],
        "target_id": target["target_id"],
        "platform": target["platform"],
        "account_id": target["account_id"],
        "payload_sha256": target["payload_sha256"],
        "idempotency_key": target["idempotency_key"],
        "group_id": prepared["group_id"],
        "prepare_receipt_id": prepared["prepare_receipt_id"],
        "prepare_receipt_sha256": _file_sha256(prepare_path),
        "runtime_canary_sha256": prepared["runtime_canary_sha256"],
    }
    _atomic_write_json(approval_path(state_dir, target["target_key"]), approval)
    return _json_copy(approval)


def _load_approval(
    state_dir: Path | str,
    plan: Mapping[str, Any],
    target: Mapping[str, Any],
    prepared_path: Path,
    prepared: Mapping[str, Any],
    now: datetime,
) -> dict[str, Any]:
    approval = _read_json(
        approval_path(state_dir, target["target_key"]), "publish approval"
    )
    if approval.get("schema_version") != APPROVAL_SCHEMA:
        raise AuthorizationError("unsupported publish approval schema")
    if approval.get("approved") is not True or approval.get("confirmed_by_user") is not True:
        raise AuthorizationError("publish approval is not explicitly approved")
    if approval.get("approved_by") != _current_user():
        raise AuthorizationError("publish approval belongs to a different local user")
    approved_at = _parse_timestamp(approval.get("approved_at"), "approved_at")
    expires_at = _parse_timestamp(approval.get("expires_at"), "expires_at")
    if expires_at <= approved_at:
        raise AuthorizationError("publish approval has an invalid validity window")
    if expires_at - approved_at > timedelta(seconds=MAX_APPROVAL_TTL_SECONDS):
        raise AuthorizationError("publish approval exceeds the maximum validity window")
    if approved_at > now + timedelta(seconds=5):
        raise AuthorizationError("publish approval timestamp is in the future")
    if now >= expires_at:
        raise AuthorizationError("publish approval has expired")
    expected = {
        "distribution_plan_id": plan["distribution_plan_id"],
        "release_revision_id": plan["release_revision_id"],
        "release_revision_hash": plan["release_revision_hash"],
        "target_key": target["target_key"],
        "target_id": target["target_id"],
        "platform": target["platform"],
        "account_id": target["account_id"],
        "payload_sha256": target["payload_sha256"],
        "idempotency_key": target["idempotency_key"],
        "group_id": prepared["group_id"],
        "prepare_receipt_id": prepared["prepare_receipt_id"],
        "prepare_receipt_sha256": _file_sha256(prepared_path),
        "runtime_canary_sha256": prepared["runtime_canary_sha256"],
    }
    for field, expected_value in expected.items():
        if approval.get(field) != expected_value:
            raise AuthorizationError(f"publish approval is stale or mismatched: {field}")
    _require_nonempty_string(approval.get("approval_id"), "approval_id")
    _require_nonempty_string(approval.get("authorization_id"), "authorization_id")
    return approval


def _existing_publish_receipt(
    state_dir: Path | str, idempotency_key: str
) -> dict[str, Any] | None:
    path = publish_receipt_path(state_dir, idempotency_key)
    if not path.exists():
        return None
    value = _read_json(path, "publish receipt")
    if value.get("schema_version") != PUBLISH_RECEIPT_SCHEMA:
        raise DistributionValidationError("unsupported publish receipt schema")
    if value.get("idempotency_key") != idempotency_key:
        raise DistributionValidationError("publish receipt idempotency key mismatch")
    status = value.get("status")
    if status not in {"submitting", "success", "failed", "unknown"}:
        raise DistributionValidationError("invalid publish receipt status")
    if isinstance(value.get("attempt"), bool) or not isinstance(value.get("attempt"), int):
        raise DistributionValidationError("publish receipt attempt must be an integer")
    if value["attempt"] < 1:
        raise DistributionValidationError("publish receipt attempt must be positive")
    return value


def require_publish_authorization(
    state_dir: Path | str,
    *,
    platform: str,
    account_id: str,
    group_id: str,
    payload: Mapping[str, Any],
    current_release_revision_id: str,
    current_release_revision_hash: str,
    now: datetime | None = None,
    allow_failed_retry: bool = False,
) -> dict[str, Any]:
    """Return the exact authorization mapping or fail closed.

    Callers must pass the revision identity returned by a *current* package verification,
    rather than trusting the revision captured in this state directory.
    """
    plan = load_distribution_plan(state_dir)
    revision_id = _require_nonempty_string(
        current_release_revision_id, "current_release_revision_id"
    )
    revision_hash = _require_sha256(
        current_release_revision_hash, "current_release_revision_hash"
    )
    if revision_id != plan["release_revision_id"]:
        raise AuthorizationError("approval does not belong to the current release revision")
    if revision_hash != plan["release_revision_hash"]:
        raise AuthorizationError("approval is stale for the current release revision hash")

    target = _find_target(plan, platform, account_id)
    if payload_sha256(payload) != target["payload_sha256"]:
        raise AuthorizationError("submission payload changed after planning")
    prepared_path, prepared = _load_prepare_receipt(state_dir, plan, target)
    if prepared.get("status") != "ready":
        raise AuthorizationError("prepared target is not ready")
    if _require_nonempty_string(group_id, "group_id") != prepared["group_id"]:
        raise AuthorizationError("submission group_id differs from the approved prepared task")
    current = _coerce_now(now)
    approval = _load_approval(
        state_dir, plan, target, prepared_path, prepared, current
    )

    existing = _existing_publish_receipt(state_dir, target["idempotency_key"])
    if allow_failed_retry is True and (
        existing is None or existing.get("status") != "failed"
    ):
        raise SubmissionBlockedError(
            "explicit retry requires an existing failed publish receipt"
        )
    if existing is not None:
        status = existing["status"]
        if status in BLOCKING_PUBLISH_STATUSES:
            raise SubmissionBlockedError(
                f"submission blocked: idempotency key is already {status}"
            )
        if status == "failed" and allow_failed_retry is not True:
            raise FailedRetryRequiresExplicitOptIn(
                "failed target requires a new approval and explicit single-target retry"
            )
        if status == "failed":
            failed_at = _parse_timestamp(existing.get("updated_at"), "publish receipt updated_at")
            newly_approved_at = _parse_timestamp(
                approval.get("approved_at"), "approved_at"
            )
            if newly_approved_at <= failed_at:
                raise AuthorizationError(
                    "failed target must be explicitly approved again after the failure"
                )
            if approval.get("approval_id") == existing.get("approval_id"):
                raise AuthorizationError(
                    "failed target retry requires a new approval_id"
                )
            if approval.get("authorization_id") == existing.get("authorization_id"):
                raise AuthorizationError(
                    "failed target retry requires a new authorization_id"
                )

    return {
        "authorized": True,
        "authorization_id": approval["authorization_id"],
        "approval_id": approval["approval_id"],
        "approved_at": approval["approved_at"],
        "expires_at": approval["expires_at"],
        "approved_by": approval["approved_by"],
        "distribution_plan_id": plan["distribution_plan_id"],
        "release_revision_id": plan["release_revision_id"],
        "release_revision_hash": plan["release_revision_hash"],
        "target_key": target["target_key"],
        "target_id": target["target_id"],
        "platform": target["platform"],
        "account_id": target["account_id"],
        "payload_sha256": target["payload_sha256"],
        "idempotency_key": target["idempotency_key"],
        "group_id": prepared["group_id"],
        "runtime_canary_sha256": prepared["runtime_canary_sha256"],
    }


def begin_submission(
    state_dir: Path | str,
    *,
    platform: str,
    account_id: str,
    group_id: str,
    payload: Mapping[str, Any],
    current_release_revision_id: str,
    current_release_revision_hash: str,
    now: datetime | None = None,
    retry_failed: bool = False,
) -> dict[str, Any]:
    """Atomically reserve one logical submission before the adapter side effect."""
    current = _coerce_now(now)
    plan = load_distribution_plan(state_dir)
    target = _find_target(plan, platform, account_id)
    with _idempotency_lock(state_dir, target["idempotency_key"]):
        authorization = require_publish_authorization(
            state_dir,
            platform=platform,
            account_id=account_id,
            group_id=group_id,
            payload=payload,
            current_release_revision_id=current_release_revision_id,
            current_release_revision_hash=current_release_revision_hash,
            now=current,
            allow_failed_retry=retry_failed,
        )
        path = publish_receipt_path(state_dir, authorization["idempotency_key"])
        previous = _existing_publish_receipt(state_dir, authorization["idempotency_key"])
        attempt = 1 if previous is None else previous["attempt"] + 1
        history = [] if previous is None else list(previous.get("history", []))
        history.append(
            {
                "status": "submitting",
                "at": _timestamp(current),
                "attempt": attempt,
                "authorization_id": authorization["authorization_id"],
            }
        )
        receipt = {
            "schema_version": PUBLISH_RECEIPT_SCHEMA,
            "status": "submitting",
            "attempt": attempt,
            "started_at": _timestamp(current),
            "updated_at": _timestamp(current),
            "authorization_id": authorization["authorization_id"],
            "approval_id": authorization["approval_id"],
            "distribution_plan_id": authorization["distribution_plan_id"],
            "release_revision_id": authorization["release_revision_id"],
            "release_revision_hash": authorization["release_revision_hash"],
            "target_key": authorization["target_key"],
            "target_id": authorization["target_id"],
            "platform": authorization["platform"],
            "account_id": authorization["account_id"],
            "payload_sha256": authorization["payload_sha256"],
            "idempotency_key": authorization["idempotency_key"],
            "group_id": authorization["group_id"],
            "runtime_canary_sha256": authorization["runtime_canary_sha256"],
            "history": history,
        }
        _atomic_write_json(path, receipt)
        return _json_copy(receipt)


def retry_failed_target(
    state_dir: Path | str,
    **kwargs: Any,
) -> dict[str, Any]:
    """Explicitly retry exactly one failed target; other terminal states stay blocked."""
    kwargs["retry_failed"] = True
    return begin_submission(state_dir, **kwargs)


def record_publish_result(
    state_dir: Path | str,
    authorization: Mapping[str, Any],
    *,
    status: str,
    remote_post_id: str | None = None,
    remote_post_url: str | None = None,
    error: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Record or reconcile a result without ever performing another submission."""
    if not isinstance(authorization, Mapping) or authorization.get("authorized") is not True:
        raise AuthorizationError("recording a publish result requires an authorization mapping")
    if status not in RESULT_STATUSES:
        raise DistributionValidationError("result status must be success, failed, or unknown")
    idempotency_key = _require_nonempty_string(
        authorization.get("idempotency_key"), "authorization.idempotency_key"
    )
    with _idempotency_lock(state_dir, idempotency_key):
        receipt_path = publish_receipt_path(state_dir, idempotency_key)
        receipt = _existing_publish_receipt(state_dir, idempotency_key)
        if receipt is None:
            raise DistributionValidationError("cannot record a result before begin_submission")
        expected = {
            "authorization_id": authorization.get("authorization_id"),
            "approval_id": authorization.get("approval_id"),
            "release_revision_id": authorization.get("release_revision_id"),
            "release_revision_hash": authorization.get("release_revision_hash"),
            "target_key": authorization.get("target_key"),
            "target_id": authorization.get("target_id"),
            "platform": authorization.get("platform"),
            "account_id": authorization.get("account_id"),
            "payload_sha256": authorization.get("payload_sha256"),
            "idempotency_key": idempotency_key,
            "group_id": authorization.get("group_id"),
            "runtime_canary_sha256": authorization.get("runtime_canary_sha256"),
        }
        for field, expected_value in expected.items():
            if not isinstance(expected_value, str) or not expected_value:
                raise AuthorizationError(f"authorization is missing {field}")
            if receipt.get(field) != expected_value:
                raise AuthorizationError(f"publish receipt differs from authorization: {field}")
        previous_status = receipt["status"]
        if previous_status == "success":
            if status == "success":
                return _json_copy(receipt)
            raise SubmissionBlockedError("successful publish receipt is terminal")
        if previous_status == "failed":
            raise DistributionValidationError(
                "failed receipt must pass through explicit retry before recording another result"
            )
        if previous_status not in {"submitting", "unknown"}:
            raise DistributionValidationError("publish receipt is not awaiting a result")

        current = _coerce_now(now)
        updated = dict(receipt)
        updated["status"] = status
        updated["updated_at"] = _timestamp(current)
        updated["remote_post_id"] = remote_post_id
        updated["remote_post_url"] = remote_post_url
        updated["error"] = error
        history = list(receipt.get("history", []))
        history.append(
            {
                "status": status,
                "at": _timestamp(current),
                "attempt": receipt["attempt"],
                "remote_post_id": remote_post_id,
                "remote_post_url": remote_post_url,
                "error": error,
            }
        )
        updated["history"] = history
        _atomic_write_json(receipt_path, updated)
        return _json_copy(updated)
