#!/usr/bin/env python3
"""Find a file within the Claude Code plugins cache directory.

Searches ~/.claude/plugins/cache/closedloop-ai/ for a file by name,
automatically selecting the latest version of each plugin using
semantic versioning.

Usage:
    python3 find_plugin_file.py <file_pattern> [--plugin <plugin-name>]

Examples:
    python3 find_plugin_file.py parse_args.py
    python3 find_plugin_file.py plan/parse_args.py
    python3 find_plugin_file.py parse_args.py --plugin code
    python3 find_plugin_file.py SKILL.md --all
"""

import argparse
import re
import sys
from pathlib import Path


def parse_version(version_str: str) -> tuple[int, ...]:
    """Parse a version string into a tuple of integers for comparison.

    Handles formats like: 1.0.0, 1.10.0, 2.0.0-beta, etc.
    Non-numeric parts are ignored for comparison purposes.
    """
    # Extract numeric parts
    parts = re.findall(r'\d+', version_str)
    return tuple(int(p) for p in parts) if parts else (0,)


def get_latest_version(plugin_path: Path) -> Path | None:
    """Get the path to the latest version directory for a plugin.

    Args:
        plugin_path: Path to the plugin directory containing version subdirectories

    Returns:
        Path to the latest version directory, or None if no versions found
    """
    if not plugin_path.is_dir():
        return None

    versions: list[tuple[tuple[int, ...], Path]] = []
    for entry in plugin_path.iterdir():
        if entry.is_dir() and re.match(r'^\d+\.', entry.name):
            versions.append((parse_version(entry.name), entry))

    if not versions:
        return None

    # Sort by parsed version and return the highest
    versions.sort(key=lambda x: x[0], reverse=True)
    return versions[0][1]


def find_file_in_dir(directory: Path, file_pattern: str, find_all: bool = False) -> list[Path]:
    """Recursively find a file by name or path pattern within a directory.

    Args:
        directory: Directory to search in
        file_pattern: Name of the file or path pattern to find.
                      Can be a simple filename (e.g., 'parse_args.py') or
                      a path pattern (e.g., 'plan/parse_args.py')
        find_all: If True, return all matches; if False, return first match only

    Returns:
        List of matching file paths
    """
    matches: list[Path] = []

    # Normalize the pattern to use forward slashes for comparison
    normalized_pattern = file_pattern.replace('\\', '/')

    try:
        for path in directory.rglob('*'):
            if not path.is_file():
                continue

            # Get path relative to search directory for pattern matching
            try:
                relative_path = path.relative_to(directory)
                relative_str = str(relative_path).replace('\\', '/')
            except ValueError:
                continue

            # Check if the pattern matches:
            # 1. Exact filename match (pattern has no slashes)
            # 2. Path suffix match (pattern has slashes, e.g., 'plan/parse_args.py')
            if '/' not in normalized_pattern:
                # Simple filename match
                if path.name == file_pattern:
                    matches.append(path)
                    if not find_all:
                        return matches
            else:
                # Path pattern match - check if relative path ends with the pattern
                if relative_str.endswith(normalized_pattern) or relative_str == normalized_pattern:
                    matches.append(path)
                    if not find_all:
                        return matches
    except PermissionError:
        pass

    return matches


def find_plugin_file(
    file_pattern: str,
    plugin_name: str | None = None,
    find_all: bool = False,
    cache_dir: Path | None = None,
) -> list[Path]:
    """Find a file within the Claude Code plugins cache.

    Args:
        file_pattern: File name or path pattern to find.
                      Can be a simple filename (e.g., 'parse_args.py') or
                      a path pattern (e.g., 'plan/parse_args.py')
        plugin_name: Optional plugin name to restrict search (e.g., 'code')
        find_all: If True, return all matches across all plugins
        cache_dir: Override the default cache directory (useful for testing)

    Returns:
        List of matching file paths
    """
    if cache_dir is None:
        cache_dir = Path.home() / '.claude' / 'plugins' / 'cache' / 'closedloop-ai'

    if not cache_dir.is_dir():
        return []

    results: list[Path] = []

    # Get list of plugins to search
    if plugin_name:
        plugins = [cache_dir / plugin_name]
    else:
        plugins = [p for p in cache_dir.iterdir() if p.is_dir()]

    for plugin_path in plugins:
        if not plugin_path.is_dir():
            continue

        latest_version = get_latest_version(plugin_path)
        if latest_version is None:
            continue

        matches = find_file_in_dir(latest_version, file_pattern, find_all)
        results.extend(matches)

        if results and not find_all:
            break

    return results


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Find a file within the Claude Code plugins cache directory.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s parse_args.py                    # Find parse_args.py in any plugin
  %(prog)s parse_args.py --plugin code            # Find only in code plugin
  %(prog)s SKILL.md --all                   # Find all SKILL.md files
  %(prog)s --list-plugins                   # List available plugins
        """
    )
    parser.add_argument('file_pattern', nargs='?',
                        help='File name or path pattern to find (e.g., parse_args.py or plan/parse_args.py)')
    parser.add_argument('--plugin', '-p', help='Restrict search to a specific plugin')
    parser.add_argument('--all', '-a', action='store_true',
                        help='Return all matches instead of just the first')
    parser.add_argument('--list-plugins', '-l', action='store_true',
                        help='List available plugins and their latest versions')
    parser.add_argument('--cache-dir', type=Path,
                        help='Override the default cache directory')

    args = parser.parse_args()

    cache_dir = args.cache_dir or Path.home() / '.claude' / 'plugins' / 'cache' / 'closedloop-ai'

    if args.list_plugins:
        if not cache_dir.is_dir():
            print(f'Cache directory not found: {cache_dir}', file=sys.stderr)
            return 1

        print('Available plugins:')
        for plugin_path in sorted(cache_dir.iterdir()):
            if plugin_path.is_dir():
                latest = get_latest_version(plugin_path)
                if latest:
                    print(f'  {plugin_path.name}: {latest.name}')
                else:
                    print(f'  {plugin_path.name}: (no versions)')
        return 0

    if not args.file_pattern:
        parser.error('file_pattern is required (unless using --list-plugins)')

    results = find_plugin_file(
        file_pattern=args.file_pattern,
        plugin_name=args.plugin,
        find_all=args.all,
        cache_dir=args.cache_dir,
    )

    if not results:
        print(f'File not found: {args.file_pattern}', file=sys.stderr)
        return 1

    for path in results:
        print(path)

    return 0


if __name__ == '__main__':
    sys.exit(main())
