#!/usr/bin/env python3
"""Input-safety and structure checks for render_report.py."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from render_report import build_document, render_markdown


CSS = "body { color: #123; }"


class RenderReportTests(unittest.TestCase):
    def test_escapes_source_html_and_rejects_unsafe_links(self) -> None:
        body, count = render_markdown(
            "# Report\n\n<script>alert(1)</script> [bad](javascript:alert(2)) [good](https://example.com/a)",
            set(),
        )
        self.assertEqual(count, 0)
        self.assertNotIn("<script>alert", body)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", body)
        self.assertNotIn('href="javascript:', body)
        self.assertIn('href="https://example.com/a"', body)
        self.assertIn('rel="noopener noreferrer"', body)

    def test_renders_tables_and_collapsible_context(self) -> None:
        body, _ = render_markdown(
            "## Assigned\n\n| Ticket | Owner |\n| --- | --- |\n| ISS-1 | Me |\n\n## Evidence\n\nPrivate snapshot.",
            {"Evidence"},
        )
        self.assertIn("<table>", body)
        self.assertIn('<details class="section-detail">', body)
        self.assertIn("Private snapshot.", body)

    def test_marks_only_policy_protected_table_rows_and_keeps_links_active(self) -> None:
        body, _ = render_markdown(
            """## Reassignment recommendation

| Ticket | Current owner | Disposition |
| --- | --- | --- |
| [ISS-1](https://example.com/issues/ISS-1) | Matt | **Protected owner — no reassignment.** Infrastructure policy. |
| [ISS-2](https://example.com/issues/ISS-2) | Kris | **Keep owner; coordinate.** Shared dependency. |
| [ISS-3](https://example.com/issues/ISS-3) | Nenad | **Protected owner — no reassignment** Security policy. |
""",
            set(),
        )
        self.assertEqual(body.count('class="protected-owner-row"'), 2)
        self.assertEqual(body.count('class="protected-owner-badge"'), 2)
        self.assertIn(
            '<span class="protected-owner-label">Protected owner</span>', body
        )
        self.assertIn('href="https://example.com/issues/ISS-1"', body)
        self.assertIn('href="https://example.com/issues/ISS-2"', body)
        ordinary_row = body.split('href="https://example.com/issues/ISS-2"', 1)[1].split(
            "</tr>", 1
        )[0]
        self.assertNotIn("protected-owner-badge", ordinary_row)
        self.assertIn("<strong>Keep owner; coordinate.</strong>", ordinary_row)

    def test_does_not_mark_unbolded_or_non_table_policy_text(self) -> None:
        body, _ = render_markdown(
            """Protected owner — no reassignment.

**Protected owner — no reassignment.**

| Ticket | Note |
| --- | --- |
| ISS-4 | Protected owner — no reassignment. |
| ISS-5 | `**Protected owner — no reassignment.**` |
""",
            set(),
        )
        self.assertNotIn("protected-owner-row", body)
        self.assertNotIn("protected-owner-badge", body)

    def test_mermaid_requires_an_embedded_renderer(self) -> None:
        markdown = "# Report\n\n```mermaid\nflowchart LR\n  A --> B\n```"
        with self.assertRaisesRegex(ValueError, "provide --mermaid-js"):
            build_document(markdown, "Report", CSS, set(), None)

    def test_mermaid_source_is_escaped_and_security_is_strict(self) -> None:
        markdown = "# Report\n\n```mermaid\nflowchart LR\n  A[<img src=x onerror=alert(1)>] --> B\n```"
        document = build_document(markdown, "Report", CSS, set(), "window.mermaid = mermaid;")
        self.assertIn("&lt;img src=x onerror=alert(1)&gt;", document)
        self.assertNotIn("A[<img", document)
        self.assertIn('securityLevel: "strict"', document)
        self.assertIn('Content-Security-Policy', document)

    def test_cli_style_output_is_self_contained(self) -> None:
        document = build_document("# Local report", "Local report", CSS, set(), None)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.html"
            path.write_text(document, encoding="utf-8")
            saved = path.read_text(encoding="utf-8")
        self.assertIn("<style>body", saved)
        self.assertNotIn("<link rel=", saved)
        self.assertIn("window.__REPORT_RENDER_COMPLETE = true", saved)
        self.assertIn('dataset.mermaidRendered = "true"', saved)


if __name__ == "__main__":
    unittest.main()
