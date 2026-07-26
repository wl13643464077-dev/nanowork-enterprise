#!/usr/bin/env python3
"""Search the local Chinese PDF and return page-cited snippets."""

from __future__ import annotations

import argparse
import os
import re
import sys
import unicodedata
from pathlib import Path

try:
    from pypdf import PdfReader
except ModuleNotFoundError:  # Allow a clear diagnostic in lean Python environments.
    PdfReader = None  # type: ignore[assignment]


DEFAULT_PDF = Path(r"I:\自我介绍的技术（【日】横川裕之，台海出版社，2023年02月）.pdf")
KNOWN_SIZE = 7_313_540
SKILL_ROOT = Path(__file__).resolve().parents[1]
PACKAGED_PDF = SKILL_ROOT / "references" / "source-book.pdf"
PDF_ENV_VAR = "SELF_INTRO_BOOK_PDF"


def normalize(text: str) -> str:
    return unicodedata.normalize("NFKC", text).replace("\x00", "")


def expand_path(path: str | Path) -> Path:
    expanded = os.path.expandvars(os.path.expanduser(str(path)))
    return Path(expanded)


def find_default_pdf() -> Path:
    configured = os.environ.get(PDF_ENV_VAR)
    if configured:
        configured_path = expand_path(configured)
        if configured_path.exists():
            return configured_path
        raise FileNotFoundError(
            f"环境变量 {PDF_ENV_VAR} 指向的文件不存在: {configured_path}"
        )

    for candidate in (PACKAGED_PDF, DEFAULT_PDF):
        if candidate.exists():
            return candidate

    discovered: list[Path] = []
    search_roots = (Path.cwd(), Path.home() / "Documents", Path.home() / "Downloads")
    for root in search_roots:
        if not root.exists():
            continue
        for pattern in ("*自我介绍*技术*.pdf", "*self*intro*.pdf"):
            try:
                discovered.extend(path for path in root.glob(pattern) if path.is_file())
            except OSError:
                continue

    unique = list(dict.fromkeys(discovered))
    for candidate in unique:
        try:
            if candidate.stat().st_size == KNOWN_SIZE:
                return candidate
        except OSError:
            continue
    if len(unique) == 1:
        return unique[0]

    raise FileNotFoundError(
        "未找到《自我介绍的技术》PDF。Skill本身仍可使用完整64项方法库；"
        f"如需原文检索，请设置 {PDF_ENV_VAR}、把自有PDF放到 "
        "references/source-book.pdf，或使用 --pdf 指定路径。"
    )


def parse_pages(spec: str | None, total: int) -> set[int] | None:
    if not spec:
        return None
    pages: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start_text, end_text = part.split("-", 1)
            start, end = int(start_text), int(end_text)
            if start > end:
                start, end = end, start
            pages.update(range(max(1, start), min(total, end) + 1))
        else:
            page = int(part)
            if 1 <= page <= total:
                pages.add(page)
    return pages


def make_snippet(text: str, positions: list[int], context: int) -> str:
    start = max(0, min(positions) - context)
    end = min(len(text), max(positions) + context)
    return re.sub(r"\s+", " ", text[start:end]).strip()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="检索《自我介绍的技术》并输出PDF页码与短摘录。"
    )
    parser.add_argument("query", help="检索词。空格分隔多个词。")
    parser.add_argument("--pdf", type=Path, help="覆盖默认PDF路径。")
    parser.add_argument("--limit", type=int, default=8, help="最多返回多少页。")
    parser.add_argument("--context", type=int, default=140, help="命中前后字符数。")
    parser.add_argument("--pages", help="页码范围，例如 59-83,90,111-128。")
    parser.add_argument(
        "--mode", choices=("any", "all"), default="any", help="多词匹配方式。"
    )
    parser.add_argument(
        "--phrase", action="store_true", help="把整个query作为一个完整短语。"
    )
    args = parser.parse_args()

    if PdfReader is None:
        print(
            "缺少依赖 pypdf。请在可用的Python环境安装pypdf，"
            "或使用Codex工作区随附的PDF运行环境。",
            file=sys.stderr,
        )
        return 2

    try:
        pdf_path = expand_path(args.pdf) if args.pdf else find_default_pdf()
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if not pdf_path.exists():
        print(f"PDF不存在: {pdf_path}", file=sys.stderr)
        return 2

    reader = PdfReader(str(pdf_path))
    allowed = parse_pages(args.pages, len(reader.pages))
    raw_terms = [args.query] if args.phrase else args.query.split()
    terms = [normalize(term).casefold() for term in raw_terms if term.strip()]
    if not terms:
        print("请提供至少一个非空检索词。", file=sys.stderr)
        return 2

    hits: list[tuple[int, str]] = []
    for index, page in enumerate(reader.pages, start=1):
        if allowed is not None and index not in allowed:
            continue
        text = normalize(page.extract_text() or "")
        folded = text.casefold()
        positions = [folded.find(term) for term in terms]
        matched = all(pos >= 0 for pos in positions) if args.mode == "all" else any(
            pos >= 0 for pos in positions
        )
        if not matched:
            continue
        present_positions = [pos for pos in positions if pos >= 0]
        hits.append((index, make_snippet(text, present_positions, args.context)))
        if len(hits) >= max(1, args.limit):
            break

    print(f"PDF: {pdf_path}")
    print(f"查询: {' | '.join(raw_terms)}")
    print(f"命中页数: {len(hits)}")
    for page_number, snippet in hits:
        print(f"\nPDF p.{page_number}\n{snippet}")
    return 0 if hits else 1


if __name__ == "__main__":
    raise SystemExit(main())
