"""Check declared audience participation without claiming semantic review.

The rules express this creator's requested release-copy workflow. They are not
an official platform policy and do not predict a platform's review outcome.
Relevance and answerability still require content review by a person or model.
"""

from __future__ import annotations

import unicodedata
from typing import Any

from user_release_source import POLICY as USER_DESCRIPTION_POLICY, is_user_release, validate_user_release_source


DESCRIPTION_POLICY = "content-participation-v1"
INTERACTION_TYPES = frozenset({"discussion", "interaction", "experience", "help"})


def normalize_interaction_text(value: str) -> str:
    """Normalize Unicode composition and whitespace, retaining all wording."""
    return " ".join(unicodedata.normalize("NFC", value).split())


def validate_description_interaction(
    description: Any, interaction: Any, platform_intro: Any = None
) -> list[str]:
    """Validate fields and actual inclusion; do not infer meaning from punctuation.

    ``None`` for platform_intro means no intro was supplied. Callers inspecting
    JSON must separately distinguish an absent key from an explicit null value.
    ``validate_package_description`` performs that presence-aware check.
    """
    errors: list[str] = []
    valid_description = isinstance(description, str) and bool(description.strip())
    if not valid_description:
        errors.append("description must be a non-empty string")

    valid_intro = platform_intro is None or (
        isinstance(platform_intro, str) and bool(platform_intro.strip())
    )
    if not valid_intro:
        errors.append("platform_intro must be a non-empty string when supplied")

    if not isinstance(interaction, dict):
        errors.append("description_interaction must be an object")
        return errors

    kind = interaction.get("type")
    if not isinstance(kind, str) or kind not in INTERACTION_TYPES:
        errors.append(
            "description_interaction.type must be discussion, interaction, experience, or help"
        )

    text = interaction.get("text")
    valid_text = isinstance(text, str) and bool(text.strip())
    if not valid_text:
        errors.append("description_interaction.text must be a non-empty string")
    else:
        normalized_text = normalize_interaction_text(text)
        if valid_description and normalized_text not in normalize_interaction_text(description):
            errors.append("description must contain description_interaction.text")
        if platform_intro is not None and valid_intro:
            if normalized_text not in normalize_interaction_text(platform_intro):
                errors.append("platform_intro must contain description_interaction.text")

    anchor = interaction.get("content_anchor")
    if not isinstance(anchor, str) or not anchor.strip():
        errors.append("description_interaction.content_anchor must be a non-empty string")

    if "answer_format" in interaction:
        answer_format = interaction["answer_format"]
        if not isinstance(answer_format, str) or not answer_format.strip():
            errors.append("description_interaction.answer_format must be a non-empty string when supplied")

    return errors


def validate_package_description(
    package: dict[str, Any], errors: list[str], warnings: list[str]
) -> None:
    """Enforce new metadata while retaining existing packages' verification."""
    if is_user_release(package):
        validate_user_release_source(package, errors)
        if "platform_intro" in package:
            intro = package["platform_intro"]
            if not isinstance(intro, str) or not intro.strip():
                errors.append("platform_intro must be a non-empty string when supplied")
            elif not isinstance(package.get("description"), str) or package["description"] not in intro:
                errors.append("platform_intro must retain the exact user description")
        # Preserve genuine user interaction if supplied; never manufacture a sentence.
        if "description_interaction" in package:
            errors.extend(validate_description_interaction(package.get("description"), package["description_interaction"], package.get("platform_intro")))
        return
    has_policy = "description_policy" in package
    has_interaction = "description_interaction" in package
    if not has_policy and not has_interaction:
        warnings.append("legacy package: missing description participation metadata")
        return

    if has_policy and package["description_policy"] != DESCRIPTION_POLICY:
        errors.append(f"description_policy must be {DESCRIPTION_POLICY}")

    if "platform_intro" in package and package["platform_intro"] is None:
        errors.append("platform_intro must be a non-empty string when supplied")

    errors.extend(
        validate_description_interaction(
            package.get("description"),
            package.get("description_interaction"),
            package.get("platform_intro"),
        )
    )
