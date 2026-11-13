from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).parents[1]
SCRIPTS = SKILL_ROOT / "scripts"
TESTS = SKILL_ROOT / "tests"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(TESTS))

from test_release_package import make_handoff  # noqa: E402


def run_script(script: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(script), *args],
        check=False,
        capture_output=True,
        text=True,
    )


def run_with_system_python(
    script: Path, *args: str
) -> subprocess.CompletedProcess[str]:
    """Exercise the pre-import guard with the user's ordinary dependency-light Python."""
    return subprocess.run(
        ["python3", "-S", str(script), *args],
        check=False,
        capture_output=True,
        text=True,
    )


def build_through_release(root: Path) -> Path:
    handoff = make_handoff(root)
    output = root / "publish"
    approval = root / "package-approval.json"
    approved = run_script(
        SCRIPTS / "release.py",
        "package-approve",
        "--handoff",
        str(handoff),
        "--output-dir",
        str(output),
        "--confirmed-by-user",
        "--output",
        str(approval),
    )
    if approved.returncode:
        raise AssertionError(approved.stderr)
    packaged = run_script(
        SCRIPTS / "release.py",
        "package",
        "--handoff",
        str(handoff),
        "--output",
        str(output),
        "--approval",
        str(approval),
    )
    if packaged.returncode:
        raise AssertionError(packaged.stderr)
    return output / "publish_package.json"




class CliAuthorityTests(unittest.TestCase):
    def test_direct_package_builder_cli_is_disabled_before_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff = make_handoff(root)
            output = root / "publish"

            result = run_with_system_python(
                SCRIPTS / "build_publish_package.py",
                "--handoff",
                str(handoff),
                "--output",
                str(output),
            )

            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("Direct execution is disabled", result.stderr)
            self.assertIn("release.py package", result.stderr)
            self.assertFalse(output.exists())





if __name__ == "__main__":
    unittest.main()
