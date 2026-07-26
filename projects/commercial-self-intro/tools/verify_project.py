#!/usr/bin/env python3
"""Verify the private commercial-self-intro development package."""

from __future__ import annotations

import argparse
import hashlib
import re
import struct
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "MANIFEST.sha256"
SKILL = ROOT / "01-skill" / "commercial-self-intro"
INDEX = SKILL / "references" / "book-technique-index.md"
COVERAGE_SCRIPT = SKILL / "scripts" / "validate_book_coverage.py"
DELIVERABLE = (
    ROOT
    / "03-deliverables"
    / "swen-commercial-profile-long-image-1080x7736.png"
)
DESIGN = ROOT / "02-design" / "swen-commercial-profile-long-image"
HTML = DESIGN / "Swen-Commercial-Profile-Long-Image.html"


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest().upper()


def relative_files() -> set[str]:
    # 04-private-sources 在清单覆盖范围之外：公开检出不含私有文件，
    # 本地补回私有文件也不应导致清单校验失败（清单见 PRIVATE-FILES.md）。
    return {
        path.relative_to(ROOT).as_posix()
        for path in ROOT.rglob("*")
        if path.is_file()
        and path != MANIFEST
        and "04-private-sources" not in path.relative_to(ROOT).parts
        and "__pycache__" not in path.parts
        and path.suffix != ".pyc"
    }


def verify_manifest() -> None:
    if not MANIFEST.is_file():
        raise RuntimeError("MANIFEST.sha256 is missing")

    expected: dict[str, str] = {}
    for line_number, raw_line in enumerate(
        MANIFEST.read_text(encoding="utf-8").splitlines(), start=1
    ):
        line = raw_line.strip()
        if not line:
            continue
        match = re.fullmatch(r"([0-9A-Fa-f]{64})  (.+)", line)
        if not match:
            raise RuntimeError(f"Bad manifest line {line_number}: {raw_line}")
        expected[match.group(2)] = match.group(1).upper()

    actual = relative_files()
    missing = sorted(set(expected) - actual)
    extra = sorted(actual - set(expected))
    mismatched = []
    for relative_path, expected_hash in expected.items():
        path = ROOT / Path(relative_path)
        if path.is_file() and digest(path) != expected_hash:
            mismatched.append(relative_path)

    if missing or extra or mismatched:
        raise RuntimeError(
            "Manifest mismatch: "
            f"missing={missing}, extra={extra}, changed={mismatched}"
        )
    print(f"manifest_files={len(expected)}")
    print("manifest_integrity=PASS")


def expected_techniques() -> set[str]:
    groups = {"F": 17, "D": 24, "E": 11, "L": 12}
    return {
        f"{prefix}{number:02d}"
        for prefix, count in groups.items()
        for number in range(1, count + 1)
    }


def verify_techniques() -> None:
    text = INDEX.read_text(encoding="utf-8")
    found = set(re.findall(r"\b[FDEL]\d{2}\b", text))
    expected = expected_techniques()
    missing = sorted(expected - found)
    unexpected = sorted(found - expected)
    if missing or unexpected:
        raise RuntimeError(
            f"Technique index mismatch: missing={missing}, unexpected={unexpected}"
        )

    result = subprocess.run(
        [sys.executable, "-X", "utf8", str(COVERAGE_SCRIPT)],
        cwd=SKILL,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "Coverage validator failed:\n"
            + result.stdout
            + ("\n" + result.stderr if result.stderr else "")
        )
    print(result.stdout.strip())


def png_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as handle:
        header = handle.read(24)
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError(f"Not a valid PNG: {path}")
    return struct.unpack(">II", header[16:24])


def verify_design() -> None:
    width, height = png_dimensions(DELIVERABLE)
    if (width, height) != (1080, 7736):
        raise RuntimeError(
            f"Unexpected deliverable dimensions: {width}x{height}"
        )

    html = HTML.read_text(encoding="utf-8")
    local_refs = {
        match
        for match in re.findall(r'(?:src|href)=["\']([^"\']+)["\']', html)
        if not re.match(r"^(?:https?:|data:|#)", match)
    }
    missing = sorted(
        reference
        for reference in local_refs
        if not (HTML.parent / Path(reference)).is_file()
    )
    if missing:
        raise RuntimeError(f"Missing local design assets: {missing}")

    print(f"long_image_dimensions={width}x{height}")
    print(f"design_local_assets={len(local_refs)}")
    print("design_integrity=PASS")


BOOK_PDF = (
    ROOT
    / "04-private-sources"
    / "book"
    / "自我介绍的技术（【日】横川裕之，台海出版社，2023年02月）.pdf"
)


def private_sources_present() -> bool:
    # 公开仓库检出不包含 04-private-sources 私有文件（见 PRIVATE-FILES.md）。
    return BOOK_PDF.is_file()


def verify_required_files() -> None:
    required = [
        ROOT / "README-先看这里.md",
        ROOT / "00-project-docs" / "PROJECT-BRIEF.md",
        SKILL / "SKILL.md",
        SKILL / "agents" / "openai.yaml",
        INDEX,
        COVERAGE_SCRIPT,
        HTML,
        DELIVERABLE,
        ROOT
        / "05-portable-release"
        / "commercial-self-intro-portable-20260710-v3.zip",
    ]
    if private_sources_present():
        required.append(BOOK_PDF)
        print("private_sources=present")
    else:
        print("private_sources=absent")
    missing = [path.relative_to(ROOT).as_posix() for path in required if not path.is_file()]
    if missing:
        raise RuntimeError(f"Required files are missing: {missing}")
    print(f"required_files={len(required)}")
    print("required_files=PASS")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--skip-manifest",
        action="store_true",
        help="Validate project semantics before regenerating MANIFEST.sha256.",
    )
    args = parser.parse_args()

    try:
        verify_required_files()
        verify_techniques()
        verify_design()
        if not args.skip_manifest:
            verify_manifest()
    except (OSError, RuntimeError, UnicodeError) as error:
        print(f"project_integrity=FAIL: {error}", file=sys.stderr)
        return 1

    print("project_integrity=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
