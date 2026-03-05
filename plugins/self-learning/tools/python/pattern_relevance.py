#!/usr/bin/env python3
"""
ClosedLoop Self-Learning System - Pattern Relevance Analysis

Analyzes pattern relevance using hybrid approach: AST concepts, context tags, and file paths.
"""

import argparse
import csv
import io
import json
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

# Minimum keyword length to consider (excludes noise like "to", "be", etc.)
MIN_KEYWORD_LENGTH = 2

# TOON field order (comma-delimited, 9 fields):
# id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context
TOON_FIELD_COUNT = 9


@dataclass
class Pattern:
    """A pattern from org-patterns.toon."""
    id: str
    category: str
    summary: str
    confidence: str
    seen_count: int
    success_rate: float
    flags: str
    applies_to: list[str]
    context: str


@dataclass
class RelevanceScore:
    """Relevance score for a pattern."""
    pattern_id: str
    score: float  # 0.0 - 1.0
    method: str  # ast, context_tags, file_paths
    matched_concepts: list[str]


def parse_toon_file(toon_path: Path) -> list[Pattern]:
    """Parse org-patterns.toon file (comma-delimited TOON format, 9 fields)."""
    patterns = []

    if not toon_path.exists():
        return patterns

    with open(toon_path, 'r') as f:
        for line in f:
            stripped = line.strip()
            if not stripped or stripped.startswith('#') or stripped.startswith('patterns['):
                continue

            # Parse comma-delimited TOON row using csv.reader
            reader = csv.reader(io.StringIO(stripped))
            for fields in reader:
                if len(fields) < TOON_FIELD_COUNT:
                    continue

                # applies_to uses pipe-separated agent names
                applies_to_raw = fields[7].strip()
                applies_to = applies_to_raw.split('|') if applies_to_raw and applies_to_raw != '*' else ['*']

                patterns.append(Pattern(
                    id=fields[0].strip(),
                    category=fields[1].strip(),
                    summary=fields[2].strip(),
                    confidence=fields[3].strip(),
                    seen_count=int(fields[4].strip()) if fields[4].strip().isdigit() else 0,
                    success_rate=float(fields[5].strip()) if fields[5].strip() else 0.0,
                    flags=fields[6].strip(),
                    applies_to=applies_to,
                    context=fields[8].strip(),
                ))
                break  # csv.reader yields one row per StringIO line

    return patterns


def extract_context_tags(file_path: str) -> set[str]:
    """Extract context tags from file paths."""
    tags = set()

    path_lower = file_path.lower()

    # Component patterns
    if 'component' in path_lower:
        tags.add('component')
    if 'hook' in path_lower or 'use' in path_lower.split('/')[-1]:
        tags.add('hooks')
    if 'route' in path_lower or 'page' in path_lower:
        tags.add('routes')
    if 'auth' in path_lower:
        tags.add('auth')
    if 'api' in path_lower:
        tags.add('api')
    if 'test' in path_lower or 'spec' in path_lower:
        tags.add('test')
    if 'util' in path_lower or 'helper' in path_lower:
        tags.add('utils')
    if 'config' in path_lower or 'setting' in path_lower:
        tags.add('config')
    if 'model' in path_lower or 'schema' in path_lower:
        tags.add('models')
    if 'service' in path_lower:
        tags.add('services')
    if 'store' in path_lower or 'state' in path_lower:
        tags.add('state')
    if 'style' in path_lower or 'css' in path_lower:
        tags.add('styles')

    # File type tags
    ext = Path(file_path).suffix.lower()
    if ext in ['.ts', '.tsx', '.js', '.jsx']:
        tags.add('javascript')
    if ext in ['.py']:
        tags.add('python')
    if ext in ['.json', '.yaml', '.yml']:
        tags.add('config')
    if ext in ['.md']:
        tags.add('docs')

    return tags


def extract_keywords_from_pattern(pattern: Pattern) -> set[str]:
    """Extract keywords from pattern summary and context."""
    keywords = set()

    # Normalize and split summary and context tags
    text = f"{pattern.summary} {pattern.context}".lower()

    # Remove common words
    stopwords = {'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
                 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
                 'would', 'could', 'should', 'may', 'might', 'must', 'shall',
                 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
                 'as', 'into', 'through', 'during', 'before', 'after', 'above',
                 'below', 'between', 'under', 'and', 'or', 'but', 'if', 'then',
                 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both',
                 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
                 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
                 'just', 'always', 'never', 'use', 'using', 'check', 'make'}

    # Extract words
    words = re.findall(r'\b[a-z_][a-z0-9_]*\b', text)
    keywords = {w for w in words if w not in stopwords and len(w) > MIN_KEYWORD_LENGTH}

    return keywords


def calculate_relevance(pattern: Pattern, changed_files: list[str]) -> RelevanceScore:
    """Calculate relevance score for a pattern against changed files."""

    # Extract context tags from all changed files
    all_tags = set()
    for file_path in changed_files:
        all_tags.update(extract_context_tags(file_path))

    # Extract keywords from pattern
    pattern_keywords = extract_keywords_from_pattern(pattern)

    # Calculate overlap
    matched = pattern_keywords & all_tags

    if pattern_keywords:
        score = len(matched) / len(pattern_keywords)
    else:
        score = 0.0

    # Boost score if pattern summary keywords appear in file paths
    summary_lower = pattern.summary.lower().replace('_', ' ').replace('-', ' ')
    summary_words = set(re.findall(r'[a-z]+', summary_lower))

    for file_path in changed_files:
        path_words = set(re.findall(r'[a-z]+', file_path.lower()))
        if summary_words & path_words:
            score = min(1.0, score + 0.2)
            matched.update(summary_words & path_words)
            break

    return RelevanceScore(
        pattern_id=pattern.id,
        score=round(score, 2),
        method='context_tags',
        matched_concepts=list(matched)
    )


def main():
    parser = argparse.ArgumentParser(description='Calculate pattern relevance')
    parser.add_argument('--workdir', default='.', help='Working directory')
    parser.add_argument('--changed-files', required=True, help='JSON file with list of changed files')
    parser.add_argument('--output', default='-', help='Output file (- for stdout)')

    args = parser.parse_args()

    workdir = Path(args.workdir).resolve()
    toon_path = workdir / '.learnings' / 'org-patterns.toon'

    # Load changed files
    with open(args.changed_files, 'r') as f:
        changed_files = json.load(f)

    if not changed_files:
        print("No changed files provided", file=sys.stderr)
        return 0

    # Parse patterns
    patterns = parse_toon_file(toon_path)

    if not patterns:
        print("No patterns found in org-patterns.toon", file=sys.stderr)
        return 0

    # Calculate relevance for each pattern
    results = []
    for pattern in patterns:
        score = calculate_relevance(pattern, changed_files)
        results.append(asdict(score))

    # Output results
    output_json = json.dumps(results, indent=2)

    if args.output == '-':
        print(output_json)
    else:
        with open(args.output, 'w') as f:
            f.write(output_json)

    return 0


if __name__ == '__main__':
    sys.exit(main())
