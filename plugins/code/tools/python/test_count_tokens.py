"""Tests for count_tokens.py."""

import io
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add tools directory to path to import count_tokens module
sys.path.insert(0, str(Path(__file__).parent))

from count_tokens import (
    DEFAULT_MODEL,
    SIZE_WARNING_BYTES,
    count_tokens,
    error_exit,
    load_content,
    main,
)


class TestErrorExit:
    """Tests for error_exit function."""

    def test_error_exit_message(self) -> None:
        """Verify error_exit prints to stderr and exits with status 1."""
        with patch("sys.stderr", new_callable=io.StringIO) as mock_stderr:
            with pytest.raises(SystemExit) as exc_info:
                error_exit("test error message")

            assert exc_info.value.code == 1
            assert "Error: test error message" in mock_stderr.getvalue()

    def test_error_exit_multiline_message(self) -> None:
        """Verify error_exit handles multiline messages."""
        with patch("sys.stderr", new_callable=io.StringIO) as mock_stderr:
            with pytest.raises(SystemExit) as exc_info:
                error_exit("line 1\nline 2\nline 3")

            assert exc_info.value.code == 1
            stderr_output = mock_stderr.getvalue()
            assert "Error: line 1" in stderr_output
            assert "line 2" in stderr_output
            assert "line 3" in stderr_output


class TestLoadContentFromFile:
    """Tests for load_content with file input."""

    def test_load_valid_file(self, tmp_path: Path) -> None:
        """Load content from valid file successfully."""
        file_path = tmp_path / "test.txt"
        file_path.write_text("Hello, world!", encoding="utf-8")

        with patch("sys.argv", ["count_tokens.py", str(file_path)]):
            with patch("sys.stdin.isatty", return_value=True):
                content = load_content()
                assert content == "Hello, world!"

    def test_load_file_with_unicode(self, tmp_path: Path) -> None:
        """Load file with Unicode characters successfully."""
        file_path = tmp_path / "unicode.txt"
        file_path.write_text("Hello 世界 🌍", encoding="utf-8")

        with patch("sys.argv", ["count_tokens.py", str(file_path)]):
            with patch("sys.stdin.isatty", return_value=True):
                content = load_content()
                assert content == "Hello 世界 🌍"

    def test_missing_file_argument(self) -> None:
        """Verify error when no file argument provided and stdin is TTY."""
        with patch("sys.argv", ["count_tokens.py"]):
            with patch("sys.stdin.isatty", return_value=True):
                with pytest.raises(SystemExit) as exc_info:
                    load_content()
                assert exc_info.value.code == 1

    def test_file_not_found(self, tmp_path: Path) -> None:
        """Verify error when file does not exist."""
        file_path = tmp_path / "nonexistent.txt"

        with patch("sys.argv", ["count_tokens.py", str(file_path)]):
            with patch("sys.stdin.isatty", return_value=True):
                with pytest.raises(SystemExit) as exc_info:
                    load_content()
                assert exc_info.value.code == 1

    def test_path_is_directory(self, tmp_path: Path) -> None:
        """Verify error when path is a directory, not a file."""
        dir_path = tmp_path / "directory"
        dir_path.mkdir()

        with patch("sys.argv", ["count_tokens.py", str(dir_path)]):
            with patch("sys.stdin.isatty", return_value=True):
                with pytest.raises(SystemExit) as exc_info:
                    load_content()
                assert exc_info.value.code == 1

    def test_invalid_utf8_file(self, tmp_path: Path) -> None:
        """Verify error when file is not valid UTF-8."""
        file_path = tmp_path / "invalid.txt"
        # Write invalid UTF-8 bytes
        file_path.write_bytes(b"\xff\xfe\xfd")

        with patch("sys.argv", ["count_tokens.py", str(file_path)]):
            with patch("sys.stdin.isatty", return_value=True):
                with pytest.raises(SystemExit) as exc_info:
                    load_content()
                assert exc_info.value.code == 1

    def test_empty_file(self, tmp_path: Path) -> None:
        """Verify error when file is empty."""
        file_path = tmp_path / "empty.txt"
        file_path.write_text("", encoding="utf-8")

        with patch("sys.argv", ["count_tokens.py", str(file_path)]):
            with patch("sys.stdin.isatty", return_value=True):
                with pytest.raises(SystemExit) as exc_info:
                    load_content()
                assert exc_info.value.code == 1

    def test_whitespace_only_file(self, tmp_path: Path) -> None:
        """Verify error when file contains only whitespace."""
        file_path = tmp_path / "whitespace.txt"
        file_path.write_text("   \n\t\n   ", encoding="utf-8")

        with patch("sys.argv", ["count_tokens.py", str(file_path)]):
            with patch("sys.stdin.isatty", return_value=True):
                with pytest.raises(SystemExit) as exc_info:
                    load_content()
                assert exc_info.value.code == 1

    def test_large_file_warning(self, tmp_path: Path) -> None:
        """Verify warning is printed for large files."""
        file_path = tmp_path / "large.txt"
        # Create a file larger than SIZE_WARNING_BYTES (1MB)
        large_content = "x" * (SIZE_WARNING_BYTES + 1000)
        file_path.write_text(large_content, encoding="utf-8")

        with patch("sys.argv", ["count_tokens.py", str(file_path)]):
            with patch("sys.stdin.isatty", return_value=True):
                with patch("sys.stderr", new_callable=io.StringIO) as mock_stderr:
                    content = load_content()
                    assert content == large_content
                    assert "Warning: large file" in mock_stderr.getvalue()

    def test_file_permission_error(self, tmp_path: Path) -> None:
        """Verify error when file cannot be read due to permissions."""
        file_path = tmp_path / "noperm.txt"
        file_path.write_text("test content", encoding="utf-8")
        # Make file unreadable
        file_path.chmod(0o000)

        try:
            with patch("sys.argv", ["count_tokens.py", str(file_path)]):
                with patch("sys.stdin.isatty", return_value=True):
                    with pytest.raises(SystemExit) as exc_info:
                        load_content()
                    assert exc_info.value.code == 1
        finally:
            # Restore permissions for cleanup
            file_path.chmod(0o644)


class TestLoadContentFromStdin:
    """Tests for load_content with stdin input."""

    def test_load_from_stdin(self) -> None:
        """Load content from stdin successfully."""
        stdin_content = "Hello from stdin"

        with patch("sys.argv", ["count_tokens.py"]):
            with patch("sys.stdin.isatty", return_value=False):
                with patch("sys.stdin.read", return_value=stdin_content):
                    content = load_content()
                    assert content == stdin_content

    def test_load_stdin_with_unicode(self) -> None:
        """Load stdin with Unicode characters successfully."""
        stdin_content = "Testing 测试 тест ✓"

        with patch("sys.argv", ["count_tokens.py"]):
            with patch("sys.stdin.isatty", return_value=False):
                with patch("sys.stdin.read", return_value=stdin_content):
                    content = load_content()
                    assert content == stdin_content

    def test_stdin_invalid_utf8(self) -> None:
        """Verify error when stdin is not valid UTF-8."""
        with patch("sys.argv", ["count_tokens.py"]):
            with patch("sys.stdin.isatty", return_value=False):
                with patch("sys.stdin.read", side_effect=UnicodeDecodeError("utf-8", b"", 0, 1, "invalid")):
                    with pytest.raises(SystemExit) as exc_info:
                        load_content()
                    assert exc_info.value.code == 1

    def test_stdin_empty(self) -> None:
        """Verify error when stdin is empty."""
        with patch("sys.argv", ["count_tokens.py"]):
            with patch("sys.stdin.isatty", return_value=False):
                with patch("sys.stdin.read", return_value=""):
                    with pytest.raises(SystemExit) as exc_info:
                        load_content()
                    assert exc_info.value.code == 1

    def test_stdin_whitespace_only(self) -> None:
        """Verify error when stdin contains only whitespace."""
        with patch("sys.argv", ["count_tokens.py"]):
            with patch("sys.stdin.isatty", return_value=False):
                with patch("sys.stdin.read", return_value="   \n\t\n   "):
                    with pytest.raises(SystemExit) as exc_info:
                        load_content()
                    assert exc_info.value.code == 1

    def test_stdin_io_error(self) -> None:
        """Verify error when stdin read fails."""
        with patch("sys.argv", ["count_tokens.py"]):
            with patch("sys.stdin.isatty", return_value=False):
                with patch("sys.stdin.read", side_effect=IOError("Read failed")):
                    with pytest.raises(SystemExit) as exc_info:
                        load_content()
                    assert exc_info.value.code == 1


class TestCountTokens:
    """Tests for count_tokens function."""

    def test_missing_api_key(self) -> None:
        """Verify error when ANTHROPIC_API_KEY is not set."""
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(SystemExit) as exc_info:
                count_tokens("test content")
            assert exc_info.value.code == 1

    def test_successful_token_count(self) -> None:
        """Count tokens successfully with valid API response."""
        mock_response = MagicMock()
        mock_response.input_tokens = 42

        mock_client = MagicMock()
        mock_client.messages.count_tokens.return_value = mock_response

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch("count_tokens.Anthropic", return_value=mock_client):
                token_count = count_tokens("test content")
                assert token_count == 42

                # Verify correct API call
                mock_client.messages.count_tokens.assert_called_once()
                call_args = mock_client.messages.count_tokens.call_args
                assert call_args[1]["model"] == DEFAULT_MODEL
                assert call_args[1]["messages"][0]["role"] == "user"
                assert call_args[1]["messages"][0]["content"] == "test content"

    def test_token_count_with_long_content(self) -> None:
        """Count tokens for long content."""
        mock_response = MagicMock()
        mock_response.input_tokens = 10000

        mock_client = MagicMock()
        mock_client.messages.count_tokens.return_value = mock_response

        long_content = "test " * 5000

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch("count_tokens.Anthropic", return_value=mock_client):
                token_count = count_tokens(long_content)
                assert token_count == 10000

    def test_api_rate_limit_error(self) -> None:
        """Verify error handling for rate limit errors."""
        from anthropic import RateLimitError  # type: ignore[import-not-found]

        mock_client = MagicMock()
        # Create a mock RateLimitError instance with proper initialization
        mock_error = MagicMock(spec=RateLimitError)
        mock_error.__str__ = MagicMock(return_value="Rate limit exceeded")
        mock_client.messages.count_tokens.side_effect = mock_error

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch("count_tokens.Anthropic", return_value=mock_client):
                with pytest.raises(SystemExit) as exc_info:
                    count_tokens("test content")
                assert exc_info.value.code == 1

    def test_api_connection_error(self) -> None:
        """Verify error handling for connection errors."""
        from anthropic import APIConnectionError  # type: ignore[import-not-found]

        mock_client = MagicMock()
        # Create a mock APIConnectionError instance with proper initialization
        mock_error = MagicMock(spec=APIConnectionError)
        mock_error.__str__ = MagicMock(return_value="Connection failed")
        mock_client.messages.count_tokens.side_effect = mock_error

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch("count_tokens.Anthropic", return_value=mock_client):
                with pytest.raises(SystemExit) as exc_info:
                    count_tokens("test content")
                assert exc_info.value.code == 1

    def test_api_error(self) -> None:
        """Verify error handling for general API errors."""
        from anthropic import APIError  # type: ignore[import-not-found]

        mock_client = MagicMock()
        # Create a mock APIError instance with proper initialization
        mock_error = MagicMock(spec=APIError)
        mock_error.__str__ = MagicMock(return_value="API error")
        mock_client.messages.count_tokens.side_effect = mock_error

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch("count_tokens.Anthropic", return_value=mock_client):
                with pytest.raises(SystemExit) as exc_info:
                    count_tokens("test content")
                assert exc_info.value.code == 1

    def test_unexpected_exception(self) -> None:
        """Verify error handling for unexpected exceptions."""
        mock_client = MagicMock()
        mock_client.messages.count_tokens.side_effect = ValueError("Unexpected error")

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch("count_tokens.Anthropic", return_value=mock_client):
                with pytest.raises(SystemExit) as exc_info:
                    count_tokens("test content")
                assert exc_info.value.code == 1

    def test_client_initialization_error(self) -> None:
        """Verify error handling when client initialization fails."""
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
            with patch("count_tokens.Anthropic", side_effect=Exception("Init failed")):
                with pytest.raises(SystemExit) as exc_info:
                    count_tokens("test content")
                assert exc_info.value.code == 1


class TestMain:
    """Tests for main function."""

    def test_successful_main_execution(self, tmp_path: Path) -> None:
        """Main function executes successfully and outputs JSON."""
        file_path = tmp_path / "test.txt"
        file_path.write_text("Hello, world!", encoding="utf-8")

        mock_response = MagicMock()
        mock_response.input_tokens = 123

        mock_client = MagicMock()
        mock_client.messages.count_tokens.return_value = mock_response

        with patch("sys.argv", ["count_tokens.py", str(file_path)]):
            with patch("sys.stdin.isatty", return_value=True):
                with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
                    with patch("count_tokens.Anthropic", return_value=mock_client):
                        with patch("sys.stdout", new_callable=io.StringIO) as mock_stdout:
                            exit_code = main()
                            assert exit_code == 0

                            # Verify JSON output
                            output = mock_stdout.getvalue()
                            result = json.loads(output.strip())
                            assert result == {"input_tokens": 123}

    def test_main_json_output_format(self, tmp_path: Path) -> None:
        """Verify main outputs valid JSON with correct structure."""
        file_path = tmp_path / "test.txt"
        file_path.write_text("test", encoding="utf-8")

        mock_response = MagicMock()
        mock_response.input_tokens = 456

        mock_client = MagicMock()
        mock_client.messages.count_tokens.return_value = mock_response

        with patch("sys.argv", ["count_tokens.py", str(file_path)]):
            with patch("sys.stdin.isatty", return_value=True):
                with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
                    with patch("count_tokens.Anthropic", return_value=mock_client):
                        with patch("sys.stdout", new_callable=io.StringIO) as mock_stdout:
                            exit_code = main()
                            assert exit_code == 0

                            # Parse and validate JSON
                            output = mock_stdout.getvalue()
                            result = json.loads(output.strip())
                            assert "input_tokens" in result
                            assert isinstance(result["input_tokens"], int)
                            assert result["input_tokens"] == 456

    def test_main_exits_on_load_error(self) -> None:
        """Main function exits with error when content loading fails."""
        with patch("sys.argv", ["count_tokens.py"]):
            with patch("sys.stdin.isatty", return_value=True):
                with pytest.raises(SystemExit) as exc_info:
                    main()
                assert exc_info.value.code == 1

    def test_main_exits_on_api_error(self, tmp_path: Path) -> None:
        """Main function exits with error when API call fails."""
        file_path = tmp_path / "test.txt"
        file_path.write_text("test", encoding="utf-8")

        with patch("sys.argv", ["count_tokens.py", str(file_path)]):
            with patch("sys.stdin.isatty", return_value=True):
                with patch.dict(os.environ, {}, clear=True):
                    with pytest.raises(SystemExit) as exc_info:
                        main()
                    assert exc_info.value.code == 1

    def test_main_from_stdin(self) -> None:
        """Main function works with stdin input."""
        stdin_content = "stdin test content"

        mock_response = MagicMock()
        mock_response.input_tokens = 789

        mock_client = MagicMock()
        mock_client.messages.count_tokens.return_value = mock_response

        with patch("sys.argv", ["count_tokens.py"]):
            with patch("sys.stdin.isatty", return_value=False):
                with patch("sys.stdin.read", return_value=stdin_content):
                    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
                        with patch("count_tokens.Anthropic", return_value=mock_client):
                            with patch("sys.stdout", new_callable=io.StringIO) as mock_stdout:
                                exit_code = main()
                                assert exit_code == 0

                                output = mock_stdout.getvalue()
                                result = json.loads(output.strip())
                                assert result == {"input_tokens": 789}


class TestIntegration:
    """Integration tests for complete workflows."""

    def test_file_workflow_end_to_end(self, tmp_path: Path) -> None:
        """Complete workflow: file input → API call → JSON output."""
        file_path = tmp_path / "integration_test.txt"
        file_content = "Integration test content with some length"
        file_path.write_text(file_content, encoding="utf-8")

        mock_response = MagicMock()
        mock_response.input_tokens = 999

        mock_client = MagicMock()
        mock_client.messages.count_tokens.return_value = mock_response

        with patch("sys.argv", ["count_tokens.py", str(file_path)]):
            with patch("sys.stdin.isatty", return_value=True):
                with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
                    with patch("count_tokens.Anthropic", return_value=mock_client):
                        with patch("sys.stdout", new_callable=io.StringIO) as mock_stdout:
                            exit_code = main()

                            # Verify successful execution
                            assert exit_code == 0

                            # Verify JSON output
                            output = mock_stdout.getvalue()
                            result = json.loads(output.strip())
                            assert result["input_tokens"] == 999

                            # Verify API was called with correct content
                            call_args = mock_client.messages.count_tokens.call_args
                            assert call_args[1]["messages"][0]["content"] == file_content

    def test_stdin_workflow_end_to_end(self) -> None:
        """Complete workflow: stdin input → API call → JSON output."""
        stdin_content = "Piped content from stdin"

        mock_response = MagicMock()
        mock_response.input_tokens = 888

        mock_client = MagicMock()
        mock_client.messages.count_tokens.return_value = mock_response

        with patch("sys.argv", ["count_tokens.py"]):
            with patch("sys.stdin.isatty", return_value=False):
                with patch("sys.stdin.read", return_value=stdin_content):
                    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
                        with patch("count_tokens.Anthropic", return_value=mock_client):
                            with patch("sys.stdout", new_callable=io.StringIO) as mock_stdout:
                                exit_code = main()

                                assert exit_code == 0

                                output = mock_stdout.getvalue()
                                result = json.loads(output.strip())
                                assert result["input_tokens"] == 888

                                # Verify API was called with stdin content
                                call_args = mock_client.messages.count_tokens.call_args
                                assert call_args[1]["messages"][0]["content"] == stdin_content
