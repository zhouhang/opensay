"""Mechanical participation checks, including Unicode and JSON presence edges."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from description_interaction import (  # noqa: E402
    DESCRIPTION_POLICY,
    validate_description_interaction,
    validate_package_description,
)


def interaction(kind: str = "discussion") -> dict[str, str]:
    return {
        "type": kind,
        "text": "免费帮你订酒店却向酒店收佣金，你能接受吗？",
        "content_anchor": "本片解释 AI 助理向酒店收佣金的商业模式。",
        "answer_format": "接受或不接受，并给出一个原因。",
    }


class DescriptionInteractionTests(unittest.TestCase):
    def test_all_four_participation_types_are_supported(self) -> None:
        for kind in ("discussion", "interaction", "experience", "help"):
            with self.subTest(kind=kind):
                entry = interaction(kind)
                description = "本期讲 AI 交易佣金。" + entry["text"]
                self.assertEqual(
                    validate_description_interaction(
                        description, entry, description + "\n音乐署名：测试作曲者。"
                    ),
                    [],
                )

    def test_required_interaction_fields_must_be_nonempty_and_typed(self) -> None:
        for field, invalid in (
            ("type", "question"), ("type", []), ("type", None),
            ("text", " \n\t"), ("text", 1),
            ("content_anchor", ""), ("content_anchor", False),
            ("answer_format", ""), ("answer_format", None),
        ):
            with self.subTest(field=field, invalid=invalid):
                entry = interaction()
                description = entry["text"]
                entry[field] = invalid
                errors = validate_description_interaction(description, entry)
                self.assertTrue(any(f"description_interaction.{field}" in item for item in errors), errors)

    def test_optional_answer_format_may_be_absent(self) -> None:
        entry = interaction()
        del entry["answer_format"]
        self.assertEqual(validate_description_interaction(entry["text"], entry), [])

    def test_missing_or_nonobject_interaction_fails(self) -> None:
        for invalid in (None, "question", [], 1):
            with self.subTest(invalid=invalid):
                self.assertIn(
                    "description_interaction must be an object",
                    validate_description_interaction("AI 如何赚佣金？", invalid),
                )

    def test_description_and_platform_intro_must_include_actual_prompt(self) -> None:
        entry = interaction()
        self.assertIn(
            "description must contain description_interaction.text",
            validate_description_interaction("AI 如何赚佣金？", entry),
        )
        self.assertIn(
            "platform_intro must contain description_interaction.text",
            validate_description_interaction(entry["text"], entry, "音乐署名：测试作曲者。"),
        )

    def test_nfc_and_contiguous_whitespace_normalization_allow_wrapping(self) -> None:
        entry = interaction()
        entry["text"] = "Café 体验：免费\n订酒店，是否接受佣金？"
        description = "本片讨论 Cafe\u0301 体验：免费\t \n订酒店，是否接受佣金？"
        self.assertEqual(validate_description_interaction(description, entry, description), [])

    def test_normalization_preserves_case_punctuation_and_words(self) -> None:
        entry = interaction()
        entry["text"] = "AI 免费订酒店，你接受佣金吗？"
        for description in (
            "ai 免费订酒店，你接受佣金吗？",
            "AI 免费订酒店，你接受佣金吗!",
            "AI 免费订酒店，你拒绝佣金吗？",
        ):
            with self.subTest(description=description):
                self.assertIn(
                    "description must contain description_interaction.text",
                    validate_description_interaction(description, entry),
                )

    def test_mechanical_validation_does_not_require_question_marks_or_pronouns(self) -> None:
        entry = interaction("experience")
        entry["text"] = "分享一次委托 AI 预订酒店的实际体验。"
        self.assertEqual(validate_description_interaction(entry["text"], entry), [])

    def test_new_package_cannot_use_null_or_blank_platform_intro(self) -> None:
        for intro in (None, "", " \n", [], 1):
            with self.subTest(intro=intro):
                entry = interaction()
                errors: list[str] = []
                warnings: list[str] = []
                validate_package_description(
                    {"description_policy": DESCRIPTION_POLICY,
                     "description": entry["text"],
                     "description_interaction": entry,
                     "platform_intro": intro},
                    errors, warnings,
                )
                self.assertTrue(any("platform_intro must be a non-empty string" in item for item in errors), errors)

    def test_policy_marker_requires_interaction_metadata(self) -> None:
        errors: list[str] = []
        warnings: list[str] = []
        validate_package_description(
            {"description_policy": DESCRIPTION_POLICY, "description": "AI 为什么免费？"},
            errors, warnings,
        )
        self.assertIn("description_interaction must be an object", errors)
        self.assertEqual(warnings, [])

    def test_interaction_without_policy_is_checked_as_new_metadata(self) -> None:
        errors: list[str] = []
        warnings: list[str] = []
        validate_package_description(
            {"description": "AI 如何赚佣金？", "description_interaction": interaction()},
            errors, warnings,
        )
        self.assertIn("description must contain description_interaction.text", errors)
        self.assertEqual(warnings, [])

    def test_wrong_policy_is_rejected(self) -> None:
        entry = interaction()
        for invalid in ("official-douyin-policy", None, []):
            with self.subTest(invalid=invalid):
                errors: list[str] = []
                validate_package_description(
                    {"description_policy": invalid, "description": entry["text"],
                     "description_interaction": entry},
                    errors, [],
                )
                self.assertIn(f"description_policy must be {DESCRIPTION_POLICY}", errors)

    def test_existing_package_remains_compatible_with_explicit_warning(self) -> None:
        errors: list[str] = []
        warnings: list[str] = []
        validate_package_description({"description": "历史介绍。"}, errors, warnings)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, ["legacy package: missing description participation metadata"])


if __name__ == "__main__":
    unittest.main()
