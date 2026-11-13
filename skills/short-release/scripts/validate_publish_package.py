#!/usr/bin/env python3
"""Validate copy, media, and the complete multi-platform cover release package."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import unicodedata
from pathlib import Path
from typing import Any

from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from description_interaction import validate_package_description
from title_source import validate_title_source
from user_release_source import is_user_release


MASTER_SIZES = {"portrait": (1080, 1920), "landscape": (1920, 1080)}
COVER_PROFILE_ID = "cn_social_covers_v2"
REQUIRED_COVER_VARIANTS: dict[str, dict[str, Any]] = {
    "douyin_cover": {
        "platform": "douyin",
        "display_slot": "custom_cover",
        "size": (1080, 1440),
        "aspect_ratio": "3:4",
        "preview_size": (180, 240),
        "asset_group": "1080x1440",
    },
    "xiaohongshu_cover": {
        "platform": "xiaohongshu",
        "display_slot": "video_note_cover",
        "size": (1080, 1440),
        "aspect_ratio": "3:4",
        "preview_size": (180, 240),
        "asset_group": "1080x1440",
    },
    "wechat_channels_home": {
        "platform": "wechat_channels",
        "display_slot": "personal_homepage_card",
        "size": (1080, 1440),
        "aspect_ratio": "3:4",
        "preview_size": (180, 240),
        "asset_group": "1080x1440",
    },
    "wechat_channels_share": {
        "platform": "wechat_channels",
        "display_slot": "share_card",
        "size": (1600, 1200),
        "aspect_ratio": "4:3",
        "preview_size": (320, 240),
        "asset_group": "1600x1200",
    },
}
OPTIONAL_COVER_VARIANTS: dict[str, dict[str, Any]] = {
    "bilibili_cover": {
        "platform": "bilibili",
        "display_slot": "video_cover",
        "size": (1920, 1080),
        "aspect_ratio": "16:9",
        "preview_size": (320, 180),
        "asset_group": "1920x1080",
    },
}
CONFIGURED_COVER_VARIANTS: dict[str, dict[str, Any]] = {
    **REQUIRED_COVER_VARIANTS,
    **OPTIONAL_COVER_VARIANTS,
}


def master_dimensions(data: dict[str, Any], orientation: str) -> tuple[int, int]:
    """Native-size masters must be the exact mapped primary asset, not a new image."""
    primary = data.get("primary_cover_variant_id", "douyin_cover")
    rule = REQUIRED_COVER_VARIANTS.get(primary)
    variants = data.get("cover_variants")
    assets = data.get("cover_assets_by_size")
    mapping = data.get("platform_cover_map")
    if (
        data.get("cover_asset_strategy") == "one_asset_per_dimensions"
        and rule
        and isinstance(variants, dict)
        and isinstance(assets, dict)
        and isinstance(mapping, dict)
        and mapping.get(primary) == rule["asset_group"]
        and isinstance(data.get("cover_master"), str)
        and data["cover_master"] == variants.get(primary) == assets.get(rule["asset_group"])
    ):
        return rule["size"]
    return MASTER_SIZES[orientation]


def normalize_cover_copy(value: str) -> str:
    """Normalize display wrapping only; wording, case, and punctuation stay significant."""
    return "".join(
        character
        for character in unicodedata.normalize("NFC", value)
        if not character.isspace()
    )


def validate_cover_title_parity(
    package: dict[str, Any], title: str, errors: list[str], warnings: list[str]
) -> None:
    """Validate new title metadata while allowing old packages to verify unchanged."""
    headline_present = "cover_headline_text" in package
    lines_present = "cover_headline_lines" in package
    if not headline_present and not lines_present:
        warnings.append(
            "legacy package: missing cover headline parity metadata; title-to-pixels was not machine-checked"
        )
        return
    if not headline_present or not lines_present:
        errors.append(
            "cover_headline_text and cover_headline_lines must be supplied together"
        )
        return

    headline = package.get("cover_headline_text")
    lines = package.get("cover_headline_lines")
    if not isinstance(headline, str) or not headline.strip():
        errors.append("cover_headline_text must be a non-empty string")
        return
    if (
        not isinstance(lines, list)
        or not lines
        or any(not isinstance(line, str) or not line.strip() for line in lines)
    ):
        errors.append("cover_headline_lines must contain one or more non-empty strings")
        return

    normalized_title = normalize_cover_copy(title)
    if normalize_cover_copy(headline) != normalized_title:
        errors.append(
            "cover_headline_text must equal title after removing Unicode whitespace"
        )
    if normalize_cover_copy("".join(lines)) != normalized_title:
        errors.append(
            "joined cover_headline_lines must equal title after removing Unicode whitespace"
        )


def resolve_path(value: str, package_path: Path) -> Path:
    path = Path(value)
    return path.resolve() if path.is_absolute() else (package_path.parent / path).resolve()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checked_file(value: Any, field: str, errors: list[str], package_path: Path) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        errors.append(f"missing field: {field}")
        return None
    file_path = resolve_path(value, package_path)
    if not file_path.is_file() or file_path.stat().st_size == 0:
        errors.append(f"missing or empty file for {field}: {value}")
        return None
    return file_path


def image_size(
    value: Any,
    field: str,
    expected: tuple[int, int] | None,
    errors: list[str],
    package_path: Path,
) -> Path | None:
    file_path = checked_file(value, field, errors, package_path)
    if file_path is None:
        return None
    try:
        with Image.open(file_path) as image:
            actual = image.size
            if expected and actual != expected:
                errors.append(f"{field} size is {actual}; expected {expected}")
    except Exception as exc:
        errors.append(f"unreadable image for {field}: {exc}")
        return None
    return file_path


def dimensions(value: Any) -> tuple[int, int] | None:
    if not isinstance(value, list) or len(value) != 2:
        return None
    try:
        return int(value[0]), int(value[1])
    except (TypeError, ValueError):
        return None


def dimension_key(size: tuple[int, int]) -> str:
    return f"{size[0]}x{size[1]}"


def require_absolute_path(value: Any, field: str, errors: list[str]) -> None:
    if not isinstance(value, str) or not value.strip() or not Path(value).expanduser().is_absolute():
        errors.append(f"{field} must be an absolute path")


def validate_rect(value: Any, field: str, size: tuple[int, int], errors: list[str]) -> None:
    if not isinstance(value, list) or len(value) != 4:
        errors.append(f"{field} must be [x,y,width,height]")
        return
    try:
        x, y, width, height = (float(item) for item in value)
    except (TypeError, ValueError):
        errors.append(f"{field} contains non-numeric values")
        return
    if min(x, y, width, height) < 0 or width <= 0 or height <= 0:
        errors.append(f"{field} contains an invalid rectangle")
        return
    canvas_width, canvas_height = size
    normalized = max(x, y, width, height) <= 1.0
    if normalized:
        if x + width > 1.000001 or y + height > 1.000001:
            errors.append(f"{field} exceeds normalized canvas bounds")
    elif x + width > canvas_width or y + height > canvas_height:
        errors.append(f"{field} exceeds pixel canvas bounds {size}")


def normalize_manifest_variants(value: Any, errors: list[str]) -> dict[str, dict[str, Any]]:
    if isinstance(value, dict):
        normalized: dict[str, dict[str, Any]] = {}
        for variant_id, item in value.items():
            if not isinstance(item, dict):
                errors.append(f"manifest variant {variant_id} must be an object")
                continue
            normalized[str(variant_id)] = {"id": str(variant_id), **item}
        return normalized
    if isinstance(value, list):
        normalized = {}
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                errors.append(f"manifest variants[{index}] must be an object")
                continue
            variant_id = item.get("id")
            if not isinstance(variant_id, str) or not variant_id:
                errors.append(f"manifest variants[{index}] is missing id")
                continue
            if variant_id in normalized:
                errors.append(f"duplicate manifest variant id: {variant_id}")
                continue
            normalized[variant_id] = item
        return normalized
    errors.append("manifest variants must be an array or object")
    return {}


def validate_cover_profile(
    package: dict[str, Any],
    package_path: Path,
    revision_id: Any,
    errors: list[str],
    warnings: list[str],
) -> tuple[dict[str, Path], Path | None, str | None]:
    profile_id = package.get("cover_profile_id")
    if not profile_id:
        warnings.append(
            "legacy package: missing cover_profile_id; the four-platform cover set was not enforced"
        )
        return {}, None, None
    if profile_id != COVER_PROFILE_ID:
        errors.append(f"unsupported cover_profile_id: {profile_id}")
        return {}, None, None
    if not package.get("release_revision_id"):
        errors.append("new-profile package requires release_revision_id")
    if not package.get("revision"):
        errors.append("new-profile package requires revision")
    if not isinstance(package.get("publish_package_validation"), str) or not package[
        "publish_package_validation"
    ].strip():
        errors.append("new-profile package requires publish_package_validation report path")
    for field in (
        "video",
        "captions",
        "description_file",
        "cover_master",
        "cover_platform",
        "cover_variants_manifest",
        "release_media_validation",
        "publish_package_validation",
    ):
        require_absolute_path(package.get(field), field, errors)

    variants_value = package.get("cover_variants")
    if not isinstance(variants_value, dict):
        errors.append("cover_variants must be an object")
        variants_value = {}
    for variant_id, value in variants_value.items():
        require_absolute_path(value, f"cover_variants.{variant_id}", errors)

    variant_paths: dict[str, Path] = {}
    for variant_id, rule in REQUIRED_COVER_VARIANTS.items():
        file_path = image_size(
            variants_value.get(variant_id),
            f"cover_variants.{variant_id}",
            rule["size"],
            errors,
            package_path,
        )
        if file_path is not None:
            variant_paths[variant_id] = file_path
    for variant_id, value in sorted(variants_value.items()):
        if variant_id in REQUIRED_COVER_VARIANTS:
            continue
        configured_rule = OPTIONAL_COVER_VARIANTS.get(str(variant_id))
        file_path = image_size(
            value,
            f"cover_variants.{variant_id}",
            configured_rule["size"] if configured_rule else None,
            errors,
            package_path,
        )
        if file_path is not None:
            variant_paths[str(variant_id)] = file_path

    manifest_path = checked_file(
        package.get("cover_variants_manifest"),
        "cover_variants_manifest",
        errors,
        package_path,
    )
    manifest: dict[str, Any] = {}
    if manifest_path is not None:
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:
            errors.append(f"invalid cover_variants_manifest JSON: {exc}")

    if manifest:
        if str(manifest.get("schema_version")) != "2.0":
            errors.append("cover manifest schema_version must be 2.0")
        manifest_profile = manifest.get("cover_profile_id") or manifest.get("profile_id")
        if manifest_profile != COVER_PROFILE_ID:
            errors.append("cover manifest profile does not match cover_profile_id")
        if manifest.get("release_revision_id") != revision_id:
            errors.append("cover manifest release_revision_id does not match package")
        for field in (
            "cover_asset_strategy",
            "cover_assets_by_size",
            "platform_cover_map",
        ):
            if field in package and manifest.get(field) != package.get(field):
                errors.append(f"cover manifest {field} does not match package")

    primary_id = package.get("primary_cover_variant_id")
    if not isinstance(primary_id, str) or primary_id not in REQUIRED_COVER_VARIANTS:
        errors.append("primary_cover_variant_id must name a required cover variant")
        primary_id = None
    manifest_primary = manifest.get("primary_cover_variant_id") or manifest.get("primary_variant_id")
    if manifest and manifest_primary != primary_id:
        errors.append("cover manifest primary variant does not match package")

    manifest_variants = normalize_manifest_variants(manifest.get("variants"), errors) if manifest else {}
    for variant_id, rule in REQUIRED_COVER_VARIANTS.items():
        entry = manifest_variants.get(variant_id)
        if entry is None:
            errors.append(f"cover manifest is missing variant: {variant_id}")
            continue
        for key in ("role", "upload_caveat"):
            if not isinstance(entry.get(key), str) or not entry[key].strip():
                errors.append(f"manifest variant {variant_id} is missing {key}")
        if entry.get("platform") != rule["platform"]:
            errors.append(f"manifest variant {variant_id} has wrong platform")
        if entry.get("display_slot") != rule["display_slot"]:
            errors.append(f"manifest variant {variant_id} has wrong display_slot")
        if dimensions(entry.get("dimensions")) != rule["size"]:
            errors.append(f"manifest variant {variant_id} has wrong dimensions")
        if entry.get("aspect_ratio") != rule["aspect_ratio"]:
            errors.append(f"manifest variant {variant_id} has wrong aspect_ratio")
        composition_mode = entry.get("composition_mode")
        if composition_mode not in {
            "native_reflow",
            "platform_specific",
            "approved_shared_composition",
        }:
            errors.append(f"manifest variant {variant_id} has invalid composition_mode")
        if variant_id == "wechat_channels_home" and composition_mode != "native_reflow":
            errors.append("wechat_channels_home must use composition_mode=native_reflow")
        package_variant = variants_value.get(variant_id)
        entry_path = entry.get("path")
        require_absolute_path(entry_path, f"manifest {variant_id}.path", errors)
        if isinstance(package_variant, str) and isinstance(entry_path, str):
            if resolve_path(package_variant, package_path) != resolve_path(
                entry_path, manifest_path or package_path
            ):
                errors.append(f"manifest path does not match cover_variants.{variant_id}")
        else:
            errors.append(f"manifest variant {variant_id} is missing path")
        validate_rect(entry.get("safe_rect"), f"manifest {variant_id}.safe_rect", rule["size"], errors)
        if variant_id == "wechat_channels_share" and not entry.get("overlay_exclusion"):
            errors.append("wechat_channels_share must declare overlay_exclusion")
        image_size(
            entry.get("thumbnail_preview"),
            f"manifest {variant_id}.thumbnail_preview",
            rule["preview_size"],
            errors,
            manifest_path or package_path,
        )
        require_absolute_path(
            entry.get("thumbnail_preview"),
            f"manifest {variant_id}.thumbnail_preview",
            errors,
        )

    for variant_id in sorted(set(variants_value) - set(REQUIRED_COVER_VARIANTS)):
        entry = manifest_variants.get(str(variant_id))
        if entry is None:
            errors.append(f"cover manifest is missing declared extra variant: {variant_id}")
            continue
        entry_path = entry.get("path")
        package_variant = variants_value.get(variant_id)
        require_absolute_path(entry_path, f"manifest extra {variant_id}.path", errors)
        if not isinstance(entry_path, str) or not isinstance(package_variant, str):
            errors.append(f"manifest extra variant {variant_id} is missing path")
        elif resolve_path(package_variant, package_path) != resolve_path(
            entry_path, manifest_path or package_path
        ):
            errors.append(f"manifest path does not match cover_variants.{variant_id}")
        for key in ("platform", "display_slot", "role", "aspect_ratio", "upload_caveat"):
            if not isinstance(entry.get(key), str) or not entry[key].strip():
                errors.append(f"manifest extra variant {variant_id} is missing {key}")
        configured_rule = OPTIONAL_COVER_VARIANTS.get(str(variant_id))
        if configured_rule:
            if entry.get("platform") != configured_rule["platform"]:
                errors.append(f"manifest extra variant {variant_id} has wrong platform")
            if entry.get("display_slot") != configured_rule["display_slot"]:
                errors.append(f"manifest extra variant {variant_id} has wrong display_slot")
            if entry.get("aspect_ratio") != configured_rule["aspect_ratio"]:
                errors.append(f"manifest extra variant {variant_id} has wrong aspect_ratio")
        declared_size = dimensions(entry.get("dimensions"))
        if declared_size is None:
            errors.append(f"manifest extra variant {variant_id} has invalid dimensions")
        else:
            image_size(
                package_variant,
                f"cover_variants.{variant_id}",
                declared_size,
                errors,
                package_path,
            )
        composition_mode = entry.get("composition_mode")
        if composition_mode not in {
            "native_reflow",
            "platform_specific",
            "approved_shared_composition",
        }:
            errors.append(f"manifest extra variant {variant_id} has invalid composition_mode")
        if declared_size is not None:
            validate_rect(
                entry.get("safe_rect"),
                f"manifest extra {variant_id}.safe_rect",
                declared_size,
                errors,
            )
        checked_file(
            entry.get("thumbnail_preview"),
            f"manifest extra {variant_id}.thumbnail_preview",
            errors,
            manifest_path or package_path,
        )
        if configured_rule:
            image_size(
                entry.get("thumbnail_preview"),
                f"manifest extra {variant_id}.thumbnail_preview",
                configured_rule["preview_size"],
                errors,
                manifest_path or package_path,
            )
        require_absolute_path(
            entry.get("thumbnail_preview"),
            f"manifest extra {variant_id}.thumbnail_preview",
            errors,
        )

    for variant_id in sorted(set(manifest_variants) - set(variants_value)):
        errors.append(f"cover manifest declares an unmapped variant: {variant_id}")

    if primary_id:
        primary_value = variants_value.get(primary_id)
        primary_rule = REQUIRED_COVER_VARIANTS[primary_id]
        alias_value = package.get("cover_platform")
        if not isinstance(primary_value, str) or not isinstance(alias_value, str):
            errors.append("cover_platform must alias the primary cover variant")
        elif resolve_path(primary_value, package_path) != resolve_path(alias_value, package_path):
            errors.append("cover_platform does not alias primary_cover_variant_id")
        if dimensions(package.get("cover_platform_dimensions")) != primary_rule["size"]:
            errors.append("cover_platform_dimensions do not match primary_cover_variant_id")

    strategy = package.get("cover_asset_strategy")
    if strategy:
        if strategy != "one_asset_per_dimensions":
            errors.append(f"unsupported cover_asset_strategy: {strategy}")
        assets_by_size = package.get("cover_assets_by_size")
        platform_map = package.get("platform_cover_map")
        if not isinstance(assets_by_size, dict):
            errors.append("cover_assets_by_size must be an object")
            assets_by_size = {}
        if not isinstance(platform_map, dict):
            errors.append("platform_cover_map must be an object")
            platform_map = {}

        grouped_paths: dict[str, set[Path]] = {}
        for variant_id, path in variant_paths.items():
            rule = CONFIGURED_COVER_VARIANTS.get(variant_id)
            entry = manifest_variants.get(variant_id, {})
            size = rule["size"] if rule else dimensions(entry.get("dimensions"))
            if size is None:
                continue
            key = dimension_key(size)
            grouped_paths.setdefault(key, set()).add(path.resolve())
            if platform_map.get(variant_id) != key:
                errors.append(f"platform_cover_map.{variant_id} must equal {key}")

        for key, paths in grouped_paths.items():
            if len(paths) != 1:
                errors.append(f"dimension {key} must use exactly one shared cover asset")
                continue
            declared = assets_by_size.get(key)
            if not isinstance(declared, str) or not declared.strip():
                errors.append(f"cover_assets_by_size is missing {key}")
                continue
            require_absolute_path(declared, f"cover_assets_by_size.{key}", errors)
            if resolve_path(declared, package_path) != next(iter(paths)):
                errors.append(f"cover_assets_by_size.{key} does not match platform cover paths")

        unexpected_sizes = sorted(set(assets_by_size) - set(grouped_paths))
        if unexpected_sizes:
            errors.append(
                "cover_assets_by_size declares unused dimensions: "
                + ", ".join(unexpected_sizes)
            )
        resolved_assets = [resolve_path(value, package_path) for value in assets_by_size.values()
                           if isinstance(value, str) and value.strip()]
        if len(set(resolved_assets)) != len(resolved_assets):
            errors.append("different dimensions must not alias the same cover asset")
    else:
        if len({str(path) for path in variant_paths.values()}) != len(variant_paths):
            errors.append("legacy cover variants must use distinct output paths")
        if len({sha256(path) for path in variant_paths.values()}) != len(variant_paths):
            warnings.append("two or more platform covers have identical pixels; verify intentional reuse")

    return variant_paths, manifest_path, primary_id


def collect_artifact_hashes(
    package: dict[str, Any],
    package_path: Path,
    cover_master: Any,
    cover_platform: Any,
    variant_paths: dict[str, Path],
    manifest_path: Path | None,
) -> dict[str, str]:
    artifact_hashes: dict[str, str] = {}
    for field, value in (
        ("video", package.get("video")),
        ("captions", package.get("captions")),
        ("description_file", package.get("description_file")),
        ("cover_master", cover_master),
        ("cover_platform", cover_platform),
    ):
        if isinstance(value, str):
            file_path = resolve_path(value, package_path)
            if file_path.is_file():
                artifact_hashes[field] = sha256(file_path)
    if manifest_path is not None and manifest_path.is_file():
        artifact_hashes["cover_variants_manifest"] = sha256(manifest_path)
    for variant_id, file_path in sorted(variant_paths.items()):
        artifact_hashes[f"cover_variant:{variant_id}"] = sha256(file_path)
    # New user-source packages bind the current evidence bytes. Legacy hashes stay identical.
    if is_user_release(package):
        source = package.get("user_release_source")
        if isinstance(source, dict) and isinstance(source.get("snapshot_path"), str):
            snapshot_path = Path(source["snapshot_path"])
            if snapshot_path.is_absolute() and snapshot_path.is_file():
                artifact_hashes["user_release_snapshot"] = sha256(snapshot_path)
                try:
                    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
                    evidence = snapshot.get("user_field_evidence", {})
                    evidence_path = Path(evidence.get("path", ""))
                    if evidence_path.is_absolute() and evidence_path.is_file():
                        artifact_hashes["user_editorial_row"] = sha256(evidence_path)
                except (OSError, ValueError, TypeError, AttributeError):
                    pass  # Source validation reports malformed evidence; hashing does not repair it.
    return artifact_hashes


def compute_revision_hash(
    package: dict[str, Any], revision_id: Any, artifact_hashes: dict[str, str]
) -> str:
    identity = {
        "release_revision_id": revision_id,
        "status": package.get("status"),
        "orientation": package.get("orientation", "portrait"),
        "cover_profile_id": package.get("cover_profile_id"),
        "primary_cover_variant_id": package.get("primary_cover_variant_id"),
        "title": str(package.get("title", "")).strip(),
        "description": package.get("description", ""),
        "hashtags": package.get("hashtags", []),
        "artifact_hashes": artifact_hashes,
    }
    # Do not perturb revision hashes for packages created before this metadata existed.
    if "doubao_source" in package:
        identity["doubao_source"] = package["doubao_source"]
    if "title_source" in package:
        identity["title_source"] = package["title_source"]
    if "user_release_source" in package:
        identity["user_release_source"] = package["user_release_source"]
        identity["script_sha256"] = package.get("script_sha256")
    if "cover_headline_text" in package or "cover_headline_lines" in package:
        identity["cover_headline_text"] = package.get("cover_headline_text")
        identity["cover_headline_lines"] = package.get("cover_headline_lines")
    if "cover_asset_strategy" in package:
        identity["cover_asset_strategy"] = package.get("cover_asset_strategy")
        identity["cover_assets_by_size"] = package.get("cover_assets_by_size")
        identity["platform_cover_map"] = package.get("platform_cover_map")
    if "description_policy" in package or "description_interaction" in package:
        identity["description_policy"] = package.get("description_policy")
        identity["description_interaction"] = package.get("description_interaction")
        if "platform_intro" in package:
            identity["platform_intro"] = package["platform_intro"]
    return hashlib.sha256(
        json.dumps(identity, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def validate_package(package_path: Path) -> dict[str, Any]:
    package_path = package_path.resolve()
    package = json.loads(package_path.read_text(encoding="utf-8"))
    errors: list[str] = []
    warnings: list[str] = []
    title_source_errors: list[str] = []
    validate_title_source(package, title_source_errors)
    errors.extend(title_source_errors)
    source = package.get("title_source")
    inherited_title_valid = (
        isinstance(source, dict)
        and source.get("policy") == "reuse-upstream-title-v1"
        and not title_source_errors
    )
    validate_package_description(package, errors, warnings)
    orientation = package.get("orientation", "portrait")
    if orientation not in MASTER_SIZES:
        errors.append(f"unsupported orientation: {orientation}")
        orientation = "portrait"

    for field in ("title", "brand_name", "video", "captions", "description_file"):
        if not package.get(field):
            errors.append(f"missing field: {field}")
    title = str(package.get("title", "")).strip()
    # Creation-length advice must not rewrite a valid upstream-approved title.
    if len(title) < 8 and not (title and inherited_title_valid):
        errors.append("title is too short")
    validate_cover_title_parity(package, title, errors, warnings)
    if package.get("status") != "approved":
        errors.append("publish package status must be approved")
    revision_id = package.get("release_revision_id") or package.get("revision")
    if not revision_id:
        errors.append("missing release_revision_id/revision")
    elif not package.get("release_revision_id"):
        warnings.append("legacy package: using revision as release_revision_id")

    for field in ("video", "captions", "description_file"):
        checked_file(package.get(field), field, errors, package_path)

    cover_master = package.get("cover_master") or package.get("cover_9x16")
    cover_platform = package.get("cover_platform") or package.get("cover_3x4")
    image_size(cover_master, "cover_master", master_dimensions(package, orientation), errors, package_path)

    variant_paths, manifest_path, primary_id = validate_cover_profile(
        package, package_path, revision_id, errors, warnings
    )
    if package.get("cover_profile_id") != COVER_PROFILE_ID:
        crop_dimensions = dimensions(package.get("cover_platform_dimensions"))
        if crop_dimensions is None and orientation == "portrait":
            crop_dimensions = (1080, 1440)
        elif crop_dimensions is None:
            errors.append("landscape package must declare cover_platform_dimensions")
        image_size(cover_platform, "cover_platform", crop_dimensions, errors, package_path)

    hashtags = package.get("hashtags", [])
    if not isinstance(hashtags, list) or len(hashtags) != 5:
        errors.append("hashtags must contain exactly five items")

    media_validation_path = package.get("release_media_validation")
    media_validation = None
    if not media_validation_path:
        errors.append("missing field: release_media_validation")
    else:
        validation_path = checked_file(
            media_validation_path, "release_media_validation", errors, package_path
        )
        if validation_path is not None:
            media_validation = json.loads(validation_path.read_text(encoding="utf-8"))
            if media_validation.get("passed") is not True:
                errors.append("release media validation did not pass")

    artifact_hashes = collect_artifact_hashes(
        package,
        package_path,
        cover_master,
        cover_platform,
        variant_paths,
        manifest_path,
    )

    if media_validation is not None:
        validated_video = media_validation.get("video")
        package_video = package.get("video")
        if (
            validated_video
            and package_video
            and resolve_path(validated_video, validation_path)
            != resolve_path(package_video, package_path)
        ):
            errors.append("release media validation points to a different video")
        validated_hash = media_validation.get("video_sha256")
        if validated_hash and validated_hash != artifact_hashes.get("video"):
            errors.append("video bytes changed after release media validation")
        elif not validated_hash:
            warnings.append("legacy media validation has no video_sha256")

    revision_hash = compute_revision_hash(package, revision_id, artifact_hashes)
    return {
        "package": str(package_path),
        "status": package.get("status"),
        "orientation": orientation,
        "title": title,
        "release_revision_id": revision_id,
        "release_revision_hash": revision_hash,
        "artifact_hashes": artifact_hashes,
        "cover_master": cover_master,
        "cover_platform": cover_platform,
        "cover_profile_id": package.get("cover_profile_id"),
        "primary_cover_variant_id": primary_id,
        "cover_variants": {key: str(value) for key, value in variant_paths.items()},
        "warnings": warnings,
        "errors": errors,
        "passed": not errors,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True)
    parser.add_argument("--report")
    args = parser.parse_args()

    report = validate_package(Path(args.package))
    if report.get("cover_profile_id") == COVER_PROFILE_ID:
        package_path = Path(args.package).resolve()
        package = json.loads(package_path.read_text(encoding="utf-8"))
        declared_report = resolve_path(package.get("publish_package_validation", ""), package_path)
        if not args.report:
            report["errors"].append("new-profile validation requires explicit --report")
        elif Path(args.report).resolve() != declared_report:
            report["errors"].append(
                "--report does not match publish_package_validation declared in package"
            )
        report["passed"] = not report["errors"]
    output = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        Path(args.report).resolve().write_text(output + "\n", encoding="utf-8")
    print(output)
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
