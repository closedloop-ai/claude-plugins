#!/usr/bin/env python3
"""Render a safe, self-contained work-report HTML file from constrained Markdown."""

from __future__ import annotations

import argparse
import html
import re
from pathlib import Path
from urllib.parse import urlparse


FENCE_RE = re.compile(r"^```\s*([A-Za-z0-9_-]*)\s*$")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
LIST_RE = re.compile(r"^\s*(?:(?P<ordered>\d+)\.|(?P<bullet>[-+*]))\s+(?P<body>.+)$")
TABLE_SEPARATOR_RE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$")
INLINE_RE = re.compile(r"`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)")
SAFE_URL_SCHEMES = {"http", "https", "mailto"}
PROTECTED_OWNER_LABEL = "Protected owner — no reassignment"
PROTECTED_OWNER_STRONG_VALUES = {PROTECTED_OWNER_LABEL, f"{PROTECTED_OWNER_LABEL}."}


def safe_url(raw: str) -> str | None:
    parsed = urlparse(raw)
    if parsed.scheme.lower() not in SAFE_URL_SCHEMES:
        return None
    return html.escape(raw, quote=True)


def render_inline(source: str, *, protected_owner_marker: bool = False) -> str:
    """Render the supported inline Markdown subset while escaping all source HTML."""
    rendered: list[str] = []
    cursor = 0
    for match in INLINE_RE.finditer(source):
        rendered.append(html.escape(source[cursor : match.start()]))
        code, strong, label, href = match.groups()
        if code is not None:
            rendered.append(f"<code>{html.escape(code)}</code>")
        elif strong is not None:
            if protected_owner_marker and strong in PROTECTED_OWNER_STRONG_VALUES:
                rendered.append(
                    '<span class="protected-owner-policy">'
                    '<span class="protected-owner-label">Protected owner</span>'
                    '<span class="protected-owner-badge">No reassignment</span>'
                    "</span>"
                )
            else:
                rendered.append(f"<strong>{html.escape(strong)}</strong>")
        else:
            url = safe_url(href)
            escaped_label = html.escape(label)
            if url is None:
                rendered.append(f"{escaped_label} ({html.escape(href)})")
            else:
                rendered.append(
                    f'<a href="{url}" target="_blank" rel="noopener noreferrer">{escaped_label}</a>'
                )
        cursor = match.end()
    rendered.append(html.escape(source[cursor:]))
    return "".join(rendered)


def has_protected_owner_marker(source: str) -> bool:
    """Return true only for the exact bold policy marker parsed as strong text."""
    return any(
        match.group(2) in PROTECTED_OWNER_STRONG_VALUES
        for match in INLINE_RE.finditer(source)
    )


def split_table_row(line: str) -> list[str]:
    stripped = line.strip().strip("|")
    return [cell.strip() for cell in stripped.split("|")]


def render_markdown(source: str, collapse_headings: set[str]) -> tuple[str, int]:
    """Render report Markdown and return HTML plus Mermaid diagram count."""
    lines = source.splitlines()
    output: list[str] = []
    index = 0
    diagram_count = 0
    detail_open = False

    def close_detail() -> None:
        nonlocal detail_open
        if detail_open:
            output.append("</div></details>")
            detail_open = False

    while index < len(lines):
        line = lines[index]
        if not line.strip():
            index += 1
            continue

        fence = FENCE_RE.match(line)
        if fence:
            language = fence.group(1).lower()
            code_lines: list[str] = []
            index += 1
            while index < len(lines) and not lines[index].startswith("```"):
                code_lines.append(lines[index])
                index += 1
            if index >= len(lines):
                raise ValueError("Unclosed fenced code block")
            index += 1
            code = "\n".join(code_lines)
            if language == "mermaid":
                diagram_count += 1
                escaped = html.escape(code)
                output.append(
                    '<figure class="diagram-card">'
                    f'<div class="mermaid" role="img" aria-label="Dependency and ownership diagram">{escaped}</div>'
                    '<details class="diagram-fallback"><summary>Text version of diagram</summary>'
                    f"<pre><code>{escaped}</code></pre></details></figure>"
                )
            else:
                class_name = f' class="language-{html.escape(language)}"' if language else ""
                output.append(f"<pre><code{class_name}>{html.escape(code)}</code></pre>")
            continue

        heading = HEADING_RE.match(line)
        if heading:
            level = len(heading.group(1))
            title = heading.group(2).strip()
            if level == 2:
                close_detail()
                if title in collapse_headings:
                    output.append(
                        '<details class="section-detail"><summary>'
                        f"{render_inline(title)}</summary><div class=\"section-detail-body\">"
                    )
                    detail_open = True
                else:
                    output.append(f"<h2>{render_inline(title)}</h2>")
            else:
                output.append(f"<h{level}>{render_inline(title)}</h{level}>")
            index += 1
            continue

        if (
            "|" in line
            and index + 1 < len(lines)
            and TABLE_SEPARATOR_RE.match(lines[index + 1])
        ):
            headers = split_table_row(line)
            index += 2
            rows: list[list[str]] = []
            while index < len(lines) and "|" in lines[index] and lines[index].strip():
                rows.append(split_table_row(lines[index]))
                index += 1
            output.append('<div class="table-wrap"><table><thead><tr>')
            output.extend(f"<th scope=\"col\">{render_inline(cell)}</th>" for cell in headers)
            output.append("</tr></thead><tbody>")
            for row in rows:
                normalized = row[: len(headers)] + [""] * max(0, len(headers) - len(row))
                protected_owner = any(has_protected_owner_marker(cell) for cell in normalized)
                row_class = ' class="protected-owner-row"' if protected_owner else ""
                output.append(f"<tr{row_class}>")
                output.extend(
                    f"<td>{render_inline(cell, protected_owner_marker=protected_owner)}</td>"
                    for cell in normalized
                )
                output.append("</tr>")
            output.append("</tbody></table></div>")
            continue

        list_match = LIST_RE.match(line)
        if list_match:
            list_type = "ol" if list_match.group("ordered") else "ul"
            output.append(f"<{list_type}>")
            while index < len(lines):
                item = LIST_RE.match(lines[index])
                item_type = "ol" if item and item.group("ordered") else "ul"
                if item is None or item_type != list_type:
                    break
                output.append(f"<li>{render_inline(item.group('body'))}</li>")
                index += 1
            output.append(f"</{list_type}>")
            continue

        if line.startswith("> "):
            quote_lines: list[str] = []
            while index < len(lines) and lines[index].startswith("> "):
                quote_lines.append(lines[index][2:])
                index += 1
            output.append(f'<blockquote class="report-note">{render_inline(" ".join(quote_lines))}</blockquote>')
            continue

        if re.match(r"^\s*---+\s*$", line):
            output.append("<hr>")
            index += 1
            continue

        paragraph: list[str] = []
        while index < len(lines):
            candidate = lines[index]
            if not candidate.strip():
                break
            if paragraph and (
                FENCE_RE.match(candidate)
                or HEADING_RE.match(candidate)
                or LIST_RE.match(candidate)
                or candidate.startswith("> ")
            ):
                break
            if paragraph and index + 1 < len(lines) and TABLE_SEPARATOR_RE.match(lines[index + 1]):
                break
            paragraph.append(candidate.strip())
            index += 1
        output.append(f"<p>{render_inline(' '.join(paragraph))}</p>")

    close_detail()
    return "\n".join(output), diagram_count


def build_document(
    markdown: str,
    title: str,
    css: str,
    collapse_headings: set[str],
    mermaid_js: str | None,
) -> str:
    body, diagram_count = render_markdown(markdown, collapse_headings)
    if diagram_count and not mermaid_js:
        raise ValueError("Mermaid diagram present; provide --mermaid-js so it renders in the HTML")

    script = """
<script>
document.documentElement.dataset.mermaidRendered = "true";
window.__REPORT_RENDER_COMPLETE = true;
</script>"""
    if mermaid_js:
        safe_library = mermaid_js.replace("</script", "<\\/script")
        script = f"""
<script>{safe_library}</script>
<script>
(() => {{
  const markComplete = (ok) => {{
    document.documentElement.dataset.mermaidRendered = ok ? "true" : "false";
    window.__REPORT_RENDER_COMPLETE = true;
  }};
  try {{
    mermaid.initialize({{
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
      flowchart: {{ htmlLabels: false, curve: "basis" }},
      themeVariables: {{
        fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        primaryColor: "#e9f4ee",
        primaryTextColor: "#17211b",
        primaryBorderColor: "#196b51",
        lineColor: "#63756a",
        secondaryColor: "#fff4df",
        tertiaryColor: "#f2f3f1"
      }}
    }});
    mermaid.run({{ querySelector: ".mermaid" }}).then(() => markComplete(true)).catch((error) => {{
      console.error("Mermaid render failed", error);
      markComplete(false);
    }});
  }} catch (error) {{
    console.error("Mermaid initialization failed", error);
    markComplete(false);
  }}
}})();
</script>"""

    escaped_title = html.escape(title)
    safe_css = css.replace("</style", "<\\/style")
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
<title>{escaped_title}</title>
<style>{safe_css}</style>
</head>
<body>
<main>{body}<p class="report-footer">Read-only planning report. Links open their cited source in a new tab.</p></main>
{script}
</body>
</html>
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="UTF-8 Markdown report")
    parser.add_argument("output", type=Path, help="Destination HTML file")
    parser.add_argument("--title", help="HTML document title; defaults to first H1")
    parser.add_argument("--css", type=Path, help="CSS asset; defaults to ../assets/report.css")
    parser.add_argument(
        "--mermaid-js",
        type=Path,
        help="Mermaid 11.x browser bundle to inline; defaults to the bundled 11.16.0 asset",
    )
    parser.add_argument(
        "--collapse",
        action="append",
        default=[],
        metavar="H2",
        help="Render the matching level-two section as a collapsed disclosure",
    )
    args = parser.parse_args()

    markdown = args.input.read_text(encoding="utf-8")
    heading = re.search(r"^#\s+(.+)$", markdown, re.MULTILINE)
    title = args.title or (heading.group(1) if heading else "Work report")
    css_path = args.css or Path(__file__).resolve().parent.parent / "assets" / "report.css"
    css = css_path.read_text(encoding="utf-8")
    mermaid_path = args.mermaid_js or (
        Path(__file__).resolve().parent.parent / "assets" / "mermaid-11.16.0.min.js"
    )
    mermaid_js = mermaid_path.read_text(encoding="utf-8") if mermaid_path.is_file() else None

    document = build_document(markdown, title, css, set(args.collapse), mermaid_js)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(document, encoding="utf-8")
    print(f"Rendered {args.output}")


if __name__ == "__main__":
    main()
