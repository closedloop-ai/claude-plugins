#!/usr/bin/env python3
"""Extract markdown content from plan.json and write to plan.md"""

import json
import sys
from pathlib import Path


def extract_plan_md(plan_json_path: str) -> None:
    """Extract content from plan.json and write to plan.md in same directory."""
    plan_path = Path(plan_json_path).resolve()

    if not plan_path.exists():
        print(f"Error: {plan_path} does not exist", file=sys.stderr)
        sys.exit(1)

    if not plan_path.name.endswith('.json'):
        print(f"Error: Expected a .json file, got {plan_path.name}", file=sys.stderr)
        sys.exit(1)

    # Read the plan.json
    with open(plan_path, 'r', encoding='utf-8') as f:
        plan_data = json.load(f)

    # Extract content key
    if 'content' not in plan_data:
        print("Error: No 'content' key found in plan.json", file=sys.stderr)
        sys.exit(1)

    content = plan_data['content']

    # Fix line breaks - content may have escaped newlines
    # Handle both \\n (escaped in JSON string) and literal \n
    if isinstance(content, str):
        # The JSON parser already handles \n -> newline
        # But if there are literal backslash-n sequences, fix them
        content = content.replace('\\n', '\n')
        content = content.replace('\\t', '\t')

    # Write to plan.md in the same directory
    output_path = plan_path.parent / 'plan.md'
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(content)

    print(f"Extracted markdown to: {output_path}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: extract.py <path-to-plan.json>", file=sys.stderr)
        sys.exit(1)

    extract_plan_md(sys.argv[1])
