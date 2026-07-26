#!/usr/bin/env python3
"""Estimate spoken duration for Chinese-first self-introduction copy."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
LATIN_WORD_RE = re.compile(r"[A-Za-z]+(?:['-][A-Za-z]+)*")
DIGIT_RE = re.compile(r"\d")
MAJOR_PAUSE_RE = re.compile(r"[。！？!?；;\n]")
MINOR_PAUSE_RE = re.compile(r"[，,、：:]")


def load_text(positional: str | None, file_path: Path | None) -> str:
    if file_path:
        return file_path.read_text(encoding="utf-8")
    if positional:
        return positional
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise ValueError("请提供文本、--file，或通过stdin传入内容。")


def estimate_seconds(text: str, cps: float) -> tuple[float, dict[str, int | float]]:
    cjk = len(CJK_RE.findall(text))
    latin_words = len(LATIN_WORD_RE.findall(text))
    digits = len(DIGIT_RE.findall(text))
    major_pauses = len(MAJOR_PAUSE_RE.findall(text))
    minor_pauses = len(MINOR_PAUSE_RE.findall(text))

    # English words and spoken digits usually take longer than one Chinese character.
    speech_units = cjk + latin_words * 1.5 + digits * 0.8
    pause_seconds = major_pauses * 0.22 + minor_pauses * 0.10
    seconds = speech_units / cps + pause_seconds
    return seconds, {
        "cjk": cjk,
        "latin_words": latin_words,
        "digits": digits,
        "speech_units": round(speech_units, 1),
        "pauses": major_pauses + minor_pauses,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="估算中文为主的自我介绍口播时长。结果仅用于初筛。"
    )
    parser.add_argument("text", nargs="?", help="要检查的口播文案。")
    parser.add_argument("--file", type=Path, help="读取UTF-8文本文件。")
    parser.add_argument("--target", type=float, help="目标秒数，例如15、18、30、60。")
    parser.add_argument("--cps", type=float, default=4.0, help="每秒语音单位，默认4.0。")
    parser.add_argument(
        "--tolerance", type=float, default=0.20, help="目标允许误差比例，默认0.20。"
    )
    args = parser.parse_args()

    if args.cps <= 0:
        parser.error("--cps 必须大于0。")
    if not 0 <= args.tolerance < 1:
        parser.error("--tolerance 必须在0到1之间。")

    try:
        text = load_text(args.text, args.file).strip()
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if not text:
        print("文本为空。", file=sys.stderr)
        return 2

    seconds, detail = estimate_seconds(text, args.cps)
    print(f"估算时长: {seconds:.1f} 秒")
    print(
        "统计: "
        f"中文字符={detail['cjk']}, 英文词={detail['latin_words']}, "
        f"数字字符={detail['digits']}, 语音单位={detail['speech_units']}, "
        f"停顿符号={detail['pauses']}"
    )
    print("说明: 这是节奏初筛，最终请本人录音计时。")

    if args.target is None:
        return 0

    lower = args.target * (1 - args.tolerance)
    upper = args.target * (1 + args.tolerance)
    within = lower <= seconds <= upper
    print(f"目标区间: {lower:.1f}-{upper:.1f} 秒")
    print(f"结果: {'通过' if within else '需调整'}")
    return 0 if within else 1


if __name__ == "__main__":
    raise SystemExit(main())
