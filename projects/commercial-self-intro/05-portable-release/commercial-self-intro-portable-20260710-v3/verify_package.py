#!/usr/bin/env python3
"""Verify every file listed in MANIFEST.sha256 and reject unexpected files."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "MANIFEST.sha256"
IGNORED_NAMES = {"MANIFEST.sha256", ".DS_Store", "Thumbs.db"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    if not MANIFEST.exists():
        print("ERROR: MANIFEST.sha256 is missing", file=sys.stderr)
        return 1

    expected: dict[str, str] = {}
    for number, raw_line in enumerate(MANIFEST.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            digest, relative = line.split("  ", 1)
        except ValueError:
            print(f"ERROR: invalid manifest line {number}", file=sys.stderr)
            return 1
        expected[relative] = digest.lower()

    actual = {
        path.relative_to(ROOT).as_posix()
        for path in ROOT.rglob("*")
        if path.is_file() and path.name not in IGNORED_NAMES
    }
    missing = sorted(set(expected) - actual)
    extra = sorted(actual - set(expected))
    failures: list[str] = []

    for relative, expected_digest in expected.items():
        path = ROOT / Path(relative)
        if not path.exists():
            continue
        actual_digest = sha256(path)
        if actual_digest != expected_digest:
            failures.append(relative)

    if missing or extra or failures:
        if missing:
            print(f"ERROR: missing files: {missing}", file=sys.stderr)
        if extra:
            print(f"ERROR: unexpected files: {extra}", file=sys.stderr)
        if failures:
            print(f"ERROR: checksum mismatch: {failures}", file=sys.stderr)
        return 1

    print(f"package_files={len(expected)}")
    print("package_integrity=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
