#!/usr/bin/env python3
"""Convert TTS or live-recording voice_timeline.json to a deterministic SRT file."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def stamp(seconds: float) -> str:
    millis = round(seconds * 1000)
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def convert(source: Path, output: Path) -> None:
    payload = json.loads(source.read_text(encoding="utf-8"))
    rows = payload.get("sentences")
    if rows is None:
        rows = payload.get("timeline")
    if not isinstance(rows, list) or not rows:
        raise ValueError("voice timeline has no sentences")
    alignment = payload.get("alignment") or {}
    if alignment.get("total_sentences") is not None and alignment.get("located") != alignment["total_sentences"]:
        raise ValueError("live recording has unlocated sentences; cannot export a complete SRT")

    blocks: list[str] = []
    previous_end = 0.0
    for index, row in enumerate(rows, 1):
        start = float(row["start"])
        end = float(row["end"])
        text = str(row["text"]).strip()
        if not math.isfinite(start) or not math.isfinite(end) or start < 0:
            raise ValueError(f"sentence {index} has invalid timestamps")
        if not text:
            raise ValueError(f"sentence {index} has empty text")
        if start < previous_end - 0.0005:
            raise ValueError(f"sentence {index} overlaps the previous sentence")
        if end <= start:
            raise ValueError(f"sentence {index} has a non-positive duration")
        if round(end * 1000) <= round(start * 1000):
            raise ValueError(f"sentence {index} has no duration at millisecond precision")
        blocks.append(f"{index}\n{stamp(start)} --> {stamp(end)}\n{text}")
        previous_end = end

    declared = payload.get("total_duration")
    if declared is None:
        media = payload.get("audio") or payload.get("video") or {}
        declared = media.get("duration")
    if declared is not None and (not math.isfinite(float(declared)) or float(declared) <= 0):
        raise ValueError("invalid media total_duration")
    if declared is not None and previous_end > float(declared) + 0.001:
        raise ValueError("last sentence ends after declared total_duration")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n\n".join(blocks) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("timeline", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    convert(args.timeline.expanduser().resolve(), args.output.expanduser().resolve())


if __name__ == "__main__":
    main()
