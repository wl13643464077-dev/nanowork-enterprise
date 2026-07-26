#!/usr/bin/env python3
"""Validate that the skill contains all 64 book-derived technique nodes."""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
REFERENCES = SKILL_ROOT / "references"
MODULES = {
    "book-foundation-discovery.md": [f"F{number:02d}" for number in range(1, 18)],
    "book-writing-structures.md": [f"D{number:02d}" for number in range(1, 25)],
    "book-delivery-interaction.md": [f"E{number:02d}" for number in range(1, 12)],
    "book-practice-iteration.md": [f"L{number:02d}" for number in range(1, 13)],
}
INDEX_FILE = REFERENCES / "book-technique-index.md"
HEADING_RE = re.compile(r"^##\s+([FDEL]\d{2})\s+-\s+.+$", re.MULTILINE)
INDEX_RE = re.compile(r"^\|\s*([FDEL]\d{2})\s*\|", re.MULTILINE)
ANY_ID_RE = re.compile(r"\b([FDEL]\d{2})\b")


def fail(messages: list[str]) -> int:
    for message in messages:
        print(f"ERROR: {message}", file=sys.stderr)
    return 1


def main() -> int:
    errors: list[str] = []
    expected = [technique for ids in MODULES.values() for technique in ids]
    found: list[str] = []

    for filename, module_expected in MODULES.items():
        path = REFERENCES / filename
        if not path.exists():
            errors.append(f"missing module: {path}")
            continue
        text = path.read_text(encoding="utf-8")
        module_found = HEADING_RE.findall(text)
        found.extend(module_found)
        if module_found != module_expected:
            missing = sorted(set(module_expected) - set(module_found))
            extra = sorted(set(module_found) - set(module_expected))
            errors.append(
                f"{filename} sequence mismatch; missing={missing or 'none'}, "
                f"extra={extra or 'none'}"
            )
        blocks = re.split(r"(?=^##\s+[FDEL]\d{2}\s+-\s+)", text, flags=re.MULTILINE)
        for block in blocks:
            match = HEADING_RE.match(block)
            if match and not re.search(r"^- 页码：PDF p\.", block, re.MULTILINE):
                errors.append(f"{filename} {match.group(1)} lacks a PDF page marker")

    duplicates = sorted(key for key, count in Counter(found).items() if count > 1)
    if duplicates:
        errors.append(f"duplicate module IDs: {duplicates}")

    if set(found) != set(expected):
        errors.append(
            "module coverage mismatch; "
            f"missing={sorted(set(expected) - set(found)) or 'none'}, "
            f"extra={sorted(set(found) - set(expected)) or 'none'}"
        )

    if not INDEX_FILE.exists():
        errors.append(f"missing index: {INDEX_FILE}")
    else:
        index_ids = INDEX_RE.findall(INDEX_FILE.read_text(encoding="utf-8"))
        if index_ids != expected:
            errors.append(
                "index sequence mismatch; "
                f"missing={sorted(set(expected) - set(index_ids)) or 'none'}, "
                f"extra={sorted(set(index_ids) - set(expected)) or 'none'}"
            )
        index_duplicates = sorted(
            key for key, count in Counter(index_ids).items() if count > 1
        )
        if index_duplicates:
            errors.append(f"duplicate index IDs: {index_duplicates}")

    expected_set = set(expected)
    markdown_files = [SKILL_ROOT / "SKILL.md", *sorted(REFERENCES.glob("*.md"))]
    for path in markdown_files:
        mentioned = set(ANY_ID_RE.findall(path.read_text(encoding="utf-8")))
        unknown = sorted(mentioned - expected_set)
        if unknown:
            errors.append(f"unknown technique IDs in {path.name}: {unknown}")

    if errors:
        return fail(errors)

    print(f"book_technique_coverage={len(found)}/{len(expected)}")
    print("module_counts=F17,D24,E11,L12")
    print("page_markers=64/64")
    print(f"cross_reference_files={len(markdown_files)}")
    print("result=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
