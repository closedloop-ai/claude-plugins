#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "anthropic>=0.18.0",
# ]
# ///
"""
Token Counter for Anthropic API

Counts tokens in a file or stdin using the Anthropic API's count_tokens endpoint.
Useful for estimating costs and context window usage before making actual API calls.

Usage:
    # Count tokens from a file
    python count_tokens.py path/to/file.txt

    # Count tokens from stdin
    cat file.txt | python count_tokens.py

    # Use with echo
    echo "Hello world" | python count_tokens.py

Environment:
    ANTHROPIC_API_KEY: Required. Your Anthropic API key.

Output:
    JSON object with input_tokens field: {"input_tokens": 42}

Examples:
    $ python count_tokens.py requirements.md
    {"input_tokens": 1523}

    $ cat plan.json | python count_tokens.py
    {"input_tokens": 8947}
"""

import json
import os
import sys
from pathlib import Path
from typing import NoReturn

try:
    from anthropic import Anthropic, APIError, APIConnectionError, RateLimitError  # type: ignore[import-not-found]
except ImportError:
    print(
        "Error: anthropic package is not installed. "
        "Install it with: uv pip install anthropic",
        file=sys.stderr,
    )
    sys.exit(1)

# Model to use for token counting
DEFAULT_MODEL = "claude-opus-4-6"

# Size limits for warnings
SIZE_WARNING_BYTES = 1024 * 1024  # 1MB

# Minimum argument count (script name + file path)
MIN_ARGS_WITH_FILE = 2


def error_exit(msg: str) -> NoReturn:
    """Print error message and exit with status 1.

    Args:
        msg: Error message to display
    """
    print(f"Error: {msg}", file=sys.stderr)
    sys.exit(1)


def load_content() -> str:
    """Load content from file argument or stdin.

    Returns:
        Content to count tokens for

    Raises:
        SystemExit: If content cannot be loaded or is invalid
    """
    # Check if stdin is a TTY (interactive terminal) or has piped input
    if sys.stdin.isatty():
        # No piped input, expect file path argument
        if len(sys.argv) < MIN_ARGS_WITH_FILE:
            error_exit(
                "missing file path argument or stdin input\n"
                "Usage: count_tokens.py <file> OR cat file | count_tokens.py"
            )

        file_path = Path(sys.argv[1])
        if not file_path.exists():
            error_exit(f"file not found: {file_path}")

        if not file_path.is_file():
            error_exit(f"not a file: {file_path}")

        # Warn about large files
        file_size = file_path.stat().st_size
        if file_size > SIZE_WARNING_BYTES:
            size_mb = file_size / (1024 * 1024)
            print(
                f"Warning: large file ({size_mb:.1f}MB) may take longer to process",
                file=sys.stderr,
            )

        # Read file with UTF-8 encoding
        try:
            content = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError as e:
            error_exit(f"file is not valid UTF-8: {e}")
        except IOError as e:
            error_exit(f"failed to read file: {e}")

    else:
        # Read from stdin
        try:
            content = sys.stdin.read()
        except UnicodeDecodeError as e:
            error_exit(f"stdin is not valid UTF-8: {e}")
        except IOError as e:
            error_exit(f"failed to read stdin: {e}")

    # Validate content is not empty
    if not content.strip():
        error_exit("content is empty or contains only whitespace")

    return content


def count_tokens(content: str) -> int:
    """Count tokens using Anthropic API.

    Args:
        content: Text content to count tokens for

    Returns:
        Number of input tokens

    Raises:
        SystemExit: If API request fails or API key is missing
    """
    # Check for API key
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        error_exit(
            "ANTHROPIC_API_KEY environment variable not set\n"
            "Set it with: export ANTHROPIC_API_KEY=your-key-here"
        )

    # Initialize Anthropic client
    try:
        client = Anthropic(api_key=api_key)
    except Exception as e:
        error_exit(f"failed to initialize Anthropic client: {e}")

    # Call count_tokens API
    try:
        response = client.messages.count_tokens(
            model=DEFAULT_MODEL,
            messages=[
                {
                    "role": "user",
                    "content": content,
                }
            ],
        )
        return response.input_tokens

    except RateLimitError as e:
        error_exit(
            f"rate limit exceeded: {e}\n"
            "Please wait a moment and try again."
        )
    except APIConnectionError as e:
        error_exit(
            f"failed to connect to Anthropic API: {e}\n"
            "Check your internet connection and try again."
        )
    except APIError as e:
        error_exit(f"Anthropic API error: {e}")
    except Exception as e:
        error_exit(f"unexpected error calling Anthropic API: {e}")

    # Unreachable: error_exit() terminates process, but needed for type checker
    return 0  # pragma: no cover


def main() -> int:
    """Main entry point for token counter.

    Returns:
        Exit code (0 for success)
    """
    content = load_content()
    token_count = count_tokens(content)

    # Output JSON with input_tokens field
    result = {"input_tokens": token_count}
    print(json.dumps(result))

    return 0


if __name__ == "__main__":
    sys.exit(main())
