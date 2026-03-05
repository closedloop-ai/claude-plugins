---
name: toon-format
description: This skill should be used when writing or parsing TOON (Token-Oriented Object Notation) files. Triggers on .toon file operations, org-patterns.toon generation, or when converting between JSON and TOON formats. Provides syntax rules, quoting conventions, and examples for LLM-optimized data serialization.
---

# TOON Format (Token-Oriented Object Notation)

TOON is a compact, human-readable encoding of the JSON data model optimized for LLM prompts. It achieves ~40% token reduction compared to JSON while maintaining lossless round-trip compatibility.

## Core Syntax Rules

### Array Declaration

Arrays use bracketed headers with mandatory length count:

```toon
tags[3]: admin,ops,dev
```

### Tabular Arrays (Uniform Object Arrays)

For arrays of objects with identical structure, use field headers in braces:

```toon
patterns[2]{id,category,summary}:
  P-001,pattern,"Use tokens for colors"
  P-002,mistake,"Check auth before routes"
```

- Field names declared once in `{...}` after the count
- Each row contains values in declared field order
- Rows indented with 2 spaces (NEVER tabs)

### Objects

Objects use indentation-based nesting (2 spaces per level):

```toon
user:
  id: 123
  name: Ada
```

## Quoting Rules (Critical)

Strings MUST be quoted if they contain:
- The active delimiter (comma by default)
- Empty string, leading/trailing whitespace
- Reserved literals (`true`, `false`, `null`)
- Numeric-like patterns
- Colons, quotes, backslashes, brackets, braces
- Control characters or leading hyphens

**Escape sequences:** `\\`, `\"`, `\n`, `\r`, `\t`

## org-patterns.toon Format

Standard format for ClosedLoop organization learnings:

```toon
patterns[N]{id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context,repo}:
  P-001,pattern,"Summary here",high,5,0.85,,implementation-subagent,UI|styling,*
  P-002,mistake,"Check auth before routes",medium,3,0.60,[REVIEW],*,auth|routes,astoria-frontend
```

**Field notes:**
- `summary` - **Always quoted** (contains natural language with commas)
- `flags` - `[REVIEW]`, `[STALE]`, `[UNTESTED]`, `[PRUNE]`, or empty
- `applies_to` - Pipe-separated agent names or `*` for all
- `context` - Pipe-separated tags
- `repo` - Repository name (derived from git remote basename) or `*` for all repos

## Validation Checklist

1. Count matches actual rows/items
2. Field count in rows matches declaration
3. Strings needing quotes are quoted
4. 2-space indentation (no tabs)
5. No blank lines within array blocks

## References

- See `references/examples.md` for comprehensive examples
- [TOON Specification](https://github.com/toon-format/spec)
- [Reference Implementation](https://github.com/toon-format/toon)
