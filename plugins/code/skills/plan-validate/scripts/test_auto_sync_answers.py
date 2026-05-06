"""Tests for auto_sync_markdown_answers() in validate_plan.py."""
import copy

from validate_plan import auto_sync_markdown_answers


def _base_data(**overrides: object) -> dict:
    """Return a plan dict with one open question and matching content."""
    data: dict = {
        "content": "",
        "acceptanceCriteria": [],
        "pendingTasks": [],
        "completedTasks": [],
        "openQuestions": [
            {"id": "Q-001", "question": "What model?", "blockingTask": "T-1.1", "recommendedAnswer": None},
        ],
        "answeredQuestions": [],
        "gaps": [],
        "manualTasks": [],
    }
    data.update(overrides)
    return data


# --- Scenario 2: Inline answer with prefix ---


def test_bold_answer_extracted() -> None:
    """A checked question with **Answer: text** is migrated."""
    content = "- [x] Q-001: What model? **Answer: Use gpt-5.3-codex.**"
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == ["Q-001"]
    assert data["openQuestions"] == []
    assert len(data["answeredQuestions"]) == 1
    assert data["answeredQuestions"][0]["answer"] == "Use gpt-5.3-codex."
    assert data["answeredQuestions"][0]["question"] == "What model?"


def test_italic_answer_extracted() -> None:
    """A checked question with *Answer: text* is migrated."""
    content = "- [x] Q-001: What model? *Answer: Use the user's selected model.*"
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == ["Q-001"]
    assert data["answeredQuestions"][0]["answer"] == "Use the user's selected model."


def test_plain_answer_after_bracket() -> None:
    """A checked question with plain Answer: after [Recommended: ...] is migrated."""
    content = (
        "- [x] Q-001: What model? (BLOCKING T-1.1) "
        "[Recommended: gpt-5.3-codex] Answer: Default to user selection."
    )
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == ["Q-001"]
    assert data["answeredQuestions"][0]["answer"] == "Default to user selection."


def test_plain_answer_midline_without_bracket() -> None:
    """A checked question with plain Answer: after question text (no ] or . preceding) is migrated."""
    content = "- [x] Q-001: What model? Answer: Use codex."
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == ["Q-001"]
    assert data["answeredQuestions"][0]["answer"] == "Use codex."


# --- Scenario 3: A-### keyed answer line ---


def test_a_answer_with_checked_question() -> None:
    """A-001 answer line paired with a checked Q-001 is migrated."""
    content = "- [x] Q-001: What model?\n- [ ] A-001: Use codex."
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == ["Q-001"]
    assert data["answeredQuestions"][0]["answer"] == "Use codex."


def test_a_answer_with_unchecked_question() -> None:
    """A-001 answer line migrates even when Q-001 is unchecked; checkbox gets updated."""
    content = "- [ ] Q-001: What model?\n- [ ] A-001: Use codex."
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == ["Q-001"]
    assert data["answeredQuestions"][0]["answer"] == "Use codex."
    # Markdown content should have the checkbox checked now
    assert "- [x] Q-001:" in data["content"]


def test_a_answer_no_list_marker() -> None:
    """A-001 answer without list marker or checkbox is detected."""
    content = "- [ ] Q-001: What model?\nA-001: Use codex."
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == ["Q-001"]
    assert data["answeredQuestions"][0]["answer"] == "Use codex."


def test_a_answer_no_matching_question_ignored() -> None:
    """A-002 with no matching open Q-002 is ignored."""
    content = "- [ ] Q-001: What model?\nA-002: irrelevant answer"
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == []
    assert len(data["openQuestions"]) == 1


def test_a_answer_preferred_over_recommended() -> None:
    """A-### answer takes precedence over recommendedAnswer from JSON."""
    content = "- [x] Q-001: What model?\nA-001: Use codex from A-line."
    data = _base_data(content=content)
    data["openQuestions"][0]["recommendedAnswer"] = "recommended fallback"

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == ["Q-001"]
    assert data["answeredQuestions"][0]["answer"] == "Use codex from A-line."


# --- Scenario 1: Inline comment without prefix ---


def test_inline_comment_after_question() -> None:
    """Extra text after the known question text is extracted as the answer."""
    content = "- [x] Q-001: What model? Use the user's selected model."
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == ["Q-001"]
    assert data["answeredQuestions"][0]["answer"] == "Use the user's selected model."


def test_inline_comment_strips_metadata() -> None:
    """Inline comment extraction strips BLOCKING and Recommended markers."""
    content = (
        "- [x] Q-001: What model? (BLOCKING T-1.1) "
        "[Recommended: gpt-5.3-codex] Use user selection instead."
    )
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == ["Q-001"]
    assert data["answeredQuestions"][0]["answer"] == "Use user selection instead."


def test_inline_comment_with_bold_markers() -> None:
    """Inline comment wrapped in bold markers has them stripped."""
    content = "- [x] Q-001: What model? **Yes, use codex**"
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == ["Q-001"]
    assert data["answeredQuestions"][0]["answer"] == "Yes, use codex"


# --- Fallback and edge cases ---


def test_recommended_answer_fallback() -> None:
    """When no Answer: text in markdown, falls back to recommendedAnswer from JSON."""
    content = "- [x] Q-001: What model?"
    data = _base_data(content=content)
    data["openQuestions"][0]["recommendedAnswer"] = "Use gpt-5.3-codex"

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == ["Q-001"]
    assert data["answeredQuestions"][0]["answer"] == "Use gpt-5.3-codex"


def test_no_answer_text_skipped() -> None:
    """A checked question with no answer text and no recommendedAnswer is NOT migrated."""
    content = "- [x] Q-001: What model?"
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == []
    assert len(data["openQuestions"]) == 1
    assert data["answeredQuestions"] == []


def test_already_in_answered_ignored() -> None:
    """A question already in answeredQuestions is not duplicated."""
    content = "- [x] Q-001: What model? **Answer: Already answered.**"
    data = _base_data(
        content=content,
        openQuestions=[],
        answeredQuestions=[{"id": "Q-001", "question": "What model?", "answer": "Previous answer."}],
    )

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == []
    assert len(data["answeredQuestions"]) == 1
    assert data["answeredQuestions"][0]["answer"] == "Previous answer."


def test_unchecked_question_with_prefix_answer_migrated() -> None:
    """An unchecked question with **Answer:** prefix is migrated and auto-checked."""
    content = "- [ ] Q-001: What model? **Answer: Some text.**"
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == ["Q-001"]
    assert data["answeredQuestions"][0]["answer"] == "Some text."
    assert "- [x] Q-001:" in data["content"]


def test_unchecked_question_with_inline_comment_migrated() -> None:
    """An unchecked question with inline comment is migrated and auto-checked."""
    content = "- [ ] Q-001: What model? Use codex."
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == ["Q-001"]
    assert data["answeredQuestions"][0]["answer"] == "Use codex."
    assert "- [x] Q-001:" in data["content"]


def test_unchecked_question_without_answer_not_migrated() -> None:
    """An unchecked question with no answer text stays in openQuestions."""
    content = "- [ ] Q-001: What model?"
    data = _base_data(content=content)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == []
    assert len(data["openQuestions"]) == 1


def test_multiple_questions_mixed() -> None:
    """Only questions with answers are migrated; others stay."""
    content = (
        "- [x] Q-001: What model? **Answer: Use codex.**\n"
        "- [ ] Q-002: What format?\n"
        "- [x] Q-003: Which env? **Answer: Production.**\n"
    )
    data = _base_data(
        content=content,
        openQuestions=[
            {"id": "Q-001", "question": "What model?", "blockingTask": None, "recommendedAnswer": None},
            {"id": "Q-002", "question": "What format?", "blockingTask": None, "recommendedAnswer": None},
            {"id": "Q-003", "question": "Which env?", "blockingTask": None, "recommendedAnswer": None},
        ],
    )

    data, migrated = auto_sync_markdown_answers(data, content)

    assert sorted(migrated) == ["Q-001", "Q-003"]
    assert len(data["openQuestions"]) == 1
    assert data["openQuestions"][0]["id"] == "Q-002"
    assert len(data["answeredQuestions"]) == 2


def test_multiple_formats_mixed() -> None:
    """All three formats coexist: inline prefix, A-### line, inline comment."""
    content = (
        "- [x] Q-001: What model? **Answer: Use codex.**\n"
        "- [ ] Q-002: What format?\n"
        "A-002: JSON format.\n"
        "- [x] Q-003: Which env? Production.\n"
    )
    data = _base_data(
        content=content,
        openQuestions=[
            {"id": "Q-001", "question": "What model?", "blockingTask": None, "recommendedAnswer": None},
            {"id": "Q-002", "question": "What format?", "blockingTask": None, "recommendedAnswer": None},
            {"id": "Q-003", "question": "Which env?", "blockingTask": None, "recommendedAnswer": None},
        ],
    )

    data, migrated = auto_sync_markdown_answers(data, content)

    assert sorted(migrated) == ["Q-001", "Q-002", "Q-003"]
    assert data["openQuestions"] == []
    answers = {q["id"]: q["answer"] for q in data["answeredQuestions"]}
    assert answers["Q-001"] == "Use codex."
    assert answers["Q-002"] == "JSON format."
    assert answers["Q-003"] == "Production."
    # Q-002 checkbox should be checked in content
    assert "- [x] Q-002:" in data["content"]


def test_data_not_mutated_when_no_matches() -> None:
    """When no questions need migration, the data dict is unchanged."""
    content = "- [ ] Q-001: What model?"
    data = _base_data(content=content)
    original = copy.deepcopy(data)

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == []
    assert data == original


def test_empty_open_questions_short_circuits() -> None:
    """When openQuestions is empty, returns immediately."""
    content = "- [x] Q-001: What model? **Answer: foo.**"
    data = _base_data(content=content, openQuestions=[])

    data, migrated = auto_sync_markdown_answers(data, content)

    assert migrated == []
