"""Validate an inherited title without generating or rewriting any copy."""
from __future__ import annotations

import hashlib
from typing import Any


def validate_title_source(data: dict[str, Any], errors: list[str], *, required: bool = False) -> None:
    source = data.get("title_source")
    if "title_source" not in data and not required:
        return
    if not isinstance(source, dict):
        errors.append("title_source must contain the upstream-approved title")
        return
    if source.get("policy") != "reuse-upstream-title-v1":
        errors.append("title_source.policy must be reuse-upstream-title-v1")
    field = source.get("field")
    if not isinstance(field, str) or field not in {"原创标题", "user-supplied"}:
        errors.append("title_source.field must be 原创标题 or user-supplied")
    if field == "原创标题" and not (
        isinstance(source.get("record_id"), str) and source["record_id"].strip()
    ):
        errors.append("title_source.record_id is required for a pool title")
    value = source.get("value")
    if not isinstance(value, str) or not value.strip():
        errors.append("title_source.value must be a non-empty string")
    else:
        if data.get("title") != value:
            errors.append("title must exactly equal the upstream title_source.value; do not rewrite it")
        if source.get("sha256") != hashlib.sha256(value.encode("utf-8")).hexdigest():
            errors.append("title_source.sha256 does not match the upstream title")
    if not isinstance(source.get("approval_note"), str) or not source["approval_note"].strip():
        errors.append("title_source.approval_note must record actual user approval")
