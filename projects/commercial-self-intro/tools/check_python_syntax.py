#!/usr/bin/env python3
"""Parse project Python files without creating __pycache__ artifacts."""

from __future__ import annotations

import argparse
import ast
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()

    files: list[Path] = []
    for path in args.paths:
        if path.is_file() and path.suffix == ".py":
            files.append(path)
        elif path.is_dir():
            files.extend(path.rglob("*.py"))

    for path in sorted(set(files)):
        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

    print(f"python_ast_files={len(set(files))}")
    print("python_ast=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
