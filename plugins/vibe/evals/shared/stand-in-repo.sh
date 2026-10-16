#!/bin/bash
# Builds the stand-in vibe session every eval case runs in: a tiny repo with
# design tokens, a component catalog, a stand-in screenshot tool (the eval
# sandbox has no browser) and a session record with its decision table.
# Each case's scaffold.sh sources this, then writes its own component and images.
set -euo pipefail
SHARED="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

stand_in_repo() {
  mkdir -p session/design-system session/src session/tools session/.closedloop-ai/decision-tables images
  cat > session/AGENTS.md <<'MD'
# Stand-in repository

This stands in for symphony-alpha in an eval. Build only with the design
tokens in `design-system/tokens.css` and the components in
`design-system/catalog.md`; never a raw pixel, color or weight value.
Components live in `src/<name>.html` with their styles in `src/<name>.css`.

There is no Storybook, control skill or running app here. To see a component
as an image, render it the way Storybook would show it:
`python3 tools/screenshot.py src/<name>.html <out.png> [--width N] [--state hover|selected]`.
MD
  cat > session/design-system/tokens.css <<'CSS'
:root {
  --color-page: #f4f5f7;
  --color-surface: #ffffff;
  --color-surface-hover: #f8faff;
  --color-text: #111827;
  --color-text-muted: #4b5563;
  --color-accent: #2563eb;
  --shadow-none: none;
  --shadow-card: 0px 8px 24px rgba(15, 23, 42, 0.18);
  --shadow-raised: 0px 12px 28px rgba(0, 0, 0, 0.24);
  --text-sm: 14px;
  --text-md: 16px;
  --text-lg: 20px;
  --text-xl: 24px;
  --weight-regular: 400;
  --weight-medium: 500;
  --weight-bold: 700;
  --radius-md: 8px;
  --radius-lg: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --tap-target: 44px;
  --card-width: 420px;
  --panel-width: 360px;
  --border-subtle: 1px solid #e5e7eb;
  --border-selected: 2px solid #2563eb;
}
CSS
  cat > session/design-system/catalog.md <<'MD'
# Component catalog

- `Card`: a surface. Elevation `--shadow-none`, `--shadow-card` (resting) or
  `--shadow-raised` (hover or dragged). Radius `--radius-lg`. Selected state
  (`aria-selected="true"` or the `is-selected` class) uses `--border-selected`
  and the `CheckBadge` component.
- `CheckBadge`: the small accent check shown on a selected item.
- `Heading`: sizes `--text-md`, `--text-lg`, `--text-xl`; weights
  `--weight-regular`, `--weight-medium`, `--weight-bold`.
- `Button`: minimum height `--tap-target` for touch.
MD
  cat > session/tools/screenshot.py <<'PY'
"""Stand-in screenshot tool for the vibe eval workspace.

The eval sandbox has no browser, so this renders the stand-in repo's simple
HTML and CSS with Pillow: a container box (background, border, radius,
padding, box-shadow) holding text rows and buttons (font size, weight, color,
min-height). It is a fixture for the eval cases only, never a plugin tool.

Usage: python3 tools/screenshot.py src/<name>.html <out.png> [--width N] [--state hover|selected]
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = "/System/Library/Fonts/Helvetica.ttc"
RULE = re.compile(r"([^{}]+)\{([^}]*)\}")
DECL = re.compile(r"([\w-]+)\s*:\s*([^;]+);?")
VAR = re.compile(r"var\((--[\w-]+)\)")
ELEMENT = re.compile(r'<(\w+)\s+class="([^"]+)"[^>]*>([^<]*)')
SHADOW = re.compile(r"(-?\d+)px\s+(-?\d+)px\s+(\d+)px\s+rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)")


def tokens(root: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for _, body in RULE.findall((root / "design-system" / "tokens.css").read_text()):
        for name, value in DECL.findall(body):
            values[name] = value.strip()
    return values


def resolve(value: str, table: dict[str, str]) -> str:
    for _ in range(5):
        value = VAR.sub(lambda match: table.get(match.group(1), "0"), value)
    return value.strip()


def styles(css: str, table: dict[str, str], state: str | None) -> dict[str, dict[str, str]]:
    found: dict[str, dict[str, str]] = {}
    for selectors, body in RULE.findall(css):
        for selector in selectors.split(","):
            selector = selector.strip()
            match = re.fullmatch(r"\.([\w-]+)(.*)", selector)
            if not match:
                continue
            name, suffix = match.groups()
            applies = suffix == "" or (state == "hover" and suffix == ":hover") or (
                state == "selected" and suffix in ('[aria-selected="true"]', ".is-selected"))
            if applies:
                found.setdefault(name, {}).update({key: resolve(value, table) for key, value in DECL.findall(body)})
    return found


def px(value: str | None, default: int = 0) -> int:
    match = re.search(r"(-?\d+(?:\.\d+)?)px", value or "")
    return int(float(match.group(1))) if match else default


def color(value: str | None, default: str) -> str:
    return (value or default).strip()


def font(size: int, weight: str | None) -> ImageFont.FreeTypeFont:
    bold = int(re.sub(r"\D", "", weight or "400") or 400) >= 600
    return ImageFont.truetype(FONT, size, index=1 if bold else 0)


def render(html_path: Path, out: Path, width: int, state: str | None) -> None:
    root = html_path.resolve().parents[1]
    table = tokens(root)
    css = re.sub(r"/\*.*?\*/|@import[^;]*;", "", html_path.with_suffix(".css").read_text(), flags=re.S)
    rules = styles(css, table, state)
    elements = ELEMENT.findall(html_path.read_text())
    box = rules.get(elements[0][1].split()[0], {})
    image = Image.new("RGB", (width, 400), color(table.get("--color-page"), "#f4f5f7"))
    pad = px(box.get("padding"), 16)
    rows = []
    for tag, classes, text in elements[1:]:
        style = rules.get(classes.split()[0], {})
        size = px(style.get("font-size"), 14)
        rows.append((tag, text.strip(), style, size, max(px(style.get("min-height")), size + 8)))
    if tag != "button":
        face = font(size, style.get("font-weight"))
        limit = px(box.get("width"), 420)
        lines, line = [], ""
        for word in text.split():
            trial = f"{line} {word}".strip()
            if line and face.getlength(trial) > limit:
                lines.append(line)
                line = word
            else:
                line = trial
        lines.append(line)
        rows[-1] = (tag, "\n".join(lines), style, size, len(lines) * (size + 8))
    inner = sum(row[4] + 10 for row in rows)
    card_w = min(width - 40, px(box.get("width"), 420) + 2 * pad)
    left, top = (width - card_w) // 2, max(20, (400 - inner - 2 * pad) // 2)
    shape = (left, top, left + card_w, top + inner + 2 * pad)
    radius = px(box.get("border-radius"), 0)
    shadow = SHADOW.search(box.get("box-shadow", ""))
    if shadow:
        dx, dy, blur, r, g, b, alpha = shadow.groups()
        layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle(
            [shape[0] + int(dx), shape[1] + int(dy), shape[2] + int(dx), shape[3] + int(dy)], radius,
            fill=(int(r), int(g), int(b), int(float(alpha) * 255)))
        image.paste(layer.filter(ImageFilter.GaussianBlur(int(blur) / 2)), (0, 0), layer.filter(ImageFilter.GaussianBlur(int(blur) / 2)))
    draw = ImageDraw.Draw(image)
    border = box.get("border", "")
    border_width = px(border)
    border_color = border.split()[-1] if border_width else None
    draw.rounded_rectangle(shape, radius, fill=color(box.get("background"), "#ffffff"),
                           outline=border_color, width=border_width or 0)
    y = shape[1] + pad
    for tag, text, style, size, height in rows:
        face = font(size, style.get("font-weight"))
        if tag == "button":
            text_w = draw.textlength(text, font=face)
            left_x = shape[0] + pad
            if (style.get("text-align") or box.get("text-align")) == "center" or box.get("text-align") == "center":
                left_x = (shape[0] + shape[2] - int(text_w) - 40) // 2
            button = (left_x, y, left_x + int(text_w) + 40, y + height)
            draw.rounded_rectangle(button, px(style.get("border-radius"), 6), fill=color(style.get("background"), "#111827"))
            draw.text((button[0] + 20, y + (height - size) // 2), text, font=face, fill=color(style.get("color"), "#ffffff"))
        else:
            centered = (style.get("text-align") or box.get("text-align")) == "center"
            x = shape[0] + pad
            if centered:
                x = (shape[0] + shape[2] - max(face.getlength(line) for line in text.split("\n"))) // 2
            draw.multiline_text((x, y), text, font=face, fill=color(style.get("color"), "#111827"), spacing=8,
                                align="center" if centered else "left")
        y += height + 10
    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("html")
    parser.add_argument("out")
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--state", choices=["hover", "selected"])
    args = parser.parse_args()
    render(Path(args.html), Path(args.out), args.width, args.state)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
PY
  cat > session/.closedloop-ai/decision-tables/session.md <<'MD'
# Session decision table

## Rows

## Acceptance Criteria

### Checks
MD
  (cd session && git init -q -b vibe/stand-in && git -c user.name=Eval -c user.email=eval@example.invalid add -A \
    && git -c user.name=Eval -c user.email=eval@example.invalid commit -q -m "Stand-in base" \
    && printf '{"worktree":"%s","branch":"vibe/stand-in","status":"active"}\n' "$PWD" > .git/vibe-session.json)
}
