#!/usr/bin/env python3
"""Regression-validate the five scenario golden samples.

Enforces the disciplines defined in references/structured-output-spec.md and
references/output-contract.md on references/golden-samples/*.json:

- intro-package structure and Truth Ledger grades
- digits in copy must trace to an A/B-grade ledger claim
- technique card minimums (>=1 F, >=3 D, >=2 L, >=1 E for spoken) and 8-20 IDs
- technique pages must match references/book-technique-index.md exactly
- exactly one recommended version; alternatives carry a single ab_variable
- version_id prefix must match the scenario code (DY/VX/SQ/BIZ/JB)
- timed versions: stored estimate fresh, and estimate within the target band
- banned absolute wording absent from copy
- content LOOP complete, score >= 85, exactly 3 evidence items to collect
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_intro_length import estimate_seconds  # noqa: E402

SKILL_ROOT = Path(__file__).resolve().parents[1]
GOLDEN_DIR = SKILL_ROOT / "references" / "golden-samples"
INDEX_FILE = SKILL_ROOT / "references" / "book-technique-index.md"

SCENARIO_CODES = {"DY", "VX", "SQ", "BIZ", "JB"}
REQUIRED_SCENARIOS = SCENARIO_CODES
AB_VARIABLES = {"opening", "outcome", "proof", "label", "cta", "delivery"}
GRADES = {"A", "B", "C", "D"}
BANNED_WORDS = ["国家级", "最高级", "最佳", "第一", "唯一", "顶级", "保证效果", "根治", "治愈"]
TOLERANCE = 0.20
ESTIMATE_DRIFT = 0.3
CPS = 4.0
TOP_LEVEL_KEYS = [
    "meta",
    "positioning",
    "truth_ledger",
    "technique_card",
    "content_loop",
    "versions",
    "compliance",
    "score",
]


def load_index_pages() -> dict[str, str]:
    pages: dict[str, str] = {}
    row = re.compile(r"^\|\s*([FDEL]\d{2})\s*\|\s*([^|]+?)\s*\|", re.MULTILINE)
    for technique_id, page in row.findall(INDEX_FILE.read_text(encoding="utf-8")):
        pages[technique_id] = page
    return pages


def check_sample(path: Path, index_pages: dict[str, str], errors: list[str]) -> str | None:
    def err(message: str) -> None:
        errors.append(f"{path.name}: {message}")

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        err(f"invalid JSON: {exc}")
        return None

    for key in TOP_LEVEL_KEYS:
        if key not in data:
            err(f"missing top-level key: {key}")
    if set(TOP_LEVEL_KEYS) - set(data):
        return None

    meta = data["meta"]
    code = meta.get("scenario_code")
    if code not in SCENARIO_CODES:
        err(f"meta.scenario_code must be one of {sorted(SCENARIO_CODES)}, got {code!r}")
        return None
    for field in ("subject", "disclaimer", "package_version", "generated_at"):
        if not meta.get(field):
            err(f"meta.{field} is empty")

    ledger = data["truth_ledger"]
    verified_text = ""
    for entry in ledger:
        grade = entry.get("grade")
        if grade not in GRADES:
            err(f"ledger claim {entry.get('claim')!r} has invalid grade {grade!r}")
            continue
        if grade in {"A", "B"}:
            verified_text += entry.get("claim", "")
        if grade == "D" and not entry.get("evidence_action"):
            err(f"D-grade claim {entry.get('claim')!r} lacks evidence_action")
    verified_digit_runs = set(re.findall(r"\d+", verified_text))

    card = data["technique_card"]
    ids = [item.get("id") for item in card]
    if not 8 <= len(ids) <= 20:
        err(f"technique card has {len(ids)} IDs, expected 8-20")
    if len(set(ids)) != len(ids):
        err("technique card contains duplicate IDs")
    counts = {prefix: sum(1 for i in ids if i and i.startswith(prefix)) for prefix in "FDEL"}
    if counts["F"] < 1 or counts["D"] < 3 or counts["L"] < 2:
        err(f"technique minimums not met (need >=1F, >=3D, >=2L): {counts}")
    if counts["E"] < 1:
        err("spoken/interactive scenario requires at least 1 E technique")
    for item in card:
        technique_id = item.get("id")
        if technique_id not in index_pages:
            err(f"unknown technique ID {technique_id!r}")
            continue
        if item.get("page") != index_pages[technique_id]:
            err(
                f"{technique_id} page {item.get('page')!r} does not match "
                f"index page {index_pages[technique_id]!r}"
            )
        if not item.get("why") or not item.get("effect"):
            err(f"{technique_id} lacks why/effect")

    loop = data["content_loop"]
    for field in ("listener", "outcome", "ownable_proof", "prompt_next_step"):
        if not loop.get(field):
            err(f"content_loop.{field} is empty")

    versions = data["versions"]
    recommended = [v for v in versions if v.get("role") == "recommended"]
    if len(recommended) != 1:
        err(f"expected exactly 1 recommended version, got {len(recommended)}")
    for version in versions:
        version_id = version.get("version_id", "")
        role = version.get("role")
        copy = version.get("copy", "")
        if not version_id.startswith(f"{code}-"):
            err(f"version_id {version_id!r} does not start with scenario code {code}-")
        if role not in {"recommended", "alternative"}:
            err(f"{version_id}: invalid role {role!r}")
        if role == "alternative" and version.get("ab_variable") not in AB_VARIABLES:
            err(f"{version_id}: alternative needs ab_variable in {sorted(AB_VARIABLES)}")
        if role == "recommended" and version.get("ab_variable"):
            err(f"{version_id}: recommended version must not set ab_variable")
        if not copy:
            err(f"{version_id}: empty copy")
            continue
        if not version.get("cta"):
            err(f"{version_id}: empty cta")
        for word in BANNED_WORDS:
            if word in copy:
                err(f"{version_id}: banned word {word!r} in copy")
        for digit_run in set(re.findall(r"\d+", copy)):
            if digit_run not in verified_digit_runs:
                err(
                    f"{version_id}: number {digit_run!r} in copy has no "
                    "A/B-grade ledger claim backing it"
                )
        target = version.get("target_seconds")
        stored = version.get("estimated_seconds")
        if target is not None:
            if stored is None:
                err(f"{version_id}: timed version lacks estimated_seconds")
                continue
            actual, _ = estimate_seconds(copy, CPS)
            if abs(actual - stored) > ESTIMATE_DRIFT:
                err(
                    f"{version_id}: stored estimate {stored}s is stale "
                    f"(recomputed {actual:.1f}s)"
                )
            lower, upper = target * (1 - TOLERANCE), target * (1 + TOLERANCE)
            if not lower <= actual <= upper:
                err(
                    f"{version_id}: estimated {actual:.1f}s outside "
                    f"{lower:.1f}-{upper:.1f}s band for target {target}s"
                )

    score = data["score"]
    if not isinstance(score.get("total"), (int, float)) or score["total"] < 85:
        err(f"score.total must be >= 85, got {score.get('total')!r}")
    if len(score.get("top_evidence_to_collect", [])) != 3:
        err("score.top_evidence_to_collect must list exactly 3 items")

    compliance = data["compliance"]
    for field in ("risk_words_removed", "pending_verification", "privacy_notes"):
        if field not in compliance:
            err(f"compliance.{field} missing")

    return code


def main() -> int:
    errors: list[str] = []
    if not GOLDEN_DIR.is_dir():
        print(f"ERROR: missing golden sample directory: {GOLDEN_DIR}", file=sys.stderr)
        return 1
    index_pages = load_index_pages()
    if len(index_pages) != 64:
        print(
            f"ERROR: technique index parse found {len(index_pages)} IDs, expected 64",
            file=sys.stderr,
        )
        return 1

    samples = sorted(GOLDEN_DIR.glob("*.json"))
    seen_codes: list[str] = []
    for path in samples:
        code = check_sample(path, index_pages, errors)
        if code:
            seen_codes.append(code)

    duplicates = {code for code in seen_codes if seen_codes.count(code) > 1}
    if duplicates:
        errors.append(f"duplicate scenario codes across samples: {sorted(duplicates)}")
    missing_scenarios = REQUIRED_SCENARIOS - set(seen_codes)
    if missing_scenarios:
        errors.append(f"missing golden samples for scenarios: {sorted(missing_scenarios)}")

    if errors:
        for message in errors:
            print(f"ERROR: {message}", file=sys.stderr)
        return 1

    print(f"golden_samples={len(samples)}")
    print(f"scenarios_covered={','.join(sorted(seen_codes))}")
    print("golden_regression=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
