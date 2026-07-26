#!/usr/bin/env python3
"""Build the Swen long-image HTML from persona-data.json + the template.

Usage:
    python -X utf8 build_long_image.py                # write the HTML
    python -X utf8 build_long_image.py --check        # verify HTML matches data (no write)
    python -X utf8 build_long_image.py --out NEW.html # write to another file

persona-data.json is the single source of copy. Its fields map back to the
persona-spec layers (see the file's source_mapping block), so upgrading the
persona spec means editing the JSON and rebuilding — never hand-editing the
generated HTML.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "Swen-Commercial-Profile-Long-Image.template.html"
DATA = HERE / "persona-data.json"
OUTPUT = HERE / "Swen-Commercial-Profile-Long-Image.html"


def hero_meta(items: list[str]) -> str:
    return "\n".join(f"          <span>{item}</span>" for item in items)


def metrics(items: list[dict]) -> str:
    return "\n".join(
        '          <div class="metric"><strong>'
        f"{item['value']}</strong><span>{item['label_html']}</span></div>"
        for item in items
    )


def credentials(items: list[str]) -> str:
    return "\n".join(
        f'          <span class="credential">{item}</span>' for item in items
    )


def impact_items(items: list[dict]) -> str:
    blocks = []
    for position, item in enumerate(items, start=1):
        blocks.append(
            '          <article class="impact-item">\n'
            f'            <div class="number">{position:02d}</div>\n'
            f"            <h3>{item['title']}</h3>\n"
            f"            <p>{item['text']}</p>\n"
            "          </article>"
        )
    return "\n".join(blocks)


def services(items: list[dict]) -> str:
    blocks = []
    for position, item in enumerate(items, start=1):
        chips = "".join(f"<span>{chip}</span>" for chip in item["deliverables"])
        blocks.append(
            '          <article class="service">\n'
            f'            <div class="service-number">{position:02d}</div>\n'
            "            <div>\n"
            f"              <h3>{item['title']}</h3>\n"
            f"              <p>{item['text']}</p>\n"
            f'              <div class="deliverables">{chips}</div>\n'
            "            </div>\n"
            "          </article>"
        )
    return "\n".join(blocks)


def photos(items: list[dict]) -> str:
    blocks = []
    for item in items:
        blocks.append(
            f'          <figure class="photo {item["variant"]}">\n'
            f'            <img src="{item["src"]}" alt="{item["alt"]}" />\n'
            f"            <figcaption>{item['caption']}</figcaption>\n"
            "          </figure>"
        )
    return "\n".join(blocks)


def steps(items: list[str]) -> str:
    return "\n".join(
        f'          <div class="step"><strong>{position:02d}</strong>'
        f"<span>{item}</span></div>"
        for position, item in enumerate(items, start=1)
    )


def contact_lines(items: list[str]) -> str:
    return "\n".join(f"            <span>{item}</span>" for item in items)


def build(data: dict, template_path: Path = TEMPLATE) -> str:
    hero = data["hero"]
    positioning = data["positioning"]
    impact = data["impact"]
    service_section = data["services"]
    field = data["field"]
    process = data["process"]
    cta = data["cta"]
    tokens = {
        "PAGE_TITLE": data["page_title"],
        "HERO_PHOTO": hero["photo"],
        "HERO_PHOTO_ALT": hero["photo_alt"],
        "HERO_TOPLINE_LEFT": hero["topline_left"],
        "HERO_TOPLINE_INDEX": hero["topline_index"],
        "HERO_ROLE": hero["role_label"],
        "HERO_NAME_CN": hero["name_cn"],
        "HERO_NAME_EN": hero["name_en"],
        "HERO_TAGLINE": hero["tagline"],
        "HERO_META": hero_meta(hero["meta"]),
        "POS_KICKER": positioning["kicker"],
        "POS_TITLE": positioning["title"],
        "POS_LEAD": positioning["lead_html"],
        "METRICS": metrics(positioning["metrics"]),
        "CREDENTIALS": credentials(positioning["credentials"]),
        "IMPACT_KICKER": impact["kicker"],
        "IMPACT_TITLE": impact["title"],
        "IMPACT_ITEMS": impact_items(impact["items"]),
        "SVC_KICKER": service_section["kicker"],
        "SVC_TITLE": service_section["title"],
        "SERVICES": services(service_section["items"]),
        "FIELD_KICKER": field["kicker"],
        "FIELD_TITLE": field["title"],
        "PHOTOS": photos(field["photos"]),
        "FIELD_NOTE": field["note"],
        "PROC_KICKER": process["kicker"],
        "PROC_TITLE": process["title"],
        "STEPS": steps(process["steps"]),
        "CTA_KICKER": cta["kicker"],
        "CTA_TITLE": cta["title"],
        "CTA_TEXT": cta["text"],
        "CONTACT_LINES": contact_lines(cta["contact_lines"]),
        "QR_SRC": cta["qr_src"],
        "QR_ALT": cta["qr_alt"],
        "QR_LABEL": cta["qr_label_html"],
        "LEGAL": data["legal"],
    }

    html = template_path.read_text(encoding="utf-8")
    for name, value in tokens.items():
        token = "{{" + name + "}}"
        if token not in html:
            raise RuntimeError(f"template is missing token {token}")
        html = html.replace(token, value)

    leftover = [line for line in html.splitlines() if "{{" in line]
    if leftover:
        raise RuntimeError(f"unreplaced tokens remain: {leftover}")
    return html


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=DATA)
    parser.add_argument("--template", type=Path, default=TEMPLATE)
    parser.add_argument("--out", type=Path, default=OUTPUT)
    parser.add_argument(
        "--check",
        action="store_true",
        help="compare the build result against --out instead of writing",
    )
    args = parser.parse_args()

    data = json.loads(args.data.read_text(encoding="utf-8"))
    html = build(data, args.template)

    if args.check:
        current = args.out.read_text(encoding="utf-8")
        if current != html:
            print(
                f"CHECK FAIL: {args.out.name} does not match the build result; "
                "run build_long_image.py to regenerate.",
                file=sys.stderr,
            )
            return 1
        print(f"check={args.out.name}")
        print("template_build=IN-SYNC")
        return 0

    args.out.write_text(html, encoding="utf-8")
    print(f"built={args.out.name}")
    print(f"bytes={len(html.encode('utf-8'))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
