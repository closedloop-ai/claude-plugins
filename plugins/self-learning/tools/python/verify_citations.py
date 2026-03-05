#!/usr/bin/env python3
"""
ClosedLoop Self-Learning System - Citation Verification

Verifies that learning acknowledgments contain valid file:line citations
that correspond to actual changes in the git diff.
"""

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

# Log format field counts
ACK_LOG_MIN_FIELDS = 7  # timestamp|run_id|iteration|agent|acknowledged|patterns|evidence
ACK_LOG_EVIDENCE_INDEX = 6
OUTCOMES_LOG_MIN_FIELDS = 5  # timestamp|run_id|iteration|agent|pattern


@dataclass
class Citation:
    """A file:line citation from an acknowledgment."""
    file_path: str
    line_number: int
    pattern: str
    agent: str
    run_id: str
    iteration: int


@dataclass
class VerificationResult:
    """Result of verifying a citation."""
    citation: Citation
    valid: bool
    reason: str


def parse_acknowledgments_log(log_path: Path) -> list[Citation]:
    """Parse acknowledgments.log to extract citations.

    Format: timestamp|run_id|iteration|agent|acknowledged|patterns_applied|evidence_summary
    """
    citations = []

    if not log_path.exists():
        return citations

    with open(log_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            parts = line.split('|')
            if len(parts) < ACK_LOG_MIN_FIELDS:
                continue

            run_id = parts[1]
            iteration = int(parts[2]) if parts[2].isdigit() else 0
            agent = parts[3]
            patterns = parts[5]
            evidence = parts[ACK_LOG_EVIDENCE_INDEX] if len(parts) > ACK_LOG_EVIDENCE_INDEX else ''

            # Extract file:line citations from evidence
            citation_pattern = r'([a-zA-Z0-9_/.\\-]+):(\d+)'
            for match in re.finditer(citation_pattern, evidence):
                file_path = match.group(1)
                line_num = int(match.group(2))

                citations.append(Citation(
                    file_path=file_path,
                    line_number=line_num,
                    pattern=patterns,
                    agent=agent,
                    run_id=run_id,
                    iteration=iteration
                ))

    return citations


def get_changed_files(start_sha: str, workdir: Path) -> set[str]:
    """Get list of files changed since start_sha."""
    try:
        result = subprocess.run(
            ['git', '-C', str(workdir), 'diff', '--name-only', start_sha, 'HEAD'],
            capture_output=True,
            text=True,
            check=True
        )
        return set(result.stdout.strip().split('\n')) if result.stdout.strip() else set()
    except subprocess.CalledProcessError:
        return set()


def get_changed_lines(start_sha: str, workdir: Path, file_path: str) -> set[int]:
    """Get line numbers that were modified in a file since start_sha."""
    changed_lines = set()

    try:
        result = subprocess.run(
            ['git', '-C', str(workdir), 'diff', '--unified=0', start_sha, 'HEAD', '--', file_path],
            capture_output=True,
            text=True,
            check=True
        )

        # Parse diff hunks: @@ -start,count +start,count @@
        hunk_pattern = r'@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@'
        for match in re.finditer(hunk_pattern, result.stdout):
            start_line = int(match.group(1))
            count = int(match.group(2)) if match.group(2) else 1

            for i in range(count):
                changed_lines.add(start_line + i)

        return changed_lines
    except subprocess.CalledProcessError:
        return set()


def verify_citation(citation: Citation, start_sha: str, workdir: Path,
                    changed_files: set[str]) -> VerificationResult:
    """Verify a single citation against git diff."""

    file_path = citation.file_path

    # Normalize path (handle both absolute and relative)
    if os.path.isabs(file_path):
        file_path = os.path.relpath(file_path, workdir)

    # Check if file exists
    full_path = workdir / file_path
    if not full_path.exists():
        return VerificationResult(
            citation=citation,
            valid=False,
            reason=f"File does not exist: {file_path}"
        )

    # Check if file was modified
    if file_path not in changed_files:
        return VerificationResult(
            citation=citation,
            valid=False,
            reason=f"File was not modified: {file_path}"
        )

    # Check if the specific line was modified
    changed_lines = get_changed_lines(start_sha, workdir, file_path)
    if citation.line_number not in changed_lines:
        # Allow some tolerance (+-5 lines) for minor shifts
        nearby_lines = set(range(citation.line_number - 5, citation.line_number + 6))
        if not nearby_lines & changed_lines:
            return VerificationResult(
                citation=citation,
                valid=False,
                reason=f"Line {citation.line_number} was not modified (changed lines: {sorted(changed_lines)[:10]}...)"
            )

    return VerificationResult(
        citation=citation,
        valid=True,
        reason="Citation verified"
    )


def update_outcomes_log(log_path: Path, invalid_citations: list[VerificationResult]) -> None:
    """Mark unverified citations in outcomes.log."""
    if not log_path.exists() or not invalid_citations:
        return

    # Create a set of (run_id, iteration, pattern) tuples to mark as unverified
    unverified = {
        (c.citation.run_id, c.citation.iteration, c.citation.pattern)
        for c in invalid_citations
    }

    # Read and update outcomes.log
    lines = []
    with open(log_path, 'r') as f:
        for line in f:
            parts = line.strip().split('|')
            if len(parts) >= OUTCOMES_LOG_MIN_FIELDS:
                run_id = parts[1]
                iteration = int(parts[2]) if parts[2].isdigit() else 0
                pattern = parts[4]

                if (run_id, iteration, pattern) in unverified:
                    if not line.strip().endswith('|unverified'):
                        line = line.rstrip() + '|unverified\n'
            lines.append(line)

    # Write back atomically
    tmp_path = log_path.with_suffix('.tmp')
    with open(tmp_path, 'w') as f:
        f.writelines(lines)
    tmp_path.rename(log_path)


def write_failures_report(report_path: Path, invalid_results: list[VerificationResult]) -> None:
    """Write verification failures to failures.md."""
    with open(report_path, 'a') as f:
        f.write(f"\n## Citation Verification Failures - {datetime.now().isoformat()}\n\n")
        for result in invalid_results:
            c = result.citation
            f.write(f"- **{c.file_path}:{c.line_number}** ({c.agent})\n")
            f.write(f"  - Pattern: {c.pattern}\n")
            f.write(f"  - Reason: {result.reason}\n\n")


def main():
    parser = argparse.ArgumentParser(description='Verify learning citation accuracy')
    parser.add_argument('--start-sha', required=True, help='Git SHA to diff from')
    parser.add_argument('--workdir', default='.', help='Working directory')
    parser.add_argument('--enable-semantic', action='store_true',
                        help='Enable semantic verification (AST + LLM fallback)')

    args = parser.parse_args()

    workdir = Path(args.workdir).resolve()
    learnings_dir = workdir / '.learnings'

    # Parse acknowledgments
    citations = parse_acknowledgments_log(learnings_dir / 'acknowledgments.log')

    if not citations:
        print("No citations found to verify")
        return 0

    # Get changed files
    changed_files = get_changed_files(args.start_sha, workdir)

    if not changed_files:
        print("No files changed since start SHA")
        return 0

    # Verify each citation
    results = []
    for citation in citations:
        result = verify_citation(citation, args.start_sha, workdir, changed_files)
        results.append(result)

    # Separate valid and invalid
    valid_results = [r for r in results if r.valid]
    invalid_results = [r for r in results if not r.valid]

    # Report results
    print("Citation verification complete:")
    print(f"  Valid: {len(valid_results)}")
    print(f"  Invalid: {len(invalid_results)}")

    if invalid_results:
        # Update outcomes.log
        update_outcomes_log(learnings_dir / 'outcomes.log', invalid_results)

        # Write failures report
        write_failures_report(learnings_dir / 'failures.md', invalid_results)

        print(f"\nFailures written to {learnings_dir / 'failures.md'}")

        # Return non-zero but don't fail the run
        return 1

    return 0


if __name__ == '__main__':
    sys.exit(main())
