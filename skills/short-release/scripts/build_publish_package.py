#!/usr/bin/env python3
"""Internal library for building the shared cn_social_covers_v2 release package.

The supported command-line authority is ``release.py package`` because it validates the
current ``release-package-approval-v1`` receipt before calling this module. This module is
kept importable for that authority and for unit tests, but it must not expose a second CLI.
"""

from __future__ import annotations

import sys


if __name__ == "__main__":
    print(
        "Direct execution is disabled: use release.py package with a current "
        "--approval receipt. No release-package output was written.",
        file=sys.stderr,
    )
    raise SystemExit(2)


import hashlib
import json
import os
import unicodedata
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

import release_gate
import validate_publish_package as validator
import description_interaction as description_rules
from title_source import validate_title_source
from user_release_source import POLICY as USER_DESCRIPTION_POLICY, is_user_release


HANDOFF_SCHEMA = "video-release-handoff-v1"
PACKAGE_SCHEMA = "video-release-package-v1"
SAFE_RECTS: dict[str, list[int]] = {
    "douyin_cover": [72, 86, 936, 1240],
    "xiaohongshu_cover": [72, 86, 936, 1240],
    "wechat_channels_home": [72, 86, 936, 954],
    "wechat_channels_share": [96, 96, 1408, 984],
    "bilibili_cover": [96, 72, 1728, 936],
}
COMPOSITION_MODES = {
    "douyin_cover": "platform_specific",
    "xiaohongshu_cover": "platform_specific",
    "wechat_channels_home": "native_reflow",
    "wechat_channels_share": "platform_specific",
    "bilibili_cover": "platform_specific",
}
UPLOAD_CAVEATS = {
    "douyin_cover": "上传至抖音自定义封面槽位，并在账号当前发布界面复核裁切。",
    "xiaohongshu_cover": "上传至小红书视频笔记封面槽位，并在账号当前发布界面复核裁切。",
    "wechat_channels_home": "上传至视频号个人主页卡片槽位；必须使用原生 3:4 重排版本。",
    "wechat_channels_share": "上传至视频号分享卡片槽位；中心播放按钮区域不得遮挡标题、人脸或结果。",
    "bilibili_cover": "上传至 B 站视频封面槽位，并在当前发布界面复核 16:9 裁切。",
}
OPTIONAL_PASSTHROUGH_FIELDS = (
    "doubao_source",
    "user_release_source",
    "script_sha256",
    "title_source",
    "episode_id",
    "series_id",
    "public_name_mode",
    "title_alternatives",
    "platform_intro",
    "description_interaction",
    "platform_copy",
    "target_platforms",
    "production_manifest",
    "used_style_history",
    "editable_project",
    "jianying_draft",
    "logo_library",
    "platform_logo_library",
    "cover_platform_logo",
    "cover_asset_strategy",
    "cover_assets_by_size",
    "platform_cover_map",
)


class HandoffError(ValueError):
    """Raised when the producer handoff cannot authorize a release package."""


def normalize_cover_copy(value: str) -> str:
    """Normalize display wrapping only; wording, case, and punctuation stay significant."""
    return "".join(
        character
        for character in unicodedata.normalize("NFC", value)
        if not character.isspace()
    )


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise HandoffError(f"handoff file does not exist: {path}") from exc
    except json.JSONDecodeError as exc:
        raise HandoffError(f"handoff is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise HandoffError("handoff root must be a JSON object")
    return value


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def absolute_file(value: Any, field: str, errors: list[str]) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        errors.append(f"missing field: {field}")
        return None
    path = Path(value).expanduser()
    if not path.is_absolute():
        errors.append(f"{field} must be an absolute path")
        return None
    path = path.resolve()
    if not path.is_file() or path.stat().st_size == 0:
        errors.append(f"{field} is missing or empty: {path}")
        return None
    return path


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def image_dimensions(path: Path, field: str, expected: tuple[int, int], errors: list[str]) -> None:
    try:
        with Image.open(path) as image:
            if image.size != expected:
                errors.append(f"{field} size is {image.size}; expected {expected}")
    except Exception as exc:
        errors.append(f"{field} is not a readable image: {exc}")


def validate_handoff(handoff: dict[str, Any]) -> dict[str, Path]:
    errors: list[str] = []
    validate_title_source(handoff, errors, required=handoff.get("producer_skill") == "sticker")
    if handoff.get("schema_version") != HANDOFF_SCHEMA:
        errors.append(f"schema_version must be {HANDOFF_SCHEMA}")
    if not isinstance(handoff.get("producer_skill"), str) or not handoff["producer_skill"].strip():
        errors.append("producer_skill must be a non-empty string")
    if handoff.get("status") != "approved":
        errors.append("handoff status must be approved")
    revision = handoff.get("revision")
    if isinstance(revision, bool) or not (
        isinstance(revision, int)
        or (isinstance(revision, str) and bool(revision.strip()))
    ):
        errors.append("revision must be an integer or a non-empty string")
    for field in ("release_revision_id", "title", "brand_name", "description"):
        value = handoff.get(field)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"{field} must be a non-empty string")
    if "description_interaction" not in handoff and not is_user_release(handoff):
        errors.append("new handoff requires description_interaction")
    description_rules.validate_package_description(handoff, errors, [])
    cover_headline_text = handoff.get("cover_headline_text")
    cover_headline_lines = handoff.get("cover_headline_lines")
    if not isinstance(cover_headline_text, str) or not cover_headline_text.strip():
        errors.append("cover_headline_text must be a non-empty string")
    if (
        not isinstance(cover_headline_lines, list)
        or not cover_headline_lines
        or any(not isinstance(line, str) or not line.strip() for line in cover_headline_lines)
    ):
        errors.append("cover_headline_lines must contain one or more non-empty strings")
    title = handoff.get("title")
    if (
        isinstance(title, str)
        and title.strip()
        and isinstance(cover_headline_text, str)
        and cover_headline_text.strip()
    ):
        normalized_title = normalize_cover_copy(title)
        if normalize_cover_copy(cover_headline_text) != normalized_title:
            errors.append(
                "cover_headline_text must equal title after removing Unicode whitespace"
            )
        if isinstance(cover_headline_lines, list) and cover_headline_lines and all(
            isinstance(line, str) and line.strip() for line in cover_headline_lines
        ):
            if normalize_cover_copy("".join(cover_headline_lines)) != normalized_title:
                errors.append(
                    "joined cover_headline_lines must equal title after removing Unicode whitespace"
                )
    orientation = handoff.get("orientation")
    if orientation not in validator.MASTER_SIZES:
        errors.append("orientation must be portrait or landscape")
        orientation = "portrait"
    hashtags = handoff.get("hashtags")
    if (
        not isinstance(hashtags, list)
        or len(hashtags) != 5
        or any(not isinstance(item, str) or not item.strip() for item in hashtags)
    ):
        errors.append("hashtags must contain exactly five non-empty strings")

    resolved: dict[str, Path] = {}
    for field in ("video", "captions", "cover_master", "release_media_validation"):
        path = absolute_file(handoff.get(field), field, errors)
        if path is not None:
            resolved[field] = path
    if "cover_master" in resolved:
        image_dimensions(
            resolved["cover_master"],
            "cover_master",
            validator.master_dimensions(handoff, orientation),
            errors,
        )

    variants = handoff.get("cover_variants")
    if not isinstance(variants, dict):
        errors.append("cover_variants must be an object")
        variants = {}
    for variant_id, rule in validator.REQUIRED_COVER_VARIANTS.items():
        field = f"cover_variants.{variant_id}"
        path = absolute_file(variants.get(variant_id), field, errors)
        if path is not None:
            resolved[field] = path
            image_dimensions(path, field, rule["size"], errors)
    for variant_id, rule in validator.OPTIONAL_COVER_VARIANTS.items():
        if variant_id not in variants:
            continue
        field = f"cover_variants.{variant_id}"
        path = absolute_file(variants.get(variant_id), field, errors)
        if path is not None:
            resolved[field] = path
            image_dimensions(path, field, rule["size"], errors)
    undeclared = sorted(set(variants) - set(validator.CONFIGURED_COVER_VARIANTS))
    if undeclared:
        errors.append(
            "handoff cannot add cover variants without full manifest metadata: "
            + ", ".join(undeclared)
        )
    primary = handoff.get("primary_cover_variant_id", "douyin_cover")
    if primary not in validator.REQUIRED_COVER_VARIANTS:
        errors.append("primary_cover_variant_id must name a required cover variant")

    strategy = handoff.get("cover_asset_strategy")
    if strategy and strategy != "one_asset_per_dimensions":
        errors.append(f"unsupported cover_asset_strategy: {strategy}")
    if strategy == "one_asset_per_dimensions":
        assets_by_size = handoff.get("cover_assets_by_size")
        platform_map = handoff.get("platform_cover_map")
        if not isinstance(assets_by_size, dict):
            errors.append("cover_assets_by_size must be an object")
            assets_by_size = {}
        if not isinstance(platform_map, dict):
            errors.append("platform_cover_map must be an object")
            platform_map = {}
        grouped: dict[str, set[Path]] = {}
        for variant_id, value in variants.items():
            rule = validator.CONFIGURED_COVER_VARIANTS.get(variant_id)
            path = resolved.get(f"cover_variants.{variant_id}")
            if rule is None or path is None:
                continue
            key = validator.dimension_key(rule["size"])
            grouped.setdefault(key, set()).add(path.resolve())
            if platform_map.get(variant_id) != key:
                errors.append(f"platform_cover_map.{variant_id} must equal {key}")
        for key, paths in grouped.items():
            if len(paths) != 1:
                errors.append(f"dimension {key} must use exactly one shared cover asset")
                continue
            declared = assets_by_size.get(key)
            declared_path = absolute_file(declared, f"cover_assets_by_size.{key}", errors)
            if declared_path is not None and declared_path.resolve() != next(iter(paths)):
                errors.append(f"cover_assets_by_size.{key} does not match cover_variants")
        target_platforms = handoff.get("target_platforms")
        if isinstance(target_platforms, list) and "bilibili" in target_platforms:
            if "bilibili_cover" not in variants:
                errors.append("target_platforms includes bilibili but bilibili_cover is missing")

    media_path = resolved.get("release_media_validation")
    if media_path is not None:
        try:
            media_report = json.loads(media_path.read_text(encoding="utf-8"))
            if not isinstance(media_report, dict) or media_report.get("passed") is not True:
                errors.append("release_media_validation did not pass")
            video_path = resolved.get("video")
            declared_video = media_report.get("video") if isinstance(media_report, dict) else None
            if video_path is not None and isinstance(declared_video, str) and declared_video:
                declared_path = Path(declared_video)
                if not declared_path.is_absolute():
                    declared_path = (media_path.parent / declared_path).resolve()
                else:
                    declared_path = declared_path.resolve()
                if declared_path != video_path:
                    errors.append("release_media_validation points to a different video")
            declared_hash = media_report.get("video_sha256") if isinstance(media_report, dict) else None
            if declared_hash and video_path is not None and declared_hash != file_sha256(video_path):
                errors.append("video bytes changed after release_media_validation")
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"release_media_validation is invalid: {exc}")

    if errors:
        raise HandoffError("invalid release handoff:\n- " + "\n- ".join(errors))
    return resolved


def require_targets_available(paths: list[Path], force: bool) -> bool:
    """Return whether an existing complete package needs a guarded force rebuild."""
    existing = [path for path in paths if path.exists()]
    if existing and not force:
        formatted = "\n- ".join(str(path) for path in existing)
        raise HandoffError(
            "refusing to overwrite an existing release package; use a new revision directory "
            f"or pass --force:\n- {formatted}"
        )
    if not existing:
        return False
    missing = [path for path in paths if not path.is_file() or path.stat().st_size == 0]
    if missing:
        formatted = "\n- ".join(str(path) for path in missing)
        raise HandoffError(
            "--force requires a complete, non-empty existing package; refusing a partial "
            f"overwrite:\n- {formatted}"
        )
    return True


def require_deterministic_force(
    package_path: Path,
    report_path: Path,
    expected_package: dict[str, Any],
) -> None:
    """Permit --force only for an unchanged and currently validated release binding."""
    try:
        existing_package = json.loads(package_path.read_text(encoding="utf-8"))
        existing_report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HandoffError(f"--force cannot read the existing package binding: {exc}") from exc
    if not isinstance(existing_package, dict) or not isinstance(existing_report, dict):
        raise HandoffError("--force requires object-valued package and validation JSON")

    expected_revision_id = expected_package["release_revision_id"]
    if existing_package.get("release_revision_id") != expected_revision_id:
        raise HandoffError(
            "--force requires the same release_revision_id; assign a new revision directory "
            "for changed releases"
        )
    if existing_report.get("release_revision_id") != expected_revision_id:
        raise HandoffError(
            "--force refused because the existing validation report is bound to a different "
            "release_revision_id"
        )
    if existing_package != expected_package:
        raise HandoffError(
            "--force only permits an exact deterministic rebuild of the existing release; "
            "handoff fields, paths, or bound metadata changed"
        )
    try:
        release_gate.require_current_publish_validation(package_path)
    except release_gate.ReleaseGateError as exc:
        raise HandoffError(
            "--force refused because the existing publish-package validation is stale: "
            f"{exc}"
        ) from exc


def render_thumbnail(source: Path, target: Path, variant_id: str) -> None:
    rule = validator.CONFIGURED_COVER_VARIANTS[variant_id]
    with Image.open(source) as image:
        preview = image.convert("RGBA").resize(rule["preview_size"], Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(preview, "RGBA")
    width, height = preview.size
    if variant_id == "wechat_channels_home":
        risk_top = round(height * 0.72)
        draw.rectangle((0, risk_top, width, height), fill=(0, 0, 0, 118))
    elif variant_id == "wechat_channels_share":
        radius = max(18, round(min(width, height) * 0.09))
        center_x, center_y = width // 2, height // 2
        draw.ellipse(
            (center_x - radius, center_y - radius, center_x + radius, center_y + radius),
            fill=(0, 0, 0, 125),
            outline=(255, 255, 255, 210),
            width=2,
        )
        triangle = [
            (center_x - radius // 3, center_y - radius // 2),
            (center_x - radius // 3, center_y + radius // 2),
            (center_x + radius // 2, center_y),
        ]
        draw.polygon(triangle, fill=(255, 255, 255, 230))
    target.parent.mkdir(parents=True, exist_ok=True)
    preview.convert("RGB").save(target, format="PNG", optimize=True)


def publish_copy_text(handoff: dict[str, Any]) -> str:
    alternatives = handoff.get("title_alternatives")
    alternative_lines = ""
    if isinstance(alternatives, list) and alternatives:
        alternative_lines = "\n\n## 备选标题\n\n" + "\n".join(
            f"- {str(item).strip()}" for item in alternatives if str(item).strip()
        )
    intro = handoff.get("platform_intro")
    intro_block = f"\n\n## 平台导语\n\n{str(intro).strip()}" if intro else ""
    tags = " ".join(
        item if item.startswith("#") else f"#{item}" for item in handoff["hashtags"]
    )
    return (
        "# 发布文案\n\n"
        f"## 发布标题\n\n{handoff['title']}"
        f"{alternative_lines}"
        f"{intro_block}\n\n"
        f"## 简介\n\n{handoff['description'] if is_user_release(handoff) else str(handoff['description']).strip()}\n\n"
        f"## 话题\n\n{tags}\n"
    )


def build_package(handoff_path: Path, output_dir: Path, *, force: bool = False) -> tuple[Path, dict[str, Any]]:
    handoff_path = handoff_path.resolve()
    output_dir = output_dir.resolve()
    handoff = read_json(handoff_path)
    resolved = validate_handoff(handoff)

    copy_path = output_dir / "publish_copy.md"
    manifest_path = output_dir / "cover" / "platforms" / "platform-cover-specs.json"
    package_path = output_dir / "publish_package.json"
    report_path = output_dir / "publish_package_validation.json"
    declared_variants = handoff.get("cover_variants")
    declared_variants = declared_variants if isinstance(declared_variants, dict) else {}
    variant_ids = [
        variant_id
        for variant_id in validator.CONFIGURED_COVER_VARIANTS
        if variant_id in declared_variants
    ]
    preview_paths = {
        variant_id: output_dir
        / "cover"
        / "platforms"
        / "previews"
        / f"{variant_id}-preview.png"
        for variant_id in variant_ids
    }
    variants: dict[str, str] = {}
    manifest_entries: list[dict[str, Any]] = []
    primary_id = str(handoff.get("primary_cover_variant_id", "douyin_cover"))
    for variant_id in variant_ids:
        rule = validator.CONFIGURED_COVER_VARIANTS[variant_id]
        source = resolved[f"cover_variants.{variant_id}"]
        preview = preview_paths[variant_id]
        variants[variant_id] = str(source)
        entry: dict[str, Any] = {
            "id": variant_id,
            "platform": rule["platform"],
            "display_slot": rule["display_slot"],
            "role": "primary" if variant_id == primary_id else "secondary",
            "path": str(source),
            "dimensions": list(rule["size"]),
            "aspect_ratio": rule["aspect_ratio"],
            "composition_mode": COMPOSITION_MODES[variant_id],
            "safe_rect": SAFE_RECTS[variant_id],
            "thumbnail_preview": str(preview),
            "upload_caveat": UPLOAD_CAVEATS[variant_id],
        }
        if variant_id == "wechat_channels_share":
            entry["overlay_exclusion"] = [680, 480, 240, 240]
        manifest_entries.append(entry)

    manifest = {
        "schema_version": "2.0",
        "cover_profile_id": validator.COVER_PROFILE_ID,
        "release_revision_id": handoff["release_revision_id"],
        "primary_cover_variant_id": primary_id,
        "variants": manifest_entries,
    }
    for field in (
        "cover_asset_strategy",
        "cover_assets_by_size",
        "platform_cover_map",
    ):
        if field in handoff:
            manifest[field] = handoff[field]
    primary_rule = validator.REQUIRED_COVER_VARIANTS[primary_id]
    package: dict[str, Any] = {
        "schema_version": PACKAGE_SCHEMA,
        "producer_skill": handoff["producer_skill"],
        "release_handoff": str(handoff_path),
        "release_handoff_sha256": file_sha256(handoff_path),
        "status": "approved",
        "revision": handoff["revision"],
        "release_revision_id": handoff["release_revision_id"],
        "orientation": handoff["orientation"],
        "title": handoff["title"] if "title_source" in handoff else str(handoff["title"]).strip(),
        "cover_headline_text": str(handoff["cover_headline_text"]).strip(),
        "cover_headline_lines": [
            str(line).strip() for line in handoff["cover_headline_lines"]
        ],
        "description": handoff["description"] if is_user_release(handoff) else str(handoff["description"]).strip(),
        "description_policy": USER_DESCRIPTION_POLICY if is_user_release(handoff) else description_rules.DESCRIPTION_POLICY,
        "description_file": str(copy_path),
        "hashtags": handoff["hashtags"],
        "brand_name": str(handoff["brand_name"]).strip(),
        "video": str(resolved["video"]),
        "captions": str(resolved["captions"]),
        "cover_master": str(resolved["cover_master"]),
        "cover_profile_id": validator.COVER_PROFILE_ID,
        "primary_cover_variant_id": primary_id,
        "cover_variants_manifest": str(manifest_path),
        "cover_variants": variants,
        "cover_platform": variants[primary_id],
        "cover_platform_dimensions": list(primary_rule["size"]),
        "release_media_validation": str(resolved["release_media_validation"]),
        "release_media_validation_sha256": file_sha256(
            resolved["release_media_validation"]
        ),
        "publish_package_validation": str(report_path),
    }
    for field in OPTIONAL_PASSTHROUGH_FIELDS:
        if field in handoff:
            package[field] = handoff[field]

    targets = [
        copy_path,
        manifest_path,
        package_path,
        report_path,
        *preview_paths.values(),
    ]
    guarded_rebuild = require_targets_available(targets, force)
    if guarded_rebuild:
        require_deterministic_force(package_path, report_path, package)

    output_dir.mkdir(parents=True, exist_ok=True)
    for variant_id in variant_ids:
        render_thumbnail(
            resolved[f"cover_variants.{variant_id}"],
            preview_paths[variant_id],
            variant_id,
        )
    copy_path.write_text(publish_copy_text(handoff), encoding="utf-8")
    write_json(manifest_path, manifest)
    write_json(package_path, package)

    report = validator.validate_package(package_path)
    write_json(report_path, report)
    if report.get("passed") is not True:
        raise HandoffError(
            "generated publish package failed validation:\n- "
            + "\n- ".join(str(error) for error in report.get("errors", []))
        )
    return package_path, report
